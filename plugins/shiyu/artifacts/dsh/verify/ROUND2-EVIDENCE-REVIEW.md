# 第三批（round 2）证据独立复核（task-19，完成）

- 复核对象：X=`4849c89`（H7 code）、X+1=`ef1e9e0`（clean-VCS harness artifacts，parent `762955f`）；本批提交 `dfbf93d`(H6b)、`d4408c8`(H2c)、`26bda0e`(H2c-evidence-refresh)、`11d0c73`(H4d-followup)、`021bdc6`(integration)、`0fb0c59`(round2-host)、`4849c89`(H7-code)、`4849c893cb2183a21605c89ab4a07f4ba7e43516`(X)、`ef1e9e0e58001bc35c570fa4b2a891ffd986fa77`(X+1)、`762955fe5e97065b596a9f3a26fdcc144323279e`(intermediate-evidence-fix)。
- 方式：只读复核 commit blob/evidence/`.local` 日志；未运行真实宿主/模型/embedding；未改他人文件；未 git 提交。
- 结论：**第三批证据真实、内部一致，未发现伪造/静默跳过/未跑写通过；F-R1…F-R7 已在 `762955f` 修复并复核，F-R8（X+1）已解决。**
- 结构化结果：`artifacts/dsh/verify/round2-evidence-review.json`（30 项检查、8 findings 全部 resolved/fixed、未观察项、证据层级）。

## 0. X+1 复核（最后一项）

| 项 | 结果 |
|---|---|
| 身份 | X `4849c89…3516`，X+1 `ef1e9e0`（parent `762955f`）；HEAD=ef1e9e0；X 是 HEAD 祖先 |
| X..X+1 | 13 个 artifacts 文件（9 件 ef1e9e0 + 4 件 artifact-only `762955f`）；`src/client/tests/scripts` diff = 0 行 |
| manifest | `vcs={head:4849c89…,branch:HEAD,dirty:false,dirtyEntries:0}`、generatedAt 21:13:38.075Z、sanitization.leaks=0、不含 `artifacts/dsh` 路径（0 命中）；`dd67e036…`/78073 |
| 9 件产物 | 全部 SHA256+bytes 与声明/commit blob 一致（traceability `d2454275…`/524899、md `f9186d52…`/31057、mapping `74fc5df5…`/28413、selfproof `6a5e7e23…`/15768、tap `3849c2d8…`/12882、fl manifest/coverage 同声明） |
| selfproof | 8 files/63 pass/0 fail/0 skip；`oracle:*`=15、`business-oracle:*`=7、`evidence:*`=6；H0b 42 + H0c 15 + H7 6 = 63 |
| oracleCorpus | `{h0b:15,h0cBusiness:7,totalOracleTests:22}`；traceability.md 明写“合计 22、不是缺少 7 个 oracle” |
| 产品行 | 79/79 `not_covered`、covered=0、tooling_ready 仅 TV.1–7/9、issues=0；41/103 行映射且全部 limited-only、unknown=0、38 未映射行保持 not_covered；9 系统均有 limitations+gaps |
| 隔离/日志 | clean-X check 1382/1382/0 skip、log `59116c33…`/150551；pipeline `edeffbbf…`/2170；archive-manifest `bd2580ed…`/768，worktreeHead=X + lifetimeNote；`.local/h7-verify/` gitignored |
| 工作树来源 | `/tmp/h7x-verify`（detached X）9 件 artifacts 与 HEAD blobs 全等；仅有 artifacts 修改 + node_modules symlink |

注：X..X+1 含中间 artifact-only 证据修提交 `762955f`（F-R1..R7 修正，4 文件，不改代码）；manifest roots 不含 `artifacts/dsh`，故 head=X/dirty=false 仍成立。clean check log 本身不含 X SHA（archive-manifest 记录 worktreeHead=X）；pipeline log 为 checklist，63 tests 以 committed tool-selfproof 为准；h7 mapping MD 用 41/38 表述，“不是缺少 7 个 oracle”原文在 traceability.md。

## 1. 计数与日志

| 切片 | 基线 | 实现者隔离 | Lead slice | 关键日志 |
|---|---|---|---|---|
| H6b | 1345 | 1352/1352（1336+16） | 1361/1361 | impl `db2e0f2f…`/147714；slice `ba8e2bb1…`/148588 |
| H2c | 1361 | 1359/1359（1345+14，日志已被覆盖，F-R1 已修） | 1375/1375 | slice `6c52a1f5…`/150184；targeted 169 `42e5732c…`/19022 |
| H4d | — | 1345/1345 | 1345/1345 | `911b8e7a…`/146824；`55b0d880…`/146852 |
| 集成 | 1375 | — | 1376/1376（+1 tool test） | `68fb9d8c…`/150291 |
| H7 / X+1 | 1376 | — | 1382/1382（X code）；clean-X 1382/1382 | `1d2c044a…`/150583；`59116c33…`/150551 |

