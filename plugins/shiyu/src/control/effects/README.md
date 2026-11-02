# 持久效果事实账本

这是识雨 `Effect / Attempt / Receipt` 的同步 SQLite 领域组件。由现有控制库 Worker 在同一数据库及 `SqliteTransactions` 中调用；不打开第二数据库服务，不运行队列，不直接调用设备、模型或网络。

`enqueue → claim → assertDispatch → complete` 是确定结果路径。`claim` 先持久化派发事实；dispatcher 必须在实际执行点再调用 `assertDispatch`，随后调用外部适配器。任何在途不确定由 `markUnknown` 或 `recover` 登记；不自动重放。`reconcile` 只接受同一个原始 claim 的独立核验回执。显式 `retry` 仅允许已注册为 idempotent 的效果，并受次数、期限、取消、当前授权及递增 fencing 约束。

授权与回执核验回调是可信 Worker 内的同步本地逻辑，不能由模型或外部 JSON 提供，也不能执行异步 I/O。数据库事务无法撤回一个已经发生的外部动作；租约到期和取消请求不证明动作已停止。资源作用域必须由可信策略规范化；此层只按规范身份相等判断互斥，不把任意文件路径字符串当访问控制。

`replayClass` 必须来自已验证能力契约，授权回调须核对动作、规范资源及该契约；不能相信模型自行声明“幂等”。dispatcher 对重试必须使用原 Effect 的稳定幂等键及参数摘要。`ReceiptVerdict.settledEffect` 必须是对该幂等身份**整体效果**的确定结论；一次重试请求失败、HTTP 失败或进程退出不构成此前未知效果也失败的证据。仅有单次尝试结果时返回 `settledEffect: null`，账本拒绝终结并保持待核对。旧 claim 不能覆盖新 claim；独立核对器以原幂等身份查询整体结果，再随当前 claim 提交核验。

`hasUncertaintyForTask(taskId)` 不受诊断列表条数截断，供 Task 投影使用：已记 unknown、安排了重试但原效果仍不确定时均返回 true；正常首个在途尝试本身不自动标为 unknown。读接口不派发、不登记回执。当前只有模块级合成验证，尚无外部动作的恰好一次保证。

本组件实现跨模块契约规定、上游尚缺少的持久 Effect 事实与 unknown 边界，不替代 Superagent 的 Effects 队列或 Outbox。参考依据为工作区 `research/2026-11-01-复用核查/任务执行.md` 和 `架构与设计/A方案全景/跨模块契约.md`，上游固定提交为 `deepseek-ai/dsh-superagent-prototype@6337fc823ce20251c8de8085948165c81aaa701e`。本目录未复制上游源码；未来队列适配必须另带完整来源及补丁记录。当前未接入 Runtime、真实设备、渠道或 DSH worker，模块合成测试不代表这些能力已经实现。
