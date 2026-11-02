import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { CoreDomain, CORE_PLAN_LIMITS } from '../src/adapters/control-store/core-domain.js';
import { TaskDomain, type TaskCommands, type TaskDetail } from '../src/adapters/control-store/task-domain.js';
import { SQLiteGoalBindingStore } from '../src/adapters/control-store/goal-bindings.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import type { CoreCandidate, CoreCommands, CoreEvaluation, CoreGoal, CorePlanDraft, CorePrepareInput } from '../src/contracts/core.js';
import type { GoalBinding } from '../src/adapters/dsh/goals.js';
import { installCoreCapabilityFixture } from './helpers/core-capability.js';

// Real temporary SQLite Core/Task/Goal/authority domains. Only the native Goal
// lifecycle and the model response are test data; every plan admission runs the
// production validation, Task/Mandate and independent artifact evidence paths.
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = { hostEpoch: 'core-plan-host', installationGeneration: 'core-plan-install' };
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === expected;
const PLAN_ARTIFACT = { kind: 'local-note', verifier: 'artifact.sha256.v1' } as const;
const DELIVERABLES = [
  { id: 'a', title: 'Collect the A facts', content: 'synthetic note A' },
  { id: 'b', title: 'Write the B summary', content: 'synthetic note B', dependsOn: ['a'] },
  { id: 'c', title: 'Write the independent C note', content: 'synthetic note C' },
];
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shiyu-core-plan-')), filename = join(directory, 'control.sqlite');
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
    const prepareInput = (extra: Partial<CorePrepareInput> = {}): CorePrepareInput => ({
      requestId: `owner-plan-${Math.random().toString(36).slice(2)}`, objective: 'Complete the owner supplied synthetic notes',
      deliverables: structuredClone(DELIVERABLES), budget: { tokens: 100000000, calls: 500, effects: 50 },
      expiresAt: new Date(clock + 6 * 3600000).toISOString(), maxEvaluations: 40, ...extra });
    const prepare = (extra: Partial<CorePrepareInput> = {}) => call('core.prepareGoal', prepareInput(extra));
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
    const dispatched = (evaluation: CoreEvaluation, candidateText: string) => call('core.recordDispatch', { permit: evaluation.permit,
      binding: { goalId: evaluation.goalId, goalRef: evaluation.permit.goalRef, roundId: evaluation.evaluationId,
        sessionId: evaluation.goal.native!.sessionId, messageId: `input:${evaluation.evaluationId}`, messageHash: sha(candidateText) } });
    const result = (evaluation: CoreEvaluation, candidateText: string, complete = true) => {
      const binding = dispatched(evaluation, candidateText).dispatch!;
      call('core.recordNativeResult', { permit: evaluation.permit, receipt: { roundId: binding.roundId, sessionId: binding.sessionId,
        messageId: binding.messageId, messageHash: binding.messageHash,
        inputRef: { sessionId: binding.sessionId, eventSeq: 1, messageId: binding.messageId, messageHash: binding.messageHash, durability: 'confirmed' },
        assistantRef: { sessionId: binding.sessionId, eventSeq: 2, messageId: `answer:${evaluation.evaluationId}`, messageHash: sha(candidateText), durability: 'confirmed' },
        outputHash: sha(candidateText), observedAt: now().toISOString() } });
      call('core.recordAccounting', { permit: evaluation.permit, receiptId: `usage:${evaluation.evaluationId}`, complete,
        tokens: 100, calls: complete ? 1 : undefined, evidenceRef: `native-usage:${evaluation.evaluationId}` });
    };
    const attempt = (evaluation: CoreEvaluation, candidateText: string, proposalId = `proposal:${evaluation.evaluationId}`) => {
      result(evaluation, candidateText);
      try { return { ok: true as const, receipt: call('core.commitCandidate', { permit: evaluation.permit, proposalId, candidateText }) }; }
      catch (error) { return { ok: false as const, error }; }
    };
    const evaluate = (goal: CoreGoal, candidate: CoreCandidate | string) => {
      const candidateText = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
      const evaluation = call('core.claim', { goalId: goal.goalId })!;
      assert.ok(evaluation, 'a bounded evaluation should be claimable');
      const outcome = attempt(evaluation, candidateText);
      assert.equal(outcome.ok, true, `expected a committed candidate: ${!outcome.ok && String(outcome.error)}`);
      return { evaluation, receipt: (outcome as { receipt: ReturnType<typeof call<'core.commitCandidate'>> }).receipt };
    };
    const reject = (goal: CoreGoal, candidateText: string, expected: string) => {
      const evaluation = call('core.claim', { goalId: goal.goalId })!;
      assert.ok(evaluation, `a bounded evaluation should be claimable before ${expected}`);
      const outcome = attempt(evaluation, candidateText);
      assert.equal(outcome.ok, false, `candidate must be rejected with ${expected}`);
      assert.ok(code(expected)((outcome as { error: unknown }).error), `expected ${expected}, got ${String((outcome as { error: unknown }).error)}`);
      const rejected = call('core.rejectEvaluation', { permit: evaluation.permit, reasonCode: expected });
      assert.equal(rejected.status, 'rejected');
      return rejected;
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
    const cancelTask = (taskId: string) => {
      const plan = task('task.claimAssignment', { taskId });
      task('task.bindAssignment', { permit: plan.permit, sessionId: `worker:${taskId}` }); task('task.assignmentStarted', { permit: plan.permit });
      task('task.cancel', { taskId, reason: 'synthetic owner cancellation' });
      return task('task.confirmCancelled', { taskId, proof: { assignmentId: plan.assignmentId, oldExecutionStopped: true, effectsKnown: true,
        pendingIntentsInvalidated: true, evidenceRefs: ['synthetic-stop-evidence'] } });
    };
    const tamperArtifact = (taskId: string) => {
      const plan = task('task.claimAssignment', { taskId });
      task('task.bindAssignment', { permit: plan.permit, sessionId: `worker:${taskId}` }); task('task.assignmentStarted', { permit: plan.permit });
      const effect = task('task.enqueueArtifact', { permit: plan.permit, content: plan.content });
      const claim = task('task.claimEffect', { permit: plan.permit, effectId: effect.effect.effectId })!;
      task('task.recordArtifactReceipt', { permit: plan.permit, claim, observedSha256: sha('tampered worker artifact'), observedBytes: 12,
        observedAt: now().toISOString(), receiptId: `artifact:${plan.assignmentId}` });
      task('task.settleUsage', { permit: plan.permit, usage: { status: 'reported', totalTokens: 200 }, calls: 1 });
      task('task.report', { permit: plan.permit, state: 'failed', summary: 'Worker produced an artifact with another hash' });
      return task('task.get', { taskId });
    };
    const pauseResume = (goalId: string) => {
      const paused = call('core.pause', { goalId, expectedVersion: call('core.get', { goalId }).version });
      native(paused, 'paused');
      const active = native(call('core.get', { goalId }));
      return call('core.resume', { goalId, expectedVersion: active.version });
    };
    const planCandidate = (goal: CoreGoal, options: Partial<CorePlanDraft> & { steps?: CorePlanDraft['steps'] } = {}) => {
      const remaining = goal.deliverables.filter(item => !goal.taskRefs.some(ref => ref.deliverableId === item.id));
      const byDeliverable = new Map(remaining.map(item => [item.id, `step-${item.id}`]));
      const steps = options.steps ?? remaining.map(item => ({ stepId: `step-${item.id}`, deliverableId: item.id,
        dependsOn: (item.dependsOn ?? []).map(dependency => byDeliverable.get(dependency)!).filter(Boolean),
        requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } }));
      return JSON.stringify({ kind: 'plan_candidate', plan: { basePlanVersion: goal.planVersion, steps,
        stopConditions: { onStepFailure: 'stop', maxFailedSteps: 0, onFactConflict: 'wait', maxParallelSteps: 2 },
        reasoningRefs: [`goal:${goal.goalId}`, `owner-core-request:${goal.requestId}`], summary: 'Trusted synthetic plan', ...options,
        ...(options.steps ? { steps } : {}) } });
    };
    return { db, tx, watermark, tasks, goals, core, call, task, prepare, prepareInput, native, authorize, evaluate, attempt, dispatched, reject, finish, cancelTask, tamperArtifact,
      pauseResume, planCandidate, reads, directory, now,
      close() { db.close(); connections.delete(db); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...open(), open, now, advance(ms: number) { clock += ms; } };
}

