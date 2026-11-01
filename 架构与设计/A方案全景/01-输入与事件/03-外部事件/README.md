# 外部事件

[所属区域](<../README.md>) · [完整目录](<../../目录.md>) · [全景图](<../../../图示/识雨全景架构-A.html>)

- 创建：2026-11-01（America/Caracas）。模块 ID：`events`，对应 2026-10-31 全景图。
- 实现状态：仅设计资料；运行系统未实现。
- 设计状态：2026-11-01 细化为验证用建议基线；未实施、未运行候选。
- 证据：[本轮一手来源与核查范围](<../../../../research/2026-11-01-完整架构/输入与外层.md>)。数值是首轮合成验证配置，不是已测性能。

## 2026-11-01 复用核查决定

**直接使用 + 适配。** `ctx.schedule.create({title,prompt,timing,target},actorSessionId?,signal?)`、`edit(...expectedUpdatedAt)`、`list/view/history/run` 提供持久定时管理；`@deepseek-ai/dsh-util-time` 的 Cron/RRULE 提供日历语法。wrapper 只允许识雨自己的 schedule ID，投递到专用受控入口，去重键绑定 scheduleId+occurrence。宿主接口是 Host-wide，不能直接暴露给 replyer。

Schedule 依赖 agents/sessions/storageDomain/sessionPersistence，持久回执只证实输入投递；重启和 flush 窗口仍需业务 inbox 去重。CloudEvents 只复用边界规范，不把 source 或 data.actor 当凭据；保留 source 注册/授权/gap 补偿作为识雨特有规则。无需另写 cron、日历或通用事件总线；V03/V23 验证实际接纳与恢复。

固定版本、源码位置、依赖和许可见[复用核查](<../../../../research/2026-11-01-复用核查/输入与外层.md>)；以下业务契约继续有效。

## 时间与事件订阅补充

识雨可以在已有Mandate、来源范围和预算内自主创建/更新/暂停/退订声明式订阅，不默认每次请求用户确认。规则写入持久SubscriptionSpec；来源监听器使用现成adapter，确定性匹配命中后进入EventEnvelope/inbox，最后才唤醒既有Goal/core。监听、轮询、续租和“无变化”处理本身不调用模型。新增账号、目录权限、公网入口或监听代码安装属于独立权限动作，不能借订阅隐式完成。

[时间与事件订阅方案](<../../时间与事件订阅.md>)明确SubscriptionSpec、SourceBinding、游标、去重、misfire、循环保护和退订恢复。订阅定义与进程内listener不同；Cordis事件不自动保存规则/事件，重启需从持久记录重建。业务事件ID跨重连保持稳定；sourceGeneration是捕获的SourceBinding.bindingGeneration，只拒绝旧来源回调。单订阅暂停/恢复递增自己的activationGeneration，不改变共享来源代次、不影响其他订阅；ruleRevision只代表规则语义。退订先持久阻断本条订阅派发，最后一个来源引用释放才清理监听；异步清理不能删除新handle，已产生的Task/unknown效果另行核对。

现成技术核查见[订阅机制证据](<../../../../research/2026-11-01-连接订阅与技术栈/订阅机制.md>)：OpenClaw当前Automations统一时间和事件观察，MCP Events具有具体协议/租期前提；这些不是当前DSH已具备的通用事件订阅API。首选已有DSH时间接口与获准来源push/poll，不新增第二宿主。

## 主方案与事件接纳

复用 DSH 事件服务与 Host Schedule 作为唤醒机制，CloudEvents 1.0.2 作为外部事件格式；持久接纳、去重和与目标关联由识雨统一账本承担。Host 活着才能触发定时；调度投递回执不是业务完成回执，不另写常驻 cron 引擎。

首轮允许来源只有：显式登记的计时器、测试目录变更、设备能力状态、任务结果、系统健康探测。来源注册记录 source URI、类型白名单、认证绑定、数据范围、速率和过期策略。网络 webhook 不默认公网开放，远端路径和对象引用不得成为任意读取文件的入口。

## 事件格式与判断

CloudEvents 顶层复用 id/source/type/specversion/time/datacontenttype，specversion 使用 1.0；内部 EventEnvelope 独立使用 schemaVersion。source + id 标识事件，correlationId 只是关联键，不授予权限。CloudEvents 的格式正确不代表内容可信，也不提供恰好一次传输保证。

观察 → 持久接纳 → 核对源状态/有效期/Goal 状态 → 与已有事件去重或聚合 → core 决定忽略、回顾或派工。事件本身不替代 Mandate。重复文件通知可合并为“需要重扫”，但不能合并支付、发送、取消等有独立语义的动作结果。

## 顺序、补偿与恢复

| 情形 | 处理规则 |
|---|---|
| 乱序 / 时钟回拨 | 同源 sequence 优先；没有 sequence 时记录 occurredAt 与 receivedAt，不伪造全局发生顺序 |
| 重复 | 持久 dedup key 命中回既有 IntakeReceipt；相同 key 内容变更拒绝并告警 |
| 来源队列溢出 | 记录 gap 与丢失窗口，对可扫描来源做基线重扫；扫描结果仍按事件规则接纳 |
| 定时错过 | 默认合并一次错过唤醒并重新评估当前目标；不把错过 100 次变成 100 次外部行动 |
| 设备失联 | 产生 health 观察，不直接重放上次副作用；设备端结果按 Task/Effect 协议核对 |
| 事件过期 | 过期的动作意图拒绝；仍有审计价值的观察可存为过期材料，不触发自动行动 |

验证配置：文件变化聚合窗口 500 ms；每 source 突发上限 100 个待处理事件，满时进入背压或 gap 补偿。具体生产阈值由测得吞吐与全局资源预算覆盖。

## 数据与验证

传入正文按来源分类保存，默认不把未经筛选的传感数据长期记忆化；大附件用受控 payloadRef。删除源撤销后，队列中的旧事件再处理前检查 source policyVersion；不能通过重放恢复已撤销能力。

V03：重复 100 次、倒序 100 条、过期事件、重启错过多个 tick、撤源后重放。通过标准：已接纳事件不静默丢失、业务变更不重复、未知缺口可见、暂停目标不被唤醒为行动。V23：同一有效事件只形成一个可追溯的任务或明确忽略回执。

可靠源数量和吞吐达到单机方案门槛后，才评估现有消息代理；若文件观察有漏报，优先重扫补偿而非自写跨平台文件监听器。高频机器人控制留在设备本地，本入口只处理高层事件。

