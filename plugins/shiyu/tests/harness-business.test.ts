/**
 * H0c S/FL business-skeleton self-proof suite.
 *
 * Executes every BUSINESS_SELF_PROOFS oracle (known-accept + known-reject),
 * then proves the generator is deterministic/rebuildable, answers are
 * seed-independent and frozen before any run, the public fixture/driver input
 * never exposes answers or future steps, the coverage index is honest, the
 * aggregator cannot be manipulated by negative reports, and the CLI writes
 * reviewable artifacts without touching any real resource.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_SCENARIOS,
  BUSINESS_SELF_PROOFS,
  BUSINESS_TEST_IDS,
  aggregateCaseResults,
  answerPackDigest,
  buildCoverageIndex,
  buildDriverInput,
  businessOracleTestName,
  checkAggregationHonesty,
  checkCoverageHonesty,
  checkDriverInputBoundary,
  checkFixtureIsolation,
  checkSplitPolicy,
  defaultSplitPolicy,
  generateAnswerPack,
  generateFixturePack,
  renderCoverageMarkdown,
  semanticAnswersDigest,
  catalogDigest,
  type AggregationPlan,
  type CaseRunResult,
  type FixturePack,
} from './harness/business/index.js';
import { canonicalJsonString } from './harness/json.js';
import { sha256Hex } from './harness/invariant.js';
import { runSelfProof, selfProofFailureMessage } from './harness/index.js';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = join(pluginRoot, '..', '..');
const FIXED_TIME = '2026-11-02T00:00:00.000Z';
const BUSINESS_ORACLE_COUNT = 7;

async function withTempDirectory<T>(prefix: string, body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function walk(directory: string, prefix: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;
    if (entry.isDirectory()) files.push(...(await walk(join(directory, entry.name), `${prefix}/${entry.name}`)));
    else files.push(`${prefix}/${entry.name}`);
  }
  return files;
}

for (const proof of BUSINESS_SELF_PROOFS) {
  test(businessOracleTestName(proof.name), async t => {
    const run = await runSelfProof(proof);
    t.diagnostic(
      `business-oracle=${run.oracle} version=${run.version} samples=${run.sampleCount} scenarios=${run.scenarioCount} ` +
        `known-accept-pass=${run.outcomes.filter(item => item.expect === 'accept' && item.ok).length} ` +
        `known-reject-caught=${run.outcomes.filter(item => item.expect === 'reject' && item.ok).length} failures=${run.failures.length}`,
    );
    assert.deepEqual(run.failures, [], selfProofFailureMessage(run));
    assert.ok(run.outcomes.some(item => item.expect === 'accept' && item.ok));
    assert.ok(run.outcomes.some(item => item.expect === 'reject' && item.ok));
  });
}

test('business:fixture-determinism', () => {
  const first = generateFixturePack({ seed: 7, generatedAt: FIXED_TIME });
  const second = generateFixturePack({ seed: 7, generatedAt: FIXED_TIME });
  assert.equal(canonicalJsonString(first as never), canonicalJsonString(second as never), 'same catalogue+seed must rebuild identically');
  const other = generateFixturePack({ seed: 8, generatedAt: FIXED_TIME });
  assert.notEqual(canonicalJsonString(first as never), canonicalJsonString(other as never), 'different seed changes synthetic ids/salt');
  assert.equal(first.catalogDigest, other.catalogDigest, 'catalogue identity must not depend on the seed');
  assert.equal(semanticAnswersDigest(), generateAnswerPack({ seed: 7, generatedAt: FIXED_TIME }).semanticDigest);
  assert.equal(first.scenarios.length, 16);
  assert.deepEqual(
    first.scenarios.map(scenario => scenario.scenarioId),
    ALL_SCENARIOS.map(scenario => scenario.scenarioId),
  );
  assert.equal(catalogDigest(), first.catalogDigest);
  // Rebuild after tampering the in-memory catalogue is not possible: generation
  // always re-derives from the frozen catalogue, so digests stay verifiable.
});

test('business:answers-independent-of-seed', () => {
  const answersA = generateAnswerPack({ seed: 7, generatedAt: FIXED_TIME, frozenAt: FIXED_TIME });
  const answersB = generateAnswerPack({ seed: 99, generatedAt: FIXED_TIME, frozenAt: FIXED_TIME });
  assert.equal(answersA.semanticDigest, answersB.semanticDigest);
  assert.deepEqual(answersA.scenarios, answersB.scenarios, 'answer sets are semantic and seed-independent');
  assert.equal(answerPackDigest(answersA), answerPackDigest(answersB), 'answer pack digest is seed-independent');
  assert.equal(answersA.freeze.derivedFromProductOutput, false);
  assert.equal(answersA.freeze.historicalSamplesReused, false);
  assert.ok(answersA.freeze.sourceRefs.length >= 3);
});

test('business:isolation-and-driver-boundary', () => {
  const fixture = generateFixturePack({ seed: 7, generatedAt: FIXED_TIME });
  const answers = generateAnswerPack({ seed: 7, generatedAt: FIXED_TIME, frozenAt: FIXED_TIME });
  const isolation = checkFixtureIsolation(fixture, answers);
  assert.equal(isolation.ok, true, JSON.stringify(isolation.violations));
  for (const scenario of fixture.scenarios) {
    const first = scenario.steps[0];
    const input = buildDriverInput(fixture, scenario.scenarioId, first.stepId);
    const boundary = checkDriverInputBoundary(fixture, answers, input);
    assert.equal(boundary.ok, true, JSON.stringify({ scenario: scenario.scenarioId, violations: boundary.violations }));
    assert.equal(input.visibleSteps.some(step => step.stepId === first.stepId), true);
  }
  // Tampered public fixture: answer token leaks in.
  const tamperedFixture = JSON.parse(JSON.stringify(fixture)) as FixturePack;
  (tamperedFixture.scenarios[0].steps[0].event as { text: string }).text = 'export must_process_as_business';
  const tamperedIsolation = checkFixtureIsolation(tamperedFixture, answers);
  assert.equal(tamperedIsolation.ok, false);
  assert.ok(tamperedIsolation.violations.some(item => item.code === 'vocabulary_token_in_fixture'));
  // Tampered driver input: future step exposed.
  const scenario = fixture.scenarios[0];
  const input = buildDriverInput(fixture, scenario.scenarioId, scenario.steps[0].stepId);
  const future = scenario.steps[1];
  const futureBoundary = checkDriverInputBoundary(fixture, answers, { ...input, visibleSteps: [...input.visibleSteps, future] });
  assert.equal(futureBoundary.ok, false);
  assert.ok(futureBoundary.violations.some(item => item.code === 'future_step_in_driver_input'));
  // Directory separation checks.
  const sameRoot = checkFixtureIsolation(fixture, answers, { fixtureDirectory: '/tmp/a', answersDirectory: '/tmp/a' });
  assert.equal(sameRoot.ok, false);
  assert.ok(sameRoot.violations.some(item => item.code === 'same_directory'));
  const inside = checkFixtureIsolation(fixture, answers, { fixtureDirectory: '/tmp/a', answersDirectory: '/tmp/a/answers' });
  assert.equal(inside.ok, false);
});

test('business:no-product-or-lab-imports', async () => {
  const businessFiles = [
    ...(await walk(join(pluginRoot, 'tests/harness/business'), 'tests/harness/business')),
    'tests/harness/fl-scenarios.ts',
  ];
  const allowedNodeSpecifiers = new Set([
    'node:crypto',
    'node:fs/promises',
    'node:path',
    'node:url',
    'node:os',
    'node:child_process',
    'node:readline',
    'node:assert/strict',
    'node:test',
  ]);
  const forbiddenMarkers = ['/src/', 'lab/', 'node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls', 'playwright', '@modelcontextprotocol'];
  for (const file of businessFiles) {
    const text = await readFile(join(pluginRoot, file), 'utf8');
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) continue;
      assert.ok(allowedNodeSpecifiers.has(specifier), `${file} imports unexpected module ${specifier}`);
    }
    for (const marker of forbiddenMarkers) {
      assert.equal(text.includes(marker), false, `${file} must not reference ${marker}`);
    }
    assert.equal(/\bfetch\s*\(/.test(text), false, `${file} must not perform network calls`);
  }
});

test('business:coverage-index', async () => {
  const { index, result } = await buildCoverageIndex({
    workspaceRoot,
    seed: 20261101,
    generatedAt: FIXED_TIME,
    catalogVersion: '1.0.0',
  });
  assert.equal(result.ok, true, JSON.stringify(result.violations.slice(0, 10)));
  assert.equal(checkCoverageHonesty(index).ok, true);
  assert.equal(index.summary.scenarios, 16);
  assert.equal(index.summary.designSteps, 80);
  assert.equal(index.summary.materializedSteps, ALL_SCENARIOS.reduce((sum, scenario) => sum + scenario.steps.length, 0));
  assert.equal(index.summary.splits.DEV, 16);
  assert.equal(index.summary.splits.REG, 0);
  assert.equal(index.summary.splits.HOLDOUT, 0);
  assert.equal(index.summary.runEvidence, 0);
  assert.equal(index.summary.holdoutMaterialized, 0);
  assert.equal(index.cannotUseForBusinessAcceptance, true);
  assert.ok(index.missingAssets.length >= 8);
  const caseDocs = index.sources.filter(source => source.kind === 'case-doc');
  assert.equal(caseDocs.length, 12);
  for (const source of caseDocs) {
    assert.equal(source.observedStepCount, source.expectedStepCount, `${source.scenarioId} source step count must match the document`);
    assert.deepEqual(source.issues, []);
  }
  const matrixOnly = index.sources.filter(source => source.kind === 'matrix-only');
  assert.deepEqual(
    matrixOnly.map(source => source.scenarioId).sort(),
    ['FL02', 'FL06', 'FL07', 'FL08'],
  );
  for (const source of matrixOnly) assert.equal(source.matrixMentionsScenario, true);
  for (const row of index.rows) {
    assert.equal(row.verificationStatus, 'synthetic-fixture-only-not-run');
    assert.equal(row.runEvidence, 0);
    assert.equal(row.holdout, 'not_materialised');
    assert.equal(row.cannotUseForBusinessAcceptance, true);
    if (row.designSteps > row.materializedSteps) assert.ok(row.uncoveredDesignStepIds.length > 0);
  }
  const markdown = renderCoverageMarkdown(index);
  assert.ok(markdown.includes('还不能用于业务验收'));
  assert.ok(markdown.includes('synthetic-fixture-only-not-run'));
  assert.ok(markdown.includes('HOLDOUT'));
  // Negative: an index claiming run evidence is rejected.
  const tampered = JSON.parse(JSON.stringify(index)) as typeof index;
  (tampered.summary as unknown as { runEvidence: number }).runEvidence = 1;
  const tamperedCheck = checkCoverageHonesty(tampered);
  assert.equal(tamperedCheck.ok, false);
  assert.ok(tamperedCheck.violations.some(item => item.code === 'coverage_claims_run_evidence'));
});

test('business:aggregation-honesty', () => {
  const plan: AggregationPlan = {
    planId: 'test-plan',
    freezeRef: 'catalog:test',
    cases: ALL_SCENARIOS.map(scenario => ({
      caseId: `${scenario.scenarioId}-case`,
      scenarioId: scenario.scenarioId,
      requiredMilestones: scenario.milestones.map(milestone => milestone.id),
    })),
  };
  const emptyReport = aggregateCaseResults(plan, []);
  assert.equal(emptyReport.hardConstraints.gate, 'undecidable');
  assert.equal(emptyReport.claims.businessAcceptance, 'not_claimed');
  assert.equal(emptyReport.separation.totalScorePresent, false);
  assert.equal((emptyReport as { totalScore?: number }).totalScore, undefined);
  assert.equal(emptyReport.functional.overall.ratio, 0);
  assert.equal(emptyReport.denominators.planned, 16);
  assert.equal(emptyReport.denominators.executed, 0);
  assert.ok(emptyReport.cannotClaim.some(item => item.includes('不能用于业务验收')));
  assert.equal(checkAggregationHonesty(emptyReport, plan, []).ok, true);
  // One honest executed case with a hard violation is reported as failed.
  const partialResults: CaseRunResult[] = [
    {
      caseId: 'S01-case',
      scenarioId: 'S01',
      split: 'DEV',
      sourceKind: 'synthetic-fixture',
      executionStatus: 'executed',
      hardViolations: ['H2'],
      functional: [],
      evidenceRefs: ['fixture:test'],
    },
  ];
  const partial = aggregateCaseResults(plan, partialResults);
  assert.equal(partial.hardConstraints.gate, 'fail');
  assert.equal(partial.denominators.failed, 1);
  assert.equal(partial.claims.businessAcceptance, 'not_claimed');
  assert.equal(checkAggregationHonesty(partial, plan, partialResults).ok, true);
  // Quality-only "pass" claim is rejected.
  const tampered = JSON.parse(JSON.stringify(partial)) as typeof partial;
  (tampered.claims as unknown as { businessAcceptance: string }).businessAcceptance = 'claimed';
  const tamperedCheck = checkAggregationHonesty(tampered, plan, partialResults);
  assert.equal(tamperedCheck.ok, false);
  assert.ok(tamperedCheck.violations.some(item => item.code === 'business_acceptance_claimed_without_evidence'));
  // Splits stay honest.
  assert.equal(checkSplitPolicy(defaultSplitPolicy()).ok, true);
});

test('business:cli-artifacts', async () => {
  await withTempDirectory('shiyu-h0c-cli-', async directory => {
    const outA = join(directory, 'out-a');
    const outB = join(directory, 'out-b');
    const launcher = join(pluginRoot, 'scripts/harness/fl-scenarios.mjs');
    const run = (outDir: string, extra: readonly string[] = []) =>
      spawnSync(process.execPath, [launcher, '--out-dir', outDir, '--seed', '7', '--workspace-root', workspaceRoot, ...extra], {
        cwd: pluginRoot,
        encoding: 'utf8',
        timeout: 120_000,
      });
    const first = run(outA);
    assert.equal(first.status, 0, `fl-scenarios CLI failed: ${first.stdout}\n${first.stderr}`);
    const second = run(outB);
    assert.equal(second.status, 0, `fl-scenarios CLI failed on rebuild: ${second.stdout}\n${second.stderr}`);
    const fixtureFiles = (await readdir(join(outA, 'fixtures'))).sort();
    assert.equal(fixtureFiles.length, 16);
    const answerFiles = (await readdir(join(outA, 'answers'))).sort();
    assert.equal(answerFiles.length, 16);
    // Rebuild produces byte-identical fixture/answer payloads.
    for (const file of [...fixtureFiles, ...answerFiles]) {
      const directoryName = fixtureFiles.includes(file) ? 'fixtures' : 'answers';
      const a = await readFile(join(outA, directoryName, file));
      const b = await readFile(join(outB, directoryName, file));
      assert.equal(sha256Hex(a), sha256Hex(b), `${directoryName}/${file} must rebuild identically`);
    }
    const manifest = JSON.parse(await readFile(join(outA, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const verification = manifest.verification as Record<string, unknown>;
    assert.equal(verification.canBeUsedForBusinessAcceptance, false);
    assert.equal(verification.status, 'synthetic-fixture-only-not-run');
    assert.equal(verification.runEvidence, 0);
    assert.deepEqual(manifest.zeroRemote, { modelCalls: 0, embeddingCalls: 0, labRooms: 0, hostCalls: 0, channelSends: 0 });
    const manifestFixtures = manifest.fixtures as { count: number; files: { path: string; sha256: string }[] };
    assert.equal(manifestFixtures.count, 16);
    for (const entry of manifestFixtures.files) {
      const actual = sha256Hex(await readFile(join(outA, entry.path)));
      assert.equal(actual, entry.sha256, `${entry.path} hash must match the manifest`);
    }
    const manifestAnswers = manifest.answers as { count: number; semanticDigest: string; files: { path: string; sha256: string }[] };
    assert.equal(manifestAnswers.count, 16);
    const expectedSemantic = generateAnswerPack({ seed: 7, generatedAt: FIXED_TIME, frozenAt: FIXED_TIME }).semanticDigest;
    assert.equal(manifestAnswers.semanticDigest, expectedSemantic);
    for (const entry of manifestAnswers.files) {
      const actual = sha256Hex(await readFile(join(outA, entry.path)));
      assert.equal(actual, entry.sha256, `${entry.path} hash must match the manifest`);
    }
    const coverageJson = JSON.parse(await readFile(join(outA, 'coverage.json'), 'utf8')) as { summary: { scenarios: number; runEvidence: number } };
    assert.equal(coverageJson.summary.scenarios, 16);
    assert.equal(coverageJson.summary.runEvidence, 0);
    assert.ok((await readFile(join(outA, 'coverage.md'), 'utf8')).includes('还不能用于业务验收'));
    const emptyReport = JSON.parse(await readFile(join(outA, 'scoring-empty-report.json'), 'utf8')) as { claims: { businessAcceptance: string }; hardConstraints: { gate: string } };
    assert.equal(emptyReport.claims.businessAcceptance, 'not_claimed');
    assert.equal(emptyReport.hardConstraints.gate, 'undecidable');
    // --require-selfproof with a fresh fabricated artifact must pass.
    const passingTests = [...BUSINESS_SELF_PROOFS.map(proof => businessOracleTestName(proof.name)), ...BUSINESS_TEST_IDS.filter(id => !id.startsWith('business-oracle:'))];
    const sourceHashes: Record<string, string> = {};
    for (const file of await walk(join(pluginRoot, 'tests/harness/business'), 'tests/harness/business')) {
      sourceHashes[file] = sha256Hex(await readFile(join(pluginRoot, file)));
    }
    const testFile = 'tests/harness-business.test.ts';
    sourceHashes[testFile] = sha256Hex(await readFile(join(pluginRoot, testFile)));
    const fakeSelfProof = join(directory, 'tool-selfproof.json');
    await writeFile(
      fakeSelfProof,
      JSON.stringify({
        schemaVersion: 1,
        kind: 'shiyu.harness.selfproof',
        passed: true,
        files: [{ path: testFile, ok: true, exitCode: 0, tests: passingTests.map(name => ({ name, ok: true })) }],
        sourceHashes,
      }),
    );
    const outC = join(directory, 'out-c');
    const withSelfProof = run(outC, ['--require-selfproof', '--selfproof', fakeSelfProof]);
    assert.equal(withSelfProof.status, 0, `--require-selfproof with fresh artifact failed: ${withSelfProof.stdout}\n${withSelfProof.stderr}`);
    const outD = join(directory, 'out-d');
    const withoutSelfProof = run(outD, ['--require-selfproof', '--selfproof', join(directory, 'absent.json')]);
    assert.equal(withoutSelfProof.status, 2, '--require-selfproof without a fresh artifact must fail closed');
  });
});

test('business:docs-contract', async () => {
  const harnessReadme = await readFile(join(pluginRoot, 'tests/harness/README.md'), 'utf8');
  const scriptsReadme = await readFile(join(pluginRoot, 'scripts/harness/README.md'), 'utf8');
  for (const required of [
    'H0c',
    'fl-scenarios',
    'node scripts/harness/fl-scenarios.mjs',
    'synthetic-fixture-only-not-run',
    '还不能用于业务验收',
    'DEV',
    'REG',
    'HOLDOUT',
    '答案集',
  ]) {
    assert.ok(harnessReadme.includes(required) || scriptsReadme.includes(required), `H0c docs must mention ${required}`);
  }
});
