# H1 独立验证最终报告（模板）

> 使用方式：在 `native-history` 宣布最终版本并给出最终 `npm run check` 日志后，于 `plugins/shiyu/`
> 重新运行 `node --import tsx tests/verify/report.mjs --label final`，用真实运行 ID/数字/哈希替换
> 本模板占位符（`{FINAL_RUN_ID}` 等），逐项勾选。若最终树与中间运行指纹不同，**必须重跑**，
> 中间版本 96/96 或 112/112 结果保留为中间证据，不替代最终版。

## 0. 结论摘要

- 最终运行：`{FINAL_RUN_ID}`（`artifacts/dsh/verify/runs/{FINAL_RUN_ID}/`）
- 被测产品：HEAD `{HEAD}`，工作树改动文件 `{PRODUCT_DIRTY_FILES}`；H1 相关 6 文件 SHA256 见附录 A
- 固定 SDK：DSH `0.2.1-rc.5`，7 个包 SHA256 见附录 A（app.asar 只读）
- 独立用例：`{CASES}` 条 = 通过 `{PASS}` / 失败 `{FAIL}` / blocked `{BLOCKED}` / unobservable `{UNOBSERVABLE}` / unreported `{UNREPORTED}`
- 测试级：`{TESTS}` 个 node:test = 通过 `{TEST_PASS}` / 失败 `{TEST_FAIL}` / skip `{TEST_SKIP}`
- 判定器自证：C00a–C00f 通过（手工应过/应拒样本 + 1 正确/3 故障突变体端到端被正确拒绝）
- 产品行为缺口：`{PRODUCT_ISSUES}`（若为空写“无；见 §4 未覆盖边界”）
- 实现者证据复核：`{IMPLEMENTER_EVIDENCE_VERDICT}`（真实/部分/不成立 + 证据引用）

## 1. 运行与冻结清单

| 项 | 值 |
|---|---|
| 运行命令 | `node --import tsx tests/verify/report.mjs --label final`（内部：`node --import tsx --test --test-concurrency=1 --test-reporter=tap tests/verify/*.test.ts`） |
| 独立类型检查 | `npx tsc -p tests/verify --noEmit`（结果：{TSC_VERIFY}） |
| 环境 | Node `{NODE}`，`{PLATFORM}`，工作目录 `{CWD}` |
| 起始/耗时 | `{STARTED_AT}` / `{DURATION}` |
| 退出码 | `{EXIT}` |
| 隔离 | 合成内存原生世界 + 合成业务宿主；未连接真实宿主、模型、embedding、频道或用户数据 |

## 2. 分母（必须与 `results.json.summary` 一致）

| 类别 | 用例 | 通过 | 失败 | blocked | unobservable |
|---|---|---|---|---|---|
| C 判定器自证 | {C_CASES} | {C_PASS} | {C_FAIL} | {C_BLOCKED} | {C_UNOBSERVABLE} |
| L 合法长历史 | {L_CASES} | {L_PASS} | … | … | … |
| I 非法历史/后端 | {I_CASES} | … | … | … | … |
| R 竞态/取消/期限 | {R_CASES} | … | … | … | … |
| B 容量边界 | {B_CASES} | … | … | … | … |
| S 恢复连续性 | {S_CASES} | … | … | … | … |
| LO load-only 业务路径 | {LO_CASES} | … | … | … | … |
| RP replyer 业务路径 | {RP_CASES} | … | … | … | … |
| CO Core 业务路径 | {CO_CASES} | … | … | … | … |
| **合计** | `{CASES}` | `{PASS}` | `{FAIL}` | `{BLOCKED}` | `{UNOBSERVABLE}` |

“unreported”（TAP 绿但无结构化证据）必须为 0；本套件不使用 `.skip/.only/assert.ok(true)`（见
`latest.json.integrity`，静态检查由 report.mjs 执行，命中即退出码非 0）。

## 3. 03 §5 覆盖矩阵（引用 `latest.md` §3）

| 03 §5 行 | 状态 | 失败/不完整 | 证据 ID |
|---|---|---|---|
| row1 合法长史/2048±/多页/继承 seed/身份保留 | `{ROW1}` | `{ROW1_GAPS}` | L01–L13, R02–R03, S17, LO02/L08/L11/L13, RP02/RP06/RP10, CO01 |
| row2 非法输入/坏 header/preset/继承/−0/资源释放 | `{ROW2}` | `{ROW2_GAPS}` | I01–I27, L06/L12 |
| row3 读取中/EOF 后/投影中变更/同长度改写/缩短 | `{ROW3}` | `{ROW3_GAPS}` | R01–R07, S07 |
| row4 合法恢复后缀与异源输入 | `{ROW4}` | `{ROW4_GAPS}` | S02–S06, S12, S14, RP08/RP09, LO11 |
| row5 授权/onDispatch await 后基准失效 | `{ROW5}` | `{ROW5_GAPS}` | S13/S16, LO03/L04/L07/L09/L12, RP03/RP04, CO02/CO03 |
| row6 取消/期限/读/投影/关闭失败 | `{ROW6}` | `{ROW6_GAPS}` | I21/I22, R08–R10, LO06/LO07 |
| row7 三类业务路径精确消息+flush+独立回读+预算 | `{ROW7}` | `{ROW7_GAPS}` | LO01/LO10, RP01/RP05, CO01 |
| row8 判定器自证与分层证据 | `{ROW8}` | `{ROW8_GAPS}` | C00a–C00f, B00, S00/S18 |

