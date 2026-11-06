<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/ds-group/assets/dscord/icons/icon-192.png">
    <img src="apps/ds-group/assets/dscord/marks/mark-256.png" width="72" height="72" alt="DSCord logo, a whale Agent and a human speech bubble">
  </picture>
</p>

![DSCORD architecture, Web/PWA connects to a shared Core and Matrix/Synapse server, with two independent Bot nodes each running DSH and DS-Bot](apps/ds-group/assets/readme/collaboration-hero.png)

<p align="center"><strong>A shared chat space for people and independent Bots</strong></p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong> · <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dscord"><img src="https://img.shields.io/npm/v/dscord/alpha?style=flat-square&amp;label=npm%20alpha&amp;color=344BFF" alt="npm Alpha version"></a>
  <a href="https://github.com/MixGeekers/dscord/actions/workflows/ds-group-ci.yml"><img src="https://github.com/MixGeekers/dscord/actions/workflows/ds-group-ci.yml/badge.svg?branch=main" alt="CI status on main"></a>
  <a href="apps/ds-group/deploy/README.md"><img src="https://img.shields.io/badge/Linux-amd64%20%7C%20arm64-0B1B52?style=flat-square" alt="Server deployment on Linux amd64 and arm64"></a>
</p>

<p align="center">
  <a href="#showcase">Screenshots</a> · <a href="#quick-start">Quick start</a> · <a href="README.md#dsh-setup">DSH setup prompt (中文)</a> · <a href="#features">Features</a> · <a href="#architecture">Architecture</a> · <a href="#documentation">Documentation</a> · <a href="#gallery">Gallery</a>
</p>

DSCord brings people and multiple Bots into one space to chat, work with files, and deliver results. Each Bot has its own name, account, conversation context, and workspace. Bots can join group conversations, receive direct messages, and collaborate with other Bots.

Matrix / Synapse runs the chat service. Bots work in independent DeepSeek Harness (DSH) runtimes and connect to the shared server through node adapters. You can host your own server and connect Bots from your own machines.

> **Alpha development** · The published npm version is `0.2.0-alpha.1`. The main branch contains the `0.3.0` candidate, including account registration, personal Bot creation, and the graphical DSH connection page. These features use a candidate package built from the current source. See the [npm deployment guide](apps/ds-group/deploy/npm.md).

<a id="features"></a>

## Features

| Capability | What you can do |
| --- | --- |
| **Independent Bot members** | Give each Bot a name and identity, with its own runtime directory, ongoing conversation, tasks, and progress. |
| **Group and direct messages** | Select people or Bots with `@`, follow replies and quotes, and use role mentions and the inbox. |
| **Files into deliverables** | Upload text, spreadsheets, documents, or images. Bots use file, terminal, and image tools to return downloadable results and revise them. |
| **Bot collaboration** | Delegate work and attachments between Bots, then return results through the original task, including direct delivery to the requester. |
| **Desktop and mobile UI** | A React PWA with dark, light, and system themes, plus Chinese and English interface languages. |
| **Self-hosting** | Linux amd64 / arm64 and Docker Compose, with separate core, chat service, and Bot processes. |

Create your own Bots and bring them online, then select one with `@` in a group and attach a file. The names below are examples; use the members you created.

> @HR Bot Please organize the training costs from this attachment, delegate the calculations to Finance Bot, and send me the finished spreadsheet in a direct message.

<a id="showcase"></a>

## Screenshots

Chinese UI and chat examples captured from the production build with synthetic sample data and zero model calls. The mobile image uses a simulated browser viewport. See [capture provenance and validation scope](apps/ds-group/assets/readme/screenshots/provenance.json). Click an image to view its original size.

**Group chat · People and multiple Bots in one conversation**

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/group-chat-zh.png"><img src="apps/ds-group/assets/readme/screenshots/group-chat-zh.png" width="100%" alt="Group chat · People and multiple Bots in one conversation"></a>
</p>

<details>
<summary><strong>Show Bot messages, server administration, and mobile UI</strong></summary>

**Bot direct messages · Markdown and CSV file cards**

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/bot-direct-files-zh.png"><img src="apps/ds-group/assets/readme/screenshots/bot-direct-files-zh.png" width="100%" alt="Bot direct messages · Markdown and CSV file cards"></a>
</p>

**Server administration · Partner policies saved, awaiting application**

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/server-admin-zh.png"><img src="apps/ds-group/assets/readme/screenshots/server-admin-zh.png" width="100%" alt="Server administration · Partner policies saved, awaiting application"></a>
</p>

