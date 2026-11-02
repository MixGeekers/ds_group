import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TaskFacade, type Candidate, type Repositories, type TaskAdmission, type TaskRecord, type TaskRecordStore,
  type TaskFacadeOptions, type Trigger, type VerificationContext, type VerificationReport } from "../src/control/tasks/index.js";
import { Engine } from "../src/control/tasks/upstream/engine.js";
import { SQLiteTaskRepositories } from "../src/adapters/control-store/task-repositories.js";

// Test-only upstream memory fixture; production code does not import vendor or this fixture.
const { MemoryRepositories } = await import(new URL("../vendor/dsh-superagent/src/core/memory.ts", import.meta.url).href) as {
  MemoryRepositories: new () => Repositories;
};
const code = (expected: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === expected;
const clone = <T>(value: T): T => structuredClone(value);
const trigger = (id: string, patch: Partial<Trigger> = {}): Trigger => ({ id, source: "synthetic", threads: [{ source: "synthetic", id: "conversation" }],
  actor: { source: "synthetic", id: "user" }, human: true, at: "2026-11-02T12:00:00.000Z", text: `request ${id}`, meta: {}, ...patch });
const admission = (id: string, patch: Partial<TaskAdmission> = {}): TaskAdmission => ({ mandateId: "mandate-1", mandateVersion: 1,
  requestScope: "synthetic-test", requestId: id, payloadHash: `hash-${id}`,
  completionSpec: { version: 1, checks: [{ checkId: "artifact", type: "sha256", targetRef: "artifact:test", evidenceRequired: true }] }, ...patch });
const verified = (context: VerificationContext): VerificationReport => ({ taskId: context.taskId, assignmentId: context.assignmentId,
  completionSpecVersion: context.completionSpec.version, resultHash: context.result.resultHash, verifierVersion: "synthetic/1",
  verifiedAt: "2026-11-02T12:00:02.000Z", checks: [{ checkId: "artifact", status: "pass", evidenceRefs: ["evidence:artifact-sha256"] }] });

function fixture() {
  const memory = new MemoryRepositories();
  let rows = new Map<string, TaskRecord>();
  let intents: { kind: string; taskId?: string; assignmentId?: string }[] = [];
  let candidates: Candidate[] = [];
  let rejectRecord = false, rejectStart = false;
  let clock = 0, paused = false, permitted = true;
  let verify: ((context: VerificationContext) => VerificationReport) | undefined = verified;
  const records: TaskRecordStore = {
    get: (id) => clone(rows.get(id)),
    save: (record) => { if (rejectRecord) throw new Error("injected metadata write failure"); rows.set(record.taskId, clone(record)); },
    list: () => [...rows.values()].map(clone),
  };
  const repo: Repositories = {
    ...memory, triggers: memory.triggers, threads: memory.threads, tickets: memory.tickets, decisions: memory.decisions,
    atomic: <T>(work: () => T): T => {
      const previous = { rows: clone(rows), intents: clone(intents), candidates: clone(candidates) };
      try { return memory.atomic(work); }
      catch (error) { rows = previous.rows; intents = previous.intents; candidates = previous.candidates; throw error; }
    },
  };
  const options: TaskFacadeOptions = {
    repo, records, clock: () => new Date(Date.UTC(2026, 10, 2, 12, 0, 0, clock++)).toISOString(),
    policy: () => ({ version: "policy-1", paused, evalTimeoutMs: 60_000, gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }),
      revalidate: () => permitted, admitsInferred: () => false }),
    scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: (candidate) => { candidates.push(clone(candidate)); } },
    executor: {
      start: (ticket, assignment) => { if (rejectStart) throw new Error("injected start intent failure"); intents.push({ kind: "start", taskId: ticket.id, assignmentId: assignment.id }); },
      deliver: (ticket, assignment) => { intents.push({ kind: "deliver", taskId: ticket.id, assignmentId: assignment.id }); },
      stop: (ticket, assignment) => { intents.push({ kind: "stop", taskId: ticket.id, assignmentId: assignment.id }); },
    },
    outbox: { send: () => { intents.push({ kind: "outbox" }); }, status: () => undefined, withdraw: () => undefined },
    verifier: { verify: (context) => { if (!verify) throw new Error("injected verifier unavailable"); return verify(context); } },
  };
  let facade = new TaskFacade(options);
  const admit = (id = "one", metadata = admission(id)) => {
    facade.receive(trigger(id)); facade.evaluateDue();
    const candidate = facade.candidate(id)!;
    const decision = facade.decide(id, { kind: "accept", title: "Synthetic task", scope: "read synthetic artifact", reason: "explicit request", evalId: candidate.evalId }, metadata);
    return facade.get(decision.ticketId!);
  };
  const ready = (taskId: string, assignmentId: string) => {
    facade.assignmentStarted(taskId, assignmentId);
    return facade.report(taskId, assignmentId, { state: "ready", summary: "Worker claims done", result: { resultHash: "result-sha256", artifactRefs: ["artifact:test"], effectRefs: [] } });
  };
  return { repo, records, options, admit, ready, get facade() { return facade; }, get candidates() { return candidates; }, get intents() { return intents; },
    restart: () => { facade = new TaskFacade(options); }, pause: (value: boolean) => { paused = value; }, permit: (value: boolean) => { permitted = value; },
    setVerifier: (value: typeof verify) => { verify = value; }, failRecord: (value: boolean) => { rejectRecord = value; }, failStart: (value: boolean) => { rejectStart = value; } };
}

