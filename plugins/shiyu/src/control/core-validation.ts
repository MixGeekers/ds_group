import { createHash } from 'node:crypto';
import type { CoreCommands, CoreEvaluation, CoreGoal, CorePlanView, CorePrepareInput } from '../contracts/core.js';
import type { GoalBinding } from '../adapters/dsh/goals.js';
import type { CommitWatermark } from '../adapters/control-store/commit-watermark.js';
import type { Budget } from './policy/mandates.js';
import type { CoreEvaluationResult } from './core-pump.js';
import type { TaskCommands, TaskDetail } from '../adapters/control-store/task-domain.js';
import type { TaskView } from './tasks/types.js';

/**
 * H3 bounded real core-Goal validation runner.
 *
 * This is one frozen, owner-triggered business chain: create one real core Goal
 * under the fixed owner authorization below, run at most two core evaluation
 * rounds (each one real bounded model round through the trusted core service),
 * let the trusted worker/independent-verification path produce the artifact,
 * and observe the native Goal complete or an explicit pause. It owns no second
 * Goal/Task state machine and it never retries a failed or unknown round.
 *
 * The runner itself only reads the control store; every mutation goes through
 * the injected trusted CoreDriver (real Goal/Task/Effect/budget/Session/artifact
 * side effects are declared in the receipt and in the host kit). Offline tests
 * inject a fake driver/store; this module never calls a model directly.
 */

export const CORE_VALIDATION_REQUEST_ID = 'core-validation-frozen-v1';
export const CORE_VALIDATION_OBJECTIVE = '完成 owner 预授权的有界本地便签验证：写入 note-1 并由独立核验确认。';
export const CORE_VALIDATION_DELIVERABLE = Object.freeze({ id: 'note-1', title: '有界 core 验证便签',
  content: 'SHIYU_CORE_VALIDATION_NOTE_V1', dependsOn: [] as string[] });
export const CORE_VALIDATION_BUDGET: Readonly<Budget> = Object.freeze({ tokens: 16_384, calls: 3, effects: 1 });
export const CORE_VALIDATION_EXPIRES_IN_MS = 10 * 60 * 1000;
export const CORE_VALIDATION_MAX_EVALUATIONS = 2;
export const CORE_VALIDATION_WALL_MS = 180_000;
export const CORE_VALIDATION_POLL_MS = 1_000;
export const CORE_VALIDATION_NO_PROGRESS_MS = 15_000;
export const CORE_VALIDATION_RECEIPT_MAX_BYTES = 65_536;
export const CORE_VALIDATION_RECEIPT_MAX_ARRAY = 16;
export const CORE_VALIDATION_RECEIPT_MAX_STRING = 4_000;
export const CORE_VALIDATION_RECEIPT_MAX_DEPTH = 8;
export const CORE_VALIDATION_STOP_COMMAND_TIMEOUT_MS = 10_000;

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
const iso = (ms: number): string => new Date(ms).toISOString();
const safeCode = (error: unknown): string => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
  && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : 'CORE_VALIDATION_INTERNAL_ERROR';
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Read-only control-store surface used by the runner. Writes go through CoreValidationDriver. */
type ReadOnlyCoreCommands = Pick<CoreCommands, 'core.get' | 'core.snapshot' | 'core.evaluations' | 'core.balance' | 'core.plan'>;
type ReadOnlyTaskCommands = Pick<TaskCommands, 'task.list' | 'task.get'>;
export interface CoreValidationCommands extends ReadOnlyCoreCommands, ReadOnlyTaskCommands {
  'goal.binding.load': { input: { goalId: string }; output: GoalBinding | undefined };
  'control.watermark': { input: Record<string, never>; output: CommitWatermark };
}
export interface CoreValidationStore {
  request<K extends keyof CoreValidationCommands>(command: K, args: CoreValidationCommands[K]['input']): Promise<CoreValidationCommands[K]['output']>;
}

/** Trusted core surface; the real LocalCoreService satisfies this structurally. */
export interface CoreValidationDriver {
  create(input: CorePrepareInput, signal?: AbortSignal): Promise<CoreGoal>;
  control(kind: 'pause' | 'cancel' | 'resume', input: { goalId: string; expectedVersion: number }, signal?: AbortSignal): Promise<CoreGoal>;
  evaluatePending(input?: { signal?: AbortSignal }): Promise<CoreEvaluationResult>;
  cancelGoal?(goalId: string, reason?: unknown): void;
}

/** Trusted host hook: run one core evaluation through the normal runtime
 * admission/scheduling path (so queued worker Tasks are scheduled). Defaults to
 * CoreValidationDriver.evaluatePending. */
export type CoreValidationEvaluate = (input: { signal: AbortSignal }) => Promise<CoreEvaluationResult>;

export interface CoreValidationOptions {
  core: CoreValidationDriver;
  store: CoreValidationStore;
  evaluate?: CoreValidationEvaluate;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  progress?: (phase: string, detail: string) => void;
}

export type CoreValidationStatus = 'completed' | 'paused' | 'timeout' | 'failed' | 'cancelled';
export type CoreValidationReasonCode =
  | 'CORE_VALIDATION_COMPLETED'
  | 'CORE_VALIDATION_PAUSED_EXTERNALLY'
  | 'CORE_VALIDATION_TIMEOUT'
  | 'CORE_VALIDATION_CANCELLED'
  | 'CORE_VALIDATION_CREATE_FAILED'
  | 'CORE_VALIDATION_CREATE_INTEGRITY'
  | 'CORE_VALIDATION_EVALUATION_FAILED'
  | 'CORE_VALIDATION_EVALUATION_UNKNOWN'
  | 'CORE_VALIDATION_TASK_FAILED'
  | 'CORE_VALIDATION_NO_PROGRESS'
  | 'CORE_VALIDATION_EVIDENCE_INCOMPLETE'
  | 'CORE_VALIDATION_BUDGET_OVERRUN'
  | 'CORE_VALIDATION_INTERNAL_ERROR';

