import { constants } from 'node:fs';
import { access, lstat, open, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PrivateStdioMcpClient, type McpCallOptions, type PrivateStdioMcpOptions } from '../mcp/index.js';
import { ControlledOmbreAdapter } from './controlled.js';

export interface ManagedOmbreConfig {
  schemaVersion: 1; backendId: string; deploymentId: string; scope: 'local-owner';
  python: string; upstream: string; root: string; embedding: 'disabled';
}
export type ManagedOmbreState = 'idle' | 'opening' | 'ready' | 'failed' | 'closing' | 'closed';
export interface ManagedOmbreStatus {
  configured: true; state: ManagedOmbreState; backendId: string; deploymentId: string; scope: 'local-owner';
  embedding: 'disabled'; semanticReady: false; bindingVerified: boolean;
  toolCount: number; stderrBytes: number; stderrTruncated: boolean; lastErrorCode?: ManagedOmbreError['code'];
}
export type ManagedOmbreTransport = Pick<PrivateStdioMcpClient, 'connect' | 'listTools' | 'callTool' | 'status' | 'close'>;
export interface ManagedOmbreOptions {
  /** Trusted dependency injection for deterministic tests; never read from backend.json or model input. */
  transportFactory?(options: PrivateStdioMcpOptions): ManagedOmbreTransport;
}
export class ManagedOmbreError extends Error {
  constructor(readonly code: 'INVALID_CONFIG' | 'INVALID_PATH' | 'UNSUPPORTED_PLATFORM' | 'NOT_READY' | 'CANCELLED' | 'TOOL_MISMATCH' | 'BINDING_MISMATCH' | 'OPEN_FAILED' | 'CLOSE_UNCONFIRMED' | 'DISCONNECTED') {
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
    || value.schemaVersion !== 1 || !identity(value.backendId) || !identity(value.deploymentId) || value.scope !== 'local-owner' || value.embedding !== 'disabled'
    || !absolutePath(value.python) || !absolutePath(value.upstream) || !absolutePath(value.root)
    || value.root === sep || contains(value.root, value.upstream) || contains(value.upstream, value.root) || contains(value.root, value.python)) throw new ManagedOmbreError('INVALID_CONFIG');
  return Object.freeze({ schemaVersion: 1, backendId: value.backendId, deploymentId: value.deploymentId, scope: value.scope,
    python: value.python, upstream: value.upstream, root: value.root, embedding: 'disabled' });
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
  #opening?: Promise<void>;
  #closing?: Promise<void>;
  #disposal?: Promise<void>;
  #stop = new AbortController();
  #bindingVerified = false;
  #lastErrorCode?: ManagedOmbreError['code'];
  constructor(config: ManagedOmbreConfig, private readonly options: ManagedOmbreOptions = {}) {
    this.#config = validateConfig(config);
    if (options.transportFactory !== undefined && typeof options.transportFactory !== 'function') throw new ManagedOmbreError('INVALID_CONFIG');
    this.adapter = new ControlledOmbreAdapter({ callTool: async (request, callOptions) => {
      if (this.#currentState() !== 'ready') throw new ManagedOmbreError('NOT_READY');
      this.#assertTools();
      return this.#client!.callTool(request, callOptions);
    } }, this.#config);
  }
  #currentState(): ManagedOmbreState {
    return this.#state === 'ready' && this.#client?.status().state !== 'ready' ? 'failed' : this.#state;
  }
  status(): Readonly<ManagedOmbreStatus> {
    const transport = this.#client?.status(), state = this.#currentState();
    return Object.freeze({ configured: true, state, backendId: this.#config.backendId, deploymentId: this.#config.deploymentId, scope: 'local-owner',
      embedding: 'disabled', semanticReady: false, bindingVerified: this.#bindingVerified,
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
      return { upstream: canonicalUpstream, root: canonicalRoot };
    } catch { throw new ManagedOmbreError('INVALID_PATH'); }
  }
  #launchOptions(paths: { upstream: string; root: string }): PrivateStdioMcpOptions {
    return { command: ENV_COMMAND, args: ['-i', 'PATH=/usr/bin:/bin', `TMPDIR=${tmpdir()}`, 'LANG=C.UTF-8', 'LC_ALL=C.UTF-8', 'PYTHONDONTWRITEBYTECODE=1',
      this.#config.python, '-I', '-B', '-u', SERVICE_PATH, '--upstream', paths.upstream, '--root', paths.root,
      '--backend-id', this.#config.backendId, '--scope', this.#config.scope, '--deployment-id', this.#config.deploymentId, '--without-embedding'],
      cwd: dirname(SERVICE_PATH), env: {}, connectTimeoutMs: 10000, callTimeoutMs: 15000, maxMessageBytes: 262144, maxStderrBytes: 16384 };
  }
  #assertTools(): void {
    let tools: ReturnType<ManagedOmbreTransport['listTools']>;
    try { tools = this.#client!.listTools(); } catch { throw new ManagedOmbreError('TOOL_MISMATCH'); }
    if (tools.length !== 3 || new Set(tools.map(tool => tool.name)).size !== 3) throw new ManagedOmbreError('TOOL_MISMATCH');
    for (const tool of tools) {
      const expected = TOOL_ARGUMENTS[tool.name];
      if (!expected || tool.execution?.taskSupport === 'required' || tool.inputSchema?.type !== 'object'
        || !record(tool.inputSchema.properties) || !equal(Object.keys(tool.inputSchema.properties).sort(), expected)
        || !Array.isArray(tool.inputSchema.required) || !equal([...tool.inputSchema.required].sort(), expected)) throw new ManagedOmbreError('TOOL_MISMATCH');
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
    const signal = AbortSignal.any([this.#stop.signal, ...options.signal ? [options.signal] : []]);
    const work = (async () => {
      try {
        const paths = await this.#paths(); signal.throwIfAborted();
        const launch = this.#launchOptions(paths);
        this.#client = this.options.transportFactory?.(launch) ?? new PrivateStdioMcpClient(launch);
        await this.#client.connect({ ...options, signal }); signal.throwIfAborted();
        this.#assertTools(); await this.#checkBinding({ ...options, signal }); signal.throwIfAborted(); this.#assertTools();
        this.#bindingVerified = true; this.#state = 'ready';
      } catch (error) {
        const failure = signal.aborted ? new ManagedOmbreError('CANCELLED') : error instanceof ManagedOmbreError ? error : new ManagedOmbreError('OPEN_FAILED');
        this.#lastErrorCode = failure.code;
        try { await this.#dispose(); } catch { this.#lastErrorCode = 'CLOSE_UNCONFIRMED'; this.#state = 'failed'; throw new ManagedOmbreError('CLOSE_UNCONFIRMED'); }
        if (this.#state !== 'closing' && this.#state !== 'closed') this.#state = 'failed';
        throw failure;
      }
    })();
    this.#opening = work; await work;
  }
  #dispose(): Promise<void> { return this.#disposal ??= this.#client?.close() ?? Promise.resolve(); }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#state = 'closing'; this.#stop.abort(new ManagedOmbreError('CANCELLED'));
    this.#closing = (async () => {
      try { await this.#dispose(); await this.#opening?.catch(() => undefined); this.#state = 'closed'; }
      catch { this.#state = 'failed'; this.#lastErrorCode = 'CLOSE_UNCONFIRMED'; throw new ManagedOmbreError('CLOSE_UNCONFIRMED'); }
    })(); return this.#closing;
  }
}
