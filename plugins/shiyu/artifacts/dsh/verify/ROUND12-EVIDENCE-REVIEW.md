# round-12 证据独立复核（task-53，完成）

- 复核对象：X=`68b1caf`（v3 cold-cut/实验/集成）、host=`31e5c05`（v3 第三次尝试+清理）、X+1=`1113662`。
- 只读复核 commit blob/evidence/`.local` 日志/只读 DB/Goal Session；未改他人文件、未 git 提交。
- 结论：**第三次 v3 尝试失败但 cold-cut 进展真实；失败/partial/清理边界诚实，未冒充业务通过；H7 未升级；X+1 满足约定。** F12-R1/R2/R3 为证据绑定/metadata/完整性 minor，R4 为 info。

## 0. X：cold-cut 激活 + v3 冻结 + reconcile 泛化 — 通过

- `ccefc57` h3 slice files 4/4；隔离 **1613/1613**（`21114f28…`/172099）；组合 **1623/1623**（`52cfd4ec…`/172866；1605+8+9+1）。
- **create-only liveCut**：`stabilizeCoreCreateBaseline` 传 `liveCut: seq-excluding-header`；仅新会话 create 使用，recovery/expectedPrefix 保持严格 event-count；native create 恰一次不 replay；其他错误立即失败。
- **v3 冻结**：requestId `core-validation-frozen-v3`、固定 template/content sha/budget/max2；仅 exact 常量引用；reconcile 固定 `[v1,v2,v3]` caller 不可选；8 net tests 真实。
- **F12-R1**：round12 integrated slice 证据文件清单仍写 `h7-round12-slice.json` 4799B，实际 X 为 6690B（1880? sha 变化）；集成 1623 测试仍通过，X+1 clean 使用最终文件。

## 1. 宿主 v3 第三次尝试 — 失败，披露诚实

| 项 | 结果 |
|---|---|
| receipt | 5999B/sha `7eefe41d…`；failed/CORE_VALIDATION_CREATE_FAILED；failurePhase=history-assert/failureCode=NATIVE_HISTORY_CHANGED；header-hash；expected.eventCount3=live.seq3、delta0；cold `baa30ad4…` vs live `bbd0090c…`；evaluateAttempts0；stopAction none；partialCreation detected/readback complete；0 retry |
| 审计 | 434/57/35/goals4 → reload 440/58/35/4 → attempt 443/58/36/5 → reconcile/final 444/58/36/5；attempt +3 commitSeq/goal/session；无 events/Task/Effect/budget/artifact；state sha 不变；known35 Session 不变 |
| v3 Goal/Session | `core-3e89f8…` unauthorized/paused/evals0/无 mandate/native；Session 解码恰 4 条（session+permission/preset+sandbox/mode+approval/policy）；journal unknown 同 reason |
| 结论 | cold-cut 修好 event-count/seq；新阻塞 header-hash；第四次未授权；create 未修复；无 pass/V25/business |

## 2. 失败后 reconcile 清理 — 通过（非业务通过）

- 一次广义调用固定 [v1,v2,v3]：v1/v2 cancelled 无动作；v3 inert-unauthorized→恰一次 cancel/postCancel cancelled+paused+version2/unknowns[]；readOnly/createsGoal/modelCalls/retries 声明在 receipt。
- 审计 443→444 **仅 +1 commitSeq**，无 events/Goal/Task-state/Effect/budget/Session/artifact 变化，state/known35 不变；DB v1/v2/v3 均 cancelled version2；status-final 缓存 failed v3 + reconcile。
- **F12-R2**：host joint `cachedReceipt` 62489B/sha `f78c8f5d…` 与实际 final `status-final` 69295B/sha `e727ffcc…` 不同（attempt-time snapshot 未保留）；`statusFinal`/`postAttemptReconcile.statusPayload` 写 66187B（sha e727 匹配，bytes 错）。
- **F12-R3**：task 说 6 审计，host/round12 实际 5 个 audit JSON（before/reload/run/after-reconcile/final）；需补或说明。
- plan `artifacts/dsh/host/round12/plan.json` 2273B/sha `b9393d6b…` 存在且匹配。

## 3. H7-round12 / X+1 — 通过

- H7 files 10/10；**67 sources/224 files**；6 新 sources/26 files；round11 host reconcile 仅 `fixed-host-zero-model-reconcile`；V25 不接收；产品 79/79 not_covered；tooling/V/S/FL 不升级；full 1614、harness 132；archives 4/4。
- X+1 `1113662`：11 artifacts（全 M，parent=X）；`68b1caf..1113662` 及至 HEAD 的 src/client/tests/scripts diff=0；manifest head=68b1caf/dirty=false、generatedAt=08:22:49.599Z、leaks=0、aggregates 404/7,280,449/`6dfa9186…`；clean **1623/1623**（`a306a454…`/172840）；pipeline `f5efeb4b…`/3169；archive `fb34b6f0…`/839；selfproof 17/123→132；67/67 sources/224 files、0 unknown；产品 79/79；gate=incomplete/executed=passed=0；11 artifact SHA/bytes 已记录。

## 4. findings/边界

- **F12-R1**（minor-evidence-binding）：round12 integrated slice evidence binds stale h7-round12-slice (4799B vs actual 6690B)
- **F12-R2**（minor-bytes）：Host status payload bytes/sha references stale
- **F12-R3**（minor-completeness）：Task says six audits; host/round12 contains five audit JSON
- **F12-R4**（info-scope）：Round-12 host evidence not yet mapped in H7 (round13)

- header-hash 根因未知，第四次未授权；create 未修复；reconcile 仅清理非业务通过；产品 79/79 not_covered，无 V25/九系统升级。
- round-12 host 证据未入 H7（round-13 工作）；F12-R4 info。
