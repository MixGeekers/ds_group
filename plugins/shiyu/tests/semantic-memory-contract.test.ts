import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlledOmbreAdapter, ControlledOmbreError, type ControlledMemoryTransport } from '../src/adapters/ombre/controlled.js';
import { OMBRE_HARRIER_PROFILE_FINGERPRINT, memoryIndexCommandDigest, memoryQueryDigest, validateMemoryIndexCommand, validateMemorySearchRequest,
  type MemoryIndexCommand, type MemoryIndexObservation, type MemoryIndexReceipt, type MemorySearchRequest, type MemorySearchResult,
  type SemanticBackendStatus } from '../src/contracts/semantic-memory.js';

const now = Date.parse('2026-11-02T12:00:00.000Z');
const binding = { backendId: 'semantic-test', deploymentId: 'deployment-test', scope: 'local-owner' as const };
const baseline = 'index_' + 'a'.repeat(32), nativeId = 'shiyu_' + 'b'.repeat(32);
const command: MemoryIndexCommand = { schemaVersion: 1, kind: 'ensure-index', ...binding,
  indexOperationId: 'index-1', memoryOperationId: 'memory-1', bodyReceiptId: 'receipt_' + 'c'.repeat(64),
  nativeId, componentVersion: 'sha256:' + 'd'.repeat(64), bodyDigest: 'e'.repeat(64), profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT,
  indexBaselineId: baseline, expectedIndexWatermark: 0, deadlineAtMs: now + 30000, maxEmbeddingCalls: 2 };
const receipt = (): MemoryIndexReceipt => ({ schemaVersion: 2, ...binding, receiptId: 'index_receipt_' + 'f'.repeat(64),
  indexOperationId: command.indexOperationId, memoryOperationId: command.memoryOperationId, bodyReceiptId: command.bodyReceiptId,
  commandDigest: memoryIndexCommandDigest(command), nativeId, componentVersion: command.componentVersion, bodyDigest: command.bodyDigest,
  profileFingerprint: command.profileFingerprint, indexBaselineId: baseline, indexWatermark: 1,
  content: { digest: command.bodyDigest, vectorHash: '1'.repeat(64), dimensions: 1024 },
  meaning: { state: 'absent', digest: null, vectorHash: null, dimensions: null }, embeddingCalls: 1, observedAt: new Date(now).toISOString() });
const index = (): MemoryIndexObservation => ({ schemaVersion: 2, ...binding, indexOperationId: command.indexOperationId, state: 'applied',
  command, commandDigest: memoryIndexCommandDigest(command), receipt: receipt(), reason: null,
  currentIndexBaselineId: baseline, currentIndexWatermark: 1, embeddingCalls: 1, usageComplete: true });
const status = (): SemanticBackendStatus => ({ schemaVersion: 2, ...binding, semanticApi: true, profileFingerprint: command.profileFingerprint,
  indexBaselineId: baseline, indexWatermark: 1, recordedIndexedCount: 1, embeddingConfigured: true,
  limits: { maxEligibleRefs: 128, maxScannedRows: 2048, maxResults: 10, maxEmbeddingCallsPerIndex: 2, maxDeadlineMs: 60000 } });
const request = (): MemorySearchRequest => ({ scope: binding.scope, query: '合成查询 🪶', limit: 3, eligibleRefs: [{
  memoryOperationId: command.memoryOperationId, bodyReceiptId: command.bodyReceiptId, nativeId, componentVersion: command.componentVersion, bodyDigest: command.bodyDigest }],
  profileFingerprint: command.profileFingerprint, expectedIndexBaselineId: baseline, expectedIndexWatermark: 1, deadlineAtMs: command.deadlineAtMs });
