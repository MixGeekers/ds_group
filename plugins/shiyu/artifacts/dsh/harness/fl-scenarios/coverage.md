# H0c S/FL 业务测试集骨架覆盖索引

生成时间：2026-11-03T10:19:19.112Z；catalog 1.0.0；seed 20261101。

> **还不能用于业务验收。** 本索引只说明合成 fixture 与独立答案集骨架已物化、来源计数已核对；0 真实模型/embedding/Lab/宿主/渠道运行，所有场景为 `synthetic-fixture-only-not-run`。

## 1. 汇总

| 项目 | 计数 | 说明 |
| --- | --- | --- |
| 场景 | 16 | S01–S08 + FL01–FL08 |
| 已物化代表步骤 | 65 | 每场景 3–5 步；不是历史 80 步全量 |
| 历史设计步骤 | 80 | 54 S + 26 FL（FL02/06/07/08 无历史步骤） |
| 未物化设计步骤 | 27 | 见各行 uncovered |
| fixture / answers | 16 / 16 | 公开输入与评估侧答案分开 |
| 运行证据 | 0 | 无模型/embedding/Lab/宿主/渠道 |
| HOLDOUT | 0 | 保留集未制作，仅保留规则 |
| 人工标注 | 0 | 无双人盲评、无质量分数 |

## 2. 场景覆盖（状态只能是 synthetic-fixture-only-not-run）

| 场景 | split | 物化/历史步 | 未物化步骤 | 里程碑 | H | 质量步骤 | 变体 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S01 记得准，也改得过来 | DEV | 4/7 | S01.3, S01.5, S01.6 | 3 | H1,H2,H3,H7,H8 | S01.7 | 2 | case-doc: 测试/2026-11-01-测试集设计/cases/S01-记忆与纠正.md |
| S02 认识一个人，不等于共享所有私聊 | DEV | 4/7 | S02.2, S02.4, S02.7 | 4 | H1,H2,H4 | — | 2 | case-doc: 测试/2026-11-01-测试集设计/cases/S02-身份与群隐私.md |
| S03 自主订阅，变化才做事 | DEV | 5/8 | S03.5, S03.6, S03.8 | 3 | H1,H3,H4,H6 | — | 2 | case-doc: 测试/2026-11-01-测试集设计/cases/S03-订阅与主动任务.md |
| S04 一边做事，一边聊天 | DEV | 4/6 | S04.2, S04.6 | 4 | H1,H3,H4,H7 | S04.3 | 2 | case-doc: 测试/2026-11-01-测试集设计/cases/S04-聊天与任务.md |
| S05 做没做成，要分开说清 | DEV | 5/7 | S05.3, S05.5 | 5 | H1,H3,H4,H7 | — | 2 | case-doc: 测试/2026-11-01-测试集设计/cases/S05-未知效果与恢复.md |
| S06 删掉以后，不再回来 | DEV | 5/7 | S06.4, S06.5 | 5 | H4,H5 | — | 2 | case-doc: 测试/2026-11-01-测试集设计/cases/S06-删除与旧备份.md |
| S07 相处有连续性，人格不随风变 | DEV | 4/6 | S07.4, S07.6 | 2 | H1,H7,H8 | S07.2, S07.3, S07.5 | 2 | case-doc: 测试/2026-11-01-测试集设计/cases/S07-情绪与人格.md |
| S08 时间过去了，也不能乱补做 | DEV | 5/6 | S08.4 | 5 | H1,H3,H4,H6 | — | 2 | case-doc: 测试/2026-11-01-测试集设计/cases/S08-时间与预算.md |
| FL01 业务藏在闲聊中 | DEV | 4/6 | FL01.4, FL01.6 | 4 | H1,H6,H7 | — | 2 | case-doc: 测试/2026-11-01-信息流Lab/cases/FL01-闲聊中的延期.md |
| FL02 语境改变答案 | DEV | 3/0 | — | 1 | H7 | FL02.3 | 2 | matrix-only: 测试/2026-11-01-信息流Lab/覆盖与拟验契约.md |
| FL03 刷屏与纠正 | DEV | 5/7 | FL03.3, FL03.5 | 5 | H2,H3,H4,H6,H7 | — | 2 | case-doc: 测试/2026-11-01-信息流Lab/cases/FL03-相关变化与旧回复.md |
| FL04 单源洪峰 | DEV | 4/6 | FL04.2, FL04.4 | 4 | H1,H4,H6 | — | 2 | case-doc: 测试/2026-11-01-信息流Lab/cases/FL04-洪峰与公平.md |
| FL05 多人跨供应商 | DEV | 4/7 | FL05.1, FL05.4, FL05.7 | 4 | H1,H2,H7 | — | 2 | case-doc: 测试/2026-11-01-信息流Lab/cases/FL05-多人冲突与隔离.md |
| FL06 不确定与附件 | DEV | 3/0 | — | 3 | H3,H7 | — | 2 | matrix-only: 测试/2026-11-01-信息流Lab/覆盖与拟验契约.md |
| FL07 重放与恢复 | DEV | 3/0 | — | 3 | H3 | — | 2 | matrix-only: 测试/2026-11-01-信息流Lab/覆盖与拟验契约.md |
| FL08 订阅与长期业务 | DEV | 3/0 | — | 3 | H3,H4,H6 | — | 2 | matrix-only: 测试/2026-11-01-信息流Lab/覆盖与拟验契约.md |

