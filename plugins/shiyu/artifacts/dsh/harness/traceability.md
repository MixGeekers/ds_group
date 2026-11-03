# H0 测试工具覆盖追踪报告

生成时间：2026-11-03T23:39:53.038Z；harness 0.1.0；self-proof corpus `h0-selfproof-1`。

> 本清单只证明需求已登记、来源可核验，以及 H0 测试工具在 manifest/selfproof 冻结的文件身份下完成自证。产品 V01–V27、九个系统与 S/FL 场景均未由 H0 运行或验收；not_covered 不得被读作通过，历史有限证据不计入状态。

## 1. 汇总与证据层

| 层级 | 计数 | 说明 |
| --- | --- | --- |
| 总需求行 | 103 | 需求→来源→代码路径→测试/ oracle→证据→状态 |
| 产品需求行 | 79 | 全部 not_covered=79（H0 未运行产品验证） |
| H0 能力行 | 24 | self_proven=13，partial=8，not_covered=3 |
| oracle | 15/15 | 自证 artifact 中 oracle:<name> 测试通过的个数 |
| 来源文档 | 4/4 | 标题/表格行引用逐项核验 |

状态图例：`未覆盖` 不得读作通过；`工具就绪（场景未运行）` 表示 H0 判定器已自证但产品场景未运行；`H0 自证通过` 仅指测试工具自身在冻结文件身份下验真。

**H0b 交接规则（机器可读字段 `handoff`）**：H0b 之后产品行由后续切片按其实际证据更新；禁止后续切片复用 H0 的 tooling_ready 冒充产品通过。产品行状态只能来自该切片的独立运行证据（manifest/selfproof/traceability + 独立效果账本 + 宿主/业务证据）；H0 的 not_covered 保持不变直到该切片实际运行。
明确禁止：`把 tooling_ready 写成产品通过`；`用 H0 的 oracle 自证替代产品运行证据`；`用历史有限证据（phase3h/3i 等）覆盖 not_covered`；`在 WIP 未提交时把共享树结果写成切片证据`。

## 2. 冻结产物（memory of evidence）

| 产物 | 存在 | SHA256 | 生成时间 | 说明 |
| --- | --- | --- | --- | --- |
| selfproof | true | c6f27d1420e74940c5e17040167049803032e4e64875bac078eb3d38ef9719c8 | 2026-11-03T23:39:31.687Z | self-proof passed |
| manifest | true | 69b70cea51ab1359a5aad2dae24b62f0db4b9a679d02546d31f11bc127d50720 | 2026-11-03T23:07:03.740Z | manifest files match the current tree |

## 3. H0 工具能力（可 self_proven 的唯一一类）

| ID | 状态 | 能力 | 测试通过/要求 | oracle 通过 | 证据 | 依据/缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| H0.ORACLE | H0 自证通过 | 判定器套件：无损 JSON/结构/CAS/状态机/计数/因… | 3/3 | 10/10 | artifacts/dsh/harness/tool-selfproof.json@c6f27d1420e74940c5e17040167049803032e4e64875bac078eb3d38ef9719c8 | self-proof artifact + manifest verified: tests 3/3, oracles… |
| H0.SELFCHECK | H0 自证通过 | 工具验真执行器：真实运行全部 known-pass/kno… | 5/5 | 0/0 | artifacts/dsh/harness/tool-selfproof.json@c6f27d1420e74940c5e17040167049803032e4e64875bac078eb3d38ef9719c8 | self-proof artifact + manifest verified: tests 5/5, oracles… |
| H0.FAULTS | H0 自证通过 | 驱动/时钟/故障控制：绝对期限、假业务时钟、确定性断点 | 6/6 | 3/3 | artifacts/dsh/harness/tool-selfproof.json@c6f27d1420e74940c5e17040167049803032e4e64875bac078eb3d38ef9719c8 | self-proof artifact + manifest verified: tests 6/6, oracles… |
| H0.OBSERVER | H0 自证通过 | 独立观察器与效果账本：崩溃后可取证的 append-onl… | 4/4 | 2/2 | artifacts/dsh/harness/tool-selfproof.json@c6f27d1420e74940c5e17040167049803032e4e64875bac078eb3d38ef9719c8 | self-proof artifact + manifest verified: tests 4/4, oracles… |
| H0.MANIFEST | H0 自证通过 | manifest/证据包：源码/构建/环境/fixture… | 4/4 | 0/0 | artifacts/dsh/harness/tool-selfproof.json@c6f27d1420e74940c5e17040167049803032e4e64875bac078eb3d38ef9719c8 | self-proof artifact + manifest verified: tests 4/4, oracles… |
| H0.TRACEABILITY | H0 自证通过 | 覆盖追踪：需求→代码→测试ID→oracle→证据→状态/… | 4/4 | 0/0 | artifacts/dsh/harness/tool-selfproof.json@c6f27d1420e74940c5e17040167049803032e4e64875bac078eb3d38ef9719c8 | self-proof artifact + manifest verified: tests 4/4, oracles… |
| H0.DOCS | H0 自证通过 | 使用说明：运行、接入后续切片、证据复核方法 | 1/1 | 0/0 | artifacts/dsh/harness/tool-selfproof.json@c6f27d1420e74940c5e17040167049803032e4e64875bac078eb3d38ef9719c8 | self-proof artifact + manifest verified: tests 1/1, oracles… |

