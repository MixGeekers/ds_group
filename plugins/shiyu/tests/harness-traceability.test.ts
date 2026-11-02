/**
 * Traceability tests (H0.TRACEABILITY).
 *
 * Proves that the registry really transcribes the handoff documents (headings
 * verified against the Markdown), that statuses are derived only from frozen
 * evidence, and that the honesty gate refuses product "pass" claims.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_REQUIREMENT_ROWS,
  PRODUCT_KINDS,
  SOURCE_DOCUMENTS,
  HARNESS_CAPABILITY_ROWS,
} from './harness/traceability-registry.js';
import type { RequirementRow } from './harness/traceability-registry.js';
import {
  loadSourceDocuments,
  verifySourceReferences,
  verifyPlanVIndex,
  evaluateTraceability,
  checkHonestStatuses,
  renderMarkdown,
  type ArtifactBundle,
  type EvaluatedRequirement,
} from './harness/traceability.js';
import { ALL_SELF_PROOFS, oracleTestName } from './harness/index.js';
import { listHarnessTestFiles, SELF_PROOF_KIND, type SelfProofArtifact } from './harness/selfproof.js';
import { buildManifest } from './harness/manifest.js';
import { sha256Hex } from './harness/invariant.js';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = join(pluginRoot, '..', '..');

async function withTempDirectory<T>(prefix: string, body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readDocumentTexts(): Promise<Map<string, readonly string[]>> {
  const texts = new Map<string, readonly string[]>();
  for (const doc of SOURCE_DOCUMENTS) {
    texts.set(doc.id, (await readFile(join(workspaceRoot, doc.path), 'utf8')).split('\n'));
  }
  return texts;
}

function emptyBundle(): ArtifactBundle {
  return {
    selfproof: null,
    selfproofState: { path: 'artifacts/dsh/harness/tool-selfproof.json', present: false, sha256: null, note: 'absent' },
    selfproofCheck: null,
    manifest: null,
    manifestState: { path: 'artifacts/dsh/harness/manifest.json', present: false, sha256: null, note: 'absent' },
    manifestCheck: null,
  };
}

async function collectHarnessSourceHashes(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${prefix}/${entry.name}`);
      else hashes[`${prefix}/${entry.name}`] = sha256Hex(await readFile(join(directory, entry.name)));
    }
  };
  await walk(join(pluginRoot, 'tests/harness'), 'tests/harness');
  for (const testFile of await listHarnessTestFiles(pluginRoot)) {
    hashes[testFile] = sha256Hex(await readFile(join(pluginRoot, testFile)));
  }
  return hashes;
}

async function buildFakeSelfProof(directory: string, options: { omitTests?: readonly string[] } = {}): Promise<string> {
  const expectedFiles = await listHarnessTestFiles(pluginRoot);
  const sourceHashes = await collectHarnessSourceHashes();
  const requiredNames = new Set<string>(['docs:readme-contract']);
  for (const row of HARNESS_CAPABILITY_ROWS) for (const name of row.verification?.requiredTests ?? []) requiredNames.add(name);
  for (const proof of ALL_SELF_PROOFS) requiredNames.add(oracleTestName(proof.name));
  for (const omitted of options.omitTests ?? []) requiredNames.delete(omitted);
  const testNames = [...requiredNames].map(name => ({ name, ok: true }));
  const files = expectedFiles.map((path, index) => ({
    path,
    sha256: sourceHashes[path],
    exitCode: 0,
    ok: true,
    tests: index === 0 ? testNames : [],
    pass: index === 0 ? testNames.length : 0,
    fail: 0,
    durationMs: 1,
    tapSha256: 'f'.repeat(64),
  }));
  const artifact = {
    schemaVersion: 1,
    kind: SELF_PROOF_KIND,
    generatedAt: '2026-11-02T00:00:00.000Z',
    harnessVersion: '0.1.0',
    selfProofCorpus: 'h0-selfproof-1',
    pluginRoot: '<plugin-root>',
    command: ['node', '--import', 'tsx', 'scripts/harness/selfproof.mjs'],
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    expectedFiles,
    files,
    totals: { pass: testNames.length, fail: 0, skipped: 0, cancelled: 0, todo: 0, files: files.length },
    passed: true,
    failures: [],
    oracleSelfProofs: ALL_SELF_PROOFS.map(proof => ({ name: proof.name, testName: oracleTestName(proof.name), verified: true })),
    sourceHashes,
    rawTap: { path: 'tool-selfproof.tap', sha256: sha256Hex('tap'), bytes: 3 },
  } satisfies Record<string, unknown>;
  const path = join(directory, 'tool-selfproof.json');
  await writeFile(path, JSON.stringify(artifact, null, 2));
  return path;
}

function sampleRow(patch: Partial<EvaluatedRequirement> & Pick<RequirementRow, 'id' | 'kind' | 'title' | 'source'>): EvaluatedRequirement {
  return {
    ...patch,
    systems: patch.systems ?? [],
    refs: patch.refs ?? {},
    thresholds: patch.thresholds ?? [],
    codePaths: patch.codePaths ?? [],
    testIds: patch.testIds ?? [],
    oracles: patch.oracles ?? [],
    historicalEvidence: patch.historicalEvidence ?? [],
    note: patch.note ?? '',
    status: patch.status ?? 'not_covered',
    statusBasis: patch.statusBasis ?? 'test',
    sourceVerified: patch.sourceVerified ?? true,
    verifiedTests: patch.verifiedTests ?? [],
    missingTests: patch.missingTests ?? [],
    oracleStatus: patch.oracleStatus ?? [],
    artifactChecks: patch.artifactChecks ?? [],
    evidence: patch.evidence ?? {},
  };
}

test('traceability:registry-complete-and-sourced', async () => {
  const documents = await loadSourceDocuments(workspaceRoot);
  for (const doc of SOURCE_DOCUMENTS) {
    const state = documents.get(doc.id);
    assert.ok(state !== undefined && state.present, `source document ${doc.path} must exist`);
    assert.match(state!.sha256, /^[0-9a-f]{64}$/);
  }
  const texts = await readDocumentTexts();
  const check = verifySourceReferences(ALL_REQUIREMENT_ROWS, documents, texts);
  assert.deepEqual(check.issues, [], JSON.stringify(check.issues.slice(0, 10), null, 2));
  assert.equal(check.verified.size, ALL_REQUIREMENT_ROWS.length, 'every requirement source must resolve to a real heading/table row');
  assert.equal(verifyPlanVIndex(documents, texts), true, '九系统计划 §5 must index V01–V27');
  const counts: Record<string, number> = {};
  for (const row of ALL_REQUIREMENT_ROWS) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  assert.deepEqual(counts, {
    'nine-system': 9,
    'v-item': 27,
    'business-scenario': 8,
    'fl-scenario': 8,
    'scoring-dimension': 8,
    'combo-scenario': 10,
    'system-matrix': 9,
    'tool-verification': 9,
    'harness-asset': 8,
    'harness-capability': 7,
  });
  const ids = new Set(ALL_REQUIREMENT_ROWS.map(row => row.id));
  assert.equal(ids.size, ALL_REQUIREMENT_ROWS.length);
  for (const row of ALL_REQUIREMENT_ROWS) {
    assert.ok(row.title.length > 0, `${row.id} title`);
    assert.ok(row.source.doc.length > 0 && row.source.heading.length > 0 && row.source.contains.length > 0, `${row.id} source ref`);
  }
});

test('traceability:statuses-are-evidence-derived', async () => {
  const empty = await evaluateTraceability({ pluginRoot, workspaceRoot, bundle: emptyBundle() });
  const productRows = empty.rows.filter(row => PRODUCT_KINDS.includes(row.kind));
  assert.equal(productRows.length, 79);
  for (const row of productRows) assert.equal(row.status, 'not_covered', `product row ${row.id} must not claim coverage in H0`);
  assert.equal(empty.summary.product.covered, 0);
  assert.equal(empty.summary.harnessCurated.selfProven, 0, 'without artifacts no H0 capability may be self_proven');
  for (const row of empty.rows.filter(item => item.kind === 'v-item')) assert.equal(row.status, 'not_covered');
  assert.equal(checkHonestStatuses(empty.rows).ok, true, 'honest "not covered" reporting passes the honesty gate');
  // With a frozen, fresh, complete artifact bundle the H0 capabilities (and
  // only they) become self_proven; tool-verification rows stay "tooling ready".
  const passingTests = new Set<string>();
  for (const proof of ALL_SELF_PROOFS) passingTests.add(oracleTestName(proof.name));
  for (const row of HARNESS_CAPABILITY_ROWS) for (const name of row.verification?.requiredTests ?? []) passingTests.add(name);
  passingTests.add('docs:readme-contract');
  const complete: ArtifactBundle = {
    ...emptyBundle(),
    selfproof: { passed: true } as unknown as SelfProofArtifact,
    selfproofState: { path: 'artifacts/dsh/harness/tool-selfproof.json', present: true, sha256: 'a'.repeat(64), generatedAt: '2026-11-02T00:00:00.000Z', note: 'self-proof passed' },
    selfproofCheck: { ok: true, fresh: true, passingTests, failingTests: new Set(), issues: [] },
    manifest: { kind: 'shiyu.harness.manifest' } as never,
    manifestState: { path: 'artifacts/dsh/harness/manifest.json', present: true, sha256: 'b'.repeat(64), generatedAt: '2026-11-02T00:00:00.000Z', note: 'manifest files match' },
    manifestCheck: { ok: true, issues: [] },
  };
  const full = await evaluateTraceability({ pluginRoot, workspaceRoot, bundle: complete });
  const capabilities = full.rows.filter(row => row.kind === 'harness-capability');
  assert.equal(capabilities.filter(row => row.status === 'self_proven').length, capabilities.length, JSON.stringify(capabilities.map(row => [row.id, row.status, row.statusBasis])));
  const tooling = full.rows.filter(row => row.kind === 'tool-verification');
  assert.equal(tooling.filter(row => row.status === 'tooling_ready').length, 8, 'oracle-backed tool-verification rows are tooling_ready, never self_proven');
  assert.equal(tooling.find(row => row.id === 'TV.8')?.status, 'not_covered', 'semantic judge rows have no deterministic oracle in H0');
  const product = full.rows.filter(row => PRODUCT_KINDS.includes(row.kind));
  for (const row of product) assert.equal(row.status, 'not_covered');
  const honesty = checkHonestStatuses(full.rows);
  assert.equal(honesty.ok, true, JSON.stringify(honesty.violations.slice(0, 5)));
  assert.equal(full.summary.oracles.verified, ALL_SELF_PROOFS.length);
  assert.equal(full.handoff.milestone, 'H0b');
  assert.match(full.handoff.rule, /禁止后续切片复用 H0 的 tooling_ready 冒充产品通过/);
  assert.ok(full.handoff.forbidden.some(item => item.includes('tooling_ready')));
  assert.match(full.handoff.productRowSource, /独立运行证据/);
  const markdown = renderMarkdown(full);
  assert.ok(markdown.includes('H0 工具能力'));
  assert.ok(markdown.includes('未覆盖'));
  assert.ok(markdown.includes('H0b 交接规则'));
});

test('traceability:cli-generates-json-and-markdown', async () => {
  await withTempDirectory('shiyu-harness-trace-', async directory => {
    const selfproofPath = await buildFakeSelfProof(directory);
    const fakeManifest = await buildManifest({ pluginRoot, workspaceRoot, includeBuild: false, roots: ['package.json', 'tests/harness/fixtures'] });
    const manifestPath = join(directory, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(fakeManifest, null, 2)}\n`);
    const outDir = join(directory, 'out');
    await mkdir(outDir, { recursive: true });
    const launcher = join(pluginRoot, 'scripts/harness/traceability.mjs');
    const result = spawnSync(process.execPath, [launcher, '--out-dir', outDir, '--selfproof', selfproofPath, '--manifest', manifestPath, '--workspace-root', workspaceRoot, '--strict'], {
      cwd: pluginRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `traceability CLI failed: ${result.stdout}\n${result.stderr}`);
    const matrix = JSON.parse(await readFile(join(outDir, 'traceability.json'), 'utf8')) as {
      kind: string;
      summary: { product: { total: number; covered: number }; harnessCurated: { selfProven: number; total: number }; oracles: { verified: number; total: number } };
      rows: { id: string; kind: string; status: string }[];
    };
    assert.equal(matrix.kind, 'shiyu.harness.traceability');
    assert.equal(matrix.summary.product.covered, 0);
    assert.equal(matrix.summary.product.total, 79);
    const capabilityCount = matrix.rows.filter(row => row.kind === 'harness-capability' && row.status === 'self_proven').length;
    assert.equal(capabilityCount, 7, 'all seven H0 capability rows should be self_proven with a complete artifact bundle');
    assert.equal(matrix.summary.harnessCurated.selfProven, matrix.rows.filter(row => row.kind !== 'nine-system' && row.kind !== 'v-item' && row.kind !== 'business-scenario' && row.kind !== 'fl-scenario' && row.kind !== 'scoring-dimension' && row.kind !== 'combo-scenario' && row.kind !== 'system-matrix' && row.status === 'self_proven').length);
    assert.equal(matrix.summary.oracles.verified, ALL_SELF_PROOFS.length);
    assert.ok(matrix.rows.every(row => !(row.kind !== 'harness-capability' && row.kind !== 'harness-asset' && row.kind !== 'tool-verification' && row.status !== 'not_covered')));
    const markdown = await readFile(join(outDir, 'traceability.md'), 'utf8');
    assert.ok(markdown.includes('# H0 测试工具覆盖追踪报告'));
    assert.ok(markdown.includes('## 3. H0 工具能力'));
    assert.ok(markdown.includes('## 10. 未覆盖与下一步'));
    assert.ok(markdown.includes('产品需求'));
    // Missing self-proof artifact: strict generation exits 3 and reports the
    // uncovered H0 denominator instead of pretending green.
    const missingOut = join(directory, 'missing-out');
    const missing = spawnSync(
      process.execPath,
      [launcher, '--out-dir', missingOut, '--selfproof', join(directory, 'does-not-exist.json'), '--manifest', manifestPath, '--workspace-root', workspaceRoot, '--strict'],
      { cwd: pluginRoot, encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(missing.status, 3, `strict run without self-proof must exit 3: ${missing.stderr}`);
    const missingMatrix = JSON.parse(await readFile(join(missingOut, 'traceability.json'), 'utf8')) as { summary: { harnessCurated: { selfProven: number; notCovered: number } } };
    assert.equal(missingMatrix.summary.harnessCurated.selfProven, 0);
    assert.ok(missingMatrix.summary.harnessCurated.notCovered > 0);
  });
});

test('traceability:rejects-unsupported-pass-claims', () => {
  const product = sampleRow({ id: 'V99', kind: 'v-item', title: 'fake', source: { doc: 'doc-v', heading: '### V99', contains: 'x' }, status: 'self_proven' });
  const harnessWithoutEvidence = sampleRow({
    id: 'H0.FAKE',
    kind: 'harness-capability',
    title: 'fake capability',
    source: { doc: 'doc-02', heading: '## 1.', contains: 'x' },
    status: 'self_proven',
  });
  const toolingNoOracle = sampleRow({
    id: 'TV.99',
    kind: 'tool-verification',
    title: 'fake tooling',
    source: { doc: 'doc-02', heading: '### 3.2', contains: 'x' },
    status: 'tooling_ready',
  });
  const unknown = sampleRow({ id: 'X', kind: 'harness-capability', title: 'x', source: { doc: 'doc-02', heading: '## 1.', contains: 'x' }, status: 'passed' as never });
  const unverifiedSource = sampleRow({ id: 'Y', kind: 'combo-scenario', title: 'y', source: { doc: 'doc-02', heading: '### 6.1', contains: 'x' }, sourceVerified: false });
  const check = checkHonestStatuses([product, harnessWithoutEvidence, toolingNoOracle, unknown, unverifiedSource]);
  assert.equal(check.ok, false);
  const codes = check.violations.map(item => item.code);
  for (const expected of ['product_claim_without_evidence', 'self_proven_without_evidence', 'tooling_ready_without_oracle', 'unknown_status', 'row_source_unverified']) {
    assert.ok(codes.includes(expected), `expected ${expected} in ${codes.join(',')}`);
  }
});
