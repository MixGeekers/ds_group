# 关系 · 身份与可核对关系方案

[所属区域](<../README.md>) · [完整目录](<../../../../目录.md>) · [记忆](<../01-记忆/README.md>) · [证据](<../../../../../../research/2026-11-01-完整架构/记忆关系认知.md>)

- 更新：2026-11-01（America/Caracas）；模块 ID：`relationship`。
- 设计状态：供验证的建议基线；未实现。这里管理“谁是谁、与谁有什么已知联系及依据”，外层“链接”仍只负责渠道收发。
- 首版使用 SQLite 关系表/类型化投影及唯一约束，复用渠道已有身份；不部署图数据库，不开发统一社交身份平台。

## 通讯录细化入口

完整补充方案见[通讯录与人际关系](<../../../../通讯录与人际关系.md>)，一手依据见[连接与身份核查](<../../../../../../research/2026-11-01-连接订阅与技术栈/通讯录关系.md>)。通讯录和人物认识分别管理：Contact为用户保存的卡片，ParticipantAccount为对方平台身份，IdentityBinding记录人物归属依据，Endpoint负责实际路由；Principal授权主体与ChannelConnection连接账号独立，不能从人物印象推导。

技术栈为TypeScript薄领域层＋现有SQLite事务/仓储＋所选渠道原生Directory/SDK；Ombre them条件承载认识，未启用时使用已有记忆与Claim。目录能力逐渠道声明，不预设完整好友表：配置、实时查询、已观察和导入来源分开，partial/limit/失败不触发批量删除。通讯录分组、平台群、组织成员和消息会话分别引用。

用户本人由已认证控制入口确定；联系人卡片和用户确认归属不自动增加控制权限。既有明确发送授权内，识雨可按偏好主动联系；歧义收件人、停联、群受众变化、撤权和unknown投递必须先处理，不能用“熟悉”替代授权。删除分为移除卡片、解绑、停联及清除全部相关信息，采用不同范围回执；恢复和重同步不得复活已删除资料。

## 1. 边界与复用

身份认证事实来自渠道或设备的已验证主体；关系模块保存其内部 entityId 映射。将熟悉、信任、亲近等不确定认识直接变为系统权限，会绕过授权体系，因此首版不设置能授予工具或数据访问的“好感度/信任分”。可明确保存用户给出的关系标签和称呼偏好，但它们是有来源的陈述。

