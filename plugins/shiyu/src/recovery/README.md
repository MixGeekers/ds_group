# 本地检查点与隔离恢复模块（H5-B1 · 离线）

状态：**离线模块已实现并离线通过（G1）；H5b 已提供 Runtime 组合层适配与 owner-only 命令的精确集成 diff，但 runtime.ts 由 Lead 落、本切片未接线；未做 live 修复、独立故障域或 V22/V27 完整验收。** 证据见
[`artifacts/dsh/h5/`](../../artifacts/dsh/h5/)；需求来源为[交接 02 §6.9](<../../../../架构与设计/DSH交接/02-测试设计与验收标准.md#69-检查点迁移长期运行与恢复>)、
[A方案 05-宿主外恢复](<../../../../架构与设计/A方案全景/05-宿主外恢复/README.md>)、
[06-预留空间/08-本地检查点](<../../../../架构与设计/A方案全景/06-预留空间/08-本地检查点/README.md>)、
[07-独立备份](<../../../../架构与设计/A方案全景/07-独立备份/README.md>) 与 task-6。

本切片是**离线模块 + 合成后端**：捕获/恢复只在人工指定的 staging 根与隔离临时根内发生；测试只使用临时真实 SQLite/文件。
它不读/写 live 数据根、不读 live 原生 Session 正文、不调用模型、不连接真实设备或渠道，也**不证明**独立故障域、RPO/RTO、
宿主原生 Goal 行为或跨组件共同截面。恢复后只到 `maintenance`/`disarmed` 的离线校验层，不激活任何数据根。

## 1. 文件与职责

| 文件 | 职责 |
|---|---|
| `types.ts` | BackupBundle / 组件清单 / staging journal / last-good / recovery-lock / generation / restore report / barrier / deletion ledger 等严格类型与常量 |
| `errors.ts` | 稳定失败码（`RecoveryError.code`） |
| `ports.ts` | 注入端口：ControlSourcePort、GoalSessionPort、MemoryExportPort、SharedObjectPort、CapacityProbe、Clock、RecoveryBarrierPort、DeletionLedgerPort |
| `control-facts.ts` | 从**完成的控制 SQLite 快照**只读读取 commitSeq / stateVersion / authEpoch / tombstoneWatermark / GoalBinding / 在途操作 / 删除墓碑；缺必需水位即 `MISSING_WATERMARK` |
| `schema.ts` | 严格 schema + 语义校验（未知字段、时间、hash 格式、版本、必需组件、ready 前置条件、lock/generation/report 组合约束） |
| `files.ts` | fsync/rename 原子写、hash、canonical JSON、路径围栏、SQLite 只读完整性检查、JSONL 读取 |
| `verify.ts` | 从真实字节复核 bundle：文件 hash/大小、SQLite `quick_check`+`foreign_key_check`、Goal 日志 tail/序列、projection digest、GoalBinding 闭包、共享对象引用闭包、顶层 captureTime 规则 |
| `capture.ts` | `CheckpointCaptureService.capture()`：控制库 `node:sqlite backup` → Goal Session 只读端口复制 → 记忆导出端口 → 共享对象 pin/复制 → 双层清单 → 自检 → 原子发布；失败不覆盖 lastGood |
| `restore.ts` | `IsolatedRestoreService.restore()`：隔离根恢复锁、维护/disarmed、复制后再次复核、barrier/删除水位判定、墓碑重放、新 generation、restore report；缺水位保持锁 |
| `index.ts` | 公共导出（未从 `src/index.ts` 或 Runtime 导出，保持本切片离线） |

## 2. 核心契约

### 2.1 双层清单

顶层 `BackupBundle` 记录：`snapshotId`、`rootId`、`captureTime`（**保守最早组件捕获时间**）、`completedAt`、`bundleSchemaVersion`、
`minimumReaderVersion`、`runtimeManifest`、`control.{commitSeq,stateVersion,tombstoneWatermark,deletionBaselineId,authorizationEpoch}`、
`generation`、`components[]`、`objectManifestRef/hash`、`durability.{crossComponentCommonSection:false,perComponent[]}`、
`status`、`reconcileRequired`、`failure`。

每个组件（`control`、`dsh-goal-sessions`、`memory`、`shared-objects`）另有自己的 manifest 文件，由顶层 `manifestRef`+
`manifestSha256` 引用；组件 manifest 内含实际数据文件、实际水位/可核验 revision、captureTime、quiescence evidence。
**组件逐库一致不会被写成跨组件共同截面**：`durability.crossComponentCommonSection` 类型/校验固定为 `false`，
ready Bundle 的 `reconcileRequired` 固定为 `true`。

`control`/`runtimeManifest`/`generation`/`objectManifest` 在 failed/incomplete 清单中允许为 `null`（失败时不得伪造水位）；
ready 前置条件要求四者非空且四个必需组件齐全、全部 `complete`、版本可读。

Bundle 状态机（published 清单只有后三种；`creating` 只存在于 `.partial` staging journal，永不发布）：

```
creating（staging journal 中，不可发布）
   ├─ 全部组件+水印+hash+版本通过 → ready（唯一允许更新 lastGood 的状态）
   ├─ 必需事实缺失但清单仍可校验 → incomplete（只作证据，不 ready，不更新 lastGood）
   └─ hash/容量/版本/自检等确定失败 → failed（同上）
lastGood 规则：只有 ready 且通过 verifyBundleDirectory 自检的 Bundle 才原子写 last-good.json；
             任何 failed/incomplete/中断都不替换 lastGood；同一 snapshotId 的 ready 重发为幂等读取。
```

### 2.2 ready 判定（缺一不可）

- 四个必需组件全部存在、`status=complete`、`failureCodes` 为空；
- 每个组件具备 `watermark` 或可核验 `actualRevision`；
- 控制水位的 commitSeq / stateVersion / tombstoneWatermark / deletionBaselineId / authorizationEpoch 全部来自**完成快照**；
- 目标 Session 日志逐 Session 有实际字节 hash、持久尾标识（能证明的 seq 或 opaque 尾 + API 限制说明）、GoalRef、
  phase/armed、flush 证据、projection 定义/config digest 与兼容版本；
- 记忆组件有导出 archive、记录索引、水位与引用闭包；共享对象全部存在且 hash/size 匹配；
- 文件级复核通过（hash、SQLite quick_check/foreign_key_check、闭包）；
- `bundleSchemaVersion`/`minimumReaderVersion`/组件 `dataSchema` 与 reader 兼容；
- `captureTime == min(components[].capturedAt)` 且 `captureTime <= completedAt`。

`verifyBundleDirectory()` 是 capture 发布前的自检门，也是 restore 的重新复核门：它**不信任清单自述**，从落盘字节重算。

### 2.3 版本与根

- `bundleSchemaVersion` 当前为 1；`minimumReaderVersion` 大于 reader 版本 → `INCOMPATIBLE_VERSION`。
- `runtimeManifest.components[]` 为组件版本向量（`componentId/version/upstreamCommit/patchDigest/dataSchema/minimumReaderVersion`）；
  capture 要求 `dsh`、`shiyu-plugin`、`projection`、`control-store`、`memory-backend`、`object-store` 条目，并逐组件检查 dataSchema/reader 兼容。
- `rootId` 为数据根身份 sha256；capture 要求与 control 端口 lease 一致，restore 可用 `expectedRootId` 拒绝错误根。

## 3. 端口注入（未来 Runtime 集成点）

本模块**不拥有**任何 live 资源；Runtime 侧组合负责实现端口并保证其前置条件。所有端口都是只读/导出语义，
不提供写 live 数据的通道。

| 端口 | Runtime 侧实现要求 |
|---|---|
| `Clock` | 测试用可推进假时钟；生产用系统时钟。所有时间字段要求 canonical UTC。 |
| `CapacityProbe.freeBytes(path)` | 读取 staging 所在卷可用字节；capture 在开始、组件间、发布前检查估算 + reserve。`estimatedBytes` 由调用方按控制库（含 WAL）与对象副本等已知需求估算；模块在开始与发布前 fail-closed，不做静默降级。 |
| `ControlSourcePort.acquire()` | 先冻结目标写者或进入维护窗口，再返回 `ControlSourceLease{databasePath,rootId,generation,runtimeManifest,quiescenceEvidence,objectRefs,release}`。**返回 lease 本身不证明已静默**，只记录其证据；capture 用只读连接 + `node:sqlite backup` 取快照。 |
| `GoalSessionPort.prepareCapture(goalIds)` | 由控制快照读出的 GoalBinding 集合调用；等宿主 flush 后返回精确 durable bytes、`durableTail`、`flush`、`goalRef`、`phase/activation`、projection 定义/config 与插件版本。缺失任一 goalId → Bundle 不 ready。真实 DSH 日志若无可证明序号，用 `logFormat:'opaque'` + `lastSequence:null`，不得编造。 |
| `MemoryExportPort.export({stagingDirectory})` | 复用 Ombre 等组件既有导出（archive + 自身 manifest/闭包）；返回 archive、记录索引、水位、objectRefs。合成实现仅用于测试。 |
| `SharedObjectPort.read(objectId)` | 按 objectId 返回精确字节与独立期望 hash/size；缺失/冲突 → 不 ready。 |
| `RecoveryBarrierPort.readLatest(...)` / `DeletionLedgerPort.readSince(...)` | 宿主外可信控制记录读最新删除水位/授权 epoch/desiredState，以及跨越快照水位的删除账本。缺失或不足 → restore 保持恢复锁。 |

Runtime 接入时必须同时满足：单 writer/唯一有效数据根、staging 不在 live 根内、捕获期间的真实静默证据、
恢复只进入隔离新根且不自动切换激活指针。本切片不实现这些宿主行为。

### 3.1 后续 Runtime 集成点（本切片**未实现**）

| 集成点 | 归属 | 本切片状态 |
|---|---|---|
| 触发/调度：谁在何时调用 `capture()`（设计建议每 5 分钟一次、由恢复/备份统一调度，不另建第二套周期任务） | Runtime + 恢复/备份调度 | 未实现；模块只暴露 `capture()`，无 timer、无后台任务 |
| control DB 路径与写者静默：single-writer 持有者提供只读路径，并在维护窗口/静默屏障后调用 | Runtime `ControlStore` 生命周期 | 未接 live；测试用临时真实 SQLite |
| Goal Session 只读端口：宿主 flush + 精确持久路径/尾 + projection 配置 | DSH `sessions`/`sessionPersistence`/`sessionProjections` 适配 | 未接 live；测试用合成 JSONL |
| memory export：Ombre 原生导出（archive + 自身 manifest/闭包） | Ombre 适配 | 未接真实 Ombre；测试用合成 archive/index |
| shared objects：不可变对象读取与 pin | ObjectStore | 未接 live；测试用内存对象 |
| 隔离恢复根与 quarantine：由恢复入口提供全新隔离目录，禁止 live 根与旧根 | RecoveryCoordinator | 模块强制路径围栏；真实根选择/创建由 Runtime 给出 |
| generation / hostEpoch 写入：恢复只生成离线记录（`verifiedByHost:false`），真正的宿主代际由宿主生命周期写入 | 宿主生命周期 + 恢复入口 | 只写离线 generation 记录，不伪造宿主行为 |
| reconcile 屏障与激活：恢复后 `reconcileRequired=true`、`dispatch=blocked`、`not-activated`；显式激活/切换 active root 是恢复入口的独立步骤 | 恢复入口/任务核对 | **未实现，不在本切片范围** |
| 独立备份复制/加密/离线凭据（restic 等） | 独立备份 | 未实现；本模块只产本地 Bundle |


## 4. 捕获状态机

```
started → capacity-checked → control-snapshot → goal-sessions → memory-export → shared-objects
        → manifest-built（写 ready 清单）→ publishing（自检后 rename）→ published
```

- staging 目录：`{stagingRoot}/bundles/{snapshotId}.partial/`，完成时同文件系统 `rename` 到 `bundles/{snapshotId}`；
  只有通过自检的 ready Bundle 才原子更新 `{stagingRoot}/last-good.json`。
- 任何必需组件/水位/日志尾/projection/对象闭包/hash/容量/版本失败 → 清单写为 `failed|incomplete` 并保留证据，
  **不更新 lastGood、不冒充 ready**；`lastGood` 只由后续通过的 ready capture 替换。
- 确定性中断注入（模拟进程在发布前死亡）只保留 `.partial` + `capture-journal.json`；同一 snapshotId 再次调用返回
  `STAGING_INTERRUPTED`，不会静默续跑；新 snapshotId 才能重新捕获。
- 同一 snapshotId 已有 ready 发布时为幂等读取，不重复写入。
- 顶层 `captureTime` 取组件捕获时间的保守最早值，绝不用发布完成时间；`completedAt` 是发布前时间。

## 5. 恢复状态机

```
（前置）验证 bundle 清单 + expectedRootId/expectedSnapshotId
  → 创建隔离 targetRoot（必须为空；live 根/隔离根外/非绝对路径直接拒绝）
  → 独占 recovery lock（maintenance, dispatch=blocked, readView=closed）
  → 从真实字节复核 bundle → 复制到 target/data/bundle → 再次复核（hash/integrity/closure/tail）
  → 读取恢复后控制库事实（水位/in-flight）并与清单核对
  → barrier：最新删除水位/授权 epoch/desiredState
       ├─ 不完整/缺失/过期/baseline 不符/未提供 → phase=locked，readView=closed，保留锁
       ├─ 前进且提供连续可校验删除账本 → 重放后 readView=read-only
       └─ 相等 → readView=read-only
  → 控制快照内墓碑补齐（记忆导出水位落后于控制删除水位时）
  → 记忆引用可读性 + 删除不复活核对
  → 写新 installationGeneration/hostEpoch（verifiedByHost=false）+ activation(not-activated, maintenance)
  → phase=verified，readView=read-only，dispatch 仍 blocked
```

- 恢复目标永远 `maintenance`、`dispatch=blocked`、`activate=not-activated`；旧 armed Goal 快照只作为证据，
  `effectiveActivation` 固定 `disarmed`，不自动重 arm、不自动派工。
- unknown 操作不重放：本模块没有任何派发端口；恢复后从恢复数据库重新读取 in-flight 状态并与捕获清单核对，
  report 记录 `unknown.preserved` 且 `replayed: 0`。
- 缺少最新删除水位/授权水位、账本不连续/被篡改、副本 hash 不符、组件缺失 → 保持恢复锁与 readView 关闭；
  失败不切换 active root、不删除旧根或最后良好副本。失败/locked 的隔离 target 根保留为 **quarantine 证据**：
  `.recovery/recovery-lock.json` 的 phase 为 `failed|locked`，不会被当作可读取实例，也不自动清理或激活。
- 只有在隔离根且全部检查通过的恢复才输出 `status=verified`；新 generation 记录标注 `offline-module`、`verifiedByHost=false`，
  **不伪造宿主重载/重启行为**。`restore-report.json` 只含 targetRootHash，不含绝对数据根路径。

## 6. 失败 / unknown 判定摘要

| 条件 | 失败码 | capture | restore |
|---|---|---|---|
| 控制库缺 commit/stateVersion/authEpoch/删除水位/墓碑表 | `MISSING_WATERMARK` / `DELETION_*` | incomplete，不 ready | 保持锁 |
| GoalBinding 缺 Session 日志 | `MISSING_GOAL_SESSION` | incomplete | 拒绝该 Bundle |
| projection 定义/config 缺失或 digest 不符 | `MISSING_PROJECTION` | incomplete | failed/锁 |
| 日志尾/序列/flush 证据缺失或不一致 | `MISSING_LOG_TAIL` | incomplete | failed/锁 |
| GoalRef revision/phase/activation 与日志或控制绑定不符 | `GOAL_REF_MISMATCH` | incomplete | failed |
| 组件/对象 hash、大小不符或对象缺失 | `HASH_MISMATCH` / `OBJECT_CLOSURE_INCOMPLETE` | failed/incomplete | failed（锁保留） |
| 版本/reader/dataSchema 不兼容 | `INCOMPATIBLE_VERSION` | failed/incomplete | 拒绝恢复 |
| 空间不足 | `CAPACITY_INSUFFICIENT` | failed，不 ready，不覆盖 lastGood | — |
| staging 中断 | `STAGING_INTERRUPTED` | incomplete，partial 保留 | — |
| bundle 非 ready / 缺组件 | — | — | `BUNDLE_NOT_READY`（不创建目标） |
| 根/目标不符或越界 | `ROOT_MISMATCH` / `TARGET_NOT_ISOLATED` / `LIVE_ROOT_PROTECTED` / `TARGET_NOT_FRESH` | — | 拒绝，不写 live 根 |
| 已有恢复锁/第二个 writer | `RECOVERY_LOCKED` | — | 拒绝 |
| 最新删除账本缺失/不连续/篡改/过期 | `DELETION_LEDGER_INVALID` / `DELETION_WATERMARK_STALE` | — | locked/failed，readView 关闭 |

unknown 的语义：恢复**不会**把 unknown 变成 succeeded，也不会因恢复重新派发；测试通过独立读取恢复库状态验证不变。
“副本可读取”“任务可核对”“允许恢复动作”是不同结论；本模块只到“隔离副本校验 + 任务/删除核对”，不授予激活。

## 7. 测试与证据

根级测试（纳入 `npm test` 主 glob）：

| 文件 | 覆盖 |
|---|---|
| `tests/recovery-schema.test.ts` | 严格 schema/ready 前置、组件清单负例、逐文件字节篡改检测、lock/generation/report/ledger 负例、校验器自证 |
| `tests/recovery-capture.test.ts` | ready 捕获形状、lastGood 推进/幂等、四类必需水位缺失、Goal/Projection/对象闭包/hash/版本/容量、五个 staging 断点、失败不覆盖 lastGood、并发写入边界声明、armed 捕获、空 Goal 集合、opaque 尾、布局/路径泄漏、非法 id |
| `tests/recovery-restore.test.ts` | 正例（复核可读/hash/删除/unknown/disarmed/generation/旧根）、armed→disarmed、unknown 保留、控制墓碑重放、旧删除账本 locked/replayed、篡改账本、barrier 全分支、篡改 bundle、root/目标/锁保护、复制后复验 |
| `tests/recovery-fault-matrix.test.ts` | 30 条故障/边界矩阵逐条断言 + 必需场景清单 |
| `tests/recovery-evidence.test.ts` | 生成并复核 evidence JSON；断言不冒称宿主/独立故障域 |
| `tests/recovery-support.ts`、`tests/recovery-matrix.ts` | 合成世界/端口/时钟/容量与矩阵运行器（非测试文件） |

复现命令（在 `plugins/shiyu/`）：

```
npx tsc --noEmit                              # 主树若有并行 WIP，仅以本切片文件无错误为准
node --import tsx --test tests/recovery-schema.test.ts tests/recovery-capture.test.ts tests/recovery-restore.test.ts tests/recovery-fault-matrix.test.ts
SHIYU_WRITE_EVIDENCE=1 node --import tsx --test tests/recovery-evidence.test.ts
npm run check                                 # 全量（建议隔离 worktree，见下）
```

证据文件：

- [`artifacts/dsh/h5/h5-recovery-matrix.json`](../../artifacts/dsh/h5/h5-recovery-matrix.json)：矩阵逐例结果、环境、模块文件 hash、
  覆盖/未覆盖清单、边界声明。
- [`artifacts/dsh/h5/h5-recovery-validator-selftest.json`](../../artifacts/dsh/h5/h5-recovery-validator-selftest.json)：已知正确接受、
  已知错误拒绝的校验器自证表。

证据级别：**G1 离线模块 + 合成端口**（真实临时 SQLite/文件，无 live 路径、无网络监听、无模型）。已留证结论仅限
“指定切片离线实现/验证完成”；证据 JSON 记录 source/test/build 指纹与逐例“注入点→期望→实际”。以下**未测/未证**，不得写成通过：

- live DSH 宿主 / 原生 Goal Session/V24 生命周期；
- 真实 Ombre 导出器及其 manifest/闭包与删除物理清除；
- 独立备份仓库、加密、离线恢复凭据、独立故障域与 3 次恢复演练（V27）；
- 1 GiB / 1000 Task / 100 unknown 的 RPO≤15min、RTO≤30min（V22 完整基准）；
- OS 级 fsync/rename 断电、真实多进程双 writer、崩溃恢复预算（V15/V21 完整项）；
- 旧 bundle schema 由新 reader 迁移/回退；
- 恢复后的真实业务激活（本切片固定 not-activated，激活属于 Runtime/恢复入口的显式步骤）。

## 8. 下一步（非本切片）

1. Runtime 组合层实现 `ControlSourcePort`（真实单 writer/维护窗口）、`GoalSessionPort`（宿主 flush + 日志尾）、
   `MemoryExportPort`（Ombre 原生导出）、`SharedObjectPort`、`RecoveryBarrierPort`；补 live-host 集成测试与失效路径。
2. 以固定宿主和真实临时数据根做 G2/G3 证据；再按交接 02 §6.9 做 V22 完整基准与 V27 独立故障域演练。
3. 迁移/旧 schema reader 兼容、OS 断点与环境故障注入另开切片；本模块的 `minimumReaderVersion`/`dataSchema` 字段已预留位置。

---

## 9. H5b：Runtime 组合层接入（离线，runtime.ts 由 Lead 落）

H5b 把 H5-B1 的纯引擎接入既有 Runtime 资源，但不修改 `runtime.ts`：交付物是
[`host-ports.ts`](host-ports.ts)、[`runtime-command.ts`](runtime-command.ts)、测试与证据，以及可直接
`git apply --check` 的精确集成 diff [`runtime-checkpoint-capture.diff`](../../artifacts/dsh/h5/runtime-checkpoint-capture.diff)（证据 JSON 记录其 SHA256）。

### 9.1 端口 → 真实资源映射

| 端口 | H5b 适配器 | 当前真实宿主状态 |
|---|---|---|
| ControlSourcePort | 读 `{dataDir}/control/events.sqlite`（正则文件/符号链接检查），capture 用 `node:sqlite backup` 到 staging；capture 前用**既有 ControlStore worker** `control.watermark` + `view.state` 读 live 前置事实，staged 快照必须单调覆盖它（`livePrecheck`） | **available**（只读挂载未使用写连接；WAL 只读访问可能更新 `-shm` 协调文件，不是产品写入） |
| GoalSessionPort | 通过 ControlStore `goal.binding.list` 枚举 GoalBinding；精确日志路径**只**来自注入 resolver（候选：已安装 JSONL 持久化后端的诊断方法 `resolveCurrentLog`，非 provider-neutral 公共契约）；native phase/armed 必须有只读公共 API；flush 走 `sessions.get(id)` + `sessions.flush(session)`；log 只接受可离线核验的 plain JSONL | **unavailable/incomplete**：缺公共路径 API、只读原生 Goal 状态、projection 导出与可离线解码格式；已在证据中列为 blocker + required scope |
| MemoryExportPort | 生产端口显式抛 `MEMORY_EXPORT_UNAVAILABLE`（managed Ombre 本部署无公开导出/归档工具，required scope 见 `HOST_MEMORY_REQUIRED_SCOPE`） | **unavailable** → Bundle **不得 ready** |
| SharedObjectPort | 只读、有界地枚举/哈希 `{dataDir}/workspaces`（拒绝符号链接与逃逸，`maxFiles/maxTotalBytes/maxFileBytes`）；引用对象才复制，清单作为证据写入 shared-objects manifest（`workspaceInventory`，非恢复依赖） | **available（只读清单）**；持久 object_refs 表尚未实现，引用集合当前通常为空 |

组合入口 `createRuntimeCheckpointComposition()` 只接受显式、位于 live 根之外且（可选）在 `allowedStagingRoots`
内的 staging 根；`liveDataRoot`/`allowedStagingRoots` 围栏在 `CheckpointCaptureService` 构造时再次强制。
只有四个必需组件 complete 且 `verifyBundleDirectory` 真实字节复核通过才 ready；否则 failed/incomplete，失败不写 lastGood。

### 9.2 owner-only 命令语义（`runtime.checkpoint.capture`）

- **显式触发**：只有 owner 控制面命令进入 `RuntimeCheckpointCommand.handle()`；composition 懒创建也只在命令内发生，
  snapshot/GET 路径从不调用（不自动、不因 GET 触发）。
- **单飞不排队**：并发第二个请求返回 `busy`（`CHECKPOINT_BUSY`），不排队、不合并、不重试。
- **暂停语义**：paused 时允许执行（纯本地只读/备份，无模型、无派发），结果记录 `pausedAtRequest=true`、
  `desiredState=unchanged`；命令不修改暂停状态。dispatch 分支位于 `ensureCanRun()` 之前。
- **失败降级**：组件 unavailable/无法核验 → Bundle `incomplete`，命令返回结构化 `status/failureCodes/blockedComponents`；
  staging 中断不发布 ready；一次命令最多一次 capture 尝试（`retried:false, autoTriggered:false`）。
- **前置**：`RuntimeOptions.checkpointStagingRoot`（信任组合、live 根之外）与
  `RuntimeOptions.checkpointRuntimeManifest`（固定宿主身份）缺一 → `CHECKPOINT_STAGING_UNCONFIGURED`/失败，
  绝不回退到临时目录或猜测宿主版本。
- 集成 diff 含：imports、RuntimeOptions 两个 trusted 字段、类字段、init 内命令处理器（无 I/O）、
  dispatch 分支、懒组合方法与 `commandCheckpoint`；**不改** snapshot/GET 路由。

### 9.3 证据与边界（H5b）

- 测试：[`tests/recovery-host-ports.test.ts`](../../tests/recovery-host-ports.test.ts)（14 用例：真实临时 ControlStore backup+precheck、
  Goal 字节/尾/flush、缺日志/缺 projection/缺 native state/缺 flush/zstd、memory unavailable、生产宿主 blocked、
  staging 中断、workspace 对象 hash 不符、live 根与 staging 围栏、隔离恢复、控制 fact 读取、候选 resolver、命令单飞/暂停/无重试）；
  [`tests/recovery-h5b-evidence.test.ts`](../../tests/recovery-h5b-evidence.test.ts) 生成 15 条矩阵证据。
- 证据：[`artifacts/dsh/h5/h5b-runtime-integration.json`](../../artifacts/dsh/h5/h5b-runtime-integration.json)（逐例注入点→期望→实际、
  source/build/test 指纹、production blockers 与 required scope、diff SHA256/可应用性、边界声明）、
  [`runtime-checkpoint-capture.diff`](../../artifacts/dsh/h5/runtime-checkpoint-capture.diff)。
- **真实生产宿主在本切片不可 ready**：Goal Session 公共路径/原生状态 API 与 Ombre 导出缺失，已如实列为 blocker；
  ready 路径仅用合成 seam（临时 Session 文件 + 合成 resolver/native-state/flush/projection/memory）验证。
- 未测/未证：Lead 落 diff 后的真实运行命令与宿主 reload、真实 `~/.dsh/sessions` 路径解析、压缩日志离线解码、
  真实 Ombre 导出、独立故障域/V27、RPO/RTO、激活切换。restore 仍只进入临时隔离根、不激活、不动 live 根。
