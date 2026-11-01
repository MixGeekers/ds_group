# 结果核验与回执 · Effect 与验证方案

[任务与执行](<../README.md>) · [完整目录](<../../../../目录.md>) · [证据与取舍](<../../../../../../research/2026-11-01-完整架构/任务与执行.md>)

- 更新：2026-11-01（America/Caracas）。模块 ID：`verify`。
- 状态：**进入验证的建议基线 v1.1（源码复用修订）**。A 的插件内核心已由用户选择；本页细节是本轮架构方案，尚未实施、未运行候选或故障实验。

## 1. 目标与主方案

“模型说完成”只是一份声明。主方案在任务受理时定义 completionSpec，执行后使用程序检查、产物校验和外部效果回执核验。优先复用工具返回结构、现有查询 API、文件摘要 / schema 校验与成熟测试工具；模型只补充难以结构化的语义评审，不能替代客观完成证据。

分开四项结果：**Task 业务完成、Effect 实际效果、内部 CommitReceipt、对外发送 Receipt**。例如产物已完成但记忆提案被拒，Task 可以 succeeded，同时清楚显示“内部未采纳”；发送超时则通知 unknown，不能声称用户已收到。

可靠投递直接采用 Superagent `6337fc823ce20251c8de8085948165c81aaa701e`（MIT）的 `src/app/effects.ts`、`src/app/outbox.ts`、Store.receipts 及所需 DDL/helper 的局部源码副本。保留入队、并发、排序、退避、generation 防旧回调和事务发送实现；修改 handler 结果分类、未知效果、取消和渠道端口，不重新编写队列。逐文件依赖与补丁见[本轮复用核查](<../../../../../../research/2026-11-01-复用核查/任务执行.md>)。

## 2. 合同字段与数据所有者

| 对象 | 字段与约束 |
|---|---|
| CompletionSpec | checks[{checkId,type,targetRef,expected,evidenceRequired}]、可选 semanticRubric、必要检查列表；任务开始前记录版本 |
| Effect | effectId、origin、mandateId/version、authEpoch、kind、targetRef、idempotencyKey、payloadHash/payloadRef、version、state、attempt、dueAt、dispatchLeaseUntil、expiresAt；origin=task 时附 taskId、assignmentId 及执行世代 / fencingToken |
| OutboxEntry | outboxId、effectId、orderingKey、generation、dueAt、attempt、claimOwner、claimUntil；引用 Effect，不能修改该动作语义 |
| ExecutionReceipt | receiptId、effectId、externalReceiptId/operationId、status、observedAt、deviceId/adapterId、evidenceRefs、payloadHash；来源经适配器认证 |
| VerificationReport | taskId、assignmentId、检查项 pass/fail/inconclusive、证据引用、verifierVersion、verifiedAt、resultHash |
| CommitReceipt / DeliveryReceipt | 分别引用内部 proposalId / 外发 effectId，持久化真实提交或发送结果；不混用“accepted” |

Effect.origin 是判别联合：task 必含 taskId / assignmentId；dialogue 必含 conversationId / turnId / conversationGeneration。普通对话回复无需 worker Assignment；由 ConversationService 拥有对话操作状态与派发前 generation 校验。两种 Effect 都绑定有效 Mandate、目的地与数据外发范围，不能用 dialogue 类型绕过授权。

TaskService 及核验器拥有任务型对象的业务规则，ConversationService 拥有对话型操作状态，统一 CommitService 写入。收到的回执先验证身份、effectId、参数摘要、代际和证据完整性；模型转述不能伪装设备回执。旧代际回执可以作为外部效果证据进入核对，但不能代替新实例结果或自动提交旧内部提案。

## 3. Effect 状态与派发闭环

| 状态 | 下一步 |
|---|---|
| pending | 未开始外部调用；符合当前授权 / 预算 / 顺序后，同事务 claim 并记录派发尝试 |
| dispatching | 已取得派发资格且可能进入外部调用；成功则 succeeded，确定失败则 failed，不能确定是否发生则 unknown |
| succeeded | 已有足够效果证据；返回原回执，不重新执行 |
| failed | 有确定失败原因；仅在能力声明安全重试、预算未耗尽时回 pending，否则维持失败 |
| unknown | 优先 queryReceipt / 查目标状态；证实成功则 succeeded，证实无效果且允许重试才回 pending，否则保持 unknown / 人工核对 |
| cancelled | 仅用于从未发出，或已证实未产生效果并终止的动作；取消请求不自动把 dispatching 改 cancelled |

投递协议：

