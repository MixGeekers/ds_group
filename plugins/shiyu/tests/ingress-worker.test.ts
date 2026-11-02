import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import { conversation, createEvent, registration, sha, tombstoneEvent } from './fixtures/channel.js';

const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-ingress-worker-')), filename = join(directory, 'control.sqlite');
  const stores: ControlStore[] = [];
  const open = async () => {
    const store = await ControlStore.open({ filename, eventTypes: SHIYU_EVENT_TYPES, componentHandlers: ['conversation.background'] });
    stores.push(store); return store;
  };
  t.after(async () => {
    await Promise.allSettled(stores.map(store => store.close()));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, filename, open, stores };
}
function allValues(filename: string): string {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      .map(row => JSON.stringify(db.prepare(`SELECT * FROM "${String((row as { name: string }).name).replaceAll('"', '""')}"`).all())).join('\n');
  } finally { db.close(); }
}

test('real ControlStore Worker exposes the channel ingress ports with durable dedupe and two-phase content reads', async t => {
  const f = await fixture(t), store = await f.open();
  assert.deepEqual(await store.request('channel.status', {}), { ready: true, schemaVersion: 1 });
  const alpha = await store.request('channel.registerConnection', registration('acct-alpha'));
  assert.equal(alpha.duplicate, false);
  const direct = conversation('worker-dm-1', 'direct');
  const ensured = await store.request('channel.ensureConversation', { connectionId: alpha.connectionId, conversation: direct, reasonRef: 'synthetic:worker' });
  assert.equal(ensured.created, true);
  await store.request('channel.updateAudience', { conversationRef: ensured.conversationRef,
    participants: [{ nativeParticipantId: 'peer-1', kind: 'human' }], reasonRef: 'synthetic:worker-dm', expectedAudienceVersion: 0 });
  const event = createEvent('worker-message-1');
  const first = await store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: direct, events: [event] });
  assert.equal(first.results[0]!.status, 'accepted');
  const duplicate = await store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: direct, events: [event] });
  assert.equal(duplicate.results[0]!.status, 'duplicate');
  assert.equal(duplicate.results[0]!.intakeSeq, first.results[0]!.intakeSeq);
  const message = await store.request('channel.getMessage', { messageId: first.results[0]!.messageId!, expectedAudienceVersion: 1 });
  assert.equal(message.status, 'active'); assert.equal(message.hasBodyRef, true);
  assert.ok(!('bodyRef' in message) && !('summary' in message));
  const capture = await store.request('channel.captureAudience', { conversationRef: ensured.conversationRef, expectedAudienceVersion: 1 });
  const content = await store.request('channel.readContentRefs', { captureId: capture.captureId, messageIds: [message.messageId] });
  assert.equal(content.content[0]!.bodyRef, 'native-body:worker-message-1');
  assert.equal(content.content[0]!.summary, 'summary worker-message-1');
  assert.deepEqual(await store.request('channel.watermark', {}), { intakeSeq: 1, invalidationWatermark: 1, deletionWatermark: 0, revocationWatermark: 0 });
  const snapshot = await store.request('channel.snapshot', {});
  assert.equal(snapshot.connections.length, 1); assert.equal(snapshot.conversations.length, 1);
  // A different conversation cannot be read through this capture.
  const other = conversation('worker-group-2', 'group');
  await store.request('channel.ensureConversation', { connectionId: alpha.connectionId, conversation: other, reasonRef: 'synthetic:worker' });
  const otherMessage = (await store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: other, events: [createEvent('worker-message-2')] })).results[0]!;
  await assert.rejects(store.request('channel.readContentRefs', { captureId: capture.captureId, messageIds: [otherMessage.messageId!] }), code('CROSS_AUDIENCE'));
  // Forged adapter metadata is refused, not reinterpreted.
  await assert.rejects(store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: direct,
    events: [{ ...event, trustedActor: 'local-owner' }] } as never), code('INVALID_SCHEMA'));
  await assert.rejects(store.request('channel.ingest', { connectionId: 'chconn-' + '0'.repeat(32), conversation: direct, events: [event] }), code('UNKNOWN_CONNECTION'));
  await assert.rejects(store.request('channel.getMessage', { messageId: 'chmsg-' + '0'.repeat(40) }), code('UNKNOWN_MESSAGE'));
  // Read-only ports do not advance the durable control commit watermark.
  const before = await store.request('control.watermark', {});
  for (let index = 0; index < 100; index++) {
    await store.request('channel.getMessage', { messageId: message.messageId });
    await store.request('channel.watermark', {});
    await store.request('channel.invalidationsAfter', {});
    await store.request('channel.deletionsAfter', {});
    await store.request('channel.revocationsAfter', {});
    await store.request('channel.snapshot', {});
    await store.request('channel.readContentRefs', { captureId: capture.captureId, messageIds: [message.messageId] });
  }
  assert.equal((await store.request('control.watermark', {})).commitSeq, before.commitSeq);
});

