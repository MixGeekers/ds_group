import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalMemorySearchService, LocalMemorySearchError, LocalMemoryIndexFailure, type LocalMemorySearchOptions, type LocalMemorySearchStore } from '../src/control/local-memory-search.js';
import { MemoryDomain, type MemoryDomainRequest, type MemoryCommands, type MemoryViewSource, type MemoryViewSnapshot, type LocalMemoryEntry } from '../src/adapters/control-store/memory-domain.js';
import { MemoryIndexDomain, type MemoryIndexRequest, type MemoryIndexCommands, type MemoryIndexEntry, type MemoryIndexPlan } from '../src/adapters/control-store/memory-index-domain.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import type { ConversationRecord } from '../src/control/conversations/index.js';
import { memoryBodyDigest, memoryCommandDigest, type MemoryBackendObservation } from '../src/contracts/memory.js';
import { canonicalSemanticMemory, memoryIndexCommandDigest, memoryQueryDigest, OMBRE_HARRIER_PROFILE_FINGERPRINT, type MemoryIndexCommand, type MemoryIndexObservation, type MemorySearchRequest, type MemorySearchResult, type SemanticBackendStatus } from '../src/contracts/semantic-memory.js';

const BODY = 'Synthetic memory: the silver notebook is on shelf five.', QUERY = 'Synthetic query: where is the notebook?';
const binding = { backendId: 'fixture-ombre', deploymentId: 'fixture-deployment', scope: 'local-owner' as const };
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : canonicalSemanticMemory(value)).digest('hex');
const errorCode = (expected: LocalMemorySearchError['code']) => (error: unknown) => error instanceof LocalMemorySearchError && error.code === expected;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
type Commands = MemoryCommands & MemoryIndexCommands;
function source(index: number): MemoryViewSource {
  const operationId = `memory-${index}`, sourceId = `source-${index}`, nativeId = `shiyu_${hash(operationId).slice(0, 32)}`, componentVersion = `sha256:${hash(BODY)}`;
  const command = { schemaVersion: 1 as const, kind: 'create' as const, operationId, backendId: binding.backendId, scope: binding.scope, targetRef: `target-${index}`, ...memoryBodyDigest(BODY), sourceRefs: [{ sourceId, revision: 1 }] };
  return { operationId, operationVersion: 1, sourceId, sourceRevision: 1, conversationId: 'conversation-1', targetRef: command.targetRef, nativeId, componentVersion, command, commandDigest: memoryCommandDigest(command),
    readToken: { operationId, operationVersion: 1, sourceId, sourceRevision: 1, audienceVersion: 1, authorizationEpoch: 1, saveMandateVersion: 1,
      deletionBaselineId: 'deletion-baseline', tombstoneWatermark: 0, installationGeneration: 'install-1', backendId: binding.backendId, deploymentId: binding.deploymentId, nativeId, componentVersion } };
}
function fixture(t: TestContext, config: Pick<LocalMemorySearchOptions, 'timeoutMs' | 'maxPending' | 'now'> = {}) {
  let sources = [source(1)], truncated = false, paused = false, dispatchAllowed = true, publishable = true, watermark = 1;
  let indexState: 'applied' | 'unknown' | 'absent' = 'applied', unknownCalls: number | null = null, searchState: 'ok' | 'index_required' = 'ok', searchCalls = 1;
  const calls: string[] = [], requests: { command: string; args: unknown }[] = [], indexes = new Map<string, MemoryIndexEntry>();
  const hooks: { allowed?: () => void | Promise<void>; afterStore?: (command: string, value: any) => void | Promise<void>; ensure?: () => void | Promise<void>; search?: () => void | Promise<void>; verify?: () => void | Promise<void>; status?: () => void | Promise<void>; backendStatus?: () => void | Promise<void> } = {};
  const pool = (): MemoryViewSnapshot => {
    const value = { schemaVersion: 1 as const, conversationId: 'conversation-1', authority: { ...binding, installationGeneration: 'install-1', authorizationEpoch: 1, deletionBaselineId: 'deletion-baseline', deletionScope: 'local-memory-source' as const, tombstoneWatermark: 0, installedAt: '2026-11-02T00:00:00.000Z' }, sources: structuredClone(sources), truncated };
    return { ...value, snapshotHash: hash(value), collectionHash: hash(sources) };
  };
  const read = (operationId: string): MemoryCommands['memory.readLocal']['output'] => {
    const current = sources.find(item => item.operationId === operationId); if (!current) throw new Error('Synthetic source is no longer readable');
    return { readToken: structuredClone(current.readToken), bodyReceiptId: `receipt_${hash(operationId)}`, entry: {
      requestId: `save-${operationId}`, conversationId: current.conversationId, source: { sourceId: current.sourceId, revision: current.sourceRevision },
      operation: { operationId, version: current.operationVersion }, command: current.command, reference: { ...binding, nativeId: current.nativeId, componentVersion: current.componentVersion, targetRef: current.targetRef, sourceId: current.sourceId }, canPublish: true,
    } as LocalMemoryEntry };
  };
  const status = (): SemanticBackendStatus => ({ schemaVersion: 2, ...binding, semanticApi: true, profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT,
    indexBaselineId: `index_${'1'.repeat(32)}`, indexWatermark: watermark, recordedIndexedCount: 1, embeddingConfigured: true,
    limits: { maxEligibleRefs: 128, maxScannedRows: 2048, maxResults: 10, maxEmbeddingCallsPerIndex: 2, maxDeadlineMs: 60000 } });
  function observation(command: MemoryIndexCommand): MemoryIndexObservation {
    const base = { schemaVersion: 2 as const, ...binding, indexOperationId: command.indexOperationId, currentIndexBaselineId: command.indexBaselineId, currentIndexWatermark: Math.max(watermark, command.expectedIndexWatermark + 1) };
    if (indexState === 'absent') return { ...base, state: 'absent', command: null, commandDigest: null, receipt: null, reason: null, embeddingCalls: null, usageComplete: false };
    if (indexState === 'unknown') return { ...base, state: 'unknown', command, commandDigest: memoryIndexCommandDigest(command), receipt: null, reason: 'UNCERTAIN', embeddingCalls: unknownCalls, usageComplete: false };
    return { ...base, state: 'applied', command, commandDigest: memoryIndexCommandDigest(command), reason: null, embeddingCalls: 1, usageComplete: true,
      receipt: { schemaVersion: 2, ...binding, receiptId: `index_receipt_${hash(command.indexOperationId)}`, indexOperationId: command.indexOperationId,
        memoryOperationId: command.memoryOperationId, bodyReceiptId: command.bodyReceiptId, commandDigest: memoryIndexCommandDigest(command), nativeId: command.nativeId, componentVersion: command.componentVersion, bodyDigest: command.bodyDigest,
        profileFingerprint: command.profileFingerprint, indexBaselineId: command.indexBaselineId, indexWatermark: command.expectedIndexWatermark + 1,
        content: { digest: command.bodyDigest, vectorHash: hash('synthetic-vector'), dimensions: 1024 }, meaning: { state: 'absent', digest: null, vectorHash: null, dimensions: null }, embeddingCalls: 1, observedAt: '2026-11-02T00:00:00.000Z' } };
  }
  const store: LocalMemorySearchStore = { async request<K extends keyof Commands>(command: K, args: Commands[K]['input']): Promise<Commands[K]['output']> {
    calls.push(command); requests.push({ command, args: structuredClone(args) }); const input = args as any; let result: any;
    if (command === 'memory.listEligibleForView') result = pool();
    else if (command === 'memory.readLocal') result = read(input.operationId);
    else if (command === 'memory.captureForView') { result = pool(); result.sources = input.operationIds.map((id: string) => { read(id); return sources.find(item => item.operationId === id)!; }); }
    else if (command === 'memory.index.prepare') {
      const old = [...indexes.values()].find(item => item.requestId === input.requestId);
      if (old) result = { duplicate: true, entry: old };
      else {
        const current = read(input.operationId), ref = current.entry.reference!, indexOperationId = `index-op-${indexes.size + 1}`;
        const indexCommand: MemoryIndexCommand = { schemaVersion: 1, kind: 'ensure-index', ...binding, indexOperationId, memoryOperationId: input.operationId, bodyReceiptId: current.bodyReceiptId,
          nativeId: ref.nativeId, componentVersion: ref.componentVersion, bodyDigest: current.entry.command.bodyDigest, profileFingerprint: input.backendStatus.profileFingerprint,
          indexBaselineId: input.backendStatus.indexBaselineId, expectedIndexWatermark: input.backendStatus.indexWatermark, deadlineAtMs: input.deadlineAtMs, maxEmbeddingCalls: 2 };
        const entry = { indexOperationId, requestId: input.requestId, command: indexCommand, effect: { status: 'pending' }, embeddingUsage: { maxEmbeddingCalls: 2, calls: null, complete: false }, publishable: false } as MemoryIndexEntry;
        indexes.set(indexOperationId, entry); result = { duplicate: false, entry };
      }
    } else {
      const entry = indexes.get(input.indexOperationId)!; assert.ok(entry);
      if (command === 'memory.index.claim' || command === 'memory.index.assertDispatch') {
        if (!dispatchAllowed) throw new Error('Synthetic authorization withdrawn');
        entry.effect.status = 'dispatching'; result = { entry, command: entry.command, claim: { effectId: `effect-${entry.indexOperationId}` } } as MemoryIndexPlan;
      } else if (command === 'memory.index.recordVerified') { entry.effect.status = 'succeeded'; entry.publishable = publishable; entry.observation = input.observation; entry.embeddingUsage = { maxEmbeddingCalls: 2, calls: input.observation.embeddingCalls, complete: input.observation.usageComplete }; result = entry; }
      else if (command === 'memory.index.markUnknown') { entry.effect.status = 'unknown'; entry.publishable = false; if (input.observation) entry.embeddingUsage = { maxEmbeddingCalls: 2, calls: input.observation.embeddingCalls, complete: input.observation.usageComplete }; result = entry; }
      else if (command === 'memory.index.cancel') { entry.effect.status = 'cancelled'; entry.embeddingUsage = { maxEmbeddingCalls: 2, calls: 0, complete: true }; result = entry; }
      else if (command === 'memory.index.get') { entry.publishable = entry.effect.status === 'succeeded' && publishable; result = entry; }
      else throw new Error(`Unexpected fixture command ${command}`);
    }
    const copy = structuredClone(result); await hooks.afterStore?.(command, copy); return copy as Commands[K]['output'];
  } };
  let lastSearch: MemorySearchRequest | undefined;
  const backend: LocalMemorySearchOptions['backend'] = {
    binding,
    async backendStatus() { calls.push('backend.status'); await hooks.backendStatus?.(); return status(); },
    async ensureIndex(command) { calls.push('backend.ensure'); await hooks.ensure?.(); return observation(command); },
    async indexStatus(command) { calls.push('backend.indexStatus'); await hooks.status?.(); return observation(command); },
    async searchCandidates(request) {
      calls.push('backend.search'); lastSearch = structuredClone(request); await hooks.search?.();
      const missing = searchState === 'index_required';
      return { schemaVersion: 2, ...binding, state: searchState, profileFingerprint: request.profileFingerprint, indexBaselineId: request.expectedIndexBaselineId, indexWatermark: request.expectedIndexWatermark,
        queryDigest: memoryQueryDigest(request.query), embeddingCalls: missing ? 0 : searchCalls, usageComplete: true,
        coverage: { eligibleCount: request.eligibleRefs.length, indexedCount: missing ? 0 : request.eligibleRefs.length, missingCount: missing ? request.eligibleRefs.length : 0 },
        matches: missing ? [] : request.eligibleRefs.slice(0, request.limit).map((ref, index) => ({ ...ref, indexReceiptId: `index_receipt_${hash(ref.memoryOperationId)}`, indexWatermark: 1, score: 0.9 - index * 0.1 })).map(({ bodyReceiptId: _bodyReceiptId, ...match }) => match) } as MemorySearchResult;
    },
    async verifyApplied(command) {
      calls.push('backend.verify'); await hooks.verify?.(); const current = source(Number(command.operationId.split('-')[1]));
      const observation: MemoryBackendObservation = { command, commandDigest: memoryCommandDigest(command), deploymentId: binding.deploymentId, nativeId: current.nativeId,
        receiptId: `receipt_${hash(command.operationId)}`, componentVersion: current.componentVersion, ...memoryBodyDigest(BODY), sourceRefs: command.sourceRefs, observedAt: '2026-11-02T00:00:00.000Z' };
      return { body: BODY, observation };
    },
  };
  const service = new LocalMemorySearchService({ store, backend, ...config, assertRuntimeAllowed: async () => { calls.push('allowed'); if (paused) throw new Error('Synthetic paused'); await hooks.allowed?.(); } });
  t.after(() => service.close());
  return { service, store, backend, hooks, calls, requests, indexes, pool, get sources() { return sources; }, set sources(value) { sources = value; },
    get lastSearch() { return lastSearch; }, pause() { paused = true; }, denyDispatch() { dispatchAllowed = false; }, revoke() { publishable = false; sources = []; },
    truncate() { truncated = true; }, moveIndex() { watermark++; }, unknownIndex(calls: number | null = null) { indexState = 'unknown'; unknownCalls = calls; }, absentIndex() { indexState = 'absent'; }, missingIndex() { searchState = 'index_required'; }, cachedQuery() { searchCalls = 0; },
    index: (signal?: AbortSignal) => service.index({ requestId: 'request-1', operationId: 'memory-1', signal }), search: (signal?: AbortSignal) => service.search({ conversationId: 'conversation-1', text: QUERY, signal }) };
}

