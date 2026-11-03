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
| H0 接管与测试基线 | 基线、环境/宿主/SDK 身份、测试工具自证、草稿保存 | **固定宿主限定通过**（本文 §0/§1）；测试工具已交付并经离线自证（§8）；S/FL 业务测试集骨架离线通过（§11，1264/1264，合成未运行） |
| H1 原生会话长期复用 | 3J 长历史冷恢复、恢复基准、布局竞态、后续压缩/恢复/缓存计量 | **离线通过**（G1 模块+组合，1058/1058，见 §5）；固定宿主/压缩/缓存/有界真实长对话仍未验 |
| H2 持久事件与多对话协作 | Agent 工具真实接线、四类发布/订阅组合、时间/外部源、背景唤醒、话题关联/受众安全 | **H2a 离线通过**（worker 事件工具+四类路径+可信协调器，1249/1249，见 §10）；固定宿主探针、时间/条件源、链深/背压与 core 工具（H2c）未完成 |
| H3 core 与目标任务扩展 | 受控计划、依赖任务、修正/重规划、更多已授权能力、独立核验 | **离线通过**（受控计划/多步任务/重规划，1288/1288，见 §14）；真实宿主/模型、更多能力与 dashboard 投影待接 |
| H4 六部分状态闭环 | 记忆生命周期完善、关系/情绪/认知/人格接入、能力清单与受限 ReadView | **四域基础离线通过**（H4，1159/1159，见 §7）；replyer 组合、仪表盘面板与固定宿主证据待接线；记忆生命周期完善待继续 |
| H5 运行保障与恢复 | 配额/迁移、宿主关闭恢复、检查点、删除/撤权屏障、独立备份 | **离线模块通过**（H5-B1 检查点/隔离恢复，1096/1096，见 §6）；未接 Runtime；宿主/独立故障域/V22/V27 未验 |
| H6 渠道、设备与 Lab 完整业务 | 明确资源范围内接实际平台/设备，本体经公共协议完成 S/FL | **H6a 通用渠道接入基础离线通过**（身份/去重/受众/修订，1336/1336，见 §15）；真实平台/设备与完整 S/FL 仍缺资源范围 |
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

状态：**离线通过（G1 模块 + 真实 Worker + 合成宿主 UI）**；H4c 已把内层参考接入 replyer 上游生成路径（§13），H4b 宿主可见性已由零模型 reload 核对（§9.2）。2026-11-02 完成并审阅。

### 9.1 交付（7 文件）

- `src/views/local.ts`：`createLocalReadView` 新增可选 `innerRead` 端口。capture.inner 四域构建独立 authority 的 ReadView 组件；严格遵守两段式：先按 scope/audience/resource/来源裁剪 metadata，再仅对 eligible recordIds 读正文；返回前再次授权并校验 authority/capturedAt/record 版本与证据态；缺 body reader 显式 `body_not_connected` unavailable；authority/grant 不匹配的篡改 capture 构造期拒绝；revoked 记录永不返回正文。
- `client/index.js`：新增“内层状态”标签页，读取 `runtime.snapshot().innerProjection`（schema4 manifest），available 展示 backendId/authorityId/capabilities，unavailable 展示 reason（五类已翻译），并明确 available 只是读取能力声明、不授权、非业务验收；缺 manifest 显式提示；中英双语。
- `src/health/systems.ts`：修复固定宿主零模型 reload 发现的陈旧文案（inner summary 原写“关系、情绪、认知、人格待接入”，与 schema4 manifest 不符），改为如实描述六域接线与 available 语义。
- 测试：`tests/inner-view.test.ts` +4（真实 Worker capture→local view 正例；缺 body reader 显式 unavailable；篡改/无 authority 构造期拒绝；纠正后重验拒绝旧正文；群聊视图不含私聊事实）；新增 `tests/ui/inner.spec.mjs` 5 项 + UI 夹具调整。
- 证据：`artifacts/dsh/h4/h4b-integration.json`、`h4b-slice-summary.json`、`artifacts/dsh/slices/h4b-verify.json`；提交后固定宿主零模型 reload 证据 `artifacts/dsh/h4/h4b-host-visible.json` / `shiyu-status-h4b-host.json`。

### 9.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `feecf86` + 仅 7 文件）`npm run check` | exit 0；**1206/1206 通过，0 失败/取消/跳过**；typecheck/build/Client 语法通过 |
| 实现者隔离 worktree `npm run test:ui` | exit 0；**209/209 通过**（既有 204 + 新增 5：中文默认、英文+390px、全 unavailable 原因、缺 manifest 显式提示、刷新只读 `commands==[]`） |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `feecf86` + 仅 7 文件） | exit 0；**1206/1206 通过，0 跳过**；证据 `artifacts/dsh/slices/h4b-verify.json` |
| Lead 复跑 `npm run test:ui`（共享树） | exit 0；**209/209 通过**（2.2 分钟）；日志 `.local/h4b-lead-ui.log` |
| **提交后固定宿主零模型重载（H4b 构建）** | `shiyu_status.systems[].inner.summary` 已更新为如实描述（旧文案清除）；`innerProjection` schema4 六域 available、authority/backend/capabilities 不变；commitSeq 302→308 为启动生命周期写入；Task/Goal/Lab/预算/Effect/17 个 Session 文件不变；工具调用前后 commitSeq 308→308（严格只读）；无模型/embedding/Task/Goal/Session 探针/Lab 输入；证据 `artifacts/dsh/h4/h4b-host-visible.json` |
| 证据级别 | G1 模块 + 真实 WorkerThread + 合成宿主 UI；外加一次固定宿主零模型 reload 确认 schema4 数据与内层文案可见（真实浏览器 DOM 渲染与真实业务数据仍未验） |

### 9.3 失败 / unknown / 未测

1. replyer 上游已由 H4c 接入四域参考（§13），H4d 已补 `prepare` 显式 inner 来源摘要与 Lab 内层只读路径（§18）；真实模型如何使用内层块、Lab permit-bound capture 是否携带 inner 元数据仍未验/未扩展。
2. 仪表盘为 client JS 面板，合成宿主 209 项 UI 通过不等于真实 DSH 宿主渲染验收；真实数据一致性未验。
3. 未新增 IPC 命令或权限；无宿主、模型、embedding 调用。
4. 固定宿主零模型 reload 后 `systems[].inner.summary` 已如实、`innerProjection` schema4 六域可见（`artifacts/dsh/h4/h4b-host-visible.json`）；但真实浏览器 DOM 渲染未由本检查证明（合成宿主 UI 209 项是独立证据层），真实数据一致性未验。
5. 顶层 scope notice 仍写“其余内层状态待接入”；与 manifest 不矛盾（memory 生命周期、跨域重算仍待推进），留待后续切片刷新。

### 9.4 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h4b-manifest.json>
cd plugins/shiyu && npm run test:ui
```

## 10. H2a 切片：Agent 事件工具真实挂载与四类发布/订阅路径

状态：**离线通过（G1/G2：真实临时 SQLite + 合成原生 DSH 协议替身 + 独立效果账本）**；固定宿主零模型探针、真实 core 续接与 core 工具（H2c）未完成。2026-11-02 完成并审阅。

### 10.1 交付

- `src/adapters/dsh/event-tools.ts`：新增 worker 事件工具（types/report）。可发布类型限定 `agent.observation.reported` / `worker.result.reported`；actor、scope、类型由宿主 principal 注入，工具参数不得携带 actor/permit/scope/taskId；`task.succeeded`、未注册类型、未授予类型拒绝；返回类型 schema/字段/版本/scope 与受理回执及含义说明。
- `src/adapters/dsh/workers.ts`：`attachEventTools(source)` 单次可信挂载；每个 Assignment 按 scope/身份决定是否及挂哪些事件工具；每 run 将事件工具并入原 3 工具预算（超过 4 个在原生 Session 创建前拒绝）；permit/gate/单主调用/authority-key 语义不变。
- `src/control/events/index.ts`：`EventDeliveryCoordinator`（组件 handler 消费与 Agent 背景引用=零模型；continuation 需可信 gate；ack 与 context-loaded 分开；慢/坏消费者有界隔离；deliveryId 至少一次幂等；`registerAgentTarget/retireAgentTarget` 防止退役绑定恢复旧资格；`scan()` 可并入既有单一 BackgroundPump 循环）；`CoreGoalContinuationTarget` 受控续接端口（重读 Goal phase/authEpoch/instance/budget、H1 基准检查后才 dispatch、confirmed context receipt 与 ack 分离）。
- **Lead 集成**：`TaskWorkerDriver` 增加可选 `attachEventTools`；`runtime.ts` 在 durable EventService 之后、任何 task 运行之前挂载 per-Assignment 事件源（失败只记 lastFailure，worker 保持事件零工具）；在既有 BackgroundPump 的单循环 consume 中合并 coordinator scan（`processed+failed===claimed` 保持，不新增第二套循环）。
- 测试：`tests/events-fixtures.ts` + 4 个新测试文件（worker mount 10、四路径 7、生命周期/负例 16、core 续接 10 = 43 项），既有 events/event-tools/background-pump 回归。
- 证据：`artifacts/dsh/h2/h2a-events-offline.json`、`h2a-slice-summary.json`、`artifacts/dsh/slices/h2a-events-verify.json`（实现者隔离）与 `h2a-verify.json`（Lead 独立）。

### 10.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `feecf86` + 9 文件）`npm run check` | exit 0；**1243/1243 通过，0 失败/跳过**；定向事件相关 66/66 |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `00fb75b` + 10 文件=H2a+Lead 集成） | exit 0；**1249/1249 通过，0 失败/跳过**；= 1206 基线 + 43 新测试；证据 `artifacts/dsh/slices/h2a-verify.json` |
| 四类路径（离线合成） | Agent→组件、组件→组件、组件→Agent（background 零模型 / continuation 经 gate）、Agent→Agent（worker 报告→绑定 Agent 目标恰一次原生 context receipt）；伪造 `task.succeeded`/越权 scope/退役投递/慢消费者/双 store 竞争均按预期拒绝或隔离 |
| 证据级别 | G1/G2 离线合成；**不是固定宿主、真实模型或业务验收** |

### 10.3 失败 / unknown / 未测

1. 固定宿主零模型探针：已补零模型探针命令与独立诊断工具（§10.5），宿主调用由 Lead 在联合 reload 执行；此前所有 Agent 证据为合成原生协议替身。
2. 真实 core Goal 续接连线（durable background command + native dispatch 到 core Session）未做；**core 模型可调用事件工具 = H2c 缺口**（依赖 H3 重设计 core 规划/计量）。
3. 时间/条件触发（DSH Schedule ingress）、链深/防循环、配额/背压矩阵、事件目录扩展不在本切片，仍为未测。
4. worker grant 目前按 Assignment scope/身份挂载，每任务 allowlist 细化留后续集成。
5. 无真实模型/embedding/频道/设备/业务动作。

### 10.4 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h2a-manifest.json>
cd plugins/shiyu && node --import tsx --test --test-concurrency=1 tests/events-*.test.ts tests/event-tools.test.ts
```

### 10.5 补充：零模型 worker 工具挂载探针（H2a-probe）

- `workers.ts`：抽出与真实 run 共用的 `mountRestrictedSurface()`，新增 `WorkerSessionDriver.probeEventTools()`——创建一次性 `shiyu-worker-probe-<uuid>` 受限 Session（`WORKER_PRESET_ID`、固定占位任务工具 + 受信事件工具源），读取真实装配的 tools 摘要（name/description/parameters/source），递归拒绝 actor/permit/scope/taskId/assignmentId/principalId/authorization/ownerId/budget 等授权字段，通过 session/event + agent/request + llm/stream 三重检测模型活动并要求全部计数为 0；不 followup、不请求模型、不建业务 Task/binding/event；abort/迟到 handle 均 cancel+dispose，创建/source 畸形/模型活动/释放失败显式失败不重试。
- `runtime.ts`：新增 `runtime.probe-event-tools` 零模型只读命令（准入与 `session.probe` 一致：全局暂停拒绝、共享操作槽、可中止、不重试）；回执缓存到 `snapshot().diagnostics.eventToolProbe`，不发布事件、不写业务库。
- `index.ts`（Lead 集成）：抽出并导出 `statusTool`/`workerToolDiagnosisTool` 供单测，注册独立诊断工具 `shiyu_diagnose_worker_tools`（无参数、非并发安全），执行且仅执行 `runtime.probe-event-tools`；描述明确“零模型诊断、不执行任务、不发送、不写业务库”。
- 测试：`events-zero-model-probe` 6 + `events-runtime-probe` 3 + `host-diagnostics-tool` 2。
- 验证：Lead 隔离 worktree（HEAD `d7dd731` + 5 探针文件）**1297/1297 通过、0 跳过**（1288 + 9）；随后加入 Lead 工具封装（+2）再次隔离验证（证据 `artifacts/dsh/slices/h2a-probe-final-verify.json`）。
- 宿主调用规格与期望回执、停止条件、不能外推的结论见 `artifacts/dsh/h2/h2a-probe-slice-summary.json` 与 `h2a-events-offline.json` 的 `zeroModelProbeDesign`/`hostProbeChecklist`；固定宿主调用本身在联合零模型重载中执行或明确保留为未测。

## 11. H0c 切片：S/FL 业务测试集骨架

状态：**离线通过（G1 工具自证 + 合成 fixture/答案集骨架）**；0 产品/宿主/模型/Lab/渠道运行，**不能用于业务验收**，也不是 HOLDOUT。2026-11-02 完成并审阅。

### 11.1 交付（14 新文件 + 2 README 更新 + 42 artifact）

- `tests/harness/business/`（11 模块）：S01–S08/FL01–FL08 场景目录、fixture 生成、独立答案集、四类允许结果、DEV/REG/HOLDOUT 拆分策略、H1–H8 判定与聚合、覆盖索引。
- `tests/harness/fl-scenarios.ts`、`scripts/harness/fl-scenarios.mjs`（启动器/CLI）、`tests/harness-business.test.ts`（主 glob 15 项）；更新两个 harness README。
- `artifacts/dsh/harness/fl-scenarios/` 37 文件：16 个公开 DEV fixture、16 份独立答案集（答案侧冻结、`derivedFromProductOutput=false`、`historicalSamplesReused=false`、评估 canary 只在答案侧）、manifest/coverage/scoring 骨架；同时刷新 H0b 5 件 artifact（新 harness 文件使旧 self-proof stale）。
- 关键事实：16/16 场景物化、65 个代表步骤；历史设计 80 步中 27 步未物化并逐条列出；12 份历史 case 文档步骤计数逐项核对（54/26）；FL02/06/07/08 标 `matrix-only` 并新写 3 步代表轨迹。DEV=16、REG=0、**HOLDOUT=0（reserved_not_materialised）**，历史有限样本禁止升级。
- 判定：H1–H8 零容忍不可平均；功能里程碑按场景报 achieved/applicable（零分母 ratio=null 不冒充满分）；相处质量 5 维分别保留、无总分；输出 planned/executed/passed/failed/unknown/skipped/notRun/notApplicable；空运行骨架 `undecidable`、`businessAcceptance=not_claimed`、`totalScorePresent=false`。
- 覆盖索引：16 行 + 10 项缺失资产（FL02–08 case、未物化步骤、变体、噪音/1,000 负载、HOLDOUT、双人标注、运行证据、附件语料、B0/R1 映射、canary 实面），`cannotUseForBusinessAcceptance=true`。

