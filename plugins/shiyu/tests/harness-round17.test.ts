/**
 * H7-round17 tests: round-16 runtime-context binding (v6) and the sixth
 * fixed-host v6 attempt (first real model request, empty provider stream) are
 * bound as limited diagnostic evidence; nothing here can be a pass.
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
const ROUND16_SOURCE_IDS = [
  'runtime-context-binding-v6',
  'round16-host-v6-first-model-request-empty-stream',
  'h7-round16-clean-artifacts',
  'round16-review',
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

interface V6Joint {
  readonly status: string;
  readonly milestone: string;
  readonly result: {
    readonly status: string;
    readonly reasonCode: string;
    readonly counters: { readonly evaluateAttempts: number; readonly pollCount: number };
    readonly goal: { readonly authorized: boolean; readonly paused: boolean; readonly nativePhase: string; readonly mandateId: string; readonly version: number };
    readonly evaluations: readonly { readonly status: string; readonly reasonCode: string; readonly usage: { readonly state: string; readonly observedTokens: null; readonly observedCalls: null; readonly accounting: string } }[];
    readonly preStopEvaluation: { readonly evaluationId: string; readonly status: string; readonly reasonCode: string };
    readonly stopAction: { readonly kind: string; readonly attempted: boolean; readonly ok: boolean; readonly goalVersion: number };
    readonly unknowns: readonly string[];
    readonly businessSideEffects: {
      readonly goal: { readonly created: string; readonly observed: { readonly authorized: boolean; readonly paused: boolean; readonly nativePhase: string; readonly goalRef: { readonly revision: number }; readonly goalSessionId: string; readonly bindingReceiptStatus: string } };
      readonly partialCreation: { readonly detected: boolean };
      readonly tasks: { readonly count: number };
      readonly effects: { readonly count: number };
      readonly artifacts: { readonly count: number };
      readonly sessions: { readonly workerSessionIds: readonly string[]; readonly goalSessionId: string };
      readonly budget: { readonly held: { readonly tokens: number; readonly calls: number; readonly effects: number } };
    };
  };
  readonly createSuccess: string;
  readonly failure: { readonly evaluationStatus: string; readonly reasonCode: string; readonly detail: string };
  readonly sessionEvents: { readonly file: string; readonly bytes: number; readonly sha256: string; readonly count: number; readonly types: readonly string[] };
  readonly deltas: {
    readonly attempt: {
      readonly commitSeq: readonly [number, number];
      readonly events: readonly [number, number];
      readonly sessions: readonly [number, number];
      readonly goals: readonly [number, number];
      readonly budget: readonly [{ readonly settled: number; readonly unknown: number }, { readonly settled: number; readonly unknown: number }];
    };
  };
  readonly cachedReceipt: { readonly file: string; readonly bytes: number; readonly sha256: string; readonly bytesSemantics: string };
  readonly evidenceCorrections: readonly { readonly id: string; readonly finding: string; readonly resolution: string }[];
  readonly residual: { readonly note: string };
  readonly businessFacts: { readonly goals: number; readonly stateFileUnchanged: boolean; readonly budget: { readonly settled: number; readonly unknown: number } };
  readonly limitations: readonly string[];
}

test('round17:new-round16-sources-integrity-and-ancestry', async () => {
  assert.equal(EVIDENCE_SOURCES.length, 105);
  const ids = new Set(EVIDENCE_SOURCES.map(source => source.id));
  for (const id of ROUND16_SOURCE_IDS) assert.ok(ids.has(id), `missing round-16 source ${id}`);
  const newSources = EVIDENCE_SOURCES.filter(source => ROUND16_SOURCE_IDS.includes(source.id as (typeof ROUND16_SOURCE_IDS)[number]));
  assert.equal(newSources.length, 4);
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
  assert.equal(report.counts.sources, 105);
  assert.equal(report.counts.verified, 105, `unknown: ${report.unknownSourceIds.join(',')}`);
  assert.equal(report.counts.files, 454);
  for (const source of newSources) {
    const verified = report.sources.find(item => item.id === source.id);
    assert.equal(verified?.status, 'verified');
    assert.ok(verified?.files.every(file => file.matchesFrozenHead));
  }
});

test('round17:runtime-context-binding-v6-semantics', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'runtime-context-binding-v6');
  assert.ok(source !== undefined);
  const sourceLevels: readonly EvidenceLevel[] = [...source.levels];
  assert.deepEqual(sourceLevels, ['offline-module', 'slice-verification']);
  assert.equal(source.levels.includes(LEVEL), false);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of [
    'assembly renderer',
    'exact rendered hash or structural binding',
    'source kind/form/section rendering/cwd',
    'third/wrong-order/bad context',
    'contextDiagnostic',
    'mismatchKind/fieldNames/shaPrefixes',
    'FIRST unknown reason',
    'CORE_VALIDATION_EXPERIMENT_V6',
    '[v1..v6]',
    '1689/1689',
    '1700/1700',
    'seventh attempt',
    'NEVER be pass',
  ]) {
    assert.ok(text.includes(required), `binding text missing ${required}`);
  }
  const h3 = committedJsonAt<{
    status: string;
    tests: { netNew: number; noSkips: boolean };
    verification: { isolatedFullCheck: { exitCode: number; tests: { tests: number; pass: number; fail: number; skipped: number } } };
    experimentV6: { requestId: string; fixedTemplateSha256: string; acceptance: string };
    reconcile: { fixedTargets: readonly string[] };
    failures: readonly unknown[];
  }>('fcb7604', 'plugins/shiyu/artifacts/dsh/h3/h3-v6-decision-context-binding.json');
  assert.match(h3.status, /offline code preparation/);
  assert.equal(h3.tests.netNew, 8);
  assert.equal(h3.tests.noSkips, true);
  assert.equal(h3.verification.isolatedFullCheck.tests.tests, 1689);
  assert.equal(h3.verification.isolatedFullCheck.tests.pass, 1689);
  assert.equal(h3.verification.isolatedFullCheck.tests.fail, 0);
  assert.equal(h3.verification.isolatedFullCheck.tests.skipped, 0);
  assert.equal(h3.verification.isolatedFullCheck.exitCode, 0);
  assert.equal(h3.experimentV6.requestId, 'core-validation-frozen-v6');
  assert.deepEqual(h3.reconcile.fixedTargets, [
    'core-validation-frozen-v1',
    'core-validation-frozen-v2',
    'core-validation-frozen-v3',
    'core-validation-frozen-v4',
    'core-validation-frozen-v5',
    'core-validation-frozen-v6',
  ]);
  assert.deepEqual(h3.failures, []);
  const integration = committedJsonAt<{ status: string; verification: { leadIntegratedIsolatedCheck: { tests: number; pass: number; fail: number; skipped: number; exitCode: number } } }>(
    'dcede28',
    'plugins/shiyu/artifacts/dsh/integration/round16-lead-integration.json',
  );
  assert.equal(integration.status, 'offline-verified-integration');
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.tests, 1700);
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.pass, 1700);
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.fail, 0);
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.skipped, 0);
  assert.equal(integration.verification.leadIntegratedIsolatedCheck.exitCode, 0);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('runtime-context-binding-v6'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'runtime-context-binding-v6'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
});

test('round17:first-real-model-request-empty-stream-never-pass', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round16-host-v6-first-model-request-empty-stream');
  assert.ok(source !== undefined);
  const sourceLevels: readonly EvidenceLevel[] = [...source.levels];
  assert.deepEqual(sourceLevels, [LEVEL]);
  assert.equal(source.levels.includes('bounded-real-model' as EvidenceLevel), false);
  assert.equal(source.levels.includes('bounded-real-model-diagnostic-only' as EvidenceLevel), false);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of [
    'FAILED sixth attempt',
    'third create success',
    'assembly-rendered runtime-context binding',
    '21-event Goal Session',
    'request/header',
    'three mounted read-only event tools',
    'request/context',
    'FIRST real model request',
    'provider stream was EMPTY',
    'streamLength=0',
    'CORE_VALIDATION_EVALUATION_UNKNOWN',
    'preStopEvaluation.reasonCode=CORE_EXECUTION_UNCONFIRMED',
    'evaluateAttempts=1',
    'no token usage',
    '+14 commitSeq',
    'goals 7→8',
    'sessions 39→40',
    'budget unknown 5→6',
    'held 16384 tokens/calls 2',
    'no events/Task/Effect/artifact',
    'v4, v5 and v6',
    'seventh attempt is NOT authorized',
    'NEVER be pass',
  ]) {
    assert.ok(text.includes(required), `v6 host limitations missing ${required}`);
  }
  const joint = committedJsonAt<V6Joint>('9d41966', 'plugins/shiyu/artifacts/dsh/host/round16-bounded-core-goal-v6.json');
  assert.equal(joint.status, 'fixed-host-v6-create-succeeded-first-real-model-request-empty-stream');
  assert.equal(joint.result.status, 'failed');
  assert.equal(joint.result.reasonCode, 'CORE_VALIDATION_EVALUATION_UNKNOWN');
  assert.equal(joint.result.counters.evaluateAttempts, 1);
  assert.equal(joint.result.counters.pollCount, 0);
  assert.equal(joint.result.goal.authorized, true);
  assert.equal(joint.result.goal.paused, true);
  assert.equal(joint.result.goal.nativePhase, 'paused');
  assert.match(joint.result.goal.mandateId, /^core-mandate:/);
  assert.equal(joint.result.evaluations.length, 1);
  assert.equal(joint.result.evaluations[0].status, 'unknown');
  assert.equal(joint.result.evaluations[0].reasonCode, 'CORE_EXECUTION_UNCONFIRMED');
  assert.deepEqual(joint.result.evaluations[0].usage, { state: 'unknown', observedTokens: null, observedCalls: null, overrun: false, accounting: 'unknown' });
  assert.deepEqual(joint.result.preStopEvaluation, {
    evaluationId: 'evaluation:core-02829b5e321e30a0f8824fe2db2a41496cccafca:1',
    status: 'unknown',
    reasonCode: 'CORE_EXECUTION_UNCONFIRMED',
  });
  assert.equal(joint.result.stopAction.kind, 'pause');
  assert.equal(joint.result.stopAction.attempted, true);
  assert.equal(joint.result.stopAction.ok, true);
  assert.equal(joint.result.stopAction.goalVersion, 5);
  assert.deepEqual([...joint.result.unknowns].sort(), ['EVALUATION_UNKNOWN', 'USAGE_UNKNOWN']);
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
  assert.deepEqual(joint.deltas.attempt.commitSeq, [496, 510]);
  assert.deepEqual(joint.deltas.attempt.events, [62, 62]);
  assert.deepEqual(joint.deltas.attempt.sessions, [39, 40]);
  assert.deepEqual(joint.deltas.attempt.goals, [7, 8]);
  assert.deepEqual(joint.deltas.attempt.budget, [
    { settled: 21, unknown: 5 },
    { settled: 21, unknown: 6 },
  ]);
  assert.equal(joint.businessFacts.goals, 8);
  assert.equal(joint.businessFacts.stateFileUnchanged, true);
  assert.equal(joint.businessFacts.budget.unknown, 6);
  assert.equal(joint.cachedReceipt.bytes, 70221);
  assert.equal(joint.cachedReceipt.sha256, 'ea856219cba7db02d5a27dfe34a7c94ad1e0e4a39718b48fea86cbb0ce185265');
  const statusFinal = git(['show', '893f846:plugins/shiyu/artifacts/dsh/host/round16/status-final.json'], 'buffer').stdout as Buffer;
  assert.equal(statusFinal.byteLength, 70221);
  assert.equal(sha256Hex(statusFinal), joint.cachedReceipt.sha256);
  assert.match(joint.residual.note, /v4, v5 and v6/);
  assert.match(joint.residual.note, /seventh attempt is unauthorized/);
  assert.ok(joint.limitations.some(line => line.includes('failed sixth attempt')));
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('round16-host-v6-first-model-request-empty-stream'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'round16-host-v6-first-model-request-empty-stream'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
  const { report: acceptance } = await buildAcceptanceReport(await acceptanceInputs());
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  assert.equal(checkAcceptanceHonesty(acceptance).ok, true);
});

test('round17:first-model-request-session-events-boundary', async () => {
  const joint = committedJsonAt<V6Joint>('9d41966', 'plugins/shiyu/artifacts/dsh/host/round16-bounded-core-goal-v6.json');
  const events = committedJsonAt<readonly { seq: number | null; type: string; data: unknown }[]>(
    '893f846',
    'plugins/shiyu/artifacts/dsh/host/round16/v6-goal-session-events.json',
  );
  assert.equal(events.length, 21);
  assert.equal(events[0].seq, null);
  assert.equal(events[0].type, 'session');
  assert.deepEqual(joint.sessionEvents.types, events.map(event => event.type));
  assert.equal(joint.sessionEvents.count, 21);
  const header = events.find(event => event.type === 'request/header');
  assert.ok(header !== undefined);
  assert.deepEqual(header.data, {
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    tools: ['shiyu_core_event_types', 'shiyu_core_event_subscriptions', 'shiyu_core_event_report'],
  });
  const requestContext = events.find(event => event.type === 'request/context');
  assert.ok(requestContext !== undefined);
  assert.deepEqual(requestContext.data, { provider: 'opencode-go', model: 'deepseek-v4.1-flash', contextWindow: 1_000_000 });
  const attempt = events.find(event => event.type === 'assistant/attempt');
  assert.ok(attempt !== undefined);
  assert.deepEqual(attempt.data, { streamLength: 0, reason: null });
  const turnEnd = events.find(event => event.type === 'turn/end');
  assert.ok(turnEnd !== undefined);
  assert.deepEqual(turnEnd.data, { reason: 'Core decision cancelled' });
  for (const type of ['system/message', 'user/message', 'request/header', 'request/context', 'assistant/attempt', 'step/end', 'turn/end']) {
    assert.ok(events.some(event => event.type === type), `missing first-request event ${type}`);
  }
  assert.equal(events.filter(event => event.type === 'user/message').length, 2);
  const buffer = git(['show', '893f846:plugins/shiyu/artifacts/dsh/host/round16/v6-goal-session-events.json'], 'buffer').stdout as Buffer;
  assert.equal(buffer.byteLength, joint.sessionEvents.bytes);
  assert.equal(sha256Hex(buffer), joint.sessionEvents.sha256);
  const receipt = committedJsonAt<{
    status: string;
    reasonCode: string;
    counters: { evaluateAttempts: number };
    evaluations: readonly { status: string; reasonCode: string; usage: { state: string } }[];
    preStopEvaluation: { reasonCode: string };
    stopAction: { kind: string };
    sent: boolean;
    readOnlyProbe: boolean;
  }>('893f846', 'plugins/shiyu/artifacts/dsh/host/round16/core-goal-v6-receipt.json');
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.reasonCode, 'CORE_VALIDATION_EVALUATION_UNKNOWN');
  assert.equal(receipt.counters.evaluateAttempts, 1);
  assert.equal(receipt.evaluations[0].status, 'unknown');
  assert.equal(receipt.evaluations[0].reasonCode, 'CORE_EXECUTION_UNCONFIRMED');
  assert.equal(receipt.evaluations[0].usage.state, 'unknown');
  assert.equal(receipt.preStopEvaluation.reasonCode, 'CORE_EXECUTION_UNCONFIRMED');
  assert.equal(receipt.stopAction.kind, 'pause');
});

test('round17:blobcommit-v6-correction-and-clean-artifacts-stable', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const hostSource = EVIDENCE_SOURCES.find(item => item.id === 'round16-host-v6-first-model-request-empty-stream');
  assert.ok(hostSource !== undefined);
  const v6Ref = hostSource.files.find(file => file.path.endsWith('round16-bounded-core-goal-v6.json'));
  assert.ok(v6Ref !== undefined);
  assert.equal(v6Ref.blobCommit, '9d41966');
  assert.equal(v6Ref.expectedSha256, 'f451169be1b186c6045a938d8b10992db2b9890222a0f45db828b71af941a273');
  const joint = committedJsonAt<V6Joint>('9d41966', 'plugins/shiyu/artifacts/dsh/host/round16-bounded-core-goal-v6.json');
  assert.equal(joint.cachedReceipt.bytes, 70221);
  assert.match(joint.cachedReceipt.bytesSemantics, /actual committed file bytes/);
  assert.ok(joint.evidenceCorrections.some(correction => correction.id.includes('F16-R1') && correction.resolution.includes('70,221')));
  assert.ok(joint.evidenceCorrections.some(correction => correction.resolution.includes('bindingReceiptStatus absent')));
  for (const file of hostSource.files) {
    assert.equal(typeof file.expectedSha256, 'string');
    const outcome = await verifyEvidenceFileFacts(workspaceRoot, head, file);
    assert.deepEqual(outcome.issues, [], `${file.path} facts`);
    assert.equal(outcome.facts.sha256, file.expectedSha256);
  }
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-round17-blob-'));
  try {
    await symlink(join(workspaceRoot, '.git'), join(directory, '.git'));
    const target = join(directory, v6Ref.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, '{"rewritten":true}\n', 'utf8');
    assert.deepEqual((await verifyEvidenceFileFacts(directory, head, v6Ref)).issues, []);
    const wrong = await verifyEvidenceFileFacts(directory, head, { ...v6Ref, expectedSha256: '0'.repeat(64) });
    assert.ok(wrong.issues.some(issue => issue.includes('does not match expected committed blob SHA')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const cleanSource = EVIDENCE_SOURCES.find(item => item.id === 'h7-round16-clean-artifacts');
  assert.ok(cleanSource !== undefined);
  for (const file of cleanSource.files) {
    assert.equal(file.blobCommit, '40df964');
    const outcome = await verifyEvidenceFileFacts(workspaceRoot, head, file);
    assert.deepEqual(outcome.issues, [], `${file.path} clean facts`);
  }
});

test('round17:review-info-only-unmapped', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round16-review');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['independent-review-info']);
  const text = source.limitations.join(' ').toLowerCase();
  for (const needle of ['info', 'not product', 'not referenced']) assert.ok(text.includes(needle), `review limitations missing ${needle}`);
  for (const mapping of PRODUCT_EVIDENCE_MAPPINGS) assert.equal(mapping.sourceIds.includes('round16-review'), false);
  for (const module of MODULE_DEFINITIONS) assert.equal(module.evidenceSourceIds.includes('round16-review'), false);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows);
  for (const system of systems) assert.equal(system.sourceIds.includes('round16-review'), false);
});

test('round17:product-tooling-vsfl-no-upgrade', async () => {
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

test('round17:acceptance-index-cites-round16-limited', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = new Map(buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows).map(system => [system.systemId, system]));
  for (const [systemId, expected] of [
    ['SYS.3', ['runtime-context-binding-v6', 'round16-host-v6-first-model-request-empty-stream']],
    ['SYS.8', ['runtime-context-binding-v6', 'round16-host-v6-first-model-request-empty-stream']],
    ['SYS.9', ['round16-host-v6-first-model-request-empty-stream']],
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
    for (const sourceId of ['runtime-context-binding-v6', 'round16-host-v6-first-model-request-empty-stream']) {
      assert.ok(module.evidenceSourceIds.includes(sourceId), `${id} missing ${sourceId}`);
    }
  }
  for (const id of ['MOD.recovery-entry', 'MOD.state', 'MOD.persistence']) {
    assert.ok(moduleById(id)?.evidenceSourceIds.includes('round16-host-v6-first-model-request-empty-stream'), `${id} missing v6 host evidence`);
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

test('round17:clean-artifacts-source-snapshot', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h7-round16-clean-artifacts');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['offline-module']);
  const manifest = committedJsonAt<{ vcs: { head: string; dirty: boolean; dirtyEntries: number } }>(
    '40df964',
    'plugins/shiyu/artifacts/dsh/harness/manifest.json',
  );
  assert.equal(manifest.vcs.head, 'dcede28bf921fc73f68e7abebec84bb80ae33f38');
  assert.equal(manifest.vcs.dirty, false);
  assert.equal(manifest.vcs.dirtyEntries, 0);
  const traceability = committedJsonAt<{ evidenceMapping: { counts: { sources: number; verified: number; unknown: number; files: number } }; summary: { product: { total: number; covered: number; notCovered: number } } }>(
    '40df964',
    'plugins/shiyu/artifacts/dsh/harness/traceability.json',
  );
  assert.deepEqual(traceability.evidenceMapping.counts, { sources: 88, verified: 88, unknown: 0, files: 339, warnings: 0 });
  assert.deepEqual(traceability.summary.product, { total: 79, covered: 0, notCovered: 79 });
  const acceptance = committedJsonAt<{ gate: { overall: string; completeNineSystems: boolean }; summary: { denominators: { executed: number; passed: number } } }>(
    '40df964',
    'plugins/shiyu/artifacts/dsh/harness/acceptance-report.json',
  );
  assert.equal(acceptance.gate.overall, 'incomplete');
  assert.equal(acceptance.gate.completeNineSystems, false);
  assert.equal(acceptance.summary.denominators.executed, 0);
  assert.equal(acceptance.summary.denominators.passed, 0);
  for (const level of source.levels) {
    assert.equal(ALLOWED_EVIDENCE_LEVELS.includes(level), true);
    assert.equal(LIMITED_EVIDENCE_LEVELS.includes(level), true);
  }
  assert.equal((ALLOWED_EVIDENCE_LEVELS as readonly string[]).includes('pass'), false);
});

test('round17:slice-evidence-present', async () => {
  const text = await readFile(join(pluginRoot, 'artifacts/dsh/harness/h7-round17-slice.json'), 'utf8').catch(() => null);
  assert.ok(text !== null, 'h7-round17-slice.json must exist');
  const evidence = JSON.parse(text) as {
    kind: string;
    baselineHead: string;
    round16Sources: readonly (string | { readonly id: string })[];
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
  assert.equal(evidence.kind, 'shiyu.harness.h7-round17-slice-evidence');
  assert.match(evidence.baselineHead, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    evidence.round16Sources.map(item => (typeof item === 'string' ? item : item.id)).sort(),
    [...ROUND16_SOURCE_IDS].sort(),
  );
  assert.deepEqual(evidence.sourceCounts, { sources: 92, files: 368 });
  // Historical slice snapshot: hash the blobs as committed in the round-17
  // slice commit (bcb252f). Later rounds legitimately edit these harness files,
  // so a mutable-worktree comparison would turn a historical record into a
  // stale drift check; the committed snapshot is the evidence.
  for (const file of evidence.files) {
    const blob = git(['show', `bcb252f:${file.path}`], 'buffer').stdout as Buffer;
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
