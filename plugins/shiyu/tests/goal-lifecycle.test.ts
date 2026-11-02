import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { syntheticLocalNoteBinding, observeSyntheticLocalNote } from './helpers/capability.js';
import { LocalArtifactStore } from '../src/adapters/artifacts/index.js';
import { GoalOperationUnknownError } from '../src/adapters/dsh/goals.js';
import type { GoalAdapterOptions, GoalAuthorityContext, GoalBinding, GoalBindingPort, GoalCreateRequest, GoalMutationRequest, GoalReadResult, NativeGoalView } from '../src/adapters/dsh/goals.js';
import type { DshContext } from '../src/adapters/dsh/sessions.js';
import type { TaskDetail } from '../src/adapters/control-store/task-domain.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import { LocalTaskRunner } from '../src/control/task-runner.js';
import type { TaskWorkerDriver } from '../src/control/task-runner.js';
import { LocalGoalLifecycleService, GoalLifecycleEvidenceError, GoalLifecycleRecoveryRequiredError } from '../src/control/goal-lifecycle.js';
import type { GoalLifecycleAdapter, GoalLifecycleOperation, GoalLifecycleOptions } from '../src/control/goal-lifecycle.js';

const CONTENT = 'Synthetic evidence for the native Goal lifecycle verification.';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const pause = () => new Promise<void>(done => setImmediate(done));
class FixtureGoalAdapter implements GoalLifecycleAdapter {
  initialized = 0;
  closed = false;
  operations: GoalLifecycleOperation[] = [];
  contexts: GoalAuthorityContext[] = [];
  proofs: unknown[] = [];
  beforeSecond?: (operation: GoalLifecycleOperation) => void | Promise<void>;
  afterMutation?: (operation: GoalLifecycleOperation) => void;
  unknownAt?: GoalLifecycleOperation;
  createGate?: Promise<void>;
  private native?: NativeGoalView;
  constructor(readonly options: GoalAdapterOptions) {}
  async initialize() { this.initialized++; }
  async close() { this.closed = true; }
  async create(request: GoalCreateRequest) {
    if (this.createGate) await this.createGate;
    return this.write('create', request);
  }
  async pause(request: GoalMutationRequest) { return this.write('pause', request); }
  async resume(request: GoalMutationRequest) { return this.write('resume', request); }
  async complete(request: GoalMutationRequest) { return this.write('complete', request); }
  private async write(operation: GoalLifecycleOperation, request: GoalCreateRequest | GoalMutationRequest): Promise<GoalReadResult> {
    const previous = await this.options.bindings.load(request.goalId), create = request as GoalCreateRequest;
    const context: GoalAuthorityContext = { operation, goalId: request.goalId, ownerId: previous?.ownerId ?? create.ownerId, scope: previous?.scope ?? create.scope,
      completionCriteriaHash: previous?.completionCriteriaHash ?? create.completionCriteriaHash,
      ...('expectedRef' in request ? { expectedRef: request.expectedRef } : {}) };
    this.contexts.push(context);
    const first = await this.options.authority.authorize(request.capability, context);
    if (!first.allowed) throw new Error('Fixture native authority denied');
    let binding: GoalBinding = { ...(previous ?? { goalId: request.goalId, sessionId: 'synthetic-native-goal-session', ownerId: create.ownerId, scope: create.scope,
      cwd: create.cwd, completionCriteriaHash: create.completionCriteriaHash }), metadataVersion: (previous?.metadataVersion ?? 0) + 1,
      receipt: { commandId: request.commandId, operation, status: 'pending', postconditionHash: 'b'.repeat(64),
        ...('expectedRef' in request ? { expectedRef: request.expectedRef } : {}),
        ...(first.completion ? { completionProof: first.completion, evidenceRefs: first.completion.evidenceRefs } : {}) } };
    await this.options.bindings.compareAndSet(previous?.metadataVersion, binding);
    if (this.unknownAt === operation) {
      const old = binding.metadataVersion; binding = { ...binding, metadataVersion: old + 1, receipt: { ...binding.receipt!, status: 'unknown' } };
      await this.options.bindings.compareAndSet(old, binding);
      throw new GoalOperationUnknownError(binding, new Error('Synthetic native outcome unknown'));
    }
    await this.beforeSecond?.(operation);
    const second = await this.options.authority.authorize(request.capability, context);
    if (!second.allowed) throw new Error('Fixture native authority denied');
    if (this.closed) throw new Error('Fixture native adapter closed');
    request.signal?.throwIfAborted();
    if (operation === 'complete') { this.proofs.push(first.completion, second.completion); assert.deepEqual(first.completion, second.completion); }
    this.native = { ...(this.native ?? { id: 'synthetic-native-goal', objective: create.objective, maxGoalRounds: 1, roundsStarted: 0, createdAt: Date.now() }),
      revision: (this.native?.revision ?? 0) + 1, phase: operation === 'pause' ? 'paused' : operation === 'complete' ? 'complete' : 'active', activation: 'disarmed', updatedAt: Date.now() };
    const goalRef = { id: this.native.id, revision: this.native.revision }, oldVersion = binding.metadataVersion;
    binding = { ...binding, metadataVersion: oldVersion + 1, goalRef, receipt: { ...binding.receipt!, status: 'confirmed', observedRef: goalRef } };
    await this.options.bindings.compareAndSet(oldVersion, binding); this.operations.push(operation); this.afterMutation?.(operation);
    return { binding, native: structuredClone(this.native) };
  }
}
async function setup(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shiyu-goal-lifecycle-'));
  const store = await ControlStore.open({ filename: path.join(root, 'control.sqlite'), eventTypes: SHIYU_EVENT_TYPES, componentHandlers: [], runtimeIdentity: { hostEpoch: 'historical-host', installationGeneration: 'historical-install' }, localNoteBinding: syntheticLocalNoteBinding('historical-install') });
  try { await observeSyntheticLocalNote(store, { hostEpoch: 'historical-host', installationGeneration: 'historical-install' }); }
  catch (error) { await store.close(); await rm(root, { recursive: true, force: true }); throw error; }
  const artifacts = await LocalArtifactStore.open(path.join(root, 'workspaces'));
  const worker: TaskWorkerDriver = { async initialize() {}, async close() {}, async run(request) {
    const binding = { taskId: request.taskId, assignmentId: request.assignmentId, scope: request.scope, sessionId: 'synthetic-task-session' };
    await request.onBound(binding);
    await request.tools![0].execute({ content: CONTENT }, { ...binding, permit: { ...request.permit, taskId: request.taskId, assignmentId: request.assignmentId, scope: request.scope }, signal: request.signal!,
      assertPermit: async () => { await request.permit.check({ ...request.permit, taskId: request.taskId, assignmentId: request.assignmentId, scope: request.scope, phase: 'tool' }); } });
    return { ...binding, candidate: { summary: 'Synthetic candidate is not Goal completion proof.', evidenceRequests: [] }, usage: { status: 'reported', inputTokens: 10, outputTokens: 10, totalTokens: 20 }, steps: 1, modelCalls: 1, nativeObservations: [], verified: false };
  } };
  const detail = await store.request('task.createLocal', { requestId: 'goal-source', title: 'Synthetic source Task', content: CONTENT }), taskId = detail.task.taskId;
  await new LocalTaskRunner(store, worker, artifacts).run(taskId, { signal: new AbortController().signal, progress() {} });
  const bindings: GoalBindingPort = {
    load: goalId => store.request('goal.binding.load', { goalId }),
    loadCommand: (goalId, commandId) => store.request('goal.binding.loadCommand', { goalId, commandId }),
    async compareAndSet(expectedMetadataVersion, binding) { await store.request('goal.binding.compareAndSet', { expectedMetadataVersion, binding }); },
  };
  let open = true, inspections = 0, taskReads = 0, fixture!: FixtureGoalAdapter;
  let editDetail: ((value: TaskDetail) => TaskDetail) | undefined;
  const opts: GoalLifecycleOptions = { ctx: {} as DshContext, bindings,
    async taskReader(id) { taskReads++; const value = await store.request('task.get', { taskId: id }); return editDetail ? editDetail(structuredClone(value)) : value; },
    artifacts: { prepareWorkspace: id => artifacts.prepareWorkspace(id), async inspect(input) { inspections++; return artifacts.inspect(input); } },
    isRuntimeOpenAndUnpaused: () => open,
    adapterFactory: value => fixture = new FixtureGoalAdapter(value),
  };
  const service = new LocalGoalLifecycleService(opts);
  t.after(async () => { await service.close(); await artifacts.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, artifacts, bindings, taskId, service, fixture, opts, counts: () => ({ inspections, taskReads }),
    setOpen(value: boolean) { open = value; }, mutateDetail(fn: (value: TaskDetail) => TaskDetail) { editDetail = fn; } };
}
const runOptions = () => ({ signal: new AbortController().signal, progress(_phase: string) {} });

test('actual artifact and trusted SQLite evidence drive exactly four native lifecycle operations with no inference request', async t => {
  const f = await setup(t); await f.service.initialize(); const phases: string[] = [];
  const result = await f.service.run(f.taskId, { ...runOptions(), progress: phase => phases.push(phase) });
  assert.deepEqual(result, { verified: true, taskId: f.taskId, goalId: `artifact-validation:${f.taskId}`, nativeGoalId: 'synthetic-native-goal', sessionId: 'synthetic-native-goal-session', nativePhase: 'complete', inferenceRequested: false, operations: ['create', 'pause', 'resume', 'complete'] });
  assert.equal(f.fixture.initialized, 1); assert.deepEqual(f.fixture.operations, result.operations); assert.equal(f.fixture.proofs.length, 2);
  assert.deepEqual(f.fixture.proofs[0], f.fixture.proofs[1]); assert.ok(f.counts().inspections >= 10); assert.ok(phases.length >= 6);
  const binding = await f.bindings.load(result.goalId); assert.equal(binding?.receipt?.status, 'confirmed'); assert.equal(binding?.receipt?.operation, 'complete');
  assert.equal(binding?.receipt?.completionProof?.goalRef.revision, 3);
  assert.equal(binding?.receipt?.completionProof?.completionCriteriaHash, binding?.completionCriteriaHash);
  await assert.rejects(f.service.run(f.taskId, runOptions()), GoalLifecycleRecoveryRequiredError); assert.equal(f.fixture.operations.length, 4);
});

test('public JSON cannot mint the service owner capability or choose another Goal/scope', async t => {
  const f = await setup(t);
  const verdict = await f.fixture.options.authority.authorize({ actor: { kind: 'owner', principalId: 'local-owner' } }, { operation: 'create', goalId: `artifact-validation:${f.taskId}`, ownerId: 'local-owner', scope: 'local-owner', completionCriteriaHash: 'a'.repeat(64) });
  assert.deepEqual(verdict, { allowed: false }); assert.equal(f.counts().inspections, 0); assert.equal(f.fixture.operations.length, 0);
});

test('invalid Task, scope, completion check, Effect or receipt cannot create a native Goal', async t => {
  const f = await setup(t);
  const mutations: Array<(detail: TaskDetail) => void> = [
    detail => { detail.task.state = 'waiting'; },
    detail => { detail.task.inputRefs = ['untrusted-input']; },
    detail => { detail.reservation!.scope = 'other-owner'; },
    detail => { detail.task.completionSpec.checks[0]!.evidenceRequired = false; },
    detail => { detail.task.verification!.checks[0]!.status = 'inconclusive'; },
    detail => { detail.effects[0]!.status = 'unknown'; },
    detail => { detail.effects[0]!.origin = { kind: 'task', taskId: 'other', assignmentId: detail.task.latestAssignmentId! }; },
    detail => { detail.effectReceipts = []; },
    detail => { detail.effectReceipts[0]!.payloadHash = 'f'.repeat(64); },
    detail => { detail.effectReceipts[0]!.claim.fencingToken++; },
    detail => { detail.effectReceipts[0]!.verification.settledEffect = null; },
  ];
  for (const mutate of mutations) {
    f.mutateDetail(detail => { mutate(detail); return detail; });
    await assert.rejects(f.service.run(f.taskId, runOptions()), GoalLifecycleEvidenceError);
  }
  assert.equal(f.fixture.operations.length, 0); assert.equal(await f.bindings.load(`artifact-validation:${f.taskId}`), undefined);
});

test('an actually changed local file cannot be replaced by a successful Task summary', async t => {
  const f = await setup(t);
  await writeFile(path.join(f.root, 'workspaces', f.taskId, 'artifacts', 'note.txt'), 'Changed synthetic file');
  await assert.rejects(f.service.run(f.taskId, runOptions())); assert.equal(f.fixture.operations.length, 0);
});

test('both completion authorizations read again and refuse a file changed between them', async t => {
  const f = await setup(t);
  f.fixture.beforeSecond = async operation => { if (operation === 'complete') await writeFile(path.join(f.root, 'workspaces', f.taskId, 'artifacts', 'note.txt'), 'Changed before second proof check'); };
  await assert.rejects(f.service.run(f.taskId, runOptions()), GoalLifecycleRecoveryRequiredError);
  assert.deepEqual(f.fixture.operations, ['create', 'pause', 'resume']);
  assert.equal((await f.bindings.load(`artifact-validation:${f.taskId}`))?.receipt?.status, 'pending');
});

test('runtime pause or cancellation between lifecycle operations stops without announcing completion', async t => {
  const f = await setup(t); f.fixture.afterMutation = operation => { if (operation === 'pause') f.setOpen(false); };
  await assert.rejects(f.service.run(f.taskId, runOptions()), GoalLifecycleRecoveryRequiredError);
  assert.deepEqual(f.fixture.operations, ['create', 'pause']);
  const binding = await f.bindings.load(`artifact-validation:${f.taskId}`); assert.equal(binding?.receipt?.operation, 'pause');
});

test('cancellation during completion authorization prevents the native complete operation', async t => {
  const f = await setup(t), controller = new AbortController();
  f.fixture.beforeSecond = operation => { if (operation === 'complete') controller.abort(new Error('Synthetic cancellation')); };
  await assert.rejects(f.service.run(f.taskId, { ...runOptions(), signal: controller.signal }), GoalLifecycleRecoveryRequiredError);
  assert.deepEqual(f.fixture.operations, ['create', 'pause', 'resume']);
});

test('cancellation after native complete preserves the actual receipt but returns no verified result', async t => {
  const f = await setup(t), controller = new AbortController();
  f.fixture.afterMutation = operation => { if (operation === 'complete') controller.abort(new Error('Late synthetic cancellation')); };
  await assert.rejects(f.service.run(f.taskId, { ...runOptions(), signal: controller.signal }), GoalLifecycleRecoveryRequiredError);
  assert.equal((await f.bindings.load(`artifact-validation:${f.taskId}`))?.receipt?.operation, 'complete');
  assert.deepEqual(f.fixture.operations, ['create', 'pause', 'resume', 'complete']);
});

test('native unknown outcome is preserved and is never retried automatically', async t => {
  const f = await setup(t); f.fixture.unknownAt = 'resume';
  await assert.rejects(f.service.run(f.taskId, runOptions()), GoalOperationUnknownError);
  assert.equal((await f.bindings.load(`artifact-validation:${f.taskId}`))?.receipt?.status, 'unknown');
  await assert.rejects(f.service.run(f.taskId, runOptions()), GoalLifecycleRecoveryRequiredError);
  assert.deepEqual(f.fixture.operations, ['create', 'pause']);
});

test('close fences late native creation and concurrent validation does not start a second sequence', async t => {
  const f = await setup(t), gate = deferred(); f.fixture.createGate = gate.promise;
  const running = f.service.run(f.taskId, runOptions()), rejected = assert.rejects(running, /closed/);
  while (f.fixture.initialized === 0) await pause();
  await assert.rejects(f.service.run(f.taskId, runOptions()), /already running/);
  const closing = f.service.close(); gate.resolve(); await Promise.all([closing, rejected]);
  assert.equal(f.fixture.closed, true); assert.equal(f.fixture.operations.length, 0);
  await assert.rejects(f.service.run(f.taskId, runOptions()), /closed/);
});

test('already paused or cancelled requests create no native lifecycle state', async t => {
  const f = await setup(t); f.setOpen(false);
  await assert.rejects(f.service.run(f.taskId, runOptions()), /unpaused/); f.setOpen(true);
  await assert.rejects(f.service.run(f.taskId, { ...runOptions(), signal: AbortSignal.abort(new Error('Already cancelled')) }), /Already cancelled/);
  assert.equal(f.fixture.operations.length, 0); assert.equal(f.counts().inspections, 0);
});

test('historical epoch and unresolved model accounting do not invalidate independently verified artifact facts', async t => {
  const f = await setup(t);
  f.mutateDetail(detail => { detail.reservation!.state = 'unknown'; detail.reservation!.leaseExpiresAt = '2020-01-01T00:00:00.000Z'; return detail; });
  const result = await f.service.run(f.taskId, runOptions()); assert.equal(result.verified, true);
});
