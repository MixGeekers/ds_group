import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { CoreDomain, recordNativeContextDiagnostic, recordNativeStreamDiagnostic } from '../src/adapters/control-store/core-domain.js';
import { TaskDomain, type TaskCommands, type TaskDetail } from '../src/adapters/control-store/task-domain.js';
import { SQLiteGoalBindingStore } from '../src/adapters/control-store/goal-bindings.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import type { CoreCandidate, CoreCommands, CoreEvaluation, CoreGoal, CoreNativeResultReceipt, CorePrepareInput } from '../src/contracts/core.js';
import type { GoalBinding } from '../src/adapters/dsh/goals.js';
import { installCoreCapabilityFixture } from './helpers/core-capability.js';
import { createCoreReadView } from '../src/views/core.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = { hostEpoch: 'core-host', installationGeneration: 'core-install' };
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shiyu-core-domain-')), filename = join(directory, 'control.sqlite');
  const connections = new Set<DatabaseSync>(); let clock = Date.now();
  const now = () => new Date(clock);
  const open = (hostEpoch = identity.hostEpoch) => {
    const db = new DatabaseSync(filename); connections.add(db);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx);
    const tasks = new TaskDomain(db, tx, { runtimeIdentity: { ...identity, hostEpoch }, now });
    const goals = new SQLiteGoalBindingStore(db, tx);
    const reads = installCoreCapabilityFixture(db, tx, tasks, { ...identity, hostEpoch }, watermark, now);
    const core = new CoreDomain(db, tx, { runtimeIdentity: { ...identity, hostEpoch }, tasks, goals, now, ...reads });
    const call = <K extends keyof CoreCommands>(command: K, args: CoreCommands[K]['input']): CoreCommands[K]['output'] => core.execute({ command, args } as never) as CoreCommands[K]['output'];
    const task = <K extends keyof TaskCommands>(command: K, args: TaskCommands[K]['input']): TaskCommands[K]['output'] => tasks.execute({ command, args } as never) as TaskCommands[K]['output'];
    const prepare = (extra: Partial<CorePrepareInput> = {}) => call('core.prepareGoal', { requestId: 'owner-one', objective: 'Write the explicitly supplied notes',
      deliverables: [{ id: 'a', title: 'First', content: 'first note' }], budget: { tokens: 100000, calls: 20, effects: 3 },
      expiresAt: new Date(clock + 3600000).toISOString(), ...extra });
    const native = (goal: CoreGoal, phase: 'active' | 'paused' = 'active') => {
      const old = goals.load(goal.goalId), revision = (old?.goalRef?.revision ?? 0) + 1;
      const receipt = { commandId: `native:${goal.goalId}:${revision}`, operation: old ? phase === 'active' ? 'resume' as const : 'pause' as const : 'create' as const,
        status: 'pending' as const, postconditionHash: sha(`post:${revision}`), ...(old?.goalRef ? { expectedRef: old.goalRef } : {}) };
      const pending: GoalBinding = old ? { ...old, metadataVersion: old.metadataVersion + 1, receipt }
        : { goalId: goal.goalId, sessionId: `session:${goal.goalId}`, ownerId: 'local-owner', scope: 'local-owner', cwd: directory,
          completionCriteriaHash: goal.completionCriteriaHash, metadataVersion: 1, receipt };
      goals.compareAndSet(old?.metadataVersion, pending);
      const goalRef = { id: `native:${goal.goalId}`, revision };
      goals.compareAndSet(pending.metadataVersion, { ...pending, metadataVersion: pending.metadataVersion + 1, goalRef,
        receipt: { ...receipt, status: 'confirmed', observedRef: goalRef } });
      return call('core.observeNativeGoal', { goalId: goal.goalId, goalRef, sessionId: pending.sessionId, phase, observedAt: now().toISOString() });
    };
    const authorize = (extra: Partial<CorePrepareInput> = {}) => { const goal = native(prepare(extra)); return call('core.authorizeGoal', { goalId: goal.goalId, expectedVersion: goal.version }); };
    const dispatched = (evaluation: CoreEvaluation) => call('core.recordDispatch', { permit: evaluation.permit,
      binding: { goalId: evaluation.goalId, goalRef: evaluation.permit.goalRef, roundId: evaluation.evaluationId,
        sessionId: evaluation.goal.native!.sessionId, messageId: `input:${evaluation.evaluationId}`, messageHash: sha(`prompt:${evaluation.evaluationId}`) } });
    const result = (evaluation: CoreEvaluation, candidate: CoreCandidate, complete = true, candidateText = JSON.stringify(candidate)) => {
      const dispatchedEvaluation = dispatched(evaluation), binding = dispatchedEvaluation.dispatch!;
      const receipt: CoreNativeResultReceipt = { roundId: binding.roundId, sessionId: binding.sessionId, messageId: binding.messageId, messageHash: binding.messageHash,
        inputRef: { sessionId: binding.sessionId, eventSeq: 1, messageId: binding.messageId, messageHash: binding.messageHash, durability: 'confirmed' },
        assistantRef: { sessionId: binding.sessionId, eventSeq: 2, messageId: `answer:${evaluation.evaluationId}`, messageHash: sha('official assistant message'), durability: 'confirmed' },
        outputHash: sha(candidateText), observedAt: now().toISOString() };
      call('core.recordNativeResult', { permit: evaluation.permit, receipt });
      call('core.recordAccounting', { permit: evaluation.permit, receiptId: `usage:${evaluation.evaluationId}`, complete,
        tokens: 100, calls: complete ? 1 : undefined, evidenceRef: `native-usage:${evaluation.evaluationId}` });
      return { permit: evaluation.permit, proposalId: `proposal:${evaluation.evaluationId}`, candidateText };
    };
    const admit = (goal: CoreGoal, deliverableId = 'a') => {
      const evaluation = call('core.claim', { goalId: goal.goalId })!;
      return call('core.commitCandidate', result(evaluation, { kind: 'task_intent', deliverableId, reason: 'Select the next owner-approved note' }));
    };
    const finish = (taskId: string) => {
      const plan = task('task.claimAssignment', { taskId });
      task('task.bindAssignment', { permit: plan.permit, sessionId: `worker:${taskId}` }); task('task.assignmentStarted', { permit: plan.permit });
      const effect = task('task.enqueueArtifact', { permit: plan.permit, content: plan.content });
      const claim = task('task.claimEffect', { permit: plan.permit, effectId: effect.effect.effectId })!;
      task('task.recordArtifactReceipt', { permit: plan.permit, claim, observedSha256: plan.expectedSha256, observedBytes: Buffer.byteLength(plan.content),
        observedAt: now().toISOString(), receiptId: `artifact:${plan.assignmentId}` });
      task('task.settleUsage', { permit: plan.permit, usage: { status: 'reported', totalTokens: 200 }, calls: 1 });
      task('task.report', { permit: plan.permit, state: 'ready', summary: 'Artifact independently observed' }); task('task.verify', { taskId });
      core.enqueueTaskFact({ taskId, eventId: `event:task-succeeded:${taskId}` }); return task('task.get', { taskId });
    };
    const complete = (goal: CoreGoal) => {
      const receipt = admit(goal); const detail = finish(receipt.taskId!);
      const evaluation = call('core.claim', { goalId: goal.goalId })!;
      call('core.commitCandidate', result(evaluation, { kind: 'complete_candidate', reason: 'All delegated notes have independent Task completion' }));
      const current = call('core.get', { goalId: goal.goalId });
      const input = { goalId: goal.goalId, expectedVersion: current.version, goalRef: current.native!.goalRef,
        observations: [{ deliverableId: 'a', taskId: detail.task.taskId, taskVersion: detail.task.version, artifactRef: detail.artifact.artifactRef,
          observedSha256: detail.artifact.expectedSha256, observedBytes: detail.artifact.byteLength, receiptId: 'independent-filesystem-readback', observedAt: now().toISOString() }] };
      return { detail, input, proof: call('core.verifyCompletion', input) };
    };
    return { db, tx, watermark, tasks, goals, core, call, task, prepare, native, authorize, dispatched, result, admit, finish, complete, reads,
      close() { db.close(); connections.delete(db); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...open(), open, now, advance(ms: number) { clock += ms; } };
}

