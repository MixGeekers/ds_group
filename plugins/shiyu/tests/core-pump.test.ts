import assert from 'node:assert/strict';
import test from 'node:test';
import { CorePump, type CoreFactBatch } from '../src/control/core-pump.js';

// Pure scheduler tests. These ports stand in for the durable domain/service;
// they never claim to prove SQLite atomicity or native model execution.
const empty = (): CoreFactBatch => ({ claimed: 0, processed: 0, failed: 0 });
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Core pump fixture timed out')), 1500); })]); }
  finally { clearTimeout(timer); }
}
const quiet = { intervalMs: 60000, minTickMs: 10 };

test('no fact port means no fabricated delivery statistics and idle durable pending means zero evaluations', async () => {
  let pending = 0, evaluations = 0;
  const pump = new CorePump({ ...quiet, pending: async () => { pending++; return false; }, evaluatePending: async () => { evaluations++; return { status: 'evaluated' }; } });
  try {
    await pump.wake(); assert.equal(pending, 0);
    await pump.start(); await pump.start();
    for (let i = 0; i < 100; i++) { const snapshot = pump.snapshot(); snapshot.state = 'stopped'; }
    assert.equal(pending, 1); assert.equal(evaluations, 0); assert.equal(pump.snapshot().state, 'idle');
    assert.equal(pump.snapshot().lastFactBatch, undefined); assert.equal(pump.snapshot().lastEvaluation, undefined);
  } finally { await pump.close(); }
});

test('concurrent wakes coalesce with one in-flight fact/evaluation chain and a later scan', async () => {
  const entered = gate(), release = gate(), rescanned = gate(); let scans = 0, active = 0, maximum = 0, calls = 0;
  const pump = new CorePump({ ...quiet, consumeFacts: async () => {
    scans++; active++; maximum = Math.max(maximum, active);
    if (scans === 1) { entered.resolve(); await release.promise; } else rescanned.resolve();
    active--; return empty();
  }, pending: async () => false, evaluatePending: async () => { calls++; return { status: 'evaluated' }; } });
  try {
    const start = pump.start(); await bounded(entered.promise);
    const wakes = Array.from({ length: 100 }, () => pump.wake());
    assert.equal(scans, 1); release.resolve(); await Promise.all([start, ...wakes]); await bounded(rescanned.promise);
    assert.equal(maximum, 1); assert.equal(scans, 2); assert.equal(calls, 0);
  } finally { release.resolve(); await pump.close(); }
});

test('a wake at the asynchronous scan tail remains visible without waiting for the periodic interval', async () => {
  const rescanned = gate(); let scans = 0;
  const pump = new CorePump({ ...quiet, pending: async () => {
    if (++scans === 1) queueMicrotask(() => queueMicrotask(() => { void pump.wake(); })); else rescanned.resolve();
    return false;
  }, evaluatePending: async () => { throw new Error('No eligible work'); } });
  try { await pump.start(); await bounded(rescanned.promise); assert.equal(scans, 2); }
  finally { await pump.close(); }
});

test('fact and evaluation batch limits stop one wake without recursively draining a permanently ready queue', async () => {
  let facts = 0, evaluations = 0;
  const pump = new CorePump({ ...quiet, batchSize: 3, maxFactBatchesPerWake: 2, maxEvaluationsPerWake: 2,
    consumeFacts: async limit => { assert.equal(limit, 3); facts++; return { claimed: 3, processed: 3, failed: 0, privateBody: 'Not dashboard metadata' }; },
    pending: async () => true, evaluatePending: async () => { evaluations++; return { status: 'evaluated', decisionId: `decision-${evaluations}` }; } });
  try {
    await pump.start(); await delay(30); assert.equal(facts, 2); assert.equal(evaluations, 2);
    assert.equal(pump.snapshot().lastEvaluation!.decisionId, 'decision-2');
    assert.deepEqual(pump.snapshot().lastFactBatch, { claimed: 3, processed: 3, failed: 0 });
  } finally { await pump.close(); }
});

test('explicit wake floods cannot bypass the minimum tick or create overlapping evaluations', async () => {
  const second = gate(); const starts: number[] = [];
  const pump = new CorePump({ intervalMs: 60000, minTickMs: 60, pending: async () => true,
    evaluatePending: async () => { starts.push(performance.now()); if (starts.length === 2) second.resolve(); return { status: 'evaluated' }; } });
  try {
    await pump.start(); await Promise.all(Array.from({ length: 100 }, () => pump.wake())); assert.equal(starts.length, 1);
    await bounded(second.promise); assert.ok(starts[1]! - starts[0]! >= 45); assert.equal(starts.length, 2);
  } finally { await pump.close(); }
});

