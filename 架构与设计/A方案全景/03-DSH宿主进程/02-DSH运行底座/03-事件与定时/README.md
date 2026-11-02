# 事件与定时

[全景目录](<../../../目录.md>) · [证据与版本](<../../../../../research/2026-11-01-完整架构/宿主与依赖.md>) · [验证与验收](<../../../验证与验收.md>)

- 更新：2026-11-01（America/Caracas）；原图模块 ID：`event-schedule`。
- 状态：完整架构的建议基线，待验证；未安装、运行或接入。A 的插件内核心由用户选定，其余技术为本轮规划选择。

## 主方案

2026-11-02 的[统一事件接口与发布订阅](<../../../统一事件接口与发布订阅.md>)补充 Agent/普通组件共同使用的发布、订阅、类型发现和回执接口；仍复用下述账本、outbox、原生 Session 与进程内唤醒。组件可直接消费，纯背景更新不触发模型，Agent 续接须经过现有准入。该扩展仅设计，未声称宿主已提供同名统一服务。

本模块现在同时承载[时间与事件订阅方案](<../../../时间与事件订阅.md>)中的宿主接缝。core在有效Mandate内可以自主建立声明式SubscriptionSpec，程序负责限额、来源绑定、确定性匹配和持久命中；不为每个tick创建模型任务，也不默认逐次询问用户。注册规则与安装可执行监听器分开；后者需已有对应实施/权限范围。

[复用核查](<../../../../../research/2026-11-01-复用核查/宿主与依赖.md>)明确直接调用 `ScheduleService.create/list/view/history/run/edit`，不复制整个调度器。纯业务到期路径若不需要 Session 投递，直接依赖 `@deepseek-ai/dsh-util-time` 的 `Cron.parse/RRule.parse`、`rule.next/resolve` 和时区解析；该 MIT 包已使用 Temporal polyfill 与 rrule。删除自写cron/RRULE/时区解析和另一通用定时框架的计划。持久输入幂等和Goal到期筛选仍是产品规则。

领域 inbox/outbox 负责可靠接收与恢复，Cordis 事件负责同进程唤醒。计时与用户日历规则优先复用 DSH Schedule / timer；不引入 Redis、Kafka 或独立工作流平台。原始事件载荷仅作为数据，不能直接成为高权限指令。

EventEnvelope 保留稳定 eventId、schemaVersion、source、actor、occurredAt、correlationId、payloadRef 和可选业务关联。入口先持久化并去重，再发进程内通知；通知丢失时由未处理记录扫描补偿。收到确认仅证明持久接收，不证明模型已处理或动作完成。

## 时间语义与流程

| 来源 | 处理路径 | 恢复规则 |
|---|---|---|
| 用户 / 设备 / 文件事件 | 来源适配 → 持久 inbox → core 去重与新鲜度判断 | 同一来源事件 ID 只接纳一次；重复确认返回原记录 |
| 明确日历 / 周期提醒 | DSH Schedule → 专用识雨入口 → 业务 inbox | 以 schedule ID + occurrence 时间构成稳定键；重复投递不重复建任务 |
| 持续 Goal 到期复查 | GoalBinding元数据的 `reviewAt` → 唯一宿主timer适配 → 索引查询 | 核对原生DSH Goal/revision及授权后受控唤醒，不复制Goal生命周期 |
| 存储 / 工具状态变化 | 程序观测 → 有来源事件 → 健康投影 | 健康变更不自动进入长期记忆 |

UTC 存储时间戳；用户日历保留 IANA 时区，初始为 America/Caracas。间隔计时用单调时钟，持久截止时间用 UTC。时钟跳变后重新计算 due 集，不重放每一个错过 tick。默认同一 Goal 的到期复查合并为一次；明确要求逐次处理的业务需要独立 occurrence 记录。

第一阶段 due 索引扫描默认每 30 秒、每批最多 100 项，仅对到期记录产生判断；这是一条有限的业务对账查询，不是新造 cron 引擎。日历 recurrence 语法、时区解析与重复提醒仍复用 DSH。任务已暂停、授权到期或资源不足时只变更可解释等待状态，不循环唤醒模型。

## 与 DSH Schedule 的边界

固定版本 Schedule 在宿主存活时工作，重启周期任务只发最新错过的一次；Session flush 与 schedule 回执是独立提交，可能重复。回执只证明 inbox 持久化，优雅 Agent disposal 仍可能清理待输入。因此它不能作为 Goal / Task 真相，也不能独立保证业务效果。

DSH 定时消息必须投递到专用 shiyu 入口；在业务 inbox 提交前不得让默认通用 Agent 执行其 prompt。适配失败时保留时间规则与任务，使用领域 due 查询进行受控补偿；不转成无限时循环推理。

本轮直接读取runtime确认：Schedule通过 `agent.followup(message)` 投递source.kind=schedule的文本并等待Session flush；公开create并不是任意callback注册器。计划使用setup前安装的专用零工具schedule-ingress Agent，由pre-step校验原生来源及受控映射、持久接纳事件，再reject该步骤；prompt只携带固定订阅标识。此接缝尚未运行验证，尤其要验证flush/业务入箱间崩溃及create丢回执。失败回退为同包util-time+现有账本的窄到期适配，先解除旧绑定，不同时运行两只同义时钟。

订阅的期望启停、ruleRevision、activationGeneration、SourceBinding.bindingGeneration、opaque游标、去重和发生回执保存在控制账本；事件sourceGeneration只复制对应bindingGeneration。单订阅取消/暂停使自己的activationGeneration失效，不影响共享来源与其他订阅；规则语义变化增加ruleRevision，原生handle/账户/重认证等来源替换才推进bindingGeneration。最后一个有效来源引用释放才清理监听；旧清理不能删除新绑定，各维度A→B→A不能复用旧代次。DSH Schedule仍是其时间定义执行权威。原生周期只支持最新错过合并，不能向用户承诺无界补齐；all/catch-up只有adapter明确支持且有持久发生记录时才接受。远端清理和已发生效果另核对。

上游 Schedule 管理是 Host-wide，不能直接当作识雨的任务级权限接口。只向角色暴露受控 wrapper，核对允许管理的 schedule ID、来源主体和 Mandate；禁止把宿主全量 schedule 管理工具开放给 worker。按次新建 Session 的原生调度并发仍须经过识雨全局预算和 TaskService 配额。

## 验证

V14 覆盖重复事件、遗漏通知、时钟回拨、睡眠跨时段、到期授权、暂停和大批积压；V24 验证原生 Schedule 的重启与投递。通过条件是同一 occurrence 对应唯一业务接收记录、最多一个有效执行资格，业务完成另由 Receipt 验证。所有计时与事件 listener 在插件卸载时释放，不留下第二套活动扫描器。

## 证据

[Schedule 官方流程与局限](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/schedule/schedule/README.md>)；[domain/changed 为提交后通知](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/storage.md>)。30 秒、100 项和合并规则为建议默认值；真实吞吐与恢复时间未实测。

新增[订阅机制证据](<../../../../../research/2026-11-01-连接订阅与技术栈/订阅机制.md>)包含runtime.ts发送路径与固定OpenClaw Automations/来源世代/MCP Events核查。V03/V14/V24追加自主创建范围、无变化0模型调用、游标/注册恢复、重复绑定和自触发链场景；没有安装或运行候选。

