# 模型与会话

[全景目录](<../../../目录.md>) · [运行仪表盘与 Session 复用](<../../../../运行仪表盘与Session复用.md>) · [证据与版本](<../../../../../research/2026-11-01-完整架构/宿主与依赖.md>) · [验证与验收](<../../../验证与验收.md>)

- 更新：2026-11-01（America/Caracas）；原图模块 ID：`model-session`。
- 状态：2026-11-01 用户明确要求“尽量复用 dsh session”；原生 Session 作为三角色默认路线。以下接入细节待验证，识雨本体未实现、未装载。

## 用户确认的复用方向

core、worker、replyer 优先复用 DSH 原生 Agent / Session 的生命周期、持久历史、恢复、上下文投影和压缩。识雨只增加角色绑定、当前授权、业务视图与执行/发送回执，不另建第二套会话日志、压缩器或推理循环。原先 replyer 默认局部复制 DS-Bot 旁路问答的安排改为条件备选；只有固定宿主上的原生路线经验证不能满足只读隔离等必要边界时，才评估该备选并记录原因。

## 主方案

[既有复用核查](<../../../../../research/2026-11-01-复用核查/宿主与依赖.md>)提供 DSH 公共 `dsh-agent`、Session、LLM 和 `llm-retry` 的接口依据，不复制 agent-loop。模型选择直接用 `agent.model.select({provider,model,...})` 的持久投影，输出上限用 `AgentOptions.maxTokens`；不新增独立模型切换状态机。新代码不使用已废弃的 `agent/request` 修改路由。仅在有明确原生适配缺口时才采用 `ctx.llm.stream` 与导出的 `BlockAssembler`；低层流为单次 attempt，不能误当作自带历史、恢复与压缩的 Session。

沿用 DSH Agent / Session 与原生模型适配，不引入第二套 Agent 框架。首阶段 core、worker、replyer 是三个逻辑角色配置，可以共用一个经过验证的模型部署；不要求三个模型常驻。用户已指定优先使用 DSH 中配置的 `opencode-go / deepseek-v4.1-flash`，有效模型与 effort 由宿主配置解析并记入验证清单，不另建凭据入口或把旧的原生 DeepSeek adapter 参考写成当前固定路由；缺凭据时用确定性替身完成离线验证。

| 角色 | 会话与工具范围 | 输出 |
|---|---|---|
| core | 持续 Goal 绑定一个专用受限 Session，连续决策周期复用；非 Goal 事项按同一业务及授权范围绑定 | Proposal 或任务建议，不能从模型直接写库 |
| worker | 每 Assignment 独立绑定；工具循环与合法传输重试复用原 Session，只挂载该任务获准的工具 broker | Result、证据引用与可选 Proposal |
| replyer | 按稳定 conversation 与受众/授权作用域绑定受限原生 Session，连续聊天追加；默认 tools=[] | ReplyDraft，发送由外层 outbox 承担 |

`conversationGeneration` 只附在本轮请求与草稿上，用于打断和迟到结果失效；不作为 Session 创建键，不因每条新消息轮换 provider 会话标识。跨受众或权限范围不能为了缓存合并历史。新 Assignment 以核验过的交接材料创建受限执行会话，不因前一次有缓存而继承旧执行资格。

## 接口与生命周期

通过 `ctx.agents.create(options)` 创建，`setup(agentCtx,agent)` 在发布 Agent 和首次 prompt 前装载角色工具、Guard 与 pre-step；失败回滚创建。`resume(options)` 恢复时重新校验当前策略，不能继承已经撤销的工具。插件持有 AgentHandle 负责 dispose；普通投递使用 Agent 的带身份消息接口，业务完成以 Task/ReplyReceipt 为准，不以 `whenIdle()` 推定某条消息成功。

请求包括角色、任务或会话绑定、ReadView 版本、剩余预算、deadline 与 cancellation；结果包括 provider/model、Session/attempt ID、终止原因、token 用量与证据引用。Session 使用宿主持久化；需要记录已落盘保证时显式等待 `ctx.sessions.flush(session)`。控制库只保留关联及业务状态，不复制原生历史成为第二权威日志。会话压缩只作用于推理上下文，不删除业务权威状态。

原生 Session 的创建、恢复和首轮请求前都要完成角色准入、上下文裁剪与工具隔离验证。replyer 的无工具约束须覆盖继承工具、自注册工具和实际执行入口；原生能力复用不等于默认继承宿主所有权限。模型日志中的 assistant 输出与平台已送达消息分别记录，取消、过时或发送 unknown 的草稿不能投影成用户已经看到的回复。

## 上下文与缓存复用

