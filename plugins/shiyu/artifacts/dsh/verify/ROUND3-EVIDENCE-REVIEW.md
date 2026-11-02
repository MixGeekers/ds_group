# round-3 证据独立复核（task-25，完成）

- 复核对象：X=`c2bb475`（H4e 迁移热修复）、X+1=`3a0f731`（clean-VCS artifacts）、host round-3=`50af4a2`（HEAD）；本批提交 `5062485`(H6c)、`479ad43`(H2b)、`69d725f`(H4e)、`5eede56`(H5b)、`09cf6d9`(H7-acceptance)、`e400fcc`(integration)、`c2bb475e67c11f12334c1b4339284e6084c5630a`(H4e-migration-hotfix (X))、`3a0f73139533813b674f1dac24f11ffc05cd075c`(H7 X+1)、`50af4a261fd8a9050a6b84881fe8dc922c3fa6b0`(host-round3)。
- 只读复核 commit blob/evidence/`.local` 日志；未改他人文件、未 git 提交。
- 结论：**round-3 证据真实、内部一致，未发现伪造/静默跳过/未跑写通过。** 热修复通过并被独立重跑；X+1 与 host 提交满足约定；仅余 1 处 minor 残留 F3-R1r + 2 条 info（F3-R7/F3-R9）。

## 0. 热修复（重点）— 通过

| 项 | 结果 |
|---|---|
| 文件 | c2bb475：inner-domain.ts `7052b0c6…`/45823、inner-upgrade.test.ts `977a06d6…`/4454、证据文件哈希匹配 |
| 无受追踪表 ALTER | inner-domain.ts 仅注释提及 ALTER；新增 additive `<domain>_derivation_meta`；meta() join、saveMeta 双写；required 排除 derivations/derivation_meta |
| 回归测试真实 | 构造 pre-H4e 磁盘 schema → 当前 ControlStore 升级 → 断言 meta 精确 9 列 + derivation_meta `{0,}` + 二次打开；**独立 /tmp 运行 1/1 pass、0 skip** |
| live DB | 4 个 inner meta 均 9 列；4 个 derivation_meta 各 1 行 `{0,}`；watermark=341；393 triggers — 与 migrationFix 一致 |
| 计数/日志 | hotfix 1435/1435、0 skip（`fd93f335…`/155811）；H4e 1389/1411 匹配 |

## 1. 切片计数与证据

| 切片 | 计数 | 媒体 |
|---|---|---|
| H6c | 1382 unit + 214 UI + 5 focused | check `bae4278c…`/150855；UI `7ae6f8e3…`/214、`a6b67cd2…`/214、focused `45d99790…`/5 |
| H2b | 1404（22 new、targeted 98） | slice `33177e35…`/152915；targeted `7948d8b2…`/98 |
| H4e | 1389 impl / 1411 lead | `53775528…`/151665；`5298d15e…`/153708 |
| H5b | 1426；15/15 matrix；impl 1397×2 | `ea675f08…`/155242；trial `71b1bce6…` |
| H7acc | 1434；8 tests；gate incomplete/executed=0 | `b28cad89…`/155701；archived 8 日志匹配 |
| 集成 | 1434（+0；targeted 72/72） | `1af1f9c4…`/155724 |
| 热修复 | 1435（+1） | `fd93f335…`/155811 |

文件哈希 0 mismatch；无 skip/only/恒真断言；traceability 产品行 79/79 not_covered、issues=0。

## 2. X+1（3a0f731）

