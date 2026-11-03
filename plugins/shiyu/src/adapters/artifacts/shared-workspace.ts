/**
 * Per-task workspace with a **writable** shared-workspace hard-link mirror.
 *
 * Layout (under the runtime's private workspaces root):
 *   {workspacesRoot}/<taskId>/task           task-private working directory
 *   {workspacesRoot}/<taskId>/shared         hard-link mirror of the shared root
 *
 * Writable semantics (explicitly disclosed, not hidden):
 *  - `shared/` mirrors only *files*, by hard link; directories are recreated.
 *  - The task and the canonical shared file share one inode. An in-place write
 *    through the task mirror therefore immediately changes the canonical shared
 *    file. `publishTaskWorkspace` records that change in the shared index when
 *    it is declared in `expectedChanges`; an undeclared modification is an
 *    unexpected conflict -> the task is reported `unknown`/`blocked` and the
 *    shared index is not guessed forward.
 *  - New files created under `shared/` are published into the canonical shared
 *    root by a controlled hard-link publish and re-linked; they are never
 *    silently discarded. On conflicts the task mirror is retained for explicit
 *    owner reconciliation (`discardTaskWorkspace` removes only task-side links).
 *  - Deleting a shared file requires an explicit owner decision. The default
 *    (`task-link-removed`) removes only the task-side link; the canonical file
 *    stays. `ownerDecision:{kind:'delete-shared'}` unlinks the canonical file.
 *  - Single-writer assumption: one shared workspace is protected by an exclusive
 *    lock file for the duration of prepare -> publish/rollback/release.
 *  - Same-file-system requirement: files are linked, never copied across
 *    devices; cross-device, symlinked or externally hard-linked files fail
 *    closed before any link is created.
 *  - Artifact publication is unchanged: this module never touches
 *    `<taskId>/artifacts`; artifacts continue to be published only from the
 *    task area by LocalArtifactStore.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { copyFile, lstat, mkdir, open, opendir, readFile, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

export const SHARED_WORKSPACE_SCHEMA_VERSION = 1;

export type SharedWorkspaceErrorCode =
  | 'INVALID_INPUT'
  | 'FORBIDDEN_PATH'
  | 'SHARED_ROOT_NOT_ALLOWED'
  | 'SHARED_ROOT_OVERLAP'
  | 'CROSS_DEVICE'
  | 'SYMLINK_FORBIDDEN'
  | 'EXTERNAL_HARDLINK'
  | 'TASK_WORKSPACE_EXISTS'
  | 'WORKSPACE_LOCKED'
  | 'WORKSPACE_LOCK_LOST'
  | 'MANIFEST_MISSING'
  | 'MANIFEST_TAMPERED'
  | 'ROLLBACK_UNAVAILABLE'
  | 'IO_FAILURE';

export class SharedWorkspaceError extends Error {
  constructor(readonly code: SharedWorkspaceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SharedWorkspaceError';
  }
}

function fail(code: SharedWorkspaceErrorCode, message: string, options?: ErrorOptions): never {
  throw new SharedWorkspaceError(code, message, options);
}

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const nowIso = (now?: () => Date): string => (now?.() ?? new Date()).toISOString();
const SAFE_TASK_ID = /^[A-Za-z0-9_-]{1,100}$/u;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const canonicalJson = (value: unknown): string => {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (isPlainObject(item)) {
      return Object.fromEntries(Object.entries(item)
        .filter(([, itemValue]) => itemValue !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, itemValue]) => [key, sort(itemValue)]));
    }
    return item;
  };
  return JSON.stringify(sort(value));
};

const isCode = (error: unknown, code: string): boolean => Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === code);

const assertSafeRelative = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 400 || value.includes('\0') || value.includes('\\')) {
    fail('INVALID_INPUT', `${label} must be a bounded POSIX relative path`);
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) fail('INVALID_INPUT', `${label} must be relative`);
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) fail('INVALID_INPUT', `${label} contains an unsafe segment`);
  return value;
};

const assertTaskId = (value: unknown): string => {
  if (typeof value !== 'string' || !SAFE_TASK_ID.test(value)) fail('INVALID_INPUT', 'taskId must be a bounded identifier without paths');
  return value;
};

const within = (root: string, target: string): boolean => {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
};

const sha256File = async (filename: string, maxBytes: number): Promise<{ sha256: string; bytes: number }> => {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || !info.isFile()) fail('FORBIDDEN_PATH', 'Expected a regular file');
  if (info.size > maxBytes) fail('INVALID_INPUT', `File exceeds the bounded workspace file limit (${maxBytes} bytes)`);
  const bytes = await readFile(filename);
  return { sha256: sha256(bytes), bytes: bytes.byteLength };
};

const syncDir = async (directory: string): Promise<void> => {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
};

const writeJsonExclusive = async (filename: string, value: unknown): Promise<void> => {
  const directory = path.dirname(filename);
  const temporary = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, filename);
  await syncDir(directory);
};

const writeJsonAtomic = async (filename: string, value: unknown): Promise<void> => {
  const directory = path.dirname(filename);
  const temporary = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, filename);
  await syncDir(directory);
};

const canonicalDirectory = async (directory: string, label: string): Promise<string> => {
  if (typeof directory !== 'string' || directory.length < 1 || directory.includes('\0')) fail('INVALID_INPUT', `${label} must be a bounded path`);
  const requested = path.resolve(directory);
  let stat: Stats;
  try { stat = await lstat(requested); }
  catch (error) { return fail('INVALID_INPUT', `${label} does not exist`, { cause: error }); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('FORBIDDEN_PATH', `${label} must be a real directory, never a symbolic link`);
  // Resolve to the canonical path (callers may pass /tmp on macOS) while still
  // rejecting a root that is itself a symbolic link.
  const canonical = await realpath(requested);
  const canonicalStat = await lstat(canonical);
  if (canonicalStat.isSymbolicLink() || !canonicalStat.isDirectory()) fail('FORBIDDEN_PATH', `${label} must resolve to a real directory`);
  return canonical;
};

const ensurePrivateDir = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) fail('FORBIDDEN_PATH', 'Workspace path must be a real directory');
  if ((info.mode & 0o777) !== 0o700) fail('FORBIDDEN_PATH', 'Workspace directory must be private (0700)');
};

export interface SharedWorkspaceManagerOptions {
  /** Runtime private workspaces directory, typically `{dataDir}/workspaces`. */
  workspacesRoot: string;
  /** Canonical shared workspace root. Omitted keeps legacy task-only behavior (no-op). */
  sharedRoot?: string;
  /** Explicit allowlist of shared roots. Defaults to the configured shared root itself. */
  allowedSharedRoots?: readonly string[];
  /** Optional pre-task snapshot (APFS clone when supported, copy otherwise) for rollback. */
  snapshot?: boolean;
  maxFiles?: number;
  maxDepth?: number;
  maxFileBytes?: number;
  /** Exclusive lock lease; an expired stale lock may be taken over. */
  lockLeaseMs?: number;
  now?: () => Date;
  /** Test/composition seam for device identity (defaults to real stat dev). */
  deviceOf?: (absolutePath: string) => Promise<number>;
}