test('failed fact receipts stop before evaluation and a later successful fact scan clears only that failure', async () => {
  let failed = true, evaluations = 0;
  const pump = new CorePump({ ...quiet, consumeFacts: async () => failed ? { claimed: 2, processed: 1, failed: 1 } : empty(),
    pending: async () => false, evaluatePending: async () => { evaluations++; return { status: 'evaluated' }; } });
  try {
    await pump.start(); assert.equal(pump.snapshot().state, 'degraded'); assert.equal(evaluations, 0);
    failed = false; await delay(12); await pump.wake(); assert.equal(pump.snapshot().state, 'idle'); assert.equal(evaluations, 0);
  } finally { await pump.close(); }
});

test('invalid fact or pending receipts fail closed before any evaluation', async () => {
  for (const facts of [true, false]) {
    let evaluations = 0;
    const pump = new CorePump({ ...quiet, ...(facts ? { consumeFacts: async () => ({ claimed: 2, processed: 1, failed: 0 }) } : {}),
      pending: async () => 'true' as unknown as boolean, evaluatePending: async () => { evaluations++; return { status: 'evaluated' }; } });
    try { await pump.start(); assert.equal(evaluations, 0); assert.equal(pump.snapshot().state, 'degraded'); assert.match(pump.snapshot().lastFailure!, /Invalid core/); }
    finally { await pump.close(); }
  }
});

test('unknown is not requeued by wake, retryAt or periodic scans and unrelated eligible work can still proceed', async () => {
  let eligible = true, calls = 0, facts = 0;
  const scanned = gate();
  const pump = new CorePump({ intervalMs: 15, minTickMs: 10, consumeFacts: async () => { if (++facts >= 4) scanned.resolve(); return empty(); },
    pending: async () => eligible, evaluatePending: async () => {
      calls++; eligible = false; // The durable domain keeps the uncertain round held.
      return calls === 1 ? { status: 'unknown', goalId: 'goal-unknown', retryAt: '2020-01-01T00:00:00.000Z' }
        : { status: 'evaluated', goalId: 'another-goal', decisionId: 'decision-2' };
    } });
  try {
    await pump.start(); await Promise.all(Array.from({ length: 20 }, () => pump.wake())); await bounded(scanned.promise);
    assert.equal(calls, 1); assert.equal(pump.snapshot().lastEvaluation!.status, 'unknown'); assert.equal(pump.snapshot().state, 'degraded');
    eligible = true; await delay(12); await pump.wake();
    assert.equal(calls, 2); assert.equal(pump.snapshot().lastEvaluation!.goalId, 'another-goal');
    assert.equal(pump.snapshot().lastUncertainty!.goalId, 'goal-unknown'); assert.equal(pump.snapshot().state, 'idle');
  } finally { await pump.close(); }
});

test('synchronous and asynchronous service failures do not recreate a claimed round', async () => {
  for (const synchronous of [true, false]) {
    let eligible = true, calls = 0;
    const perform = () => { calls++; eligible = false; if (synchronous) throw new Error('Synthetic dispatch unknown'); return Promise.reject(new Error('Synthetic dispatch unknown')); };
    const pump = new CorePump({ ...quiet, pending: async () => eligible, evaluatePending: perform });
    try {
      await pump.start(); assert.equal(pump.snapshot().state, 'degraded'); assert.match(pump.snapshot().lastFailure!, /dispatch unknown/);
      await delay(12); await pump.wake(); assert.equal(calls, 1); assert.equal(pump.snapshot().state, 'degraded');
    } finally { await pump.close(); }
  }
});

test('deferred service gate stops the batch, and pause between pending and dispatch cannot be bypassed', async () => {
  let paused = false, calls = 0, modelCalls = 0;
  const pump = new CorePump({ ...quiet, maxEvaluationsPerWake: 4, pending: async () => { paused = true; return true; },
    evaluatePending: async () => { calls++; if (paused) return { status: 'deferred' }; modelCalls++; return { status: 'evaluated' }; } });
  try { await pump.start(); assert.equal(calls, 1); assert.equal(modelCalls, 0); assert.equal(pump.snapshot().lastEvaluation!.status, 'deferred'); }
  finally { await pump.close(); }
});