test('owner capability preparation is bounded, idempotent, and GET/pending never publish or grant', t => {
  const f = fixture(t), goal = f.prepare(), seq = f.watermark.read().commitSeq;
  assert.deepEqual(f.prepare(), goal); assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
  assert.equal(f.call('core.get', { goalId: goal.goalId }).authorized, false);
  assert.equal(f.call('core.balance', { goalId: goal.goalId }), undefined);
  assert.equal(f.watermark.read().commitSeq, seq);
  assert.throws(() => f.prepare({ objective: 'changed' }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => f.prepare({ requestId: 'cyclic', deliverables: [{ id: 'a', title: 'A', content: 'a', dependsOn: ['b'] }, { id: 'b', title: 'B', content: 'b', dependsOn: ['a'] }] }), code('INVALID_CORE_INPUT'));
  assert.throws(() => f.prepare({ requestId: 'too-large', deliverables: [{ id: 'a', title: 'A', content: '雨'.repeat(342) }] }), code('INVALID_CORE_INPUT'));
  assert.throws(() => f.call('core.authorizeGoal', { goalId: goal.goalId, expectedVersion: goal.version }), code('STALE_NATIVE_GOAL'));
});

test('disabled capability retains pending owner facts without reserving or spinning a Core evaluation', t => {
  const f = fixture(t), goal = f.authorize(), cap = f.reads.capability;
  cap.setEnabled({ requestId: 'disable-before-claim', expectedRevision: cap.snapshot().revision, enabled: false });
  const before = f.watermark.read(), facts = f.db.prepare('SELECT fact_id,consumed_by FROM shiyu_core_facts').all();
  for (let index = 0; index < 1000; index++) {
    assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
    assert.equal(f.call('core.snapshot', {})[0]!.planning!.reasonCode, 'capability_unavailable');
  }
  assert.equal(f.call('core.claim', { goalId: goal.goalId }), undefined);
  assert.deepEqual(f.db.prepare('SELECT fact_id,consumed_by FROM shiyu_core_facts').all(), facts);
  assert.deepEqual(f.watermark.read(), before); assert.equal(f.call('core.get', { goalId: goal.goalId }).evaluations, 0);
  assert.deepEqual(f.call('core.balance', { goalId: goal.goalId })!.held, { tokens: 0, calls: 0, effects: 0 });
  cap.setEnabled({ requestId: 'enable-before-claim', expectedRevision: cap.snapshot().revision, enabled: true });
  assert.deepEqual(f.call('core.pending', {}).goalIds, [goal.goalId]);
  assert.ok(f.call('core.claim', { goalId: goal.goalId }));
});

test('Core capture uses the real ability row through ReadView without requiring a prior success proof', async t => {
  const f = fixture(t), goal = f.authorize(), evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  const capture = evaluation.readCapture!;
  assert.equal(capture.capability.record.verification, 'unknown');
  assert.equal(capture.capability.record.usableForAuthorizedTask, true);
  const before = f.watermark.read(), views = createCoreReadView(capture, {
    now: f.now, validate: async () => f.call('core.readView', { permit: evaluation.permit }),
  });
  try {
    const view = await views.read();
    assert.deepEqual(view.data[0]!.fields.capability, capture.capability.record);
    assert.deepEqual(view.authority!.ability, { backendId: 'control-ability', ...capture.capability.ref });
    assert.equal(view.aggregateVersions[0]!.version, capture.capability.revision);
    assert.equal(view.sourceRefs[0]!.sourceId, 'capability:task.local-note.execute');
    assert.equal(view.commitSeq, capture.control.commitSeq); assert.equal(view.stateVersion, capture.publication.stateVersion);
    await views.assertCurrent(view.viewId); assert.deepEqual(f.watermark.read(), before);
    const malicious = structuredClone(capture); malicious.component.records[0]!.fields = { capability: { usableForAuthorizedTask: true } };
    const changed = createCoreReadView(malicious, { now: f.now, validate: async () => f.call('core.readView', { permit: evaluation.permit }) });
    try { await assert.rejects(changed.read()); } finally { changed.dispose(); }
  } finally { views.dispose(); }
});

test('a disabled captured binding rejects a fully accounted intent while completion facts remain valid', t => {
  const f = fixture(t), goal = f.authorize(), cap = f.reads.capability;
  const evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  const result = f.result(evaluation, { kind: 'task_intent', deliverableId: 'a', reason: 'Use the owner-authorized note' });
  cap.setEnabled({ requestId: 'disable-after-model', expectedRevision: cap.snapshot().revision, enabled: false });
  assert.throws(() => f.call('core.commitCandidate', result), code('CORE_CAPABILITY_CHANGED'));
  const rejected = f.call('core.rejectEvaluation', { permit: evaluation.permit, reasonCode: 'CORE_CAPABILITY_CHANGED' });
  assert.equal(rejected.status, 'rejected'); assert.equal(f.call('core.get', { goalId: goal.goalId }).activeEvaluationId, undefined);
  assert.equal(f.call('core.get', { goalId: goal.goalId }).taskRefs.length, 0);
  assert.deepEqual(f.call('core.balance', { goalId: goal.goalId })!.held, { tokens: 0, calls: 0, effects: 0 });
  assert.deepEqual(f.call('core.pending', {}).goalIds, []);
  assert.equal(f.db.prepare('SELECT consumed_by FROM shiyu_core_facts WHERE goal_id=?').get(goal.goalId)!.consumed_by, null);

  const completedGoal = f.authorize({ requestId: 'already-completed' });
  cap.setEnabled({ requestId: 'enable-to-execute', expectedRevision: cap.snapshot().revision, enabled: true });
  assert.ok(f.call('core.pending', {}).goalIds.includes(goal.goalId));
  const admitted = f.admit(completedGoal); f.finish(admitted.taskId!);
  cap.setEnabled({ requestId: 'disable-after-task', expectedRevision: cap.snapshot().revision, enabled: false });
  const completion = f.call('core.claim', { goalId: completedGoal.goalId })!; assert.ok(completion);
  assert.equal(completion.readCapture!.capability.record.enabled, false);
  assert.equal(f.call('core.commitCandidate', f.result(completion, { kind: 'complete_candidate', reason: 'Independently completed earlier task' })).kind, 'complete_candidate');
});

test('capability recovery cannot bypass an exhausted evaluation limit or release an unknown round', t => {
  const f = fixture(t), goal = f.authorize({ maxEvaluations: 1 }), cap = f.reads.capability;
  const evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  const result = f.result(evaluation, { kind: 'task_intent', deliverableId: 'a', reason: 'Original authorized input' });
  cap.setEnabled({ requestId: 'bounded-disable', expectedRevision: cap.snapshot().revision, enabled: false });
  assert.throws(() => f.call('core.commitCandidate', result), code('CORE_CAPABILITY_CHANGED'));
  f.call('core.rejectEvaluation', { permit: evaluation.permit, reasonCode: 'CORE_CAPABILITY_CHANGED' });
  cap.setEnabled({ requestId: 'bounded-enable', expectedRevision: cap.snapshot().revision, enabled: true });
  assert.deepEqual(f.call('core.pending', {}).goalIds, []);
  assert.equal(f.call('core.snapshot', {})[0]!.planning!.reasonCode, 'evaluation_limit');

  const unknownGoal = f.authorize({ requestId: 'unknown-stays-held' });
  const unknown = f.call('core.claim', { goalId: unknownGoal.goalId })!;
  f.dispatched(unknown); f.call('core.markUnknown', { permit: unknown.permit, reasonCode: 'synthetic-missing-native-result' });
  const before = f.call('core.balance', { goalId: unknownGoal.goalId });
  cap.setEnabled({ requestId: 'unknown-disable', expectedRevision: cap.snapshot().revision, enabled: false });
  cap.setEnabled({ requestId: 'unknown-enable', expectedRevision: cap.snapshot().revision, enabled: true });
  assert.deepEqual(f.call('core.pending', {}).goalIds, []);
  assert.deepEqual(f.call('core.balance', { goalId: unknownGoal.goalId }), before);
  assert.equal(f.call('core.evaluations', { goalId: unknownGoal.goalId })[0]!.status, 'unknown');
  assert.throws(() => f.call('core.rejectEvaluation', { permit: unknown.permit, reasonCode: 'CORE_CAPABILITY_CHANGED' }), code('CORE_RECONCILIATION_REQUIRED'));
});

test('a proven pre-native view rejection settles zero and restores only its original facts without refunding the evaluation count', t => {
  const f = fixture(t), goal = f.authorize(), evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  const rejected = f.call('core.rejectEvaluation', { permit: evaluation.permit, reasonCode: 'CORE_VIEW_UNAVAILABLE' });
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.reservation.state, 'settled');
  const balance = f.call('core.balance', { goalId: goal.goalId })!;
  assert.deepEqual(balance.spent, { tokens: 0, calls: 0, effects: 0 }); assert.deepEqual(balance.held, balance.spent);
  assert.equal(f.call('core.get', { goalId: goal.goalId }).evaluations, 1);
  assert.equal(f.db.prepare('SELECT consumed_by FROM shiyu_core_facts WHERE goal_id=?').get(goal.goalId)!.consumed_by, null);
  const before = f.watermark.read();
  assert.deepEqual(f.call('core.rejectEvaluation', { permit: evaluation.permit, reasonCode: 'CORE_VIEW_UNAVAILABLE' }), rejected);
  assert.deepEqual(f.watermark.read(), before);
  const next = f.call('core.claim', { goalId: goal.goalId })!;
  assert.notEqual(next.evaluationId, evaluation.evaluationId); assert.equal(next.goal.evaluations, 2);
});

