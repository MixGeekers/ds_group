# API-only 与独立客户端托管

Core 可选择 `api-only`，提供业务和认证 API，由独立静态部署托管现有聊天客户端。原单服网页部署使用 `bundled`。本功能不增加客户端副本或认证 SDK，也不接管独立治理/管理监听。

## 正常配置入口

| 配置 | 行为 |
|---|---|
| `core-config.json` 的 `webMode` | 持久值：`api-only` 或 `bundled`；原配置缺省为 `bundled` |
| `dscord init --web-mode api-only` | 初始化并持久保存 API-only；初始化参数优先于初始化环境变量 |
| `DS_GROUP_WEB_MODE=api-only dscord init` | 从部署环境选择并持久保存模式 |
| Core 进程的 `DS_GROUP_WEB_MODE` | 当前进程的显式覆盖，优先于已保存值；直接运行 Core 不会据此改写配置 |
| Compose 的 `DS_GROUP_WEB_MODE` | 同时传给 config 初始化服务与 Core，正常启动时保存并应用该选择；空值保留已保存模式 |

未知值拒绝启动或初始化，不能把 `false` 当关闭网页的隐式设置。新部署和没有模式字段的旧部署默认仍为 `bundled`。

### CLI / Node

在既有服务器的相同数据目录及 Matrix 配置下运行：

```sh
dscord init --web-mode api-only
dscord server
```

源码入口等价于 `node bin/dscord.mjs init --web-mode api-only` 和 `node bin/dscord.mjs server`。`dscord init` 的既有服务器名、内部 Matrix 地址及公开地址环境仍需沿用原值。`DS_GROUP_DATA_DIR` 选择持久目录；不在这里导入或更换 Matrix 身份。

持久选择后，不带模式参数再次初始化以及后续 Core 重启都会保留 `api-only`。明确恢复原网页部署时使用 `dscord init --web-mode bundled`，并重启 Core；若运行环境另有显式模式覆盖，应同步调整它。

### Docker Compose

在现有 `deploy/.env` 加入：

```dotenv
DS_GROUP_WEB_MODE=api-only
```

继续使用同一数据卷和正常 Compose 入口：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
```

初始化服务会将模式写入 Core 配置。之后移除该环境行再执行初始化，不会把已保存的 API-only 重置为 bundled。需要恢复时显式设为 `bundled`。HTTPS、存储等既有 overlay 继续使用同一组合，不需要为此增加新的监听端口。

## 网络行为

API-only 在读取 `webRoot` 之前拒绝网页托管。`GET/HEAD /`、`/index.html`、打包的 `/assets/*`、`/theme.js`、PWA manifest 和 service worker 均返回 404；JSON 错误为 `WEB_DISABLED`，`Cache-Control: no-store`。即使磁盘保留原构建文件或设置 `DS_GROUP_WEB_DIR`，也不会发布它们。

`/healthz`、`/readyz`、公开发现、登录、账号、房间、消息、附件和节点 API 继续走原处理路径。`/api/bootstrap` 新增 `web.mode`，`/api/status` 的 `core.webMode` 展示当前有效模式。普通 API 的 Matrix 和本地账号状态门禁继续执行。该模式不会授予管理员权限，也不把独立管理面板挂到 Core 根页面；实例管理后台继续使用自己的管理监听。

独立静态站点使用同一份 `dist/web/` 构建产物，配置方式见[客户端部署](client/README.md)。公开 Core/Matrix 地址及 `core-config.json` 的 `identity.clientOrigins` 必须与实际客户端匹配。网页托管模式不会自动放宽 CORS，也不会将外服 URL 变成普通登录令牌的允许目标。

切换模式不删除构建、聊天历史、账号或节点配置，也不会清空用户设备已有的 PWA 离线缓存；服务器网络请求的网页发布按当前模式处理。

## 部署检查

确认 Core 的 `/readyz` 正常，`/api/status` 的 `core.webMode` 为所选模式，并从实际客户端 origin 完成登录和房间读取。API-only 的 Core 根路径应返回 `WEB_DISABLED`；独立客户端的根路径应提供应用页面。反向代理仍须转发业务 API，且不能把 API 错误改写成客户端 HTML。

配置与响应的实现依据见 [web-mode.mjs](../src/web-mode.mjs)、[server-init.mjs](../scripts/server-init.mjs) 和 [core.mjs](../src/core.mjs)。
