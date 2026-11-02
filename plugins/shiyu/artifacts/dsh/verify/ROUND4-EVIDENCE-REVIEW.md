# round-4 证据独立复核（task-30，完成）

- 复核对象：X=`af201fe`（LocalCoreService 热修复）、X+1=`dfe4372`（clean artifacts）、host=`bd81270`（HEAD）；本批提交 `8cc6762`(H2b-probe)、`d2da9c7`(H2c-probe)、`dab6d5b`(H5b-probe)、`e273aa7`(H7-round4)、`1f74180`(integration)、`af201fecea06c13dbfbc23e5f4e66d2aa29350b1`(LocalCoreService-hotfix (X))、`dfe437224ffaaa12299f946a724084ad11e00869`(H7 X+1)、`bd81270e0f21c765eb26e2a8d947754af0045c14`(host-round4)。
- 只读复核 commit blob/evidence/`.local` 日志；未改他人文件、未 git 提交。
- 结论：**round-4 证据真实、内部一致，未发现伪造/静默跳过/未跑写通过。** 热修复代码/测试与宿主效果通过；唯一有界真实模型尝试为**诚实失败**（0 模型请求），不计为通过；X+1 与 host 证据满足约定。

## 0. 热修复（LocalCoreService 委托）— 通过

| 项 | 结果 |
|---|---|
| 代码/测试 | af201fe 仅改 local-core.ts + local-core.test.ts：薄委托 + 缺失方法 `NATIVE_MISMATCH`；无策略变化 |
| 独立复核 | /tmp 独立跑 `tests/local-core.test.ts` **32/32 pass、0 skip**（含 delegation + NATIVE_MISMATCH） |
| 计数修正 | F4-R1 已修：clean-X（af201fe）**1473/1473、0 skip**（= 集成基线 1472 + 1 委托回归），日志 `e64f43d4…`/159480；不再声称 1435 |
| 宿主效果 | attempt1（1f74180）`CORE_MODEL_TOOL_PROBE_UNAVAILABLE` 0 模型；attempt2（af201fe）`PROTOCOL_VIOLATION` counters 全 0/usage unknown/archived/released/cleanup/不重试/无业务写入 |

## 1. 探针/切片证据（全部匹配）

| 项 | 证据 | 结论 |
|---|---|---|
| H2b probe | 9 tests；1444（`d4c8f6b8…`/156756）；15 checks 全 true | verified |
| H2c probe | 9 tests；1444（`45f6c66a…`/156860）；MAX 2/1 未变、复用 validateCoreEventToolMount、正例 2 requests/2 streams/1 tool、负例齐全 | verified |
| H5b probe | 10 tests、7/7 matrix；1445×2（`83b76b2c…`/`adba9183…`）；filesWritten=0/resolverInvoked=false/captureAttempted=false/ready=false、active=3 | verified |
| H7-round4 | 6 tests；1441（`8b30dca3…`/156244）、harness 77；30 sources/72 files；产品行 79/79 not_covered、gate incomplete | verified |
| 集成 | 1472（`8e668c19…`/159340）；files 4/4；targeted 76/76 无独立日志（F4-R7 info） | verified |

## 2. 宿主 round-4（bd81270）— F4-R1…R6 已修并复核

| 项 | 结果 |
|---|---|
| 链 | 失败构建 341→347（events42→43、sessions22→22、cap21→23、dist `ebf257e6…`，`deltas.failedBuildWindow` 已引用两条 audit 并分类）→ 修复构建 347→353（events43→44、cap23→25）→ probes 353→353（sessions24→25→27） |
| 探针 Session | 失败构建 2 个（worker 44868a86/core 23ecb68c）+ 修复构建 3 个（worker b0e70f9d/core 730e7816/core-model c6126eb1）= 5 个；22 个已知 Session 逐字节不变（`probeSessions` 明示） |
| 探针/缓存 | time 15/15；checkpoint flags；worker/core mounts；final status 缓存 4 receipts；timeSource idle schedules=0；notifications disabled |
| 真实模型尝试 | attempt1 UNAVAILABLE（0 模型）；attempt2 counters 全 0、usage unknown、released/disposed/archived/cleanup、不重试、无业务写入；诚实失败，未计为通过 |
| payloadBytes | 已改实际字节+semantics（55906/2549/2688/3976/3836/826/69781，sha 均对） |
| Task 元数据 | v31→v32→v33 按窗口披露（state unknown、无 retry/success） |
| 卫生 | 无绝对 home/秘密/正文；encoded relativePath/sanitized audits 惯例已注明；host 提交 16 文件（doc+artifacts）无 code/tests/scripts |
| 构建 | 1f74180→`ebf257e6…`/111、af201fe→`04d4a435…`/111 独立重建；definitionDigest `5a591515…` 不变 |

