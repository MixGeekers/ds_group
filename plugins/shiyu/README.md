# 识雨本体

`@shiyu/runtime` **0.1.0**。识雨的独立 DSH 插件包，采用宿主内权威核心的 A 方案。当前已有运行仪表盘、受限原生 replyer/worker、持久事件，以及带授权预算、效果回执和独立核验的本地任务链路；本地 embedding 尚未连接记忆业务。

**状态：3B 基线 `81eedc0` 已提交并推送，348/348 模块、83/83 模拟宿主 UI 与限定宿主证据保留。3C 已接线，421 项模块、112 项全量 UI 与后续相关 30 项定向 UI 通过；一次真实两轮验证已完成，独立持久回执与有序重载核对已完成。** 3B 已将本地 Conversation/Topic 绑定、Task 关联和持久背景标记接入 Runtime，并新增对话页与提交水位；修复后 348/348 模块、83/83 UI 通过，限定宿主关联、刷新及修复后重载幂等核对已有证据。阶段 2 `1e1bdd2` 的受限本地任务已有真实成功记录，首次用量失败 unknown 保留。3C 已接线仅授予 localTask 的 ReadView 与原生上下文确认；MemoryOperation 和 Ombre 薄适配仍为独立模块。core 自主规划、六部分内层业务、正式记忆后端和真实渠道未接入。分批结果见[实施记录](<实施记录.md>)与[九系统计划](<../../架构与设计/九大系统实施与验证计划.md>)。

本包不依赖 Lab 引擎或资料工作台作为运行能力。`lab/` 继续作为独立被测环境，`plugins/shiyu-workbench/` 完整保留。

## 当前实现与限定验证

| 部分 | 已实现范围 | 当前边界 |
|---|---|---|
| Host 与运行状态 | DSH 插件入口、只读状态路由、`shiyu_status` 工具、显式运行命令与卸载清理 | 原生安装与限定禁用/启用验证已有证据；无独立 Web 服务，不等于完整生命周期压力验收 |
| 运行仪表盘 | 总览、当前工作、活动、九系统状态、事件/订阅、Session、任务完成条件与独立核验详情、显式诊断；中英文、主题及窄屏布局 | 使用结构化运行快照；受理不显示为成功，unknown 与停止请求独立显示；缺失用量保留未知 |
| replyer Session | 专用原生 preset、创建/恢复前模型校验、空工具与执行 guard、稳定业务/scope 绑定、取消与释放；显式两轮真实模型验证入口 | 零推理探针和两轮代号回忆已测；业务恢复/压缩及完整缓存收益仍待验，没有渠道外发 |
| 任务与 worker | 本地 owner 创建 Task/Assignment，原生 worker 使用受控单工具写固定产物；绑定先持久化，资格按宿主/安装世代、fence、租约及授权复查 | 修复后第二个有界真实任务通过；首轮结算失败保留 unknown；没有 core 自主派工或通用文件/设备权限 |
| 授权、效果与核验 | Mandate/CAS、原子预算预留、Effect 领取/回执/不确定性、独立产物 SHA256 核验；完成状态与完成事件同事务 | 目前只接固定本地合成任务；取消不假称效果回滚，旧实例及 unknown 不自动重派，多用户与外部设备尚未接入 |
| 原生 Goal 生命周期 | 原生 Goal 适配、SQLite 绑定/CAS/命令历史、独立完成证明及显式 `goal.verify-lifecycle` 诊断已接 Runtime；真实四步零推理验证通过 | 原生日志拥有 Goal 状态；本地仅存绑定和命令事实，未启用 core/续接循环；一次生命周期通过不代表完整恢复/持续规划验收 |
| 本地对话与背景 | 同库稳定 Conversation/Topic/回复绑定、Task 关联、可信完成事件投影、有界扫描；显式本地上下文回复与验证 | 背景消费者不调用模型；Event ack 不等于加载，显式回复须原生持久回执才 ackContext；无渠道发送 |
| 发布与受限视图 | 六 unavailable 的真实 publication/stateVersion；同 Worker capture、本地读取策略/撤回权威与 localTask ReadView；草稿最终双校验 | 不提供内层正文或记忆写入；30 秒 capture，过期/来源/受众变化拒绝旧视图；版本不与 commitSeq 混用 |
| 事件与订阅 | 类型目录、发布、订阅增删改查、有限回放、投递领取/确认/失败、重试和统计；事件与匹配投递同事务提交 | live 路径为可信组件消费和 Agent background 引用；Agent 事件工具工厂已实现并合成验证，但尚未挂载到原生 Session，未自动续接 |
| 本地状态与数据库 | 单实例运行锁、暂停与 Session 绑定保存；SQLite 独立 WorkerThread，事件、Task/Assignment、Mandate/预算及 Effect 共用连接与事务 | 尚无原生 inbox/请求结果完整对账；正常重载、事务/文件故障注入和限定子进程退出不代替完整断电/灾难恢复 |
| embedding | 固定 Harrier Q8_0 文件身份、1024 维向量、query 前缀、归一化、显式 loopback HTTP 适配 | 本地真实冒烟通过；未接记忆、索引或检索业务，未安装常驻 embedding 服务 |

