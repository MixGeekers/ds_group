# DS-Group 的 DS-Bot 节点适配

本模块在独立 DSH 宿主内装载 DS-Bot 0.2.7，并提供 DS-Group 的 Bot 注册与对话 HTTP 接口。

## 运行依赖

- 固定上游为 `71d344bf193f3f18185f25de3d8e5c483046910a`。原始 npm 包保存在 `../vendor/ds-bot/`，`UPSTREAM.json`、`LICENSE` 和 `NOTICE` 记录来源及许可，上游源码保持未修改。
- 本轮宿主为本机安装的 DeepSeek Harness 0.2.1-rc.5。`index.mjs` 使用 Node `registerHooks` 将本模块及 vendored DS-Bot 的 SDK imports 解析到同一个宿主安装目录。
- macOS 默认 CLI 是 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。`DS_GROUP_DSH_CLI` 和 `DS_GROUP_DSH_RUNTIME` 可以指定其他安装位置。其他平台的实际启动仍需验证。
- `runtime-dependencies.json` 与 `runtime-dependencies-lock.json` 固定 `deep-view@0.1.0`、`yaml@2.9.1`。启动器在私有 `.local/dsh-deps/` 使用 `npm ci --ignore-scripts` 准备依赖，再创建本地依赖链接。

## 启动和停止

在 DS-Group 包目录运行。

```sh
node scripts/dsh-node.mjs start finance
node scripts/dsh-node.mjs start hr
node scripts/dsh-node.mjs status finance
node scripts/dsh-node.mjs stop finance
```

两个桥接端口分别为 `127.0.0.1:18091` 和 `127.0.0.1:18092`。每个宿主拥有独立 `.local/dsh-<node>/home/`、DS-Bot 数据目录、原生 Session 与工作区。启动器只复制原有 `opencode-go` 配置和它引用的一个模型凭据到私有目录，文件模式为 `0600`。停止命令等待对应进程退出及桥接端口关闭。

## HTTP 契约

- `GET /api/ds-group-node/status` 返回节点、Bot、原生 Session 和本次进程计数。
- `GET /api/ds-group-node/models` 返回模型目录元信息。
- `POST /api/ds-group-node/bots` 接收 `botId/name/role/instructions`，保存外部身份与 DS-Bot 身份的映射。
- `POST /api/ds-group-node/turns` 接收 `requestId/botId/event/history`。同 Bot 串行，重复完整请求返回持久回执，同 ID 不同内容拒绝。重启时尚未结束的请求保留为 `unknown`。

成功回执包含 `status=completed`、`text`、`sessionId`、`usage` 和 `claimId`。模型回答遵循 JSON `text/delegate` 协议，跨节点消息由 DS-Group Matrix 适配层投递。

## 首轮模型行为

唯一远端模型为 `opencode-go/deepseek-v4.1-flash`，effort 为 `low`，单次输出上限为 4096。所有实际 stream 先向核心 `/internal/model/claim` 记账，结束后向 `/internal/model/complete` 回报。核心不可达时不进入 provider。

Bot 初始化抑制自动问候。首轮关闭自动 memory review，模型工具列表为空，远程委派通过结构化回复完成。上下文连续性由真实 DS-Bot 与 DSH Session 承担，首轮尚未验证自动长期记忆整理或上下文压缩。每个 turn 只允许一个 native 模型请求，provider retryPolicy 的 maxRetries 为 0。
