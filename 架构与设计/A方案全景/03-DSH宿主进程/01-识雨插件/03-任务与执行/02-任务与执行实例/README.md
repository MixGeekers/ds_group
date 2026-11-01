# 任务与执行实例 · Task / Assignment 方案

[任务与执行](<../README.md>) · [完整目录](<../../../../目录.md>) · [证据与取舍](<../../../../../../research/2026-11-01-完整架构/任务与执行.md>)

- 更新：2026-11-01（America/Caracas）。模块 ID：`tasks`。
- 状态：**进入验证的建议基线 v1.1（源码复用修订）**。A 的插件内核心已由用户选择；本页细节是本轮架构方案，尚未实施、未运行候选或故障实验。

## 1. 主方案与目标

Task 表示用户希望完成的一件事；Assignment 表示一次具体执行绑定。重试保留 Task 和原有授权，新增 Assignment，不创建新的目标或扩大权限。**直接复用 Superagent core 的 Engine、Ticket、Assignment、输入归属实现及 Store 仓储；TaskService 改为受控适配门面，不重新实现它们。** DSH Session 承载工作上下文；权威任务账本使用复制并补丁后的 SQLite Store，Session 日志作为执行关联。

复制基线为 Superagent `6337fc823ce20251c8de8085948165c81aaa701e`（MIT），core 13 文件闭包仅额外依赖 node:crypto；具体清单、仓储 DDL 与补丁见[复用核查](<../../../../../../research/2026-11-01-复用核查/任务执行.md>)。保留内部 Ticket JSON 与上游仓储协议；公开 Task、version、租约、fencing、验证结果可由同事务补充记录投影，不为匹配接口名称重写整个存储模型。

## 2. 数据契约

| 对象 | 必要字段 |
|---|---|
| Task | taskId、goalId、mandateId、mandateVersion、originEventIds、requestScope、requestId、payloadHash、version、state、waitReason、completionSpec、inputRefs、resultRefs、activeAssignmentId、deadline、pauseReason/pausedAt、stopRequested/cancellationEpoch |
| Assignment | assignmentId、taskId、attempt、executorRef、sessionBinding、hostEpoch、installationGeneration、fencingToken、state、createdAt、startedAt、leaseExpiresAt、endedAt、endReason |
| TaskInput | inputId、taskId、sourceEventId、kind(context / followup / cancel / scope_change)、ownership、deliveredTo、readAt |
| TaskResult | taskId、assignmentId、fencingToken、completionChecks、artifactRefs、effectRefs、proposalRefs、summaryRef、resultHash |
| 状态快照 | task version、commitSeq、相关授权与执行代际；不把任务 version 当内层 stateVersion |

TaskService 在上游 Engine 前后维护识雨聚合约束；受控写入使用统一提交协议及 task Store.atomic。worker 只能提交输入确认、进度和结果请求，不能自行设置 Task.succeeded。字段名和代际比较遵循总契约。

约束：`(requestScope, requestId)` 唯一，相同键与相同 payloadHash 返回原受理结果；同键不同内容拒绝。一个 Task 至多一个 pending/running Assignment；创建新实例的事务同时使旧实例失去提交资格，并分配更大的 fencingToken。历史实例和回执仍留作核对。

## 3. Task 状态与迁移

公共枚举严格采用 queued / running / waiting / succeeded / failed / cancelled / unknown。waitReason、stopRequested、lastKnownState、pauseReason 是解释或控制字段，不新增公开状态；如实现内部状态更细，也必须映射到这七态。

| 当前状态 | 触发 / 证据 | 下一状态 |
|---|---|---|
| queued | 授权有效、预算已预留、资源可用，创建实例并准备启动 | running（启动确认后） |
| queued / running | 等待输入、依赖、能力恢复或有限退避；没有未核清副作用 | waiting |
| waiting | 必要条件满足且当前授权复核通过 | queued 或继续原 running 实例 |
| running | 取得可核验产物及已知效果，全部 completionSpec 通过 | succeeded |
| running | 确定失败且重试额度耗尽 / 不可恢复 | failed |
| 无未核清副作用的非终态 | 缺少授权、证据或需用户 / 运维介入 | waiting，waitReason=blocked；已有未知效果则保持 unknown 并附等待原因，不能进入可重排队列 |
| 任一非终态 | 外部动作可能已发生且无法判定，或执行实例失联需核对 | unknown |
| 任一非终态 | 收到有效取消 / 撤权，持久 stopRequested，发送受限停止 | waiting，waitReason=cancel_requested；若已有未知效果则保持 unknown |
| waiting（cancel_requested）/ unknown | stopRequested=true，实例已结束，所有已派发动作有确定结果，剩余待执行动作失效 | cancelled |
| unknown | 查得原动作结果、确认旧执行已停，当前授权仍有效 | 由证据回到 waiting / queued / succeeded / failed；取消已请求则走取消终态判断 |

