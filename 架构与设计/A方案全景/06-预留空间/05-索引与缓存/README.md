# 索引与缓存 · 可重建检索基线

[所属区域](<../README.md>) · [完整目录](<../../目录.md>) · [验证与验收](<../../验证与验收.md>)

更新：2026-11-01。模块 ID：`cache`。**建议验证基线，未实施、未实测。** 本页定义方案，不创建运行数据库或数据根。

## 优先路线与本地对照

**2026-11-01 复用更新：优先验证 Ombre 自有 BM25 / embedding / recall 检索，控制库仅保留授权、删除与来源目录查询。** 不为维持此前单库设想平行重建第二份记忆全文 / 向量索引。Ombre 查询返回的候选必须经控制侧 sourceRefs、authEpoch、tombstoneWatermark 回查，组件缓存 / recall 的写副作用由记忆模块限制。具体固定源码和适配范围见[数据复用核查](<../../../../research/2026-11-01-复用核查/数据空间.md>)与[记忆方案](<../../03-DSH宿主进程/01-识雨插件/02-内层-六部分状态/01-记忆/README.md>)。

**以下 FTS5 schema 与同事务承诺只属于待验证的本地对照 / 回退方案。** 组件模式以其真实 indexVersion / capturedAt / 已应用操作清单表达新鲜度，不能把 control.commitSeq 直接充当 Ombre indexWatermark。切换后端须单一权威迁移并停掉旧引擎写入；LanceDB 为本地路线收益门槛后的增强，不是 Ombre 旁挂默认依赖。

验证起点采用 SQLite FTS5 + BM25，配普通实体 / 时间 / 别名索引。中文正文与查询使用现成 Intl.Segmenter(zh, word) 一致预分词，Node / ICU 与分词配置计入 tokenizerVersion；不自写中文分词器。短名字、账号和设备 ID 走结构化精确查询，不假设全文引擎能解决所有短词。

FTS5 仅为派生状态，不能与内层权威数据互换。基线固定使用同库 search_docs 与 FTS5 表，正式聚合、search_docs、全文更新在同一 UnitOfWork 事务中完成；业务上仍可清空重建。分词准备和正文读取在事务外完成，提交时验证相关来源 revision / hash，不能把耗时分词或 embedding 放在权威写事务内。

## 最小 schema 与更新契约

- index_registry：indexId、indexEpoch、kind、tokenizerVersion、embeddingVersion（基础方案为空）、schemaVersion、status、indexWatermark、sourceSnapshotVersion。
- indexed_documents：sourceId、sourceRevision、objectRef、documentKind、privacyClass、indexEpoch；sourceId + sourceRevision + indexEpoch 唯一。
- FTS5 虚表：docId、预分词文本、必要搜索字段；不向外层暴露原始全文表。派生缓存键必须包含实体 revision、authEpoch、tombstoneWatermark、模型 / 分词版本。
- FTS5 主方案与权威记录同事务更新并推进对应 indexWatermark；失败整体回滚。不相关业务提交可推进无操作水位，但不能跳过待索引的相关提交。新 epoch 重建或条件启用 LanceDB 时，Indexer 才从持久 domain outbox 消费并追平；不能在处理一半时推进到更高 commitSeq。

检索先做请求权限过滤，再取候选；返回前重新查权威实体是否存在、revision 是否匹配、来源是否有效、ACL / tombstone 是否已改变。readview标记 indexWatermark 和引用版本。索引未追平时，对最新变化使用结构化查询 / 等待，不把“未检索到”当作“不存在”。

## 重建与删除

重建创建新 indexEpoch，读取一致权威快照，构建后追平其后 outbox；验证已删对象为零、来源版本正确，才原子切换活动索引指针。旧 epoch 保持短期回退但在查询入口受同一删除屏障约束。崩溃时只有完整 ready epoch 可接流量。

用户删除由权威 tombstone 即时阻断，基线 FTS5 行删除与权威变更同事务；外部派生索引、独立缓存和历史 epoch 的清理异步确认。物理删除还需检查 SQLite 空闲页、WAL 和独立备份；不能将 FTS DELETE 当作所有介质已抹除。embedding 缓存即使只有向量也受相同隐私与保留政策。

## 收益门槛与替代方案

若合成中文同义改写集 recall@10 未达 0.85，可评估现成 LanceDB 混合检索，详见[记忆方案](<../../03-DSH宿主进程/01-识雨插件/02-内层-六部分状态/01-记忆/README.md>)。启用门槛为至少提升 10 个百分点、延迟不超过基线 2 倍、删除 / 权限用例全部通过；切换后只保留一个活跃派生全文体系，避免同时维护两套真相。未过门槛继续 FTS5 + 结构化查询，不自研向量数据库。

## 验收

[V15](<../../验证与验收.md#v15>) 对 10,000 条合成记录清空索引再重建，查询内容 / 版本一致，索引故障不改变权威实体；Tokenizer 变化必须切 epoch。[V16](<../../验证与验收.md#v16>) 验证落后索引也不能返回删除数据。[V23](<../../验证与验收.md#v23>) 验证断电后消费可续跑、不重记忆。检索质量阈值来自设计目标，本轮未测。

## 证据与适用限制

一手资料、静态核查范围与具体链接见[数据空间证据](<../../../../research/2026-11-01-完整架构/数据空间.md>)。以上业务字段、默认参数与通过标准是识雨的设计建议，不是上游软件自动提供的能力。

