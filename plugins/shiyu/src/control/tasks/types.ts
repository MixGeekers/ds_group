import type { Ticket } from "./upstream/model.js";
import type { WorkerReport } from "./upstream/assignments.js";

export type TaskState = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface CompletionCheck {
  checkId: string;
  type: string;
  targetRef: string;
  expected?: unknown;
  evidenceRequired: boolean;
}
export interface CompletionSpec { version: number; checks: CompletionCheck[] }
export interface TaskAdmission {
  goalId?: string;
  mandateId: string;
  mandateVersion: number;
  requestScope: string;
  requestId: string;
  payloadHash: string;
  completionSpec: CompletionSpec;
  inputRefs?: string[];
  supersedesTaskId?: string;
}
export interface TaskResultEvidence { resultHash: string; artifactRefs: string[]; effectRefs: string[] }
export interface VerificationReport {
  taskId: string;
  assignmentId: string;
  completionSpecVersion: number;
  resultHash: string;
  verifierVersion: string;
  verifiedAt: string;
  checks: { checkId: string; status: "pass" | "fail" | "inconclusive"; evidenceRefs: string[] }[];
  /** Only a trusted verifier may declare a failed check a final failure. */
  failureDisposition?: "terminal";
}
export interface VerificationContext {
  taskId: string;
  assignmentId: string;
  completionSpec: CompletionSpec;
  result: TaskResultEvidence;
}
/** Synchronous validation of evidence acquired before the transaction; never network/model I/O. */
export interface CompletionVerifier { verify(context: VerificationContext): VerificationReport }

/** Shiyu metadata persisted atomically beside the original Ticket JSON. */
export interface TaskRecord extends TaskAdmission {
  taskId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  ready?: { assignmentId: string; at: string; result: TaskResultEvidence };
  verification?: VerificationReport;
  uncertainty?: { reason: string; at: string; evidenceRefs: string[] };
  lastRecovery?: { assignmentId: string; at: string; evidenceRefs: string[] };
  cancelRequested?: { reason: string; at: string };
  terminal?: { state: "succeeded" | "failed" | "cancelled"; at: string; evidenceRefs: string[]; reason?: string };
}
/** MUST participate in the same synchronous transaction as Repositories.atomic. */
export interface TaskRecordStore {
  get(taskId: string): TaskRecord | undefined;
  save(record: TaskRecord): void;
  list(): TaskRecord[];
}
export interface TaskView {
  taskId: string;
  title: string;
  state: TaskState;
  waitReason?: string;
  version: number;
  goalId?: string;
  mandateId: string;
  mandateVersion: number;
  completionSpec: CompletionSpec;
  originEventIds: string[];
  inputRefs: string[];
  activeAssignmentId?: string;
  latestAssignmentId?: string;
  attempt: number;
  result?: TaskResultEvidence;
  verification?: VerificationReport;
  uncertainty?: TaskRecord["uncertainty"];
  stopRequested: boolean;
  supersedesTaskId?: string;
  createdAt: string;
  updatedAt: string;
}
/** Trusted recovery facts, checked outside the DB transaction by the recovery coordinator. */
export interface RecoveryProof {
  assignmentId: string;
  oldExecutionStopped: true;
  effectsKnown: true;
  evidenceRefs: string[];
}
export interface CancellationProof extends RecoveryProof {
  /** Pending start/delivery/action intents have been cancelled or made ineligible. */
  pendingIntentsInvalidated: true;
}
export interface TaskWorkerReport extends WorkerReport { result?: TaskResultEvidence }
export type TaskTicket = Ticket;
