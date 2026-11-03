import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export interface ArtifactObservation {
  artifactRef: string;
  sha256: string;
  byteLength: number;
  observedAt: string;
}
export interface ArtifactWrite {
  taskId: string;
  content: string;
  expectedSha256: string;
  signal?: AbortSignal;
  /** Trusted execution gate after temporary-file fsync, before any new publication.
   * Not called for an already-present same-content artifact. No DB transaction
   * may remain open across this asynchronous filesystem operation. */
  beforePublish?: () => Promise<void> | void;
}
export interface ArtifactInspect { taskId: string; expectedSha256?: string }
export class ArtifactError extends Error {
  constructor(readonly code: string, message: string, readonly outcome: 'not_written' | 'unknown' = 'not_written', options?: ErrorOptions) {
    super(message, options); this.name = 'ArtifactError';
  }
}
export class ArtifactUnknownError extends ArtifactError {
  constructor(readonly artifactRef: string, message: string, cause?: unknown) {
    super('RESULT_UNKNOWN', message, 'unknown', cause === undefined ? undefined : { cause }); this.name = 'ArtifactUnknownError';
  }
}
interface DirectoryAnchor { path: string; handle: FileHandle; identity: BigIntStats }
interface OwnedTemporary { path: string; identity: BigIntStats }
interface ObservedArtifact { observation: ArtifactObservation; aliases: OwnedTemporary[] }
const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const bytesLimit = 1024;
const ref = (taskId: string) => `artifact:${taskId}`;
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const isCode = (error: unknown, code: string) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function taskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(value)) throw new ArtifactError('INVALID_INPUT', 'Task ID must be an opaque identifier without paths or dots.');
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new ArtifactError('INVALID_INPUT', 'Expected SHA-256 must be a lowercase 64-character digest.');
  return value;
}
function checkInput(input: unknown, allowed: string[]): asserts input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new ArtifactError('INVALID_INPUT', 'Invalid artifact command.');
}
function ownerAndMode(stats: BigIntStats, mode: bigint): void {
  if (typeof process.getuid !== 'function' || stats.uid !== BigInt(process.getuid()) || (stats.mode & 0o777n) !== mode) throw new ArtifactError('FORBIDDEN_PATH', 'Artifact storage requires an owned private directory and private files.');
}
function cancelled(signal: AbortSignal, artifactRef: string, observedOrPublished = false): void {
  if (!signal.aborted) return;
  if (observedOrPublished) throw new ArtifactUnknownError(artifactRef, 'Cancellation arrived after the artifact may have taken effect.');
  throw new ArtifactError('CANCELLED', 'Artifact operation cancelled before publication.');
}
async function durable(handle: FileHandle, artifactRef: string): Promise<void> {
  try { await handle.sync(); }
  catch (error) { throw new ArtifactUnknownError(artifactRef, 'Artifact durability could not be confirmed.', error); }
}

/**
 * Filesystem adapter for one bounded local-note capability, outside DB transactions.
 * root is the runtime's private workspaces directory; no caller-selected path is
 * accepted. Held directory identities, O_NOFOLLOW and before/after checks narrow
 * races, but do not claim OS isolation against a malicious process of this UID.
 */
export class LocalArtifactStore {
  readonly root: string;
  private readonly active = new Set<Promise<unknown>>();
  private readonly shutdown = new AbortController();
  private closing?: Promise<void>;
  private stopped = false;
  private constructor(private readonly rootAnchor: DirectoryAnchor) { this.root = rootAnchor.path; }