仪表盘查看/刷新只读取状态，不自动创建 Session、发布事件或调用模型。可见时每 10 秒刷新，页面隐藏时停止轮询；读取失败保留上次快照并标记状态未确认。显式“检查会话接入”执行零推理探针，“验证模型与会话复用”发送两轮合成输入，“运行本地任务验证”受理固定合成任务并交后台执行。暂停关闭新操作并取消在途模型，不声称回滚已经发生的效果；可信任务完成的纯背景标记仍可落库，不会因此请求模型、续接 Session 或发送消息。

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
| `POST /api/shiyu/commands` | 显式 `runtime.pause`、`runtime.resume`、`session.probe`、`session.verify-model`、`reply.generate`、`task.createLocal`、`task.cancel`、`goal.verify-lifecycle`、`conversation.linkLocalTask`、`conversation.replyLocal` 或 `conversation.verifyContext`；JSON 正文上限 64 KiB |

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
├── runtime-state.json       暂停状态、Session 绑定、最近探针/模型/Goal/上下文验证结果
├── control/events.sqlite    事件、Task/授权/Effect、Goal/Conversation、背景与回复元记录、发布/读取权威及提交水位
└── workspaces/
    └── <taskId>/artifacts/note.txt  当前受限任务的固定产物；其余为受限 Session 工作目录
