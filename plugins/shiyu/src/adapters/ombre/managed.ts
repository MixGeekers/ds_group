import { constants } from 'node:fs';
import { access, lstat, open, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PrivateStdioMcpClient, type McpCallOptions, type PrivateStdioMcpOptions } from '../mcp/index.js';
import { ControlledOmbreAdapter } from './controlled.js';
import { ManagedHarrier, type ManagedHarrierConfig, type ManagedHarrierStatus } from '../embedding/managed.js';
import { OMBRE_HARRIER_PROFILE_ID, OMBRE_HARRIER_PROFILE_FINGERPRINT, type SemanticBackendStatus,
  type MemoryIndexObservation, type MemorySearchResult } from '../../contracts/semantic-memory.js';

export interface ManagedOmbreConfigV1 {
  schemaVersion: 1; backendId: string; deploymentId: string; scope: 'local-owner';
  python: string; upstream: string; root: string; embedding: 'disabled';
}
export interface ManagedOmbreConfigV2 {
  schemaVersion: 2; backendId: string; deploymentId: string; scope: 'local-owner';
  python: string; upstream: string; root: string;
  embedding: ManagedHarrierConfig & { mode: 'managed-harrier'; profileId: 'harrier-oss-v1-0.6b-q8_0-1024-ombre-head2000-v1' };
}
export type ManagedOmbreConfig = ManagedOmbreConfigV1 | ManagedOmbreConfigV2;
export type ManagedOmbreState = 'idle' | 'opening' | 'ready' | 'failed' | 'closing' | 'closed';
export interface ManagedOmbreStatus {
  configured: true; state: ManagedOmbreState; backendId: string; deploymentId: string; scope: 'local-owner';
  embedding: 'disabled' | 'managed-harrier'; semanticReady: boolean; bindingVerified: boolean;
  /** Added in v2; optional only for existing trusted v1 host test doubles. */
  storageReady?: boolean;
  harrier?: ManagedHarrierStatus;
  protocolVersion?: 1 | 2;
  semantic?: {
    /** Inference verification is from a new query HTTP call in this process, never an old index receipt. */
    state: 'disabled' | 'unverified' | 'ready' | 'unavailable'; profileCompatible: boolean; embeddingVerified: boolean;
    profileId: string | null; profileFingerprint: string | null; indexBaselineId: string | null; indexWatermark: number | null;
    recordedIndexedCount: number | null; observedAt: string | null; lastEmbeddingSuccessAt: string | null;
  };
  toolCount: number; stderrBytes: number; stderrTruncated: boolean; lastErrorCode?: ManagedOmbreError['code'];
}
export type ManagedOmbreTransport = Pick<PrivateStdioMcpClient, 'connect' | 'listTools' | 'callTool' | 'status' | 'close'>;
export type ManagedOmbreHarrier = Pick<ManagedHarrier, 'open' | 'status' | 'close'>;
export interface ManagedOmbreOptions {
  /** Trusted dependency injection for deterministic tests; never read from backend.json or model input. */
  transportFactory?(options: PrivateStdioMcpOptions): ManagedOmbreTransport;
  harrierFactory?(config: ManagedHarrierConfig): ManagedOmbreHarrier;
}
export class ManagedOmbreError extends Error {
  constructor(readonly code: 'INVALID_CONFIG' | 'INVALID_PATH' | 'UNSUPPORTED_PLATFORM' | 'NOT_READY' | 'CANCELLED' | 'TIMEOUT' | 'TOOL_MISMATCH' | 'BINDING_MISMATCH' | 'OPEN_FAILED' | 'CLOSE_UNCONFIRMED' | 'DISCONNECTED' | 'EMBEDDING_UNAVAILABLE') {
    super(`Managed Ombre ${code.toLowerCase().replaceAll('_', ' ')}`); this.name = 'ManagedOmbreError';
  }
}
const MAX_CONFIG_BYTES = 16384;
const SERVICE_PATH = fileURLToPath(new URL('../../../service/ombre/service.py', import.meta.url));
const ENV_COMMAND = '/usr/bin/env';
const TOOL_ARGUMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  shiyu_memory_create: ['body', 'command', 'commandDigest'],
  shiyu_memory_get: ['nativeId', 'scope'],
  shiyu_memory_operation_status: ['operationId', 'scope'],
});
const SEMANTIC_TOOL_ARGUMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...TOOL_ARGUMENTS,
  shiyu_memory_backend_status: ['scope'],
  shiyu_memory_index_ensure: ['command', 'commandDigest'],
  shiyu_memory_index_status: ['indexOperationId', 'scope'],
  shiyu_memory_search_candidates: ['deadlineAtMs', 'eligibleRefs', 'expectedIndexBaselineId', 'expectedIndexWatermark', 'limit', 'profileFingerprint', 'query', 'scope'],
});
const fields = ['schemaVersion', 'backendId', 'deploymentId', 'scope', 'python', 'upstream', 'root', 'embedding'] as const;
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(value);
const absolutePath = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && value.length > 1 && !/[\u0000-\u001f]/u.test(value) && isAbsolute(value) && normalize(value) === value;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function contains(parent: string, child: string): boolean { const path = relative(parent, child); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); }
/** Resolve aliases even when the dedicated root has not been created yet. No mkdir. */
async function resolvedFuturePath(value: string): Promise<string> {
  const missing: string[] = []; let current = value;
  for (;;) {
    try { return resolve(await realpath(current), ...missing); }
    catch (error) {
      if (!record(error) || error.code !== 'ENOENT' || dirname(current) === current) throw error;
      missing.unshift(basename(current)); current = dirname(current);
    }
  }
}
function validateConfig(value: unknown): Readonly<ManagedOmbreConfig> {
  if (!record(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))
    || ![1, 2].includes(Number(value.schemaVersion)) || typeof value.schemaVersion !== 'number' || !identity(value.backendId) || !identity(value.deploymentId) || value.scope !== 'local-owner'
    || !absolutePath(value.python) || !absolutePath(value.upstream) || !absolutePath(value.root)
    || value.root === sep || contains(value.root, value.upstream) || contains(value.upstream, value.root) || contains(value.root, value.python)) throw new ManagedOmbreError('INVALID_CONFIG');
  const base = { backendId: value.backendId, deploymentId: value.deploymentId, scope: value.scope,
    python: value.python, upstream: value.upstream, root: value.root } as const;
  if (value.schemaVersion === 1) {
    if (value.embedding !== 'disabled') throw new ManagedOmbreError('INVALID_CONFIG');
    return Object.freeze({ ...base, schemaVersion: 1, embedding: 'disabled' });
  }
  const embedding = value.embedding;
  if (!record(embedding) || !equal(Object.keys(embedding).sort(), ['mode', 'modelArtifact', 'profileId', 'serverBinary'])
    || embedding.mode !== 'managed-harrier' || embedding.profileId !== OMBRE_HARRIER_PROFILE_ID
    || !absolutePath(embedding.serverBinary) || !absolutePath(embedding.modelArtifact)
    || contains(value.root, embedding.serverBinary) || contains(value.root, embedding.modelArtifact)) throw new ManagedOmbreError('INVALID_CONFIG');
  return Object.freeze({ ...base, schemaVersion: 2, embedding: Object.freeze({ mode: 'managed-harrier', profileId: embedding.profileId,
    serverBinary: embedding.serverBinary, modelArtifact: embedding.modelArtifact }) });
}

