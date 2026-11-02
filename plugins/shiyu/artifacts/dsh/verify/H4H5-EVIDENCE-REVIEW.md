# H4 / H4b / H5 / H4b-host 已提交证据真实性独立复核（task-13）

- 复核对象：HEAD `00fb75b25a89006b9c69a569c9203a57043855f2`；提交 `2e04eb2`(H4)、`f2f9d42`(H4b)、`5a7bc9e`(H5)、`feecf86`(H4-host)、`00fb75b`(H4b-host)、`eef00d3`(H0b)
- 复核方式：**只读**审阅提交内文件、产品/测试源码、`artifacts/dsh/**`、`.local` 日志；未运行真实宿主/模型/embedding；未修改任何产品、测试或实现者证据；未 git 提交。
- 额外独立复算：用 `git archive` 在 /tmp 重建 `3b3b69f` 与 `f2f9d42` 的 dist（仅 tsc）并复算 host-audit dist digest，随后删除临时树；只用 `node:sqlite` 只读查询 `.local/runtime/control/events.sqlite`。
- 结构化逐项结果：`artifacts/dsh/verify/h4h5-evidence-review.json`（30 项断言/证据/结论 + findings + unobserved）。

## 0. 总体结论

**证据真实性：通过（无伪造发现）。** 共 30 项检查：**verified 29 / finding 1（C29，展开为 F1/F2 路径项）/ rejected 0**；另有 10 条 findings（F1–F10）与 7 条未观察项。所有声明的文件 SHA256、日志 SHA256/bytes/计数、矩阵与校验器分母、宿主 before/after/after-tool 审计差量均与提交内容一致；安装的 dist 可由对应提交独立重建复现。发现的问题均为 **路径脱敏/元数据完整性/披露与可审计性** 层面的 minor 项（F1–F10），不改变 H4/H4b/H5 的结论或证据层级。

关键判定：
- H4/H4b/H5/H0b 的隔离 check、Lead 独立 slice-verify、定向/UI 日志与声明一致，未见“空断言/静默跳过/复制实现当 oracle/未跑写通过”的证据。
- 宿主证据审计链内部自洽：commitSeq 291→302→308、stateVersion 5→6→6、capability revision 8→10→12（每次 reload +2 且 hostEpoch 重绑到新 instanceId）与实现路径（Runtime init rebind + observeLocalNote；publication 仅在 manifest 变化时升版）一致；Task/Goal/Lab/预算/Effect/17 Session 文件/state 文件不变，工具调用前后仅 `capturedAt` 不同（只读）。
- H5 “已验证性”边界未被夸大：证据明确 G1 离线 + 合成端口、未接 Runtime/宿主，未声称 V22/V27/RPO/RTO/独立故障域；ready/failed/incomplete、lastGood、旧删除账本、tombstone、防复活等断言真实存在。
- traceability/handoff 未被误升级：产品行 79/79 `not_covered`、`covered=0`；`tooling_ready` 仅 TV.1–7/9（工具判定器自证），handoff 明文禁止升级为产品通过；H4/H5/H4b 未修改 traceability。

## 1. 复核矩阵（逐项）