test('index dispatch occurs once after the last authority read and only independent status settles it', async t => {
  const f = fixture(t), result = await f.index(); assert.equal(result.duplicate, false); assert.equal(result.entry.effect.status, 'succeeded');
  assert.equal(f.calls[f.calls.indexOf('backend.ensure') - 1], 'memory.index.assertDispatch');
  assert.ok(f.calls.indexOf('backend.indexStatus') > f.calls.indexOf('backend.ensure')); assert.ok(f.calls.indexOf('memory.index.recordVerified') > f.calls.indexOf('backend.indexStatus'));
  assert.deepEqual(result.entry.embeddingUsage, { maxEmbeddingCalls: 2, calls: 1, complete: true });
  assert.equal((await f.index()).duplicate, true); assert.equal(f.calls.filter(value => value === 'backend.ensure').length, 1);
  assert.ok(!JSON.stringify(f.requests).includes(BODY)); assert.ok(!JSON.stringify(f.requests).includes(QUERY));
});

test('unclaimed cancellation releases intent while a changed authority after an asynchronous gate never dispatches', async t => {
  const cancelled = fixture(t); cancelled.hooks.afterStore = command => { if (command === 'memory.index.prepare') cancelled.pause(); };
  await assert.rejects(cancelled.index(), LocalMemoryIndexFailure); assert.equal([...cancelled.indexes.values()][0]!.effect.status, 'cancelled'); assert.ok(!cancelled.calls.includes('backend.ensure'));
  const revoked = fixture(t); revoked.hooks.afterStore = command => { if (command === 'memory.index.claim') revoked.hooks.allowed = async () => { await Promise.resolve(); revoked.denyDispatch(); }; };
  await assert.rejects(revoked.index(), LocalMemoryIndexFailure); assert.ok(revoked.calls.includes('memory.index.assertDispatch')); assert.ok(!revoked.calls.includes('backend.ensure'));
});