test('a validated plan admits dependency-ready steps, revisions continue after Task results, and completion needs independent evidence', t => {
  const f = fixture(t), goal = f.authorize();
  const first = f.evaluate(goal, f.planCandidate(goal));
  assert.equal(first.receipt.status, 'committed'); assert.equal(first.receipt.kind, 'plan_candidate');
  assert.equal(first.receipt.planVersion, 1); assert.deepEqual(first.receipt.stepRefs!.map(ref => ref.stepId), ['step-a', 'step-c']);
  assert.equal(first.receipt.taskId, undefined);
  const plan = f.call('core.plan', { goalId: goal.goalId });
  assert.equal(plan.planVersion, 1); assert.equal(plan.history.length, 1);
  assert.equal(plan.current!.goalId, goal.goalId); assert.equal(plan.current!.evaluationId, first.evaluation.evaluationId);
  assert.deepEqual(plan.current!.triggerRefs, [first.evaluation.triggerRefs[0]]);
  assert.deepEqual(plan.current!.steps.map(step => step.stepId), ['step-a', 'step-b', 'step-c']);
  assert.equal(plan.current!.steps[0]!.expectedSha256, sha('synthetic note A'));
  assert.equal(plan.current!.steps[0]!.byteLength, Buffer.byteLength('synthetic note A'));
  assert.deepEqual(plan.snapshot!.steps.map(step => step.state), ['active', 'blocked_dependency', 'active']);
  assert.equal(plan.current!.steps[1]!.dependsOn[0], 'step-a');
  const current = f.call('core.get', { goalId: goal.goalId });
  assert.equal(current.planVersion, 1); assert.deepEqual(current.taskRefs.map(ref => ref.deliverableId), ['a', 'c']);
  const taskA = current.taskRefs.find(ref => ref.deliverableId === 'a')!.taskId, taskC = current.taskRefs.find(ref => ref.deliverableId === 'c')!.taskId;
  const detailA = f.task('task.get', { taskId: taskA });
  assert.equal(detailA.task.goalId, goal.goalId);
  // The worker receives only its owner-scoped note resource and the captured
  // local-note capability binding, never the Goal's global tool surface.
  assert.deepEqual(detailA.reservation!.resourceScopes, [`deliverable:${goal.goalId}:a`]);
  assert.equal(detailA.capabilityRef!.installationGeneration, identity.installationGeneration);
  assert.equal(detailA.task.mandateId, f.call('core.get', { goalId: goal.goalId }).mandateId);
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
  assert.equal(f.call('core.snapshot', {})[0]!.planning!.reasonCode, 'awaiting_fact');
  f.finish(taskC); f.finish(taskA);
  // Replaying the same trusted completion event adds no fact and no round.
  assert.equal(f.core.enqueueTaskFact({ taskId: taskA, eventId: `event:task-succeeded:${taskA}` }).queued, false);
  assert.deepEqual(f.call('core.pending', {}).goalIds, [goal.goalId]);
  const trigger = f.call('core.claim', { goalId: goal.goalId })!;
  assert.equal(trigger.plan!.current!.planVersion, 1);
  assert.deepEqual(trigger.plan!.steps.map(step => step.state), ['done', 'ready', 'done']);
  assert.ok(trigger.plan!.availableFacts.some(ref => ref.kind === 'task' && ref.ref === taskA));
  // The revision covers exactly the unowned deliverable and continues after the
  // trusted Task results; its admitted Task is owner/mandate scoped like any other.
  const revised = JSON.stringify({ kind: 'plan_candidate', plan: { basePlanVersion: 1,
    steps: [{ stepId: 'step-b2', deliverableId: 'b', dependsOn: [], requiredFacts: [{ kind: 'task', ref: taskA }],
      expectedArtifact: { ...PLAN_ARTIFACT } }],
    stopConditions: { onStepFailure: 'stop', maxFailedSteps: 0, onFactConflict: 'wait', maxParallelSteps: 2 },
    reasoningRefs: [`goal:${goal.goalId}`, taskA], summary: 'Continue with the dependent note' } });
  // The pending evaluation above is the claimed round; commit it through the same trusted boundary.
  const committedOutcome = f.attempt(trigger, revised);
  assert.equal(committedOutcome.ok, true);
  const committed = (committedOutcome as { receipt: { status: string; planVersion?: number; stepRefs?: { stepId: string }[] } }).receipt;
  assert.equal(committed.status, 'committed'); assert.equal(committed.planVersion, 2);
  assert.deepEqual(committed.stepRefs!.map(ref => ref.stepId), ['step-b2']);
  const afterRevision = f.call('core.plan', { goalId: goal.goalId });
  assert.equal(afterRevision.history.length, 2); assert.equal(afterRevision.history[0]!.planVersion, 1);
  assert.equal(afterRevision.current!.steps[0]!.deliverableId, 'b');
  assert.deepEqual(afterRevision.current!.facts.map(fact => fact.state), ['resolved']);
  const remainingTask = afterRevision.snapshot!.steps[0]!.taskId!;
  f.finish(remainingTask);
  assert.deepEqual(f.call('core.pending', {}).goalIds, [goal.goalId]);
  const finalRound = f.call('core.claim', { goalId: goal.goalId })!;
  const completionText = JSON.stringify({ kind: 'complete_candidate', reason: 'All owner deliverables have verified Tasks' });
  const completionOutcome = f.attempt(finalRound, completionText);
  assert.equal(completionOutcome.ok, true);
  assert.equal((completionOutcome as { receipt: { kind: string } }).receipt.kind, 'complete_candidate');
  const verified = f.call('core.get', { goalId: goal.goalId });
  const observations = verified.taskRefs.map(ref => {
    const detail = f.task('task.get', { taskId: ref.taskId });
    return { deliverableId: ref.deliverableId, taskId: detail.task.taskId, taskVersion: detail.task.version, artifactRef: detail.artifact.artifactRef,
      observedSha256: detail.artifact.expectedSha256, observedBytes: detail.artifact.byteLength, receiptId: `read:${ref.taskId}`, observedAt: f.now().toISOString() };
  });
  const proof = f.call('core.verifyCompletion', { goalId: goal.goalId, expectedVersion: verified.version, goalRef: verified.native!.goalRef, observations });
  assert.equal(proof.completionCriteriaHash, verified.completionCriteriaHash);
  assert.equal(proof.evidenceRefs.length >= 3, true);
  // No change after completion: no further claim, no second plan and no model round.
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
});

