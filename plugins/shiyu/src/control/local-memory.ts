import type { MemoryCommands, LocalMemoryEntry, MemoryDispatchPlan } from '../adapters/control-store/memory-domain.js';
import type { ControlledOmbreAdapter } from '../adapters/ombre/controlled.js';
import { assertMemoryBody, canonicalMemoryCommand, memoryBodyDigest } from '../contracts/memory.js';

export interface LocalMemoryStore {
  request<K extends keyof MemoryCommands>(command: K, args: MemoryCommands[K]['input']): Promise<MemoryCommands[K]['output']>;
}
export interface LocalMemoryOptions {
  store: LocalMemoryStore;
  backend: Pick<ControlledOmbreAdapter, 'binding' | 'create' | 'verifyApplied'>;
  /** Trusted lifecycle/owner gate, never supplied by a public request. */
  assertRuntimeAllowed(): void | Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
  maxPending?: number;
}
export interface LocalRememberInput { requestId: string; conversationId: string; text: string; signal?: AbortSignal }
export interface LocalMemoryReadInput { operationId: string; signal?: AbortSignal }
export interface LocalRememberResult { duplicate: boolean; entry: LocalMemoryEntry }
export interface LocalMemoryReadResult { entry: LocalMemoryEntry; body: string }
export class LocalMemoryError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'CAPACITY' | 'CLOSED' | 'CANCELLED' | 'TIMEOUT' | 'DISPATCH_UNAVAILABLE' | 'BACKEND_UNSETTLED' | 'STALE_READ' | 'BACKEND_MISMATCH') {
    super(`Local memory ${code.toLowerCase().replaceAll('_', ' ')}`); this.name = 'LocalMemoryError';
  }
}
export class LocalMemoryFailure extends Error {
  constructor(readonly operationId: string, readonly status: LocalMemoryEntry['operation']['status']) {
    super('Local memory did not produce a currently authorized result; do not replay automatically'); this.name = 'LocalMemoryFailure';
  }
}
interface Pending {
  cancel: AbortController; expiry: AbortController; signal: AbortSignal; deadline: number; done: Promise<unknown>;
}
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._\/-]{0,149}$/.test(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
function fields(value: unknown, permitted: string[], required: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new LocalMemoryError('INVALID_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !permitted.includes(key)) || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(field => !Object.hasOwn(field, 'value'))) throw new LocalMemoryError('INVALID_INPUT');
}
function untilCancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
  });
}
function reason(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'LOCAL_MEMORY_FAILED';
}