| 项 | 结果 |
|---|---|
| 差异 | 11 个 artifacts（9 M + acceptance-report.json/.md A）；`c2bb475..3a0f731` 的 src/client/tests/scripts diff=0；parent=X |
| manifest | `{head:c2bb475…,branch:HEAD,dirty:false,dirtyEntries:0}`、generatedAt=22:46:21.061Z、leaks=0、aggregates 392/6,592,842/`7cf5b7e5…` |
| 11 件产物 | 全部 SHA/bytes 匹配（manifest `ba6e4786…`/82018、selfproof `8af56a2e…`/17284、tap `b8412350…`/14183、traceability `7416e349…`/524899、md `13d2cfc1…`/31057、mapping `16b932d8…`/28413、acceptance json `6e481307…`/167324、md `6a4fd7d5…`/26415、fl manifest `a72d8a33…`/13154、coverage `c6012864…`/52559、coverage md `c84488f6…`/9308） |
| clean X | check 1435/1435/0 skip（`3dea5464…`/155781）；pipeline `9caf088d…`/2578（honesty=pass、gate=incomplete、executed=passed=0、buildIssues=0）；archive `8ac5cd30…`/904 frozenHead=c2bb475 + lifetimeNote |
| selfproof | 9 files/71 pass/0 fail/0 skip；oracle 15/7/22；H0b 42+H0c 15+H7 evidence 6+H7acc 8=71 |
| 产品/映射 | 79/79 not_covered、covered=0、tooling_ready 仅 TV.1–7/9；22/22 sources verified（54 files、0 unknown）；41/103 mapped limited-only；issues=0 |
| acceptance | gate=incomplete、completeNineSystems=false；planned 92/executed 0/passed 0/failed 0/blocked 19/notRun 73；modules 32 limited+3 not_covered+5 blocked；systems 9 limited-evidence-only；V 12 limited+14 blocked+1 not_covered；S/FL 16 synthetic、canUse=false；honesty=pass（pipeline/MD，JSON 无该字段） |

## 3. 宿主 50af4a2（零模型 limited）

| 项 | 结果 |
|---|---|
| 链 | 322(before) → 325(failed) → **325→335(repairActivation +10 已分类)** → 341(repaired) → 341(after-tools, sessions 20→22) |
| events/sessions | events 40→40→41→42；sessions 20→20→20→20→22；20 个已知 Session 文件全程不变；新增 worker/core 两个 probe |
| probes/status | 两探针 authorityFields=[]/counters=0/released-disposed；statusAfterProbes 两缓存 probeSessionId 匹配；timeSource idle schedules=0、notifications disabled、channels ready-empty |
| F3 修复 | F3-R2 payloadBytes 实际字节+semantics（55853/60780/2445/2584，sha 均对）；F3-R3 repairActivation 325→335（+10，未逐条枚举但分类/无业务事实变化说明）；F3-R4 Task 版本 28→29→30→31 逐窗口披露；F3-R5 failedBuild e400fcc/`982e5b09…`；F3-R6 relativePath/sanitizedAudits 说明 |
| 构建 | 独立重建 e400fcc→`982e5b…`/109、c2bb475→`342fa7ab…`/109；definitionDigest `5a591515…` 均不变 |
| 范围/卫生 | 提交仅 13 文件（doc+host artifacts+h2b 修复），无 code/tests/scripts；raw audits 仅 dataDir/sessions.root 脱敏；encoded `Users-caja…` 保留但已说明（无绝对路径/正文/秘密） |
| F3-R1 | slice-summary 已重绑 Lead 运行+superseded；**detail `h2b-subscriptions-time.json#isolatedFullCheck.log` 仍保留旧实现者 hash `1c150f34…`（F3-R1r 残留，单字段 minor）** |

## 4. findings 最终处置

| ID | 状态 |
|---|---|
| F3-R1 | partially-fixed-in-50af4a2：H2b implementer isolated log overwritten/not retained |
| F3-R2 | fixed-in-50af4a2：Round-3 host payloadBytes are character counts, not file bytes |
| F3-R3 | fixed-in-50af4a2：Failure→repair commitSeq gap 325→335 not explained |
| F3-R4 | fixed-in-50af4a2：Unknown Task metadata versions 28→29→30→31 not fully disclosed |
| F3-R5 | fixed-in-50af4a2：Failed build provenance (dist 982e5b) not explicit in joint evidence |
| F3-R6 | fixed-in-50af4a2：Round-3 host evidence keeps encoded home path in session names |
| F3-R7 | info-accepted：Integration 72/72 targeted claim has no retained log |
| F3-R8 | resolved-by-3a0f731-and-50af4a2：Host round-3 evidence and H7 X+1 not yet committed/verified |
| F3-R1r | ：H2b detail evidence still carries the overwritten implementer log hash |
| F3-R9 | ：acceptance-report inputs contain the clean generation temp root |

## 5. 未观察/边界

- 仅热修复升级测试在 /tmp 独立重跑；其余套件以保留日志/哈希/计数+Lead clean-X 检查为证。
- 宿主零模型 limited；H5b production readiness blocked；H7acc executed=0；真实模型/渠道/DOM/长期行为未测。
- acceptance inputs 含 `/private/tmp/h7r3-clean` 生成临时路径（无 home 路径、非产品数据，已在提交说明披露；future code 可 redact，F3-R9 info）。
- clean count 1435 不与 H0c 历史 1216/1264 混算。
