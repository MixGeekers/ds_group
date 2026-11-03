import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { computeMemoryReadiness, type MemoryIndexCoverage } from '../src/adapters/ombre/readiness.js';
import { MemoryDomain } from '../src/adapters/control-store/memory-domain.js';
import { MemoryIndexDomain, type MemoryIndexCommands } from '../src/adapters/control-store/memory-index-domain.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { LocalMemorySearchService, type LocalMemorySearchStore } from '../src/control/local-memory-search.js';
import { memoryBodyDigest, memoryCommandDigest } from '../src/contracts/memory.js';
import { canonicalSemanticMemory, memoryIndexCommandDigest, memoryQueryDigest, OMBRE_HARRIER_PROFILE_FINGERPRINT,
  type MemoryIndexCommand, type MemoryIndexObservation } from '../src/contracts/semantic-memory.js';

const coverage = (patch: Partial<MemoryIndexCoverage> = {}): MemoryIndexCoverage => ({
  readableCount: 2, indexedCount: 2, missingCount: 0, staleCount: 0, pendingCount: 0, unknownCount: 0, cancelledCount: 0,
  indexBaselineId: `index_${'a'.repeat(32)}`, indexWatermark: 3, observedAt: '2026-11-03T00:00:00.000Z', coverageComplete: true, ...patch,
});
const backend = (patch: Record<string, unknown> = {}) => ({
  state: 'ready', bindingVerified: true, semanticReady: true,
  semantic: { state: 'ready', profileCompatible: true, embeddingVerified: true, profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT,
    indexBaselineId: `index_${'a'.repeat(32)}`, indexWatermark: 3, observedAt: '2026-11-03T00:00:00.000Z',
    lastEmbeddingSuccessAt: '2026-11-03T00:00:00.000Z' }, ...patch,
});

test('a ready verified backend with complete coverage advertises semantic search', () => {
  const value = computeMemoryReadiness({ backend: backend(), coverage: coverage(), semanticConfigured: true });
  assert.equal(value.exactRead, true); assert.equal(value.embeddingVerified, true); assert.equal(value.profileCompatible, true);
  assert.equal(value.semanticReady, true); assert.deepEqual(value.capabilities, ['exact_read', 'semantic_search']);
  assert.equal(value.reason, null); assert.equal(value.coverageComplete, true); assert.equal(value.coverage.indexedCount, 2);
  assert.equal(value.verification.scope, 'backend-instance');
});

test('profile-compatible but unverified embedding degrades to exact read only (no fake semantic recall)', () => {
  const value = computeMemoryReadiness({ backend: backend({ semanticReady: false, semantic: { ...backend().semantic, state: 'unverified', embeddingVerified: false, lastEmbeddingSuccessAt: null } }), coverage: coverage(), semanticConfigured: true });
  assert.equal(value.exactRead, true); assert.equal(value.embeddingVerified, false); assert.equal(value.semanticReady, false);
  assert.deepEqual(value.capabilities, ['exact_read']); assert.equal(value.reason, 'EMBEDDING_UNVERIFIED');
  assert.equal(value.verification.lastEmbeddingSuccessAt, null);
});

test('profile mismatch cannot be presented as semantic recall', () => {
  const value = computeMemoryReadiness({ backend: backend({ semantic: { ...backend().semantic, profileCompatible: false } }), coverage: coverage() });
  assert.equal(value.semanticReady, false); assert.deepEqual(value.capabilities, ['exact_read']); assert.equal(value.reason, 'PROFILE_MISMATCH'); assert.equal(value.profileCompatible, false);
});

test('backend unavailable/not ready or failed runtime memory reports exact read unavailable', () => {
  for (const input of [{ backend: undefined, memoryFailure: 'MEMORY_BACKEND_UNAVAILABLE' },
    { backend: backend({ state: 'failed', bindingVerified: false }), coverage: coverage() },
    { backend: backend({ state: 'opening' }), coverage: coverage() }]) {
    const value = computeMemoryReadiness(input);
    assert.equal(value.exactRead, false); assert.equal(value.semanticReady, false); assert.deepEqual(value.capabilities, []);
    assert.ok(value.reason === 'MEMORY_BACKEND_UNAVAILABLE' || value.reason === 'MEMORY_BACKEND_NOT_READY');
  }
});

test('verified embedding with no indexed memory degrades instead of promising an empty semantic path', () => {
  const value = computeMemoryReadiness({ backend: backend(), coverage: coverage({ readableCount: 2, indexedCount: 0, missingCount: 2, coverageComplete: false }) });
  assert.equal(value.semanticReady, false); assert.deepEqual(value.capabilities, ['exact_read']); assert.equal(value.reason, 'INDEX_EMPTY'); assert.equal(value.coverageComplete, false);
});

