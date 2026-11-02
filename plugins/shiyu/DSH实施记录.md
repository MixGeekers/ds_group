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
| H0 接管与测试基线 | 基线、环境/宿主/SDK 身份、测试工具自证、草稿保存 | **固定宿主限定通过**（本文 §0/§1）；测试工具已交付并经离线自证（§8，1201/1201） |
| H1 原生会话长期复用 | 3J 长历史冷恢复、恢复基准、布局竞态、后续压缩/恢复/缓存计量 | **离线通过**（G1 模块+组合，1058/1058，见 §5）；固定宿主/压缩/缓存/有界真实长对话仍未验 |
| H2 持久事件与多对话协作 | Agent 工具真实接线、四类发布/订阅组合、时间/外部源、背景唤醒、话题关联/受众安全 | 待 H1 后建立切片 |
| H3 core 与目标任务扩展 | 受控计划、依赖任务、修正/重规划、更多已授权能力、独立核验 | 待建立 |
| H4 六部分状态闭环 | 记忆生命周期完善、关系/情绪/认知/人格接入、能力清单与受限 ReadView | **四域基础离线通过**（H4，1159/1159，见 §7）；replyer 组合、仪表盘面板与固定宿主证据待接线；记忆生命周期完善待继续 |
| H5 运行保障与恢复 | 配额/迁移、宿主关闭恢复、检查点、删除/撤权屏障、独立备份 | **离线模块通过**（H5-B1 检查点/隔离恢复，1096/1096，见 §6）；未接 Runtime；宿主/独立故障域/V22/V27 未验 |
| H6 渠道、设备与 Lab 完整业务 | 明确资源范围内接实际平台/设备，本体经公共协议完成 S/FL | 待建立（真实资源范围需另有决定） |
| H7 整体验收与交付 | 九系统、40 模块、V01–V27、S/FL、部署剖面与失败清单逐项证明 | 待建立 |

## 3. 本轮证据索引与复现

| 证据 | 内容 |
|---|---|
| [baseline-offline.json](<artifacts/dsh/h0/baseline-offline.json>) | HEAD/环境/固定 SDK 哈希/1021 项基线日志摘要/隔离 worktree 1025 项验证/3J 草稿与 H0 文件哈希 |
| [host-status-zero-model.json](<artifacts/dsh/h0/host-status-zero-model.json>) | 冻结计划的零模型宿主核对：重载、工具输出、前后审计、增量分类、边界 |
| [host-status-tool-observation.json](<artifacts/dsh/h0/host-status-tool-observation.json>) | 同一原生会话中 `shiyu_status` 修复前报错与修复后完整 JSON 的原始事件记录（含 payload 哈希） |
| [host-audit-before.json](<artifacts/dsh/h0/host-audit-before.json>) / [installed](<artifacts/dsh/h0/host-audit-installed.json>) / [after](<artifacts/dsh/h0/host-audit-after.json>) / [after-tool](<artifacts/dsh/h0/host-audit-after-tool.json>) | 只读宿主状态审计（路径脱敏） |
| [h4-host-zero-model.json](<artifacts/dsh/h4/h4-host-zero-model.json>) / [shiyu-status-schema4-host.json](<artifacts/dsh/h4/shiyu-status-schema4-host.json>) | H1+H4+H5 验证构建的一次固定宿主零模型重载：schema4 六域发布、只读工具成功与前后只读审计；含 before/after/after-tool 审计与增量分类 |
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

## 5. H1 切片：原生会话长历史冷恢复（3J）

状态：**离线通过（G1 模块 + 原生接口组合）**；固定宿主、压缩恢复与有界真实长对话未验，不宣称 V24/V13/V14 通过。2026-11-02 完成并审阅。

### 5.1 交付