test('overreaching, invalid and unsourced plan candidates are rejected without Tasks, plan versions or held budget', t => {
  const f = fixture(t);
  const cases: { name: string; candidate(goal: CoreGoal): string; expected: string }[] = [
    { name: 'invalid JSON', candidate: () => '{"kind":"plan_candidate","plan":', expected: 'INVALID_CORE_CANDIDATE' },
    { name: 'unknown candidate kind', candidate: goal => JSON.stringify({ kind: 'reboot', plan: {} }), expected: 'INVALID_CORE_CANDIDATE' },
    { name: 'tool injection', candidate: goal => f.planCandidate(goal).replace('"expectedArtifact"', '"tools":["shell.exec"],"expectedArtifact"'), expected: 'INVALID_CORE_INPUT' },
    { name: 'budget injection', candidate: goal => f.planCandidate(goal).replace('"summary"', '"budget":{"tokens":999999999},"summary"'), expected: 'INVALID_CORE_INPUT' },
    { name: 'mandate injection', candidate: goal => f.planCandidate(goal).replace('"summary"', '"mandate":{"scope":"global"},"summary"'), expected: 'INVALID_CORE_INPUT' },
    { name: 'ungranted deliverable', candidate: goal => f.planCandidate(goal, { steps: [{ stepId: 'sx', deliverableId: 'not-owner-authorized',
      dependsOn: [], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } }] }), expected: 'CORE_SCOPE_DENIED' },
    { name: 'incomplete coverage', candidate: goal => f.planCandidate(goal, { steps: [{ stepId: 'sa', deliverableId: 'a', dependsOn: [],
      requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } }] }), expected: 'CORE_PLAN_INCOMPLETE' },
    { name: 'unknown dependency step', candidate: goal => f.planCandidate(goal, { steps: [
      { stepId: 'sa', deliverableId: 'a', dependsOn: ['missing-step'], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } },
      { stepId: 'sb', deliverableId: 'b', dependsOn: ['sa'], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } },
      { stepId: 'sc', deliverableId: 'c', dependsOn: [], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } }] }), expected: 'CORE_PLAN_STRUCTURE_INVALID' },
    { name: 'dependency cycle', candidate: goal => f.planCandidate(goal, { steps: [
      { stepId: 'sa', deliverableId: 'a', dependsOn: ['sc'], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } },
      { stepId: 'sb', deliverableId: 'b', dependsOn: ['sa'], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } },
      { stepId: 'sc', deliverableId: 'c', dependsOn: ['sa'], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } }] }), expected: 'CORE_PLAN_STRUCTURE_INVALID' },
    { name: 'owner dependency not ordered', candidate: goal => f.planCandidate(goal, { steps: [
      { stepId: 'sa', deliverableId: 'a', dependsOn: [], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } },
      { stepId: 'sb', deliverableId: 'b', dependsOn: [], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } },
      { stepId: 'sc', deliverableId: 'c', dependsOn: [], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } }] }), expected: 'CORE_PLAN_DEPENDENCY_ORDER_INVALID' },
    { name: 'unsourced fact', candidate: goal => f.planCandidate(goal, { steps: [
      { stepId: 'sa', deliverableId: 'a', dependsOn: [], requiredFacts: [{ kind: 'task', ref: 'task-invented-by-model' }], expectedArtifact: { ...PLAN_ARTIFACT } },
      { stepId: 'sb', deliverableId: 'b', dependsOn: ['sa'], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } },
      { stepId: 'sc', deliverableId: 'c', dependsOn: [], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } }] }), expected: 'CORE_PLAN_FACT_UNSOURCED' },
    { name: 'unsourced reasoning', candidate: goal => f.planCandidate(goal, { reasoningRefs: ['owner-approval:unlimited'] }), expected: 'CORE_PLAN_REF_UNSOURCED' },
    { name: 'stale base version', candidate: goal => f.planCandidate(goal, { basePlanVersion: 7 }), expected: 'CORE_PLAN_STALE' },
    { name: 'excess parallelism', candidate: goal => f.planCandidate(goal).replace('"maxParallelSteps":2', '"maxParallelSteps":5'), expected: 'INVALID_CORE_INPUT' },
    { name: 'excess failure allowance', candidate: goal => f.planCandidate(goal).replace('"maxFailedSteps":0', '"maxFailedSteps":9'), expected: 'INVALID_CORE_INPUT' },
    { name: 'wrong artifact verifier', candidate: goal => f.planCandidate(goal).replaceAll('artifact.sha256.v1', 'model.self-attest.v9'), expected: 'INVALID_CORE_CANDIDATE' },
    { name: 'oversized plan', candidate: goal => JSON.stringify({ kind: 'plan_candidate', plan: { basePlanVersion: 0,
      steps: Array.from({ length: CORE_PLAN_LIMITS.steps + 1 }, (_value, index) => ({ stepId: `s${index}`, deliverableId: 'a',
        dependsOn: [], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } })),
      stopConditions: { onStepFailure: 'stop', maxFailedSteps: 0, onFactConflict: 'wait', maxParallelSteps: 2 },
      reasoningRefs: [`goal:${goal.goalId}`], summary: 'oversized' } }), expected: 'INVALID_CORE_CANDIDATE' },
  ];
  for (const scenario of cases) {
    const goal = f.authorize();
    // A candidate is a candidate: it never mints Tasks, plan versions or holds.
    f.reject(goal, scenario.candidate(goal), scenario.expected);
    const current = f.call('core.get', { goalId: goal.goalId });
    assert.equal(current.planVersion, 0, scenario.name);
    assert.deepEqual(current.taskRefs, [], scenario.name);
    assert.equal(f.task('task.list', {}).length, 0, scenario.name);
    const plan = f.call('core.plan', { goalId: goal.goalId });
    assert.deepEqual(plan.history, [], scenario.name);
    const balance = f.call('core.balance', { goalId: goal.goalId })!;
    assert.deepEqual(balance.held, { tokens: 0, calls: 0, effects: 0 }, scenario.name);
    assert.equal(balance.spent.calls, 1, scenario.name);
  }
});

