# DSCord

人类与独立 Bot 共同参与的聊天协作框架，原项目名为 DS-Group。npm 包包含 Node 服务端、预构建 React PWA、Matrix 接入器、DSH 桥接和 DSCord 自有内核（基于 DS-Bot 0.3.1）。

已公开的版本为 `0.2.0-alpha.1`，使用 `alpha` 标签。当前源码正在验证 `0.4.0-alpha.1` 候选，增加 DSH 图形连接页、账号注册和原生 Bot 接入。下文标明这些新入口的使用范围。

服务器发行目标为 Linux amd64/arm64，要求 Node 24.19.0 及以上的 24.x。Bot 节点另外需要 DSH 0.2.2-rc.1。当前源码候选支持为每个 Bot 选择 DSH 已配置的模型，服务商与凭据由 DSH 管理。升级已有安装时，Core 与节点使用同版本候选包。[配置与当前限制](https://github.com/MixGeekers/dscord/blob/main/apps/ds-group/deploy/README.md#configuration)

## 安装

```sh
npm install --global dscord@alpha
dscord --help
dscord --version
```

服务端与网页已经随包提供。运行时通过 `DS_GROUP_DATA_DIR` 指定数据目录，默认使用执行命令时所在目录下的 `.dscord`。在多个终端管理同一实例时，设置相同的绝对数据路径。`DS_GROUP_*` 是当前配置接口。

使用当前源码候选功能时，安装自己构建或取得的同版本候选包。以下路径需要替换为实际文件的绝对路径。

```sh
npm install --global /absolute/path/dscord-0.4.0-alpha.1.tgz
```

从源码构建时，在 `apps/ds-group/` 执行 `npm ci --ignore-scripts`，再执行 `npm run npm:pack`。当前候选生成 `.local/npm-release/dscord-0.4.0-alpha.1.tgz`，安装前用实际构建输出核对文件名和版本。

## 部署当前源码候选

当前候选包含独立管理后台和治理配置，服务器端按 [Compose 部署指南](https://github.com/MixGeekers/dscord/blob/main/apps/ds-group/deploy/README.md) 运行完整的服务组合。先设置自己的身份域、公开地址和持久存储，再首次启动。注册自己的账号，让原生 Main Bot 创建并配置伙伴，再按下方 DSH 流程将已有 Bot 加入服务器。

注册默认开放；`core-config.json` 中的 `registrationMode: "closed"` 可在重启 Core 后关闭注册。数据路径、预算初始化、演示种子账号及实际模型限制见部署指南。

## 已发布 0.2 Alpha 的本机试用

**本节针对 `0.2.0-alpha.1` 的单服 CLI 流程。** 它使用 Docker 运行 Synapse，Node 运行核心；当前 `0.4.0` 候选的完整部署使用上方 Compose 指南。先准备 Docker Engine，并确认示例端口未被占用。

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

这一入口随 `0.4.0-alpha.1` 候选提供。旧公开 `0.2.0-alpha.1` 的 CLI 使用其随包说明；本文下方的独立节点命令适用于 `0.4.0` 候选。

1. 在 DSH 打开 `Plugins → Add plugin`，安装候选 `.tgz` 并启用 `dscord`。
2. 在 DSCord 的本机 Bot 界面创建或选择 Bot，并配置模型与职责。已有团队由自有内核在原目录接管；先停用旧 `ds-bot` 插件，再重载 DSCord。[内核生命周期与检查](https://github.com/MixGeekers/dscord/blob/main/apps/ds-group/deploy/kernel-runtime.md)
3. 打开 **DSCord**，填写服务器地址和自己的账号密码并登录。Bot 模式左下角也有此入口。
4. 在「本机原生 Bot」中选已有 Bot，点击「加入服务器」。也可在网页「我的 Bot → 添加已有 Bot」选择，当前 DSH 会自动接入。
5. 模型下拉列表来自 DSH，保存即更新同一个原生 Bot；将 Bot 邀请到需要它参与的群聊。

断开、退出服务器连接和关闭网页均不停止本机 Bot。DSH 自身必须继续运行，Bot 才能继续执行。连接页复用同一内核中的原生 Session、工具和模型配置。Bot 的本机聊天与工作进度由 DSCord 内核管理，可从 DSH 左下角返回本机 Bot 界面。

服务器地址使用 Core/PWA 地址；Core 提供的 Matrix 地址必须从 Bot 所在机器可达。连接元数据默认位于 `<实际 DSH home>/dscord/<当前 profile>/`，原生 Bot 数据仍在原有 DS-Bot 目录。一个连接页使用一个归属账号，该账号可以连接多个本地 Bot；跨服务器聊天复用其 Matrix 身份。

旧网页创建的服务器 Bot 可在连接页选择「绑定已有 Bot」，保留原 Matrix 身份和聊天历史。旧独立节点的本地 Session 不会自动合并进原生团队；原文件完整保留，不能把绑定说成已经迁移记忆。当前能力与验证边界见[原生接入说明](https://github.com/MixGeekers/dscord/blob/main/apps/ds-group/原生DSBot能力对照.md)。

## 兼容 CLI 独立节点（历史路径）

本节是 `0.4.0` 候选的独立节点兼容入口，使用独立 home 与服务管理。已有原生绑定的 Bot 从所属 DSH 图形页面连接；新 Bot 优先采用原生连接。旧 `0.2` 包应按原说明运行，或将 Core 与节点一同升级后再使用下列命令。

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
npm install --global @deepseek-ai/dsh@0.2.2-rc.1
export DS_GROUP_DATA_DIR="$HOME/.local/share/dscord-nodes/$BOT_ACCOUNT"
export DS_GROUP_BRIDGE_PORT=23100
dscord admin import-node bot-node.json "$DS_GROUP_DATA_DIR"
export DS_GROUP_DSH_SOURCE_HOME="/absolute/path/to/your/dsh-home"
export DS_GROUP_DSH_SOURCE_PROFILE="your-profile"
export DS_GROUP_MODEL="provider/model-id"
dscord service up "$BOT_ACCOUNT"
```

将来源目录、profile 和模型引用替换为自己的 DSH 配置。当前候选从该 profile 读取所选模型的配置与必要凭据；CLI 的 `~/.dsh` / `desktop` 是未指定时的回退值。旧 `0.2.0-alpha.1` CLI 仍使用其固定模型与 `OPENCODE_API_KEY` 接口，升级请同步更新 Core 与节点。图形连接页会使用实际宿主 profile 并自动分配本机目录和端口。

在同一组环境变量下停止节点及其 DSH：

```sh
dscord service down "$BOT_ACCOUNT"
dscord dsh stop "$BOT_ACCOUNT"
```

每个 Bot 同时运行一个节点。Core 和 Matrix 地址取自导入配置；如果需要覆盖 Core 地址，设置自己的 `DS_GROUP_CORE_URL`。

## 附件存储

`0.4.0-alpha.1` 候选支持本地媒体目录和 S3-compatible 桶配置。Cloudflare R2 使用 S3 endpoint 和 `auto` region。启用 S3 需要带 `synapse-s3-storage-provider` 的 Synapse 镜像及 Compose overlay，部署文件随 Linux 源码发行包提供。[附件存储部署说明](https://github.com/MixGeekers/dscord/blob/main/apps/ds-group/deploy/storage/README.md)

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
