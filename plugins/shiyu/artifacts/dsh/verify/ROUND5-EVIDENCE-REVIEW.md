# round-5 证据独立复核（task-34，完成）

- 复核对象：X=`444f377`（harness-only blobCommit hotfix）、X+1=`693fab1`（clean artifacts）、host=`511fe65`（HEAD）；提交 `fix host working-directory context`(c018036)、`H2b live time-trigger probe`(a7b3f3e)、`H7-round5 mapping`(4d126dd)、`round5 integration`(6ecb487)、`failure diagnostics`(7f57ea1)、`assembly rebuild`(7704e5d)、`structural binding`(3bec321)、`title suppression`(3e2bbf9)、`tool-history non-authoritative (X)`(6ae4582)、`511fe653e9417d447d0bd6a56712dbd59c7b7ef9`(host-round5)、`444f3777f674287dc1640c714b4764b84fe7371f`(harness-hotfix (X))、`693fab1de4cb5b2829852d3003a14a253088325f`(H7 X+1)。
- 只读复核 commit blob/evidence/`.local` 日志/只读 DB；未改他人文件、未 git 提交。
- 结论：**round-5 证据真实、内部一致；真实模型单轮在“受限诊断探针”范围内通过，live 时间触发通过；X/X+1 满足约定；未发现伪造/静默跳过/未跑写通过。**

## 0. H2c 修复链（全部匹配；边界未放宽）

| 修复 | 计数 | 证据 |
|---|---|---|
| c018036 首步 cwd 上下文 | 1477 | files 2/2、log `fff150c7…` |
| 7f57ea1 失败诊断 | 1492 | files 3/3、log `46f44b97…` |
| 7704e5d assembly | 1493 | declared `a0efc4b2…`（R1 已披露覆盖） |
| 3bec321 结构绑定 | 1494 | declared `3ec73e72…` |
| 3e2bbf9 title 抑制 | 1495 | declared `c5fabd0a…` |
| 6ae4582 tool-history | 1496 | final `408dc519…`/161521 |
| H2b live trigger | 1481 | `80ba53d5…`/160255 |
| H7-round5 | 1479 / harness 83 | files/archive 匹配 |
| round5 集成 | 1492 | `c6d8772b…`/161135 |

**边界**：MAX_MAIN_REQUESTS=2/MAX_TOOL_CALLS=1 不变；精确 core 工具集；只允许 `shiyu_core_event_types`；256 tokens/unknown usage/0 retry/no business writes 保持。fix 仅增加 host context/title/tool-history 处理；fake-host 回归测试真实；无 skip/only/恒真。

## 1. 宿主 511fe65（真实模型通过 + live 时间触发）

- **真实模型通过**：pass receipt；2 requests/2 streams、1 tool/1 result；usage reported 1469/41/2406（total≠in+out，按 reported 不重算）；typesSeen=4 与 toolResult 一致；titleRequestsSuppressed=2；released/disposed/archived/cleanup；无 Goal/Task/Effect/budget/业务写入。
- **live 时间触发通过**：8/8 checks；**live DB 只读实测恰 1 个 `time.occurred`（seq46，scope `shiyu-time-probe`，eventId `0c159245…` 与 receipt 一致）**；规则/timeState 清理；append-only 副作用已披露。
- **审计链**：353/44/27/cap25 → 359/45/27/27 → 390/51/33/37 → final 390/51/33/37；known 27 Session 逐字节不变；6 个新增 probe Session 与 attempt/pass sessionId 对应；业务事实/state 不变；final status 只读；dist `bdc6e3a2…`/111 独立重建；definitionDigest `5a591515…` 不变。
- **6 次失败**：af201fe + 5 个 round5 pre-pass；DSH §37.2 明确 attempt4/5 为 1 request/0 stream/usage unknown/费用未知，不概括为零请求；最终 pass 后未重试。

## 2. X=444f377（harness-only hotfix）— 通过

- 仅 7 文件：DSH、h7-round5-slice、h7-blobcommit-hotfix-verify、harness 测试与 `tests/harness/evidence.ts`；**产品 src/client/scripts 与 host 证据未变**。
- `blobCommit` 通过 `git show <blobCommit>:<path>` 读取 committed snapshot + `expectedSha256` fail-closed + commit 祖先校验；测试覆盖 pipeline 重写后仍验证与 invalid fail-closed；真实 pipeline 中 manifest 被 selfproof 前重写后仍 **38/38 sources verified（103 文件、0 unknown）**。
- X hotfix 隔离 1498/1498、0 skip（`e6bcf50a…`/161620）。