for (const scenario of ['dispatched', 'unknown', 'old-host'] as const) test(`${scenario} evaluation cannot use a view failure to release an uncertain hold`, t => {
  const f = fixture(t), goal = f.authorize(), evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  if (scenario === 'dispatched') f.dispatched(evaluation);
  if (scenario === 'unknown') f.call('core.markUnknown', { permit: evaluation.permit, reasonCode: 'synthetic-uncertain' });
  const store = scenario === 'old-host' ? f.open('replacement-core-host') : f;
  const before = store.call('core.balance', { goalId: goal.goalId });
  assert.throws(() => store.call('core.rejectEvaluation', { permit: evaluation.permit, reasonCode: 'CORE_VIEW_UNAVAILABLE' }), code('CORE_RECONCILIATION_REQUIRED'));
  assert.deepEqual(store.call('core.balance', { goalId: goal.goalId }), before);
  assert.notEqual(store.call('core.evaluations', { goalId: goal.goalId })[0]!.status, 'rejected');
});

test('new informational success evidence leaves a captured intent binding usable', t => {
  const f = fixture(t), separate = f.task('task.createLocal', { requestId: 'separate', title: 'Independent note', content: 'separate synthetic note' });
  f.finish(separate.task.taskId);
  const goal = f.authorize(), evaluation = f.call('core.claim', { goalId: goal.goalId })!, ref = evaluation.readCapture!.capability.ref;
  const proof = f.reads.capability.recordSuccessfulTask(separate.task.taskId);
  assert.equal(proof.snapshot.verification, 'verified');
  assert.deepEqual(f.reads.capability.captureForCore().ref, ref);
  assert.ok(f.call('core.readView', { permit: evaluation.permit }));
  const admitted = f.call('core.commitCandidate', f.result(evaluation, { kind: 'task_intent', deliverableId: 'a', reason: 'Proof is informational' }));
  assert.equal(admitted.status, 'committed');
});