/** Reads one bounded, regular descriptor only. Missing configuration never installs or launches anything. */
export async function loadManagedOmbreConfig(dataDir: string): Promise<Readonly<ManagedOmbreConfig> | undefined> {
  if (!absolutePath(dataDir)) throw new ManagedOmbreError('INVALID_PATH');
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(join(dataDir, 'memory', 'backend.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (record(error) && error.code === 'ENOENT') return undefined;
    throw new ManagedOmbreError('INVALID_CONFIG');
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) throw new ManagedOmbreError('INVALID_CONFIG');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break; bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_CONFIG_BYTES) throw new ManagedOmbreError('INVALID_CONFIG');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))); }
    catch { throw new ManagedOmbreError('INVALID_CONFIG'); }
    return validateConfig(value);
  } catch (error) { throw error instanceof ManagedOmbreError ? error : new ManagedOmbreError('INVALID_CONFIG'); }
  finally { await handle.close(); }
}

/**
 * Owns only its private stdio transport. Construction/status perform no spawn.
 * SDK stdio merges HOME/LOGNAME/PATH/SHELL/TERM/USER on POSIX even with env:{};
 * fixed /usr/bin/env -i discards that inheritance BEFORE Python startup. Only
 * these literal runtime settings plus a host-selected temp directory are passed;
 * OS startup may add platform metadata such as macOS text encoding.
 * -I disables Python user-site/PYTHONPATH; fixed service.py explicitly imports
 * its own sibling modules. No shell, provider key, proxy, dotenv or model config
 * is accepted. Source fingerprint and old-root identity are checked by Python.
 */
