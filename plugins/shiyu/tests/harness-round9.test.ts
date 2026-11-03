/**
 * H7-round9 tests: round-8 fixed-host reconcile evidence is bound as limited
 * zero-model reconcile evidence and can never be a pass/business acceptance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_EVIDENCE_LEVELS,
  EVIDENCE_SOURCES,
  FORBIDDEN_CLAIM_LEVELS,
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
const ROUND8_SOURCE_IDS = [
  'round8-host-core-validation-reconcile',
  'h3-core-validation-reconcile',
  'round8-lead-integration',
  'h7-round8-clean-artifacts',
  'round8-review',
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

test('round9:new-reconcile-sources-integrity-and-ancestry', async () => {
  assert.equal(EVIDENCE_SOURCES.length, 67);
  const ids = new Set(EVIDENCE_SOURCES.map(source => source.id));
  for (const id of ROUND8_SOURCE_IDS) assert.ok(ids.has(id), `missing round-8 source ${id}`);
  const newSources = EVIDENCE_SOURCES.filter(source => ROUND8_SOURCE_IDS.includes(source.id as (typeof ROUND8_SOURCE_IDS)[number]));
  assert.equal(newSources.length, 5);
  assert.equal(newSources.reduce((sum, source) => sum + source.files.length, 0), 19);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  for (const source of newSources) {
    assert.ok(source.scope.length > 0);
    assert.ok(source.limitations.length > 0);
    for (const commit of source.commits) {
      assert.equal(git(['cat-file', '-e', `${commit}^{commit}`]).status, 0, `${source.id} commit ${commit}`);
      assert.equal(git(['merge-base', '--is-ancestor', commit, head]).status, 0, `${source.id} ${commit} ancestor`);
    }
  }
  const { report, result } = await verifyEvidenceSources(workspaceRoot, head);
  assert.equal(result.ok, true, JSON.stringify(result.violations.slice(0, 5)));
  assert.equal(report.counts.sources, 67);
  assert.equal(report.counts.verified, 67, `unknown: ${report.unknownSourceIds.join(',')}`);
  assert.equal(report.counts.files, 224);
  for (const source of newSources) {
    const verified = report.sources.find(item => item.id === source.id);
    assert.equal(verified?.status, 'verified');
    assert.ok(verified?.files.every(file => file.matchesFrozenHead));
    for (const commit of verified?.commits ?? []) assert.equal(commit.ancestor, true);
  }
});

test('round9:reconcile-never-pass', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const source = report.sources.find(item => item.id === 'round8-host-core-validation-reconcile');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['fixed-host-zero-model-reconcile']);
  assert.equal(source.levels.includes('bounded-real-model' as EvidenceLevel), false);
  assert.equal(source.levels.includes('fixed-host-zero-model' as EvidenceLevel), false);
  const text = source.limitations.join(' ');
  for (const required of ['reconcile', 'inert-unauthorized', 'readOnly=true', 'createsGoal=false', 'modelCalls=0', 'retries=0', 'does not fix', 'business chain']) {
    assert.ok(text.includes(required), `limitations missing ${required}`);
  }
  const receipt = JSON.parse(git(['show', 'f10affc:plugins/shiyu/artifacts/dsh/host/round8/reconcile-receipt.json']).stdout.toString());
  assert.equal(receipt.classification, 'inert-unauthorized');
  assert.equal(receipt.readOnly, true);
  assert.equal(receipt.createsGoal, false);
  assert.equal(receipt.modelCalls, 0);
  assert.equal(receipt.retries, 0);
  assert.equal(receipt.cancelAttempts, 1);
  assert.equal(receipt.postCancel.cancelled, true);
  assert.equal(receipt.postCancel.paused, true);
  assert.equal(git(['cat-file', '-s', 'f10affc:plugins/shiyu/artifacts/dsh/host/round8/status-final.json']).stdout.toString().trim(), '58375');
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('round8-host-core-validation-reconcile'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'round8-host-core-validation-reconcile'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round9:h3-reconcile-boundary', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h3-core-validation-reconcile');
  assert.ok(source !== undefined);
  const text = source.limitations.join(' ');
  assert.match(text, /1552/);
  assert.match(text, /29 tests/i);
  assert.match(text, /host reconcile was NOT executed/i);
  assert.match(text, /does not retry creation/i);
  assert.deepEqual(source.levels, ['offline-module', 'slice-verification']);
  assert.ok(source.files.every(file => file.blobCommit === '5f9ac00' && file.expectedSha256 !== undefined));
  assert.ok(source.files.some(file => file.path.endsWith('core-validation.ts')));
  assert.ok(source.files.some(file => file.path.endsWith('core-validation.test.ts')));
});

test('round9:review-info-only-unmapped', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round8-review');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['independent-review-info']);
  const text = source.limitations.join(' ').toLowerCase();
  for (const needle of ['info', 'not product', 'not referenced']) assert.ok(text.includes(needle), `review limitations missing ${needle}`);
  for (const mapping of PRODUCT_EVIDENCE_MAPPINGS) assert.equal(mapping.sourceIds.includes('round8-review'), false);
  for (const module of MODULE_DEFINITIONS) assert.equal(module.evidenceSourceIds.includes('round8-review'), false);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows);
  for (const system of systems) assert.equal(system.sourceIds.includes('round8-review'), false);
});

test('round9:blobcommit-round8-clean-artifacts-stable', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h7-round8-clean-artifacts');
  assert.ok(source !== undefined);
  for (const file of source.files) {
    assert.equal(file.blobCommit, 'f766ab7');
    const outcome = await verifyEvidenceFileFacts(workspaceRoot, head, file);
    assert.deepEqual(outcome.issues, []);
    assert.equal(outcome.facts.sha256, file.expectedSha256);
  }
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-round9-blob-'));
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

test('round9:product-tooling-vsfl-no-upgrade', async () => {
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

test('round9:acceptance-index-cites-reconcile-limited-evidence', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = new Map(buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows).map(system => [system.systemId, system]));
  for (const [systemId, expected] of [
    ['SYS.3', ['round8-host-core-validation-reconcile', 'h3-core-validation-reconcile', 'round8-lead-integration']],
    ['SYS.8', ['round8-lead-integration', 'round8-host-core-validation-reconcile']],
    ['SYS.9', ['round8-host-core-validation-reconcile']],
  ] as const) {
    const system = systems.get(systemId);
    assert.ok(system !== undefined);
    for (const id of expected) assert.ok(system.sourceIds.includes(id), `${systemId} missing ${id}`);
    assert.equal(system.row?.state, 'limited-only');
  }
  const modulesWith = (id: string) => MODULE_DEFINITIONS.find(module => module.id === id);
  assert.ok(modulesWith('MOD.core')?.evidenceSourceIds.includes('round8-host-core-validation-reconcile'));
  assert.ok(modulesWith('MOD.tool-policy')?.evidenceSourceIds.includes('h3-core-validation-reconcile'));
  assert.ok(modulesWith('MOD.recovery-entry')?.evidenceSourceIds.includes('round8-host-core-validation-reconcile'));
  for (const module of MODULE_DEFINITIONS) {
    assert.ok(module.evidenceSourceIds.every(id => EVIDENCE_SOURCES.some(source => source.id === id)));
    assert.ok(module.systems.length > 0);
  }
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.modules.length, 40);
  assert.equal(acceptance.systems.length, 9);
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round9:slice-evidence-present', async () => {
  const text = await readFile(join(pluginRoot, 'artifacts/dsh/harness/h7-round9-slice.json'), 'utf8').catch(() => null);
  assert.ok(text !== null, 'h7-round9-slice.json must exist');
  const evidence = JSON.parse(text) as {
    kind: string;
    baselineHead: string;
    round8Sources: readonly (string | { readonly id: string })[];
    sourceCounts: { sources: number; files: number };
    files: readonly { path: string; sha256: string; bytes: number }[];
    checks: { sharedTree: { harness: { tests: number; pass: number; fail: number } }; isolatedWorktree: { harness: { tests: number; pass: number; fail: number } } };
    productRows: { total: number; notCovered: number; covered: number };
    toolingReady: readonly string[];
    acceptanceGate: string;
  };
  assert.equal(evidence.kind, 'shiyu.harness.h7-round9-slice-evidence');
  assert.match(evidence.baselineHead, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    evidence.round8Sources.map(item => (typeof item === 'string' ? item : item.id)).sort(),
    [...ROUND8_SOURCE_IDS].sort(),
  );
  assert.deepEqual(evidence.sourceCounts, { sources: 57, files: 179 });
  for (const file of evidence.files) {
    const blob = git(['show', `b01843e:${file.path}`], 'buffer');
    if (blob.status === 0) {
      assert.equal(sha256Hex(blob.stdout as Buffer), file.sha256, `${file.path} slice sha @b01843e`);
    } else {
      const bytes = await readFile(join(workspaceRoot, file.path));
      assert.equal(sha256Hex(bytes), file.sha256, `${file.path} slice sha`);
      assert.equal(bytes.byteLength, file.bytes);
    }
  }
  assert.equal(evidence.checks.sharedTree.harness.fail, 0);
  assert.equal(evidence.checks.isolatedWorktree.harness.fail, 0);
  assert.deepEqual(evidence.productRows, { total: 79, notCovered: 79, covered: 0 });
  assert.deepEqual([...evidence.toolingReady].sort(), ['TV.1', 'TV.2', 'TV.3', 'TV.4', 'TV.5', 'TV.6', 'TV.7', 'TV.9']);
  assert.equal(evidence.acceptanceGate, 'incomplete');
});