### 11.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `feecf86` + 仅 H0c）`npm run check` | exit 0；**1216/1216 通过，0 失败/跳过**；`manifest→selfproof→traceability --strict→fl-scenarios --require-selfproof` 链 exit 0 |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `a80c33d` + 仅 58 个 H0c 文件） | exit 0；**1264/1264 通过，0 失败/跳过**（= 1249 已提交基线 + 15）；证据 `artifacts/dsh/slices/h0c-verify.json` |
| 自证 | harness 套件 **57/57**（H0b 42 + H0c 15），0 skip；H0c 7 个 oracle 共 43 known-verdict（12 accept / 31 reject）；负例自证覆盖隐藏硬违规、unknown/skip 计通过、质量抵消功能失败、伪造分母、零分母满分、总分、历史样本升级 |
| 覆盖追踪 | 产品行仍 79/79 **not_covered**；`tooling_ready` 不冒充通过；H0c 场景状态 `synthetic-fixture-only-not-run` |

### 11.3 失败 / unknown / 未测

1. **不能用于业务验收**：0 产品/宿主/模型/Lab/渠道运行；不是 HOLDOUT、无盲评、无质量分。
2. 27 个历史设计步骤未物化；65 代表步骤不是 80 步全量，也不是 80 个独立统计样本。
3. FL02/06/07/08 无历史 case，其 3 步为新写代表轨迹；变体只冻结规格未生成；噪音 0/16/76、1,000 负载、附件语料、B0/R1 映射未生成。
4. 答案冻结/反回填是“可观察形态”守卫，不证明作者从未看过输出（需真实流程隔离）；同机目录不是秘密隔离。
5. H0b 刷新件在 `feecf86 + 未提交 overlay` 的隔离 worktree 生成（vcs dirty=true 如实记录）；clean-VCS 重生成可留作后续增量。

### 11.4 复现

```
cd plugins/shiyu
node scripts/harness/fl-scenarios.mjs --require-selfproof
node --import tsx --test --test-concurrency=1 tests/harness-business.test.ts
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h0c-manifest.json>
```

## 12. 证据卫生与 H4/H4b/H5 已提交证据独立复核

2026-11-02，独立验证员对已提交的 H4/H4b/H5/H4-host/H4b-host/H0b 证据做了只读复核（task-13）：**真实性通过，未发现伪造、静默跳过、把实现当 oracle 或未跑写通过**。完整报告见 [H4H5-EVIDENCE-REVIEW.md](<artifacts/dsh/verify/H4H5-EVIDENCE-REVIEW.md>) 与 [h4h5-evidence-review.json](<artifacts/dsh/verify/h4h5-evidence-review.json>)：30 项检查 29 verified / 1 finding / 0 rejected，10 条 findings、7 条未观察项。

复核要点：
- 文件/日志 SHA256 全部与对应 commit blob、声明计数一致（H4 21 文件 1088/1088、H4b 7 文件 1206/1206 + UI 209/209、H5 18/19 文件 1063/1062/1 既有 pinned-Python 条件 skip、H5 slice 1096/1096、H0b slice 1201/1201、H0b TAP 145 known-verdict 41/104）。
- 宿主审计链一致：两轮 reload 的 commitSeq 291→302→308、stateVersion 5→6→6、capability 8→10→12、hostEpoch 重绑；Task/Goal/Lab/预算/Effect/17 Session/state 文件不变；after-tool 仅 capturedAt 变化；events 36/37/38 都是对应 reload 的 `runtime.lifecycle.changed`。dist provenance 用 `git archive` 独立重建两轮 digest（`647aaa7f…`、`bff93a84…`）一致。
- H5 边界未被夸大（G1 离线+合成端口、未接 Runtime/宿主、V22 仅子场景、V27 未尝试、RPO/RTO/独立故障域未验）；traceability 产品行仍 79/79 not_covered。

findings 处理：
| ID | 处理 |
|---|---|
| F1 新增证据含绝对 home 路径 | 已修：`scripts/slice-verify.mjs` 从生成处脱敏 `<home>/<repo>`；11 个已提交 slice/证据文件内 `/Users/caja` 统一替换 `<home>`；H4 手写 reproduce 命令同期脱敏 |
| F2 host audit `sessions.files[].relativePath` 含编码 home 片段 | 接受为既有惯例（无绝对路径、无正文）；后续导出会脱敏 relativePath |
| F3 两轮 host 证据 `payload.bytes` 是字符数而非字节数 | 已修：改为实际文件字节数并注明语义（sha256 原本正确） |
| F4 H4b 未披露 unknown Task 元数据启动刷新 | 已补披露：version 25→26、updatedAt=本次 reload；状态/计数/不重试/不宣告成功不变 |
| F5 host 审计缺 task version/updated 摘要 | 工具前景已修：`scripts/host-state-audit.mjs` 现输出逐 Task version/updatedAt/state/uncertaintyReason；已提交的旧 host 快照未重跑，H4 的 24→25 由 H4b 披露 + 只读 DB 三角佐证；如需旧快照直接可核需另立一次零模型 host audit 批次 |
| F6/F7 实现者日志仅在 /tmp、H4b 日志未声明 sha/bytes | **F6 已修**：H5 三份全量日志已归档到 gitignored `.local/h5-verify/`，`h5-verification.json` 增加 `archivedCopy{path,sha256,bytes,matchTransientLog}` 与 `logDurability`（归档哈希与原件一致，复核通过）；F7（H4b 日志未声明 sha/bytes）记录为已知限制，后续切片统一声明 |
| F8/F9/F10 matrix observed 叙述、oldDist 语义、H0b dirty overlay | info 级披露；H0b/H0c artifacts 可在最终批次干净 HEAD 上重生成 clean-VCS 指纹 |

说明：F6 已修复并复核通过；F7 属于可审计性不足而非证据造假，本记录保留该限制，不把临时日志当作首选证据。独立复核员随后在 `H4H5-EVIDENCE-REVIEW.md`/`h4h5-evidence-review.json` 增加了 §7“复核快照边界”、§8“F1–F6 修正验证”与逐 finding 的 `postReviewStatus`，作为 F1–F6 处置的持久记录。

## 13. H4c 切片：replyer 上游生成路径接入内层四域参考

状态：**离线通过（G1 模块 + 真实临时 SQLite/Worker IPC + 确定性断言）**；真实模型/生成质量/宿主与 Lab 内层路径未验。2026-11-02 完成并审阅。

### 13.1 交付（2 文件）

- `src/control/local-reply.ts`：在既有 primary capture 之外另发一次 `purpose:'reply_context'` + `innerDomains:[relationship,emotion,cognition,personality]` 的 **metadata-only capture**（同 Worker/会话/受众）；按固定策略选出有界 eligible recordIds（每域 ≤6、kind 白名单、evidenceState=valid 且 bodyAvailable，排除 superseded/digested/resolved/reverted/merged/tombstoned/rejected 等），仅对这些 id 调 `view.readInnerBodies` 读正文；prompt 前与 ready/loaded 前各一次 `validateCapture(phase:'ready')` 新鲜重验。
- `INNER_REFERENCE_POLICY` / `INNER_REFERENCE_MARKER` / `buildInnerReference`：固定域序（relationship→emotion→cognition→personality）、固定 record 键序、payload 递归排序、无时间戳/viewId（同状态字节可复现）；caps 6/域、1024B/条、1536B/域、4096B/块、sources≤4；`readOnly:true, authorization:'none', completionFact:false, scope:'current-audience'`；`omitted` 显式计数 degraded/revoked/inactive/unreadable/overBound；缺失/不可用域显式 reason（Lab 路径 `lab_reply_capture`，不静默）。块放在既有“获准资料：”之前；`\n本轮用户输入：\n` 定界符与 `inputHash=sha256(原始用户文本)` 不变。
- 既有生成路径不变式保持：同 Session 复用、零工具、单主调用、maxTokens/预算/期限、ReadView+Conversation 双校验、草稿新鲜度均未变；无新增模型/embedding 调用。
- 测试：`tests/local-reply.test.ts` 25→32（+7）：正例、确定性（两次执行字节相等）、跨受众裁剪、撤回/降级、超限（9→6、overBound、总字节 ≤4096）、篡改/缺 authority、不可用域、personality 域损坏仍完成回复且显式 unavailable。

### 13.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `00fb75b` / `a80c33d` / `c6a3f05` + 2 文件） | 分别 1213/1213、1256/1256、1271/1271，0 失败/跳过 |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `41c496b` + 仅 2 文件） | exit 0；**1271/1271 通过，0 失败/跳过**（基线 1264 + 7）；证据 `artifacts/dsh/slices/h4c-verify.json` |
| 证据级别 | G1 离线模块 + 真实临时 SQLite/Worker IPC；真实模型与生成质量未验 |

### 13.3 失败 / unknown / 未测

1. 真实模型生成、provider 缓存/费用、模型实际如何使用内层块未测；6 条/域与 4096B 上限对答案质量的影响未评估。
2. `conversation.reply.prepare` JSON 合同未扩展显式 inner 来源字段（该命令在 control-store）；当前以双 capture + 两处 `validateCapture(phase:'ready')` 绑定新鲜度。若需显式字段，另开 H4d 扩展 control-store 合同与 ReadView authority。
3. Lab reply capture 合同不请求 `innerDomains`，Lab 路径显式 inner unavailable（行为未改变）。
4. tombstoned 身份在 capture 元数据中消失，不能计入 omitted（degraded/revoked 可计数）。
5. 无宿主 reload、真实频道/设备；H4b 宿主可见性证据不由此切片新增。

### 13.4 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h4c-manifest.json>
cd plugins/shiyu && node --import tsx --test --test-concurrency=1 tests/local-reply.test.ts
```

## 14. H3 切片：core 受控规划、多步任务与重规划

状态：**离线通过（G1 模块/属性 + 真实临时 SQLite/Worker 域）**；真实宿主/模型、更多已授权能力、dashboard 投影未验。2026-11-02 完成并审阅。

### 14.1 交付（7 文件）

- `src/contracts/core.ts`：`CorePlanDraft/Version/Snapshot/StepView/StopConditions/PlanFactRef|Status`、`plan_candidate` 候选、`CoreGoal.planVersion+plans`（≤16）、`CoreEvaluation.plan`、回执 `planVersion/stepRefs`、只读 `core.plan` 命令、共享 `CORE_KNOWN_REJECTIONS`。
- `src/adapters/control-store/core-domain.ts`：计划结构/范围/依赖/事实/核验器/停止条件严格校验；`basePlanVersion` CAS + proposal 幂等 + 旧候选 `CORE_PLAN_STALE`；计划版本含 evaluationId/proposalId/triggerRefs/reasoningRefs/facts/planHash 可追溯；facts 为 resolved/pending/conflict/unknown/unsourced，命名不存在的事实/推理引用整候选拒绝；ready 步骤按依赖与 `maxParallelSteps≤2` 确定性 admit（同事务，失败整体回滚，沿用 Task/Mandate/fence）；失败/冲突/容忍失败进入 `plan_stopped_*` / `plan_waiting_fact` / `plan_tolerated_failure`；`evaluation_unknown` 与 `evaluation_active` 拆分；未知 round 跨租约/唤醒/重开不重跑；legacy `task_intent` 仅在未接纳计划前可用（否则 `CORE_PLAN_REQUIRED`）；`core.plan` 纯读；未知命令显式 `UNKNOWN_CORE_COMMAND`。
- `src/control/local-core.ts`：确定性 prompt（固定字段顺序/递归排序、排除 volatile viewId/generatedAt、计划+事实目录 sha256 摘要、计划 schema；保留既有“获准资料/能力资料”解析），计划候选仍在 H1 单 step/request/stream + 零工具边界内完成。
- `src/control/core-pump.ts`：`planVersion` 观察与校验（非法值 degraded，不触发第二次评估）。
- 测试：`tests/core-plan.test.ts` 12、`tests/local-core.test.ts` +4、`tests/core-pump.test.ts` +1（净增 17）。
- 无 runtime.ts/goals.ts/core-decision.ts/worker.ts 强制改动；`core.*` 泛化分发自动覆盖 `core.plan`。

### 14.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `41c496b` + 7 文件）`npm run check` | exit 0；**1281/1281 通过，0 失败/取消/跳过**（= 1264 + 17） |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `c00c6a9` + 仅 7 文件） | exit 0；**1288/1288 通过，0 失败/跳过**（= 1271 + 17）；证据 `artifacts/dsh/slices/h3-verify.json` |
| 正例 | 依赖顺序、并行独立步、Task 结果后修订续跑、停止条件下完成、pending→resolved 事实跨 Task 结果、1000× `core.plan` 不写库、同状态 prompt 字节一致 |
| 负例 | 非法 JSON/结构、越权字段（tool/budget/mandate）、未授权/漏覆盖交付项、未知/环依赖、owner 依赖乱序、未来源事实/引用、旧计划 CAS、超额并行/失败额度、错误 verifier、超限计划；worker 错误产物+自述完成被 `CORE_COMPLETION_UNPROVEN` 拒绝且 native Goal 未完成；迟到旧 evaluation/task permit 无法重获资格；撤销/禁用能力阻断；未知 round 租约到期/重开不重跑；安静期 0 模型调用、重复触发不产第二计划/第二次调用 |
| 证据级别 | G1 模块/属性 + 真实临时 SQLite/Worker 域；不是宿主/模型/业务验收 |

### 14.3 失败 / unknown / 未测

1. 真实 DSH 宿主/native Session/Goal round、真实模型（dsv4.1f 产计划 JSON 的稳定性/拒绝行为/prompt cache）、embedding 均未执行。
2. 无 runtime/dashboard 集成；建议 Lead 显式投影 `planVersion`/最近计划摘要（不要把 plans 全史放进 snapshot）。
3. 计划步骤当前只绑定现有固定 local-note 能力；更多已授权能力需各自固定 adapter 准入。
4. 真实 worker 并行执行/槽位、事件源事实（待 H2）、压缩/长历史交互、计划历史归档策略、多 Goal 真实定时器并发均未测。
5. H2c（core 事件工具）复用本切片计划契约/状态机，但需重新声明单轮计量边界。

### 14.4 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h3-manifest.json>
cd plugins/shiyu && node --import tsx --test --test-concurrency=1 tests/core-plan.test.ts tests/local-core.test.ts tests/core-pump.test.ts
```

## 15. H6a 切片：通用渠道接入基础（身份/去重/受众/修订）

状态：**离线通过（G1 模块/集成 + 真实临时 SQLite/Worker IPC）**；真实平台/账号/设备/发送与完整 Lab/S/FL 未验。2026-11-02 完成并审阅。

### 15.1 交付（11 文件）

