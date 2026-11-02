import { isAbsolute } from 'node:path';
import { Client, ProtocolError, ProtocolErrorCode, type CallToolResult, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

/** Only trusted host composition may construct this configuration; it is not an Agent tool schema. */
export interface PrivateStdioMcpOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  maxMessageBytes?: number;
  maxStderrBytes?: number;
}
export interface McpCallOptions { signal?: AbortSignal; timeoutMs?: number }
export interface PrivateMcpRequest { name: string; arguments: Readonly<Record<string, unknown>> }
export type PrivateMcpState = 'idle' | 'connecting' | 'ready' | 'failed' | 'closing' | 'closed';
export class PrivateMcpError extends Error {
  constructor(readonly code: 'INVALID_CONFIG' | 'INVALID_REQUEST' | 'NOT_READY' | 'BUSY' | 'CANCELLED' | 'TIMEOUT' | 'CONNECTION_FAILED' | 'CALL_FAILED' | 'DISCONNECTED' | 'CLOSE_UNCONFIRMED') {
    super(`Private MCP ${code.toLowerCase().replaceAll('_', ' ')}`); this.name = 'PrivateMcpError';
  }
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new PrivateMcpError('INVALID_CONFIG');
  return result;
}
function safeText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
}
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
  });
}

/** Private control-domain transport: no tool registration, model request, reconnect or call replay. */
export class PrivateStdioMcpClient {
  readonly #options: Required<Omit<PrivateStdioMcpOptions, 'env'>> & { env: Record<string, string> };
  #state: PrivateMcpState = 'idle';
  #client?: Client;
  #transport?: StdioClientTransport;
  #tools = new Map<string, Tool>();
  #stop = new AbortController();
  #operation?: Promise<unknown>;
  #closing?: Promise<void>;
  #resolveTransportClosed!: () => void;
  #transportClosed = new Promise<void>(resolve => { this.#resolveTransportClosed = resolve; });
  #closeObserved = false;
  #stderrBytes = 0;
  #stderrTruncated = false;
  #pid: number | null = null;

