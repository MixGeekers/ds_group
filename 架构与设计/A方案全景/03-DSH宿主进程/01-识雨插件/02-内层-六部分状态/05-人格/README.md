# 人格

[所属区域](<../README.md>) · [完整目录](<../../../../目录.md>) · [证据与选型](<../../../../../../research/2026-11-01-复用核查/情绪人格能力.md>)

- 更新：2026-11-01（America/Caracas）。模块 ID：`personality`。
- 设计状态：Ombre I候选与DSH提示装配联合复用的优先验证方案；Ombre尚未采用。
- 实现状态：未实现、未实测；没有改动真实用户偏好、模型权重或宿主提示。

## 1. 主方案与非目标

人格首版优先采用 **Ombre I自我认知候选＋小型PersonaProfile＋DSH原有提示装配**。I与记忆/feel共用一个服务和权威桶，不能再自建一套“人格反思记忆库”；稳定Profile仅保留名称、语言、风格和映射规则。Ombre候选尚未采用，真实接口与效果待验证。

本次替换旧方案中独立pattern_candidate生成/沉淀引擎的隐含安排。调用 `I(content, aspect)` 写候选、`dream` 形成跨日见证、`I(promote=id)` 晋升、`I(read=True)` 取得当前/质疑/取代记录；由core组织这些有副作用调用。其3日门槛是沉淀节奏，不是事实证明；I叙述不会自动覆盖Profile，更不会成为系统授权。[固定I实现](<https://github.com/P0luz/Ombre-Brain/blob/115d831d979bf67efc7150f976e2cb34c333c935/src/tools/i/core.py#L303-L454>)

人格回答“识雨以什么稳定风格理解和表达”，不存全部用户画像、经历与事实；这些分别属于关系、记忆、认知。对某位用户“回答短一些”的偏好属于有范围的 UserPreference，由只读视图合成，不会因此修改全局人格。

人格不赋予权限、扩展预算或决定自己必须执行某任务。事实不确定性仍由证据决定，不能因为“自信”的风格而隐去不确定性；角色设计也不要求声称具有生物身份或主观体验。

## 2. 状态、优先级和接口

| 对象 | 必要字段与语义 |
|---|---|
| `PersonaProfile` | `personaId, schemaVersion, profileVersion, revision, displayName, languageDefaults, style, expressionPrinciples, createdAt, sourceRefs, previousVersion` |
| `style` | V1 仅 `warmth / directness / verbosity ∈ [0,1]`，建议初值 `0.6 / 0.7 / 0.4`；参数用于模板映射，不宣称对应心理人格量表 |
| `expressionPrinciples` | 有限枚举的表达原则，如讲清依据、承认未知、尊重暂停；权限策略另有唯一所有者，不能在此覆写 |
| `PersonaChangeProposal` | 复用统一 Proposal；额外含精确字段差异、变更原因、`sourceKind=user_explicit/pattern_candidate`、评测版本、回退目标 |
| `PersonaView` | ReadView 裁剪结果，含 profileVersion、stateVersion、commitSeq、scopeHash、authEpoch、来源及有效期；不提供更新句柄 |
| `StyleOverride` | 当前任务或会话的临时输出要求，只作用于受限字段，随任务 / 会话到期，不自动存为人格 |
| `PersonaEvaluation` | 版本对、固定样例集版本、输出引用、评分及失败项；只读证据，不能自行发布版本 |

表达参数组合顺序为：**执行与数据政策约束 → 当前用户明确输出要求 → 获准的用户范围偏好 → 稳定人格 → 与当前任务相关的感受表达参考**。任何一层都不能改动前一层的授权或事实；后置参数只作用于尚可调整的表达维度。默认同一回复开始时冻结一个 profileVersion，避免生成途中风格跳变。

逻辑接口为 `getPersonaView(scope)`、`proposePersonaChange(diff, sourceRefs)`、`evaluatePersona(candidateVersion, suiteVersion)` 和 core 的统一提交。外层只能读视图或递送用户输入，不能调用激活与保存接口。

## 3. 稳定配置与学习分开

首版将人格配置作为有 schema 的 JSON 文档放入领域状态，候选与 active 版本分开，更新使用 CAS。领域配置统一采用 JSON Schema 2020-12 与 Ajv 校验，复用公共校验器并拒绝未知字段；只在向 DSH 注册工具时映射到宿主支持的 schema 子集，不能用工具子集替代完整领域约束。[统一技术基线](<../../../../技术选型与决策.md>)；[DSH 工具 schema 与校验](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/tools.md>)

版本发布流程：

1. **提出。** 明确用户指示由 core 解析为可审阅字段差异；从经历发现的模式优先写入Ombre I候选，Profile侧只保存bucket引用与拟变更差异，不复制I正文。使用I现有不同日期3次dream见证门槛；若要影响持久Profile，必须另核查有效的来源支持、矛盾与用户指示，日期计数不能替代独立证据。撤回机械叠加“三条证据/两会话”作为另一沉淀引擎的默认要求。
2. **校验。** 只准变更白名单字段；拒绝工具权限、凭据、主机配置、记忆保留和预算字段。认知中的支持 Claim 必须仍有效；来源已撤销则候选失效。
3. **离线回归。** 在固定合成样例上对比 active 与 candidate。这里“离线”指无真实外部动作；是否允许使用模型 API 由验证阶段预算决定，不假定本地推理。
4. **激活。** 用户明确请求修改且结构化差异与请求一致，可在既有授权范围提交；学习得到的持久人格变化默认需要用户审阅具体差异。当前用户授权的是架构设计，不等于提前批准未来人格自动变更。
5. **观察与回退。** 首批最多 20 次已授权对话使用新版本，保留旧版可选；发现事实边界、隐私或授权回归立即停用新版本。回退改变 active 指针并增加实体 revision，不擦除期间的其他记忆和任务。
6. **稳定。** V1 不按每轮对话重写人格、不训练模型权重；I到Profile的候选差异最多每7天汇总一次供审阅，用户显式变更不受这个汇总周期限制。

变更状态建议为 `draft → validated → awaiting_review → active → superseded`，或 `rejected / invalidated / rolled_back`。本地Profile发布事务同时保存版本、active指针、审核依据和outbox；任务重试不得重复激活同一提案。Ombre I晋升与本地Profile发布跨服务，不在同一事务：采用记忆模块命令回执与unknown核对，先确认I状态，再决定是否发布Profile。I晋升成功不自动激活Profile；Profile失败也不伪造I已回滚。

## 4. 失败、版本冲突与删除

| 情况 | 处理 |
|---|---|
| 同时修改同一 profile revision | readSet 的 expectedVersion 失败；返回当前差异重新合并，不 last-write-wins |
| 模型输出非法字段或“解除限制” | schema 与字段白名单拒绝，保留最小失败记录 |
| 配置损坏或未来 schema | 使用最近通过验证且可读的版本；没有可用版本时用静态中性表达模板 |
| 新版本提示成本过大 | 输出投影预算建议 ≤ 600 个中文字符，超过则结构化裁剪，不截断执行政策 |
| 来源删除或撤权 | 失效所有含该来源的 PersonaView；去掉依赖该来源的字段或回到独立来源支持的版本，再运行回归 |
| 新版本已有任务或外部效果 | 人格回退不回放工具、不撤销事实、不重做任务；仅影响后续表达 |

稳定人格是配置而非秘密储存处。身份偏好和变更理由按拥有者范围访问，普通对话只获取必要的风格投影；不向模型发送审核者内部身份、凭据或其他会话原文。sourceRefs 与反向依赖支持删除传播，最小审计不保存被删除内容的摘要或可重识别文本哈希。

默认保留 active 与最近两个可恢复版本；更早版本保留期依统一配置审计政策。来源删除优先于保留版本，备份恢复必须先应用删除清单，不能靠切回旧版恢复已删除偏好。

## 5. 验证与替代

以下属于 **V08**，语义评分归入 **V25**；本轮未运行。

| 验证 | 通过标准 |
|---|---|
| I与Profile联合复用 | 同日dream不多计见证、未满3日晋升拒绝；晋升I不自动改Profile；I服务失败仍能固定表达；原始I/feel不在Profile重复成为正文权威 |
| 稳定性 | 100 轮不含合法变更的合成对话后 active profileVersion 不变 |
| 外层与注入 | 普通对话、工具结果和恶意“从此改人格”片段不能直接提交；只有可归因的授权输入形成提案 |
| CAS 与幂等 | 同 revision 两个变更最多一项成功；同 idempotencyKey 重试 1,000 次只激活一次 |
| 参数边界 | 越界、未知字段、修改权限策略全部拒绝；现有授权和工具集不因人格变化扩大 |
| 版本回退 | 候选激活与回退可解释，回退后现有任务和记忆版本未被覆盖 |
| 删除传播 | 删除源后当前及旧版本不再导出其派生内容，旧 ReadView 立即失效 |
| 固定语义回归 | 50 组固定样例中事实边界、授权边界、隐私检查无新增失败；对目标风格的盲评改善才保留新版本 |

**替代与切换：**如果动态人格投影难以保持稳定或成本高于收益，使用一个人工维护的固定PersonaProfile，关闭I到Profile的学习映射；Ombre已有记忆照常可读，不能为回退风格删除经历。只有在固定配置与范围偏好均不能满足已测量需求时，才评估现成个性化系统或微调；不能为“看起来像会成长”而引入训练平台。

## 6. 复用依据与接口关联

DSH固定提交提供 `ctx.systemPrompt.section(PromptSection)` 与 `ctx.systemPrompt.context(PromptContext)`，复用scope、排序及注册disposer，可输出版本冻结后的表达依据，不重新实现提示装配器。Profile只是一份小型领域配置，不新增人格平台。人格内容与权限执行保持分离。[DSH 系统提示接口](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/system-prompt.md>)

Ombre固定提交 `115d831d979bf67efc7150f976e2cb34c333c935` 与DSH `ce7073d51254c26cd63b22a60835b8f948deb447` 均MIT；服务依赖、调用副作用、许可声明和失败回退见证据页。本篇的版本流程、默认参数与发布门槛均为设计建议。与 [记忆](<../01-记忆/README.md>)、[认知](<../04-认知/README.md>)共享 sourceRefs / dependencyRefs / EvidenceRevoked；与 [情绪](<../03-情绪/README.md>)只组合视图，不互相改写权威状态。

