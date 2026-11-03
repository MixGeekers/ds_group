import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { CoreCandidate, CoreEvaluation, CoreGoal, CorePlanVersion, CorePrepareInput } from '../src/contracts/core.js';
import type { CoreEvaluationResult } from '../src/control/core-pump.js';
import type { GoalBinding } from '../src/adapters/dsh/goals.js';
import type { CommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import type { TaskDetail } from '../src/adapters/control-store/task-domain.js';
import type { TaskView } from '../src/control/tasks/types.js';
import type { Budget } from '../src/control/policy/mandates.js';
import {
  assertBoundedCoreValidationReceipt, BoundedCoreValidationRunner, CoreValidationBusyError, CoreValidationOptionsError,
  frozenCoreValidationInput, runBoundedCoreValidation, CORE_VALIDATION_BUDGET,
  CORE_VALIDATION_DELIVERABLE, CORE_VALIDATION_MAX_EVALUATIONS, CORE_VALIDATION_OBJECTIVE, CORE_VALIDATION_POLL_MS,
  CORE_VALIDATION_RECEIPT_MAX_BYTES, CORE_VALIDATION_TEMPLATE_SHA256, CORE_VALIDATION_WALL_MS,
  type CoreValidationCommands, type CoreValidationDriver, type CoreValidationOptions, type CoreValidationReceipt, type CoreValidationStore,
} from '../src/control/core-validation.js';

// Synthetic world: a fake trusted core driver plus a read-only fake store. The
// real runtime injects LocalCoreService/ControlStore; these doubles simulate the
// bounded business chain without a model, a worker, a host or any real Task.
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const iso = (ms: number): string => new Date(ms).toISOString();
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === expected;
const clone = <T>(value: T): T => structuredClone(value);
const CONTENT = CORE_VALIDATION_DELIVERABLE.content;
const CONTENT_SHA = sha256(CONTENT);
const GOAL_REF = { id: 'native-core-validation-goal', revision: 1 };
const GOAL_SESSION = 'shiyu-core-goal-fixture-validation';
const CONTROL_SPEC = { version: 1, checks: [{ checkId: 'artifact-sha256', type: 'artifact.sha256', targetRef: 'artifact:task-note-1',
  expected: CONTENT_SHA, evidenceRequired: true }] };

function planVersionOne(): CorePlanVersion {
  return { schemaVersion: 2, goalId: 'core-validation-fixture', planVersion: 1, basePlanVersion: 0, evaluationId: 'evaluation:1',
    proposalId: 'proposal:evaluation:1', acceptedAt: iso(T0 + 1000), summary: 'Synthetic frozen note plan', reasoningRefs: ['goal:fixture'],
    triggerRefs: ['owner:fixture'], stopConditions: { onStepFailure: 'stop', maxFailedSteps: 0, onFactConflict: 'wait', maxParallelSteps: 2 },
    steps: [{ stepId: 'step-note-1', deliverableId: 'note-1', dependsOn: [], requiredFacts: [],
      expectedArtifact: { kind: 'local-note', verifier: 'artifact.sha256.v1' }, expectedSha256: CONTENT_SHA, byteLength: Buffer.byteLength(CONTENT) }],
    facts: [], planHash: 'a'.repeat(64) };
}
function reservation(evaluationId: string, state: 'settled' | 'unknown' = 'settled', observed: Partial<Budget> = { tokens: 123, calls: 1 }): CoreEvaluation['reservation'] {
  return { schemaVersion: 1, principalId: 'core:fixture', amount: { ...CORE_VALIDATION_BUDGET }, version: 1, state,
    observed: clone(observed), overrun: false, reservationId: `reservation:${evaluationId}`, mandateId: 'mandate:fixture', mandateVersion: 1,
    authEpoch: 1, scope: 'local-owner', action: 'core.evaluate', resourceScopes: ['goal:fixture'],
    leaseExpiresAt: iso(T0 + 120_000), createdAt: iso(T0 + 1000), updatedAt: iso(T0 + 9000) };
}
class World {
  clock = T0;
  goal?: CoreGoal;
  evaluations: CoreEvaluation[] = [];
  plan?: ReturnType<typeof planVersionOne>;
  tasks = new Map<string, TaskView>();
  details = new Map<string, TaskDetail>();
  binding?: GoalBinding;
  balance = { limits: { ...CORE_VALIDATION_BUDGET }, spent: { tokens: 0, calls: 0, effects: 0 } as Budget,
    held: { tokens: 0, calls: 0, effects: 0 } as Budget, available: { ...CORE_VALIDATION_BUDGET } };
  watermark: CommitWatermark = { schemaVersion: 1, commitSeq: 1, baselineId: 'fixture-baseline', startedAt: iso(T0), history: 'since-installation' };
  createCalls: CorePrepareInput[] = [];
  evaluateCalls = 0;
  controlCalls: { kind: 'pause' | 'cancel' | 'resume'; goalId: string; expectedVersion: number }[] = [];
  autoWorker = false;
  workerCompleted = false;
  workerTampered = false;
  evaluate: (world: World) => Promise<CoreEvaluationResult> = async () => ({ status: 'evaluated', goalId: 'unspecified' });
  createFailure?: string;
  createUnauthorized = false;
  driver: CoreValidationDriver;
  store: CoreValidationStore;
  constructor() {
    this.driver = {
      create: async (input, signal) => this.create(input, signal),
      control: async (kind, input) => this.control(kind, input),
      evaluatePending: async (input) => this.evaluateOnce(input?.signal),
    };
    this.store = {
      request: (async <K extends keyof CoreValidationCommands>(command: K, args: CoreValidationCommands[K]['input']): Promise<CoreValidationCommands[K]['output']> => {
        void args;
        switch (command) {
          case 'core.get': return clone(this.goal) as unknown as CoreValidationCommands[K]['output'];
          case 'core.snapshot': return (this.goal ? [clone(this.goal)] : []) as unknown as CoreValidationCommands[K]['output'];
          case 'core.evaluations': return clone(this.evaluations) as unknown as CoreValidationCommands[K]['output'];
          case 'core.balance': return clone(this.balance) as unknown as CoreValidationCommands[K]['output'];
          case 'core.plan': return (this.plan
            ? { goalId: this.goal?.goalId ?? 'fixture', planVersion: this.plan.planVersion, current: clone(this.plan), history: [clone(this.plan)] }
            : { goalId: this.goal?.goalId ?? 'fixture', planVersion: 0, history: [] }) as unknown as CoreValidationCommands[K]['output'];
          case 'goal.binding.load': return clone(this.binding) as unknown as CoreValidationCommands[K]['output'];
          case 'control.watermark': return clone(this.watermark) as unknown as CoreValidationCommands[K]['output'];
          case 'task.list': { this.maybeCompleteWorker(); return [...this.tasks.values()].map(clone) as unknown as CoreValidationCommands[K]['output']; }
          case 'task.get': { this.maybeCompleteWorker(); const taskId = (args as { taskId: string }).taskId;
            return clone(this.details.get(taskId)) as unknown as CoreValidationCommands[K]['output']; }
          default: throw new Error(`Unexpected fixture read command: ${String(command)}`);
        }
      }) as CoreValidationStore['request'],
    };
  }
  private async create(input: CorePrepareInput, signal?: AbortSignal): Promise<CoreGoal> {
    signal?.throwIfAborted();
    this.createCalls.push(clone(input));
    if (this.createFailure) throw Object.assign(new Error('Synthetic native Goal create failed'), { code: this.createFailure });
    const startedAt = this.clock;
    const goal: CoreGoal = { schemaVersion: 1, goalId: 'core-validation-fixture', requestId: input.requestId, objective: input.objective,
      deliverables: clone(input.deliverables), budget: clone(input.budget), expiresAt: input.expiresAt, maxEvaluations: input.maxEvaluations ?? 2,
      completionCriteria: '{"kind":"fixture"}', completionCriteriaHash: sha256('{"kind":"fixture"}'), version: 1,
      authorized: !this.createUnauthorized, paused: false, cancelled: false, controlEpoch: 1, mandateId: 'mandate:fixture',
      native: { goalId: 'native-core-validation-goal', goalRef: { ...GOAL_REF }, sessionId: GOAL_SESSION, phase: 'active', observedAt: iso(startedAt) },
      taskRefs: [], planVersion: 0, evaluations: 0, createdAt: iso(startedAt), updatedAt: iso(startedAt) };
    this.goal = goal;
    this.binding = { goalId: goal.goalId, sessionId: GOAL_SESSION, ownerId: 'local-owner', scope: 'local-owner', cwd: '/synthetic/core-validation',
      completionCriteriaHash: goal.completionCriteriaHash, metadataVersion: 2, goalRef: { ...GOAL_REF },
      receipt: { commandId: 'create:fixture', operation: 'create', status: 'confirmed', postconditionHash: sha256('create'), observedRef: { ...GOAL_REF } } };
    this.watermark = { ...this.watermark, commitSeq: this.watermark.commitSeq + 1 };
    return clone(goal);
  }
  private async control(kind: 'pause' | 'cancel' | 'resume', input: { goalId: string; expectedVersion: number }): Promise<CoreGoal> {
    const goal = this.goal;
    assert.ok(goal, 'control requires an existing fixture Goal');
    assert.equal(input.goalId, goal.goalId);
    assert.equal(input.expectedVersion, goal.version);
    this.controlCalls.push({ kind, ...input });
    const next: CoreGoal = { ...goal, version: goal.version + 1, controlEpoch: goal.controlEpoch + 1,
      paused: kind === 'pause' ? true : kind === 'resume' ? false : goal.paused, cancelled: goal.cancelled || kind === 'cancel',
      native: goal.native ? { ...goal.native, phase: kind === 'resume' ? 'active' : 'paused', observedAt: iso(this.clock) } : goal.native,
      updatedAt: iso(this.clock) };
    this.goal = next; this.watermark = { ...this.watermark, commitSeq: this.watermark.commitSeq + 1 };
    if (this.binding) {
      const updated: GoalBinding = { ...this.binding, metadataVersion: this.binding.metadataVersion + 1,
        receipt: { ...this.binding.receipt!, status: 'confirmed', operation: kind === 'cancel' ? 'pause' : kind, observedRef: next.native?.goalRef } };
      this.binding = updated;
    }
    return clone(next);
  }
  private async evaluateOnce(signal?: AbortSignal): Promise<CoreEvaluationResult> {
    this.evaluateCalls++;
    signal?.throwIfAborted();
    return this.evaluate(this);
  }
  private maybeCompleteWorker(): void {
    if (!this.autoWorker || this.workerCompleted || !this.goal || !this.goal.taskRefs.length) return;
    const task = this.tasks.get(this.goal.taskRefs[0]!.taskId);
    if (!task || task.state !== 'queued') return;
    this.workerCompleted = true;
    const succeeded: TaskView = { ...task, state: 'succeeded', version: task.version + 1, updatedAt: iso(this.clock),
      verification: { taskId: task.taskId, assignmentId: 'assignment-note-1', completionSpecVersion: 1, resultHash: CONTENT_SHA,
        verifierVersion: 'fixture-independent-verifier', verifiedAt: iso(this.clock), checks: [{ checkId: 'artifact-sha256', status: 'pass', evidenceRefs: ['artifact-observation:receipt-note-1'] }] },
      result: { resultHash: CONTENT_SHA, artifactRefs: ['artifact:task-note-1'], effectRefs: ['effect-note-1'] } };
    this.tasks.set(task.taskId, succeeded);
    const detail = taskDetail(succeeded);
    if (this.workerTampered) detail.artifact.expectedSha256 = sha256('tampered worker artifact');
    this.details.set(task.taskId, detail);
    this.balance = { limits: clone(this.balance.limits), spent: { tokens: 200, calls: 2, effects: 1 }, held: { tokens: 0, calls: 0, effects: 0 },
      available: { tokens: 16_184, calls: 1, effects: 0 } };
    this.watermark = { ...this.watermark, commitSeq: this.watermark.commitSeq + 1 };
  }
  commitPlanEvaluation(): void {
    const goal = this.goal!;
    const plan = planVersionOne(); plan.goalId = goal.goalId;
    this.plan = plan;
    goal.planVersion = 1; goal.plans = [clone(plan)]; goal.evaluations = 1; goal.updatedAt = iso(this.clock);
    const task = taskView(goal.goalId, 'queued');
    this.tasks.set(task.taskId, task);
    goal.taskRefs = [{ deliverableId: 'note-1', taskId: task.taskId }];
    const evaluation: CoreEvaluation = {
      evaluationId: 'evaluation:1', goalId: goal.goalId, status: 'committed',
      permit: { hostEpoch: 'fixture-host', installationGeneration: 'fixture-install', goalId: goal.goalId, evaluationId: 'evaluation:1',
        claimToken: 'fixture-claim', fencingToken: 1, controlEpoch: goal.controlEpoch, scopeVersion: goal.version,
        goalRef: { ...GOAL_REF }, reservationId: 'reservation:evaluation:1', mandateId: 'mandate:fixture', mandateVersion: 1,
        authEpoch: 1, leaseExpiresAt: iso(T0 + 120_000) },
      goal: clone(goal),
      tasks: [{ deliverableId: 'note-1', taskId: task.taskId, version: task.version, state: 'queued', effectVersions: [] }],
      triggerRefs: ['owner:fixture'], reservation: reservation('evaluation:1'),
      candidate: { kind: 'plan_candidate', plan: { basePlanVersion: 0, steps: [{ stepId: 'step-note-1', deliverableId: 'note-1', dependsOn: [],
        requiredFacts: [], expectedArtifact: { kind: 'local-note', verifier: 'artifact.sha256.v1' } }],
        stopConditions: { onStepFailure: 'stop', maxFailedSteps: 0, onFactConflict: 'wait', maxParallelSteps: 2 },
        reasoningRefs: ['goal:fixture'], summary: 'Synthetic frozen note plan' } } as CoreCandidate,
      receipt: { evaluationId: 'evaluation:1', proposalId: 'proposal:evaluation:1', status: 'committed', kind: 'plan_candidate',
        reasonCode: 'plan_candidate', planVersion: 1, stepRefs: [{ stepId: 'step-note-1', taskId: task.taskId }] },
    };
    this.evaluations.push(evaluation);
    this.watermark = { ...this.watermark, commitSeq: this.watermark.commitSeq + 1 };
  }
  completeNativeEvaluation(): void {
    const goal = this.goal!;
    goal.native = { ...goal.native!, phase: 'complete', observedAt: iso(this.clock) };
    goal.updatedAt = iso(this.clock);
    this.binding = this.binding ? { ...this.binding, metadataVersion: this.binding.metadataVersion + 1,
      receipt: { commandId: 'complete:fixture', operation: 'complete', status: 'confirmed', postconditionHash: sha256('complete'),
        observedRef: { ...GOAL_REF } } } : undefined;
    const evaluation: CoreEvaluation = {
      evaluationId: 'evaluation:2', goalId: goal.goalId, status: 'committed',
      permit: { hostEpoch: 'fixture-host', installationGeneration: 'fixture-install', goalId: goal.goalId, evaluationId: 'evaluation:2',
        claimToken: 'fixture-claim-2', fencingToken: 2, controlEpoch: goal.controlEpoch, scopeVersion: goal.version,
        goalRef: { ...GOAL_REF }, reservationId: 'reservation:evaluation:2', mandateId: 'mandate:fixture', mandateVersion: 1,
        authEpoch: 1, leaseExpiresAt: iso(T0 + 180_000) },
      goal: clone(goal), tasks: [], triggerRefs: ['task:task-note-1:2'], reservation: reservation('evaluation:2'),
      candidate: { kind: 'complete_candidate', reason: 'Independent Task/Effect evidence verified' },
      receipt: { evaluationId: 'evaluation:2', proposalId: 'proposal:evaluation:2', status: 'committed', kind: 'complete_candidate', reasonCode: 'complete_candidate' },
    };
    this.evaluations.push(evaluation);
    this.watermark = { ...this.watermark, commitSeq: this.watermark.commitSeq + 1 };
  }
}
function taskView(goalId: string, state: TaskView['state']): TaskView {
  return { taskId: 'task-note-1', title: CORE_VALIDATION_DELIVERABLE.title, state, version: 2, goalId, mandateId: 'mandate:fixture', mandateVersion: 1,
    completionSpec: clone(CONTROL_SPEC), originEventIds: [], inputRefs: [], latestAssignmentId: 'assignment-note-1', attempt: 1,
    stopRequested: false, createdAt: iso(T0), updatedAt: iso(T0) };
}
function taskDetail(task: TaskView): TaskDetail {
  const effect = { schemaVersion: 1, effectId: 'effect-note-1', idempotencyKey: 'idem-note-1',
    origin: { kind: 'task', taskId: task.taskId, assignmentId: 'assignment-note-1' }, action: 'artifact.write',
    resourceScopes: ['artifact:task-note-1'], payloadRef: 'payload:note-1', payloadHash: CONTENT_SHA, replayClass: 'idempotent',
    authorization: { hostEpoch: 'fixture-host', installationGeneration: 'fixture-install', fencingToken: 1, mandateId: 'mandate:fixture',
      mandateVersion: 1, authEpoch: 1 }, expiresAt: iso(T0 + 600_000), maxAttempts: 3, status: 'succeeded', version: 2,
    attempts: 1, createdAt: iso(T0), updatedAt: iso(T0), receiptId: 'receipt-note-1' };
  const receipt = { receiptId: 'receipt-note-1', serviceId: 'fixture-artifact', externalOperationId: 'effect-note-1', observedAt: iso(T0 + 5000),
    outcome: 'succeeded', payloadHash: CONTENT_SHA, evidenceRefs: ['artifact-observation:receipt-note-1'],
    effectId: 'effect-note-1', receivedAt: iso(T0 + 5000), mode: 'completion', verification: { verified: true, installationGeneration: 'fixture-install' },
    claim: { effectId: 'effect-note-1', attempt: 1, ownerId: 'worker:task-note-1', claimToken: 'claim-note-1', claimedAt: iso(T0),
      leaseExpiresAt: iso(T0 + 120_000), fencingToken: 1 } };
  return { task: clone(task), artifact: { artifactRef: 'artifact:task-note-1', expectedSha256: CONTENT_SHA, byteLength: Buffer.byteLength(CONTENT) },
    execution: { assignmentId: 'assignment-note-1', state: 'reported', sessionId: 'worker-session:note-1', hostEpoch: 'fixture-host',
      installationGeneration: 'fixture-install' }, effects: [effect], effectReceipts: [receipt],
    reservation: reservation('task:evaluation:1').state === 'settled' ? undefined : undefined } as unknown as TaskDetail;
}
function makeWorld(): World { return new World(); }
function optionsFor(world: World, extra: Partial<CoreValidationOptions> = {}): CoreValidationOptions {
  return { core: world.driver, store: world.store, now: () => world.clock,
    sleep: async (ms: number, signal: AbortSignal) => { signal.throwIfAborted(); world.clock += ms; await new Promise<void>(resolve => setImmediate(resolve)); },
    ...extra };
}
function completedScenario(world: World): void {
  const goalId = 'core-validation-fixture';
  void goalId;
  world.autoWorker = true;
  world.evaluate = async current => {
    if (world.evaluateCalls === 1) { world.commitPlanEvaluation(); return { status: 'evaluated', goalId: current.goal!.goalId, decisionId: 'proposal:evaluation:1', planVersion: 1 }; }
    world.completeNativeEvaluation();
    return { status: 'evaluated', goalId: current.goal!.goalId, decisionId: 'proposal:evaluation:2' };
  };
}

test('bounded validation completes the frozen chain: plan, Task/Effect/artifact verification and native Goal complete', async () => {
  const world = makeWorld(); completedScenario(world);
  const receipt = await runBoundedCoreValidation(optionsFor(world));
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.reasonCode, 'CORE_VALIDATION_COMPLETED');
  assert.equal(receipt.counters.evaluateAttempts, 2); assert.equal(receipt.counters.maxEvaluations, CORE_VALIDATION_MAX_EVALUATIONS);
  assert.equal(Number.isSafeInteger(receipt.counters.pollCount) && receipt.counters.pollCount >= 0 && receipt.counters.pollCount <= 200, true);
  assert.equal(receipt.goalId, 'core-validation-fixture');
  assert.equal(receipt.evaluations.length, 2);
  assert.equal(receipt.evaluations[0]!.kind, 'plan_candidate'); assert.equal(receipt.evaluations[0]!.candidateSummary, 'plan_candidate v1 steps=1');
  assert.equal(receipt.evaluations[1]!.kind, 'complete_candidate');
  assert.deepEqual(receipt.evaluations.map(evaluation => evaluation.usage.accounting), ['complete', 'complete']);
  assert.equal(receipt.plans.length, 1); assert.equal(receipt.plans[0]!.planVersion, 1); assert.equal(receipt.plans[0]!.steps[0]!.deliverableId, 'note-1');
  assert.equal(receipt.taskRefs.length, 1); assert.equal(receipt.taskRefs[0]!.state, 'succeeded');
  assert.equal(receipt.taskRefs[0]!.verification, 'pass'); assert.equal(receipt.taskRefs[0]!.expectedSha256, CONTENT_SHA);
  assert.equal(receipt.native.phase, 'complete'); assert.equal(receipt.native.completedObserved, true);
  assert.equal(receipt.native.bindingReceiptStatus, 'confirmed');
  assert.equal(receipt.stopAction.kind, 'none'); assert.equal(receipt.stopAction.attempted, false);
  assert.equal(receipt.businessSideEffects.goal.created, true);
  assert.deepEqual(receipt.businessSideEffects.tasks.ids, ['task-note-1']);
  assert.equal(receipt.businessSideEffects.effects.count, 1);
  assert.equal(receipt.businessSideEffects.artifacts.count, 1);
  assert.equal(receipt.artifacts.length, 1); assert.equal(receipt.artifacts[0]!.artifactRef, 'artifact:task-note-1');
  assert.equal(receipt.artifacts[0]!.expectedSha256, CONTENT_SHA); assert.equal(receipt.artifacts[0]!.observedSha256, CONTENT_SHA);
  assert.equal(receipt.artifacts[0]!.verification, 'pass');
  assert.deepEqual(receipt.effects, [{ effectId: 'effect-note-1', status: 'succeeded', receiptId: 'receipt-note-1' }]);
  assert.equal(receipt.businessSideEffects.sessions.goalSessionId, GOAL_SESSION);
  assert.deepEqual(receipt.businessSideEffects.sessions.workerSessionIds, ['worker-session:note-1']);
  assert.equal(receipt.fixedInput.templateSha256, CORE_VALIDATION_TEMPLATE_SHA256);
  assert.equal(world.evaluateCalls, 2); assert.equal(world.controlCalls.length, 0);
  assert.equal(world.createCalls.length, 1);
  assert.deepEqual(world.createCalls[0]!.deliverables, [{ id: 'note-1', title: CORE_VALIDATION_DELIVERABLE.title,
    content: CONTENT, dependsOn: [] }]);
  assert.deepEqual(world.createCalls[0]!.budget, CORE_VALIDATION_BUDGET);
  assert.equal(world.createCalls[0]!.objective, CORE_VALIDATION_OBJECTIVE);
  assert.equal(world.createCalls[0]!.maxEvaluations, CORE_VALIDATION_MAX_EVALUATIONS);
  assert.equal(new Date(world.createCalls[0]!.expiresAt).getTime() - T0, 10 * 60 * 1000);
  assertBoundedCoreValidationReceipt(receipt);
  assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt);
  assert.equal(Buffer.byteLength(JSON.stringify(receipt)) <= CORE_VALIDATION_RECEIPT_MAX_BYTES, true);
});

