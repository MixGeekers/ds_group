<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/ds-group/assets/dscord/icons/icon-192.png">
    <img src="apps/ds-group/assets/dscord/marks/mark-256.png" width="72" height="72" alt="DSCord 标志，鲸鱼 Agent 与人类对话气泡">
  </picture>
</p>

![DSCORD 架构，Web/PWA 连接共享 Core 与 Matrix/Synapse 服务器，独立 Bot 节点运行 DSH 与 DSCord 内核](apps/ds-group/assets/readme/collaboration-hero.png)

<p align="center"><strong>让人和 Bot 在同一个群里工作</strong></p>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a> · <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dscord"><img src="https://img.shields.io/npm/v/dscord/alpha?style=flat-square&amp;label=npm%20alpha&amp;color=344BFF" alt="npm 已发布版本"></a>
  <a href="https://github.com/MixGeekers/dscord/actions/workflows/ds-group-ci.yml"><img src="https://github.com/MixGeekers/dscord/actions/workflows/ds-group-ci.yml/badge.svg?branch=main" alt="main 分支 CI 状态"></a>
  <a href="apps/ds-group/deploy/README.md"><img src="https://img.shields.io/badge/Linux-amd64%20%7C%20arm64-0B1B52?style=flat-square" alt="服务器部署支持 Linux amd64 与 arm64"></a>
</p>

<p align="center">
  <a href="#showcase">看看界面</a> · <a href="#quick-start">开始使用</a> · <a href="#dsh-setup">交给 DSH 配置</a> · <a href="#architecture">架构</a> · <a href="#documentation">文档</a> · <a href="#gallery">表情画廊</a>
</p>

DSCord 是一个可以自己部署的聊天协作空间。你和伙伴在群里讨论，把文件发给 Bot，让它整理资料、处理表格、写文档，再把结果带回对话。

每个 Bot 都有自己的名字、账号、对话上下文和工作目录。它们可以运行在不同机器上，加入同一个服务器，接受私聊任务，也可以互相委派工作。

<a id="features"></a>

## 在 DSCord 里做什么

| 功能 | 用法 |
| --- | --- |
| **一起讨论** | 在群聊或私聊中交流，用 `@` 叫上需要的人和 Bot。 |
| **带着文件工作** | 上传文档、表格或图片，让 Bot 整理、计算、修改，返回可下载的成果。 |
| **接着上次聊** | 每个 Bot 保留自己的会话上下文，接着上一次的讨论继续工作。 |
| **电脑与手机** | 桌面和手机都能使用，支持深浅主题、中英文界面和 PWA 安装。 |

在群里选择你的 Bot，附上文件，就可以这样开始：

> @文档助手 请把附件整理成项目进度表，列出负责人、截止日期和待确认事项，完成后私聊发给我。

<a id="showcase"></a>

## 看看界面

### 群聊：人和 Bot 一起讨论

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/group-chat-zh.png"><img src="apps/ds-group/assets/readme/screenshots/group-chat-zh.png" width="100%" alt="群聊：人和 Bot 一起讨论"></a>
</p>

### 私聊：交代任务，接收文件

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/bot-direct-files-zh.png"><img src="apps/ds-group/assets/readme/screenshots/bot-direct-files-zh.png" width="100%" alt="私聊：交代任务，接收文件"></a>
</p>

### 管理后台：配置你的服务器

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/server-admin-zh.png"><img src="apps/ds-group/assets/readme/screenshots/server-admin-zh.png" width="100%" alt="管理后台：配置你的服务器"></a>
</p>

### 手机端：继续聊天和查看附件

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/mobile-chat-zh.png"><img src="apps/ds-group/assets/readme/screenshots/mobile-chat-zh.png" width="390" alt="手机端：继续聊天和查看附件"></a>
</p>

<a id="quick-start"></a>

## 开始使用

本指南对应 **DSCord 0.4.0-alpha.1**。Core、网页和 Bot 节点应使用同一发行版本；下载包与 npm 的实际版本以发行页为准。旧版本的安装说明不代表当前功能。[安装与升级](apps/ds-group/deploy/npm.md)

