# 串行 / 并行队列

[所属区域](<../README.md>) · [完整目录](<../../../../目录.md>) · [全景图](<../../../../../图示/识雨全景架构-A.html>)

- 创建：2026-11-01（America/Caracas）。模块 ID：`dialogue-queue`，对应 2026-10-31 全景图。
- 实现状态：仅设计资料；运行系统未实现。
- 设计状态：2026-11-01 细化为验证用建议基线；未实施、未运行候选。
- 证据：[本轮一手来源与核查范围](<../../../../../../research/2026-11-01-完整架构/输入与外层.md>)。数值是首轮合成验证配置，不是已测性能。

## 渠道连接与队列补充（2026-11-01）

实际链路为 **平台传输队列 → DSH 持久 inbox → ConversationService 待答集合 → p-queue 模型执行槽 → ReplyDraft → Effect/outbox → 渠道回执**。平台队列只负责传输，业务 TaskService/worker 调度独立；后台长任务不占住聊天的等待队列。

会话串行键使用稳定 connectionId + 原生会话/线程 + 受众，connectionId 绑定 tenant/app/服务账号，不取临时连接实例；重连保持原键。接纳事务生成 conversationSeq；p-queue 只保存 turnId 引用。每会话最多一个生成任务，每次仅一个候选进入全局队列，完成后把该会话后续项排尾。相同主体/受众未开始文本可 250 ms 合并，保留原 eventId；控制/删除不合并。新纠正先持久推进 conversationGeneration，再 abort 旧计算；迟到结果即使返回也不能发送。队列满明确背压或 gap，不静默丢弃。

普通问答/已有任务状态可直接受限 ReadView → replyer；需要行动、长期变更或目标判断才转 core。needs_core 以原 eventId 一次升级，不把它重新造事件回送。最终发送由 Effect 独占：pending/dispatching/unknown 各有恢复策略，未知先核对；侧车已有待发 intent 时 DSH 不绕路重复发送。

OpenClaw 飞书 sequential-queue 超时后旧任务仍运行、后续同 key 已放行，因此不复制它作为识雨无重叠保证。p-queue 超时同样不证明任务停止，必须保留代次/发送门禁。V05 加入侧车断连、SDK 内重试、晚到结果及两路重复派发情形。

固定来源、许可、真实 API 和未验证项见[渠道连接核查](<../../../../../../research/2026-11-01-连接订阅与技术栈/渠道连接.md>)。仅规划，尚未安装或接入。

## 2026-11-01 复用核查决定

**直接使用成熟队列。** 无工具 replyer 路线采用 p-queue 9.0.1（MIT、ESM、Node ≥20）的 `PQueue({concurrency:1})`、`add(fn,{id,signal})`、`onSizeLessThan`、`pause/onPendingZero`；依赖 eventemitter3 与 p-timeout，实际锁版本由验证环境固定。每会话最多一个执行候选进入全局队列，完成后将后续项排尾；conversationGeneration 与公平规则是产品适配，Promise 调度/取消/排空不再自写。与宿主模型预算服务共享额度，不新建额外模型槽。

p-queue 不持久化，不证明外部发送未发生；业务 inbox/DialogueTurn 是恢复依据，容量接纳由单一接纳器/事务原子判断，不能把 onSizeLessThan 当并发原子配额。运行中的任务仍需配合 AbortSignal，迟到结果由代次门禁挡住。

若使用完整专用 Agent 路线，直接用 DSH `Agent.send/inbox.append/replace/remove/clear/cancel`，不再叠加一份 Agent pending-list。MaiBot runtime 的 asyncio.Queue 依附 Python 会话、消息库、工具与学习器闭包，移植收益低于同栈直接依赖；不复制整 runtime。V05 验证队列语义，V23 验证预算与后台任务并行。

固定版本、源码位置、依赖和许可见[复用核查](<../../../../../../research/2026-11-01-复用核查/输入与外层.md>)；以下业务契约继续有效。

## 主方案与复用

