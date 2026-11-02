/**
 * Driver / clock / fault-control unit tests (H0.FAULTS).
 * Real monotonic timers are used only where the observation itself is the
 * subject; ordering and recurrence are driven by the fake business clock
 * instead of sleeps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AbsoluteDeadline,
  BusinessClock,
  DeadlineExceededError,
  FaultInjectedError,
  FaultInjector,
  checkAbortObservation,
  combineAbortSignals,
  waitForAbort,
} from './harness/faults.js';

test('faults:deadline-real-timer', async () => {
  const deadline = new AbsoluteDeadline(15);
  try {
    const start = performance.now();
    const observed = await waitForAbort(deadline.signal, 2000);
    assert.notEqual(observed, null, 'real timer must abort within the guard timeout');
    assert.equal(deadline.reason?.code, 'deadline_exceeded');
    const check = checkAbortObservation({
      signalAborted: true,
      startMs: start,
      deadlineAtMs: deadline.atMs,
      observedAtMs: observed!,
      maxDelayMs: 1000,
      expectedReason: 'deadline_exceeded',
      actualReason: deadline.reason?.code,
    });
    assert.equal(check.ok, true, JSON.stringify(check.violations));
    assert.ok(observed! >= deadline.atMs - 1, 'abort must not be observed before the absolute deadline');
    const error = new DeadlineExceededError(deadline);
    assert.equal(error.code, 'DEADLINE_EXCEEDED');
  } finally {
    deadline.dispose();
  }
});

test('faults:deadline-manual-and-combined-signals', () => {
  let now = 1000;
  const manual = new AbsoluteDeadline(500, { manual: true, now: () => now });
  assert.equal(manual.atMs, 1500);
  assert.equal(manual.remainingMs(), 500);
  now = 1400;
  assert.equal(manual.remainingMs(), 100);
  assert.equal(manual.expired, false);
  now = 1600;
  assert.equal(manual.expired, true, 'expired is derived from the monotonic clock even without a timer');
  assert.equal(manual.signal.aborted, false, 'expiry alone does not fabricate an abort observation');
  manual.expire('trusted_stop', 'owner pressed stop');
  assert.equal(manual.signal.aborted, true);
  assert.equal(manual.reason?.code, 'trusted_stop');
  assert.equal(manual.reason?.detail, 'owner pressed stop');
  const other = new AbortController();
  const combined = combineAbortSignals([manual.signal, other.signal]);
  const second = new AbortController();
  const combined2 = combineAbortSignals([manual.signal, second.signal]);
  second.abort();
  assert.equal(combined2.aborted, true, 'combined signal observes any source abort');
  assert.equal(combined.aborted, true);
  assert.equal(combined.reason instanceof Object, true);
});

test('faults:fault-injector-deterministic-plan', () => {
  const injector = new FaultInjector({ runId: 'run-unit-faults' });
  injector.plan([
    { name: 'second-hit', checkpoint: 'write', at: 2, times: 2, action: 'throw', code: 'WRITE_BROKE' },
    { name: 'never', checkpoint: 'close', action: 'throw' },
  ]);
  assert.equal(injector.checkpoint('write'), 1);
  assert.throws(() => injector.checkpoint('write'), (error: unknown) => error instanceof FaultInjectedError && error.code === 'WRITE_BROKE' && error.ordinal === 2);
  assert.throws(() => injector.checkpoint('write'), (error: unknown) => error instanceof FaultInjectedError && error.ordinal === 3);
  assert.equal(injector.checkpoint('write'), 4, 'fault stops firing after times');
  const firstPass = injector.checkHits();
  assert.equal(firstPass.ok, false, 'planned-but-unhit fault must be reported');
  assert.ok(firstPass.violations.some(item => item.code === 'fault_not_hit'));
  assert.throws(() => injector.checkpoint('close'), (error: unknown) => error instanceof FaultInjectedError && error.faultName === 'never');
  const nowHit = injector.checkHits();
  assert.equal(nowHit.ok, true, JSON.stringify(nowHit.violations));
  assert.equal(injector.hits.length, 3);
  assert.deepEqual(
    injector.hits.map(hit => hit.ordinal),
    [2, 3, 1],
  );
  const expected = injector.checkHits([{ name: 'second-hit', checkpoint: 'write', times: 2 }]);
  assert.equal(expected.ok, false, 'unplanned checkpoint must be detectable when expectations are frozen');
  assert.ok(expected.violations.some(item => item.code === 'unexpected_fault_hit'));
  assert.throws(() => injector.plan([{ name: 'exit-fault', checkpoint: 'crash', action: 'exit' }]), /allowProcessExit/);
});

test('faults:fault-injector-abort-and-guards', () => {
  const injector = new FaultInjector({ runId: 'run-unit-abort' });
  injector.plan([{ name: 'abort-once', checkpoint: 'send', action: 'abort', code: 'SEND_ABORTED' }]);
  injector.checkpoint('send');
  assert.equal(injector.controller.signal.aborted, true);
  const reason = injector.controller.signal.reason as { code?: string; name?: string };
  assert.equal(reason.code, 'SEND_ABORTED');
  assert.equal(reason.name, 'abort-once');
  injector.checkpoint('send');
  const check = injector.checkHits();
  assert.equal(check.ok, true, JSON.stringify(check.violations));
  assert.equal(injector.hits.length, 1);
  assert.throws(() => new FaultInjector({ runId: 'x' }).plan([{ name: 'bad', checkpoint: 'a', at: 0 }]), /at must be >= 1/);
});

test('faults:business-clock-utc-recurrence', () => {
  const clock = new BusinessClock({ start: '2026-11-02T00:00:00.000Z', timeZone: 'UTC' });
  assert.equal(clock.nowIso(), '2026-11-02T00:00:00.000Z');
  assert.deepEqual(clock.localParts(Date.parse('2026-11-02T09:05:00.000Z')), { year: 2026, month: 11, day: 2, hour: 9, minute: 5, second: 0 });
  assert.equal(clock.offsetAt(Date.parse('2026-11-02T09:05:00.000Z')), 0);
  assert.equal(clock.nextOccurrence({ hour: 9, minute: 0 }), Date.parse('2026-11-02T09:00:00.000Z'));
  clock.advanceTo('2026-11-02T09:00:00.000Z');
  assert.equal(clock.nextOccurrence({ hour: 9, minute: 0 }), Date.parse('2026-11-03T09:00:00.000Z'), 'strictly after the current instant');
  const occurrences = clock.occurrencesBetween({ hour: 9, minute: 0 }, Date.parse('2026-11-02T00:00:00.000Z'), Date.parse('2026-11-04T10:00:00.000Z'));
  assert.deepEqual(occurrences, [Date.parse('2026-11-02T09:00:00.000Z'), Date.parse('2026-11-03T09:00:00.000Z'), Date.parse('2026-11-04T09:00:00.000Z')]);
  assert.throws(() => clock.advanceTo('2026-11-01T00:00:00.000Z'), /cannot move backwards/);
  assert.throws(() => clock.advance(-1), /non-negative/);
  assert.throws(() => new BusinessClock({ start: '2026-11-02T00:00:00.000Z', timeZone: 'Not/AZone' }), /unknown time zone/);
  assert.throws(() => clock.nextOccurrence({ hour: 25, minute: 0 }), /invalid hour/);
});

test('faults:business-clock-deterministic-timer-queue', () => {
  const clock = new BusinessClock({ start: '2026-11-02T00:00:00.000Z' });
  const ran: string[] = [];
  const early = clock.schedule(30, 'c', () => ran.push('c'));
  clock.schedule(10, 'a', () => ran.push('a'));
  clock.schedule(20, 'b', () => ran.push('b'));
  assert.equal(clock.pending(), 3);
  const before = clock.runDue();
  assert.equal(before.executed.length, 0, 'fake clock does not advance by itself');
  clock.advance(25);
  const due = clock.due().map(task => task.label);
  assert.deepEqual(due, ['a', 'b']);
  const mid = clock.runDue();
  assert.deepEqual(mid.executed.map(task => task.label), ['a', 'b']);
  assert.equal(clock.pending(), 1);
  clock.advance(5);
  assert.deepEqual(clock.runDue().executed.map(task => task.label), ['c']);
  assert.deepEqual(ran, ['a', 'b', 'c']);
  assert.equal(early.dueMs, Date.parse('2026-11-02T00:00:00.000Z') + 30);
  // Missed occurrences: latest-only policy must report skipped ones explicitly.
  const missed = new BusinessClock({ start: '2026-11-02T00:00:00.000Z' });
  missed.scheduleAt(Date.parse('2026-11-02T09:00:00.000Z'), 'report');
  missed.scheduleAt(Date.parse('2026-11-03T09:00:00.000Z'), 'report');
  missed.scheduleAt(Date.parse('2026-11-04T09:00:00.000Z'), 'report');
  missed.advanceTo('2026-11-04T12:00:00.000Z');
  const latest = missed.runDue({ policy: 'latest-per-label' });
  assert.equal(latest.executed.length, 1);
  assert.equal(latest.skippedMissed.length, 2);
  assert.equal(missed.pending(), 0);
});
