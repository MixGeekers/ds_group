import { Engine, type Outcome } from "./upstream/engine.js";
import { isoTime, latestAssignment, type Decision, type Ticket, type Trigger } from "./upstream/model.js";
import type { Assessor, Candidate, Executor, Outbox, Policy, Repositories, SourceScope } from "./upstream/ports.js";
import type {
  CancellationProof, CompletionVerifier, RecoveryProof, TaskAdmission, TaskRecord, TaskRecordStore,
  TaskView, TaskWorkerReport, VerificationReport,
} from "./types.js";

export type * from "./types.js";
export type { Assessor, Candidate, Executor, Outbox, Policy, Repositories, SourceScope } from "./upstream/ports.js";
export type { Assignment, Decision, Ticket, Trigger } from "./upstream/model.js";
export type { Outcome } from "./upstream/engine.js";

export class TaskError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "TaskError"; }
}
export interface TaskFacadeOptions {
  repo: Repositories;
  records: TaskRecordStore;
  policy: () => Policy;
  scope: SourceScope;
  /** These ports only persist intents in repo.atomic, never execute outside effects. */
  assessor: Assessor;
  executor: Executor;
  outbox: Outbox;
  clock: () => string;
  verifier?: CompletionVerifier;
  /** Query the authoritative EffectLedger within the same DB transaction. */
  effects?: { hasUncertaintyForTask(taskId: string): boolean };
}

