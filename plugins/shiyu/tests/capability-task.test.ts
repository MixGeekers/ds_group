import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { TaskDomain, type TaskCommands, type TaskDomainRequest, type TaskExecutionPlan } from '../src/adapters/control-store/task-domain.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { CapabilityError, type CapabilityAuthorityPort, type CapabilityRef } from '../src/contracts/capability.js';
import type { CoreTaskDelegation } from '../src/contracts/core.js';
import type { EffectClaim } from '../src/control/effects/index.js';

const owner = { principalId: 'local-owner', kind: 'owner' as const, scopes: ['local-owner'] };
const identity = { hostEpoch: 'cap-task-host', installationGeneration: 'cap-task-install' };
const hasCode = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
/** This mutable synchronous port is a Task boundary fixture, not capability/host proof.
 * Real CapabilityDomain + Worker + filesystem success is covered by task-runner.test.ts. */
async function fixture(t: TestContext, install = true) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-cap-task-'));
  const db = new DatabaseSync(join(directory, 'control.sqlite')), tx = new SqliteTransactions(db);
  const state = { available: true, ref: { capabilityId: 'task.local-note.execute', authorityId: 'cap-task-authority', safetyRevision: 1,
    definitionDigest: 'd'.repeat(64), installationGeneration: identity.installationGeneration, environmentFingerprint: 'e'.repeat(64) } as CapabilityRef };
  const port: Pick<CapabilityAuthorityPort, 'requireCurrent' | 'assertCurrent'> = {
    requireCurrent() { if (!state.available) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'Synthetic capability unavailable'); return structuredClone(state.ref); },
    assertCurrent(ref) { if (!state.available) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'Synthetic capability unavailable');
      if (JSON.stringify(ref) !== JSON.stringify(state.ref)) throw new CapabilityError('STALE_CAPABILITY', 'Synthetic capability binding changed'); },
  };
  const successes: string[] = [];
  const domain = new TaskDomain(db, tx, { runtimeIdentity: identity, onSucceeded: id => successes.push(id) });
  if (install) domain.setCapabilityAuthority(port);
  const command = <K extends keyof TaskCommands>(name: K, args: TaskCommands[K]['input']): TaskCommands[K]['output'] =>
    domain.execute({ command: name, args } as TaskDomainRequest) as TaskCommands[K]['output'];
  const create = (requestId = 'one') => command('task.createLocal', { requestId, title: 'Synthetic capability task', content: 'fixed synthetic note' });
  const editLocal = (taskId: string, change: (local: Record<string, any>) => void) => tx.atomic(() => {
    const row = db.prepare('SELECT value FROM shiyu_task_local_inputs WHERE task_id=?').get(taskId)!;
    const value = JSON.parse(String(row.value)); change(value);
    db.prepare('UPDATE shiyu_task_local_inputs SET value=? WHERE task_id=?').run(JSON.stringify(value), taskId);
  });
  const start = (taskId = create().task.taskId) => {
    const plan = command('task.claimAssignment', { taskId });
    command('task.bindAssignment', { permit: plan.permit, sessionId: 'synthetic-cap-task-session' });
    command('task.assignmentStarted', { permit: plan.permit }); return plan;
  };
  const dispatch = (plan: TaskExecutionPlan) => {
    const intent = command('task.enqueueArtifact', { permit: plan.permit, content: plan.content });
    const claim = command('task.claimEffect', { permit: plan.permit, effectId: intent.effect.effectId })!;
    assert.ok(claim); command('task.assertEffect', { permit: plan.permit, claim }); return claim;
  };
  const receipt = (plan: TaskExecutionPlan, claim: EffectClaim) => command('task.recordArtifactReceipt', { permit: plan.permit, claim,
    observedSha256: plan.expectedSha256, observedBytes: Buffer.byteLength(plan.content), observedAt: new Date().toISOString(), receiptId: 'synthetic-artifact-receipt' });
  const finish = (plan: TaskExecutionPlan) => {
    command('task.settleUsage', { permit: plan.permit, usage: { status: 'reported', totalTokens: 10 }, calls: 1 });
    command('task.report', { permit: plan.permit, state: 'ready', summary: 'Synthetic candidate only' });
    return command('task.verify', { taskId: plan.taskId });
  };
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  return { db, tx, domain, state, port, command, create, editLocal, start, dispatch, receipt, finish, successes };
}

test('both new admissions require a trusted capability port and cannot inject one through task arguments', async t => {
  const f = await fixture(t, false);
  assert.throws(() => f.create(), hasCode('CAPABILITY_AUTHORITY_REQUIRED'));
  f.domain.setCoreAuthority(() => ({ goalId: 'core-synthetic', deliverableId: 'note', title: 'Synthetic', content: 'note', resourceRef: 'deliverable:note',
    subjectId: 'core:synthetic', mandateId: 'missing-grant', mandateVersion: 1, authEpoch: 1, sourceRefs: [], capabilityRef: f.state.ref }));
  assert.throws(() => f.domain.admitCoreIntent({ goalId: 'core-synthetic', deliverableId: 'note', proposalId: 'proposal' }), hasCode('CAPABILITY_AUTHORITY_REQUIRED'));
  assert.equal(f.command('task.list', {}).length, 0);
  f.domain.setCapabilityAuthority(f.port);
  assert.throws(() => f.command('task.createLocal', { requestId: 'forged', title: 'x', content: 'x', capabilityRef: f.state.ref } as never), hasCode('INVALID_TASK_INPUT'));
  assert.throws(() => f.domain.setCapabilityAuthority(f.port), hasCode('CAPABILITY_AUTHORITY_INSTALLED'));
});