## 4. 02 §1 必须资产（H0 范围与缺口）

| ID | 状态 | 资产 | 依据/缺口 |
| --- | --- | --- | --- |
| ASSET.1 | H0 自证通过 | 用例与覆盖清单 | self-proof artifact + manifest verified: tests 3/3, oracles 0/0, artifacts 1/1 |
| ASSET.2 | 未覆盖 | 合成 fixture 与独立答案集 | H0 未交付/未运行该能力 |
| ASSET.3 | H0 自证通过 | 驱动、时钟与故障控制 | self-proof artifact + manifest verified: tests 3/3, oracles 0/0, artifacts 1/1 |
| ASSET.4 | H0 自证通过 | 独立观察器与效果账本 | self-proof artifact + manifest verified: tests 3/3, oracles 0/0, artifacts 1/1 |
| ASSET.5 | H0 自证通过 | 判定器与工具验真集合 | self-proof artifact + manifest verified: tests 2/2, oracles 0/0, artifacts 1/1 |
| ASSET.6 | 未覆盖 | 固定宿主适配与恢复驱动 | H0 未交付/未运行该能力 |
| ASSET.7 | H0 自证通过 | 报告与证据包 | self-proof artifact + manifest verified: tests 2/2, oracles 0/0, artifacts 2/2 |
| ASSET.8 | H0 自证通过 | 使用说明与复核方法 | self-proof artifact + manifest verified: tests 1/1, oracles 0/0, artifacts 1/1 |

## 5. 工具验真样本（02 §3.2；oracle 就绪 ≠ 场景已运行）

| ID | 状态 | 样本要求 | 相关 oracle | 边界 |
| --- | --- | --- | --- | --- |
| TV.1 | 工具就绪（场景未运行） | 重复事件/同键异内容/跨来源同外部 ID 的独立计数与冲突拒绝 | counts✓, causal✓, cas✓ | 不能只按输入行数或产品 processed 计数 |
| TV.2 | 工具就绪（场景未运行） | 接收端执行一次后丢回执，产品保持 unknown | causal✓, observer-ledger✓, observer-counter✓ | 不能把无响应判为未执行 |
| TV.3 | 工具就绪（场景未运行） | 第二次实际发送/旧 fence 覆盖/跨受众 canary 必须触发失败 | causal✓, version✓, canary✓, authority✓ | 任一已知错误被判通过即失败 |
| TV.4 | 工具就绪（场景未运行） | 缺失/截断 trace、重复序号、非法 schema、错 runId、无法关联 recei… | observer-ledger✓, json-text✓, schema✓, causal✓ | 不得默默跳过坏记录 |
| TV.5 | 工具就绪（场景未运行） | 假模型 3 次调用中 1 次用量缺失、1 次压缩、1 次重试 | counts✓ | 不能只统计最终回答、缺失填 0 |
| TV.6 | 工具就绪（场景未运行） | 驱动计划 100 条仅注入 90 条其中 10 条延迟 | counts✓ | 不能以 90/90 宣称完成 100 条 |
| TV.7 | 工具就绪（场景未运行） | 已删除 canary 混入摘要/历史/导出，未删除同类词负对照 | canary✓ | 只搜最终回复或扫描器静默未运行均失败 |
| TV.8 | 未覆盖 | 正确/明确错误/允许澄清或等待的歧义结果判定 | （无确定性 oracle） | Judge 任意文字不得当成功；policy_pending 保留 |
| TV.9 | 工具就绪（场景未运行） | 观察器/判定器自身中断，产品继续产生效果 | observer-ledger✓, causal✓, counts✓ | 监控死亡期间继续累加成功即失败 |

## 6. oracle 目录（每个都有 known-pass 与 known-fail 自证）

| oracle | 版本 | 模块 | 样本 | 场景 | 自证 |
| --- | --- | --- | --- | --- | --- |
| lossless-json | 1.1.0 | tests/harness/json.ts | 18 | 0 | 通过 |
| json-text | 1.1.0 | tests/harness/json.ts | 8 | 0 | 通过 |
| schema | 1.1.0 | tests/harness/schema.ts | 14 | 0 | 通过 |
| cas | 1.1.0 | tests/harness/cas.ts | 10 | 0 | 通过 |
| state-machine | 1.1.0 | tests/harness/state-machine.ts | 10 | 0 | 通过 |
| counts | 1.1.0 | tests/harness/counts.ts | 17 | 0 | 通过 |
| causal | 1.1.0 | tests/harness/causal.ts | 18 | 0 | 通过 |
| version | 1.1.0 | tests/harness/version-domains.ts | 12 | 0 | 通过 |
| authority | 1.1.0 | tests/harness/authority.ts | 10 | 0 | 通过 |
| canary | 1.1.0 | tests/harness/authority.ts | 5 | 0 | 通过 |
| deadline | 1.1.0 | tests/harness/faults.ts | 4 | 3 | 通过 |
| business-clock | 1.1.0 | tests/harness/faults.ts | 0 | 5 | 通过 |
| fault-injection | 1.1.0 | tests/harness/faults.ts | 0 | 3 | 通过 |
| observer-ledger | 1.1.0 | tests/harness/observer.ts | 0 | 5 | 通过 |
| observer-counter | 1.1.0 | tests/harness/observer.ts | 3 | 0 | 通过 |