queued 在创建 pending Assignment 后仍等待启动确认；派发器只认 activeAssignmentId，不再重复创建。Assignment 的生命周期为 pending → running → ended，endReason 区分 completed、failed、cancelled、lease_expired、host_lost、superseded。

终态不被普通输入自动复活。用户明确要求重做时创建新的 Task，并关联 supersedesTaskId；非终态任务内补充且语义未改变的恢复使用原 Task，但仍核验原 Mandate。需要在上游 Intake.receive / Tickets.wake / Engine.evaluateDue 的终态唤醒路径加策略门；其余输入归属和继续机制保留。目标暂停是独立标记，不覆盖 unknown 或完成状态；恢复不抹去过去的取消。

上游 Ticket / report 的内部状态通过适配投影公开七态：未启动或排队映射 queued，当前实例运行映射 running，已知等待映射 waiting；unknown 效果事实优先于这些状态。上游 ready / ended 只表示报告或编排已收束，只有 ResultVerifier 通过 completionSpec 才投影 succeeded；确定失败与完成取消分别投影 failed / cancelled。内部枚举不能直透给调用者。

## 4. 输入归属与并发规则

一条请求的“由谁决定是否成为新任务”有单一 ownership 记录。已归属 worker 的任务内追问只进入当前 Task；超范围时 worker 可返回 hand_back，由 core 重新评估，不由 core 和 worker 同时接单。上下文订阅可供多个任务只读使用，不能给这些任务新授权。

并行仅限无资源冲突的任务。按 conversation / device / resource 设置显式依赖或独占资源；同一 GUI 与机器人执行面默认独占。父任务等待子任务使用持久 dependencyRefs，新增依赖先检查环路；不支持任意脚本式工作流。对无关回执的提交使用各聚合 readSet CAS，避免全局冲突风暴。

## 5. 租约、fencing 与重启

租约由程序心跳维持，不等待 LLM 返回。租约到期使旧实例不能提交新结果或开始新动作，但**不证明旧动作已经停止**。检查顺序为 installationGeneration → hostEpoch → 当前 fencingToken 与资源租约 → activeAssignmentId → 授权 / stop / pause → 参数与预算。

对被旧租约实例返回的结果，保留证据并标 stale；不能直接更新当前 Task 或内层。若回执能证明某个旧 Effect 实际完成，交给当前核验器按 effectId 核对，可以解决 unknown，但不能将旧 Proposal 顺便提交。

崩溃恢复先扫描 pending/running Assignment、dispatching/unknown Effect 与待发 outbox。唯一 TaskRecoveryCoordinator 核对通过后才能调用上游 Engine.assignmentInterrupted → Assignments.interrupted；原实现会自动 restart / deliver，不能直接在启动时放行。无副作用且已确认停止的实例可新建尝试；有未知外部动作时先查回执和真实状态。旧实例未证实停止、资源端不支持 fencing 时，保持 waiting（blocked）/ unknown，不能直接把 GUI 或物理设备改派给新 worker。

## 6. 数据生命周期与错误处置

任务正文、工具日志和大产物只用受限引用；数据库保存结构与摘要。终态压缩不能删掉仍用于外部动作去重的 effectId、请求指纹和撤权状态；保留期限与设备最大离线 / 重试窗口由数据专题统一决定，超过窗口的老命令一律拒绝或人工核对。

唯一约束冲突按 duplicate / conflict 回执处理；CAS 失败重新读取并重新判定，不盲目重放整段模型输出。数据库忙时只有限退避，不在事务中继续等待网络。损坏与版本不兼容由恢复专题接管，禁止从聊天摘要重建“曾执行过”的事实。

## 7. 验证与替代条件

全局验收见 [V11](<../../../../验证与验收.md#v11>)、[V12](<../../../../验证与验收.md#v12>)、[V23](<../../../../验证与验收.md#v23>)。下述数值是合成验证场景的初始配置，不是已测性能。

V11 在 pending 持久化、实际启动、启动回执、心跳、完成回执各断点退出；同 Task 50 个并发领取请求最多 1 个有效活动实例，旧实例结果 100% 不能直接覆盖新 version。注入租约到期但旧 worker 仍活动的场景，同一资源不得同时出现两个有效执行者；不支持 fencing 的端点必须保持阻塞，不能把该场景标通过。

V12/V23 验证同键同内容得到原回执，同键异内容明确拒绝；任务 succeeded、内层 proposal rejected、通知 unknown 能同时如实展示。保留并适配 Superagent 的 followup/assignment/effect 领域测试，而非只参考测试名称；另加识雨的版本、预算、终态补充消息与未知效果断言。V14 检查 Store.atomic 的同步限制、SAVEPOINT 失败恢复与数据库状态不明时隔离。

若 TaskService 逐渐需要跨中心持久工作流、任意依赖图与版本重放，按区域页门槛评估 Temporal，而非扩建自制通用工作流语言。当前状态表及接口是主方案。证据见 [任务与执行证据](<../../../../../../research/2026-11-01-完整架构/任务与执行.md>)；未运行实验。

