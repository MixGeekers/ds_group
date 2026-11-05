# DSCord 连接、账号与存储

更新于 2026-11-04（America/Caracas）。用户要求同时推进 DSH 安装后的连接体验、服务器注册登录，以及可选服务器附件存储和索引。用户已澄清 S2 指 Cloudflare R2。当前源码候选为 `0.3.0-alpha.1`，公开 npm 版本仍为 `0.2.0-alpha.1`。

[产品路线](<DS-Group首个框架与实施路线.md>) · [应用说明](<../apps/ds-group/README.md>) · [存储候选](<../技术候选/DSCord多后端存储.md>)

## 用户操作路径

| 操作位置 | 用户操作 | 可见结果 |
|---|---|---|
| 服务器网页 | 注册账号或输入账号密码登录 | 进入聊天界面，看到会话与“我的 Bot” |
| 网页“我的 Bot” | 创建 Bot，输入名称 | 获得独立 Bot ID，可以私聊或邀请进群 |
| DSH 插件管理 | 安装 `dscord` 候选并启用 | 左侧出现 DSCord，插件详情中出现配置页 |
| DSH 的 DSCord 页面 | 输入服务器网页地址、账号和密码 | 显示当前账号与自己拥有的 Bot |
| DSH 的 Bot 列表 | 点击“上线” | 启动该 Bot 的独立运行时，显示连接状态 |
| DSH 的 Bot 列表 | 断开或重连 | 按该 Bot 操作节点进程，原数据目录持续复用 |
| 网页聊天 | 私聊 Bot，或在群里点名 Bot | Bot 在自己的节点处理输入并发送回复 |

当前候选在 DSH 中通过 `Plugins → Add plugin` 输入本地 `.tgz` 绝对路径安装，随后在包详情启用 `Enable dscord`。公开 npm 版本升级到包含该入口的版本后，包名安装才能提供相同界面。[安装说明](<../apps/ds-group/deploy/npm.md>)

DSH 连接页包含服务器地址、账号、密码、我的 Bot、连接状态、打开网页和可展开的本机配置目录。界面跟随宿主主题与语言。Bot 名称之外显示稳定账号 ID，以区分同名个体。新 Bot 先在网页创建，连接页读取所有者列表。

一个 DSH profile 当前连接一个服务器账号，可以管理该账号的多个 Bot。切换账号或服务器时先停止原连接。此范围由当前 `ConnectController` 的单账号状态实现，多服务器同时在线可在后续扩展连接列表。

## 核心与节点的边界

```text
网页 / PWA
    │ 注册、登录、创建 Bot、聊天、附件
    ▼
DSCord Core ── Matrix / Synapse
    ▲               ▲
    │ 账号与连接配置 │ 消息同步与发送
    │               │
DSH 的 DSCord 页面 ── 每个 Bot 的独立节点
                       └─ DSH + DS-Bot + Session + 工作目录
```

DSH 内的 `dsh-connect/` 提供账号连接与节点管理。它按 Bot 启动独立 DSH 运行时和 Matrix 接入进程。已有 `dsh-plugin/` 负责独立运行时中的模型、工具和 DS-Bot 适配。两个入口各自维护所属生命周期。

默认连接目录为 `DSH_HOME/dscord/<profile>/`。`connection.json` 保存当前服务器、账号会话和期望在线状态，`nodes/<稳定派生标识>/` 保存每个 Bot 的配置与运行数据。密码只用于登录请求。节点配置含该 Bot 的 Matrix 凭据和节点凭据，文件以私有权限保存。

上线前从 Core 取得当前 Bot 身份与连接配置，启动后核对本地运行时和 Core 心跳。断开先排空 Matrix 适配进程，再停止独立 DSH。退出管理宿主时使用独立清理子进程和生命周期锁协调多 Bot 关闭。插件重载后按期望在线状态恢复。[真实宿主验证](<../apps/ds-group/artifacts/onboarding/dsh-connect-host.json>)

## 注册登录与 Bot 归属

Matrix 保存账号密码、客户端设备会话和房间成员关系。Core 的 `AccountService` 在 `accounts.sqlite` 保存动态成员、Bot 所有者及执行成员操作需要的服务端会话。新客户端登录各自创建设备会话，客户端退出只注销对应会话。

