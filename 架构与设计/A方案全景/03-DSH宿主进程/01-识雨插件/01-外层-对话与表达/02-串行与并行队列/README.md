# 串行 / 并行队列

[所属区域](<../README.md>) · [完整目录](<../../../../目录.md>) · [全景图](<../../../../../图示/识雨全景架构-A.html>) · [运行仪表盘与 Session 复用](<../../../../../运行仪表盘与Session复用.md>)

- 创建：2026-11-01（America/Caracas）。模块 ID：`dialogue-queue`，对应 2026-10-31 全景图。
- 实现状态：仅设计资料；运行系统未实现。
- 设计状态：2026-11-01 用户确认尽量复用 DSH Session；原生 inbox 为默认，以下调度与恢复规则尚待验证。
- 证据：[本轮一手来源与核查范围](<../../../../../../research/2026-11-01-完整架构/输入与外层.md>)。数值是首轮合成验证配置，不是已测性能。

## 渠道连接与队列补充（2026-11-01）

设计默认链路为 **平台传输队列 → 业务接纳与输入映射 → DSH 原生 Session / Agent inbox → 统一模型预算准入 → ReplyDraft → Effect/outbox → 渠道回执**。原生 inbox 管理会话待处理输入；ConversationService 保存业务接纳序号、输入与原生请求的映射以及草稿资格，不再叠加待答集合或第二份 Agent pending-list。平台队列只负责传输，业务 TaskService/worker 调度独立；后台长任务不占住聊天的等待队列。原生持久化与重启恢复边界需在当前宿主验证，不假定它与识雨 SQLite 共享事务。

会话串行键使用稳定 connectionId + 原生会话/线程 + 受众，connectionId 绑定 tenant/app/服务账号，不取临时连接实例；重连保持原键。接纳事务生成 conversationSeq，以稳定 eventId / turnId 对账原生 inbox 与请求。每会话最多一个生成任务；通过宿主调度与统一预算准入验证跨会话公平性，不额外包一层 Promise 队列。相同主体/受众未开始文本可 250 ms 合并，保留原 eventId；控制/删除不合并。新纠正先持久推进 conversationGeneration，再取消旧计算；迟到结果即使返回也不能发送。Session 按 conversation + scope 保持，推进 generation 不换 Session。队列满明确背压或 gap，不静默丢弃。

普通问答/已有任务状态可直接受限 ReadView → replyer；需要行动、长期变更或目标判断才转 core。needs_core 以原 eventId 一次升级，不把它重新造事件回送。最终发送由 Effect 独占：pending/dispatching/unknown 各有恢复策略，未知先核对；侧车已有待发 intent 时 DSH 不绕路重复发送。

OpenClaw 飞书 sequential-queue 超时后旧任务仍运行、后续同 key 已放行，因此不复制它作为识雨无重叠保证。无论原生取消、超时还是备选 p-queue 超时，都不能单独证明计算已停止或外部发送未发生，必须保留代次/发送门禁。V05 加入侧车断连、SDK 内重试、晚到结果及两路重复派发情形。

固定来源、许可、真实 API 和未验证项见[渠道连接核查](<../../../../../../research/2026-11-01-连接订阅与技术栈/渠道连接.md>)。仅规划，尚未安装或接入。

## 2026-11-01 复用核查决定

**本次用户确认后，原生 Session / inbox 为默认。** replyer 也优先使用受限原生 Agent，验证 `Agent.send/inbox.append/replace/remove/clear/cancel` 等公共接缝的实际语义；创建与恢复前验证角色准入、`tools=[]` 和 scope，复用原生历史、恢复与压缩。conversationGeneration、受众、授权与发送资格是识雨适配，不能因此再建一份待答队列。模型生成与原生摘要额外调用共同计入宿主统一预算，不新建额外模型槽。

历史核查曾建议无工具 replyer 采用 p-queue 9.0.1（MIT、ESM、Node ≥20）的 `PQueue({concurrency:1})`、`add(fn,{id,signal})`、`onSizeLessThan`、`pause/onPendingZero`，依赖 eventemitter3 与 p-timeout。该路线现在仅在证实原生边界不能满足必要隔离或取消要求后作为备选评估，未安装或采用。若启用旁路，p-queue 只保留 turnId 引用并复用统一预算，不与原生 inbox 同时调度同一输入；不能自建第二套会话历史或压缩。

p-queue 不持久化，不证明外部发送未发生；备选恢复也须对账业务接纳记录、输入来源与原生 Session 状态。容量接纳由单一接纳器原子判断，不能把 onSizeLessThan 当并发原子配额。运行中的任务仍需配合 AbortSignal，迟到结果由代次门禁挡住。MaiBot runtime 的 asyncio.Queue 依附 Python 会话、消息库、工具与学习器闭包，不复制整 runtime。V05 验证原生队列、取消与恢复语义，V23 验证统一预算与后台任务并行。

固定版本、源码位置、依赖和许可见[复用核查](<../../../../../../research/2026-11-01-复用核查/输入与外层.md>)；以下业务契约继续有效。

## 主方案与复用

