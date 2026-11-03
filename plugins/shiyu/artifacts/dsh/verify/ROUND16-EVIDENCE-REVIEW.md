# round-16 证据独立复核（task-65，完成）

- 最终身份：X=`dcede28`、host=`893f846`、X+1=`40df964`；slice `fcb7604`、H7-round16 `e33b93e`。
- 只读复核 commit blob/evidence/`.local` 日志/只读 DB/Session；未改他人文件、未 git 提交。
- 结论：**绑定修复生效；首次到达真实模型请求层；provider 空 stream 为新阻塞；0 usage/未重试/第七次未授权；审计与残留披露诚实；H7 未升级；X+1 符合约定。** F16-R1 为 host bytes；R2/R3 info。

## 0. 绑定/诊断/v6 — 通过

- `fcb7604` files 7/7；隔离 **1689/1689**（`c7d76d94…`/178726）；组合 **1700/1700**（`26693952…`/179396）。
- host assembly renderer 与 bounded probe 同 renderer 重建 expected runtime-context；精确 hash 或结构绑定（source kind/form/section 渲染/cwd）均接受；额外 section 仅被投影并渲染时接受；仍 1–2 条、第 1 条精确 owner；第三条/错序/坏 context 请求前 fail closed；其它检查不变。
- contextDiagnostic 字段名/hash 前缀、无正文/路径；error→core-domain→unknown evaluation→preStopEvaluation.contextDiagnostic；首次 reason 保留；bounded validator。
- v6 常量 requestId/content/template sha 冻结、exact-only；reconcile [v1..v6] caller 不可选；集成 runtime/index/output schema。

## 1. 宿主 893f846 — 首次真实模型请求，空 stream

| 项 | 结果 |
|---|---|
| create | 再次成功 authorized=true/active/mandate/goalRef rev1/1 Goal Session/partialCreation=false；receipt 3917B/sha `80afd9bd…` |
| **首次模型请求** | Goal Session **21 events**：step/start、system message、owner user、runtime-context user、**request/header（provider=opencode-go、model=deepseek-v4.1-flash、effort、maxTokens、3 个只读事件工具）**、**request/context（1M）**、**assistant/attempt streamLength=0**、step end/turn end aborted |
| evaluation | failed/EVALUATION_UNKNOWN；preStopEvaluation.reasonCode=`CORE_EXECUTION_UNCONFIRMED`（保留）；evaluateAttempts=1；**0 usage/0 completed stream**；stopAction pause ok；未重试 |
| 审计 | 490/61/39/goals7/budget26(unknown5) → reload496/62/39/7 → run/final510/62/40/8/budget27(unknown6)；+14 commitSeq、+1 Goal、+1 Session、+1 unknown budget；无 events/Task/Effect/artifact；state/known 不变 |
| v6 Goal | `core-02829b…` version5 authorized/paused/activeEvaluation unknown；budget held 16384/2；DB create command confirmed；第七次未授权 |
| **F16-R1** | joint cachedReceipt bytes=66937 vs actual status-final **70221**（sha `ea856219…` 匹配；你给的 70221 正确） |

## 2. H7-round16 — 通过

- files 14/14；**88 sources/339 files**；round15 v5 证据等级 `fixed-host-create-succeeded-evaluation-failure`；V25 不接收；产品 79/79 not_covered；tooling/V/S/FL 不升级；isolated 172/172、full 1692、archives 3 真实；issues 0。

## 3. X+1 40df964 — 通过

- 11 artifacts（全 M，parent=dcede28）；code/tests/scripts diff=0；manifest head=dcede28/dirty=false/leaks0、generatedAt=16:51:35.805Z、aggregates 407/7,485,173/`24b324a6…`；clean **1700/1700**（`b75b5cc6…`/179397）；pipeline `41a7bb9b…`/3478；archive `77b21371…`/839；selfproof 21 files/172；**88/88 sources/339 files、0 unknown**；产品 79/79 not_covered；gate=incomplete/executed=passed=0；11 artifact SHA/bytes 已记录。

## 4. findings/边界

- **F16-R1**（minor-bytes）：cachedReceipt bytes 66937 vs actual status-final 70221
- **F16-R2**（info-wording）：createSuccess says confirmed binding while create snapshot reported bindingReceiptStatus absent
- **F16-R3**（info-boundary）：Empty provider stream/new blocker; 0 usage; v4/v5/v6 residual; seventh unauthorized

- 绑定修复生效、首次到模型层；但 provider 空 stream 原因未显式暴露，尚无完成 model stream/usage；不证业务链。
- 第七次未授权；v4/v5/v6 残留 unknown 预算需 reconcile/披露；round-16 host 未入 H7（下一轮）；产品 79/79 not_covered，无 V25/九系统升级。
