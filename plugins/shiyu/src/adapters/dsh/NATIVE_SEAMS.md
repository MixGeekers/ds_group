# DSH 原生生命周期接缝

2026-11-02，静态核查本机 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 中 DSH `0.2.1-rc.5`。下列行号指 ASAR 内对应 npm 包的 `lib/index.js`，不是其他版本的兼容承诺。实现调用宿主公开服务，没有复制宿主源码或自建模型循环。

## 3F：显式 load-only 原生维护接缝

同一固定宿主重新只读核查：`@deepseek-ai/dsh-agent-loop:906–922` 先 claim inbox 再 pre-step，`1052–1073` 通过 prepareRequest 后才 append `user/message`，`1084–1085` 调用 stream 后才检查 abort。因而在 user/message 监听器中 cancel **不能**证明零 stream；已将测试替身的 user append 移到 pre-step/request 之后，拒绝输入不再伪造加载回执。生成调用已开始后失败，仍可独立证明此前加载。

`loadContextOnly(ContextLoadRequest)` 是独立接口，返回 `ContextLoadResult {mode:'load-only',binding,contextReceipt,inferenceRequested:false,followupRequested:false}`，没有 text/assistantRef/usage 或草稿完成含义。可信回调 phases 为 admission、append、context_ack、release；onBound 持久化身份后才可能追加，receipt 只在 exact full-message seq/hash/surface metadata、flush 与冷读全部确认后提交。调用前后及每次 await 后复核取消与授权；任何 pending inbox 均拒绝，不顺手移除过期项。相同业务 binding 复用原生 Session，每次成功前释放 handle，失败释放不放行成功，已提交的加载回执不因此消失。

原生接缝：`dsh-agent-loop:790–791,822–844` 的 `runMaintenance(job(signal))` 要求真正 idle phase、与其他活动互斥，本身不 wake；maintenance 的公开 status 仍是 idle，因此不能只靠 status 判断独占。并发外来 followup 可能 latch wake（`854–868`），适配器同时保持 load-only/无活动/关闭状态下的 pre-step 与 request 拒绝，任何未知 inbox 都阻止 ack/处置。`dsh-session:1481–1537` 的公开 append 返回不可变完整事件，调用 `append('user/message', officialMessage, {surfaceOp:'append'})`，没有 followup/inject/wake。固定用户标题先于追加，避免 `dsh-session-title:380–383` 自动标题；不 import 或调用压缩模型。

`dsh-session-persistence-jsonl:63–90` 的 read `eventState` 是 aliasing 标记（如 `detached`），**不是**总事件数。冷读仍用官方 projector，最多 2048 连续事件，并用同 handle 的 `read(prefix.length,1)` 确认 EOF；不自造 `eventState.count`。未知输入清理的每次 async 等待后以及 cancel/dispose 前均复核；无法安全处置时保留 handle 和拒绝钩子，不能清掉别人输入。宿主 dispose 内部行为仍属于公共 API 边界，没有另写 teardown 或历史日志。

本轮静态证据的原始包 SHA256：agent-loop `cf57e3ecd487ac5c2553455aaa5cef2c6fb41e6bd61be5aa455675d1d7193033`；session `2f5dd07cb5c744a29abbb8003a8a4cefd9e582c6e2538074ca299a0ddd02a3bf`；session-title `eb814490ca3d0aaabf8f6ddc705a031f99a98709c484c1502c5f28f101cf0eeb`。本轮 `sessions.test.ts` 47 项、`native-context.test.ts` 6 项，共 **53/53** 替身测试；日志 `.local/phase3f-native-context-tests.log`。包括原生顺序、maintenance/late creation、取消、精确冷读、不同 surface、未知输入与清理竞态、同 Session 恢复、回执后失败和丢返回不重发。整包类型检查与集成验收随本切片其他并行模块统一记录，不由这 53 项定向测试代替。

没有调用真实 DSH 或模型。`inferenceRequested:false` 只指此方法没有主动请求生成；真正宿主验收须从 create/resume 起核对完整限定会话事件及标题/压缩旁路，不能把 attach 后局部事件监听当作全宿主费用证明。

