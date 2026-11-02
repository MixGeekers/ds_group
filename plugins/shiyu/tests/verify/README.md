# H1 独立验证套件（tests/verify）

本目录是 H1「原生 Session 长期复用 / 冷恢复 / 竞态」的**独立验证**测试集，由独立验证者按
[DSH 交接 00–03](../../../../架构与设计/DSH交接/00-交接入口与实施路线.md) 与已安装固定 SDK
`0.2.1-rc.5` 的静态契约从规范侧编写，不复用、不读取实现者测试断言作为预期来源，也不修改产品源码。

## 1. 为什么独立

- 预期来自规范与固定 SDK 源码：`read(offset,length)` 语义、open 捕获 header/inherited、同 handle
  单调读、`restore` 的 `asOfSeq = 最后一条 seq（空为 -1）`、`session.seq = 日志长度`、
  `agent/inbox/spliced` 投影、resume 的 interrupted closers/`session/end-seed`、固定 user 标题
  `session/title{messageSeqs:[],source:{kind:'user'}}`。
- 判据自持：`support/independent.ts` 独立实现 inbox fold、水位/继承/字节判据与安全拒绝判据，
  **不 import 产品的解析或 hash 比较函数**；`support/world.ts` 是独立原生世界替身，
  `support/host.ts` 是独立业务路径宿主替身。
- 判定器先自证：`00-oracle-selftest.test.ts` 用手工构造的应过/应拒样本（≥2/≥2）证明判据会拒绝错误。
- 所有数据均为合成数据；不连接真实宿主、模型、embedding、频道或用户数据。

## 2. 运行

在 `plugins/shiyu/` 下：

```bash
# 1) 独立套件（独立 glob，不进入主 tests/*.test.ts）
node --import tsx --test --test-concurrency=1 tests/verify/*.test.ts

# 2) 独立类型检查（extends 根 tsconfig，仍只编译 src 与 verify）
npx tsc -p tests/verify --noEmit

# 3) 推荐：运行 + 归并 TAP/逐例证据并生成报告
node --import tsx tests/verify/report.mjs
```

`report.mjs` 会生成：

- `plugins/shiyu/artifacts/dsh/verify/runs/<runId>/manifest.json`：冻结 HEAD/worktree、产品 6 个
  适配文件、固定 SDK 7 个包的只读 SHA256、测试文件 SHA256、运行命令与环境；
- `runs/<runId>/raw/*.jsonl`：每进程的结构化逐例证据（id/预期/实际/判定/规范来源/耗时）；
- `runs/<runId>/tap.txt`：node:test TAP 原始输出；
- `runs/<runId>/results.json` 与 `results.md`：逐例结果、分类分母、03 §5 覆盖矩阵、issue 清单；
- `artifacts/dsh/verify/latest.{json,md}` 与 `index.md`：最新一次运行与索引。

## 3. 判定口径（防止“未测写成通过”）

| 结果 | 规则 | 是否计通过 |
|---|---|---|
| pass | TAP 绿 **且** 该测试关联的每条结构化证据均为 `pass` | 是 |
| fail | 观察到违反预期，或 TAP 红 | 否 |
| blocked | 接口/能力/环境不具备（如未导出可观测水位） | 否，单列缺口 |
| unobservable | 该层无法观测（如仅数组兼容接口不暴露 asOfSeq） | 否，单列缺口 |
| unreported | TAP 绿但没有结构化证据记录 | 否，单列 |

代码中的 `t.skip` **不会**被用来表示未测：本套件不用 skip；不具备条件的用例记为
`blocked`/`unobservable` 并明确指出缺什么。

## 4. 用例编号与覆盖

| 前缀 | 覆盖 |
|---|---|
| `C00*` | 判定器/替身自证（应过/应拒手工样本、read/offset/缩短/asOfSeq/detached 语义） |
| `L*` | 合法长历史：空史、2048−1/2048/2048+1、5000/10000、短页非 EOF、继承 seed、inbox lane/移除、同业务身份 |
| `I*` | 非法：缺号/重复/乱序、页超量、坏 header/version/preset/isSeeded/−0/继承范围/继承切口、坏 inbox、投影失败/缺 inbox/错 asOfSeq、读/关闭失败、缺服务、Session 不存在、空史水位 |
| `R*` | 竞态：页间追加/inbox 插入移除、同长度早段改写、EOF 后追加、投影中追加、缩短、取消、预取消、内部期限 |
| `B*` | 声明的容量边界：maxEvents±1、maxBytes 上下、maxReads、限额常量自洽 |
| `S*` | 恢复连续性：expectedPrefix 零后缀、受信 resume/setup/title 后缀、异源 user/assistant/inbox/自动标题拒绝、前缀改写/缩短、篡改基准、后缀上限、受信判定矩阵、live 绑定、单事件扩展、maintenance 观测 |
| `LO*` | load-only 业务路径：精确消息+flush+独立回读+receipt、长史恢复、授权 await 期间异源追加、pending inbox、flush 失败、期限、取消、二次复用、独立持久回读 |
| `RP*` | replyer 业务路径：receipt+一次受限生成、长史恢复、授权/onBound 期间异源输入、预算/用量、同 Session 复用、pending inbox、已知过期输入精确移除 |
| `CO*` | Core 业务路径：长史 Goal Session 恢复+有界候选、onDispatch/授权 await 期间异源写入拒绝 |

03 §5 覆盖矩阵与逐例结果由 `report.mjs` 生成，见 `artifacts/dsh/verify/latest.md`。

