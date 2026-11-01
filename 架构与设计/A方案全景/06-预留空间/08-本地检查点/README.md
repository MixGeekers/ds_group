# 本地检查点 · 复用组件导出与组合 Bundle

[所属区域](<../README.md>) · [完整目录](<../../目录.md>) · [验证与验收](<../../验证与验收.md>)

更新：2026-11-01。模块 ID：`checkpoint`。**建议验证基线，未实施、未实测。** 本页定义方案，不创建运行数据库或数据根。

## 主方案

控制库直接复用 SQLite Online Backup API / Node `sqlite.backup`；Ombre 直接调用自身 `backup_archive.build_export_archive_file`，复用它的流式 ZIP、manifest hash、来源引用闭包、SQLite backup / quick_check、导入路径与大小校验，不重写第二套 Ombre 导出器。识雨 CheckpointService 只协调各组件屏障、收集其 manifest 与控制水位、打包通用产物并形成顶层目录；[独立备份](<../../07-独立备份/README.md>)只使用成熟备份工具复制 ready Bundle。[固定版本与限制](<../../../../research/2026-11-01-复用核查/数据空间.md>)。

Ombre 现有导出依次读 Markdown、来源文件与多个 DB；每个 SQLite backup 的一致性不等于所有组件同一截面。其 export_lock 不能自动推导所有写者均已冻结。默认 Bundle 是带版本向量、需要恢复核对的组合快照；只有取得可验证的全写者静默屏障才可声明共同截面。WAL checkpoint 本身仍只是数据库维护。

**DSH Goal 的唯一权威位于目标专用 Session log，因此它也是必需恢复数据。** 不能仅打包 control.db 中的 GoalBinding 就宣称目标可恢复。范围精确到该快照 GoalBinding 所引用、仍需恢复或保留核对的目标 Session；不为此打包无关对话。

## Bundle 与生成协议

BackupBundle：snapshotId、captureTime、completedAt、rootId、bundleSchemaVersion、minimumReaderVersion、runtimeManifest、control.commitSeq、control.stateVersion、tombstoneWatermark、components[]、objectManifestRef/hash、status、reconcileRequired。components 每项为 componentId、upstreamCommit / patchDigest、dataSchema、snapshotRef、manifestSha、watermark 或实际 revision / captureTime、quiescenceEvidence；不存在的全局版本不能填猜测值。

| 必需组件 | 内容与完整条件 |
|---|---|
| control | 完成的控制 SQLite 快照、GoalBinding、在途目标命令 / 组件操作、停止 / 授权 / 删除记录及实际 commitSeq |
| dsh-goal-sessions | 上述 GoalBinding 引用的目标专用 Session 耐久 log，以及解释 / 重放 Goal 状态必需的 projection 定义、schema、插件配置和版本清单；逐 Session 记录实际 log sequence / durable tail、GoalRef{id,revision}、原生 phase / armed 与 captureTime。不存在可证明的序号则保留可验证的日志尾标识并标明 API 限制，不填造出的 seq |
| memory | 记忆组件 manifest / 数据及其引用闭包；采用 Ombre 时包括原生导出，缺失必需源或媒体不算完整 |
| shared-objects / runtime-manifest | 上述组件引用的通用对象、解释各组件所需版本和配置；不包含明文秘密。SecretRef 的实际可用性恢复后另外核对 |

`dsh-goal-sessions` 记录 DSH 固定提交、识雨插件 / projection 版本或 digest、日志格式与兼容恢复版本。可重建 projection 无需保留第二份权威数据，但重建定义 / 配置必须齐全且可复现。组件清单与 GoalBinding 闭包逐项对齐；必需日志、定义 / 配置、实际尾水位或兼容版本校验缺失时，Bundle 必须 failed / incomplete，**不得 ready**。reconcileRequired 不能替代缺失权威数据。