- `src/adapters/dsh/native-context.ts`：有界分页冷读（页 512、总量 32768 事件 / 32 MiB / 256 次 read / 10 秒绝对期限 / 允许追加后缀 64 事件），空白尾读确认 EOF；两遍完整顺序复读逐事件 hash 比较（第二遍不保留第二份历史）；一次官方 projector 投影并精确核对 `header.version=4/id/preset/isSeeded/inheritedEventCount` 与 `snapshot.asOfSeq === eventCount-1`（空史 -1）及 inbox 引用；链式历史摘要证明恢复前基准前缀身份，只接受受信原生恢复后缀（interrupted closers、`session/end-seed`、固定 user 标题），异源 user/assistant 消息、inbox splice、自动标题一律拒绝；10 个固定 `NativeHistoryError` 错误码，不泄漏正文或 SDK 原始错误；取消/期限/读/投影/close 失败均不产生成功回执，handle 在 finally 关闭。
- 恢复点接线：`sessions.ts`（load-only 与 replyer context）保留恢复前基准 S0，在原生 maintenance 阶段 flush + 冷读 + 绑定 live 对象/id/header/继承/inbox/seq；每次授权 await、onBound await 后同步重核；load-only 在 `authorize('append')` 等待窗口被外部直接追加 foreign `user/message`（不进 inbox）时记录异源输入并阻止回执、不删除未知消息；自身 append 后以“零额外后缀”完整冷读确认边界；固定标题写入按其精确 seq/hash 纳入新基准。`goals.ts`/`core-decision.ts`：core 决策恢复与派发前绑定并重核同一基准，`onDispatch` await 后再次核对，派发前 inbox 变化保持 unknown 拒绝。
- 测试：`tests/native-context.test.ts` 22 项（空史/2048±/远大于一页/短页非 EOF/页超量/缺号重复乱序 -0/header 与继承/投影水位/界限/追加改写/投影中追加/取消期限读投影 close 失败/expectedPrefix 正反例/extend 精确 append/live 绑定/maintenance），`tests/native-history.test.ts` 14 项业务路径（load-only 跨 2048、继承 seed、合法恢复后缀、两类外源直接追加、同长度早段改写、缩短、未知 inbox、replyer 跨 2048+外源 onBound 阻断、混合恢复后缀拒绝、空史身份保留、重启后同业务 Session、长历史取消无回执）；旧夹具（sessions/core-goal-sessions/session-reply-accounting）仅补新契约必需字段，未删断言、未跳过、未弱化安全断言。

### 5.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `08995d1` + 本切片 9 文件）`npm run check` | exit 0；**1058/1058 通过，0 失败/取消/跳过**，typecheck/build/Client 语法通过；日志 `plugins/shiyu/.local/phase3j-final-check.log`（SHA256 `8c05c87f…`，18:39:49Z–18:44:47Z） |
| Lead 独立 `scripts/slice-verify.mjs`（隔离 worktree，HEAD + 仅本切片，symlink node_modules 与 pinned Python 夹具） | exit 0；**1058/1058 通过，0 跳过**；证据 `artifacts/dsh/slices/h1-verify.json`、日志 `.local/slice-verify-h1.log`（SHA256 `aa342679…`） |
| 计数口径 | 基线 1025（H0）+ 净增 33（native-context 6→22、native-history 新增 14、core-goal-sessions 17→20）= 1058；两批结果一致 |
| 独立验证员（最终，绑定提交 `92c857f`） | `tests/verify/` 独立套件 **117 例 / 103 TAP tests 全通过**，0 失败/blocked/unobservable/unreported/skip；独立 `tsc -p tests/verify --noEmit` 通过；判定器自证 C00a–C00f（应过/应拒样本 + 1 正确/3 突变体端到端突变测试）；03 §5 八行覆盖 21/21、30/30、8/8、8/8、10/10、7/7、9/9、8/8；产品 6 文件与固定 SDK 7 包指纹绑定提交并逐项核对一致 |
| 独立复现与证据审计 | 独立验证员在同一隔离 worktree 复现 `npm run check`：exit 0、1058/1058/0/0；核读实现者日志 SHA256 `8c05c87f…` 与 Lead slice-verify 日志 `aa342679…`，确认非硬编码；测试计数算术 1021+4+33=1058 一致；未发现删除基线测试、`.skip/.only/assert.ok(true)` 或静默通过；旧测试放宽的少数错误正则仍保留“拒绝+零回执+句柄闭合/异源保留”硬断言 |
| 证据级别 | G1：合成原生读者/投影世界 + 真实临时 SQLite + 既有组合夹具；固定 SDK 只读静态核查，未执行 SDK |