## 3. 来源核验

| 场景 | 来源 | 存在 | 声明步数 | 实际步数 | 问题 |
| --- | --- | --- | --- | --- | --- |
| S01 | 测试/2026-11-01-测试集设计/cases/S01-记忆与纠正.md | yes | 7 | 7 | — |
| S02 | 测试/2026-11-01-测试集设计/cases/S02-身份与群隐私.md | yes | 7 | 7 | — |
| S03 | 测试/2026-11-01-测试集设计/cases/S03-订阅与主动任务.md | yes | 8 | 8 | — |
| S04 | 测试/2026-11-01-测试集设计/cases/S04-聊天与任务.md | yes | 6 | 6 | — |
| S05 | 测试/2026-11-01-测试集设计/cases/S05-未知效果与恢复.md | yes | 7 | 7 | — |
| S06 | 测试/2026-11-01-测试集设计/cases/S06-删除与旧备份.md | yes | 7 | 7 | — |
| S07 | 测试/2026-11-01-测试集设计/cases/S07-情绪与人格.md | yes | 6 | 6 | — |
| S08 | 测试/2026-11-01-测试集设计/cases/S08-时间与预算.md | yes | 6 | 6 | — |
| FL01 | 测试/2026-11-01-信息流Lab/cases/FL01-闲聊中的延期.md | yes | 6 | 6 | — |
| FL02 | 测试/2026-11-01-信息流Lab/覆盖与拟验契约.md | yes | 0 | 0 | — |
| FL03 | 测试/2026-11-01-信息流Lab/cases/FL03-相关变化与旧回复.md | yes | 7 | 7 | — |
| FL04 | 测试/2026-11-01-信息流Lab/cases/FL04-洪峰与公平.md | yes | 6 | 6 | — |
| FL05 | 测试/2026-11-01-信息流Lab/cases/FL05-多人冲突与隔离.md | yes | 7 | 7 | — |
| FL06 | 测试/2026-11-01-信息流Lab/覆盖与拟验契约.md | yes | 0 | 0 | — |
| FL07 | 测试/2026-11-01-信息流Lab/覆盖与拟验契约.md | yes | 0 | 0 | — |
| FL08 | 测试/2026-11-01-信息流Lab/覆盖与拟验契约.md | yes | 0 | 0 | — |

历史文档步骤计数与来源正文逐项核对；companion 文档（判分/合成公司/覆盖契约/Lab 计划）问题见 coverage.json issues。

## 4. 拆分规则（DEV / REG / HOLDOUT）

当前状态：DEV=16，REG=0，HOLDOUT=0；holdout=reserved_not_materialised。

