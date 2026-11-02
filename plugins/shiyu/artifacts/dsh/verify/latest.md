# H1 独立验证结果：2026-11-02T18-49-33-366Z-final-92c857f

- 运行命令：`node --import tsx --test --test-concurrency=1 --test-reporter=tap tests/verify/*.test.ts`
- 运行时间：2026-11-02T18:49:33.366Z，耗时 37.4s；退出码：0
- 环境：Node v24.19.0，darwin/arm64；工作目录 `/Users/caja/Documents/识雨/plugins/shiyu`
- 产品源码指纹：HEAD 92c857fcfe5d（分支 codex/start-shiyu-implementation），本切片 6 个适配文件 + 测试文件 SHA256 记录在 [manifest.json](manifest.json)
- 固定 SDK：DSH app.asar 内 7 个 0.2.1-rc.5 包的只读 SHA256 已记录（见 manifest.json）；本运行未连接真实宿主、模型、embedding、频道或用户数据。

## 1. 判定口径

- **通过**：TAP 绿 + 该测试关联的每条结构化证据记录均为 `pass`；两者缺一不可。
- **失败**：观察到违反预期，或 TAP 红。
- **blocked / unobservable**：接口/能力/可观测性不具备，单独分母，**不计通过**；TAP 绿但无证据记录记为 `unreported`，同样不计通过。

## 2. 汇总（分母齐全）

| 类别 | 用例数 | 通过 | 失败 | blocked | unobservable | 非通过用例 |
| --- | --- | --- | --- | --- | --- | --- |
| B declared capacity bounds | 7 | 7 | 0 | 0 | 0 | — |
| C judge self-verification | 6 | 6 | 0 | 0 | 0 | — |
| CO core business path | 5 | 5 | 0 | 0 | 0 | — |
| I invalid history/backend | 28 | 28 | 0 | 0 | 0 | — |
| L legal long history | 13 | 13 | 0 | 0 | 0 | — |
| LO load-only business path | 13 | 13 | 0 | 0 | 0 | — |
| R races/cancellation/limits | 12 | 12 | 0 | 0 | 0 | — |
| RP replyer business path | 10 | 10 | 0 | 0 | 0 | — |
| S recovery continuity | 23 | 23 | 0 | 0 | 0 | — |

**总计：117 条用例记录 = 通过 117 / 失败 0 / blocked 0 / unobservable 0。** TAP 测试级：103 个测试 = 通过 103 / 失败 0 / blocked 0 / unobservable 0 / unreported 0 / skip 0。

## 3. 03 §5 场景覆盖矩阵

| 规范要求 | 计划 | 本次有记录 | 失败 | 不完整 | 缺失 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 03 §5 row1: 空史/2048±/远超一页/页间inbox插入移除/继承seed 恢复正确官方投影，同业务 Session 身份保留，不能只证明超限拒绝 | 21 | 21 | — | — | — | covered |
| 03 §5 row2: 短页合法继续；缺号/重复乱序/页超量/坏header/preset/继承/−0 失效无接受回执、资源释放 | 30 | 30 | — | — | — | covered |
| 03 §5 row3: 读取中/EOF后/投影中追加；同长度早段变化、缩短 被检测或按受信规则重取，不默默拼混合历史 | 8 | 8 | — | — | — | covered |
| 03 §5 row4: 原生合法中断收尾/end-seed/固定标题与异源 user 混入；合法恢复成功、未知输入不被丢/自动执行 | 8 | 8 | — | — | — | covered |
| 03 §5 row5: 授权await、onDispatch await、冷读后 live.seq/inbox 变化 → 最终接纳门拒绝失效基准，不产生错误 context receipt/草稿资格 | 10 | 10 | — | — | — | covered |
| 03 §5 row6: 取消、期限、读/投影/关闭失败、关闭后迟到 → handle/agent 生命周期可核对，无静默新 Session/重试未知效果，不泄漏正文 | 7 | 7 | — | — | — | covered |
| 03 §5 row7: load-only、replyer、Core 各自正常长史路径；精确本次原生消息+flush+独立回读才给 receipt；生成路径在明确预算下推进 | 9 | 9 | — | — | — | covered |
| 02 §3.2 / 03 §5 row8: 判定器自证（应过/应拒样本），测试/替身/SDK静态分别留证不互相冒充 | 8 | 8 | — | — | — | covered |

## 4. 判定器与套件完整性静态检查

| 检查项 | 结果 |
| --- | --- |
| 判定器 support/independent.ts 是否 import 产品源码 | 否 |
| 测试中的 .skip/.todo 调用 | 0 |
| 测试中的 .only 调用 | 0 |
| assert.ok(true) 恒真断言 | 0 |
| 每个测试文件是否都写结构化证据 | 是 |
| 逐文件 verifyCase 记录数 | {"00-oracle-selftest.test.ts":6,"10-legal-history.test.ts":13,"20-invalid-history.test.ts":22,"30-races.test.ts":12,"40-limits.test.ts":7,"50-recovery.test.ts":16,"60-business-loadonly.test.ts":13,"70-business-replyer.test.ts":10,"80-business-core.test.ts":5} |
| 判定器自证（C00*） | C00a–C00f：手工应过/应拒样本 + 1 正确/3 故障突变体端到端突变测试 |