业务 ConversationKey、DSH Session、模型可见上下文和 provider 前缀缓存分别管理。稳定 Session 标识用于请求路由，实际缓存取决于发送内容和提供方行为；不承诺命中率或缓存保存期限，也不以缓存代替合法上下文的完整传递。

1. **稳定前缀。** 角色规则、工具 schema 与排序、稳定 Profile 和当前阶段摘要保持确定表示；发生真实规则或能力变化时再更新。时间、预算、当前状态、随机 viewId 和新检索材料通过宿主动态 context 追加到后部，不逐轮重写 system section。
2. **连续追加。** 使用同一 Session 的有效历史、完整工具往返和本轮新输入。合法传输重试不重复追加用户消息；普通新消息不清空 Session。effort 按工作阶段调整，不为不同 effort 维护重复业务历史，其缓存影响单独测量。
3. **原生压缩。** 优先使用 DSH compaction，在同一 Session 内更新模型可见投影并保留原事件引用；持续 Goal 的原生 Session 身份保持不变。摘要保留目标、约束、未解决问题、已核验结果和来源，作为可重建投影而非自动写入长期记忆。压缩阈值服从角色输入预算及输出预留，不直接采用模型标称最大窗口。
4. **强失效。** 删除、撤权、受众缩小或污染材料进入上下文时，在下一次模型请求前重新裁剪/重建有效投影，允许缓存失效；不能仅追加“忽略旧内容”后继续发送。原生日志的保留和清除仍遵守来源政策。
5. **可观测而不重复存储。** 从宿主实际事件和 usage 生成 Session 状态、上下文估计、最近压缩与缓存读取量的运行视图。缺失用量字段标未知，不能填零；仪表盘读取不会唤醒模型或触发压缩。

摘要生成属于额外模型调用，计入统一预算、并发和用量。具体摘要模型与 effort 在固定宿主的配置接缝核对，不假设它自动继承上一轮选择；不为控制摘要模型而重写压缩引擎。

## 预算、重试与降级

验证默认总模型并发 3，其中 1 槽预留显式对话；后台 core 自动评估与 worker 合计不超过 2，core 评估并发 1，worker Assignment 并发最多 2。限制取交集，不为六部分内层各开常驻模型。设备动作另受设备资源独占限制。

每次真实外发前，费用、调用次数、总时间和最大输出 token 四项限额必须齐全且可执行，否则只用替身，不发送请求。每次推理必须预扣预算，重试也计入；模型总期限由任务提供，默认交互 60 秒、后台 180 秒作为验证值，且不得超过上层 Mandate / Task 的剩余期限。达到期限发出 abort，丢弃未完成结构化输出；外部工具效果另按 Effect 账本核对。

复用 DSH `llm-retry`，将 provider policy 显式设为有限 normal 模式，最多 2 次重试；不使用 always。认证、权限和无效请求不盲重试。原生默认是 5 次重试，因此不能遗漏覆盖。应用层不再套一层完整循环，避免指数叠加。

`retryPolicy` 写在每个 provider 配置，`llm-retry` 自身 Config 是空对象；原生重试投影、可取消退避和会话事件直接复用。最多重试次数仍受角色单次评估与真实外发调用总限额收窄；识雨仅补预算扣减/预留和角色调度，不复制重试器。

主 provider 失败时先使用同一已授权路由的有限重试；只有清单预先允许且能力、数据外发范围等价的替代路由才切换。无替代则任务等待依赖，replyer 可用模板说明状态。已发生工具副作用的 turn 不整体重放；只在新的决策步骤继续核对。模型无法输出有效 Proposal 时按验证失败处理，不从文本猜测提交。

## 验证与切换条件

V13/V14 覆盖路由缺失、上下文泄漏、超时、取消、非法结构、重试计费与预算耗尽；模拟持续后台负载时对话预留槽仍能获得调度。V24 核查创建前 setup、Session恢复、模型切换与宿主重试日志。若 provider 不支持所需图像/工具形式，降级该能力或选已验证 adapter；不为一个 provider 自建 SDK。

V04/V05/V24 增加原生 replyer 的创建/恢复前隔离、连续输入不换 Session、旧草稿不混入已送达历史、压缩后 Goal 绑定不变、删除/撤权后旧正文不再外发。缓存验证比较连续多轮、压缩前后、宿主恢复和 effort 切换的实际缓存读取量、未缓存输入及首 token 延迟，同时检查任务质量；本次仅更新设计，没有新增模型或缓存实测。

## 证据

[Agent API](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/core.md>)、[Session durability](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/session.md>)、[模型 streaming](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/llm-streaming.md>)、[重试语义](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/llm/llm-retry/README.md>)。上述 API 已读；并发数、期限、角色映射与预算是本方案验证默认值，未宣称已达到性能指标。

