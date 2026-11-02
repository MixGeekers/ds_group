/**
 * H5-B1 isolated-restore tests against real temporary SQLite / files.
 *
 * Covers the verified positive path (readable references, re-hashed copied
 * bytes, disarmed goals, preserved unknown operations, new generation record,
 * untouched old root), every barrier-lock branch (unavailable / stale /
 * baseline mismatch / advanced without ledger), deletion replay from the
 * control snapshot and from a sealed latest ledger, tamper rejection, and all
 * root/target guards (live root, isolation parent, freshness, exclusive lock).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as support from './recovery-support.js';
import { readControlFacts } from '../src/recovery/control-facts.js';
import { validateRecoveryLockRecord, validateRestoreReport } from '../src/recovery/schema.js';
import { deriveSeqChain, verifyBundleDirectory } from '../src/recovery/verify.js';

const exists = async (filename: string): Promise<boolean> => {
  try { await access(filename); return true; } catch { return false; }
};

const rejected = async (promise: Promise<unknown>, expectedCode: string): Promise<void> => {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  assert.ok(failure !== undefined, `expected rejection with ${expectedCode}`);
  assert.equal((failure as { code?: unknown }).code, expectedCode, `unexpected rejection: ${(failure as Error).message}`);
};

test('verified isolated restore: readonly re-hash, readable references, disarmed goals, preserved unknown, new generation', async t => {
  const world = await support.createWorld(t, {
    control: {
      effects: [{ effectId: 'effect-unknown-1', status: 'unknown' }],
      goalCommands: [{ goalId: 'goal-alpha', commandId: 'command-pending-1', status: 'pending' }],
    },
  });
  const ready = await support.captureReady(world, { snapshotId: 'restore-positive-1' });
  const beforeSentinel = await support.readSentinel(world);
  const result = await support.restoreWorld(world, ready.bundleDirectory, { targetName: 'restore-positive' });
  assert.equal(result.report.status, 'verified', JSON.stringify(result.report.failures));
  assert.equal(validateRestoreReport(result.report).ok, true, JSON.stringify(validateRestoreReport(result.report).violations));
  assert.equal(result.report.mode, 'maintenance');
  assert.equal(result.report.dispatch, 'blocked');
  assert.equal(result.report.activate, 'not-activated');
  assert.equal(result.report.readView, 'read-only');
  assert.equal(result.report.reconcileRequired, true);
  assert.equal(result.report.oldRoot, 'untouched');
  assert.equal(result.report.liveActivation, 'not-changed');
  assert.ok(result.report.checks.every((item) => item.status === 'pass'));
  assert.equal(result.report.components.length, 4);
  assert.ok(result.report.components.every((item) => item.hashVerified && item.integrity !== 'failed'));

  // Lock is retained as verified/read-only, dispatch still blocked.
  assert.equal(validateRecoveryLockRecord(result.lock).ok, true);
  assert.equal(result.lock.phase, 'verified');
  assert.equal(result.lock.dispatch, 'blocked');
  assert.equal(result.lock.readView, 'read-only');
  assert.equal(result.lock.releasedAt, null);
  const persistedLock = JSON.parse(await readFile(path.join(result.targetRoot, '.recovery', 'recovery-lock.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(persistedLock.phase, 'verified');

  // New generation record exists and differs from the captured generation.
  const generation = JSON.parse(await readFile(path.join(result.targetRoot, '.recovery', 'generation.json'), 'utf8')) as Record<string, unknown>;
  assert.notEqual(generation.installationGeneration, support.GENERATION.installationGeneration);
  assert.notEqual(generation.hostEpoch, support.GENERATION.hostEpoch);
  assert.deepEqual(generation.previous, { ...support.GENERATION });
  assert.equal(generation.verifiedByHost, false);

  // Restored control database is readable and matches the captured watermarks.
  const restoredDb = path.join(result.targetRoot, 'data', 'bundle', 'components', 'control', 'control.sqlite');
  const facts = readControlFacts(restoredDb);
  assert.deepEqual(facts.watermarks, world.control.watermarks);
  const restoredVerification = await verifyBundleDirectory(path.join(result.targetRoot, 'data', 'bundle'), { requireReady: true });
  assert.equal(restoredVerification.ok, true, JSON.stringify(restoredVerification.violations));

  // State surface: goals disarmed, unknown preserved, memory bodies readable.
  assert.notEqual(result.state, null);
  assert.equal(result.state!.control.integrity, 'ok');
  assert.equal(result.state!.control.commitSeq, world.control.watermarks.commitSeq);
  assert.ok(result.state!.goals.every((goal) => goal.effectiveActivation === 'disarmed' && goal.dispatch === 'blocked'));
  assert.equal(result.state!.unknown.preserved.length, 2);
  assert.equal(result.state!.unknown.preserved.filter((item) => item.kind === 'effect')[0]?.status, 'unknown');
  assert.equal(result.state!.unknown.replayed, 0);
  assert.equal(result.state!.memory.visibleRecords.length, support.defaultMemoryRecords().length);
  for (const record of result.state!.memory.visibleRecords) {
    assert.ok(record.ref.length > 0);
    assert.ok(record.sha256 === null || /^[a-f0-9]{64}$/.test(record.sha256));
  }

  // Live root untouched; report does not leak absolute paths.
  assert.equal(await support.readSentinel(world), beforeSentinel);
  const reportText = await readFile(path.join(result.targetRoot, '.recovery', 'restore-report.json'), 'utf8');
  assert.ok(!reportText.includes(world.root), 'report leaked an absolute data-root path');
  assert.ok(!reportText.includes(world.liveRoot), 'report leaked the live root path');
  assert.equal(await exists(path.join(result.targetRoot, '.recovery', 'restore-report.json')), true);
});

test('captured armed Goal is disarmed after restore and never auto re-armed', async t => {
  const world = await support.createWorld(t, { goals: { captureActivationOverrideFor: 'goal-alpha', failActivation: 'armed' } });
  const ready = await support.captureReady(world, { snapshotId: 'restore-armed-1' });
  const result = await support.restoreWorld(world, ready.bundleDirectory, { targetName: 'restore-armed' });
  assert.equal(result.report.status, 'verified', JSON.stringify(result.report.failures));
  assert.equal(result.report.goals[0]?.restoredActivation, 'armed');
  assert.equal(result.report.goals[0]?.effectiveActivation, 'disarmed');
  assert.equal(result.report.goals[0]?.dispatch, 'blocked');
  assert.equal(result.state!.goals[0]?.activation, 'armed');
  assert.equal(result.state!.goals[0]?.effectiveActivation, 'disarmed');
  assert.equal(result.state!.goals[0]?.dispatch, 'blocked');
  assert.equal(result.lock.dispatch, 'blocked');
});

test('unknown effects and pending Goal commands are preserved with their captured status and never replayed', async t => {
  const world = await support.createWorld(t, {
    control: {
      effects: [{ effectId: 'effect-unknown-1', status: 'unknown' }],
      goalCommands: [{ goalId: 'goal-alpha', commandId: 'command-pending-1', status: 'pending' }],
      reservations: [{ id: 'reservation-unknown-1', state: 'unknown' }],
      memoryOperations: [{ operationId: 'memory-op-unknown-1', effectState: 'unknown', status: 'approved' }],
    },
  });
  const ready = await support.captureReady(world, { snapshotId: 'restore-unknown-1' });
  const controlManifest = JSON.parse(await readFile(path.join(ready.bundleDirectory, 'components/control/manifest.json'), 'utf8')) as {
    inFlight: { kind: string; id: string; status: string }[];
  };
  assert.equal(controlManifest.inFlight.length, 4);
  const result = await support.restoreWorld(world, ready.bundleDirectory, { targetName: 'restore-unknown' });
  assert.equal(result.report.status, 'verified');
  assert.deepEqual(
    [...result.state!.unknown.preserved].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
    [...controlManifest.inFlight].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
  );
  assert.equal(result.report.unknown.replayed, 0);
  const restoredDb = path.join(result.targetRoot, 'data', 'bundle', 'components', 'control', 'control.sqlite');
  const facts = readControlFacts(restoredDb);
  assert.deepEqual(facts.inFlight, controlManifest.inFlight);
});

test('internal control tombstones replay when the memory export watermark lags the control ledger', async t => {
  const world = await support.createWorld(t, {
    control: {
      tombstoneWatermark: 5,
      tombstones: [{ ref: 'memory-deleted-if-tombstoned', watermark: 5 }],
    },
    memory: { tombstoneWatermark: 3 },
  });
  const ready = await support.captureReady(world, { snapshotId: 'restore-internal-deletion' });
  const result = await support.restoreWorld(world, ready.bundleDirectory, { targetName: 'restore-internal-deletion' });
  assert.equal(result.report.status, 'verified', JSON.stringify(result.report.failures));
  const visible = result.state!.memory.visibleRecords.map((item) => item.ref);
  assert.ok(!visible.includes('memory-deleted-if-tombstoned'), 'deleted memory was resurrected');
  assert.equal(result.report.deletion.resurrectionDetected, false);
  assert.ok(result.report.deletion.removedRefs >= 1);
  assert.equal(result.report.deletion.visibleRefs, visible.length);
});

test('latest deletion ledger is required for an advanced watermark; without it the lock stays closed', async t => {
  const world = await support.createWorld(t, {});
  const ready = await support.captureReady(world, { snapshotId: 'restore-old-ledger-1' });
  const base = world.barrier();
  const advanced = { ...base, deletion: { baselineId: base.deletion!.baselineId, tombstoneWatermark: 5 } };
  const locked = await support.restoreWorld(world, ready.bundleDirectory, { barrier: advanced, targetName: 'restore-locked-ledger' });
  assert.equal(locked.report.status, 'locked');
  assert.equal(locked.report.readView, 'closed');
  assert.equal(locked.state, null);
  assert.equal(locked.lock.phase, 'locked');
  assert.equal(locked.lock.readView, 'closed');
  assert.equal(locked.report.barrier.deletion.relation, 'advanced-unreplayed');
  assert.equal(locked.report.deletion.ledgerApplied, false);

  const ledger = support.ledgerFixture(3, 5, ['memory-visible-2']);
  const verified = await support.restoreWorld(world, ready.bundleDirectory, {
    barrier: advanced, deletionLedger: ledger, targetName: 'restore-ledger-replay',
  });
  assert.equal(verified.report.status, 'verified', JSON.stringify(verified.report.failures));
  assert.equal(verified.report.deletion.ledgerApplied, true);
  assert.equal(verified.report.barrier.deletion.relation, 'advanced-replayed');
  assert.ok(!verified.state!.memory.visibleRecords.some((item) => item.ref === 'memory-visible-2'));
});

test('tampered deletion ledger and stale/baseline-mismatched barriers fail closed', async t => {
  const world = await support.createWorld(t, {});
  const ready = await support.captureReady(world, { snapshotId: 'restore-barrier-branches' });
  const base = world.barrier();
  const advanced = { ...base, deletion: { baselineId: base.deletion!.baselineId, tombstoneWatermark: 5 } };
  const goodLedger = support.ledgerFixture(3, 5, ['memory-visible-2']);
  const tampered = JSON.parse(JSON.stringify(goodLedger)) as Record<string, unknown>;
  tampered.ledgerSha256 = support.sha256('forged-ledger');
  const tamperedResult = await support.restoreWorld(world, ready.bundleDirectory, {
    barrier: advanced, deletionLedger: tampered as never, targetName: 'restore-tampered-ledger',
  });
  assert.equal(tamperedResult.report.status, 'failed');
  assert.equal(tamperedResult.report.readView, 'closed');
  assert.equal(tamperedResult.lock.phase, 'failed');

  const mismatch = await support.restoreWorld(world, ready.bundleDirectory, {
    barrier: { ...base, deletion: { baselineId: 'different-baseline', tombstoneWatermark: base.deletion!.tombstoneWatermark } },
    targetName: 'restore-baseline-mismatch',
  });
  assert.equal(mismatch.report.status, 'locked');
  assert.equal(mismatch.report.barrier.deletion.relation, 'baseline-mismatch');
  assert.equal(mismatch.report.readView, 'closed');

  const stale = await support.restoreWorld(world, ready.bundleDirectory, {
    barrier: { ...base, deletion: { baselineId: base.deletion!.baselineId, tombstoneWatermark: 1 } },
    targetName: 'restore-stale-barrier',
  });
  assert.equal(stale.report.status, 'locked');
  assert.equal(stale.report.barrier.deletion.relation, 'stale');

  const partial = await support.restoreWorld(world, ready.bundleDirectory, {
    barrier: { ...base, completeness: 'partial' },
    targetName: 'restore-partial-barrier',
  });
  assert.equal(partial.report.status, 'locked');
  assert.equal(partial.report.barrier.completeness, 'partial');

  const authorizationStale = await support.restoreWorld(world, ready.bundleDirectory, {
    barrier: { ...base, authorization: { authEpoch: 1 } },
    targetName: 'restore-stale-authorization',
  });
  assert.equal(authorizationStale.report.status, 'locked');
  assert.equal(authorizationStale.report.barrier.authorization.relation, 'stale');

  const missingBarrier = await support.restoreWorld(world, ready.bundleDirectory, { barrier: undefined, targetName: 'restore-missing-barrier' });
  assert.equal(missingBarrier.report.status, 'locked');
  assert.equal(missingBarrier.report.barrier.completeness, 'unavailable');
  assert.equal(missingBarrier.report.readView, 'closed');
});

test('tampered bundle bytes are rejected without touching the live root', async t => {
  const world = await support.createWorld(t, {
    objects: new Map([['artifact-a', Buffer.from('synthetic artifact')]]),
    controlObjectRefs: ['artifact-a'],
  });
  const ready = await support.captureReady(world, { snapshotId: 'restore-tamper-bytes' });
  const objectDirectory = path.join(ready.bundleDirectory, 'components/shared-objects/objects');
  const [objectFile] = await readdir(objectDirectory);
  const filename = path.join(objectDirectory, objectFile!);
  const bytes = await readFile(filename);
  await writeFile(filename, Buffer.concat([bytes, Buffer.from('tampered')]));
  const before = await support.readSentinel(world);
  const result = await support.restoreWorld(world, ready.bundleDirectory, { targetName: 'restore-tampered-bundle' });
  assert.equal(result.report.status, 'failed');
  assert.equal(result.report.readView, 'closed');
  assert.equal(result.lock.phase, 'failed');
  assert.equal(await support.readSentinel(world), before);
  assert.ok(result.report.failures.length > 0);
});

test('failed / non-ready bundles and missing components are refused before any copy', async t => {
  const world = await support.createWorld(t, {});
  const failed = await support.captureWorld(world, {
    snapshotId: 'restore-refuse-failed',
    faults: { at: 'after-control-snapshot', mode: 'fail' },
  });
  assert.notEqual(failed.status, 'ready');
  if (failed.status === 'ready') throw new Error('unreachable');
  await rejected(support.restoreWorld(world, failed.bundleDirectory!, { targetName: 'restore-refused' }), 'BUNDLE_NOT_READY');
  assert.equal(await exists(path.join(world.isolatedRoot, 'restore-refused')), false);

  const ready = await support.captureReady(world, { snapshotId: 'restore-refuse-missing-component' });
  const manifestPath = path.join(ready.bundleDirectory, 'bundle.json');
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  raw.components = (raw.components as Record<string, unknown>[]).filter((item) => item.componentId !== 'memory');
  await writeFile(manifestPath, `${support.canonicalJson(raw)}\n`);
  await rejected(support.restoreWorld(world, ready.bundleDirectory, { targetName: 'restore-refused-2' }), 'BUNDLE_NOT_READY');
});

test('root identity / snapshot identity mismatches are rejected before writing', async t => {
  const world = await support.createWorld(t, {});
  const ready = await support.captureReady(world, { snapshotId: 'restore-identity' });
  await rejected(support.restoreWorld(world, ready.bundleDirectory, {
    expectedRootId: support.sha256('different-root'), targetName: 'restore-wrong-root',
  }), 'ROOT_MISMATCH');
  await rejected(world.restoreService.restore({
    bundleDirectory: ready.bundleDirectory,
    targetRoot: path.join(world.isolatedRoot, 'restore-wrong-snapshot'),
    isolatedRoot: world.isolatedRoot,
    expectedSnapshotId: 'some-other-snapshot',
    barrier: world.barrier(),
  }), 'SNAPSHOT_MISMATCH');
});

test('live root, isolation parent and freshness guards reject unsafe targets without writing', async t => {
  const world = await support.createWorld(t, {});
  const ready = await support.captureReady(world, { snapshotId: 'restore-guards' });
  const before = await support.readSentinel(world);
  await rejected(support.restoreWorld(world, ready.bundleDirectory, { targetRoot: world.liveRoot }), 'LIVE_ROOT_PROTECTED');
  await rejected(support.restoreWorld(world, ready.bundleDirectory, {
    targetName: 'restore-inside-live-root',
    liveDataRoot: world.root,
  }), 'LIVE_ROOT_PROTECTED');
  await rejected(support.restoreWorld(world, ready.bundleDirectory, {
    targetRoot: path.join(world.root, 'outside', 'restore'),
  }), 'TARGET_NOT_ISOLATED');
  const nonEmptyTarget = path.join(world.isolatedRoot, 'non-empty-target');
  await mkdir(nonEmptyTarget, { recursive: true });
  await writeFile(path.join(nonEmptyTarget, 'stray.txt'), 'not fresh');
  await rejected(support.restoreWorld(world, ready.bundleDirectory, { targetRoot: nonEmptyTarget }), 'TARGET_NOT_FRESH');
  await rejected(world.restoreService.restore({
    bundleDirectory: ready.bundleDirectory,
    targetRoot: 'relative/target',
    isolatedRoot: world.isolatedRoot,
    barrier: world.barrier(),
  }), 'INVALID_SCHEMA');
  assert.equal(await support.readSentinel(world), before);
  assert.equal(await exists(path.join(world.liveRoot, 'nested-restore')), false);
});

test('recovery lock is exclusive: a second restore cannot start while a lock exists, and a completed target is not re-restored', async t => {
  const world = await support.createWorld(t, {});
  const ready = await support.captureReady(world, { snapshotId: 'restore-lock' });
  const lockedTarget = path.join(world.isolatedRoot, 'pre-locked-target');
  await mkdir(path.join(lockedTarget, '.recovery'), { recursive: true });
  const lock = {
    schemaVersion: 1, lockId: 'existing-lock', snapshotId: 'previous-snapshot', targetRootHash: support.sha256(lockedTarget),
    mode: 'maintenance', phase: 'restoring', dispatch: 'blocked', readView: 'closed',
    acquiredAt: support.FIXED_BASE, releasedAt: null, holder: 'recovery-module',
    hostProvenance: 'offline-module', reasonCode: null,
  };
  await writeFile(path.join(lockedTarget, '.recovery', 'recovery-lock.json'), JSON.stringify(lock));
  await rejected(support.restoreWorld(world, ready.bundleDirectory, { targetRoot: lockedTarget }), 'RECOVERY_LOCKED');

  const first = await support.restoreWorld(world, ready.bundleDirectory, { targetName: 'restore-once' });
  assert.equal(first.report.status, 'verified');
  await rejected(support.restoreWorld(world, ready.bundleDirectory, { targetName: 'restore-once' }), 'RECOVERY_LOCKED');
});

test('restore of a verified bundle is idempotent only into a fresh target: copied data verifies again', async t => {
  const world = await support.createWorld(t, {});
  const ready = await support.captureReady(world, { snapshotId: 'restore-copy-verify' });
  const result = await support.restoreWorld(world, ready.bundleDirectory, { targetName: 'restore-copy-verify' });
  assert.equal(result.report.status, 'verified');
  const copiedRoot = path.join(result.targetRoot, 'data', 'bundle');
  const verification = await verifyBundleDirectory(copiedRoot, { requireReady: true });
  assert.equal(verification.ok, true, JSON.stringify(verification.violations));
  // Copied control SQLite really opens read-only and returns the snapshot facts.
  const facts = readControlFacts(path.join(copiedRoot, 'components/control/control.sqlite'));
  assert.equal(facts.watermarks.commitSeq, world.control.watermarks.commitSeq);
  // A copied Goal Session log still derives the expected tail.
  const goals = JSON.parse(await readFile(path.join(copiedRoot, 'components/dsh-goal-sessions/manifest.json'), 'utf8')) as {
    sessions: { logFile: string; logTail: { lastSequence: number } }[];
  };
  const session = goals.sessions[0]!;
  const log = await readFile(path.join(copiedRoot, session.logFile));
  const derived = deriveSeqChain(log);
  assert.equal(derived.lastSequence, session.logTail.lastSequence);
  assert.notEqual(derived.goalState, null);
});