## 5. Issue 清单

本运行未发现失败用例，也没有 blocked/unobservable 用例。

## 6. 逐例结果

| ID | 判定 | 预期 | 实际 | 规范来源 |
| --- | --- | --- | --- | --- |
| B00 | pass | page/maxEvents/maxBytes/maxReads/timeout are explicit numbers; page < maxEvents; bounds exceed the legal 2049 history | explicit limits: {"pageEvents":512,"maxEvents":32768,"maxBytes":33554432,"maxReads":256,"timeoutMs":10000,"raw":{"pageEvents":512,"maxEvents":32768,"maxBytes":33554432,"maxReads":256,"timeoutMs":10000,"maxAppendedEvents"… | 03 §2 03 §4.1 |
| B01 | pass | the declared capacity boundary itself must still recover; only maxEvents+1 may fail | asOfSeq=32767 eventCount=32768 refs=1 inherited=0 reads=132 opens=1 closes=1 | 03 §4.1 |
| B02 | pass | one event past the declared capacity rejects with a diagnosable limit error and releases the handle; it must not return a truncated history | rejected with NativeHistoryError code=NATIVE_HISTORY_LIMIT: NativeHistoryError: Native cold projection history exceeds the safe read bound | 03 §4.1 03 §5 row2 |
| B03 | pass | a history whose serialized events exceed the declared byte bound rejects; no partial projection | rejected with NativeHistoryError code=NATIVE_HISTORY_LIMIT: NativeHistoryError: Native cold projection history exceeds the safe read bound | 03 §2 03 §4.1 |
| B04 | pass | a multi-megabyte history below the byte bound recovers exactly | asOfSeq=5 eventCount=6 refs=0 inherited=0 reads=16 opens=1 closes=1 | 03 §4.1 |
| B05 | pass | a backend forcing more than maxReads slices (pageCap=1) rejects with a bounded-work error rather than unbounded reads | rejected with NativeHistoryError code=NATIVE_HISTORY_LIMIT: NativeHistoryError: Native cold projection history exceeds the safe read bound | 03 §2 03 §4.1 |
| B06 | pass | a history whose serialized UTF-8 bytes exceed maxBytes rejects even when its JSON character count is smaller; byte accounting is not a character count | rejected with NativeHistoryError code=NATIVE_HISTORY_LIMIT: NativeHistoryError: Native cold projection history exceeds the safe read bound | 03 §4.1 |
| C00a | pass | independent judge reports no violation for correct snapshot and refs | accepted both correct hand samples (40-event mixed history and empty history) | 02 §3.2 03 §5 |
| C00b | pass | each of 4 hand-built wrong samples is rejected with the matching field violation | rejected all 5 hand-built wrong snapshots with the expected fields | 02 §3.2 03 §3 03 §5 |
| C00c | pass | independent fold refuses duplicate/out-of-range/gap inputs instead of projecting them | rejected 7 malformed hand samples | 02 §3.2 03 §3 |
| C00d | pass | clean rejection passes; body-leaking, unclosed-handle, empty-message and missing-error samples fail | accepted the clean rejection and rejected all 5 unsafe rejection samples | 02 §3.2 03 §5 |
| C00e | pass | offset slices, explicit EOF, monotonic shrink rejection, empty asOfSeq=-1 and detached state | fixture semantics verified (slices, EOF, shrink rejection, empty asOfSeq -1, detached state, inert end-seed) | 03 §3 |
| C00f | pass | independent world+judge accepts a hand-written correct two-pass reader and rejects single-pass, stale-cut and short-page-as-EOF readers | accepted the correct hand reader and rejected all 3 mutants (single-pass:only one complete history pass observed (returned=500, events=500); 03 §4.1 requ \| stale-cut:asOfSeq: expected 500 got 499 (inclusive native waterm… | 02 §3.2 02 §3.1 03 §5 |
| CO01 | pass | same Goal Session resumed from long history; trusted suffix+title bound; exact dispatch receipt; one primary stream; bounded candidate | same Goal Session resumed; candidate text, exact input seq=2011 and assistant seq=2013, one model call, observed accounting | 03 §5 row8 03 §4.3 6.3 |
| CO02 | pass | a foreign native input appended while onDispatch awaits must be detected by the synchronous live baseline recheck before dispatch; no candidate, no context rece… | round refused with "Native history changed outside the trusted recovery suffix"; no candidate/context receipt, accounting preserved | 03 §4.3 03 §5 row5 |
| CO03 | pass | the dispatch gate rechecks the live baseline after an authorization await, so a write landing there is refused before any model call | round refused with "Native history changed outside the trusted recovery suffix"; zero model calls | 03 §4.3 03 §5 row5 |
| CO04 | pass | only the owner input plus at most the exact cwd runtime snapshot may enter the core request; any other user message is rejected before/at the stream boundary | round refused with "Core native context has no distinct official message identity"; no candidate/context receipt | 03 §4.3 NATIVE_SEAMS core input boundary |
| CO05 | pass | an unknown pending native input on the resumed Goal Session blocks the decision before any dispatch/model call; the input is preserved | decision refused with "Unknown native inbox blocks Core Goal recovery"; input preserved; zero dispatch/model | 03 §4.1 03 §5 row5 |
| I01 | pass | a gap in the logical sequence must reject; a completed prefix must not be accepted | rejected with NativeHistoryError code=NATIVE_HISTORY_SEQUENCE: NativeHistoryError: Native cold projection has an incomplete or invalid event sequence | 03 §5 row2 |
| I02a | pass | non-strictly-increasing seqs must reject | rejected with NativeHistoryError code=NATIVE_HISTORY_SEQUENCE: NativeHistoryError: Native cold projection has an incomplete or invalid event sequence | 03 §5 row2 |
| I02b | pass | non-strictly-increasing seqs must reject | rejected with NativeHistoryError code=NATIVE_HISTORY_SEQUENCE: NativeHistoryError: Native cold projection has an incomplete or invalid event sequence | 03 §5 row2 |
| I03 | pass | read length is a maximum; a page exceeding it must be treated as an invalid backend, not silently consumed | rejected with NativeHistoryError code=NATIVE_HISTORY_SEQUENCE: NativeHistoryError: Native cold projection has an incomplete or invalid event sequence | 03 §5 row2 03 §3 read(offset,length) |
| I04 | pass | a backend result without an events array must reject and release the handle | rejected with NativeHistoryError code=NATIVE_HISTORY_READ: NativeHistoryError: Native history read failed | 03 §5 row2 03 §4.1 |
| I05 | pass | a stored header bound to another Session id must never be accepted as this managed Session | rejected with NativeHistoryError code=NATIVE_HISTORY_HEADER: NativeHistoryError: Native history identity or inherited metadata does not match | 03 §5 row2 03 §3 header.id |
| I06 | pass | a Session whose agentPreset differs from the managed binding must reject | rejected with NativeHistoryError code=NATIVE_HISTORY_HEADER: NativeHistoryError: Native history identity or inherited metadata does not match | 03 §5 row2 03 §3 header/preset |
| I07 | pass | a non-current stored header version must not be projected as current history | rejected with NativeHistoryError code=NATIVE_HISTORY_HEADER: NativeHistoryError: Native history identity or inherited metadata does not match | 03 §5 row2 03 §3 SDK validateSessionHeader |
| I08 | pass | isSeeded must be a boolean; a string must reject before projection | rejected with NativeHistoryError code=NATIVE_HISTORY_HEADER: NativeHistoryError: Native history identity or inherited metadata does not match | 03 §5 row2 03 §3 SDK header validation |
| I09 | pass | the frozen SDK brand rejects -0; a recovered inherited count of -0 must never be accepted | rejected with NativeHistoryError code=NATIVE_HISTORY_HEADER: NativeHistoryError: Native history identity or inherited metadata does not match | 03 §4.4 03 §5 row2 SDK SessionLogOffset |
| I10 | pass | inheritedEventCount must be a branded safe integer within the log and exactly 0 for an unseeded Session | rejected with NativeHistoryError code=NATIVE_HISTORY_HEADER: NativeHistoryError: Native history identity or inherited metadata does not match | 03 §5 row2 03 §4.4 |
| I11 | pass | inheritedEventCount must be a branded safe integer within the log and exactly 0 for an unseeded Session | rejected with NativeHistoryError code=NATIVE_HISTORY_HEADER: NativeHistoryError: Native history identity or inherited metadata does not match | 03 §5 row2 03 §4.4 |
| I12 | pass | inheritedEventCount must be a branded safe integer within the log and exactly 0 for an unseeded Session | rejected with NativeHistoryError code=NATIVE_HISTORY_HEADER: NativeHistoryError: Native history identity or inherited metadata does not match | 03 §5 row2 03 §4.4 |
| I13 | pass | inheritedEventCount must be a branded safe integer within the log and exactly 0 for an unseeded Session | rejected with NativeHistoryError code=NATIVE_HISTORY_HEADER: NativeHistoryError: Native history identity or inherited metadata does not match | 03 §5 row2 03 §4.4 |
| I14 | pass | a seeded header must identify its inherited cut with data.inherited===true session/end-seed (or inherited===eventCount) | rejected with NativeHistoryError code=NATIVE_HISTORY_HEADER: NativeHistoryError: Native history identity or inherited metadata does not match | 03 §5 row2 SDK Session constructor |
| I15 | pass | an inbox entry without a complete native message id must reject rather than project an anonymous pending input | rejected with NativeHistoryError code=NATIVE_HISTORY_PROJECTION: NativeHistoryError: Native inbox projection or its sequence watermark is invalid | 03 §5 row2 03 §4.1 |
| I16 | pass | the official inbox fold rejects the same pending message id appearing twice; cold recovery must not accept it | rejected with NativeHistoryError code=NATIVE_HISTORY_PROJECTION: NativeHistoryError: Native inbox projection or its sequence watermark is invalid | 03 §5 row2 agent-loop inbox projection |
| I17 | pass | a persisted splice outside its lane range must reject instead of being clamped | rejected with NativeHistoryError code=NATIVE_HISTORY_PROJECTION: NativeHistoryError: Native inbox projection or its sequence watermark is invalid | 03 §5 row2 agent-loop inbox projection |
| I18 | pass | a projection failure must reject with no acceptance receipt and release the handle | rejected with NativeHistoryError code=NATIVE_HISTORY_PROJECTION: NativeHistoryError: Native inbox projection or its sequence watermark is invalid | 03 §5 last row 03 §4.1 |
| I19 | pass | an absent registered inbox projection must never be interpreted as an empty inbox | rejected with NativeHistoryError code=NATIVE_HISTORY_PROJECTION: NativeHistoryError: Native inbox projection or its sequence watermark is invalid | 03 §5 last row 03 §4.1 |
| I20 | pass | snapshot.asOfSeq must equal the last observed seq (eventCount-1); a projector claiming another cut must reject | rejected with NativeHistoryError code=NATIVE_HISTORY_PROJECTION: NativeHistoryError: Native inbox projection or its sequence watermark is invalid | 03 §3 snapshot.asOfSeq 03 §5 |
| I21 | pass | a read error rejects, stays diagnosable, releases the handle and never includes event/message bodies | rejected with NativeHistoryError code=NATIVE_HISTORY_READ: NativeHistoryError: Native history read failed | 03 §5 last row 02 §9 |
| I22 | pass | a close error must reject the operation (no acceptance receipt); the handle may remain for diagnosis, but no success result escapes | rejected with NativeHistoryError code=NATIVE_HISTORY_CLOSE: NativeHistoryError: Native history handle release failed | 03 §5 last row 03 §4.1 |
| I23 | pass | flush, read-only persistence and cold projection are all required; a missing service rejects without opening/accepted receipt | rejected with NativeHistoryError code=NATIVE_HISTORY_SERVICES: NativeHistoryError: Native history services are unavailable | 03 §4.1 03 §5 last row |
| I24 | pass | flush, read-only persistence and cold projection are all required; a missing service rejects without opening/accepted receipt | rejected with NativeHistoryError code=NATIVE_HISTORY_SERVICES: NativeHistoryError: Native history services are unavailable | 03 §4.1 03 §5 last row |
| I25 | pass | flush, read-only persistence and cold projection are all required; a missing service rejects without opening/accepted receipt | rejected with NativeHistoryError code=NATIVE_HISTORY_SERVICES: NativeHistoryError: Native history services are unavailable | 03 §4.1 03 §5 last row |
| I26 | pass | opening a non-existent Session rejects; no substitute Session is created | rejected with NativeHistoryError code=NATIVE_HISTORY_READ: NativeHistoryError: Native history read failed | 03 §5 last row |
| I27 | pass | for an empty log asOfSeq must be -1; a projector claiming 0 must reject | rejected with NativeHistoryError code=NATIVE_HISTORY_PROJECTION: NativeHistoryError: Native inbox projection or its sequence watermark is invalid | 03 §3 03 §5 last row |
| L01 | pass | asOfSeq=-1, eventCount=0, inherited=0, empty inbox, handle released | asOfSeq=-1 eventCount=0 refs=0 inherited=0 reads=3 opens=1 closes=1 | 03 §5 row1 03 §3 6.6 |
| L02 | pass | both frozen/detached event states are adoptable; empty cut restores with asOfSeq=-1 | asOfSeq=-1 eventCount=0 refs=0 inherited=0 reads=3 opens=1 closes=1 | 03 §3 session-persistence README |
| L03 | pass | 2047 events restored exactly; conforming pages of 512 are not mistaken for EOF | asOfSeq=2046 eventCount=2047 refs=1 inherited=0 reads=12 opens=1 closes=1 | 03 §5 row1 6.6 |
| L04 | pass | exactly 2048 events restored with exact projection and asOfSeq=2047 | asOfSeq=2047 eventCount=2048 refs=1 inherited=0 reads=12 opens=1 closes=1 | 03 §5 row1 6.6 |
| L05 | pass | the old hard 2048 limit must not reject a legal 2049-event history | asOfSeq=2048 eventCount=2049 refs=1 inherited=0 reads=14 opens=1 closes=1 | 03 §5 row1 6.6 |
| L06 | pass | a conforming backend returning fewer events than requested maximum does not terminate the scan early | asOfSeq=4999 eventCount=5000 refs=2 inherited=0 reads=104 opens=1 closes=1 | 03 §5 row1/row2 03 §3 |
| L07 | pass | long legal history restores exactly, no silent truncation, bounded pages honoured | asOfSeq=9999 eventCount=10000 refs=1 inherited=0 reads=204 opens=1 closes=1 | 03 §5 row1 6.6 |
| L08 | pass | inheritedEventCount=300 reported exactly; inherited-prefix inbox splices are projected; official asOfSeq covers the whole log | asOfSeq=899 eventCount=900 refs=2 inherited=300 reads=20 opens=1 closes=1 | 03 §5 row1 03 §3 header/inherited |
| L09 | pass | a seeded header whose inherited cut is the empty prefix passes; marker at seq 0 is part of the log | asOfSeq=60 eventCount=61 refs=1 inherited=0 reads=12 opens=1 closes=1 | 03 §3 03 §5 row1 |
| L10 | pass | next-turn refs precede next-step refs; insert+remove history folds to the final durable inbox | asOfSeq=302 eventCount=303 refs=2 inherited=0 reads=22 opens=1 closes=1 | 03 §5 row1 agent-loop inbox projection |
| L11 | pass | a long-lived managed Session keeps its exact native id and managed preset across cold recovery | asOfSeq=1499 eventCount=1500 refs=1 inherited=0 reads=16 opens=1 closes=1 | 03 §5 row1 |
| L12 | pass | a final page shorter than the requested maximum (because the log ends) is read to explicit EOF and succeeds | asOfSeq=699 eventCount=700 refs=1 inherited=0 reads=8 opens=1 closes=1 | 03 §5 row2 |
| L13 | pass | explicit advertised maxEvents >= 2049 so the old hard limit is genuinely replaced | declared maxEvents=32768 (pageEvents=512, maxBytes=33554432, maxReads=256, timeoutMs=10000) | 03 §2 03 §4.1 |
| LO01 | pass | exact current message appended + flushed, durable readback, no generation, receipt only after all of it | receipt at exact seq=1, 3 flushes, zero followup/model calls, agent disposed | 03 §5 row8 03 §4.3 6.2 |
| LO02 | pass | same Session resumes 3000 persisted events; the resume suffix and the fixed title append are bound into the baseline before the exact load message | same Session shiyu-replyer-verify-load-long-0001: 3000 prefix events preserved, suffix ["session/end-seed","session/title","user/message"], receipt seq=3002 | 03 §4.2 03 §4.3 03 §5 row8 |
| LO03 | pass | a foreign user/message written to the same Session while authorize(append) awaits must not be acknowledged; no durable receipt, no deletion | foreign append left in the log (403 events), no receipt/ack; load failed with "Native history changed outside the trusted recovery suffix" | 03 §4.3 static counterexample 03 §5 row5 |
| LO04 | pass | a foreign write landing before the acknowledgement callback must prevent onContextDurable | foreign event preserved in the log, no durable receipt and no load result | 03 §4.3 03 §5 row5 |
| LO05 | pass | unknown pending input is never removed to make loading succeed; no receipt and the input is preserved | load refused with "Pending native inbox blocks load-only context"; pending input preserved | 03 §4.1 03 §5 row6.2 |
| LO06 | pass | if the durability barrier for the loaded message does not confirm, no load receipt escapes even though the in-memory append happened | load refused with "Native Session durability listener did not handle the flush"; no receipt | 03 §4.1 03 §5 row8 |
| LO07 | pass | an absolute deadline exceeded while authorize(append) awaits rejects without a receipt | deadline observed during authorize(append); load refused without receipt | 03 §4.1 03 §4.3 |
| LO08 | pass | the same business Session id is resumed, the first loaded message remains native history, and the second exact message extends it | one created + one resumed Session shiyu-replyer-ad56d961-24ef-4f04-8839-db3b1e63726e, both exact messages retained, second receipt seq=3 | 03 §5 row1/row8 |
| LO09 | pass | cooperative cancellation rejects without a load receipt and the owned Agent is released | cancellation observed; no receipt, agent released | 03 §4.1 03 §5 last row |
| LO10 | pass | the acknowledged seq/type/full-message hash read back through a fresh independent handle equals what the log holds; the receipt is never just the adapter succes… | exact message read back at seq=1802 through a fresh independent handle (1803 events) | 03 §5 row8 02 §3.1 |
| LO11 | pass | a Session whose title is already user-pinned needs no title write; seq is not assumed to change and the load still produces an exact receipt | no duplicate title append; suffix ["session/title","session/end-seed","user/message"]; receipt seq=222 | 03 §4.3 03 §5 row4 |
| LO12 | pass | an unregistered pending input arriving over the live Session during the append authorization blocks the acknowledgement and is preserved | load refused with "Load-only context failed and native cleanup could not be confirmed"; pending input preserved, no receipt | 03 §4.1 03 §4.3 03 §5 row5 |
| LO13 | pass | after closing the adapter, a new adapter instance with the persisted binding resumes the same native Session (no replacement Session) and still issues an exact … | restarted adapter resumed shiyu-replyer-7912c169-949d-4ec3-8953-a02415815701 without a replacement Session; prefix preserved; receipt seq=3 | 03 §5 row1/row8 03 §2 isolation-root |
| R01 | pass | a foreign append observed mid-read either rejects or is re-read into the final coherent cut | accepted only after re-reading the final cut: asOfSeq=600 eventCount=601 refs=0 | 03 §5 row3 03 §3 two passes |
| R02 | pass | a pending inbox insertion observed mid-read either rejects or is projected from the final coherent cut exactly once | accepted only after re-reading the final cut: asOfSeq=600 eventCount=601 refs=1 | 03 §5 row1/row3 |
| R03 | pass | a pending input removed mid-read is absent from the verified final projection (no resurrection) | accepted only after re-reading the final cut: asOfSeq=601 eventCount=602 refs=0 | 03 §5 row1/row3 |
| R04 | pass | a same-length rewrite of an already-observed early event must not yield a stale/mixed accepted projection | rejected observed change with NativeHistoryError: NativeHistoryError: Native history changed outside the trusted recovery suffix | 03 §5 row3 03 §3 |
| R05 | pass | an append after a first-pass EOF is never accepted as if the earlier cut were current | rejected observed change with NativeHistoryError: NativeHistoryError: Native history changed outside the trusted recovery suffix | 03 §5 row3 03 §3 EOF |
| R06 | pass | a write that lands while the projector runs must not be silently dropped from the accepted cut | rejected observed change with NativeHistoryError: NativeHistoryError: Native history changed outside the trusted recovery suffix | 03 §5 row3 |
| R07 | pass | a stored log that shrank below the observed prefix must reject, never return a silently shortened/mixed history | rejected with NativeHistoryError code=NATIVE_HISTORY_READ: NativeHistoryError: Native history read failed | 03 §5 row3 session-persistence monotonic read contract |
| R08 | pass | cooperative cancellation rejects with a diagnosable error, releases the handle and posts no acceptance receipt | rejected with NativeHistoryError code=NATIVE_HISTORY_CANCELLED: NativeHistoryError: Native history recovery was cancelled | 03 §5 last row 03 §4.1 |
| R09 | pass | an aborted caller signal rejects before any read/acceptance receipt | rejected with NativeHistoryError code=NATIVE_HISTORY_CANCELLED: NativeHistoryError: Native history recovery was cancelled | 03 §4.1 |
| R10 | pass | an exceeded recovery deadline rejects with a diagnosable error and releases the handle | rejected with NativeHistoryError code=NATIVE_HISTORY_DEADLINE: NativeHistoryError: Native history recovery exceeded its deadline | 03 §4.1 cancellation/deadline 03 §2 default 10s collaborative deadline |
| R11 | pass | a supplied absolute deadlineAtMs shortens recovery and rejects with a deadline error, releasing the handle | rejected with NativeHistoryError code=NATIVE_HISTORY_DEADLINE: NativeHistoryError: Native history recovery exceeded its deadline | 03 §4.1 native deadlines 03 §2 |
| R12 | pass | an absolute deadline in the past rejects without opening/using a native handle or accepting a projection | rejected with NativeHistoryError code=NATIVE_HISTORY_DEADLINE: NativeHistoryError: Native history recovery exceeded its deadline | 03 §4.1 |
| RP01 | pass | one exact owner message durably loaded, one bounded primary stream under maxTokens, observed usage, complete accounting | receipt seq=5, draft+assistant ref durable, 1 model call, usage reported, accounting complete | 03 §5 row8 03 §4.3 6.2 |
| RP02 | pass | 2500 persisted events are preserved; resume suffix + fixed title are bound; the exact new message and one generation extend the same Session | same Session shiyu-replyer-verify-reply-long-1: 2500 prefix events + suffix ["session/end-seed","session/title","agent/inbox/spliced","turn/start","agent/inbox/spliced","step/start","user/message","assistant/message","st… | 03 §4.2 03 §5 row8 6.6 |
| RP03 | pass | an unregistered native user input arriving during an authorization await blocks the stream/draft; no context receipt | reply refused with "Native context inputs do not match the registered owner input"; foreign event preserved; no receipt/draft | 03 §4.3 03 §5 row5 6.2 |
| RP04 | pass | an unregistered pending inbox input inserted while the binding callback awaits blocks loading/acknowledgement | reply refused with "Context-safe reply failed and native cleanup could not be confirmed"; no receipt or draft | 03 §4.3 03 §5 row4/row5 |
| RP05 | pass | maxTokens from the operation reaches the single native stream; no title/compaction model calls are counted | one bounded primary stream, reported usage, no title/compaction inference events | 03 §5 row8 NATIVE_SEAMS modelCalls |
| RP06 | pass | normal input reuses the native Session (no new Session), the first message/assistant remain history, and the second receipt/assistant are exact | one created + one resumed Session, both exact messages and assistant drafts retained | 03 §5 row1/row8 6.6 |
| RP07 | pass | unknown pending input blocks the reply before any model call; no receipt | reply refused with "Unknown native inbox input blocks context-safe continuation"; zero model calls | 03 §4.1 6.2 |
| RP08 | pass | a controller-declared obsolete pending input is removed by its exact id/hash, the removal events are re-read into the baseline, and the reply proceeds with an e… | one exact removal (seq=402) bound into the baseline; inbox empty; reply receipt seq=408 | 03 §4.3 03 §5 row4 NATIVE_SEAMS exact removal |
| RP09 | pass | only a controller declaration whose exact id+hash matches the durable input may remove it; a wrong hash blocks the reply and preserves the input | reply refused with "Unknown native inbox input blocks context-safe continuation"; pending input preserved | 03 §4.3 NATIVE_SEAMS exact removal |
| RP10 | pass | a new adapter instance + persisted binding resumes the same native Session, preserves history and produces a second exact receipt with one bounded generation | restarted adapter resumed shiyu-replyer-651c7129-72f8-4b15-8525-49059f26a765, preserved 9 durable events and generated one bounded reply | 03 §5 row1/row8 |
| S00 | pass | the public seam accepts a previous complete cut and returns appendedCount/appendedTypes for a continuity proof | snapshot seam reports appendedCount=0 appendedTypes=[] | 03 §4.2 03 §4.4 |
| S01 | pass | no new events → appendedCount=0, same asOfSeq/eventCount/digest/references | unchanged prefix proven (digest chain equal, appendedCount=0, 1 refs) | 03 §4.2 |
| S02 | pass | end-seed + interrupted closers + user-pinned fixed title are accepted, counted and reported by type; older cut keeps its digest | accepted 5 trusted suffix events ["session/end-seed","tool/result","step/end","turn/end","session/title"]; prefix digest preserved, baseline references unchanged | 03 §4.2 03 §5 row4 03 §3 native resume |
| S03 | pass | a foreign event appended between the pre-resume cut and resume must reject the continuity proof; it is never discarded as recovery noise | rejected with NativeHistoryError code=NATIVE_HISTORY_CHANGED: NativeHistoryError: Native history changed outside the trusted recovery suffix | 03 §4.2 03 §5 row4 03 §4.3 |
| S04 | pass | a foreign event appended between the pre-resume cut and resume must reject the continuity proof; it is never discarded as recovery noise | rejected with NativeHistoryError code=NATIVE_HISTORY_CHANGED: NativeHistoryError: Native history changed outside the trusted recovery suffix | 03 §4.2 03 §5 row4 03 §4.3 |
| S05 | pass | a foreign event appended between the pre-resume cut and resume must reject the continuity proof; it is never discarded as recovery noise | rejected with NativeHistoryError code=NATIVE_HISTORY_CHANGED: NativeHistoryError: Native history changed outside the trusted recovery suffix | 03 §4.2 03 §5 row4 03 §4.3 |
| S06 | pass | a foreign event appended between the pre-resume cut and resume must reject the continuity proof; it is never discarded as recovery noise | rejected with NativeHistoryError code=NATIVE_HISTORY_CHANGED: NativeHistoryError: Native history changed outside the trusted recovery suffix | 03 §4.2 03 §5 row4 03 §4.3 |
| S07 | pass | a same-length rewrite inside the previously observed prefix must fail the prefix digest, not just a count/tail comparison | rejected with NativeHistoryError code=NATIVE_HISTORY_CHANGED: NativeHistoryError: Native history changed outside the trusted recovery suffix | 03 §4.2 03 §3 |
| S08 | pass | a log shortened below the observed cut must fail (no silently shortened recovery) | rejected with NativeHistoryError code=NATIVE_HISTORY_CHANGED: NativeHistoryError: Native history changed outside the trusted recovery suffix | 03 §4.2 03 §3 |
| S09 | pass | a stale/tampered baseline must be refused when used as expectedPrefix | rejected with NativeHistoryError code=NATIVE_HISTORY_CHANGED: NativeHistoryError: Native history changed outside the trusted recovery suffix | 03 §4.2 |
| S10a | pass | a stale/tampered baseline must be refused when used as expectedPrefix | rejected with NativeHistoryError code=NATIVE_HISTORY_CHANGED: NativeHistoryError: Native history changed outside the trusted recovery suffix | 03 §4.2 |
| S10b | pass | a stale/tampered baseline must be refused when used as expectedPrefix | rejected with NativeHistoryError code=NATIVE_HISTORY_CHANGED: NativeHistoryError: Native history changed outside the trusted recovery suffix | 03 §4.2 |
| S10c | pass | a stale/tampered baseline must be refused when used as expectedPrefix | rejected with NativeHistoryError code=NATIVE_HISTORY_CHANGED: NativeHistoryError: Native history changed outside the trusted recovery suffix | 03 §4.2 |
| S10d | pass | a stale/tampered baseline must be refused when used as expectedPrefix | rejected with NativeHistoryError code=NATIVE_HISTORY_CHANGED: NativeHistoryError: Native history changed outside the trusted recovery suffix | 03 §4.2 |
| S11 | pass | a recovery suffix larger than the declared maxAppendedEvents rejects instead of accepting unbounded recovery writes | rejected with NativeHistoryError code=NATIVE_HISTORY_LIMIT: NativeHistoryError: Native cold projection history exceeds the safe read bound | 03 §4.2 03 §4.1 bounds |
| S12 | pass | hand-built positive/negative matrix: exactly the SDK resume closers/end-seed/fixed user title pass; user/assistant/inbox/automatic-title/compaction events fail | accepted 7 trusted events, refused 10 foreign/automatic events | 03 §3 native resume 03 §4.2 |
| S13 | pass | exact live object/id/header/preset/inherited/seq and the projected live inbox must all match; each mismatch rejects | matching live binding accepted; all 5 mismatched bindings rejected | 03 §4.2 03 §5 row5 |
| S14 | pass | a fixed-title/load-only style exact append is re-read at its exact seq, EOF confirmed, and the baseline extended; a stale, duplicated or inbox-splice append fai… | exact legitimate append extended the baseline; wrong validator, stale extra append and inbox splice all refused | 03 §4.3 03 §5 row5 |
| S15 | pass | flush is performed, exactly one maintenance phase runs, and live identity/inbox are bound; running/disabled hosts reject without success | one maintenance phase, 2 flushes, bound cut eventCount=140; running host and failed flush both rejected | 03 §4.2 03 §5 row5 |
| S16 | pass | a foreign user/message appended after the pre-resume baseline is refused by the post-flush observation, never acknowledged | rejected with NativeHistoryError code=NATIVE_HISTORY_CHANGED: NativeHistoryError: Native history changed outside the trusted recovery suffix | 03 §4.2 03 §4.3 |
| S17 | pass | after a trusted resume suffix on a long history, the same business Session id/preset and the whole projected inbox are preserved | same Session shiyu-verify-long-recovery, preset shiyu-runtime-replyer-v1, asOfSeq=2604, 2 inbox refs after trusted suffix | 03 §5 row1/row4 |
| S18 | pass | the array-shaped compatibility helper returns the same exact references as the snapshot and rejects malformed history the same way | compat helper returned 1 identical references and refused malformed history | 03 §4.4 interface freedom NATIVE_SEAMS compatibility helper |
| S19 | pass | an explicit caller policy (not the default trusted native suffix) is honoured and the appended count/types reflect exactly what it admitted | caller-controlled policy admitted exactly one user/message suffix event | 03 §4.2 public seam |

## 7. 未覆盖行为目标（分层留证，不是失败）

| 未覆盖行为目标 | 原因 | 需要的后续证据 |
| --- | --- | --- |
| 真实 DSH 宿主上的长历史冷恢复/恢复（真实 JSONL、projection、agent resume；零模型） | 本套件为合成原生替身+固定 SDK 静态契约层，不执行真实宿主 | Lead 冻结的 G3/V24 零模型重载/隔离根验证 |
| 真实模型生成、标题/压缩旁路、provider 内部重试与计费/缓存完整性 | 不调用模型或网络 | 有界真实模型批次与独立观测器；压缩单独评估 |
| 原生压缩/检查点之后的恢复 | H1 实现尚未接线压缩 | H1 后续切片（03 §2 明确为长期目标） |
| 跨进程或任意外部写者条件下的原子快照 | 固定 SDK 是 append-only 合同而非原子快照（03 §3 已声明边界） | 不承诺；按观察/使用边界留证 |
| 真实后端内存/IO 成本与资源上界、长期运行稳定性 | 替身不提供真实解码/存储成本 | 宿主性能与长期运行测试 |
| 真实频道、设备、备份与恢复（H2+、V21/V22/V26/V27） | 资源与授权范围之外 | 后续切片 |

**证据边界：** 本验证为离线合成替身 + 固定 SDK 静态契约层。它证明适配逻辑在合成原生语义下的行为；不替代上表真实宿主/模型/压缩/长期运行验收（03 §5 最后一行要求分层留证，不得互相冒充）。

## 8. 运行级证据

- 结构化逐例证据（JSONL，每进程一个文件）：`/Users/caja/Documents/识雨/plugins/shiyu/artifacts/dsh/verify/runs/2026-11-02T18-49-33-366Z-final-92c857f/raw`
- TAP 原始输出：`/Users/caja/Documents/识雨/plugins/shiyu/artifacts/dsh/verify/runs/2026-11-02T18-49-33-366Z-final-92c857f/tap.txt`
- 冻结清单：`/Users/caja/Documents/识雨/plugins/shiyu/artifacts/dsh/verify/runs/2026-11-02T18-49-33-366Z-final-92c857f/manifest.json`
- 本报告：`/Users/caja/Documents/识雨/plugins/shiyu/artifacts/dsh/verify/runs/2026-11-02T18-49-33-366Z-final-92c857f/results.md` 与 `/Users/caja/Documents/识雨/plugins/shiyu/artifacts/dsh/verify/runs/2026-11-02T18-49-33-366Z-final-92c857f/results.json`

**证据边界：** 本验证为离线合成替身 + 固定 SDK 静态契约层。它证明适配逻辑在合成原生语义下的行为；不替代真实宿主/模型/压缩/长对话验收（03 §5 最后一行要求分层留证，不得互相冒充）。
