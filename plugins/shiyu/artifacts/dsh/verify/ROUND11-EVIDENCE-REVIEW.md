# round-11 证据独立复核（task-50，完成）

- 复核对象：X=`fe6d5f7`（诊断/泛化 reconcile）、host=`7d9979e`、X+1=`7ad2621`；commit `196024a`（诊断/泛化）、`1eea3e8`（H7-round11）、`fe6d5f7`（集成）。
- 只读复核 commit blob/evidence/`.local` 日志/只读 DB/Goal Session；未改他人文件、未 git 提交。
- 结论：**round-11 证据真实、失败/诊断/dormant 边界诚实；reconcile 仅 v1 no-op + v2 一次 cancel；H7 未升级；X+1 满足约定。** F11-R1/R2 为次要 bytes/cache 字段问题，R3/R4 为 info。

## 0. history-assert 诊断 — 通过

- `196024a` files 5/5；隔离 **1597/1597、0 skip**（`12289fc3…`/170794）；14 net new tests（core-event-tools 47、core-validation 40）。
- `historyDiagnostic`：mismatchKinds event-count/live-seq-vs-event-count/prefix-digest/header-hash/inherited-count/session-id/preset/references/projection/unknown；expected/live eventCount/seq/hash prefix/delta、≤300、无正文/路径；透出 error + runner receipt + 独立 validator。
- fake-host 确定性 cold-header：expected 4/live seq 3/delta -1/native create 0；审核确认 **liveCut 候选修复 dormant、未激活**；未猜测修改产品行为。

## 1. v1/v2 reconcile 泛化 — 通过

- 固定 `CORE_VALIDATION_RECONCILE_REQUEST_IDS=[v1,v2]`，caller 不可选择；每目标仅 inert 一次 cancel/postCancel；0 重试/0 模型/不创建；顶字段 v1 兼容 + targets[]；tests/validator 真实。

## 2. 宿主 7d9979e — reconcile 通过，披露边界明确

| 项 | 结果 |
|---|---|
| receipt | 2825B/sha `0a6ea978…`；v1 cancelled/no action/cancelAttempts0；v2 inert-unauthorized→cancelAttempts1/postCancel cancelled+paused+version2；readOnly true/createsGoal false/modelCalls0/retries0；unknowns [] |
| 审计 | 427/56/35/goals4 → reload 433/57/35/4 → run/final 434/57/35/4；reconcile 仅 +1 commitSeq；无 events/Goal/Task-state/Effect/budget/Session/artifact 变化；state sha 不变；known35 Session 字节不变 |
| DB | v1/v2 Goal 均 cancelled=true/paused=true/version2；总 goals 仍 4 |
| 边界 | 只证 reconcile；create history-assert 未修复；cold-header 候选未 host-confirmed；第三次实验未授权；无 pass/V25/business 声明 |
| **F11-R1** | cachedReceipt.bytes=58079，实际 status-final **61122B**（sha `3b595259…` 匹配；你消息 61121 少 1） |
| **F11-R2** | joint findings 称 cache 含 readOnly/createsGoal/modelCalls/retries，实际 `diagnostics.coreValidationReconcile` 无这些字段（只在 receipt 文件） |
| plan | `artifacts/dsh/host/round11/plan.json` 1419B/sha `8733779…` 存在且匹配 |

## 3. H7-round11 / X+1 — 通过

- H7 files 9/9；**61 sources/198 files**；4 新 sources/19 files；round10 v2 failure 仅 `fixed-host-failure-diagnostic`；V25 不接收；merge provenance 为 info-only 未映射；产品 79/79 not_covered；tooling/V/S/FL 不升级；full 1591、harness 123；archives 4/4。
- X+1 `7ad2621`：11 artifacts（全 M，parent=X）；`fe6d5f7..7ad2621` 及至 HEAD 的 src/client/tests/scripts diff=0；manifest `{head:fe6d5f7…,dirty:false,dirtyEntries:0}`、generatedAt=07:00:10.684Z、leaks=0、aggregates 404/7,249,365/`b9b96225…`；clean **1605/1605**（`24f63f7a…`/171178）；pipeline `dcde725d…`/3095；archive `93d67e23…`/839；selfproof 16/123；61/61 sources/198 files、0 unknown；产品 79/79、gate incomplete/executed=passed=0；11 artifact SHA/bytes 与 test-harness/test-harness 提供一致。

## 4. findings

- **F11-R1**（minor-bytes）：cachedReceipt bytes 58079 vs actual status-final 61122 (Lead note 61121)
- **F11-R2**（minor-cache-claim）：joint findings claims cache has readOnly/createsGoal/modelCalls/retries, but status diagnostics cache lacks them
- **F11-R3**（info-wording）：reload delta includes normal task-metadata/capability changes though classification says business facts unchanged
- **F11-R4**（info-scope）：merge provenance is info-only and not mapped

## 5. 边界

- 诊断/cold-header 候选未 host-confirmed；liveCut 未激活；create 未修复；第三次实验未授权。
- 本轮只证 reconcile 路径，不证真实 business chain；产品 79/79 not_covered，无 V25/九系统升级。
- F11-R1/R2 建议修正；R3/R4 info（reload 期间 task metadata version 44→45/capability 47→49 属正常启动记账；merge provenance 仅 info）。
