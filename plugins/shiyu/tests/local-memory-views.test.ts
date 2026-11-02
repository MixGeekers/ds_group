import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { createControlAuthority, MEMORY_DISPATCHER, MEMORY_VERIFIER } from '../src/adapters/control-store/authority.js';
import { MemoryDomain, type LocalMemoryEntry } from '../src/adapters/control-store/memory-domain.js';
import { ViewDomain, type LocalViewCapture } from '../src/adapters/control-store/view-domain.js';
import { MemoryOperationLedger } from '../src/control/memory/index.js';
import { ConversationStore } from '../src/control/conversations/index.js';
import type { TrustedPolicyActor } from '../src/control/policy/mandates.js';
import { memoryBodyDigest, memoryCommandDigest, type MemoryBackendObservation } from '../src/contracts/memory.js';
import { StatePublicationStore, createStatePublisher, initialStateManifest, type MemoryStateManifest } from '../src/state/publication.js';
import { LocalReadSafetyStore } from '../src/state/safety.js';
import { createLocalReadView, type LocalReadViewOptions } from '../src/views/local.js';

const start = '2026-11-02T05:00:00.000Z';
const OWNER: TrustedPolicyActor = { principalId: 'local-owner', kind: 'owner', scopes: ['local-owner'] };
const body = '合成唯一正文：雨天记得带伞；此正文只能来自后端。';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (...values: string[]) => (error: unknown) => error instanceof Error && 'code' in error && values.includes(String(error.code));
const profileFingerprint = 'a'.repeat(64);
function observation(entry: LocalMemoryEntry): MemoryBackendObservation {
  return { command: structuredClone(entry.command), commandDigest: memoryCommandDigest(entry.command), deploymentId: 'deployment-a',
    nativeId: `shiyu_${sha(entry.operation.operationId).slice(0, 32)}`, receiptId: `receipt_${sha(`receipt:${entry.operation.operationId}`)}`,
    componentVersion: `sha256:${sha(`native-markdown:${entry.command.bodyDigest}`)}`, bodyDigest: entry.command.bodyDigest,
    bodyBytes: entry.command.bodyBytes, sourceRefs: structuredClone(entry.command.sourceRefs), observedAt: start };
}
async function fixture(t: TestContext, config: { available?: boolean; semantic?: boolean; ttlMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-memory-view-')), db = new DatabaseSync(join(directory, 'control.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  let clock = Date.parse(start); const now = () => new Date(clock), tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx);
  const conversations = new ConversationStore(db, tx, { ownerIds: ['local-owner'], componentPermissions: {}, authorizeReference: () => false, now });
  const conversation = conversations.ensureConversation(OWNER, { connectionId: 'local-synthetic', platformConversationId: 'memory-view', kind: 'direct', scope: 'local-owner' });
  const memories = new MemoryDomain(db, tx, { runtimeIdentity: { hostEpoch: 'host-a', installationGeneration: 'install-a' }, backendId: 'ombre-local', deploymentId: 'deployment-a',
    getConversation: id => conversations.getConversation(OWNER, id), now });
  const authority = createControlAuthority(db, tx, { now }), safety = new LocalReadSafetyStore(db, tx, { getAuthEpoch: () => authority.health().authEpoch, now });
  const publication = new StatePublicationStore(db, tx, { publisherIds: ['state-service'], now }), publisher = createStatePublisher('state-service');
  publication.publish(publisher, { requestId: 'legacy', manifest: initialStateManifest() });
  const publish = (manifest: MemoryStateManifest, requestId = 'available') => {
    const old = publication.get()!; return publication.publish(publisher, { requestId, expectedBaselineId: old.baselineId, expectedStateVersion: old.stateVersion, manifest });
  };
  if (config.available !== false) publish({ schemaVersion: 2, domains: { ...initialStateManifest().domains,
    memory: { status: 'available', backendId: 'ombre-local', deploymentId: 'deployment-a', capabilities: config.semantic ? ['exact_read', 'semantic_search'] : ['exact_read'],
      ...(config.semantic ? { profileFingerprint } : {}) } } });
  const context: LocalViewCapture['context'] = { token: { bindingId: 'binding-a', conversationId: conversation.conversationId, scope: 'local-owner', audienceVersion: 1,
    conversationGeneration: 1, routingRevision: 1, sessionEpoch: 1, contextVersion: 0 }, sources: [], pending: [], needsSync: false, businessId: 'business-a' };
  const views = new ViewDomain(db, tx, { publication, safety, watermark, memory: memories, context: () => structuredClone(context),
    getTask: () => { throw new Error('No tasks in this fixture'); }, now, ttlMs: config.ttlMs });
  const save = (requestId = 'save-a', conversationId = conversation.conversationId) => {
    const value = memoryBodyDigest(body), entry = memories.prepareLocal({ requestId, conversationId, bodyDigest: value.bodyDigest, bytes: value.bodyBytes });
    const plan = memories.claim({ operationId: entry.operation.operationId })!, observed = observation(entry);
    const applied = memories.recordVerifiedReceipt({ operationId: entry.operation.operationId, claim: plan.claim, observation: observed, reconciliation: false });
    return { entry: applied, observed, operationId: entry.operation.operationId };
  };
  const validate = async (id: string) => views.validateReplyCapture(id, { for: 'ready' });
  const capture = (operationIds: string[]) => views.captureLocal({ conversationId: conversation.conversationId, purpose: 'reply_context', memoryOperationIds: operationIds });
  const local = (capture: LocalViewCapture, options: Partial<LocalReadViewOptions> = {}) => {
    const result = createLocalReadView(capture, { validate, now, ...options }); t.after(() => result.close()); return result;
  };
  return { db, tx, memories, authority, safety, publication, publish, watermark, conversations, conversationId: conversation.conversationId,
    context, views, save, validate, capture, local, now, advance: (ms: number) => { clock += ms; } };
}

