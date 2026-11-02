import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ConversationDomain, type LabChannelInput, type ConversationEventPort } from '../src/adapters/control-store/conversation-domain.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { ConversationError } from '../src/control/conversations/index.js';
import { sessionBindingKey } from '../src/adapters/dsh/sessions.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const channel: LabChannelInput = { connectionId: 'synthetic-connection', runId: 'run-one', channelId: 'direct-one', kind: 'direct', membersDigest: hash('owner+fixture') };
const hasCode = (code: string) => (error: unknown) => error instanceof ConversationError && error.code === code;
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx);
  let eventReads = 0;
  const forbidden = () => { throw new Error('Lab channel must not touch Tasks or Event delivery'); };
  const events: ConversationEventPort = { subscribe: forbidden, claim: forbidden, inspectClaim: forbidden, ack: forbidden, fail: forbidden,
    listSubscriptions: () => { eventReads++; return []; }, stats: () => { eventReads++; return { subscriptions: 0, pending: 0, claimed: 0, acknowledged: 0, failed: 0, cancelled: 0 } as ReturnType<ConversationEventPort['stats']>; } };
  const domain = new ConversationDomain(db, tx, { events, getTask: forbidden });
  return { db, tx, domain, watermark, reopen: () => new ConversationDomain(db, tx, { events, getTask: forbidden }), eventReads: () => eventReads };
}

test('trusted Lab channels require no Task, preserve stable binding, and are source tagged', t => {
  const f = fixture(t), first = f.domain.ensureLabChannel(channel), mark = f.watermark.read();
  assert.deepEqual(first.taskRefs, []); assert.deepEqual(first.subscriptionRefs, []);
  assert.deepEqual(first.source, { kind: 'lab', connectionId: channel.connectionId, runId: channel.runId, channelId: channel.channelId, membersDigest: channel.membersDigest });
  assert.deepEqual(f.domain.ensureLabChannel(channel), first); assert.deepEqual(f.watermark.read(), mark);
  assert.equal(f.eventReads(), 0); assert.equal(f.domain.replyContext(first.conversationId).businessId.length > 0, true);
  assert.deepEqual(f.domain.snapshotLocal({ conversationId: first.conversationId }).conversations, [first]);
  assert.deepEqual(f.watermark.read(), mark);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM shiyu_local_conversations').get()!.n, 0);
});

test('twenty direct/group channels and overlapping IDs across runs never share native businesses or allow active-owner takeover', t => {
  const f = fixture(t), entries = Array.from({ length: 20 }, (_, i) => f.domain.ensureLabChannel({ ...channel, channelId: `channel-${i}`, kind: i % 2 ? 'group' : 'direct' }));
  entries.push(f.domain.ensureLabChannel({ ...channel, channelId: 'channel-0', runId: 'other-run' }));
  assert.throws(() => f.domain.ensureLabChannel({ ...channel, channelId: 'channel-0', connectionId: 'other-connection' }), hasCode('LAB_CHANNEL_OWNED'));
  assert.equal(new Set(entries.map(entry => entry.conversationId)).size, 21);
  assert.equal(new Set(entries.map(entry => entry.bindingId)).size, 21);
  assert.equal(new Set(entries.map(entry => f.domain.replyContext(entry.conversationId).businessId)).size, 21);
});

test('new Lab input invalidates old generations idempotently without changing the native epoch', t => {
  const f = fixture(t), first = f.domain.ensureLabChannel(channel), context = f.domain.replyContext(first.conversationId);
  const { connectionId, runId, channelId } = channel;
  const next = f.domain.advanceLabInput({ connectionId, runId, channelId, eventId: 'input-1' });
  assert.ok(next.conversationGeneration > first.conversationGeneration); assert.equal(next.sessionEpoch, first.sessionEpoch);
  assert.equal(f.domain.replyContext(first.conversationId).businessId, context.businessId);
  const mark = f.watermark.read();
  assert.deepEqual(f.domain.advanceLabInput({ connectionId, runId, channelId, eventId: 'input-1' }), next);
  assert.deepEqual(f.watermark.read(), mark);
});

