# Conversation 业务绑定与背景版本

2026-11-02：阶段 3 独立模块，已完成真实 SQLite 合成测试，尚未接入 runtime、DB Worker、渠道或模型。依据已确认的 [多频道话题与后台协作](../../../../../架构与设计/A方案全景/多频道话题与后台协作.md)、[统一事件接口与发布订阅](../../../../../架构与设计/A方案全景/统一事件接口与发布订阅.md) 和 [跨模块契约](../../../../../架构与设计/A方案全景/跨模块契约.md)。

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

## 本轮验证

`node --import tsx --test tests/conversations.test.ts`：17/17 通过。使用真实临时 SQLite，覆盖重开恢复、默认绑定身份、私聊隔离、能力授权、部分/旧确认、版本缺口、依赖草稿失效、分支/合并/分离、受众轮换、归档、事件回执原子提交和发送前检查。`tsc --noEmit --pretty false` 通过。未调用模型、未创建原生 Session、未发消息；这些结果不代表渠道或运行时集成已验收。
