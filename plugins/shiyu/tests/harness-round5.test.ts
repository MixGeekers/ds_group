/**
 * H7-round5 tests: round-4 probe/host/failure evidence is bound into the H7
 * evidence map and acceptance index.
 *
 * Hard requirements covered here:
 * - 8 new sources (38 sources/103 files) verify against committed blobs and
 *   commit ancestry;
 * - the H2c bounded real-model attempt failed before any model request and must
 *   never be reported as pass; host evidence is zero-model limited;
 * - a tampered/unreadable file fails closed to `unknown` and referencing rows
 *   become unknown instead of borrowing a level;
 * - product rows stay 79/79 not_covered, tooling_ready and V/S/FL do not
 *   upgrade merely because more limited evidence was bound;
 * - the acceptance index cites the new limited evidence for the expected
 *   systems/modules while keeping the gate incomplete.
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
  verifyEvidenceSources,
  verifyEvidenceFileFacts,
  type EvidenceFileRef,
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
const ROUND4_SOURCE_IDS = [
  'h2b-host-time-probe',
  'h2c-real-model-probe',
  'h5b-checkpoint-probe',
  'h7-round4-slice',
  'round4-lead-integration',
  'round4-localcore-hotfix',
  'round4-host-zero-model',
  'h7-round4-clean-artifacts',
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
        sha256: '0'.repeat(64),
        bytes: 1,
        present: true,
        matchesFrozenHead: true,
        frozenHeadBlobSha256: '0'.repeat(64),
        lastCommit: null,
        expectedCommit: file.sliceCommit,
        jsonParseable: true,
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

test('round5:new-probe-sources-integrity-and-ancestry', async () => {
  assert.equal(EVIDENCE_SOURCES.length, 38);
  const ids = new Set(EVIDENCE_SOURCES.map(source => source.id));
  for (const id of ROUND4_SOURCE_IDS) assert.ok(ids.has(id), `missing round-4 source ${id}`);
  const newSources = EVIDENCE_SOURCES.filter(source => ROUND4_SOURCE_IDS.includes(source.id as (typeof ROUND4_SOURCE_IDS)[number]));
  assert.equal(newSources.length, 8);
  assert.equal(newSources.reduce((sum, source) => sum + source.files.length, 0), 31);
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
  assert.equal(report.counts.sources, 38);
  assert.equal(report.counts.verified, 38, `unknown: ${report.unknownSourceIds.join(',')}`);
  assert.equal(report.counts.files, 103);
  for (const source of newSources) {
    const verified = report.sources.find(item => item.id === source.id);
    assert.equal(verified?.status, 'verified');
    assert.ok(verified?.files.every(file => file.matchesFrozenHead));
    for (const commit of verified?.commits ?? []) assert.equal(commit.ancestor, true);
  }
  // Independent git-show blob check for each new source's first file.
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

test('round5:real-model-failure-never-pass', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const byId = new Map(report.sources.map(source => [source.id, source]));
  const h2c = byId.get('h2c-real-model-probe');
  assert.ok(h2c !== undefined);
  const h2cText = h2c.limitations.join(' ');
  assert.match(h2cText, /implementer did NOT execute the real model/i);
  assert.match(h2cText, /failed before any model request/i);
  assert.match(h2cText, /must never be counted as pass/i);
  assert.equal(h2c.levels.includes('bounded-real-model'), false, 'offline H2c kit must not claim bounded real-model level');
  const host = byId.get('round4-host-zero-model');
  assert.ok(host !== undefined);
  const hostText = host.limitations.join(' ');
  assert.match(hostText, /FAILED before any model request/i);
  assert.match(hostText, /must never be recorded as pass/i);
  assert.match(hostText, /zero-model/i);
  for (const source of report.sources) {
    for (const level of source.levels as EvidenceLevel[]) {
      assert.ok(!FORBIDDEN_CLAIM_LEVELS.includes(level), `${source.id} forbidden level ${level}`);
      assert.ok(LIMITED_EVIDENCE_LEVELS.includes(level), `${source.id} limited level ${level}`);
    }
  }
  // Fresh mapping: rows citing the failed attempt stay limited/unknown only.
  const mapping = evaluateEvidenceMapping(report);
  const mappedRows = mapping.rows.filter(row => row.sources.some(source => source.id === 'h2c-real-model-probe' || source.id === 'round4-host-zero-model'));
  assert.ok(mappedRows.length > 0);
  for (const row of mappedRows) {
    assert.ok(['limited-only', 'unknown', 'none'].includes(row.state), `${row.rowId} state ${row.state}`);
    assert.ok(row.levels.every(level => ALLOWED_EVIDENCE_LEVELS.includes(level)));
    assert.ok(!row.levels.includes('complete' as EvidenceLevel));
  }
  // Acceptance report cannot turn the failed attempt into a pass.
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.gate.completeNineSystems, false);
  const h2cModules = MODULE_DEFINITIONS.filter(module => module.evidenceSourceIds.includes('h2c-real-model-probe')).map(module => module.id);
  assert.ok(h2cModules.length > 0);
  for (const moduleId of h2cModules) {
    const row = acceptance.modules.find(module => module.id === moduleId);
    assert.ok(row !== undefined);
    assert.ok(['limited-only', 'unknown', 'blocked', 'not_covered'].includes(row.status), `${moduleId} status ${row.status}`);
  }
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round5:hash-mismatch-fails-closed', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-round5-tamper-'));
  try {
    await symlink(join(workspaceRoot, '.git'), join(directory, '.git'));
    for (const source of EVIDENCE_SOURCES) {
      for (const file of source.files) {
        const target = join(directory, file.path);
        await mkdir(dirname(target), { recursive: true });
        const blob = git(['show', `${head}:${file.path}`], 'buffer');
        assert.equal(blob.status, 0, `materialize ${file.path}`);
        await writeFile(target, blob.stdout as Buffer);
      }
    }
    const tampered = join(directory, 'plugins/shiyu/artifacts/dsh/h2/h2c-real-model-probe.json');
    const text = await readFile(tampered, 'utf8');
    await writeFile(tampered, `${text}\n`, 'utf8');
    const { report, result } = await verifyEvidenceSources(directory, head);
    assert.equal(result.ok, false);
    const h2c = report.sources.find(source => source.id === 'h2c-real-model-probe');
    assert.equal(h2c?.status, 'unknown');
    assert.ok(report.unknownSourceIds.includes('h2c-real-model-probe'));
    const mapping = evaluateEvidenceMapping(report);
    for (const row of mapping.rows.filter(item => item.sources.some(source => source.id === 'h2c-real-model-probe'))) {
      assert.equal(row.state, 'unknown', `${row.rowId} must fail closed`);
      assert.ok(row.levels.includes('unknown'));
    }
    const unavailable = await verifyEvidenceSources(directory, '0'.repeat(40));
    assert.equal(unavailable.result.ok, false);
    assert.equal(unavailable.report.counts.verified, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('round5:product-tooling-and-vsfl-stay', async () => {
  const committed = committedJson<TraceabilityMatrix>('plugins/shiyu/artifacts/dsh/harness/traceability.json');
  assert.ok(committed !== null);
  assert.equal(committed.summary.product.total, 79);
  assert.equal(committed.summary.product.notCovered, 79);
  assert.equal(committed.summary.product.covered, 0);
  for (const row of committed.rows.filter(row => PRODUCT_KINDS.includes(row.kind))) assert.equal(row.status, 'not_covered');
  const toolingReady = committed.rows.filter(row => row.status === 'tooling_ready').map(row => row.id).sort();
  assert.deepEqual(toolingReady, ['TV.1', 'TV.2', 'TV.3', 'TV.4', 'TV.5', 'TV.6', 'TV.7', 'TV.9']);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const mapping = evaluateEvidenceMapping(report);
  // V items gain limited evidence references only; no V moves to a pass state.
  for (const vId of ['V14', 'V22', 'V24']) {
    const row = mapping.rows.find(item => item.rowId === vId);
    assert.ok(row !== undefined, `${vId} mapped`);
    assert.ok(['limited-only', 'unknown', 'none'].includes(row.state), `${vId} state ${row.state}`);
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
  assert.equal(mapping.rows.filter(row => /^V\d{2}$/.test(row.rowId)).length > 0, true);
  // H0c scenarios keep synthetic-only flags in the acceptance report.
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.scenarios.length, ALL_SCENARIOS.length);
  for (const scenario of acceptance.scenarios) {
    assert.equal(scenario.status, 'synthetic-fixture-only-not-run');
    assert.equal(scenario.canUseForBusinessAcceptance, false);
  }
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  assert.equal(acceptance.gate.completedDimensions.length, 0);
  void PRODUCT_EVIDENCE_MAPPINGS;
});

test('round5:acceptance-index-cites-new-limited-evidence', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = new Map(buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows).map(system => [system.systemId, system]));
  for (const [systemId, expected] of [
    ['SYS.2', ['h2b-host-time-probe', 'h2c-real-model-probe', 'round4-lead-integration', 'round4-host-zero-model']],
    ['SYS.3', ['h2c-real-model-probe', 'round4-localcore-hotfix', 'round4-host-zero-model']],
    ['SYS.8', ['h5b-checkpoint-probe', 'round4-lead-integration', 'round4-host-zero-model']],
    ['SYS.9', ['round4-host-zero-model']],
  ] as const) {
    const system = systems.get(systemId);
    assert.ok(system !== undefined);
    for (const id of expected) assert.ok(system.sourceIds.includes(id), `${systemId} missing ${id}`);
    assert.equal(system.row?.state, 'limited-only');
    for (const level of system.verifiedLevels) assert.ok(LIMITED_EVIDENCE_LEVELS.includes(level));
  }
  const modulesWith = (id: string) => MODULE_DEFINITIONS.find(module => module.id === id);
  assert.ok(modulesWith('MOD.events')?.evidenceSourceIds.includes('h2c-real-model-probe'));
  assert.ok(modulesWith('MOD.core')?.evidenceSourceIds.includes('round4-localcore-hotfix'));
  assert.ok(modulesWith('MOD.tool-policy')?.evidenceSourceIds.includes('h2c-real-model-probe'));
  assert.ok(modulesWith('MOD.checkpoint')?.evidenceSourceIds.includes('h5b-checkpoint-probe'));
  assert.ok(modulesWith('MOD.lifecycle')?.evidenceSourceIds.includes('round4-host-zero-model'));
  assert.ok(modulesWith('MOD.views')?.evidenceSourceIds.includes('round4-host-zero-model'));
  for (const module of MODULE_DEFINITIONS) {
    assert.ok(module.evidenceSourceIds.every(id => EVIDENCE_SOURCES.some(source => source.id === id)));
    assert.ok(module.systems.length > 0);
  }
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.modules.length, 40);
  assert.equal(acceptance.systems.length, 9);
  assert.equal(acceptance.vItems.length, 27);
  assert.equal(acceptance.scenarios.length, 16);
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.gate.completeNineSystems, false);
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round5:blob-commit-snapshot-survives-pipeline-rewrites', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h7-round4-clean-artifacts');
  assert.ok(source !== undefined);
  const manifestRef = source.files.find(file => file.path.endsWith('manifest.json'));
  assert.ok(manifestRef !== undefined);
  assert.equal(manifestRef.blobCommit, 'dfe4372');
  // The committed snapshot verifies independently of the worktree file.
  const outcome = await verifyEvidenceFileFacts(workspaceRoot, head, manifestRef);
  assert.deepEqual(outcome.issues, []);
  assert.equal(outcome.facts.present, true);
  assert.equal(outcome.facts.matchesFrozenHead, true);
  assert.equal(outcome.facts.sha256, manifestRef.expectedSha256);
  // Simulate a pipeline rewrite in a temp workspace: the worktree file differs
  // completely, but the committed blob snapshot still verifies.
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-round5-blob-'));
  try {
    await symlink(join(workspaceRoot, '.git'), join(directory, '.git'));
    const target = join(directory, manifestRef.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, '{"rewrittenByPipeline":true}\n', 'utf8');
    const rewritten = await verifyEvidenceFileFacts(directory, head, manifestRef);
    assert.deepEqual(rewritten.issues, []);
    assert.equal(rewritten.facts.sha256, manifestRef.expectedSha256);
    // A non-snapshot source (default worktree check) fails on the same rewrite.
    const defaultRef = EVIDENCE_SOURCES.find(item => item.id === 'h2b-host-time-probe')?.files[0];
    assert.ok(defaultRef !== undefined);
    const materialized = join(directory, defaultRef.path);
    await mkdir(dirname(materialized), { recursive: true });
    const blob = git(['show', `${head}:${defaultRef.path}`], 'buffer');
    await writeFile(materialized, blob.stdout as Buffer);
    assert.deepEqual((await verifyEvidenceFileFacts(directory, head, defaultRef)).issues, []);
    await writeFile(materialized, `${(blob.stdout as Buffer).toString('utf8')}\n`, 'utf8');
    const tampered = await verifyEvidenceFileFacts(directory, head, defaultRef);
    assert.equal(tampered.facts.matchesFrozenHead, false);
    assert.ok(tampered.issues.some(issue => issue.includes('does not match the frozen HEAD blob')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('round5:blob-commit-invalid-fails-closed', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h7-round4-clean-artifacts');
  assert.ok(source !== undefined);
  const manifestRef = source.files.find(file => file.path.endsWith('manifest.json'));
  assert.ok(manifestRef !== undefined);
  // Wrong pinned SHA (as if the committed blob was tampered): unknown, not pass.
  const wrongSha: EvidenceFileRef = { ...manifestRef, expectedSha256: '0'.repeat(64) };
  const wrong = await verifyEvidenceFileFacts(workspaceRoot, head, wrongSha);
  assert.equal(wrong.facts.matchesFrozenHead, false);
  assert.ok(wrong.issues.some(issue => issue.includes('does not match expected committed blob SHA')));
  // Missing blob commit fails closed.
  const missingCommit: EvidenceFileRef = { ...manifestRef, blobCommit: '0'.repeat(40) };
  const missing = await verifyEvidenceFileFacts(workspaceRoot, head, missingCommit);
  assert.ok(missing.issues.some(issue => issue.includes('is not present')));
  // Not-an-ancestor blob commit fails closed (dfe4372 is not an ancestor of an
  // earlier frozen HEAD).
  const earlyHead = git(['rev-parse', 'af201fe']).stdout.toString().trim();
  const notAncestor: EvidenceFileRef = { ...manifestRef, blobCommit: 'dfe4372' };
  const ancestry = await verifyEvidenceFileFacts(workspaceRoot, earlyHead, notAncestor);
  assert.ok(ancestry.issues.some(issue => issue.includes('is not an ancestor')));
  const early = await verifyEvidenceSources(workspaceRoot, earlyHead);
  const earlySource = early.report.sources.find(item => item.id === 'h7-round4-clean-artifacts');
  assert.equal(earlySource?.status, 'unknown');
  assert.ok(early.report.unknownSourceIds.includes('h7-round4-clean-artifacts'));
  assert.equal(early.result.ok, false);
});

test('round5:slice-evidence-present', async () => {
  const text = await readFile(join(pluginRoot, 'artifacts/dsh/harness/h7-round5-slice.json'), 'utf8').catch(() => null);
  assert.ok(text !== null, 'h7-round5-slice.json must exist');
  const evidence = JSON.parse(text) as {
    kind: string;
    baselineHead: string;
    round4Sources: readonly (string | { readonly id: string })[];
    sourceCounts: { sources: number; files: number };
    files: readonly { path: string; sha256: string; bytes: number }[];
    checks: { sharedTree: { harness: { tests: number; pass: number; fail: number } }; isolatedWorktree: { harness: { tests: number; pass: number; fail: number } } };
    productRows: { total: number; notCovered: number; covered: number };
    toolingReady: readonly string[];
    acceptanceGate: string;
  };
  assert.equal(evidence.kind, 'shiyu.harness.h7-round5-slice-evidence');
  assert.match(evidence.baselineHead, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    evidence.round4Sources.map(item => (typeof item === 'string' ? item : item.id)).sort(),
    [...ROUND4_SOURCE_IDS].sort(),
  );
  assert.deepEqual(evidence.sourceCounts, { sources: 38, files: 103 });
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
