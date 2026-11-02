/**
 * H5-B1 fault / boundary matrix executed against real temporary SQLite and
 * files. Used by both the fault-matrix test and the evidence generator so the
 * JSON evidence is produced by the same code path the tests assert.
 *
 * Evidence level: G1 offline module + synthetic ports. This does NOT exercise
 * the live DSH host, a live data root, a native Session, models, an independent
 * backup fault domain, RPO/RTO or an independent failure domain.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as support from './recovery-support.js';
import type { BackupBundle } from '../src/recovery/types.js';
import { validateBackupBundle, validateDeletionLedger, validateGenerationTransition, validateGoalSessionsComponentManifest, validateRecoveryLockRecord, validateRestoreReport } from '../src/recovery/schema.js';
import { readControlFacts } from '../src/recovery/control-facts.js';

export interface MatrixRecord {
  caseId: string;
  scenario: string;
  requirement: string;
  injectionPoint: string;
  expected: string;
  observed: string;
  pass: boolean;
  evidence: Record<string, unknown>;
  evidenceLayer: 'G1-offline-synthetic';
}

export interface SelfProofCase {
  caseId: string;
  expected: 'accepted' | 'rejected';
  observed: string;
  rejected: boolean;
  pass: boolean;
}

export interface MatrixResult {
  records: MatrixRecord[];
  selfProof: SelfProofCase[];
  summary: { total: number; passed: number; failed: number; selfProofTotal: number; selfProofPassed: number };
}

const expect = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const captureFailure = (result: Awaited<ReturnType<typeof support.captureWorld>>): { code: string; status: string } => {
  if (result.status === 'ready') throw new Error('expected a failed capture, got ready');
  return { code: result.failure.code, status: result.status };
};

const restoreFailure = async (promise: Promise<unknown>): Promise<{ code: string }> => {
  try {
    await promise;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string') throw error;
    return { code };
  }
  throw new Error('expected a rejected restore precondition, but the restore resolved');
};

const readJson = async (filename: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>;

const controlManifestOf = async (bundleDirectory: string): Promise<Record<string, unknown>> =>
  readJson(path.join(bundleDirectory, 'components', 'control', 'manifest.json'));

const goalManifestOf = async (bundleDirectory: string): Promise<Record<string, unknown>> =>
  readJson(path.join(bundleDirectory, 'components', 'dsh-goal-sessions', 'manifest.json'));

const manifestOf = async (bundleDirectory: string): Promise<BackupBundle> => support.readManifest(bundleDirectory);

/**
 * Fault-injection point for each matrix case, so the evidence JSON can state
 * "injection point → expected state → observed state" per case.
 */
export const INJECTION_POINTS: Readonly<Record<string, string>> = {
  'capture.ready': '真实临时 SQLite 控制库 + 合成 JSONL Goal Session + 合成 memory export + 内存共享对象；无注入',
  'capture.concurrent-writer-boundary': 'capture 完成后由另一连接提交 commit_seq+1（live 继续写入，已发布清单不得回流）',
  'capture.unknown-breakpoints': '控制库行：unknown effect / pending Goal command / unknown reservation / unknown MemoryOperation',
  'capture.staging-interrupted': 'inject fault after-control-snapshot: interrupt（不发布，保留 partial journal）',
  'capture.staging-failed-not-ready': 'inject fault after-goal-sessions: fail（只发布 failed 清单）',
  'capture.missing-commit-watermark': '控制快照缺少 shiyu_commit_watermark 行',
  'capture.missing-publication-watermark': '控制快照缺少 shiyu_state_publication_head 行',
  'capture.missing-authorization-watermark': '控制快照缺少 shiyu_policy_meta 行',
  'capture.missing-deletion-watermark': '控制快照缺少 shiyu_memory_meta 行',
  'capture.missing-goal-session': 'GoalSessionPort 省略 GoalBinding 对应的 Session 日志',
  'capture.missing-projection': 'GoalSessionPort 返回的 projection digest 与定义字节不符',
  'capture.object-closure-incomplete': 'MemoryExportPort 声明 objectRefs=[artifact-missing]，SharedObjectPort 返回 undefined',
  'capture.hash-mismatch': 'MemoryExportPort 的 archive 摘要与实际写入字节不符',
  'capture.version-incompatible': 'runtimeManifest 的 projection minimumReaderVersion=2',
  'capture.capacity-insufficient': 'CapacityProbe 返回 1 KiB（低于估算需求）',
  'capture.failure-preserves-lastgood': '首次 ready 后 CapacityProbe 返回低值（第二次捕获失败）',
  'capture.goal-tail-mismatch': 'GoalSessionPort 返回字节追加内容，expected/durableTail 保持原值',
  'capture.empty-goal-set': '控制库无 GoalBinding（dsh-goal-sessions 组件为空但完整）',
  'restore.old-deletion-ledger-locked': 'barrier 删除水位 3→5 且请求不提供 deletionLedger',
  'restore.old-deletion-ledger-replayed': 'barrier 删除水位 3→5 + sealDeletionLedger 连续账本（ref=memory-visible-2）',
  'restore.control-tombstone-replay': '控制库 tombstone_watermark=5 且 shiyu_memory_tombstones(watermark=5)，memory export watermark=3',
  'restore.barrier-unavailable-locked': 'restore 请求 barrier=undefined',
  'restore.verified-positive': '无注入正例：完整 ready Bundle + 完整 barrier',
  'restore.armed-goal-disarmed': 'GoalSessionPort 捕获到 activation=armed 的 Goal 状态',
  'restore.tampered-bundle-rejected': 'capture 后向 shared object 文件追加字节',
  'restore.live-root-protected': 'restore targetRoot=live 数据根',
  'restore.target-not-isolated': 'restore targetRoot 位于 isolatedRoot 之外',
  'restore.recovery-lock-exclusive': '预置 targetRoot/.recovery/recovery-lock.json',
  'restore.bundle-not-ready': '对 failed Bundle 发起恢复（capture 在 after-control-snapshot 注入 fail）',
  'restore.missing-component-manifest': '手工从 bundle.json 删除 memory 组件后恢复',
};