test('unknown index outcomes are retained and a duplicate never replays the backend', async t => {
  const f = fixture(t); f.unknownIndex(); f.hooks.ensure = () => { throw new Error('Synthetic RPC outcome unknown'); };
  await assert.rejects(f.index(), error => error instanceof LocalMemoryIndexFailure && error.status === 'unknown' && error.embeddingUsage.calls === null);
  assert.equal(f.calls.filter(value => value === 'backend.indexStatus').length, 1);
  assert.equal((await f.index()).duplicate, true); assert.equal(f.calls.filter(value => value === 'backend.ensure').length, 1);
});

test('a late independent unknown observation preserves known partial usage after control cancellation', async t => {
  const f = fixture(t); f.unknownIndex(1);
  f.hooks.ensure = () => { [...f.indexes.values()][0]!.effect.status = 'unknown'; };
  await assert.rejects(f.index(), error => error instanceof LocalMemoryIndexFailure && error.status === 'unknown' && error.embeddingUsage.calls === 1 && !error.embeddingUsage.complete);
  assert.equal(f.calls.filter(value => value === 'memory.index.markUnknown').length, 1);
  assert.equal((f.requests.find(row => row.command === 'memory.index.markUnknown')!.args as { observation: MemoryIndexObservation }).observation.embeddingCalls, 1);
});