export type CoreValidationStopKind = 'none' | 'pause' | 'cancel';
export interface CoreValidationStopAction {
  kind: CoreValidationStopKind;
  attempted: boolean;
  ok: boolean | null;
  reasonCode?: string;
  at?: string;
  goalVersion?: number;
}
export interface CoreValidationUsage {
  /** Raw budget reservation state; never recomputed and never padded with zero. */
  state: 'reserved' | 'unknown' | 'settled' | 'absent';
  observedTokens: number | null;
  observedCalls: number | null;
  overrun: boolean;
  accounting: 'complete' | 'unknown';
}
export interface CoreValidationEvaluationSummary {
  evaluationId: string;
  status: string;
  kind?: string;
  reasonCode?: string;
  candidateSummary?: string;
  planVersion?: number;
  triggerRefs: string[];
  usage: CoreValidationUsage;
}
export interface CoreValidationTaskSummary {
  deliverableId: string;
  taskId: string;
  state: string;
  version: number;
  verification: 'pass' | 'fail' | 'unobserved';
  artifactRef?: string;
  expectedSha256?: string;
  observedSha256?: string;
  observedBytes?: number | null;
  effectId?: string;
  effectStatus?: string;
  receiptId?: string;
}
export interface CoreValidationPlanSummary {
  planVersion: number;
  historyCount: number;
  latestPlanHash?: string;
  latestAcceptedAt?: string;
  steps: { stepId: string; deliverableId: string; dependsOn: string[]; expectedSha256: string }[];
  stopConditions?: { onStepFailure: string; maxFailedSteps: number; onFactConflict: string; maxParallelSteps: number };
}
export interface CoreValidationNativeSummary {
  phase: 'active' | 'paused' | 'blocked' | 'complete' | 'unobserved';
  goalRef?: { id: string; revision: number };
  sessionId?: string;
  observedAt?: string;
  bindingReceiptStatus?: 'pending' | 'unknown' | 'confirmed' | 'rejected' | 'absent';
  /** True if any observation in this run saw the native Goal phase complete. */
  completedObserved: boolean;
}
export interface CoreValidationBusinessSideEffects {
  goal: { created: boolean; goalId?: string; requestId: string; version?: number };
  tasks: { count: number; ids: string[] };
  effects: { count: number; ids: string[] };
  artifacts: { count: number; refs: { taskId: string; artifactRef: string; sha256: string; bytes: number }[] };
  sessions: { goalSessionId?: string; workerSessionIds: string[] };
  budget: { limits: Budget; spent: Partial<Budget>; held: Partial<Budget> };
  control: { commitSeqBefore?: number; commitSeqAfter?: number };
}
export interface CoreValidationFixedInput {
  frozen: true;
  requestId: string;
  objectiveSha256: string;
  deliverable: { id: string; titleSha256: string; contentSha256: string; dependsOn: string[] };
  budget: Budget;
  expiresInMs: number;
  maxEvaluations: number;
  templateSha256: string;
}
export interface CoreValidationReceipt {
  schemaVersion: 1;
  kind: 'bounded-core-goal-validation';
  status: CoreValidationStatus;
  reasonCode: CoreValidationReasonCode;
  goalId?: string;
  requestId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  fixedInput: CoreValidationFixedInput;
  counters: { evaluateAttempts: number; pollCount: number; maxEvaluations: number; wallLimitMs: number };
  goal?: {
    goalId: string; version: number; requestId: string; authorized: boolean; paused: boolean; cancelled: boolean;
    planVersion: number; mandateId?: string; expiresAt: string; nativePhase: string;
  };
  evaluations: CoreValidationEvaluationSummary[];
  taskRefs: CoreValidationTaskSummary[];
  plans: CoreValidationPlanSummary[];
  native: CoreValidationNativeSummary;
  budget?: { limits: Budget; spent: Partial<Budget>; held: Partial<Budget>; available: Partial<Budget>; overrun: boolean };
  artifacts: { taskId: string; artifactRef: string; expectedSha256: string; observedSha256?: string; byteLength: number; verification: string }[];
  effects: { effectId: string; status: string; receiptId?: string }[];
  businessSideEffects: CoreValidationBusinessSideEffects;
  stopAction: CoreValidationStopAction;
  unknowns: string[];
  error?: { phase: string; code: string; message: string };
}
export class CoreValidationBusyError extends Error {
  readonly code = 'CORE_VALIDATION_BUSY';
  constructor() { super('A bounded core Goal validation is already running; it is single-flight and is never retried'); this.name = 'CoreValidationBusyError'; }
}
export class CoreValidationOptionsError extends Error {
  readonly code = 'CORE_VALIDATION_INVALID_OPTIONS';
  constructor(message: string) { super(message); this.name = 'CoreValidationOptionsError'; }
}

const FROZEN_TEMPLATE = Object.freeze({ requestId: CORE_VALIDATION_REQUEST_ID, objective: CORE_VALIDATION_OBJECTIVE,
  deliverables: [CORE_VALIDATION_DELIVERABLE], budget: CORE_VALIDATION_BUDGET,
  expiresInMs: CORE_VALIDATION_EXPIRES_IN_MS, maxEvaluations: CORE_VALIDATION_MAX_EVALUATIONS });
