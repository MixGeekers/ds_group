import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { HARRIER_PROFILE, verifyHarrierArtifact } from './index.js';
import { HARRIER_RUNTIME_FINGERPRINT, HARRIER_RUNTIME_MANIFEST } from './runtime-manifest.js';

export interface ManagedHarrierConfig { serverBinary: string; modelArtifact: string }
export type ManagedHarrierState = 'idle' | 'opening' | 'ready' | 'failed' | 'closing' | 'closed';
export interface ManagedHarrierStatus {
  state: ManagedHarrierState; verified: boolean; profileId: typeof HARRIER_PROFILE.id;
  runtimeFingerprint: string; childGeneration: number; readinessProbe: 'not-run' | 'passed';
  /** Readiness makes no inference call and cannot attest successful embeddings. */
  embeddingVerified: false; lastErrorCode?: ManagedHarrierError['code'];
}
export interface ManagedHarrierConnection { endpoint: string; keyFile: string }
export interface ManagedHarrierOptions {
  /** Trusted composition/test seams only. These are never read from backend.json or public commands. */
  verifyFiles?(config: Readonly<ManagedHarrierConfig>, signal: AbortSignal): Promise<void>;
  spawn?(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  allocatePort?(signal: AbortSignal): Promise<number>;
  fetch?: typeof globalThis.fetch;
}
export class ManagedHarrierError extends Error {
  constructor(readonly code: 'INVALID_CONFIG' | 'INVALID_PATH' | 'UNSUPPORTED_PLATFORM' | 'RUNTIME_MISMATCH' | 'ARTIFACT_MISMATCH' | 'NOT_READY' | 'CANCELLED' | 'TIMEOUT' | 'OPEN_FAILED' | 'IDENTITY_MISMATCH' | 'DISCONNECTED' | 'CLOSE_UNCONFIRMED') {
    super(`Managed Harrier ${code.toLowerCase().replaceAll('_', ' ')}`); this.name = 'ManagedHarrierError';
  }
}
const absolute = (value: unknown): value is string => typeof value === 'string' && value.length > 1 && value.length <= 4096
  && !/[\u0000-\u001f]/u.test(value) && isAbsolute(value) && normalize(value) === value;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Hashes the complete pinned runtime, with no executable invocation. */
export async function verifyHarrierRuntime(serverBinary: string, options: { signal?: AbortSignal } = {}): Promise<void> {
  options.signal?.throwIfAborted();
  if (!absolute(serverBinary)) throw new ManagedHarrierError('INVALID_PATH');
  if (process.platform !== HARRIER_RUNTIME_MANIFEST.platform || process.arch !== HARRIER_RUNTIME_MANIFEST.arch) throw new ManagedHarrierError('UNSUPPORTED_PLATFORM');
  for (const entry of HARRIER_RUNTIME_MANIFEST.files) {
    options.signal?.throwIfAborted();
    const path = entry.name === 'llama-server' ? serverBinary : join(dirname(serverBinary), entry.name);
    try {
      const info = await lstat(path); options.signal?.throwIfAborted();
      if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes) throw new ManagedHarrierError('RUNTIME_MISMATCH');
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(path, { signal: options.signal })) { options.signal?.throwIfAborted(); digest.update(chunk); }
      options.signal?.throwIfAborted();
      if (digest.digest('hex') !== entry.sha256) throw new ManagedHarrierError('RUNTIME_MISMATCH');
      if ('alias' in entry && typeof entry.alias === 'string' && await realpath(join(dirname(serverBinary), entry.alias)) !== await realpath(path)) throw new ManagedHarrierError('RUNTIME_MISMATCH');
      options.signal?.throwIfAborted();
    } catch (error) { options.signal?.throwIfAborted(); throw error instanceof ManagedHarrierError ? error : new ManagedHarrierError('RUNTIME_MISMATCH'); }
  }
  // This pinned Mach-O embeds an absolute LC_RPATH. A copied binary must not attest
  // adjacent libraries while dyld actually loads the original directory's libraries.
  const header = await readFile(serverBinary, { signal: options.signal });
  const directory = await realpath(dirname(serverBinary)); options.signal?.throwIfAborted();
  if (header.length !== 33472 || header.readUInt32LE(0) !== 0xfeedfacf) throw new ManagedHarrierError('RUNTIME_MISMATCH');
  let offset = 32; const rpaths: string[] = [];
  for (let index = 0; index < header.readUInt32LE(16); index++) {
    if (offset + 8 > header.length) throw new ManagedHarrierError('RUNTIME_MISMATCH');
    const command = header.readUInt32LE(offset), bytes = header.readUInt32LE(offset + 4);
    if (bytes < 8 || offset + bytes > header.length) throw new ManagedHarrierError('RUNTIME_MISMATCH');
    if (command === 0x8000001c) {
      if (bytes < 12) throw new ManagedHarrierError('RUNTIME_MISMATCH');
      const start = offset + header.readUInt32LE(offset + 8), end = header.indexOf(0, start);
      if (start < offset + 12 || start >= offset + bytes || end < start || end >= offset + bytes) throw new ManagedHarrierError('RUNTIME_MISMATCH');
      rpaths.push(header.toString('utf8', start, end));
    }
    offset += bytes;
  }
  if (rpaths.length !== 1 || !absolute(rpaths[0]) || await realpath(rpaths[0]) !== directory) throw new ManagedHarrierError('RUNTIME_MISMATCH');
  await access(serverBinary, constants.X_OK); options.signal?.throwIfAborted();
}
async function verifyFiles(config: Readonly<ManagedHarrierConfig>, signal: AbortSignal): Promise<void> {
  await verifyHarrierRuntime(config.serverBinary, { signal }); signal.throwIfAborted();
  try { await verifyHarrierArtifact(config.modelArtifact, { signal }); signal.throwIfAborted(); }
  catch { signal.throwIfAborted(); throw new ManagedHarrierError('ARTIFACT_MISMATCH'); }
}
async function allocatePort(signal: AbortSignal): Promise<number> {
  signal.throwIfAborted(); const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    signal.throwIfAborted(); const address = server.address();
    if (!address || typeof address === 'string') throw new ManagedHarrierError('OPEN_FAILED');
    return address.port;
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ManagedHarrierError('IDENTITY_MISMATCH');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 65536) throw new ManagedHarrierError('IDENTITY_MISMATCH'); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ManagedHarrierError('IDENTITY_MISMATCH'); }
}

