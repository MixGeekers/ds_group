/**
 * Fault injection, absolute deadlines, deterministic abort signals and a
 * fake business clock.
 *
 * Design rules taken from 02 §1–§3:
 * - blocking is explicit (named checkpoints / scheduled instants), no
 *   `sleep` is used to guess a race;
 * - a fault hit is recorded with checkpoint, ordinal and monotonic time so
 *   the injection location is provable;
 * - deadlines use a real monotonic clock and AbortSignal, while business
 *   recurrence uses an injectable fake clock that can cross DST and missed
 *   occurrences deterministically;
 * - crash faults can terminate a real child process so the observer ledger
 *   and real temporary SQLite survive and can be audited after the crash.
 *
 * Boundary: the fake clock is not a real 7-day run; an aborted signal proves
 * the stop was requested/observed, not that every in-flight external effect
 * has stopped. Hash/in-memory evidence is integrity-oriented, not a
 * cryptographic attestation.
 */
import { performance } from 'node:perf_hooks';
import type { CheckResult, JsonValue, OracleSelfProof, Violation } from './invariant.js';
import { finish, violation } from './invariant.js';
import { checkOccurrenceAccounting } from './counts.js';

/* ------------------------------------------------------------------ */
/* Abort reasons / deadlines.                                          */
/* ------------------------------------------------------------------ */

export type AbortReasonCode = 'deadline_exceeded' | 'trusted_stop' | 'superseded' | 'session_epoch_changed' | 'fault_injected';

export interface HarnessAbortReason {
  readonly code: AbortReasonCode;
  readonly detail?: string;
  readonly atMs: number;
}

export class DeadlineExceededError extends Error {
  readonly code = 'DEADLINE_EXCEEDED';
  readonly deadline: AbsoluteDeadline;

  constructor(deadline: AbsoluteDeadline) {
    super(`deadline exceeded after ${deadline.elapsedMs().toFixed(1)}ms`);
    this.name = 'DeadlineExceededError';
    this.deadline = deadline;
  }
}

export interface DeadlineOptions {
  /** Monotonic clock in milliseconds. Defaults to performance.now(). */
  readonly now?: () => number;
  /** Manual deadline: no timer is armed; call `expire()` explicitly. */
  readonly manual?: boolean;
  readonly reason?: AbortReasonCode;
  readonly detail?: string;
}

/**
 * An absolute deadline expressed on a monotonic clock, paired with an
 * AbortSignal. The same object answers "remaining time", "has expired" and
 * "what reason aborted it" so evidence can distinguish a deadline from a
 * trusted stop.
 */
export class AbsoluteDeadline {
  readonly atMs: number;
  readonly startMs: number;
  readonly signal: AbortSignal;
  readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout | undefined;
  private abortReason: HarnessAbortReason | undefined;

  constructor(ms: number, options: DeadlineOptions = {}) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`deadline must be a finite non-negative number, got ${String(ms)}`);
    this.now = options.now ?? (() => performance.now());
    this.startMs = this.now();
    this.atMs = this.startMs + ms;
    this.signal = this.controller.signal;
    if (options.manual !== true) {
      this.timer = setTimeout(() => this.expire(options.reason ?? 'deadline_exceeded', options.detail), ms);
    }
  }

  elapsedMs(): number {
    return this.now() - this.startMs;
  }

  remainingMs(): number {
    return Math.max(0, this.atMs - this.now());
  }

  get expired(): boolean {
    return this.signal.aborted || this.now() >= this.atMs;
  }

  get reason(): HarnessAbortReason | undefined {
    return this.abortReason;
  }

  expire(reason: AbortReasonCode = 'deadline_exceeded', detail?: string): void {
    if (this.signal.aborted) return;
    this.abortReason = detail === undefined ? { code: reason, atMs: this.now() } : { code: reason, detail, atMs: this.now() };
    this.controller.abort(this.abortReason);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}

/** AbortSignal.any wrapper that documents the tested Node baseline. */
export function combineAbortSignals(signals: readonly AbortSignal[]): AbortSignal {
  return AbortSignal.any([...signals]);
}

export interface AbortObservationInput {
  readonly signalAborted: boolean;
  readonly startMs?: number;
  readonly deadlineAtMs?: number;
  readonly observedAtMs?: number;
  readonly maxDelayMs?: number;
  readonly expectedReason?: AbortReasonCode;
  readonly actualReason?: AbortReasonCode | string;
}

/**
 * Judge an observed abort timing without sleeping: the caller passes the
 * monotonic timestamps it actually observed. A missing timestamp is
 * undecidable, not "on time".
 */