test('plan admission and completion are idempotent while stale revisions cannot overwrite the accepted plan', t => {
  const f = fixture(t), input = f.prepareInput({ requestId: 'owner-repeat-plan' }), goal = f.authorize(input);
  // Duplicate owner request IDs cannot create a second Goal or a second plan namespace.
  assert.deepEqual(f.call('core.prepareGoal', input).goalId, goal.goalId);
  assert.throws(() => f.call('core.prepareGoal', { ...input, objective: 'changed owner intent' }), code('IDEMPOTENCY_CONFLICT'));
  const first = f.evaluate(goal, f.planCandidate(goal));
  assert.equal(first.receipt.planVersion, 1);
  // Replaying the exact committed proposal returns its original receipt.
  const replay = f.call('core.commitCandidate', { permit: first.evaluation.permit, proposalId: `proposal:${first.evaluation.evaluationId}`,
    candidateText: f.planCandidate(goal) });
  assert.deepEqual(replay, first.receipt);
  assert.equal(f.call('core.plan', { goalId: goal.goalId }).history.length, 1);
  // Same evaluation ID and proposal identity with different content conflicts.
  f.finish(f.call('core.get', { goalId: goal.goalId }).taskRefs[0]!.taskId);
  const second = f.call('core.claim', { goalId: goal.goalId })!;
  assert.equal(second.plan!.current!.planVersion, 1);
  const revision = f.planCandidate({ ...goal, taskRefs: f.call('core.get', { goalId: goal.goalId }).taskRefs, planVersion: 1 });
  const committed = f.attempt(second, revision);
  assert.equal(committed.ok, true);
  assert.equal((committed as { receipt: { planVersion?: number } }).receipt.planVersion, 2);
  assert.throws(() => f.call('core.commitCandidate', { permit: second.permit, proposalId: `proposal:${second.evaluationId}`,
    candidateText: f.planCandidate({ ...goal, planVersion: 2 }) }), code('IDEMPOTENCY_CONFLICT'));
  // An old revision candidate cannot overwrite the newly accepted plan.
  f.finish(f.call('core.get', { goalId: goal.goalId }).taskRefs.at(-1)!.taskId);
  const third = f.call('core.claim', { goalId: goal.goalId })!;
  const staleText = JSON.stringify({ kind: 'plan_candidate', plan: { basePlanVersion: 1, steps: [
    { stepId: 'stale-a', deliverableId: 'a', dependsOn: [], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } },
    { stepId: 'stale-b', deliverableId: 'b', dependsOn: [], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } }],
    stopConditions: { onStepFailure: 'stop', maxFailedSteps: 0, onFactConflict: 'wait', maxParallelSteps: 2 },
    reasoningRefs: [`goal:${goal.goalId}`], summary: 'stale' } });
  const stale = f.attempt(third, staleText);
  assert.equal(stale.ok, false); assert.ok(code('CORE_PLAN_STALE')((stale as { error: unknown }).error));
  f.call('core.rejectEvaluation', { permit: third.permit, reasonCode: 'CORE_PLAN_STALE' });
  const finalPlan = f.call('core.plan', { goalId: goal.goalId });
  assert.equal(finalPlan.planVersion, 2); assert.equal(finalPlan.history.length, 2);
  // The stale rejected round keeps its consumption but grants no derived work.
  assert.equal(f.call('core.get', { goalId: goal.goalId }).taskRefs.length, 3);
});

