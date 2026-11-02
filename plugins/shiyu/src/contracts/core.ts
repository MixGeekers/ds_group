import type { Budget, BudgetReservation } from '../control/policy/mandates.js';
import type { NativeGoalRef, GoalCompletionProof } from '../adapters/dsh/goals.js';
import type { TaskDetail, TaskRuntimeIdentity } from '../adapters/control-store/task-domain.js';
import type { CapabilityCapture, CapabilityRef } from './capability.js';
import type { PublishedState } from '../state/publication.js';
import type { LocalReadSafety } from '../state/safety.js';
import type { CommitWatermark } from '../adapters/control-store/commit-watermark.js';
import type { ComponentSnapshot, TrustedViewActor, ViewAccess } from '../views/index.js';

/** Owner-specified capabilities. Model output may select an id, never redefine its body or authority. */
export interface CoreDeliverable { id: string; title: string; content: string; dependsOn?: string[] }
/** Trusted plan fact references. A candidate may only cite identifiers the
 * control domain observes in the current evaluation's trusted catalog. */
export type CorePlanFactKind = 'owner_basis' | 'trigger' | 'task' | 'capability';
export interface CorePlanFactRef { kind: CorePlanFactKind; ref: string }
export type CorePlanFactState = 'resolved' | 'pending' | 'conflict' | 'unknown' | 'unsourced';
/** Trusted observation of one required fact. Model text never supplies state. */
export interface CorePlanFactStatus extends CorePlanFactRef {
  state: CorePlanFactState;
  digest?: string;
  observedAt?: string;
  reasonCode?: string;
}
/** The only artifact verifier an owner-authorized local-note step can request. */
export interface CorePlanExpectedArtifact { kind: 'local-note'; verifier: 'artifact.sha256.v1' }
export interface CorePlanStep {
  stepId: string;
  deliverableId: string;
  dependsOn: string[];
  requiredFacts: CorePlanFactRef[];
  expectedArtifact: CorePlanExpectedArtifact;
}
/** Bounded stop policy. It can only reduce work; budget/expiry/Mandate remain owner facts. */
export interface CorePlanStopConditions {
  onStepFailure: 'stop' | 'continue_independent';
  maxFailedSteps: number;
  onFactConflict: 'wait' | 'stop';
  maxParallelSteps: number;
}
/** The model-owned candidate. Trusted control material (expected hash, verifier
 * target, budget, mandate, tool identity) is never accepted from this object. */
