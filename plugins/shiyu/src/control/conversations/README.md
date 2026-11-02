# Conversation 业务绑定与背景版本

2026-11-02：阶段 3，业务模块及本地 Task 背景投影已接入同一 DB Worker；Runtime 通过受控本地入口和有界扫描驱动。尚未接真实渠道、原生 Session 上下文注入或完整 ReadView 权威，不请求模型。依据已确认的 [多频道话题与后台协作](../../../../../架构与设计/A方案全景/多频道话题与后台协作.md)、[统一事件接口与发布订阅](../../../../../架构与设计/A方案全景/统一事件接口与发布订阅.md) 和 [跨模块契约](../../../../../架构与设计/A方案全景/跨模块契约.md)。

## 创建与可信边界

```ts
const conversations = new ConversationStore(db, transactions, {
  ownerIds: [configuredOwnerId],
  componentPermissions: {
    conversationRouter: ["read", "manage", "reply"],
    backgroundProjection: ["read", "background"],
    replyCoordinator: ["read", "reply"],
  },
  authorizeReference: ({ actor, scope, reference, access }) =>
    businessAuthority.canUseReference(actor, scope, reference, access),
});
```

必须使用与事件、任务、Effect 等领域相同 SQLite 连接的 `SqliteTransactions`。所有方法同步执行；事务内不请求模型、宿主 Session、网络或其他异步服务。`authorizeReference` 必须是同步的可信领域查询，Promise 会被拒绝。

每个方法的第一个参数是适配层根据真实调用者构造的 `ConversationActor`。它不来自模型参数、渠道载荷或事件正文。配置的 owner/component 身份、组件 capability 和 actor 的精确 scope 必须同时匹配；模型 Agent 身份不直接具有写权限。公共模型工具只能接收业务命令参数，由可信适配层另行注入 actor。TypeScript 类型本身不认证身份。

`scope` 是不可变的受众边界，不是临时连接 ID、话题名或权限提示。不同 scope 的 Conversation、Topic、来源版本和原生 Session 绑定不会合并。当前实现保守地拒绝所有跨 scope 话题合并；需要跨频道协作时，在各自 scope 中显式关联经过来源授权的业务引用。

## 对外接口

| 接口 | 作用 |
| --- | --- |
| `ensureConversation` / `getConversation` / `listConversations` | 以稳定 connection、平台 conversation/thread、kind、scope 复用 Conversation |
| `createTopic` / `linkTopic` / `detachTopic` / `linkReference` | 管理话题和获准的 Task/Goal/source 引用；变更使用 revision 检查 |
| `branchTopic` / `mergeTopics` / `separateTopic` / `relations` | 保存带证据的业务关系和显式撤销；不复制 Task、引用、订阅或原生 Session 日志 |
| `ensureReplyBinding` / `bindSession` / `getReplyBinding` | 一个 Conversation 与可选 Topic 对应稳定的业务绑定和原生 Session 引用 |
| `version` | 读取 `bindingId/conversationId/scope/audienceVersion/conversationGeneration/routingRevision/sessionEpoch/contextVersion` |
| `recordBackgroundUpdate` | 按 scope + 来源保存单调版本、事件去重回执和每绑定每来源的最新待同步标记 |
| `contextSnapshot` / `ackContext` | 按当前来源权限读取版本，再确认实际加载的来源版本 |
| `advanceGeneration` / `invalidateAudience` / `setArchived` | 用户新输入、中断、取消、受众变化和归档使旧回复资格失效 |
| `beginReply` / `completeReply` / `assertDraftCurrent` / `abandonReply` | 保存草稿引用及依赖版本，在完成和发送前验证有效性 |

业务 `businessId` 可传给现有 DSH Session 适配器，与 `scope` 一起生成 `sessionBindingKey("replyer", businessId, scope)`。它区分默认绑定、名为 `default` 的真实 Topic、不同 Conversation 和不同 sessionEpoch。`bindSession` 只登记实际 Session ID，不创建或恢复 Session；同一个 Session ID 不允许跨绑定或在退休后重新使用。

## 背景同步与回复失效

背景完成只增加相关绑定的 `contextVersion`，默认不增加 `conversationGeneration`、不请求模型、也不产生发送行为。待同步内容仅含来源引用、版本和证据引用，按来源合并为最新标记；它不是第二个 inbox 或消息历史。

`contextSnapshot` 只返回当时获准的来源。调用者在事务外读取来源的获准当前快照，并在确实向对应原生 Session 提供该上下文后，用捕获的 token 和实际读取版本调用 `ackContext`。每个绑定独立持久化来源确认游标，因此只确认 X 不会把已有但未读的 Y 标成已同步。旧 token 不能清掉读取期间到达的新 pending，也不能跨受众、路由、generation 或 sessionEpoch 确认。

发现版本跳跃时，pending 的 `gap` 持续保留到消费者确认已重读该来源当前快照。后续连续事件不会覆盖尚未处理的缺口。重新读取只恢复当前状态；调用者仍应说明存在历史缺口，不能生成缺失过程。各来源版本互相独立，本模块不声称跨服务读取具有全局原子性。

草稿记录精确的来源依赖。依赖 X 的草稿不会仅因无关 Y 的背景更新失效；X 的版本变化、用户新输入/取消、路由或受众变化会使它失效。受众变化、分离误合并话题和解绑会轮换 Session epoch；旧 Session 引用保留在防复用登记中，不能被当作已清除敏感历史继续恢复。本模块不删除原生日志，也不宣称轮换能够撤回已经发送的内容。