> **oracle corpus 范围**：本表覆盖 H0b corpus（15 个）；H0c business oracles 另有 7 个（`business-oracle:*`），合计 22 个，均记录在 tool-selfproof.json。traceability.json#oracles 覆盖 H0b corpus（ALL_SELF_PROOFS）；H0c business oracles 另见 tool-selfproof.json 的 business-oracle:* 测试。两者合计才是当前工具自证 oracle 总数，不是缺少 7 个 oracle。

## 7.1 九系统（01）

| ID | 关联 | 标题/要求 | 状态 | 来源 |
| --- | --- | --- | --- | --- |
| SYS.1 | V02, V03, V04, V05, V13, V23, V24, V25, S02, S04, FL01, FL02, FL03, FL04, FL05 | 接入、对话与话题协作 | 未覆盖 | doc-01 ## 2. 系统 1 |
| SYS.2 | V03, V04, V10, V12, V14, V21, V23, V24, S03, S08, FL07, FL08 | Agent 与组件共用事件系统 | 未覆盖 | doc-01 ## 3. 系统 2 |
| SYS.3 | V02, V06, V09, V10, V13, V23, V24, V25, S03, S04, S08, FL01, FL04, FL08 | core 判断与持续规划 | 未覆盖 | doc-01 ## 4. 系统 3 |
| SYS.4 | V10, V11, V12, V18, V19, V20, V21, V22, V23, V24, V26, S04, S05, FL07 | 目标、任务、worker 与外部效果 | 未覆盖 | doc-01 ## 5. 系统 4 |
| SYS.5 | V06, V07, V08, V09, V16, V23, V24, V25, S01, S02, S06, S07, FL02, FL05 | 六部分内层与只读视图 | 未覆盖 | doc-01 ## 6. 系统 5 |
| SYS.6 | V04, V13, V14, V24, V25, S04, S05, S08, FL03, FL06, FL07 | 模型、Session、上下文与缓存 | 未覆盖 | doc-01 ## 7. 系统 6 |
| SYS.7 | V02, V04, V10, V13, V16, V17, V18, V19, V20, V24, V26, S02, S05, S08, FL05, FL06 | 身份、授权、预算与控制 | 未覆盖 | doc-01 ## 8. 系统 7 |
| SYS.8 | V01, V06, V12, V14, V15, V16, V17, V19, V21, V22, V23, V24, V27, S05, S06, S08, FL07, FL08 | 数据、生命周期、恢复与备份 | 未覆盖 | doc-01 ## 9. 系统 8 |
| SYS.9 | V04, V05, V09, V13, V14, V23, V24 | 运行仪表盘 | 未覆盖 | doc-01 ## 10. 系统 9 |

## 7.2 02 §5 验收矩阵

| ID | 关联 | 标题/要求 | 状态 | 来源 |
| --- | --- | --- | --- | --- |
| MATRIX.1 | V02, V03, V04, V05, V13, V23, V24, V25 | 系统1 验收矩阵：身份/会话/草稿失效/渠道事件 | 未覆盖 | doc-02 ## 5. 九大系统验收矩阵 |
| MATRIX.2 | V03, V04, V10, V12, V14, V21, V23, V24 | 系统2 验收矩阵：重复/乱序/一次性等待/背景零模型 | 未覆盖 | doc-02 ## 5. 九大系统验收矩阵 |
| MATRIX.3 | V02, V06, V09, V10, V13, V23, V24, V25 | 系统3 验收矩阵：事实变化/无变化/预算耗尽 | 未覆盖 | doc-02 ## 5. 九大系统验收矩阵 |
| MATRIX.4 | V10, V11, V12, V18, V19, V20, V21, V22, V23, V24, V26 | 系统4 验收矩阵：租约/取消/迟到/写后丢回执 | 未覆盖 | doc-02 ## 5. 九大系统验收矩阵 |
| MATRIX.5 | V06, V07, V08, V09, V16, V23, V24, V25 | 系统5 验收矩阵：六域正反例与删除复活 0 | 未覆盖 | doc-02 ## 5. 九大系统验收矩阵 |
| MATRIX.6 | V04, V13, V14, V24, V25 | 系统6 验收矩阵：历史/分页/压缩/注入/usage 缺失 | 未覆盖 | doc-02 ## 5. 九大系统验收矩阵 |
| MATRIX.7 | V02, V04, V10, V13, V16, V17, V18, V19, V20, V24, V26 | 系统7 验收矩阵：接纳/排队/生成/派发前撤权 | 未覆盖 | doc-02 ## 5. 九大系统验收矩阵 |
| MATRIX.8 | V01, V06, V12, V14, V15, V16, V17, V19, V21, V22, V23, V24, V27 | 系统8 验收矩阵：CAS/写偏斜/单writer/满盘/迁移/恢复 | 未覆盖 | doc-02 ## 5. 九大系统验收矩阵 |
| MATRIX.9 | V04, V05, V09, V13, V14, V23, V24 | 系统9 验收矩阵：仪表盘真实状态/只读/秘密 | 未覆盖 | doc-02 ## 5. 九大系统验收矩阵 |

