# 原生知识快照的活动上下文替换

2026-11-07。实施针对 DSH `0.2.2-rc.1`，不改写 run01 的 53 帧、约 483k 字符累积失败。此次使用隔离 DSH home、官方 SDK、真实 read 工具与 localhost 脚本 provider；没有远端模型、用户当前 DSH、真实 Matrix 或物理跨机器操作。当前上下文的作者/房间首步准备沿用 `afb0429`，跨原生 part 的原文保留沿用 `871742b`。

后续可靠请求内嵌 view 的独立修补见[历史派生记忆视图](native-request-views.md)，不回改本页首轮证据。

## 官方接入与事件含义

`memory/snapshot-context.mjs` 向 `ctx.sessionProjections.register()` 注册 `dscord-memory-snapshots`，索引只保存 snapshot 的 Session seq 和 message ID。重放、缓存、水位及生命周期由官方 registry 管理；热路径不调用已弃用的 `eventAt/snapshotEvents/ownEvents`，也不复制 snapshot 正文到第二套历史。

下一步模型输入组装前，helper 交叉核对官方 `session.surface.nodes`、`session.deriveMessages()` 和索引，只处理当前活动的 `source.kind=knowledge-context` 节点。每个旧节点产生两个原生事件：

1. `session.append('compaction/prune', {shadowedRange:{start:oldSeq,end:oldSeq},shadowedSeqs:[oldSeq],shadowedTokenCount:estimateMessage(oldMessage)})`。`estimateMessage` 来自 `@deepseek-ai/dsh-token-meter/estimate`。这是官方 tokenMeter 重放计量所用的旧范围估算，随后发生替换时可以扣除旧 snapshot 的启发式 token 数，不是 provider 用量、费用或模型摘要调用。
2. `session.append('user/message', emptyMessage, {surfaceOp:{op:'replace',startSeq:oldSeq,endSeq:oldSeq},sourceEventSeqs:[oldSeq,pruneSeq]})`。空 message 的 source 为 `knowledge-context-retired`、`input=context`，还记录原 seq/ID。原事件及正文不变，替换只影响模型 surface。

官方 surface 用一个新节点替换范围，不能直接删节点。空 user 节点可合法存在于 pre-step 和 idle，冷恢复无需自定义事件解释器；内核的官方 `llm/stream` hook 只省略同时符合退役 source、context 标记与空 content 的节点，并沿用 `carryUsageTag`。普通空消息、非空内容、人工输入、工具配对、Bot 委派及 checkpoint 都保留。启发式 Session 计量仍可能包含这些空节点每条 4 token 的 framing 开销；实际 provider 请求不含它们，不能把该估算称作实际计费用量。

`parts` 的最前置 pre-step 在压力判断前退旧帧；memory 的合法 claimed-source 准备后再幂等退旧，并追加当前唯一一帧。显式 checkpoint、原生范围 compaction、idle context check、handoff 和 overflow 恢复入口在维护前至多保留最新一帧。范围端点若恰好引用被退役的节点，会沿用同位置的新 seq。原生 Session 不因 snapshot 轮换而重建；显式“新 part”继续走原有的归档与恢复路径。

## 本轮证据

- `node scripts/check.mjs`：语法、两套 TypeScript 检查与 673 项模块检查通过。
- `npm run test:kernel-host`：20 项官方 SDK、原生内核、记忆 schema、claimed-source 与实际 ACP 子进程检查通过。覆盖 53 帧退役、原始事件不变、重复调用幂等、工具/Bot/人工节点保留、原生冷恢复、已压缩范围、CLI 同路由增量及新 CLI 回放。
- `npm run runtime:memory-snapshot-check`：真实 DSH 进程与隔离私有依赖，13 次 localhost 脚本 provider 调用通过，0 次远端模型。见[结构化证据](snapshot-surface-host.json)。

实际进程覆盖同一 Bot/Session 连续两个作者与房间、Bot relay、真实 `read` 工具两步、四次启动与有序停止；每次普通 provider 请求只有当前一帧，首请求的 author/room 与该次 claimed 输入一致。保留 raw snapshots 的 hash，通过 `ctx.sessionController.events()` 在重启前后重新读取核对。

模拟旧 home 额外写入 53 个 9000 字符快照后，不先发新聊天便显式 checkpoint，摘要输入最多一帧；随后继续同一 Session。独立加入非 memory 的背景大文本触发真正的 native steward 与自动 checkpoint，后续 Bob/南群输入仍复用同一 Session、只有当前一帧。启发式上下文估算在两次压缩前后分别记录；这些不是 provider 计费用量。

另在现有 part 登记 Matrix 原文后，通过原生 `newPart` 切到新 Session，再消费包装消息，首帧仍显示同一个 Bob/南群及精确原始正文；再次重启一致。该步骤是显式 part 功能验证，不算 snapshot 自行换 Session。

## 失败及边界

本轮先复现首 human 请求 0 snapshot 的 claimed-source 时序问题；已由 `afb0429` 修补。初版空 developer 替换在内存 Session 测试通过，却被实际 JSONL 格式检查拒绝：缺 turn/step，补齐后冷恢复仍拒绝 pre-step/idle 不在 open step 内的 developer 事件。该候选已移除；最终采用合法的空 user 替换。另一次 prune 试接线把仅 surface 事件可用的 `sourceEventSeqs` 放到 log-only prune，被 SDK 拒绝；最终引用只放在随后 user 替换事件。失败与最后通过分别记载，不把内存检查当作持久宿主恢复证明。

CLI 检查证明新的 adapter 请求和新 CLI 回放不再携带旧 snapshot；持续运行的外部 CLI 可能保留之前已提交内容，其私有历史由 CLI 自身管理。本次不宣称擦除外部进程历史。原始 Session 事件继续增长以保留审计，活动模型请求不会重复携带旧 snapshot；这也不证明长程远端模型的语义质量已通过。

原生模型切换所用的范围 compaction 入口已核对接线与 surface 端点更新；本轮实际 provider 场景使用同一模型，未把模型切换记为实测通过。

## 官方 CLI 的 SDK 测试前置修补

首轮 SDK 检查使用包含开发 testkit 的 harness；发行线随后发现干净的官方 CLI 不安装该包，三个测试文件因此无法加载。测试现改用 `tests/fixtures/sdk-session-context.mjs` 直接加载官方 `SessionStore` 与 `SessionProjectionRegistry`，无需 testkit、额外开发依赖或运行 manifest 变化。全新隔离前缀只安装 `@deepseek-ai/dsh@0.2.2-rc.1`，确认 testkit 解析为 `MODULE_NOT_FOUND` 后，20 项 SDK/CLI 检查通过；原来的实际宿主证据独立保留。详见[前置修补证据](sdk-session-fixture.json)。
