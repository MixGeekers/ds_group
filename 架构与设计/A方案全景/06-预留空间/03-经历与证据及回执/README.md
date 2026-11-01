# 经历、证据与回执 · 可追溯且可删除

[所属区域](<../README.md>) · [完整目录](<../../目录.md>) · [验证与验收](<../../验证与验收.md>)

更新：2026-11-01。模块 ID：`evidence`。**建议验证基线，未实施、未实测。** 本页定义方案，不创建运行数据库或数据根。

## 主方案

**复用更新：**输入与投递身份复用 Superagent trigger / disposition / outbox receipt；已经交给 Ombre 的原文证据直接用它的 `SourceStore.put/read` 与 source_links，不再由识雨平行保存第二份原文层。`SourceStore` 是内容寻址、限大小、写临时文件 fsync 后独占发布并读回验 hash；控制账本只保存 opaque sourceId 到组件引用的映射。源 hash 是内部实现，不作为对模型暴露的永久身份。未交给记忆组件的通用输入仍使用本页原对象协议。

上游 SourceStore 单文件发布不等于与控制账本共同事务，也未提供完整识雨删除 / TTL / 授权规则；首次纳入记忆的复制有 durable operation，失败留下待清 orphan 或 unknown，不能虚报完成。Ombre bucket、source、引用、媒体、索引的级联清理须逐项验证。复用文件与许可见[核查证据](<../../../../research/2026-11-01-复用核查/数据空间.md>)；下列 schema 是所需目录字段，可映射上游已有表和 KV，不重复造通用事件库。

事件与证据用 SQLite 元数据 + ObjectStore 正文引用；保存“发生了什么”与“被内层接受为什么”两种记录。复用 DSH 原始输入与输出接口，但不默认复制全部 Session 日志、遥测或模型上下文。每类来源明确采集许可、隐私类别、保留期限与跨设备传输范围。

## 输入输出与最小 schema

| 表 | 关键字段 / 约束 |
|---|---|
| inbox_events | eventId、schemaVersion、type、source、actorRef、occurredAt、receivedAt、correlationId、causationId、conversationId/goalId/taskId、payloadRef、sourceMessageId、privacyClass、expiresAt；unique(source,sourceMessageId) |
| evidence_records | evidenceId、sourceEventId、producerRef、objectRef、observedAt、validity、retentionClass、expiresAt、deletedAt；sourceEventId与expiresAt索引 |
| source_links | sourceId、derivedAggregateRef、derivedKind、revision；sourceId反向索引 |
| deletion_jobs | deletionId、scopeRefs、requestedAt、authorizedByRef、watermark、phase、pendingStores、lastErrorCode；请求身份唯一 |
| deletion_tombstones | scopeRef / sourceId、watermark、reasonCode、effectiveAt；不保存被删正文、摘要或内容 hash |

事件载荷不是授权，occurredAt 来自外部时与 receivedAt 分开。输出 SourceRef 附可用性（available / expired / deleted / unavailable）及可复核范围；原文已过期时不可声称仍能核对全文。

## 处理与删除协议

输入适配器先验证大小、身份和内容类型，发布不可变正文对象，再经 UnitOfWork 原子记 inbox 与处理 outbox；已接收 durable 回执只在事务成功后发出。重试以来源稳定 ID 去重；没有来源 ID 的消息须使用适配器生成并持久绑定的接收身份，不能单靠相似文本去重。

用户删除经过明确作用域解析和权限校验后，第一事务递增 tombstoneWatermark、设置权威拒读屏障、撤销受影响 ReadView / 待派发 payload，并产生清理 outbox。然后依赖关系逐项清理全文 / 向量派生、正文对象、Session 关联材料与备份清理任务。已发送到外部服务的副本只能报告其实际删除接口与回执状态，不能承诺本地删除等于外部消失。

对外删除状态统一为 accepted → blocked_from_reads → live_copies_purged → backup_pending → completed / failed；索引、对象与会话清理分别记内部进度。任何存储无确认就不报告 completed。备份恢复前取得最新已知删除账本并重放到必要水位，否则处于恢复锁且不能开放 ReadView。为了执行删除而保留的最小随机身份与操作代码单独限权，不携带可重新识别正文的摘要。

## 生命周期与恢复

默认原始事件正文 30 天、诊断日志 7 天；有任务或合法正式记忆依赖时，保留范围必须由政策显式决定，不靠引用偷偷延长原文无限期保存。原文到期可保留最小来源类别 / 时间 / 随机 ID 和 evidence_unavailable；候选提案须降级证据强度。主动删除优先阻断全部相关派生读取，随后按内层规则重算或撤回结论。

失败清理按 deletionId 幂等重试；删除屏障先于异步清理，因此索引落后不会泄漏旧内容。磁盘满时不在日志反复复制原文；数据库不可写时不声称删除已持久完成。

## 验收与替代条件

[V16](<../../验证与验收.md#v16>) 用含唯一标记的合成事件产生记忆、别名、摘要、索引、任务与备份；逻辑删除提交后下一次读取与模型上下文均不得出现标记。断网 / 重启 / 索引落后 / 旧备份恢复都维持屏障；物理清理未完成准确显示 pending。[V12](<../../验证与验收.md#v12>) 验证输入正文对象发布与 inbox 持久回执断点。

先使用本地关系索引追踪来源；只有已测来源图查询成本明显超出 SQLite 能力才评估图数据库。审计采用可删载荷与最小元数据，不另引入永久保存全部正文的事件溯源平台。

## 证据与适用限制

一手资料、静态核查范围与具体链接见[数据空间证据](<../../../../research/2026-11-01-完整架构/数据空间.md>)。以上业务字段、默认参数与通过标准是识雨的设计建议，不是上游软件自动提供的能力。