### 5.3 失败 / unknown / 未测

1. 真实固定宿主的长历史冷恢复、重载与 live 原生 Session 操作未执行（本切片真实模型/embedding/宿主重载/live 写均为 0）；需后续零模型宿主与有界真实长对话/压缩分层分别留证。
2. 原生压缩/checkpoint、lifecycle（非 core）Goal namespace 的新基准接线未做；超过显式上限的历史仍按固定错误码拒绝。
3. 超时/取消依赖 SDK 协作式 AbortSignal；单次后端 read 若不响应 abort 可能晚于计时器返回（不宣称硬实时），但不会产生成功回执。
4. 两遍完整复读是 append-only 稳定观察，不是任意外部写者下的原子快照；同长度早段改写仅在两遍之间可检出。
5. 尚未做固定宿主 V24/V13/V14 验收；本切片不把离线 1058/1058 当作宿主或完整 H1 目标通过。

### 5.4 证据索引

| 证据 | 内容 |
|---|---|
| [h1-verification.json](<artifacts/dsh/h1/h1-verification.json>) | 本切片文件哈希、实现/验证范围、实现者隔离检查、Lead 独立切片检查、独立验证员最终结果、EV-09 元数据更正、失败/unknown/未测 |
| [h1-verify.json](<artifacts/dsh/slices/h1-verify.json>) | `scripts/slice-verify.mjs` 在 HEAD+仅本切片隔离 worktree 的全量检查原始记录（与 `.local/slice-verify-h1.log` 对应） |
| [FINAL-REPORT.md](<artifacts/dsh/verify/FINAL-REPORT.md>) / [runs/2026-11-02T18-57-25-813Z-final](<artifacts/dsh/verify/runs/2026-11-02T18-57-25-813Z-final/>) | 独立验证最终报告与最终运行 manifest/逐例结果/TAP/原始证据（绑定 H1 提交 `92c857f`，运行 HEAD `2e04eb2`，117 例/103 TAP 全过；本机 home 绝对路径已脱敏为 `<home>`）；[ISSUES.md](<artifacts/dsh/verify/ISSUES.md>) 与 [implementer-evidence-review.json](<artifacts/dsh/verify/implementer-evidence-review.json>) 保存复核结论与 EV-09 根因/更正 |
| [replication-final-check.log](<artifacts/dsh/verify/replication-final-check.log>) | 独立验证员在同一隔离 worktree 复现的 `npm run check` 日志（SHA256 `c6181832…`） |
| 独立套件源码 | `tests/verify/`（9 个 test + `support/` 独立世界/判据 + `report.mjs` + 独立 tsconfig + README）；运行 `node --import tsx tests/verify/report.mjs` |

元数据更正（EV-09）：`h1-verification.json` 的 implementerIsolatedCheck.startedAt 原为被覆盖的首次尝试（18:39:49Z，仅差预存在 Python/Ombre 条件 skip），已更正为保留日志的 18:42:44Z→18:44:47Z；计数/hash/退出码不变，结论不受影响。

### 5.5 复现

```
# 隔离切片验证（HEAD + 仅本切片文件 + pinned 依赖链接）
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h1-manifest.json>
# 独立验证员套件
cd plugins/shiyu && node --import tsx tests/verify/report.mjs
```

## 6. H5 切片：本地检查点与隔离恢复模块 B1

状态：**离线模块通过（G1，真实临时 SQLite/文件 + 合成端口）**；未接 Runtime/宿主，未做独立故障域或 V22/V27 完整验收。2026-11-02 完成并审阅。

### 6.1 交付

