import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeService } from '../src/runtime.js';
import type { SessionDriver } from '../src/runtime.js';
import { defaultModel, sessionBindingKey } from '../src/adapters/dsh/sessions.js';
import type { DshContext, ReplyRequest, ReplyResult } from '../src/adapters/dsh/sessions.js';
import { readCommand, serveCommand, serveState } from '../src/index.js';
import type { WorkerRunRequest, WorkerRunResult } from '../src/adapters/dsh/workers.js';
import type { GoalLifecycleResult, GoalLifecycleRunOptions } from '../src/control/goal-lifecycle.js';

class FakeGoals {
  calls = 0;
  async initialize() {}
  async run(_taskId: string, _options: GoalLifecycleRunOptions): Promise<GoalLifecycleResult> { this.calls++; throw new Error('Synthetic Goal driver was not configured'); }
  async close() {}
}

class FakeWorkers {
  calls = 0;
  async initialize() {}
  async run(_request: WorkerRunRequest): Promise<WorkerRunResult> { this.calls++; throw new Error('Synthetic worker was not configured'); }
  async close() {}
}

class FakeSessions implements SessionDriver {
  probes = 0; generations = 0; closed = false;
  async initialize() {}
  async probe() { this.probes++; return { ready: true as const, noModelCalled: true as const, sessionId: 'synthetic-probe', tools: [], model: defaultModel('replyer'), released: true as const, archived: true as const }; }
  generateReply(input: ReplyRequest): Promise<ReplyResult> {
    this.generations++;
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new Error('Cancelled synthetic model'));
      if (input.signal?.aborted) abort(); else input.signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async getStatus() { return []; }
  async cancel() {}
  async close() { this.closed = true; }
}
async function fixture(t: any, allowCloseFailure = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiyu-runtime-test-'));
  const fake = new FakeSessions();
  const workers = new FakeWorkers();
  const goals = new FakeGoals();
  const create = () => new RuntimeService({} as DshContext, { dataDir: directory }, { sessionFactory: () => fake, workerFactory: () => workers, goalFactory: () => goals });
  const runtime = create(); await runtime.init();
  t.after(async () => { try { await runtime.close(); } catch (error) { if (!allowCloseFailure) throw error; } finally { await rm(directory, { recursive: true, force: true }); } });
  return { directory, fake, workers, goals, runtime, create };
}
function syntheticReply(request: ReplyRequest, text: string): ReplyResult {
  return { text, usage: { status: 'unknown' }, binding: { key: sessionBindingKey('replyer', request.businessId, request.scope), role: 'replyer', businessId: request.businessId, scope: request.scope, sessionId: 'shiyu-replyer-synthetic-model-check', model: defaultModel('replyer'), status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), usage: { status: 'unknown' } } };
}

test('explicit Goal verification reports native evidence without inference and becomes historical on reload', async t => {
  const { runtime, goals, fake, workers, create } = await fixture(t);
  const taskId = 'a'.repeat(32);
  goals.run = async (id, options) => {
    goals.calls++; options.signal.throwIfAborted(); options.progress('原生完成核对');
    return { verified: true, taskId: id, goalId: `artifact-validation:${id}`, nativeGoalId: 'synthetic-native-goal', sessionId: 'shiyu-goal-synthetic', nativePhase: 'complete', inferenceRequested: false, operations: ['create', 'pause', 'resume', 'complete'] };
  };
  const result: any = await runtime.command({ action: 'goal.verify-lifecycle', taskId });
  assert.equal(result.verified, true); assert.equal(result.taskId, taskId);
  assert.equal((await runtime.snapshot()).dependencies.find(d => d.id === 'native-goal')?.status, 'available');
  await runtime.snapshot(); await runtime.snapshot();
  assert.equal(goals.calls, 1); assert.equal(fake.generations, 0); assert.equal(workers.calls, 0);
  await runtime.close(); const fresh = create(); await fresh.init();
  try { assert.equal((await fresh.snapshot()).dependencies.find(d => d.id === 'native-goal')?.status, 'unknown'); assert.equal(goals.calls, 1); }
  finally { await fresh.close(); }
});

