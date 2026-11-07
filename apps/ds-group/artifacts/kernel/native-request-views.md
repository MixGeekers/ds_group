# 可靠请求中的历史派生记忆视图

2026-11-07，代码 `f24ef49`，基于 `1e1d524`。本切片修补另一条独立的重复通道：`NativeBridge` 读取 attention view 后，`nativeMessage` 将它写入普通 `user/message` 的 JSON；部分输入的 `context.attention.memoryView` 又带入一份。只退役 `knowledge-context` 不能移除这些历史请求中的派生数据。

## 实际记录的只读核查

使用 full-run-01 识雨 Session 的实际 v4 压缩日志，逐帧只读解码，再用官方 `Session.create()` 重建 full-079 请求边界 seq1101。原文件未改、未启动宿主或调用模型。这是原生活动 surface 的重建，不是完整 provider HTTP 抓包；当次 calls 日志没有请求正文。

该边界有 10 条原生派生消息，其中一条是派发时省略的空退役节点。一个历史请求包含 7875、7789 字符的两个 view，当前请求又包含 7940 字符的 view；此外还有 12384 字符的当前 knowledge frame。更早请求已被 checkpoint 替换，所以不能说所有历史请求都仍直接活动。

36656 字符的 checkpoint 仍在活动输入中，明确保留预算 900、余 319，以及原 17 项测试通过、2455 字节日志；其 memoryView 字样只是旧固定说明，不含实际 view JSON。重复通道已证实，但这不能独立证明它造成当次事实混淆。

在内存副本应用修补后，两个可靠请求中的三个 view 字段全部移除，当前 knowledge frame 保留。两个请求的 message ID、source、原人类正文、近期房间历史与 replyRoute，以及 checkpoint 和其它消息均未变；1102 个原始事件的指纹不变。见[只读重建证据](native-request-view-audit.json)。

## 最小修补

`src/native-request.mjs` 只处理 top-level `memoryView` 与 `context.attention.memoryView`。新请求在序列化前去掉这两个派生字段；attention 的参与模式与其它控制仍保留，运行时当前 `knowledge-context` 提供当前记忆视图。没有改动用户正文中同名字段或引用的文字。

兼容历史消息时，必须同时匹配持久 source 的 request/rpc ID、事件、房间、发送者，以及 envelope 的当前消息、context、replyRoute 和原生 self 结构。仅出现 `DSCORD_REQUEST` marker、复制的引用或身份不匹配均不授权修改。

官方 projection 索引升级到 stateVersion 2，只增存可靠请求的 seq/ID。旧请求在压力判断、下一步或显式维护前，通过原生 `compaction/prune` 与 `user/message` surface replacement 去掉派生字段；保留原 message ID/source，原始事件及正文仍在 append-only 日志。prune 使用官方 `estimateMessage()` 更新启发式上下文计量，不代表 provider 费用。

替换事件不是新的人类发言：记忆监听不再次 ingest，也不移动当前说话人。`parts` 的来源历史回放对可靠原始请求应用同一纯投影，checkpoint、handoff 和历史查询不会从 raw append 记录重新带回旧 view；替换副本不重复显示为聊天或写入携带历史。真正的人类、工具、委派与工作记录保留。

## 本轮验证与边界

- `node scripts/check.mjs`：语法、两套 TypeScript 与 728 项模块检查通过。
- 干净官方 DSH `0.2.2-rc.1` 上 `npm run test:kernel-host`：28 项通过，无额外 testkit。
- 实际隔离 DSH、私有锁定依赖、localhost 脚本 provider：14 次调用、10 项检查通过，0 远端模型。覆盖旧 envelope 冷恢复、原始事件指纹、同 Session、工具配对、source 不重写/说话人不回退、旧请求未进下一轮就直接 checkpoint、自动压缩、跨 part 原文及正常 `NativeBridge` 入口。见[实际宿主证据](native-request-view-host.json)。

已写成自然语言摘要或任意用户引用的内容保留原样，不按 marker 或字段名猜删。外部 CLI 自己保留的已提交历史仍受其接口能力限制。本切片证明输入投影与生命周期，不宣称真实模型事实判断或完整长程业务复验已通过；后续正常人类反馈由主线程运行。
