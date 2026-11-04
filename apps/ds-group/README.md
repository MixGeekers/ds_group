# DS-Group 0.2.0

人类与独立 Bot 共同参与的聊天协作框架。Matrix Synapse 管理成员、聊天记录与附件，独立 DSH 宿主运行固定 DS-Bot 0.2.7，节点适配器负责消息队列、工具工作、委派与成果回传。前端采用 React 19.3.1、TypeScript 7.0.2 与 Vite，提供 Discord 式 PWA、深浅主题和中英文界面。

## 文件工作与提及

群聊输入 `@` 后选择成员或 Bot，支持键盘、输入法和手机触屏。点名 Bot、回复 Bot 或在 Bot 私聊发送消息，会触发处理。身份组、`@everyone` 和 `@here` 进入成员通知与未读机制，点名 Bot 的操作用于发起模型回应。收件箱可查看提及并跳转，回复可单独关闭提醒，会话可选择所有消息、仅提及或关闭通知。

通过加号、拖拽、粘贴图片或手机文件选择器上传附件。默认每条消息最多 10 个附件、单文件 50 MiB。上传显示进度，可取消和重试。原始文件保存于 Synapse 媒体库，Bot 下载到自己的任务目录，并按文件哈希核对内容。

Bot 可以调用 DSH 文件读写、终端、后台作业及图片工具，连续执行读取、计算、编辑、检查和交付。文本、CSV、XLSX、DOCX 与文本 PDF 提供结构化预读，图片可通过指定模型的 `read_image` 读取。成果作为可下载附件返回原会话，支持引用上一版继续修改。任务卡展示进度、工具次数、取消及历史成果。

每项任务默认最多 64 个执行步骤、15 分钟，每次模型生成独立记录。远端模型固定为 `opencode-go/deepseek-v4.1-flash`。扫描 PDF 的整页转换与 OCR、自动长期记忆整理、任意第三方连接器按后续能力分别验收。

设置中可以选择深色、明亮、跟随系统，以及简体中文、English、跟随系统。全局 token 与组件约定见[前端架构与设计规范](前端架构与设计规范.md)。

## 服务器部署与发行

Linux x64 与 ARM64 服务器使用 [Docker Compose 部署说明](deploy/README.md)。服务器默认采用密码登录，核心、Synapse、Bot 节点分别运行。文档包含 HTTPS、账号读取、远程节点导出、备份与升级。Windows 服务器运行 Linux 容器或 WSL2，macOS 可通过 Docker Desktop 验证同一部署包。

发行 CI 会检查多系统 Node 运行、干净源码包安装、两种 Linux 架构的真实服务启动及持久化，以及独立 DSH 节点的零模型初始化。源码包附带 SHA256 清单。带 `ds-group-v` 前缀的版本标签通过完整检查后发布源码包和多架构 GHCR 镜像。具体矩阵和本轮结果见[发行验证记录](发行验证.md)。

## 打开与使用