实体与来源的建模参考 W3C PROV 的实体、活动、责任主体及派生关系概念；使用普通 JSON/SQL 字段即可，不要求引入 RDF、知识图谱服务或完整 PROV 序列化。[PROV-DM](<https://www.w3.org/TR/prov-dm/>)

**复用核查后的划分是：身份绑定沿用渠道验证和SQLite唯一约束，对人的认识优先评估Ombre them服务接口，独立关系断言与授权证明保留薄领域层。** them已有Person多名称、revision、继承YouClaim的认识/依据生命周期，不应重新开发第二个人物印象库；但工具明确不描述人际关系，其名称匹配不是已验证账号绑定。Mem0实体候选是文字/类型检索信号，当前spaCy路径依赖英语模型；既不能替代中文同名消歧，也不应照旧Neo4j教程假定OSS仍有graph服务。

初始Ombre记忆验证关闭You/them；关系子项通过可审阅性/身份用例后再开启。接入使用entityId↔person_id稳定映射，core独占调用，replyer只收快照。them `recall`会刷新人物提及、清除改名和纠错待阅，不是纯读取；启用后由内部有写操作管理。若无法满足可审阅与纠正要求，退回有来源Claim，不为规避服务调用直接复制them私有模块，其依赖含you模型/服务、存储、来源、letter及安全规则。来源、许可、具体函数见[复用核查](<../../../../../../research/2026-11-01-复用核查/记忆关系认知.md>)。

## 2. 逻辑实体

身份绑定与显式关系聚合可沿统一state_entities与投影设计；them被启用时，其认识正文留在服务内，本地仅保存映射与依据目录。以下对象是逻辑职责，归core批准，不由渠道适配器直接改写，也不强制服务实现同名数据表。

| 对象 | 关键字段与约束 |
|---|---|
| Entity | `entityId, revision, kind(person/org/project/device/other), displayName, status, sourceRefs`；名称是显示属性，不是身份主键 |
| IdentityBinding | `bindingId, accountId, entityId, basis, verificationRef, assurance, status, validFrom, validTo`；account引用ParticipantAccount，账号唯一键是provider＋identityNamespace＋identityType＋externalSubjectId。个人有效绑定约束和共享账号类别分开，不只按tenant或昵称去重 |
| Alias | `aliasId, entityId, text, locale, scope, sourceRefs, validFrom/To`；显示名、昵称、旧名都保留归属与适用范围 |
| RelationshipAssertion | `assertionId, revision, subjectId, predicate, objectId/value, sourceRefs, dependencyRefs, validFrom/To, epistemicStatus, visibilityScope` |
| IdentityResolutionCandidate | `candidateId, entityIds[], proposedBinding, evidenceRefs, reason, expiry`；不参与正式访问范围计算 |
| EntityMergeRecord | `mergeId, fromIds[], canonicalId, readSet, verificationRefs, previousMapping, committedAt`；可撤销，映射必须无环 |

关系谓词首版采用小型受控词表：成员关系、项目参与、设备拥有者声明、用户定义称呼/关系标签、沟通偏好；新谓词通过 schema 版本变更引入。权限、设备配对撤销与 Mandate 仍由相应权威模块维护；此处仅引用其 ID 和状态，不复制一套授权。

来源中区分 `said_by` 与 `about`：甲说“乙喜欢茶”，说话人是甲，陈述主体是乙，不能变成甲的偏好或乙自己确认的事实。

## 3. 身份解析与合并流程

1. 外层把来源可验证的provider/identityNamespace/identityType/externalSubjectId放入事件，未经验证的来源标明unknown；保存原始ID类型，不把标准化SDK回退后的senderId裸串当全局唯一身份。模型输出的账号字符串不能替换渠道验证身份。
2. 有有效 IdentityBinding 时按唯一键定位；没有时创建独立候选主体或上下文局部实体，不因名称相同自动合并。
3. 规范化只用于搜索：保留原始显示名，语言/大小写规则与原渠道一致。不能随意去掉数字、标点或跨平台大小写规则后当作身份相等。
4. 同一人跨渠道合并，只接受用户明确的同人合并指示或可信平台同一主体映射；由core检查来源及readSet后提交。同一控制者证据仅建立账号控制关联，不能把其控制的组织/共享/服务账号都合成一个自然人；模型“很像同一个人”只生成候选。
5. 正式合并建立 canonical 映射，保留原事件的原始 actor ID；不批量改写历史说话人。事务校验无环、无冲突绑定，并更新相关 ReadView 失效信息。
6. 纠错解除合并时恢复之前的映射版本，对混合后形成的关系/认知记录发出重算任务；在重算完成前按来源隔离并标 contested，不继续导出跨人聚合画像。

合并、解除合并、来源删除都要检查相关聚合 expectedVersion，并在同事务递增 commitSeq/stateVersion，留下非内容最小操作回执。重复相同 mergeId 不再执行；迟到候选重新校验后才可提交。

## 4. 查询与更新接口

| 接口 | 输入 | 输出 / 限制 |
|---|---|---|
| ResolveIdentity | provider/identityNamespace/identityType/verifiedSubjectId 或范围内别名 | resolved / ambiguous / unknown 与 entityRef；ambiguous 不隐式选最高分 |
| ProposeRelationship | 事件、主体引用、受控谓词、sourceRefs | Proposal；不是对关系库直接写入 |
| QueryRelationship | entityId、predicate、atTime、读取范围 | 带来源/时效/认识状态的断言；不包含越范围的全部身份绑定 |
| ProposeEntityMerge / Split | 用户指示或验证证明、候选实体、readSet | 受控变更提案、影响清单、CommitReceipt |
| RevokeRelationEvidence | 被撤回 source/entity/binding 与版本 | 先失效相关视图，再撤回或重算派生断言；清除阶段归 deletion job |

ReadView 按用途裁剪：对话表达可见称呼和获准的沟通偏好；执行器只见任务必需的目标身份；不把原始渠道账号、联系方式或未核实的第三方评价默认放入回复上下文。查询仍返回安全版本与来源新鲜度，不通过查询次数修改关系。

## 5. 关系变化、冲突与生命周期

- 用户对自己的称呼或沟通偏好明确纠正，可形成新有效区间并 supersede 旧断言；这不证明用户关于外部世界的任意说法都正确。
- 两个来源说法不同，记录各自断言及冲突，先比较主体、语境和有效时间；“去年同事”和“现在离职”可以并存，不能误当必须删一条。
- 活跃同名候选默认保留 7 天；没有合法依据就不晋升。正式关系随所引用政策复核，90 天复核不是自动否定关系；已失效身份绑定不得用于访问。
- sourceRefs 按数据全局政策到期时，标 evidence_unavailable；用户明确删除时走 tombstone 和 dependencyRefs 级联，相关称呼、摘要与人格候选也不能借别名继续保留被删内容。
- 设备拥有者声明与真正设备授权不一致时，以设备授权服务为准；关系模块不因此获得配对、执行或撤销能力。

## 6. 故障与恢复

| 风险 | 处理 |
|---|---|
| 两条输入同时登记同一渠道主体 | SQLite 唯一约束决定单一绑定；冲突事务重读，不生成两个正式身份 |
| 渠道服务账号复用 / tenant 变化 | 绑定含来源与有效期；新验证事实可提出解绑与新绑，旧历史仍保留原标识 |
| 合并中途退出 | 映射和受影响范围同事务；提交前失败不生效，提交后按 outbox 继续重算 |
| 错合并 | 可撤销 merge record，恢复来源隔离；禁止只改显示名就声称问题修好 |
| 关系查询遇到 stale 索引 | 回查权威绑定/断言；身份不确定则返回 ambiguous，不能容忍跨人误读 |
| 删除后恢复旧备份 | 恢复阶段先应用最新 tombstone/auth 水位，重建别名与关系投影后才接受查询 |

## 7. 验证与替代门槛

| 用例 | 通过条件 |
|---|---|
| V07：同名、二字名、同一昵称、转发及引用 | fixture 中身份误合并为 0；说话人与陈述主体完全区分 |
| V07：跨渠道绑定和并发登记 | 无验证证明不自动合并；唯一键冲突保持一个有效绑定；重放不新增正式关系 |
| V07：merge → 派生 → split | 能列出受影响记忆/认知，解除后不继续跨主体导出；历史 actor ID 未被改写 |
| V16：删除姓名/绑定/源事件 | 别名检索、关系视图、认知摘要与恢复后读取均不泄漏被删内容 |
| V25：语言歧义评测 | 至少 100 个同名/昵称/代词/跨渠道样本；模糊匹配仅产候选，不得因模型分数绕过验证 |
| V23：规模 | 1 万实体、10 万关系断言、1/2 跳定界查询 P95 ≤200ms（目标，未实测）；查询有 scope、limit 与超时 |

首版只需要邻接与定界查询，SQLite 足够作为验证主方案。仅在真实查询已明确需要多跳分析，且索引优化后上述目标仍不达标，才比较成熟图数据库；迁移的是可重建关系投影，权威身份与版本仍在统一提交协议内。不因“关系”一词预先部署图数据库。

## 8. 来源与实施范围

本轮是设计建议加官方资料核查，没有运行身份服务、关系库或候选。相关限定来源见[记忆关系认知证据](<../../../../../../research/2026-11-01-完整架构/记忆关系认知.md>)；证据链和纠错策略与[认知方案](<../04-认知/README.md>)一致。

