# 识雨本体 · DSH 实施记录

更新：2026-11-02（America/Caracas）。本文件是由 DeepSeek Harness（DSH）接管后维护的实施与证据记录；Codex 时期的实现与证据历史保留在[实施记录.md](<实施记录.md>)，两份记录不互相改写。

入口：[DSH 交接包](<../../架构与设计/DSH交接/00-交接入口与实施路线.md>) · [九系统目标](<../../架构与设计/DSH交接/01-九系统剩余目标与边界.md>) · [测试与验收](<../../架构与设计/DSH交接/02-测试设计与验收标准.md>) · [3J 接手](<../../架构与设计/DSH交接/03-3J草稿与原生会话接手说明.md>) · [九大系统计划](<../../架构与设计/九大系统实施与验证计划.md>) · [V01–V27](<../../架构与设计/A方案全景/验证与验收.md>) · [使用与开发说明](<README.md>)

状态词口径（与 02 一致）：设计中 → 已实现未验 → 离线通过 → 固定宿主通过 → 限定真实业务通过 → 完整适用门槛通过；另有失败、unknown、blocked、经说明不适用。本文只记录实际取得的证据层，不把文档、旧批次或合成替身写成宿主/业务验收。

## 0. 接管快照（H0）

2026-11-02，DSH 按交接包接管识雨九系统剩余实现。第一轮先做接管与基线核对，再做两个可直接验证的 H0 变更（宿主状态工具缺陷修复、测试工具与审计脚本），随后进入 H1（3J 原生 Session 长历史）。

### 0.1 仓库与环境（接管时实测）

| 项目 | 实测值 |
|---|---|
| 工作树 | `/Users/caja/Documents/识雨`；分支 `codex/start-shiyu-implementation`；HEAD `d9d14a5`（代码等价 `2402ca8` + 证据/文档提交） |
| 未提交内容 | 仅 `src/adapters/dsh/native-context.ts` 的 3J 草稿；SHA256 `fb178ebc…5292`，与 03 文档记录一致。接管时先保存到 `.local/3j-draft/native-context.draft.ts`，把工作树恢复为已提交基线后再跑基线 |
| 本地运行时 | Node `v24.19.0`、npm `11.17.0`、macOS `darwin/arm64` |
| 固定宿主 | DeepSeek Harness `0.2.1-rc.5`（`runtime/primary-runtime/runtime.json`）；宿主内置运行时 Node `24.21.0`；宿主工具输出中的 SQLite 为 `3.53.4 / wal / 独立线程`，本机 CLI SQLite `3.53.3` |
| 固定 SDK | 通过本包 `scripts/read-dsh-asar.mjs` 只读提取 `app.asar` 内的六个公开包，SHA256 与 03 文档的静态核查一致（`dsh-session` `2f5dd07c…`、`dsh-session-persistence` `cc0b6d3a…`、`dsh-session-persistence-jsonl` `973dd786…`、`dsh-session-projection` `7dc2b212…`、`dsh-agent-loop` `cf57e3ec…`、`dsh-agent` `7b59cf82…`）；另记录 `dsh-tools`、`dsh-util-values`、`dsh-llm` 哈希用于无损 JSON 与工具输出契约分析 |
| 插件装载 | 本 profile 以 link 方式装载 `@shiyu/runtime`（`include:shiyu-runtime`）、`@shiyu/gym`、`@shiyu/workbench`；三者在接管时均 enabled/active |

### 0.2 离线基线与草稿身份

- 在已提交 HEAD 上执行 `npm run check`：**1021/1021 模块测试通过，0 失败/取消/跳过**，类型检查、构建与 Client 语法检查均通过，退出码 0，耗时 108.6 秒；日志 `plugins/shiyu/.local/h0-baseline-check.log`（该 .local 目录被本包 .gitignore 排除，不改写历史证据）。1021 与 3I 历史离线基线一致。
- 3J 未验证草稿保持原样保存，不当作已验实现；其身份、已核实 SDK 语义与缺口见 03 文档。
- H0 修复在 **隔离 git worktree**（`d9d14a5` + 仅 H0 补丁）中验证：`npm run check` **1025/1025 通过，0 失败/取消/跳过**（补上 Python/Ombre 夹具依赖后无跳过项），再从该 worktree 安装构建产物到运行插件。该做法保证宿主不会加载其他并行进行中的源码。

### 0.3 接管时宿主只读状态（裸机核对，不依赖插件工具）

