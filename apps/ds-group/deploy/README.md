# DSCord 服务器部署

服务器提供聊天核心、PWA、Matrix 和 Web Push 接口。Bot 节点通过公网 HTTPS 或内网地址连接核心，可以分别运行在其他机器。服务器数据保存在 Docker 命名卷中。

本指南对应 DSCord **0.4.0-alpha.1**。服务器、网页和节点使用同一发行版本；安装包与精确 npm 发布号以所选发行说明为准。[安装与连接](npm.md)

Core 可采用 `bundled` 托管网页，或通过 `DS_GROUP_WEB_MODE=api-only` 配合独立静态客户端。[API-only 部署](api-only.md) · [客户端部署](client/README.md)

Bot 节点的兼容宿主、唯一实例和原目录采用见[内核运行](kernel-runtime.md)。本页示例的域名、端口、账号和目录需要按自己的部署替换。

## 支持范围

| 环境 | 部署方式 |
| --- | --- |
| Linux x86-64 | Docker Engine 和 Compose v2 |
| Linux ARM64 | Docker Engine 和 Compose v2，包括 ARM 云服务器及 64 位系统的树莓派 |

镜像内使用 Debian、Node 24.19.0 和 Synapse 1.164.2，版本与摘要见 [Dockerfile](../Dockerfile) 和 [Compose](compose.yaml)。资源需求取决于用户、消息、附件和 Bot 数量；本地模型的计算资源另计，应按自己的负载测量容量。

这套 Compose 使用单实例核心与 Synapse SQLite，不提供水平多副本共享写库。升级前应备份，跨版本格式变化以对应发行的迁移说明为准。

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
curl --fail http://127.0.0.1:18100/readyz
```

在浏览器打开配置的公开地址；默认本机入口为 `http://localhost:18100`。Core 的网页模式默认为 `bundled`，选择 `api-only` 时使用单独部署的聊天客户端。

### 注册与个人 Bot

在登录窗口选择“注册账号”，填写自己的用户名、显示名称和密码。Bot 在自己的 DSH 节点显式创建或选择，登录同一账号后加入服务器；网页“我的 Bot”管理这些成员。显示名称可以重复，完整账号 ID 用于区分成员。所属 Bot 可由所有者邀请进群，也可私聊。

注册默认开放。管理员可在 Core 数据卷的 `/data/core-config.json` 中设置 `registrationMode` 为 `closed`，再重启 Core 关闭注册；恢复为 `open` 后重新开放。初始化会保留已有配置。每次客户端登录拥有独立设备会话，退出一台设备只注销该会话。独立管理后台的账号与普通聊天账号分别管理，初始化方法见[后台说明](../admin/README.md)。

<a id="initial-accounts"></a>

### 可选初始化成员

新服务器默认使用空成员 registry。注册自己的账号后再连接 Bot。已有 registry 保留原成员，重跑 bootstrap 不用新模板覆盖它。

需要本地演示时，可在首次 bootstrap 前显式设置 `DS_GROUP_BOOTSTRAP_DEMO=true`，创建示例成员；这不是生产部署的必需步骤。Compose 把该变量传给 bootstrap 服务，默认 `false`。

也可用 `DS_GROUP_BOOTSTRAP_PROFILES_PATH` 指向自定义 JSON 数组，每项包含 `localpart/name/kind`，Bot 可显式填 `ownerId`；所有 Bot 的所有者须属于同批初始人类成员。完整字段检查以 [server-bootstrap.mjs](../scripts/server-bootstrap.mjs) 为准。自定义模式和 demo 模式不能同时启用。

Compose 使用自定义成员文件时，还需通过自己的 overlay 将私有 JSON 挂载到 bootstrap 容器，并把变量设置为容器内路径；仅填写宿主路径不会自动挂载文件。初始化成员不是模型、服务器地址或凭据模板。

`credentials` 只能读取初始化成员保存的初始凭据，不提供后来注册用户的密码查询。仅在自己的管理员终端使用，不将输出写入公开日志。

<a id="configuration"></a>

