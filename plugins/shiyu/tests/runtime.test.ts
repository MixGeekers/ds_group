import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeService } from '../src/runtime.js';
import type { SessionDriver } from '../src/runtime.js';
import { defaultModel } from '../src/adapters/dsh/sessions.js';
import type { DshContext, ReplyRequest, ReplyResult } from '../src/adapters/dsh/sessions.js';
import { readCommand, serveCommand, serveState } from '../src/index.js';

class FakeSessions implements SessionDriver {
  probes = 0; generations = 0; closed = false;
  async initialize() {}
  async probe() { this.probes++; return { ready: true as const, noModelCalled: true as const, sessionId: 'synthetic-probe', tools: [], model: defaultModel('replyer'), released: true as const, archived: true as const }; }
  generateReply(input: ReplyRequest): Promise<ReplyResult> {
    this.generations++;
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new Error('Cancelled synthetic model'));
      if (input.signal?.aborted) abort(); else input.signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async getStatus() { return []; }
  async cancel() {}
  async close() { this.closed = true; }
}
async function fixture(t: any, allowCloseFailure = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiyu-runtime-test-'));
  const fake = new FakeSessions();
  const create = () => new RuntimeService({} as DshContext, { dataDir: directory }, { sessionFactory: () => fake });
  const runtime = create(); await runtime.init();
  t.after(async () => { try { await runtime.close(); } catch (error) { if (!allowCloseFailure) throw error; } finally { await rm(directory, { recursive: true, force: true }); } });
  return { directory, fake, runtime, create };
}

test('dashboard reads never publish, create Sessions or infer; planned systems remain explicit', async t => {
  const { runtime, fake } = await fixture(t);
  const first = await runtime.snapshot();
  for (let i = 0; i < 12; i++) {
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.events.published, first.events.published);
    assert.equal(snapshot.events.pending, 0);
    assert.equal(snapshot.activeWork.length, 0);
    assert.equal(snapshot.usage.inputTokens, null);
    assert.equal(snapshot.usage.cacheReadTokens, null);
    assert.equal(snapshot.systems.length, 9);
    assert.equal(snapshot.systems.find(s => s.id === 'core')?.status, 'planned');
    assert.equal(snapshot.dependencies.find(d => d.id === 'native-session')?.status, 'unknown');
  }
  assert.equal(fake.probes, 0); assert.equal(fake.generations, 0);
});

test('explicit Session probe records evidence without inference and pause survives restart', async t => {
  const { runtime, fake, create } = await fixture(t);
  await runtime.command({ action: 'session.probe' });
  assert.equal(fake.probes, 1); assert.equal(fake.generations, 0);
  assert.equal((await runtime.snapshot()).dependencies.find(d => d.id === 'native-session')?.status, 'available');
  assert.equal((await runtime.snapshot()).dependencies.find(d => d.id === 'model')?.status, 'unknown');
  await runtime.command({ action: 'runtime.pause' });
  await assert.rejects(runtime.command({ action: 'session.probe' }), /paused/);
  await runtime.close();
  const resumed = create(); await resumed.init();
  try {
    assert.equal((await resumed.snapshot()).state, 'paused');
    assert.equal((await resumed.snapshot()).dependencies.find(d => d.id === 'native-session')?.status, 'unknown');
    await assert.rejects(resumed.command({ action: 'reply.generate', businessId: 'demo', prompt: 'test' }), /paused/);
    await resumed.command({ action: 'runtime.resume' });
    assert.equal((await resumed.snapshot()).state, 'idle');
  } finally { await resumed.close(); }
});

test('pause immediately cancels an in-flight reply and releases no draft', async t => {
  const { runtime, fake } = await fixture(t);
  const pending = assert.rejects(runtime.command({ action: 'reply.generate', businessId: 'demo', prompt: 'synthetic input' }), /Cancelled/);
  assert.equal(fake.generations, 1);
  await runtime.command({ action: 'runtime.pause' });
  await pending;
  assert.equal((await runtime.snapshot()).activeWork.length, 0);
  assert.equal((await runtime.snapshot()).state, 'paused');
});