## Replyer 上下文加载与草稿引用

本节接缝依据同一 DSH `0.2.1-rc.5` 的本机源码静态核查。`sessions.ts` 的业务请求通过显式 `context` 安全模式接入；原有 probe 与诊断路径保持独立，不能把普通回复成功当作上下文持久加载证明。

- `@deepseek-ai/dsh-llm/package.json:4,31–34`：版本为 `0.2.1-rc.5`，公开导出 `./message`；`lib/types/message.js:26–58` 的 `createUserMessage({content, source})` 生成完整 `role='user'` 与一次性原生 `id`，深拷贝并冻结。识雨通过宿主 peer `@deepseek-ai/dsh-llm/message` 导入工厂，不复制其实现。safe 与 legacy replyer 都只构造一次完整消息后传入 followup；业务侧只登记 ID、内容 hash 与原生引用，不复制会话正文历史。
- `@deepseek-ai/dsh-app-boot:1347–1350,1676–1728`：linked plugin 的 peer 映射读取 `peerDependencies` 的名称；optional peer 的声明不绕过宿主映射。`prepareContextSafety()` 只加载并验证工厂及公共 flush/read/projector 服务，不构造消息、不创建 Session、不请求推理。它的 ready **不等于**任何资料已经进入原生历史；真实加载仍须下述逐次回执。
- `@deepseek-ai/dsh-agent-loop:800–808,906–918,1066–1074`：followup 先进入原生 inbox，随后 wake；原生不会替调用者补全缺失消息 ID。pre-step 的 `messages` 是本步实际认领的新输入，`user/message` 的 `data` 即完整消息。适配器同时核对实际 claimed 消息的唯一 ID/hash，拒绝未知输入；观察到事件或 `whenIdle()` 本身不构成加载/生成成功。
- `@deepseek-ai/dsh-session:1938–1967` 的 `sessions.flush(exactSession)` 只确认有 durability listener 参与；`@deepseek-ai/dsh-session-persistence-jsonl:421–432` 的无 writer 分支可能不落盘。因此 receipt 必须同时核对精确 `user/message`、flush 与公开 `sessionPersistence.open(id, 'read', {signal})` 后 `read(seq, 1, {signal})` 的 seq/type/完整消息 hash。该公共只读 handle 的接口见同包 `56–110,140–178,2481–2519`，在 finally 中 close。草稿另行确认精确 assistant event 并返回 `{sessionId,eventSeq,messageId}`，不只取任意最后一条回复。
- `@deepseek-ai/dsh-session-projection:262–318`：冷读调用公开 `sessionProjections.restore({}, events, 0, header, inheritedEventCount)`，使用已注册的 `snapshot.values.inbox` 投影；inbox 注册/字段见 `@deepseek-ai/dsh-agent-loop:26–61,1581–1584`。当前冷读最多 **2048 个完整、连续事件**，超限、缺段或无 inbox 投影均拒绝恢复。此上限是首切片的显式限制，不是第二套 checkpoint/history；尚未实现超长 Session 的压缩恢复接线。
- `@deepseek-ai/dsh-agent-loop:145–149,179–207,815–820,1703–1726`：`cancel(...,{keepInbox:true})` 保留 inbox，但 `handle.dispose()` 默认 cancel 会清空它。未知 inbox 因此在 resume 前或 live continuation 时阻止执行；若已挂载的会话出现未知输入，适配器保留拒绝钩子和 handle，close 明确报告清理失败，**不静默 dispose**。仅控制域明确登记为过期的 ID/hash 可逐项 remove，并核对对应 canceled splice、flush、精确回读和冷投影。首个业务编排不自动声明过期输入，不自动重放。

顺序为 admission 授权 → 确认期望 native ID → onBound 持久绑定/dispatch-intent → followup → 原生 pre-step/request 再授权 → 精确加载回读 → context_ack 授权及 onContextDurable → 草稿 release 授权。加载回执独立于生成结果：模型失败不抹除已证明的加载；取消、过期和未知输入不得 ack。context_ack 只核对该捕获版本的权限与强绑定，背景来源变新由 pre-step/release 的当前来源验证拒绝旧草稿，不把已经加载的旧捕获伪装成未加载。绝对 `deadlineMs` 包含排队/初始化/创建，调用者可及时收到超时，串行锁仍持有晚到原生操作直至清理完成，close 会等待。