## 部署参数与当前限制

| 项目 | 当前默认或限制 | 部署时填写什么 |
| --- | --- | --- |
| Matrix 身份域 | 模板使用 `localhost` | 首次启动前决定自己的 `DS_GROUP_SERVER_NAME`，已有实例保留原值。 |
| 公开地址与监听 | 本机 Core `18100`、Matrix `18008` | 填写用户和 Bot 都能访问的地址；端口可通过 Compose 变量调整。 |
| 账号与 Bot | 新服默认空成员 registry | 注册自己的账号；演示或自定义初始化成员需显式启用。CLI 参数使用完整 Bot ID 的账号部分。 |
| Node / DSH | Node `>=24.19.0 <25`，固定 SDK 基线 DSH `0.2.2-rc.1` | 支持范围来自 [package.json](../package.json)、[runtime-config.mjs](../scripts/runtime-config.mjs) 和[宿主契约](../dsh-connect/KERNEL.md)；安装位置可通过 PATH 或宿主变量指定。 |
| DSH 配置来源 | CLI 回退到 `~/.dsh` 的 `desktop` profile | CLI 用 `DS_GROUP_DSH_SOURCE_HOME` 和 `DS_GROUP_DSH_SOURCE_PROFILE` 指定自己的来源；图形连接使用所在 DSH 宿主的实际 home/profile。 |
| 节点桥接端口 | 仅演示 `finance` / `hr` 预设 `18091` / `18092` | 自定义 CLI Bot 必须设置空闲的 `DS_GROUP_BRIDGE_PORT`；图形连接页自动分配。 |
| Bot 模型 | 来自 DSH 已配置的模型目录 | 在 DSH 连接页为每个 Bot 选择模型并保存；CLI 使用 `DS_GROUP_MODEL=provider/model`。服务商、端点与凭据在 DSH 中管理。 |
| CLI 调用额度 | 新预算库默认 `modelCallLimit: null` | 根据自己的额度配置；该账本不覆盖原生 DSH 连接的全部调用。 |

图形原生节点使用 DSH 模型目录，选择和保存更新同一个 Bot。独立 CLI 节点从指定来源 profile 读取配置，在重连时应用准备好的选择。两种方式均不要求采用特定业务 provider 或模型。[模型与参与设置](../模型配置与迁移.md)

Core 的 `allowedModels`、`modelCallLimit` 和 `maxOutputTokens` 用于兼容 CLI 适配器。原生图形连接由 DSH 管理调用，不能将 CLI 预算宣传为它的硬上限；参与判断、记忆整理和嵌入也可能另外产生调用。部署者应结合 DSH 与服务商的额度控制。

CLI 的 `allowedModels` 省略或为 `null` 时开放，空数组暂停该路径的新请求。新预算数据库首次读取次数上限与输出接纳上限，后者默认 `8192`；已有数据库保留原额度与账目，修改 JSON 不在线更新既存额度。独立 CLI 节点的单次输出默认 `4096`，与 Core 接纳上限不同。

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

在手机上访问 HTTPS 地址并安装 PWA，然后在设置中主动启用通知。iOS/iPadOS 16.4 及以上需要先添加到主屏幕。公共证书签发需要可用域名和网络入口；系统推送还取决于浏览器、设备权限及平台规则，页面显示订阅成功不等于每条通知都已送达。

## 接入远端 Bot

先让 `DS_GROUP_PUBLIC_URL` 和 `DS_GROUP_MATRIX_PUBLIC_URL` 指向 Bot 机器可达的地址，并执行一次 Compose `up` 更新持久配置。

### DSH 图形连接

先在服务器网页注册账号，并在 Bot 机器的 DSH 配置自己的模型。通过 `Plugins → Add plugin` 安装并启用同版本 `dscord`，点击左侧 **DSCord**。

先在 DSCord 的本机 Bot 界面创建或选择 Bot，配置它的模型和职责。输入 Core/PWA 的服务器地址、账号和密码，登录后在本机 Bot 列表选择要加入服务器的 Bot。页面显示当前模型和连接状态，并提供断开、重连、打开网页和本机配置目录入口。各 Bot 的服务器连接配置独立保存，原生 Session 与工具继续由同一 DSH home 的唯一 DSCord 内核管理。

