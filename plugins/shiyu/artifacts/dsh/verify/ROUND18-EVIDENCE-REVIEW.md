# round-18 证据独立复核（task-75，完成）

- 最终身份：X=`fc4b947`、X+1=`8a06066`、host=`3673395`；code `c47502d`、fix `ff5ea11`。
- 只读复核 commit blob/evidence/`.local` 日志/只读 DB/7 audits；未改他人文件、未 git 提交。
- 结论：**P0 chat-memory 失败披露诚实、recall 未执行；startup embedding 验证独立通过；workspace TaskRunner 代码已接线；H7 未升级；X+1 符合约定。** F18-R1 为 host effects/budget 未披露（moderate audit completeness）；F18-R2 为 workspace 旧措辞；R3 info。

## 0. P0 chat-memory — 未通过（披露诚实）

| 项 | 结果 |
|---|---|
| write#1 | `INVALID_INDEX_OBSERVATION`，**0 generation model calls**；index 成功但已发布 manifest 仍 exact_read；修复 `ff5ea11`（onIndexed publish） |
| write#2 | 到达 ReadView（**2 个受控 memorySources**）、创建 draft；但 **无 current verified draft**：reply status=unknown、reason=`REPLY_FAILED`、usage null、replyer Session cancelled |
| recall | 按冻结计划 **0 重试、recall 未执行**；重启召回/marker/同 Session 全未验证 |
| 残留 | 2 条合成 chat-probe facts active：`cccbba76…`、`d855739f…`；明确披露；无 Task/Goal 变更 |
| 结论 | **P0 聊天记忆闭环未通过，不得宣称真实多轮聊天记忆通过** |

## 1. 启动自动 embedding 验证 — 独立成功

- 第二次 reload 后 `attempted=true/verified=true/embeddingCalls=1/semanticPublished=true`（capture 21:46:03）；manifest capabilities `exact_read+semantic_search` + profileFingerprint；status-extract 3055B/sha `dad4725d…` 匹配。
- 这是 reload readiness 独立成功项，**不是 chat recall 证明**。

## 2. host audit — 发现未披露 effects/budget

- **F18-R1（moderate disclosure）**：7 audits 显示 `effects` 19→21（write1）→23（write2），budget settled 27→29→31（+4 each）；`stateFile` 在 write2 9a1d→b487；goals8/tasks states/sessions40 不变。joint delta/key summary 未列 effects/budget，Lead key fact 写“无 Task/Goal/Effect/外部发送”不准确；需披露 memory-probe effects/budget 与 state 变化，或明确 Effect 口径。

## 3. workspace TaskRunner 集成 — 代码通过，措辞需修

- `c47502d` 修改 runtime.ts/task-runner.ts/index.ts/task-workspace.ts；`runtime-task-workspace.diff` sha `cdc9e268…` 匹配、patch applies；可信 sharedRoot、claim 前 prepare、worker cwd task/、publish/owner delete、expectedChanges/ownerDecision、失败 mirror+markUnknown、无 sharedRoot no-op；10/10 cases、isolated 1776/1776；liveHost=false（未真实宿主执行）。
- **F18-R2（minor wording）**：workspace-runtime-integration `boundaries.runtimeTsEdited=false`，H7-round18 旧 workspace source 仍 `runtimeWired=false`；旧 adapter cce6deb 切片属实，但当前 TaskRunner 集成已接线，未映射；措辞需 scope 到旧切片，下一轮映射新集成。

## 4. H7 / X+1 — 通过

- H7 100 sources/420 files；product 79/79 not_covered；gate incomplete；full1775/harness193；archived3；round17 workspace source old runtimeWired=false；round18 新 P0 chat/startup/TaskRunner 尚未映射（下一轮）；无 product/V25/业务/九系统升级。
- X+1 `8a06066`：**12 M artifacts**（11 clean + R18-CORR slice JSON）；code diff0；manifest head=fc4b947/dirty=false/leaks0、aggregates 426/7,941,693/`d2ba0e33…`；clean **1807/1807**（`526913b5…`/189727）；pipeline `8716f780…`/3722；archive `49360c29…`/839；selfproof 23/193；**100/100 sources/420 files、0 unknown**；产品 79/79；gate=incomplete/executed=passed=0；12 artifact SHA/bytes 已记录。

## 5. findings/边界

- **F18-R1**（moderate-disclosure）：Host audits show +4 effects/+4 settled budget, but joint delta/key facts omit them and say no Effect
- **F18-R2**（minor-wording）：Workspace evidence/H7 says runtimeWired=false/runtimeTsEdited=false although round18 code wires Runtime/TaskRunner
- **F18-R3**（info-boundary）：Startup embedding verification success is independent of chat recall; P0 chat closure NOT passed

- P0 chat-memory 未通过；startup embedding success 非 recall proof；recall/restart/marker/same-Session 未验证；2 active synthetic facts 残留。
- workspace 代码集成已有，但 live host 未执行；H7 未升级；产品 79/79 not_covered；无真实聊天记忆/业务/九系统通过。