使用新增的只读审计脚本 `scripts/host-state-audit.mjs`（`node:sqlite` 只读连接 + 文件元信息，不写产品数据、不调用运行时服务）核对：

- 全局运行状态 `paused=false`；运行时实例自本地时间约 13:07 后空闲；10 条 Session 绑定（1 archived、9 released）。
- 控制库 commitSeq `285`，与 3I 收尾记录一致；发布清单 stateVersion `5`（memory available、ability available，其余四域 unavailable）。
- Task 3 项（2 succeeded、1 unknown）、Task run 3 项（2 reported、1 unknown）、Core Goal 2 项（1 cancelled/paused、1 complete/paused）、评估 3 项（2 committed、1 unknown）、Lab 连接 3 项全部 disconnected、预算预留 24 项（21 settled、3 unknown）、Effect 13 项 succeeded、事件 35、投递 34 全部 acked。
- 17 个识雨自有原生 Session 文件（`~/.dsh/sessions/**/shiyu-*`）记录 bytes/SHA256/mtime 清单，哈希清单摘要 `21cab6fa…`。
- 本轮只读审计不写库、不解码原生 Session 正文，不读取其他工作区。

### 0.4 本轮团队与任务板

本轮以 Lead + 3 名 DSH 团队成员并行推进，全部使用共享任务板并声明写作用域；用户已明确本轮预算无上限，团队按完整推理/完整测试矩阵推进（无上限预算不等于可跳过证据、权限或真实资源围栏）：

| 成员 | 任务 | 写作用域（摘要） |
|---|---|---|
| Lead | H0 接管、基线、宿主状态缺陷修复与零模型验证、集成/复核/提交、S 切片编排 | 共享文件、runtime.ts/lab.ts、文档与证据 |
| `native-history` | task-1：H1 3J 长历史冷恢复实现+测试+全量检查 | `src/adapters/dsh/{native-context,sessions,goals,core-decision}.ts` 与对应测试 |
| `test-harness` | task-2：H0 测试工具与自证（oracle/故障注入/观察账本/manifest/覆盖追踪） | `tests/harness/`、`scripts/harness/` |
| `independent-verifier` | task-3：H1 独立验证测试集与实现证据复核 | `tests/verify/`、`artifacts/dsh/verify/` |

任务板（共享）：H1 3J 实现、H0 测试工具、H1 独立验证、H0 宿主缺陷；H2–H7 切片在 H0/H1 证据之后按依赖逐一建立。

## 1. H0 切片：运行状态工具的宿主缺陷与测试基础设施

### 1.1 发现

接管时直接调用运行中插件的只读工具 `shiyu_status` 返回：

```
Error: tool "shiyu_status" returned invalid output: value is not lossless JSON
```

该工具返回 `RuntimeService.snapshot()`。DSH `0.2.1-rc.5` 的 `dsh-tools` 在返回前对工具输出做 lossless JSON 快照校验（拒绝显式 `undefined`、`NaN`/`Infinity`/`-0`、非普通原型对象、稀疏数组、符号/不可枚举键等）。定位到两个产生显式 `undefined` 的产品投影点：

1. `src/runtime.ts` 的 `dependencies[].checkedAt` 直接写 `probe?.at` / `verification?.at` / `goalVerification?.at`：新实例尚无观测记录时为 `undefined`，被校验拒绝；
2. `src/control/lab.ts` 的 Lab 公共投影对 `reasonCode` / `sendId` 总是输出键：数据库中无该值的回复/发送会产生显式 `undefined`（真实库中 A 轮 unknown 回复即此形态）。

两层都用只读探针独立复现：新建临时运行时实例复现 `$.dependencies[1].checkedAt`；对真实运行库的**临时副本**（`.backup` 到临时目录后只读）复现 8 个 `lab.connections[].replies[]` 字段。探针只写临时目录，不触碰 live 库。

### 1.2 修复

- `dependencies[].checkedAt` 改为条件展开：仅在存在真实时间戳时输出该键；HTTP JSON 形状与 UI 行为保持不变（`undefined` 本来也不会出现在 JSON 中）。
- Lab 公共投影的 `reasonCode` / `sendId` 改为条件展开，保持真实值；同时导出 `publicConnection` 供回归测试直接验证投影输出。
- 新增 `tests/host-status.test.ts`：独立实现 lossless JSON 判据（不复用产品工具），先以 known-good / known-bad 样本自证判定器会拒绝错误；再断言：新实例快照无显式 undefined、含任务/会话的诊断快照仍无损、Lab 投影在有/无可选字段两种真实形态下都无损、JSON round-trip 与 HTTP 形状一致。

