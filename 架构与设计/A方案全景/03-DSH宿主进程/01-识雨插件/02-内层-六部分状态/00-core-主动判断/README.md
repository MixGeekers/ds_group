# core · 主动判断与受控提交方案

[所属区域](<../README.md>) · [跨模块契约](<../../../../跨模块契约.md>) · [全景目录](<../../../../目录.md>)

- 更新：2026-11-01（America/Caracas）。模块 ID：`core`。
- 设计状态：DSH 插件内核心已选；下述为本轮建议基线及合成验证参数。
- 实现状态：未实现、未运行模型或业务实验。

## 1. 目标、非目标与技术基线

core 把持续目标、当前状态、外部事件和真实运行健康组织成可解释的判断，输出受限任务或内部变更提案，并控制其合法提交。它不靠无限自我对话维持“主动”，不把人格 / 情绪当成授权，也不把自己写代码改策略当成普通故障恢复。

### 路由、判断、派工与表达

core 负责选择“是否行动、做什么、如何处理内部改变”，不是所有消息必须经过的转发层。IngressService / ConversationService 做确定性认证、去重、会话路由与队列控制；core 仅在需要语义取舍时调用判断模型。CoreCommitService 的程序校验、CAS 或写回执本身不消耗一次 core 推理。

会话路由使用稳定 `ConversationKey = connectionId + platformConversationId + threadId? + 会话类型 / 受众范围`。connectionId 是识雨登录连接配置身份，重连不变；内部 conversationId 映射到该键，不以临时连接进程或运行实例创建另一条队列。core 沿用入口认证的关联，不根据文本或重连后的句柄重新推断受众。

普通聊天、已知 Task 状态和健康查询可以直接走 `对话队列 → ViewService → replyer → dialogue Effect`，不强制创建 Goal / Task / Assignment。行动请求、持续目标、持久状态变更、任务归属歧义才进入 core 判断；明确已认证的停止 / 撤权控制命令走程序通道，不等长模型调用。replyer 对自由文本给出的 `needs_core` 只能建议移交原输入，不含任务、权限或执行命令；程序沿用原 eventId，记录 routeAttempt / correlation 并去重，不能把移交包装成新入站事件反复循环。

派工链为 `core 任务意图 → PolicyGate / TaskService(Superagent Engine) → Task受理 → 有效Assignment / WorkOrder → worker → ResultVerifier / 回执`。core 决定工作内容与能力需求；TaskEngine 程序根据预算、资源、依赖与当前权限安排执行资格。worker 不直接抢用户队列或宣布 Task.succeeded；已核验状态通过事件和只读视图回到对话队列，只有后续行动或内部变更才再次请 core 判断。完整场景、并发和字段边界见[Core派工与对话时序](<../../../../Core派工与对话时序.md>)。

直接使用 DSH ctx.agents.create/resume 与 AgentHandle 生命周期、Session 和工具服务；TaskService 局部复用 Superagent Engine 的输入、决策和 Assignment 状态机，不再重写同类逻辑。CoreCoordinator 只接识雨持续目标、准入、预算和领域 Proposal。控制账本事务复用 Superagent Store / SQLite；边界校验采用成熟 Schema 校验器。优先验证 Ombre 记忆后端，六域同 SQLite 仅作对照，不是硬约束。

DSH Agent.followup 负责排入正常轮次，cancel / whenIdle / runMaintenance 负责取消、静止观测及空闲维护；不调用具体 agent-loop 内部实现，也不新造模型轮询循环。followup 返回不代表任务完成，whenIdle 也不是逐消息成功回执；完成仍查任务账本。AgentHandle.dispose 负责停止 / 排空与释放 scope，setup 只注册本角色能力。Superagent 的终态自动唤醒、恢复重放与授权复核需要任务专题列出的定点适配，不能照搬默认全权限会话。

## 2. 持续目标和触发条件

持续目标直接复用 `ctx.goals`：一个目标使用一个专用 DSH Session，以 `create(agent,{objective,maxGoalRounds})` 建立，`get(agent)` 取得 detached GoalView；后续 edit / pause / resume / complete / block / clear 使用精确 GoalRef `{id,revision}` CAS 变更。唯一生命周期为 DSH 的 active / paused / blocked / complete；取消或到期先记控制原因、disarm，再按明确清理策略 clear，不另造重复状态机。控制账本仅保存 `goalId↔sessionId`、owner / scope / completionCriteria / priority / budget / reviewAt / expiresAt 及 Mandate 关联。普通单轮对话不创建持续目标，多个目标用多个 Session 映射。

