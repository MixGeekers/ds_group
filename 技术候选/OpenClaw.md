# OpenClaw

[候选目录](<目录.md>) · [总体架构](<../架构与设计/总体架构.md>) · [渠道连接核查](<../research/2026-11-01-连接订阅与技术栈/渠道连接.md>)

| 项目 | 内容 |
|---|---|
| 类型 / 方向 | 多渠道智能体运行宿主；本次只评估渠道侧车、原生渠道插件及有限源码复用 |
| 来源 | [openclaw/openclaw](https://github.com/openclaw/openclaw) |
| 核查日期 / 快照 | 2026-11-01；[04fefb3455a0b0779909b251dbabb19f4d61db29](https://github.com/openclaw/openclaw/commit/04fefb3455a0b0779909b251dbabb19f4d61db29)，package 2026.10.9 |
| 许可 | MIT，源码版权与许可已读；依赖完整许可证锁尚待验证环境核对 |
| 宿主要求 | Node ≥24.16 且 <25，或 ≥26.1；ChannelPlugin 依赖 OpenClaw PluginRuntime，与 DSH 运行时不是同一 API |
| 候选状态 | **已初评**；统一渠道侧车是条件验证路线，尚未确认采用 |
| 证据 / 实施 | 官方文档、限定源码静态核查；未安装、登录、运行、复制产品源码或接入真实渠道 |

## 当前判断

可以复用它接 WhatsApp、QQ、飞书，DSH 继续承载识雨核心。优先比较**完整 OpenClaw 渠道侧车 + 小型接管桥及失败阻断补丁**，不拆整个运行时伪装成传输 SDK。这样可保留多平台账号、QR、重连、媒体、目录和投递整合能力；桥不是目前已有的 DSH 集成产品。

另一条对照路线直接使用腾讯 QQ Bot SDK 与飞书官方 Lark Channel；两者已经封装 Bot 生命周期或高层传输/格式能力，不是从头实现连接层。三渠道一起用时侧车可能摊薄整合成本；单 QQ/飞书以及侧车补丁扩散时，官方 SDK 更值得选。未实测前不宣称任一路整体维护量一定更小。

## 已核查机制与实际限制

| 能力 | 来源 | 对识雨的适配结论 |
|---|---|---|
| 渠道插件 | [sdk-channel-plugins](https://github.com/openclaw/openclaw/blob/04fefb3455a0b0779909b251dbabb19f4d61db29/docs/plugins/sdk-channel-plugins.md) | 平台账号/原生发送可复用，但路由、session、dispatch、运行时仍由宿主提供；不能整目录拷入 DSH 即用 |
| 接管入站 | [before_dispatch 文档](https://github.com/openclaw/openclaw/blob/04fefb3455a0b0779909b251dbabb19f4d61db29/docs/plugins/hooks/messages.md) | 返回 handled 可无模型回复接管；DSH 持久 accepted/duplicate 后才能确认 |
| 失败语义 | [hooks.ts](https://github.com/openclaw/openclaw/blob/04fefb3455a0b0779909b251dbabb19f4d61db29/src/plugins/hooks.ts)、[choose-route](https://github.com/openclaw/openclaw/blob/04fefb3455a0b0779909b251dbabb19f4d61db29/src/auto-reply/reply/dispatch-from-config.choose-route.ts) | before_dispatch 默认 fail-open，且部分受限上下文跳过；需要宿主 guard，不能靠抛异常或 model=null 假装纯网关 |
| 原生出站 | [Gateway send](https://github.com/openclaw/openclaw/blob/04fefb3455a0b0779909b251dbabb19f4d61db29/src/gateway/server-methods/send.ts)、[scope 描述](https://github.com/openclaw/openclaw/blob/04fefb3455a0b0779909b251dbabb19f4d61db29/src/gateway/methods/core-descriptors.ts) | 实际 RPC 是 send，operator.write；不是 chat.send。幂等键存在但跨重启保证未证，需 Effect/intent 回执关联与窄桥 |
| 持久入站/出站组件 | [channel-outbound API](https://github.com/openclaw/openclaw/blob/04fefb3455a0b0779909b251dbabb19f4d61db29/docs/plugins/sdk-channel-outbound.md) | 优先用现有 monitor/drain/sendDurableMessageBatch；某渠道每类事件是否全部经该链路尚待验证，queued 不等于 delivered |
| 飞书串行队列 | [sequential-queue.ts](https://github.com/openclaw/openclaw/blob/04fefb3455a0b0779909b251dbabb19f4d61db29/extensions/feishu/src/sequential-queue.ts) | 超时让下一项继续而旧调用不停止；不复制为识雨的发送一致性保证 |

## 平台路线

- **WhatsApp**：当前 OpenClaw 插件为 Baileys / WhatsApp Web QR linked-device，适合验证现有账号连接生命周期；Meta Business Cloud API 是另一条官方业务路线，两者账号/模板/消息能力不同。
- **QQ**：腾讯维护 @tencent-connect/openclaw-qqbot；其独立 [qqbot-nodejs](https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/USAGE.md)已有 start/stop、token、重连、发送、sessionPersistence，可直接 DSH 使用。官方 Bot 不等于个人 QQ 好友/群登录。
- **飞书**：OpenClaw 官方插件是社区维护；飞书厂商官方 [node-sdk 高层 Channel](https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/docs/channel.zh.md)已有 createLarkChannel/connect/send/stream、媒体、卡片、归一化和重连。直连仍需审 dedup/stale、自动重试/降级与原始身份类型。
- **个人 QQ 桥接**：不与官方 Bot 混为一项；NapCat 的自定义许可和 NTQQ 运行依赖另评，不纳入默认 MIT 复制计划。

## 状态与副作用

侧车持有平台凭据、连接/配对状态、传输 journal 和可能的原生 session/transcript；DSH 持有业务 inbox、对话代次与 Effect。原始内容保存不是长期记忆。桥无权写识雨六部分状态，副作用只有获准传输。识雨数据删除和保留必须覆盖侧车副本、插件媒体缓存与日志，不能只清 DSH。

DSH Effect 已交给 sidecar intent 后，由唯一传输 owner 负责原生重试；DSH 不从 SDK 再发一份。每次实际派发/恢复重放均核对授权、删除、代次。未知结果核对前保持 unknown；普通模型/工具进入次数必须为 0。凭据不给 replyer，外部渠道与内容不构成内部授权。

## 待验证与退出条件

V02 身份/资源/受众；V03 接纳/handled 的崩溃窗口；V04 桥缺失、异常、热卸载、媒体/命令分支均不回退默认 Agent；V05 新消息打断、过时发送和未知回执；V23 同一场景比较侧车与 SDK。具体范围和复制/补丁位置见[完整核查](<../research/2026-11-01-连接订阅与技术栈/渠道连接.md>)。

2026-11-01：根据用户希望复用连接层的方向形成两条验证路线。若少量明确边界补丁就能通过，保留统一侧车；若需要改多条推理/命令链或无法覆盖重放授权，切 SDK 对照。当前未进入实施阶段。