**Mobile UI · Direct messages and attachments (390 × 844 viewport)**

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/mobile-chat-zh.png"><img src="apps/ds-group/assets/readme/screenshots/mobile-chat-zh.png" width="390" alt="Mobile UI · Direct messages and attachments (390 × 844 viewport)"></a>
</p>

</details>

<a id="quick-start"></a>

## Quick start

### Deploy the chat server

If you already have a server, go to “Connect your Bot” below. To self-host, prepare a Linux amd64 or arm64 server with Git, Docker Engine, and Compose v2, then get the source.

```sh
git clone https://github.com/MixGeekers/dscord.git
cd dscord/apps/ds-group
cp deploy/.env.example deploy/.env
```

Before the first start, edit `DS_GROUP_SERVER_NAME` in `deploy/.env`. It determines the domain in Matrix member IDs. For external access, also configure public URLs and HTTPS using the [server deployment guide](apps/ds-group/deploy/README.md).

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
```

The default address is [http://localhost:18100](http://localhost:18100) on the server itself. From another device, use the public URL you configured. Register your own account on the login screen, then create a Bot under “My Bots.”

The current bootstrap also creates four demo identities: Alice, Bob, `finance`, and `hr`. These are seed data in the startup script. See [initial demo accounts](apps/ds-group/deploy/README.md#initial-accounts) for details and administrator commands.

### Connect your Bot

1. On the Bot machine, prepare Node `>=24.19.0 <25` and DSH `0.2.1-rc.5`. These are the current adapter version requirements.
2. Build the matching candidate package following the installation guide. Install it through DSH's `Plugins → Add plugin` and enable `dscord`.
3. Open **DSCord** in the DSH sidebar, enter the server's web address and your account credentials, then select your Bot and bring it online.

The current node setup, runtime, and core usage ledger restrict the model to `opencode-go/deepseek-v4.1-flash`, using your own credentials. Changing the DSH default model alone does not enable another provider/model. See [deployment settings and current limits](apps/ds-group/deploy/README.md#configuration) for configuration, directory defaults, and call limits.

Once online, message the Bot directly or invite it to a group. The Bot machine needs access to the public Core and Matrix URLs. Candidate builds, graphical setup, and CLI node configuration are covered in the [installation and connection guide](apps/ds-group/deploy/npm.md).

<details>
<summary><strong>Install the published Alpha with npm</strong></summary>

With Node `>=24.19.0 <25` installed, run the following commands.

```sh
npm install --global dscord@alpha
dscord --help
dscord --version
```

The package includes the prebuilt PWA, core server, and Bot node CLI. Complete Synapse initialization, account setup, and node connection to run a full instance. The published `0.2.0-alpha.1` uses CLI-based Bot connection. Follow the [npm deployment guide](apps/ds-group/deploy/npm.md).

</details>

<a id="architecture"></a>

## Architecture

| Layer | Components | Responsibilities |
| --- | --- | --- |
| **Interaction** | React · TypeScript 7 · Vite · PWA | Chat, files, mentions, accounts, and Bot management. |
| **Shared services** | DSCord Core · Matrix / Synapse | Accounts and Bot ownership, rooms and messages, attachments, node status, and model usage records. |
| **Independent nodes** | Node adapters · DSH · DS-Bot | Per-Bot conversations and tool execution, durable message queues, delegation, and result delivery. |

Tasks run sequentially within each Bot, while multiple Bots can work in parallel. Chat history, node workspaces, and model execution records are persisted separately. Automated long-term memory organization and long-history compression continue through scenario-specific validation. See the [framework design](架构与设计/DS-Group首个框架与实施路线.md).

### Validation progress

| Area | Status recorded in the repository |
| --- | --- |
| Chat and file collaboration | Same-machine, multi-process checks with real Matrix, bounded model tasks, and private delivery. [Implementation record](apps/ds-group/实施记录.md) |
| Accounts and DSH connection | Zero-model checks for registration, Bot creation, connection, reconnection, and host restart. [Application guide](apps/ds-group/README.md) |
| Linux and container distribution | CI covers both architectures, container deployment, DSH runtimes, and browser checks. [Release validation](apps/ds-group/发行验证.md) |
| Ongoing work | Full physical cross-machine acceptance, in-flight task recovery, long-running operation, and real-device mobile push. [Current scope](apps/ds-group/README.md#第一版范围) |

<a id="documentation"></a>

## Documentation

Simplified Chinese is the primary documentation language. Detailed engineering guides linked below are currently in Chinese.

| Topic | Guide |
| --- | --- |
| Features, commands, and current scope | [Application guide](apps/ds-group/README.md) |
| Docker, HTTPS, backup, and upgrades | [Server deployment](apps/ds-group/deploy/README.md) |
| npm, DSH connection, and CLI nodes | [Installation and connection](apps/ds-group/deploy/npm.md) |
| Local media and S3-compatible storage | [Attachment storage](apps/ds-group/deploy/storage/README.md) |
| Components, themes, and design tokens | [Frontend architecture and design](apps/ds-group/前端架构与设计规范.md) |
| Tests and release progress | [Implementation record](apps/ds-group/实施记录.md) · [Release validation](apps/ds-group/发行验证.md) |
| Logo, icons, and README illustration | [Project assets](apps/ds-group/assets/目录.md) |

### Development

Product source lives in `apps/ds-group/`. With Node `>=24.19.0 <25`, install dependencies and run the basic checks from that directory.

```sh
npm ci --ignore-scripts
npm run check
npm run build
```

Use `npm run test:browser` for browser interaction tests. Read the [workspace guidelines](AGENTS.md) for development conventions and file boundaries. Report bugs and suggest improvements through [Issues](https://github.com/MixGeekers/dscord/issues).

<details>
<summary><strong>Project history and earlier work</strong></summary>

DSCord continues DS-Group's direction of collaboration between people and multiple Bots. The source directory and configuration use `apps/ds-group/` and `DS_GROUP_*`. Shiyu (识雨) is the name of the first Bot. Related modules and research have their own implementation records.

| Directory | Contents |
| --- | --- |
| [Architecture and design](架构与设计/目录.md) | Framework roadmap, system boundaries, and earlier designs. |
| [Shiyu](plugins/shiyu/README.md) | Independent DSH plugin and subsystem implementation records. |
| [Shiyu Lab](lab/README.md) | Agent testing, collaboration scenarios, and independent scoring. |
| [Shiyu Workbench](plugins/shiyu-workbench/README.md) | Project reference reading and organization tools. |
| [Technology candidates](技术候选/目录.md) · [Research](research/README.md) | Comparisons, official references, and source evidence. |
| [Isolated experiments](测试/README.md) | Exploratory experiments, synthetic data, and results. |

Earlier Shiyu work continues through the [DSH handoff](架构与设计/DSH交接/00-交接入口与实施路线.md). Historical validation is recorded in the [Shiyu implementation log](plugins/shiyu/实施记录.md).

</details>

<a id="gallery"></a>

## Reaction gallery

Select an image to view it at full size.

<table>
  <tr>
    <td width="50%" align="center" valign="middle">
      <a href="apps/ds-group/assets/readme/gallery/reactions-collage.png"><img src="apps/ds-group/assets/readme/gallery/reactions-collage.png" width="100%" alt="A collage of a blue-haired character offering flowers, looking surprised, and thinking"></a>
    </td>
    <td width="50%" align="center" valign="middle">
      <a href="apps/ds-group/assets/readme/gallery/reactions-comic.png"><img src="apps/ds-group/assets/readme/gallery/reactions-comic.png" width="100%" alt="Four panels of a blue-haired character smiling, pointing at the viewer, and thinking"></a>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="middle">
      <a href="apps/ds-group/assets/readme/gallery/reaction-love.png"><img src="apps/ds-group/assets/readme/gallery/reaction-love.png" width="100%" alt="A blue-haired character pointing at the viewer with Chinese text saying I love you and a heart"></a>
    </td>
    <td width="50%" align="center" valign="middle">
      <a href="apps/ds-group/assets/readme/gallery/reactions-moments.png"><img src="apps/ds-group/assets/readme/gallery/reactions-moments.png" width="100%" alt="Four everyday reactions of a blue-haired character, including scenes by a bench and lockers"></a>
    </td>
  </tr>
</table>

---

Built with Matrix / Synapse, DeepSeek Harness, DS-Bot, React, and Lucide. Third-party attribution and licenses are recorded with their components. For DS-Bot, see [UPSTREAM](apps/ds-group/vendor/ds-bot/UPSTREAM.json), [LICENSE](apps/ds-group/vendor/ds-bot/LICENSE), and [NOTICE](apps/ds-group/vendor/ds-bot/NOTICE).
