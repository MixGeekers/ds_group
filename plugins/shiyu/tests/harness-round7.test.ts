/**
 * H7-round7 tests: round-6 host isolated inner-lifecycle evidence is bound into
 * the H7 evidence map and acceptance index without upgrading a diagnostic probe
 * into live-memory/business/nine-system acceptance.
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
import { ALL_SCENARIOS } from './harness/business/index.js';
import type { CoverageIndex } from './harness/business/coverage.js';
import type { TraceabilityMatrix } from './harness/traceability.js';
import type { SelfProofArtifact } from './harness/selfproof.js';
import type { HarnessManifest } from './harness/manifest.js';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = join(pluginRoot, '..', '..');
const FIXED_TIME = '2026-11-02T00:00:00.000Z';
const ROUND6_SOURCE_IDS = ['round6-host-inner-lifecycle', 'h4e-isolated-lifecycle-probe', 'round6-lead-integration', 'h7-round6-clean-artifacts'] as const;

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

test('round7:new-host-sources-integrity-and-ancestry', async () => {
  assert.equal(EVIDENCE_SOURCES.length, 47);
  const ids = new Set(EVIDENCE_SOURCES.map(source => source.id));
  for (const id of ROUND6_SOURCE_IDS) assert.ok(ids.has(id), `missing round-6 source ${id}`);
  const newSources = EVIDENCE_SOURCES.filter(source => ROUND6_SOURCE_IDS.includes(source.id as (typeof ROUND6_SOURCE_IDS)[number]));
  assert.equal(newSources.length, 4);
  assert.equal(newSources.reduce((sum, source) => sum + source.files.length, 0), 16);
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
  assert.equal(report.counts.sources, 47);
  assert.equal(report.counts.verified, 47, `unknown: ${report.unknownSourceIds.join(',')}`);
  assert.equal(report.counts.files, 142);
  for (const source of newSources) {
    const verified = report.sources.find(item => item.id === source.id);
    assert.equal(verified?.status, 'verified');
    assert.ok(verified?.files.every(file => file.matchesFrozenHead));
    for (const commit of verified?.commits ?? []) assert.equal(commit.ancestor, true);
  }
  for (const source of newSources) {
    const file = source.files[0];
    const blobRef = file.blobCommit ?? head;
    const blob = git(['show', `${blobRef}:${file.path}`], 'buffer');
    assert.equal(blob.status, 0, `${source.id} show ${blobRef}:${file.path}`);
    if (file.blobCommit === undefined) {
      const disk = await readFile(join(workspaceRoot, file.path));
      assert.equal(sha256Hex(disk), sha256Hex(blob.stdout as Buffer));
    } else {
      assert.equal(sha256Hex(blob.stdout as Buffer), file.expectedSha256);
    }
  }
});

test('round7:host-inner-lifecycle-diagnostic-not-pass', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const source = report.sources.find(item => item.id === 'round6-host-inner-lifecycle');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['fixed-host-zero-model']);
  const text = source.limitations.join(' ');
  for (const required of ['Diagnostic-only', ':memory:', 'SKIPS the memory backend', '59072', 'nine-system acceptance']) {
    assert.ok(text.includes(required), `limitations must include ${required}`);
  }
  // status-final is 59072 bytes and proves only diagnostics-cache passed.
  const size = git(['cat-file', '-s', '8d4c97c:plugins/shiyu/artifacts/dsh/host/round6/status-final.json']).stdout.toString().trim();
  assert.equal(size, '59072');
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'round6-host-inner-lifecycle'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state), `${row.rowId} state ${row.state}`);
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.gate.completeNineSystems, false);
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round7:h4e-isolated-probe-boundary', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h4e-isolated-lifecycle-probe');
  assert.ok(source !== undefined);
  assert.deepEqual(source.files.map(file => file.path).sort(), [
    'plugins/shiyu/artifacts/dsh/h4/h4e-host-lifecycle-probe.json',
    'plugins/shiyu/artifacts/dsh/h4/h4e-runtime-integration.diff',
    'plugins/shiyu/src/control/inner-lifecycle-probe.ts',
    'plugins/shiyu/tests/inner-lifecycle-probe.test.ts',
  ].sort());
  const text = source.limitations.join(' ');
  for (const required of ['14 steps', '9 checks', 'rejects live path', '1507', ':memory:', 'diagnostics only']) {
    assert.ok(text.includes(required), `probe limitations must include ${required}`);
  }
  assert.deepEqual(source.levels, ['offline-module']);
  assert.equal(source.levels.includes('fixed-host-zero-model' as EvidenceLevel), false);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'h4e-isolated-lifecycle-probe'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => !FORBIDDEN_CLAIM_LEVELS.includes(level)));
  }
});

test('round7:blobcommit-round6-clean-artifacts-stable', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h7-round6-clean-artifacts');
  assert.ok(source !== undefined);
  for (const file of source.files) {
    assert.equal(file.blobCommit, 'c89d940');
    assert.ok(file.expectedSha256 !== undefined);
    const outcome = await verifyEvidenceFileFacts(workspaceRoot, head, file);
    assert.deepEqual(outcome.issues, []);
    assert.equal(outcome.facts.sha256, file.expectedSha256);
  }
  // Mutable worktree rewrite must not affect the committed snapshot.
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-round7-blob-'));
  try {
    await symlink(join(workspaceRoot, '.git'), join(directory, '.git'));
    const manifestRef = source.files.find(file => file.path.endsWith('manifest.json'));
    assert.ok(manifestRef !== undefined);
    const target = join(directory, manifestRef.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, '{"rewritten":true}\n', 'utf8');
    assert.deepEqual((await verifyEvidenceFileFacts(directory, head, manifestRef)).issues, []);
    const wrong = await verifyEvidenceFileFacts(directory, head, { ...manifestRef, expectedSha256: '0'.repeat(64) });
    assert.ok(wrong.issues.some(issue => issue.includes('does not match expected committed blob SHA')));
    const missing = await verifyEvidenceFileFacts(directory, head, { ...manifestRef, blobCommit: '0'.repeat(40) });
    assert.ok(missing.issues.some(issue => issue.includes('is not present')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('round7:product-tooling-vsfl-no-upgrade', async () => {
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
  for (const module of acceptance.modules) assert.ok(['limited-only', 'unknown', 'blocked', 'not_covered'].includes(module.status));
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
  void ALL_SCENARIOS;
});

test('round7:acceptance-index-cites-round6-diagnostic', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = new Map(buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows).map(system => [system.systemId, system]));
  for (const [systemId, expected] of [
    ['SYS.5', ['round6-host-inner-lifecycle', 'h4e-isolated-lifecycle-probe', 'round6-lead-integration']],
    ['SYS.8', ['round6-lead-integration', 'round6-host-inner-lifecycle']],
    ['SYS.9', ['round6-host-inner-lifecycle']],
  ] as const) {
    const system = systems.get(systemId);
    assert.ok(system !== undefined);
    for (const id of expected) assert.ok(system.sourceIds.includes(id), `${systemId} missing ${id}`);
    assert.equal(system.row?.state, 'limited-only');
  }
  const modulesWith = (id: string) => MODULE_DEFINITIONS.find(module => module.id === id);
  assert.ok(modulesWith('MOD.memory')?.evidenceSourceIds.includes('h4e-isolated-lifecycle-probe'));
  assert.ok(modulesWith('MOD.relationship')?.evidenceSourceIds.includes('round6-host-inner-lifecycle'));
  assert.ok(modulesWith('MOD.lifecycle')?.evidenceSourceIds.includes('round6-lead-integration'));
  assert.ok(modulesWith('MOD.views')?.evidenceSourceIds.includes('round6-host-inner-lifecycle'));
  assert.ok(modulesWith('MOD.persistence')?.evidenceSourceIds.includes('h4e-isolated-lifecycle-probe'));
  for (const module of MODULE_DEFINITIONS) {
    assert.ok(module.evidenceSourceIds.every(id => EVIDENCE_SOURCES.some(source => source.id === id)));
    assert.ok(module.systems.length > 0);
  }
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.modules.length, 40);
  assert.equal(acceptance.systems.length, 9);
  assert.equal(acceptance.vItems.length, 27);
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round7:slice-evidence-present', async () => {
  const text = await readFile(join(pluginRoot, 'artifacts/dsh/harness/h7-round7-slice.json'), 'utf8').catch(() => null);
  assert.ok(text !== null, 'h7-round7-slice.json must exist');
  const evidence = JSON.parse(text) as {
    kind: string;
    baselineHead: string;
    round6Sources: readonly (string | { readonly id: string })[];
    sourceCounts: { sources: number; files: number };
    files: readonly { path: string; sha256: string; bytes: number }[];
    checks: { sharedTree: { harness: { tests: number; pass: number; fail: number } }; isolatedWorktree: { harness: { tests: number; pass: number; fail: number } } };
    productRows: { total: number; notCovered: number; covered: number };
    toolingReady: readonly string[];
    acceptanceGate: string;
  };
  assert.equal(evidence.kind, 'shiyu.harness.h7-round7-slice-evidence');
  assert.match(evidence.baselineHead, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    evidence.round6Sources.map(item => (typeof item === 'string' ? item : item.id)).sort(),
    [...ROUND6_SOURCE_IDS].sort(),
  );
  assert.deepEqual(evidence.sourceCounts, { sources: 47, files: 142 });
  for (const file of evidence.files) {
    const bytes = await readFile(join(workspaceRoot, file.path));
    assert.equal(sha256Hex(bytes), file.sha256, `${file.path} slice sha`);
    assert.equal(bytes.byteLength, file.bytes);
  }
  assert.equal(evidence.checks.sharedTree.harness.fail, 0);
  assert.equal(evidence.checks.isolatedWorktree.harness.fail, 0);
  assert.deepEqual(evidence.productRows, { total: 79, notCovered: 79, covered: 0 });
  assert.deepEqual([...evidence.toolingReady].sort(), ['TV.1', 'TV.2', 'TV.3', 'TV.4', 'TV.5', 'TV.6', 'TV.7', 'TV.9']);
  assert.equal(evidence.acceptanceGate, 'incomplete');
});