同一 Conversation 同时只接受一个仍有效的 `generating` 草稿。`ready` 仅表示草稿引用已形成，不代表已发送；排队发送、同一对话的最终发送顺序、Effect 幂等、回执和 unknown 均由现有调度与 Effect 领域承担。

## 接线时必须保持的事务边界

1. 事件消费者使用相同 `transactions.atomic` 同时调用 `recordBackgroundUpdate` 并提交原 Event 服务的消费回执。此处保存的事件去重记录不替代 Event 服务的 inbox、投递或恢复职责。
2. 回复完成后，调用者在创建发送 Effect intent 的同一事务中执行 `assertDraftCurrent`。Effect 真正 dispatch 前还要再次验证；不能把早先通过的检查当成永久发送许可。
3. ReadView 可以通过只读适配层取得 `version()`。策略版本、auth epoch 和删除水位仍由其所属服务提供；背景 `contextVersion` 不应默认作为所有视图/草稿的强失效条件。
4. 原生 Session 创建/恢复、异步上下文注入及渠道发送均在 DB 同步事务外完成。发生部分完成或回执不明时，沿用宿主与 Effect 的恢复机制，本模块不自行重放模型请求。

## 当前本地接线

`adapters/control-store/conversation-domain.ts` 使用固定 `local-owner` 受众和可信组件 `shiyu-conversation-background`，注册 handler 为 `conversation.background`。模型与公共参数不能指定 actor、scope、事件正文或来源版本。Worker 提供：

| 命令 | 行为 |
| --- | --- |
| `conversation.ensureLocalTask({taskId, localConversationKey?})` | 只关联已有本地 Task；key 默认为 Task ID，允许 1–100 个字母、数字、下划线或连字符，最多 64 个本地对话。相同 key 复用 Conversation/Topic/binding，同 Task 可关联不同 key。 |
| `conversation.consumeBackground({limit?})` | 每批 1–20 条，仅消费现有 Event 队列里的可信 `task.succeeded`。 |
| `conversation.snapshotLocal({conversationId?})` | 返回业务引用、Task 状态、背景版本、待同步标记和订阅回放缺口；只读，不领取投递或确认上下文。它是控制状态投影，不声称是完整 ReadView。 |

Task 仍由原 `task.verify` 在同一事务中提交独立核验成功状态和 `task.succeeded` 事件。每个 Task 只建立一个固定组件订阅，按 taskId 过滤并有界回放；`replayTruncated` 保留在返回状态中，不能用“订阅建立成功”代替历史完整性。

消费者先领取投递、持久化 attempts，再逐条在共享事务中复验 claim、读取存储的 envelope、检查真实 Task 已 succeeded、写入背景标记并 Event ack。背景写入或 ack 失败时二者共同回滚，随后用原 Event `fail` 记录重试；不新建 inbox。`duplicate` 计入 `acknowledged`，正常批次返回满足 `acknowledged + failed === claimed`；failed 是消费失败次数，返回的 delivery status 另行区分 retrying、failed 和 stale。无法证明事务结果时整批命令抛错，保持隔离状态。

当前 v1 事件只有 taskId，因此来源版本 1 明确表示该 Task 的一次性成功事实，不是全局 Event sequence，也不是 Task 聚合 revision。Task 状态的真实 revision 单独返回为 `taskRefs[].version`。将来增加其他状态事件时需要明确来源版本契约，不能悄改已登记的事件 v1。

同 Task 的多个既有绑定会一起增加背景版本。若 A 已消费成功事件后才创建 B，B 可以是 `pending=[]`、`contextVersion=0`，但仍具有 `sources=[Task 成功事实 v1]` 和 `needsSync=true`，表示首次来源加载未完成；不伪造一条新事件补 pending。界面必须依据 `needsSync`，不能仅依据 pending 数量判断是否同步。

Event ack 只表示背景标记已持久化，本切片不调用 `ackContext`。查看 UI、成功消费事件以及模型暂停都不意味着原生上下文已加载。原生 Session、Goal 和模型验证不由这些命令启动。`control.watermark` 只读暴露真实控制写提交水位及其安装基线；它不替代尚未接入的组合投影 stateVersion 或 ReadView 权威。

## 本轮验证

独立业务模块的 `tests/conversations.test.ts` 为既有 17 项基线，覆盖重开恢复、默认绑定身份、私聊隔离、能力授权、部分/旧确认、版本缺口、依赖草稿失效、分支/合并/分离、受众轮换、归档、事件回执原子提交和发送前检查。

新增 `tests/conversation-store-integration.test.ts` 使用临时 SQLite 和真实 Worker IPC 验证上述本地接线；故障案例使用真实 SQLite 加同步合成 EventPort，在 ack 写入后抛错验证共同回滚。测试中的 Task 完成证据为显式合成观察，不访问真实产物、宿主、模型或渠道。完整验收结果由本轮实施记录列明，不将这些合成结果算作真实渠道验收。

本轮命令 `node --import tsx --test tests/conversation-store-integration.test.ts tests/conversations.test.ts`：28/28 通过（新增集成 11 项、原领域 17 项）；全包 `tsc --noEmit --pretty false` 通过。集成测试还核对真实 `commitSeq`：claim 与背景投影加 ack 各计一次写提交，多个绑定和嵌套 savepoint 不多计；重复 ensure、空消费和只读 snapshot 不增加水位。
