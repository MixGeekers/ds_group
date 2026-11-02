import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import {
  LocalReplyDomain, type LocalReplyCapture, type LocalReplyContextReceipt,
  type LocalReplyNativeBinding, type LocalReplyOperation,
} from '../src/adapters/control-store/local-reply-domain.js';
import type { MemoryViewSnapshot } from '../src/adapters/control-store/memory-domain.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { sessionBindingKey } from '../src/adapters/dsh/sessions.js';
import { memoryBodyDigest, memoryCommandDigest, type MemoryCreateCommand } from '../src/contracts/memory.js';
import {
  ConversationError, ConversationStore, type ConversationActor, type ContextToken,
  type ReplyBinding,
} from '../src/control/conversations/index.js';

const owner: ConversationActor = { principalId: 'local-owner', kind: 'owner', scopes: ['local-owner'] };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof ConversationError && error.code === expected;
const strong = (token: ContextToken) => [token.bindingId, token.conversationId, token.scope,
  token.audienceVersion, token.conversationGeneration, token.routingRevision, token.sessionEpoch];
interface MemoryFixture { snapshot: MemoryViewSnapshot; operationIds: string[]; sourceIds: string[] }

function memory(conversationId: string, names = ['a']): MemoryFixture {
  const sources = names.map(name => {
    const operationId = `memory-operation-${name}`, sourceId = `memory-source-${name}`;
    const body = memoryBodyDigest(`Synthetic memory ${name}`);
    const command: MemoryCreateCommand = { schemaVersion: 1, kind: 'create', operationId, backendId: 'ombre-test', scope: 'local-owner',
      targetRef: `memory-target-${name}`, ...body, sourceRefs: [{ sourceId, revision: 1 }] };
    return { operationId, operationVersion: 3, sourceId, sourceRevision: 1, conversationId, targetRef: command.targetRef,
      nativeId: `native-memory-${name}`, componentVersion: hash(`component-${name}`), command, commandDigest: memoryCommandDigest(command),
      readToken: { operationId, operationVersion: 3, sourceId, sourceRevision: 1, audienceVersion: 1,
        authorizationEpoch: 1, saveMandateVersion: 1, deletionBaselineId: 'memory-baseline', tombstoneWatermark: 0,
        installationGeneration: 'test-installation', backendId: 'ombre-test', deploymentId: 'test-deployment',
        nativeId: `native-memory-${name}`, componentVersion: hash(`component-${name}`) } };
  });
  return { snapshot: { schemaVersion: 1, conversationId,
    authority: { backendId: 'ombre-test', deploymentId: 'test-deployment', installationGeneration: 'test-installation',
      authorizationEpoch: 1, deletionBaselineId: 'memory-baseline', deletionScope: 'local-memory-source', tombstoneWatermark: 0,
      installedAt: '2026-11-02T11:00:00.000Z' },
    sources, snapshotHash: hash(JSON.stringify(sources)), collectionHash: hash(JSON.stringify(sources)), truncated: false },
  operationIds: sources.map(source => source.operationId), sourceIds: sources.map(source => source.sourceId) };
}

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  const tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx);
  const now = new Date('2026-11-02T12:00:00.000Z');
  const revoked = new Set<string>();
  const freshnessChecks: string[][] = [];
  const bindings = new Map<string, string>();
  const captures = new Map<string, { value: LocalReplyCapture; memorySourceIds: string[] }>();
  const store = new ConversationStore(db, tx, { ownerIds: [owner.principalId], componentPermissions: {},
    now: () => now, authorizeReference: ({ scope, reference }) => scope === 'local-owner' && reference.kind === 'task' && reference.id === 'task-a' });
  const bindingFor = (conversationId: string): ReplyBinding => {
    const bindingId = bindings.get(conversationId);
    if (!bindingId) throw new ConversationError('UNKNOWN_CONVERSATION', 'Unknown synthetic conversation');
    return store.getReplyBinding(owner, bindingId);
  };
  const domain = new LocalReplyDomain(db, tx, { conversations: store, bindingFor, now: () => now });
  domain.setAuthority({ validateCapture(captureId) {
    const captured = captures.get(captureId);
    if (!captured) throw new ConversationError('UNKNOWN_CAPTURE', 'Unknown synthetic capture');
    if (captured.memorySourceIds.some(sourceId => revoked.has(sourceId))) {
      throw new ConversationError('MEMORY_READ_FORBIDDEN', 'Captured memory consent was withdrawn');
    }
    const current = store.contextSnapshot(owner, captured.value.context.token.bindingId);
    if (JSON.stringify(strong(current.token)) !== JSON.stringify(strong(captured.value.context.token))) {
      throw new ConversationError('STALE_CONTEXT', 'Captured native context epoch or route changed');
    }
    return structuredClone(captured.value);
  }, assertMemorySourcesCurrent(sources) {
    freshnessChecks.push(sources.map(source => source.sourceId));
    if (sources.some(source => revoked.has(source.sourceId))) {
      throw new ConversationError('MEMORY_READ_FORBIDDEN', 'Previously exposed native memory is no longer readable');
    }
  } });
  const createConversation = (name: string = randomUUID()) => {
    const conversation = store.ensureConversation(owner, { connectionId: 'local-synthetic', platformConversationId: name, kind: 'direct', scope: 'local-owner' });
    const topic = store.createTopic(owner, { topicId: `topic-${name}`, scope: 'local-owner' });
    store.linkTopic(owner, { conversationId: conversation.conversationId, topicId: topic.topicId,
      expectedConversationRevision: conversation.revision, expectedTopicRevision: topic.revision });
    store.linkReference(owner, { topicId: topic.topicId, expectedRevision: topic.revision, reference: { kind: 'task', id: 'task-a' } });
    const binding = store.ensureReplyBinding(owner, { conversationId: conversation.conversationId, topicId: topic.topicId });
    bindings.set(conversation.conversationId, binding.bindingId);
    return { conversation, binding };
  };
  const primary = createConversation('primary');
  const capture = (conversationId: string, memory?: MemoryFixture) => {
    const binding = bindingFor(conversationId);
    const value: LocalReplyCapture = { captureId: randomUUID(), expiresAt: '2026-11-02T12:00:30.000Z',
      context: { ...store.contextSnapshot(owner, binding.bindingId), businessId: binding.businessId,
        ...(binding.sessionId ? { sessionId: binding.sessionId } : {}) },
      ...(memory ? { memory: structuredClone(memory.snapshot) } : {}) };
    captures.set(value.captureId, { value: structuredClone(value), memorySourceIds: memory?.sourceIds ?? [] });
    return value;
  };
  const prepare = (options: { conversationId?: string; memory?: MemoryFixture; inputId?: string; loadedMemoryOperationIds?: string[] } = {}) => {
    const conversationId = options.conversationId ?? primary.conversation.conversationId;
    const { operation } = domain.admit({ conversationId, inputId: options.inputId ?? randomUUID(), inputHash: hash('synthetic request') });
    const captured = capture(conversationId, options.memory);
    return domain.prepare({ operationId: operation.operationId, captureId: captured.captureId, viewId: randomUUID(), loadedTaskIds: ['task-a'],
      ...(options.memory || options.loadedMemoryOperationIds ? { loadedMemoryOperationIds: options.loadedMemoryOperationIds ?? options.memory!.operationIds } : {}) });
  };
  const native = (operation: LocalReplyOperation, sessionId = operation.expectedSessionId ?? `native-${randomUUID()}`): LocalReplyNativeBinding => ({
    operationId: operation.operationId, contextTokenId: operation.contextTokenId!, sessionEpoch: operation.sessionEpoch,
    key: sessionBindingKey('replyer', operation.businessId, operation.scope), businessId: operation.businessId,
    scope: operation.scope, sessionId, messageId: `message-${operation.operationId}`, messageHash: hash(`prompt-${operation.operationId}`),
  });
  const receipt = (binding: LocalReplyNativeBinding): LocalReplyContextReceipt => ({ ...binding, userMessageSeq: 4, confirmedAt: now.toISOString(), durability: 'confirmed' });
  const assistant = (binding: LocalReplyNativeBinding) => ({ sessionId: binding.sessionId, eventSeq: 6, messageId: `assistant-${binding.operationId}` });
  const bind = (prepared: LocalReplyOperation, sessionId?: string) => {
    const value = native(prepared, sessionId); domain.bind({ binding: value }); return value;
  };
  const complete = (prepared: LocalReplyOperation) => {
    const value = bind(prepared); domain.contextDurable({ receipt: receipt(value) });
    domain.ready({ operationId: prepared.operationId, assistantRef: assistant(value) }); return value;
  };
  const exposureCount = () => Number(db.prepare('SELECT COUNT(*) AS n FROM shiyu_local_reply_memory_exposures').get()!.n);
  t.after(() => db.close());
  return { db, tx, watermark, store, domain, revoked, freshnessChecks, ...primary, bindingFor, createConversation, capture, prepare, native, bind, receipt, assistant, complete, exposureCount };
}