| ID | 域 | 声明 | 结果 | 证据/方法摘要 |
|---|---|---|---|---|
| C01 | commit/file identity | H4 evidence declares 21 slice files; H4 commit 2e04eb2 contains them with identical SHA256 | **verified** | artifacts/dsh/h4/h4-inner-domains-offline.json#implementation.added/modified/updated files; artifacts/dsh/h4/h4-slice-summary.json#files |
| C02 | commit/file identity | H4b declares 7 slice files and H4b commit f2f9d42 contains them identically | **verified** | artifacts/dsh/h4/h4b-integration.json#files; artifacts/dsh/h4/h4b-slice-summary.json#files |
| C03 | commit/file identity | H5 declares 18/19 slice files and commit 5a7bc9e contains them identically; matrix fingerprints (12 module files, 7 test | **verified** | artifacts/dsh/h5/h5-slice-summary.json#files; artifacts/dsh/h5/h5-verification.json#sliceFiles; artifacts/dsh/h5/h5-recovery-matrix.json#fingerprints |
| C04 | commit/file identity | Lead slice-verify artifacts for H1/H0b/H4/H4b/H5 describe the exact committed slice files | **verified** | artifacts/dsh/slices/{h1,h0b,h4,h4b,h5}-verify.json |
| C05 | H4 isolated check | H4 implementer isolated worktree npm run check = 1088/1088, 0 fail, 0 skip, exit 0; log sha f43ac02c… | **verified** | .local/h4-check-final.log; artifacts/dsh/h4/h4-slice-summary.json#verification.implementerIsolatedCheck |
| C06 | H4 Lead slice check | Lead slice verification at HEAD 31af227 + 21 files = 1159/1159, 0 skip; log 0bffd689… | **verified** | .local/slice-verify-h4.log; artifacts/dsh/slices/h4-verify.json |
| C07 | H4 test truth | 63 new inner tests are real assertions with per-file counts (8/10/9/7/8/12/9) and no skips/tautologies | **verified** | 2e04eb2 tests/inner-*.test.ts; artifacts/dsh/h4/h4-inner-domains-offline.json#implementation.addedTestFiles |
| C08 | H4 baseline-test edits | Three baseline tests updated only for schema4/version/shape, not weakened | **verified** | 2e04eb2 tests/local-view-store.test.ts, tests/memory-view-store.test.ts, tests/runtime-capability.test.ts |
| C09 | H4b isolated checks | H4b implementer npm run check = 1206/1206, UI 209/209; Lead reran UI independently 209/209 | **verified** | .local/h4b-check-final.log; .local/h4b-ui-final.log; .local/h4b-lead-ui.log; artifacts/dsh/h4/h4b-slice-summary.json#verification.implementerIsolatedC |
| C10 | H4b test truth | inner-view +5 tests and inner.spec.mjs +5 UI cases are substantive; 209 = 204+5 | **verified** | f2f9d42 tests/inner-view.test.ts; f2f9d42 tests/ui/inner.spec.mjs |
| C11 | H5 isolated checks | H5 implementer isolated npm run check x3 = 1063 tests/1062 pass/0 fail/1 pre-existing conditional skip; logs sha/bytes m | **verified** | /tmp/h5-check-final.log; /tmp/h5-check-final2.log; /tmp/h5-check-final3.log; artifacts/dsh/h5/h5-verification.json#runs |
| C12 | H5 Lead slice check | H5 Lead slice verification at HEAD 92c857f + 18 files = 1096/1096, 0 skip; log f0ea3313… | **verified** | .local/slice-verify-h5.log; artifacts/dsh/slices/h5-verify.json |
| C13 | H5 matrix | 30/30 fault-matrix cases executed and passed; each has injection point/expected/observed; required families present | **verified** | artifacts/dsh/h5/h5-recovery-matrix.json; 5a7bc9e tests/recovery-matrix.ts; tests/recovery-fault-matrix.test.ts |
| C14 | H5 validator self-proof | 18/18 self-proof cases: good bundle/report accepted, 17 known-bad variants rejected by expected code | **verified** | artifacts/dsh/h5/h5-recovery-validator-selftest.json; 5a7bc9e tests/recovery-matrix.ts#runValidatorSelfProof |
| C15 | H5 boundaries honesty | H5 evidence explicitly G1 offline/synthetic; no V22/V27/live-host claim | **verified** | artifacts/dsh/h5/h5-recovery-matrix.json#boundaries; artifacts/dsh/h5/h5-slice-summary.json; plugins/shiyu/DSH实施记录.md §6 |
| C16 | H4 host audit chain | H4 zero-model reload: before/after/after-tool raw audit fields match the summary and the deltas are exactly the classifi | **verified** | artifacts/dsh/h4/h4-host-zero-model.json; artifacts/dsh/h4/host-{before,after,after-tool}.json |
| C17 | H4 host business facts | No Task/Goal/Lab/budget/effect/Session business facts changed by the reload | **verified** | host-before.json; host-after.json |
| C18 | H4b host audit chain | H4b zero-model reload: 302→308, stateVersion 6→6, publication unchanged, capability 10→12, no business fact change, tool | **verified** | artifacts/dsh/h4/h4b-host-visible.json; artifacts/dsh/h4/h4b-host-{before,after,after-tool}.json |
| C19 | H4b host visible summary | systems[].inner.summary corrected; stale H4 wording gone; innerProjection six domains still available with same authorit | **verified** | artifacts/dsh/h4/shiyu-status-schema4-host.json; artifacts/dsh/h4/shiyu-status-h4b-host.json; h4b-host-visible.json#findings |
| C20 | host dist provenance | dist installed for each host run was actually built from the claimed committed HEAD | **verified** | h4-host-zero-model.json#code.dist; h4b-host-visible.json#code.dist; host snapshots #dist |
| C21 | event history | Only startup lifecycle writes occurred; no new task/goal/model/lab events | **verified** | .local/runtime/control/events.sqlite (read-only query) |
| C22 | stateVersion/capability explanation | stateVersion 5→6 then 6→6 and capability revision +2 per reload are explained by the implementation path | **verified** | src/runtime.ts:179-190; src/state/publication.ts:299-313; src/adapters/control-store/capability-domain.ts:75-85,195-215 |
| C23 | H0b self-proof | H0b self-proof corpus is real: 42 tests/42 pass, 15 oracles, 145 known verdicts (41 accept / 104 reject), 0 leaks | **verified** | artifacts/dsh/harness/tool-selfproof.json; artifacts/dsh/harness/tool-selfproof.tap; artifacts/dsh/harness/manifest.json; artifacts/dsh/h0/h0b-test-ha |
| C24 | traceability/handoff | Product rows remain not_covered; tooling_ready not upgraded; handoff rules intact | **verified** | artifacts/dsh/harness/traceability.json (HEAD=eef00d3 only); h0b-test-harness.json#verification.traceability |
| C25 | commit scope discipline | Reviewed commits do not touch forbidden files (src/runtime.ts, src/index.ts, dsh adapters workers/event-tools) and stay  | **verified** | git show --name-only 2e04eb2 f2f9d42 5a7bc9e feecf86 00fb75b |
| C26 | host evidence integrity | Committed host snapshots/payloads are the originals captured during the run | **verified** | artifacts/dsh/h4/host-*.json; artifacts/dsh/h4/shiyu-status-*.json; .local/h1h4h5-host-*.json; .local/h4b-host-*.json |
| C27 | H5 boundary detail | ready/failed/incomplete, lastGood, old deletion ledger assertions really exist | **verified** | 5a7bc9e tests/recovery-matrix.ts; tests/recovery-capture.test.ts; tests/recovery-restore.test.ts |
| C28 | hygiene-secrets | New evidence contains no credentials/secrets/real message bodies | **verified** | 29 new evidence/doc files in reviewed commits; host audit tool source |
| C29 | hygiene-paths | New H4/H5 evidence should not add unredacted local paths | **finding** | artifacts/dsh/h4/h4-inner-domains-offline.json lines 283/286; artifacts/dsh/slices/{h4,h4b,h5,h0b,h1}-verify.json; artifacts/dsh/h4/{host,h4b-host}-*. |
| C30 | evidence-level wording | H4/H4b/H5/DSH record do not overclaim host/model/business acceptance | **verified** | h4-slice-summary.json; h4b-slice-summary.json; h5-slice-summary.json; DSH实施记录.md §6/§7/§9 |

### 1.1 H4 / H4b / H5 / H0b 计数与算术链

| 切片 | 基线 | 增量 | 合同总数 | 实现者隔离 check | Lead slice-verify |
|---|---|---|---|---|---|
| H4 | 1025 | +63 inner | 1088 | 1088/1088, 0 skip, log `f43ac02c…` | 1096+63=1159/1159, log `0bffd689…` |
| H4b | 1201 | +5 | 1206 | 1206/1206, UI 209/209 | 1206/1206, log `4ec58080…`；Lead UI 独立重跑 209/209 |
| H5 | 1058 | +38 | 1096 | ×3: 1063/1062 pass/1 既有 skip（pinned Python 缺失） | 1096/1096, 0 skip, log `f0ea3313…` |
| H0b | 1159 | +42 | 1201 | 42/42 self-proof tests, 15 oracles, 145 known verdicts(41 accept/104 reject) | 1201/1201, log `5d37d100…` |

## 2. 宿主零模型审计链（H4 `feecf86` / H4b `00fb75b`）

| 观察项 | H4 reload | H4b reload | 判定 |
|---|---|---|---|
| commitSeq | 291 → 302 (+11) | 302 → 308 (+6) | 与证据声明一致；未观测到任务/目标/模型/渠道事件，唯一新增事件为 `runtime.lifecycle.changed`（correlationId=新 instanceId） |
| stateVersion | 5 → 6 | 6 → 6 | 首次真实发布 schema4（四域 unavailable→available，manifestHash fd3f…→8e9f…）；第二次 manifest 不变不升版 |
| capability revision | 8 → 10 | 10 → 12 | 每次 +2 与代码路径一致：ControlStore init hostEpoch 重绑(+1) + observeLocalNote(+1)；observation hostEpoch 同步为新 instanceId |
| 业务事实 | 全部不变 | 全部不变 | tasks 状态/Goal/Lab 连接/预算 settled=21·unknown=3/effects=13/17 Session 文件+digest/state 文件 sha 均同；见 F4/F5 的 unknown Task 元数据刷新披露项 |
| 工具只读 | 仅 capturedAt 变 | 仅 capturedAt 变 | after 与 after-tool 深度 diff 无其他变化 |
| dist 指纹 | 647aaa7f… | bff93a84… | **独立重建 3b3b69f / f2f9d42 得到相同 digest**，安装构建来源成立 |
| 载荷 | schema4 六域 available；inner summary 仍陈旧（H4 已知） | 同一 manifestHash/authorityId；inner summary 已改为六域如实描述 | H4b findings 的“旧文案已清除”属实 |

事件历史（只读 SQLite）：events 36/37/38 分别为 H0(`69650eab`)/H4(`7dddbb6c`)/H4b(`b10a41c5`) reload 的 `runtime.lifecycle.changed`；watermark commit_seq=308；无新增 task/goal/lab/model 事件。

## 3. Issue / 发现清单（不改变证据真实性结论）

| ID | 级别 | 事实 | 建议/责任 |
|---|---|---|---|
| F1 | minor-hygiene | Absolute home paths in newly added slice/implementer evidence；证据：artifacts/dsh/h4/h4-inner-domains-offline.json:283,286 (reproduce commands); artifacts/dsh/slices/h4-verify.json (worktree, log.path); artifacts/dsh/slices/h4b-verify.json; artifacts/dsh/slices/h5-ver；new (not historical) | sanitize slice-verify.mjs output (worktree relative to repo or <home>) and fix H4 reproduce commands; regenerate artifacts; H1/H0b same class if batch-regenerated；owner: lead (tool) / inner-domains + recovery-checkpoint (their committed evidence) |
| F2 | minor-hygiene | Encoded home path in new host audit snapshots (sessions.files[].relativePath)；证据：artifacts/dsh/h4/host-before.json; artifacts/dsh/h4/host-after.json; artifacts/dsh/h4/host-after-tool.json; artifacts/dsh/h4/h4b-host-before.json; artifacts/dsh/h4/h4b-host-after.json; artifacts/dsh/h；follows existing H0 host-audit convention (base HEAD 08995d1 already had h0 host-audit files with the same class), but these are newly added files; no absolute <home> and no messag | redact relativePath in future exports (e.g. <workspace-root>/session.v4.jsonl.zstd) or accept as documented historical convention for host-audit metadata；owner: lead (host evidence/tool) |
| F3 | minor-metadata | payload.bytes does not match the committed payload file size (sha does match)；证据：artifacts/dsh/h4/h4-host-zero-model.json#payload; artifacts/dsh/h4/h4b-host-visible.json#payload； | correct the bytes fields or document that they refer to the original tool output; sha and content are consistent；owner: lead (host evidence) |
| F4 | minor-disclosure | H4b host evidence does not disclose the startup refresh of the retained unknown Task uncertainty metadata；证据：artifacts/dsh/h4/h4b-host-visible.json#deltaClassification; artifacts/dsh/h4/h4-host-zero-model.json#findings[2]；aggregate facts (unknown preserved, no retry/success/assignment) unchanged, so the classification is not false, but the write is not disclosed in the H4b artifact | add the metadata-refresh disclosure (as H4 did) and/or capture task version/update digests in the audit snapshot；owner: lead (host evidence) |
| F5 | minor-auditability | H4 claim of unknown Task version 24->25 is not observable from the committed audit snapshots；证据：artifacts/dsh/h4/h4-host-zero-model.json#findings[2]; artifacts/dsh/h4/host-*.json； | include task record version/last-updated digest (metadata only) in host-state-audit output；owner: lead (host evidence/tool) |
| F6 | minor-durability | H5 implementer run logs referenced only under /tmp；证据：artifacts/dsh/h5/h5-verification.json#runs； | copy the three logs into plugins/shiyu/.local (gitignored) or artifacts and record their hashes, or explicitly note transient evidence；owner: recovery-checkpoint/lead |
| F7 | info | H4b evidence logs have no SHA/bytes claims；证据：artifacts/dsh/h4/h4b-slice-summary.json#verification.implementerIsolatedCheck.logs； | add sha/bytes claims like H4/H5 for attribution/durability；owner: inner-domains/lead |
| F8 | info | H5 matrix JSON 'observed' strings are hand-authored narrative；证据：artifacts/dsh/h5/h5-recovery-matrix.json#cases； | derive observed from measured variables where feasible to avoid future drift；owner: recovery-checkpoint |
| F9 | info | H4 plan code.oldDist digest equals the newly built 3b3b69f digest; backup provenance ambiguous；证据：.local/dsh-h1h4h5-host-execution-plan.json#code.oldDist; artifacts/dsh/h4/h4-host-zero-model.json#code.dist；installed-build claim is independently confirmed; only the oldDist label is ambiguous | clarify/rename oldDist if the backup was taken after the new build; keep dist digest evidence；owner: lead |
| F10 | info | H0b harness manifest was generated on a dirty overlay (vcs head 92c857f, dirty=true)；证据：artifacts/dsh/harness/manifest.json#vcs; artifacts/dsh/h0/h0b-test-harness.json#failedUnknownUntested；artifact is self-consistent and sanitized(leaks=0), but not byte-reproducible from the commit tree alone | optional clean refresh in a later tooling slice; keep the disclosure；owner: test-harness/lead |

### 3.1 路径脱敏分类

- **既有历史惯例**：base HEAD `08995d1` 的 `artifacts/dsh/h0/host-audit-*.json` 已含编码 `Users-caja` 的 Session 目录名；本次 H4/H4b host 原始审计沿用同一 `scripts/host-state-audit.mjs` 输出格式，绝对根已脱敏为 `<home>`。
- **新增应修（F1）**：H4 新增 `h4-inner-domains-offline.json` 的 reproduce 命令含绝对 home 路径；`slices/{h4,h4b,h5}-verify.json`（以及同批次 h0b/h1-verify）由 `scripts/slice-verify.mjs` 写入绝对 worktree/log 路径。建议在工具输出层统一改为相对路径或 `<home>` 后重生成。
- **新增但沿用惯例（F2）**：6 个新增 host 原始审计文件的 `sessions.files[].relativePath` 仍含编码 `Users-caja-…`；无绝对路径、无正文；建议后续导出将 relativePath 脱敏为 `<workspace-root>/…`。

## 4. 明确未观察/未覆盖（与证据声明一致）

| 未观察项 | 原因 | 对结论的影响 |
|---|---|---|
| Independent rerun of H4/H4b/H5 test suites by the reviewer | task is read-only review; no product/test execution was performed (only one offline dist rebuild from git archive in /tmp for digest verification) | test outcomes are verified at the level of committed logs, hashes, counts and code/assertion inspection, not by independent execution; Lead slice-verify runs provide a second execution for H4/H4b/H5/H0b/H1 |
| Provider/model/network absence beyond control DB + usage + plan scope | host evidence has no provider trace; zero-model claim is supported by plan scope, event/counter deltas, unchanged lastModelVerification and no task/goal/session changes, but no packet/provider log | bounded to fixed-host zero-model limited claim, matching evidence wording |
| Real DSH host rendering/screenshot of the H4b dashboard panel | UI evidence is synthetic Playwright host; H4b host evidence only verifies shiyu_status JSON summary, not rendered DOM | H4b host evidence correctly says it verifies visible JSON/summary; real rendering remains unverified |
| H5 V22/V27/live host/RPO/RTO/independent fault domain | not attempted by the slice; evidence explicitly disclaims | no overclaim; remains blocked/pending as declared |
| H4b replyer production generation path consuming inner domains (H4c) | out of H4b scope, declared boundary | local read-view composition tested; generation path not wired |
| H4 Task version 24->25 exact transition | not captured in audit metadata; current read-only DB shows version 26/updatedAt=H4b reload, consistent but not proof of the exact H4 delta | see F5 |
| H4b host task-uncertainty refresh write disclosure | not in H4b artifact; observed via read-only DB current state | see F4 |

## 5. 证据层级与结论

- H4：G1 模块/属性 + 真实临时 SQLite/WorkerThread；一次固定宿主零模型 reload（limited，非 V24/业务验收）。
- H4b：G1 模块 + 真实 Worker + 合成宿主 Playwright UI；一次固定宿主零模型 reload 确认 shiyu_status summary 文案；**真实 DSH 渲染未单独验证**。
- H5：G1 离线模块 + 合成端口（真实临时 SQLite/文件）；未接 Runtime、未测 live 宿主/V22/V27/RPO/RTO/独立故障域；30/30 故障矩阵与 18/18 校验器自结论与提交内容一致。
- H0b：G1 工具自证（42/42 tests、15 oracles、145 known verdicts、sanitization leaks=0）；产品行保持 not_covered。
- 结论：**提交的证据真实、内部一致且边界表述诚实；未发现伪造、静默跳过或未跑写通过。** F1/F2/F3/F4/F5/F6/F7 属需修正/披露的证据卫生项，不推翻 H4/H4b/H5/H0b 的证据层级结论。

## 6. 复核所用文件哈希（节选，完整见 JSON）

| 文件 | SHA256 |
|---|---|
| `.local/h4-check-final.log` | `f43ac02c7734a91be34537be20942347560880bc2e12b7f805a1601cfea43c50` |
| `.local/slice-verify-h4.log` | `0bffd689189cb072dcd9c5e5009b59046065cd8193eaf61dffde9ac977d92171` |
| `.local/h4b-check-final.log` | `4821590f4ceef738c1d221530803643ebb8bc036803379db911ec964bc0ff1ea` |
| `.local/h4b-ui-final.log` | `18b35e135f160bfad3b48fd7b9117036ba01193a99f08101ac1b27f620dbbc7d` |
| `.local/h4b-lead-ui.log` | `0a9042ec906ccb167b84439aa60a657302a61b186ca76bd06947632dfdaebd64` |
| `.local/slice-verify-h4b.log` | `4ec580808db18562adf0ddfaaf2748d75b105267814a45466263c31e8565df99` |
| `.local/slice-verify-h5.log` | `f0ea331378eea3f16c9f04b2f9bc64cee16a694dc472a70a5d229fefcd6122b7` |
| `.local/slice-verify-h0b.log` | `5d37d10030cdb2483c18fe53284a2669df8f1d3fa0b8362fe8c4769c20cccf17` |
| `/tmp/h5-check-final.log` | `abeb16069ae86fea570b80b903227795a6534eadfec30ee0a763094832dc09ac` |
| `/tmp/h5-check-final2.log` | `fcf7d8d6cb6f77b425a182b0406d47aae4dae6d10b58730c11974c78b8518990` |
| `/tmp/h5-check-final3.log` | `8c764019fa4a7ab9e94d025ebbd8e7a7883308dcc7eac9d1e2f7275e01458b36` |
| `artifacts/dsh/h4/h4-host-zero-model.json` | `c29fd4099c137ba6d88f16fbbcb0013dea8d9664b75f8a9ffa40926a57f05e49` |
| `artifacts/dsh/h4/h4b-host-visible.json` | `22760b75f4921b839bb7119bc6e881db348375d3a0e38aac710545cac120ac43` |
| `artifacts/dsh/h4/h4-inner-domains-offline.json` | `3c2731afd977cab4cf92fe8dc9bd0b3e1c4c63694cfbb6ff40fe06061da23742` |
| `artifacts/dsh/h4/h4b-integration.json` | `abb2c6e2429093368c889aa1f68ca6339f7d2f11ba8fe8ca7f0ad31e909193b8` |
| `artifacts/dsh/h4/h4b-slice-summary.json` | `ce09df93a011cc96b609d424c430371c2cbfea91fc2c748a5cf51fa717fbda2c` |
| `artifacts/dsh/h4/h4-slice-summary.json` | `8261145b4d90b8f3275884e887bb212ea1ceda4b454564a8a0a8162a29b93960` |
| `artifacts/dsh/h5/h5-recovery-matrix.json` | `4e3891f5457b7da0b02996457c9f04fc2ff8eba25daf741bcda775616dd8cd59` |
| `artifacts/dsh/h5/h5-recovery-validator-selftest.json` | `76070b507c96242cf6a0ea237d7d5ac6f6d06f17d2c52e5579f3eb55ab559b7b` |
| `artifacts/dsh/h5/h5-verification.json` | `2cdf4265ae148ec952d6be2e13782b50c4e9a8bbee9f4687cb8d000cb92f2b6c` |
| `artifacts/dsh/h5/h5-slice-summary.json` | `32f9df0e4f2fc54f5b452fd0cf144431b405e818b8a457fbdf91be23d5502df4` |
| `artifacts/dsh/slices/h4-verify.json` | `2e46357e75879a11caad221a788c43da2742b7bce014d180d4ae0a9ce8946a99` |
| `artifacts/dsh/slices/h4b-verify.json` | `678d376037e6d1a11d6ec58956a6ea87ee727e81449824f249023249e5534225` |
| `artifacts/dsh/slices/h5-verify.json` | `2e9d838350a0014603ddad4efa2ea47dbe64d3735c893a65900462317b9f33dd` |
| `artifacts/dsh/slices/h0b-verify.json` | `64d8660ee00e707dde6682cc338cd429304f539d9d8eaa0843cd6eb778317f27` |
| `artifacts/dsh/h0/h0b-test-harness.json` | `e6eb22efb6260ea1452141f7abcf3587059dc829ba6d160650cb0ac7dd06ab68` |

复现要点：`git show <commit>:<path> | shasum -a 256`；日志 `shasum -a 256` + `grep -E "ℹ (tests|pass|fail|skipped)"`；宿主证据逐项重算见 JSON method 字段；dist 复现见 C20。

## 7. 复核快照边界（后续提交不在本报告范围）

- 本报告冻结于 HEAD `00fb75b`，复核提交为 `2e04eb2`/`f2f9d42`/`5a7bc9e`/`feecf86`/`00fb75b`/`eef00d3`。
- 复核完成后 HEAD 已前移至 `7bd962c`（中间 `a80c33d` H2a、`086e43a` H2a evidence、`7bd962c` H0c）。这些提交**不在 task-13 范围**，本报告不对其作真实性结论。
- 事后观察（未复核）：`7bd962c` 已把 `artifacts/dsh/harness` 刷新为 42 个 artifact 文件、tool-selfproof 7 files/57 tests；其 manifest 仍 `vcs.dirty=true`（head `feecf86`），即 F10 类披露在当前 HEAD 仍成立。**不要把 H0c 新 artifact/57 tests 与 `eef00d3` H0b 的 6 files/42 tests 混算**；新提交需要新的独立复核轮次。

## 8. 复核后修正验证（commit `c6a3f05`，仅针对 F1–F6 处置）

Lead 已提交 `c6a3f05`（chore(shiyu): evidence hygiene fixes and independent H4/H5 review (F1-F5)），并对 F1–F6 做出处置。本节为**只读复核该提交的修复字段**，原报告主体仍冻结于 `00fb75b`。

| ID | 处置状态 | 复核结果 |
|---|---|---|
| F1 绝对 home 路径 | 已修 | HEAD `artifacts/dsh` 无 `绝对 home 路径`；slice artifacts 的 worktree/log 改为 `<home>/…` token；H4 reproduce 命令脱敏；`slice-verify.mjs` 从生成处脱敏；核对 h4/h4b/h5 slice artifacts 的 files[] 哈希仍与源 commit 一致（21/7/18 全匹配） |
| F2 编码 home 片段 | 接受为既有惯例 | Lead 记录接受（无绝对路径/无正文），6 个 host 原始审计文件保持原样；后续导出将脱敏 relativePath |
| F3 payload.bytes | 已修 | 两轮 host evidence bytes 改为实际 53320/53773 并加 `bytesSemantics`；sha256 原值不变、仍与实际文件一致 |
| F4 unknown Task 元数据披露 | 已修 | H4b findings 新增 version 25→26、updatedAt=本次 reload、状态/计数/不重试/不宣告成功不变；与只读 DB（version 26、updatedAt=19:24:28.897Z）一致 |
| F5 旧快照缺 task version | 工具前景修复 | `host-state-audit.mjs` 现输出 tasks.metadata(version/updatedAt/state/uncertaintyReason)；已提交旧快照未重跑，故旧的 24→25 仍不能由旧快照直接验证（由 H4b 披露+DB 三角佐证） |
| F6 H5 /tmp 日志 | 已修并入库 | HEAD `h5-verification.json` 含 archivedCopy/logDurability；`.local/h5-verify/` 三份日志存在且 sha/bytes 与声明逐一匹配（gitignored）；矩阵/校验器 JSON 自 `5a7bc9e` 未变 |
| F7 H4b 日志无 hash 声明 | 记录为已知限制 | DSH 记录 §12 记录；后续切片日志复制 .local 并声明 sha/bytes（H5 已按此办理） |
| F8/F9/F10 | 接受/待定 | F8 记后续改进；F9 info 不变；F10 由 test-harness 确认待 Lead 指定 HEAD 后 clean refresh，本报告不对新 commit 结论 |

结论：F1/F3/F4/F6 已修复且复核通过；F2 已按既有惯例明确接受；F5 工具已修但仅对后续快照生效；F7/F8/F9/F10 为已知限制/后续项。修复未改变任何产品/测试源码结论，也未改变 H4/H4b/H5 的证据层级结论。
