# DSCord 服务器部署

服务器提供聊天核心、PWA、Matrix 和 Web Push 接口。Bot 节点通过公网 HTTPS 或内网地址连接核心，可以分别运行在其他机器。服务器数据保存在 Docker 命名卷中。

聊天客户端独立托管时，可通过 `DS_GROUP_WEB_MODE=api-only` 持久关闭 Core 的网页发布；原单服缺省仍托管 PWA。配置、CLI/Compose 入口及升级兼容见 [API-only 部署](api-only.md)。

中央默认归属、独立 administration 监听、三卷备份及真实发行部署验收见[中央平台部署与发行验证](platform-validation.md)。

本文对应 `0.3.0` 源码候选，新增账号注册、个人 Bot 创建与 DSH 连接页。公开 npm 包当前为 `0.2.0-alpha.1`，候选安装步骤见 [npm 说明](npm.md)。

## 支持范围

| 环境 | 部署方式 |
| --- | --- |
| Linux x86-64 | Docker Engine 和 Compose v2 |
| Linux ARM64 | Docker Engine 和 Compose v2，包括 ARM 云服务器及 64 位系统的树莓派 |

镜像内使用 Debian、Node 24.19.0 和 Synapse 1.164.2。Node、Synapse、Caddy 的镜像摘要均指向包含 amd64 与 arm64 的多架构索引。建议初始配置为 2 核 CPU、2 GB 内存和持久磁盘，实际容量取决于用户、消息及 Bot 数量。

这套 Compose 使用单实例核心与 Synapse SQLite。水平扩容、多副本共享写库和跨版本数据库迁移需要另行实施。发行 CI 会检查容器重建后数据保留以及备份恢复到新卷。

## 启动服务器

以下命令在 Linux 服务器的发布包根目录执行，源码仓库对应 `apps/ds-group/`。已有实例继续使用自己的 `.env` 和 Compose 项目名；首次部署先复制配置模板。

```sh
cp deploy/.env.example deploy/.env
```

**首次启动前先编辑 `deploy/.env`。** `DS_GROUP_SERVER_NAME` 是 Matrix 身份域，例如 `@your-account:chat.example.com` 中的 `chat.example.com`，初始化后必须保留。网页和 Matrix 的公开地址则按实际网络入口设置，服务器迁移后可以更新。下列域名仅为示例。

```dotenv
DS_GROUP_SERVER_NAME=chat.example.com
DS_GROUP_PUBLIC_URL=https://chat.example.com
DS_GROUP_MATRIX_PUBLIC_URL=https://chat.example.com
```

仅在服务器本机试用时，可以保留模板的 `localhost` 默认值。默认监听 `127.0.0.1`；其他设备不能通过自己的 `localhost` 访问这台服务器。内网直接访问时，将 `DS_GROUP_BIND` 设为服务器内网 IP，两个公开 URL 分别设置为可达的 `http://IP:18100` 和 `http://IP:18008`。若更改宿主端口，同时修改 `DS_GROUP_HTTP_PORT`、`DS_GROUP_MATRIX_PORT` 和对应 URL。

使用 HTTPS 时先完成下一节的域名配置，并使用带 HTTPS overlay 的启动命令。仅本机或内网 HTTP 部署执行：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
```

在浏览器打开配置的公开地址；默认本机入口为 `http://localhost:18100`。Core 的网页模式默认为 `bundled`，选择 `api-only` 时使用单独部署的聊天客户端。

### 注册与个人 Bot

在登录窗口选择“注册账号”，填写自己的用户名、显示名称和密码。注册后进入“我的 Bot”创建 Bot，随后从 DSH 连接。显示名称可以重复，稳定账号 ID 用于区分成员。新 Bot 由所有者邀请进群，也可以直接私聊。

注册默认开放。管理员可在 Core 数据卷的 `/data/core-config.json` 中设置 `registrationMode` 为 `closed`，再重启 Core 关闭注册；恢复为 `open` 后重新开放。初始化会保留已有配置。每次客户端登录拥有独立设备会话，退出一台设备只注销该会话。独立管理后台的账号与普通聊天账号分别管理，初始化方法见[后台说明](../admin/README.md)。

