# 记忆 · 可追溯事实与检索方案

[所属区域](<../README.md>) · [完整目录](<../../../../目录.md>) · [核心](<../00-core-主动判断/README.md>) · [证据](<../../../../../../research/2026-11-01-完整架构/记忆关系认知.md>)

- 更新：2026-11-01（America/Caracas）；模块 ID：`memory`。
- 设计状态：**供下一阶段验证的建议基线**。已有内外只读边界继续有效；本轮无实现、安装或运行实验。
- 职责：保存获准的长期经历与事实，按来源、主体、时间和用途检索；检索结果不能绕过内部受控提交。

## 1. 主方案与复用取舍

**复用核查后的优先验证方案为 Ombre Brain 3.6.14 完整服务，Mem0 为可直接接入的替代后端，SQLite/FTS5 为对照及失败退路。** 不再预设自组管线胜出。识雨只补保存政策、来源关系、版本/操作回执与服务适配，不实现数据库、分词器、向量引擎或另一个自主核心。证据与明确复制计划见[全架构复用核查](<../../../../../../research/2026-11-01-复用核查/记忆关系认知.md>)。下文SQL原子提交、FTS5及LanceDB细节仅适用本地对照；服务模式按第1.1节处理，不能混用两种权威承诺。

| 选择 | 本方案使用范围 | 理由 / 变化条件 |
|---|---|---|
| SQLite + FTS5 | 本地对照后端的受控状态、检索投影与全文索引；驱动和修复版本门槛跟随[数据方案](<../../../../06-预留空间/README.md>) | 成熟、单机可事务化、无需额外服务；不把全文相关度当事实可信度 |
| Intl.Segmenter | 正文与查询先按语言切词，再交 FTS5 unicode61；Node/ICU/locale 纳入 tokenizerVersion | 复用运行时语言能力，不自写中文分词；V01 必须核验目标宿主中文分词支持 |
| DSH 的结构化模型输出 | 从已授权事件提出 Memory/Claim 提案；同一次抽取可复用实体与来源结果 | 不增加第二个推理框架；模型不能直接调用数据库写工具 |
| LanceDB OSS TypeScript 0.41.0，Apache-2.0 | **条件增强**，替换派生检索引擎；不成为权威库 | 现成向量、全文和 RRF 能力；仍为 0.x，原生包兼容与删除必须验证，启用门槛见第 6 节 |
| Mem0 | 固定753496cf…的`Memory.add(infer=False)`直接保存core批准文本；search/get/update/delete复用SDK | 跳过抽取与该分支messages保存，仍写向量/历史；作为替代权威而非并行第二库。delete保留prev_value，需清除适配 |
| Letta | 局部改编reflection-v2.md与核心记忆维护策略；由DSH运行 | 复制范围与Apache-2.0声明见复用核查，不为提示策略部署另一套宿主；当前尚未复制代码 |
| Ombre Brain | **优先组件对照**：复用情绪记忆、混合检索、浮现/衰减与回顾 | 服务本身不等于第二核心；先比较受控接入及清除/追溯/版本适配成本，不能因不符单库假设直接排除。见[同日复评](<../../../../../../research/2026-11-01-完整架构/Ombre内层复评.md>) |

