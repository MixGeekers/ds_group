import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { defaultModel, sessionBindingKey } from '../src/adapters/dsh/sessions.js';
import type { ContextLoadRequest, ContextLoadResult } from '../src/adapters/dsh/sessions.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import { LocalReplyService, type LocalReplySessionDriver } from '../src/control/local-reply.js';

const TEXT = 'Synthetic question: inspect the linked local task.';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
type Request = Parameters<LocalReplySessionDriver['generateReply']>[0];
class NativeFixture implements LocalReplySessionDriver {
  readonly requests: Request[] = [];
  readonly loads: ContextLoadRequest[] = [];
  modelSteps = 0;
  beforeBind?: (request: Request) => Promise<void>;
  afterBind?: (request: Request) => Promise<void>;
  afterLoad?: (request: Request) => Promise<void>;
  afterLoadOnly?: (request: ContextLoadRequest) => Promise<void>;
  beforeLoadOnlyReceipt?: (request: ContextLoadRequest) => Promise<void>;
  async loadContextOnly(request: ContextLoadRequest): Promise<ContextLoadResult> {
    this.loads.push(request);
    const sessionId = request.context.expectedSessionId ?? 'shiyu-replyer-synthetic-load';
    const native = { operationId: request.context.operationId, contextTokenId: request.context.contextTokenId, sessionEpoch: request.context.sessionEpoch,
      key: sessionBindingKey('replyer', request.businessId, request.scope), businessId: request.businessId, scope: request.scope, sessionId,
      messageId: `load-message-${request.context.operationId}`, messageHash: sha(request.prompt) };
    await request.context.authorize({ phase: 'admission', ...native });
    await request.context.onBound(native); await request.context.authorize({ phase: 'append', ...native });
    await this.beforeLoadOnlyReceipt?.(request);
    const contextReceipt = { ...native, userMessageSeq: this.loads.length * 10 + 1, confirmedAt: new Date().toISOString(), durability: 'confirmed' as const };
    await request.context.authorize({ phase: 'context_ack', ...native }); await request.context.onContextDurable(contextReceipt);
    await this.afterLoadOnly?.(request); await request.context.authorize({ phase: 'release', ...native });
    return { mode: 'load-only', inferenceRequested: false, followupRequested: false, contextReceipt,
      binding: { key: native.key, role: 'replyer', businessId: request.businessId, scope: request.scope, sessionId,
        model: defaultModel('replyer'), status: 'released', createdAt: contextReceipt.confirmedAt, updatedAt: contextReceipt.confirmedAt, usage: { status: 'unknown' } } };
  }
  async generateReply(request: Request) {
    this.requests.push(request);
    await request.context.authorize({ phase: 'admission' });
    await this.beforeBind?.(request);
    const sessionId = request.context.expectedSessionId ?? 'shiyu-replyer-synthetic-native';
    const native = { operationId: request.context.operationId, contextTokenId: request.context.contextTokenId, sessionEpoch: request.context.sessionEpoch,
      key: sessionBindingKey('replyer', request.businessId, request.scope), businessId: request.businessId, scope: request.scope, sessionId,
      messageId: `message-${request.context.operationId}`, messageHash: sha(request.prompt) };
    await request.context.onBound(native); await this.afterBind?.(request);
    await request.context.authorize({ phase: 'pre_step', ...native }); this.modelSteps++;
    const contextReceipt = { ...native, userMessageSeq: this.requests.length * 10 + 1, confirmedAt: new Date().toISOString(), durability: 'confirmed' as const };
    await request.context.authorize({ phase: 'context_ack', ...native }); await request.context.onContextDurable(contextReceipt);
    await this.afterLoad?.(request); await request.context.authorize({ phase: 'release', ...native });
    return { text: 'Synthetic current task answer', usage: { status: 'unknown' as const }, contextReceipt,
      assistantRef: { sessionId, eventSeq: contextReceipt.userMessageSeq + 1, messageId: `assistant-${request.context.operationId}` },
      binding: { key: native.key, role: 'replyer' as const, businessId: request.businessId, scope: request.scope, sessionId,
        model: defaultModel('replyer'), status: 'idle' as const, createdAt: contextReceipt.confirmedAt, updatedAt: contextReceipt.confirmedAt, usage: { status: 'unknown' as const } } };
  }
}
async function fixture(t: TestContext, options: { now?: () => Date } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-local-reply-service-'));
  const filename = join(directory, 'control.sqlite');
  const store = await ControlStore.open({ filename, eventTypes: SHIYU_EVENT_TYPES, componentHandlers: ['conversation.background'], runtimeIdentity: { hostEpoch: 'reply-host', installationGeneration: 'reply-install' } });
  const task = (await store.request('task.createLocal', { requestId: 'reply-source', title: 'Synthetic task', content: 'Synthetic local content' })).task;
  const conversation = await store.request('conversation.ensureLocalTask', { taskId: task.taskId });
  const native = new NativeFixture(); let paused = false;
  const service = new LocalReplyService({ store, sessions: native, ...options, assertRuntimeAllowed() { if (paused) throw new Error('paused'); } });
  t.after(async () => { await service.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const run = (inputId = 'input-one') => service.run({ conversationId: conversation.conversationId, inputId, text: TEXT });
  const latest = async () => (await store.request('conversation.snapshotLocal', { conversationId: conversation.conversationId })).conversations[0]!;
  return { store, native, service, filename, task, conversation, run, latest, pause() { paused = true; } };
}

test('two local inputs use real captures and one stable native binding; duplicate input never follows up again', async t => {
  const f = await fixture(t); const published = await f.store.request('view.state', {});
  const first = await f.run(); assert.equal(first.operation.status, 'ready'); assert.equal(first.operation.durability, 'confirmed');
  assert.equal((await f.latest()).needsSync, false); assert.equal(first.view!.data[0]!.fields.taskId, f.task.taskId);
  const beforeDuplicate = await f.store.request('control.watermark', {});
  const duplicate = await f.run(); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.reply, undefined);
  assert.equal(f.native.requests.length, 1); assert.deepEqual(await f.store.request('control.watermark', {}), beforeDuplicate);
  const second = await f.run('input-two'); assert.equal(second.operation.status, 'ready');
  assert.equal(first.reply!.binding.sessionId, second.reply!.binding.sessionId); assert.equal(first.operation.businessId, second.operation.businessId);
  assert.equal(first.operation.sessionEpoch, second.operation.sessionEpoch); assert.ok(second.operation.token.conversationGeneration > first.operation.token.conversationGeneration);
  assert.equal(f.native.requests[1]!.context.expectedSessionId, first.reply!.binding.sessionId);
  assert.equal((await f.store.request('view.state', {}))!.stateVersion, published!.stateVersion);
  const row = new DatabaseSync(f.filename, { readOnly: true });
  try { const records = JSON.stringify(row.prepare('SELECT record_json FROM shiyu_local_reply_inputs').all()); assert.ok(!records.includes(TEXT)); assert.ok(!records.includes('Synthetic current task answer')); }
  finally { row.close(); }
});

test('load-only confirms native context independently, reuses its Session and never creates a ready assistant draft', async t => {
  const f = await fixture(t);
  const first = await f.service.load({ conversationId: f.conversation.conversationId, inputId: 'load-one', text: TEXT });
  assert.equal(first.operation.status, 'loaded'); assert.equal(first.operation.durability, 'confirmed');
  assert.equal(first.operation.assistantRef, undefined); assert.equal(first.operation.draftRef, undefined);
  assert.equal(first.load!.inferenceRequested, false); assert.equal(first.load!.followupRequested, false);
  const duplicate = await f.service.load({ conversationId: f.conversation.conversationId, inputId: 'load-one', text: TEXT });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.load, undefined); assert.equal(duplicate.view, undefined);
  const second = await f.service.load({ conversationId: f.conversation.conversationId, inputId: 'load-two', text: TEXT });
  assert.equal(second.operation.status, 'loaded'); assert.equal(second.load!.binding.sessionId, first.load!.binding.sessionId);
  assert.equal(second.operation.sessionEpoch, first.operation.sessionEpoch); assert.equal(f.native.loads.length, 2);
  assert.equal(f.native.requests.length, 0); assert.equal(f.native.modelSteps, 0);
  const db = new DatabaseSync(f.filename, { readOnly: true });
  try {
    const rows = JSON.stringify(db.prepare('SELECT record_json FROM shiyu_local_reply_inputs').all());
    assert.equal(rows.includes(TEXT), false);
    for (const row of db.prepare('SELECT record_json FROM shiyu_reply_drafts').all()) assert.equal(JSON.parse(String(row.record_json)).status, 'abandoned');
  } finally { db.close(); }
});

