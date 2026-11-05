# DSCord 多后端存储

审阅日期为 2026-11-04（America/Caracas）。用户已确认本轮所说的 S2 指 Cloudflare R2。

| 项目 | 状态 |
|---|---|
| 方向 | 服务器附件存储、云盘连接与文件索引 |
| 候选状态 | 试验中 |
| 证据层级 | 官方资料、固定源码核查、真实 Core / Matrix / S3 协议限定实验 |
| 实施状态 | local/S3 配置、可选 provider 镜像与网关模板已实现，本地 remote 协议验证通过 |
| 当前基线 | `codex/dscord-connect`，基线提交 `6fe03c5` |
| 原始材料 | [来源与证据](<../research/2026-11-04-DSCord存储/README.md>) |

## 判断

建议分两层复用。附件字节先沿用 Matrix 媒体路径，S3 与 R2 优先接入现成的 Synapse S3 provider。Google Drive 与 OneDrive 优先验证 rclone sidecar 的统一连接能力。DSCord 持有稳定附件身份、消息引用、成员权限、上传状态与索引事务。OpenList 作为需要独立文件管理界面、目录浏览和搜索时的可选 sidecar。

这一方案把已有 `mxc://` 附件和 Bot 下载路径纳入兼容范围。接入 Drive、OneDrive 的主要未知项在网关协议、上传完成语义与失败恢复，需先做限定实验。

同日后续已实现最小 local/S3 配置和可部署 rclone 网关模板。21 项相关模块与 9 项真实本地 remote 协议检查通过，覆盖 multipart、隔离缓存回读、重启、Range 和远端写失败后的稳定重试。首次健康探针失败与随后 Range 失败均保留。真实 R2、Drive、OneDrive 账号和全盘索引仍待验收。[实验结果](<../测试/2026-11-04-DSCord存储/结果.md>)、[部署入口](<../apps/ds-group/deploy/storage/README.md>)

## 当前项目路径

`apps/ds-group/src/media.mjs` 将文件接收到 `media-staging`，计算 SHA-256，并以 `owner_id + upload_id` 处理重试。`media.sqlite` 保存附件 ID、名称、类型、大小、哈希、状态和 Matrix content URI。上传通过 `client.uploadMedia()` 进入 Synapse，下载回到 Matrix 媒体接口并转发 Range 请求。启动恢复会将残留 `uploading` 标为 `failed`。

`scripts/server-init.mjs` 生成的 Synapse 配置使用 `/data/homeserver.db` 与 `/data/media_store`。本轮已增加 `media-storage.json` 保存当前后端，并在再次初始化时复用。当前 `attachments` 表的后端连接 ID、对象定位、版本、回收任务与迁移状态仍需后续扩展。

| 数据 | 建议位置 | 原因 |
|---|---|---|
| 账号、成员、房间、消息 | Synapse 数据库 | 当前聊天权威状态 |
| 附件身份、授权引用、上传与迁移任务、文件索引 | Core 数据库 | 需要事务、唯一约束与可恢复队列 |
| 附件原文件、缩略图、导出与备份文件 | 本地磁盘或对象存储 / 云盘 | 适合按稳定对象定位读写 |
| Bot 原生 Session 与本机工作目录 | 各 Agent 节点 | 保持节点职责与本机工具执行路径 |

当前 SQLite WAL 文件需要本地持久卷。SQL 数据库扩展可另行采用 PostgreSQL，备份快照可上传到桶或云盘。将活动数据库文件放进云盘挂载会引入额外文件锁与一致性依赖，应通过独立数据库迁移方案处理。

## 候选比较

| 候选 | 本轮版本与许可 | 四类后端 | 接入形态 | 索引能力与主要取舍 |
|---|---|---|---|---|
| rclone | v1.75.2，MIT | 官方覆盖 S3、R2、Drive、OneDrive | Go 进程 / 容器，CLI、RC、S3 网关 | 提供列表与元信息，DSCord 保存持久索引。连接器覆盖广 |
| Synapse S3 provider | v1.7.0，Apache-2.0 | 直接 S3-compatible，R2 待固定组合实测，Drive/OneDrive 经网关 | Synapse Python 模块，依赖 boto3 | 最贴合已有媒体链路。接口只有存取，远端删除需补充 |
| OpenList | v4.2.9，AGPL-3.0 | 四类均有驱动或明确配置 | 独立服务，REST / WebDAV / S3 Gateway | 自带目录索引、管理 UI 与挂载管理，需与聊天权限对接 |
| AList | v3.66.0，AGPL-3.0 | 属同类多云文件门户 | 独立服务 | 本轮仅维护、许可及定位核查，详细机制核查集中于 OpenList |
| matrix-media-repo | v1.3.8，MIT | 本地 / S3 媒体存储，Drive/OneDrive 仍需连接器 | 独立 Matrix 媒体服务与数据库 | 适合媒体服务独立扩容，替换面较大 |