  static async open(rootAbsolute: string): Promise<LocalArtifactStore> {
    if (typeof rootAbsolute !== 'string' || !path.isAbsolute(rootAbsolute) || rootAbsolute.includes('\0')) throw new ArtifactError('INVALID_INPUT', 'Artifact root must be an absolute local directory.');
    const requested = path.resolve(rootAbsolute); let created = false;
    try { await mkdir(requested, { mode: 0o700 }); created = true; }
    catch (error) { if (!isCode(error, 'EEXIST')) throw new ArtifactError('IO_FAILURE', 'Artifact root could not be created.', 'not_written', { cause: error }); }
    const stat = await lstat(requested, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ArtifactError('FORBIDDEN_PATH', 'Artifact root must be a real directory.');
    ownerAndMode(stat, 0o700n);
    const canonical = await realpath(requested);
    const handle = await open(canonical, flags);
    try {
      const identity = await handle.stat({ bigint: true });
      if (!same(identity, stat)) throw new ArtifactError('FORBIDDEN_PATH', 'Artifact root changed while opening.');
      const store = new LocalArtifactStore({ path: canonical, handle, identity });
      await store.verify(store.rootAnchor);
      if (created) {
        const parent = await open(path.dirname(canonical), flags);
        try { await durable(parent, 'artifact:root'); } finally { await parent.close(); }
      }
      return store;
    } catch (error) { await handle.close(); throw error; }
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new ArtifactError('CLOSED', 'Artifact store is closing.'));
    const pending = Promise.resolve().then(operation);
    this.active.add(pending);
    void pending.finally(() => this.active.delete(pending)).catch(() => undefined);
    return pending;
  }
  private async verify(anchor: DirectoryAnchor): Promise<void> {
    const [atPath, held, canonical] = await Promise.all([lstat(anchor.path, { bigint: true }), anchor.handle.stat({ bigint: true }), realpath(anchor.path)]);
    if (atPath.isSymbolicLink() || !atPath.isDirectory() || !same(atPath, anchor.identity) || !same(held, anchor.identity) || canonical !== anchor.path) throw new ArtifactError('FORBIDDEN_PATH', 'Artifact directory identity changed.');
    ownerAndMode(atPath, 0o700n); ownerAndMode(held, 0o700n);
  }
  private async verifyAll(anchors: DirectoryAnchor[]): Promise<void> { for (const anchor of [this.rootAnchor, ...anchors]) await this.verify(anchor); }
  private async child(parent: DirectoryAnchor, name: string, create: boolean, artifactRef: string): Promise<DirectoryAnchor | undefined> {
    await this.verify(parent);
    const target = path.join(parent.path, name); let created = false;
    if (create) {
      try { await mkdir(target, { mode: 0o700 }); created = true; }
      catch (error) { if (!isCode(error, 'EEXIST')) throw error; }
    }
    let stat: BigIntStats;
    try { stat = await lstat(target, { bigint: true }); }
    catch (error) { if (!create && isCode(error, 'ENOENT')) return undefined; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ArtifactError('FORBIDDEN_PATH', 'Task and artifact folders must be real directories.');
    ownerAndMode(stat, 0o700n);
    const handle = await open(target, flags);
    try {
      const identity = await handle.stat({ bigint: true });
      if (!same(identity, stat)) throw new ArtifactError('FORBIDDEN_PATH', 'Artifact folder changed while opening.');
      const anchor = { path: target, handle, identity };
      await this.verify(parent); await this.verify(anchor);
      if (created) await durable(parent.handle, artifactRef);
      return anchor;
    } catch (error) { await handle.close(); throw error; }
  }
  private async directories(id: string, create: boolean): Promise<DirectoryAnchor[] | undefined> {
    const task = await this.child(this.rootAnchor, id, create, ref(id));
    if (!task) return undefined;
    try {
      const artifacts = await this.child(task, 'artifacts', create, ref(id));
      if (!artifacts) { await task.handle.close(); return undefined; }
      return [task, artifacts];
    } catch (error) { await task.handle.close(); throw error; }
  }
  private async ownAliases(directory: DirectoryAnchor, target: BigIntStats): Promise<OwnedTemporary[]> {
    if (target.nlink < 1n || target.nlink > 9n) throw new ArtifactError('FORBIDDEN_PATH', 'Artifact link count is outside the controlled recovery bound.');
    if (target.nlink === 1n) return [];
    const aliases: OwnedTemporary[] = []; let entries = 0;
    for await (const entry of await opendir(directory.path)) {
      if (++entries > 64) throw new ArtifactError('FORBIDDEN_PATH', 'Artifact directory exceeds the bounded recovery scan.');
      if (!/^\.note-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u.test(entry.name)) continue;
      const candidate = path.join(directory.path, entry.name); const identity = await lstat(candidate, { bigint: true });
      if (identity.isSymbolicLink() || !identity.isFile() || !same(identity, target)) continue;
      ownerAndMode(identity, 0o600n); aliases.push({ path: candidate, identity });
    }
    // Account for every alias. A hard link outside this private directory (or
    // under an unrelated name) still fails closed. These recognized names are
    // residual publication links, not permission to delete arbitrary files.
    if (BigInt(aliases.length + 1) !== target.nlink) throw new ArtifactError('FORBIDDEN_PATH', 'Artifact has an unaccounted hard-link alias.');
    return aliases;
  }
  private async observe(id: string, anchors: DirectoryAnchor[], expected?: string, sync = false): Promise<ObservedArtifact | undefined> {
    await this.verifyAll(anchors);
    const directory = anchors.at(-1)!;
    const target = path.join(directory.path, 'note.txt');
    let before: BigIntStats;
    try { before = await lstat(target, { bigint: true }); }
    catch (error) { if (isCode(error, 'ENOENT')) return undefined; throw error; }
    if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(bytesLimit)) throw new ArtifactError('FORBIDDEN_PATH', 'Artifact must be a bounded regular file.');
    ownerAndMode(before, 0o600n);
    const aliases = await this.ownAliases(directory, before);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!same(opened, before) || !opened.isFile() || opened.nlink !== before.nlink || opened.size > BigInt(bytesLimit)) throw new ArtifactError('FORBIDDEN_PATH', 'Artifact changed while opening.');
      ownerAndMode(opened, 0o600n);
      const bytes = Buffer.alloc(bytesLimit + 1); let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const atPath = await lstat(target, { bigint: true });
      if (length > bytesLimit || BigInt(length) !== after.size || !same(after, opened) || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || after.nlink !== opened.nlink || !same(atPath, after) || atPath.isSymbolicLink()) throw new ArtifactError('FORBIDDEN_PATH', 'Artifact changed during observation.');
      for (const alias of aliases) {
        const current = await lstat(alias.path, { bigint: true });
        if (current.isSymbolicLink() || !same(current, after)) throw new ArtifactError('FORBIDDEN_PATH', 'Artifact recovery alias changed during observation.');
      }
      await this.verifyAll(anchors);
      const digest = sha256(bytes.subarray(0, length));
      if (expected !== undefined && digest !== expected) throw new ArtifactError('CONTENT_CONFLICT', 'Existing artifact content differs from the expected digest.');
      if (sync) await durable(handle, ref(id));
      return { observation: { artifactRef: ref(id), sha256: digest, byteLength: length, observedAt: new Date().toISOString() }, aliases };
    } finally { await handle.close(); }
  }
  private async cleanTemporary(temp: OwnedTemporary, anchors: DirectoryAnchor[], artifactRef: string): Promise<void> {
    await this.verifyAll(anchors);
    let stat: BigIntStats;
    try { stat = await lstat(temp.path, { bigint: true }); }
    catch (error) { if (isCode(error, 'ENOENT')) { await durable(anchors.at(-1)!.handle, artifactRef); return; } throw error; }
    if (stat.isSymbolicLink() || !stat.isFile() || !same(stat, temp.identity)) throw new ArtifactError('FORBIDDEN_PATH', 'Temporary artifact identity changed; refusing to remove it.');
    await unlink(temp.path);
    await durable(anchors.at(-1)!.handle, artifactRef);
  }
  /** Read-only preflight of the already-held private root; creates no paths. */
  inspectRoot(): Promise<void> {
    return this.run(async () => {
      cancelled(this.shutdown.signal, 'artifact:root');
      await this.verify(this.rootAnchor);
      cancelled(this.shutdown.signal, 'artifact:root');
    });
  }
  /** Creates only the verified task directory, suitable as a native DSH cwd. */
  prepareWorkspace(id: string): Promise<string> {
    return this.run(async () => {
      id = taskId(id); cancelled(this.shutdown.signal, ref(id));
      const directory = await this.child(this.rootAnchor, id, true, ref(id));
      try { await this.verifyAll([directory!]); cancelled(this.shutdown.signal, ref(id)); return directory!.path; }
      finally { await directory?.handle.close(); }
    });
  }
  inspect(input: ArtifactInspect): Promise<ArtifactObservation | undefined> {
    return this.run(async () => {
      checkInput(input, ['taskId', 'expectedSha256']); const id = taskId(input.taskId);
      const expected = input.expectedSha256 === undefined ? undefined : hash(input.expectedSha256);
      try {
        const anchors = await this.directories(id, false); if (!anchors) return undefined;
        try { return (await this.observe(id, anchors, expected))?.observation; }
        finally { for (const anchor of anchors.reverse()) await anchor.handle.close(); }
      } catch (error) {
        if (error instanceof ArtifactUnknownError) throw error;
        throw new ArtifactUnknownError(ref(id), 'Artifact observation could not be confirmed.', error);
      }
    });
  }
  write(input: ArtifactWrite): Promise<ArtifactObservation> {
    return this.run(async () => {
      checkInput(input, ['taskId', 'content', 'expectedSha256', 'signal', 'beforePublish']); const id = taskId(input.taskId); const expected = hash(input.expectedSha256);
      if (typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > bytesLimit) throw new ArtifactError('INVALID_INPUT', 'Artifact content must be at most 1024 UTF-8 bytes.');
      const content = Buffer.from(input.content, 'utf8');
      if (sha256(content) !== expected) throw new ArtifactError('INVALID_INPUT', 'Expected SHA-256 does not match the supplied content.');
      if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw new ArtifactError('INVALID_INPUT', 'Invalid cancellation signal.');
      const beforePublish = input.beforePublish;
      if (beforePublish !== undefined && typeof beforePublish !== 'function') throw new ArtifactError('INVALID_INPUT', 'Invalid publication gate.');
      const signal = input.signal ? AbortSignal.any([input.signal, this.shutdown.signal]) : this.shutdown.signal;
      const artifactRef = ref(id); cancelled(signal, artifactRef);
      let anchors: DirectoryAnchor[] = []; let temp: OwnedTemporary | undefined; let published = false; let observed = false;
      let result: ArtifactObservation | undefined; let failure: unknown;
      try {
        anchors = (await this.directories(id, true))!;
        cancelled(signal, artifactRef);
        const existing = await this.observe(id, anchors, expected, true);
        if (existing) {
          observed = true;
          for (const alias of existing.aliases) await this.cleanTemporary(alias, anchors, artifactRef);
          await durable(anchors.at(-1)!.handle, artifactRef); cancelled(signal, artifactRef, true);
          result = (await this.observe(id, anchors, expected))?.observation;
          if (!result) throw new ArtifactUnknownError(artifactRef, 'Artifact disappeared after idempotent verification.');
        } else {
          const temporaryPath = path.join(anchors.at(-1)!.path, `.note-${randomUUID()}.tmp`);
          const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try {
            temp = { path: temporaryPath, identity: await handle.stat({ bigint: true }) };
            ownerAndMode(temp.identity, 0o600n);
            await handle.writeFile(content); await durable(handle, artifactRef);
          } finally { await handle.close(); }
          await this.verifyAll(anchors); cancelled(signal, artifactRef);
          if (beforePublish) {
            try { await beforePublish(); }
            catch (error) { throw new ArtifactError('PUBLICATION_DENIED', 'Artifact publication gate rejected the operation.', 'not_written', { cause: error }); }
          }
          cancelled(signal, artifactRef);
          // The gate can await trusted control-store facts. Recheck filesystem
          // identities and any target created meanwhile before attempting link.
          const appeared = await this.observe(id, anchors, expected, true);
          cancelled(signal, artifactRef, Boolean(appeared));
          if (appeared) observed = true;
          else {
            try {
              await link(temp.path, path.join(anchors.at(-1)!.path, 'note.txt')); published = true;
            } catch (error) {
              if (!isCode(error, 'EEXIST')) throw new ArtifactUnknownError(artifactRef, 'Artifact publication result could not be confirmed.', error);
            }
          }
          await this.verifyAll(anchors);
          await durable(anchors.at(-1)!.handle, artifactRef);
          await this.cleanTemporary(temp, anchors, artifactRef); temp = undefined;
          // Even EEXIST may be the original attempt's already-visible effect.
          // Cancellation here cannot be reported as having removed that effect.
          cancelled(signal, artifactRef, true);
          result = (await this.observe(id, anchors, expected, !published))?.observation;
          if (!result) throw new ArtifactUnknownError(artifactRef, 'Artifact disappeared after publication.');
          observed = true; cancelled(signal, artifactRef, true);
        }
      } catch (error) { failure = error; }
      finally {
        if (temp) {
          try { await this.cleanTemporary(temp, anchors, artifactRef); }
          catch (error) { failure = new ArtifactUnknownError(artifactRef, 'Artifact temporary-file cleanup could not be confirmed.', new AggregateError([failure, error].filter(value => value !== undefined))); }
        }
        for (const anchor of anchors.reverse()) {
          try { await anchor.handle.close(); }
          catch (error) { failure = new ArtifactUnknownError(artifactRef, 'Artifact directory cleanup could not be confirmed.', new AggregateError([failure, error].filter(value => value !== undefined))); }
        }
      }
      if (failure) {
        if (failure instanceof ArtifactUnknownError) throw failure;
        if (published || observed) throw new ArtifactUnknownError(artifactRef, 'Artifact may have taken effect; inspect before deciding its outcome.', failure);
        if (failure instanceof ArtifactError) throw failure;
        throw new ArtifactError('IO_FAILURE', 'Artifact write failed before publication.', 'not_written', { cause: failure });
      }
      return result!;
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true; this.shutdown.abort();
    this.closing = (async () => { await Promise.allSettled([...this.active]); await this.rootAnchor.handle.close(); })();
    return this.closing;
  }
}

export * from './shared-workspace.js';
