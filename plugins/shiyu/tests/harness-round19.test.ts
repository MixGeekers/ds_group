/**
 * H7-round19 tests: round-18 P0 single-user chat-memory failure, automatic
 * startup embedding verification, TaskRunner workspace integration and the
 * round-18 review are bound as limited diagnostic evidence; nothing here can be
 * a pass.
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
const ROUND18_SOURCE_IDS = [
  'round18-host-p0-chat-memory',
  'h2e-chat-memory-probe',
  'workspace-taskrunner-integration',
  'h7-round18-clean-artifacts',
  'round18-review',
] as const;
const NEW_LEVEL: EvidenceLevel = 'fixed-host-p0-chat-memory-failed';

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

interface Round18HostEvidence {
  readonly status: string;
  readonly attempts: readonly {
    readonly attempt: number;
    readonly phase: string;
    readonly result: string;
    readonly reasonCode: string;
    readonly generationModelCalls: number | string;
    readonly replyInput: { readonly status: string; readonly reasonCode: string; readonly memorySourceCount: number };
  }[];
  readonly startupEmbeddingVerification: {
    readonly file: string;
    readonly sha256: string;
    readonly value: {
      readonly attempted: boolean;
      readonly verified: boolean;
      readonly reason: string | null;
      readonly embeddingCalls: number;
      readonly usageComplete: boolean;
      readonly semanticPublished: boolean;
    };
    readonly note: string;
  };
  readonly memory: {
    readonly readiness: {
      readonly embeddingVerified: boolean;
      readonly semanticReady: boolean;
      readonly capabilities: readonly string[];
      readonly reason: string;
      readonly coverage: { readonly readableCount: number; readonly indexedCount: number; readonly staleCount: number; readonly coverageComplete: boolean };
    };
    readonly probeMemories: readonly { readonly operationId: string; readonly status: string; readonly blocked: boolean; readonly canRead: boolean }[];
  };
  readonly delta: {
    readonly write2: { readonly stateFile: readonly [string, string] };
  };
  readonly effectsBudgetDisclosure: {
    readonly note: string;
    readonly effectsSucceeded: readonly number[];
    readonly timeline: readonly { readonly stage: string; readonly effects: { readonly succeeded: number }; readonly budget: { readonly states: { readonly settled: number; readonly unknown: number } } }[];
  };
  readonly evidenceCorrections: readonly { readonly id: string; readonly finding: string; readonly resolution: string }[];
  readonly limitations: readonly string[];
}

test('round19:new-round18-sources-integrity-and-ancestry', async () => {
  assert.equal(EVIDENCE_SOURCES.length, 105);
  const ids = new Set(EVIDENCE_SOURCES.map(source => source.id));
  for (const id of ROUND18_SOURCE_IDS) assert.ok(ids.has(id), `missing round-18 source ${id}`);
  const newSources = EVIDENCE_SOURCES.filter(source => ROUND18_SOURCE_IDS.includes(source.id as (typeof ROUND18_SOURCE_IDS)[number]));
  assert.equal(newSources.length, 5);
  assert.equal(newSources.reduce((sum, source) => sum + source.files.length, 0), 34);
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
  assert.equal(report.counts.sources, 105);
  assert.equal(report.counts.verified, 105, `unknown: ${report.unknownSourceIds.join(',')}`);
  assert.equal(report.counts.files, 454);
  for (const source of newSources) {
    const verified = report.sources.find(item => item.id === source.id);
    assert.equal(verified?.status, 'verified');
    assert.ok(verified?.files.every(file => file.matchesFrozenHead));
  }
});

test('round19:new-limited-level-defined', async () => {
  assert.equal(ALLOWED_EVIDENCE_LEVELS.includes(NEW_LEVEL), true);
  assert.equal(LIMITED_EVIDENCE_LEVELS.includes(NEW_LEVEL), true);
  for (const forbidden of ['complete', 'completed', 'verified', 'passed', 'pass', 'full', 'accepted']) {
    assert.equal((ALLOWED_EVIDENCE_LEVELS as readonly string[]).includes(forbidden), false);
    assert.equal((LIMITED_EVIDENCE_LEVELS as readonly string[]).includes(forbidden), false);
  }
  assert.equal(NEW_LEVEL.includes('pass'), false);
  assert.equal(NEW_LEVEL.includes('complete'), false);
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round18-host-p0-chat-memory');
  assert.ok(source !== undefined);
  const sourceLevels: readonly EvidenceLevel[] = [...source.levels];
  assert.deepEqual(sourceLevels, [NEW_LEVEL]);
  const host = committedJsonAt<Round18HostEvidence>('15d86ee', 'plugins/shiyu/artifacts/dsh/host/round18-p0-chat-memory.json');
  assert.equal(host.status, 'fixed-host-startup-embedding-verified-chat-reply-failed');
  assert.equal(host.attempts[0].reasonCode, 'INVALID_INDEX_OBSERVATION');
  assert.equal(host.attempts[0].generationModelCalls, 0);
  assert.equal(host.attempts[1].reasonCode, 'REPLY_FAILED');
  assert.equal(host.attempts[1].replyInput.status, 'unknown');
  assert.equal(host.attempts[1].replyInput.memorySourceCount, 2);
});

test('round19:chat-memory-failure-never-pass', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round18-host-p0-chat-memory');
  assert.ok(source !== undefined);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of [
    'INVALID_INDEX_OBSERVATION',
    '0 generation calls',
    'REPLY_FAILED',
    'usage null',
    'replyer Session was cancelled',
    'recall phase was NOT executed',
    'restart recall',
    'same-Session',
    'NOT passed',
    '0 automatic retries',
    'two synthetic',
    '19→21→23',
    '27→29→31',
    'unknown stays 6',
    'runtime-state file changed',
    'NEVER be pass',
  ]) {
    assert.ok(text.includes(required), `chat-memory host text missing ${required}`);
  }
  const host = committedJsonAt<Round18HostEvidence>('15d86ee', 'plugins/shiyu/artifacts/dsh/host/round18-p0-chat-memory.json');
  assert.equal(host.attempts.length, 2);
  assert.equal(host.attempts[0].phase, 'write');
  assert.equal(host.attempts[0].result, 'failed before any model request');
  assert.equal(host.attempts[1].phase, 'write');
  assert.match(host.attempts[1].result, /no current verified draft/);
  const replyFailures = committedJsonAt<{
    replyInputs: readonly { inputId: string; status: string; reasonCode: string; memorySourceCount: number }[];
    memoryOps: readonly { requestId: string; operationId: string; conversationId: string }[];
  }>('3673395', 'plugins/shiyu/artifacts/dsh/host/round18/reply-failures.json');
  const replied = replyFailures.replyInputs.find(input => input.reasonCode === 'REPLY_FAILED');
  assert.ok(replied !== undefined);
  assert.equal(replied.status, 'unknown');
  assert.equal(replied.memorySourceCount, 2);
  const rejected = replyFailures.replyInputs.find(input => input.reasonCode === 'INVALID_INDEX_OBSERVATION');
  assert.ok(rejected !== undefined);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.memorySourceCount, 0);
  assert.equal(replyFailures.memoryOps.length, 4);
  assert.equal(replyFailures.memoryOps.filter(op => op.requestId.startsWith('chat-memory-probe-write-')).length, 2);
  assert.ok(replyFailures.memoryOps.every(op => op.conversationId.length > 0));
  const plan = committedJsonAt<{
    status: string;
    scope: { maxGenerationCalls: number; maxTokensPerCall: number; retries: number; orderedReloads: number; toolCalls: readonly string[] };
  }>('3673395', 'plugins/shiyu/artifacts/dsh/host/round18/plan.json');
  assert.equal(plan.status, 'frozen-before-execution');
  assert.equal(plan.scope.maxGenerationCalls, 2);
  assert.equal(plan.scope.maxTokensPerCall, 256);
  assert.equal(plan.scope.retries, 0);
  assert.equal(plan.scope.orderedReloads, 2);
  assert.deepEqual([...plan.scope.toolCalls].sort(), ['recall', 'write']);
  assert.ok(host.limitations.some(line => line.includes('No recall phase was executed')));
  assert.ok(host.limitations.some(line => line.includes('residual data')));
  const mapped = EVIDENCE_SOURCES.find(item => item.id === 'h2e-chat-memory-probe');
  assert.ok(mapped !== undefined);
  assert.deepEqual([...mapped.levels], ['offline-module']);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('round18-host-p0-chat-memory'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'round18-host-p0-chat-memory'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round19:startup-verification-is-not-recall', async () => {
  const host = committedJsonAt<Round18HostEvidence>('15d86ee', 'plugins/shiyu/artifacts/dsh/host/round18-p0-chat-memory.json');
  const startup = host.startupEmbeddingVerification.value;
  assert.equal(startup.attempted, true);
  assert.equal(startup.verified, true);
  assert.equal(startup.reason, null);
  assert.equal(startup.embeddingCalls, 1);
  assert.equal(startup.usageComplete, true);
  assert.equal(startup.semanticPublished, true);
  assert.match(host.startupEmbeddingVerification.note, /not a chat-memory recall proof/);
  const statusExtract = committedJsonAt<{ startupEmbeddingVerification: typeof startup; readiness: { capabilities: readonly string[]; reason: string; coverage: { readableCount: number; indexedCount: number; staleCount: number; coverageComplete: boolean } } }>(
    '3673395',
    'plugins/shiyu/artifacts/dsh/host/round18/status-extract.json',
  );
  assert.deepEqual(statusExtract.startupEmbeddingVerification, startup);
  assert.deepEqual(statusExtract.readiness.capabilities, ['exact_read', 'semantic_search']);
  assert.equal(statusExtract.readiness.reason, 'INDEX_COVERAGE_INCOMPLETE');
  assert.equal(statusExtract.readiness.coverage.coverageComplete, false);
  assert.equal(statusExtract.readiness.coverage.readableCount, 2);
  assert.equal(statusExtract.readiness.coverage.indexedCount, 2);
  const startupBuffer = git(['show', '3673395:plugins/shiyu/artifacts/dsh/host/round18/status-extract.json'], 'buffer').stdout as Buffer;
  assert.equal(sha256Hex(startupBuffer), host.startupEmbeddingVerification.sha256);
  assert.equal(host.memory.readiness.embeddingVerified, true);
  assert.equal(host.memory.readiness.semanticReady, true);
  assert.equal(host.memory.readiness.reason, 'INDEX_COVERAGE_INCOMPLETE');
  assert.equal(host.memory.readiness.coverage.staleCount, 4);
  assert.equal(host.memory.probeMemories.length, 2);
  assert.ok(host.memory.probeMemories.every(memory => memory.status === 'applied' && memory.canRead === true && memory.blocked === false));
  assert.equal(ROUND18_SOURCE_IDS.includes('h2e-chat-memory-probe'), true);
});

test('round19:effects-budget-f18-disclosure', async () => {
  const host = committedJsonAt<Round18HostEvidence>('15d86ee', 'plugins/shiyu/artifacts/dsh/host/round18-p0-chat-memory.json');
  const disclosure = host.effectsBudgetDisclosure;
  assert.match(disclosure.note, /F18-R1/);
  assert.deepEqual(disclosure.effectsSucceeded, [19, 19, 21, 21, 23]);
  const stages = disclosure.timeline.map(stage => stage.stage);
  assert.deepEqual(stages, ['before', 'reload1', 'write1-failed-pre-model', 'reload2', 'write2-reply-failed']);
  assert.equal(disclosure.timeline[0].effects.succeeded, 19);
  assert.deepEqual(disclosure.timeline[0].budget.states, { settled: 27, unknown: 6 });
  assert.equal(disclosure.timeline[2].effects.succeeded, 21);
  assert.deepEqual(disclosure.timeline[2].budget.states, { settled: 29, unknown: 6 });
  assert.equal(disclosure.timeline[4].effects.succeeded, 23);
  assert.deepEqual(disclosure.timeline[4].budget.states, { settled: 31, unknown: 6 });
  const correction = host.evidenceCorrections.find(item => item.id === 'F18-R1');
  assert.ok(correction !== undefined);
  assert.match(correction.finding, /19→21→23/);
  assert.match(correction.resolution, /effectsBudgetDisclosure/);
  const [beforeState, afterState] = host.delta.write2.stateFile;
  assert.notEqual(beforeState, afterState);
  assert.match(host.delta.write2.stateFile[1], /^[0-9a-f]{64}$/);
  assert.ok(host.attempts[0].replyInput.memorySourceCount === 0);
  assert.ok(host.attempts[1].replyInput.memorySourceCount === 2);
});

test('round19:h2e-offline-probe-boundary', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h2e-chat-memory-probe');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['offline-module']);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of ['two-phase', 'startup embedding verifier', '18/18', '1782/1782', 'NO_ELIGIBLE_MEMORY', 'fake-ports', 'NEVER be pass']) {
    assert.ok(text.includes(required), `h2e text missing ${required}`);
  }
  const h2e = committedJsonAt<{
    status: string;
    evidenceLevel: string;
    failures: readonly unknown[];
    verification: { isolatedWorktree: { exitCode: number; tests: number; pass: number; fail: number; skipped: number }; targeted: { count: number; pass: number } };
    hostKit: { status: string };
    boundaries: readonly string[];
  }>('c47502d', 'plugins/shiyu/artifacts/dsh/h2/h2e-single-user-chat-memory-probe.json');
  assert.match(h2e.status, /离线\/集成通过/);
  assert.match(h2e.evidenceLevel, /G1/);
  assert.equal(h2e.verification.isolatedWorktree.exitCode, 0);
  assert.equal(h2e.verification.isolatedWorktree.tests, 1782);
  assert.equal(h2e.verification.isolatedWorktree.pass, 1782);
  assert.equal(h2e.verification.isolatedWorktree.fail, 0);
  assert.equal(h2e.verification.isolatedWorktree.skipped, 0);
  assert.equal(h2e.verification.targeted.count, 18);
  assert.equal(h2e.verification.targeted.pass, 18);
  assert.match(h2e.hostKit.status, /待真实宿主/);
  assert.deepEqual(h2e.failures, []);
  assert.ok(h2e.boundaries.some(line => line.includes('未真实模型')));
});

test('round19:workspace-taskrunner-wired-wording', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'workspace-taskrunner-integration');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['offline-module']);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of ['wiring is now REAL', 'RuntimeConfig.sharedWorkspaceRoot', 'LocalTaskRunner 4th argument', '10/10', '1776/1776', 'F18-R2', 'runtimeWired=false is accurate only for the pre-integration adapter slice', 'NEVER be pass']) {
    assert.ok(text.includes(required), `workspace integration text missing ${required}`);
  }
  const integration = committedJsonAt<{
    evidenceLevel: string;
    summary: { total: number; passed: number; failed: number };
    integration: { patchApplies: boolean; patchSha256: string; runtime: string; indexTsChange: string };
    boundaries: {
      liveHost: boolean;
      modelCalls: number;
      runtimeTsEdited: boolean;
      runtimeTsEditedByAuthor: boolean;
      runtimeTsEditedByLead: boolean;
      runtimeIntegrationApplied: string;
    };
    verification: { runs: { final: { exitCode: number; counts: { tests: number; pass: number; fail: number } } } };
    evidenceCorrections: readonly { id: string; finding: string; resolution: string }[];
  }>('15d86ee', 'plugins/shiyu/artifacts/dsh/tasks/workspace-runtime-integration.json');
  assert.match(integration.evidenceLevel, /G1/);
  assert.deepEqual(integration.summary, { total: 10, passed: 10, failed: 0 });
  assert.equal(integration.integration.patchApplies, true);
  assert.match(integration.integration.runtime, /RuntimeConfig.sharedWorkspaceRoot/);
  assert.match(integration.integration.runtime, /LocalTaskRunner/);
  assert.equal(integration.boundaries.liveHost, false);
  assert.equal(integration.boundaries.modelCalls, 0);
  assert.equal(integration.boundaries.runtimeTsEdited, false);
  assert.equal(integration.boundaries.runtimeTsEditedByAuthor, false);
  assert.equal(integration.boundaries.runtimeTsEditedByLead, true);
  assert.match(integration.boundaries.runtimeIntegrationApplied, /Lead applied it in c47502d/);
  assert.equal(integration.verification.runs.final.exitCode, 0);
  assert.equal(integration.verification.runs.final.counts.tests, 1776);
  assert.equal(integration.verification.runs.final.counts.pass, 1776);
  assert.equal(integration.verification.runs.final.counts.fail, 0);
  const correction = integration.evidenceCorrections.find(item => item.id === 'F18-R2');
  assert.ok(correction !== undefined);
  assert.match(correction.resolution, /runtime integration is wired|TaskRunner integration is wired|wired/i);
});

test('round19:review-info-only-unmapped', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round18-review');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['independent-review-info']);
  const text = source.limitations.join(' ').toLowerCase();
  for (const needle of ['info', 'not product', 'not referenced']) assert.ok(text.includes(needle), `review limitations missing ${needle}`);
  for (const mapping of PRODUCT_EVIDENCE_MAPPINGS) assert.equal(mapping.sourceIds.includes('round18-review'), false);
  for (const module of MODULE_DEFINITIONS) assert.equal(module.evidenceSourceIds.includes('round18-review'), false);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows);
  for (const system of systems) assert.equal(system.sourceIds.includes('round18-review'), false);
});

test('round19:product-tooling-vsfl-no-upgrade', async () => {
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

test('round19:acceptance-index-cites-round18-limited', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = new Map(buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows).map(system => [system.systemId, system]));
  for (const [systemId, expected] of [
    ['SYS.3', ['h2e-chat-memory-probe', 'round18-host-p0-chat-memory']],
    ['SYS.8', ['h2e-chat-memory-probe', 'round18-host-p0-chat-memory', 'workspace-taskrunner-integration', 'h7-round18-clean-artifacts']],
    ['SYS.9', ['round18-host-p0-chat-memory']],
  ] as const) {
    const system = systems.get(systemId);
    assert.ok(system !== undefined);
    for (const id of expected) assert.ok(system.sourceIds.includes(id), `${systemId} missing ${id}`);
    assert.equal(system.row?.state, 'limited-only');
    for (const level of system.verifiedLevels) assert.ok(LIMITED_EVIDENCE_LEVELS.includes(level));
  }
  const moduleById = (id: string) => MODULE_DEFINITIONS.find(module => module.id === id);
  for (const [id, sourceId] of [
    ['MOD.core', 'h2e-chat-memory-probe'],
    ['MOD.model-session', 'h2e-chat-memory-probe'],
    ['MOD.model-session', 'round18-host-p0-chat-memory'],
    ['MOD.recovery-entry', 'h2e-chat-memory-probe'],
    ['MOD.state', 'round18-host-p0-chat-memory'],
    ['MOD.state', 'workspace-taskrunner-integration'],
    ['MOD.lifecycle', 'round18-host-p0-chat-memory'],
    ['MOD.lifecycle', 'h2e-chat-memory-probe'],
    ['MOD.lifecycle', 'workspace-taskrunner-integration'],
    ['MOD.memory', 'h2e-chat-memory-probe'],
    ['MOD.memory', 'round18-host-p0-chat-memory'],
    ['MOD.views', 'round18-host-p0-chat-memory'],
    ['MOD.artifacts', 'workspace-taskrunner-integration'],
    ['MOD.worker', 'workspace-taskrunner-integration'],
  ] as const) {
    const module = moduleById(id);
    assert.ok(module !== undefined);
    assert.ok(module.evidenceSourceIds.includes(sourceId), `${id} missing ${sourceId}`);
  }
  for (const module of MODULE_DEFINITIONS) {
    assert.ok(module.evidenceSourceIds.every(id => EVIDENCE_SOURCES.some(source => source.id === id)), `${module.id} cites unknown source`);
    assert.ok(module.systems.length > 0);
  }
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.modules.length, 40);
  assert.equal(acceptance.systems.length, 9);
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.summary.denominators.planned, 92);
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round19:blobcommit-f18-corrections-stable', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const newSources = EVIDENCE_SOURCES.filter(source => ROUND18_SOURCE_IDS.includes(source.id as (typeof ROUND18_SOURCE_IDS)[number]));
  for (const source of newSources) {
    for (const file of source.files) {
      assert.equal(typeof file.expectedSha256, 'string', `${file.path} expectedSha256`);
      assert.match(file.blobCommit ?? '', /^[0-9a-f]{7,40}$/, `${file.path} blobCommit`);
      const outcome = await verifyEvidenceFileFacts(workspaceRoot, head, file);
      assert.deepEqual(outcome.issues, [], `${source.id} ${file.path} facts`);
      assert.equal(outcome.facts.sha256, file.expectedSha256);
    }
  }
  const corrected: readonly [string, string, string][] = [
    ['round18-host-p0-chat-memory', 'plugins/shiyu/artifacts/dsh/host/round18-p0-chat-memory.json', '15d86ee'],
    ['workspace-taskrunner-integration', 'plugins/shiyu/artifacts/dsh/tasks/workspace-runtime-integration.json', '15d86ee'],
    ['h2e-chat-memory-probe', 'plugins/shiyu/src/control/chat-memory-probe.ts', 'ff5ea11'],
    ['h2e-chat-memory-probe', 'plugins/shiyu/src/runtime.ts', 'ff5ea11'],
    ['h2e-chat-memory-probe', 'plugins/shiyu/tests/chat-memory-probe.test.ts', 'ff5ea11'],
    ['h7-round18-clean-artifacts', 'plugins/shiyu/artifacts/dsh/harness/manifest.json', '8a06066'],
  ];
  for (const [sourceId, path, blobCommit] of corrected) {
    const source = newSources.find(item => item.id === sourceId);
    assert.ok(source !== undefined);
    const file = source.files.find(item => item.path === path);
    assert.ok(file !== undefined, `${sourceId} missing ${path}`);
    assert.equal(file.blobCommit, blobCommit);
  }
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-round19-blob-'));
  try {
    await symlink(join(workspaceRoot, '.git'), join(directory, '.git'));
    const ref = EVIDENCE_SOURCES.find(item => item.id === 'round18-host-p0-chat-memory')?.files.find(file => file.path.endsWith('round18-p0-chat-memory.json'));
    assert.ok(ref !== undefined);
    const target = join(directory, ref.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, '{"rewritten":true}\n', 'utf8');
    assert.deepEqual((await verifyEvidenceFileFacts(directory, head, ref)).issues, []);
    const wrong = await verifyEvidenceFileFacts(directory, head, { ...ref, expectedSha256: '0'.repeat(64) });
    assert.ok(wrong.issues.some(issue => issue.includes('does not match expected committed blob SHA')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const manifest = committedJsonAt<{ vcs: { head: string; dirty: boolean } }>('8a06066', 'plugins/shiyu/artifacts/dsh/harness/manifest.json');
  assert.equal(manifest.vcs.head, 'fc4b94740e56f4f1d182b287b50cc29e5c315f18');
  assert.equal(manifest.vcs.dirty, false);
});

test('round19:slice-evidence-present', async () => {
  const text = await readFile(join(pluginRoot, 'artifacts/dsh/harness/h7-round19-slice.json'), 'utf8').catch(() => null);
  assert.ok(text !== null, 'h7-round19-slice.json must exist');
  const evidence = JSON.parse(text) as {
    kind: string;
    baselineHead: string;
    round18Sources: readonly (string | { readonly id: string })[];
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
  assert.equal(evidence.kind, 'shiyu.harness.h7-round19-slice-evidence');
  assert.match(evidence.baselineHead, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    evidence.round18Sources.map(item => (typeof item === 'string' ? item : item.id)).sort(),
    [...ROUND18_SOURCE_IDS].sort(),
  );
  assert.deepEqual(evidence.sourceCounts, { sources: 105, files: 454 });
  for (const file of evidence.files) {
    const bytes = await readFile(join(workspaceRoot, file.path));
    assert.equal(sha256Hex(bytes), file.sha256, `${file.path} slice sha`);
    assert.equal(bytes.byteLength, file.bytes);
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