test('native durable result and complete usage precede admission; one shared grant creates one non-human Task', t => {
  const f = fixture(t), goal = f.authorize(), evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  const candidate = { kind: 'task_intent' as const, deliverableId: 'a', reason: 'First permitted note' };
  assert.equal(f.call('core.claim', { goalId: goal.goalId }), undefined);
  assert.throws(() => f.call('core.commitCandidate', { permit: evaluation.permit, proposalId: 'not-proved', candidateText: JSON.stringify(candidate) }), code('CORE_NATIVE_REQUIRED'));
  const input = f.result(evaluation, candidate, true, JSON.stringify(candidate, null, 2));
  const before = f.watermark.read().commitSeq, receipt = f.call('core.commitCandidate', input);
  assert.equal(f.watermark.read().commitSeq, before + 1);
  assert.deepEqual(f.call('core.commitCandidate', input), receipt);
  assert.equal(f.watermark.read().commitSeq, before + 1);
  const task = f.task('task.get', { taskId: receipt.taskId! });
  assert.equal(task.task.goalId, goal.goalId); assert.equal(task.task.mandateId, goal.mandateId);
  assert.equal(task.reservation!.principalId, `goal-worker:${goal.goalId}`);
  assert.deepEqual(task.reservation!.resourceScopes, [`deliverable:${goal.goalId}:a`]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shiyu_mandates').get()!.n, 1);
  const ticket = f.tasks.repositories.tickets.get(task.task.taskId)!;
  const trigger = f.tasks.repositories.triggers.get(ticket.origin.triggerIds[0]!)!;
  assert.equal(trigger.human, false); assert.equal(trigger.source, 'shiyu-core'); assert.equal(trigger.actor.id, `core:${goal.goalId}`);
  assert.equal(trigger.meta.ownerBasisRef, `owner-core-request:${goal.requestId}`);
  const balance = f.call('core.balance', { goalId: goal.goalId })!;
  assert.deepEqual(balance.spent, { tokens: 100, calls: 1, effects: 0 }); assert.deepEqual(balance.held, { tokens: 16384, calls: 2, effects: 1 });
});

test('proposal receipt, Task/Assignment, shared hold, start intent and scope ownership roll back together', t => {
  const f = fixture(t), goal = f.authorize(), evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  const input = f.result(evaluation, { kind: 'task_intent', deliverableId: 'a', reason: 'Select A' });
  const before = f.watermark.read().commitSeq, balance = f.call('core.balance', { goalId: goal.goalId });
  assert.throws(() => f.tx.atomic(() => { f.call('core.commitCandidate', input); throw new Error('injected outer failure'); }), /injected outer failure/);
  assert.equal(f.task('task.list', {}).length, 0); assert.deepEqual(f.call('core.get', { goalId: goal.goalId }).taskRefs, []);
  assert.deepEqual(f.call('core.balance', { goalId: goal.goalId }), balance); assert.equal(f.watermark.read().commitSeq, before);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM shiyu_task_aux_intents WHERE kind='start'").get()!.n, 0);
  assert.ok(f.call('core.commitCandidate', input).taskId);
});

test('derived task cannot mint a fresh allowance when the Goal balance is insufficient', t => {
  const f = fixture(t), goal = f.authorize({ budget: { tokens: 16384, calls: 2, effects: 1 } }), evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  const input = f.result(evaluation, { kind: 'task_intent', deliverableId: 'a', reason: 'Select A' });
  assert.throws(() => f.call('core.commitCandidate', input), code('BUDGET_EXCEEDED'));
  assert.equal(f.task('task.list', {}).length, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM shiyu_mandates').get()!.n, 1);
  assert.equal(f.call('core.balance', { goalId: goal.goalId })!.spent.calls, 1);
});

test('ungranted and dependency-blocked deliverables cannot pass typed proposal admission', t => {
  for (const selected of ['ungranted', 'b']) {
    const f = fixture(t), goal = f.authorize({ deliverables: [{ id: 'a', title: 'A', content: 'a' }, { id: 'b', title: 'B', content: 'b', dependsOn: ['a'] }] });
    const evaluation = f.call('core.claim', { goalId: goal.goalId })!;
    const input = f.result(evaluation, { kind: 'task_intent', deliverableId: selected, reason: 'Model selects a forbidden next step' });
    assert.throws(() => f.call('core.commitCandidate', input), code(selected === 'b' ? 'CORE_DEPENDENCY_PENDING' : 'CORE_SCOPE_DENIED'));
    assert.equal(f.task('task.list', {}).length, 0);
  }
});

test('unknown native accounting retains hold and blocks both derived work and automatic replay across reopen', t => {
  const f = fixture(t), goal = f.authorize(), evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  const input = f.result(evaluation, { kind: 'task_intent', deliverableId: 'a', reason: 'Known result but unknown whole invocation usage' }, false);
  assert.throws(() => f.call('core.commitCandidate', input), code('CORE_USAGE_UNCERTAIN'));
  f.call('core.markUnknown', { permit: evaluation.permit, reasonCode: 'partial_native_usage' });
  assert.deepEqual(f.call('core.balance', { goalId: goal.goalId })!.held, { tokens: 16384, calls: 2, effects: 0 });
  f.close(); const reopened = f.open('next-host');
  assert.deepEqual(reopened.call('core.pending', {}), { goalIds: [] });
  assert.equal(reopened.call('core.evaluations', { goalId: goal.goalId })[0]!.status, 'unknown');
  assert.equal(reopened.task('task.list', {}).length, 0);
});

test('unrelated control commits preserve the read set; a same-Goal Task version change rejects the proposal', t => {
  const f = fixture(t), goal = f.authorize(), first = f.admit(goal); f.finish(first.taskId!);
  const evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  f.task('task.createLocal', { requestId: 'unrelated', title: 'Other owner task', content: 'unrelated' });
  assert.doesNotThrow(() => f.call('core.assertDispatch', { permit: evaluation.permit }));
  const record = f.tasks.repositories.records.get(first.taskId!)!;
  f.tx.atomic(() => f.tasks.repositories.records.save({ ...record, version: record.version + 1 }));
  assert.throws(() => f.call('core.assertDispatch', { permit: evaluation.permit }), code('CORE_SOURCE_CONFLICT'));
});

test('pause invalidates a claimed round and explicit resume cannot resurrect its unknown invocation', t => {
  const f = fixture(t), goal = f.authorize(), evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  const paused = f.call('core.pause', { goalId: goal.goalId, expectedVersion: f.call('core.get', { goalId: goal.goalId }).version });
  assert.throws(() => f.call('core.assertDispatch', { permit: evaluation.permit }), code('CORE_PAUSED'));
  assert.throws(() => f.call('core.resume', { goalId: goal.goalId, expectedVersion: paused.version }), code('CORE_RECONCILIATION_REQUIRED'));
  assert.equal(f.call('core.evaluations', { goalId: goal.goalId })[0]!.status, 'unknown');
});

test('owner pause/resume exchanges only never-claimed Task holds under the same total mandate', t => {
  const f = fixture(t), goal = f.authorize(), receipt = f.admit(goal), taskId = receipt.taskId!;
  const old = f.task('task.get', { taskId }).reservation!;
  const paused = f.call('core.pause', { goalId: goal.goalId, expectedVersion: f.call('core.get', { goalId: goal.goalId }).version });
  f.native(paused, 'paused'); const active = f.native(f.call('core.get', { goalId: goal.goalId }));
  f.call('core.resume', { goalId: goal.goalId, expectedVersion: active.version });
  const next = f.task('task.get', { taskId }).reservation!;
  assert.notEqual(next.reservationId, old.reservationId); assert.equal(next.mandateId, old.mandateId);
  assert.equal(f.tasks.mandates.getReservation({ principalId: 'local-owner', kind: 'owner', scopes: ['local-owner'] }, old.reservationId).state, 'settled');
  assert.equal(f.call('core.balance', { goalId: goal.goalId })!.held.effects, 1);
  assert.doesNotThrow(() => f.task('task.claimAssignment', { taskId }));
});

test('pausing already-claimed delegated work records unknown and never reissues its budget on resume', t => {
  const f = fixture(t), goal = f.authorize(), receipt = f.admit(goal), taskId = receipt.taskId!;
  f.task('task.claimAssignment', { taskId });
  const paused = f.call('core.pause', { goalId: goal.goalId, expectedVersion: f.call('core.get', { goalId: goal.goalId }).version });
  assert.equal(f.task('task.get', { taskId }).task.state, 'unknown');
  assert.throws(() => f.call('core.resume', { goalId: goal.goalId, expectedVersion: paused.version }), code('CORE_RECONCILIATION_REQUIRED'));
  assert.equal(f.call('core.balance', { goalId: goal.goalId })!.held.effects, 1);
});

test('bounded dispatched inference remains current at 90 seconds while stale fresh entry is denied', t => {
  const f = fixture(t), goal = f.authorize(), evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  f.dispatched(evaluation); f.advance(90000);
  assert.doesNotThrow(() => f.call('core.assertDispatch', { permit: evaluation.permit }));
  const input = f.result(evaluation, { kind: 'no_action', reason: 'No further work' });
  assert.doesNotThrow(() => f.call('core.assertCurrent', { permit: evaluation.permit }));
  assert.equal(f.call('core.commitCandidate', input).status, 'committed');
  const other = f.authorize({ requestId: 'second-goal' }); f.advance(61000);
  assert.throws(() => f.call('core.claim', { goalId: other.goalId }), code('NATIVE_GOAL_NOT_ACTIVE'));
});

test('defer has a persistent cooldown and a finite evaluation cap, with no read-triggered writes', t => {
  const f = fixture(t), goal = f.authorize({ maxEvaluations: 2 });
  for (let i = 0; i < 2; i++) {
    const evaluation = f.call('core.claim', { goalId: goal.goalId })!;
    f.call('core.commitCandidate', f.result(evaluation, { kind: 'defer', reason: 'Wait for bounded scheduled review', retryAfterMs: 1000 }));
    const before = f.watermark.read().commitSeq;
    assert.deepEqual(f.call('core.pending', {}), { goalIds: [] }); assert.equal(f.watermark.read().commitSeq, before);
    f.advance(1000);
  }
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
});

test('trusted Task completion triggers the next evaluation once and complete requires full independent evidence', t => {
  const f = fixture(t), goal = f.authorize(), completed = f.complete(goal);
  assert.equal(completed.proof.completionCriteriaHash, goal.completionCriteriaHash);
  assert.ok(completed.proof.evidenceRefs.includes(completed.detail.artifact.artifactRef));
  assert.equal(f.core.enqueueTaskFact({ taskId: completed.detail.task.taskId, eventId: `event:task-succeeded:${completed.detail.task.taskId}` }).queued, false);
  assert.throws(() => f.call('core.verifyCompletion', { ...completed.input, observations: [{ ...completed.input.observations[0]!, observedSha256: sha('wrong') }] }), code('CORE_COMPLETION_UNPROVEN'));
});

test('foreign Goal ownership and altered successful Effect receipts cannot prove completion', t => {
  for (const mutation of ['foreign-goal', 'receipt-outcome', 'receipt-claim', 'receipt-service']) {
    const f = fixture(t), goal = f.authorize(), { detail, input } = f.complete(goal);
    f.tx.atomic(() => {
      if (mutation === 'foreign-goal') {
        const record = f.tasks.repositories.records.get(detail.task.taskId)!; f.tasks.repositories.records.save({ ...record, goalId: 'foreign' });
      } else {
        const receipt = structuredClone(detail.effectReceipts[0]!);
        if (mutation === 'receipt-outcome') receipt.outcome = 'failed';
        if (mutation === 'receipt-claim') receipt.claim.fencingToken++;
        if (mutation === 'receipt-service') receipt.serviceId = 'untrusted-service';
        f.db.prepare('UPDATE shiyu_effect_receipts SET record_json=? WHERE receipt_id=?').run(JSON.stringify(receipt), receipt.receiptId);
      }
    });
    assert.throws(() => f.call('core.verifyCompletion', input), code('CORE_COMPLETION_UNPROVEN'));
  }
});

test('same-DB global Task pause blocks both new planning and final proposal admission', t => {
  const f = fixture(t), goal = f.authorize(), evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  const input = f.result(evaluation, { kind: 'task_intent', deliverableId: 'a', reason: 'Authorized until global pause' });
  f.task('task.setPaused', { paused: true });
  assert.throws(() => f.call('core.commitCandidate', input), code('CORE_PAUSED'));
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] }); assert.equal(f.task('task.list', {}).length, 0);
  f.task('task.setPaused', { paused: false });
  assert.throws(() => f.call('core.commitCandidate', input), code('STALE_CORE_PERMIT'));
});