Conversation generation 变化由业务 token 令旧草稿失效，不单独换 Session；sessionEpoch 由控制域纳入 businessId，expectedSessionId 一经给出就必须精确恢复，缺失或不符不会创建替代会话。当前未覆盖长期会话、压缩后恢复、超过冷读上限的恢复或真实频道输入，不以短程热复用结果声明这些能力完成。

本轮 `tests/sessions.test.ts` **33/33** 与类型检查通过：公共服务替身覆盖完整消息工厂、绑定先于 followup、exact user/assistant 回读、失败生成与独立加载、取消/flush 假成功、来源变更、未知 inbox 和未观察到 inserted 时的实际 claimed 输入、已知过期项精确移除，以及初始化/排队/晚创建期限。测试未连接真实宿主或模型。真实 zero-prep、原生加载及有限模型轮次的证据由主实施记录单列。

## Worker 完整消息契约补齐

2026-11-02，基于 `9115e35` 的独立修复已将 `workers.ts` 的历史 partial followup 改为复用 `native-message.ts` 的同一公开工厂。默认由宿主 peer 提供 `@deepseek-ai/dsh-llm/message`；可信测试可注入 `WorkerDriverOptions.createUserMessage`，没有自建 ID/role 的生产兜底。公共 `DshAgent.followup` 参数类型同时收紧为完整 `NativeUserMessage`。

每次获准 run 在原生 create/resume 前只构造一次消息，校验 ID、user role、source 与原 prompt，工厂返回后再次核对 permit。缺工厂、工厂抛错或消息不符时，不创建/恢复 Agent、不提交 onBound、不 followup；工厂等待受现有取消、deadline、lease 与卸载控制，晚返回不触发派发。原生 creation 仍保留既有所有权，取消/close 等晚到 handle 清理，不把它改为脱离管理的取消竞速。`onBound → 固定标题/flush → dispatch gate → followup`、候选 `verified:false`、用量/预算、Task/Mandate/Effect 与独立核验路径保持不变；未新增重试或 unknown 重放。

本轮 `tests/workers.test.ts` **27/27** 与类型检查通过，全部使用原生服务替身。新增覆盖公共工厂缺失、错误消息、工厂等待期间取消/超时/卸载和授权撤销；正常派发断言工厂只调用一次且完整 ID/role/prompt 原样进入原生 user message，resume 使用原 Session 与新的消息 ID，既有晚创建回归确认零派发并释放晚到 handle。没有调用真实 Worker、模型或宿主 API。这次静态契约修复不推翻此前实际 Worker 成功证据，也不把上述零模型测试当作新的真实 Worker 验收。

## 固定标题与用量

- `@deepseek-ai/dsh-session-title:281–310`：`get(exactSession)` 返回 `{title, source, messageSeqs, eventSeq, updatedAt}`；`rename(exactLiveSession, title)` 同步写原生 `session/title`，`source.kind='user'`，并 supersede 旧自动标题。
- 同包 `380–383`：固定标题使每条后续用户消息直接跳过自动标题，适用于 first-prompt 与 all-prompts provider；`546–549` 同时取消 active 并清除 pending。状态来自原生日志。`319–343` 的显式 owner refresh 可以重新启动标题，故这不是不可解除的永久锁。
- `session-title.ts` 在 handle 已发布后、followup 前调用公开 rename/get/flush；服务缺失、回读不符或 flush 未确认均拒绝发送。恢复后同样复核。Goal 生命周期会话也固定标题。
- `@deepseek-ai/dsh-session-title-llm:191–219`：标题旁路携带 `sessionId`、`purpose='session-title'`，写 `session/title-llm-request` 后直接 stream，未把 usage 写回该事件。
- `@deepseek-ai/dsh-compaction-basic:292–337,435–498,584–648`：压缩直接 `ctx.llm.stream`，绕过 `agent/request`，摘要前可发生内部重试。一条 `compaction/summary` 不代表完整调用数。
- Worker 的 `steps` 只表示受限 Agent pre-step；`modelCalls` 仅在请求 admission 与已结算 native attempt 一致且没有压缩/标题旁路时给出计数，不声称知道 provider transport 重试。压缩或意外标题出现时计数为 `null`、usage 为 `unknown`，已知部分仍保留，原始计量记录只输出 type/seq/usage，不含正文。不得用 steps 填补未知调用数。
- `@earendil-works/pi-ai/dist/api/openai-completions.js:1162–1186`：input 排除 cache read/write，total 包含 input + output + 两类 cache。`@deepseek-ai/dsh-llm-pi-ai:1440–1445` 只在 cache 值大于零时输出 cache 字段，缺失不能证明是零。领域预算应保留宿主 total 与原始观察，不能强制 total=input+output。

