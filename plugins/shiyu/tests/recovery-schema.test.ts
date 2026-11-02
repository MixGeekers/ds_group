/**
 * H5-B1 schema / verifier tests.
 *
 * Proves the validator chain is not "readable JSON is enough": a real captured
 * bundle is accepted; known-bad data-level mutations are rejected with a
 * specific code; and byte-level tampering of every component file is caught by
 * the directory verifier. Also includes the validator self-proof table shared
 * with the evidence generator (known-good accepted, known-bad rejected).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as support from './recovery-support.js';
import { runValidatorSelfProof } from './recovery-matrix.js';
import {
  validateBackupBundle,
  validateControlComponentManifest,
  validateDeletionLedger,
  validateGenerationTransition,
  validateGoalSessionsComponentManifest,
  validateLastGoodPointer,
  validateMemoryComponentManifest,
  validateRecoveryLockRecord,
  validateRestoreReport,
  validateSharedObjectsComponentManifest,
  validateStagingJournal,
} from '../src/recovery/schema.js';
import { verifyBundleDirectory } from '../src/recovery/verify.js';

const codesOf = (result: { violations: { code: string }[] }): string[] => result.violations.map((item) => item.code);

test('validator self-proof: a real valid bundle/report is accepted and every known-bad variant is rejected', async () => {
  const cases = await runValidatorSelfProof();
  assert.ok(cases.length >= 15, `expected a broad self-proof table, got ${cases.length}`);
  const failed = cases.filter((item) => !item.pass);
  assert.deepEqual(failed, [], `validator self-proof failures: ${JSON.stringify(failed, null, 2)}`);
  assert.ok(cases.some((item) => item.expected === 'accepted' && !item.rejected), 'at least one known-good sample must be accepted');
  assert.ok(cases.filter((item) => item.expected === 'rejected').every((item) => item.rejected), 'every known-bad sample must be rejected');
});

test('bundle ready preconditions: captureTime, failure record, required components, versions, common-section claim', async t => {
  const world = await support.createWorld(t, {});
  const ready = await support.captureReady(world, { snapshotId: 'schema-bundle' });
  const raw = JSON.parse(await readFile(path.join(ready.bundleDirectory, 'bundle.json'), 'utf8')) as Record<string, unknown>;
  const good = validateBackupBundle(raw, { requireReady: true });
  assert.equal(good.ok, true, JSON.stringify(good.violations));
  const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

  const lateCapture = clone();
  lateCapture.captureTime = new Date(Date.parse(String(lateCapture.completedAt)) + 1000).toISOString();
  assert.ok(codesOf(validateBackupBundle(lateCapture, { requireReady: true })).includes('capture-time'));

  const noDurability = clone();
  noDurability.durability = { crossComponentCommonSection: false, perComponent: [] };
  assert.ok(codesOf(validateBackupBundle(noDurability, { requireReady: true })).includes('missing-durability'));

  const wrongReader = clone();
  wrongReader.minimumReaderVersion = 2;
  assert.ok(codesOf(validateBackupBundle(wrongReader, { requireReady: true })).includes('incompatible'));

  const wrongSchema = clone();
  wrongSchema.bundleSchemaVersion = 2;
  assert.ok(codesOf(validateBackupBundle(wrongSchema, { requireReady: true })).includes('incompatible'));

  const failedWithoutRecord = clone();
  failedWithoutRecord.status = 'incomplete';
  assert.ok(codesOf(validateBackupBundle(failedWithoutRecord, { requireReady: true })).includes('bundle-not-ready'));

  const duplicate = clone();
  duplicate.components = [...(duplicate.components as unknown[]), (duplicate.components as unknown[])[0]];
  assert.ok(codesOf(validateBackupBundle(duplicate, { requireReady: true })).includes('duplicate'));

  const controlWatermarkMismatch = clone();
  (controlWatermarkMismatch.control as Record<string, unknown>).commitSeq = 999;
  assert.ok(codesOf(validateBackupBundle(controlWatermarkMismatch, { requireReady: true })).includes('watermark'));
});

test('component manifests reject duplicate bindings, missing integrity evidence and invalid watermarks', async t => {
  const world = await support.createWorld(t, {});
  const ready = await support.captureReady(world, { snapshotId: 'schema-components' });
  const read = async (relative: string): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(path.join(ready.bundleDirectory, relative), 'utf8')) as Record<string, unknown>;
  const control = await read('components/control/manifest.json');
  const controlClone = (): Record<string, unknown> => JSON.parse(JSON.stringify(control)) as Record<string, unknown>;
  const goodControl = validateControlComponentManifest(control);
  assert.equal(goodControl.ok, true, JSON.stringify(goodControl.violations));

  const duplicateBinding = controlClone();
  duplicateBinding.goalBindings = [...(duplicateBinding.goalBindings as unknown[]), (duplicateBinding.goalBindings as unknown[])[0]];
  assert.ok(codesOf(validateControlComponentManifest(duplicateBinding)).includes('duplicate'));

  const badIntegrity = controlClone();
  badIntegrity.integrity = { quickCheck: 'failed', foreignKeyCheck: 'ok' };
  assert.ok(codesOf(validateControlComponentManifest(badIntegrity)).includes('integrity'));

  const missingObjectRefs = controlClone();
  delete missingObjectRefs.objectRefs;
  assert.ok(codesOf(validateControlComponentManifest(missingObjectRefs)).includes('missing-field'));

  const goals = await read('components/dsh-goal-sessions/manifest.json');
  const goalsClone = (): Record<string, unknown> => JSON.parse(JSON.stringify(goals)) as Record<string, unknown>;
  assert.equal(validateGoalSessionsComponentManifest(goals).ok, true);
  const tamperedTail = goalsClone();
  ((tamperedTail.sessions as Record<string, unknown>[])[0]!).logTail = {
    kind: 'opaque', bytes: 1, sha256: support.sha256('x'), lastSequence: 4,
  };
  assert.ok(codesOf(validateGoalSessionsComponentManifest(tamperedTail)).includes('semantics'));

  const memory = await read('components/memory/manifest.json');
  assert.equal(validateMemoryComponentManifest(memory).ok, true);
  const memoryClone = JSON.parse(JSON.stringify(memory)) as Record<string, unknown>;
  (memoryClone.watermark as Record<string, unknown>).tombstoneWatermark = -1;
  assert.ok(codesOf(validateMemoryComponentManifest(memoryClone)).includes('range'));

  const objects = await read('components/shared-objects/manifest.json');
  assert.equal(validateSharedObjectsComponentManifest(objects).ok, true);
  const objectsClone = JSON.parse(JSON.stringify(objects)) as Record<string, unknown>;
  objectsClone.objects = [
    { objectId: 'artifact-a', file: 'components/shared-objects/objects/a.bin', bytes: 1, sha256: support.sha256('a') },
    { objectId: 'artifact-a', file: 'components/shared-objects/objects/b.bin', bytes: 1, sha256: support.sha256('b') },
  ];
  assert.ok(codesOf(validateSharedObjectsComponentManifest(objectsClone)).includes('duplicate'));
});

test('byte-level tampering of each component file is detected by the directory verifier', async t => {
  const world = await support.createWorld(t, {
    objects: new Map([['artifact-a', Buffer.from('synthetic artifact')]]),
    controlObjectRefs: ['artifact-a'],
  });
  const ready = await support.captureReady(world, { snapshotId: 'schema-tamper' });
  const base = await mkdtemp(path.join(tmpdir(), 'shiyu-recovery-tamper-'));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const manifest = await support.readManifest(ready.bundleDirectory);
  const controlManifest = JSON.parse(await readFile(path.join(ready.bundleDirectory, 'components/control/manifest.json'), 'utf8')) as Record<string, unknown>;
  const goalsManifest = JSON.parse(await readFile(path.join(ready.bundleDirectory, 'components/dsh-goal-sessions/manifest.json'), 'utf8')) as Record<string, unknown>;
  const memoryManifest = JSON.parse(await readFile(path.join(ready.bundleDirectory, 'components/memory/manifest.json'), 'utf8')) as Record<string, unknown>;
  const objectsManifest = JSON.parse(await readFile(path.join(ready.bundleDirectory, 'components/shared-objects/manifest.json'), 'utf8')) as Record<string, unknown>;
  const session = (goalsManifest.sessions as Record<string, unknown>[])[0]!;
  const object = (objectsManifest.objects as Record<string, unknown>[])[0]!;
  const targets: { label: string; relative: string; expected: string }[] = [
    { label: 'control database', relative: String(controlManifest.databaseFile), expected: 'HASH_MISMATCH' },
    { label: 'goal session log', relative: String(session.logFile), expected: 'HASH_MISMATCH' },
    { label: 'projection config', relative: String(session.projectionConfigFile), expected: 'HASH_MISMATCH' },
    { label: 'memory archive', relative: String(memoryManifest.archiveFile), expected: 'HASH_MISMATCH' },
    { label: 'shared object', relative: String(object.file), expected: 'HASH_MISMATCH' },
  ];
  for (const [index, target] of targets.entries()) {
    const copy = path.join(base, `copy-${index}`);
    await cp(ready.bundleDirectory, copy, { recursive: true });
    const filename = path.join(copy, target.relative);
    const bytes = await readFile(filename);
    await writeFile(filename, Buffer.concat([bytes, Buffer.from('tampered')]));
    const verification = await verifyBundleDirectory(copy, { requireReady: true });
    assert.equal(verification.ok, false, `${target.label} tampering was not detected`);
    assert.ok(codesOf(verification).includes(target.expected), `${target.label} did not report ${target.expected}: ${codesOf(verification).join(',')}`);
  }
  // A manifest-level hash mutation must also fail even when files are unchanged.
  const manifestCopy = path.join(base, 'copy-manifest');
  await cp(ready.bundleDirectory, manifestCopy, { recursive: true });
  const bundlePath = path.join(manifestCopy, 'bundle.json');
  const bundleRaw = JSON.parse(await readFile(bundlePath, 'utf8')) as Record<string, unknown>;
  const component = (bundleRaw.components as Record<string, unknown>[]).find((item) => item.componentId === 'control')!;
  component.manifestSha256 = support.sha256('not-the-control-manifest');
  await writeFile(bundlePath, `${support.canonicalJson(bundleRaw)}\n`);
  const manifestVerification = await verifyBundleDirectory(manifestCopy, { requireReady: true });
  assert.equal(manifestVerification.ok, false);
  assert.ok(codesOf(manifestVerification).includes('HASH_MISMATCH'));
  void manifest;
});

test('recovery lock / generation / report / ledger validators reject unsafe states', async () => {
  const goodLock = {
    schemaVersion: 1, lockId: 'lock-1', snapshotId: 'snap-1', targetRootHash: support.sha256('root'),
    mode: 'maintenance', phase: 'verified', dispatch: 'blocked', readView: 'read-only',
    acquiredAt: support.FIXED_BASE, releasedAt: null, holder: 'recovery-module',
    hostProvenance: 'offline-module', reasonCode: 'RESTORE_REQUIRES_EXPLICIT_ACTIVATION',
  };
  assert.equal(validateRecoveryLockRecord(goodLock).ok, true);
  const lockVariants: [Record<string, unknown>, string][] = [
    [{ ...goodLock, dispatch: 'enabled' }, 'value'],
    [{ ...goodLock, mode: 'running' }, 'value'],
    [{ ...goodLock, phase: 'locked', readView: 'read-only' }, 'semantics'],
    [{ ...goodLock, hostProvenance: 'host' }, 'value'],
    [{ ...goodLock, acquiredAt: '2026-11-02 18:00:00' }, 'format'],
  ];
  for (const [variant, code] of lockVariants) {
    const result = validateRecoveryLockRecord(variant);
    assert.equal(result.ok, false);
    assert.ok(codesOf(result).includes(code), `${code} not reported: ${codesOf(result).join(',')}`);
  }

  const goodGeneration = {
    schemaVersion: 1, installationGeneration: 'generation-a', hostEpoch: 'epoch-a',
    previous: { installationGeneration: 'generation-old', hostEpoch: 'epoch-old' },
    reason: 'restore', sourceSnapshotId: 'snap-1', createdAt: support.FIXED_BASE, verifiedByHost: false,
  };
  assert.equal(validateGenerationTransition(goodGeneration).ok, true);
  assert.ok(codesOf(validateGenerationTransition({ ...goodGeneration, verifiedByHost: true })).includes('value'));
  assert.ok(codesOf(validateGenerationTransition({
    ...goodGeneration,
    previous: { installationGeneration: 'generation-a', hostEpoch: 'epoch-old' },
  })).includes('semantics'));
  assert.ok(codesOf(validateGenerationTransition({
    ...goodGeneration,
    previous: { installationGeneration: 'generation-old', hostEpoch: 'epoch-a' },
  })).includes('semantics'));

  const goodJournal = {
    schemaVersion: 1, snapshotId: 'snap-1', phase: 'published', startedAt: support.FIXED_BASE,
    updatedAt: support.FIXED_BASE, estimatedBytes: 10, freeBytes: 100, attempts: 1, lastErrorCode: null,
  };
  assert.equal(validateStagingJournal(goodJournal).ok, true);
  assert.ok(codesOf(validateStagingJournal({ ...goodJournal, phase: 'complete' })).includes('enum'));
  assert.ok(codesOf(validateStagingJournal({ ...goodJournal, lastErrorCode: 'lower-case' })).includes('format'));

  const goodLastGood = {
    schemaVersion: 1, snapshotId: 'snap-1', manifestSha256: support.sha256('manifest'),
    captureTime: support.FIXED_BASE, updatedAt: support.FIXED_BASE,
  };
  assert.equal(validateLastGoodPointer(goodLastGood).ok, true);
  assert.ok(codesOf(validateLastGoodPointer({ ...goodLastGood, snapshotId: '../escape' })).includes('format'));

  const goodLedger = support.ledgerFixture(3, 5, ['memory-visible-2']);
  assert.equal(validateDeletionLedger(goodLedger).ok, true);
  const gap = { ...goodLedger, entries: [...goodLedger.entries.slice(0, 1), { ...goodLedger.entries[1]!, watermark: 9 }] };
  assert.ok(codesOf(validateDeletionLedger(gap)).includes('ledger-gap'));
  const emptyRefs = JSON.parse(JSON.stringify(goodLedger)) as Record<string, unknown>;
  ((emptyRefs.entries as Record<string, unknown>[])[0]!).refs = [];
  assert.ok(codesOf(validateDeletionLedger(emptyRefs)).includes('ledger-empty-entry'));
});

test('restore report validation rejects a verified report that accepts resurrection or re-enables dispatch', async t => {
  const world = await support.createWorld(t, {});
  const ready = await support.captureReady(world, { snapshotId: 'schema-report' });
  const restored = await support.restoreWorld(world, ready.bundleDirectory, { targetName: 'schema-report-target' });
  assert.equal(restored.report.status, 'verified');
  assert.equal(validateRestoreReport(restored.report).ok, true, JSON.stringify(validateRestoreReport(restored.report).violations));
  const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(restored.report)) as Record<string, unknown>;
  const variants: [Record<string, unknown>, string][] = [
    [((): Record<string, unknown> => { const v = clone(); (v.deletion as Record<string, unknown>).resurrectionDetected = true; return v; })(), 'semantics'],
    [((): Record<string, unknown> => { const v = clone(); v.dispatch = 'enabled'; return v; })(), 'value'],
    [((): Record<string, unknown> => { const v = clone(); v.activate = 'activated'; return v; })(), 'value'],
    [((): Record<string, unknown> => { const v = clone(); v.readView = 'closed'; return v; })(), 'semantics'],
    [((): Record<string, unknown> => { const v = clone(); v.oldRoot = 'modified'; return v; })(), 'value'],
    [((): Record<string, unknown> => { const v = clone(); ((v.goals as Record<string, unknown>[])[0]!).effectiveActivation = 'armed'; return v; })(), 'semantics'],
    [((): Record<string, unknown> => { const v = clone(); (v.unknown as Record<string, unknown>).replayed = 1; return v; })(), 'semantics'],
  ];
  for (const [variant, code] of variants) {
    const validation = validateRestoreReport(variant);
    assert.equal(validation.ok, false, `variant should be rejected: ${JSON.stringify(variant).slice(0, 120)}`);
    assert.ok(codesOf(validation).includes(code), `${code} not reported: ${codesOf(validation).join(',')}`);
  }
});

test('captured bundle manifests survive a JSON round-trip but not semantic edits', async t => {
  const world = await support.createWorld(t, {});
  const ready = await support.captureReady(world, { snapshotId: 'schema-roundtrip' });
  const text = await readFile(path.join(ready.bundleDirectory, 'bundle.json'), 'utf8');
  const parsed = JSON.parse(text) as unknown;
  assert.equal(validateBackupBundle(parsed, { requireReady: true }).ok, true);
  assert.equal(text.endsWith('\n'), true, 'bundle manifest should be canonical newline-terminated JSON');
  const reordered = JSON.parse(text) as Record<string, unknown>;
  const first = reordered.components as Record<string, unknown>[];
  reordered.components = [first[0]!, first[2]!, first[1]!, first[3]!];
  // Component order is not semantic; the validator must still accept a reordered vector.
  assert.equal(validateBackupBundle(reordered, { requireReady: true }).ok, true);
});
