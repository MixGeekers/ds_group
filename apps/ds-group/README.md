# DSCord 0.3.0 候选

人类与独立 Bot 共同参与的聊天协作框架。Matrix Synapse 管理成员、聊天记录与附件，独立 DSH 宿主运行固定 DS-Bot 0.2.7，节点适配器负责消息队列、工具工作、委派与成果回传。前端采用 React 19.3.1、TypeScript 7.0.2 与 Vite，提供 Discord 式 PWA、深浅主题和中英文界面。

当前源码增加中央身份与默认归属服务、独立聊天客户端、每服管理后台，以及分层准入的跨服务器协作。DSH 连接页、服务器注册登录和可选附件存储一并保留在 `0.3.0-alpha.1` 源码候选中。公开 npm `dscord@0.2.0-alpha.1` 的能力按对应发行记录解释。连接入口、状态归属与当前验收范围见[连接、账号与存储设计](../../架构与设计/DSCord连接、账号与存储.md)。

独立后台的管理 UI 位于 `admin/`，各实例通过独立管理会话配置伙伴、成员和房间准入。接口、运行方法及逐层验证见[独立后台与治理切片](admin/README.md)和[协作空间 API 契约](artifacts/governance/contract.json)。

聊天端与独立后台共用 `ui/` 的 shadcn/ui + Base UI 基础控件、Tailwind 工具层和既有主题 token。当前迁移边界、依赖许可证与浏览器截图见[UI 基础组件实施记录](UI基础组件实施记录.md)。

独立网页/PWA 可以连接固定归属 Core，以同一中央身份切换实际协作空间，接受邀请及加入获准房间。部署配置、兼容范围和分层证据见[独立客户端部署](deploy/client/README.md)与[统一客户端实施记录](统一客户端实施记录.md)。

首个切片复用归属 Synapse 的密码认证与设备会话，持久保存中央 `authorityId`、用户 `subjectId` 和完整 Matrix ID 的绑定。协作服务器可通过 `dscord init --web-mode api-only` 选择纯 API 托管，运维使用独立后台入口。独立 OIDC 身份发行服务列为后续演进项。[中央身份实现](中央身份实施记录.md) · [API-only 部署](deploy/api-only.md)

## 账号与自己的 Bot

打开服务器网页，在登录窗口选择“注册账号”，填写用户名、显示名称和密码。注册后点击最左侧全局栏的“我的 Bot”，再点击“创建 Bot”，输入名称即可生成独立 Bot 身份。多个 Bot 可以使用相同显示名称，列表同时显示各自的完整 Bot ID。自己的 Bot 私聊始终在全局 Bot 区，进入服务器可查看其频道；Bot 实际加入的群仍会显示其成员身份。

在 DSH 的 `Plugins → Add plugin` 安装候选 `.tgz`，启用 `dscord`，再打开左侧 **DSCord**。填写 Core/PWA 服务器地址和自己的账号密码，登录后在“我的 Bot”中点击“上线”。这里可以查看连接状态、断开或重连，也可以打开服务器网页或展开本机配置目录。每个 Bot 使用独立 DSH 运行目录和 Session，指定模型为 `opencode-go/deepseek-v4.1-flash`。[安装与连接步骤](deploy/npm.md)

本地 DSH 0.2.1-rc.5 已完成实际安装、登录、上线、断开、重连和插件重载。最终候选另通过两个已在线 Bot 的完整宿主快速重启，恢复原 Bot/Session 身份，并持续观察 10 秒。测试为零模型调用，在途模型任务恢复仍需独立验收。[DSH 宿主验证](artifacts/onboarding/dsh-connect-host.json)

服务器默认开放注册。管理员可在 `core-config.json` 中设置 `registrationMode: "closed"`，重启 Core 后关闭注册。每次客户端登录使用独立会话，退出一台设备后其他设备继续使用自己的会话。真实 Matrix/Core 联调已覆盖两个新账号、同名 Bot 的独立身份、所属 Bot 连接、附件、提及和重启恢复。[本轮账号验收](artifacts/onboarding/onboarding-2026-11-05T00-26-35-920Z.json)

真实 PWA 检查覆盖桌面与手机尺寸、中英文和深浅主题，以及注册、创建 Bot、退出、修复后的登录和刷新恢复。初轮登录触发的地址限流已修复，原失败与后续复验分别保存。真实界面累计 18 项成功，另有 69 项浏览器夹具检查，均为零模型调用。[界面验收汇总](artifacts/onboarding/pwa-validation-summary.json)

## 附件后端与索引

默认使用 Synapse 本地媒体目录。`DS_GROUP_MEDIA_BACKEND=s3` 可以选择 S3-compatible 桶，支持 bucket、endpoint、region、prefix 和凭据配置。Cloudflare R2 使用自定义 endpoint 与 `auto` region。Compose 提供固定 Synapse S3 provider 扩展镜像，上传会等待远端写入完成。[存储部署步骤](deploy/storage/README.md)

