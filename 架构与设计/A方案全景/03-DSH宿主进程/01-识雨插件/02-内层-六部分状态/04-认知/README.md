# 认知 · 证据与判断修订方案

[所属区域](<../README.md>) · [完整目录](<../../../../目录.md>) · [记忆](<../01-记忆/README.md>) · [关系](<../02-关系/README.md>) · [证据](<../../../../../../research/2026-11-01-完整架构/记忆关系认知.md>)

- 更新：2026-11-01（America/Caracas）；模块 ID：`cognition`。
- 设计状态：供验证的建议基线；未实现。本模块维护“识雨根据什么形成了什么认识、何时需要修正”，不训练新模型，也不另建自主行动调度器。
- 依赖：DSH 推理入口、记忆/关系查询、统一 Proposal 与 CoreCommitService、成熟 JSON Schema 校验及 SQLite 版本存储。

## 1. 主方案与必要自定义范围

采用 **受限上下文 + 通用模型的结构化提案 + 确定性校验 + 有来源的判断记录**。复用 DSH 的模型和会话、标准结构校验、SQLite 事务；认知只定义识雨特有的判断类型、证据状态与修订条件。首版不引入 RL 训练、通用知识图谱推理引擎或另一套 Agent 编排框架。

**优先局部改编现成筛选策略，而非从零设计反思提示。** 固定Letta Code 0.34.34 / 89a757…中reflection-v2.md的Trajectory review段及maintaining-core-memory/SKILL.md的稳定模式/纠正/假设验证规则，去掉Bash/Edit/Git直接提交和系统提示注入，输出本文Claim/RevisionCandidate与sourceRefs，由DSH模型执行。Apache-2.0许可、来源与修改声明一并保留；本轮只形成复制计划，未复制产品文件。

Mem0固定753496cf…的ADDITIVE_EXTRACTION_PROMPT和generate_additive_extraction_prompt格式化闭包也是可局部移植候选；它只需json/datetime，可转成TypeScript，补已获准范围、观察时间及逐项来源，不必部署Mem0才复用抽取。若选择其完整SDK，add(infer=False)可直接保存已批准文本，不应把“不能同库”作为拒选理由。Ombre `dream/I`优先提供经历回顾和自我候选，重复见证不作为独立事实支持。三者共同未提供的产品规则才是本模块保留的证据分组、冲突/时间判断与批准提交。固定文件、许可、依赖与修改范围见[复用核查](<../../../../../../research/2026-11-01-复用核查/记忆关系认知.md>)。

## 2. 判断记录及来源

| 对象 | 核心字段 |
|---|---|
| Claim | `claimId, revision, subjectIds, propositionRef, claimType, scope, validFrom/To, sourceRefs, dependencyRefs, epistemicStatus, reviewAfter` |
| EvidenceAssessment | `assessmentId, claimId, evidenceRef, relation(supports/contradicts/context_only), provenanceGroupId, assessedAt, assessorProfileId` |
| ConflictSet | `conflictId, claimIds[], subject/time/scope, unresolvedReason, resolutionRef?` |
| RevisionCandidate | `candidateId, targetClaimId, proposedStatus/contentRef, sourceRefs, readSet, policyVersion, expiresAt` |
| DecisionSummary | 与一次 task/commit 关联的简短结论、依据 ID、替代选项和未解决事项；不保存冗长隐藏推理轨迹 |

`claimType` 区分用户自述偏好、观察结果、外部来源陈述、模型推断、可复用流程假设。来源质量保留类别与验证方式，不折成能自动授予权限的统一分数。记录来源的观察时间、声明时间和有效区间，不用模型当前日期覆盖历史。

