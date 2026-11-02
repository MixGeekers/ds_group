/**
 * H5b evidence generator: Runtime composition matrix, production-host blockers,
 * integration diff identity and boundaries. Regenerated when
 * SHIYU_WRITE_EVIDENCE=1 or when the artifact does not exist yet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { runH5bMatrix } from './recovery-h5b-matrix.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const artifactDirectory = path.join(packageRoot, 'artifacts', 'dsh', 'h5');
const evidenceFile = path.join(artifactDirectory, 'h5b-runtime-integration.json');
const diffFile = path.join(artifactDirectory, 'runtime-checkpoint-capture.diff');

const sha256 = async (filename: string): Promise<string> => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(await readFile(filename)).digest('hex');
};

const exists = async (filename: string): Promise<boolean> => {
  try { await access(filename); return true; } catch { return false; }
};

const sqliteVersion = (): string => {
  const db = new DatabaseSync(':memory:');
  try { return (db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version; } finally { db.close(); }
};

const gitMetadata = (): Record<string, unknown> => {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
    const lines = status.split('\n').filter((line) => line.length > 0);
    return { head, trackedChanges: lines.filter((line) => !line.startsWith('??')).length, untracked: lines.filter((line) => line.startsWith('??')).length };
  } catch {
    return { head: null, note: 'git metadata unavailable; file hashes remain authoritative' };
  }
};

const fileIdentity = async (relative: string): Promise<{ path: string; sha256: string }> => ({
  path: relative, sha256: await sha256(path.join(packageRoot, relative)),
});

test('H5b runtime composition matrix passes and production host remains explicitly blocked', async () => {
  const matrix = await runH5bMatrix();
  const failed = matrix.records.filter((item) => !item.pass);
  assert.deepEqual(failed, [], `matrix failures: ${JSON.stringify(failed, null, 2)}`);
  const required = [
    'composition.control-backup-and-precheck',
    'composition.goal-bytes-and-tail',
    'composition.goal-missing-log',
    'composition.goal-missing-projection',
    'composition.goal-native-state-unavailable',
    'composition.goal-unverifiable-format',
    'composition.memory-unavailable',
    'composition.production-host-blocked',
    'composition.staging-interrupted',
    'composition.hash-mismatch',
    'composition.live-root-rejected',
    'composition.isolated-restore-verified',
    'composition.workspace-inventory',
    'composition.command-single-flight',
    'composition.resolver-candidate-provenance',
  ];
  const observed = new Set(matrix.records.map((item) => item.caseId));
  assert.deepEqual(required.filter((item) => !observed.has(item)), []);
  assert.equal(matrix.summary.failed, 0);
  assert.equal(matrix.summary.total, matrix.records.length);
  assert.ok(matrix.summary.total >= required.length);
  for (const record of matrix.records) {
    assert.equal(record.evidenceLayer, 'G1+offline-composition-synthetic-seams');
    assert.ok(record.injectionPoint.length > 0 && record.injectionPoint !== 'unspecified');
  }
  // The production host must never present a ready bundle in this slice.
  assert.equal(matrix.productionHost.readyObtainable, false);
  assert.notEqual(matrix.productionHost.observedCaptureStatus, 'ready');
  const blockerCodes = matrix.productionHost.blockers.map((item) => item.code);
  assert.ok(blockerCodes.includes('GOAL_SESSION_EXPORT_UNAVAILABLE'), `missing goal blocker: ${blockerCodes.join(',')}`);
  assert.ok(blockerCodes.includes('MEMORY_EXPORT_UNAVAILABLE'), `missing memory blocker: ${blockerCodes.join(',')}`);
  assert.ok(matrix.productionHost.blockers.every((item) => item.requiredScope.length > 0));

  // Integration diff exists, hashes, and applies cleanly to the pinned runtime.ts.
  assert.equal(await exists(diffFile), true, 'integration diff artifact is missing');
  const diffText = await readFile(diffFile, 'utf8');
  assert.ok(diffText.includes('a/plugins/shiyu/src/runtime.ts') && diffText.includes("action === 'runtime.checkpoint.capture'"));
  assert.ok(diffText.includes('checkpointStagingRoot') && diffText.includes('checkpointRuntimeManifest'));
  let applies = false;
  try {
    execFileSync('git', ['apply', '--check', diffFile], { cwd: repoRoot, stdio: 'pipe' });
    applies = true;
  } catch { applies = false; }
  assert.equal(applies, true, 'integration diff does not apply cleanly to the current runtime.ts');

  const sourceFiles = [
    'src/recovery/host-ports.ts',
    'src/recovery/runtime-command.ts',
    'src/recovery/capture.ts',
    'src/recovery/types.ts',
    'src/recovery/ports.ts',
    'src/recovery/schema.ts',
    'src/recovery/verify.ts',
    'src/recovery/restore.ts',
    'src/recovery/README.md',
  ];
  const testFiles = [
    'tests/recovery-h5b-support.ts',
    'tests/recovery-h5b-matrix.ts',
    'tests/recovery-host-ports.test.ts',
    'tests/recovery-h5b-evidence.test.ts',
  ];
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    sqliteVersion: sqliteVersion(),
    os: process.env.OS ?? null,
    tsxVersion: (JSON.parse(await readFile(path.join(packageRoot, 'node_modules', 'tsx', 'package.json'), 'utf8')) as { version?: string }).version ?? null,
  };
  const source = await Promise.all(sourceFiles.map(fileIdentity));
  const tests = await Promise.all(testFiles.map(fileIdentity));
  const boundaries = {
    slice: 'H5b',
    evidenceLevel: 'G1+ offline Runtime composition + synthetic Goal/memory seams',
    runtimeWiredInThisSlice: false,
    integrationDiffAppliedByLead: false,
    liveDataRootTouched: false,
    liveNativeSessionTouched: false,
    liveControlDatabaseWritten: false,
    modelCalls: 0,
    realOmbreBackendUsed: false,
    realChannelOrDeviceCalls: 0,
    memoryExportAvailableOnCurrentHost: false,
    goalSessionPublicApiAvailableOnCurrentHost: false,
    productionHostReady: false,
    readyPathValidatedWithSyntheticSeamsOnly: true,
    activationImplemented: false,
    h5B1ArtifactsHistorical: 'artifacts/dsh/h5/h5-recovery-matrix.json + h5-recovery-validator-selftest.json were generated for the H5-B1 submission (5a7bc9e) and are not rewritten by H5b; H5b additive schema fields are optional/backward compatible and this file records the current source/test fingerprints.',
    schemaChangesAreAdditive: ['control.livePrecheck', 'dsh-goal-sessions.excludedBindings', 'shared-objects.workspaceInventory', 'restore-report.goalExclusions'],
    v22Claim: 'sub-scenarios only; composition capture/restore on synthetic seams',
    v27Claim: 'not attempted; requires an independent failure domain and offline recovery credentials',
    fullHostAcceptance: false,
  };
  const evidence = {
    schemaVersion: 1,
    slice: 'H5b',
    title: '检查点 Runtime 组合层接入：离线端口适配、精确集成 diff 与故障矩阵',
    generatedAt: new Date().toISOString(),
    evidenceLevel: 'G1+ offline Runtime composition (real temporary ControlStore/SQLite/Session files; synthetic native-state/flush/projection/memory seams)',
    environment,
    fingerprints: {
      source: { git: gitMetadata(), moduleFiles: source },
      build: {
        buildCommand: 'npm run check (tsc --noEmit + node --import tsx --test tests/*.test.ts + tsc -p tsconfig.build.json + node --check client/index.js)',
        tsconfigBuildSha256: await sha256(path.join(packageRoot, 'tsconfig.build.json')),
        packageJsonSha256: await sha256(path.join(packageRoot, 'package.json')),
        packageLockSha256: await sha256(path.join(packageRoot, 'package-lock.json')),
      },
      tests: { files: tests, command: 'node --import tsx --test tests/recovery-host-ports.test.ts tests/recovery-h5b-evidence.test.ts' },
    },
    integrationDiff: {
      path: 'artifacts/dsh/h5/runtime-checkpoint-capture.diff',
      sha256: await sha256(diffFile),
      bytes: (await readFile(diffFile)).byteLength,
      appliesToPinnedRuntime: applies,
      target: 'src/runtime.ts (Lead applies; this slice does not edit it)',
      preconditions: [
        'RuntimeOptions.checkpointStagingRoot is a trusted absolute path outside dataDir; otherwise the command returns CHECKPOINT_STAGING_UNCONFIGURED and never falls back to temp.',
        'RuntimeOptions.checkpointRuntimeManifest is a trusted fixed host identity; the composition never guesses a host version from a request.',
        'The command is dispatched before ensureCanRun() so a paused runtime can snapshot local state; it performs no model calls, dispatches nothing and does not change pause state.',
        'Composition creation is lazy and happens only inside the explicit command; GET/snapshot/status paths never call it.',
        'A failed attempt is returned as a structured failed/incomplete result and recorded in the diagnostic field; it is never retried automatically and never queued.',
      ],
      failureDegradation: [
        'Goal Session path/state/projection/flush unavailable → component explicitly unavailable → Bundle incomplete, never ready.',
        'Managed Ombre export unavailable → memory component explicitly unavailable → Bundle incomplete, never ready.',
        'Capture failure or staging interruption → structured failed/incomplete result; lastGood is not replaced.',
      ],
    },
    boundaries,
    blockers: matrix.productionHost.blockers,
    matrix: matrix.records,
    summary: matrix.summary,
    productionHost: matrix.productionHost,
    regeneration: {
      command: 'SHIYU_WRITE_EVIDENCE=1 node --import tsx --test tests/recovery-h5b-evidence.test.ts',
      sourceOfTruth: 'tests/recovery-h5b-matrix.ts (same runner the tests assert)',
    },
  };
  const shouldWrite = process.env.SHIYU_WRITE_EVIDENCE === '1' || !await exists(evidenceFile);
  if (shouldWrite) {
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  assert.equal(await exists(evidenceFile), true);
  const persisted = JSON.parse(await readFile(evidenceFile, 'utf8')) as {
    schemaVersion: number; slice: string; boundaries: Record<string, unknown>;
    summary: { total: number; passed: number; failed: number };
    matrix: { caseId: string; pass: boolean; injectionPoint: string }[];
    blockers: { code: string; requiredScope: string[] }[];
    fingerprints: { source: { moduleFiles: { sha256: string }[] }; tests: { files: { sha256: string }[] }; build: { tsconfigBuildSha256: string } };
    integrationDiff: { sha256: string; appliesToPinnedRuntime: boolean };
  };
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.slice, 'H5b');
  assert.equal(persisted.summary.failed, 0);
  assert.equal(persisted.matrix.every((item) => item.pass && item.injectionPoint.length > 0), true);
  assert.equal(persisted.boundaries.productionHostReady, false);
  assert.equal(persisted.boundaries.memoryExportAvailableOnCurrentHost, false);
  assert.equal(persisted.boundaries.goalSessionPublicApiAvailableOnCurrentHost, false);
  assert.equal(persisted.boundaries.runtimeWiredInThisSlice, false);
  assert.equal(persisted.boundaries.fullHostAcceptance, false);
  assert.ok(persisted.blockers.some((item) => item.code === 'MEMORY_EXPORT_UNAVAILABLE' && item.requiredScope.length > 0));
  assert.ok(persisted.fingerprints.source.moduleFiles.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.ok(persisted.fingerprints.tests.files.length >= 4);
  assert.ok(/^[a-f0-9]{64}$/.test(persisted.fingerprints.build.tsconfigBuildSha256));
  assert.equal(persisted.integrationDiff.appliesToPinnedRuntime, true);
  const text = await readFile(evidenceFile, 'utf8');
  assert.ok(!text.includes('/tmp/'), 'evidence leaked a temporary absolute path');
});