- `src/contracts/channel.ts`：15 个 `channel.*` IPC 命令类型、可信视图、水位与失效信号类型；明确“可信信封 vs 不可信正文”。
- `src/control/ingress/index.ts`：纯规范化/校验——connection/conversation/participant/message 身份派生、sourceEventId 组合去重键、revision 决策、`InnerAccount`/`ConversationKey` 映射、严格白名单与防御上限。
- `src/adapters/control-store/ingress-domain.ts`：真实 SQLite 持久账本（连接/参与者/会话/受众/消息/修订/接纳/冲突/失效/删除/撤权/两段式捕获），共享既有 `SqliteTransactions` 单连接单事务。
- `worker.ts`/`protocol.ts`：仅增量接线（+18 行），既有命令语义不变。
- 测试 5 文件 + fixture（37 项）：identity 9、ingress 12、audience 8、conversation/relationship 集成 4、真实 Worker IPC 4。
- 证据：`artifacts/dsh/h6/h6a-channel-ingress.json`、`h6a-slice-summary.json`、`h6a-slice-verify.json`（实现者放置于 h6/）、`artifacts/dsh/slices/h6a-verify.json`（Lead 独立）。

### 15.2 关键设计

- **身份**：全部由注册时可信适配器元数据派生；显示名/正文声明不参与；跨账号同短 ID 永不合并，同名可并存；正文只允许 contentHash/bodyRef/≤512B summary/≤8 attachment refs，不能增加信封字段或角色。
- **去重/修订**：唯一键 `(namespace, account, conversationRef, sourceEventId)`；同键同指纹=duplicate 返回原 intakeSeq，同键异指纹=持久冲突拒绝；显式 nativeEventId 跨会话复用=`SOURCE_EVENT_CONFLICT`；revision 严格递增才 apply，旧 revision stale 不覆盖；撤回/删除为终态墓碑（清正文引用、留 digest/来源/revision、推进删除水位与失效信号，不可复活）；100 事件×10 重送交错=100 facts/900 duplicate。
- **受众**：DM 固定单一 counterpart；group/channel 可替换成员集合 + audienceVersion CAS；成员移除逐人撤权水位；`revokeAccess(participant|conversation)`；同步 `onInvalidation` sink + 拉取式 `invalidationsAfter`；sink 抛错与受众变更同事务回滚（用真实 ConversationStore 验证旧 draft 变 STALE_CONTEXT）。
- **正文两段式**：`captureAudience` 只出 metadata；`readContentRefs` 重校验 capture 过期、当前 audienceVersion、快照 revision、终态后才返回可信引用；跨受众 messageId 一律 `CROSS_AUDIENCE`；控制库不存正文。

### 15.3 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `d7dd731` + 11 文件）`npm run check` | exit 0；**1325/1325 通过，0 失败/取消/跳过**（= 1288 + 37） |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `6f600f4` + 仅 11 文件） | exit 0；**1336/1336 通过，0 失败/跳过**（= 1299 + 37）；证据 `artifacts/dsh/slices/h6a-verify.json` |
| 定向 | identity 9 + ingress 12 + audience 8 + conversation 集成 4 + worker IPC 4 = 37/37；既有 ControlStore 回归 77/77 |
| 负例 | 伪造 envelope/正文提权、跨账号短 ID、旧 revision 覆盖、删除复活、跨受众捕获、capability=false 假删除、CAS 冲突、批次原子性、上限背压、sink 失败回滚 |
| 证据级别 | G1 离线合成 SQLite + 真实 Worker IPC；不是真实平台/宿主/业务验收 |

### 15.4 失败 / unknown / 未测

1. 真实平台适配/凭据/回执、发送与 Effect、原生 Session/草稿消费、仪表盘/HTTP/UI、Lab 房间复用、长跑/崩溃窗口/迁移均未做；真实平台与完整 S/FL 仍缺用户资源范围。
2. Runtime 集成点（Lead）：持久 `channelRef→conversationId` 绑定、把 `onInvalidation` 桥接进 ConversationDomain、仪表盘只读投影、`toConversationKey`/`toInnerAccount` 映射到 Conversation/Lab/Relationship。
3. 仅离线合成 SQLite + 真实 Worker IPC；无真实渠道、模型或 embedding 调用。

### 15.5 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h6a-manifest.json>
cd plugins/shiyu && node --import tsx --test --test-concurrency=1 tests/channel-*.test.ts tests/ingress-worker.test.ts
```

## 16. 联合固定宿主零模型验证（最终构建，2026-11-02）

状态：**固定宿主零模型限定通过**（启动/发布/只读工具/受限工具挂载/无重放），不是 V24 或业务验收。代码 HEAD `3b25e1b`，dist 由该 HEAD 的隔离 worktree 构建（101 文件，digest `ce295911…`），一次有序 disable→enable。

### 16.1 观察结果

| 项 | 实际 |
|---|---|
| 插件启动 | 新实例 `18322852…` 启动于 `2026-11-02T20:12:48.788Z`；全局 paused=false |
| `shiyu_status` | 返回有效无损 JSON（payload 54,095 字节，SHA256 已冻结）；`innerProjection.manifest.schemaVersion=4`、六域 available（memory/relationship/emotion/cognition/personality/ability，backend/authority/capabilities 不变）；`systems[].inner.summary` 为如实文案（旧“关系、情绪、认知、人格待接入”已消失） |
| `shiyu_diagnose_worker_tools`（本次新增诊断工具） | ok=true、zeroModel=true、readOnly=true、sent=false；装配工具恰为 `shiyu_worker_probe_task`（assignment）+ `shiyu_worker_event_types`/`shiyu_worker_event_report`（event）；`assignmentTools`/`eventTools` 分离；`authorityFields=[]`；counters 全 0（modelRequests/modelStreams/assistantMessages/userMessages/toolEvents/usageEvents）；released=disposed=true；探针 Session `shiyu-worker-probe-940b80a0…` 已释放/归档；宿主工具列表中 shell/工作区等仅存在于宿主侧，未挂入受限 surface |
| 重载增量 | commitSeq `308→315`（+7 启动生命周期/能力 hostEpoch 观察写入）；events `38→39`（+1 runtime.lifecycle.changed 及其投递 ack）；stateVersion 保持 6；capability revision `12→14`（hostEpoch 重绑 + availability 观察），enabled/available 保持 true/available，verification 仍 unknown；definitionDigest 由 `1f9c5911…` 变为 `5a591515…`——稳定实现身份覆盖了变化的 worker 执行面（mountRestrictedSurface/探针），这是预期变化，未伪造成功证明 |
| 业务事实 | Task 3（2 succeeded/1 unknown，unknown 元数据版本 26→27 为启动恢复元数据刷新）、Goal 2、Lab 3 disconnected、预算 24（21 settled/3 unknown）、Effect 13 全部不变；17 个已知自有 Session 文件 bytes/SHA256 逐字节不变 |
| 工具调用只读性 | `shiyu_status` 与诊断工具调用前后：commitSeq `315→315`、events `39→39`、deliveries `38→38`、stateVersion/capability revision 不变、runtime-state 文件 SHA256 不变 |
| 会话增量 | 唯一新增文件 = 探针诊断会话 `shiyu-worker-probe-940b80a0…/session.v4.jsonl.zstd`（已释放/归档）；无其他新增/变更 |
| 模型/外部调用 | 产品 0 模型/0 embedding/0 Task/0 Goal 操作/0 Lab 输入；探针 counters 全 0 |

证据：[final-joint-zero-model.json](<artifacts/dsh/host/final-joint-zero-model.json>)、[shiyu-status-final-build.json](<artifacts/dsh/host/shiyu-status-final-build.json>)、[worker-tools-diagnosis-final-build.json](<artifacts/dsh/host/worker-tools-diagnosis-final-build.json>)、before/after/after-tools 只读审计（同目录）。

### 16.2 边界与未测

1. 零模型证据只证启动、发布、只读工具与受限**挂载/不可伪造字段/释放**；不证真实模型调用事件工具、provider 预算/缓存、真实 Task/Goal 续接或 H3 计划在真实模型下的执行。
2. 真实浏览器 DOM 渲染未由 JSON 观察证明；合成宿主 UI 是独立证据层。
3. 诊断探针每次调用会创建并释放一个原生诊断 Session 文件（预期副作用，不可作为业务路径）；17 个已知业务 Session 未变。
4. lifecycle=degraded 仍来自保留的历史 unknown/暂停业务事实，不是本轮新失败。

## 17. 第二轮独立复核与证据修正（H2a-probe/H3/H4c/H6a/H0c/联合宿主）

2026-11-02，独立验证员对提交 `6f600f4`(H2a-probe)、`3b25e1b`、`d7dd731`(H3)、`c00c6a9`(H4c)、`8b34d66`(H6a)、`7bd962c`(H0c)、`a68eeb2`(联合宿主) 做了只读复核（task-18）：**证据真实性通过，未发现伪造、静默跳过、未跑写通过；边界陈述诚实**。32 项逐项检查结论、计数/日志表、联合宿主审计链与 G1–G11 findings 见 [H2-H6-EVIDENCE-REVIEW.md](<artifacts/dsh/verify/H2-H6-EVIDENCE-REVIEW.md>) 与 [h2h6-evidence-review.json](<artifacts/dsh/verify/h2h6-evidence-review.json>)。

复核复算要点：H2a-probe 1299、H3 1288、H4c 1271、H6a 1336、H0c 1264 的隔离日志 sha/bytes/计数全部匹配；H0c committed TAP 57 tests/188 known verdicts、7 oracles/43 verdicts 与声明一致；traceability 产品行 79/79 not_covered 未被误升级；联合宿主 commitSeq 308→315→315、events 38→39→39、deliveries 37→38→38、stateVersion 6/6/6、capability 12→14、hostEpoch 重绑、17 个已知 Session 完全不变、仅新增一个已释放 probe Session；dist `ce295911…`（101 文件）与 definitionDigest `1f9c5911…`→`5a591515…` 均由复核者独立重建复现。

findings 处理（均 minor，不推翻结论）：

| ID | 处理 |
|---|---|
| G1 H3 证据引用 stale（slice/log 哈希与保留日志不一致） | 已修：`h3-core-planning-offline.json` 的 evidenceFiles 重新绑定到保留的 Lead 1288 运行哈希；实现者 1281 全量日志被覆盖，标记 superseded（计数保留为历史）；`h3-slice-summary` 同步注明 |
| G2 H6a summary 实现者日志路径/哈希错误（截断） | 已修：指向 committed `artifacts/dsh/h6/h6a-isolated-check.log` 完整 SHA（`74c2859f…`/144652B）；Lead 日志独立记录（`2c2e6135…`） |
| G3 H2a-probe 保留 stale 1297 中间记录 | 已修：标记 superseded（最终 1299 为权威） |
| G4 H0c 1216 首跑 superseded 且日志仅 /tmp | 已修：标记 superseded；两份日志归档到 gitignored `.local/h0c/` 并记录完整 SHA/bytes（`1771a15a…`/132654、`a5ff12ab…`/1894） |
| G5 H4c 测试算术 “26+6” | 已修：改为 25 既有 + 7 新增（32 总数不变） |
| G6 联合宿主 payloadBytes 为字符数 | 已修：改为实际文件字节 54,096 并注明 bytesSemantics |
| G7 未披露 unknown Task 元数据启动刷新 | 已补：version 27、updatedAt=20:12:48.893Z、state 仍 unknown、无重试/无成功声明 |
| G8 committed raw audits 的脱敏未说明 | 已补：与 .local 原件唯一差异是 home/data-root → `<home>` |
| G9 编码 session relativePath | 已补披露：无绝对路径/无正文/无秘密，沿用既有 host 证据惯例；后续导出脱敏 |
| G10 host 级 eventToolProbe 缓存未观测 | 记为 unobserved：捕获的 status 在 diagnosis 之前；代码+离线测试覆盖，待未来零模型 host 批次补 post-probe status |
| G11 traceability oracle 口径 15 vs 22 | H7-prep（task-17）在 traceability 注明 oracle corpus 口径（H0b 15 + H0c business 7） |

未观察项：未独立重跑五套件（以日志/哈希/计数+断言审阅+Lead slice-verify 二次执行为证）；host 无 provider 网络 trace；H3 真实模型 plan、H4c 真实模型消费、H6a 真实平台、H0c 业务验收均未测，证据已声明。

## 18. H4d 切片：reply prepare 显式 inner 来源与 Lab 内层路径

状态：**离线通过（G1 模块/属性 + 真实临时 SQLite/Worker IPC）**；真实模型/真实 Lab 房间/宿主未验。2026-11-02 完成并审阅。

### 18.1 交付（4 文件 + 2 证据）

- `src/adapters/control-store/local-reply-domain.ts`：`conversation.reply.prepare` 新增可选、body-free 的 `innerSources` 合同：schemaVersion/policyVersion/captureId + 固定四域顺序的 `{domain,status:included|empty|unavailable,reason?,authority:{backendId,authorityId,installationGeneration,policyVersion,tombstoneWatermark,baselineId}|null,records:[{recordId,revision,evidenceState,recordDigest}≤6]}`。封闭校验（未知字段/正文/payload/grant/permit、域序、digest、revision 全拒），通过 `validateCapture(innerCaptureId,'prepare')` 回查真实 capture 逐项比对 authority/record revision/evidenceState/recordDigest，不符→`STALE_INNER_CONTEXT`；字段写入 operation 持久记录，`conversation.reply.get` 原样回读，重开库仍在；重复 prepare 被拒且零状态/零 commitSeq 变化；`current(operation,phase)` 在 prepare/ack/ready 回查 inner 摘要，撤回/降级拒绝；Lab 路径只对 `EXPIRED` 容忍 30s 快照/120s permit 时间边界，provenance 变化仍拒绝。
- `src/control/local-reply.ts`：`buildInnerSources` 从同一次 metadata capture + 两段式 body 读取生成摘要并随 prepare 提交，并逐字节比对 Worker 回包确保“prompt 嵌入 = 持久准备”；Lab reply 不再一律 unavailable，改为同会话只读 `captureLocal{innerDomains}` + `readInnerBodies`（同 INNER_REFERENCE_POLICY/确定性/受众裁剪/不可用显式），Permit-bound `captureLabReply` 合同、Permit、预算、发送语义零变化；Lab ready 前重新派生内层块逐字节比较（变化→`INNER_REFERENCE_CHANGED`）。
- 测试：`tests/local-reply-domain.test.ts` 13→20（+7：持久/回读/重开、幂等、旧记录 not_provided、封闭负例、撤回/降级拒绝、Lab 时间边界、跨会话 capture 拒绝）；`tests/local-reply.test.ts` 32→34（+2：本地 prompt 与持久摘要对齐/生成期撤回不 ready；Lab permit 正例仍单主调用、无额外发送/预算）。
- 证据：`artifacts/dsh/h4/h4d-prepare-inner.json`（文件/日志 SHA、verifierChecklist、边界）；`h4c-replyer-inner-context.json` 按 G5 修正描述性算术（25+7），并同步修正 `h4c-slice-summary` 残留字符串。

### 18.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `a68eeb2` + 仅 4 文件）`npm run check` | exit 0；**1345/1345 通过，0 失败/取消/跳过**（= 1336 + 9）；日志 `.local/h4d-check-final.log` SHA256 `911b8e7a…`/146824B |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `7f354ac` + 仅 4 文件） | exit 0；**1345/1345 通过，0 跳过**；证据 `artifacts/dsh/slices/h4d-verify.json` |
| 定向 | local-reply-domain 20/20、local-reply 34/34、reply/lab 邻接 116/116 |
| 证据级别 | G1 离线模块 + 真实临时 SQLite/Worker IPC + prompt 确定性；无宿主/模型/真实 Lab 房间 |

### 18.3 失败 / unknown / 未测

1. 真实模型如何使用显式 inner 来源块、Lab 真实房间与发送/预算未验；Lab permit-bound capture 仍未携带 inner 元数据（如需扩 ViewDomain/Lab 合同另开切片）。
2. `innerSources` 只是摘要（不含正文），旧记录缺字段只表示 `not_provided`，不能反推当时无内层数据。
3. 30s 读取快照/120s permit 的时间边界仅在 Lab 路径按 `EXPIRED` 容忍，其他 provenance 变化仍拒绝；未做长期时钟/暂停/恢复组合。
4. 未改 runtime.ts/index.ts/client/dsh adapters/view-domain 核心；无宿主/模型声明。

### 18.4 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h4d-manifest.json>
cd plugins/shiyu && node --import tsx --test --test-concurrency=1 tests/local-reply-domain.test.ts tests/local-reply.test.ts
```