test('the independent receipt validator rejects lossless/boundary/fixed-input violations', async () => {
  const world = makeWorld(); completedScenario(world);
  const receipt = await runBoundedCoreValidation(optionsFor(world));
  assert.doesNotThrow(() => assertBoundedCoreValidationReceipt(receipt));
  const mutations: ((value: Record<string, unknown>) => void)[] = [
    value => { value.durationMs = Number.NaN; },
    value => { value.goal = undefined; },
    value => { (value.fixedInput as Record<string, unknown>).objectiveSha256 = 'x'.repeat(4_001); },
    value => { value.status = 'unknown'; },
    value => { (value.fixedInput as { budget: Budget }).budget = { tokens: 1, calls: 1, effects: 1 }; },
    value => { value.taskRefs = Array.from({ length: 17 }, () => ({})); },
    value => { value.counters = { evaluateAttempts: 3, pollCount: 0, maxEvaluations: 2, wallLimitMs: CORE_VALIDATION_WALL_MS }; },
    value => { (value.businessSideEffects as { tasks: { ids: unknown[]; count: number } }).tasks.ids = [undefined]; },
  ];
  for (const mutate of mutations) {
    const copy = JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;
    mutate(copy);
    assert.throws(() => assertBoundedCoreValidationReceipt(copy));
  }
});

