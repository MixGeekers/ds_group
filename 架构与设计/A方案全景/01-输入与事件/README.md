# 输入与事件

[上级](<../README.md>) · [完整目录](<../目录.md>) · [全景图](<../../图示/识雨全景架构-A.html>)

- 创建：2026-11-01（America/Caracas）。区域 ID：`sources`，对应 2026-10-31 全景图。
- 实现状态：仅设计资料；运行系统未实现。
- 设计状态：2026-11-01 细化为验证用建议基线；未实施、未运行候选。
- 证据：[本轮一手来源与核查范围](<../../../research/2026-11-01-完整架构/输入与外层.md>)。数值是首轮合成验证配置，不是已测性能。

## 2026-11-01 复用核查决定

复用细化：身份与载体直接调用 DSH Peer/Typert/Remote Access；定时直接调用 Host Schedule；只保留来源身份、业务接纳、受众和事件去重规则。DS-Bot 的命名请求控制流作为发送侧局部源码复用，不替代入口持久账本。新增复用证据给出了 API、固定提交、许可和失败回退；本轮未安装运行。

固定版本、源码位置、依赖和许可见[复用核查](<../../../research/2026-11-01-复用核查/输入与外层.md>)；以下业务契约继续有效。

## 主方案与边界

入口分为认证用户、对话渠道和获准的外部事件。复用 DSH Web / 桌面认证会话及插件服务；外部事件在渠道边界使用 CloudEvents 1.0.2 JSON，再映射为识雨内部 EventEnvelope。标准仅提供事件格式，不提供身份认证、业务顺序、授权或持久投递。

识雨拥有输入接纳、来源标记和业务 inbox 语义；不新造通用聊天平台、身份提供方或消息中间件。第一阶段使用专用 shiyu-dialogue 会话入口，不能旁观已开始执行工具的通用 DSH Agent 再补做权限检查。DSH 接缝与版本由宿主方案统一锁定。

## 入口链路

认证连接 → 检查 source/actor/大小/协议版本 → 附加 receivedAt 与 conversationSeq → 同事务登记 inbox 与去重键 → 返回 IntakeReceipt → 唤醒内部处理 → core 决定是否形成 Goal、Task 或内部变更 → 外层等待获准视图。

IntakeReceipt = {eventId, status: accepted|duplicate|rejected, receivedAt, reasonCode?, commitSeq?}；accepted 代表输入已持久接纳。CommitReceipt 仅由内部受控提交服务产生，不能以“收到消息”声称“已记住”。

## 数据契约与所有者

| 项 | 验证基线 |
|---|---|
| EventEnvelope 必填 | eventId、type、schemaVersion、occurredAt、receivedAt、source、actor、correlationId、payloadRef、privacyClass |
| 可选关联 | conversationId、conversationSeq、goalId、taskId、causationId、expiresAt；未绑定对象的输入不得伪造其关联 |
| 可信元数据 | actor、source、receivedAt 由受信适配器生成；正文里相同名称的字段只作为内容 |
| CloudEvents 映射 | id → eventId，time → occurredAt，source URI → source；specversion 与内部 schemaVersion 分开。actor 等领域属性放 data，由入口验证，不能当凭据 |
| 业务去重 | 来源命名空间 + sourceEventId；平台只提供 messageId 时，由适配器将 sourceMessageId、revision、event kind 组合成 sourceEventId。相同键不同 payloadHash 拒绝。相同正文的两条独立消息不能误并为一条 |
| 持久化 | 统一 Store 服务写 inbox、操作回执及载荷引用；外层无六部分内层表的写接口，也不持有数据库句柄 |
| 敏感性与受众 | 每项载荷附数据分类、允许受众及来源。跨会话读取须由内部授权视图决定，不能靠提示词隔离 |

若原事件没有稳定来源 ID，连接器首次接纳时分配并持久化 ID；不具备重放标识的上游只能提供有限去重，文档和回执必须如实标明。发生时钟回拨按接纳顺序处理，occurredAt 只作源时间证据。

## 保留、恢复与过载

原始输入属于受保留策略管理的经历材料，不自动成为长期记忆。删除请求通过认证控制入口进入内部删除流程，并清除或失效化 inbox 载荷、派生视图、待发回复及相关 DSH Session 投影；已有外部平台副本与备份按数据方案分别报告，不承诺本地删除能消除所有副本。

接纳前崩溃由来源重试；持久接纳后崩溃由 inbox 重放，同一去重键只接纳一次。拒绝不能记作已受理。恢复不批量唤醒已暂停目标，过期事件保留被拒原因而不盲目补做动作。

首轮输入上限：单条文本 16 KiB，元数据封装 64 KiB；附件仅接纳受控对象引用，不在入口自动打开 URL / 远程路径。超限返回明确错误或交给获准文件导入流程，不能静默截断。队列容量和速率见外层队列；超额源能背压时拒绝并返回重试窗口，不能背压时登记 gap 事件并进入补偿扫描。

## 下级方案

- [用户与目标](<01-用户与目标/README.md>)
- [对话渠道](<02-对话渠道/README.md>)
- [外部事件](<03-外部事件/README.md>)

## 验证与切换条件

V02：两个主体、两个会话、伪造 actor、跨会话 ID 和同正文独立消息，全部得到可解释的接纳结果，未授权输入不获写权限。V03：重复 100 次、断电窗口、源时间倒序、删除后重放，已持久接纳项不丢且不重复形成业务变化。V23：由认证输入到内部提交、表达、回执完整关联。

DSH 专用入口无法可靠阻断默认通用 Agent 执行时，改用 DSH 插件提供的独立输入面板和受限模型调用接缝；仍复用宿主认证和呈现，不另建整个聊天产品。多进程高吞吐若在固定负载下持续超过单机账本容量，再评估消息代理，而非提前引入。

