# Mem0

> 2026-11-01 复用核查修正：固定753496cf…的`add(infer=False)`可直接接收core批准文本，应列为**可直接接入的替代记忆后端**，不再仅限影子参考；它与Ombre择一承担相同记忆权威，不并行双写。另有可独立复制的抽取提示/格式化闭包。仍未安装、运行或采用，证据见[本轮复用核查](<../research/2026-11-01-复用核查/记忆关系认知.md>)。

[返回技术候选目录](<目录.md>)

## 基本信息

- **类型 / 方向：**开源记忆基础设施；结构化抽取、存储与检索。
- **来源：**[官方仓库](<https://github.com/mem0ai/mem0>)。
- **审阅快照：**[26cdefb46600c0fa5953c4b5ee5003c125539fc4](<https://github.com/mem0ai/mem0/commit/26cdefb46600c0fa5953c4b5ee5003c125539fc4>)，提交日期 2026-10-26。
- **记录日期：**2026-10-30（America/Caracas）。
- **状态：**已初评；限定静态阅读，未安装、未运行、未复现实验。

## 一句话判断

可直接复用SDK保存与检索core已批准的记忆，也可只复制提示/格式化函数由DSH生成提案。**当前默认推断模式不是常见旧介绍中的 ADD / UPDATE / DELETE / NONE 四操作判断，而是单次 ADD-only 抽取；infer=False则跳过这一抽取。** 不同数据库不是拒选理由，实际缺口在授权映射、重试幂等及所有副本清除。

## 2026-11-01 直接使用与局部复制方案

新增核查固定提交`753496cf1435d76c3a711f3af51303f7fdcb6420`；[pyproject.toml](https://github.com/mem0ai/mem0/blob/753496cf1435d76c3a711f3af51303f7fdcb6420/pyproject.toml)版本2.2.1、Python>=3.10,<4.0，[LICENSE](https://github.com/mem0ai/mem0/blob/753496cf1435d76c3a711f3af51303f7fdcb6420/LICENSE)为Apache-2.0。基础依赖qdrant-client、Pydantic、OpenAI、httpx、PostHog、pytz、SQLAlchemy、protobuf；NLP为可选项。验证须记录所选provider及`MEM0_TELEMETRY=False`，后者关闭默认启用的遥测。

| 复用项 | 精确接口 / 源码 | 适配范围 |
|---|---|---|
| 批准后保存 | [main.py760–917](https://github.com/mem0ai/mem0/blob/753496cf1435d76c3a711f3af51303f7fdcb6420/mem0/memory/main.py#L760)，`Memory.add(...,infer=False)` | 用纯文本并关闭vision加工；跳过抽取LLM与此分支save_messages，仍生成embedding、随机UUID、vector及SQLite history |
| 检索 / 精确读 | `get`1222、`get_all`1269、`search`1393 | search/get_all作用域放filters；get按ID不替代鉴权。适配器回查owner、scope与tombstone |
| 更新 / 删除 | `update/delete`1829–1902；[_delete_memory2121–2146](https://github.com/mem0ai/mem0/blob/753496cf1435d76c3a711f3af51303f7fdcb6420/mem0/memory/main.py#L2121) | 身份字段创建后不可改；没有识雨readSet公共参数，由单写者门面维护版本。delete把旧正文写入history.prev_value，不能当作完整清除 |
| 抽取提示 | [prompts.py468–958](https://github.com/mem0ai/mem0/blob/753496cf1435d76c3a711f3af51303f7fdcb6420/mem0/configs/prompts.py#L468) `ADDITIVE_EXTRACTION_PROMPT` | 输出memory/attributed_to/linked_memory_ids；改为获准范围并补sourceRefs、主体和观察/生效时间，不把关联ID当独立证据 |
| 提示构造闭包 | [prompts.py961–1064](https://github.com/mem0ai/mem0/blob/753496cf1435d76c3a711f3af51303f7fdcb6420/mem0/configs/prompts.py#L961) `generate_additive_extraction_prompt`及六个格式化函数/常量 | 仅依赖标准库json/datetime，可移植TypeScript供DSH调用；无需SDK、Python服务或向量库 |

局部移植保留Apache-2.0、适用署名、源提交和修改说明，实际复制时核对发行包NOTICE。**本轮复制产品源码为0**。不复制整段Memory.add作为“仅分析”函数，它包含有状态后端操作；不为已批准文本绕行私有函数。

Mem0实体索引仅是类型+文字候选，[entity_extraction.py731–778](https://github.com/mem0ai/mem0/blob/753496cf1435d76c3a711f3af51303f7fdcb6420/mem0/utils/entity_extraction.py#L731)依赖英语spaCy模型，不提供同名消歧、跨账号验证或可撤销身份合并，因此不是识雨关系层的直接替代。

采用验证：V07测source/metadata往返、过滤/精确读授权、重放；随机ID不天然幂等，服务写后回执丢失必须先核对。V16测history/messages/实体关联/索引/备份清除；V25对照默认抽取、DSH+局部提示与Ombre，比较误写和维护量。未通过时切换后端，不能留下另一套仍在写的正式记忆库。

## 当前实际机制

1. 收集最近消息与相似的已有记忆。
2. 用可配置 LLM 和抽取提示词生成 JSON `memory` 列表；没有抽取项时不新增语义记忆。
3. 对正文做嵌入及哈希去重，分配新 ID 并新增，不由该默认路径自动覆盖或删除旧事实。
4. 显式 update / delete API 仍然存在；“默认抽取仅新增”不等于系统完全不能修改或删除。

官方迁移说明与实际代码一致：[V3 迁移说明](<https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/docs/migration/oss-v2-to-v3.mdx#L14-L40>)、[默认抽取与去重实现](<https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/mem0/memory/main.py#L918-L1041>)、[显式修改 / 删除入口](<https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/mem0/memory/main.py#L1829-L1902>)。

旧四操作提示词仍保留在代码中，但不能据此推断当前默认执行流程。其作用是提示模型作决策，不是一个经项目专门 RL 训练并验证过的四分类策略模型。

## 可借鉴与不能照搬

- **可借鉴：**结构化输出、已有记忆对照、去重、显式区分抽取与提交；追加式保存可以降低错误合并直接覆盖历史的风险。
- **仍需处理：**新旧事实可以并存，冲突、时效、归属与权威版本要在其他环节解决；文本哈希去重不等于语义去重。
- **不能把抽取规则当作事实校验器。** 当前提示词也处理 assistant 内容，要求区分来源；识雨仍需防止把模型建议或虚构回复固化成用户事实、人格或能力。
- **不抽取不等于不留数据。** 默认代码在空 `memory` 时仍保存输入 messages。若用户要求不保留，或组件必须对内只读，不能简单以“没有新记忆条目”视为符合约束。
- **不应放在只读外层直接调用写入。** 若用于识雨，抽取与提交应由 core 控制的内部通道承担；replyer 只发送观察事件或读取授权结果。

## 成熟度与证据边界

当前机制有完整公开执行路径，可作为受控原型的参考；本次未验证生产稳定性或逐条记忆决策准确率。

官方评测页面明确：公布的成绩来自带有专有优化的 managed platform，不应直接视为开源 SDK 成绩；检索预算、回答模型和 LLM judge 也影响结果。问答得分不等于“该记 / 不该记”的判断准确率。[评测口径](<https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/docs/core-concepts/memory-evaluation.mdx#L125-L140>)。

## 待验证与决定

- [ ] 在识雨样本上区分误写、漏写、错归属、矛盾累积与问答效果。
- [ ] 核查空抽取、解析失败、模型不可用及输入保留策略的区别。
- [ ] 明确追加事实、废止旧观点和真正删除的不同通道。
- [ ] 验证外层无法经此服务获得内部写权限。

**2026-10-30：**收录作工程路线参考；未决定采用。后续版本可能再次改变默认策略，升级前需重新核对执行路径。
