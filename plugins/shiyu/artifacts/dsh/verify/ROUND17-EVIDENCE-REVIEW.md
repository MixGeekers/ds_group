# round-17 证据独立复核（task-71，完成）

- 最终身份：X=`6f6268d`、X+1=`4110d35`、host=`928c8f1`；关键切片 `fc9daae..520e305`（P0 memory）、`cce6deb`（workspace）、`e860ac8`（emotion）、`fa9e880`（stream/v7）、`bcb252f`（H7-round17）、`6f6268d`（R17-CORR）。
- 只读复核 commit blob/evidence/`.local` 日志/只读 DB/Session；未改他人文件、未 git 提交。
- 结论：**P0 memory gate/host round-trip、workspace、emotion、stream/v7 边界真实；H7 未升级；X+1 符合约定。** F17-R1/R2 为 minor evidence metadata；R3/R4 info。

## 0. P0 memory gate / 宿主 embedding round-trip — 通过

- 语义：`semantic_search` 仅在 embeddingVerified + profile 兼容 + 索引非空时声明；unverified 时 exact_read only；显式 index/search 允许但不提前 semanticReady；成功后 semanticReady。
- 宿主 h2d：ok=true、steps5、index/search embedding 各1、semanticHit、exact body、postWithdraw `MEMORY_READ_FORBIDDEN`；readiness before exact_read/EMBEDDING_UNVERIFIED → after exact_read+semantic_search/embeddingVerified/semanticReady（reason `INDEX_COVERAGE_INCOMPLETE`；coverage stale）；+10 commitSeq；无 generation model。
- h2d host 声明 2 个 synthetic withdrawn 操作；host round17 新增 1、累计 3（joint sideEffects 明示）；**F17-R1**：h2d `statusFinal` bytes 64889 vs actual **68173**（sha `4ac9e162…` 匹配）。
- **未执行**真实单用户多轮聊天记忆闭环；h2d chat 文件明确 hostKit 待执行；不得宣称聊天记忆通过。

## 1. 可写共享工作区 — 通过（未接 Runtime/TaskRunner）

- 文件硬链接镜像；原地写传播到 canonical；新文件受控 publish；删除默认 task-link-only，共享删除需 ownerDecision；锁/冲突 unknown（index 不推进/mirror 保留）/manifest tamper/回滚/跨设备/符号链接/外部 hardlink/allowlist 安全边界。
- 15 tests、11 scenario cases 全 pass、隔离 1715/1715；`runtimeWired=false`（未接 Runtime/TaskRunner）；同文件系统/单写者假设。
- **F17-R2**：evidence 自引用 `sliceFileHashes` 的 self sha `671a7378…` vs actual HEAD `a50e0bb1…`/10205（其余 4 文件匹配）；建议刷新 self hash 或排除 self-entry。

## 2. 情绪延续 — 通过（只读/隔离）

- h4f evidence 1727/1727；host receipt 4139B/sha `091024b6…`；7 steps、**15/15 checks**、zeroModel/Embedding/TaskEffect、liveDataTouched=false、cleanup（`diagnostics.cleanup.storeClosed/workerTerminated`）、released/disposed。
- emotion.context/memoryDimension 只读；受众/撤回/降级/版本/decay；无 set_emotion/pulse；Ombre 仅 valence/arousal 元数据、`ombreMetadataWritten=false`；**明确不宣称主观体验/长期人格**。

## 3. stream/v7 — 通过（未执行第七次）

- `fa9e880`/v7 evidence：bounded provider-stream failure classification（empty stream/transport/unknown/abort/timeout/auth/request-shape）、Goal Session summary、no body/path、no auto retry；v7 exact-only；realModelExecuted=false、hostReloads=0、goalCreated=false；第七次未授权。

## 4. 宿主 round17 — 仅零模型探针

- 1次 ordered reload 556→563/events66→67/cap67→69；probes 563→573 **+10 commitSeq only**（memory command/index/withdraw/availability）；sessions40/goals8/events/state 不变；emotion in-memory；无 Task/Effect；sideEffects syntheticMemories3（累计，1 added）。

## 5. H7-round17 / X+1 — 通过

- H7 92 sources/368 files；product 79/79 not_covered；gate incomplete；round16 v6 失败等级不升级；archived3 real；新 round17 P0/emotion/workspace/v7 尚未映射（下一轮），无 product/V25 升级。
- X+1 `4110d35`：11 artifacts、code diff0、manifest head=6f6268d/dirty=false/leaks0、aggregates 417/7,764,548/`b676a3c2…`；clean **1764/1764**（`d34a82f5…`/185715）；pipeline `44cbda5c…`/3637；archive `57e4f6cd…`/839；selfproof 22/182；92/92 sources/368 files、0 unknown；产品 79/79；gate incomplete/executed=passed=0；11 artifact SHA/bytes 已记录。

## 6. findings/边界

- **F17-R1**（minor-bytes）：h2d host statusFinal bytes 64889 vs actual 68173
- **F17-R2**（minor-self-hash）：workspace evidence self-hash stale
- **F17-R3**（info-counts）：Memory synthetic ops total3 (2 prior +1 this round), stale4; task disclosure 2→3
- **F17-R4**（info-scope）：Round-17 P0/emotion/workspace/v7 not yet mapped into H7; no product/V25 upgrade

- 未执行：真实 multi-turn chat memory、workspace Runtime/TaskRunner、v7 host、live emotion/subjective；P0/emotion/workspace 不得升级到 V25/业务/九系统。
- 产品 79/79 not_covered；H7 无 unknown/升级；host 仅 +10 commitSeq 的 memory 探针；无真实聊天记忆通过。