export interface TaskWorkspaceManifestEntry {
  path: string;
  dev: number;
  ino: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface TaskWorkspaceSnapshotEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface TaskWorkspaceManifest {
  schemaVersion: number;
  taskId: string;
  workspacesRootHash: string;
  sharedRootHash: string | null;
  createdAt: string;
  lockToken: string | null;
  entries: TaskWorkspaceManifestEntry[];
  snapshot: { enabled: boolean; entries: TaskWorkspaceSnapshotEntry[] } | null;
  manifestSha256: string;
}

export type WorkspaceChangeKind = 'in-place-updated' | 'published-new' | 'task-link-removed' | 'shared-deleted' | 'already-published';
export type WorkspaceConflictKind = 'unexpected-modification' | 'external-change' | 'canonical-missing' | 'canonical-replaced' | 'canonical-exists' | 'inconsistent-mirror' | 'symlink' | 'manifest-mismatch';
export type WorkspacePublishStatus = 'synced' | 'no-changes' | 'unknown' | 'blocked' | 'no-shared';

export interface WorkspaceChange {
  path: string;
  kind: WorkspaceChangeKind;
  preSha256: string | null;
  postSha256: string | null;
}

export interface WorkspaceConflict {
  path: string;
  kind: WorkspaceConflictKind;
  detail: string;
}

export interface WorkspacePublishReport {
  schemaVersion: number;
  taskId: string;
  status: WorkspacePublishStatus;
  code: string | null;
  sharedRootHash: string | null;
  manifestSha256: string | null;
  lockReleased: boolean;
  mirrorRetained: boolean;
  changes: WorkspaceChange[];
  conflicts: WorkspaceConflict[];
  index: { path: string; sha256: string } | null;
  rollbackAvailable: boolean;
  /** Present only when an explicit owner deletion decision was applied. */
  ownerDecision: { kind: 'delete-shared'; decisionId: string; paths: string[] } | null;
  disclosure: {
    inPlaceWritesPropagateToSharedSource: boolean;
    mirrorUsesFileHardLinks: boolean;
    deletionDefault: 'task-link-only';
    deleteSharedRequiresOwnerDecision: true;
    artifactsUnaffected: true;
  };
}

export interface WorkspaceRollbackReport {
  schemaVersion: number;
  taskId: string;
  status: 'rolled-back' | 'blocked' | 'no-snapshot';
  code: string | null;
  restored: { path: string; sha256: string }[];
  conflicts: WorkspaceConflict[];
  lockReleased: boolean;
}

export interface TaskWorkspaceSession {
  schemaVersion: number;
  taskId: string;
  taskDir: string;
  sharedDir: string | null;
  sharedRoot: string | null;
  sharedRootHash: string | null;
  lockToken: string | null;
  manifestSha256: string | null;
  /** True when in-place writes through the mirror change the canonical shared file. */
  inPlaceWritesPropagate: boolean;
  release(): Promise<{ mirrorRemoved: boolean; lockReleased: boolean }>;
}

interface LockRecord {
  schemaVersion: number;
  token: string;
  taskId: string;
  pid: number;
  acquiredAt: string;
  leaseExpiresAt: string;
}

const LOCK_NAME = 'lock.json';
const INDEX_NAME = 'index.json';
const MANIFEST_NAME = '.workspace-manifest.json';
const REPORT_NAME = '.workspace-report.json';
const SNAPSHOT_NAME = '.workspace-snapshot';
const STATE_DIR = '.shared-workspaces';

const stateDirectory = (workspacesRoot: string): string => path.join(workspacesRoot, STATE_DIR);
const lockFile = (workspacesRoot: string): string => path.join(stateDirectory(workspacesRoot), LOCK_NAME);
const indexPath = (workspacesRoot: string): string => path.join(stateDirectory(workspacesRoot), INDEX_NAME);

const taskDirectory = (workspacesRoot: string, taskId: string): string => path.join(workspacesRoot, taskId);
const taskSubdirectory = (workspacesRoot: string, taskId: string, name: 'task' | 'shared'): string => path.join(taskDirectory(workspacesRoot, taskId), name);
const manifestFile = (workspacesRoot: string, taskId: string): string => path.join(taskDirectory(workspacesRoot, taskId), MANIFEST_NAME);
const reportFile = (workspacesRoot: string, taskId: string): string => path.join(taskDirectory(workspacesRoot, taskId), REPORT_NAME);

const manifestDigest = (manifest: Omit<TaskWorkspaceManifest, 'manifestSha256'>): string => sha256(canonicalJson(manifest));

const acquireLock = async (
  workspacesRoot: string,
  taskId: string,
  options: { now: () => Date; leaseMs: number },
): Promise<LockRecord> => {
  await ensurePrivateDir(stateDirectory(workspacesRoot));
  const filename = lockFile(workspacesRoot);
  const leaseMs = Math.max(1000, Math.min(options.leaseMs, 24 * 60 * 60 * 1000));
  const acquireOnce = async (): Promise<LockRecord> => {
    const token = randomUUID();
    const record: LockRecord = {
      schemaVersion: SHARED_WORKSPACE_SCHEMA_VERSION,
      token,
      taskId,
      pid: process.pid,
      acquiredAt: nowIso(options.now),
      leaseExpiresAt: new Date(options.now().getTime() + leaseMs).toISOString(),
    };
    let handle;
    try {
      handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (!isCode(error, 'EEXIST')) return fail('IO_FAILURE', 'Shared workspace lock could not be created', { cause: error });
      return fail('WORKSPACE_LOCKED', 'Shared workspace is exclusively locked by another task');
    }
    try {
      await handle.writeFile(`${canonicalJson(record)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await syncDir(stateDirectory(workspacesRoot));
    return record;
  };
  try {
    return await acquireOnce();
  } catch (error) {
    if (!(error instanceof SharedWorkspaceError) || error.code !== 'WORKSPACE_LOCKED') throw error;
    // A crashed task may leave an expired lease; take over exactly one stale lock.
    let existing: LockRecord | undefined;
    try {
      const raw = JSON.parse(await readFile(filename, 'utf8')) as unknown;
      if (isPlainObject(raw) && typeof raw.leaseExpiresAt === 'string'
        && typeof raw.token === 'string' && typeof raw.taskId === 'string') {
        existing = raw as unknown as LockRecord;
      }
    } catch { /* Unreadable lock stays locked. */ }
    if (!existing) throw error;
    if (Date.parse(existing.leaseExpiresAt) > options.now().getTime()) throw error;
    await unlink(filename).catch(() => undefined);
    await syncDir(stateDirectory(workspacesRoot));
    return await acquireOnce();
  }
};

const releaseLock = async (workspacesRoot: string, token: string): Promise<boolean> => {
  const filename = lockFile(workspacesRoot);
  try {
    const raw = JSON.parse(await readFile(filename, 'utf8')) as unknown;
    if (!isPlainObject(raw) || raw.token !== token) return false;
    await unlink(filename);
    await syncDir(stateDirectory(workspacesRoot));
    return true;
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false;
    return false;
  }
};

const releaseLockForTask = async (workspacesRoot: string, taskId: string): Promise<boolean> => {
  try {
    const raw = JSON.parse(await readFile(lockFile(workspacesRoot), 'utf8')) as unknown;
    if (!isPlainObject(raw) || raw.taskId !== taskId || typeof raw.token !== 'string') return false;
    return await releaseLock(workspacesRoot, raw.token);
  } catch { return false; }
};

const assertLockOwned = async (workspacesRoot: string, token: string): Promise<void> => {
  const filename = lockFile(workspacesRoot);
  let raw: unknown;
  try { raw = JSON.parse(await readFile(filename, 'utf8')); }
  catch { return fail('WORKSPACE_LOCK_LOST', 'Shared workspace lock is missing'); }
  if (!isPlainObject(raw) || raw.token !== token) fail('WORKSPACE_LOCK_LOST', 'Shared workspace lock belongs to another task');
};

interface MirroredFile { relativePath: string; absolutePath: string; stat: Stats }

const walkSharedFiles = async (
  root: string,
  options: { maxFiles: number; maxDepth: number },
): Promise<MirroredFile[]> => {
  const canonicalRoot = await realpath(root);
  const files: MirroredFile[] = [];
  const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > options.maxDepth) fail('INVALID_INPUT', 'Shared workspace directory depth exceeds the bounded limit');
    const canonicalDirectoryPath = await realpath(directory);
    if (!within(canonicalRoot, canonicalDirectoryPath)) fail('FORBIDDEN_PATH', 'Shared workspace path escaped its root through a symlink');
    const entries = await readdir(canonicalDirectoryPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(canonicalDirectoryPath, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail('SYMLINK_FORBIDDEN', `Shared workspace contains a symbolic link at ${childRelative}`);
      if (entry.isDirectory()) { await walk(absolute, childRelative, depth + 1); continue; }
      if (!entry.isFile()) fail('FORBIDDEN_PATH', `Shared workspace contains a non-regular entry at ${childRelative}`);
      if (files.length >= options.maxFiles) fail('INVALID_INPUT', 'Shared workspace file count exceeds the bounded limit');
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) fail('SYMLINK_FORBIDDEN', `Shared workspace file changed to a non-regular entry at ${childRelative}`);
      files.push({ relativePath: assertSafeRelative(childRelative, 'shared workspace path'), absolutePath: absolute, stat });
    }
  };
  await walk(canonicalRoot, '', 0);
  return files;
};

const mirrorFiles = async (
  sharedRoot: string,
  mirrorRoot: string,
  options: { maxFiles: number; maxDepth: number; maxFileBytes: number; device: number; now: () => Date },
): Promise<{ entries: TaskWorkspaceManifestEntry[]; snapshot: { enabled: boolean; entries: TaskWorkspaceSnapshotEntry[] } | null }> => {
  const files = await walkSharedFiles(sharedRoot, options);
  const entries: TaskWorkspaceManifestEntry[] = [];
  const snapshotEntries: TaskWorkspaceSnapshotEntry[] = [];
  for (const file of files) {
    if (file.stat.dev !== options.device) fail('CROSS_DEVICE', 'Shared workspace file is on a different device than the task workspace');
    if (file.stat.nlink !== 1) {
      fail('EXTERNAL_HARDLINK', `Shared workspace file ${file.relativePath} has an external hard-link alias (nlink=${file.stat.nlink as unknown as number}); refusing writable mirroring`);
    }
    const mirrorPath = path.join(mirrorRoot, ...file.relativePath.split('/'));
    await mkdir(path.dirname(mirrorPath), { recursive: true, mode: 0o700 });
    await linkFile(file.absolutePath, mirrorPath);
    const linked = await lstat(mirrorPath);
    if (!linked.isFile() || linked.isSymbolicLink() || linked.dev !== file.stat.dev || linked.ino !== file.stat.ino) {
      fail('FORBIDDEN_PATH', `Hard-link mirror failed for ${file.relativePath}`);
    }
    const sourceAfter = await lstat(file.absolutePath);
    if (sourceAfter.nlink !== file.stat.nlink + 1) fail('EXTERNAL_HARDLINK', `Unexpected link count change while mirroring ${file.relativePath}`);
    const digest = await sha256File(file.absolutePath, options.maxFileBytes);
    entries.push({
      path: file.relativePath,
      dev: file.stat.dev,
      ino: file.stat.ino,
      nlink: file.stat.nlink,
      size: file.stat.size,
      mtimeMs: file.stat.mtimeMs,
      sha256: digest.sha256,
    });
  }
  return { entries, snapshot: null };
};

const linkFile = async (source: string, target: string): Promise<void> => {
  const { link } = await import('node:fs/promises');
  try { await link(source, target); }
  catch (error) {
    if (isCode(error, 'EXDEV')) fail('CROSS_DEVICE', 'Hard link across devices is not allowed');
    return fail('IO_FAILURE', 'Hard link could not be created', { cause: error });
  }
};

const captureSnapshots = async (
  sharedRoot: string,
  taskDir: string,
  entries: TaskWorkspaceManifestEntry[],
  maxFileBytes: number,
  now: () => Date,
): Promise<{ enabled: boolean; entries: TaskWorkspaceSnapshotEntry[] }> => {
  const snapshotRoot = path.join(taskDir, SNAPSHOT_NAME);
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  const snapshotEntries: TaskWorkspaceSnapshotEntry[] = [];
  for (const entry of entries) {
    const source = path.join(sharedRoot, ...entry.path.split('/'));
    const destination = path.join(snapshotRoot, ...entry.path.split('/'));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await copyFile(source, destination, constants.COPYFILE_FICLONE);
    } catch (error) {
      if (!isCode(error, 'ENOTSUP') && !isCode(error, 'EXDEV') && !isCode(error, 'EINVAL')) {
        return fail('IO_FAILURE', 'Pre-task workspace snapshot could not be created', { cause: error });
      }
      await copyFile(source, destination);
    }
    const digest = await sha256File(destination, maxFileBytes);
    if (digest.sha256 !== entry.sha256) fail('IO_FAILURE', `Snapshot digest differs for ${entry.path}`);
    snapshotEntries.push({ path: entry.path, bytes: digest.bytes, sha256: digest.sha256 });
  }
  return { enabled: true, entries: snapshotEntries };
};

const validateManifest = (value: unknown, taskId: string): TaskWorkspaceManifest => {
  if (!isPlainObject(value)) fail('MANIFEST_TAMPERED', 'Workspace manifest is missing or not an object');
  const required = ['schemaVersion', 'taskId', 'workspacesRootHash', 'sharedRootHash', 'createdAt', 'lockToken', 'entries', 'snapshot', 'manifestSha256'];
  for (const key of Object.keys(value)) if (!required.includes(key)) fail('MANIFEST_TAMPERED', `Workspace manifest has an unknown field: ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail('MANIFEST_TAMPERED', `Workspace manifest lacks ${key}`);
  if (value.schemaVersion !== SHARED_WORKSPACE_SCHEMA_VERSION) fail('MANIFEST_TAMPERED', 'Unsupported workspace manifest schema');
  if (value.taskId !== taskId) fail('MANIFEST_TAMPERED', 'Workspace manifest task identity changed');
  if (typeof value.workspacesRootHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.workspacesRootHash)) fail('MANIFEST_TAMPERED', 'Invalid workspaces root hash');
  if (value.sharedRootHash !== null && (typeof value.sharedRootHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.sharedRootHash))) fail('MANIFEST_TAMPERED', 'Invalid shared root hash');
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) fail('MANIFEST_TAMPERED', 'Invalid createdAt');
  if (value.lockToken !== null && (typeof value.lockToken !== 'string' || !/^[a-f0-9-]{36}$/.test(value.lockToken))) fail('MANIFEST_TAMPERED', 'Invalid lock token');
  if (!Array.isArray(value.entries) || value.entries.length > 100_000) fail('MANIFEST_TAMPERED', 'Invalid manifest entries');
  const seen = new Set<string>();
  for (const raw of value.entries) {
    if (!isPlainObject(raw)) fail('MANIFEST_TAMPERED', 'Invalid manifest entry');
    const entryPath = assertSafeRelative(raw.path, 'manifest entry path');
    if (seen.has(entryPath)) fail('MANIFEST_TAMPERED', 'Duplicate manifest entry');
    seen.add(entryPath);
    for (const field of ['dev', 'ino', 'nlink', 'size', 'mtimeMs'] as const) {
      if (typeof raw[field] !== 'number' || !Number.isFinite(raw[field] as number)) fail('MANIFEST_TAMPERED', `Invalid ${field} in manifest entry`);
    }
    if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) fail('MANIFEST_TAMPERED', 'Invalid entry hash');
  }
  if (value.snapshot !== null) {
    if (!isPlainObject(value.snapshot) || typeof value.snapshot.enabled !== 'boolean' || !Array.isArray(value.snapshot.entries)) fail('MANIFEST_TAMPERED', 'Invalid snapshot metadata');
    for (const raw of value.snapshot.entries) {
      if (!isPlainObject(raw)) fail('MANIFEST_TAMPERED', 'Invalid snapshot entry');
      assertSafeRelative(raw.path, 'snapshot path');
      if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) fail('MANIFEST_TAMPERED', 'Invalid snapshot hash');
    }
  }
  const manifest = value as unknown as TaskWorkspaceManifest;
  const { manifestSha256: _ignored, ...rest } = manifest;
  const recomputed = manifestDigest(rest);
  if (typeof manifest.manifestSha256 !== 'string' || manifest.manifestSha256 !== recomputed) {
    fail('MANIFEST_TAMPERED', 'Workspace manifest integrity hash does not match its content');
  }
  return manifest;
};