test('membership change retires one native epoch while pause only invalidates drafts', t => {
  const f = fixture(t), first = f.domain.ensureLabChannel(channel), context = f.domain.replyContext(first.conversationId);
  const second = f.domain.ensureLabChannel({ ...channel, membersDigest: hash('new membership') });
  assert.equal(second.conversationId, first.conversationId); assert.equal(second.bindingId, first.bindingId);
  assert.equal(second.audienceVersion, first.audienceVersion + 1); assert.equal(second.sessionEpoch, first.sessionEpoch + 1);
  assert.notEqual(f.domain.replyContext(first.conversationId).businessId, context.businessId);
  assert.deepEqual(f.domain.ensureLabChannel({ ...channel, membersDigest: hash('new membership') }), second);
  const { connectionId, runId, channelId } = channel;
  const retired = f.domain.retireLabChannel({ connectionId, runId, channelId, reasonRef: 'disconnect-one' });
  assert.equal(retired.sessionEpoch, second.sessionEpoch); assert.equal(retired.audienceVersion, second.audienceVersion);
  assert.ok(retired.conversationGeneration > second.conversationGeneration);
  const mark = f.watermark.read();
  assert.deepEqual(f.domain.retireLabChannel({ connectionId, runId, channelId, reasonRef: 'disconnect-one' }), retired);
  assert.deepEqual(f.watermark.read(), mark);
});

test('pause, explicit reconnect and host reconstruction reuse the native Session while old callbacks cannot touch the new owner', t => {
  const f = fixture(t), first = f.domain.ensureLabChannel(channel);
  const admitted = f.domain.execute({ command: 'conversation.reply.admit', args: { conversationId: first.conversationId, inputId: 'owner-message', inputHash: hash('synthetic') } }) as { operation: { operationId: string } };
  const context = f.domain.replyContext(first.conversationId), capture = { captureId: 'synthetic-capture', expiresAt: new Date(Date.now() + 30000).toISOString(), context };
  f.domain.setReplyAuthority({ validateCapture() { return capture; } });
  const prepared = f.domain.execute({ command: 'conversation.reply.prepare', args: { operationId: admitted.operation.operationId, captureId: capture.captureId, viewId: 'synthetic-view', loadedTaskIds: [] } }) as { contextTokenId: string };
  f.domain.execute({ command: 'conversation.reply.bind', args: { binding: { operationId: admitted.operation.operationId, contextTokenId: prepared.contextTokenId,
    sessionEpoch: context.token.sessionEpoch, key: sessionBindingKey('replyer', context.businessId, 'local-owner'), businessId: context.businessId, scope: 'local-owner',
    sessionId: 'shiyu-replyer-persisted-lab', messageId: 'synthetic-message', messageHash: hash('native synthetic input') } } });
  const key = { connectionId: channel.connectionId, runId: channel.runId, channelId: channel.channelId };
  f.domain.retireLabChannel({ ...key, reasonRef: 'owner-pause' });
  const nextOwner = { ...channel, connectionId: 'new-owner' }, next = f.domain.ensureLabChannel(nextOwner), reused = f.domain.replyContext(next.conversationId);
  assert.equal(next.conversationId, first.conversationId); assert.equal(next.bindingId, first.bindingId);
  assert.equal(reused.businessId, context.businessId); assert.equal(reused.token.sessionEpoch, context.token.sessionEpoch); assert.equal(reused.sessionId, 'shiyu-replyer-persisted-lab');
  const before = f.watermark.read();
  assert.deepEqual(f.domain.retireLabChannel({ ...key, reasonRef: 'late-old-disconnect' }), next);
  assert.deepEqual(f.watermark.read(), before);
  assert.throws(() => f.domain.advanceLabInput({ ...key, eventId: 'late-old-input' }), hasCode('STALE_LAB_CONNECTION'));
  const reopened = f.reopen(); reopened.retireLabChannel({ ...key, connectionId: nextOwner.connectionId, reasonRef: 'host-restart' });
  const attached = reopened.ensureLabChannel({ ...channel, connectionId: 'after-host-restart' }), restored = reopened.replyContext(attached.conversationId);
  assert.equal(restored.businessId, reused.businessId); assert.equal(restored.sessionId, reused.sessionId); assert.equal(restored.token.sessionEpoch, reused.token.sessionEpoch);
});

test('Lab channel schema and identity changes fail before creating an alternate source binding', t => {
  const f = fixture(t); f.domain.ensureLabChannel(channel);
  assert.throws(() => f.domain.ensureLabChannel({ ...channel, kind: 'group' }), hasCode('IDEMPOTENCY_CONFLICT'));
  for (const invalid of [{ ...channel, membersDigest: 'bad' }, { ...channel, runId: '' }, { ...channel, scope: 'foreign' }, { ...channel, taskId: 'fake' }]) {
    assert.throws(() => f.domain.ensureLabChannel(invalid as LabChannelInput), hasCode('INVALID_SCHEMA'));
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM shiyu_lab_conversations').get()!.n, 1);
  assert.throws(() => f.domain.ensureLocalTask({ taskId: 'direct-one', localConversationKey: 'direct-one' }), /must not touch Tasks/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM shiyu_local_conversations').get()!.n, 0);
});