test('late observed indexing success settles facts but pause, withdrawal and close release no success', async t => {
  for (const mode of ['pause', 'withdraw', 'cancel'] as const) {
    const f = fixture(t), controller = new AbortController(); f.hooks.ensure = () => { if (mode === 'pause') f.pause(); else if (mode === 'withdraw') f.revoke(); else controller.abort(); };
    await assert.rejects(f.index(controller.signal)); await f.service.drain();
    const entry = [...f.indexes.values()][0]!; assert.equal(entry.effect.status, 'succeeded'); assert.equal(entry.embeddingUsage.calls, 1);
    assert.equal(f.calls.filter(value => value === 'backend.ensure').length, 1); assert.ok(f.calls.includes('backend.indexStatus'));
  }
});

test('search captures only this conversation, sorts eligible refs, returns at most five metadata matches and never persists text', async t => {
  const f = fixture(t); f.sources = Array.from({ length: 8 }, (_, i) => source(i + 1)); const result = await f.search();
  assert.equal(result.operationIds.length, 5); assert.equal(result.matches.length, 5); assert.equal(f.lastSearch!.limit, 5);
  assert.deepEqual(f.lastSearch!.eligibleRefs.map(ref => ref.nativeId), f.lastSearch!.eligibleRefs.map(ref => ref.nativeId).sort());
  assert.deepEqual(result.embeddingUsage, { calls: 1, complete: true }); assert.ok(result.index); assert.ok(!JSON.stringify(result).includes(QUERY)); assert.ok(!JSON.stringify(result).includes(BODY));
  assert.ok(!JSON.stringify(f.requests).includes(QUERY)); assert.equal(f.calls.at(-1), 'memory.listEligibleForView');
});

