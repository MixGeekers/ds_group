import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CoreAccounting, CoreCandidate, CoreCommands, CoreCommitReceipt, CoreCompletionRequest, CoreDispatchBinding,
  CoreDomainRequest, CoreEvaluation, CoreEvaluationPermit, CoreGoal, CoreNativeObservation, CoreNativeResultReceipt,
  CorePrepareInput, CoreTaskDelegation, CoreReadCapture, CorePlanDraft, CorePlanFactRef, CorePlanFactStatus, CorePlanSnapshot,
  CorePlanStep, CorePlanStepView, CorePlanStopConditions, CorePlanVersion, CorePlanView } from '../../contracts/core.js';
import { CORE_KNOWN_REJECTIONS } from '../../contracts/core.js';
import type { CapabilityAuthorityPort, CapabilityCapture } from '../../contracts/capability.js';
import type { StatePublicationStore } from '../../state/publication.js';
import type { LocalReadSafetyStore } from '../../state/safety.js';
import type { CommitWatermarkReader } from './commit-watermark.js';
import type { GoalCompletionProof } from '../dsh/goals.js';
import type { BudgetReservation, TrustedPolicyActor } from '../../control/policy/mandates.js';
import { CORE_DISPATCHER, CORE_VERIFIER, createControlAuthority } from './authority.js';
import type { SQLiteGoalBindingStore } from './goal-bindings.js';
import type { TaskDomain, TaskRuntimeIdentity } from './task-domain.js';
import { SqliteTransactions } from './transaction.js';
import { inspectTaskEvidence } from '../../control/goal-lifecycle.js';

export class CoreDomainError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'CoreDomainError'; }
}
const fail = (code: string, message: string): never => { throw new CoreDomainError(code, message); };
const OWNER: TrustedPolicyActor = { principalId: 'local-owner', kind: 'owner', scopes: ['local-owner'] };
export const CORE_EVALUATION_BUDGET = Object.freeze({ tokens: 16384, calls: 2, effects: 0 });
/** Bounded plan surface. Limits cover every model-supplied collection and the
 * replayable revision history; all are enforced before any durable effect. */
export const CORE_PLAN_LIMITS = Object.freeze({ steps: 16, dependencies: 16, factsPerStep: 8,
  reasoningRefs: 32, history: 16, parallelDefault: 2 });
const PLAN_FACT_KINDS = Object.freeze(['owner_basis', 'trigger', 'task', 'capability'] as const);
const PLAN_VERIFIER = Object.freeze({ kind: 'local-note' as const, verifier: 'artifact.sha256.v1' as const });
const FACT_REF = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/;
const STEP_ID = /^[A-Za-z0-9_-]{1,40}$/;
/** The single accepted artifact verifier is bound by the owner-authorized capability. */
const sameArtifact = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value)
  && canonical(value) === canonical(PLAN_VERIFIER);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => hash(canonical(value));
const clone = <T>(value: T): T => structuredClone(value);
function object(input: unknown, keys: string[], required = keys): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))
    || required.some(key => !Object.hasOwn(input, key))) fail('INVALID_CORE_INPUT', 'Unknown or missing Core fields');
}
function text(value: unknown, field: string, max = 300): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail('INVALID_CORE_INPUT', `Invalid ${field}`);
}
function number(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail('INVALID_CORE_INPUT', `Invalid ${field}`);
}
function date(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('INVALID_CORE_INPUT', `Invalid ${field}`);
}
function sha(value: unknown): void { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('INVALID_CORE_INPUT', 'Invalid content hash'); }
function nativeRef(value: CoreNativeObservation['goalRef']): void {
  object(value, ['id', 'revision']); text(value.id, 'native goal id'); number(value.revision, 'native revision', 1);
}
interface Options {
  runtimeIdentity: TaskRuntimeIdentity; tasks: TaskDomain; goals: Pick<SQLiteGoalBindingStore, 'load'>;
  capability: CapabilityAuthorityPort; publication: StatePublicationStore; safety: LocalReadSafetyStore; watermark: CommitWatermarkReader;
  now?: () => Date; isPaused?: () => boolean;
}
interface StoredEvaluation extends CoreEvaluation { proposalHash?: string }

/**
 * Synchronous control admission only. DSH owns Goal phase/rounds/Session; this
 * store owns finite owner capability, invocation receipts and proposal intake.
 * No native/model/filesystem work occurs in these transactions. Reads neither
 * publish projections nor manufacture a planning round.
 */