test('required facts are resolved from the trusted ledger, preserved while pending, and stop conditions hold new work', t => {
  const f = fixture(t), goal = f.authorize({ deliverables: [
    { id: 'a', title: 'A', content: 'synthetic note A' }, { id: 'b', title: 'B', content: 'synthetic note B' },
    { id: 'c', title: 'C', content: 'synthetic note C' }] });
  // First plan orders c and a first (bounded parallelism 2): b stays unowned.
  f.evaluate(goal, f.planCandidate(goal, { steps: [
    { stepId: 'step-c', deliverableId: 'c', dependsOn: [], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } },
    { stepId: 'step-a', deliverableId: 'a', dependsOn: [], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } },
    { stepId: 'step-b', deliverableId: 'b', dependsOn: [], requiredFacts: [], expectedArtifact: { ...PLAN_ARTIFACT } }] }));
  let current = f.call('core.get', { goalId: goal.goalId });
  const taskA = current.taskRefs.find(ref => ref.deliverableId === 'a')!.taskId;
  const taskC = current.taskRefs.find(ref => ref.deliverableId === 'c')!.taskId;
  f.finish(taskC); // one trusted Task result creates the next eligible round
  const pendingRound = f.call('core.claim', { goalId: goal.goalId })!;
  // A revision can depend on a still-running Task's future result; that fact is
  // recorded as pending and admits no Task. The model cannot fill it with prose.
  const revisionPending = JSON.stringify({ kind: 'plan_candidate', plan: { basePlanVersion: 1,
    steps: [{ stepId: 'step-b', deliverableId: 'b', dependsOn: [],
      requiredFacts: [{ kind: 'task', ref: taskA }], expectedArtifact: { ...PLAN_ARTIFACT } }],
    stopConditions: { onStepFailure: 'continue_independent', maxFailedSteps: 1, onFactConflict: 'stop', maxParallelSteps: 2 },
    reasoningRefs: [`goal:${goal.goalId}`, taskA], summary: 'Wait for the running dependency result' } });
  const committed = f.attempt(pendingRound, revisionPending);
  assert.equal(committed.ok, true);
  const receipt = (committed as { receipt: { planVersion?: number; stepRefs?: unknown[] } }).receipt;
  assert.equal(receipt.planVersion, 2); assert.equal(receipt.stepRefs, undefined);
  const plan = f.call('core.plan', { goalId: goal.goalId });
  assert.deepEqual(plan.current!.facts.map(fact => [fact.kind, fact.ref, fact.state]), [['task', taskA, 'pending']]);
  assert.deepEqual(plan.snapshot!.steps.map(step => step.state), ['blocked_fact']);
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
  assert.equal(f.call('core.snapshot', {})[0]!.planning!.reasonCode, 'plan_waiting_fact');
  // The Task result resolves the fact; the next revision can then admit the step.
  f.finish(taskA);
  assert.deepEqual(f.call('core.pending', {}).goalIds, [goal.goalId]);
  const resolvedRound = f.call('core.claim', { goalId: goal.goalId })!;
  assert.deepEqual(resolvedRound.plan!.facts.map(fact => [fact.kind, fact.ref, fact.state]), [['task', taskA, 'resolved']]);
  const revisionResolved = JSON.stringify({ kind: 'plan_candidate', plan: { basePlanVersion: 2,
    steps: [{ stepId: 'step-b', deliverableId: 'b', dependsOn: [],
      requiredFacts: [{ kind: 'task', ref: taskA }], expectedArtifact: { ...PLAN_ARTIFACT } }],
    stopConditions: { onStepFailure: 'continue_independent', maxFailedSteps: 1, onFactConflict: 'stop', maxParallelSteps: 2 },
    reasoningRefs: [`goal:${goal.goalId}`, taskA], summary: 'The dependency result is now verified' } });
  const resolved = f.attempt(resolvedRound, revisionResolved);
  assert.equal(resolved.ok, true);
  assert.deepEqual((resolved as { receipt: { stepRefs: { stepId: string }[] } }).receipt.stepRefs.map(ref => ref.stepId), ['step-b']);
  current = f.call('core.get', { goalId: goal.goalId });
  assert.deepEqual(current.taskRefs.map(ref => ref.deliverableId), ['c', 'a', 'b']);
  f.finish(current.taskRefs.find(ref => ref.deliverableId === 'b')!.taskId);
  // All deliverables are succeeded; a completion candidate is still only a candidate.
  const completionRound = f.call('core.claim', { goalId: goal.goalId })!;
  const completionText = JSON.stringify({ kind: 'complete_candidate', reason: 'All verified' });
  const completionOutcome = f.attempt(completionRound, completionText);
  assert.equal(completionOutcome.ok, true);
  assert.equal((completionOutcome as { receipt: { kind: string } }).receipt.kind, 'complete_candidate');
});