test('metadata capture is a pure read; transient exact body has native provenance and fixed deadline', async t => {
  const f = await fixture(t), saved = f.save(), before = f.watermark.read(), capture = f.capture([saved.operationId]);
  assert.deepEqual(f.watermark.read(), before); assert.doesNotMatch(JSON.stringify(capture), /合成唯一正文|记得带伞/);
  const tables = f.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const table of tables) assert.equal(JSON.stringify(f.db.prepare(`SELECT * FROM ${table.name}`).all()).includes(body), false);
  let reads = 0;
  const local = f.local(capture, { memoryRead: async source => { reads++; assert.equal(source.operationId, saved.operationId); return { body, observation: saved.observed }; } });
  const view = await local.read(); await local.assertCurrent(view.viewId);
  assert.equal(reads, 1); assert.equal(view.freshness.status, 'current'); assert.equal(view.expiresAt, capture.expiresAt);
  assert.deepEqual(view.data, [{ backendId: 'native-memory', recordId: saved.operationId, fields: { text: body } }]);
  assert.deepEqual(view.aggregateVersions, [{ aggregateType: 'memory', aggregateId: saved.operationId, version: saved.entry.operation.version }]);
  assert.deepEqual(view.sourceRefs.map(({ sourceId, revision, contentHash }) => ({ sourceId, revision, contentHash })),
    [{ sourceId: `memory:${saved.entry.source.sourceId}`, revision: saved.entry.source.revision, contentHash: saved.entry.command.bodyDigest }]);
  assert.equal(view.components.find(item => item.backendId === 'native-memory')!.indexVersion, undefined);
  assert.equal(view.authority!.memory!.deletionScope, 'local-memory-source'); assert.equal(view.authority!.deletionScope, 'local-task-source');
  assert.deepEqual(f.watermark.read(), before); assert.deepEqual(await f.validate(capture.captureId), capture);
});

