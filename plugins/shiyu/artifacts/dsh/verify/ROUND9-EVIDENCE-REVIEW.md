# round-9 证据独立复核（task-46，完成）

- 复核对象：X=`69ed588`（create 修复 `1ae4bb8` + H7-round9 `b01843e` + 集成 `69ed588`）、X+1=`04dc817`；**round-9 无 host commit**（无 runtime 改动/reload，v2 未激活）。
- 只读复核 commit blob/evidence/`.local` 日志/只读 DB/Goal Session；未改他人文件、未 git 提交。
- 结论：**round-9 证据真实、边界诚实；根因强支持但未 host-confirmed；v2 冻结未激活；H7 未升级；X+1 满足约定。**

## 0. H3 create 根因修复 1ae4bb8 — 通过

- files 4/4、日志匹配；product-only **1467/1467**（`68b1c060…`）；full isolated 1574/1548/26 expected harness hash-binding（`c085258f…`，clean 后清零）；red 31/39（8 fail）→ green 39/39。
- **live 根因**：只读 DB 核到 command `core-create:core-17e3fe95…` status=unknown、reason “Native history changed outside the trusted recovery suffix”；失败 Goal Session 解码 exactly `session`+`permission/preset`+`sandbox/mode`+`approval/policy` 4 条；证据明确 **not host-confirmed**；title/preset 假设被否定。
- **fix 语义**：仅 `NATIVE_HISTORY_CHANGED` 有界重观察 3 次、signal/deadline；持续篡改有界失败；**native create 恰一次、不 replay**；failure phase 枚举/≤300/path `<workspace>`/无正文；receipt schema 不变；fallback/validator 测试真实。
- **v2 冻结**：requestId `core-validation-frozen-v2`、template `756ec37b…`、content `1e45f585…`、budget 16384/3/1、max2；Object.freeze；仅精确常量引用；克隆/version-only/override 拒绝；v1 reconcile 不变；**runtime/index/tool 无 ref，未激活**。

## 1. H7-round9 b01843e — 通过

- files 10/10；**57 sources/179 files**；5 新 sources/19 files；round8 host reconcile levels 精确 `fixed-host-zero-model-reconcile`；V25 不接收；review `independent-review-info` 且 mappings 不引用；round8 clean@f766ab7（非 c89d940）。
- 产品 79/79 not_covered、covered=0；tooling_ready 仅 TV.1–7/9；gate incomplete；full 1569、harness 115；archives 4/4；issues 0。

## 2. 集成 69ed588 — 通过

- files 匹配；组合隔离 **1582/1582、0 skip**（`f1bf764d…`/169117；1561+13+8）；无 runtime/index 激活 v2。

## 3. X+1 04dc817 — 通过

| 项 | 结果 |
|---|---|
| 差异 | 11 artifacts（全 M，parent=X）；`69ed588..04dc817` 及至 HEAD 的 src/client/tests/scripts diff=0 |
| manifest | `{head:69ed588…,dirty:false,dirtyEntries:0}`、generatedAt=05:05:38.152Z、leaks=0、aggregates 404/7,201,020/`3e25c919…` |
| clean | **1582/1582、0 skip**（`38998588…`/169046）；pipeline `41e4bc29…`/3021；archive `7842e144…`/867 |
| selfproof/来源 | 15 files/115；57/57 sources/179 files、0 unknown；oracle 15/7/22 |
| 产品/acceptance | 79/79 not_covered、covered=0、tooling_ready TV.1–7/9；gate=incomplete/completeNineSystems=false，planned92/executed0/passed0/failed0/blocked19/notRun73；issues=0 |
| 差异闭环 | H3 pre-clean 26 expected harness hash-binding failures 已被 clean 1582 清零 |

## 4. findings/边界

- **F9-R1**（info-expected）：Full isolated check has 26 expected harness hash-binding failures until clean refresh — resolved-by-clean-X+1
- **F9-R2**（info-unconfirmed）：Live root cause strongly supported but not host-confirmed — info-accepted
- **F9-R3**（info-frozen）：v2 is frozen but not activated; no host/Goal/model execution — info-accepted
- **F9-R4**（pending）：X+1 pending — resolved-by-04dc817

- 无 host commit 是预期：本轮无 runtime/index 改动/无 reload；v2 未激活，无真实 Goal/模型调用；根因未 host-confirmed。
- title/preset 假设已否定；fix 只对 NATIVE_HISTORY_CHANGED 有界重观察；native create 不 replay。
- 真实 host 确认需未来显式 owner 决定 + 新冻结 v2 激活；acceptance inputs 临时路径为 info（无 home/产品数据）。