1. 接受动作时以 `(targetRef,idempotencyKey)` 去重，比较 payloadHash；键相同内容不同返回 conflict。
2. 在同一事务写 Effect + OutboxEntry 及相关 Task 或 DialogueTurn 变更。调用外部服务必须在提交后。
3. Dispatcher claim 时检查当前 Mandate、authEpoch、对应 origin 的取消 / 暂停 / generation 或 fencing，以及数据删除屏障；记录 attempt 与租约后发出调用。
4. 回执与 Effect 及其业务对象更新同事务保存；迟到回调必须匹配该次 generation / version，不能删除后来的待办。
5. 崩溃恢复遇到 dispatching：对可查询接收端先查询；不可查询的非幂等动作转 unknown。即使可能在调用前崩溃，也不能凭猜测重放。

`idempotencyKey` 只是协议中的标识。接收端必须将其与真实效果原子关联，或能可靠查询已有 operationId；仅在中心保存“已发出”不足以证明远端只执行一次。普通 SSH 命令、GUI 点击、邮件 / IM 发送等需逐能力验证，不能继承统一“自动重试”假设。

上游 Effects 成功删除队列行，识雨保留该调度机制但将持久 Effect 结果单独留存；队列 generation 与任务/设备 fencingToken 不能互换。异常分为已知可重试、Later 延后、确定失败、unknown；后者停止自动重放。Outbox 的 SourceRegistry 换成 send/queryReceipt/allowed 窄端口；原 ticket/channel 排序扩展为 origin 的 orderingKey，普通 dialogue 不能因没有 ticketId 失序。withdraw 只撤销可证明未发送的动作，在途动作保持停止标记与回执核对。

## 4. 核验、取消与补偿

文件产物可用存在性、内容摘要、schema、指定测试结果核验；设备动作核对端点状态或签名 / 认证回执；消息发送核对 providerMessageId 或平台查询，投递确认不能外推为人已阅读。

必要检查任一 fail 则任务不可 succeeded，inconclusive 保持 waiting（可附 waitReason=blocked）或 unknown 并说明证据缺口。语义评审使用固定 rubric 和可追溯输入；高成本或不确定判断可采样复核，不构建自制通用评测平台。

取消已完成的效果不叫回滚。需要补偿时建立新的有授权 Effect，指向 compensatesEffectId；例如删除已生成文件、撤回消息只在能力支持且授权允许时执行。物理动作或不可撤销发送可能无法补偿，保留实际后果与停止点，不伪造“恢复原状”。

## 5. 失败与数据生命周期

- 回执缺失、冲突或无法验证：保留 unknown，不让模型自行合成成功凭据。
- 外部成功、写回数据库失败：重启先查询外部 operationId；去重端返回相同回执。若不可查询，则需要人工或替代证据核对。
- 核验通过但内层版本冲突：Task 结果保留，Proposal 重新读取内层后重评；不要重跑已经完成的外部动作。
- 发送结果未知：对话视图显示“发送结果未确认”，后续可以主动解释，但不能无界重复发送原消息。
- 原始产物 / 日志按数据保留策略回收，回执保留最小身份、摘要与状态。去重记录保留时间必须覆盖授权允许的重试 / 离线回执窗口；超窗的旧命令不重新当新动作接受。
- 删除或脱敏资料后，相关 ReadView、payloadRef 与待发 Effect 同时失效；只有必要审计元数据可按明确政策保留。

## 6. 验证与替代

全局验收见 [V12](<../../../../验证与验收.md#v12>)、[V23](<../../../../验证与验收.md#v23>)。下述数值是合成验证场景的初始配置，不是已测性能。

V12 用外部动作计数器，分别模拟支持原子幂等 / 查询的接收端和完全不支持的端点；在提交前后、claim 后、调用已完成而回执未落盘时退出。前者重复请求计数不增长，后者进入 unknown 且自动重放计数为 0。不能以丢掉原任务证明“没有重复”。

V12 同时覆盖：同键异内容冲突、旧 generation 回调不得删除新 outbox、撤权 / 删除发生在排队和派发之间、不可逆效果取消、凭据或 actor 伪造回执。V23 必须分别断言 Task、Effect、CommitReceipt、DeliveryReceipt 的真实结果，不用单一“成功”布尔值验收。

主方案是能力适配器提供的结构化回执与现成查询；不支持可靠查询的非幂等能力先限制为需核对的单次动作。只有受控模拟器证明恢复语义后才扩大自动化范围。Superagent Outbox 的既有实现直接作为副本基线，发送后 settle / 默认重试增加上述必要补丁；不因这些差异放弃其余可复用代码。保留 MIT 声明、原路径和补丁清单，升级不兼容时回到最后已验证副本。详见[复用核查](<../../../../../../research/2026-11-01-复用核查/任务执行.md>)；本轮未复制到产品或运行。