## 19. H6b 切片：渠道域→Runtime 桥接（绑定/失效/投影）

状态：**离线通过（G1 模块/集成 + 真实临时 SQLite/Worker IPC）**；Runtime/worker 生产装配与固定宿主快照未落地（Lead 集成），真实平台/发送未验。2026-11-02 完成并审阅。

### 19.1 交付（6 文件 + 证据）

- 新增 `src/control/channels/{bridge,index}.ts`：`ChannelRuntimeBridge`（host 侧）提供 `bindChannel`（`conversation.channelBind`：幂等、并发单行、`expectedBindingVersion` CAS 改绑、跨 scope/未授权/伪造 ref/无效或归档 conversation 拒绝）、`bindings` 读取、`bridgePending`（`channel.invalidationsAfter` + applied watermark 幂等，重启/重跑不重复）、只读 `ChannelRuntimeProjection`（status/watermark/bindings/connections/conversations/pending/degraded；无正文/summary/bodyRef/参与者文本；lossless JSON；100 次刷新 commitSeq 不变；conversation 域缺失显式 degraded 而非空成功）。
- `conversation-domain.ts`（+174）：新表 `shiyu_channel_conversation_bindings`、3 个 `conversation.channel*` IPC 命令、同 Worker `bridgeChannelInvalidation`。
- `ingress-domain.ts`（+14）：仅 `setInvalidationSink` 与 emit 一次调用，H6a 语义/命令不变。
- 失效桥：sink 在受众/删除变更**同一事务**内调用；经 `ConversationStore.invalidateAudience`（audienceVersion++、reply sessionEpoch++）使真实旧 draft `STALE_CONTEXT`；sink 抛错时 channel 变更+失效账本+conversation store 一起回滚；未绑定频道 no-op。
- 身份映射：`channelConversationKey`/`toConversationKey` 产出既有 ConversationKey 精确形状并与绑定同事务 `ensureConversation`；`channelParticipantAccount`/InnerAccount 经契约校验后喂 `relationship.registerSubject`（跨账号同短 ID/同显示名→两个 entity，同 tuple 幂等）。
- 测试：`tests/channel-bridge.test.ts` 9 + `tests/channel-bridge-worker.test.ts` 7（真实 Worker IPC）。
- 证据：`artifacts/dsh/h6/h6b-channel-runtime-bridge.json`、`h6b-slice-summary.json`、`h6b-isolated-check.log`、`artifacts/dsh/slices/h6b-verify.json`。

### 19.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `7f354ac` + 仅 6 文件）`npm run check` | exit 0；**1352/1352 通过，0 失败/取消/跳过**（= 1336 + 16）；日志 `artifacts/dsh/h6/h6b-isolated-check.log` |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `11d0c73` + 仅 6 文件） | exit 0；**1361/1361 通过，0 跳过**（= 1345 + 16）；证据 `artifacts/dsh/slices/h6b-verify.json` |
| 定向 | H6b 16/16、H6a 全量 37/37 复跑、既有 ControlStore 回归 97/97 |
| 证据级别 | G1 离线模块/集成 + 真实临时 SQLite/Worker IPC；非宿主/真实平台验收 |

### 19.3 失败 / unknown / 未测

1. Runtime/worker 生产装配未落地：Lead 需在 `worker.ts` 的 ConversationDomain 构造后接 `ingress.setInvalidationSink(...)`，在 `runtime.ts` 构造 `ChannelRuntimeBridge` 并把 `snapshot().channels` 投影接入（可选启动 `bridgePending()` reconciliation）；集成后需另做固定宿主零模型核对。
2. 固定宿主 `snapshot()` 实际输出与 dashboard、真实平台适配/凭据/回执、发送/Effect、原生 Session/草稿消费、Lab 复用、长跑/崩溃窗口/迁移/多 writer 均未验。
3. 仅离线合成 SQLite + 真实 Worker IPC；无真实平台、模型或 embedding 调用。

### 19.4 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h6b-manifest.json>
cd plugins/shiyu && node --import tsx --test --test-concurrency=1 tests/channel-bridge.test.ts tests/channel-bridge-worker.test.ts
```

## 20. H2c 切片：core 受限事件工具与显式单工具轮边界

状态：**离线通过（G1 模块/集成 + 真实临时 SQLite/Worker + 合成 provider loop）**；runtime 集成与固定宿主零模型探针未落地，真实模型/预算/计划质量未验。2026-11-02 完成并审阅。

### 20.1 交付（6 文件 + 证据）

- `event-tools.ts`：`createCoreEventTools` 三个工具——`shiyu_core_event_types`（类型/schema/字段/版本/scope/canPublish/canSubscribe 发现）、`shiyu_core_event_subscriptions`（只读自有订阅与最近投递）、`shiyu_core_event_report`（仅 `agent.observation.reported`）。actor/scope/来源等级/可发类型由宿主注入 principal；参数不得携带 actor/permit/scope/taskId/ownerId 等授权字段；`task.succeeded`、component-only、publisherIds 程序事件拒绝；回执明确“不代表完成/核验/授权/账目/送达”。
- `core-decision.ts`：**显式声明新边界**——无工厂时 H1 历史单 request/stream/零工具路径逐字节不变；有工厂时最多 **1 次事件工具调用、≤2 main request/stream**：request1 → 唯一 tool-call → 精确匹配的 tool/result（callId/name/原始 arguments/原生 message hash）→ request2 → 单一最终文本 JSON 候选。request2 maxTokens = maxTokens − 首次 assistant outputTokens；首次 usage/outputTokens 缺失直接以 unknown 拒绝（不猜、不补零）。重复 tool-call/第二轮/缺失结果/越权参数/暂停撤权显式失败；工具结果只进入模型上下文，不成为 Task/Goal 事实或授权。
- `goals.ts`：受信 `CoreDecisionEventToolFactory` 选项与 core compose 挂载；新增 `probeCoreDecisionEventTools` 零模型探针（专用 `shiyu-core-probe-*` Session、同一受限装配路径、无 followup/模型/Goal 命令、装配读取+authority 扫描+释放/清理显式失败）。
- `local-core.ts`：`eventTools` 选项、确定性 prompt 说明（默认无工具；有挂载时最多一次并需同一轮最终 JSON 候选）、`summarizeCoreDecisionAccounting`（complete 规则、tokens/calls 不补零、`evidenceRef=native-core-usage:<id>:main=<n>:streams=<n>:tools=<n>:results=<n>`）与 `probeCoreEventTools`（沿用 pause 准入语义）。
- 计量可观察：新增 mainModelRequests/mainModelStreams/toolCalls/toolResults/eventToolCalls/toolNames；`modelCalls` 仅在完整覆盖时非 null，否则 null；usage 仅全部主调用完整时 reported，未知时 complete=false 且 tokens/calls 缺省；持久 `core.recordAccounting.calls` 仍是主模型调用数，tool 数编码进 evidenceRef，控制契约不变。
- 测试：`tests/core-event-tools.test.ts` 14 项（provider 契约/宿主身份/只读性、accounting 正反例、types→plan_candidate（2/2、maxTokens [512,505]、汇总 38 tokens、tool 1/1）、无工具路径、report observation、重复/第二轮/未知用量/暂停撤权/越权参数/保留类型/坏 schema/探针清理负例）。
- 证据：`artifacts/dsh/h2/h2c-core-event-tools.json`、`h2c-slice-summary.json`、`artifacts/dsh/slices/h2c-verify.json`。

### 20.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `66a9428` + 仅本切片）`npm run check` | exit 0；**1359/1359 通过，0 失败/取消/跳过**（= 1345 + 14） |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `dfbf93d` + 仅 6 文件） | exit 0；**1375/1375 通过，0 跳过**（= 1361 + 14）；证据 `artifacts/dsh/slices/h2c-verify.json` |
| 定向 | 169/169（新 core-event-tools + 既有 core-goal-sessions/local-core/core-plan/core-pump + events/event-tools/background-pump）；H1/H3 既有测试未改（仅对保留的零工具路径加可观察断言） |
| 证据级别 | G1 离线模块/集成 + 真实临时 SQLite/Worker + 合成 provider loop；非宿主/真实模型验收 |

### 20.3 失败 / unknown / 未测

1. Runtime 集成未落地：Lead 需在 `runtime.ts` 于 EventService 后构造受信 per-Goal factory、传入 `LocalCoreOptions`、新增 owner-only 零模型 `runtime.probe-core-event-tools` 命令与 `snapshot().diagnostics.coreEventToolProbe`（可选诊断工具封装）；不接 factory 时保持 H1 零工具退路。精确 diff 见队友证据 `runtimeIntegration`。
2. 固定宿主零模型探针未执行；真实模型/embedding/host Agent loop、provider 预算/缓存、真实计划质量、第二次 main request 的真实计量未验。
3. core 自建声明式订阅/时间触发（H2b）、链深/配额/背压不在本切片；工具结果只进模型上下文，永不作为权威事实。
4. 仅离线合成 provider loop + 真实临时 SQLite/Worker；无真实模型/embedding/宿主。

### 20.4 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h2c-manifest.json>
cd plugins/shiyu && node --import tsx --test --test-concurrency=1 tests/core-event-tools.test.ts tests/core-goal-sessions.test.ts
```

## 21. Lead 集成：H6b 渠道桥与 H2c core 事件工具接入 Runtime/Worker

状态：**离线集成通过（G1：隔离全量 check + 定向）**；固定宿主新投影/core 探针未验。2026-11-02 完成并审阅。

### 21.1 集成内容

- `worker.ts`：ConversationDomain 构造后安装 `ingress.setInvalidationSink(...)`，把 `channelRef/reasonRef/sourceWatermark` 在同一事务内转给 `ConversationDomain.bridgeChannelInvalidation`；绑定出现后回填引用。这样 H6b 的失效桥在生产 Worker 真正生效（此前只有离线单测）。
- `runtime.ts`：
  - 在 ControlStore 打开后构造 `ChannelRuntimeBridge`，`snapshot()` 增加只读、无正文的 `channels` 投影；
  - 在 EventService 后构造受信 per-Goal `CoreDecisionEventToolFactory` 并传入 `LocalCoreOptions.eventTools`（不接工厂时保持 H1 历史零工具/单请求路径）；
  - 新增 owner-only 零模型 `runtime.probe-core-event-tools`（沿用 session.probe 准入；回执写入 `snapshot().diagnostics.coreEventToolProbe`）；
  - H2a 的 worker 探针命令保持。
- `index.ts`：导出并注册 `shiyu_diagnose_core_event_tools`（无参数、非并发安全），执行且仅执行 `runtime.probe-core-event-tools`。
- 测试：`channel-bridge-worker` 适配“Worker 已内置同事务 sink”的新行为（pull 路径用绑定后仍有 pending 的频道覆盖）；`host-diagnostics-tool` 增加 core 诊断命令契约。

### 21.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| Lead `scripts/slice-verify.mjs`（HEAD `26bda0e` + 仅 5 个集成文件） | exit 0；**1376/1376 通过，0 失败/跳过**（= 1375 + 1 tool-definition test）；证据 `artifacts/dsh/slices/h6b-h2c-integration-verify.json` |
| 定向 | 145/145：runtime、host-status（新增 channels key 后快照仍无损）、host diagnostics、channel bridge（host+worker）、core event tools、core plan/local-core、events worker mount/paths；0 失败/0 跳过 |
| 已知限制 | `ChannelRuntimeProjection.pending.unapplied` 使用全局最小 applied watermark，多绑定不同水位时会偏大（逐绑定幂等由 `bridgePending` 保证）；记录为后续投影细化项 |
| 证据级别 | G1 集成 + 隔离全量 check；固定宿主新投影/core 探针下一步验证 |