会话级协调器使用上述 p-queue 或 DSH 专用 Agent 公共 inbox 接缝；持久游标和待处理输入使用统一 SQLite 账本服务。只增加识雨特有的 conversationGeneration、受众和过时发送规则，不引入 Redis / Kafka / 独立工作流平台。

对话队列只保存局部调度事实，不复制 Goal、Task、Assignment 或 Effect 权威状态。业务任务可在后台继续；同一会话谁能生成和发送回复由局部调度器决定。

## 排序与控制规则

| 维度 | 主方案 |
|---|---|
| 串行键 | connectionId + 原生 conversationId + 原生 threadId（如有）+ audienceMode；接纳事务分配 conversationSeq |
| 新消息 | 正常情况下进入下一 conversationGeneration；旧生成尚未发送则协作取消，合并当前未答输入后重新取视图 |
| 合并 | 仅同会话、同主体、同受众、未开始处理的文本可在 250 ms 窗口合并；保留各原 eventId，不合并控制/删除事件 |
| 控制优先级 | 认证停止、撤权、删除独立控制通道，不排在长模型调用之后；文本控制仍由 core 判断 |
| 并发 | 同会话最多一个生成、一个严格有序发送；跨会话公平共享 1 个预留 replyer 模型槽；全局模型并发 3，后台 core / worker 合计最多 2 |
| 防饥饿 | 跨会话轮转，同会话连续消息可合并但不能永久占用全部槽；20 条待答文本到上限后背压，不静默丢弃 |
| 发送资格 | conversationGeneration、scopeHash、authEpoch、tombstoneWatermark、policyVersion 与关联 Task/Goal 取消状态均通过程序检查；旧成果回复作废，当前请求的取消状态查询可使用新视图回复；之后经统一 Effect 服务派发 |

输入源声称的顺序只作证据；程序的接纳序号负责业务顺序。先到的旧输入若迟于新状态，必须按当前 Goal 与授权重新评估。

## 局部状态与崩溃恢复

ConversationService 管理的 DialogueTurn 保存 turnId、conversationId、conversationKey、conversationGeneration、inputEventIds、viewId、draftId 和状态 queued/generating/ready/cancelled/failed。普通回复关联 origin.kind=dialogue 的 Effect，任务动作关联 origin.kind=task；两类均核验有效 Mandate 和目的地范围。发送状态始终读关联 Effect，不另建“成功”标志。进程重启将未有可靠草稿的 generating 重新排队；ready 草稿必须重新验证资格，过期视图则重取。

取消立即持久化 conversationGeneration 增量或失效标记，AbortSignal 只负责停止计算；模型或工具不响应取消时其迟到输出仍因 conversationGeneration 校验失效。已派发发送可能 unknown，不能用 abort 宣称消息没有出去。未知发送未核对前阻止该会话后续依赖它的自动消息，独立状态查询仍可用。

## 背压与测量配置

首轮合成负载固定为 20 个会话、总 1000 条短消息、输入突发 10 条/秒；按全局预算设置并发，默认 1 个预留对话模型槽，后台最多 2 个模型槽。每会话待答文本上限 20，总待处理输入上限 1000；控制消息有独立有界入口，但同样受认证与抗滥用限制。

验收目标：本地接纳回执 p95 ≤ 500 ms，认证停止在 p95 ≤ 1 s 内使新发送失效；上述时间不包含模型或外部平台响应，模型首字延迟单独报告。资源限制触发时记录原因与队列深度，不能通过无限增加并发解决。

## 验证与替代

V05：两会话并行，其中一会话连续纠正十次，旧 conversationGeneration 发送数为 0；在每个局部状态重启，已受理输入不丢；假模型忽略 AbortSignal 时迟到结果仍被拒；队列满有明确背压。V23：后台 Task 运行中仍可查询其已知状态，但不声称未完成任务已经成功。

若 DSH 专用 Agent 接缝不适用，采用上述 p-queue 旁路方案，保留持久游标和失效门禁；禁止写新的 Agent 推理循环。若 SQLite 排队在固定负载与合理索引下无法达到门槛，再评估成熟任务队列及多进程方案。