test('binding records possible memory exposure before a durable context acknowledgement exists', t => {
  const h = fixture(t), selected = memory(h.conversation.conversationId);
  const prepared = h.prepare({ memory: selected });
  assert.equal(h.exposureCount(), 0);
  const value = h.bind(prepared);
  assert.equal(h.exposureCount(), 1);
  const dispatched = h.domain.get({ operationId: prepared.operationId });
  assert.equal(dispatched.status, 'dispatching'); assert.equal(dispatched.durability, 'unconfirmed');
  assert.equal(dispatched.contextReceipt, undefined);
  const before = h.bindingFor(h.conversation.conversationId);
  const invalidated = h.domain.invalidateMemorySources({ withdrawalId: 'withdraw-unconfirmed', sourceIds: selected.sourceIds });
  assert.deepEqual(invalidated.conversationIds, [h.conversation.conversationId]);
  assert.deepEqual(invalidated.retiredSessions, [{ bindingId: before.bindingId, sessionEpoch: before.sessionEpoch,
    businessId: before.businessId, sessionId: value.sessionId }]);
  assert.equal(h.bindingFor(h.conversation.conversationId).sessionEpoch, before.sessionEpoch + 1);
  assert.throws(() => h.domain.contextDurable({ receipt: h.receipt(value) }), code('STALE_CONTEXT'));
  assert.equal(h.domain.get({ operationId: prepared.operationId }).durability, 'unconfirmed');
});

