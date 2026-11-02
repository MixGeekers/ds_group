import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ArtifactError, ArtifactUnknownError, LocalArtifactStore } from '../src/adapters/artifacts/index.js';

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const input = (taskId = 'task-a', content = '识雨本体的合成本地产物。') => ({ taskId, content, expectedSha256: digest(content) });
const hasCode = (code: string) => (error: unknown) => error instanceof ArtifactError && error.code === code;
const uncertainBecause = (code: string) => (error: unknown) => error instanceof ArtifactUnknownError && error.outcome === 'unknown' && error.cause instanceof ArtifactError && error.cause.code === code;
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-artifacts-'));
  const requested = join(directory, 'workspaces');
  const store = await LocalArtifactStore.open(requested);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, root: store.root, target: (id = 'task-a') => join(store.root, id, 'artifacts', 'note.txt') };
}
function interceptOpen(intercept: (file: string, handle: fs.promises.FileHandle) => fs.promises.FileHandle) {
  const original = fs.promises.open;
  fs.promises.open = async (...args: Parameters<typeof original>) => intercept(String(args[0]), await original(...args));
  syncBuiltinESMExports();
  return () => { fs.promises.open = original; syncBuiltinESMExports(); };
}
function withSync(handle: fs.promises.FileHandle, sync: () => Promise<void>): fs.promises.FileHandle {
  return new Proxy(handle, { get(target, key) {
    if (key === 'sync') return sync;
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
function interceptLink(intercept: (original: typeof fs.promises.link, existing: fs.PathLike, target: fs.PathLike) => Promise<void>) {
  const original = fs.promises.link;
  fs.promises.link = async (existing, target) => intercept(original, existing, target);
  syncBuiltinESMExports();
  return () => { fs.promises.link = original; syncBuiltinESMExports(); };
}

test('bounded local artifacts use a fixed private path and are independently observable', async t => {
  const { store, root, target } = await fixture(t); const note = input();
  assert.equal(store.root, await realpath(root));
  const written = await store.write(note);
  assert.equal(written.artifactRef, 'artifact:task-a'); assert.equal(written.sha256, note.expectedSha256);
  assert.equal(written.byteLength, Buffer.byteLength(note.content)); assert.ok(Number.isFinite(Date.parse(written.observedAt)));
  assert.equal(await readFile(target(), 'utf8'), note.content);
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(root, 'task-a'))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(root, 'task-a', 'artifacts'))).mode & 0o777, 0o700);
  assert.equal((await lstat(target())).mode & 0o777, 0o600);
  assert.equal((await lstat(target())).nlink, 1);
  assert.deepEqual(await readdir(join(root, 'task-a', 'artifacts')), ['note.txt']);
  assert.equal((await store.inspect({ taskId: note.taskId, expectedSha256: note.expectedSha256 }))!.sha256, note.expectedSha256);
});

test('same content retries are idempotent across a new adapter, while different content never overwrites', async t => {
  const { store, root, target } = await fixture(t); const first = input();
  await store.write(first); const identity = await lstat(target(), { bigint: true });
  const secondStore = await LocalArtifactStore.open(root);
  try {
    assert.equal((await secondStore.write(first)).sha256, first.expectedSha256);
    assert.equal((await lstat(target(), { bigint: true })).ino, identity.ino);
    await assert.rejects(secondStore.write(input('task-a', 'different content')), hasCode('CONTENT_CONFLICT'));
    assert.equal(await readFile(target(), 'utf8'), first.content);
  } finally { await secondStore.close(); }
});

test('task IDs, content size, fields and hashes are validated before any task directory is created', async t => {
  const { store, root } = await fixture(t);
  for (const id of ['../escape', 'a/b', 'a.b', '.', '', 'x\\y', 'x'.repeat(101)]) await assert.rejects(store.write(input(id)), hasCode('INVALID_INPUT'));
  await assert.rejects(store.write({ ...input(), expectedSha256: '0'.repeat(64) }), hasCode('INVALID_INPUT'));
  await assert.rejects(store.write({ ...input(), expectedSha256: 'INVALID' }), hasCode('INVALID_INPUT'));
  await assert.rejects(store.write(input('too-large', '雨'.repeat(342))), hasCode('INVALID_INPUT'));
  await assert.rejects(store.write({ ...input(), path: '/not-a-supported-command' } as any), hasCode('INVALID_INPUT'));
  assert.deepEqual(await readdir(root), []);
  assert.equal((await store.write(input('utf8-limit', '雨'.repeat(341)))).byteLength, 1023);
  assert.equal((await store.write(input('byte-limit', 'a'.repeat(1024)))).byteLength, 1024);
});

