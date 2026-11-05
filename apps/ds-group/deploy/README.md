# DSCord 服务器部署

服务器提供聊天核心、PWA、Matrix 和 Web Push 接口。Bot 节点通过公网 HTTPS 或内网地址连接核心，可以分别运行在其他机器。服务器数据保存在 Docker 命名卷中。

聊天客户端独立托管时，可通过 `DS_GROUP_WEB_MODE=api-only` 持久关闭 Core 的网页发布；原单服缺省仍托管 PWA。配置、CLI/Compose 入口及升级兼容见 [API-only 部署](api-only.md)。

本文对应 `0.3.0` 源码候选，新增账号注册、个人 Bot 创建与 DSH 连接页。公开 npm 包当前为 `0.2.0-alpha.1`，候选安装步骤见 [npm 说明](npm.md)。

## 支持范围

| 环境 | 部署方式 |
| --- | --- |
| Linux x86-64 | Docker Engine 和 Compose v2 |
| Linux ARM64 | Docker Engine 和 Compose v2，包括 ARM 云服务器及 64 位系统的树莓派 |

镜像内使用 Debian、Node 24.19.0 和 Synapse 1.164.2。Node、Synapse、Caddy 的镜像摘要均指向包含 amd64 与 arm64 的多架构索引。建议初始配置为 2 核 CPU、2 GB 内存和持久磁盘，实际容量取决于用户、消息及 Bot 数量。

这套 Compose 使用单实例核心与 Synapse SQLite。水平扩容、多副本共享写库和跨版本数据库迁移需要另行实施。发行 CI 会检查容器重建后数据保留以及备份恢复到新卷。

## 启动服务器

以下命令在 Linux 服务器的发布包根目录执行，源码仓库对应 `apps/ds-group/`。

```sh
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
```

本机浏览器打开 `http://localhost:18100`。第一次启动会创建 Alice、Bob 和两个归 Alice 所有的 Bot。登录密码由服务器随机生成，通过下面的管理命令取得。

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T core node scripts/server-admin.mjs credentials alice
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T core node scripts/server-admin.mjs credentials bob
```

`credentials` 的输出包含登录密码，按需在管理员终端使用。服务器日常启动日志只输出公开身份和服务状态。初始 Bot 状态为离线，接入 Bot 节点后开始处理消息。

### 注册与个人 Bot

其他成员打开服务器网页，在登录窗口选择“注册账号”，填写用户名、显示名称和密码。注册后进入“我的 Bot”创建 Bot，随后从 DSH 连接。成员的显示名称可以重复，稳定账号 ID 用于区分成员。新 Bot 由所有者邀请进群，也可以直接私聊。

注册默认开放。管理员可在 Core 数据卷的 `/data/core-config.json` 中设置 `registrationMode` 为 `closed`，再重启 Core 关闭注册。恢复为 `open` 后重新开放。初始化会保留已有配置。每次客户端登录拥有独立设备会话，退出一台设备只注销该会话。

初始化之前编辑 `deploy/.env` 中的 `DS_GROUP_SERVER_NAME`。它是 Matrix 成员 ID 的域，例如 `@alice:chat.example.com`，建立后必须保留。网址可以随服务器迁移而更新。

```dotenv
DS_GROUP_SERVER_NAME=chat.example.com
DS_GROUP_PUBLIC_URL=https://chat.example.com
DS_GROUP_MATRIX_PUBLIC_URL=https://chat.example.com
```

默认端口只绑定 `127.0.0.1`。内网直接访问时，可将 `DS_GROUP_BIND` 设为该服务器的内网 IP，并把两个公开 URL 分别设为可达的 `http://IP:18100` 和 `http://IP:18008`。手机安装和通知使用下面的 HTTPS 部署。

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

在服务器网页注册并创建自己的 Bot，在 Bot 机器的 DSH 中配置 `opencode-go/deepseek-v4.1-flash`。随后通过 `Plugins → Add plugin` 安装同版本 `dscord` 候选包并启用，点击左侧 **DSCord**。

输入 Core/PWA 的服务器地址、账号和密码，登录后在“我的 Bot”中点击“上线”。页面显示每个 Bot 的名称、ID 与连接状态，并提供断开、重连、打开网页和本机配置目录入口。程序会为每个 Bot 创建独立目录、端口与 DSH 运行时。