核实到的发行日期分别为 rclone 2026-10-09、Synapse provider 2026-08-18、OpenList 2026-10-25、AList 2026-10-21、matrix-media-repo 2025-01-16。OpenList 与 AList 仓库均未归档且仍有近期发行。matrix-media-repo 官方 README 将大型或多 homeserver 媒体部署列为目标，并指向 Synapse S3 provider 作为单独 S3 存储选项。[rclone 发行](https://github.com/rclone/rclone/releases/tag/v1.75.2)、[Synapse provider 发行](https://github.com/matrix-org/synapse-s3-storage-provider/releases/tag/v1.7.0)、[OpenList 发行](https://github.com/OpenListTeam/OpenList/releases/tag/v4.2.9)、[AList 发行](https://github.com/AlistGo/alist/releases/tag/v3.66.0)、[matrix-media-repo README](https://github.com/t2bot/matrix-media-repo/blob/v1.3.8/README.md)

各候选的许可按其发行物保存。rclone 与 Synapse provider 的宽松许可有利于组件分发。OpenList/AList 的修改或源码嵌入应在发行前核对 AGPL 对应义务，本轮建议采用进程级接入。[rclone 许可](https://github.com/rclone/rclone/blob/v1.75.2/COPYING)、[Synapse provider 许可](https://github.com/matrix-org/synapse-s3-storage-provider/blob/v1.7.0/LICENSE)、[OpenList 许可](https://github.com/OpenListTeam/OpenList/blob/v4.2.9/LICENSE)、[AList 许可](https://github.com/AlistGo/alist/blob/v3.66.0/LICENSE)、[matrix-media-repo 许可](https://github.com/t2bot/matrix-media-repo/blob/v1.3.8/LICENSE)

## 已静态核查的关键机制

### rclone 连接层

| 后端 | 读写删与元信息 | 授权 | 分页与限制 |
|---|---|---|---|
| S3 / R2 | 上传、读取、删除、列对象，大小、时间、哈希能力依后端 | Access key / secret，可指定 endpoint | 驱动处理服务端分页，R2 使用 S3-compatible API |
| Google Drive | 文件上传、下载、删除、目录与对象 ID | OAuth client 与 refresh token，可选适用场景下的 service account | 同名文件合法，稳定对象 ID 要进入外部文件索引 |
| OneDrive | 文件上传、下载、删除、目录与对象 ID | Microsoft OAuth，组织应用可按相应模式使用 client credentials | 哈希和元信息能力与 Drive 不同，大文件上传需保留本地暂存容量 |

官方 remotes 覆盖上述能力。Google Drive 的 `drive.file` scope 只覆盖应用创建或打开的文件，管理员需明确选择“专用附件目录”或“索引已有云盘”。OneDrive 应使用与写入范围匹配的授权。OAuth 可在管理页面完成浏览器跳转，服务器持有 refresh token 与连接配置。[rclone Drive](https://rclone.org/drive/)、[rclone OneDrive](https://rclone.org/onedrive/)、[rclone S3/R2](https://rclone.org/s3/#cloudflare-r2)

rclone RC 提供 `operations/list`、`stat`、上传、删除、复制与异步作业。`operations/list` 返回目录数组，DSCord 面向用户的分页应查询自己的持久索引。RC 作业记录具有有限保留时间，服务器需持久化自己的作业状态。RC 身份认证与内部网络接入足以供服务端封装，用户请求仍通过 Core 的成员和对象授权。[RC 官方接口](https://rclone.org/rc/)

`serve s3` 在固定 v1.75.2 中标记为 Experimental，提供 SigV4 与多访问密钥。默认 VFS cache off 路径等待远端上传，writes/full 模式先写本地缓存并由后台回写，二者的成功回执代表不同持久化阶段。OneDrive multipart 会使用本地 spool。目录缓存、临时对象、进程重启后恢复与 boto3 multipart 兼容是首轮实验重点。[固定版本文档](https://github.com/rclone/rclone/blob/v1.75.2/cmd/serve/s3/serve_s3.md)

### Synapse 媒体存储

v1.7.0 支持 bucket、endpoint、region、prefix 与凭据。`store_synchronous: true` 让媒体写入等待 provider 完成。`store_local` 指本 homeserver 产生的媒体，`store_remote` 指联邦远端媒体，服务器仍需要本地上传与缓存目录。附带的历史媒体转存脚本要求 PostgreSQL 连接配置，当前 DSCord 的 SQLite 部署需要另行适配。[固定版本 README](https://github.com/matrix-org/synapse-s3-storage-provider/blob/v1.7.0/README.md)

provider 实现通过 boto3 `upload_file` 写入、`get_object` 读取。固定 Synapse 1.164.2 的 `StorageProvider` 只有 `store_file` 与 `fetch` 两个抽象入口。多 provider 配置形成副本写入与读取回退。首版建议每服务器一个当前附件主存储，旧后端转为只读获取，完成迁移后退出。按附件动态路由需要额外的路由 provider 或独立媒体层。[provider 源码](https://github.com/matrix-org/synapse-s3-storage-provider/blob/v1.7.0/s3_storage_provider.py)、[Synapse 接口](https://github.com/element-hq/synapse/blob/v1.164.2/synapse/media/storage_provider.py)、[调用与读取顺序](https://github.com/element-hq/synapse/blob/v1.164.2/synapse/media/media_storage.py)

固定 provider 从 `media_store_path` 加相对路径读取源文件，首轮应保留本地媒体存储。Synapse 1.164.2 的 `enable_local_media_storage: false` 临时文件模式需要单独验证适配。另有一处源码与 README 差异，`parse_config()` 未转发 `threadpool_size` 及两个 checksum 选项，构造器将使用默认值。自定义这些参数时需要修补或核实后续版本。[provider 源码](https://github.com/matrix-org/synapse-s3-storage-provider/blob/v1.7.0/s3_storage_provider.py)、[Synapse 配置](https://github.com/element-hq/synapse/blob/v1.164.2/synapse/config/repository.py)

**远端回收是明确缺口。** 当前接口没有 delete 回调。DSCord 需将消息引用、Synapse 媒体引用、本地缓存和云端对象纳入回收计划，并对丢失回执与失败重试保留状态。复用 provider 本身只能交付媒体存取。[provider 源码](https://github.com/matrix-org/synapse-s3-storage-provider/blob/v1.7.0/s3_storage_provider.py)

R2 官方给出对象读写、元信息、删除和列表的强一致性，权限变更为最终一致。S3 兼容 API 有明确支持范围，实施时应检查 boto3 的请求头与调用集合。仍需处理客户端丢失响应及在途请求随后完成的情况。[R2 一致性](https://developers.cloudflare.com/r2/reference/consistency/)、[S3 兼容表](https://developers.cloudflare.com/r2/api/s3/api/)

### OpenList 文件门户

固定 v4.2.9 的 S3、Google Drive、OneDrive 驱动均有 List、Link、Put、Remove。S3 跟随 marker/token，Drive 跟随 `nextPageToken`，OneDrive 跟随 Graph `@odata.nextLink`。R2 在 S3 驱动文档中有明确配置。REST 与 WebDAV 可封装为内部连接器。[S3 驱动](https://github.com/OpenListTeam/OpenList/blob/v4.2.9/drivers/s3/driver.go)、[Drive 驱动](https://github.com/OpenListTeam/OpenList/blob/v4.2.9/drivers/google_drive/driver.go)、[OneDrive 驱动](https://github.com/OpenListTeam/OpenList/blob/v4.2.9/drivers/onedrive/driver.go)、[R2 配置](https://doc.oplist.org/guide/drivers/s3)

REST 提供文件列表、读取、搜索、上传与删除。读取路径检查用户 base path 和 metadata 权限。`page/per_page` 在已加载的目录对象数组上切片，大目录的一页请求可能先拉取上游整个目录，此处属于源码推断，尚无性能实测。[路由](https://github.com/OpenListTeam/OpenList/blob/v4.2.9/server/router.go)、[分页与权限](https://github.com/OpenListTeam/OpenList/blob/v4.2.9/server/handles/fsread.go)

索引可用数据库、Bleve 或 Meilisearch，`SearchNode` 保存父路径、名称、目录标记和大小。自动更新依赖目录刷新 hook，要求已建索引、已开启自动更新且当前没有建库任务。更新按名称集合计算增删，同名内容或大小变化仍需单独核验，云端外部修改需要刷新或 provider delta 同步。PDF、Office 正文提取和语义索引需另建处理链路。[搜索文档](https://doc.oplist.org/guide/advanced/search)、[索引结构](https://github.com/OpenListTeam/OpenList/blob/v4.2.9/internal/model/search.go)、[更新源码](https://github.com/OpenListTeam/OpenList/blob/v4.2.9/internal/search/build.go)

OpenList S3 Gateway 官方列出 List、Get、Put、Delete。下载可以 302 到云盘或通过本机代理，需验证 Matrix 客户端与网关交互。它自带管理和文件浏览界面，适合服务管理员需要直接管理已有云盘的场景。[S3 Gateway](https://doc.oplist.org/guide/advanced/s3)、[WebDAV](https://doc.oplist.org/guide/advanced/webdav)

## 可落地的服务端契约草案

以下为完整控制与索引设计草案。本轮已实现环境变量 / 私有配置形式的单后端选择、Synapse provider 配置与部署模板，设置界面、连接管理 API、扫描、迁移及回收作业仍属后续范围。

### 配置与控制入口

管理入口放在服务器设置的“存储”。添加连接时选择本地、S3、R2、Google Drive 或 OneDrive，完成凭据或 OAuth 配置后进行连接检查，随后选择当前附件主存储。界面显示连接状态、授权失效、待处理上传、最近索引时间与实际可取得的容量信息。

| 资源 / 操作 | 最小字段或语义 |
|---|---|
| `StorageConnection` | `id`、`kind`、`label`、`configVersion`、`secretRef`、`capabilities`、`health` |
| `checkConnection` | 只读连通性检查与显式合成读写检查分开，返回能力与失败原因 |
| `setAttachmentStore` | 指定新文件写入目标，保存生效版本与既有后端读取配置 |
| `scanConnection` | 持久作业，保存 cursor 或扫描代次、进度、最后成功时间 |
| `listIndexedFiles` | 通过 Core 权限过滤后对持久索引分页 |
| `resolveAttachment` | 从稳定附件 ID 得到授权媒体读取路径，支持 Range |
| `migrateAttachments` | 复制、验证、切换引用、排队回收，并记录逐对象结果 |

云凭据留在服务端连接管理范围，页面与 Bot 通过 Core 获取授权对象。rclone 的凭据和任务接口只作为内部连接器接口。连接状态与文件列表需要独立响应，使外部云盘故障能明确定位到具体连接。

### 索引与一致性

建议先扩展现有附件记录，增加 `storage_connection_id`、`storage_config_version` 与必要的对象状态。沿用 Synapse 时，Core 以 `content_uri` 关联媒体身份，Synapse 管理相对物理路径。只有具备可靠 provider 清单时，才保存后端 object key，避免从 URI 猜路径。

外部云盘目录单独建立 `IndexedFile`，保存连接 ID、provider item ID、父项、名称、大小、mtime、可用哈希、ETag/版本及最后扫描代次。同名文件保留不同身份。先按名称、类型和大小查询，正文提取与向量检索作为后续独立能力。

上传状态应明确区分接收中、远端写入中、待核对、可用和失败。丢失写入回执时先核对稳定对象身份及大小/哈希，确认后再发布。稳定 `upload_id` 和不可变对象键用于限制重复提交。云端哈希能力不足时，保留 Core 计算的 SHA-256，并在迁移验收时读回核验。

全量扫描以完整代次提交缺失项，扫描中断保留上次成功索引。支持 provider delta cursor 的后端可增加增量同步。迁移按“复制完成 → 校验 → 切换引用 → 回收旧副本”推进。删除使用 tombstone 与持久任务，回收前复核消息和协作交付引用。

## 最小验证计划

下表保留完整验证清单。本轮已执行真实本地 remote 的存取、multipart、Range、重启和写失败恢复，详见实验结果。其他项按对应范围继续验证。

| 步骤 | 环境与输入 | 通过条件 |
|---|---|---|
| 固定组件兼容 | Synapse 1.164.2、provider 1.7.0、rclone 1.75.2，隔离本地合成目录 | 模块加载、S3 签名、上传、读取、Range、缩略图正常 |
| 数据与协议 | 空文件、Unicode 名称、同名不同内容、50 MiB、multipart | 字节与 SHA-256 一致，稳定附件身份、错误分类准确 |
| 完成语义 | cache off 与 writes/full 分别测试，阻断远端写入 | 仅达到所声明持久化阶段时标为可用，重启后可核对 |
| 中断与并发 | 上传中断、丢失回执、重复请求、进程重启、磁盘满 | 任务可恢复，旧对象可读，重复发布受约束 |
| 索引 | 大目录分页、同名文件、外部修改、全量扫描中断 | 分页稳定，同名身份保留，中断扫描不误删旧索引 |
| 删除与迁移 | 保留消息引用、复制失败、切换前后重启、删除重试 | 原有 mxc 可读，有引用对象受保护，失败可恢复 |
| 真实后端 | 后续分别使用授权的 R2、Drive、OneDrive 合成目录 | OAuth 刷新、配额/限流、真实 multipart 和重启恢复通过 |

组件实验应放在隔离测试目录或后续产品实施包内，与验收范围一起记录。S3 本地夹具通过仅覆盖协议路径，三个真实云后端分别验收。

## 本轮决定记录

2026-11-04，用户提出服务器多后端存储与索引需求，明确 Cloudflare R2。实施代理按本轮授权完成 local/S3 配置与限定协议实验，优先复用 Synapse S3 provider 和 rclone。OpenList 保留为文件门户选项。当前通过范围为本机 Core、Matrix 与 rclone local remote 的真实协议闭环，真实云账号、物理跨机、迁移、回收与已有云盘索引分别推进。