  /** Validation/copy only. Connecting is always explicit. */
  constructor(options: PrivateStdioMcpOptions) {
    if (!options || !safeText(options.command, 4096) || !isAbsolute(options.command) || !safeText(options.cwd, 4096) || !isAbsolute(options.cwd)
      || !Array.isArray(options.args ?? []) || (options.args?.length ?? 0) > 64 || options.args?.some(arg => typeof arg !== 'string' || arg.length > 16384 || arg.includes('\0'))
      || (options.env !== undefined && (!options.env || typeof options.env !== 'object' || Array.isArray(options.env)))) throw new PrivateMcpError('INVALID_CONFIG');
    const env = options.env ?? {};
    if (Object.keys(env).length > 64 || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.length > 16384 || value.includes('\0'))) throw new PrivateMcpError('INVALID_CONFIG');
    this.#options = { command: options.command, cwd: options.cwd, args: [...options.args ?? []], env: { ...env },
      connectTimeoutMs: bounded(options.connectTimeoutMs, 10000, 60000), callTimeoutMs: bounded(options.callTimeoutMs, 15000, 60000),
      maxMessageBytes: bounded(options.maxMessageBytes, 1048576, 4194304), maxStderrBytes: bounded(options.maxStderrBytes, 16384, 65536) };
  }
  /** No stderr text, process arguments, environment, backend errors or tool bodies are exposed. */
  status(): Readonly<{ state: PrivateMcpState; pid: number | null; toolCount: number; stderrBytes: number; stderrTruncated: boolean }> {
    return Object.freeze({ state: this.#state, pid: this.#state === 'closed' ? null : this.#pid, toolCount: this.#tools.size, stderrBytes: this.#stderrBytes, stderrTruncated: this.#stderrTruncated });
  }
  async #bounded<T>(timeoutMs: number, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort(new PrivateMcpError('CANCELLED'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const fused = AbortSignal.any([controller.signal, this.#stop.signal]);
    const timer = setTimeout(() => controller.abort(new PrivateMcpError('TIMEOUT')), timeoutMs);
    try { fused.throwIfAborted(); return await raceAbort(Promise.resolve().then(() => { fused.throwIfAborted(); return action(fused); }), fused); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  #fail(code: 'CONNECTION_FAILED' | 'CALL_FAILED' | 'DISCONNECTED', error?: unknown): PrivateMcpError {
    if (this.#state !== 'closing' && this.#state !== 'closed') this.#state = 'failed';
    const failure = error instanceof PrivateMcpError ? error : new PrivateMcpError(code);
    if (!this.#stop.signal.aborted) this.#stop.abort(failure);
    return failure;
  }
  async connect(options: McpCallOptions = {}): Promise<void> {
    if (this.#state !== 'idle') throw new PrivateMcpError('NOT_READY');
    if (options.signal?.aborted) throw new PrivateMcpError('CANCELLED');
    const timeout = bounded(options.timeoutMs, this.#options.connectTimeoutMs, 60000);
    this.#state = 'connecting';
    const work = this.#bounded(timeout, options.signal, async signal => {
      const client = this.#client = new Client({ name: 'shiyu-private-control', version: '0.1.0' }, {
        capabilities: {}, versionNegotiation: { mode: 'legacy' }, listMaxPages: 4, inputRequired: { autoFulfill: false },
      });
      // No sampling, elicitation, roots, authentication UI or delegated Agent requests.
      client.fallbackRequestHandler = async () => { throw new ProtocolError(ProtocolErrorCode.MethodNotFound, 'Server-initiated requests are disabled'); };
      const transport = this.#transport = new StdioClientTransport({ command: this.#options.command, args: [...this.#options.args], cwd: this.#options.cwd,
        env: { ...this.#options.env }, stderr: 'pipe', maxBufferSize: this.#options.maxMessageBytes });
      transport.stderr?.on('data', (chunk: Buffer | string) => {
        const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
        this.#stderrTruncated ||= this.#stderrBytes + bytes > this.#options.maxStderrBytes;
        this.#stderrBytes = Math.min(this.#options.maxStderrBytes, this.#stderrBytes + bytes);
      });
      client.onclose = () => {
        this.#closeObserved = true; this.#resolveTransportClosed();
        if (this.#state !== 'closing' && this.#state !== 'closed') this.#fail('DISCONNECTED');
      };
      client.onerror = () => {
        if (this.#state !== 'closing' && this.#state !== 'closed') { this.#fail('CONNECTION_FAILED'); void this.close().catch(() => {}); }
      };
      await client.connect(transport, { signal, timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false });
      this.#pid = transport.pid;
      const listed = await client.listTools(undefined, { signal, timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false, cacheMode: 'refresh' });
      signal.throwIfAborted();
      if (listed.tools.length > 128 || Buffer.byteLength(JSON.stringify(listed)) > this.#options.maxMessageBytes) throw new PrivateMcpError('CONNECTION_FAILED');
      for (const tool of listed.tools) {
        if (!safeText(tool.name, 128) || this.#tools.has(tool.name)) throw new PrivateMcpError('CONNECTION_FAILED');
        this.#tools.set(tool.name, structuredClone(tool));
      }
      this.#state = 'ready';
    });
    this.#operation = work;
    try { await work; }
    catch (error) { const failure = this.#fail('CONNECTION_FAILED', error); await this.close(); throw failure; }
    finally { if (this.#operation === work) this.#operation = undefined; }
  }
  /** Returns detached discovery data; it never registers schemas or instructions with an Agent. */
  listTools(): readonly Tool[] {
    if (this.#state !== 'ready') throw new PrivateMcpError('NOT_READY');
    return structuredClone([...this.#tools.values()]);
  }
  /** Structural superset of OmbreMcpTransport.callTool; authority is supplied by its trusted caller. */
  async callTool(request: PrivateMcpRequest, options: McpCallOptions = {}): Promise<CallToolResult> {
    if (this.#state !== 'ready') throw new PrivateMcpError('NOT_READY');
    if (this.#operation) throw new PrivateMcpError('BUSY');
    if (options.signal?.aborted) throw new PrivateMcpError('CANCELLED');
    const timeout = bounded(options.timeoutMs, this.#options.callTimeoutMs, 60000);
    const tool = this.#tools.get(request?.name);
    if (!tool || tool.execution?.taskSupport === 'required' || !request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) throw new PrivateMcpError('INVALID_REQUEST');
    let args: Record<string, unknown>;
    try {
      const encoded = JSON.stringify(request.arguments);
      if (Buffer.byteLength(encoded) > this.#options.maxMessageBytes) throw new Error();
      args = JSON.parse(encoded) as Record<string, unknown>;
    } catch { throw new PrivateMcpError('INVALID_REQUEST'); }
    const work = this.#bounded(timeout, options.signal, async signal => {
      // A fixed definition also disables the SDK's modern header-mismatch refresh/replay path.
      const result = await this.#client!.callTool({ name: tool.name, arguments: args }, {
        signal, timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false, toolDefinition: tool,
      });
      signal.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(result)) > this.#options.maxMessageBytes) throw new PrivateMcpError('CALL_FAILED');
      return result;
    });
    this.#operation = work;
    try { return await work; }
    catch (error) { const failure = this.#fail('CALL_FAILED', error); await this.close(); throw failure; }
    finally { if (this.#operation === work) this.#operation = undefined; }
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#state = 'closing';
    if (!this.#stop.signal.aborted) this.#stop.abort(new PrivateMcpError('CANCELLED'));
    const client = this.#client, transport = this.#transport;
    this.#closing = (async () => {
      const timer = new AbortController();
      const timeout = setTimeout(() => timer.abort(new PrivateMcpError('CLOSE_UNCONFIRMED')), 5500);
      try {
        await raceAbort((async () => {
          // The SDK closes only the child spawned by this transport, never an arbitrary external PID.
          await client?.close();
          if (transport && !this.#closeObserved) await this.#transportClosed;
        })(), timer.signal);
        this.#tools.clear(); this.#state = 'closed';
      } catch { this.#state = 'failed'; throw new PrivateMcpError('CLOSE_UNCONFIRMED'); }
      finally { clearTimeout(timeout); }
    })();
    return this.#closing;
  }
}
