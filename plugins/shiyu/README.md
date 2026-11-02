# 识雨本体

`@shiyu/runtime` **0.1.0**。识雨的独立 DSH 插件包，采用宿主内权威核心的 A 方案。当前交付的是首个基础切片：运行仪表盘、受限原生 replyer Session 适配、持久事件/订阅基础与本地 embedding 适配。

**状态：首切片已有 51 项模块检查、11 项模拟宿主 UI 测试、本地 embedding 冒烟和限定真实 DSH 验证。** 本轮实际安装、两次零推理 Session 探针及一次禁用/启用后的暂停持久保持通过；尚无真实生成模型、压缩或缓存测量。core 判断、Goal/Task/worker 执行闭环、六部分内层及真实渠道尚未接入。完整结果与范围见[实施记录](<实施记录.md>)；九大系统进度见[实施与验证计划](<../../架构与设计/九大系统实施与验证计划.md>)。

本包不依赖 Lab 引擎或资料工作台作为运行能力。`lab/` 继续作为独立被测环境，`plugins/shiyu-workbench/` 完整保留。

## 当前可用代码

| 部分 | 已实现范围 | 当前边界 |
|---|---|---|
| Host 与运行状态 | DSH 插件入口、只读状态路由、`shiyu_status` 工具、显式运行命令与卸载清理 | 本轮原生安装及一次禁用/启用验证通过；无独立 Web 服务，不等于完整生命周期压力验收 |
| 运行仪表盘 | 总览、当前工作、活动、九系统状态、事件/订阅、Session 详情、诊断；中英文、主题及窄屏布局 | 使用结构化运行快照；模型/缓存用量缺失显示未知；测试界面的合成内容不进入生产默认状态 |
| replyer Session | 专用原生 preset、创建/恢复前模型校验、空工具与执行 guard、稳定业务/scope 绑定、取消与释放 | 原生零推理创建/flush/释放/归档已测；真实回复、业务恢复/压缩仍待验，没有 core/worker 调度或消息外发 |
| 事件与订阅 | 类型目录、发布、订阅增删改查、有限回放、投递领取/确认/失败、重试和统计；事件与匹配投递同事务提交 | 可信组件消费和 Agent background 持久引用；尚无 Agent 事件工具或原生 Session 自动续接 |
| 本地状态与数据库 | 单实例运行状态锁、暂停与 Session 绑定保存；SQLite 独立 WorkerThread、具名命令、持久事件及租约恢复 | 尚无原生 inbox/请求结果对账；正常重载与文件同步错误注入不代替完整断电/灾难恢复；事件库不是完整任务账本 |
| embedding | 固定 Harrier Q8_0 文件身份、1024 维向量、query 前缀、归一化、显式 loopback HTTP 适配 | 本地真实冒烟通过；未接记忆、索引或检索业务，未安装常驻 embedding 服务 |

仪表盘查看/刷新只读取状态，不自动创建 Session、发布事件或调用模型。可见时每 10 秒刷新，页面隐藏时停止轮询；读取失败保留上次快照并标记状态未确认。显式“检查会话接入”执行零推理探针；暂停/恢复控制新模型操作，不声称回滚已经发生的效果。

## 构建与本地检查

在本包目录使用锁文件安装开发依赖，再执行检查：

```sh
npm ci
npm run check
npm run test:ui
```

`check` 依次进行 TypeScript 检查、模块测试、构建和 Client JavaScript 语法检查。UI 测试使用模拟 DSH 的本地夹具，说明见[UI 验证目录](<tests/ui/README.md>)。它不能替代原生宿主验收，也不会调用生成模型。

包声明 Node `>=24.19.0 <25`、DSH `>=0.2.1-rc.5 <0.3.0`；这是兼容目标，不是所有版本已经实测。运行时记录实际 SQLite 版本：达到本仓库 WAL 修复基线才使用 WAL，否则选择 DELETE 并报告原因；使用 `synchronous=FULL`、外键和 5 秒 busy timeout。完整 V01/V15 门槛仍须按[验收方案](<../../架构与设计/A方案全景/验证与验收.md>)补齐。

## 宿主装载与操作边界

[包声明](<package.json>)的 Host 入口为构建后的 `dist/index.js`，Client 为 `client/index.js`，装载声明见[cordis.patch.yml](<cordis.patch.yml>)。本轮已通过 DSH 原生插件管理界面，以本地目录安装并启用 0.1.0；识雨、工作台与健身房在侧栏并存。宿主包静态核对为 DSH 0.2.1-rc.5，运行时实读 SQLite 3.53.4 / WAL / 独立线程；限定运行过程及已验源码摘要见[宿主证据](<artifacts/host-validation.json>)。

宿主 `connection` 接口承载以下路径，不另开网络监听：

| 入口 | 用途 |
|---|---|
| `GET /api/shiyu/state` | 只读运行快照；与 `shiyu_status` 使用同一服务 |
| `POST /api/shiyu/commands` | 显式 `runtime.pause`、`runtime.resume`、`session.probe` 或 `reply.generate`；JSON 正文上限 64 KiB |