DSH Goal 只存状态、不调度；先接服务，不自动附带 goal 工具或默认 continuation driver。create 会 armed，但任何后续轮次仍通过识雨准入，maxGoalRounds 只限制轮数，费用、时间、主动节流由识雨补充。Session 恢复 / fork 后 active 默认 disarmed，必须经过当前授权和恢复流程才可 resume；模型不能自行解除用户暂停。取消在途轮次另调用 Agent.cancel，不能以 goal.pause 冒充实际停止。Mandate 独立记录资源、接收方、数据外发和期限，目标正文不自动扩大授权。

| 输入 | 判断入口 | 允许推进的范围 |
|---|---|---|
| 用户明确请求或控制命令 | 经来源认证的 EventEnvelope，关联既有目标或提出新目标 | 程序建立 / 修订权限依据后才执行；用户暂停、取消优先于普通输入 |
| 已授权目标的复查时刻 | Goal.reviewAt 与中心时钟生成稳定到期事件 | 只在原目标 / Mandate 内检查，终态目标不能自动重开 |
| 文件、设备等环境变化 | 获准订阅的观察事件 | 先核对目标相关性、时效与来源；不能自行扩大订阅或自动记忆所有内容 |
| 任务完成、失败或 unknown | 已核验的任务 / 效果回执 | 决定跟进、结束、核对或受限补偿；回执不是新的授权 |
| 健康变化 | HealthService 的带时间探测 | 已知恢复动作按恢复策略处理；模型只在需要语义诊断且预算允许时介入 |

自主推进无触发原因、无有效目标、权限已失效或预算不足时不调用模型；显式用户请求按自身范围和准入处理，不因其他目标暂停就禁止正常聊天或新请求。必要的周期扫描只查到期记录和健康，不制造“想点什么做”的空任务。多个来源指向同一目标时先合并事件身份和原因，防止相同机会多次接单。

## 3. 判断与提交的接口

| 接口 / 对象 | 输入与输出 | 所有者与保证 |
|---|---|---|
| `evaluate(eventIds, goalId?, context)` | 已持久事件和经认证上下文 → DecisionRecord / Proposal / defer | CoreCoordinator；调用模型前做程序准入，模型在事务外 |
| `Proposal` | proposalId、schemaVersion、actor、role、sourceRefs、baseStateVersion、readSet、policyVersion、idempotencyKey、commands、expiresAt | 角色由调用上下文核实；模型不能自报特权；worker 附当前执行世代与 fence |
| `readSet` | aggregateType、aggregateId、expectedVersion；集合谓词还需 collectionVersion 或唯一约束 | 每个受影响规则声明依赖；不接受只提供“当前 stateVersion”就覆盖全部状态 |
| `commit(proposal, authenticatedContext)` | Proposal → CommitReceipt committed / rejected / conflict | CoreCommitService 统一领域准入；同库原子提交，跨组件按独立回执核对；不提供任意 SQL / JSON patch |
| `CommitReceipt` | proposalId、commitSeq、stateVersion、changedAggregates、effectIds、reasonCode、retryClass | 相同提案重送回原回执；同 idempotencyKey 不同内容摘要拒绝 |
| `IntakeReceipt` | accepted / duplicate / rejected | 只证明入箱；不能作为 CommitReceipt 或任务成功证明 |

TaskService 通过 Superagent Engine 端口复用 Task / Assignment 迁移，六域由各服务或既有组件拥有规则。core 组织“该做什么”，CoreCommitService 是统一逻辑准入与控制账本事务入口，不能让模型绕过任务或领域接口直接修改数据。任务已完成但内部 Proposal 被拒绝时，分别展示“外部工作成功”和“内部未采纳”。

## 4. 一次主动循环

1. **受理与去重。** 读取持久 inbox 中尚未处理的触发；保留来源与 correlationId，不在模型上下文内推测已处理标记。
2. **确定性准入。** 检查全局暂停、目标终态、Mandate、时效、冷却、订阅范围和剩余预算。无权限则形成拒绝或候选建议；主动跨会话通知还需明确通知许可。
3. **明确一致性范围。** 控制库短读事务生成本地快照；Ombre 等组件单独读取，记录各自可取得版本和 freshness。不能以控制 commitSeq 声称外部组件已经同步，未证实的跨组件依赖暂缓。
4. **预算预留与推理。** 在预算账本中预留最坏允许调用额度，使用 DSH Session 调模型。指令和外部证据分开，模型只可输出注册命令的 Proposal 或结构化 defer / no_action，不提供内部写工具。
5. **程序核验。** 校验 Schema、大小、actor / role、命令白名单、来源可访问性、授权、暂停、期限、预算、hostEpoch / fence 和 readSet；由相关领域规则检查语义不变量。
6. **本地事务与组件结果。** 控制写事务内复核权限 / 本地版本，一起写本地状态、预算、事件归属、回执和 outbox；外部组件写入通过受控适配在事务外执行。其成功、失败或 unknown 单独记录，不能把控制提交误报为领域写入完成。
7. **提交后推进。** 唤醒 dispatcher、刷新视图失效状态、更新下一复查时间。执行、内部提交和发送各自回执；未知外部效果进入核对，不作为可盲重试失败。