test("real reused Engine intake → eval → decision → assignment → ready requires verifier evidence", () => {
  const h = fixture(); const task = h.admit();
  assert.equal(h.candidates.length, 1); assert.equal(task.state, "queued"); assert.equal(h.intents.filter((i) => i.kind === "start").length, 1);
  assert.equal(h.facade.assignmentStarted(task.taskId, task.activeAssignmentId!).state, "running");
  const result = h.facade.report(task.taskId, task.activeAssignmentId!, { state: "ready", summary: "done", result: { resultHash: "result-sha256", artifactRefs: ["artifact:test"], effectRefs: [] } });
  assert.equal(result.state, "waiting"); assert.equal(result.waitReason, "completion_verification");
  assert.equal(h.repo.tickets.get(task.taskId)!.ended?.outcome, "completed");
  assert.equal(h.facade.verifyCompletion(task.taskId).state, "succeeded");
  assert.deepEqual(h.facade.get(task.taskId).verification?.checks[0].evidenceRefs, ["evidence:artifact-sha256"]);
});

test("completion validation rejects absent, duplicate, stale and unproven check results", () => {
  const invalid: ((context: VerificationContext) => VerificationReport)[] = [
    (c) => ({ ...verified(c), checks: [] }),
    (c) => ({ ...verified(c), checks: [...verified(c).checks, ...verified(c).checks] }),
    (c) => ({ ...verified(c), assignmentId: "stale-assignment" }),
    (c) => ({ ...verified(c), resultHash: "different-result" }),
    (c) => ({ ...verified(c), completionSpecVersion: 99 }),
    (c) => ({ ...verified(c), failureDisposition: "retryable" } as unknown as VerificationReport),
    (c) => ({ ...verified(c), checks: [{ checkId: "artifact", status: "pass", evidenceRefs: [] }] }),
  ];
  for (const verify of invalid) {
    const h = fixture(); const task = h.admit(); h.ready(task.taskId, task.activeAssignmentId!); h.setVerifier(verify);
    assert.throws(() => h.facade.verifyCompletion(task.taskId), code("INVALID_VERIFICATION"));
    assert.equal(h.facade.get(task.taskId).state, "waiting"); assert.equal(h.records.get(task.taskId)!.verification, undefined);
  }
  const h = fixture(); const task = h.admit(); h.ready(task.taskId, task.activeAssignmentId!);
  const withoutVerifier = new TaskFacade({ ...h.options, verifier: undefined });
  assert.throws(() => withoutVerifier.verifyCompletion(task.taskId), code("VERIFIER_UNAVAILABLE"));
  h.setVerifier((c) => ({ ...verified(c), checks: [{ checkId: "artifact", status: "inconclusive", evidenceRefs: [] }] }));
  assert.equal(h.facade.verifyCompletion(task.taskId).state, "waiting");
  h.setVerifier((c) => ({ ...verified(c), failureDisposition: "terminal", checks: [{ checkId: "artifact", status: "fail", evidenceRefs: ["evidence:mismatch"] }] }));
  assert.equal(h.facade.verifyCompletion(task.taskId).state, "failed");
});

