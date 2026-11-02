import { createHash } from 'node:crypto';

/** Pinned Ombre profile; the TS batch client's non-truncating profile is different. */
export const OMBRE_HARRIER_PROFILE_ID = 'harrier-oss-v1-0.6b-q8_0-1024-ombre-head2000-v1' as const;
export const OMBRE_HARRIER_PROFILE = Object.freeze({
  id: OMBRE_HARRIER_PROFILE_ID, model: 'shiyu-harrier-0.6b-q8_0',
  artifact_sha256: 'b017b8fceae7c77864652c63d07af51480088b078771a89cafe1a467b069ea75',
  upstream_revision: 'f9b9dc8d367d443f2479d27aa5d8d2850c0774ee',
  dimensions: 1024, pooling: 'last', normalization: 'l2',
  query_prefix: 'Instruct: Given a user query about personal chat memories, retrieve the most relevant memory entries that answer the query\nQuery: ',
  document_prefix: '', input_policy: 'head-2000-unicode-codepoints-before-prefix',
} as const);
export interface SemanticMemoryBinding { backendId: string; deploymentId: string; scope: 'local-owner' }
export interface MemoryIndexCommand extends SemanticMemoryBinding {
  schemaVersion: 1; kind: 'ensure-index'; indexOperationId: string; memoryOperationId: string; bodyReceiptId: string;
  nativeId: string; componentVersion: string; bodyDigest: string; profileFingerprint: string;
  indexBaselineId: string; expectedIndexWatermark: number; deadlineAtMs: number; maxEmbeddingCalls: 2;
}
export interface MemoryIndexReceipt extends SemanticMemoryBinding {
  schemaVersion: 2; receiptId: string; indexOperationId: string; memoryOperationId: string; bodyReceiptId: string;
  commandDigest: string; nativeId: string; componentVersion: string; bodyDigest: string; profileFingerprint: string;
  indexBaselineId: string; indexWatermark: number;
  content: { digest: string; vectorHash: string; dimensions: 1024 };
  meaning: { state: 'absent'; digest: null; vectorHash: null; dimensions: null }
    | { state: 'indexed'; digest: string; vectorHash: string; dimensions: 1024 };
  embeddingCalls: number; observedAt: string;
}
export interface MemoryIndexObservation extends SemanticMemoryBinding {
  schemaVersion: 2; indexOperationId: string; state: 'absent' | 'unknown' | 'applied';
  command: MemoryIndexCommand | null; commandDigest: string | null; receipt: MemoryIndexReceipt | null; reason: string | null;
  currentIndexBaselineId: string; currentIndexWatermark: number; embeddingCalls: number | null; usageComplete: boolean;
}
export interface SemanticBackendStatus extends SemanticMemoryBinding {
  schemaVersion: 2; semanticApi: true; profileFingerprint: string; indexBaselineId: string; indexWatermark: number;
  recordedIndexedCount: number; embeddingConfigured: true;
  limits: { maxEligibleRefs: 128; maxScannedRows: 2048; maxResults: 10; maxEmbeddingCallsPerIndex: 2; maxDeadlineMs: 60000 };
}
export interface MemorySearchEligibleRef {
  memoryOperationId: string; bodyReceiptId: string; nativeId: string; componentVersion: string; bodyDigest: string;
}
export interface MemorySearchRequest {
  scope: 'local-owner'; query: string; limit: number; eligibleRefs: MemorySearchEligibleRef[];
  profileFingerprint: string; expectedIndexBaselineId: string; expectedIndexWatermark: number; deadlineAtMs: number;
}
export interface MemorySearchResult extends SemanticMemoryBinding {
  schemaVersion: 2; state: 'ok' | 'index_required'; profileFingerprint: string; indexBaselineId: string; indexWatermark: number;
  queryDigest: string; embeddingCalls: number; usageComplete: true;
  coverage: { eligibleCount: number; indexedCount: number; missingCount: number };
  matches: { memoryOperationId: string; nativeId: string; componentVersion: string; bodyDigest: string;
    indexReceiptId: string; indexWatermark: number; score: number }[];
}
export class SemanticMemoryContractError extends Error {
  constructor(readonly code: 'INVALID_INDEX_COMMAND' | 'INVALID_SEARCH_REQUEST' | 'INVALID_SEMANTIC_RESPONSE' | 'SEMANTIC_IDENTITY_MISMATCH') {
    super(code); this.name = 'SemanticMemoryContractError';
  }
}
type Code = SemanticMemoryContractError['code'];
function fail(code: Code = 'INVALID_SEMANTIC_RESPONSE'): never { throw new SemanticMemoryContractError(code); }
function object(value: unknown, keys: readonly string[], code?: Code): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(field => !Object.hasOwn(field, 'value'))) return fail(code);
  return value as Record<string, unknown>;
}
const id = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const native = (value: unknown): value is string => typeof value === 'string' && /^shiyu_[a-f0-9]{32}$/.test(value);
const component = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const baseline = (value: unknown): value is string => typeof value === 'string' && /^index_[a-f0-9]{32}$/.test(value);
const bodyReceipt = (value: unknown): value is string => typeof value === 'string' && /^receipt_[a-f0-9]{64}$/.test(value);
const indexReceipt = (value: unknown): value is string => typeof value === 'string' && /^index_receipt_[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const reason = (value: unknown): value is string | null => value === null || (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value));
export function canonicalSemanticMemory(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSemanticMemory).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalSemanticMemory((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
export const OMBRE_HARRIER_PROFILE_FINGERPRINT = digest(canonicalSemanticMemory(OMBRE_HARRIER_PROFILE));
const same = (a: unknown, b: unknown): boolean => canonicalSemanticMemory(a) === canonicalSemanticMemory(b);
function binding(raw: Record<string, unknown>, expected: SemanticMemoryBinding): void {
  if (raw.schemaVersion !== 2 || raw.backendId !== expected.backendId || raw.deploymentId !== expected.deploymentId || raw.scope !== expected.scope) fail('SEMANTIC_IDENTITY_MISMATCH');
}
const indexCommandKeys = ['schemaVersion', 'kind', 'indexOperationId', 'memoryOperationId', 'bodyReceiptId', 'backendId', 'deploymentId', 'scope',
  'nativeId', 'componentVersion', 'bodyDigest', 'profileFingerprint', 'indexBaselineId', 'expectedIndexWatermark', 'deadlineAtMs', 'maxEmbeddingCalls'] as const;
export function validateMemoryIndexCommand(value: unknown): MemoryIndexCommand {
  const raw = object(value, indexCommandKeys, 'INVALID_INDEX_COMMAND');
  if (raw.schemaVersion !== 1 || raw.kind !== 'ensure-index' || !id(raw.indexOperationId, 150) || !id(raw.memoryOperationId, 150)
    || !bodyReceipt(raw.bodyReceiptId) || !id(raw.backendId) || !id(raw.deploymentId) || raw.scope !== 'local-owner'
    || !native(raw.nativeId) || !component(raw.componentVersion) || !hash(raw.bodyDigest) || raw.profileFingerprint !== OMBRE_HARRIER_PROFILE_FINGERPRINT
    || !baseline(raw.indexBaselineId) || !integer(raw.expectedIndexWatermark) || !integer(raw.deadlineAtMs, Number.MAX_SAFE_INTEGER, 1)
    || raw.maxEmbeddingCalls !== 2) fail('INVALID_INDEX_COMMAND');
  return structuredClone(raw) as unknown as MemoryIndexCommand;
}
export function canonicalMemoryIndexCommand(command: MemoryIndexCommand): string { return canonicalSemanticMemory(validateMemoryIndexCommand(command)); }
export function memoryIndexCommandDigest(command: MemoryIndexCommand): string { return digest(canonicalMemoryIndexCommand(command)); }
export function memoryQueryDigest(query: string): string {
  if (typeof query !== 'string' || !query.trim() || /\p{Surrogate}/u.test(query) || Buffer.byteLength(query, 'utf8') > 8192) fail('INVALID_SEARCH_REQUEST');
  return digest(query);
}
export function validateMemorySearchRequest(value: unknown): MemorySearchRequest {
  const raw = object(value, ['scope', 'query', 'limit', 'eligibleRefs', 'profileFingerprint', 'expectedIndexBaselineId', 'expectedIndexWatermark', 'deadlineAtMs'], 'INVALID_SEARCH_REQUEST');
  if (raw.scope !== 'local-owner' || !integer(raw.limit, 10, 1) || !Array.isArray(raw.eligibleRefs) || raw.eligibleRefs.length > 128
    || raw.profileFingerprint !== OMBRE_HARRIER_PROFILE_FINGERPRINT || !baseline(raw.expectedIndexBaselineId) || !integer(raw.expectedIndexWatermark)
    || !integer(raw.deadlineAtMs, Number.MAX_SAFE_INTEGER, 1)) fail('INVALID_SEARCH_REQUEST');
  memoryQueryDigest(raw.query as string);
  const eligible = raw.eligibleRefs as unknown[];
  let previous = '';
  for (const value of eligible) {
    const ref = object(value, ['memoryOperationId', 'bodyReceiptId', 'nativeId', 'componentVersion', 'bodyDigest'], 'INVALID_SEARCH_REQUEST');
    if (!id(ref.memoryOperationId, 150) || !bodyReceipt(ref.bodyReceiptId) || !native(ref.nativeId) || !component(ref.componentVersion)
      || !hash(ref.bodyDigest) || ref.nativeId <= previous) fail('INVALID_SEARCH_REQUEST');
    previous = ref.nativeId;
  }
  return structuredClone(raw) as unknown as MemorySearchRequest;
}
export function validateSemanticBackendStatus(value: unknown, expected: SemanticMemoryBinding): SemanticBackendStatus {
  const raw = object(value, ['schemaVersion', 'backendId', 'deploymentId', 'scope', 'semanticApi', 'profileFingerprint', 'indexBaselineId', 'indexWatermark', 'recordedIndexedCount', 'embeddingConfigured', 'limits']);
  binding(raw, expected);
  if (raw.semanticApi !== true || raw.profileFingerprint !== OMBRE_HARRIER_PROFILE_FINGERPRINT || !baseline(raw.indexBaselineId)
    || !integer(raw.indexWatermark) || !integer(raw.recordedIndexedCount) || raw.embeddingConfigured !== true
    || !same(object(raw.limits, ['maxEligibleRefs', 'maxScannedRows', 'maxResults', 'maxEmbeddingCallsPerIndex', 'maxDeadlineMs']),
      { maxEligibleRefs: 128, maxScannedRows: 2048, maxResults: 10, maxEmbeddingCallsPerIndex: 2, maxDeadlineMs: 60000 })) fail();
  return structuredClone(raw) as unknown as SemanticBackendStatus;
}
export function validateMemoryIndexReceipt(value: unknown, command: MemoryIndexCommand): MemoryIndexReceipt {
  const raw = object(value, ['schemaVersion', 'backendId', 'deploymentId', 'scope', 'receiptId', 'indexOperationId', 'memoryOperationId', 'bodyReceiptId',
    'commandDigest', 'nativeId', 'componentVersion', 'bodyDigest', 'profileFingerprint', 'indexBaselineId', 'indexWatermark', 'content', 'meaning', 'embeddingCalls', 'observedAt']);
  binding(raw, command);
  for (const key of ['indexOperationId', 'memoryOperationId', 'bodyReceiptId', 'nativeId', 'componentVersion', 'bodyDigest', 'profileFingerprint', 'indexBaselineId'] as const) {
    if (raw[key] !== command[key]) fail('SEMANTIC_IDENTITY_MISMATCH');
  }
  const content = object(raw.content, ['digest', 'vectorHash', 'dimensions']);
  const meaning = object(raw.meaning, ['state', 'digest', 'vectorHash', 'dimensions']);
  if (!indexReceipt(raw.receiptId) || raw.commandDigest !== memoryIndexCommandDigest(command) || !integer(raw.indexWatermark, Number.MAX_SAFE_INTEGER, 1)
    || raw.indexWatermark <= command.expectedIndexWatermark || !integer(raw.embeddingCalls, 2) || !timestamp(raw.observedAt)
    || content.digest !== command.bodyDigest || !hash(content.vectorHash) || content.dimensions !== 1024
    || (meaning.state === 'absent' ? meaning.digest !== null || meaning.vectorHash !== null || meaning.dimensions !== null
      : meaning.state !== 'indexed' || !hash(meaning.digest) || !hash(meaning.vectorHash) || meaning.dimensions !== 1024)) fail();
  return structuredClone(raw) as unknown as MemoryIndexReceipt;
}
export function validateMemoryIndexObservation(value: unknown, command: MemoryIndexCommand): MemoryIndexObservation {
  const raw = object(value, ['schemaVersion', 'backendId', 'deploymentId', 'scope', 'indexOperationId', 'state', 'command', 'commandDigest', 'receipt', 'reason',
    'currentIndexBaselineId', 'currentIndexWatermark', 'embeddingCalls', 'usageComplete']);
  binding(raw, command);
  if (raw.indexOperationId !== command.indexOperationId || raw.currentIndexBaselineId !== command.indexBaselineId) fail('SEMANTIC_IDENTITY_MISMATCH');
  if (!integer(raw.currentIndexWatermark) || raw.currentIndexWatermark < command.expectedIndexWatermark || !reason(raw.reason) || typeof raw.usageComplete !== 'boolean'
    || (raw.embeddingCalls !== null && !integer(raw.embeddingCalls, 2)) || (raw.usageComplete && raw.embeddingCalls === null)) fail();
  if (raw.state === 'absent') {
    if (raw.command !== null || raw.commandDigest !== null || raw.receipt !== null || raw.embeddingCalls !== null || raw.usageComplete !== false || raw.reason !== null) fail();
  } else if (raw.state === 'unknown' || raw.state === 'applied') {
    if (!same(validateMemoryIndexCommand(raw.command), command) || raw.commandDigest !== memoryIndexCommandDigest(command)) fail('SEMANTIC_IDENTITY_MISMATCH');
    if (raw.state === 'unknown') { if (raw.receipt !== null) fail(); }
    else {
      const receipt = validateMemoryIndexReceipt(raw.receipt, command);
      if (raw.reason !== null || raw.currentIndexWatermark < receipt.indexWatermark || raw.embeddingCalls !== receipt.embeddingCalls || raw.usageComplete !== true) fail();
    }
  } else fail();
  return structuredClone(raw) as unknown as MemoryIndexObservation;
}
export function validateMemorySearchResult(value: unknown, request: MemorySearchRequest, expected: SemanticMemoryBinding): MemorySearchResult {
  const raw = object(value, ['schemaVersion', 'backendId', 'deploymentId', 'scope', 'state', 'profileFingerprint', 'indexBaselineId', 'indexWatermark', 'queryDigest',
    'embeddingCalls', 'usageComplete', 'coverage', 'matches']);
  binding(raw, expected);
  if (raw.profileFingerprint !== request.profileFingerprint || raw.indexBaselineId !== request.expectedIndexBaselineId
    || raw.indexWatermark !== request.expectedIndexWatermark || raw.queryDigest !== memoryQueryDigest(request.query)) fail('SEMANTIC_IDENTITY_MISMATCH');
  const coverage = object(raw.coverage, ['eligibleCount', 'indexedCount', 'missingCount']);
  if (coverage.eligibleCount !== request.eligibleRefs.length || !integer(coverage.indexedCount, request.eligibleRefs.length)
    || !integer(coverage.missingCount, request.eligibleRefs.length) || coverage.indexedCount + coverage.missingCount !== coverage.eligibleCount
    || !integer(raw.embeddingCalls, 1) || raw.usageComplete !== true || !Array.isArray(raw.matches) || raw.matches.length > request.limit) fail();
  if (raw.state === 'index_required') {
    if (coverage.missingCount === 0 || raw.matches.length !== 0 || raw.embeddingCalls !== 0) fail();
  } else if (raw.state === 'ok') {
    if (coverage.missingCount !== 0 || (request.eligibleRefs.length === 0 && (raw.embeddingCalls !== 0 || raw.matches.length !== 0))) fail();
  } else fail();
  const eligible = new Map(request.eligibleRefs.map(ref => [ref.nativeId, ref])), seen = new Set<string>();
  let previous = Infinity;
  for (const value of raw.matches) {
    const match = object(value, ['memoryOperationId', 'nativeId', 'componentVersion', 'bodyDigest', 'indexReceiptId', 'indexWatermark', 'score']);
    const ref = typeof match.nativeId === 'string' ? eligible.get(match.nativeId) : undefined;
    if (!ref || seen.has(ref.nativeId) || match.memoryOperationId !== ref.memoryOperationId || match.componentVersion !== ref.componentVersion || match.bodyDigest !== ref.bodyDigest
      || !indexReceipt(match.indexReceiptId) || !integer(match.indexWatermark, request.expectedIndexWatermark, 1)
      || typeof match.score !== 'number' || !Number.isFinite(match.score) || match.score < -1.000001 || match.score > 1.000001 || match.score > previous) fail();
    seen.add(ref.nativeId); previous = match.score;
  }
  return structuredClone(raw) as unknown as MemorySearchResult;
}