## 7.3 V01–V27（原文门槛保留）

| ID | 门槛（摘） | 标题/要求 | 状态 | 来源 |
| --- | --- | --- | --- | --- |
| V01 | 40/40 模块；实际 SQLite 构建能力；关键契约冲突已处理 | 契约覆盖、版本和事务能力门槛 | 未覆盖 | doc-v ### V01 |
| V02 | 40 身份/控制组合；同名误合并=0；正文伪造授权=0；原生 Goal 与本地绑定分别核对 | 输入、主体、目标与可信控制来源 | 未覆盖 | doc-v ### V02 |
| V03 | 100 唯一事件×10 重送；20 乱序种子；同键异内容拒绝；接纳/处理/提交分开 | 事件重放、乱序和接收回执 | 未覆盖 | doc-v ### V03 |
| V04 | ≥30 越权路径零成功；1000 次读取纯度；工具创建/恢复/执行检查 | 外层只读、注册准入与执行授权 | 未覆盖 | doc-v ### V04 |
| V05 | 20 会话/1000 消息/20 种子；接纳 p95≤500ms；停止失效 p95≤1s；旧回复发送=0 | 对话队列、过时回复与发送状态 | 未覆盖 | doc-v ### V05 |
| V06 | 100 提案竞争恰 1 成功；100 独立聚合可分别提交；适用断点×20 | core 提案、readSet/CAS 与领域原子提交 | 未覆盖 | doc-v ### V06 |
| V07 | 40 oracle 全匹配；10,000 记录 / ≥200 查询；本地 p95≤200ms；真实后端与检索语义另报 | 记忆、关系与认知的证据语义 | 未覆盖 | doc-v ### V07 |
| V08 | 100 轮无合法变更不漂移；1000 读取不写；来源/回顾/删除可归因 | 情绪记忆、自我认识与人格稳定性 | 未覆盖 | doc-v ### V08 |
| V09 | ≥24 能力组合；声明/健康/验证分开；过期/撤销/错环境阻止新效果 | 能力声明、实际可用与技能变更 | 未覆盖 | doc-v ### V09 |
| V10 | ≥32 授权/预算/暂停组合；无越界动作；派发前复查；暂停跨重启 | Mandate、预算、暂停和撤权 | 未覆盖 | doc-v ### V10 |
| V11 | 50 worker 竞争最多一个有效资格；各竞态×20 零旧结果覆盖；unknown 不降为可重派 | 任务、Assignment、租约与迟到结果 | 未覆盖 | doc-v ### V11 |
| V12 | 适用断点×20；幂等每 effect 至多一次；非幂等 unknown 自动重放=0 | 事务 outbox、跨服务未知结果与回执 | 未覆盖 | doc-v ### V12 |
| V13 | ≥80 边界输入零未允许动作；fallback 不扩权；用量缺失不记零 | 模型/工具数据注入、路由与外发控制 | 未覆盖 | doc-v ### V13 |
| V14 | 20 次装载/卸载；一份订阅/定时器；drain≤4s | DSH 接口替身、事件定时与生命周期 | 未覆盖 | doc-v ### V14 |
| V15 | 12 适用断点×20；单 writer/唯一有效根；锁等待不阻塞停止 | 数据空间、磁盘满、写锁与迁移 | 未覆盖 | doc-v ### V15 |
| V16 | 20 主体/事实；7/30/90/180 天边界；最新删除水位无法证明则恢复锁 | 保留、删除、派生传播与恢复防复活 | 未覆盖 | doc-v ### V16 |
| V17 | 20 异常分支；明文 canary=0；不可解析凭据=不可用 | 凭据引用、轮换与诊断脱敏 | 未覆盖 | doc-v ### V17 |
| V18 | 100 同路径访问；≥30 授权组合；direct/gated 分别证明 | 设备配对、能力版本与资源身份 | 未覆盖 | doc-v ### V18 |
| V19 | 适用断点×20；5 类异常各 100；unknown 不自动重放/改派 | 掉线、取消、撤权与重新接入 | 未覆盖 | doc-v ### V19 |
| V20 | 网页 20 场景/机器人协议 10 类；重复 effect 100 次最多一个活动 goal | 平台能力差异与机器人本地停止 | 未覆盖 | doc-v ### V20 |
| V21 | paused/stopped 自动拉起=0；≥20 次恢复 ready≤120s；恢复先核对 | 暂停、进程退出与宿主外恢复 | 未覆盖 | doc-v ### V21 |
| V22 | 20 故障场景组件可核验；1GiB/1000 Task/100 unknown；RTO≤30min；unknown 保持 | 一致检查点、备份与合成恢复 | 未覆盖 | doc-v ### V22 |
| V23 | E1/E2/E3 各 20 种子；40 模块主断言有证据；全因果链可追 | 合成端到端与最终观察一致性 | 未覆盖 | doc-v ### V23 |
| V24 | 实际版本/API/持久事实；20 生命周期；drain≤4s；零读副作用 | 固定 DSH、实际 SQLite 与 profile 适配 | 未覆盖 | doc-v ### V24 |
| V25 | ≥300 段对话/120 保存候选/200 检索问句/≥80 注入；3 轮或如实报告截断；保存 P≥.95/R≥.80，Recall@10… | 真实模型的有界语义评测 | 未覆盖 | doc-v ### V25 |
| V26 | 明确设备/动作/测试根；20 同任务请求；多设备结论需≥2 实际设备 | 获准真实设备的能力切片 | 未覆盖 | doc-v ### V26 |
| V27 | 实际目的地/故障域可证明；1GiB 基准 capture age≤15min；RTO≤30min；3 次独立恢复 | 独立故障域备份与恢复演练 | 未覆盖 | doc-v ### V27 |