test('Worker restart preserves intake identity, watermarks and persisted captures without replay', async t => {
  const f = await fixture(t);
  let store = await f.open();
  const alpha = await store.request('channel.registerConnection', registration('acct-restart'));
  const conv = conversation('restart-group-1', 'group');
  const ensured = await store.request('channel.ensureConversation', { connectionId: alpha.connectionId, conversation: conv, reasonRef: 'synthetic:restart' });
  const created = (await store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: conv, events: [createEvent('restart-message')] })).results[0]!;
  const capture = await store.request('channel.captureAudience', { conversationRef: ensured.conversationRef });
  const watermark = await store.request('channel.watermark', {});
  await store.close();
  store = await f.open();
  assert.deepEqual(await store.request('channel.status', {}), { ready: true, schemaVersion: 1 });
  const reconnect = await store.request('channel.registerConnection', registration('acct-restart'));
  assert.equal(reconnect.connectionId, alpha.connectionId); assert.equal(reconnect.duplicate, true);
  const replay = await store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: conv, events: [createEvent('restart-message')] });
  assert.equal(replay.results[0]!.status, 'duplicate'); assert.equal(replay.results[0]!.messageId, created.messageId);
  assert.deepEqual(await store.request('channel.watermark', {}), watermark);
  const persisted = await store.request('channel.readContentRefs', { captureId: capture.captureId, messageIds: [created.messageId!] });
  assert.equal(persisted.content[0]!.bodyRef, 'native-body:restart-message');
  const next = await store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: conv, events: [createEvent('restart-message-2')] });
  assert.equal(next.results[0]!.intakeSeq, watermark.intakeSeq + 1);
});

test('persisted channel state holds no message body text and a tombstone clears the summary reference', async t => {
  const f = await fixture(t), store = await f.open();
  const body = 'SYNTHETIC_FULL_BODY_CANARY_NEVER_STORED_' + 'x'.repeat(32);
  const alpha = await store.request('channel.registerConnection', registration('acct-body'));
  const conv = conversation('body-group-1', 'group');
  const ensured = await store.request('channel.ensureConversation', { connectionId: alpha.connectionId, conversation: conv, reasonRef: 'synthetic:body' });
  const event = createEvent('body-message');
  event.content = { contentHash: sha(body), bodyRef: 'native-body:body-message', summary: 'SYNTHETIC_SUMMARY_CANARY_VISIBLE_ONCE', attachments: [] };
  const created = (await store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: conv, events: [event] })).results[0]!;
  const capture = await store.request('channel.captureAudience', { conversationRef: ensured.conversationRef });
  const exposed = await store.request('channel.readContentRefs', { captureId: capture.captureId, messageIds: [created.messageId!] });
  assert.equal(exposed.content[0]!.contentHash, sha(body));
  await store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: conv, events: [tombstoneEvent('body-message', 2, 'message.delete')] });
  await store.close();
  const persisted = allValues(f.filename);
  assert.ok(!persisted.includes(body), 'the full body text never reaches the control store');
  assert.ok(!persisted.includes('SYNTHETIC_SUMMARY_CANARY_VISIBLE_ONCE'), 'a tombstone clears the stored summary reference');
  assert.ok(persisted.includes(sha(body)), 'the content digest remains as deletion evidence');
});


test('concurrent Worker deliveries of one source event yield exactly one accepted fact and one audience CAS winner', async t => {
  const f = await fixture(t), store = await f.open();
  const alpha = await store.request('channel.registerConnection', registration('acct-concurrent'));
  const conv = conversation('concurrent-group-1', 'group');
  const ensured = await store.request('channel.ensureConversation', { connectionId: alpha.connectionId, conversation: conv, reasonRef: 'synthetic:concurrent' });
  const event = createEvent('concurrent-message', { nativeEventId: 'concurrent-native-event' });
  const receipts = await Promise.all(Array.from({ length: 10 }, () =>
    store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: conv, events: [event] })));
  assert.equal(receipts.filter(value => value.results[0]!.status === 'accepted').length, 1);
  assert.equal(receipts.filter(value => value.results[0]!.status === 'duplicate').length, 9);
  assert.equal(new Set(receipts.map(value => value.results[0]!.intakeSeq)).size, 1);
  assert.equal((await store.request('channel.watermark', {})).intakeSeq, 1);
  // Same expected audience version: exactly one CAS winner, the other observes the change.
  const results = await Promise.allSettled([
    store.request('channel.updateAudience', { conversationRef: ensured.conversationRef, participants: [{ nativeParticipantId: 'u1', kind: 'human' }],
      reasonRef: 'synthetic:cas-one', expectedAudienceVersion: 0 }),
    store.request('channel.updateAudience', { conversationRef: ensured.conversationRef, participants: [{ nativeParticipantId: 'u2', kind: 'human' }],
      reasonRef: 'synthetic:cas-two', expectedAudienceVersion: 0 }),
  ]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  const rejected = results.find(value => value.status === 'rejected') as PromiseRejectedResult;
  assert.equal((rejected.reason as { code?: string }).code, 'VERSION_CONFLICT');
  assert.equal((await store.request('channel.snapshot', {})).conversations[0]!.audienceVersion, 1);
});
