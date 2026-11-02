# Ombre 公共 API 薄适配边界

实施范围（2026-11-02）：`index.ts` 实现注入式 MCP 调用边界。合成契约测试之后，已由产品私有 stdio 客户端在独立空 vault 对固定原版服务完成一次 readI 探针，进程关闭已核对；正式 Runtime 记忆业务仍未连接。本模块不拥有 Python 依赖、daemon、记忆正文数据库、第二套检索、自动 fallback 或模型调用。

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