export class ManagedOmbreBackend {
  readonly adapter: ControlledOmbreAdapter;
  readonly #config: Readonly<ManagedOmbreConfig>;
  #state: ManagedOmbreState = 'idle';
  #client?: ManagedOmbreTransport;
  #harrier?: ManagedOmbreHarrier;
  #opening?: Promise<void>;
  #closing?: Promise<void>;
  #disposal?: Promise<void>;
  #stop = new AbortController();
  #bindingVerified = false;
  #lastErrorCode?: ManagedOmbreError['code'];
  #semanticStatus?: SemanticBackendStatus;
  #semanticCountCurrent = false;
  #semanticObservedAt?: string;
  #lastEmbeddingSuccessAt?: string;
  constructor(config: ManagedOmbreConfig, private readonly options: ManagedOmbreOptions = {}) {
    this.#config = validateConfig(config);
    if ([options.transportFactory, options.harrierFactory].some(value => value !== undefined && typeof value !== 'function')) throw new ManagedOmbreError('INVALID_CONFIG');
    this.adapter = new ControlledOmbreAdapter({ callTool: async (request, callOptions) => {
      if (this.#currentState() !== 'ready') throw new ManagedOmbreError('NOT_READY');
      if (!Object.hasOwn(TOOL_ARGUMENTS, request.name) && !this.#harrierReady()) throw new ManagedOmbreError('EMBEDDING_UNAVAILABLE');
      this.#assertTools();
      const result = await this.#client!.callTool(request, callOptions);
      if (this.#currentState() !== 'ready') throw new ManagedOmbreError('NOT_READY');
      if (!Object.hasOwn(TOOL_ARGUMENTS, request.name) && !this.#harrierReady()) throw new ManagedOmbreError('EMBEDDING_UNAVAILABLE');
      this.#assertTools(); return result;
    } }, this.#config, { semanticApi: this.#config.schemaVersion === 2, onSemanticObservation: value => this.#observeSemantic(value) });
  }
  #harrierReady(): boolean {
    const status = this.#harrier?.status(); return status?.state === 'ready' && status.verified;
  }
  #observeSemantic(value: SemanticBackendStatus | MemoryIndexObservation | MemorySearchResult): void {
    this.#semanticObservedAt = new Date().toISOString();
    if ('semanticApi' in value) {
      if (this.#semanticStatus && value.indexBaselineId === this.#semanticStatus.indexBaselineId && value.indexWatermark < this.#semanticStatus.indexWatermark) {
        this.#semanticStatus = undefined; this.#lastEmbeddingSuccessAt = undefined; this.#semanticCountCurrent = false; return;
      }
      if (this.#semanticStatus?.indexBaselineId !== value.indexBaselineId) this.#lastEmbeddingSuccessAt = undefined;
      this.#semanticStatus = structuredClone(value); this.#semanticCountCurrent = true;
    }
    else if (this.#semanticStatus) {
      const indexBaselineId = 'currentIndexBaselineId' in value ? value.currentIndexBaselineId : value.indexBaselineId;
      const indexWatermark = 'currentIndexWatermark' in value ? value.currentIndexWatermark : value.indexWatermark;
      if (indexBaselineId !== this.#semanticStatus.indexBaselineId || indexWatermark < this.#semanticStatus.indexWatermark) {
        this.#semanticStatus = undefined; this.#lastEmbeddingSuccessAt = undefined; return;
      }
      this.#semanticStatus = { ...this.#semanticStatus, indexWatermark };
      this.#semanticCountCurrent = false;
      // Index observations carry historical operation usage, including after a
      // new provider process starts. Only a fresh query reports this RPC's work.
      if ('queryDigest' in value && value.embeddingCalls > 0 && value.state === 'ok') this.#lastEmbeddingSuccessAt = this.#semanticObservedAt;
    }
  }
  #currentState(): ManagedOmbreState {
    return this.#state === 'ready' && this.#client?.status().state !== 'ready' ? 'failed' : this.#state;
  }
  status(): Readonly<ManagedOmbreStatus> {
    const transport = this.#client?.status(), state = this.#currentState();
    const storageReady = state === 'ready' && this.#bindingVerified, enabled = this.#config.schemaVersion === 2;
    const profileCompatible = this.#semanticStatus?.profileFingerprint === OMBRE_HARRIER_PROFILE_FINGERPRINT;
    const dependencyReady = storageReady && this.#harrierReady() && profileCompatible;
    const embeddingVerified = dependencyReady && this.#lastEmbeddingSuccessAt !== undefined;
    return Object.freeze({ configured: true, state, backendId: this.#config.backendId, deploymentId: this.#config.deploymentId, scope: 'local-owner',
      embedding: enabled ? 'managed-harrier' : 'disabled', semanticReady: embeddingVerified, bindingVerified: this.#bindingVerified, storageReady,
      protocolVersion: enabled ? 2 : 1, ...(this.#harrier ? { harrier: this.#harrier.status() } : {}),
      semantic: { state: !enabled ? 'disabled' : !dependencyReady ? 'unavailable' : embeddingVerified ? 'ready' : 'unverified',
        profileCompatible, embeddingVerified, profileId: enabled ? OMBRE_HARRIER_PROFILE_ID : null,
        profileFingerprint: this.#semanticStatus?.profileFingerprint ?? null, indexBaselineId: this.#semanticStatus?.indexBaselineId ?? null,
        indexWatermark: this.#semanticStatus?.indexWatermark ?? null, recordedIndexedCount: this.#semanticCountCurrent ? this.#semanticStatus?.recordedIndexedCount ?? null : null,
        observedAt: this.#semanticObservedAt ?? null, lastEmbeddingSuccessAt: this.#lastEmbeddingSuccessAt ?? null } as const,
      toolCount: transport?.toolCount ?? 0, stderrBytes: transport?.stderrBytes ?? 0, stderrTruncated: transport?.stderrTruncated ?? false,
      ...(this.#lastErrorCode ? { lastErrorCode: this.#lastErrorCode } : state === 'failed' ? { lastErrorCode: 'DISCONNECTED' as const } : {}) });
  }
  async #paths(): Promise<{ upstream: string; root: string }> {
    if (!['darwin', 'linux'].includes(process.platform)) throw new ManagedOmbreError('UNSUPPORTED_PLATFORM');
    try {
      const [python, upstream, service, launcher] = await Promise.all([stat(this.#config.python), stat(this.#config.upstream), lstat(SERVICE_PATH), stat(ENV_COMMAND)]);
      if (!python.isFile() || !upstream.isDirectory() || !service.isFile() || service.isSymbolicLink() || !launcher.isFile()) throw new Error();
      await Promise.all([access(this.#config.python, constants.X_OK), access(ENV_COMMAND, constants.X_OK), access(SERVICE_PATH, constants.R_OK)]);
      try { const root = await lstat(this.#config.root); if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(); }
      catch (error) { if (!record(error) || error.code !== 'ENOENT') throw error; }
      const [canonicalPython, canonicalUpstream, canonicalRoot] = await Promise.all([realpath(this.#config.python), realpath(this.#config.upstream), resolvedFuturePath(this.#config.root)]);
      if (canonicalRoot === sep || contains(canonicalRoot, canonicalUpstream) || contains(canonicalUpstream, canonicalRoot) || contains(canonicalRoot, canonicalPython)) throw new Error();
      if (this.#config.schemaVersion === 2) {
        const [server, model] = await Promise.all([realpath(this.#config.embedding.serverBinary), realpath(this.#config.embedding.modelArtifact)]);
        if (contains(canonicalRoot, server) || contains(canonicalRoot, model)) throw new Error();
      }
      return { upstream: canonicalUpstream, root: canonicalRoot };
    } catch { throw new ManagedOmbreError('INVALID_PATH'); }
  }
  #launchOptions(paths: { upstream: string; root: string }, embedding?: { endpoint: string; keyFile: string }): PrivateStdioMcpOptions {
    return { command: ENV_COMMAND, args: ['-i', 'PATH=/usr/bin:/bin', `TMPDIR=${tmpdir()}`, 'LANG=C.UTF-8', 'LC_ALL=C.UTF-8', 'PYTHONDONTWRITEBYTECODE=1',
      this.#config.python, '-I', '-B', '-u', SERVICE_PATH, '--upstream', paths.upstream, '--root', paths.root,
      '--backend-id', this.#config.backendId, '--scope', this.#config.scope, '--deployment-id', this.#config.deploymentId,
      ...embedding ? ['--semantic-api', '--embedding-endpoint', embedding.endpoint, '--embedding-key-file', embedding.keyFile] : ['--without-embedding']],
      cwd: dirname(SERVICE_PATH), env: {}, connectTimeoutMs: 10000, callTimeoutMs: 15000, maxMessageBytes: 262144, maxStderrBytes: 16384 };
  }
  #assertTools(): void {
    let tools: ReturnType<ManagedOmbreTransport['listTools']>;
    try { tools = this.#client!.listTools(); } catch { throw new ManagedOmbreError('TOOL_MISMATCH'); }
    const contracts = this.#config.schemaVersion === 1 ? TOOL_ARGUMENTS : SEMANTIC_TOOL_ARGUMENTS;
    const count = Object.keys(contracts).length;
    if (tools.length !== count || new Set(tools.map(tool => tool.name)).size !== count) throw new ManagedOmbreError('TOOL_MISMATCH');
    for (const tool of tools) {
      const expected = contracts[tool.name];
      if (!expected || tool.execution?.taskSupport === 'required' || tool.inputSchema?.type !== 'object'
        || !record(tool.inputSchema.properties) || !equal(Object.keys(tool.inputSchema.properties).sort(), expected)
        || !Array.isArray(tool.inputSchema.required) || !equal([...tool.inputSchema.required].sort(), expected)) throw new ManagedOmbreError('TOOL_MISMATCH');
      if (this.#config.schemaVersion === 2 && expected.some(key => {
        const schema = tool.inputSchema.properties![key];
        const type = key === 'command' ? 'object' : key === 'eligibleRefs' ? 'array' : ['limit', 'expectedIndexWatermark', 'deadlineAtMs'].includes(key) ? 'integer' : 'string';
        return !record(schema) || schema.type !== type;
      })) throw new ManagedOmbreError('TOOL_MISMATCH');
    }
  }
  async #checkBinding(options: McpCallOptions): Promise<void> {
    const operationId = `managed-probe:${randomUUID()}`;
    const response = await this.#client!.callTool({ name: 'shiyu_memory_operation_status', arguments: { operationId, scope: this.#config.scope } }, options);
    if (!record(response) || (response.isError !== undefined && response.isError !== false) || !Array.isArray(response.content) || response.content.length !== 1
      || !record(response.content[0]) || response.content[0].type !== 'text' || typeof response.content[0].text !== 'string'
      || Buffer.byteLength(response.content[0].text) > 16384) throw new ManagedOmbreError('BINDING_MISMATCH');
    let body: unknown;
    try { body = JSON.parse(response.content[0].text); } catch { throw new ManagedOmbreError('BINDING_MISMATCH'); }
    const structured = response.structuredContent;
    const keys = ['schemaVersion', 'backendId', 'deploymentId', 'scope', 'operationId', 'state', 'command', 'commandDigest', 'plannedNativeId', 'nativeId', 'receipt', 'reason'];
    if (!record(body) || Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key)) || body.schemaVersion !== 1
      || body.backendId !== this.#config.backendId || body.deploymentId !== this.#config.deploymentId || body.scope !== this.#config.scope || body.operationId !== operationId || body.state !== 'absent'
      || ['command', 'commandDigest', 'plannedNativeId', 'nativeId', 'receipt', 'reason'].some(key => body[key] !== null)
      || (structured !== undefined && (!record(structured) || Object.keys(structured).length !== keys.length || keys.some(key => structured[key] !== body[key])))) throw new ManagedOmbreError('BINDING_MISMATCH');
  }
  async open(options: McpCallOptions = {}): Promise<void> {
    if (this.#state !== 'idle') throw new ManagedOmbreError('NOT_READY');
    if (options.signal?.aborted) throw new ManagedOmbreError('CANCELLED');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60000)) throw new ManagedOmbreError('INVALID_CONFIG');
    this.#state = 'opening';
    const expiry = new AbortController(), duration = options.timeoutMs ?? (this.#config.schemaVersion === 2 ? 60000 : 10000), deadline = Date.now() + duration;
    const timer = setTimeout(() => expiry.abort(new ManagedOmbreError('TIMEOUT')), duration);
    const signal = AbortSignal.any([this.#stop.signal, expiry.signal, ...options.signal ? [options.signal] : []]);
    const remaining = (): McpCallOptions => {
      signal.throwIfAborted(); const timeoutMs = deadline - Date.now();
      if (timeoutMs < 1) throw new ManagedOmbreError('TIMEOUT'); return { signal, timeoutMs };
    };
    const work = (async () => {
      try {
        const paths = await this.#paths(); signal.throwIfAborted();
        let embedding: { endpoint: string; keyFile: string } | undefined;
        if (this.#config.schemaVersion === 2) {
          const config = { serverBinary: this.#config.embedding.serverBinary, modelArtifact: this.#config.embedding.modelArtifact };
          this.#harrier = this.options.harrierFactory?.(config) ?? new ManagedHarrier(config);
          embedding = await this.#harrier.open(remaining()); signal.throwIfAborted();
          if (!this.#harrierReady()) throw new ManagedOmbreError('EMBEDDING_UNAVAILABLE');
        }
        const launch = this.#launchOptions(paths, embedding);
        this.#client = this.options.transportFactory?.(launch) ?? new PrivateStdioMcpClient(launch);
        await this.#client.connect(remaining()); signal.throwIfAborted();
        this.#assertTools(); await this.#checkBinding(remaining()); signal.throwIfAborted(); this.#assertTools();
        if (this.#config.schemaVersion === 2) {
          const probe = new ControlledOmbreAdapter(this.#client, this.#config, { semanticApi: true });
          try { this.#observeSemantic(await probe.backendStatus(remaining())); }
          catch { signal.throwIfAborted(); throw new ManagedOmbreError('BINDING_MISMATCH'); }
          signal.throwIfAborted(); this.#assertTools();
          if (!this.#harrierReady()) throw new ManagedOmbreError('EMBEDDING_UNAVAILABLE');
        }
        this.#bindingVerified = true; this.#state = 'ready';
      } catch (error) {
        const failure = expiry.signal.aborted ? new ManagedOmbreError('TIMEOUT') : signal.aborted ? new ManagedOmbreError('CANCELLED') : error instanceof ManagedOmbreError ? error : new ManagedOmbreError('OPEN_FAILED');
        this.#lastErrorCode = failure.code;
        try { await this.#dispose(); } catch { this.#lastErrorCode = 'CLOSE_UNCONFIRMED'; this.#state = 'failed'; throw new ManagedOmbreError('CLOSE_UNCONFIRMED'); }
        if (this.#state !== 'closing' && this.#state !== 'closed') this.#state = 'failed';
        throw failure;
      } finally { clearTimeout(timer); }
    })();
    this.#opening = work; await work;
  }
  #dispose(): Promise<void> {
    return this.#disposal ??= (async () => {
      let failed = false;
      try { await this.#client?.close(); } catch { failed = true; }
      // The only process capable of issuing embeddings is stopped before its provider.
      try { await this.#harrier?.close(); } catch { failed = true; }
      if (failed) throw new ManagedOmbreError('CLOSE_UNCONFIRMED');
    })();
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#state = 'closing'; this.#stop.abort(new ManagedOmbreError('CANCELLED'));
    this.#closing = (async () => {
      try { await this.#dispose(); await this.#opening?.catch(() => undefined); this.#state = 'closed'; }
      catch { this.#state = 'failed'; this.#lastErrorCode = 'CLOSE_UNCONFIRMED'; throw new ManagedOmbreError('CLOSE_UNCONFIRMED'); }
    })(); return this.#closing;
  }
}