## Goal 权威与恢复

- `@deepseek-ai/dsh-goal:611–626`：get/disarm 需要 exact live Agent；disarm 仅移除进程内 continuation authority，不修改 durable phase/revision。
- 同包 `635–711,760–775`：公开 create/edit/pause/resume/complete；写操作校验 native revision。create/resume 会 armed；原生 complete 本身不验证业务证据。
- 同包 `594–602,777–785`：新挂载、重载及 runtime state 初始均 disarmed；`858–877` 的 goal/change append 与 emit 不是 durable flush 的替代。
- `@deepseek-ai/dsh-goal-round-driver:108–129,243–247`：原生 driver 在 flush 等待后再次检查 activation。适配器把 create/resume 放在同步 try/finally 内立即 disarm，包含“宿主已提交后抛错”的情况，不在二者之间 await。
- `@deepseek-ai/dsh-goal:413–450,771–775`：cold wire projection 可能展示最后一个良好状态；精确 live get 会抛 replay failure。因此本适配器 read/recover 会短暂恢复并释放受限 Agent，不是适合仪表盘轮询的无副作用 GET。
- `@deepseek-ai/dsh-session:1938–1967`：公开 `sessions.flush(exactSession)` 返回是否有 durability listener 处理。原生写成功后必须 flush 与 get 回读，再确认本地 command receipt。
- `@deepseek-ai/dsh-tool-goal:72–79,335–364`：原生模型工具能够更新 Goal。此接缝通过专用 preset、tools=[]、工具执行 guard、pre-step/request 拒绝挡住直接执行；AI 只能向上层提出 proposal。

`goals.ts` 是原生薄适配器，现由 `control/goal-lifecycle.ts` 接入 Runtime 的限定诊断入口，尚未接 core 计划循环。Goal phase/objective/rounds 始终以原生日志为权威；本地 port 只存 Session/Goal 引用、CAS 版本、操作回执及可信完成证明的引用元数据。所有入口需要注入 authority 验证不透明 capability；恢复 stopped Goal 仅 owner 能授权。complete 的独立证明在写前持久化，并要求最终授权证明身份一致；恢复也核对 native ref、criteria hash 与证明引用。

生命周期服务只接受受信 `taskReader(taskId)` 返回的已 succeeded 本地产物 Task。核对 `local-input`、reservation 的 local-owner scope、当前 Assignment、完整 EffectReceipt、Task verification，并复用 LocalArtifactStore.inspect 实际读取文件校验 hash/bytes。每次 native 授权都重新检查 runtime、取消信号和当前证据；两次 complete 授权独立实读，但证明引用、native revision 与验证时间保持同一身份。流程为 create→pause→resume→complete，各步仍 disarmed。服务不发 followup，返回 `inferenceRequested:false` 只表示服务未请求推理，不代替真实宿主日志对旁路的核对。

SDK create/mutation 的可选 signal 与 adapter shutdown 合并后传入原生 create/resume；原生写前及 flush 后复核取消。关闭时继续等待 late handle 并释放，不以 Promise.race 丢弃后台创建。服务把已有 binding 或中途停止作为需显式核对/恢复的边界，不自动重放整段流程；取消在原生 complete 之后到达也不伪装为已回滚。

