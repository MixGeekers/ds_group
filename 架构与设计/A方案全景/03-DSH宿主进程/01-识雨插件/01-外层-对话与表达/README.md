# 外层 · 对话与表达

[上级](<../README.md>) · [完整目录](<../../../目录.md>) · [全景图](<../../../../图示/识雨全景架构-A.html>) · [运行仪表盘与 Session 复用](<../../../../运行仪表盘与Session复用.md>)

- 创建：2026-11-01（America/Caracas）。区域 ID：`outer`，对应 2026-10-31 全景图。
- 实现状态：仅设计资料；运行系统未实现。
- 设计状态：2026-11-01 用户确认尽量复用 DSH Session；以下为待验证的实现设计，未实施、未运行候选。
- 证据：[本轮一手来源与核查范围](<../../../../../research/2026-11-01-完整架构/输入与外层.md>)。数值是首轮合成验证配置，不是已测性能。

## 2026-11-01 复用核查决定

以本次用户确认的“尽量复用 DSH Session”为当前方向：外层默认复用 DSH 原生 Agent / Session 的生命周期、历史、恢复、inbox、上下文组织与原生压缩，沿用宿主模型路由、认证 UI 和取消接缝。replyer 使用受限原生 Session，首轮 `tools=[]`；必须先验证创建与恢复前的角色准入、工具隔离和实际执行门禁。外层只增加会话代次、受众、授权、保留和发送资格等识雨规则，不再建设第二套会话历史、待答队列或压缩引擎。

历史核查曾建议局部复制 DS-Bot 的 callAside/complete/settle/cancel 与 requests 幂等控制流，并用 p-queue 调度旁路模型调用。该建议现在只保留为备选：确证原生路径不能满足必要的隔离或取消边界后，才评估 `ctx.llm.stream` / `BlockAssembler` 与上述局部复用。不能仅为自定义上下文或追求缓存而默认绕过原生 Session。整包 ds-bot 未作为依赖，局部复制亦尚未实施。

固定版本、源码位置、依赖和许可见[复用核查](<../../../../../research/2026-11-01-复用核查/输入与外层.md>)；以下业务契约继续有效。

## 区域主方案

外层由渠道链接、原生 Session / inbox 与识雨会话规则、replyer 组成。优先通过受限原生 Agent 接收输入、生成草稿与恢复上下文；会话的未处理输入由原生 inbox 负责，识雨记录业务接纳、原生请求映射与草稿发送资格。快照由程序追加到原生上下文；只有原生边界验证存在缺口时才评估前述旁路备选。

外层对六部分内部状态只读。接收输入、生成草稿、维护会话游标和派发获准回复属于对话运行数据；它们不能成为内部权威状态的写入旁路。所有存储操作通过按角色收窄的 Store / Intake / Effect 服务，外层没有数据库句柄、目录遍历或凭据读取能力。

## 双工流程

用户输入 → 渠道连接器/桥接 → 认证与 inbox → IntakeReceipt → IngressRouter 分流。普通问答/状态查询且已有视图足够时直接 ReadView → replyer；行动、目标或持久变更进入 core → 授权/TaskService → worker/核验 → ReadView。两路生成 ReplyDraft 后都经程序检查受众、conversationGeneration、authEpoch、tombstoneWatermark 与关联任务/目标取消状态 → 统一 Effect/outbox → ChannelAdapter → Receipt。

core 是决策协调职责，入口路由和任务派发分别由程序与复用引擎承担。无变化订阅不进入模型；暂停/取消先执行可信控制逻辑。详见[Core派工与对话时序](<../../../Core派工与对话时序.md>)和[渠道、订阅总方案](<../../../连接、订阅与派工总方案.md>)。

查询方向：外层请求裁剪视图；推送方向：core 发布获准的视图失效 / 完成通知。二者都不允许外层操作记忆、关系、人格或情绪。读取行为不增加记忆权重或触发学习；必要访问日志归审计域。

