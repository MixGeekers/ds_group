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
