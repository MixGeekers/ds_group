# round-13 证据独立复核（task-56，完成；H7 更正待提交）

- 复核对象：X=`76c7116`、host=`9ba7e70`、X+1=`4c2de7c`；slice `4421b6a`、H7-round13 `e371479`。
- 只读复核 commit blob/evidence/`.local` 日志/只读 DB/Session；未改他人文件、未 git 提交。
- 结论：**headerDiff/零模型探针/宿主精确字段差异真实且无泄露；探针零副作用/清理；失败/未授权边界诚实；H7 未升级；X+1 满足约定。** F13-R1 为 host bytes metadata；F13-R2 为 H7-round13 占位更正未提交（已知 caveat，列入待补）。

## 0. headerDiff 诊断 — 通过

- `4421b6a` files 5/5；隔离 **1632/1632、0 skip**（`e34c6a8d…`/173814）；组合 **1643/1643**（`17b98b3e…`/174494）。
- headerDiff 仅字段名+值类别：boolean/number/string-sha8hex/object/array/null/absent；**≤12 项、≤80/项、join≤300**；总诊断上限 **300→600** 已披露并双 validator 校验；无正文/路径；fake host 覆盖 isSeeded/createdAt/delegationDepth/cwd。
- 零模型探针：恰好 1 个裸 lifecycle Session（Goal preset/cwd/meta、无事件工具、拒绝模型、空 inbox）；flush→cold→live→assert(liveCut seq-excluding-header)；finally cancel/dispose/archive；admission paused/busy/capacity；失败/cleanup 失败诚实报告。

## 1. 宿主 9ba7e70 — 精确字段差异，仅诊断

| 项 | 结果 |
|---|---|
| receipt | 903B/sha `a7cc6e83…`；status completed、zeroModel/zeroEmbedding/zeroTaskOrEffect、createdGoal false；matched=false、mismatchKind=header-hash；**headerDiff=[delegationDepth: number:0→absent]**；cold event3/hash421ba38b、live seq3/hash815793bb；9 checks；released/disposed/archived/cleanup ok |
| Session | `shiyu-native-header-cut-d2fd51f0…`；审计恰新增 1 个 Session 文件；known36 不变；无 Goal/Task/Effect/budget/artifact |
| 审计 | 444/58/36/goals5 → reload450/59/36/5 → probe/final450/59/37/5；probe commitSeq/events/goals/tasks/budget/effects/state 不变 |
| 边界 | 诊断 only；未修复 headerDiff；第四次未授权；无模型/Goal/业务写；产品 79/79 not_covered |
| **F13-R1** | joint receipt bytes=901 vs actual **903**；cachedReceipt bytes=57582 vs actual status-final **60692**（sha `9abd48d7…` 匹配；你给的 60692 正确） |

## 2. H7-round13 — **已知 caveat，更正未提交（待补）**

- HEAD `h7-round13-slice.json` 是开发期占位：sharedTree **142/142/0**、archivedCopies=[]、日志 sha/bytes 为空；**不得当作 green 证据**。
- 工作树存在未提交更正（`M h7-round13-slice.json` + `M tests/harness-round13.test.ts`）：sharedTree 标 `blockedByConcurrentWip=true`、真实 shared 日志 `ac5235b9…`/43478（**100 pass/42 fail**，不 green）、isolated `ca4889ee…`/11159（142/142）、full `f977bdb9…`/173500（1633）、archivedCopies 真实。内容核对一致，但**未 commit**；最终 SHA `9ba7e70` 前未提交。
- 建议 Lead/B 提交独立更正并给出 blob SHA；在此之前 H7 占位声明不能作为最终绿证据（X+1 clean 1643 是真实独立的完整运行）。
- H7 未升级：round12 v3 failure 仅 `fixed-host-failure-diagnostic`、cleanup reconcile 仅 `fixed-host-zero-model-reconcile`；V25 不接收；review info-only；产品 79/79 not_covered。

## 3. X+1 4c2de7c — 通过

- 11 artifacts（全 M，parent=76c7116）；code/tests/scripts diff=0；manifest head=76c7116/dirty=false、generatedAt=10:07:48.085Z、leaks=0、aggregates 407/7,360,380/`2dedf999…`；clean **1643/1643**（`192fee72…`/174535）；pipeline `2e1c3995…`/3245；archive `90c08f5f…`/839；selfproof 18 files/142；**73/73 sources/254 files、0 unknown**；产品 79/79 not_covered；gate=incomplete/executed=passed=0；11 artifact SHA/bytes 已记录。

## 4. findings/边界

- **F13-R1**（minor-bytes）：Host receipt 901 vs actual 903; cachedReceipt 57582 vs final status 60692
- **F13-R2**（pending-evidence）：H7-round13 committed slice still contains development placeholders; corrected version uncommitted
- **F13-R3**（info-boundary）：headerDiff total bound 300→600 documented and double-validated
- **F13-R4**（info-scope）：Host probe diagnosis only; no fix/fourth attempt; round13 host not mapped in H7

- 只证 header-cut 诊断，不证业务链；未修复头部字段、第四次未授权；无宿主模型/Goal/Task/Effect/budget/业务写。
- headerDiff 总上限 300→600 为有意扩展，headerDiff 仍 join≤300；未发现正文/路径泄露。
- round-13 host 未入 H7（下一轮）；F13-R4 info。
