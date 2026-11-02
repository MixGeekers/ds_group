import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';

/** The profile pins the user's already-evaluated artifact, not an arbitrary HF download. */
export const HARRIER_PROFILE = Object.freeze({
  id: 'harrier-oss-v1-0.6b-q8_0-1024-v1',
  model: 'shiyu-harrier-0.6b-q8_0',
  upstream: 'microsoft/harrier-oss-v1-0.6b',
  upstreamRevision: 'f9b9dc8d367d443f2479d27aa5d8d2850c0774ee',
  artifactSha256: 'b017b8fceae7c77864652c63d07af51480088b078771a89cafe1a467b069ea75',
  artifactBytes: 639447904,
  dimensions: 1024,
  pooling: 'last',
  normalization: 'l2',
  queryPrefix: 'Instruct: Given a user query about personal chat memories, retrieve the most relevant memory entries that answer the query\nQuery: ',
  documentPrefix: '',
} as const);

export interface EmbeddingBatch {
  profileId: typeof HARRIER_PROFILE.id;
  dimensions: typeof HARRIER_PROFILE.dimensions;
  vectors: number[][];
}
export interface EmbeddingOptions { signal?: AbortSignal }
export interface LocalHarrierConfig {
  /** Exact endpoint, e.g. http://127.0.0.1:18333/v1/embeddings. No DNS or remote host. */
  endpoint: string;
  timeoutMs?: number;
  /** For transport tests; production uses global fetch. */
  fetch?: typeof globalThis.fetch;
}
export class EmbeddingError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'EmbeddingError'; }
}
const MAX_BATCH = 32;
const MAX_TEXT_BYTES = 16384;
const MAX_REQUEST_BYTES = 262144;
const MAX_RESPONSE_BYTES = 2097152;

export function validateLocalEmbeddingEndpoint(endpoint: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new EmbeddingError('INVALID_ENDPOINT', 'Embedding endpoint must be a loopback HTTP URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/embeddings') {
    throw new EmbeddingError('INVALID_ENDPOINT', 'Embedding endpoint requires an explicit loopback IP and port at /v1/embeddings');
  }
  return url;
}

/** This checks the local file; the HTTP API itself cannot attest the server's loaded weights. */
export async function verifyHarrierArtifact(filePath: string, options: { signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  const info = await stat(filePath);
  options.signal?.throwIfAborted();
  if (!info.isFile() || info.size !== HARRIER_PROFILE.artifactBytes) {
    throw new EmbeddingError('ARTIFACT_MISMATCH', 'Harrier artifact size does not match the pinned Q8_0 file');
  }
  const file = await open(filePath, 'r');
  const header = Buffer.alloc(24);
  try { options.signal?.throwIfAborted(); await file.read(header, 0, header.length, 0); options.signal?.throwIfAborted(); } finally { await file.close(); }
  options.signal?.throwIfAborted();
  if (header.toString('ascii', 0, 4) !== 'GGUF' || header.readUInt32LE(4) !== 3 || header.readBigUInt64LE(8) !== 310n) {
    throw new EmbeddingError('ARTIFACT_FORMAT', 'Harrier artifact must be the expected GGUF v3 with 310 tensors');
  }
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath, { signal: options.signal })) { options.signal?.throwIfAborted(); digest.update(chunk); }
  options.signal?.throwIfAborted();
  const sha256 = digest.digest('hex');
  if (sha256 !== HARRIER_PROFILE.artifactSha256) throw new EmbeddingError('ARTIFACT_MISMATCH', 'Harrier artifact SHA256 does not match the pinned evaluation artifact');
  return { sha256, bytes: info.size, format: 'GGUF', version: 3, tensorCount: 310 } as const;
}

export function normalizeEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== HARRIER_PROFILE.dimensions
    || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new EmbeddingError('INVALID_VECTOR', 'Embedding must contain 1024 finite numbers');
  }
  // Scale first so very large finite components cannot overflow the norm.
  let scale = 0;
  for (const item of value) scale = Math.max(scale, Math.abs(item));
  if (scale === 0) throw new EmbeddingError('INVALID_VECTOR', 'Embedding must have a nonzero norm');
  const scaled: number[] = value.map(item => item / scale);
  const norm = Math.sqrt(scaled.reduce((sum, item) => sum + item * item, 0));
  return scaled.map(item => item / norm);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    await response.body?.cancel();
    throw new EmbeddingError('INVALID_RESPONSE', 'Embedding endpoint did not return JSON');
  }
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new EmbeddingError('RESPONSE_TOO_LARGE', 'Embedding response exceeds the configured limit');
  }
  if (!response.body) throw new EmbeddingError('INVALID_RESPONSE', 'Embedding response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > MAX_RESPONSE_BYTES) throw new EmbeddingError('RESPONSE_TOO_LARGE', 'Embedding response exceeds the configured limit');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new EmbeddingError('INVALID_RESPONSE', 'Embedding endpoint returned invalid JSON'); }
}

/** An explicitly configured local client. Construction never starts processes or makes requests. */
export class LocalHarrierEmbedder {
  readonly profile = HARRIER_PROFILE;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly transport: typeof globalThis.fetch;
  constructor(config: LocalHarrierConfig) {
    this.endpoint = validateLocalEmbeddingEndpoint(config.endpoint);
    this.timeoutMs = config.timeoutMs ?? 15000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000) {
      throw new EmbeddingError('INVALID_CONFIG', 'Embedding timeout must be 1–60000 milliseconds');
    }
    this.transport = config.fetch ?? globalThis.fetch;
  }
  embedDocuments(texts: readonly string[], options: EmbeddingOptions = {}): Promise<EmbeddingBatch> { return this.embed(texts, false, options); }
  embedQueries(texts: readonly string[], options: EmbeddingOptions = {}): Promise<EmbeddingBatch> { return this.embed(texts, true, options); }

  private async embed(texts: readonly string[], query: boolean, options: EmbeddingOptions): Promise<EmbeddingBatch> {
    options.signal?.throwIfAborted();
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_BATCH
      || texts.some(text => typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_TEXT_BYTES)) {
      throw new EmbeddingError('INVALID_INPUT', 'Embedding requires 1–32 nonempty texts, each at most 16384 UTF-8 bytes');
    }
    const body = JSON.stringify({ model: this.profile.model, input: texts.map(text => (query ? this.profile.queryPrefix : this.profile.documentPrefix) + text), encoding_format: 'float' });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new EmbeddingError('INVALID_INPUT', 'Embedding batch exceeds 262144 UTF-8 bytes');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await this.transport(this.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body,
      signal, redirect: 'manual',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new EmbeddingError('ENDPOINT_FAILURE', `Embedding endpoint returned HTTP ${response.status}`);
    }
    const raw = await readBoundedJson(response) as { model?: unknown; data?: unknown } | null;
    if (!raw || typeof raw !== 'object' || (raw.model !== undefined && raw.model !== this.profile.model)
      || !Array.isArray(raw.data) || raw.data.length !== texts.length) {
      throw new EmbeddingError('INVALID_RESPONSE', 'Embedding response model or item count does not match the request');
    }
    const vectors: number[][] = new Array(texts.length);
    for (const item of raw.data) {
      if (!item || typeof item !== 'object' || !Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length || vectors[item.index]) {
        throw new EmbeddingError('INVALID_RESPONSE', 'Embedding response indices must cover the request exactly once');
      }
      vectors[item.index] = normalizeEmbedding(item.embedding);
    }
    return { profileId: this.profile.id, dimensions: this.profile.dimensions, vectors };
  }
}
