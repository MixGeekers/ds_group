# worker · 受控任务执行方案

[任务与执行](<../README.md>) · [完整目录](<../../../../目录.md>) · [证据与取舍](<../../../../../../research/2026-11-01-完整架构/任务与执行.md>)

- 更新：2026-11-01（America/Caracas）。模块 ID：`worker`。
- 状态：**进入验证的建议基线 v1.1（源码复用修订）**。A 的插件内核心已由用户选择；本页细节是本轮架构方案，尚未实施、未运行候选或故障实验。

## 1. 角色与复用方案

worker 使用 DSH Agent / Session 完成检索、计算与获准工具调用。一个活动 Assignment 绑定一个工作 Session；任务跨实例恢复可引用已有检查点，但必须重建当前授权与工具范围。worker 是逻辑执行角色，不是六部分内层之一，也不预设必须使用独立模型或常驻进程。

优先复用 `ctx.agents.create(options)`、Session、已有模型 provider、tools.restrict 与 guard。Agent 发布前在 setup 中设置能力白名单；最终受限 Broker 复核所有工具调用。DSH 同进程插件属于受信任代码，白名单和提示词本身不构成 OS 隔离。

同时复制 Superagent `6337fc823ce20251c8de8085948165c81aaa701e`（MIT）的 `src/executor/dsh.ts` 中 WorkerSlots 类及 `src/executor/background.ts` 所需停止/收敛 helper。WorkerSlots 只需 Map、running/max 回调和 Effects.Later；background 通过 jobs/subagents 宿主接口适配。保留现有槽位预留和后台收敛算法，不另写一套。完整 DshExecutor / sessions.ts 还带入 worktree、Settings、prompts、宽工具集合等业务依赖，故本轮采用精确抽取与 DSH 公共 API；闭包和补丁见[复用核查](<../../../../../../research/2026-11-01-复用核查/任务执行.md>)。

## 2. 输入与输出

输入 `WorkOrder` 包含 taskId、assignmentId、installationGeneration、hostEpoch、fencingToken、Mandate 引用及当前 authEpoch、completionSpec、获准 ReadView / inputRefs、能力白名单、workspaceRef、budgetReservation、deadline 和恢复摘要。租约校验元组为 installationGeneration + hostEpoch + 单调 fencingToken；身份与角色由宿主调用上下文绑定，模型不能自行声明更高权限。

输出分为：

| 输出 | 谁消费 | 语义 |
|---|---|---|
| ProgressReport | TaskService / 只读视图 | 进度、等待原因与已知证据；不表示任务完成 |
| ToolRequest | Broker | 具体能力、参数、目标、effectId 或只读调用身份；由程序决定可否执行 |
| TaskResult | ResultVerifier | 对 completionSpec 的逐项依据、产物与 effect 引用 |
| Proposal | core | 内部变更建议；附 readSet、baseStateVersion、policyVersion、task/assignment/token；不含任意 SQL |
| HandBack / StopAck | TaskService | 超范围输入归还；已停止的执行范围及仍未核清动作 |

## 3. 执行流程

1. 领取当前 Assignment，核对租约、授权、暂停、预算及资源占用；发布前安装工具范围。
2. 构建最小上下文：任务、授权摘要、必要证据、当前读视图与历史未完成项。第三方内容保持来源标签，只作为资料。
3. 模型产生计划或工具请求；Broker 检查 capabilityId 及版本、设备身份、当前权限、参数、目标、资源锁和成本。
4. 纯读取也经 Broker 校验，记录调用回执；任何可观察副作用先创建 Effect 并落盘，再由 Dispatcher 执行。任意 shell / GUI 操作不能伪装成“只读工具”跳过账本。
5. 定期报告进度，等待输入 / 能力时让出 worker 槽；程序心跳不由模型控制。
6. 获得结果后提交 TaskResult / Proposal，释放确认可释放的资源。由核验器判断业务完成，core 单独决定内部变更。

任务工作目录是资源组织方式，不是安全沙箱。默认不向 worker 提供通用数据库访问、宿主配置写入、凭据读取或无限制执行器。需要通用 shell、浏览器或真实设备控制时，由能力目录绑定已批准的执行环境及 OS / provider 限制；未验证隔离前，只开替身和只读能力。

## 4. 工具权限接点与绕过防护