跨存储操作先存 pending，再调用原生写；durability、确认回执或释放失败记 unknown，不盲目重复 create/resume/complete。绑定 port 原子保存 CAS 与 command receipt 历史；旧 commandId 不能配新 ref 再执行。公开 `goalCommandIdentity` 固定命令语义，状态/回读/错误说明可以推进，操作与证明身份不可改变。重复命令拒绝并要求 read/recover，不伪装幂等成功。原生明确 `GOAL_INVALID_TRANSITION` 且回读仍为原快照时记 rejected；不把重复 pause 当作 no-op 成功。

recover 只恢复原 Session 并对账；不存在、读取失败或无法确认时保留未知，不构造替代 Goal。当前未引入宿主异常类依赖，不能结构化区分缺失 Session 与其他恢复失败：`SessionPersistenceNotFoundError` 只有公开类、name 与 sessionId，没有 code。未暴露 clear：仅通过 get 返回 undefined 无法区别历史 tombstone 与从未创建。

插件卸载后 preset 缺失会阻止普通 UI restore；已加载时 created/pre-step/工具 guard 同样拒绝非识雨挂载。原生 UI 对未开始 turn 的空会话允许 owner 显式重新选择其他 preset，这个边界未伪装成永久封印。

验证层级：`tests/goals.test.ts` 当前 21 项通过，包括原生替身+真实 SQLiteGoalBindingStore 的 unknown 恢复及完整生命周期组合。`tests/goal-lifecycle.test.ts` 12 项通过，使用真实 ControlStore、LocalTaskRunner、LocalArtifactStore 和 Goal binding IPC/SQLite，仅 worker 与原生 Goal adapter 为替身。本模块实现/测试没有调用真实 Goal API、创建真实 Goal Session 或调用模型；真实宿主诊断由主实施记录另行留证，不由上述替身结果替代。

## 3G：同一原生 Goal Session 的受限判断接缝

2026-11-02 追加。上节“尚未接 core 计划循环”保留为先前生命周期切片的历史；本节记录新增 SDK 接口与离线验证，不把它们称为真实 core 模型验收。固定来源仍是上述 DSH `0.2.1-rc.5`。各原始文件的完整 SHA256、准确包内路径及测试层级见 [phase3g-native-contract.json](../../../artifacts/phase3g-native-contract.json)。本次没有执行宿主 API、创建真实 Session 或调用模型。

`GoalSessionAdapter({namespace:'core'})` 同时拥有本 namespace 的生命周期和 `decisionRound`，同一 Goal 的操作与用量回执共用串行锁；不能再用另一个同 namespace adapter 争用同一 Session。core 使用 `shiyu-runtime-core-goal-v1` / `shiyu-core-goal-`，默认生命周期诊断继续使用 `shiyu-runtime-goal-v1` / `shiyu-goal-` 并拒绝全部推理。两者身份分离；core 内多轮及重建 adapter 后恢复同一个原生 Goal Session。原生仍权威管理 Goal phase/revision/objective 与历史，本地 binding 不存第二份 Goal 状态或消息日志。

新增公开接缝的静态依据如下，行号均指相应包的 `lib/index.js`：

