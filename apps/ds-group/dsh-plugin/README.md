# DSCord 的 DS-Bot 节点适配

本模块在独立 DSH 宿主内运行 DSCord 自有内核 `0.4.0`，基于 DS-Bot `0.3.1`，并提供 Bot 注册与对话 HTTP 接口。生命周期、部署和健康查询见[内核运行说明](../deploy/kernel-runtime.md)。

## 运行依赖

- 固定上游为 DS-Bot `0.3.1` / `6559c9e7c4ef71c292e6ac50f690031133536fe0`。随包源码位于 `../vendor/ds-bot/`；`UPSTREAM.json` 记录 npm 来源、完整性及 DSCord 适配修改，`LICENSE` 和 `NOTICE` 保留许可与声明。
- 发行节点使用 Linux amd64/arm64 与官方 npm DeepSeek Harness 0.2.2-rc.1 CLI。`index.mjs` 使用 Node `registerHooks` 将本模块及 vendored DS-Bot 的 SDK imports 解析到同一个宿主安装目录。
- 通过 `DS_GROUP_DSH_CLI` 和 `DS_GROUP_DSH_RUNTIME` 指定安装位置，启动器也会查找 PATH 中的 `dsh`。Linux 双架构纳入发行验证。本机开发环境已有 macOS 桌面版路径回退及历史 Session 重启证据，详见[发行验证](../发行验证.md)。
- `runtime-dependencies.json` 与随包 npm/pnpm 锁固定 MCP client `2.4.0`、deep-view `0.1.2`、imapflow `2.9.1`、mailparser `3.12.4`、nodemailer `10.2.1`、YAML `2.9.1` 和 zod `4.6.7`。启动器在数据目录按锁安装并核验运行依赖；第三方模块解析到该私有目录，DSH SDK 解析到实际宿主，用户无需手工复制依赖或向源码树写入链接。

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

模型与凭据在 DSH 中管理。CLI 使用 `DS_GROUP_DSH_SOURCE_HOME` 和 `DS_GROUP_DSH_SOURCE_PROFILE` 指向已有配置，用 `DS_GROUP_MODEL` 选择已有的 `provider/model`。节点复制所选 provider 的原生配置和必要凭据。CLI 未指定时回退到 `~/.dsh` / `desktop`，DSH 图形连接则使用实际宿主的 home/profile。凭据文件模式为 `0600`。

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

每个 Bot 使用保存的 DSH 模型选择。初次连接可沿用 DSH 默认模型，也可在连接页选择其他已配置模型。使用默认模型时继承 DSH 的默认思考强度，单次输出默认上限为 4096。配置准备保留所选 provider 的模型目录、覆盖项、协议、端点、headers 和重试设置。凭据和调用额度由部署者提供。详见[配置与限制](../deploy/README.md#configuration)。每次 stream 先按实际 `provider/model` 向核心 `/internal/model/claim` 记账，结束后向 `/internal/model/complete` 回报。核心不可达时不进入 provider。

Bot 初始化抑制自动问候。0.2.0 启用原生文件读写、编辑、终端、后台作业、图片及技能工具，默认每任务最多 64 步、15 分钟，每次模型请求独立记账。远程委派通过结构化回复完成。上下文连续性由 DS-Bot 与 DSH 原生 Session 承担，旧 Bot 的工具提示升级后沿用原身份和历史。自动长期记忆整理及长历史压缩按独立场景验收，provider 的原生 `retryPolicy` 随 DSH 配置继承。核心以 stream 为单位记账，provider 内部 HTTP 重试与完整费用需结合服务商账单核对。迁移和本轮验证见[模型配置与迁移](../模型配置与迁移.md)。