test('load-only failure before receipt stays unknown and an identical retry never appends again', async t => {
  const f = await fixture(t); f.native.beforeLoadOnlyReceipt = async () => { throw new Error('Synthetic lost native append outcome'); };
  const input = { conversationId: f.conversation.conversationId, inputId: 'unknown-load', text: TEXT };
  await assert.rejects(f.service.load(input)); assert.equal((await f.latest()).latestReply!.status, 'unknown');
  const duplicate = await f.service.load(input); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.operation.durability, 'unconfirmed');
  assert.equal(f.native.loads.length, 1); assert.equal(f.native.requests.length, 0);
});

test('load-only release failure preserves the exact confirmed loading fact without claiming a completed diagnostic', async t => {
  const f = await fixture(t); f.native.afterLoadOnly = async () => { throw new Error('Synthetic native release failure'); };
  await assert.rejects(f.service.load({ conversationId: f.conversation.conversationId, inputId: 'loaded-but-failed', text: TEXT }));
  const operation = (await f.latest()).latestReply!;
  assert.equal(operation.status, 'failed'); assert.equal(operation.durability, 'confirmed'); assert.equal(operation.assistantEventSeq, undefined);
  assert.equal(f.native.requests.length, 0); assert.equal(f.native.modelSteps, 0);
});

