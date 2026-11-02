/**
 * H5-B1 fault / boundary matrix test.
 *
 * Runs the full synthetic fault matrix (control watermark gaps, Goal Session /
 * projection / object closure gaps, hash mismatches, version incompatibility,
 * capacity starvation, staged interruptions, deletion-ledger branches,
 * tampered bundles, root guards, lock exclusivity, disarm/unknown behaviour)
 * and requires every case to pass. The same runner produces the evidence JSON
 * in `tests/recovery-evidence.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEvidenceMatrix } from './recovery-matrix.js';

test('offline fault/boundary matrix: every case passes and every must-have scenario is covered', async () => {
  const result = await runEvidenceMatrix();
  const failed = result.records.filter((item) => !item.pass);
  assert.deepEqual(failed, [], `matrix failures: ${JSON.stringify(failed, null, 2)}`);
  const requiredCases = [
    'capture.ready',
    'capture.concurrent-writer-boundary',
    'capture.unknown-breakpoints',
    'capture.staging-interrupted',
    'capture.staging-failed-not-ready',
    'capture.missing-commit-watermark',
    'capture.missing-publication-watermark',
    'capture.missing-authorization-watermark',
    'capture.missing-deletion-watermark',
    'capture.missing-goal-session',
    'capture.missing-projection',
    'capture.object-closure-incomplete',
    'capture.hash-mismatch',
    'capture.version-incompatible',
    'capture.capacity-insufficient',
    'capture.failure-preserves-lastgood',
    'capture.goal-tail-mismatch',
    'capture.empty-goal-set',
    'restore.old-deletion-ledger-locked',
    'restore.old-deletion-ledger-replayed',
    'restore.control-tombstone-replay',
    'restore.barrier-unavailable-locked',
    'restore.verified-positive',
    'restore.armed-goal-disarmed',
    'restore.tampered-bundle-rejected',
    'restore.live-root-protected',
    'restore.target-not-isolated',
    'restore.recovery-lock-exclusive',
    'restore.bundle-not-ready',
    'restore.missing-component-manifest',
  ];
  const observed = new Set(result.records.map((item) => item.caseId));
  const missingCases = requiredCases.filter((item) => !observed.has(item));
  assert.deepEqual(missingCases, [], `matrix is missing required cases: ${missingCases.join(',')}`);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.total, result.records.length);
  assert.ok(result.summary.total >= requiredCases.length);
  assert.equal(result.summary.selfProofPassed, result.summary.selfProofTotal);
  assert.ok(result.summary.selfProofTotal >= 15);
  for (const record of result.records) {
    assert.equal(record.evidenceLayer, 'G1-offline-synthetic');
    assert.ok(typeof record.requirement === 'string' && record.requirement.length > 0);
    assert.ok(typeof record.injectionPoint === 'string' && record.injectionPoint.length > 0 && record.injectionPoint !== 'unspecified',
      `case ${record.caseId} is missing its injection point`);
    assert.ok(typeof record.observed === 'string' && record.observed.length > 0);
  }
});

test('matrix covers each named breakpoint family from the task description', async () => {
  const result = await runEvidenceMatrix();
  const byRequirement = (requirement: string): number => result.records.filter((item) => item.requirement === requirement).length;
  assert.ok(byRequirement('task-6-B') >= 10, 'capture cases are under-represented');
  assert.ok(byRequirement('task-6-C') >= 5, 'restore cases are under-represented');
  assert.ok(byRequirement('task-6-B/V15') >= 2, 'V15-like staging/capacity cases are under-represented');
  assert.ok(byRequirement('task-6-C/V22') >= 2, 'V22-like deletion cases are under-represented');
  assert.ok(byRequirement('task-6-B/D') >= 1, 'the unknown/breakpoint family is missing');
});