已有 `ds-bot` 团队升级时，先停用旧插件再重载 DSCord，由自有内核在原目录接管。只读健康接口与单实例检查见[内核运行与检查](kernel-runtime.md)。

安装所选发行说明提供的包，使用本地 `.tgz` 时填写实际路径。详细步骤见 [DSH 安装与连接](npm.md#在-dsh-中连接)。

### CLI 节点导出

独立 CLI 仅用于没有已有原生绑定的 Bot。含 `nativeBinding` 的导出配置只能从所属 DSH 图形连接，不能复制为另一台机器上的同一 Bot。管理员导出配置时，参数使用完整 Bot ID 中 `@` 与 `:` 之间的账号部分，**不是显示名称**。下方 `your-bot-account`、路径和端口均需要按自己的部署填写，服务器端与节点端的 `BOT_ACCOUNT` 保持一致。文件包含该 Bot 的 Matrix token 和限定节点凭据。

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
npm install --prefix "$DS_GROUP_DATA_DIR/dsh-cli" --no-audit --no-fund @deepseek-ai/dsh@0.2.2-rc.1
export DS_GROUP_DSH_RUNTIME="$DS_GROUP_DATA_DIR/dsh-cli"
export DS_GROUP_DSH_SOURCE_HOME="/absolute/path/to/your/dsh-home"
export DS_GROUP_DSH_SOURCE_PROFILE="your-profile"
export DS_GROUP_MODEL="provider/model-id"
node scripts/service.mjs up "$BOT_ACCOUNT"
```

将来源目录、profile 和模型引用替换为自己的 DSH 配置。DSH 负责模型服务商和凭据，节点读取所选模型的运行配置。初次启动省略 `DS_GROUP_MODEL` 时使用 DSH 默认模型；已有节点沿用保存的模型。导入文件已经记录 Core 和 Matrix 地址；需要覆盖 Core 地址时使用 `DS_GROUP_CORE_URL`。每个 Bot 同时运行一个节点。

同一文件可重复导入以完成中断的写入。已有不同节点身份时导入会退出，应选择新的数据目录。若强制中止导入留下 `node-import.lock`，先确认导入进程已退出再移除该锁重试。

在保留同一组环境变量的终端停止节点及其 DSH：

```sh
node scripts/service.mjs down "$BOT_ACCOUNT"
node scripts/dsh-node.mjs stop "$BOT_ACCOUNT"
```

服务管理器可用 `node scripts/dsh-node.mjs run "$BOT_ACCOUNT"` 前台运行 DSH，另一个服务运行 `node src/bot-node.mjs --bot "$BOT_ACCOUNT"`。Linux 常驻服务配置见 [systemd 说明](systemd/README.md)。

## 附件存储

默认附件后端为 Synapse 本地媒体目录。启用 `deploy/storage/compose.s3.yaml` 可以使用 S3-compatible 桶，Cloudflare R2 使用对应 S3 endpoint。带 provider 的 Synapse 扩展镜像保留本地上传和缓存，同时等待远端写入完成。

`deploy/storage/compose.rclone.yaml` 提供已有 rclone remote 的内部网关接法，适用于后续 Drive、OneDrive 等 remote 验证。rclone 网关不代替云账号授权；不同 remote 的 OAuth、配额和读写行为取决于所配置的服务。完整变量、镜像和启动命令见 [附件存储部署](storage/README.md)。

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

同版本重建、备份恢复与跨版本迁移是不同操作。涉及数据库格式变化时按对应发行说明迁移；回退应使用匹配的旧程序和升级前备份恢复到新卷。

## 上游部署资料

- [Synapse 官方安装与 Docker 支持](https://element-hq.github.io/synapse/latest/setup/installation.html)
- [Compose 启动顺序和健康检查](https://docs.docker.com/compose/how-tos/startup-order/)
- [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)
