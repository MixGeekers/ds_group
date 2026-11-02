import { prepareSyntheticLocalNote } from './helpers/capability.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { RuntimeService, type CoreDriver, type SessionDriver } from '../src/runtime.js';
import { serveState } from '../src/index.js';
import type { DshContext } from '../src/adapters/dsh/sessions.js';
import type { GoalBinding } from '../src/adapters/dsh/goals.js';
import type { WorkerRunRequest, WorkerRunResult } from '../src/adapters/dsh/workers.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import type { CoreGoal, CorePrepareInput } from '../src/contracts/core.js';
import type { LocalCoreOptions } from '../src/control/local-core.js';
import type { CorePump, CoreEvaluationResult } from '../src/control/core-pump.js';

// These tests exercise the public Runtime, real Worker and temporary SQLite.
// Core and native drivers are synthetic boundaries: no DSH, network, generation,
// embedding, real native Goal or live installation is read or invoked.
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture did not settle within 5 seconds')), 5000); })]); }
  finally { clearTimeout(timer); }
}
const input = (requestId = 'synthetic-core'): CorePrepareInput => ({ requestId, objective: 'Produce the owner specified synthetic note.',
  deliverables: [{ id: 'note', title: 'Synthetic note', content: 'PRIVATE_SYNTHETIC_DELIVERABLE_BODY' }],
  budget: { tokens: 100000, calls: 8, effects: 2 }, expiresAt: new Date(Date.now() + 3600000).toISOString(), maxEvaluations: 3 });
const pump = (runtime: RuntimeService): CorePump => (runtime as unknown as { corePump: CorePump }).corePump;
type PublicGoal = Omit<CoreGoal, 'deliverables'> & { deliverables: { id: string; title: string; bodyBytes: number }[] };

class SyntheticCore implements CoreDriver {
  readonly creates: CorePrepareInput[] = [];
  readonly controls: { kind: 'pause' | 'cancel' | 'resume'; goalId: string; expectedVersion: number }[] = [];
  readonly evaluations: AbortSignal[] = [];
  readonly cancelledGoals: string[] = [];
  cancellations = 0;
  closes = 0;
  closeFailure = false;
  afterStop?: (goal: CoreGoal) => Promise<void>;
  evaluate: (signal: AbortSignal) => Promise<CoreEvaluationResult> = async () => ({ status: 'idle' });
  private readonly active = new Set<Promise<CoreEvaluationResult>>();
  private closing?: Promise<void>;
  constructor(readonly options: LocalCoreOptions, private readonly trace: string[]) {}
  async create(value: CorePrepareInput, signal?: AbortSignal): Promise<CoreGoal> {
    signal?.throwIfAborted(); await this.options.assertRuntimeAllowed(); this.creates.push(structuredClone(value));
    // Keep real input validation and persisted Goal admission in the path. This
    // double deliberately leaves native creation/authorization unperformed.
    return this.options.store.request('core.prepareGoal', value);
  }
  async control(kind: 'pause' | 'cancel' | 'resume', value: { goalId: string; expectedVersion: number }, signal?: AbortSignal) {
    signal?.throwIfAborted(); this.controls.push({ kind, ...value });
    if (kind === 'resume') await this.options.assertRuntimeAllowed();
    const goal = await this.options.store.request(kind === 'pause' ? 'core.pause' : kind === 'cancel' ? 'core.cancel' : 'core.resume', value);
    if (kind !== 'resume') {
      this.cancelGoal(value.goalId); this.options.onGoalStopped?.(goal); await this.afterStop?.(goal);
    }
    return goal;
  }
  evaluatePending(value: { signal?: AbortSignal } = {}): Promise<CoreEvaluationResult> {
    assert.ok(value.signal); this.evaluations.push(value.signal); this.trace.push('core.evaluate');
    const work = this.evaluate(value.signal); this.active.add(work);
    void work.finally(() => this.active.delete(work)).catch(() => undefined); return work;
  }
  cancelGoal(goalId: string): void { this.cancelledGoals.push(goalId); }
  cancelAll(): void { this.cancellations++; this.trace.push('core.cancelAll'); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closes++; this.trace.push('core.close'); this.cancelAll();
    this.closing = this.closeFailure ? Promise.reject(new Error('Synthetic core close failed'))
      : Promise.allSettled([...this.active]).then(() => { this.trace.push('core.drained'); });
    return this.closing;
  }
}