test('Goal validation rejects public authority fields and respects immediate runtime pause', async t => {
  const { runtime, goals } = await fixture(t);
  const taskId = 'b'.repeat(32);
  await assert.rejects(runtime.command({ action: 'goal.verify-lifecycle', taskId, ownerId: 'forged' }), /Invalid Goal validation/);
  assert.equal(goals.calls, 0);
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  goals.run = async (_id, options) => { goals.calls++; started(); return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(new Error('Goal verification cancelled')), { once: true }); }); };
  const running = runtime.command({ action: 'goal.verify-lifecycle', taskId });
  await began; await runtime.command({ action: 'runtime.pause' });
  await assert.rejects(running, /cancelled/);
  assert.equal(runtime.state.state.lastGoalVerification?.ok, false);
  await assert.rejects(runtime.command({ action: 'goal.verify-lifecycle', taskId }), /paused/);
  assert.equal(goals.calls, 1); assert.equal(runtime.operations.size, 0);
});

test('explicit model verification uses exactly two bounded turns and one Session without sending', async t => {
  const { runtime, fake } = await fixture(t);
  let marker = ''; const requests: ReplyRequest[] = [];
  fake.generateReply = async request => {
    requests.push(request); fake.generations++;
    if (requests.length === 1) { marker = request.prompt.match(/SHIYU_[a-f0-9]+/)![0]; return syntheticReply(request, '已记住'); }
    return syntheticReply(request, marker);
  };
  const result: any = await runtime.command({ action: 'session.verify-model' });
  assert.equal(result.verified, true); assert.equal(result.calls, 2); assert.equal(result.sameSession, true); assert.equal(result.sent, false);
  assert.equal(requests.length, 2); assert.ok(requests.every(r => r.maxTokens === 1024));
  assert.equal(requests[0].businessId, requests[1].businessId); assert.equal(requests[1].prompt.includes(marker), false);
  assert.equal(runtime.state.state.lastModelVerification?.calls, 2);
  assert.equal((await runtime.snapshot()).dependencies.find(d => d.id === 'model')?.status, 'available');
  await runtime.snapshot(); await runtime.snapshot(); assert.equal(fake.generations, 2);
});

test('model verification does not retry a failed first turn or a wrong second answer', async t => {
  const { runtime, fake } = await fixture(t);
  fake.generateReply = async () => { fake.generations++; throw new Error('Synthetic provider unavailable'); };
  await assert.rejects(runtime.command({ action: 'session.verify-model' }), /Synthetic provider unavailable/);
  assert.equal(fake.generations, 1); assert.equal(runtime.state.state.lastModelVerification?.calls, 1);
  fake.generateReply = async request => { fake.generations++; return syntheticReply(request, 'incorrect'); };
  await assert.rejects(runtime.command({ action: 'session.verify-model' }), /did not confirm/);
  assert.equal(fake.generations, 3);
  assert.equal((await runtime.snapshot()).dependencies.find(d => d.id === 'model')?.status, 'unavailable');
});

test('an accepted local task outlives its HTTP request and completes only after independent verification', async t => {
  const { runtime, workers } = await fixture(t);
  const content = 'Synthetic background task';
  workers.run = async request => {
    const binding = { taskId: request.taskId, assignmentId: request.assignmentId, scope: request.scope, sessionId: 'shiyu-worker-synthetic-background' };
    const identity = { ...binding, hostEpoch: request.permit.hostEpoch, installationGeneration: request.permit.installationGeneration, fencingToken: request.permit.fencingToken, leaseExpiresAt: request.permit.leaseExpiresAt };
    await request.onBound(binding);
    await request.tools![0].execute({ content }, { ...binding, permit: identity, signal: request.signal!, assertPermit: async () => { await request.permit.check({ ...identity, phase: 'tool' }); } });
    return { ...binding, candidate: { summary: 'Synthetic candidate', evidenceRequests: [] }, usage: { status: 'reported', inputTokens: 20, outputTokens: 10, totalTokens: 30 }, steps: 2, modelCalls: 2, nativeObservations: [], verified: false };
  };
  const request = new AbortController();
  const accepted: any = await runtime.command({ action: 'task.createLocal', requestId: 'background-test', title: 'Background fixture', content }, request.signal);
  assert.equal(accepted.accepted, true); assert.equal(accepted.task.state, 'queued');
  request.abort();
  await Promise.all([...runtime.operations.values()].map(operation => operation.done));
  const snapshot = await runtime.snapshot();
  assert.equal(snapshot.tasks.find(task => task.taskId === accepted.task.taskId)?.state, 'succeeded');
  assert.equal(snapshot.activeWork.length, 0);
});