## 4. 未覆盖行为目标（按行为目标缺口记录，不按接口改名记录）

| 未覆盖项 | 性质 | 需要什么 |
|---|---|---|
| 真实 DSH 宿主长历史冷恢复（真实 JSONL/projection/resume，零模型） | 本层为合成替身+固定 SDK 静态契约；不执行真实宿主 | Lead 冻结的零模型重载/隔离根验证（G3/V24） |
| 真实模型生成、标题/压缩旁路、provider 重试、计费/缓存完整性 | 不调用模型/网络 | 有界真实模型批次与观测器；压缩单独评估 |
| 原生压缩/检查点后的恢复 | 实现未接线压缩 | H1 后续切片 |
| 跨进程/任意外部写者原子快照 | 固定 SDK 非原子快照（03 §3 边界） | 不承诺，按观察/使用边界留证 |
| 真实后端性能/资源上界、长期运行 | 替身不提供真实成本 | 宿主性能/长期运行测试 |
| 真实频道/设备/备份（H2+、V21/V22/V26/V27） | 资源与授权范围 | 后续切片 |

## 5. 实现者证据真实性复核（Lead 要求的四件套之一）

| 检查 | 结果 | 证据 |
|---|---|---|
| 最终 `npm run check` 日志存在且覆盖声称的 HEAD/worktree | `{CHECK_LOG_VERDICT}` | `{CHECK_LOG_PATH}`（起止时间/退出码/通过项数） |
| 日志中的通过数是否可解释（基线 1021 + 新增用例，且无失败/取消残留） | `{CHECK_COUNT_VERDICT}` | 日志摘要行；注意并行队友未跟踪文件的影响范围 `{PARALLEL_SCOPE}` |
| 实现者测试是否真实覆盖（非只加数量/复制实现逻辑/空断言） | `{IMPLEMENTER_TESTS_VERDICT}` | diff + 抽样断言；native-context.test.ts 22 项真实断言；业务路径集成 `{IMPL_BIZ_COVERAGE}` |
| 是否存在静默跳过/未跑写通过 | `{SKIP_VERDICT}` | grep `.skip/.only/assert.ok(true)`=0；日志无 `# SKIP`（或在报告中列出） |
| 实现者是否把未测项写成通过 | `{HONESTY_VERDICT}` | 其报告“未覆盖/未测”段落核对 |

## 6. 独立验证自身的边界与反自证声明

- 预期来源：DSH交接 00–03 + 固定 SDK 静态源码（见附录 A 指纹）；未读取实现者测试断言作为预期来源。
- 判定器 `tests/verify/support/independent.ts` 不 import 产品源码（静态检查=否 import；report.mjs 失败门禁）。
- 世界/宿主替身 `support/world.ts`、`support/host.ts` 为独立实现；业务路径替身不复用实现者夹具。
- 判定器经手工应过/应拒样本（C00a–C00d）、替身语义自检（C00e）与端到端突变测试（C00f：1 正确 reader 通过、3 个故障 reader 被拒）验真。
- 任何产品/SDK/测试文件变化都会使本结论失效，必须重跑（manifest 记录精确 SHA256）。

## 7. Issue 清单

见 `artifacts/dsh/verify/ISSUES.md`（按最终版更新 B-01…B-04 状态；产品行为问题段 `{PRODUCT_ISSUES}`）。

## 8. 下一步

1. `{NEXT_1}`（若存在未通过/未观测项）。
2. 由 Lead 依据本报告 + 实现者最终 check 日志 + 覆盖矩阵裁决 H1 是否可标记“离线切片完成”。
3. 真实宿主零模型长历史/恢复验证另立批次（G3/V24），不并入本离线结论。

## 附录 A：冻结指纹

- 产品文件 SHA256（见 `runs/{FINAL_RUN_ID}/manifest.json#product`）：
  - `src/adapters/dsh/native-context.ts` `{SHA_NATIVE_CONTEXT}`
  - `src/adapters/dsh/sessions.ts` `{SHA_SESSIONS}`
  - `src/adapters/dsh/goals.ts` `{SHA_GOALS}`
  - `src/adapters/dsh/core-decision.ts` `{SHA_CORE_DECISION}`
  - `src/adapters/dsh/native-message.ts` `{SHA_NATIVE_MESSAGE}`
  - `src/adapters/dsh/session-title.ts` `{SHA_SESSION_TITLE}`
- 固定 SDK 包 SHA256（app.asar 只读，manifest.json#sdk）：`{SDK_HASHES}`
- 测试文件 SHA256（manifest.json#tests，9 个）：`{TEST_HASHES}`