test('exhausted planning allowance is a pure-read pending exclusion with an explicit diagnostic', t => {
  const f = fixture(t), goal = f.authorize({ budget: { tokens: 16384, calls: 2, effects: 1 } });
  const evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  f.call('core.commitCandidate', f.result(evaluation, { kind: 'defer', reason: 'Defer without enough room for another bound', retryAfterMs: 1000 }));
  f.advance(1000); const before = f.watermark.read().commitSeq;
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
  assert.deepEqual(f.call('core.snapshot', {})[0]!.planning, { eligible: false, reasonCode: 'budget_exhausted' });
  assert.equal(f.watermark.read().commitSeq, before);
});

test('a known forbidden proposal can be rejected without replay, while unknown accounting cannot', t => {
  const f = fixture(t), goal = f.authorize(), evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  const input = f.result(evaluation, { kind: 'task_intent', deliverableId: 'ungranted', reason: 'Unpermitted model selection' });
  assert.throws(() => f.call('core.commitCandidate', input), code('CORE_SCOPE_DENIED'));
  const rejected = f.call('core.rejectEvaluation', { permit: evaluation.permit, reasonCode: 'CORE_SCOPE_DENIED' });
  assert.equal(rejected.status, 'rejected'); assert.equal(f.call('core.get', { goalId: goal.goalId }).activeEvaluationId, undefined);
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
  assert.equal(f.call('core.balance', { goalId: goal.goalId })!.spent.calls, 1);
  const second = f.authorize({ requestId: 'unknown-reject' }), uncertain = f.call('core.claim', { goalId: second.goalId })!;
  f.result(uncertain, { kind: 'no_action', reason: 'No action' }, false);
  assert.throws(() => f.call('core.rejectEvaluation', { permit: uncertain.permit, reasonCode: 'CORE_PAUSED' }), code('CORE_RECONCILIATION_REQUIRED'));
});

