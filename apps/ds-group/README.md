# DS-Group 0.1.0

人类与独立 Bot 共同参与的聊天协作框架。首个切片采用 Matrix Synapse 管理成员与聊天记录，两个独立 DSH 宿主运行固定 DS-Bot 0.2.7，节点适配器负责消息队列、委派与回传。前端是手机与电脑适配的 PWA，采用 Discord 式深色布局。

## 打开与使用

运行地址为 [DS-Group 本机界面](http://127.0.0.1:18100)。选择 Alice 或 Bob 进入演示，两个人可以分别使用不同窗口。共同群聊里勾选“邀请回应”的 Bot 后发送消息。点击联系人可进入真实私聊，返回“初次协作”继续群聊。

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
npm run up
npm run status
npm run down
```

`up` 保留已有 Matrix 房间、成员、Bot Session 和处理游标。`down` 有序停止本项目的节点、隔离 DSH、核心进程和 Synapse 容器，运行数据继续保留。

可单独管理 Matrix 接入进程。

```sh
node scripts/service.mjs down finance
node scripts/service.mjs up finance
```

单独重启 DSH 时，先停止对应接入进程，再执行 `node scripts/dsh-node.mjs stop finance`，最后执行 `node scripts/service.mjs up finance`。

### 本机依赖

- Node 24.19.x 与 npm。
- 已安装且可启动的 Docker Desktop，用于固定 Synapse 容器。
- 已安装的 DSH 0.2.1-rc.5。当前默认 CLI 位于 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`，可通过 `DS_GROUP_DSH_CLI` 指定其他位置。
- 现有 DSH 中配置可用的 `opencode-go/deepseek-v4.1-flash`。launcher 只把该 provider 的配置与引用凭据复制到 `.local/` 内的隔离 DSH home，源码和公开证据不包含凭据。

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

第一版 Bot 输出结构化回复与可选 `delegate`。节点按明确目标投递给另一位 Bot，结果沿原任务返回。私聊发起的协作经过共同协作群，最后由原 Bot 回到原私聊。独立 Bot 主 Session 延续跨群聊与私聊的经历。

## 验证

```sh
npm run check
npm run verify
```

`check` 做源码语法与本包离线模块验证。`verify` 会使用真实 Matrix、两个真实 DS-Bot 节点和用户指定的远端模型，并有序重启人事节点以验证会话延续。每次运行生成独立证据文件，失败也保留记录。

模型调用由 `.local/model-budget.sqlite` 记录，包含节点、请求 ID、开始与完成时间及用量。用户已授权无人值守不限次数测试，当前 `limit=null`，远端生成仍只允许 `opencode-go/deepseek-v4.1-flash`。单次输出上限当前为 4096 tokens，核心接纳上限为 8192 tokens。

证据入口为 [Matrix 实测](artifacts/matrix-smoke.json)、[DS-Bot 真实探针](artifacts/ds-bot-smoke.json)、[界面验证](artifacts/ui-verification.json)。完整逻辑闭环记录在 `artifacts/first-flow-*.json`，当前汇总见[验收摘要](artifacts/framework-validation.json)和[实施记录](实施记录.md)。

## 第一版范围

- 运行数据全部位于 `.local/`，已被 Git 排除。包含合成账号凭据、SQLite、日志、DSH Session 和 SDK 依赖链接。
- 网页提供本机演示账号快捷登录，当前使用合成成员。
- 本轮验证原生 Session 历史回忆。自动长期记忆复盘与本地工具执行关闭，通用文件工作与更广的工具能力留待后续切片。
- 对模型运行中断或回执不明的请求，保存 `unknown` 并停止自动重放。已生成并保存的 outbox 可以恢复发送。完整在途故障接管尚待实现和验证。
- 首批界面包括共同群与私聊。附件上传、语音视频、任意成员管理和长期多日运行尚待补齐。

## 来源

DS-Bot npm 包固定为 0.2.7，对应提交 `71d344bf193f3f18185f25de3d8e5c483046910a`。上游文件保存在 `vendor/ds-bot/`，来源、完整性和许可见 [UPSTREAM](vendor/ds-bot/UPSTREAM.json)、[LICENSE](vendor/ds-bot/LICENSE)、[NOTICE](vendor/ds-bot/NOTICE)。适配代码位于 `dsh-plugin/` 与 `src/`。

原识雨本体、资料工作台及健身房继续保留，历史成绩按原证据解释。项目方向与分阶段验收见 [DS-Group 首个框架路线](../../架构与设计/DS-Group首个框架与实施路线.md)。