test('partial coverage stays explicit while verified semantic search remains available', () => {
  const value = computeMemoryReadiness({ backend: backend(), coverage: coverage({ readableCount: 3, indexedCount: 2, missingCount: 1, coverageComplete: false }) });
  assert.equal(value.semanticReady, true); assert.deepEqual(value.capabilities, ['exact_read', 'semantic_search']);
  assert.equal(value.coverageComplete, false); assert.equal(value.reason, 'INDEX_COVERAGE_INCOMPLETE');
  assert.deepEqual([value.coverage.readableCount, value.coverage.indexedCount, value.coverage.missingCount], [3, 2, 1]);
});

test('pending or unknown indexing is unsettled and explicit; stale entries are counted separately', () => {
  const pending = computeMemoryReadiness({ backend: backend(), coverage: coverage({ pendingCount: 1, coverageComplete: false }) });
  assert.equal(pending.reason, 'INDEX_UNSETTLED'); assert.equal(pending.coverage.pendingCount, 1);
  const unknown = computeMemoryReadiness({ backend: backend(), coverage: coverage({ unknownCount: 1, coverageComplete: false }) });
  assert.equal(unknown.reason, 'INDEX_UNSETTLED'); assert.equal(unknown.coverage.unknownCount, 1);
  const stale = computeMemoryReadiness({ backend: backend(), coverage: coverage({ staleCount: 1, coverageComplete: false }) });
  assert.equal(stale.reason, 'INDEX_COVERAGE_INCOMPLETE'); assert.equal(stale.coverage.staleCount, 1);
});

test('missing coverage counts are derived conservatively and coercion never invents readiness', () => {
  const value = computeMemoryReadiness({ backend: backend(), coverage: { readableCount: 5, indexedCount: 2, indexBaselineId: `index_${'a'.repeat(32)}`, indexWatermark: 3 } });
  assert.equal(value.coverage.missingCount, 3); assert.equal(value.coverageComplete, false); assert.equal(value.reason, 'INDEX_COVERAGE_INCOMPLETE');
  const coerced = computeMemoryReadiness({ backend: backend(), coverage: { readableCount: -1 as never, indexedCount: Number.NaN as never } });
  assert.equal(coerced.coverage.readableCount, 0); assert.equal(coerced.coverage.indexedCount, 0);
  assert.equal(coerced.semanticReady, true); // provider verified, index empty -> semantic enabled but explicit
});