## 5. 边界

本套件证明的是**合成原生替身 + 固定 SDK 静态契约层**上的适配行为（模块/组合级）。它不能替代：

- 真实 DSH 宿主上的零模型/有界真实会话验收（G3/V24）；
- 真实模型生成、压缩、provider 计费/缓存完整性；
- 长期运行、多频道、真实设备与备份恢复（H2+、V21/V22/V25–V27）。

这些必须按 03 §5 最后一行分层留证，**不得互相冒充**。`manifest.json` 记录每次运行精确的
source/SDK/test 摘要，任何产品、SDK 或测试改动都会使旧运行结论需要重跑。

## 6. 复核方法（Lead / 第三方可逐步重算）

本套件的结论只在 `manifest.json` 冻结的精确 tree 上成立；任何产品/SDK/测试变化都必须重跑。
可按下面顺序复核（均在 `plugins/shiyu/` 下执行）：

1. **冻结清单**：打开 `artifacts/dsh/verify/runs/<runId>/manifest.json`，核对
   - `git.head` 与 `git.dirtyPaths` 是否与实现者声称的被测版本一致（含并行队友的改动，不可混算）；
   - `product` 6 个适配文件的 SHA256 是否等于当前工作树 `shasum -a 256 <file>` 的结果；
   - `sdk` 7 个包 SHA256：`node scripts/read-dsh-asar.mjs hash <package/lib/index.js>` 重算；
   - `tests` 9 个测试文件 SHA256 是否等于当前 `tests/verify/*.test.ts`。
2. **重跑**：`node --import tsx tests/verify/report.mjs --label final`，要求
   `cases = pass + fail + blocked + unobservable`（四项相乘覆盖），且 `sum pass == cases`、
   `unreported = 0`、`skip = 0`；否则结论不成立。
3. **独立类型检查**：`npx tsc -p tests/verify --noEmit` 必须 0 退出（它只编译本套件与依赖的
   产品适配文件，不受并行工作流影响）。
4. **证据↔TAP 对齐**：`runs/<runId>/tap.txt` 的测试数应等于 `results.json.summary.tap.total`；
   `runs/<runId>/raw/*.jsonl` 每行含 id/预期/实际/verdict/耗时；`results.json` 中
   `unreportedTests`、`unattributedEvidence` 必须为空。任一测试 TAP 通过但无证据记录时，
   报告会把它计为 `unreported`（不计通过），而不是绿色。
5. **防自证静态检查**：`results.json.integrity`（由 report.mjs 生成，命中即退出码非 0）要求：
   `judgeImportsProduct=false`（判定器 `support/independent.ts` 不 import 产品源码）、
   `.skip/.todo/.only/assert.ok(true)` 均为 0、每个测试文件都写结构化证据。
   人工可再 `grep -n "src/adapters" tests/verify/support/independent.ts` 确认为空。
6. **判定器验真**：重读/重跑 `00-oracle-selftest.test.ts`：
   C00a/C00b/C00c/C00d 是手工构造的应过/应拒样本；C00e 校验替身语义（切片、EOF、缩短拒绝、
   空 asOfSeq=-1、detached、end-seed 惰性）；C00f 用 1 个正确手写 reader + 3 个故障
   reader（单遍、陈旧 cut、短页当 EOF）端到端证明 harness 会拒绝错误实现。没有这一步，
   绿色结果不得作为发布证据。
7. **聚合器自身否定对照**：`artifacts/dsh/verify/negative-control.json` 记录了两次临时注入运行：
   故意失败的用例被判 fail、TAP 绿但证据记录为 blocked 的用例判 blocked、TAP 绿但无证据记录的
   用例判 unreported，且整体退出码为 1；随后删除临时用例与运行目录，只保留该对照 JSON。
   因此 `fail/blocked/unreported` 分母是真实的，不能被静默升级为通过。
8. **与实现者证据分离**：本套件不读取实现者测试断言作为预期；如需核对实现者测试真实性
   （是否复制实现逻辑/静默跳过/未跑写通过），按其日志与 diff 单独复核，见
   `artifacts/dsh/verify/ISSUES.md` 与最终报告的“实现者证据真实性复核”节。
9. **边界声明**：本套件是离线合成替身 + 固定 SDK 静态契约层，不替代 G3/V24 真实宿主、
   真实模型/压缩/计费、长期运行与真实渠道/设备/备份验收（03 §5 最后一行：分层留证、不得互相冒充）。

## 7. 当前状态（H1 收口）

- 被测 H1 提交：`92c857fcfe5d823836b48ea9c9df09fcdeb14981`；最终独立运行在后续 HEAD `31af227`（该 HEAD 未修改 H1 适配文件，H1 9 文件哈希与 92c857f 一致）；最终运行
  `artifacts/dsh/verify/runs/2026-11-02T18-54-10-909Z-final/`：
  **117 条逐例记录 / 103 个 TAP tests 全部通过**（0 失败 / 0 blocked / 0 unobservable / 0 unreported / 0 skip）。
- 最终报告：`artifacts/dsh/verify/FINAL-REPORT.md`；Issue 清单：`ISSUES.md`；
  实现者证据复核：`implementer-evidence-review.json`。
- 过程证据：`runs/2026-11-02T18-45-41-522Z/`（被实现者 H1 证据引用的中间运行）与
  `FINAL-REPORT-TEMPLATE.md`；不替代最终运行。新增证据已做 home 路径脱敏（`<home>`）。