test('inspect is read-only when an artifact or its directories are absent', async t => {
  const { store, root } = await fixture(t);
  assert.equal(await store.inspect({ taskId: 'missing' }), undefined);
  assert.deepEqual(await readdir(root), []);
  const cwd = await store.prepareWorkspace('prepared');
  assert.equal(cwd, join(root, 'prepared')); assert.deepEqual(await readdir(cwd), []);
  assert.equal(await store.inspect({ taskId: 'prepared' }), undefined);
  assert.deepEqual(await readdir(cwd), []);
});

test('root and child symlinks cannot redirect artifacts outside the controlled directory', async t => {
  const { directory, store, root } = await fixture(t);
  const outside = join(directory, 'outside'); await mkdir(outside, { mode: 0o700 });
  await writeFile(join(outside, 'note.txt'), 'outside-sentinel', { mode: 0o600 });
  await symlink(root, join(directory, 'root-alias'));
  await assert.rejects(LocalArtifactStore.open(join(directory, 'root-alias')), hasCode('FORBIDDEN_PATH'));
  await symlink(outside, join(root, 'task-link'));
  await assert.rejects(store.prepareWorkspace('task-link'), hasCode('FORBIDDEN_PATH'));
  await assert.rejects(store.write(input('task-link')), hasCode('FORBIDDEN_PATH'));
  await assert.rejects(store.inspect({ taskId: 'task-link' }), uncertainBecause('FORBIDDEN_PATH'));
  await store.prepareWorkspace('artifact-link'); await symlink(outside, join(root, 'artifact-link', 'artifacts'));
  await assert.rejects(store.write(input('artifact-link')), hasCode('FORBIDDEN_PATH'));
  assert.equal(await readFile(join(outside, 'note.txt'), 'utf8'), 'outside-sentinel');
});

test('artifact symlinks, hard-link aliases and nonregular targets are rejected without touching their contents', async t => {
  const { directory, store, root, target } = await fixture(t);
  const outside = join(directory, 'outside.txt'); await writeFile(outside, 'outside-sentinel', { mode: 0o600 });
  for (const id of ['symbolic', 'hard', 'directory']) {
    const cwd = await store.prepareWorkspace(id); await mkdir(join(cwd, 'artifacts'), { mode: 0o700 });
    if (id === 'symbolic') await symlink(outside, target(id));
    else if (id === 'hard') await link(outside, target(id));
    else await mkdir(target(id), { mode: 0o700 });
    await assert.rejects(store.inspect({ taskId: id }), uncertainBecause('FORBIDDEN_PATH'));
    await assert.rejects(store.write(input(id)), hasCode('FORBIDDEN_PATH'));
    assert.deepEqual(await readdir(join(root, id, 'artifacts')), ['note.txt']);
  }
  assert.equal(await readFile(outside, 'utf8'), 'outside-sentinel');
});

test('storage must stay private and independent inspection bounds pre-existing files', async t => {
  const { directory, store, root, target } = await fixture(t);
  const publicRoot = join(directory, 'public'); await mkdir(publicRoot, { mode: 0o755 });
  await assert.rejects(LocalArtifactStore.open(publicRoot), hasCode('FORBIDDEN_PATH'));
  await store.write(input()); await chmod(target(), 0o644);
  await assert.rejects(store.inspect({ taskId: 'task-a' }), uncertainBecause('FORBIDDEN_PATH'));
  await chmod(target(), 0o600); await writeFile(target(), 'x'.repeat(1025));
  await assert.rejects(store.inspect({ taskId: 'task-a' }), uncertainBecause('FORBIDDEN_PATH'));
  await chmod(join(root, 'task-a'), 0o755);
  await assert.rejects(store.write(input()), hasCode('FORBIDDEN_PATH'));
});

test('inspection reports actual content independently and refuses a mismatched expected digest', async t => {
  const { store, target } = await fixture(t); await store.write(input());
  await writeFile(target(), 'independently modified synthetic note', { mode: 0o600 });
  const observed = await store.inspect({ taskId: 'task-a' });
  assert.equal(observed!.sha256, digest('independently modified synthetic note'));
  await assert.rejects(store.inspect({ taskId: 'task-a', expectedSha256: input().expectedSha256 }), uncertainBecause('CONTENT_CONFLICT'));
});