export interface PrepareTaskWorkspaceInput extends SharedWorkspaceManagerOptions {
  taskId: string;
}

const resolveRoots = async (input: SharedWorkspaceManagerOptions): Promise<{
  workspacesRoot: string;
  sharedRoot: string | null;
  sharedRootHash: string | null;
  device: number;
  deviceOf: (absolutePath: string) => Promise<number>;
  now: () => Date;
  maxFiles: number;
  maxDepth: number;
  maxFileBytes: number;
}> => {
  const now = input.now ?? (() => new Date());
  const workspacesRoot = await canonicalDirectory(input.workspacesRoot, 'Workspaces root');
  const deviceOf = input.deviceOf ?? (async (absolutePath: string) => (await lstat(absolutePath)).dev);
  const workspaceDevice = await deviceOf(workspacesRoot);
  if (input.sharedRoot === undefined) {
    return { workspacesRoot, sharedRoot: null, sharedRootHash: null, device: workspaceDevice, deviceOf, now,
      maxFiles: Math.max(1, Math.min(input.maxFiles ?? 5000, 100_000)),
      maxDepth: Math.max(1, Math.min(input.maxDepth ?? 16, 64)),
      maxFileBytes: Math.max(1, Math.min(input.maxFileBytes ?? 8 * 1024 * 1024, 256 * 1024 * 1024)) };
  }
  const sharedRoot = await canonicalDirectory(input.sharedRoot, 'Shared workspace root');
  const allowedRaw = input.allowedSharedRoots ?? [sharedRoot];
  const allowed = [];
  for (const candidate of allowedRaw) allowed.push(await canonicalDirectory(candidate, 'Allowed shared root'));
  if (!allowed.some((candidate) => within(candidate, sharedRoot))) {
    fail('SHARED_ROOT_NOT_ALLOWED', 'Shared workspace root is outside the explicit allowlist');
  }
  if (within(workspacesRoot, sharedRoot) || within(sharedRoot, workspacesRoot)) {
    fail('SHARED_ROOT_OVERLAP', 'Shared workspace root must not overlap the task workspaces root');
  }
  const sharedDevice = await deviceOf(sharedRoot);
  if (sharedDevice !== workspaceDevice) fail('CROSS_DEVICE', 'Shared workspace root is on a different device than the task workspaces root');
  return { workspacesRoot, sharedRoot, sharedRootHash: sha256(`shiyu-shared-workspace:v1:${sharedRoot}`), device: workspaceDevice, deviceOf, now,
    maxFiles: Math.max(1, Math.min(input.maxFiles ?? 5000, 100_000)),
    maxDepth: Math.max(1, Math.min(input.maxDepth ?? 16, 64)),
    maxFileBytes: Math.max(1, Math.min(input.maxFileBytes ?? 8 * 1024 * 1024, 256 * 1024 * 1024)) };
};

