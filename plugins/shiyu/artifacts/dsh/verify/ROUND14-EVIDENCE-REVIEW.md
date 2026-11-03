# round-14 证据独立复核（task-59，完成；H7 更正已入库 437ac97）

- 最终身份：X=`7d5d2e1`、host=`732b9f7`、X+1=`4f8c342`、H7-round14 更正=`437ac97`。
- 只读复核 commit blob/evidence/`.local` 日志/只读 DB/Session；未改他人文件、未 git 提交。
- 结论：**归一化范围/边界正确；create 首次真实成功、evaluation 0 模型失败与 reason masking 披露诚实；v4 残留/预算披露；H7 未升级；X+1 满足约定；H7 占位已由 437ac97 修正入库。** F14-R1 为 host bytes metadata；F14-R2 已解决；R3/R4 info。

## 0. 归一化 + v4 — 通过

- `2752f49` files 6/6；隔离 **1651/1651**（`ddf99a0a…`/175494）；组合 **1662/1662**（`bc962e12…`/176180）。
- create-only `headerCanonicalization=delegation-depth-default-zero`：仅 cold `delegationDepth=number:0` 且 live absent/null、仅在 create 比较副本注入 0；recovery/resume/expectedPrefix/default strict 不变；不归一化其它字段；native create 恰一次。
- v4 常量 requestId/content/template sha 冻结、exact-only；reconcile `[v1,v2,v3,v4]` caller 不可选；集成仅 runtime/index + output schema。

## 1. 宿主 732b9f7 — create 首次成功，evaluation 失败

| 项 | 结果 |
|---|---|
| create | 首次真实成功：authorized=true、paused=false、nativePhase=active、hasMandate=true、goalRef rev1、恰 1 Goal Session、partialCreation=false；receipt 3744B/sha `c378aaea…` |
| evaluation | failed/CORE_VALIDATION_EVALUATION_UNKNOWN、evaluateAttempts=1、**0 model requests**（Goal Session 13 events，无 request/assistant）；reason 被 pause 路径掩盖为 `owner_paused`；stopAction pause ok |
| 审计 | before 450/59/37/goals5/budget24 → reload456/60/37/5/24 → run/final470/60/38/6/budget25（unknown3→4）；+14 commitSeq、+1 Goal、+1 Session、+1 unknown budget；无 events/Task/Effect/artifact；state/known37 不变 |
| v4 Goal | `core-92818c…` version5 authorized=true/paused=true/cancelled=false/activeEvaluation unknown；budget held 16384/2/0；DB create command confirmed |
| 边界 | 第五次未授权；未重试；create 阻塞已解决，新阻塞在 decision pre-step 形状/reason 保留；不证业务链 |
| **F14-R1** | joint cachedReceipt bytes=62422 vs actual status-final **65594**（sha `f8443b15…` 匹配；Lead 65593 少1） |

## 2. H7-round14 / 更正 437ac97 — 通过

- HEAD `437ac97`（parent 732b9f7，单文件更正）已替换占位：真实 tsc `bcb1a617…`/11、harness `38b9613a…`/11773（152/152）、full `8f685d2d…`/175049（1653）；archivedCopies 3 项；sharedTree `blockedByConcurrentWip=true` 且明确 non-green（污染观测不冒充 green）。commit message 说 four archives 而文件 3 项（shared contaminated log 未入 archivedCopies）——仅 wording 小差异。
- H7 79 sources/282 files；round13 header-cut 探针仅 `fixed-host-zero-model`；V25 不接收；产品 79/79 not_covered；tooling/V/S/FL 不升级；issues 0。

## 3. X+1 4f8c342 — 通过

- 11 artifacts（全 M，parent=7d5d2e1）；code/tests/scripts diff=0；manifest head=7d5d2e1/dirty=false/leaks0、generatedAt=11:53:59.306Z、aggregates 407/7,396,719/`96fa6f1b…`；clean **1662/1662**（`d0b0ef6f…`/176147）；pipeline `8d396a1e…`/3323；archive `8e732448…`/839；selfproof 19 files/152；**79/79 sources/282 files、0 unknown**；产品 79/79 not_covered；gate=incomplete/executed=passed=0；11 artifact SHA/bytes 已记录。

## 4. findings/边界

- **F14-R1**（minor-bytes）：cachedReceipt bytes 62422 vs actual status-final 65594 (Lead 65593) — open-minor
- **F14-R2**（pending-evidence）：H7-round14 committed slice still placeholder; corrected real-log slice uncommitted — fixed-in-437ac97
- **F14-R3**（info-wording）：CreateSuccess says binding receipt absent→confirmed while create snapshot reported absent — info-accepted
- **F14-R4**（info-boundary）：Evaluation reason masked owner_paused; 0 model requests; unknown budget held; fifth unauthorized — info-accepted

- 未修复 header evaluation pre-step/reason preservation；第五次未授权；v4 Goal/unknown budget 残留需处理；不证业务链。
- round-14 host 未入 H7（下一轮）；F14-R3 createSuccess “binding absent→confirmed”为历史措辞 info；F14-R4 info。
