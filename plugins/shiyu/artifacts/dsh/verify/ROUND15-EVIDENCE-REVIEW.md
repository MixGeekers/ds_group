# round-15 证据独立复核（task-62，完成）

- 最终身份：X=`94251aa`、host=`3d31da3`、X+1=`b1c9061`；slice `91fdbf6`、H7-round15 `26e1e14`。
- 只读复核 commit blob/evidence/`.local` 日志/只读 DB/Session；未改他人文件、未 git 提交。
- 结论：**pre-step 语义/边界正确；reason 保留修复生效；create 再次真实成功、evaluation 0 模型失败；preStopEvaluation 真实；审计/残留披露；H7 未升级；X+1 满足约定。** F15-R1 为 host bytes metadata；R2/R3 info。

## 0. pre-step/reason/v5 — 通过

- `91fdbf6` files 6/6；隔离 **1671/1671**（`139d564e…`/177175）；组合 **1682/1682**（`31271870…`/177860）。
- step0 接受 1–2 条（精确 owner + 可选精确 runtime-context 结构绑定）；第三条/错序/坏 context 在请求前 fail closed；decision.messages/tool step/历史检查不变；fake host 正反例真实。
- reason 保留：core-domain `unknown()` 已是 unknown 时保留首次 reason、不覆盖、不重复 reconcile；runner 在唯一 stop 前抓取 preStopEvaluation 并有界校验。
- v5 常量 requestId/content/template sha 冻结、exact-only；reconcile `[v1..v5]` caller 不可选；集成 runtime/index/output schema。

## 1. 宿主 3d31da3 — create 再次成功，evaluation reason 保留

| 项 | 结果 |
|---|---|
| create | 第二次真实成功：authorized=true/paused=false/nativeActive=true/hasMandate=true/goalRef rev1/恰1 Goal Session/partialCreation=false；receipt 3921B/sha `274ce6df…` |
| evaluation | failed/EVALUATION_UNKNOWN；**preStopEvaluation.reasonCode=CORE_NATIVE_CONTEXT_REJECTED**（reason 保留生效，不再 owner_paused）；evaluateAttempts=1；0 模型请求（Session 13 events 无 request/assistant）；stopAction pause ok；未重试 |
| 审计 | 470/60/38/goals6/budget24 → reload476/61/38/6/24 → run/final490/61/39/7/budget25（unknown4→5）；+14 commitSeq、+1 Goal、+1 Session、+1 unknown budget；无 events/Task/Effect/artifact；state/known 不变 |
| v5 Goal | `core-f5d638…` version5 authorized=true/paused=true/activeEvaluation unknown；budget held 16384/2；DB create command confirmed；第六次未授权 |
| 新阻塞 | runtime-context claim 形状（step0 已接受 1–2 条，但第二条 host runtime-context 与当前精确 expected 结构/文本绑定不匹配；下一步用 probe renderer/结构绑定对齐） |
| **F15-R1** | joint cachedReceipt bytes=64766 vs actual status-final **67986**（sha `6ab5b46a…` 匹配；你给的 67986 正确） |

## 2. H7-round15 — 通过

- files 14/14；**84 sources/311 files**；round14 v4 证据等级 `fixed-host-create-succeeded-evaluation-failure`；V25 不接收；产品 79/79 not_covered；tooling/V/S/FL 不升级；isolated 162/162、full 1672、archives 3 真实；issues 0。

## 3. X+1 b1c9061 — 通过

- 11 artifacts（全 M，parent=94251aa）；code/tests/scripts diff=0；manifest head=94251aa/dirty=false/leaks0、generatedAt=13:59:42.399Z、aggregates 407/7,433,706/`c61dce70…`；clean **1682/1682**（`2520a1fb…`/177891）；pipeline `6ee030b7…`/3399；archive `e5dd002b…`/839；selfproof 20 files/162；**84/84 sources/311 files、0 unknown**；产品 79/79 not_covered；gate=incomplete/executed=passed=0；11 artifact SHA/bytes 已记录。

## 4. findings/边界

- **F15-R1**（minor-bytes）：cachedReceipt bytes 64766 vs actual status-final 67986
- **F15-R2**（info-wording）：createSuccess says confirmed binding while create snapshot reported bindingReceiptStatus absent
- **F15-R3**（info-boundary）：v4/v5 residual unknown budgets; sixth unauthorized; no business chain

- create 成功不证业务链；evaluation 0 模型失败；第六次未授权；v4/v5 残留 unknown 预算需 reconcile/披露。
- preStopEvaluation 有界校验；reason 保留修复有效；runtime-context 精确形状仍待诊断（下一轮）。
- round-15 host 未入 H7（下一轮）；产品 79/79 not_covered，无 V25/九系统升级。
