/**
 * H7-round14 tests: round-13 header-cut probe / correction / review evidence is
 * bound as limited diagnostic evidence; nothing here can be a pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVIDENCE_SOURCES,
  LIMITED_EVIDENCE_LEVELS,
  PRODUCT_EVIDENCE_MAPPINGS,
  buildSystemEvidenceSummaries,
  checkEvidenceMappingHonesty,
  evaluateEvidenceMapping,
  verifyEvidenceFileFacts,
  verifyEvidenceSources,
  type EvidenceLevel,
  type EvidenceVerificationReport,
} from './harness/evidence.js';
import { PRODUCT_KINDS } from './harness/traceability-registry.js';
import { sha256Hex } from './harness/invariant.js';
import { MODULE_DEFINITIONS } from './harness/acceptance-registry.js';
import { buildAcceptanceReport, checkAcceptanceHonesty, type AcceptanceInputs } from './harness/acceptance.js';
import type { CoverageIndex } from './harness/business/coverage.js';
import type { TraceabilityMatrix } from './harness/traceability.js';
import type { SelfProofArtifact } from './harness/selfproof.js';
import type { HarnessManifest } from './harness/manifest.js';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = join(pluginRoot, '..', '..');
const FIXED_TIME = '2026-11-02T00:00:00.000Z';
const ROUND13_SOURCE_IDS = [
  'native-header-cut-probe',
  'round13-lead-integration',
  'h7-round13-clean-artifacts',
  'round13-host-native-header-cut',
  'round13-review',
  'h7-round13-slice-correction',
] as const;

function git(args: readonly string[], encoding: 'utf8' | 'buffer' = 'utf8'): { status: number; stdout: string | Buffer } {
  const result = spawnSync('git', ['-C', workspaceRoot, ...args], { encoding, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? (encoding === 'buffer' ? Buffer.alloc(0) : '') };
}

function committedJsonAt<T>(commit: string, relativePath: string): T {
  const result = git(['show', `${commit}:${relativePath}`]);
  assert.equal(result.status, 0, `git show ${commit}:${relativePath}`);
  return JSON.parse(result.stdout as string) as T;
}

function committedJson<T>(relativePath: string): T | null {
  const result = git(['show', `HEAD:${relativePath}`]);
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return null;
  }
}

function syntheticEvidenceReport(frozenHead: string): EvidenceVerificationReport {
  return {
    version: '1.0.0',
    frozenHead,
    issues: [],
    warnings: [],
    unknownSourceIds: [],
    counts: {
      sources: EVIDENCE_SOURCES.length,
      verified: EVIDENCE_SOURCES.length,
      unknown: 0,
      files: EVIDENCE_SOURCES.reduce((sum, source) => sum + source.files.length, 0),
      warnings: 0,
    },
    sources: EVIDENCE_SOURCES.map(source => ({
      id: source.id,
      status: 'verified' as const,
      levels: [...source.levels],
      commits: source.commits.map(sha => ({ sha, exists: true, ancestor: true })),
      files: source.files.map(file => ({
        path: file.path,
        sha256: file.expectedSha256 ?? '0'.repeat(64),
        bytes: 1,
        present: true,
        matchesFrozenHead: true,
        frozenHeadBlobSha256: file.expectedSha256 ?? '0'.repeat(64),
        lastCommit: null,
        expectedCommit: file.sliceCommit,
        jsonParseable: true,
        ...(file.blobCommit === undefined ? {} : { blobCommit: file.blobCommit }),
        ...(file.expectedSha256 === undefined ? {} : { expectedSha256: file.expectedSha256 }),
      })),
      observations: [],
      issues: [],
      warnings: [],
      scope: source.scope,
      limitations: [...source.limitations],
    })),
  };
}

async function acceptanceInputs(): Promise<AcceptanceInputs> {
  const traceability = committedJson<TraceabilityMatrix>('plugins/shiyu/artifacts/dsh/harness/traceability.json');
  const selfproof = committedJson<SelfProofArtifact>('plugins/shiyu/artifacts/dsh/harness/tool-selfproof.json');
  const manifest = committedJson<HarnessManifest>('plugins/shiyu/artifacts/dsh/harness/manifest.json');
  const coverage = committedJson<CoverageIndex>('plugins/shiyu/artifacts/dsh/harness/fl-scenarios/coverage.json');
  const frozenHead = traceability?.evidenceMapping.frozenHead ?? '0'.repeat(40);
  return {
    pluginRoot,
    workspaceRoot,
    generatedAt: FIXED_TIME,
    traceability,
    traceabilitySha256: traceability === null ? null : '1'.repeat(64),
    selfproof,
    selfproofSha256: selfproof === null ? null : '2'.repeat(64),
    manifest,
    manifestSha256: manifest === null ? null : '3'.repeat(64),
    coverage,
    coverageSha256: coverage === null ? null : '4'.repeat(64),
    evidence: syntheticEvidenceReport(frozenHead),
    documents: {
      moduleCatalog: await readFile(join(workspaceRoot, '架构与设计/A方案全景/目录.md'), 'utf8'),
      acceptanceDoc: await readFile(join(workspaceRoot, '架构与设计/A方案全景/验证与验收.md'), 'utf8'),
    },
  };
}

test('round14:new-round13-sources-integrity-and-ancestry', async () => {
  assert.equal(EVIDENCE_SOURCES.length, 88);
  const ids = new Set(EVIDENCE_SOURCES.map(source => source.id));
  for (const id of ROUND13_SOURCE_IDS) assert.ok(ids.has(id), `missing round-13 source ${id}`);
  const newSources = EVIDENCE_SOURCES.filter(source => ROUND13_SOURCE_IDS.includes(source.id as (typeof ROUND13_SOURCE_IDS)[number]));
  assert.equal(newSources.length, 6);
  assert.equal(newSources.reduce((sum, source) => sum + source.files.length, 0), 28);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  for (const source of newSources) {
    assert.ok(source.scope.length > 0, `${source.id} scope`);
    assert.ok(source.limitations.length > 0, `${source.id} limitations`);
    assert.ok(source.levels.length > 0, `${source.id} levels`);
    for (const commit of source.commits) {
      assert.equal(git(['cat-file', '-e', `${commit}^{commit}`]).status, 0, `${source.id} commit ${commit}`);
      assert.equal(git(['merge-base', '--is-ancestor', commit, head]).status, 0, `${source.id} ${commit} ancestor`);
    }
  }
  const { report, result } = await verifyEvidenceSources(workspaceRoot, head);
  assert.equal(result.ok, true, JSON.stringify(result.violations.slice(0, 5)));
  assert.equal(report.counts.sources, 88);
  assert.equal(report.counts.verified, 88, `unknown: ${report.unknownSourceIds.join(',')}`);
  assert.equal(report.counts.files, 339);
  for (const source of newSources) {
    const verified = report.sources.find(item => item.id === source.id);
    assert.equal(verified?.status, 'verified');
    assert.ok(verified?.files.every(file => file.matchesFrozenHead));
  }
});

test('round14:header-cut-probe-source-boundary', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'native-header-cut-probe');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['offline-module', 'slice-verification']);
  assert.equal(source.levels.includes('fixed-host-zero-model' as EvidenceLevel), false);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of ['headerDiff', '<=12 entries x <=80', '600', 'exactly one bare lifecycle Session', 'seq-excluding-header', '8 net-new', '1632', 'no fix', 'fourth bounded Goal attempt', 'NEVER be pass']) {
    assert.ok(text.includes(required), `header-cut probe text missing ${required}`);
  }
  assert.ok(source.files.some(file => file.path.endsWith('src/adapters/dsh/native-context.ts')));
  assert.ok(source.files.some(file => file.path.endsWith('src/control/native-header-cut-probe.ts')));
  assert.ok(source.files.some(file => file.path.endsWith('h3-native-header-cut-probe.patch')));
  const evidence = committedJsonAt<{
    status: string;
    tests: { netNew: number };
    verification: { isolatedFullCheck: { tests: { tests: number; pass: number; fail: number }; exitCode: number } };
    failures: readonly unknown[];
  }>('4421b6a', 'plugins/shiyu/artifacts/dsh/h3/h3-native-header-cut-probe.json');
  assert.match(evidence.status, /offline/);
  assert.equal(evidence.tests.netNew, 8);
  assert.equal(evidence.verification.isolatedFullCheck.tests.tests, 1632);
  assert.equal(evidence.verification.isolatedFullCheck.tests.pass, 1632);
  assert.equal(evidence.verification.isolatedFullCheck.tests.fail, 0);
  assert.equal(evidence.verification.isolatedFullCheck.exitCode, 0);
  assert.deepEqual(evidence.failures, []);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('native-header-cut-probe'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'native-header-cut-probe'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
});

test('round14:round13-integration-boundary', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round13-lead-integration');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['offline-module', 'slice-verification']);
  const text = source.limitations.join(' ');
  for (const required of ['0 real model/embedding calls', '0 Goal creates', 'does not fix', 'fourth', 'Never pass/V25']) {
    assert.ok(text.includes(required), `integration limitations missing ${required}`);
  }
  assert.ok(source.files.some(file => file.path.endsWith('src/runtime.ts')));
  assert.ok(source.files.some(file => file.path.endsWith('src/index.ts')));
  assert.ok(source.files.some(file => file.path.endsWith('tests/host-diagnostics-tool.test.ts')));
  const integration = committedJsonAt<{
    status: string;
    verification: { leadIntegratedIsolatedCheck: { exitCode: number; tests: number; pass: number; fail: number } };
    scope: { goalCreates: number; realModelCalls: number; embeddingCalls: number };
  }>('76c7116', 'plugins/shiyu/artifacts/dsh/integration/round13-lead-integration.json');
  assert.equal(integration.status, 'offline-verified-integration');
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.exitCode, 0);
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.tests, 1643);
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.pass, 1643);
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.fail, 0);
  assert.equal(integration.scope.goalCreates, 0);
  assert.equal(integration.scope.realModelCalls, 0);
  assert.equal(integration.scope.embeddingCalls, 0);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'round13-lead-integration'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
  }
});

test('round14:header-cut-host-probe-never-pass', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round13-host-native-header-cut');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['fixed-host-zero-model']);
  assert.equal(source.levels.includes('bounded-real-model' as EvidenceLevel), false);
  assert.equal(source.levels.includes('fixed-host-failure-diagnostic' as EvidenceLevel), false);
  const text = source.limitations.join(' ');
  for (const required of [
    'Zero-model header-cut DIAGNOSIS only',
    'matched=false',
    'delegationDepth: number:0→absent',
    'delegationDepth number:0',
    'aligned at 3/3',
    'Exactly one bare lifecycle Session',
    '0 model requests',
    '0 Goal/Task/Effect/budget creations',
    '0 business writes',
    '0 retries',
    'does not fix',
    'fourth bounded attempt',
    'NEVER be pass',
  ]) {
    assert.ok(text.includes(required), `host header-cut limitations missing ${required}`);
  }
  const joint = committedJsonAt<{
    status: string;
    result: {
      status: string;
      zeroModel: boolean;
      zeroEmbedding: boolean;
      zeroTaskOrEffect: boolean;
      createdGoal: boolean;
      matched: boolean;
      mismatchKind: string;
      headerDiff: readonly string[];
      cold: { eventCount: number; inheritedEventCount: number; headerHashPrefix: string };
      live: { eventCount: number; seq: number; inheritedEventCount: number; headerHashPrefix: string };
      released: boolean;
      disposed: boolean;
      archived: boolean;
      cleanup: { ok: boolean; failures: readonly unknown[] };
    };
    cachedReceipt: { bytes: number; sha256: string; matched: boolean; headerDiff: readonly string[] };
    deltas: { probe: { sessions: readonly [number, number]; commitSeq: readonly [number, number]; goals: readonly [number, number] } };
    businessFacts: { goals: number; stateFileUnchanged: boolean };
  }>('d221561', 'plugins/shiyu/artifacts/dsh/host/round13-joint-header-cut.json');
  assert.equal(joint.status, 'fixed-host-zero-model-header-cut-passed');
  assert.equal(joint.result.status, 'completed');
  assert.equal(joint.result.zeroModel, true);
  assert.equal(joint.result.zeroEmbedding, true);
  assert.equal(joint.result.zeroTaskOrEffect, true);
  assert.equal(joint.result.createdGoal, false);
  assert.equal(joint.result.matched, false);
  assert.equal(joint.result.mismatchKind, 'header-hash');
  assert.deepEqual(joint.result.headerDiff, ['delegationDepth: number:0→absent']);
  assert.equal(joint.result.cold.eventCount, 3);
  assert.equal(joint.result.cold.inheritedEventCount, 0);
  assert.equal(joint.result.cold.headerHashPrefix, '421ba38b88bb3384');
  assert.equal(joint.result.live.eventCount, 3);
  assert.equal(joint.result.live.seq, 3);
  assert.equal(joint.result.live.inheritedEventCount, 0);
  assert.equal(joint.result.live.headerHashPrefix, '815793bba716d8fc');
  assert.equal(joint.result.released, true);
  assert.equal(joint.result.disposed, true);
  assert.equal(joint.result.archived, true);
  assert.deepEqual(joint.result.cleanup, { ok: true, failures: [] });
  assert.deepEqual(joint.deltas.probe.sessions, [36, 37]);
  assert.deepEqual(joint.deltas.probe.commitSeq, [450, 450]);
  assert.deepEqual(joint.deltas.probe.goals, [5, 5]);
  assert.equal(joint.businessFacts.goals, 5);
  assert.equal(joint.businessFacts.stateFileUnchanged, true);
  assert.equal(joint.cachedReceipt.bytes, 60692);
  assert.equal(joint.cachedReceipt.matched, false);
  assert.deepEqual(joint.cachedReceipt.headerDiff, ['delegationDepth: number:0→absent']);
  const statusFinal = git(['show', '9ba7e70:plugins/shiyu/artifacts/dsh/host/round13/status-final.json'], 'buffer').stdout as Buffer;
  assert.equal(statusFinal.byteLength, 60692);
  assert.equal(sha256Hex(statusFinal), joint.cachedReceipt.sha256);
  const receipt = committedJsonAt<{
    status: string;
    zeroModel: boolean;
    zeroEmbedding: boolean;
    zeroTaskOrEffect: boolean;
    createdGoal: boolean;
    createdSessionId: string;
    matched: boolean;
    headerDiff: readonly string[];
    released: boolean;
    disposed: boolean;
    archived: boolean;
    cleanup: { ok: boolean };
  }>('9ba7e70', 'plugins/shiyu/artifacts/dsh/host/round13/native-header-cut-receipt.json');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.zeroModel, true);
  assert.equal(receipt.zeroEmbedding, true);
  assert.equal(receipt.zeroTaskOrEffect, true);
  assert.equal(receipt.createdGoal, false);
  assert.match(receipt.createdSessionId, /^shiyu-native-header-cut-/);
  assert.equal(receipt.matched, false);
  assert.deepEqual(receipt.headerDiff, ['delegationDepth: number:0→absent']);
  assert.equal(receipt.released, true);
  assert.equal(receipt.disposed, true);
  assert.equal(receipt.archived, true);
  assert.equal(receipt.cleanup.ok, true);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('round13-host-native-header-cut'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'round13-host-native-header-cut'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round14:correction-info-only-unmapped', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h7-round13-slice-correction');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['independent-review-info']);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of ['R13-CORR-1', 'real archived log SHA/bytes', 'blockedByConcurrentWip', 'NO green claim', 'not product/host/model/business verification', 'NOT referenced']) {
    assert.ok(text.includes(required), `correction source text missing ${required}`);
  }
  assert.ok(source.files.some(file => file.path.endsWith('h7-round13-slice.json')));
  assert.ok(source.files.some(file => file.path.endsWith('tests/harness-round13.test.ts')));
  for (const mapping of PRODUCT_EVIDENCE_MAPPINGS) assert.equal(mapping.sourceIds.includes('h7-round13-slice-correction'), false);
  for (const module of MODULE_DEFINITIONS) assert.equal(module.evidenceSourceIds.includes('h7-round13-slice-correction'), false);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows);
  for (const system of systems) assert.equal(system.sourceIds.includes('h7-round13-slice-correction'), false);
});

test('round14:blobcommit-round13-clean-artifacts-stable', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h7-round13-clean-artifacts');
  assert.ok(source !== undefined);
  for (const file of source.files) {
    assert.equal(file.blobCommit, '4c2de7c');
    assert.equal(typeof file.expectedSha256, 'string');
    const outcome = await verifyEvidenceFileFacts(workspaceRoot, head, file);
    assert.deepEqual(outcome.issues, []);
    assert.equal(outcome.facts.sha256, file.expectedSha256);
  }
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-round14-blob-'));
  try {
    await symlink(join(workspaceRoot, '.git'), join(directory, '.git'));
    const ref = source.files[0];
    const target = join(directory, ref.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, '{"rewritten":true}\n', 'utf8');
    assert.deepEqual((await verifyEvidenceFileFacts(directory, head, ref)).issues, []);
    const wrong = await verifyEvidenceFileFacts(directory, head, { ...ref, expectedSha256: '0'.repeat(64) });
    assert.ok(wrong.issues.some(issue => issue.includes('does not match expected committed blob SHA')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('round14:review-info-only-unmapped', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round13-review');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['independent-review-info']);
  const text = source.limitations.join(' ').toLowerCase();
  for (const needle of ['info', 'not product', 'not referenced']) assert.ok(text.includes(needle), `review limitations missing ${needle}`);
  for (const mapping of PRODUCT_EVIDENCE_MAPPINGS) assert.equal(mapping.sourceIds.includes('round13-review'), false);
  for (const module of MODULE_DEFINITIONS) assert.equal(module.evidenceSourceIds.includes('round13-review'), false);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows);
  for (const system of systems) assert.equal(system.sourceIds.includes('round13-review'), false);
});

test('round14:product-tooling-vsfl-no-upgrade', async () => {
  const committed = committedJson<TraceabilityMatrix>('plugins/shiyu/artifacts/dsh/harness/traceability.json');
  assert.ok(committed !== null);
  assert.deepEqual(committed.summary.product, { total: 79, covered: 0, notCovered: 79 });
  for (const row of committed.rows.filter(row => PRODUCT_KINDS.includes(row.kind))) assert.equal(row.status, 'not_covered');
  assert.deepEqual(committed.rows.filter(row => row.status === 'tooling_ready').map(row => row.id).sort(), ['TV.1', 'TV.2', 'TV.3', 'TV.4', 'TV.5', 'TV.6', 'TV.7', 'TV.9']);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows) {
    assert.ok(['limited-only', 'unknown', 'none'].includes(row.state), `${row.rowId} state ${row.state}`);
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
  const honesty = checkEvidenceMappingHonesty(mapping.rows, committed.rows.filter(row => PRODUCT_KINDS.includes(row.kind)).map(row => row.id));
  assert.equal(honesty.ok, true, JSON.stringify(honesty.violations.slice(0, 5)));
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  for (const scenario of acceptance.scenarios) {
    assert.equal(scenario.status, 'synthetic-fixture-only-not-run');
    assert.equal(scenario.canUseForBusinessAcceptance, false);
  }
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round14:acceptance-index-cites-round13-limited', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = new Map(buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows).map(system => [system.systemId, system]));
  for (const [systemId, expected] of [
    ['SYS.3', ['native-header-cut-probe', 'round13-lead-integration', 'round13-host-native-header-cut']],
    ['SYS.8', ['native-header-cut-probe', 'round13-lead-integration', 'round13-host-native-header-cut']],
    ['SYS.9', ['round13-host-native-header-cut']],
  ] as const) {
    const system = systems.get(systemId);
    assert.ok(system !== undefined);
    for (const id of expected) assert.ok(system.sourceIds.includes(id), `${systemId} missing ${id}`);
    assert.equal(system.row?.state, 'limited-only');
  }
  const moduleById = (id: string) => MODULE_DEFINITIONS.find(module => module.id === id);
  for (const id of ['MOD.core', 'MOD.tool-policy', 'MOD.lifecycle']) {
    const module = moduleById(id);
    assert.ok(module !== undefined);
    for (const sourceId of ['native-header-cut-probe', 'round13-lead-integration', 'round13-host-native-header-cut']) {
      assert.ok(module.evidenceSourceIds.includes(sourceId), `${id} missing ${sourceId}`);
    }
  }
  for (const id of ['MOD.recovery-entry', 'MOD.state', 'MOD.persistence']) {
    assert.ok(moduleById(id)?.evidenceSourceIds.includes('round13-host-native-header-cut'), `${id} missing host header-cut probe`);
  }
  assert.ok(moduleById('MOD.recovery-entry')?.evidenceSourceIds.includes('native-header-cut-probe'));
  for (const module of MODULE_DEFINITIONS) {
    assert.ok(module.evidenceSourceIds.every(id => EVIDENCE_SOURCES.some(source => source.id === id)), `${module.id} cites unknown source`);
    assert.ok(module.systems.length > 0);
  }
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.modules.length, 40);
  assert.equal(acceptance.systems.length, 9);
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round14:slice-evidence-present', async () => {
  const text = await readFile(join(pluginRoot, 'artifacts/dsh/harness/h7-round14-slice.json'), 'utf8').catch(() => null);
  assert.ok(text !== null, 'h7-round14-slice.json must exist');
  const evidence = JSON.parse(text) as {
    kind: string;
    baselineHead: string;
    round13Sources: readonly (string | { readonly id: string })[];
    sourceCounts: { sources: number; files: number };
    files: readonly { path: string; sha256: string; bytes: number }[];
    checks: {
      sharedTree: { blockedByConcurrentWip?: boolean; note?: string; harness?: { tests: number; pass: number; fail: number } };
      isolatedWorktree: { harness: { tests: number; pass: number; fail: number }; fullCheck: { exitCode: number; tests: number; pass: number; fail: number } };
    };
    productRows: { total: number; notCovered: number; covered: number };
    toolingReady: readonly string[];
    acceptanceGate: string;
  };
  assert.equal(evidence.kind, 'shiyu.harness.h7-round14-slice-evidence');
  assert.match(evidence.baselineHead, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    evidence.round13Sources.map(item => (typeof item === 'string' ? item : item.id)).sort(),
    [...ROUND13_SOURCE_IDS].sort(),
  );
  assert.deepEqual(evidence.sourceCounts, { sources: 79, files: 282 });
  // Historical slice snapshot: hash the blobs as committed in the round-14
  // correction commit (437ac97). Later rounds legitimately edit these harness
  // files, so a mutable-worktree comparison would turn a historical record into
  // a stale drift check; the committed snapshot is the evidence.
  for (const file of evidence.files) {
    const blob = git(['show', `437ac97:${file.path}`], 'buffer').stdout as Buffer;
    assert.ok(blob.byteLength > 0, `${file.path} committed blob missing`);
    assert.equal(sha256Hex(blob), file.sha256, `${file.path} slice sha`);
    assert.equal(blob.byteLength, file.bytes);
  }
  if (evidence.checks.sharedTree.blockedByConcurrentWip === true) {
    assert.ok(
      typeof evidence.checks.sharedTree.note === 'string' && evidence.checks.sharedTree.note.length > 0,
      'a blocked-by-concurrent-WIP shared tree run must carry an explanatory note and no green claim',
    );
  } else if (evidence.checks.sharedTree.harness !== undefined) {
    assert.equal(evidence.checks.sharedTree.harness.fail, 0);
  } else {
    assert.fail('sharedTree must be either blocked-by-concurrent-WIP or a green run');
  }
  assert.equal(evidence.checks.isolatedWorktree.harness.fail, 0);
  assert.equal(evidence.checks.isolatedWorktree.fullCheck.exitCode, 0);
  assert.equal(evidence.checks.isolatedWorktree.fullCheck.fail, 0);
  assert.ok(evidence.checks.isolatedWorktree.harness.tests > 0);
  assert.ok(evidence.checks.isolatedWorktree.fullCheck.tests > 0);
  assert.deepEqual(evidence.productRows, { total: 79, notCovered: 79, covered: 0 });
  assert.deepEqual([...evidence.toolingReady].sort(), ['TV.1', 'TV.2', 'TV.3', 'TV.4', 'TV.5', 'TV.6', 'TV.7', 'TV.9']);
  assert.equal(evidence.acceptanceGate, 'incomplete');
});