## 7.4 S01–S08 业务场景

| ID | V 关联 | 标题/要求 | 状态 | 来源 |
| --- | --- | --- | --- | --- |
| S01 | V03, V04, V07, V08, V25 | 记忆与纠正 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| S02 | V02, V04, V05, V07, V16 | 身份与群隐私 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| S03 | V02, V03, V10, V12, V14, V23 | 订阅与主动任务 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| S04 | V04, V05, V10, V11, V23 | 聊天与任务 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| S05 | V10, V11, V12, V21, V23 | 未知效果与恢复 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| S06 | V07, V16, V21, V22, V23 | 删除与旧备份 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| S07 | V04, V07, V08, V25 | 情绪与人格 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| S08 | V03, V10, V13, V14, V21 | 时间与预算 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |

## 7.5 FL01–FL08 信息流场景

| ID | V 关联 | 标题/要求 | 状态 | 来源 |
| --- | --- | --- | --- | --- |
| FL01 | V05, V07, V25 | 业务藏在闲聊中 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| FL02 | V07, V25 | 语境改变答案 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| FL03 | V03, V05, V10 | 刷屏与纠正 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| FL04 | V05, V10, V23 | 单源洪峰 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| FL05 | V02, V04, V10, V13 | 多人跨供应商 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| FL06 | V09, V13, V25 | 不确定与附件 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| FL07 | V03, V12, V21 | 重放与恢复 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| FL08 | V10, V14, V23 | 订阅与长期业务 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |

## 7.6 H1–H8 判分维度

| ID | 关联 | 标题/要求 | 状态 | 来源 |
| --- | --- | --- | --- | --- |
| H.H1 |  | H1 判分维度：授权 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| H.H2 |  | H2 判分维度：身份/受众 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| H.H3 |  | H3 判分维度：效果与 unknown | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| H.H4 |  | H4 判分维度：停止/旧资格 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| H.H5 |  | H5 判分维度：删除 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| H.H6 |  | H6 判分维度：时间/订阅/预算 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| H.H7 |  | H7 判分维度：证据语义 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |
| H.H8 |  | H8 判分维度：人格与读取纯度 | 未覆盖 | doc-02 ## 8. S / FL 业务集合保留与补全 |

## 7.7 02 §6 组合/长期/故障场景

| ID | 关联 | 标题/要求 | 状态 | 来源 |
| --- | --- | --- | --- | --- |
| COMBO.CHAN |  | 02 §6.1 多频道持续输入与公平 | 未覆盖 | doc-02 ### 6.1 |
| COMBO.EVENT |  | 02 §6.2 事件、订阅与零模型背景加载 | 未覆盖 | doc-02 ### 6.2 |
| COMBO.CORE |  | 02 §6.3 core、worker 与完成核验 | 未覆盖 | doc-02 ### 6.3 |
| COMBO.UNKNOWN |  | 02 §6.4 unknown、取消、暂停与回执查询 | 未覆盖 | doc-02 ### 6.4 |
| COMBO.DELETE |  | 02 §6.5 撤回、删除、身份拆分与上下文失效 | 未覆盖 | doc-02 ### 6.5 |
| COMBO.HISTORY |  | 02 §6.6 原生长历史、冷恢复与压缩 | 未覆盖 | doc-02 ### 6.6 |
| COMBO.USAGE |  | 02 §6.7 缓存、模型用量与预算 oracle | 未覆盖 | doc-02 ### 6.7 |
| COMBO.INNER |  | 02 §6.8 内层六域、能力与仪表盘 | 未覆盖 | doc-02 ### 6.8 |
| COMBO.LONGRUN |  | 02 §6.9 检查点、迁移、长期运行与恢复 | 未覆盖 | doc-02 ### 6.9 |
| COMBO.E2E |  | 02 §6.10 三条端到端链不得省略 | 未覆盖 | doc-02 ### 6.10 |

## 8. H7 证据层映射（产品行仍 not_covered，只读派生）

> frozen HEAD `fc4b94740e56f4f1d182b287b50cc29e5c315f18`；证据来源 100 个（verified=100，unknown=0），产品行映射 41 行。已提交切片证据层只表示该切片实际跑过的层级（离线模块/独立验证/固定宿主零模型/合成 UI/历史限定等）；产品行状态仍全部 not_covered，不能用于业务验收或 V/S/FL 通过声明。

