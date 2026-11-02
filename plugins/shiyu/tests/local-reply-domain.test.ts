import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { LocalReplyDomain, type LocalReplyCapture, type LocalReplyContextReceipt, type LocalReplyNativeBinding, type LocalReplyOperation } from '../src/adapters/control-store/local-reply-domain.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { sessionBindingKey } from '../src/adapters/dsh/sessions.js';
import { ConversationError, ConversationStore, type ConversationActor, type ContextToken } from '../src/control/conversations/index.js';

const owner: ConversationActor = { principalId: 'local-owner', kind: 'owner', scopes: ['local-owner'] };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof ConversationError && error.code === expected;
const strong = (token: ContextToken) => [token.bindingId, token.conversationId, token.scope, token.audienceVersion, token.conversationGeneration, token.routingRevision, token.sessionEpoch];

function fixture(t: TestContext, persistent = false) {
  const directory = persistent ? mkdtempSync(join(tmpdir(), 'shiyu-local-reply-')) : undefined;
  const filename = directory ? join(directory, 'control.sqlite') : ':memory:';
  const handles: DatabaseSync[] = [];
  const revoked = new Set<string>();
  let time = Date.UTC(2026, 10, 2, 12);
  const taskVersions = new Map([['task-a', 6], ['task-b', 2]]);
  const captures = new Map<string, { capture: LocalReplyCapture; versions: Map<string, number> }>();
  let bindingId = '';
  const open = () => {
    const db = new DatabaseSync(filename); handles.push(db);
    const tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx);
    const store = new ConversationStore(db, tx, { ownerIds: [owner.principalId], componentPermissions: {}, now: () => new Date(time),
      authorizeReference: ({ scope, reference }) => scope === 'local-owner' && taskVersions.has(reference.id) && !revoked.has(reference.id) });
    const bindingFor = (conversationId: string) => {
      const binding = store.getReplyBinding(owner, bindingId);
      if (binding.conversationId !== conversationId) throw new ConversationError('UNKNOWN_CONVERSATION', 'Not the fixture conversation');
      return binding;
    };
    const domain = new LocalReplyDomain(db, tx, { conversations: store, bindingFor, now: () => new Date(time) });
    domain.setAuthority({ validateCapture(captureId, phase) {
      const saved = captures.get(captureId);
      if (!saved) throw new ConversationError('UNKNOWN_CAPTURE', 'Missing capture');
      if (Date.parse(saved.capture.expiresAt) <= time) throw new ConversationError('EXPIRED', 'Capture expired');
      const current = store.contextSnapshot(owner, saved.capture.context.token.bindingId);
      if (JSON.stringify(strong(current.token)) !== JSON.stringify(strong(saved.capture.context.token))) throw new ConversationError('STALE_CONTEXT', 'Strong version changed');
      if (saved.capture.context.sources.some(source => revoked.has(source.reference.id))) throw new ConversationError('FORBIDDEN_REFERENCE', 'Source revoked');
      if (phase !== 'ack' && [...saved.versions].some(([id, version]) => taskVersions.get(id) !== version)) throw new ConversationError('VIEW_INVALIDATED', 'Task revision changed');
      return structuredClone(saved.capture);
    } });
    return { db, tx, store, domain, watermark, bindingFor };
  };
  const h = open();
  const conversation = h.store.ensureConversation(owner, { connectionId: 'local-synthetic', platformConversationId: 'chat', kind: 'direct', scope: 'local-owner' });
  const topic = h.store.createTopic(owner, { topicId: 'topic', scope: 'local-owner' });
  h.store.linkTopic(owner, { conversationId: conversation.conversationId, topicId: topic.topicId, expectedConversationRevision: conversation.revision, expectedTopicRevision: topic.revision });
  const binding = h.store.ensureReplyBinding(owner, { conversationId: conversation.conversationId, topicId: topic.topicId }); bindingId = binding.bindingId;
  const link = (taskId: string) => h.store.linkReference(owner, { topicId: topic.topicId, expectedRevision: h.store.getTopic(owner, topic.topicId).revision, reference: { kind: 'task', id: taskId } });
  link('task-a');
  const update = (version: number, taskId = 'task-a') => h.store.recordBackgroundUpdate(owner, { eventId: `${taskId}-v${version}`, scope: 'local-owner', reference: { kind: 'task', id: taskId }, sourceVersion: version, evidenceRef: `event:${taskId}-v${version}` });
  const capture = () => {
    const current = h.bindingFor(conversation.conversationId);
    const value: LocalReplyCapture = { captureId: randomUUID(), expiresAt: new Date(time + 30000).toISOString(),
      context: { ...h.store.contextSnapshot(owner, bindingId), businessId: current.businessId, ...(current.sessionId ? { sessionId: current.sessionId } : {}) } };
    captures.set(value.captureId, { capture: structuredClone(value), versions: new Map(value.context.sources.map(source => [source.reference.id, taskVersions.get(source.reference.id)!])) });
    return value;
  };
  const admit = (inputId: string = randomUUID(), text = 'synthetic input') => h.domain.admit({ conversationId: conversation.conversationId, inputId, inputHash: hash(text) });
  const prepare = (inputId?: string) => {
    const { operation } = admit(inputId); const captured = capture();
    return h.domain.prepare({ operationId: operation.operationId, captureId: captured.captureId, viewId: randomUUID(), loadedTaskIds: ['task-a'] });
  };
  const native = (operation: LocalReplyOperation, sessionId = operation.expectedSessionId ?? 'shiyu-replyer-native') : LocalReplyNativeBinding => ({
    operationId: operation.operationId, contextTokenId: operation.contextTokenId!, sessionEpoch: operation.sessionEpoch,
    key: sessionBindingKey('replyer', operation.businessId, operation.scope), businessId: operation.businessId, scope: operation.scope,
    sessionId, messageId: `message-${operation.operationId}`, messageHash: hash(`prompt-${operation.operationId}`),
  });
  const receipt = (value: LocalReplyNativeBinding): LocalReplyContextReceipt => ({ ...value, userMessageSeq: 4, confirmedAt: new Date(time).toISOString(), durability: 'confirmed' });
  const dispatch = (inputId?: string) => { const prepared = prepare(inputId), value = native(prepared); h.domain.bind({ binding: value }); return { prepared, native: value }; };
  const complete = () => {
    const value = dispatch(); h.domain.contextDurable({ receipt: receipt(value.native) });
    const assistantRef = { sessionId: value.native.sessionId, eventSeq: 6, messageId: 'assistant-a' };
    return { ...value, assistantRef, ready: h.domain.ready({ operationId: value.prepared.operationId, assistantRef }) };
  };
  t.after(() => { for (const db of handles) { try { db.close(); } catch {} } if (directory) rmSync(directory, { recursive: true, force: true }); });
  return { ...h, conversation, binding, revoked, taskVersions, captures, open, link, update, capture, admit, prepare, native, receipt, dispatch, complete,
    advanceTime(ms: number) { time += ms; } };
}