test('no eligible memory performs zero backend calls, and over 128 or truncated pools refuse incomplete search', async t => {
  const empty = fixture(t); empty.sources = []; assert.deepEqual((await empty.search()).embeddingUsage, { calls: 0, complete: true }); assert.ok(!empty.calls.some(value => value.startsWith('backend.')));
  for (const mode of ['over', 'truncated']) { const f = fixture(t); if (mode === 'over') f.sources = Array.from({ length: 129 }, (_, index) => source(index + 1)); else f.truncate(); await assert.rejects(f.search(), errorCode('TOO_MANY_CANDIDATES')); assert.ok(!f.calls.some(value => value.startsWith('backend.'))); }
});

test('missing indexes are explicit diagnostics and select cannot disguise them as empty hits', async t => {
  const f = fixture(t); f.missingIndex(); const diagnostic = await f.search(); assert.equal(diagnostic.state, 'index_required'); assert.equal(diagnostic.coverage.missingCount, 1);
  assert.deepEqual(diagnostic.embeddingUsage, { calls: 0, complete: true }); await assert.rejects(f.service.select({ conversationId: 'conversation-1', text: QUERY }), errorCode('INDEX_REQUIRED'));
});

test('final validation rejects mutations to nonmatching candidates, new sources and index watermark, preserving known query usage', async t => {
  for (const mode of ['nonmatch', 'new-source', 'watermark']) {
    const f = fixture(t); f.sources = Array.from({ length: 6 }, (_, i) => source(i + 1));
    f.hooks.search = () => { if (mode === 'watermark') f.moveIndex(); else if (mode === 'new-source') f.sources = [...f.sources, source(7)]; else { const id = f.lastSearch!.eligibleRefs.at(-1)!.memoryOperationId; f.sources.find(item => item.operationId === id)!.readToken.authorizationEpoch++; } };
    await assert.rejects(f.search(), error => error instanceof LocalMemorySearchError && error.code === 'STALE_SELECTION' && error.embeddingUsage.calls === 1 && error.embeddingUsage.complete);
  }
});