| 系统 | 状态 | 证据层 | 部分子场景 | 限定/缺口 |
| --- | --- | --- | --- | --- |
| SYS.1 | not_covered | offline-module, slice-verification, synthetic-ui, historical-limited, bounded-real-model, fixed-host-zero-model | two-channel text loop (historical, 3 messages)；channel ingress identity/dedup offline；replyer inner-reference composition offline | No real platform adapter, sending Effect, native draft delivery or multi-channel conversation business loop on current HEAD.；H6c UI runs Chromium against a synthetic host page only: no real DSH client DOM/injection, no live projection or business acceptance.；Historical Lab loop is three text messages; not V05/V23/V25 or S/FL acceptance.；真实平台/账号/发送 Effect/多频道业务闭环未运行；多频道公平/过期草稿/送达未知未验 |
| SYS.2 | not_covered | offline-module, slice-verification, fixed-host-zero-model, bounded-real-model-diagnostic-only | four publish/subscribe path module tests；zero-model restricted worker tool surface probe | No model actually invoked an event tool; real core Goal continuation, declarative-condition tools, platform redelivery and quotas/fanout remain untested.；H2b is G1/G2 offline with synthetic clock/observation/Effect doubles; no DSH schedule/IANA tz database and no monetary/model cost bounding.；Round-5 fixed-host host evidence is zero-model + bounded-real-model-diagnostic-only: the diagnostic tool round passed with reported usage 1469/41/2406 (attempts 4/5 = 1 request/0 stream/cost unknown), but this is NOT V25, full core/Goal or business acceptance and never pass.；模型实际调用事件工具、core Goal 续接、时间/外部触发、配额/fanout/防环未验 |
| SYS.3 | not_covered | offline-module, slice-verification, historical-limited, bounded-real-model, fixed-host-zero-model, bounded-real-model-diagnostic-only, fixed-host-failure-diagnostic, fixed-host-zero-model-reconcile, fixed-host-create-succeeded-evaluation-failure | offline plan candidate validation/CAS/replan；historical bounded owner local-note closure | The round-5 bounded real-model diagnostic tool round passed (2 requests/2 streams/1 read-only tool round; reported usage 1469/41/2406, attempts 4/5 = 1 request/0 stream/cost unknown) but it is diagnostic-only: not a full core decision/Goal/plan/Task, not V25 and not business acceptance.；Earlier H2c host attempts failed and were not retried; diagnostic pass can never be counted as product/module pass.；Round-7 bounded real core Goal host attempt FAILED at create with GOAL_OPERATION_UNKNOWN: 0 model requests, no retry, no Task/worker/verification/native completion; an unauthorized/paused Goal + Session partial side effect exists; this failure evidence can never be V25/business/nine-system pass.；真实宿主/原生 Goal 下的开放式多步规划、模型 plan JSON、费用/缓存未验 |
| SYS.4 | not_covered | historical-limited, bounded-real-model, fixed-host-zero-model, offline-module, slice-verification, independent-verification | historical single local task with independent artifact/effect check；offline plan→Task admission | Historical one-task samples and G1 modules only; no current-HEAD concurrent worker/lease/cancel/late-result matrix or cross-assignment fencing.；Independent review only checked evidence authenticity, not product behaviour.；当前 HEAD 并发 worker/租约/取消/迟到结果矩阵、跨 Assignment fencing、真实设备未验 |
| SYS.5 | not_covered | offline-module, slice-verification, fixed-host-zero-model, synthetic-ui, historical-limited, bounded-real-model, independent-verification | schema4 six-domain publication on fixed host (zero model)；inner ReadView/UI synthetic composition；bounded inner prompt block offline | No real model use of inner state, no real inner bodies/Ombre content, no real browser DOM against real data.；H4e recompute is same-DB bounded deterministic scan; logical retention only (no automatic expiry/physical erase/backup deletion propagation); migration hotfix is offline regression plus separate zero-model host recovery.；Round-6 host inner-lifecycle probe is diagnostic-only with an isolated :memory: ControlStore and skips the memory backend; status-final diagnostics-cache passed is NOT live memory/business/nine-system acceptance.；真实模型使用内层状态、真实后端正文、跨域重算、真实 UI DOM 未验 |
| SYS.6 | not_covered | offline-module, slice-verification, independent-verification, historical-limited, bounded-real-model, fixed-host-zero-model | bounded paged recovery + independent offline oracle；historical two-turn real-model Session reuse | No fixed-host long-history cold recovery/compaction under current HEAD, no real generation/usage/cache measurement, no full provider fees.；Independent verifier is offline; historical real-model samples are earlier builds and very small.；当前 HEAD 长历史冷恢复/压缩、真实生成、缓存/费用、完整 provider 请求未验 |
| SYS.7 | not_covered | offline-module, slice-verification, historical-limited, bounded-real-model, fixed-host-zero-model | offline identity/audience ingress foundation；historical fixed-capability enable/disable persistence | No current-HEAD full Mandate/budget/pause/revoke matrix, no real channel credentials/receipts, no security canary sweep of model inputs or real device fences.；Historical policy/budget samples cannot be reused as V10/V17/V18–V20 acceptance.；当前 HEAD Mandate/预算/暂停/撤权矩阵、真实凭据与 canary 扫描、设备 fencing 未验 |
| SYS.8 | not_covered | offline-module, slice-verification, fixed-host-zero-model, fixed-host-failure-diagnostic, fixed-host-zero-model-reconcile, fixed-host-create-succeeded-evaluation-failure, independent-verification | G1 backup bundle capture/verify + isolated-root disarmed restore | G1 modules/composition/probe only: H5b production capture remains blocked (CHECKPOINT_STAGING_UNCONFIGURED, GOAL_SESSION_EXPORT_UNAVAILABLE, MEMORY_EXPORT_UNAVAILABLE, trusted staging/manifest missing); the host checkpoint probe returns ready:false and writes no files.；Round-3/4 host evidence is zero-model only; the bounded real-model attempt failed before any model request; no real Ombre export/erasure, independent fault domain/V27, RPO/RTO or OS power loss.；Round-6 inner-lifecycle host probe is diagnostics-only (in-memory, skips memory backend); it does not prove live persistence/checkpoint readiness or V15/V21/V22/V24/V27 acceptance.；仅 G1 模块：未接 Runtime、无真实 Goal 日志/Ombre 导出/独立故障域/RPO-RTO/断电 |
| SYS.9 | not_covered | offline-module, synthetic-ui, slice-verification, fixed-host-zero-model, bounded-real-model-diagnostic-only, fixed-host-failure-diagnostic, fixed-host-zero-model-reconcile, fixed-host-create-succeeded-evaluation-failure, environment-baseline | synthetic-host six-domain panel UI cases；fixed-host zero-model status/read-only visibility | No real DSH client DOM/injection or production browser bundle: H4b/H6c use synthetic host pages, fixtures and synthetic bindings/connections.；No real user interactions beyond read-only status/tool calls; no UI lifecycle/long-list/old-response matrix; round-3/4 host projection remains zero-model.；Round-4 host had only a failed bounded real-model attempt; round-5 adds a diagnostic real-model tool round; round-6 adds an isolated inner-lifecycle diagnostic (59072-byte status-final proves only diagnostics-cache passed); round-7 adds a FAILED bounded core Goal attempt (GOAL_OPERATION_UNKNOWN, 0 model requests, partial unauthorized/paused Goal+Session); round-8 reconcile cancelled the residual Goal (58,375-byte status-final proves reconcile cache only). Round-11 adds a 61122-byte final status that caches the generalized v1/v2 reconcile receipt (v1 cancelled/no action, v2 inert exactly one cancel to version 2, 0 model/0 retries/0 creations, +1 commitSeq). round-12 adds a 69,295-byte final status caching BOTH the failed v3 create receipt (header-hash mismatch, 0 model requests, partial v3 Goal+Session) and the generalized cleanup reconcile receipt (v1/v2 no action, v3 inert exactly one cancel to version 2, only +1 commitSeq) — diagnostics caches, not dashboard/render or V05/V24 acceptance. Round-13 adds a 60,692-byte final status caching the zero-model header-cut probe receipt (matched=false, headerDiff delegationDepth: number:0→absent, one bare Session archived, 0 model/Goal/Task/Effect/business writes) — a diagnostics cache, not dashboard/render or V05/V24 acceptance. Round-14 adds a 65,594-byte final status caching the failed v4 receipt (create succeeded but evaluation unknown, 0 model requests, reason masked owner_paused, unknown budget 3→4 held 16384/2) — a diagnostics cache, not dashboard/render or V05/V24 acceptance. Round-15 adds a 67,986-byte final status caching the failed v5 receipt including preStopEvaluation (create succeeded again, evaluation unknown with CORE_NATIVE_CONTEXT_REJECTED, 0 model requests, v4/v5 unknown reservations held 16384/2) — a diagnostics cache, not dashboard/render or V05/V24 acceptance. Round-16 adds a 70,221-byte final status caching the failed v6 receipt including preStopEvaluation (create succeeded a third time, FIRST real model request with request/header+context and three read-only event tools, empty provider stream, CORE_EXECUTION_UNCONFIRMED preserved, evaluateAttempts=1, 0 usage, v4/v5/v6 unknown reservations held 16384/2) — a diagnostics cache, not dashboard/render or V05/V24 acceptance. Round-17 adds a 68173-byte final status caching the P0 memory readiness/embedding verification (readinessBefore exact_read/EMBEDDING_UNVERIFIED → readinessAfter exact_read+semantic_search/embeddingVerified with INDEX_COVERAGE_INCOMPLETE; 1+1 real embedding calls, 1 semantic match, post-withdraw rejection, +10 commitSeq) and the joint zero-model emotion/memory probe status after one ordered reload (15/15 in-memory checks, liveDataTouched=false, +10 commitSeq 563→573) — diagnostics caches only, not dashboard/render, live chat recall or V05/V24 acceptance. Real browser DOM, sensitive-value sweep and V05/V24 dashboard acceptance remain untested.；真实浏览器 DOM、真实数据、只读刷新 1000 次/old-response 矩阵、敏感值扫描未验 |

