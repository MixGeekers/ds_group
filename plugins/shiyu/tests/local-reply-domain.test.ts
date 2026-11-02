import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { LocalReplyDomain, type LocalReplyCapture, type LocalReplyContextReceipt, type LocalReplyInnerSources, type LocalReplyNativeBinding, type LocalReplyOperation } from '../src/adapters/control-store/local-reply-domain.js';
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
  const capture = (inner?: LocalReplyCapture['inner'], options: { expiresMs?: number; lab?: { operationId: string; replyId: string } } = {}) => {
    const current = h.bindingFor(conversation.conversationId);
    const value: LocalReplyCapture = { captureId: randomUUID(), expiresAt: new Date(time + (options.expiresMs ?? 30000)).toISOString(),
      ...(options.lab ? { replyExecution: { kind: 'lab-reply-v1' as const, operationId: options.lab.operationId, replyId: options.lab.replyId, connectionId: 'lab-connection' } } : {}),
      context: { ...h.store.contextSnapshot(owner, bindingId), businessId: current.businessId, ...(current.sessionId ? { sessionId: current.sessionId } : {}) },
      ...(inner ? { inner: structuredClone(inner) } : {}) };
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
  const complete = (textSha256?: string) => {
    const value = dispatch(); h.domain.contextDurable({ receipt: receipt(value.native) });
    const assistantRef = { sessionId: value.native.sessionId, eventSeq: 6, messageId: 'assistant-a' };
    return { ...value, assistantRef, ready: h.domain.ready({ operationId: value.prepared.operationId, assistantRef, ...(textSha256 ? { textSha256 } : {}) }) };
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

test('legacy mode-less loaded and unknown outcomes remain immutable duplicates while explicit modes conflict', t => {
  const h = fixture(t);
  for (const status of ['loaded', 'unknown'] as const) {
    const first = h.admit(`legacy-${status}`), legacy = { ...first.operation, status };
    delete legacy.mode;
    h.tx.atomic(() => h.db.prepare('UPDATE shiyu_local_reply_inputs SET record_json=? WHERE operation_id=?').run(JSON.stringify(legacy), legacy.operationId));
    const before = h.watermark.read();
    const duplicate = h.domain.admit({ conversationId: h.conversation.conversationId, inputId: legacy.inputId, inputHash: legacy.inputHash, mode: 'load' });
    assert.deepEqual(duplicate, { duplicate: true, operation: legacy });
    assert.deepEqual(h.watermark.read(), before);
    assert.throws(() => h.domain.bind({ binding: { ...h.native(legacy), contextTokenId: hash('synthetic-legacy-context') } }), code('REPLY_ALREADY_DISPATCHED'));
  }
  const explicit = h.domain.admit({ conversationId: h.conversation.conversationId, inputId: 'explicit-load', inputHash: hash('load'), mode: 'load' }).operation;
  assert.throws(() => h.domain.admit({ conversationId: h.conversation.conversationId, inputId: explicit.inputId, inputHash: explicit.inputHash, mode: 'reply' }), code('IDEMPOTENCY_CONFLICT'));
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

test('trusted ready draft publication checks exact receipt/hash and stays read-only', t => {
  const h = fixture(t), done = h.complete(hash('native assistant text')), before = h.watermark.read().commitSeq;
  assert.deepEqual(h.domain.assertReadyDraft(done.ready.operationId), done.ready);
  assert.equal(h.watermark.read().commitSeq, before);
  assert.throws(() => h.domain.ready({ operationId: done.ready.operationId, assistantRef: done.assistantRef, textSha256: hash('changed') }), code('IDEMPOTENCY_CONFLICT'));
  h.admit('newer-input');
  assert.throws(() => h.domain.assertReadyDraft(done.ready.operationId), code('STALE_CONTEXT'));
});

test('trusted ready draft gate rejects legacy, changed sources, expired captures and altered durable evidence', t => {
  const legacy = fixture(t), old = legacy.complete();
  assert.throws(() => legacy.domain.assertReadyDraft(old.ready.operationId), code('REPLY_NOT_READY'));
  const current = fixture(t), done = current.complete(hash('exact text'));
  current.taskVersions.set('task-a', 7);
  assert.throws(() => current.domain.assertReadyDraft(done.ready.operationId), code('VIEW_INVALIDATED'));
  current.taskVersions.set('task-a', 6);
  const record = structuredClone(done.ready); record.contextReceipt!.messageHash = hash('not the bound input');
  current.tx.atomic(() => current.db.prepare('UPDATE shiyu_local_reply_inputs SET record_json=? WHERE operation_id=?').run(JSON.stringify(record), record.operationId));
  assert.throws(() => current.domain.assertReadyDraft(record.operationId), code('REPLY_NOT_READY'));
  current.tx.atomic(() => current.db.prepare('UPDATE shiyu_local_reply_inputs SET record_json=? WHERE operation_id=?').run(JSON.stringify(done.ready), record.operationId));
  current.advanceTime(30000);
  assert.throws(() => current.domain.assertReadyDraft(record.operationId), code('EXPIRED'));
});

/* ------------------------------------------------------------------ */
/* H4d: explicit inner provenance on prepare                          */
/* ------------------------------------------------------------------ */
const INNER_DOMAIN_LIST = ['relationship', 'emotion', 'cognition', 'personality'] as const;
const INNER_RECORD_ID = 'assertion:inner-a:r1';
const INNER_RECORD_DIGEST = hash('inner-record-digest');
const innerAuthority = (domain: (typeof INNER_DOMAIN_LIST)[number]) => ({ authorityId: `${domain}-authority`, installationGeneration: 'inner-install',
  policyVersion: 1, tombstoneWatermark: 0, baselineId: `${domain}-baseline` });
function innerBundle(recordsFor: Partial<Record<(typeof INNER_DOMAIN_LIST)[number], LocalReplyCapture['inner']>> = {}): NonNullable<LocalReplyCapture['inner']> {
  const domains: NonNullable<LocalReplyCapture['inner']>['domains'] = {};
  for (const domain of INNER_DOMAIN_LIST) {
    const patched = (recordsFor[domain]?.domains?.[domain]) as { records?: { recordId: string; revision: number; evidenceState: 'valid'; recordDigest: string }[] } | undefined;
    domains[domain] = { domain, authority: innerAuthority(domain),
      records: domain === 'relationship' ? [{ recordId: INNER_RECORD_ID, revision: 1, evidenceState: 'valid' as const, recordDigest: INNER_RECORD_DIGEST }] : (patched?.records ?? []) };
  }
  return { domains };
}
function innerSummary(captureId: string): LocalReplyInnerSources {
  return { schemaVersion: 1, policyVersion: 1, captureId, domains: INNER_DOMAIN_LIST.map(domain => domain === 'relationship'
    ? { domain, status: 'included' as const, authority: { backendId: `control-${domain}`, ...innerAuthority(domain) },
        records: [{ recordId: INNER_RECORD_ID, revision: 1, evidenceState: 'valid' as const, recordDigest: INNER_RECORD_DIGEST }] }
    : { domain, status: 'empty' as const, authority: { backendId: `control-${domain}`, ...innerAuthority(domain) }, records: [] }) };
}
function preparedWithInner(t: TestContext, options: { persistent?: boolean; lab?: boolean } = {}) {
  const h = fixture(t, Boolean(options.persistent));
  const { operation } = h.admit('inner-prepared');
  const captured = h.capture(innerBundle(), options.lab ? { lab: { operationId: operation.operationId, replyId: operation.inputId }, expiresMs: 120000 } : {});
  const innerSources = innerSummary(captured.captureId);
  const prepared = h.domain.prepare({ operationId: operation.operationId, captureId: captured.captureId, viewId: randomUUID(), loadedTaskIds: ['task-a'], innerSources });
  return { h, prepared, captured, innerSources };
}

test('prepare persists body-free inner provenance and returns it on readback and reopen', t => {
  const { h, prepared, innerSources, captured } = preparedWithInner(t, { persistent: true });
  assert.deepEqual(prepared.innerSources, innerSources);
  assert.deepEqual(h.domain.get({ operationId: prepared.operationId }).innerSources, innerSources);
  const serialized = JSON.stringify(prepared);
  assert.equal(serialized.includes('合成'), false);
  assert.equal(serialized.includes('payload'), false);
  assert.equal(serialized.includes('grant'), false);
  assert.equal(serialized.includes('permit'), false);
  assert.equal(serialized.includes(innerSources.domains![0]!.records![0]!.recordDigest), true);
  const reopened = h.open();
  assert.deepEqual(reopened.domain.get({ operationId: prepared.operationId }).innerSources, innerSources);
  // Record projection is exactly the bounded digest surface.
  assert.deepEqual(Object.keys(innerSources.domains[0]!.records[0]!).sort(), ['evidenceState', 'recordDigest', 'recordId', 'revision']);
  assert.equal(captured.captureId, innerSources.captureId);
});

test('prepare replay is idempotent in effect while a second prepare stays refused and changes nothing', t => {
  const { h, prepared, captured, innerSources } = preparedWithInner(t);
  const before = h.domain.get({ operationId: prepared.operationId }), watermark = h.watermark.read();
  assert.throws(() => h.domain.prepare({ operationId: prepared.operationId, captureId: captured.captureId, viewId: randomUUID(), loadedTaskIds: ['task-a'], innerSources }), code('REPLY_ALREADY_PREPARED'));
  assert.throws(() => h.domain.prepare({ operationId: prepared.operationId, captureId: captured.captureId, viewId: randomUUID(), loadedTaskIds: ['task-a'] }), code('REPLY_ALREADY_PREPARED'));
  assert.deepEqual(h.domain.get({ operationId: prepared.operationId }), before);
  assert.deepEqual(h.watermark.read(), watermark);
});

test('legacy callers without inner provenance stay compatible and read back as not_provided', t => {
  const h = fixture(t), prepared = h.prepare('legacy-inner');
  assert.equal(prepared.innerSources, undefined);
  assert.equal('innerSources' in h.domain.get({ operationId: prepared.operationId }), false);
  const value = h.native(prepared); h.domain.bind({ binding: value }); h.domain.contextDurable({ receipt: h.receipt(value) });
  const ready = h.domain.ready({ operationId: prepared.operationId, assistantRef: { sessionId: value.sessionId, eventSeq: 6, messageId: 'assistant-a' } });
  assert.equal(ready.status, 'ready'); assert.equal(ready.innerSources, undefined);
});

test('inner provenance is closed: bodies, grants, bad order, bad digests and mismatch are refused before persistence', t => {
  const h = fixture(t), { operation } = h.admit('reject-inner'), captured = h.capture(innerBundle());
  const valid = innerSummary(captured.captureId);
  const prepare = (innerSources: unknown) => h.domain.prepare({ operationId: operation.operationId, captureId: captured.captureId, viewId: randomUUID(), loadedTaskIds: ['task-a'], innerSources } as never);
  const withRecord = (patch: Record<string, unknown>) => ({ ...structuredClone(valid), domains: [{ ...structuredClone(valid.domains[0]!), records: [{ ...structuredClone(valid.domains[0]!.records[0]!), ...patch }] }, ...structuredClone(valid.domains.slice(1))] });
  const cases: [unknown, string[]][] = [
    [{ ...structuredClone(valid), body: '正文' }, ['INVALID_SCHEMA']],
    [withRecord({ payload: { text: '正文' } }), ['INVALID_INNER_SOURCES', 'INVALID_SCHEMA']],
    [withRecord({ evidenceState: 'degraded' }), ['INVALID_INNER_SOURCES']],
    [withRecord({ recordDigest: 'not-a-digest' }), ['INVALID_INNER_SOURCES']],
    [withRecord({ revision: 0 }), ['INVALID_INNER_SOURCES']],
    [{ ...structuredClone(valid), domains: [...structuredClone(valid.domains)].reverse() }, ['INVALID_INNER_SOURCES']],
    [{ ...structuredClone(valid), domains: structuredClone(valid.domains).slice(0, 3) }, ['INVALID_INNER_SOURCES']],
    [((): LocalReplyInnerSources => { const value = structuredClone(valid); value.domains[0]!.authority!.authorityId = 'other-authority'; return value; })(), ['STALE_INNER_CONTEXT']],
    [((): LocalReplyInnerSources => { const value = structuredClone(valid); value.domains[0]!.records[0]!.recordDigest = hash('changed'); return value; })(), ['STALE_INNER_CONTEXT']],
    [((): LocalReplyInnerSources => { const value = structuredClone(valid); value.domains[0]!.records.push({ ...structuredClone(value.domains[0]!.records[0]!), recordId: 'assertion:unknown:r1' }); return value; })(), ['STALE_INNER_CONTEXT']],
  ];
  for (const [index, [invalid, allowed]] of cases.entries()) {
    try { prepare(invalid); throw new Error(`inner source case ${index} was accepted`); }
    catch (error) {
      if (error instanceof Error && /^inner source case/.test(error.message)) throw error;
      if (!(error instanceof ConversationError && allowed.includes(error.code))) {
        throw new Error(`inner source case ${index} expected ${allowed.join('/')} got ${(error as { code?: string }).code}: ${JSON.stringify(invalid).slice(0, 160)}`);
      }
    }
  }
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM shiyu_reply_drafts').get()!.n, 0);
});

test('a revoked inner capture is refused at prepare time and its record change is refused before dispatch', t => {
  const unknown = fixture(t);
  const unknownOperation = unknown.admit('inner-unknown').operation, unknownPrimary = unknown.capture();
  assert.throws(() => unknown.domain.prepare({ operationId: unknownOperation.operationId, captureId: unknownPrimary.captureId, viewId: randomUUID(), loadedTaskIds: ['task-a'],
    innerSources: { ...innerSummary(unknownPrimary.captureId), captureId: randomUUID() } }), code('UNKNOWN_CAPTURE'));
  const { h, prepared, captured } = preparedWithInner(t);
  const value = h.native(prepared);
  h.domain.bind({ binding: value });
  // Simulate a degraded/withdrawn inner record after prepare: the pinned capture bytes changed.
  const saved = h.captures.get(captured.captureId)!;
  saved.capture.inner!.domains.relationship!.records[0]!.recordDigest = hash('changed-after-prepare');
  assert.throws(() => h.domain.authorize({ operationId: prepared.operationId, phase: 'ready' }), code('STALE_INNER_CONTEXT'));
  saved.capture.inner!.domains.relationship!.records[0]!.recordDigest = INNER_RECORD_DIGEST;
  saved.capture.inner!.domains.relationship!.records[0]!.evidenceState = 'degraded';
  assert.throws(() => h.domain.authorize({ operationId: prepared.operationId, phase: 'ready' }), code('STALE_INNER_CONTEXT'));
  // An expired inner capture is a revocation blocker for a local reply.
  saved.capture.inner!.domains.relationship!.records[0]!.evidenceState = 'valid';
  h.advanceTime(31000);
  assert.throws(() => h.domain.authorize({ operationId: prepared.operationId, phase: 'ready' }), code('EXPIRED'));
});

test('a Lab reply tolerates only the inner read-snapshot time bound, not changed provenance', t => {
  const { h, prepared, captured } = preparedWithInner(t, { lab: true });
  const value = h.native(prepared);
  h.domain.bind({ binding: value });
  h.advanceTime(31000);
  // Primary Lab capture lives to 120s; the 30s inner read snapshot may expire, and
  // the replyer re-derives/compares the bounded block before release.
  const authorized = h.domain.authorize({ operationId: prepared.operationId, phase: 'ready' });
  assert.equal(authorized.status, 'dispatching');
  const saved = h.captures.get(captured.captureId)!;
  saved.capture.inner!.domains.relationship!.records[0]!.recordDigest = hash('lab-changed');
  assert.throws(() => h.domain.authorize({ operationId: prepared.operationId, phase: 'ready' }), code('STALE_INNER_CONTEXT'));
});

test('inner provenance from another conversation or another domain authority is refused', t => {
  const h = fixture(t), { operation } = h.admit('cross-audience-inner');
  const primary = h.capture(), inner = h.capture(innerBundle());
  const valid = innerSummary(inner.captureId);
  const saved = h.captures.get(inner.captureId)!;
  saved.capture.context.token.conversationId = 'another-conversation';
  assert.throws(() => h.domain.prepare({ operationId: operation.operationId, captureId: primary.captureId, viewId: randomUUID(), loadedTaskIds: ['task-a'], innerSources: valid }),
    (error: unknown) => error instanceof ConversationError && ['STALE_INNER_CONTEXT', 'STALE_CONTEXT', 'VIEW_INVALIDATED'].includes(error.code));
});