test('input identity is content-bound, duplicates do not advance generation, and archived inputs are refused', t => {
  const h = fixture(t), before = h.store.version(owner, h.binding.bindingId);
  const first = h.admit('same-input', 'one');
  const seq = h.watermark.read().commitSeq;
  assert.equal(first.duplicate, false); assert.equal(first.operation.token.conversationGeneration, before.conversationGeneration + 1);
  assert.deepEqual(h.admit('same-input', 'one'), { duplicate: true, operation: first.operation });
  assert.equal(h.watermark.read().commitSeq, seq);
  assert.throws(() => h.admit('same-input', 'changed'), code('IDEMPOTENCY_CONFLICT'));
  const current = h.store.getConversation(owner, h.conversation.conversationId);
  h.store.setArchived(owner, { conversationId: current.conversationId, expectedRevision: current.revision, archived: true });
  assert.throws(() => h.admit('archived'), code('INACTIVE_BINDING'));
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM shiyu_local_reply_inputs').get()!.n, 1);
});

test('prepare cannot attach an old capture to a newer admitted generation or unrelated loaded source', t => {
  const h = fixture(t), old = h.admit('old').operation, oldCapture = h.capture();
  const current = h.admit('new').operation, currentCapture = h.capture();
  assert.throws(() => h.domain.prepare({ operationId: old.operationId, captureId: currentCapture.captureId, viewId: 'view-old', loadedTaskIds: ['task-a'] }), code('STALE_CONTEXT'));
  assert.throws(() => h.domain.prepare({ operationId: current.operationId, captureId: oldCapture.captureId, viewId: 'view-new', loadedTaskIds: ['task-a'] }), code('STALE_CONTEXT'));
  assert.throws(() => h.domain.prepare({ operationId: current.operationId, captureId: currentCapture.captureId, viewId: 'view-new', loadedTaskIds: ['task-b'] }), code('FORBIDDEN_REFERENCE'));
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM shiyu_reply_drafts').get()!.n, 0);
});

