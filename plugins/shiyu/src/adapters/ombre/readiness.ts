/**
 * P0 Ombre memory readiness projection.
 *
 * This module only *interprets* trusted facts already observed by the managed
 * backend and the local index ledger. It performs no I/O, no embedding call and
 * cannot grant authority: the host runtime still owns every command gate.
 *
 * The one behavioural rule this slice fixes: a configured profile is not a
 * verified embedding. `semantic_search` is only advertised when a fresh query
 * embedding actually succeeded in this backend instance (`embeddingVerified`).
 * Otherwise the truthful projection is exact-read-only with an explicit reason;
 * no component may pretend that lexical/exact reads are semantic recall.
 */
export interface MemoryIndexCoverage {
  /** Current readable local memory sources in the audience considered by the caller. */
  readableCount: number;
  /** Applied index entries whose source is still current/readable. */
  indexedCount: number;
  /** Readable sources without a current applied index. */
  missingCount: number;
  /** Applied index entries whose source has since changed or was withdrawn. */
  staleCount: number;
  pendingCount: number;
  unknownCount: number;
  cancelledCount: number;
  /** indexBaselineId/indexWatermark come from the last trusted semantic observation. */
  indexBaselineId: string | null;
  indexWatermark: number | null;
  observedAt: string | null;
  coverageComplete: boolean;
}
export interface MemoryReadinessBackend {
  state: string;
  bindingVerified: boolean;
  semanticReady?: boolean;
  semantic?: {
    state?: string;
    profileCompatible?: boolean;
    embeddingVerified?: boolean;
    profileFingerprint?: string | null;
    indexBaselineId?: string | null;
    indexWatermark?: number | null;
    observedAt?: string | null;
    lastEmbeddingSuccessAt?: string | null;
  } | null;
}
export type MemoryReadinessReason =
  | 'MEMORY_BACKEND_UNAVAILABLE'
  | 'MEMORY_BACKEND_NOT_READY'
  | 'EMBEDDING_UNVERIFIED'
  | 'PROFILE_MISMATCH'
  | 'INDEX_EMPTY'
  | 'INDEX_COVERAGE_INCOMPLETE'
  | 'INDEX_UNSETTLED'
  | null;
export interface MemoryReadiness {
  version: 1;
  semanticConfigured: boolean;
  /** Backend storage is usable for controlled exact reads. */
  exactRead: boolean;
  /** Fresh embedding inference was verified in this backend instance. */
  embeddingVerified: boolean;
  profileCompatible: boolean;
  /** Advertised capability list; never includes semantic_search unless verified. */
  capabilities: ('exact_read' | 'semantic_search')[];
  coverage: MemoryIndexCoverage;
  coverageComplete: boolean;
  /** `semanticReady` here means "may truthfully advertise semantic_search". */
  semanticReady: boolean;
  reason: MemoryReadinessReason;
  /** Stable declaration that verification is per-process, not an old receipt. */
  verification: { scope: 'backend-instance'; lastEmbeddingSuccessAt: string | null };
}
export interface MemoryReadinessInput {
  backend?: MemoryReadinessBackend;
  coverage?: Partial<MemoryIndexCoverage>;
  memoryFailure?: string;
  semanticConfigured?: boolean;
}
const integer = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const coverageOf = (value?: Partial<MemoryIndexCoverage>): MemoryIndexCoverage => {
  const readableCount = integer(value?.readableCount), indexedCount = integer(value?.indexedCount);
  const missingCount = value?.missingCount === undefined ? Math.max(0, readableCount - indexedCount) : integer(value.missingCount);
  const staleCount = integer(value?.staleCount), pendingCount = integer(value?.pendingCount), unknownCount = integer(value?.unknownCount), cancelledCount = integer(value?.cancelledCount);
  const indexBaselineId = typeof value?.indexBaselineId === 'string' ? value.indexBaselineId : null;
  const indexWatermark = typeof value?.indexWatermark === 'number' && Number.isSafeInteger(value.indexWatermark) && value.indexWatermark >= 0 ? value.indexWatermark : null;
  const observedAt = typeof value?.observedAt === 'string' ? value.observedAt : null;
  return { readableCount, indexedCount, missingCount, staleCount, pendingCount, unknownCount, cancelledCount, indexBaselineId, indexWatermark, observedAt,
    coverageComplete: missingCount === 0 && staleCount === 0 && pendingCount === 0 && unknownCount === 0 && (readableCount > 0 || indexBaselineId !== null) };
};
export function computeMemoryReadiness(input: MemoryReadinessInput = {}): MemoryReadiness {
  const coverage = coverageOf(input.coverage);
  const backend = input.backend;
  const configured = input.semanticConfigured ?? Boolean(backend?.semantic);
  const empty = { version: 1 as const, semanticConfigured: configured, exactRead: false, embeddingVerified: false, profileCompatible: false,
    capabilities: [] as ('exact_read' | 'semantic_search')[], coverage, coverageComplete: coverage.coverageComplete, semanticReady: false,
    reason: (input.memoryFailure ? 'MEMORY_BACKEND_UNAVAILABLE' : 'MEMORY_BACKEND_UNAVAILABLE') as MemoryReadinessReason,
    verification: { scope: 'backend-instance' as const, lastEmbeddingSuccessAt: null } };
  if (!backend) return { ...empty, reason: input.memoryFailure ? 'MEMORY_BACKEND_UNAVAILABLE' : 'MEMORY_BACKEND_NOT_READY' };
  const embeddingVerified = backend.state === 'ready' && backend.bindingVerified && backend.semanticReady === true
    && backend.semantic?.embeddingVerified === true;
  const profileCompatible = backend.semantic?.profileCompatible === true;
  const lastEmbeddingSuccessAt = typeof backend.semantic?.lastEmbeddingSuccessAt === 'string' ? backend.semantic.lastEmbeddingSuccessAt : null;
  if (backend.state !== 'ready' || !backend.bindingVerified) {
    return { ...empty, semanticConfigured: configured, profileCompatible, reason: 'MEMORY_BACKEND_NOT_READY',
      verification: { scope: 'backend-instance', lastEmbeddingSuccessAt } };
  }
  const exactRead = true;
  const semanticPossible = embeddingVerified && profileCompatible;
  const indexEmpty = coverage.readableCount > 0 && coverage.indexedCount === 0;
  const unsettled = coverage.pendingCount > 0 || coverage.unknownCount > 0;
  const semanticReady = semanticPossible && !indexEmpty;
  const reason: MemoryReadinessReason = !embeddingVerified ? 'EMBEDDING_UNVERIFIED'
    : !profileCompatible ? 'PROFILE_MISMATCH'
      : indexEmpty ? 'INDEX_EMPTY'
        : unsettled ? 'INDEX_UNSETTLED'
          : !coverage.coverageComplete ? 'INDEX_COVERAGE_INCOMPLETE' : null;
  return { version: 1, semanticConfigured: configured, exactRead, embeddingVerified, profileCompatible,
    capabilities: semanticReady ? ['exact_read', 'semantic_search'] : ['exact_read'],
    coverage, coverageComplete: coverage.coverageComplete, semanticReady, reason,
    verification: { scope: 'backend-instance', lastEmbeddingSuccessAt } };
}
