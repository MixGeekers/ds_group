import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { CapabilityDomain } from '../src/adapters/control-store/capability-domain.js';
import { TaskDomain, type TaskCommands, type TaskDomainRequest } from '../src/adapters/control-store/task-domain.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import type { CapabilitySnapshot, CapabilityTaskEvidence } from '../src/contracts/capability.js';

const owner = { principalId: 'local-owner', kind: 'owner' as const, scopes: ['local-owner'] };
const identity = { hostEpoch: 'matrix-host', installationGeneration: 'matrix-install' };
const binding = { installationGeneration: identity.installationGeneration, definitionDigest: 'd'.repeat(64), environmentFingerprint: 'e'.repeat(64) };
const observedAt = '2026-11-02T12:00:00.000Z';
const hasCode = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shiyu-capability-matrix-')), db = new DatabaseSync(join(directory, 'control.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx);
  const tasks = new TaskDomain(db, tx, { runtimeIdentity: identity, now: () => new Date(observedAt) });
  let syntheticProof: CapabilityTaskEvidence | undefined;
  // This fixed synchronous source simulates already checked historical metadata.
  // It is deliberately not a real successful Task, independent artifact proof,
  // native host validation, or permission for the Task being claimed below.
  const ability = new CapabilityDomain(db, tx, { runtimeIdentity: identity, binding, now: () => new Date(observedAt),
    taskEvidence: taskId => taskId === syntheticProof?.taskId ? syntheticProof : undefined });
  tasks.setCapabilityAuthority(ability);
  const command = <K extends keyof TaskCommands>(name: K, args: TaskCommands[K]['input']): TaskCommands[K]['output'] =>
    tasks.execute({ command: name, args } as TaskDomainRequest) as TaskCommands[K]['output'];
  let observation = 0;
  const observe = (status: CapabilitySnapshot['availability']) => ability.observeLocalNote({ requestId: `matrix-observation:${++observation}`,
    expectedRevision: ability.snapshot().revision, hostEpoch: identity.hostEpoch, binding, status, reasonCode: `MATRIX_${status.toUpperCase()}` });
  observe('available');
  const task = command('task.createLocal', { requestId: 'matrix-task', title: 'Synthetic authority matrix', content: 'Fixed local-only fixture note.' });
  const addSyntheticProof = () => {
    syntheticProof = { taskId: 'historical-synthetic-proof-task', taskVersion: 8, assignmentId: 'historical-synthetic-assignment',
      effectId: 'historical-synthetic-effect', receiptId: 'historical-synthetic-receipt', observedAt, capabilityRef: ability.requireCurrent() };
    assert.equal(ability.recordSuccessfulTask(syntheticProof.taskId).recorded, true);
  };
  return { db, watermark, tasks, ability, command, observe, task, addSyntheticProof };
}

for (const enabled of [false, true]) for (const availability of ['unknown', 'unavailable', 'available'] as const)
  for (const proof of ['unknown', 'verified'] as const) for (const mandate of ['active', 'revoked'] as const) {
    test(`independent authorities: enabled=${enabled}, availability=${availability}, proof=${proof}, Task Mandate=${mandate}`, t => {
      const f = fixture(t);
      if (proof === 'verified') f.addSyntheticProof();
      f.observe(availability);
      f.ability.setEnabled({ requestId: 'matrix-enabled', expectedRevision: f.ability.snapshot().revision, enabled });
      const grant = f.tasks.mandates.get(owner, f.task.task.mandateId);
      if (mandate === 'revoked') f.tasks.mandates.revoke(owner, { mandateId: grant.mandateId, expectedVersion: grant.version });

      const capability = f.ability.snapshot(), before = f.watermark.read(), pending = f.tasks.get(f.task.task.taskId);
      assert.equal(capability.declared, true);
      assert.equal(capability.enabled, enabled); assert.equal(capability.availability, availability); assert.equal(capability.verification, proof);
      assert.equal(capability.usableForAuthorizedTask, enabled && availability === 'available');
      assert.equal(capability.reasonCode, enabled ? `MATRIX_${availability.toUpperCase()}` : 'CAPABILITY_DISABLED');
      assert.equal(capability.evidenceRefs.length, proof === 'verified' ? 4 : 0);
      assert.equal(f.tasks.mandates.get(owner, grant.mandateId).state, mandate);

      if (enabled && availability === 'available') {
        // Capability readiness remains true even if the independent original
        // owner grant is revoked. Only Task can decide whether to claim work.
        assert.deepEqual(f.ability.requireCurrent(), f.ability.captureForCore().ref);
        if (mandate === 'active') {
          const plan = f.command('task.claimAssignment', { taskId: f.task.task.taskId });
          f.command('task.checkPermit', { permit: plan.permit });
          assert.equal(f.tasks.get(plan.taskId).execution?.state, 'claimed');
          assert.deepEqual(f.tasks.get(plan.taskId).capabilityRef, f.ability.requireCurrent());
          assert.equal(f.watermark.read().commitSeq, before.commitSeq + 1);
        } else {
          assert.throws(() => f.command('task.claimAssignment', { taskId: f.task.task.taskId }), hasCode('REVOKED'));
          assert.deepEqual(f.tasks.get(f.task.task.taskId), pending);
          assert.deepEqual(f.watermark.read(), before);
        }
      } else {
        assert.throws(() => f.ability.requireCurrent(), hasCode('CAPABILITY_UNAVAILABLE'));
        assert.throws(() => f.command('task.claimAssignment', { taskId: f.task.task.taskId }), hasCode('CAPABILITY_UNAVAILABLE'));
        assert.deepEqual(f.tasks.get(f.task.task.taskId), pending);
        assert.deepEqual(f.watermark.read(), before);
      }
      // Claiming does not execute a model, create an Effect or independently
      // validate the synthetic proof. These remain separately testable facts.
      assert.deepEqual(f.ability.snapshot(), capability);
      assert.equal(f.tasks.inspectCapabilityEvidence(f.task.task.taskId), undefined);
      assert.equal(f.db.prepare('SELECT count(*) n FROM shiyu_effects').get()!.n, 0);
      assert.equal(f.db.prepare('SELECT count(*) n FROM shiyu_task_usage_observations').get()!.n, 0);
      assert.equal(f.db.prepare('SELECT count(*) n FROM shiyu_task_artifact_observations').get()!.n, 0);
      assert.equal(f.db.prepare('SELECT count(*) n FROM shiyu_task_runs WHERE json_extract(value,\'$.sessionId\') IS NOT NULL').get()!.n, 0);
    });
  }