- 本切片所有 S/FL 场景均为公开 DEV；改名/翻译/加噪/换种子/重排不得变成 HOLDOUT
- 同一 family 的所有变体必须与 family 同属一个集合
- REG 只在冻结故事与已修复失败上按来源登记（含 bug 引用），不得由 DEV 改名复制
- HOLDOUT 尚未制作：需独立作者、答案先冻结、真实权限与流程隔离；目录名不构成秘密隔离
- 历史有限样本（phase3h/3i 等）不得升级为 HOLDOUT 或已验证业务证据
- 同机/同用户目录不是秘密隔离；开发 agent 拥有工作区读取权限时不能自称对 HOLDOUT 盲测

## 5. 缺失资产（全部阻断业务验收）

| ID | 缺口 | 影响 | 负责切片 |
| --- | --- | --- | --- |
| MISSING.FL02-06-07-08-cases | FL02/FL06/FL07/FL08 没有历史 case 文档与历史答案，只有矩阵要求；本骨架只新写 3 步代表轨迹 | 阻断业务验收 | H0c+ |
| MISSING.design-steps | S 54 步与 FL01/03/04/05 26 步中未物化的历史步骤（见各行 uncovered） | 阻断业务验收 | H0c+ |
| MISSING.variants | 每个场景的答案不变/答案改变变体只冻结规格，未生成输入轨迹 | 阻断业务验收 | H0c+ |
| MISSING.noise-trajectories | FL01 的 0/16/76 条噪音轨迹、FL04 的 1,000 条负载计划未生成 | 阻断业务验收 | H1+/Lab 切片 |
| MISSING.holdout | HOLDOUT 保留集未制作：需独立作者、答案冻结后保管、真实权限/流程隔离；当前 0 条 | 阻断业务验收 | 独立作者/流程 |
| MISSING.annotators | 相处质量 1–5 分无人工双标注与分歧记录；讨论门槛未冻结 | 阻断业务验收 | 人工评审 |
| MISSING.run-evidence | 0 真实模型/embedding/Lab 房间/宿主/渠道运行；所有场景状态只能是 synthetic-fixture-only-not-run | 阻断业务验收 | H1+ 运行切片 |
| MISSING.attachment-corpus | FL06 附件/转写语料未物化，附件不可解析分支仅有 1 个合成事件 | 阻断业务验收 | H0c+ |
| MISSING.b0-r1-contract | B0/R1 回复失效与 core 容量配置差异仍是并列契约，尚未映射到公共 API | 阻断业务验收 | H1+/架构切片 |
| MISSING.canary-surfaces | 评估侧 canary 仅存在于答案包；尚未在实际视图/模型输入/发送面上运行扫描 | 阻断业务验收 | H1+ 运行切片 |

## 6. 复核方法

- `node scripts/harness/fl-scenarios.mjs`
- `node --import tsx --test --test-concurrency=1 tests/harness-business.test.ts`
- `node --import tsx --test --test-concurrency=1 tests/harness-*.test.ts`

复核要点：
1. `fixtures/` 只含公开驱动输入；`answers/` 才含四类允许结果、里程碑、oracle 期望与评估 canary，二者目录分离且扫描通过。
2. 每个场景的 answers 必须早于任何运行冻结（`freeze.derivedFromProductOutput=false`），语义摘要稳定；不接受由产品输出回填的答案。
3. 聚合器把硬约束 H1–H8（零容忍）、功能里程碑、相处质量分开；任何 unknown/skip/未运行不得计为通过，也不得有总分。
4. 历史 case 文档只是公开 DEV 设计来源；其未物化步骤、变体、噪音/负载、HOLDOUT 与人工标注仍是缺口。
5. 任何“业务通过/已验证”措辞都与本索引矛盾；先由后续切片在真实/沙箱运行中提供独立证据。

## 7. 免责声明

本索引只说明 S/FL 合成 fixture 与独立答案集骨架已物化、来源步骤计数已核对。没有任何产品/宿主/模型/Lab/渠道运行，所有场景状态为 synthetic-fixture-only-not-run；它不能用于业务验收，也不能被后续切片当作已验证证据或 HOLDOUT。