export function checkAbortObservation(input: AbortObservationInput): CheckResult {
  const violations: Violation[] = [];
  const maxDelayMs = input.maxDelayMs ?? 1000;
  if (!input.signalAborted) {
    violations.push(violation('abort_not_observed', '$', 'signal was not aborted; a requested stop is not a stop proof'));
  }
  if (input.startMs === undefined || input.deadlineAtMs === undefined || input.observedAtMs === undefined) {
    violations.push(violation('observation_incomplete', '$', 'start/deadline/observed timestamps are required to judge timing'));
    return finish({ oracle: 'deadline', version: '1.1.0', boundary: ABORT_BOUNDARY, scope: 'abort-observation' }, 1, violations);
  }
  if (input.deadlineAtMs < input.startMs) {
    violations.push(violation('deadline_before_start', '$', 'deadline precedes start; observation is inconsistent'));
  }
  if (input.observedAtMs < input.startMs) {
    violations.push(violation('observation_before_start', '$', 'abort observed before start'));
  }
  if (input.expectedReason !== undefined && input.actualReason !== input.expectedReason) {
    violations.push(
      violation('wrong_abort_reason', '$', `expected reason ${input.expectedReason}, observed ${String(input.actualReason)}`, {
        expected: input.expectedReason,
        actual: input.actualReason ?? null,
      }),
    );
  }
  const earlyToleranceMs = (input as AbortObservationInput & { earlyToleranceMs?: number }).earlyToleranceMs ?? 5;
  if (input.signalAborted && input.observedAtMs < input.deadlineAtMs - earlyToleranceMs) {
    violations.push(
      violation('abort_before_deadline', '$', `signal aborted ${(input.deadlineAtMs - input.observedAtMs).toFixed(1)}ms before the absolute deadline (tolerance ${earlyToleranceMs}ms)`),
    );
  }
  if (input.signalAborted && input.observedAtMs > input.deadlineAtMs + maxDelayMs) {
    violations.push(
      violation('late_abort', '$', `abort observed ${(input.observedAtMs - input.deadlineAtMs).toFixed(1)}ms after deadline (max ${maxDelayMs}ms)`),
    );
  }
  const delay = input.observedAtMs - input.deadlineAtMs;
  return finish({ oracle: 'deadline', version: '1.1.0', boundary: ABORT_BOUNDARY, scope: 'abort-observation' }, 4, violations, {
    delayFromDeadlineMs: delay,
    maxDelayMs,
  });
}

const ABORT_BOUNDARY =
  '按调用方用真实单调时钟记录的 start/deadline/observed 时间戳判定：必须观察到 abort、原因匹配、不得早于期限、不得晚于 maxDelayMs。' +
  '不证明在途外部效果已停止，也不使用 sleep 猜测竞态。';

/** Await the next abort, returning the monotonic observation time (or null on guard timeout). */
export function waitForAbort(signal: AbortSignal, guardTimeoutMs = 5000): Promise<number | null> {
  if (signal.aborted) return Promise.resolve(performance.now());
  return new Promise(resolve => {
    let settled = false;
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, guardTimeoutMs);
    signal.addEventListener(
      'abort',
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        resolve(performance.now());
      },
      { once: true },
    );
  });
}

/* ------------------------------------------------------------------ */
/* Fake business clock.                                                */
/* ------------------------------------------------------------------ */

export interface DailyAt {
  readonly hour: number;
  readonly minute: number;
  readonly second?: number;
}

export interface ScheduledTask {
  readonly id: number;
  readonly label: string;
  readonly dueMs: number;
  readonly run?: () => void;
}

export interface RunDueResult {
  readonly executed: readonly ScheduledTask[];
  readonly skippedMissed: readonly ScheduledTask[];
  readonly errors: readonly { task: ScheduledTask; message: string }[];
}

export interface BusinessClockOptions {
  /** Frozen start instant (ISO string or epoch ms). */
  readonly start: string | number;
  /** IANA time zone used for local recurrence, default UTC. */
  readonly timeZone?: string;
}

/**
 * Deterministic business clock: wall time only advances when the test calls
 * `advance`/`advanceTo`, recurring instants are computed with real IANA
 * rules (DST-aware), and missed occurrences are surfaced explicitly instead
 * of being silently dropped.
 */
export class BusinessClock {
  readonly timeZone: string;
  readonly startMs: number;
  private currentMs: number;
  private nextTaskId = 1;
  private readonly tasks: ScheduledTask[] = [];
  private readonly completed = new Set<number>();
  private readonly formatters = new Map<string, Intl.DateTimeFormat>();