/**
 * Prepare `<taskId>/task` and (when configured) a writable hard-link mirror at
 * `<taskId>/shared`. Acquires the exclusive shared-workspace lock before any
 * link; on failure the lock is released and partial mirror links are removed.
 */
export const prepareTaskWorkspace = async (input: PrepareTaskWorkspaceInput): Promise<TaskWorkspaceSession> => {
  const taskId = assertTaskId(input.taskId);
  const roots = await resolveRoots(input);
  const directory = taskDirectory(roots.workspacesRoot, taskId);
  const taskDirectoryPath = taskSubdirectory(roots.workspacesRoot, taskId, 'task');
  const sharedDirectoryPath = taskSubdirectory(roots.workspacesRoot, taskId, 'shared');
  let lockToken: string | null = null;
  let session: TaskWorkspaceSession | undefined;
  try {
    // The task root may already exist (artifact store layout); create only our children.
    await ensurePrivateDir(roots.workspacesRoot);
    let existing: Stats | undefined;
    try { existing = await lstat(directory); } catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) fail('FORBIDDEN_PATH', 'Task workspace root must be a real directory');
    if (!existing) await ensurePrivateDir(directory);
    if (roots.sharedRoot === null) {
      await ensurePrivateDir(taskDirectoryPath);
      const manifest = null;
      session = {
        schemaVersion: SHARED_WORKSPACE_SCHEMA_VERSION, taskId, taskDir: taskDirectoryPath, sharedDir: null,
        sharedRoot: null, sharedRootHash: null, lockToken: null, manifestSha256: manifest,
        inPlaceWritesPropagate: false,
        release: async () => ({ mirrorRemoved: false, lockReleased: false }),
      };
      return session;
    }
    if (await fileExists(manifestFile(roots.workspacesRoot, taskId))) {
      fail('TASK_WORKSPACE_EXISTS', 'A shared task workspace already exists for this taskId; publish/discard it first');
    }
    // A crashed earlier attempt may have left task-side mirror links but no
    // manifest. Remove only those links (canonical shared files are untouched)
    // before re-mirroring, otherwise their link count would look external.
    if (await fileExists(sharedDirectoryPath)) await removeMirrorLinks(sharedDirectoryPath);
    lockToken = (await acquireLock(roots.workspacesRoot, taskId, { now: roots.now, leaseMs: input.lockLeaseMs ?? 10 * 60 * 1000 })).token;
    await ensurePrivateDir(taskDirectoryPath);
    await ensurePrivateDir(sharedDirectoryPath);
    const mirrored = await mirrorFiles(roots.sharedRoot, sharedDirectoryPath, {
      maxFiles: roots.maxFiles, maxDepth: roots.maxDepth, maxFileBytes: roots.maxFileBytes, device: roots.device, now: roots.now,
    });
    let snapshot: { enabled: boolean; entries: TaskWorkspaceSnapshotEntry[] } | null = null;
    if (input.snapshot) snapshot = await captureSnapshots(roots.sharedRoot, directory, mirrored.entries, roots.maxFileBytes, roots.now);
    const manifestWithoutHash: Omit<TaskWorkspaceManifest, 'manifestSha256'> = {
      schemaVersion: SHARED_WORKSPACE_SCHEMA_VERSION,
      taskId,
      workspacesRootHash: sha256(`shiyu-workspaces-root:v1:${roots.workspacesRoot}`),
      sharedRootHash: roots.sharedRootHash,
      createdAt: nowIso(roots.now),
      lockToken,
      entries: mirrored.entries,
      snapshot,
    };
    const manifest: TaskWorkspaceManifest = { ...manifestWithoutHash, manifestSha256: manifestDigest(manifestWithoutHash) };
    await writeJsonExclusive(manifestFile(roots.workspacesRoot, taskId), manifest);
    session = {
      schemaVersion: SHARED_WORKSPACE_SCHEMA_VERSION, taskId, taskDir: taskDirectoryPath, sharedDir: sharedDirectoryPath,
      sharedRoot: roots.sharedRoot, sharedRootHash: roots.sharedRootHash, lockToken, manifestSha256: manifest.manifestSha256,
      inPlaceWritesPropagate: true,
      release: async () => {
        const mirrorRemoved = await removeMirrorLinks(sharedDirectoryPath);
        const lockReleased = lockToken ? await releaseLock(roots.workspacesRoot, lockToken) : false;
        return { mirrorRemoved, lockReleased };
      },
    };
    return session;
  } catch (error) {
    if (lockToken) await releaseLock(roots.workspacesRoot, lockToken).catch(() => undefined);
    await removeMirrorLinks(sharedDirectoryPath).catch(() => undefined);
    if (error instanceof SharedWorkspaceError) throw error;
    fail('IO_FAILURE', 'Task workspace preparation failed', { cause: error });
  }
};