<a id="initial-accounts"></a>

### 初始演示账号

当前 `server-bootstrap.mjs` 在空实例中仍会创建 Alice、Bob、`finance` 和 `hr` 四个演示身份，两个 Bot 归 Alice 所有。这是尚未拆出的初始化种子数据；当前脚本没有跳过它们的选项。个人接入流程使用上方注册的账号和自己创建的 Bot。

需要检查演示账号时，管理员可读取其随机生成的初始密码。`credentials` 只适用于初始化记录中的账号，不提供后来注册用户的密码查询。

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T core \
  node scripts/server-admin.mjs credentials alice
```

输出含登录密码，仅在自己的管理员终端使用。Bot 初始离线，节点接入后才开始处理消息。

<a id="configuration"></a>

## 部署参数与当前限制

| 项目 | 当前默认或限制 | 部署时填写什么 |
| --- | --- | --- |
| Matrix 身份域 | 模板使用 `localhost` | 首次启动前决定自己的 `DS_GROUP_SERVER_NAME`，已有实例保留原值。 |
| 公开地址与监听 | 本机 Core `18100`、Matrix `18008` | 填写用户和 Bot 都能访问的地址；端口可通过 Compose 变量调整。 |
| 账号与 Bot | 引导脚本包含四个演示身份 | 注册自己的账号、创建自己的 Bot；CLI 使用 Bot 完整 ID 中 `@` 与 `:` 之间的账号部分。 |
| Node / DSH | Node `>=24.19.0 <25`，DSH `0.2.1-rc.5` | 当前适配器依赖这些版本，安装位置通过 PATH 或 `DS_GROUP_DSH_CLI` / `DS_GROUP_DSH_RUNTIME` 指定。 |
| DSH 配置来源 | CLI 回退到 `~/.dsh` 的 `desktop` profile | CLI 用 `DS_GROUP_DSH_SOURCE_HOME` 和 `DS_GROUP_DSH_SOURCE_PROFILE` 指定自己的来源；图形连接使用所在 DSH 宿主的实际 home/profile。 |
| 节点桥接端口 | 仅演示 `finance` / `hr` 预设 `18091` / `18092` | 自定义 CLI Bot 必须设置空闲的 `DS_GROUP_BRIDGE_PORT`；图形连接页自动分配。 |
| provider / model | 当前固定 `opencode-go/deepseek-v4.1-flash` | 使用自己的匹配凭据；当前版本尚不支持任意 provider/model 切换。 |
| 调用额度 | 新预算库默认 `modelCallLimit: null`，表示不限次数 | 根据自己的额度设置新实例配置；开发者的历史测试授权不适用于用户部署。 |

模型限制同时存在于[节点配置准备](../scripts/runtime-config.mjs)、[运行时](../dsh-plugin/runtime.mjs)与[核心账本](../src/budget.mjs)。`OPENCODE_API_KEY` 或已有 DSH profile 可提供该 provider 的凭据，`DS_GROUP_OPENCODE_BASE_URL` 只调整其服务端点；改变默认模型或端点不会解除模型限制。

新预算数据库首次创建时读取 `core-config.json` 的 `modelCallLimit` 和 `maxOutputTokens`，后者默认 `8192`。如需限制新实例的调用次数，应在 Core 第一次启动、创建 `model-budget.sqlite` 前填写预算配置。已有数据库保留原额度和账目，修改 JSON 不会更新既存额度；当前未提供在线调整额度的管理入口。Bot 单次输出默认上限另为 `4096`，两项含义不同。模型生成需要用户自己的调用授权和费用预算。

### 数据目录按运行方式区分

| 运行方式 | 默认保存位置 | 自定义方式 |
| --- | --- | --- |
| 源码开发演示 `npm run up` | 应用目录下 `.local/` | `DS_GROUP_DATA_DIR` |
| 源码 `server-init.mjs` 直接运行 | 当前目录的 `.local/server` 和 `.local/server-synapse` | `DS_GROUP_DATA_DIR`、`DS_GROUP_SYNAPSE_DIR` |
| npm CLI | 执行命令的当前目录下 `.dscord/` | 用绝对路径设置 `DS_GROUP_DATA_DIR`，管理同一实例时保持一致。 |
| Docker Compose | `core-data`、`synapse-data`、`governance-data` 三个命名卷 | 保留同一 Compose 项目名及卷配置。容器内 `/data` 是挂载点。 |
| DSH 图形连接 | `<实际 DSH home>/dscord/<当前 profile>/` | 在连接页查看“本机配置目录”，每个 Bot 有自己的子目录。 |
| systemd 模板 | `/var/lib/ds-group-<Bot账号>/` | 随安装位置调整单元和环境文件，见 [systemd 说明](systemd/README.md)。 |

## HTTPS 和手机通知

将域名 DNS 指向服务器，允许到达 80、443 端口，在 `deploy/.env` 中填写相同的 HTTPS 域名。

```dotenv
DS_GROUP_DOMAIN=chat.example.com
DS_GROUP_SERVER_NAME=chat.example.com
DS_GROUP_PUBLIC_URL=https://chat.example.com
DS_GROUP_MATRIX_PUBLIC_URL=https://chat.example.com
```

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.https.yaml up --build --detach --wait
```

