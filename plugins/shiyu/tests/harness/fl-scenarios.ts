#!/usr/bin/env node
/**
 * H0c command: generate the S/FL synthetic fixture pack, independent answer
 * pack, coverage index and scoring skeleton, then freeze their digests.
 *
 * This command performs no model, embedding, Lab, host, channel or device
 * operation. It only reads design documents and writes synthetic artifacts
 * under `artifacts/dsh/harness/fl-scenarios/`.
 *
 *   node scripts/harness/fl-scenarios.mjs [--out-dir <dir>] [--seed <int>]
 *     [--plugin-root <dir>] [--workspace-root <dir>] [--selfproof <file>]
 *     [--require-selfproof] [--print]
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex, type CheckResult, type Violation } from './invariant.js';
import { finish, violation } from './invariant.js';
import { canonicalJsonString } from './json.js';
import {
  ALL_SCENARIOS,
  BUSINESS_SELF_PROOFS,
  BUSINESS_TEST_IDS,
  H0C_REQUIRED_ZERO_REMOTE,
  aggregateCaseResults,
  answerPackDigest,
  buildCoverageIndex,
  businessOracleTestName,
  catalogSourceFiles,
  checkAggregationHonesty,
  checkCatalogIntegrity,
  checkCoverageHonesty,
  checkFixtureIsolation,
  checkSplitPolicy,
  defaultSplitPolicy,
  generateAnswerPack,
  generateFixturePack,
  renderCoverageMarkdown,
  type AggregationPlan,
  type AnswerPack,
  type CoverageIndex,
  type FixturePack,
} from './business/index.js';
import type { CaseRunResult } from './business/scoring.js';

export const BUSINESS_AUTHORING_TIME = '2026-11-02T00:00:00.000Z';
export const BUSINESS_MANIFEST_SCHEMA_VERSION = 1;
export const BUSINESS_MANIFEST_KIND = 'shiyu.harness.business.manifest';

const REQUIRED_BUSINESS_TEST_NAMES: readonly string[] = [
  ...BUSINESS_SELF_PROOFS.map(proof => businessOracleTestName(proof.name)),
  ...BUSINESS_TEST_IDS.filter(id => !id.startsWith('business-oracle:')),
];

interface ToolSelfProofSummary {
  readonly path: string;
  readonly present: boolean;
  readonly sha256: string | null;
  readonly passingTests: ReadonlySet<string>;
  readonly fresh: boolean;
  readonly issues: readonly string[];
}

async function walkFiles(directory: string, prefix: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === '__pycache__') continue;
    if (entry.isDirectory()) files.push(...(await walkFiles(join(directory, entry.name), `${prefix}/${entry.name}`)));
    else files.push(`${prefix}/${entry.name}`);
  }
  return files;
}

async function summarizeToolSelfProof(pluginRoot: string, selfproofOverride?: string): Promise<ToolSelfProofSummary> {
  const path = resolve(selfproofOverride ?? join(pluginRoot, 'artifacts/dsh/harness/tool-selfproof.json'));
  const displayPath = relative(pluginRoot, path);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { path: displayPath, present: false, sha256: null, passingTests: new Set(), fresh: false, issues: ['tool-selfproof artifact is absent (run scripts/harness/selfproof.mjs first)'] };
  }
  const issues: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return { path: displayPath, present: true, sha256: sha256Hex(text), passingTests: new Set(), fresh: false, issues: [`artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const artifact = parsed as {
    kind?: string;
    passed?: boolean;
    files?: { tests?: { name: string; ok: boolean }[] }[];
    sourceHashes?: Record<string, string>;
  };
  const passingTests = new Set<string>();
  for (const file of artifact.files ?? []) for (const test of file.tests ?? []) if (test.ok) passingTests.add(test.name);
  if (artifact.kind !== 'shiyu.harness.selfproof') issues.push('artifact kind is not shiyu.harness.selfproof');
  if (artifact.passed !== true) issues.push('self-proof artifact did not pass');
  // Freshness for the H0c files only (H0b files are checked by traceability).
  const currentHashes = new Map<string, string>();
  for (const file of await walkFiles(join(pluginRoot, 'tests/harness/business'), 'tests/harness/business')) {
    currentHashes.set(file, sha256Hex(await readFile(join(pluginRoot, file))));
  }
  const testFile = 'tests/harness-business.test.ts';
  try {
    currentHashes.set(testFile, sha256Hex(await readFile(join(pluginRoot, testFile))));
  } catch {
    issues.push(`${testFile} is absent`);
  }
  let fresh = true;
  for (const [file, hash] of currentHashes) {
    const recorded = artifact.sourceHashes?.[file];
    if (recorded === undefined) {
      fresh = false;
      issues.push(`artifact does not record source hash for ${file}`);
    } else if (recorded !== hash) {
      fresh = false;
      issues.push(`artifact source hash for ${file} is stale`);
    }
  }
  const missingTests = REQUIRED_BUSINESS_TEST_NAMES.filter(name => !passingTests.has(name));
  for (const missing of missingTests) issues.push(`required business test not passing in artifact: ${missing}`);
  return { path: displayPath, present: true, sha256: sha256Hex(text), passingTests, fresh, issues };
}

function parseArgs(argv: readonly string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error(`unexpected argument ${item}`);
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(key, next);
      index++;
    } else args.set(key, true);
  }
  return args;
}

async function writeJson(path: string, value: unknown): Promise<{ sha256: string; bytes: number }> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
  return { sha256: sha256Hex(text), bytes: Buffer.byteLength(text, 'utf8') };
}

export interface BusinessCliResult {
  readonly exitCode: number;
  readonly summary: string;
  readonly manifest?: Record<string, unknown>;
}

export async function runBusinessCli(argv: readonly string[], defaults?: { pluginRoot?: string; workspaceRoot?: string }): Promise<BusinessCliResult> {
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const args = parseArgs(argv);
  const pluginRoot = resolve(typeof args.get('plugin-root') === 'string' ? String(args.get('plugin-root')) : defaults?.pluginRoot ?? moduleRoot);
  const workspaceRoot = resolve(
    typeof args.get('workspace-root') === 'string' ? String(args.get('workspace-root')) : defaults?.workspaceRoot ?? resolve(pluginRoot, '../..'),
  );
  const outDir = resolve(typeof args.get('out-dir') === 'string' ? String(args.get('out-dir')) : join(pluginRoot, 'artifacts/dsh/harness/fl-scenarios'));
  const seed = typeof args.get('seed') === 'string' ? Number(args.get('seed')) : 20261101;
  const selfproofOverride = typeof args.get('selfproof') === 'string' ? resolve(String(args.get('selfproof'))) : undefined;
  const requireSelfProof = args.get('require-selfproof') === true;
  const print = args.get('print') === true;
  if (!Number.isSafeInteger(seed) || seed < 0) return { exitCode: 1, summary: `invalid --seed ${String(args.get('seed'))}` };
  const generatedAt = new Date().toISOString();
  const fixture = generateFixturePack({ seed, generatedAt: BUSINESS_AUTHORING_TIME });
  const answers = generateAnswerPack({ seed, generatedAt: BUSINESS_AUTHORING_TIME, frozenAt: BUSINESS_AUTHORING_TIME });
  const fixtureRoot = join(outDir, 'fixtures');
  const answersRoot = join(outDir, 'answers');

  const catalogCheck = checkCatalogIntegrity(ALL_SCENARIOS);
  const isolationCheck = checkFixtureIsolation(fixture, answers, { fixtureDirectory: fixtureRoot, answersDirectory: answersRoot });
  const splitCheck = checkSplitPolicy(defaultSplitPolicy());
  const coverage = await buildCoverageIndex({ workspaceRoot, seed, generatedAt, catalogVersion: '1.0.0' });
  const coverageHonesty = checkCoverageHonesty(coverage.index);

  // Driver-boundary probe for the first step of every scenario.
  const driverViolations: Violation[] = [];
  for (const scenario of fixture.scenarios) {
    const firstStep = scenario.steps[0];
    if (firstStep === undefined) continue;
    const { buildDriverInput, checkDriverInputBoundary } = await import('./business/fixtures.js');
    const driverCheck = checkDriverInputBoundary(fixture, answers, buildDriverInput(fixture, scenario.scenarioId, firstStep.stepId));
    driverViolations.push(...driverCheck.violations);
  }

  // Frozen scoring skeleton: one representative case per scenario, empty run.
  const plan: AggregationPlan = {
    planId: 'h0c-skeleton-plan',
    freezeRef: `catalog:${fixture.catalogDigest}`,
    cases: ALL_SCENARIOS.map(scenario => ({
      caseId: `${scenario.scenarioId}-representative`,
      scenarioId: scenario.scenarioId,
      requiredMilestones: scenario.milestones.map(milestone => milestone.id),
    })),
  };
  const emptyResults: CaseRunResult[] = [];
  const emptyReport = aggregateCaseResults(plan, emptyResults);
  const aggregationCheck = checkAggregationHonesty(emptyReport, plan, emptyResults);

  const selfProof = await summarizeToolSelfProof(pluginRoot, selfproofOverride);
  const oracleSelfProofs = BUSINESS_SELF_PROOFS.map(proof => ({
    name: proof.name,
    version: proof.version,
    module: proof.module,
    testName: businessOracleTestName(proof.name),
    verified: selfProof.passingTests.has(businessOracleTestName(proof.name)),
  }));
  const allOraclesVerified = oracleSelfProofs.every(item => item.verified) && selfProof.fresh && selfProof.issues.length === 0;

  const failures: Violation[] = [
    ...catalogCheck.violations.map(item => ({ ...item, code: `catalog:${item.code}` })),
    ...isolationCheck.violations.map(item => ({ ...item, code: `isolation:${item.code}` })),
    ...splitCheck.violations.map(item => ({ ...item, code: `split:${item.code}` })),
    ...coverage.result.violations.map(item => ({ ...item, code: `coverage:${item.code}` })),
    ...coverageHonesty.violations.map(item => ({ ...item, code: `coverage-honesty:${item.code}` })),
    ...aggregationCheck.violations.map(item => ({ ...item, code: `aggregation:${item.code}` })),
    ...driverViolations.map(item => ({ ...item, code: `driver:${item.code}` })),
  ];
  if (requireSelfProof && !allOraclesVerified) {
    failures.push(violation('selfproof_not_verified', '$', `H0c self-proof is not verified/fresh: ${selfProof.issues.join('; ')}`));
  }

  const sourceHashes: Record<string, string> = {};
  for (const file of catalogSourceFiles()) {
    try {
      sourceHashes[file] = sha256Hex(await readFile(join(pluginRoot, file)));
    } catch {
      failures.push(violation('catalog_source_missing', '$', `${file} is absent`));
    }
  }
  for (const extra of ['tests/harness-business.test.ts', 'tests/harness/fl-scenarios.ts']) {
    try {
      sourceHashes[extra] = sha256Hex(await readFile(join(pluginRoot, extra)));
    } catch {
      failures.push(violation('source_missing', '$', `${extra} is absent`));
    }
  }

  // Persist fixtures/answers (deterministic content).
  const fixtureFiles: { scenarioId: string; path: string; sha256: string; bytes: number }[] = [];
  const answerFiles: { scenarioId: string; path: string; sha256: string; bytes: number }[] = [];
  for (const scenario of fixture.scenarios) {
    const fixtureResult = await writeJson(join(fixtureRoot, `${scenario.scenarioId}.json`), scenario);
    fixtureFiles.push({ scenarioId: scenario.scenarioId, path: `fixtures/${scenario.scenarioId}.json`, ...fixtureResult });
  }
  for (const scenario of answers.scenarios) {
    const answerResult = await writeJson(join(answersRoot, `${scenario.scenarioId}.json`), scenario);
    answerFiles.push({ scenarioId: scenario.scenarioId, path: `answers/${scenario.scenarioId}.json`, ...answerResult });
  }
  const fixtureDigest = sha256Hex(canonicalJsonString(JSON.parse(JSON.stringify(fixture)) as never));
  const answerDigest = answerPackDigest(answers);
  const scoringPlanWrite = await writeJson(join(outDir, 'scoring-plan.json'), plan);
  const emptyReportWrite = await writeJson(join(outDir, 'scoring-empty-report.json'), emptyReport);

  const manifest: Record<string, unknown> = {
    schemaVersion: BUSINESS_MANIFEST_SCHEMA_VERSION,
    kind: BUSINESS_MANIFEST_KIND,
    generatedAt,
    seed,
    catalogVersion: fixture.catalogVersion,
    catalogDigest: fixture.catalogDigest,
    sourceHashes,
    fixtures: { count: fixtureFiles.length, digest: fixtureDigest, files: fixtureFiles },
    answers: {
      count: answerFiles.length,
      semanticDigest: answers.semanticDigest,
      packDigest: answerDigest,
      files: answerFiles,
      freeze: answers.freeze,
    },
    oracleSelfProofs,
    verification: {
      status: 'synthetic-fixture-only-not-run',
      canBeUsedForBusinessAcceptance: false,
      runEvidence: 0,
      selfProof: { path: selfProof.path, present: selfProof.present, sha256: selfProof.sha256, fresh: selfProof.fresh, issues: selfProof.issues, requiredTests: REQUIRED_BUSINESS_TEST_NAMES },
    },
    isolation: {
      fixtureRoot: 'fixtures',
      answersRoot: 'answers',
      result: isolationCheck.ok ? 'pass' : 'fail',
      fixtureContainsAnswers: false,
      canariesEvaluationSideOnly: true,
      sameMachineDirectoriesNotSecretIsolation: true,
    },
    split: {
      ...coverage.index.summary.splits,
      holdoutState: coverage.index.splitPolicy.state,
      rules: coverage.index.splitPolicy.rules,
      historicalSamplesUpgraded: false,
    },
    zeroRemote: H0C_REQUIRED_ZERO_REMOTE,
    coverage: {
      path: 'coverage.json',
      markdown: 'coverage.md',
      scenarios: coverage.index.summary.scenarios,
      materializedSteps: coverage.index.summary.materializedSteps,
      designSteps: coverage.index.summary.designSteps,
      uncoveredDesignSteps: coverage.index.summary.uncoveredDesignSteps,
      missingAssets: coverage.index.missingAssets.length,
    },
    scoring: {
      planPath: 'scoring-plan.json',
      emptyReportPath: 'scoring-empty-report.json',
      planSha256: scoringPlanWrite.sha256,
      emptyReportSha256: emptyReportWrite.sha256,
      hardGate: emptyReport.hardConstraints.gate,
      businessAcceptance: emptyReport.claims.businessAcceptance,
      totalScorePresent: false,
    },
    checks: {
      catalog: catalogCheck.ok ? 'pass' : 'fail',
      fixtureIsolation: isolationCheck.ok ? 'pass' : 'fail',
      splitPolicy: splitCheck.ok ? 'pass' : 'fail',
      coverage: coverage.result.ok ? 'pass' : 'fail',
      coverageHonesty: coverageHonesty.ok ? 'pass' : 'fail',
      aggregationHonesty: aggregationCheck.ok ? 'pass' : 'fail',
      driverBoundary: driverViolations.length === 0 ? 'pass' : 'fail',
      selfProofVerified: allOraclesVerified,
    },
    failures,
    cannotClaim: [
      '没有任何产品/宿主/模型/Lab/渠道运行；所有场景状态是 synthetic-fixture-only-not-run',
      '不是 HOLDOUT，也没有双人盲评或相处质量分数',
      '不能用于业务验收、V01–V27 或九系统整体通过的任何声明',
    ],
    commands: [
      'node scripts/harness/fl-scenarios.mjs --require-selfproof',
      'node scripts/harness/manifest.mjs',
      'node scripts/harness/selfproof.mjs',
      'node scripts/harness/traceability.mjs --strict',
    ],
  };

  await writeJson(join(outDir, 'manifest.json'), manifest);
  await writeJson(join(outDir, 'coverage.json'), coverage.index);
  await writeFile(join(outDir, 'coverage.md'), `${renderCoverageMarkdown(coverage.index)}\n`, 'utf8');

  const exitCode = failures.length === 0 || (requireSelfProof && failures.every(item => item.code === 'selfproof_not_verified')) ? (failures.length === 0 ? 0 : 2) : 2;
  const lines = [
    `h0c business skeleton ${failures.length === 0 ? 'PASSED' : 'FAILED'}`,
    `  outDir=${relative(workspaceRoot, outDir)}`,
    `  scenarios=${fixture.scenarios.length} materializedSteps=${coverage.index.summary.materializedSteps} designSteps=${coverage.index.summary.designSteps} uncovered=${coverage.index.summary.uncoveredDesignSteps}`,
    `  fixtures=${fixtureFiles.length} answers=${answerFiles.length} semanticDigest=${answers.semanticDigest.slice(0, 16)}…`,
    `  catalog=${catalogCheck.ok ? 'pass' : 'fail'} isolation=${isolationCheck.ok ? 'pass' : 'fail'} coverage=${coverage.result.ok ? 'pass' : 'fail'} honesty=${coverageHonesty.ok ? 'pass' : 'fail'} aggregation=${aggregationCheck.ok ? 'pass' : 'fail'} driver=${driverViolations.length === 0 ? 'pass' : 'fail'}`,
    `  selfproof verified=${allOraclesVerified} fresh=${selfProof.fresh} requiredTests=${REQUIRED_BUSINESS_TEST_NAMES.length}`,
    `  status=synthetic-fixture-only-not-run canUseForBusinessAcceptance=false hardGate=${emptyReport.hardConstraints.gate} claims=${emptyReport.claims.businessAcceptance}`,
    `  failures=${failures.length}`,
  ];
  if (failures.length > 0) for (const failure of failures.slice(0, 30)) lines.push(`    - ${failure.code}: ${failure.message}`);
  return { exitCode: failures.length === 0 ? 0 : 2, summary: lines.join('\n'), manifest };
}

function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(moduleUrl));
}

if (isMain(import.meta.url)) {
  const result = await runBusinessCli(process.argv.slice(2));
  process.stderr.write(`${result.summary}\n`);
  process.exitCode = result.exitCode;
}

export type { CoverageIndex, FixturePack, AnswerPack, CheckResult };