test('cancellation before writing or before atomic publication leaves no note and cleans its temporary file', async t => {
  const { store, root } = await fixture(t); const already = new AbortController(); already.abort();
  await assert.rejects(store.write({ ...input(), signal: already.signal }), hasCode('CANCELLED'));
  assert.deepEqual(await readdir(root), []);
  const beforePublish = new AbortController();
  const restore = interceptOpen((file, handle) => file.startsWith(root) && file.endsWith('.tmp') ? withSync(handle, async () => { await handle.sync(); beforePublish.abort(); }) : handle);
  try { await assert.rejects(store.write({ ...input(), signal: beforePublish.signal }), hasCode('CANCELLED')); }
  finally { restore(); }
  assert.equal(await store.inspect({ taskId: 'task-a' }), undefined);
  assert.deepEqual(await readdir(join(root, 'task-a', 'artifacts')), []);
});

test('cancellation after publication reports unknown and retains the independently inspectable artifact', async t => {
  const { store, root } = await fixture(t); const controller = new AbortController();
  const restore = interceptLink(async (original, source, target) => {
    await original(source, target); if (String(source).startsWith(root)) controller.abort();
  });
  try { await assert.rejects(store.write({ ...input(), signal: controller.signal }), error => error instanceof ArtifactUnknownError && error.outcome === 'unknown'); }
  finally { restore(); }
  assert.equal((await store.inspect({ taskId: 'task-a' }))!.sha256, input().expectedSha256);
  assert.deepEqual(await readdir(join(root, 'task-a', 'artifacts')), ['note.txt']);
});

test('directory fsync failure after publication preserves an unknown result rather than pretending no write occurred', async t => {
  const { store, root } = await fixture(t); let injected = false;
  const restore = interceptOpen((file, handle) => file === join(root, 'task-a', 'artifacts') ? withSync(handle, async () => {
    if (!injected) { injected = true; throw new Error('synthetic directory durability failure'); }
    await handle.sync();
  }) : handle);
  try { await assert.rejects(store.write(input()), error => error instanceof ArtifactUnknownError && error.code === 'RESULT_UNKNOWN'); }
  finally { restore(); }
  assert.equal(injected, true);
  assert.equal((await store.inspect({ taskId: 'task-a' }))!.sha256, input().expectedSha256);
  assert.deepEqual(await readdir(join(root, 'task-a', 'artifacts')), ['note.txt']);
  assert.equal((await store.write(input())).sha256, input().expectedSha256);
});

test('temporary-file durability failure is typed unknown and cleans only the adapter-owned temporary file', async t => {
  const { store, root } = await fixture(t);
  const restore = interceptOpen((file, handle) => file.startsWith(root) && file.endsWith('.tmp') ? withSync(handle, async () => { throw new Error('synthetic temp durability failure'); }) : handle);
  try { await assert.rejects(store.write(input()), error => error instanceof ArtifactUnknownError); }
  finally { restore(); }
  assert.equal(await store.inspect({ taskId: 'task-a' }), undefined);
  assert.deepEqual(await readdir(join(root, 'task-a', 'artifacts')), []);
});

test('an uncertain link result retains the published note and never retries by overwriting it', async t => {
  const { store, root } = await fixture(t);
  const restore = interceptLink(async (original, source, target) => {
    await original(source, target);
    if (String(source).startsWith(root)) throw Object.assign(new Error('synthetic ambiguous link response'), { code: 'EIO' });
  });
  try { await assert.rejects(store.write(input()), error => error instanceof ArtifactUnknownError); }
  finally { restore(); }
  assert.equal((await store.inspect({ taskId: 'task-a' }))!.sha256, input().expectedSha256);
  assert.equal((await store.write(input())).sha256, input().expectedSha256);
});