- `src/recovery/`（11 文件，含 README）：严格 `BackupBundle`/组件清单/`restore report`/恢复锁/世代类型与校验；控制库 `node:sqlite backup` 捕获到 staging、Goal Session 只读端口复制与逐 Session 尾部/hash/GoalRef/phase/armed/flush/projection 校验、记忆导出端口、共享对象闭包；`verifyBundleDirectory()` 不信任清单自述，从真实字节复核 hash/大小、SQLite `quick_check`/`foreign_key_check`、闭包、捕获时间规则；只有 ready 且自检通过才原子更新 last-good，任何 failed/incomplete/中断都不替换 last-good；`IsolatedRestoreService` 只在临时隔离根恢复，独占恢复锁 + maintenance/disarmed，复制后再次复核，按删除/授权屏障与 tombstone 判定，unknown 效果保留不重放，记录新 installationGeneration/hostEpoch 但 `verifiedByHost=false`，只到 not-activated。
- 跨组件共同截面明确 `crossComponentCommonSection=false`、ready 的 `reconcileRequired=true`，不把逐库一致冒充共同事务截面。
- 测试：`tests/recovery-*.test.ts` 5 个文件（schema 7、capture 15、restore 12、fault-matrix 2、evidence 2 = 38 项）纳入主 glob；30 例故障矩阵逐例“注入点→期望→实际”；校验器自证 18/18（好样本接受、坏样本按 code 拒绝）。
- 证据：`artifacts/dsh/h5/h5-recovery-matrix.json`、`h5-recovery-validator-selftest.json`、`h5-verification.json`、`h5-slice-summary.json`。

### 6.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `08995d1` + 本切片）`npm run check` ×3 | exit 0；**1063/1063?** 实际 1063 tests / 1062 pass / 0 fail / 1 既有条件 skip（隔离 worktree 未装 pinned Python/Ombre，非本切片）；定向 4 文件重复 3 轮 36/36 |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `92c857f` + 仅本切片，symlink node_modules 与 pinned Python） | exit 0；**1096/1096 通过，0 失败/跳过**；测试增量 1058 + 38 = 1096；证据 `artifacts/dsh/slices/h5-verify.json`、日志 `.local/slice-verify-h5.log` |
| 证据级别 | G1 离线模块 + 合成端口（真实临时 SQLite/文件）；无 live 数据根、原生 Session、模型、embedding、网络监听 |

### 6.3 失败 / unknown / 未测

1. 未接 Runtime：捕获触发/调度、控制库单写者与静默窗口、DSH flush/日志尾适配、真实 Ombre 导出、对象 pin、隔离根与激活切换、reconcile 屏障与显式激活均为后续集成点（README §3–§4 已写）。
2. 未测：live DSH/V24、真实原生 Goal Session flush 与日志格式、真实 Ombre 导出与物理删除、独立故障域/V27、RPO/RTO（V22 完整基准）、OS 断电与真实多进程双 writer、旧 schema 迁移、激活切换。
3. 上表“1063/3? ”口径：实现者隔离运行有 1 个既有 Python 条件跳过，Lead 在带 pinned fixture 的隔离树复核为 0 跳过；以 1096/1096 的 0 跳过分母为最终口径，不把 skip 当 pass。

