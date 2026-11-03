/**
 * H7-round16 tests: round-15 v5 decision pre-step / reason preservation /
 * create-success + context-rejected evidence is bound as limited diagnostic
 * evidence; nothing here can be a pass.
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
const ROUND15_SOURCE_IDS = [
  'decision-prestep-reason-preservation-v5',
  'round15-host-v5-create-success-context-rejected',
  'h7-round15-clean-artifacts',
  'round15-review',
] as const;
const LEVEL: EvidenceLevel = 'fixed-host-create-succeeded-evaluation-failure';

function git(args: readonly string[], encoding: 'utf8' | 'buffer' = 'utf8'): { status: number; stdout: string | Buffer } {
  const result = spawnSync('git', ['-C', workspaceRoot, ...args], { encoding, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? (encoding === 'buffer' ? Buffer.alloc(0) : '') };
}

function committedJsonAt<T>(commit: string, relativePath: string): T {
  const result = git(['show', `${commit}:${relativePath}`]);
  assert.equal(result.status, 0, `git show ${commit}:${relativePath}`);
  return JSON.parse(result.stdout as string) as T;
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

test('round16:new-round15-sources-integrity-and-ancestry', async () => {
  assert.equal(EVIDENCE_SOURCES.length, 92);
  const ids = new Set(EVIDENCE_SOURCES.map(source => source.id));
  for (const id of ROUND15_SOURCE_IDS) assert.ok(ids.has(id), `missing round-15 source ${id}`);
  const newSources = EVIDENCE_SOURCES.filter(source => ROUND15_SOURCE_IDS.includes(source.id as (typeof ROUND15_SOURCE_IDS)[number]));
  assert.equal(newSources.length, 4);
  assert.equal(newSources.reduce((sum, source) => sum + source.files.length, 0), 28);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  for (const source of newSources) {
    assert.ok(source.scope.length > 0, `${source.id} scope`);
    assert.ok(source.limitations.length > 0, `${source.id} limitations`);
    assert.ok(source.levels.length > 0, `${source.id} levels`);
    for (const commit of source.commits) {
      assert.equal(git(['cat-file', '-e', `${commit}^{commit}`]).status, 0, `${source.id} commit ${commit}`);
      assert.equal(git(['merge-base', '--is-ancestor', commit, head]).status, 0, `${source.id} ${commit} ancestor`);
    }
  }
  const { report, result } = await verifyEvidenceSources(workspaceRoot, head);
  assert.equal(result.ok, true, JSON.stringify(result.violations.slice(0, 5)));
  assert.equal(report.counts.sources, 92);
  assert.equal(report.counts.verified, 92, `unknown: ${report.unknownSourceIds.join(',')}`);
  assert.equal(report.counts.files, 368);
  for (const source of newSources) {
    const verified = report.sources.find(item => item.id === source.id);
    assert.equal(verified?.status, 'verified');
    assert.ok(verified?.files.every(file => file.matchesFrozenHead));
  }
});

test('round16:decision-prestep-claim-and-v5-boundary', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'decision-prestep-reason-preservation-v5');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['offline-module', 'slice-verification']);
  assert.equal(source.levels.includes(LEVEL), false);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of [
    'step-0 pre-step now admits exactly 1-2 messages',
    'registered owner input',
    'exact host runtime-context snapshot',
    'third/wrong-order/changed message still fails closed',
    'CoreDomain.unknown()',
    'FIRST unknown reason',
    'preStopEvaluation',
    'CORE_VALIDATION_EXPERIMENT_V5',
    '[v1..v5]',
    '1671/1671',
    '1682/1682',
    'CORE_NATIVE_CONTEXT_REJECTED',
    'sixth attempt',
    'NEVER be pass',
  ]) {
    assert.ok(text.includes(required), `prestep text missing ${required}`);
  }
  const fix = committedJsonAt<{
    status: string;
    fixes: {
      preStepClaim: { change: string; notRelaxed: readonly string[]; tests: readonly string[] };
      reasonPreservation: { change: string; receipt: string; bounds: string; tests: readonly string[] };
    };
    experimentV5: { requestId: string; fixedTemplateSha256: string; acceptance: string };
    reconcile: { fixedTargets: readonly string[] };
    tests: { netNew: number };
    verification: { isolatedFullCheck: { tests: { tests: number; pass: number; fail: number }; exitCode: number } };
    failures: readonly unknown[];
  }>('91fdbf6', 'plugins/shiyu/artifacts/dsh/h3/h3-v5-decision-prestep-fix.json');
  assert.match(fix.status, /offline code preparation/);
  assert.match(fix.fixes.preStepClaim.change, /accepts 1-2 messages/);
  assert.ok(fix.fixes.preStepClaim.notRelaxed.some(line => line.includes('third message')));
  assert.ok(fix.fixes.preStepClaim.tests.some(line => line.includes('third pre-step message is rejected')));
  assert.match(fix.fixes.reasonPreservation.change, /returns the already-unknown evaluation unchanged/);
  assert.match(fix.fixes.reasonPreservation.receipt, /before the pause/i);
  assert.ok(fix.fixes.reasonPreservation.tests.some(line => line.includes('cannot overwrite the first reason')));
  assert.equal(fix.experimentV5.requestId, 'core-validation-frozen-v5');
  assert.match(fix.experimentV5.acceptance, /only the exact code-level constants/);
  assert.deepEqual(fix.reconcile.fixedTargets, ['core-validation-frozen-v1', 'core-validation-frozen-v2', 'core-validation-frozen-v3', 'core-validation-frozen-v4', 'core-validation-frozen-v5']);
  assert.equal(fix.tests.netNew, 8);
  assert.equal(fix.verification.isolatedFullCheck.tests.tests, 1671);
  assert.equal(fix.verification.isolatedFullCheck.tests.pass, 1671);
  assert.equal(fix.verification.isolatedFullCheck.tests.fail, 0);
  assert.equal(fix.verification.isolatedFullCheck.exitCode, 0);
  assert.deepEqual(fix.failures, []);
  const integration = committedJsonAt<{ verification: { leadIntegratedIsolatedCheck: { tests: number; exitCode: number } } }>(
    '94251aa',
    'plugins/shiyu/artifacts/dsh/integration/round15-lead-integration.json',
  );
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.tests, 1682);
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.exitCode, 0);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('decision-prestep-reason-preservation-v5'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'decision-prestep-reason-preservation-v5'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
});

test('round16:reason-preservation-semantics-offline', async () => {
  const receipt = committedJsonAt<{
    status: string;
    reasonCode: string;
    preStopEvaluation?: { reasonCode?: string };
    evaluations: readonly { status: string; reasonCode: string }[];
    counters: { evaluateAttempts: number };
    stopAction: { kind: string };
  }>('3d31da3', 'plugins/shiyu/artifacts/dsh/host/round15/core-goal-v5-receipt.json');
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.reasonCode, 'CORE_VALIDATION_EVALUATION_UNKNOWN');
  assert.equal(receipt.counters.evaluateAttempts, 1);
  assert.equal(receipt.stopAction.kind, 'pause');
  assert.equal(receipt.evaluations.length, 1);
  assert.equal(receipt.evaluations[0].status, 'unknown');
  assert.equal(receipt.evaluations[0].reasonCode, 'CORE_NATIVE_CONTEXT_REJECTED');
  assert.equal(receipt.preStopEvaluation?.reasonCode, 'CORE_NATIVE_CONTEXT_REJECTED');
  for (const level of EVIDENCE_SOURCES.find(source => source.id === 'round15-host-v5-create-success-context-rejected')?.levels ?? []) {
    assert.equal(ALLOWED_EVIDENCE_LEVELS.includes(level), true);
    assert.equal(LIMITED_EVIDENCE_LEVELS.includes(level), true);
  }
});

test('round16:v5-context-rejected-never-pass', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round15-host-v5-create-success-context-rejected');
  assert.ok(source !== undefined);
  const sourceLevels: readonly EvidenceLevel[] = [...source.levels];
  assert.deepEqual(sourceLevels, [LEVEL]);
  assert.equal(source.levels.includes('bounded-real-model' as EvidenceLevel), false);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of [
    'FAILED fifth attempt',
    'second create success',
    'CORE_VALIDATION_EVALUATION_UNKNOWN',
    'preStopEvaluation.reasonCode=CORE_NATIVE_CONTEXT_REJECTED',
    'no longer owner_paused',
    'evaluateAttempts=1',
    '0 model requests',
    '+14 commitSeq',
    'goals 6→7',
    'sessions 38→39',
    'budget unknown 4→5',
    'held 16384 tokens/calls 2',
    'no events/Task/Effect/artifact',
    'v4 and v5 Goals',
    'sixth attempt is NOT authorized',
    'NEVER be pass',
  ]) {
    assert.ok(text.includes(required), `v5 host limitations missing ${required}`);
  }
  const joint = committedJsonAt<{
    status: string;
    result: {
      status: string;
      reasonCode: string;
      counters: { evaluateAttempts: number };
      goal: { authorized: boolean; paused: boolean; nativePhase: string; mandateId: string };
      evaluations: readonly { status: string; reasonCode: string }[];
      preStopEvaluation: { status: string; reasonCode: string };
      stopAction: { kind: string; attempted: boolean; ok: boolean };
      businessSideEffects: {
        goal: { created: string; observed: { authorized: boolean; nativePhase: string; goalRef: { revision: number }; goalSessionId: string } };
        partialCreation: { detected: boolean };
        tasks: { count: number };
        effects: { count: number };
        artifacts: { count: number };
        sessions: { workerSessionIds: readonly string[] };
        budget: { held: { tokens: number; calls: number; effects: number } };
      };
    };
    cachedReceipt: { bytes: number; sha256: string };
    deltas: {
      attempt: {
        commitSeq: readonly [number, number];
        goals: readonly [number, number];
        sessions: readonly [number, number];
        events: readonly [number, number];
        budget: readonly [{ settled: number; unknown: number }, { settled: number; unknown: number }];
      };
    };
    businessFacts: { goals: number; stateFileUnchanged: boolean };
  }>('b59c8af', 'plugins/shiyu/artifacts/dsh/host/round15-bounded-core-goal-v5.json');
  assert.equal(joint.status, 'fixed-host-v5-create-succeeded-evaluation-context-rejected');
  assert.equal(joint.result.status, 'failed');
  assert.equal(joint.result.reasonCode, 'CORE_VALIDATION_EVALUATION_UNKNOWN');
  assert.equal(joint.result.counters.evaluateAttempts, 1);
  assert.equal(joint.result.goal.authorized, true);
  assert.equal(joint.result.goal.paused, true);
  assert.equal(joint.result.goal.nativePhase, 'paused');
  assert.match(joint.result.goal.mandateId, /^core-mandate:/);
  assert.equal(joint.result.evaluations.length, 1);
  assert.equal(joint.result.evaluations[0].status, 'unknown');
  assert.equal(joint.result.evaluations[0].reasonCode, 'CORE_NATIVE_CONTEXT_REJECTED');
  assert.deepEqual(joint.result.preStopEvaluation, {
    evaluationId: 'evaluation:core-f5d638166d03988e3251d67ba875cf8c16fcef36:1',
    status: 'unknown',
    reasonCode: 'CORE_NATIVE_CONTEXT_REJECTED',
  });
  assert.equal(joint.result.stopAction.kind, 'pause');
  assert.equal(joint.result.stopAction.attempted, true);
  assert.equal(joint.result.stopAction.ok, true);
  const goal = joint.result.businessSideEffects.goal;
  assert.equal(goal.created, 'true');
  assert.equal(goal.observed.authorized, true);
  assert.equal(goal.observed.nativePhase, 'active');
  assert.equal(goal.observed.goalRef.revision, 1);
  assert.match(goal.observed.goalSessionId, /^shiyu-core-goal-/);
  assert.equal(joint.result.businessSideEffects.partialCreation.detected, false);
  assert.equal(joint.result.businessSideEffects.tasks.count, 0);
  assert.equal(joint.result.businessSideEffects.effects.count, 0);
  assert.equal(joint.result.businessSideEffects.artifacts.count, 0);
  assert.deepEqual(joint.result.businessSideEffects.sessions.workerSessionIds, []);
  assert.deepEqual(joint.result.businessSideEffects.budget.held, { tokens: 16384, calls: 2, effects: 0 });
  assert.deepEqual(joint.deltas.attempt.commitSeq, [476, 490]);
  assert.deepEqual(joint.deltas.attempt.goals, [6, 7]);
  assert.deepEqual(joint.deltas.attempt.sessions, [38, 39]);
  assert.deepEqual(joint.deltas.attempt.events, [61, 61]);
  assert.deepEqual(joint.deltas.attempt.budget, [{ settled: 21, unknown: 4 }, { settled: 21, unknown: 5 }]);
  assert.equal(joint.businessFacts.goals, 7);
  assert.equal(joint.businessFacts.stateFileUnchanged, true);
  assert.equal(joint.cachedReceipt.bytes, 67986);
  const sessionEvents = committedJsonAt<readonly { seq: number | null; type: string }[]>(
    '3d31da3',
    'plugins/shiyu/artifacts/dsh/host/round15/v5-goal-session-events.json',
  );
  assert.equal(sessionEvents.length, 13);
  assert.ok(sessionEvents.every(event => event.type !== 'request' && event.type !== 'assistant/message'));
  assert.ok(sessionEvents.some(event => event.type === 'turn/end'));
  assert.ok(sessionEvents.some(event => event.type === 'goal/change'));
  const statusFinal = git(['show', '3d31da3:plugins/shiyu/artifacts/dsh/host/round15/status-final.json'], 'buffer').stdout as Buffer;
  assert.equal(statusFinal.byteLength, 67986);
  assert.equal(sha256Hex(statusFinal), joint.cachedReceipt.sha256);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('round15-host-v5-create-success-context-rejected'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'round15-host-v5-create-success-context-rejected'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round16:reused-level-boundary', async () => {
  assert.equal(ALLOWED_EVIDENCE_LEVELS.includes(LEVEL), true);
  assert.equal(LIMITED_EVIDENCE_LEVELS.includes(LEVEL), true);
  assert.equal((ALLOWED_EVIDENCE_LEVELS as readonly string[]).includes('pass'), false);
  const v4 = EVIDENCE_SOURCES.find(item => item.id === 'round14-host-v4-create-success-eval-failure');
  const v5 = EVIDENCE_SOURCES.find(item => item.id === 'round15-host-v5-create-success-context-rejected');
  assert.ok(v4 !== undefined && v5 !== undefined);
  const v4Levels: readonly EvidenceLevel[] = [...v4.levels];
  const v5Levels: readonly EvidenceLevel[] = [...v5.levels];
  assert.deepEqual(v4Levels, [LEVEL]);
  assert.deepEqual(v5Levels, [LEVEL]);
  for (const source of [v4, v5]) {
    assert.ok(source.limitations.some(line => line.includes('NEVER be pass')));
    assert.ok(source.limitations.some(line => line.includes('0 model requests')));
  }
});

test('round16:blobcommit-round15-clean-artifacts-stable', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h7-round15-clean-artifacts');
  assert.ok(source !== undefined);
  for (const file of source.files) {
    assert.equal(file.blobCommit, 'b1c9061');
    assert.equal(typeof file.expectedSha256, 'string');
    const outcome = await verifyEvidenceFileFacts(workspaceRoot, head, file);
    assert.deepEqual(outcome.issues, []);
    assert.equal(outcome.facts.sha256, file.expectedSha256);
  }
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-round16-blob-'));
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

test('round16:review-info-only-unmapped', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round15-review');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['independent-review-info']);
  const text = source.limitations.join(' ').toLowerCase();
  for (const needle of ['info', 'not product', 'not referenced']) assert.ok(text.includes(needle), `review limitations missing ${needle}`);
  for (const mapping of PRODUCT_EVIDENCE_MAPPINGS) assert.equal(mapping.sourceIds.includes('round15-review'), false);
  for (const module of MODULE_DEFINITIONS) assert.equal(module.evidenceSourceIds.includes('round15-review'), false);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows);
  for (const system of systems) assert.equal(system.sourceIds.includes('round15-review'), false);
});

test('round16:product-tooling-vsfl-no-upgrade', async () => {
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

test('round16:acceptance-index-cites-round15-limited', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = new Map(buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows).map(system => [system.systemId, system]));
  for (const [systemId, expected] of [
    ['SYS.3', ['decision-prestep-reason-preservation-v5', 'round15-host-v5-create-success-context-rejected']],
    ['SYS.8', ['decision-prestep-reason-preservation-v5', 'round15-host-v5-create-success-context-rejected']],
    ['SYS.9', ['round15-host-v5-create-success-context-rejected']],
  ] as const) {
    const system = systems.get(systemId);
    assert.ok(system !== undefined);
    for (const id of expected) assert.ok(system.sourceIds.includes(id), `${systemId} missing ${id}`);
    assert.equal(system.row?.state, 'limited-only');
  }
  const moduleById = (id: string) => MODULE_DEFINITIONS.find(module => module.id === id);
  for (const id of ['MOD.core', 'MOD.tool-policy', 'MOD.lifecycle']) {
    const module = moduleById(id);
    assert.ok(module !== undefined);
    for (const sourceId of ['decision-prestep-reason-preservation-v5', 'round15-host-v5-create-success-context-rejected']) {
      assert.ok(module.evidenceSourceIds.includes(sourceId), `${id} missing ${sourceId}`);
    }
  }
  for (const id of ['MOD.recovery-entry', 'MOD.state', 'MOD.persistence']) {
    assert.ok(moduleById(id)?.evidenceSourceIds.includes('round15-host-v5-create-success-context-rejected'), `${id} missing v5 host evidence`);
  }
  for (const module of MODULE_DEFINITIONS) {
    assert.ok(module.evidenceSourceIds.every(id => EVIDENCE_SOURCES.some(source => source.id === id)), `${module.id} cites unknown source`);
    assert.ok(module.systems.length > 0);
  }
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.modules.length, 40);
  assert.equal(acceptance.systems.length, 9);
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round16:slice-evidence-present', async () => {
  const text = await readFile(join(pluginRoot, 'artifacts/dsh/harness/h7-round16-slice.json'), 'utf8').catch(() => null);
  assert.ok(text !== null, 'h7-round16-slice.json must exist');
  const evidence = JSON.parse(text) as {
    kind: string;
    baselineHead: string;
    round15Sources: readonly (string | { readonly id: string })[];
    sourceCounts: { sources: number; files: number };
    files: readonly { path: string; sha256: string; bytes: number }[];
    checks: {
      sharedTree: { blockedByConcurrentWip?: boolean; note?: string; harness?: { tests: number; pass: number; fail: number } };
      isolatedWorktree: { harness: { tests: number; pass: number; fail: number }; fullCheck: { exitCode: number; tests: number; pass: number; fail: number } };
    };
    productRows: { total: number; notCovered: number; covered: number };
    toolingReady: readonly string[];
    acceptanceGate: string;
  };
  assert.equal(evidence.kind, 'shiyu.harness.h7-round16-slice-evidence');
  assert.match(evidence.baselineHead, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    evidence.round15Sources.map(item => (typeof item === 'string' ? item : item.id)).sort(),
    [...ROUND15_SOURCE_IDS].sort(),
  );
  assert.deepEqual(evidence.sourceCounts, { sources: 88, files: 339 });
  // Historical slice snapshot: hash the blobs as committed in the round-16
  // slice commit (e33b93e). Later rounds legitimately edit these harness files,
  // so a mutable-worktree comparison would turn a historical record into a
  // stale drift check; the committed snapshot is the evidence.
  for (const file of evidence.files) {
    const blob = git(['show', `e33b93e:${file.path}`], 'buffer').stdout as Buffer;
    assert.ok(blob.byteLength > 0, `${file.path} committed blob missing`);
    assert.equal(sha256Hex(blob), file.sha256, `${file.path} slice sha`);
    assert.equal(blob.byteLength, file.bytes);
  }
  if (evidence.checks.sharedTree.blockedByConcurrentWip === true) {
    assert.ok(
      typeof evidence.checks.sharedTree.note === 'string' && evidence.checks.sharedTree.note.length > 0,
      'a blocked-by-concurrent-WIP shared tree run must carry an explanatory note and no green claim',
    );
  } else if (evidence.checks.sharedTree.harness !== undefined) {
    assert.equal(evidence.checks.sharedTree.harness.fail, 0);
  } else {
    assert.fail('sharedTree must be either blocked-by-concurrent-WIP or a green run');
  }
  assert.equal(evidence.checks.isolatedWorktree.harness.fail, 0);
  assert.equal(evidence.checks.isolatedWorktree.fullCheck.exitCode, 0);
  assert.equal(evidence.checks.isolatedWorktree.fullCheck.fail, 0);
  assert.ok(evidence.checks.isolatedWorktree.harness.tests > 0);
  assert.ok(evidence.checks.isolatedWorktree.fullCheck.tests > 0);
  assert.deepEqual(evidence.productRows, { total: 79, notCovered: 79, covered: 0 });
  assert.deepEqual([...evidence.toolingReady].sort(), ['TV.1', 'TV.2', 'TV.3', 'TV.4', 'TV.5', 'TV.6', 'TV.7', 'TV.9']);
  assert.equal(evidence.acceptanceGate, 'incomplete');
});