test('withdrawal cancellation notification stops an in-flight load without dispatching any generation', async t => {
  const f = await fixture(t); let entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  f.native.beforeLoadOnlyReceipt = async request => { entered(); await new Promise<void>((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true })); };
  const loading = f.service.load({ conversationId: f.conversation.conversationId, inputId: 'withdraw-load', text: TEXT });
  const rejected = assert.rejects(loading); await began; f.service.cancelConversations([f.conversation.conversationId]); await rejected;
  assert.equal((await f.latest()).latestReply!.status, 'cancelled'); assert.equal(f.native.requests.length, 0);
});

test('unknown native dispatch is retained and an identical retry does not dispatch or consume background', async t => {
  const f = await fixture(t); f.native.afterBind = async () => { throw new Error('native durable outcome unknown'); };
  await assert.rejects(f.run()); assert.equal((await f.latest()).latestReply!.status, 'unknown'); assert.equal((await f.latest()).needsSync, true);
  const duplicate = await f.run(); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.operation.status, 'unknown'); assert.equal(f.native.requests.length, 1);
});

test('a failed generation keeps independently confirmed context loading', async t => {
  const f = await fixture(t); f.native.afterLoad = async () => { throw new Error('synthetic model failure after input loading'); };
  await assert.rejects(f.run()); const latest = await f.latest();
  assert.equal(latest.latestReply!.status, 'failed'); assert.equal(latest.latestReply!.durability, 'confirmed'); assert.equal(latest.needsSync, false);
  assert.equal((await f.run()).duplicate, true); assert.equal(f.native.requests.length, 1);
});

test('actual Task version change after loading invalidates the draft without undoing its context receipt', async t => {
  const f = await fixture(t); f.native.afterLoad = async () => { await f.store.request('task.cancel', { taskId: f.task.taskId, reason: 'Synthetic source version changed' }); };
  await assert.rejects(f.run()); const latest = await f.latest();
  assert.equal(latest.latestReply!.status, 'failed'); assert.equal(latest.latestReply!.durability, 'confirmed'); assert.equal(latest.latestReply!.assistantEventSeq, undefined);
});

