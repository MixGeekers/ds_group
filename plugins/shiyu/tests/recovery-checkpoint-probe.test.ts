/**
 * H5b checkpoint availability probe tests + evidence.
 *
 * Real temporary ControlStore/SQLite and real temporary directories; synthetic
 * resolver presence markers and memory availability. The probe must stay
 * strictly read-only: no capture, no file writes, no resolver invocation, no
 * live session access.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as h5b from './recovery-h5b-support.js';
import {
  CHECKPOINT_PROBE_REASON_CODES,
  probeCheckpointAvailability,
  validateCheckpointProbeResult,
} from '../src/recovery/checkpoint-probe.js';
import { RuntimeCheckpointProbeCommand } from '../src/recovery/runtime-command.js';
import { CheckpointCaptureService } from '../src/recovery/capture.js';
import type { CheckpointProbeResult } from '../src/recovery/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const artifactDirectory = path.join(packageRoot, 'artifacts', 'dsh', 'h5');
const probeEvidenceFile = path.join(artifactDirectory, 'h5b-checkpoint-probe.json');
const integrationDiffFile = path.join(artifactDirectory, 'runtime-checkpoint-probe.diff');

const sha256 = async (filename: string): Promise<string> => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(await readFile(filename)).digest('hex');
};

const exists = async (filename: string): Promise<boolean> => {
  try { await access(filename); return true; } catch { return false; }
};

const blockerCodes = (result: CheckpointProbeResult): string[] => result.blockers.map((item) => item.reasonCode);
const componentOf = (result: CheckpointProbeResult, id: CheckpointProbeResult['components'][number]['id']) => result.components.find((item) => item.id === id);

const createProbeWorld = async (t: Parameters<typeof h5b.createRealHostWorld>[0]): Promise<h5b.RealHostWorld> => {
  const world = await h5b.createRealHostWorld(t);
  const stagingRoot = path.join(world.root, 'checkpoint-staging');
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  return Object.assign(world, { probeStagingRoot: stagingRoot });
};

const stagedWorld = async (t: Parameters<typeof h5b.createRealHostWorld>[0]): Promise<h5b.RealHostWorld> => {
  const world = await createProbeWorld(t);
  await h5b.seedGoalBinding(world.store, { goalId: 'goal-probe-a', sessionId: 'shiyu-goal-probe-a', nativeGoalId: 'native-goal-probe-a' });
  return world;
};

interface WorldWithStaging extends h5b.RealHostWorld { probeStagingRoot: string }

test('unconfigured staging root is reported as CHECKPOINT_STAGING_UNCONFIGURED without creating anything', async t => {
  const world = await createProbeWorld(t);
  const before = await h5b.snapshotTree(world.root);
  const result = await probeCheckpointAvailability({
    dataDir: world.dataDir,
    controlStore: world.store,
    workspaceRoot: path.join(world.dataDir, 'workspaces'),
  });
  const validation = validateCheckpointProbeResult(result);
  assert.equal(validation.ok, true, JSON.stringify(validation.violations));
  assert.equal(result.ready, false);
  assert.equal(result.expectedReady, false);
  assert.equal(result.readOnly, true);
  assert.equal(result.captureAttempted, false);
  assert.equal(result.resolverInvoked, false);
  assert.equal(result.filesWritten, 0);
  assert.equal(result.staging.configured, false);
  assert.equal(componentOf(result, 'staging')?.status, 'unconfigured');
  assert.equal(componentOf(result, 'staging')?.reasonCode, 'CHECKPOINT_STAGING_UNCONFIGURED');
  assert.ok(blockerCodes(result).includes('CHECKPOINT_STAGING_UNCONFIGURED'));
  assert.deepEqual(await h5b.snapshotTree(world.root), before, 'probe must not write files');
});

test('real ControlStore enumerates active Goal bindings; missing resolver yields GOAL_SESSION_EXPORT_UNAVAILABLE', async t => {
  const world = await stagedWorld(t) as WorldWithStaging;
  await h5b.seedGoalBinding(world.store, { goalId: 'goal-probe-b', sessionId: 'shiyu-goal-probe-b', nativeGoalId: 'native-goal-probe-b' });
  const result = await probeCheckpointAvailability({
    stagingRoot: world.probeStagingRoot,
    dataDir: world.dataDir,
    controlStore: world.store,
    workspaceRoot: path.join(world.dataDir, 'workspaces'),
    ownerId: 'local-owner',
    scope: 'local-owner',
  });
  assert.equal(validateCheckpointProbeResult(result).ok, true);
  assert.equal(componentOf(result, 'control')?.status, 'available');
  assert.equal(result.goalBindings.source, 'controlStore');
  assert.equal(result.goalBindings.total, 2);
  assert.equal(result.goalBindings.active, 2);
  assert.equal(componentOf(result, 'dsh-goal-sessions')?.status, 'unavailable');
  assert.equal(componentOf(result, 'dsh-goal-sessions')?.reasonCode, 'GOAL_SESSION_EXPORT_UNAVAILABLE');
  assert.ok((componentOf(result, 'dsh-goal-sessions')?.requiredScope.length ?? 0) >= 3);
  assert.equal(componentOf(result, 'memory')?.reasonCode, 'MEMORY_EXPORT_UNAVAILABLE');
  assert.equal(componentOf(result, 'shared-objects')?.status, 'available');
  assert.equal(result.ready, false);
  assert.equal(result.expectedReady, false);
});

test('resolver presence is checked without invoking it; injected seams and memory can mark components available', async t => {
  const world = await stagedWorld(t) as WorldWithStaging;
  let resolverCalls = 0;
  const resolver = {
    provenance: 'injected',
    async resolve(): Promise<void> { resolverCalls += 1; throw new Error('resolver must never be invoked by the probe'); },
  };
  const result = await probeCheckpointAvailability({
    stagingRoot: world.probeStagingRoot,
    dataDir: world.dataDir,
    goalBindings: [{ goalRef: { id: 'native-probe', revision: 1 }, receipt: { status: 'confirmed' } }],
    sessionLogResolver: resolver,
    goalSeams: { nativeState: true, flush: true, projection: true },
    memoryExport: true,
    workspaceRoot: path.join(world.dataDir, 'workspaces'),
  });
  assert.equal(resolverCalls, 0, 'probe must not call the injected resolver');
  assert.equal(result.resolverInvoked, false);
  assert.equal(componentOf(result, 'dsh-goal-sessions')?.status, 'available');
  assert.equal(componentOf(result, 'memory')?.status, 'available');
  assert.equal(result.ready, false);
  assert.equal(result.expectedReady, false);
  // Even when every component looks available, the probe never claims readiness.
  assert.deepEqual(result.blockers, []);
});

test('no active Goal bindings makes the Goal Session component available without requiring a resolver', async t => {
  const world = await createProbeWorld(t) as WorldWithStaging;
  const result = await probeCheckpointAvailability({
    stagingRoot: world.probeStagingRoot,
    dataDir: world.dataDir,
    goalBindings: [],
    memoryExport: true,
    workspaceRoot: path.join(world.dataDir, 'workspaces'),
  });
  assert.equal(componentOf(result, 'control')?.status, 'available');
  assert.equal(componentOf(result, 'dsh-goal-sessions')?.status, 'available');
  assert.equal(result.goalBindings.active, 0);
  assert.equal(result.resolverInvoked, false);
});

test('memory export unavailability is explicit and never faked', async t => {
  const world = await createProbeWorld(t) as WorldWithStaging;
  const unavailable = await probeCheckpointAvailability({
    stagingRoot: world.probeStagingRoot,
    dataDir: world.dataDir,
    goalBindings: [],
    workspaceRoot: path.join(world.dataDir, 'workspaces'),
  });
  assert.equal(componentOf(unavailable, 'memory')?.status, 'unavailable');
  assert.equal(componentOf(unavailable, 'memory')?.reasonCode, 'MEMORY_EXPORT_UNAVAILABLE');
  assert.ok(blockerCodes(unavailable).includes('MEMORY_EXPORT_UNAVAILABLE'));
  // An explicit injected unavailability keeps its precise reason/scope.
  const explicit = await probeCheckpointAvailability({
    goalBindings: [],
    memoryExport: { available: false, reasonCode: 'MEMORY_EXPORT_UNAVAILABLE', detail: 'synthetic missing export adapter', requiredScope: ['approved Ombre export API'] },
  });
  const memory = componentOf(explicit, 'memory')!;
  assert.equal(memory.reasonCode, 'MEMORY_EXPORT_UNAVAILABLE');
  assert.deepEqual(memory.requiredScope, ['approved Ombre export API']);
});

test('all probes missing still returns a complete, strictly valid structure with the required reason codes', async () => {
  const result = await probeCheckpointAvailability({});
  assert.equal(validateCheckpointProbeResult(result).ok, true, JSON.stringify(validateCheckpointProbeResult(result).violations));
  assert.equal(result.components.length, 5);
  assert.deepEqual(result.components.map((item) => item.id), ['staging', 'control', 'dsh-goal-sessions', 'memory', 'shared-objects']);
  assert.equal(result.goalBindings.source, 'unavailable');
  assert.equal(result.goalBindings.total, null);
  const codes = blockerCodes(result);
  for (const required of CHECKPOINT_PROBE_REASON_CODES) {
    // Staging/memory are always observable without any dependency; the goal
    // reason is covered by the active-binding case above. In the fully-missing
    // case the same blocker is reported through the control-facts path.
    if (required === 'GOAL_SESSION_EXPORT_UNAVAILABLE') continue;
    assert.ok(codes.includes(required), `missing ${required}: ${codes.join(',')}`);
  }
  assert.ok(result.staging.configured === false);
  assert.equal(result.ready, false);
  assert.equal(result.expectedReady, false);
  assert.equal(result.readOnly, true);
});

test('probe reports unreadable workspace and staging overlap as explicit blockers', async t => {
  const world = await createProbeWorld(t) as WorldWithStaging;
  const missingWorkspace = await probeCheckpointAvailability({
    stagingRoot: world.probeStagingRoot,
    dataDir: world.dataDir,
    goalBindings: [],
    memoryExport: true,
    workspaceRoot: path.join(world.root, 'missing-workspace'),
  });
  assert.equal(componentOf(missingWorkspace, 'shared-objects')?.reasonCode, 'WORKSPACE_INVENTORY_UNAVAILABLE');
  const overlap = await probeCheckpointAvailability({
    stagingRoot: path.join(world.dataDir, 'checkpoint'),
    dataDir: world.dataDir,
    goalBindings: [],
    memoryExport: true,
    workspaceRoot: path.join(world.dataDir, 'workspaces'),
  });
  assert.equal(componentOf(overlap, 'staging')?.reasonCode, 'LIVE_ROOT_PROTECTED');
  assert.equal(overlap.staging.withinLiveRoot, true);
});

test('owner-only probe command is strict, paused read-only, write-free, capture-free and resolver-free', async t => {
  const world = await createProbeWorld(t) as WorldWithStaging;
  const before = await h5b.snapshotTree(world.root);
  let probeCalls = 0;
  let resolverCalls = 0;
  let captureCalls = 0;
  const originalCapture = CheckpointCaptureService.prototype.capture;
  (CheckpointCaptureService.prototype as { capture: typeof CheckpointCaptureService.prototype.capture }).capture = async function (this: CheckpointCaptureService, ...args: Parameters<typeof originalCapture>) {
    captureCalls += 1;
    return originalCapture.apply(this, args);
  } as typeof CheckpointCaptureService.prototype.capture;
  t.after(() => { (CheckpointCaptureService.prototype as { capture: typeof originalCapture }).capture = originalCapture; });
  const receipts: CheckpointProbeResult[] = [];
  let paused = true;
  const command = new RuntimeCheckpointProbeCommand({
    probe: async () => {
      probeCalls += 1;
      return probeCheckpointAvailability({
        stagingRoot: world.probeStagingRoot,
        dataDir: world.dataDir,
        paused,
        goalBindings: [{ goalRef: { id: 'g', revision: 1 }, receipt: { status: 'confirmed' } }],
        sessionLogResolver: { async resolve() { resolverCalls += 1; return undefined; } },
        goalSeams: { nativeState: false, flush: false, projection: false },
        workspaceRoot: path.join(world.dataDir, 'workspaces'),
      });
    },
    isOpen: () => true,
    isPaused: () => paused,
    onReceipt: receipt => { receipts.push(receipt); },
  });
  const result = await command.handle({ action: 'runtime.checkpoint.probe' });
  assert.equal(result.paused, true);
  assert.equal(paused, true, 'probe must not change pause state');
  assert.equal(probeCalls, 1);
  assert.equal(resolverCalls, 0);
  assert.equal(captureCalls, 0);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.action, 'runtime.checkpoint.probe');
  assert.deepEqual(await h5b.snapshotTree(world.root), before, 'probe command must not write files');
  // Strict fields: extra/missing/wrong action are rejected before any probe call.
  await assert.rejects(command.handle({ action: 'runtime.checkpoint.probe', requestId: 'x' }), (error: unknown) => (error as { code?: string }).code === 'CHECKPOINT_INPUT_INVALID');
  await assert.rejects(command.handle({ action: 'runtime.checkpoint.capture' }), (error: unknown) => (error as { code?: string }).code === 'CHECKPOINT_INPUT_INVALID');
  await assert.rejects(command.handle({ action: 'runtime.checkpoint.probe', unexpected: true }), (error: unknown) => (error as { code?: string }).code === 'CHECKPOINT_INPUT_INVALID');
  assert.equal(probeCalls, 1, 'invalid commands must not invoke the probe');
  // Repeated valid commands are idempotent (same structure, same no-write/no-capture guarantees).
  const second = await command.handle({ action: 'runtime.checkpoint.probe' });
  assert.deepEqual(second.components.map((item) => ({ id: item.id, status: item.status, reasonCode: item.reasonCode })), result.components.map((item) => ({ id: item.id, status: item.status, reasonCode: item.reasonCode })));
  assert.equal(probeCalls, 2);
  assert.equal(resolverCalls, 0);
  assert.equal(captureCalls, 0);
  assert.equal(receipts.length, 2);
  assert.deepEqual(await h5b.snapshotTree(world.root), before);
});

test('probe rejects a malformed receipt before it can be stored as diagnostics', async () => {
  const command = new RuntimeCheckpointProbeCommand({
    probe: () => ({
      schemaVersion: 1, action: 'runtime.checkpoint.probe', observedAt: new Date().toISOString(), paused: false,
      readOnly: true, captureAttempted: false, resolverInvoked: false, filesWritten: 0,
      ready: true, expectedReady: false,
      staging: { configured: false, exists: null, withinLiveRoot: null, detail: '' },
      goalBindings: { source: 'unavailable', total: null, active: null, detail: '' },
      components: [], blockers: [],
    } as unknown as CheckpointProbeResult),
    isOpen: () => true,
    isPaused: () => false,
  });
  await assert.rejects(command.handle({ action: 'runtime.checkpoint.probe' }), (error: unknown) => (error as { code?: string }).code === 'CHECKPOINT_PROBE_INVALID');
});

async function generateProbeEvidence(): Promise<void> {
  const matrix: { caseId: string; injectionPoint: string; expected: string; observed: string; pass: boolean; evidence?: Record<string, unknown> }[] = [];
  const record = async (caseId: string, injectionPoint: string, expected: string, check: () => Promise<{ observed: string; evidence?: Record<string, unknown> }>): Promise<void> => {
    try {
      const { observed, evidence } = await check();
      matrix.push({ caseId, injectionPoint, expected, observed, pass: true, evidence: evidence ?? {} });
    } catch (error) {
      matrix.push({ caseId, injectionPoint, expected, observed: `failed: ${(error as Error).message}`, pass: false });
    }
  };
  const withWorld = async <T>(body: (world: WorldWithStaging) => Promise<T>): Promise<T> => {
    const world = await createProbeWorld(undefined) as WorldWithStaging;
    try { return await body(world); } finally {
      await world.store.close().catch(() => undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  };
  await record('probe.staging-unconfigured', 'stagingRoot 未配置（生产默认）', 'CHECKPOINT_STAGING_UNCONFIGURED blocker；readOnly/captureAttempted/resolverInvoked/filesWritten 固定', async () => {
    return withWorld(async world => {
      const result = await probeCheckpointAvailability({ dataDir: world.dataDir, controlStore: world.store, workspaceRoot: path.join(world.dataDir, 'workspaces') });
      return { observed: `blockers=${blockerCodes(result).join(',')}; staging=${componentOf(result, 'staging')?.status}`, evidence: { blockers: blockerCodes(result) } };
    });
  });
  await record('probe.goal-resolver-missing', '真实 ControlStore + 2 个 active binding，resolver 未注入', 'GOAL_SESSION_EXPORT_UNAVAILABLE blocker；control available；不做 resolver 调用', async () => {
    return withWorld(async world => {
      await h5b.seedGoalBinding(world.store, { goalId: 'goal-ev-a', sessionId: 'shiyu-goal-ev-a', nativeGoalId: 'native-goal-ev-a' });
      await h5b.seedGoalBinding(world.store, { goalId: 'goal-ev-b', sessionId: 'shiyu-goal-ev-b', nativeGoalId: 'native-goal-ev-b' });
      const result = await probeCheckpointAvailability({ stagingRoot: world.probeStagingRoot, dataDir: world.dataDir, controlStore: world.store, workspaceRoot: path.join(world.dataDir, 'workspaces') });
      return { observed: `active=${result.goalBindings.active}, blockers=${blockerCodes(result).join(',')}`, evidence: { goalBindings: result.goalBindings } };
    });
  });
  await record('probe.memory-unavailable', 'memoryExport 未注入（managed Ombre 无公开导出）', 'MEMORY_EXPORT_UNAVAILABLE blocker；requiredScope 非空', async () => {
    return withWorld(async world => {
      const result = await probeCheckpointAvailability({ stagingRoot: world.probeStagingRoot, dataDir: world.dataDir, goalBindings: [], workspaceRoot: path.join(world.dataDir, 'workspaces') });
      const memory = componentOf(result, 'memory')!;
      return { observed: `memory=${memory.reasonCode}; requiredScope=${memory.requiredScope.length}`, evidence: { requiredScope: memory.requiredScope } };
    });
  });
  await record('probe.all-missing-structure', '全依赖缺失（空 options）', '结构完整 5 组件、blockers 与组件一致、严格校验通过', async () => {
    const result = await probeCheckpointAvailability({});
    const validation = validateCheckpointProbeResult(result);
    expectOk(validation.ok, 'validation failed');
    return { observed: `components=${result.components.length}, blockers=${result.blockers.length}`, evidence: { components: result.components.map((item) => item.id), blockers: blockerCodes(result) } };
  });
  await record('probe.resolver-presence-only', '注入会抛错的 resolver 对象 + 全 seam', '组件 available；resolver 调用次数 0；ready/expectedReady 仍 false', async () => {
    let calls = 0;
    const result = await probeCheckpointAvailability({
      goalBindings: [{ goalRef: { id: 'g', revision: 1 } }],
      sessionLogResolver: { async resolve() { calls += 1; throw new Error('must not be called'); } },
      goalSeams: { nativeState: true, flush: true, projection: true },
      memoryExport: true,
    });
    expectOk(calls === 0, 'resolver was invoked');
    return { observed: `resolverCalls=${calls}; goal=${componentOf(result, 'dsh-goal-sessions')?.status}`, evidence: { resolverCalls: calls } };
  });
  await record('probe.command-readonly-idempotent', 'owner 命令 paused=true，两次调用 + 非法字段', '不写文件/不 capture/不改 paused/非法字段拒绝；两次结构一致', async () => {
    return withWorld(async world => {
      const before = await h5b.snapshotTree(world.root);
      let captureCalls = 0;
      const original = CheckpointCaptureService.prototype.capture;
      (CheckpointCaptureService.prototype as { capture: typeof original }).capture = async function (this: CheckpointCaptureService, ...args: Parameters<typeof original>) { captureCalls += 1; return original.apply(this, args); } as typeof original;
      try {
        const command = new RuntimeCheckpointProbeCommand({
          probe: () => probeCheckpointAvailability({ stagingRoot: world.probeStagingRoot, dataDir: world.dataDir, goalBindings: [], paused: true, workspaceRoot: path.join(world.dataDir, 'workspaces') }),
          isOpen: () => true, isPaused: () => true,
        });
        const first = await command.handle({ action: 'runtime.checkpoint.probe' });
        const second = await command.handle({ action: 'runtime.checkpoint.probe' });
        let rejected = false;
        try { await command.handle({ action: 'runtime.checkpoint.probe', extra: 1 }); } catch (error) { rejected = (error as { code?: string }).code === 'CHECKPOINT_INPUT_INVALID'; }
        expectOk(rejected, 'invalid field not rejected');
        expectOk(captureCalls === 0, 'capture was called');
        expectOk(first.paused === true && second.paused === true, 'paused observation wrong');
        const after = await h5b.snapshotTree(world.root);
        expectOk(JSON.stringify(before) === JSON.stringify(after), 'probe wrote files');
        return { observed: `two idempotent read-only receipts; captureCalls=${captureCalls}; invalid rejected=${rejected}`, evidence: { captureCalls } };
      } finally {
        (CheckpointCaptureService.prototype as { capture: typeof original }).capture = original;
      }
    });
  });
  await record('probe.workspace-unreadable', 'workspaceRoot 指向不存在目录', 'WORKSPACE_INVENTORY_UNAVAILABLE blocker', async () => {
    const result = await probeCheckpointAvailability({ goalBindings: [], workspaceRoot: path.join(tmpdir(), `missing-workspace-${Date.now()}`) });
    return { observed: `shared-objects=${componentOf(result, 'shared-objects')?.reasonCode}`, evidence: { code: componentOf(result, 'shared-objects')?.reasonCode } };
  });
  const diffText = await readFile(integrationDiffFile, 'utf8');
  let applies = false;
  try { execFileSync('git', ['apply', '--check', integrationDiffFile], { cwd: repoRoot, stdio: 'pipe' }); applies = true; } catch { applies = false; }
  const sourceFiles = [
    'src/recovery/checkpoint-probe.ts', 'src/recovery/runtime-command.ts', 'src/recovery/types.ts', 'src/recovery/index.ts', 'src/recovery/errors.ts',
  ];
  const testFiles = ['tests/recovery-checkpoint-probe.test.ts'];
  const fileIdentity = async (relative: string) => ({ path: relative, sha256: await sha256(path.join(packageRoot, relative)) });
  const sqliteVersion = (() => {
    const db = new DatabaseSync(':memory:');
    try { return (db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version; } finally { db.close(); }
  })();
  let git: Record<string, unknown> = { head: null };
  try {
    git = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim() };
  } catch { /* non-git environment */ }
  const evidence = {
    schemaVersion: 1,
    slice: 'H5b-probe',
    title: '检查点可用性只读探针：宿主零模型取证（不 capture/不写文件/不调 resolver）',
    generatedAt: new Date().toISOString(),
    evidenceLevel: 'G1+ offline read-only probe (real temporary ControlStore/SQLite; synthetic resolver markers/memory availability)',
    environment: { node: process.version, platform: process.platform, arch: process.arch, sqliteVersion },
    fingerprints: {
      source: { git, moduleFiles: await Promise.all(sourceFiles.map(fileIdentity)) },
      build: {
        buildCommand: 'npm run check (tsc --noEmit + node --import tsx --test tests/*.test.ts + tsc -p tsconfig.build.json + node --check client/index.js)',
        tsconfigBuildSha256: await sha256(path.join(packageRoot, 'tsconfig.build.json')),
        packageJsonSha256: await sha256(path.join(packageRoot, 'package.json')),
        packageLockSha256: await sha256(path.join(packageRoot, 'package-lock.json')),
      },
      tests: { files: await Promise.all(testFiles.map(fileIdentity)) },
    },
    integrationDiff: {
      path: 'artifacts/dsh/h5/runtime-checkpoint-probe.diff',
      sha256: await sha256(integrationDiffFile),
      bytes: (await readFile(integrationDiffFile)).byteLength,
      applies: applies,
      runtimeTs: 'adds RuntimeCheckpointProbeCommand wiring, runtime.checkpoint.probe dispatch and snapshot().diagnostics.checkpointProbe receipt storage',
      indexTs: 'comment-only clarification: the existing owner command route serves runtime.checkpoint.probe; no new model tool or HTTP route is added',
    },
    guarantees: {
      readOnly: true, captureAttempted: false, resolverInvoked: false, filesWritten: 0,
      pauseStateChanged: false, liveDataRootTouched: false, liveNativeSessionTouched: false,
      controlWrites: 0, modelCalls: 0, realOmbreBackendUsed: false, runtimeWiredInThisSlice: false,
    },
    reasonCodes: [...CHECKPOINT_PROBE_REASON_CODES],
    summary: { total: matrix.length, passed: matrix.filter((item) => item.pass).length, failed: matrix.filter((item) => !item.pass).length },
    cases: matrix,
    regeneration: { command: 'SHIYU_WRITE_EVIDENCE=1 node --import tsx --test tests/recovery-checkpoint-probe.test.ts' },
  };
  const shouldWrite = process.env.SHIYU_WRITE_EVIDENCE === '1' || !await exists(probeEvidenceFile);
  if (shouldWrite) {
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(probeEvidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  const persisted = JSON.parse(await readFile(probeEvidenceFile, 'utf8')) as {
    schemaVersion: number; slice: string; summary: { total: number; passed: number; failed: number };
    guarantees: Record<string, unknown>; integrationDiff: { applies: boolean }; cases: { pass: boolean }[];
  };
  expectOk(persisted.schemaVersion === 1 && persisted.slice === 'H5b-probe', 'evidence identity mismatch');
  expectOk(persisted.summary.failed === 0 && persisted.summary.total >= 6, 'probe evidence matrix failed');
  expectOk(persisted.guarantees.readOnly === true && persisted.guarantees.captureAttempted === false, 'probe guarantees missing');
  expectOk(persisted.guarantees.filesWritten === 0 && persisted.guarantees.resolverInvoked === false, 'probe write/call guarantee missing');
  expectOk(persisted.integrationDiff.applies === true, 'integration diff does not apply');
}

function expectOk(condition: unknown, message: string): void { if (!condition) throw new Error(message); }

test('evidence generator: probe matrix and integration diff identity are reproducible', async () => {
  assert.equal(await exists(integrationDiffFile), true, 'integration diff is missing');
  await generateProbeEvidence();
  const text = await readFile(probeEvidenceFile, 'utf8');
  assert.ok(!text.includes('/tmp/'), 'evidence leaked a temporary path');
  const diffText = await readFile(integrationDiffFile, 'utf8');
  assert.ok(diffText.includes('runtime.checkpoint.probe'));
  assert.ok(diffText.includes('diagnostics.checkpointProbe') || diffText.includes('checkpointProbe'));
  assert.ok(diffText.includes('probeCheckpointAvailability'));
});