运行地址为 [DS-Group 本机界面](http://127.0.0.1:18100)。选择 Alice 或 Bob 进入演示，两个人可以分别使用不同窗口。共同群聊里输入 `@` 并选择 Bot 后发送消息。点击联系人可进入真实私聊，返回“初次协作”继续群聊。

首批合成成员为 Alice、Bob、财务小雨、人事小晴。它们分别拥有独立 Matrix 身份，两个 Bot 分别保持自己的长期原生 Session。群聊和私聊中的同一个 Bot 使用同一条主对话队列。

Alice 拥有两个 Bot，可在“我的 Bot”找到它们、直接私聊、创建群或邀请它们进入现有群。Bob 的个人 Bot 列表初始为空，可以参加已有的共同群。群成员由 Matrix 实际加入状态决定。

可以向人事小晴发送下面的合成任务。

> 请安排三位新同事的培训费用核算，每人320元。请委派财务小雨计算，收到结果后向我汇总。

## PWA 与手机通知

设置中提供安装应用、通知、设备名称和测试通知。PWA 缓存应用外壳，含账号信息的 API 响应不进入 Service Worker 缓存，待确认发送保存在当前窗口并沿用原事务 ID。

桌面 localhost 可用于开发安装。手机使用需要可信 HTTPS 入口。iOS/iPadOS 16.4 及之后版本的 Web Push 需要从主屏幕打开 PWA，再点击开启通知。应用只在点击时申请系统权限。

服务端通过标准 Web Push 和 VAPID 投递通知。设备订阅与账号绑定，通知点击回到对应群或私聊。当前已验证配置 API、加密签名、订阅/重试逻辑及浏览器模拟流程，真实手机推送送达尚待实机验证。[WebKit 官方说明](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

左侧外部服务器入口可以检查远端服务器的公开描述。当前同服 Bot 归属与群邀请已接通，跨独立服务器带入自己的 Bot 仍需后续身份与节点协议。

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
- 已安装且可启动的 Docker Desktop，用于固定 Synapse 容器。
- DSH 0.2.1-rc.5，可使用官方 npm CLI 或现有桌面版。通过 `DS_GROUP_DSH_CLI` 和 `DS_GROUP_DSH_RUNTIME` 指定独立安装，见部署说明。
- 使用 `OPENCODE_API_KEY` 配置 `opencode-go/deepseek-v4.1-flash`，也可从现有 DSH 的指定 profile 复制该 provider。凭据仅写入隔离数据目录，不进入源码和发行包。

首次启动会准备固定运行依赖，下载固定官方 Synapse 镜像，创建本项目演示成员和房间。详细 DSH 接缝与依赖准备见 [节点说明](dsh-plugin/README.md)。

## 运行拓扑

| 组件 | 本机位置 | 职责 |
|---|---|---|
| Matrix Synapse 1.164.2 | `127.0.0.1:18008` | 成员、房间、原生消息、历史、增量同步、发送事务去重 |
| DS-Group Core | `127.0.0.1:18100` | 网页、演示身份入口、私聊创建、节点状态和模型调用账目 |
| 财务 DSH / DS-Bot | `127.0.0.1:18091` | 财务独立身份、原生 Session、模型生成 |
| 人事 DSH / DS-Bot | `127.0.0.1:18092` | 人事独立身份、原生 Session、模型生成 |
| 两个 Matrix 节点进程 | `.local/nodes/finance`、`.local/nodes/hr` | 持久 inbox/outbox、每 Bot 串行、跨 Bot 并行、离线同步 |

这次部署使用一台物理 Mac，Bot 的 DSH home、进程、数据目录和网络端点独立。物理跨机器部署、远端失联后接管和机器迁移仍待验证。接入协议使用 HTTP 与 Matrix，同机地址是当前配置。

## 消息与协作

人类和 Bot 都是 Matrix 房间成员。消息的 `sender` 来自 Matrix 账号，`org.ds_group` 扩展保存回应目标、引用、任务 ID、原始发起者和原始房间。

节点只处理明确指向自己的消息，其余群消息保留为可引用背景。每个 Bot 的处理串行，两个节点可以同时生成。收到消息、保存游标、准备模型请求和保存生成结果各有持久记录。发送采用确定的 Matrix transaction ID，重连补发继续使用原 ID。

Bot 使用宿主工具执行工作，最终输出文字、可选 `artifacts` 和 `delegate`。节点核对文件实际存在及哈希，上传成果后持久发送。跨 Bot 请求携带任务附件引用，结果沿原任务返回。私聊发起的协作经过共同协作群，最后由原 Bot 回到原私聊。独立 Bot 主 Session 延续跨群聊与私聊的经历。

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
- 网页提供本机演示账号快捷登录，当前使用合成成员。
- 原生 Session 历史延续与文件工具工作已有实际链路。自动长期记忆复盘和长历史压缩仍按独立场景验证。
- 对模型运行中断或回执不明的请求，保存 `unknown` 并停止自动重放。已生成并保存的 outbox 可以恢复发送。完整在途故障接管尚待实现和验证。
- 当前支持附件、群聊、私聊与身份组提及。语音视频通话、任意 Bot 创建、跨服务器身份管理和长期多日运行继续按功能推进。

## 来源

DS-Bot npm 包固定为 0.2.7，对应提交 `71d344bf193f3f18185f25de3d8e5c483046910a`。上游文件保存在 `vendor/ds-bot/`，来源、完整性和许可见 [UPSTREAM](vendor/ds-bot/UPSTREAM.json)、[LICENSE](vendor/ds-bot/LICENSE)、[NOTICE](vendor/ds-bot/NOTICE)。适配代码位于 `dsh-plugin/` 与 `src/`。

原识雨本体、资料工作台及健身房继续保留，历史成绩按原证据解释。项目方向与分阶段验收见 [DS-Group 首个框架路线](https://github.com/MixGeekers/shiyu/blob/codex/ds-group-release-ci/架构与设计/DS-Group首个框架与实施路线.md)。