/** Serial private control orchestration. Bodies exist only in this call, never in control-store commands. */
export class LocalMemoryService {
  private closed = false;
  private closing?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<Pending>();
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  constructor(private readonly options: LocalMemoryOptions) {
    this.timeoutMs = options.timeoutMs ?? 30000; this.maxPending = options.maxPending ?? 32;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000
      || !Number.isSafeInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 32) throw new LocalMemoryError('INVALID_INPUT');
  }
  private now(): number { return (this.options.now?.() ?? new Date()).getTime(); }
  private remaining(pending: Pending): number {
    const remaining = pending.deadline - this.now();
    if (remaining <= 0 || pending.expiry.signal.aborted) throw new LocalMemoryError('TIMEOUT');
    return Math.max(1, Math.floor(remaining));
  }
  private check(pending: Pending): void {
    if (this.closed) throw new LocalMemoryError('CLOSED');
    pending.signal.throwIfAborted(); this.remaining(pending);
  }
  private async allowed(pending: Pending): Promise<void> {
    this.check(pending);
    await this.options.assertRuntimeAllowed();
    this.check(pending);
  }
  private enqueue<T>(signal: AbortSignal | undefined, action: (pending: Pending) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new LocalMemoryError('CLOSED'));
    if (this.pending.size >= this.maxPending) return Promise.reject(new LocalMemoryError('CAPACITY'));
    const cancel = new AbortController(), expiry = new AbortController();
    const abort = () => cancel.abort(new LocalMemoryError('CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const pending: Pending = { cancel, expiry, signal: AbortSignal.any([cancel.signal, expiry.signal]), deadline: this.now() + this.timeoutMs, done: Promise.resolve() };
    const timer = setTimeout(() => expiry.abort(new LocalMemoryError('TIMEOUT')), this.timeoutMs);
    // Keep the serial slot until the underlying I/O and fact recording settle, even when the caller stops waiting.
    const work = this.tail.catch(() => {}).then(() => action(pending)).finally(() => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(pending);
    });
    pending.done = work; this.tail = work; this.pending.add(pending);
    return untilCancelled(work, pending.signal);
  }
  remember(input: LocalRememberInput): Promise<LocalRememberResult> {
    fields(input, ['requestId', 'conversationId', 'text', 'signal'], ['requestId', 'conversationId', 'text']);
    if (!identity(input.requestId) || !identity(input.conversationId) || typeof input.text !== 'string' || input.text.length > 20000) throw new LocalMemoryError('INVALID_INPUT');
    const body = input.text.trim(), digest = memoryBodyDigest(body);
    const captured = { requestId: input.requestId, conversationId: input.conversationId };
    return this.enqueue(input.signal, pending => this.save(captured, body, digest, pending));
  }
  private async save(input: Pick<LocalRememberInput, 'requestId' | 'conversationId'>, body: string, digest: ReturnType<typeof memoryBodyDigest>, pending: Pending): Promise<LocalRememberResult> {
    let entry: LocalMemoryEntry | undefined, plan: MemoryDispatchPlan | undefined, ownsNewIntent = false;
    try {
      await this.allowed(pending);
      const prepared = await this.options.store.request('memory.prepareLocal', { requestId: input.requestId, conversationId: input.conversationId, bodyDigest: digest.bodyDigest, bytes: digest.bodyBytes });
      const { duplicate, ...metadata } = prepared; entry = metadata;
      if (duplicate) { await this.allowed(pending); return { duplicate: true, entry }; }
      ownsNewIntent = true;
      await this.allowed(pending);
      plan = await this.options.store.request('memory.claim', { operationId: entry.operation.operationId, leaseMs: this.remaining(pending) });
      if (!plan) throw new LocalMemoryError('DISPATCH_UNAVAILABLE');
      await this.allowed(pending);
      const admitted = await this.options.store.request('memory.assertDispatch', { operationId: entry.operation.operationId, claim: plan.claim });
      if (canonicalMemoryCommand(admitted.command) !== canonicalMemoryCommand(entry.command) || admitted.command.backendId !== this.options.backend.binding.backendId
        || admitted.command.scope !== this.options.backend.binding.scope) throw new LocalMemoryError('BACKEND_MISMATCH');
      // The final authority read follows all asynchronous lifecycle gates. Do
      // not insert another await between that read and the backend dispatch.
      assertMemoryBody(admitted.command, body); this.check(pending);
      const created = await this.options.backend.create(admitted.command, body, { signal: pending.signal, timeoutMs: this.remaining(pending) });
      if (created.state !== 'applied') throw new LocalMemoryError('BACKEND_UNSETTLED');
      // After an observed backend effect, cancellation/revocation blocks release but must not erase facts.
      // Verification is read-only and keeps the original absolute deadline, independent of caller cancellation.
      const verified = await this.options.backend.verifyApplied(admitted.command, { signal: pending.expiry.signal, timeoutMs: this.remaining(pending) });
      entry = await this.options.store.request('memory.get', { operationId: entry.operation.operationId });
      if (entry.operation.status === 'dispatching' && Date.parse(plan.claim.leaseExpiresAt) <= this.now()) {
        entry = await this.options.store.request('memory.markUnknown', { operationId: entry.operation.operationId, claim: plan.claim, reasonCode: 'LEASE_EXPIRED' });
      }
      entry = await this.options.store.request('memory.recordVerifiedReceipt', { operationId: entry.operation.operationId, claim: plan.claim, observation: verified.observation, reconciliation: entry.operation.status === 'unknown' });
      await this.allowed(pending);
      // The receipt response is a commit-time snapshot; consent can change before it reaches this caller.
      entry = await this.options.store.request('memory.get', { operationId: entry.operation.operationId });
      this.check(pending);
      if (!entry.reference || !entry.canPublish) throw new LocalMemoryError('STALE_READ');
      return { duplicate: false, entry };
    } catch (error) {
      if (!entry || !ownsNewIntent) throw error;
      try {
        // A receipt may have committed before its IPC response failed. Preserve the authoritative applied fact.
        entry = await this.options.store.request('memory.get', { operationId: entry.operation.operationId });
        if (entry.operation.status !== 'applied' && entry.operation.status !== 'unknown') {
          if (plan) entry = await this.options.store.request('memory.markUnknown', { operationId: entry.operation.operationId, claim: plan.claim, reasonCode: reason(error) });
          else entry = await this.options.store.request('memory.withdrawLocal', { requestId: `cancel-${input.requestId}`, operationId: entry.operation.operationId });
        }
      } catch { throw new Error('Local memory outcome could not be recorded; do not replay automatically'); }
      throw new LocalMemoryFailure(entry.operation.operationId, entry.operation.status);
    }
  }
  read(input: LocalMemoryReadInput): Promise<LocalMemoryReadResult> {
    fields(input, ['operationId', 'signal'], ['operationId']);
    if (!identity(input.operationId)) throw new LocalMemoryError('INVALID_INPUT');
    const operationId = input.operationId;
    return this.enqueue(input.signal, async pending => {
      await this.allowed(pending);
      const before = await this.options.store.request('memory.readLocal', { operationId });
      if (!before.entry.reference) throw new LocalMemoryError('STALE_READ');
      if (before.entry.reference.backendId !== this.options.backend.binding.backendId || before.entry.reference.deploymentId !== this.options.backend.binding.deploymentId
        || before.entry.reference.scope !== this.options.backend.binding.scope) throw new LocalMemoryError('BACKEND_MISMATCH');
      const verified = await this.options.backend.verifyApplied(before.entry.command, { signal: pending.signal, timeoutMs: this.remaining(pending) });
      await this.allowed(pending);
      const after = await this.options.store.request('memory.readLocal', { operationId });
      const reference = after.entry.reference;
      if (canonical(before.readToken) !== canonical(after.readToken) || !reference || verified.observation.nativeId !== reference.nativeId
        || verified.observation.componentVersion !== reference.componentVersion || verified.observation.deploymentId !== reference.deploymentId
        || canonicalMemoryCommand(verified.observation.command) !== canonicalMemoryCommand(after.entry.command)) throw new LocalMemoryError('STALE_READ');
      assertMemoryBody(after.entry.command, verified.body); this.check(pending);
      return { entry: after.entry, body: verified.body };
    });
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending].map(pending => pending.done)); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const pending of this.pending) pending.cancel.abort(new LocalMemoryError('CLOSED'));
    return this.closing = this.drain();
  }
}
