# 插件生命周期

[全景目录](<../../../目录.md>) · [证据与版本](<../../../../../research/2026-11-01-完整架构/宿主与依赖.md>) · [验证与验收](<../../../验证与验收.md>)

- 更新：2026-11-01（America/Caracas）；原图模块 ID：`lifecycle`。
- 状态：完整架构的建议基线，待验证；未安装、运行或接入。A 的插件内核心由用户选定，其余技术为本轮规划选择。

## 主方案

[复用核查](<../../../../../research/2026-11-01-复用核查/宿主与依赖.md>)确认直接使用 DSH launcher/profile、Cordis inject/effect/disposer 与现有启动诊断。宿主已有 `engines.dsh` / peer 兼容预检，识雨声明需求并固定bundle即可，不再编写semver兼容器、插件装载器或HMR系统；受信包摘要仍是额外产品准入。已有 `sanitizeProfile` 可用于停止宿主后的配置恢复，复用官方入口，不复制配置修复器；它会备份profile patch并修改bundle清单，不是数据库恢复。

将识雨作为固定 DSH bundle 中的受信插件组合，通过 Cordis inject / effect / disposer 注册与释放服务。生命周期状态采用 `starting → recovering → ready → draining → stopped`；健康降级是 ready 的能力标记，必需持久化或权限服务失败则不进入 ready。

初始化先完成持久化版本与单实例检查，随后装载 CoreCommitService、角色 Guard、HostAdapter 与队列。Agent setup 在发布前完成工具与prompt配置。恢复中的 Task 先核对租约、Effect 和设备回执，再重新派工；不能把所有 running 任务自动改成待重试。

## 所有权与接口

插件组合持有服务实例、AgentHandle、timer、注册项和监听器的 disposer；使用顺序化复合 effect 按依赖逆序释放。健康快照输出实例 ID、启动代次、版本摘要、ready/degraded、待排空数、最近成功探测与失败原因；不把连接配置存在当作可用证明。

启动检查包括角色工具清单、executor来源、领域schema版本、数据库修复门槛、DSH API指纹、额外日志贡献关闭策略。检查只读取摘要和验证结果，不向模型暴露凭据或完整配置。

## 停止、重载与升级

1. 接到停用/升级/退出后阻止新接单与新派工，保留暂停意图。
2. 取消模型等待和扫描器，冻结未开始的 Effect 派发；通知正在执行的任务停止，保留可能已产生效果的未知状态。普通暂停 / 关机保留 pending 记录，只有明确取消或授权失效才转换终态。
3. 刷新领域写入与宿主 Session，再释放 Agent、工具、timer、数据库句柄。
4. 内部目标为 4 秒内排空；宿主当前优雅停止预算是 5 秒，超时由下次恢复核对，不无限延长关机。

本方案不对权威服务执行任意热更新。DSH 支持配置 HMR，但插件代码、schema、执行器或授权语义变化走维护模式和受控重启。升级前保留兼容恢复材料；schema迁移需要幂等、可中断和版本检查，旧二进制不能通过降低版本戳强读新数据。

## 失败与替代

依赖缺失、注册失败或迁移失败时注销已注册资源，保留诊断摘要并拒绝 ready。外部监督器依据明确的 desired state 和故障预算决定是否再启动；本插件不能复活已经退出的自身进程。host诊断日志可能含原始错误和配置值，导出前脱敏，保留按数据方案清理。

若目标版本 HMR 无法保证单实例与有序资源释放，则整个识雨 profile 重启；若Web生命周期行为与文档不符，使用固定版本替身保持契约验证，暂停真实宿主接入，不能带着未知行为继续上线。

## 验证与证据

V14 测试每个初始化阶段失败后的逆序释放、重复 dispose、ready前投递和晚到回调；V24 测试实际 SIGTERM、第二实例、卸载后timer数为0、停止中任务保持可核对、升级读旧库与拒读未知版本。

[DSH Agent创建与dispose](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/core.md>)、[CLI停止预算与诊断](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/apps/cli/reference/README.md>)为官方文档核查。恢复手段见[宿主外恢复](<../../../05-宿主外恢复/README.md>)；本轮未加载、卸载或升级任何插件。

