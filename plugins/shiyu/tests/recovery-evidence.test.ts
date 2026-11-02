/**
 * H5-B1 evidence generator.
 *
 * Executes the same offline fault matrix and validator self-proof used by the
 * tests, then writes machine-checkable evidence JSON to
 * `plugins/shiyu/artifacts/dsh/h5/`. The evidence is regenerated when
 * SHIYU_WRITE_EVIDENCE=1 or when the artifact does not exist yet; a normal
 * `npm run check` does not rewrite it.
 *
 * The evidence explicitly states what this slice is NOT: no live DSH host, no
 * live data root/native Session/database, no model calls, no independent backup
 * fault domain, no RPO/RTO claim, and no cross-component common-section claim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { runEvidenceMatrix } from './recovery-matrix.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactDirectory = path.join(packageRoot, 'artifacts', 'dsh', 'h5');
const matrixFile = path.join(artifactDirectory, 'h5-recovery-matrix.json');
const selfProofFile = path.join(artifactDirectory, 'h5-recovery-validator-selftest.json');

const sha256 = async (filename: string): Promise<string> => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(await readFile(filename)).digest('hex');
};

const exists = async (filename: string): Promise<boolean> => {
  try { await access(filename); return true; } catch { return false; }
};

const gitMetadata = (): Record<string, unknown> => {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: packageRoot, encoding: 'utf8' });
    const lines = status.split('\n').filter((line) => line.length > 0);
    return { head, trackedChanges: lines.filter((line) => !line.startsWith('??')).length, untracked: lines.filter((line) => line.startsWith('??')).length };
  } catch {
    return { head: null, trackedChanges: null, untracked: null, note: 'git metadata unavailable (non-git environment); source file hashes remain authoritative' };
  }
};

const buildFingerprint = async (): Promise<Record<string, unknown>> => {
  const readJsonFile = async (relative: string): Promise<Record<string, unknown> | null> => {
    try { return JSON.parse(await readFile(path.join(packageRoot, relative), 'utf8')) as Record<string, unknown>; } catch { return null; }
  };
  const js = async (relative: string): Promise<Record<string, unknown>> => (await readJsonFile(relative)) ?? {};
  const typescript = await js('node_modules/typescript/package.json');
  const tsx = await js('node_modules/tsx/package.json');
  const tsconfig = await sha256(path.join(packageRoot, 'tsconfig.build.json'));
  const packageJson = await sha256(path.join(packageRoot, 'package.json'));
  const packageLock = await sha256(path.join(packageRoot, 'package-lock.json'));
  return {
    buildCommand: 'npm run check -> tsc --noEmit && node --import tsx --test tests/*.test.ts && tsc -p tsconfig.build.json && node --check client/index.js',
    typescriptVersion: typescript.version ?? null,
    tsxVersion: tsx.version ?? null,
    tsconfigBuildSha256: tsconfig,
    packageJsonSha256: packageJson,
    packageLockSha256: packageLock,
  };
};

const sqliteVersion = (): string => {
  const db = new DatabaseSync(':memory:');
  try {
    const row = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    return row.version;
  } finally { db.close(); }
};

const moduleIdentity = async (): Promise<{ files: { path: string; sha256: string }[]; testFiles: { path: string; sha256: string }[] }> => {
  const sourceDirectory = path.join(packageRoot, 'src', 'recovery');
  const testDirectory = path.join(packageRoot, 'tests');
  const sourceNames = (await readdir(sourceDirectory)).filter((name) => name.endsWith('.ts') || name.endsWith('.md')).sort();
  const testNames = (await readdir(testDirectory)).filter((name) => name.startsWith('recovery-') && name.endsWith('.ts')).sort();
  const files = [];
  for (const name of sourceNames) files.push({ path: `src/recovery/${name}`, sha256: await sha256(path.join(sourceDirectory, name)) });
  const testFiles = [];
  for (const name of testNames) testFiles.push({ path: `tests/${name}`, sha256: await sha256(path.join(testDirectory, name)) });
  return { files, testFiles };
};

test('evidence generator: offline fault matrix and validator self-proof produce reproducible JSON', async () => {
  const matrix = await runEvidenceMatrix();
  assert.equal(matrix.summary.failed, 0, `matrix failures: ${JSON.stringify(matrix.records.filter((item) => !item.pass), null, 2)}`);
  assert.equal(matrix.summary.selfProofPassed, matrix.summary.selfProofTotal);
  assert.ok(matrix.summary.total >= 25, `matrix too small: ${matrix.summary.total}`);
  assert.ok(matrix.summary.selfProofTotal >= 15, `self-proof too small: ${matrix.summary.selfProofTotal}`);
  const identity = await moduleIdentity();
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    sqliteVersion: sqliteVersion(),
    os: process.env.OS ?? null,
    tsxVersion: (JSON.parse(await readFile(path.join(packageRoot, 'node_modules/tsx/package.json'), 'utf8')) as { version?: string }).version ?? null,
  };
  const build = await buildFingerprint();
  const boundaries = {
    evidenceLayer: 'G1 offline module + synthetic ports',
    offlineModuleOnly: true,
    syntheticBackends: true,
    wiredIntoRuntime: false,
    liveDataRootTouched: false,
    liveNativeSessionTouched: false,
    liveControlDatabaseTouched: false,
    modelCalls: 0,
    realChannelOrDeviceCalls: 0,
    crossComponentCommonSectionClaimed: false,
    independentFaultDomain: false,
    rpoRtoClaimed: false,
    v22Claim: 'sub-scenarios only; full V22 requires fixed-host/fault-domain evidence',
    v27Claim: 'not attempted; requires an independent failure domain and offline recovery credentials',
    fullHostAcceptance: false,
    independentFaultDomainAcceptance: false,
  };
  const coverage = {
    breakpointFamilies: {
      controlCommittedComponentExecutedLocalUnconfirmed: 'capture.unknown-breakpoints',
      stagingInterruptedBeforePublish: 'capture.staging-interrupted',
      stagingFailureNotReady: 'capture.staging-failed-not-ready',
      missingGoalSessionOrProjection: ['capture.missing-goal-session', 'capture.missing-projection'],
      hashMismatch: ['capture.hash-mismatch', 'capture.goal-tail-mismatch', 'restore.tampered-bundle-rejected'],
      oldDeletionLedger: ['restore.old-deletion-ledger-locked', 'restore.old-deletion-ledger-replayed'],
      restorePositive: 'restore.verified-positive',
      v15Like: ['capture.staging-interrupted', 'capture.failure-preserves-lastgood', 'capture.capacity-insufficient'],
      v22Like: [
        'capture.ready', 'capture.concurrent-writer-boundary', 'restore.control-tombstone-replay',
        'restore.armed-goal-disarmed', 'restore.unknown-breakpoints',
      ],
    },
    notCovered: [
      'live DSH host / native Goal Session service integration',
      'real Ombre export archive and its own manifest/hash/closure',
      'independent backup repository, encryption, offline credentials (V27)',
      'RPO/RTO measurement from a completed independent backup',
      'crash at OS level during fsync/rename (only deterministic staging interruptions)',
      'multi-process double-writer at the OS level (only recovery-lock exclusivity)',
      'migration of an older bundle schema by a newer reader',
    ],
  };
  const fingerprints = {
    source: { git: gitMetadata(), moduleFiles: identity.files },
    build,
    tests: { files: identity.testFiles, command: 'node --import tsx --test tests/recovery-*.test.ts' },
    environment,
  };
  const denominators = {
    planned: matrix.records.length,
    executed: matrix.records.length,
    passed: matrix.summary.passed,
    failed: matrix.summary.failed,
    skipped: 0,
    unknown: 0,
    notApplicable: 0,
    selfProof: { planned: matrix.summary.selfProofTotal, executed: matrix.summary.selfProofTotal, passed: matrix.summary.selfProofPassed, failed: matrix.summary.selfProofTotal - matrix.summary.selfProofPassed },
  };
  const matrixEvidence = {
    schemaVersion: 1,
    slice: 'H5-B1',
    title: '本地检查点与隔离恢复模块：离线故障/边界矩阵',
    generatedAt: new Date().toISOString(),
    evidenceLevel: 'G1 offline module + synthetic ports (real temporary SQLite/files)',
    fingerprints,
    denominators,
    boundaries,
    coverage,
    summary: matrix.summary,
    cases: matrix.records,
    regeneration: {
      command: 'SHIYU_WRITE_EVIDENCE=1 node --import tsx --test tests/recovery-evidence.test.ts',
      sourceOfTruth: 'tests/recovery-matrix.ts (the same runner the fault-matrix test asserts)',
    },
  };
  const selfProofEvidence = {
    schemaVersion: 1,
    slice: 'H5-B1',
    title: '校验器自证：已知正确样本接受、已知错误样本拒绝',
    generatedAt: new Date().toISOString(),
    fingerprints: { source: fingerprints.source, build: fingerprints.build, environment },
    summary: { total: matrix.selfProof.length, passed: matrix.summary.selfProofPassed },
    cases: matrix.selfProof,
    boundary: '按声明式 schema/语义判定；文件 hash/closure 由 verifyBundleDirectory 从真实字节复核。不能证明业务正确、授权有效或完整采集。',
  };

  const shouldWrite = process.env.SHIYU_WRITE_EVIDENCE === '1' || !await exists(matrixFile);
  if (shouldWrite) {
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(matrixFile, `${JSON.stringify(matrixEvidence, null, 2)}\n`);
    await writeFile(selfProofFile, `${JSON.stringify(selfProofEvidence, null, 2)}\n`);
  }
  assert.equal(await exists(matrixFile), true, 'matrix evidence file must exist');
  assert.equal(await exists(selfProofFile), true, 'validator self-proof evidence file must exist');

  const persisted = JSON.parse(await readFile(matrixFile, 'utf8')) as {
    schemaVersion: number; slice: string;
    boundaries: { crossComponentCommonSectionClaimed: boolean; independentFaultDomain: boolean };
    summary: { total: number; failed: number };
    denominators: { planned: number; executed: number; passed: number; failed: number; skipped: number };
    fingerprints: { source: { git: { head: string | null }; moduleFiles: { path: string; sha256: string }[] }; build: { typescriptVersion: string | null }; tests: { files: { path: string; sha256: string }[] } };
    coverage: { breakpointFamilies: Record<string, unknown> };
    cases: { caseId: string; pass: boolean; injectionPoint: string }[];
  };
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.slice, 'H5-B1');
  assert.equal(persisted.cases.every((item) => item.pass), true);
  assert.equal(persisted.summary.failed, 0);
  assert.equal(persisted.denominators.planned, persisted.denominators.executed);
  assert.equal(persisted.denominators.failed, 0);
  assert.equal(persisted.denominators.skipped, 0);
  assert.ok(persisted.fingerprints.source.moduleFiles.length >= 8);
  assert.ok(persisted.fingerprints.source.moduleFiles.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.ok(persisted.fingerprints.tests.files.length >= 5);
  assert.ok(persisted.fingerprints.build.typescriptVersion !== null);
  assert.ok(persisted.cases.every((item) => typeof item.injectionPoint === 'string' && item.injectionPoint !== 'unspecified'), 'every case must state its injection point');
  assert.equal(persisted.boundaries.crossComponentCommonSectionClaimed, false);
  assert.equal(persisted.boundaries.independentFaultDomain, false);
  assert.ok(Object.keys(persisted.coverage.breakpointFamilies).length >= 8);

  const persistedSelfProof = JSON.parse(await readFile(selfProofFile, 'utf8')) as {
    summary: { total: number; passed: number };
    cases: { pass: boolean; expected: string }[];
  };
  assert.equal(persistedSelfProof.summary.total, persistedSelfProof.summary.passed);
  assert.ok(persistedSelfProof.cases.some((item) => item.expected === 'accepted'));
  assert.ok(persistedSelfProof.cases.some((item) => item.expected === 'rejected'));

  // Evidence must not contain absolute temporary working paths.
  const matrixText = await readFile(matrixFile, 'utf8');
  assert.ok(!matrixText.includes('/tmp/'), 'evidence leaked a temporary absolute path');
  assert.ok(!matrixText.includes('\\tmp\\'), 'evidence leaked a temporary absolute path');
});

test('evidence files never claim live-host / independent-fault-domain acceptance', async () => {
  const matrixText = await readFile(matrixFile, 'utf8');
  const parsed = JSON.parse(matrixText) as { boundaries: Record<string, unknown>; coverage: { notCovered: string[] } };
  assert.equal(parsed.boundaries.liveDataRootTouched, false);
  assert.equal(parsed.boundaries.liveNativeSessionTouched, false);
  assert.equal(parsed.boundaries.modelCalls, 0);
  assert.equal(parsed.boundaries.fullHostAcceptance, false);
  assert.equal(parsed.boundaries.independentFaultDomainAcceptance, false);
  assert.equal(String(parsed.boundaries.v27Claim).startsWith('not attempted'), true);
  assert.ok(parsed.coverage.notCovered.length >= 5);
});