DecisionRecord 保存触发引用、所用视图 / 策略版本、结构化理由和拒绝码，不保存模型的私有推理过程。能够解释“依据什么推进或不推进”，不要求对模型思维逐字留档。

## 5. 一致性和冲突

`commitSeq` 每次控制账本事务递增；`stateVersion` 表达已发布的内层组合投影变化。外部记忆组件版本与 freshness 独立，不能拿这两个数代替 Ombre CAS。只有组件实际提供的实体 / 集合版本才能充当对应 CAS 前提。无关任务回执增加 commitSeq 时，不应让针对未变化记忆的提案必然失败。

跨服务记忆写入使用根 v1.1 契约 `MemoryOperation`：approved → dispatching → applied / unknown / rejected。approved 只是控制入账，applied 须核对后端效果与来源；不能把本地 CommitReceipt 混当记忆后端已完成证明。

同一聚合并发更新只允许符合 expectedVersion 的一次成功。仅同库提案可保证记忆和关系同成同败。跨组件命令先记录意图，再记录组件结果及确认状态；尚无可验证 CAS / 幂等能力时串行限制本识雨写入，遇超时先核对，无法排除其他写者时降低为建议或停止自动写入，不宣称串行适配创造了组件原子性。涉及“没有同类任务”“身份集合没有冲突”等不存在性判断，必须在事务中用集合版本、唯一约束或等价谓词检查保护，避免两份提案各自成立而联合破坏约束。

冲突返回 VERSION_CONFLICT / after_refresh；重新读取再生成新 proposalId，保留同一业务关联。禁止自动覆盖、由冲突错误触发无限模型重试、在事务中等待模型。重复 proposalId / 幂等键且内容摘要相同只返回原回执，不递增版本或重复写 outbox。撤权与删除在提交前再次核对，不能只依赖推理开始时的快照。

## 6. 主动性、资源与静默的验证参数

以下用于合成验证；真实预算、模型、通知时段须在激活配置中明确。本轮没有配置真实运行限额。

| 参数 | 验证默认值 | 语义 |
|---|---|---|
| 全局模型并发 | 3；后台合计最多 2 | core 自动评估与 worker 共用后台配额，为显式对话保留 1；不是每角色各 3 |
| core 评估并发 | 1 | 判断可串行，数据库短事务独立；不会在模型等待期间锁住查询 |
| 一次主动评估 / 认知回顾模型调用 | 最多 2 次，格式修复共享第二次 | 六域不各自再开预算循环；额外分析成为独立授权任务并计入总账本 |
| worker Assignment 并发 | 2 | 由 TaskService 管理，仍受模型总配额与每设备独占资源约束 |
| 同目标事件合并 | 1 秒 | 合并触发原因，保留各 eventId；暂停 / 取消控制事件不等待该窗口 |
| 目标周期扫描 | 60 秒，纯程序 | 检查已到期目标，不意味着每分钟调模型 |
| 单目标自动评估 | 最多 4 次 / 小时，间隔至少 15 分钟 | 显式用户任务不受主动冷却，但仍受授权、并发与预算；重复健康信号按事件类抑制 |
| 冲突后自动重评 | 最多 2 次 | 每次重新取视图及预算；之后转 waiting，等待新事件或控制入口 |
| Proposal 大小与批量 | 64 KiB；commands ≤ 32，readSet ≤ 256 | 大对象只传受控引用，超限在模型输出进入事务前拒绝 |
| Proposal 有效期 | 120 秒 | 合成场景；真实上限不超过 Goal / Mandate / Assignment 的最早到期时间 |
| ReadView / 健康样本有效期 | 30 秒 / 60 秒 | 到期标 stale 或 unavailable；不能把旧健康值当当前事实 |
| 真实模型调用准入 | 缺费用、时间、调用次数或最大输出限额则拒绝外发 | 账本检查 spent + reserved ≤ limit；成本未知不得默认为零 |
| 主动跨会话通知 | 未配置通知许可或静默时段规则时，聚合到下次用户交互 | 不假定用户作息；合成用 22:00–08:00 America/Caracas 测试静默边界 |

