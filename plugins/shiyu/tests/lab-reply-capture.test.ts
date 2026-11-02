import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { sessionBindingKey } from '../src/adapters/dsh/sessions.js';
import type { LabReply } from '../src/contracts/lab.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import { createLocalReadView } from '../src/views/local.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const coded = (error: unknown): error is Error & { code: string } => error instanceof Error && 'code' in error && typeof error.code === 'string';

/** Real IPC Worker, authority, Conversation, Lab permits and SQLite. No Session, remote service or model. */
async function fixture(t: TestContext, options: { expiresInMs?: number; channels?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-lab-reply-capture-'));
  const store = await ControlStore.open({ filename: join(directory, 'control.sqlite'), eventTypes: SHIYU_EVENT_TYPES,
    componentHandlers: ['conversation.background'], runtimeIdentity: { hostEpoch: 'synthetic-capture-host', installationGeneration: 'synthetic-capture-install' } });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const expiresAt = new Date(Date.now() + (options.expiresInMs ?? 600000)).toISOString();
  const connection = await store.request('lab.connect', { requestId: 'synthetic-capture-connection', runId: 'synthetic-capture-run',
    channels: Array.from({ length: options.channels ?? 2 }, (_, index) => ({ channelId: `capture-channel-${index}`, kind: index ? 'group' as const : 'direct' as const,
      membersDigest: hash(`synthetic-members-${index}`) })), budget: { tokens: 262144, calls: 16, effects: 16 }, expiresAt });
  let sequence = 0;
  const ingest = async (channelId = connection.channels[0]!.channelId) => {
    const seq = ++sequence, text = `synthetic input ${seq}`;
    await store.request('lab.ingest', { connectionId: connection.connectionId, events: [{ eventId: `synthetic-capture-run:e${seq}`, channelId,
      actorId: 'HUMAN', type: 'input.message', seq, bodyHash: hash(text), bodyBytes: Buffer.byteLength(text) }] });
    return text;
  };
  const claim = async (index = 0) => {
    const channelId = connection.channels[index]!.channelId, text = await ingest(channelId);
    const reply = await store.request('lab.claimReply', { connectionId: connection.connectionId, channelId });
    assert.ok(reply); return { reply, text };
  };
  const admit = async (reply: LabReply, text: string, inputId = reply.replyId, mode?: 'reply' | 'load') =>
    (await store.request('conversation.reply.admit', { conversationId: reply.conversationId, inputId, inputHash: hash(text), ...(mode ? { mode } : {}) })).operation;
  const capture = (operationId: string, reply: LabReply) => store.request('view.captureLabReply', { operationId, permit: reply.permit });
  return { store, connection, ingest, claim, admit, capture };
}

test('real Worker issues an operation-bound 120-second Lab capture while ordinary captures stay at 30 seconds', async t => {
  const f = await fixture(t), { reply, text } = await f.claim(), operation = await f.admit(reply, text);
  const ordinary = await f.store.request('view.captureLocal', { conversationId: reply.conversationId, purpose: 'reply_context' });
  assert.equal(Date.parse(ordinary.expiresAt) - Date.parse(ordinary.capturedAt), 30000);
  assert.equal(ordinary.replyExecution, undefined);
  const capture = await f.capture(operation.operationId, reply);
  assert.equal(Date.parse(capture.expiresAt) - Date.parse(operation.createdAt), 120000);
  assert.deepEqual(capture.replyExecution, { kind: 'lab-reply-v1', operationId: operation.operationId, replyId: reply.replyId, connectionId: reply.connectionId });
  assert.equal(capture.access.expiresAt, capture.expiresAt); assert.equal(capture.component.expiresAt, capture.expiresAt);
  const local = createLocalReadView(capture, { validate: captureId => f.store.request('view.validateCapture', { captureId }) }); t.after(() => local.close());
  const view = await local.read();
  assert.equal(view.expiresAt, capture.expiresAt, 'ReadView must not truncate the trusted Lab lease back to its ordinary 30-second cap');
  const prepared = await f.store.request('conversation.reply.prepare', { operationId: operation.operationId, captureId: capture.captureId, viewId: view.viewId, loadedTaskIds: [] });
  assert.equal(prepared.expiresAt, capture.expiresAt);
  assert.deepEqual(await f.store.request('view.validateCapture', { captureId: capture.captureId }), capture);
});

test('connection expiry clips the Lab execution lease instead of always granting 120 seconds', async t => {
  const f = await fixture(t, { expiresInMs: 60000 }), { reply, text } = await f.claim(), operation = await f.admit(reply, text);
  const capture = await f.capture(operation.operationId, reply);
  assert.equal(capture.expiresAt, f.connection.expiresAt);
  assert.ok(Date.parse(capture.expiresAt) < Date.parse(operation.createdAt) + 120000);
  assert.ok(Date.parse(capture.expiresAt) <= Date.parse(reply.permit.leaseExpiresAt));
});

test('caller-selected TTL, execution metadata and altered permit cannot create a longer capture', async t => {
  const f = await fixture(t), { reply, text } = await f.claim(), operation = await f.admit(reply, text);
  const before = await f.store.request('control.watermark', {});
  for (const extra of [{ ttlMs: 600000 }, { expiresAt: '2099-01-01T00:00:00.000Z' },
    { replyExecution: { kind: 'lab-reply-v1', operationId: operation.operationId, replyId: reply.replyId, connectionId: reply.connectionId } }]) {
    await assert.rejects(f.store.request('view.captureLocal', { conversationId: reply.conversationId, purpose: 'reply_context', ...extra } as never), coded);
    await assert.rejects(f.store.request('view.captureLabReply', { operationId: operation.operationId, permit: reply.permit, ...extra } as never), coded);
  }
  for (const permit of [{ ...reply.permit, claimToken: 'forged-claim' }, { ...reply.permit, leaseExpiresAt: '2099-01-01T00:00:00.000Z' },
    { ...reply.permit, hostEpoch: 'another-host' }, { ...reply.permit, connectionEpoch: reply.permit.connectionEpoch + 1 }]) {
    await assert.rejects(f.store.request('view.captureLabReply', { operationId: operation.operationId, permit }), coded);
  }
  assert.deepEqual(await f.store.request('control.watermark', {}), before);
  assert.ok(await f.capture(operation.operationId, reply), 'rejected attempts must not consume the valid initial capture');
});

test('capture requires the exact Lab input, conversation and admitted local operation', async t => {
  const f = await fixture(t), first = await f.claim(0), second = await f.claim(1);
  const wrongInput = await f.admit(first.reply, first.text, 'ordinary-local-input');
  await assert.rejects(f.capture(wrongInput.operationId, first.reply), coded);
  const a = await f.admit(first.reply, first.text), b = await f.admit(second.reply, second.text);
  await assert.rejects(f.capture(a.operationId, second.reply), coded);
  await assert.rejects(f.capture(b.operationId, first.reply), coded);
  const capture = await f.capture(a.operationId, first.reply);
  await assert.rejects(f.store.request('conversation.reply.prepare', { operationId: b.operationId, captureId: capture.captureId, viewId: 'foreign-operation-view', loadedTaskIds: [] }), coded);
  const currentB = await f.store.request('conversation.reply.get', { operationId: b.operationId });
  assert.equal(currentB.status, 'admitted'); assert.equal(currentB.captureId, undefined);
  const ordinary = await f.store.request('view.captureLocal', { conversationId: first.reply.conversationId, purpose: 'reply_context' });
  assert.equal(ordinary.replyExecution, undefined);
});

test('duplicate capture is refused without changing the fixed lease or advancing control state', async t => {
  const f = await fixture(t), { reply, text } = await f.claim(), operation = await f.admit(reply, text), capture = await f.capture(operation.operationId, reply);
  const before = await f.store.request('control.watermark', {});
  await assert.rejects(f.capture(operation.operationId, reply), coded);
  assert.deepEqual(await f.store.request('view.validateCapture', { captureId: capture.captureId }), capture);
  assert.deepEqual(await f.store.request('control.watermark', {}), before);
});

test('load-only and already-prepared local operations cannot acquire the generation lease', async t => {
  const f = await fixture(t), a = await f.claim(0), load = await f.admit(a.reply, a.text, a.reply.replyId, 'load');
  await assert.rejects(f.capture(load.operationId, a.reply), coded);
  const ordinary = await f.store.request('view.captureLocal', { conversationId: a.reply.conversationId, purpose: 'reply_context' });
  assert.equal(Date.parse(ordinary.expiresAt) - Date.parse(ordinary.capturedAt), 30000);
  const b = await f.claim(1), operation = await f.admit(b.reply, b.text);
  const short = await f.store.request('view.captureLocal', { conversationId: b.reply.conversationId, purpose: 'reply_context' });
  await f.store.request('conversation.reply.prepare', { operationId: operation.operationId, captureId: short.captureId, viewId: 'already-prepared-view', loadedTaskIds: [] });
  await assert.rejects(f.capture(operation.operationId, b.reply), coded);
});

test('accounted replies keep pure capture validation but cannot receive another capture', async t => {
  const f = await fixture(t), { reply, text } = await f.claim(), operation = await f.admit(reply, text), capture = await f.capture(operation.operationId, reply);
  await f.store.request('lab.recordReplyAccounting', { permit: reply.permit, receiptId: 'synthetic-usage-receipt', complete: true, tokens: 100, calls: 1, evidenceRef: 'synthetic:native-primary' });
  const before = await f.store.request('control.watermark', {});
  assert.deepEqual(await f.store.request('view.validateCapture', { captureId: capture.captureId }), capture);
  await assert.rejects(f.capture(operation.operationId, reply), coded);
  assert.deepEqual(await f.store.request('control.watermark', {}), before);
});

test('a sent reply may validate its original capture without granting new generation or another effect', async t => {
  const f = await fixture(t), { reply, text } = await f.claim(), operation = await f.admit(reply, text), capture = await f.capture(operation.operationId, reply);
  const prepared = await f.store.request('conversation.reply.prepare', { operationId: operation.operationId, captureId: capture.captureId, viewId: 'synthetic-sent-view', loadedTaskIds: [] });
  // Synthetic native references exercise only the trusted adapter-to-domain contract; no Session is opened.
  const binding = { operationId: prepared.operationId, contextTokenId: prepared.contextTokenId!, sessionEpoch: prepared.sessionEpoch,
    key: sessionBindingKey('replyer', prepared.businessId, prepared.scope), businessId: prepared.businessId, scope: prepared.scope,
    sessionId: 'shiyu-replyer-synthetic-capture', messageId: 'synthetic-capture-input', messageHash: hash('synthetic complete native input') };
  await f.store.request('conversation.reply.bind', { binding });
  await f.store.request('conversation.reply.contextDurable', { receipt: { ...binding, userMessageSeq: 1, confirmedAt: new Date().toISOString(), durability: 'confirmed' } });
  const body = 'Synthetic native draft for capture validation.';
  await f.store.request('conversation.reply.ready', { operationId: prepared.operationId,
    assistantRef: { sessionId: binding.sessionId, eventSeq: 2, messageId: 'synthetic-capture-assistant' }, textSha256: hash(body) });
  await f.store.request('lab.recordReplyAccounting', { permit: reply.permit, receiptId: 'synthetic-sent-usage', complete: true,
    tokens: 100, calls: 1, evidenceRef: 'synthetic:native-capture' });
  const send = await f.store.request('lab.prepareSend', { permit: reply.permit, draftOperationId: prepared.operationId, bodyHash: hash(body), bodyBytes: Buffer.byteLength(body) });
  assert.ok(send.claim);
  await f.store.request('lab.recordSendReceipt', { opId: send.opId, claim: send.claim, reconciliation: false,
    observation: { opId: send.opId, channelId: reply.channelId, eventId: 'synthetic-capture-run:e100', bodyHash: hash(body), observedAt: new Date().toISOString() } });
  const before = await f.store.request('control.watermark', {}), detail = await f.store.request('lab.get', { connectionId: reply.connectionId });
  assert.equal(detail.replies[0]!.status, 'sent'); assert.equal(detail.sends.length, 1);
  assert.deepEqual(await f.store.request('view.validateCapture', { captureId: capture.captureId }), capture);
  await assert.rejects(f.capture(operation.operationId, reply), coded);
  await assert.rejects(f.store.request('conversation.reply.authorize', { operationId: operation.operationId, phase: 'dispatch' }), coded);
  assert.deepEqual(await f.store.request('lab.get', { connectionId: reply.connectionId }), detail);
  assert.deepEqual(await f.store.request('control.watermark', {}), before);
});

for (const change of ['new-input', 'unknown', 'connection-pause', 'runtime-pause'] as const) test(`long capture still rejects ${change} before use`, async t => {
  const f = await fixture(t), { reply, text } = await f.claim(), operation = await f.admit(reply, text), capture = await f.capture(operation.operationId, reply);
  if (change === 'new-input') await f.ingest(reply.channelId);
  else if (change === 'unknown') await f.store.request('lab.markReplyUnknown', { permit: reply.permit, reasonCode: 'synthetic_unknown' });
  else if (change === 'connection-pause') await f.store.request('lab.pause', { connectionId: reply.connectionId });
  else await f.store.request('task.setPaused', { paused: true });
  await assert.rejects(f.store.request('view.validateCapture', { captureId: capture.captureId }), coded);
  await assert.rejects(f.store.request('conversation.reply.prepare', { operationId: operation.operationId, captureId: capture.captureId, viewId: `invalidated-${change}`, loadedTaskIds: [] }), coded);
  assert.equal((await f.store.request('conversation.reply.get', { operationId: operation.operationId })).status, 'admitted');
});