### 6.4 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h5-manifest.json>
node --import tsx --test --test-concurrency=1 tests/recovery-*.test.ts
```

## 7. H4 切片：内层四域基础（关系/情绪/认知/人格）

状态：**离线通过（G1 模块/属性测试 + 真实临时 SQLite/WorkerThread）**，并已由 H4b 完成 replyer 只读组合与仪表盘面板；上游 replyer 生成路径接入（H4c）与真实业务验收未完成。2026-11-02 完成并审阅。

### 7.1 交付

- 新增 `src/contracts/inner.ts`（严格共享契约与校验）、`control-store/inner-domain.ts`（四域共用本地存储引擎：authority/revision/tombstone 水位、来源解析、metadata-only capture、正文分离读取、幂等回执、删除屏障）与四个领域文件：
  - `relationship-domain.ts`：完整账号元组唯一绑定、同名/同短 ID 不合并、角色/成员/交互/称呼/评估断言、显式 merge/split（不改写历史）、CAS 纠正、证据/身份撤回不复活、受众裁剪；关系亲疏不赋权。
  - `emotion-domain.ts`：有来源观察 + 固定版本衰减/回顾规则、同输入/时钟确定性重算、表达调节过期、拒绝把人当心理事实/无授权声明、跨受众隔离、来源失效降级。
  - `cognition-domain.ts`：有来源 Claim/假设/冲突集/复盘结论/可修订行动经验；事实与解释分离；保留谓词拒绝自述伪造工具/世界事实；来源撤回使依赖结论降级。
  - `personality-domain.ts`：稳定 Profile 版本、白名单 diff、学习策略固定 disabled、propose→review 两段审批、CAS、来源撤回 fail-closed；普通聊天无论多少轮不改稳定人格。
- `worker.ts`/`protocol.ts`：四域经同一 ControlStore Worker IPC 暴露（每域 9–11 个类型化命令）；`view-domain.ts` captureLocal 支持 `innerDomains`（只 reply_context）且只捕获 metadata，新增 `view.readInnerBodies` 仅对捕获子集与域内再授权读正文；`views/index.ts` 通用 ReadView 两段式（metadata 裁剪 → 返回前再授权 → 受众裁剪后才读正文；端口缺失/不完整/超时显式 unavailable，不空成功）。
- `publication.ts` schema4：memory+ability 旧语义保留（schema1/2/3 回执重放）；四域只有真实初始化成功才 available，初始化失败发布 unavailable 且命令显式失败；修复既有缺陷：schema4 下 memory/ability 可用性更新不再把清单降级到 schema2/3。
- 测试：`tests/inner-*.test.ts` 7 文件 63 项；按 schema4 必要更新 3 个既有基线测试的版本/形状断言（+8/−5，未削弱安全断言）。
- 证据：`artifacts/dsh/h4/h4-inner-domains-offline.json`、`h4-slice-summary.json`、`artifacts/dsh/slices/h4-verify.json`。

### 7.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `08995d1` + 仅本切片 21 文件）`npm run check` | exit 0；**1088/1088 通过，0 失败/取消/跳过**；typecheck/build/Client 语法通过；= 1025 基线 + 63 新测试 |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `31af227` + 仅本切片，symlink node_modules 与 pinned Python） | exit 0；**1159/1159 通过，0 失败/跳过**；= 1096 已提交基线 + 63；证据 `artifacts/dsh/slices/h4-verify.json`、日志 `.local/slice-verify-h4.log` |
| 覆盖 | 四域各自：写入/来源→发布→裁剪读取→使用→纠正/撤回→重启恢复；负例含同名误合并 0、跨受众泄露 0、删除复活 0、普通消息改人格 0、缺失 authority fail-closed；publication schema4 组合与读视图两段式；真实 WorkerThread 双连接 CAS 唯一赢家 |
| **加入固定宿主零模型重载（H1+H4+H5 联合构建）** | `shiyu_status` 返回有效无损 JSON；`innerProjection.manifest.schemaVersion=4` 且六域 available（memory + 四新域 + ability，含 backendId/authorityId/capabilities）；stateVersion 5→6 为真实启动发布；Task/Goal/Lab/预算/Effect/17 个 Session 文件不变；工具调用前后 commitSeq 302→302（严格只读）；无模型/embedding/Task/Goal/Session 探针/Lab 输入；证据 `artifacts/dsh/h4/h4-host-zero-model.json` |
| 证据级别 | G1 模块/属性 + 真实临时 SQLite/WorkerThread；外加一次固定宿主零模型启动/发布/只读工具核对（H4 宿主证据，非 V24 或业务验收） |

### 7.3 失败 / unknown / 未测

1. 未接线（H4b 集成中）：`src/views/local.ts` replyer 四域只读组合（`captureLocal{innerDomains}` + `view.readInnerBodies`）、client 仪表盘六域可用性面板与 `src/health/systems.ts` 的 inner summary 文案（宿主实测发现仍写“关系、情绪、认知、人格待接入”，与 schema4 manifest 不符，已列入 H4b）；H4b 后需再做一次零模型 reload 才算仪表盘宿主可见。
2. 未实现：关系纠正后的跨域重算（仅来源失效降级）、emotion 规则版本迁移与 personality 学习启用路径、完整历史回放视图（capture 只暴露当前 latest 可用版本）。
3. 未测：真实 DSH 宿主、真实模型/embedding、真实 Ombre 记忆正文、真实渠道/设备/业务；publication available 只是读取能力声明，不是授权或业务验收。

### 7.4 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h4-manifest.json>
cd plugins/shiyu && node --import tsx --test --test-concurrency=1 tests/inner-*.test.ts
```