const fileExists = async (filename: string): Promise<boolean> => {
  try { await lstat(filename); return true; } catch (error) { if (isCode(error, 'ENOENT')) return false; throw error; }
};

const removeMirrorLinks = async (sharedDirectoryPath: string | null): Promise<boolean> => {
  if (!sharedDirectoryPath) return false;
  let removed = false;
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (isCode(error, 'ENOENT')) return; throw error; }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { await unlink(absolute); removed = true; continue; }
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (entry.isFile()) { await unlink(absolute); removed = true; }
    }
    await rmdir(directory).catch(() => undefined);
  };
  await walk(sharedDirectoryPath);
  return removed;
};

export interface PublishTaskWorkspaceInput extends SharedWorkspaceManagerOptions {
  taskId: string;
  /** Declared in-place modifications. Undeclared modifications are conflicts. */
  expectedChanges?: readonly string[];
  /** Explicit owner decision required to delete canonical shared files. */
  ownerDecision?: { kind: 'delete-shared'; paths: readonly string[]; decisionId: string; decidedAt?: string };
  /** Keep task-side mirror links for inspection even when synced (default false). */
  keepMirror?: boolean;
}

const readManifest = async (workspacesRoot: string, taskId: string): Promise<TaskWorkspaceManifest> => {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(manifestFile(workspacesRoot, taskId), 'utf8')); }
  catch (error) {
    if (isCode(error, 'ENOENT')) fail('MANIFEST_MISSING', 'Task workspace manifest is missing');
    fail('MANIFEST_TAMPERED', 'Task workspace manifest is unreadable', { cause: error });
  }
  return validateManifest(raw, taskId);
};

