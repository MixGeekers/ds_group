# 渠道链接

[所属区域](<../README.md>) · [完整目录](<../../../../目录.md>) · [全景图](<../../../../../图示/识雨全景架构-A.html>)

- 创建：2026-11-01（America/Caracas）。模块 ID：`links`，对应 2026-10-31 全景图。
- 实现状态：仅设计资料；运行系统未实现。
- 设计状态：2026-11-01 细化为验证用建议基线；未实施、未运行候选。
- 证据：[本轮一手来源与核查范围](<../../../../../../research/2026-11-01-完整架构/输入与外层.md>)。数值是首轮合成验证配置，不是已测性能。

## 渠道连接与队列补充（2026-11-01）

连接实现可由 OpenClaw 渠道侧车或平台官方 SDK 提供。侧车不是另一识雨核心：入站先取得 DSH 的持久 accepted/duplicate，再由 before_dispatch/合适 claim 路径返回 handled；中间任何崩溃按同 sourceEventId 重投。只返回 handled 后异步放内存会丢消息，禁止采用。侧车具备 durable ingress 的路径复用原生 monitor/drain，不具备的路径必须补持久交接或明确 gap。

真实出站 OpenClaw Gateway RPC 为 send（不是 chat.send），参数含 channel/accountId/to/message/replyToId/threadId/idempotencyKey，静态 scope 为 operator.write。桥必须收窄账号、目的地、Effect/payloadHash 和有效授权；不能把宽 Gateway 凭据给 replyer。专用桥入口/回执查询是需要适配的接口，不宣称上游自带 DSH bridge。sidecar delivery intent 是 Effect 的传输子记录，唯一传输 owner 重试，OUTBOUND_DELIVERY_QUEUED 不等于发送成功；跨重启去重与未知发送通过 V05 核查。

每次侧车/SDK 内部重试前也须执行当前授权和代次门禁；无法保证时不启用延迟自动重放。飞书 Channel 的回复目标撤销降级、格式降级、媒体 URL/本地路径自动读取及流式占位发送需显式约束；普通首轮回复只发经过门禁的完整草稿。删除/保留覆盖侧车 journal、session/transcript、媒体缓存及 DSH 数据。

固定来源、许可、真实 API 和未验证项见[渠道连接核查](<../../../../../../research/2026-11-01-连接订阅与技术栈/渠道连接.md>)。仅规划，尚未安装或接入。

## 2026-11-01 复用核查决定

**局部源码复用 + 载体适配。** 计划提取 DS-Bot `requests.js` 的 identity/verdict/known/admit 控制流，闭包只有 `node:crypto`、state.requests、rt.own/readOnly/save/warn 与 inflight Map。将持久接缝接入统一 Effect 服务，不再保留第二份 state.requests；身份取程序生成的 idempotencyKey，指纹直接取规范化 payloadHash，避免原 JSON.stringify 的键序差异。

保留“先持久受理再 work、并发重复共享结果、未知结果不重放”；原 delivered/uncertain 映射真实派发 succeeded/unknown，不将入队视为送达。原吞掉 save 错误的路径需改为可核对未知状态；只有证据证明未发送才能释放请求键。每次 dispatch 仍执行 Mandate/目的地/代次检查。Apache-2.0 来源和适用 NOTICE 随复制保留。V05 重点覆盖同键异内容、回执失败和重启未知状态；直接 DSH Remote 是载体备选，不替代幂等门禁。

固定版本、源码位置、依赖和许可见[复用核查](<../../../../../../research/2026-11-01-复用核查/输入与外层.md>)；以下业务契约继续有效。

## 主方案与职责

本模块实现受限 ChannelAdapter，连接输入来源与可发送目的地；复用 DSH Web / 桌面认证、插件 UI 和消息呈现，不重写聊天客户端。第一阶段只有已认证 owner 的专用识雨会话；外部平台加入时沿同一接纳与发送契约适配。

主体解析、受众核验和载荷登记在入口完成。外层只能提交观察事件、记录会话运行数据和请求获准回复，不得调用内部状态变更入口。源提供的 role、system、approved 字段都不成为有效权限。

## 入站接口

receive(raw,connectionContext) → 检查认证 principal、source 注册与正文大小 → 入站规范化 → IngressService.accept(EventEnvelope) → IntakeReceipt → 对话队列。连接边界以稳定 connectionId 绑定 provider/tenant/app/服务账号，connectorAccountRef 承接 OpenClaw accountId 等运行配置；对方 ParticipantAccount.accountId 单独记录。重连不变更串行键或去重域。clientMessageId 与 providerMessageId 的来源命名空间不能混用；编辑/删除在只有消息 ID 的平台上将原消息 ID、revision 与事件类型组合成独立 sourceEventId。

受理必须先持久化；存储失败回 status=rejected，并附统一错误码及适当 retryClass，不能显示已接收并依赖内存恢复。附件先通过受控导入得到 payloadRef，外层不按消息里路径直接读文件。用户内容中的链接、代码和项目说明只作为输入材料，工具执行由内部另行授权。

## 出站接口与状态

send(Effect,deliveryCapability) 前复核目的地、受众、conversationGeneration、authEpoch、tombstoneWatermark、关联 Task/Goal 取消状态及 Mandate；取消后的旧成果回复作废，当前请求的取消状态查询另取新视图。普通回复使用 Effect.origin={kind:dialogue,conversationId,turnId,conversationGeneration}，无需 worker Assignment；任务动作使用 task 关联。PolicyGate 为直接回复建立或解析由当前认证请求限定的有效 Mandate，绑定目的地与外发 scope，主动通知使用明确登记的 destination scope、频率与安静时段策略。

Effect 采用任务区统一状态：pending → dispatching → succeeded / failed / unknown；尚未派发可 cancelled。幂等键由程序从逻辑发送身份生成，与 payloadHash 同时保存；同键异内容拒绝。网络成功与平台送达/已读是不同凭据，Receipt 必须说明平台究竟确认了哪一步。

若收到平台成功但本地回执提交前退出，恢复后先用 providerMessageId / 幂等键查询。可查询则补记回执；不可查询保持 unknown，不盲重发。DSH 本地会话投影用 effectId 作唯一关联，可重复投影但不重复显示；不将此结果外推到外部平台。

## 生命周期与权限

卸载或关停先拒绝新发送、取消未开始请求，等待已派发请求达到已知结果或 unknown，再关闭连接。平台凭据由宿主凭据设施管理，只给适配器受限引用，不注入 replyer 上下文。连接器自身无需拿到内部数据库、长期记忆文件或完整私聊历史。

删除消息应立即失效依赖其内容的视图与未发草稿；已发送副本能否撤回按平台 capability 和独立授权处理。不得以保留“发送日志”为名永久保存正文，状态去重墓碑与正文应分开。

## 验证与替代

V02 验证同名不同主体、跨渠道 ID 冲突与伪造消息 role；不能越过身份映射。V05 在发送前、平台返回后、回执落盘前注入失败，重复派发 100 次；有幂等能力的假平台只见一个逻辑消息，无能力的假平台出现 unknown 后不自动再发。

平台没有可靠身份映射时不开启自动发送；平台仅缺幂等查询时可保留人工核对模式。若 DSH 原生 Chat 入口不能在通用执行前约束，改用专用插件入口，不放宽 replyer 工具权限来迁就 UI。