test('concurrent resume then pause cannot reopen work or disagree with durable pause', async t => {
  const { runtime, create } = await fixture(t);
  await runtime.command({ action: 'runtime.pause' });
  const resume = runtime.command({ action: 'runtime.resume' });
  const pause = runtime.command({ action: 'runtime.pause' });
  await Promise.all([resume, pause]);
  assert.equal((await runtime.snapshot()).state, 'paused');
  assert.equal(runtime.state.state.paused, true);
  await assert.rejects(runtime.command({ action: 'session.probe' }), /paused/);
  await runtime.close();
  const fresh = create(); await fresh.init();
  try { assert.equal((await fresh.snapshot()).state, 'paused'); } finally { await fresh.close(); }
});

test('ordered pause then resume opens only after persistence; unload drains accepted controls', async t => {
  const { runtime, create } = await fixture(t);
  await Promise.all([runtime.command({ action: 'runtime.pause' }), runtime.command({ action: 'runtime.resume' })]);
  assert.equal((await runtime.snapshot()).state, 'idle');
  assert.equal(runtime.state.state.paused, false);
  const pause = runtime.command({ action: 'runtime.pause' });
  await Promise.all([pause, runtime.close()]);
  const fresh = create(); await fresh.init();
  try { assert.equal((await fresh.snapshot()).state, 'paused'); } finally { await fresh.close(); }
});

test('unload cancels outstanding inference before releasing state/store ownership', async t => {
  const { runtime, fake, create } = await fixture(t);
  const pending = assert.rejects(runtime.command({ action: 'reply.generate', businessId: 'demo', prompt: 'synthetic input' }), /Cancelled/);
  await runtime.close(); await pending;
  assert.equal(fake.closed, true);
  await assert.rejects(runtime.snapshot(), /stopping/);
  const fresh = create(); await fresh.init(); await fresh.close();
});

test('a failed Session close still waits for outstanding operations before releasing ownership', async t => {
  const { runtime, fake, create } = await fixture(t, true);
  let finish!: () => void;
  fake.generateReply = async () => { await new Promise<void>(resolve => { finish = resolve; }); throw new Error('Synthetic operation ended'); };
  fake.close = async () => { throw new Error('Synthetic dispose failed'); };
  const pending = assert.rejects(runtime.command({ action: 'reply.generate', businessId: 'demo', prompt: 'test' }), /Synthetic operation ended/);
  const closed = assert.rejects(runtime.close(), /Synthetic dispose failed/);
  await assert.rejects(create().init(), /lock|locked/i);
  finish(); await pending; await closed;
  const fresh = create(); await fresh.init();
  fake.close = async () => {};
  await fresh.close();
});

test('an existing live instance prevents second writer; closing releases its lock', async t => {
  const { runtime, create } = await fixture(t);
  await assert.rejects(create().init(), /lock|locked/i);
  await runtime.close();
  const second = create(); await second.init(); await second.close();
});

test('HTTP read is non-mutating; bounded JSON command parser rejects invalid input', async t => {
  const { runtime, fake } = await fixture(t);
  const state = await serveState(runtime);
  assert.equal(state.status, 200); assert.equal(state.headers.get('cache-control'), 'no-store');
  assert.equal(fake.probes, 0);
  const post = (body: string, contentType = 'application/json') => new Request('http://local.test/api/shiyu/commands', { method: 'POST', headers: { 'content-type': contentType }, body });
  await assert.rejects(readCommand(post('{}', 'text/plain')), /application\/json/);
  await assert.rejects(readCommand(post('x'.repeat(65537))), /64 KiB/);
  const invalid = await serveCommand(runtime, post('{"action":"run_anything"}'));
  assert.equal(invalid.status, 400);
  const probe = await serveCommand(runtime, post('{"action":"session.probe"}'));
  assert.equal(probe.status, 200); assert.equal(fake.probes, 1); assert.equal(fake.generations, 0);
});
