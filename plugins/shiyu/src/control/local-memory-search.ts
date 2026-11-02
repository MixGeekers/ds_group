import type { MemoryCommands, MemoryViewSnapshot, MemoryViewSource } from '../adapters/control-store/memory-domain.js';
import type { MemoryIndexCommands, MemoryIndexEntry, MemoryIndexPlan } from '../adapters/control-store/memory-index-domain.js';
import type { ControlledOmbreAdapter } from '../adapters/ombre/controlled.js';
import { assertMemoryBody, canonicalMemoryCommand, memoryCommandDigest, type MemoryBackendObservation } from '../contracts/memory.js';
import { canonicalMemoryIndexCommand, canonicalSemanticMemory, memoryQueryDigest, validateMemoryIndexObservation, validateMemorySearchResult,
  validateSemanticBackendStatus, type MemoryIndexObservation, type MemorySearchRequest, type MemorySearchResult } from '../contracts/semantic-memory.js';

type Commands = MemoryCommands & MemoryIndexCommands;
export interface LocalMemorySearchStore { request<K extends keyof Commands>(command: K, args: Commands[K]['input']): Promise<Commands[K]['output']> }
export interface LocalMemorySearchOptions {
  store: LocalMemorySearchStore;
  backend: Pick<ControlledOmbreAdapter, 'binding' | 'backendStatus' | 'ensureIndex' | 'indexStatus' | 'searchCandidates' | 'verifyApplied'>;
  assertRuntimeAllowed(): void | Promise<void>;
  now?: () => Date; timeoutMs?: number; maxPending?: number;
}
export interface LocalMemoryEmbeddingUsage { calls: number | null; complete: boolean }
export interface LocalMemoryIndexInput { requestId: string; operationId: string; signal?: AbortSignal }
export interface LocalMemorySearchInput { conversationId: string; text: string; signal?: AbortSignal }
export interface LocalMemoryIndexResult { duplicate: boolean; entry: MemoryIndexEntry }
export interface LocalMemoryIndexVersion { profileFingerprint: string; indexBaselineId: string; indexWatermark: number }
export interface LocalMemorySelection { operationIds: string[]; index?: LocalMemoryIndexVersion; embeddingUsage: LocalMemoryEmbeddingUsage }
export interface LocalMemorySearchResult extends LocalMemorySelection {
  state: 'ok' | 'index_required'; coverage: MemorySearchResult['coverage'];
  matches: { operationId: string; score: number; indexReceiptId: string; indexWatermark: number }[];
}
export class LocalMemorySearchError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'CAPACITY' | 'CLOSED' | 'CANCELLED' | 'TIMEOUT' | 'DISPATCH_UNAVAILABLE' | 'BACKEND_MISMATCH'
    | 'INDEX_UNSETTLED' | 'INDEX_REQUIRED' | 'STALE_SELECTION' | 'TOO_MANY_CANDIDATES' | 'STALE_READ' | 'BACKEND_FAILED' | 'OUTCOME_UNCONFIRMED',
    readonly embeddingUsage: LocalMemoryEmbeddingUsage = { calls: null, complete: false }) {
    super(`Local memory search ${code.toLowerCase().replaceAll('_', ' ')}`); this.name = 'LocalMemorySearchError';
  }
}
export class LocalMemoryIndexFailure extends Error {
  constructor(readonly indexOperationId: string, readonly status: MemoryIndexEntry['effect']['status'], readonly embeddingUsage: MemoryIndexEntry['embeddingUsage']) {
    super('Local memory index result is not currently releasable; do not replay automatically'); this.name = 'LocalMemoryIndexFailure';
  }
}
interface Pending { cancel: AbortController; expiry: AbortController; signal: AbortSignal; deadline: number; done: Promise<unknown> }
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,149}$/.test(value);
const same = (a: unknown, b: unknown) => canonicalSemanticMemory(a) === canonicalSemanticMemory(b);
const noEmbedding = (): LocalMemoryEmbeddingUsage => ({ calls: 0, complete: true });
function fields(value: unknown, keys: string[], required: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new LocalMemorySearchError('INVALID_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(value => !Object.hasOwn(value, 'value'))) throw new LocalMemorySearchError('INVALID_INPUT');
}
function reason(error: unknown): string { return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'LOCAL_INDEX_FAILED'; }
function untilCancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
  });
}