## 8. H0b 切片：测试工具、判定器自证与覆盖追踪

状态：**离线通过（G1 工具自证）**；只证明测试基础设施本身，产品 V/S/FL/九系统/宿主/模型语义/费用仍未运行（traceability 产品行 not_covered）。2026-11-02 完成并审阅。

### 8.1 交付（35 文件）

- `tests/harness/`（20 文件）：`invariant.ts`（CheckResult 契约 + 自证框架）、`json.ts`（无损 JSON / JSON 文本判定）、`schema.ts`、`cas.ts`（含 100 同版本恰 1 胜、写偏斜）、`state-machine.ts`、`counts.ts`（缺失计数≠0、90/100 不得宣称完成、调用数含压缩/重试、周期遗漏、静默窗口 0 模型调用）、`causal.ts`（效果账本对齐/因果链）、`version-domains.ts`、`version.ts`（版本域不得混同/只读不得推进 stateVersion）、`authority.ts`（权限/canary/正文冒充控制）、`faults.ts`（AbsoluteDeadline+AbortSignal、BusinessClock 含 DST 跳过/重复与 latest-only、命名断点 FaultInjector）、`observer.ts`（fsync append-only JSONL + 序号 + SHA256 链；截断尾/篡改可检出；执行一次丢回执=1 次效果且产品 unknown）、`manifest.ts`、`selfproof.ts`、`traceability*.ts`、`fixtures/crash-child.ts`、`index.ts`、`README.md`。
- 根级主 glob 自证测试 6 文件 42 项（`tests/harness-*.test.ts`）；启动器 `scripts/harness/{manifest,selfproof,traceability}.mjs`；证据 `artifacts/dsh/harness/{manifest,tool-selfproof,traceability}.json` 等。
- 判定器自证：15 个 oracle 共 145 个 known-verdict（41 accept / 104 reject）全部按预期；元测试注入“永远接受”的假 oracle 被框架判失败；`lossless-json` 能复现并拒绝 H0 修复前的宿主缺陷形态。
- 覆盖追踪：103 行（九系统 9 + 02 §5 矩阵 9 + V01–V27 27 + S01–S08 8 + FL01–FL08 8 + H1–H8 8 + 02 §6.1–6.10 10 = 产品行 79 **全部 not_covered**；H0 侧 7 项 harness 能力 self_proven、8 项 tooling_ready、3 项未覆盖）。机器可读 `handoff` 规则：H0b 之后产品行由后续切片按其实际证据更新，禁止 tooling_ready 冒充通过。

### 8.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| `tests/harness-*.test.ts` | **42/42 通过，0 失败/跳过**；145 known-verdict 全部符合预期 |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `2e04eb2` + 仅 35 个 H0b 文件，symlink node_modules 与 pinned Python） | exit 0；**1201/1201 通过，0 失败/跳过**（= 已提交基线 1159 + 42 harness）；证据 `artifacts/dsh/slices/h0b-verify.json`、日志 `.local/slice-verify-h0b.log` |
| 实现者隔离 worktree（`92c857f` + H0b overlay） | exit 0；1100/1100（= H1 基线 1058 + 42），0 跳过；manifest/selfproof/traceability `--strict` 链生成 exit 0 |
| 证据级别 | G1 工具自证；产品证据保持 not_covered，不把工具通过写成产品通过 |

### 8.3 失败 / unknown / 未测

1. 只证明工具本身；产品 V/S/FL/九系统/宿主/模型语义/费用未运行（traceability 产品行 79/79 not_covered）。
2. 哈希链是完整性检测而非签名；同机同用户两个目录不是秘密隔离；假时钟是截止/发生边界，不替代真实 7 天运行；观察器未知项不填 0。
3. manifest artifact 生成于 `92c857f + 未提交 H0b overlay` 的隔离树（vcs.dirty=true，dirtyEntries=9 如实记录）；提交后可在干净基线重生成 clean-VCS manifest 作为增量，不改变工具语义。