test('owner admission persists the authority ref and unavailable admission creates no task or allowance', async t => {
  const f = await fixture(t); f.state.available = false;
  assert.throws(() => f.create(), hasCode('CAPABILITY_UNAVAILABLE'));
  assert.equal(f.command('task.list', {}).length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM shiyu_budget_reservations').get()!.n, 0);
  f.state.available = true; const detail = f.create();
  assert.deepEqual(detail.capabilityRef, f.state.ref);
  f.state.available = false;
  assert.equal(f.create().task.taskId, detail.task.taskId); // Existing intent is an immutable read.
  assert.throws(() => f.command('task.claimAssignment', { taskId: detail.task.taskId }), hasCode('CAPABILITY_UNAVAILABLE'));
  assert.equal(f.command('task.get', { taskId: detail.task.taskId }).execution?.state, 'pending');
});

test('never-claimed tasks may refresh safety revision but cannot silently upgrade implementation or environment', async t => {
  const f = await fixture(t), task = f.create().task;
  f.state.ref.safetyRevision++;
  f.command('task.claimAssignment', { taskId: task.taskId });
  assert.equal(f.domain.get(task.taskId).capabilityRef!.safetyRevision, 2);
  const pending = f.create('second').task;
  f.state.ref.environmentFingerprint = 'f'.repeat(64); f.state.ref.safetyRevision++;
  assert.throws(() => f.command('task.claimAssignment', { taskId: pending.taskId }), hasCode('STALE_CAPABILITY'));
  assert.equal(f.domain.get(pending.taskId).capabilityRef!.environmentFingerprint, 'e'.repeat(64));
  assert.equal(f.domain.get(pending.taskId).execution!.state, 'pending');
});

test('legacy pending binds only at its first claim; claimed work never retrofits a missing ref', async t => {
  const f = await fixture(t), detail = f.create();
  f.editLocal(detail.task.taskId, local => { delete local.capabilityRef; });
  assert.equal(f.domain.get(detail.task.taskId).capabilityRef, undefined);
  const plan = f.command('task.claimAssignment', { taskId: detail.task.taskId });
  assert.deepEqual(f.domain.get(detail.task.taskId).capabilityRef, f.state.ref);
  f.editLocal(detail.task.taskId, local => { delete local.capabilityRef; });
  assert.throws(() => f.command('task.checkPermit', { permit: plan.permit }), hasCode('CAPABILITY_AUTHORITY_REQUIRED'));
  assert.equal(f.domain.get(detail.task.taskId).capabilityRef, undefined);
});

test('failed mandate checks roll back a pending safety-ref refresh atomically', async t => {
  const f = await fixture(t), detail = f.create();
  const grant = f.domain.mandates.get(owner, detail.task.mandateId);
  f.domain.mandates.revoke(owner, { mandateId: grant.mandateId, expectedVersion: grant.version });
  f.state.ref.safetyRevision++;
  assert.throws(() => f.command('task.claimAssignment', { taskId: detail.task.taskId }));
  assert.equal(f.domain.get(detail.task.taskId).capabilityRef!.safetyRevision, 1);
  assert.equal(f.domain.get(detail.task.taskId).execution!.state, 'pending');
});

test('claimed model and final effect gates reject changed or unavailable capability without changing the claim', async t => {
  const f = await fixture(t), plan = f.start(), claim = f.dispatch(plan);
  f.state.available = false;
  assert.throws(() => f.command('task.checkPermit', { permit: plan.permit }), hasCode('CAPABILITY_UNAVAILABLE'));
  assert.throws(() => f.command('task.assertEffect', { permit: plan.permit, claim }), hasCode('CAPABILITY_UNAVAILABLE'));
  f.state.available = true; f.state.ref.safetyRevision++;
  assert.throws(() => f.command('task.assertEffect', { permit: plan.permit, claim }), hasCode('STALE_CAPABILITY'));
  assert.equal(f.domain.get(plan.taskId).effects[0]!.attempts, 1);
  assert.equal(f.domain.get(plan.taskId).capabilityRef!.safetyRevision, 1);
});

test('post-dispatch disable preserves receipt, accounting, completion and independently readable success evidence', async t => {
  const f = await fixture(t), plan = f.start(), claim = f.dispatch(plan);
  assert.equal(f.domain.inspectCapabilityEvidence(plan.taskId), undefined);
  f.state.available = false; f.state.ref.safetyRevision++;
  assert.equal(f.receipt(plan, claim).status, 'succeeded');
  assert.equal(f.finish(plan).state, 'succeeded');
  const evidence = f.domain.inspectCapabilityEvidence(plan.taskId)!;
  assert.equal(evidence.taskId, plan.taskId); assert.equal(evidence.receiptId, 'synthetic-artifact-receipt');
  assert.equal(evidence.capabilityRef.safetyRevision, 1); assert.deepEqual(f.successes, [plan.taskId]);
  f.command('task.verify', { taskId: plan.taskId }); assert.equal(f.successes.length, 1);
  assert.equal(f.domain.get(plan.taskId).task.state, 'succeeded');
  f.editLocal(plan.taskId, local => { delete local.capabilityRef; });
  assert.equal(f.domain.get(plan.taskId).task.state, 'succeeded');
  assert.equal(f.domain.inspectCapabilityEvidence(plan.taskId), undefined); // No invented legacy proof.
});

test('model claims and missing independent artifact observations cannot become capability proof', async t => {
  const f = await fixture(t), plan = f.start();
  assert.throws(() => f.command('task.report', { permit: plan.permit, state: 'ready', summary: 'I verified the capability' }), hasCode('EVIDENCE_REQUIRED'));
  assert.equal(f.domain.inspectCapabilityEvidence(plan.taskId), undefined);
  const claim = f.dispatch(plan); f.receipt(plan, claim); f.finish(plan);
  assert.ok(f.domain.inspectCapabilityEvidence(plan.taskId));
  f.tx.atomic(() => f.db.prepare('DELETE FROM shiyu_task_artifact_observations').run());
  assert.equal(f.domain.inspectCapabilityEvidence(plan.taskId), undefined);
  assert.equal(f.domain.get(plan.taskId).task.state, 'succeeded'); // History is not rewritten by the evidence view.
});

test('core admission uses the exact evaluation ref and shared mandate, never the latest replacement ref', async t => {
  const f = await fixture(t);
  const grant = f.domain.mandates.grant(owner, { id: 'core-grant', scope: 'local-owner', subjectIds: ['core:synthetic'],
    allowedActions: ['task.local-note.execute', 'artifact.write'], allowedResources: ['deliverable:synthetic'],
    limits: { tokens: 32768, calls: 4, effects: 2 }, basisRef: 'synthetic-owner-core', expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const delegation: CoreTaskDelegation = { goalId: 'core-synthetic', deliverableId: 'note', title: 'Synthetic delegated note', content: 'fixed',
    resourceRef: 'deliverable:synthetic', subjectId: 'core:synthetic', mandateId: grant.mandateId, mandateVersion: grant.version, authEpoch: grant.authEpoch,
    sourceRefs: ['goal:synthetic'], capabilityRef: structuredClone(f.state.ref) };
  f.domain.setCoreAuthority(() => structuredClone(delegation));
  f.state.ref.safetyRevision++;
  assert.throws(() => f.domain.admitCoreIntent({ goalId: delegation.goalId, deliverableId: 'note', proposalId: 'old' }), hasCode('STALE_CAPABILITY'));
  assert.equal(f.command('task.list', {}).length, 0);
  delegation.capabilityRef = structuredClone(f.state.ref);
  const detail = f.domain.admitCoreIntent({ goalId: delegation.goalId, deliverableId: 'note', proposalId: 'fresh' });
  assert.equal(detail.task.mandateId, grant.mandateId); assert.deepEqual(detail.capabilityRef, delegation.capabilityRef);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM shiyu_mandates').get()!.n, 1);
});

test('explicit recovered assignments retain known cancelled effects without treating them as a new dispatch', async t => {
  const f = await fixture(t), old = f.start();
  const intent = f.command('task.enqueueArtifact', { permit: old.permit, content: old.content });
  f.domain.effects.cancel(intent.effect.effectId, intent.effect.version, 'synthetic-unused-effect');
  f.command('task.markUnknown', { taskId: old.taskId, reason: 'synthetic stopped worker before any effect claim' });
  const proof = { assignmentId: old.assignmentId, oldExecutionStopped: true as const, effectsKnown: true as const,
    evidenceRefs: ['synthetic-worker-stopped-and-pending-effect-cancelled'] };
  assert.throws(() => f.command('task.recover', { taskId: old.taskId, proof }), hasCode('RECONCILIATION_REQUIRED'));
  f.command('task.reconcileUsage', { taskId: old.taskId, assignmentId: old.assignmentId, receiptId: 'synthetic-unused-usage',
    oldExecutionStopped: true, evidenceRef: 'synthetic-no-primary-entry', usage: { status: 'reported', totalTokens: 0 }, calls: 0 });
  f.state.ref.safetyRevision++;
  const recovered = f.command('task.recover', { taskId: old.taskId, proof });
  const fresh = f.command('task.claimAssignment', { taskId: recovered.taskId });
  assert.notEqual(fresh.assignmentId, old.assignmentId);
  assert.equal(f.domain.get(old.taskId).effects[0]!.status, 'cancelled');
  assert.equal(f.domain.get(old.taskId).effects[0]!.attempts, 0);
  assert.equal(f.domain.get(old.taskId).capabilityRef!.safetyRevision, 2);
  assert.throws(() => f.command('task.checkPermit', { permit: old.permit }));
});
