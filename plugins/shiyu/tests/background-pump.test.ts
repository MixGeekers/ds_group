import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundPump } from '../src/control/background-pump.js';

const empty = () => ({ claimed: 0, processed: 0, failed: 0 });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test('background wake-ups coalesce without concurrent consumers and snapshots never consume', async t => {
  const blocked = gate(), entered = gate(); let calls = 0, active = 0, max = 0;
  const pump = new BackgroundPump({ intervalMs: 60000, consume: async () => {
    calls++; active++; max = Math.max(max, active);
    if (calls === 1) { entered.release(); await blocked.promise; }
    active--; return empty();
  } });
  t.after(() => pump.close());
  const starting = pump.start(); await entered.promise;
  const one = pump.wake(), two = pump.wake();
  for (let i = 0; i < 100; i++) assert.equal(pump.snapshot().state, 'running');
  assert.equal(calls, 1); blocked.release(); await Promise.all([starting, one, two]);
  assert.equal(calls, 2); assert.equal(max, 1); assert.equal(pump.snapshot().state, 'idle');
  for (let i = 0; i < 100; i++) pump.snapshot(); assert.equal(calls, 2);
});

test('a busy durable queue is bounded per wake and a failed delivery never spins', async t => {
  let calls = 0, failure = false;
  const pump = new BackgroundPump({ intervalMs: 60000, batchSize: 5, maxBatchesPerWake: 3, consume: async () => {
    calls++; return failure ? { claimed: 5, processed: 4, failed: 1 } : { claimed: 5, processed: 5, failed: 0 };
  } });
  t.after(() => pump.close()); await pump.start(); assert.equal(calls, 3);
  failure = true; await pump.wake(); assert.equal(calls, 4); assert.equal(pump.snapshot().state, 'degraded');
  assert.equal(pump.snapshot().lastBatch?.failed, 1);
});

test('close cancels periodic work, drains the actual in-flight consumer and prevents late wake-ups', async () => {
  const blocked = gate(), entered = gate(); let calls = 0;
  const pump = new BackgroundPump({ intervalMs: 10, consume: async () => { calls++; entered.release(); await blocked.promise; return { claimed: 50, processed: 50, failed: 0 }; } });
  const start = pump.start(); await entered.promise;
  let closed = false; const closing = pump.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  await pump.wake(); assert.equal(calls, 1);
  blocked.release(); await Promise.all([start, closing]);
  assert.equal(pump.snapshot().state, 'stopped'); assert.equal(calls, 1);
  await assert.rejects(pump.start(), /closed/);
});

test('periodic retry recovers an observation failure without a UI request or new in-memory queue', async t => {
  let calls = 0; const retried = gate();
  const pump = new BackgroundPump({ intervalMs: 10, consume: async () => {
    if (++calls === 1) throw new Error('Transient control worker error');
    retried.release(); return empty();
  } });
  t.after(() => pump.close()); await pump.start();
  assert.equal(pump.snapshot().state, 'degraded'); assert.match(pump.snapshot().lastFailure!, /Transient/);
  let timer!: ReturnType<typeof setTimeout>;
  try { await Promise.race([retried.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Background retry did not occur')), 1500); })]); }
  finally { clearTimeout(timer); }
  await pump.close(); assert.ok(calls >= 2); assert.equal(pump.snapshot().lastFailure, undefined);
});

test('an incomplete batch receipt is retained as unconfirmed rather than a successful scan', async t => {
  const pump = new BackgroundPump({ intervalMs: 60000, consume: async () => ({ claimed: 2, processed: 1, failed: 0 }) });
  t.after(() => pump.close()); await pump.start();
  assert.equal(pump.snapshot().state, 'degraded'); assert.match(pump.snapshot().lastFailure!, /Invalid background/);
  assert.equal(pump.snapshot().lastBatch, undefined);
});
