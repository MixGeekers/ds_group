# 识雨本体

`@shiyu/runtime` **0.1.0**。识雨的独立 DSH 插件包，采用宿主内权威核心的 A 方案。当前已有运行仪表盘、受限原生 replyer/worker、持久事件，以及带授权预算、效果回执和独立核验的本地任务链路；本地 embedding 尚未连接记忆业务。

**状态：阶段 2 的本地任务链路已在真实 DSH 跑通，限定模块复验 198/198、模拟宿主 UI 39/39 通过。** 第二个有界合成任务完成受理、原生 worker、产物/Effect 独立核验和预算结算；第一次因缓存用量口径失败的 unknown 记录完整保留。首切片 `6b7dff5` 的 51/11 项与 Harrier/宿主证据继续作为历史快照；另有两轮真实 replyer 同 Session 验证，401 tokens 仅为主请求报告值，旁路费用未知。core、原生 Goal 运行接入、六部分内层和真实渠道仍未接入。分批结果见[实施记录](<实施记录.md>)与[九系统计划](<../../架构与设计/九大系统实施与验证计划.md>)。

本包不依赖 Lab 引擎或资料工作台作为运行能力。`lab/` 继续作为独立被测环境，`plugins/shiyu-workbench/` 完整保留。

## 当前可用代码

| 部分 | 已实现范围 | 当前边界 |
|---|---|---|
| Host 与运行状态 | DSH 插件入口、只读状态路由、`shiyu_status` 工具、显式运行命令与卸载清理 | 原生安装与限定禁用/启用验证已有证据；无独立 Web 服务，不等于完整生命周期压力验收 |
| 运行仪表盘 | 总览、当前工作、活动、九系统状态、事件/订阅、Session、任务完成条件与独立核验详情、显式诊断；中英文、主题及窄屏布局 | 使用结构化运行快照；受理不显示为成功，unknown 与停止请求独立显示；缺失用量保留未知 |
| replyer Session | 专用原生 preset、创建/恢复前模型校验、空工具与执行 guard、稳定业务/scope 绑定、取消与释放；显式两轮真实模型验证入口 | 零推理探针和两轮代号回忆已测；业务恢复/压缩及完整缓存收益仍待验，没有渠道外发 |
| 任务与 worker | 本地 owner 创建 Task/Assignment，原生 worker 使用受控单工具写固定产物；绑定先持久化，资格按宿主/安装世代、fence、租约及授权复查 | 修复后第二个有界真实任务通过；首轮结算失败保留 unknown；没有 core 自主派工或通用文件/设备权限 |
| 授权、效果与核验 | Mandate/CAS、原子预算预留、Effect 领取/回执/不确定性、独立产物 SHA256 核验；完成状态与完成事件同事务 | 目前只接固定本地合成任务；取消不假称效果回滚，旧实例及 unknown 不自动重派，多用户与外部设备尚未接入 |
| 事件与订阅 | 类型目录、发布、订阅增删改查、有限回放、投递领取/确认/失败、重试和统计；事件与匹配投递同事务提交 | live 路径为可信组件消费和 Agent background 引用；Agent 事件工具工厂已实现并合成验证，但尚未挂载到原生 Session，未自动续接 |
| 本地状态与数据库 | 单实例运行锁、暂停与 Session 绑定保存；SQLite 独立 WorkerThread，事件、Task/Assignment、Mandate/预算及 Effect 共用连接与事务 | 尚无原生 inbox/请求结果完整对账；正常重载、事务/文件故障注入和限定子进程退出不代替完整断电/灾难恢复 |
| embedding | 固定 Harrier Q8_0 文件身份、1024 维向量、query 前缀、归一化、显式 loopback HTTP 适配 | 本地真实冒烟通过；未接记忆、索引或检索业务，未安装常驻 embedding 服务 |

