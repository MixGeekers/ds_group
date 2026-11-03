# round-7 证据独立复核（task-40，完成）

- 复核对象：X=`183b649`、X+1=`cf87322`、host=`cc2e8d1`；H3 runner `9f841bd`、H7-round7 `bc36dbc`、集成 `183b649`。
- 只读复核 commit blob/evidence/`.local` 日志/只读 DB/构建；未改他人文件、未 git 提交。
- 结论：**round-7 证据真实、披露诚实；宿主尝试明确为失败、未重试、无真实业务完成声明；未发现掩盖失败或将诊断当 pass。** 主要问题是 H3 离线 create-failure 测试假设“空副作用”而真实宿主持久了部分 Goal（host 证据已更正披露）。

## 0. H3 有界 runner 9f841bd — 通过（含 F7-R1 缺口）

- files 2/2、patch `095c3a45…`/9642 匹配；隔离 **1531/1531、0 skip**（`6eed16af…`/164825）；16 tests；frozenInput/template sha 匹配。
- 覆盖 completed/failed/unknown/timeout/abort/单飞/固定输入/create 失败/预算 overrun/证据不完整；receipt validator mutation self-proof 真实；无恒真。
- **F7-R1**：create 失败路径 catch 后 goal=null → `businessSideEffects.goal.created=false`；离线测试断言空副作用；真实宿主 create 失败却持久了 unauthorized/paused Goal row + 1 Session。host 证据正确披露/更正，但 runner 未 post-failure readback，离线测试也未覆盖“部分创建”场景。

## 1. H7-round7 bc36dbc — 通过

- files 6/6；**47 sources/142 files**；新增 4 sources/16 files（round6-host、h4e probe、round6 integration、round6 clean artifacts）逐文件 blob/ancestry。
- round6-host levels 仅 fixed-host-zero-model；产品行 **79/79 not_covered**、covered=0；tooling_ready 仅 TV.1–7/9；无升级；blobCommit 稳定；issues=0；gate incomplete。
- H7 日志 1522 full / 99 harness；X+1 clean 99。

## 2. 集成 183b649 — 通过

- runtime/index/tool 与 slice files 全匹配；隔离 **1539/1539、0 skip**（`61ab6577…`/165402）。

## 3. 宿主 cc2e8d1 — 失败证据，披露诚实

| 项 | 结果 |
|---|---|
| receipt | status=failed、`CORE_VALIDATION_CREATE_FAILED`、`GOAL_OPERATION_UNKNOWN`；evaluateAttempts=0、stopAction=none、0 model requests、未重试 |
| 审计链 | before 396/52/33/cap39/goals2 → reload 402/53/33/41/goals2 → run 405/53/34/41/goals3；events/state 不变；Task/Effect/budget/artifact 不变；known 33 Session 不变 |
| 持久副作用 | 1 个 unauthorized/paused Goal row（`core-17e3fe95…`、request `core-validation-frozen-v1`、v1、evaluations 0、无 mandate/native）+ 1 个 core Goal Session；DB 只读查询与 frozen-goal-state 完全一致 |
| 矛盾披露 | receipt `businessSideEffects.goal.created=false` 与审计矛盾，evidence findings 明确更正；无业务/模型通过声明 |
| 残留 | inert Goal/Session 留待 round-8 reconcile，不重试；真实业务链未验证 |

## 4. X+1 cf87322 — 通过

| 项 | 结果 |
|---|---|
| 差异 | 11 artifacts（全 M，parent=X）；`183b649..cf87322` 及至 HEAD 的 src/client/tests/scripts diff=0 |
| manifest | `{head:183b649…,dirty:false,dirtyEntries:0}`、generatedAt=02:53:29.518Z、leaks=0、aggregates 404/7,096,993/`10a0f0e3…` |
| clean | 1539/1539、0 skip（`775ef3c2…`/165330）；pipeline `938409ee…`/2874；archive `a24e7fbe…`/867 |
| selfproof/来源 | 13 files/99；47/47 sources/142 files、0 unknown；oracleCorpus 15/7/22 |
| 产品/acceptance | 79/79 not_covered、covered=0、tooling_ready TV.1–7/9；gate=incomplete/completeNineSystems=false，planned92/executed0/passed0/failed0/blocked19/notRun73；issues=0 |

## 5. findings

- **F7-R1**（moderate-product-test-gap）：H3 runner's create-failure path/test assumes empty side effects; real host failure persisted partial Goal
- **F7-R2**（minor-disclosure）：Host attempt evaluations=2 lacks explicit 'historical' label
- **F7-R3**（info-residual）：Residual unauthorized/paused core Goal and Goal Session intentionally left for round-8 reconcile
- **F7-R4**（info-scope）：Round-7 failed host evidence not mapped in H7-round7
- **F7-R5**（info-hygiene）：acceptance inputs contain clean generation temp root

## 6. 边界/未观察

- Successful real bounded core Goal run：host attempt failed at create; no plan/Task/worker/verification/native completion; not retried
- Partial-create detection in H3 offline suite：fake driver throws before persisting; host real partial Goal not reproduced offline (F7-R1)
- Exact provider usage/cost on failed attempt：no model request admitted; usage unknown
- Round-7 host mapping in H7：not mapped until round-8 (intentional)
- Independent suite re-execution：read-only; logs/hashes/counts/Lead checks used; no product/host/model rerun
- acceptance inputs 含 `/private/tmp/h7r7-clean` 临时路径（F7-R5 info，无 home/产品数据）。