test('withdrawal considers accumulated native memory even after later Task-only turns and leaves other conversations alone', t => {
  const h = fixture(t), selected = memory(h.conversation.conversationId);
  const first = h.prepare({ memory: selected }), native = h.complete(first);
  const second = h.prepare({ memory: memory(h.conversation.conversationId, ['b']) });
  assert.equal(h.complete(second).sessionId, native.sessionId);
  const taskOnly = h.prepare();
  assert.equal(h.complete(taskOnly).sessionId, native.sessionId);
  assert.equal(taskOnly.businessId, first.businessId); assert.equal(taskOnly.sessionEpoch, first.sessionEpoch);
  assert.ok(h.freshnessChecks.some(sources => sources.includes(selected.sourceIds[0]!)), 'Task-only turns must recheck already exposed memory');
  const other = h.createConversation('unaffected');
  const unrelated = h.prepare({ conversationId: other.conversation.conversationId }); h.complete(unrelated);
  const otherBefore = h.bindingFor(other.conversation.conversationId);
  assert.equal(h.exposureCount(), 2);
  assert.ok(Number(h.db.prepare('SELECT COUNT(*) AS n FROM shiyu_reply_source_cursors WHERE binding_id=?').get(h.binding.bindingId)!.n) > 0);
  const before = h.bindingFor(h.conversation.conversationId);
  const invalidated = h.domain.invalidateMemorySources({ withdrawalId: 'withdraw-historical', sourceIds: selected.sourceIds });
  assert.deepEqual(invalidated.conversationIds, [h.conversation.conversationId]);
  assert.equal(invalidated.retiredSessions.length, 1); assert.equal(invalidated.retiredSessions[0]!.sessionId, native.sessionId);
  const after = h.bindingFor(h.conversation.conversationId);
  assert.equal(after.sessionEpoch, before.sessionEpoch + 1); assert.notEqual(after.businessId, before.businessId); assert.equal(after.sessionId, undefined);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM shiyu_reply_source_cursors WHERE binding_id=?').get(after.bindingId)!.n, 0);
  assert.deepEqual(h.bindingFor(other.conversation.conversationId), otherBefore);
});

