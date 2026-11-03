/**
 * H7-round12 tests: round-11 history-assert diagnostics / generalized v1+v2
 * reconcile / fixed-host zero-model reconcile evidence is bound as limited
 * diagnostic evidence; nothing here can be a pass.
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
const ROUND11_SOURCE_IDS = [
  'history-assert-diagnostics',
  'v1v2-reconcile-generalization',
  'round11-lead-integration',
  'round11-host-v1v2-reconcile',
  'h7-round11-clean-artifacts',
  'round11-review',
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

test('round12:new-round11-sources-integrity-and-ancestry', async () => {
  assert.equal(EVIDENCE_SOURCES.length, 73);
  const ids = new Set(EVIDENCE_SOURCES.map(source => source.id));
  for (const id of ROUND11_SOURCE_IDS) assert.ok(ids.has(id), `missing round-11 source ${id}`);
  const newSources = EVIDENCE_SOURCES.filter(source => ROUND11_SOURCE_IDS.includes(source.id as (typeof ROUND11_SOURCE_IDS)[number]));
  assert.equal(newSources.length, 6);
  assert.equal(newSources.reduce((sum, source) => sum + source.files.length, 0), 26);
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

test('round12:history-assert-diagnostic-boundary', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'history-assert-diagnostics');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['offline-module', 'slice-verification']);
  assert.equal(source.levels.includes('bounded-real-model' as EvidenceLevel), false);
  assert.equal(source.levels.includes('fixed-host-zero-model' as EvidenceLevel), false);
  assert.equal(source.levels.includes('fixed-host-failure-diagnostic' as EvidenceLevel), false);
  const text = source.limitations.join(' ');
  for (const required of ['no real model or host', 'DORMANT', 'NOT host-confirmed', 'NEVER', '<=300', 'does not fix the create']) {
    assert.ok(text.includes(required), `diagnostic limitations missing ${required}`);
  }
  const diagnosis = JSON.parse(git(['show', '196024a:plugins/shiyu/artifacts/dsh/h3/h3-history-assert-diagnosis.json']).stdout.toString()) as {
    status: string;
    instrumentation: { mismatchKinds: readonly string[]; bounded: string; candidateFix: { status: string } };
    tests: { netNew: number };
    failures: readonly unknown[];
    untestedOrBoundaries: readonly string[];
  };
  assert.match(diagnosis.status, /offline/);
  assert.ok(diagnosis.instrumentation.mismatchKinds.includes('live-seq-vs-event-count'));
  assert.match(diagnosis.instrumentation.candidateFix.status, /NOT activated/);
  assert.equal(diagnosis.tests.netNew, 14);
  assert.deepEqual(diagnosis.failures, []);
  assert.ok(diagnosis.untestedOrBoundaries.some(line => line.includes('dormant')));
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('history-assert-diagnostics'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'history-assert-diagnostics'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
});

test('round12:reconcile-generalization-offline-boundary', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'v1v2-reconcile-generalization');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['offline-module', 'slice-verification']);
  assert.deepEqual([...source.commits].sort(), ['196024a', 'fe6d5f7']);
  assert.ok(source.files.some(file => file.path.endsWith('src/control/core-validation.ts')));
  assert.ok(source.files.some(file => file.path.endsWith('h3-history-assert-reconcile-integration.patch')));
  assert.ok(source.files.some(file => file.path.endsWith('src/index.ts')));
  const text = source.limitations.join(' ');
  for (const required of ['core-validation-frozen-v1', 'core-validation-frozen-v2', 'caller cannot select', '0 retries', '0 model calls', 'no Goal creation', 'NEVER creates', 'third']) {
    assert.ok(text.toLowerCase().includes(required.toLowerCase()), `reconcile limitations missing ${required}`);
  }
  const integration = JSON.parse(git(['show', 'fe6d5f7:plugins/shiyu/artifacts/dsh/integration/round11-lead-integration.json']).stdout.toString()) as {
    status: string;
    verification: { leadIntegratedIsolatedCheck: { exitCode: number; tests: number; pass: number; fail: number } };
  };
  assert.equal(integration.status, 'offline-verified-integration');
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.exitCode, 0);
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.tests, 1605);
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.pass, 1605);
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.fail, 0);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'v1v2-reconcile-generalization'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
});

test('round12:host-v1v2-reconcile-never-pass', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round11-host-v1v2-reconcile');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['fixed-host-zero-model-reconcile']);
  assert.equal(source.levels.includes('bounded-real-model' as EvidenceLevel), false);
  assert.equal(source.levels.includes('fixed-host-zero-model' as EvidenceLevel), false);
  const text = source.limitations.join(' ');
  for (const required of ['v1 cancelled', 'no action', 'inert-unauthorized', 'exactly one cancel', 'postCancel', 'version 2', '0 model calls', '0 retries', '0 Goal creations', '+1 commitSeq', 'NOT host-confirmed', 'liveCut', 'third bounded experiment', 'NEVER']) {
    assert.ok(text.includes(required), `host reconcile limitations missing ${required}`);
  }
  const joint = JSON.parse(git(['show', 'a29dd29:plugins/shiyu/artifacts/dsh/host/round11-joint-reconcile-v1v2.json']).stdout.toString()) as {
    status: string;
    readOnly: boolean;
    createsGoal: boolean;
    modelCalls: number;
    retries: number;
    requestIds: readonly string[];
    targets: readonly {
      requestId: string;
      classification: string;
      cancelAttempts: number;
      stopAction: { kind: string; attempted: boolean };
      postCancel?: { cancelled: boolean; paused: boolean; version: number };
    }[];
    cachedReceipt: { bytes: number; sha256: string };
  };
  assert.equal(joint.status, 'fixed-host-reconcile-v1v2-passed');
  assert.equal(joint.readOnly, true);
  assert.equal(joint.createsGoal, false);
  assert.equal(joint.modelCalls, 0);
  assert.equal(joint.retries, 0);
  assert.deepEqual(joint.requestIds, ['core-validation-frozen-v1', 'core-validation-frozen-v2']);
  const [v1, v2] = joint.targets;
  assert.equal(v1.classification, 'cancelled');
  assert.equal(v1.cancelAttempts, 0);
  assert.equal(v1.stopAction.kind, 'none');
  assert.equal(v2.classification, 'inert-unauthorized');
  assert.equal(v2.cancelAttempts, 1);
  assert.equal(v2.stopAction.kind, 'cancel');
  assert.equal(v2.stopAction.attempted, true);
  assert.deepEqual(v2.postCancel, { cancelled: true, paused: true, version: 2 });
  assert.equal(joint.cachedReceipt.bytes, 61122);
  const statusBytes = git(['show', '7d9979e:plugins/shiyu/artifacts/dsh/host/round11/status-final.json'], 'buffer').stdout as Buffer;
  assert.equal(statusBytes.byteLength, 61122);
  assert.equal(sha256Hex(statusBytes), joint.cachedReceipt.sha256);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('round11-host-v1v2-reconcile'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'round11-host-v1v2-reconcile'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round12:review-info-only-unmapped', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round11-review');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['independent-review-info']);
  const text = source.limitations.join(' ').toLowerCase();
  for (const needle of ['info', 'not product', 'not referenced']) assert.ok(text.includes(needle), `review limitations missing ${needle}`);
  for (const mapping of PRODUCT_EVIDENCE_MAPPINGS) assert.equal(mapping.sourceIds.includes('round11-review'), false);
  for (const module of MODULE_DEFINITIONS) assert.equal(module.evidenceSourceIds.includes('round11-review'), false);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows);
  for (const system of systems) assert.equal(system.sourceIds.includes('round11-review'), false);
});

test('round12:blobcommit-round11-clean-artifacts-stable', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h7-round11-clean-artifacts');
  assert.ok(source !== undefined);
  for (const file of source.files) {
    assert.equal(file.blobCommit, '7ad2621');
    assert.equal(typeof file.expectedSha256, 'string');
    const outcome = await verifyEvidenceFileFacts(workspaceRoot, head, file);
    assert.deepEqual(outcome.issues, []);
    assert.equal(outcome.facts.sha256, file.expectedSha256);
  }
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-round12-blob-'));
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

test('round12:product-tooling-vsfl-no-upgrade', async () => {
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

test('round12:acceptance-index-cites-round11-reconcile-limited', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = new Map(buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows).map(system => [system.systemId, system]));
  for (const [systemId, expected] of [
    ['SYS.3', ['history-assert-diagnostics', 'v1v2-reconcile-generalization', 'round11-lead-integration', 'round11-host-v1v2-reconcile']],
    ['SYS.8', ['history-assert-diagnostics', 'v1v2-reconcile-generalization', 'round11-lead-integration', 'round11-host-v1v2-reconcile']],
    ['SYS.9', ['round11-host-v1v2-reconcile']],
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
    for (const sourceId of ['history-assert-diagnostics', 'v1v2-reconcile-generalization', 'round11-lead-integration', 'round11-host-v1v2-reconcile']) {
      assert.ok(module.evidenceSourceIds.includes(sourceId), `${id} missing ${sourceId}`);
    }
  }
  for (const id of ['MOD.recovery-entry', 'MOD.state', 'MOD.persistence']) {
    assert.ok(moduleById(id)?.evidenceSourceIds.includes('round11-host-v1v2-reconcile'), `${id} missing host reconcile`);
  }
  assert.ok(moduleById('MOD.recovery-entry')?.evidenceSourceIds.includes('history-assert-diagnostics'));
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

test('round12:slice-evidence-present', async () => {
  const text = await readFile(join(pluginRoot, 'artifacts/dsh/harness/h7-round12-slice.json'), 'utf8').catch(() => null);
  assert.ok(text !== null, 'h7-round12-slice.json must exist');
  const evidence = JSON.parse(text) as {
    kind: string;
    baselineHead: string;
    round11Sources: readonly (string | { readonly id: string })[];
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
  assert.equal(evidence.kind, 'shiyu.harness.h7-round12-slice-evidence');
  assert.match(evidence.baselineHead, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    evidence.round11Sources.map(item => (typeof item === 'string' ? item : item.id)).sort(),
    [...ROUND11_SOURCE_IDS].sort(),
  );
  assert.deepEqual(evidence.sourceCounts, { sources: 67, files: 224 });
  // Historical slice snapshot: hash the blobs as committed in the round-12 X+1
  // commit (1113662). Later rounds legitimately edit these harness files, so a
  // mutable-worktree comparison would turn a historical record into a stale
  // drift check; the committed snapshot is the evidence.
  for (const file of evidence.files) {
    const blob = git(['show', `1113662:${file.path}`], 'buffer').stdout as Buffer;
    assert.ok(blob.byteLength > 0, `${file.path} committed blob missing`);
    assert.equal(sha256Hex(blob), file.sha256, `${file.path} slice sha`);
    assert.equal(blob.byteLength, file.bytes);
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