## 共同契约

| 对象 | 字段与校验 |
|---|---|
| ReadView | viewId、schemaVersion、commitSeq、stateVersion、authEpoch、tombstoneWatermark、indexWatermark、aggregateVersions、generatedAt、expiresAt、policyVersion、scopeHash、issuedTo、purpose、sourceRefs、freshness、data（含获准的健康与状态内容） |
| scopeHash | 绑定 actor、channel、conversation、purpose；viewId 只是索引，不是持有即可访问的授权令牌 |
| ReplyDraft | draftId、conversationId、turnId、conversationGeneration、viewId、stateVersion、sourceRefs、contentRef、draftStatus |
| Effect / Receipt | 使用任务区的 pending/dispatching/succeeded/failed/unknown/cancelled；origin 为 task{taskId,assignmentId} 或 dialogue{conversationId,turnId,conversationGeneration}，两类均绑定 Mandate、目的地和授权 scope；stable idempotencyKey + payloadHash；Receipt 关联 providerMessageId、证据与送达阶段 |
| 业务回执 | accepted、内部 committed、外部发送 succeeded 分别报告，不把入队成功描述为完成 |

首轮 replyer 默认 tools=[]，ReadView 由程序注入。创建与恢复 Session 前均检查角色、scope、模型配置与空工具集合，禁止恢复时继承通用 Agent 权限。需要按需补查时只准 query_read_view / query_task_status 的受限 facade，每次按 actor / audience / purpose 重新授权；不暴露写工具、文件工具、MCP、Shell、设备或通用委派工具。

空工具列表并非同进程安全隔离：只装载可信注册，角色 ToolGuard 必须在实际执行时 deny 未允许的工具与无角色调用，禁止自定义 executor 绕过；scope 自注册工具不能继承通用权限。严格对抗恶意插件不属于该逻辑边界能力，验证失败时停止启用并采用独立受限执行面。

## 资源、恢复与替代

ConversationService 只管理 DialogueTurn、ReplyDraft、原生 Session / 请求映射与 conversationGeneration，并经统一 UnitOfWork 写入局部业务记录和回复 Effect；不写六部分内部状态，也不复制原生历史或维护另一份待答队列。每会话最多一个可发送的 conversationGeneration，跨会话有限并发；输入/视图/发送都可取消，但已完成外部副作用不会因取消而回滚。重启先对账原生 Session、inbox 与请求结果，不能仅见业务记录未完成就重复追加输入。

Session 按 conversation + scope 保持；conversationGeneration 只使草稿失效，不逐条换 Session。稳定角色指令和工具定义保持前缀稳定，ReadView、时间、预算与当前状态作为动态内容追加。长期上下文默认使用 DSH 原生压缩与受控原文引用，摘要额外模型调用计入统一预算；未答输入由原生 inbox 保留，授权与发送边界另有业务记录，不能只依赖摘要。原生生成历史与平台送达事实分开记录，取消或未知送达的草稿不能当作用户已经看到的回复。

默认不做跨聊天平台群上下文合并；私聊内容只能由受众限定的视图显式释放。模型不可用时返回已核实任务状态与失败原因，不伪造自然语言成果。只读工具验证不通过时退回零工具、程序注入快照；仍不通过则停止该 replyer 适配。

## 子模块与验收

- [渠道链接](<01-渠道链接/README.md>)
- [串行与并行队列](<02-串行与并行队列/README.md>)
- [replyer 表现](<03-replyer-表现/README.md>)

V04：视图裁剪、只读副作用、未知工具、scope 自注册和自定义 executor 路径逐项验证；任何绕过必须阻止进入后续阶段。V05：新消息打断、并发两会话、取消和未知发送结果；旧 conversationGeneration 不再发送。V23：完整链路可追溯 event → view → draft → Effect → Receipt，内部只读约束保持。