test('plan stop conditions and unavailable control states are distinguishable and never retried', t => {
  const f = fixture(t), goal = f.authorize();
  f.evaluate(goal, f.planCandidate(goal));
  const current = f.call('core.get', { goalId: goal.goalId });
  const taskA = current.taskRefs.find(ref => ref.deliverableId === 'a')!.taskId;
  // Repeated failure: stopping policy holds every further step and no round is claimed.
  const cancelled = f.cancelTask(taskA);
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
  assert.equal(f.call('core.snapshot', {})[0]!.planning!.reasonCode, 'plan_stopped_step_failed');
  assert.equal(f.call('core.claim', { goalId: goal.goalId }), undefined);
  assert.equal(f.call('core.evaluations', { goalId: goal.goalId }).length, 1);
  // Owner pause is a durable distinct state; resume requires a confirmed native
  // resume and reopens eligibility without replaying the failed round.
  const pausedGoal = f.call('core.pause', { goalId: goal.goalId, expectedVersion: f.call('core.get', { goalId: goal.goalId }).version });
  assert.equal(pausedGoal.paused, true);
  assert.equal(f.call('core.snapshot', {}).find(item => item.goalId === goal.goalId)!.planning!.reasonCode, 'paused');
  f.native(pausedGoal, 'paused'); f.native(f.call('core.get', { goalId: goal.goalId }));
  const resumedGoal = f.call('core.resume', { goalId: goal.goalId, expectedVersion: f.call('core.get', { goalId: goal.goalId }).version });
  assert.equal(resumedGoal.paused, false);
  assert.deepEqual(f.call('core.evaluations', { goalId: goal.goalId }).length, 1);
  assert.equal(f.call('core.claim', { goalId: goal.goalId }), undefined);
  // Cancelling the owner capability is a different observable state than a stop policy.
  const cancelledGoal = f.call('core.cancel', { goalId: goal.goalId, expectedVersion: f.call('core.get', { goalId: goal.goalId }).version });
  assert.equal(cancelledGoal.cancelled, true);
  assert.equal(f.call('core.snapshot', {})[0]!.planning!.reasonCode, 'cancelled');
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });

  const unknownGoal = f.authorize(), unknownPlan = f.evaluate(unknownGoal, f.planCandidate(unknownGoal));
  const unknownTask = f.call('core.get', { goalId: unknownGoal.goalId }).taskRefs[0]!.taskId;
  f.task('task.markUnknown', { taskId: unknownTask, reason: 'synthetic uncertain worker result' });
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
  assert.equal(f.call('core.snapshot', {}).find(item => item.goalId === unknownGoal.goalId)!.planning!.reasonCode, 'task_unknown');
  f.advance(600000);
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
  f.native(f.call('core.get', { goalId: unknownGoal.goalId }));
  assert.equal(f.call('core.claim', { goalId: unknownGoal.goalId }), undefined);
  assert.equal(f.call('core.evaluations', { goalId: unknownGoal.goalId }).length, 1);
  assert.equal(f.call('core.plan', { goalId: unknownGoal.goalId }).planVersion, 1);
  assert.equal(unknownPlan.receipt.status, 'committed');

  // A tolerant failure policy keeps independent work eligible for the next
  // trusted trigger, then stops once its bounded allowance is exceeded.
  const tolerant = f.authorize({ deliverables: [
    { id: 'a', title: 'A', content: 'synthetic note A' },
    { id: 'b', title: 'B', content: 'synthetic note B' },
    { id: 'c', title: 'C', content: 'synthetic note C' }] });
  f.evaluate(tolerant, f.planCandidate(tolerant).replace('"onStepFailure":"stop","maxFailedSteps":0', '"onStepFailure":"continue_independent","maxFailedSteps":1'));
  const tolerantTasks = f.call('core.get', { goalId: tolerant.goalId }).taskRefs.map(ref => ref.taskId);
  assert.equal(tolerantTasks.length, 2);
  f.cancelTask(tolerantTasks[0]!);
  assert.equal(f.call('core.snapshot', {}).find(item => item.goalId === tolerant.goalId)!.planning!.reasonCode, 'plan_tolerated_failure');
  f.cancelTask(tolerantTasks[1]!);
  assert.equal(f.call('core.snapshot', {}).find(item => item.goalId === tolerant.goalId)!.planning!.reasonCode, 'plan_stopped_failure_limit');
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });

  // A missing capability view is explicit and never becomes an empty success.
  const noViewGoal = f.authorize(), capability = f.reads.capability;
  capability.setEnabled({ requestId: 'disable-plan-view', expectedRevision: capability.snapshot().revision, enabled: false });
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
  assert.equal(f.call('core.snapshot', {}).find(item => item.goalId === noViewGoal.goalId)!.planning!.reasonCode, 'capability_unavailable');
  assert.equal(f.call('core.claim', { goalId: noViewGoal.goalId }), undefined);
  capability.setEnabled({ requestId: 'enable-plan-view', expectedRevision: capability.snapshot().revision, enabled: true });
  assert.equal(f.call('core.snapshot', {}).find(item => item.goalId === noViewGoal.goalId)!.planning!.eligible, true);
});

test('fact conflicts stop a plan with a distinct state while an exhausted budget is held without new claims', t => {
  const f = fixture(t), goal = f.authorize();
  f.evaluate(goal, f.planCandidate(goal));
  const current = f.call('core.get', { goalId: goal.goalId });
  const taskA = current.taskRefs.find(ref => ref.deliverableId === 'a')!.taskId;
  f.finish(current.taskRefs.find(ref => ref.deliverableId === 'c')!.taskId);
  const round = f.call('core.claim', { goalId: goal.goalId })!;
  const revision = JSON.stringify({ kind: 'plan_candidate', plan: { basePlanVersion: 1,
    steps: [{ stepId: 'step-b', deliverableId: 'b', dependsOn: [],
      requiredFacts: [{ kind: 'task', ref: taskA }], expectedArtifact: { ...PLAN_ARTIFACT } }],
    stopConditions: { onStepFailure: 'continue_independent', maxFailedSteps: 1, onFactConflict: 'stop', maxParallelSteps: 2 },
    reasoningRefs: [`goal:${goal.goalId}`, taskA], summary: 'Wait on the running dependency' } });
  assert.equal(f.attempt(round, revision).ok, true);
  f.cancelTask(taskA);
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
  assert.equal(f.call('core.snapshot', {})[0]!.planning!.reasonCode, 'plan_stopped_fact_conflict');
  assert.equal(f.call('core.claim', { goalId: goal.goalId }), undefined);

  const tiny = f.authorize({ budget: { tokens: 32768, calls: 6, effects: 3 } });
  f.evaluate(tiny, f.planCandidate(tiny).replace('"maxParallelSteps":2', '"maxParallelSteps":1'));
  // One admissible plan round plus one Task reservation leaves less than the
  // fixed planning allowance; the durable state holds the remaining budget.
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
  assert.equal(f.call('core.snapshot', {}).find(item => item.goalId === tiny.goalId)!.planning!.reasonCode, 'budget_exhausted');
  assert.equal(f.call('core.claim', { goalId: tiny.goalId }), undefined);
  const balance = f.call('core.balance', { goalId: tiny.goalId })!;
  assert.equal(balance.held.tokens > 0, true);
  assert.equal(f.task('task.list', {}).filter(task => task.goalId === tiny.goalId).length, 1);
});