test('unrelated control commits do not invalidate a captured local Task answer', async t => {
  const f = await fixture(t); f.native.afterLoad = async () => { await f.store.request('conversation.ensureLocalTask', { taskId: f.task.taskId, localConversationKey: 'unrelated-conversation' }); };
  assert.equal((await f.run()).operation.status, 'ready'); assert.equal(f.native.modelSteps, 1);
});

test('runtime pause before native bind and an already-expired capture prevent native model steps', async t => {
  const f = await fixture(t); f.native.beforeBind = async () => { f.pause(); };
  await assert.rejects(f.run()); assert.equal(f.native.modelSteps, 0); assert.equal((await f.latest()).needsSync, true);
  const g = await fixture(t, { now: () => new Date(Date.now() + 60000) });
  await assert.rejects(g.run()); assert.equal(g.native.requests.length, 0);
});

test('a newer input cancels an old in-flight attempt while preserving the business binding', async t => {
  const f = await fixture(t); let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.native.afterBind = async request => {
    if (f.native.requests.length !== 1) return;
    started(); await new Promise<void>((_resolve, reject) => { request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true }); });
  };
  const older = f.run('older-input'); const rejection = assert.rejects(older); await entered;
  const newer = await f.run('newer-input'); await rejection;
  assert.equal(newer.operation.status, 'ready'); assert.equal(f.native.requests.length, 2);
  assert.equal(f.native.requests[0]!.businessId, f.native.requests[1]!.businessId);
  assert.equal(f.native.requests[1]!.context.expectedSessionId, 'shiyu-replyer-synthetic-native');
});

test('close cancels and drains an active native request before the store is closed', async t => {
  const f = await fixture(t); let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.native.afterBind = async request => { started(); await new Promise<void>((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true })); };
  const running = f.run(); const rejected = assert.rejects(running); await entered;
  await f.service.close(); await rejected; assert.equal((await f.latest()).latestReply!.status, 'cancelled');
  await assert.rejects(f.run('after-close')); assert.equal(f.native.requests.length, 1);
});

test('abort or pause during final View validation cannot mark or return a ready draft', async t => {
  for (const mode of ['abort', 'pause'] as const) {
    const f = await fixture(t); const controller = new AbortController();
    let nativeReturned = false, enter!: () => void, release!: () => void, gated = false;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const native = f.native.generateReply.bind(f.native);
    f.native.generateReply = async request => { const result = await native(request); nativeReturned = true; return result; };
    const request = f.store.request.bind(f.store);
    f.store.request = (async (command: string, args: never) => {
      const value = await request(command as never, args);
      if (!gated && nativeReturned && command === 'view.validateCapture') { gated = true; enter(); await gate; }
      return value;
    }) as typeof f.store.request;
    const running = f.service.run({ conversationId: f.conversation.conversationId, inputId: `cancel-final-${mode}`, text: TEXT, signal: controller.signal });
    const rejection = assert.rejects(running); await entered;
    if (mode === 'abort') controller.abort(new Error('synthetic cancellation')); else f.pause();
    release(); await rejection;
    const latest = await f.latest(); assert.notEqual(latest.latestReply!.status, 'ready'); assert.equal(latest.latestReply!.assistantEventSeq, undefined);
    assert.equal(latest.latestReply!.durability, 'confirmed');
  }
});

test('cancellation after ready commits preserves its receipt but suppresses transient reply return', async t => {
  const f = await fixture(t); const controller = new AbortController(); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const request = f.store.request.bind(f.store);
  f.store.request = (async (command: string, args: never) => {
    const value = await request(command as never, args);
    if (command === 'conversation.reply.ready') { enter(); await gate; }
    return value;
  }) as typeof f.store.request;
  const running = f.service.run({ conversationId: f.conversation.conversationId, inputId: 'cancel-committed-ready', text: TEXT, signal: controller.signal });
  const rejection = assert.rejects(running); await entered; controller.abort(new Error('synthetic cancellation after commit')); release(); await rejection;
  const latest = await f.latest(); assert.equal(latest.latestReply!.status, 'ready'); assert.equal(latest.latestReply!.durability, 'confirmed');
  assert.equal((await f.run('cancel-committed-ready')).duplicate, true); assert.equal(f.native.requests.length, 1);
});
