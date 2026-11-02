/**
 * Filesystem / SQLite primitives for the offline checkpoint module.
 *
 * These helpers perform real durable writes (fsync + rename + directory fsync)
 * and real SQLite integrity reads. They never repair or delete authoritative
 * data and never follow symlinks out of the roots they are given.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RecoveryError } from './errors.js';

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]));
  }
  return value;
};

/** Deterministic JSON used for manifest hashes and ledger sealing. */
export const canonicalJson = (value: unknown): string => JSON.stringify(canonical(value));

export const hashCanonical = (value: unknown): string => sha256(canonicalJson(value));

export const ensureDir = async (directory: string): Promise<string> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
};

export const readJson = async (filename: string): Promise<unknown> => {
  const text = await readFile(filename, 'utf8');
  return JSON.parse(text) as unknown;
};

export const fileEvidence = async (filename: string): Promise<{ bytes: number; sha256: string }> => {
  const bytes = await readFile(filename);
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
};

const fsyncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** Write a new regular file durably. Existing files are never overwritten. */
export const writeBytesAtomic = async (filename: string, bytes: Uint8Array, mode = 0o600): Promise<void> => {
  await ensureDir(path.dirname(filename));
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', mode);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filename);
    await fsyncDirectory(path.dirname(filename));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

export const writeJsonAtomic = async (filename: string, value: unknown): Promise<void> => {
  await writeBytesAtomic(filename, new TextEncoder().encode(`${canonicalJson(value)}\n`));
};

/** Write exact bytes to a not-yet-existing file (exclusive create). */
export const writeBytesExclusive = async (filename: string, bytes: Uint8Array, mode = 0o600): Promise<void> => {
  await ensureDir(path.dirname(filename));
  const handle = await open(filename, 'wx', mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** Reject absolute paths, traversal, backslashes and empty segments. Bundle refs are POSIX-relative. */
export const assertSafeRelativeRef = (ref: unknown, label: string): string => {
  if (typeof ref !== 'string' || !ref || ref.length > 400 || ref.includes('\\') || ref.includes('\0')) {
    throw new RecoveryError('INVALID_SCHEMA', `Invalid ${label}`);
  }
  if (ref.startsWith('/') || /^[A-Za-z]:/.test(ref)) throw new RecoveryError('INVALID_SCHEMA', `Absolute path in ${label}`);
  const segments = ref.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new RecoveryError('INVALID_SCHEMA', `Unsafe path segment in ${label}`);
  }
  return ref;
};

export const resolveInside = (root: string, ref: string): string => {
  const resolved = path.resolve(root, ...assertSafeRelativeRef(ref, 'bundle ref').split('/'));
  const normalRoot = path.resolve(root);
  if (resolved !== normalRoot && !resolved.startsWith(`${normalRoot}${path.sep}`)) {
    throw new RecoveryError('INVALID_SCHEMA', 'Bundle reference escaped its root');
  }
  return resolved;
};

export const hashPath = (value: string): string => sha256(path.resolve(value));

export const freeBytes = async (target: string): Promise<number> => {
  try {
    const info = await statfs(target, { bigint: false });
    return info.bavail * info.bsize;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return freeBytes(path.dirname(target));
    }
    throw error;
  }
};

/**
 * Read-only SQLite integrity check. `quick_check` reads the database pages
 * needed for logical consistency without rewriting anything; `foreign_key_check`
 * is read-only in SQLite and returns zero rows for a consistent snapshot.
 */
export const sqliteIntegrity = async (filename: string): Promise<{ quickCheck: 'ok'; foreignKeyCheck: 'ok' }> => {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const quick = db.prepare('PRAGMA quick_check').all() as unknown as { quick_check?: unknown }[];
    if (quick.length !== 1 || quick[0]?.quick_check !== 'ok') {
      throw new RecoveryError('INTEGRITY_CHECK_FAILED', 'SQLite quick_check did not return ok');
    }
    const foreign = db.prepare('PRAGMA foreign_key_check').all();
    if (foreign.length !== 0) throw new RecoveryError('INTEGRITY_CHECK_FAILED', 'SQLite foreign_key_check reported violations');
    return { quickCheck: 'ok', foreignKeyCheck: 'ok' };
  } finally {
    db.close();
  }
};

export const readOnlyDatabase = (filename: string): DatabaseSync => new DatabaseSync(filename, { readOnly: true });

/** Directory listing without following symlinks; returns sorted relative file paths. */
export const listRegularFiles = async (root: string, relative = ''): Promise<string[]> => {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const ref = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new RecoveryError('INVALID_SCHEMA', 'Bundle contains a symbolic link');
    if (entry.isDirectory()) result.push(...await listRegularFiles(root, ref));
    else if (entry.isFile()) result.push(ref);
  }
  return result.sort();
};

export const parseJsonText = (text: string, label: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RecoveryError('INVALID_SCHEMA', `Invalid JSON in ${label}`);
  }
};

export const readJsonLines = async (filename: string, options: { maxBytes: number; maxLines: number }): Promise<unknown[]> => {
  const info = await stat(filename);
  if (!info.isFile() || info.size > options.maxBytes) throw new RecoveryError('INVALID_SCHEMA', 'JSONL file exceeds its size limit');
  const text = await readFile(filename, 'utf8');
  if (!text.endsWith('\n')) throw new RecoveryError('INVALID_SCHEMA', 'JSONL file is not newline terminated');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > options.maxLines) throw new RecoveryError('INVALID_SCHEMA', 'JSONL file exceeds its line limit');
  return lines.map((line, index) => parseJsonText(line, `JSONL line ${index + 1}`));
};

export const fileExists = async (filename: string): Promise<boolean> => {
  try {
    const info = await stat(filename);
    return info.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

export const isInside = (child: string, parent: string): boolean => {
  const normalizedChild = path.resolve(child);
  const normalizedParent = path.resolve(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`);
};
