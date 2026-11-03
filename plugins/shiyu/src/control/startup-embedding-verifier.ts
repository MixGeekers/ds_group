/**
 * P0 round-18: one bounded startup embedding verification per process.
 *
 * It performs at most one fixed local-embedding query, never a generation call,
 * never a retry and never a synthetic memory write. If the backend is not ready,
 * there is no eligible indexed conversation, or the query fails/times out, the
 * truthful outcome is exact-read-only plus a controlled reason. It must not be
 * used to "prove" semantic recall of a specific fact; it only proves that a real
 * query embedding works in this backend instance and may be published.
 */
export const STARTUP_EMBEDDING_QUERY = 'SHIYU_STARTUP_EMBEDDING_VERIFY 受控启动 embedding 验证';
export type StartupEmbeddingReason =
  | 'ALREADY_ATTEMPTED' | 'SEMANTIC_NOT_CONFIGURED' | 'BACKEND_NOT_READY' | 'ALREADY_VERIFIED'
  | 'NO_CONVERSATION' | 'NO_ELIGIBLE_MEMORY' | 'EMBEDDING_FAILED' | 'TIMEOUT' | 'ABORTED' | null;
export interface StartupEmbeddingBackendStatus {
  state: string; bindingVerified: boolean; semanticReady?: boolean;
  semantic?: { embeddingVerified?: boolean; profileCompatible?: boolean; state?: string } | null;
}
export interface StartupEmbeddingSearchResult {
  state: 'ok' | 'index_required';
  embeddingCalls: number | null;
  usageComplete: boolean;
  matches: number;
}
export interface StartupEmbeddingDeps {
  semanticConfigured: boolean;
  backendStatus(): StartupEmbeddingBackendStatus;
  /** Deterministic conversation that currently has at least one readable memory. */
  findConversationWithMemory(): Promise<string | undefined>;
  search(input: { conversationId: string; query: string; signal: AbortSignal }): Promise<StartupEmbeddingSearchResult>;
  /** Called only after a real embedding call succeeded; publishes the verified capability. */
  publishVerified?(): Promise<void>;
  now?: () => Date;
}
export interface StartupEmbeddingResult {
  schemaVersion: 1;
  attempted: boolean;
  verified: boolean;
  reason: StartupEmbeddingReason;
  conversationId: string | null;
  embeddingCalls: number | null;
  usageComplete: boolean;
  semanticPublished: boolean;
  capturedAt: string;
  durationMs: number;
  errorCode?: string;
}
const bounded = (value: unknown, max = 120): string => String(value).replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
const isAbort = (error: unknown): boolean => Boolean(error && typeof error === 'object' && (('name' in error && (error as Error).name === 'AbortError') || ('code' in error && String((error as { code?: unknown }).code).includes('ABORT'))));
export interface StartupEmbeddingOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => Date;
}
/**
 * Perform exactly one verification attempt. No retry loop exists by construction.
 */
export async function verifyStartupEmbedding(deps: StartupEmbeddingDeps, options: StartupEmbeddingOptions = {}): Promise<StartupEmbeddingResult> {
  const now = options.now ?? deps.now ?? (() => new Date());
  const started = Date.parse(now().toISOString());
  const at = (): string => now().toISOString();
  const done = (patch: Partial<StartupEmbeddingResult>): StartupEmbeddingResult => ({ schemaVersion: 1, attempted: true, verified: false,
    reason: null, conversationId: null, embeddingCalls: null, usageComplete: false, semanticPublished: false, capturedAt: at(),
    durationMs: Math.max(0, Date.parse(at()) - started), ...patch });
  if (options.signal?.aborted) return done({ reason: 'ABORTED' });
  if (!deps.semanticConfigured) return done({ reason: 'SEMANTIC_NOT_CONFIGURED' });
  const status = deps.backendStatus();
  if (status.state !== 'ready' || !status.bindingVerified) return done({ reason: 'BACKEND_NOT_READY' });
  if (status.semanticReady === true && status.semantic?.embeddingVerified === true) return done({ reason: 'ALREADY_VERIFIED' });
  const conversationId = await deps.findConversationWithMemory().catch(() => undefined);
  if (!conversationId) return done({ reason: 'NO_CONVERSATION' });
  const timeoutMs = options.timeoutMs ?? 20000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid startup embedding timeout');
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('STARTUP_EMBEDDING_TIMEOUT')), timeoutMs);
  const timedOut = (): boolean => controller.signal.aborted && !options.signal?.aborted;
  try {
    const result = await deps.search({ conversationId, query: STARTUP_EMBEDDING_QUERY, signal: controller.signal });
    if (options.signal?.aborted) return done({ conversationId, reason: 'ABORTED' });
    const calls = result.embeddingCalls;
    if (typeof calls !== 'number' || !Number.isSafeInteger(calls) || calls < 0 || calls > 1 || result.usageComplete !== true) {
      return done({ conversationId, embeddingCalls: typeof calls === 'number' ? calls : null, usageComplete: result.usageComplete === true, reason: 'EMBEDDING_FAILED', errorCode: 'UNBOUNDED_EMBEDDING_USAGE' });
    }
    if (result.state !== 'ok' || calls < 1) {
      return done({ conversationId, embeddingCalls: calls, usageComplete: result.usageComplete === true, reason: 'NO_ELIGIBLE_MEMORY' });
    }
    await deps.publishVerified?.();
    return done({ verified: true, conversationId, embeddingCalls: calls, usageComplete: true, semanticPublished: true });
  } catch (error) {
    const errorCode = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? bounded((error as { code: string }).code) : bounded(error instanceof Error ? error.name : 'UNKNOWN');
    if (options.signal?.aborted && !timedOut()) return done({ conversationId, reason: 'ABORTED', errorCode });
    if (timedOut()) return done({ conversationId, reason: 'TIMEOUT', errorCode: 'STARTUP_EMBEDDING_TIMEOUT' });
    return done({ conversationId, reason: isAbort(error) ? 'ABORTED' : 'EMBEDDING_FAILED', errorCode });
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); }
}
/**
 * Per-process single-attempt guard. A second call in the same process reports
 * ALREADY_ATTEMPTED without touching the backend or starting another query.
 */
export class StartupEmbeddingVerifier {
  #attempted = false;
  #last?: StartupEmbeddingResult;
  async verify(deps: StartupEmbeddingDeps, options: StartupEmbeddingOptions = {}): Promise<StartupEmbeddingResult> {
    if (this.#attempted) {
      const at = (options.now ?? deps.now ?? (() => new Date()))().toISOString();
      return { schemaVersion: 1, attempted: false, verified: this.#last?.verified === true, reason: 'ALREADY_ATTEMPTED',
        conversationId: this.#last?.conversationId ?? null, embeddingCalls: null, usageComplete: false,
        semanticPublished: this.#last?.semanticPublished === true, capturedAt: at, durationMs: 0 };
    }
    this.#attempted = true;
    this.#last = await verifyStartupEmbedding(deps, options);
    return this.#last;
  }
  get attempted(): boolean { return this.#attempted; }
  last(): StartupEmbeddingResult | undefined { return this.#last ? structuredClone(this.#last) : undefined; }
}
