/**
 * H1 concurrency / race cases.
 *
 * Spec: DSH交接 03 §5 rows 3 and 6.6 ("读取中/EOF后/投影中追加；同长度早段变化、
 * 缩短 → 被检测变化拒绝或按明确受信规则重取；不默默拼成混合历史") and 03 §3
 * ("两遍相同完整读取能够发现观察期间的许多改写，但不是任意外写者条件下的原子
 * 快照。使用官方append-only合同及独占业务操作，并明确每次观察/使用的边界").
 *
 * A race case passes when the product either rejects with a clean diagnosable
 * error (handle released) or re-reads and returns exactly the final coherent
 * cut. Accepting a stale/mixed cut fails.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHistory, NativeWorld, userMessage } from './support/world.js';
import { cold, judgeRejection, judgeRace, timeout } from './support/harness.js';
import { loadColdSeam, resolveLimits } from './support/seam.js';
import { verifyCase } from './support/evidence.js';

const seam = await loadColdSeam();
const limits = resolveLimits(seam.limits);

test('R01 append between pages is not silently accepted as a mixed history', async () => {
  const c = verifyCase({ id: 'R01', title: 'append between pages', spec: ['03 §5 row3', '03 §3 two passes'], expectation: 'a foreign append observed mid-read either rejects or is re-read into the final coherent cut' });
  const history = buildHistory({ length: 600 });
  let appended = false;
  const w = new NativeWorld({
    sessionId: 'shiyu-verify-append-midread', events: history.events, pageCap: 64,
    afterRead: (world, readIndex) => {
      if (readIndex === 2 && !appended) { appended = true; world.appendUserMessage('foreign append between pages', 'foreign-append-1'); }
    },
  });
  const outcome = await cold(seam, w);
  judgeRace(c, seam, w, outcome, { leakCanaries: ['foreign append between pages'] });
  assert.equal(appended, true, 'injection must have fired');
});

test('R02 inbox insertion between pages is projected from the final cut', async () => {
  const c = verifyCase({ id: 'R02', title: 'inbox insert between pages', spec: ['03 §5 row1/row3'], expectation: 'a pending inbox insertion observed mid-read either rejects or is projected from the final coherent cut exactly once' });
  const history = buildHistory({ length: 600 });
  let inserted = false;
  const w = new NativeWorld({
    sessionId: 'shiyu-verify-inbox-midread', events: history.events, pageCap: 64,
    afterRead: (world, readIndex) => {
      if (readIndex === 2 && !inserted) { inserted = true; world.insertInboxMessage(userMessage('mid-read pending', 'mid-read-pending-1')); }
    },
  });
  const outcome = await cold(seam, w);
  judgeRace(c, seam, w, outcome, { leakCanaries: ['mid-read pending'] });
  assert.equal(inserted, true, 'injection must have fired');
});

test('R03 inbox removal between pages is reflected exactly once', async () => {
  const c = verifyCase({ id: 'R03', title: 'inbox removal between pages', spec: ['03 §5 row1/row3'], expectation: 'a pending input removed mid-read is absent from the verified final projection (no resurrection)' });
  const message = userMessage('to be removed', 'removed-pending-1');
  const history = buildHistory({ length: 600 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-inbox-remove', events: history.events, pageCap: 64 });
  w.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] });
  let removed = false;
  (w.options as any).afterRead = (world: NativeWorld, readIndex: number) => {
    if (readIndex === 2 && !removed) {
      removed = true;
      world.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' });
    }
  };
  const outcome = await cold(seam, w);
  judgeRace(c, seam, w, outcome);
  assert.equal(removed, true, 'injection must have fired');
});

test('R04 same-length early rewrite during the first pass is detected or re-read', async () => {
  const c = verifyCase({ id: 'R04', title: 'same-length early rewrite', spec: ['03 §5 row3', '03 §3'], expectation: 'a same-length rewrite of an already-observed early event must not yield a stale/mixed accepted projection' });
  const history = buildHistory({ length: 400 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-rewrite', events: history.events, pageCap: 32 });
  // Replace one early event with an inbox splice whose content the writer later rewrites (same length).
  w.rewriteEvent(3, { target: 'next-turn', start: 0, removedCount: 0, inserted: [userMessage('first version pending', 'pending-first-version')] });
  // NOTE: rewriting the durable log is only a synthetic foreign-writer model; no real SDK call is made.
  let offsetZeroReads = 0;
  (w.options as any).afterRead = (world: NativeWorld, _readIndex: number, offset: number) => {
    if (offset !== 0) return;
    offsetZeroReads++;
    if (offsetZeroReads === 1) {
      world.rewriteEvent(3, { target: 'next-turn', start: 0, removedCount: 0, inserted: [userMessage('second version pending', 'pending-second-version')] });
    }
  };
  const outcome = await cold(seam, w);
  judgeRace(c, seam, w, outcome);
});

test('R05 append after an observed EOF is detected or re-read', async () => {
  const c = verifyCase({ id: 'R05', title: 'append after EOF', spec: ['03 §5 row3', '03 §3 EOF'], expectation: 'an append after a first-pass EOF is never accepted as if the earlier cut were current' });
  const history = buildHistory({ length: 300 });
  let appended = false;
  const w = new NativeWorld({
    sessionId: 'shiyu-verify-eof-append', events: history.events, pageCap: 64,
    afterRead: (world, _readIndex, _offset, _requested, snapshot) => {
      if (!appended && snapshot.events.length === 0) { appended = true; world.appendUserMessage('post-EOF append', 'post-eof-append-1'); }
    },
  });
  const outcome = await cold(seam, w);
  judgeRace(c, seam, w, outcome, { leakCanaries: ['post-EOF append'] });
  assert.equal(appended, true, 'EOF injection must have fired');
});

test('R06 append during the official projection is detected or re-read', async () => {
  const c = verifyCase({ id: 'R06', title: 'append during projection', spec: ['03 §5 row3'], expectation: 'a write that lands while the projector runs must not be silently dropped from the accepted cut' });
  const history = buildHistory({ length: 300 });
  const w = new NativeWorld({
    sessionId: 'shiyu-verify-projection-append', events: history.events, pageCap: 64,
    duringRestore: world => { world.appendUserMessage('during projection append', 'during-projection-1'); },
  });
  const outcome = await cold(seam, w);
  judgeRace(c, seam, w, outcome, { leakCanaries: ['during projection append'] });
  assert.equal(w.restoreCalls.length >= 1, true, 'projector must have been reached');
});

test('R07 log shrink observed after a read rejects (no mixed history)', async () => {
  const c = verifyCase({ id: 'R07', title: 'shrinking log', spec: ['03 §5 row3', 'session-persistence monotonic read contract'], expectation: 'a stored log that shrank below the observed prefix must reject, never return a silently shortened/mixed history' });
  const history = buildHistory({ length: 800 });
  const w = new NativeWorld({
    sessionId: 'shiyu-verify-shrink', events: history.events, pageCap: 64,
    afterRead: (world, readIndex) => { if (readIndex === 2) world.truncate(20); },
  });
  judgeRejection(c, w, await cold(seam, w));
});

test('R08 cancel during a native read rejects without orphaning the handle', async () => {
  const c = verifyCase({ id: 'R08', title: 'cancel during read', spec: ['03 §5 last row', '03 §4.1'], expectation: 'cooperative cancellation rejects with a diagnosable error, releases the handle and posts no acceptance receipt' });
  const controller = new AbortController();
  const history = buildHistory({ length: 3000 });
  const w = new NativeWorld({
    sessionId: 'shiyu-verify-cancel', events: history.events, pageCap: 50,
    afterRead: (_world, readIndex) => { if (readIndex === 2) controller.abort(new Error('verification cancels the cold read')); },
  });
  const outcome = await Promise.race([cold(seam, w, { signal: controller.signal }), timeout(20_000)]);
  judgeRejection(c, w, outcome as any, { note: 'cancellation is cooperative in the frozen SDK; the check is "rejects and releases", not a hard realtime bound' });
});

test('R09 already-aborted signal opens no native handle', async () => {
  const c = verifyCase({ id: 'R09', title: 'pre-aborted signal', spec: ['03 §4.1'], expectation: 'an aborted caller signal rejects before any read/acceptance receipt' });
  const history = buildHistory({ length: 20 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-preabort', events: history.events });
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  const outcome = await cold(seam, w, { signal: controller.signal });
  if (outcome.error === undefined) {
    c.fail('an already-aborted signal was accepted and produced a result', { result: JSON.stringify(outcome.result)?.slice(0, 300) });
    assert.fail('an already-aborted signal was accepted');
  }
  judgeRejection(c, w, outcome);
});

test('R11 an absolute caller deadline option rejects promptly without waiting for the fixed timeout', async () => {
  const c = verifyCase({ id: 'R11', title: 'absolute deadline option', spec: ['03 §4.1 native deadlines', '03 §2'], expectation: 'a supplied absolute deadlineAtMs shortens recovery and rejects with a deadline error, releasing the handle' });
  const history = buildHistory({ length: 500 });
  const w = new NativeWorld({
    sessionId: 'shiyu-verify-deadline-option', events: history.events, pageCap: 64,
    readDelayMsAt: new Map([[1, 5000]]),
  });
  const started = Date.now();
  const outcome = await Promise.race([cold(seam, w, { options: { deadlineAtMs: Date.now() + 60 } }), timeout(15_000)]);
  const elapsed = Date.now() - started;
  if (outcome.error === undefined) { c.fail('absolute deadline option was not enforced'); assert.fail('deadline option not enforced'); }
  assert.ok(elapsed < 4000, `deadline option rejection took ${elapsed}ms (fixed timeout is ${String(limits.timeoutMs)})`);
  judgeRejection(c, w, outcome as any, { note: `deadlineAtMs=+60ms honoured in ${elapsed}ms` });
});

test('R12 an already-expired absolute deadline rejects before opening a handle', async () => {
  const c = verifyCase({ id: 'R12', title: 'expired deadline option', spec: ['03 §4.1'], expectation: 'an absolute deadline in the past rejects without opening/using a native handle or accepting a projection' });
  const history = buildHistory({ length: 50 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-deadline-expired', events: history.events });
  const outcome = await cold(seam, w, { options: { deadlineAtMs: Date.now() - 1 } });
  if (outcome.error === undefined) { c.fail('an expired absolute deadline was accepted'); assert.fail('expired deadline accepted'); }
  const judged = judgeRejection(c, w, outcome);
  assert.equal(w.handleStats.opens, 0);
  void judged;
});

test('R10 internal recovery deadline rejects instead of hanging', async () => {
  const c = verifyCase({ id: 'R10', title: 'recovery deadline', spec: ['03 §4.1 cancellation/deadline', '03 §2 default 10s collaborative deadline'], expectation: 'an exceeded recovery deadline rejects with a diagnosable error and releases the handle' });
  if (limits.timeoutMs === undefined) {
    c.blocked(`no resolvable recovery timeout in the public seam (raw limits: ${JSON.stringify(seam.rawLimits)})`, { exports: seam.exportNames });
    return;
  }
  const history = buildHistory({ length: 500 });
  const w = new NativeWorld({
    sessionId: 'shiyu-verify-deadline', events: history.events, pageCap: 64,
    readDelayMsAt: new Map([[1, limits.timeoutMs + 400]]),
  });
  const started = Date.now();
  const outcome = await Promise.race([cold(seam, w), timeout(limits.timeoutMs + 10_000)]);
  const elapsed = Date.now() - started;
  if (outcome.error === undefined) {
    c.fail(`slow read beyond the ${limits.timeoutMs}ms deadline was accepted (elapsed=${elapsed}ms)`, { elapsedMs: elapsed });
    assert.fail('deadline was not enforced');
  }
  assert.ok(elapsed < limits.timeoutMs + 8_000, `deadline rejection took ${elapsed}ms, expected near ${limits.timeoutMs}ms`);
  judgeRejection(c, w, outcome as any, { note: `observe timeoutMs=${limits.timeoutMs}ms, elapsed=${elapsed}ms` });
});