test('a wrong worker artifact and a self-declared completion cannot pass independent verification', t => {
  const f = fixture(t), goal = f.authorize();
  f.evaluate(goal, f.planCandidate(goal));
  const current = f.call('core.get', { goalId: goal.goalId });
  const taskA = current.taskRefs.find(ref => ref.deliverableId === 'a')!.taskId;
  const tampered = f.tamperArtifact(taskA);
  assert.equal(tampered.task.state, 'waiting'); assert.equal(tampered.artifact.expectedSha256, sha('synthetic note A'));
  assert.equal(f.call('core.pending', {}).goalIds.length, 0);
  // A trusted lifecycle round exists (pause/resume owner fact), but the model's
  // prose cannot replace the missing artifact evidence.
  f.pauseResume(goal.goalId);
  const round = f.call('core.claim', { goalId: goal.goalId })!;
  const selfAttested = JSON.stringify({ kind: 'complete_candidate', reason: 'The worker says everything is written' });
  const outcome = f.attempt(round, selfAttested);
  assert.equal(outcome.ok, false); assert.ok(code('CORE_COMPLETION_UNPROVEN')((outcome as { error: unknown }).error));
  f.call('core.rejectEvaluation', { permit: round.permit, reasonCode: 'CORE_COMPLETION_UNPROVEN' });
  const after = f.call('core.get', { goalId: goal.goalId });
  assert.equal(after.native!.phase, 'active'); assert.equal(after.taskRefs.length, 2);
  assert.equal(f.task('task.get', { taskId: taskA }).task.verification, undefined);
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
});

test('legacy single-step intent remains available only until a plan owns the Goal', t => {
  const f = fixture(t), goal = f.authorize({ deliverables: [{ id: 'a', title: 'A', content: 'synthetic note A' },
    { id: 'b', title: 'B', content: 'synthetic note B' }] });
  const legacyText = JSON.stringify({ kind: 'task_intent', deliverableId: 'a', reason: 'Select the explicit owner deliverable' });
  const legacy = f.evaluate(goal, legacyText);
  assert.ok(legacy.receipt.taskId); assert.equal(legacy.receipt.planVersion, undefined);
  assert.equal(f.call('core.get', { goalId: goal.goalId }).planVersion, 0);
  assert.equal(f.task('task.list', {}).length, 1);
  const text = JSON.stringify({ kind: 'task_intent', deliverableId: 'b', reason: 'Model now selects another deliverable' });
  // Build a fresh round through legacy-compatible Task completion and its fact.
  f.finish(f.call('core.get', { goalId: goal.goalId }).taskRefs[0]!.taskId);
  const round = f.call('core.claim', { goalId: goal.goalId })!;
  const outcome = f.attempt(round, text);
  assert.equal(outcome.ok, true);
  assert.equal((outcome as { receipt: { kind: string } }).receipt.kind, 'task_intent');
  // The second Task existed before planning; the Goal still has no accepted plan.
  assert.equal(f.call('core.get', { goalId: goal.goalId }).planVersion, 0);
});

test('accepted plans refuse legacy ad-hoc Task selection and cancelled Goals generate no new eligibility', t => {
  const f = fixture(t), goal = f.authorize();
  f.evaluate(goal, f.planCandidate(goal));
  f.finish(f.call('core.get', { goalId: goal.goalId }).taskRefs.find(ref => ref.deliverableId === 'c')!.taskId);
  const round = f.call('core.claim', { goalId: goal.goalId })!;
  const legacyText = JSON.stringify({ kind: 'task_intent', deliverableId: 'b', reason: 'Bypass the plan' });
  const outcome = f.attempt(round, legacyText);
  assert.equal(outcome.ok, false); assert.ok(code('CORE_PLAN_REQUIRED')((outcome as { error: unknown }).error));
  f.call('core.rejectEvaluation', { permit: round.permit, reasonCode: 'CORE_PLAN_REQUIRED' });
  assert.equal(f.call('core.get', { goalId: goal.goalId }).taskRefs.length, 2);
  const cancelled = f.call('core.cancel', { goalId: goal.goalId, expectedVersion: f.call('core.get', { goalId: goal.goalId }).version });
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
  assert.equal(f.call('core.plan', { goalId: goal.goalId }).planVersion, 1);
  assert.throws(() => f.call('core.claim', { goalId: goal.goalId }), code('CORE_PAUSED'));
});

