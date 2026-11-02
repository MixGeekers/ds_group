import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { SHIYU_EVENT_TYPES, type EventPrincipal, type EventTypeDefinition } from '../src/contracts/events.js';
import type { TaskExecutionPlan, TaskRuntimeIdentity, TaskUsageObservation } from '../src/adapters/control-store/task-domain.js';
import { syntheticLocalNoteBinding, observeSyntheticLocalNote } from './helpers/capability.js';

const identity: TaskRuntimeIdentity = { hostEpoch: 'synthetic-host-1', installationGeneration: 'synthetic-install-1' };
const observer: EventPrincipal = { principalId: 'local-owner-observer', kind: 'component', scopes: ['local-owner'], publishTypes: [], subscribeTypes: ['task.succeeded'], targetRefs: [] };
const hasCode = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
async function fixture(t: TestContext, config: { identity?: TaskRuntimeIdentity | null; types?: EventTypeDefinition[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-task-domain-'));
  const stores: ControlStore[] = [];
  const open = async (runtimeIdentity: TaskRuntimeIdentity | null = config.identity === undefined ? identity : config.identity) => {
    const store = await ControlStore.open({ filename: join(directory, 'control.sqlite'), eventTypes: config.types ?? SHIYU_EVENT_TYPES,
      componentHandlers: [], ...(runtimeIdentity ? { runtimeIdentity, localNoteBinding: syntheticLocalNoteBinding(runtimeIdentity.installationGeneration) } : {}) });
    stores.push(store);
    if (runtimeIdentity) await observeSyntheticLocalNote(store, runtimeIdentity);
    return store;
  };
  t.after(async () => { await Promise.all(stores.map(store => store.close())); await rm(directory, { recursive: true, force: true }); });
  return { store: await open(), open, filename: join(directory, 'control.sqlite') };
}
async function running(store: ControlStore, requestId = 'synthetic-request'): Promise<TaskExecutionPlan> {
  const detail = await store.request('task.createLocal', { requestId, title: 'Synthetic bounded local note', content: 'synthetic local artifact\n' });
  const plan = await store.request('task.claimAssignment', { taskId: detail.task.taskId, leaseMs: 180000 });
  await store.request('task.bindAssignment', { permit: plan.permit, sessionId: `synthetic-local-${plan.assignmentId}` });
  await store.request('task.assignmentStarted', { permit: plan.permit });
  return plan;
}
/** This test double supplies deterministic read-back facts; it performs no host/model/device operation. */
async function observedArtifact(store: ControlStore, plan: TaskExecutionPlan) {
  const prepared = await store.request('task.enqueueArtifact', { permit: plan.permit, content: plan.content });
  const claim = await store.request('task.claimEffect', { permit: plan.permit, effectId: prepared.effect.effectId, leaseMs: 120000 });
  assert.ok(claim);
  const dispatch = await store.request('task.assertEffect', { permit: plan.permit, claim });
  assert.equal(dispatch.payload.content, plan.content);
  const receipt = await store.request('task.recordArtifactReceipt', { permit: plan.permit, claim, observedSha256: plan.expectedSha256,
    observedBytes: Buffer.byteLength(plan.content), receiptId: `synthetic-receipt:${plan.assignmentId}`, observedAt: new Date().toISOString() });
  assert.equal(receipt.status, 'succeeded');
  return { prepared, claim, receipt };
}

test('task IPC is disabled without an explicit trusted runtime identity', async t => {
  const { store } = await fixture(t, { identity: null });
  await assert.rejects(store.request('task.createLocal', { requestId: 'blocked', title: 'not created', content: 'x' }), hasCode('TASKS_UNAVAILABLE'));
  assert.ok((await store.info()).workerThreadId > 0);
});

test('owner admission is bounded, idempotent and atomically reserves the compound task budget', async t => {
  const { store } = await fixture(t);
  const input = { requestId: 'one-request', title: 'Synthetic note', content: 'payload' };
  const first = await store.request('task.createLocal', input);
  const duplicate = await store.request('task.createLocal', input);
  assert.equal(first.task.taskId, duplicate.task.taskId);
  assert.equal(first.task.state, 'queued');
  assert.equal(first.execution!.state, 'pending');
  assert.equal(first.artifact.artifactRef, `artifact:${first.task.taskId}`);
  assert.equal(first.task.completionSpec.checks[0].expected, first.artifact.expectedSha256);
  assert.deepEqual(first.reservation!.amount, { tokens: 16384, calls: 2, effects: 1 });
  assert.equal(first.reservation!.action, 'task.local-note.execute');
  assert.deepEqual(first.effects, []);
  await assert.rejects(store.request('task.createLocal', { ...input, content: 'changed' }), hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(store.request('task.createLocal', { ...input, requestId: 'oversized', content: '识'.repeat(342) }), hasCode('INVALID_TASK_INPUT'));
  await assert.rejects(store.request('task.createLocal', { ...input, requestId: 'forged', principal: { kind: 'owner' } } as never), hasCode('INVALID_TASK_INPUT'));
  assert.equal((await store.request('task.list', {})).length, 1);
  const claims = await Promise.allSettled(Array.from({ length: 20 }, () => store.request('task.claimAssignment', { taskId: first.task.taskId })));
  assert.equal(claims.filter(value => value.status === 'fulfilled').length, 1);
});

test('only independent artifact evidence followed by verification publishes a task success', async t => {
  const { store, filename } = await fixture(t);
  const plan = await running(store);
  await assert.rejects(store.request('task.report', { permit: plan.permit, state: 'ready', summary: 'model claims success without evidence' }), hasCode('EVIDENCE_REQUIRED'));
  await assert.rejects(store.request('task.enqueueArtifact', { permit: plan.permit, content: 'unapproved content' }), hasCode('ARTIFACT_CONTENT_MISMATCH'));
  const { receipt } = await observedArtifact(store, plan);
  // Current native pi input excludes cached input; the host total includes it.
  const usage = { status: 'reported' as const, inputTokens: 100, outputTokens: 10, totalTokens: 190, cacheReadTokens: 80, cacheWriteTokens: 0 };
  const settled = await store.request('task.settleUsage', { permit: plan.permit, usage, calls: 2 });
  assert.equal(settled.state, 'settled');
  assert.equal(settled.observed.tokens, 190);
  assert.equal((await store.request('task.settleUsage', { permit: plan.permit, usage, calls: 2 })).state, 'settled');
  await assert.rejects(store.request('task.checkPermit', { permit: plan.permit }), hasCode('BUDGET_UNAVAILABLE'));
  const ready = await store.request('task.report', { permit: plan.permit, state: 'ready', summary: 'synthetic candidate with independently observed artifact' });
  assert.equal(ready.state, 'waiting');
  assert.equal(ready.waitReason, 'completion_verification');
  assert.deepEqual(ready.result!.effectRefs, [receipt.effectId]);
  assert.deepEqual(await store.request('listEvents', { principal: observer }), []);
  const verified = await store.request('task.verify', { taskId: plan.taskId });
  assert.equal(verified.state, 'succeeded');
  assert.equal(verified.verification!.verifierVersion, 'local-artifact-sha256-v1');
  await store.request('task.verify', { taskId: plan.taskId });
  const facts = await store.request('listEvents', { principal: observer });
  assert.equal(facts.length, 1); assert.equal(facts[0].payload.taskId, plan.taskId);
  await assert.rejects(store.request('task.enqueueArtifact', { permit: plan.permit, content: plan.content }), hasCode('STALE_FENCE'));
  await store.close();
  const evidence = new DatabaseSync(filename, { readOnly: true });
  try {
    const saved = JSON.parse(String(evidence.prepare('SELECT value FROM shiyu_task_usage_observations WHERE reservation_id=?').get(plan.permit.reservationId)!.value));
    assert.equal(saved.observation.usage.cacheReadTokens, 80);
    assert.equal(saved.observation.usage.cacheWriteTokens, 0);
    assert.equal(saved.reservation.observed.tokens, 190);
    assert.deepEqual(saved.accounting, { basis: 'host_total', tokens: 190 });
  } finally { evidence.close(); }
});

test('native totals take precedence; absent totals require every disjoint pi component and known calls', async t => {
  const { store, filename } = await fixture(t);
  const cases: { name: string; usage: TaskUsageObservation['usage']; calls: number | null; tokens?: number; basis: string }[] = [
    { name: 'host-total', usage: { status: 'reported', totalTokens: 205, inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0 }, calls: 2, tokens: 205, basis: 'host_total' },
    { name: 'explicit-components', usage: { status: 'reported', inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 4 }, calls: 2, tokens: 194, basis: 'pi_disjoint_components' },
    { name: 'explicit-zero-caches', usage: { status: 'reported', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, calls: 2, tokens: 110, basis: 'pi_disjoint_components' },
    { name: 'missing-both-caches', usage: { status: 'reported', inputTokens: 100, outputTokens: 10 }, calls: 2, basis: 'unknown' },
    { name: 'missing-write-cache', usage: { status: 'reported', inputTokens: 100, outputTokens: 10, cacheReadTokens: 80 }, calls: 2, basis: 'unknown' },
    { name: 'missing-read-cache', usage: { status: 'reported', inputTokens: 100, outputTokens: 10, cacheWriteTokens: 0 }, calls: 2, basis: 'unknown' },
    { name: 'incomplete-aggregate', usage: { status: 'unknown', totalTokens: 190, inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0 }, calls: 2, basis: 'unknown' },
    { name: 'unknown-calls', usage: { status: 'reported', totalTokens: 190 }, calls: null, tokens: 190, basis: 'host_total' },
  ];
  const reservations: { id: string; sample: typeof cases[number] }[] = [];
  for (const sample of cases) {
    const plan = await running(store, sample.name);
    const input = { permit: plan.permit, usage: sample.usage, calls: sample.calls };
    const result = await store.request('task.settleUsage', input);
    const complete = sample.tokens !== undefined && sample.calls !== null;
    assert.equal(result.state, complete ? 'settled' : 'unknown', sample.name);
    assert.equal(result.observed.tokens, sample.tokens, sample.name);
    assert.equal(result.observed.calls, sample.calls ?? undefined, sample.name);
    assert.deepEqual(result.amount, { tokens: 16384, calls: 2, effects: 1 });
    assert.deepEqual(await store.request('task.settleUsage', input), result);
    reservations.push({ id: plan.permit.reservationId, sample });
  }
  await store.close();
  const evidence = new DatabaseSync(filename, { readOnly: true });
  try {
    for (const { id, sample } of reservations) {
      const saved = JSON.parse(String(evidence.prepare('SELECT value FROM shiyu_task_usage_observations WHERE reservation_id=?').get(id)!.value));
      assert.deepEqual(saved.observation.usage, sample.usage);
      assert.equal(saved.observation.calls, sample.calls);
      assert.equal(saved.accounting.basis, sample.basis);
      assert.equal(saved.accounting.tokens, sample.tokens);
    }
  } finally { evidence.close(); }
});

test('independent usage reconciliation retains unknown dimensions until a complete native observation arrives', async t => {
  const { store, filename } = await fixture(t);
  const plan = await running(store);
  const base = { taskId: plan.taskId, assignmentId: plan.assignmentId, oldExecutionStopped: true as const, evidenceRef: 'synthetic-native-accounting-readback' };
  await store.request('task.markUnknown', { taskId: plan.taskId, reason: 'synthetic incomplete worker telemetry' });
  const absentCaches = await store.request('task.reconcileUsage', { ...base, receiptId: 'missing-cache-fields', usage: { status: 'reported', inputTokens: 100, outputTokens: 10 }, calls: 2 });
  assert.equal(absentCaches.state, 'unknown');
  assert.equal(absentCaches.observed.tokens, undefined);
  const usage = { status: 'reported' as const, inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, totalTokens: 190 };
  const unknownCalls = await store.request('task.reconcileUsage', { ...base, receiptId: 'unknown-native-calls', usage, calls: null });
  assert.equal(unknownCalls.state, 'unknown');
  assert.equal(unknownCalls.observed.tokens, 190);
  const settledInput = { ...base, receiptId: 'complete-native-usage', usage, calls: 2 };
  const settled = await store.request('task.reconcileUsage', settledInput);
  assert.equal(settled.state, 'settled');
  assert.deepEqual(settled.observed, { tokens: 190, calls: 2, effects: 0 });
  assert.deepEqual(await store.request('task.reconcileUsage', settledInput), settled);
  await assert.rejects(store.request('task.reconcileUsage', { ...settledInput, calls: 1 }), hasCode('IDEMPOTENCY_CONFLICT'));
  assert.equal((await store.request('task.get', { taskId: plan.taskId })).task.state, 'unknown');
  await store.close();
  const evidence = new DatabaseSync(filename, { readOnly: true });
  try {
    const saved = JSON.parse(String(evidence.prepare('SELECT value FROM shiyu_task_usage_reconciliations WHERE receipt_id=?').get(settledInput.receiptId)!.value));
    assert.deepEqual(saved.observation.usage, usage);
    assert.deepEqual(saved.accounting, { basis: 'host_total', tokens: 190 });
  } finally { evidence.close(); }
});

test('malformed native counters cannot settle a budget; reported totals still enforce its limit', async t => {
  const { store } = await fixture(t);
  const plan = await running(store);
  for (const usage of [{ status: 'reported', totalTokens: -1 }, { status: 'reported', totalTokens: 190, cacheReadTokens: 0.5 }]) {
    await assert.rejects(store.request('task.settleUsage', { permit: plan.permit, usage, calls: 2 } as never), hasCode('INVALID_TASK_INPUT'));
  }
  await assert.rejects(store.request('task.settleUsage', { permit: plan.permit, usage: { status: 'reported', totalTokens: 190 }, calls: undefined } as never), hasCode('INVALID_TASK_INPUT'));
  const overrun = await store.request('task.settleUsage', { permit: plan.permit, usage: { status: 'reported', inputTokens: 100, outputTokens: 10, totalTokens: 17000 }, calls: 2 });
  assert.equal(overrun.observed.tokens, 17000);
  assert.equal(overrun.overrun, true);
  await assert.rejects(store.request('task.createLocal', { requestId: 'after-overrun', title: 'Rejected after budget overrun', content: 'x' }), hasCode('BUDGET_OVERRUN'));
});

test('bounded native observations preserve partial per-call cache evidence without changing aggregate accounting', async t => {
  const { store, filename } = await fixture(t);
  const plan = await running(store);
  const input = { permit: plan.permit, usage: { status: 'reported' as const, totalTokens: 190 }, calls: 2 };
  const invalid: unknown[] = [
    null,
    Array.from({ length: 101 }, () => ({ type: 'assistant/message' })),
    [{ type: 'tool/result' }],
    [{ type: 'compaction/' }],
    [{ type: 'assistant/message', text: 'model text must never be accepted' }],
    [{ type: 'assistant/message', seq: -1 }],
    [{ type: 'assistant/message', seq: 0.5 }],
    [{ type: 'assistant/message', seq: Number.MAX_SAFE_INTEGER + 1 }],
    [{ type: 'assistant/message', usage: { status: 'reported' } }],
    [{ type: 'assistant/message', usage: { totalTokens: -1 } }],
    [{ type: 'assistant/message', usage: { cacheReadTokens: Infinity } }],
    [{ type: 'assistant/message', usage: { cacheWriteTokens: 0.5 } }],
    [{ type: 'assistant/message', usage: { inputTokens: 1, outputTokens: 2, prompt: 'not accounting data' } }],
  ];
  for (const nativeObservations of invalid) {
    await assert.rejects(store.request('task.settleUsage', { ...input, nativeObservations } as never), hasCode('INVALID_TASK_INPUT'));
  }
  const nativeObservations: NonNullable<TaskUsageObservation['nativeObservations']> = [
    { type: 'assistant/message', seq: 1, usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 } },
    { type: 'assistant/message', seq: 2, usage: { inputTokens: 0, outputTokens: 5, totalTokens: 85, cacheReadTokens: 80 } },
    { type: 'assistant/attempt', seq: 3, usage: { outputTokens: 2 } },
    { type: 'compaction/start', seq: 4 },
    { type: 'compaction/summary', seq: 5, usage: { totalTokens: 7 } },
    { type: 'session/title-llm-request', seq: 6 },
    ...Array.from({ length: 94 }, (_, index) => ({ type: 'compaction/end', seq: 7 + index })),
  ];
  // These records are evidence only: aggregate completeness belongs to the trusted native driver.
  const observedInput = { ...input, nativeObservations };
  const result = await store.request('task.settleUsage', observedInput);
  assert.equal(result.state, 'settled');
  assert.equal(result.observed.tokens, 190);
  assert.deepEqual(await store.request('task.settleUsage', observedInput), result);
  await assert.rejects(store.request('task.settleUsage', { ...input, nativeObservations: nativeObservations.slice(1) }), hasCode('IDEMPOTENCY_CONFLICT'));
  await store.close();
  const evidence = new DatabaseSync(filename, { readOnly: true });
  try {
    const saved = JSON.parse(String(evidence.prepare('SELECT value FROM shiyu_task_usage_observations WHERE reservation_id=?').get(plan.permit.reservationId)!.value));
    assert.deepEqual(saved.observation.nativeObservations, nativeObservations);
    assert.equal(saved.observation.nativeObservations[0].usage.cacheReadTokens, undefined);
    assert.equal(saved.observation.nativeObservations[1].usage.cacheReadTokens, 80);
    assert.deepEqual(saved.accounting, { basis: 'host_total', tokens: 190 });
  } finally { evidence.close(); }
});

test('task completion and its durable event roll back together if the completion event cannot be accepted', async t => {
  const { store } = await fixture(t, { types: SHIYU_EVENT_TYPES.filter(type => type.type !== 'task.succeeded') });
  const plan = await running(store);
  await observedArtifact(store, plan);
  await store.request('task.report', { permit: plan.permit, state: 'ready', summary: 'synthetic candidate' });
  await assert.rejects(store.request('task.verify', { taskId: plan.taskId }), hasCode('UNKNOWN_TYPE'));
  const detail = await store.request('task.get', { taskId: plan.taskId });
  assert.equal(detail.task.state, 'waiting');
  assert.equal(detail.task.verification, undefined);
  assert.equal(detail.effects[0].status, 'succeeded');
});

test('reload preserves unknown execution and effect facts without granting another dispatch', async t => {
  const first = await fixture(t);
  const plan = await running(first.store);
  const { effect } = await first.store.request('task.enqueueArtifact', { permit: plan.permit, content: plan.content });
  const claim = await first.store.request('task.claimEffect', { permit: plan.permit, effectId: effect.effectId });
  assert.ok(claim);
  await first.store.close();
  const reopened = await first.open({ ...identity, hostEpoch: 'synthetic-host-2' });
  const recovered = await reopened.request('task.get', { taskId: plan.taskId });
  assert.equal(recovered.task.state, 'unknown');
  assert.equal(recovered.execution!.state, 'unknown');
  assert.equal(recovered.effects[0].status, 'unknown');
  assert.equal(recovered.effects[0].attempts, 1);
  assert.equal(recovered.effects[0].payloadHash, effect.payloadHash);
  assert.equal(recovered.reservation!.state, 'unknown');
  assert.deepEqual(recovered.reservation!.amount, { tokens: 16384, calls: 2, effects: 1 });
  await assert.rejects(reopened.request('task.checkPermit', { permit: plan.permit }), hasCode('STALE_FENCE'));
  await assert.rejects(reopened.request('task.claimAssignment', { taskId: plan.taskId }), hasCode('TASK_NOT_DISPATCHABLE'));
  await assert.rejects(reopened.request('task.verify', { taskId: plan.taskId }), hasCode('RESULT_UNKNOWN'));
});

test('pause fences the old assignment even after resume; a fresh queued task keeps its original identity', async t => {
  const { store } = await fixture(t);
  const plan = await running(store);
  const queued = await store.request('task.createLocal', { requestId: 'queued', title: 'Never started', content: 'queued note' });
  await store.request('task.setPaused', { paused: true });
  await assert.rejects(store.request('task.checkPermit', { permit: plan.permit }), hasCode('TASK_PAUSED'));
  await assert.rejects(store.request('task.claimAssignment', { taskId: queued.task.taskId }), hasCode('TASK_PAUSED'));
  await store.request('task.setPaused', { paused: false });
  await assert.rejects(store.request('task.checkPermit', { permit: plan.permit }), hasCode('STALE_FENCE'));
  assert.equal((await store.request('task.get', { taskId: plan.taskId })).task.state, 'unknown');
  const next = await store.request('task.claimAssignment', { taskId: queued.task.taskId });
  assert.equal(next.taskId, queued.task.taskId);
  assert.ok(next.permit.fencingToken > plan.permit.fencingToken);
});

test('partial usage stays held while same-assignment result facts can still be verified', async t => {
  const { store } = await fixture(t);
  const plan = await running(store);
  await observedArtifact(store, plan);
  const usage = await store.request('task.settleUsage', { permit: plan.permit, usage: { status: 'unknown' }, calls: 2 });
  assert.equal(usage.state, 'unknown');
  await assert.rejects(store.request('task.checkPermit', { permit: plan.permit }), hasCode('BUDGET_UNAVAILABLE'));
  await store.request('task.report', { permit: plan.permit, state: 'ready', summary: 'artifact is observed; token telemetry is incomplete' });
  assert.equal((await store.request('task.verify', { taskId: plan.taskId })).state, 'succeeded');
  assert.equal((await store.request('task.get', { taskId: plan.taskId })).reservation!.state, 'unknown');
});

test('cancellation invalidates pending intents and cannot claim that unknown effects were cancelled', async t => {
  const { store } = await fixture(t);
  const plan = await running(store, 'cancelled');
  await store.request('task.enqueueArtifact', { permit: plan.permit, content: plan.content });
  const requested = await store.request('task.cancel', { taskId: plan.taskId, reason: 'synthetic owner cancellation' });
  assert.equal(requested.stopRequested, true);
  assert.equal((await store.request('task.get', { taskId: plan.taskId })).effects[0].status, 'cancelled');
  const cancelled = await store.request('task.confirmCancelled', { taskId: plan.taskId, proof: { assignmentId: plan.assignmentId, oldExecutionStopped: true,
    effectsKnown: true, pendingIntentsInvalidated: true, evidenceRefs: ['synthetic-stop-evidence'] } });
  assert.equal(cancelled.state, 'cancelled');
  const uncertain = await running(store, 'unknown');
  const { effect } = await store.request('task.enqueueArtifact', { permit: uncertain.permit, content: uncertain.content });
  await store.request('task.claimEffect', { permit: uncertain.permit, effectId: effect.effectId });
  await store.request('task.markUnknown', { taskId: uncertain.taskId, reason: 'synthetic transport break after dispatch' });
  await store.request('task.cancel', { taskId: uncertain.taskId, reason: 'owner cancel while effect unknown' });
  await assert.rejects(store.request('task.confirmCancelled', { taskId: uncertain.taskId, proof: { assignmentId: uncertain.assignmentId, oldExecutionStopped: true,
    effectsKnown: true, pendingIntentsInvalidated: true, evidenceRefs: ['assertion without effect reconciliation'] } }), hasCode('RECONCILIATION_REQUIRED'));
  assert.equal((await store.request('task.get', { taskId: uncertain.taskId })).task.state, 'unknown');
});

test('an owner can explicitly recover a never-started old assignment only after independent zero-usage reconciliation', async t => {
  const first = await fixture(t);
  const detail = await first.store.request('task.createLocal', { requestId: 'unstarted-recovery', title: 'Never started', content: 'synthetic note' });
  const oldAssignmentId = detail.task.latestAssignmentId!;
  await first.store.close();
  const reopened = await first.open({ ...identity, hostEpoch: 'recovery-host' });
  const proof = { assignmentId: oldAssignmentId, oldExecutionStopped: true as const, effectsKnown: true as const, evidenceRefs: ['synthetic-no-native-session-or-effect'] };
  await assert.rejects(reopened.request('task.recover', { taskId: detail.task.taskId, proof }), hasCode('RECONCILIATION_REQUIRED'));
  const zeroUsage = { taskId: detail.task.taskId, assignmentId: oldAssignmentId, receiptId: 'synthetic-zero-usage', oldExecutionStopped: true as const,
    evidenceRef: 'synthetic-native-registry-empty', usage: { status: 'reported' as const, totalTokens: 0 }, calls: 0 };
  const settled = await reopened.request('task.reconcileUsage', zeroUsage);
  assert.deepEqual(await reopened.request('task.reconcileUsage', zeroUsage), settled);
  await assert.rejects(reopened.request('task.reconcileUsage', { ...zeroUsage, calls: 1 }), hasCode('IDEMPOTENCY_CONFLICT'));
  const recovered = await reopened.request('task.recover', { taskId: detail.task.taskId, proof });
  assert.equal(recovered.state, 'queued');
  assert.notEqual(recovered.latestAssignmentId, oldAssignmentId);
  const plan = await reopened.request('task.claimAssignment', { taskId: recovered.taskId });
  assert.equal(plan.assignmentId, recovered.latestAssignmentId);
});
