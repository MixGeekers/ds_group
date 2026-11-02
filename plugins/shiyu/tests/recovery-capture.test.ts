/**
 * H5-B1 capture tests against real temporary SQLite / files.
 *
 * Covers: ready capture shape, last-good publication and idempotency, all
 * required-watermark gaps, Goal Session / projection / object closure gaps,
 * hash mismatches, version incompatibility, capacity checks, staging
 * interruptions at every stage, failure-never-overwrites-lastGood and the
 * concurrent-writer boundary declaration (never a common cross-component
 * snapshot).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as support from './recovery-support.js';
import { verifyBundleDirectory } from '../src/recovery/verify.js';
import type { BackupBundle } from '../src/recovery/types.js';

const exists = async (filename: string): Promise<boolean> => {
  try { await access(filename); return true; } catch { return false; }
};

const notReady = (result: Awaited<ReturnType<typeof support.captureWorld>>): { code: string; status: string } => {
  assert.notEqual(result.status, 'ready', 'expected a non-ready capture');
  if (result.status === 'ready') throw new Error('unreachable');
  return { code: result.failure.code, status: result.status };
};

test('ready capture publishes a verifiable two-level manifest and a matching last-good pointer', async t => {
  const world = await support.createWorld(t, {
    objects: new Map([['artifact-a', Buffer.from('synthetic artifact')]]),
    controlObjectRefs: ['artifact-a'],
  });
  const ready = await support.captureReady(world, { snapshotId: 'capture-ready-1' });
  const manifest = await support.readManifest(ready.bundleDirectory);
  assert.equal(manifest.status, 'ready');
  assert.equal(manifest.reconcileRequired, true);
  assert.equal(manifest.durability.crossComponentCommonSection, false);
  assert.equal(manifest.failure, null);
  assert.equal(manifest.snapshotId, 'capture-ready-1');
  assert.equal(manifest.rootId, world.rootId);
  assert.deepEqual(manifest.components.map((item) => item.componentId).sort(), ['control', 'dsh-goal-sessions', 'memory', 'shared-objects']);
  for (const component of manifest.components) {
    assert.equal(component.status, 'complete');
    assert.equal(component.dataSchema, 1);
    assert.equal(component.minimumReaderVersion, 1);
    assert.ok(component.watermark !== null || component.actualRevision !== null);
    assert.ok(component.quiescenceEvidence.length > 0);
  }
  assert.deepEqual(manifest.control, world.control.watermarks);
  const earliest = [...manifest.components.map((item) => item.capturedAt)].sort()[0];
  assert.equal(manifest.captureTime, earliest, 'captureTime must be the conservative earliest component time');
  assert.ok(manifest.completedAt >= manifest.captureTime);
  assert.equal(manifest.objectManifest?.objectCount, 1);
  const verification = await verifyBundleDirectory(ready.bundleDirectory, { requireReady: true });
  assert.equal(verification.ok, true, JSON.stringify(verification.violations));
  const lastGood = await world.captureService.readLastGood();
  assert.equal(lastGood?.snapshotId, 'capture-ready-1');
  assert.equal(lastGood?.manifestSha256, ready.manifestSha256);
  assert.equal(lastGood?.captureTime, manifest.captureTime);

  // The staged control snapshot really contains the captured watermarks.
  const stagedDb = new DatabaseSync(path.join(ready.bundleDirectory, 'components/control/control.sqlite'), { readOnly: true });
  try {
    const row = stagedDb.prepare('SELECT commit_seq FROM shiyu_commit_watermark WHERE id=1').get() as { commit_seq: number };
    assert.equal(row.commit_seq, world.control.watermarks.commitSeq);
    assert.equal(stagedDb.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
  } finally { stagedDb.close(); }

  // Goal Session log bytes on disk match the captured hash.
  const goalsManifest = JSON.parse(await readFile(path.join(ready.bundleDirectory, 'components/dsh-goal-sessions/manifest.json'), 'utf8')) as {
    sessions: { logFile: string; logSha256: string; logBytes: number; logTail: { lastSequence: number } }[];
  };
  const session = goalsManifest.sessions[0]!;
  const logBytes = await readFile(path.join(ready.bundleDirectory, session.logFile));
  assert.equal(support.sha256(logBytes), session.logSha256);
  assert.equal(logBytes.byteLength, session.logBytes);
  assert.ok(session.logTail.lastSequence >= 1);
});

test('a second ready capture advances last-good; recapturing the same snapshot id is idempotent', async t => {
  const world = await support.createWorld(t, {});
  const first = await support.captureReady(world, { snapshotId: 'capture-idem-1' });
  const second = await support.captureReady(world, { snapshotId: 'capture-idem-2' });
  let lastGood = await world.captureService.readLastGood();
  assert.equal(lastGood?.snapshotId, 'capture-idem-2');
  const again = await world.captureService.capture({ snapshotId: 'capture-idem-2', rootId: world.rootId, estimatedBytes: 1024 });
  assert.equal(again.status, 'ready');
  if (again.status !== 'ready') throw new Error('unreachable');
  assert.equal(again.manifestSha256, second.manifestSha256);
  lastGood = await world.captureService.readLastGood();
  assert.equal(lastGood?.snapshotId, 'capture-idem-2');
  assert.equal(await exists(path.join(world.stagingRoot, 'bundles', 'capture-idem-1', 'bundle.json')), true);
  assert.equal(first.manifestSha256.length, 64);
});

test('missing required watermarks are incomplete and never ready', async t => {
  const cases = [
    { label: 'commit', missing: { commit: true } },
    { label: 'publication', missing: { publication: true } },
    { label: 'authorization', missing: { policy: true } },
    { label: 'deletion', missing: { deletion: true } },
  ] as const;
  for (const item of cases) {
    const world = await support.createWorld(t, { control: { missing: item.missing } });
    const result = await support.captureWorld(world, { snapshotId: `capture-missing-${item.label}` });
    const failure = notReady(result);
    assert.equal(failure.code, 'MISSING_WATERMARK', `${item.label}: unexpected code ${failure.code}`);
    assert.equal(failure.status, 'incomplete');
    assert.equal(await world.captureService.readLastGood(), undefined);
  }
});

test('missing Goal Session log, projection definition or object closure is incomplete', async t => {
  const cases: { label: string; options: support.WorldOptions; code: string }[] = [
    { label: 'goal-session', options: { goals: { omitGoalId: 'goal-alpha' } }, code: 'MISSING_GOAL_SESSION' },
    { label: 'projection', options: { goals: { tamperProjection: true } }, code: 'MISSING_PROJECTION' },
    { label: 'object-closure', options: { memory: { objectRefs: ['artifact-missing'] } }, code: 'OBJECT_CLOSURE_INCOMPLETE' },
    { label: 'goal-tail-hash', options: { goals: { tamperBytes: true } }, code: 'HASH_MISMATCH' },
  ];
  for (const item of cases) {
    const world = await support.createWorld(t, item.options);
    const result = await support.captureWorld(world, { snapshotId: `capture-${item.label}` });
    const failure = notReady(result);
    assert.equal(failure.code, item.code, `${item.label}: unexpected code ${failure.code}`);
    if (result.status !== 'ready') {
      assert.equal(await world.captureService.readLastGood(), undefined, `${item.label}: lastGood must not change`);
    }
  }
});

test('memory export failure and version incompatibility never produce a ready bundle', async t => {
  const exportFailure = await support.createWorld(t, { memory: { exportThrows: true } });
  const exportResult = notReady(await support.captureWorld(exportFailure, { snapshotId: 'capture-memory-failure' }));
  assert.equal(exportResult.code, 'COMPONENT_FAILED');
  assert.equal(exportResult.status, 'failed');

  const wrongVersion = await support.createWorld(t, { runtimeManifest: support.runtimeManifestFixture({ minimumReaderVersion: 2 }) });
  const versionResult = notReady(await support.captureWorld(wrongVersion, { snapshotId: 'capture-version' }));
  assert.equal(versionResult.code, 'INCOMPATIBLE_VERSION');

  const wrongSchema = await support.createWorld(t, {
    runtimeManifest: support.runtimeManifestFixture({ dataSchema: 2 }),
  });
  const schemaResult = notReady(await support.captureWorld(wrongSchema, { snapshotId: 'capture-schema' }));
  assert.equal(schemaResult.code, 'INCOMPATIBLE_VERSION');
});

test('capacity checks fail closed before and during capture, and failures never overwrite last-good', async t => {
  const starved = await support.createWorld(t, { capacity: [4096] });
  const failed = notReady(await support.captureWorld(starved, { snapshotId: 'capture-capacity-1', estimatedBytes: 1024 * 1024 }));
  assert.equal(failed.code, 'CAPACITY_INSUFFICIENT');
  assert.equal(await starved.captureService.readLastGood(), undefined);

  // Capacity is sufficient at the start but drops before publish: the bundle
  // must not be published as ready and the previous last-good must survive.
  let calls = 0;
  const world = await support.createWorld(t, {
    capacity: () => { calls += 1; return calls <= 3 ? 8 * 1024 * 1024 * 1024 : 1024; },
  });
  const first = await support.captureReady(world, { snapshotId: 'capture-capacity-first' });
  const second = notReady(await support.captureWorld(world, { snapshotId: 'capture-capacity-second' }));
  assert.equal(second.code, 'CAPACITY_INSUFFICIENT');
  const pointer = await world.captureService.readLastGood();
  assert.equal(pointer?.snapshotId, first.snapshotId);
  assert.equal(pointer?.manifestSha256, first.manifestSha256);
});

test('staging interruption at every stage leaves a partial journal, no ready bundle and no lastGood', async t => {
  const stages = [
    ['after-control-snapshot', 'control-snapshot'],
    ['after-goal-sessions', 'goal-sessions'],
    ['after-memory-export', 'memory-export'],
    ['after-shared-objects', 'shared-objects'],
    ['before-publish', 'publishing'],
  ] as const;
  for (const [stage, expectedPhase] of stages) {
    const world = await support.createWorld(t, {});
    const snapshotId = `capture-interrupt-${stage}`;
    const result = await support.captureWorld(world, { snapshotId, faults: { at: stage, mode: 'interrupt' } });
    const failure = notReady(result);
    assert.equal(failure.code, 'STAGING_INTERRUPTED', `${stage}: unexpected code ${failure.code}`);
    assert.equal(failure.status, 'incomplete');
    const staging = await world.captureService.inspectStaging(snapshotId);
    assert.notEqual(staging.partialDirectory, null, `${stage}: partial directory missing`);
    assert.equal(staging.journal?.phase, expectedPhase, `${stage}: journal phase`);
    assert.equal(staging.publishedDirectory, null);
    assert.equal(await exists(path.join(world.bundleDirectory(snapshotId), 'bundle.json')), false);
    assert.equal(await world.captureService.readLastGood(), undefined);
    // A partial attempt must not be silently resumed under the same id.
    const again = await support.captureWorld(world, { snapshotId });
    assert.equal(notReady(again).code, 'STAGING_INTERRUPTED');
    // A fresh id succeeds against the same sources.
    const fresh = await support.captureReady(world, { snapshotId: `${snapshotId}-retry` });
    assert.ok(fresh.bundleDirectory.length > 0);
  }
});

test('injected non-crash failure publishes only a structurally valid failed bundle', async t => {
  const world = await support.createWorld(t, {});
  const result = await support.captureWorld(world, {
    snapshotId: 'capture-injected-failure',
    faults: { at: 'after-goal-sessions', mode: 'fail' },
  });
  assert.notEqual(result.status, 'ready');
  if (result.status === 'ready') throw new Error('unreachable');
  assert.equal(result.failure.code, 'INJECTED_FAILURE');
  assert.equal(result.bundleDirectory !== null, true);
  assert.equal(await world.captureService.readLastGood(), undefined);
  const verified = await verifyBundleDirectory(result.bundleDirectory!, { requireReady: false });
  assert.equal(verified.ok, true, JSON.stringify(verified.violations));
  const manifest = verified.manifest as BackupBundle;
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.failure?.code, 'INJECTED_FAILURE');
});

test('concurrent writer boundary: the published manifest is a component snapshot vector, not a live or common snapshot', async t => {
  const world = await support.createWorld(t, {});
  const ready = await support.captureReady(world, { snapshotId: 'capture-concurrent-writer', estimatedBytes: 1024 * 1024 });
  const manifest = await support.readManifest(ready.bundleDirectory);
  // A writer commits after the capture completed.
  const live = new DatabaseSync(world.controlPath);
  live.prepare('UPDATE shiyu_commit_watermark SET commit_seq=commit_seq+1 WHERE id=1').run();
  live.close();
  const facts = await support.readControlFixtureFacts(world);
  assert.equal(facts.watermarks.commitSeq, world.control.watermarks.commitSeq + 1);
  assert.equal(manifest.control?.commitSeq, world.control.watermarks.commitSeq);
  assert.equal(manifest.reconcileRequired, true);
  assert.equal(manifest.durability.crossComponentCommonSection, false);
  for (const component of manifest.components) {
    assert.ok(component.capturedAt.length > 0);
    assert.ok(component.quiescenceEvidence.length > 0);
  }
  const times = manifest.components.map((item) => item.capturedAt);
  assert.ok(times.every((time) => time <= manifest.completedAt));
  const verification = await verifyBundleDirectory(ready.bundleDirectory, { requireReady: true });
  assert.equal(verification.ok, true);
  // The live writer's later commit did not leak into the published bundle.
});

test('a writer active at capture start is contained: the published manifest reflects the snapshot, not later live state', async t => {
  let commitAtSnapshot = 0;
  const world = await support.createWorld(t, {
    controlAcquireHook: () => {
      // A live writer commits immediately before the online backup starts.
      const live = new DatabaseSync(worldControlPath());
      live.prepare('UPDATE shiyu_commit_watermark SET commit_seq=commit_seq+1 WHERE id=1').run();
      const row = live.prepare('SELECT commit_seq FROM shiyu_commit_watermark WHERE id=1').get() as { commit_seq: number };
      commitAtSnapshot = row.commit_seq;
      live.close();
    },
  });
  function worldControlPath(): string { return path.join(worldRootPath(), 'control.sqlite'); }
  function worldRootPath(): string { return world.root; }
  const ready = await support.captureReady(world, { snapshotId: 'capture-writer-at-start' });
  const manifest = await support.readManifest(ready.bundleDirectory);
  assert.equal(manifest.control?.commitSeq, commitAtSnapshot, 'manifest must record the watermarks read from the completed snapshot');
  assert.equal(manifest.control?.commitSeq, world.control.watermarks.commitSeq + 1);
  // A further live write after publish does not change the bundle or its lastGood pointer.
  const live = new DatabaseSync(path.join(world.root, 'control.sqlite'));
  live.prepare('UPDATE shiyu_commit_watermark SET commit_seq=commit_seq+1 WHERE id=1').run();
  live.close();
  const reread = await support.readManifest(ready.bundleDirectory);
  assert.equal(reread.control?.commitSeq, manifest.control?.commitSeq);
  assert.equal(reread.reconcileRequired, true);
  assert.equal(reread.durability.crossComponentCommonSection, false);
  const pointer = await world.captureService.readLastGood();
  assert.equal(pointer?.snapshotId, ready.snapshotId);
  assert.equal(pointer?.manifestSha256, ready.manifestSha256);
});

test('armed native Goal is captured as evidence but does not make the bundle non-ready', async t => {
  const world = await support.createWorld(t, { goals: { captureActivationOverrideFor: 'goal-alpha', failActivation: 'armed' } });
  const ready = await support.captureReady(world, { snapshotId: 'capture-armed-goal' });
  const manifest = await support.readManifest(ready.bundleDirectory);
  assert.equal(manifest.status, 'ready');
  const goalsManifest = JSON.parse(await readFile(path.join(ready.bundleDirectory, 'components/dsh-goal-sessions/manifest.json'), 'utf8')) as {
    sessions: { activation: string }[];
  };
  assert.equal(goalsManifest.sessions[0]?.activation, 'armed');
});

test('an empty GoalBinding set still produces a complete, verifiable dsh-goal-sessions component', async t => {
  const world = await support.createWorld(t, { control: { goalBindings: [] } });
  const ready = await support.captureReady(world, { snapshotId: 'capture-empty-goals' });
  const goalsManifest = JSON.parse(await readFile(path.join(ready.bundleDirectory, 'components/dsh-goal-sessions/manifest.json'), 'utf8')) as {
    sessions: unknown[];
  };
  assert.deepEqual(goalsManifest.sessions, []);
  const manifest = await support.readManifest(ready.bundleDirectory);
  const goalComponent = manifest.components.find((item) => item.componentId === 'dsh-goal-sessions')!;
  assert.equal(goalComponent.watermark, null);
  assert.ok(goalComponent.actualRevision !== null);
  const verification = await verifyBundleDirectory(ready.bundleDirectory, { requireReady: true });
  assert.equal(verification.ok, true, JSON.stringify(verification.violations));
});

test('opaque Goal Session tails are accepted only with bytes/hash evidence and no invented sequence', async t => {
  const world = await support.createWorld(t, { goals: { opaque: true } });
  const ready = await support.captureReady(world, { snapshotId: 'capture-opaque-tail' });
  const goalsManifest = JSON.parse(await readFile(path.join(ready.bundleDirectory, 'components/dsh-goal-sessions/manifest.json'), 'utf8')) as {
    sessions: { logFormat: string; logTail: { kind: string; lastSequence: number | null } }[];
  };
  assert.equal(goalsManifest.sessions[0]?.logFormat, 'opaque');
  assert.equal(goalsManifest.sessions[0]?.logTail.kind, 'opaque');
  assert.equal(goalsManifest.sessions[0]?.logTail.lastSequence, null);
  const verification = await verifyBundleDirectory(ready.bundleDirectory, { requireReady: true });
  assert.equal(verification.ok, true);
});

test('staging directory layout is deterministic and contains no absolute paths in manifests', async t => {
  const world = await support.createWorld(t, {});
  const ready = await support.captureReady(world, { snapshotId: 'capture-layout' });
  const entries = await readdir(ready.bundleDirectory);
  assert.deepEqual(entries.sort(), ['bundle.json', 'capture-journal.json', 'components']);
  const manifest = await support.readManifest(ready.bundleDirectory);
  const raw = JSON.stringify(manifest);
  assert.ok(!raw.includes(world.root), 'bundle manifest leaked an absolute staging path');
  assert.ok(!raw.includes(world.liveRoot), 'bundle manifest leaked the live root path');
});

test('capture rejects invalid snapshot ids and root identities up front', async t => {
  const world = await support.createWorld(t, {});
  await assert.rejects(world.captureService.capture({ snapshotId: '../escape', rootId: world.rootId, estimatedBytes: 0 }), /snapshotId/);
  await assert.rejects(world.captureService.capture({ snapshotId: 'ok', rootId: 'not-a-hash', estimatedBytes: 0 }), /rootId/);
  await assert.rejects(world.captureService.capture({ snapshotId: 'ok', rootId: world.rootId, estimatedBytes: -1 }), /estimatedBytes/);
});