### 21.3 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <integration-manifest.json>
cd plugins/shiyu && node --import tsx --test --test-concurrency=1 tests/runtime.test.ts tests/channel-bridge*.test.ts tests/host-diagnostics-tool.test.ts
```

## 22. 第二轮联合固定宿主零模型验证（H4d/H6b/H2c/集成构建）

状态：**固定宿主零模型限定通过**（启动/发布/新投影/worker 探针/core 探针/诊断缓存/无重放）；不是 V24、真实模型或业务验收。代码 HEAD `021bdc6`，dist 由该 HEAD 的隔离 worktree 构建（103 文件，digest `7b70471a…`），一次有序 disable→enable。

### 22.1 观察结果

| 项 | 实际 |
|---|---|
| 插件启动 | 新实例 `68b67720…`，启动 `2026-11-02T21:00:05.785Z`；paused=false；schema4 六域 available（manifestHash `8e9f0530…` 与上轮一致）；inner 文案如实 |
| `channels` 新投影 | schemaVersion 1、source=channel-ingress、status ready、watermark 全 0、bindings/connections/conversations 为空、pending 全 0、degraded 空；仅元数据、无正文；因当前 live 无渠道适配器，显式为空且 ready（不是业务验收） |
| worker 探针 | ok/zeroModel/readOnly/sent=false；工具恰为占位任务工具 + 2 事件工具（assignment/event 分离）；authorityFields=[]；counters 全 0；released=disposed=true；probe session `shiyu-worker-probe-a91427aa…` |
| core 探针（本轮新增） | ok/zeroModel/readOnly/sent=false；工具恰为 3 个 core 事件工具；authorityFields=[]；counters 全 0；released=disposed=true；probe session `shiyu-core-probe-bd923a83…`；preset `shiyu-runtime-core-goal-v1` |
| 诊断缓存（关闭上轮 G10） | 探针后的只读 `shiyu_status` 中 `diagnostics.eventToolProbe` 与 `diagnostics.coreEventToolProbe` 均缓存完整回执；快照仍无损 JSON |
| 重载增量 | commitSeq `315→322`（+7 启动生命周期/能力观察写入）；events `39→40`（+1 lifecycle 及投递 ack）；stateVersion 保持 6；capability revision `14→16`（hostEpoch 重绑+观察），definitionDigest 与 binding 不变、verification 仍 unknown；unknown Task 元数据 version 27→28（启动恢复刷新，无重试/无成功声明） |
| 探针副作用 | 两探针前后：commitSeq/events/deliveries/stateVersion/capability revision/runtime-state 文件哈希全不变；唯一新增 = 两个已释放/归档探针 Session（worker + core）；18 个已知业务 Session 逐字节不变 |
| 探针后状态调用 | commitSeq/events/sessions/state 文件/capability revision 全不变（严格只读） |
| 模型/外部动作 | 产品 0 模型/0 embedding/0 Task/0 Goal/0 渠道输入/0 Lab 输入 |

证据：[round2-joint-zero-model.json](<artifacts/dsh/host/round2-joint-zero-model.json>) 及同目录 before/after/after-tools/after-status2 审计、status-after-reload/status-after-probes、worker/core 探针回执原文。

### 22.2 边界与未测

1. 零模型证据只证启动、发布、新投影、受限挂载/不可伪造字段/释放与诊断缓存；不证真实模型调用事件工具、provider 预算/缓存、真实 core 计划执行或真实渠道流量。
2. `channels` 投影在 live 为空（尚无渠道适配器）；真实 audience/binding/invalidation 行为仅有离线集成证据。
3. 真实浏览器 DOM 渲染未证明；lifecycle=degraded 仍来自保留的历史 unknown/暂停事实。

## 23. H7-prep：证据派生的覆盖映射与 clean-VCS 证据刷新（第三批收尾）

状态：**G1 工具/证据层级通过**；产品业务验收仍未运行（traceability 产品行 79/79 not_covered、covered=0）。2026-11-02 完成并审阅。

### 23.1 提交链

| 提交 | 内容 |
|---|---|
| `4849c89`（X，H7 code） | 新增 `tests/harness/evidence.ts` 与 6 个测试；traceability 增加 evidenceLevel/evidenceRefs/limitations、H7 mapping 渲染与 `oracleCorpus`（15+7=22）口径；隔离 check **1382/1382、0 skip**。 |
| `762955f`（artifact-only） | 第三批复核 F-R1..R7 元数据/披露修正（H2c 实现者日志 superseded+重绑、round2 payload bytes 语义、sanitizedAudits/relativePathEncoding、探针 payload sha/bytes 与 diagnostics cache 绑定、集成 targeted 无日志披露、H6b 完整 log sha/bytes）；不触 code/tests。 |
| `ef1e9e0`（X+1，only artifacts） | X 的干净 worktree 重生成 9 件 harness artifacts：`manifest.vcs={head:4849c89,dirty:false,dirtyEntries:0}`、generatedAt=21:13:38Z、sanitization leaks=0；selfproof 8 files/63 pass（H0b 42 + H0c 15 + H7 6）；traceability rows 103、产品 79/79 not_covered、covered=0、tooling_ready 仅 TV.1–7/9、issues=0；证据映射 22/22 sources verified（54 文件、0 unknown）、41/103 行 limited-only；fl-scenarios synthetic-only、`canUseForBusinessAcceptance=false`。`git diff X..X+1 -- src client tests scripts` = 0 行（中间 `762955f` 为 artifacts-only，manifest 不含 artifacts/dsh，故 head=X/dirty=false 仍有效）。 |

### 23.2 验证与复核

- clean-X 隔离：`npm run check` **1382/1382、0 fail/0 skip**；pipeline（manifest→selfproof→traceability --strict→fl-scenarios --require-selfproof）exit 0；日志归档 `.local/h7-verify/`（check sha `59116c33…`/150551、pipeline `edeffbbf…`/2170、archive-manifest `bd2580ed…`/768；gitignored + lifetimeNote）。
- 第三批独立复核（task-19，提交 `dfbf93d` H6b、`d4408c8`+`26bda0e` H2c、`66a9428`+`11d0c73` H4d、`021bdc6` 集成、`0fb0c59` 第二轮宿主、`4849c89` X、`ef1e9e0` X+1）：**30 项检查完成，证据真实、内部一致；未发现伪造/静默跳过/未跑写通过**；8 条 findings（F-R1..R8）全部 fixed/resolved。报告：[ROUND2-EVIDENCE-REVIEW.md](<artifacts/dsh/verify/ROUND2-EVIDENCE-REVIEW.md>)、[round2-evidence-review.json](<artifacts/dsh/verify/round2-evidence-review.json>)。
- 复算要点：各切片文件/日志/计数与 commit blob 一致；H6b/H2c/H4d/集成/H7 的隔离计数（1361/1375/1345/1376/1382）与 0 skip 匹配；第二轮宿主审计链 commitSeq 315→322→322→322、events 39→40、sessions 18→18→20→20（仅 worker/core 两探针）、18 个已知 Session 不变、capability 14→16 且 definitionDigest 不变、unknown Task v28 披露、diagnostics 两探针缓存、状态调用只读；`git archive 021bdc6` + tsc 独立重建 dist `7b70471a…`（103 文件）与 definitionDigest `5a591515…`；X+1 manifest `dd67e036…`/78073 与 9 件 artifact 哈希一致。

### 23.3 边界

1. 覆盖映射只是**证据层**：产品行仍 79/79 not_covered、covered=0，`tooling_ready` 不升级为产品通过；H5 明确仅 G1、H4b 合成 UI+零模型宿主、H2a/H2a-probe 离线+零模型探针、H1 独立验证离线 oracle、历史样本 historical-limited。
2. 真实宿主/模型/频道/设备/业务验收未运行；H7 mapping 明示不能用于业务验收。
3. clean-VCS manifest 绑定 frozen X；中间 artifact-only 提交已披露且不影响 manifest 哈希有效性。

## 24. H6c 切片：渠道只读投影仪表盘展示与系统文案

状态：**离线通过（G1 合成宿主 UI + 真实 Chromium 进程）**；真实 DSH DOM/生产浏览器、真实平台与业务验收未验。2026-11-02 完成并审阅。

### 24.1 交付（6 文件）

- `client/index.js`：新增“渠道 / Channels”只读标签页，读取 `runtime.snapshot().channels`：status/source/schemaVersion/capturedAt/errorCode；四个 watermark；pending（appliedThrough/unapplied/unbound/truncated）；bindings（channelRef/conversationId/scope/version/appliedInvalidationWatermark/conversationAudienceVersion/replySessionEpoch/可选 lastInvalidationAt）；connections（provider/deployment/accountId/revision 等）；conversations（mode/audienceVersion/audienceStatus/participantCount/nativeConversationId 等）；degraded 原因双语。空/缺失/不兼容/字段缺失均显式提示，不留空白、不假可用；**不显示正文/summary/bodyRef/参与者文本**，无任何交互控件；明示只读投影不代表真实平台已接入或业务验收。
- `src/health/systems.ts`：conversation 摘要按实际接线更新为新文案（本地对话/背景、受控 Lab 限定频道与私聊回执已接线；H6a 身份/去重/受众/墓碑与 H6b 绑定/失效桥/只读投影已离线接线；真实平台适配、渠道发送与固定宿主验收未完成）；status 保持 partial。
- `tests/ui/channels.spec.mjs`（5 项）+ fixtures 合成投影 + playwright testMatch + UI README。
- 证据：`artifacts/dsh/h6/h6c-ui.json`、`h6c-slice-summary.json`、`h6c-isolated-check.log`、`artifacts/dsh/slices/h6c-verify.json`。

### 24.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `d160756` + 仅 6 文件） | `npm run check` **1382/1382、0 skip**；`npm run test:ui` **214/214**（基线 209 + 5） |
| Lead 独立 `scripts/slice-verify.mjs`（静默重跑） | exit 0；**1382/1382 通过，0 失败/跳过**；证据 `artifacts/dsh/slices/h6c-verify.json` |
| Lead `npm run test:ui`（静默重跑） | **214/214 通过，exit 0**；日志 `.local/h6c-lead-ui2.log` |
| 首次尝试的两次失败（如实保留） | 均为负载敏感的**已知 flake**，非 H6c 回归：(1) `lab-integration.test.ts` 20 频道用例内部 10s 等待在并发负载下 10.6s 超时——静默重跑 1382/1382 通过，且其他切片也报同一现象；(2) `context-verification.spec.js` 切对话用例在 UI 套件与重型检查并行时命中 Playwright strict-mode 两个 `role=status` 节点——静默重跑 214/214 通过，H6c 未新增 `role=status` 节点。首次 UI 日志 `.local/h6c-lead-ui.log` 保留；首次 slice-verify 日志已被静默重跑覆盖，失败详情记录在上述证据 JSON。 |
| 证据级别 | G1 合成宿主 UI + 真实 Chromium；不是真实 DSH 客户端注入/生产浏览器验收 |

### 24.3 失败 / unknown / 未测

1. 真实 DSH 客户端注入/DOM、生产浏览器验收、无障碍、真实移动设备、zh/en 之外语言未测；截图仅存 `.local`。
2. 当前 live 的 channels 投影为 ready-空（无渠道适配器）；非空真实数据渲染仅有合成夹具。
3. 未改 runtime.ts/index.ts/worker.ts/dsh adapters，未新增命令端点；无真实平台/模型/embedding/Lab/宿主 reload。

### 24.4 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h6c-manifest.json>
cd plugins/shiyu && npm run test:ui
```

## 25. H2b 切片：订阅生命周期、一次性等待、时间源与通知路由基础

状态：**离线通过（G1 模块/集成 + 真实临时 SQLite + 合成时钟/观察端口）**；Runtime 集成与宿主/真实依赖未验。2026-11-02 完成并审阅。

### 25.1 交付（7 文件 + 证据）

- `src/control/events/rules.ts`：`EventRuleStore` 以控制目录下原子 JSON 持久化声明式规则与派生状态（订阅/投递/ack 仍以控制库为唯一权威）。条件只允许 `eq/in/changed/gt/gte/lt/lte/exists`、≤8 谓词、filterable 原始值、in≤16；**不可表达 callback/JS/SQL/正则**；对 lastSeen、时间/观察水位、wait outcome、notification intent 做有界保留。
- `src/control/events/subscriptions.ts`：`SubscriptionLifecycleService`（subscribe/update/pause/resume/unsubscribe/list/status，expectedRevision CAS；declarative-only 变更 bump conditionRevision 并通过 pause+resume 关闭旧 activation generation、取消旧 pending，同一事件不会因暂停恢复二次命中）；`withDeclarativeCondition()` 把条件接入既有 continuation gate（不匹配只落零模型背景引用并 ack，不唤醒）；`OnceWaitService`（一次性等待+期限，不占 worker 槽、零模型；匹配后仍校验 Assignment/Goal/pause/budget，拒绝保留背景引用；取消/过期关闭资格）；`RuleStoreSubscriptionReader`。
- `src/control/events/time-source.ts`：`SchedulePort` + `RuleBasedSchedulePort`（插件自带，**不依赖 DSH dsh-schedule**）；触发身份 = `subscriptionId + ruleRevision(conditionRevision) + 规范计划发生时刻`；重复 tick/schedule 同身份只执行一次；latest-only 合并错过周期、skip/grace 丢过期并记 gap；fresh/restart 建立 baseline 不重放历史；时钟回拨/时区/规则变更记 gap 不重复触发；once 只触发一次且重启不重放；取消/暂停/退订不复活；注入只读 `ObservationPort` 有界轮询（失败=gap 非“无变化”）；`TimeSourcePump` 协作 tick（自有 timer、不占操作槽、不调模型、pause 门控、合并进行中 tick、close drain）；`H2B_EVENT_TYPES`（`time.occurred`/`observation.changed`）供 runtime catalog。
- `src/control/events/notifications.ts`：`NotificationRouter`：目的地只来自登记规则（仅关联从不广播）；每目的地独立受限视图（metadata+显式 allowedFields+digest）；durable intent 身份跨重启/重连去重；unknown/failed 不自动重发（只读 reconcile）；causation 链深（默认 8）/环阻断；fan-out 与 pending intents 有界并显式 deferred；无模型调用。
- 测试：`tests/events-subscriptions.test.ts` 6、`events-time-source.test.ts` 10、`events-notifications.test.ts` 6（共 22）。
- 证据：`artifacts/dsh/h2/h2b-subscriptions-time.json`（含 runtime.ts 精确集成 diff）、`h2b-slice-summary.json`、`artifacts/dsh/slices/h2b-verify.json`。

### 25.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `d160756` + 仅 8 文件） | exit 0；**1404/1404 通过，0 失败/取消/跳过**（= 1382 + 22） |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `5062485` + 仅 7 文件） | exit 0；**1404/1404 通过，0 跳过**；证据 `artifacts/dsh/slices/h2b-verify.json` |
| 定向 | 98/98（H2b 3 文件 + 既有 events/event-tools/background-pump 回归） |
| 证据级别 | G1 离线模块/集成；非 Runtime/宿主/真实依赖验收 |

### 25.3 失败 / unknown / 未测

1. Runtime 集成（catalog + rule store/lifecycle/reader + `TimeSourcePump` + 可选 NotificationRouter + close drain + 只读 diagnostics）为 Lead 步骤；精确 diff 在队友证据中。
2. 固定宿主零模型验证、真实模型/渠道/Effect 端口、IANA DST 数据库（本切片 daily 用注入 zoneOffsetMinutes）、agent-facing 条件订阅工具、跨运行时回声与平台级通知回执语义未测。
3. 因果环检测受可见 500 事件历史限制；结构有界不是货币/模型成本预算。
4. 无真实模型/embedding/渠道/Lab 动作。