test('search transport failure leaves usage unknown; cache hits retain observed zero', async t => {
  const failed = fixture(t); failed.hooks.search = () => { throw new Error('Synthetic private backend body must not escape'); };
  await assert.rejects(failed.search(), error => error instanceof LocalMemorySearchError && error.embeddingUsage.calls === null && !error.embeddingUsage.complete && !error.message.includes('private'));
  const cached = fixture(t); cached.cachedQuery(); assert.deepEqual((await cached.search()).embeddingUsage, { calls: 0, complete: true });
});

test('exact body read verifies applied receipt then freshly compares source and readToken', async t => {
  const f = fixture(t), captured = f.pool().sources[0]!; assert.equal((await f.service.read(captured)).body, BODY);
  assert.deepEqual(f.calls.filter(value => value !== 'allowed'), ['memory.readLocal', 'backend.verify', 'memory.captureForView']);
  for (const mode of ['withdraw', 'token', 'pause']) { const race = fixture(t), source = race.pool().sources[0]!; race.hooks.verify = () => { if (mode === 'withdraw') race.revoke(); else if (mode === 'pause') race.pause(); else race.sources[0]!.readToken.authorizationEpoch++; }; await assert.rejects(race.service.read(source)); }
  const wrong = fixture(t), foreign = wrong.pool().sources[0]!; foreign.conversationId = 'foreign-conversation'; await assert.rejects(wrong.service.read(foreign), errorCode('STALE_READ')); assert.ok(!wrong.calls.includes('backend.verify'));
});

test('queued requests keep their absolute deadline and close drains non-cooperative in-flight work before releasing the slot', async t => {
  const f = fixture(t, { timeoutMs: 30, maxPending: 2 }), held = deferred(), entered = deferred(); f.hooks.search = async () => { entered.resolve(); await held.promise; };
  const first = f.search(); const firstRejected = assert.rejects(first, errorCode('TIMEOUT')); await entered.promise;
  const second = f.search(); const secondRejected = assert.rejects(second, errorCode('TIMEOUT'));
  await assert.rejects(f.search(), errorCode('CAPACITY')); await delay(40); await Promise.all([firstRejected, secondRejected]);
  let drained = false; const closing = f.service.close().then(() => { drained = true; }); await Promise.resolve(); assert.equal(drained, false);
  held.resolve(); await closing; assert.equal(f.calls.filter(value => value === 'backend.search').length, 1); await assert.rejects(f.search(), errorCode('CLOSED'));
});