`media.sqlite` 保存附件身份、名称、大小、哈希、上传状态和 Matrix URI，原文件由媒体后端保存。服务器当前选择一个活动附件后端。rclone overlay 可以接入管理员已有的 remote，Google Drive 和 OneDrive 的真实云端授权与恢复尚待验证。已有云盘目录的扫描、分页搜索索引、历史附件迁移和远端回收列入后续实施。[存储候选与证据](../../技术候选/DSCord多后端存储.md)

本地 rclone remote 的 9 项真实协议检查已通过，覆盖普通上传、9 MiB multipart、移除本地缓存后的远端读取、Range、重启恢复及远端写入失败后的稳定重试。此前健康探针与 Range 两轮失败记录分别保留。[存储协议验收](artifacts/storage/protocol-pass.json)

## 文件工作与提及

群聊输入 `@` 后选择成员或 Bot，支持键盘、输入法和手机触屏。点名 Bot、回复 Bot 或在 Bot 私聊发送消息，会触发处理。身份组、`@everyone` 和 `@here` 进入成员通知与未读机制，点名 Bot 的操作用于发起模型回应。收件箱可查看提及并跳转，回复可单独关闭提醒，会话可选择所有消息、仅提及或关闭通知。

通过加号、拖拽、粘贴图片或手机文件选择器上传附件。默认每条消息最多 10 个附件、单文件 50 MiB。上传期间显示待完成状态，支持取消和重试，成功以附件回执确认。原始文件保存于 Synapse 媒体库，Bot 下载到自己的任务目录，并按文件哈希核对内容。

Bot 可以调用 DSH 文件读写、终端、后台作业及图片工具，连续执行读取、计算、编辑、检查和交付。文本、CSV、XLSX、DOCX 与文本 PDF 提供结构化预读，图片可通过指定模型的 `read_image` 读取。成果作为可下载附件返回原会话，支持引用上一版继续修改。任务卡展示进度、工具次数、取消及历史成果。

每项任务默认最多 64 个执行步骤、15 分钟，每次模型生成独立记录。远端模型固定为 `opencode-go/deepseek-v4.1-flash`。扫描 PDF 的整页转换与 OCR、自动长期记忆整理、任意第三方连接器按后续能力分别验收。

群里可以向 Bot 说明“做好之后私聊发给我”。交付位置按原始人类发起者记录，生成中追加的明确提及或回复也可以在首次发送前更新。引用已有任务时优先按被回复消息关联，“再发一次”复用已确认的成品，普通新任务默认回当前会话。跨房间交付使用来源元数据关联原请求。

在私聊里联系 Bot 时，任务默认采用私聊交付与 Bot 间私聊协作。群内明确要求私聊交付的任务也通过 Bot 与 Bot 的私聊传递要求和文件，由原请求 Bot 最终交给人类。当前收件范围为原始人类发起者，Bot 同伴通过委派关系交接。工作记录通过顶部入口主动打开，对话区仅显示消息附件，执行时输入栏旁显示轻量动态点。

设置中可以选择深色、明亮、跟随系统，以及简体中文、English、跟随系统。全局 token 与组件约定见[前端架构与设计规范](前端架构与设计规范.md)。

## 服务器部署与发行

npm 发行名为 `dscord`。已公开的 `0.2.0-alpha.1` 包含预构建 PWA、核心服务和 Bot 节点 CLI，当前 `0.3.0-alpha.1` 候选另含 DSH 安装清单及连接页面。安装与启动步骤见 [npm 部署说明](deploy/npm.md)。通过 `npm run npm:pack` 构建带文件白名单的独立发行包，源工程的私有包清单用于本地开发。

Linux x64 与 ARM64 服务器使用 [Docker Compose 部署说明](deploy/README.md)。服务器默认采用密码登录，核心、Synapse、Bot 节点分别运行。文档包含 HTTPS、账号读取、远程节点导出、备份与升级。正式发行和 CI 目标为 Linux amd64/arm64 与 Docker/Compose。

发行 CI 包含 10 个任务，检查两种 Linux 架构的 Node/TS7 构建、干净源码包安装、浏览器交互、真实容器部署及持久化，以及独立 DSH 节点初始化、工具执行与取消。源码包附带 SHA256 清单。带 `ds-group-v` 前缀的版本标签通过完整检查后发布源码包和多架构 GHCR 镜像。具体矩阵和本轮结果见[发行验证记录](发行验证.md)。

## 本机演示