test('background binding revisions do not replace a stable native Session and a new input only advances generation', t => {
  const h = fixture(t); h.update(1);
  const prepared = h.prepare('first'), value = h.native(prepared);
  h.link('task-b'); // A routing change is a strong invalidation, not a harmless binding revision.
  assert.throws(() => h.domain.bind({ binding: value }), code('STALE_CONTEXT'));
  const first = h.prepare('second'), secondNative = h.native(first);
  h.update(1, 'task-b'); // Unrelated background only changes binding/context revisions.
  h.domain.bind({ binding: secondNative }); h.domain.contextDurable({ receipt: h.receipt(secondNative) });
  h.domain.ready({ operationId: first.operationId, assistantRef: { sessionId: secondNative.sessionId, eventSeq: 6, messageId: 'assistant-a' } });
  const next = h.prepare('third');
  assert.equal(next.expectedSessionId, secondNative.sessionId); assert.equal(next.businessId, first.businessId); assert.equal(next.sessionEpoch, first.sessionEpoch);
  assert.ok(next.token.conversationGeneration > first.token.conversationGeneration);
  const wrong = h.native(next, 'shiyu-replyer-replacement');
  assert.throws(() => h.domain.bind({ binding: wrong }), code('SESSION_BINDING_CONFLICT'));
  h.domain.bind({ binding: h.native(next) });
  assert.equal(h.store.getReplyBinding(owner, h.binding.bindingId).sessionId, secondNative.sessionId);
});

test('durable old context confirms only captured sources and preserves newer pending background', t => {
  const h = fixture(t); h.update(1); h.link('task-b'); h.update(1, 'task-b');
  const { prepared, native } = h.dispatch(); h.update(2);
  const result = h.domain.contextDurable({ receipt: h.receipt(native) });
  assert.equal(result.durability, 'confirmed');
  const context = h.store.contextSnapshot(owner, h.binding.bindingId);
  assert.equal(context.needsSync, true); assert.equal(context.pending.length, 2);
  assert.equal(context.pending.find(item => item.reference.id === 'task-a')!.sourceVersion, 2);
  const cursors = h.db.prepare('SELECT ref_key,source_version FROM shiyu_reply_source_cursors').all();
  assert.equal(cursors.length, 1); assert.equal(cursors[0].source_version, 1);
  assert.throws(() => h.domain.ready({ operationId: prepared.operationId, assistantRef: { sessionId: native.sessionId, eventSeq: 6, messageId: 'assistant-old' } }), code('STALE_DRAFT'));
});

test('context receipts reject forged scope, mismatched native evidence, new generation and changed audience', t => {
  const h = fixture(t); h.update(1); const first = h.dispatch();
  assert.throws(() => h.domain.contextDurable({ receipt: { ...h.receipt(first.native), scope: 'foreign' } }), code('INVALID_SCHEMA'));
  assert.throws(() => h.domain.contextDurable({ receipt: { ...h.receipt(first.native), messageHash: hash('other') } }), code('REPLY_NOT_ACTIVE'));
  h.admit('superseding');
  assert.throws(() => h.domain.contextDurable({ receipt: h.receipt(first.native) }), code('STALE_CONTEXT'));
  const second = h.dispatch();
  const conversation = h.store.getConversation(owner, h.conversation.conversationId);
  h.store.invalidateAudience(owner, { conversationId: conversation.conversationId, expectedRevision: conversation.revision, reasonRef: 'policy:audience-narrowed' });
  assert.throws(() => h.domain.contextDurable({ receipt: h.receipt(second.native) }), code('STALE_CONTEXT'));
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM shiyu_reply_source_cursors').get()!.n, 0);
  assert.equal(h.domain.get({ operationId: second.prepared.operationId }).durability, 'unconfirmed');
});

test('current Task revision and view expiry block release independently of a confirmed context load', t => {
  const h = fixture(t); h.update(1); const first = h.dispatch();
  h.taskVersions.set('task-a', 7);
  h.domain.contextDurable({ receipt: h.receipt(first.native) }); // The old snapshot was durably loaded even though its answer is now stale.
  assert.throws(() => h.domain.ready({ operationId: first.prepared.operationId, assistantRef: { sessionId: first.native.sessionId, eventSeq: 6, messageId: 'assistant-a' } }), code('VIEW_INVALIDATED'));
  h.domain.fail({ operationId: first.prepared.operationId, status: 'failed', reasonCode: 'STALE_VIEW' });
  const second = h.dispatch(); h.advanceTime(30000);
  assert.throws(() => h.domain.contextDurable({ receipt: h.receipt(second.native) }), code('EXPIRED'));
  assert.equal(h.domain.get({ operationId: first.prepared.operationId }).durability, 'confirmed');
  assert.equal(h.domain.get({ operationId: second.prepared.operationId }).durability, 'unconfirmed');
});

