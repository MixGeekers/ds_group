import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { LocalStateFile } from '../src/recovery/local-state.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-state-test-'));
  const state = await LocalStateFile.open(directory);
  t.after(async () => { await state.close(); await rm(directory, { recursive: true, force: true }); });
  const read = async () => JSON.parse(await readFile(join(directory, 'runtime-state.json'), 'utf8'));
  return { directory, state, read };
}

/** The patch is process-local, restored in finally, and limited to this test's temporary path. */
function interceptOpen(intercept: (file: string, flags: string | number | undefined, handle: fs.promises.FileHandle) => fs.promises.FileHandle) {
  const original = fs.promises.open;
  fs.promises.open = async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    return intercept(String(args[0]), args[1], handle);
  };
  syncBuiltinESMExports();
  return () => { fs.promises.open = original; syncBuiltinESMExports(); };
}

function overrideSync(handle: fs.promises.FileHandle, sync: () => Promise<void>): fs.promises.FileHandle {
  return new Proxy(handle, {
    get(target, key) {
      if (key === 'sync') return sync;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('a directory fsync failure after rename freezes writes and preserves the visible pause state', async t => {
  const { state, read } = await fixture(t);
  let injected = false;
  const restore = interceptOpen((file, flags, handle) => {
    if (file !== state.directory || flags !== 'r' || injected) return handle;
    injected = true;
    return overrideSync(handle, async () => { throw new Error('synthetic directory fsync failure'); });
  });
  try {
    await assert.rejects(state.update(value => { value.paused = true; }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /durability is uncertain/);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /synthetic directory fsync/);
      return true;
    });
  } finally { restore(); }
  assert.equal(injected, true);
  assert.equal(state.state.paused, true);
  assert.equal((await read()).paused, true);
  assert.throws(() => state.assertHealthy(), /durability is uncertain/);
  let changed = false;
  await assert.rejects(state.update(value => {
    changed = true;
    value.lastProbe = { at: new Date().toISOString(), ok: true, message: 'unrelated update' };
  }), /durability is uncertain/);
  assert.equal(changed, false);
  assert.equal((await read()).paused, true);
  assert.equal((await read()).lastProbe, undefined);
  assert.equal((await readdir(state.directory)).some(name => name.endsWith('.tmp')), false);
});

test('failure before rename preserves the old state and permits a fresh explicit retry', async t => {
  const { state, read } = await fixture(t);
  let injected = false;
  const restore = interceptOpen((file, flags, handle) => {
    if (!file.startsWith(join(state.directory, 'runtime-state.json.')) || flags !== 'wx' || injected) return handle;
    injected = true;
    return overrideSync(handle, async () => { throw new Error('synthetic temporary file fsync failure'); });
  });
  try { await assert.rejects(state.update(value => { value.paused = true; }), /temporary file fsync failure/); }
  finally { restore(); }
  assert.equal(injected, true);
  assert.equal(state.state.paused, false);
  assert.equal((await read()).paused, false);
  state.assertHealthy();
  await state.update(value => { value.paused = true; });
  assert.equal((await read()).paused, true);
  assert.equal((await readdir(state.directory)).some(name => name.endsWith('.tmp')), false);
});

test('close retains ownership until the pending durable update finishes and rejects late writes', async t => {
  const { directory, state, read } = await fixture(t);
  let signalEntered!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  let releaseWrite!: () => void;
  const gate = new Promise<void>(resolve => { releaseWrite = resolve; });
  let held = false;
  const restore = interceptOpen((file, flags, handle) => {
    if (!file.startsWith(join(state.directory, 'runtime-state.json.')) || flags !== 'wx' || held) return handle;
    held = true;
    return overrideSync(handle, async () => { signalEntered(); await gate; await handle.sync(); });
  });
  const writing = state.update(value => { value.paused = true; });
  let closing: Promise<void> | undefined;
  try {
    await entered;
    let closed = false;
    closing = state.close().then(() => { closed = true; });
    const lateWrite = assert.rejects(state.update(value => { value.paused = false; }), /closed/);
    await assert.rejects(LocalStateFile.open(directory), /lock|locked/i);
    assert.equal(closed, false);
    releaseWrite();
    await writing; await closing; await lateWrite;
    assert.equal((await read()).paused, true);
    await assert.rejects(state.update(value => { value.paused = false; }), /closed/);
    const reopened = await LocalStateFile.open(directory);
    try { assert.equal(reopened.state.paused, true); }
    finally { await reopened.close(); }
  } finally {
    releaseWrite(); restore();
    await writing.catch(() => undefined); await closing;
  }
});