  constructor(options: BusinessClockOptions) {
    this.timeZone = options.timeZone ?? 'UTC';
    this.startMs = typeof options.start === 'number' ? options.start : Date.parse(options.start);
    if (Number.isNaN(this.startMs)) throw new RangeError(`invalid business clock start: ${String(options.start)}`);
    this.currentMs = this.startMs;
    this.assertZone();
  }

  private assertZone(): void {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: this.timeZone }).format(0);
    } catch {
      throw new RangeError(`unknown time zone ${this.timeZone}`);
    }
  }

  private formatter(kind: 'parts' | 'offset'): Intl.DateTimeFormat {
    const cached = this.formatters.get(kind);
    if (cached !== undefined) return cached;
    const formatter =
      kind === 'offset'
        ? new Intl.DateTimeFormat('en-US', { timeZone: this.timeZone, timeZoneName: 'longOffset' })
        : new Intl.DateTimeFormat('en-US', {
            timeZone: this.timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
    this.formatters.set(kind, formatter);
    return formatter;
  }

  /** Local calendar components for an instant in this clock's time zone. */
  localParts(epochMs: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
    const parts = this.formatter('parts').formatToParts(epochMs);
    const get = (type: string): number => {
      const part = parts.find(item => item.type === type);
      return part === undefined ? Number.NaN : Number(part.value);
    };
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
  }

  /** Offset of the zone at an instant: local-clock-as-UTC minus real epoch. */
  offsetAt(epochMs: number): number {
    const parts = this.formatter('offset').formatToParts(epochMs);
    const name = parts.find(item => item.type === 'timeZoneName')?.value ?? 'GMT';
    const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
    if (match === null) throw new Error(`cannot parse time zone offset ${name}`);
    if (match[1] === undefined) return 0;
    const sign = match[1] === '-' ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
  }

  private localAsUtc(epochMs: number): number {
    const parts = this.localParts(epochMs);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  }

  /** All real instants whose local wall time equals the requested one (0–2 around DST). */
  private wallTimeCandidates(year: number, month: number, day: number, hour: number, minute: number, second: number): number[] {
    const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const offsets = new Set([this.offsetAt(wallAsUtc - 86_400_000), this.offsetAt(wallAsUtc), this.offsetAt(wallAsUtc + 86_400_000)]);
    const candidates: number[] = [];
    for (const offset of offsets) {
      const instant = wallAsUtc - offset;
      if (this.localAsUtc(instant) === wallAsUtc) candidates.push(instant);
    }
    return [...new Set(candidates)].sort((left, right) => left - right);
  }

  nextOccurrence(daily: DailyAt, afterMs?: number): number | null {
    this.validateDaily(daily);
    const after = afterMs ?? this.currentMs;
    const second = daily.second ?? 0;
    const local = this.localParts(after);
    for (let dayOffset = 0; dayOffset <= 370; dayOffset++) {
      const dayProbe = Date.UTC(local.year, local.month - 1, local.day + dayOffset, 12, 0, 0);
      const candidates = this.wallTimeCandidates(
        this.localParts(dayProbe).year,
        this.localParts(dayProbe).month,
        this.localParts(dayProbe).day,
        daily.hour,
        daily.minute,
        second,
      );
      for (const candidate of candidates) {
        if (candidate > after) return candidate;
      }
    }
    return null;
  }

  occurrencesBetween(daily: DailyAt, fromMs: number, toMs: number): number[] {
    this.validateDaily(daily);
    if (!(toMs > fromMs)) return [];
    const found: number[] = [];
    const second = daily.second ?? 0;
    const local = this.localParts(fromMs);
    for (let dayOffset = 0; dayOffset <= 370; dayOffset++) {
      const dayProbe = Date.UTC(local.year, local.month - 1, local.day + dayOffset, 12, 0, 0);
      const parts = this.localParts(dayProbe);
      const candidates = this.wallTimeCandidates(parts.year, parts.month, parts.day, daily.hour, daily.minute, second);
      for (const candidate of candidates) {
        if (candidate > fromMs && candidate <= toMs) found.push(candidate);
      }
      if (dayProbe > toMs + 86_400_000) break;
    }
    return found.sort((left, right) => left - right);
  }

  private validateDaily(daily: DailyAt): void {
    if (!Number.isInteger(daily.hour) || daily.hour < 0 || daily.hour > 23) throw new RangeError(`invalid hour ${daily.hour}`);
    if (!Number.isInteger(daily.minute) || daily.minute < 0 || daily.minute > 59) throw new RangeError(`invalid minute ${daily.minute}`);
    if (daily.second !== undefined && (!Number.isInteger(daily.second) || daily.second < 0 || daily.second > 59)) {
      throw new RangeError(`invalid second ${daily.second}`);
    }
  }

  nowMs(): number {
    return this.currentMs;
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`advance must be a finite non-negative number, got ${String(ms)}`);
    this.currentMs += ms;
  }

  advanceTo(instant: string | number): void {
    const target = typeof instant === 'number' ? instant : Date.parse(instant);
    if (Number.isNaN(target)) throw new RangeError(`invalid instant ${String(instant)}`);
    if (target < this.currentMs) throw new RangeError('business clock cannot move backwards');
    this.currentMs = target;
  }

  schedule(delayMs: number, label: string, run?: () => void): ScheduledTask {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError(`delay must be a finite non-negative number, got ${String(delayMs)}`);
    return this.scheduleAt(this.currentMs + delayMs, label, run);
  }

  scheduleAt(epochMs: number, label: string, run?: () => void): ScheduledTask {
    const task: ScheduledTask = { id: this.nextTaskId++, label, dueMs: epochMs, run };
    this.tasks.push(task);
    return task;
  }

  pending(): number {
    return this.tasks.filter(task => !this.completed.has(task.id)).length;
  }

  /** Overdue tasks in deterministic (dueMs, id) order; nothing is executed. */
  due(nowMs?: number): readonly ScheduledTask[] {
    const now = nowMs ?? this.currentMs;
    return this.tasks
      .filter(task => !this.completed.has(task.id) && task.dueMs <= now)
      .sort((left, right) => left.dueMs - right.dueMs || left.id - right.id);
  }

  /**
   * Execute the tasks that are due at `nowMs` (default current time).
   * `latest-per-label` implements the "missed occurrence: run only the
   * latest applicable one" policy and reports skipped ones explicitly.
   */
  runDue(options: { policy?: 'all' | 'latest-per-label'; nowMs?: number } = {}): RunDueResult {
    const policy = options.policy ?? 'all';
    const due = this.due(options.nowMs);
    const selected: ScheduledTask[] = [];
    const skipped: ScheduledTask[] = [];
    if (policy === 'all') selected.push(...due);
    else {
      const latestByLabel = new Map<string, ScheduledTask>();
      for (const task of due) {
        const current = latestByLabel.get(task.label);
        if (current === undefined || task.dueMs > current.dueMs) latestByLabel.set(task.label, task);
      }
      for (const task of due) {
        if (latestByLabel.get(task.label) === task) selected.push(task);
        else skipped.push(task);
      }
    }
    const errors: { task: ScheduledTask; message: string }[] = [];
    const executed: ScheduledTask[] = [];
    for (const task of selected) {
      this.completed.add(task.id);
      try {
        task.run?.();
        executed.push(task);
      } catch (error) {
        errors.push({ task, message: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const task of skipped) this.completed.add(task.id);
    return { executed, skippedMissed: skipped, errors };
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic fault injection / crash points.                       */
/* ------------------------------------------------------------------ */

export type FaultAction = 'throw' | 'abort' | 'exit';

export interface FaultSpec {
  readonly name: string;
  readonly checkpoint: string;
  readonly action?: FaultAction;
  /** Fire on the Nth call to this checkpoint (1-based). Default 1. */
  readonly at?: number;
  /** Number of consecutive calls to fire. Default 1. */
  readonly times?: number;
  readonly code?: string;
  readonly detail?: string;
  /** `exit` action only. Default 17. */
  readonly exitCode?: number;
}

export interface FaultHit {
  readonly name: string;
  readonly checkpoint: string;
  readonly ordinal: number;
  readonly atMs: number;
  readonly action: FaultAction;
  readonly code: string;
}

export class FaultInjectedError extends Error {
  readonly code: string;
  readonly faultName: string;
  readonly checkpoint: string;
  readonly ordinal: number;

  constructor(hit: FaultHit) {
    super(`fault ${hit.name}@${hit.checkpoint}#${hit.ordinal} (${hit.code})`);
    this.name = 'FaultInjectedError';
    this.code = hit.code;
    this.faultName = hit.name;
    this.checkpoint = hit.checkpoint;
    this.ordinal = hit.ordinal;
  }
}

export interface FaultInjectorOptions {
  readonly runId: string;
  readonly now?: () => number;
  /** Required to allow action 'exit' (real child-process crash point). */
  readonly allowProcessExit?: boolean;
}

/**
 * Named, planned fault injection. A hit is deterministic: it fires only on
 * the declared checkpoint/ordinal, is recorded once, and the hit log proves
 * which location executed. This is how the harness avoids `sleep`-based
 * race guessing: the failure point is a named program location.
 */
export class FaultInjector {
  readonly runId: string;
  readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly allowProcessExit: boolean;
  private readonly specs: FaultSpec[] = [];
  private readonly ordinals = new Map<string, number>();
  private readonly fired = new Map<string, number>();
  private readonly hitLog: FaultHit[] = [];

  constructor(options: FaultInjectorOptions) {
    this.runId = options.runId;
    this.now = options.now ?? (() => performance.now());
    this.allowProcessExit = options.allowProcessExit ?? false;
  }

  plan(specs: readonly FaultSpec[]): void {
    for (const spec of specs) {
      if (spec.at !== undefined && (!Number.isInteger(spec.at) || spec.at < 1)) throw new RangeError(`fault ${spec.name}: at must be >= 1`);
      if (spec.times !== undefined && (!Number.isInteger(spec.times) || spec.times < 1)) throw new RangeError(`fault ${spec.name}: times must be >= 1`);
      if ((spec.action ?? 'throw') === 'exit' && !this.allowProcessExit) throw new Error(`fault ${spec.name}: exit action requires allowProcessExit`);
      this.specs.push(spec);
    }
  }

  get hits(): readonly FaultHit[] {
    return [...this.hitLog];
  }

  /** Rounds a checkpoint; returns the deterministic ordinal (1-based). */
  checkpoint(checkpoint: string, context?: unknown): number {
    const ordinal = (this.ordinals.get(checkpoint) ?? 0) + 1;
    this.ordinals.set(checkpoint, ordinal);
    for (const spec of this.specs) {
      if (spec.checkpoint !== checkpoint) continue;
      const at = spec.at ?? 1;
      const times = spec.times ?? 1;
      if (ordinal < at || ordinal >= at + times) continue;
      const fireKey = `${spec.name}\u0000${checkpoint}`;
      const alreadyFired = this.fired.get(fireKey) ?? 0;
      if (alreadyFired >= times) continue;
      this.fired.set(fireKey, alreadyFired + 1);
      const hit: FaultHit = {
        name: spec.name,
        checkpoint,
        ordinal,
        atMs: this.now(),
        action: spec.action ?? 'throw',
        code: spec.code ?? 'FAULT_INJECTED',
      };
      this.hitLog.push(hit);
      if (hit.action === 'throw') throw new FaultInjectedError(hit);
      if (hit.action === 'abort') {
        this.controller.abort({ ...hit, context: context === undefined ? undefined : String(context) });
        return ordinal;
      }
      if (hit.action === 'exit') {
        process.exit(spec.exitCode ?? 17);
      }
    }
    return ordinal;
  }

  /**
   * Verify the fault plan against a frozen expectation. Without an explicit
   * expectation the planned specs are used. Missing hits, wrong counts and
   * unplanned hits are all violations ("fault not injected" must not pass).
   */
  checkHits(expected?: readonly FaultSpec[]): CheckResult {
    const expectedSpecs = expected ?? this.specs;
    const violations: Violation[] = [];
    let checked = 0;
    const actualByCheckpoint = new Map<string, FaultHit[]>();
    for (const hit of this.hitLog) {
      const list = actualByCheckpoint.get(hit.checkpoint) ?? [];
      list.push(hit);
      actualByCheckpoint.set(hit.checkpoint, list);
    }
    for (const spec of expectedSpecs) {
      checked++;
      const actual = actualByCheckpoint.get(spec.checkpoint) ?? [];
      const expectedTimes = spec.times ?? 1;
      if (actual.length === 0) {
        violations.push(
          violation('fault_not_hit', '$', `planned fault ${spec.name} at checkpoint ${spec.checkpoint} never fired`, {
            fault: spec.name,
            checkpoint: spec.checkpoint,
          }),
        );
      } else if (actual.length !== expectedTimes) {
        violations.push(
          violation('fault_times_mismatch', '$', `fault ${spec.name} at ${spec.checkpoint} fired ${actual.length} time(s), expected ${expectedTimes}`, {
            fault: spec.name,
            actual: actual.length,
            expected: expectedTimes,
          }),
        );
      }
    }
    const plannedCheckpoints = new Set(expectedSpecs.map(spec => spec.checkpoint));
    for (const checkpoint of actualByCheckpoint.keys()) {
      checked++;
      if (!plannedCheckpoints.has(checkpoint)) {
        violations.push(violation('unexpected_fault_hit', '$', `unplanned fault fired at checkpoint ${checkpoint}`));
      }
    }
    return finish(
      { oracle: 'fault-injection', version: '1.1.0', boundary: FAULT_BOUNDARY, scope: 'fault-hit-log' },
      checked,
      violations,
      { hits: this.hitLog.length },
    );
  }

  hitLogJson(): JsonValue {
    return this.hitLog.map(hit => ({
      name: hit.name,
      checkpoint: hit.checkpoint,
      ordinal: hit.ordinal,
      atMs: hit.atMs,
      action: hit.action,
      code: hit.code,
    }));
  }
}

const FAULT_BOUNDARY =
  '按命名断点与序号注入故障并记录命中日志：只允许在计划断点/次数命中，未命中或多余命中均拒绝；' +
  '崩溃断点使用真实子进程退出验证持久证据可取证。不证明产品在未覆盖代码路径上的故障行为。';

/* ------------------------------------------------------------------ */
/* Schedule-run judge (used by the clock scenario proofs).             */
/* ------------------------------------------------------------------ */

export interface ScheduleRunInput {
  readonly plannedOccurrences: number;
  readonly due: number;
  readonly executed: number;
  readonly skippedMissed?: number;
  readonly latestOnlyPolicy?: boolean;
  readonly expectedExecuted?: number;
}

export function checkScheduleRun(input: ScheduleRunInput): CheckResult {
  return checkOccurrenceAccounting(input);
}

/* ------------------------------------------------------------------ */
/* Self-proofs.                                                        */
/* ------------------------------------------------------------------ */

const DEADLINE_CONTEXT = { oracle: 'deadline', version: '1.1.0', boundary: ABORT_BOUNDARY, scope: 'deadline' } as const;

export const deadlineSelfProof: OracleSelfProof = {
  name: 'deadline',
  version: '1.1.0',
  module: 'tests/harness/faults.ts',
  boundary: ABORT_BOUNDARY,
  evaluate: input => checkAbortObservation(input as AbortObservationInput),
  scenarios: [
    {
      label: 'accept-real-timer-aborts-at-deadline',
      expect: 'accept',
      why: '真实 setTimeout 15ms 到期后 AbortSignal 在宽容窗口内以 deadline_exceeded 触发',
      run: async () => {
        const deadline = new AbsoluteDeadline(15);
        const start = performance.now();
        try {
          const observed = await waitForAbort(deadline.signal);
          if (observed === null) throw new Error('abort never observed (guard timeout)');
          return checkAbortObservation({
            signalAborted: true,
            startMs: start,
            deadlineAtMs: deadline.atMs,
            observedAtMs: observed,
            maxDelayMs: 1000,
            expectedReason: 'deadline_exceeded',
            actualReason: deadline.reason?.code,
          });
        } finally {
          deadline.dispose();
        }
      },
    },
    {
      label: 'reject-stop-requested-but-not-observed',
      expect: 'reject',
      expectCodes: ['abort_not_observed'],
      why: '只有停止请求、没有观察到 abort 时不能记成停止成功',
      run: async () => checkAbortObservation({ signalAborted: false }),
    },
    {
      label: 'reject-late-abort',
      expect: 'reject',
      expectCodes: ['late_abort'],
      why: 'abort 观察时间超过 deadline+maxDelay，时限证明不成立',
      run: async () =>
        checkAbortObservation({
          signalAborted: true,
          startMs: 100,
          deadlineAtMs: 200,
          observedAtMs: 2_500,
          maxDelayMs: 500,
          expectedReason: 'deadline_exceeded',
          actualReason: 'deadline_exceeded',
        }),
    },
  ],
  samples: [
    {
      label: 'accept-in-window-deadline-abort',
      input: { signalAborted: true, startMs: 10, deadlineAtMs: 110, observedAtMs: 118, maxDelayMs: 1000, expectedReason: 'deadline_exceeded', actualReason: 'deadline_exceeded' },
      expect: 'accept',
      why: '真实单调时间内观察到正确原因的 abort',
    },
    {
      label: 'reject-abort-before-deadline',
      input: { signalAborted: true, startMs: 10, deadlineAtMs: 110, observedAtMs: 50, maxDelayMs: 1000, expectedReason: 'deadline_exceeded', actualReason: 'deadline_exceeded' },
      expect: 'reject',
      expectCodes: ['abort_before_deadline'],
      why: '期限未到就 abort，不是到期停止证据',
    },
    {
      label: 'reject-wrong-abort-reason',
      input: { signalAborted: true, startMs: 10, deadlineAtMs: 110, observedAtMs: 120, maxDelayMs: 1000, expectedReason: 'deadline_exceeded', actualReason: 'trusted_stop' },
      expect: 'reject',
      expectCodes: ['wrong_abort_reason'],
      why: '原因不匹配：可信停止与期限到期是不同事实',
    },
    {
      label: 'reject-incomplete-observation',
      input: { signalAborted: true },
      expect: 'reject',
      expectCodes: ['observation_incomplete'],
      why: '缺少时间戳时不可判定，不能按通过处理',
    },
  ],
};

export const businessClockSelfProof: OracleSelfProof = {
  name: 'business-clock',
  version: '1.1.0',
  module: 'tests/harness/faults.ts',
  boundary:
    '可注入假业务时钟：墙钟仅显式推进、按 IANA 时区计算每日发生点（DST 跳过/重复）、遗漏周期显式记账。' +
    '不证明真实 7 天连续运行或真实定时器抖动。',
  scenarios: [
    {
      label: 'accept-dst-spring-forward-skips-missing-local-time',
      expect: 'accept',
      why: 'America/New_York 2026-03-08 02:30 不存在，下一次 02:30 应是 2026-03-09（EDT, 06:30Z）',
      run: async () => {
        const clock = new BusinessClock({ start: '2026-03-08T00:00:00-05:00', timeZone: 'America/New_York' });
        const next = clock.nextOccurrence({ hour: 2, minute: 30 });
        const expected = Date.parse('2026-03-09T02:30:00-04:00');
        const violations: Violation[] = [];
        if (next !== expected) {
          violations.push(violation('dst_occurrence_mismatch', '$', `expected ${new Date(expected).toISOString()}, got ${next === null ? 'null' : new Date(next).toISOString()}`));
        }
        return finish({ oracle: 'business-clock', version: '1.1.0', boundary: 'dst', scope: 'spring-forward' }, 1, violations);
      },
    },
    {
      label: 'accept-dst-fall-back-repeated-local-time-twice',
      expect: 'accept',
      why: 'America/New_York 2026-11-01 01:30 在回拨日出现两次（05:30Z 与 06:30Z）',
      run: async () => {
        const clock = new BusinessClock({ start: '2026-11-01T00:00:00-04:00', timeZone: 'America/New_York' });
        const occurrences = clock.occurrencesBetween({ hour: 1, minute: 30 }, Date.parse('2026-11-01T00:00:00-04:00'), Date.parse('2026-11-01T03:00:00-05:00'));
        const expected = [Date.parse('2026-11-01T01:30:00-04:00'), Date.parse('2026-11-01T01:30:00-05:00')];
        const violations: Violation[] = [];
        if (occurrences.length !== 2 || occurrences[0] !== expected[0] || occurrences[1] !== expected[1]) {
          violations.push(violation('dst_occurrence_mismatch', '$', `expected two instants, got ${JSON.stringify(occurrences)}`));
        }
        return finish({ oracle: 'business-clock', version: '1.1.0', boundary: 'dst', scope: 'fall-back' }, 1, violations);
      },
    },
    {
      label: 'accept-missed-daily-latest-only-accounted',
      expect: 'accept',
      why: '假时钟跨 3 天 4 个到期周期，latest-only 只执行最近一次并显式记录漏过 3 次',
      run: async () => {
        const clock = new BusinessClock({ start: '2026-11-02T00:00:00.000Z', timeZone: 'UTC' });
        clock.scheduleAt(Date.parse('2026-11-02T09:00:00.000Z'), 'daily-report');
        clock.scheduleAt(Date.parse('2026-11-03T09:00:00.000Z'), 'daily-report');
        clock.scheduleAt(Date.parse('2026-11-04T09:00:00.000Z'), 'daily-report');
        clock.scheduleAt(Date.parse('2026-11-05T09:00:00.000Z'), 'daily-report');
        clock.advanceTo('2026-11-05T10:00:00.000Z');
        const due = clock.due().length;
        const result = clock.runDue({ policy: 'latest-per-label' });
        return checkScheduleRun({
          plannedOccurrences: 4,
          due,
          executed: result.executed.length,
          skippedMissed: result.skippedMissed.length,
          latestOnlyPolicy: true,
          expectedExecuted: 1,
        });
      },
    },
    {
      label: 'reject-missed-occurrence-silently-dropped',
      expect: 'reject',
      expectCodes: ['missed_occurrence_silently_dropped'],
      why: '到期 4 次只执行 1 次且不申报漏过时，调度运行证明失败',
      run: async () => checkScheduleRun({ plannedOccurrences: 4, due: 4, executed: 1, latestOnlyPolicy: true }),
    },
    {
      label: 'accept-deterministic-timer-order',
      expect: 'accept',
      why: '假时钟只按显式推进执行到期任务，顺序由 dueMs 决定而非 sleep',
      run: async () => {
        const clock = new BusinessClock({ start: '2026-11-02T00:00:00.000Z' });
        const order: string[] = [];
        clock.schedule(30, 'c', () => order.push('c'));
        clock.schedule(10, 'a', () => order.push('a'));
        clock.schedule(20, 'b', () => order.push('b'));
        const tooEarly = clock.runDue();
        clock.advance(30);
        const executed = clock.runDue();
        const violations: Violation[] = [];
        if (tooEarly.executed.length !== 0) violations.push(violation('early_timer_execution', '$', 'timer executed before the fake clock reached its due instant'));
        if (order.join(',') !== 'a,b,c') violations.push(violation('timer_order_mismatch', '$', `expected a,b,c; got ${order.join(',')}`));
        if (executed.executed.length !== 3) violations.push(violation('timer_execution_count', '$', `expected 3 executed, got ${executed.executed.length}`));
        return finish({ oracle: 'business-clock', version: '1.1.0', boundary: 'timers', scope: 'deterministic-order' }, 3, violations, { order: order.join(',') });
      },
    },
  ],
  samples: [],
};

export const faultInjectionSelfProof: OracleSelfProof = {
  name: 'fault-injection',
  version: '1.1.0',
  module: 'tests/harness/faults.ts',
  boundary: FAULT_BOUNDARY,
  evaluate: input => {
    const { injector, expected } = input as { injector: FaultInjector; expected?: FaultSpec[] };
    return injector.checkHits(expected);
  },
  scenarios: [
    {
      label: 'accept-single-hit-at-declared-checkpoint',
      expect: 'accept',
      why: '计划在 after-write 断点抛错一次：before-write 不命中，after-write 命中且再次调用不命中，命中日志与计划一致',
      run: async () => {
        const injector = new FaultInjector({ runId: 'run-fault-1' });
        injector.plan([{ name: 'lost-receipt', checkpoint: 'after-write', action: 'throw', code: 'RECEIPT_LOST_AFTER_WRITE' }]);
        injector.checkpoint('before-write');
        let thrown: unknown;
        try {
          injector.checkpoint('after-write');
        } catch (error) {
          thrown = error;
        }
        injector.checkpoint('after-write');
        const violations: Violation[] = [];
        if (!(thrown instanceof FaultInjectedError)) violations.push(violation('fault_not_thrown', '$', 'planned fault did not throw at the declared checkpoint'));
        else if (thrown.code !== 'RECEIPT_LOST_AFTER_WRITE') violations.push(violation('fault_code_mismatch', '$', `unexpected code ${thrown.code}`));
        const hitCheck = injector.checkHits();
        const hitLog = injector.hitLogJson() as JsonValue[];
        if (hitCheck.violations.length > 0) violations.push(...hitCheck.violations);
        if (hitLog.length !== 1) violations.push(violation('fault_hit_count', '$', `expected exactly one hit, got ${hitLog.length}`));
        return finish({ oracle: 'fault-injection', version: '1.1.0', boundary: FAULT_BOUNDARY, scope: 'single-hit' }, 3, violations, {
          hits: hitLog,
        });
      },
    },
    {
      label: 'reject-planned-fault-never-fired',
      expect: 'reject',
      expectCodes: ['fault_not_hit'],
      why: '计划注入但断点未执行时，checkHits 必须报 fault_not_hit，证明注入位置可证伪',
      run: async () => {
        const injector = new FaultInjector({ runId: 'run-fault-2' });
        injector.plan([{ name: 'planned-crash', checkpoint: 'after-commit' }]);
        injector.checkpoint('before-commit');
        return injector.checkHits();
      },
    },
    {
      label: 'reject-fault-fired-fewer-times-than-planned',
      expect: 'reject',
      expectCodes: ['fault_times_mismatch'],
      why: '计划命中两次实际只命中一次时，命中次数校验失败',
      run: async () => {
        const injector = new FaultInjector({ runId: 'run-fault-3', allowProcessExit: false });
        injector.plan([{ name: 'two-aborts', checkpoint: 'retry-loop', action: 'abort', times: 2 }]);
        injector.checkpoint('retry-loop');
        return injector.checkHits();
      },
    },
  ],
  samples: [],
};

export const ABORT_SELF_PROOFS: readonly OracleSelfProof[] = [deadlineSelfProof];