| 接口 | 当前职责 |
|---|---|
| `GET /api/bootstrap` | 公开成员、节点状态及是否开放注册 |
| `POST /api/register` | 创建人类账号并返回客户端登录会话 |
| `POST /api/login` | 使用已有本服账号登录 |
| `GET /api/me` | 返回当前人类与其拥有的 Bot |
| `POST /api/logout` | 退出当前客户端会话 |
| `GET /api/bots` | 列出当前账号拥有的 Bot |
| `POST /api/bots` | 根据名称创建独立 Bot，支持同一请求重试 |
| `POST /api/bots/:id/connect` | 为所有者返回目标 Bot 的节点配置 |

服务器默认开放注册，可通过 `core-config.json` 的 `registrationMode` 选择 `open` 或 `closed`。注册依赖初始化产生的 Matrix 服务器身份与共享注册配置。注册成功的人类加入初始协作房间，新 Bot 的群成员关系由后续邀请形成。

Bot 使用生成的账号 ID，显示名称允许重复。节点配置绑定该 Bot，Core 核对心跳、任务操作和模型账目的 Bot 范围。`node-credentials.sqlite` 支持 Core 与 CLI 读取当前凭据，CLI 导出新 Bot 后可直接对已运行的 Core 认证。已有服务器的旧节点配置继续兼容。节点持续刷新公共成员列表，使新注册成员、新 Bot 与后续群内提及在现有运行节点中可见。[SQLite 凭据复验](<../apps/ds-group/artifacts/onboarding/onboarding-2026-11-05T00-35-05-315Z.json>)

账号注册与 Bot 创建存在分步写入。Core 保存处理中状态和稳定创建请求标识，恢复时核对 Matrix 已有结果。当前验收覆盖两个并行使用的人类、多设备、客户端退出、独立服务端会话、同名 Bot 和 Core 重启。邮件验证、密码找回、邀请制注册及多 Core 并发部署仍需各自实施与验收。