/** Private bounded composition. Search text/body never enters a control-store command. */
export class LocalMemorySearchService {
  private closed = false; private closing?: Promise<void>; private tail: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<Pending>(); private readonly timeoutMs: number; private readonly maxPending: number;
  constructor(private readonly options: LocalMemorySearchOptions) {
    this.timeoutMs = options.timeoutMs ?? 30000; this.maxPending = options.maxPending ?? 32;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000 || !Number.isSafeInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 32) throw new LocalMemorySearchError('INVALID_INPUT');
  }
  private now(): number { return (this.options.now?.() ?? new Date()).getTime(); }
  private remaining(pending: Pending): number { const left = pending.deadline - this.now(); if (left <= 0 || pending.expiry.signal.aborted) throw new LocalMemorySearchError('TIMEOUT'); return Math.max(1, Math.floor(left)); }
  private check(pending: Pending): void { if (this.closed) throw new LocalMemorySearchError('CLOSED'); pending.signal.throwIfAborted(); this.remaining(pending); }
  private async allowed(pending: Pending): Promise<void> { this.check(pending); await this.options.assertRuntimeAllowed(); this.check(pending); }
  private enqueue<T>(signal: AbortSignal | undefined, action: (pending: Pending) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new LocalMemorySearchError('CLOSED'));
    if (this.pending.size >= this.maxPending) return Promise.reject(new LocalMemorySearchError('CAPACITY'));
    const cancel = new AbortController(), expiry = new AbortController(), abort = () => cancel.abort(new LocalMemorySearchError('CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const pending: Pending = { cancel, expiry, signal: AbortSignal.any([cancel.signal, expiry.signal]), deadline: this.now() + this.timeoutMs, done: Promise.resolve() };
    const timer = setTimeout(() => expiry.abort(new LocalMemorySearchError('TIMEOUT')), this.timeoutMs);
    // Caller cancellation does not release the serial slot before late facts settle.
    const work = this.tail.catch(() => {}).then(() => action(pending)).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(pending); });
    pending.done = work; this.tail = work; this.pending.add(pending); return untilCancelled(work, pending.signal);
  }
  index(input: LocalMemoryIndexInput): Promise<LocalMemoryIndexResult> {
    fields(input, ['requestId', 'operationId', 'signal'], ['requestId', 'operationId']);
    if (!identity(input.requestId) || !identity(input.operationId)) throw new LocalMemorySearchError('INVALID_INPUT');
    const captured = { requestId: input.requestId, operationId: input.operationId };
    return this.enqueue(input.signal, pending => this.ensureIndex(captured, pending));
  }
  private async ensureIndex(input: Omit<LocalMemoryIndexInput, 'signal'>, pending: Pending): Promise<LocalMemoryIndexResult> {
    let entry: MemoryIndexEntry | undefined, plan: MemoryIndexPlan | undefined, ownsIntent = false, observed: MemoryIndexObservation | undefined;
    try {
      await this.allowed(pending);
      const backendStatus = validateSemanticBackendStatus(await this.options.backend.backendStatus({ signal: pending.signal, timeoutMs: this.remaining(pending) }), this.options.backend.binding);
      await this.allowed(pending);
      const prepared = await this.options.store.request('memory.index.prepare', { ...input, backendStatus, deadlineAtMs: pending.deadline }); entry = prepared.entry;
      if (prepared.duplicate) { await this.allowed(pending); return { duplicate: true, entry }; }
      ownsIntent = true; await this.allowed(pending);
      plan = await this.options.store.request('memory.index.claim', { indexOperationId: entry.indexOperationId, leaseMs: this.remaining(pending) });
      if (!plan) throw new LocalMemorySearchError('DISPATCH_UNAVAILABLE');
      await this.allowed(pending);
      const admitted = await this.options.store.request('memory.index.assertDispatch', { indexOperationId: entry.indexOperationId, claim: plan.claim });
      if (canonicalMemoryIndexCommand(admitted.command) !== canonicalMemoryIndexCommand(entry.command) || admitted.command.memoryOperationId !== input.operationId
        || admitted.command.backendId !== this.options.backend.binding.backendId || admitted.command.deploymentId !== this.options.backend.binding.deploymentId
        || admitted.command.scope !== this.options.backend.binding.scope || admitted.command.deadlineAtMs > pending.deadline) throw new LocalMemorySearchError('BACKEND_MISMATCH');
      this.check(pending);
      // No asynchronous lifecycle gate may separate the final authority read and dispatch.
      let dispatchError: unknown;
      try { await this.options.backend.ensureIndex(admitted.command, { signal: pending.signal, timeoutMs: this.remaining(pending) }); } catch (error) { dispatchError = error; }
      // Independently observe effects even after a caller cancels, within the original deadline.
      observed = validateMemoryIndexObservation(await this.options.backend.indexStatus(admitted.command, { signal: pending.expiry.signal, timeoutMs: this.remaining(pending) }), admitted.command);
      if (observed.state !== 'applied') throw dispatchError ?? new LocalMemorySearchError('INDEX_UNSETTLED');
      entry = await this.options.store.request('memory.index.recordVerified', { indexOperationId: entry.indexOperationId, claim: plan.claim, observation: observed });
      await this.allowed(pending);
      entry = await this.options.store.request('memory.index.get', { indexOperationId: entry.indexOperationId }); this.check(pending);
      if (!entry.publishable || entry.effect.status !== 'succeeded') throw new LocalMemorySearchError('STALE_READ');
      return { duplicate: false, entry };
    } catch (error) {
      if (!entry || !ownsIntent) throw error instanceof LocalMemorySearchError ? error : new LocalMemorySearchError('BACKEND_FAILED');
      try {
        entry = await this.options.store.request('memory.index.get', { indexOperationId: entry.indexOperationId });
        if (entry.effect.status !== 'succeeded' && (entry.effect.status !== 'unknown' || observed?.state === 'unknown')) {
          entry = plan ? await this.options.store.request('memory.index.markUnknown', { indexOperationId: entry.indexOperationId, claim: plan.claim, reasonCode: reason(error), ...(observed?.state === 'unknown' ? { observation: observed } : {}) })
            : await this.options.store.request('memory.index.cancel', { indexOperationId: entry.indexOperationId, reasonCode: reason(error) });
        }
      } catch { throw new LocalMemorySearchError('OUTCOME_UNCONFIRMED'); }
      throw new LocalMemoryIndexFailure(entry.indexOperationId, entry.effect.status, entry.embeddingUsage);
    }
  }
  search(input: LocalMemorySearchInput): Promise<LocalMemorySearchResult> {
    fields(input, ['conversationId', 'text', 'signal'], ['conversationId', 'text']);
    if (!identity(input.conversationId)) throw new LocalMemorySearchError('INVALID_INPUT');
    try { memoryQueryDigest(input.text); } catch { throw new LocalMemorySearchError('INVALID_INPUT'); }
    const captured = { conversationId: input.conversationId, text: input.text };
    return this.enqueue(input.signal, pending => this.find(captured, pending));
  }
  async select(input: LocalMemorySearchInput): Promise<LocalMemorySelection> {
    const result = await this.search(input);
    if (result.state === 'index_required') throw new LocalMemorySearchError('INDEX_REQUIRED', result.embeddingUsage);
    return { operationIds: result.operationIds, ...(result.index ? { index: result.index } : {}), embeddingUsage: result.embeddingUsage };
  }
  private pool(snapshot: MemoryViewSnapshot, conversationId: string): void {
    if (snapshot.conversationId !== conversationId || snapshot.authority.backendId !== this.options.backend.binding.backendId || snapshot.authority.deploymentId !== this.options.backend.binding.deploymentId
      || snapshot.sources.some(source => source.conversationId !== conversationId) || new Set(snapshot.sources.map(source => source.operationId)).size !== snapshot.sources.length) throw new LocalMemorySearchError('BACKEND_MISMATCH');
    if (snapshot.truncated || snapshot.sources.length > 128) throw new LocalMemorySearchError('TOO_MANY_CANDIDATES', noEmbedding());
  }
  private exactSource(source: MemoryViewSource, read: Commands['memory.readLocal']['output']): boolean {
    const { entry, readToken } = read, ref = entry.reference;
    return Boolean(ref && source.operationId === entry.operation.operationId && source.operationVersion === entry.operation.version
      && source.sourceId === entry.source.sourceId && source.sourceRevision === entry.source.revision && source.conversationId === entry.conversationId
      && source.targetRef === ref.targetRef && source.nativeId === ref.nativeId && source.componentVersion === ref.componentVersion
      && source.commandDigest === memoryCommandDigest(entry.command) && canonicalMemoryCommand(source.command) === canonicalMemoryCommand(entry.command) && same(source.readToken, readToken));
  }
  private async find(input: Omit<LocalMemorySearchInput, 'signal'>, pending: Pending): Promise<LocalMemorySearchResult> {
    let usage: LocalMemoryEmbeddingUsage = noEmbedding();
    try {
      await this.allowed(pending);
      const captured = await this.options.store.request('memory.listEligibleForView', { conversationId: input.conversationId }); this.pool(captured, input.conversationId);
      if (!captured.sources.length) {
        await this.allowed(pending); const current = await this.options.store.request('memory.listEligibleForView', { conversationId: input.conversationId }); this.check(pending);
        if (!same(current, captured)) throw new LocalMemorySearchError('STALE_SELECTION');
        return { state: 'ok', operationIds: [], coverage: { eligibleCount: 0, indexedCount: 0, missingCount: 0 }, matches: [], embeddingUsage: usage };
      }
      const status = validateSemanticBackendStatus(await this.options.backend.backendStatus({ signal: pending.signal, timeoutMs: this.remaining(pending) }), this.options.backend.binding);
      const eligibleRefs: MemorySearchRequest['eligibleRefs'] = [];
      for (const source of captured.sources) {
        this.check(pending); const read = await this.options.store.request('memory.readLocal', { operationId: source.operationId });
        if (!this.exactSource(source, read)) throw new LocalMemorySearchError('STALE_SELECTION');
        eligibleRefs.push({ memoryOperationId: source.operationId, bodyReceiptId: read.bodyReceiptId, nativeId: source.nativeId, componentVersion: source.componentVersion, bodyDigest: source.command.bodyDigest });
      }
      await this.allowed(pending);
      const before = await this.options.store.request('memory.listEligibleForView', { conversationId: input.conversationId }); this.check(pending);
      if (!same(before, captured)) throw new LocalMemorySearchError('STALE_SELECTION');
      const request: MemorySearchRequest = { scope: 'local-owner', query: input.text, limit: 5, eligibleRefs: eligibleRefs.sort((a, b) => a.nativeId.localeCompare(b.nativeId)),
        profileFingerprint: status.profileFingerprint, expectedIndexBaselineId: status.indexBaselineId, expectedIndexWatermark: status.indexWatermark, deadlineAtMs: pending.deadline };
      usage = { calls: null, complete: false };
      const result = validateMemorySearchResult(await this.options.backend.searchCandidates(request, { signal: pending.signal, timeoutMs: this.remaining(pending) }), request, this.options.backend.binding);
      usage = { calls: result.embeddingCalls, complete: result.usageComplete };
      const after = validateSemanticBackendStatus(await this.options.backend.backendStatus({ signal: pending.signal, timeoutMs: this.remaining(pending) }), this.options.backend.binding);
      if (after.profileFingerprint !== status.profileFingerprint || after.indexBaselineId !== status.indexBaselineId || after.indexWatermark !== status.indexWatermark) throw new LocalMemorySearchError('STALE_SELECTION');
      await this.allowed(pending);
      // Recheck the entire eligible pool, including sources that did not rank into the result.
      const current = await this.options.store.request('memory.listEligibleForView', { conversationId: input.conversationId }); this.check(pending);
      if (!same(current, captured)) throw new LocalMemorySearchError('STALE_SELECTION');
      return { state: result.state, operationIds: result.matches.map(match => match.memoryOperationId), index: { profileFingerprint: result.profileFingerprint, indexBaselineId: result.indexBaselineId, indexWatermark: result.indexWatermark },
        coverage: result.coverage, matches: result.matches.map(match => ({ operationId: match.memoryOperationId, score: match.score, indexReceiptId: match.indexReceiptId, indexWatermark: match.indexWatermark })), embeddingUsage: usage };
    } catch (error) { throw new LocalMemorySearchError(error instanceof LocalMemorySearchError ? error.code : 'BACKEND_FAILED', usage); }
  }
  read(source: MemoryViewSource, signal?: AbortSignal): Promise<{ body: string; observation: MemoryBackendObservation }> {
    if (!source || !identity(source.operationId) || !identity(source.conversationId)) throw new LocalMemorySearchError('INVALID_INPUT');
    const captured = structuredClone(source);
    return this.enqueue(signal, async pending => {
      await this.allowed(pending);
      const before = await this.options.store.request('memory.readLocal', { operationId: captured.operationId });
      if (!this.exactSource(captured, before) || captured.readToken.backendId !== this.options.backend.binding.backendId || captured.readToken.deploymentId !== this.options.backend.binding.deploymentId) throw new LocalMemorySearchError('STALE_READ');
      const verified = await this.options.backend.verifyApplied(before.entry.command, { signal: pending.signal, timeoutMs: this.remaining(pending) });
      await this.allowed(pending);
      const after = await this.options.store.request('memory.captureForView', { conversationId: captured.conversationId, operationIds: [captured.operationId] }); this.check(pending);
      if (after.truncated || after.sources.length !== 1 || !same(after.sources[0], captured) || verified.observation.receiptId !== before.bodyReceiptId
        || verified.observation.nativeId !== captured.nativeId || verified.observation.componentVersion !== captured.componentVersion || verified.observation.deploymentId !== captured.readToken.deploymentId
        || canonicalMemoryCommand(verified.observation.command) !== canonicalMemoryCommand(captured.command)) throw new LocalMemorySearchError('STALE_READ');
      assertMemoryBody(captured.command, verified.body); return { body: verified.body, observation: verified.observation };
    });
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending].map(pending => pending.done)); }
  close(): Promise<void> { if (this.closing) return this.closing; this.closed = true; for (const pending of this.pending) pending.cancel.abort(new LocalMemorySearchError('CLOSED')); return this.closing = this.drain(); }
}