- `@deepseek-ai/dsh-agent-loop:103–110,204–206,906–918,1052–1085,1148–1162`：claim/pre-step 传完整消息，inbox inserted 为 `{message}`；request 准备通过后才追加完整 user 消息，再调用 stream；assistant 事件包含完整 `data.message` 与可选 usage。`@deepseek-ai/dsh-agent:193–204` 的外层 pre-step 钩子可能追加模型切换提示，因此适配器除检查进入/返回的消息外，还在 stream 前检查最终已提交的唯一 user 消息 ID/hash，额外或篡改输入不能进入 provider。
- `@deepseek-ai/dsh-agent-loop:1274–1287`：请求包含 `session.deriveMessages()` 的完整保留 surface，包括历史、system 和本轮输入，并由 `markAgentLoopRequest` 标记。`@deepseek-ai/dsh-llm:377–387,2249–2257,2393–2397,2429`：公开根包导出 WeakSet 身份谓词 `isAgentLoopRequest`；prepared call 同样经过 `llm/stream`。`@deepseek-ai/cordis:258–263,317–324` 保留参数对象身份。生产使用公开谓词，不能仅以缺省 `purpose` 或形状相似认作主 Agent 请求。
- `@deepseek-ai/dsh-llm:759–770,2335–2349`：stream middleware 后仍可能从历史更新重建工具声明。适配器同时拒绝当前工具、`toolHistory.tools` 和 `updates[].additions` 非空，并保留执行 guard。`@deepseek-ai/dsh-session:658–680,696–714` 的无工具初态为 `{tools:[],updates:[]}`；恢复不能仅凭当前 preset 推断历史无工具。
- `@deepseek-ai/dsh-compaction-basic:292–323,839–861` 的压缩可绕过 `agent/request` 直接 stream；固定用户标题之外，core 专属 `llm/stream` gate 也拒绝 title/compaction、未标记请求及第二次 stream。其他 namespace 的流量不受此 gate 干预。该 gate 不构成对全宿主流量的审计。
- `@deepseek-ai/dsh-goal:163–166,273–278` 只对合法 `source.kind='goal'` 消息推进 `roundsStarted`。本接口通过官方工厂创建 `source.kind='user'` 的普通 followup，没有伪造 Goal 来源或调用私有 round API；结果明确 `nativeGoalRound:false`，记录前后原生计数不变。控制层另有 evaluation/round 预算，不以原生 `roundsStarted` 代替。

每轮固定 `opencode-go/deepseek-v4.1-flash/high`，只准入一个 pre-step、一个 native request 和一个可观察的主 stream，不自写模型循环或自动修复重试。`onDispatch` 耐久登记消息身份后才 followup；输入与 assistant 分别 flush、按精确 seq 冷读并核对完整消息 hash。返回的是有界原始候选文本、引用及 `verified:false`，结构/权限/Task/完成证据仍由控制层检查。每个执行阶段重验 opaque capability、绑定的 roundId/expectedRef、有效期与当前原生 Goal；释放后不读已处置 Agent，而是再次进行 authority 检查。失败仍调用 `onAccounting` 保留已知观察，缺用量为 unknown、缺调用计数为 null，不补零；记账失败不能返回候选成功。

调用数、输出参数、时间与 token 预留是不同边界。当前业务每次 evaluation 预留 **16,384 total tokens**，请求 `maxTokens=1,024`；SDK 允许可信调用者设置 1–4,096 的输出参数。`maxTokens` 是传给原生/provider 的输出控制，不能限制已有历史输入。`modelCalls` 计量本适配器可观察的 native middleware 派发；provider 内部 transport 重试未知，不能把一次主 stream 宣称为完整计费请求数。

**16,384 是预留、实际用量对账和超额冻结依据，不是请求前硬计费上限。** `@deepseek-ai/dsh-token-meter:15–16,39–75` 明确采用 `CHARS_PER_TOKEN=4`；`722–764` 的 `measure()` 使用上次 usage 锚点加启发式 surface 增量，`778–784` 的 `estimateMessage()` 也只是估算。`@deepseek-ai/dsh-llm:2111–2140` 只提供模型容量等元数据，没有精确计数或可信 token 上界；`2335–2349` 与 `@deepseek-ai/dsh-llm-pi-ai:1971–1986` 此后仍进行路由/provider 输入转换。16 个交付项、4,000 字目标、单请求、输出参数以及历史长度限制均不能证明总 token 必定低于预留。现接口未新增未经证实的计数器，也未把压力估算升级为硬预算保证；真实用量超额后的冻结无法撤销已发生费用。

`deadlineAtMs` 是贯穿排队、授权、恢复、派发与回读的绝对期限，过期会撤销本轮并向原生 cancel/AbortSignal 传播；晚到的原生 handle 仍受管并释放。若宿主 create/whenIdle 或耐久回调不返回，适配器继续保有所有权等待 drain，**不承诺在期限内硬终止进程或立即返回**。未知 inbox 保留并阻止处置；释放失败保留拒绝钩子，封闭再次挂载，close 明确失败。冷 inbox 复用现有 2048 连续事件/EOF 限制，超限拒绝；本切片没有自动压缩或超长会话恢复接线。

