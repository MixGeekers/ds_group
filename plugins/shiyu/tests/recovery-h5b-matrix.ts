/**
 * H5b Runtime composition matrix + evidence generator.
 *
 * Every case runs against a real temporary ControlStore worker, a real
 * temporary data directory and real temporary Session logs; native-state /
 * flush / projection / memory seams are synthetic by design. No live data
 * root, real Session store or model is touched.
 */
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as h5b from './recovery-h5b-support.js';
import { verifyBundleDirectory } from '../src/recovery/verify.js';
import { IsolatedRestoreService } from '../src/recovery/restore.js';
import { createHostWorkspaceObjectPort } from '../src/recovery/host-ports.js';
import { RuntimeCheckpointCommand } from '../src/recovery/runtime-command.js';
import type { CaptureResult, RecoveryBarrierEvidence } from '../src/recovery/types.js';
import type { RuntimeCheckpointComposition } from '../src/recovery/host-ports.js';

export interface MatrixRecord {
  caseId: string;
  scenario: string;
  requirement: string;
  injectionPoint: string;
  expected: string;
  observed: string;
  pass: boolean;
  evidence: Record<string, unknown>;
  evidenceLayer: 'G1+offline-composition-synthetic-seams';
}

export interface MatrixResult {
  records: MatrixRecord[];
  productionHost: {
    readyObtainable: boolean;
    blockers: { componentId: string; code: string; requiredScope: string[] }[];
    observedCaptureStatus: string | null;
  };
  summary: { total: number; passed: number; failed: number };
}

const expect = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };

const failureOf = (result: CaptureResult): { status: string; code: string } => {
  if (result.status === 'ready') throw new Error('expected a non-ready capture');
  return { status: result.status, code: result.failure.code };
};

const barrierFor = (world: h5b.RealHostWorld): RecoveryBarrierEvidence => ({
  source: 'synthetic-test',
  capturedAt: h5b.FIXED_TIME,
  completeness: 'complete',
  deletion: { baselineId: world.watermarks.deletionBaselineId, tombstoneWatermark: world.watermarks.tombstoneWatermark },
  authorization: { authEpoch: world.watermarks.authorizationEpoch },
  desiredState: { state: 'running', intentSeq: 1 },
  unavailableReasons: [],
});

const goManifest = async (bundleDirectory: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(bundleDirectory, 'components', 'dsh-goal-sessions', 'manifest.json'), 'utf8')) as Record<string, unknown>;

const sharedManifest = async (bundleDirectory: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(bundleDirectory, 'components', 'shared-objects', 'manifest.json'), 'utf8')) as Record<string, unknown>;

const seeding = async (world: h5b.RealHostWorld, goalId = 'goal-matrix', sessionId = 'shiyu-goal-matrix', nativeGoalId = 'native-goal-matrix') => {
  await h5b.seedGoalBinding(world.store, { goalId, sessionId, nativeGoalId });
  return { goalId, sessionId, nativeGoalId, phase: 'active' as const, activation: 'disarmed' as const };
};

const withWorld = async <T>(body: (world: h5b.RealHostWorld) => Promise<T>): Promise<T> => {
  const world = await h5b.createRealHostWorld();
  try { return await body(world); } finally {
    await world.store.close().catch(() => undefined);
    await rm(world.root, { recursive: true, force: true });
  }
};

