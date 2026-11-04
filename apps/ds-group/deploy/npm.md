# DSCord

人类与独立 Bot 共同参与的聊天协作框架，原项目名为 DS-Group。npm 包包含 Node 服务端、预构建 React PWA、Matrix 接入器、DSH 桥接和固定 DS-Bot 0.2.7。

当前为 `0.2.0-alpha.1`，使用 `alpha` 标签发布。服务器发行目标为 Linux amd64/arm64，要求 Node 24.19.0 及以上的 24.x。Bot 节点另外需要 DSH 0.2.1-rc.5 和 `opencode-go/deepseek-v4.1-flash` 模型配置。

## 安装

```sh
npm install --global dscord@alpha
dscord --help
dscord --version
```

服务端与网页已经随包提供。运行时通过 `DS_GROUP_DATA_DIR` 指定数据目录，默认使用执行命令时所在目录下的 `.dscord`。在多个终端管理同一实例时，设置相同的绝对数据路径。`DS_GROUP_*` 是当前配置接口。

## 启动本机服务器

以下步骤使用 Docker 运行独立 Synapse，核心通过 Node 启动。先安装 Docker Engine 并启动 Docker 服务。

```sh
export DS_GROUP_DATA_DIR="$HOME/.local/share/dscord"
export DS_GROUP_SERVER_NAME=localhost
export DS_GROUP_MATRIX_URL=http://127.0.0.1:18008
export DS_GROUP_MATRIX_PUBLIC_URL=http://localhost:18008
export DS_GROUP_PUBLIC_URL=http://localhost:18100
dscord init

docker run --detach --name dscord-synapse \
  --user "$(id -u):$(id -g)" \
  --publish 127.0.0.1:18008:8008 \
  --mount "type=bind,source=$DS_GROUP_DATA_DIR/synapse,target=/data" \
  ghcr.io/element-hq/synapse@sha256:f0df87cff259872637b4b5e5174b9977e5e3046dd421505407803b5e45c5f842
```

等待 Synapse 的 `http://127.0.0.1:18008/_matrix/client/versions` 返回成功，再执行。

```sh
dscord bootstrap
dscord admin credentials alice
dscord server
```

浏览器访问 `http://localhost:18100`，使用上一步在管理员终端显示的 Alice 登录信息。初始化会创建 Alice、Bob、财务和人事四个独立成员。Bot 在各自节点接入后上线。服务端通过 `Ctrl+C` 停止，Synapse 可通过 `docker stop dscord-synapse` 停止，并通过 `docker start dscord-synapse` 再次启动。

HTTPS、Docker Compose、备份恢复与 systemd 的完整部署流程见源码仓库中的部署指南。手机 PWA 安装和通知需要可信 HTTPS。[服务器部署指南](https://github.com/MixGeekers/ds_group/blob/main/apps/ds-group/deploy/README.md)

## 连接 Bot 节点

先按服务器部署指南配置 HTTPS 反向代理，使核心 API 和 Matrix API 可从 Bot 机器访问。然后将 `DS_GROUP_PUBLIC_URL` 和 `DS_GROUP_MATRIX_PUBLIC_URL` 配置为对应的外部地址，再执行 `dscord init` 和 `dscord bootstrap` 更新地址。使用目标 Bot 的名称导出节点配置。

```sh
umask 077
dscord admin export-node finance > finance-node.json
```

将配置文件传到 Bot 机器，在该机器安装 `dscord@alpha` 和 DSH，再执行。

```sh
npm install --global @deepseek-ai/dsh@0.2.1-rc.5
export DS_GROUP_DATA_DIR="$HOME/.local/share/dscord-finance"
dscord admin import-node finance-node.json "$DS_GROUP_DATA_DIR"
read -r -s OPENCODE_API_KEY
export OPENCODE_API_KEY
dscord service up finance
```

`OPENCODE_API_KEY` 在本地终端输入。人事节点使用 `hr` 及独立数据目录。使用以下命令停止财务节点及其 DSH。

```sh
dscord service down finance
dscord dsh stop finance
```

当前 npm 入口提供 CLI 部署。DSH 桌面“添加插件”中的直接安装与自动接入仍待实现。

## 包内组件

- `dscord server` 启动核心 API 和预构建 PWA。
- `dscord init` 与 `dscord bootstrap` 管理服务器初始化和 Matrix 成员。
- `dscord admin` 读取账号、导出和导入节点配置。
- `dscord node` 运行 Matrix 适配进程。
- `dscord dsh` 管理独立 DSH 运行时。
- `dscord service` 管理本机核心和 Bot 进程。
- `dscord path` 显示安装目录。

上游 DS-Bot 的 Apache-2.0 LICENSE 与 NOTICE 位于 `vendor/ds-bot/`。Lucide 的 ISC 与 Feather MIT 许可位于 `dist/web/licenses/lucide.txt`。
