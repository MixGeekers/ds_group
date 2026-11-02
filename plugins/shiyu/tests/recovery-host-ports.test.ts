/**
 * H5b Runtime composition tests.
 *
 * Real temporary ControlStore worker + real temporary data directory and
 * Session logs; synthetic native-state/flush/projection/memory seams. No live
 * data root, no real `~/.dsh/sessions`, no model, no Ombre backend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as h5b from './recovery-h5b-support.js';
import { IsolatedRestoreService } from '../src/recovery/restore.js';
import { readBundleManifest, verifyBundleDirectory } from '../src/recovery/verify.js';
import { RuntimeCheckpointCommand } from '../src/recovery/runtime-command.js';
import { createHostControlSourcePort, detectSessionPersistenceLogResolver, createHostWorkspaceObjectPort } from '../src/recovery/host-ports.js';
import type { CaptureResult } from '../src/recovery/types.js';
import type { RecoveryBarrierEvidence } from '../src/recovery/types.js';
import type { GoalSessionPort } from '../src/recovery/ports.js';
import type { RuntimeCheckpointComposition } from '../src/recovery/host-ports.js';

const barrierFor = (world: h5b.RealHostWorld, overrides: Partial<RecoveryBarrierEvidence> = {}): RecoveryBarrierEvidence => ({
  source: 'synthetic-test',
  capturedAt: h5b.FIXED_TIME,
  completeness: 'complete',
  deletion: { baselineId: world.watermarks.deletionBaselineId, tombstoneWatermark: world.watermarks.tombstoneWatermark },
  authorization: { authEpoch: world.watermarks.authorizationEpoch },
  desiredState: { state: 'running', intentSeq: 1 },
  unavailableReasons: [],
  ...overrides,
});

/**
 * Live-root stability assertion. SQLite read-only access through WAL may update
 * the platform shared-memory coordination file (`-shm`); that is not a product
 * write. The database, WAL and every other file must stay byte-identical.
 */
const stableLiveTree = async (dataDir: string): Promise<{ relativePath: string; bytes: number; sha256: string }[]> =>
  (await h5b.snapshotTree(dataDir)).filter((file) => !file.relativePath.startsWith('control/events.sqlite'));

const captureFailure = (result: CaptureResult): { status: string; code: string } => {
  if (result.status === 'ready') throw new Error('expected a non-ready capture');
  return { status: result.status, code: result.failure.code };
};

const controlManifestOf = async (bundleDirectory: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(bundleDirectory, 'components', 'control', 'manifest.json'), 'utf8')) as Record<string, unknown>;

const goalManifestOf = async (bundleDirectory: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(bundleDirectory, 'components', 'dsh-goal-sessions', 'manifest.json'), 'utf8')) as Record<string, unknown>;

const sharedManifestOf = async (bundleDirectory: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(bundleDirectory, 'components', 'shared-objects', 'manifest.json'), 'utf8')) as Record<string, unknown>;