export interface CorePlanDraft {
  basePlanVersion: number;
  steps: CorePlanStep[];
  stopConditions: CorePlanStopConditions;
  reasoningRefs: string[];
  summary: string;
}
/** Artifact expectation materialized by the control domain from the owner note. */
export interface CorePlanStepVersion extends CorePlanStep { expectedSha256: string; byteLength: number }
/** One accepted plan revision; history is bounded and queryable. */
export interface CorePlanVersion {
  schemaVersion: 2;
  goalId: string; planVersion: number; basePlanVersion: number;
  evaluationId: string; proposalId: string; acceptedAt: string;
  summary: string; reasoningRefs: string[];
  /** Trusted evaluation triggers joined to this revision, not model claims. */
  triggerRefs: string[];
  stopConditions: CorePlanStopConditions;
  steps: CorePlanStepVersion[];
  /** Fact observations at acceptance time; later drift is visible on a new claim. */
  facts: CorePlanFactStatus[];
  planHash: string;
}
export type CorePlanStepState = 'ready' | 'blocked_dependency' | 'blocked_fact' | 'active' | 'done' | 'failed' | 'unknown';
export interface CorePlanStepView extends CorePlanStepVersion {
  state: CorePlanStepState;
  taskId?: string;
  taskState?: string;
}
/** Claim-time trusted projection of the current plan and required facts. */
export interface CorePlanSnapshot {
  schemaVersion: 2; goalId: string; planVersion: number; capturedAt: string;
  current?: CorePlanVersion;
  steps: CorePlanStepView[];
  facts: CorePlanFactStatus[];
  /** Identifiers the model may cite in plan/step candidates and reasoning refs. */
  availableFacts: CorePlanFactRef[];
  stopped?: { reasonCode: string };
}
export interface CorePlanView {
  goalId: string; planVersion: number;
  current?: CorePlanVersion;
  history: CorePlanVersion[];
  snapshot?: CorePlanSnapshot;
}
/** Deterministic rejections that may settle a fully accounted native round. */
export const CORE_KNOWN_REJECTIONS = Object.freeze([
  'INVALID_CORE_CANDIDATE', 'INVALID_CORE_INPUT', 'CORE_SCOPE_DENIED', 'CORE_DEPENDENCY_PENDING',
  'CORE_DELIVERABLE_OWNED', 'CORE_SOURCE_CONFLICT', 'STALE_CORE_PERMIT', 'STALE_AUTHORITY',
  'CORE_PAUSED', 'CORE_EXPIRED', 'BUDGET_EXCEEDED', 'NATIVE_GOAL_NOT_ACTIVE', 'STALE_NATIVE_GOAL',
  'CORE_COMPLETION_UNPROVEN', 'CORE_CAPABILITY_CHANGED', 'CORE_VIEW_UNAVAILABLE',
  'CORE_PLAN_MISSING', 'CORE_PLAN_STALE', 'CORE_PLAN_INCOMPLETE', 'CORE_PLAN_STRUCTURE_INVALID',
  'CORE_PLAN_DEPENDENCY_CONFLICT', 'CORE_PLAN_DEPENDENCY_ORDER_INVALID', 'CORE_PLAN_FACT_UNSOURCED',
  'CORE_PLAN_REF_UNSOURCED', 'CORE_PLAN_VERIFIER_DENIED', 'CORE_PLAN_LIMIT', 'CORE_PLAN_REQUIRED',
  'CORE_PLAN_STOPPED', 'CORE_PLAN_PARALLEL_LIMIT', 'CORE_PLAN_ADMISSION_FAILED',
] as const);
export interface CorePrepareInput {
  requestId: string; objective: string; deliverables: CoreDeliverable[]; budget: Budget;
  expiresAt: string; maxEvaluations?: number;
}
export interface CoreNativeObservation {
  goalId: string; goalRef: NativeGoalRef; sessionId: string;
  phase: 'active' | 'paused' | 'blocked' | 'complete'; observedAt: string;
}
export interface CoreGoal {
  schemaVersion: 1; goalId: string; requestId: string; objective: string;
  deliverables: CoreDeliverable[]; budget: Budget; expiresAt: string; maxEvaluations: number;
  completionCriteria: string; completionCriteriaHash: string; version: number;
  /** Local authorization controls, not a copy of native DSH Goal.state. */
  authorized: boolean; paused: boolean; cancelled: boolean; controlEpoch: number;
  pausedAtNativeRevision?: number;
  mandateId?: string; native?: CoreNativeObservation;
  taskRefs: { deliverableId: string; taskId: string }[];
  /** Current accepted plan revision; 0 means the legacy unplanned single-step path. */
  planVersion: number;
  /** Bounded accepted-plan revisions (newest last) for traceability; never model text bodies. */
  plans?: CorePlanVersion[];
  evaluations: number; activeEvaluationId?: string; nextEligibleAt?: string;
  /** Derived read-only diagnostics; never a native Goal state or a second budget ledger. */
  planning?: { eligible: boolean; reasonCode: string };
  createdAt: string; updatedAt: string;
}
export type CoreCandidate =
  | { kind: 'plan_candidate'; plan: CorePlanDraft }
  | { kind: 'task_intent'; deliverableId: string; reason: string }
  | { kind: 'defer'; reason: string; retryAfterMs: number }
  | { kind: 'no_action'; reason: string }
  | { kind: 'complete_candidate'; reason: string };