export class CoreDomain {
  private readonly mandates;
  private admitting?: { goalId: string; deliverableId: string; kind: 'task_intent' | 'step_intent'; stepId?: string; planVersion?: number };
  constructor(private readonly db: DatabaseSync, private readonly tx: SqliteTransactions, private readonly options: Options) {
    if (!tx.owns(db)) fail('TRANSACTION_MISMATCH', 'Core and Task must use the shared transaction connection');
    text(options.runtimeIdentity.hostEpoch, 'host epoch'); text(options.runtimeIdentity.installationGeneration, 'installation generation');
    this.mandates = createControlAuthority(db, tx, { now: () => this.now() });
    tx.atomic(() => {
      const names = ['shiyu_core_meta', 'shiyu_core_goals', 'shiyu_core_evaluations', 'shiyu_core_facts', 'shiyu_core_accounting'];
      const present = names.filter(name => db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
      if (present.length && present.length !== names.length) fail('CORRUPT_CORE', 'Incomplete Core schema requires explicit recovery');
      if (!present.length) db.exec(`
        CREATE TABLE shiyu_core_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,fence INTEGER NOT NULL);
        INSERT INTO shiyu_core_meta VALUES(1,1,0);
        CREATE TABLE shiyu_core_goals(goal_id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,input_hash TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)));
        CREATE TABLE shiyu_core_evaluations(evaluation_id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)));
        CREATE TABLE shiyu_core_facts(fact_id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,consumed_by TEXT,value TEXT NOT NULL CHECK(json_valid(value)));
        CREATE TABLE shiyu_core_accounting(receipt_id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)));
      `);
      if (db.prepare('SELECT schema_version FROM shiyu_core_meta WHERE id=1').get()?.schema_version !== 1) fail('CORRUPT_CORE', 'Missing or incompatible Core schema baseline');
      // An old process exiting does not prove its native inference did not run.
      for (const evaluation of this.evaluations()) {
        if (evaluation.status === 'claimed' || evaluation.status === 'dispatching') this.unknown(evaluation.permit, 'runtime_reopened_requires_reconciliation');
      }
    });
    options.tasks.setCoreAuthority((goalId, deliverableId) => this.delegation(goalId, deliverableId));
    options.tasks.setCorePauseObserver(() => {
      for (const goal of this.all()) if (goal.activeEvaluationId) {
        const active = this.evaluations(goal.goalId).find(item => item.evaluationId === goal.activeEvaluationId)!;
        this.unknown(active.permit, 'global_control_paused'); goal.controlEpoch++; this.save(goal);
      }
    });
  }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private at(): string { return this.now().toISOString(); }
  private read(goalId: string): CoreGoal {
    this.tx.assertUsable(); text(goalId, 'goalId');
    const row = this.db.prepare('SELECT value FROM shiyu_core_goals WHERE goal_id=?').get(goalId);
    if (!row) return fail('UNKNOWN_CORE_GOAL', 'Owner Core capability is absent');
    const goal = JSON.parse(String(row.value)) as CoreGoal;
    // Legacy rows predate the plan surface; planVersion has one durable meaning:
    // zero accepted revisions. No read writes or upgrades persisted rows.
    if (!Number.isSafeInteger(goal.planVersion) || goal.planVersion < 0) goal.planVersion = 0;
    return goal;
  }
  get(goalId: string): CoreGoal { return clone(this.read(goalId)); }
  private save(goal: CoreGoal, changed = true): void {
    if (changed) goal.version++;
    goal.updatedAt = this.at();
    this.db.prepare('UPDATE shiyu_core_goals SET value=? WHERE goal_id=?').run(JSON.stringify(goal), goal.goalId);
  }
  private all(): CoreGoal[] { return this.db.prepare('SELECT value FROM shiyu_core_goals ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as CoreGoal); }
  private evaluations(goalId?: string): StoredEvaluation[] {
    return (goalId ? this.db.prepare('SELECT value FROM shiyu_core_evaluations WHERE goal_id=? ORDER BY rowid').all(goalId)
      : this.db.prepare('SELECT value FROM shiyu_core_evaluations ORDER BY rowid').all()).map(row => JSON.parse(String(row.value)) as StoredEvaluation);
  }
  private evaluation(permit: CoreEvaluationPermit): StoredEvaluation {
    const row = this.db.prepare('SELECT value FROM shiyu_core_evaluations WHERE evaluation_id=?').get(permit?.evaluationId);
    const value = row ? JSON.parse(String(row.value)) as StoredEvaluation : fail('UNKNOWN_CORE_EVALUATION', 'Evaluation is absent');
    if (canonical(value.permit) !== canonical(permit)) fail('STALE_CORE_PERMIT', 'Permit does not match persisted invocation');
    return value;
  }
  private saveEvaluation(value: StoredEvaluation): void { this.db.prepare('UPDATE shiyu_core_evaluations SET value=? WHERE evaluation_id=?').run(JSON.stringify(value), value.evaluationId); }
  private checkVersion(goal: CoreGoal, version: number): void { number(version, 'expectedVersion', 1); if (goal.version !== version) fail('VERSION_CONFLICT', 'Core owner capability changed'); }
  private checkNative(goal: CoreGoal, fresh = true, completionCheck = false): void {
    const observed = goal.native, binding = this.options.goals.load(goal.goalId);
    const pending = binding?.receipt;
    const matchingPendingCompletion = completionCheck && pending?.status === 'pending' && pending.operation === 'complete'
      && canonical(pending.expectedRef) === canonical(observed?.goalRef)
      && pending.completionProof?.completionCriteriaHash === goal.completionCriteriaHash
      && canonical(pending.completionProof.goalRef) === canonical(observed?.goalRef);
    if (!observed || !binding || binding.ownerId !== OWNER.principalId || binding.scope !== 'local-owner'
      || binding.sessionId !== observed.sessionId || binding.completionCriteriaHash !== goal.completionCriteriaHash
      || canonical(binding.goalRef) !== canonical(observed.goalRef) || binding.receipt?.status !== 'confirmed' && !matchingPendingCompletion) fail('STALE_NATIVE_GOAL', 'Native Goal binding lacks a matching confirmed observation');
    if (observed!.phase !== 'active' || fresh && this.now().getTime() - Date.parse(observed!.observedAt) > 60000 || Date.parse(observed!.observedAt) > this.now().getTime() + 1000) fail('NATIVE_GOAL_NOT_ACTIVE', 'A fresh trusted active native Goal observation is required');
  }
  private running(goal: CoreGoal, freshNative = true, completionCheck = false): void {
    if (this.options.tasks.isPaused() || this.options.isPaused?.()) fail('CORE_PAUSED', 'Global control dispatch is paused');
    if (!goal.authorized || goal.paused || goal.cancelled) fail('CORE_PAUSED', 'Owner Core capability is not active');
    if (goal.expiresAt <= this.at()) fail('CORE_EXPIRED', 'Owner Core capability expired');
    this.checkNative(goal, freshNative, completionCheck);
    const mandate = this.mandates.get(OWNER, goal.mandateId!);
    if (mandate.state !== 'active') fail('CORE_PAUSED', 'Shared Goal mandate is not active');
    if (this.mandates.health().frozen) fail('BUDGET_FROZEN', 'Policy budget is frozen');
  }
  private captureTasks(goal: CoreGoal): CoreEvaluation['tasks'] {
    return goal.taskRefs.map(ref => {
      const task = this.options.tasks.get(ref.taskId);
      return { ...ref, version: task.task.version, state: task.task.state,
        effectVersions: task.effects.map(effect => ({ effectId: effect.effectId, version: effect.version, status: effect.status })) };
    });
  }
  /** Current accepted plan revision. 0 means the legacy unplanned single-step path. */
  private currentPlan(goal: CoreGoal): CorePlanVersion | undefined {
    const plans = goal.plans;
    if (!Array.isArray(plans) || !plans.length) return undefined;
    const current = plans.at(-1)!;
    return current.planVersion === goal.planVersion ? current : undefined;
  }
  private remainingDeliverables(goal: CoreGoal): CoreGoal['deliverables'] {
    return goal.deliverables.filter(item => !goal.taskRefs.some(ref => ref.deliverableId === item.id));
  }
  private planTaskStates(goal: CoreGoal): { failed: number; unknown: boolean } {
    let failed = 0, unknown = false;
    for (const ref of goal.taskRefs) {
      const state = this.options.tasks.get(ref.taskId).task.state;
      if (state === 'unknown') unknown = true;
      if (state === 'failed' || state === 'cancelled') failed++;
    }
    return { failed, unknown };
  }
  /** Trusted fact catalog for one Goal. Identifiers come from the control ledger,
   * the current ability authority and the persisted evaluation triggers only. */
  private planFactCatalog(goal: CoreGoal): Map<string, CorePlanFactStatus> {
    const catalog = new Map<string, CorePlanFactStatus>();
    const add = (kind: CorePlanFactRef['kind'], ref: string, state: CorePlanFactStatus['state'], digestValue?: string,
      observedAt?: string, reasonCode?: string): void => {
      const key = `${kind}\u0000${ref}`;
      if (catalog.has(key)) return;
      catalog.set(key, { kind, ref, state, ...(digestValue ? { digest: digestValue } : {}),
        ...(observedAt ? { observedAt } : {}), ...(reasonCode ? { reasonCode } : {}) });
    };
    add('owner_basis', `owner-core-request:${goal.requestId}`, 'resolved', digest(goal.requestId), goal.createdAt);
    for (const row of this.db.prepare('SELECT fact_id,value FROM shiyu_core_facts WHERE goal_id=? ORDER BY rowid').all(goal.goalId)) {
      add('trigger', String(row.fact_id), 'resolved', digest(JSON.parse(String(row.value))));
    }
    for (const ref of goal.taskRefs) {
      const detail = this.options.tasks.get(ref.taskId);
      const state = detail.task.state;
      const observedAt = detail.task.updatedAt;
      const source = digest({ taskId: ref.taskId, version: detail.task.version, state, artifactRef: detail.artifact.artifactRef,
        expectedSha256: detail.artifact.expectedSha256 });
      if (state === 'succeeded') add('task', ref.taskId, 'resolved', source, observedAt);
      else if (state === 'failed' || state === 'cancelled') add('task', ref.taskId, 'conflict', source, observedAt, 'task_terminal_non_success');
      else if (state === 'unknown') add('task', ref.taskId, 'unknown', source, observedAt, 'task_result_unknown');
      else add('task', ref.taskId, 'pending', source, observedAt);
    }
    try {
      const capability = this.options.capability.captureForCore();
      const usable = capability.record.enabled === true && capability.record.usableForAuthorizedTask === true;
      add('capability', capability.ref.capabilityId, usable ? 'resolved' : 'conflict', digest(capability.record), capability.capturedAt,
        usable ? undefined : 'capability_not_usable');
    } catch { /* No captured ability authority means no citable capability fact. */ }
    return catalog;
  }
  private factKey(kind: CorePlanFactRef['kind'], ref: string): string { return `${kind}\u0000${ref}`; }
  /** Resolve model-cited facts. Missing sources stay explicit `unsourced`; they
   * are never replaced with an optimistic default. */
  private resolvePlanFacts(goal: CoreGoal, refs: readonly CorePlanFactRef[]): CorePlanFactStatus[] {
    const catalog = this.planFactCatalog(goal), resolved: CorePlanFactStatus[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = this.factKey(ref.kind, ref.ref);
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push(catalog.get(key) ?? { kind: ref.kind, ref: ref.ref, state: 'unsourced', reasonCode: 'fact_source_missing' });
    }
    return resolved;
  }
  private planStepViews(goal: CoreGoal, plan: CorePlanVersion, facts: readonly CorePlanFactStatus[]): CorePlanStepView[] {
    const byStep = new Map(plan.steps.map(step => [step.stepId, step]));
    const taskFor = (deliverableId: string) => goal.taskRefs.find(ref => ref.deliverableId === deliverableId);
    const factStates = new Map(facts.map(item => [this.factKey(item.kind, item.ref), item.state]));
    const memo = new Map<string, CorePlanStepView['state']>();
    const stepState = (step: CorePlanStep): CorePlanStepView['state'] => {
      const known = memo.get(step.stepId); if (known) return known;
      const ref = taskFor(step.deliverableId);
      let state: CorePlanStepView['state'];
      if (ref) {
        const taskState = this.options.tasks.get(ref.taskId).task.state;
        state = taskState === 'succeeded' ? 'done' : taskState === 'failed' || taskState === 'cancelled' ? 'failed'
          : taskState === 'unknown' ? 'unknown' : 'active';
      } else {
        const deliverable = goal.deliverables.find(item => item.id === step.deliverableId)!;
        const dependencyBlocked = (deliverable.dependsOn ?? []).some(dependency => {
          const dependencyTask = taskFor(dependency);
          return !dependencyTask || this.options.tasks.get(dependencyTask.taskId).task.state !== 'succeeded';
        });
        const planBlocked = step.dependsOn.some(dependency => stepState(byStep.get(dependency)!) !== 'done');
        const factsResolved = step.requiredFacts.every(item => factStates.get(this.factKey(item.kind, item.ref)) === 'resolved');
        state = dependencyBlocked || planBlocked ? 'blocked_dependency' : !factsResolved ? 'blocked_fact' : 'ready';
      }
      memo.set(step.stepId, state); return state;
    };
    return plan.steps.map(step => {
      const ref = taskFor(step.deliverableId);
      return { ...clone(step), state: stepState(step),
        ...(ref ? { taskId: ref.taskId, taskState: this.options.tasks.get(ref.taskId).task.state } : {}) };
    });
  }
  /** Bounded stop policy over admitted work and current required facts. It can
   * only stop or hold; it never enlarges owner budget, expiry or authority. */
  private planStopped(goal: CoreGoal, plan: CorePlanVersion, facts: readonly CorePlanFactStatus[],
    steps: readonly CorePlanStepView[]): string | undefined {
    const { failed } = this.planTaskStates(goal);
    const tolerated = plan.stopConditions.onStepFailure === 'stop' ? 0 : plan.stopConditions.maxFailedSteps;
    if (failed) {
      if (plan.stopConditions.onStepFailure === 'stop' || failed > tolerated) {
        return plan.stopConditions.onStepFailure === 'stop' ? 'plan_stopped_step_failed' : 'plan_stopped_failure_limit';
      }
    }
    if (plan.stopConditions.onFactConflict === 'stop' && facts.some(item => item.state === 'conflict')) return 'plan_stopped_fact_conflict';
    return undefined;
  }
  private planSnapshot(goal: CoreGoal, plan: CorePlanVersion, capturedAt: string): CorePlanSnapshot {
    const facts = this.resolvePlanFacts(goal, plan.steps.flatMap(step => step.requiredFacts));
    const steps = this.planStepViews(goal, plan, facts);
    const stopped = this.planStopped(goal, plan, facts, steps);
    const catalog = this.planFactCatalog(goal);
    return { schemaVersion: 2, goalId: goal.goalId, planVersion: plan.planVersion, capturedAt,
      current: clone(plan), steps, facts,
      availableFacts: [...catalog.values()].map(item => ({ kind: item.kind, ref: item.ref })),
      ...(stopped ? { stopped: { reasonCode: stopped } } : {}) };
  }
  private allowedReasoningRefs(goal: CoreGoal, evaluation?: CoreEvaluation): Set<string> {
    const allowed = new Set<string>([goal.goalId, `goal:${goal.goalId}`, `owner-core-request:${goal.requestId}`]);
    const catalog = this.planFactCatalog(goal);
    for (const item of catalog.values()) { allowed.add(item.ref); allowed.add(`${item.kind}:${item.ref}`); }
    if (goal.planVersion) allowed.add(`plan:${goal.goalId}:${goal.planVersion}`);
    for (const ref of evaluation?.triggerRefs ?? []) allowed.add(ref);
    return allowed;
  }
  /** Strict structural parse of the model-owned plan candidate. Trusted material
   * (hashes, verifier target, budget, mandate, tool identity) has no fields here. */
  private planDraft(value: unknown): CorePlanDraft {
    object(value, ['basePlanVersion', 'steps', 'stopConditions', 'reasoningRefs', 'summary']);
    const draft = value as Record<string, any>;
    number(draft.basePlanVersion, 'basePlanVersion', 0, CORE_PLAN_LIMITS.history * 1000);
    text(draft.summary, 'plan summary', 1000);
    if (!Array.isArray(draft.reasoningRefs) || !draft.reasoningRefs.length || draft.reasoningRefs.length > CORE_PLAN_LIMITS.reasoningRefs
      || new Set(draft.reasoningRefs).size !== draft.reasoningRefs.length) fail('INVALID_CORE_CANDIDATE', 'Invalid plan reasoning references');
    for (const ref of draft.reasoningRefs as unknown[]) { if (typeof ref !== 'string' || !FACT_REF.test(ref)) fail('INVALID_CORE_CANDIDATE', 'Invalid plan reasoning reference'); }
    if (!Array.isArray(draft.steps) || !draft.steps.length || draft.steps.length > CORE_PLAN_LIMITS.steps) fail('INVALID_CORE_CANDIDATE', 'Invalid plan step count');
    const stepIds = new Set<string>(), deliverableIds = new Set<string>(), steps: CorePlanStep[] = [];
    for (const rawStep of draft.steps as unknown[]) {
      object(rawStep, ['stepId', 'deliverableId', 'dependsOn', 'requiredFacts', 'expectedArtifact']);
      const step = rawStep as Record<string, any>;
      if (typeof step.stepId !== 'string' || !STEP_ID.test(step.stepId) || stepIds.has(step.stepId)) fail('INVALID_CORE_CANDIDATE', 'Invalid plan step identity');
      stepIds.add(step.stepId);
      if (typeof step.deliverableId !== 'string' || !step.deliverableId || step.deliverableId.length > 80 || deliverableIds.has(step.deliverableId)) {
        fail('INVALID_CORE_CANDIDATE', 'Invalid plan deliverable selection');
      }
      deliverableIds.add(step.deliverableId);
      if (!Array.isArray(step.dependsOn) || step.dependsOn.length > CORE_PLAN_LIMITS.dependencies
        || new Set(step.dependsOn).size !== step.dependsOn.length) fail('INVALID_CORE_CANDIDATE', 'Invalid plan dependency list');
      for (const dependency of step.dependsOn as unknown[]) { if (typeof dependency !== 'string' || !STEP_ID.test(dependency)) fail('INVALID_CORE_CANDIDATE', 'Invalid plan dependency identity'); }
      if (!Array.isArray(step.requiredFacts) || step.requiredFacts.length > CORE_PLAN_LIMITS.factsPerStep) fail('INVALID_CORE_CANDIDATE', 'Invalid plan fact list');
      const requiredFacts: CorePlanFactRef[] = [];
      for (const rawFact of step.requiredFacts as unknown[]) {
        object(rawFact, ['kind', 'ref']);
        const fact = rawFact as Record<string, any>;
        if (!PLAN_FACT_KINDS.includes(fact.kind)) fail('INVALID_CORE_CANDIDATE', 'Unsupported plan fact kind');
        if (typeof fact.ref !== 'string' || !FACT_REF.test(fact.ref)) fail('INVALID_CORE_CANDIDATE', 'Invalid plan fact reference');
        requiredFacts.push({ kind: fact.kind, ref: fact.ref });
      }
      if (!sameArtifact(step.expectedArtifact)) fail('INVALID_CORE_CANDIDATE', 'Unsupported plan artifact verifier');
      steps.push({ stepId: step.stepId, deliverableId: step.deliverableId, dependsOn: [...step.dependsOn],
        requiredFacts, expectedArtifact: { ...PLAN_VERIFIER } });
    }
    for (const step of steps) for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) fail('CORE_PLAN_STRUCTURE_INVALID', 'Plan dependency names no declared step');
    }
    const visiting = new Set<string>(), visited = new Set<string>();
    const byStep = new Map(steps.map(step => [step.stepId, step]));
    const visit = (id: string): void => {
      if (visiting.has(id)) fail('CORE_PLAN_STRUCTURE_INVALID', 'Plan step dependency cycle');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of byStep.get(id)!.dependsOn) visit(dependency);
      visiting.delete(id); visited.add(id);
    };
    for (const id of stepIds) visit(id);
    object(draft.stopConditions, ['onStepFailure', 'maxFailedSteps', 'onFactConflict', 'maxParallelSteps']);
    const stops = draft.stopConditions as Record<string, any>;
    if (!['stop', 'continue_independent'].includes(stops.onStepFailure)) fail('INVALID_CORE_CANDIDATE', 'Unsupported plan failure policy');
    if (!['wait', 'stop'].includes(stops.onFactConflict)) fail('INVALID_CORE_CANDIDATE', 'Unsupported plan fact policy');
    number(stops.maxFailedSteps, 'maxFailedSteps', 0, 3);
    number(stops.maxParallelSteps, 'maxParallelSteps', 1, CORE_PLAN_LIMITS.parallelDefault);
    if (stops.maxFailedSteps > steps.length && stops.onStepFailure === 'continue_independent') fail('INVALID_CORE_CANDIDATE', 'Failure allowance exceeds plan step count');
    return clone({ basePlanVersion: draft.basePlanVersion, steps,
      stopConditions: { onStepFailure: stops.onStepFailure, maxFailedSteps: stops.maxFailedSteps,
        onFactConflict: stops.onFactConflict, maxParallelSteps: stops.maxParallelSteps },
      reasoningRefs: [...draft.reasoningRefs], summary: draft.summary }) as CorePlanDraft;
  }
  /** Validate one candidate plan against current owner authority, trusted facts
   * and the existing Task/Mandate machinery. It never grants new authority. */
  private validatePlan(goal: CoreGoal, evaluation: CoreEvaluation, draft: CorePlanDraft): {
    version: CorePlanVersion; facts: CorePlanFactStatus[] } {
    if (draft.basePlanVersion !== goal.planVersion) fail('CORE_PLAN_STALE', 'Plan candidate targets another revision');
    if ((goal.plans?.length ?? 0) >= CORE_PLAN_LIMITS.history) fail('CORE_PLAN_LIMIT', 'Plan revision history is exhausted');
    const remaining = this.remainingDeliverables(goal);
    if (!remaining.length) fail('CORE_PLAN_INCOMPLETE', 'No unowned owner deliverable needs a new plan revision');
    const deliverableIds = new Set(remaining.map(item => item.id));
    for (const step of draft.steps) {
      const deliverable = goal.deliverables.find(item => item.id === step.deliverableId);
      if (!deliverable) fail('CORE_SCOPE_DENIED', 'Plan selects an ungranted owner deliverable');
      if (goal.taskRefs.some(ref => ref.deliverableId === step.deliverableId)) fail('CORE_DELIVERABLE_OWNED', 'Plan reselects an already owned deliverable');
      if (!deliverableIds.has(step.deliverableId)) fail('CORE_PLAN_INCOMPLETE', 'Plan selects a deliverable outside the remaining scope');
      if (!sameArtifact(step.expectedArtifact)) fail('CORE_PLAN_VERIFIER_DENIED', 'Plan cannot choose another artifact verifier');
    }
    if (draft.steps.length !== remaining.length) fail('CORE_PLAN_INCOMPLETE', 'Plan must cover every unowned owner deliverable once');
    const byDeliverable = new Map(draft.steps.map(step => [step.deliverableId, step]));
    const byStep = new Map(draft.steps.map(step => [step.stepId, step]));
    for (const step of draft.steps) {
      const deliverable = goal.deliverables.find(item => item.id === step.deliverableId)!;
      for (const dependencyId of deliverable.dependsOn ?? []) {
        const dependencyDeliverable = goal.deliverables.find(item => item.id === dependencyId)!;
        const owned = goal.taskRefs.find(ref => ref.deliverableId === dependencyId);
        if (owned) {
          const state = this.options.tasks.get(owned.taskId).task.state;
          // A running dependency can be waited on; a terminal non-success or
          // an uncertain dependency cannot back a new plan revision.
          if (state === 'failed' || state === 'cancelled' || state === 'unknown') {
            fail('CORE_PLAN_DEPENDENCY_CONFLICT', 'An owner dependency is terminally non-successful or uncertain');
          }
          continue;
        }
        const dependencyStep = byDeliverable.get(dependencyDeliverable.id);
        if (!dependencyStep) fail('CORE_PLAN_INCOMPLETE', 'Plan omits an unowned owner dependency');
        // Every declared owner dependency must be a transitive plan prerequisite.
        const reachable = new Set<string>(); const stack = [...step.dependsOn];
        while (stack.length) { const id = stack.pop()!; if (reachable.has(id)) continue; reachable.add(id); stack.push(...(byStep.get(id)?.dependsOn ?? [])); }
        if (!reachable.has(dependencyStep!.stepId)) fail('CORE_PLAN_DEPENDENCY_ORDER_INVALID', 'Plan does not order an owner dependency first');
      }
    }
    const facts = this.resolvePlanFacts(goal, draft.steps.flatMap(step => step.requiredFacts));
    if (facts.some(item => item.state === 'unsourced')) fail('CORE_PLAN_FACT_UNSOURCED', 'Plan requires a fact with no trusted source');
    const allowed = this.allowedReasoningRefs(goal, evaluation);
    for (const ref of draft.reasoningRefs) if (!allowed.has(ref)) fail('CORE_PLAN_REF_UNSOURCED', 'Plan reasoning cites an untrusted reference');
    if (!draft.reasoningRefs.length) fail('CORE_PLAN_REF_UNSOURCED', 'Plan reasoning needs a trusted basis');
    const planVersion = goal.planVersion + 1;
    const steps = draft.steps.map(step => {
      const deliverable = goal.deliverables.find(item => item.id === step.deliverableId)!;
      return { ...clone(step), expectedSha256: hash(deliverable.content), byteLength: Buffer.byteLength(deliverable.content) };
    });
    const body = { schemaVersion: 2 as const, goalId: goal.goalId, planVersion, basePlanVersion: draft.basePlanVersion,
      evaluationId: evaluation.evaluationId, proposalId: `proposal:${evaluation.evaluationId}`, acceptedAt: this.at(),
      summary: draft.summary, reasoningRefs: clone(draft.reasoningRefs), triggerRefs: clone(evaluation.triggerRefs),
      stopConditions: clone(draft.stopConditions), steps, facts };
    const version: CorePlanVersion = { ...body, planHash: digest(body) };
    return { version, facts };
  }
  /** Deterministically admit the currently ready plan steps up to the plan's
   * bounded parallelism. Every admission reuses the existing Task/Mandate path. */
  private admitPlanSteps(goal: CoreGoal, plan: CorePlanVersion, evaluation: CoreEvaluation): { stepId: string; taskId: string }[] {
    const snapshot = this.planSnapshot(goal, plan, this.at());
    if (snapshot.stopped) fail(snapshot.stopped.reasonCode, 'The plan stop policy already holds further work');
    const admitted: { stepId: string; taskId: string }[] = [];
    let active = 0;
    for (const ref of goal.taskRefs) {
      const state = this.options.tasks.get(ref.taskId).task.state;
      if (!['succeeded', 'failed', 'cancelled', 'unknown'].includes(state)) active++;
    }
    for (const step of snapshot.steps) {
      if (admitted.length + active >= plan.stopConditions.maxParallelSteps) break;
      if (step.state !== 'ready') continue;
      if (this.admitting) fail('CORE_REENTRANT', 'Nested Core admissions are not allowed');
      this.admitting = { goalId: goal.goalId, deliverableId: step.deliverableId, kind: 'step_intent', stepId: step.stepId, planVersion: plan.planVersion };
      try {
        const task = this.options.tasks.admitCoreIntent({ goalId: goal.goalId, deliverableId: step.deliverableId, proposalId: `proposal:${evaluation.evaluationId}` });
        goal.taskRefs.push({ deliverableId: step.deliverableId, taskId: task.task.taskId });
        admitted.push({ stepId: step.stepId, taskId: task.task.taskId });
      } finally { this.admitting = undefined; }
    }
    return admitted;
  }
  private needsNewNote(goal: CoreGoal): boolean {
    return goal.deliverables.some(item => !goal.taskRefs.some(ref => ref.deliverableId === item.id));
  }
  private captureRead(goal: CoreGoal, evaluationId: string, expiresAt: string, capability: CapabilityCapture): CoreReadCapture {
    const publication = this.options.publication.get() ?? fail('CORE_VIEW_UNAVAILABLE', 'Capability read metadata is not published');
    const ability = publication.manifest.domains.ability, safety = this.options.safety.snapshot(), control = this.options.watermark.read();
    if (ability.status !== 'available' || ability.backendId !== 'control-ability' || ability.authorityId !== capability.ref.authorityId || !safety.enabled) {
      fail('CORE_VIEW_UNAVAILABLE', 'A current explicitly published capability read authority is required');
    }
    const capturedAt = this.at(), actor = { principalId: `core:${goal.goalId}`, role: 'core' as const, scopes: ['local-owner'] };
    const appliedSafety = { authEpoch: safety.authEpoch, tombstoneWatermark: safety.tombstoneWatermark };
    const authority = { backendId: 'control-ability', ...clone(capability.ref) };
    const resourceRefs = [`goal:${goal.goalId}`, `capability:${capability.ref.capabilityId}`];
    const source = { sourceId: `capability:${capability.ref.capabilityId}`, revision: capability.revision,
      contentHash: digest(capability.record), observedAt: capability.capturedAt, trustClass: 'trusted-capability-ledger' };
    return { schemaVersion: 1, evaluationId, goalId: goal.goalId, capturedAt, expiresAt, capability: clone(capability), actor, publication, control, safety,
      access: { principalId: actor.principalId, purpose: 'core_decision', scope: 'local-owner', audienceIds: ['local-owner'], resourceRefs,
        components: [{ backendId: 'control-ability', fields: ['capability'], authority: 'ability' }], expiresAt,
        policyVersion: safety.policyVersion, authEpoch: safety.authEpoch, tombstoneWatermark: safety.tombstoneWatermark,
        appliedSafety, commitSeq: control.commitSeq, stateVersion: publication.stateVersion, indexWatermark: 0,
        authority: { publicationBaselineId: publication.baselineId, policyAuthorityId: safety.policyAuthorityId,
          deletionAuthorityId: safety.deletionAuthorityId, deletionScope: safety.deletionScope, indexMode: 'not-used', ability: authority } },
      component: { capturedAt: capability.capturedAt, componentRevision: capability.revision, verifiedSourceHash: source.contentHash,
        freshness: { status: 'current' }, appliedSafety, expiresAt, abilityAuthority: authority,
        records: [{ recordId: capability.ref.capabilityId, scope: 'local-owner', audienceIds: ['local-owner'], resourceRefs,
          fields: { capability: JSON.parse(JSON.stringify(capability.record)) }, sourceRefs: [source],
          aggregateVersion: { aggregateType: 'ability', aggregateId: capability.ref.capabilityId, version: capability.revision } }] } };
  }
  /** Revalidate the persisted read capture, never create a replacement binding. */
  private readView(permit: CoreEvaluationPermit): CoreReadCapture {
    return this.tx.atomic(() => {
      const evaluation = this.current(permit, false), capture = evaluation.readCapture ?? fail('CORE_VIEW_UNAVAILABLE', 'This evaluation has no capability capture');
      if (capture.evaluationId !== evaluation.evaluationId || capture.goalId !== evaluation.goalId
        || capture.expiresAt <= this.at()) fail('CORE_VIEW_UNAVAILABLE', 'This evaluation has no current capability capture');
      const current = this.options.capability.captureForCore(), publication = this.options.publication.get(), safety = this.options.safety.snapshot();
      if (canonical(current.ref) !== canonical(capture.capability.ref)
        || !publication || publication.baselineId !== capture.publication.baselineId
        || canonical(publication.manifest.domains.ability) !== canonical(capture.publication.manifest.domains.ability)
        || canonical(safety) !== canonical(capture.safety)) fail('CORE_VIEW_UNAVAILABLE', 'Capability read authority changed since capture');
      // A newer informational success proof does not revoke the immutable
      // captured observation or the unchanged execution binding.
      return clone(capture);
    });
  }
  private permitIdentity(permit: CoreEvaluationPermit) {
    return { reservationId: permit.reservationId, mandateId: permit.mandateId, mandateVersion: permit.mandateVersion,
      authEpoch: permit.authEpoch, scope: 'local-owner', action: 'core.evaluate', resourceScopes: [`goal:${permit.goalId}`] };
  }
  private current(permit: CoreEvaluationPermit, dispatch: boolean): StoredEvaluation {
    const evaluation = this.evaluation(permit), goal = this.read(permit.goalId);
    // Once dispatch is durable, the native adapter checks the actual Goal at every
    // gate; this local receipt need not expire before the invocation lease does.
    this.running(goal, evaluation.status !== 'dispatching');
    if (permit.hostEpoch !== this.options.runtimeIdentity.hostEpoch || permit.installationGeneration !== this.options.runtimeIdentity.installationGeneration
      || permit.leaseExpiresAt <= this.at() || goal.activeEvaluationId !== permit.evaluationId || goal.controlEpoch !== permit.controlEpoch
      || goal.version !== permit.scopeVersion || canonical(goal.native!.goalRef) !== canonical(permit.goalRef)
      || !['claimed', 'dispatching'].includes(evaluation.status)) fail('STALE_CORE_PERMIT', 'Core evaluation is no longer current');
    if (canonical(this.captureTasks(goal)) !== canonical(evaluation.tasks)) fail('CORE_SOURCE_CONFLICT', 'A same-Goal Task or Effect changed since capture');
    if (dispatch) this.mandates.assertPermit(CORE_DISPATCHER, this.permitIdentity(permit));
    else {
      const mandate = this.mandates.get(OWNER, permit.mandateId);
      if (mandate.version !== permit.mandateVersion || mandate.authEpoch !== permit.authEpoch) fail('STALE_AUTHORITY', 'Goal authority changed during evaluation');
    }
    return evaluation;
  }
  private fact(goalId: string, id: string, payload: unknown): boolean {
    const old = this.db.prepare('SELECT value FROM shiyu_core_facts WHERE fact_id=?').get(id);
    if (old) { if (canonical(JSON.parse(String(old.value))) !== canonical(payload)) fail('IDEMPOTENCY_CONFLICT', 'Trigger fact identity changed'); return false; }
    this.db.prepare('INSERT INTO shiyu_core_facts VALUES(?,?,NULL,?)').run(id, goalId, JSON.stringify(payload)); return true;
  }
  private prepare(input: CorePrepareInput): CoreGoal {
    object(input, ['requestId', 'objective', 'deliverables', 'budget', 'expiresAt', 'maxEvaluations'], ['requestId', 'objective', 'deliverables', 'budget', 'expiresAt']);
    text(input.requestId, 'requestId', 100); text(input.objective, 'objective', 4000); date(input.expiresAt, 'expiresAt');
    object(input.budget, ['tokens', 'calls', 'effects']); number(input.budget.tokens, 'tokens', 1, 100000000); number(input.budget.calls, 'calls', 1, 1000); number(input.budget.effects, 'effects', 1, 1000);
    if (!Array.isArray(input.deliverables) || !input.deliverables.length || input.deliverables.length > 16) fail('INVALID_CORE_INPUT', 'Owner must specify 1–16 bounded local-note deliverables');
    const ids = new Set<string>();
    for (const item of input.deliverables) {
      object(item, ['id', 'title', 'content', 'dependsOn'], ['id', 'title', 'content']); text(item.id, 'deliverable id', 80); text(item.title, 'title', 160); text(item.content, 'content', 1024);
      if (!/^[A-Za-z0-9_-]+$/.test(item.id) || ids.has(item.id) || Buffer.byteLength(item.content) > 1024) fail('INVALID_CORE_INPUT', 'Deliverable identity or local-note byte bound is invalid');
      ids.add(item.id);
      if (item.dependsOn && (!Array.isArray(item.dependsOn) || new Set(item.dependsOn).size !== item.dependsOn.length)) fail('INVALID_CORE_INPUT', 'Invalid dependency list');
    }
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) fail('INVALID_CORE_INPUT', 'Deliverable dependency cycle');
      if (visited.has(id)) return; visiting.add(id);
      for (const dep of input.deliverables.find(item => item.id === id)!.dependsOn ?? []) { if (!ids.has(dep)) fail('INVALID_CORE_INPUT', 'Unknown deliverable dependency'); visit(dep); }
      visiting.delete(id); visited.add(id);
    };
    for (const id of ids) visit(id);
    const maxEvaluations = input.maxEvaluations ?? input.deliverables.length * 2 + 2;
    number(maxEvaluations, 'maxEvaluations', 1, 100);
    const normalized = { ...clone(input), maxEvaluations }, inputHash = digest(normalized);
    return this.tx.atomic(() => {
      const old = this.db.prepare('SELECT goal_id,input_hash FROM shiyu_core_goals WHERE request_id=?').get(input.requestId);
      if (old) { if (old.input_hash !== inputHash) fail('IDEMPOTENCY_CONFLICT', 'Owner request ID has different capabilities'); return this.get(String(old.goal_id)); }
      if (input.expiresAt <= this.at() || Date.parse(input.expiresAt) > this.now().getTime() + 7 * 86400000) fail('CORE_EXPIRED', 'Owner capability must expire within seven days');
      const goalId = `core-${hash(input.requestId).slice(0, 40)}`;
      const completionCriteria = canonical({ schemaVersion: 1, kind: 'all-local-note-artifacts', goalId,
        deliverables: input.deliverables.map(item => ({ id: item.id, sha256: hash(item.content), bytes: Buffer.byteLength(item.content) })) });
      const goal: CoreGoal = { schemaVersion: 1, goalId, ...normalized, completionCriteria, completionCriteriaHash: hash(completionCriteria),
        version: 1, authorized: false, paused: true, cancelled: false, controlEpoch: 1, taskRefs: [], planVersion: 0, evaluations: 0,
        createdAt: this.at(), updatedAt: this.at() };
      this.db.prepare('INSERT INTO shiyu_core_goals VALUES(?,?,?,?)').run(goalId, input.requestId, inputHash, JSON.stringify(goal)); return clone(goal);
    });
  }
  private observe(input: CoreNativeObservation): CoreGoal {
    object(input, ['goalId', 'goalRef', 'sessionId', 'phase', 'observedAt']); nativeRef(input.goalRef); text(input.sessionId, 'sessionId'); date(input.observedAt, 'observedAt');
    if (!['active', 'paused', 'blocked', 'complete'].includes(input.phase)) fail('INVALID_CORE_INPUT', 'Unsupported native phase');
    if (Math.abs(this.now().getTime() - Date.parse(input.observedAt)) > 60000) fail('STALE_NATIVE_GOAL', 'Native observation is not fresh');
    return this.tx.atomic(() => {
      const goal = this.read(input.goalId), binding = this.options.goals.load(goal.goalId);
      if (!binding || binding.ownerId !== OWNER.principalId || binding.scope !== 'local-owner' || binding.sessionId !== input.sessionId
        || binding.completionCriteriaHash !== goal.completionCriteriaHash || canonical(binding.goalRef) !== canonical(input.goalRef)
        || binding.receipt?.status !== 'confirmed') fail('STALE_NATIVE_GOAL', 'Observation does not match a confirmed native binding');
      if (goal.native && input.observedAt < goal.native.observedAt) fail('STALE_NATIVE_GOAL', 'Native observation moved backwards');
      const changed = !!goal.native && (canonical(goal.native.goalRef) !== canonical(input.goalRef) || goal.native.phase !== input.phase);
      goal.native = clone(input);
      if (changed) goal.controlEpoch++;
      if (input.phase !== 'active' && goal.authorized && !goal.paused) {
        const mandate = this.mandates.get(OWNER, goal.mandateId!); this.mandates.pause(OWNER, { mandateId: mandate.mandateId, expectedVersion: mandate.version });
        goal.paused = true;
      }
      this.save(goal, changed); return clone(goal);
    });
  }
  private authorize(input: { goalId: string; expectedVersion: number }): CoreGoal {
    object(input, ['goalId', 'expectedVersion']);
    return this.tx.atomic(() => {
      const goal = this.read(input.goalId); this.checkVersion(goal, input.expectedVersion); this.checkNative(goal);
      if (goal.authorized) return clone(goal);
      if (goal.cancelled || this.options.tasks.isPaused() || this.options.isPaused?.()) fail('CORE_PAUSED', 'Owner authorization is disabled while stopped');
      const mandate = this.mandates.grant(OWNER, { id: `core-mandate:${goal.goalId}`, scope: 'local-owner',
        subjectIds: [`core:${goal.goalId}`, `goal-worker:${goal.goalId}`, CORE_DISPATCHER.principalId, CORE_VERIFIER.principalId, 'shiyu-task-dispatcher', 'shiyu-artifact-verifier'],
        allowedActions: ['core.evaluate', 'task.local-note.execute', 'artifact.write'],
        allowedResources: [`goal:${goal.goalId}`, ...goal.deliverables.map(item => `deliverable:${goal.goalId}:${item.id}`)],
        limits: goal.budget, basisRef: `owner-core-request:${goal.requestId}`, expiresAt: goal.expiresAt });
      goal.authorized = true; goal.paused = false; goal.mandateId = mandate.mandateId; goal.controlEpoch++; this.save(goal);
      this.fact(goal.goalId, `owner:${goal.goalId}`, { kind: 'owner_request', requestId: goal.requestId }); return clone(goal);
    });
  }
  /** Pure-read planning eligibility and diagnostic state. Distinct reason codes
   * keep cancelled, paused, exhausted, unknown, unavailable, stale-plan, stop
   * condition and no-change states observable without any model call. */
  private planning(goal: CoreGoal): { eligible: boolean; reasonCode: string } {
    let reasonCode = !goal.authorized ? 'not_authorized' : goal.cancelled ? 'cancelled' : goal.paused ? 'paused'
      : this.options.tasks.isPaused() || this.options.isPaused?.() ? 'global_paused'
        : goal.activeEvaluationId ? (this.evaluationState(goal) === 'unknown' ? 'evaluation_unknown' : 'evaluation_active')
          : goal.evaluations >= goal.maxEvaluations ? 'evaluation_limit' : goal.expiresAt <= this.at() ? 'expired' : '';
    let toleratedFailure: string | undefined;
    const plan = this.currentPlan(goal);
    const taskStates = this.planTaskStates(goal);
    if (!reasonCode && taskStates.unknown) reasonCode = 'task_unknown';
    if (!reasonCode && plan) {
      const snapshot = this.planSnapshot(goal, plan, this.at());
      if (snapshot.stopped) reasonCode = snapshot.stopped.reasonCode;
      else if (taskStates.failed) toleratedFailure = 'plan_tolerated_failure';
    } else if (!reasonCode && taskStates.failed) reasonCode = 'task_failed';
    if (!reasonCode && goal.nextEligibleAt && goal.nextEligibleAt > this.at()) reasonCode = 'cooldown';
    if (!reasonCode && this.mandates.health().frozen) reasonCode = 'budget_frozen';
    if (!reasonCode && this.needsNewNote(goal)) {
      try { if (!this.options.capability.captureForCore().record.usableForAuthorizedTask) reasonCode = 'capability_unavailable'; }
      catch { reasonCode = 'capability_unavailable'; }
    }
    if (!reasonCode) {
      const grant = this.mandates.get(OWNER, goal.mandateId!);
      if (grant.state !== 'active' || grant.expiresAt <= this.at()) reasonCode = 'authority_unavailable';
      else {
        const { available } = this.mandates.balance(OWNER, grant.mandateId);
        if (available.tokens < CORE_EVALUATION_BUDGET.tokens || available.calls < CORE_EVALUATION_BUDGET.calls) reasonCode = 'budget_exhausted';
      }
    }
    if (!reasonCode && !goal.nextEligibleAt) {
      const unconsumed = this.db.prepare('SELECT 1 FROM shiyu_core_facts WHERE goal_id=? AND consumed_by IS NULL LIMIT 1').get(goal.goalId);
      const planWaitingFacts = plan && this.planSnapshot(goal, plan, this.at()).steps.some(step => step.state === 'blocked_fact');
      if (!unconsumed) reasonCode = toleratedFailure ?? (planWaitingFacts ? 'plan_waiting_fact' : 'awaiting_fact');
    }
    return { eligible: !reasonCode, reasonCode: reasonCode || 'ready' };
  }
  private evaluationState(goal: CoreGoal): string | undefined {
    if (!goal.activeEvaluationId) return undefined;
    return this.evaluations(goal.goalId).find(item => item.evaluationId === goal.activeEvaluationId)?.status;
  }
  private eligible(goal: CoreGoal): boolean { return this.planning(goal).eligible; }
  private claim(goalId: string): CoreEvaluation | undefined {
    return this.tx.atomic(() => {
      const goal = this.read(goalId); this.running(goal);
      if (!this.eligible(goal)) return undefined;
      const capability = this.options.capability.captureForCore();
      if (this.needsNewNote(goal)) this.options.capability.assertCurrent(capability.ref);
      const grant = this.mandates.get(OWNER, goal.mandateId!), evaluationId = `evaluation:${goalId}:${goal.evaluations + 1}`;
      // Read the committed source watermark before this transaction creates
      // the evaluation/reservation; it must never claim uncommitted writes.
      const readCapture = this.captureRead(goal, evaluationId,
        new Date(Math.min(this.now().getTime() + 180000, Date.parse(goal.expiresAt))).toISOString(), capability);
      const reservation = this.mandates.reserve({ principalId: `core:${goalId}`, kind: 'agent', scopes: ['local-owner'] }, {
        reservationId: `reservation:${evaluationId}`, mandateId: grant.mandateId, mandateVersion: grant.version, authEpoch: grant.authEpoch,
        scope: 'local-owner', action: 'core.evaluate', resourceScopes: [`goal:${goalId}`], amount: CORE_EVALUATION_BUDGET, leaseMs: 180000 });
      const fence = Number(this.db.prepare('UPDATE shiyu_core_meta SET fence=fence+1 WHERE id=1 RETURNING fence').get()!.fence);
      goal.evaluations++; goal.activeEvaluationId = evaluationId; delete goal.nextEligibleAt; this.save(goal);
      const permit: CoreEvaluationPermit = { ...this.options.runtimeIdentity, goalId, evaluationId, claimToken: randomUUID(), fencingToken: fence,
        controlEpoch: goal.controlEpoch, scopeVersion: goal.version, goalRef: clone(goal.native!.goalRef), reservationId: reservation.reservationId,
        mandateId: grant.mandateId, mandateVersion: grant.version, authEpoch: grant.authEpoch, leaseExpiresAt: reservation.leaseExpiresAt };
      const triggerRefs = this.db.prepare('SELECT fact_id FROM shiyu_core_facts WHERE goal_id=? AND consumed_by IS NULL ORDER BY rowid').all(goalId).map(row => String(row.fact_id));
      const plan = this.currentPlan(goal);
      const evaluation: StoredEvaluation = { evaluationId, goalId, status: 'claimed', permit, goal: clone(goal), tasks: this.captureTasks(goal), triggerRefs, reservation,
        readCapture, ...(plan ? { plan: this.planSnapshot(goal, plan, this.at()) } : {}) };
      this.db.prepare('INSERT INTO shiyu_core_evaluations VALUES(?,?,?)').run(evaluationId, goalId, JSON.stringify(evaluation));
      this.db.prepare('UPDATE shiyu_core_facts SET consumed_by=? WHERE goal_id=? AND consumed_by IS NULL').run(evaluationId, goalId);
      return clone(evaluation);
    });
  }
  private recordDispatch(permit: CoreEvaluationPermit, binding: CoreDispatchBinding): CoreEvaluation {
    object(binding, ['goalId', 'goalRef', 'roundId', 'sessionId', 'messageId', 'messageHash']); nativeRef(binding.goalRef);
    text(binding.roundId, 'roundId'); text(binding.messageId, 'messageId'); sha(binding.messageHash);
    return this.tx.atomic(() => {
      const evaluation = this.current(permit, true);
      if (binding.goalId !== permit.goalId || binding.roundId !== permit.evaluationId || binding.sessionId !== evaluation.goal.native!.sessionId
        || canonical(binding.goalRef) !== canonical(permit.goalRef)) fail('CORE_DISPATCH_MISMATCH', 'Native input binding does not match this round');
      if (evaluation.dispatch) {
        if (canonical(evaluation.dispatch) !== canonical(binding)) fail('IDEMPOTENCY_CONFLICT', 'Evaluation already binds another native input');
        return clone(evaluation);
      }
      evaluation.dispatch = clone(binding); evaluation.status = 'dispatching'; this.saveEvaluation(evaluation); return clone(evaluation);
    });
  }
  private recordNative(permit: CoreEvaluationPermit, receipt: CoreNativeResultReceipt): CoreEvaluation {
    object(receipt, ['roundId', 'sessionId', 'messageId', 'messageHash', 'inputRef', 'assistantRef', 'outputHash', 'observedAt']);
    date(receipt.observedAt, 'observedAt'); sha(receipt.outputHash); sha(receipt.messageHash);
    for (const ref of [receipt.inputRef, receipt.assistantRef]) {
      object(ref, ['sessionId', 'eventSeq', 'messageId', 'messageHash', 'durability']); text(ref.sessionId, 'sessionId'); text(ref.messageId, 'messageId'); number(ref.eventSeq, 'eventSeq', 0); sha(ref.messageHash);
      if (ref.durability !== 'confirmed') fail('CORE_NATIVE_UNCONFIRMED', 'Native message lacks durable readback');
    }
    return this.tx.atomic(() => {
      const evaluation = this.evaluation(permit), dispatch = evaluation.dispatch;
      if (!dispatch || receipt.roundId !== dispatch.roundId || receipt.sessionId !== dispatch.sessionId || receipt.messageId !== dispatch.messageId
        || receipt.messageHash !== dispatch.messageHash || receipt.inputRef.sessionId !== dispatch.sessionId || receipt.inputRef.messageId !== dispatch.messageId
        || receipt.inputRef.messageHash !== dispatch.messageHash || receipt.assistantRef.sessionId !== dispatch.sessionId || receipt.assistantRef.eventSeq <= receipt.inputRef.eventSeq
        || Date.parse(receipt.observedAt) > this.now().getTime() + 1000) fail('CORE_NATIVE_MISMATCH', 'Native result does not match the dispatched input');
      if (evaluation.nativeReceipt && canonical(evaluation.nativeReceipt) !== canonical(receipt)) fail('IDEMPOTENCY_CONFLICT', 'Native result receipt changed');
      evaluation.nativeReceipt = clone(receipt); this.saveEvaluation(evaluation); return clone(evaluation);
    });
  }
  private accounting(input: CoreAccounting): BudgetReservation {
    object(input, ['permit', 'receiptId', 'complete', 'tokens', 'calls', 'evidenceRef'], ['permit', 'receiptId', 'complete', 'evidenceRef']);
    text(input.receiptId, 'receiptId'); text(input.evidenceRef, 'evidenceRef');
    if (typeof input.complete !== 'boolean') fail('INVALID_CORE_INPUT', 'Accounting coverage is required');
    if (input.tokens !== undefined) number(input.tokens, 'tokens'); if (input.calls !== undefined) number(input.calls, 'calls', 0, 1000);
    if (input.complete && (input.tokens === undefined || input.calls === undefined)) fail('INCOMPLETE_USAGE', 'Complete planning accounting needs token and call coverage');
    return this.tx.atomic(() => {
      const evaluation = this.evaluation(input.permit), inputHash = digest(input);
      const prior = this.db.prepare('SELECT input_hash,value FROM shiyu_core_accounting WHERE receipt_id=?').get(input.receiptId);
      if (prior) { if (prior.input_hash !== inputHash) fail('IDEMPOTENCY_CONFLICT', 'Accounting receipt changed'); return JSON.parse(String(prior.value)) as BudgetReservation; }
      if (evaluation.dispatch && input.complete && input.calls === 0) fail('INCOMPLETE_USAGE', 'Dispatched generation cannot be accounted as zero calls');
      const reservation = this.mandates.getReservation(OWNER, input.permit.reservationId);
      const result = this.mandates.reconcile(CORE_VERIFIER, { receiptId: input.receiptId, reservationId: reservation.reservationId, expectedVersion: reservation.version,
        complete: input.complete, usage: { ...(input.tokens !== undefined ? { tokens: input.tokens } : {}), ...(input.calls !== undefined ? { calls: input.calls } : {}), effects: 0 }, evidenceRef: input.evidenceRef });
      evaluation.reservation = result; this.saveEvaluation(evaluation);
      this.db.prepare('INSERT INTO shiyu_core_accounting VALUES(?,?,?)').run(input.receiptId, inputHash, JSON.stringify(result)); return result;
    });
  }
  private candidate(textValue: string): CoreCandidate {
    text(textValue, 'candidateText', 16000); let parsed: unknown;
    try { parsed = JSON.parse(textValue); } catch { return fail('INVALID_CORE_CANDIDATE', 'Core output must be one JSON object'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('INVALID_CORE_CANDIDATE', 'Core output must be one JSON object');
    const candidate = parsed as Record<string, unknown>;
    if (!['plan_candidate', 'task_intent', 'defer', 'no_action', 'complete_candidate'].includes(candidate.kind as string)) {
      fail('INVALID_CORE_CANDIDATE', 'Unsupported Core candidate kind');
    }
    if (candidate.kind === 'plan_candidate') {
      object(candidate, ['kind', 'plan']);
      const plan = this.planDraft(candidate.plan);
      return { kind: 'plan_candidate', plan };
    }
    object(candidate, candidate.kind === 'task_intent' ? ['kind', 'deliverableId', 'reason'] : candidate.kind === 'defer' ? ['kind', 'reason', 'retryAfterMs'] : ['kind', 'reason']);
    text(candidate.reason, 'structured reason', 1000);
    if (candidate.kind === 'task_intent') { text(candidate.deliverableId, 'deliverableId', 80); return { kind: 'task_intent', deliverableId: candidate.deliverableId, reason: candidate.reason }; }
    if (candidate.kind === 'defer') { number(candidate.retryAfterMs, 'retryAfterMs', 1000, 86400000); return { kind: 'defer', reason: candidate.reason, retryAfterMs: candidate.retryAfterMs }; }
    if (candidate.kind === 'complete_candidate') return { kind: 'complete_candidate', reason: candidate.reason };
    return { kind: 'no_action', reason: candidate.reason };
  }
  private delegation(goalId: string, deliverableId: string): CoreTaskDelegation {
    const admitted = this.admitting;
    const validAdmission = admitted !== undefined && admitted.goalId === goalId && admitted.deliverableId === deliverableId;
    if (!validAdmission) fail('CORE_ADMISSION_REQUIRED', 'Task delegation is only available inside validated Core commit');
    const goal = this.read(goalId); this.running(goal, false);
    const deliverable = goal.deliverables.find(item => item.id === deliverableId) ?? fail('CORE_SCOPE_DENIED', 'Model selected an ungranted deliverable');
    const plan = this.currentPlan(goal);
    if (goal.planVersion) {
      // Once a plan is accepted, only its validated ready steps can receive Tasks.
      if (admitted!.kind !== 'step_intent' || admitted!.planVersion !== goal.planVersion) fail('CORE_PLAN_REQUIRED', 'Planned Goals admit only validated plan steps');
      if (!plan) fail('CORE_PLAN_MISSING', 'The accepted plan revision is unavailable');
      const step = plan!.steps.find(item => item.stepId === admitted!.stepId && item.deliverableId === deliverableId) ?? fail('CORE_PLAN_STRUCTURE_INVALID', 'Admitted step is absent from the current plan');
      const view = this.planSnapshot(goal, plan!, this.at()).steps.find(item => item.stepId === step.stepId);
      if (!view || view.state !== 'ready') fail('CORE_PLAN_STRUCTURE_INVALID', 'Only a ready plan step can be admitted');
    } else if (admitted!.kind !== 'task_intent') fail('CORE_PLAN_MISSING', 'Unplanned admission requires the legacy owner deliverable intent');
    if (goal.taskRefs.some(ref => ref.deliverableId === deliverableId)) fail('CORE_DELIVERABLE_OWNED', 'This owner deliverable already belongs to a Task');
    for (const dependency of deliverable.dependsOn ?? []) {
      const ref = goal.taskRefs.find(item => item.deliverableId === dependency);
      if (!ref || this.options.tasks.get(ref.taskId).task.state !== 'succeeded') fail('CORE_DEPENDENCY_PENDING', 'Owner dependency lacks verified Task completion');
      this.verifiedDeliverable(goal, goal.deliverables.find(item => item.id === dependency)!);
    }
    const grant = this.mandates.get(OWNER, goal.mandateId!);
    const evaluation = this.evaluations(goalId).find(value => value.evaluationId === goal.activeEvaluationId);
    const capabilityRef = evaluation?.readCapture?.capability.ref ?? fail('CORE_CAPABILITY_CHANGED', 'The admitted evaluation has no captured capability binding');
    try { this.options.capability.assertCurrent(capabilityRef); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['CAPABILITY_CHANGED', 'CAPABILITY_UNAVAILABLE'].includes(String(error.code))) {
        fail('CORE_CAPABILITY_CHANGED', 'The captured local-note execution binding is no longer usable');
      }
      throw error;
    }
    return { goalId, deliverableId, title: deliverable.title, content: deliverable.content, resourceRef: `deliverable:${goalId}:${deliverableId}`,
      subjectId: `goal-worker:${goalId}`, mandateId: grant.mandateId, mandateVersion: grant.version, authEpoch: grant.authEpoch,
      capabilityRef: clone(capabilityRef), sourceRefs: [grant.basisRef, ...(evaluation?.triggerRefs ?? [])] };
  }
  private commit(input: CoreCommands['core.commitCandidate']['input']): CoreCommitReceipt {
    object(input, ['permit', 'proposalId', 'candidateText']); text(input.proposalId, 'proposalId');
    const candidate = this.candidate(input.candidateText), proposalHash = digest({ proposalId: input.proposalId, candidate });
    return this.tx.atomic(() => {
      const old = this.evaluation(input.permit);
      if (old.receipt) { if (old.proposalHash !== proposalHash) fail('IDEMPOTENCY_CONFLICT', 'Evaluation already has another proposal'); return clone(old.receipt); }
      const evaluation = this.current(input.permit, false);
      if (!evaluation.nativeReceipt || evaluation.nativeReceipt.outputHash !== hash(input.candidateText)) fail('CORE_NATIVE_REQUIRED', 'Candidate lacks its matching durable native result');
      const reservation = this.mandates.getReservation(OWNER, input.permit.reservationId);
      if (reservation.state !== 'settled' || reservation.overrun) fail('CORE_USAGE_UNCERTAIN', 'Unknown or excess planning usage cannot authorize derived work');
      const goal = this.read(input.permit.goalId);
      const receipt: CoreCommitReceipt = { evaluationId: evaluation.evaluationId, proposalId: input.proposalId, status: 'committed', kind: candidate.kind, reasonCode: candidate.kind };
      if (candidate.kind === 'task_intent') {
        // A planned Goal cannot fall back to arbitrary single-step selection.
        if (goal.planVersion) fail('CORE_PLAN_REQUIRED', 'A planned Goal admits work only through plan revisions');
        if (this.admitting) fail('CORE_REENTRANT', 'Nested Core admissions are not allowed');
        this.admitting = { goalId: goal.goalId, deliverableId: candidate.deliverableId, kind: 'task_intent' };
        try {
          const task = this.options.tasks.admitCoreIntent({ goalId: goal.goalId, deliverableId: candidate.deliverableId, proposalId: input.proposalId });
          goal.taskRefs.push({ deliverableId: candidate.deliverableId, taskId: task.task.taskId }); receipt.taskId = task.task.taskId;
        } finally { this.admitting = undefined; }
      } else if (candidate.kind === 'plan_candidate') {
        const validated = this.validatePlan(goal, evaluation, candidate.plan);
        goal.plans = [...(goal.plans ?? []), validated.version];
        goal.planVersion = validated.version.planVersion;
        // The accepted revision must be visible to the same-transaction Task
        // delegation authority before any admitted step obtains a Task identity.
        this.save(goal);
        receipt.planVersion = validated.version.planVersion;
        const stepRefs = this.admitPlanSteps(goal, validated.version, evaluation);
        if (stepRefs.length) receipt.stepRefs = stepRefs;
      } else if (candidate.kind === 'defer') goal.nextEligibleAt = new Date(this.now().getTime() + candidate.retryAfterMs).toISOString();
      else if (candidate.kind === 'complete_candidate') this.completedTasks(goal);
      delete goal.activeEvaluationId; this.save(goal);
      evaluation.status = 'committed'; evaluation.candidate = clone(candidate); evaluation.receipt = receipt; evaluation.proposalHash = proposalHash;
      evaluation.reservation = reservation; this.saveEvaluation(evaluation); return clone(receipt);
    });
  }
  private unknown(permit: CoreEvaluationPermit, reasonCode: string): CoreEvaluation {
    text(reasonCode, 'reasonCode', 200);
    return this.tx.atomic(() => {
      const evaluation = this.evaluation(permit);
      if (evaluation.status === 'committed' || evaluation.status === 'rejected') return clone(evaluation);
      const reservation = this.mandates.getReservation(OWNER, permit.reservationId);
      if (reservation.state === 'reserved') evaluation.reservation = this.mandates.reconcile(CORE_VERIFIER, { receiptId: `core-unknown:${permit.evaluationId}`,
        reservationId: reservation.reservationId, expectedVersion: reservation.version, complete: false, usage: {}, evidenceRef: `core-interruption:${permit.evaluationId}` });
      evaluation.status = 'unknown'; evaluation.reasonCode = reasonCode; this.saveEvaluation(evaluation); return clone(evaluation);
    });
  }
  private reject(permit: CoreEvaluationPermit, reasonCode: string): CoreEvaluation {
    if (!(CORE_KNOWN_REJECTIONS as readonly string[]).includes(reasonCode)) fail('INVALID_CORE_INPUT', 'Only a known deterministic rejection may settle an evaluation');
    return this.tx.atomic(() => {
      const evaluation = this.evaluation(permit), goal = this.read(permit.goalId);
      let reservation = this.mandates.getReservation(OWNER, permit.reservationId);
      if (evaluation.status === 'committed') fail('CORE_ALREADY_COMMITTED', 'An admitted proposal cannot become rejected');
      if (evaluation.status === 'rejected') {
        if (evaluation.reasonCode !== reasonCode) fail('IDEMPOTENCY_CONFLICT', 'Evaluation rejection reason changed'); return clone(evaluation);
      }
      if (reasonCode === 'CORE_VIEW_UNAVAILABLE') {
        if (evaluation.status !== 'claimed' || evaluation.dispatch || evaluation.nativeReceipt || reservation.state !== 'reserved'
          || permit.hostEpoch !== this.options.runtimeIdentity.hostEpoch || permit.installationGeneration !== this.options.runtimeIdentity.installationGeneration
          || goal.activeEvaluationId !== evaluation.evaluationId) fail('CORE_RECONCILIATION_REQUIRED', 'Only the current undispatched claim can settle as zero inference');
        reservation = this.mandates.reconcile(CORE_VERIFIER, { receiptId: `core-undispatched:${permit.evaluationId}`,
          reservationId: reservation.reservationId, expectedVersion: reservation.version, complete: true,
          usage: { tokens: 0, calls: 0, effects: 0 }, evidenceRef: `core-view-before-native:${permit.evaluationId}` });
      } else if (!evaluation.dispatch || !evaluation.nativeReceipt || reservation.state !== 'settled' || reservation.overrun) {
        fail('CORE_RECONCILIATION_REQUIRED', 'Deterministic rejection requires the exact known native result and complete accounting');
      }
      evaluation.status = 'rejected'; evaluation.reasonCode = reasonCode; evaluation.reservation = reservation; this.saveEvaluation(evaluation);
      if (reasonCode === 'CORE_CAPABILITY_CHANGED' || reasonCode === 'CORE_VIEW_UNAVAILABLE') {
        // A known accounted rejection or a proven pre-native failure may make
        // its original facts eligible again, never an unknown/native replay.
        this.db.prepare('UPDATE shiyu_core_facts SET consumed_by=NULL WHERE goal_id=? AND consumed_by=?').run(permit.goalId, permit.evaluationId);
      }
      if (goal.activeEvaluationId === evaluation.evaluationId) { delete goal.activeEvaluationId; this.save(goal); }
      return clone(evaluation);
    });
  }
  private control(input: { goalId: string; expectedVersion: number }, operation: 'pause' | 'resume' | 'cancel'): CoreGoal {
    object(input, ['goalId', 'expectedVersion']);
    return this.tx.atomic(() => {
      const goal = this.read(input.goalId); this.checkVersion(goal, input.expectedVersion);
      if (operation === 'resume') {
        if (!goal.authorized || goal.cancelled || goal.activeEvaluationId) fail('CORE_RECONCILIATION_REQUIRED', 'Stopped or uncertain planning cannot automatically resume');
        if (goal.taskRefs.some(ref => this.options.tasks.get(ref.taskId).task.state === 'unknown')) fail('CORE_RECONCILIATION_REQUIRED', 'Unknown delegated work needs independent reconciliation');
        if (this.options.tasks.isPaused() || this.options.isPaused?.()) fail('CORE_PAUSED', 'Global control dispatch is paused');
        this.checkNative(goal);
        const binding = this.options.goals.load(goal.goalId)!;
        if (binding.receipt?.operation !== 'resume' || goal.native!.goalRef.revision <= (goal.pausedAtNativeRevision ?? 0)) fail('STALE_NATIVE_GOAL', 'Owner resume needs a new confirmed native resume after this pause');
        const grant = this.mandates.get(OWNER, goal.mandateId!); this.mandates.resume(OWNER, { mandateId: grant.mandateId, expectedVersion: grant.version });
        this.options.tasks.resumeCorePending(goal.goalId);
        goal.paused = false; goal.controlEpoch++; this.save(goal);
        this.fact(goal.goalId, `resume:${goal.goalId}:${goal.controlEpoch}`, { kind: 'owner_resume', controlEpoch: goal.controlEpoch });
      } else {
        if (goal.activeEvaluationId) {
          const current = this.evaluations(goal.goalId).find(item => item.evaluationId === goal.activeEvaluationId)!;
          this.unknown(current.permit, operation === 'cancel' ? 'owner_cancelled' : 'owner_paused');
        }
        if (goal.mandateId) {
          const grant = this.mandates.get(OWNER, goal.mandateId);
          if (operation === 'cancel') this.mandates.revoke(OWNER, { mandateId: grant.mandateId, expectedVersion: grant.version });
          else if (grant.state !== 'revoked') this.mandates.pause(OWNER, { mandateId: grant.mandateId, expectedVersion: grant.version });
        }
        goal.paused = true; goal.cancelled ||= operation === 'cancel'; goal.controlEpoch++; this.save(goal);
        goal.pausedAtNativeRevision = goal.native?.goalRef.revision; this.save(goal, false);
        if (operation === 'pause') for (const ref of goal.taskRefs) {
          const detail = this.options.tasks.get(ref.taskId);
          if (detail.execution && ['claimed', 'bound', 'running'].includes(detail.execution.state)
            && !['succeeded', 'failed', 'cancelled'].includes(detail.task.state)) this.options.tasks.execute({ command: 'task.markUnknown', args: { taskId: ref.taskId, reason: 'owner_goal_paused_requires_reconciliation' } });
        }
        if (operation === 'cancel') for (const ref of goal.taskRefs) {
          if (!['succeeded', 'failed', 'cancelled'].includes(this.options.tasks.get(ref.taskId).task.state)) this.options.tasks.execute({ command: 'task.cancel', args: { taskId: ref.taskId, reason: 'owner_goal_cancelled' } });
        }
      }
      return clone(goal);
    });
  }
  /** Worker publishes its verified task.succeeded event first; both operations join the same transaction. */
  enqueueTaskFact(input: { taskId: string; eventId: string }): { queued: boolean; goalId?: string } {
    text(input.taskId, 'taskId'); text(input.eventId, 'eventId');
    return this.tx.atomic(() => {
      const goal = this.all().find(value => value.taskRefs.some(ref => ref.taskId === input.taskId));
      if (!goal) return { queued: false };
      const detail = this.options.tasks.get(input.taskId);
      if (detail.task.state !== 'succeeded' || !detail.task.verification || detail.effects.some(effect => ['pending', 'dispatching', 'unknown'].includes(effect.status))
        || !detail.effects.some(effect => effect.status === 'succeeded' && !!effect.receiptId)) fail('CORE_FACT_UNVERIFIED', 'Task fact requires independent settled artifact evidence');
      const deliverableId = goal.taskRefs.find(ref => ref.taskId === input.taskId)!.deliverableId;
      this.verifiedDeliverable(goal, goal.deliverables.find(item => item.id === deliverableId)!);
      const queued = this.fact(goal.goalId, `task:${input.taskId}:${detail.task.version}`, { kind: 'task.succeeded', ...input, taskVersion: detail.task.version });
      return { queued, goalId: goal.goalId };
    });
  }
  private completedTasks(goal: CoreGoal) {
    if (goal.taskRefs.length !== goal.deliverables.length) fail('CORE_COMPLETION_UNPROVEN', 'Every owner deliverable needs an admitted Task');
    return goal.deliverables.map(item => this.verifiedDeliverable(goal, item));
  }
  private verifiedDeliverable(goal: CoreGoal, item: CoreGoal['deliverables'][number]) {
      const ref = goal.taskRefs.find(value => value.deliverableId === item.id) ?? fail('CORE_COMPLETION_UNPROVEN', 'Deliverable Task ownership is missing');
      const detail = this.options.tasks.get(ref.taskId);
      const admission = this.evaluations(goal.goalId).find(value =>
        (value.receipt?.taskId === ref.taskId && value.candidate?.kind === 'task_intent' && value.candidate.deliverableId === item.id)
        || (value.candidate?.kind === 'plan_candidate' && !!value.receipt?.stepRefs?.some(step => step.taskId === ref.taskId)));
      if (!admission || !goal.mandateId) fail('CORE_COMPLETION_UNPROVEN', 'Task lacks its committed same-Goal admission');
      const grant = this.mandates.get(OWNER, goal.mandateId!);
      try { inspectTaskEvidence(detail, ref.taskId, { goalId: goal.goalId, mandateId: grant.mandateId, resourceRef: `deliverable:${goal.goalId}:${item.id}`,
        inputRefs: [`local-input:${ref.taskId}`, grant.basisRef, ...admission!.triggerRefs], now: this.now().getTime() }); }
      catch { fail('CORE_COMPLETION_UNPROVEN', 'Full Task/Effect/receipt verification failed'); }
      if (detail.task.state !== 'succeeded' || !detail.task.verification || detail.artifact.expectedSha256 !== hash(item.content)
        || detail.artifact.byteLength !== Buffer.byteLength(item.content) || !detail.task.result
        || detail.task.result.resultHash !== detail.artifact.expectedSha256
        || detail.task.result.effectRefs.length !== 1) fail('CORE_COMPLETION_UNPROVEN', 'Owner deliverable lacks matching verified Task completion');
      const effect = detail.effects.find(value => value.effectId === detail.task.result!.effectRefs[0]);
      if (effect?.status !== 'succeeded' || !effect.receiptId || !detail.effectReceipts.some(receipt => receipt.receiptId === effect.receiptId)) fail('CORE_COMPLETION_UNPROVEN', 'Task completion lacks its successful Effect receipt');
      return { item, detail, effect };
  }
  private verify(input: CoreCompletionRequest): GoalCompletionProof {
    object(input, ['goalId', 'expectedVersion', 'goalRef', 'observations']); nativeRef(input.goalRef);
    return this.tx.atomic(() => {
      const goal = this.read(input.goalId); this.checkVersion(goal, input.expectedVersion); this.running(goal, true, true);
      if (canonical(goal.native!.goalRef) !== canonical(input.goalRef)) fail('STALE_NATIVE_GOAL', 'Completion native revision changed');
      if (!this.evaluations(goal.goalId).some(value => value.status === 'committed' && value.candidate?.kind === 'complete_candidate')) fail('CORE_COMPLETION_UNPROVEN', 'Completion requires a committed completion candidate');
      const completed = this.completedTasks(goal);
      if (!Array.isArray(input.observations) || input.observations.length !== completed.length || new Set(input.observations.map(item => item.deliverableId)).size !== completed.length) fail('CORE_COMPLETION_UNPROVEN', 'Independent readback must cover every deliverable once');
      const evidenceRefs: string[] = [];
      for (const { item, detail, effect } of completed) {
        const observed = input.observations.find(value => value.deliverableId === item.id) ?? fail('CORE_COMPLETION_UNPROVEN', 'Deliverable observation missing');
        object(observed, ['deliverableId', 'taskId', 'taskVersion', 'artifactRef', 'observedSha256', 'observedBytes', 'receiptId', 'observedAt']);
        date(observed.observedAt, 'observedAt'); text(observed.receiptId, 'receiptId');
        if (observed.taskId !== detail.task.taskId || observed.taskVersion !== detail.task.version || observed.artifactRef !== detail.artifact.artifactRef
          || observed.observedSha256 !== detail.artifact.expectedSha256 || observed.observedBytes !== detail.artifact.byteLength
          || Math.abs(this.now().getTime() - Date.parse(observed.observedAt)) > 60000) fail('CORE_COMPLETION_UNPROVEN', 'Independent artifact readback is stale or mismatched');
        evidenceRefs.push(`core-artifact-readback:${observed.receiptId}`, `artifact-observation:${effect!.receiptId}`, detail.artifact.artifactRef);
      }
      const proof: GoalCompletionProof = { goalRef: clone(input.goalRef), completionCriteriaHash: goal.completionCriteriaHash, evidenceRefs,
        verifierId: 'shiyu-core-artifact-verifier-v1', verifiedAt: this.at() };
      const pending = this.options.goals.load(goal.goalId)?.receipt;
      if (pending?.status === 'pending' && (canonical({ ...pending.completionProof, verifiedAt: undefined }) !== canonical({ ...proof, verifiedAt: undefined })
        || !pending.completionProof || Math.abs(this.now().getTime() - Date.parse(pending.completionProof.verifiedAt)) > 60000)) fail('CORE_COMPLETION_UNPROVEN', 'Pending native completion proof no longer matches fresh independent evidence');
      return proof;
    });
  }
  /** Read-only current plan, bounded history and recomputed trusted snapshot. */
  private planView(goalId: string): CorePlanView {
    text(goalId, 'goalId');
    const goal = this.read(goalId), plan = this.currentPlan(goal);
    return { goalId, planVersion: goal.planVersion, history: clone(goal.plans ?? []),
      ...(plan ? { current: clone(plan), snapshot: this.planSnapshot(goal, plan, this.at()) } : {}) };
  }
  execute(request: CoreDomainRequest): unknown {
    this.tx.assertUsable();
    switch (request.command) {
      case 'core.prepareGoal': return this.prepare(request.args);
      case 'core.observeNativeGoal': return this.observe(request.args);
      case 'core.authorizeGoal': return this.authorize(request.args);
      case 'core.get': return this.get(request.args.goalId);
      case 'core.balance': { const goal = this.read(request.args.goalId); return goal.mandateId ? this.mandates.balance(OWNER, goal.mandateId) : undefined; }
      case 'core.snapshot': return this.all().map(goal => ({ ...goal, planning: this.planning(goal) }));
      case 'core.evaluations': return this.evaluations(request.args.goalId);
      case 'core.plan': return this.planView(request.args.goalId);
      case 'core.pending': {
        object(request.args, ['limit', 'afterGoalId'], []);
        const limit = request.args.limit ?? 10; number(limit, 'limit', 1, 100);
        if (request.args.afterGoalId !== undefined && (typeof request.args.afterGoalId !== 'string' || !/^core-[a-f0-9]{40}$/.test(request.args.afterGoalId))) fail('INVALID_CORE_INPUT', 'Invalid Goal cursor identity');
        const all = this.all(), cursor = request.args.afterGoalId === undefined ? -1 : all.findIndex(goal => goal.goalId === request.args.afterGoalId);
        // Rotate the complete persisted order before eligibility filtering: a
        // paused/exhausted cursor still advances, and no first-page cap starves
        // later Goals. The caller owns this advisory cursor; GET never writes it.
        const ordered = cursor < 0 ? all : [...all.slice(cursor + 1), ...all.slice(0, cursor + 1)];
        return { goalIds: this.options.tasks.isPaused() || this.options.isPaused?.() ? [] : ordered.filter(goal => this.eligible(goal)).slice(0, limit).map(goal => goal.goalId) };
      }
      case 'core.claim': return this.claim(request.args.goalId);
      case 'core.readView': return this.readView(request.args.permit);
      case 'core.assertDispatch': return this.tx.atomic(() => this.current(request.args.permit, true));
      case 'core.assertCurrent': return this.tx.atomic(() => this.current(request.args.permit, false));
      case 'core.recordDispatch': return this.recordDispatch(request.args.permit, request.args.binding);
      case 'core.recordNativeResult': return this.recordNative(request.args.permit, request.args.receipt);
      case 'core.recordAccounting': return this.accounting(request.args);
      case 'core.commitCandidate': return this.commit(request.args);
      case 'core.markUnknown': return this.unknown(request.args.permit, request.args.reasonCode);
      case 'core.rejectEvaluation': return this.reject(request.args.permit, request.args.reasonCode);
      case 'core.pause': return this.control(request.args, 'pause');
      case 'core.resume': return this.control(request.args, 'resume');
      case 'core.cancel': return this.control(request.args, 'cancel');
      case 'core.verifyCompletion': return this.verify(request.args);
      default: {
        const unknown = (request as { command?: unknown }).command;
        return fail('UNKNOWN_CORE_COMMAND', `Unsupported Core command: ${typeof unknown === 'string' ? unknown.slice(0, 80) : 'invalid'}`);
      }
    }
  }
}