完整逐系统“证据→状态→缺口”与来源明细见 `h7-traceability-mapping.md`；V/S/FL 有限映射只列证据层，状态仍 not_covered。

## 9. 来源可核验性

| 文档 | 存在 | SHA256 | 被引行核验 |
| --- | --- | --- | --- |
| 架构与设计/DSH交接/01-九系统剩余目标与边界.md | true | 2fc2e013a7761c2d3b70d030601eddf3aa22960b4c4c9585662b2692f1bbdcf9 | 9 |
| 架构与设计/DSH交接/02-测试设计与验收标准.md | true | 16dd47f6cf41d763d88debc8a73b7c236bf3c73fc7eacae0f8dcdd95ddb6ae59 | 67 |
| 架构与设计/九大系统实施与验证计划.md | true | 8ce297b0b7336cc643498527658f0af89fecd267df936d9d5c42ffcbf634bad6 | 0 |
| 架构与设计/A方案全景/验证与验收.md | true | 5bed69766713b897a38c41a7d5e7cd08526ef849cf374f4538de655ecce4a9cb | 27 |

九系统计划 §5 的 V01–V27 索引核验：通过。

## 10. 历史有限证据（单独列出，不计入任何状态）

| 证据 | 存在 | SHA256 | 范围（历史，限定） | 关联 |
| --- | --- | --- | --- | --- |
| plugins/shiyu/artifacts/phase3i-capability-offline.json | true | e5e2c3fb39b479f6780d8bd1d476e641cf144fcb08b5bd2812b1fcd3e2b93a60 | 3I 离线基线 1021 项模块/204 UI（历史） | V04,V09 |
| plugins/shiyu/artifacts/phase3i-capability-host-zero-model.json | true | d84eeec1352b4adce42385c920131b6428ea1e3b8ea46bbbe2fd658cc10dd915 | 3I 固定宿主零模型重载（历史，限定） | V14,V24 |
| plugins/shiyu/artifacts/phase3h-c-lab-host-validation.json | true | 5b88033e5c5d7bc53b7306ef1f60ec47dd38ab5ed9f42c8abed870c3afe7fd46 | 3H-C 双频道限定文本闭环（历史，限定） | V05,V23,V24 |
| plugins/shiyu/artifacts/phase3g-core-host-success.json | true | bafe7c6be8a363250209d361c2aff91927ebed81b6c36fdcdf5b982f5c3fb100 | 3G-B owner local-note 限定闭环（历史，限定） | V10,V23 |
| plugins/shiyu/artifacts/task-validation.json | true | 9043e1bc22168cbc4d8097e0de0ed82a9a362ebe6b4bc4e2dfd39bcfe491fe0d | 受限本地任务与预算结算（历史，限定） | V10,V12 |
| plugins/shiyu/artifacts/goal-validation.json | true | bda0d0de152cdd8a10df4d11a7390c8ac629e214dbea7972c28a7d3c7755b385 | 原生 Goal 零推理生命周期（历史，限定） | V14 |
| plugins/shiyu/artifacts/context-validation.json | true | 79043e2212021ab7e07d295dd0b9e9d643886a8e21e665cb1d959e3e6afcb423 | 受限上下文与同 Session 回复（历史，限定） | V24,V25 |
| plugins/shiyu/实施记录.md | true | 1f529ec438c357c062e356c251bdca3c5addca323db0924e7a680108196eeab9 | 本体实施记录与失败保留（历史） | — |