### 8.4 复现

```
cd plugins/shiyu
node --import tsx --test --test-concurrency=1 tests/harness-*.test.ts
node scripts/harness/manifest.mjs --out artifacts/dsh/harness/manifest.json
node scripts/harness/selfproof.mjs --out artifacts/dsh/harness/tool-selfproof.json
node scripts/harness/traceability.mjs --strict --out artifacts/dsh/harness/traceability.json
```

## 9. H4b 切片：内层四域 replyer 只读组合与仪表盘面板

状态：**离线通过（G1 模块 + 真实 Worker + 合成宿主 UI）**；H4c（replyer 上游生成路径）与 H4b 提交后的固定宿主渲染核对另行推进。2026-11-02 完成并审阅。

### 9.1 交付（7 文件）

- `src/views/local.ts`：`createLocalReadView` 新增可选 `innerRead` 端口。capture.inner 四域构建独立 authority 的 ReadView 组件；严格遵守两段式：先按 scope/audience/resource/来源裁剪 metadata，再仅对 eligible recordIds 读正文；返回前再次授权并校验 authority/capturedAt/record 版本与证据态；缺 body reader 显式 `body_not_connected` unavailable；authority/grant 不匹配的篡改 capture 构造期拒绝；revoked 记录永不返回正文。
- `client/index.js`：新增“内层状态”标签页，读取 `runtime.snapshot().innerProjection`（schema4 manifest），available 展示 backendId/authorityId/capabilities，unavailable 展示 reason（五类已翻译），并明确 available 只是读取能力声明、不授权、非业务验收；缺 manifest 显式提示；中英双语。
- `src/health/systems.ts`：修复固定宿主零模型 reload 发现的陈旧文案（inner summary 原写“关系、情绪、认知、人格待接入”，与 schema4 manifest 不符），改为如实描述六域接线与 available 语义。
- 测试：`tests/inner-view.test.ts` +4（真实 Worker capture→local view 正例；缺 body reader 显式 unavailable；篡改/无 authority 构造期拒绝；纠正后重验拒绝旧正文；群聊视图不含私聊事实）；新增 `tests/ui/inner.spec.mjs` 5 项 + UI 夹具调整。
- 证据：`artifacts/dsh/h4/h4b-integration.json`、`h4b-slice-summary.json`、`artifacts/dsh/slices/h4b-verify.json`。

### 9.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `feecf86` + 仅 7 文件）`npm run check` | exit 0；**1206/1206 通过，0 失败/取消/跳过**；typecheck/build/Client 语法通过 |
| 实现者隔离 worktree `npm run test:ui` | exit 0；**209/209 通过**（既有 204 + 新增 5：中文默认、英文+390px、全 unavailable 原因、缺 manifest 显式提示、刷新只读 `commands==[]`） |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `feecf86` + 仅 7 文件） | exit 0；**1206/1206 通过，0 跳过**；证据 `artifacts/dsh/slices/h4b-verify.json` |
| Lead 复跑 `npm run test:ui`（共享树） | exit 0；**209/209 通过**（2.2 分钟）；日志 `.local/h4b-lead-ui.log` |
| 证据级别 | G1 模块 + 真实 WorkerThread + 合成宿主 UI；真实 DSH 宿主渲染与真实数据一致性待提交后零模型 reload 核对 |

### 9.3 失败 / unknown / 未测

1. replyer 上游 `src/control/local-reply.ts` 尚未在 `view.captureLocal` 请求 `innerDomains`，也未把内层行纳入 prompt / `conversation.reply.prepare` 合同——生产 replyer 生成路径本轮**不会**消费四域正文；这是显式 H4c 集成项，不把 local.ts 两段式就绪写成生成闭环。
2. 仪表盘为 client JS 面板，合成宿主 209 项 UI 通过不等于真实 DSH 宿主渲染验收；真实数据一致性未验。
3. 未新增 IPC 命令或权限；无宿主、模型、embedding 调用。

### 9.4 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h4b-manifest.json>
cd plugins/shiyu && npm run test:ui
```
