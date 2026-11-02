import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { LocalCoreService, LocalCoreCompletionError, LocalCorePreflightError, type LocalCoreAdapter } from '../src/control/local-core.js';
import { CoreDomain } from '../src/adapters/control-store/core-domain.js';
import { TaskDomain, type TaskCommands, type TaskDomainRequest } from '../src/adapters/control-store/task-domain.js';
import { SQLiteGoalBindingStore } from '../src/adapters/control-store/goal-bindings.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { LocalArtifactStore } from '../src/adapters/artifacts/index.js';
import { GoalOperationUnknownError, type GoalAdapterOptions, type GoalAuthorityContext, type GoalBinding,
  type GoalCreateRequest, type GoalMutationRequest, type GoalReadResult, type NativeGoalView,
  type CoreDecisionRequest, type CoreDecisionResult } from '../src/adapters/dsh/goals.js';
import type { DshContext } from '../src/adapters/dsh/sessions.js';
import type { CoreCommands, CoreDomainRequest, CoreGoal, CorePrepareInput } from '../src/contracts/core.js';
import { installCoreCapabilityFixture } from './helpers/core-capability.js';
import { coreDecisionPrompt } from '../src/control/local-core.js';
import { createCoreReadView } from '../src/views/core.js';

// Real Core/Task/Goal-binding/authorization SQLite domains and actual bounded
// artifact files; only native lifecycle and model output are test doubles.
// Nothing here attaches to the installed DSH, calls a model or uses the network.
const CONTENT = 'Synthetic Core deliverable: preserve the mint notebook on shelf four.';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Local Core fixture timed out')), 3000); })]); }
  finally { clearTimeout(timer); }
}
async function completionFailure(work: Promise<unknown>, goalId: string): Promise<LocalCoreCompletionError> {
  let failure!: LocalCoreCompletionError;
  await assert.rejects(work, error => {
    assert.ok(error instanceof LocalCoreCompletionError); failure = error;
    assert.equal(error.code, 'CORE_COMPLETION_UNCONFIRMED'); assert.equal(error.goalId, goalId);
    assert.match(error.reasonCode, /^[A-Z_]{1,100}$/); assert.ok(error.cause instanceof Error);
    assert.equal(error.message, `Core completion requires inspection: ${goalId}; ${error.decisionId}; ${error.reasonCode}`);
    return true;
  });
  return failure;
}
type Mutation = 'create' | 'pause' | 'resume' | 'complete';
type Commands = CoreCommands & TaskCommands;

