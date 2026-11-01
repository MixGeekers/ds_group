# 内部权威状态 · 控制账本与组件权威

[所属区域](<../README.md>) · [完整目录](<../../目录.md>) · [验证与验收](<../../验证与验收.md>)

更新：2026-11-01。模块 ID：`state`。**建议验证基线，未实施、未实测。** 本页定义方案，不创建运行数据库或数据根。

## 主方案

复用 Superagent Store 的事务 / KV / 聚合持久化片段保存控制账本；优先验证 Ombre 作为唯一记忆正文后端。控制库保存授权、来源到 backendId / bucketId 的目录、操作状态、独立 Entity / Claim 等识雨特有结构，不双写 Ombre 记忆正文。领域实体由各模块定义，不把 Session 日志或向量索引作为事实源。

**替换旧计划：**不再自写通用 Repository / savepoint 执行器，也不要求六域全部迁移到同一 SQLite。复用 Superagent `src/app/store.ts` 的 atomic / afterCommit、typed KV 与聚合读写；依赖闭包、MIT 声明、SAVEPOINT 失败恢复补丁见[本轮核查](<../../../../research/2026-11-01-复用核查/数据空间.md>)。下列表是逻辑目录与校验字段，不是每项必须新增一张物理表；可按上游 KV family 与聚合 JSON 映射。旧六域同库为隔离的本地 FTS 对照 / 回退。

## 最小逻辑 schema

| 表 | 最小字段 / 索引 | 写入规则 |
|---|---|---|
| system_meta | schemaVersion、commitSeq、stateVersion、authEpoch、tombstoneWatermark、instanceId | UnitOfWork 更新；恢复不能从旧备份直接复活当前授权 |
| state_entities | aggregateType、aggregateId（联合主键）、revision、payloadSchemaVersion、payloadJson 或 payloadRef、privacyClass、retentionClass、deletedAt | 唯一受控提交；领域字段必须经版本化 schema 校验 |
| state_sources | aggregateType、aggregateId、sourceId、sourceRevision、relationType；sourceId 反向索引 | 与实体同事务维护，支持删除与来源撤回传播 |
| domain_projections | 按域的实体 / 别名 / 关系 / claim 等 typed 投影及 revision | 有唯一约束的权威查询投影须同事务维护；全文与向量索引不在此范围 |
| domain_events / audit_records | eventId、commitSeq、actorRef、policyVersion、entityRefs、operationCode、payloadRef、occurredAt | 记录提交因果；敏感正文外置并可删除，审计不重复保存正文 |
| commit_receipts | proposalId、requestScope、idempotencyKey、payloadHash、outcome、commitSeq、stateVersion、changedRefs | 作用域内 idempotencyKey 唯一，同键不同载荷拒绝；同一 Proposal 重交返回原结果 |
| component_catalog | backendId、aggregateId、backendRecordId、componentRevision、verifiedSourceHash、observedAt、sourceRefs、deletionState | 只保存目录与核对元信息，不复制记忆正文；hash 不对模型暴露，用户删除时一并清除 |
| component_operations | operationId、proposalId、backendId、commandType、expectedComponentRevision、payloadRef、status、attempt、resultRef、lastObservedAt | 与控制决策 / outbox 原子保存；status 为 approved / dispatching / applied / unknown / rejected，不能把 approved 回执称为组件已提交 |

记忆领域对应的逻辑类型为公共契约 `MemoryOperation`；`stateVersion` 是已发布组合投影版本。`verifiedSourceHash` 仅作读取核对，不能冒充后端 CAS 条件。组件新鲜度字段使用 `freshness`；未提供 revision 或 indexVersion 时留空并说明限制。

SQLite 序号为 64 位整数；跨 JSON 边界的长序号用十进制字符串，避免 JavaScript Number 精度丢失。实体 ID 使用共享契约的不透明身份；业务排序依赖 commitSeq 而非随机 ID。MemoryRecord、Entity / IdentityBinding、RelationshipAssertion、Claim、emotion_state、personality_profile、capability_definition 的领域内容见对应内层方案，不由本页另造第二套语义。

## 输入、输出与事务

输入 Proposal 带 proposalId、schemaVersion、actor / role、sourceRefs、baseStateVersion、readSet[{aggregateType,aggregateId,expectedVersion}]、policyVersion、commands、idempotencyKey、expiresAt。CoreCommitService 验证每项命令及当前授权；全局 baseStateVersion 只说明视图起点，不以无关实体变化制造冲突。

控制库内短事务逐聚合 CAS，必要时验证 collectionVersion / 唯一约束；写本库领域变化、来源目录、审计、操作 outbox 和本地回执。Ombre 写入在事务外，组件确认与版本核对后再记录应用结果。`committed` 不能跨来源冒充全局原子完成；Proposal 的本地受理、组件 applied、worker 成功分开表达。Ombre them 局部 expected_revision 不等于 hold / grow / trace 公共接口已有幂等与 CAS：接口须逐条验证，缺失则补真实服务端约束并先测失败窗口。模型重新推理在事务外。

ReadView 的控制部分来自短读事务，组件部分带 backendId、实际 revision 或已核 source hash、capturedAt、indexVersion。只对控制部分宣称本库快照一致；读取后再次复核 authEpoch / tombstoneWatermark，存在相关 unknown、版本不符或过时组件结果时标 pending / stale。replyer 只拿裁剪视图，不拿 SQLite 文件、源 hash 索引或通用写工具。

## 恢复与生命周期

重复提交从回执恢复；冲突重新读取相关聚合再提案，不盲目覆盖。删除先打 tombstone 并阻止检索，再清理正文、投影与引用；审计保留最小操作身份和结果，不能以“不可变审计”为由永久保存已删内容。数据库损坏进入隔离恢复，禁止让模型补写缺失事实。用户删除涉及的 payloadHash / source 内容摘要也须清除；必要幂等身份改为不含正文摘要的拒绝重放墓碑，不能以去重为由保留可重识别内容。

## 验收与替代条件

[V06](<../../验证与验收.md#v06>)：控制库同 revision 冲突与独立实体并发均正确，控制实体 / event / outbox / receipt 原子可见；后端缺版本保障时不能虚报 CAS。[V12](<../../验证与验收.md#v12>) 在 Ombre 已应用但本地未记回执处中断，必须 unknown 核对，不重复记忆。[V16](<../../验证与验收.md#v16>) 落后组件也不得越过删除屏障。10,000 个合成控制聚合 / 100,000 事件下短提交 p95≤100 ms 是目标，未测。

只有单 writer 成为已测瓶颈、跨主机并发写成为真实要求时，才评估 PostgreSQL；迁移保留同一 Proposal / Receipt 契约，不先引入分布式数据库。单次慢查询优先通过索引和事务缩短修复。

## 证据与适用限制

一手资料、静态核查范围与具体链接见[数据空间证据](<../../../../research/2026-11-01-完整架构/数据空间.md>)。以上业务字段、默认参数与通过标准是识雨的设计建议，不是上游软件自动提供的能力。