test('late receipt persistence failure rolls back source acknowledgement and its commit watermark together', t => {
  const h = fixture(t); h.update(1); const { prepared, native } = h.dispatch();
  const before = h.store.contextSnapshot(owner, h.binding.bindingId), sequence = h.watermark.read().commitSeq;
  const originalPrepare = h.db.prepare.bind(h.db);
  h.db.prepare = (sql: string) => {
    if (sql.startsWith('UPDATE shiyu_local_reply_inputs SET record_json=')) throw new Error('Injected late receipt write failure');
    return originalPrepare(sql);
  };
  try { assert.throws(() => h.domain.contextDurable({ receipt: h.receipt(native) }), /Injected late receipt write failure/); }
  finally { h.db.prepare = originalPrepare; }
  assert.deepEqual(h.store.contextSnapshot(owner, h.binding.bindingId), before);
  assert.equal(h.domain.get({ operationId: prepared.operationId }).durability, 'unconfirmed');
  assert.equal(h.watermark.read().commitSeq, sequence);
  assert.equal(h.tx.poisoned, false);
  h.domain.contextDurable({ receipt: h.receipt(native) });
  assert.equal(h.store.contextSnapshot(owner, h.binding.bindingId).needsSync, false);
});

test('model failure preserves independent durable context evidence while terminal cancellation rejects late acknowledgements', t => {
  const h = fixture(t); h.update(1); const first = h.dispatch();
  const receipt = h.receipt(first.native); h.domain.contextDurable({ receipt });
  const failed = h.domain.fail({ operationId: first.prepared.operationId, status: 'failed', reasonCode: 'MODEL_ERROR' });
  assert.equal(failed.status, 'failed'); assert.equal(failed.durability, 'confirmed'); assert.deepEqual(failed.contextReceipt, receipt);
  assert.equal(h.store.contextSnapshot(owner, h.binding.bindingId).needsSync, false);
  const second = h.dispatch();
  h.domain.fail({ operationId: second.prepared.operationId, status: 'cancelled', reasonCode: 'CANCELLED' });
  assert.throws(() => h.domain.contextDurable({ receipt: h.receipt(second.native) }), code('REPLY_NOT_ACTIVE'));
});

test('ready and receipt duplicates are pure reads and a late caller failure cannot downgrade a ready draft', t => {
  const h = fixture(t), done = h.complete(), before = h.watermark.read().commitSeq;
  assert.equal(done.ready.status, 'ready'); assert.match(done.ready.draftRef!, /^native-session:/);
  assert.deepEqual(h.domain.ready({ operationId: done.ready.operationId, assistantRef: done.assistantRef }), done.ready);
  assert.deepEqual(h.domain.contextDurable({ receipt: h.receipt(done.native) }), done.ready);
  assert.deepEqual(h.domain.fail({ operationId: done.ready.operationId, status: 'unknown', reasonCode: 'LOST_CALLER' }), done.ready);
  assert.equal(h.watermark.read().commitSeq, before);
  assert.throws(() => h.domain.ready({ operationId: done.ready.operationId, assistantRef: { ...done.assistantRef, messageId: 'other' } }), code('IDEMPOTENCY_CONFLICT'));
  const row = String(h.db.prepare('SELECT record_json FROM shiyu_local_reply_inputs').get()!.record_json);
  assert.ok(!row.includes('synthetic input'));
  assert.ok(!Object.keys(JSON.parse(row)).some(key => ['prompt', 'text', 'history', 'inbox'].includes(key)));
});

test('reopened unknown input retains stable native identity and cannot be prepared or dispatched again', t => {
  const h = fixture(t, true), { prepared, native } = h.dispatch('uncertain-input');
  const unknown = h.domain.fail({ operationId: prepared.operationId, status: 'unknown', reasonCode: 'READBACK_UNKNOWN' });
  const reopen = h.open(), before = reopen.watermark.read().commitSeq;
  const duplicate = reopen.domain.admit({ conversationId: h.conversation.conversationId, inputId: 'uncertain-input', inputHash: hash('synthetic input') });
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.operation, unknown);
  assert.equal(reopen.bindingFor(h.conversation.conversationId).sessionId, native.sessionId);
  assert.throws(() => reopen.domain.prepare({ operationId: prepared.operationId, captureId: prepared.captureId!, viewId: 'replacement-view', loadedTaskIds: ['task-a'] }), code('REPLY_ALREADY_PREPARED'));
  assert.throws(() => reopen.domain.bind({ binding: native }), code('REPLY_ALREADY_DISPATCHED'));
  assert.equal(reopen.watermark.read().commitSeq, before);
});