class NativeFixture implements LocalCoreAdapter {
  initialized = 0; closed = false;
  calls: string[] = [];
  readGoalIds: string[] = [];
  readFailures = new Map<string, Error>();
  decisions: CoreDecisionRequest[] = [];
  outputs: string[] = [];
  contexts: GoalAuthorityContext[] = [];
  proofs: unknown[] = [];
  natives = new Map<string, NativeGoalView>();
  output = JSON.stringify({ kind: 'task_intent', deliverableId: 'note', reason: 'Select the explicit owner deliverable.' });
  unknownAt?: Mutation;
  unknownDecision = false;
  beforeMutation?: (operation: Mutation) => void | Promise<void>;
  beforeSecond?: (operation: Mutation) => void | Promise<void>;
  afterDispatch?: (request: CoreDecisionRequest) => void | Promise<void>;
  beforeAccounting?: (request: CoreDecisionRequest) => void | Promise<void>;
  lastCapability?: object;
  constructor(readonly options: GoalAdapterOptions) { assert.equal(options.namespace, 'core'); }
  async initialize() { this.initialized++; }
  async close() { this.closed = true; }
  async create(request: GoalCreateRequest) { return this.mutate('create', request); }
  async pause(request: GoalMutationRequest) { return this.mutate('pause', request); }
  async resume(request: GoalMutationRequest) { return this.mutate('resume', request); }
  async complete(request: GoalMutationRequest) { return this.mutate('complete', request); }
  async read(goalId: string, capability: object): Promise<GoalReadResult> {
    this.calls.push('read'); this.readGoalIds.push(goalId); const binding = await this.options.bindings.load(goalId); assert.ok(binding);
    const verdict = await this.options.authority.authorize(capability, this.context(binding, 'read'));
    assert.equal(verdict.allowed, true, 'native read needs current opaque authority');
    const failure = this.readFailures.get(goalId); if (failure) throw failure;
    return { binding, native: structuredClone(this.natives.get(goalId)) };
  }
  private context(binding: GoalBinding, operation: GoalAuthorityContext['operation']): GoalAuthorityContext {
    return { operation, goalId: binding.goalId, ownerId: binding.ownerId, scope: binding.scope, completionCriteriaHash: binding.completionCriteriaHash };
  }
  private async mutate(operation: Mutation, request: GoalCreateRequest | GoalMutationRequest): Promise<GoalReadResult> {
    this.calls.push(operation); this.lastCapability = request.capability;
    const old = await this.options.bindings.load(request.goalId), create = request as GoalCreateRequest;
    const basis = old ?? { goalId: request.goalId, sessionId: `shiyu-core-fixture-${hash(request.goalId)}`, ownerId: create.ownerId,
      scope: create.scope, cwd: create.cwd, completionCriteriaHash: create.completionCriteriaHash, metadataVersion: 0 };
    const context = { ...this.context(basis, operation), ...('expectedRef' in request ? { expectedRef: request.expectedRef }
      : { changes: { objective: create.objective, maxGoalRounds: create.maxGoalRounds ?? 32 } }) };
    this.contexts.push(context);
    const first = await this.options.authority.authorize(request.capability, context);
    assert.equal(first.allowed, true, 'native lifecycle requires an opaque capability');
    if (!first.allowed) throw new Error('Denied');
    await this.beforeMutation?.(operation);
    let binding: GoalBinding = { ...basis, metadataVersion: basis.metadataVersion + 1,
      receipt: { commandId: request.commandId, operation, status: 'pending', postconditionHash: hash(`${operation}:${request.commandId}`),
        ...('expectedRef' in request ? { expectedRef: request.expectedRef } : {}),
        ...(first.completion ? { completionProof: first.completion, evidenceRefs: first.completion.evidenceRefs } : {}) } };
    await this.options.bindings.compareAndSet(old?.metadataVersion, binding);
    if (this.unknownAt === operation) {
      const version = binding.metadataVersion; binding = { ...binding, metadataVersion: version + 1, receipt: { ...binding.receipt!, status: 'unknown' } };
      await this.options.bindings.compareAndSet(version, binding); throw new GoalOperationUnknownError(binding, new Error('Synthetic lifecycle uncertainty'));
    }
    await this.beforeSecond?.(operation);
    const second = await this.options.authority.authorize(request.capability, context);
    assert.equal(second.allowed, true, 'native dispatch rechecks opaque authority');
    if (!second.allowed) throw new Error('Denied');
    request.signal?.throwIfAborted(); if (this.closed) throw new Error('Native fixture closed');
    if (operation === 'complete') { this.proofs.push(first.completion, second.completion); assert.deepEqual(first.completion, second.completion); }
    const previous = this.natives.get(request.goalId);
    const native: NativeGoalView = { ...(previous ?? { id: `native-${request.goalId}`, objective: create.objective, maxGoalRounds: create.maxGoalRounds ?? 1,
      roundsStarted: 0, createdAt: Date.now() }), revision: (previous?.revision ?? 0) + 1,
      phase: operation === 'pause' ? 'paused' : operation === 'complete' ? 'complete' : 'active', activation: 'disarmed', updatedAt: Date.now() };
    this.natives.set(request.goalId, native);
    const version = binding.metadataVersion, goalRef = { id: native.id, revision: native.revision };
    binding = { ...binding, metadataVersion: version + 1, goalRef, receipt: { ...binding.receipt!, status: 'confirmed', observedRef: goalRef } };
    await this.options.bindings.compareAndSet(version, binding); return { binding, native: structuredClone(native) };
  }
  async decisionRound(request: CoreDecisionRequest): Promise<CoreDecisionResult> {
    this.calls.push('decision'); this.decisions.push(request); this.lastCapability = request.capability;
    const text = this.outputs.length ? this.outputs.shift()! : this.output;
    const binding = await this.options.bindings.load(request.goalId); assert.ok(binding);
    const base = { ...this.context(binding, 'decision'), expectedRef: request.expectedRef, roundId: request.roundId };
    for (const phase of ['start', 'dispatch'] as const) {
      const verdict = await this.options.authority.authorize(request.capability, { ...base, phase }); assert.equal(verdict.allowed, true);
    }
    const dispatch = { goalId: request.goalId, goalRef: request.expectedRef, roundId: request.roundId, sessionId: binding.sessionId,
      messageId: `input:${request.roundId}`, messageHash: hash(request.prompt) };
    await request.onDispatch(dispatch); await this.afterDispatch?.(request);
    await this.beforeAccounting?.(request);
    // Late usage is a fact even when control cancellation already arrived.
    await request.onAccounting({ goalId: request.goalId, roundId: request.roundId, sessionId: binding.sessionId,
      usage: this.unknownDecision ? { status: 'unknown' } : { status: 'reported', totalTokens: 23, inputTokens: 17, outputTokens: 6 },
      modelCalls: this.unknownDecision ? null : 1, nativeObservations: this.unknownDecision ? [] : [{ type: 'assistant/message', seq: 11, usage: { totalTokens: 23 } }],
      dispatchAttempted: true, outcome: this.unknownDecision ? 'unknown' : 'observed' });
    if (this.unknownDecision) throw new Error('Synthetic native result lost');
    request.signal?.throwIfAborted();
    const resultGrant = await this.options.authority.authorize(request.capability, { ...base, phase: 'result' }); assert.equal(resultGrant.allowed, true);
    const inputRef = { sessionId: binding.sessionId, eventSeq: 10, messageId: dispatch.messageId, messageHash: dispatch.messageHash, durability: 'confirmed' as const };
    await request.onContextDurable?.(inputRef);
    return { binding: dispatch, text, inputRef,
      assistantRef: { sessionId: binding.sessionId, eventSeq: 11, messageId: `assistant:${request.roundId}`, messageHash: hash(text), durability: 'confirmed' },
      usage: { status: 'reported', totalTokens: 23, inputTokens: 17, outputTokens: 6 }, modelCalls: 1,
      nativeObservations: [{ type: 'assistant/message', seq: 11, usage: { totalTokens: 23 } }], verified: false,
      nativeRoundsStarted: { before: 0, after: 0 }, nativeGoalRound: false };
  }
}

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-local-core-')), db = new DatabaseSync(join(directory, 'control.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  const tx = new SqliteTransactions(db), runtimeIdentity = { hostEpoch: 'fixture-core-host', installationGeneration: 'fixture-core-install' };
  let allowed = true, capacity = true, inspections = 0, onGoalStopped: ((goal: CoreGoal) => void) | undefined;
  const tasks = new TaskDomain(db, tx, { runtimeIdentity }), bindings = new SQLiteGoalBindingStore(db, tx);
  const watermark = installCommitWatermark(db, tx), reads = installCoreCapabilityFixture(db, tx, tasks, runtimeIdentity, watermark);
  const core = new CoreDomain(db, tx, { runtimeIdentity, tasks, goals: bindings, isPaused: () => !allowed, ...reads });
  const artifacts = await LocalArtifactStore.open(join(directory, 'workspaces'));
  const trace: string[] = [], errors: { command: string; message: string; code?: string }[] = [];
  const store = { async request<K extends keyof Commands>(command: K, args: Commands[K]['input']): Promise<Commands[K]['output']> {
    trace.push(command);
    try { return (command.startsWith('core.') ? core.execute({ command, args } as CoreDomainRequest)
      : tasks.execute({ command, args } as TaskDomainRequest)) as Commands[K]['output']; }
    catch (error) { errors.push({ command, message: String(error), ...(error && typeof error === 'object' && 'code' in error ? { code: String(error.code) } : {}) }); throw error; }
  } };
  let native!: NativeFixture;
  const service = new LocalCoreService({ ctx: {} as DshContext, store, bindings: bindings.asPort(),
    artifacts: { prepareWorkspace: id => artifacts.prepareWorkspace(id), async inspect(input) { inspections++; return artifacts.inspect(input); } },
    assertRuntimeAllowed() { if (!allowed) throw new Error('Runtime paused'); }, hasCapacity: () => capacity,
    onGoalStopped: goal => onGoalStopped?.(goal),
    adapterFactory: options => native = new NativeFixture(options) });
  t.after(async () => {
    try { await service.close(); }
    finally {
      try { await artifacts.close(); }
      finally { try { db.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
    }
  });
  const input = (requestId = 'owner-core-one'): CorePrepareInput => ({ requestId, objective: 'Create the specified synthetic notebook note.',
    deliverables: [{ id: 'note', title: 'Synthetic notebook note', content: CONTENT }], budget: { tokens: 200000, calls: 20, effects: 4 },
    expiresAt: new Date(Date.now() + 3600000).toISOString(), maxEvaluations: 4 });
  const completeTask = async (taskId: string) => {
    const plan = await store.request('task.claimAssignment', { taskId, leaseMs: 180000 });
    await store.request('task.bindAssignment', { permit: plan.permit, sessionId: 'fixture-worker-session' });
    await store.request('task.assignmentStarted', { permit: plan.permit });
    const effect = await store.request('task.enqueueArtifact', { permit: plan.permit, content: plan.content });
    const claim = (await store.request('task.claimEffect', { permit: plan.permit, effectId: effect.effect.effectId }))!;
    await store.request('task.assertEffect', { permit: plan.permit, claim });
    const observation = await artifacts.write({ taskId, content: plan.content, expectedSha256: plan.expectedSha256 });
    await store.request('task.recordArtifactReceipt', { permit: plan.permit, claim, observedSha256: observation.sha256, observedBytes: observation.byteLength,
      observedAt: observation.observedAt, receiptId: `fixture-artifact:${plan.assignmentId}` });
    await store.request('task.settleUsage', { permit: plan.permit, usage: { status: 'reported', totalTokens: 15 }, calls: 1 });
    await store.request('task.report', { permit: plan.permit, state: 'ready', summary: 'Synthetic artifact is independently observable.' });
    await store.request('task.verify', { taskId }); core.enqueueTaskFact({ taskId, eventId: `fixture-completion:${taskId}` });
    return plan;
  };
  return { service, store, tasks, core, bindings, artifacts, directory, db, watermark, trace, errors, input, completeTask, reads,
    get native() { return native; }, get inspections() { return inspections; }, setAllowed(value: boolean) { allowed = value; }, setCapacity(value: boolean) { capacity = value; },
    setStopHook(hook: (goal: CoreGoal) => void) { onGoalStopped = hook; },
    get(goalId: string): Promise<CoreGoal> { return store.request('core.get', { goalId }); } };
}

test('owner creation binds one native Goal and duplicate requests never replay create; GET is native-free', async t => {
  const f = await setup(t), input = f.input(), goal = await f.service.create(input);
  assert.equal(goal.authorized, true); assert.equal(goal.native?.phase, 'active'); assert.deepEqual(f.native.calls, ['create']);
  const duplicate = await f.service.create(input); assert.equal(duplicate.goalId, goal.goalId); assert.equal(f.native.calls.filter(call => call === 'create').length, 1);
  const before = f.watermark.read(), calls = [...f.native.calls];
  await f.get(goal.goalId); await f.store.request('core.snapshot', {}); assert.deepEqual(f.watermark.read(), before); assert.deepEqual(f.native.calls, calls);
  await assert.rejects(f.service.create({ ...input, objective: 'Changed intent' }), /same|idempot|different/i);
});

test('capability unavailability is a zero-model pending state and the actual read-only view enters the later prompt', async t => {
  const f = await setup(t), goal = await f.service.create(f.input()), cap = f.reads.capability;
  cap.setEnabled({ requestId: 'pause-ability', expectedRevision: cap.snapshot().revision, enabled: false });
  const before = f.watermark.read();
  assert.equal((await f.service.evaluatePending()).status, 'idle');
  assert.equal(f.native.decisions.length, 0); assert.deepEqual(f.watermark.read(), before);
  cap.setEnabled({ requestId: 'resume-ability', expectedRevision: cap.snapshot().revision, enabled: true });
  assert.equal((await f.service.evaluatePending()).status, 'evaluated');
  assert.equal(f.native.decisions.length, 1);
  const text = f.native.decisions[0]!.prompt;
  const payload = JSON.parse(text.split('\n获准资料：')[1]!.split('\n能力资料')[0]!);
  assert.equal(payload.goalId, goal.goalId);
  assert.equal(payload.capabilityView.purpose, 'core_decision');
  assert.equal(payload.capabilityView.data[0].fields.capability.verification, 'unknown');
  assert.equal(payload.capabilityView.data[0].fields.capability.usableForAuthorizedTask, true);
  assert.equal(payload.capabilityView.authority.ability.authorityId, cap.snapshot().authorityId);
  assert.equal(payload.capabilityView.sourceRefs[0].sourceId, 'capability:task.local-note.execute');
  assert.ok(f.trace.includes('core.readView'));
});

test('capability revocation after a known model result rejects the intent instead of creating a permanent unknown', async t => {
  const f = await setup(t), goal = await f.service.create(f.input()), cap = f.reads.capability;
  f.native.beforeAccounting = () => { cap.setEnabled({ requestId: 'disable-during-model', expectedRevision: cap.snapshot().revision, enabled: false }); };
  assert.equal((await f.service.evaluatePending()).status, 'evaluated');
  const evaluation = (await f.store.request('core.evaluations', { goalId: goal.goalId }))[0]!;
  assert.equal(evaluation.status, 'rejected'); assert.equal(evaluation.reasonCode, 'CORE_CAPABILITY_CHANGED');
  const current = await f.get(goal.goalId);
  assert.equal(current.activeEvaluationId, undefined); assert.deepEqual(current.taskRefs, []);
  const balance = await f.store.request('core.balance', { goalId: goal.goalId });
  assert.deepEqual(balance!.held, { tokens: 0, calls: 0, effects: 0 });
  assert.equal((await f.service.evaluatePending()).status, 'idle'); assert.equal(f.native.decisions.length, 1);
  f.native.beforeAccounting = undefined;
  cap.setEnabled({ requestId: 'enable-after-known-rejection', expectedRevision: cap.snapshot().revision, enabled: true });
  assert.equal((await f.service.evaluatePending()).status, 'evaluated'); assert.equal(f.native.decisions.length, 2);
  assert.equal((await f.get(goal.goalId)).taskRefs.length, 1);
  const rounds = await f.store.request('core.evaluations', { goalId: goal.goalId });
  assert.equal(rounds[0]!.status, 'rejected'); assert.equal(rounds[1]!.status, 'committed');
  assert.notEqual(rounds[0]!.evaluationId, rounds[1]!.evaluationId);
});

test('capability disable between claim and ReadView makes zero native rounds and can later start a new bounded evaluation', async t => {
  const f = await setup(t), goal = await f.service.create(f.input()), cap = f.reads.capability;
  const request = f.store.request.bind(f.store); let disabled = false;
  f.store.request = async <K extends keyof Commands>(command: K, args: Commands[K]['input']): Promise<Commands[K]['output']> => {
    if (command === 'core.readView' && !disabled) {
      disabled = true; cap.setEnabled({ requestId: 'disable-before-view', expectedRevision: cap.snapshot().revision, enabled: false });
    }
    return request(command, args);
  };
  assert.equal((await f.service.evaluatePending()).status, 'evaluated'); assert.equal(f.native.decisions.length, 0);
  const first = (await f.store.request('core.evaluations', { goalId: goal.goalId }))[0]!;
  assert.equal(first.status, 'rejected'); assert.equal(first.reasonCode, 'CORE_VIEW_UNAVAILABLE');
  const balance = (await f.store.request('core.balance', { goalId: goal.goalId }))!;
  assert.deepEqual(balance.spent, { tokens: 0, calls: 0, effects: 0 }); assert.deepEqual(balance.held, balance.spent);
  assert.equal((await f.get(goal.goalId)).evaluations, 1);
  assert.equal((await f.service.evaluatePending()).status, 'idle'); assert.equal(f.native.decisions.length, 0);
  cap.setEnabled({ requestId: 'enable-after-view-failure', expectedRevision: cap.snapshot().revision, enabled: true });
  assert.equal((await f.service.evaluatePending()).status, 'evaluated'); assert.equal(f.native.decisions.length, 1);
  const rounds = await f.store.request('core.evaluations', { goalId: goal.goalId });
  assert.equal(rounds[0]!.status, 'rejected'); assert.equal(rounds[1]!.status, 'committed');
  assert.notEqual(rounds[0]!.evaluationId, rounds[1]!.evaluationId); assert.equal((await f.get(goal.goalId)).evaluations, 2);
});

test('a lost zero-call rejection response is read back as rejected rather than reported unknown', async t => {
  const f = await setup(t), goal = await f.service.create(f.input()), cap = f.reads.capability;
  const request = f.store.request.bind(f.store); let disabled = false, lost = false;
  f.store.request = async <K extends keyof Commands>(command: K, args: Commands[K]['input']): Promise<Commands[K]['output']> => {
    if (command === 'core.readView' && !disabled) {
      disabled = true; cap.setEnabled({ requestId: 'lost-response-disable', expectedRevision: cap.snapshot().revision, enabled: false });
    }
    const result = await request(command, args);
    if (command === 'core.rejectEvaluation' && !lost) { lost = true; throw new Error('Synthetic lost committed rejection response'); }
    return result;
  };
  assert.equal((await f.service.evaluatePending()).status, 'evaluated');
  assert.equal(lost, true); assert.equal(f.native.decisions.length, 0); assert.ok(f.trace.includes('core.markUnknown'));
  const evaluation = (await f.store.request('core.evaluations', { goalId: goal.goalId }))[0]!;
  assert.equal(evaluation.status, 'rejected'); assert.equal(evaluation.reasonCode, 'CORE_VIEW_UNAVAILABLE');
  const balance = (await f.store.request('core.balance', { goalId: goal.goalId }))!;
  assert.deepEqual(balance.spent, { tokens: 0, calls: 0, effects: 0 }); assert.deepEqual(balance.held, balance.spent);
});

test('model JSON and expired operation capabilities cannot impersonate owner authority', async t => {
  const f = await setup(t), goal = await f.service.create(f.input()), context = f.native.contexts[0]!;
  for (const capability of [{ trusted: true }, { ownerId: 'local-owner' }, f.native.lastCapability!]) {
    const verdict = await f.native.options.authority.authorize(capability, context); assert.equal(verdict.allowed, false);
  }
  assert.equal((await f.get(goal.goalId)).evaluations, 0); assert.equal(f.native.decisions.length, 0);
});

test('pause commits local stop before native write, while resume confirms native first and then reopens local admission', async t => {
  const f = await setup(t); let goal = await f.service.create(f.input()), notifications = 0;
  f.setStopHook(() => { notifications++; });
  f.native.beforeMutation = async operation => {
    if (operation === 'pause' || operation === 'resume') assert.equal((await f.get(goal.goalId)).paused, true, operation);
  };
  goal = await f.service.control('pause', { goalId: goal.goalId, expectedVersion: goal.version }); assert.equal(goal.paused, true); assert.equal(goal.native?.phase, 'paused');
  assert.equal(notifications, 1);
  goal = await f.service.control('resume', { goalId: goal.goalId, expectedVersion: goal.version }); assert.equal(goal.paused, false); assert.equal(goal.native?.phase, 'active');
  assert.equal(notifications, 1);
});

test('native resume uncertainty leaves local stop in place and blocks duplicate replay', async t => {
  const f = await setup(t); let goal = await f.service.create(f.input());
  goal = await f.service.control('pause', { goalId: goal.goalId, expectedVersion: goal.version }); f.native.unknownAt = 'resume';
  await assert.rejects(f.service.control('resume', { goalId: goal.goalId, expectedVersion: goal.version }));
  goal = await f.get(goal.goalId); assert.equal(goal.paused, true); assert.equal(f.bindings.load(goal.goalId)!.receipt!.status, 'unknown');
  const count = f.native.calls.filter(call => call === 'resume').length;
  await assert.rejects(f.service.control('resume', { goalId: goal.goalId, expectedVersion: goal.version }));
  assert.equal(f.native.calls.filter(call => call === 'resume').length, count);
});

test('unknown create leaves a persistent binding fence and duplicate owner request does not call native again', async t => {
  const f = await setup(t); await f.service.initialize(); f.native.unknownAt = 'create'; const input = f.input();
  await assert.rejects(f.service.create(input)); const goal = (await f.store.request('core.snapshot', {}))[0]!;
  assert.equal(goal.authorized, false); assert.equal(f.bindings.load(goal.goalId)!.receipt!.status, 'unknown');
  const duplicate = await f.service.create(input); assert.equal(duplicate.goalId, goal.goalId); assert.equal(duplicate.authorized, false);
  assert.equal(f.bindings.load(goal.goalId)!.receipt!.status, 'unknown'); assert.equal(f.native.calls.filter(call => call === 'create').length, 1);
});

test('an owner stop after durable preparation cannot be undone by repeating create', async t => {
  const f = await setup(t), input = f.input();
  const prepared = await f.store.request('core.prepareGoal', input);
  const paused = await f.service.control('pause', { goalId: prepared.goalId, expectedVersion: prepared.version });
  assert.ok(paused.controlEpoch > prepared.controlEpoch); assert.equal(paused.paused, true);
  await assert.rejects(f.service.create(input), error => error instanceof Error && 'code' in error && error.code === 'RECOVERY_REQUIRED');
  assert.equal(f.bindings.load(prepared.goalId), undefined); assert.deepEqual(f.native.calls, []);
  assert.equal((await f.get(prepared.goalId)).authorized, false);
});

test('one verified native proposal creates only its owner-scoped Task and no unchanged input starts another evaluation', async t => {
  const f = await setup(t), goal = await f.service.create(f.input());
  const result = await f.service.evaluatePending(); assert.equal(result.status, 'evaluated');
  const current = await f.get(goal.goalId); assert.equal(current.taskRefs.length, 1); assert.equal(current.taskRefs[0]!.deliverableId, 'note');
  const task = await f.store.request('task.get', { taskId: current.taskRefs[0]!.taskId }); assert.equal(task.task.goalId, goal.goalId); assert.equal(task.task.state, 'queued');
  const evaluation = (await f.store.request('core.evaluations', { goalId: goal.goalId }))[0]!;
  assert.equal(evaluation.status, 'committed'); assert.equal(evaluation.reservation.observed.tokens, 23); assert.equal(evaluation.reservation.observed.calls, 1);
  assert.ok(evaluation.nativeReceipt); assert.equal(f.native.decisions.length, 1);
  assert.equal((await f.service.evaluatePending()).status, 'idle'); assert.equal(f.native.decisions.length, 1);
});

test('lost native decision outcome stays unknown across repeated evaluation scans and does not create a Task', async t => {
  const f = await setup(t), goal = await f.service.create(f.input()); f.native.unknownDecision = true;
  assert.equal((await f.service.evaluatePending()).status, 'unknown');
  const evaluation = (await f.store.request('core.evaluations', { goalId: goal.goalId }))[0]!;
  assert.equal(evaluation.status, 'unknown'); assert.equal(evaluation.reservation.state, 'unknown'); assert.equal((await f.get(goal.goalId)).taskRefs.length, 0);
  for (let count = 0; count < 3; count++) await f.service.evaluatePending(); assert.equal(f.native.decisions.length, 1);
});

for (const [name, output] of [
  ['invalid JSON', '{"kind":'],
  ['an unauthorized deliverable', JSON.stringify({ kind: 'task_intent', deliverableId: 'not-owner-authorized', reason: 'Choose something else.' })],
] as const) test(`a known proposal rejection for ${name} settles once without an unknown evaluation or replay`, async t => {
  const f = await setup(t), goal = await f.service.create(f.input()); f.native.output = output;
  const result = await f.service.evaluatePending(); assert.equal(result.status, 'evaluated');
  const evaluation = (await f.store.request('core.evaluations', { goalId: goal.goalId }))[0]!;
  assert.equal(evaluation.status, 'rejected'); assert.equal(evaluation.reservation.state, 'settled');
  assert.ok(evaluation.nativeReceipt); assert.equal(evaluation.reservation.observed.tokens, 23);
  const current = await f.get(goal.goalId); assert.equal(current.activeEvaluationId, undefined); assert.equal(current.taskRefs.length, 0);
  assert.equal(f.bindings.load(goal.goalId)!.receipt!.status, 'confirmed');
  for (let count = 0; count < 3; count++) assert.equal((await f.service.evaluatePending()).status, 'idle');
  assert.equal(f.native.decisions.length, 1);
});

test('late complete accounting after owner pause is recorded as fact without committing the cancelled proposal', async t => {
  const f = await setup(t), goal = await f.service.create(f.input());
  let pausing!: Promise<CoreGoal>;
  f.native.afterDispatch = async request => {
    const current = await f.get(goal.goalId);
    pausing = f.service.control('pause', { goalId: goal.goalId, expectedVersion: current.version });
    // The local fence/cancel must not wait for the serialized native lifecycle
    // lock; the native pause itself waits until this decision drains.
    await bounded(new Promise<void>(resolve => { if (request.signal!.aborted) resolve(); else request.signal!.addEventListener('abort', () => resolve(), { once: true }); }));
  };
  assert.equal((await f.service.evaluatePending()).status, 'unknown');
  await bounded(pausing);
  const current = await f.get(goal.goalId), evaluation = (await f.store.request('core.evaluations', { goalId: goal.goalId }))[0]!;
  assert.equal(current.paused, true); assert.equal(current.taskRefs.length, 0); assert.equal(evaluation.status, 'unknown');
  const rows = f.db.prepare('SELECT value FROM shiyu_core_accounting').all(); assert.equal(rows.length, 1);
  const accounting = JSON.parse(String(rows[0]!.value)); assert.equal(accounting.state, 'settled');
  assert.equal(accounting.observed.tokens, 23); assert.equal(accounting.observed.calls, 1);
});

for (const kind of ['pause', 'cancel'] as const) test(`${kind} notifies after the durable fence and abort, before a blocked native lifecycle lock`, async t => {
  const f = await setup(t), goal = await f.service.create(f.input()), entered = gate(), release = gate(), notified = gate();
  const order: string[] = []; let notifications = 0;
  f.native.beforeAccounting = async () => { entered.resolve(); await release.promise; };
  f.native.beforeMutation = operation => { if (operation === 'pause') order.push('native-pause'); };
  f.setStopHook(stopped => {
    const durable = f.core.execute({ command: 'core.get', args: { goalId: goal.goalId } }) as CoreGoal;
    assert.equal(f.db.isTransaction, false); assert.equal(durable.paused, true); assert.equal(durable.cancelled, kind === 'cancel');
    assert.ok(durable.controlEpoch > goal.controlEpoch); assert.equal(stopped.controlEpoch, durable.controlEpoch); assert.equal(stopped.version, durable.version);
    assert.equal(f.native.decisions[0]!.signal!.aborted, true); assert.equal(f.native.calls.includes('pause'), false);
    notifications++; order.push('notified');
    // The trusted observer receives a copy, so accidental mutation cannot
    // change the service's subsequent native target or the persisted record.
    stopped.goalId = 'notification-copy'; stopped.native!.phase = 'complete'; notified.resolve();
  });
  let running: Promise<unknown> | undefined, stopping: Promise<CoreGoal> | undefined;
  try {
    running = f.service.evaluatePending(); await bounded(entered.promise);
    const current = await f.get(goal.goalId);
    stopping = f.service.control(kind, { goalId: goal.goalId, expectedVersion: current.version }); void stopping.catch(() => {});
    await bounded(notified.promise); assert.deepEqual(order, ['notified']);
    let stopped = false; void stopping.then(() => { stopped = true; }, () => {}); await tick(); assert.equal(stopped, false);
    release.resolve(); const [, result] = await bounded(Promise.all([running, stopping]));
    assert.equal(result.goalId, goal.goalId); assert.equal(result.paused, true); assert.equal(result.cancelled, kind === 'cancel');
    assert.equal(result.native?.phase, 'paused'); assert.deepEqual(order, ['notified', 'native-pause']); assert.equal(notifications, 1);
  } finally { release.resolve(); await Promise.allSettled([running, stopping]); }
});

test('completion requires fresh artifact readback at both native authority checks', async t => {
  const f = await setup(t), goal = await f.service.create(f.input()); await f.service.evaluatePending();
  await f.completeTask((await f.get(goal.goalId)).taskRefs[0]!.taskId); f.native.output = JSON.stringify({ kind: 'complete_candidate', reason: 'All scoped artifacts are complete.' });
  const before = f.inspections; assert.equal((await f.service.evaluatePending()).status, 'evaluated', JSON.stringify(f.errors));
  assert.equal((await f.get(goal.goalId)).native?.phase, 'complete'); assert.ok(f.inspections - before >= 3);
  assert.equal(f.native.proofs.length, 2); assert.deepEqual(f.native.proofs[0], f.native.proofs[1]);
});

test('a file changed between completion checks cannot be replaced by model success text', async t => {
  const f = await setup(t), goal = await f.service.create(f.input()); await f.service.evaluatePending();
  const taskId = (await f.get(goal.goalId)).taskRefs[0]!.taskId; await f.completeTask(taskId);
  f.native.output = JSON.stringify({ kind: 'complete_candidate', reason: 'I claim everything is finished.' });
  let changed = false;
  f.native.beforeSecond = async operation => { if (operation === 'complete') { changed = true; await writeFile(join(f.directory, 'workspaces', taskId, 'artifacts/note.txt'), 'Changed after first completion proof'); } };
  const error = await completionFailure(f.service.evaluatePending(), goal.goalId);
  assert.notEqual((await f.get(goal.goalId)).native?.phase, 'complete');
  assert.equal(changed, true); assert.notEqual(f.native.natives.get(goal.goalId)!.phase, 'complete');
  const evaluation = (await f.store.request('core.evaluations', { goalId: goal.goalId }))[1]!;
  assert.equal(evaluation.status, 'committed'); assert.equal(evaluation.reservation.state, 'settled'); assert.equal(error.decisionId, evaluation.receipt!.proposalId);
  for (let count = 0; count < 3; count++) await f.service.evaluatePending();
  assert.equal(f.native.decisions.length, 2); assert.equal(f.native.calls.filter(call => call === 'complete').length, 1);
});

test('damaged artifact preflight reports completion failure without starting an uncertain native command', async t => {
  const f = await setup(t), goal = await f.service.create(f.input()); await f.service.evaluatePending();
  const taskId = (await f.get(goal.goalId)).taskRefs[0]!.taskId; await f.completeTask(taskId);
  const binding = f.bindings.load(goal.goalId)!; assert.equal(binding.receipt!.status, 'confirmed');
  await writeFile(join(f.directory, 'workspaces', taskId, 'artifacts/note.txt'), 'Already damaged before completion admission');
  f.native.output = JSON.stringify({ kind: 'complete_candidate', reason: 'A proposal still needs independent artifact verification.' });
  const error = await completionFailure(f.service.evaluatePending(), goal.goalId);
  const evaluation = (await f.store.request('core.evaluations', { goalId: goal.goalId }))[1]!;
  assert.equal(evaluation.status, 'committed'); assert.equal(evaluation.reservation.state, 'settled'); assert.equal(error.decisionId, evaluation.receipt!.proposalId);
  assert.deepEqual(f.bindings.load(goal.goalId), binding); assert.equal((await f.get(goal.goalId)).activeEvaluationId, undefined);
  assert.equal(f.native.calls.filter(call => call === 'complete').length, 0); assert.equal(f.native.proofs.length, 0);
  for (let count = 0; count < 3; count++) await f.service.evaluatePending();
  assert.equal(f.native.decisions.length, 2); assert.equal(f.native.calls.filter(call => call === 'complete').length, 0);
});

test('native completion uncertainty preserves the already committed decision and never repeats its model call', async t => {
  const f = await setup(t), goal = await f.service.create(f.input()); await f.service.evaluatePending();
  await f.completeTask((await f.get(goal.goalId)).taskRefs[0]!.taskId);
  f.native.output = JSON.stringify({ kind: 'complete_candidate', reason: 'All scoped artifacts are independently verified.' });
  f.native.unknownAt = 'complete'; const error = await completionFailure(f.service.evaluatePending(), goal.goalId);
  const evaluations = await f.store.request('core.evaluations', { goalId: goal.goalId });
  assert.equal(evaluations.length, 2); assert.equal(evaluations[1]!.status, 'committed'); assert.equal(evaluations[1]!.reservation.state, 'settled');
  assert.equal(error.decisionId, evaluations[1]!.receipt!.proposalId);
  assert.equal(f.bindings.load(goal.goalId)!.receipt!.status, 'unknown');
  const current = await f.get(goal.goalId); assert.equal(current.activeEvaluationId, undefined); assert.notEqual(current.native?.phase, 'complete');
  for (let count = 0; count < 3; count++) await f.service.evaluatePending();
  assert.equal(f.native.decisions.length, 2); assert.equal(f.native.calls.filter(call => call === 'complete').length, 1);
});

test('capacity and runtime pause reject before a durable evaluation or native model call', async t => {
  const f = await setup(t), goal = await f.service.create(f.input()); f.setCapacity(false);
  const result = await f.service.evaluatePending(); assert.ok(['deferred', 'idle'].includes(result.status));
  assert.equal((await f.get(goal.goalId)).evaluations, 0); assert.equal(f.native.decisions.length, 0);
  f.setCapacity(true); f.setAllowed(false); await f.service.evaluatePending().catch(() => undefined);
  assert.equal((await f.get(goal.goalId)).evaluations, 0); assert.equal(f.native.decisions.length, 0);
});

test('a native preflight failure backs off only its Goal and the next scan can evaluate another Goal without replay', async t => {
  const f = await setup(t), first = await f.service.create(f.input('preflight-owner-a')), second = await f.service.create(f.input('preflight-owner-b'));
  const failure = new Error('Synthetic private native read details must not enter the pump message');
  f.native.readFailures.set(first.goalId, failure);
  const balance = await f.store.request('core.balance', { goalId: first.goalId });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let firstRetryAt!: string;
  const checkFailure = (error: unknown): boolean => {
    assert.ok(error instanceof LocalCorePreflightError); assert.equal(error.code, 'CORE_PREFLIGHT_FAILED');
    assert.equal(error.goalId, first.goalId); assert.equal(error.cause, failure); assert.match(error.reasonCode, /^[A-Z_]{1,100}$/);
    assert.equal(error.retryAt, new Date(Date.now() + 30000).toISOString()); firstRetryAt = error.retryAt;
    assert.equal(error.message, `Core native preflight failed: ${first.goalId}; ${error.reasonCode}; retryAt=${error.retryAt}`);
    assert.equal(error.message.includes(failure.message), false); return true;
  };
  await assert.rejects(f.service.evaluatePending(), checkFailure);
  assert.deepEqual(await f.store.request('core.evaluations', { goalId: first.goalId }), []);
  assert.deepEqual(await f.store.request('core.balance', { goalId: first.goalId }), balance);
  assert.equal((await f.get(first.goalId)).activeEvaluationId, undefined); assert.equal(f.native.decisions.length, 0);
  assert.equal(f.trace.filter(command => command === 'core.claim').length, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM shiyu_core_accounting').get()!.n, 0);
  const result = await f.service.evaluatePending(); assert.equal(result.status, 'evaluated'); assert.equal(result.goalId, second.goalId);
  assert.deepEqual(f.native.decisions.map(value => value.goalId), [second.goalId]);
  assert.equal((await f.get(second.goalId)).taskRefs.length, 1);
  for (let count = 0; count < 3; count++) {
    const waiting = await f.service.evaluatePending(); assert.equal(waiting.status, 'deferred'); assert.equal(waiting.retryAt, firstRetryAt);
  }
  assert.equal(f.native.readGoalIds.filter(id => id === first.goalId).length, 1); assert.equal(f.native.decisions.length, 1);
  t.mock.timers.tick(30000);
  await assert.rejects(f.service.evaluatePending(), checkFailure);
  assert.equal(f.native.readGoalIds.filter(id => id === first.goalId).length, 2);
  assert.deepEqual(await f.store.request('core.evaluations', { goalId: first.goalId }), []);
  assert.deepEqual(await f.store.request('core.balance', { goalId: first.goalId }), balance); assert.equal(f.native.decisions.length, 1);
});

test('an empty pending set never initializes the native Goal adapter', async t => {
  const f = await setup(t); assert.equal(f.native.initialized, 0);
  assert.equal((await f.service.evaluatePending()).status, 'idle');
  assert.equal(f.native.initialized, 0); assert.deepEqual(f.native.calls, []);
});

test('a full page of backed-off Goals does not hide a healthy Goal beyond the pending cursor', async t => {
  const f = await setup(t), failed: string[] = [];
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (let index = 0; index < 20; index++) {
    const goal = await f.service.create(f.input(`cursor-owner-${index}`)); failed.push(goal.goalId);
    f.native.readFailures.set(goal.goalId, new Error('Synthetic per-Goal native read failure'));
  }
  for (const goalId of failed) await assert.rejects(f.service.evaluatePending(), error => error instanceof LocalCorePreflightError && error.goalId === goalId);
  assert.deepEqual(f.native.readGoalIds, failed); assert.equal(f.native.decisions.length, 0);
  const deferred = await f.service.evaluatePending(); assert.equal(deferred.status, 'deferred');
  assert.deepEqual(f.native.readGoalIds, failed);
  const healthy = await f.service.create(f.input('cursor-owner-healthy'));
  const result = await f.service.evaluatePending(); assert.equal(result.status, 'evaluated'); assert.equal(result.goalId, healthy.goalId);
  assert.deepEqual(f.native.decisions.map(value => value.goalId), [healthy.goalId]);
  assert.deepEqual(f.native.readGoalIds.filter(id => failed.includes(id)), failed);
  for (const goalId of failed) assert.deepEqual(await f.store.request('core.evaluations', { goalId }), []);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shiyu_core_accounting').get()!.n, 1);
});

test('global initialization failure is preserved before any per-Goal preflight, claim or usage', async t => {
  const f = await setup(t), first = await f.service.create(f.input('initialize-owner-a')), second = await f.service.create(f.input('initialize-owner-b'));
  const failure = new Error('Synthetic native adapter initialization failure'); let adapter!: NativeFixture;
  const service = new LocalCoreService({ ctx: {} as DshContext, store: f.store, bindings: f.bindings.asPort(), artifacts: f.artifacts,
    assertRuntimeAllowed() {}, adapterFactory(options) {
      adapter = new NativeFixture(options); adapter.initialize = async () => { adapter.initialized++; throw failure; }; return adapter;
    } });
  try {
    for (let count = 0; count < 2; count++) await assert.rejects(service.evaluatePending(), error => error === failure);
    assert.equal(adapter.initialized, 1); assert.deepEqual(adapter.readGoalIds, []); assert.equal(adapter.decisions.length, 0);
    assert.equal(f.trace.filter(command => command === 'core.claim').length, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM shiyu_core_accounting').get()!.n, 0);
    for (const goal of [first, second]) assert.deepEqual(await f.store.request('core.evaluations', { goalId: goal.goalId }), []);
    // No persistent per-Goal stop was manufactured by the failed adapter.
    const result = await f.service.evaluatePending(); assert.equal(result.status, 'evaluated'); assert.equal(result.goalId, first.goalId);
  } finally { await service.close(); }
});

test('one service evaluation owns dispatch and close aborts but drains late accounting before returning', async t => {
  const f = await setup(t), goal = await f.service.create(f.input()), entered = gate(), release = gate();
  f.native.beforeAccounting = async () => { entered.resolve(); await release.promise; };
  try {
    const running = f.service.evaluatePending(); await bounded(entered.promise);
    const second = await f.service.evaluatePending(); assert.ok(['deferred', 'idle'].includes(second.status)); assert.equal(f.native.decisions.length, 1);
    const closing = f.service.close(); assert.equal(f.native.decisions[0]!.signal!.aborted, true);
    let done = false; void closing.then(() => { done = true; }); await tick(); assert.equal(done, false);
    release.resolve(); await bounded(Promise.all([running, closing]));
    assert.equal(f.native.closed, true); assert.equal((await f.get(goal.goalId)).taskRefs.length, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM shiyu_core_accounting').get()!.n, 1);
  } finally { release.resolve(); await f.service.close(); }
});

// ---- H3 controlled plan / multi-step core extension (synthetic model records) ----
const PLAN_CONTENT = { first: 'Synthetic plan note one: collect the owner facts.', second: 'Synthetic plan note two: write the approved summary.' };
function multiInput(requestId: string): CorePrepareInput {
  return { requestId, objective: 'Plan and complete the two owner supplied synthetic notes',
    deliverables: [{ id: 'first', title: 'Collect facts', content: PLAN_CONTENT.first },
      { id: 'second', title: 'Write summary', content: PLAN_CONTENT.second, dependsOn: ['first'] }],
    budget: { tokens: 400000, calls: 40, effects: 8 }, expiresAt: new Date(Date.now() + 3600000).toISOString(), maxEvaluations: 8 };
}
function planText(goal: CoreGoal, stepIds: Record<string, string>, options: { basePlanVersion?: number } = {}): string {
  const steps = goal.deliverables.map(deliverable => ({ stepId: stepIds[deliverable.id]!, deliverableId: deliverable.id,
    dependsOn: (deliverable.dependsOn ?? []).map(dependency => stepIds[dependency]!), requiredFacts: [] as { kind: string; ref: string }[],
    expectedArtifact: { kind: 'local-note', verifier: 'artifact.sha256.v1' } }));
  return JSON.stringify({ kind: 'plan_candidate', plan: { basePlanVersion: options.basePlanVersion ?? goal.planVersion, steps,
    stopConditions: { onStepFailure: 'stop', maxFailedSteps: 0, onFactConflict: 'wait', maxParallelSteps: 2 },
    reasoningRefs: [`goal:${goal.goalId}`, `owner-core-request:${goal.requestId}`], summary: 'Synthetic controlled plan' } });
}
function revisionText(goal: CoreGoal, stepId: string, deliverableId: string, taskId: string, basePlanVersion: number): string {
  return JSON.stringify({ kind: 'plan_candidate', plan: { basePlanVersion,
    steps: [{ stepId, deliverableId, dependsOn: [], requiredFacts: [{ kind: 'task', ref: taskId }],
      expectedArtifact: { kind: 'local-note', verifier: 'artifact.sha256.v1' } }],
    stopConditions: { onStepFailure: 'stop', maxFailedSteps: 0, onFactConflict: 'wait', maxParallelSteps: 2 },
    reasoningRefs: [`goal:${goal.goalId}`, taskId], summary: 'Continue after the verified dependency result' } });
}

test('a synthetic model plan admits only the dependency-ready owner Task, revises after its result and completes independently', async t => {
  const f = await setup(t), goal = await f.service.create(multiInput('synthetic-plan-flow'));
  f.native.outputs.push(planText(goal, { first: 's1', second: 's2' }));
  assert.equal((await f.service.evaluatePending()).status, 'evaluated');
  let current = await f.get(goal.goalId);
  assert.equal(current.planVersion, 1);
  assert.deepEqual(current.taskRefs.map(ref => ref.deliverableId), ['first']);
  const plan = await f.store.request('core.plan', { goalId: goal.goalId });
  assert.equal(plan.planVersion, 1); assert.equal(plan.history.length, 1);
  assert.deepEqual(plan.snapshot!.steps.map(step => step.state), ['active', 'blocked_dependency']);
  assert.equal(f.native.decisions.length, 1);
  assert.match(f.native.decisions[0]!.prompt, /计划与事实目录摘要：sha256:[a-f0-9]{64}$/);
  assert.equal(f.native.decisions[0]!.prompt.includes('"plan":null'), true);
  const firstTask = current.taskRefs[0]!.taskId;
  await f.completeTask(firstTask);
  const firstEvaluation = (await f.store.request('core.evaluations', { goalId: goal.goalId }))[0]!;
  assert.equal(firstEvaluation.status, 'committed');
  f.native.outputs.push(revisionText(goal, 's2r', 'second', firstTask, 1));
  assert.equal((await f.service.evaluatePending()).status, 'evaluated');
  current = await f.get(goal.goalId);
  assert.equal(current.planVersion, 2);
  assert.deepEqual(current.taskRefs.map(ref => ref.deliverableId), ['first', 'second']);
  const revisedPlan = await f.store.request('core.plan', { goalId: goal.goalId });
  assert.equal(revisedPlan.history.length, 2); assert.equal(revisedPlan.history[0]!.planVersion, 1);
  assert.deepEqual(revisedPlan.current!.facts.map(fact => [fact.kind, fact.ref, fact.state]), [['task', firstTask, 'resolved']]);
  assert.equal(f.native.decisions.length, 2);
  assert.equal(f.native.decisions[1]!.prompt.includes('"planVersion":1'), true);
  await f.completeTask(current.taskRefs[1]!.taskId);
  f.native.outputs.push(JSON.stringify({ kind: 'complete_candidate', reason: 'Both independently verified artifacts exist' }));
  assert.equal((await f.service.evaluatePending()).status, 'evaluated');
  assert.equal(f.native.natives.get(goal.goalId)!.phase, 'complete');
  assert.equal(f.native.calls.filter(call => call === 'complete').length, 1);
  assert.equal(f.native.proofs.length, 2);
  const completed = (await f.store.request('core.evaluations', { goalId: goal.goalId })).at(-1)!;
  assert.equal(completed.status, 'committed'); assert.equal(completed.receipt!.kind, 'complete_candidate');
});

test('an invalid plan response settles as one deterministic rejection and never replays an unknown or second model call', async t => {
  const f = await setup(t), goal = await f.service.create(multiInput('synthetic-plan-reject'));
  f.native.outputs.push('{"kind":"plan_candidate","plan":');
  assert.equal((await f.service.evaluatePending()).status, 'evaluated');
  const evaluations = await f.store.request('core.evaluations', { goalId: goal.goalId });
  assert.equal(evaluations.length, 1); assert.equal(evaluations[0]!.status, 'rejected');
  assert.equal(evaluations[0]!.reasonCode, 'INVALID_CORE_CANDIDATE');
  const current = await f.get(goal.goalId);
  assert.equal(current.planVersion, 0); assert.deepEqual(current.taskRefs, []);
  assert.equal((await f.store.request('task.list', {})).length, 0);
  for (let count = 0; count < 5; count++) assert.ok(['idle', 'deferred'].includes((await f.service.evaluatePending()).status));
  assert.equal(f.native.decisions.length, 1);
  assert.equal((await f.store.request('core.evaluations', { goalId: goal.goalId })).length, 1);
});

test('the Core prompt is deterministic over one captured state and omits volatile view identity', async t => {
  const f = await setup(t), goal = await f.service.create(multiInput('synthetic-plan-prompt'));
  const evaluation = await f.store.request('core.claim', { goalId: goal.goalId });
  assert.ok(evaluation?.readCapture);
  const readView = async () => {
    const views = createCoreReadView(evaluation!.readCapture!, { validate: async () => f.store.request('core.readView', { permit: evaluation!.permit }) });
    try { return await views.read(); } finally { views.dispose(); }
  };
  const first = await readView(), second = await readView();
  const promptA = coreDecisionPrompt(evaluation!, first), promptB = coreDecisionPrompt(evaluation!, second);
  assert.equal(promptA, promptB);
  assert.equal(promptA.includes('generatedAt'), false);
  assert.equal(promptA.includes('viewId'), false);
  assert.match(promptA, /获准资料：/);
  assert.match(promptA, /计划与事实目录摘要：sha256:[a-f0-9]{64}$/);
  assert.equal(promptA.includes('"planVersion":0'), true);
  assert.equal(promptA.includes('"plan":null'), true);
});

test('a planned Goal with no new fact performs no extra model round or plan revision', async t => {
  const f = await setup(t), goal = await f.service.create(multiInput('synthetic-plan-quiet'));
  f.native.outputs.push(planText(goal, { first: 's1', second: 's2' }));
  assert.equal((await f.service.evaluatePending()).status, 'evaluated');
  const decisions = f.native.decisions.length;
  for (let count = 0; count < 10; count++) assert.ok(['idle', 'deferred'].includes((await f.service.evaluatePending()).status));
  assert.equal(f.native.decisions.length, decisions);
  assert.equal((await f.store.request('core.evaluations', { goalId: goal.goalId })).length, 1);
  assert.equal((await f.get(goal.goalId)).planVersion, 1);
  assert.equal((await f.store.request('core.plan', { goalId: goal.goalId })).history.length, 1);
});