### 25.4 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h2b-manifest.json>
cd plugins/shiyu && node --import tsx --test --test-concurrency=1 tests/events-subscriptions.test.ts tests/events-time-source.test.ts tests/events-notifications.test.ts
```

## 26. H4e 切片：记忆生命周期完善与跨域派生重算/失效

状态：**离线通过（G1 模块/集成 + 真实临时 SQLite/Worker IPC）**；宿主/真实 Ombre/模型未验。2026-11-02 完成并审阅。

### 26.1 交付（10 文件 + 证据）

- 派生模型：来源三态（current/version_changed/invalid）→ 派生状态 `current / needs_review / degraded / source_invalid / revoked` + 有界 reasons；capture metadata 携带 derivation+reasons，`bodyAvailable` 仅 current/degraded；`validateForView` 同时比对 authority、recordDigest 与派生态，旧 capture/旧正文被拒绝；`derivedRevision` 纳入 authority 与 ReadView 的 inner authority 校验。
- 跨域来源：`INNER_SOURCE_KINDS` 新增 relationship-record / emotion-record / personality-profile；各域 `sourceReference` 只读解析（4 层环保护 fail-closed）；来源版本变化写入被拒（`INNER_SOURCE_NOT_CURRENT`），撤回/遗忘不可复活；relationship merge→`source_merged`、split→确定性恢复 current；personality 仅 active profile 可作来源；emotion digested observation 非 current。
- 同事务一致性：Worker 对四域写命令与 `memory.withdrawLocal/forgetLocal` 用外层事务包裹，并在同库事务内触发四域 `recompute`；digest 变化才持久化派生账本并 +1 derivedRevision（无变化不写、不抬版本）；新增只读 `*.derivations`/`*.recompute` IPC。
- 记忆生命周期：`memory.forgetLocal`（consent→withdrawn + forgottenAt + deletion tombstone；与 withdraw 共享屏障、各自幂等）+ 只读 `memory.lifecycle`（owner-controlled、automaticExpiry=false、physicalErase=false、删除水位/可读性/可发布性）；publication 保持 schema4 六域 capabilities，不误升级 verification。
- 测试：新增 `tests/inner-lifecycle.test.ts` 7 项（撤回→依赖降级/旧 capture 拒；forget/lifecycle/publication 不变；personality 版本；merge/split；emotion 撤回；recompute 幂等/重启；两连接只 bump 一次）。
- 证据：`artifacts/dsh/h4/h4e-lifecycle-recompute.json`、`h4e-slice-summary.json`、`artifacts/dsh/slices/h4e-verify.json`。

### 26.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `d160756` + 仅 10 文件） | exit 0；**1389/1389 通过，0 失败/取消/跳过**（= 1382 + 7）；~408s |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `479ad43` + 仅 10 文件） | exit 0；**1411/1411 通过，0 跳过**（= 1404 + 7）；证据 `artifacts/dsh/slices/h4e-verify.json` |
| 定向 | inner-lifecycle 7/7；回归批（inner-*/memory-*/local-reply*/local-view*/memory-view-store/views/state-publication/lab-reply*）320/320 |
| 证据级别 | G1 离线模块/集成；非宿主/真实 Ombre/业务验收 |

### 26.3 失败 / unknown / 未测

1. retention 仅显式逻辑生命周期（无后台过期/物理擦除/备份删除传播）；语义索引/缓存未新增物理真空清理，旧读取由来源态与 derivedRevision 阻止。
2. recompute 为同库有界 latest 扫描；跨组件只显式 unknown，不宣称跨服务原子快照；旧记录无 derivation 字段按 current 归一化（表示“未计算过”，不是重新证明）。
3. relationship merge/split 可逆与撤回/遗忘不可复活的语义分别测试；未做长期并发/多 writer。
4. 无真实模型/embedding/宿主 reload/真实 Ombre。

### 26.4 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h4e-manifest.json>
cd plugins/shiyu && node --import tsx --test --test-concurrency=1 tests/inner-lifecycle.test.ts tests/inner-*.test.ts
```

## 27. H5b 切片：检查点 Runtime 组合层接入（端口适配/命令处理器/生产阻断账）

状态：**离线通过（G1 组合 + 合成 seam）**；生产组合明确 `incomplete`（未伪造 ready），真实宿主命令/真实 Session 路径/真实 Ombre 导出未验。2026-11-02 完成并审阅。

### 27.1 交付（11 源文件 + 4 测试 + 证据）

- 新增 `src/recovery/host-ports.ts`：ControlSourcePort（真实 `dataDir/control/events.sqlite` + `node:sqlite` backup + 既有 ControlStore 只读 live 前置，`livePrecheck` 入清单）、GoalSessionPort（`goal.binding.list` 枚举；**精确日志路径只来自注入 resolver**，候选为已安装 JSONL 后端的诊断 `resolveCurrentLog` 并标注非公共契约；native phase/armed、flush、projection 由注入提供；只接受可离线核验的 plain JSONL；无 native GoalRef 显式 exclusion）、MemoryExportPort（生产显式 `MEMORY_EXPORT_UNAVAILABLE` + required scope；仅测试注入合成导出）、SharedObjectPort（`dataDir/workspaces` 有界只读清单+逐文件/聚合 hash，拒符号链接/逃逸，引用对象才复制）；组合入口 `createRuntimeCheckpointComposition()`（staging 必须在 live 根外且在 allowedStagingRoots 内；只有四组件 complete 且 `verifyBundleDirectory` 真实字节复核通过才 ready）。
- 新增 `src/recovery/runtime-command.ts`：owner-only `runtime.checkpoint.capture` handler（严格字段、单飞 busy 不排队、paused 允许且不改暂停态、显式触发/不因 GET、无自动重试、结构化失败降级、路径脱敏）。
- B1 additive 兼容扩展：`control.livePrecheck`、`dsh-goal-sessions.excludedBindings`、`shared-objects.workspaceInventory`、`restore-report.goalExclusions`；capture 增加 liveDataRoot/allowedStagingRoots 围栏与显式 exclusion；旧 H5-B1 证据保持历史。
- 精确集成 diff：`artifacts/dsh/h5/runtime-checkpoint-capture.diff`（7839 B，`git apply --check` 通过；含 RuntimeOptions 两个 trusted 字段 `checkpointStagingRoot`/`checkpointRuntimeManifest`、类字段、init 命令处理器、dispatch 分支（在 ensureCanRun 之前，paused 可快照）、懒组合方法；不改 snapshot/GET 路由）。
- 测试：`tests/recovery-host-ports.test.ts`（14）+ `tests/recovery-h5b-support.ts`、`recovery-h5b-matrix.ts`、`recovery-h5b-evidence.test.ts`；15 项矩阵覆盖注入点→期望→实际。
- 证据：`artifacts/dsh/h5/h5b-runtime-integration.json`、`h5b-slice-summary.json`、`runtime-checkpoint-capture.diff`、`artifacts/dsh/slices/h5b-verify.json`。

### 27.2 生产宿主结论（未伪造 ready）

当前生产组合**不可 ready**：Goal Session 公共只读路径/原生状态/projection 导出缺失（`GOAL_SESSION_EXPORT_UNAVAILABLE`），managed Ombre 无公开导出（`MEMORY_EXPORT_UNAVAILABLE`）；`availability.expectedReady=false`，capture=incomplete，blockers 均附具体 requiredScope；不存在临时目录回退或猜路径。ready 路径仅以合成 seam 验证（临时真实 Session 文件 + 合成 resolver/native-state/flush/projection/memory），并完成隔离根 restore 核对（read-view only、dispatch blocked、armed→disarmed、live 数据根未动）。

### 27.3 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 worktree（HEAD `d160756` + 仅切片文件） | **两次连续 `npm run check` 均 1397/1397、0 失败/跳过、exit 0**（pinned Python 跨语言测试实际执行，非 skip） |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `69d725f` + 切片文件 + 证据测试所需 2 个 artifacts） | exit 0；**1426/1426 通过，0 跳过**（= 1411 + 15）；证据 `artifacts/dsh/slices/h5b-verify.json` |
| 首次 Lead 尝试 | 失败原因是证据测试要求 committed 的 integration diff/evidence artifacts 存在，而首次 manifest 未包含它们；把 2 个 artifacts 加入 manifest 后重跑通过；失败原因已如实记录，非实现缺陷 |
| 定向 | 恢复套件 53/53；`tsc` 0 错误；diff `git apply --check` 通过 |
| 证据级别 | G1 组合/离线 + 合成 seam；生产 ready 明确阻断，不宣称完成 |

### 27.4 失败 / unknown / 未测

1. `runtime.ts` 集成 diff 未由本切片落地：Lead 应用时必须保持 trusted composition 输入（stagingRoot/runtimeManifest）缺省，使命令显式 unavailable 而不是伪造 ready；固定宿主命令执行/重载、真实 Session 路径与 flush、zstd 离线解码、真实 Ombre 导出、独立故障域/V27、RPO/RTO、激活切换均未验。
2. ready 路径仅合成 seam；生产 readiness=false，required scope 已列出。
3. 只读 SQLite backup 可能刷新 `-shm` 协调文件（非产品写入）；证据断言 DB+WAL 字节不变并说明。

### 27.5 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h5b-manifest.json>
cd plugins/shiyu && node --import tsx --test --test-concurrency=1 tests/recovery-host-ports.test.ts tests/recovery-h5b-evidence.test.ts
```

## 28. H7-acceptance 切片：全量验收追踪与门控运行器

状态：**G1 工具/证据层通过**；产品与业务验收**未运行**（executed=passed=0）。2026-11-02 完成并审阅。

### 28.1 交付（6 文件 + 清单/证据）

- `tests/harness/acceptance-registry.ts`：从 `架构与设计/A方案全景/目录.md` 物化 **12 区域 / 40 模块**清单：需求来源、九系统映射（全部非空）、已知代码路径与产品测试文件 ID（存在性校验）、oracle、已提交证据来源（evidence.ts source ids）、阻塞资源、limitations；状态仅由证据/资源派生：`limited-only / blocked / not_covered / unknown`，**绝无 passed**。
- `tests/harness/acceptance.ts`：全量验收追踪/门控运行器：V01–V27 保留原门槛与编号（27 条、未重编号、source heading 逐条核验；14 资源阻塞、12 limited-evidence、1 not_covered、0 passed）；S01–S08/FL01–FL08 从 H0c skeleton 读取并原样传播 `synthetic-fixture-only-not-run` 与 `canUseForBusinessAcceptance=false`；九系统↔40 模块↔V/S/FL 映射完整；门控永远 `incomplete`、`completeNineSystems=false`，内置 9 项 blocked 资源与 cannotClaim；负例拒绝把 tooling_ready/limited-only 当 pass、删除 unknown/skipped/notRun 分母、伪造 complete、升级 H0c 标志。
- `scripts/harness/acceptance.mjs`（CLI）+ 两份 README 章节；8 项测试；`artifacts/dsh/harness/h7-acceptance-slice.json` 与 summary。
- 全量 `acceptance-report.json/.md` 不在本切片生成：按 A 方案在回合末 clean frozen HEAD 上重生成，由 Lead 作为 artifacts-only follow-up 提交。

### 28.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| 实现者隔离 overlay（HEAD `d160756` + 6 code/test） | tsc EXIT 0；harness 71/71、0 skip；全量 check 见 1 个既有负载敏感 `lab-integration` 超时（未修改该测试，同 HEAD 可复现），本切片只声明 harness 绿与 tsc 绿 |
| Lead 独立 `scripts/slice-verify.mjs`（HEAD `5eede56` + 仅 7 文件） | exit 0；**1434/1434 通过，0 跳过**（= 1426 + 8）；证据 `artifacts/dsh/slices/h7-acceptance-verify.json` |
| acceptance CLI 预览（隔离树，/tmp 输出） | gate=incomplete、completeNineSystems=false；40 模块=30 limited-only/5 blocked/5 not_covered；九系统均 limited-evidence-only；V=27（14 blocked/12 limited/1 not-covered）；S/FL=16 全 skeleton 未运行、canUse=false；executed=passed=0；honesty=pass |
| 证据级别 | G1 工具/证据层；不能据此声明九系统完成 |

### 28.3 失败 / unknown / 未测

1. 未执行任何产品/宿主/模型/业务验收：executed=0/passed=0；系统/模块/V/S/FL 全部为 not_covered/limited-only/blocked/skeleton。
2. 全量 acceptance-report 待回合末 clean HEAD 生成；本切片只有预览（未提交）。
3. 已知负载敏感 `lab-integration` 超时属该测试 owner，非本切片改动；不因工具绿而升级任何产品行。

### 28.4 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <h7-acceptance-manifest.json>
cd plugins/shiyu && node scripts/harness/acceptance.mjs --out /tmp/acceptance-preview
```

## 29. Lead 集成：H2b 时间源/规则与 H5b 检查点命令接入 Runtime

状态：**离线集成通过（G1：隔离全量 check + 定向）**；固定宿主验证与真实依赖未验。2026-11-02 完成并审阅。

### 29.1 集成内容（runtime.ts）

- **H2b**：受信 catalog 增加 `H2B_EVENT_TYPES`（`time.occurred`/`observation.changed`）；在 `EventService` 创建后构造 `EventRuleStore`（`dataDir/control/event-rules.json`）、`SubscriptionLifecycleService`、`RuleStoreSubscriptionReader`、`TimeSourceService`（受信 component principal）并启动协作式零模型 `TimeSourcePump`（自有 timer、不占操作槽、不调模型、pause 门控、close 参与 drain）；仅当受信 `notificationEffectPort` 存在时创建 `NotificationRouter`；`snapshot().diagnostics` 增加只读 `timeSource` 快照与 `notifications{enabled}`。
- **H5b**：应用提供的精确 patch：`RuntimeOptions.checkpointStagingRoot`/`checkpointRuntimeManifest`（trusted composition，默认缺省）、懒创建组合、`runtime.checkpoint.capture` 在 `ensureCanRun` 之前 dispatch（paused 可快照）、不因 GET/snapshot 触发、无自动重试/临时目录回退；**trusted 输入缺省时命令显式 unavailable，不伪造 ready**。
- **测试适配**：H5b 证据测试原先要求 integration patch 能干净应用到未打补丁的 runtime.ts；Lead 应用后改为断言 runtime 中的集成标记（patch 仍作为集成证据），未削弱任何产品行为。
- **可见新键**：`diagnostics.timeSource`（pump 快照或 null）与 `diagnostics.notifications{enabled}`；既有 channels/diagnostics 键不变。

### 29.2 验证（实际运行）

| 验证 | 结果 |
|---|---|
| Lead `scripts/slice-verify.mjs`（HEAD `09cf6d9` + 仅 2 文件） | exit 0；**1434/1434 通过，0 失败/跳过**；证据 `artifacts/dsh/slices/h2b-h5b-integration-verify.json` |
| 定向 | 72/72：runtime、host-status（新增 diagnostics 键后快照仍无损）、H2b 订阅/时间/通知、H5b host-ports/证据矩阵、host diagnostics |
| 边界 | 检查点命令在 trusted composition 缺省时显式 unavailable；时间源仅插件自有规则，不使用 DSH dsh-schedule；无 IANA DST/真实观察/通知 Effect/agent-facing 订阅工具 |
| 证据级别 | G1 集成；固定宿主验证下一步 |

### 29.3 复现

```
node plugins/shiyu/scripts/slice-verify.mjs --manifest <round3-integration-manifest.json>
cd plugins/shiyu && node --import tsx --test --test-concurrency=1 tests/runtime.test.ts tests/host-status.test.ts tests/events-time-source.test.ts tests/recovery-h5b-evidence.test.ts
```

## 30. H4e 迁移热修复：避免 ALTER 已受 commit-watermark 追踪的表

状态：**已修复并在固定宿主恢复激活**（离线回归 + 真实宿主升级路径证据）；真实模型/业务未验。2026-11-02。

### 30.1 症状与根因

