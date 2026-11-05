# 中央平台部署与发行验证

日期：2026-11-04（America/Caracas）。本切片从集成提交 `ca336a2` 开始，随后快进到 `cf77e22`，纳入统一客户端、后台整理和联邦修复；仅新增部署/打包验证与必要修复，没有手改 `web/src`。

## 已验证的正常部署路径

在相同的 `.env`、Compose 文件组合和持久卷上配置 `DS_GROUP_WEB_MODE=api-only`，使用原启动命令。该模式保留业务 API；聊天网页由[统一客户端静态部署](client/README.md)托管。独立管理服务仍通过 administration 的单独监听提供 UI 与管理 API，默认仅绑定 loopback。

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
```

将已初始化服务器设为中央默认归属时，使用该实例拥有数据目录的 UID，保留原 Matrix serverName 和完整账号 ID：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps -T \
  --user 1000:1000 config node scripts/central-init.mjs --data-dir /data \
  --core-url https://core.example --matrix-url https://matrix.example \
  --client-origin https://client.example
docker compose --env-file deploy/.env -f deploy/compose.yaml restart core
```

这是对既有账号目录的中央配置升级，不在其他 homeserver 创建同名账号。本轮真实 Compose 使用原初始化流程产生的四个合成成员，核对中央升级前后 ID 一致；空目录中央账号初始化沿身份切片的单独证据解释。

通过独立本地控制台初始化每服管理员：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T administration node scripts/admin.mjs init admin
```

默认将生成的首次管理凭据保存到 `/data/initial-administrator.json`，标准输出只报告位置；可用既有 `DS_GROUP_ADMIN_PASSWORD` 入口自行提供密码。管理认证与普通聊天登录独立，使用方法见[后台说明](../admin/README.md)。本轮实测普通聊天 token 调用管理 API 为 401，管理 token 调用普通 Core API 也为 401。

## 可复现验收

先从发行源码构建镜像，验证中使用不同项目名和自有卷：

```sh
node scripts/release-pack.mjs
node scripts/release-verify.mjs --extract .local/release-unpacked
docker build -t ds-group:ci .local/release-unpacked
DS_GROUP_IMAGE=ds-group:ci node .local/release-unpacked/scripts/platform-deploy-smoke.mjs
```

该脚本默认使用 24220/24228/24230，在启动前检查占用；可通过 `DS_GROUP_PLATFORM_SMOKE_PORT_BASE` 设置基端口，Matrix 为 +8、管理为 +10。`DS_GROUP_PLATFORM_SMOKE_REPORT` 可指定报告路径。脚本使用真实五服务 Compose，不能以配置渲染替代运行。

带 `--browser` 时，使用已安装 Playwright Chromium 实际打开独立后台，完成管理员登录、读取实际部署策略，以及重建容器后恢复原管理会话；默认 CI 运行检查真实 HTML、构建资源和管理 API。两者都保存策略并调用真实 Synapse 控制/guard，再核对实际回读。`prepared` 表示配置准备及房间应用回执成功；是否已生效和是否需重启分别核对 `livePolicyObserved`、`restartRequired`，不把准备完成直接当作联邦网络重启。

旧单服的兼容检查继续运行：

```sh
DS_GROUP_IMAGE=ds-group:ci DS_GROUP_SMOKE_PORT_BASE=24260 \
  node .local/release-unpacked/scripts/deploy-smoke.mjs
```

省略旧检查的端口基数时，三种监听都由 Docker 分配端口，管理监听不再争用宿主 18110。备份前停止 Core、administration、Synapse 三个写入服务，再备份 Core、Synapse、governance 三个卷；向新卷恢复后核对原账号、房间、token、VAPID、历史和去重。

两种脚本结束都会清理自己唯一项目名下的容器、网络和卷，不删除其他部署。运行数据和原始诊断日志留在被 Git 排除的 `.local/`。本轮端口均在 242xx；实际测试镜像为本轮专用标签，验证后移除，构建摘要及报告保留。

## 打包边界与必要修复

源码发行包含 admin 源码/配置、统一客户端构建配置、原生身份和网页模式模块、中央/管理初始化脚本、Synapse guard 及两份实施说明。去除了集成时重复登记的 `dsh-connect` 目录，避免重复 tar entry；必要部署文件缺失会使源包构建失败。

npm 运行包新增 `scripts/central-init.mjs`，并要求构建后的 `dist/web/client-config.json`；既有 `dist/admin`、管理脚本、guard 和全量 `src` 保留。已用真实 tarball 在新目录安装并运行安装包内 CLI 的 API-only 初始化、中央初始化和独立管理账号初始化。该安装验证没有假装连接新的真实 Matrix；真实 Matrix 业务闭环由上面的 Compose 验收承担。

旧部署冒烟实际暴露 Bot `createRosterClient` 带普通 token 请求公开 bootstrap 导致 403。最小修复只让这条公开请求使用 `credentials: omit`、无 Authorization，并拒绝重定向；节点内部 API 和 Matrix 认证不变。针对原调用的模块检查和真实适配进程复验均通过。

## CI 覆盖与证据级别

CI 保持原矩阵数量。4 组 Linux/Node native job 继续检查源码发行的干净安装，并新增真实 npm runtime 组装；2 组容器 job 从已校验源码归档构建本机架构镜像，运行旧单服部署和新增中央平台/独立管理部署检查，同时上传两份结果。现有浏览器 job 验证后台及客户端组件交互；容器检查默认验证真实构建 UI 与后端，完整后台 Chromium 联调由本轮本机 `--browser` 额外留证。

本轮实际容器架构为 Linux arm64，本机宿主为 macOS arm64。目标 Linux amd64/arm64 的 GitHub CI 已配置，本聊天没有推送或触发新的远端 CI，也没有发布 npm 包、镜像或 GitHub release。物理跨机、真实模型与其他聊天的 A/B/C 联邦验收不在本切片重复。

首轮旧基线返回 partial（未捕获应用明细），后续合入治理回读修补，并按 prepared 语义核验。该失败与 Bot 公开 roster 403 分别保留报告；后续通过不改写原结果。完整结果见[部署发行证据目录](../artifacts/deploy-release/目录.md)。