export interface CoreEvaluationPermit extends TaskRuntimeIdentity {
  evaluationId: string; goalId: string; claimToken: string; fencingToken: number;
  controlEpoch: number; scopeVersion: number; goalRef: NativeGoalRef;
  reservationId: string; mandateId: string; mandateVersion: number; authEpoch: number;
  leaseExpiresAt: string;
}
export interface CoreEvaluation {
  evaluationId: string; goalId: string; status: 'claimed' | 'dispatching' | 'committed' | 'unknown' | 'rejected';
  permit: CoreEvaluationPermit; goal: CoreGoal;
  /** Only owner text and same-Goal Task/Effect metadata. No memory body or replyer Session history. */
  tasks: { deliverableId: string; taskId: string; version: number; state: string; effectVersions: { effectId: string; version: number; status: string }[] }[];
  triggerRefs: string[]; reservation: BudgetReservation;
  /** Trusted plan/fact projection captured with the claim; absent only on legacy rows. */
  plan?: CorePlanSnapshot;
  candidate?: CoreCandidate; receipt?: CoreCommitReceipt; reasonCode?: string;
  dispatch?: CoreDispatchBinding; nativeReceipt?: CoreNativeResultReceipt;
  /** Absent only on historical evaluations; new claims capture it atomically. */
  readCapture?: CoreReadCapture;
}
export interface CoreReadCapture {
  schemaVersion: 1; evaluationId: string; goalId: string; capturedAt: string; expiresAt: string;
  capability: CapabilityCapture; actor: TrustedViewActor; access: ViewAccess; component: ComponentSnapshot;
  publication: PublishedState; control: CommitWatermark; safety: LocalReadSafety;
}
export interface CoreDispatchBinding {
  goalId: string; goalRef: NativeGoalRef; roundId: string; sessionId: string; messageId: string; messageHash: string;
}
/** Written only by the trusted adapter after independent native flush/readback. */
export interface CoreNativeResultReceipt {
  roundId: string; sessionId: string; messageId: string; messageHash: string;
  inputRef: CoreMessageRef; assistantRef: CoreMessageRef;
  outputHash: string; observedAt: string;
}
export interface CoreMessageRef { sessionId: string; eventSeq: number; messageId: string; messageHash: string; durability: 'confirmed' }
export interface CoreCommitReceipt {
  evaluationId: string; proposalId: string; status: 'committed' | 'rejected' | 'conflict';
  kind: CoreCandidate['kind']; reasonCode: string; taskId?: string;
  planVersion?: number;
  /** Owner-scoped Tasks admitted deterministically for ready plan steps, in candidate order. */
  stepRefs?: { stepId: string; taskId: string }[];
}
export interface CoreAccounting {
  permit: CoreEvaluationPermit; receiptId: string;
  /** Only complete native invocation coverage can release unused planning allowance. */
  complete: boolean; tokens?: number; calls?: number; evidenceRef: string;
}
export interface CoreCompletionRequest {
  goalId: string; expectedVersion: number; goalRef: NativeGoalRef;
  observations: { deliverableId: string; taskId: string; taskVersion: number; artifactRef: string;
    observedSha256: string; observedBytes: number; receiptId: string; observedAt: string }[];
}
export interface CoreCommands {
  'core.prepareGoal': { input: CorePrepareInput; output: CoreGoal };
  'core.observeNativeGoal': { input: CoreNativeObservation; output: CoreGoal };
  'core.authorizeGoal': { input: { goalId: string; expectedVersion: number }; output: CoreGoal };
  'core.get': { input: { goalId: string }; output: CoreGoal };
  'core.balance': { input: { goalId: string }; output: { limits: Budget; spent: Budget; held: Budget; available: Budget } | undefined };
  'core.snapshot': { input: Record<string, never>; output: CoreGoal[] };
  'core.pending': { input: { limit?: number; afterGoalId?: string }; output: { goalIds: string[] } };
  'core.claim': { input: { goalId: string }; output: CoreEvaluation | undefined };
  'core.readView': { input: { permit: CoreEvaluationPermit }; output: CoreReadCapture };
  'core.assertDispatch': { input: { permit: CoreEvaluationPermit }; output: CoreEvaluation };
  'core.assertCurrent': { input: { permit: CoreEvaluationPermit }; output: CoreEvaluation };
  'core.recordDispatch': { input: { permit: CoreEvaluationPermit; binding: CoreDispatchBinding }; output: CoreEvaluation };
  'core.recordNativeResult': { input: { permit: CoreEvaluationPermit; receipt: CoreNativeResultReceipt }; output: CoreEvaluation };
  'core.evaluations': { input: { goalId: string }; output: CoreEvaluation[] };
  /** Read-only plan history + recomputed trusted snapshot; never writes or dispatches. */
  'core.plan': { input: { goalId: string }; output: CorePlanView };
  'core.recordAccounting': { input: CoreAccounting; output: BudgetReservation };
  'core.commitCandidate': { input: { permit: CoreEvaluationPermit; proposalId: string; candidateText: string }; output: CoreCommitReceipt };
  'core.markUnknown': { input: { permit: CoreEvaluationPermit; reasonCode: string }; output: CoreEvaluation };
  'core.rejectEvaluation': { input: { permit: CoreEvaluationPermit; reasonCode: string }; output: CoreEvaluation };
  'core.pause': { input: { goalId: string; expectedVersion: number }; output: CoreGoal };
  'core.resume': { input: { goalId: string; expectedVersion: number }; output: CoreGoal };
  'core.cancel': { input: { goalId: string; expectedVersion: number }; output: CoreGoal };
  'core.verifyCompletion': { input: CoreCompletionRequest; output: GoalCompletionProof };
}
export type CoreDomainRequest = { [K in keyof CoreCommands]: { command: K; args: CoreCommands[K]['input'] } }[keyof CoreCommands];
/** Same-Worker callback; never serialized into a public/model command. */
export interface CoreTaskDelegation {
  goalId: string; deliverableId: string; title: string; content: string; resourceRef: string;
  subjectId: string; mandateId: string; mandateVersion: number; authEpoch: number;
  sourceRefs: string[];
  /** The evaluation's persisted binding; old completed records may predate it. */
  capabilityRef?: CapabilityRef;
}
export interface CoreTaskPort {
  setCoreAuthority(authority: (goalId: string, deliverableId: string) => CoreTaskDelegation): void;
  admitCoreIntent(input: { goalId: string; deliverableId: string; proposalId: string }): TaskDetail;
  get(taskId: string): TaskDetail;
  execute(request: { command: 'task.cancel'; args: { taskId: string; reason: string } }): unknown;
}
