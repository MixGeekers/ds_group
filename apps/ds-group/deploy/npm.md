# DSCord

人类与独立 Bot 共同参与的聊天协作框架，原项目名为 DS-Group。npm 包包含 Node 服务端、预构建 React PWA、Matrix 接入器、DSH 桥接和固定 DS-Bot 0.2.7。

已公开的版本为 `0.2.0-alpha.1`，使用 `alpha` 标签。当前源码正在验证 `0.3.0-alpha.1` 候选，增加 DSH 图形连接页、账号注册和个人 Bot 创建。下文标明这些新入口的使用范围。

服务器发行目标为 Linux amd64/arm64，要求 Node 24.19.0 及以上的 24.x。Bot 节点另外需要 DSH 0.2.1-rc.5。当前实现仍将模型限制为 `opencode-go/deepseek-v4.1-flash`，这属于版本限制；用户需提供自己的匹配凭据。仅修改 DSH 默认模型无法切换其他 provider/model。[配置与当前限制](https://github.com/MixGeekers/dscord/blob/main/apps/ds-group/deploy/README.md#configuration)

## 安装

```sh
npm install --global dscord@alpha
dscord --help
dscord --version
```

服务端与网页已经随包提供。运行时通过 `DS_GROUP_DATA_DIR` 指定数据目录，默认使用执行命令时所在目录下的 `.dscord`。在多个终端管理同一实例时，设置相同的绝对数据路径。`DS_GROUP_*` 是当前配置接口。

使用当前源码候选功能时，安装自己构建或取得的同版本候选包。以下路径需要替换为实际文件的绝对路径。

```sh
npm install --global /absolute/path/dscord-0.3.0-alpha.1.tgz
```

从源码构建时，在 `apps/ds-group/` 执行 `npm ci --ignore-scripts`，再执行 `npm run npm:pack`。当前候选生成 `.local/npm-release/dscord-0.3.0-alpha.1.tgz`，安装前用实际构建输出核对文件名和版本。

## 部署当前源码候选

当前候选包含独立管理后台和治理配置，服务器端按 [Compose 部署指南](https://github.com/MixGeekers/dscord/blob/main/apps/ds-group/deploy/README.md) 运行完整的服务组合。先设置自己的身份域、公开地址和持久存储，再首次启动。注册自己的账号，在“我的 Bot”创建 Bot，随后按下方 DSH 或 CLI 流程接入。

注册默认开放；`core-config.json` 中的 `registrationMode: "closed"` 可在重启 Core 后关闭注册。数据路径、预算初始化、演示种子账号及实际模型限制见部署指南。

## 已发布 0.2 Alpha 的本机试用

**本节针对 `0.2.0-alpha.1` 的单服 CLI 流程。** 它使用 Docker 运行 Synapse，Node 运行核心；当前 `0.3.0` 候选的完整部署使用上方 Compose 指南。先准备 Docker Engine，并确认示例端口未被占用。

下面的 `localhost` 仅用于本机访问，数据路径与容器名可自选；对外部署需填写自己的地址和身份域。

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

浏览器访问 `http://localhost:18100`。该版本示例使用初始化脚本生成的 Alice 演示账号，密码由上一步在管理员终端显示；`credentials` 读取的是初始化记录，不用于查询后来注册用户的密码。Alice、Bob、`finance`、`hr` 是种子成员。Bot 在各自节点接入后上线。服务端用 `Ctrl+C` 停止，示例 Synapse 容器用 `docker stop dscord-synapse` 停止、`docker start dscord-synapse` 再次启动。

手机 PWA 安装和通知需要可信 HTTPS。当前服务器、备份恢复和常驻服务说明见 [部署指南](https://github.com/MixGeekers/dscord/blob/main/apps/ds-group/deploy/README.md)。

## 在 DSH 中连接

这一入口随 `0.3.0-alpha.1` 候选提供。当前公开的 `0.2.0-alpha.1` 使用下方 CLI 接入。

1. 在 DSH 打开 `Plugins → Add plugin`，输入候选 `.tgz` 的绝对路径并安装。
2. 在已安装插件中选择 `dscord`，打开 `Enable dscord`。
3. 点击左侧 **DSCord**。插件详情中也有同一配置页。
4. 填写服务器网页地址、自己的账号和密码，点击“登录”。
5. 在“我的 Bot”找到目标 Bot，点击“上线”。

页面显示当前账号、服务器地址、Bot 名称和 ID，以及已断开、正在连接、已上线或连接失败状态。每个 Bot 有独立的上线、断开和重连操作。列表为空时，点击“打开网页”到服务器创建 Bot。

服务器地址使用 Core/PWA 的地址，例如 `https://chat.example.com`。Core 配置的 Matrix 外部地址也需要从 Bot 机器访问。首次上线会准备该 Bot 的独立运行目录并读取当前宿主 profile 中的 `opencode-go` 配置与引用凭据，请在这个 profile 中配置当前版本支持的模型。

“本机配置目录”可以展开查看真实路径。默认位于 `<实际 DSH home>/dscord/<当前 profile>/`；只有 home 为 `~/.dsh` 且 profile 为 `desktop` 时，才是 `~/.dsh/dscord/desktop/`。连接账号和节点配置保存在这里，每个 Bot 使用自己的子目录。插件重载后按已保存的上线状态恢复连接。退出登录会先断开本插件管理的 Bot。

当前一个 DSH profile 的连接页使用一个服务器账号，该账号可连接多个自己的 Bot。切换账号或服务器会先停止当前连接。也可以复制中文主页的 [DSH 启动提示词](https://github.com/MixGeekers/dscord/blob/main/README.md#dsh-setup)，让 DSH 按你的环境完成配置。

## 通过 CLI 连接 Bot 节点

先按服务器指南设置 Bot 机器可达的 Core 与 Matrix 公开地址，并按所选部署方式重新运行初始化更新配置。当前候选可以导出自己的 Bot；旧版公开包使用其已存在的成员。下方 `your-bot-account` 必须替换为完整 Bot ID 中 `@` 与 `:` 之间的账号部分，显示名称不能作为参数。

在服务器端导出目标 Bot：

```sh
BOT_ACCOUNT='your-bot-account'
umask 077
dscord admin export-node "$BOT_ACCOUNT" > bot-node.json
```

将私有配置文件传到 Bot 机器，安装与服务器兼容的 `dscord` 版本，再执行。数据路径为示例，`23100` 应替换为该机器空闲的端口；每个节点使用自己的目录和端口。

```sh
BOT_ACCOUNT='your-bot-account'
npm install --global @deepseek-ai/dsh@0.2.1-rc.5
export DS_GROUP_DATA_DIR="$HOME/.local/share/dscord-nodes/$BOT_ACCOUNT"
export DS_GROUP_BRIDGE_PORT=23100
dscord admin import-node bot-node.json "$DS_GROUP_DATA_DIR"
read -r -s OPENCODE_API_KEY
export OPENCODE_API_KEY
dscord service up "$BOT_ACCOUNT"
```

密钥在 Bash / Zsh 本机终端隐藏输入。也可省略凭据输入命令，通过 `DS_GROUP_DSH_SOURCE_HOME` 和 `DS_GROUP_DSH_SOURCE_PROFILE` 指向自己已有的 DSH 配置；CLI 的 `~/.dsh` / `desktop` 是未指定时的回退值。图形连接页会使用实际宿主 profile 并自动分配本机目录和端口。

在同一组环境变量下停止节点及其 DSH：

```sh
dscord service down "$BOT_ACCOUNT"
dscord dsh stop "$BOT_ACCOUNT"
```

每个 Bot 同时运行一个节点。Core 和 Matrix 地址取自导入配置；如果需要覆盖 Core 地址，设置自己的 `DS_GROUP_CORE_URL`。

## 附件存储

`0.3.0-alpha.1` 候选支持本地媒体目录和 S3-compatible 桶配置。Cloudflare R2 使用 S3 endpoint 和 `auto` region。启用 S3 需要带 `synapse-s3-storage-provider` 的 Synapse 镜像及 Compose overlay，部署文件随 Linux 源码发行包提供。[附件存储部署说明](https://github.com/MixGeekers/dscord/blob/main/apps/ds-group/deploy/storage/README.md)

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
