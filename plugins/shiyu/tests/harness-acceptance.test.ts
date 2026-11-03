/**
 * H7-acceptance tests: 40-module registry completeness, V/S/FL preservation,
 * evidence-derived statuses, honest denominators, negative upgrade rejection,
 * deterministic output and the CLI end-to-end path.
 *
 * The unit tests use committed artifact blobs (`git show HEAD:<path>`) plus a
 * synthetic evidence verification report, so a dirty shared worktree cannot
 * silently change the acceptance fixture; the CLI test exercises the real
 * runner against committed-content input files written to a temp directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCEPTANCE_KIND,
  ACCEPTANCE_REPORT_JSON,
  ACCEPTANCE_REPORT_MARKDOWN,
  buildAcceptanceReport,
  checkAcceptanceHonesty,
  renderAcceptanceMarkdown,
  type AcceptanceInputs,
  type AcceptanceReport,
} from './harness/acceptance.js';
import {
  BLOCKED_RESOURCES,
  BLOCKED_RESOURCE_BY_ID,
  MODULE_AREAS,
  MODULE_DEFINITIONS,
  V_RESOURCE_BLOCKS,
  SCENARIO_RESOURCE_BLOCKS,
  systemIds,
} from './harness/acceptance-registry.js';
import { EVIDENCE_SOURCES, type EvidenceVerificationReport } from './harness/evidence.js';
import { ALL_SCENARIOS } from './harness/business/index.js';
import type { CoverageIndex } from './harness/business/coverage.js';
import type { TraceabilityMatrix } from './harness/traceability.js';
import type { SelfProofArtifact } from './harness/selfproof.js';
import type { HarnessManifest } from './harness/manifest.js';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = join(pluginRoot, '..', '..');
const FIXED_TIME = '2026-11-02T00:00:00.000Z';

function committedJson<T>(relativePath: string): T | null {
  const result = spawnSync('git', ['-C', workspaceRoot, 'show', `HEAD:${relativePath}`], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return null;
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

async function loadDocuments(): Promise<{ moduleCatalog: string; acceptanceDoc: string }> {
  return {
    moduleCatalog: await readFile(join(workspaceRoot, '架构与设计/A方案全景/目录.md'), 'utf8'),
    acceptanceDoc: await readFile(join(workspaceRoot, '架构与设计/A方案全景/验证与验收.md'), 'utf8'),
  };
}

async function buildInputs(overrides: Partial<AcceptanceInputs> = {}): Promise<AcceptanceInputs> {
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
    documents: await loadDocuments(),
    ...overrides,
  };
}

async function validReport(): Promise<{ report: AcceptanceReport; inputs: AcceptanceInputs }> {
  const inputs = await buildInputs();
  const { report, result } = await buildAcceptanceReport(inputs);
  assert.equal(result.ok, true, `acceptance build must not have hard violations: ${JSON.stringify(result.violations.slice(0, 5))}`);
  return { report, inputs };
}

test('acceptance:module-registry-complete', () => {
  assert.equal(MODULE_AREAS.length, 12, 'exactly 12 regions from 目录.md');
  assert.equal(MODULE_DEFINITIONS.length, 40, 'exactly 40 modules from 目录.md');
  assert.equal(new Set(MODULE_AREAS.map(area => area.id)).size, 12);
  assert.equal(new Set(MODULE_DEFINITIONS.map(module => module.id)).size, 40);
  assert.equal(new Set(MODULE_DEFINITIONS.map(module => module.graphId)).size, 40);
  const areaIds = new Set(MODULE_AREAS.map(area => area.id));
  const evidenceIds = new Set(EVIDENCE_SOURCES.map(source => source.id));
  for (const module of MODULE_DEFINITIONS) {
    assert.ok(areaIds.has(module.areaId), `${module.id} area ${module.areaId}`);
    assert.ok(module.systems.length > 0, `${module.id} must map to at least one system`);
    assert.ok(module.systems.every(system => systemIds().includes(system)), `${module.id} system ids 1-9`);
    assert.ok(module.docPath.endsWith('README.md'), `${module.id} doc path`);
    assert.ok(module.docRow.startsWith('(<'), `${module.id} doc row marker`);
    for (const sourceId of module.evidenceSourceIds) assert.ok(evidenceIds.has(sourceId), `${module.id} evidence source ${sourceId}`);
    for (const resourceId of module.blockedResourceIds) assert.ok(BLOCKED_RESOURCE_BY_ID.has(resourceId), `${module.id} blocked resource ${resourceId}`);
  }
  for (const system of systemIds()) {
    assert.ok(MODULE_DEFINITIONS.some(module => module.systems.includes(system)), `system ${system} has modules`);
  }
  // Device + credential modules are resource-blocked, never silently covered.
  for (const moduleId of ['MOD.device-gateway', 'MOD.desktop-device', 'MOD.other-device', 'MOD.robot', 'MOD.credentials']) {
    const module = MODULE_DEFINITIONS.find(item => item.id === moduleId);
    assert.ok((module?.blockedResourceIds ?? []).length > 0, `${moduleId} must be resource-blocked`);
  }
  assert.ok(BLOCKED_RESOURCES.length >= 8, 'blocked resources list must cover real device/channel/model/backup/holdout resources');
  for (const [vId, resources] of Object.entries(V_RESOURCE_BLOCKS)) {
    assert.match(vId, /^V\d{2}$/);
    for (const resourceId of resources) assert.ok(BLOCKED_RESOURCE_BY_ID.has(resourceId), `${vId} resource ${resourceId}`);
  }
});

test('acceptance:preserves-v-and-sfl', async () => {
  const { report } = await validReport();
  assert.equal(report.vItems.length, 27, 'V01–V27 preserved, no renumbering');
  assert.deepEqual(
    report.vItems.map(row => row.id),
    Array.from({ length: 27 }, (_unused, index) => `V${String(index + 1).padStart(2, '0')}`),
  );
  for (const row of report.vItems) {
    assert.ok(row.thresholds.length > 0, `${row.id} must keep the frozen threshold summary`);
    assert.equal(row.sourceHeadingPresent, true, `${row.id} source heading must exist in 验证与验收.md`);
  }
  assert.equal(report.scenarios.length, 16, 'S01–S08 + FL01–FL08');
  for (const scenario of report.scenarios) {
    assert.equal(scenario.status, 'synthetic-fixture-only-not-run');
    assert.equal(scenario.syntheticFixtureOnlyNotRun, true);
    assert.equal(scenario.canUseForBusinessAcceptance, false);
    assert.equal(scenario.coverageFlagsPropagated, true);
    assert.ok(scenario.systems.length > 0, `${scenario.id} maps to at least one system`);
  }
  const h0cScenarioIds = ALL_SCENARIOS.map(scenario => scenario.scenarioId);
  assert.deepEqual(report.scenarios.map(scenario => scenario.id), h0cScenarioIds);
  assert.deepEqual([...SCENARIO_RESOURCE_BLOCKS].sort(), [...new Set(report.scenarios.flatMap(scenario => scenario.blockedResourceIds))].sort());
});

test('acceptance:evidence-derived-statuses', async () => {
  const { report } = await validReport();
  assert.deepEqual(report.issues, [], `build issues: ${JSON.stringify(report.issues.slice(0, 5))}`);
  const allowed = new Set(['not_covered', 'limited-only', 'unknown', 'blocked']);
  for (const module of report.modules) {
    assert.ok(allowed.has(module.status), `${module.id} status ${module.status}`);
    if (module.status === 'limited-only') {
      assert.ok(module.evidenceRefs.some(ref => ref.status === 'verified'), `${module.id} limited-only must cite verified evidence`);
      assert.ok(module.limitations.length > 0, `${module.id} limited-only needs limitations`);
    }
    if (module.status === 'blocked') assert.ok(module.blockedResourceIds.length > 0, `${module.id} blocked needs resource`);
    if (module.status === 'not_covered') assert.equal(module.evidenceSourceIds.length, 0, `${module.id} not_covered must not cite evidence`);
  }
  assert.equal(report.modules.filter(module => module.status === 'blocked').length, 5);
  assert.equal(report.modules.filter(module => module.status === 'limited-only').length, 33);
  assert.equal(report.modules.filter(module => module.status === 'not_covered').length, 2);
  for (const system of report.systems) {
    assert.equal(system.status, 'limited-evidence-only', `${system.id} has limited evidence only`);
    assert.ok(system.modules.length > 0);
    assert.ok(system.limitations.length > 0);
    assert.ok(system.gaps.length > 0);
  }
  assert.equal(report.systems.length, 9);
  // Blocked resources must map to modules/V/scenarios.
  for (const resource of report.gate.blockedResources) {
    assert.ok(resource.blocksModules.length + resource.blocksVItems.length + resource.blocksScenarios.length > 0, `${resource.id} blocks nothing`);
  }
  assert.ok(report.vItems.filter(row => row.status === 'blocked').length >= 10, 'resource-gated V items must be blocked');
});

test('acceptance:unmapped-inputs-are-unknown', async () => {
  const inputs = await buildInputs({ traceability: null, evidence: null, selfproof: null, manifest: null, coverage: null, traceabilitySha256: null, selfproofSha256: null, manifestSha256: null, coverageSha256: null });
  const { report } = await buildAcceptanceReport(inputs);
  for (const system of report.systems) assert.equal(system.status, 'unknown', `${system.id} without traceability must be unknown`);
  for (const module of report.modules) {
    if (module.evidenceSourceIds.length > 0) assert.equal(module.status, 'unknown', `${module.id} with unverified evidence must be unknown`);
    else if (module.blockedResourceIds.length === 0) assert.equal(module.status, 'not_covered', `${module.id} without evidence must be not_covered`);
  }
  for (const scenario of report.scenarios) {
    assert.equal(scenario.status, 'synthetic-fixture-only-not-run');
    assert.equal(scenario.coverageFlagsPropagated, false, 'missing H0c coverage cannot claim flags propagated');
    assert.equal(scenario.canUseForBusinessAcceptance, false);
  }
  assert.ok(report.issues.some(issue => issue.code === 'scenario_coverage_missing'));
  assert.ok(report.issues.some(issue => issue.code === 'module_evidence_unknown'));
  assert.ok(report.issues.some(issue => issue.code === 'mapping_missing'));
  assert.equal(report.gate.overall, 'incomplete');
  assert.equal(report.gate.completeNineSystems, false);
  const honesty = checkAcceptanceHonesty(report);
  assert.equal(honesty.ok, false);
  assert.ok(honesty.violations.some(item => item.code === 'scenario_flag_missing'));
});

test('acceptance:denominators-honest', async () => {
  const { report } = await validReport();
  const { executed, passed, failed } = report.summary.denominators;
  assert.deepEqual({ executed, passed, failed }, { executed: 0, passed: 0, failed: 0 }, 'H7-prep has no acceptance execution');
  const scopes: readonly [string, readonly { readonly status: string }[], AcceptanceReport['summary']['byScope']['modules']][] = [
    ['modules', report.modules, report.summary.byScope.modules],
    ['systems', report.systems, report.summary.byScope.systems],
    ['vItems', report.vItems, report.summary.byScope.vItems],
    ['scenarios', report.scenarios, report.summary.byScope.scenarios],
  ];
  for (const [name, rows, denominator] of scopes) {
    assert.equal(denominator.planned, rows.length, `${name} planned`);
    assert.equal(denominator.executed, 0, `${name} executed`);
    assert.equal(denominator.passed, 0, `${name} passed`);
    assert.equal(denominator.blocked, rows.filter(row => row.status === 'blocked').length, `${name} blocked`);
    assert.equal(denominator.unknown, rows.filter(row => row.status === 'unknown').length, `${name} unknown`);
    assert.equal(
      denominator.executed + denominator.unknown + denominator.blocked + denominator.skipped + denominator.notRun + denominator.notApplicable,
      denominator.planned,
      `${name} denominator sum`,
    );
  }
  const overall = report.summary.denominators;
  assert.equal(overall.planned, 40 + 9 + 27 + 16);
  assert.equal(overall.unknown, report.summary.byScope.modules.unknown + report.summary.byScope.systems.unknown + report.summary.byScope.vItems.unknown + report.summary.byScope.scenarios.unknown);
  assert.equal(overall.blocked, report.summary.byScope.modules.blocked + report.summary.byScope.systems.blocked + report.summary.byScope.vItems.blocked + report.summary.byScope.scenarios.blocked);
  assert.equal(report.gate.overall, 'incomplete');
  assert.equal(report.gate.completeNineSystems, false);
  assert.ok(report.gate.reasons.some(reason => reason.includes('executed=0')));
  assert.ok(report.gate.cannotClaim.some(claim => claim.includes('不得声明完整九系统完成')));
  assert.equal(checkAcceptanceHonesty(report).ok, true);
});

test('acceptance:negative-upgrade-rejected', async () => {
  const { report } = await validReport();
  const mutate = (patch: (copy: Record<string, unknown>) => void): AcceptanceReport => {
    const copy = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    patch(copy);
    return copy as unknown as AcceptanceReport;
  };
  const completeClaim = mutate(copy => {
    (copy.gate as Record<string, unknown>).completeNineSystems = true;
  });
  assert.ok(checkAcceptanceHonesty(completeClaim).violations.some(item => item.code === 'full_completion_claimed'));

  const gateClaim = mutate(copy => {
    (copy.gate as Record<string, unknown>).overall = 'complete';
  });
  assert.ok(checkAcceptanceHonesty(gateClaim).violations.some(item => item.code === 'full_completion_claimed'));

  const modulePass = mutate(copy => {
    const modules = copy.modules as { id: string; status: string }[];
    const target = modules.find(module => module.id === 'MOD.core');
    if (target !== undefined) target.status = 'passed';
  });
  assert.ok(checkAcceptanceHonesty(modulePass).violations.some(item => item.code === 'dimension_passed_claimed'));

  const denominatorLie = mutate(copy => {
    const summary = copy.summary as { denominators: Record<string, number> };
    summary.denominators.passed = 5;
    summary.denominators.executed = 5;
  });
  assert.ok(checkAcceptanceHonesty(denominatorLie).violations.some(item => item.code === 'denominator_mismatch'));

  const scenarioUpgrade = mutate(copy => {
    const scenarios = copy.scenarios as { id: string; status: string; canUseForBusinessAcceptance: boolean }[];
    const target = scenarios.find(scenario => scenario.id === 'S01');
    if (target !== undefined) {
      target.status = 'verified';
      target.canUseForBusinessAcceptance = true;
    }
  });
  const scenarioViolations = checkAcceptanceHonesty(scenarioUpgrade).violations.map(item => item.code);
  assert.ok(scenarioViolations.includes('skeleton_upgraded'));

  const missingFlags = mutate(copy => {
    const scenarios = copy.scenarios as { coverageFlagsPropagated: boolean }[];
    for (const scenario of scenarios) scenario.coverageFlagsPropagated = false;
  });
  assert.ok(checkAcceptanceHonesty(missingFlags).violations.some(item => item.code === 'scenario_flag_missing'));

  const missingBlocked = mutate(copy => {
    (copy.gate as Record<string, unknown>).blockedResources = [];
  });
  assert.ok(checkAcceptanceHonesty(missingBlocked).violations.some(item => item.code === 'blocked_resource_missing'));

  const noCannotClaim = mutate(copy => {
    (copy.gate as Record<string, unknown>).cannotClaim = [];
  });
  assert.ok(checkAcceptanceHonesty(noCannotClaim).violations.some(item => item.code === 'cannot_claim_missing'));

  const noDimensions = mutate(copy => {
    (copy.gate as Record<string, unknown>).completedDimensions = ['nine-systems'];
  });
  assert.ok(checkAcceptanceHonesty(noDimensions).violations.some(item => item.code === 'dimension_passed_claimed'));
});

test('acceptance:deterministic-output-and-cli', async () => {
  const { report, inputs } = await validReport();
  const first = await buildAcceptanceReport(inputs);
  const second = await buildAcceptanceReport(inputs);
  assert.equal(JSON.stringify(first.report), JSON.stringify(second.report), 'same inputs => identical JSON');
  assert.equal(renderAcceptanceMarkdown(first.report), renderAcceptanceMarkdown(second.report), 'same inputs => identical markdown');
  assert.equal(first.report.kind, ACCEPTANCE_KIND);
  assert.match(renderAcceptanceMarkdown(report), /门控结论：incomplete/);
  assert.match(renderAcceptanceMarkdown(report), /不得声明完整九系统完成/);
  assert.match(renderAcceptanceMarkdown(report), /40 模块/);

  // CLI end-to-end: write committed-content inputs to a temp dir and run the
  // real launcher twice; outputs must be byte-identical and gate incomplete.
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-acceptance-cli-'));
  try {
    const inputDir = join(directory, 'inputs');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(inputDir, { recursive: true });
    const files: readonly [string, string][] = [
      ['traceability.json', 'plugins/shiyu/artifacts/dsh/harness/traceability.json'],
      ['tool-selfproof.json', 'plugins/shiyu/artifacts/dsh/harness/tool-selfproof.json'],
      ['manifest.json', 'plugins/shiyu/artifacts/dsh/harness/manifest.json'],
      ['coverage.json', 'plugins/shiyu/artifacts/dsh/harness/fl-scenarios/coverage.json'],
    ];
    const paths: Record<string, string> = {};
    for (const [name, source] of files) {
      const target = join(inputDir, name);
      const blob = spawnSync('git', ['-C', workspaceRoot, 'show', `HEAD:${source}`], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
      assert.equal(blob.status, 0, `committed blob ${source}`);
      await writeFile(target, blob.stdout);
      paths[name] = target;
    }
    const launcher = join(pluginRoot, 'scripts/harness/acceptance.mjs');
    const run = (outDir: string) =>
      spawnSync(
        process.execPath,
        [launcher, '--out-dir', outDir, '--traceability', paths['traceability.json'], '--selfproof', paths['tool-selfproof.json'], '--manifest', paths['manifest.json'], '--coverage', paths['coverage.json'], '--generated-at', FIXED_TIME],
        { cwd: pluginRoot, encoding: 'utf8', timeout: 180_000 },
      );
    const outA = join(directory, 'out-a');
    const outB = join(directory, 'out-b');
    const firstRun = run(outA);
    assert.equal(firstRun.status, 0, `acceptance CLI failed: ${firstRun.stdout}\n${firstRun.stderr}`);
    const secondRun = run(outB);
    assert.equal(secondRun.status, 0, `acceptance CLI rebuild failed: ${secondRun.stdout}\n${secondRun.stderr}`);
    const reportA = JSON.parse(await readFile(join(outA, ACCEPTANCE_REPORT_JSON), 'utf8')) as AcceptanceReport;
    const reportB = JSON.parse(await readFile(join(outB, ACCEPTANCE_REPORT_JSON), 'utf8')) as AcceptanceReport;
    assert.deepEqual(reportA, reportB, 'CLI output must be deterministic');
    assert.equal(reportA.gate.overall, 'incomplete');
    assert.equal(reportA.gate.completeNineSystems, false);
    assert.equal(reportA.summary.denominators.executed, 0);
    assert.equal(reportA.summary.denominators.passed, 0);
    assert.ok((await readFile(join(outA, ACCEPTANCE_REPORT_MARKDOWN), 'utf8')).includes('门控结论：incomplete'));
    assert.equal(checkAcceptanceHonesty(reportA).ok, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('acceptance:no-product-or-network-imports', async () => {
  for (const file of ['tests/harness/acceptance.ts', 'tests/harness/acceptance-registry.ts']) {
    const text = await readFile(join(pluginRoot, file), 'utf8');
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) continue;
      assert.ok(['node:child_process', 'node:fs', 'node:fs/promises', 'node:path', 'node:url', 'node:crypto', 'node:os', 'node:assert/strict', 'node:test'].includes(specifier), `${file} imports ${specifier}`);
    }
    assert.equal(/\bfetch\s*\(/.test(text), false, `${file} must not use network`);
    assert.equal(text.includes('/src/'), false, `${file} must not import product src`);
    assert.equal(text.includes('lab/'), false, `${file} must not import Lab`);
  }
  const harnessReadme = await readFile(join(pluginRoot, 'tests/harness/README.md'), 'utf8');
  const scriptsReadme = await readFile(join(pluginRoot, 'scripts/harness/README.md'), 'utf8');
  for (const required of ['acceptance.mjs', 'acceptance-report.json', '40 模块', '不得声明完整九系统完成', 'blocked']) {
    assert.ok(harnessReadme.includes(required) || scriptsReadme.includes(required), `docs must mention ${required}`);
  }
  void writeFile;
});
