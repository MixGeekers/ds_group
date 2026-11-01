# DSH-Superagent

> 2026-11-01 复用核查修订：选择 core 13 文件任务引擎、Store 事务/仓储所需片段、Effects、Outbox/receipts、WorkerSlots/background 的**局部源码复用作为验证基线**；TaskService 改为适配门面，不再重复实现任务引擎。未知效果、取消、终态唤醒及事务失败需要明确补丁，不构成拒用整个实现的理由。本轮未复制进入产品、未安装或运行，候选仍为已初评。精确依赖、MIT 声明、补丁和维护方案见[复用核查](<../research/2026-11-01-复用核查/任务执行.md>)，该记录优先于本文早期“仅参考”的建议。

[返回技术候选目录](<目录.md>) · [内外双工与角色边界](<../架构与设计/内外双工与角色边界.md>)

## 基本信息

| 项目 | 内容 |
|---|---|
| 类型 | 开源研究原型；面向单个 GitHub 仓库的主动式编码任务编排，基于 DeepSeek Harness（DSH） |
| 方向 | 事件接入、任务授权、worker 生命周期、异步消息与恢复、并发调度 |
| 来源 | 用户提供的 [dsh-superagent-prototype](<https://github.com/deepseek-ai/dsh-superagent-prototype>) |
| 审阅快照 | main · [6337fc823ce20251c8de8085948165c81aaa701e](<https://github.com/deepseek-ai/dsh-superagent-prototype/commit/6337fc823ce20251c8de8085948165c81aaa701e>)；提交时间 2026-10-31T12:05:39Z |
| 版本与许可 | package.json 为 0.1.0、private；MIT。未逐依赖审查许可 |
| 收录 / 更新 | 2026-10-31 / 2026-11-01（America/Caracas） |
| 候选状态 | **已初评**；本轮建议将明确代码闭包作为局部复用验证基线，未接入产品或通过验证 |
| 证据层级 | 一手资料、限定源码与测试断言静态核查；**未安装、未运行、未复现实验** |
| 识雨实施状态 | 未接入；不代表识雨运行系统已实现 |
| 证据索引 | [来源与核查范围](<../research/2026-10-31-dsh-superagent/来源与核查范围.md>) |

## 核心判断

**可直接复用任务领域与持久队列的具体实现，优先于再造 TaskService 状态引擎。** 其 core 的 13 文件运行闭包只额外依赖 node:crypto；宿主、Policy、Repositories、Executor 和 Outbox 通过端口适配。任务、执行实例与对外回执已有可检查的实现；识雨补充机器授权、fencing、结果核验和未知副作用处理。

来源将它定位为研究原型，明确不是正式 DeepSeek 产品；公开版本经过调整，不等于内部版本或相关文章描述的全部设计，部分设计尚未实现。它主要服务 GitHub 编码工作，可选接入飞书，不是识雨六部分内层的现成实现。[README](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/README.md#L1-L11>)

对比参考位置、角色组合与数据流的建议，见[边界专题第 8 节](<../架构与设计/内外双工与角色边界.md#8-2026-10-31-候选带来的补充草案>)。这些建议不改变用户已确定的外层只读要求。

## 机制与证据

### 1. 授权、工单、执行实例是三个不同对象

**已静态核查：**接入事件 Trigger 经接收范围和 Policy gate 判断，进入 Eval；接受后创建 Mandate（依据、来源身份、范围、策略版本）、Ticket（工作事项）和 Assignment（一次执行绑定）。显式请求可走主会话路由；推断类候选还需要评估流程和启用规则，不能简单因为模型认为有用就接下。

任务恢复可以保留 Ticket 与原 Mandate，换一个 Assignment 继续执行。它因此可以区分“同一件事重新开始执行”和“又接受了一件新事”。

**设计建议：**识雨可为 worker 派工明确事件来源、任务身份、范围、授权依据、结果契约与状态版本；不要把一段提示词同时当作事实、授权和完成凭据。这不决定 worker 的层级归属。

依据：[Mandate 数据结构](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/model.ts#L116-L134>)、[gate 与恢复复核](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/policy.ts#L190-L239>)、[接收及创建](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/evals.ts#L131-L155>)、[创建授权记录](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/evals.ts#L305-L315>)、[重新执行](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/tickets.ts#L318-L326>)。

### 2. 后续消息有归属，补充上下文不自动增加授权

**已静态核查：**人的后续消息若已交给现有 Ticket 的 worker，就由该 worker 判断是否属于当前任务；主会话不能同时再接成另一个任务。worker 可将不属于本任务的消息交回；有多个所属任务时，要等这些 worker 全部交回后才进入新任务评估。符合授权条件的停止请求另有路径。

订阅相关线程可以仅用于上下文，不给该 worker 新任务权限。人的追问能唤醒部分已结束任务，但恢复前会重新检查原 Mandate；机器人或 CI 信息不能沿这条路径唤醒已结束任务。被人明确停止的任务也不会被普通追问自动恢复。

**设计建议：**双工协议应区分观察事件、任务内补充、授权变更、取消与新任务，避免同一条输入被 core 和 worker 各做一次。需要注意，worker 对“是否超出语义范围”的判断仍依赖模型与提示，不是完整的机器可执行权限系统。

依据：[接入分发](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/intake.ts#L14-L62>)、[已归属消息限制](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/evals.ts#L147-L155>)、[恢复条件](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/tickets.ts#L247-L269>)；上游测试断言见[消息交回](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/tests/followups.spec.ts#L47-L89>)、[仅上下文订阅](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/tests/followups.spec.ts#L235-L248>)，本轮未运行。

### 3. 模型判断与确定性状态提交分开

**已静态核查：**Engine 通过同步事务入口修改事件、任务与执行记录；Policy、Assessor、Executor、Outbox 和 Repositories 通过小接口连接。运行时使用 SQLite，外部执行及发送先写入持久 effect 队列，再由适配器执行。

这是“模型负责提出判断，程序负责检查并记录合法状态迁移”的参考。源码的 core 是任务领域层，不能因为名称相同就等同于识雨包含记忆、关系、情绪等部分的 core；角色接口类型也不等于操作系统权限隔离。

**设计建议：**若沿用识雨现有角色草案，可继续把 core 内的模型判断和内部提交入口分开。worker 返回结果或提案后，由程序核对任务身份、授权范围和状态版本，再进入内部提交路径。

依据：[Engine 事务入口](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/engine.ts#L19-L48>)、[SQLite 事务与提交后动作](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/store.ts#L134-L161>)、[架构接口](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/007-architecture.md#L44-L64>)。

### 4. 持久队列与消息回执支持恢复，但不保证所有外部动作只执行一次

**已静态核查：**Effects 按种类和键保存待执行动作，同键更新合并并递增 generation。处理旧动作的完成回调不能误删新版本；失败按退避重试。Outbox 将消息回执和待发送动作一起提交，同消息 ID 不重复入队，区分 pending、sent、dropped。

恢复执行时会提示 worker 检查目录、Git 历史和 GitHub，再决定是否重复外部动作。因此，“有持久队列”不能推出“任意外部动作恰好一次”。Outbox 发送调用与本地 sent 记录也分两步；崩溃窗口下是否重复，需要核对各 Source 的幂等实现和外部服务语义，本轮没有完整验证。相同任务、相同会话的发送通常按序，但较早消息持续失败达到阈值后允许后续发送，并非无条件严格保序。

**设计建议：**识雨应分别表达“已接收”“已执行”“内部已提交”“对外已发送”和“结果未知”；回执的身份与状态应可查询。未知结果的处置仍需单独设计。

依据：[effect 合并](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/effects.ts#L60-L66>)、[并发、旧回调与退避](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/effects.ts#L103-L145>)、[Outbox](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/outbox.ts#L17-L50>)、[重启恢复说明](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/003-execution.md#L140-L154>)。

### 5. 后台吞吐与人的响应优先级分别处理

**已静态核查：**WorkerSlots 同时计算运行和启动中的任务；人的追问或状态请求可以占用常规并发上限以外的一个额外槽。普通自动事件等待正常槽位。主会话限制长时间等待，报告及后台结果通过消息回流。普通进度留在任务中，需要人处理的问题或结果再转给主会话。

**设计建议：**外层队列设计可以区分持续后台工作与对话响应，避免忙于任务时连用户追问都迟迟不能回应。这里的“额外一个槽”只是原型选择，不应未经测量变成识雨的固定参数。

**限制：**worker 槽位不是统一资源预算。交给人处理后，有些 shell 作业可继续且不占槽；超时处理对子代理与 shell 作业的行为不同。token、内存、进程数量、长期费用和实际延迟均未在本轮测量。

依据：[槽位实现](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/executor/dsh.ts#L172-L198>)、[人的消息唤醒](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/executor/dsh.ts#L290-L327>)、[主会话等待约束](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/sessions.ts#L61-L85>)、[交给人后的后台工作](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/executor/dsh.ts#L588-L599>)、[报告转发](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/tools/executor.ts#L85-L100>)。

## 适配限制与成本

| 维度 | 已核查事实与影响 |
|---|---|
| 外层只读 | 主会话同时有路由、回复、策略与提示配置工具，还有 shell；不存在一个已分离、只读的 replyer。不能直接把 orchestrator 当作识雨外层。[工具清单](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/007-architecture.md#L490-L507>) |
| 执行隔离 | 创建的主会话和 worker 会话使用 `danger-full-access`。独立目录与命令包装仅建立默认行为；源码文档也明确它们不是安全边界。若将来借用执行器，需另外确定能力与存储隔离。[Session](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/sessions.ts#L138-L154>)、[执行边界](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/003-execution.md#L49-L80>) |
| 观察模式 | off / observe / auto 主要控制推断类候选；显式请求仍可接受。observe 不是“整个系统只看不动”。[策略检查](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/policy.ts#L40-L60>)、[测试断言](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/tests/policy.spec.ts#L315-L325>) |
| 策略变更与暂停 | 待评估事件会重新评估，受影响的运行任务收到策略变更消息；不会仅因策略变化立即强制停止。暂停也不是撤销所有正在发生的动作。识雨的撤权、取消、暂停语义需独立决定。[变更输入](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/tickets.ts#L196-L207>)、[执行与暂停说明](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/003-execution.md#L186-L201>) |
| 六部分内层 | 没有形成它覆盖识雨记忆、关系、情绪、认知、人格、能力的证据。`src/core/memory.ts` 是供测试和临时 Engine 使用的内存仓储，不是长期记忆模块。[实现](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/memory.ts#L1-L23>) |
| 数据保留 | 任务、事件、决策、出站回执与版本历史等持久化；架构文档明确旧记录尚无清理机制，会持续增长。运行日志不能自动视为已获准的长期记忆。[持久化说明](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/007-architecture.md#L450-L484>) |
| 依赖与替换成本 | DSH bundle，声明 DSH `^0.2.1-alpha.2`、Node `^22.19.0 &#124;&#124; >=24.0.0`；具体 Session、工具、模型调用与生命周期接入 DSH。Engine 的接口拆分有利于研究替换，但未验证脱离 DSH 运行的工程量。[包清单](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/package.json>) |
| 运行费用与数据去向 | 模型调用、并发 worker 与后台工作带来成本；主会话会合并部分输入，但本轮没有实际价格或性能测量。模型数据去向取决于运行时配置；本地 SQLite 不代表模型推理全部在本地 |
| 成熟度 | 公开定位为研究代码；上游提供较细的测试，本轮仅阅读相关断言，不代表测试通过、生产可用或已验证其自主工作效果 |

当前识雨基线仍是设计文档，候选没有已接入能力。下一阶段优先复制已确认的领域/队列闭包，沿用其测试并加识雨契约断言；不是整包将编码代理接管识雨，也不是只参考后重新写同类引擎。Store.atomic 的异步误用、SAVEPOINT 入口和回滚失败路径须先补丁，具体见本轮核查。

## 待验证事项：计划，未执行

| 问题 | 最小验证方式 | 通过条件 |
|---|---|---|
| 消息归属与重复接单 | 合成事件同时到 core 与 worker；包括多任务订阅、交回和上下文订阅 | 不重复建任务；有明确所属与交回记录；上下文不扩大授权 |
| 过时授权与撤权 | 接单后改变策略，覆盖执行中、排队中、已结束后恢复三种情况 | 符合事先选定的撤权规则；不能把“收到撤权通知”冒充“已停止动作” |
| 状态与外部动作恢复 | 在提交前后、发送后记回执前、旧 effect 完成时注入中断 | 不丢新版本动作；每个外部动作明确已完成、未完成或未知；不虚报恰好一次 |
| 对话响应与资源预算 | 后台任务占满正常槽，加入用户追问、状态请求、持续子任务 | 对话满足事先确定的延迟目标；统计总资源，而不只看 worker 槽位 |
| 与只读 replyer 组合 | 使用合成内部状态与裁剪视图；验证工具、文件和存储访问范围 | replyer 无内部写入通道；视图可追到版本；任务完成与内部提交分别回执 |
| 数据保留 | 使用合成事件、任务与版本历史，设计关闭与清除路径 | 保留与清除范围可说明、可检查；不把归档误称为彻底删除 |

若后续要求运行实验，使用 `测试/YYYY-MM-DD-dsh-superagent/`，先选一个明确问题，以替身渠道和合成数据验证，记录依赖、费用及清理范围。本轮未执行安装、测试、候选启动或外部服务接入。

## 决策记录

- **2026-10-31，用户要求继续查看此仓库。** 完成固定提交的资料与限定源码核查，登记为已初评。
- **助手建议，待讨论：**优先参考授权 / 工单 / 执行实例分离、消息归属、程序控制状态提交、持久回执和对话响应优先级。
- **未决定：**是否复用本项目代码、采用其具体授权或恢复策略，以及 core / worker / replyer 的层级和模型映射。
- **同日后续用户决定：**识雨当前以 [DSH 插件](<DSH.md>)存在；比较后选择 A：识雨核心运行于插件内。这不等于采用 DSH-Superagent，本候选仍为已初评、未实施。
- **验证情况：**阅读了策略、消息交回、effect 事务与更新竞争、并发槽位等测试断言；没有运行上游测试，不记为“通过”。