- 症状：round-3 构建第一次有序 reload 失败，插件 entry 进入 `failed`，错误为 `EventServiceError: Transaction connection is quarantined...`（底层 `STORE_ISOLATED`）。
- 诊断：在 live 控制库副本上复现；用临时错误链插桩后得到真实原因 `Commit watermark: tracking schema was modified or uses a reserved name [trigger ... ON shiyu_relationship_meta ...]`。**H4e 的 additive migration 对已存在域使用 `ALTER TABLE ... ADD COLUMN`**，而 commit-watermark 的 UPDATE 追踪触发器 SQL 内嵌了列清单；在 owned atomic 内变更列后，`beforeCommit` 期望的触发器 SQL 与已安装触发器不一致，fail-closed 回滚并隔离连接，导致每次启用都失败。
- 这不是数据库损坏：live 库回滚后仍一致；问题是**升级路径不可行**（H4e 隔离测试都用全新临时库，CREATE 一次成型，未覆盖“旧库升级”）。

### 30.2 修复

- 派生权威改放**独立的新表** `${prefix}derivation_meta(id=1, derived_revision, derivation_digest)`；`meta` 表不再 ALTER，升级纯 additive；commit-watermark 只为新表安装触发器，既有触发器的列清单不变。
- `meta()` 通过 JOIN 读取派生行；`saveMeta` 分别更新 `meta` 与 `derivation_meta` 两行；derivations 账本表不变。
- 回归测试 `tests/inner-upgrade.test.ts`：构造 pre-H4e 磁盘内层 schema → 当前 ControlStore 打开（additive 升级）→ 断言 meta 列未变、派生权威 0/空、第二次打开仍通过（追踪触发器一致）。

### 30.3 验证

| 验证 | 结果 |
|---|---|
| live 控制库副本（修复前） | 每次 open 命中 quarantined 错误（可复现） |
| live 控制库副本（修复后） | 两次连续 open 成功；additive 升级落盘；`outer` 触发校验通过 |
| 回归测试 | `tests/inner-upgrade.test.ts` 1/1 + `inner-lifecycle` 7/7 |
| 固定宿主 | 修复构建重新 disable→enable **成功激活**（后续 round-3 零模型验证另记） |
| 证据 | H4e 证据 JSON 记录 `migrationFix`（症状/根因/修复/回归/复现）；`.local` 保留首次失败与诊断日志 |

### 30.4 约束与未测

1. 后续任何“已受追踪表”的结构变更都不得原地 ALTER；应使用新表/新账本或未来实现触发器重建（需单独设计与测试）。本切片未实现通用触发器重建。
2. 修复只覆盖内层派生权威；其他域若有同类 ALTER 迁移需同样审计。
3. 修复后未重跑真实模型/业务；宿主证据仅为启动/升级/零模型。

## 31. 第三轮联合固定宿主零模型验证（修复后的 round-3 构建）

状态：**固定宿主零模型限定通过**（激活/迁移升级/发布/两探针/诊断缓存/只读）；**同时如实记录了本轮真实发生的激活失败与热修复**。代码 HEAD `c2bb475`，dist 由该 HEAD 的隔离 worktree 构建（109 文件，digest `342fa7ab…`），修复后一次有序 disable→enable。

### 31.1 失败 → 诊断 → 修复（真实事件）

1. round-3 构建（`e400fcc`）第一次有序 reload **失败**：`EventServiceError: Transaction connection is quarantined (STORE_ISOLATED)`，插件 entry 保持 failed，重试同样失败。
2. 在 live 控制库**副本**上复现，并用临时错误链插桩得到真实原因：`Commit watermark: tracking schema was modified or uses a reserved name`（`shiyu_relationship_meta` UPDATE 触发器）。H4e 的 additive migration 对已受 commit-watermark 追踪的内层 meta 表使用 `ALTER TABLE`，触发器 SQL 内嵌列清单，升级无法与既有触发器定义协调 → fail-closed。
3. 热修复（`c2bb475`）：派生权威改放独立 `derivation_meta` 表，meta 表不再 ALTER；新增 `tests/inner-upgrade.test.ts` 构造 pre-H4e 磁盘 schema 验证 additive 升级与二次打开。修复构建重新启用**成功激活**。

### 31.2 观察结果

| 项 | 实际 |
|---|---|
| 启动 | 新实例 `5ec0bc5c…`，启动 `2026-11-02T22:41:05.378Z`；paused=false；schema4 六域 available（manifestHash `8e9f0530…` 不变）、inner 文案如实 |
| 迁移升级 | live 四域 meta 表仍为 **9 列**（无 derived 列）；`derivation_meta` 行 = derived_revision 0 / digest 空；watermark `341`；重开一致 |
| `channels` 投影 | ready、watermark 全 0、bindings/connections/conversations 空、pending 全 0、degraded 空、无正文 |
| `diagnostics.timeSource` | 新：`state=idle`、`lastTickAt` 有值、`schedules=0/occurrences=0/accepted=0`——零模型协作 tick 实际运行且无规则时不产生事件 |
| `notifications` | `enabled=false`（无受信 effect 端口） |
| worker 探针 | 3 工具、authorityFields=[]、counters 全 0、released/disposed、probe session `shiyu-worker-probe-c5a9b9f6…` |
| core 探针 | 3 core 工具、authorityFields=[]、counters 全 0、released/disposed、probe session `shiyu-core-probe-ec0dac67…` |
| 探针后状态 | 只读；`diagnostics.eventToolProbe`/`coreEventToolProbe` 均缓存完整回执；快照仍无损 |
| 重载增量（pre-reload2→after） | commitSeq `335→341`（+6 启动生命周期/能力观察写入）；events `41→42`（+1 lifecycle 及投递 ack）；stateVersion 6；capability revision `19→21`（hostEpoch 重绑）；unknown Task 元数据以 `runtime_reopened_requires_reconciliation` 刷新到 version 31（仍 unknown、无重试/无成功声明） |
| 失败窗口增量（before→failed） | commitSeq `322→325`：两次失败激活在迁移失败前完成 boot catalog 事务（含 H2b 两个新事件类型），业务事实不变 |
| 探针副作用 | 两探针前后 commitSeq/events/deliveries/stateVersion/capability revision/runtime-state 文件哈希全不变；唯一新增 = 两个已释放/归档探针 Session；20 个已知业务 Session 逐字节不变 |
| 模型/外部动作 | 产品 0 模型/0 embedding/0 Task/0 Goal/0 渠道输入/0 Lab 输入 |

证据：[round3-joint-zero-model.json](<artifacts/dsh/host/round3-joint-zero-model.json>) 及同目录 before/failed/pre-reload2/after/after-tools 审计与 status/probe 原文。

### 31.3 边界与未测

1. 零模型证据只证激活、迁移升级、发布、受限挂载/释放、诊断缓存与只读；不证真实模型调用、provider 预算/缓存、真实计划质量或真实渠道流量。
2. `runtime.checkpoint.capture` 因 trusted staging/manifest composition 缺省而显式 unavailable，未在宿主执行。
3. 真实浏览器 DOM 渲染未证明；lifecycle=degraded 仍来自保留的历史 unknown/暂停事实。
4. 失败尝试的诊断是在 live DB 副本上复现的；修复后宿主成功激活是本轮 live 证据，但未对失败激活做宿主内重放。

## 32. 第三轮独立复核与 F3 处置（round-3 收尾）

2026-11-02，独立验证员对 round-3 全部提交与证据做只读复核（task-25）：**30 项检查完成，10 条 findings 全部 fixed/resolved/info，未发现需要阻断的问题**。报告：[ROUND3-EVIDENCE-REVIEW.md](<artifacts/dsh/verify/ROUND3-EVIDENCE-REVIEW.md>)、[round3-evidence-review.json](<artifacts/dsh/verify/round3-evidence-review.json>)。

### 32.1 复核覆盖

| 项 | 结果 |
|---|---|
| H6c `5062485` | 1382 unit + 214 UI + 5 focused；日志/哈希一致；已知负载敏感 flake 已披露 |
| H2b `479ad43` | 1404（impl/lead）、22 new、targeted 98；日志匹配 |
| H4e `69d725f` | 1389/1411；迁移修复链见下 |
| H5b `5eede56` | 1426（15/15 matrix；impl 1397×2）；文件哈希 0 mismatch |
| H7-acceptance `09cf6d9` | 1434（8 tests；gate=incomplete/executed=passed=0） |
| 集成 `e400fcc` | 1434（+0；targeted 72/72） |
| **热修复 `c2bb475`** | **通过**：`inner-domain.ts` 已无 ALTER 受追踪表；`inner-upgrade.test.ts` 真构造 pre-H4e schema 并在 /tmp 独立复跑 1/1；live DB 四域 meta 9 列、derivation_meta `{0,''}`、watermark 341 与证据一致；1435/1435、0 skip |
| 宿主 `50af4a2` | 链 322→325→repairActivation 325→335(+10 已分类)→341→341；events 40/40/41/42；sessions 20/20/20/20/22；20 已知 Session 不变；两探针/缓存/timeSource idle/notifications disabled；dist 独立重建（e400fcc `982e5b…`、c2bb475 `342fa7ab…`）；definitionDigest `5a591515…` 不变 |
| X+1 `3a0f731` | 11 artifacts only；manifest.vcs head=X,dirty=false,leaks=0；src/client/tests/scripts diff=0；11 件 SHA/bytes 全匹配；selfproof 71、oracleCorpus 15/7/22、产品 79/79 not_covered；acceptance gate=incomplete/executed=passed=0/planned92 |

### 32.2 F3 findings 处置

| ID | 处置 |
|---|---|
| F3-R1 / F3-R1r（H2b） | summary 与 detail 的实现者日志均标 superseded 并重绑到保留的 Lead 1404 日志（`33177e35…`）；计数与结论不变 |
| F3-R2（host payloadBytes） | 已改为实际字节（55853/60780/2445/2584）+ bytesSemantics；sha 原本正确 |
| F3-R3（host 325→335 未解释） | 新增 `repairActivation` 窗口：+10 = additive migration schema commit + 正常启动写入 + 一次 lifecycle 事件/投递/ack；未逐条枚举但已说明无业务事实变化 |
| F3-R4（unknown Task 版本） | 逐窗口披露 28→29→30→31；state 仍 unknown、无重试/成功声明/预算变化 |
| F3-R5（故障构建身份） | 记录 `failedBuild` e400fcc / dist `982e5b09…`/109 |
| F3-R6（encoded relativePath） | 已说明惯例：无绝对路径/正文/秘密，future 导出 redact |
| F3-R7（集成 targeted 无独立日志） | info 接受（完整隔离 1434 有日志） |
| F3-R8（旧 findings 状态） | resolved |
| F3-R9（acceptance temp path） | info 接受：`/private/tmp/h7r3-clean` 为生成 worktree 路径（无 home/非产品数据），future redact code 小改 |
| F3-R10（informational） | 接受，不改变结论 |

### 32.3 边界

1. round-3 新增能力（H2b 时间源、H4e 派生/生命周期、H5b 检查点组合、H6c 仪表盘）均为 **G1 离线/合成宿主**；固定宿主仅零模型验证。
2. 产品行仍 79/79 not_covered；acceptance gate=incomplete、executed=passed=0；九系统整体验收未完成。
3. 真实模型调用、真实渠道/设备、真实 Ombre 导出、独立故障域/V27、生产浏览器 DOM 与长期运行仍未验证。

## 33. 第四轮：H2b/H2c/H5b 诊断探针与 H7 证据映射（round-4 离线切片）

状态：**G1 离线/集成通过**；宿主执行与真实模型单轮未验（下一步）。2026-11-02 完成并审阅。

### 33.1 H2b 时间源零模型探针

- `src/control/events/probe.ts`：`probeTimeSource` 在**独立 `:memory:` ControlStore + EventService + 临时 EventRuleStore** 内运行（不触 live 控制库）：确定性 due 一次性规则 tick 两次恰好 1 个 `time.occurred`（identity=subscription+conditionRevision+规范发生时刻）、重复 tick 静默、interval latest-only 合并、paused 不触发且恢复不重放、时钟回拨记 gap 不重触发、once-wait 匹配一次、cleanup/关闭、无损有界回执。
- 顺带修复 time-source 的 once occurrence 重复前缀 bug（`once:<rev>:<ISO>`）。
- 测试 9 项；作者隔离 1444/1444、Lead 集成隔离 1472/1472，0 skip。

### 33.2 H2c 真实模型单轮工具探针

- `probeCoreEventToolModelRound`：专用 `shiyu-core-model-probe-*` Session，走与 core 决策相同的受限 3 工具装配（宿主注入 actor/scope、参数禁授权字段）、固定不可变 prompt（先调用一次 `shiyu_core_event_types`，再返回单行 JSON）、≤2 主请求/2 stream、1 工具往返、总输出 ≤256 tokens、0 重试；仅记录 provider 实际 usage（缺失=unknown），工具名/参数 sha/结果交叉校验；flush→release→dispose→archive；**不创建 Goal/Task/Effect/budget/业务事实**，失败/unknown/cancelled 如实返回。
- 测试 9 项；作者隔离 1444/1444、Lead 集成 1472/1472。
- 集成 patch `artifacts/dsh/h2/h2c-real-model-probe-integration.patch`（local-core 薄接缝 + runtime 命令 + 工具）由 Lead 应用。

### 33.3 H5b 检查点可用性只读探针

- `probeCheckpointAvailability`：只读枚举 active GoalBindings（ControlStore `goal.binding.list`）、staging 配置/围栏、resolver/native-state/flush/projection 仅 presence、memory 生产显式 `MEMORY_EXPORT_UNAVAILABLE` + required scope、workspace 只读 lstat/readdir；固定 `ready:false`/`expectedReady:false`/`readOnly:true`/`captureAttempted:false`/`resolverInvoked:false`/`filesWritten:0`，blockers 与组件一一对应。
- `RuntimeCheckpointProbeCommand`：owner-only `runtime.checkpoint.probe`，严格字段、paused 只读、不 capture/不写文件、坏回执拒绝后才缓存 diagnostics。
- 测试 10 项 + 7 条矩阵；作者隔离两次 1445/1445、Lead 集成 1472/1472。

### 33.4 H7-round4 证据映射与验收索引

- 增加 8 个 round-3 证据来源（18 文件，总 30 来源/72 文件）：H6c、H2b、H4e、H4e 热修复、H5b、H7-acceptance、Lead 集成、round-3 宿主；逐文件 `git show <commit>:<path>` blob SHA + ancestry 校验，失败 fail-closed→unknown。
- 九系统/40 模块/V 只增加 limited 证据引用：产品行仍 **79/79 not_covered、covered=0**、tooling_ready 仍 8（TV.1–7/9）、V 不升级；event-schedule 从 not_covered→limited-only（非验收）。
- 新增 6 测试；harness 77/77、tsc 通过；作者隔离全量 1441/1441。

### 33.5 Lead 集成与验证