test("terminal follow-up goes to evaluation; attach and clock cannot resurrect its old Task", () => {
  const h = fixture(); const task = h.admit(); h.ready(task.taskId, task.activeAssignmentId!); h.facade.verifyCompletion(task.taskId);
  const starts = h.intents.filter((i) => i.kind === "start").length;
  h.pause(true); h.facade.receive(trigger("followup")); h.facade.evaluateDue();
  h.pause(false); h.facade.evaluateDue();
  assert.ok(h.facade.candidate("followup")); assert.equal(h.repo.triggers.disposition("followup")!.fanout.length, 0);
  assert.equal(h.facade.get(task.taskId).state, "succeeded"); assert.equal(h.facade.get(task.taskId).attempt, 1);
  assert.equal(h.intents.filter((i) => i.kind === "start").length, starts);
  assert.throws(() => h.facade.attach(task.taskId, "followup"), code("TASK_TERMINAL"));
  const decision = h.facade.decide("followup", { kind: "accept", title: "Explicit redo", scope: "same bounded artifact", reason: "new request" }, admission("redo", { supersedesTaskId: task.taskId }));
  assert.notEqual(decision.ticketId, task.taskId); assert.equal(h.facade.get(decision.ticketId!).supersedesTaskId, task.taskId);
});

test("unknown persists across facade recreation and blocks late receipts, new delivery and unproved restart", () => {
  const h = fixture(); const task = h.admit(); const id = task.activeAssignmentId!;
  h.facade.assignmentStarted(task.taskId, id); h.facade.recover(task.taskId, id);
  assert.equal(h.facade.get(task.taskId).state, "unknown");
  const starts = h.intents.filter((i) => i.kind === "start").length;
  const deliveries = h.intents.filter((i) => i.kind === "deliver").length;
  h.restart(); h.facade.receive(trigger("late-message")); h.facade.evaluateDue();
  assert.equal(h.facade.get(task.taskId).state, "unknown");
  assert.throws(() => h.facade.assignmentStarted(task.taskId, id), code("RESULT_UNKNOWN"));
  assert.throws(() => h.facade.report(task.taskId, id, { state: "ready", summary: "late", result: { resultHash: "late", artifactRefs: [], effectRefs: [] } }), code("RESULT_UNKNOWN"));
  assert.throws(() => h.facade.inputsRead(task.taskId, id, []), code("RESULT_UNKNOWN"));
  assert.throws(() => h.facade.retry(task.taskId), code("RESULT_UNKNOWN"));
  assert.throws(() => h.facade.verifyCompletion(task.taskId), code("RESULT_UNKNOWN"));
  assert.equal(h.intents.filter((i) => i.kind === "start").length, starts);
  assert.equal(h.intents.filter((i) => i.kind === "deliver").length, deliveries);
  assert.throws(() => h.facade.recover(task.taskId, id, { assignmentId: id, oldExecutionStopped: true, effectsKnown: true, evidenceRefs: [] }), code("RECONCILIATION_REQUIRED"));
  h.permit(false);
  const proof = { assignmentId: id, oldExecutionStopped: true, effectsKnown: true, evidenceRefs: ["receipt:stopped-and-no-effects"] } as const;
  assert.throws(() => h.facade.recover(task.taskId, id, { ...proof, evidenceRefs: [...proof.evidenceRefs] }), code("FORBIDDEN"));
  h.permit(true);
  const recovered = h.facade.recover(task.taskId, id, { ...proof, evidenceRefs: [...proof.evidenceRefs] });
  assert.equal(recovered.state, "queued"); assert.equal(recovered.attempt, 2); assert.notEqual(recovered.activeAssignmentId, id);
});

test("a previous assignment cannot report into the current assignment", () => {
  const h = fixture(); const task = h.admit(); const old = task.activeAssignmentId!;
  h.facade.assignmentStarted(task.taskId, old); h.facade.report(task.taskId, old, { state: "failed", summary: "known failure" });
  const retried = h.facade.retry(task.taskId); h.facade.assignmentStarted(task.taskId, retried.activeAssignmentId!);
  assert.throws(() => h.facade.report(task.taskId, old, { state: "ready", summary: "stale", result: { resultHash: "stale", artifactRefs: [], effectRefs: [] } }), code("STALE_ASSIGNMENT"));
  assert.equal(h.facade.get(task.taskId).state, "running");
});

