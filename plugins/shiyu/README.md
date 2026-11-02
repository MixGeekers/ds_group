# 识雨本体

`@shiyu/runtime` **0.1.0**。识雨的独立 DSH 插件包，采用宿主内权威核心的 A 方案。当前已有运行仪表盘、受限原生 core/replyer/worker、持久事件，以及带授权预算、效果回执和独立核验的本地目标、任务与记忆链路。

**状态：3G 已通过一个真实合成便签闭环及完成后重载核对。** owner 明确指定范围、共享预算与期限后，core 提出候选，控制域接纳 Task，worker 执行，独立核验后完成原生 Goal。两轮 Core 复用同一 Session；主模型记录合计 3813 reported tokens、4 次调用、1 次效果，完成后无剩余预留。首次失败 A 的取消与 unknown 保留，新样本 B 不改写其结果。见[成功证据](<artifacts/phase3g-core-host-success.json>)、[首次失败](<artifacts/phase3g-core-host-validation.json>)、[兼容修复](<artifacts/phase3g-required-context-fix.json>)及下方 [3G 说明](#3g有界-core-与本地目标)。这仍是有限授权事项推进，不是开放式规划或九系统整体验收。

**3F 历史验证：** 3E 已完成限定 DSH 保存、精确读回、有序重载和本地撤回；3F 新增受控 Harrier 生命周期、单独授权的索引操作、同对话语义检索、原生记忆 ReadView 与零推理背景加载。记忆已进入 Session 后，撤回会封存旧绑定并切换安全代次；正常消息继续复用 Session。记忆正文只存原生普通桶，控制库与后端 journal 只存其元信息，撤回不代表物理删除。schema1 配置继续关闭 embedding，schema2 才显式启用受控 Harrier；其余五个内层域仍 unavailable。3F 当时 676 模块、59 Python、154 UI 通过；真实隔离 Harrier 20 次 embedding，宿主两次零推理加载确认了撤回前复用与撤回后新 Session 不含撤回正文。固定标题及恢复标记另作解释，宿主内部查询完整用量未知；分批结果、失败与未覆盖范围见[实施记录](<实施记录.md>)及[九系统计划](<../../架构与设计/九大系统实施与验证计划.md>)。

本包不依赖 Lab 引擎或资料工作台作为运行能力。`lab/` 继续作为独立被测环境，`plugins/shiyu-workbench/` 完整保留。

**3H 新增：受控 Lab 连续对话。** owner 显式指定 run、获准频道、预算和期限后，通过健身房公共目标协议接收输入，按 run/channel 复用 DSH 原生 replyer，核对当前草稿与授权后发送。发送实际回执、草稿完成和调用账目分别记录；结果未知只查询既存回执，不重复发送。当前仅有离线模块、真实临时数据库、公共协议替身及模拟 UI 验证；没有为此重载真实宿主、调用模型或操作真实 Lab 房间。具体结果见[实施记录](<实施记录.md>)。

## 当前实现与限定验证

| 部分 | 已实现范围 | 当前边界 |
|---|---|---|
| Host 与运行状态 | DSH 插件入口、只读状态路由、`shiyu_status` 工具、显式运行命令与卸载清理 | 原生安装与限定禁用/启用验证已有证据；无独立 Web 服务，不等于完整生命周期压力验收 |
| 运行仪表盘 | 总览、目标与判断、当前工作、活动、九系统状态、事件/订阅、Session、任务核验、显式诊断和记忆操作；中英文、主题及窄屏布局 | 目标候选、接纳任务、原生观察及命令回执分别显示；受理不显示为成功，unknown 与缺失用量保留未知 |
| 有界 core | owner 明确登记 local-note 范围、依赖、预算与期限；可信触发、判断预留、原生候选、同事务 Task 接纳和独立完成证明 | 一个真实便签闭环及重载不重放已验；模型只能选择已授权便签 ID，没有任意任务、记忆写入、设备或外部渠道权限 |
| replyer Session | 专用原生 preset、空工具、稳定业务/scope 绑定、单主调用观测与实际账目、取消与释放 | 历史原生探针和两轮代号回忆已测；3H 新主调用门及 Lab 路径仅离线验证，业务压缩与完整缓存收益待验 |
| 任务与 worker | owner 本地任务及 3G 已授权便签委托复用 Task/Assignment；原生 worker 只写固定产物，派发资格持续复查 | 历史有界任务及 3G core 派工各有限定真实成功证据，首次 unknown 保留；没有通用文件或设备权限 |
| 授权、效果与核验 | Mandate/CAS、原子预留、Effect 与独立产物核验；3G 判断与派生 Task 共用同一 Goal 授权及预算 | 不以模型候选或 `task.createLocal` 代替 owner 授权；取消不回滚已发生效果，旧实例与 unknown 不自动重派 |
| 原生 Goal 生命周期 | 原生 Goal 绑定/CAS/命令历史、独立完成证明；历史零推理诊断保留，3G 另用专用 Goal Session 执行有界判断 | 原生日志拥有 phase/revision；普通判断 followup 不计为原生 Goal driver round；旧观察不覆盖 pending/unknown 命令事实 |
| 本地对话与背景 | 同库稳定 Conversation/Topic/回复绑定、Task 关联、可信完成事件投影、有界扫描；显式本地上下文回复与验证 | 背景消费者不调用模型；Event ack 不等于加载，显式回复须原生持久回执才 ackContext；无渠道发送 |
| Lab 连续对话 | 最多 20 个获准群聊/私聊、原生 Session、输入去重与纠正失效、共享容量、预算、Effect 发送及只读回执核对 | 仅文本 message.send；不开放文件、Office、任务完成或管理操作，不自动注入跨对话记忆；真实房间业务验收待做 |
| 发布与受限视图 | schema2 按实际依赖发布 memory 读取能力，其余五域 unavailable；Task 与 native-memory ReadView、独立删除屏障及最终双校验 | 30 秒 capture，正文异步精确读取前后重核；只读接口不保存记忆，版本不与 commitSeq 或索引水位混用 |
| 事件与订阅 | 类型目录、发布、订阅增删改查、有限回放、投递领取/确认/失败、重试和统计；事件与匹配投递同事务提交 | live 路径为可信组件消费和 Agent background 引用；Agent 事件工具工厂已实现并合成验证，但尚未挂载到原生 Session，未自动续接 |
| 本地状态与数据库 | 单实例运行锁、暂停与 Session 绑定保存；SQLite 独立 WorkerThread，事件、Task/Assignment、Mandate/预算及 Effect 共用连接与事务 | 尚无原生 inbox/请求结果完整对账；正常重载、事务/文件故障注入和限定子进程退出不代替完整断电/灾难恢复 |
| 记忆控制与后端接缝 | 普通桶保存/精确读、共享授权与 Effect、独立索引回执、候选先授权后排序、可能暴露来源登记及撤回失效传播 | 同 Conversation、local-owner；不自动选取聊天正文，无普通物理删除/CAS、自主整理或跨对话分享 |
| embedding | 固定 Harrier Q8_0、主程序与动态库身份、1024 维/head2000 profile；受控随机 loopback、临时鉴权、随 Runtime 清理 | 显式索引与搜索才请求向量，保存/状态刷新零 embedding；启动健康与 profile 核对不冒称模型实测或全量索引完成 |

仪表盘查看/刷新只读取状态，不自动创建 Session、发布事件或调用模型。可见时每 10 秒刷新，页面隐藏时停止轮询；读取失败保留上次快照并标记状态未确认。显式“检查会话接入”执行零推理探针，“验证模型与会话复用”发送两轮合成输入，“运行本地任务验证”受理固定合成任务并交后台执行。暂停关闭新操作并取消在途模型，不声称回滚已经发生的效果。Conversation 的纯背景标记仍可落库，本身不请求模型或发送消息；3G core 另在已有 owner 授权内消费可信触发并进行有界判断，页面轮询不驱动这条链路。

“检查原生 Goal 生命周期”使用已成功的本地任务重新读取产物和可信回执，依次检查 create/pause/resume/complete。它不请求模型推理；原生旁路是否确实为零另以宿主事件核对。已有 Goal 绑定或执行中断时要求显式核对，按钮不会自动重放整个序列。

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
| `POST /api/shiyu/commands` | 显式 `runtime.pause`、`runtime.resume`、`session.probe`、`session.verify-model`、`reply.generate`、`task.createLocal`、`task.cancel`、`goal.verify-lifecycle`、`conversation.linkLocalTask`、`conversation.replyLocal`、`conversation.verifyContext`、`conversation.loadContext`、`memory.rememberLocal`、`memory.readLocal`、`memory.withdrawLocal`、`memory.indexLocal`、`memory.searchLocal` 及下方四个 `core.*` 命令；JSON 正文上限 64 KiB |

`reply.generate` 是当前本地 owner 范围的开发入口：传入业务标识及文本，返回 `status=draft`、`sent=false`。它会发起模型请求，界面刷新和会话探针不会。当前没有多用户授权管理、渠道收发或外部 Effect 派发，不能将这个入口当作完整聊天产品或通用任务执行工具。

## Session 与模型

默认路由为用户现有 `opencode-go / deepseek-v4.1-flash`，replyer effort 为 `low`，受限本地 worker 与 3G core 为 `high`；模型配置先经宿主解析。当前适配支持 `low/high/max`，不增加另一套凭据或修改宿主全局模型。core 的该固定路由已接代码，但本轮未调用真实生成模型。

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
├── runtime-state.json       暂停状态、Session 绑定、最近探针/模型/Goal/上下文验证结果
├── control/events.sqlite    事件、Task/授权/Effect、Goal 范围与判断记录、Conversation/记忆元记录、发布/读取权威及提交水位
├── memory/backend.json      可选的可信私有后端配置；缺失时不安装或启动服务
└── workspaces/
    └── <taskId>/artifacts/note.txt  当前受限任务的固定产物；其余为受限 Session 工作目录
```

本地保存业务绑定、控制元记录、验证回执，以及 owner 明确登记的 Task/Goal 便签正文；记忆正文仍由原生记忆后端持有。这里不复制 Session 聊天历史，DSH 的模型历史仍在宿主原生持久层。本地开发数据、依赖、构建、UI 输出由[.gitignore](<.gitignore>)排除；正式数据目录按部署配置另行登记。当前没有完整检查点、独立备份或旧备份恢复入口。

## 本地 embedding

[embedding 适配](<src/adapters/embedding/index.ts>)使用已核对的 `microsoft/harrier-oss-v1-0.6b` Q8_0、1024 维 profile；模型文件 SHA256、固定来源 revision、前缀和向量规范见[实测证据](<artifacts/embedding-validation.json>)。它只接受显式 loopback IP/端口的 `/v1/embeddings`，禁止重定向、凭据 URL 与远端地址；构造客户端不会启动服务或发请求。本轮 smoke 校验了它启动的 server 与本地文件，通用 HTTP 客户端不能仅凭响应证明任意配置的 loopback 服务实际加载了该文件。

[embedding-smoke.ts](<scripts/embedding-smoke.ts>)只使用已有且身份匹配的 GGUF 和 llama-server，可在明确的本地验证范围运行：

```sh
node --import tsx scripts/embedding-smoke.ts /path/model.gguf /path/llama-server
```

脚本设置 120 秒取消期限并执行退出清理，文件哈希等未接取消信号的步骤不构成严格端到端硬超时；结束关闭它启动的服务，不会下载模型或安装常驻项。本轮仅测 3 条合成文档、2 条查询和 1 条重复输入，2/2 查询首位正确，不是用户原有 102 查询评测的复跑，也不等于长期记忆或完整语义检索已经上线。

## 阶段 3 接线与独立模块

阶段 3 初期接入原生 Goal 生命周期诊断。该诊断专用 Session 使用空工具与执行 guard，create/resume 后同步 disarm，拒绝模型步骤和自动续接；3G core 使用另一个 preset，见下节。SQLite 保存稳定绑定、native ref/revision、命令 CAS 与 pending/unknown/confirmed/rejected 回执；Goal phase、objective 和轮次仍只以原生日志为权威。原生变更后必须 flush、回读并持久确认，无法确认时不自动重放。

诊断只接受已成功的本地 Task ID。可信服务重新读取 Task 完成条件、Assignment、完整 EffectReceipt 和实际产物，在完成前复核同一证据身份，并将证明绑定到精确 Goal revision。模型或 HTTP 参数不能提供完成证明或 owner capability。`read/recover` 会短暂恢复受限 Agent，因此不用于仪表盘轮询；普通快照只显示已保存的检查事实及其所属实例。

本轮真实诊断以阶段 2 成功任务为独立依据，原生 Goal 在同一 Session 完成 4 次变更，revision 连续为 1–4、roundsStarted=0。精确原生日志中 request/header、assistant、标题 LLM 与压缩均为 0；控制库有 4 个 confirmed 命令回执，metadataVersion=8。有序重载后 Session 字节与哈希、绑定及命令历史一致，历史验证保留且未重放。证据见[原生 Goal 验证](<artifacts/goal-validation.json>)；该结果证明受控生命周期接缝，不代表已开启自主 Goal 规划或通过崩溃恢复验收。

ConversationStore 的本地任务背景路径与 3C 本地回复资格、localTask ReadView 已接入，范围见下节；分支/合并/分离和实际渠道路由仍未运行接入。记忆模块的原独立边界与 3E 新接线分开：

| 模块 | 实现范围 | 尚缺的运行接缝 |
|---|---|---|
| MemoryOperationLedger | 复用 EffectLedger 的批准、派发、回执、unknown、删除水位与依赖传播；3E 通过 MemoryDomain 接入显式普通记忆操作 | schema1 仍需显式迁移；普通记忆物理清除、跨组件恢复与六域发布未完成；没有第二套记忆正文库 |
| Ombre 薄 MCP 适配 | 原 search/readFeel/readI 薄适配保留；3D 有原版限定实测；3E 另有受控 create/status/get 服务与 Managed 接线 | 原语义搜索不直接给 replyer 使用；受控路径无更新、删除、通用 CAS 或自主整理，限定宿主证据见下节 |

Ombre 的 domain/tag 不是多受众 ACL，“读取”也可能触发原生日志、decay 或通知消费；当前接口不自动获得纯只读保证。具体静态证据与后续真实接入门槛见[核查目录](<../../research/2026-11-02-Ombre接入/目录.md>)。这些路径不能据此标成完整六部分内层或语义检索已经运行。

## 本地对话与后台标记（3B 已验范围）

对话页的“关联本地任务”只关联现有 Task，不要求任务已经成功；可信运行层固定 `local-owner` 身份与受众，不从请求接收授权主体。默认本地对话标识取 Task ID，重复关联复用稳定 Conversation/Topic/回复绑定；最多 64 个本地绑定。这里只保存控制引用，不创建聊天正文、第二个 inbox 或原生 Session。

每个 Task 复用一条 `task.succeeded` 订阅。消费者重新检查持久 claim、事件来源、scope 与真实 Task 成功状态，再在同一 SQLite 事务提交背景来源标记和 Event ack。领取次数单独持久化，失败保留投递重试资格；来源版本 1 表示一次不可变的已核验成功事实，不取全局事件序号或 Task 总修订号。一个 Task 可以关联多个本地对话；晚建绑定仍需首次加载来源，不能因旧投递已确认就显示已同步。

后台扫描在启动、任务结算、关联后唤醒，并每 5 秒补扫；每批最多 20 条，每次唤醒最多 4 批，卸载等待在途扫描结束。暂停允许纯背景落库；持久 failed 投递使整体状态保持 degraded，不能被后续空扫描消除。GET 与仪表盘刷新不消费投递，也不调用 `ackContext`；Event ack 只确认背景标记已落库，不能证明上下文已注入 Session。3B 当时未开放原生上下文注入、回复/发送或 ReadView；3C 的本地只读上下文与回复接线见下节，渠道发送仍未接入。

控制库另提供持久 `commitSeq`，有效行或支持的 schema 变化在同一外层提交中计一次；纯读、无变化和回滚不增加。旧库首次启用建立独立基线，不回填旧历史，只有相同 baselineId 的序号可以比较。它不是事件序号、Task 版本或内层组合投影的 `stateVersion`，不能用它宣布 ReadView 权威已建立。实际限制见[控制库说明](<src/adapters/control-store/README.md>)；修复后全量 348/348 模块、83/83 UI 通过，限定宿主关联、刷新及修复后重载幂等核对已有证据。

真实 DSH 中，首次关联成功 Task 后只有 1 条 acked 投递，pending=1、needsSync=true，尚无来源确认游标或原生回复 Session 绑定。修复前一次刷新保持 commitSeq 9→9；事务修补后重载并重复关联，commitSeq 17→17，绑定与业务摘要保持一致。两次源码证据分别保留，最终宿主复验限于已有绑定的幂等关联；3 个精确自有工作目录内的 6 个 Session 均未新增或改变，不代表宿主其他流量。详情见[对话背景验证](<artifacts/conversation-validation.json>)。

## 3C：受限上下文与回复草稿

本切片建立持久内层发布清单和独立 `stateVersion`，六部分均明确标为 unavailable；Task、Conversation 或控制库 commitSeq 的变化不能冒充内层状态更新。同一 DB Worker 捕获获准 Task 的真实版本、绑定、提交水位和当前读取策略，ReadView 仅允许 localTask，不因此开放记忆正文或其他六内层能力。

稳定 replyer Session 使用宿主完整 `createUserMessage`。先持久确认 `onBound` 再 followup，并仅在匹配 user/message、flush 与回读证明持久化后 ackContext；仅有 Event ack 或模型文本不能确认上下文已加载。草稿交付前重新核查 ReadView 与 Conversation，过期、受众/来源变更或证据不齐均阻止交付。控制库只存引用/哈希/回执，不复制聊天历史，不发送外部频道消息。

本切片先通过零模型边界和真实宿主零模型重载检查，由主任务审阅代码与测试后才运行一次显式两轮上下文验证：最多 2 个顺序 followup、同一 Session，每轮最多 1 step、输出上限 512，期限不超过该轮视图剩余有效期（初始 TTL 30 秒）。适配器不自动重试，失败即停；标题、压缩与 provider 重试另外审计，两个 followup 不等于完整计费调用数。本计划不增加模型授权或无限调用额度。冻结门槛见[九系统计划](<../../架构与设计/九大系统实施与验证计划.md>)。实际仅显式运行一次两轮验证，同一 Session 取得两份持久加载与草稿回执，pending 1→0，刷新 commitSeq 40→40；有序重载后回执与来源游标保留，7 个限定自有 Session 文件未改变。两轮宿主 reported total 合计 1507 tokens，第二轮明确 cacheRead=384，首轮缓存字段缺失，金额及底层重试未知。见[上下文验证证据](<artifacts/context-validation.json>)；同 Session 复用是热会话观察，重载后未再次生成。

启动时 `prepareContextSafety()` 只检查官方消息工厂及原生 flush/read/projector；其 ready 不表示上下文已经加载，失败只禁用此功能。`@deepseek-ai/dsh-llm@0.2.1-rc.5` 是由宿主提供的 optional peer，本包未安装或复制 SDK。公共 `conversation.replyLocal` 接受已有关联的 Conversation，返回 draft/sent=false；`conversation.verifyContext` 逐轮程序核对任务状态与随机合成代号。控制库只保存输入哈希、原生引用和回执，重复 inputId 不重新生成。

原生冷投影最多读取 2048 个完整连续事件，未知 inbox、缺段或超限拒绝恢复，不能静默 dispose 清掉未知输入。已确认加载可独立于生成失败保留；Task 版本、受众/路由/世代、策略、撤回或 TTL 失效仍阻止旧草稿。此切片尚未验证长上下文、压缩后恢复或真实渠道。

## 3E：显式普通记忆（历史限定路径已验）

`memory.rememberLocal` 只接受已有本地对话、稳定 requestId 与用户明确输入的正文。可信控制域登记来源版本和保存同意，以共享 Mandate 预留 1 个 Effect，再派发受控普通 `dynamic` 桶创建；正文不经控制库 IPC 存储。相同请求和内容只返回已存元回执，unknown 不自动重发。独立 `operation_status` 与精确 `get` 同时核对命令、deployment、原生 ID、正文摘要与文件指纹后，才能确认 applied、结算效果并形成当前本地读取资格。

`memory.readLocal` 在后端精确读取前后核查授权、来源、会话、撤回屏障和版本；正文仅在本次响应返回。`memory.withdrawLocal` 在暂停或后端不可用时仍可撤回本地保存同意、使本地引用失效，**原生文件仍保留，不是普通记忆删除或索引/备份清除**。这里的本地资格不发布六域 stateVersion，也不加入 replyer ReadView。

可信 `<dataDir>/memory/backend.json` 指定固定 backend/deployment、Python、上游源码和独占 vault；配置不存在时不安装、不启动进程。Managed 后端只装载三个私有工具，使用 `env -i` 和 Python `-I` 隔离环境，不连接模型、渠道或原生 Session。运行配置只允许 `embedding: disabled`，显示 `semanticReady=false`。服务和 Harrier profile 的依赖、构建及启动边界见[受控服务说明](<service/ombre/README.md>)与[协议](<service/ombre/PROTOCOL.md>)；Python 37 项、全量 TS 535 项通过，后增 gate 回归合批 16 项通过；未重跑完整 537 项。模拟宿主 UI 首轮 141/142，唯一旧 Task 断言修补后相关 3 项通过，记忆页 29 项已通过；未重跑完整 142 项。

真实 DSH 仅显式保存一段 97 字节合成普通记忆；控制回执、后端回执、原生 ID 与正文/文件 hash 独立一致，按 0 生成 tokens/0 生成 calls/1 effect 结算。有序重载后仍读回同一 ID/回执，无写重放；随后撤回本地同意与授权，原生文件保留且 hash 不变。7 个限定自有 Session 的字节/hash/mtime 和清单全程未变，最后只读刷新 commitSeq 60→60；不据此宣称全机零模型流量。见[真实宿主证据](<artifacts/memory-host-validation.json>)；此前[隔离真实服务链路](<artifacts/phase3e-memory-validation.json>)保留修补前源码快照。以上为 3E 当时的 disabled 配置与限定证据；3F 已将受控依赖升级为语义配置，见下节。普通物理删除和完整六域仍未完成。

## 实际源码入口

```text
src/index.ts                         Host 路由、状态工具、装载/卸载
src/runtime.ts                       运行快照、显式命令与服务组装
src/contracts/events.ts              事件、订阅、回执与可信主体契约
src/contracts/core.ts                owner Goal 范围、判断资格、候选与完成证明契约
src/control/events/index.ts          组件共用事件服务
src/control/local-core.ts            共享授权下的 Goal 生命周期、判断、Task 接纳与完成编排
src/control/core-pump.ts             有界事实消费和判断调度，不实现第二个模型循环
src/control/tasks/                   TaskFacade 与局部复用的 Superagent 任务核心
src/control/policy/mandates.ts        可信授权、预算预留与结算
src/control/effects/                 Effect 账本、回执、执行资格与 unknown
src/control/task-runner.ts           原生 worker 与本地产物任务编排
src/control/goal-lifecycle.ts         以真实 Task/产物/回执验证原生 Goal 生命周期
src/control/conversations/           稳定业务绑定与背景版本；本地 Task 路径已接入
src/control/background-pump.ts       有界后台投递扫描与唤醒
src/control/local-reply.ts           Task/记忆视图、生成/零推理加载与撤回失效编排
src/control/memory/                  记忆操作控制账本、恢复与本地重新发布
src/control/local-memory.ts          显式保存、独立回执核验和精确读取编排
src/control/local-memory-search.ts   显式索引、候选授权、语义搜索与最终整集复核
src/contracts/semantic-memory.ts     索引证明、profile/水位与搜索协议
src/contracts/memory.ts              跨 TypeScript/Python 的严格命令与正文摘要契约
src/state/                           memory 能力发布、其余五域 unavailable 与读取权威
src/views/                           localTask/native-memory 裁剪、独立安全向量与精确读取
src/adapters/control-store/          SQLite Worker、协议与主线程代理
src/adapters/control-store/goal-bindings.ts  原生 Goal 引用与命令回执 CAS
src/adapters/control-store/core-domain.ts    Goal 范围、事实触发、判断与共享预算控制域
src/adapters/control-store/task-domain.ts    owner Task 与可信 core 委托的共用执行接缝
src/adapters/control-store/conversation-domain.ts  可信本地关联、背景投影与原子 ack
src/adapters/control-store/commit-watermark.ts     控制库持久提交水位与基线
src/adapters/control-store/view-domain.ts         同 Worker 可信捕获与新鲜度校验
src/adapters/control-store/local-reply-domain.ts  输入元记录、原生加载确认与草稿资格
src/adapters/control-store/authority.ts           Task/Memory/Core 共用授权目录与显式迁移
src/adapters/control-store/memory-domain.ts       来源同意、独立删除屏障与本地撤回
src/adapters/control-store/memory-index-domain.ts 显式索引授权/预算/效果及独立事实核验
src/adapters/dsh/sessions.ts          受限原生 replyer Session 适配
src/adapters/dsh/native-message.ts    官方完整 user message 与身份/哈希核对
src/adapters/dsh/native-context.ts    精确原生回读与冷 inbox 投影
src/adapters/dsh/workers.ts           受限原生 worker、工具与执行资格
src/adapters/dsh/goals.ts             原生 Goal 生命周期薄适配
src/adapters/dsh/core-decision.ts     同 Goal Session 内的一次受限原生判断及独立回读
src/adapters/dsh/NATIVE_SEAMS.md      固定宿主接缝、持久性和未覆盖边界
src/adapters/dsh/session-title.ts     识雨自有 Session 的固定标题与旁路限制
src/adapters/dsh/event-tools.ts       Agent 事件工具工厂，尚未挂载运行 Session
src/adapters/artifacts/              固定路径产物写入与独立读取
src/adapters/embedding/index.ts       本地 Harrier 适配
src/adapters/ombre/                  原薄读取适配、受控协议核验与 Managed 子进程
service/ombre/                       固定上游的薄服务、metadata journal 与 Harrier profile
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
artifacts/goal-validation.json       原生 Goal 四步零推理、独立证明及有序重载证据
artifacts/conversation-validation.json  背景关联/刷新/重载、修复前后分段及幂等证据
artifacts/context-validation.json    本地视图、原生加载、两轮草稿/用量及有序重载证据
artifacts/phase3g-native-contract.json  3G 固定 SDK 静态接缝与离线原生替身测试证据
artifacts/phase3e-memory-validation.json  修补前隔离真实普通记忆链路
artifacts/memory-host-validation.json    修补后真实 DSH 保存/读回/撤回及重载证据
vendor/dsh-superagent/               未修改的上游证据基线，独立于运行时适配
licenses/                           随发布包保留的第三方完整许可
```

第三方来源与本地修改由[来源说明](<THIRD_PARTY_NOTICES.md>)维护。阶段 2 `1e1bdd2` 的限定 **16 文件、198/198 模块**及 **39/39 UI** 保留为已验快照。已同步 `0f946f4` 的 Goal 接线、取消修补及独立模块批次 `npm run check` 为 **304/304**，类型检查/构建/Client 语法检查通过；完整 UI 为 **64/64**。本地对话/后台标记与水位的修复前全量检查为 **345/345 模块、83/83 UI**；事务边界修补后全量为 **348/348 模块**，类型检查/构建/Client 语法通过。UI 文件未变，沿用本切片 **83/83** 结果；两次源码与宿主证据分别记录。3C 全量模块 **421/421**、完整 UI **112/112**，后续上下文尝试轮数显示修补的相关 UI **30/30**；当前登记 113 个 UI 用例，未运行完整 113 项。各批包含旧用例，不能相加成新增数量。模块与 UI 夹具不替代真实 Goal/记忆后端验收，独立模块合成通过也不表示已运行接入。完整规划树仍见[本体文件树规划](<../../架构与设计/识雨本体文件树规划.md>)。

## 3F：语义记忆与安全上下文

在可信 `memory/backend.json` 使用 schema2（完整字段见[适配器配置说明](<src/adapters/ombre/README.md>)）后，Runtime 显式 open 才启动固定 Harrier 与私有 Ombre。`memory.indexLocal` 仅对已保存、仍可读的单条记忆建索引；`memory.searchLocal` 只在同 Conversation 的获准集合内检索，最多 128 个候选、5 个结果。缺索引明确返回 `index_required`，不自动补建。来源、删除屏障或索引水位变化会拒绝在途结果。

`conversation.loadContext` 与普通 `conversation.replyLocal` 共用获准视图和原生加载回执；前者只加载，不 followup 或生成草稿。已暴露来源撤回后，旧 Session 历史保留、绑定失效，下一次输入使用新安全代次。显式保存、索引、搜索与加载分开操作，刷新不触发它们。

离线与真实证据：[实施记录](<实施记录.md>)、[隔离 Harrier](<artifacts/phase3f-semantic-memory-validation.json>)、[限定宿主路径](<artifacts/phase3f-memory-host-validation.json>)。没有跨对话分享、自动记忆抽取、物理删除、自主整理或完整六内层能力。

## 3G：有界 core 与本地目标

本轮只开放 `local-note`：owner 显式提供目标、不可由模型修改的便签正文及依赖、总预算和期限。控制域保存该范围，原生 Goal 建立并独立确认后才产生授权。core 只能返回 `task_intent`、`defer`、`no_action` 或 `complete_candidate`；模型候选本身没有授权、派发或完成权。接纳 Task 前核对原生输入/输出持久引用、同 Goal 的 Task/Effect 版本、依赖完成证据、当前授权与已结算判断用量，随后在同一控制事务中记录判断回执和 Task。core 委托通过可信 `admitCoreIntent` 使用原 Goal 的 Mandate 与预算，不调用 `task.createLocal` 换取新的 owner 授权。实现见[契约](<src/contracts/core.ts>)、[CoreDomain](<src/adapters/control-store/core-domain.ts>)及[TaskDomain](<src/adapters/control-store/task-domain.ts>)。

[LocalCoreService](<src/control/local-core.ts>)复用同一原生 Goal Session 处理生命周期和判断，[CorePump](<src/control/core-pump.ts>)只负责有界调度。诊断 preset 与 core preset 分离；core Session 仍为空工具、禁止直接执行，并保持原生 Goal 自动续接 disarmed。每次判断通过官方完整 user message 发起一次普通 followup，本地 `evaluations` 与原生 Goal driver 的 `roundsStarted` 分开记录，不能将前者伪装为原生 Goal 轮次。当前服务每次最多一个原生主请求、1024 输出 tokens，绝对取消期限不超过 120 秒及授权剩余期限；不自建模型循环、历史或 inbox。稳定 Session、完整消息、资格复查和冷回读接缝见[Goal 适配](<src/adapters/dsh/goals.ts>)、[判断适配](<src/adapters/dsh/core-decision.ts>)与[固定 SDK 静态证据](<artifacts/phase3g-native-contract.json>)。取消期限不保证底层调用按时返回或进程硬退出；未知 inbox、未结算调用或释放失败保留所有权并阻止重放，长期会话压缩及恢复仍未验收。

判断和派生 worker 从同一总授权预留额度：每次判断预留 16384 tokens、2 calls、0 effects；每个便签 Task 预留 16384 tokens、2 calls、1 effect。实际可观察用量另行结算，unknown 保留占用，超额后停止后续工作。SDK 的请求前 Token 估计是启发式，因此 **Token 限额是预留与对账限额，不是实际计费的硬上限**；原生请求次数与输出长度限制独立，provider 内部重试及完整计费覆盖仍未知。完成候选还须重新读取全部便签产物与可信 Task/Effect 回执，经独立证明才能请求原生 complete；候选已提交但原生命令 unknown 时，保留两个独立事实。

公共命令均经 `POST /api/shiyu/commands` 的严格字段校验进入可信 Runtime；caller 不能提交 actor、Mandate、模型配置、工具权限或完成证明：

| action | 公共输入与回执 |
|---|---|
| `core.create` | `{ requestId, objective, deliverables: [{ id, title, content, dependsOn? }], budget: { tokens, calls, effects }, expiresAt, maxEvaluations? }` → `{ goal, duplicate? }`；相同请求不重新授权或重放未知原生命令 |
| `core.pause` / `core.cancel` | `{ goalId, expectedVersion }` → `{ goal }`；先落本地停止屏障，再处理原生生命周期，不等待在途模型才停止授权；Runtime 暂停时仍可提交 |
| `core.resume` | `{ goalId, expectedVersion }` → `{ goal }`；只接受 owner 显式恢复，重核期限、授权和原生命令状态；不默认恢复 unknown 执行 |
| `GET /api/shiyu/state` 的 `core` | `{ ready, errorCode?, pump?, goals, ... }`；每个 Goal 的 `deliverables` 去掉正文，只返回 `bodyBytes` 等范围元信息，另含 `evaluationsLog`、可用时的 `balance` 和 `nativeCommand` |

“目标与判断”页提供 1–3 条便签表单，每条正文最多 1024 UTF-8 字节；依赖只能引用本目标中其他 ID，不能成环。默认可编辑预留为 131072 tokens、12 calls、3 effects、最多 4 次判断，有效期可选 30 分钟或 1 小时；这些默认值不代表实际调用数或完成保证。Goal 详情分别显示目标状态、最后一次原生观察及时间、原生命令 pending/unknown/confirmed/rejected、触发引用、候选、接纳 Task 和用量完整性。pending/unknown 原生命令禁用恢复，暂停与取消仍可关闭本地范围；取消不删除原生日志或撤销已发生效果。请求回执不会乐观替换快照，切换目标、运行实例变化或不匹配的新版本会拒绝旧响应。

本轮仪表盘完整离线回归 **168/168** 通过；随后只调整上述默认预算与预算边界文案，相关表单、创建请求及中英文窄屏 **3/3** 复验通过，未在这次最终文案修改后再跑完整 168 项。首轮旧 Goal 诊断用例遇到成功提示与等待提示同时出现的定位竞争，限定到成功提示后完成上述全量复验，未改变诊断行为。新增界面用例见[core.spec.mjs](<tests/ui/core.spec.mjs>)；领域、编排、调度和原生接缝分别见[CoreDomain 测试](<tests/core-domain.test.ts>)、[LocalCore 测试](<tests/local-core.test.ts>)、[CorePump 测试](<tests/core-pump.test.ts>)及[原生 Goal Session 替身测试](<tests/core-goal-sessions.test.ts>)。系统全量检查结果以[实施记录](<实施记录.md>)最终汇总为准，不将不同批次累加。上述是 755c7f4 离线批次，当时没有真实宿主、生成模型或 embedding 验收；没有通用任务规划、跨对话记忆读取、外部设备/频道操作或完整自主恢复能力。

修复后 B 样本的两轮 Core、worker 执行、独立产物核验和原生 Goal 完成已有[限定真实证据](<artifacts/phase3g-core-host-success.json>)；完成后有序重载保持日志、预算和事实不变，A 失败记录继续保留。完成态显示修补仅有本轮相关 26/26 UI 回归，未再重载宿主。原生 complete 优先显示为已完成并关闭三个目标控制按钮；本地 paused 字段只是停止派发的屏障，不能当作可恢复的原生暂停。详细分批检查与局限见[实施记录](<实施记录.md>)。

## 3H：Lab 连续对话与回执

运行仪表盘的 Lab 页面接受 owner 的 run ID、target token、最多 20 个明确频道、三轴预算和到期时间。token 只留当前 Runtime 私有内存，提交后清空输入框，控制库、状态工具和模型上下文均不含 token。页面刷新不访问 Lab，不推进模型、发送或消费输入。

每个 run/channel 拥有稳定 Conversation 与原生 Session。普通新消息、暂停和同受众重接只使旧草稿失效，不更换 Session；成员实际变化才退休旧 Session 代次。每组最多 8 条输入、正文总计 16 KiB，输入引用和摘要在控制库去重，正文仍由 Lab 与 DSH 持有。replyer 不使用工具，也不从其他频道加载记忆；本地任意回复入口不能绕过 Lab 协调器操作该会话。

发送前核对当前输入、受众、草稿、预算、连接与服务身份。派发最多一次，实际送达证据必须来自 Lab。某频道存在未知发送时暂停该频道后续生成，其他获准频道可继续；未知用量保留预算占用。新的授权不能绕过同 run/channel 的旧未知发送锁或把旧输入重放为新请求。

“核对”只调用新增公共 `message.receipt`，冷读 Lab 已持久化的送达事件并核对原操作、频道、正文摘要，不重复 `act`。它可补记过期、暂停或旧输入代次下已发生的事实；未找到、歧义或认证失效仍保持 unknown。Lab 自身重载导致 sealed 身份失效时，不绕过其认证恢复观察。正常 Runtime 关闭或重开不会自动装回 token、恢复模型或重发；重新接入须 owner 显式操作。

每次回复预留 16384 tokens / 1 主调用，发送另预留 1 effect；原生报告不完整时不把缺失字段填零。预算是准入、预留与事后对账，不能声称调用前精确硬限 provider 费用或知道其内部传输重试。原生核心上下文、历史和压缩归 DSH；本切片不冒称长历史压缩、缓存收益或完整 Lab S/FL 验收。