test('unknown rounds never restart by lease expiry or reopen and late old rounds gain no new authority', t => {
  const f = fixture(t), goal = f.authorize();
  const evaluation = f.call('core.claim', { goalId: goal.goalId })!;
  f.dispatched(evaluation, '{"kind":"defer","reason":"later","retryAfterMs":1000}');
  f.call('core.markUnknown', { permit: evaluation.permit, reasonCode: 'synthetic_lost_native_result' });
  assert.equal(f.call('core.snapshot', {})[0]!.planning!.reasonCode, 'evaluation_unknown');
  f.advance(3600000);
  assert.deepEqual(f.call('core.pending', {}), { goalIds: [] });
  const refreshed = f.native(f.call('core.get', { goalId: goal.goalId }));
  assert.equal(refreshed.native!.phase, 'active');
  assert.equal(f.call('core.claim', { goalId: goal.goalId }), undefined);
  assert.equal(f.call('core.evaluations', { goalId: goal.goalId }).length, 1);
  assert.throws(() => f.call('core.commitCandidate', { permit: evaluation.permit, proposalId: 'proposal-after-unknown',
    candidateText: '{"kind":"no_action","reason":"late"}' }), code('STALE_CORE_PERMIT'));
  // A late Task assignment permit cannot bind or report after the task was cancelled.
  const lateGoal = f.authorize();
  f.evaluate(lateGoal, f.planCandidate(lateGoal));
  const lateTask = f.call('core.get', { goalId: lateGoal.goalId }).taskRefs[0]!.taskId;
  const taskPlan = f.task('task.claimAssignment', { taskId: lateTask });
  f.task('task.cancel', { taskId: lateTask, reason: 'synthetic cancellation' });
  f.task('task.confirmCancelled', { taskId: lateTask, proof: { assignmentId: taskPlan.assignmentId, oldExecutionStopped: true, effectsKnown: true,
    pendingIntentsInvalidated: true, evidenceRefs: ['synthetic-stop'] } });
  assert.throws(() => f.task('task.bindAssignment', { permit: taskPlan.permit, sessionId: 'late-worker' }), code('STALE_FENCE'));
  assert.throws(() => f.task('task.assignmentStarted', { permit: taskPlan.permit }), code('STALE_FENCE'));
  assert.equal(f.task('task.get', { taskId: lateTask }).task.state, 'cancelled');

  f.native(f.call('core.get', { goalId: goal.goalId }));
  f.close(); const reopened = f.open('replacement-host');
  assert.deepEqual(reopened.call('core.pending', {}), { goalIds: [] });
  assert.equal(reopened.call('core.snapshot', {})[0]!.planning!.reasonCode, 'evaluation_unknown');
  assert.equal(reopened.call('core.evaluations', { goalId: goal.goalId })[0]!.status, 'unknown');
  assert.throws(() => reopened.call('core.commitCandidate', { permit: evaluation.permit, proposalId: 'proposal-old-host',
    candidateText: '{"kind":"no_action","reason":"late"}' }), code('STALE_CORE_PERMIT'));
});

test('plan revision history is hard bounded and a further revision is refused rather than overwriting history', t => {
  const f = fixture(t), goal = f.authorize({ deliverables: [
    { id: 'a', title: 'A', content: 'synthetic note A' },
    { id: 'b', title: 'B', content: 'synthetic note B', dependsOn: ['a'] }] });
  // The first plan admits only the dependency root; b stays waiting on a.
  f.evaluate(goal, f.planCandidate(goal).replace('"maxParallelSteps":2', '"maxParallelSteps":1'));
  assert.equal(f.call('core.plan', { goalId: goal.goalId }).history.length, 1);
  for (let revision = 1; revision < CORE_PLAN_LIMITS.history; revision++) {
    f.pauseResume(goal.goalId);
    const state = f.call('core.get', { goalId: goal.goalId });
    const round = f.call('core.claim', { goalId: goal.goalId })!;
    const outcome = f.attempt(round, f.planCandidate(state));
    assert.equal(outcome.ok, true, `revision ${revision + 1} should be accepted`);
    assert.equal((outcome as { receipt: { planVersion?: number } }).receipt.planVersion, revision + 1);
  }
  const full = f.call('core.plan', { goalId: goal.goalId });
  assert.equal(full.history.length, CORE_PLAN_LIMITS.history);
  assert.equal(full.planVersion, CORE_PLAN_LIMITS.history);
  f.pauseResume(goal.goalId);
  const state = f.call('core.get', { goalId: goal.goalId });
  const round = f.call('core.claim', { goalId: goal.goalId })!;
  const refused = f.attempt(round, f.planCandidate(state));
  assert.equal(refused.ok, false); assert.ok(code('CORE_PLAN_LIMIT')((refused as { error: unknown }).error));
  f.call('core.rejectEvaluation', { permit: round.permit, reasonCode: 'CORE_PLAN_LIMIT' });
  const after = f.call('core.plan', { goalId: goal.goalId });
  assert.equal(after.planVersion, CORE_PLAN_LIMITS.history);
  assert.equal(after.history.length, CORE_PLAN_LIMITS.history);
});

test('core.plan is a bounded read-only projection and unknown commands fail explicitly', t => {
  const f = fixture(t), goal = f.authorize();
  f.evaluate(goal, f.planCandidate(goal));
  const before = f.watermark.read(), version = f.call('core.get', { goalId: goal.goalId }).version;
  const tasks = f.task('task.list', {}).length, evaluations = f.call('core.evaluations', { goalId: goal.goalId }).length;
  let last: ReturnType<typeof f.call<'core.plan'>> | undefined;
  for (let index = 0; index < 1000; index++) last = f.call('core.plan', { goalId: goal.goalId });
  assert.equal(last!.planVersion, 1);
  assert.deepEqual(f.watermark.read(), before);
  assert.equal(f.call('core.get', { goalId: goal.goalId }).version, version);
  assert.equal(f.task('task.list', {}).length, tasks);
  assert.equal(f.call('core.evaluations', { goalId: goal.goalId }).length, evaluations);
  assert.throws(() => f.call('core.plan', { goalId: 'core-absent' }), code('UNKNOWN_CORE_GOAL'));
  assert.throws(() => f.core.execute({ command: 'core.unknown', args: {} } as never), code('UNKNOWN_CORE_COMMAND'));
  // The plan surface is bounded: advice history cannot grow without limit.
  assert.equal(CORE_PLAN_LIMITS.history, 16);
  assert.equal(CORE_PLAN_LIMITS.steps, 16);
  assert.equal(CORE_PLAN_LIMITS.factsPerStep, 8);
  assert.equal(CORE_PLAN_LIMITS.reasoningRefs, 32);
});