### 1.3 新增测试工具

| 工具 | 用途 | 证据级别 |
|---|---|---|
| `scripts/read-dsh-asar.mjs` | 只读解析已安装 DSH `app.asar`（ASAR pickle 容器），`list`/`cat`/`hash`；用于固定 SDK 契约静态核查，不运行 Electron、不安装依赖、不写盘 | 以 3J 交接的已知 SHA256 交叉验证通过 |
| `scripts/host-state-audit.mjs` | 只读审计宿主运行状态：runtime-state 摘要、控制库水位/发布/Task/Goal/Lab/预算/Effect/投递计数、17 个自有原生 Session 文件 bytes/SHA256/mtime、dist 摘要；不写产品数据、不调用产品 API | 用于本轮 before/after 零模型核对，工具本身为元数据采集，不是产品验收 |
| `tests/host-status.test.ts` | 如上，防止该宿主契约缺陷回归 | 已包含在 1025/1025 验证批次 |

### 1.4 固定宿主零模型验证（有序重载一次）

执行前冻结计划 `.local/dsh-h0-host-execution-plan.json`（SHA256 `ac8a5987…`），范围为：一次有序禁用/启用识雨自身插件、只调用 `shiyu_status`、0 模型/embedding/Task/Goal/Session 探针/Lab 输入。

实际结果（UTC 2026-11-02）：

| 观察项 | 结果 |
|---|---|
| 有序重载 | `include:shiyu-runtime` disable→enable 均 applied；新实例 `69650eab…`，启动于 `18:07:06` |
| 工具输出 | 同一 Lead 会话中，修复前工具调用（session 事件 seq 83/84）报 `invalid output: value is not lossless JSON`；重载后同一工具调用（seq 850/851）返回**完整有效 JSON**，无错误 |
| 只读性 | 工具调用前后审计完全一致：commitSeq `291→291`、事件 `36→36`、投递 35、Task/Goal/Lab/预算/Effect 计数不变、运行时状态文件 SHA256 不变 |
| 重载增量 | commitSeq `285→291`（+6：启动生命周期事件与其投递 ack，属宿主初始化写入）；事件 +1、投递 +1；发布清单 **stateVersion 5 与 manifestHash 均未变**；能力 revision `6→8` 且 hostEpoch 换新：`RuntimeService` 启动时对固定 local-note 能力做依赖观察（`ability.observeLocalNote`），enabled 保持 true、binding digest 不变、availability=available、成功证据仍 unknown（未补历史 proof） |
| 业务事实 | Task 3（2 succeeded/1 unknown）、Core Goal 2（1 cancelled、1 complete）、Lab 3 disconnected、预算 24（21 settled/3 unknown）、Effect 13、17 个原生 Session 文件 bytes/SHA256/mtime 摘要 `21cab6fa…` 均与重载前一致；无新 Task/Goal/Session/探针/Lab 输入/外部效果 |
| 返回快照 | 新实例 `lifecycle=degraded` 来自保留的历史 unknown/暂停业务事实（A 轮 unknown 预算、未解决 Core 评估），不是本轮新失败；`activeWork=[]` |

证据：`artifacts/dsh/h0/host-status-zero-model.json`（含计划哈希、修复文件、构建摘要、before/installed/after/after-tool 审计摘要与增量分类）、`artifacts/dsh/h0/host-status-tool-observation.json`（同一会话日志中修复前后两次工具调用的原始记录，含成功返回的完整同步快照与 payload 哈希）、`artifacts/dsh/h0/host-audit-*.json`（路径已脱敏）、`artifacts/dsh/h0/baseline-offline.json`（基线、环境、SDK、测试日志与指纹）。

### 1.5 H0 边界与未完成项

- 本切片只证明：状态工具输出满足 DSH 无损 JSON 契约、该工具路径只读、一次有序重载无业务重放；**不是 V24 生命周期验收**（不覆盖 20 次生命周期、drain 时限、长历史/压缩/生成）。
- 当前运行插件装载的是 **H0 验证构建**（来自隔离 worktree，`dist` 摘要 `4ce980e6…`，82 个文件），不是工作树中并行进行的 H1 源码；H1 完成并通过全量检查后才另做新的验证构建与（如需要）重载。
- 该缺陷说明“产品模块测试全绿”不能替代宿主工具契约验证；后续切片需把工具输出/仪表盘路径纳入宿主检查（已由 `test-harness` 的 oracle 工具集承接通用部分）。

