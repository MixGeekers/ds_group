# DSCord

人类与独立 Bot 共同参与的聊天协作框架，原项目名为 DS-Group。npm 包包含 Node 服务端、预构建 React PWA、Matrix 接入器、DSH 桥接和固定 DS-Bot 0.2.7。

已公开的版本为 `0.2.0-alpha.1`，使用 `alpha` 标签。当前源码正在验证 `0.3.0-alpha.1` 候选，增加 DSH 图形连接页、账号注册和个人 Bot 创建。下文标明这些新入口的使用范围。

服务器发行目标为 Linux amd64/arm64，要求 Node 24.19.0 及以上的 24.x。Bot 节点另外需要 DSH 0.2.1-rc.5 和 `opencode-go/deepseek-v4.1-flash` 模型配置。

## 安装

```sh
npm install --global dscord@alpha
dscord --help
dscord --version
```

服务端与网页已经随包提供。运行时通过 `DS_GROUP_DATA_DIR` 指定数据目录，默认使用执行命令时所在目录下的 `.dscord`。在多个终端管理同一实例时，设置相同的绝对数据路径。`DS_GROUP_*` 是当前配置接口。

本地验证新功能时，安装已构建的候选包。

```sh
npm install --global /absolute/path/dscord-0.3.0-alpha.1.tgz
```

源码维护者在 `apps/ds-group/` 执行 `npm run npm:pack`，生成 `.local/npm-release/dscord-0.3.0-alpha.1.tgz`。

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

`0.3.0-alpha.1` 候选的登录窗口提供“注册账号”。填写用户名、显示名称和密码后即可进入服务器，在“我的 Bot”中创建自己的 Bot。显示名称可以相同，每个 Bot 的账号 ID 独立。创建后从 DSH 上线，再直接私聊或邀请进群。

默认开放注册。管理员可以将数据目录中 `core-config.json` 的 `registrationMode` 设置为 `closed`，重启 Core 后关闭注册入口。已有账号继续通过用户名和密码登录。退出当前客户端会注销该客户端的登录会话。

HTTPS、Docker Compose、备份恢复与 systemd 的完整部署流程见源码仓库中的部署指南。手机 PWA 安装和通知需要可信 HTTPS。[服务器部署指南](https://github.com/MixGeekers/ds_group/blob/main/apps/ds-group/deploy/README.md)

## 在 DSH 中连接

这一入口随 `0.3.0-alpha.1` 候选提供。当前公开的 `0.2.0-alpha.1` 使用下方 CLI 接入。

1. 在 DSH 打开 `Plugins → Add plugin`，输入候选 `.tgz` 的绝对路径并安装。
2. 在已安装插件中选择 `dscord`，打开 `Enable dscord`。
3. 点击左侧 **DSCord**。插件详情中也有同一配置页。
4. 填写服务器网页地址、自己的账号和密码，点击“登录”。
5. 在“我的 Bot”找到目标 Bot，点击“上线”。

页面显示当前账号、服务器地址、Bot 名称和 ID，以及已断开、正在连接、已上线或连接失败状态。每个 Bot 有独立的上线、断开和重连操作。列表为空时，点击“打开网页”到服务器创建 Bot。

服务器地址使用 Core/PWA 的地址，例如 `https://chat.example.com`。Core 配置的 Matrix 外部地址也需要从 Bot 机器访问。首次上线会准备该 Bot 的独立运行目录并读取当前 DSH profile 中的指定模型配置。

“本机配置目录”可以展开查看真实路径。默认位于 `DSH_HOME/dscord/<profile>/`，通常为 `~/.dsh/dscord/desktop/`。连接账号和节点配置保存在这里，每个 Bot 使用自己的子目录。插件重载后按已保存的上线状态恢复连接。退出登录会先断开本插件管理的 Bot。

当前一个 DSH profile 的连接页使用一个服务器账号，该账号可连接多个自己的 Bot。切换账号或服务器会先停止当前连接。

## 通过 CLI 连接 Bot 节点

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

新建 Bot 的 CLI 参数使用其 ID 中 `@` 与 `:` 之间的账号部分。为每个自定义 Bot 设置独立 `DS_GROUP_DATA_DIR` 和 `DS_GROUP_BRIDGE_PORT`。DSH 连接页会自动分配这些本机配置。

## 附件存储

`0.3.0-alpha.1` 候选支持本地媒体目录和 S3-compatible 桶配置。Cloudflare R2 使用 S3 endpoint 和 `auto` region。启用 S3 需要带 `synapse-s3-storage-provider` 的 Synapse 镜像及 Compose overlay，部署文件随 Linux 源码发行包提供。[附件存储部署说明](https://github.com/MixGeekers/ds_group/blob/main/apps/ds-group/deploy/storage/README.md)

Core 的附件身份、哈希和上传状态保存在本地数据库，文件字节由 Synapse 保存到所选后端。Compose 另提供已有 rclone remote 的网关模板，本地目录 remote 已完成限定协议测试。Google Drive 和 OneDrive 的真实云账号授权、历史文件迁移和远端清理仍需后续验收。

## 包内组件

- `dscord server` 启动核心 API 和预构建 PWA。
- `dscord init` 与 `dscord bootstrap` 管理服务器初始化和 Matrix 成员。
- `dscord admin` 读取账号、导出和导入节点配置。
- `dscord node` 运行 Matrix 适配进程。
- `dscord dsh` 管理独立 DSH 运行时。
- `dscord service` 管理本机核心和 Bot 进程。
- `dscord path` 显示安装目录。

上游 DS-Bot 的 Apache-2.0 LICENSE 与 NOTICE 位于 `vendor/ds-bot/`。Lucide 的 ISC 与 Feather MIT 许可位于 `dist/web/licenses/lucide.txt`。