test('process exit after publication leaves a controlled alias that is observable without mutation and recoverable by same-content retry', async t => {
  const { store, root, target } = await fixture(t); const note = input();
  const source = `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const original=fs.promises.link;
    fs.promises.link=async (...args)=>{await original(...args);process.exit(77);};
    syncBuiltinESMExports();
    const {LocalArtifactStore}=await import(${JSON.stringify(new URL('../src/adapters/artifacts/index.ts', import.meta.url).href)});
    const store=await LocalArtifactStore.open(${JSON.stringify(root)});
    await store.write(${JSON.stringify(note)});
    process.exit(78);
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000, killSignal: 'SIGKILL' });
  let errors = ''; child.stderr.on('data', chunk => { if (errors.length < 4000) errors += String(chunk); });
  const status = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(status, 77, errors);
  const names = await readdir(join(root, 'task-a', 'artifacts'));
  assert.equal(names.length, 2); assert.ok(names.some(name => name.endsWith('.tmp')));
  assert.equal((await lstat(target())).nlink, 2);
  const observed = await store.inspect({ taskId: 'task-a', expectedSha256: note.expectedSha256 });
  assert.equal(observed!.sha256, note.expectedSha256);
  assert.deepEqual(await readdir(join(root, 'task-a', 'artifacts')), names);
  assert.equal((await store.write(note)).sha256, note.expectedSha256);
  assert.equal((await lstat(target())).nlink, 1);
  assert.deepEqual(await readdir(join(root, 'task-a', 'artifacts')), ['note.txt']);
});

test('a recognized same-directory alias does not conceal an extra hard link outside the artifact directory', async t => {
  const { store, root, directory, target } = await fixture(t); await store.write(input());
  await link(target(), join(root, 'task-a', 'artifacts', '.note-00000000-0000-4000-8000-000000000000.tmp'));
  await link(target(), join(directory, 'unaccounted.txt'));
  await assert.rejects(store.inspect({ taskId: 'task-a' }), uncertainBecause('FORBIDDEN_PATH'));
  await assert.rejects(store.write(input()), hasCode('FORBIDDEN_PATH'));
  assert.equal((await lstat(target())).nlink, 3);
});

test('a competing target created at the publication boundary is never overwritten', async t => {
  const { store, root, target } = await fixture(t);
  const restore = interceptLink(async (original, source, destination) => {
    if (String(source).startsWith(root)) await writeFile(destination, 'competing-content', { mode: 0o600, flag: 'wx' });
    await original(source, destination);
  });
  try { await assert.rejects(store.write(input()), hasCode('CONTENT_CONFLICT')); }
  finally { restore(); }
  assert.equal(await readFile(target(), 'utf8'), 'competing-content');
  assert.deepEqual(await readdir(join(root, 'task-a', 'artifacts')), ['note.txt']);
});

test('directory identity changes abort publication and do not clean up an unrelated replacement path', async t => {
  const { directory, store, root } = await fixture(t);
  const outside = join(directory, 'outside'); await mkdir(outside, { mode: 0o700 });
  await writeFile(join(outside, 'note.txt'), 'outside-sentinel', { mode: 0o600 });
  let replaced = false;
  const restore = interceptOpen((file, handle) => file.startsWith(root) && file.endsWith('.tmp') ? withSync(handle, async () => {
    await handle.sync();
    if (!replaced) { replaced = true; await rename(join(root, 'task-a'), join(root, 'moved-task')); await symlink(outside, join(root, 'task-a')); }
  }) : handle);
  try { await assert.rejects(store.write(input()), error => error instanceof ArtifactUnknownError); }
  finally { restore(); }
  assert.equal(await readFile(join(outside, 'note.txt'), 'utf8'), 'outside-sentinel');
  assert.equal((await readdir(join(root, 'moved-task', 'artifacts'))).some(name => name.endsWith('.tmp')), true);
  assert.equal((await readdir(join(root, 'moved-task', 'artifacts'))).includes('note.txt'), false);
});

test('close cancels pending publication, waits for held I/O, and rejects new operations', async t => {
  const { store, root } = await fixture(t);
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const restore = interceptOpen((file, handle) => file.startsWith(root) && file.endsWith('.tmp') ? withSync(handle, async () => { enter(); await gate; await handle.sync(); }) : handle);
  const writing = assert.rejects(store.write(input()), hasCode('CANCELLED'));
  let close: Promise<void> | undefined;
  try {
    await entered; let closed = false; close = store.close().then(() => { closed = true; });
    await assert.rejects(store.inspect({ taskId: 'task-a' }), hasCode('CLOSED'));
    await assert.rejects(store.prepareWorkspace('late'), hasCode('CLOSED'));
    assert.equal(closed, false);
    release(); await writing; await close;
    assert.equal(closed, true);
  } finally { release(); restore(); await writing; await close; }
  const next = await LocalArtifactStore.open(root);
  try { assert.equal(await next.inspect({ taskId: 'task-a' }), undefined); }
  finally { await next.close(); }
});