显式暂停立即持久化并增加相关策略版本：阻断新评估 / 派发，取消未开始的调用，向在途任务请求停止。已发送外部动作只能核对或补偿，不能宣称已撤回。静默仅延后非紧急主动表达，不私自停止已授权任务；“紧急”类别也必须由明确策略列出，不能由模型任意跳过静默。

## 7. 自知、故障和数据生命周期

core 通过 ViewService 读取空间使用、可用能力、任务 unknown、模型依赖及最后恢复结果；每条健康数据含实际探测来源和时间。配置声明、当前可达、已验证有效分开。模型自述不能修改探测状态。

| 失败 | 处置 |
|---|---|
| 模型超时 / 不合法输出 | 释放或结算预留额度，记录结构错误；最多一次格式修复共享本次最多 2 次调用的第二次名额，计入原预算，仍失败则 defer，不执行部分命令 |
| SQLite busy / 短暂竞争 | 有界退避后重试未开始提交；事务状态不明时先按 proposalId 查询原回执，不能另造提案重复动作 |
| 磁盘不足 / 数据版本不兼容 | 停止新写入与派发，保留已有可验证读取；进入恢复流程，不删权威记忆腾空间 |
| 权限撤销 / 暂停 / 期限届满 | 拒绝新提交与派发，已发生效果进入核对；不可通过新任务身份绕过 |
| 宿主退出 | 核心暂停；重启生成新 hostEpoch，拒绝旧回调。备份恢复使用新 installationGeneration 并进入 quarantine |
| 恢复材料缺失 | 按缺失项保持恢复锁；缺最新删除 / 撤权控制记录时，仅开放不含业务正文的诊断与人工恢复入口，阻断 ReadView、模型上下文与对外业务读取；不猜测补齐事实 |

事件正文、决策元数据、模型会话日志、权威状态和执行证据按各自政策保留。Proposal 和 DecisionRecord 引用来源，避免再复制一份完整敏感正文。删除传播到派生视图与未发送内容；预算和最小操作审计保留去内容化关联，具体期限服从预留空间方案。

## 8. 验证与备选门槛

- V01：未知 schemaVersion / 命令、伪造 role、来源越界、超限载荷在迁移前拒绝；DSH 工具子集适配前后拒绝语义一致。
- V06：100 个提案竞争同一 aggregateVersion 恰有 1 个提交；无关聚合可以分别提交；同 id 重放回同回执。同库失败零部分更新；跨组件失败或超时保留真实分步状态，未确认依赖不得派发；集合并发不得破坏唯一性。推理期间撤权 / 删除导致提交拒绝。
- V04：视图读取与 replyer 请求不能触发六域写入；独立后端维护造成的版本变化按来源单独核对，不能通过查询学习副作用绕过。
- V09：能力已声明但过期或不可用时不派发，模型“我已经能做”不改变有效状态。
- V23：24 小时合成时钟中，无有效目标且无显式请求时自动模型调用为 0；同目标重复事件遵守限额；暂停重启仍暂停；静默通知不外发但已授权任务可继续；恢复后每个任务和效果有可追溯结果。普通问答不必调用 core，任务进行中可查询进度；同事件移交只产生一次任务归属，不能因 needs_core 回送而无限评估。

只有现有基线在固定合成负载下证明无法满足延迟 / 恢复要求，才评估扩大模型并发、引入成熟工作流引擎或抽离独立核心。更换推理模型应保持 Proposal 和权限契约不变；未通过格式与授权测试的模型只能返回建议文本，不能参与自动提交。

## 9. 复用验收与证据

补充 V01 / V06 / V23：对 DSH create / resume / setup 失败 / dispose 做资源释放验证；whenIdle 后仍须核对任务账本；同目标事件经 Superagent receive / decide 只产生一次归属。原自研通用循环与任务状态机方案已由 DSH 公共接口和 Superagent 局部复用替换；识雨保留目标、预算、静默、暂停、领域授权及跨组件可见性这些产品规则。固定来源、许可、闭包和回退见[本轮复用核查](<../../../../../../research/2026-11-01-复用核查/核心与视图.md>)。


[核心与视图来源核查](<../../../../../../research/2026-11-01-完整架构/核心与视图.md>)记录 DSH、DSH-Superagent、SQLite 与 Ajv 的一手资料和静态证据。本文的调度、参数、角色分工与验收门槛是设计建议；未开展运行、费用或性能实测。
