/**
 * Bounded, controlled diagnostics for failed local reply generations.
 *
 * This module only turns already-observed, in-process stream facts (event types,
 * assistant/attempt stream lengths, timer/abort state and a controlled error
 * code/name) into a small persisted diagnostic. Provider messages, prompts, tool
 * arguments and paths are NEVER retained: classification may look at a bounded
 * lower-cased error/turn label internally, but the returned diagnostic exposes
 * only the category, a bounded code/name and the observed chunk counters.
 *
 * It never retries and never changes operation status; the first recorded
 * unknown/failed reason remains authoritative (see LocalReplyDomain.fail).
 */
export const REPLY_STREAM_CATEGORIES = ['empty-provider-stream', 'transport', 'auth', 'request-shape', 'timeout',
  'aborted-before-first-chunk', 'aborted-after-first-chunk', 'unknown'] as const;
export type ReplyStreamCategory = (typeof REPLY_STREAM_CATEGORIES)[number];
export const RESPONSE_DIAGNOSTIC_MAX_BYTES = 400;
const MAX_ATTEMPTS = 8;
const MAX_CHUNKS = 1_000_000;
export interface ReplyStreamDiagnostic {
  category: ReplyStreamCategory;
  /** Controlled error code/errno (uppercase token) or NONE. */
  code: string;
  /** Controlled error name token or Error. */
  name: string;
  /** Observed assistant chunk/stream count for this failed generation. */
  chunks: number;
  /** Last bounded assistant/attempt stream lengths, for host-side diagnosis only. */
  attemptStreamLengths: number[];
  assistantMessages: number;
  abortedBeforeFirstChunk: boolean;
  abortedAfterFirstChunk: boolean;
  timedOut: boolean;
  /** Controlled label only: category[:CODE], no provider text. */
  label: string;
  elapsedMs?: number;
}
export interface ReplyGenerationFacts {
  chunks: number;
  attemptStreamLengths: number[];
  assistantMessages: number;
  firstChunkSeen: boolean;
}
export class ReplyGenerationFailure extends Error {
  constructor(message: string, readonly replyStreamDiagnostic: ReplyStreamDiagnostic, options?: { cause?: unknown }) {
    super(message, options); this.name = 'ReplyGenerationFailure';
  }
}
const boundedCode = (value: unknown): string => {
  if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(value)) return value.toUpperCase().slice(0, 40);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, 20);
  return 'NONE';
};
const boundedName = (value: unknown): string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(value) ? value.slice(0, 40) : 'Error';
const integer = (value: unknown, max = MAX_CHUNKS): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : 0;
/** Extract controlled generation facts from native Session events. */
export function replyGenerationFacts(events: readonly { type?: unknown; data?: unknown }[] | undefined): ReplyGenerationFacts {
  const attemptStreamLengths: number[] = [];
  let assistantMessages = 0;
  for (const event of events ?? []) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'assistant/message') assistantMessages++;
    if (event.type === 'assistant/attempt') {
      const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
      if (Number.isSafeInteger(data.streamLength) && Number(data.streamLength) >= 0) attemptStreamLengths.push(integer(data.streamLength));
    }
  }
  const boundedAttempts = attemptStreamLengths.slice(-MAX_ATTEMPTS);
  const streamed = boundedAttempts.reduce((sum, value) => sum + value, 0);
  const chunks = Math.min(MAX_CHUNKS, streamed + assistantMessages);
  return { chunks, attemptStreamLengths: boundedAttempts, assistantMessages,
    firstChunkSeen: assistantMessages > 0 || streamed > 0 };
}
export interface ReplyGenerationDiagnosticInput {
  error: unknown;
  facts: ReplyGenerationFacts;
  timedOut: boolean;
  externallyAborted: boolean;
  operationAborted: boolean;
  /** Bounded turn-level error string; used only for classification, never persisted. */
  turnError?: string;
  elapsedMs?: number;
}
/** Controlled classification; order is explicit and provider semantics are never guessed. */
export function replyStreamDiagnosticFromGeneration(input: ReplyGenerationDiagnosticInput): ReplyStreamDiagnostic {
  const record = input.error && typeof input.error === 'object' ? input.error as Record<string, unknown> : {};
  const code = boundedCode(record.code ?? record.errno);
  const name = boundedName(record.name);
  const raw = `${code} ${name} ${typeof record.message === 'string' ? record.message : ''} ${input.turnError ?? ''}`.toLowerCase().slice(0, 2000);
  const hasError = input.error !== undefined && input.error !== null;
  const extraction: ReplyStreamCategory =
    input.timedOut ? 'timeout'
    : input.externallyAborted || input.operationAborted
      ? (input.facts.firstChunkSeen ? 'aborted-after-first-chunk' : 'aborted-before-first-chunk')
    : /auth|unauthorized|forbidden|401|403|api[-_ ]?key|credential/.test(raw) ? 'auth'
    : /enotfound|econnreset|econnrefused|ehostunreach|epipe|socket|network|fetch|tls|certificate|eai_again|stream/.test(raw) ? 'transport'
    : /invalid|schema|malformed|request|400|422|parameter/.test(raw) ? 'request-shape'
    : /timeout|timedout|etimedout|deadline/.test(raw) ? 'timeout'
    : input.facts.chunks === 0 && !input.facts.firstChunkSeen ? 'empty-provider-stream'
    : 'unknown';
  // A clean structured error with no chunk is not automatically an empty stream:
  // transport/auth/request-shape already won above. Remaining zero-chunk errors
  // are observed "no chunk before abort/end" and surface as empty-provider-stream.
  const category: ReplyStreamCategory = extraction === 'request-shape' && !hasError && input.facts.chunks === 0 ? 'empty-provider-stream' : extraction;
  const label = category === 'unknown' ? 'unknown' : code !== 'NONE' ? `${category}:${code}`.slice(0, 80) : category;
  const diagnostic: ReplyStreamDiagnostic = {
    category, code, name, chunks: integer(input.facts.chunks), attemptStreamLengths: [...input.facts.attemptStreamLengths],
    assistantMessages: integer(input.facts.assistantMessages, 1000),
    abortedBeforeFirstChunk: !input.facts.firstChunkSeen && (input.externallyAborted || input.operationAborted),
    abortedAfterFirstChunk: input.facts.firstChunkSeen && (input.externallyAborted || input.operationAborted),
    timedOut: input.timedOut, label,
    ...(input.elapsedMs === undefined ? {} : { elapsedMs: integer(input.elapsedMs, 3_600_000) }),
  };
  return diagnostic;
}
/** Mapped, bounded reasonCode persisted on the failed operation. */
export function replyFailureReasonCode(diagnostic: ReplyStreamDiagnostic | undefined): string {
  if (!diagnostic) return 'REPLY_FAILED';
  switch (diagnostic.category) {
    case 'empty-provider-stream': return 'REPLY_EMPTY_PROVIDER_STREAM';
    case 'transport': return 'REPLY_TRANSPORT';
    case 'auth': return 'REPLY_AUTH';
    case 'request-shape': return 'REPLY_REQUEST_SHAPE';
    case 'timeout': return 'REPLY_TIMEOUT';
    case 'aborted-before-first-chunk': return 'REPLY_ABORTED_BEFORE_FIRST_CHUNK';
    case 'aborted-after-first-chunk': return 'REPLY_ABORTED_AFTER_FIRST_CHUNK';
    default: return 'REPLY_FAILED';
  }
}
export class ReplyStreamDiagnosticError extends Error {
  constructor(message: string) { super(message); this.name = 'ReplyStreamDiagnosticError'; }
}
/** Strict validator for persisted/serialized diagnostics (mutation and leak rejection). */
export function validateReplyStreamDiagnostic(value: unknown, maxBytes = RESPONSE_DIAGNOSTIC_MAX_BYTES): ReplyStreamDiagnostic {
  const fail = (message: string): never => { throw new ReplyStreamDiagnosticError(message); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Expected a plain diagnostic object');
  const keys = ['category', 'code', 'name', 'chunks', 'attemptStreamLengths', 'assistantMessages', 'abortedBeforeFirstChunk',
    'abortedAfterFirstChunk', 'timedOut', 'label', 'elapsedMs'];
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) fail('Unknown diagnostic field');
  if (typeof record.category !== 'string' || !REPLY_STREAM_CATEGORIES.includes(record.category as ReplyStreamCategory)) fail('Invalid stream category');
  if (typeof record.code !== 'string' || !/^(?:NONE|[A-Z][A-Z0-9_.-]{0,39})$/.test(record.code)) fail('Invalid controlled code');
  if (typeof record.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(record.name)) fail('Invalid controlled name');
  if (typeof record.chunks !== 'number' || !Number.isSafeInteger(record.chunks) || record.chunks < 0 || record.chunks > MAX_CHUNKS) fail('Invalid chunk count');
  if (!Array.isArray(record.attemptStreamLengths) || record.attemptStreamLengths.length > MAX_ATTEMPTS
    || record.attemptStreamLengths.some(item => !Number.isSafeInteger(item) || Number(item) < 0 || Number(item) > MAX_CHUNKS)) fail('Invalid bounded attempt lengths');
  if (typeof record.assistantMessages !== 'number' || !Number.isSafeInteger(record.assistantMessages) || record.assistantMessages < 0 || record.assistantMessages > 1000) fail('Invalid assistant message count');
  for (const flag of ['abortedBeforeFirstChunk', 'abortedAfterFirstChunk', 'timedOut'] as const) if (typeof record[flag] !== 'boolean') fail(`Invalid ${flag}`);
  if (typeof record.label !== 'string' || record.label.length < 1 || record.label.length > 100 || /[\u0000-\u001f]/.test(record.label)) fail('Invalid controlled label');
  if (record.elapsedMs !== undefined && (typeof record.elapsedMs !== 'number' || !Number.isSafeInteger(record.elapsedMs) || record.elapsedMs < 0 || record.elapsedMs > 3_600_000)) fail('Invalid elapsed time');
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) fail('Diagnostic exceeds its bound');
  // Reject obvious raw provider/prompt/path echoes even if a caller tries to smuggle them into labels.
  if (/\/(?:Users|home|private|var|tmp)\//.test(serialized) || /\b(?:Bearer|sk-|api[_-]?key)\b/i.test(serialized)) fail('Diagnostic contains disallowed provider/path material');
  return structuredClone(record) as unknown as ReplyStreamDiagnostic;
}
export function replyStreamDiagnosticTool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_reply_stream_diagnostic',
    description: '零模型只读诊断（owner-only）：读取最近一次本地回复操作的持久失败 reasonCode 与受控 streamDiagnostic（category/code/name/chunks/attemptStreamLengths/assistantMessages/abort/timeout/label/elapsedMs，≤400B）；不含 provider 正文、提示词、工具参数或路径；不生成、不重试、不自动修复。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: true,
    execute: async () => service.command({ action: 'runtime.reply-stream-diagnostic' }),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
  };
}
/** Safe extraction from a caught error without ever trusting its message body. */
export function replyStreamDiagnosticOf(error: unknown): ReplyStreamDiagnostic | undefined {
  const candidate = error && typeof error === 'object' && 'replyStreamDiagnostic' in error
    ? (error as { replyStreamDiagnostic?: unknown }).replyStreamDiagnostic : undefined;
  if (!candidate) return undefined;
  try { return validateReplyStreamDiagnostic(candidate); } catch { return undefined; }
}