const normalizedExpected = (paths: readonly string[] | undefined): Set<string> => {
  const result = new Set<string>();
  for (const candidate of paths ?? []) result.add(assertSafeRelative(candidate, 'expected change path'));
  return result;
};

const buildIndex = async (sharedRoot: string, roots: { maxFiles: number; maxDepth: number; maxFileBytes: number }, now: () => Date): Promise<{ schemaVersion: number; sharedRootHash: string; updatedAt: string; entries: { path: string; sha256: string; size: number; dev: number; ino: number; mtimeMs: number }[] }> => {
  const files = await walkSharedFiles(sharedRoot, roots);
  const entries = [];
  for (const file of files) {
    const digest = await sha256File(file.absolutePath, roots.maxFileBytes);
    entries.push({ path: file.relativePath, sha256: digest.sha256, size: file.stat.size, dev: file.stat.dev, ino: file.stat.ino, mtimeMs: file.stat.mtimeMs });
  }
  return {
    schemaVersion: SHARED_WORKSPACE_SCHEMA_VERSION,
    sharedRootHash: sha256(`shiyu-shared-workspace:v1:${await realpath(sharedRoot)}`),
    updatedAt: nowIso(now),
    entries,
  };
};

/**
 * Diff the writable mirror against the pre-task manifest, publish declared new
 * files by hard link and update the shared index only for a consistent result.
 * Undeclared modifications, external replacements and symlinks produce
 * `unknown`/`blocked` with no index guess and no silent discard.
 */