test('cancelEvaluation aborts current evaluation but permits later pure fact scans under the persistent pause gate', async () => {
  const entered = gate(), release = gate(); let signal!: AbortSignal, paused = false, facts = 0, calls = 0;
  const pump = new CorePump({ ...quiet, consumeFacts: async () => { facts++; return empty(); }, pending: async () => !paused,
    evaluatePending: async input => { calls++; signal = input.signal; entered.resolve(); await release.promise; signal.throwIfAborted(); return { status: 'evaluated' }; } });
  try {
    const start = pump.start(); await bounded(entered.promise); paused = true; pump.cancelEvaluation(new Error('Paused by owner'));
    assert.equal(signal.aborted, true); assert.ok(pump.snapshot().lastCancellationAt); release.resolve(); await start;
    await delay(12); await pump.wake(); assert.equal(calls, 1); assert.equal(facts, 2); assert.equal(pump.snapshot().state, 'idle');
  } finally { release.resolve(); await pump.close(); }
});

test('close during facts drains their durable consumption and never enters pending or evaluation afterwards', async () => {
  const entered = gate(), release = gate(); let pending = 0;
  const pump = new CorePump({ intervalMs: 10, minTickMs: 10, consumeFacts: async () => { entered.resolve(); await release.promise; return empty(); },
    pending: async () => { pending++; return true; }, evaluatePending: async () => { throw new Error('Closed pump evaluated'); } });
  try {
    const start = pump.start(); await bounded(entered.promise); let closed = false;
    const closing = pump.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
    await pump.wake(); release.resolve(); await Promise.all([start, closing]); await delay(25);
    assert.equal(pending, 0); assert.equal(pump.snapshot().state, 'stopped'); await assert.rejects(pump.start(), /closed/);
  } finally { release.resolve(); await pump.close(); }
});

test('close aborts before draining a slow evaluation and preserves late uncertainty without starting another round', async () => {
  const entered = gate(), release = gate(); let calls = 0, signal!: AbortSignal;
  const pump = new CorePump({ intervalMs: 10, minTickMs: 10, maxEvaluationsPerWake: 4, pending: async () => true,
    evaluatePending: async input => { calls++; signal = input.signal; entered.resolve(); await release.promise; return { status: 'unknown', goalId: 'late-goal' }; } });
  try {
    const start = pump.start(); await bounded(entered.promise); const closing = pump.close(); assert.equal(pump.close(), closing);
    assert.equal(signal.aborted, true); let done = false; void closing.then(() => { done = true; }); await tick(); assert.equal(done, false);
    await pump.wake(); release.resolve(); await Promise.all([start, closing]); await delay(25);
    assert.equal(calls, 1); assert.equal(pump.snapshot().state, 'stopped'); assert.equal(pump.snapshot().lastUncertainty!.goalId, 'late-goal');
  } finally { release.resolve(); await pump.close(); }
});

test('malformed evaluation receipt remains degraded rather than counted as a valid decision', async () => {
  const pump = new CorePump({ ...quiet, pending: async () => true, evaluatePending: async () => ({ status: 'completed' } as never) });
  try { await pump.start(); assert.equal(pump.snapshot().lastEvaluation, undefined); assert.match(pump.snapshot().lastFailure!, /Invalid core evaluation/); }
  finally { await pump.close(); }
});

test('configuration bounds reject spinning intervals and invalid batch ceilings', () => {
  for (const patch of [{ intervalMs: 0 }, { minTickMs: 0 }, { intervalMs: 10, minTickMs: 11 }, { batchSize: 101 }, { maxFactBatchesPerWake: 11 }, { maxEvaluationsPerWake: 5 }]) {
    assert.throws(() => new CorePump({ pending: async () => false, evaluatePending: async () => ({ status: 'idle' }), ...patch }), /Invalid bounded/);
  }
});

test('a plan revision receipt is surfaced only with a positive bounded revision and invalid values degrade the pump', async () => {
  let evaluations = 0;
  const pump = new CorePump({ ...quiet, pending: async () => true,
    evaluatePending: async () => { evaluations++; return { status: 'evaluated', goalId: 'core-goal', decisionId: 'proposal:route', planVersion: 3 }; } });
  try {
    await pump.start();
    assert.equal(evaluations, 1);
    assert.equal(pump.snapshot().lastEvaluation!.planVersion, 3);
    assert.equal(pump.snapshot().state, 'idle');
  } finally { await pump.close(); }
  let invalidEvaluations = 0;
  const invalid = new CorePump({ ...quiet, pending: async () => true,
    evaluatePending: async () => { invalidEvaluations++; return { status: 'evaluated', planVersion: 0 } as never; } });
  try {
    await invalid.start();
    assert.equal(invalidEvaluations, 1);
    assert.equal(invalid.snapshot().state, 'degraded');
    assert.match(invalid.snapshot().lastFailure!, /Invalid core evaluation receipt/);
  } finally { await invalid.close(); }
});