test('withdrawal fences an acknowledged in-flight draft and the next epoch cannot reuse the retired native Session', t => {
  const h = fixture(t), selected = memory(h.conversation.conversationId);
  const prepared = h.prepare({ memory: selected }), oldNative = h.bind(prepared);
  h.domain.contextDurable({ receipt: h.receipt(oldNative) });
  h.domain.invalidateMemorySources({ withdrawalId: 'withdraw-inflight', sourceIds: selected.sourceIds });
  assert.throws(() => h.domain.authorize({ operationId: prepared.operationId, phase: 'dispatch' }), code('STALE_CONTEXT'));
  assert.throws(() => h.domain.ready({ operationId: prepared.operationId, assistantRef: h.assistant(oldNative) }), code('STALE_CONTEXT'));
  const next = h.prepare();
  assert.equal(next.sessionEpoch, prepared.sessionEpoch + 1); assert.notEqual(next.businessId, prepared.businessId);
  assert.equal(next.expectedSessionId, undefined);
  assert.throws(() => h.bind(next, oldNative.sessionId), code('SESSION_BINDING_CONFLICT'));
  const fresh = h.bind(next, 'native-after-withdrawal');
  h.domain.contextDurable({ receipt: h.receipt(fresh) });
  assert.equal(h.domain.ready({ operationId: next.operationId, assistantRef: h.assistant(fresh) }).status, 'ready');
  assert.equal(h.bindingFor(h.conversation.conversationId).sessionId, fresh.sessionId);
});

test('repeated withdrawal returns its durable receipt without another epoch reset or commit', t => {
  const h = fixture(t), selected = memory(h.conversation.conversationId);
  h.complete(h.prepare({ memory: selected }));
  const input = { withdrawalId: 'withdraw-once', sourceIds: selected.sourceIds };
  const receipt = h.domain.invalidateMemorySources(input), binding = h.bindingFor(h.conversation.conversationId);
  const sequence = h.watermark.read().commitSeq;
  assert.deepEqual(h.domain.invalidateMemorySources(input), receipt);
  assert.deepEqual(h.bindingFor(h.conversation.conversationId), binding);
  assert.equal(h.watermark.read().commitSeq, sequence);
  assert.throws(() => h.domain.invalidateMemorySources({ ...input, sourceIds: ['different-source'] }), code('IDEMPOTENCY_CONFLICT'));
});

test('shared transaction rollback restores the native epoch, cursors and withdrawal identity together', t => {
  const h = fixture(t), selected = memory(h.conversation.conversationId);
  h.complete(h.prepare({ memory: selected }));
  const before = h.bindingFor(h.conversation.conversationId);
  const cursors = h.db.prepare('SELECT * FROM shiyu_reply_source_cursors ORDER BY binding_id,ref_key').all();
  const sequence = h.watermark.read().commitSeq;
  const input = { withdrawalId: 'rolled-back-withdrawal', sourceIds: selected.sourceIds };
  assert.throws(() => h.tx.atomic(() => {
    h.domain.invalidateMemorySources(input);
    assert.equal(h.bindingFor(h.conversation.conversationId).sessionEpoch, before.sessionEpoch + 1);
    throw new Error('Injected surrounding withdrawal transaction failure');
  }), /Injected surrounding withdrawal/);
  assert.deepEqual(h.bindingFor(h.conversation.conversationId), before);
  assert.deepEqual(h.db.prepare('SELECT * FROM shiyu_reply_source_cursors ORDER BY binding_id,ref_key').all(), cursors);
  assert.equal(h.watermark.read().commitSeq, sequence); assert.equal(h.tx.poisoned, false);
  const committed = h.domain.invalidateMemorySources(input);
  assert.equal(committed.retiredSessions.length, 1); assert.equal(h.bindingFor(h.conversation.conversationId).sessionEpoch, before.sessionEpoch + 1);
});