## 3. X+1（dfe4372）— 全部通过

| 项 | 结果 |
|---|---|
| 差异 | 11 artifacts（全 M，parent=X）；af201fe..HEAD 的 src/client/tests/scripts diff=0 |
| manifest | `{head:af201fe…,branch:HEAD,dirty:false,dirtyEntries:0}`、generatedAt=23:34:44.419Z、leaks=0、无 artifacts/dsh 路径、aggregates 398/6,832,569/`05120da9…` |
| 11 件产物 | 全部 SHA/bytes 已记录：manifest `c32b7734…`/83139、selfproof `408f93b4…`/18434、tap `a15408cf…`/15352、traceability `d208ceb0…`/654174、md `7411ce41…`/31939、mapping `0c150b86…`/37382、acceptance json `c244f683…`/203512、md `1818e928…`/27044、fl manifest `6cc67b45…`/13154、coverage `9d392a35…`/52559、coverage md `c874b010…`/9308 |
| clean-X | 1473/1473/0 skip（`e64f43d4…`/159480）；pipeline `5863a134…`/2653（honesty=pass、gate=incomplete、executed=passed=0、buildIssues=0）；archive `4ec3e4e7…`/873 frozenHead=af201fe+lifetimeNote |
| selfproof/来源 | 10 files/77 pass；oracleCorpus 15/7/22；30/30 sources verified（72 files、0 unknown） |
| 产品/acceptance | 79/79 not_covered、covered=0、tooling_ready TV.1–7/9；acceptance gate=incomplete/completeNineSystems=false，planned92/executed0/passed0/failed0/blocked19/notRun73；modules 33 limited+5 blocked+2 not_covered；systems 9 limited；V 12 limited+14 blocked+1 not_covered；S/FL16 synthetic；issues=0 |

## 4. findings 最终处置

| ID | 状态 |
|---|---|
| F4-R1 | fixed-in-bd81270：Hotfix isolation count 1435/1435 has no evidence/log and is arithmetically inconsistent |
| F4-R2 | fixed-in-bd81270：Round-4 host payloadBytes are character counts, not file bytes |
| F4-R3 | fixed-in-bd81270：First failed build's raw audits unreferenced and its window unclassified |
| F4-R4 | fixed-in-bd81270：Host evidence says exactly three new probe Sessions but five exist since round-4 start |
| F4-R5 | fixed-in-bd81270：Unknown Task metadata versions v31→v32→v33 not disclosed per window |
| F4-R6 | fixed-in-bd81270：Round-4 host evidence keeps encoded home paths in session names |
| F4-R7 | info-accepted：Integration targeted 76/76 has no retained log |
| F4-R8 | info-unobserved-accepted：Attempt2 archived Session event sequence is not independently observable |
| F4-R9 | resolved-by-dfe4372-and-bd81270：Round-4 host commit and H7 X+1 pending |
| F4-R10 | info-accepted：acceptance-report inputs contain the clean generation temp root |

## 5. 未观察/边界

- 仅 hotfix local-core 测试在 /tmp 独立重跑；其余以保留日志/哈希/计数+Lead slice/clean checks 为证。
- **真实模型工具往返仍是诚实失败**：attempt2 0 main requests/streams/tool calls、usage unknown、未重试；不得记为通过；真实模型成本/缓存未取得。
- 宿主零模型 limited；live time rules/checkpoint capture/真实 Session/Ombre 导出/DOM/渠道未测；acceptance inputs 含 `/private/tmp/h7r4-clean` 临时路径（F4-R10 info，无 home/产品数据）。
- clean count 1473 不与 H0c 历史 1216/1264 混算。