SQLite 官方提供全文查询与 BM25，但其 unicode61 不等于中文语言分词；trigram 的短于三个字符限制也不能忽略。本方案使用现成预分词和结构化短名查询。事实依据见[FTS5](<https://sqlite.org/fts5.html>)、[Intl 标准](<https://tc39.es/ecma402/#segmenter-objects>)和[Node ICU](<https://nodejs.org/api/intl.html>)。其余技术适配判断与版本来源汇总于证据文档。

### 1.1 服务模式的权威与恢复

- Ombre独占记忆正文、情感痕迹与原生整理状态；MemoryRecord作为逻辑DTO/引用目录，不向SQLite双写第二套正文权威。SQLite保留授权、命令回执、sourceRefs/dependencyRefs、backendId/nativeId映射及独立Entity/Claim。原始事件与长期记忆有各自保存政策。
- core独占写工具与dream，replyer仅接收ReadView。初验关闭You/them；它们以后启用时需单独适配：them读取会更新提及与清除待阅通知，不能当作纯读取直接交给外层。
- 先持久批准命令，再调服务、核对nativeId和结果，最后登记已应用回执与本地可见版本。跨服务状态有approved/dispatching/applied/unknown/rejected等明确阶段；服务写后回执丢失先核对，不盲重试。具体枚举跟随公共契约；不宣称跨库SQL原子性。
- 原生idempotency/CAS是否覆盖所选工具必须验证；them内部有局部expected_revision，不代表全部MCP写工具提供同一协议。Dashboard/Obsidian写旁路须禁用或作为外部变化重新核对，不能绕过core控制。
- 共同恢复manifest关联控制库、Ombre原生一致备份、backend版本及删除水位；先隔离核对unknown命令与丢失/未登记桶，再开放只读视图。普通归档不是清除，来源回读用已有授权证据服务补充。
- 服务方案整体按来源、权限、恢复、清除与维护量比较，不套用第6节LanceDB单项召回门槛。完整服务未通过时回退本地对照；不得同时正常维护三份正式记忆库。

## 2. 数据与所有者

以下为跨后端逻辑对象。服务模式将其映射到原生条目与来源目录，不要求服务具有同名表，也不复制第二权威正文。本地对照可存入统一 `state_entities`，由受控事务同步维护类型化投影。

| 对象 / 字段 | 方案 |
|---|---|
| MemoryRecord 身份 | `memoryId, revision, schemaVersion, kind`；kind 为 episode / explicit_fact / preference / procedure_reference。稳定 ID 不随摘要重写改变 |
| 内容 | `bodyRef, subjectIds[], claimIds[]`；长正文引用对象文件，程序按范围解析；不能用裸文件路径当永久标识 |
| 来源 | `sourceRefs[]` 关联事件、来源身份、观察时间及声明时间；`dependencyRefs[]` 记录派生链；不以模型生成文本充当独立来源 |
| 时间 | `recordedAt, observedAt, validFrom?, validTo?, reviewAfter`；记录时间不替代事实生效时间。无法确定时保留未知，不猜日期 |
| 状态 | proposed / active / contested / superseded / archived / tombstoned；正文的物理清除完成由独立 deletion job 表示 |
| 读取与保留 | `privacyClass, scope, retentionPolicyId, consentBasisRef, pinned`；只允许范围内的主体/会话读取 |
| 版本与依据 | `supersedes?, commitId, sourceQuality, modelConfidence?`；模型分数是未校准提示，不能作为真实性或授权证明 |

所有正式变更归core批准。Proposal包含baseStateVersion、readSet、sourceRefs、操作和政策版本。本地对照由CoreCommitService在同库CAS与提交；服务模式先核对引用版本，服务写入确认后再登记本地可见版本，跨服务不冒充统一CAS。仅任务进度变化不递增内层stateVersion；服务本地变化的发现与快照标识跟随公共契约。

## 3. 接口与保存流程

| 逻辑接口 | 输入 | 输出 / 写入权 |
|---|---|---|
| PrepareMemoryProposal | 获准 eventIds、裁剪上下文、政策版本与基础 ReadView | 结构化 Proposal 或 no_candidate / insufficient_evidence；模型无提交权 |
| ValidateMemoryProposal | Proposal、来源状态、readSet、保存政策 | accepted / rejected / needs_review；校验本身不暗写内层 |
| CommitMemoryChange | core 批准的提案和幂等身份 | MemoryRecord、依赖引用、检索投影、持久 outbox 同事务；提交回执 |
| QueryMemory | query、scope、subjectIds、atTime、topK（默认 10、上限 20） | 允许读取的 MemoryHit 与版本/索引水位，交给 ReadView 服务裁剪 |
| RequestMemoryErasure | 用户删除指示或已确定保留政策、范围、预期版本 | deletionJobId 与当前清除阶段；不是“归档成功” |

保存顺序：

1. **先执行政策。** 事件接收、临时会话落盘不等于长期记忆授权。敏感内容、第三方资料及不允许外发的来源先按数据范围筛选，未获准内容不进入远程抽取。
2. **形成候选。** 用户明确要求保留的事实、稳定偏好、可重复流程与对已有记录的纠正优先；一次性运行状态留在任务系统。候选默认最多 7 天，未晋升即按候选保留政策清理。
3. **找已有记录。** 按主体与时间筛选再检索；相似只用于提出“可能重复”，不自动合并同名人物或不同时间的事实。
4. **核对提案。** 每项必须有可引用来源，区分引述、事实陈述和推断；注入文本中的命令保留为普通内容，不授予操作权。无证据、来源已撤回、越权或版本冲突则拒绝。
5. **一次受控提交。** 使用 `eventId + operation + targetId + extractorVersion` 等稳定任务身份去重；失败重试不会重复形成正式记录。FTS5 模式下正式聚合、search_docs 与索引触发更新使用同一 SQLite 事务。
6. **回执与复核。** replyer 仅在读取 CommitReceipt 后可表达“已记住”；队列受理只表示等待处理。正式记忆默认 90 天复核，不因到期复核自动删除；明确保留期优先。

保存同一事实的第二条转发内容不会被计作独立证据。对旧事实的修订创建新 revision 并关联原版本；检索可按 atTime 看历史，默认只返回当前有效版本及明确冲突标记。

## 4. 基础检索与中文处理

基线 SearchPlan：先固定访问范围和主体/时间，再走实体别名精确查询与 FTS5，最后回查权威状态及来源可用性。全文候选最多 100 条，裁剪后提供默认 10 条，不把无边界大扫描交给模型。

- 正文与查询使用同一 `Intl.Segmenter(locale,{granularity:"word"})` 规则，取词单元后交 unicode61 + BM25；保留原文展示，分词文本只在派生投影中。
- tokenizerVersion 记录 Node、ICU、locale 与规范化规则。版本变化先构建新 indexEpoch，未核对中文用例前不混写新旧分词。
- 账号、路径、项目 ID、二字姓名和已确认别名另用普通索引查找。不可把姓名字符串相等视为 entityId 相等。
- FTS 查询由程序构造受限词项并参数化；用户字符串不直接成为 SQL 或任意 MATCH 表达式。中文无字典分词支持时先降级为精确主体/别名检索并标记能力下降；不自造分词算法填补。
- BM25 排序后以确定性的主体匹配、时间有效性和固定优先项分组，不把访问次数自动转为内层“重要性”。检索不修改 MemoryRecord；使用反馈进入独立事件，由内部另行判断。
- 搜索结果必须回查当前 ACL、tombstoneWatermark、来源删除状态与 entity revision；旧索引命中仅是候选，不能直接填入回复。

ReadView 沿用统一 `commitSeq, stateVersion, authEpoch, tombstoneWatermark, indexWatermark, aggregateVersions`。索引落后时返回 stale 与水位差，允许精确读权威记录；对“全部符合条件”之类完备性问题不得把不完整索引当完整答案。

## 5. 更新、淡忘、删除与恢复

| 情况 | 处理与验收依据 |
|---|---|
| 新事实与旧记录矛盾 | 提交 contested 及冲突来源；由认知模块提出修订，禁止最新消息无条件覆盖 |
| 不常用 / 自然淡忘 | 调整派生排序或归档候选；不自动硬删正式事实，不把“少被检索”当“不真实” |
| 原始来源按 30 天默认 TTL 到期 | 保留政策允许的独立长期记忆；来源仅剩最小元信息并标 evidence_unavailable，不宣称仍能核对全文。来源到期不会反向扩张保存授权 |
| 用户撤回或删除来源 | 事务中立即标 tombstone、提高删除水位并使关联 ReadView 强失效；反向 dependencyRefs 定位记忆、关系、认知及人格候选中的派生内容 |
| 派生链含多份依据 | 对受影响项先停止导出；只可凭未删除的独立证据重新提出内容，不能换个摘要保留被删除部分 |
| 索引失败 / 损坏 | 正式状态保留；禁用损坏索引，使用精确查询，重建新 epoch 后核对数量/抽样/删除水位再切换 |
| 模型超时 / 无有效 JSON | 任务区分失败与 no_candidate；保持原状态，限制重试，不静默声称没有值得保存的内容 |
| 重启 / 迟到提案 | 恢复持久任务，检查 readSet、授权、源撤回与提案版本；旧提案不能复活已删记录 |

删除是可查询的多阶段任务：`accepted → blocked_from_reads → live_copies_purged → backup_pending → completed / failed`。内层只承诺自己已证实的阶段。派生索引、缓存、会话投影、对象文件、设备暂存、导出物和备份处置由[数据区域](<../../../../06-预留空间/README.md>)与[独立备份](<../../../../07-独立备份/README.md>)统一登记。恢复旧备份时必须先应用最新删除/撤权水位，再开放读取；审计只留随机对象 ID、任务 ID、时间和结果，不能残留被删除原文、摘要或可反推内容的哈希索引。

数据库行删除、文件移除不等于 SSD 介质物理不可恢复；是否完成相应层面的清除，以数据层验证与备份清单为准。

## 6. 语义增强的明确切换门槛

**默认不开启 LanceDB。** 基础检索完整通过 V07/V16 后，在 V25 固定中文改写检索集比较：

1. FTS5 的 Recall@10 未达 0.85，且错误主要来自语义改写，而非身份、权限或源数据缺失；
2. LanceDB hybrid 在同一保留测试集上相对提高至少 **10 个百分点**，总体 Recall@10 达 0.85；若单纯全文已达标则不引入；
3. 删除/撤权零泄漏，精确账号/名称/时间测试零回退，查询 P95 不超过基线两倍且不高于 400ms（不含 embedding），资源峰值在验证机器预算内；
4. embedding 使用已允许该数据级别的固定 EmbeddingProfile，并锁模型标识、版本/摘要、维度、归一化方式；未配置该 profile 则保持 FTS5 并如实记录语义门槛未通过。不得擅自把真实记忆上传外部服务。

通过后选择 `@lancedb/lancedb 0.41.0` 的现成 hybrid/RRF，迁移 search_docs 的派生副本；SQLite 的实体/时间/ACL 普通索引继续负责权威筛选，**不再同步维护两套正常工作中的全文索引**。迁移为：权威快照 commitSeq S → 新 epoch 构建 → 回放 outbox 至当前水位 → 同集质量/删除核验 → 原子切换 searchBackend/indexEpoch。试运行失败则回滚路由、从权威数据重建 FTS5，不能从 LanceDB 反写事实。

向量更新按 embeddingProfileId 分 epoch，维度不兼容禁止混查。LanceDB 的删除还需处理旧版本、碎片与索引；使用官方 optimize/prune 接口前停写并隔离读者，完成受控重建与清理验证。若无法证明其旧副本清理满足数据政策，该增强不进入真实数据阶段。该清理能力是验证项，不从 delete API 推导物理清除完成。

## 7. 下一阶段验收

以下均为计划，未运行。跨模块编号以总验证计划 V07、V16、V23、V25 为准。

| 用例 | 通过条件 |
|---|---|
| V07：30 条可追溯事实 + 10 条必须拒绝材料 | 重复事件仅一次正式提交；缺来源、越权、撤回后晚到提案全部拒绝；只读检索前后内层 revision 不变 |
| V07：同名、短名、中文词界、时间修订 | 账号/二字名精确查找正确；不存在跨主体混合；atTime 区分历史与当前版本 |
| V16：删除与旧索引/旧视图/恢复重放竞态 | 确认 tombstone 后读取泄漏为 0；源与派生都有清除阶段回执，旧备份恢复后无复活 |
| V25：冻结合成抽取集 | 至少 300 段材料，含 120 条可保存候选；人工标注保存范围/主体/时间/来源；保存 precision ≥0.95、recall ≥0.80；失败按原因归类，不只报平均分 |
| V25：冻结检索集 | 至少 200 查询，覆盖事实、中文改写、时间、否定、同名、不可回答；Recall@10 ≥0.85，不可回答误报率 ≤0.05；语义增强另满足第 6 节收益门槛 |
| V23：负载与故障 | 1 万条已提交记忆下 FTS5 查询 P95 ≤200ms（不含模型）；源写与索引之间崩溃后可恢复，不能出现已回执而缺权威记录 |

保存模型、检索模型、提示词、分词、索引和评测集都记录固定版本；真实模型指标走 V25，确定性 fixture 成功不能当作语义能力已验证。

## 8. 证据与剩余边界

本轮有官方文档阅读及 Mem0 当前限定源码核查；无运行验证。与原先整套记忆候选相比，推荐保留的是成熟引擎和可测试的机制，新增部分限于识雨自己的领域协议。备选切换已有门槛；具体机器性能、目标 SQLite/ICU 能力与模型有效性在验证阶段锁定，不影响方案进入验证。

详细来源、快照、许可证及取舍见[记忆关系认知证据](<../../../../../../research/2026-11-01-完整架构/记忆关系认知.md>)。