仪表盘查看/刷新只读取状态，不自动创建 Session、发布事件或调用模型。可见时每 10 秒刷新，页面隐藏时停止轮询；读取失败保留上次快照并标记状态未确认。显式“检查会话接入”执行零推理探针，“验证模型与会话复用”发送两轮合成输入，“运行本地任务验证”受理固定合成任务并交后台执行。暂停关闭新操作并取消在途模型，不声称回滚已经发生的效果。

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
| `POST /api/shiyu/commands` | 显式 `runtime.pause`、`runtime.resume`、`session.probe`、`session.verify-model`、`reply.generate`、`task.createLocal` 或 `task.cancel`；JSON 正文上限 64 KiB |

`reply.generate` 是当前本地 owner 范围的开发入口：传入业务标识及文本，返回 `status=draft`、`sent=false`。它会发起模型请求，界面刷新和会话探针不会。当前没有多用户授权管理、渠道收发或外部 Effect 派发，不能将这个入口当作完整聊天产品或通用任务执行工具。

## Session 与模型

默认路由为用户现有 `opencode-go / deepseek-v4.1-flash`，replyer effort 为 `low`，受限本地 worker 为 `high`；模型配置先经宿主解析。当前适配支持 `low/high/max`，不增加另一套凭据或修改宿主全局模型。core 的默认选择仍是后续配置，当前没有 core 模型运行链。

绑定键包含 role、businessId、scope；同一 replyer 绑定串行复用原生会话，不在本地复制模型历史。原生 Session 日志与压缩由 DSH 管理，当前实现只记录业务绑定和本轮观察结果。完整 conversationGeneration、发送门禁、原生压缩和缓存复用效果仍待后续验收。

零推理探针创建受限 Session，检查组装后工具为空，flush 原生持久化，再释放并归档；两次实际探针均收到 `ready/noModelCalled/released/archived` 确认。归档不删除 Session，所有者可显式取消归档；探针不用于真实业务续接。重载将旧探针标为历史，当前可用性重新保持未知，直到本次探针成功。实际请求默认最多一个模型步骤、输出上限 4096、120 秒超时；这些是适配边界，不构成完整跨角色预算账本。未取得 token/缓存字段时保留未知，不将缺失统计记作零。

`session.verify-model` 每次显式运行最多 2 个顺序主生成请求，每轮输出上限 1024 tokens。第一轮给出随机合成代号，第二轮不重发代号而询问；程序同时核对同一 Session ID 和第二轮准确答案。适配器没有自动重试，宿主/provider 的传输重试次数未独立观察；原生自动标题等旁路也不由主步骤数代表，因此 `calls=2` 不等于整个 Session 的模型请求数、两次底层 HTTP 请求或完整费用上限。合成文本实际发送给已配置的生成模型，没有向外部聊天渠道发送消息或执行设备动作。

本次结果为同 Session 验证通过，两轮主请求由宿主报告输入 351、输出 50、合计 401 tokens，见[模型增量证据](<artifacts/model-validation.json>)。后续精确 Session 审计发现另有 2 次无用量报告的自动标题请求，因此整个 Session 费用未知。cacheRead/cacheWrite 均未报告；宿主适配静态核查显示缓存读取只在正值时输出，缺失可能是 0 或 provider 未报，不能补零、认定未命中或计算命中率。Session 行的用量是最近一轮，全局用量仍保留未知。这个两轮样本不是完整 V25、业务重启恢复、长上下文或压缩测试。

## 本地任务链路

`task.createLocal` 按 `requestId` 幂等受理本地 owner 任务，正文最多 1024 UTF-8 字节。界面入口的请求 ID 在同一运行实例内固定；受理回执不等于成功，任务页随后读取真实账本。后台执行不依附单次 HTTP 请求，暂停期间已提交的受理仍返回确认，恢复后只调度本实例尚未领取的任务；重启后的未完成执行保留 unknown，等待核对。

每个任务的预算轴预留为 16384 总 tokens、2 次原生模型调用、1 个产物效果；本地 worker 执行配置另限制为最多 2 步、合计 1024 输出 tokens、120 秒取消期限。步骤数与模型调用数不是同一概念，压缩或观测不齐时不靠步骤数补造完整用量。worker 仅获得 `shiyu_worker_write_note`，只能写该任务预登记正文到专属 `note.txt`，没有任意路径参数。工具执行与结果返回前复查资格；先记录 Effect，再在数据库事务之外写文件，随后独立读取字节和 SHA256。只有可信核验确认完成条件才将 Task 记为 succeeded，模型摘要本身无完成权。