Caddy 会管理公共 HTTPS 证书，并转发同一域名下的 PWA、核心 API 和 Matrix 客户端 API。Synapse 管理路由保持在 Docker 内部网络。已有反向代理的部署可以参照 `Caddyfile` 的路由规则，将流量发往两个本机端口。

### 代理与登录限流

Core 默认将连接的来源 IP 传给 Synapse，用于按访问地址计算登录限流。`compose.https.yaml` 会给 Core 启用 `DS_GROUP_TRUST_PROXY=true`，从单层 Caddy 代理传入的 `X-Forwarded-For` 最后一项读取合法 IP。

自行部署单层可信反向代理时，可以给 Core 进程设置 `DS_GROUP_TRUST_PROXY=true`，或在 `/data/core-config.json` 中设置 `trustProxy` 为 `true`。该选项适用于 Core 入口由这层代理控制、代理会写入实际来源地址的拓扑。直连部署使用默认值。多层代理需要另行配置真实地址传递关系。

初始化生成的 Synapse 登录限制分别为地址每秒 1 次、突发 20 次，账号每秒 0.003 次、突发 5 次，以及失败尝试每秒 0.17 次、突发 3 次。网页会显示服务器返回的等待时间，由用户等待后重新提交。升级已有部署时，重新运行初始化服务并重建 Synapse，使生成配置生效。

在手机上访问 HTTPS 地址并安装 PWA，然后在设置中主动启用通知。iOS/iPadOS 16.4 及以上需要先添加到主屏幕。Caddy 配置校验进入本地验证范围，公共证书签发和真实手机推送依赖部署域名及设备验证。

## 接入远端 Bot

先让 `DS_GROUP_PUBLIC_URL` 和 `DS_GROUP_MATRIX_PUBLIC_URL` 指向 Bot 机器可达的地址，并执行一次 Compose `up` 更新持久配置。

### DSH 图形连接

