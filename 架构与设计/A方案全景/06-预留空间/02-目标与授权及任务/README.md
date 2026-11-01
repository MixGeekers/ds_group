# 目标、授权与任务 · 持久业务账本

[所属区域](<../README.md>) · [完整目录](<../../目录.md>) · [验证与验收](<../../验证与验收.md>)

更新：2026-11-01。模块 ID：`task-store`。**建议验证基线，未实施、未实测。** 本页定义方案，不创建运行数据库或数据根。

## 主方案与所有者

优先局部复制 Superagent 6337fc8 的 Engine / Repositories 领域闭包与 Store 事务、聚合 JSON、活动索引、receipt / effect 片段；Ticket 内原有 Mandate / Assignment 可继续作为物理聚合，公开 Task 作为适配投影。**替换此前按自定 Task 表重写整个任务仓储的计划**；下列字段为必须可表达的逻辑约束，不要求逐项另建表。TaskService 拥有规则，CoreCommitService 门面调用复用的事务实现；设备和 worker 只提交核验报告。不以 DSH Session 活跃与否推定完成。[任务与执行](<../../03-DSH宿主进程/01-识雨插件/03-任务与执行/README.md>)决定最终复制闭包。

复用范围为 `src/core` 领域模块、`src/app/store.ts` 的 atomic / afterCommit 与相关 CRUD / schema、`effects.ts` / `outbox.ts` 的持久投递机制，不连带复制全套 GitHub / 飞书 / 配置应用。MIT 原声明必须保留。新增 replayClass、unknown、撤权 gate 与对话 origin 是具体差异补丁；上游遇失败自动重试不能直接用于非幂等外部动作。SAVEPOINT 创建失败与回滚失败的 depth / 连接隔离缺口必须修复。详细依赖与证据见[数据复用核查](<../../../../research/2026-11-01-复用核查/数据空间.md>)。

## 最小逻辑字段与约束（映射到上游聚合）

| 逻辑对象 | 字段与索引 |
|---|---|
| DSH GoalRef / 原生 phase | DSH `ctx.goals` 与目标专用 Session log 是生命周期唯一权威；GoalRef{id,revision}，phase=active / paused / blocked / complete。控制库不新增 goals 状态表，不维护第二份 revision / pausedAt / Goal.state |
| GoalBinding | goalId、sessionId、goalRef、owner、scope、completionCriteria、priority、budget、reviewAt、expiresAt?、metadataVersion、stopReason?；goalId 唯一，sessionId / reviewAt / expiresAt 查询索引。仅识雨元数据及标注观察时间的原生状态投影，metadataVersion 不代替 GoalRef.revision |
| mandates | mandateId、version、status、authorityRef、sourceEventIds、policyVersion、scope、expiresAt、budget；复合身份保留原授权版本 |
| tasks | taskId、goalId、mandateId/version、taskVersion、state、activeAssignmentId、lastFencingToken、completionSpec、inputRefs、resultRefs、pauseReason、deadline；unique(requestScope,requestId) |
| assignments | assignmentId、taskId、attempt、installationGeneration、hostEpoch、fencingToken、executorRef、sessionBinding、state、leaseExpiresAt、endReason；同 task 只允许一个 active，尝试序号单调递增 |
| effects | effectId、originKind、originRef、installationGeneration、hostEpoch、fencingToken（任务分支）、mandateId/version、authEpoch、kind、targetRef、idempotencyKey、payloadHash/Ref、state、attempt、dueAt、dispatchLeaseUntil；unique(targetRef,idempotencyKey) |
| effect_receipts | receiptId、effectId、status、evidenceRefs、observedAt、externalOperationId、externalReceiptId；unique(effectId,externalReceiptId) |
| conversations / turns / drafts | conversationId、turnId、conversationGeneration、draftId、viewId、payloadRef、sendState、stopRequested；ConversationService只提交本域命令，不写内层 |
| outbox | deliveryId、eventId/effectId、destination、payloadRef、status、attempt、dueAt、leaseUntil、lastErrorCode；pending+dueAt索引 |