产物写入不覆盖既有不同内容，支持相同内容幂等核对；暂停、异常或失去回执后保留已观察事实。首次真实任务因缓存计数口径结算失败，另有一次未报告用量的标题旁路，失败原样保留。修复后只关闭识雨自有 Session 的自动标题，未更改用户其他会话；第二个新任务 **succeeded**，原生记录为 2 个主调用、0 标题/压缩/失败 attempt，产物 92 字节及 SHA256 一致。预算按宿主总量结算 **1699 tokens、2 calls、1 effect**，无超额；其中两次 cacheRead 均为 512，合计 1024。详情见[任务证据](<artifacts/task-validation.json>)。这不代表完整重启对账、原生 Goal、外部效果或长期任务已验收。

用量保留每次脱正文的原生观测与计账依据：可信宿主 total 优先；total 缺失时，只有 input/output/cacheRead/cacheWrite 四项全部显式提供才求和。缺字段、压缩或调用观测不齐时不补零、不按 steps 代替 calls，预算继续保留等待核对。provider 内部传输重试仍不在可观察原生调用数内。

## 数据位置

`dataDir` 可显式配置为绝对路径；默认是本包被忽略的 `.local/runtime/`。当前实际布局为：

```text
<dataDir>/
├── runtime-state.json       暂停状态、Session 绑定、最近探针与模型验证结果
├── control/events.sqlite    事件、订阅、Task/Assignment、Mandate/预算与 Effect/Receipt
└── workspaces/
    └── <taskId>/artifacts/note.txt  当前受限任务的固定产物；其余为受限 Session 工作目录
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
src/control/tasks/                   TaskFacade 与局部复用的 Superagent 任务核心
src/control/policy/mandates.ts        可信授权、预算预留与结算
src/control/effects/                 Effect 账本、回执、执行资格与 unknown
src/control/task-runner.ts           原生 worker 与本地产物任务编排
src/adapters/control-store/          SQLite Worker、协议与主线程代理
src/adapters/dsh/sessions.ts          受限原生 replyer Session 适配
src/adapters/dsh/workers.ts           受限原生 worker、工具与执行资格
src/adapters/dsh/session-title.ts     识雨自有 Session 的固定标题与旁路限制
src/adapters/dsh/event-tools.ts       Agent 事件工具工厂，尚未挂载运行 Session
src/adapters/artifacts/              固定路径产物写入与独立读取
src/adapters/embedding/index.ts       本地 Harrier 适配
src/recovery/local-state.ts          运行状态锁与持久绑定
src/health/systems.ts                九系统实际接入状态
client/index.js                      原生仪表盘
locale/ · assets/                    中英文及图标
tests/*.test.ts · tests/ui/          模块测试与模拟宿主 UI 测试
scripts/embedding-smoke.ts           有界本地真实 embedding 探针
artifacts/embedding-validation.json  已检查的合成实测摘要
artifacts/host-validation.json       首切片真实宿主过程、测试汇总与源码摘要
artifacts/model-validation.json      后续两轮真实生成、Session 复用与用量证据
artifacts/task-validation.json       本地任务实际成败、独立产物、回执与原生用量
artifacts/phase2-offline-validation.json  阶段 2 限定测试批次、命令及测试源码摘要
vendor/dsh-superagent/               未修改的上游证据基线，独立于运行时适配
licenses/                           随发布包保留的第三方完整许可
```

第三方来源与本地修改由[来源说明](<THIRD_PARTY_NOTICES.md>)维护。修复后的阶段 2 限定 **16 个测试文件、198/198 通过**，同时通过当前源码树类型检查、构建与 Client 语法检查；完整 UI 为较早的 39/39 批次，其后 Client 未变更。188 项为首次实跑前的历史批次，不与 198 累加；UI 也不与早先 11/23 项累加。阶段 3 conversations/goals/memory/ombre/views 未计入阶段 2 模块批次，尚未接入 Runtime。完整规划树仍见[本体文件树规划](<../../架构与设计/识雨本体文件树规划.md>)。
