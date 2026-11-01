# 模型与会话

[全景目录](<../../../目录.md>) · [证据与版本](<../../../../../research/2026-11-01-完整架构/宿主与依赖.md>) · [验证与验收](<../../../验证与验收.md>)

- 更新：2026-11-01（America/Caracas）；原图模块 ID：`model-session`。
- 状态：完整架构的建议基线，待验证；未安装、运行或接入。A 的插件内核心由用户选定，其余技术为本轮规划选择。

## 主方案

[本轮复用核查](<../../../../../research/2026-11-01-复用核查/宿主与依赖.md>)将实现收敛为直接依赖 DSH 公共 `dsh-agent`、Session、LLM 和 `llm-retry`，不复制 agent-loop。模型选择直接用 `agent.model.select({provider,model,...})` 的持久投影，输出上限用 `AgentOptions.maxTokens`；不新增独立模型切换状态机。新代码不使用已废弃的 `agent/request` 修改路由。需要低层流时调用 `ctx.llm.stream` 并直接用导出的 `BlockAssembler`，不重写流拼接；该低层路径是单次 attempt。

沿用 DSH Agent / Session 与原生模型适配，不引入第二套 Agent 框架。首阶段 core、worker、replyer 是三个逻辑角色配置，可以共用一个经过验证的模型部署；不要求三个模型常驻。主路由使用已有授权的 DSH DeepSeek adapter，具体 provider/model 从固定宿主的有效配置解析并写入验证清单；缺凭据时用确定性替身完成离线验证，不能为了启动自行申请账号或上传资料。

| 角色 | 会话与工具范围 | 输出 |
|---|---|---|
| core | 按 Goal / 决策周期绑定受限 Session；只读取领域投影与任务状态 | Proposal 或任务建议，不能从模型直接写库 |
| worker | 每 Assignment 独立绑定；只挂载该任务获准的工具 broker | Result、证据引用与可选 Proposal |
| replyer | 按 conversation/generation 绑定；默认无执行工具，仅允许裁剪视图读取 | ReplyDraft，发送由外层 outbox 承担 |

## 接口与生命周期

通过 `ctx.agents.create(options)` 创建，`setup(agentCtx,agent)` 在发布 Agent 和首次 prompt 前装载角色工具、Guard 与 pre-step；失败回滚创建。`resume(options)` 恢复时重新校验当前策略，不能继承已经撤销的工具。插件持有 AgentHandle 负责 dispose；普通投递使用 Agent 的带身份消息接口，业务完成以 Task/ReplyReceipt 为准，不以 `whenIdle()` 推定某条消息成功。

请求包括角色、任务或会话绑定、ReadView 版本、剩余预算、deadline 与 cancellation；结果包括 provider/model、Session/attempt ID、终止原因、token 用量与证据引用。Session 使用宿主持久化；需要记录已落盘保证时显式等待 `ctx.sessions.flush(session)`。会话压缩只作用于推理上下文，不删除业务权威状态。

## 预算、重试与降级

验证默认总模型并发 3，其中 1 槽预留显式对话；后台 core 自动评估与 worker 合计不超过 2，core 评估并发 1，worker Assignment 并发最多 2。限制取交集，不为六部分内层各开常驻模型。设备动作另受设备资源独占限制。

每次真实外发前，费用、调用次数、总时间和最大输出 token 四项限额必须齐全且可执行，否则只用替身，不发送请求。每次推理必须预扣预算，重试也计入；模型总期限由任务提供，默认交互 60 秒、后台 180 秒作为验证值，且不得超过上层 Mandate / Task 的剩余期限。达到期限发出 abort，丢弃未完成结构化输出；外部工具效果另按 Effect 账本核对。

复用 DSH `llm-retry`，将 provider policy 显式设为有限 normal 模式，最多 2 次重试；不使用 always。认证、权限和无效请求不盲重试。原生默认是 5 次重试，因此不能遗漏覆盖。应用层不再套一层完整循环，避免指数叠加。

`retryPolicy` 写在每个 provider 配置，`llm-retry` 自身 Config 是空对象；原生重试投影、可取消退避和会话事件直接复用。最多重试次数仍受角色单次评估与真实外发调用总限额收窄；识雨仅补预算扣减/预留和角色调度，不复制重试器。

主 provider 失败时先使用同一已授权路由的有限重试；只有清单预先允许且能力、数据外发范围等价的替代路由才切换。无替代则任务等待依赖，replyer 可用模板说明状态。已发生工具副作用的 turn 不整体重放；只在新的决策步骤继续核对。模型无法输出有效 Proposal 时按验证失败处理，不从文本猜测提交。

## 验证与切换条件

V13/V14 覆盖路由缺失、上下文泄漏、超时、取消、非法结构、重试计费与预算耗尽；模拟持续后台负载时对话预留槽仍能获得调度。V24 核查创建前 setup、Session恢复、模型切换与宿主重试日志。若 provider 不支持所需图像/工具形式，降级该能力或选已验证 adapter；不为一个 provider 自建 SDK。

## 证据

[Agent API](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/core.md>)、[Session durability](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/session.md>)、[模型 streaming](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/llm-streaming.md>)、[重试语义](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/llm/llm-retry/README.md>)。上述 API 已读；并发数、期限、角色映射与预算是本方案验证默认值，未宣称已达到性能指标。