export const CORE_VALIDATION_TEMPLATE_SHA256: string = sha256(canonical(FROZEN_TEMPLATE));
const FIXED_INPUT: CoreValidationFixedInput = Object.freeze({
  frozen: true as const,
  requestId: CORE_VALIDATION_REQUEST_ID,
  objectiveSha256: sha256(CORE_VALIDATION_OBJECTIVE),
  deliverable: Object.freeze({ id: CORE_VALIDATION_DELIVERABLE.id, titleSha256: sha256(CORE_VALIDATION_DELIVERABLE.title),
    contentSha256: sha256(CORE_VALIDATION_DELIVERABLE.content), dependsOn: Object.freeze([]) as unknown as string[] }),
  budget: Object.freeze({ ...CORE_VALIDATION_BUDGET }),
  expiresInMs: CORE_VALIDATION_EXPIRES_IN_MS,
  maxEvaluations: CORE_VALIDATION_MAX_EVALUATIONS,
  templateSha256: CORE_VALIDATION_TEMPLATE_SHA256,
});
export function frozenCoreValidationInput(startedAtMs: number): CorePrepareInput {
  return { requestId: CORE_VALIDATION_REQUEST_ID, objective: CORE_VALIDATION_OBJECTIVE,
    deliverables: [{ id: CORE_VALIDATION_DELIVERABLE.id, title: CORE_VALIDATION_DELIVERABLE.title,
      content: CORE_VALIDATION_DELIVERABLE.content, dependsOn: [...CORE_VALIDATION_DELIVERABLE.dependsOn] }],
    budget: { ...CORE_VALIDATION_BUDGET }, expiresAt: iso(startedAtMs + CORE_VALIDATION_EXPIRES_IN_MS),
    maxEvaluations: CORE_VALIDATION_MAX_EVALUATIONS };
}
const OPTION_KEYS = ['core', 'store', 'evaluate', 'now', 'sleep', 'signal', 'progress'] as const;
function validateOptions(options: unknown): asserts options is CoreValidationOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new CoreValidationOptionsError('Bounded core validation requires an options object');
  const value = options as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.some(key => !(OPTION_KEYS as readonly string[]).includes(key))) throw new CoreValidationOptionsError('Bounded core validation accepts no caller-supplied objective, budget or other input overrides');
  if (!value.core || typeof value.core !== 'object' || ['create', 'control', 'evaluatePending'].some(name => typeof (value.core as Record<string, unknown>)[name] !== 'function')) {
    throw new CoreValidationOptionsError('Bounded core validation requires the trusted core driver');
  }
  if (!value.store || typeof value.store !== 'object' || typeof (value.store as Record<string, unknown>).request !== 'function') {
    throw new CoreValidationOptionsError('Bounded core validation requires the read-only control store');
  }
  for (const name of ['evaluate', 'now', 'sleep', 'progress'] as const) if (value[name] !== undefined && typeof value[name] !== 'function') throw new CoreValidationOptionsError(`Invalid ${name} port`);
  if (value.signal !== undefined && (typeof value.signal !== 'object' || typeof (value.signal as AbortSignal).aborted !== 'boolean')) {
    throw new CoreValidationOptionsError('Invalid abort signal');
  }
}
/** Real timers by default; tests inject a deterministic clock and sleep. */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
    timer.unref?.();
    signal.addEventListener('abort', abort, { once: true });
  });
}
interface Observation {
  goal?: CoreGoal;
  evaluations: CoreEvaluation[];
  tasks: TaskView[];
  details: Map<string, TaskDetail>;
  plan?: CorePlanView;
  binding?: GoalBinding;
  watermark?: CommitWatermark;
  balance?: { limits: Budget; spent: Budget; held: Budget; available: Budget };
}
interface Judge {
  status?: CoreValidationStatus;
  reasonCode?: CoreValidationReasonCode;
  unknown?: string[];
  error?: { phase: string; code: string; message: string };
}
const TASK_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
const TASK_SUCCESS = 'succeeded';
function budgetSum(...parts: (Partial<Budget> | undefined)[]): Partial<Budget> {
  const result: Partial<Budget> = {};
  for (const axis of ['tokens', 'calls', 'effects'] as const) {
    const values = parts.map(part => part?.[axis]).filter((value): value is number => Number.isSafeInteger(value));
    if (values.length) result[axis] = values.reduce((sum, value) => sum + value, 0);
  }
  return result;
}
function overBudget(limits: Budget, spent: Partial<Budget>, held: Partial<Budget>): boolean {
  return (['tokens', 'calls', 'effects'] as const).some(axis => (spent[axis] ?? 0) + (held[axis] ?? 0) > limits[axis]);
}
function verificationSummary(detail: TaskDetail): CoreValidationTaskSummary['verification'] {
  const verification = detail.task.verification;
  if (!verification) return 'unobserved';
  return verification.checks.every(check => check.status === 'pass') ? 'pass' : 'fail';
}
function candidateSummary(candidate: CoreEvaluation['candidate']): string | undefined {
  if (!candidate) return undefined;
  switch (candidate.kind) {
    case 'plan_candidate': return `plan_candidate v${candidate.plan.basePlanVersion + 1} steps=${candidate.plan.steps.length}`;
    case 'task_intent': return `task_intent deliverable=${candidate.deliverableId}`;
    case 'defer': return `defer retryAfterMs=${candidate.retryAfterMs}`;
    case 'no_action': return 'no_action';
    case 'complete_candidate': return 'complete_candidate';
  }
}
function usageSummary(evaluation: CoreEvaluation): CoreValidationUsage {
  const reservation = evaluation.reservation;
  if (!reservation) return { state: 'absent', observedTokens: null, observedCalls: null, overrun: false, accounting: 'unknown' };
  const tokens = Number.isSafeInteger(reservation.observed?.tokens) ? reservation.observed.tokens! : null;
  const calls = Number.isSafeInteger(reservation.observed?.calls) ? reservation.observed.calls! : null;
  const accounting = reservation.state === 'settled' && !reservation.overrun && tokens !== null && calls !== null ? 'complete' : 'unknown';
  return { state: reservation.state, observedTokens: tokens, observedCalls: calls, overrun: reservation.overrun === true, accounting };
}
function planSummary(plan: CorePlanView | undefined): CoreValidationPlanSummary[] {
  if (!plan || !Array.isArray(plan.history) || !plan.history.length) return [];
  const latest = plan.current ?? plan.history.at(-1)!;
  return [{ planVersion: plan.planVersion, historyCount: plan.history.length,
    ...(latest.planHash ? { latestPlanHash: latest.planHash } : {}), ...(latest.acceptedAt ? { latestAcceptedAt: latest.acceptedAt } : {}),
    steps: latest.steps.slice(0, 16).map(step => ({ stepId: step.stepId, deliverableId: step.deliverableId,
      dependsOn: step.dependsOn.slice(0, 16), expectedSha256: step.expectedSha256 })),
    stopConditions: { onStepFailure: latest.stopConditions.onStepFailure, maxFailedSteps: latest.stopConditions.maxFailedSteps,
      onFactConflict: latest.stopConditions.onFactConflict, maxParallelSteps: latest.stopConditions.maxParallelSteps } }];
}
function nativeSummary(goal: CoreGoal | undefined, binding: GoalBinding | undefined, completedObserved: boolean): CoreValidationNativeSummary {
  const native = goal?.native;
  const receiptStatus = binding?.receipt?.status;
  return { phase: native?.phase ?? 'unobserved',
    ...(native ? { goalRef: { id: native.goalRef.id, revision: native.goalRef.revision }, sessionId: native.sessionId, observedAt: native.observedAt } : {}),
    bindingReceiptStatus: receiptStatus === 'pending' || receiptStatus === 'unknown' || receiptStatus === 'confirmed' || receiptStatus === 'rejected' ? receiptStatus : 'absent',
    completedObserved };
}
function boundedText(value: unknown, max = 240): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
class BoundedValidationRunnerCore {
  private readonly evaluate: CoreValidationEvaluate;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly progress: (phase: string, detail: string) => void;
  private readonly startedAtMs: number;
  private readonly deadlineAtMs: number;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private goalId?: string;
  private pollCount = 0;
  private evaluateAttempts = 0;
  private lastEvaluatedAt = 0;
  private commitSeqBefore?: number;
  private commitSeqAfter?: number;
  private readonly unknowns: string[] = [];
  private completedObserved = false;
  private error?: { phase: string; code: string; message: string };
  private observation: Observation = { evaluations: [], tasks: [], details: new Map() };
  private goal?: CoreGoal;
  private readonly wallTimer: ReturnType<typeof setTimeout>;
  constructor(private readonly options: CoreValidationOptions) {
    this.evaluate = options.evaluate ?? (input => options.core.evaluatePending({ signal: input.signal }));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.progress = options.progress ?? (() => undefined);
    this.startedAtMs = this.now();
    this.deadlineAtMs = this.startedAtMs + CORE_VALIDATION_WALL_MS;
    this.signal = AbortSignal.any([this.controller.signal, ...(options.signal ? [options.signal] : [])]);
    this.wallTimer = setTimeout(() => { try { this.controller.abort(new Error('Bounded core validation wall limit reached')); } catch { /* abort is advisory */ } },
      Math.max(1, CORE_VALIDATION_WALL_MS + 1000));
    this.wallTimer.unref?.();
  }
  private finished = false;
  private async read<T>(operation: () => Promise<T>, code: string): Promise<T | undefined> {
    try { return await operation(); }
    catch (error) { if (!this.unknowns.includes(code)) this.unknowns.push(code); return undefined; }
  }
  private async observe(): Promise<Observation> {
    const goalId = this.goalId!;
    const [goal, evaluations, taskList, plan, binding, watermark] = await Promise.all([
      this.read(() => this.options.store.request('core.get', { goalId }), 'GOAL_READ_UNAVAILABLE'),
      this.read(() => this.options.store.request('core.evaluations', { goalId }), 'EVALUATIONS_READ_UNAVAILABLE'),
      this.read(() => this.options.store.request('task.list', {}), 'TASKS_READ_UNAVAILABLE'),
      this.read(() => this.options.store.request('core.plan', { goalId }), 'PLAN_READ_UNAVAILABLE'),
      this.read(() => this.options.store.request('goal.binding.load', { goalId }), 'BINDING_READ_UNAVAILABLE'),
      this.read(() => this.options.store.request('control.watermark', {}), 'WATERMARK_READ_UNAVAILABLE'),
    ]);
    const goalTasks = (taskList ?? []).filter(task => task.goalId === goalId).slice(0, 16);
    const details = new Map<string, TaskDetail>();
    for (const task of goalTasks.slice(0, 8)) {
      const detail = await this.read(() => this.options.store.request('task.get', { taskId: task.taskId }), 'TASK_DETAIL_UNAVAILABLE');
      if (detail) details.set(task.taskId, detail);
    }
    const balance = await this.read(() => this.options.store.request('core.balance', { goalId }), 'BALANCE_READ_UNAVAILABLE');
    this.commitSeqAfter = watermark?.commitSeq;
    this.observation = { ...(goal ? { goal } : {}), evaluations: evaluations ?? [], tasks: goalTasks, details,
      ...(plan ? { plan } : {}), ...(binding ? { binding } : {}), ...(watermark ? { watermark } : {}), ...(balance ? { balance } : {}) };
    if (goal) { this.goal = goal; if (goal.native?.phase === 'complete') this.completedObserved = true; }
    return this.observation;
  }
  private terminal(observation: Observation): Judge {
    const goal = observation.goal;
    if (!goal) return {};
    if (this.options.signal?.aborted) return { status: 'cancelled', reasonCode: 'CORE_VALIDATION_CANCELLED', unknown: ['EXTERNAL_ABORT'] };
    if (goal.cancelled) return { status: 'cancelled', reasonCode: 'CORE_VALIDATION_CANCELLED' };
    if (goal.paused) return { status: 'paused', reasonCode: 'CORE_VALIDATION_PAUSED_EXTERNALLY' };
    const failedTask = observation.tasks.find(task => task.state === 'failed' || task.state === 'cancelled' || task.state === 'unknown');
    if (failedTask) return { status: 'failed', reasonCode: 'CORE_VALIDATION_TASK_FAILED',
      unknown: failedTask.state === 'unknown' ? ['TASK_UNKNOWN'] : failedTask.state === 'failed' ? ['TASK_FAILED'] : ['TASK_CANCELLED'] };
    if (observation.evaluations.some(evaluation => evaluation.status === 'unknown')) {
      return { status: 'failed', reasonCode: 'CORE_VALIDATION_EVALUATION_UNKNOWN', unknown: ['EVALUATION_UNKNOWN'] };
    }
    if (observation.balance && overBudget(observation.balance.limits, observation.balance.spent, observation.balance.held)) {
      return { status: 'failed', reasonCode: 'CORE_VALIDATION_BUDGET_OVERRUN', unknown: ['BUDGET_OVERRUN'] };
    }
    if (goal.native?.phase === 'complete') {
      const evidence = this.completionEvidence(observation);
      return evidence.ok ? { status: 'completed', reasonCode: 'CORE_VALIDATION_COMPLETED' }
        : { status: 'failed', reasonCode: 'CORE_VALIDATION_EVIDENCE_INCOMPLETE', unknown: evidence.unknown };
    }
    return {};
  }
  private completionEvidence(observation: Observation): { ok: boolean; unknown: string[] } {
    const unknown: string[] = [];
    const goal = observation.goal!;
    const deliverable = CORE_VALIDATION_DELIVERABLE;
    const expectedSha = sha256(deliverable.content);
    for (const ref of goal.taskRefs) {
      const detail = observation.details.get(ref.taskId);
      if (!detail) { unknown.push('TASK_DETAIL_UNAVAILABLE'); continue; }
      if (detail.task.state !== TASK_SUCCESS) unknown.push('TASK_NOT_SUCCEEDED');
      if (verificationSummary(detail) !== 'pass') unknown.push('TASK_VERIFICATION_NOT_PASS');
      if (detail.artifact.expectedSha256 !== expectedSha) unknown.push('ARTIFACT_HASH_MISMATCH');
      const succeeded = detail.effects.filter(effect => effect.status === 'succeeded' && !!effect.receiptId);
      if (!succeeded.length) unknown.push('EFFECT_RECEIPT_MISSING');
      const observed = detail.effectReceipts.find(receipt => receipt.receiptId === succeeded[0]?.receiptId);
      if (!observed || observed.outcome !== 'succeeded') unknown.push('EFFECT_RECEIPT_UNCONFIRMED');
    }
    if (goal.taskRefs.length !== goal.deliverables.length) unknown.push('DELIVERABLE_TASK_MISSING');
    if (goal.native?.phase !== 'complete') unknown.push('NATIVE_PHASE_NOT_COMPLETE');
    return { ok: unknown.length === 0, unknown: [...new Set(unknown)] };
  }
  private async evaluateOnce(): Promise<CoreEvaluationResult> {
    this.evaluateAttempts++;
    const attempt = this.evaluateAttempts;
    this.progress('核心有界验证：第 ' + attempt + ' 次 core 决策轮', 'awaiting trusted core evaluation');
    const result = await this.evaluate({ signal: this.signal });
    this.lastEvaluatedAt = this.now();
    return result;
  }
  private shouldEvaluate(observation: Observation): boolean {
    if (this.evaluateAttempts >= CORE_VALIDATION_MAX_EVALUATIONS) return false;
    if (this.evaluateAttempts === 0) return true;
    // A second evaluation is only for the verified-result completion round: it
    // is attempted once every admitted Task reached a terminal success.
    if (!observation.tasks.length) return false;
    return observation.tasks.every(task => task.state === TASK_SUCCESS);
  }
  private async finish(status: CoreValidationStatus, reasonCode: CoreValidationReasonCode): Promise<CoreValidationReceipt> {
    this.finished = true;
    clearTimeout(this.wallTimer);
    const stopAction = await this.stop(status);
    let observation = this.observation;
    try { observation = await this.observe(); } catch { /* retain the last honest observation */ }
    return this.receipt(status, reasonCode, observation, stopAction);
  }
  private async stop(status: CoreValidationStatus): Promise<CoreValidationStopAction> {
    // A committed evaluation or native round may have advanced the Goal between
    // the last observation and this stop; always re-read the exact current
    // version so the single stop command is not rejected by a stale CAS.
    let goal = this.goal;
    if (goal && goal.goalId) {
      try { goal = (await this.options.store.request('core.get', { goalId: goal.goalId })) ?? goal; } catch { /* bounded by the last honest observation */ }
      this.goal = goal;
    }
    if (status === 'completed' || !goal) return { kind: 'none', attempted: false, ok: null, ...(goal ? { goalVersion: goal.version } : {}) };
    if (goal.paused || goal.cancelled) {
      return { kind: 'none', attempted: false, ok: true, reasonCode: 'ALREADY_STOPPED', at: iso(this.now()), goalVersion: goal.version };
    }
    const kind: CoreValidationStopKind = status === 'cancelled' ? 'cancel' : 'pause';
    this.progress(kind === 'cancel' ? '核心有界验证：显式取消 Goal' : '核心有界验证：显式暂停 Goal', 'single durable stop command, no retry');
    try {
      // Use a fresh non-aborted signal: the stop must not be skipped because the
      // external signal that ended the run is already aborted.
      const stopped = await this.options.core.control(kind, { goalId: goal.goalId, expectedVersion: goal.version }, new AbortController().signal);
      return { kind, attempted: true, ok: true, at: iso(this.now()), goalVersion: stopped.version };
    } catch (error) {
      const code = safeCode(error);
      if (!this.unknowns.includes('STOP_UNCONFIRMED')) this.unknowns.push('STOP_UNCONFIRMED');
      return { kind, attempted: true, ok: false, reasonCode: code, at: iso(this.now()), goalVersion: goal.version };
    }
  }
  private businessSideEffects(observation: Observation): CoreValidationBusinessSideEffects {
    const goal = observation.goal;
    const tasks = observation.tasks;
    const effects = [...observation.details.values()].flatMap(detail => detail.effects);
    const artifacts = [...observation.details.values()].map(detail => ({ taskId: detail.task.taskId, artifactRef: detail.artifact.artifactRef,
      sha256: detail.artifact.expectedSha256, bytes: detail.artifact.byteLength }));
    const workerSessions = [...observation.details.values()].map(detail => detail.execution?.sessionId).filter((value): value is string => !!value);
    const balance = observation.balance;
    return {
      goal: { created: !!goal, ...(goal ? { goalId: goal.goalId, requestId: goal.requestId, version: goal.version } : { requestId: CORE_VALIDATION_REQUEST_ID }) },
      tasks: { count: tasks.length, ids: tasks.slice(0, 8).map(task => task.taskId) },
      effects: { count: effects.length, ids: effects.slice(0, 8).map(effect => effect.effectId) },
      artifacts: { count: artifacts.length, refs: artifacts.slice(0, 8) },
      sessions: { ...(goal?.native?.sessionId ? { goalSessionId: goal.native.sessionId } : {}), workerSessionIds: workerSessions.slice(0, 8) },
      budget: { limits: { ...CORE_VALIDATION_BUDGET }, spent: balance ? budgetSum(balance.spent) : {}, held: balance ? budgetSum(balance.held) : {} },
      control: { ...(this.commitSeqBefore !== undefined ? { commitSeqBefore: this.commitSeqBefore } : {}), ...(this.commitSeqAfter !== undefined ? { commitSeqAfter: this.commitSeqAfter } : {}) },
    };
  }
  private receipt(status: CoreValidationStatus, reasonCode: CoreValidationReasonCode, observation: Observation, stopAction: CoreValidationStopAction): CoreValidationReceipt {
    const end = this.now();
    const goal = observation.goal ?? this.goal;
    const native = nativeSummary(goal, observation.binding, this.completedObserved);
    const receipt: CoreValidationReceipt = {
      schemaVersion: 1, kind: 'bounded-core-goal-validation', status, reasonCode,
      ...(goal ? { goalId: goal.goalId } : {}), requestId: CORE_VALIDATION_REQUEST_ID,
      startedAt: iso(this.startedAtMs), completedAt: iso(Math.max(end, this.startedAtMs)),
      durationMs: Math.max(0, end - this.startedAtMs), fixedInput: structuredClone(FIXED_INPUT),
      counters: { evaluateAttempts: this.evaluateAttempts, pollCount: this.pollCount, maxEvaluations: CORE_VALIDATION_MAX_EVALUATIONS, wallLimitMs: CORE_VALIDATION_WALL_MS },
      ...(goal ? { goal: { goalId: goal.goalId, version: goal.version, requestId: goal.requestId, authorized: goal.authorized,
        paused: goal.paused, cancelled: goal.cancelled, planVersion: goal.planVersion, ...(goal.mandateId ? { mandateId: goal.mandateId } : {}),
        expiresAt: goal.expiresAt, nativePhase: goal.native?.phase ?? 'unobserved' } } : {}),
      evaluations: observation.evaluations.slice(0, 2).map(evaluation => ({ evaluationId: evaluation.evaluationId, status: evaluation.status,
        ...(evaluation.candidate?.kind ?? evaluation.receipt?.kind ? { kind: evaluation.candidate?.kind ?? evaluation.receipt?.kind } : {}),
        ...(evaluation.reasonCode ? { reasonCode: evaluation.reasonCode } : {}),
        ...(candidateSummary(evaluation.candidate) ? { candidateSummary: candidateSummary(evaluation.candidate) } : {}),
        ...(evaluation.goal.planVersion ? { planVersion: evaluation.goal.planVersion } : {}),
        triggerRefs: evaluation.triggerRefs.slice(0, 8).map(ref => boundedText(ref, 120) ?? 'redacted'),
        usage: usageSummary(evaluation) })),
      taskRefs: goal ? goal.taskRefs.slice(0, 8).map(ref => this.taskSummary(ref.deliverableId, ref.taskId, observation)) : [],
      plans: planSummary(observation.plan),
      native,
      ...(observation.balance ? { budget: { limits: { ...observation.balance.limits }, spent: budgetSum(observation.balance.spent),
        held: budgetSum(observation.balance.held), available: budgetSum(observation.balance.available),
        overrun: overBudget(observation.balance.limits, observation.balance.spent, observation.balance.held) } } : {}),
      artifacts: [...observation.details.values()].slice(0, 8).map(detail => {
        const effect = detail.effects.find(item => item.effectId === detail.task.result?.effectRefs[0]) ?? detail.effects[0];
        const receipt = effect?.receiptId ? detail.effectReceipts.find(item => item.receiptId === effect.receiptId) : undefined;
        return { taskId: detail.task.taskId, artifactRef: detail.artifact.artifactRef, expectedSha256: detail.artifact.expectedSha256,
          ...(receipt?.payloadHash ? { observedSha256: receipt.payloadHash } : {}), byteLength: detail.artifact.byteLength,
          verification: verificationSummary(detail) };
      }),
      effects: [...observation.details.values()].flatMap(detail => detail.effects).slice(0, 8).map(effect => ({
        effectId: effect.effectId, status: effect.status, ...(effect.receiptId ? { receiptId: effect.receiptId } : {}) })),
      businessSideEffects: this.businessSideEffects(observation),
      stopAction,
      unknowns: [...new Set(this.unknowns)].slice(0, 16),
      ...(this.error ? { error: this.error } : {}),
    };
    const unknownUsage = receipt.evaluations.some(evaluation => evaluation.usage.accounting === 'unknown');
    if (unknownUsage && !receipt.unknowns.includes('USAGE_UNKNOWN')) receipt.unknowns.push('USAGE_UNKNOWN');
    return receipt;
  }
  private taskSummary(deliverableId: string, taskId: string, observation: Observation): CoreValidationTaskSummary {
    const detail = observation.details.get(taskId);
    if (!detail) return { deliverableId, taskId, state: 'unobserved', version: 0, verification: 'unobserved' };
    const effect = detail.effects.find(item => item.effectId === detail.task.result?.effectRefs[0]) ?? detail.effects[0];
    const receipt = effect?.receiptId ? detail.effectReceipts.find(item => item.receiptId === effect.receiptId) : undefined;
    return { deliverableId, taskId, state: detail.task.state, version: detail.task.version, verification: verificationSummary(detail),
      artifactRef: detail.artifact.artifactRef, expectedSha256: detail.artifact.expectedSha256,
      observedSha256: receipt?.payloadHash ?? undefined, observedBytes: detail.artifact.byteLength,
      ...(effect ? { effectId: effect.effectId, effectStatus: effect.status } : {}), ...(receipt ? { receiptId: receipt.receiptId } : {}) };
  }
  async execute(): Promise<CoreValidationReceipt> {
    this.progress('核心有界验证：创建冻结 Goal', 'frozen owner input only');
    let created: CoreGoal;
    try {
      created = await this.options.core.create(frozenCoreValidationInput(this.startedAtMs), this.signal);
    } catch (error) {
      this.error = { phase: 'create', code: safeCode(error), message: messageOf(error) };
      if (!this.unknowns.includes('GOAL_CREATE_FAILED')) this.unknowns.push('GOAL_CREATE_FAILED');
      if ((error as { code?: string })?.code === 'CORE_VALIDATION_CANCELLED' || this.options.signal?.aborted) return this.finish('cancelled', 'CORE_VALIDATION_CANCELLED');
      return this.finish('failed', 'CORE_VALIDATION_CREATE_FAILED');
    }
    this.goal = created;
    this.goalId = created.goalId;
    if (!created.authorized || created.cancelled || created.native?.phase !== 'active') {
      this.error = { phase: 'create', code: 'CORE_VALIDATION_CREATE_INTEGRITY', message: 'Created Goal is not exactly one active, owner-authorized, native-active Goal' };
      if (!this.unknowns.includes('GOAL_CREATE_INTEGRITY')) this.unknowns.push('GOAL_CREATE_INTEGRITY');
      return this.finish('failed', 'CORE_VALIDATION_CREATE_INTEGRITY');
    }
    const initial = await this.observe();
    this.commitSeqBefore = initial.watermark?.commitSeq;
    this.progress('核心有界验证：观察计划与派工', 'blocked on trusted core decision round');
    while (true) {
      if (this.options.signal?.aborted) return this.finish('cancelled', 'CORE_VALIDATION_CANCELLED');
      const observation = await this.observe();
      const terminal = this.terminal(observation);
      if (terminal.status) {
        if (terminal.unknown) this.unknowns.push(...terminal.unknown);
        return this.finish(terminal.status, terminal.reasonCode!);
      }
      if (this.now() >= this.deadlineAtMs) { if (!this.unknowns.includes('WALL_LIMIT_REACHED')) this.unknowns.push('WALL_LIMIT_REACHED'); return this.finish('timeout', 'CORE_VALIDATION_TIMEOUT'); }
      if (this.shouldEvaluate(observation)) {
        try {
          const result = await this.evaluateOnce();
          if (result.status === 'unknown') {
            if (!this.unknowns.includes('EVALUATION_UNKNOWN')) this.unknowns.push('EVALUATION_UNKNOWN');
            this.error = { phase: 'evaluate', code: 'CORE_VALIDATION_EVALUATION_UNKNOWN', message: boundedText(result.decisionId ?? result.retryAt ?? 'unknown') ?? 'unknown' };
            return this.finish('failed', 'CORE_VALIDATION_EVALUATION_UNKNOWN');
          }
          if (result.status === 'evaluated' && this.now() >= this.deadlineAtMs) return this.finish('timeout', 'CORE_VALIDATION_TIMEOUT');
        } catch (error) {
          if (this.options.signal?.aborted) return this.finish('cancelled', 'CORE_VALIDATION_CANCELLED');
          if (this.now() >= this.deadlineAtMs) { if (!this.unknowns.includes('WALL_LIMIT_REACHED')) this.unknowns.push('WALL_LIMIT_REACHED'); return this.finish('timeout', 'CORE_VALIDATION_TIMEOUT'); }
          this.error = { phase: 'evaluate', code: safeCode(error), message: messageOf(error) };
          if (!this.unknowns.includes('EVALUATION_FAILED')) this.unknowns.push('EVALUATION_FAILED');
          return this.finish('failed', 'CORE_VALIDATION_EVALUATION_FAILED');
        }
        continue;
      }
      // No evaluation is eligible: wait for worker/independent verification or the deadline.
      this.pollCount++;
      try { await this.sleep(CORE_VALIDATION_POLL_MS, this.signal); }
      catch (error) {
        if (this.options.signal?.aborted) return this.finish('cancelled', 'CORE_VALIDATION_CANCELLED');
        this.error = { phase: 'poll', code: safeCode(error), message: messageOf(error) };
        return this.finish('failed', 'CORE_VALIDATION_INTERNAL_ERROR');
      }
      const afterPoll = await this.observe();
      const settled = this.terminal(afterPoll);
      if (settled.status) {
        if (settled.unknown) this.unknowns.push(...settled.unknown);
        return this.finish(settled.status, settled.reasonCode!);
      }
      if (this.evaluateAttempts >= 1 && !afterPoll.tasks.length && afterPoll.goal && afterPoll.goal.planVersion === 0
        && this.lastEvaluatedAt > 0 && this.now() - this.lastEvaluatedAt >= CORE_VALIDATION_NO_PROGRESS_MS) {
        if (!this.unknowns.includes('NO_PROGRESS_AFTER_EVALUATION')) this.unknowns.push('NO_PROGRESS_AFTER_EVALUATION');
        return this.finish('failed', 'CORE_VALIDATION_NO_PROGRESS');
      }
      if (this.now() >= this.deadlineAtMs) { if (!this.unknowns.includes('WALL_LIMIT_REACHED')) this.unknowns.push('WALL_LIMIT_REACHED'); return this.finish('timeout', 'CORE_VALIDATION_TIMEOUT'); }
    }
  }
}
export class BoundedCoreValidationRunner {
  private busy = false;
  async run(options: CoreValidationOptions): Promise<CoreValidationReceipt> {
    validateOptions(options);
    if (this.busy) throw new CoreValidationBusyError();
    this.busy = true;
    try {
      const runner = new BoundedValidationRunnerCore(options);
      const receipt = await runner.execute();
      assertBoundedCoreValidationReceipt(receipt);
      return receipt;
    } finally { this.busy = false; }
  }
}
const sharedRunner = new BoundedCoreValidationRunner();
/** Single-flight process-wide entry point used by the owner runtime command. */
export function runBoundedCoreValidation(options: CoreValidationOptions): Promise<CoreValidationReceipt> {
  return sharedRunner.run(options);
}

