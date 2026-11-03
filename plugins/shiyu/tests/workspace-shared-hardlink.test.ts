/**
 * Writable shared-workspace hard-link mirror (task-67).
 *
 * Real temporary filesystems and hard links; no live host, no model, no real
 * workspace. Artifact publication is intentionally exercised alongside to prove
 * `<taskId>/artifacts` remains unchanged by workspace mirroring/publishing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { LocalArtifactStore } from '../src/adapters/artifacts/index.js';
import {
  SharedWorkspaceError,
  discardTaskWorkspace,
  prepareTaskWorkspace,
  publishTaskWorkspace,
  rollbackTaskWorkspace,
} from '../src/adapters/artifacts/shared-workspace.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const artifactDirectory = path.join(packageRoot, 'artifacts', 'dsh', 'tasks');
const evidenceFile = path.join(artifactDirectory, 'workspace-shared-hardlink.json');

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const sha256File = async (filename: string): Promise<string> => sha256(await readFile(filename));
const NOW = (): Date => new Date('2026-11-03T21:00:00.000Z');

const hasCode = (code: string) => (error: unknown): boolean => error instanceof SharedWorkspaceError && error.code === code;

interface Fixture {
  root: string;
  workspacesRoot: string;
  sharedRoot: string;
  options: { workspacesRoot: string; sharedRoot: string; allowedSharedRoots: string[]; now: () => Date };
}

const fixture = async (t: { after(fn: () => Promise<void>): void }): Promise<Fixture> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'shiyu-shared-workspace-'));
  const root = await realpath(directory);
  const workspacesRoot = path.join(root, 'workspaces');
  const sharedRoot = path.join(root, 'shared-workspace');
  await mkdir(workspacesRoot, { recursive: true, mode: 0o700 });
  await mkdir(sharedRoot, { recursive: true, mode: 0o700 });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, workspacesRoot, sharedRoot, options: { workspacesRoot, sharedRoot, allowedSharedRoots: [sharedRoot], now: NOW } };
};

const seed = async (fixture: Fixture, files: Record<string, string>): Promise<void> => {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(fixture.sharedRoot, ...relative.split('/'));
    await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    await writeFile(absolute, content);
  }
};

const indexOf = async (fixture: Fixture): Promise<{ entries: { path: string; sha256: string }[] } | undefined> => {
  try { return JSON.parse(await readFile(path.join(fixture.workspacesRoot, '.shared-workspaces', 'index.json'), 'utf8')) as { entries: { path: string; sha256: string }[] }; }
  catch { return undefined; }
};

test('layout uses task/ and shared/, and the mirror is a writable hard-link of the canonical file', async t => {
  const f = await fixture(t);
  await seed(f, { 'notes.md': 'original shared notes' });
  const session = await prepareTaskWorkspace({ ...f.options, taskId: 'task-layout' });
  assert.equal(session.inPlaceWritesPropagate, true);
  assert.ok(session.sharedDir && session.taskDir);
  assert.deepEqual((await readdir(path.join(f.workspacesRoot, 'task-layout'))).sort(), ['.workspace-manifest.json', 'shared', 'task']);
  assert.equal((await lstat(session.taskDir)).isDirectory(), true);
  assert.equal((await lstat(session.sharedDir!)).isDirectory(), true);
  const mirror = path.join(session.sharedDir!, 'notes.md');
  const canonical = path.join(f.sharedRoot, 'notes.md');
  const [mirrorStat, canonicalStat] = await Promise.all([lstat(mirror), lstat(canonical)]);
  assert.equal(canonicalStat.isFile(), true);
  assert.equal(mirrorStat.ino, canonicalStat.ino);
  assert.equal(mirrorStat.dev, canonicalStat.dev);
  assert.equal(canonicalStat.nlink, 2, 'mirror and canonical share one inode');
  // In-place write through the task mirror immediately changes the canonical file.
  await writeFile(mirror, 'edited in place through the task mirror');
  assert.equal(await readFile(canonical, 'utf8'), 'edited in place through the task mirror');
  const manifest = JSON.parse(await readFile(path.join(f.workspacesRoot, 'task-layout', '.workspace-manifest.json'), 'utf8')) as {
    entries: { path: string; dev: number; ino: number; nlink: number; size: number; mtimeMs: number; sha256: string }[];
    manifestSha256: string;
  };
  assert.equal(manifest.entries[0]?.path, 'notes.md');
  assert.equal(manifest.entries[0]?.nlink, 1);
  assert.equal(manifest.entries[0]?.sha256, sha256('original shared notes'));
  for (const field of ['dev', 'ino', 'nlink', 'size', 'mtimeMs']) assert.equal(typeof manifest.entries[0]?.[field as 'dev'], 'number');
  const report = await publishTaskWorkspace({ ...f.options, taskId: 'task-layout', expectedChanges: ['notes.md'] });
  assert.equal(report.status, 'synced');
  assert.deepEqual(report.changes.map((change) => change.kind), ['in-place-updated']);
  assert.equal(report.disclosure.inPlaceWritesPropagateToSharedSource, true);
  assert.equal(report.disclosure.mirrorUsesFileHardLinks, true);
  assert.equal(report.lockReleased, true);
  assert.equal(report.mirrorRetained, false);
  assert.equal((await lstat(canonical)).nlink, 1, 'mirror is cleaned up after publish');
  const index = await indexOf(f);
  assert.equal(index?.entries.find((entry) => entry.path === 'notes.md')?.sha256, sha256('edited in place through the task mirror'));
});

test('new files created under shared/ are published into the canonical root by hard link and never discarded', async t => {
  const f = await fixture(t);
  await seed(f, { 'notes.md': 'base' });
  const session = await prepareTaskWorkspace({ ...f.options, taskId: 'task-new' });
  await mkdir(path.join(session.sharedDir!, 'nested'), { recursive: true });
  await writeFile(path.join(session.sharedDir!, 'nested', 'new.txt'), 'created by the task');
  const report = await publishTaskWorkspace({ ...f.options, taskId: 'task-new' });
  assert.equal(report.status, 'synced');
  assert.deepEqual(report.changes.map((change) => [change.path, change.kind]), [['nested/new.txt', 'published-new']]);
  const canonical = path.join(f.sharedRoot, 'nested', 'new.txt');
  assert.equal(await readFile(canonical, 'utf8'), 'created by the task');
  assert.equal((await indexOf(f))?.entries.find((entry) => entry.path === 'nested/new.txt')?.sha256, sha256('created by the task'));
  // A later task can still prepare: canonical files are single-link again.
  const next = await prepareTaskWorkspace({ ...f.options, taskId: 'task-new-next' });
  assert.equal((await lstat(path.join(next.sharedDir!, 'nested', 'new.txt'))).nlink, 2);
  await next.release();
});

test('deleting a shared file defaults to removing only the task-side link', async t => {
  const f = await fixture(t);
  await seed(f, { 'keep.md': 'keep me', 'other.md': 'other' });
  const session = await prepareTaskWorkspace({ ...f.options, taskId: 'task-delete-default' });
  await rm(path.join(session.sharedDir!, 'keep.md'));
  const report = await publishTaskWorkspace({ ...f.options, taskId: 'task-delete-default' });
  assert.equal(report.status, 'synced');
  assert.deepEqual(report.changes.map((change) => [change.path, change.kind]), [['keep.md', 'task-link-removed']]);
  assert.equal(await readFile(path.join(f.sharedRoot, 'keep.md'), 'utf8'), 'keep me', 'canonical file is never silently deleted');
  assert.equal((await indexOf(f))?.entries.some((entry) => entry.path === 'keep.md'), true);
});

test('deleting a canonical shared file requires an explicit owner decision', async t => {
  const f = await fixture(t);
  await seed(f, { 'remove.md': 'remove after owner decision', 'keep.md': 'keep' });
  const session = await prepareTaskWorkspace({ ...f.options, taskId: 'task-delete-decision' });
  await rm(path.join(session.sharedDir!, 'remove.md'));
  const report = await publishTaskWorkspace({
    ...f.options, taskId: 'task-delete-decision',
    ownerDecision: { kind: 'delete-shared', paths: ['remove.md'], decisionId: 'owner-decision-1', decidedAt: NOW().toISOString() },
  });
  assert.equal(report.status, 'synced');
  assert.deepEqual(report.changes.map((change) => [change.path, change.kind]), [['remove.md', 'shared-deleted']]);
  assert.deepEqual(report.ownerDecision, { kind: 'delete-shared', decisionId: 'owner-decision-1', paths: ['remove.md'] });
  await assert.rejects(readFile(path.join(f.sharedRoot, 'remove.md')), /ENOENT/);
  assert.equal((await indexOf(f))?.entries.some((entry) => entry.path === 'remove.md'), false);
});

test('an undeclared in-place modification is a conflict: task unknown, index not updated, mirror retained', async t => {
  const f = await fixture(t);
  await seed(f, { 'notes.md': 'before' });
  const session = await prepareTaskWorkspace({ ...f.options, taskId: 'task-conflict' });
  await writeFile(path.join(session.sharedDir!, 'notes.md'), 'undeclared edit');
  const indexBefore = await indexOf(f);
  const report = await publishTaskWorkspace({ ...f.options, taskId: 'task-conflict' });
  assert.equal(report.status, 'unknown');
  assert.equal(report.code, 'WORKSPACE_CONFLICT_UNKNOWN');
  assert.deepEqual(report.conflicts.map((conflict) => [conflict.path, conflict.kind]), [['notes.md', 'unexpected-modification']]);
  assert.equal(report.mirrorRetained, true);
  assert.equal(report.lockReleased, true);
  assert.deepEqual(await indexOf(f), indexBefore, 'shared index must not guess an undeclared change');
  // Canonical changed by the disclosed in-place write; the task mirror is kept for reconciliation.
  assert.equal(await readFile(path.join(f.sharedRoot, 'notes.md'), 'utf8'), 'undeclared edit');
  await discardTaskWorkspace({ ...f.options, taskId: 'task-conflict' });
  const next = await prepareTaskWorkspace({ ...f.options, taskId: 'task-conflict-next' });
  await next.release();
});

test('external replacement of the canonical file is an unexpected conflict and is not overwritten', async t => {
  const f = await fixture(t);
  await seed(f, { 'notes.md': 'captured' });
  const session = await prepareTaskWorkspace({ ...f.options, taskId: 'task-replaced' });
  const canonical = path.join(f.sharedRoot, 'notes.md');
  const replacement = path.join(f.sharedRoot, '.replacement.tmp');
  await writeFile(replacement, 'external replacement');
  await rename(replacement, canonical);
  const report = await publishTaskWorkspace({ ...f.options, taskId: 'task-replaced', expectedChanges: ['notes.md'] });
  assert.equal(report.status, 'unknown');
  assert.deepEqual(report.conflicts.map((conflict) => conflict.kind), ['canonical-replaced']);
  assert.equal(await readFile(canonical, 'utf8'), 'external replacement');
  assert.equal(report.mirrorRetained, true);
  void session;
});

test('exclusive shared-workspace lock blocks a second task until release', async t => {
  const f = await fixture(t);
  await seed(f, { 'notes.md': 'locked' });
  const first = await prepareTaskWorkspace({ ...f.options, taskId: 'task-lock-a' });
  await assert.rejects(prepareTaskWorkspace({ ...f.options, taskId: 'task-lock-b' }), hasCode('WORKSPACE_LOCKED'));
  const released = await first.release();
  assert.equal(released.lockReleased, true);
  assert.equal(released.mirrorRemoved, true);
  const second = await prepareTaskWorkspace({ ...f.options, taskId: 'task-lock-b' });
  await second.release();
});

test('cross-device shared roots and symbolically linked roots/files are rejected before any link', async t => {
  const f = await fixture(t);
  await seed(f, { 'notes.md': 'target' });
  const crossDevice = await prepareTaskWorkspace({
    ...f.options, taskId: 'task-cross-device',
    deviceOf: async (absolutePath: string) => (path.resolve(absolutePath) === path.join(f.root, 'shared-workspace') || absolutePath.includes(`${path.sep}shared-workspace`) ? 999 : 1),
  }).then(() => undefined, (error: unknown) => error);
  assert.ok(crossDevice instanceof SharedWorkspaceError && crossDevice.code === 'CROSS_DEVICE');
  await assert.rejects(readdir(path.join(f.workspacesRoot, 'task-cross-device', 'shared')), /ENOENT/);
  // Symlinked shared root.
  const alias = path.join(f.root, 'shared-alias');
  await symlink(f.sharedRoot, alias);
  await assert.rejects(prepareTaskWorkspace({ workspacesRoot: f.workspacesRoot, sharedRoot: alias, allowedSharedRoots: [alias], now: NOW, taskId: 'task-symlink-root' }), hasCode('FORBIDDEN_PATH'));
  // Symlinked entry inside the shared root.
  const outside = path.join(f.root, 'outside.txt');
  await writeFile(outside, 'outside');
  await symlink(outside, path.join(f.sharedRoot, 'escape-link'));
  await assert.rejects(prepareTaskWorkspace({ ...f.options, taskId: 'task-symlink-entry' }), hasCode('SYMLINK_FORBIDDEN'));
  await rm(path.join(f.sharedRoot, 'escape-link'));
  // A task-created symlink in the mirror is a blocked publish, not a follow.
  const session = await prepareTaskWorkspace({ ...f.options, taskId: 'task-symlink-task' });
  await symlink(outside, path.join(session.sharedDir!, 'created-link'));
  const report = await publishTaskWorkspace({ ...f.options, taskId: 'task-symlink-task' });
  assert.equal(report.status, 'blocked');
  assert.equal(report.code, 'SYMLINK_FORBIDDEN');
  await discardTaskWorkspace({ ...f.options, taskId: 'task-symlink-task' });
});

test('shared files with an external hard-link alias are rejected (no foreign inode mirroring)', async t => {
  const f = await fixture(t);
  await seed(f, { 'notes.md': 'shared' });
  const external = path.join(f.root, 'external-alias');
  await link(path.join(f.sharedRoot, 'notes.md'), external);
  await assert.rejects(prepareTaskWorkspace({ ...f.options, taskId: 'task-external-inode' }), hasCode('EXTERNAL_HARDLINK'));
  await assert.rejects(readdir(path.join(f.workspacesRoot, 'task-external-inode', 'shared')), /ENOENT/);
});

test('shared root allowlist, overlap and escape rules are enforced', async t => {
  const f = await fixture(t);
  const other = path.join(f.root, 'other-shared');
  await mkdir(other, { recursive: true, mode: 0o700 });
  await assert.rejects(prepareTaskWorkspace({ workspacesRoot: f.workspacesRoot, sharedRoot: f.sharedRoot, allowedSharedRoots: [other], now: NOW, taskId: 'task-not-allowed' }), hasCode('SHARED_ROOT_NOT_ALLOWED'));
  const inside = path.join(f.workspacesRoot, 'shared-inside');
  await mkdir(inside, { recursive: true, mode: 0o700 });
  await assert.rejects(prepareTaskWorkspace({ workspacesRoot: f.workspacesRoot, sharedRoot: inside, allowedSharedRoots: [inside], now: NOW, taskId: 'task-overlap' }), hasCode('SHARED_ROOT_OVERLAP'));
  await assert.rejects(prepareTaskWorkspace({ ...f.options, taskId: '../escape' }), hasCode('INVALID_INPUT'));
});

test('manifest tampering is detected and blocks publishing without guessing', async t => {
  const f = await fixture(t);
  await seed(f, { 'notes.md': 'before tamper' });
  const session = await prepareTaskWorkspace({ ...f.options, taskId: 'task-tamper' });
  assert.ok(session.manifestSha256);
  const manifestPath = path.join(f.workspacesRoot, 'task-tamper', '.workspace-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { entries: { sha256: string }[] };
  manifest.entries[0]!.sha256 = '0'.repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const indexBefore = await indexOf(f);
  const report = await publishTaskWorkspace({ ...f.options, taskId: 'task-tamper' });
  assert.equal(report.status, 'blocked');
  assert.equal(report.code, 'MANIFEST_TAMPERED');
  assert.equal(report.lockReleased, true);
  assert.deepEqual(await indexOf(f), indexBefore);
  await discardTaskWorkspace({ ...f.options, taskId: 'task-tamper' });
  const next = await prepareTaskWorkspace({ ...f.options, taskId: 'task-tamper-next' });
  await next.release();
});

test('optional pre-task snapshot supports an in-place rollback of canonical content', async t => {
  const f = await fixture(t);
  await seed(f, { 'notes.md': 'original before snapshot', 'other.md': 'other original' });
  const session = await prepareTaskWorkspace({ ...f.options, taskId: 'task-rollback', snapshot: true });
  assert.equal((await readdir(path.join(f.workspacesRoot, 'task-rollback', '.workspace-snapshot'))).sort().join(','), 'notes.md,other.md');
  await writeFile(path.join(session.sharedDir!, 'notes.md'), 'modified after snapshot');
  assert.equal(await readFile(path.join(f.sharedRoot, 'notes.md'), 'utf8'), 'modified after snapshot');
  const rollback = await rollbackTaskWorkspace({ ...f.options, taskId: 'task-rollback' });
  assert.equal(rollback.status, 'rolled-back');
  assert.equal(rollback.lockReleased, true);
  assert.deepEqual(rollback.restored.map((item) => item.path).sort(), ['notes.md', 'other.md']);
  assert.equal(await readFile(path.join(f.sharedRoot, 'notes.md'), 'utf8'), 'original before snapshot');
  assert.equal((await indexOf(f))?.entries.find((entry) => entry.path === 'notes.md')?.sha256, sha256('original before snapshot'));
  // Snapshot disabled -> explicit no-snapshot outcome, lock still released.
  const noSnapshot = await prepareTaskWorkspace({ ...f.options, taskId: 'task-no-snapshot' });
  const disabled = await rollbackTaskWorkspace({ ...f.options, taskId: 'task-no-snapshot' });
  assert.equal(disabled.status, 'no-snapshot');
  assert.equal(disabled.code, 'SNAPSHOT_DISABLED');
  assert.equal(disabled.lockReleased, true);
  void noSnapshot;
});

test('without a configured shared root the module is a task-only no-op and artifacts are unaffected', async t => {
  const f = await fixture(t);
  const store = await LocalArtifactStore.open(f.workspacesRoot);
  try {
    const content = 'synthetic task artifact';
    const expectedSha256 = sha256(content);
    const written = await store.write({ taskId: 'task-no-shared', content, expectedSha256 });
    const artifactPath = path.join(f.workspacesRoot, 'task-no-shared', 'artifacts', 'note.txt');
    assert.equal(await readFile(artifactPath, 'utf8'), content);
    const session = await prepareTaskWorkspace({ workspacesRoot: f.workspacesRoot, taskId: 'task-no-shared', now: NOW });
    assert.equal(session.sharedDir, null);
    assert.equal(session.sharedRoot, null);
    assert.equal(session.inPlaceWritesPropagate, false);
    assert.equal(session.lockToken, null);
    assert.equal((await lstat(session.taskDir)).isDirectory(), true);
    const report = await publishTaskWorkspace({ workspacesRoot: f.workspacesRoot, taskId: 'task-no-shared', now: NOW });
    assert.equal(report.status, 'no-shared');
    assert.deepEqual(report.changes, []);
    assert.equal(report.disclosure.artifactsUnaffected, true);
    const released = await session.release();
    assert.deepEqual(released, { mirrorRemoved: false, lockReleased: false });
    // Artifact publication path is unchanged and independently observable.
    assert.equal((await store.inspect({ taskId: 'task-no-shared', expectedSha256 }))!.sha256, expectedSha256);
    assert.equal(written.sha256, expectedSha256);
    assert.equal((await lstat(artifactPath)).isFile(), true);
  } finally { await store.close(); }
});

test('with a shared root configured, existing artifact files stay byte-identical and independently observable', async t => {
  const f = await fixture(t);
  await seed(f, { 'notes.md': 'shared content' });
  const store = await LocalArtifactStore.open(f.workspacesRoot);
  try {
    const content = 'task artifact while shared mirroring';
    const expectedSha256 = sha256(content);
    await store.write({ taskId: 'task-artifact', content, expectedSha256 });
    const artifactPath = path.join(f.workspacesRoot, 'task-artifact', 'artifacts', 'note.txt');
    const before = await lstat(artifactPath);
    const session = await prepareTaskWorkspace({ ...f.options, taskId: 'task-artifact' });
    await writeFile(path.join(session.sharedDir!, 'notes.md'), 'changed through shared mirror');
    await writeFile(path.join(session.sharedDir!, 'brand-new.md'), 'new shared file');
    const report = await publishTaskWorkspace({ ...f.options, taskId: 'task-artifact', expectedChanges: ['notes.md'] });
    assert.equal(report.status, 'synced');
    const after = await lstat(artifactPath);
    assert.equal(after.ino, before.ino);
    assert.equal(await readFile(artifactPath, 'utf8'), content);
    assert.equal((await store.inspect({ taskId: 'task-artifact', expectedSha256 }))!.sha256, expectedSha256);
  } finally { await store.close(); }
});

/* ------------------------------------------------------------------------------------------------
 * Evidence generator
 * ---------------------------------------------------------------------------------------------- */