test('public input rejects authority, profile, IDs, body and limits before any work', t => {
  const f = fixture(t);
  for (const patch of [{ scope: 'other' }, { limit: 128 }, { eligibleRefs: [] }, { profileFingerprint: 'caller' }, { body: BODY }]) assert.throws(() => f.service.search({ conversationId: 'conversation-1', text: QUERY, ...patch } as never), errorCode('INVALID_INPUT'));
  assert.throws(() => f.service.index({ requestId: 'request-1', operationId: 'memory-1', backendStatus: {} } as never), errorCode('INVALID_INPUT'));
  assert.deepEqual(f.calls, []);
});

test('real control domains settle the synthetic independent proof and reject withdrawal inside the final asynchronous gate', async t => {
  for (const revoke of [false, true]) {
    const f = fixture(t), db = new DatabaseSync(':memory:'), tx = new SqliteTransactions(db), at = new Date().toISOString();
    const runtimeIdentity = { installationGeneration: 'install-integration', hostEpoch: 'host-integration' };
    const conversation: ConversationRecord = { conversationId: 'conversation-1', key: { connectionId: 'local-synthetic', platformConversationId: 'synthetic', kind: 'direct', scope: 'local-owner' }, revision: 1, audienceVersion: 1, conversationGeneration: 1, archived: false, createdAt: at, updatedAt: at };
    const memory = new MemoryDomain(db, tx, { runtimeIdentity, ...binding, getConversation: () => conversation });
    const indexes = new MemoryIndexDomain(db, tx, { runtimeIdentity, ...binding, memory });
    const digest = memoryBodyDigest(BODY), prepared = memory.prepareLocal({ requestId: 'synthetic-save', conversationId: conversation.conversationId, bodyDigest: digest.bodyDigest, bytes: digest.bodyBytes });
    const claim = memory.claim({ operationId: prepared.operation.operationId })!;
    memory.recordVerifiedReceipt({ operationId: prepared.operation.operationId, claim: claim.claim, reconciliation: false, observation: {
      command: prepared.command, commandDigest: memoryCommandDigest(prepared.command), deploymentId: binding.deploymentId,
      nativeId: `shiyu_${hash(prepared.operation.operationId).slice(0, 32)}`, receiptId: `receipt_${hash(prepared.operation.operationId)}`, componentVersion: `sha256:${hash(BODY)}`,
      ...digest, sourceRefs: prepared.command.sourceRefs, observedAt: at,
    } });
    let claimed = false;
    const store: LocalMemorySearchStore = { async request<K extends keyof Commands>(command: K, args: Commands[K]['input']): Promise<Commands[K]['output']> {
      const result = command.startsWith('memory.index.') ? indexes.execute({ command, args } as MemoryIndexRequest) : memory.execute({ command, args } as MemoryDomainRequest);
      if (command === 'memory.index.claim') claimed = true; return result as Commands[K]['output'];
    } };
    const service = new LocalMemorySearchService({ store, backend: f.backend, assertRuntimeAllowed: async () => {
      if (revoke && claimed) { await Promise.resolve(); memory.withdrawLocal({ requestId: 'synthetic-withdraw', operationId: prepared.operation.operationId }); }
    } });
    try {
      const action = service.index({ requestId: 'synthetic-index', operationId: prepared.operation.operationId });
      if (revoke) { await assert.rejects(action, LocalMemoryIndexFailure); assert.ok(!f.calls.includes('backend.ensure')); }
      else { const result = await action; assert.equal(result.entry.effect.status, 'succeeded'); assert.equal(result.entry.publishable, true); assert.equal(result.entry.embeddingUsage.calls, 1); assert.equal(result.entry.reservation.observed.effects, 1); }
    } finally { await service.close(); db.close(); }
  }
});