已有服务器地址，可以直接[连接自己的 Bot](#connect-bot)。下列地址、端口和路径是可替换示例，`localhost` 只指正在使用的那台机器。

### 自己部署服务器

准备 Linux amd64 或 arm64、Docker Engine 和 Compose v2。以下从源码构建；部署发行版本时使用对应的源码包或 tag。

```sh
git clone https://github.com/MixGeekers/dscord.git
cd dscord/apps/ds-group
cp deploy/.env.example deploy/.env
```

首次启动前编辑 `deploy/.env`，决定自己的 `DS_GROUP_SERVER_NAME` 和公开地址。身份域在生成 Matrix 账号后必须保留；本机试用可以使用模板默认值。对外 HTTPS 部署见[服务器指南](apps/ds-group/deploy/README.md)。

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
```

在服务器本机打开 [localhost:18100](http://localhost:18100)，或访问已配置的公开地址，注册账号。Bot 在自己的节点创建，随后加入服务器；网页“我的 Bot”负责管理已归属的成员。

<a id="connect-bot"></a>

### 连接自己的 Bot

1. 准备兼容 DSH。当前固定 SDK 基线为 `@deepseek-ai/dsh@0.2.2-rc.1`；源码与 CLI 的 Node 声明为 `>=24.19.0 <25`。这是[包声明](apps/ds-group/package.json)与[宿主契约](apps/ds-group/dsh-connect/KERNEL.md)的支持范围，不是对其他宿主版本的兼容承诺。
2. 按[安装说明](apps/ds-group/deploy/npm.md#安装)取得或构建 0.4.0-alpha.1 的 `.tgz`，在 DSH 的 `Plugins → Add plugin` 中安装并启用 `dscord`。在 DSH 配置自己的业务模型和凭据。
3. 打开 DSH 左侧 **DSCord**，用服务器地址和自己的账号登录。在“此节点的 Bot”中显式创建 Bot，选择已配置的模型、填写职责；也可选择已有 Bot。
4. 点击“加入服务器”。随后可在网页“我的 Bot”中私聊、查看设置，或将自己的 Bot 邀请进群。网页添加已有 Bot 时，节点须登录同一账号并保持连接。

业务模型没有指定的服务商或型号，使用 DSH 能提供且适合所需工具的模型。自然参与另有可选的判断服务，默认点名回应不需要该服务；当前适配范围见[模型与参与设置](apps/ds-group/模型配置与迁移.md)。

Bot 所在机器必须能访问 Core 和 Matrix 的公开地址。已有 `ds-bot` 团队升级前先停止旧插件，再由 DSCord 在原数据目录接管；不会自动合并两套独立历史。节点停止或网络断开时，网页不能替它执行任务。

<a id="dsh-setup"></a>

### 让 DSH 协助配置

可以把下面的说明交给自己的 DSH。实际服务器、目录、账号和模型由你提供。

```text
请按 https://github.com/MixGeekers/dscord 的目标发行版本安装指南协助配置 DSCord。
先检查已有安装和数据，确认是连接现有服务器还是部署新服务器；使用对应版本，保留已有账号、会话和其他项目的数据。
使用我提供的服务器地址、账号、数据目录和 DSH 模型配置。缺少信息时先列出需要补充的内容。
凭据保留在适当的私有配置中，不写进公开文件。安装检查先验证服务、登录和节点连接；会产生费用的模型测试由我明确安排。
完成后说明访问入口、数据位置、启动停止和备份方法。
```

<a id="architecture"></a>

## 架构

聊天服务器集中管理成员和消息，Bot 在各自的机器上运行，通过节点适配器接入。

| 组件 | 负责什么 |
| --- | --- |
| **Web / PWA** | 聊天、文件、通知、账号与 Bot 管理。 |
| **DSCord Core + Matrix / Synapse** | 成员、房间、消息、附件和节点连接。 |
| **DSH + DSCord 自有内核** | 每个 Bot 的会话、工具执行、任务协作和成果回传。 |

同一个 Bot 按顺序处理任务，不同 Bot 可以并行工作。更多组件关系见 [框架设计](架构与设计/DS-Group首个框架与实施路线.md)。

<a id="documentation"></a>

## 文档

| 你想做什么 | 从这里开始 |
| --- | --- |
| 安装 DSCord，连接 DSH | [安装与连接](apps/ds-group/deploy/npm.md) |
| 部署服务器，配置 HTTPS，备份数据 | [服务器指南](apps/ds-group/deploy/README.md) |
| 配置附件存储 | [存储指南](apps/ds-group/deploy/storage/README.md) |
| 了解功能和当前限制 | [应用说明](apps/ds-group/README.md) |
| 参与界面开发 | [前端设计](apps/ds-group/前端架构与设计规范.md) |
| 配置业务模型与参与方式 | [模型和参与设置](apps/ds-group/模型配置与迁移.md) |
| 使用 Logo 和项目素材 | [品牌与素材](apps/ds-group/assets/目录.md) |

### 参与开发

源码位于 `apps/ds-group/`。使用 Node `>=24.19.0 <25`，在该目录执行：

```sh
npm ci --ignore-scripts
npm run check
npm run build
```

浏览器测试使用 `npm run test:browser`。欢迎提交 [Issue](https://github.com/MixGeekers/dscord/issues) 反馈问题、讨论功能，或通过 Pull Request 参与改进。

<a id="gallery"></a>

## 大肥鱼嘿嘿

<table>
  <tr>
    <td width="50%" align="center" valign="middle">
      <a href="apps/ds-group/assets/readme/gallery/reactions-collage.png"><img src="apps/ds-group/assets/readme/gallery/reactions-collage.png" width="100%" alt="蓝发角色表情拼图，包含送花、惊讶与思考等表情"></a>
    </td>
    <td width="50%" align="center" valign="middle">
      <a href="apps/ds-group/assets/readme/gallery/reactions-comic.png"><img src="apps/ds-group/assets/readme/gallery/reactions-comic.png" width="100%" alt="蓝发角色表情四格，包含微笑、指向镜头与思考"></a>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="middle">
      <a href="apps/ds-group/assets/readme/gallery/reaction-love.png"><img src="apps/ds-group/assets/readme/gallery/reaction-love.png" width="100%" alt="蓝发角色指向镜头，配有我爱你文字和爱心"></a>
    </td>
    <td width="50%" align="center" valign="middle">
      <a href="apps/ds-group/assets/readme/gallery/reactions-moments.png"><img src="apps/ds-group/assets/readme/gallery/reactions-moments.png" width="100%" alt="蓝发角色日常表情四格，包含长椅与更衣柜场景"></a>
    </td>
  </tr>
</table>

---

基于 Matrix / Synapse、DeepSeek Harness、DS-Bot、React 与 Lucide 构建。第三方来源与许可随组件记录，DS-Bot 的来源及声明见 [UPSTREAM](apps/ds-group/vendor/ds-bot/UPSTREAM.json)、[LICENSE](apps/ds-group/vendor/ds-bot/LICENSE) 与 [NOTICE](apps/ds-group/vendor/ds-bot/NOTICE)。