## 3. X+1=693fab1 — 通过

| 项 | 结果 |
|---|---|
| 差异 | 11 artifacts（全 M，parent=X）；`444f377..693fab1` src/client/tests/scripts diff=0 |
| manifest | `{head:444f377…,branch:HEAD,dirty:false,dirtyEntries:0}`、generatedAt=01:23:48.254Z、leaks=0、aggregates 398/6,905,958/`b689c7a5…`、无 artifacts/dsh 路径 |
| 11 件产物 | SHA/bytes 记录：manifest `2474996a…`/83141、selfproof `b362022d…`/19764、tap `ca8f25bd…`/16768、traceability `ca9307df…`/818405、md `151fb41a…`/32376、mapping `651ab4d3…`/46638、acceptance json `beb367d8…`/245696、md `94819ee3…`/27417、fl manifest `f1f39199…`/13154、coverage `0b907322…`/52559、coverage md `a336169c…`/9308 |
| clean-X | 1498/1498/0 skip（`d7fe20bc…`/161680）；pipeline `c44068f9…`/2726（honesty=pass、gate=incomplete、executed=passed=0、buildIssues=0）；archive `a87887c7…`/888 |
| selfproof/来源 | 11 files/85 pass；oracleCorpus 15/7/22；38/38 sources verified（103 files、0 unknown） |
| 产品/acceptance | 79/79 not_covered、covered=0、tooling_ready TV.1–7/9；gate=incomplete/completeNineSystems=false，planned92/executed0/passed0/failed0/blocked19/notRun73；modules 33 limited+5 blocked+2 not_covered；S/FL16 synthetic；issues=0 |

## 4. findings 最终处置

- **F5-R1**（minor-evidence-durability）：fixed-or-disclosed-in-511fe65 — Intermediate fix logs 1493/1494/1495 overwritten at one path
- **F5-R2**（minor-metadata）：fixed-or-disclosed-in-511fe65 — Host passed receipt bytes is a character count
- **F5-R3**（minor-wording）：fixed-or-disclosed-in-511fe65 — Failure count wording: timeline has six failures but limitation says five pre-pass
- **F5-R4**（minor-precision）：fixed-or-disclosed-in-511fe65 — '0 streams' vs '0 provider requests' for attempts 4/5
- **F5-R5**（minor-audit-granularity）：fixed-or-disclosed-in-511fe65 — Six reloads but only four audit snapshots; intermediate build dists unattributed
- **F5-R6**（info）：info-accepted — Final status only caches core-model receipt
- **F5-R7**（pending）：resolved-by-444f377-and-693fab1 — X+1 and host commit pending
- **F5-R8**（info-hygiene）：info-accepted — acceptance inputs contain the clean generation temp root
- **F5-R9**（info-scope）：info-accepted — Round-5 host evidence is not yet in H7 mapping

## 5. 边界/未观察

- X+1 and host commit：not yet committed; host evidence reviewed as untracked draft
- Per-reload intermediate host audits/build dists：only four snapshots for six reloads; classification arithmetic only
- Attempts 4/5 provider request fate/cost：mainModelRequests=1/streams=0/usage unknown; cannot prove provider receipt/billing
- Attempt2 archived Session events：zstd archive not decoded; receipt/counters/status used
- Independent full-suite re-execution：read-only; hotfix? no hotfix; fix logs/counts+Lead slice checks verified; final real model was actually executed
- **真实模型工具往返仅在受限诊断探针范围内通过**，不是完整 core 决策/计划质量/Goal/Task/缓存/费用/业务/九系统验收；attempt4/5 已发起 1 次 request 但 0 stream/无 usage，费用未知。
- round-5 host 证据（511fe65）按计划未进入 H7 映射（round-6 工作），本轮 clean 不升级、不产生 unknown。
- acceptance inputs 含 `/private/tmp/h7r5-clean` 临时生成路径（无 home/产品数据；F5-R8 info）。
