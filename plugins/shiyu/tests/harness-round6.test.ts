/**
 * H7-round6 tests: round-5 host/fix-chain/tooling evidence is bound into the
 * H7 evidence map and acceptance index without upgrading any diagnostic pass
 * into product acceptance.
 *
 * Covered:
 * - 5 new sources (43 sources/126 files) verify against committed blobs and
 *   commit ancestry;
 * - round-5 host evidence carries `fixed-host-zero-model` +
 *   `bounded-real-model-diagnostic-only`, records usage 1469/41/2406 as reported
 *   and attempts 4/5 as 1 request/0 stream/cost unknown; it is never mapped to
 *   V25 and never counted as pass;
 * - the H2c fix chain (5 commits) is fake-host offline only and does not widen
 *   the H2c boundary or add retries;
 * - committed clean-artifact snapshots stay bound with blobCommit and are
 *   unaffected by mutable worktree rewrites;
 * - product rows stay 79/79 not_covered, tooling_ready/V/S/FL do not upgrade.
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
const ROUND5_SOURCE_IDS = [
  'round5-host-real-model',
  'h2c-probe-fix-chain',
  'h2b-live-time-trigger',
  'h7-blobcommit-hotfix',
  'h7-round5-clean-artifacts',
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

test('round6:new-host-fix-sources-integrity-and-ancestry', async () => {
  assert.equal(EVIDENCE_SOURCES.length, 61);
  const ids = new Set(EVIDENCE_SOURCES.map(source => source.id));
  for (const id of ROUND5_SOURCE_IDS) assert.ok(ids.has(id), `missing round-5 source ${id}`);
  const newSources = EVIDENCE_SOURCES.filter(source => ROUND5_SOURCE_IDS.includes(source.id as (typeof ROUND5_SOURCE_IDS)[number]));
  assert.equal(newSources.length, 5);
  assert.equal(newSources.reduce((sum, source) => sum + source.files.length, 0), 23);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  for (const source of newSources) {
    assert.ok(source.scope.length > 0, `${source.id} scope`);
    assert.ok(source.limitations.length > 0, `${source.id} limitations`);
    for (const commit of source.commits) {
      assert.equal(git(['cat-file', '-e', `${commit}^{commit}`]).status, 0, `${source.id} commit ${commit}`);
      assert.equal(git(['merge-base', '--is-ancestor', commit, head]).status, 0, `${source.id} ${commit} ancestor`);
    }
  }
  const { report, result } = await verifyEvidenceSources(workspaceRoot, head);
  assert.equal(result.ok, true, JSON.stringify(result.violations.slice(0, 5)));
  assert.equal(report.counts.sources, 61);
  assert.equal(report.counts.verified, 61, `unknown: ${report.unknownSourceIds.join(',')}`);
  assert.equal(report.counts.files, 198);
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

test('round6:diagnostic-pass-never-v25-or-business', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const source = report.sources.find(item => item.id === 'round5-host-real-model');
  assert.ok(source !== undefined);
  assert.ok(source.levels.includes('fixed-host-zero-model' as EvidenceLevel));
  assert.ok(source.levels.includes('bounded-real-model-diagnostic-only' as EvidenceLevel));
  assert.equal(source.levels.includes('bounded-real-model' as EvidenceLevel), false, 'diagnostic-only must not claim plain bounded-real-model');
  const text = source.limitations.join(' ');
  for (const required of ['diagnostic', '1469', '41', '2406', 'mainModelStreams=0', 'unknown', 'NOT a full core']) {
    assert.ok(text.includes(required), `host limitations must include ${required}`);
  }
  assert.match(text, /attempts 4 and 5/i);
  // V25 must not be fed by the diagnostic round or the fix chain.
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('round5-host-real-model'), false);
  assert.equal(v25.sourceIds.includes('h2c-probe-fix-chain'), false);
  const mapping = evaluateEvidenceMapping(report);
  const v25Row = mapping.rows.find(row => row.rowId === 'V25');
  assert.ok(v25Row !== undefined);
  assert.ok(['limited-only', 'unknown', 'none', 'invalid'].includes(v25Row.state));
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'round5-host-real-model'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state), `${row.rowId} state ${row.state}`);
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
  // Acceptance gate still incomplete with zero executed/passed.
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.gate.completeNineSystems, false);
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round6:h2c-fix-chain-boundary-preserved', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h2c-probe-fix-chain');
  assert.ok(source !== undefined);
  assert.deepEqual(source.commits, ['7f57ea1', '7704e5d', '3bec321', '3e2bbf9', '6ae4582']);
  for (const commit of source.commits) assert.equal(git(['merge-base', '--is-ancestor', commit, head]).status, 0);
  const text = source.limitations.join(' ');
  assert.match(text, /fake-host/i);
  assert.match(text, /do NOT widen/i);
  assert.match(text, /real model/i);
  assert.equal(source.levels.includes('bounded-real-model' as EvidenceLevel), false);
  assert.equal(source.levels.includes('bounded-real-model-diagnostic-only' as EvidenceLevel), false);
  assert.ok(source.files.some(file => file.path.includes('core-model-probe-diagnostics-verify.json')));
  assert.ok(source.files.some(file => file.path.includes('core-model-probe-context-verify.json')));
  assert.ok(source.files.some(file => file.path.includes('tests/core-event-tools.test.ts')));
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'h2c-probe-fix-chain'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state), `${row.rowId} state ${row.state}`);
    assert.ok(row.levels.every(level => !FORBIDDEN_CLAIM_LEVELS.includes(level)));
  }
});

test('round6:blobcommit-clean-snapshots-stable', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  for (const [id, commit] of [
    ['h7-round4-clean-artifacts', 'dfe4372'],
    ['h7-round5-clean-artifacts', '693fab1'],
  ] as const) {
    const source = EVIDENCE_SOURCES.find(item => item.id === id);
    assert.ok(source !== undefined, id);
    for (const file of source.files) {
      assert.equal(file.blobCommit, commit, `${id} must keep blobCommit ${commit}`);
      assert.ok(file.expectedSha256 !== undefined);
      const outcome = await verifyEvidenceFileFacts(workspaceRoot, head, file);
      assert.deepEqual(outcome.issues, [], `${id} ${file.path}`);
      assert.equal(outcome.facts.matchesFrozenHead, true);
      assert.equal(outcome.facts.sha256, file.expectedSha256);
    }
  }
  // A mutable worktree rewrite cannot affect the committed snapshot.
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-round6-blob-'));
  try {
    await symlink(join(workspaceRoot, '.git'), join(directory, '.git'));
    const source = EVIDENCE_SOURCES.find(item => item.id === 'h7-round5-clean-artifacts');
    assert.ok(source !== undefined);
    const manifestRef = source.files.find(file => file.path.endsWith('manifest.json'));
    assert.ok(manifestRef !== undefined);
    const target = join(directory, manifestRef.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, '{"pipelineRewroteThis":true}\n', 'utf8');
    const rewritten = await verifyEvidenceFileFacts(directory, head, manifestRef);
    assert.deepEqual(rewritten.issues, []);
    assert.equal(rewritten.facts.sha256, manifestRef.expectedSha256);
    // Wrong pinned SHA / missing commit fails closed.
    const wrong = await verifyEvidenceFileFacts(directory, head, { ...manifestRef, expectedSha256: '0'.repeat(64) });
    assert.ok(wrong.issues.some(issue => issue.includes('does not match expected committed blob SHA')));
    const missing = await verifyEvidenceFileFacts(directory, head, { ...manifestRef, blobCommit: '0'.repeat(40) });
    assert.ok(missing.issues.some(issue => issue.includes('is not present')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('round6:product-tooling-vsfl-no-upgrade', async () => {
  const committed = committedJson<TraceabilityMatrix>('plugins/shiyu/artifacts/dsh/harness/traceability.json');
  assert.ok(committed !== null);
  assert.deepEqual(committed.summary.product, { total: 79, covered: 0, notCovered: 79 });
  for (const row of committed.rows.filter(row => PRODUCT_KINDS.includes(row.kind))) assert.equal(row.status, 'not_covered');
  assert.deepEqual(committed.rows.filter(row => row.status === 'tooling_ready').map(row => row.id).sort(), ['TV.1', 'TV.2', 'TV.3', 'TV.4', 'TV.5', 'TV.6', 'TV.7', 'TV.9']);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const mapping = evaluateEvidenceMapping(report);
  assert.equal(mapping.rows.filter(row => /^V\d{2}$/.test(row.rowId)).length > 0, true);
  for (const row of mapping.rows.filter(item => ['V14', 'V22', 'V24', 'V25'].includes(item.rowId))) {
    assert.ok(['limited-only', 'unknown', 'none'].includes(row.state), `${row.rowId} state ${row.state}`);
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
  const honesty = checkEvidenceMappingHonesty(mapping.rows, committed.rows.filter(row => PRODUCT_KINDS.includes(row.kind)).map(row => row.id));
  assert.equal(honesty.ok, true, JSON.stringify(honesty.violations.slice(0, 5)));
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.scenarios.length, ALL_SCENARIOS.length);
  for (const scenario of acceptance.scenarios) {
    assert.equal(scenario.status, 'synthetic-fixture-only-not-run');
    assert.equal(scenario.canUseForBusinessAcceptance, false);
  }
  for (const module of acceptance.modules) {
    assert.ok(['limited-only', 'unknown', 'blocked', 'not_covered'].includes(module.status), `${module.id} ${module.status}`);
  }
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round6:acceptance-index-cites-round5-limited-evidence', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = new Map(buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows).map(system => [system.systemId, system]));
  for (const [systemId, expected] of [
    ['SYS.2', ['round5-host-real-model', 'h2c-probe-fix-chain', 'h2b-live-time-trigger']],
    ['SYS.3', ['h2c-probe-fix-chain', 'round5-host-real-model']],
    ['SYS.9', ['round5-host-real-model']],
  ] as const) {
    const system = systems.get(systemId);
    assert.ok(system !== undefined);
    for (const id of expected) assert.ok(system.sourceIds.includes(id), `${systemId} missing ${id}`);
    assert.equal(system.row?.state, 'limited-only');
    assert.ok(system.verifiedLevels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
  const modulesWith = (id: string) => MODULE_DEFINITIONS.find(module => module.id === id);
  assert.ok(modulesWith('MOD.events')?.evidenceSourceIds.includes('round5-host-real-model'));
  assert.ok(modulesWith('MOD.event-schedule')?.evidenceSourceIds.includes('h2b-live-time-trigger'));
  assert.ok(modulesWith('MOD.core')?.evidenceSourceIds.includes('h2c-probe-fix-chain'));
  assert.ok(modulesWith('MOD.tool-policy')?.evidenceSourceIds.includes('round5-host-real-model'));
  assert.ok(modulesWith('MOD.views')?.evidenceSourceIds.includes('round5-host-real-model'));
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

test('round6:slice-evidence-present', async () => {
  const text = await readFile(join(pluginRoot, 'artifacts/dsh/harness/h7-round6-slice.json'), 'utf8').catch(() => null);
  assert.ok(text !== null, 'h7-round6-slice.json must exist');
  const evidence = JSON.parse(text) as {
    kind: string;
    baselineHead: string;
    round5Sources: readonly (string | { readonly id: string })[];
    sourceCounts: { sources: number; files: number };
    files: readonly { path: string; sha256: string; bytes: number }[];
    checks: { sharedTree: { harness: { tests: number; pass: number; fail: number } }; isolatedWorktree: { harness: { tests: number; pass: number; fail: number } } };
    productRows: { total: number; notCovered: number; covered: number };
    toolingReady: readonly string[];
    acceptanceGate: string;
  };
  assert.equal(evidence.kind, 'shiyu.harness.h7-round6-slice-evidence');
  assert.match(evidence.baselineHead, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    evidence.round5Sources.map(item => (typeof item === 'string' ? item : item.id)).sort(),
    [...ROUND5_SOURCE_IDS].sort(),
  );
  assert.deepEqual(evidence.sourceCounts, { sources: 43, files: 126 });
  for (const file of evidence.files) {
    const blob = git(['show', `08243b4:${file.path}`], 'buffer');
    if (blob.status === 0) {
      assert.equal(sha256Hex(blob.stdout as Buffer), file.sha256, `${file.path} slice sha @08243b4`);
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
