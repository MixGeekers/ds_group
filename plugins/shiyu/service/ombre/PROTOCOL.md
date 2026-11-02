# 识雨受控 Ombre stdio 协议 v1

固定上游 3.6.14 / `115d831d979bf67efc7150f976e2cb34c333c935`。本服务组合原生 BucketManager、Markdown、桶锁、派生索引；不导入 server，不启动 You/Them、decay、dream、dehydrator、GitHub、tunnel、hook、dashboard 或上游工具注册。默认只注册以下三个 MCP 工具。显式 `--semantic-api` 才增加文末四个语义工具；它不改变 v1 正文命令、保存回执或 installation binding。更新、删除、迁移、自主整理尚不支持。

## 命令与摘要

`shiyu_memory_create({command, commandDigest, body})`：

```json
{"schemaVersion":1,"kind":"create","operationId":"operation-1","backendId":"ombre-local","scope":"local-owner","targetRef":"target-1","bodyDigest":"<sha256 UTF8 body>","bodyBytes":12,"sourceRefs":[{"sourceId":"source-1","revision":1}]}
```

`command` 只允许上述精确字段。所有 ID 满足 `^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$`，operationId 另限 150 字符。sourceRefs 长度 1..32，sourceId 唯一且 ASCII 升序，revision 为 1..9007199254740991 整数（bool 不算）。body 为有效 Unicode，无孤立 surrogate，UTF8 长度 1..16384；要求原生清洗及 frontmatter 往返都不改变正文，服务拒绝而不偷偷 trim。bodyDigest/commandDigest 为小写 hex64。

commandDigest = SHA256(递归按 ASCII 键排序、无空白、UTF8 编码的 JSON)。Python `json.dumps(command, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)`，与 TS 同规则一致。正文独立参数，不进入 journal 或控制库。

## 统一字段与状态响应

`shiyu_memory_operation_status({operationId,scope})` 与 create 返回同一布局：

```json
{
  "schemaVersion":1,"backendId":"ombre-local","deploymentId":"deployment-1","scope":"local-owner",
  "operationId":"operation-1","state":"applied",
  "command":{},"commandDigest":"<hex64>","plannedNativeId":"shiyu_<hex32>",
  "nativeId":"shiyu_<hex32>","receipt":{},"reason":null
}
```

state 为 `absent | unknown | applied | rejected`。absent 的 command、commandDigest、plannedNativeId、nativeId、receipt 为 null。unknown 表示持久 intent 已存在，副作用尚不能证明；绝不表示可以重发。rejected 只用于已确认在任何原生创建前拒绝的 planned-ID 冲突。unknown/rejected 的 nativeId 与 receipt 为 null；plannedNativeId 保留。applied 的 receipt 精确字段为：

```json
{
  "schemaVersion":1,"receiptId":"receipt_<hex64>","operationId":"operation-1",
  "backendId":"ombre-local","deploymentId":"deployment-1","scope":"local-owner",
  "commandDigest":"<hex64>","nativeId":"shiyu_<hex32>","bodyDigest":"<hex64>","bodyBytes":12,
  "sourceRefs":[{"sourceId":"source-1","revision":1}],
  "componentVersion":"sha256:<native Markdown file hex64>","outcome":"applied",
  "bodyDurable":true,"indexState":"unknown","observedAt":"<UTC ISO8601>","reconciled":false
}
```

componentVersion 是当时原生文件内容指纹，**不是原生版本号或 CAS**。indexState 为 `disabled | unknown`：未装 embedding 时 disabled，启用时保守 unknown，不能用正文成功声称已索引。receipt 是历史观察；status 对 applied 会重新读取原生文件，发现缺失/内容/归属/文件指纹变化则返回 unknown、reason=`NATIVE_MISMATCH`、receipt=null，不改写历史 journal。status 不写或 ack；启动恢复仅补全 unknown 的证明，不重发 create。

## 独立精确读取

`shiyu_memory_get({nativeId,scope})`：

```json
{
  "schemaVersion":1,"backendId":"ombre-local","deploymentId":"deployment-1","scope":"local-owner",
  "state":"found","nativeId":"shiyu_<hex32>","command":{},"commandDigest":"<hex64>",
  "receipt":{},"body":"exact native content","bodyDigest":"<hex64>",
  "componentVersion":"sha256:<hex64>","reason":null
}
```