test('prepared memory is not native exposure and withdrawal freshness blocks its later bind', t => {
  const h = fixture(t), selected = memory(h.conversation.conversationId);
  const prepared = h.prepare({ memory: selected }), before = h.bindingFor(h.conversation.conversationId);
  assert.equal(h.exposureCount(), 0);
  const result = h.domain.invalidateMemorySources({ withdrawalId: 'withdraw-before-native', sourceIds: selected.sourceIds });
  assert.deepEqual(result.conversationIds, []); assert.deepEqual(result.retiredSessions, []);
  assert.deepEqual(h.bindingFor(h.conversation.conversationId), before);
  h.revoked.add(selected.sourceIds[0]!);
  assert.throws(() => h.bind(prepared), code('MEMORY_READ_FORBIDDEN'));
  assert.equal(h.exposureCount(), 0); assert.equal(h.bindingFor(h.conversation.conversationId).sessionId, undefined);
});

test('only selected captured memory operations enter the native exposure ledger', t => {
  const h = fixture(t), selected = memory(h.conversation.conversationId, ['a', 'b']);
  const prepared = h.prepare({ memory: selected, loadedMemoryOperationIds: [selected.operationIds[0]!] });
  h.complete(prepared); assert.equal(h.exposureCount(), 1);
  const before = h.bindingFor(h.conversation.conversationId);
  const unseen = h.domain.invalidateMemorySources({ withdrawalId: 'withdraw-not-loaded', sourceIds: [selected.sourceIds[1]!] });
  assert.deepEqual(unseen.retiredSessions, []); assert.deepEqual(h.bindingFor(h.conversation.conversationId), before);
  const seen = h.domain.invalidateMemorySources({ withdrawalId: 'withdraw-loaded', sourceIds: [selected.sourceIds[0]!] });
  assert.equal(seen.retiredSessions.length, 1); assert.equal(h.bindingFor(h.conversation.conversationId).sessionEpoch, before.sessionEpoch + 1);
  assert.throws(() => h.prepare({ memory: memory(h.conversation.conversationId), loadedMemoryOperationIds: ['uncaptured-operation'] }), code('FORBIDDEN_REFERENCE'));
});

test('durable context-only loading is terminal without an assistant draft or generation result', t => {
  const h = fixture(t), selected = memory(h.conversation.conversationId);
  const prepared = h.prepare({ memory: selected }), value = h.bind(prepared);
  assert.throws(() => h.domain.loaded({ operationId: prepared.operationId }), code('REPLY_NOT_LOADED'));
  h.domain.contextDurable({ receipt: h.receipt(value) });
  const loaded = h.domain.loaded({ operationId: prepared.operationId });
  assert.equal(loaded.status, 'loaded'); assert.equal(loaded.durability, 'confirmed');
  assert.equal(loaded.assistantRef, undefined); assert.equal(loaded.draftRef, undefined);
  const draft = JSON.parse(String(h.db.prepare('SELECT record_json FROM shiyu_reply_drafts WHERE id=?').get(loaded.draftId!)!.record_json));
  assert.equal(draft.status, 'abandoned'); assert.equal(draft.draftRef, undefined);
  assert.equal(h.exposureCount(), 1);
  const sequence = h.watermark.read().commitSeq;
  assert.deepEqual(h.domain.loaded({ operationId: loaded.operationId }), loaded);
  assert.deepEqual(h.domain.fail({ operationId: loaded.operationId, status: 'unknown', reasonCode: 'LATE_CALLER_FAILURE' }), loaded);
  assert.equal(h.watermark.read().commitSeq, sequence);
  assert.throws(() => h.domain.ready({ operationId: loaded.operationId, assistantRef: h.assistant(value) }), code('REPLY_NOT_READY'));
});