test('an evaluation failure returns a bounded failed receipt, a single pause and no retry', async () => {
  const world = makeWorld();
  world.evaluate = async () => {
    // A committed plan advances the Goal version before the round fails late.
    world.commitPlanEvaluation();
    throw Object.assign(new Error('Synthetic core model round failed'), { code: 'SYNTHETIC_MODEL_FAILED' });
  };
  const receipt = await runBoundedCoreValidation(optionsFor(world));
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.reasonCode, 'CORE_VALIDATION_EVALUATION_FAILED');
  assert.equal(receipt.counters.evaluateAttempts, 1); assert.equal(world.evaluateCalls, 1);
  assert.equal(receipt.error?.phase, 'evaluate'); assert.equal(receipt.error?.code, 'SYNTHETIC_MODEL_FAILED');
  assert.equal(receipt.unknowns.includes('EVALUATION_FAILED'), true);
  assert.equal(receipt.stopAction.kind, 'pause'); assert.equal(receipt.stopAction.attempted, true); assert.equal(receipt.stopAction.ok, true);
  assert.deepEqual(world.controlCalls.map(call => call.kind), ['pause']);
  assert.equal(world.goal?.paused, true);
  assertBoundedCoreValidationReceipt(receipt);
});

test('an unknown evaluation round is preserved once and never retried or converted to success', async () => {
  const world = makeWorld();
  world.evaluate = async () => ({ status: 'unknown', goalId: 'core-validation-fixture' });
  const receipt = await runBoundedCoreValidation(optionsFor(world));
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.reasonCode, 'CORE_VALIDATION_EVALUATION_UNKNOWN');
  assert.equal(receipt.counters.evaluateAttempts, 1); assert.equal(world.evaluateCalls, 1);
  assert.equal(receipt.unknowns.includes('EVALUATION_UNKNOWN'), true);
  assert.equal(world.controlCalls.length, 1); assert.equal(world.goal?.paused, true);
  assertBoundedCoreValidationReceipt(receipt);
});

