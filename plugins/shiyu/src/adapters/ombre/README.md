# Ombre 公共 API 薄适配边界

历史薄适配范围（2026-11-02）：`index.ts` 实现注入式 MCP 调用边界。合成契约测试之后，已由产品私有 stdio 客户端在独立空 vault 对固定原版服务完成一次 readI 探针，进程关闭已核对。以下原版公共 API 说明只适用于 `index.ts`；后续 Runtime 受控普通记忆与 3F 语义协议使用独立的 `controlled.ts` / `managed.ts`，见文末，不沿用原版工具能力声明。

上游为 [P0luz/Ombre-Brain](https://github.com/P0luz/Ombre-Brain/tree/115d831d979bf67efc7150f976e2cb34c333c935)，固定 3.6.14 / `115d831d979bf67efc7150f976e2cb34c333c935`，MIT（Copyright 2026 P0lar1zzZ）。本实现按公共参数契约独立编写，没有复制上游算法代码。[本轮核查与来源摘录](../../../../../research/2026-11-02-Ombre接入/目录.md)保留许可和具体行号。

## 接入方式

受信 host 用 `new OmbrePublicApiAdapter(transport, binding, options?)` 构造。`transport.callTool({name,arguments})` 对接现有 MCP 客户端；认证、连接、deadline、取消属于该客户端，必须关闭自动重试。适配器不拥有该连接，因而不擅自 close。固定宿主没有公开 raw MCP service；已核实并实现 [私有 stdio 客户端](../mcp/README.md)，复用公开 client2.2.0。未修改 Runtime 接线，DSH 内 peer 实际装载仍未实测。

`binding` 绑定 backendId、vaultScope、deploymentEvidenceRef、固定版本/提交，以及已关闭 You/Them 和允许原生生命周期副作用的受信配置。它不构成在线版本证明，也不执行部署验证。真实启用前，host 必须用安装清单与配置读回验证这些断言；模型正文不得创建 binding。构造器只检查声明符合此版边界。

方法：

| 方法 | 公共工具 | 边界 |
|---|---|---|
| `search({scope,query,maxTokens?,maxResults?,domain?})` | `breath_advanced` | 固定 `mode=automatic, with_ids=true`，默认 4,000 tokens / 10 条，上限 10,000 / 50；domain 只是主题筛选 |
| `readFeel({scope,query,maxTokens?})` | `feel` | 显式按主题取回感受；不能称为自动受众裁剪 |
| `readI({scope,limit?})` | `I` | 固定 `read=true`，清空所有写/晋升参数；默认 20 条，上限 50 |

调用者必须是已完成授权判断的 core。scope 相等只是路由约束，不能认证 actor。官方隔离单位是独立 instance/vault，并无每次调用 namespace ACL。一个含多个私密受众的共享 vault 不能凭 domain、tag 或结果 ID 变成安全 ReadView；在该能力补齐前，不得将本适配器直接给 replyer 使用。

所有结果均为 `unverified-backend-text`：保留原文、不自动采纳 I 为信念。`with_ids` 解析只生成未可信引用提示；重复/损坏 marker 不生成 IDs，单个格式正确 marker 仍不能证明真实性、写入成功或 CAS。`reportsBackendError=false` 不证明工具语义成功。响应只接受 MCP 文本块，默认总上限 256 KiB，超限报错而不截断假装完整。

## 禁止误读的能力

- `automaticWrites/nativeIdempotency/atomicCompareAndSwap/perRequestNamespace/deletionProof` 当前均为 false。
- 搜索命中不再 `touch()`，但外层仍记录工具事件、启动 decay、展示/消耗删除通知；“读取接口”不表示整个调用零写入。底层 embedding 也可能访问配置的 provider，真实接线需单独完成模型/外发预算约束。
- `hold` 可自动合并、打标并启动 plan/重复检查任务。`dream` 写见证记录。`I` 支持候选/晋升。三者不在此调用端口开放。
- 上游 `trace(delete=true)` 是归档；`hard_delete` 仅允许创建时标明可清理的测试桶。没有在本轮证明普通记忆及原文、索引、导出副本的完整清除闭环。
- MCP 返回成功不等于保存成功：上游将多数运行异常格式化为 `isError=false` 的普通文本。MemoryOperationLedger 必须要求独立可信回执；不能把正文 hash、搜索相似或 schema-valid ID 当作后端 CAS/操作证明。

验证命令：`node --import tsx --test tests/ombre.test.ts`，本轮 9/9；fake transport 只验证参数、范围、结果处理和失败不重试，不构成真实后端或宿主验收。

同日实际接线另见[stdio-run.json](../../../../../测试/2026-11-02-Ombre服务验证/artifacts/stdio-run.json)：一轮 connect/listTools、一次 readI、关闭自有 PID 成功；只有空库读取，不证明 MemoryOperation 回执、普通写入或 DSH 宿主业务集成。

## 3E / 3F 受控协议与进程边界

[controlled.ts](controlled.ts) 的普通记忆端口为 `create`、`operationStatus`、`verifyApplied`，使用三个 `shiyu_memory_*` 私有工具。3E 保存/精确读/重载/本地撤回的限定证据见本体实施记录；普通撤回不表示物理清除。3F 新增 `backendStatus`、`ensureIndex`、`indexStatus`、`searchCandidates`，精确 wire 类型及校验在 [semantic-memory.ts](../../contracts/semantic-memory.ts)。适配器定向验证使用合成 transport 及真实 SDK/Python 跨语言 fixture；后续主任务另完成真实 Harrier 和限定 DSH 路径，见[本体实施记录](<../../../实施记录.md>)，不把替身结果混作模型验收。

[managed.ts](managed.ts) 保留 descriptor `schemaVersion:1` 的精确八字段和 `embedding:"disabled"`，继续只接受原三个工具。`schemaVersion:2` 使用相同顶层字段，但 `embedding` 必须严格为 `{mode:"managed-harrier",profileId:"harrier-oss-v1-0.6b-q8_0-1024-ombre-head2000-v1",serverBinary,modelArtifact}`；两个文件路径由受信本机安装配置指定，不能加入 endpoint、key、环境或任意服务脚本。v2 精确接受七个工具，不能静默降级或接受额外通用上游工具。

配置读取、构造和 `status()` 不启动进程、不发请求。显式 `open()` 先启动并核验自有 [ManagedHarrier](../embedding/managed.ts)，再把它返回的回环 endpoint 与短期 key-file 路径传给固定 Python 服务 `--semantic-api`；私有 MCP 连接后核对工具集合、3E 部署绑定及独立 backend status。关闭先等待 Ombre 子进程退出，再关闭它的 embedding provider。不会重连或重放未确认操作。descriptor 版本、语义 wire v2、原生 installation/body-receipt v1 是不同版本边界，旧 vault 绑定不能随 wire 改写。

运行状态分别表示：

- `storageReady`：私有 MCP 与正文部署绑定当前可用。
- `semantic.profileCompatible`：纯读 backend status 已核对固定 Python Harrier profile；它不能证明推理成功。
- `semantic.embeddingVerified`：本次管理实例中，新的一次成功 query embedding 实际发生了 HTTP 调用。启动 health、空候选、query 缓存命中、index 成功、历史 index receipt 均不将它置真。provider 退出后立即为 false。
- `semantic.state`：`disabled / unavailable / unverified / ready`。schema2 初次启动为 unverified，但允许显式、有授权和预算的 index/search；不能用 `embeddingVerified=false` 阻断首次验证。
- `indexBaselineId/indexWatermark`：最后观察的服务端持久索引身份与水位；`recordedIndexedCount` 仅在同一次 backend status 中记录，后续索引/查询观察后标 null。它们不证明全部授权来源已覆盖，检索仍核对本次 `coverage`。

正文保存回执保持原结构；索引是独立操作。`ensureIndex` 的成功响应不能代替后续独立 `indexStatus`。index receipt 同时绑定原正文回执、native 文件指纹、profile、content/meaning 的内容摘要与实际 float32 向量摘要。`MemoryIndexObservation.embeddingCalls` / receipt 中调用量表示该持久索引操作的历史实际用量；重复 ensure 或 status 不代表本次 RPC 再次调用模型。`MemorySearchResult.embeddingCalls` 才表示本次查询调用量，空集合和缓存命中为 0。组合服务必须按操作去重结算，不按读取回执次数累加。

候选查询不返回正文；调用者在排名前提供当前授权的有限引用集，并在精确读取及整批交付前重新核验资格。输入/输出严格校验 profile、水位、覆盖率、候选集合、分数及请求摘要。index/search 共用入队时固定的绝对 deadline；过期命令仍可通过只读 `indexStatus` 核对历史结果。错误、取消和不完整索引不会被解释为空的成功结果，不自动回填或调用其他后端。

本片定向验证：17 项 managed、11 项 semantic contract、5 项原正文 contract，以及 [semantic-memory-stdio.test.ts](../../../tests/semantic-memory-stdio.test.ts) 的 1 项真实 TypeScript SDK ↔ Python 服务测试通过。跨语言测试复用已有 Python `Fixture` 返回固定向量，真实私有 MCP/原生 Markdown/SQLite，临时 vault 中一条普通正文创建不触发 embedding HTTP；一次 index 实际调用 fixture 一次，独立 status 和重复 index 不增加请求；缺索引/空集合为零次，查询一次、缓存命中零次。总计 2 次固定向量 HTTP 请求，key 与路径核对通过，两个自有 Python 子进程均退出，临时 vault 删除。测试在固定本地依赖缺失时显式 skip，不安装依赖；这不是 Harrier 检索质量或 DSH 宿主验收。