```

本地仅保存业务绑定、控制元记录与验证回执，不复制 Session 正文历史。DSH 的模型历史仍在宿主原生持久层。本地开发数据、依赖、构建、UI 输出由[.gitignore](<.gitignore>)排除；正式数据目录按部署配置另行登记。当前没有完整检查点、独立备份或旧备份恢复入口。

## 本地 embedding

[embedding 适配](<src/adapters/embedding/index.ts>)使用已核对的 `microsoft/harrier-oss-v1-0.6b` Q8_0、1024 维 profile；模型文件 SHA256、固定来源 revision、前缀和向量规范见[实测证据](<artifacts/embedding-validation.json>)。它只接受显式 loopback IP/端口的 `/v1/embeddings`，禁止重定向、凭据 URL 与远端地址；构造客户端不会启动服务或发请求。本轮 smoke 校验了它启动的 server 与本地文件，通用 HTTP 客户端不能仅凭响应证明任意配置的 loopback 服务实际加载了该文件。

[embedding-smoke.ts](<scripts/embedding-smoke.ts>)只使用已有且身份匹配的 GGUF 和 llama-server，可在明确的本地验证范围运行：

```sh
node --import tsx scripts/embedding-smoke.ts /path/model.gguf /path/llama-server
```

脚本设置 120 秒取消期限并执行退出清理，文件哈希等未接取消信号的步骤不构成严格端到端硬超时；结束关闭它启动的服务，不会下载模型或安装常驻项。本轮仅测 3 条合成文档、2 条查询和 1 条重复输入，2/2 查询首位正确，不是用户原有 102 查询评测的复跑，也不等于长期记忆或完整语义检索已经上线。

## 阶段 3 接线与独立模块

原生 Goal 的生命周期是当前新增的运行接线。专用 Session 使用空工具与执行 guard，create/resume 后同步 disarm，拒绝模型步骤和自动续接。SQLite 保存稳定绑定、native ref/revision、命令 CAS 与 pending/unknown/confirmed/rejected 回执；Goal phase、objective 和轮次仍只以原生日志为权威。原生变更后必须 flush、回读并持久确认，无法确认时不自动重放。

诊断只接受已成功的本地 Task ID。可信服务重新读取 Task 完成条件、Assignment、完整 EffectReceipt 和实际产物，在完成前复核同一证据身份，并将证明绑定到精确 Goal revision。模型或 HTTP 参数不能提供完成证明或 owner capability。`read/recover` 会短暂恢复受限 Agent，因此不用于仪表盘轮询；普通快照只显示已保存的检查事实及其所属实例。

本轮真实诊断以阶段 2 成功任务为独立依据，原生 Goal 在同一 Session 完成 4 次变更，revision 连续为 1–4、roundsStarted=0。精确原生日志中 request/header、assistant、标题 LLM 与压缩均为 0；控制库有 4 个 confirmed 命令回执，metadataVersion=8。有序重载后 Session 字节与哈希、绑定及命令历史一致，历史验证保留且未重放。证据见[原生 Goal 验证](<artifacts/goal-validation.json>)；该结果证明受控生命周期接缝，不代表已开启自主 Goal 规划或通过崩溃恢复验收。

ConversationStore 的本地任务背景路径与 3C 本地回复资格、localTask ReadView 已接入，范围见下节；分支/合并/分离和实际渠道路由仍未运行接入。以下模块有定向合成验证，**尚未接入 Runtime 或真实后端**：

| 模块 | 实现范围 | 尚缺的运行接缝 |
|---|---|---|
| MemoryOperationLedger | 复用 EffectLedger 的批准、派发、回执、unknown、删除水位与依赖传播；只存操作/来源元数据 | 真实记忆后端的操作证明、CAS、物理清除与恢复；没有第二套记忆正文库 |
| Ombre 薄 MCP 适配 | 固定 3.6.14 公共参数，注入 transport，提供有界 search/readFeel/readI，输出为未可信后端文本 | 未安装、未启动、未连接真实 Ombre；无自动写入/删除、无通用 CAS/操作幂等证明，不直接给 replyer 使用 |

Ombre 的 domain/tag 不是多受众 ACL，“读取”也可能触发原生日志、decay 或通知消费；当前接口不自动获得纯只读保证。具体静态证据与后续真实接入门槛见[核查目录](<../../research/2026-11-02-Ombre接入/目录.md>)。这些独立模块不能据此标成六部分内层或长期记忆已经运行。

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
src/control/goal-lifecycle.ts         以真实 Task/产物/回执验证原生 Goal 生命周期
src/control/conversations/           稳定业务绑定与背景版本；本地 Task 路径已接入
src/control/background-pump.ts       有界后台投递扫描与唤醒
src/control/local-reply.ts           localTask 视图、原生加载回执与草稿双校验编排
src/control/memory/                  独立记忆操作控制账本，尚未运行接入
src/state/                           六 unavailable 发布清单与本地读取权威
src/views/                           只读裁剪服务；localTask 捕获已接入
src/adapters/control-store/          SQLite Worker、协议与主线程代理
src/adapters/control-store/goal-bindings.ts  原生 Goal 引用与命令回执 CAS
src/adapters/control-store/conversation-domain.ts  可信本地关联、背景投影与原子 ack
src/adapters/control-store/commit-watermark.ts     控制库持久提交水位与基线
src/adapters/control-store/view-domain.ts         同 Worker 可信捕获与新鲜度校验
src/adapters/control-store/local-reply-domain.ts  输入元记录、原生加载确认与草稿资格
src/adapters/dsh/sessions.ts          受限原生 replyer Session 适配
src/adapters/dsh/native-message.ts    官方完整 user message 与身份/哈希核对
src/adapters/dsh/native-context.ts    精确原生回读与冷 inbox 投影
src/adapters/dsh/workers.ts           受限原生 worker、工具与执行资格
src/adapters/dsh/goals.ts             原生 Goal 生命周期薄适配
src/adapters/dsh/NATIVE_SEAMS.md      固定宿主接缝、持久性和未覆盖边界
src/adapters/dsh/session-title.ts     识雨自有 Session 的固定标题与旁路限制
src/adapters/dsh/event-tools.ts       Agent 事件工具工厂，尚未挂载运行 Session
src/adapters/artifacts/              固定路径产物写入与独立读取
src/adapters/embedding/index.ts       本地 Harrier 适配
src/adapters/ombre/                  独立注入式 MCP 边界，尚未连接真实后端
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
vendor/dsh-superagent/               未修改的上游证据基线，独立于运行时适配
licenses/                           随发布包保留的第三方完整许可
```

第三方来源与本地修改由[来源说明](<THIRD_PARTY_NOTICES.md>)维护。阶段 2 `1e1bdd2` 的限定 **16 文件、198/198 模块**及 **39/39 UI** 保留为已验快照。已同步 `0f946f4` 的 Goal 接线、取消修补及独立模块批次 `npm run check` 为 **304/304**，类型检查/构建/Client 语法检查通过；完整 UI 为 **64/64**。本地对话/后台标记与水位的修复前全量检查为 **345/345 模块、83/83 UI**；事务边界修补后全量为 **348/348 模块**，类型检查/构建/Client 语法通过。UI 文件未变，沿用本切片 **83/83** 结果；两次源码与宿主证据分别记录。3C 全量模块 **421/421**、完整 UI **112/112**，后续上下文尝试轮数显示修补的相关 UI **30/30**；当前登记 113 个 UI 用例，未运行完整 113 项。各批包含旧用例，不能相加成新增数量。模块与 UI 夹具不替代真实 Goal/记忆后端验收，独立模块合成通过也不表示已运行接入。完整规划树仍见[本体文件树规划](<../../架构与设计/识雨本体文件树规划.md>)。