test('pause after durable admission preserves its accepted receipt and resume schedules it once', async t => {
  const { runtime, workers } = await fixture(t);
  const original = runtime.store.request.bind(runtime.store);
  let reached!: () => void, release!: () => void;
  const committed = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  runtime.store.request = (async (command: any, args: any) => {
    const value = await original(command, args);
    if (command === 'task.createLocal') { reached(); await gate; }
    return value;
  }) as typeof runtime.store.request;
  const pending = runtime.command({ action: 'task.createLocal', requestId: 'pause-admission', title: 'Pause fixture', content: 'Synthetic input' });
  await committed; await runtime.command({ action: 'runtime.pause' }); release();
  const accepted: any = await pending;
  assert.equal(accepted.accepted, true); assert.equal(accepted.task.state, 'queued'); assert.equal(workers.calls, 0);
  await runtime.command({ action: 'runtime.resume' });
  await Promise.all([...runtime.operations.values()].map(operation => operation.done));
  assert.equal(workers.calls, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workers.calls, 1);
});

test('unload drains a committed admission without changing its receipt or starting a late worker', async t => {
  const { runtime, workers, create } = await fixture(t);
  const original = runtime.store.request.bind(runtime.store);
  let reached!: () => void, release!: () => void;
  const committed = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  runtime.store.request = (async (command: any, args: any) => {
    const value = await original(command, args);
    if (command === 'task.createLocal') { reached(); await gate; }
    return value;
  }) as typeof runtime.store.request;
  const pending = runtime.command({ action: 'task.createLocal', requestId: 'unload-admission', title: 'Unload fixture', content: 'Synthetic input' });
  await committed;
  let closed = false; const close = runtime.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); assert.equal((await pending as any).accepted, true); await close; assert.equal(workers.calls, 0);
  const fresh = create(); await fresh.init();
  try { assert.equal((await fresh.snapshot()).tasks.length, 1); assert.equal(workers.calls, 0); } finally { await fresh.close(); }
});

test('a failed domain resume keeps the persistent pause across a new runtime instance', async t => {
  const { runtime, create } = await fixture(t);
  await runtime.command({ action: 'runtime.pause' });
  const original = runtime.store.request.bind(runtime.store);
  runtime.store.request = (async (command: any, args: any) => {
    if (command === 'task.setPaused' && args.paused === false) throw new Error('Synthetic resume storage failure');
    return original(command, args);
  }) as typeof runtime.store.request;
  await assert.rejects(runtime.command({ action: 'runtime.resume' }), /Synthetic resume storage failure/);
  assert.equal(runtime.state.state.paused, true);
  await runtime.close(); const fresh = create(); await fresh.init();
  try { assert.equal((await fresh.snapshot()).state, 'paused'); } finally { await fresh.close(); }
});

test('dashboard reads never publish, create Sessions or infer; planned systems remain explicit', async t => {
  const { runtime, fake } = await fixture(t);
  const first = await runtime.snapshot();
  for (let i = 0; i < 12; i++) {
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.events.published, first.events.published);
    assert.equal(snapshot.events.pending, 0);
    assert.equal(snapshot.activeWork.length, 0);
    assert.equal(snapshot.usage.inputTokens, null);
    assert.equal(snapshot.usage.cacheReadTokens, null);
    assert.equal(snapshot.systems.length, 9);
    assert.equal(snapshot.systems.find(s => s.id === 'core')?.status, 'planned');
    assert.equal(snapshot.dependencies.find(d => d.id === 'native-session')?.status, 'unknown');
  }
  assert.equal(fake.probes, 0); assert.equal(fake.generations, 0);
});

test('explicit Session probe records evidence without inference and pause survives restart', async t => {
  const { runtime, fake, create } = await fixture(t);
  await runtime.command({ action: 'session.probe' });
  assert.equal(fake.probes, 1); assert.equal(fake.generations, 0);
  assert.equal((await runtime.snapshot()).dependencies.find(d => d.id === 'native-session')?.status, 'available');
  assert.equal((await runtime.snapshot()).dependencies.find(d => d.id === 'model')?.status, 'unknown');
  await runtime.command({ action: 'runtime.pause' });
  await assert.rejects(runtime.command({ action: 'session.probe' }), /paused/);
  await runtime.close();
  const resumed = create(); await resumed.init();
  try {
    assert.equal((await resumed.snapshot()).state, 'paused');
    assert.equal((await resumed.snapshot()).dependencies.find(d => d.id === 'native-session')?.status, 'unknown');
    await assert.rejects(resumed.command({ action: 'reply.generate', businessId: 'demo', prompt: 'test' }), /paused/);
    await resumed.command({ action: 'runtime.resume' });
    assert.equal((await resumed.snapshot()).state, 'idle');
  } finally { await resumed.close(); }
});

