import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { ConversationDomain, CONVERSATION_BACKGROUND_HANDLER, conversationEventPrincipal, type ConversationEventPort } from '../src/adapters/control-store/conversation-domain.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import type { TaskView } from '../src/control/tasks/index.js';
import { EventService } from '../src/control/events/index.js';
import { SHIYU_EVENT_TYPES, type EventPrincipal, type StoredDelivery, type StoredEvent, type StoredSubscription } from '../src/contracts/events.js';

const CONTENT = 'Synthetic background integration data; no model or native Session is invoked.';
const principal = conversationEventPrincipal();
const taskPublisher: EventPrincipal = { principalId: 'task-service', kind: 'component', scopes: ['local-owner'], publishTypes: ['task.succeeded'], subscribeTypes: ['task.succeeded'], targetRefs: [] };
const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
async function fixture(t: TestContext, handlers = [CONVERSATION_BACKGROUND_HANDLER]) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-conversation-domain-')), filename = join(directory, 'control.sqlite');
  const stores: ControlStore[] = [];
  const open = async () => {
    const store = await ControlStore.open({ filename, eventTypes: SHIYU_EVENT_TYPES, componentHandlers: handlers,
      runtimeIdentity: { hostEpoch: 'synthetic-host', installationGeneration: 'synthetic-installation' } });
    stores.push(store); return { store, events: new EventService(store) };
  };
  t.after(async () => { await Promise.all(stores.map(store => store.close())); await rm(directory, { recursive: true, force: true }); });
  return { ...await open(), open, filename };
}
async function task(store: ControlStore, requestId = 'task-one') {
  return (await store.request('task.createLocal', { requestId, title: 'Synthetic task', content: CONTENT })).task;
}
/** Uses trusted synthetic evidence through real Task/Effect commands. No filesystem action or native model/session port. */
async function complete(store: ControlStore, taskId: string) {
  const plan = await store.request('task.claimAssignment', { taskId });
  const permit = plan.permit;
  await store.request('task.bindAssignment', { permit, sessionId: `synthetic-reference-${taskId}` });
  await store.request('task.assignmentStarted', { permit });
  const artifact = await store.request('task.enqueueArtifact', { permit, content: CONTENT });
  const claim = await store.request('task.claimEffect', { permit, effectId: artifact.effect.effectId });
  assert.ok(claim);
  await store.request('task.assertEffect', { permit, claim });
  await store.request('task.recordArtifactReceipt', { permit, claim, observedSha256: artifact.payload.sha256,
    observedBytes: artifact.payload.byteLength, receiptId: `synthetic-receipt-${taskId}`, observedAt: new Date().toISOString() });
  await store.request('task.settleUsage', { permit, calls: 0, usage: { status: 'reported', inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  await store.request('task.report', { permit, state: 'ready', summary: 'Synthetic receipt available for independent verifier.' });
  const result = await store.request('task.verify', { taskId }); assert.equal(result.state, 'succeeded'); return result;
}
function readRows(filename: string, sql: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

test('one verified completion fans out to two local contexts and one event receipt without model work', async t => {
  const { store, events } = await fixture(t), localTask = await task(store);
  const a = await store.request('conversation.ensureLocalTask', { taskId: localTask.taskId, localConversationKey: 'local_a' });
  const b = await store.request('conversation.ensureLocalTask', { taskId: localTask.taskId, localConversationKey: 'local_b' });
  assert.notEqual(a.conversationId, b.conversationId); assert.notEqual(a.bindingId, b.bindingId);
  assert.equal((await events.listSubscriptions(principal)).length, 1);
  await complete(store, localTask.taskId);
  const before = await store.request('conversation.snapshotLocal', {});
  assert.equal(before.background.pending, 1); assert.ok(before.conversations.every(value => value.contextVersion === 0));
  const beforeConsume = await store.request('control.watermark', {});
  const consumed = await store.request('conversation.consumeBackground', { limit: 2 });
  assert.deepEqual([consumed.claimed, consumed.acknowledged, consumed.failed], [1, 1, 0]);
  // One persisted claim plus one atomic fanout-and-ack write; nested saves do not count separately.
  assert.equal((await store.request('control.watermark', {})).commitSeq, beforeConsume.commitSeq + 2);
  const after = await store.request('conversation.snapshotLocal', {});
  assert.equal(after.background.acknowledged, 1);
  for (const entry of after.conversations) {
    assert.equal(entry.contextVersion, 1); assert.equal(entry.pending.length, 1); assert.equal(entry.sources[0].sourceVersion, 1);
    assert.equal(entry.needsSync, true); assert.equal(entry.taskRefs[0].state, 'succeeded');
    assert.equal(entry.conversationGeneration, entry.conversationId === a.conversationId ? a.conversationGeneration : b.conversationGeneration);
  }
  assert.equal((await store.request('conversation.consumeBackground', {})).claimed, 0);
  assert.deepEqual((await store.request('conversation.snapshotLocal', {})).conversations, after.conversations);
  assert.equal((await store.request('control.watermark', {})).commitSeq, beforeConsume.commitSeq + 2);
});

test('ensure is stable, takes only local keys and does not create tasks or duplicate subscriptions', async t => {
  const { store, events } = await fixture(t), localTask = await task(store);
  const first = await store.request('conversation.ensureLocalTask', { taskId: localTask.taskId });
  const beforeRetry = await store.request('control.watermark', {});
  const again = await store.request('conversation.ensureLocalTask', { taskId: localTask.taskId });
  assert.deepEqual(again, first); assert.equal(first.localConversationKey, localTask.taskId);
  assert.deepEqual(await store.request('control.watermark', {}), beforeRetry);
  assert.equal((await store.request('task.list', {})).length, 1); assert.equal((await events.listSubscriptions(principal)).length, 1);
  for (const extra of [{ scope: 'other-private' }, { actor: taskPublisher }, { sourceVersion: 9 }, { event: { type: 'task.succeeded' } }]) {
    await assert.rejects(store.request('conversation.ensureLocalTask', { taskId: localTask.taskId, ...extra } as never), code('INVALID_SCHEMA'));
  }
  for (const localConversationKey of ['', 'spaces are forbidden', '../private', 'x'.repeat(101)]) {
    await assert.rejects(store.request('conversation.ensureLocalTask', { taskId: localTask.taskId, localConversationKey }), code('INVALID_SCHEMA'));
  }
  await assert.rejects(store.request('conversation.ensureLocalTask', { taskId: 'unknown' }), code('UNKNOWN_TASK'));
  await assert.rejects(store.request('conversation.consumeBackground', { limit: 21 }), code('INVALID_SCHEMA'));
  await assert.rejects(store.request('conversation.consumeBackground', { principal } as never), code('INVALID_SCHEMA'));
});

test('a completion accepted before the first local association is replayed with visible bounded replay metadata', async t => {
  const { store, events } = await fixture(t), localTask = await task(store); await complete(store, localTask.taskId);
  // Additional trusted envelope is synthetic backlog, not a second change to Task state.
  await events.publish(taskPublisher, { type: 'task.succeeded', scope: 'local-owner', payload: { taskId: localTask.taskId }, idempotencyKey: 'synthetic-extra-completion-envelope' });
  const entry = await store.request('conversation.ensureLocalTask', { taskId: localTask.taskId });
  assert.equal(entry.subscriptionRefs[0].replayedCount, 1); assert.equal(entry.subscriptionRefs[0].replayTruncated, true);
  assert.equal((await store.request('conversation.snapshotLocal', {})).background.pending, 1);
  await store.request('conversation.consumeBackground', {});
  const final = (await store.request('conversation.snapshotLocal', { conversationId: entry.conversationId })).conversations[0];
  assert.equal(final.contextVersion, 1); assert.equal(final.subscriptionRefs[0].replayTruncated, true);
});

test('a new binding after another consumed the event retains initial source synchronization even with no pending increment', async t => {
  const { store } = await fixture(t), localTask = await task(store);
  const a = await store.request('conversation.ensureLocalTask', { taskId: localTask.taskId, localConversationKey: 'early' });
  await complete(store, localTask.taskId); await store.request('conversation.consumeBackground', {});
  const b = await store.request('conversation.ensureLocalTask', { taskId: localTask.taskId, localConversationKey: 'late' });
  assert.equal(b.pending.length, 0); assert.equal(b.contextVersion, 0);
  assert.deepEqual(b.sources, [{ reference: { kind: 'task', id: localTask.taskId }, sourceVersion: 1 }]); assert.equal(b.needsSync, true);
  assert.equal((await store.request('conversation.consumeBackground', {})).claimed, 0);
  const again = await store.request('conversation.snapshotLocal', {});
  assert.equal(again.conversations.find(entry => entry.conversationId === a.conversationId)!.contextVersion, 1);
  assert.equal(again.conversations.find(entry => entry.conversationId === b.conversationId)!.needsSync, true);
});

test('redelivery of the same stored event acknowledges another delivery without another context increment', async t => {
  const { store, events } = await fixture(t), localTask = await task(store);
  await store.request('conversation.ensureLocalTask', { taskId: localTask.taskId }); await complete(store, localTask.taskId);
  await store.request('conversation.consumeBackground', {});
  await events.subscribe(principal, { id: 'synthetic-replay-subscription', types: ['task.succeeded'], scope: 'local-owner',
    target: { kind: 'component', handlerRef: CONVERSATION_BACKGROUND_HANDLER }, deliveryMode: 'component',
    start: { kind: 'replay', afterSequence: 0, limit: 1 }, filter: { taskId: localTask.taskId } });
  const duplicate = await store.request('conversation.consumeBackground', {});
  assert.deepEqual([duplicate.claimed, duplicate.acknowledged, duplicate.duplicate, duplicate.failed], [1, 1, 1, 0]);
  const snapshot = await store.request('conversation.snapshotLocal', {});
  assert.equal(snapshot.conversations[0].contextVersion, 1); assert.equal(snapshot.conversations[0].pending.length, 1);
  assert.equal(snapshot.background.acknowledged, 2);
});

test('an envelope claiming success cannot project a Task that has not independently succeeded', async t => {
  const { store, events } = await fixture(t), localTask = await task(store);
  await store.request('conversation.ensureLocalTask', { taskId: localTask.taskId });
  await events.publish(taskPublisher, { type: 'task.succeeded', scope: 'local-owner', payload: { taskId: localTask.taskId }, idempotencyKey: 'unverified-envelope' });
  const result = await store.request('conversation.consumeBackground', {});
  assert.deepEqual([result.claimed, result.acknowledged, result.failed], [1, 0, 1]);
  assert.equal(result.deliveries[0].status, 'retrying'); assert.equal(result.deliveries[0].errorCode, 'UNVERIFIED_TASK');
  const snapshot = await store.request('conversation.snapshotLocal', {});
  assert.equal(snapshot.conversations[0].contextVersion, 0); assert.deepEqual(snapshot.conversations[0].pending, []);
  assert.equal((await events.listDeliveries(principal))[0].attempts, 1);
  assert.equal((await store.request('task.get', { taskId: localTask.taskId })).task.state, 'queued');
});

test('expired claimed work survives Worker reopening and old tokens cannot acknowledge the recovered delivery', async t => {
  const h = await fixture(t), localTask = await task(h.store);
  const original = await h.store.request('conversation.ensureLocalTask', { taskId: localTask.taskId }); await complete(h.store, localTask.taskId);
  const [old] = await h.events.claim(principal, { consumerId: 'synthetic-interrupted-consumer', deliveryMode: 'component', leaseMs: 1 });
  await h.store.close(); await delay(5);
  const next = await h.open();
  assert.equal((await next.store.request('conversation.ensureLocalTask', { taskId: localTask.taskId })).bindingId, original.bindingId);
  const result = await next.store.request('conversation.consumeBackground', {});
  assert.equal(result.acknowledged, 1); assert.equal((await next.events.listDeliveries(principal))[0].attempts, 2);
  await assert.rejects(next.events.ack(principal, { deliveryId: old.deliveryId, claimToken: old.claimToken }), code('STALE_CLAIM'));
  assert.equal((await next.store.request('conversation.snapshotLocal', {})).conversations[0].contextVersion, 1);
});

test('a cancelled subscription claim cannot mutate a context and snapshot reads leave all synchronization markers untouched', async t => {
  const h = await fixture(t), localTask = await task(h.store);
  const entry = await h.store.request('conversation.ensureLocalTask', { taskId: localTask.taskId }); await complete(h.store, localTask.taskId);
  const [claimed] = await h.events.claim(principal, { consumerId: 'held', deliveryMode: 'component' });
  const [sub] = await h.events.listSubscriptions(principal); await h.events.unsubscribe(principal, sub.id, sub.revision);
  await assert.rejects(h.events.ack(principal, claimed), code('STALE_CLAIM'));
  assert.equal((await h.store.request('conversation.consumeBackground', {})).claimed, 0);
  const before = readRows(h.filename, 'SELECT record_json FROM shiyu_reply_bindings ORDER BY id');
  const watermark = await h.store.request('control.watermark', {});
  for (let count = 0; count < 3; count++) {
    const state = await h.store.request('conversation.snapshotLocal', { conversationId: entry.conversationId });
    assert.equal(state.conversations[0].contextVersion, 0); assert.equal(state.conversations[0].needsSync, true);
  }
  assert.deepEqual(readRows(h.filename, 'SELECT record_json FROM shiyu_reply_bindings ORDER BY id'), before);
  assert.deepEqual(await h.store.request('control.watermark', {}), watermark);
  assert.equal(readRows(h.filename, 'SELECT * FROM shiyu_reply_source_cursors').length, 0);
  assert.equal(readRows(h.filename, 'SELECT * FROM shiyu_reply_sessions').length, 0);
});

test('the 64-conversation limit rejects a new binding atomically while allowing existing bindings', async t => {
  const { store } = await fixture(t), localTask = await task(store);
  for (let index = 0; index < 64; index++) await store.request('conversation.ensureLocalTask', { taskId: localTask.taskId, localConversationKey: `local_${index}` });
  await assert.rejects(store.request('conversation.ensureLocalTask', { taskId: localTask.taskId, localConversationKey: 'overflow' }), code('CONVERSATION_CAPACITY'));
  assert.equal((await store.request('conversation.snapshotLocal', {})).conversations.length, 64);
  assert.equal((await store.request('conversation.ensureLocalTask', { taskId: localTask.taskId, localConversationKey: 'local_0' })).localConversationKey, 'local_0');
});

test('a missing registered handler rolls back all business binding writes', async t => {
  const h = await fixture(t, []), localTask = await task(h.store);
  await assert.rejects(h.store.request('conversation.ensureLocalTask', { taskId: localTask.taskId }), code('FORBIDDEN'));
  assert.equal((await h.store.request('conversation.snapshotLocal', {})).conversations.length, 0);
  assert.equal(readRows(h.filename, 'SELECT * FROM shiyu_conversations').length, 0);
  assert.equal(readRows(h.filename, 'SELECT * FROM shiyu_topics').length, 0);
});

test('an injected failure after the ack write rolls back both contexts and ack, while preserving claim attempts', () => {
  const db = new DatabaseSync(':memory:'), tx = new SqliteTransactions(db);
  try {
    tx.atomic(() => db.exec("CREATE TABLE fixture_delivery(status TEXT,attempts INTEGER); INSERT INTO fixture_delivery VALUES('pending',0)"));
    const stamp = new Date().toISOString();
    const event: StoredEvent = { eventId: 'success-event', sequence: 1, type: 'task.succeeded', schemaVersion: 1, scope: 'local-owner',
      actor: { principalId: 'task-service', kind: 'component' }, payload: { taskId: 'task-1' }, receivedAt: stamp, correlationId: 'fixture' };
    const base = { deliveryId: 'delivery-1', eventId: event.eventId, subscriptionId: 'conversation-task-success:task-1', ruleRevision: 1, activationGeneration: 1,
      target: { kind: 'component' as const, handlerRef: CONVERSATION_BACKGROUND_HANDLER }, deliveryMode: 'component' as const, availableAt: stamp };
    const row = () => db.prepare('SELECT * FROM fixture_delivery').get() as { status: StoredDelivery['status']; attempts: number };
    const current = (): StoredDelivery => ({ ...base, ...row() });
    const subscriptions: StoredSubscription[] = []; let failAck = true;
    const events: ConversationEventPort = {
      subscribe(input) {
        if (!subscriptions.length) subscriptions.push({ ...input, id: input.id!, ownerId: principal.principalId, revision: 1, ruleRevision: 1, activationGeneration: 1,
          status: 'active', startSequence: 0, createdAt: stamp, updatedAt: stamp, replayedCount: 1, replayTruncated: false });
        return subscriptions[0];
      },
      listSubscriptions: () => subscriptions,
      stats() { const value = row(); return { events: 1, subscriptions: 1, pending: +(value.status === 'pending'), claimed: +(value.status === 'claimed'),
        acknowledged: +(value.status === 'acked'), failed: 0, cancelled: 0 }; },
      claim: () => tx.atomic(() => {
        if (row().status !== 'pending') return [];
        db.exec("UPDATE fixture_delivery SET status='claimed',attempts=attempts+1");
        return [{ ...current(), status: 'claimed' as const, claimToken: 'fixture-token', event }];
      }),
      inspectClaim() { assert.equal(row().status, 'claimed'); return { delivery: current(), event }; },
      ack: () => tx.atomic(() => {
        db.exec("UPDATE fixture_delivery SET status='acked'");
        if (failAck) throw new Error('Injected failure after ack write');
        return current();
      }),
      fail: () => tx.atomic(() => { db.exec("UPDATE fixture_delivery SET status='pending'"); return current(); }),
    };
    const domain = new ConversationDomain(db, tx, { events, getTask: taskId => ({ taskId, state: 'succeeded', version: 7 } as TaskView) });
    domain.ensureLocalTask({ taskId: 'task-1', localConversationKey: 'a' }); domain.ensureLocalTask({ taskId: 'task-1', localConversationKey: 'b' });
    const failed = domain.consumeBackground({});
    assert.deepEqual([failed.claimed, failed.acknowledged, failed.failed], [1, 0, 1]);
    assert.equal(row().status, 'pending'); assert.equal(row().attempts, 1);
    assert.ok(domain.snapshotLocal({}).conversations.every(entry => entry.contextVersion === 0 && entry.pending.length === 0));
    assert.equal(db.prepare('SELECT count(*) AS count FROM shiyu_background_events').get()!.count, 0);
    failAck = false;
    const retried = domain.consumeBackground({}); assert.equal(retried.acknowledged, 1);
    assert.equal(row().attempts, 2); assert.equal(row().status, 'acked');
    assert.ok(domain.snapshotLocal({}).conversations.every(entry => entry.contextVersion === 1 && entry.pending.length === 1 && entry.needsSync));
  } finally { db.close(); }
});
