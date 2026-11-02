# MemoryOperation 控制账本

实现依据是[跨模块契约 §5](../../../../../架构与设计/A方案全景/跨模块契约.md)、[记忆模块方案](../../../../../架构与设计/A方案全景/03-DSH宿主进程/01-识雨插件/02-内层-六部分状态/01-记忆/README.md)和[复用核查](../../../../../research/2026-11-01-复用核查/记忆关系认知.md)。本模块没有复制 Ombre 源码、安装服务、调用模型或写真实记忆；后端能力依据既有静态证据，不是本轮后端验收。

`MemoryOperationLedger(db, transactions, options)` 使用现有 DB Worker 的同一连接和 `SqliteTransactions`。它直接复用 `EffectLedger` 的持久尝试、租约、fencing、资源互斥、未知结果和回执核验；不建第二套派发器。操作批准和关联 Effect 在同一事务内写入，回执与本地登记也在同一事务内提交。记忆正文、原生整理状态和检索仍归所选后端；这里只保存命令引用、摘要、来源/依赖、授权、版本观察及回执。

## 调用接口

| 接口 | 语义 |
| --- | --- |
| `approve(actor, input, authorize)` | 规范化整个意图；同 operationId 同内容返回现有记录，异内容拒绝；登记 `approved` 和 pending Effect |
| `claim(actor, request, authorize)` | CAS、当前来源/依赖/授权及删除屏障检查后，复用 Effect 原子 claim；提交后才返回执行资格 |
| `assertDispatch(actor, operationId, claim, authorize)` | 在真实调用前重新检查租约、世代、fence、当前授权和依赖；不能缓存准入结果 |
| `complete` / `reconcile` | 外部查询在事务外完成，再由同步可信 verifier 核验结果；late/unknown 只能凭独立核对证据 reconcile |
| `markUnknown` / `recover` | 保留不确定性；recover 只处理当前 actor 范围内的记忆操作，不改变其他领域 |
| `reject` | 只允许尚未派发的 pending 意图被本地拒绝；在途结果需要后端证明 |
| `tombstone` | 同事务提高本地删除水位、阻断来源与传递派生引用、取消 pending 并将 in-flight 标 unknown；不声称已物理清除 |
| `get` / `receipts` / `watermark` | 内部控制事实只读查询，不是给 replyer 的记忆查询或 ReadView |

Actor 必须由宿主认证入口构造。配置中的 principal 角色和后端部署身份会固定到控制库，变化要求显式迁移；模型不能选择 actor、policy callback 或 verifier。scope 按完整 opaque 身份精确匹配，不继承、不匹配前缀。`backendId` 必须标识固定部署/存储空间，不能只表示“所有 Ombre 服务”。`memoryResource(scope, backendId, targetRef)` 可用于可信 Mandate 资源目录；接线时 policy 仍须调用 `assertPermit` 等现有准入并保证 reservation 与单次操作绑定，本模块不凭字段存在授予 Mandate 权限。

`proposalId` 是审计关联，幂等权威是 `operationId`。后者包含整个规范化命令身份、来源修订、依赖、授权、scope 和期限；这只是本地去重。每个 Effect 固定 `reconcilable`、`maxAttempts=1`；本模块没有 retry API，不会盲重发 unknown。多后端工作必须拆成独立 operationId。

## 版本、依赖与发布

操作 `version` 是本地 revision 与关联 Effect revision 的单调和，可能一次增加两步；它只用于控制账本 CAS，不是后端记忆版本。原始来源修订和 `expectedComponentVersion` 分开。无条件 `append` 可表达一次获准写入；`update` 必须给 expectedComponentVersion。凡携带该版本，批准和派发政策必须证明真实后端原子比较更新能力及当前观察版本，applied 回执还必须证明实际 CAS 的输入/输出版本。内容 hash、先读后写、MCP 返回成功均不能替代该证明。

来源、target 与 dependency 引用均属于精确 scope；本切片不支持跨 scope 派生。跨域复制须以后通过明确授权、目标域新引用及来源策略单独接线。`sourcesVerified` 核对来源范围、修订、当前保存同意；`dependenciesVerified` 核对每个依赖的范围和可用性，包括账本外引用。账本还会确定性检查自身已登记 target 的 source/dependency 入边：存在 approved、dispatching 或 unknown 时阻断派发；没有可用 applied 引用也阻断。更新在执行入口和结果发布时再次检查，不能依赖某个尚未核实的效果继续工作。未知外部引用不因“字符串存在”而获准。

后端回执 verifier 必须证明是**本次整个操作**的结果、固定后端/外部操作身份、命令摘要、原始来源修订及 nativeId；重放核对需 `reconciled === true`。一次网络请求失败、匹配正文的搜索命中、普通 MCP 文本或 isError=false 都不足以证明整个操作。`publicationAllowed` 另外核对**当前** authEpoch、scope、来源修订和 consent；核实旧回执不能自动得到发布权。同步钩子不允许 Promise/thenable，也不执行模型、网络或文件 I/O。

后端事实与可见性分开：有 verified backend applied 但来源已删除、依赖未定或当前发布权不足时，Effect 保留 succeeded 和真实回执，MemoryOperation 保持 unknown，并给出阻断原因；不重新发布 nativeId，也不再尝试写入。这里 unknown 也包含“后台已确认，但本地发布/清除流程未能完成”，须结合 backendOutcome 与 reasonCode 阅读。

## 删除屏障

墓碑以 scope+opaque 引用登记，水位只增不减。已知派生图按 source/dependency → target 做闭包，立即在同事务内阻断所有可追踪派生。新的提案必须观察当前水位；已删除 ID 不能靠换 proposalId、operationId 或晚到结果复活。新且独立的证据需要新的身份和新提案，不能清除旧墓碑。

`applied` 是历史事实，删除一条已应用记忆不会伪造“从未发生”：其状态可仍为 applied，但 `blocked=true` 且不再返回 nativeId。`MemoryReceiptRecord.published` 同样只说明登记当时是否发布，不能用作当前读取授权。未来 ViewService 必须复查当前 ACL、删除水位、来源状态及后端事实；此控制查询不能直接供外层检索。实际正文、索引、缓存、备份清除与恢复水位证明尚待独立集成，本地 tombstone 不表示后端物理清除完成。

## 本轮验证

`node --import tsx --test tests/memory-operations.test.ts`：21 项临时文件 SQLite 测试通过，包括 4 个独立 Worker 争抢唯一派发、跨连接 CAS、重启 unknown、原始 claim 核对、幂等、缺少后端 CAS 证明、授权/来源/依赖、删除闭包、撤权后结果不发布，以及真实 SQLite 触发器故障下的跨账本事务回滚。整包 `npm run typecheck` 通过。

测试后端与可信 verifier 为合成 fixture，只证明控制协议。没有运行 Ombre、真实 DSH 宿主或模型；现有 Ombre 接口未证明通用 CAS/operationId/结果归属能力，默认不能由该账本自动开启写入。