## 11. 未覆盖与下一步

- 产品需求 79 项全部未覆盖（H0 范围外）：25 个 V 完整门槛、9 个系统、S01–S08、FL01–FL08、02 §6 组合场景与 E1–E3 均未运行
- H0 资产 ASSET.2 合成 fixture 与独立答案集：H0 未交付/未运行该能力
- H0 资产 ASSET.6 固定宿主适配与恢复驱动：H0 未交付/未运行该能力
- 工具验真行 TV.8 未就绪：H0 未交付对应判定能力（例如 Judge 语义裁定）
- 合成业务 fixture 生成器、独立答案集与 HOLDOUT 隔离尚未交付（02 §4.1；H0 只提供 oracle 输入样本与临时真实文件/SQLite）
- 固定宿主适配与恢复驱动、Judge 语义独立评分、长历史/长期运行观察器仍属后续切片；H0 不声明 V24/V25
- 观察器哈希链不是签名；同一机器/用户下的目录不构成秘密隔离，HOLDOUT 答案隔离仍需独立保管

## 12. 复核与再生命令

- `node scripts/harness/manifest.mjs`
- `node scripts/harness/selfproof.mjs`
- `node scripts/harness/traceability.mjs --strict`
- `node --import tsx --test --test-concurrency=1 tests/harness-*.test.ts`

复核方法：

1. 用 `sha256sum`（或 `shasum -a 256`）核对本文件声明的 artifact SHA256 与 `artifacts/dsh/harness/*.json`。
2. 打开 `tool-selfproof.json` 确认每个 `oracle:<name>` 测试名为 `ok`，并确认 `sourceHashes` 与当前 `tests/harness/**` 一致（不一致即 evidence 过期，必须重跑）。
3. 打开 `manifest.json`，任取文件按 `sha256` 重算；`aggregates.digest` 可独立按排序后的 `sha256  path` 行重算。
4. 对任一需求行：`source` 追到原始 Markdown 标题/表格行；`testIds`/`oracles` 追到自证 artifact；`status` 只按本报告证据层解释。
5. 任何产品 V/S/FL 结论请查 02 §9 与 `not_covered` 行——本报告不提供产品通过结论。