本轮真实 PWA 验证在多个账号共用 Core 出口时遇到 Synapse 地址限流。后续修补将客户端连接 IP 传给 Synapse，单层可信代理通过显式 `trustProxy` 配置解析转发地址，并保留账号和失败尝试限流。前端按服务器等待时间提示用户再次提交。修复后使用原受限账号完成一次真实登录、个人 Bot 恢复和页面刷新，三项通过，原失败报告保留。[登录复验](<../apps/ds-group/artifacts/onboarding/pwa-login-recovery-2026-11-05T00-43-39-942Z/report.json>) · [配置边界](<../apps/ds-group/deploy/README.md#代理与登录限流>)

## 文件字节与服务端索引

本轮自主工程选择沿用 Matrix 媒体链路，使用固定 `synapse-s3-storage-provider` 连接 S3-compatible 存储。rclone 提供 Drive、OneDrive 和其他云盘连接的候选网关。项目比较、许可与固定来源见[存储调研](<../技术候选/DSCord多后端存储.md>)。

| 数据 | 当前保存位置 | 本轮范围 |
|---|---|---|
| 用户、房间、消息和消息中的附件引用 | Synapse 数据库 | 继续使用已有 Matrix 事件关系 |
| 附件 ID、名称、大小、哈希、上传状态、Matrix URI | Core `media.sqlite` | 现有上传索引与幂等记录 |
| 附件原文件与媒体缓存 | Synapse 本地目录，可选 S3-compatible 桶 | 每台服务器选择一个活动后端 |
| Bot Session、工作文件和工具产物 | 所属 Bot 节点 | 成果上传后关联到聊天附件 |
| 已有云盘目录、外部对象版本、扫描游标、搜索索引 | 后续 Core 索引扩展 | 设计与后续实施范围 |

配置入口为 `DS_GROUP_MEDIA_BACKEND=local|s3`。S3 模式支持 bucket、endpoint、region、prefix 和访问凭据。R2 使用其 S3 endpoint，region 为 `auto`。Synapse 扩展镜像固定 provider 版本，Compose overlay 负责初始化这些配置。[存储部署说明](<../apps/ds-group/deploy/storage/README.md>)

S3 模式保留本地上传和缓存路径，并同步写入桶。上传成功等待 provider 返回。首次启用 S3 后，新文件进入该路径，既有本地附件保持其原存储位置。初始化会复用已保存的后端选择，已有 S3 目标的切换需要显式迁移。

Google Drive 与 OneDrive 的接入路径为 `Synapse → S3 provider → rclone S3 网关 → 云盘专用目录`，`compose.rclone.yaml` 已提供管理员已有 remote 的配置模板。固定 rclone 的 S3 网关仍标为实验功能，上传完成语义、临时文件和重启恢复需按具体 remote 验证。本轮本地目录 remote 已通过正常上传、9 MiB multipart、移除本地缓存后的远端回读、Range、Core/Synapse 重启及失败重试。真实云端 OAuth、配额、大文件和断网恢复分别验收。[协议结果](<../apps/ds-group/artifacts/storage/protocol-pass.json>)

下一步索引应在 Core 持久保存连接 ID、稳定外部对象 ID、版本、扫描游标和迁移进度。聊天附件继续沿现有身份与房间引用读取，扫描已有云盘时另建文件目录与分页查询入口。历史文件转存、重建索引和远端删除需要可恢复任务记录，再开放后端切换。

## 本轮证据与待验项

| 项目 | 证据层级 | 当前结果 |
|---|---|---|
| 注册、登录、同名 Bot、所属连接、附件与提及 | 真实 Core + 官方 Synapse，零模型 | 8 项通过，含重启恢复，固定源码哈希见报告 |
| SQLite 节点凭据与动态 Bot 导出 | 真实 Core + CLI，零模型 | 3 项通过，CLI 签发后现有 Core 立即识别 |
| PWA 注册、个人 Bot、登录与布局 | 真实构建 PWA + Core，以及独立浏览器夹具 | 真实界面累计 18 项成功，初轮登录429后另存修复复验，69项夹具通过，均为零模型 |
| DSH 包安装与节点生命周期 | 真实本机隔离 DSH 0.2.1-rc.5，零模型 | 安装、登录、上线、断开、重连、插件重载通过，最终候选双 Bot 完整宿主快速重启恢复通过 |
| DSH 固定运行依赖 | 真实隔离依赖安装，零模型 | 宿主自带 Node/pnpm 在子进程无 npm 的 PATH 下完成首次安装和旧目录迁移 |
| 最终 npm 候选 | 干净安装 + 真实 Core/Synapse，零模型 | 7 项通过，含预构建 PWA、两人登录、消息、附件和安装目录无运行写入 |
| 本地模块与发行 CI | 源码检查及 Linux amd64/arm64 runner | 280 项模块通过，`57c9b32` 的 CI 10/10 通过 |
| 多后端配置与 provider 镜像 | 模块验证与真实镜像构建 | 21 项相关模块通过，固定镜像构建与 provider import 通过 |
| S3-compatible 存取与恢复 | 本地 rclone S3 协议实验 | 9 项通过，零模型、零云账号调用，实验进程已清理 |
| R2、AWS S3、Drive、OneDrive 真实账号 | 官方资料与固定源码核查 | 真实云端未验 |
| 核心与 Bot 分居两台物理机器 | 网络协议与同机多进程 | 物理跨机器未验 |

账号报告记录本轮合成身份、输入与检查结果。后续修改源码后需留新一轮证据，原报告按其中固定哈希解释。[账号验收](<../apps/ds-group/artifacts/onboarding/onboarding-2026-11-05T00-26-35-920Z.json>)

PWA 真实验证覆盖 1440×1000 和 390×844、中英文与深浅主题。两轮测试脚本问题与实际登录限流均保留原记录，修复后的生产构建为 `8fc2a1c498597b32`。手机原生 Safari 键盘缩放仍需实机检查。[界面验收汇总](<../apps/ds-group/artifacts/onboarding/pwa-validation-summary.json>)

最终本地 npm 候选的 SHA-1 为 `e3bb46fd06d90c6c1ec733cf9b61fe65a48e369f`，DSH 安装源码与冻结文件一致。双 Bot 已上线后关闭管理宿主，在其退出后 1 ms 启动新宿主，两者自动恢复原 DS-Bot/Session 身份并观察稳定 10 秒。本轮在途连接关闭仅有模块回归，实际模型任务中断恢复待验。管理宿主及其两个 Bot 的 7 个进程已退出，23090、23100、23101 端口已释放。[DSH 最终报告](<../apps/ds-group/artifacts/onboarding/dsh-connect-host.json>) · [npm 干净安装](<../apps/ds-group/artifacts/onboarding/npm-final-install-smoke.json>) · [运行依赖验证](<../apps/ds-group/artifacts/onboarding/runtime-dependencies.json>)

DSH 首次启用 404、手机长账号裁切及宿主五秒退出期限导致的孤立进程问题已保留在报告历史中，修复后分别复验。存储实验保留健康检查假设错误与 Range 回读失败的两轮记录，修复后另存通过结果。[存储实验结果](<../测试/2026-11-04-DSCord存储/结果.md>)

`57c9b32` 的 Linux amd64/arm64、容器部署、DSH 与浏览器 CI 共 10 项通过。公开 npm 发版、同机协议验收、物理跨机验收与真实云端验收分别记录。[本轮 CI](https://github.com/MixGeekers/ds_group/actions/runs/41944520804)