默认本机入口为 [DSCord 本机界面](http://127.0.0.1:18100)。选择 Alice 或 Bob 进入演示，两个人可以分别使用不同窗口。共同群聊里输入 `@` 并选择 Bot 后发送消息。点击联系人可进入真实私聊，返回“初次协作”继续群聊。

首批合成成员为 Alice、Bob、财务小雨、人事小晴。它们分别拥有独立 Matrix 身份，两个 Bot 分别保持自己的长期原生 Session。群聊和私聊中的同一个 Bot 使用同一条主对话队列。

Alice 拥有两个 Bot，可在“我的 Bot”找到它们、直接私聊、创建群或邀请它们进入现有群。Bob 的个人 Bot 列表初始为空，可以参加已有的共同群。群成员由 Matrix 实际加入状态决定。

可以向人事小晴发送下面的合成任务。

> 请安排三位新同事的培训费用核算，每人320元。请委派财务小雨计算，收到结果后向我汇总。

## PWA 与手机通知

设置中提供安装应用、通知、设备名称和测试通知。PWA 缓存应用外壳，含账号信息的 API 响应不进入 Service Worker 缓存，待确认发送保存在当前窗口并沿用原事务 ID。

桌面 localhost 可用于开发安装。手机使用需要可信 HTTPS 入口。iOS/iPadOS 16.4 及之后版本的 Web Push 需要从主屏幕打开 PWA，再点击开启通知。应用只在点击时申请系统权限。

服务端通过标准 Web Push 和 VAPID 投递通知。设备订阅与账号绑定，通知点击回到对应群或私聊。当前已验证配置 API、加密签名、订阅/重试逻辑及浏览器模拟流程，真实手机推送送达尚待实机验证。[WebKit 官方说明](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

左侧服务器栏按实际成员资格和本服准入展示协作空间，支持邀请接受和 A/B 房间切换。跨服 Bot 沿用原完整身份、所有者与运行节点，由所有者授权、双方服务政策、房间工作策略和节点能力共同限定可执行范围。当前跨服文件工作限定在获准房间内，具体工具、交付边界及实测记录见[跨服 Bot 实施与验证](artifacts/cross-server-bot/实施与验证.md)。

## 启动与停止

在本目录执行。

```sh
npm ci --ignore-scripts
npm run up
npm run status
npm run down
```

`up` 先完成 TS7 检查和 React 生产构建，再启动服务。已有 Matrix 房间、成员、Bot Session 和处理游标继续使用。`down` 有序停止本项目的节点、隔离 DSH、核心进程和 Synapse 容器，运行数据继续保留。仅开发界面时可运行 `npm run dev`，默认代理到本机核心，`DS_GROUP_CORE_URL` 可指定隔离核心地址。

可单独管理 Matrix 接入进程。

```sh
node scripts/service.mjs down finance
node scripts/service.mjs up finance
```

单独重启 DSH 时，先停止对应接入进程，再执行 `node scripts/dsh-node.mjs stop finance`，最后执行 `node scripts/service.mjs up finance`。

### 本机依赖

- Node 24.19.0 及以上的 24.x 与 npm。
- 可运行 Linux 容器的 Docker，用于固定 Synapse 容器。
- DSH 0.2.1-rc.5，可使用官方 npm CLI 或现有桌面版。通过 `DS_GROUP_DSH_CLI` 和 `DS_GROUP_DSH_RUNTIME` 指定独立安装，见部署说明。
- 使用 `OPENCODE_API_KEY` 配置 `opencode-go/deepseek-v4.1-flash`，也可从现有 DSH 的指定 profile 复制该 provider。凭据仅写入隔离数据目录，不进入源码和发行包。

首次启动会准备固定运行依赖，下载固定官方 Synapse 镜像，创建本项目演示成员和房间。详细 DSH 接缝与依赖准备见 [节点说明](dsh-plugin/README.md)。

## 运行拓扑

| 组件 | 本机位置 | 职责 |
|---|---|---|
| Matrix Synapse 1.164.2 | `127.0.0.1:18008` | 成员、房间、原生消息、历史、增量同步、发送事务去重 |
| DSCord Core | `127.0.0.1:18100` | 网页、注册登录、Bot 归属、私聊创建、附件索引、节点状态和模型调用账目 |
| 财务 DSH / DS-Bot | `127.0.0.1:18091` | 财务独立身份、原生 Session、模型生成 |
| 人事 DSH / DS-Bot | `127.0.0.1:18092` | 人事独立身份、原生 Session、模型生成 |
| 两个 Matrix 节点进程 | `.local/nodes/finance`、`.local/nodes/hr` | 持久 inbox/outbox、每 Bot 串行、跨 Bot 并行、离线同步 |

这次部署使用一台物理 Mac，Bot 的 DSH home、进程、数据目录和网络端点独立。物理跨机器部署、远端失联后接管和机器迁移仍待验证。接入协议使用 HTTP 与 Matrix，同机地址是当前配置。

## 消息与协作

人类和 Bot 都是 Matrix 房间成员。消息的 `sender` 来自 Matrix 账号，`org.ds_group` 扩展保存回应目标、引用、任务 ID、原始发起者和原始房间。

节点只处理明确指向自己的消息，其余群消息保留为可引用背景。每个 Bot 的处理串行，两个节点可以同时生成。收到消息、保存游标、准备模型请求和保存生成结果各有持久记录。发送采用确定的 Matrix transaction ID，重连补发继续使用原 ID。

Bot 使用宿主工具执行工作，最终输出文字、可选 `artifacts` 和 `delegate`。节点核对文件实际存在及哈希，上传成果后持久发送。跨 Bot 请求携带任务附件引用，结果沿原任务返回。私聊交付任务的协作经过 Bot 间私聊，最后由原 Bot 交给人类。独立 Bot 主 Session 延续跨群聊与私聊的经历。

## 验证

```sh
npm run check
npm run build
npm run test:browser
npm run verify
```

`check` 做源码语法、TS7 严格类型检查与模块验证，`build` 生成生产 PWA，`test:browser` 验证编辑器及 React 组件交互。`verify` 保留首框架的真实文本协作验证。新的 `npm run verify:work` 使用隔离核心默认端口 19100，验证 CSV、Excel、文件改稿、跨 Bot 文件交接与取消，显式增加 `-- --cases csv,revision,xlsx,delegate,cancel,image` 可包含实际图片读取。该验证会使用指定远端模型并生成独立证据。

模型调用由 `.local/model-budget.sqlite` 记录，包含节点、请求 ID、开始与完成时间及用量。用户已授权无人值守不限次数测试，当前 `limit=null`，远端生成仍只允许 `opencode-go/deepseek-v4.1-flash`。单次输出上限当前为 4096 tokens，核心接纳上限为 8192 tokens。

证据入口为 [Matrix 实测](https://github.com/MixGeekers/shiyu/blob/948f0b7dde72f072dbc44c3b2fc30b3817a74b49/apps/ds-group/artifacts/matrix-smoke.json)、[DS-Bot 真实探针](https://github.com/MixGeekers/shiyu/blob/948f0b7dde72f072dbc44c3b2fc30b3817a74b49/apps/ds-group/artifacts/ds-bot-smoke.json)、[界面验证](https://github.com/MixGeekers/shiyu/blob/948f0b7dde72f072dbc44c3b2fc30b3817a74b49/apps/ds-group/artifacts/ui-verification.json)。完整逻辑闭环记录在 `artifacts/first-flow-*.json`，当前汇总见[验收摘要](https://github.com/MixGeekers/shiyu/blob/948f0b7dde72f072dbc44c3b2fc30b3817a74b49/apps/ds-group/artifacts/framework-validation.json)和[实施记录](https://github.com/MixGeekers/shiyu/blob/948f0b7dde72f072dbc44c3b2fc30b3817a74b49/apps/ds-group/实施记录.md)。

## 第一版范围

- 运行数据全部位于 `.local/`，已被 Git 排除。包含合成账号凭据、SQLite、日志、DSH Session 和 SDK 依赖链接。
- `DS_GROUP_DATA_DIR` 可以将运行数据放在源码目录外。容器使用独立持久卷，升级镜像保留原数据。预算上限由已有预算数据库保存，修改配置文件不会重置历史账目或既存预算。
- 网页提供注册、密码登录、退出和个人 Bot 创建，本机演示模式另外提供合成账号快捷登录。
- 原生 Session 历史延续与文件工具工作已有实际链路。自动长期记忆复盘和长历史压缩仍按独立场景验证。
- 对模型运行中断或回执不明的请求，保存 `unknown` 并停止自动重放。已生成并保存的 outbox 可以恢复发送。完整在途故障接管尚待实现和验证。
- 当前支持个人 Bot、附件、群聊、私聊、身份组提及和受控跨服协作。语音视频通话、独立 OIDC 接入、任意跨服委派和长期多日运行继续按功能推进。

## 来源

DS-Bot npm 包固定为 0.2.7，对应提交 `71d344bf193f3f18185f25de3d8e5c483046910a`。上游文件保存在 `vendor/ds-bot/`，来源、完整性和许可见 [UPSTREAM](vendor/ds-bot/UPSTREAM.json)、[LICENSE](vendor/ds-bot/LICENSE)、[NOTICE](vendor/ds-bot/NOTICE)。适配代码位于 `dsh-plugin/` 与 `src/`。

原识雨本体、资料工作台及健身房继续保留，历史成绩按原证据解释。项目方向与分阶段验收见 [DS-Group 首个框架路线](https://github.com/MixGeekers/shiyu/blob/codex/ds-group-release-ci/架构与设计/DS-Group首个框架与实施路线.md)。