async function fixture(t: TestContext, options: { failFactory?: boolean; allowCloseFailure?: boolean; configureCore?(core: SyntheticCore): void } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-runtime-core-'));
  const trace: string[] = [], runtimes: RuntimeService[] = [], cores: SyntheticCore[] = [], gates: ReturnType<typeof deferred>[] = [];
  const forbidden = { probe: 0, generation: 0, goal: 0 }, workerCalls: WorkerRunRequest[] = [];
  let factoryCalls = 0;
  const workers = {
    prepareLocalNote: prepareSyntheticLocalNote,
    async initialize() {}, async close() { trace.push('workers.close'); },
    async run(request: WorkerRunRequest): Promise<WorkerRunResult> { workerCalls.push(request); return workers.execute(request); },
    async execute(_request: WorkerRunRequest): Promise<WorkerRunResult> { throw new Error('Synthetic worker boundary is not configured'); },
  };
  const sessions: SessionDriver = {
    async initialize() {}, async prepareContextSafety() { return { ready: true, messageFactory: 'injected', nativeReadback: true, coldProjection: true }; },
    async probe() { forbidden.probe++; throw new Error('Native probe forbidden'); },
    async generateReply() { forbidden.generation++; throw new Error('Generation forbidden'); },
    async getStatus() { return []; }, async cancel() {}, async close() { trace.push('sessions.close'); },
  };
  const open = async () => {
    const runtime = new RuntimeService({} as DshContext, { dataDir: directory }, {
      sessionFactory: () => sessions, workerFactory: () => workers,
      goalFactory: () => ({ async initialize() {}, async close() { trace.push('goals.close'); },
        async run() { forbidden.goal++; throw new Error('Native Goal lifecycle forbidden'); } }),
      coreFactory(value) {
        factoryCalls++; if (options.failFactory) throw new Error('Synthetic core construction failed');
        const core = new SyntheticCore(value, trace); cores.push(core); options.configureCore?.(core); return core;
      },
    });
    runtimes.push(runtime); await runtime.init(); return runtime;
  };
  t.after(async () => {
    // Release held boundary operations even when an assertion fails.
    for (const gate of gates) gate.resolve();
    try {
      for (const runtime of runtimes) { try { await within(runtime.close()); } catch (error) { if (!options.allowCloseFailure) throw error; } }
      assert.deepEqual(forbidden, { probe: 0, generation: 0, goal: 0 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  const runtime = await open();
  return { runtime, cores, open, directory, trace, forbidden, workers, workerCalls, factoryCalls: () => factoryCalls,
    gate() { const gate = deferred(); gates.push(gate); return gate; } };
}

async function create(runtime: RuntimeService, requestId = 'synthetic-core'): Promise<PublicGoal> {
  const result = await runtime.command({ action: 'core.create', ...input(requestId) }) as { goal: PublicGoal }; return result.goal;
}

async function eligible(f: Awaited<ReturnType<typeof fixture>>, requestId = 'eligible-core'): Promise<CoreGoal> {
  const core = f.cores.at(-1)!;
  const goal = await core.options.store.request('core.prepareGoal', input(requestId));
  // Synthetic native proof is confined to the trusted fixture seam. Real
  // bindings, domain ownership checks and pending eligibility remain in use.
  const binding: GoalBinding = { goalId: goal.goalId, sessionId: `synthetic-session-${requestId}`, ownerId: 'local-owner', scope: 'local-owner',
    cwd: f.directory, completionCriteriaHash: goal.completionCriteriaHash, metadataVersion: 1,
    receipt: { commandId: `create:${goal.goalId}`, operation: 'create', status: 'pending', postconditionHash: 'b'.repeat(64) } };
  await core.options.bindings.compareAndSet(undefined, binding);
  const goalRef = { id: `synthetic-native-${requestId}`, revision: 1 };
  await core.options.bindings.compareAndSet(1, { ...binding, metadataVersion: 2, goalRef,
    receipt: { ...binding.receipt!, status: 'confirmed', observedRef: goalRef } });
  const observed = await core.options.store.request('core.observeNativeGoal', { goalId: goal.goalId, goalRef,
    sessionId: binding.sessionId, phase: 'active', observedAt: new Date().toISOString() });
  const authorized = await core.options.store.request('core.authorizeGoal', { goalId: goal.goalId, expectedVersion: observed.version });
  assert.deepEqual((await core.options.store.request('core.pending', { limit: 1 })).goalIds, [goal.goalId]); return authorized;
}

async function delegate(f: Awaited<ReturnType<typeof fixture>>, goal: CoreGoal): Promise<string> {
  const store = f.runtime.store, evaluation = await store.request('core.claim', { goalId: goal.goalId }); assert.ok(evaluation);
  // Synthetic native/accounting receipts exercise the real delegation commit;
  // these are test data, not evidence of a native invocation or actual usage.
  const candidateText = JSON.stringify({ kind: 'task_intent', deliverableId: 'note', reason: 'Synthetic scoped proposal' });
  const sessionId = goal.native!.sessionId, messageId = 'synthetic-core-input', messageHash = sha('synthetic core prompt');
  await store.request('core.recordDispatch', { permit: evaluation.permit, binding: { goalId: goal.goalId,
    goalRef: evaluation.permit.goalRef, roundId: evaluation.evaluationId, sessionId, messageId, messageHash } });
  await store.request('core.recordNativeResult', { permit: evaluation.permit, receipt: { roundId: evaluation.evaluationId,
    sessionId, messageId, messageHash, outputHash: sha(candidateText), observedAt: new Date().toISOString(),
    inputRef: { sessionId, eventSeq: 1, messageId, messageHash, durability: 'confirmed' },
    assistantRef: { sessionId, eventSeq: 2, messageId: 'synthetic-core-assistant', messageHash: sha(candidateText), durability: 'confirmed' } } });
  await store.request('core.recordAccounting', { permit: evaluation.permit, receiptId: `synthetic-accounting:${goal.goalId}`, complete: true,
    tokens: 10, calls: 1, evidenceRef: 'fixture:synthetic-native-coverage' });
  const committed = await store.request('core.commitCandidate', { permit: evaluation.permit, proposalId: `synthetic-proposal:${goal.goalId}`, candidateText });
  assert.ok(committed.taskId); assert.equal((await store.request('task.get', { taskId: committed.taskId })).task.state, 'queued');
  return committed.taskId;
}

function holdEvaluation(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = f.gate(), release = f.gate(), aborted = f.gate(), core = f.cores.at(-1)!;
  core.evaluate = async signal => {
    signal.addEventListener('abort', aborted.resolve, { once: true });
    entered.resolve(); await release.promise; f.trace.push('evaluation.drained'); return { status: 'idle' };
  };
  return { entered, release, aborted, core };
}

function corruptCore(directory: string): void {
  // Closed temporary DB only. Keep the connection's existing transaction and
  // watermark guards so only Core's own schema version is corrupted.
  const db = new DatabaseSync(join(directory, 'control/events.sqlite'));
  try {
    const tx = new SqliteTransactions(db); installCommitWatermark(db, tx);
    tx.atomic(() => db.prepare('UPDATE shiyu_core_meta SET schema_version = 99').run());
  } finally { db.close(); }
}

test('Core public commands reject forged authority, getters and prototypes before the trusted service', async t => {
  const f = await fixture(t), core = f.cores[0]!;
  const command = { action: 'core.create', ...input() };
  for (const field of ['ownerId', 'scope', 'model', 'effort', 'capability', 'authority', 'adapterFactory', 'sessionId', 'goalRef', 'mandateId']) {
    await assert.rejects(f.runtime.command({ ...command, [field]: 'forged' }), /Invalid/);
  }
  let getters = 0;
  for (const field of ['action', 'objective']) {
    const value = { ...command }; Object.defineProperty(value, field, { enumerable: true, get() { getters++; return command[field as 'action' | 'objective']; } });
    await assert.rejects(f.runtime.command(value), /Invalid|Expected/);
  }
  await assert.rejects(f.runtime.command(Object.assign(Object.create({ authority: 'forged' }), command)), /Invalid|Expected/);
  for (const action of ['core.pause', 'core.resume', 'core.cancel']) {
    await assert.rejects(f.runtime.command({ action, goalId: 'goal', expectedVersion: 1, capability: {} }), /Invalid/);
    await assert.rejects(f.runtime.command({ action, goalId: 'goal', expectedVersion: 0 }), /Invalid/);
  }
  assert.equal(getters, 0); assert.equal(core.creates.length, 0); assert.equal(core.controls.length, 0);
  assert.deepEqual(await f.runtime.store.request('core.snapshot', {}), []); assert.equal(f.runtime.operations.size, 0);
});

test('Core required and nested field validation reaches the real domain without native operations', async t => {
  const f = await fixture(t), core = f.cores[0]!, command = { action: 'core.create', ...input() };
  for (const field of ['requestId', 'objective', 'deliverables', 'budget', 'expiresAt']) {
    const value: Record<string, unknown> = { ...command }; delete value[field]; await assert.rejects(f.runtime.command(value));
  }
  await assert.rejects(f.runtime.command({ ...command, budget: { ...command.budget, dollars: 1 } }));
  await assert.rejects(f.runtime.command({ ...command, deliverables: [{ ...command.deliverables[0], tools: ['anything'] }] }));
  assert.equal(core.creates.length, 7); assert.deepEqual(await f.runtime.store.request('core.snapshot', {}), []);
  assert.deepEqual(await f.runtime.store.request('task.list', {}), []); assert.equal(f.workerCalls.length, 0);
});

test('Core creation uses its service and durable Goal scope, never standalone task creation', async t => {
  const f = await fixture(t), core = f.cores[0]!, requests: string[] = [];
  const request = f.runtime.store.request.bind(f.runtime.store);
  f.runtime.store.request = ((command: Parameters<typeof request>[0], args: never) => { requests.push(command); return request(command, args); }) as typeof request;
  const goal = await create(f.runtime), stored = await f.runtime.store.request('core.get', { goalId: goal.goalId });
  assert.equal(core.creates.length, 1); assert.equal(requests.includes('core.prepareGoal'), true); assert.equal(requests.includes('task.createLocal'), false);
  assert.equal(goal.authorized, false); assert.equal(goal.paused, true); assert.deepEqual(goal.taskRefs, []);
  assert.equal(stored.deliverables[0]!.content, input().deliverables[0]!.content);
  assert.deepEqual(goal.deliverables, [{ id: 'note', title: 'Synthetic note', bodyBytes: Buffer.byteLength(stored.deliverables[0]!.content) }]);
  assert.equal(JSON.stringify(goal).includes('PRIVATE_SYNTHETIC_DELIVERABLE_BODY'), false);
  assert.deepEqual(await f.runtime.store.request('task.list', {}), []); assert.equal(f.workerCalls.length, 0);
});

test('Core pause and cancel remain available during global pause while create and resume remain fenced', async t => {
  const f = await fixture(t), core = f.cores[0]!, goal = await create(f.runtime);
  await f.runtime.command({ action: 'runtime.pause' });
  await assert.rejects(f.runtime.command({ action: 'core.create', ...input('paused-create') }), /paused/);
  await assert.rejects(f.runtime.command({ action: 'core.resume', goalId: goal.goalId, expectedVersion: goal.version }), /paused/);
  const paused = await f.runtime.command({ action: 'core.pause', goalId: goal.goalId, expectedVersion: goal.version }) as { goal: PublicGoal };
  const cancelled = await f.runtime.command({ action: 'core.cancel', goalId: goal.goalId, expectedVersion: paused.goal.version }) as { goal: PublicGoal };
  assert.equal(cancelled.goal.cancelled, true); assert.equal(cancelled.goal.paused, true);
  assert.deepEqual(core.controls.map(value => value.kind), ['pause', 'cancel']); assert.equal(core.creates.length, 1);
  assert.deepEqual(core.cancelledGoals, [goal.goalId, goal.goalId]); assert.equal((await f.runtime.snapshot()).state, 'paused');
});

test('Core dashboard and GET repeatedly read metadata without evaluation or native side effects', async t => {
  const f = await fixture(t), core = f.cores[0]!; await create(f.runtime);
  const before = await f.runtime.store.request('control.watermark', {});
  for (let count = 0; count < 3; count++) {
    const snapshot = await f.runtime.snapshot(); assert.equal(snapshot.core.ready, true); assert.equal(snapshot.core.goals.length, 1);
    assert.equal(JSON.stringify(snapshot.core).includes('PRIVATE_SYNTHETIC_DELIVERABLE_BODY'), false);
    const response = await serveState(f.runtime); assert.equal(response.status, 200);
    const body = await response.json() as { core: { ready: boolean; goals: unknown[] } }; assert.equal(body.core.ready, true); assert.equal(body.core.goals.length, 1);
  }
  assert.deepEqual(await f.runtime.store.request('control.watermark', {}), before);
  assert.equal(core.creates.length, 1); assert.equal(core.controls.length, 0); assert.equal(core.evaluations.length, 0);
  assert.equal(core.cancellations, 0); assert.equal(core.closes, 0); assert.equal(f.workerCalls.length, 0);
});

test('Corrupt persisted Core metadata degrades only Core and does not dispatch queued work on read', async t => {
  const f = await fixture(t); await create(f.runtime);
  const task = await f.runtime.store.request('task.createLocal', { requestId: 'queued-with-corrupt-core', title: 'Synthetic queued note', content: 'Synthetic content' });
  await f.runtime.close();
  corruptCore(f.directory);
  const restarted = await f.open(), snapshot = await restarted.snapshot();
  assert.equal(f.factoryCalls(), 1); assert.equal(snapshot.lifecycle, 'degraded'); assert.equal(snapshot.core.ready, false);
  assert.equal((await restarted.store.request('core.status', {})).ready, false);
  // Existing Task recovery is deliberately conservative even for a formerly
  // queued assignment; a reopened process never proves old execution stopped.
  assert.equal((await restarted.store.request('task.get', { taskId: task.task.taskId })).task.state, 'unknown');
  await assert.rejects(restarted.store.request('task.claimAssignment', { taskId: task.task.taskId }), /fresh queued assignment/);
  assert.equal((await serveState(restarted)).status, 200); assert.equal(f.workerCalls.length, 0);
  await assert.rejects(restarted.command({ action: 'core.create', ...input('blocked') }), /Core control is unavailable/);
});

test('Previously queued delegated work receives no fresh authority when Core reopens corrupt', async t => {
  const f = await fixture(t), goal = await eligible(f), taskId = await delegate(f, goal);
  assert.equal(f.workerCalls.length, 0); await f.runtime.close(); corruptCore(f.directory);
  const restarted = await f.open();
  assert.equal((await restarted.store.request('core.status', {})).ready, false); assert.equal(f.factoryCalls(), 1);
  assert.equal((await restarted.store.request('task.get', { taskId })).task.state, 'unknown');
  await assert.rejects(restarted.store.request('task.claimAssignment', { taskId }), /fresh queued assignment/);
  await restarted.command({ action: 'runtime.resume' });
  const before = await restarted.store.request('control.watermark', {});
  assert.equal((await serveState(restarted)).status, 200);
  assert.deepEqual(await restarted.store.request('control.watermark', {}), before);
  assert.equal(f.workerCalls.length, 0); assert.equal(restarted.operations.size, 0);
});

for (const [kind, otherKind] of [['pause', 'ordinary'], ['cancel', 'another-goal']] as const) {
  test(`Goal ${kind} immediately aborts its running worker before native stop finishes, preserving ${otherKind} work`, async t => {
    const f = await fixture(t), goal = await eligible(f), taskId = await delegate(f, goal);
    const otherTaskId = otherKind === 'ordinary'
      ? (await f.runtime.store.request('task.createLocal', { requestId: 'independent-task', title: 'Independent note', content: 'Synthetic independent note' })).task.taskId
      : await delegate(f, await eligible(f, 'independent-goal'));
    const entered = new Map([[taskId, f.gate()], [otherTaskId, f.gate()]]), releaseWorkers = f.gate();
    f.workers.execute = async request => {
      await request.onBound({ taskId: request.taskId, assignmentId: request.assignmentId, scope: request.scope, sessionId: `synthetic-worker-${request.taskId}` });
      entered.get(request.taskId)!.resolve(); await releaseWorkers.promise; throw new Error('Synthetic worker drained');
    };
    await f.runtime.command({ action: 'runtime.resume' }); await within(Promise.all([...entered.values()].map(gate => gate.promise)));
    assert.equal(f.runtime.operations.size, 2);
    const target = f.workerCalls.find(request => request.taskId === taskId)!, other = f.workerCalls.find(request => request.taskId === otherTaskId)!;
    assert.equal((await f.runtime.store.request('task.get', { taskId })).execution?.state, 'running');
    assert.equal(target.signal!.aborted, false); assert.equal(other.signal!.aborted, false);
    const nativeStopEntered = f.gate(), releaseNativeStop = f.gate();
    f.cores[0]!.afterStop = async stopped => {
      assert.equal(stopped.paused, true); assert.deepEqual(stopped.taskRefs.map(ref => ref.taskId), [taskId]);
      nativeStopEntered.resolve(); await releaseNativeStop.promise;
    };
    const current = await f.runtime.store.request('core.get', { goalId: goal.goalId });
    let settled = false;
    const stopping = f.runtime.command({ action: `core.${kind}`, goalId: goal.goalId, expectedVersion: current.version }).then(value => { settled = true; return value; });
    await within(nativeStopEntered.promise);
    assert.equal(settled, false); assert.equal(target.signal!.aborted, true); assert.equal(other.signal!.aborted, false);
    assert.equal((await f.runtime.store.request('task.get', { taskId: otherTaskId })).execution?.state, 'running');
    releaseNativeStop.resolve(); await within(stopping);
    await f.runtime.command({ action: 'runtime.pause' }); releaseWorkers.resolve();
    await within(Promise.all([...f.runtime.operations.values()].map(operation => operation.done)));
  });
}

test('Core construction failure leaves the Runtime dashboard and ordinary store available', async t => {
  const f = await fixture(t, { failFactory: true });
  const snapshot = await f.runtime.snapshot(); assert.equal(snapshot.lifecycle, 'degraded');
  assert.equal(snapshot.core.ready, false); assert.equal(snapshot.core.errorCode, 'CORE_INITIALIZATION_FAILED');
  assert.equal((await serveState(f.runtime)).status, 200); assert.deepEqual(await f.runtime.store.request('task.list', {}), []);
  assert.equal(f.factoryCalls(), 1); assert.equal(f.workerCalls.length, 0);
  await assert.rejects(f.runtime.command({ action: 'core.create', ...input() }), /Core control is unavailable/);
});

test('Reopening a pending Core goal does not block init or GET; pause aborts immediately and close drains its evaluation', async t => {
  let configureCore: (core: SyntheticCore) => void = () => undefined;
  const f = await fixture(t, { configureCore: core => configureCore(core) });
  const goal = await eligible(f, 'pending-across-restart');
  await f.runtime.close();
  const entered = f.gate(), release = f.gate(), aborted = f.gate();
  configureCore = core => {
    core.evaluate = async signal => {
      signal.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve();
      await release.promise;
      // A cancelled evaluation may still record/check facts during drain.
      assert.equal((await core.options.store.request('core.get', { goalId: goal.goalId })).goalId, goal.goalId);
      f.trace.push('reopened-evaluation.drained'); return { status: 'idle' };
    };
  };
  const restarted = await within(f.open());
  await within(entered.promise); assert.equal(restarted.operations.size, 1);
  const response = await within(serveState(restarted)); assert.equal(response.status, 200);
  assert.equal((await response.json() as { core: { ready: boolean } }).core.ready, true);
  const pausing = restarted.command({ action: 'runtime.pause' });
  assert.equal(f.cores.at(-1)!.evaluations[0]!.aborted, true); await within(aborted.promise); await within(pausing);
  const closeStore = restarted.store.close.bind(restarted.store); let storeClosed = false, settled = false;
  restarted.store.close = async () => { storeClosed = true; f.trace.push('reopened-store.close'); return closeStore(); };
  const closing = restarted.close().then(() => { settled = true; });
  await tick(); assert.equal(settled, false); assert.equal(storeClosed, false);
  release.resolve(); await within(closing);
  assert.equal(storeClosed, true); assert.equal(restarted.operations.size, 0);
  assert.ok(f.trace.indexOf('reopened-evaluation.drained') < f.trace.indexOf('reopened-store.close'));
});

test('Global pause immediately cancels Core and closes its runtime gate before durable pause can finish', async t => {
  const f = await fixture(t), hold = holdEvaluation(f); await eligible(f); void pump(f.runtime).wake(); await within(hold.entered.promise);
  const writeEntered = f.gate(), writeReleased = f.gate(), update = f.runtime.state.update.bind(f.runtime.state);
  f.runtime.state.update = (async change => { writeEntered.resolve(); await writeReleased.promise; return update(change); }) as typeof update;
  const pausing = f.runtime.command({ action: 'runtime.pause' });
  assert.equal(hold.core.cancellations, 1); assert.equal(hold.core.evaluations[0]!.aborted, true);
  assert.throws(() => hold.core.options.assertRuntimeAllowed(), /paused/); await within(writeEntered.promise);
  await assert.rejects(f.runtime.command({ action: 'core.create', ...input('during-pause-write') }), /paused/);
  assert.equal(hold.core.creates.length, 0); assert.equal(hold.core.evaluations.length, 1);
  hold.release.resolve(); writeReleased.resolve(); await within(pausing); assert.equal((await f.runtime.snapshot()).state, 'paused');
});

for (const failClose of [false, true]) {
  test(`Runtime close drains cancelled Core before closing SQLite${failClose ? ' even when core.close rejects' : ''}`, async t => {
    const f = await fixture(t, { allowCloseFailure: failClose }), hold = holdEvaluation(f); hold.core.closeFailure = failClose;
    const goal = await eligible(f); void pump(f.runtime).wake(); await within(hold.entered.promise);
    const closeStore = f.runtime.store.close.bind(f.runtime.store);
    f.runtime.store.close = async () => { f.trace.push('store.close'); return closeStore(); };
    const closing = f.runtime.close(); let settled = false;
    const observed = closing.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    await within(hold.aborted.promise); await tick();
    assert.equal(hold.core.closes, 1); assert.equal(hold.core.cancellations, 1); assert.equal(settled, false);
    assert.equal(f.trace.includes('store.close'), false);
    assert.equal((await f.runtime.store.request('core.get', { goalId: goal.goalId })).goalId, goal.goalId);
    hold.release.resolve(); const error = await within(observed);
    if (failClose) assert.ok(error instanceof AggregateError); else assert.equal(error, undefined);
    assert.ok(f.trace.indexOf('core.close') < f.trace.indexOf('store.close'));
    assert.ok(f.trace.indexOf('evaluation.drained') < f.trace.indexOf('store.close'));
    for (const step of ['sessions.close', 'workers.close', 'goals.close']) assert.ok(f.trace.indexOf(step) < f.trace.indexOf('store.close'));
    assert.equal(f.runtime.operations.size, 0);
  });
}

test('Core evaluation and worker execution share two activity slots; a third operation cannot be admitted', async t => {
  const f = await fixture(t), hold = holdEvaluation(f); await eligible(f); void pump(f.runtime).wake(); await within(hold.entered.promise);
  const workerEntered = f.gate(), workerRelease = f.gate();
  f.workers.execute = async () => { workerEntered.resolve(); await workerRelease.promise; throw new Error('Synthetic worker stopped'); };
  await f.runtime.command({ action: 'task.createLocal', requestId: 'slot-worker', title: 'Synthetic slot worker', content: 'Synthetic slot note' });
  await within(workerEntered.promise); assert.equal(f.runtime.operations.size, 2);
  await assert.rejects(f.runtime.command({ action: 'task.createLocal', requestId: 'overflow-worker', title: 'Overflow', content: 'Synthetic overflow' }), /capacity/);
  await assert.rejects(f.runtime.command({ action: 'core.create', ...input('overflow-core') }), /capacity/);
  await assert.rejects(f.runtime.command({ action: 'reply.generate', businessId: 'overflow', prompt: 'Synthetic overflow' }), /capacity/);
  assert.equal((await f.runtime.store.request('task.list', {})).length, 1); assert.equal(hold.core.creates.length, 0);
  assert.equal(hold.core.evaluations.length, 1); assert.equal(f.workerCalls.length, 1);
  await f.runtime.command({ action: 'runtime.pause' }); hold.release.resolve(); workerRelease.resolve();
  await within(Promise.all([...f.runtime.operations.values()].map(operation => operation.done)));
});

test('Two active workers defer the Core pump until a shared slot is released', async t => {
  const f = await fixture(t), hold = holdEvaluation(f), workersEntered = f.gate(), releases = [f.gate(), f.gate()];
  f.workers.execute = async () => {
    const index = f.workerCalls.length - 1; if (f.workerCalls.length === 2) workersEntered.resolve();
    await releases[index]!.promise; throw new Error('Synthetic worker stopped');
  };
  for (let count = 0; count < 2; count++) await f.runtime.command({ action: 'task.createLocal', requestId: `occupant-${count}`, title: 'Synthetic occupant', content: 'Synthetic slot content' });
  await within(workersEntered.promise); await eligible(f); await pump(f.runtime).wake();
  // Let the real pump's fixed one-second coalescing interval expire; its
  // pending check and clock remain unmodified.
  await new Promise<void>(resolve => setTimeout(resolve, 1100));
  assert.equal(hold.core.evaluations.length, 0); assert.equal(f.runtime.operations.size, 2);
  releases[0]!.resolve(); await within(hold.entered.promise);
  assert.equal(hold.core.evaluations.length, 1); assert.equal(f.runtime.operations.size, 2); assert.equal(f.workerCalls.length, 2);
  await f.runtime.command({ action: 'runtime.pause' }); hold.release.resolve(); releases[1]!.resolve();
  await within(Promise.all([...f.runtime.operations.values()].map(operation => operation.done)));
});