const search = (input = request()): MemorySearchResult => ({ schemaVersion: 2, ...binding, state: 'ok', profileFingerprint: command.profileFingerprint,
  indexBaselineId: baseline, indexWatermark: 1, queryDigest: memoryQueryDigest(input.query), embeddingCalls: 1, usageComplete: true,
  coverage: { eligibleCount: input.eligibleRefs.length, indexedCount: input.eligibleRefs.length, missingCount: 0 }, matches: input.eligibleRefs.map(ref => ({
    memoryOperationId: ref.memoryOperationId, nativeId: ref.nativeId, componentVersion: ref.componentVersion, bodyDigest: ref.bodyDigest,
    indexReceiptId: receipt().receiptId, indexWatermark: 1, score: 0.8 })) });
const wire = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
function fixture(change: (name: string, value: any) => unknown = (_name, value) => value, clock = () => now) {
  const calls: Parameters<ControlledMemoryTransport['callTool']>[] = [];
  const adapter = new ControlledOmbreAdapter({ callTool: async (...args) => {
    calls.push(structuredClone([args[0], { timeoutMs: args[1]?.timeoutMs }]) as Parameters<ControlledMemoryTransport['callTool']>);
    const value = args[0].name === 'shiyu_memory_backend_status' ? status() : args[0].name === 'shiyu_memory_search_candidates' ? search(args[0].arguments as unknown as MemorySearchRequest) : index();
    return wire(change(args[0].name, structuredClone(value)));
  } }, binding, { semanticApi: true, now: clock });
  return { adapter, calls };
}

test('semantic profile pins the Python truncation/prefix contract, and commands reject hidden authority or ambiguous values', () => {
  assert.equal(OMBRE_HARRIER_PROFILE_FINGERPRINT, 'd3aa5e3e6aecf3cc147ea1f1c04ffad2fcfcb206271364f284f0d432fbc1111b');
  const copy = validateMemoryIndexCommand(command); copy.memoryOperationId = 'different'; assert.equal(command.memoryOperationId, 'memory-1');
  for (const patch of [{ body: 'must not enter metadata' }, { endpoint: 'http://127.0.0.1:9/v1/embeddings' }, { maxEmbeddingCalls: 3 },
    { deadlineAtMs: Infinity }, { expectedIndexWatermark: -1 }, { profileFingerprint: '0'.repeat(64) }, { nativeId: 'some-native-id' },
    { bodyReceiptId: 'receipt-unverified' }, { scope: 'another-owner' }]) assert.throws(() => validateMemoryIndexCommand({ ...command, ...patch }));
  let getterCalls = 0;
  assert.throws(() => validateMemoryIndexCommand({ ...command, get bodyDigest() { getterCalls++; return command.bodyDigest; } }));
  assert.equal(getterCalls, 0);
});

test('legacy adapters cannot discover or invoke semantic tools by accident', async () => {
  let calls = 0;
  const legacy = new ControlledOmbreAdapter({ callTool: async () => { calls++; return wire(status()); } }, binding);
  for (const action of [() => legacy.backendStatus(), () => legacy.ensureIndex(command), () => legacy.indexStatus(command), () => legacy.searchCandidates(request())]) {
    await assert.rejects(action(), (error: unknown) => error instanceof ControlledOmbreError && error.code === 'SEMANTIC_DISABLED');
  }
  assert.equal(calls, 0);
});

test('backend status is a pure typed observation and rejects foreign, disabled or incompatible responses', async () => {
  const f = fixture(); assert.deepEqual(await f.adapter.backendStatus(), status());
  assert.deepEqual(f.calls.map(([request]) => request), [{ name: 'shiyu_memory_backend_status', arguments: { scope: 'local-owner' } }]);
  for (const patch of [{ backendId: 'other' }, { deploymentId: 'other' }, { semanticApi: false }, { embeddingConfigured: false },
    { profileFingerprint: '0'.repeat(64) }, { indexBaselineId: 'new-unbound-baseline' }, { indexWatermark: -1 },
    { limits: { ...status().limits, maxEmbeddingCallsPerIndex: 20 } }, { body: 'unexpected source text' }]) {
    await assert.rejects(fixture((_name, value) => ({ ...value, ...patch })).adapter.backendStatus());
  }
});