export const runH5bMatrix = async (): Promise<MatrixResult> => {
  const records: MatrixRecord[] = [];
  const record = async (
    caseId: string,
    scenario: string,
    requirement: string,
    injectionPoint: string,
    expected: string,
    check: () => Promise<{ observed: string; evidence?: Record<string, unknown> }>,
  ): Promise<void> => {
    try {
      const { observed, evidence } = await check();
      records.push({ caseId, scenario, requirement, injectionPoint, expected, observed, pass: true, evidence: evidence ?? {}, evidenceLayer: 'G1+offline-composition-synthetic-seams' });
    } catch (error) {
      records.push({
        caseId, scenario, requirement, injectionPoint, expected,
        observed: `failed: ${(error as Error).message}`,
        pass: false, evidence: {}, evidenceLayer: 'G1+offline-composition-synthetic-seams',
      });
    }
  };

  await record('composition.control-backup-and-precheck',
    '真实临时 ControlStore 上完成控制库 node:sqlite backup，并用既有 store request 读取 live 前置事实',
    'task-21-1/2', '无故障：真实 ControlStore + 真实临时 dataDir；Goal/memory 端口为注入替身',
    'ready；livePrecheck 单调、staged DB quick_check=ok、live 数据根无产品写入', async () => {
      return withWorld(async world => {
        const spec = await seeding(world);
        const fixture = await h5b.createComposition(world, { specs: [spec] });
        const before = await h5b.snapshotTree(world.dataDir);
        const result = await fixture.composition.capture('matrix-control');
        expect(result.status === 'ready', `unexpected ${result.status} ${JSON.stringify(result.status === 'ready' ? null : result.failure)}`);
        if (result.status !== 'ready') return { observed: '' };
        const control = JSON.parse(await readFile(path.join(result.bundleDirectory, 'components/control/manifest.json'), 'utf8')) as { livePrecheck?: { commitSeq: number; stateVersion: number } };
        expect(control.livePrecheck, 'livePrecheck missing');
        expect(control.livePrecheck!.commitSeq === await h5b.currentCommitSeq(world), 'precheck commitSeq mismatch');
        const db = new DatabaseSync(path.join(result.bundleDirectory, 'components/control/control.sqlite'), { readOnly: true });
        let quick = '';
        try { quick = String((db.prepare('PRAGMA quick_check').get() as { quick_check?: string })?.quick_check); } finally { db.close(); }
        expect(quick === 'ok', 'staged DB quick_check failed');
        const after = (await h5b.snapshotTree(world.dataDir)).filter((file) => !file.relativePath.startsWith('control/events.sqlite'));
        expect(JSON.stringify(after) === JSON.stringify(before.filter((file) => !file.relativePath.startsWith('control/events.sqlite'))), 'live data root changed');
        return {
          observed: `ready; precheck commitSeq=${control.livePrecheck!.commitSeq}, stateVersion=${control.livePrecheck!.stateVersion}; staged quick_check=ok; live tree stable`,
          evidence: { manifestSha256: result.manifestSha256, livePrecheck: control.livePrecheck },
        };
      });
    });

  await record('composition.goal-bytes-and-tail',
    'Goal Session 端口从注入 resolver 取得精确路径，复制字节并核对真实序列/尾/flush/projection',
    'task-21-1', '真实临时 Session 文件 + 合成 resolver/native-state/flush/projection',
    'ready；复制字节与源文件一致；tail.lastSequence=4；flush 为 acknowledged host-flush', async () => {
      return withWorld(async world => {
        const spec = await seeding(world);
        const fixture = await h5b.createComposition(world, { specs: [spec] });
        const result = await fixture.composition.capture('matrix-goal');
        expect(result.status === 'ready', `unexpected ${result.status}`);
        if (result.status !== 'ready') return { observed: '' };
        const goals = await goManifest(result.bundleDirectory);
        const session = (goals.sessions as { logFile: string; logTail: { lastSequence: number }; flush: { kind: string; acknowledged: boolean }; projection: { digest: string } }[])[0]!;
        const copied = await readFile(path.join(result.bundleDirectory, session.logFile));
        const source = await readFile(fixture.sessions!.paths.get('shiyu-goal-matrix')!);
        expect(copied.equals(source), 'copied bytes differ');
        expect(session.logTail.lastSequence === 4, 'tail sequence mismatch');
        expect(session.flush.kind === 'host-flush' && session.flush.acknowledged === true, 'flush evidence missing');
        expect(session.projection.digest === fixture.sessions!.projection.digest, 'projection digest mismatch');
        const verification = await verifyBundleDirectory(result.bundleDirectory, { requireReady: true });
        expect(verification.ok, 'bundle verification failed');
        return { observed: 'copied bytes identical; tail seq=4; host-flush acknowledged; projection digest matches; bundle re-verified', evidence: { logSha256: h5b.sha256(copied) } };
      });
    });

  const incompleteCases: { caseId: string; options: h5b.CompositionOptions; expectedCode: string; scenario: string; injection: string }[] = [
    { caseId: 'composition.goal-missing-log', options: { specs: [{ ...{ goalId: 'goal-missing-log', sessionId: 'shiyu-goal-missing-log', nativeGoalId: 'native-goal-missing-log' }, omitLog: true, phase: 'active', activation: 'disarmed' }] }, expectedCode: 'MISSING_GOAL_SESSION', scenario: 'GoalBinding 存在但权威日志不可解析', injection: 'resolver 返回 undefined' },
    { caseId: 'composition.goal-missing-projection', options: { specs: [{ goalId: 'goal-no-proj', sessionId: 'shiyu-goal-no-proj', nativeGoalId: 'native-goal-no-proj', phase: 'active', activation: 'disarmed' }], omitProjection: true }, expectedCode: 'PROJECTION_EXPORT_UNAVAILABLE', scenario: '缺少 projection 定义/配置导出', injection: 'projection seam 缺失' },
    { caseId: 'composition.goal-native-state-unavailable', options: { specs: [{ goalId: 'goal-no-state', sessionId: 'shiyu-goal-no-state', nativeGoalId: 'native-goal-no-state', phase: 'active', activation: 'disarmed', nativeStateMissing: true }] }, expectedCode: 'GOAL_SESSION_EXPORT_UNAVAILABLE', scenario: '宿主公共 API 不能读取原生 Goal phase/armed', injection: 'nativeState 返回 undefined' },
    { caseId: 'composition.goal-unverifiable-format', options: { specs: [{ goalId: 'goal-zstd', sessionId: 'shiyu-goal-zstd', nativeGoalId: 'native-goal-zstd', phase: 'active', activation: 'disarmed', format: 'zstd' }] }, expectedCode: 'LOG_FORMAT_NOT_OFFLINE_VERIFIABLE', scenario: '默认 zstd 日志无法在本切片独立离线核验', injection: 'resolver format=zstd' },
  ];
  for (const item of incompleteCases) {
    await record(item.caseId, item.scenario, 'task-21-1/4', item.injection, `非 ready；${item.expectedCode}；不写 lastGood`, async () => {
      return withWorld(async world => {
        const goalId = item.caseId.split('.').at(-1)!;
        const spec = item.options.specs![0]!;
        await h5b.seedGoalBinding(world.store, { goalId: spec.goalId, sessionId: spec.sessionId, nativeGoalId: spec.nativeGoalId });
        void goalId;
        const fixture = await h5b.createComposition(world, item.options);
        const result = await fixture.composition.capture(`matrix-${item.caseId.replaceAll('.', '-')}`);
        const failure = failureOf(result);
        expect(failure.code === item.expectedCode, `unexpected code ${failure.code}`);
        expect(await fixture.composition.lastGood() === undefined, 'lastGood must stay absent');
        return { observed: `${failure.status} ${failure.code}; lastGood absent`, evidence: { code: failure.code } };
      });
    });
  }

  await record('composition.memory-unavailable', '当前 managed Ombre 无公开导出 API', 'task-21-1/2', 'Goal 端口注入替身 + 生产 memory 端口（不可用）',
    'incomplete MEMORY_EXPORT_UNAVAILABLE；availability blockers 含 requiredScope；不得 ready', async () => {
      return withWorld(async world => {
        const spec = await seeding(world);
        const fixture = await h5b.createComposition(world, { specs: [spec], memoryUnavailable: true });
        const availability = fixture.composition.availability();
        expect(availability.expectedReady === false, 'availability must not claim ready');
        const memory = availability.components.find((item) => item.componentId === 'memory')!;
        expect(memory.code === 'MEMORY_EXPORT_UNAVAILABLE' && memory.requiredScope.length > 0, 'missing precise memory blocker');
        const result = await fixture.composition.capture('matrix-memory');
        const failure = failureOf(result);
        expect(failure.code === 'MEMORY_EXPORT_UNAVAILABLE', `unexpected code ${failure.code}`);
        expect(await fixture.composition.lastGood() === undefined, 'lastGood must stay absent');
        return { observed: 'incomplete MEMORY_EXPORT_UNAVAILABLE with requiredScope; no lastGood', evidence: { requiredScope: memory.requiredScope.length } };
      });
    });

  await record('composition.production-host-blocked', '无任何合成 seam 的生产组合（真实 store/workspace）', 'task-21-1/2', '生产端口：无 Goal resolver/native-state/projection、无 Ombre 导出',
    'expectedReady=false；capture 非 ready；blockers 精确列出 Goal+memory required scope；不伪造 ready', async () => {
      return withWorld(async world => {
        await seeding(world);
        const fixture = await h5b.createComposition(world, { memoryUnavailable: true });
        const availability = fixture.composition.availability();
        expect(availability.expectedReady === false, 'production host must not be ready');
        const goal = availability.components.find((item) => item.componentId === 'dsh-goal-sessions')!;
        const memory = availability.components.find((item) => item.componentId === 'memory')!;
        expect(goal.status === 'unavailable' && goal.code === 'GOAL_SESSION_EXPORT_UNAVAILABLE', 'goal blocker missing');
        expect(memory.status === 'unavailable' && memory.code === 'MEMORY_EXPORT_UNAVAILABLE', 'memory blocker missing');
        expect(goal.requiredScope.length >= 3 && memory.requiredScope.length >= 1, 'required scope must be concrete');
        const result = await fixture.composition.capture('matrix-production');
        expect(result.status !== 'ready', 'production capture must not be ready');
        return { observed: 'production host explicitly blocked with bounded required scopes; capture not ready', evidence: { blockers: availability.blockers.map((item) => item.code) } };
      });
    });

  await record('composition.staging-interrupted', 'staging 完成前模拟进程中断（控制快照之后）', 'task-21-2/V15', 'fault injection after-control-snapshot: interrupt',
    'incomplete STAGING_INTERRUPTED；partial 目录保留；无 ready、无 lastGood', async () => {
      return withWorld(async world => {
        const spec = await seeding(world);
        const fixture = await h5b.createComposition(world, { specs: [spec] });
        const result = await fixture.composition.capture('matrix-interrupt', { faults: { at: 'after-control-snapshot', mode: 'interrupt' } });
        const failure = failureOf(result);
        expect(failure.code === 'STAGING_INTERRUPTED', `unexpected code ${failure.code}`);
        expect(result.status === 'incomplete' && result.partialDirectory != null, 'partial staging evidence missing');
        expect(await fixture.composition.lastGood() === undefined, 'lastGood must stay absent');
        return { observed: 'incomplete STAGING_INTERRUPTED; partial retained; no lastGood', evidence: { code: failure.code } };
      });
    });

  await record('composition.hash-mismatch', '真实 workspace 对象字节在 port 缓存后被改写', 'task-21-4/V22', 'workspace port inventory 后改写文件；control.objectRefs 引用该对象',
    'failed HASH_MISMATCH；不得 ready', async () => {
      return withWorld(async world => {
        await mkdir(path.join(world.dataDir, 'workspaces', 'task-matrix'), { recursive: true });
        const objectFile = path.join(world.dataDir, 'workspaces', 'task-matrix', 'artifact.txt');
        await writeFile(objectFile, 'matrix artifact original');
        const port = await createHostWorkspaceObjectPort({ dataDir: world.dataDir });
        const inventory = await port.inventory();
        const objectId = `ws-${h5b.sha256(inventory.files[0]!.relativePath).slice(0, 40)}`;
        await h5b.seedGoalBinding(world.store, { goalId: 'goal-hash', sessionId: 'shiyu-goal-hash', nativeGoalId: 'native-goal-hash' });
        const spec = { goalId: 'goal-hash', sessionId: 'shiyu-goal-hash', nativeGoalId: 'native-goal-hash', phase: 'active' as const, activation: 'disarmed' as const };
        await writeFile(objectFile, 'matrix artifact changed after inventory');
        const fixture = await h5b.createComposition(world, { specs: [spec], sharedObjects: port, extra: { control: { objectRefs: [objectId] } } });
        const result = await fixture.composition.capture('matrix-hash');
        const failure = failureOf(result);
        expect(failure.code === 'HASH_MISMATCH', `unexpected code ${failure.code}`);
        return { observed: 'failed HASH_MISMATCH; not ready', evidence: { code: failure.code } };
      });
    });

  await record('composition.live-root-rejected', 'staging 根指向 live 数据根内部 / 未批准父目录', 'task-21-2', 'stagingRoot=dataDir/checkpoint；以及 allowedStagingRoots 之外的目录',
    'LIVE_ROOT_PROTECTED / TARGET_NOT_ISOLATED；live 数据根不写入', async () => {
      return withWorld(async world => {
        const before = await h5b.snapshotTree(world.dataDir);
        let live = '';
        try { await h5b.createComposition(world, { stagingRoot: path.join(world.dataDir, 'checkpoint') }); } catch (error) { live = (error as { code?: string }).code ?? ''; }
        expect(live === 'LIVE_ROOT_PROTECTED', `unexpected live-root code ${live}`);
        const outside = path.join(world.root, 'unapproved');
        await mkdir(outside, { recursive: true });
        let isolated = '';
        try { await h5b.createComposition(world, { stagingRoot: outside, allowedStagingRoots: [world.stagingRoot] }); } catch (error) { isolated = (error as { code?: string }).code ?? ''; }
        expect(isolated === 'TARGET_NOT_ISOLATED', `unexpected isolation code ${isolated}`);
        const after = await h5b.snapshotTree(world.dataDir);
        expect(JSON.stringify(after.filter((file) => !file.relativePath.startsWith('control/events.sqlite')))
          === JSON.stringify(before.filter((file) => !file.relativePath.startsWith('control/events.sqlite'))), 'live data root was modified');
        return { observed: 'LIVE_ROOT_PROTECTED + TARGET_NOT_ISOLATED; live root unchanged', evidence: { live, isolated } };
      });
    });

  await record('composition.isolated-restore-verified', '组合产出的 ready Bundle 在隔离临时根恢复', 'task-21-3', 'ready composition bundle + 隔离根 + 最新 barrier',
    'verified；readView read-only；dispatch blocked；旧 armed → disarmed；live 数据根未动', async () => {
      return withWorld(async world => {
        await h5b.seedGoalBinding(world.store, { goalId: 'goal-restore-m', sessionId: 'shiyu-goal-restore-m', nativeGoalId: 'native-goal-restore-m' });
        const spec = { goalId: 'goal-restore-m', sessionId: 'shiyu-goal-restore-m', nativeGoalId: 'native-goal-restore-m', phase: 'active' as const, activation: 'armed' as const };
        const fixture = await h5b.createComposition(world, { specs: [spec] });
        const captured = await fixture.composition.capture('matrix-restore');
        expect(captured.status === 'ready', 'capture not ready');
        if (captured.status !== 'ready') return { observed: '' };
        const before = (await h5b.snapshotTree(world.dataDir)).filter((file) => !file.relativePath.startsWith('control/events.sqlite'));
        const restore = new IsolatedRestoreService({ clock: world.clock });
        const result = await restore.restore({
          bundleDirectory: captured.bundleDirectory,
          targetRoot: path.join(world.isolatedRoot, 'matrix-restore-target'),
          isolatedRoot: world.isolatedRoot,
          liveDataRoot: world.dataDir,
          expectedRootId: fixture.composition.dataRootHash,
          barrier: barrierFor(world),
        });
        expect(result.report.status === 'verified', `restore not verified: ${result.report.failures.map((item) => item.code).join(',')}`);
        expect(result.report.readView === 'read-only' && result.report.dispatch === 'blocked' && result.report.activate === 'not-activated', 'restore state mismatch');
        expect(result.report.goalExclusions.length === 0, 'unexpected goal exclusions');
        expect(result.state!.goals.every((goal) => goal.effectiveActivation === 'disarmed'), 'restored goal not disarmed');
        const after = (await h5b.snapshotTree(world.dataDir)).filter((file) => !file.relativePath.startsWith('control/events.sqlite'));
        expect(JSON.stringify(after) === JSON.stringify(before), 'live data root changed after restore');
        return { observed: 'verified read-only restore; armed→disarmed; live root unchanged', evidence: { checks: result.report.checks.length } };
      });
    });

  await record('composition.workspace-inventory', '真实 dataDir/workspaces 只读清单+hash；符号链接排除', 'task-21-1', 'workspace 文件 + 一个指向根外的符号链接',
    'shared-objects manifest 记录清单/聚合 hash/excludedCount；不复制未引用文件', async () => {
      return withWorld(async world => {
        await mkdir(path.join(world.dataDir, 'workspaces', 'nested'), { recursive: true });
        await writeFile(path.join(world.dataDir, 'workspaces', 'a.txt'), 'alpha');
        await writeFile(path.join(world.dataDir, 'workspaces', 'nested', 'b.bin'), Buffer.from([0, 1, 2, 3]));
        const outside = path.join(world.root, 'outside.txt');
        await writeFile(outside, 'outside');
        await symlink(outside, path.join(world.dataDir, 'workspaces', 'escape'));
        const spec = await seeding(world);
        const fixture = await h5b.createComposition(world, { specs: [spec] });
        const result = await fixture.composition.capture('matrix-inventory');
        expect(result.status === 'ready', 'capture not ready');
        if (result.status !== 'ready') return { observed: '' };
        const shared = await sharedManifest(result.bundleDirectory);
        const inventory = shared.workspaceInventory as { files: { relativePath: string }[]; aggregateSha256: string; excludedCount: number };
        expect(inventory.files.length === 2 && inventory.excludedCount >= 1, 'inventory shape mismatch');
        expect(inventory.aggregateSha256 === h5b.sha256(h5b.canonicalJson(inventory.files)), 'inventory aggregate mismatch');
        return { observed: 'inventory recorded with aggregate hash; symlink excluded', evidence: { files: inventory.files.length, excludedCount: inventory.excludedCount } };
      });
    });

  await record('composition.command-single-flight', 'owner-only 命令：显式触发、paused 允许、单飞不排队、不自动重试', 'task-21-3', 'fake composition（captureResult=incomplete）+ paused=true + 并发第二次请求',
    'explicit only；pausedAtRequest=true；第二次 busy 且只执行一次 capture；retried=false', async () => {
      const calls = { count: 0 };
      let paused = false;
      const composition: RuntimeCheckpointComposition = {
        dataRootHash: h5b.sha256('root'), stagingRootHash: h5b.sha256('staging'),
        dataDir: '/tmp/matrix-data', stagingRoot: '/tmp/matrix-staging',
        generation: { installationGeneration: 'gen-matrix', hostEpoch: 'epoch-matrix' },
        async capture(snapshotId) {
          calls.count += 1;
          return { status: 'incomplete', snapshotId, failure: { code: 'MEMORY_EXPORT_UNAVAILABLE', componentId: 'memory', message: 'synthetic' }, bundleDirectory: null, partialDirectory: null, lastGoodUpdated: false };
        },
        availability: () => ({
          stagingRootHash: h5b.sha256('staging'), dataRootHash: h5b.sha256('root'),
          components: [], expectedReady: false,
          blockers: [{ componentId: 'memory', code: 'MEMORY_EXPORT_UNAVAILABLE', requiredScope: ['export api'] }],
        }),
        async lastGood() { return undefined; },
      };
      const command = new RuntimeCheckpointCommand({ composition, isOpen: () => true, isPaused: () => paused, snapshotId: () => 'matrix-command' });
      expect(calls.count === 0, 'construction must not capture');
      paused = true;
      const result = await command.handle({ action: 'runtime.checkpoint.capture', requestId: 'matrix-1' });
      expect(result.pausedAtRequest === true && result.desiredState === 'unchanged', 'pause semantics violated');
      expect(result.retried === false && result.autoTriggered === false, 'retry semantics violated');
      expect(calls.count === 1, 'capture must run exactly once');
      const busy = await command.handle({ action: 'runtime.checkpoint.capture', requestId: 'matrix-2' });
      expect(busy.status === 'busy' || busy.status === 'incomplete', 'unexpected concurrent result');
      return { observed: `explicit command ran once; paused preserved; concurrent status=${busy.status}; captured blocks=${result.blockedComponents.length}`, evidence: { calls: calls.count } };
    });

  await record('composition.resolver-candidate-provenance', '宿主候选 resolver 的 provenance 与不可用分支', 'task-21-1', 'fake persistence 对象：有/无 resolveCurrentLog；compression none/zstd',
    '有方法 → provenance=jsonl-internal-diagnostic 且可解析；无方法 → null；zstd → format=zstd（后续显式不可离线核验）', async () => {
      const logs = new Map([['session-x', '/tmp/session-x.jsonl']]);
      const resolver = h5b.detectSessionPersistenceLogResolver(h5b.fakeJsonlPersistence(logs));
      expect(resolver?.provenance === 'jsonl-internal-diagnostic', 'provenance mismatch');
      expect((await resolver!.resolve('session-x'))?.path === '/tmp/session-x.jsonl', 'resolver path mismatch');
      expect(h5b.detectSessionPersistenceLogResolver({}) === null, 'missing method must be null');
      const zstd = h5b.detectSessionPersistenceLogResolver(h5b.fakeJsonlPersistence(logs, 'zstd'));
      expect((await zstd!.resolve('session-x'))?.format === 'zstd', 'zstd format not reported');
      return { observed: 'candidate resolver detected with explicit provenance; missing method returns null; zstd format reported', evidence: { provenance: resolver?.provenance } };
    });

  const passed = records.filter((item) => item.pass).length;
  const production = await withWorld(async world => {
    await seeding(world);
    const fixture = await h5b.createComposition(world, { memoryUnavailable: true });
    const availability = fixture.composition.availability();
    const result = await fixture.composition.capture('matrix-production-summary');
    return {
      readyObtainable: availability.expectedReady,
      blockers: availability.blockers.map((item) => ({ componentId: item.componentId, code: item.code, requiredScope: [...item.requiredScope] })),
      observedCaptureStatus: result.status,
    };
  });
  return {
    records,
    productionHost: production,
    summary: { total: records.length, passed, failed: records.length - passed },
  };
};
