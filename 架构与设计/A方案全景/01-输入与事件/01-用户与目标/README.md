# 用户与目标

[所属区域](<../README.md>) · [完整目录](<../../目录.md>) · [全景图](<../../../图示/识雨全景架构-A.html>)

- 创建：2026-11-01（America/Caracas）。模块 ID：`user`，对应 2026-10-31 全景图。
- 实现状态：仅设计资料；运行系统未实现。
- 设计状态：2026-11-01 细化为验证用建议基线；未实施、未运行候选。
- 证据：[本轮一手来源与核查范围](<../../../../research/2026-11-01-完整架构/输入与外层.md>)。数值是首轮合成验证配置，不是已测性能。

## 2026-11-01 复用核查决定

**直接使用 + 领域适配。** DSH `this.ctx.invocation.peer.principal` 提供 Host 固定的调用身份，`@Remote({resources})` 声明目标/会话资源，`ctx.remoteAccess.registerPolicy/invalidate` 管非 owner 角色和撤权。owner 在 DSH Remote Access 中直接放行，因此识雨仍须检查 owner 配对、Goal 归属和 Mandate，不能把宿主 owner 当任意业务动作的授权。

DSH `ctx.goals` 已有 revision CAS 和持久生命周期；单 Session 一个 Goal、依赖 exact live Agent 与 Session log。与核心方案统一采用“一目标专用 Session + ctx.goals CRUD/revision CAS + 领域元数据”；业务账本只补 goalId↔sessionId、Mandate、范围和预算，不另建第二生命周期状态机。入口直接适配创建/控制命令。不能以存储形式不同排除 DSH，也不能把只有 objective/phase/round cap 的对象当作已经具备识雨授权模型。V02/V23 核查身份、资源与实际目标回执。

固定版本、源码位置、依赖和许可见[复用核查](<../../../../research/2026-11-01-复用核查/输入与外层.md>)；以下业务契约继续有效。

## 主方案

用户意图以带证据的输入事件进入内部；Goal 生命周期由 DSH `ctx.goals` 管理，识雨通过 GoalBinding 关联专用 Session 与领域元数据，core 解释目标并提出受限命令，Mandate 是程序核查的行动范围。首阶段只接受已配对 owner 主体创建、暂停、恢复或取消持续目标，其他人的消息可作为观察材料，不能直接改动 owner 的目标。

复用 DSH 的已认证连接与用户消息来源，身份映射采用稳定 principalId，不依据昵称、语言风格或“我是主人”文本。自然语言目标由 core 提取 Proposal，再按规则落盘；外层不自行将模型总结变为新授权。普通当前会话回复可继承本次明确请求的回复范围，无需每条重复确认。

## 输入输出与所有者

| 输入 / 输出 | 内容与所有者 |
|---|---|
| goal.requested | 原文 payloadRef、actor、source、conversationId、客户端请求 ID；IngressService 接纳，core 解释 |
| goal.control.requested | 暂停 / 恢复 / 取消意图、goalId、DSHGoalRef、metadataVersion；分别核对原生 revision、领域元数据版本与归属 |
| DSHGoalRef 与 phase | DSH 原生 GoalRef 为 {id,revision}，在适配边界记为 DSHGoalRef；phase 仅为 active / paused / blocked / complete，由 Session log 权威保存 |
| GoalBinding | goalId、sessionId、goalRef、owner、scope、completionCriteria、priority、budget、reviewAt、expiresAt?、metadataVersion、stopReason? 及观察投影；控制库只保存关联、授权元数据和停止记录，不维护第二套 Goal 生命周期 |
| 回复依据 | IntakeReceipt 可报告收到；核对 DSHGoalRef、GoalBinding.metadataVersion 与 Mandate 版本后的确认回执，才可报告目标建立或变更完成 |

UI 停止按钮使用认证的控制请求，进入高优先级控制通道。文本“停一下”是高优先级待解释输入，不能让引用文件中相同文字直接控制任务。暂停阻止新的派工与待发送副作用；已经不可逆完成的动作不能被取消回执虚构为已回滚。

## 关键流程与默认值

当前问答默认是短期会话请求，只有具有持续意图及范围的指示才建立长期 Goal。目标必须具备可观测完成条件；缺少目标对象或动作范围时，Goal 创建前的输入解释结果标为 needs_clarification（不新增原生 Goal phase），不靠无限追问阻塞无关任务。已有授权明确时直接复用，并将授权版本链接到任务。

未指定时间的目标不凭空写截止日期，采用无硬截止、24 小时复查的验证配置；这只是检查目标是否仍有效，不是自动每天对外行动。默认主动通知只发回原认证对话，安静时段与通知频率由策略决定；跨平台通知需要已登记目的地和相应授权。

## 失败、权限与生命周期

同 clientRequestId 同内容回放既有回执，异内容冲突。取消或到期先持久记录 GoalBinding.stopReason 并关闭本地派发资格，再按已核验的 DSH disarm / pause / clear 语义处理，保留 DSHGoalRef 关联墓碑；不新增 cancelled 或 expired 原生 phase。恢复时核对原生 phase、当前授权与本地停止记录，历史记录中的“继续”或普通定时输入不能重开已停用目标。原生 armed 也不能绕过识雨每轮准入，不默认加载自动 continuation driver。撤销授权与取消任务分开处理，下一次副作用派发必须重新核查。

DSH Session log 与控制库不共享事务：先登记控制命令，再按 revision 调用 DSH，读取核对后确认回执。任一中断或结果不明标为命令 unknown，保持本地派发关闭，恢复后核对原生记录与控制记录；不能直接重放命令、恢复派发或声称两边已经同步完成。unknown 是命令核对状态，不是新的 Goal phase。

目标摘要可长期保留至目标关闭和保留期结束；原始正文按原始经历策略处理。删除只保留最少无正文墓碑以防旧输入复活，具体期限及备份清除遵循全局数据方案。外层只写受理与对话运行记录，不写六部分内部权威状态。

## 验证与备选

V02：伪造 owner、原生 revision 或 metadataVersion 冲突、同 ID 内容冲突均拒绝；暂停、取消或到期后重启不派生新任务。V23：用户创建可测目标，Task 与最后回执都能追到同一 DSHGoalRef、GoalBinding.metadataVersion 和 Mandate 版本；在跨存储命令各阶段注入中断，unknown 在核对前不恢复派发、不虚报完成。通过标准是业务结果与身份一致，不能以模型“理解了”代替。

复杂自然语言解析不稳定时，保留同一 Goal 模型，改用已有 Web 表单填写范围、截止与完成条件；不换成另一套目标引擎。首阶段不接入强化学习来决定何时接受目标。