export const publishTaskWorkspace = async (input: PublishTaskWorkspaceInput): Promise<WorkspacePublishReport> => {
  const taskId = assertTaskId(input.taskId);
  const roots = await resolveRoots(input);
  const sharedRoot = roots.sharedRoot;
  const taskDirectoryPath = taskDirectory(roots.workspacesRoot, taskId);
  const mirrorDirectoryPath = taskSubdirectory(roots.workspacesRoot, taskId, 'shared');
  const report = (value: WorkspacePublishReport): WorkspacePublishReport => value;
  const disclosure = {
    inPlaceWritesPropagateToSharedSource: true,
    mirrorUsesFileHardLinks: true,
    deletionDefault: 'task-link-only' as const,
    deleteSharedRequiresOwnerDecision: true as const,
    artifactsUnaffected: true as const,
  };
  if (sharedRoot === null) {
    return report({
      schemaVersion: SHARED_WORKSPACE_SCHEMA_VERSION, taskId, status: 'no-shared', code: null, sharedRootHash: null,
      manifestSha256: null, lockReleased: false, mirrorRetained: false, changes: [], conflicts: [], index: null,
      rollbackAvailable: false, ownerDecision: null, disclosure,
    });
  }
  const blockedReport = async (code: string, manifestSha256: string | null, rollbackAvailable: boolean): Promise<WorkspacePublishReport> => {
    const lockReleased = await releaseLockForTask(roots.workspacesRoot, taskId);
    const blocked: WorkspacePublishReport = {
      schemaVersion: SHARED_WORKSPACE_SCHEMA_VERSION, taskId, status: 'blocked', code, sharedRootHash: roots.sharedRootHash,
      manifestSha256, lockReleased, mirrorRetained: true, changes: [], conflicts: [], index: null, rollbackAvailable,
      ownerDecision: null, disclosure,
    };
    await writeJsonAtomic(reportFile(roots.workspacesRoot, taskId), blocked).catch(() => undefined);
    return blocked;
  };
  let manifest: TaskWorkspaceManifest;
  try { manifest = await readManifest(roots.workspacesRoot, taskId); }
  catch (error) {
    if (error instanceof SharedWorkspaceError) return blockedReport(error.code, null, false);
    throw error;
  }
  if (manifest.sharedRootHash !== roots.sharedRootHash) return blockedReport('SHARED_ROOT_NOT_ALLOWED', manifest.manifestSha256, manifest.snapshot !== null);
  const expected = normalizedExpected(input.expectedChanges);
  const deleteDecision = new Set<string>();
  if (input.ownerDecision) {
    if (input.ownerDecision.kind !== 'delete-shared' || typeof input.ownerDecision.decisionId !== 'string'
      || !/^[A-Za-z0-9_.:-]{1,100}$/.test(input.ownerDecision.decisionId)) {
      fail('INVALID_INPUT', 'ownerDecision must be an explicit delete-shared decision with a bounded decisionId');
    }
    for (const candidate of input.ownerDecision.paths) deleteDecision.add(assertSafeRelative(candidate, 'owner deletion path'));
  }
  const lockToken = manifest.lockToken;
  try {
    if (!lockToken) fail('WORKSPACE_LOCK_LOST', 'Manifest has no lock token');
    await assertLockOwned(roots.workspacesRoot, lockToken);
    const mirrorFiles = await walkSharedFiles(mirrorDirectoryPath, roots);
    const mirrorByPath = new Map(mirrorFiles.map((file) => [file.relativePath, file]));
    const preByPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    for (const decisionPath of deleteDecision) {
      if (!preByPath.has(decisionPath)) fail('INVALID_INPUT', `ownerDecision path ${decisionPath} is not an existing shared file captured by this task`);
    }
    const changes: WorkspaceChange[] = [];
    const conflicts: WorkspaceConflict[] = [];
    const pendingLinks: { relativePath: string; sourcePath: string }[] = [];
    const pendingDeletions: string[] = [];
    for (const [relativePath, entry] of preByPath) {
      const canonicalPath = path.join(sharedRoot, ...relativePath.split('/'));
      let canonical: Stats | undefined;
      try { canonical = await lstat(canonicalPath); }
      catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
      if (!canonical) { conflicts.push({ path: relativePath, kind: 'canonical-missing', detail: 'canonical shared file disappeared during the task' }); continue; }
      if (canonical.isSymbolicLink() || !canonical.isFile()) { conflicts.push({ path: relativePath, kind: 'external-change', detail: 'canonical shared path became a non-regular file' }); continue; }
      if (canonical.dev !== entry.dev || canonical.ino !== entry.ino) {
        conflicts.push({ path: relativePath, kind: 'canonical-replaced', detail: 'canonical shared file was replaced by a different inode during the task' });
        continue;
      }
      const mirror = mirrorByPath.get(relativePath);
      if (deleteDecision.has(relativePath)) {
        pendingDeletions.push(relativePath);
        continue;
      }
      if (!mirror) {
        const canonicalNow = await sha256File(canonicalPath, roots.maxFileBytes);
        if (canonicalNow.sha256 !== entry.sha256) {
          conflicts.push({ path: relativePath, kind: 'external-change', detail: 'canonical shared file changed while the task link was removed' });
          continue;
        }
        changes.push({ path: relativePath, kind: 'task-link-removed', preSha256: entry.sha256, postSha256: entry.sha256 });
        continue;
      }
      if (mirror.stat.dev !== canonical.dev || mirror.stat.ino !== canonical.ino) {
        conflicts.push({ path: relativePath, kind: 'inconsistent-mirror', detail: 'task mirror no longer shares the canonical inode' });
        continue;
      }
      const current = await sha256File(mirror.absolutePath, roots.maxFileBytes);
      if (current.sha256 === entry.sha256) continue;
      const canonicalDigest = await sha256File(canonicalPath, roots.maxFileBytes);
      if (canonicalDigest.sha256 !== current.sha256) {
        conflicts.push({ path: relativePath, kind: 'inconsistent-mirror', detail: 'mirror and canonical bytes differ despite a shared inode' });
        continue;
      }
      if (!expected.has(relativePath)) {
        conflicts.push({ path: relativePath, kind: 'unexpected-modification', detail: 'in-place modification was not declared in expectedChanges' });
        continue;
      }
      changes.push({ path: relativePath, kind: 'in-place-updated', preSha256: entry.sha256, postSha256: current.sha256 });
    }
    for (const [relativePath, mirror] of mirrorByPath) {
      if (preByPath.has(relativePath)) continue;
      const canonicalPath = path.join(sharedRoot, ...relativePath.split('/'));
      let canonical: Stats | undefined;
      try { canonical = await lstat(canonicalPath); }
      catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
      if (!canonical || canonical.ino === mirror.stat.ino) {
        // Canonical may be a hard-linked publish from an earlier failed attempt.
        if (canonical && (canonical.isSymbolicLink() || !canonical.isFile())) {
          conflicts.push({ path: relativePath, kind: 'canonical-exists', detail: 'canonical path already exists as a non-regular entry' });
        } else if (canonical) {
          changes.push({ path: relativePath, kind: 'already-published', preSha256: null, postSha256: mirror.stat.isFile() ? (await sha256File(mirror.absolutePath, roots.maxFileBytes)).sha256 : null });
        } else {
          pendingLinks.push({ relativePath, sourcePath: mirror.absolutePath });
        }
        continue;
      }
      conflicts.push({ path: relativePath, kind: 'canonical-exists', detail: 'a different canonical file already exists at the new path; refusing to overwrite' });
    }
    const conflictStatus = conflicts.length > 0;
    let index: { path: string; sha256: string } | null = null;
    if (!conflictStatus) {
      for (const relativePath of pendingDeletions) {
        const canonicalPath = path.join(sharedRoot, ...relativePath.split('/'));
        await unlink(canonicalPath);
        await syncDir(path.dirname(canonicalPath));
        changes.push({ path: relativePath, kind: 'shared-deleted', preSha256: preByPath.get(relativePath)?.sha256 ?? null, postSha256: null });
      }
      for (const pending of pendingLinks) {
        const canonicalPath = path.join(sharedRoot, ...pending.relativePath.split('/'));
        await ensureSharedDirectories(sharedRoot, path.dirname(canonicalPath));
        await linkFile(pending.sourcePath, canonicalPath);
        const canonicalStat = await lstat(canonicalPath);
        const mirrorStat = await lstat(pending.sourcePath);
        if (canonicalStat.dev !== mirrorStat.dev || canonicalStat.ino !== mirrorStat.ino || canonicalStat.nlink !== 2) {
          fail('IO_FAILURE', 'Published new shared file link identity is inconsistent');
        }
        const digest = await sha256File(canonicalPath, roots.maxFileBytes);
        changes.push({ path: pending.relativePath, kind: 'published-new', preSha256: null, postSha256: digest.sha256 });
      }
      if (changes.length > 0 || pendingLinks.length > 0 || pendingDeletions.length > 0) {
        const indexValue = await buildIndex(sharedRoot, roots, roots.now);
        await writeJsonAtomic(indexPath(roots.workspacesRoot), indexValue);
        index = { path: `${STATE_DIR}/${INDEX_NAME}`, sha256: sha256(`${canonicalJson(indexValue)}\n`) };
      } else {
        index = await currentIndexIdentity(roots.workspacesRoot);
      }
    }
    const status: WorkspacePublishStatus = conflictStatus ? 'unknown' : changes.length === 0 ? 'no-changes' : 'synced';
    const finalReport: WorkspacePublishReport = {
      schemaVersion: SHARED_WORKSPACE_SCHEMA_VERSION, taskId, status, code: conflictStatus ? 'WORKSPACE_CONFLICT_UNKNOWN' : null,
      sharedRootHash: roots.sharedRootHash, manifestSha256: manifest.manifestSha256, lockReleased: false,
      mirrorRetained: conflictStatus || input.keepMirror === true, changes, conflicts, index,
      rollbackAvailable: manifest.snapshot !== null,
      ownerDecision: input.ownerDecision
        ? { kind: 'delete-shared', decisionId: input.ownerDecision.decisionId, paths: [...deleteDecision].sort() }
        : null,
      disclosure,
    };
    const reportWithRelease = await finishSession(roots, taskId, finalReport, input.keepMirror === true || conflictStatus, lockToken);
    if (reportWithRelease.status !== 'blocked') await writeJsonAtomic(reportFile(roots.workspacesRoot, taskId), reportWithRelease);
    return reportWithRelease;
  } catch (error) {
    if (lockToken) await releaseLock(roots.workspacesRoot, lockToken).catch(() => undefined);
    if (error instanceof SharedWorkspaceError) return blockedReport(error.code, manifest.manifestSha256, manifest.snapshot !== null);
    throw error;
  }
};

const currentIndexIdentity = async (workspacesRoot: string): Promise<{ path: string; sha256: string } | null> => {
  try {
    const bytes = await readFile(indexPath(workspacesRoot));
    return { path: `${STATE_DIR}/${INDEX_NAME}`, sha256: sha256(bytes) };
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null;
    throw error;
  }
};