state 为 `found | not_found | mismatch`。只有属于该 deployment journal 的 applied ID 且重新读取核对通过才 found；不存在的 journal ID 返回 not_found，绝不退回语义搜索或任意 vault 读取。其余返回 mismatch。非 found 时 body/bodyDigest/componentVersion/receipt=null，command/commandDigest 可保留对应已知命令；reason 给固定错误码，不泄露路径/正文。

## 持久关联和恢复

受信启动参数绑定 backendId、scope、deploymentId 与独占数据根。这些字段只是路由/部署约束，授权来自调用方受信控制域，不接受 AI 正文授予能力。vault 进程锁排除本服务的并发实例；已有数据/数据库缺 metadata 或绑定不符立即失败，不自动认成新安装。

SQLite FULL journal 只记录命令 metadata、正文 hash/长度、预定随机 native ID、状态、回执，不存第二份正文。先持久 unknown intent，然后原生 create 普通 dynamic 桶，`test_data=false`、固定 `source_tool=shiyu_strict_create` 和 `grow_batch_id=commandDigest` 在同一次 Markdown 发布中关联命令。窄 BucketManager 子类只在 create 上下文阻止候选换号；保留原生桶锁、原子 no-overwrite 发布、路径索引、原生 embedding/outbox。

返回成功前 native get_including_archive 独立核对 ID、metadata.id、归属标记、正文 hash/长度、普通 dynamic/非 terminal 状态，然后 fsync 实际文件及父目录，再登记 applied。异常/取消/半截文件均保留 unknown。启动只按已记录 planned ID 重新核对，成功可补 receipt（reconciled=true），没找到仍 unknown；从不调用 create 补写。重复 operationId 必须同一 commandDigest/command，否则冲突；同命令只返回已存/实观测状态，绝不重发。

这里的 durability 指正常 OS/fsync 语义；不承诺恶意本机文件篡改、磁盘故障、未受控旧 Ombre 进程或硬件掉电绝对安全。独占根只能由本部署使用，不能同时交给上游完整服务。

## 显式语义 API（3F）

必须同时配置 `--semantic-api --embedding-endpoint http://127.0.0.1:<port>/v1/embeddings`。受信 launcher 可另传 `--embedding-key-file <absolute-path>`：常规文件、不可为 symlink/FIFO、仅 owner 可访问、1–256 个可见 ASCII 字符，可末尾一个换行。key 只进入固定回环端点的 Bearer header，不读取环境，也不进入 profile、摘要、状态和日志。默认三工具仍原样存在；语义模式精确七工具。正文 create 仅向原生 outbox 登记派生任务，不做 inline embedding，也不启动 outbox worker。普通 GET、operation status、index status、backend status 均不推理、不补索引、不迁移。

所有新增响应包含 `schemaVersion:2,backendId,deploymentId,scope`，以下用 B 表示这四个字段。索引指纹固定为 `d3aa5e3e6aecf3cc147ea1f1c04ffad2fcfcb206271364f284f0d432fbc1111b`；head-2000 Unicode codepoints 后添加 query 指令，与 TS 整段输入 profile 分开。

`shiyu_memory_backend_status({scope})` 返回：

```text
{B,semanticApi:true,profileFingerprint,indexBaselineId,indexWatermark,
 recordedIndexedCount,embeddingConfigured:true,
 limits:{maxEligibleRefs:128,maxScannedRows:2048,maxResults:10,
         maxEmbeddingCallsPerIndex:2,maxDeadlineMs:60000}}
```

这里 `embeddingConfigured` 表示明确配置了客户端，不是 provider 健康证明；`recordedIndexedCount` 是历史索引登记数量，不替代实时证明。独立 `.shiyu/semantic.sqlite3` 保存索引 intent/receipt，不存正文；其随机 `index_<hex32>` baseline 另在原 operations SQLite 的新 `semantic_installation` 表绑定，不改原 installation 行。已有 marker、数据库或元数据缺失即失败关闭，不能通过状态 GET 补建新基线。每个成功的新索引 intent 让 watermark 加一；同一 intent 重入保留原回执。

`shiyu_memory_index_ensure({command,commandDigest})` 的精确 command：

```text
{schemaVersion:1,kind:"ensure-index",indexOperationId,memoryOperationId,bodyReceiptId,
 backendId,deploymentId,scope,nativeId,componentVersion,bodyDigest,profileFingerprint,
 indexBaselineId,expectedIndexWatermark,deadlineAtMs,maxEmbeddingCalls:2}
```