test('Goal resume requires a new confirmed native resume after the local pause', t => {
  const f = fixture(t), goal = f.authorize();
  const paused = f.call('core.pause', { goalId: goal.goalId, expectedVersion: goal.version });
  assert.throws(() => f.call('core.resume', { goalId: goal.goalId, expectedVersion: paused.version }), code('STALE_NATIVE_GOAL'));
  const observed = f.native(paused);
  assert.equal(f.call('core.resume', { goalId: goal.goalId, expectedVersion: observed.version }).paused, false);
});

test('only exact pending native completion proof allows the second independent verification; unknown never does', t => {
  const f = fixture(t), goal = f.authorize(), { input, proof } = f.complete(goal);
  const binding = f.goals.load(goal.goalId)!;
  const pending: GoalBinding = { ...binding, metadataVersion: binding.metadataVersion + 1, receipt: {
    commandId: 'complete-pending', operation: 'complete', status: 'pending', expectedRef: binding.goalRef,
    postconditionHash: sha('complete-postcondition'), evidenceRefs: proof.evidenceRefs, completionProof: proof,
  } };
  f.goals.compareAndSet(binding.metadataVersion, pending);
  assert.deepEqual(f.call('core.verifyCompletion', input), proof);
  f.goals.compareAndSet(pending.metadataVersion, { ...pending, metadataVersion: pending.metadataVersion + 1,
    receipt: { ...pending.receipt!, status: 'unknown' } });
  assert.throws(() => f.call('core.verifyCompletion', input), code('STALE_NATIVE_GOAL'));
});

