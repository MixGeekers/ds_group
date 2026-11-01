# 任务与执行 · 总体方案

[任务与执行](<README.md>) · [完整目录](<../../../目录.md>) · [证据与取舍](<../../../../../research/2026-11-01-完整架构/任务与执行.md>)

- 更新：2026-11-01（America/Caracas）。区域 ID：`execution`。
- 状态：**进入验证的建议基线 v1.1（源码复用修订）**。A 的插件内核心已由用户选择；本页细节是本轮架构方案，尚未实施、未运行候选或故障实验。

## 1. 主方案与复用边界

选择 **DSH 公共执行接口 + Superagent Engine / Store / Effects / Outbox 的局部源码复用 + 识雨领域适配**。TaskService 是既有 Engine 的受控门面，消费类型化命令，并保留识雨授权、租约、核验与状态投影；不再另写通用接单、输入归属、任务生命周期和队列。任务写入使用复制并补丁后的 Store 事务机制，CoreCommitService 负责协调其他领域的独立提交及其回执。

DSH-Superagent 固定提交 `6337fc823ce20251c8de8085948165c81aaa701e`（MIT）作为复制基线：core 13 文件纯领域闭包、Store 所需事务与 CRUD/DDL、Effects 队列、Outbox/receipts、WorkerSlots 和后台生命周期 helper。保留版权、固定来源及本地补丁。识雨 Task 对应其 Ticket 的公开投影；内部 Ticket JSON 可保留，补充识雨字段同事务存储。详细文件闭包、补丁和维护方案见[本轮复用核查](<../../../../../research/2026-11-01-复用核查/任务执行.md>)；本轮仅制定复制计划，没有接入产品。

| 层次 | 优先复用 | 识雨必须定义的部分 |
|---|---|---|
| 运行与推理 | DSH Agent / Session / tools / guard | 角色工具范围、当前授权与预算的最终检查 |
| 可靠落盘 | Superagent Store.atomic / afterCommit 及任务仓储；node:sqlite | 同步事务限制、失败隔离补丁、识雨补充字段和 CAS |
| 执行恢复 | Superagent Effects 队列、Outbox/receipts 和 generation 的现有实现 | 外部副作用分类、unknown 核对屏障、撤权、设备 fencing |
| 流程编排 | Superagent Engine 的 receive / evaluateDue / decide、Ticket/Assignment、输入归属 | 终态重做规则、公开状态投影、六部分与设备回执的端口适配 |
| 复杂分布式流程 | 本轮不引入 Temporal / Redis 队列 | 达到明确迁移门槛再使用成熟平台，不向当前薄层扩建通用框架 |

DSH storage-domain 的既有逐记录接口不提供任意跨领域事务组合，不能靠多次 put 代替“任务 + effect + outbox”原子提交。宿主证据见 [宿主与依赖](<../../../../../research/2026-11-01-完整架构/宿主与依赖.md>)；数据库物理方案由 [预留空间](<../../../06-预留空间/README.md>)负责。

## 2. 所有者与调用关系

```text
获准输入 / Goal
  → core 判断是否值得做
  → GoalService / PolicyGate 校验授权；TaskService 校验任务命令
  → TaskService → Superagent Engine → task Store.atomic
      任务授权快照 + Task / Assignment 补充事实 + Effect / outbox 同库提交
  → 提交后 Dispatcher
  → DSH worker / 设备能力 Broker
  → ExecutionReceipt + TaskResult
  → 程序核验 → Task 状态
  → 如有内部变更 Proposal → core 独立决定 → CommitReceipt
  → 只读视图 → replyer → 发送 Effect → DeliveryReceipt
```

- **TaskService** 是任务、执行实例及任务型动作账本的业务规则所有者；普通对话发送由 ConversationService 维护 turn / draft / generation 与对话型 Effect。两者都不开放 SQL、不让模型写状态枚举、不绕过统一事务入口。
- **CoreCommitService / UnitOfWork** 是受控提交入口，任务仓储直接使用已有 Store 事务实现；`commitSeq` 每次业务事务递增，`stateVersion` 仅六部分内层状态变更时递增。任务聚合用 `version` 做 CAS；记忆后端的独立提交使用 CommitReceipt 核对，不能把跨库流程当作一个 SQL 事务。
- **worker** 是受控执行角色，位于任务执行逻辑分组；没有内部权威状态提交权。分组不预设模型数量或新的进程边界。
- **Dispatcher / Broker** 在模型之外，检查当前授权、版本、预算、暂停、删除屏障、执行租约与设备能力；工具调用路径不能跳过该检查。
- **ResultVerifier** 按 Task.completionSpec 核验证据；Task.succeeded 不等于内部 Proposal 已采纳，也不等于通知已发送。
- **replyer** 只读 Task/内层视图，不通过表操作、通用工具或取消回调取得内部写权限。

## 3. 一致性与消息保证

接单、分配执行实例、变更任务状态、写待执行动作与必要回执在任务账本的同一个本地事务内完成；事务内不调用模型、网络或设备。Store.atomic 回调必须同步，复制前修补 SAVEPOINT 入口栈状态、回滚失败隔离和异步回调误用；afterCommit 只用于加速，可靠工作必须先写 Effects。进程丢失唤醒时，Dispatcher 仍能从持久记录找到工作。任务结果与 Ombre 等独立记忆后端的提交各有回执，由协调器重试/核对，不能推定跨库原子性。

