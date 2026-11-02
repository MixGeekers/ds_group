# H1 独立验证：Issue 清单（最终，随 H1 提交 92c857f）

结论：**产品行为问题：无。** 独立套件 117 条逐例记录 / 103 个 TAP tests 全部通过（0 失败 / 0 blocked / 0 unobservable / 0 unreported / 0 skip）。
最终报告：`FINAL-REPORT.md`；最终运行：`runs/2026-11-02T18-49-33-366Z-final-92c857f/`；被测提交 `92c857f`。

## A. 产品行为问题

无。未发现静默截断、错误接收回执、异源输入被吞、重复派发、旧基准放行、句柄泄漏或正文泄漏。

## B. 证据/环境事项（均已核实或规避，不改变产品行为结论）

| ID | 状态 | 事实 | 证据 |
|---|---|---|---|
| B-01 主套件旧夹具曾红 | **已解决** | 曾被 `tests/session-reply-accounting.test.ts` 旧夹具（缺 runMaintenance/seq/append/version-4 header/sessions.get/projector asOfSeq）阻塞；实现者已按新契约更新，未删除/跳过断言 | `92c857f`；`phase3j-final-check.log` 1058/1058/0；独立复现一致 |
| B-02 全量 check 受并行 WIP 干扰 | **已规避** | 主树含 H4/H5 未跟踪 WIP，直接全量 check 不可归因；实现者与 Lead 均在隔离 worktree 运行并留 9 文件哈希 | 实现者 `/tmp/shiyu-h1-check`；Lead `artifacts/dsh/slices/h1-verify.json` |
| B-03 实现者业务路径自测缺口 | **已解决** | 最终版新增 `tests/native-history.test.ts` 14 项业务路径集成测试；core-goal-sessions 17→20；模块级 22 项真实断言 | `92c857f` 测试文件；`implementer-evidence-review.json` EV-07 |
| B-04 最终 check 日志真实性 | **已核实** | 日志 SHA256 `8c05c87f…` 与声明一致；独立复现（同隔离 worktree）exit 0、1058/1058/0/skip 0、源文件哈希前后不变；Lead 隔离切片验证日志 `aa342679…` 亦一致 | `implementer-evidence-review.json` EV-02–EV-05；`replication-final-check.log` |
| B-05 文档时间戳小差异 | **记录（不影响结论）** | 实现者 `artifacts/dsh/h1/h1-verification.json` 记 startedAt=18:39:49Z，保留日志头为 18:42:44Z→18:44:47Z；计数/哈希/退出码/独立复现完全一致 | `implementer-evidence-review.json` EV-09 |

## C. 明确未覆盖/不可观察项（按 03 §5 最后一行分层留证，不是失败）

| 未覆盖项 | 原因 | 需要的后续证据 |
|---|---|---|
| 真实 DSH 宿主长历史冷恢复/恢复（真实 JSONL/projection/agent resume，零模型） | 本套件为合成原生替身 + 固定 SDK 静态契约层，不执行真实宿主 | Lead 冻结的 G3/V24 零模型重载/隔离根验证 |
| 真实模型生成、标题/压缩旁路、provider 重试与计费/缓存完整性 | 不调用模型/网络 | 有界真实模型批次与独立观测器；压缩单独评估 |
| 原生压缩/检查点后的恢复 | H1 实现未接线压缩（实现者也已声明） | H1 后续切片 |
| 跨进程/任意外部写者原子快照 | 固定 SDK 为 append-only 合同，非原子快照（03 §3） | 不承诺，按观察/使用边界留证 |
| 真实后端性能/资源上界、长期运行 | 替身不提供真实解码/存储成本 | 宿主性能/长期运行测试 |
| 真实频道、设备、备份与恢复（H2+、V21/V22/V26/V27） | 资源与授权范围 | 后续切片 |
| 生命周期（非 core）Goal namespace 的新恢复基准 | 实现者声明保持旧行为 | 如需另行评估 |

## D. 已解决的接口/契约风险

- 接口名称调整（03 §4.4 允许）：最终导出 `coldNativeInboxSnapshot/expectedPrefix/extendNativeHistorySnapshot/assertNativeLiveHistory/observeNativeBaseline/trustedNativeRecoverySuffix` 等；独立套件用动态导出探测绑定行为目标，未把改名当失败。
- `header.version===4`、`−0`、非 seeded 继承=0、seeded 切口 marker 均按冻结 SDK 契约拒绝；独立用例 I07–I14 与实现自测一致。

## E. 判定器/套件完整性

见 `latest.md` §4 与 `latest.json.integrity`：判定器未 import 产品源码；无 `.skip/.only/assert.ok(true)`；每个测试文件均有结构化证据；C00a–C00f 手工应过/应拒样本 + 1 正确/3 故障突变体；聚合器否定对照见 `negative-control.json`（fail/blocked/unreported 均不会升级为 pass）。
