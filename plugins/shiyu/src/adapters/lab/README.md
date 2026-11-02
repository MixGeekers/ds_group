# Lab 公共目标协议适配

更新：2026-11-02。此模块为识雨 3H 的窄传输接缝；模块替身验证、Lab 临时合成运行测试与真实宿主验收分开记录。本轮没有访问真实 Lab 房间、DSH Session、模型或 UI。

适配器通过可信 `getService()` 或 `ctx.get('shiyuGym')` 取得服务，只调用 `service.collaboration.externalCall(runId, token, request, signal)`。不导入 Lab 引擎，不读取其管理接口、engine、state 或运行目录，不提供任意 URL、操作名称或代理执行接口。Lab 自己的 `message.receipt` 实现属于 Lab 内部公共协议扩展。

## 接口与边界

| 适配器方法 | 固定公共请求 | 返回给可信控制器的内容 |
|---|---|---|
| `connect({runId,token,clientName?,readOnly?,signal?})` | 普通接入为 `connect`；明确只读接入为 `inspect` | 规范化人员、频道、自身 `SHIYU` 身份和成员摘要 |
| `inspect(signal?)` | `inspect` | 与连接时相同成员集合的目录；变更即拒绝 |
| `inputs({after,limit?,waitMs?,signal?})` | `inputs`，前后各一次 `inspect` | 最多 30 条临时输入正文、身份及游标；等待最多 20 秒 |
| `send({operationId,channelId,text,toActorId?,beforeDispatch?,assertDispatch?,signal?})` | `act`，仅 `operation.type='message.send'` | 送达回执或 `unknown`；无附件、任务交付、文件和工具调用 |
| `observeSend({operationId,channelId,bodyHash,signal?})` | `message.receipt` | `delivered / not_found / ambiguous / unknown`，仅精确关联的元信息 |
| `disconnect(signal?)` | `disconnect` | 撤销本地接入资格并请求 Lab 断开 |
| `close()` | 不发请求 | 撤销本地资格、清理 token、取消本实例待接收结果 |

token 为 Lab 生成的 32 字节 base64url 值，只保存在 JavaScript 私有字段；它不出现在返回结果、快照、错误正文或本体控制库。外部异常被稳定错误码替代。连接绑定确切 service、collaboration 与 externalCall 函数对象；服务关闭、更换或本地关闭均拒绝新派发。重新接入必须经过控制器的明确生命周期。

`readOnly:true` 是 owner 明确重连以观察旧回执的本地限制，只调用公共 inspect 建立本地 binding，不调用 connect；适配器本身硬拒 inputs 和 send，不能通过再次 connect 或目录状态变化升级写权限。它允许查看仍由原有效 HTTP sealed 身份认证的终态房间。若 Lab 自身重载已撤销该身份，查询继续失败、旧 unknown 继续保留，不绕过认证。活动房间的 inspect 仍可能建立或刷新旧协议的 HTTP 连接；这是明确接入动作的副作用，不是 message.receipt 查询的副作用。新的写授权须由控制域另行建立，不能从只读接入推导。

频道与人员 ID、唯一性、频道 kind、成员引用均受校验。每个输入须匹配 run、原生 `${runId}:e${seq}` 事件身份、递增 seq、已知频道和发言成员。正文暂存在调用结果，不在适配器持久化。输入上限为 16384 个 JavaScript 字符，覆盖 Lab 真人任务的标题加 12000 字指令；发送上限 10000 字，并要求无首尾空白，以避免 Lab 原生 trim 改变正文 hash。调用者请求小于 30 条时重新计算返回游标，未返回的项留到下一页。

成员摘要只覆盖人员 ID、频道 ID/kind/memberIds，不把显示名称变化当成权限变化。它不是 Lab 原子 CAS。生产控制器必须提供 `beforeDispatch`，在异步 inspect 后再次检查持久 SendPlan、Effect claim、运行状态与授权；其 await 完成后，再以 `assertDispatch` 同步检查 Runtime 停止状态与当前连接身份。此最后回调只能返回 undefined，Promise、thenable 或其他返回值均拒绝派发；它之后到适配器同步复核信号、服务身份及实际外部调用之间没有 await。Lab 自身发送仍核对 SHIYU 与指定收件人的成员关系。暂停或取消发生在派发之后不能抹掉已经确认的送达事实。

## 只读送达观察与未知结果