DSH 的 restrict/guard 必须在每个 Agent 的 setup 阶段配置，不依赖会话提示词。scope 自有工具注册可能绕开继承 allowlist，因此识雨 Broker 对自己的每个工具入口仍须复核 effective role、当前 Mandate、Effect 状态和 fencingToken；缺失 agent/role 上下文默认拒绝。插件扩展本身由受信任部署清单管理，不能允许模型动态注册 executor 或工具。

read-only 标签来自已核验的能力版本与参数约束，不直接相信远端宣称。文件读写同时带 deviceId 与规范资源引用；权限与路径检查在实际使用时执行。副作用操作的真实范围必须受执行宿主权限约束；无法强制约束时标为该能力未准入，而非把宽权限交给模型后希望它自律。

## 5. 并发、预算与上下文

后台上限初始 2 个 worker，由全局模型预算、资源互斥与 Task 优先级进一步限制。用户对话的低延迟路径由外层负责，不额外给 worker 绕过全局预算的无限槽位。

上游 WorkerSlots 为 person 路径允许额外一个槽；适配时该槽必须有独立预留且计入全局预算，或关闭此例外。继续复用原 starting/running 竞争控制，避免“限制变严格”成为重新造槽位管理器的理由。

一次 Task 的子工作必须继承更窄或相同 Mandate，使用父预算预留。首阶段默认最大委派深度 1、子任务数 4，超过则回 core 重新规划；不是自动递归创建 Agent。待验证后可调，不用新角色数量代表能力。

长任务使用 DSH 上下文管理与任务检查点；检查点包含未完成项、已完成 effectId、授权版本、证据引用和精确资源身份。摘要不能丢掉停止、范围收窄及已执行动作；恢复要回查权威记录而非仅信摘要。模型 fallback 仅限宿主已配置且满足相同数据外发约束的路由，不能因失败自动转发更多隐私数据。

## 6. 失败与恢复

- 模型或只读请求确定瞬时失败：在预算和期限内有限退避；恢复同一 Task 的新实例。
- 模型超时但可能已有工具副作用：先核对 effect 账本；不得把整个“思考—工具执行”轮次原样重放。
- 工具输出与预期不符：记录 evidence 与失败原因；未知能力不试探更大权限。
- 撤权 / 暂停 / 取消：阻止新工具效果、发停止信号、结束可中断推理；已发动作查回执。停止信号发送成功不等于设备已停止。
- 失联 / 租约到期：旧实例丧失提交资格；资源占用保持到执行端停止确认或可验证的 fencing 生效。复用 background 的 job/subagent 停止工具，并核对宿主版本支持；调用停止成功不代替远端实际停止回执。任务恢复统一经过 TaskRecoveryCoordinator，不与原 DshExecutor.resume 同时自主启动实例。
- 接到过时 Proposal：保留所指证据，拒绝直接提交；当前 core 如需采用，基于新视图重评。

## 7. 生命周期、验收与替代

工作目录按 Task 独立范围计量，终态后由数据策略决定回收；模型上下文、原始输出和最终产物分别保留，不以“调试”无限保存。令牌和凭据由专门设施注入执行器，不能进入模型历史或检查点。

全局验收见 [V10](<../../../../验证与验收.md#v10>)、[V11](<../../../../验证与验收.md#v11>)、[V23](<../../../../验证与验收.md#v23>)。下述数值是合成验证场景的初始配置，不是已测性能。

在 V10/V11 中尝试伪造角色、动态注册工具、用只读标签包装写入、使用旧 token 与越界路径：均应在真实入口拒绝且无副作用。验证对话高优先级响应不被两个后台 worker 永久饿死；取消后启动新动作数为 0，已在途动作以实际回执判断。V23 使用一个读取任务和一个替身写入任务，检查子任务预算汇总和检查点恢复不会重复外部动作。

若 DSH 工具范围 / 生命周期接点不能封闭绕过路径，主系统保持 A 的 core，但该执行能力改用成熟的隔离执行宿主或设备适配器；直到门槛满足前不启用真实副作用。不要另造 DSH Session / LLM loop。证据见 [来源记录](<../../../../../../research/2026-11-01-完整架构/任务与执行.md>)与[宿主核查](<../../../../../../research/2026-11-01-完整架构/宿主与依赖.md>)。

