# 阶段 3E 受控 Ombre 真实链路验证计划

冻结时间：2026-11-02。本计划在首次执行脚本前写入；该脚本不纳入默认 `tests/*.test.ts`，必须显式执行。目标是验证产品的受控保存链路，不能据此宣布正式记忆系统、语义检索或完整恢复已验收。

## 范围与固定依赖

- 入口：`node --import tsx tests/ombre-live-smoke.ts`。
- 使用包内现有 `.local/ombre/.venv/bin/python` 与 `.local/ombre/upstream/Ombre-Brain-115d831d979bf67efc7150f976e2cb34c333c935`；不下载、安装或改上游。
- 使用真实 ControlStore Worker、MemoryDomain、LocalMemoryService、ManagedOmbreBackend、私有 MCP SDK 和固定 `service.py`。模型/Session/Agent 端口不构造；`embedding: disabled` / `--without-embedding`。
- 每次执行只在包内新建 `.local/phase3e-memory-<随机后缀>/`，其中保存独立 control.sqlite、backend.json 和唯一 vault。明确禁止使用 `.local/runtime/` 或当前 DSH 库。运行数据继续由 Git 忽略。
- 一项 session-less 本地 Task 只提供关联元信息，不 claim/派发 worker。对话通过现有 `ensureLocalTask` 建立。
- 数据为一段固定合成普通记忆；不使用业务资料、账号、凭据或现有会话正文。

## 步骤与调用边界

1. 加载独立 descriptor 并显式 open 第一台自有子进程；检查三工具与只读 absent 身份探针。
2. 显式 `remember` 一次，预期产生 **一个** `shiyu_memory_create`，由独立 operation_status/get 核对后在控制账本确认 applied/Effect 成功/1 effect 结算；输入、输出、模型调用预算均为 0。
3. 再读一次，正文 SHA256/长度与合成输入一致。重复同 requestId、conversationId 和内容，预期 duplicate 元回执，MCP 调用数不增加。
4. 有序关闭服务、MCP 子进程和 ControlStore；确认只关闭本次 owned PID 且退出已观察。使用相同安装、backend/deployment 和原库，换一个 hostEpoch，启动第二台子进程；精确读取同 native ID/receipt/正文，不再 create。
5. 在控制域 `withdrawLocal` 一次，预期 consent withdrawn、引用不再可读；LocalMemoryService.read 拒绝且不再调用后端。**这是本地撤回，不是物理删除**；只读文件核验确认唯一原生 Markdown 仍存在且字节未变。
6. 枚举本次 control SQLite 的全部普通表内容，并扫描仅本次 DB/WAL/SHM 字节，确认合成正文不在控制库；正文在唯一原生 Markdown。核对后端 journal 的命令记录没有正文副本。
7. 第二次有序关闭并确认 owned PID 已退出。保留隔离合成 vault、控制库和脱敏 trace 作为本地复核材料，不启动常驻服务。

最多两个显式 managed.open（含两个只读身份探针）、一个 create；其余 status/get 只为独立验证与读取，实际数量逐项记录。每个业务操作最长 30 秒，open 使用当前受控超时，脚本总时间上限 120 秒。失败即停止，不自动重试写操作；报告已观察结果与未知项。若发现产品模块缺陷，先报告主代理，不修改冻结模块或覆盖失败证据。

## 独立证据与报告

脚本包装真实私有 transport 只记录 MCP 工具名、次数、阶段、受控进程 PID/退出观察及状态，不记录工具参数或正文。报告公开 artifact 只保存合成身份、摘要/长度、回执/版本、实际检查结果、调用计数、源码哈希与边界；机器绝对路径和原生正文仅留 ignored 运行目录。记录 `indexState=disabled`、未接模型/embedding 的构造与 CLI 证据，不把它扩大为全机器网络流量观察。

预期证据等级：本轮真实本地 Python/Ombre/MCP/ControlStore 业务链路；不是 DSH 插件 UI 验证，不是模型测试，不是硬崩溃或跨故障域恢复，且未验证物理删除/索引删除/正式语义检索。