Effect.origin 是判别联合：task{taskId,assignmentId} 或 dialogue{conversationId,turnId,conversationGeneration}。两分支均校验 Mandate / 目的地授权、删除水位与有效期；task 才要求 Assignment / fencingToken 外键。普通 replyer 不伪造 worker Assignment，conversation 字段也不能绕过授权。表可分支外键或 JSON 引用，但必须有 CHECK / 程序校验拒绝缺项与混合来源。

同键不同 payloadHash 拒绝，不能把旧幂等键复用于不同动作。引用完整保存到任务终态后的保留期；超出旧请求身份保留窗口的历史输入不自动重放，需要明确的新请求。outbox 的一次投递完成不代表 effect 成功，effect 成功也不代表内层提交完成。

Task.goalId 引用 GoalBinding，目标是否有效再核对 DSH 当前 GoalRef / phase 与本地停止记录；不能只读过时的控制投影。目标专用 Session log 及重建其状态必需的 projection 定义 / 配置是[检查点](<../08-本地检查点/README.md>)的必需组件；只备份控制库 GoalBinding 不足以恢复目标权威。

## 关键流程

目标变更先登记控制命令，再按 GoalRef.revision 调用已核验的 DSH 接口，读取原生 phase / armed 与新 revision 后确认回执。它与控制 SQLite 不共享事务；中断标 unknown 并核对，不先同步改一份本地 Goal.state。取消 / 到期先关闭本地派发资格，再按已验证的 disarm / pause / clear 语义处理并保留引用墓碑；恢复需原生状态、当前授权与本地停止记录一致。普通定时输入不能重开停用目标，原生 armed 也不能绕过每轮准入。

1. 受理：同事务验证 Mandate、去重请求、创建 Task / 必要 Assignment、递增 fencingToken 并写派工 outbox。
2. 派发：重新核查当前授权版本、authEpoch、租约和 hostEpoch；再把受限任务发给执行端。外部网络在事务外。
3. 回执：先验证 taskId / assignmentId / fencingToken；旧执行者仅可留诊断证据，不能覆盖新状态。核验结果后用一个事务更新 Task / Effect / Receipt 与后续 outbox。
   这一事务限于控制库；关联 Ombre 记忆写入使用 component operation 与独立提交回执，不能把任务完成当作已记忆。结果未知时任务与组件操作均保留可核对身份。
4. 超时：非幂等副作用记 unknown，先查询外部实际结果；不能按“没收到回执”直接创建第二次动作。明确取消使未来派工停止，已完成动作不能被取消记录抹去。

Task 状态采用 queued / running / waiting / succeeded / failed / cancelled / unknown；blocked 与 cancel_requested 归入 waiting 的 waitReason，stopRequested、cancellationEpoch 与 pauseReason 独立持久，unknown 也可保留停止标记。Assignment 为 pending / running / ended；Effect 为 pending / dispatching / succeeded / failed / unknown / cancelled。恢复流程必须沿任务专题的合法迁移，不由 SQL任意跳状态。

## 失败、保留与权限

重启时释放失效本地执行资格，但不把远端已执行结果假设为未发生。每次启动取得新 hostEpoch，备份恢复还产生新 installationGeneration；旧备份中的 token 不能重新授权发送。默认终态最小元数据保留 180 天；活动、unknown、未确认 outbox 与待删除核对的任务保持 pin。正文和大对象按来源政策分开到期；授权到期、暂停与撤销在恢复后仍有效。

## 验收与替代条件

[V12](<../../验证与验收.md#v12>) 在事务提交前后、网络发送后回执入库前分别注入中断：不丢已受理 Task；允许重复投递但不重复接受同一执行身份；外部未知结果准确标注。[V22](<../../验证与验收.md#v22>) 验证 GoalBinding 与原生 Session log / GoalRef 的恢复核对，缺少原生日志不得生成完整 ready 检查点。[V23](<../../验证与验收.md#v23>) 证明用户取消后无新派工、迟到回执不覆盖当前任务。

只有跨宿主工作流规模、长时间等待或运维要求证明本地账本不足，才评估 Temporal 等成熟工作流平台；不得仅因需要重试便引入另一套状态真相。

## 证据与适用限制

一手资料、静态核查范围与具体链接见[数据空间证据](<../../../../research/2026-11-01-完整架构/数据空间.md>)。以上业务字段、默认参数与通过标准是识雨的设计建议，不是上游软件自动提供的能力。