test('pause immediately cancels an in-flight reply and releases no draft', async t => {
  const { runtime, fake } = await fixture(t);
  const pending = assert.rejects(runtime.command({ action: 'reply.generate', businessId: 'demo', prompt: 'synthetic input' }), /Cancelled/);
  assert.equal(fake.generations, 1);
  await runtime.command({ action: 'runtime.pause' });
  await pending;
  assert.equal((await runtime.snapshot()).activeWork.length, 0);
  assert.equal((await runtime.snapshot()).state, 'paused');
});

test('concurrent resume then pause cannot reopen work or disagree with durable pause', async t => {
  const { runtime, create } = await fixture(t);
  await runtime.command({ action: 'runtime.pause' });
  const resume = runtime.command({ action: 'runtime.resume' });
  const pause = runtime.command({ action: 'runtime.pause' });
  await Promise.all([resume, pause]);
  assert.equal((await runtime.snapshot()).state, 'paused');
  assert.equal(runtime.state.state.paused, true);
  await assert.rejects(runtime.command({ action: 'session.probe' }), /paused/);
  await runtime.close();
  const fresh = create(); await fresh.init();
  try { assert.equal((await fresh.snapshot()).state, 'paused'); } finally { await fresh.close(); }
});

test('ordered pause then resume opens only after persistence; unload drains accepted controls', async t => {
  const { runtime, create } = await fixture(t);
  await Promise.all([runtime.command({ action: 'runtime.pause' }), runtime.command({ action: 'runtime.resume' })]);
  assert.equal((await runtime.snapshot()).state, 'idle');
  assert.equal(runtime.state.state.paused, false);
  const pause = runtime.command({ action: 'runtime.pause' });
  await Promise.all([pause, runtime.close()]);
  const fresh = create(); await fresh.init();
  try { assert.equal((await fresh.snapshot()).state, 'paused'); } finally { await fresh.close(); }
});

test('unload cancels outstanding inference before releasing state/store ownership', async t => {
  const { runtime, fake, create } = await fixture(t);
  const pending = assert.rejects(runtime.command({ action: 'reply.generate', businessId: 'demo', prompt: 'synthetic input' }), /Cancelled/);
  await runtime.close(); await pending;
  assert.equal(fake.closed, true);
  await assert.rejects(runtime.snapshot(), /stopping/);
  const fresh = create(); await fresh.init(); await fresh.close();
});

test('a failed Session close still waits for outstanding operations before releasing ownership', async t => {
  const { runtime, fake, create } = await fixture(t, true);
  let finish!: () => void;
  fake.generateReply = async () => { await new Promise<void>(resolve => { finish = resolve; }); throw new Error('Synthetic operation ended'); };
  fake.close = async () => { throw new Error('Synthetic dispose failed'); };
  const pending = assert.rejects(runtime.command({ action: 'reply.generate', businessId: 'demo', prompt: 'test' }), /Synthetic operation ended/);
  const closed = assert.rejects(runtime.close(), (error: unknown) => error instanceof AggregateError && error.errors.some(e => e.message === 'Synthetic dispose failed'));
  await assert.rejects(create().init(), /lock|locked/i);
  finish(); await pending; await closed;
  const fresh = create(); await fresh.init();
  fake.close = async () => {};
  await fresh.close();
});

test('an existing live instance prevents second writer; closing releases its lock', async t => {
  const { runtime, create } = await fixture(t);
  await assert.rejects(create().init(), /lock|locked/i);
  await runtime.close();
  const second = create(); await second.init(); await second.close();
});

test('HTTP read is non-mutating; bounded JSON command parser rejects invalid input', async t => {
  const { runtime, fake } = await fixture(t);
  const state = await serveState(runtime);
  assert.equal(state.status, 200); assert.equal(state.headers.get('cache-control'), 'no-store');
  assert.equal(fake.probes, 0);
  const post = (body: string, contentType = 'application/json') => new Request('http://local.test/api/shiyu/commands', { method: 'POST', headers: { 'content-type': contentType }, body });
  await assert.rejects(readCommand(post('{}', 'text/plain')), /application\/json/);
  await assert.rejects(readCommand(post('x'.repeat(65537))), /64 KiB/);
  const invalid = await serveCommand(runtime, post('{"action":"run_anything"}'));
  assert.equal(invalid.status, 400);
  const probe = await serveCommand(runtime, post('{"action":"session.probe"}'));
  assert.equal(probe.status, 200); assert.equal(fake.probes, 1); assert.equal(fake.generations, 0);
});
