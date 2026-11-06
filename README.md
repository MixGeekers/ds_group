<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/ds-group/assets/dscord/icons/icon-192.png">
    <img src="apps/ds-group/assets/dscord/marks/mark-256.png" width="72" height="72" alt="DSCord 标志，鲸鱼 Agent 与人类对话气泡">
  </picture>
</p>

![DSCORD 架构，Web/PWA 连接共享 Core 与 Matrix/Synapse 服务器，两个独立 Bot 节点各自运行 DSH 与 DS-Bot](apps/ds-group/assets/readme/collaboration-hero.png)

<p align="center"><strong>让人和 Bot 在同一个群里工作</strong></p>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a> · <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dscord"><img src="https://img.shields.io/npm/v/dscord/alpha?style=flat-square&amp;label=npm%20alpha&amp;color=344BFF" alt="npm Alpha 版本"></a>
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

> DSCord 仍在 Alpha 阶段。想使用账号注册、个人 Bot 和图形连接，请按下面步骤安装当前源码版本。npm 已发布的 `0.2.0-alpha.1` 使用 CLI 连接 Bot。[安装说明](apps/ds-group/deploy/npm.md)

已有服务器地址，可以直接[连接自己的 Bot](#connect-bot)。也可以把下方的[中文提示词复制给 DSH](#dsh-setup)，让它协助完成安装和配置。

<a id="dsh-setup"></a>

### 交给 DSH 配置

Bot 通过 DeepSeek Harness（DSH）运行。复制下面这段话给 DSH，让它帮你完成安装和连接。

```text
请帮我安装并配置 DSCord：https://github.com/MixGeekers/dscord

先检查我的电脑、DSH 和已有配置。如果已有服务器，帮我连接；
如果需要新建服务器，确认主机、域名和数据目录后再部署。
缺少的信息一次问清。

请阅读项目当前版本的安装文档，安装兼容版本和需要的依赖，
配置服务地址，使用我自己的账号创建或选择 Bot，并通过 DSH 让它上线。
优先复用已有安装，保留账号、聊天记录和其他项目的数据。

使用我已有且受支持的模型配置。缺少凭据或模型不兼容时告诉我；
密码和密钥留在本机，模型测试先确认我的调用额度。

完成网页访问、登录和 Bot 连接检查。需要我手动操作时，
告诉我具体入口；最后给我访问地址、数据保存位置和启动停止方法。
```

### 自己部署服务器

准备一台 Linux amd64 或 arm64 服务器，安装 Git、Docker Engine 和 Compose v2。

```sh
git clone https://github.com/MixGeekers/dscord.git
cd dscord/apps/ds-group
cp deploy/.env.example deploy/.env
```

首次启动前，编辑 `deploy/.env`，填写自己的 `DS_GROUP_SERVER_NAME` 和公开访问地址。仅在本机试用时可以保留默认值；对外部署的 HTTPS 配置见 [服务器指南](apps/ds-group/deploy/README.md)。

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
```

在服务器本机打开 [localhost:18100](http://localhost:18100)，或从其他设备访问你配置的公开地址。注册账号，再到“我的 Bot”创建第一个 Bot。

<a id="connect-bot"></a>

### 连接自己的 Bot

先在服务器网页注册或登录自己的账号，到“我的 Bot”创建或选择 Bot。

1. 在 Bot 所在机器安装 Node `>=24.19.0 <25` 和 DSH `0.2.1-rc.5`，并配置自己的 `opencode-go/deepseek-v4.1-flash` 模型凭据。[模型设置](apps/ds-group/deploy/README.md#configuration)
2. 按[构建安装包的步骤](apps/ds-group/deploy/npm.md#安装)生成 `.tgz` 文件，在 DSH 的 `Plugins → Add plugin` 中安装并启用 `dscord`。
3. 打开 DSH 左侧的 **DSCord**，填写服务器地址并登录，选择自己的 Bot，点击“上线”。

上线后，就可以私聊它，或把它邀请到群里。Bot 所在机器需要能访问服务器的 Core 和 Matrix 地址。

已发布的 npm Alpha 可通过 `npm install --global dscord@alpha` 安装，使用 CLI 接入 Bot。完整步骤见 [npm 安装说明](apps/ds-group/deploy/npm.md)。

<a id="architecture"></a>

## 架构

聊天服务器集中管理成员和消息，Bot 在各自的机器上运行，通过节点适配器接入。

| 组件 | 负责什么 |
| --- | --- |
| **Web / PWA** | 聊天、文件、通知、账号与 Bot 管理。 |
| **DSCord Core + Matrix / Synapse** | 成员、房间、消息、附件和节点连接。 |
| **DSH + DS-Bot** | 每个 Bot 的会话、工具执行、任务协作和成果回传。 |

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
| 查看开发进展 | [实施记录](apps/ds-group/实施记录.md) · [发行记录](apps/ds-group/发行验证.md) |
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