test('unknown provider usage stays unknown (never zero-filled) while independent completion still stands', async () => {
  const world = makeWorld();
  world.autoWorker = true;
  world.evaluate = async current => {
    if (world.evaluateCalls === 1) {
      world.commitPlanEvaluation();
      world.evaluations[0]!.reservation = reservation('evaluation:1', 'unknown', {});
      return { status: 'evaluated', goalId: current.goal!.goalId, decisionId: 'proposal:evaluation:1', planVersion: 1 };
    }
    world.completeNativeEvaluation();
    return { status: 'evaluated', goalId: current.goal!.goalId, decisionId: 'proposal:evaluation:2' };
  };
  const receipt = await runBoundedCoreValidation(optionsFor(world));
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.evaluations[0]!.usage.state, 'unknown');
  assert.equal(receipt.evaluations[0]!.usage.accounting, 'unknown');
  assert.equal(receipt.evaluations[0]!.usage.observedTokens, null);
  assert.equal(receipt.evaluations[0]!.usage.observedCalls, null);
  assert.equal(receipt.unknowns.includes('USAGE_UNKNOWN'), true);
  assert.equal(JSON.stringify(receipt).includes('"observedTokens":0'), false);
  assertBoundedCoreValidationReceipt(receipt);
});

test('wall timeout returns a timeout receipt and performs exactly one explicit pause', async () => {
  const world = makeWorld();
  world.evaluate = async current => {
    world.commitPlanEvaluation();
    return { status: 'evaluated', goalId: current.goal!.goalId, decisionId: 'proposal:evaluation:1', planVersion: 1 };
  };
  const receipt = await runBoundedCoreValidation(optionsFor(world));
  assert.equal(receipt.status, 'timeout'); assert.equal(receipt.reasonCode, 'CORE_VALIDATION_TIMEOUT');
  assert.equal(receipt.durationMs >= CORE_VALIDATION_WALL_MS, true);
  assert.equal(receipt.counters.evaluateAttempts, 1);
  assert.equal(receipt.counters.pollCount >= Math.floor((CORE_VALIDATION_WALL_MS - 1000) / CORE_VALIDATION_POLL_MS), true);
  assert.equal(receipt.unknowns.includes('WALL_LIMIT_REACHED'), true);
  assert.equal(receipt.stopAction.kind, 'pause'); assert.equal(receipt.stopAction.ok, true);
  assert.deepEqual(world.controlCalls.map(call => call.kind), ['pause']);
  assert.equal(world.goal?.paused, true);
  assertBoundedCoreValidationReceipt(receipt);
});