test('index dispatch and independent status share immutable identity without performing an automatic retry', async () => {
  const f = fixture(); assert.equal((await f.adapter.ensureIndex(command)).state, 'applied');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0]![0], { name: 'shiyu_memory_index_ensure', arguments: { command, commandDigest: memoryIndexCommandDigest(command) } });
  const confirmed = await f.adapter.indexStatus(command); assert.deepEqual(confirmed.receipt, receipt());
  assert.deepEqual(f.calls.map(([request]) => request.name), ['shiyu_memory_index_ensure', 'shiyu_memory_index_status']);
  let attempts = 0;
  const failed = new ControlledOmbreAdapter({ callTool: async () => { attempts++; throw new Error('synthetic disconnect'); } }, binding, { semanticApi: true, now: () => now });
  await assert.rejects(failed.ensureIndex(command)); assert.equal(attempts, 1);
});

test('body, vector, meaning, watermark and observed usage each remain part of the independent index proof', async () => {
  const receiptChanges = [
    { deploymentId: 'other' }, { memoryOperationId: 'other' }, { bodyReceiptId: 'receipt_' + '9'.repeat(64) },
    { componentVersion: 'sha256:' + '9'.repeat(64) }, { bodyDigest: '9'.repeat(64) }, { indexWatermark: 0 },
    { content: { ...receipt().content, digest: '9'.repeat(64) } }, { content: { ...receipt().content, vectorHash: null } },
    { meaning: { state: 'absent', digest: '9'.repeat(64), vectorHash: null, dimensions: null } },
    { meaning: { state: 'indexed', digest: '9'.repeat(64), vectorHash: null, dimensions: 1024 } }, { embeddingCalls: 2 }, { text: 'forbidden' },
  ];
  for (const patch of receiptChanges) await assert.rejects(fixture((_name, value) => ({ ...value, receipt: { ...value.receipt, ...patch } })).adapter.indexStatus(command));
  const withMeaning = fixture((_name, value) => ({ ...value, receipt: { ...value.receipt, meaning: { state: 'indexed', digest: '2'.repeat(64), vectorHash: '3'.repeat(64), dimensions: 1024 } } }));
  assert.equal((await withMeaning.adapter.indexStatus(command)).receipt!.meaning.state, 'indexed');
  for (const patch of [{ currentIndexWatermark: 0 }, { usageComplete: false }, { embeddingCalls: null }]) await assert.rejects(fixture((_name, value) => ({ ...value, ...patch })).adapter.indexStatus(command));
});

test('unknown and absent remain distinguishable, and expired commands can still be explicitly reconciled', async () => {
  const unknown = fixture((_name, value) => ({ ...value, state: 'unknown', receipt: null, reason: 'NATIVE_MISMATCH', embeddingCalls: null, usageComplete: false }), () => now + 90000);
  assert.equal((await unknown.adapter.indexStatus(command)).state, 'unknown');
  await assert.rejects(unknown.adapter.ensureIndex(command), (error: unknown) => error instanceof ControlledOmbreError && error.code === 'DEADLINE_EXCEEDED');
  assert.equal(unknown.calls.length, 1);
  const absent = fixture((_name, value) => ({ ...value, state: 'absent', command: null, commandDigest: null, receipt: null, reason: null, embeddingCalls: null, usageComplete: false }));
  assert.equal((await absent.adapter.indexStatus(command)).state, 'absent');
  await assert.rejects(fixture((_name, value) => ({ ...value, state: 'unknown', receipt: null, embeddingCalls: null, usageComplete: true })).adapter.indexStatus(command));
});

test('search input stays bounded and cannot smuggle bodies, unordered identities or an incompatible profile', async () => {
  for (const patch of [{ query: '' }, { query: '\ud800' }, { query: '雪'.repeat(3000) }, { limit: 11 }, { limit: NaN },
    { eligibleRefs: [request().eligibleRefs[0], request().eligibleRefs[0]] }, { eligibleRefs: [{ ...request().eligibleRefs[0], body: 'private' }] },
    { profileFingerprint: '0'.repeat(64) }, { deadlineAtMs: 0 }, { scope: 'other' }]) assert.throws(() => validateMemorySearchRequest({ ...request(), ...patch }));
  const f = fixture(); const result = await f.adapter.searchCandidates(request());
  assert.equal(result.matches[0]!.nativeId, nativeId); assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(result).includes('合成查询'), false);
});