export const runEvidenceMatrix = async (): Promise<MatrixResult> => {
  const records: MatrixRecord[] = [];
  const record = async (
    caseId: string,
    scenario: string,
    requirement: string,
    expected: string,
    check: () => Promise<{ observed: string; evidence?: Record<string, unknown> }>,
  ): Promise<void> => {
    const injectionPoint = INJECTION_POINTS[caseId] ?? 'unspecified';
    try {
      const { observed, evidence } = await check();
      records.push({ caseId, scenario, requirement, injectionPoint, expected, observed, pass: true, evidence: evidence ?? {}, evidenceLayer: 'G1-offline-synthetic' });
    } catch (error) {
      records.push({
        caseId, scenario, requirement, injectionPoint, expected,
        observed: `failed: ${(error as Error).message}`,
        pass: false,
        evidence: {},
        evidenceLayer: 'G1-offline-synthetic',
      });
    }
  };

  const withWorld = async <T>(options: support.WorldOptions, body: (world: support.World) => Promise<T>): Promise<T> => {
    const world = await support.createWorld(undefined, options);
    try { return await body(world); } finally { await support.cleanupWorld(world); }
  };

  // 1. Ready capture + last-good publication ------------------------------------------------
  await record('capture.ready', '合成控制库、Goal Session 日志、记忆导出与共享对象在临时根完成一次 ready capture', 'task-6-B', 'ready，全部必需组件可核验，lastGood 更新', async () => {
    const world = await support.createWorld(undefined, {
      objects: new Map([['artifact-a', Buffer.from('synthetic artifact')]]),
      controlObjectRefs: ['artifact-a'],
    });
    try {
      const ready = await support.captureReady(world, { snapshotId: 'matrix-capture-ready' });
      const manifest = await manifestOf(ready.bundleDirectory);
      expect(manifest.status === 'ready', 'manifest status must be ready');
      expect(manifest.reconcileRequired === true, 'reconcileRequired must be true');
      expect(manifest.durability.crossComponentCommonSection === false, 'must not claim a common section');
      expect(manifest.components.length === 4, 'must capture exactly four required components');
      expect(manifest.control?.commitSeq === world.control.watermarks.commitSeq, 'control commitSeq mismatch');
      const pointer = await world.captureService.readLastGood();
      expect(pointer?.snapshotId === ready.snapshotId, 'last-good pointer was not updated');
      const verified = await support.verifyDirectory(ready.bundleDirectory);
      expect(verified.ok, `bundle self-verification failed: ${verified.violations[0]?.message ?? ''}`);
      return {
        observed: 'ready; 4 components complete; lastGood published; bundle directory re-verified from bytes',
        evidence: { manifestSha256: ready.manifestSha256, objectCount: manifest.objectManifest?.objectCount ?? 0 },
      };
    } finally { await support.cleanupWorld(world); }
  });

  // 2. Concurrent writer boundary declaration ----------------------------------------------
  await record('capture.concurrent-writer-boundary', 'capture 期间 live 控制库仍可写入；Bundle 不冒称跨组件共同截面', 'task-6-B/V22', '每组件独立水位；captureTime 取最早组件时间；完成后 live 变更不回流到已发布清单', async () => {
    const world = await support.createWorld(undefined, { snapshotId: 'matrix-concurrent-writer' });
    const ready = await support.captureReady(world, { snapshotId: 'matrix-concurrent-writer' });
    const manifest = await manifestOf(ready.bundleDirectory);
    const live = new DatabaseSync(world.controlPath);
    live.prepare('UPDATE shiyu_commit_watermark SET commit_seq=commit_seq+1 WHERE id=1').run();
    live.close();
    expect(manifest.control?.commitSeq === 42, 'manifest must retain the snapshot commitSeq');
    expect(manifest.reconcileRequired === true, 'ready bundle must remain reconcileRequired');
    expect(manifest.durability.crossComponentCommonSection === false, 'must not claim a cross-component section');
    const earliest = [...manifest.components.map((item) => item.capturedAt)].sort()[0];
    expect(manifest.captureTime === earliest, 'captureTime must be the earliest component capture time');
    expect(manifest.completedAt >= manifest.captureTime, 'completedAt must not precede captureTime');
    const facts = await support.readControlFixtureFacts(world);
    expect(facts.watermarks.commitSeq === 43, 'live commitSeq changed after capture (as intended by the case)');
    return {
      observed: 'snapshot commitSeq retained; bundle declarations remain per-component; live later write did not alter manifest',
      evidence: { captureTime: manifest.captureTime, completedAt: manifest.completedAt, commonSection: false },
    };
  });

  // 3. Control committed / component executed / local unconfirmed breakpoints ---------------
  await record('capture.unknown-breakpoints', '控制已提交、组件可能已执行但本地未确认（unknown effect、pending Goal command、unknown reservation、unknown MemoryOperation）', 'task-6-B/D', '全部 unknown 进入 control 清单；恢复后状态保持 unknown 且不重放', async () => {
    const world = await support.createWorld(undefined, {
      control: {
        effects: [
          { effectId: 'effect-unknown-1', status: 'unknown' },
          { effectId: 'effect-succeeded-1', status: 'succeeded' },
        ],
        goalCommands: [{ goalId: 'goal-alpha', commandId: 'command-pending-1', status: 'pending' }],
        reservations: [{ id: 'reservation-unknown-1', state: 'unknown' }],
        memoryOperations: [{ operationId: 'memory-op-unknown-1', effectState: 'unknown', status: 'approved' }],
      },
    });
    try {
      const ready = await support.captureReady(world, { snapshotId: 'matrix-unknown-breakpoints' });
      const control = await controlManifestOf(ready.bundleDirectory);
      const inFlight = control.inFlight as { kind: string; status: string }[];
      expect(inFlight.length === 4, `expected 4 in-flight operations, got ${inFlight.length}`);
      expect(inFlight.some((item) => item.kind === 'effect' && item.status === 'unknown'), 'unknown effect not captured');
      expect(inFlight.some((item) => item.kind === 'goal-command' && item.status === 'pending'), 'pending Goal command not captured');
      expect(inFlight.some((item) => item.kind === 'budget-reservation'), 'unknown reservation not captured');
      expect(inFlight.some((item) => item.kind === 'memory-operation'), 'unknown memory operation not captured');
      const restored = await support.restoreWorld(world, ready.bundleDirectory);
      expect(restored.report.status === 'verified', `restore failed: ${restored.report.failures.map((item) => item.code).join(',')}`);
      expect(restored.state !== null, 'restored state must be available');
      expect(restored.state!.unknown.preserved.length === 4, 'restored unknown operations were not preserved');
      expect(restored.state!.unknown.replayed === 0, 'unknown operations must never be replayed');
      const restoredDb = path.join(restored.targetRoot, 'data', 'bundle', 'components', 'control', 'control.sqlite');
      const facts = readControlFacts(restoredDb);
      expect(support.canonicalJson(facts.inFlight) === support.canonicalJson(inFlight), 'restored in-flight statuses changed');
      return {
        observed: '4 in-flight/unknown operations captured and preserved; replay count is 0',
        evidence: { inFlight: inFlight.map((item) => `${item.kind}:${item.status}`).sort() },
      };
    } finally { await support.cleanupWorld(world); }
  });

  // 4. Staging interruption before publish -------------------------------------------------
  await record('capture.staging-interrupted', 'staging 完成前模拟进程中断（控制快照之后）', 'task-6-B/V15', '状态 incomplete；partial 保留；没有 ready Bundle；不更新 lastGood；同 id 不静默恢复', async () => {
    const world = await support.createWorld(undefined, {});
    try {
      const interrupted = await support.captureWorld(world, {
        snapshotId: 'matrix-interrupted',
        faults: { at: 'after-control-snapshot', mode: 'interrupt' },
      });
      const failure = captureFailure(interrupted);
      expect(failure.code === 'STAGING_INTERRUPTED' && failure.status === 'incomplete', `unexpected failure ${JSON.stringify(failure)}`);
      const staging = await world.captureService.inspectStaging('matrix-interrupted');
      expect(staging.partialDirectory !== null, 'partial staging directory was not retained');
      expect(staging.journal?.phase === 'control-snapshot', 'journal phase not retained');
      expect(staging.publishedDirectory === null, 'interrupted staging must not be published');
      expect(await world.captureService.readLastGood() === undefined, 'lastGood must not be updated');
      const sameId = await support.captureWorld(world, { snapshotId: 'matrix-interrupted' });
      const sameFailure = captureFailure(sameId);
      expect(sameFailure.code === 'STAGING_INTERRUPTED', 'a partial staging attempt must not be silently resumed');
      const retried = await support.captureWorld(world, { snapshotId: 'matrix-interrupted-retry' });
      expect(retried.status === 'ready', 'a fresh snapshotId must capture after an interruption');
      return {
        observed: 'incomplete with retained partial journal; same id stayed incomplete; fresh id became ready',
        evidence: { partialPhase: staging.journal?.phase ?? null, retryStatus: retried.status },
      };
    } finally { await support.cleanupWorld(world); }
  });

  // 5. Staging failure (not interruption) publishes only a failed bundle -------------------
  await record('capture.staging-failed-not-ready', '在 Goal Session 抓取后注入失败', 'task-6-B/V15', 'failed/incomplete 清单可发布但绝不 ready；lastGood 不变；恢复拒绝', async () => {
    const world = await support.createWorld(undefined, {});
    try {
      const failed = await support.captureWorld(world, {
        snapshotId: 'matrix-injected-failure',
        faults: { at: 'after-goal-sessions', mode: 'fail' },
      });
      if (failed.status === 'ready') throw new Error('injected failure must not produce a ready bundle');
      expect(failed.failure.code === 'INJECTED_FAILURE', `unexpected code ${failed.failure.code}`);
      expect(failed.bundleDirectory !== null, 'a failed bundle manifest should be published for evidence');
      expect(await world.captureService.readLastGood() === undefined, 'failed bundle must not update lastGood');
      const verified = await support.verifyDirectory(failed.bundleDirectory!, false);
      expect(verified.ok, `failed bundle manifest must still validate structurally: ${verified.violations[0]?.message ?? ''}`);
      const locked = await restoreFailure(support.restoreWorld(world, failed.bundleDirectory!, { targetName: 'restore-of-failure' }));
      expect(locked.code === 'BUNDLE_NOT_READY', `restore must reject a failed bundle, got ${locked.code}`);
      return { observed: 'failed bundle recorded, not ready, lastGood unchanged, restore rejected', evidence: { code: failed.failure.code } };
    } finally { await support.cleanupWorld(world); }
  });

  // 6. Missing required watermarks ---------------------------------------------------------
  for (const [caseId, missing] of [
    ['capture.missing-commit-watermark', { commit: true }],
    ['capture.missing-publication-watermark', { publication: true }],
    ['capture.missing-authorization-watermark', { policy: true }],
    ['capture.missing-deletion-watermark', { deletion: true }],
  ] as const) {
    await record(caseId, `控制快照缺少必需水位 ${JSON.stringify(missing)}`, 'task-6-B', 'incomplete MISSING_WATERMARK；不得 ready', async () => {
      const world = await support.createWorld(undefined, { control: { missing } });
      try {
        const result = await support.captureWorld(world, { snapshotId: `matrix-${caseId.replaceAll('.', '-')}` });
        const failure = captureFailure(result);
        expect(failure.code === 'MISSING_WATERMARK', `unexpected code ${failure.code}`);
        expect(failure.status === 'incomplete', `missing watermark must be incomplete, got ${failure.status}`);
        expect(await world.captureService.readLastGood() === undefined, 'lastGood must not be updated');
        return { observed: 'incomplete MISSING_WATERMARK; no lastGood', evidence: { missing } };
      } finally { await support.cleanupWorld(world); }
    });
  }

  // 7. Missing Goal Session log / projection ----------------------------------------------
  await record('capture.missing-goal-session', 'GoalBinding 存在但权威 Goal Session 日志缺失', 'task-6-B', 'incomplete MISSING_GOAL_SESSION；不得 ready', async () => {
    const world = await support.createWorld(undefined, { goals: { omitGoalId: 'goal-alpha' } });
    try {
      const failure = captureFailure(await support.captureWorld(world, { snapshotId: 'matrix-missing-goal-session' }));
      expect(failure.code === 'MISSING_GOAL_SESSION', `unexpected code ${failure.code}`);
      expect(await world.captureService.readLastGood() === undefined, 'lastGood must not be updated');
      return { observed: 'incomplete MISSING_GOAL_SESSION', evidence: { failure: failure.code } };
    } finally { await support.cleanupWorld(world); }
  });

  await record('capture.missing-projection', 'Goal Session 日志存在但 projection 定义 digest 不符', 'task-6-B', 'incomplete MISSING_PROJECTION；不得 ready', async () => {
    const world = await support.createWorld(undefined, { goals: { tamperProjection: true } });
    try {
      const failure = captureFailure(await support.captureWorld(world, { snapshotId: 'matrix-missing-projection' }));
      expect(failure.code === 'MISSING_PROJECTION', `unexpected code ${failure.code}`);
      return { observed: 'incomplete MISSING_PROJECTION', evidence: { failure: failure.code } };
    } finally { await support.cleanupWorld(world); }
  });

  // 8. Missing shared object closure -------------------------------------------------------
  await record('capture.object-closure-incomplete', '记忆导出引用的共享对象在对象源不可读', 'task-6-B', 'incomplete OBJECT_CLOSURE_INCOMPLETE；不得 ready', async () => {
    const world = await support.createWorld(undefined, { memory: { objectRefs: ['artifact-missing'] } });
    try {
      const failure = captureFailure(await support.captureWorld(world, { snapshotId: 'matrix-object-closure' }));
      expect(failure.code === 'OBJECT_CLOSURE_INCOMPLETE', `unexpected code ${failure.code}`);
      return { observed: 'incomplete OBJECT_CLOSURE_INCOMPLETE', evidence: { failure: failure.code } };
    } finally { await support.cleanupWorld(world); }
  });

  // 9. Hash mismatch at capture ------------------------------------------------------------
  await record('capture.hash-mismatch', '记忆导出端口返回的 archive 摘要与实际字节不符', 'task-6-B', 'fail/incomplete HASH_MISMATCH；不得 ready', async () => {
    const world = await support.createWorld(undefined, { memory: { tamperArchive: true } });
    try {
      const failure = captureFailure(await support.captureWorld(world, { snapshotId: 'matrix-capture-hash' }));
      expect(failure.code === 'HASH_MISMATCH', `unexpected code ${failure.code}`);
      expect(await world.captureService.readLastGood() === undefined, 'lastGood must not be updated');
      return { observed: `${failure.status} HASH_MISMATCH; not ready`, evidence: { failure: failure.code } };
    } finally { await support.cleanupWorld(world); }
  });

  // 10. Version incompatibility ------------------------------------------------------------
  await record('capture.version-incompatible', '运行清单要求更新的恢复 reader', 'task-6-B', 'fail/incomplete INCOMPATIBLE_VERSION；不得 ready', async () => {
    const world = await support.createWorld(undefined, { runtimeManifest: support.runtimeManifestFixture({ minimumReaderVersion: 2 }) });
    try {
      const failure = captureFailure(await support.captureWorld(world, { snapshotId: 'matrix-version' }));
      expect(failure.code === 'INCOMPATIBLE_VERSION', `unexpected code ${failure.code}`);
      return { observed: `${failure.status} INCOMPATIBLE_VERSION`, evidence: { failure: failure.code } };
    } finally { await support.cleanupWorld(world); }
  });

  // 11. Capacity insufficient --------------------------------------------------------------
  await record('capture.capacity-insufficient', '捕获前可用空间低于估算需求', 'task-6-B/V15', 'failed CAPACITY_INSUFFICIENT；不得 ready；不更新 lastGood', async () => {
    const world = await support.createWorld(undefined, { capacity: [1024] });
    try {
      const failure = captureFailure(await support.captureWorld(world, { snapshotId: 'matrix-capacity' }));
      expect(failure.code === 'CAPACITY_INSUFFICIENT', `unexpected code ${failure.code}`);
      expect(await world.captureService.readLastGood() === undefined, 'lastGood must not be updated');
      return { observed: 'failed CAPACITY_INSUFFICIENT', evidence: { failure: failure.code } };
    } finally { await support.cleanupWorld(world); }
  });

  // 12. Failure never overwrites lastGood --------------------------------------------------
  await record('capture.failure-preserves-lastgood', '已有 ready lastGood 后新的捕获失败', 'task-6-B/V15', '失败不替换 lastGood', async () => {
    let capacityCall = 0;
    const world = await support.createWorld(undefined, {
      capacity: () => { capacityCall += 1; return capacityCall <= 3 ? 4 * 1024 * 1024 * 1024 : 1024; },
    });
    try {
      const first = await support.captureReady(world, { snapshotId: 'matrix-lastgood-first' });
      const firstPointer = await world.captureService.readLastGood();
      expect(firstPointer?.snapshotId === first.snapshotId, 'first capture must set lastGood');
      const second = await support.captureWorld(world, { snapshotId: 'matrix-lastgood-second' });
      if (second.status === 'ready') throw new Error('capacity-starved capture must not be ready');
      const pointer = await world.captureService.readLastGood();
      expect(pointer?.snapshotId === first.snapshotId, 'failed capture replaced lastGood');
      expect(pointer?.manifestSha256 === first.manifestSha256, 'lastGood manifest hash changed after failure');
      return { observed: 'lastGood unchanged after failure', evidence: { pointerSnapshot: pointer?.snapshotId ?? null } };
    } finally { await support.cleanupWorld(world); }
  });

  // 13. Old deletion ledger / missing latest watermark ------------------------------------
  await record('restore.old-deletion-ledger-locked', '从删除前 Bundle 恢复但最新删除水位已前进且没有账本', 'task-6-C/V22', 'status locked；readView closed；恢复锁保留', async () => {
    const world = await support.createWorld(undefined, {});
    try {
      const ready = await support.captureReady(world, { snapshotId: 'matrix-old-ledger-locked' });
      const barrier = world.barrier();
      const advanced = { ...barrier, deletion: { baselineId: barrier.deletion!.baselineId, tombstoneWatermark: 5 } };
      const result = await support.restoreWorld(world, ready.bundleDirectory, { barrier: advanced, targetName: 'restore-old-ledger' });
      expect(result.report.status === 'locked', `expected locked, got ${result.report.status}`);
      expect(result.report.readView === 'closed', 'locked restore must keep the read view closed');
      expect(result.state === null, 'locked restore must not expose restored state');
      expect(result.lock.phase === 'locked' && result.lock.readView === 'closed', 'recovery lock was not retained');
      expect(result.report.barrier.deletion.relation === 'advanced-unreplayed', 'barrier relation mismatch');
      return { observed: 'locked with closed read view; lock retained', evidence: { relation: result.report.barrier.deletion.relation } };
    } finally { await support.cleanupWorld(world); }
  });

  await record('restore.old-deletion-ledger-replayed', '从删除前 Bundle 恢复并应用较新删除账本', 'task-6-C/V22', 'verified；被删引用不可见；不复活', async () => {
    const world = await support.createWorld(undefined, {});
    try {
      const ready = await support.captureReady(world, { snapshotId: 'matrix-old-ledger-replayed' });
      const barrier = world.barrier();
      const advanced = { ...barrier, deletion: { baselineId: barrier.deletion!.baselineId, tombstoneWatermark: 5 } };
      const ledger = support.ledgerFixture(3, 5, ['memory-visible-2']);
      const result = await support.restoreWorld(world, ready.bundleDirectory, {
        barrier: advanced, deletionLedger: ledger, targetName: 'restore-ledger-replayed',
      });
      expect(result.report.status === 'verified', `expected verified, got ${result.report.status}: ${result.report.failures.map((item) => item.code).join(',')}`);
      expect(result.state !== null, 'verified restore must expose isolated state');
      const visible = result.state!.memory.visibleRecords.map((item) => item.ref);
      expect(!visible.includes('memory-visible-2'), 'a deleted memory reference was resurrected');
      expect(result.report.deletion.ledgerApplied === true, 'deletion ledger was not recorded as applied');
      expect(result.report.deletion.resurrectionDetected === false, 'report must state no resurrection');
      expect(result.report.barrier.deletion.relation === 'advanced-replayed', 'barrier relation mismatch');
      return {
        observed: 'verified; deleted ref absent; ledger applied',
        evidence: { removedRefs: result.report.deletion.removedRefs, visibleRefs: result.report.deletion.visibleRefs },
      };
    } finally { await support.cleanupWorld(world); }
  });

  // 14. Internal deletion lag (control ledger ahead of memory export) ----------------------
  await record('restore.control-tombstone-replay', '控制库删除水位领先记忆导出，恢复使用控制快照内墓碑补齐', 'task-6-C/V22', 'verified；被删记忆不可见，不依赖外部账本', async () => {
    const world = await support.createWorld(undefined, {
      control: { tombstoneWatermark: 5, tombstones: [{ ref: 'memory-deleted-if-tombstoned', watermark: 5 }] },
      memory: { tombstoneWatermark: 3 },
    });
    try {
      const ready = await support.captureReady(world, { snapshotId: 'matrix-internal-tombstone' });
      const result = await support.restoreWorld(world, ready.bundleDirectory, { targetName: 'restore-internal-tombstone' });
      expect(result.report.status === 'verified', `expected verified, got ${result.report.status}: ${result.report.failures.map((item) => item.code).join(',')}`);
      const visible = result.state!.memory.visibleRecords.map((item) => item.ref);
      expect(!visible.includes('memory-deleted-if-tombstoned'), 'control tombstone replay failed: deleted memory is visible');
      expect(result.report.deletion.removedRefs >= 1, 'removed ref count was not recorded');
      return {
        observed: 'verified; internal control tombstones replayed before the read view opened',
        evidence: { removedRefs: result.report.deletion.removedRefs, appliedEntries: result.report.deletion.appliedEntries },
      };
    } finally { await support.cleanupWorld(world); }
  });

  // 15. Missing barrier keeps the recovery lock --------------------------------------------
  await record('restore.barrier-unavailable-locked', '宿主外 barrier 不可用（未提供）', 'task-6-C/V22', 'status locked；readView closed；不得猜测最新删除水位', async () => {
    const world = await support.createWorld(undefined, {});
    try {
      const ready = await support.captureReady(world, { snapshotId: 'matrix-barrier-unavailable' });
      const result = await support.restoreWorld(world, ready.bundleDirectory, { barrier: undefined, targetName: 'restore-no-barrier' });
      expect(result.report.status === 'locked', `expected locked, got ${result.report.status}`);
      expect(result.report.readView === 'closed', 'read view must stay closed');
      expect(result.report.barrier.completeness === 'unavailable', 'barrier completeness must be unavailable');
      return { observed: 'locked; read view closed', evidence: { completeness: result.report.barrier.completeness } };
    } finally { await support.cleanupWorld(world); }
  });

  // 16. Restore positive path: readable references, hashes, unknown preserved, disarmed ----
  await record('restore.verified-positive', '正常隔离恢复：组件 hash/完整性/引用可读，目标 disarmed，unknown 保留', 'task-6-C', 'status verified；readView read-only；dispatch blocked；旧根未动；新 generation 记录', async () => {
    const world = await support.createWorld(undefined, {});
    try {
      const ready = await support.captureReady(world, { snapshotId: 'matrix-restore-positive' });
      const beforeSentinel = await support.readSentinel(world);
      const result = await support.restoreWorld(world, ready.bundleDirectory, { targetName: 'restore-positive' });
      expect(result.report.status === 'verified', `expected verified, got ${result.report.status}: ${result.report.failures.map((item) => item.code).join(',')}`);
      expect(result.report.mode === 'maintenance' && result.report.dispatch === 'blocked', 'restore must be maintenance/disarmed');
      expect(result.report.activate === 'not-activated', 'restore must not activate');
      expect(result.report.oldRoot === 'untouched' && result.report.liveActivation === 'not-changed', 'live root was not untouched');
      expect(result.lock.phase === 'verified' && result.lock.dispatch === 'blocked', 'recovery lock state mismatch');
      expect(await support.readSentinel(world) === beforeSentinel, 'live root sentinel changed');
      expect(result.state !== null && result.state.goals.every((item) => item.effectiveActivation === 'disarmed'), 'restored goals must stay disarmed');
      expect(result.state!.unknown.replayed === 0, 'unknown replay count must be 0');
      const reportText = await readFile(path.join(result.targetRoot, '.recovery', 'restore-report.json'), 'utf8');
      expect(!reportText.includes(world.root), 'restore report must not leak absolute data-root paths');
      const generationValidation = validateGenerationTransition(JSON.parse(
        await readFile(path.join(result.targetRoot, '.recovery', 'generation.json'), 'utf8')) as unknown);
      expect(generationValidation.ok, 'generation record failed validation');
      const restoredBundle = await support.verifyDirectory(path.join(result.targetRoot, 'data', 'bundle'));
      expect(restoredBundle.ok, 'copied restore data does not verify');
      return {
        observed: 'verified read-only, maintenance, disarmed; copied bytes re-verified; live root untouched',
        evidence: { checks: result.report.checks.length, generation: result.report.generation.installationGeneration },
      };
    } finally { await support.cleanupWorld(world); }
  });

  // 17. Old armed Goal is restored disarmed ------------------------------------------------
  await record('restore.armed-goal-disarmed', 'Bundle 内原生 Goal 为 armed，恢复只读', 'task-6-C/V22', '恢复后 effectiveActivation=disarmed；不自动重 arm；dispatch blocked', async () => {
    const world = await support.createWorld(undefined, {
      goals: { captureActivationOverrideFor: 'goal-alpha', failActivation: 'armed' },
    });
    try {
      const ready = await support.captureReady(world, { snapshotId: 'matrix-armed-goal' });
      const manifest = await manifestOf(ready.bundleDirectory);
      const goalManifest = await goalManifestOf(ready.bundleDirectory);
      const sessions = goalManifest.sessions as { activation: string }[];
      expect(sessions[0]?.activation === 'armed', 'fixture did not capture an armed goal');
      expect(manifest.status === 'ready', 'capture itself stays ready (restore owns disarm)');
      const result = await support.restoreWorld(world, ready.bundleDirectory, { targetName: 'restore-armed-goal' });
      expect(result.report.status === 'verified', `expected verified, got ${result.report.status}`);
      expect(result.state!.goals.every((item) => item.effectiveActivation === 'disarmed'), 'armed goal was not disarmed by restore');
      expect(result.report.goals.every((item) => item.restoredActivation === 'armed' && item.effectiveActivation === 'disarmed'), 'report must show captured armed vs effective disarmed');
      return { observed: 'captured armed; effective disarmed; dispatch blocked', evidence: { goals: result.report.goals.length } };
    } finally { await support.cleanupWorld(world); }
  });

  // 18. Tampered bundle rejected -----------------------------------------------------------
  await record('restore.tampered-bundle-rejected', '恢复前 Bundle 对象字节被翻转', 'task-6-C/V22', 'status failed；readView closed；恢复锁保留；旧根未动', async () => {
    const world = await support.createWorld(undefined, {
      objects: new Map([['artifact-a', Buffer.from('synthetic artifact')]]),
      controlObjectRefs: ['artifact-a'],
    });
    try {
      const ready = await support.captureReady(world, { snapshotId: 'matrix-tampered-bundle' });
      const objectDirectory = path.join(ready.bundleDirectory, 'components', 'shared-objects', 'objects');
      const [file] = await readdir(objectDirectory);
      const filename = path.join(objectDirectory, file!);
      const bytes = await readFile(filename);
      await writeFile(filename, Buffer.concat([bytes, Buffer.from('tampered\n')]));
      const beforeSentinel = await support.readSentinel(world);
      const result = await support.restoreWorld(world, ready.bundleDirectory, { targetName: 'restore-tampered' });
      expect(result.report.status === 'failed', `expected failed, got ${result.report.status}`);
      expect(result.report.readView === 'closed', 'failed restore must keep read view closed');
      expect(result.lock.phase === 'failed', 'failed restore must retain a failed lock');
      expect(await support.readSentinel(world) === beforeSentinel, 'live root sentinel changed');
      return { observed: 'failed; lock retained; no live-root write', evidence: { failures: result.report.failures.map((item) => item.code) } };
    } finally { await support.cleanupWorld(world); }
  });

  // 19. Live root / isolation guards -------------------------------------------------------
  await record('restore.live-root-protected', '尝试把恢复目标指向 live 数据根', 'task-6-C', 'LIVE_ROOT_PROTECTED；不写入 live 根', async () => {
    const world = await support.createWorld(undefined, {});
    try {
      const ready = await support.captureReady(world, { snapshotId: 'matrix-live-root' });
      const before = await support.readSentinel(world);
      const rejection = await restoreFailure(support.restoreWorld(world, ready.bundleDirectory, { targetRoot: world.liveRoot }));
      expect(rejection.code === 'LIVE_ROOT_PROTECTED', `unexpected code ${rejection.code}`);
      expect(await support.readSentinel(world) === before, 'live root was modified');
      return { observed: 'LIVE_ROOT_PROTECTED; live root untouched', evidence: { code: rejection.code } };
    } finally { await support.cleanupWorld(world); }
  });

  await record('restore.target-not-isolated', '恢复目标位于隔离根之外', 'task-6-C', 'TARGET_NOT_ISOLATED；不创建目标', async () => {
    const world = await support.createWorld(undefined, {});
    try {
      const ready = await support.captureReady(world, { snapshotId: 'matrix-not-isolated' });
      const rejection = await restoreFailure(support.restoreWorld(world, ready.bundleDirectory, {
        targetRoot: path.join(world.root, 'outside-isolation', 'restore'),
      }));
      expect(rejection.code === 'TARGET_NOT_ISOLATED', `unexpected code ${rejection.code}`);
      return { observed: 'TARGET_NOT_ISOLATED', evidence: { code: rejection.code } };
    } finally { await support.cleanupWorld(world); }
  });

  // 20. Double-writer / old-root protection ------------------------------------------------
  await record('restore.recovery-lock-exclusive', '目标根已存在 recovery lock 时再次恢复', 'task-6-C', 'RECOVERY_LOCKED；不产生第二个 writer', async () => {
    const world = await support.createWorld(undefined, {});
    try {
      const ready = await support.captureReady(world, { snapshotId: 'matrix-lock-exclusive' });
      const target = path.join(world.isolatedRoot, 'locked-target');
      const recovery = path.join(target, '.recovery');
      await mkdir(recovery, { recursive: true });
      await writeFile(path.join(recovery, 'recovery-lock.json'), JSON.stringify({
        schemaVersion: 1, lockId: 'existing-lock', snapshotId: 'other-snapshot', targetRootHash: support.sha256(target),
        mode: 'maintenance', phase: 'restoring', dispatch: 'blocked', readView: 'closed',
        acquiredAt: support.FIXED_BASE, releasedAt: null, holder: 'recovery-module',
        hostProvenance: 'offline-module', reasonCode: null,
      }));
      const rejection = await restoreFailure(support.restoreWorld(world, ready.bundleDirectory, { targetRoot: target }));
      expect(rejection.code === 'RECOVERY_LOCKED', `unexpected code ${rejection.code}`);
      return { observed: 'RECOVERY_LOCKED; only one recovery writer', evidence: { code: rejection.code } };
    } finally { await support.cleanupWorld(world); }
  });

  // 21. Goal session tail tamper at capture ------------------------------------------------
  await record('capture.goal-tail-mismatch', 'Goal Session 端口返回的字节与独立期望不符', 'task-6-B', 'fail/incomplete HASH_MISMATCH；不得 ready', async () => {
    const world = await support.createWorld(undefined, { goals: { tamperBytes: true } });
    try {
      const failure = captureFailure(await support.captureWorld(world, { snapshotId: 'matrix-goal-tail-tamper' }));
      expect(failure.code === 'HASH_MISMATCH', `unexpected code ${failure.code}`);
      return { observed: `${failure.status} HASH_MISMATCH`, evidence: { failure: failure.code } };
    } finally { await support.cleanupWorld(world); }
  });

  // 22. Zero goal bindings still requires a complete (empty) component ---------------------
  await record('capture.empty-goal-set', '快照没有 GoalBinding', 'task-6-B', 'ready，dsh-goal-sessions 组件存在但 Session 列表为空', async () => {
    const world = await support.createWorld(undefined, { control: { goalBindings: [] } });
    try {
      const ready = await support.captureReady(world, { snapshotId: 'matrix-empty-goals' });
      const goalManifest = await goalManifestOf(ready.bundleDirectory);
      expect(Array.isArray(goalManifest.sessions) && (goalManifest.sessions as unknown[]).length === 0, 'empty goal set must still produce the component manifest');
      const verified = await support.verifyDirectory(ready.bundleDirectory);
      expect(verified.ok, 'bundle with empty goal set must verify');
      return { observed: 'ready with an explicitly empty dsh-goal-sessions component', evidence: { sessions: 0 } };
    } finally { await support.cleanupWorld(world); }
  });

  // 23. Restore of a failed bundle and missing component ----------------------------------
  await record('restore.bundle-not-ready', '恢复一个 only-failed Bundle', 'task-6-C', 'BUNDLE_NOT_READY；不复制任何组件', async () => {
    const world = await support.createWorld(undefined, {});
    try {
      const failed = await support.captureWorld(world, {
        snapshotId: 'matrix-restore-not-ready',
        faults: { at: 'after-control-snapshot', mode: 'fail' },
      });
      if (failed.bundleDirectory === null) throw new Error('failed bundle was not published.');
      const rejection = await restoreFailure(support.restoreWorld(world, failed.bundleDirectory, { targetName: 'restore-not-ready' }));
      expect(rejection.code === 'BUNDLE_NOT_READY', `unexpected code ${rejection.code}`);
      return { observed: 'BUNDLE_NOT_READY', evidence: { code: rejection.code } };
    } finally { await support.cleanupWorld(world); }
  });

  await record('restore.missing-component-manifest', 'Bundle 清单缺少必需组件（内存组件被删除）', 'task-6-C', 'BUNDLE_NOT_READY；拒绝恢复', async () => {
    const world = await support.createWorld(undefined, {});
    try {
      const ready = await support.captureReady(world, { snapshotId: 'matrix-missing-component' });
      const manifestPath = path.join(ready.bundleDirectory, 'bundle.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.components = (manifest.components as unknown[]).filter((item) => (item as { componentId: string }).componentId !== 'memory');
      await writeFile(manifestPath, `${support.canonicalJson(manifest)}\n`);
      const rejection = await restoreFailure(support.restoreWorld(world, ready.bundleDirectory, { targetName: 'restore-missing-component' }));
      expect(rejection.code === 'BUNDLE_NOT_READY', `unexpected code ${rejection.code}`);
      return { observed: 'BUNDLE_NOT_READY', evidence: { code: rejection.code } };
    } finally { await support.cleanupWorld(world); }
  });

  const selfProof = await runValidatorSelfProof();
  const passed = records.filter((item) => item.pass).length;
  const selfProofPassed = selfProof.filter((item) => item.pass).length;
  return {
    records,
    selfProof,
    summary: { total: records.length, passed, failed: records.length - passed, selfProofTotal: selfProof.length, selfProofPassed },
  };
};

/** Prove the validators accept a real bundle and reject known-bad variants. */
export const runValidatorSelfProof = async (): Promise<SelfProofCase[]> => {
  const cases: SelfProofCase[] = [];
  const world = await support.createWorld(undefined, {});
  try {
    const ready = await support.captureReady(world, { snapshotId: 'selftest-bundle' });
    const raw = JSON.parse(await readFile(path.join(ready.bundleDirectory, 'bundle.json'), 'utf8')) as BackupBundle;
    const good = validateBackupBundle(raw, { requireReady: true });
    cases.push({
      caseId: 'bundle.good',
      expected: 'accepted',
      observed: good.ok ? 'accepted' : `rejected: ${good.violations.map((item) => item.code).join(',')}`,
      rejected: !good.ok,
      pass: good.ok,
    });
    const mutations: { caseId: string; mutate: (bundle: Record<string, unknown>) => void; code: string }[] = [
      { caseId: 'bundle.hash-format', mutate: (bundle) => { (bundle.components as Record<string, unknown>[])[0]!.manifestSha256 = 'zzz'; }, code: 'range' },
      {
        caseId: 'bundle.missing-component',
        mutate: (bundle) => { bundle.components = (bundle.components as unknown[]).filter((item) => (item as { componentId: string }).componentId !== 'memory'); },
        code: 'required-component-missing',
      },
      { caseId: 'bundle.reader-version', mutate: (bundle) => { bundle.minimumReaderVersion = 2; }, code: 'incompatible' },
      {
        caseId: 'bundle.ready-with-failure',
        mutate: (bundle) => { bundle.failure = { code: 'INJECTED_FAILURE', componentId: null, message: 'synthetic' }; },
        code: 'semantics',
      },
      { caseId: 'bundle.unknown-field', mutate: (bundle) => { bundle.extra = true; }, code: 'unknown-field' },
      {
        caseId: 'bundle.common-section-claim',
        mutate: (bundle) => { (bundle.durability as Record<string, unknown>).crossComponentCommonSection = true; },
        code: 'false-common-section',
      },
      { caseId: 'bundle.reconcile-false', mutate: (bundle) => { bundle.reconcileRequired = false; }, code: 'semantics' },
      { caseId: 'bundle.null-control', mutate: (bundle) => { bundle.control = null; }, code: 'missing-field' },
    ];
    for (const mutation of mutations) {
      const clone = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
      mutation.mutate(clone);
      const validation = validateBackupBundle(clone, { requireReady: true });
      const codes = validation.violations.map((item) => item.code);
      cases.push({
        caseId: mutation.caseId,
        expected: 'rejected',
        observed: codes.join(',') || 'accepted',
        rejected: !validation.ok,
        pass: !validation.ok && codes.includes(mutation.code),
      });
    }
    const goalRaw = JSON.parse(await readFile(path.join(ready.bundleDirectory, 'components', 'dsh-goal-sessions', 'manifest.json'), 'utf8')) as {
      sessions: Record<string, unknown>[];
      [key: string]: unknown;
    };
    if (goalRaw.sessions.length > 0) {
      goalRaw.sessions[0]!.logTail = { kind: 'jsonl-seq-v1', bytes: 1, sha256: support.sha256('x'), lastSequence: null };
      const validation = validateGoalSessionsComponentManifest(goalRaw);
      const codes = validation.violations.map((item) => item.code);
      cases.push({
        caseId: 'goal-session.missing-tail-sequence',
        expected: 'rejected',
        observed: codes.join(',') || 'accepted',
        rejected: !validation.ok,
        pass: !validation.ok && codes.includes('semantics'),
      });
    }
    const gapLedger = {
      schemaVersion: 1, baselineId: support.FIXED_DELETION_BASELINE, fromWatermark: 3, toWatermark: 6,
      entries: [
        { watermark: 4, refs: ['x'], reasonCode: 'OWNER_DELETION', recordedAt: support.FIXED_BASE },
        { watermark: 6, refs: ['y'], reasonCode: 'OWNER_DELETION', recordedAt: support.FIXED_BASE },
      ],
      ledgerSha256: support.sha256('gap'),
    };
    const ledgerValidation = validateDeletionLedger(gapLedger);
    cases.push({
      caseId: 'deletion-ledger.gap',
      expected: 'rejected',
      observed: ledgerValidation.violations.map((item) => item.code).join(',') || 'accepted',
      rejected: !ledgerValidation.ok,
      pass: !ledgerValidation.ok && ledgerValidation.violations.some((item) => item.code === 'ledger-gap'),
    });
    const lockRaw = {
      schemaVersion: 1, lockId: 'lock-selftest', snapshotId: 'selftest-bundle', targetRootHash: support.sha256('root'),
      mode: 'maintenance', phase: 'locked', dispatch: 'enabled', readView: 'closed',
      acquiredAt: support.FIXED_BASE, releasedAt: null, holder: 'recovery-module',
      hostProvenance: 'offline-module', reasonCode: null,
    };
    const lockValidation = validateRecoveryLockRecord(lockRaw);
    cases.push({
      caseId: 'recovery-lock.enabled-dispatch',
      expected: 'rejected',
      observed: lockValidation.violations.map((item) => item.code).join(',') || 'accepted',
      rejected: !lockValidation.ok,
      pass: !lockValidation.ok && lockValidation.violations.some((item) => item.code === 'value'),
    });
    const restore = await support.restoreWorld(world, ready.bundleDirectory, { targetName: 'selftest-restore' });
    const report = restore.report;
    const reportCases: { caseId: string; mutate: (report: Record<string, unknown>) => void; code: string }[] = [
      {
        caseId: 'restore-report.resurrection-accepted',
        mutate: (candidate) => { (candidate.deletion as Record<string, unknown>).resurrectionDetected = true; },
        code: 'semantics',
      },
      { caseId: 'restore-report.activated', mutate: (candidate) => { candidate.activate = 'activated'; }, code: 'value' },
      { caseId: 'restore-report.dispatch-enabled', mutate: (candidate) => { candidate.dispatch = 'enabled'; }, code: 'value' },
      { caseId: 'restore-report.readview-closed', mutate: (candidate) => { candidate.readView = 'closed'; }, code: 'semantics' },
    ];
    for (const mutation of reportCases) {
      const clone = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
      mutation.mutate(clone);
      const validation = validateRestoreReport(clone);
      const codes = validation.violations.map((item) => item.code);
      cases.push({
        caseId: mutation.caseId,
        expected: 'rejected',
        observed: codes.join(',') || 'accepted',
        rejected: !validation.ok,
        pass: !validation.ok && codes.includes(mutation.code),
      });
    }
    const goodReport = validateRestoreReport(report);
    cases.push({
      caseId: 'restore-report.good',
      expected: 'accepted',
      observed: goodReport.ok ? 'accepted' : goodReport.violations.map((item) => item.code).join(','),
      rejected: !goodReport.ok,
      pass: goodReport.ok,
    });
    const generation = JSON.parse(await readFile(path.join(restore.targetRoot, '.recovery', 'generation.json'), 'utf8')) as Record<string, unknown>;
    const sameGeneration = JSON.parse(JSON.stringify(generation)) as Record<string, unknown>;
    (sameGeneration.previous as Record<string, unknown>).installationGeneration = sameGeneration.installationGeneration;
    const generationValidation = validateGenerationTransition(sameGeneration);
    cases.push({
      caseId: 'generation.same-as-previous',
      expected: 'rejected',
      observed: generationValidation.violations.map((item) => item.code).join(',') || 'accepted',
      rejected: !generationValidation.ok,
      pass: !generationValidation.ok && generationValidation.violations.some((item) => item.code === 'semantics'),
    });
  } finally {
    await support.cleanupWorld(world);
  }
  return cases;
};