const ensureSharedDirectories = async (sharedRoot: string, directory: string): Promise<void> => {
  if (!within(sharedRoot, directory)) fail('FORBIDDEN_PATH', 'Published shared directory escaped the shared root');
  const canonicalRoot = await realpath(sharedRoot);
  const relative = path.relative(canonicalRoot, directory);
  let current = canonicalRoot;
  for (const segment of relative.split(path.sep).filter((value) => value.length > 0)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) fail('FORBIDDEN_PATH', 'Shared publish path component is not a real directory');
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
      await mkdir(current, { mode: 0o700 });
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) fail('FORBIDDEN_PATH', 'Shared publish directory creation failed');
    }
  }
};

const finishSession = async (
  roots: { workspacesRoot: string; now: () => Date },
  taskId: string,
  report: WorkspacePublishReport,
  keepMirror: boolean,
  lockToken: string | null,
): Promise<WorkspacePublishReport> => {
  let mirrorRemoved = false;
  if (!keepMirror) mirrorRemoved = await removeMirrorLinks(taskSubdirectory(roots.workspacesRoot, taskId, 'shared'));
  const lockReleased = lockToken ? await releaseLock(roots.workspacesRoot, lockToken) : false;
  return { ...report, lockReleased, mirrorRetained: keepMirror || report.mirrorRetained };
};

/** Remove only task-side mirror links and the lock/manifest; canonical shared files are untouched. */
export const discardTaskWorkspace = async (input: SharedWorkspaceManagerOptions & { taskId: string }): Promise<{ mirrorRemoved: boolean; lockReleased: boolean }> => {
  const taskId = assertTaskId(input.taskId);
  const roots = await resolveRoots(input);
  const manifest = await readManifest(roots.workspacesRoot, taskId).catch(() => undefined);
  const mirrorRemoved = await removeMirrorLinks(taskSubdirectory(roots.workspacesRoot, taskId, 'shared'));
  const lockReleased = manifest?.lockToken
    ? await releaseLock(roots.workspacesRoot, manifest.lockToken)
    : await releaseLockForTask(roots.workspacesRoot, taskId);
  await unlink(manifestFile(roots.workspacesRoot, taskId)).catch(() => undefined);
  return { mirrorRemoved, lockReleased };
};

export interface RollbackTaskWorkspaceInput extends SharedWorkspaceManagerOptions {
  taskId: string;
}

/**
 * Restore the pre-task snapshot content in place (preserving the canonical
 * inode where possible) and leave the task mirror cleaned up.
 */
export const rollbackTaskWorkspace = async (input: RollbackTaskWorkspaceInput): Promise<WorkspaceRollbackReport> => {
  const taskId = assertTaskId(input.taskId);
  const roots = await resolveRoots(input);
  const reportBase = {
    schemaVersion: SHARED_WORKSPACE_SCHEMA_VERSION, taskId,
    restored: [] as { path: string; sha256: string }[], conflicts: [] as WorkspaceConflict[], lockReleased: false,
  };
  if (roots.sharedRoot === null) return { ...reportBase, status: 'no-snapshot', code: 'NO_SHARED_ROOT' };
  let manifest: TaskWorkspaceManifest;
  try { manifest = await readManifest(roots.workspacesRoot, taskId); }
  catch (error) {
    return { ...reportBase, status: 'blocked', code: error instanceof SharedWorkspaceError ? error.code : 'MANIFEST_TAMPERED' };
  }
  if (!manifest.snapshot?.enabled) {
    const lockReleased = manifest.lockToken ? await releaseLock(roots.workspacesRoot, manifest.lockToken) : false;
    return { ...reportBase, status: 'no-snapshot', code: 'SNAPSHOT_DISABLED', lockReleased };
  }
  if (!manifest.lockToken) return { ...reportBase, status: 'blocked', code: 'WORKSPACE_LOCK_LOST' };
  const lockToken = manifest.lockToken;
  try {
    await assertLockOwned(roots.workspacesRoot, lockToken);
    const snapshotRoot = path.join(taskDirectory(roots.workspacesRoot, taskId), SNAPSHOT_NAME);
    const conflicts: WorkspaceConflict[] = [];
    const restored: { path: string; sha256: string }[] = [];
    for (const entry of manifest.entries) {
      const canonicalPath = path.join(roots.sharedRoot, ...entry.path.split('/'));
      let canonical: Stats | undefined;
      try { canonical = await lstat(canonicalPath); }
      catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
      if (!canonical) { conflicts.push({ path: entry.path, kind: 'canonical-missing', detail: 'canonical file is gone; snapshot cannot recreate the inode safely' }); continue; }
      if (canonical.isSymbolicLink() || !canonical.isFile() || canonical.dev !== entry.dev || canonical.ino !== entry.ino) {
        conflicts.push({ path: entry.path, kind: 'canonical-replaced', detail: 'canonical inode changed; refusing an in-place rollback over a different file' });
        continue;
      }
      const snapshotPath = path.join(snapshotRoot, ...entry.path.split('/'));
      const snapshotDigest = await sha256File(snapshotPath, roots.maxFileBytes);
      if (snapshotDigest.sha256 !== entry.sha256) {
        conflicts.push({ path: entry.path, kind: 'manifest-mismatch', detail: 'snapshot content no longer matches the manifest hash' });
        continue;
      }
      const bytes = await readFile(snapshotPath);
      const handle = await open(canonicalPath, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const restoredDigest = await sha256File(canonicalPath, roots.maxFileBytes);
      if (restoredDigest.sha256 !== entry.sha256) throw new SharedWorkspaceError('IO_FAILURE', 'Rollback write did not restore the expected hash');
      restored.push({ path: entry.path, sha256: entry.sha256 });
    }
    await removeMirrorLinks(taskSubdirectory(roots.workspacesRoot, taskId, 'shared'));
    const lockReleased = await releaseLock(roots.workspacesRoot, manifest.lockToken);
    if (conflicts.length === 0) {
      const indexValue = await buildIndex(roots.sharedRoot, roots, roots.now);
      await writeJsonAtomic(indexPath(roots.workspacesRoot), indexValue);
      const report: WorkspaceRollbackReport = { ...reportBase, status: 'rolled-back', code: null, restored, conflicts, lockReleased };
      await writeJsonAtomic(reportFile(roots.workspacesRoot, taskId), report);
      return report;
    }
    return { ...reportBase, status: 'blocked', code: 'ROLLBACK_CONFLICT', restored, conflicts, lockReleased };
  } catch (error) {
    if (manifest.lockToken) await releaseLock(roots.workspacesRoot, manifest.lockToken).catch(() => undefined);
    if (error instanceof SharedWorkspaceError) throw error;
    fail('IO_FAILURE', 'Workspace rollback failed', { cause: error });
  }
};
