/**
 * H7-round18 tests: round-17 P0 memory (readiness/embedding), emotion
 * continuation (offline + zero-model host probe), writable shared workspace and
 * provider-stream/v7 instrumentation are bound as limited diagnostic evidence;
 * nothing here can be a pass.
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
const ROUND17_SOURCE_IDS = [
  'h2d-single-user-memory-chat',
  'h2d-host-memory-embedding-verification',
  'h4f-emotion-continuation',
  'round17-host-emotion-memory-probes',
  'workspace-shared-hardlink',
  'h3-v7-stream-error-instrumentation',
  'h7-round17-clean-artifacts',
  'round17-review',
] as const;

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

test('round18:new-round17-sources-integrity-and-ancestry', async () => {
  assert.equal(EVIDENCE_SOURCES.length, 100);
  const ids = new Set(EVIDENCE_SOURCES.map(source => source.id));
  for (const id of ROUND17_SOURCE_IDS) assert.ok(ids.has(id), `missing round-17 source ${id}`);
  const newSources = EVIDENCE_SOURCES.filter(source => ROUND17_SOURCE_IDS.includes(source.id as (typeof ROUND17_SOURCE_IDS)[number]));
  assert.equal(newSources.length, 8);
  assert.equal(newSources.reduce((sum, source) => sum + source.files.length, 0), 52);
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

test('round18:h2d-memory-readiness-offline-boundary', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h2d-single-user-memory-chat');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['offline-module']);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of [
    'verified embedding',
    'semantic_search',
    'exact_read',
    'EMBEDDING_UNVERIFIED',
    'INDEX_COVERAGE_INCOMPLETE',
    '1716/1716',
    'hostKit',
    'no generation model',
    'NEVER be pass',
  ]) {
    assert.ok(text.includes(required), `h2d text missing ${required}`);
  }
  const evidence = committedJsonAt<{
    status: string;
    evidenceLevel: string;
    failures: readonly unknown[];
    verification: { isolatedWorktree: { exitCode: number; tests: number; pass: number; fail: number; skipped: number } };
    hostKit: { status: string };
    boundaries: readonly string[];
  }>('fc9daae', 'plugins/shiyu/artifacts/dsh/h2/h2d-single-user-memory-chat.json');
  assert.match(evidence.status, /离线\/集成通过/);
  assert.match(evidence.evidenceLevel, /G1/);
  assert.equal(evidence.verification.isolatedWorktree.exitCode, 0);
  assert.equal(evidence.verification.isolatedWorktree.tests, 1716);
  assert.equal(evidence.verification.isolatedWorktree.pass, 1716);
  assert.equal(evidence.verification.isolatedWorktree.fail, 0);
  assert.equal(evidence.verification.isolatedWorktree.skipped, 0);
  assert.match(evidence.hostKit.status, /待真实宿主/);
  assert.deepEqual(evidence.failures, []);
  assert.ok(evidence.boundaries.some(line => line.includes('hostKit')));
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('h2d-single-user-memory-chat'), false);
  const mapping = evaluateEvidenceMapping(report);
  for (const row of mapping.rows.filter(item => item.sources.some(src => src.id === 'h2d-single-user-memory-chat'))) {
    assert.ok(['limited-only', 'unknown'].includes(row.state));
    assert.ok(row.levels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)));
  }
});

test('round18:h2d-host-memory-embedding-never-pass', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h2d-host-memory-embedding-verification');
  assert.ok(source !== undefined);
  const sourceLevels: readonly EvidenceLevel[] = [...source.levels];
  assert.deepEqual(sourceLevels, ['offline-module', 'fixed-host-zero-model']);
  assert.equal(source.levels.includes('bounded-real-model' as EvidenceLevel), false);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of [
    'embeddingCalls=1',
    'searchEmbeddingCalls=1',
    'MEMORY_READ_FORBIDDEN',
    'INDEX_COVERAGE_INCOMPLETE',
    '+10 commitSeq',
    '546→556',
    'no generation model',
    '68173',
    'NEVER be pass',
  ]) {
    assert.ok(text.includes(required), `h2d host text missing ${required}`);
  }
  const host = committedJsonAt<{
    status: string;
    receipt: {
      ok: boolean;
      steps: readonly { step: string; status: string }[];
      embeddingCalls: number;
      searchEmbeddingCalls: number;
      usageComplete: boolean;
      matches: number;
      semanticHit: boolean;
      exactReadBodyMatched: boolean;
      postWithdrawRejected: boolean;
      postWithdrawCode: string;
      readinessBefore: { embeddingVerified: boolean; semanticReady: boolean; capabilities: readonly string[]; reason: string };
      readinessAfter: { embeddingVerified: boolean; semanticReady: boolean; capabilities: readonly string[]; reason: string };
    };
    statusFinal: { bytes: number; sha256: string; bytesSemantics: string };
    deltas: { verification: { commitSeq: readonly [number, number]; sessions: readonly [number, number]; stateFile: readonly [string, string] } };
    boundaries: readonly string[];
  }>('ab08779', 'plugins/shiyu/artifacts/dsh/h2/h2d-host-memory-embedding-verification.json');
  assert.equal(host.status, 'fixed-host-embedding-roundtrip-passed');
  assert.equal(host.receipt.ok, true);
  assert.equal(host.receipt.steps.length, 5);
  assert.ok(host.receipt.steps.every(step => step.status === 'passed'));
  assert.equal(host.receipt.embeddingCalls, 1);
  assert.equal(host.receipt.searchEmbeddingCalls, 1);
  assert.equal(host.receipt.usageComplete, true);
  assert.equal(host.receipt.matches, 1);
  assert.equal(host.receipt.semanticHit, true);
  assert.equal(host.receipt.exactReadBodyMatched, true);
  assert.equal(host.receipt.postWithdrawRejected, true);
  assert.equal(host.receipt.postWithdrawCode, 'MEMORY_READ_FORBIDDEN');
  assert.deepEqual(host.receipt.readinessBefore.capabilities, ['exact_read']);
  assert.equal(host.receipt.readinessBefore.embeddingVerified, false);
  assert.equal(host.receipt.readinessBefore.semanticReady, false);
  assert.equal(host.receipt.readinessBefore.reason, 'EMBEDDING_UNVERIFIED');
  assert.deepEqual(host.receipt.readinessAfter.capabilities, ['exact_read', 'semantic_search']);
  assert.equal(host.receipt.readinessAfter.embeddingVerified, true);
  assert.equal(host.receipt.readinessAfter.semanticReady, true);
  assert.equal(host.receipt.readinessAfter.reason, 'INDEX_COVERAGE_INCOMPLETE');
  assert.equal(host.statusFinal.bytes, 68173);
  assert.equal(host.statusFinal.sha256, '4ac9e162bcada358e0127e8b724cbef37e39cba389a0a55e63904fb418f28af6');
  assert.match(host.statusFinal.bytesSemantics, /actual committed file bytes/);
  assert.deepEqual(host.deltas.verification.commitSeq, [546, 556]);
  assert.deepEqual(host.deltas.verification.sessions, [40, 40]);
  assert.equal(host.deltas.verification.stateFile[0], host.deltas.verification.stateFile[1]);
  assert.ok(host.boundaries.some(line => line.includes('No generation model')));
  const statusFinal = git(['show', '67bf0bc:plugins/shiyu/artifacts/dsh/h2/host/status-final.json'], 'buffer').stdout as Buffer;
  assert.equal(statusFinal.byteLength, 68173);
  assert.equal(sha256Hex(statusFinal), host.statusFinal.sha256);
  for (const level of source.levels) {
    assert.equal(ALLOWED_EVIDENCE_LEVELS.includes(level), true);
    assert.equal(LIMITED_EVIDENCE_LEVELS.includes(level), true);
  }
});

test('round18:emotion-continuation-and-joint-host-probe', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h4f-emotion-continuation');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['offline-module']);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of ['1727/1727', 'read-only', 'valence/arousal', 'subjective experience', 'NEVER be pass']) {
    assert.ok(text.includes(required), `h4f text missing ${required}`);
  }
  const emotion = committedJsonAt<{
    status: string;
    verification: { isolatedWorktree: { exitCode: number; tests: number; pass: number; fail: number } };
    boundaries: readonly string[];
  }>('928c8f1', 'plugins/shiyu/artifacts/dsh/h4/h4f-emotion-continuation.json');
  assert.match(emotion.status, /离线\/集成通过/);
  assert.equal(emotion.verification.isolatedWorktree.exitCode, 0);
  assert.equal(emotion.verification.isolatedWorktree.tests, 1727);
  assert.equal(emotion.verification.isolatedWorktree.pass, 1727);
  assert.equal(emotion.verification.isolatedWorktree.fail, 0);
  assert.ok(emotion.boundaries.some(line => line.includes('主观情绪体验')));
  const jointSource = EVIDENCE_SOURCES.find(item => item.id === 'round17-host-emotion-memory-probes');
  assert.ok(jointSource !== undefined);
  const jointLevels: readonly EvidenceLevel[] = [...jointSource.levels];
  assert.deepEqual(jointLevels, ['fixed-host-zero-model']);
  const joint = committedJsonAt<{
    status: string;
    emotionProbe: {
      status: string;
      checks: number;
      checksPassed: number;
      zeroModel: boolean;
      zeroEmbedding: boolean;
      liveDataTouched: boolean;
      store: string;
      disclosure: { subjectiveExperience: boolean; longTermPersonality: boolean; modelSelfReportAuthority: string; ombrePulseTreatedAsEmotion: boolean };
      cleanup: { storeClosed: boolean; workerTerminated: boolean };
      receipt: { bytes: number; sha256: string };
    };
    memoryRoundTrip: {
      ok: boolean;
      embeddingCalls: number;
      searchEmbeddingCalls: number;
      matches: number;
      semanticHit: boolean;
      postWithdrawCode: string;
      receipt: { bytes: number; sha256: string };
    };
    reload: { commitSeq: readonly [number, number] };
    probes: { commitSeq: readonly [number, number] };
    sideEffects: { syntheticMemories: number };
  }>('928c8f1', 'plugins/shiyu/artifacts/dsh/host/round17-joint-emotion-memory.json');
  assert.equal(joint.status, 'fixed-host-zero-model-emotion-and-memory-passed');
  assert.equal(joint.emotionProbe.status, 'passed');
  assert.equal(joint.emotionProbe.checks, 15);
  assert.equal(joint.emotionProbe.checksPassed, 15);
  assert.equal(joint.emotionProbe.zeroModel, true);
  assert.equal(joint.emotionProbe.zeroEmbedding, true);
  assert.equal(joint.emotionProbe.liveDataTouched, false);
  assert.equal(joint.emotionProbe.store, 'in-memory');
  assert.deepEqual(joint.emotionProbe.disclosure, {
    subjectiveExperience: false,
    longTermPersonality: false,
    modelSelfReportAuthority: 'none',
    ombrePulseTreatedAsEmotion: false,
  });
  assert.equal(joint.emotionProbe.cleanup.storeClosed, true);
  assert.equal(joint.emotionProbe.cleanup.workerTerminated, true);
  assert.equal(joint.memoryRoundTrip.ok, true);
  assert.equal(joint.memoryRoundTrip.embeddingCalls, 1);
  assert.equal(joint.memoryRoundTrip.searchEmbeddingCalls, 1);
  assert.equal(joint.memoryRoundTrip.matches, 1);
  assert.equal(joint.memoryRoundTrip.semanticHit, true);
  assert.equal(joint.memoryRoundTrip.postWithdrawCode, 'MEMORY_READ_FORBIDDEN');
  assert.deepEqual(joint.reload.commitSeq, [556, 563]);
  assert.deepEqual(joint.probes.commitSeq, [563, 573]);
  assert.equal(joint.sideEffects.syntheticMemories, 3);
  const emotionReceipt = git(['show', '928c8f1:plugins/shiyu/artifacts/dsh/host/round17/emotion-probe-receipt.json'], 'buffer').stdout as Buffer;
  assert.equal(emotionReceipt.byteLength, joint.emotionProbe.receipt.bytes);
  assert.equal(sha256Hex(emotionReceipt), joint.emotionProbe.receipt.sha256);
  const memoryReceipt = git(['show', '928c8f1:plugins/shiyu/artifacts/dsh/host/round17/memory-embedding-receipt.json'], 'buffer').stdout as Buffer;
  assert.equal(memoryReceipt.byteLength, joint.memoryRoundTrip.receipt.bytes);
  assert.equal(sha256Hex(memoryReceipt), joint.memoryRoundTrip.receipt.sha256);
  for (const level of jointSource.levels) {
    assert.equal(ALLOWED_EVIDENCE_LEVELS.includes(level), true);
    assert.equal(LIMITED_EVIDENCE_LEVELS.includes(level), true);
  }
  assert.equal((ALLOWED_EVIDENCE_LEVELS as readonly string[]).includes('pass'), false);
});

test('round18:workspace-shared-hardlink-offline-boundary', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'workspace-shared-hardlink');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['offline-module']);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of ['FILE HARD LINKS', 'in-place', 'owner decision', 'runtimeWired=false', '1715/1715', '11/11', 'NEVER be pass']) {
    assert.ok(text.includes(required), `workspace text missing ${required}`);
  }
  const ws = committedJsonAt<{
    evidenceLevel: string;
    summary: { total: number; passed: number; failed: number };
    boundaries: { liveHost: boolean; modelCalls: number; realWorkspaceTouched: boolean; runtimeWired: boolean };
    disclosure: {
      inPlaceWritesPropagateToSharedSource: boolean;
      mirrorUsesFileHardLinksOnly: boolean;
      symlinkAndExternalHardlinkRejected: boolean;
      deleteSharedRequiresExplicitOwnerDecision: boolean;
      artifactsPathUnchanged: boolean;
    };
    verification: { runs: { final: { exitCode: number; counts: { tests: number } } } };
    evidenceCorrections: readonly { id: string; finding: string; resolution: string }[];
  }>('ab08779', 'plugins/shiyu/artifacts/dsh/tasks/workspace-shared-hardlink.json');
  assert.match(ws.evidenceLevel, /G1 offline filesystem module/);
  assert.deepEqual(ws.summary, { total: 11, passed: 11, failed: 0 });
  assert.equal(ws.boundaries.liveHost, false);
  assert.equal(ws.boundaries.modelCalls, 0);
  assert.equal(ws.boundaries.realWorkspaceTouched, false);
  assert.equal(ws.boundaries.runtimeWired, false);
  assert.equal(ws.disclosure.inPlaceWritesPropagateToSharedSource, true);
  assert.equal(ws.disclosure.mirrorUsesFileHardLinksOnly, true);
  assert.equal(ws.disclosure.symlinkAndExternalHardlinkRejected, true);
  assert.equal(ws.disclosure.deleteSharedRequiresExplicitOwnerDecision, true);
  assert.equal(ws.disclosure.artifactsPathUnchanged, true);
  assert.equal(ws.verification.runs.final.exitCode, 0);
  assert.equal(ws.verification.runs.final.counts.tests, 1715);
  assert.ok(ws.evidenceCorrections.some(correction => correction.id === 'F17-R2'));
});

test('round18:v7-stream-instrumentation-not-executed', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'h3-v7-stream-error-instrumentation');
  assert.ok(source !== undefined);
  const sourceLevels: readonly EvidenceLevel[] = [...source.levels];
  assert.deepEqual(sourceLevels, ['offline-module', 'slice-verification']);
  const text = `${source.scope} ${source.limitations.join(' ')}`;
  for (const required of [
    'empty-provider-stream',
    'transport',
    'auth',
    'request-shape',
    'timeout',
    '[v1..v7]',
    'NOT executed',
    'seventh attempt is NOT authorized',
    '1710/1710',
    'NEVER be pass',
  ]) {
    assert.ok(text.includes(required), `v7 text missing ${required}`);
  }
  const v7 = committedJsonAt<{
    status: string;
    realModelExecutedByImplementer: boolean;
    hostReloadsByImplementer: number;
    realGoalCreatedByImplementer: boolean;
    realGoalCancelledByImplementer: boolean;
    instrumentation: { streamDiagnostic: { categories: Record<string, string> } };
    experimentV7: { requestId: string; version: number };
    reconcile: { fixedTargets: readonly string[] };
    tests: { netNew: number };
    failures: readonly unknown[];
  }>('fa9e880', 'plugins/shiyu/artifacts/dsh/h3/h3-v7-stream-error-instrumentation.json');
  assert.match(v7.status, /offline instrumentation preparation/);
  assert.equal(v7.realModelExecutedByImplementer, false);
  assert.equal(v7.hostReloadsByImplementer, 0);
  assert.equal(v7.realGoalCreatedByImplementer, false);
  assert.equal(v7.realGoalCancelledByImplementer, false);
  assert.equal(v7.experimentV7.requestId, 'core-validation-frozen-v7');
  assert.equal(v7.experimentV7.version, 7);
  assert.deepEqual(v7.reconcile.fixedTargets, [
    'core-validation-frozen-v1',
    'core-validation-frozen-v2',
    'core-validation-frozen-v3',
    'core-validation-frozen-v4',
    'core-validation-frozen-v5',
    'core-validation-frozen-v6',
    'core-validation-frozen-v7',
  ]);
  assert.equal(v7.tests.netNew, 8);
  assert.deepEqual(v7.failures, []);
  for (const category of ['empty-provider-stream', 'transport', 'auth', 'request-shape', 'timeout', 'aborted', 'unknown']) {
    assert.ok(category in v7.instrumentation.streamDiagnostic.categories, `missing stream category ${category}`);
  }
  const slice = committedJsonAt<{
    kind: string;
    verdict: string;
    check: { exitCode: number; tests: { tests: number; pass: number; fail: number; skipped: number } };
  }>('bcb252f', 'plugins/shiyu/artifacts/dsh/slices/h3-v7-stream-error-verify.json');
  assert.equal(slice.kind, 'isolated-slice-verification');
  assert.equal(slice.verdict, 'pass');
  assert.equal(slice.check.exitCode, 0);
  assert.equal(slice.check.tests.tests, 1710);
  assert.equal(slice.check.tests.pass, 1710);
  assert.equal(slice.check.tests.fail, 0);
  assert.equal(slice.check.tests.skipped, 0);
  const v25 = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === 'V25');
  assert.ok(v25 !== undefined);
  assert.equal(v25.sourceIds.includes('h3-v7-stream-error-instrumentation'), false);
});

test('round18:review-info-only-unmapped', async () => {
  const source = EVIDENCE_SOURCES.find(item => item.id === 'round17-review');
  assert.ok(source !== undefined);
  assert.deepEqual(source.levels, ['independent-review-info']);
  const text = source.limitations.join(' ').toLowerCase();
  for (const needle of ['info', 'not product', 'not referenced']) assert.ok(text.includes(needle), `review limitations missing ${needle}`);
  for (const mapping of PRODUCT_EVIDENCE_MAPPINGS) assert.equal(mapping.sourceIds.includes('round17-review'), false);
  for (const module of MODULE_DEFINITIONS) assert.equal(module.evidenceSourceIds.includes('round17-review'), false);
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows);
  for (const system of systems) assert.equal(system.sourceIds.includes('round17-review'), false);
});

test('round18:product-tooling-vsfl-no-upgrade', async () => {
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

test('round18:acceptance-index-cites-round17-limited', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const { report } = await verifyEvidenceSources(workspaceRoot, head);
  const systems = new Map(buildSystemEvidenceSummaries(evaluateEvidenceMapping(report).rows).map(system => [system.systemId, system]));
  for (const [systemId, expected] of [
    ['SYS.3', ['h3-v7-stream-error-instrumentation']],
    ['SYS.8', ['h2d-single-user-memory-chat', 'h2d-host-memory-embedding-verification', 'h4f-emotion-continuation', 'workspace-shared-hardlink', 'round17-host-emotion-memory-probes']],
    ['SYS.9', ['h2d-host-memory-embedding-verification', 'round17-host-emotion-memory-probes']],
  ] as const) {
    const system = systems.get(systemId);
    assert.ok(system !== undefined);
    for (const id of expected) assert.ok(system.sourceIds.includes(id), `${systemId} missing ${id}`);
    assert.equal(system.row?.state, 'limited-only');
  }
  const moduleById = (id: string) => MODULE_DEFINITIONS.find(module => module.id === id);
  for (const id of ['MOD.core', 'MOD.tool-policy', 'MOD.recovery-entry', 'MOD.lifecycle']) {
    const module = moduleById(id);
    assert.ok(module !== undefined);
    for (const sourceId of ['h3-v7-stream-error-instrumentation']) {
      assert.ok(module.evidenceSourceIds.includes(sourceId), `${id} missing ${sourceId}`);
    }
  }
  for (const [id, sourceId] of [
    ['MOD.memory', 'h2d-host-memory-embedding-verification'],
    ['MOD.memory', 'round17-host-emotion-memory-probes'],
    ['MOD.emotion', 'h4f-emotion-continuation'],
    ['MOD.emotion', 'round17-host-emotion-memory-probes'],
    ['MOD.views', 'h2d-host-memory-embedding-verification'],
    ['MOD.artifacts', 'workspace-shared-hardlink'],
    ['MOD.lifecycle', 'round17-host-emotion-memory-probes'],
    ['MOD.state', 'workspace-shared-hardlink'],
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

test('round18:blobcommit-f17-corrections-stable', async () => {
  const head = git(['rev-parse', 'HEAD']).stdout.toString().trim();
  const newSources = EVIDENCE_SOURCES.filter(source => ROUND17_SOURCE_IDS.includes(source.id as (typeof ROUND17_SOURCE_IDS)[number]));
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
    ['h2d-host-memory-embedding-verification', 'plugins/shiyu/artifacts/dsh/h2/h2d-host-memory-embedding-verification.json', 'ab08779'],
    ['workspace-shared-hardlink', 'plugins/shiyu/artifacts/dsh/tasks/workspace-shared-hardlink.json', 'ab08779'],
    ['h4f-emotion-continuation', 'plugins/shiyu/artifacts/dsh/h4/h4f-emotion-continuation.json', '928c8f1'],
    ['h3-v7-stream-error-instrumentation', 'plugins/shiyu/artifacts/dsh/slices/h3-v7-stream-error-verify.json', 'bcb252f'],
  ];
  for (const [sourceId, path, blobCommit] of corrected) {
    const source = newSources.find(item => item.id === sourceId);
    assert.ok(source !== undefined);
    const file = source.files.find(item => item.path === path);
    assert.ok(file !== undefined, `${sourceId} missing ${path}`);
    assert.equal(file.blobCommit, blobCommit);
  }
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-round18-blob-'));
  try {
    await symlink(join(workspaceRoot, '.git'), join(directory, '.git'));
    const ref = EVIDENCE_SOURCES.find(item => item.id === 'h2d-host-memory-embedding-verification')?.files.find(file => file.path.endsWith('h2d-host-memory-embedding-verification.json'));
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
  const host = committedJsonAt<{ statusFinal: { bytes: number; bytesSemantics: string } }>(
    'ab08779',
    'plugins/shiyu/artifacts/dsh/h2/h2d-host-memory-embedding-verification.json',
  );
  assert.equal(host.statusFinal.bytes, 68173);
  assert.match(host.statusFinal.bytesSemantics, /actual committed file bytes/);
  const ws = committedJsonAt<{ evidenceCorrections: readonly { id: string; resolution: string }[] }>(
    'ab08779',
    'plugins/shiyu/artifacts/dsh/tasks/workspace-shared-hardlink.json',
  );
  assert.ok(ws.evidenceCorrections.every(correction => correction.id === 'F17-R2'));
  assert.ok(ws.evidenceCorrections.some(correction => correction.resolution.includes('self')));
});

test('round18:slice-evidence-present', async () => {
  const text = await readFile(join(pluginRoot, 'artifacts/dsh/harness/h7-round18-slice.json'), 'utf8').catch(() => null);
  assert.ok(text !== null, 'h7-round18-slice.json must exist');
  const evidence = JSON.parse(text) as {
    kind: string;
    baselineHead: string;
    round17Sources: readonly (string | { readonly id: string })[];
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
  assert.equal(evidence.kind, 'shiyu.harness.h7-round18-slice-evidence');
  assert.match(evidence.baselineHead, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    evidence.round17Sources.map(item => (typeof item === 'string' ? item : item.id)).sort(),
    [...ROUND17_SOURCE_IDS].sort(),
  );
  assert.deepEqual(evidence.sourceCounts, { sources: 100, files: 420 });
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