test('composition captures a ready bundle from a real ControlStore backup and the control live precheck', async t => {
  const world = await h5b.createRealHostWorld(t);
  await h5b.seedGoalBinding(world.store, { goalId: 'goal-h5b', sessionId: 'shiyu-goal-h5b', nativeGoalId: 'native-goal-h5b' });
  const fixture = await h5b.createComposition(world, {
    specs: [{ goalId: 'goal-h5b', sessionId: 'shiyu-goal-h5b', nativeGoalId: 'native-goal-h5b', phase: 'active', activation: 'disarmed' }],
  });
  const treeBefore = await stableLiveTree(world.dataDir);
  const dbBefore = (await h5b.snapshotTree(world.dataDir)).filter((file) => file.relativePath.startsWith('control/events.sqlite'));
  const result = await fixture.composition.capture('h5b-ready');
  assert.equal(result.status, 'ready', result.status === 'ready' ? '' : JSON.stringify(result.failure));
  if (result.status !== 'ready') return;
  assert.equal(result.manifest.status, 'ready');
  assert.equal(result.manifest.reconcileRequired, true);
  assert.deepEqual(result.manifest.components.map((item) => item.componentId).sort(), ['control', 'dsh-goal-sessions', 'memory', 'shared-objects']);
  const verification = await verifyBundleDirectory(result.bundleDirectory, { requireReady: true });
  assert.equal(verification.ok, true, JSON.stringify(verification.violations));
  const control = await controlManifestOf(result.bundleDirectory);
  const precheck = control.livePrecheck as { commitSeq: number; stateVersion: number } | undefined;
  assert.ok(precheck, 'control manifest must record the ControlStore live precheck');
  assert.equal(precheck!.commitSeq, await h5b.currentCommitSeq(world));
  assert.equal(precheck!.stateVersion, world.watermarks.stateVersion);
  // The control backup is a real SQLite copy read from the staged file.
  const copiedDb = new DatabaseSync(path.join(result.bundleDirectory, 'components/control/control.sqlite'), { readOnly: true });
  try {
    assert.equal(copiedDb.prepare('SELECT commit_seq FROM shiyu_commit_watermark WHERE id=1').get()?.commit_seq, await h5b.currentCommitSeq(world));
    assert.equal(copiedDb.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
  } finally { copiedDb.close(); }
  // Capture writes only the explicit staging root; the live data root content
  // (database + WAL + other files) is byte-identical. A read-only WAL reader may
  // refresh the platform -shm coordination file, which is not a product write.
  assert.deepEqual(await stableLiveTree(world.dataDir), treeBefore);
  const dbAfter = (await h5b.snapshotTree(world.dataDir)).filter((file) => file.relativePath.startsWith('control/events.sqlite'));
  assert.deepEqual(dbAfter.filter((file) => file.relativePath !== 'control/events.sqlite-shm'), dbBefore.filter((file) => file.relativePath !== 'control/events.sqlite-shm'));
  const lastGood = await fixture.composition.lastGood();
  assert.equal(lastGood?.snapshotId, 'h5b-ready');
});

test('Goal Session bytes are copied exactly and the durable tail/GoalRef/flush evidence is verified', async t => {
  const world = await h5b.createRealHostWorld(t);
  await h5b.seedGoalBinding(world.store, { goalId: 'goal-tail', sessionId: 'shiyu-goal-tail', nativeGoalId: 'native-goal-tail' });
  const fixture = await h5b.createComposition(world, {
    specs: [{ goalId: 'goal-tail', sessionId: 'shiyu-goal-tail', nativeGoalId: 'native-goal-tail', phase: 'paused', activation: 'disarmed' }],
  });
  const result = await fixture.composition.capture('h5b-goal-tail');
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  const goals = await goalManifestOf(result.bundleDirectory);
  const sessions = goals.sessions as { goalId: string; sessionId: string; logFile: string; logBytes: number; logSha256: string; logTail: { lastSequence: number }; flush: { kind: string; acknowledged: boolean }; projection: { digest: string } }[];
  assert.equal(sessions.length, 1);
  const session = sessions[0]!;
  assert.equal(session.goalId, 'goal-tail');
  const copied = await readFile(path.join(result.bundleDirectory, session.logFile));
  const sourcePath = fixture.sessions!.paths.get('shiyu-goal-tail')!;
  assert.deepEqual(copied, await readFile(sourcePath), 'copied Goal Session bytes must equal the source log');
  assert.equal(session.logBytes, copied.byteLength);
  assert.equal(session.logSha256, h5b.sha256(copied));
  assert.equal(session.logTail.lastSequence, 4);
  assert.equal(session.flush.kind, 'host-flush');
  assert.equal(session.flush.acknowledged, true);
  assert.equal(session.projection.digest, fixture.sessions!.projection.digest);
  const verification = await verifyBundleDirectory(result.bundleDirectory, { requireReady: true });
  assert.equal(verification.ok, true, JSON.stringify(verification.violations));
});

test('missing Goal Session log, missing projection and missing native state are explicit incomplete/blocked', async t => {
  const world = await h5b.createRealHostWorld(t);
  await h5b.seedGoalBinding(world.store, { goalId: 'goal-missing', sessionId: 'shiyu-goal-missing', nativeGoalId: 'native-goal-missing' });
  const base = { goalId: 'goal-missing', sessionId: 'shiyu-goal-missing', nativeGoalId: 'native-goal-missing', phase: 'active' as const, activation: 'disarmed' as const };
  const cases: { label: string; options: h5b.CompositionOptions; code: string }[] = [
    { label: 'missing-log', options: { specs: [{ ...base, omitLog: true }] }, code: 'MISSING_GOAL_SESSION' },
    { label: 'missing-projection', options: { specs: [base], omitProjection: true }, code: 'PROJECTION_EXPORT_UNAVAILABLE' },
    { label: 'missing-native-state', options: { specs: [{ ...base, nativeStateMissing: true }] }, code: 'GOAL_SESSION_EXPORT_UNAVAILABLE' },
    { label: 'missing-resolver', options: { specs: [base], omitResolver: true }, code: 'GOAL_SESSION_EXPORT_UNAVAILABLE' },
    { label: 'missing-flush', options: { specs: [{ ...base, flushAcknowledged: false }] }, code: 'MISSING_LOG_TAIL' },
    { label: 'unverifiable-format', options: { specs: [{ ...base, format: 'zstd' }] }, code: 'LOG_FORMAT_NOT_OFFLINE_VERIFIABLE' },
  ];
  for (const item of cases) {
    const fixture = await h5b.createComposition(world, item.options);
    const result = await fixture.composition.capture(`h5b-${item.label}`);
    const failure = captureFailure(result);
    assert.equal(failure.code, item.code, `${item.label}: unexpected code ${failure.code}`);
    assert.notEqual(failure.status, 'ready');
    assert.equal(await fixture.composition.lastGood(), undefined, `${item.label}: lastGood must not be published`);
  }
});

test('missing memory export makes the bundle incomplete and never ready', async t => {
  const world = await h5b.createRealHostWorld(t);
  await h5b.seedGoalBinding(world.store, { goalId: 'goal-mem', sessionId: 'shiyu-goal-mem', nativeGoalId: 'native-goal-mem' });
  const spec = { goalId: 'goal-mem', sessionId: 'shiyu-goal-mem', nativeGoalId: 'native-goal-mem', phase: 'active' as const, activation: 'disarmed' as const };
  const fixture = await h5b.createComposition(world, { specs: [spec], memoryUnavailable: true });
  const availability = fixture.composition.availability();
  assert.equal(availability.expectedReady, false);
  assert.equal(availability.components.find((item) => item.componentId === 'memory')?.status, 'unavailable');
  assert.equal(availability.components.find((item) => item.componentId === 'memory')?.code, 'MEMORY_EXPORT_UNAVAILABLE');
  assert.ok((availability.components.find((item) => item.componentId === 'memory')?.requiredScope.length ?? 0) > 0);
  const result = await fixture.composition.capture('h5b-memory-unavailable');
  const failure = captureFailure(result);
  assert.equal(failure.code, 'MEMORY_EXPORT_UNAVAILABLE');
  assert.equal(failure.status, 'incomplete');
  assert.equal(await fixture.composition.lastGood(), undefined);
});

test('production host composition (no synthetic seams) is explicitly blocked, never ready', async t => {
  const world = await h5b.createRealHostWorld(t);
  await h5b.seedGoalBinding(world.store, { goalId: 'goal-host', sessionId: 'shiyu-goal-host', nativeGoalId: 'native-goal-host' });
  const fixture = await h5b.createComposition(world, { memoryUnavailable: true });
  const availability = fixture.composition.availability();
  assert.equal(availability.expectedReady, false);
  const goal = availability.components.find((item) => item.componentId === 'dsh-goal-sessions')!;
  const memory = availability.components.find((item) => item.componentId === 'memory')!;
  assert.equal(goal.status, 'unavailable');
  assert.equal(goal.code, 'GOAL_SESSION_EXPORT_UNAVAILABLE');
  assert.equal(memory.status, 'unavailable');
  assert.equal(availability.blockers.length, 2);
  assert.ok(goal.requiredScope.some((item) => item.includes('log path')));
  const result = await fixture.composition.capture('h5b-production-blocked');
  assert.notEqual(result.status, 'ready');
  const manifest = await readBundleManifest(result.bundleDirectory!);
  assert.notEqual(manifest.bundle.status, 'ready');
  assert.equal(await fixture.composition.lastGood(), undefined);
});

test('staging interruption is incomplete and is never published as ready', async t => {
  const world = await h5b.createRealHostWorld(t);
  await h5b.seedGoalBinding(world.store, { goalId: 'goal-int', sessionId: 'shiyu-goal-int', nativeGoalId: 'native-goal-int' });
  const spec = { goalId: 'goal-int', sessionId: 'shiyu-goal-int', nativeGoalId: 'native-goal-int', phase: 'active' as const, activation: 'disarmed' as const };
  const fixture = await h5b.createComposition(world, { specs: [spec] });
  const result = await fixture.composition.capture('h5b-interrupt', { faults: { at: 'after-control-snapshot', mode: 'interrupt' } });
  assert.notEqual(result.status, 'ready');
  if (result.status === 'ready') return;
  assert.equal(result.failure.code, 'STAGING_INTERRUPTED');
  assert.equal(result.status, 'incomplete');
  assert.ok(result.partialDirectory !== null);
  assert.equal(await fixture.composition.lastGood(), undefined);
});

test('hash mismatch from a real workspace object read fails the capture', async t => {
  const world = await h5b.createRealHostWorld(t);
  await mkdir(path.join(world.dataDir, 'workspaces', 'task-a'), { recursive: true });
  const objectFile = path.join(world.dataDir, 'workspaces', 'task-a', 'artifact.txt');
  await writeFile(objectFile, 'synthetic artifact content');
  const workspacePort = await createHostWorkspaceObjectPort({ dataDir: world.dataDir });
  const inventory = await workspacePort.inventory();
  assert.equal(inventory.files.length, 1);
  const objectId = `ws-${h5b.sha256(inventory.files[0]!.relativePath).slice(0, 40)}`;
  await h5b.seedGoalBinding(world.store, { goalId: 'goal-obj', sessionId: 'shiyu-goal-obj', nativeGoalId: 'native-goal-obj' });
  const spec = { goalId: 'goal-obj', sessionId: 'shiyu-goal-obj', nativeGoalId: 'native-goal-obj', phase: 'active' as const, activation: 'disarmed' as const };
  // Mutate the file after the port cached its expected hash.
  await writeFile(objectFile, 'synthetic artifact content CHANGED');
  const fixture = await h5b.createComposition(world, { specs: [spec], sharedObjects: workspacePort, extra: { control: { objectRefs: [objectId] } } });
  const result = await fixture.composition.capture('h5b-object-hash');
  const failure = captureFailure(result);
  assert.equal(failure.code, 'HASH_MISMATCH');
  assert.notEqual(failure.status, 'ready');
});

test('workspace inventory is read-only, hash-verified and recorded in the shared-objects manifest', async t => {
  const world = await h5b.createRealHostWorld(t);
  await mkdir(path.join(world.dataDir, 'workspaces', 'nested'), { recursive: true });
  await writeFile(path.join(world.dataDir, 'workspaces', 'a.txt'), 'alpha');
  await writeFile(path.join(world.dataDir, 'workspaces', 'nested', 'b.bin'), Buffer.from([0, 1, 2, 3]));
  const outside = path.join(world.root, 'outside-secret.txt');
  await writeFile(outside, 'must not be inventoried or read');
  const { symlink } = await import('node:fs/promises');
  await symlink(outside, path.join(world.dataDir, 'workspaces', 'escape-link'));
  const port = await createHostWorkspaceObjectPort({ dataDir: world.dataDir });
  const inventory = await port.inventory();
  assert.equal(inventory.files.length, 2);
  assert.ok(inventory.excludedCount >= 1, 'symlink must be excluded from the inventory');
  const names = inventory.files.map((item) => item.relativePath).sort();
  assert.deepEqual(names, ['a.txt', 'nested/b.bin']);
  assert.equal(inventory.totalBytes, 9);
  assert.equal(inventory.aggregateSha256, h5b.sha256(h5b.canonicalJson(inventory.files)));
  await h5b.seedGoalBinding(world.store, { goalId: 'goal-inv', sessionId: 'shiyu-goal-inv', nativeGoalId: 'native-goal-inv' });
  const spec = { goalId: 'goal-inv', sessionId: 'shiyu-goal-inv', nativeGoalId: 'native-goal-inv', phase: 'active' as const, activation: 'disarmed' as const };
  const fixture = await h5b.createComposition(world, { specs: [spec] });
  const result = await fixture.composition.capture('h5b-inventory');
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  const shared = await sharedManifestOf(result.bundleDirectory);
  const recorded = shared.workspaceInventory as { files: { relativePath: string }[]; excludedCount: number; aggregateSha256: string };
  assert.deepEqual(recorded.files.map((item) => item.relativePath), ['a.txt', 'nested/b.bin']);
  assert.ok(recorded.excludedCount >= 1);
  assert.equal(recorded.aggregateSha256, inventory.aggregateSha256);
  // The inventory is evidence-only: workspace files themselves are not copied.
  const componentFiles = await readFile(path.join(result.bundleDirectory, 'components', 'shared-objects', 'manifest.json'), 'utf8');
  assert.ok(!componentFiles.includes('must not be inventoried'));
});

test('live data root and approved staging roots are enforced before any write', async t => {
  const world = await h5b.createRealHostWorld(t);
  const before = await stableLiveTree(world.dataDir);
  await assert.rejects(h5b.createComposition(world, { stagingRoot: path.join(world.dataDir, 'checkpoint') }), (error: unknown) => (error as { code?: string }).code === 'LIVE_ROOT_PROTECTED');
  const outside = path.join(world.root, 'unapproved-staging');
  await mkdir(outside, { recursive: true });
  await assert.rejects(h5b.createComposition(world, { stagingRoot: outside, allowedStagingRoots: [world.stagingRoot] }), (error: unknown) => (error as { code?: string }).code === 'TARGET_NOT_ISOLATED');
  assert.deepEqual(await stableLiveTree(world.dataDir), before);
  assert.equal(await readFile(path.join(world.dataDir, 'sentinel.txt'), 'utf8'), 'live-data-root-sentinel');
});

test('a ready composition bundle restores into an isolated root without touching the live data root', async t => {
  const world = await h5b.createRealHostWorld(t);
  await h5b.seedGoalBinding(world.store, { goalId: 'goal-restore', sessionId: 'shiyu-goal-restore', nativeGoalId: 'native-goal-restore' });
  const spec = { goalId: 'goal-restore', sessionId: 'shiyu-goal-restore', nativeGoalId: 'native-goal-restore', phase: 'active' as const, activation: 'armed' as const };
  const fixture = await h5b.createComposition(world, { specs: [spec] });
  const captured = await fixture.composition.capture('h5b-restore');
  assert.equal(captured.status, 'ready');
  if (captured.status !== 'ready') return;
  const before = await stableLiveTree(world.dataDir);
  const restore = new IsolatedRestoreService({ clock: world.clock });
  const targetRoot = path.join(world.isolatedRoot, 'restore-h5b');
  const result = await restore.restore({
    bundleDirectory: captured.bundleDirectory,
    targetRoot,
    isolatedRoot: world.isolatedRoot,
    liveDataRoot: world.dataDir,
    expectedRootId: fixture.composition.dataRootHash,
    barrier: barrierFor(world),
  });
  assert.equal(result.report.status, 'verified', JSON.stringify(result.report.failures));
  assert.equal(result.report.readView, 'read-only');
  assert.equal(result.report.dispatch, 'blocked');
  assert.equal(result.report.activate, 'not-activated');
  assert.notEqual(result.state, null);
  assert.equal(result.state!.control.commitSeq, await h5b.currentCommitSeq(world));
  assert.ok(result.state!.goals.every((goal) => goal.effectiveActivation === 'disarmed'));
  assert.equal(result.state!.memory.visibleRecords.length, 2);
  assert.deepEqual(await stableLiveTree(world.dataDir), before);
  assert.equal(await readFile(path.join(world.dataDir, 'sentinel.txt'), 'utf8'), 'live-data-root-sentinel');
});

test('control source uses the existing ControlStore read-only facts and never opens a writer', async t => {
  const world = await h5b.createRealHostWorld(t);
  const port = createHostControlSourcePort({
    dataDir: world.dataDir,
    controlStore: world.store,
    generation: world.generation,
    runtimeManifest: world.runtimeManifest,
    quiescenceEvidence: 'test: no writes issued',
  });
  const lease = await port.acquire();
  assert.equal(lease.rootId, h5b.sha256(`shiyu-data-root:v1:${path.resolve(world.dataDir)}`));
  assert.equal(lease.liveFacts?.commitSeq, await h5b.currentCommitSeq(world));
  assert.equal(lease.liveFacts?.stateVersion, world.watermarks.stateVersion);
  assert.equal(path.basename(lease.databasePath), 'events.sqlite');
  await lease.release();
  // A missing control DB is unavailable, not silently recreated.
  const bad = createHostControlSourcePort({
    dataDir: path.join(world.root, 'missing-data-root'),
    controlStore: world.store,
    generation: world.generation,
    runtimeManifest: world.runtimeManifest,
    quiescenceEvidence: 'test: unavailable',
  });
  await assert.rejects(bad.acquire(), (error: unknown) => (error as { code?: string }).code === 'CONTROL_FACTS_UNAVAILABLE');
});

test('candidate JSONL persistence resolver is detected only when the diagnostic method exists', async () => {
  const logs = new Map([['session-a', '/tmp/session-a.jsonl']]);
  const resolver = detectSessionPersistenceLogResolver(h5b.fakeJsonlPersistence(logs));
  assert.ok(resolver);
  assert.equal(resolver!.provenance, 'jsonl-internal-diagnostic');
  assert.deepEqual(await resolver!.resolve('session-a'), { path: '/tmp/session-a.jsonl', format: 'jsonl-plain' });
  assert.equal(await resolver!.resolve('session-missing'), undefined);
  assert.equal(detectSessionPersistenceLogResolver({}), null);
  assert.equal(detectSessionPersistenceLogResolver({ resolveCurrentLog: 42 }), null);
  const zstd = detectSessionPersistenceLogResolver(h5b.fakeJsonlPersistence(logs, 'zstd'));
  assert.equal((await zstd!.resolve('session-a'))?.format, 'zstd');
});

const fakeComposition = (overrides: {
  captureCalls: { count: number };
  captureResult?: CaptureResult | (() => CaptureResult);
  availability?: RuntimeCheckpointComposition['availability'];
}): RuntimeCheckpointComposition => ({
  dataRootHash: h5b.sha256('root'),
  stagingRootHash: h5b.sha256('staging'),
  dataDir: '/tmp/synthetic-data-root',
  stagingRoot: '/tmp/synthetic-staging',
  generation: { installationGeneration: 'gen-cmd', hostEpoch: 'epoch-cmd' },
  async capture(snapshotId: string) {
    overrides.captureCalls.count += 1;
    const value = overrides.captureResult ?? (() => ({
      status: 'incomplete' as const,
      snapshotId,
      failure: { code: 'MEMORY_EXPORT_UNAVAILABLE', componentId: 'memory', message: 'synthetic unavailable' },
      bundleDirectory: null,
      partialDirectory: null,
      lastGoodUpdated: false as const,
    }));
    return typeof value === 'function' ? value() : value;
  },
  availability: overrides.availability ?? (() => ({
    stagingRootHash: h5b.sha256('staging'), dataRootHash: h5b.sha256('root'),
    components: [
      { componentId: 'control', status: 'available', source: 'host', code: null, detail: '', requiredScope: [] },
      { componentId: 'dsh-goal-sessions', status: 'available', source: 'injected', code: null, detail: '', requiredScope: [] },
      { componentId: 'memory', status: 'unavailable', source: 'host', code: 'MEMORY_EXPORT_UNAVAILABLE', detail: '', requiredScope: ['export api'] },
      { componentId: 'shared-objects', status: 'available', source: 'host', code: null, detail: '', requiredScope: [] },
    ],
    expectedReady: false,
    blockers: [{ componentId: 'memory', code: 'MEMORY_EXPORT_UNAVAILABLE', requiredScope: ['export api'] }],
  })),
  async lastGood() { return undefined; },
});

test('owner-only command handler: explicit-only, single-flight, pause-preserving, no retry', async () => {
  const captureCalls = { count: 0 };
  let paused = false;
  const pausedSetterCalls = { count: 0 };
  const withComposition = new RuntimeCheckpointCommand({
    composition: fakeComposition({ captureCalls }),
    isOpen: () => true,
    isPaused: () => paused,
    snapshotId: () => 'command-snapshot-1',
  });
  // Creating the handler or reading state never triggers a capture.
  assert.equal(captureCalls.count, 0);
  const result = await withComposition.handle({ action: 'runtime.checkpoint.capture', requestId: 'req-1' });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.retried, false);
  assert.equal(result.autoTriggered, false);
  assert.equal(result.desiredState, 'unchanged');
  assert.equal(captureCalls.count, 1);
  assert.equal(result.snapshotId, 'command-snapshot-1');
  assert.equal(result.blockedComponents[0]?.code, 'MEMORY_EXPORT_UNAVAILABLE');

  // Paused runtime: allowed, recorded, never toggled.
  paused = true;
  const pausedResult = await withComposition.handle({ action: 'runtime.checkpoint.capture' });
  assert.equal(pausedResult.pausedAtRequest, true);
  assert.equal(pausedResult.desiredState, 'unchanged');
  assert.equal(pausedSetterCalls.count, 0);
  assert.equal(captureCalls.count, 2);

  // Invalid input and unknown fields are rejected, not attempted.
  await assert.rejects(withComposition.handle({ action: 'runtime.checkpoint.capture', extra: true }), (error: unknown) => (error as { code?: string }).code === 'CHECKPOINT_INPUT_INVALID');
  await assert.rejects(withComposition.handle({ action: 'runtime.resume' }), (error: unknown) => (error as { code?: string }).code === 'CHECKPOINT_INPUT_INVALID');
  assert.equal(captureCalls.count, 2);

  // Unconfigured staging root: explicit unavailable, no capture attempted.
  const unconfigured = new RuntimeCheckpointCommand({ isOpen: () => true, isPaused: () => false, now: () => new Date(h5b.FIXED_TIME) });
  const unavailable = await unconfigured.handle({ action: 'runtime.checkpoint.capture' });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.code, 'CHECKPOINT_STAGING_UNCONFIGURED');
});