`reply.generate` 是当前本地 owner 范围的开发入口：传入业务标识及文本，返回 `status=draft`、`sent=false`。它会发起模型请求，界面刷新和会话探针不会。当前没有多用户授权管理、渠道收发或外部 Effect 派发，不能将这个入口当作完整聊天产品或通用任务执行工具。

## Session 与模型

默认路由为用户现有 `opencode-go / deepseek-v4.1-flash`，replyer effort 为 `low`；模型配置先经宿主解析，实际结果随 Session 绑定保存。当前适配支持 `low/high/max`，不增加另一套凭据或修改宿主全局模型。代码中的 core/worker 默认选择只是后续角色配置，不能据此认为角色执行已实现。

绑定键包含 role、businessId、scope；同一 replyer 绑定串行复用原生会话，不在本地复制模型历史。原生 Session 日志与压缩由 DSH 管理，当前实现只记录业务绑定和本轮观察结果。完整 conversationGeneration、发送门禁、原生压缩和缓存复用效果仍待后续验收。

零推理探针创建受限 Session，检查组装后工具为空，flush 原生持久化，再释放并归档；两次实际探针均收到 `ready/noModelCalled/released/archived` 确认。归档不删除 Session，所有者可显式取消归档；探针不用于真实业务续接。重载将旧探针标为历史，当前可用性重新保持未知，直到本次探针成功。实际请求默认最多一个模型步骤、输出上限 4096、120 秒超时；这些是适配边界，不构成完整跨角色预算账本。未取得 token/缓存字段时保留未知，不将缺失统计记作零。

## 数据位置

`dataDir` 可显式配置为绝对路径；默认是本包被忽略的 `.local/runtime/`。当前实际布局为：

```text
<dataDir>/
├── runtime-state.json       暂停状态、Session 绑定与最近探针结果
├── control/events.sqlite    事件、订阅及投递；附属日志依 SQLite 模式产生
└── workspaces/              受限 Session 的工作目录
```

运行状态只保存业务绑定，不是第二套 Session 日志。DSH 的模型历史仍在宿主原生持久层。本地开发数据、依赖、构建、UI 输出由[.gitignore](<.gitignore>)排除；正式数据目录按部署配置另行登记。当前没有完整检查点、独立备份或旧备份恢复入口。

## 本地 embedding

[embedding 适配](<src/adapters/embedding/index.ts>)使用已核对的 `microsoft/harrier-oss-v1-0.6b` Q8_0、1024 维 profile；模型文件 SHA256、固定来源 revision、前缀和向量规范见[实测证据](<artifacts/embedding-validation.json>)。它只接受显式 loopback IP/端口的 `/v1/embeddings`，禁止重定向、凭据 URL 与远端地址；构造客户端不会启动服务或发请求。本轮 smoke 校验了它启动的 server 与本地文件，通用 HTTP 客户端不能仅凭响应证明任意配置的 loopback 服务实际加载了该文件。

[embedding-smoke.ts](<scripts/embedding-smoke.ts>)只使用已有且身份匹配的 GGUF 和 llama-server，可在明确的本地验证范围运行：

```sh
node --import tsx scripts/embedding-smoke.ts /path/model.gguf /path/llama-server
```

脚本设置 120 秒取消期限并执行退出清理，文件哈希等未接取消信号的步骤不构成严格端到端硬超时；结束关闭它启动的服务，不会下载模型或安装常驻项。本轮仅测 3 条合成文档、2 条查询和 1 条重复输入，2/2 查询首位正确，不是用户原有 102 查询评测的复跑，也不等于长期记忆或完整语义检索已经上线。

## 实际源码入口

```text
src/index.ts                         Host 路由、状态工具、装载/卸载
src/runtime.ts                       运行快照、显式命令与服务组装
src/contracts/events.ts              事件、订阅、回执与可信主体契约
src/control/events/index.ts          组件共用事件服务
src/adapters/control-store/          SQLite Worker、协议与主线程代理
src/adapters/dsh/sessions.ts          受限原生 replyer Session 适配
src/adapters/embedding/index.ts       本地 Harrier 适配
src/recovery/local-state.ts          运行状态锁与持久绑定
src/health/systems.ts                九系统实际接入状态
client/index.js                      原生仪表盘
locale/ · assets/                    中英文及图标
tests/*.test.ts · tests/ui/          模块测试与模拟宿主 UI 测试
scripts/embedding-smoke.ts           有界本地真实 embedding 探针
artifacts/embedding-validation.json  已检查的合成实测摘要
artifacts/host-validation.json       首切片真实宿主过程、测试汇总与源码摘要
vendor/dsh-superagent/               后续任务域复用材料，尚未接入首切片
```

第三方来源与本地修改由[来源说明](<THIRD_PARTY_NOTICES.md>)维护。阶段 2 的任务/事务适配正开始实施；新增代码在完成集成和验证前不计入上述首切片能力或 51 项成绩。完整规划树仍见[本体文件树规划](<../../架构与设计/识雨本体文件树规划.md>)，不把未创建路径当作已经完成的模块。