test('explicit memory selection needs published capability and cannot inject authority or cross conversations', async t => {
  const f = await fixture(t, { available: false }), saved = f.save(), before = f.watermark.read();
  assert.throws(() => f.capture([saved.operationId]), code('MEMORY_UNAVAILABLE')); assert.deepEqual(f.watermark.read(), before);
  const taskOnly = f.views.captureLocal({ conversationId: f.conversationId, purpose: 'reply_context' }); assert.equal(taskOnly.memory, undefined);
  f.publish({ schemaVersion: 2, domains: { ...initialStateManifest().domains, memory: { status: 'available', backendId: 'ombre-local', deploymentId: 'deployment-a', capabilities: ['exact_read'] } } });
  const empty = f.capture([]); assert.equal(empty.memory!.sources.length, 0); assert.ok(empty.access.authority!.memory);
  for (const patch of [{ actor: OWNER }, { readToken: {} }, { policyVersion: 1 }, { receiptId: 'forged' }]) {
    assert.throws(() => f.views.captureLocal({ conversationId: f.conversationId, purpose: 'reply_context', memoryOperationIds: [saved.operationId], ...patch } as never), code('INVALID_SCHEMA'));
  }
  const foreign = f.conversations.ensureConversation(OWNER, { connectionId: 'local-synthetic', platformConversationId: 'other-local', kind: 'direct', scope: 'local-owner' });
  const other = f.save('foreign-save', foreign.conversationId);
  assert.throws(() => f.capture([other.operationId]), code('MEMORY_VIEW_FORBIDDEN'));
  assert.throws(() => f.capture([saved.operationId, saved.operationId]), code('INVALID_SCHEMA'));
  f.memories.withdrawLocal({ requestId: 'withdraw', operationId: saved.operationId });
  assert.throws(() => f.capture([saved.operationId]), code('MEMORY_READ_FORBIDDEN'));
});

test('memory withdrawal and publication changes invalidate prepare, ack and ready', async t => {
  const f = await fixture(t), saved = f.save(), capture = f.capture([saved.operationId]);
  f.memories.withdrawLocal({ requestId: 'withdraw', operationId: saved.operationId });
  for (const phase of ['prepare', 'ack', 'ready'] as const) assert.throws(() => f.views.validateReplyCapture(capture.captureId, { for: phase }), code('VIEW_INVALIDATED', 'MEMORY_VIEW_INVALIDATED'));
  const empty = f.capture([]);
  f.publish({ schemaVersion: 2, domains: { ...initialStateManifest().domains, memory: { status: 'unavailable', reason: 'source_unavailable' } } }, 'unavailable');
  assert.throws(() => f.views.validateReplyCapture(empty.captureId, { for: 'ack' }), code('VIEW_INVALIDATED'));
});

test('memory deletion barrier invalidates captures without changing Task watermark or global auth epoch', async t => {
  const f = await fixture(t), saved = f.save(), capture = f.capture([saved.operationId]), safety = f.safety.snapshot();
  const ledger = new MemoryOperationLedger(f.db, f.tx, { backendIds: ['ombre-local'], approverIds: [OWNER.principalId],
    dispatcherIds: [MEMORY_DISPATCHER.principalId], verifierIds: [MEMORY_VERIFIER.principalId], eraserIds: [OWNER.principalId], now: f.now });
  ledger.tombstone(OWNER, { deletionId: 'independent-deletion', scope: 'local-owner', refs: ['unrelated-memory-source'], expectedWatermark: 0, reasonCode: 'OWNER_WITHDRAWAL' });
  assert.deepEqual(f.safety.snapshot(), safety); assert.equal(ledger.watermark(), 1);
  for (const phase of ['prepare', 'ack', 'ready'] as const) assert.throws(() => f.views.validateReplyCapture(capture.captureId, { for: phase }), code('MEMORY_VIEW_INVALIDATED'));
  const next = f.capture([saved.operationId]);
  assert.equal(next.access.tombstoneWatermark, 0); assert.equal(next.access.authority!.memory!.tombstoneWatermark, 1);
  const view = await f.local(next, { memoryRead: async () => ({ body, observation: saved.observed }) }).read();
  assert.equal(view.freshness.status, 'current'); assert.equal(view.tombstoneWatermark, 0); assert.equal(view.authority!.memory!.tombstoneWatermark, 1);
});