/** Only explicit open starts an owned process; constructor/status never touch filesystem/network. */
export class ManagedHarrier {
  readonly #config: Readonly<ManagedHarrierConfig>;
  #state: ManagedHarrierState = 'idle'; #lastErrorCode?: ManagedHarrierError['code'];
  #verified = false; #probe = false; #generation = 0;
  #child?: ChildProcess; #childDone?: Promise<void>; #exited = false; #spawnError = false;
  #directory?: string; #keyFile?: string; #key?: string;
  #opening?: Promise<ManagedHarrierConnection>; #closing?: Promise<void>; #disposal?: Promise<void>;
  readonly #stop = new AbortController();
  constructor(config: ManagedHarrierConfig, private readonly options: ManagedHarrierOptions = {}) {
    if (!record(config) || Object.keys(config).sort().join(',') !== 'modelArtifact,serverBinary' || !absolute(config.serverBinary) || !absolute(config.modelArtifact)
      || [options.verifyFiles, options.spawn, options.allocatePort, options.fetch].some(value => value !== undefined && typeof value !== 'function')) throw new ManagedHarrierError('INVALID_CONFIG');
    this.#config = Object.freeze({ serverBinary: config.serverBinary, modelArtifact: config.modelArtifact });
  }
  status(): Readonly<ManagedHarrierStatus> {
    return Object.freeze({ state: this.#state, verified: this.#verified && this.#state === 'ready', profileId: HARRIER_PROFILE.id,
      runtimeFingerprint: HARRIER_RUNTIME_FINGERPRINT, childGeneration: this.#generation, readinessProbe: this.#probe ? 'passed' : 'not-run', embeddingVerified: false,
      ...(this.#lastErrorCode ? { lastErrorCode: this.#lastErrorCode } : {}) });
  }
  async #probeServer(base: string, signal: AbortSignal): Promise<void> {
    const fetcher = this.options.fetch ?? globalThis.fetch;
    while (true) {
      signal.throwIfAborted(); if (this.#exited || this.#spawnError) throw new ManagedHarrierError('DISCONNECTED');
      let healthy = false;
      try { const response = await fetcher(`${base}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), redirect: 'manual' }); healthy = response.status === 200; await response.body?.cancel(); }
      catch { signal.throwIfAborted(); }
      if (healthy) break;
      await delay(100, undefined, { signal });
    }
    // A random secret must be required. A public models endpoint on a collided port is not our server.
    const unauthenticated = await fetcher(`${base}/v1/models`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), redirect: 'manual' });
    await unauthenticated.body?.cancel();
    if (unauthenticated.status !== 401) throw new ManagedHarrierError('IDENTITY_MISMATCH');
    const response = await fetcher(`${base}/v1/models`, { headers: { Authorization: `Bearer ${this.#key}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), redirect: 'manual' });
    if (response.status !== 200) { await response.body?.cancel(); throw new ManagedHarrierError('IDENTITY_MISMATCH'); }
    const body = await boundedJson(response);
    if (!record(body) || !Array.isArray(body.data) || body.data.length !== 1 || !record(body.data[0]) || body.data[0].id !== HARRIER_PROFILE.model) throw new ManagedHarrierError('IDENTITY_MISMATCH');
    signal.throwIfAborted(); if (this.#exited || this.#spawnError) throw new ManagedHarrierError('DISCONNECTED');
  }
  async open(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ManagedHarrierConnection> {
    if (this.#state !== 'idle') throw new ManagedHarrierError('NOT_READY');
    if (options.signal?.aborted) throw new ManagedHarrierError('CANCELLED');
    const timeoutMs = options.timeoutMs ?? 60000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new ManagedHarrierError('INVALID_CONFIG');
    this.#state = 'opening'; const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const signal = AbortSignal.any([this.#stop.signal, deadline.signal, ...options.signal ? [options.signal] : []]);
    const work = (async () => {
      try {
        await (this.options.verifyFiles ?? verifyFiles)(this.#config, signal); signal.throwIfAborted();
        const binary = await realpath(this.#config.serverBinary); signal.throwIfAborted();
        const port = await (this.options.allocatePort ?? allocatePort)(signal); signal.throwIfAborted();
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new ManagedHarrierError('OPEN_FAILED');
        this.#directory = await mkdtemp(join(tmpdir(), 'shiyu-harrier-')); signal.throwIfAborted();
        this.#keyFile = join(this.#directory, 'api-key'); this.#key = randomBytes(32).toString('hex');
        await writeFile(this.#keyFile, this.#key + '\n', { flag: 'wx', mode: 0o600 }); signal.throwIfAborted();
        const args = ['-m', this.#config.modelArtifact, '--embeddings', '--pooling', 'last', '--alias', HARRIER_PROFILE.model,
          '-ngl', '999', '-c', '4096', '-b', '512', '-ub', '512', '-t', '4', '--host', '127.0.0.1', '--port', String(port), '-fa', 'off', '--api-key-file', this.#keyFile];
        // No inherited provider, proxy, DYLD, shell, HOME, model configuration or environment credentials.
        const child = (this.options.spawn ?? spawn)(binary, args, { cwd: this.#directory, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: 'ignore', shell: false, detached: false });
        this.#child = child; this.#generation++;
        this.#childDone = new Promise<void>(resolve => {
          child.once('error', () => { this.#spawnError = true; });
          child.once('close', () => { this.#exited = true; resolve(); if (this.#state === 'ready') { this.#state = 'failed'; this.#lastErrorCode = 'DISCONNECTED'; void this.#dispose().catch(() => { this.#lastErrorCode = 'CLOSE_UNCONFIRMED'; }); } });
        });
        signal.throwIfAborted(); const base = `http://127.0.0.1:${port}`;
        await this.#probeServer(base, signal); signal.throwIfAborted();
        this.#verified = true; this.#probe = true; this.#state = 'ready';
        return Object.freeze({ endpoint: `${base}/v1/embeddings`, keyFile: this.#keyFile });
      } catch (error) {
        const failure = deadline.signal.aborted && !this.#stop.signal.aborted && !options.signal?.aborted ? new ManagedHarrierError('TIMEOUT')
          : signal.aborted ? new ManagedHarrierError('CANCELLED') : error instanceof ManagedHarrierError ? error : new ManagedHarrierError('OPEN_FAILED');
        this.#lastErrorCode = failure.code;
        try { await this.#dispose(); } catch { this.#lastErrorCode = 'CLOSE_UNCONFIRMED'; this.#state = 'failed'; throw new ManagedHarrierError('CLOSE_UNCONFIRMED'); }
        if (this.#state !== 'closing' && this.#state !== 'closed') this.#state = 'failed';
        throw failure;
      } finally { clearTimeout(timer); }
    })();
    this.#opening = work; return work;
  }
  #dispose(): Promise<void> {
    return this.#disposal ??= (async () => {
      try {
        if (this.#child && !this.#exited && this.#child.pid) {
          this.#child.kill('SIGTERM');
          await Promise.race([this.#childDone, delay(500, undefined, { ref: false })]);
          if (!this.#exited) { this.#child.kill('SIGKILL'); await Promise.race([this.#childDone, delay(5000, undefined, { ref: false })]); }
          if (!this.#exited) throw new ManagedHarrierError('CLOSE_UNCONFIRMED');
        } else if (this.#childDone && !this.#exited) { await Promise.race([this.#childDone, delay(500, undefined, { ref: false })]); if (!this.#exited) throw new ManagedHarrierError('CLOSE_UNCONFIRMED'); }
      } finally {
        this.#key = undefined;
        if (this.#directory) await rm(this.#directory, { recursive: true, force: true });
        this.#keyFile = undefined;
      }
    })();
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#state = 'closing'; this.#stop.abort();
    this.#closing = (async () => {
      try { await this.#opening?.catch(() => undefined); await this.#dispose(); this.#state = 'closed'; }
      catch { this.#state = 'failed'; this.#lastErrorCode = 'CLOSE_UNCONFIRMED'; throw new ManagedHarrierError('CLOSE_UNCONFIRMED'); }
    })(); return this.#closing;
  }
}