const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const clone = <T>(value: T): T => structuredClone(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const refs = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonempty);
function sync<T>(value: T): T {
  if (value !== null && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") {
    fail("ASYNC_TRANSACTION", "Task transactions and ports must be synchronous");
  }
  return value;
}
function invoke<T>(fn: () => T): T {
  if (fn.constructor.name === "AsyncFunction") fail("ASYNC_TRANSACTION", "Async task ports are forbidden");
  return sync(fn());
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

/**
 * Synchronous task-domain adapter for the DB worker. Authentication, fence/lease checks
 * and evidence collection happen at trusted command boundaries before these calls.
 * Records, upstream repositories and queued port intents MUST share repo.atomic.
 * No Engine instance or worker-controlled verification status is exposed.
 */
export class TaskFacade {
  private readonly engine: Engine;
  private readonly repo: Repositories;
  private admission?: TaskAdmission;

  constructor(private readonly options: TaskFacadeOptions) {
    for (const fn of [options.clock, options.policy, options.scope.scope, options.assessor.request, options.assessor.release,
      options.executor.start, options.executor.deliver, options.executor.stop, options.outbox.send, options.outbox.status,
      options.outbox.withdraw, options.verifier?.verify, options.effects?.hasUncertaintyForTask,
      options.records.get, options.records.save, options.records.list, options.repo.atomic]) {
      if (fn?.constructor.name === "AsyncFunction") fail("ASYNC_TRANSACTION", "Async task ports are forbidden");
    }
    this.repo = {
      ...options.repo,
      atomic: <T>(work: () => T): T => options.repo.atomic(() => invoke(work)),
      triggers: options.repo.triggers, threads: options.repo.threads, decisions: options.repo.decisions,
      tickets: {
        ...options.repo.tickets,
        save: (ticket) => {
          sync(options.repo.tickets.save(ticket));
          const record = sync(options.records.get(ticket.id));
          if (record) this.save(record);
        },
      },
    };
    this.engine = new Engine({
      repo: this.repo, policy: () => this.policy(), scope: { scope: (input) => sync(options.scope.scope(input)) },
      now: () => this.now(), canResume: () => false, restartInterruptedAssignments: true,
      prepareTicket: (ticket) => {
        if (!this.admission) fail("MISSING_ADMISSION", "Task admission metadata is required");
        sync(options.records.save({ ...clone(this.admission!), taskId: ticket.id, version: 0, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt }));
        return ticket;
      },
      assessor: { request: (candidate) => sync(options.assessor.request(candidate)), release: (id) => sync(options.assessor.release?.(id)) },
      executor: {
        start: (ticket, assignment) => { if (this.dispatchable(ticket.id)) sync(options.executor.start(ticket, assignment)); },
        deliver: (ticket, assignment) => { if (this.dispatchable(ticket.id)) sync(options.executor.deliver(ticket, assignment)); },
        // Unknown work still permits a restricted stop intent; it does not prove stopping succeeded.
        stop: (ticket, assignment, reason) => sync(options.executor.stop(ticket, assignment, reason)),
      },
      outbox: {
        send: (message) => sync(options.outbox.send(message)),
        status: (id) => sync(options.outbox.status(id)),
        withdraw: (id) => sync(options.outbox.withdraw(id)),
      },
    });
  }

  receive(trigger: Trigger) {
    return this.repo.atomic(() => {
      const normalized = { ...clone(trigger), at: isoTime(trigger.at) };
      const previous = this.repo.triggers.get(trigger.id);
      if (previous && canonical(previous) !== canonical(normalized)) fail("IDEMPOTENCY_CONFLICT", "Trigger ID already names different content");
      return this.engine.receive(normalized);
    });
  }
  evaluateDue(): void { this.repo.atomic(() => this.engine.evaluateDue()); }
  candidate(triggerId: string): Candidate | undefined { return clone(this.engine.candidate(triggerId)); }
  candidateDelivered(evalId: string): void { this.repo.atomic(() => this.engine.candidateDelivered(evalId)); }

  decide(triggerId: string, outcome: Outcome, admission?: TaskAdmission): Decision {
    return this.repo.atomic(() => {
      if (outcome.kind !== "accept") {
        const decision = this.engine.decide(triggerId, outcome);
        if (decision.kind === "stop" && decision.ticketId) {
          this.save({ ...this.record(decision.ticketId), cancelRequested: { reason: "decision_stop", at: this.now() } });
        }
        return decision;
      }
      this.validateAdmission(admission);
      const incoming = admission!;
      const previous = sync(this.options.records.list()).find((record) => record.requestScope === incoming.requestScope && record.requestId === incoming.requestId);
      if (previous) {
        const { taskId, version, createdAt, updatedAt, ready, verification, uncertainty, lastRecovery, cancelRequested, terminal, ...original } = previous;
        if (canonical(original) !== canonical(incoming)) fail("IDEMPOTENCY_CONFLICT", "Request identity already names different task admission");
        const ticket = this.ticket(taskId);
        if (!ticket.origin.triggerIds.includes(triggerId)) this.engine.decide(triggerId, { kind: "ignore", reason: "duplicateRequest", ...outcome.evalId ? { evalId: outcome.evalId } : {} });
        return this.repo.decisions.get(ticket.decisionId) ?? fail("TASK_RECORD_MISSING", "Task decision is missing");
      }
      if (this.admission) fail("REENTRANT_ADMISSION", "Task admission may not reenter");
      this.admission = clone(incoming);
      try { return this.engine.decide(triggerId, outcome); }
      finally { this.admission = undefined; }
    });
  }

  get(taskId: string): TaskView { return this.project(this.ticket(taskId), this.record(taskId)); }
  list(): TaskView[] { return sync(this.options.records.list()).map((record) => this.project(this.ticket(record.taskId), record)); }

  assignmentStarted(taskId: string, assignmentId: string): TaskView {
    return this.change(taskId, () => { this.current(taskId, assignmentId, true); this.engine.assignmentStarted(taskId, assignmentId); });
  }
  inputsDelivered(taskId: string, assignmentId: string, inputIds: string[]): TaskView {
    return this.change(taskId, () => { this.current(taskId, assignmentId); this.engine.inputsDelivered(taskId, assignmentId, inputIds); });
  }
  inputsRead(taskId: string, assignmentId: string, inputIds: string[]): TaskView {
    return this.change(taskId, () => { this.current(taskId, assignmentId); this.engine.inputsRead(taskId, inputIds); });
  }
  report(taskId: string, assignmentId: string, report: TaskWorkerReport): TaskView {
    return this.change(taskId, () => {
      if (!["progress", "waiting", "ready", "blocked", "failed", "dropped"].includes(report.state) || typeof report.summary !== "string") {
        fail("INVALID_REPORT", "Worker reports require a registered state and summary");
      }
      this.current(taskId, assignmentId, report.state === "failed");
      if (report.state === "ready") {
        if (!report.result || !nonempty(report.result.resultHash) || !refs(report.result.artifactRefs) || !refs(report.result.effectRefs)) {
          fail("INVALID_RESULT", "A ready report requires a result hash and typed reference lists");
        }
        this.save({ ...this.record(taskId), ready: { assignmentId, at: this.now(), result: clone(report.result!) } });
      }
      const { result: _result, ...workerReport } = report;
      this.engine.report(taskId, workerReport);
    });
  }
  attach(taskId: string, triggerId: string, note?: string): TaskView {
    return this.change(taskId, () => { this.mutable(taskId); this.engine.attach(taskId, triggerId, note); });
  }
  retry(taskId: string): TaskView {
    return this.change(taskId, () => {
      this.mutable(taskId); this.authorized(taskId);
      this.engine.retryTicket(taskId);
    });
  }

  /** Only the injected trusted verifier can supply check outcomes. */
  verifyCompletion(taskId: string): TaskView {
    return this.change(taskId, () => {
      const record = this.mutable(taskId);
      const ticket = this.ticket(taskId), ready = record.ready;
      if (!ready || !ticket.ended || latestAssignment(ticket)?.state !== "ended" || latestAssignment(ticket)?.id !== ready.assignmentId || latestAssignment(ticket)?.report?.state !== "ready") {
        fail("RESULT_NOT_READY", "The current assignment has not submitted a verifiable result");
      }
      const verifier = this.options.verifier ?? fail("VERIFIER_UNAVAILABLE", "Completion requires a trusted verifier");
      const result = sync(verifier.verify(clone({ taskId, assignmentId: ready!.assignmentId, completionSpec: record.completionSpec, result: ready!.result })));
      this.validateVerification(record, result);
      const evidenceRefs = [...new Set(result.checks.flatMap((check) => check.evidenceRefs))];
      const passed = result.checks.every((check) => check.status === "pass");
      if (passed && !evidenceRefs.length) fail("INVALID_VERIFICATION", "Completion requires evidence references");
      const failed = result.checks.some((check) => check.status === "fail") && result.failureDisposition === "terminal";
      this.save({ ...record, verification: clone(result), ...(passed || failed ? {
        terminal: { state: passed ? "succeeded" : "failed", at: this.now(), evidenceRefs },
      } : {}) });
    });
  }

  markUnknown(taskId: string, reason: string, evidenceRefs: string[] = []): TaskView {
    return this.change(taskId, () => {
      const record = this.record(taskId);
      if (record.terminal) fail("TASK_TERMINAL", "A terminal task cannot reenter recovery");
      if (!nonempty(reason) || !refs(evidenceRefs)) fail("INVALID_EVIDENCE", "Unknown state requires a reason and reference list");
      this.save({ ...record, uncertainty: { reason, evidenceRefs: clone(evidenceRefs), at: this.now() } });
      const ticket = this.ticket(taskId), current = latestAssignment(ticket);
      if (current && current.state !== "ended") sync(this.options.executor.stop(ticket, current, "resultUnknown"));
    });
  }

  /** No proof means unknown, never upstream's automatic restart. Not callable by workers. */
  recover(taskId: string, assignmentId: string, proof?: RecoveryProof): TaskView {
    return this.change(taskId, () => {
      const record = this.record(taskId), ticket = this.ticket(taskId), assignment = latestAssignment(ticket);
      if (record.terminal) fail("TASK_TERMINAL", "Terminal tasks are not recoverable");
      if (assignment?.id !== assignmentId) fail("STALE_ASSIGNMENT", "Recovery must identify the latest assignment");
      if (!proof) { this.markUnknown(taskId, "execution_interrupted"); return; }
      this.checkProof(assignmentId, proof);
      if (this.effectsUnknown(taskId)) fail("RESULT_UNKNOWN", "Effect ledger uncertainty must be reconciled before recovery");
      if (record.cancelRequested) fail("CANCEL_REQUESTED", "Recovery cannot restart cancelled work");
      this.authorized(taskId);
      const { uncertainty: _unknown, ...known } = record;
      this.save({ ...known, lastRecovery: { assignmentId, at: this.now(), evidenceRefs: clone(proof.evidenceRefs) } });
      if (ticket.ended) return; // A ready result needs verification, not a fresh execution.
      if (assignment!.state === "pending") {
        this.engine.report(taskId, { state: "failed", summary: "Startup interrupted; recovery evidence confirms no unresolved effects" });
        this.engine.retryTicket(taskId);
      } else this.engine.assignmentInterrupted(taskId, assignmentId);
    });
  }

  requestCancel(taskId: string, reason: string): TaskView {
    return this.change(taskId, () => {
      const record = this.record(taskId);
      if (record.terminal) fail("TASK_TERMINAL", "A terminal task cannot be cancelled");
      if (!nonempty(reason)) fail("INVALID_REASON", "Cancellation needs a reason");
      this.save({ ...record, cancelRequested: { reason, at: this.now() } });
      this.engine.stopTicket(taskId, reason);
    });
  }
  confirmCancelled(taskId: string, proof: CancellationProof): TaskView {
    return this.change(taskId, () => {
      const record = this.record(taskId);
      if (record.terminal || !record.cancelRequested) fail("CANCEL_NOT_REQUESTED", "Cancellation must first be requested on a live task");
      const assignment = latestAssignment(this.ticket(taskId));
      if (!assignment) fail("STALE_ASSIGNMENT", "No assignment to reconcile");
      this.checkProof(assignment!.id, proof);
      if (this.effectsUnknown(taskId)) fail("RESULT_UNKNOWN", "Effect ledger uncertainty must be reconciled before cancellation completes");
      if (proof.pendingIntentsInvalidated !== true) fail("RECONCILIATION_REQUIRED", "Pending action intents must be invalidated before cancellation completes");
      const { uncertainty: _unknown, ...known } = record;
      this.save({ ...known, terminal: { state: "cancelled", at: this.now(), evidenceRefs: clone(proof.evidenceRefs), reason: record.cancelRequested!.reason } });
    });
  }

  private change(taskId: string, work: () => void): TaskView { return this.repo.atomic(() => { invoke(work); return this.get(taskId); }); }
  private now(): string { return isoTime(invoke(this.options.clock)); }
  private ticket(taskId: string): Ticket { return this.repo.tickets.get(taskId) ?? fail("UNKNOWN_TASK", "Task does not exist"); }
  private record(taskId: string): TaskRecord { return sync(this.options.records.get(taskId)) ?? fail("TASK_RECORD_MISSING", "Task metadata does not exist"); }
  private save(record: TaskRecord): void { sync(this.options.records.save({ ...record, version: record.version + 1, updatedAt: this.now() })); }
  private dispatchable(taskId: string): boolean {
    const record = this.record(taskId);
    return !record.uncertainty && !this.effectsUnknown(taskId) && !record.terminal && !record.cancelRequested;
  }
  private mutable(taskId: string): TaskRecord {
    const record = this.record(taskId);
    if (record.uncertainty || this.effectsUnknown(taskId)) fail("RESULT_UNKNOWN", "Resolve uncertain effects before changing execution");
    if (record.terminal) fail("TASK_TERMINAL", "Terminal tasks do not resume; admit a new task");
    if (record.cancelRequested) fail("CANCEL_REQUESTED", "Cancellation is pending reconciliation");
    return record;
  }
  private current(taskId: string, assignmentId: string, pending = false): void {
    this.mutable(taskId);
    const ticket = this.ticket(taskId), assignment = latestAssignment(ticket);
    if (ticket.ended || assignment?.id !== assignmentId || assignment.state === "ended" || (!pending && assignment.state !== "running")) {
      fail("STALE_ASSIGNMENT", "Report does not belong to the current executable assignment");
    }
  }
  private authorized(taskId: string): void {
    const policy = this.policy();
    if (policy.paused || !sync(policy.revalidate(this.ticket(taskId).mandate))) fail("FORBIDDEN", "Current policy does not permit execution");
  }
  private policy(): Policy {
    const policy = invoke(this.options.policy);
    for (const fn of [policy.gate, policy.revalidate, policy.admitsInferred]) {
      if (fn.constructor.name === "AsyncFunction") fail("ASYNC_TRANSACTION", "Async policy ports are forbidden");
    }
    return { ...policy, gate: (...args) => sync(policy.gate(...args)), revalidate: (mandate) => sync(policy.revalidate(mandate)),
      admitsInferred: (rules) => sync(policy.admitsInferred(rules)) };
  }
  private effectsUnknown(taskId: string): boolean {
    if (!this.options.effects) return false;
    const value = sync(this.options.effects.hasUncertaintyForTask(taskId));
    if (typeof value !== "boolean") fail("INVALID_EFFECT_STATE", "Effect uncertainty query must return a boolean");
    return value;
  }
  private checkProof(assignmentId: string, proof: RecoveryProof): void {
    if (proof.assignmentId !== assignmentId || proof.oldExecutionStopped !== true || proof.effectsKnown !== true || !refs(proof.evidenceRefs) || !proof.evidenceRefs.length) {
      fail("RECONCILIATION_REQUIRED", "Recovery requires evidence that the old execution stopped and effects are known");
    }
  }
  private validateAdmission(admission: TaskAdmission | undefined): void {
    if (!admission || ![admission.mandateId, admission.requestScope, admission.requestId, admission.payloadHash].every(nonempty)
      || !Number.isInteger(admission.mandateVersion) || admission.mandateVersion < 1
      || !admission.completionSpec || !Number.isInteger(admission.completionSpec.version) || admission.completionSpec.version < 1
      || !Array.isArray(admission.completionSpec.checks) || !admission.completionSpec.checks.length) fail("INVALID_ADMISSION", "Task identity, mandate and completion checks are required");
    const checks = admission!.completionSpec.checks;
    if (new Set(checks.map((check) => check.checkId)).size !== checks.length || checks.some((check) =>
      ![check.checkId, check.type, check.targetRef].every(nonempty) || typeof check.evidenceRequired !== "boolean")) fail("INVALID_ADMISSION", "Completion checks must have unique typed identities");
    if (admission!.supersedesTaskId && !this.record(admission!.supersedesTaskId).terminal) fail("INVALID_ADMISSION", "A redo must reference a terminal predecessor");
  }
  private validateVerification(record: TaskRecord, result: VerificationReport): void {
    if (!result || result.taskId !== record.taskId || result.assignmentId !== record.ready?.assignmentId
      || result.resultHash !== record.ready.result.resultHash || result.completionSpecVersion !== record.completionSpec.version
      || (result.failureDisposition !== undefined && result.failureDisposition !== "terminal")
      || !nonempty(result.verifierVersion) || !nonempty(result.verifiedAt) || !Number.isFinite(Date.parse(result.verifiedAt)) || !Array.isArray(result.checks)) {
      fail("INVALID_VERIFICATION", "Verification must bind the task, current result and completion spec");
    }
    const checks = new Map(result.checks.map((check) => [check.checkId, check]));
    if (checks.size !== result.checks.length || checks.size !== record.completionSpec.checks.length) fail("INVALID_VERIFICATION", "Every completion check must appear exactly once");
    for (const required of record.completionSpec.checks) {
      const check = checks.get(required.checkId);
      if (!check || !["pass", "fail", "inconclusive"].includes(check.status) || !refs(check.evidenceRefs)
        || (required.evidenceRequired && check.status !== "inconclusive" && !check.evidenceRefs.length)) fail("INVALID_VERIFICATION", "Completion check evidence is missing or malformed");
    }
  }
  private project(ticket: Ticket, record: TaskRecord): TaskView {
    const assignment = latestAssignment(ticket);
    let state: TaskView["state"], waitReason: string | undefined;
    if (record.uncertainty || this.effectsUnknown(ticket.id)) { state = "unknown"; waitReason = "effect_reconciliation"; }
    else if (record.terminal) state = record.terminal.state;
    else if (record.cancelRequested) { state = "waiting"; waitReason = "cancel_requested"; }
    else if (record.ready || ticket.ended) { state = "waiting"; waitReason = record.verification ? "completion_unconfirmed" : "completion_verification"; }
    else if (ticket.delivery) { state = "waiting"; waitReason = "delivery_failed"; }
    else if (assignment?.report && ["waiting", "blocked", "failed"].includes(assignment.report.state)) { state = "waiting"; waitReason = assignment.report.state; }
    else state = assignment?.state === "running" ? "running" : "queued";
    return clone({ taskId: ticket.id, title: ticket.title, state, ...waitReason ? { waitReason } : {}, version: record.version,
      ...record.goalId ? { goalId: record.goalId } : {}, mandateId: record.mandateId, mandateVersion: record.mandateVersion,
      completionSpec: record.completionSpec, originEventIds: ticket.origin.triggerIds, inputRefs: record.inputRefs ?? [],
      ...assignment?.state !== "ended" && assignment ? { activeAssignmentId: assignment.id } : {},
      ...assignment ? { latestAssignmentId: assignment.id } : {}, attempt: ticket.assignments.length,
      ...record.ready ? { result: record.ready.result } : {}, ...record.verification ? { verification: record.verification } : {},
      ...record.uncertainty ? { uncertainty: record.uncertainty } : {}, stopRequested: !!record.cancelRequested,
      ...record.supersedesTaskId ? { supersedesTaskId: record.supersedesTaskId } : {}, createdAt: record.createdAt, updatedAt: record.updatedAt });
  }
}
