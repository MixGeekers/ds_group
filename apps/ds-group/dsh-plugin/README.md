# DSCord 的 DS-Bot 节点适配

本模块在独立 DSH 宿主内装载 DS-Bot 0.2.7，并提供 DS-Group 的 Bot 注册与对话 HTTP 接口。

## 运行依赖

- 固定上游为 `71d344bf193f3f18185f25de3d8e5c483046910a`。原始 npm 包保存在 `../vendor/ds-bot/`，`UPSTREAM.json`、`LICENSE` 和 `NOTICE` 记录来源及许可，上游源码保持未修改。
- 发行节点使用 Linux amd64/arm64 与官方 npm DeepSeek Harness 0.2.1-rc.5 CLI。`index.mjs` 使用 Node `registerHooks` 将本模块及 vendored DS-Bot 的 SDK imports 解析到同一个宿主安装目录。
- 通过 `DS_GROUP_DSH_CLI` 和 `DS_GROUP_DSH_RUNTIME` 指定安装位置，启动器也会查找 PATH 中的 `dsh`。Linux 双架构纳入发行验证。本机开发环境已有 macOS 桌面版路径回退及历史 Session 重启证据，详见[发行验证](../发行验证.md)。
- `runtime-dependencies.json` 与 `runtime-dependencies-lock.json` 固定 `deep-view@0.1.0`、`yaml@2.9.1`。启动器在数据目录内使用 `npm ci --ignore-scripts` 准备依赖，模块解析指向该私有依赖目录，源码树无需写入依赖链接。

## 启动和停止

先按[服务器部署](../deploy/README.md#接入远端-bot)导出并导入目标 Bot 的配置，然后在应用包目录启动。下方 `your-bot-account` 替换为 Bot 完整 ID 中 `@` 与 `:` 之间的账号部分，数据目录和端口由用户选择。

```sh
BOT_ACCOUNT='your-bot-account'
export DS_GROUP_DATA_DIR="$HOME/.local/share/dscord-nodes/$BOT_ACCOUNT"
export DS_GROUP_BRIDGE_PORT=23100
node scripts/dsh-node.mjs start "$BOT_ACCOUNT"
node scripts/dsh-node.mjs status "$BOT_ACCOUNT"
node scripts/dsh-node.mjs stop "$BOT_ACCOUNT"
```

这些命令只管理 DSH 宿主，Matrix 适配进程按部署指南另行启动。自定义 Bot 必须配置空闲的 `DS_GROUP_BRIDGE_PORT`；`finance` / `hr` 是开发演示节点，它们的 `18091` / `18092` 只是预设端口。每个宿主拥有独立的 `<数据目录>/dsh-<Bot账号>/home/`、DS-Bot 数据、原生 Session 与工作区。

当前版本通过 `OPENCODE_API_KEY` 提供固定模型的凭据，也可通过 `DS_GROUP_DSH_SOURCE_HOME` 和 `DS_GROUP_DSH_SOURCE_PROFILE` 从用户自己的安装复制 `opencode-go` 配置和单个引用凭据。CLI 未指定时回退到 `~/.dsh` / `desktop`，DSH 图形连接则使用实际宿主的 home/profile。凭据文件模式为 `0600`。

停止命令等待对应进程退出及桥接端口关闭。`run` 用于服务管理器的前台运行。图形连接会自动管理每个 Bot 的目录、端口和两类进程，见[安装与连接](../deploy/npm.md)。

## HTTP 契约

- `GET /api/ds-group-node/status` 返回节点、Bot、原生 Session 和本次进程计数。
- `GET /api/ds-group-node/models` 返回模型目录元信息。
- `POST /api/ds-group-node/bots` 接收 `botId/name/role/instructions`，保存外部身份与 DS-Bot 身份的映射。
- `POST /api/ds-group-node/turns` 接收 `requestId/botId/event/history/files`，设置 `async: true` 后返回 202。同 Bot 串行，重复完整请求返回持久回执，同 ID 不同内容拒绝。重启时尚未结束的请求保留为 `unknown`。
- `GET /api/ds-group-node/turns/:requestId` 查询持久任务、进度、工具和成果回执。
- `POST /api/ds-group-node/turns/:requestId/cancel` 取消队列或执行中的任务。

成功回执包含 `status=completed`、`text`、`sessionId`、`usage`、逐次生成的 `claims`、工具回执及 `artifacts`。模型最终回答遵循 JSON `text/artifacts/delegate` 协议，成果由适配层核验、上传并发送到原会话，跨节点消息通过 Matrix 投递。

## 交付目的地

适配层持久保存任务的交付意图、原始人类发起者及原始 Bot。模型可以提出 `delivery`，形如 `{"kind":"direct","recipientId":"原始人类完整ID"}`，采用时由程序校验当前请求并解析真实私聊房间。已经明确指定的交付意图作为权威路线，Bot 间的回传遵循 `returnTo`。

Core 根据私聊映射和实际成员计算 `conversationKind` 并随消息保存。已知人类私聊中的新任务默认采用私聊交付，显式本轮指令具有更高优先级。当前会话上下文也优先于历史跟进的默认路线，旧发送记录按原回执保存。

在途控制、回复锚点与已有成品重发由 `src/node-delivery.mjs` 协调。最终发送前重新检查近期指令，解析房间后的版本比较与首次发送计划在本地事务中完成。首次发送发起后整批保持同一目的地与事务编号，恢复使用保存的计划。要求私聊交付时，Bot 间委派和回传采用双方私聊，最终成果由原 Bot 投递到原始人类私聊。

## 模型与工具行为

当前适配器、配置准备和核心账本共同限制模型为 `opencode-go/deepseek-v4.1-flash`。这是当前实现限制，其他 provider/model 尚不可通过更改默认模型启用。运行时 effort 为 `low`，单次输出默认上限为 4096；凭据和调用额度由部署者提供。详见[配置与限制](../deploy/README.md#configuration)。所有实际 stream 先向核心 `/internal/model/claim` 记账，结束后向 `/internal/model/complete` 回报。核心不可达时不进入 provider。

Bot 初始化抑制自动问候。0.2.0 启用原生文件读写、编辑、终端、后台作业、图片及技能工具，默认每任务最多 64 步、15 分钟，每次模型请求独立记账。远程委派通过结构化回复完成。上下文连续性由 DS-Bot 与 DSH 原生 Session 承担，旧 Bot 的工具提示升级后沿用原身份和历史。自动长期记忆整理及长历史压缩按独立场景验收，provider retryPolicy 的 maxRetries 为 0。
