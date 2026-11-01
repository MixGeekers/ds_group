# 工具与权限

[全景目录](<../../../目录.md>) · [证据与版本](<../../../../../research/2026-11-01-完整架构/宿主与依赖.md>) · [验证与验收](<../../../验证与验收.md>)

- 更新：2026-11-01（America/Caracas）；原图模块 ID：`tool-policy`。
- 状态：完整架构的建议基线，待验证；未安装、运行或接入。A 的插件内核心由用户选定，其余技术为本轮规划选择。

## 主方案与信任边界

[复用核查](<../../../../../research/2026-11-01-复用核查/宿主与依赖.md>)已直接阅读固定 DSH 的 `packages/core/tools/src/index.ts`：register/restrict/resolve/guard/checkGuards/setExecutor/execute 都由宿主提供。直接依赖这些公共 API、native executor 和既有审批设施；删除第二套工具 registry、通用executor、schema子集验证器和审批UI计划。保留代码仅为识雨的当前授权/资源/fence判断及Effect入口；作用域不等于硬沙箱并不构成重造工具框架的理由。

复用 DSH `defineTool`、native executor、权限预设、sandbox、`tools.restrict` 和 `tools.guard`，只补识雨的能力注册准入和 EffectBroker。这里的 broker 是 EffectDispatcher 面向工具的窄入口，不是第二个授权或派发中心。A 为同进程受信插件组合；这些接口是可检查的逻辑边界，不能阻止恶意同进程插件直接读文件或调用网络。

工具登记必须包含工具/实现版本、输入输出 schema、效应类型、资源范围、幂等或查询策略、取消能力、超时和 provider 摘要。启动和升级时进行注册准入；未准入工具、动态扩大 scope 的注册、自定义 executor、直接 PTC 任意执行入口不进入角色工具集。

## 两层执行检查

1. Agent 发布前在 setup 中设置继承工具 allow-list，并配置系统提示中的角色能力。replyer 默认无工具或只有 ReadView 查询；core 无原始写库工具；worker 仅有 Assignment 对应的 broker 工具。
2. 每次调用进入最终 Guard 和 broker，重新读取可信角色绑定、Mandate 版本、任务状态、fencing token、资源范围、期限及预算。模型提交的 `role` 或 `approved=true` 不是凭据。
3. 副作用由业务事务登记 Effect 后才能发送。适配器结果返回 Receipt，未知结果保留为 unknown，不视作未执行。

DSH `ToolRestriction` 只筛选继承工具，scope 自己注册的工具被豁免；自定义 executor 也可能不经过默认执行管线。因此最终 broker 检查不能只依赖提示词或工具列表。缺少可信 Agent 绑定的调用默认拒绝，宿主内部维护操作使用单独程序身份与最小能力集合。

## Schema、系统权限与副作用

DSH 工具 schema 是受限 JSON Schema 子集；不支持的关键字会被拒绝。识雨全量消息契约可使用 Ajv 2020-12，工具适配须显式投影到 DSH 子集，再校验返回领域对象；不能宣称 schema 可原样跨两种验证器共享。禁止校验器通过隐式类型转换修改调用意图。

本地 worker 使用受限工作目录与原生 sandbox，领域数据库、凭据和配置不在任务写范围。DSH 默认 workspace-write 并不全面限制读取和网络；因此 replyer 不暴露文件/网络工具，worker 网络和私有资源范围必须通过所选执行后端实际验证。需要运行不受信插件或代码时另加成熟进程/容器隔离，不把所有代码放入主宿主后宣称安全。

## 失败与验证

授权撤销、资源不匹配、schema错误与新旧 fencing 冲突均在执行前拒绝并记原因；执行中撤权请求取消，不能保证所有外部效果被撤销，随后核对 Receipt。sandbox不可用时拒绝需要隔离的能力，不降为全权限。

V04/V14 验证 scope-own 新工具、同名替换、custom executor、agentless、PTC子调用、路径别名、迟到执行、授权撤回均不能绕过 broker；V24 验证固定 DSH 实际组合。测试必须覆盖允许的正常动作和拒绝的越界动作，不以只验证“工具按钮隐藏”作为通过。

## 证据

[工具 registry、restriction、Guard 与 schema](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/tools.md>)、[权限预设与限制](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/permission-presets.md>)和[CLI 默认权限范围](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/apps/cli/reference/README.md>)为官方文档核查；本轮没有完成操作系统级隔离实测。

