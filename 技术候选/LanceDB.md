# LanceDB

[候选目录](<目录.md>) · [记忆方案](<../架构与设计/A方案全景/03-DSH宿主进程/01-识雨插件/02-内层-六部分状态/01-记忆/README.md>)

- 日期：2026-11-01；状态：**已初评，条件增强候选**；未采用为起步依赖、未安装或运行。
- 类型：嵌入式派生全文 / 向量检索引擎，TypeScript可用；不是识雨权威记忆库。
- 核查版本：[v0.41.0](<https://github.com/lancedb/lancedb/releases/tag/v0.41.0>)；[Node包](<https://github.com/lancedb/lancedb/blob/v0.41.0/nodejs/package.json>)与[Apache-2.0许可](<https://github.com/lancedb/lancedb/blob/v0.41.0/LICENSE>)已静态核查。0.x原生依赖的目标平台兼容仍待测。

2026-11-01 复用核查后，优先验证 Ombre 作为完整记忆后端并使用其原生检索；**LanceDB 不作为 Ombre 旁挂默认依赖**。SQLite FTS5 是独立本地对照 / 回退。仅该本地路线在冻结检索集显示语义召回不足时，比较 LanceDB 的[混合检索与RRF](<https://docs.lancedb.com/search/hybrid-search>)，避免自写向量库。只保存权威记录的派生索引；切换停止旧全文引擎常规写入，不默认维护两套索引引擎。[复用核查](<../research/2026-11-01-复用核查/数据空间.md>)。

启用门槛为 V25 召回提升至少10个百分点且达到质量目标、精确查询不退化、延迟预算满足，以及 V16 删除与恢复零泄漏。delete 与旧版本文件清理分开，不能从索引查询不可见推导介质已清除；见[官方优化接口](<https://lancedb.github.io/lancedb/js/classes/Table/#optimize>)。

迁移通过一致快照、outbox追增量、索引水位与权威回查完成，失败回退FTS5；不允许迁移改写权威事实。详见[本轮证据与比较](<../research/2026-11-01-完整架构/记忆关系认知.md>)。所有收益阈值是规划验收目标，无本轮基准成绩。