test('owner cancellation aborts the run, performs one cancel and never evaluates twice', async () => {
  const world = makeWorld();
  const abort = new AbortController();
  world.evaluate = async current => {
    world.commitPlanEvaluation();
    return { status: 'evaluated', goalId: current.goal!.goalId, decisionId: 'proposal:evaluation:1', planVersion: 1 };
  };
  const receipt = await runBoundedCoreValidation(optionsFor(world, { signal: abort.signal,
    sleep: async (ms, signal) => { world.clock += ms; if (world.clock - T0 >= 2 * CORE_VALIDATION_POLL_MS) abort.abort(new Error('owner abort')); signal.throwIfAborted(); } }));
  assert.equal(receipt.status, 'cancelled'); assert.equal(receipt.reasonCode, 'CORE_VALIDATION_CANCELLED');
  assert.equal(receipt.counters.evaluateAttempts, 1); assert.equal(world.evaluateCalls, 1);
  assert.equal(receipt.stopAction.kind, 'cancel'); assert.equal(receipt.stopAction.ok, true);
  assert.deepEqual(world.controlCalls.map(call => call.kind), ['cancel']);
  assert.equal(world.goal?.cancelled, true);
  assertBoundedCoreValidationReceipt(receipt);
});

test('the runner is single-flight: a concurrent call returns BUSY and releases after completion', async () => {
  const world = makeWorld();
  let release!: (value: CoreEvaluationResult) => void;
  const blocked = new Promise<CoreEvaluationResult>(resolve => { release = resolve; });
  world.evaluate = async () => blocked;
  const first = runBoundedCoreValidation(optionsFor(world));
  for (let index = 0; index < 200 && world.evaluateCalls === 0; index++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(world.evaluateCalls, 1);
  await assert.rejects(runBoundedCoreValidation(optionsFor(makeWorld())), (error: unknown) => error instanceof CoreValidationBusyError && code('CORE_VALIDATION_BUSY')(error));
  release({ status: 'unknown', goalId: 'core-validation-fixture' });
  const firstReceipt = await first;
  assert.equal(firstReceipt.status, 'failed');
  const second = await runBoundedCoreValidation(optionsFor(makeWorld()));
  assert.equal(second.status, 'failed');
});

test('frozen input cannot be overridden by options and reaches the trusted driver unchanged', async () => {
  for (const override of [{ objective: 'hijacked objective' }, { budget: { tokens: 1, calls: 1, effects: 1 } },
    { deliverables: [{ id: 'evil', title: 'evil', content: 'evil' }] }, { maxEvaluations: 9 }, { expiresAt: iso(T0 + 1000) }]) {
    const world = makeWorld(); completedScenario(world);
    await assert.rejects(runBoundedCoreValidation(optionsFor(world, override as never)),
      (error: unknown) => error instanceof CoreValidationOptionsError && code('CORE_VALIDATION_INVALID_OPTIONS')(error));
    assert.equal(world.createCalls.length, 0);
  }
  const world = makeWorld(); completedScenario(world);
  const receipt = await runBoundedCoreValidation(optionsFor(world));
  assert.equal(receipt.requestId, 'core-validation-frozen-v1');
  assert.deepEqual(world.createCalls[0], frozenCoreValidationInput(T0));
});

test('a failed Goal creation still returns a validated receipt with honest empty side effects', async () => {
  const world = makeWorld();
  world.createFailure = 'SYNTHETIC_CREATE_FAILED';
  const receipt = await runBoundedCoreValidation(optionsFor(world));
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.reasonCode, 'CORE_VALIDATION_CREATE_FAILED');
  assert.equal(receipt.error?.phase, 'create'); assert.equal(receipt.error?.code, 'SYNTHETIC_CREATE_FAILED');
  assert.equal(receipt.businessSideEffects.goal.created, false);
  assert.equal(receipt.stopAction.attempted, false);
  assert.equal(world.controlCalls.length, 0);
  assertBoundedCoreValidationReceipt(receipt);
});