当前候选安装使用本地 `.tgz` 绝对路径，公开 npm 版本升级后再使用包名安装。详细步骤见 [DSH 安装与连接](npm.md#在-dsh-中连接)。

### CLI 节点导出

管理员也可以导出节点配置。文件携带目标 Bot 的 Matrix token、公开成员资料和限定到该 Bot 的核心节点凭据。

```sh
umask 077
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T core node scripts/server-admin.mjs export-node finance > finance-node.json
```

将这个文件和同版本 DS-Group 发布包复制到 Bot 机器。该机器需要 Node 24.19.0 与 DSH。运行以下命令导入私有数据目录。

```sh
npm ci --ignore-scripts --no-audit --no-fund
node scripts/server-admin.mjs import-node finance-node.json .local
npm install --prefix .local/dsh-cli --no-audit --no-fund @deepseek-ai/dsh@0.2.1-rc.5
export DS_GROUP_DSH_RUNTIME="$PWD/.local/dsh-cli"
export DS_GROUP_CORE_URL=https://chat.example.com
read -r -s OPENCODE_API_KEY
export OPENCODE_API_KEY
node scripts/service.mjs up finance
```

同一文件可以重复导入以完成中断的写入。已有不同节点身份时导入会退出，操作员应选择新的数据目录。导入被强制终止而留下 `node-import.lock` 时，确认导入进程已退出后移除这个锁再重试。

`read` 等待输入 opencode 密钥并隐藏回显，输入后按回车。节点使用 `opencode-go/deepseek-v4.1-flash`。`DS_GROUP_DSH_RUNTIME` 可指向已有 DSH 安装，导入文件中的核心地址也会作为默认值。第二台机器导出并导入 `hr`，两个节点分别使用自己的数据目录和原生 Session。每个 Bot 同时运行一个节点。

```sh
node scripts/service.mjs down finance
node scripts/dsh-node.mjs stop finance
```

第一个命令停止 Matrix 适配进程，第二个命令停止该 Bot 的 DSH。将节点交给 systemd 等服务管理器时，可以使用 `node scripts/dsh-node.mjs run finance` 前台运行 DSH，另一个服务运行 `node src/bot-node.mjs --bot finance`。

Linux 开机启动和独立节点重启配置见 [systemd 部署说明](systemd/README.md)。

网页新建 Bot 同样可以导出，命令参数使用其 ID 中 `@` 与 `:` 之间的账号部分。为自定义 Bot 设置独立 `DS_GROUP_DATA_DIR` 和 `DS_GROUP_BRIDGE_PORT`。

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

`/healthz` 检查核心进程，`/readyz` 还检查 Matrix 连通性。Compose 使用健康检查等待首次启动。用户、消息、任务账本、推送密钥与订阅保存在 `core-data` 和 `synapse-data` 命名卷中。

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml down
docker compose --env-file deploy/.env -f deploy/compose.yaml up --detach --wait
```

`down` 保留数据卷。`down --volumes` 会删除该 Compose 项目的数据，只用于明确需要清空的测试项目。

## 备份和恢复

先暂停 Bot 节点，再停止两个写入服务。下面在同一个 shell 中定义 `dc`，后续备份、恢复和升级命令均用它指定项目。

```sh
export DS_GROUP_COMPOSE_PROJECT=ds-group
dc() { docker compose --env-file deploy/.env --project-name "$DS_GROUP_COMPOSE_PROJECT" -f deploy/compose.yaml "$@"; }
umask 077
mkdir -p .local/backups
dc stop --timeout 45 core synapse
dc run --rm --no-deps -T --user 0:0 config tar -czf - -C /data . > .local/backups/core.tgz
dc run --rm --no-deps -T --user 0:0 config tar -czf - -C /synapse . > .local/backups/synapse.tgz
dc up --detach --wait
```

备份包含密码、token、VAPID 密钥及聊天内容，保存到管理员控制的存储中。HTTPS 的 Caddy 证书卷独立保留，公共证书也可由同域名重新申请。

恢复到新的 Compose 项目时，保留原来的 `DS_GROUP_SERVER_NAME`，先停止占用相同端口的旧实例，并选择一个尚无数据卷的项目名。

```sh
export DS_GROUP_COMPOSE_PROJECT=ds-group-restore
dc run --rm --no-deps -T --user 0:0 config tar -xzf - -C /data < .local/backups/core.tgz
dc run --rm --no-deps -T --user 0:0 config tar -xzf - -C /synapse < .local/backups/synapse.tgz
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