在服务器网页注册并创建自己的 Bot，按上方[当前限制](#configuration)在 Bot 机器的实际 DSH profile 中配置可用模型凭据。随后通过 `Plugins → Add plugin` 安装同版本 `dscord` 候选包并启用，点击左侧 **DSCord**。

输入 Core/PWA 的服务器地址、账号和密码，登录后在“我的 Bot”中点击“上线”。页面显示每个 Bot 的名称、ID 与连接状态，并提供断开、重连、打开网页和本机配置目录入口。程序会为每个 Bot 创建独立目录、端口与 DSH 运行时。

当前候选安装使用本地 `.tgz` 绝对路径，公开 npm 版本升级后再使用包名安装。详细步骤见 [DSH 安装与连接](npm.md#在-dsh-中连接)。

### CLI 节点导出

管理员也可以导出自己要连接的 Bot。参数使用完整 Bot ID 中 `@` 与 `:` 之间的账号部分，**不是显示名称**。下方 `your-bot-account`、路径和端口均需要按自己的部署填写，服务器端与节点端的 `BOT_ACCOUNT` 保持一致。文件包含该 Bot 的 Matrix token 和限定节点凭据。

在服务器端导出：

```sh
BOT_ACCOUNT='your-bot-account'
umask 077
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T core \
  node scripts/server-admin.mjs export-node "$BOT_ACCOUNT" > bot-node.json
```

将文件和同版本发布包传到 Bot 机器，在包目录执行。以下数据目录是可自选的示例，桥接端口须空闲，其他 Bot 使用各自的目录和端口。

```sh
BOT_ACCOUNT='your-bot-account'
export DS_GROUP_DATA_DIR="$HOME/.local/share/dscord-nodes/$BOT_ACCOUNT"
export DS_GROUP_BRIDGE_PORT=23100
npm ci --ignore-scripts --no-audit --no-fund
node scripts/server-admin.mjs import-node bot-node.json "$DS_GROUP_DATA_DIR"
npm install --prefix "$DS_GROUP_DATA_DIR/dsh-cli" --no-audit --no-fund @deepseek-ai/dsh@0.2.1-rc.5
export DS_GROUP_DSH_RUNTIME="$DS_GROUP_DATA_DIR/dsh-cli"
read -r -s OPENCODE_API_KEY
export OPENCODE_API_KEY
node scripts/service.mjs up "$BOT_ACCOUNT"
```

`read` 在 Bash / Zsh 终端隐藏输入的密钥。也可省略这两条凭据输入命令，设置 `DS_GROUP_DSH_SOURCE_HOME` 和 `DS_GROUP_DSH_SOURCE_PROFILE`，从自己的 DSH 配置复制匹配 provider。导入文件已经记录 Core 和 Matrix 地址；需要覆盖 Core 地址时使用 `DS_GROUP_CORE_URL`。每个 Bot 同时运行一个节点。

同一文件可重复导入以完成中断的写入。已有不同节点身份时导入会退出，应选择新的数据目录。若强制中止导入留下 `node-import.lock`，先确认导入进程已退出再移除该锁重试。

在保留同一组环境变量的终端停止节点及其 DSH：

```sh
node scripts/service.mjs down "$BOT_ACCOUNT"
node scripts/dsh-node.mjs stop "$BOT_ACCOUNT"
```

服务管理器可用 `node scripts/dsh-node.mjs run "$BOT_ACCOUNT"` 前台运行 DSH，另一个服务运行 `node src/bot-node.mjs --bot "$BOT_ACCOUNT"`。Linux 常驻服务配置见 [systemd 说明](systemd/README.md)。

## 附件存储

默认附件后端为 Synapse 本地媒体目录。启用 `deploy/storage/compose.s3.yaml` 可以使用 S3-compatible 桶，Cloudflare R2 使用对应 S3 endpoint。带 provider 的 Synapse 扩展镜像保留本地上传和缓存，同时等待远端写入完成。

`deploy/storage/compose.rclone.yaml` 提供已有 rclone remote 的内部网关接法，适用于后续 Drive、OneDrive 等 remote 验证。当前本地目录 remote 已完成限定 S3 协议测试，真实云账号另行验收。完整变量、镜像和启动命令见 [附件存储部署](storage/README.md)。

Core 的 `media.sqlite` 保存附件 ID、哈希、上传状态和 Matrix URI，房间与消息中的引用由 Matrix 保存。已有云盘文件的扫描、外部变更同步、搜索分页和导入仍需独立索引作业。

启用存储 overlay 后，日常启动、升级与恢复命令均保留相同 Compose 文件组合。备份同时覆盖 Core/Synapse 数据卷与桶中的文件字节。

## 状态和日常重启

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail 100 core synapse
docker compose --env-file deploy/.env -f deploy/compose.yaml restart core
```

`/healthz` 检查核心进程，`/readyz` 还检查 Matrix 连通性。Compose 使用健康检查等待首次启动。用户、消息、任务账本、推送密钥、订阅和治理策略保存在 `core-data`、`synapse-data`、`governance-data` 三个命名卷中。

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml down
docker compose --env-file deploy/.env -f deploy/compose.yaml up --detach --wait
```

`down` 保留数据卷。`down --volumes` 会删除该 Compose 项目的数据，只用于明确需要清空的测试项目。

## 备份和恢复

先暂停 Bot 节点，再停止 Core、administration、Synapse 三个写入服务。下面在同一终端定义 `dc`，后续命令均用它指定项目。`ds-group` 是模板默认项目名，请填写实际部署使用的名称；HTTPS 或存储 overlay 也要加入 `dc` 的文件组合。

```sh
export DS_GROUP_COMPOSE_PROJECT=ds-group
dc() { docker compose --env-file deploy/.env --project-name "$DS_GROUP_COMPOSE_PROJECT" -f deploy/compose.yaml "$@"; }
umask 077
mkdir -p .local/backups
dc stop --timeout 45 core administration synapse
dc run --rm --no-deps -T --user 0:0 config tar -czf - -C /data . > .local/backups/core.tgz
dc run --rm --no-deps -T --user 0:0 config tar -czf - -C /synapse . > .local/backups/synapse.tgz
dc run --rm --no-deps -T --user 0:0 config tar -czf - -C /dscord-policy . > .local/backups/governance.tgz
dc up --detach --wait
```

备份包含密码、token、VAPID 密钥及聊天内容，保存到管理员控制的存储中。HTTPS 的 Caddy 证书卷独立保留，公共证书也可由同域名重新申请。

恢复到新的 Compose 项目时，保留原来的 `DS_GROUP_SERVER_NAME`，先停止占用相同端口的旧实例，并选择一个尚无数据卷的项目名。

```sh
export DS_GROUP_COMPOSE_PROJECT=ds-group-restore
dc run --rm --no-deps -T --user 0:0 config tar -xzf - -C /data < .local/backups/core.tgz
dc run --rm --no-deps -T --user 0:0 config tar -xzf - -C /synapse < .local/backups/synapse.tgz
dc run --rm --no-deps -T --user 0:0 config tar -xzf - -C /dscord-policy < .local/backups/governance.tgz
dc up --detach --wait
```

恢复完成后确认成员、历史消息、节点身份和推送公钥，再恢复 Bot 处理。HTTPS 部署需在 `dc` 函数中同时加入 `-f deploy/compose.https.yaml`。已启用 S3 或 rclone 的部署也加入对应存储 overlay，并恢复匹配的远端文件。

## 升级

先按上节保存停机备份和当前版本，再解压新的发布包并复制现有 `deploy/.env`。使用相同 Compose 项目名可复用原有数据卷。

```sh
dc up --build --detach --wait
```

使用已发布镜像时，将 `DS_GROUP_IMAGE` 设为选定版本，运行 `dc pull` 后执行 `dc up --no-build --detach --wait`。发行流水线生成的校验和用于核对下载包。

当前验证覆盖同版本容器重建、备份及新卷恢复。将来涉及数据库迁移的版本需要增加对应迁移测试。版本回退时使用对应旧版程序和升级前备份恢复到新卷。

## 自行运行发行冒烟检查

```sh
docker build --tag ds-group:ci .
DS_GROUP_IMAGE=ds-group:ci node scripts/deploy-smoke.mjs
```

脚本创建随机命名的独立项目，使用自动分配的本机端口，验证登录、建群、消息、PWA、节点导出与真实适配进程接入、容器重建、请求去重、备份恢复及零模型调用。适配进程的推理桥接使用仅接受注册的夹具，Matrix 与核心是实际容器。结果写入 `.local/deploy-smoke.json`，测试创建的容器和数据卷在结束时清理。

## 上游部署资料

- [Synapse 官方安装与 Docker 支持](https://element-hq.github.io/synapse/latest/setup/installation.html)
- [Compose 启动顺序和健康检查](https://docs.docker.com/compose/how-tos/startup-order/)
- [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)
