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
import { LocalReplyService, type LocalReplyOptions, type LocalReplySessionDriver } from '../src/control/local-reply.js';

const TEXT = 'Synthetic question: inspect the linked local task.';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
type Request = Parameters<LocalReplySessionDriver['generateReply']>[0];
class NativeFixture implements LocalReplySessionDriver {
  readReplyDraft?: LocalReplySessionDriver['readReplyDraft'];
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

async function labFixture(t: TestContext, options: Partial<Pick<LocalReplyOptions, 'allowEmptyContext' | 'authorize' | 'maxInputBytes'>> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-lab-reply-')), filename = join(directory, 'control.sqlite');
  const store = await ControlStore.open({ filename, eventTypes: SHIYU_EVENT_TYPES, componentHandlers: ['conversation.background'], runtimeIdentity: { hostEpoch: 'lab-reply-host', installationGeneration: 'lab-reply-install' } });
  const channel = { connectionId: 'lab-test', runId: 'run-one', channelId: 'channel-one', kind: 'direct' as const, membersDigest: sha('synthetic members') };
  const conversation = await store.request('conversation.ensureLabChannel', channel), native = new NativeFixture();
  const service = new LocalReplyService({ store, sessions: native, assertRuntimeAllowed() {}, ...options });
  t.after(async () => { await service.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const run = (inputId = 'lab-one', text = 'Synthetic Lab question') => service.run({ conversationId: conversation.conversationId, inputId, text });
  return { store, native, service, conversation, channel, run, filename };
}

async function labProfileFixture(t: TestContext, grantMs = 600000) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-lab-reply-profile-'));
  const store = await ControlStore.open({ filename: join(directory, 'control.sqlite'), eventTypes: SHIYU_EVENT_TYPES, componentHandlers: ['conversation.background'],
    runtimeIdentity: { hostEpoch: 'profile-host', installationGeneration: 'profile-install' } });
  const channelId = 'profile-channel', expiresAt = new Date(Date.now() + grantMs).toISOString();
  const connection = await store.request('lab.connect', { requestId: 'profile-connect', runId: 'profile-run',
    channels: [{ channelId, kind: 'direct', membersDigest: sha('profile-members') }], budget: { tokens: 32768, calls: 2, effects: 2 }, expiresAt });
  const event = (seq: number) => ({ eventId: `profile-input-${seq}`, channelId, actorId: 'HUMAN', type: 'input.message', seq, bodyHash: sha(TEXT), bodyBytes: Buffer.byteLength(TEXT) });
  await store.request('lab.ingest', { connectionId: connection.connectionId, events: [event(1)] });
  const claim = (await store.request('lab.claimReply', { connectionId: connection.connectionId, channelId }))!;
  const native = new NativeFixture(); let elapsed = 0, captureCalls = 0;
  const service = new LocalReplyService({ store, sessions: native, now: () => new Date(Date.now() + elapsed), allowEmptyContext: true,
    assertRuntimeAllowed() {}, authorize: async () => { await store.request('lab.assertReply', { permit: claim.permit }); },
    captureLabReply: input => { captureCalls++; return store.request('view.captureLabReply', { operationId: input.operationId, permit: claim.permit }); } });
  t.after(async () => { await service.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const input = { conversationId: claim.conversationId, inputId: claim.replyId, text: TEXT, maxTokens: 512 };
  return { store, native, service, claim, connection, input, expiresAt, run: () => service.run(input),
    advance(ms: number) { elapsed += ms; }, captures: () => captureCalls, nextInput: () => store.request('lab.ingest', { connectionId: connection.connectionId, events: [event(2)] }) };
}

test('trusted Lab generation can finish after 31s with one low-effort 512-token request and unchanged capture', async t => {
  const f = await labProfileFixture(t);
  f.native.afterLoad = async () => { f.advance(31000); };
  const result = await f.run();
  assert.equal(result.operation.status, 'ready'); assert.equal(f.captures(), 1); assert.equal(f.native.modelSteps, 1);
  assert.equal(f.native.requests.length, 1); assert.equal(f.native.requests[0]!.maxTokens, 512);
  assert.equal(result.reply!.binding.model.reasoningEffort, 'low');
  assert.equal(Date.parse(result.operation.expiresAt!) - Date.parse(result.operation.createdAt), 120000);
  assert.equal(result.view!.expiresAt, result.operation.expiresAt);
  assert.equal(f.native.requests[0]!.deadlineMs, Date.parse(result.operation.expiresAt!));
  assert.equal((await f.run()).duplicate, true); assert.equal(f.native.requests.length, 1); assert.equal(f.captures(), 1);
});

test('trusted Lab profile still stops at fixed 120s or earlier authority expiry without redispatch', async t => {
  for (const [grantMs, elapsed] of [[600000, 120000], [60000, 61000]]) {
    const f = await labProfileFixture(t, grantMs);
    f.native.afterLoad = async () => { f.advance(elapsed!); };
    await assert.rejects(f.run()); assert.equal(f.native.requests.length, 1); assert.equal(f.captures(), 1);
    const operation = await f.store.request('conversation.reply.get', { operationId: f.native.requests[0]!.context.operationId });
    assert.notEqual(operation.status, 'ready');
    assert.equal(operation.expiresAt, grantMs === 60000 ? f.expiresAt : new Date(Date.parse(operation.createdAt) + 120000).toISOString());
    const duplicate = await f.run(); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.reply, undefined);
    assert.equal(f.native.modelSteps, 1); assert.equal(f.captures(), 1);
  }
});

test('trusted Lab profile rejects new input, connection pause and runtime pause after 31s', async t => {
  for (const change of ['input', 'connection', 'runtime'] as const) {
    const f = await labProfileFixture(t);
    f.native.afterLoad = async () => {
      f.advance(31000);
      if (change === 'input') await f.nextInput();
      else if (change === 'connection') await f.store.request('lab.pause', { connectionId: f.connection.connectionId });
      else await f.store.request('task.setPaused', { paused: true });
    };
    await assert.rejects(f.run()); assert.equal(f.native.modelSteps, 1);
    const operation = await f.store.request('conversation.reply.get', { operationId: f.native.requests[0]!.context.operationId });
    assert.notEqual(operation.status, 'ready');
  }
});

test('Lab load-only uses the ordinary 30s capture even when the trusted generation callback exists', async t => {
  const f = await labProfileFixture(t);
  const result = await f.service.load(f.input);
  assert.equal(result.operation.status, 'loaded'); assert.equal(result.operation.mode, 'load');
  assert.equal(f.captures(), 0); assert.equal(f.native.requests.length, 0); assert.equal(f.native.loads.length, 1);
  assert.ok(Date.parse(result.operation.expiresAt!) - Date.parse(result.operation.createdAt) < 31000);
  await assert.rejects(f.store.request('view.captureLabReply', { operationId: result.operation.operationId, permit: f.claim.permit }));
  await assert.rejects(f.run()); assert.equal(f.native.requests.length, 0);
});

test('legacy loaded and unknown duplicate loads never dispatch or obtain a new capture', async () => {
  for (const status of ['loaded', 'unknown'] as const) {
    const operation = { operationId: 'legacy-operation', conversationId: 'legacy-conversation', inputId: 'legacy-input', status };
    const commands: string[] = []; let nativeCalls = 0, captures = 0;
    const service = new LocalReplyService({ assertRuntimeAllowed() {},
      store: { request: async (command: string) => { commands.push(command); assert.equal(command, 'conversation.reply.admit'); return { duplicate: true, operation }; } } as unknown as ControlStore,
      sessions: { generateReply: async () => { nativeCalls++; throw new Error('Unexpected generation'); }, loadContextOnly: async () => { nativeCalls++; throw new Error('Unexpected load'); } },
      captureLabReply: async () => { captures++; throw new Error('Unexpected renewed capture'); } });
    try {
      const result = await service.load({ conversationId: operation.conversationId, inputId: operation.inputId, text: TEXT });
      assert.equal(result.duplicate, true); assert.deepEqual(result.operation, operation);
      assert.deepEqual(commands, ['conversation.reply.admit']); assert.equal(nativeCalls, 0); assert.equal(captures, 0);
    } finally { await service.close(); }
  }
});

test('Lab empty context is trusted opt-in only and keeps one native Session for ordinary messages', async t => {
  const denied = await labFixture(t);
  await assert.rejects(denied.run()); assert.equal(denied.native.requests.length, 0);
  await assert.rejects(denied.service.run({ conversationId: denied.conversation.conversationId, inputId: 'smuggled', text: 'hi', allowEmptyContext: true } as never));
  const phases: string[] = [], allowed = await labFixture(t, { allowEmptyContext: true, authorize(check) { phases.push(check.phase); } });
  const first = await allowed.run(), second = await allowed.run('lab-two');
  assert.deepEqual(first.view!.data, []); assert.equal(first.operation.textSha256, sha(first.reply!.text));
  assert.equal(first.reply!.binding.sessionId, second.reply!.binding.sessionId);
  assert.equal(first.operation.sessionEpoch, second.operation.sessionEpoch); assert.equal(first.operation.businessId, second.operation.businessId);
  for (const phase of ['start', 'prepare', 'bound', 'admission', 'pre_step', 'context_ack', 'durable', 'release', 'ready']) assert.ok(phases.includes(phase), phase);
  assert.equal((await allowed.run('lab-two')).duplicate, true); assert.equal(allowed.native.requests.length, 2);
  const db = new DatabaseSync(allowed.filename, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shiyu_local_conversations').get()!.n, 0);
    const serialized = JSON.stringify(db.prepare('SELECT record_json FROM shiyu_local_reply_inputs').all());
    assert.ok(!serialized.includes('Synthetic Lab question')); assert.ok(!serialized.includes(first.reply!.text));
  } finally { db.close(); }
});

test('trusted Lab gate revocation blocks dispatch, ack and ready without releasing text', async t => {
  for (const deniedPhase of ['start', 'bound', 'pre_step', 'context_ack', 'durable', 'release', 'ready']) {
    const f = await labFixture(t, { allowEmptyContext: true, authorize(check) { if (check.phase === deniedPhase) throw new Error('Lab authority revoked'); } });
    await assert.rejects(f.run());
    if (['start', 'bound', 'pre_step'].includes(deniedPhase)) assert.equal(f.native.modelSteps, 0, deniedPhase);
    const latest = (await f.store.request('conversation.snapshotLocal', { conversationId: f.conversation.conversationId })).conversations[0]!.latestReply;
    assert.notEqual(latest?.status, 'ready', deniedPhase);
    if (['context_ack', 'durable'].includes(deniedPhase)) assert.equal(latest?.durability, 'unconfirmed');
  }
});

test('Lab membership change after native loading prevents release and starts a new safe epoch', async t => {
  const f = await labFixture(t, { allowEmptyContext: true });
  f.native.afterLoad = async () => { await f.store.request('conversation.ensureLabChannel', { ...f.channel, membersDigest: sha('membership changed') }); };
  await assert.rejects(f.run());
  const current = (await f.store.request('conversation.snapshotLocal', { conversationId: f.conversation.conversationId })).conversations[0]!;
  assert.equal(current.sessionEpoch, f.conversation.sessionEpoch + 1); assert.notEqual(current.latestReply?.status, 'ready');
});

test('a local Task key matching a Lab display key creates an independent source binding', async t => {
  const f = await labFixture(t, { allowEmptyContext: true });
  const task = (await f.store.request('task.createLocal', { requestId: 'lab-key-collision', title: 'Synthetic task', content: 'Independent synthetic content' })).task;
  const local = await f.store.request('conversation.ensureLocalTask', { taskId: task.taskId, localConversationKey: f.conversation.localConversationKey });
  assert.notEqual(local.conversationId, f.conversation.conversationId); assert.notEqual(local.bindingId, f.conversation.bindingId);
  assert.deepEqual(local.source, { kind: 'local-task' });
  const lab = (await f.store.request('conversation.snapshotLocal', { conversationId: f.conversation.conversationId })).conversations[0]!;
  assert.deepEqual(lab.taskRefs, []); assert.deepEqual(lab.sources, []);
});

test('native ready draft cold retrieval is exact, read-only and gated independently of generation', async t => {
  const phases: string[] = [], f = await labFixture(t, { allowEmptyContext: true, authorize(check) { phases.push(check.phase); } });
  const ready = await f.run(); let reads = 0;
  f.native.readReplyDraft = async input => {
    reads++; assert.equal(input.textSha256, ready.operation.textSha256); assert.deepEqual(input.assistantRef, ready.reply!.assistantRef);
    return { text: ready.reply!.text, assistantRef: input.assistantRef, binding: ready.reply!.binding };
  };
  const before = await f.store.request('control.watermark', {}), recovered = await f.service.readReadyDraft({ operationId: ready.operation.operationId });
  assert.equal(recovered.text, ready.reply!.text); assert.equal(reads, 1); assert.equal(f.native.requests.length, 1);
  assert.deepEqual(await f.store.request('control.watermark', {}), before); assert.equal(phases.filter(phase => phase === 'read_draft').length, 2);
  f.native.readReplyDraft = async input => ({ text: 'changed', assistantRef: input.assistantRef, binding: ready.reply!.binding });
  await assert.rejects(f.service.readReadyDraft({ operationId: ready.operation.operationId }), /does not match/);
});

test('trusted grouped input byte bound is explicit and never truncates or leaks into public input', async t => {
  const f = await labFixture(t, { allowEmptyContext: true, maxInputBytes: 18432 });
  await assert.rejects(f.run('too-big', '合'.repeat(6145))); assert.equal(f.native.requests.length, 0);
  const content = 'a'.repeat(17000), result = await f.run('allowed-group', content);
  assert.equal(result.operation.inputHash, sha(content));
  // Independent Lab audit extracts the exact admitted input with this stable delimiter.
  assert.equal(f.native.requests[0]!.prompt.split('\n本轮用户输入：\n').at(1), content);
  assert.throws(() => new LocalReplyService({ store: f.store, sessions: f.native, assertRuntimeAllowed() {}, maxInputBytes: 32769 }));
});

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