`commandDigest` 沿用正文命令的 canonical JSON SHA256。command 绑定当前原正文 receipt、实际文件指纹、正文摘要、profile 与基线/水位；只接受单条明确目标，不接收正文或任意 provider 参数。先持久 unknown intent，调用原生 content 和最新 meaning 索引方法（至多各一次），复核原生文件与两个向量列，fsync 后在独立事务中发布索引回执。无 meaning 时明确核对列为空；不能把 outbox pending、行数或 content 成功当作 meaning 成功。重复或 unknown intent 不自动重发；崩溃后也不把残留向量自动认成 applied。

`shiyu_memory_index_status({indexOperationId,scope})` 和 ensure 返回同一布局：

```text
{B,indexOperationId,state:"absent"|"unknown"|"applied",command:null|IndexCommand,
 commandDigest:null|hex64,receipt:null|IndexReceipt,reason:null|FIXED_CODE,
 currentIndexBaselineId,currentIndexWatermark,embeddingCalls:null|0..2,usageComplete:boolean}
```

absent 的 command/digest/receipt/reason/calls 全为 null、usageComplete=false。unknown 无 receipt；进程中断导致无法完整计数时 calls=null、usageComplete=false。已记录 applied 但原文件或向量证明不符时，status 返回 unknown/INDEX_PROOF_MISMATCH，保留历史记录，不修复。回执精确布局：

```text
{B,receiptId:"index_receipt_<hex64>",indexOperationId,memoryOperationId,bodyReceiptId,
 commandDigest,nativeId,componentVersion,bodyDigest,profileFingerprint,indexBaselineId,indexWatermark,
 content:{digest:hex64,vectorHash:hex64,dimensions:1024},
 meaning:{state:"absent"|"indexed",digest:null|hex64,vectorHash:null|hex64,dimensions:null|1024},
 embeddingCalls:0..2,observedAt:ISO8601}
```

vectorHash 是原生 SQLite float32 BLOB 的 SHA256；两个向量均独立检查 1024 维、有限、非零、L2。meaning 为 absent 时后三字段全 null。HTTP 尝试数由本地客户端实际请求开始处计数，缓存命中不计；不是 tokens 或模型费用。成功的新 intent 即使命中缓存、零 HTTP 调用，仍登记新回执并推进 watermark。正文历史 indexState 不回填。

`shiyu_memory_search_candidates` 精确参数：

```text
{scope,query,limit,eligibleRefs,profileFingerprint,
 expectedIndexBaselineId,expectedIndexWatermark,deadlineAtMs}
eligibleRefs = [{memoryOperationId,bodyReceiptId,nativeId,componentVersion,bodyDigest}]
```

query 有效 UTF8、非空、最多 8192 字节；limit 1–10；eligibleRefs 最多 128，nativeId 唯一且 ASCII 升序。原生向量表最多 2048 行，新建第 2049 行在派发前拒绝。query/index 的绝对 `deadlineAtMs` 最多未来 60 秒，计时包含 mutex 排队；同步证明/排名后也检查截止时间。provider 错误明确报错，不退回 BM25/模糊搜索。

```text
{B,state:"ok"|"index_required",profileFingerprint,indexBaselineId,indexWatermark,
 queryDigest,embeddingCalls:0|1,usageComplete:true,
 coverage:{eligibleCount,indexedCount,missingCount},
 matches:[{memoryOperationId,nativeId,componentVersion,bodyDigest,indexReceiptId,indexWatermark,score}]}
```

任何 eligible 项缺少当前独立索引证明时，返回 index_required、空 matches、零模型调用；空 allowlist 为 ok 空结果、零调用。使用原生 `search_similar_strict`，在排名前传入 allowed IDs，保留原生 content/meaning max-score 规则。模型等待后再核对命中证明；仅返回引用与分数，无正文、无自动 reindex、无 BM25 懒构建。score 是相似度，不是真实性或权限证明。

此服务不知道控制域撤回状态。eligibleRefs 必须由受信宿主从当前控制域资格生成；宿主在异步检索/精确回读后、交付正文或加载对话前仍须重核来源、受众、授权和删除水位。原生索引尚存不代表允许读取，也不代表完成物理清除。