Lab 原 `message.send` 先持久化 `message.delivered`，再写 operation receipt。这两次写入不是原子事务，因此不能用重新发送同一 operationId 查询未知结果。适配器在同一进程实例内拒绝已派发的 run/operationId 再次 send；跨重启的同一约束由控制域持久 SendPlan/Effect 权威承担。适配器不会自行重试。

新增公共 `message.receipt` 只冷读指定 run 的已持久事件，按 operationId 先计数，再核对 target 来源、频道和送达正文 UTF-8 SHA256。唯一匹配返回 eventId 与该事件的 `at` 作为 `observedAt`；不是重新生成的服务时间。不存在或不匹配返回 `not_found`，同 operationId 多条送达返回 `ambiguous`；读取/协议不确定性在适配器归为 `unknown`。`not_found` 不能证明未发送，也不授予重发许可。

该观察请求要求既存、有效的 HTTP target 接入身份和原 token；允许已封存房间的原 sealed 身份查询。它不会建立连接、续租、发送、emit、save 或更新 run。断开身份不能靠查询重新接入。普通 `inspect / inputs` 仍继承旧协议的连接活跃时间更新，因此不得把所有目录读取笼统宣称为宿主无写操作。

`inputs` 仅含 `input.*`，不能作为送达事件读回。发送过程异常或畸形回执均保留 `unknown`；已取得精确合法 delivered 回执，即使本地同时取消或关闭，仍返回事实供 Effect 记账。原生 act 不传递 AbortSignal，因此取消不是撤回已派发发送；close 也不声称硬中止未返回的宿主工作。

## 固定公共来源

协议以本仓 Lab 的公共目标接口为准，不混用旧 standalone Bearer REST：`lab/plugin/collaboration.js` 的 externalCall、`lab/plugin/service.js` 的 targetCall，以及 `lab/src/types.ts / engine.ts`。原 HTTP 包装入口为 `lab/plugin/index.js:19`，包体 `{runId,targetToken,request}`；本模块直接调用同一 public service。

以下是本切片公共 receipt 扩展后的源码 SHA256；路径相对工作区根。它们固定本轮实现来源，不代表真实宿主已经加载这些修改。

| 来源 | 字节 | SHA256 |
|---|---:|---|
| `lab/plugin/index.js` | 4428 | `515e87ff915c5bcfcad5703246193dddc76414b9f00f9f707082786db04d0f1a` |
| `lab/plugin/collaboration.js` | 21911 | `8136b3e3b43b96dd46e4f9ca6d528ff0b332dffb971481549ee38bc8fb49351c` |
| `lab/plugin/service.js` | 24199 | `90d42ad197b963aa9146ec77893b0b233bd40115d97524a1cb8a98198abc5736` |
| `lab/src/engine.ts` | 65612 | `9b79240b790ce27e274bd40ad050539a664ed405e95fd543517165dbe6ca9658` |
| `lab/src/store.ts` | 11968 | `800fae184e9e4b8ce0c49b30d574ab97f1aa8e3f4d7ff9bb65f623d809cb3f30` |
| `lab/src/types.ts` | 6853 | `6efb813889f10cb3a8371a17c4d34acb36b0dcad364571b968f0a3d9560ec77c` |
| `lab/src/protocol.ts` | 4263 | `a174c3976281c2c2e3c32dc48bfeef49a4af22e3cd446400b1c510d07a3b0733` |

本轮离线验证：本体 adapter 22 项替身测试及类型检查通过，日志位于本体 `.local/phase3h-lab-adapter.log` 与 `.local/phase3h-lab-adapter-typecheck.log`。新增同步门回归覆盖异步授权完成后的微任务撤权，以及 Promise/thenable 回调拒绝。另由协作子 agent 执行 Lab 7 项新增 engine 冷读测试、2 项新增公共入口测试、11 项既有 collaboration 测试，共 20 项通过，并完成 Lab 类型检查与插件构建。Lab 公共入口测试逐字节核对查询前后连接状态、SQLite/WAL、事件、snapshot、manifest 与内存 run 不变，覆盖 active/sealed、断开身份、错误 token 和 native 占用。

这些是替身及临时合成 Lab 运行证据；没有真实宿主、真实房间或模型调用。旧协议核查说明与新增行为的测试证据分别记录，不将既有 Lab 模型实验当成本切片验收。
