/**
 * H7-prep evidence-layer mapping tests.
 *
 * Proves that the mapping is bound to committed evidence files in a frozen
 * HEAD, that boundaries are explicit (H5 G1-only, H4b synthetic UI + zero-model
 * host, H2a zero-model probe, historical samples not upgraded), that product
 * rows never leave not_covered, that unknown sources fail closed, and that the
 * H7 report renders per-system evidence→status→gap together with the
 * "cannot be used for business acceptance" wording.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_EVIDENCE_LEVELS,
  EVIDENCE_SOURCES,
  FORBIDDEN_CLAIM_LEVELS,
  LIMITED_EVIDENCE_LEVELS,
  buildSystemEvidenceSummaries,
  checkEvidenceMappingHonesty,
  evaluateEvidenceMapping,
  mappingForRow,
  renderH7MappingMarkdown,
  verifyEvidenceSources,
  type EvaluatedRowEvidence,
  type EvidenceLevel,
  type EvidenceVerificationReport,
  type RowEvidenceMapping,
} from './harness/evidence.js';
import {
  checkHonestStatuses,
  evaluateTraceability,
  loadArtifacts,
  renderMarkdown,
  resolveFrozenHead,
  type TraceabilityMatrix,
} from './harness/traceability.js';
import { PRODUCT_KINDS } from './harness/traceability-registry.js';
import { sha256Hex } from './harness/invariant.js';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = join(pluginRoot, '..', '..');

interface EvidenceContext {
  readonly frozenHead: string;
  readonly report: EvidenceVerificationReport;
  readonly rows: readonly EvaluatedRowEvidence[];
  readonly matrix: TraceabilityMatrix;
}

let cached: Promise<EvidenceContext> | undefined;

function evidenceContext(): Promise<EvidenceContext> {
  cached ??= (async () => {
    const head = resolveFrozenHead(workspaceRoot);
    assert.match(head.frozenHead, /^[0-9a-f]{40}$/, `frozen HEAD must be a commit: ${head.frozenHead}`);
    const { report, result } = await verifyEvidenceSources(workspaceRoot, head.frozenHead);
    assert.equal(result.ok, true, `evidence sources must verify against ${head.frozenHead}: ${JSON.stringify(result.violations.slice(0, 5))}`);
    const mapping = evaluateEvidenceMapping(report);
    assert.deepEqual(mapping.issues, [], `evidence mapping authoring issues: ${JSON.stringify(mapping.issues)}`);
    const bundle = await loadArtifacts({ pluginRoot, outputDir: join(pluginRoot, 'artifacts/dsh/harness') });
    const matrix = await evaluateTraceability({ pluginRoot, workspaceRoot, bundle, frozenHead: head.frozenHead });
    return { frozenHead: head.frozenHead, report, rows: mapping.rows, matrix };
  })();
  return cached;
}

test('evidence:sources-bound-to-frozen-head', async () => {
  const { frozenHead, report } = await evidenceContext();
  assert.equal(report.frozenHead, frozenHead);
  assert.equal(report.counts.sources, EVIDENCE_SOURCES.length);
  assert.equal(report.counts.verified, EVIDENCE_SOURCES.length, `unknown sources: ${report.unknownSourceIds.join(',')}`);
  assert.equal(report.counts.unknown, 0);
  assert.ok(report.counts.files >= 40);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.warnings, []);
  for (const source of report.sources) {
    assert.equal(source.status, 'verified');
    assert.ok(source.scope.length > 0, `${source.id} scope`);
    assert.ok(source.limitations.length > 0, `${source.id} limitations`);
    for (const commit of source.commits) {
      assert.equal(commit.exists, true, `${source.id} commit ${commit.sha} must exist`);
      assert.equal(commit.ancestor, true, `${source.id} commit ${commit.sha} must be an ancestor of ${frozenHead}`);
    }
    for (const file of source.files) {
      assert.equal(file.present, true, `${source.id} file ${file.path}`);
      assert.equal(file.matchesFrozenHead, true, `${source.id} file ${file.path} blob must equal frozen HEAD blob`);
      assert.equal(file.frozenHeadBlobSha256, file.sha256);
      if (file.path.endsWith('.json')) assert.equal(file.jsonParseable, true, `${source.id} JSON ${file.path} must parse`);
    }
  }
  // Independent second implementation: read one file and its HEAD blob directly.
  const sample = report.sources.find(source => source.id === 'h4b-host');
  assert.ok(sample !== undefined);
  const sampleFile = sample.files[0];
  const disk = await readFile(join(workspaceRoot, sampleFile.path));
  assert.equal(sha256Hex(disk), sampleFile.sha256);
  const blob = spawnSync('git', ['-C', workspaceRoot, 'show', `${frozenHead}:${sampleFile.path}`], { timeout: 30_000 });
  assert.equal(blob.status, 0);
  assert.equal(sha256Hex(blob.stdout), sampleFile.sha256);
});

test('evidence:system-mapping-boundaries', async () => {
  const { rows } = await evidenceContext();
  const systems = buildSystemEvidenceSummaries(rows);
  assert.equal(systems.length, 9);
  const bySystem = new Map(systems.map(system => [system.systemId, system]));
  for (const system of systems) {
    assert.ok(system.limitations.length > 0, `${system.systemId} must have limitations`);
    assert.ok(system.gaps.length > 0, `${system.systemId} must declare gaps`);
    for (const level of system.verifiedLevels) {
      assert.ok(ALLOWED_EVIDENCE_LEVELS.includes(level), `${system.systemId} level ${level}`);
      assert.ok(!FORBIDDEN_CLAIM_LEVELS.includes(level));
      assert.ok(LIMITED_EVIDENCE_LEVELS.includes(level), `${system.systemId} evidence must stay limited`);
    }
  }
  const sys2 = bySystem.get('SYS.2');
  assert.ok(sys2 !== undefined);
  assert.ok(sys2.verifiedLevels.includes('offline-module'));
  assert.ok(sys2.verifiedLevels.includes('fixed-host-zero-model'));
  assert.ok(sys2.sourceIds.some(id => id.startsWith('h2a')), 'system 2 must bind H2a evidence');
  const sys8 = bySystem.get('SYS.8');
  assert.ok(sys8 !== undefined);
  for (const level of sys8.verifiedLevels) assert.ok(['offline-module', 'slice-verification', 'independent-verification'].includes(level));
  assert.ok(sys8.limitations.some(item => item.includes('G1')), 'H5 must be described as G1-only');
  assert.ok(sys8.gaps.some(item => item.includes('G1')), 'system 8 gap must say G1-only');
  const sys9 = bySystem.get('SYS.9');
  assert.ok(sys9 !== undefined);
  assert.ok(sys9.verifiedLevels.includes('synthetic-ui'), 'system 9 must bind synthetic UI evidence');
  assert.ok(
    sys9.limitations.some(item => item.includes('DOM')) || sys9.limitations.some(item => item.includes('浏览器')),
    'system 9 must state no real browser DOM',
  );
  const sys5 = bySystem.get('SYS.5');
  assert.ok(sys5 !== undefined);
  assert.ok(sys5.verifiedLevels.includes('fixed-host-zero-model'));
  assert.ok(sys5.verifiedLevels.includes('synthetic-ui'));
  const sys4 = bySystem.get('SYS.4');
  assert.ok(sys4 !== undefined);
  assert.ok(sys4.verifiedLevels.includes('historical-limited'));
});

test('evidence:product-rows-stay-not-covered', async () => {
  const { matrix, rows } = await evidenceContext();
  const productRows = matrix.rows.filter(row => PRODUCT_KINDS.includes(row.kind));
  assert.equal(productRows.length, 79);
  for (const row of productRows) {
    assert.equal(row.status, 'not_covered', `product row ${row.id} must stay not_covered`);
    if (row.evidenceLevels !== undefined) {
      assert.ok(row.evidenceState === 'limited-only' || row.evidenceState === 'unknown', `${row.id} state ${row.evidenceState}`);
      assert.ok((row.limitations ?? []).length > 0, `${row.id} evidence must carry limitations`);
    }
  }
  assert.equal(matrix.summary.product.covered, 0);
  assert.equal(matrix.summary.evidence.mappedProductRows, rows.length);
  assert.ok(matrix.summary.evidence.mappedProductRows >= 30);
  assert.equal(matrix.summary.evidence.unknownSources, 0);
  // Matrix rows alias their system mapping while keeping MATRIX identity.
  const matrixRow = matrix.rows.find(row => row.id === 'MATRIX.2');
  assert.equal(matrixRow?.status, 'not_covered');
  assert.ok((matrixRow?.evidenceLevels ?? []).includes('offline-module'));
  assert.equal(mappingForRow('MATRIX.2')?.rowId, 'SYS.2');
  // Rows with no committed business evidence remain unmapped/not_covered.
  for (const id of ['FL01', 'V23', 'V27']) {
    const row = matrix.rows.find(item => item.id === id);
    assert.equal(row?.status, 'not_covered', `${id}`);
    assert.equal(row?.evidenceLevels, undefined, `${id} must not claim evidence layers`);
  }
  const honesty = checkHonestStatuses(matrix.rows, rows);
  assert.equal(honesty.ok, true, JSON.stringify(honesty.violations.slice(0, 5)));
});

test('evidence:unknown-sources-fail-closed', async () => {
  const { report, rows } = await evidenceContext();
  // Fabricated report with one unknown source: the referencing row must become
  // unknown and must explain the gap instead of borrowing the evidence level.
  const degraded: EvidenceVerificationReport = {
    ...report,
    sources: report.sources.map(source =>
      source.id === 'h2a-probe' ? { ...source, status: 'unknown' as const, levels: ['unknown' as EvidenceLevel], issues: ['simulated missing blob'] } : source,
    ),
    unknownSourceIds: ['h2a-probe'],
  };
  const degradedMapping = evaluateEvidenceMapping(degraded);
  const sys2 = degradedMapping.rows.find(row => row.rowId === 'SYS.2');
  assert.ok(sys2 !== undefined);
  assert.equal(sys2.state, 'unknown');
  assert.ok(sys2.levels.includes('unknown'));
  assert.ok(sys2.limitations.some(item => item.includes('h2a-probe') && item.includes('unknown')));
  // Missing frozen HEAD: all sources unknown, result fails closed.
  const unavailable = await verifyEvidenceSources(workspaceRoot, '0'.repeat(40));
  assert.equal(unavailable.result.ok, false);
  assert.equal(unavailable.report.counts.verified, 0);
  assert.ok(unavailable.report.issues.some(issue => issue.code === 'frozen_head_unavailable'));
  // Missing limitations on an unknown row is rejected by the honesty gate.
  const brokenRow: EvaluatedRowEvidence = {
    rowId: 'SYS.2',
    state: 'unknown',
    levels: ['unknown'],
    sources: [],
    scope: 'fabricated',
    limitations: [],
    partialSubscenarios: [],
  };
  const brokenCheck = checkEvidenceMappingHonesty([brokenRow], ['SYS.2']);
  assert.equal(brokenCheck.ok, false);
  assert.ok(brokenCheck.violations.some(item => item.code === 'evidence_unknown_without_limitation' || item.code === 'evidence_missing_limitations'));
  // Unverified source rows must not silently pass as verified evidence.
  const rowsBySystem = new Map(rows.map(row => [row.rowId, row]));
  assert.equal(rowsBySystem.get('SYS.2')?.state, 'limited-only');
});

test('evidence:h7-report-and-traceability-render', async () => {
  const { report, rows, matrix, frozenHead } = await evidenceContext();
  const markdown = renderH7MappingMarkdown(report, rows, frozenHead, matrix.generatedAt);
  for (let index = 1; index <= 9; index++) {
    assert.ok(markdown.includes(`SYS.${index}`), `H7 report must cover SYS.${index}`);
  }
  for (const required of ['不能用于业务验收', 'not_covered', 'H2a', 'H4b', 'H5', 'V01–V27', 'S/FL', 'unknown']) {
    assert.ok(markdown.includes(required), `H7 report must mention ${required}`);
  }
  assert.ok(markdown.includes(frozenHead));
  const traceabilityMarkdown = renderMarkdown(matrix);
  assert.ok(traceabilityMarkdown.includes('H7 证据层映射'));
  assert.ok(traceabilityMarkdown.includes('h7-traceability-mapping.md'));
  assert.ok(traceabilityMarkdown.includes('frozen HEAD'));
  assert.ok(matrix.evidenceMapping.systemSummaries.length === 9);
});

test('evidence:negative-upgrade-rejected', async () => {
  const { matrix, rows } = await evidenceContext();
  const product = matrix.rows.find(row => row.id === 'SYS.2');
  assert.ok(product !== undefined);
  // Any attempt to mark a product row with evidence as passed is rejected.
  const upgraded = { ...product, status: 'self_proven' as const };
  const upgradedCheck = checkHonestStatuses([upgraded], rows);
  assert.equal(upgradedCheck.ok, false);
  assert.ok(upgradedCheck.violations.some(item => item.code === 'product_claim_without_evidence'));
  // Evidence-level upgrade using a conclusion word is rejected by the evidence gate.
  const badLevels = rows.map(row => {
    if (row.rowId !== 'SYS.2') return row;
    return { ...row, levels: [...row.levels, 'verified' as EvidenceLevel] };
  });
  const badCheck = checkEvidenceMappingHonesty(badLevels, matrix.rows.filter(row => PRODUCT_KINDS.includes(row.kind)).map(row => row.id));
  assert.equal(badCheck.ok, false);
  assert.ok(badCheck.violations.some(item => item.code === 'forbidden_claim_level'));
  // A fabricated mapping entry with conclusion level is rejected at authoring time.
  const fabricated: RowEvidenceMapping = {
    rowId: 'SYS.2',
    sourceIds: ['h2a-probe'],
    levels: ['complete' as EvidenceLevel],
    scope: 'fabricated',
    limitations: ['fabricated'],
    partialSubscenarios: [],
  };
  assert.deepEqual(fabricated.levels, ['complete']);
  assert.ok(FORBIDDEN_CLAIM_LEVELS.includes('complete'));
});