本轮离线验证为 **56/56**：core 原生替身 14 项、既有 Goal 21 项、真实 SQLite binding 9 项、生命周期组合 12 项；另整包类型检查及本次差异检查通过。新增用例包括同 Session/重启复用、准确消息回读、先登记后派发、记账期间串行与 close drain、过期/撤权、晚创建、取消、未知 inbox 保留、清理失败后禁续跑，以及重试/旁路/未标记请求/历史工具/额外或篡改输入零 provider-next。14 项独立日志为 `.local/phase3g-core-goal-sessions.log`；56 项组合结果来自本轮执行回执，未另存完整 stdout 文件。它们均不代替后续固定宿主与有界真实模型验收。

### 3G 首次真实失败后的 required context 修复

上面的 56 项验证及 `phase3g-native-contract.json` 保留为修复前历史。首次限定真实 core Session 在 inbox claim 后、`step/start` 前结束，只有通用取消原因 `Core decision cancelled`；没有 user/message、request、assistant、标题模型或压缩事件，也没有 usage 事件。该原生记录没有保留内部异常，不能仅从通用取消文本反推出唯一原因。之后用固定 SDK 的默认 required context 结构离线复现了相同事件差量，实际抛错为 `Core prepared step changed the registered input`；旧替身仅返回 claimed owner 消息，遗漏了原生必需 cwd 上下文。首次 unknown/cancelled 记录没有重写为成功，本轮修复没有进行真实重试。

新增固定来源：`@deepseek-ai/dsh-working-directory/lib/index.js:30–46,76–78,121–122` 从 Session 的 workingDirectory 投影读取 cwd（初值为 header.cwd），注册 `required:true` 的 `working-directory:current`。`@deepseek-ai/dsh-system-prompt/lib/index.js:394,400–404` 明确保留 required 项，即使已调用 suppressRuntimeContext；`136–155` 给出固定 snapshot 文本与具名 section 结构。两份文件的版本、字节数、完整 SHA256 及本次复现/修复代码和测试日志指纹见 [phase3g-required-context-fix.json](../../../artifacts/phase3g-required-context-fix.json)，不替换旧证据的来源 hash。

`dsh-agent-loop:334–348,914–918,1053–1073` 会在 pre-step 生成待用 runtime-context 消息，request 准备后刷新并重新生成最终消息，再作为 `user/message` 追加。两次 UUID 不必相同；已保留同样文本时 `337` 返回 undefined，不重复追加。修复仍要求 claimed inbox 恰好一个已登记 owner 输入、ID/hash 原样不变且处于首位；只额外允许零或一个完整 UUIDv4 user 消息，source 必须恰为 runtime-context/snapshot，sections 恰好一项 working-directory:current，section 及完整 snapshot 正文精确对应绑定 cwd。每个 live gate 还读取公开 `workingDirectory.get(exactSession)` 确认当前 cwd 未变。任何其他来源、cwd、section、附加文本、重复上下文或额外用户消息均拒绝。

最终 stream 前再次检查所有本轮已提交 user 消息，execute 分别 flush、按精确 seq/hash 冷读 owner 与每个允许的 context 后才接受后续 assistant。可选 `runtimeContextRefs` 仅提供新追加快照的耐久证明，不改变领域 owner input receipt；返回空数组表示本轮未新增快照，不表示历史里没有上下文。输入/上下文校验与相关冷读失败分别给安全固定 code `CORE_NATIVE_INPUT_REJECTED` / `CORE_NATIVE_CONTEXT_REJECTED`，不保存上下文正文或原始 SDK 异常。空工具、单主请求、授权复核、未知 inbox 保留和原有预算/取消边界均保留。

修复后 **59/59** 定向测试通过（core 17、旧 Goal 21、binding 9、生命周期组合 12），日志 `.local/phase3g-required-context-combined.log`；整包类型检查及本次差异检查通过。默认替身已包含 required cwd snapshot、预备/最终不同 UUID 和同 Session 后续零新增快照；另覆盖准备与提交两个阶段的非法上下文、context 冷读失配及实时 cwd 变化。原始失败复现日志 `.local/phase3g-required-context-repro.log` 独立保留。上述通过只属于离线修复证据，不是修复后的真实宿主或模型验收。