test('owner-only command handler never queues a concurrent request', async () => {
  const captureCalls = { count: 0 };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const composition = fakeComposition({
    captureCalls,
    captureResult: () => ({ status: 'incomplete', snapshotId: 'busy-snapshot', failure: { code: 'CONTROL_FACTS_UNAVAILABLE', componentId: 'control', message: 'synthetic' }, bundleDirectory: null, partialDirectory: null, lastGoodUpdated: false }),
  });
  const originalCapture = composition.capture.bind(composition);
  (composition as { capture: RuntimeCheckpointComposition['capture'] }).capture = async (snapshotId) => { await gate; return originalCapture(snapshotId); };
  const command = new RuntimeCheckpointCommand({ composition, isOpen: () => true, isPaused: () => false, snapshotId: () => 'busy-snapshot' });
  const first = command.handle({ action: 'runtime.checkpoint.capture', requestId: 'a' });
  const second = await command.handle({ action: 'runtime.checkpoint.capture', requestId: 'b' });
  assert.equal(second.status, 'busy');
  assert.equal(second.code, 'CHECKPOINT_BUSY');
  release();
  const firstResult = await first;
  assert.equal(firstResult.status, 'incomplete');
  assert.equal(captureCalls.count, 1, 'a concurrent request must not queue a second capture');
});
