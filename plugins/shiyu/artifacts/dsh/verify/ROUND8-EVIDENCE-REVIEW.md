# round-8 证据独立复核（task-43，完成）

- 复核对象：X=`7c0b22a`、X+1=`f766ab7`、host=`f10affc`（HEAD）；H3 reconcile=`5f9ac00`、H7-round8=`4d5ba0d`、集成=`7c0b22a`。
- 只读复核 commit blob/evidence/`.local` 日志/只读 DB/构建；未改他人文件、未 git 提交。
- 结论：**round-8 证据真实、披露诚实；reconcile 仅处理 inert 残留 Goal，一次 cancel、无模型/重试/创建；未把 reconcile 当业务链通过；F8-R1/R2 已修，X+1 满足约定。**

## 0. H3 create 失败回读+reconcile 5f9ac00 — 通过

- files 2/2、patch `d2dac5b8…`/8454 匹配；隔离 **1552/1552、0 skip**（`805b5be4…`/166703）；29 tests（+13）。
- readback：create 抛错后只读回读 requestId→Goal/binding session；`created=true|false|unknown` + `partialCreation`；不可用→unknown；不重试/不自动 cancel。
- reconcile：absent/inert-unauthorized/paused-authorized/cancelled/unknown；**仅 inert 恰一次 cancel**；拒绝保留 errorCode；postCancel 回读；paused-authorized 不 cancel；固定 requestId/拒绝 caller 输入；不创建/不调模型；validator mutation 自证；无 skip/恒真。

## 1. H7-round8 4d5ba0d — 通过

- files 8/8；**52 sources/160 files**；新增 5 sources/18 files；round7 失败仅 `fixed-host-failure-diagnostic`（无 pass/V25/business/nine-system）；V25 不接收；review `independent-review-info` 且所有 product/module/system mappings 不引用；产品 79/79 not_covered、covered=0；tooling_ready 仅 TV.1–7/9；gate incomplete；logs 1547/107/107，archives 4/4 匹配。

## 2. 集成 7c0b22a — 通过

- files 3/3 + slice files 17/17；隔离 **1561/1561、0 skip**（`aa181574…`/167267）。

## 3. 宿主 f10affc — 通过（F8-R1/R2 已修）

| 项 | 结果 |
|---|---|
| receipt | classification inert-unauthorized、readback complete、cancelAttempts 1、postCancel `{cancelled:true,paused:true,version:2}`、unknowns []、readOnly true/createsGoal false/modelCalls 0/retries 0；1083B/sha 匹配 |
| 审计 | before 405/53/34/cap41/goals3 → reload 411/54/34/43/goals3 → run/final 412/54/34/43/goals3；**reconcile 恰 +1 commitSeq**；events 不变；无新增/删除 session/Goal/Task-state/Effect/budget/artifact；state sha 不变；known 34 Session 字节不变 |
| live DB | Goal `core-17e3fe95…` request `core-validation-frozen-v1` **cancelled true/paused true/version2**；总 goals 仍 3 |
| **F8-R1 已修** | `cachedReceipt.bytes=58,375` + `bytesSemantics`，与实际 status-final/sha 匹配 |
| **F8-R2 已修** | `cachedReceipt` 只保留实际缓存字段 + `fieldsPresent`；readOnly/createsGoal/modelCalls/retries 移到 `declaredOnlyInReceipt` 并注明仅在 receipt，findings 第 3 条同步更新 |
| dist | `7c0b22a` 独立重建 113/`c4887fa9…`；definitionDigest `5a591515…` 不变；plan `5ee15ff2…` 存在 |
| 边界 | status=reconcile-passed；limitations 明确只证 reconcile/cancel、不证业务链、不修复 create 失败、未来需新冻结计划 |

## 4. X+1 f766ab7 — 通过

| 项 | 结果 |
|---|---|
| 差异 | 11 artifacts（全 M，parent=X）；`7c0b22a..f766ab7` 及至 HEAD 的 src/client/tests/scripts diff=0 |
| manifest | `{head:7c0b22a…,dirty:false,dirtyEntries:0}`、generatedAt=03:54:01.191Z、leaks=0、aggregates 404/7,162,480/`9e9837e5…` |
| clean | 1561/1561、0 skip（`a2f60e04…`/167299）；pipeline `2bde1fcf…`/2948；archive `73a77b85…`/867 |
| selfproof/来源 | 14 files/107；52/52 sources/160 files、0 unknown；oracle 15/7/22 |
| 产品/acceptance | 79/79 not_covered、covered=0、tooling_ready TV.1–7/9；gate=incomplete/completeNineSystems=false，planned92/executed0/passed0/failed0/blocked19/notRun73；issues=0 |

## 5. findings

- **F8-R1**（evidence-metadata-bug）：cachedReceipt bytes 55,376 vs actual status-final 58,375 — fixed-in-f10affc
- **F8-R2**（cache-claim-mismatch）：Cached status receipt lacks readOnly/createsGoal/modelCalls/retries but joint findings claims them — fixed-in-f10affc
- **F8-R3**（pending）：Host commit and X+1 pending — resolved-by-f766ab7-and-f10affc
- **F8-R4**（info-wording）：Reload delta includes normal task metadata/capability epoch changes though classification says no business facts changed — info-accepted
- **F8-R5**（info-scope）：Round-8 host evidence not mapped in H7-round8 — info-accepted
- **F8-R6**（info-hygiene）：acceptance inputs contain clean generation temp root — info-accepted

## 6. 边界/未观察

- Host commit/X+1：host draft untracked; X+1 pending
- Real bounded core Goal business chain：round-7 create failed; round-8 only reconciles residual; no plan/Task/worker/verification/native completion
- Original create failure cause：not fixed in this slice; future create needs new explicit owner decision/frozen plan
- Independent suite re-execution：read-only; logs/hashes/counts/Lead checks used
- Round-8 host H7 mapping：host committed after X+1; not in H7-round8 (future round)
- F8-R4 info：reload 期间 task metadata version 41→42/capability epoch 变化属正常启动记账；reconcile 本身仅 +1 commitSeq。F8-R5 info：round-8 host 未入 H7-round8（下一轮）。