test('an externally paused Goal is reported as paused without issuing a second stop command', async () => {
  const world = makeWorld();
  world.evaluate = async current => {
    world.commitPlanEvaluation();
    world.goal!.paused = true; world.goal!.version += 1;
    return { status: 'evaluated', goalId: current.goal!.goalId, decisionId: 'proposal:evaluation:1', planVersion: 1 };
  };
  const receipt = await runBoundedCoreValidation(optionsFor(world));
  assert.equal(receipt.status, 'paused'); assert.equal(receipt.reasonCode, 'CORE_VALIDATION_PAUSED_EXTERNALLY');
  assert.equal(receipt.stopAction.kind, 'none'); assert.equal(receipt.stopAction.reasonCode, 'ALREADY_STOPPED');
  assert.equal(world.controlCalls.length, 0);
  assertBoundedCoreValidationReceipt(receipt);
});

test('a budget overrun is detected and stopped instead of being reported as success', async () => {
  const world = makeWorld();
  world.evaluate = async current => {
    world.commitPlanEvaluation();
    world.balance = { ...world.balance, spent: { tokens: 20_000, calls: 2, effects: 1 } };
    return { status: 'evaluated', goalId: current.goal!.goalId, decisionId: 'proposal:evaluation:1', planVersion: 1 };
  };
  const receipt = await runBoundedCoreValidation(optionsFor(world));
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.reasonCode, 'CORE_VALIDATION_BUDGET_OVERRUN');
  assert.equal(receipt.unknowns.includes('BUDGET_OVERRUN'), true);
  assert.equal(receipt.budget?.overrun, true);
  assert.equal(receipt.stopAction.kind, 'pause'); assert.equal(receipt.stopAction.ok, true);
  assertBoundedCoreValidationReceipt(receipt);
});