test('candidate IDs cannot expand the approved set and incomplete index coverage never yields matches', async () => {
  for (const patch of [{ nativeId: 'shiyu_' + '0'.repeat(32) }, { memoryOperationId: 'other' }, { bodyDigest: '0'.repeat(64) },
    { componentVersion: 'sha256:' + '0'.repeat(64) }, { score: Infinity }, { score: 1.2 }, { indexWatermark: 2 }, { body: 'leaked' }]) {
    await assert.rejects(fixture((_name, value) => ({ ...value, matches: [{ ...value.matches[0], ...patch }] })).adapter.searchCandidates(request()));
  }
  for (const patch of [{ queryDigest: '0'.repeat(64) }, { indexWatermark: 2 }, { coverage: { eligibleCount: 1, indexedCount: 0, missingCount: 1 } }, { usageComplete: false }]) {
    await assert.rejects(fixture((_name, value) => ({ ...value, ...patch })).adapter.searchCandidates(request()));
  }
  await assert.rejects(fixture((_name, value) => ({ ...value, matches: [...value.matches, ...value.matches] })).adapter.searchCandidates(request()));
  const required = fixture((_name, value) => ({ ...value, state: 'index_required', matches: [], embeddingCalls: 0, coverage: { eligibleCount: 1, indexedCount: 0, missingCount: 1 } }));
  assert.equal((await required.adapter.searchCandidates(request())).state, 'index_required');
});

test('an empty authorized set permits only an empty response with zero embedding calls', async () => {
  const input = { ...request(), eligibleRefs: [] };
  const empty = fixture((_name, value) => ({ ...value, embeddingCalls: 0 }));
  const result = await empty.adapter.searchCandidates(input); assert.deepEqual(result.matches, []); assert.equal(result.embeddingCalls, 0);
  await assert.rejects(fixture().adapter.searchCandidates(input));
});

test('fixed semantic deadlines and cancellation apply before dispatch and after the I/O result', async () => {
  let time = now;
  const f = fixture((_name, value) => { time += 30001; return value; }, () => time);
  await assert.rejects(f.adapter.ensureIndex(command, { timeoutMs: 5000 }), (error: unknown) => error instanceof ControlledOmbreError && error.code === 'DEADLINE_EXCEEDED');
  assert.equal(f.calls[0]![1]!.timeoutMs, 5000);
  const expired = fixture(); await assert.rejects(expired.adapter.searchCandidates({ ...request(), deadlineAtMs: now - 1 })); assert.equal(expired.calls.length, 0);
  await assert.rejects(expired.adapter.ensureIndex({ ...command, deadlineAtMs: now + 60001 })); assert.equal(expired.calls.length, 0);
  const cancel = new AbortController(); cancel.abort(); await assert.rejects(expired.adapter.ensureIndex(command, { signal: cancel.signal })); assert.equal(expired.calls.length, 0);
  const late = new AbortController(); const aborted = fixture((_name, value) => { late.abort(); return value; });
  await assert.rejects(aborted.adapter.searchCandidates(request(), { signal: late.signal })); assert.equal(aborted.calls.length, 1);
});

test('semantic MCP errors and conflicting representations are never interpreted as an empty successful search', async () => {
  for (const response of [{ ...wire(search()), isError: true }, { ...wire(search()), structuredContent: { ...search(), state: 'index_required' } },
    { content: [{ type: 'text', text: 'backend failed' }] }, { content: [{ type: 'text', text: JSON.stringify(search()) }, { type: 'text', text: 'extra' }] }]) {
    const adapter = new ControlledOmbreAdapter({ callTool: async () => response }, binding, { semanticApi: true, now: () => now });
    await assert.rejects(adapter.searchCandidates(request()));
  }
});
