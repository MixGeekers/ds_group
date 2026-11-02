import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeService } from '../src/runtime.js';
import type { SessionDriver } from '../src/runtime.js';
import { defaultModel, sessionBindingKey } from '../src/adapters/dsh/sessions.js';
import type { DshContext, ReplyRequest, ReplyResult } from '../src/adapters/dsh/sessions.js';
import { readCommand, serveCommand, serveState } from '../src/index.js';
import type { WorkerRunRequest, WorkerRunResult } from '../src/adapters/dsh/workers.js';
import type { GoalLifecycleResult, GoalLifecycleRunOptions } from '../src/control/goal-lifecycle.js';
import { conversationEventPrincipal, CONVERSATION_BACKGROUND_HANDLER } from '../src/adapters/control-store/conversation-domain.js';

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
  async prepareContextSafety() { return { ready: true as const, messageFactory: 'injected' as const, nativeReadback: true as const, coldProjection: true as const }; }
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

async function contextFixture(t: any) {
  const base = await fixture(t);
  const detail = await base.runtime.store.request('task.createLocal', { requestId: 'context-runtime-fixture', title: 'Synthetic context Task', content: 'Synthetic artifact input' });
  const linked: any = await base.runtime.command({ action: 'conversation.linkLocalTask', taskId: detail.task.taskId });
  const conversation = (await base.runtime.snapshot()).conversations[0]!;
  return { ...base, task: detail.task, conversation, linked };
}
// Runtime-only driver double. Domain/capture/native durability are verified in
// their integration tests; these receipts exercise admission and final checks.
function contextResult(input: any, conversation: any, text: string, round: number, sessionId = 'shiyu-replyer-synthetic-context'): any {
  const reply = syntheticReply({ businessId: 'synthetic-context', scope: 'local-owner', prompt: input.text }, text);
  reply.binding.sessionId = sessionId;
  return { duplicate: false, operation: { operationId: `synthetic-op-${round}`, status: 'ready' },
    view: { viewId: `synthetic-view-${round}`, conversation: { bindingId: conversation.bindingId, sessionEpoch: 1, conversationGeneration: round + 3 } },
    reply: { ...reply, contextReceipt: { durability: 'confirmed', sessionId, userMessageSeq: round * 2 }, assistantRef: { sessionId, eventSeq: round * 2 + 1, messageId: `assistant-${round}` } } };
}

test('context verification admits two bounded rounds and stores only diagnostic metadata', async t => {
  const { runtime, task, conversation, directory, fake } = await contextFixture(t);
  const requests: any[] = []; let marker = '';
  runtime.localReplies.run = async request => {
    requests.push(request);
    marker ||= request.text.match(/SHIYU_[a-f0-9]{12}/u)![0];
    return contextResult(request, conversation, JSON.stringify({ taskId: task.taskId, state: task.state, marker }), requests.length);
  };
  const receipt: any = await runtime.command({ action: 'conversation.verifyContext', conversationId: conversation.conversationId });
  assert.equal(receipt.verified, true); assert.equal(receipt.calls, 2);
  assert.equal(receipt.sameSession, true); assert.equal(receipt.contextDurable, true); assert.equal(receipt.draftsValidated, true); assert.equal(receipt.sent, false);
  assert.deepEqual(requests.map(request => request.maxTokens), [512, 512]);
  assert.notEqual(requests[0].inputId, requests[1].inputId);
  assert.ok(!requests[1].text.includes(marker));
  assert.equal((await runtime.snapshot()).diagnostics.contextVerification?.ok, true);
  for (let i = 0; i < 5; i++) await runtime.snapshot();
  assert.equal(requests.length, 2); assert.equal(fake.generations, 0);
  const state = await readFile(path.join(directory, 'runtime-state.json'), 'utf8');
  assert.ok(!state.includes(marker)); assert.ok(!state.includes(requests[0].text));
});