H6b focused/regression 8/8 日志 sha/bytes/counts 全部匹配（bridge 9、bridge-worker 7、identity 9、ingress 12、audience 8、conversation 4、worker 4、regression 97）。

## 2. 宿主 0fb0c59 审计链

| 观察项 | 结果 |
|---|---|
| commitSeq / events / deliveries | 315→322→322→322；events 39→40；deliveries 38→39 |
| stateVersion / capability | 6 不变；capability 14→16，hostEpoch 1832→68b6，definitionDigest `5a591515…` 不变 |
| sessions | 18→18→20→20；18 个已知文件不变；仅新增 worker(a91427aa…)+core(bd923a83…) 两个 probe Session |
| unknown Task | 启动刷新 v27→v28，state 仍 unknown、无重试/成功（已披露） |
| 只读性 | after-tools→after-status2 仅 capturedAt 变；commitSeq/events/state 文件不变；工具调用只读 |
| 探针/缓存 | 两探针各一 Session；authorityFields=[]、counters=0、released/disposed；statusAfterProbes 两条 diagnostics 缓存与 probeSessionId 匹配 |

**独立复现**：`git archive 021bdc6` + tsc → 103 文件、dist `7b70471a…`；capability-identity → definitionDigest `5a591515…`，均与证据一致。

## 3. F-R findings 最终处置

| ID | 原问题 | 处置 |
|---|---|---|
| F-R1 | H2c slice-summary keeps an overwritten implementer log reference | fixed-in-762955f：claims .local/slice-verify-h2c.log sha '17efc888…' for the 1359 implementer run; current file is the Lead 1375 run (6c52a1f5…/150184) and th |
| F-R2 | Round-2 statusTool payloadBytes are character counts, not file bytes | fixed-in-762955f：declared 51990/56833 vs actual files 54828/59755 bytes; sha256 matches the actual files |
| F-R3 | Round-2 raw audits are sanitized copies but the joint evidence does not say so | fixed-in-762955f：committed audits differ from .local originals only in dataDir and sessions.root (<home> redaction); no sanitizedAudits note in round2 joint  |
| F-R4 | New round-2 host evidence keeps encoded home path in session names | fixed-in-762955f：encoded 'Users-caja-…' appears in 4 raw audits and the joint addedSessionFiles; no absolute /Users path, no body/secret |
| F-R5 | Round-2 probe payloads lack recorded sha/bytes and some fields are summarized away | fixed-in-762955f：joint evidence omits ok/preset/scope from the raw probe payloads (keeps expected/other fields) and records no sha/bytes for the two probe fi |
| F-R6 | Integration 145/145 targeted run has no retained log | fixed-in-762955f：claim only; the full isolated 1376/1376 log is retained |
| F-R7 | H6b slice-summary implementer log hash truncated | fixed-in-762955f：'db2e0f2f…' vs committed full sha db2e0f2f…/147714 (matches) |
| F-R8 | H7 X+1 clean artifacts not yet delivered | resolved：HEAD 4849c89 has H7 code/tests only; committed traceability artifact still pre-H7 (no oracleCorpus) |

## 4. 未观察/未覆盖

| 项 | 原因/影响 |
|---|---|
| H7 X+1 clean artifacts | not yet produced; X/X+1 not available at review time |
| Independent re-execution of suites | read-only review; verified via retained logs/hashes/counts + Lead slice-verify secondary execution |
| Real model/channel/provider/DOM/long-run behavior | round-2 host is zero-model limited; probes only prove mounting/release/cache; real channel traffic/audience behavior only offline tests |
| H2c implementer 1359 log | overwritten/not retained; Lead 1375 run validates same build |
| Round-2 probe wrapper flags at host layer | cache adds zeroModel/readOnly/sent wrapper flags not present in stored probe payloads; relation inferred, not hash-bound |

## 5. 证据层级

| 切片 | 离线 | 宿主 |
|---|---|---|
| H6b | G1 offline module/integration + real temporary SQLite/Worker IPC | runtime assembly pending at slice commit; round-2 host validates limited wiring/projection |
| H2c | G1 module/integration + synthetic provider loop | round-2 core probe limited zero-model |
| H4d | G1 offline module + real temp SQLite/Worker IPC | not run for H4d |
| integration | G1 integration + full isolated check | round-2 host limited zero-model validates wiring/probes |
| round2-host | fixed-host zero-model limited (reload + 4 tool calls) | no real model/channel/business |
| H7 | G1 tooling/evidence mapping (clean X+1 artifacts verified) | n/a |

## 6. 复核边界

- 本报告冻结于 X+1=`ef1e9e0`；X+1 之后无 code/tests 变化。
- 只读复核不等于独立重跑：以保留日志/哈希/计数、clean worktree 证据与 Lead slice-verify 二次执行为证；真实模型/渠道/业务验收仍未测（证据已声明）。