1. 经控制事务记录 snapshotId、在途目标命令 / 组件 operation 清单及 GC 保留屏障，状态 creating。静默目标变更、自动 continuation 与相关派发，并申请 Ombre 全部写入口 / dream / decay / 后台索引静默，不能只锁导出路由。无法获得跨组件共同屏障时明确 reconcileRequired，不虚报同截面；每个必需组件自己的耐久快照仍必须成立。
2. 对目标专用 DSH Session 等待宿主已提供的 flush，并取得实际耐久日志尾及 GoalRef；仅 flush 不阻止随后写入，必须维持目标写者静默，或使用已验证的宿主快照接口 / 维护窗口停宿主后闭合复制。控制 SQLite online backup、目标 Session 快照与组件导出各写 staging。Ombre 暂存使用受控 TMPDIR 或登记外置位置。备份限时、限额、任一必需组件失败即 Bundle failed，不替换 lastGood。
3. 从完成的控制快照读取实际 commitSeq / 删除水位 / GoalBinding / object_refs；从完成的 DSH 快照读实际日志 sequence / tail、GoalRef revision、phase / armed并与记录核对；从记忆导出 manifest 读其证据。不得用 flush 调用前的内存 revision 冒充复制后版本。顶层 captureTime 取各必要组件捕获窗口中保守最早时刻，绝不使用上传完成时刻冒充新鲜度。
4. 组件自行验证内部 manifest、来源闭包与 SQLite；顶层验证组件齐全、操作对应、共享引用与最新删除要求，再 pin 通用对象。不要让备份服务再扫描 / 重算另一套组件内部 manifest。Ombre 媒体是否全被原生导出涵盖必须测清；未覆盖项通过其 manifest 扩展或显式文件组件补齐，不默默漏掉。
5. 所需数据和目录耐久发布后，发布 ready Bundle；记录是否需 reconcile。独立备份确认后释放本地 pin。GC 屏障只在失败清理或完整 pin 建立后释放，不能因超时删正在使用的对象。

默认每 5 分钟请求一次检查点，由恢复 / 备份调度统一触发；不得数据层与备份层各启动一套周期任务。正常保留最近 3 份已验证 Bundle；迁移前、尚未远端确认或恢复演练占用的 Bundle 保持 pin。空间不足时停止新 Bundle 并暴露备份陈旧，而不是删唯一可用恢复副本。

## 恢复协议

恢复目标先进入 maintenance / quarantine。控制库恢复独立 DB，Ombre 使用其 `extract_backup_archive_file` 在隔离目录校验 / 解包，不能直接 import 覆盖 live；legacy 无 manifest 导出不能标 verified。按 components 清单重建版本映射，核对在途 operation 与组件真实状态，再重放最新删除 / 撤权账本。无法确认必要水位时 ReadView 保持关闭。重新生成 installationGeneration 和 hostEpoch，unknown 外部效果不自动重放；组件恢复与控制库恢复完成不代表它们天然一致。

DSH 目标 Session 先校验日志完整性、实际尾序号、GoalRef revision 与 DSH / 插件 / projection 兼容版本，在禁用自动 continuation 和外部派发的恢复配置中加载 / 重放。通过宿主已核验的 disarm 路径使并确认目标 **disarmed**，记录确认后的真实 revision；不手改 Session log 伪造状态，也不凭快照原有 armed 自动继续。逐项核对原生 phase、GoalBinding、当前授权、stopReason、取消 / 到期墓碑及在途目标命令；版本不兼容、缺 projection 或状态冲突保持隔离。核对完成后仍需当前准入与明确恢复资格，恢复数据库不等于重启目标执行。

本地快照只解决逻辑回滚与快速恢复；独立备份的 RPO/RTO 与最近成功可恢复快照的实际捕获时间计算，不能由“定时器运行了”推断。

## 失败与替代条件

若 Node online backup 失败，停写 / 排空 / 关闭全部连接后离线复制，不能在线 cp 主 DB。若 Ombre 公共接口不能提供必要静默，首验证允许维护窗口停服务后导出；这属于验证中的依赖条件，不新增常驻备份框架。Ombre 现成归档解压总量限制 512 MiB，组件测试先≤256 MiB；超过限制须显式配置或局部补丁并重复限额 / 防损坏测试，不能悄悄绕开保护。

## 验收

[V22](<../../验证与验收.md#v22>) 注入控制已批准 / Ombre 已执行 / 本地未确认各断点，及并发写入、GC、删除、备份退出；恢复后引用可读、hash 一致、删除不复活、unknown 不自动重放。总合成数据可为1GiB，但 Ombre 组件保持≤256MiB，其余由通用对象组成；组件上限单独验证。整体 Bundle≤5分钟、RPO≤15分钟、RTO≤30分钟均为目标，按最旧必需组件实际捕获时间计算，超时必须 degraded。

同一 V22 覆盖目标变更已写 Session log / 控制命令未确认、flush 后再次写入、故意漏掉目标 Session、缺 projection 定义、旧版本不兼容和旧快照 armed=true；缺失组件不得 ready，恢复后 GoalRef / 实际日志尾可核对，目标在重新准入前均 disarmed，无关对话不进入包。

[V15](<../../验证与验收.md#v15>) 验证中断 staging 不可冒充 ready、失败不覆盖最后可用检查点、空间检查包括 DB 及对象副本所需容量。

## 证据与适用限制

一手资料、静态核查范围与具体链接见[数据空间证据](<../../../../research/2026-11-01-完整架构/数据空间.md>)。以上业务字段、默认参数与通过标准是识雨的设计建议，不是上游软件自动提供的能力。