- `runtime.ts`：接入三条 owner 命令（`runtime.probe-time-source`、`runtime.probe-core-model-tools`、`runtime.checkpoint.probe`）与 diagnostics（`timeSourceProbe`、`coreModelToolProbe`、`checkpointProbe`）；`index.ts` 注册三个无参数、非并发安全的诊断工具（`shiyu_diagnose_time_source`/`shiyu_diagnose_core_model_tools`/`shiyu_diagnose_checkpoint_availability`）；`local-core.ts` 仅薄委托。
- **Lead 集成隔离验证**（HEAD `50e347d` + 全部 round-4 切片与集成文件）：**1472/1472 通过，0 失败/0 跳过**（= 1435 + 9 + 9 + 10 + 6 + 3）；证据 `artifacts/dsh/slices/round4-integrated-verify.json`。
- 定向 76/76（runtime、host diagnostics、时间探针、检查点探针、core 事件工具）。
- 证据级别：G1 集成；宿主命令执行、真实模型单轮、真实 Session/Ombre 导出仍未验。

## 34. 第四轮联合固定宿主验证：零模型探针与一次有界真实模型尝试

状态：**固定宿主零模型限定通过 + 有界真实模型单轮尝试诚实失败**（未产生模型请求/费用）；真实模型工具往返仍未验证。代码 HEAD `af201fe`，dist 由该 HEAD 隔离 worktree 构建（111 文件，digest `04d4a435…`），一次有序 reload。

### 34.1 失败 → 修复 → 重载

1. 第一次在 `1f74180` 构建上调用 `shiyu_diagnose_core_model_tools` 返回 `CORE_MODEL_TOOL_PROBE_UNAVAILABLE`：H2c 集成 patch 的 LocalCoreService 委托 hunk 实际未落进共享树（`git apply -3` 报告 clean 但文件未变），Runtime CoreDriver 缺少可选方法。**此尝试未产生任何模型请求。**
2. 热修复 `af201fe`：补 LocalCoreService 薄委托 + 回归测试（adapter 存在时委托、缺失时 `NATIVE_MISMATCH`）。验证：独立复核者在 /tmp 独立跑 `tests/local-core.test.ts` **32/32、0 skip**；clean-X（af201fe）全量 check **1473/1473、0 skip**（= 集成基线 1472 + 新增 1 个委托回归测试；日志 `.local/h7-verify/round4-clean-af201fe-check.log`，sha256 `e64f43d4…`/159480）。
3. 以 `af201fe` 重建 dist 并再次有序 reload 成功；随后零模型探针全部通过，并做**唯一一次**有界真实模型单轮尝试（不重试）。

### 34.2 零模型探针（af201fe 构建）

| 探针 | 实际 |
|---|---|
| worker 工具 | ok；3 工具（占位任务 + 2 事件）；authorityFields=[]；counters 全 0；released/disposed；probe session `shiyu-worker-probe-b0e70f9d…` |
| core 事件工具 | ok；3 个 core 事件工具；authorityFields=[]；counters 全 0；released/disposed；probe session `shiyu-core-probe-730e7816…` |
| 时间源（H2b） | ok/zeroModel/zeroEmbedding/zeroTaskOrEffect；独立 `:memory:` 控制库；once 到点恰好 1 个 `time.occurred`（identity=subscription+conditionRevision+`once:1:2026-01-01T00:00:05.000Z`）、重复 tick 无第二事件、latest-only 合并、paused 不触发、时钟回拨记 gap、once-wait 匹配一次；15 项 checks 全 true；released/disposed，temp dir removed，`liveDataTouched=false` |
| 检查点可用性（H5b） | `ready=false/expectedReady=false/readOnly=true/captureAttempted=false/resolverInvoked=false/filesWritten=0`；只读枚举 **3 个 active Goal binding**；blockers = `CHECKPOINT_STAGING_UNCONFIGURED`、`GOAL_SESSION_EXPORT_UNAVAILABLE`、`MEMORY_EXPORT_UNAVAILABLE`；shared-objects/control 只读可用；未建任何文件/未调 resolver |
| 诊断缓存 | 探针后只读 `shiyu_status` 显示 `coreModelToolProbe`、`timeSourceProbe`、`checkpointProbe` 回执均缓存；快照仍无损 |

### 34.3 有界真实模型单轮尝试（唯一一次，不重试）

- 调用：`shiyu_diagnose_core_model_tools` → `runtime.probe-core-model-tools`；固定 prompt（sha256 `88730918…`）、opencode-go/deepseek-v4.1-flash/high、maxTokens 256、60s 上限、0 重试。
- 结果：**结构化失败** `CORE_MODEL_PROBE_PROTOCOL_VIOLATION`；counters 全 0（mainModelRequests=0/streams=0/toolCalls=0/toolResults=0）；usage status=unknown；`released/disposed/archived/cleanupVerified=true`；`sent=false`、`productionStateWrites=0`。
- 归档 Session 事件：`agent/inbox/spliced(inserted fixed prompt) → turn/start → agent/inbox/spliced(removedCount:1) → turn/end(reason: blocked)`，**没有任何 assistant 消息/模型请求**；说明失败发生在 host agent loop 的 blocked turn，而非模型协议。
- 判定：**诚实失败、零模型费用、未重试**；真实模型工具往返仍未验证（记录为 gap，不升级任何 H2c 真实模型结论）。
- 两次尝试均未写控制库业务表：探针前后 commitSeq/events/capability revision/runtime-state 文件哈希不变；新增 Session 仅 3 个已释放/归档探针（worker、core、core-model），已知 Session 逐字节不变。

### 34.4 边界

1. 零模型证据只证挂载/时间源隔离行为/检查点阻断清单/诊断缓存/只读；不证 live 时间规则触发、capture 就绪、真实 Session/Ombre 导出。
2. 真实模型单轮失败，无 provider 用量/缓存/费用证据；不得据此声称 H2c 真实模型工具调用通过。
3. 失败原因（host agent loop 对探针 Session 的 blocked turn）未进一步深挖；后续需单独修复探针输入投递路径后再做一次有界验证（另留证据，不重试本次失败）。
4. 真实浏览器 DOM、真实渠道/设备、V27 独立故障域等仍未验。

## 35. 第四轮独立复核与 F4 处置（round-4 收尾）

2026-11-02，独立验证员对 round-4 提交与宿主证据做只读复核（task-30）：**25 项检查完成，10 条 findings 全部 fixed/resolved/info**。报告：[ROUND4-EVIDENCE-REVIEW.md](<artifacts/dsh/verify/ROUND4-EVIDENCE-REVIEW.md>)、[round4-evidence-review.json](<artifacts/dsh/verify/round4-evidence-review.json>)。

### 35.1 复核覆盖

| 项 | 结果 |
|---|---|
| H2b 时间源探针 `8cc6762` | 9 tests；1444/1444；15 checks 全 true（in-memory/identity/幂等/latest-only/paused/clock rollback/cleanup）；哈希匹配 |
| H2c 真实模型探针 `d2da9c7` | 9 tests（14→23）；1444/1444；MAX_MAIN_REQUESTS=2/MAX_TOOL_CALLS=1 未变、复用 `validateCoreEventToolMount`；实现者未执行真实模型 |
| H5b 检查点探针 `dab6d5b` | 10 tests、7/7 matrix；trial/final 1445；readOnly/captureAttempted=false/resolverInvoked=false/filesWritten=0；active bindings=3 |
| H7-round4 `e273aa7` | 6 tests；slice 1441、harness 77；30 sources/72 files；产品行 79/79 not_covered、仅 limited 证据 |
| 集成 `1f74180` | 1472/1472；files 4/4 |
| 热修复 `af201fe` | 代码/宿主通过；独立 local-core 32/32；clean-X **1473/1473**（=1472+1 委托回归，日志 `e64f43d4…`/159480）；宿主 attempt1 UNAVAILABLE（0 模型）、attempt2 PROTOCOL_VIOLATION（counters 全 0、usage unknown、archived/released/cleanup、不重试、无业务写入）一致 |
| 宿主 `bd81270` | 失败窗口 341→347 与修复窗口 347→353 分类；events 42→43→44；sessions 22→22→24→27（两构建共 5 个探针 Session）；已知 22 个 Session 不变；time 15/15；checkpoint flags；4 receipts 缓存；timeSource idle/schedules=0；notifications disabled；dist 独立重建 `ebf257e6…`（失败构建）/`04d4a435…`（修复构建）；definitionDigest 不变 |
| X+1 `dfe4372` | 11 artifacts only；manifest.vcs head=af201fe,dirty=false,leaks=0；src/client/tests/scripts diff=0；11 件 SHA/bytes 全匹配；1473/1473；selfproof 77；30/30 verified；产品 79/79；acceptance gate=incomplete/executed=passed=0 |

### 35.2 F4 findings 处置

| ID | 处置 |
|---|---|
| F4-R1（hotfix 计数） | 已修正为 clean-X 1473/1473 + 保留日志 sha；并引用复核者独立 local-core 32/32；不再声明 1435 |
| F4-R2（payloadBytes） | 已改实际字节 + bytesSemantics（55906/2549/2688/826/69781 等；sha 原本正确） |
| F4-R3（失败构建窗口） | 新增 `deltas.failedBuildWindow`（341→347/events42→43/sessions22→22/cap21→23/dist `ebf257e6…`）并引用 round4-host-before/after audits |
| F4-R4（探针 Session 数） | 改为按 build 披露：失败构建 2 + 修复构建 3 = 5；已知 22 个 Session 逐字节不变 |
| F4-R5（unknown Task 版本） | v31→v32→v33 按窗口披露；state 仍 unknown、无重试/成功声明/预算变化 |
| F4-R6（编码路径） | 已注明历史惯例：无绝对路径/正文/秘密，future 导出 redact |
| F4-R7（集成 targeted 无日志） | info 接受（完整隔离 1472 有日志） |
| F4-R8（attempt2 归档事件仅 receipt/status 可核） | info 接受（zstd 未解码；本次由 Lead 直接解码该 Session 得到 in-flight turn blocked 事件链，已在 §34 记录） |
| F4-R9（host/X+1 pending） | resolved（`bd81270`/`dfe4372` 已提交并复核） |
| F4-R10（acceptance temp path） | info 接受（`/private/tmp/h7r4-clean` 生成路径，无 home/产品数据，future redact） |

### 35.3 边界

1. round-4 探针均为 G1/零模型诊断；**真实模型工具往返仍是诚实失败**（0 main requests/streams/tool calls、usage unknown、未重试），不得记为通过或升级为业务/九系统验收。
2. 零模型只证挂载/时间源隔离行为/检查点阻断清单/诊断缓存；live 时间规则触发、capture 就绪、真实 Session/Ombre 导出、真实 DOM、真实渠道/设备与 V27 仍未验。
3. 产品行仍 79/79 not_covered；acceptance gate=incomplete、executed=passed=0；真实模型尝试的根因（host agent loop blocked turn）未进一步修复。

## 36. 第五轮：core-model 首步修复与 live 时间规则触发探针（round-5 离线切片）

状态：**G1 离线/集成通过**；固定宿主重测（真实模型一次、live 时间触发）未执行（下一步）。2026-11-02 完成并审阅。

### 36.1 H2c core-model 探针 blocked turn 根因与修复

- 根因（用 fake host 事件序列离线复现）：固定宿主在首步同时 claim 固定 prompt 与**必需的 working-directory runtime-context 快照**（2 条，`suppressRuntimeContext()` 也仍注入）；probe 的 `agent/pre-step` 要求长度恰好 1，于是 reject → 宿主移除输入并以 blocked 结束 turn → 没有任何 user/message 或模型请求（counters 全 0）。
- 修复（仅 `core-decision.ts`）：首步接受 1–2 条——第 1 条必须 id+hash 等于注册固定 prompt；第 2 条若存在必须是精确绑定的 cwd runtime-context（复用同一校验）；0 或 >2 条仍 fail-closed；`decision.messages` 与 committed-input/stream 校验共用同一首步校验；**其他边界完全未放宽**（仅 types 工具、≤2 主请求/2 stream/1 turn、1 工具往返、maxTokens 256、usage unknown 不补零、0 重试、无业务写、flush+release+dispose+archive 才出回执）。
- 测试：新增 4 项（1 条路径、正确 2 条、错误 cwd、第三条输入拒绝）；修复前 focused 仅 2 条失败、修复后 27/27；回归 135/135；作者隔离 1477/1477。
- 集成 diff：`artifacts/dsh/h2/h2c-model-probe-fix.patch`（42 行，仅 core-decision.ts）；runtime/index 无需改动。

### 36.2 H2b live 时间规则触发探针（如实披露副作用）

- `probeLiveTimeTrigger`：向**真实 live EventRuleStore** 写入唯一 one-shot 规则（dueAt≈now+1s），在 live TimeSourceService 注册**内存 ephemeral 订阅**（不写控制库 subscription 行），经 live TimeSourcePump 驱动，在 live EventService 观察到**恰好 1 个 `time.occurred`**（identity=subscription+conditionRevision+规范 occurrence+scheduledFor）；重复 wake 无第二事件；reserved probe scope 无 delivery；finally 清理规则/timeState 并复核。
- **副作用如实声明**：会向 live 控制库 append **1 个不可删除的 `time.occurred`**（`liveDataTouched='control-events-append-only'`、`eventDeletable=false`、`businessTablesWritten=[]`、`externalEffects=0`）；规则条目临时写入后删除；崩溃可能残留惰性规则（hostKit 有 operator warning）。
- 测试：新增 8 项（真实临时 SQLite+EventService+规则文件+真实 TimeSourcePump；正例/重复 tick 幂等/cleanup 保留 append-only 事件+唯一身份/paused 前后/deadline/真实自动 tick/abort+lossless receipt）；作者隔离 1481/1481。

### 36.3 H7-round5 证据映射

- 增加 8 个 round-4 来源/31 文件（H2b 时间探针、H2c 探针 kit、H5b checkpoint 探针、H7-round4、Lead 集成、LocalCore 热修复、round-4 宿主、X+1 clean artifacts），逐文件 blob SHA+ancestry，失败→unknown。
- **失败语义保留**：H2c 实现者未执行真实模型、宿主真实尝试在任何模型请求前失败且未重试，映射中明确“不得记 pass/V25/产品验收”；host 保持 zero-model limited；H5b 保持 production-blocked。
- 产品行仍 79/79 not_covered、covered=0、tooling_ready/V/S/FL 不升级；harness 83/83；作者隔离 1479/1479。

### 36.4 Lead 集成与验证

- `runtime.ts`：live 时间源 principal scopes 增加 `TIME_TRIGGER_PROBE_SCOPE`（probe 事件只落 append-only 账本、无 live delivery）；新 owner 命令 `runtime.probe-time-trigger`（session.probe 准入、单槽、可中止、不重试、`readOnly:false` 因会 append）；`diagnostics.timeTriggerProbe`。
- `index.ts`：新工具 `shiyu_diagnose_time_trigger`（无参数、非并发安全）。
- **Lead 集成隔离验证**（HEAD `bcc3591` + 全部 round-5 切片与集成文件）：**1492/1492 通过，0 失败/0 跳过**（= 1473 + 4 + 8 + 6 + 1）；证据 `artifacts/dsh/slices/round5-integrated-verify.json`。
- 宿主重测：真实模型探针按 kit 仅一次、0 重试；live 时间触发探针一次并记录 append-only 副作用；结果另行留证。