test('a late native-bind write failure rolls back exposure, native registration and dispatch state together', t => {
  const h = fixture(t), selected = memory(h.conversation.conversationId);
  const prepared = h.prepare({ memory: selected }), value = h.native(prepared);
  const before = h.bindingFor(h.conversation.conversationId), sequence = h.watermark.read().commitSeq;
  const originalPrepare = h.db.prepare.bind(h.db);
  h.db.prepare = (sql: string) => {
    if (sql.startsWith('UPDATE shiyu_local_reply_inputs SET record_json=')) throw new Error('Injected late exposure bind failure');
    return originalPrepare(sql);
  };
  try { assert.throws(() => h.domain.bind({ binding: value }), /Injected late exposure bind failure/); }
  finally { h.db.prepare = originalPrepare; }
  assert.equal(h.exposureCount(), 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM shiyu_reply_sessions').get()!.n, 0);
  assert.deepEqual(h.bindingFor(h.conversation.conversationId), before);
  assert.deepEqual(h.domain.get({ operationId: prepared.operationId }), prepared);
  assert.equal(h.watermark.read().commitSeq, sequence); assert.equal(h.tx.poisoned, false);
  assert.equal(h.domain.bind({ binding: value }).status, 'dispatching');
  assert.equal(h.exposureCount(), 1); assert.equal(h.bindingFor(h.conversation.conversationId).sessionId, value.sessionId);
});

test('unknown exposure survives Domain reconstruction and Task-only reuse fails closed without memory authority', t => {
  const h = fixture(t), selected = memory(h.conversation.conversationId);
  const prepared = h.prepare({ memory: selected }), value = h.bind(prepared);
  h.domain.fail({ operationId: prepared.operationId, status: 'unknown', reasonCode: 'NATIVE_READBACK_UNKNOWN' });
  assert.equal(h.exposureCount(), 1);
  const reconstructed = new LocalReplyDomain(h.db, h.tx, { conversations: h.store, bindingFor: h.bindingFor, now: () => new Date('2026-11-02T12:00:00.000Z') });
  const admitted = h.domain.admit({ conversationId: h.conversation.conversationId, inputId: 'task-only-after-unknown', inputHash: hash('synthetic Task-only request') }).operation;
  const capture = h.capture(h.conversation.conversationId);
  reconstructed.setAuthority({ validateCapture(captureId) {
    assert.equal(captureId, capture.captureId); return structuredClone(capture);
  } });
  assert.throws(() => reconstructed.admit({ conversationId: h.conversation.conversationId, inputId: 'without-fresh-memory-authority', inputHash: hash('synthetic input') }), code('MEMORY_AUTHORITY_UNAVAILABLE'));
  assert.throws(() => reconstructed.prepare({ operationId: admitted.operationId, captureId: capture.captureId, viewId: 'task-only-view', loadedTaskIds: ['task-a'] }), code('MEMORY_AUTHORITY_UNAVAILABLE'));
  assert.equal(reconstructed.get({ operationId: admitted.operationId }).status, 'admitted');
  assert.equal(h.bindingFor(h.conversation.conversationId).sessionId, value.sessionId);
  const result = reconstructed.invalidateMemorySources({ withdrawalId: 'withdraw-after-reconstruction', sourceIds: selected.sourceIds });
  assert.deepEqual(result.conversationIds, [h.conversation.conversationId]);
  assert.equal(result.retiredSessions[0]!.sessionId, value.sessionId);
  assert.equal(h.bindingFor(h.conversation.conversationId).sessionEpoch, prepared.sessionEpoch + 1);
});

test('the 201st distinct native memory is refused before exposure registration without poisoning the existing epoch', t => {
  const f = fixture(t);
  for (let batch = 0; batch < 10; batch++) {
    const selected = memory(f.conversation.conversationId, Array.from({ length: 20 }, (_, n) => `bounded-${batch * 20 + n}`));
    f.bind(f.prepare({ memory: selected, inputId: `batch-${batch}` }));
  }
  const binding = f.bindingFor(f.conversation.conversationId), before = f.watermark.read();
  const overflow = f.prepare({ memory: memory(f.conversation.conversationId, ['overflow']), inputId: 'capacity-overflow' });
  const preparedVersion = f.watermark.read();
  assert.throws(() => f.bind(overflow), code('MEMORY_CONTEXT_CAPACITY'));
  assert.deepEqual(f.watermark.read(), preparedVersion);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM shiyu_local_reply_memory_exposures').get()!.n, 200);
  assert.equal(f.domain.get({ operationId: overflow.operationId }).status, 'prepared');
  const taskOnly = f.prepare({ inputId: 'still-usable' }); f.bind(taskOnly);
  assert.equal(taskOnly.expectedSessionId, binding.sessionId); assert.equal(taskOnly.sessionEpoch, binding.sessionEpoch);
  assert.ok(f.watermark.read().commitSeq > before.commitSeq);
});