## 2. 切片路线（H0–H7）

按交接包建议顺序推进；每个切片独立形成“代码 + 测试 + 证据 + 记录”，状态只写实际证据层。

| 切片 | 目标 | 当前状态 |
|---|---|---|
| H0 接管与测试基线 | 基线、环境/宿主/SDK 身份、测试工具自证、草稿保存 | **固定宿主限定通过**（本文 §0/§1）；测试工具仍在扩展（task-2） |
| H1 原生会话长期复用 | 3J 长历史冷恢复、恢复基准、布局竞态、后续压缩/恢复/缓存计量 | 实施中（task-1/task-3） |
| H2 持久事件与多对话协作 | Agent 工具真实接线、四类发布/订阅组合、时间/外部源、背景唤醒、话题关联/受众安全 | 待 H1 后建立切片 |
| H3 core 与目标任务扩展 | 受控计划、依赖任务、修正/重规划、更多已授权能力、独立核验 | 待建立 |
| H4 六部分状态闭环 | 记忆生命周期完善、关系/情绪/认知/人格接入、能力清单与受限 ReadView | 待建立 |
| H5 运行保障与恢复 | 配额/迁移、宿主关闭恢复、检查点、删除/撤权屏障、独立备份 | 待建立 |
| H6 渠道、设备与 Lab 完整业务 | 明确资源范围内接实际平台/设备，本体经公共协议完成 S/FL | 待建立（真实资源范围需另有决定） |
| H7 整体验收与交付 | 九系统、40 模块、V01–V27、S/FL、部署剖面与失败清单逐项证明 | 待建立 |

## 3. 本轮证据索引与复现

| 证据 | 内容 |
|---|---|
| [baseline-offline.json](<artifacts/dsh/h0/baseline-offline.json>) | HEAD/环境/固定 SDK 哈希/1021 项基线日志摘要/隔离 worktree 1025 项验证/3J 草稿与 H0 文件哈希 |
| [host-status-zero-model.json](<artifacts/dsh/h0/host-status-zero-model.json>) | 冻结计划的零模型宿主核对：重载、工具输出、前后审计、增量分类、边界 |
| [host-status-tool-observation.json](<artifacts/dsh/h0/host-status-tool-observation.json>) | 同一原生会话中 `shiyu_status` 修复前报错与修复后完整 JSON 的原始事件记录（含 payload 哈希） |
| [host-audit-before.json](<artifacts/dsh/h0/host-audit-before.json>) / [installed](<artifacts/dsh/h0/host-audit-installed.json>) / [after](<artifacts/dsh/h0/host-audit-after.json>) / [after-tool](<artifacts/dsh/h0/host-audit-after-tool.json>) | 只读宿主状态审计（路径脱敏） |
| `plugins/shiyu/.local/h0-baseline-check.log`、`.local/h0-verify-log.sha256`、`.local/dsh-h0-host-execution-plan.json` | 基线日志、验证构建日志哈希、冻结执行计划（`plugins/shiyu/.local/` 为本包 gitignore 的运行数据目录） |

复现命令（在 `plugins/shiyu/`）：

```
npm run check                                        # 基线/切片离线全量检查
node --import tsx --test tests/host-status.test.ts    # H0 定向回归
node scripts/read-dsh-asar.mjs hash "dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js"
node scripts/host-state-audit.mjs --out /tmp/host-audit.json
```

## 4. 失败、unknown 与限制

- 接管时运行中插件的 `shiyu_status` 失败是**真实宿主缺陷观察**，已修复并有宿主证据；修复不改变任何业务未知：A 轮 unknown 预算、旧 unknown Task、已取消 Goal 等历史事实原样保留。
- 基线 1021 项与 H0 验证 1025 项是两个不同源码快照的批次，不累加、不互相替代；前者不含 3J 草稿，后者 = 基线 + H0 修复。
- 本轮所有离线测试使用合成替身与临时真实 SQLite/文件；唯一真实宿主操作是一次零模型有序重载与一次只读工具调用。没有模型、embedding、真实渠道或设备调用。
- 后续真实资源（新账号/频道、设备、付费预算批次、独立备份目的地）仍按交接包 §5/§7 的围栏处理；缺范围时继续完成不依赖它们的工作并明确标 blocked。
