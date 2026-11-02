# 同步任务领域适配

`TaskFacade` 实际调用固定版本 Superagent 的 `Engine.receive → evaluateDue → decide → Assignment → report`，没有另建 Agent 循环或 Goal 状态机。`upstream/` 是 13 文件运行时闭包；完整 MIT 许可、上游与本地 SHA256、机械 import 变化、语义补丁保存在该目录的 `LICENSE`、`SOURCE_MANIFEST.json` 与 `LOCAL_PATCHES.diff`。

## DB Worker 接缝

构造参数见 `index.ts` 的 `TaskFacadeOptions`，公共 DTO、核验及恢复证据见 `types.ts`。`repo` 使用上游 `Repositories` 协议；`records` 为同一数据库和同一事务所有者中的 `TaskRecordStore { get, save, list }`。`SQLiteTaskRepositories.records` 已实现此接缝。整合时传入 `effects: effectLedger`，其 `hasUncertaintyForTask` 会在投影、执行回执、派发和核验/恢复/取消确认时核对权威未知效果，避免元数据标记遗漏。Facade 在外层事务内调用 Engine，Engine 自身会嵌套 `atomic`，存储适配器必须正确支持嵌套事务。

`Assessor.request/release`、`Executor.start/deliver/stop` 和 `Outbox.send/withdraw` 只登记同事务内的持久意图；提交后才由调度器执行。构造时拒绝 async 端口，调用返回 thenable 时使事务失败。同步接口不使网络或模型调用安全：实际适配器仍必须只做本地入账。测试用内存仓储仅从 vendor 加载，生产文件没有导入 MemoryRepositories。

主链路：

1. `receive(trigger)` 校验重复 ID 的原始内容，再进入 Engine 入箱和输入归属。
2. `evaluateDue()` 创建评估；`candidate(triggerId)` 取得待决事实；`decide(triggerId, outcome, admission)` 创建 Ticket 与 TaskRecord。`TaskAdmission` 必须给定请求身份、授权版本和完成检查。相同请求身份、相同内容返回原 Decision；不同内容拒绝。
3. 派发器读取 `get(taskId).activeAssignmentId`；启动确认调用 `assignmentStarted(taskId, assignmentId)`。输入投递/读取与 `report` 都核对当前实例身份。
4. `report(..., {state: 'ready', summary, result: {resultHash, artifactRefs, effectRefs}})` 让上游结束编排，对外保持 `waiting/completion_verification`。
5. `verifyCompletion(taskId)` 调用注入的同步 `CompletionVerifier.verify(context)`，对事务前已获取的证据进行核对。报告必须完整绑定 Task、Assignment、completionSpec 版本和 resultHash，每个检查恰有一项结果；必要证据缺失、旧报告或缺少 verifier 均不能成功。

只有检查全部通过且有证据引用才投影 `succeeded`。明确终止失败由 verifier 的 `failureDisposition: 'terminal'` 给出。`inconclusive` 或未宣告终止的检查失败继续等待补充证据及重新核验；本切片不提供“结束 Ticket 后重新执行修复”的重试接口，也不接受未实现的 `retryable` 核验标记。确认终止后需要重新执行时，以新 Task 的 `supersedesTaskId` 关联前序。worker 自身 `failed/blocked` 报告尚未结束 Ticket 时，`retry(taskId)` 保留上游的受控新 Assignment 能力。

## 终态、未知效果及取消

Facade 固定关闭上游 ended-ticket continuation。普通追问不再进入已结束 Ticket 的 fanout，而是进入新评估；显式 attach、延后时钟唤醒同样不能复活终态。策略开关缺省时保持上游行为，原始 vendor 文件未修改。

`markUnknown` 或不带核对证明的 `recover` 持久记录不确定性，只允许登记受限停止意图；后续启动、报告、投递、重试及完成核验被挡住。实例重建后此标记仍来自数据库。带 `RecoveryProof` 的恢复由受信恢复协调器调用，证明旧执行停止、效果已知并引用证据；Facade 再复核当前策略。原执行未结束时必定新建 Assignment，保留 `lastRecovery` 证据；旧 Assignment 的迟到报告被拒。已有 ready 结果只回到待核验，不自动重跑。

`requestCancel` 持久化停止请求，但不声称停止或效果已撤销；原状态为 unknown 时仍保持 unknown。`confirmCancelled` 需要当前实例、停止/效果证据，以及 `pendingIntentsInvalidated: true`，才置 cancelled。

这些是 DB Worker 内部领域方法，不是模型工具。调用方仍负责认证、Mandate 有效性、installationGeneration / hostEpoch / fencingToken / lease 比较和 EffectLedger 当前未知事实；端口与命令层必须在同一事务内复核对应事实。`RecoveryProof` 和 verifier 不能由 worker 模型自填，证据采集不在数据库事务中运行。

## 本轮验证

`node --import tsx --test tests/tasks.test.ts`：13 个测试通过，包含实际引擎链路、核验证据绑定、终态追问、unknown 与迟到回执、权威效果未知状态、证明恢复换新实例、取消、幂等冲突、内存和真实 SQLite 的共同回滚、异步端口拒绝，以及上游默认 continuation / settled recovery 兼容性。整包 `tsc --noEmit` 通过。此结果是领域与仓储合成验证，不代表真实模型、设备或整个识雨本体验收。
