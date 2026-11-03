/**
 * H7-round13 tests: round-12 cold-cut/v3 activation, third v3 attempt failure,
 * post-attempt cleanup reconcile and review are bound as limited diagnostic
 * evidence; nothing here can be a pass.
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
const ROUND12_SOURCE_IDS = [
  'cold-cut-v3-activation',
  'round12-lead-integration',
  'h7-round12-clean-artifacts',
  'round12-host-v3-create-failure',
  'round12-host-v3-cleanup-reconcile',
  'round12-review',
] as const;

function git(args: readonly string[], encoding: 'utf8' | 'buffer' = 'utf8'): { status: number; stdout: string | Buffer } {
  const result = spawnSync('git', ['-C', workspaceRoot, ...args], { encoding, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? (encoding === 'buffer' ? Buffer.alloc(0) : '') };
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

test('round13:new-round12-sources-integrity-and-ancestry', async () => {
  assert.equal(EVIDENCE_SOURCES.length, 73);
  const ids = new Set(EVIDENCE_SOURCES.map(source => source.id));
  for (const id of ROUND12_SOURCE_IDS) assert.ok(ids.has(id), `missing round-12 source ${id}`);
  const newSources = EVIDENCE_SOURCES.filter(source => ROUND12_SOURCE_IDS.includes(source.id as (typeof ROUND12_SOURCE_IDS)[number]));
  assert.equal(newSources.length, 6);
  assert.equal(newSources.reduce((sum, source) => sum + source.files.length, 0), 30);
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
  assert.equal(report.counts.sources, 73);
  assert.equal(report.counts.verified, 73, `unknown: ${report.unknownSourceIds.join(',')}`);
  assert.equal(report.counts.files, 254);
  for (const source of newSources) {
    const verified = report.sources.find(item => item.id === source.id);
    assert.equal(verified?.status, 'verified');
    assert.ok(verified?.files.every(file => file.matchesFrozenHead));
  }
});

test('round13:v3-activation-boundary', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'cold-cut-v3-activation');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['offline-module', 'slice-verification']);
  assert.equal(source.levels.includes('bounded-real-model' as EvidenceLevel), false);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of ['create-only', 'liveCut', 'seq-excluding-header', 'expectedPrefix', 'exactly once', '1613', 'host-candidate', 'FAILED separately', 'never be reported as a successful v3 run']) {
    assert.ok(text.includes(required), `activation text missing ${required}`);
  }
  assert.ok(source.files.some(file => file.path.endsWith('src/adapters/dsh/goals.ts')));
  assert.ok(source.files.some(file => file.path.endsWith('src/control/core-validation.ts')));
  assert.ok(source.files.some(file => file.path.endsWith('h3-v3-livecut-activation.json')));
  assert.ok(source.files.some(file => file.path.endsWith('h3-v3-runtime-index.patch')));
  const activation = JSON.parse(git(['show', 'ccefc57:plugins/shiyu/artifacts/dsh/h3/h3-v3-livecut-activation.json']).stdout.toString()) as {
    status: string;
    tests: { netNew: number };
    verification: { isolatedFullCheck: { tests: { tests: number; pass: number; fail: number }; exitCode: number } };
    failures: readonly unknown[];
  };
  assert.match(activation.status, /offline code preparation/);
  assert.equal(activation.tests.netNew, 8);
  assert.equal(activation.verification.isolatedFullCheck.tests.tests, 1613);
  assert.equal(activation.verification.isolatedFullCheck.tests.pass, 1613);
  assert.equal(activation.verification.isolatedFullCheck.tests.fail, 0);
  assert.equal(activation.verification.isolatedFullCheck.exitCode, 0);
  assert.deepEqual(activation.failures, []);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('cold-cut-v3-activation'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'cold-cut-v3-activation'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
});

test('round13:round12-integration-boundary', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round12-lead-integration');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['offline-module', 'slice-verification']);
  const text = source.limitations.join(' ');
  for (const required of ['0 real model calls', 'FAILED', 'F12-R1', 'Never pass/V25']) {
    assert.ok(text.includes(required), `integration limitations missing ${required}`);
  }
  assert.ok(source.files.some(file => file.path.endsWith('src/runtime.ts')));
  assert.ok(source.files.some(file => file.path.endsWith('src/index.ts')));
  assert.ok(source.files.some(file => file.path.endsWith('tests/host-diagnostics-tool.test.ts')));
  const integration = JSON.parse(git(['show', '390346d:plugins/shiyu/artifacts/dsh/integration/round12-lead-integration.json']).stdout.toString()) as {
    status: string;
    verification: { leadIntegratedIsolatedCheck: { exitCode: number; tests: number; pass: number; fail: number } };
    finalXSliceEvidence: { bytes: number; sha256: string };
  };
  assert.equal(integration.status, 'offline-verified-integration');
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.exitCode, 0);
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.tests, 1623);
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.pass, 1623);
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.fail, 0);
  assert.equal(integration.finalXSliceEvidence.bytes, 6690);
  assert.equal(integration.finalXSliceEvidence.sha256, 'fb04c010e81f8a1f4278cff37e0f0c04ac5d9bf9b77476415eec0cd26de8ae28');
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'round12-lead-integration'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
  }
});

test('round13:v3-create-failure-never-pass', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round12-host-v3-create-failure');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['fixed-host-failure-diagnostic']);
  assert.equal(source.levels.includes('bounded-real-model' as EvidenceLevel), false);
  assert.equal(source.levels.includes('fixed-host-zero-model-reconcile' as EvidenceLevel), false);
  const text = source.limitations.join(' ');
  for (const required of [
    'FAILED third v3 attempt',
    'header-hash',
    'baa30ad4d06e38bf',
    'bbd0090cf84d43d9',
    'expected.eventCount 3 = live.seq 3',
    'delta 0',
    '0 model requests',
    'no retry',
    'unauthorized/paused v3 Goal',
    'create journal is unknown',
    'no new Task/Effect/budget/artifact',
    'fourth attempt is NOT authorized',
    'create failure is NOT fixed',
    'NEVER be pass',
  ]) {
    assert.ok(text.includes(required), `v3 failure limitations missing ${required}`);
  }
  const joint = JSON.parse(git(['show', '390346d:plugins/shiyu/artifacts/dsh/host/round12-bounded-core-goal-v3.json']).stdout.toString()) as {
    status: string;
    attempt: {
      status: string;
      reasonCode: string;
      failurePhase: string;
      failureCode: string;
      counters: { evaluateAttempts: number };
      stopAction: { kind: string; attempted: boolean };
      partialCreation: { detected: boolean; readback: string };
      historyDiagnostic: {
        mismatchKind: string;
        expected: { eventCount: number; inheritedEventCount: number; headerHash: string };
        live: { eventCount: number; seq: number; inheritedEventCount: number; headerHash: string };
        delta: number;
      };
    };
    cachedReceipt: { bytes: number; sha256: string };
    businessFacts: { goals: number; stateFileUnchanged: boolean };
  };
  assert.equal(joint.status, 'fixed-host-v3-create-failed-header-hash');
  assert.equal(joint.attempt.status, 'failed');
  assert.equal(joint.attempt.reasonCode, 'CORE_VALIDATION_CREATE_FAILED');
  assert.equal(joint.attempt.failurePhase, 'history-assert');
  assert.equal(joint.attempt.failureCode, 'NATIVE_HISTORY_CHANGED');
  assert.equal(joint.attempt.counters.evaluateAttempts, 0);
  assert.deepEqual(joint.attempt.stopAction, { kind: 'none', attempted: false, ok: null });
  assert.equal(joint.attempt.partialCreation.detected, true);
  assert.equal(joint.attempt.partialCreation.readback, 'complete');
  const diagnostic = joint.attempt.historyDiagnostic;
  assert.equal(diagnostic.mismatchKind, 'header-hash');
  assert.equal(diagnostic.expected.eventCount, 3);
  assert.equal(diagnostic.live.seq, 3);
  assert.equal(diagnostic.expected.inheritedEventCount, 0);
  assert.equal(diagnostic.delta, 0);
  assert.equal(diagnostic.expected.headerHash, 'baa30ad4d06e38bf');
  assert.equal(diagnostic.live.headerHash, 'bbd0090cf84d43d9');
  assert.equal(joint.cachedReceipt.bytes, 69295);
  assert.equal(joint.businessFacts.goals, 5);
  assert.equal(joint.businessFacts.stateFileUnchanged, true);
  const receipt = JSON.parse(git(['show', '31e5c05:plugins/shiyu/artifacts/dsh/host/round12/core-goal-v3-receipt.json']).stdout.toString()) as {
    status: string;
    counters: { evaluateAttempts: number };
    stopAction: { kind: string };
    businessSideEffects: { partialCreation: { detected: boolean } };
    unknowns: readonly string[];
  };
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.counters.evaluateAttempts, 0);
  assert.equal(receipt.stopAction.kind, 'none');
  assert.equal(receipt.businessSideEffects.partialCreation.detected, true);
  assert.ok(receipt.unknowns.includes('GOAL_CREATE_FAILED'));
  assert.ok(receipt.unknowns.includes('PARTIAL_CREATION_REQUIRES_RECONCILE'));
  const statusFinal = git(['show', '31e5c05:plugins/shiyu/artifacts/dsh/host/round12/status-final.json'], 'buffer').stdout as Buffer;
  assert.equal(statusFinal.byteLength, 69295);
  assert.equal(sha256Hex(statusFinal), joint.cachedReceipt.sha256);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('round12-host-v3-create-failure'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'round12-host-v3-create-failure'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round13:v3-cleanup-reconcile-not-business', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round12-host-v3-cleanup-reconcile');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['fixed-host-zero-model-reconcile']);
  assert.equal(source.levels.includes('fixed-host-failure-diagnostic' as EvidenceLevel), false);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of ['v1 and v2 were already cancelled', 'v3 was inert-unauthorized', 'exactly one cancel', 'postCancel', 'version=2', '0 model calls', '0 retries', '+1 commitSeq', 'does NOT fix', 'fourth bounded experiment is NOT authorized']) {
    assert.ok(text.includes(required), `cleanup text missing ${required}`);
  }
  const joint = JSON.parse(git(['show', '390346d:plugins/shiyu/artifacts/dsh/host/round12-bounded-core-goal-v3.json']).stdout.toString()) as {
    postAttemptReconcile: {
      requestIds: readonly string[];
      targets: readonly {
        requestId: string;
        classification: string;
        cancelAttempts: number;
        postCancel?: { cancelled: boolean; paused: boolean; version: number };
      }[];
      auditDeltas: { commitSeq: readonly [number, number] };
      statusPayload: { bytes: number; sha256: string };
    };
  };
  const reconcile = joint.postAttemptReconcile;
  assert.deepEqual(reconcile.requestIds, ['core-validation-frozen-v1', 'core-validation-frozen-v2', 'core-validation-frozen-v3']);
  const [v1, v2, v3] = reconcile.targets;
  assert.equal(v1.classification, 'cancelled');
  assert.equal(v1.cancelAttempts, 0);
  assert.equal(v2.classification, 'cancelled');
  assert.equal(v2.cancelAttempts, 0);
  assert.equal(v3.classification, 'inert-unauthorized');
  assert.equal(v3.cancelAttempts, 1);
  assert.deepEqual(v3.postCancel, { cancelled: true, paused: true, version: 2 });
  assert.deepEqual(reconcile.auditDeltas.commitSeq, [444, 444]);
  assert.equal(reconcile.statusPayload.bytes, 69295);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('round12-host-v3-cleanup-reconcile'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'round12-host-v3-cleanup-reconcile'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
  }
});

test('round13:blobcommit-round12-clean-artifacts-stable', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h7-round12-clean-artifacts');
  assert.ok(source !== undefined);
  for (const file of source.files) {
    assert.equal(file.blobCommit, '1113662');
    assert.equal(typeof file.expectedSha256, 'string');
    const outcome = await verifyEvidenceFileFacts(workspaceRoot, head, file);
    assert.deepEqual(outcome.issues, []);
    assert.equal(outcome.facts.sha256, file.expectedSha256);
  }
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-round13-blob-'));
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

test('round13:review-info-only-unmapped', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round12-review');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['independent-review-info']);
  const text = source.limitations.join(' ').toLowerCase();
  for (const needle of ['info', 'not product', 'not referenced']) assert.ok(text.includes(needle), `review limitations missing ${needle}`);
  for (const mapping of PRODUCT_EVIDENCE_MAPPINGS) assert.equal(mapping.sourceIds.includes('round12-review'), false);
  for (const module of MODULE_DEFINITIONS) assert.equal(module.evidenceSourceIds.includes('round12-review'), false);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows);
  for (const system of systems) assert.equal(system.sourceIds.includes('round12-review'), false);
});

test('round13:product-tooling-vsfl-no-upgrade', async () => {
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

test('round13:acceptance-index-cites-round12-limited', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = new Map(buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows).map(system => [system.systemId, system]));
  for (const [systemId, expected] of [
    ['SYS.3', ['cold-cut-v3-activation', 'round12-lead-integration', 'round12-host-v3-create-failure', 'round12-host-v3-cleanup-reconcile']],
    ['SYS.8', ['cold-cut-v3-activation', 'round12-lead-integration', 'round12-host-v3-create-failure', 'round12-host-v3-cleanup-reconcile']],
    ['SYS.9', ['round12-host-v3-create-failure', 'round12-host-v3-cleanup-reconcile']],
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
    for (const sourceId of ['cold-cut-v3-activation', 'round12-lead-integration', 'round12-host-v3-cleanup-reconcile']) {
      assert.ok(module.evidenceSourceIds.includes(sourceId), `${id} missing ${sourceId}`);
    }
  }
  for (const id of ['MOD.core', 'MOD.lifecycle', 'MOD.recovery-entry', 'MOD.state', 'MOD.persistence']) {
    assert.ok(moduleById(id)?.evidenceSourceIds.includes('round12-host-v3-cleanup-reconcile'), `${id} missing cleanup reconcile`);
  }
  for (const id of ['MOD.core', 'MOD.lifecycle', 'MOD.recovery-entry']) {
    assert.ok(moduleById(id)?.evidenceSourceIds.includes('round12-host-v3-create-failure'), `${id} missing v3 failure`);
  }
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

test('round13:slice-evidence-present', async () => {
  const text = await readFile(join(pluginRoot, 'artifacts/dsh/harness/h7-round13-slice.json'), 'utf8').catch(() => null);
  assert.ok(text !== null, 'h7-round13-slice.json must exist');
  const evidence = JSON.parse(text) as {
    kind: string;
    baselineHead: string;
    round12Sources: readonly (string | { readonly id: string })[];
    sourceCounts: { sources: number; files: number };
    files: readonly { path: string; sha256: string; bytes: number }[];
    checks: {
      sharedTree: { harness: { tests: number; pass: number; fail: number } };
      isolatedWorktree: { harness: { tests: number; pass: number; fail: number }; fullCheck: { exitCode: number; tests: number; pass: number; fail: number } };
    };
    productRows: { total: number; notCovered: number; covered: number };
    toolingReady: readonly string[];
    acceptanceGate: string;
  };
  assert.equal(evidence.kind, 'shiyu.harness.h7-round13-slice-evidence');
  assert.match(evidence.baselineHead, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    evidence.round12Sources.map(item => (typeof item === 'string' ? item : item.id)).sort(),
    [...ROUND12_SOURCE_IDS].sort(),
  );
  assert.deepEqual(evidence.sourceCounts, { sources: 73, files: 254 });
  for (const file of evidence.files) {
    const bytes = await readFile(join(workspaceRoot, file.path));
    assert.equal(sha256Hex(bytes), file.sha256, `${file.path} slice sha`);
    assert.equal(bytes.byteLength, file.bytes);
  }
  assert.equal(evidence.checks.sharedTree.harness.fail, 0);
  assert.equal(evidence.checks.isolatedWorktree.harness.fail, 0);
  assert.equal(evidence.checks.isolatedWorktree.fullCheck.exitCode, 0);
  assert.equal(evidence.checks.isolatedWorktree.fullCheck.fail, 0);
  assert.ok(evidence.checks.sharedTree.harness.tests > 0);
  assert.ok(evidence.checks.isolatedWorktree.harness.tests > 0);
  assert.ok(evidence.checks.isolatedWorktree.fullCheck.tests > 0);
  assert.deepEqual(evidence.productRows, { total: 79, notCovered: 79, covered: 0 });
  assert.deepEqual([...evidence.toolingReady].sort(), ['TV.1', 'TV.2', 'TV.3', 'TV.4', 'TV.5', 'TV.6', 'TV.7', 'TV.9']);
  assert.equal(evidence.acceptanceGate, 'incomplete');
});