test('pure pending cursor reaches Goals beyond the first 100 and advances past a paused cursor', t => {
  const f = fixture(t), goals: CoreGoal[] = [];
  for (let index = 0; index < 102; index++) goals.push(f.authorize({ requestId: `cursor-goal-${index}` }));
  f.call('core.pause', { goalId: goals[50]!.goalId, expectedVersion: goals[50]!.version });
  const before = f.watermark.read().commitSeq;
  assert.equal(f.call('core.pending', { limit: 100 }).goalIds.length, 100);
  assert.deepEqual(f.call('core.pending', { limit: 3, afterGoalId: goals[99]!.goalId }).goalIds,
    [goals[100]!.goalId, goals[101]!.goalId, goals[0]!.goalId]);
  assert.deepEqual(f.call('core.pending', { limit: 1, afterGoalId: goals[50]!.goalId }).goalIds, [goals[51]!.goalId]);
  assert.deepEqual(f.call('core.pending', { limit: 1, afterGoalId: `core-${'f'.repeat(40)}` }).goalIds, [goals[0]!.goalId]);
  assert.throws(() => f.call('core.pending', { afterGoalId: 'not-a-core-goal' }), code('INVALID_CORE_INPUT'));
  assert.throws(() => f.call('core.pending', { afterGoalId: `core-${'f'.repeat(40)}`, injected: true } as never), code('INVALID_CORE_INPUT'));
  assert.equal(f.watermark.read().commitSeq, before);
});