test('real index ledger reconciles applied/current vs stale after a source withdrawal', async () => {
  const BODY = 'Synthetic coverage body: the green notebook is in drawer nine.';
  const binding = { backendId: 'coverage-backend', deploymentId: 'coverage-deployment', scope: 'local-owner' as const };
  const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : canonicalSemanticMemory(value)).digest('hex');
  const db = new DatabaseSync(':memory:'), tx = new SqliteTransactions(db), at = '2026-11-03T00:00:00.000Z';
  const conversation = { conversationId: 'coverage-conversation', key: { connectionId: 'local-synthetic', platformConversationId: 'coverage', kind: 'direct' as const, scope: 'local-owner' as const },
    revision: 1, audienceVersion: 1, conversationGeneration: 1, archived: false, createdAt: at, updatedAt: at };
  const memory = new MemoryDomain(db, tx, { runtimeIdentity: { installationGeneration: 'coverage-install', hostEpoch: 'coverage-host' }, ...binding, getConversation: () => conversation });
  const indexes = new MemoryIndexDomain(db, tx, { runtimeIdentity: { installationGeneration: 'coverage-install', hostEpoch: 'coverage-host' }, ...binding, memory });
  const value = memoryBodyDigest(BODY);
  const prepared = memory.prepareLocal({ requestId: 'coverage-save', conversationId: conversation.conversationId, bodyDigest: value.bodyDigest, bytes: value.bodyBytes });
  const claim = memory.claim({ operationId: prepared.operation.operationId })!;
  memory.recordVerifiedReceipt({ operationId: prepared.operation.operationId, claim: claim.claim, reconciliation: false, observation: {
    command: prepared.command, commandDigest: memoryCommandDigest(prepared.command), deploymentId: binding.deploymentId,
    nativeId: `shiyu_${hash(prepared.operation.operationId).slice(0, 32)}`, receiptId: `receipt_${hash(prepared.operation.operationId)}`, componentVersion: `sha256:${hash(BODY)}`,
    ...value, sourceRefs: prepared.command.sourceRefs, observedAt: at } });
  let watermark = 1;
  const status = () => ({ schemaVersion: 2 as const, ...binding, semanticApi: true as const, profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT,
    indexBaselineId: `index_${'c'.repeat(32)}`, indexWatermark: watermark, recordedIndexedCount: 1, embeddingConfigured: true as const,
    limits: { maxEligibleRefs: 128 as const, maxScannedRows: 2048 as const, maxResults: 10 as const, maxEmbeddingCallsPerIndex: 2 as const, maxDeadlineMs: 60000 as const } });
  const observation = (command: MemoryIndexCommand): MemoryIndexObservation => ({ schemaVersion: 2, ...binding, indexOperationId: command.indexOperationId,
    currentIndexBaselineId: command.indexBaselineId, currentIndexWatermark: Math.max(watermark, command.expectedIndexWatermark + 1), state: 'applied', command, commandDigest: memoryIndexCommandDigest(command),
    reason: null, embeddingCalls: 1, usageComplete: true, receipt: { schemaVersion: 2, ...binding, receiptId: `index_receipt_${hash(command.indexOperationId)}`,
      indexOperationId: command.indexOperationId, memoryOperationId: command.memoryOperationId, bodyReceiptId: command.bodyReceiptId, commandDigest: memoryIndexCommandDigest(command),
      nativeId: command.nativeId, componentVersion: command.componentVersion, bodyDigest: command.bodyDigest, profileFingerprint: command.profileFingerprint,
      indexBaselineId: command.indexBaselineId, indexWatermark: command.expectedIndexWatermark + 1, content: { digest: command.bodyDigest, vectorHash: hash('vector'), dimensions: 1024 },
      meaning: { state: 'absent', digest: null, vectorHash: null, dimensions: null }, embeddingCalls: 1, observedAt: at } });
  const store: LocalMemorySearchStore = { async request(command, args) {
    const typed = args as never;
    if (command.startsWith('memory.index.')) return indexes.execute({ command, args: typed } as never) as never;
    if (command === 'memory.listEligibleForView') return memory.listEligibleForView(typed) as never;
    if (command === 'memory.readLocal') return memory.readLocal(typed) as never;
    if (command === 'memory.captureForView') return memory.captureForView(typed) as never;
    throw new Error(`Unexpected coverage command ${command}`);
  } };
  const backend = { binding, async backendStatus() { return status(); }, async ensureIndex(command: MemoryIndexCommand) { return observation(command); },
    async indexStatus(command: MemoryIndexCommand) { return observation(command); }, async searchCandidates() { throw new Error('search not used'); },
    async verifyApplied() { throw new Error('verify not used'); } };
  const service = new LocalMemorySearchService({ store, backend, assertRuntimeAllowed() {} });
  try {
    const result = await service.index({ requestId: 'coverage-index', operationId: prepared.operation.operationId });
    assert.equal(result.entry.publishable, true);
    const covered = indexes.coverage();
    assert.equal(covered.indexedCount, 1); assert.equal(covered.staleCount, 0); assert.equal(covered.pendingCount, 0); assert.equal(covered.unknownCount, 0);
    assert.equal(covered.indexBaselineId, `index_${'c'.repeat(32)}`); assert.equal(covered.indexWatermark, 2); assert.equal(covered.observedAt, at);
    memory.withdrawLocal({ requestId: 'coverage-withdraw', operationId: prepared.operation.operationId });
    const stale = indexes.coverage();
    assert.equal(stale.indexedCount, 0); assert.equal(stale.staleCount, 1);
    const readiness = computeMemoryReadiness({ backend: { state: 'ready', bindingVerified: true, semanticReady: true,
      semantic: { state: 'ready', profileCompatible: true, embeddingVerified: true, profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT,
        indexBaselineId: stale.indexBaselineId, indexWatermark: stale.indexWatermark } },
      coverage: { readableCount: 0, indexedCount: stale.indexedCount, missingCount: 0, staleCount: stale.staleCount,
        pendingCount: stale.pendingCount, unknownCount: stale.unknownCount, indexBaselineId: stale.indexBaselineId, indexWatermark: stale.indexWatermark } });
    assert.equal(readiness.exactRead, true); assert.equal(readiness.coverageComplete, false); assert.equal(readiness.reason, 'INDEX_COVERAGE_INCOMPLETE');
  } finally { await service.close(); db.close(); }
});
