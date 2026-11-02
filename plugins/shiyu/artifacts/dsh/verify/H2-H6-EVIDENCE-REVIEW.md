# H2a-probe / H3 / H4c / H6a / H0c 与联合固定宿主证据独立复核（task-18）

- 复核对象：HEAD `a68eeb2e61bdd9d7836dfe9f55c08cf0ca3e2581`；提交 `6f600f4`(H2a-probe)、`3b25e1b`(H2a-probe-evidence-refresh)、`d7dd731`(H3)、`c00c6a9`(H4c)、`8b34d66`(H6a)、`7bd962c`(H0c)、`a68eeb2`(joint-host)
- 复核方式：**只读**审阅提交内文件、产品/测试源码、`artifacts/dsh/**`、`.local` 日志；未运行真实宿主/模型/embedding，未改他人文件，未 git 提交。
- 额外独立复算：`git archive 3b25e1b` + tsc 重建 dist 并复算 host-audit digest；在 `00fb75b` 与 `3b25e1b` 重建并导入 `capability-identity` 复现 `definitionDigest` 变化；临时树已删除。
- 结构化逐项结果：`artifacts/dsh/verify/h2h6-evidence-review.json`（32 项检查、G1–G11 findings、未观察项、证据层级表）。

## 0. 总体结论

**证据真实性：通过（无伪造/静默跳过/未跑写通过发现）。** 共 32 项检查：verified/verified-with-finding 共 25，未观察 1，新 findings 11 条（G1–G11，均为证据引用/披露/算术/卫生类 minor）。

关键判定：
- 五个切片的隔离 check 计数与日志 hash 全部匹配：H2a-probe 1299、H3 1288、H4c 1271、H6a 1336、H0c 1264，均 0 fail/0 skip；声明文件 7/7、7/7、2/2、11/11、58/58 与对应 commit blob 一致（H3 证据引用例外见 G1）。
- 测试真实性抽查通过：无 `.skip/.only/assert.ok(true)`；H3 计划 CAS/拒绝码/停止条件/unknown round、H4c 确定性/受众裁剪/撤回省略、H6a 去重/修订/墓碑/受众、H2a-probe 零模型 counters/authorityFields/释放、H0c 自证与合成 fixtures 均有真实负例断言。
- 联合宿主审计链自洽：commitSeq 308→315→315、events 38→39→39、deliveries 37→38→38、stateVersion 6/6/6、capability 12→14、Session 17→17→18（仅新增 probe Session，17 个已知文件不变）；工具调用未写控制账本；dist `ce295911…`(101 文件) 与 definitionDigest `1f9c5911…`→`5a591515…` 均**独立复现**。
- 证据层级诚实：五个切片均为 G1 离线（H2a-probe/H3/H4c/H6a 模块+真实临时 SQLite/Worker；H0c 仅工具自证+合成 fixtures、不可用于业务验收）；联合宿主仅固定 DSH 零模型 limited，未声称真实模型/DOM/N 轮/长跑。
- traceability 未被误升级：产品行 79/79 `not_covered`、`covered=0`、`tooling_ready` 仅 8 条工具行，handoff 规则未改；H0c 刷新后仍如实。

## 1. 逐项检查矩阵