test('a later unknown mark cannot overwrite the first unknown reason or reconcile the reservation twice', t => {
  const f = fixture(t), goal = f.authorize(), evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  f.dispatched(evaluation);
  const first = f.call('core.markUnknown', { permit: evaluation.permit, reasonCode: 'CORE_DECISION_PRESTEP_ABORTED' });
  assert.equal(first.status, 'unknown'); assert.equal(first.reasonCode, 'CORE_DECISION_PRESTEP_ABORTED');
  const balanceBefore = f.call('core.balance', { goalId: goal.goalId });
  const second = f.call('core.markUnknown', { permit: evaluation.permit, reasonCode: 'owner_paused' });
  assert.equal(second.status, 'unknown');
  assert.equal(second.reasonCode, 'CORE_DECISION_PRESTEP_ABORTED', 'the first unknown reason is preserved');
  assert.equal(f.call('core.evaluations', { goalId: goal.goalId })[0]!.reasonCode, 'CORE_DECISION_PRESTEP_ABORTED');
  assert.deepEqual(f.call('core.balance', { goalId: goal.goalId }), balanceBefore, 'the reservation is not reconciled twice');
});

test('a controlled runtime-context diagnostic reaches the unknown evaluation without changing the first reason', t => {
  const f = fixture(t), goal = f.authorize(), evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  f.dispatched(evaluation);
  recordNativeContextDiagnostic(goal.goalId, { mismatchKind: 'section-render',
    expected: { shaPrefix: '0123456789abcdef' }, actual: { shaPrefix: 'fedcba9876543210' },
    fieldNames: ['source.sections[0].text', 'content[0].text'] });
  const unknown = f.call('core.markUnknown', { permit: evaluation.permit, reasonCode: 'CORE_NATIVE_CONTEXT_REJECTED' });
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.reasonCode, 'CORE_NATIVE_CONTEXT_REJECTED');
  const stored = f.call('core.evaluations', { goalId: goal.goalId })[0] as unknown as { contextDiagnostic?: any };
  assert.deepEqual(stored.contextDiagnostic, { mismatchKind: 'section-render',
    expected: { shaPrefix: '0123456789abcdef' }, actual: { shaPrefix: 'fedcba9876543210' },
    fieldNames: ['source.sections[0].text', 'content[0].text'] });
  const again = f.call('core.markUnknown', { permit: evaluation.permit, reasonCode: 'owner_paused' });
  assert.equal(again.reasonCode, 'CORE_NATIVE_CONTEXT_REJECTED');
  assert.deepEqual((f.call('core.evaluations', { goalId: goal.goalId })[0] as unknown as { contextDiagnostic?: any }).contextDiagnostic, stored.contextDiagnostic);
});

test('a controlled provider stream failure and Goal Session summary reach the unknown evaluation without changing the first reason', t => {
  const f = fixture(t), goal = f.authorize(), evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  f.dispatched(evaluation);
  recordNativeStreamDiagnostic(goal.goalId, { category: 'empty-provider-stream', code: 'NONE', name: 'Error', chunks: 0,
    abortedBeforeFirstChunk: false, abortedAfterFirstChunk: false, timedOut: false, message: '' }, {
    provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high', maxTokens: 512, toolCount: 3,
    eventCounts: { 'user/message': 2, 'assistant/attempt': 1, 'turn/end': 1 }, attemptStreamLengths: [0], turnEndReasons: ['blocked'] });
  const unknown = f.call('core.markUnknown', { permit: evaluation.permit, reasonCode: 'CORE_EXECUTION_UNCONFIRMED' });
  assert.equal(unknown.reasonCode, 'CORE_EXECUTION_UNCONFIRMED');
  const stored = f.call('core.evaluations', { goalId: goal.goalId })[0] as unknown as { streamDiagnostic?: any; goalSessionSummary?: any };
  assert.equal(stored.streamDiagnostic?.category, 'empty-provider-stream');
  assert.deepEqual(stored.goalSessionSummary?.attemptStreamLengths, [0]);
  assert.deepEqual(stored.goalSessionSummary?.turnEndReasons, ['blocked']);
  const again = f.call('core.markUnknown', { permit: evaluation.permit, reasonCode: 'owner_paused' });
  assert.equal(again.reasonCode, 'CORE_EXECUTION_UNCONFIRMED');
  assert.deepEqual((f.call('core.evaluations', { goalId: goal.goalId })[0] as unknown as { streamDiagnostic?: any }).streamDiagnostic, stored.streamDiagnostic);
});