test('native body, native identity and component fingerprint mismatches cannot enter the view', async t => {
  const f = await fixture(t), saved = f.save();
  const results = [
    { body: 'forged body', observation: saved.observed },
    { body, observation: { ...saved.observed, nativeId: 'other-native' } },
    { body, observation: { ...saved.observed, componentVersion: `sha256:${'b'.repeat(64)}` } },
    { body, observation: { ...saved.observed, deploymentId: 'other-deployment' } },
    { body, observation: { ...saved.observed, commandDigest: 'b'.repeat(64) } },
    { body, observation: { ...saved.observed, sourceRefs: [] } },
  ];
  for (const result of results) {
    const local = f.local(f.capture([saved.operationId]), { memoryRead: async () => result }), view = await local.read();
    assert.deepEqual(view.data, []); assert.equal(view.freshness.status, 'unavailable'); assert.equal(JSON.stringify(view).includes(body), false);
  }
  const missing = await f.local(f.capture([saved.operationId])).read(); assert.equal(missing.freshness.status, 'unavailable'); assert.deepEqual(missing.data, []);
});

test('withdrawal during an awaited native read blocks the returned body and old view reuse', async t => {
  const f = await fixture(t), saved = f.save(), capture = f.capture([saved.operationId]);
  let release!: (value: { body: string; observation: MemoryBackendObservation }) => void, started!: () => void;
  const gate = new Promise<void>(resolve => { started = resolve; });
  const local = f.local(capture, { memoryRead: async () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const reading = local.read(); await gate;
  f.memories.withdrawLocal({ requestId: 'withdraw-inflight', operationId: saved.operationId }); release({ body, observation: saved.observed });
  await assert.rejects(reading, code('DEPENDENCY_UNAVAILABLE', 'VIEW_INVALIDATED'));
  assert.throws(() => f.views.validateReplyCapture(capture.captureId, { for: 'ack' }), code('VIEW_INVALIDATED', 'MEMORY_VIEW_INVALIDATED'));
});

test('native reads cannot renew a pinned TTL or survive disposal', async t => {
  const f = await fixture(t, { ttlMs: 10 }), saved = f.save(), capture = f.capture([saved.operationId]);
  const expired = f.local(capture, { memoryRead: async () => { f.advance(11); return { body, observation: saved.observed }; } });
  await assert.rejects(expired.read(), code('DEPENDENCY_UNAVAILABLE', 'EXPIRED'));
  assert.throws(() => f.views.validateReplyCapture(capture.captureId, { for: 'ack' }), code('UNKNOWN_CAPTURE'));
  let release!: (value: { body: string; observation: MemoryBackendObservation }) => void, started!: () => void;
  const gate = new Promise<void>(resolve => { started = resolve; });
  const closing = f.local(f.capture([saved.operationId]), { memoryRead: async () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const reading = closing.read(); await gate; closing.close(); release({ body, observation: saved.observed });
  await assert.rejects(reading, code('DISPOSED'));
});

test('semantic index observation is profile bound and remains separate from memory deletion authority', async t => {
  const f = await fixture(t, { semantic: true }), saved = f.save(), capture = f.capture([saved.operationId]);
  const memoryIndex = { profileFingerprint, indexBaselineId: 'native-index-a', indexWatermark: 42 };
  const view = await f.local(capture, { memoryIndex, memoryRead: async () => ({ body, observation: saved.observed }) }).read();
  assert.equal(view.components.find(item => item.backendId === 'native-memory')!.indexVersion, `native-index-a@42/${profileFingerprint}`);
  assert.equal(view.indexWatermark, 0); assert.equal(view.authority!.memory!.tombstoneWatermark, 0);
  for (const patch of [{ profileFingerprint: 'b'.repeat(64) }, { indexWatermark: -1 }, { indexBaselineId: '' }, { actor: OWNER }]) {
    assert.throws(() => f.local(capture, { memoryIndex: { ...memoryIndex, ...patch } }), code('INVALID_INDEX_OBSERVATION'));
  }
  const exact = await fixture(t), exactSaved = exact.save();
  assert.throws(() => exact.local(exact.capture([exactSaved.operationId]), { memoryIndex }), code('INVALID_INDEX_OBSERVATION'));
});