会话级协调器默认使用 DSH 原生 Agent / Session 与公共 inbox 接缝。业务接纳、幂等去重、conversationSeq、原生 Session / 请求映射和草稿资格使用统一 SQLite 账本服务；原生 inbox 保有待处理输入，原生 Session 保有模型历史与压缩结果。两者以稳定标识和恢复对账衔接，不假设跨存储原子提交，也不复制同一份待答状态。只增加识雨特有的 conversationGeneration、受众和过时发送规则，不引入 Redis / Kafka / 独立工作流平台。

对话队列只保存局部调度事实，不复制 Goal、Task、Assignment 或 Effect 权威状态。业务任务可在后台继续；同一会话谁能生成和发送回复由局部调度器决定。

## 排序与控制规则

| 维度 | 主方案 |
|---|---|
| 串行键 | connectionId + 原生 conversationId + 原生 threadId（如有）+ audienceMode；接纳事务分配 conversationSeq |
| 新消息 | 影响当前答复的消息推进 conversationGeneration；旧生成尚未发送则协作取消，通过原生 inbox 处理当前未答输入并重新取视图；generation 失效不重建 Session |
| 合并 | 仅同会话、同主体、同受众、未开始处理的文本可在 250 ms 窗口合并；保留各原 eventId，不合并控制/删除事件 |
| 控制优先级 | 认证停止、撤权、删除独立控制通道，不排在长模型调用之后；文本控制仍由 core 判断 |
| 并发 | 同会话最多一个生成、一个严格有序发送；跨会话公平共享 1 个预留 replyer 模型槽；全局模型并发 3，后台 core / worker 合计最多 2 |
| 防饥饿 | 跨会话轮转，同会话连续消息可合并但不能永久占用全部槽；20 条待答文本到上限后背压，不静默丢弃 |
| 发送资格 | conversationGeneration、scopeHash、authEpoch、tombstoneWatermark、policyVersion 与关联 Task/Goal 取消状态均通过程序检查；旧成果回复作废，当前请求的取消状态查询可使用新视图回复；之后经统一 Effect 服务派发 |

输入源声称的顺序只作证据；程序的接纳序号负责业务顺序。先到的旧输入若迟于新状态，必须按当前 Goal 与授权重新评估。

## 局部状态与崩溃恢复

ConversationService 管理的 DialogueTurn 保存 turnId、conversationId、conversationKey、conversationGeneration、inputEventIds、nativeSessionId、nativeRequestId、viewId、draftId 和业务状态 queued/generating/ready/cancelled/failed；字段为适配契约，不声称当前宿主 API 已提供全部同名字段。业务状态用于追踪接纳与草稿，不作为第二个模型输入队列。普通回复关联 origin.kind=dialogue 的 Effect，任务动作关联 origin.kind=task；两类均核验有效 Mandate 和目的地范围。发送状态始终读关联 Effect，不另建“成功”标志。进程重启先恢复原 Session，再以稳定输入标识核对原生 inbox、进行中的请求与已有结果；只有确认未接纳或需要重试的输入才重新追加，不能见 generating 就重复排队。ready 草稿必须重新验证资格，过期视图则重取。

取消立即持久化 conversationGeneration 增量或失效标记，AbortSignal 只负责停止计算；模型或工具不响应取消时其迟到输出仍因 conversationGeneration 校验失效。已派发发送可能 unknown，不能用 abort 宣称消息没有出去。未知发送未核对前阻止该会话后续依赖它的自动消息，独立状态查询仍可用。

## 背压与测量配置

首轮合成负载固定为 20 个会话、总 1000 条短消息、输入突发 10 条/秒；按全局预算设置并发，默认 1 个预留对话模型槽，后台最多 2 个模型槽。每会话待答文本上限 20，总待处理输入上限 1000；控制消息有独立有界入口，但同样受认证与抗滥用限制。

验收目标：本地接纳回执 p95 ≤ 500 ms，认证停止在 p95 ≤ 1 s 内使新发送失效；上述时间不包含模型或外部平台响应，模型首字延迟单独报告。资源限制触发时记录原因与队列深度，不能通过无限增加并发解决。

## 验证与替代

V05：两会话并行，其中一会话连续纠正十次，旧 conversationGeneration 发送数为 0；在每个局部状态重启，原生 inbox 与业务记录对账后已受理输入不丢、不重复生成；原生 Session 身份在 generation 推进后保持；假模型忽略 AbortSignal 时迟到结果仍被拒；队列满有明确背压。创建与恢复前验证受限 replyer 的角色准入和工具隔离。V23：后台 Task 运行中仍可查询其已知状态，生成与压缩调用共用预算，但不声称未完成任务已经成功。

只有在当前宿主验证确认原生 Agent / Session 的必要隔离或取消边界无法满足，并记录具体缺口后，才评估上述 p-queue 与 `ctx.llm.stream` / DS-Bot callAside 旁路；保留输入映射、统一预算与失效门禁，禁止同时启用两套待答调度，禁止写新的 Agent 推理循环或会话压缩引擎。若原生调度或业务账本在固定负载下未达门槛，先核查适配和容量策略，再依据实测评估替代方案，不因缓存假设绕过原生 Session。