test('context verification stops on the first unverified reply and retains failure as failure', async t => {
  const { runtime, conversation } = await contextFixture(t); let calls = 0;
  runtime.localReplies.run = async request => { calls++; return contextResult(request, conversation, 'unverified reply', calls); };
  await assert.rejects(runtime.command({ action: 'conversation.verifyContext', conversationId: conversation.conversationId }), /requested JSON/);
  assert.equal(calls, 1);
  const state = await runtime.snapshot();
  assert.equal(state.diagnostics.contextVerification?.ok, false); assert.equal(state.diagnostics.contextVerification?.calls, 1);
  assert.equal(state.activeWork.length, 0); assert.equal(state.lifecycle, 'degraded');
});

test('two matching answers cannot confirm context verification if native Session identity changes', async t => {
  const { runtime, task, conversation } = await contextFixture(t); let calls = 0, marker = '';
  runtime.localReplies.run = async request => {
    calls++; marker ||= request.text.match(/SHIYU_[a-f0-9]{12}/u)![0];
    return contextResult(request, conversation, JSON.stringify({ taskId: task.taskId, state: task.state, marker }), calls, `shiyu-replyer-synthetic-${calls}`);
  };
  await assert.rejects(runtime.command({ action: 'conversation.verifyContext', conversationId: conversation.conversationId }), /same native Session/);
  assert.equal(calls, 2); assert.equal((await runtime.snapshot()).diagnostics.contextVerification?.ok, false);
});

test('business reply admission refuses caller authority and pause, and does not relabel duplicate operations as drafts', async t => {
  const { runtime, conversation } = await contextFixture(t); let calls = 0;
  runtime.localReplies.run = async () => { calls++; return { duplicate: true, operation: { status: 'unknown' } } as any; };
  const command = { action: 'conversation.replyLocal', conversationId: conversation.conversationId, inputId: 'one-input', text: 'Synthetic status question' };
  await assert.rejects(runtime.command({ ...command, scope: 'another-audience' }), /Invalid local reply/);
  await assert.rejects(runtime.command({ action: 'conversation.verifyContext', conversationId: conversation.conversationId, businessId: 'forged-binding' }), /Invalid local reply/);
  assert.equal(calls, 0);
  const duplicate: any = await runtime.command(command);
  assert.equal(duplicate.status, 'existing'); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.operation.status, 'unknown');
  await runtime.command({ action: 'runtime.pause' });
  await assert.rejects(runtime.command(command), /paused/);
  assert.equal(calls, 1);
});

test('pause cancels an in-flight business reply before the runtime can release a draft', async t => {
  const { runtime, conversation } = await contextFixture(t);
  let entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  runtime.localReplies.run = async request => new Promise((_resolve, reject) => {
    request.signal!.addEventListener('abort', () => reject(new Error('Synthetic context cancelled')), { once: true }); entered();
  });
  const running = runtime.command({ action: 'conversation.replyLocal', conversationId: conversation.conversationId, inputId: 'cancel-me', text: 'Synthetic status question' });
  const rejected = assert.rejects(running, /cancelled/);
  await began; await runtime.command({ action: 'runtime.pause' }); await rejected;
  assert.equal(runtime.operations.size, 0); assert.equal((await runtime.snapshot()).state, 'paused');
});

test('missing native context prerequisites leave the dashboard available and admit no business reply', async t => {
  const { runtime, conversation, fake, create } = await contextFixture(t);
  await runtime.close();
  fake.prepareContextSafety = async () => { throw new Error('Synthetic native message factory unavailable'); };
  const restarted = create(); await restarted.init();
  try {
    const before = await restarted.store.request('control.watermark', {});
    const snapshot = await restarted.snapshot();
    assert.equal(snapshot.diagnostics.contextSafety.ready, false);
    assert.equal(snapshot.dependencies.find(item => item.id === 'native-context')?.status, 'unavailable');
    await assert.rejects(restarted.command({ action: 'conversation.verifyContext', conversationId: conversation.conversationId }), /Native context safety is unavailable/);
    assert.deepEqual(await restarted.store.request('control.watermark', {}), before);
    assert.equal(fake.generations, 0); assert.equal(restarted.operations.size, 0);
  } finally { await restarted.close(); }
});