| ID | 域 | 声明/检查 | 结果 |
|---|---|---|---|
| R01 | file identity | All evidence-declared slice/summary files match the commit they claim (H2a-probe 7+7, H3 7+7, H4c 2+2, H6a 11+11, H0c 58 | **verified** |
| R02 | isolated counts | Slice-verify counts/log hashes match: H2a-probe 1299, H3 1288, H4c 1271, H6a 1336, H0c 1264, all 0 fail/0 skip | **verified** |
| R03 | H2a-probe arithmetic | 1288 baseline + 11 new (9 probe + 2 tool) = 1299; finalCheck matches evidence artifact; stale 1297 record is superseded | **verified-with-finding** |
| R04 | H3 arithmetic/style | 1264+17=1281 implementer; 1271+17=1288 Lead; tests real (CAS/stale/stop/unknown) | **verified-with-finding** |
| R05 | H4c arithmetic | baseline 1264, final 1271 (1264+7); instructed head 1213; a80c33d 1256; lead 1271 | **verified-with-finding** |
| R06 | H6a arithmetic/style | 1288+37=1325 implementer; 1299+37=1336 Lead; 37 new tests across identity 9/ingress 12/audience 8/conversation 4/worker  | **verified-with-reference-finding** |
| R07 | H0c arithmetic/scope | baseline 1249 at a80c33d, lead 1264 (1249+15); implementer 1216 at feecf86 superseded; /tmp logs currently match claims | **verified-with-finding** |
| R08 | test truth (global) | No .skip/.only/assert.ok(true) in new round-2 test files; negative cases assert real rejection codes | **verified** |
| R09 | H3 feature claims | Plan CAS/idempotency, stop conditions and unknown-round no-retry are real tests | **verified** |
| R10 | H4c feature claims | Prompt determinism, audience trimming and withdrawal omission are real tests | **verified** |
| R11 | H6a feature claims | Dedup/revision/tombstone/audience are real tests | **verified** |
| R12 | H2a-probe review surface | Zero-model counters/authorityFields/release and host receipt are real | **verified** |
| R13 | H0c self-proof | Committed self-proof corpus supports H0c claims: 57/57 tests (42+15), 7 H0c oracles, 43 known verdicts (12 accept/31 rej | **verified** |
| R14 | H0c boundary | H0c evidence is tooling-only; scenarios synthetic-fixture-only-not-run; no product/host/model acceptance | **verified** |
| R15 | traceability/handoff | Product rows not upgraded by H0c/H6a/H3/H4c/H2a-probe; tooling_ready not passed off as product | **verified** |
| R16 | H0c refreshed artifacts | H0c refreshed harness artifact hashes match committed HEAD | **verified** |
| R17 | host audit chain | commitSeq 308→315→315, events 38→39→39, deliveries 37→38→38, stateVersion 6/6/6, capability 12→14/14 match raw audits an | **verified** |
| R18 | host sessions/probe | Sessions 17→17→18; known 17 files unchanged; added file is the probe Session matching diagnosis probeSessionId | **verified** |
| R19 | host business facts/read-only | Tasks states/counts, goals, lab, budget, effects, state-file hash unchanged; both tool calls do not write the control le | **verified** |
| R20 | capability definitionDigest | definitionDigest 1f9c5911→5a591515 is explained by the fixed implementation identity covering changed worker execution s | **verified** |
| R21 | host dist provenance | dist ce295911…/101 files was built from the claimed committed HEAD | **verified** |
| R22 | host status payload | status tool payload sha matches and payloadBytes is the file size | **finding** |
| R23 | host diagnosis payload | diagnosis payload receipt/tools/authority/counters/release match audit side effects | **verified** |
| R24 | host committed vs captured audits | Committed raw audits are the captured originals | **finding** |
| R25 | host hygiene | New host evidence has no secrets/absolute home paths/message bodies | **verified-with-finding** |
| R26 | host task metadata | No business fact changed except the expected lifecycle writes | **finding** |
| R27 | host eventToolProbe cache | diagnostics.eventToolProbe cache works at host level | **unobserved** |
| R28 | stale refs/log collisions | Implementer run records point to retained immutable logs | **finding** |
| R29 | traceability oracle scope | H0c refresh kept traceability truthful | **note** |
| R30 | commit scope | Reviewed commits stay within their slice scopes | **verified** |
| R31 | review boundary | Review is bound to committed HEAD a68eeb2 | **note** |
| R32 | overall authenticity | No fabricated/overclaimed evidence in the reviewed commits | **verified** |

## 2. 计数与日志核对

| 切片 | 基线 | 形成计数 | Lead slice | 日志 SHA256/bytes |
|---|---|---|---|---|
| H2a-probe | 1288 | impl n/a; final 1299 | 1299/1299 | `a5a3b4c5…` / 141826 |
| H3 | 1271 | 1281（1264+17） | 1288/1288 | `3fdbc26e…` / 140606 |
| H4c | 1264 | 1271（c6a3f05+7） | 1271/1271 | `e6f2e3de…` / 138618 |
| H6a | 1299 | 1325（1288+37） | 1336/1336 | `2c2e6135…` / 145767 |
| H0c | 1249 | 1216（feecf86+15，已被取代） | 1264/1264 | `b506c898…` / 137820 |

H6a 详细证据另有 committed `artifacts/dsh/h6/h6a-isolated-check.log`（`74c2859f…`/144652，1325 次）与 6 份 focused/regression 日志，8/8 hash+counts 匹配。

## 3. 联合固定宿主（a68eeb2）

| 观察项 | 结果 |
|---|---|
| 审计链 | before→after：commitSeq 308→315、events 38→39、deliveries 37→38、stateVersion 6→6、capability 12→14、hostEpoch b10a41c5→18322852；after→after-tools 仅 Session 17→18 |
| Sessions | 17 个已知文件 before/after/tools 完全不变；新增文件恰为 `shiyu-worker-probe-940b80a0…`，与 diagnosis `probeSessionId` 一致；reload 时 digest 不变，工具后 digest 因新增文件变化 |
| 业务事实 | tasks 2 succeeded+1 unknown、goals 2、lab 3 disconnected、budget 21/3、effects 13、state 文件 hash 均不变（但 unknown Task 元数据 version 26→27 未披露，G7） |
| 只读性 | 两次工具调用后 commitSeq/events/deliveries/stateFileHash 不变；status 仅读，diagnosis 仅新增一个已释放/归档 probe Session |
| capability | revision 12→14（hostEpoch rebind + observation）；definitionDigest `1f9c5911…`→`5a591515…` 经独立构建复现，原因（固定实现身份覆盖被 H2a-probe 改动的 `./dsh/workers`）准确 |
| dist | `ce295911…`/101 文件由 `git archive 3b25e1b` 独立重建复现 |
| 工具载荷 | status sha `5ff56a8a…` 匹配但 payloadBytes 51276 为字符数（实际 54096，G6）；diagnosis sha `13e9e4e9…`、工具列表/authorityFields=[]/counters=0/released=disposed=true 均与审计一致 |
| 卫生 | 无秘密、无绝对 home 路径、无消息正文；4 个新文件保留编码 `Users-caja-…` 路径（G9）；committed raw audits 相对 `.local` 原件的唯一差异是 dataDir/sessions.root 脱敏为 `<home>`（G8，未文档化） |

## 4. 新 findings（G1–G11，均不推翻结论）

| ID | 级别 | 事实 | 建议/责任 |
|---|---|---|---|
| G1 | minor-evidence-reference | H3 evidence references a stale slice artifact and an overwritten implementer log | refresh H3 evidence after the final slice-verify artifact/log (or label the first run superseded); use immutable per-run log names and full sha256；owner: inner-domains / Lead |
| G2 | minor-evidence-reference | H6a summary points its implementer log at the Lead run path and truncates the hash | correct summary path and full sha；owner: inner-domains |
| G3 | minor-stale-record | H2a-probe summary keeps a superseded 1297 lead run referencing the final 1299 evidence | label/remove the 1297 pre-tool-wrapper run or attach its log; keep only final 1299 as the current claim；owner: inner-domains / Lead |
| G4 | minor-durability | H0c implementer check is a superseded first attempt whose logs live only in /tmp | label first attempt superseded; archive logs under .local/h0c-verify (gitignored) with sha like H5 F6, or remove the superseded record；owner: test-harness / Lead |
| G5 | minor-arithmetic | H4c summary misdescribes its test delta (says 26 existing + 6 new; actual 25 + 7) | fix to '25 既有 + 7 新增 = 32'；owner: inner-domains |
| G6 | minor-metadata | Joint host statusTool.payloadBytes is a character count, not the file byte size | set payloadBytes to 54096 with bytesSemantics, like the H4/H4b fix；owner: Lead |
| G7 | minor-disclosure | Joint host evidence does not disclose the startup refresh of the retained unknown Task metadata | add a deltaClassification line (unknown Task version 26→27, documented recovery metadata, no retry/success)；owner: Lead |
| G8 | minor-disclosure | Committed host raw audits are sanitized copies of the .local originals but this is not documented | document the redaction (e.g. 'committed copies redact dataDir/sessions.root to <home>; originals in .local') or re-export from the beginning with the sanitizer；owner: Lead |
| G9 | minor-hygiene | New joint host evidence keeps encoded home path in session names | redact sessions.files[].relativePath and addedSessionFiles to e.g. <workspace-root>/<session>/session.v4.jsonl.zstd in future exports; optionally re-export this artifact；owner: Lead |
| G10 | info-unobserved | Host-level eventToolProbe cache is not observed | optionally capture a second shiyu_status after the diagnosis tool in a future zero-model run；owner: Lead |
| G11 | info-traceability | Traceability oracle count differs from tool-selfproof after H0c | optionally add a note/field so traceability states it covers the H0b oracle corpus only；owner: test-harness / Lead |

## 5. 未观察/未覆盖（与证据声明一致）

| 未观察项 | 原因/影响 |
|---|---|
| Independent re-execution of the H2a-probe/H3/H4c/H6a/H0c test suites | read-only review; verified through committed logs/hashes/counts + code/assertion sampling (plus Lead slice-verify secondary executions), not by re-running the suites → test outcomes are verified at the evidence level, not re-executed independently by this review |
| Implementer full-run logs for H3 (1281) and H6a (1325) in their claimed paths | H3 log overwritten by Lead run and not retained; H6a summary path wrong while the committed isolated log exists → see G1/G2; Lead slice runs validate the same builds |
| Joint host provider/model/network absence beyond control-DB and counter deltas | no provider trace in evidence; zero-model claim supported by plan scope, event/counter deltas, unchanged state/usage and probe counters, not by network logs → bounded to fixed-host zero-model limited claim |
| Host-level eventToolProbe cache and real browser DOM | G10; no post-probe status captured; dashboard not rendered → UI/caching remain unobserved at host layer |
| H3 real model plan JSON/caching, H4c real model use of inner block, H6a real platform adapters | not executed by design in these slices → declared untested; no overclaim |
| H0c product/host/business acceptance | synthetic fixtures only; scenarios synthetic-fixture-only-not-run, HOLDOUT unmaterialized → tooling-only evidence, not business acceptance |
| Post-HEAD working-tree WIP | working tree is dirty after HEAD a68eeb2 (conversation/ingress/local-reply-domain, event-tools, goals, src/control/channels, tests/harness/evidence.ts); not part of any reviewed commit → out of scope; review bound to committed HEAD blobs |

## 6. 证据层级集合结论

| 切片 | 离线证据 | 固定宿主 | 未测 |
|---|---|---|---|
| H2a-probe | G1 module + synthetic native host (probe assembly/authority/counters/release, 1299 check) | limited zero-model joint host: shiyu_diagnose_worker_tools receipt + one archived probe Session; no model tool call | real model tool invocation, provider budget/cache, native continuation dispatch, business semantics |
| H3 | G1 module/property + real temporary SQLite/Worker domain (1288) | not executed | real DSH host/Goal rounds, real model plan JSON, caching/usage, dashboard integration, many authorized capabilities |
| H4c | G1 module + real temporary SQLite/Worker + prompt determinism assertions (1271) | not executed for H4c (H4b host remains prior evidence) | real model/cache/cost, how model uses inner block, prepare-contract extension, Lab inner unavailable path documented |
| H6a | G1 module/property + real temporary SQLite + real ControlStore Worker IPC (1336) | not executed | real platform adapter/credentials/receipt, sending/Effect, native Session/draft consumption, dashboard, crash/migration |
| H0c | G1 tooling self-verification + synthetic fixtures/answers (1264) | none | zero product/host/model/Lab/channel execution; 16 scenarios synthetic-fixture-only-not-run, HOLDOUT unmaterialized, 27 design steps uncovered |
| joint-host | n/a | fixed DSH 0.2.1-rc.5 limited zero-model: ordered reload + shiyu_status + diagnose tool; no product model/embedding | real model generation, provider budget/cache, real browser DOM, V24/V25/V26/V27, long-run |

## 7. H0c / traceability

- H0c status `offline-verified-tooling`；coverage 摘要：{"scenarios": 16, "materializedSteps": 65, "designSteps": 80, "uncoveredDesignSteps": 27, "fixtures": 16, "answers": 16, "splits": {"DEV": 16, "REG": 0, "HOLDOUT": 0}, "runEvidence": 0, "holdoutMaterialized": 0, "annotatorScores": 0, "realModelCalls": 0, "realEmbeddingCalls": 0, "labRooms": 0, "hostOperations": 0}；`cannotUseForBusinessAcceptance=True`。
- H0c self-proof：57/57 (H0b 42 + H0c 15)；committed TAP 解析为 22 oracle lines, 53 known-accept-pass + 135 known-reject-caught = 188 total；H0c 7 oracles / 43 verdicts（12 accept + 31 reject）核对一致。
- traceability（HEAD，sha `457f403b037e4a2b…`）：rows 103，product 79 全 not_covered（covered 0），tooling_ready 8，handoff 规则不变。
- oracle 计数口径：traceability.oracles.total=15 (H0b corpus) while tool-selfproof now has 22 oracles (15 H0b + 7 H0c business); README says H0c business oracles are recorded in tool-selfproof.json; no product-row upgrade. Info only; avoid reading 15 as a missing-oracle failure.

## 8. 复核边界

- 本报告冻结于 HEAD `a68eeb2`；其后工作树存在其他切片的未提交 WIP（conversation/ingress/local-reply-domain、event-tools、goals、`src/control/channels/`、`tests/harness/evidence.ts`），**不在本轮范围**，我未修改。
- 只读复核不等于独立重跑：测试结果以未篡改的提交日志/哈希/计数 + 断言与源码检查为证；Lead slice-verify 提供同构建的二次执行。
