/**
 * H7-round15 tests: round-14 delegationDepth normalization / v4 create-success
 * evaluation-failure / correction / review evidence is bound as limited
 * diagnostic evidence; nothing here can be a pass.
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
const ROUND14_SOURCE_IDS = [
  'delegation-depth-normalization-v4',
  'h7-round14-clean-artifacts',
  'round14-host-v4-create-success-eval-failure',
  'round14-review',
  'h7-round14-slice-correction',
] as const;
const NEW_LEVEL: EvidenceLevel = 'fixed-host-create-succeeded-evaluation-failure';

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

test('round15:new-round14-sources-integrity-and-ancestry', async () => {
  assert.equal(EVIDENCE_SOURCES.length, 100);
  const ids = new Set(EVIDENCE_SOURCES.map(source => source.id));
  for (const id of ROUND14_SOURCE_IDS) assert.ok(ids.has(id), `missing round-14 source ${id}`);
  const newSources = EVIDENCE_SOURCES.filter(source => ROUND14_SOURCE_IDS.includes(source.id as (typeof ROUND14_SOURCE_IDS)[number]));
  assert.equal(newSources.length, 5);
  assert.equal(newSources.reduce((sum, source) => sum + source.files.length, 0), 29);
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
  assert.equal(report.counts.sources, 100);
  assert.equal(report.counts.verified, 100, `unknown: ${report.unknownSourceIds.join(',')}`);
  assert.equal(report.counts.files, 420);
  for (const source of newSources) {
    const verified = report.sources.find(item => item.id === source.id);
    assert.equal(verified?.status, 'verified');
    assert.ok(verified?.files.every(file => file.matchesFrozenHead));
  }
});

test('round15:delegation-depth-normalization-boundary', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'delegation-depth-normalization-v4');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['offline-module', 'slice-verification']);
  assert.equal(source.levels.includes(NEW_LEVEL), false);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of [
    'delegation-depth-default-zero',
    'cold baseline headerFacts delegationDepth is number:0',
    'live header delegationDepth is absent/null',
    'recovery/resume',
    'no other header field is normalized',
    'CORE_VALIDATION_EXPERIMENT_V4',
    '[v1,v2,v3,v4]',
    '1651/1651',
    '1662/1662',
    'separate evidence',
    'fifth attempt is NOT authorized',
    'NEVER be pass',
  ]) {
    assert.ok(text.includes(required), `normalization text missing ${required}`);
  }
  const fix = committedJsonAt<{
    status: string;
    normalization: { condition: string; unchanged: readonly string[] };
    experimentV4: { requestId: string; fixedTemplateSha256: string; acceptance: string };
    tests: { netNew: number };
    verification: { isolatedFullCheck: { tests: { tests: number; pass: number; fail: number }; exitCode: number } };
    failures: readonly unknown[];
  }>('2752f49', 'plugins/shiyu/artifacts/dsh/h3/h3-v4-trusted-header-fix.json');
  assert.match(fix.status, /offline code preparation/);
  assert.match(fix.normalization.condition, /delegationDepth=0/);
  assert.ok(fix.normalization.unchanged.some(line => line.includes('recovery/resume')));
  assert.ok(fix.normalization.unchanged.some(line => line.includes('no other header field is normalized')));
  assert.equal(fix.experimentV4.requestId, 'core-validation-frozen-v4');
  assert.match(fix.experimentV4.acceptance, /only the exact code-level constants/);
  assert.equal(fix.tests.netNew, 8);
  assert.equal(fix.verification.isolatedFullCheck.tests.tests, 1651);
  assert.equal(fix.verification.isolatedFullCheck.tests.pass, 1651);
  assert.equal(fix.verification.isolatedFullCheck.tests.fail, 0);
  assert.equal(fix.verification.isolatedFullCheck.exitCode, 0);
  assert.deepEqual(fix.failures, []);
  const integration = committedJsonAt<{ verification: { leadIntegratedIsolatedCheck: { tests: number; exitCode: number } } }>(
    '7d5d2e1',
    'plugins/shiyu/artifacts/dsh/integration/round14-lead-integration.json',
  );
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.tests, 1662);
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.exitCode, 0);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('delegation-depth-normalization-v4'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'delegation-depth-normalization-v4'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
});

test('round15:new-evidence-level-is-limited', async () => {
  assert.equal(ALLOWED_EVIDENCE_LEVELS.includes(NEW_LEVEL), true);
  assert.equal(LIMITED_EVIDENCE_LEVELS.includes(NEW_LEVEL), true);
  assert.equal((LIMITED_EVIDENCE_LEVELS as readonly string[]).includes('pass'), false);
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round14-host-v4-create-success-eval-failure');
  assert.ok(source !== undefined);
  const sourceLevels: readonly EvidenceLevel[] = [...source.levels];
  assert.deepEqual(sourceLevels, [NEW_LEVEL]);
  for (const mapping of PRODUCT_EVIDENCE_MAPPINGS) {
    for (const level of mapping.levels) assert.ok(ALLOWED_EVIDENCE_LEVELS.includes(level), `${mapping.rowId} level ${level}`);
  }
});

test('round15:v4-create-success-eval-failure-never-pass', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round14-host-v4-create-success-eval-failure');
  assert.ok(source !== undefined);
  const sourceLevels: readonly EvidenceLevel[] = [...source.levels];
  assert.deepEqual(sourceLevels, [NEW_LEVEL]);
  assert.equal(source.levels.includes('bounded-real-model' as EvidenceLevel), false);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of [
    'FAILED fourth attempt',
    'create succeeded',
    'authorized/active/mandate/binding confirmed/goalRef rev1/1 Goal Session',
    'CORE_VALIDATION_EVALUATION_UNKNOWN',
    'evaluateAttempts=1',
    '0 model requests',
    'no request/assistant event',
    'masked as owner_paused',
    'stopAction=pause',
    'budget unknown 3→4',
    'held 16384 tokens/calls 2',
    'no events/Task/Effect/artifact',
    'fifth attempt is NOT authorized',
    'NEVER be pass',
  ]) {
    assert.ok(text.includes(required), `v4 host limitations missing ${required}`);
  }
  const joint = committedJsonAt<{
    status: string;
    result: {
      status: string;
      reasonCode: string;
      counters: { evaluateAttempts: number };
      goal: { authorized: boolean; paused: boolean; nativePhase: string; mandateId: string };
      evaluations: readonly { status: string; reasonCode: string; usage: { state: string; accounting: string } }[];
      stopAction: { kind: string; attempted: boolean; ok: boolean };
      businessSideEffects: {
        goal: {
          created: string;
          observed: { authorized: boolean; nativePhase: string; goalRef: { revision: number }; goalSessionId: string };
        };
        partialCreation: { detected: boolean };
        tasks: { count: number };
        effects: { count: number };
        artifacts: { count: number };
        sessions: { goalSessionId: string; workerSessionIds: readonly string[] };
        budget: { held: { tokens: number; calls: number; effects: number } };
      };
    };
    cachedReceipt: { bytes: number; sha256: string };
    deltas: { attempt: { commitSeq: readonly [number, number]; goals: readonly [number, number]; sessions: readonly [number, number]; events: readonly [number, number] } };
    businessFacts: { goals: number; stateFileUnchanged: boolean };
  }>('6130b80', 'plugins/shiyu/artifacts/dsh/host/round14-bounded-core-goal-v4.json');
  assert.equal(joint.status, 'fixed-host-v4-create-succeeded-evaluation-unknown');
  assert.equal(joint.result.status, 'failed');
  assert.equal(joint.result.reasonCode, 'CORE_VALIDATION_EVALUATION_UNKNOWN');
  assert.equal(joint.result.counters.evaluateAttempts, 1);
  assert.equal(joint.result.goal.authorized, true);
  assert.equal(joint.result.goal.paused, true);
  assert.equal(joint.result.goal.nativePhase, 'paused');
  assert.match(joint.result.goal.mandateId, /^core-mandate:/);
  assert.equal(joint.result.evaluations.length, 1);
  assert.equal(joint.result.evaluations[0].status, 'unknown');
  assert.equal(joint.result.evaluations[0].reasonCode, 'owner_paused');
  assert.equal(joint.result.evaluations[0].usage.state, 'unknown');
  assert.equal(joint.result.evaluations[0].usage.accounting, 'unknown');
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
  assert.deepEqual(joint.deltas.attempt.commitSeq, [456, 470]);
  assert.deepEqual(joint.deltas.attempt.goals, [5, 6]);
  assert.deepEqual(joint.deltas.attempt.sessions, [37, 38]);
  assert.deepEqual(joint.deltas.attempt.events, [60, 60]);
  assert.equal(joint.businessFacts.goals, 6);
  assert.equal(joint.businessFacts.stateFileUnchanged, true);
  assert.equal(joint.cachedReceipt.bytes, 65594);
  const sessionEvents = committedJsonAt<readonly { seq: number | null; type: string }[]>(
    '732b9f7',
    'plugins/shiyu/artifacts/dsh/host/round14/v4-goal-session-events.json',
  );
  assert.equal(sessionEvents.length, 13);
  assert.ok(sessionEvents.every(event => event.type !== 'request' && event.type !== 'assistant/message'));
  assert.ok(sessionEvents.some(event => event.type === 'turn/end'));
  assert.ok(sessionEvents.some(event => event.type === 'goal/change'));
  const statusFinal = git(['show', '732b9f7:plugins/shiyu/artifacts/dsh/host/round14/status-final.json'], 'buffer').stdout as Buffer;
  assert.equal(statusFinal.byteLength, 65594);
  assert.equal(sha256Hex(statusFinal), joint.cachedReceipt.sha256);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('round14-host-v4-create-success-eval-failure'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'round14-host-v4-create-success-eval-failure'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round15:blobcommit-round14-clean-artifacts-stable', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h7-round14-clean-artifacts');
  assert.ok(source !== undefined);
  for (const file of source.files) {
    assert.equal(file.blobCommit, '4f8c342');
    assert.equal(typeof file.expectedSha256, 'string');
    const outcome = await verifyEvidenceFileFacts(workspaceRoot, head, file);
    assert.deepEqual(outcome.issues, []);
    assert.equal(outcome.facts.sha256, file.expectedSha256);
  }
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-round15-blob-'));
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

test('round15:correction-info-only-unmapped', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h7-round14-slice-correction');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['independent-review-info']);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of ['R14-CORR-1', 'real archived log SHA/bytes', 'blockedByConcurrentWip', 'NO green claim', 'not product/host/model/business verification', 'NOT referenced']) {
    assert.ok(text.includes(required), `correction source text missing ${required}`);
  }
  assert.equal(source.files.length, 1);
  assert.ok(source.files[0].path.endsWith('h7-round14-slice.json'));
  assert.equal(source.files[0].blobCommit, '437ac97');
  for (const mapping of PRODUCT_EVIDENCE_MAPPINGS) assert.equal(mapping.sourceIds.includes('h7-round14-slice-correction'), false);
  for (const module of MODULE_DEFINITIONS) assert.equal(module.evidenceSourceIds.includes('h7-round14-slice-correction'), false);
});

test('round15:review-info-only-unmapped', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round14-review');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['independent-review-info']);
  const text = source.limitations.join(' ').toLowerCase();
  for (const needle of ['info', 'not product', 'not referenced']) assert.ok(text.includes(needle), `review limitations missing ${needle}`);
  for (const mapping of PRODUCT_EVIDENCE_MAPPINGS) assert.equal(mapping.sourceIds.includes('round14-review'), false);
  for (const module of MODULE_DEFINITIONS) assert.equal(module.evidenceSourceIds.includes('round14-review'), false);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows);
  for (const system of systems) assert.equal(system.sourceIds.includes('round14-review'), false);
});

test('round15:product-tooling-vsfl-no-upgrade', async () => {
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

test('round15:acceptance-index-cites-round14-limited', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = new Map(buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows).map(system => [system.systemId, system]));
  for (const [systemId, expected] of [
    ['SYS.3', ['delegation-depth-normalization-v4', 'round14-host-v4-create-success-eval-failure']],
    ['SYS.8', ['delegation-depth-normalization-v4', 'round14-host-v4-create-success-eval-failure']],
    ['SYS.9', ['round14-host-v4-create-success-eval-failure']],
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
    for (const sourceId of ['delegation-depth-normalization-v4', 'round14-host-v4-create-success-eval-failure']) {
      assert.ok(module.evidenceSourceIds.includes(sourceId), `${id} missing ${sourceId}`);
    }
  }
  for (const id of ['MOD.recovery-entry', 'MOD.state', 'MOD.persistence']) {
    assert.ok(moduleById(id)?.evidenceSourceIds.includes('round14-host-v4-create-success-eval-failure'), `${id} missing v4 host evidence`);
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

test('round15:slice-evidence-present', async () => {
  const text = await readFile(join(pluginRoot, 'artifacts/dsh/harness/h7-round15-slice.json'), 'utf8').catch(() => null);
  assert.ok(text !== null, 'h7-round15-slice.json must exist');
  const evidence = JSON.parse(text) as {
    kind: string;
    baselineHead: string;
    round14Sources: readonly (string | { readonly id: string })[];
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
  assert.equal(evidence.kind, 'shiyu.harness.h7-round15-slice-evidence');
  assert.match(evidence.baselineHead, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    evidence.round14Sources.map(item => (typeof item === 'string' ? item : item.id)).sort(),
    [...ROUND14_SOURCE_IDS].sort(),
  );
  assert.deepEqual(evidence.sourceCounts, { sources: 84, files: 311 });
  // Historical slice snapshot: hash the blobs as committed in the round-15
  // slice commit (26e1e14). Later rounds legitimately edit these harness files,
  // so a mutable-worktree comparison would turn a historical record into a
  // stale drift check; the committed snapshot is the evidence.
  for (const file of evidence.files) {
    const blob = git(['show', `26e1e14:${file.path}`], 'buffer').stdout as Buffer;
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
