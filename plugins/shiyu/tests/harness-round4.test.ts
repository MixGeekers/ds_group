/**
 * H7-round4 tests: round-3 delivered slices are bound into the evidence
 * mapping and the acceptance index.
 *
 * Covers:
 * - new source integrity (8 round-3 sources, 18 files) and commit ancestry;
 * - file/hash mismatch (and unreadable input) fails closed to `unknown`;
 * - product rows stay 79/79 not_covered and tooling_ready is unchanged;
 * - 40-module/9-system evidenceRefs include the new limited evidence layers
 *   (H5b production-blocked; H2b/H4e/H6c G1/synthetic; host zero-model) while
 *   V/S/FL are never upgraded to pass;
 * - slice evidence `h7-round4-slice.json` is present and consistent.
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
  type EvidenceLevel,
  type EvidenceVerificationReport,
} from './harness/evidence.js';
import { checkHonestStatuses, evaluateTraceability, loadArtifacts, resolveFrozenHead, type TraceabilityMatrix } from './harness/traceability.js';
import { PRODUCT_KINDS } from './harness/traceability-registry.js';
import { sha256Hex } from './harness/invariant.js';
import { MODULE_DEFINITIONS } from './harness/acceptance-registry.js';
import type { TraceabilityMatrix as Matrix } from './harness/traceability.js';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = join(pluginRoot, '..', '..');
const ROUND3_SOURCE_IDS = [
  'h6c-channel-projection-ui',
  'h2b-subscriptions-time',
  'h4e-lifecycle-recompute',
  'h4e-migration-hotfix',
  'h5b-runtime-integration',
  'h7-acceptance-slice',
  'round3-lead-integration',
  'round3-host-zero-model',
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

test('round4:new-sources-integrity-and-ancestry', async () => {
  // 8 new round-3 sources, 18 new files, total 30 sources / 72 files.
  assert.equal(EVIDENCE_SOURCES.length, 79);
  const ids = new Set(EVIDENCE_SOURCES.map(source => source.id));
  for (const id of ROUND3_SOURCE_IDS) assert.ok(ids.has(id), `missing round-3 source ${id}`);
  const newSources = EVIDENCE_SOURCES.filter(source => ROUND3_SOURCE_IDS.includes(source.id as (typeof ROUND3_SOURCE_IDS)[number]));
  assert.equal(newSources.length, 8);
  assert.equal(newSources.reduce((sum, source) => sum + source.files.length, 0), 18);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  for (const source of newSources) {
    assert.ok(source.scope.length > 0, `${source.id} scope`);
    assert.ok(source.limitations.length > 0, `${source.id} limitations`);
    for (const commit of source.commits) {
      assert.equal(git(['cat-file', '-e', `${commit}^{commit}`]).status, 0, `${source.id} commit ${commit} exists`);
      assert.equal(git(['merge-base', '--is-ancestor', commit, head]).status, 0, `${source.id} commit ${commit} is ancestor of HEAD`);
    }
    for (const file of source.files) {
      assert.match(file.path, /^(plugins\/shiyu\/)?(artifacts|tests)\//, `${source.id} file ${file.path}`);
    }
  }
  const { report, result } = await verifyEvidenceSources(workspaceRoot, head);
  assert.equal(result.ok, true, JSON.stringify(result.violations.slice(0, 5)));
  assert.equal(report.counts.sources, 79);
  assert.equal(report.counts.verified, 79, `unknown sources: ${report.unknownSourceIds.join(',')}`);
  assert.equal(report.counts.files, 282);
  for (const source of newSources) {
    const verified = report.sources.find(item => item.id === source.id);
    assert.ok(verified !== undefined, `${source.id} verified entry`);
    assert.equal(verified.status, 'verified');
    assert.ok(verified.files.every(file => file.matchesFrozenHead), `${source.id} file blobs match frozen HEAD`);
    for (const commit of verified.commits) assert.equal(commit.ancestor, true);
  }
  // Independent git-show check for one file of each new source.
  for (const source of newSources) {
    const file = source.files[0];
    const blobRef = file.blobCommit ?? head;
    const blob = git(['show', `${blobRef}:${file.path}`], 'buffer');
    assert.equal(blob.status, 0, `${source.id} git show ${blobRef}:${file.path}`);
    assert.ok(Buffer.isBuffer(blob.stdout));
    if (file.blobCommit === undefined) {
      const disk = await readFile(join(workspaceRoot, file.path));
      assert.equal(sha256Hex(disk), sha256Hex(blob.stdout as Buffer), `${source.id} disk/blob sha`);
    } else {
      assert.equal(sha256Hex(blob.stdout as Buffer), file.expectedSha256, `${source.id} committed blob sha`);
    }
  }
});

test('round4:hash-mismatch-and-unreadable-fail-closed', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-round4-tamper-'));
  try {
    // Temp workspace with a .git symlink to the real repository and all
    // committed evidence files materialized, then one file tampered.
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
    const tamperedPath = join(directory, 'plugins/shiyu/artifacts/dsh/h6/h6c-ui.json');
    const original = await readFile(tamperedPath, 'utf8');
    await writeFile(tamperedPath, `${original}\n`, 'utf8');
    const { report, result } = await verifyEvidenceSources(directory, head);
    assert.equal(result.ok, false, 'tampered evidence must fail closed');
    const h6c = report.sources.find(source => source.id === 'h6c-channel-projection-ui');
    assert.equal(h6c?.status, 'unknown');
    assert.ok(h6c?.issues.some(issue => issue.includes('does not match the frozen HEAD blob')));
    assert.ok(report.unknownSourceIds.includes('h6c-channel-projection-ui'));
    // Other new sources stay verified (only the tampered file is unknown).
    for (const id of ROUND3_SOURCE_IDS.filter(id => id !== 'h6c-channel-projection-ui')) {
      assert.equal(report.sources.find(source => source.id === id)?.status, 'verified', `${id} unaffected by tamper`);
    }
    // Mapping rows that reference the unknown source must become unknown and
    // explain the gap; no row may borrow the evidence level silently.
    const mapping = evaluateEvidenceMapping(report);
    for (const row of mapping.rows.filter(item => item.sources.some(source => source.id === 'h6c-channel-projection-ui'))) {
      assert.equal(row.state, 'unknown', `${row.rowId} must become unknown`);
      assert.ok(row.levels.includes('unknown'));
      assert.ok(row.limitations.some(item => item.includes('h6c-channel-projection-ui')));
    }
    // Missing frozen HEAD also fails closed.
    const unavailable = await verifyEvidenceSources(directory, '0'.repeat(40));
    assert.equal(unavailable.result.ok, false);
    assert.equal(unavailable.report.counts.verified, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('round4:product-rows-and-tooling-ready-unchanged', async () => {
  const committed = committedJson<Matrix>('plugins/shiyu/artifacts/dsh/harness/traceability.json');
  assert.ok(committed !== null, 'committed traceability artifact');
  assert.equal(committed.summary.product.total, 79);
  assert.equal(committed.summary.product.notCovered, 79);
  assert.equal(committed.summary.product.covered, 0);
  const toolingReady = committed.rows.filter(row => row.status === 'tooling_ready').map(row => row.id).sort();
  assert.deepEqual(toolingReady, ['TV.1', 'TV.2', 'TV.3', 'TV.4', 'TV.5', 'TV.6', 'TV.7', 'TV.9']);
  assert.equal(committed.rows.filter(row => row.status === 'self_proven').length, 13);
  for (const row of committed.rows.filter(row => PRODUCT_KINDS.includes(row.kind))) {
    assert.equal(row.status, 'not_covered', `${row.id} must stay not_covered`);
  }
  // Fresh mapping with the real verification report: product-kind mapped rows
  // remain limited-only/unknown and the honesty gate still passes.
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report: verification } = await verifyEvidenceSources(workspaceRoot, head);
  const mapping = evaluateEvidenceMapping(verification);
  assert.ok(mapping.rows.length >= 41);
  const productRowIds = new Set(committed.rows.filter(row => PRODUCT_KINDS.includes(row.kind)).map(row => row.id));
  for (const row of mapping.rows.filter(item => productRowIds.has(item.rowId))) {
    assert.ok(['limited-only', 'unknown', 'none'].includes(row.state), `${row.rowId} state ${row.state}`);
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)), `${row.rowId} limited levels`);
  }
  const honesty = checkEvidenceMappingHonesty(mapping.rows, [...productRowIds]);
  assert.equal(honesty.ok, true, JSON.stringify(honesty.violations.slice(0, 5)));
});

test('round4:acceptance-index-updated-with-limited-evidence', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report: verification } = await verifyEvidenceSources(workspaceRoot, head);
  const mapping = evaluateEvidenceMapping(verification);
  const systems = buildSystemEvidenceSummaries(mapping.rows);
  const bySystem = new Map(systems.map(system => [system.systemId, system]));
  const sys2 = bySystem.get('SYS.2');
  assert.ok(sys2?.sourceIds.includes('h2b-subscriptions-time'));
  assert.ok(sys2?.sourceIds.includes('round3-host-zero-model'));
  const sys8 = bySystem.get('SYS.8');
  assert.ok(sys8?.sourceIds.includes('h5b-runtime-integration'));
  assert.ok(sys8?.sourceIds.includes('h4e-migration-hotfix'));
  assert.ok(sys8?.sourceIds.includes('round3-lead-integration'));
  assert.ok(sys8?.sourceIds.includes('round3-host-zero-model'));
  const sys9 = bySystem.get('SYS.9');
  assert.ok(sys9?.sourceIds.includes('h6c-channel-projection-ui'));
  assert.ok(sys9?.sourceIds.includes('round3-host-zero-model'));
  for (const system of systems) {
    for (const level of system.verifiedLevels) {
      assert.ok(LIMITED_EVIDENCE_LEVELS.includes(level), `${system.systemId} level ${level}`);
      assert.ok(!FORBIDDEN_CLAIM_LEVELS.includes(level));
    }
  }
  // Acceptance registry: 40 modules keep evidence-derived statuses; the new
  // layers are cited by the expected modules and no module becomes passed.
  const moduleWith = (id: string) => MODULE_DEFINITIONS.find(module => module.id === id);
  assert.ok(moduleWith('MOD.views')?.evidenceSourceIds.includes('h6c-channel-projection-ui'));
  assert.ok(moduleWith('MOD.events')?.evidenceSourceIds.includes('h2b-subscriptions-time'));
  assert.ok(moduleWith('MOD.memory')?.evidenceSourceIds.includes('h4e-lifecycle-recompute'));
  assert.ok(moduleWith('MOD.persistence')?.evidenceSourceIds.includes('h4e-migration-hotfix'));
  assert.ok(moduleWith('MOD.checkpoint')?.evidenceSourceIds.includes('h5b-runtime-integration'));
  assert.ok(moduleWith('MOD.lifecycle')?.evidenceSourceIds.includes('round3-host-zero-model'));
  for (const module of MODULE_DEFINITIONS) {
    assert.ok(module.evidenceSourceIds.every(id => EVIDENCE_SOURCES.some(source => source.id === id)));
    assert.ok(module.systems.length > 0);
  }
  // V rows: new limited sources only; statuses never become passing words.
  const v14 = mapping.rows.find(row => row.rowId === 'V14');
  const v22 = mapping.rows.find(row => row.rowId === 'V22');
  const v24 = mapping.rows.find(row => row.rowId === 'V24');
  assert.ok(v14?.sources.some(source => source.id === 'h2b-subscriptions-time'));
  assert.ok(v22?.sources.some(source => source.id === 'h5b-runtime-integration'));
  assert.ok(v24?.sources.some(source => source.id === 'round3-host-zero-model'));
  for (const row of [v14, v22, v24]) {
    assert.ok(row !== undefined);
    assert.ok(['limited-only', 'unknown', 'invalid'].includes(row.state));
    assert.ok(row.levels.every(level => ALLOWED_EVIDENCE_LEVELS.includes(level)));
  }
  // Committed traceability product rows remain not_covered (no pass upgrade).
  const committed = committedJson<Matrix>('plugins/shiyu/artifacts/dsh/harness/traceability.json');
  assert.ok(committed !== null);
  for (const row of committed.rows.filter(row => PRODUCT_KINDS.includes(row.kind))) assert.equal(row.status, 'not_covered');
});

test('round4:limitations-preserve-production-and-boundaries', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const byId = new Map(report.sources.map(source => [source.id, source]));
  const text = (id: string) => (byId.get(id)?.limitations ?? []).join(' ');
  assert.match(text('h5b-runtime-integration'), /production|blocked|GOAL_SESSION_EXPORT_UNAVAILABLE/i);
  assert.match(text('h5b-runtime-integration'), /capture command|NOT executed|not executed/i);
  assert.match(text('h2b-subscriptions-time'), /G1|offline/i);
  assert.match(text('h2b-subscriptions-time'), /synthetic/i);
  assert.match(text('h4e-lifecycle-recompute'), /G1|offline/i);
  assert.match(text('h4e-migration-hotfix'), /offline/i);
  assert.match(text('h6c-channel-projection-ui'), /synthetic/i);
  assert.match(text('h6c-channel-projection-ui'), /DOM/i);
  assert.match(text('round3-host-zero-model'), /zero-model/i);
  assert.match(text('round3-host-zero-model'), /checkpoint capture.*unavailable/i);
  assert.match(text('round3-lead-integration'), /fixed-host/i);
  for (const id of ROUND3_SOURCE_IDS) {
    const source = byId.get(id);
    assert.ok(source !== undefined);
    assert.equal(source.status, 'verified');
    for (const level of source.levels) {
      assert.ok(LIMITED_EVIDENCE_LEVELS.includes(level), `${id} level ${level}`);
      assert.ok(!FORBIDDEN_CLAIM_LEVELS.includes(level));
    }
    assert.equal((source.levels as EvidenceLevel[]).includes('unknown'), false);
  }
  // Product mappings never use conclusion levels.
  for (const mapping of PRODUCT_EVIDENCE_MAPPINGS) {
    for (const level of mapping.levels) assert.ok(!FORBIDDEN_CLAIM_LEVELS.includes(level));
  }
});

test('round4:slice-evidence-present', async () => {
  const text = await readFile(join(pluginRoot, 'artifacts/dsh/harness/h7-round4-slice.json'), 'utf8').catch(() => null);
  assert.ok(text !== null, 'h7-round4-slice.json must exist');
  const evidence = JSON.parse(text) as {
    kind: string;
    baselineHead: string;
    files: readonly { path: string; sha256: string; bytes: number }[];
    round3Sources: readonly (string | { readonly id: string })[];
    checks: { sharedTree: { harness: { tests: number; pass: number; fail: number } }; isolatedWorktree: { harness: { tests: number; pass: number; fail: number } } };
    productRows: { total: number; notCovered: number; covered: number };
    toolingReady: readonly string[];
    acceptanceGate: string;
  };
  assert.equal(evidence.kind, 'shiyu.harness.h7-round4-slice-evidence');
  assert.match(evidence.baselineHead, /^[0-9a-f]{40}$/);
  assert.ok(evidence.files.length >= 2);
  // The slice evidence is a historical snapshot: compare each declared file to
  // its blob at the slice commit when available (later slices may modify it),
  // otherwise fall back to the current worktree file.
  for (const file of evidence.files) {
    const blob = git(['show', `e273aa7:${file.path}`], 'buffer');
    if (blob.status === 0) {
      assert.equal(sha256Hex(blob.stdout as Buffer), file.sha256, `${file.path} slice-evidence blob sha @e273aa7`);
    } else {
      const bytes = await readFile(join(workspaceRoot, file.path));
      assert.equal(sha256Hex(bytes), file.sha256, `${file.path} slice-evidence sha`);
      assert.equal(bytes.byteLength, file.bytes);
    }
  }
  const ids = evidence.round3Sources.map(item => (typeof item === 'string' ? item : item.id)).sort();
  assert.deepEqual(ids, [...ROUND3_SOURCE_IDS].sort());
  assert.equal(evidence.checks.sharedTree.harness.fail, 0);
  assert.equal(evidence.checks.isolatedWorktree.harness.fail, 0);
  assert.equal(evidence.productRows.total, 79);
  assert.equal(evidence.productRows.notCovered, 79);
  assert.equal(evidence.productRows.covered, 0);
  assert.deepEqual([...evidence.toolingReady].sort(), ['TV.1', 'TV.2', 'TV.3', 'TV.4', 'TV.5', 'TV.6', 'TV.7', 'TV.9']);
  assert.equal(evidence.acceptanceGate, 'incomplete');
});
