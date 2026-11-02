# 对话渠道

[所属区域](<../README.md>) · [完整目录](<../../目录.md>) · [全景图](<../../../图示/识雨全景架构-A.html>)

- 创建：2026-11-01（America/Caracas）。模块 ID：`channels`，对应 2026-10-31 全景图。
- 实现状态：仅设计资料；运行系统未实现。
- 设计状态：2026-11-01 细化为验证用建议基线；未实施、未运行候选。
- 证据：[本轮一手来源与核查范围](<../../../../research/2026-11-01-完整架构/输入与外层.md>)。数值是首轮合成验证配置，不是已测性能。

## 渠道连接与队列补充（2026-11-01）

新增两条并行验证路线：**OpenClaw 统一渠道侧车 + 识雨接管桥/有限失败阻断补丁**，以及 **QQ 官方 qqbot-nodejs / 飞书官方 createLarkChannel 直连**。DSH 仍是唯一核心，平台 SDK 已有 token、重连和高层消息能力；不自建 IM 协议。统一侧车保留多账号、配对、媒体/卡片和投递整合收益，不因 hook 缺口直接排除。

WhatsApp 的 OpenClaw 插件是 Baileys / WhatsApp Web QR linked-device，Meta Business Cloud API 为独立官方业务路线；QQ 官方 Bot 不等于个人 QQ 账号；飞书 OpenClaw 插件为社区维护，厂商官方 SDK 已有高层 Channel。平台账号、主动消息范围、身份类型和 app/tenant 命名空间分别声明。公开目录能力不等于全联系人或主动联系授权。

OpenClaw ChannelPlugin 依赖宿主 PluginRuntime，不能直接拷入 DSH。before_dispatch 可接管，但默认 fail-open 且不是全部路径无条件执行；只有通过 V04 桥缺失/超时/媒体/命令/热卸载均无普通模型与工具调用后，才允许作为纯渠道侧车。两路以 V02/V03/V05/V23 同场景比较，不预估未经测量的实施工作量。

固定来源、许可、真实 API 和未验证项见[渠道连接核查](<../../../../research/2026-11-01-连接订阅与技术栈/渠道连接.md>)。仅规划，尚未安装或接入。

## 2026-11-01 复用核查决定

**直接使用 + 适配。** 使用 DSH Host Gateway/Typert 的专用 `@Remote` 服务与已有 UI，服务从 `this.ctx.invocation.peer` 取得身份和取消信号；inbox 接纳早于任何 Agent 消费。首阶段直接复用 DSH 载体，不增加第三方 IM SDK。专用 Agent 路线使用 `ctx.agents.create({...,setup})` 在发布前安装角色约束，不能事后订阅通用 Agent 补救。

ChannelAdapter 只承担 EventEnvelope、会话身份、能力声明、Effect/Receipt 映射等差异。DSH 的 owner Remote 放行不替代业务 scope；登录/token 的完整实现尚未审计，验证须覆盖真实连接。第二平台确定后优先其官方 SDK 或成熟连接器，按 V02/V03/V05 验收后加入，不为了抽象提前复制 MaiBot 平台运行体。

固定版本、源码位置、依赖和许可见[复用核查](<../../../../research/2026-11-01-复用核查/输入与外层.md>)；以下业务契约继续有效。

## 选型与范围

第一阶段采用 DSH Web 与桌面载体已有的认证连接、Session 呈现和插件 UI；它们是同一识雨中心的入口，不各自维护一个人格。桌面版和 Web 服务应按宿主部署方案选择实际运行方式，不能同时启动两个未协调的权威写入者。

第二阶段接入聊天平台时优先使用平台官方 API 或维护活跃的现有连接器，经 ChannelAdapter 转换；本方案不提前选定用户未指定的平台，也不自制 IM 协议。每个连接器必须通过下述契约，才能宣称支持其平台。

## ChannelAdapter 契约

| 能力 | 最小要求 |
|---|---|
| receive | 验证连接与来源；返回稳定 sourceEventId；无独立事件 ID 时提供 sourceMessageId、revision、event kind 供入口组合，另附 principalId、conversationKey、内容引用 |
| edit / delete | 平台支持时提供原消息关联；不支持时标为 capability=false，不假造删除完成 |
| send | 输入 Effect ID / 幂等键、目标会话、payloadHash 与内容；输出 providerMessageId 与 Receipt |
| queryReceipt | 能按幂等键或 providerMessageId 查询；不能查询则派发结果 unknown 不自动重发 |
| control / health | 取消未开始发送、断连状态、速率限制窗口；已发送内容撤回是另一项有权限的操作 |
| capabilities | 文本、附件、流式呈现、编辑、撤回、幂等发送及回执查询分别声明 |

conversationKey = connectionId + providerConversationId + providerThreadId（如有）+ audienceMode。不能将同名群或两台设备的窗口当成同一会话。跨平台主体合并只接受验证过的配对映射，显示名和模型猜测不参与权限归属。

connectionId 是持久连接绑定，关联 provider、tenant/app 与服务账号；重连、进程重启或 connector session 更新不改变它。connectorAccountRef 保存 OpenClaw accountId 或 SDK 服务账号引用；ParticipantAccount.accountId 是对方账号，三者不可混用。入站去重域使用稳定 connectionId + 原生事件 ID；只有消息 ID 时加入 revision/event kind。跨连接同一原生 ID 不合并。

## Session 与账本分工

DSH 原生 Session 管理模型历史、inbox、恢复与压缩，Goal 生命周期以其专用 Session 日志为权威；识雨控制账本保存 GoalBinding、业务接纳与原生请求映射、授权、Task 和 Effect。两者按稳定标识恢复对账，不复制第二套待答队列或 Goal 生命周期。界面刷新、Session 压缩或开启新段不得重新接受同一业务事件。先登记 IntakeReceipt，再向受限 replyer Session 追加输入，不能用 onMessage 旁路把已执行的通用 Agent 事后改成只读。当前路线见[运行仪表盘与 Session 复用](<../../../运行仪表盘与Session复用.md>)。

DSH 已有日志可能保存正文，因此外层的短期上下文保留期不能覆盖或假定控制了宿主日志。验证时应使用独立测试 profile，显式盘点 Session 日志、模型请求记录、会话日志贡献与平台留存；删除完成回执按各层实际结果分别说明。

## 恢复与验收

断线时保持唯一 inbox 事件身份；恢复后先拉取已知游标后的消息，再与已接纳 ID 去重。source cursor 只有在接纳记录持久后推进。消息发送超时进入 Effect.unknown；第三方平台没有查询能力时由人工或用户核对，不能重启后全部重发。

V02 验证两个渠道的相同 provider ID 不串线，私人标记不会出现在另一受众视图。V03 验证游标推进前后崩溃，不丢已接纳输入。V05 验证断连、限流、重复发送请求及未知结果，不虚报发送成功。首阶段 DSH 页面可用 Effect ID 作为消息投影唯一键，实现本地呈现去重；这不外推为网络平台恰好一次。

若目标平台无法证明身份或无法约束受众，先采用只读收集或停止接入；若只能人工转发，则明确该渠道不支持自动可靠发送。

