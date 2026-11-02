# DSH 原生生命周期接缝

2026-11-02，静态核查本机 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 中 DSH `0.2.1-rc.5`。下列行号指 ASAR 内对应 npm 包的 `lib/index.js`，不是其他版本的兼容承诺。实现调用宿主公开服务，没有复制宿主源码或自建模型循环。

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