`provenanceGroupId` 将同一来源的转发、摘要和重复提及归为一组；同一材料被多个模型复述不算独立支持。概念参考 W3C PROV 的归属、生成、派生与失效关系，落地使用普通有向依赖引用，不额外引入标准全栈。[PROV-DM](<https://www.w3.org/TR/prov-dm/>)

## 3. 状态与转换

| 状态 | 含义 | 允许转换条件 |
|---|---|---|
| hypothesis | 模型推断或尚无充分来源的认识 | 获得可核对来源后提出 supported；过期仍无依据则拒绝候选或继续未知 |
| supported | 有指定范围内的支持证据 | 新矛盾成为 contested；明确修订成为 superseded；源撤回成为 evidence_revoked |
| contested | 有互斥或难兼容的依据 | 先核对主体/时间/范围；足以解决才提案确定有效版本，否则保持并列 |
| superseded | 已被有依据的新版本替代 | 历史查询仍可解释修订；不能被默认检索当作当前事实 |
| evidence_unavailable | 来源正文到期或暂不可读 | 记录可用性限制；补足独立来源后重审，不把旧置信度当仍可核验 |
| evidence_revoked | 来源被删除或撤回，当前判断暂停使用 | 受影响内容先阻断导出，按未删除独立证据重新提出；不能直接恢复旧摘要 |
| tombstoned | 按删除要求不可再读取正文 | 仅由删除流程保留最小状态；旧任务/回放不得恢复 |

“supported”只表示具有规定范围内的依据，不宣称普遍真理。用户对自己当前偏好具有直接陈述依据，关于第三人的传闻仍只是该来源的陈述。数值计算、工具操作结果等需可复验的程序证据；模型“我已确认”不算核验。

## 4. 一次认知更新的闭环

1. **触发。** 新的正式记忆、用户纠正、工具核验结果、来源失效或有界周期回顾进入 core 队列；本模块不独立无限轮询。
2. **取材。** 只取获准 ReadView 及相关记忆/关系，保存引用版本；默认最多 20 个相关条目，超过则分批或缩小问题。使用已存在抽取结果，避免同一输入重复调用模型。
3. **提出。** 模型输出有类型的 Claim/RevisionCandidate、逐项 sourceRefs、替代解释和简短理由。无法确定则输出 unknown / needs_evidence，而不是填补材料缺口。
4. **程序校验。** 检查结构、来源可访问且未撤回、主体/时间匹配、readSet、禁止的权限扩张及内容保留范围。结构合规不等于语义正确，后者由 V25 测量。
5. **冲突判断。** 相同主体/谓词在同一有效区间互斥才建立 ConflictSet；先排除“时间改变”“引述者不同”“不同任务范围”。不能单凭新旧时间或重复次数强行选胜者。
6. **受控提交。** core选择接受、拒绝或继续调查；本地Claim、依赖引用和失效outbox可同事务提交，相关实体revision做CAS。若提案依赖Ombre/Mem0新记忆，先确认服务写结果与nativeId，再提交引用它的Claim；中间标pending/unknown，不宣称跨服务原子成功。服务回顾不直接修改人格/权限。
7. **通知与验证。** 新判断只通过只读视图影响表达。若需要改变人格、能力策略或外部行动，仅产生对应域的 Proposal，由该域政策另行处理，不直接修改它们。

认知结论是数据，不是更高优先级指令。来自外部文档或长期记忆的“忽略规则”“调用某工具”等文本，即使被模型总结，也不能获得 Mandate 或工具权限。

## 5. 对外接口与跨模块约束

| 接口 | 作用与所有者 |
|---|---|
| AnalyzeEvidence(eventRefs, viewId, questionScope) | 产出 Proposal/unknown；通过 DSH 调模型，不直接改内层 |
| QueryClaims(subjectIds, atTime, scope, includeConflicts) | 返回有来源和状态的判断，默认包含相关冲突提示；经 ReadView 输出 |
| ProposeClaimRevision(targetId, sourceRefs, readSet) | 对纠正、过时、冲突解决提出具体变更，不使用不限定字段的任意 patch |
| InvalidateByEvidence(sourceIds, tombstoneWatermark) | 由受控失效流程遍历 dependencyRefs；先阻断可见性，再后台重算 |
| ExplainClaim(claimId, revision, scope) | 返回简短结论、可见依据和未知项，来源已清除时如实说明不可用 |

与记忆分工：记忆保存经历与获准事实；认知保存由这些材料得到的判断与修订关系，不重复复制完整原文。与关系分工：必须使用 entityId，身份 ambiguous 时不产生跨人综合结论。与情绪分工：情绪可影响关注顺序，不改写证据真实性。与人格/能力分工：稳定变化有独立版本与验收，不能因一次认知提案直接晋升。

## 6. 回顾、预算与失败

认知回顾默认由 core 在有新增证据或到期复核时触发；日内对同一输入范围与 profileVersion 去重。每个回顾最多两次模型调用：第一次整理提案，第二次只用于必要核对或一次结构修复，两者共享该剩余名额；预算不足保持原状态并标 deferred。正式频率、token 和费用上限引用 core 的总预算，不额外开一套无限后台循环。

| 失败 | 处置 |
|---|---|
| 模型不可用 / 输出不合法 | 明确失败原因；保持旧版本，禁止把错误当作“无变化”成功回执 |
| 提案期间新纠正到达 | 相关 readSet 失效，丢弃旧提交资格，重新取材；不自动覆盖新版本 |
| 支持来源被删 | 查询立即屏蔽受影响内容，后台撤回/重算；旧提案不能复活 |
| 来源互相冲突 | 并列证据与范围，不强迫生成唯一答案；需要外部核验时由 core 建任务 |
| 反复回顾产生相同提案 | 同来源集合、目标、profileVersion 去重；暂停该回顾并记录原因 |
| 记忆索引落后 | 用权威 ID 精确取材或延迟；不得把没搜到当作事实不存在 |
| 恢复旧数据库 | 先应用最新删除/授权水位，再恢复认知依赖投影，重算完成前不导出可疑判断 |

## 7. 验证与后续升级

| 用例 | 通过条件 |
|---|---|
| V07：纠正、引述、重复转发、时效变化 | 正确状态转换；无依据直接 supported、跨主体综合、重复来源计独立证据均为 0 |
| V07：旧提案 + 并发修订 + 源撤回 | CAS 拒绝冲突，删除先阻断导出；任何迟到任务不能覆盖或复活已失效内容 |
| V16：源删除传播至 Claim/人格候选/ReadView | 可枚举依赖影响；读取零泄漏，任务结束有可解释回执 |
| V25：冻结认知评测 | 至少 100 组歧义/纠正/矛盾/无答案案例；来源归属正确率 ≥0.95，互斥误合并率 ≤0.02；越权提案提交率 0 |
| V25：实际效益 | 同一模型和输入下，对照“直接用聊天摘要”：有证据答案正确率不下降，来源可追溯率 1.0；记录调用数、延迟与 token，不以反思文本长度当收益 |
| V23：资源限制 | 到达预算或重试上限后任务进入明确 deferred/failed；没有后台无限回顾或重复正式变更 |

Memory-R1/AgeMem/MemRL 等训练或效用学习路线保留为后续备选：只有固定任务中出现可重复的判断/检索瓶颈，现有提示与成熟组件无法解决，且影子评估证明稳定收益后才进入专项实验。首版不以训练新模型作为架构成立前提。

## 8. 证据级别

本模块的状态机、预算与阈值是识雨的设计建议，不是上游产品保证。官方文档及固定源码提供了可复用的机制证据；模型语义效果、长周期稳定性与故障恢复均未实测。来源详见[证据记录](<../../../../../../research/2026-11-01-完整架构/记忆关系认知.md>)。