test('task completion reaches local conversations in the background, while reads preserve unconsumed Session context', async t => {
  const { runtime, workers, fake, goals } = await fixture(t);
  const content = 'Synthetic conversation background completion';
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  workers.run = async request => {
    workers.calls++;
    const binding = { taskId: request.taskId, assignmentId: request.assignmentId, scope: request.scope, sessionId: 'shiyu-worker-synthetic-conversation' };
    const identity = { ...binding, hostEpoch: request.permit.hostEpoch, installationGeneration: request.permit.installationGeneration, fencingToken: request.permit.fencingToken, leaseExpiresAt: request.permit.leaseExpiresAt };
    await request.onBound(binding); entered(); await gate;
    await request.tools![0].execute({ content }, { ...binding, permit: identity, signal: request.signal!, assertPermit: async () => { await request.permit.check({ ...identity, phase: 'tool' }); } });
    return { ...binding, candidate: { summary: 'Synthetic candidate', evidenceRequests: [] }, usage: { status: 'reported', inputTokens: 20, outputTokens: 10, totalTokens: 30 }, steps: 2, modelCalls: 2, nativeObservations: [], verified: false };
  };
  const accepted: any = await runtime.command({ action: 'task.createLocal', requestId: 'conversation-background-test', title: 'Conversation background fixture', content });
  await began;
  const linked: any = await runtime.command({ action: 'conversation.linkLocalTask', taskId: accepted.task.taskId, localConversationKey: 'conversation-a' });
  assert.equal(linked.accepted, true); assert.equal(linked.taskId, accepted.task.taskId);
  const before = (await runtime.snapshot()).conversations[0];
  release(); await Promise.all([...runtime.operations.values()].map(op => op.done));
  await runtime.background.wake();
  let snapshot = await runtime.snapshot(); const first = snapshot.conversations[0];
  assert.equal(first.conversationId, linked.conversationId); assert.equal(first.bindingId, linked.bindingId);
  assert.equal(first.pending.length, 1); assert.equal(first.pending[0].sourceVersion, 1);
  assert.equal(first.contextVersion, before.contextVersion + 1);
  assert.equal(first.conversationGeneration, before.conversationGeneration);
  assert.equal(first.needsSync, true); assert.equal(snapshot.background.pending, 0); assert.equal(snapshot.background.acknowledged, 1);
  // A late subscriber uses the current known source, even if the original event
  // is globally deduplicated. No page read may acknowledge native Session input.
  const late: any = await runtime.command({ action: 'conversation.linkLocalTask', taskId: accepted.task.taskId, localConversationKey: 'conversation-b' });
  await runtime.background.wake();
  const commitBeforeReads = await runtime.store.request('control.watermark', {});
  for (let i = 0; i < 20; i++) snapshot = await runtime.snapshot();
  assert.deepEqual(await runtime.store.request('control.watermark', {}), commitBeforeReads);
  assert.equal(snapshot.conversations.length, 2);
  const second = snapshot.conversations.find(item => item.conversationId === late.conversationId)!;
  assert.equal(second.needsSync, true); assert.equal(second.sources[0].sourceVersion, 1);
  assert.equal(snapshot.conversations.find(item => item.conversationId === first.conversationId)!.pending.length, 1);
  assert.equal(fake.generations, 0); assert.equal(fake.probes, 0); assert.equal(goals.calls, 0); assert.equal(workers.calls, 1);
});

test('local association rejects caller authority and paused admission without starting any Session', async t => {
  const { runtime, fake, workers, goals } = await fixture(t);
  const detail = await runtime.store.request('task.createLocal', { requestId: 'conversation-admission', title: 'Local fixture', content: 'Synthetic input' });
  await assert.rejects(runtime.command({ action: 'conversation.linkLocalTask', taskId: detail.task.taskId, scope: 'another-audience' }), /Invalid local conversation/);
  await assert.rejects(runtime.command({ action: 'conversation.linkLocalTask', taskId: detail.task.taskId, localConversationKey: '../escape' }), /Invalid local conversation/);
  await runtime.command({ action: 'runtime.pause' });
  await assert.rejects(runtime.command({ action: 'conversation.linkLocalTask', taskId: detail.task.taskId }), /paused/);
  assert.equal((await runtime.snapshot()).conversations.length, 0);
  assert.equal(fake.generations + fake.probes + workers.calls + goals.calls, 0);
});

