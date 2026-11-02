import type { Budget, BudgetReservation } from '../control/policy/mandates.js';
import type { NativeGoalRef, GoalCompletionProof } from '../adapters/dsh/goals.js';
import type { TaskDetail, TaskRuntimeIdentity } from '../adapters/control-store/task-domain.js';

/** Owner-specified capabilities. Model output may select an id, never redefine its body or authority. */
export interface CoreDeliverable { id: string; title: string; content: string; dependsOn?: string[] }
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
  evaluations: number; activeEvaluationId?: string; nextEligibleAt?: string;
  /** Derived read-only diagnostics; never a native Goal state or a second budget ledger. */
  planning?: { eligible: boolean; reasonCode: string };
  createdAt: string; updatedAt: string;
}
export type CoreCandidate =
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
  candidate?: CoreCandidate; receipt?: CoreCommitReceipt; reasonCode?: string;
  dispatch?: CoreDispatchBinding; nativeReceipt?: CoreNativeResultReceipt;
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
  'core.assertDispatch': { input: { permit: CoreEvaluationPermit }; output: CoreEvaluation };
  'core.assertCurrent': { input: { permit: CoreEvaluationPermit }; output: CoreEvaluation };
  'core.recordDispatch': { input: { permit: CoreEvaluationPermit; binding: CoreDispatchBinding }; output: CoreEvaluation };
  'core.recordNativeResult': { input: { permit: CoreEvaluationPermit; receipt: CoreNativeResultReceipt }; output: CoreEvaluation };
  'core.evaluations': { input: { goalId: string }; output: CoreEvaluation[] };
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
}
export interface CoreTaskPort {
  setCoreAuthority(authority: (goalId: string, deliverableId: string) => CoreTaskDelegation): void;
  admitCoreIntent(input: { goalId: string; deliverableId: string; proposalId: string }): TaskDetail;
  get(taskId: string): TaskDetail;
  execute(request: { command: 'task.cancel'; args: { taskId: string; reason: string } }): unknown;
}