test('an evaluation that produces no plan or Task fails explicitly without a second model round', async () => {
  const world = makeWorld();
  world.evaluate = async () => ({ status: 'evaluated', goalId: 'core-validation-fixture' });
  const receipt = await runBoundedCoreValidation(optionsFor(world));
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.reasonCode, 'CORE_VALIDATION_NO_PROGRESS');
  assert.equal(receipt.counters.evaluateAttempts, 1); assert.equal(world.evaluateCalls, 1);
  assert.equal(receipt.unknowns.includes('NO_PROGRESS_AFTER_EVALUATION'), true);
  assert.equal(receipt.stopAction.kind, 'pause'); assert.equal(receipt.stopAction.ok, true);
  assertBoundedCoreValidationReceipt(receipt);
});

test('invalid dependency options are rejected before any Goal is created', async () => {
  const world = makeWorld();
  await assert.rejects(runBoundedCoreValidation({ core: world.driver } as never),
    (error: unknown) => error instanceof CoreValidationOptionsError);
  await assert.rejects(runBoundedCoreValidation({ store: world.store } as never),
    (error: unknown) => error instanceof CoreValidationOptionsError);
  await assert.rejects(runBoundedCoreValidation({ core: world.driver, store: world.store, sleep: 'not-a-function' } as never),
    (error: unknown) => error instanceof CoreValidationOptionsError);
  assert.equal(world.createCalls.length, 0);
  const runner = new BoundedCoreValidationRunner();
  await assert.rejects(runner.run({ core: world.driver, store: world.store, progress: 42 } as never),
    (error: unknown) => error instanceof CoreValidationOptionsError);
});