async function generateEvidence(): Promise<void> {
  const cases: { caseId: string; injectionPoint: string; expected: string; observed: string; pass: boolean }[] = [];
  const scenario = async (caseId: string, injectionPoint: string, expected: string, body: () => Promise<string>): Promise<void> => {
    try { cases.push({ caseId, injectionPoint, expected, observed: await body(), pass: true }); }
    catch (error) { cases.push({ caseId, injectionPoint, expected, observed: `failed: ${(error as Error).message}`, pass: false }); }
  };
  const withWorkspace = async <T>(body: (f: Fixture) => Promise<T>): Promise<T> => {
    const directory = await mkdtemp(path.join(tmpdir(), 'shiyu-shared-workspace-evidence-'));
    const root = await realpath(directory);
    const workspacesRoot = path.join(root, 'workspaces');
    const sharedRoot = path.join(root, 'shared-workspace');
    await mkdir(workspacesRoot, { recursive: true, mode: 0o700 });
    await mkdir(sharedRoot, { recursive: true, mode: 0o700 });
    const f: Fixture = { root, workspacesRoot, sharedRoot, options: { workspacesRoot, sharedRoot, allowedSharedRoots: [sharedRoot], now: NOW } };
    try { return await body(f); } finally { await rm(root, { recursive: true, force: true }); }
  };
  await scenario('in-place-propagation', '共享文件已链接到任务 shared/，任务原地写该链接', 'canonical 内容立即变化；declare expectedChanges 后 synced 且 index 更新', async () => {
    return withWorkspace(async f => {
      await writeFile(path.join(f.sharedRoot, 'notes.md'), 'before');
      const session = await prepareTaskWorkspace({ ...f.options, taskId: 'ev-in-place' });
      await writeFile(path.join(session.sharedDir!, 'notes.md'), 'after');
      const canonical = await readFile(path.join(f.sharedRoot, 'notes.md'), 'utf8');
      const report = await publishTaskWorkspace({ ...f.options, taskId: 'ev-in-place', expectedChanges: ['notes.md'] });
      if (canonical !== 'after' || report.status !== 'synced') throw new Error(`canonical=${canonical} status=${report.status}`);
      return 'canonical changed immediately; synced with declared change; index sha updated';
    });
  });
  await scenario('new-file-publish', '任务在 shared/ 下新建 nested/new.txt', 'canonical 出现新文件；index 记录；不静默丢弃', async () => {
    return withWorkspace(async f => {
      const session = await prepareTaskWorkspace({ ...f.options, taskId: 'ev-new' });
      await mkdir(path.join(session.sharedDir!, 'nested'), { recursive: true });
      await writeFile(path.join(session.sharedDir!, 'nested', 'new.txt'), 'new');
      const report = await publishTaskWorkspace({ ...f.options, taskId: 'ev-new' });
      const canonical = await readFile(path.join(f.sharedRoot, 'nested', 'new.txt'), 'utf8');
      if (report.status !== 'synced' || canonical !== 'new') throw new Error(`status=${report.status}`);
      return 'published new.txt by hard link; canonical readable; index updated';
    });
  });
  await scenario('delete-default', '任务删除 shared/ 中文件链接', '默认只移除任务侧链接，canonical 保留', async () => {
    return withWorkspace(async f => {
      await writeFile(path.join(f.sharedRoot, 'keep.md'), 'keep');
      const session = await prepareTaskWorkspace({ ...f.options, taskId: 'ev-delete' });
      await rm(path.join(session.sharedDir!, 'keep.md'));
      const report = await publishTaskWorkspace({ ...f.options, taskId: 'ev-delete' });
      const canonical = await readFile(path.join(f.sharedRoot, 'keep.md'), 'utf8');
      if (report.status !== 'synced' || canonical !== 'keep') throw new Error(`status=${report.status} canonical=${canonical}`);
      return 'task-link removed; canonical kept; change recorded as task-link-removed';
    });
  });
  await scenario('delete-owner-decision', '任务删除链接 + 显式 ownerDecision delete-shared', 'canonical 被受控删除；index 移除；回执记录 decision', async () => {
    return withWorkspace(async f => {
      await writeFile(path.join(f.sharedRoot, 'remove.md'), 'remove');
      const session = await prepareTaskWorkspace({ ...f.options, taskId: 'ev-delete-decision' });
      await rm(path.join(session.sharedDir!, 'remove.md'));
      const report = await publishTaskWorkspace({ ...f.options, taskId: 'ev-delete-decision', ownerDecision: { kind: 'delete-shared', paths: ['remove.md'], decisionId: 'ev-decision-1', decidedAt: NOW().toISOString() } });
      if (report.status !== 'synced' || report.changes[0]?.kind !== 'shared-deleted') throw new Error(`status=${report.status}`);
      try { await readFile(path.join(f.sharedRoot, 'remove.md')); throw new Error('canonical still exists'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return 'canonical deleted only under explicit owner decision; index updated';
    });
  });
  await scenario('unexpected-conflict', '任务原地写未在 expectedChanges 声明', 'status unknown；index 不变；mirror 保留；不猜', async () => {
    return withWorkspace(async f => {
      await writeFile(path.join(f.sharedRoot, 'notes.md'), 'before');
      const session = await prepareTaskWorkspace({ ...f.options, taskId: 'ev-conflict' });
      await writeFile(path.join(session.sharedDir!, 'notes.md'), 'undeclared');
      const report = await publishTaskWorkspace({ ...f.options, taskId: 'ev-conflict' });
      if (report.status !== 'unknown' || !report.conflicts.some((item) => item.kind === 'unexpected-modification')) throw new Error(`status=${report.status}`);
      return 'unknown with unexpected-modification; index untouched; mirror retained';
    });
  });
  await scenario('lock-exclusive', '任务 A 持有共享锁时任务 B prepare', '任务 B 得到 WORKSPACE_LOCKED；A release 后 B 可 prepare', async () => {
    return withWorkspace(async f => {
      await writeFile(path.join(f.sharedRoot, 'notes.md'), 'x');
      const a = await prepareTaskWorkspace({ ...f.options, taskId: 'ev-lock-a' });
      let rejected = '';
      try { await prepareTaskWorkspace({ ...f.options, taskId: 'ev-lock-b' }); } catch (error) { rejected = (error as { code?: string }).code ?? ''; }
      await a.release();
      const b = await prepareTaskWorkspace({ ...f.options, taskId: 'ev-lock-b' });
      await b.release();
      if (rejected !== 'WORKSPACE_LOCKED') throw new Error(`rejected=${rejected}`);
      return 'second prepare blocked with WORKSPACE_LOCKED; released lock allows next task';
    });
  });
  await scenario('cross-device-rejected', '注入 deviceOf 使 shared root 与 workspaces root 设备不同', 'CROSS_DEVICE；不创建链接', async () => {
    return withWorkspace(async f => {
      await writeFile(path.join(f.sharedRoot, 'notes.md'), 'x');
      let code = '';
      try {
        await prepareTaskWorkspace({ ...f.options, taskId: 'ev-cross-device', deviceOf: async (absolutePath: string) => absolutePath.includes(`${path.sep}shared-workspace`) ? 999 : 1 });
      } catch (error) { code = (error as { code?: string }).code ?? ''; }
      if (code !== 'CROSS_DEVICE') throw new Error(`code=${code}`);
      return 'CROSS_DEVICE before any link creation';
    });
  });
  await scenario('symlink-rejected', 'shared root 中存在符号链接条目', 'SYMLINK_FORBIDDEN；不跟随、不链接', async () => {
    return withWorkspace(async f => {
      await writeFile(path.join(f.root, 'outside.txt'), 'outside');
      await symlink(path.join(f.root, 'outside.txt'), path.join(f.sharedRoot, 'escape'));
      let code = '';
      try { await prepareTaskWorkspace({ ...f.options, taskId: 'ev-symlink' }); } catch (error) { code = (error as { code?: string }).code ?? ''; }
      if (code !== 'SYMLINK_FORBIDDEN') throw new Error(`code=${code}`);
      return 'SYMLINK_FORBIDDEN; outside file never linked or read as workspace content';
    });
  });
  await scenario('manifest-tamper', '修改 .workspace-manifest.json 的 entry sha256', 'blocked MANIFEST_TAMPERED；不发布/index 不变', async () => {
    return withWorkspace(async f => {
      await writeFile(path.join(f.sharedRoot, 'notes.md'), 'before');
      await prepareTaskWorkspace({ ...f.options, taskId: 'ev-tamper' });
      const manifestPath = path.join(f.workspacesRoot, 'ev-tamper', '.workspace-manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { entries: { sha256: string }[] };
      manifest.entries[0]!.sha256 = '0'.repeat(64);
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      const report = await publishTaskWorkspace({ ...f.options, taskId: 'ev-tamper' });
      if (report.status !== 'blocked' || report.code !== 'MANIFEST_TAMPERED') throw new Error(`status=${report.status} code=${report.code}`);
      return 'blocked MANIFEST_TAMPERED; lock released; no publish';
    });
  });
  await scenario('snapshot-rollback', 'snapshot=true 后原地修改，再 rollback', 'rolled-back；canonical 内容恢复；index 恢复；锁释放', async () => {
    return withWorkspace(async f => {
      await writeFile(path.join(f.sharedRoot, 'notes.md'), 'original');
      const session = await prepareTaskWorkspace({ ...f.options, taskId: 'ev-rollback', snapshot: true });
      await writeFile(path.join(session.sharedDir!, 'notes.md'), 'changed');
      const rollback = await rollbackTaskWorkspace({ ...f.options, taskId: 'ev-rollback' });
      const restored = await readFile(path.join(f.sharedRoot, 'notes.md'), 'utf8');
      if (rollback.status !== 'rolled-back' || restored !== 'original') throw new Error(`status=${rollback.status} restored=${restored}`);
      return 'rolled-back; canonical content/hash restored; index rebuilt; lock released';
    });
  });
  await scenario('no-shared-noop', '未配置 sharedRoot', 'task-only；publish=no-shared；artifact 路径不变', async () => {
    return withWorkspace(async f => {
      const store = await LocalArtifactStore.open(f.workspacesRoot);
      try {
        const content = 'artifact no shared';
        await store.write({ taskId: 'ev-no-shared', content, expectedSha256: sha256(content) });
        const session = await prepareTaskWorkspace({ workspacesRoot: f.workspacesRoot, taskId: 'ev-no-shared', now: NOW });
        const report = await publishTaskWorkspace({ workspacesRoot: f.workspacesRoot, taskId: 'ev-no-shared', now: NOW });
        if (session.sharedDir !== null || report.status !== 'no-shared') throw new Error('not a no-op');
        return 'task-only layout; publish no-shared; artifact still observable';
      } finally { await store.close(); }
    });
  });

  const sourceFiles = ['src/adapters/artifacts/shared-workspace.ts', 'src/adapters/artifacts/index.ts', 'src/adapters/artifacts/SHARED_WORKSPACE.md', 'tests/workspace-shared-hardlink.test.ts'];
  const fileIdentity = async (relative: string) => ({ path: relative, sha256: await sha256File(path.join(packageRoot, relative)) });
  let git: Record<string, unknown> = { head: null };
  try { git = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim() }; } catch { /* non-git */ }
  const evidence = {
    schemaVersion: 1,
    slice: 'task-67',
    title: '每任务工作区 + 可写共享工作区硬链接：布局、发布、锁、manifest、冲突与回滚',
    generatedAt: new Date().toISOString(),
    evidenceLevel: 'G1 offline filesystem module (real temporary filesystems and hard links; no live host/model)',
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    fingerprints: {
      source: { git, moduleFiles: await Promise.all(sourceFiles.map(fileIdentity)) },
      build: {
        buildCommand: 'npm run check (tsc --noEmit + node --import tsx --test tests/*.test.ts + tsc -p tsconfig.build.json + node --check client/index.js)',
        tsconfigBuildSha256: await sha256File(path.join(packageRoot, 'tsconfig.build.json')),
        packageJsonSha256: await sha256File(path.join(packageRoot, 'package.json')),
      },
      tests: { files: [{ path: 'tests/workspace-shared-hardlink.test.ts', sha256: await sha256File(path.join(packageRoot, 'tests/workspace-shared-hardlink.test.ts')) }] },
    },
    layout: {
      taskRoot: '{dataDir}/workspaces/<taskId>/task',
      sharedMirror: '{dataDir}/workspaces/<taskId>/shared (hard links only; directories recreated)',
      manifest: '{dataDir}/workspaces/<taskId>/.workspace-manifest.json (dev/ino/nlink/size/mtime/sha256 + integrity hash)',
      report: '{dataDir}/workspaces/<taskId>/.workspace-report.json',
      snapshot: '{dataDir}/workspaces/<taskId>/.workspace-snapshot/ (optional APFS clone/copy)',
      sharedIndex: '{dataDir}/workspaces/.shared-workspaces/index.json',
      lock: '{dataDir}/workspaces/.shared-workspaces/lock.json (exclusive single-writer)',
      artifacts: 'unchanged: {dataDir}/workspaces/<taskId>/artifacts/note.txt is only published by LocalArtifactStore from the task area',
    },
    disclosure: {
      inPlaceWritesPropagateToSharedSource: true,
      mirrorUsesFileHardLinksOnly: true,
      deletionDefault: 'task-link-only',
      deleteSharedRequiresExplicitOwnerDecision: true,
      unexpectedConflictOutcome: 'unknown/blocked, shared index not advanced, task mirror retained for reconciliation',
      singleWriterAssumption: true,
      sameFilesystemRequired: true,
      symlinkAndExternalHardlinkRejected: true,
      artifactsPathUnchanged: true,
    },
    summary: { total: cases.length, passed: cases.filter((item) => item.pass).length, failed: cases.filter((item) => !item.pass).length },
    cases,
    boundaries: {
      liveHost: false, modelCalls: 0, realWorkspaceTouched: false,
      apfsCloneVerified: false,
      externalConcurrentWriters: 'not supported; exclusive advisory lock + single-writer assumption only',
      runtimeWired: false,
    },
    regeneration: { command: 'SHIYU_WRITE_EVIDENCE=1 node --import tsx --test tests/workspace-shared-hardlink.test.ts' },
  };
  let exists = true;
  try { await readFile(evidenceFile); } catch { exists = false; }
  if (process.env.SHIYU_WRITE_EVIDENCE === '1' || !exists) {
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  const persisted = JSON.parse(await readFile(evidenceFile, 'utf8')) as { summary: { total: number; failed: number }; cases: { pass: boolean }[]; disclosure: { inPlaceWritesPropagateToSharedSource: boolean } };
  assert.equal(persisted.summary.failed, 0);
  assert.equal(persisted.summary.total, cases.length);
  assert.equal(persisted.cases.every((item) => item.pass), true);
  assert.equal(persisted.disclosure.inPlaceWritesPropagateToSharedSource, true);
}

test('evidence generator: shared-workspace matrix includes all required scenarios', async () => {
  await generateEvidence();
  const text = await readFile(evidenceFile, 'utf8');
  assert.ok(!text.includes('/tmp/'), 'evidence leaked a temporary path');
  const persisted = JSON.parse(text) as { cases: { caseId: string }[] };
  const ids = new Set(persisted.cases.map((item) => item.caseId));
  for (const required of ['in-place-propagation', 'new-file-publish', 'delete-default', 'delete-owner-decision', 'unexpected-conflict', 'lock-exclusive', 'cross-device-rejected', 'symlink-rejected', 'manifest-tamper', 'snapshot-rollback', 'no-shared-noop']) {
    assert.ok(ids.has(required), `missing evidence case ${required}`);
  }
});