const STATUSES: readonly CoreValidationStatus[] = ['completed', 'paused', 'timeout', 'failed', 'cancelled'];
const REASONS: readonly CoreValidationReasonCode[] = ['CORE_VALIDATION_COMPLETED', 'CORE_VALIDATION_PAUSED_EXTERNALLY', 'CORE_VALIDATION_TIMEOUT',
  'CORE_VALIDATION_CANCELLED', 'CORE_VALIDATION_CREATE_FAILED', 'CORE_VALIDATION_CREATE_INTEGRITY', 'CORE_VALIDATION_EVALUATION_FAILED',
  'CORE_VALIDATION_EVALUATION_UNKNOWN', 'CORE_VALIDATION_TASK_FAILED', 'CORE_VALIDATION_NO_PROGRESS', 'CORE_VALIDATION_EVIDENCE_INCOMPLETE',
  'CORE_VALIDATION_BUDGET_OVERRUN', 'CORE_VALIDATION_INTERNAL_ERROR'];
function assertLossless(value: unknown, path: string, depth: number, seen: Set<object>): void {
  if (depth > CORE_VALIDATION_RECEIPT_MAX_DEPTH) throw new Error(`Receipt exceeds maximum depth at ${path}`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`Receipt has a non-lossless number at ${path}`); return; }
  if (typeof value === 'string') { if (value.length > CORE_VALIDATION_RECEIPT_MAX_STRING) throw new Error(`Receipt string is unbounded at ${path}`); return; }
  if (typeof value !== 'object') throw new Error(`Receipt has a non-JSON value at ${path}`);
  if (seen.has(value as object)) throw new Error(`Receipt has a cycle at ${path}`);
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      if (value.length > CORE_VALIDATION_RECEIPT_MAX_ARRAY) throw new Error(`Receipt array is unbounded at ${path}`);
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new Error(`Receipt array is sparse at ${path}`);
        assertLossless(value[index], `${path}[${index}]`, depth + 1, seen);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`Receipt has a non-plain object at ${path}`);
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) throw new Error(`Receipt has an invalid key at ${path}`);
      assertLossless(record[key], `${path}.${key}`, depth + 1, seen);
    }
  } finally { seen.delete(value as object); }
}
/** Strict independent validator: plain lossless JSON, bounded size/arrays/strings, required shape. */
export function assertBoundedCoreValidationReceipt(value: unknown): asserts value is CoreValidationReceipt {
  assertLossless(value, '$', 0, new Set());
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > CORE_VALIDATION_RECEIPT_MAX_BYTES) throw new Error('Receipt exceeds its bounded byte size');
  const receipt = value as CoreValidationReceipt;
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'bounded-core-goal-validation') throw new Error('Receipt header is invalid');
  if (!STATUSES.includes(receipt.status) || !REASONS.includes(receipt.reasonCode)) throw new Error('Receipt status or reason code is invalid');
  for (const field of ['startedAt', 'completedAt'] as const) {
    if (typeof receipt[field] !== 'string' || new Date(receipt[field]).toISOString() !== receipt[field]) throw new Error(`Receipt ${field} is not canonical UTC`);
  }
  if (!Number.isSafeInteger(receipt.durationMs) || receipt.durationMs < 0) throw new Error('Receipt duration is invalid');
  if (receipt.requestId !== CORE_VALIDATION_REQUEST_ID) throw new Error('Receipt request identity changed');
  if (receipt.fixedInput?.frozen !== true || receipt.fixedInput.templateSha256 !== CORE_VALIDATION_TEMPLATE_SHA256
    || receipt.fixedInput.objectiveSha256 !== FIXED_INPUT.objectiveSha256
    || receipt.fixedInput.deliverable?.contentSha256 !== FIXED_INPUT.deliverable.contentSha256
    || canonical(receipt.fixedInput.budget) !== canonical(CORE_VALIDATION_BUDGET)) throw new Error('Receipt fixed input is not the frozen owner template');
  const counters = receipt.counters;
  if (!counters || !Number.isSafeInteger(counters.evaluateAttempts) || counters.evaluateAttempts < 0 || counters.evaluateAttempts > CORE_VALIDATION_MAX_EVALUATIONS
    || !Number.isSafeInteger(counters.pollCount) || counters.pollCount < 0 || counters.maxEvaluations !== CORE_VALIDATION_MAX_EVALUATIONS
    || counters.wallLimitMs !== CORE_VALIDATION_WALL_MS) throw new Error('Receipt counters are outside the frozen hard stops');
  if (!Array.isArray(receipt.evaluations) || receipt.evaluations.length > 2) throw new Error('Receipt evaluation list is invalid');
  for (const evaluation of receipt.evaluations!) {
    if (!evaluation || typeof evaluation.evaluationId !== 'string' || typeof evaluation.status !== 'string') throw new Error('Receipt evaluation is invalid');
    if (!evaluation.usage || !['reserved', 'unknown', 'settled', 'absent'].includes(evaluation.usage.state)
      || !(evaluation.usage.observedTokens === null || Number.isSafeInteger(evaluation.usage.observedTokens))
      || !(evaluation.usage.observedCalls === null || Number.isSafeInteger(evaluation.usage.observedCalls))
      || !['complete', 'unknown'].includes(evaluation.usage.accounting)) throw new Error('Receipt evaluation usage is invalid');
  }
  if (!Array.isArray(receipt.taskRefs) || receipt.taskRefs.length > CORE_VALIDATION_RECEIPT_MAX_ARRAY) throw new Error('Receipt task list is invalid');
  if (!Array.isArray(receipt.plans) || receipt.plans.length > 2) throw new Error('Receipt plan list is invalid');
  if (!receipt.native || !['active', 'paused', 'blocked', 'complete', 'unobserved'].includes(receipt.native.phase)) throw new Error('Receipt native summary is invalid');
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length > CORE_VALIDATION_RECEIPT_MAX_ARRAY
    || receipt.artifacts.some(entry => !entry || typeof entry.taskId !== 'string' || typeof entry.artifactRef !== 'string'
      || typeof entry.expectedSha256 !== 'string' || !Number.isSafeInteger(entry.byteLength) || typeof entry.verification !== 'string')) {
    throw new Error('Receipt artifact summary is invalid');
  }
  if (!Array.isArray(receipt.effects) || receipt.effects.length > CORE_VALIDATION_RECEIPT_MAX_ARRAY
    || receipt.effects.some(entry => !entry || typeof entry.effectId !== 'string' || typeof entry.status !== 'string')) {
    throw new Error('Receipt effect summary is invalid');
  }
  if (!receipt.businessSideEffects || typeof receipt.businessSideEffects.goal !== 'object' || !Array.isArray(receipt.businessSideEffects.tasks.ids)
    || !Array.isArray(receipt.businessSideEffects.effects.ids) || !Array.isArray(receipt.businessSideEffects.artifacts.refs)
    || !Array.isArray(receipt.businessSideEffects.sessions.workerSessionIds)) throw new Error('Receipt business side effects are invalid');
  if (!receipt.stopAction || !['none', 'pause', 'cancel'].includes(receipt.stopAction.kind) || typeof receipt.stopAction.attempted !== 'boolean') throw new Error('Receipt stop action is invalid');
  if (!Array.isArray(receipt.unknowns) || receipt.unknowns.length > 16 || receipt.unknowns.some(code => typeof code !== 'string' || code.length > 120)) throw new Error('Receipt unknowns are invalid');
  if (receipt.error !== undefined && (typeof receipt.error.phase !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(receipt.error.code))) throw new Error('Receipt error is invalid');
  if (receipt.status === 'completed' && (receipt.native.phase !== 'complete' || receipt.evaluations.length < 1)) throw new Error('Completed receipt lacks native completion evidence');
}