test('a created Goal that is not exactly one active owner-authorized Goal fails the create integrity check', async () => {
  const world = makeWorld();
  world.createUnauthorized = true;
  const receipt = await runBoundedCoreValidation(optionsFor(world));
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.reasonCode, 'CORE_VALIDATION_CREATE_INTEGRITY');
  assert.equal(receipt.error?.code, 'CORE_VALIDATION_CREATE_INTEGRITY');
  assert.equal(receipt.unknowns.includes('GOAL_CREATE_INTEGRITY'), true);
  assert.equal(receipt.stopAction.kind, 'pause'); assert.equal(receipt.stopAction.ok, true);
  assert.equal(world.controlCalls.length, 1);
  assertBoundedCoreValidationReceipt(receipt);
});

test('a native complete that is not backed by independent artifact evidence is reported as evidence-incomplete', async () => {
  const world = makeWorld();
  world.autoWorker = true; world.workerTampered = true;
  world.evaluate = async current => {
    if (world.evaluateCalls === 1) { world.commitPlanEvaluation(); return { status: 'evaluated', goalId: current.goal!.goalId, planVersion: 1 }; }
    world.completeNativeEvaluation();
    return { status: 'evaluated', goalId: current.goal!.goalId };
  };
  const receipt = await runBoundedCoreValidation(optionsFor(world));
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.reasonCode, 'CORE_VALIDATION_EVIDENCE_INCOMPLETE');
  assert.equal(receipt.unknowns.includes('ARTIFACT_HASH_MISMATCH'), true);
  assert.equal(receipt.native.phase, 'paused'); assert.equal(receipt.native.completedObserved, true);
  assert.equal(receipt.stopAction.kind, 'pause');
  assertBoundedCoreValidationReceipt(receipt);
});
