# 恢复入口

[所属区域](<../README.md>) · [完整目录](<../../目录.md>) · [全景图](<../../../图示/识雨全景架构-A.html>)

- 模块 ID：`recovery-entry`。更新：2026-11-01。
- 状态：验证基线设计；没有恢复真实数据或切换运行版本。

## 主方案与边界

RecoveryCoordinator 收缩为确定性 runbook，调用已选宿主、SQLite 检查、restic 0.19.1 restore 和同文件系统激活指针切换。Ombre 组件使用其现成 `extract_backup_archive_file` 校验/解包，任务核对调用任务模块唯一的 Superagent 适配恢复流程，不另写 ZIP 解包器或任务恢复状态机。它不使用模型自由生成修复命令。自动范围限于重连、可重建索引、同数据兼容范围内的已发布配置回退；数据库原文损坏、未知迁移或备份还原进入 maintenance，由显式恢复操作选择源和目标。

Ombre 固定 `115d831`、Superagent 固定 `6337fc8`，均 MIT；restic 为 BSD-2-Clause，精确文件、依赖、复制范围和许可见[复用核查](<../../../../research/2026-11-01-复用核查/恢复备份.md>)。Ombre 现有 migrate/upload→status→apply 可用于隔离实例，apply 的202不算完成；旧包无 manifest 的 `integrity_verified=false` 不得升级为可验证恢复。其逐文件安装与 Superagent 的 DshExecutor.resume→Engine.assignmentInterrupted→Assignments.interrupted / effects.start 均不能直接作为识雨全系统恢复完成证明。任务模块唯一 TaskRecoveryCoordinator 必须在这些入口前补停用/撤权、回执与 unknown 屏障；恢复入口在其前面处理删除和组件截面，不再重写任务迁移。这是适配计划，未复制或执行。

恢复不是重置记忆。二进制回退、配置回退、数据迁移和恢复旧数据是四种不同操作；选择旧程序前必须检查其可读写 schema 范围，不能把旧数据库覆盖到已有新业务数据上。

## 输入输出契约

| 对象 | 关键字段 |
|---|---|
| RecoveryRequest | recoveryId、kind、failureCode、sourceSnapshotId / knownGoodVersion、targetRootRef、requestedBy、currentIntentSeq |
| RecoveryPlan | expectedManifestHash、requiredSchemaRange、expectedDeletionWatermark、mode=maintenance、effectDispatch=false、rollbackTarget |
| RecoveryReport | phase、before / after versions、checkedCommitSeq、deletionWatermark、objectChecks、reconcileRequired、errors、endedAt |
| ActivationRecord | installationGeneration、hostEpoch、activeDataRootRef、manifestHash、intentSeq、activationTime |

只通过可信控制面创建请求。报告只含必要路径引用和摘要；密钥由专门凭据设施向受信恢复进程提供，不进模型上下文。恢复目录和 source 都不是任意外部输入提供的可执行路径。

## 顺序与切换

1. **冻结执行。** 写 maintenance 意图、停派工、关闭外部发送出口，等待单实例锁和业务写入退出；不能与活跃写入者同时更换根目录。
2. **保留故障现场。** 将损坏数据库 / 配置保持只读，记录摘要与必要诊断；不原地猜测修复。
3. **准备新根。** 从已验证 BackupBundle 恢复到新的暂存位置，核对版本、SQLite 完整性、manifest、对象 hash / size、commitSeq 和配置来源。只读检查通过前不运行迁移。
4. **处理删除与授权。** 取最新删除账本和撤权 / 停用控制记录，重放删除再建索引。最新删除水位无法确认时，数据只保留在恢复锁内，禁止 ReadView 和外发。旧备份里的 running、有效设备授权不能覆盖较新的撤销。
5. **处理版本。** 在副本上执行固定、可重跑且有失败回退点的迁移；迁移后的源不再交给不兼容旧版本。旧根和新根分开，保留可回滚指针。
6. **重建执行代际。** 新主机或旧备份恢复采用新的 installationGeneration 与 hostEpoch；若无法确认原 epoch 源或旧主机已停止，先撤销旧执行会话 / 凭据再与设备重新配对。不能只对恢复出的计数加一。
7. **核对任务。** 设置 reconcileRequired，扫描 pending / running Assignment 与 dispatching / unknown Effect；租约过期或实例丢失不等于未执行。查询设备回执、实际效果与 Effect 账本；未知结果继续 unknown，并保留 stopRequested / cancellationEpoch。Task 阻塞使用 waiting + waitReason，不能新增与公共状态机冲突的隐含状态。旧 fencingToken 的结果可留为证据，不能改写当前 assignment 或提交内部提案。
8. **验证并启用。** 在断外发 / 替身设备下完成业务校验，取得新的 ActivationRecord；同文件系统原子替换激活指针。仅在当前用户意图为 running 且屏障解除时开放派工，其他状态保持原意图。

以上为设计流程，不是已实现的 API 或脚本。SQLite 备份保证单库一致性，Ombre 现成导出逐文件读取并依次快照多个库，不天然形成跨库截面。[数据空间](<../../06-预留空间/README.md>)唯一 CheckpointService 记录组件水位与静默证明；缺少共同静默证明时只能作组件快照向量，恢复仍须核对跨组件回执，不能由一个 BackupBundle 名称推导全局原子性。[SQLite 官方在线备份](<https://www.sqlite.org/backup.html>)。

必需恢复组件还包括 `dsh-goal-sessions`：只含 GoalBinding 绑定的目标专用 Session 耐久日志及必要 projection 定义/配置，记录实际 log seq、GoalRef revision、原生 phase/armed 和 DSH/plugin/projection 版本；不打包无关聊天。第3步先核对组件完整性及版本，缺失不得宣称 complete/read-ready；恢复实例在读取日志前关闭目标调度出口，隔离恢复后保持 disarmed，再于第7步核对 GoalRef/phase、本地 stop/取消、当前授权与 reconcile 结果。即使旧快照 armed=true，也只有当前运行意图和核对结果同时允许时才重新启用。不能用本地任务副本推测重建丢失的权威 Goal 日志。

## 失败处理与数据生命周期

恢复任何一步失败都不切换 active root，保留旧根与恢复报告；临时文件标为恢复工作产物，失败证据按去敏政策保留，不能自动删除最后一份可恢复副本。恢复锁覆盖 prune、对象 GC 和根目录切换；锁异常退出须核对进程 / epoch 后释放，不能按文件年龄猜测解锁。

索引仅从已通过删除过滤的权威原文重建。数据库损坏时不使用 LLM 补写事实；无法核对副作用时不重放点击、发送、移动设备等动作。合成场景的删除、撤权和暂停用例必须先通过，才允许验证真实数据恢复。

## 备选与验证

如 Online Backup 在所选驱动不可用，数据模块可采用短暂停写、关闭全部连接后的离线一致快照；严禁裸拷活跃 WAL 主文件。如目标 schema 不能安全迁移，使用原兼容版本在隔离位置读取 / 导出，停止自动启用，不临时拼接迁移代码。

[V21 / V22 / V23 / V27](<../../验证与验收.md>) 通过条件：恢复失败不改变现有 active root；原 pause / revoke 不复活；从删除前快照恢复后被删内容在 ReadView / 索引 / 导出中均不可见；故意损坏对象被 manifest 校验拒绝；100 个 unknown effect 不自动重发；旧代际结果 100% 被提交入口拒绝。报告必须区分“副本可读取”“任务可核对”“允许恢复动作”。

来源与限制见[恢复与备份核查](<../../../../research/2026-11-01-完整架构/恢复与备份.md>)。

