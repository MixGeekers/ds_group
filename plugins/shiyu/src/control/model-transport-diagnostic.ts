import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { checkedNativeUserMessage, loadNativeMessageFactory, type NativeMessageFactory, type NativeUserMessage } from '../adapters/dsh/native-message.js';
import type { DshAgentHandle, DshContext } from '../adapters/dsh/sessions.js';

export const MODEL_TRANSPORT_PROBE_TOOL = 'shiyu_diagnose_model_transport';
export const MODEL_TRANSPORT_MODEL = Object.freeze({ provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' as const, maxTokens: 8 });
export const MODEL_TRANSPORT_PROMPT = 'Reply with the single word OK.';
export const MODEL_TRANSPORT_PROMPT_SHA256 = createHash('sha256').update(MODEL_TRANSPORT_PROMPT, 'utf8').digest('hex');
export const MODEL_TRANSPORT_RECEIPT_MAX_BYTES = 16 * 1024;
const PROMPT_LIST = Object.freeze([MODEL_TRANSPORT_PROMPT]);
const MAX_CHUNKS = 64;
const MAX_TEXT_BYTES = 256 * 1024;
type Category = 'ok' | 'empty-provider-stream' | 'transport' | 'auth' | 'request-shape' | 'timeout' | 'aborted' | 'unknown';

export class ModelTransportDiagnosticError extends Error {
  constructor(readonly code: 'MODEL_TRANSPORT_PAUSED' | 'MODEL_TRANSPORT_BUSY' | 'MODEL_TRANSPORT_CAPACITY'
    | 'MODEL_TRANSPORT_INVALID' | 'MODEL_TRANSPORT_UNAVAILABLE', message: string) {
    super(message); this.name = 'ModelTransportDiagnosticError';
  }
}
/** Pure owner-command admission helper: paused rejects, one exclusive probe slot,
 * generic runtime capacity respected, no retries. */
export function assertModelTransportAdmission(state: { paused: boolean; operations: number; capacity: number; sameActionRunning: boolean }): void {
  if (state.paused) throw new ModelTransportDiagnosticError('MODEL_TRANSPORT_PAUSED', 'Model transport diagnostic requires an unpaused runtime');
  if (state.sameActionRunning) throw new ModelTransportDiagnosticError('MODEL_TRANSPORT_BUSY', 'Model transport diagnostic is already running');
  if (!Number.isSafeInteger(state.operations) || state.operations < 0 || state.capacity < 1 || state.operations >= state.capacity) {
    throw new ModelTransportDiagnosticError('MODEL_TRANSPORT_CAPACITY', 'Model transport diagnostic requires an idle runtime slot');
  }
}
/** One bounded transport observation, produced by the host session path or by a
 * fake injected transport in tests. It never contains prompt/response text. */
export interface ModelTransportObservation {
  chunks: number;
  textBytes: number;
  textSha256?: string;
  usage: { status: 'reported'; tokens?: number } | { status: 'unknown' };
  error?: unknown;
  abortedBeforeFirstChunk: boolean;
  abortedAfterFirstChunk: boolean;
  timedOut: boolean;
  toolCount: number;
  messageCount: number;
  cleanup?: { createdSessionId?: string; released: boolean; disposed: boolean; archived: boolean; failures: string[] };
}
export interface ModelTransportRequest {
  provider: string; model: string; reasoningEffort: string; maxTokens: number; prompt: string;
  signal?: AbortSignal; deadlineAtMs?: number;
}
export interface ModelTransport { run(request: ModelTransportRequest): Promise<ModelTransportObservation>; }
export interface ModelTransportDiagnosticOptions {
  ctx?: DshContext;
  /** Trusted test/owner injection; production uses the host-backed transport. */
  transport?: ModelTransport;
  cwd?: string;
  preset?: string;
  agentPreset?: string;
  createUserMessage?: NativeMessageFactory;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  now?: () => number;
}
export interface ModelTransportDiagnosticReceipt {
  schemaVersion: 1; kind: 'model-transport-diagnostic'; toolName: typeof MODEL_TRANSPORT_PROBE_TOOL;
  realModelCall: true; automaticRetry: false; businessPass: false; chatPass: false;
  status: Category; ok: boolean;
  request: { provider: string; model: string; reasoningEffort: string; maxTokens: number; messageCount: number; toolCount: number; promptSha256: string };
  result: { chunks: number; textBytes: number; textSha256?: string; usage: { status: 'reported'; tokens?: number } | { status: 'unknown' } };
  error?: { category: Category; code: string; name: string; label: string };
  session?: { createdSessionId?: string; released: boolean; disposed: boolean; archived: boolean; cleanup: { ok: boolean; failures: string[] } };
  checks: string[];
  startedAt: string; completedAt: string; durationMs: number;
}
const boundCode = (value: unknown): string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/.test(value)
  ? value : typeof value === 'number' && Number.isFinite(value) ? String(value).slice(0, 20) : 'NONE';
const boundName = (value: unknown): string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(value) ? value : 'Error';
const categoryFromError = (error: unknown, flags: { timedOut: boolean; aborted: boolean; chunks: number }): Category => {
  if (flags.timedOut) return 'timeout';
  if (flags.aborted) return 'aborted';
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  // Classification may use the raw numeric/string status here (e.g. 401/422);
  // the persisted receipt only keeps the bounded safe label.
  const rawCode = typeof record.code === 'string' ? record.code : typeof record.code === 'number' ? String(record.code)
    : typeof record.errno === 'string' ? record.errno : typeof record.errno === 'number' ? String(record.errno) : '';
  const raw = `${rawCode} ${boundName(record.name)}`.toLowerCase();
  if (/auth|unauthorized|forbidden|401|403|api[-_ ]?key|credential/.test(raw)) return 'auth';
  if (/timeout|timedout|etimedout|deadline/.test(raw)) return 'timeout';
  if (/enotfound|econnreset|econnrefused|ehostunreach|epipe|socket|network|fetch|tls|certificate|eai_again/.test(raw)) return 'transport';
  if (/invalid|schema|malformed|request|400|422|tool|parameter/.test(raw)) return 'request-shape';
  return 'unknown';
};
/** Controlled classification of one observation; provider internals are never guessed. */
export function classifyModelTransport(observation: ModelTransportObservation): Category {
  if (observation.error !== undefined) return categoryFromError(observation.error, { timedOut: observation.timedOut,
    aborted: observation.abortedBeforeFirstChunk || observation.abortedAfterFirstChunk, chunks: observation.chunks });
  if (observation.timedOut) return 'timeout';
  if (observation.abortedBeforeFirstChunk || observation.abortedAfterFirstChunk) return 'aborted';
  if (!Number.isSafeInteger(observation.chunks) || observation.chunks <= 0) return 'empty-provider-stream';
  if (observation.textBytes > 0) return 'ok';
  return 'unknown';
}
function iso(epochMs: number): string { return new Date(epochMs).toISOString(); }
function errorFacts(error: unknown): { code: string; name: string; label: string } | undefined {
  if (error === undefined) return undefined;
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = boundCode(record.code ?? record.errno), name = boundName(record.name);
  return { code, name, label: `${name}${code !== 'NONE' ? `:${code}` : ''}`.slice(0, 80) };
}
function textFromChunk(chunk: unknown): string {
  if (!chunk || typeof chunk !== 'object') return '';
  const record = chunk as Record<string, unknown>;
  if (record.type === 'text' && typeof record.text === 'string') return record.text;
  if (typeof record.text === 'string') return record.text;
  const delta = record.delta;
  if (delta && typeof delta === 'object' && typeof (delta as Record<string, unknown>).text === 'string') return (delta as { text: string }).text;
  const content = record.content;
  if (Array.isArray(content)) return content.filter(block => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text'
    && typeof (block as Record<string, unknown>).text === 'string').map(block => (block as { text: string }).text).join('');
  return '';
}
/** Production host-backed transport: create exactly one bare lifecycle Session,
 * install an llm/stream observation hook, send the fixed one-line owner message,
 * await one turn, then always cancel/dispose/archive the Session. No retry. */
function hostTransport(options: ModelTransportDiagnosticOptions & { ctx: DshContext; cwd: string; preset: string }): ModelTransport {
  return {
    async run(request: ModelTransportRequest): Promise<ModelTransportObservation> {
      const ctx = options.ctx, now = options.now ?? Date.now;
      const startedAtMs = now();
      const deadline = options.deadlineAtMs ?? startedAtMs + 30_000;
      let handle: DshAgentHandle | undefined;
      let capturedRequest: { tools?: unknown[]; messages?: unknown[] } | undefined;
      let chunks = 0, textBytes = 0, textHash = createHash('sha256');
      let tokens: number | undefined;
      let failure: unknown;
      let abortedBefore = false, abortedAfter = false, timedOut = false;
      const failures: string[] = [];
      let released = false, disposed = false, archived = false;
      const sessionId = `shiyu-model-transport-${randomUUID()}`;
      let disposer: (() => void) | undefined;
      try {
        disposer = ctx.on('llm/stream', async (incoming: any, next: () => Promise<AsyncIterable<unknown>>) => {
          capturedRequest = { tools: Array.isArray(incoming?.tools) ? incoming.tools : [], messages: Array.isArray(incoming?.messages) ? incoming.messages : [] };
          const source = await next();
          return (async function* () {
            for await (const chunk of source) {
              chunks++;
              if (chunks > MAX_CHUNKS) throw new Error('Core transport probe chunk bound exceeded');
              const text = textFromChunk(chunk);
              if (text) { textBytes += Buffer.byteLength(text, 'utf8'); textHash.update(text); }
              const usage = chunk && typeof chunk === 'object' ? (chunk as Record<string, unknown>).usage : undefined;
              if (usage && typeof usage === 'object') {
                const total = (usage as Record<string, unknown>).totalTokens;
                if (Number.isSafeInteger(total) && (total as number) >= 0) tokens = (tokens ?? 0) + (total as number);
              }
              if (textBytes > MAX_TEXT_BYTES) throw new Error('Core transport probe text bound exceeded');
              yield chunk;
            }
          })();
        });
        handle = await ctx.agents.create({ sessionId, ...(options.signal ? { signal: options.signal } : {}),
          agentOptions: { provider: MODEL_TRANSPORT_MODEL.provider, model: MODEL_TRANSPORT_MODEL.model,
            reasoningEffort: MODEL_TRANSPORT_MODEL.reasoningEffort, maxTokens: MODEL_TRANSPORT_MODEL.maxTokens },
          meta: { cwd: options.cwd, agentPreset: options.preset },
          setup: (agentCtx) => {
            agentCtx.tools.guard(() => 'Model transport diagnostic Session cannot execute tools.');
            agentCtx.on('agent/pre-step', async () => ({ kind: 'enter' }));
          } });
        const factory = options.createUserMessage ?? await loadNativeMessageFactory();
        const message: NativeUserMessage = checkedNativeUserMessage(await factory({ content: [{ type: 'text', text: request.prompt }],
          source: { kind: 'user' } }), request.prompt);
        handle.agent.followup(message);
        await handle.agent.whenIdle();
        if (options.signal?.aborted) { abortedBefore = chunks === 0; abortedAfter = chunks > 0; }
        if (now() >= deadline) timedOut = true;
      } catch (error) {
        failure = error;
        abortedBefore = Boolean(options.signal?.aborted) && chunks === 0;
        abortedAfter = Boolean(options.signal?.aborted) && chunks > 0;
        timedOut = now() >= deadline;
      } finally {
        if (disposer) { try { disposer(); } catch { /* observation only */ } }
        if (handle) {
          try { handle.agent.cancel({ kind: 'hook', reason: 'Model transport diagnostic finished' }, { keepInbox: true }); released = true; }
          catch (error) { failures.push(`release:${boundCode((error as { code?: unknown })?.code)}`); }
          try { await handle.dispose(); disposed = true; }
          catch (error) { failures.push(`dispose:${boundCode((error as { code?: unknown })?.code)}`); }
          try {
            const workspace = ctx.get('workspaceRegistry');
            if (typeof workspace?.archiveSession !== 'function') throw new Error('archive unavailable');
            await workspace.archiveSession(sessionId); archived = true;
          } catch { failures.push('archive:NATIVE_ARCHIVE_FAILED'); }
        }
      }
      return { chunks: Math.max(0, chunks), textBytes: Math.max(0, textBytes),
        ...(textBytes > 0 ? { textSha256: textHash.digest('hex') } : {}),
        usage: tokens !== undefined ? { status: 'reported', tokens } : { status: 'unknown' },
        ...(failure !== undefined ? { error: failure } : {}),
        abortedBeforeFirstChunk: abortedBefore, abortedAfterFirstChunk: abortedAfter, timedOut,
        toolCount: Array.isArray(capturedRequest?.tools) ? capturedRequest.tools.length : 0,
        messageCount: Array.isArray(capturedRequest?.messages) ? capturedRequest.messages.length : 0,
        cleanup: { createdSessionId: sessionId, released, disposed, archived, failures: failures.slice(0, 8) } };
    },
  };
}
function fakeTransport(options: ModelTransportDiagnosticOptions): ModelTransport {
  return options.transport ?? {
    async run(): Promise<ModelTransportObservation> {
      return { chunks: 0, textBytes: 0, usage: { status: 'unknown' }, abortedBeforeFirstChunk: false,
        abortedAfterFirstChunk: false, timedOut: false, toolCount: 0, messageCount: 0 };
    },
  };
}
/**
 * Owner-only MINIMAL REAL MODEL TRANSPORT diagnostic. It performs exactly one
 * bounded real generation call (or an injected fake transport in offline tests),
 * with the fixed replyer provider/model/reasoning effort, maxTokens <=8, one
 * turn, one runtime slot, caller abort, no retry. The receipt carries controlled
 * classification/hashes/counts only: no prompt, response text, body or path is
 * persisted. A failed/unknown result is terminal and is NEVER a chat/business
 * pass; an owner-authorized retry is a separate explicit decision.
 */
export async function diagnoseModelTransport(options: ModelTransportDiagnosticOptions = {}): Promise<ModelTransportDiagnosticReceipt> {
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const deadline = options.deadlineAtMs ?? startedAtMs + 30_000;
  const context = options.ctx;
  const cwd = options.cwd;
  const preset = options.preset ?? options.agentPreset ?? 'shiyu-runtime-core-goal-v1';
  let transport: ModelTransport;
  if (options.transport) transport = options.transport;
  else {
    if (!context || typeof context.agents?.create !== 'function' || typeof context.get !== 'function') {
      throw new ModelTransportDiagnosticError('MODEL_TRANSPORT_UNAVAILABLE', 'Host model/session services are unavailable');
    }
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new ModelTransportDiagnosticError('MODEL_TRANSPORT_INVALID', 'An absolute diagnostic cwd is required');
    transport = hostTransport({ ctx: context, cwd, preset, now, ...(options.signal ? { signal: options.signal } : {}),
      deadlineAtMs: deadline, ...(options.createUserMessage ? { createUserMessage: options.createUserMessage } : {}) });
  }
  let observation: ModelTransportObservation;
  try {
    observation = await transport.run({ ...MODEL_TRANSPORT_MODEL, prompt: MODEL_TRANSPORT_PROMPT,
      ...(options.signal ? { signal: options.signal } : {}), deadlineAtMs: deadline });
  } catch (error) {
    observation = { chunks: 0, textBytes: 0, usage: { status: 'unknown' }, error, abortedBeforeFirstChunk: Boolean(options.signal?.aborted),
      abortedAfterFirstChunk: false, timedOut: now() >= deadline, toolCount: 0, messageCount: 0 };
  }
  const status = classifyModelTransport(observation);
  const error = status === 'ok' || status === 'empty-provider-stream' ? undefined
    : errorFacts(observation.error ?? { name: status === 'timeout' ? 'TimeoutError' : status === 'aborted' ? 'AbortError' : 'Error',
      code: 'NONE' });
  const completedAtMs = Math.max(now(), startedAtMs);
  const cleanup = observation.cleanup;
  const receipt: ModelTransportDiagnosticReceipt = {
    schemaVersion: 1, kind: 'model-transport-diagnostic', toolName: MODEL_TRANSPORT_PROBE_TOOL,
    realModelCall: true, automaticRetry: false, businessPass: false, chatPass: false,
    status, ok: status === 'ok',
    request: { ...MODEL_TRANSPORT_MODEL, messageCount: observation.messageCount, toolCount: observation.toolCount, promptSha256: MODEL_TRANSPORT_PROMPT_SHA256 },
    result: { chunks: observation.chunks, textBytes: observation.textBytes,
      ...(observation.textSha256 ? { textSha256: observation.textSha256 } : {}), usage: observation.usage },
    ...(error ? { error: { category: status, ...error } } : {}),
    ...(cleanup ? { session: { ...(cleanup.createdSessionId ? { createdSessionId: cleanup.createdSessionId } : {}), released: cleanup.released,
      disposed: cleanup.disposed, archived: cleanup.archived,
      cleanup: { ok: cleanup.failures.length === 0, failures: cleanup.failures.slice(0, 8) } } } : {}),
    checks: ['real-model-call:true', 'automatic-retry:false', `classification:${status}`, ...(observation.timedOut ? ['deadline-expired'] : []),
      ...(observation.abortedBeforeFirstChunk ? ['aborted-before-first-chunk'] : []),
      ...(observation.abortedAfterFirstChunk ? ['aborted-after-first-chunk'] : [])].slice(0, 16),
    startedAt: iso(startedAtMs), completedAt: iso(completedAtMs), durationMs: Math.max(0, completedAtMs - startedAtMs),
  };
  assertModelTransportDiagnosticReceipt(receipt);
  return receipt;
}
const CATEGORIES = Object.freeze(['ok', 'empty-provider-stream', 'transport', 'auth', 'request-shape', 'timeout', 'aborted', 'unknown']);
/** Independent strict validator: bounded plain receipt; controlled codes/labels,
 * hash prefixes only, no prompt/response body/path. */
export function assertModelTransportDiagnosticReceipt(value: unknown): asserts value is ModelTransportDiagnosticReceipt {
  const lossless = (item: unknown, depth: number): void => {
    if (depth > 8) throw new Error('Model transport receipt is too deep');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item) || Object.is(item, -0)) throw new Error('Model transport receipt has a non-lossless number'); return; }
    if (typeof item === 'string') { if (item.length > 256) throw new Error('Model transport receipt has an oversized string'); return; }
    if (Array.isArray(item)) { if (item.length > 32) throw new Error('Model transport receipt array is too long'); for (const entry of item) lossless(entry, depth + 1); return; }
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) throw new Error('Model transport receipt is not lossless JSON');
    for (const entry of Object.values(item as Record<string, unknown>)) lossless(entry, depth + 1);
  };
  lossless(value, 0);
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > MODEL_TRANSPORT_RECEIPT_MAX_BYTES) throw new Error('Model transport receipt exceeds its bounded size');
  if (JSON.stringify(JSON.parse(encoded)) !== encoded) throw new Error('Model transport receipt is not lossless');
  const receipt = value as ModelTransportDiagnosticReceipt;
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'model-transport-diagnostic' || receipt.toolName !== MODEL_TRANSPORT_PROBE_TOOL) throw new Error('Model transport receipt header is invalid');
  if (receipt.realModelCall !== true || receipt.automaticRetry !== false || receipt.businessPass !== false || receipt.chatPass !== false) {
    throw new Error('Model transport receipt must declare a real call with no retry and no chat/business pass');
  }
  if (!CATEGORIES.includes(receipt.status)) throw new Error('Model transport classification is invalid');
  if (typeof receipt.ok !== 'boolean' || receipt.ok !== (receipt.status === 'ok')) throw new Error('Model transport ok flag must match its classification');
  const request = receipt.request;
  if (!request || typeof request !== 'object' || request.provider !== MODEL_TRANSPORT_MODEL.provider || request.model !== MODEL_TRANSPORT_MODEL.model
    || request.reasoningEffort !== MODEL_TRANSPORT_MODEL.reasoningEffort || request.maxTokens !== MODEL_TRANSPORT_MODEL.maxTokens
    || request.maxTokens > 8 || !Number.isSafeInteger(request.messageCount) || !Number.isSafeInteger(request.toolCount)
    || typeof request.promptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(request.promptSha256)) throw new Error('Model transport request facts are invalid');
  const result = receipt.result;
  if (!result || !Number.isSafeInteger(result.chunks) || result.chunks < 0 || !Number.isSafeInteger(result.textBytes) || result.textBytes < 0
    || (result.textSha256 !== undefined && !/^[a-f0-9]{64}$/.test(result.textSha256))
    || !result.usage || !['reported', 'unknown'].includes(result.usage.status)
    || (result.usage.status === 'reported' && result.usage.tokens !== undefined && (!Number.isSafeInteger(result.usage.tokens) || result.usage.tokens < 0))) {
    throw new Error('Model transport result facts are invalid');
  }
  if ((result.textBytes > 0) !== (result.textSha256 !== undefined)) throw new Error('Model transport text hash must match its byte count');
  if (receipt.status === 'ok' && !(result.chunks > 0 && result.textBytes > 0)) throw new Error('Model transport ok requires a non-empty assistant text');
  if (receipt.status === 'empty-provider-stream' && !(result.chunks === 0 && result.textBytes === 0)) throw new Error('Model transport empty stream must have no chunks/text');
  if (receipt.status === 'ok' && receipt.error !== undefined) throw new Error('An ok transport diagnostic cannot carry an error label');
  if (receipt.error !== undefined) {
    if (!receipt.error || !CATEGORIES.includes(receipt.error.category) || receipt.error.category !== receipt.status
      || typeof receipt.error.code !== 'string' || receipt.error.code.length > 40 || !/^[A-Za-z0-9_.:-]*$/.test(receipt.error.code)
      || typeof receipt.error.name !== 'string' || receipt.error.name.length > 40 || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(receipt.error.name)
      || typeof receipt.error.label !== 'string' || receipt.error.label.length > 80 || /[/\\]/.test(receipt.error.label)) {
      throw new Error('Model transport error label is invalid');
    }
  } else if (receipt.status !== 'ok' && receipt.status !== 'empty-provider-stream') throw new Error('Non-ok transport classification must keep its controlled error label');
  if (receipt.session !== undefined) {
    const session = receipt.session;
    if (!session || typeof session.released !== 'boolean' || typeof session.disposed !== 'boolean' || typeof session.archived !== 'boolean'
      || !session.cleanup || typeof session.cleanup.ok !== 'boolean' || !Array.isArray(session.cleanup.failures) || session.cleanup.failures.length > 8
      || session.cleanup.failures.some(failure => typeof failure !== 'string' || !/^[a-z]+:[A-Za-z0-9_.:-]{1,60}$/.test(failure))) {
      throw new Error('Model transport session cleanup facts are invalid');
    }
  }
  if (!Array.isArray(receipt.checks) || receipt.checks.length > 16 || receipt.checks.some(check => typeof check !== 'string' || !/^[a-z][a-z0-9:-]{0,63}$/.test(check))) {
    throw new Error('Model transport checks are invalid');
  }
  for (const field of ['startedAt', 'completedAt'] as const) {
    if (typeof receipt[field] !== 'string' || new Date(receipt[field]).toISOString() !== receipt[field]) throw new Error(`Model transport ${field} is not canonical UTC`);
  }
  if (!Number.isSafeInteger(receipt.durationMs) || receipt.durationMs < 0) throw new Error('Model transport duration is invalid');
}
