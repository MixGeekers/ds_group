# DSCord 自有内核 0.4

本轮将 [DS-Bot 0.3.1](https://github.com/Fei2411/DS-Bot/tree/6559c9e7c4ef71c292e6ac50f690031133536fe0/ds-bot) 吸收到 DSCord。上游 npm 包的 SHA-512 与 Git 固定提交的运行文件已逐项核对；来源、许可和本地修改登记在 `vendor/ds-bot/UPSTREAM.json`。原有 source-aware memory、消息交付、调用方 Session、压缩 steward、provider 上下文溢出识别和面板记忆删除修补均保留。旧 `plugins/shiyu/`、资料工作台与 Lab 不在本切片修改范围。

## 宿主契约

支持的固定 DSH 基线是 `@deepseek-ai/dsh@0.2.2-rc.1`，与上游 0.3.1 的测试宿主一致。需要原生 `sessionController.resolveAgent/create`、`sessions.flush`、`tools`、`systemPrompt`、`sessionTitle`、`workspaceRegistry` 和 authenticated shared connection 服务。附件使用宿主的 `attachments.admitPromptContent`；工具和模型继续来自 DSH。运行依赖新增 `@modelcontextprotocol/client@2.4.0`、`imapflow@2.9.1`、`mailparser@3.12.4`、`nodemailer@10.2.1`，`deep-view` 升为 `0.1.2`。

DSCord 自有入口是 `POST /api/dscord/kernel`，协议为 `{endpoint,payload}`，响应为 `{ok,value}` 或 `{ok:false,error}`。`kernel-info` 只读并返回 `runtime`；`state` 同样带 `runtime`，读取不会自动创建 Chief、启动问候或等待 provider/credentials 发现。模型目录由 `models` 等显式操作刷新，避免 DSH loader 初始化时循环等待。`runtime` 包含 `id=dscord-kernel`、`version=0.4.0`、`upstreamVersion=0.3.1`、`apiVersion=1`、`instanceId`、`status`、`home`、`memoryBackend`、迁移信息和保留工作的概要。原生客户端与 SSE feed 均使用该路由，不再隐式选用 `/api/bot`。上游自身的包更新器不替换 DSCord 管理的内核，更新随 DSCord 发行包进行。

`create-bot` 支持 `name/role/model/main/owner/source/requestId/greet`。第一位显式创建的 Bot 默认成为 Main Bot；`greet:false` 仍真实创建 Session、挂接工具并保存成员，仅省略问候生成。`owner` 保留完整身份对象，`id` 必须非空；`creationSource.requestId` 可用于丢失回执后的查找。相同 `requestId`、所有者和请求体的并发或重启重试复用持久回执，改动请求体会被拒绝。`claim-bot` 仅为尚无 `owner` 的旧 Bot 做首次明确绑定；同一所有者可重试，已有不同所有者不能被覆盖。

`sendUser({sessionId,content,requestId,source,memoryContext})` 接收 Bot 稳定 ID、当前原生 Session ID 或早期 part ID，并解析到当前 part。DSH 的公开 `prompt` RPC 会构造单一 `user` 来源，因此结构化输入直接复用原生 Agent inbox、消息构造器、附件接纳和持久化。持久请求回执先于消息入队；未知结果保留为未知，不自动重投。

`source.sender` / `source.actor` 保存完整稳定 ID、名称和 `human/bot/tool/background/unknown` 种类，另保存 transport、room、event 和 request。人类及其他 Bot 的真实输入进入 followup；工具或后台快照使用 inject，不独自唤醒工作。一个 Bot 可交错服务不同 Matrix 房间，身份和记忆仍属于同一 Bot。

来源记忆扩展端点为 `observe`、`attention-view`、`memory-profiles`、`memory-profile`，分别调用记忆模块提供的 `memoryObserve`、`memoryAttentionView`、`memoryProfiles`、`memoryProfile`。profile 是来源记录的读取视图，写入仍走 remember/review。缺少对应模块时端点明确报告 unavailable。`observe` 不主动调用模型 flush。

0.3 的本地 CLI adapter 已修正：`knowledge-context`、runtime、工具与后台生产者保留为 Context；快照不能回答待决的人类问题，单独到来不启动 CLI；后续真实输入会带上积累的上下文。CLI replay 与新输入区分 Human、Bot、Participant 和 Context 标签。DSCord 模式不执行上游对原生 Goal、subagent、teammates、阻塞问题或 schedule target 的额外隐藏与拒绝；宿主原有权限预设和用户主动停用的连接器继续生效。

## 生命周期与原位采用

`startNativeTeam` 在安装任何监听器或后台工作前检测旧 `/api/bot` 和目录锁。存在旧运行时会报告 `DSCORD_KERNEL_CONFLICT`，details 包含占用入口/锁、需停止的旧插件和重载步骤。宿主生命周期管理可在已有授权内停止旧插件后重载；不会落回旧内核执行请求。本轮没有操作用户正在运行的 DSH 实例。

默认仍采用 `DSH_HOME/bot`，独立节点可指定原 `dataDir/ds-bot`。目录 canonical realpath 和持有 token 的 `state.lock` 保证单写者；同进程另一个实例也会冲突，活着但心跳暂时过期的本机进程不会被夺锁。Cordis 会并行清理单个 fiber 的 effects，因此租约放在父 scope 并等待整个内核子 fiber 完成 `dispose()`，覆盖记忆回顾、inbox 与状态写入之后才释放。

首次采用只增加 `migrations/dscord-0.4.0/` 快照与 `dscord-kernel.json`，不复制或重建 Session，不移动记忆，不更改 Bot ID。原始 state 与 inflight 以精确字节、内容摘要和只增快照保留。未知或损坏的数据版本会阻止启动，文件保持原样。迁移中断后继续同一采用记录。

旧 `inflight.json` 中未知的 turn/queue 保存在 `migrationHeld`；首次采用和未来重启均不自动重投这些旧项。新工作仍使用原生恢复流程。`migration-work` 可读取保留项，`resume-migrated {sessionId}` 可明确继续，使用持久回执防重复。该端点开始继续后若结果未知，仍报告未知而不会重复发送。

## 本轮证据边界

`npm test` 是产品模块/合成检查。`npm run test:kernel-host` 使用隔离安装的真实 DSH 0.2.2-rc.1 消息/工具 peer 与合成宿主服务，以及实际启动的合成 ACP CLI；不代表真实模型、真实账号连接器或物理跨机器验收。该检查覆盖自有身份、纯读取、首个显式 Bot、完整工具、来源隔离、重试与重启、所有权、迁移不重投和 CLI 背景上下文。真实宿主与远端模型验证由主线程及部署切片另行留证。八个上游 IM adapter 的源码被吸收，本轮产品入口继续使用 Matrix，未将吸收代码记为八种 IM 业务通过。

本轮截至 `c2804aa`：483 项产品模块检查、9 项内核单元、10 项 native peer/合成宿主与 CLI 检查通过，构建通过。上游原始全套在 `52b94eb` 上为 1,857 通过、2 跳过、2 个已说明的行为差异断言失败：未修改的源代码构建要求仍为旧客户端路由，以及旧锁策略要求夺取存活进程的过期锁。初轮缺少测试开发依赖、随后 optional config 兼容失败与修复都保留在[离线证据](../artifacts/kernel/offline-validation.json)。部署首轮真实宿主的 catalog 就绪阻塞单独保留，`bc2cd26` 修补后的真实复验以部署切片为准。