test("authoritative effect uncertainty blocks completion and recovery even before sidecar is marked", () => {
  const h = fixture(); const task = h.admit(); const id = task.activeAssignmentId!;
  h.ready(task.taskId, id);
  let unresolved = true;
  const facade = new TaskFacade({ ...h.options, effects: { hasUncertaintyForTask: () => unresolved } });
  assert.equal(h.records.get(task.taskId)!.uncertainty, undefined);
  assert.equal(facade.get(task.taskId).state, "unknown");
  assert.throws(() => facade.verifyCompletion(task.taskId), code("RESULT_UNKNOWN"));
  assert.throws(() => facade.recover(task.taskId, id, { assignmentId: id, oldExecutionStopped: true, effectsKnown: true, evidenceRefs: ["untrusted:claim"] }), code("RESULT_UNKNOWN"));
  unresolved = false;
  assert.equal(facade.verifyCompletion(task.taskId).state, "succeeded");
});

test("proven recovery of a settled worker replaces its stopped assignment instead of reusing it", () => {
  for (const state of ["waiting", "blocked", "failed"] as const) {
    const h = fixture(); const task = h.admit(); const old = task.activeAssignmentId!;
    h.facade.assignmentStarted(task.taskId, old); h.facade.report(task.taskId, old, { state, summary: "settled worker" });
    h.facade.markUnknown(task.taskId, "host lost");
    const recovered = h.facade.recover(task.taskId, old, { assignmentId: old, oldExecutionStopped: true, effectsKnown: true, evidenceRefs: ["receipt:old-stopped"] });
    assert.equal(recovered.state, "queued"); assert.equal(recovered.attempt, 2); assert.notEqual(recovered.activeAssignmentId, old);
    assert.equal(h.records.get(task.taskId)!.lastRecovery!.assignmentId, old);
    assert.throws(() => h.facade.report(task.taskId, old, { state: "ready", summary: "late", result: { resultHash: "old", artifactRefs: [], effectRefs: [] } }), code("STALE_ASSIGNMENT"));
  }
});

test("cancel request retains uncertainty until controlled stop/effect reconciliation", () => {
  const h = fixture(); const task = h.admit(); const id = task.activeAssignmentId!;
  h.facade.assignmentStarted(task.taskId, id); h.facade.markUnknown(task.taskId, "lost-receipt");
  assert.equal(h.facade.requestCancel(task.taskId, "user cancelled").state, "unknown");
  assert.ok(h.intents.filter((intent) => intent.kind === "stop").length > 0);
  const final = h.facade.confirmCancelled(task.taskId, { assignmentId: id, oldExecutionStopped: true, effectsKnown: true, pendingIntentsInvalidated: true, evidenceRefs: ["receipt:stop", "receipt:effects-known"] });
  assert.equal(final.state, "cancelled"); assert.equal(final.stopRequested, true);
  assert.throws(() => h.facade.recover(task.taskId, id), code("TASK_TERMINAL"));
});

test("duplicate intake/request content is compared and preserves one task", () => {
  const h = fixture(); const task = h.admit();
  assert.equal(h.facade.receive(trigger("one")), "duplicate");
  assert.throws(() => h.facade.receive(trigger("one", { text: "different" })), code("IDEMPOTENCY_CONFLICT"));
  const outcome = { kind: "accept", title: "Synthetic task", scope: "read synthetic artifact", reason: "explicit request" } as const;
  assert.equal(h.facade.decide("one", outcome, admission("one")).ticketId, task.taskId);
  assert.throws(() => h.facade.decide("one", outcome, admission("one", { payloadHash: "changed" })), code("IDEMPOTENCY_CONFLICT"));
  assert.equal(h.facade.list().length, 1);
});

