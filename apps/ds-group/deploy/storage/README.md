# 附件存储

首次部署使用本地媒体目录。S3 模式保留本地上传与缓存，并通过固定 `synapse-s3-storage-provider` 1.7.0 同步写入配置的桶。新文件只有完成 provider 写入才返回上传成功。

## Docker Compose

在私有 `.env` 中设置以下变量，运行时使用绝对 `--env-file` 路径。凭据进入服务器私有配置文件，请保持文件权限为 `0600`。

```dotenv
DS_GROUP_S3_BUCKET=your-media-bucket
DS_GROUP_S3_ENDPOINT=https://your-s3-endpoint.example
DS_GROUP_S3_REGION=us-east-1
DS_GROUP_S3_PREFIX=dscord/
DS_GROUP_S3_ACCESS_KEY_ID=your-access-key
DS_GROUP_S3_SECRET_ACCESS_KEY=your-secret-key
```

R2 使用账号的 S3 endpoint，region 设置为 `auto`。AWS S3 可以省略 endpoint。支持可选 `DS_GROUP_S3_SESSION_TOKEN`。桶需已创建并允许对象读写。

从包根目录执行以下命令。overlay 中的相对路径依据第一个 Compose 文件解析。

```sh
docker compose --env-file /absolute/path/server.env \
  -f deploy/compose.yaml -f deploy/storage/compose.s3.yaml up --build -d
```

该 overlay 仅向初始化服务传递云配置，并构建带 provider 的 Synapse 扩展镜像。S3 部署以后启动时继续使用相同 overlay。主应用镜像与 Synapse 扩展镜像均需存在，`up --no-build` 适用于镜像已构建的情况。

## 直接初始化

`scripts/server-init.mjs` 接受 `DS_GROUP_MEDIA_BACKEND=local|s3`，S3 参数与上表相同。省略后端时复用私有 `media-storage.json` 中已保存的选择，新部署默认 local。返回摘要只包含后端类型。

从 local 开启 S3 后，既有附件继续保存在本地，新上传写入两处。当前切片保留已使用 S3 的 bucket、endpoint 和 prefix，调整目标或回到纯本地需要显式迁移。凭据和 region 可更新。缓存回收、历史附件转存与远端删除由后续迁移/保留策略处理。

管理员备份应同时覆盖 Core/Synapse 数据卷与远端桶对象，恢复时保留两者的对应关系。rclone、Drive 与 OneDrive 的真实云授权分别验收。

## 已有 rclone remote

`compose.rclone.yaml` 提供内部 S3 网关接法。管理员先准备已授权的 rclone remote，在其根目录创建与 `DS_GROUP_S3_BUCKET` 同名的目录，并设置以下变量。remote 与配置目录来自管理员已有的 rclone 配置。

```dotenv
DS_GROUP_RCLONE_REMOTE=mydrive:dscord-root
DS_GROUP_RCLONE_CONFIG_DIR=/absolute/path/rclone-config
DS_GROUP_S3_BUCKET=dscord-media
```

配置目录包含 `rclone.conf`，以可写目录挂载供 OAuth token 刷新持久化。再配置专用于内部网关的一组 S3 access key / secret，使用不含逗号和引号的随机值。模板采用 cache off，并给需要已知文件大小的云盘上传分配 spool 卷，容量应覆盖并发文件暂存。

```sh
docker compose --env-file /absolute/path/server.env \
  -f deploy/compose.yaml -f deploy/storage/compose.s3.yaml \
  -f deploy/storage/compose.rclone.yaml up --build -d
```

该模板复用管理员已配置的 remote。当前限定协议验证使用本地目录 remote，Drive/OneDrive 的 OAuth、配额和真实写入行为仍需对应账号验收。rclone 1.75.2 将 serve s3 标为 Experimental。

## 服务端索引范围

Core 的 `media.sqlite` 保存本应用上传附件的稳定 ID、文件名、类型、大小、SHA-256、状态和 Matrix URI。房间及消息中的附件引用由 Matrix 保存。切换文件字节后端后，这些记录继续支持既有消息和下载入口。

云盘中已有文件的发现、全盘扫描、外部变化同步和导入需要独立的持久文件索引。本轮提供后端接法与附件链路，后续再实现这些索引作业。

## 隔离协议验证

```sh
node scripts/storage-smoke.mjs
```

该脚本使用 rclone 1.75.2 的本地目录 remote 提供真实 S3 协议服务，验证正常附件入口、远端字节、移除本地缓存后的读取、重启和 Range。使用 `.local/storage-smoke/` 私有数据和 22300、22400、22408 三个回环端口，结束时清理本轮容器与网络。结果说明以脚本输出证据为准。