`effects` 保存逻辑动作的身份、参数摘要与结果；`outbox` 保存该动作的投递安排。两者不是两份独立真相：outbox 引用 effectId，所有变更同事务；重复投递使用同一个 effectId 和幂等键。回执是已观察到的事实，不能以“出箱已删除”代替。

Effect.origin 区分 task（taskId、assignmentId）与 dialogue（conversationId、turnId、conversationGeneration）。普通回复不为满足字段形式而创建 worker Assignment，但仍绑定 Mandate、目的地与可外发范围，并经过相同可靠派发和核对流程。

保证范围为**至少一次投递 + 同库去重 + 能力端明确支持时的执行幂等**。远端缺少持久回执、结果查询或原子幂等支持时，超时后可能无法确定是否执行；保留 unknown、停止重放并请求核对。任何“恰好一次”承诺都只能限于已验证的具体接收端协议。

## 4. 运行默认值、暂停与恢复

- 初始后台 worker 上限 2；单 Task 同时仅 1 个活动 Assignment。仍受宿主全局模型 / 设备资源预算约束，不能以“额外槽位”绕过预算。首轮故障验证可降为 1，便于定位竞态。
- 每 Assignment 程序心跳 10 秒、租约 30 秒；每轮重试最多 3 次，初始退避 2 秒、上限 60 秒并加抖动。仅适用于明确可重试的读取、启动和幂等动作；不是所有副作用的统一重试策略。
- 系统 / Goal 暂停持久阻止新 Assignment 和新 Effect 派发；已发动作尽力停止与核对，不能宣称撤回成功。暂停不清除 unknown，不自动延长 Mandate 到期时间。
- 取消持久写 stopRequested / cancellationEpoch，阻止新动作；停机、租约过期或取消请求均不能单独证明动作停止。无停止确认时保留未知状态。
- 启动先进入恢复屏障：确认数据库与宿主身份 → 保留暂停 / 撤权 → 核对旧 Assignment 与 dispatching / unknown Effect → 只恢复仍获准且可安全继续的动作。
- 从旧备份恢复需要新 hostEpoch 和隔离核对；不能把旧数据库计数加 1 当作跨恢复的 fencing 保证。设备承认新代际前不恢复有副作用的派发。具体 hostEpoch 规则遵循总契约和恢复专题。

## 5. 资料与验证导航

| 模块 | 方案重点 |
|---|---|
| [任务授权与范围](<01-任务授权与范围/README.md>) | 授权版本、机器可执行范围、预算、撤权与到期 |
| [任务与执行实例](<02-任务与执行实例/README.md>) | 任务状态、执行租约、CAS、输入归属与恢复 |
| [worker · 任务执行](<03-worker-任务执行/README.md>) | DSH 复用、工具 Broker、并发、上下文、停止与 fencing |
| [结果核验与回执](<04-结果核验与回执/README.md>) | 完成凭据、Effect/outbox、unknown、内部提交与外部结果分离 |

全局验收见 [V10](<../../../验证与验收.md#v10>)、[V11](<../../../验证与验收.md#v11>)、[V12](<../../../验证与验收.md#v12>)、[V23](<../../../验证与验收.md#v23>)。下述数值是合成验证场景的初始配置，不是已测性能。

跨模块不变量：重复输入只受理一次；同键异内容必须拒绝；撤权后不开始新副作用；过期实例不能更新当前状态；外部结果未知不伪装成功或未执行；已完成外部动作不因崩溃自动重放；内层写入始终经过受控提交。

## 6. 替代方案与切换门槛

若 DSH 不能在发布 Agent 前设置可靠工具范围，或 worker 可绕过 Broker 调用宽权限执行器，验证阶段只允许替身与只读能力，并将具体执行放入已有 OS 沙箱 / 隔离执行宿主后再开副作用；不以提示词代替控制。

若多个权威调度进程、跨站点长流程或业务日历成为必要要求，或固定验证负载下写入竞争与恢复延迟持续不达标，先评估 **Temporal** 的 Workflow / Activity 与持久历史，保留 Mandate、Task ID、Effect ID 和状态查询接口作为迁移边界。不能同时让 Temporal 与本地调度器拥有同一 Task 的派发权。当前 A 的单中心基线不需要 Redis/Kafka，也不通过增加自研调度特性追赶成熟工作流平台。

## 7. 证据与限制

本轮完成固定源码与官方文档静态阅读，没有执行任何候选。设计中的租约、fencing、保留策略、设备端幂等和量化门槛是识雨建议，不能归因于上游已实现。原始依据见 [任务与执行证据](<../../../../../research/2026-11-01-完整架构/任务与执行.md>)，最终源码复用取舍以[本轮复用核查](<../../../../../research/2026-11-01-复用核查/任务执行.md>)为准。上游只有初始公开提交的维护证据；使用固定副本和可审阅补丁集，升级先验证再替换，不依赖未承诺的稳定 API。