test('background failures appear in runtime health and a state read cannot retry the consumer', async t => {
  const { runtime } = await fixture(t);
  const original = runtime.store.request.bind(runtime.store); let failures = 0;
  runtime.store.request = (async (command: any, args: any) => {
    if (command === 'conversation.consumeBackground') { failures++; throw new Error('Synthetic background worker fault'); }
    return original(command, args);
  }) as typeof runtime.store.request;
  await runtime.background.wake();
  const state = await runtime.snapshot();
  assert.equal(state.lifecycle, 'degraded'); assert.equal(state.background.state, 'degraded');
  assert.ok(state.notices.some(notice => notice.id === 'background' && notice.message.includes('Synthetic background worker fault')));
  await serveState(runtime); await runtime.snapshot(); assert.equal(failures, 1);
  runtime.store.request = original; await runtime.background.wake();
  assert.equal((await runtime.snapshot()).background.state, 'idle');
});

test('an empty scan cannot hide a terminal durable background delivery failure', async t => {
  const { runtime, fake, workers } = await fixture(t);
  const actor = conversationEventPrincipal();
  await runtime.events.subscribe(actor, { id: 'synthetic-terminal-background-failure', types: ['task.succeeded'], scope: 'local-owner',
    target: { kind: 'component', handlerRef: CONVERSATION_BACKGROUND_HANDLER }, deliveryMode: 'component', start: { kind: 'from_now' }, maxAttempts: 1 });
  // Simulate a bug in a trusted publisher: a reserved event is still insufficient
  // evidence for a nonexistent Task, so the durable consumer must refuse it.
  await runtime.events.publish({ principalId: 'task-service', kind: 'component', scopes: ['local-owner'], publishTypes: ['task.succeeded'], subscribeTypes: [], targetRefs: [] },
    { type: 'task.succeeded', scope: 'local-owner', payload: { taskId: 'e'.repeat(32) }, idempotencyKey: 'synthetic-missing-task', correlationId: 'synthetic-background-test' });
  await runtime.background.wake();
  assert.equal((await runtime.snapshot()).background.failed, 1);
  await runtime.background.wake();
  const snapshot = await runtime.snapshot();
  assert.equal(snapshot.background.lastBatch?.claimed, 0); assert.equal(snapshot.background.state, 'idle');
  assert.equal(snapshot.background.failed, 1); assert.equal(snapshot.lifecycle, 'degraded');
  assert.ok(snapshot.notices.some(notice => notice.id === 'background-failed'));
  assert.equal(fake.generations + fake.probes + workers.calls, 0);
});

test('committed conversation admission survives unload and never wakes a consumer after close', async t => {
  const { runtime, fake, workers, create } = await fixture(t);
  const detail = await runtime.store.request('task.createLocal', { requestId: 'conversation-close', title: 'Local fixture', content: 'Synthetic input' });
  const original = runtime.store.request.bind(runtime.store);
  let reached!: () => void, release!: () => void, scans = 0;
  const committed = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  runtime.store.request = (async (command: any, args: any) => {
    if (command === 'conversation.consumeBackground') scans++;
    const value = await original(command, args);
    if (command === 'conversation.ensureLocalTask') { reached(); await gate; }
    return value;
  }) as typeof runtime.store.request;
  const pending = runtime.command({ action: 'conversation.linkLocalTask', taskId: detail.task.taskId });
  await committed; let closed = false; const closing = runtime.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); assert.equal((await pending as any).accepted, true); await closing;
  assert.equal(scans, 0); assert.equal(runtime.background.snapshot().state, 'stopped');
  const fresh = create(); await fresh.init();
  try { assert.equal((await fresh.snapshot()).conversations.length, 1); assert.equal(fake.generations + fake.probes + workers.calls, 0); }
  finally { await fresh.close(); }
});

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
  const cancelled = assert.rejects(running, /cancelled/);
  await began; await runtime.command({ action: 'runtime.pause' });
  await cancelled;
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

test('dashboard reads never publish, create Sessions or infer; partial systems remain explicit', async t => {
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
    assert.equal(snapshot.systems.find(s => s.id === 'core')?.status, 'partial');
    assert.match(snapshot.systems.find(s => s.id === 'core')?.summary ?? '', /开放式分解和长期规划待验证或实现/);
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
