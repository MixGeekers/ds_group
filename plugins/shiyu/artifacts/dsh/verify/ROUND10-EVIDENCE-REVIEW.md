# round-10 证据独立复核（task-47，完成）

- 复核对象：X=`b09416f`（v2 激活+output schema 修复）、host=`6d65135`（v2 失败证据）、X+1=`b5bc3cc`、merge=`6392c7e`（parents `6d65135`+`081e987`）。
- 只读复核 commit blob/evidence/`.local` 日志/只读 DB/Goal Session/git merge；未改他人文件、未 git 提交。
- 结论：**v2 首次宿主尝试明确失败、未重试、未冒充通过；merge 真实保留远端历史；X+1 满足约定；H7 未升级。** F10-R1/R2/R3 为证据绑定/metadata/provenance 问题，需修正但不改变失败披露。

## 0. X b09416f — v2 激活 + output schema 修复

- 新增 `runtime.probe-core-goal-v2` + 无参数 `shiyu_validate_core_goal_v2`，仅传精确 `CORE_VALIDATION_EXPERIMENT`；v1 不重试；output schema 修复（index.ts +4 行）真实；隔离 1583/1583（`45d06d35…`/169245）。
- **F10-R1**：activation evidence/slice 文件清单写 `src/index.ts` 14765B/sha `39a982dd…`，但 b09416f 实际 14947B/sha `68828810…`（amend 的 +4 行未入 X 证据；X+1 clean 1583 覆盖最终代码）。

## 1. 宿主 v2 尝试 — 失败证据诚实

| 项 | 结果 |
|---|---|
| receipt | 5700B/sha `734e1b01…`；failed/CORE_VALIDATION_CREATE_FAILED；failurePhase=history-assert/failureCode=NATIVE_HISTORY_CHANGED；evaluateAttempts=0；stopAction none；partialCreation detected/readback complete；0 retry |
| 审计 | 412/54/34/goals3 → reload 424/56/34/3 → run/final 427/56/35/4；attempt +3 commitSeq；无 events/Task/Effect/budget/artifact；state sha 不变；known 34 Session 字节不变 |
| 新 Goal/Session | v2 Goal `core-9f494d…`（request core-validation-frozen-v2、v1、unauthorized/paused/cancelled false/evals0、无 mandate/native）+ 1 Session（解码恰 4 条：session+permission/preset+sandbox/mode+approval/policy）；journal unknown 同 reason |
| 结论披露 | 两次独立失败同 history-assert → 确定性不匹配；第三次未授权；v2 残留无法用 v1-only reconcile 清理；无 pass/V25/business 声明 |
| **F10-R2** | joint cachedReceipt.bytes=61039，实际 status-final 64082B（sha `27805dd5…` 匹配） |
| **F10-R3** | joint plan `.local/dsh-round10-host-execution-plan.json`/sha `c6be8da1…` 未找到 |

## 2. merge 真实性 — 通过

- `6392c7e` parents = `6d65135` + `081e987`；`081e987..6392c7e` **无删除文件**、无冲突标记；仅 index.ts output schema +4 行、round10 证据/doc、X+1 产物；代码 HEAD==b09416f；远端 081e987 是祖先、origin 已前进到 merge（非 force-push 改写历史）。

## 3. X+1 b5bc3cc — 通过

- 11 artifacts（全 M，parent=b09416f）；`b09416f..b5bc3cc` 及至 HEAD 的 src/client/tests/scripts diff=0；manifest `{head:b09416f…,dirty:false,dirtyEntries:0}`、generatedAt=05:36:48.271Z、leaks=0、aggregates 404/7,206,587/`b0fd920c…`；clean **1583/1583**（`4826fdc6…`/169127）；pipeline `ff33a1e2…`/3021；archive `82d71408…`/872；selfproof 15 files/115；57/57 sources/179 files、0 unknown；产品 79/79 not_covered、covered=0；gate=incomplete/completeNineSystems=false，planned92/executed0/passed0/failed0/blocked19/notRun73；issues=0。

## 4. H7/边界

- H7 未升级：57/57 sources、产品 79/79 not_covered、tooling/V/S/FL 不升级、gate incomplete；round10 v2 失败未映射为 pass。
- v2 失败非通过；无核心 plan/model/Task/native completion；第三次尝试未授权；根因仍在 history-assert 层，需 instrument exact expected/live counts/digests 后另行修复。
- F10 findings：R1 evidence-binding（moderate）、R2 bytes、R3 plan provenance；R4 merge info。建议修正后随最终证据入库。
