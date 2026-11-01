# DSH 运行底座

[全景目录](<../../目录.md>) · [证据与版本](<../../../../research/2026-11-01-完整架构/宿主与依赖.md>) · [验证与验收](<../../验证与验收.md>)

- 更新：2026-11-01（America/Caracas）；原图区域 ID：`foundation`。
- 状态：完整架构的建议基线，待验证；未安装、运行或接入。A 的插件内核心由用户选定，其余技术为本轮规划选择。

## 方案与复用范围

六模块的[精确复用清单](<../../../../research/2026-11-01-复用核查/宿主与依赖.md>)已给出公共API、固定源码、MIT许可与复制边界。模型/工具/调度/生命周期直接依赖DSH；领域事务优先局部复用Superagent现成内核并补已查明失败路径。HostAdapter只是业务边界调用，不建设第二宿主、通用工具/事件/存储平台。

以薄 `HostAdapter` 隔离识雨领域和 DSH API，保留 DSH 原生 Agent loop、模型 adapter、工具管线、Session persistence、Cordis effect 生命周期。适配层只做角色配置、身份映射、预算与契约校验，不重写这些基础能力。

| 子模块 | 宿主复用与识雨补充 |
|---|---|
| [模型与会话](<01-模型与会话/README.md>) | 复用 `ctx.agents.create/resume`、`ctx.sessions.flush`、模型路由与重试；补充角色预算和业务 ID 绑定 |
| [工具与权限](<02-工具与权限/README.md>) | 复用 `defineTool`、scope restriction、最终 Guard、native executor；补充注册准入与 EffectBroker |
| [事件与定时](<03-事件与定时/README.md>) | 复用 Cordis 事件、timer 和 DSH Schedule；领域 inbox/outbox 承担可靠性 |
| [持久化接口](<04-持久化接口/README.md>) | DSH 保存自身 Session；宿主内专用 DB 线程和 SQLite 薄仓储负责领域跨表事务及基线 FTS5 同步更新 |
| [插件生命周期](<05-插件生命周期/README.md>) | 复用 inject、setup、effect/disposer；补充迁移门控、就绪状态和排空顺序 |

## 统一适配契约

下列名称是识雨适配接口，不冒充 DSH 自带 API：`createRoleSession(role,binding)`、`runModel(request,budget,signal)`、`invokeEffect(effectId)`、`publishEvent(eventId)`、`wakeDueGoals(now)`、`flushAndDispose(deadline)`。输入只接受已校验对象；输出包括 request/session/attempt ID、终止原因和可核对用量，错误按配置、授权、瞬态依赖、结果未知、持久化失败分类。

领域事件和数据库事务不依赖 DSH Session 顺序；Session ID 是推理执行绑定，不能代替 Goal、Task 或 Assignment ID。副作用必须先有业务 Effect，再经过当前授权检查；不允许直接绕过 broker 调工具。

## 验证与失败处置

V14 以确定性替身逐项验证适配，不调用真实模型；V24 才把替身替换为固定 DSH。配置、工具准入、schema 或持久化检查失败时，相关服务不发布 ready。模型故障只降低推理可用性，领域写入故障则停止新副作用。版本升级需要完成全套契约回归并保存回滚清单，不凭 semver 自动升级。