test("repository, sidecar and queued intents roll back together on admission or metadata failure", () => {
  const h = fixture(); h.facade.receive(trigger("one")); h.facade.evaluateDue();
  h.failStart(true);
  assert.throws(() => h.facade.decide("one", { kind: "accept", title: "test", scope: "bounded", reason: "explicit" }, admission("one")), /start intent failure/);
  assert.equal(h.records.list().length, 0); assert.equal(h.repo.tickets.list().length, 0); assert.equal(h.intents.length, 0);
  h.failStart(false);
  const task = h.admit(); const id = task.activeAssignmentId!; const before = clone(h.repo.tickets.get(task.taskId));
  h.failRecord(true);
  assert.throws(() => h.facade.assignmentStarted(task.taskId, id), /metadata write failure/);
  assert.deepEqual(h.repo.tickets.get(task.taskId), before); assert.equal(h.facade.get(task.taskId).state, "queued");
});

test("async ports and thenable queue results are rejected within the transaction", () => {
  const h = fixture();
  assert.throws(() => new TaskFacade({ ...h.options, executor: { ...h.options.executor, start: async () => undefined } }), code("ASYNC_TRANSACTION"));
  const facade = new TaskFacade({ ...h.options, outbox: { ...h.options.outbox, send: () => Promise.resolve() } });
  facade.receive(trigger("one", { channel: { source: "synthetic", thread: "conversation", address: {} } })); facade.evaluateDue();
  assert.throws(() => facade.decide("one", { kind: "accept", title: "test", scope: "bounded", reason: "explicit", acknowledgement: "accepted" }, admission("one")), code("ASYNC_TRANSACTION"));
  assert.equal(h.records.list().length, 0); assert.equal(h.repo.tickets.list().length, 0);
});

test("copied core keeps upstream continuation default when canResume is not supplied", () => {
  const h = fixture();
  const engine = new Engine({ repo: h.repo, policy: h.options.policy, scope: h.options.scope, assessor: h.options.assessor,
    executor: h.options.executor, outbox: h.options.outbox, now: h.options.clock });
  engine.receive(trigger("one")); engine.evaluateDue();
  const decision = engine.decide("one", { kind: "accept", title: "original behavior", scope: "test", reason: "explicit" });
  const ticket = h.repo.tickets.get(decision.ticketId!)!; const id = ticket.assignments[0].id;
  engine.assignmentStarted(ticket.id, id); engine.report(ticket.id, { state: "ready", summary: "done" });
  engine.receive(trigger("followup"));
  assert.equal(h.repo.tickets.get(ticket.id)!.ended, undefined); assert.equal(h.repo.tickets.get(ticket.id)!.assignments.length, 2);
  const resumed = h.repo.tickets.get(ticket.id)!.assignments.at(-1)!.id;
  engine.assignmentStarted(ticket.id, resumed); engine.report(ticket.id, { state: "waiting", summary: "settled" });
  engine.assignmentInterrupted(ticket.id, resumed);
  assert.equal(h.repo.tickets.get(ticket.id)!.assignments.at(-1)!.id, resumed);
});

test("Facade and SQLite repositories share real nested transactions with queued effects", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const repo = new SQLiteTaskRepositories(db); const h = fixture();
  db.exec("CREATE TABLE synthetic_effects (id TEXT PRIMARY KEY)");
  let reject = true;
  const facade = new TaskFacade({ ...h.options, repo, records: repo.records, executor: { ...h.options.executor,
    start: (_ticket, assignment) => { db.prepare("INSERT INTO synthetic_effects VALUES (?)").run(assignment.id); if (reject) throw new Error("effect queue failed"); },
  } });
  facade.receive(trigger("sqlite")); facade.evaluateDue();
  const outcome = { kind: "accept", title: "SQLite task", scope: "bounded", reason: "explicit" } as const;
  assert.throws(() => facade.decide("sqlite", outcome, admission("sqlite")), /effect queue failed/);
  assert.equal(repo.records.list().length, 0); assert.equal(repo.tickets.list().length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM synthetic_effects").get()!.count, 0);
  reject = false;
  const taskId = facade.decide("sqlite", outcome, admission("sqlite")).ticketId!;
  const assignmentId = facade.get(taskId).activeAssignmentId!;
  facade.assignmentStarted(taskId, assignmentId);
  facade.report(taskId, assignmentId, { state: "ready", summary: "done", result: { resultHash: "sqlite-result", artifactRefs: ["artifact:test"], effectRefs: [] } });
  assert.equal(facade.verifyCompletion(taskId).state, "succeeded");
  assert.equal(repo.records.get(taskId)!.terminal!.state, "succeeded");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM synthetic_effects").get()!.count, 1);
});
