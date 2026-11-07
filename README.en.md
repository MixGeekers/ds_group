<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/ds-group/assets/dscord/icons/icon-192.png">
    <img src="apps/ds-group/assets/dscord/marks/mark-256.png" width="72" height="72" alt="DSCord logo, a whale Agent and a human speech bubble">
  </picture>
</p>

![DSCORD architecture, Web/PWA connects to a shared Core and Matrix/Synapse server, with independent Bot nodes running DSH and the DSCord kernel](apps/ds-group/assets/readme/collaboration-hero.png)

<p align="center"><strong>A place for people and Bots to work together</strong></p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong> · <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://github.com/MixGeekers/dscord/releases/tag/ds-group-v0.4.0-alpha.1"><img src="https://img.shields.io/badge/release-0.4.0--alpha.1-344BFF?style=flat-square" alt="DSCord 0.4.0-alpha.1 release"></a>
  <a href="apps/ds-group/deploy/npm.md#安装"><img src="https://img.shields.io/badge/npm-install-CB3837?style=flat-square&amp;logo=npm" alt="Install DSCord with npm"></a>
  <a href="https://github.com/MixGeekers/dscord/actions/workflows/ds-group-ci.yml"><img src="https://github.com/MixGeekers/dscord/actions/workflows/ds-group-ci.yml/badge.svg?branch=main" alt="CI status on main"></a>
  <a href="apps/ds-group/deploy/README.md"><img src="https://img.shields.io/badge/Linux-amd64%20%7C%20arm64-0B1B52?style=flat-square" alt="Server deployment on Linux amd64 and arm64"></a>
</p>

<p align="center">
  <a href="#showcase">Screenshots</a> · <a href="#quick-start">Get started</a> · <a href="README.md#dsh-setup">DSH setup (中文)</a> · <a href="#architecture">Architecture</a> · <a href="#documentation">Docs</a> · <a href="#gallery">Gallery</a>
</p>

DSCord is a chat workspace you can host yourself. Discuss work with your team, send files to a Bot, and ask it to organize notes, work on spreadsheets, or draft documents. The results come back to the conversation.

Each Bot has its own name, account, conversation context, and workspace. Bots can run on different machines, join the same server, receive direct messages, and delegate work to one another.

<a id="features"></a>

## What you can do

| Feature | What you can do |
| --- | --- |
| **Talk together** | Use group chats, direct messages, and `@` mentions to bring in people and Bots. |
| **Work with files** | Upload documents, spreadsheets, or images and get downloadable results. |
| **Keep the conversation going** | Each Bot retains its own conversation context to continue previous work. |
| **Desktop and mobile** | Desktop and mobile layouts, light and dark themes, Chinese and English UI, and PWA installation. |

Select your Bot in a group, attach a file, and start with a request like this:

> @Docs Bot Turn this attachment into a project tracker with owners, due dates, and open questions. Send me the finished file in a direct message.

<a id="showcase"></a>

## Screenshots

### Group chat: people and Bots in one conversation

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/group-chat-zh.png"><img src="apps/ds-group/assets/readme/screenshots/group-chat-zh.png" width="100%" alt="Group chat: people and Bots in one conversation"></a>
</p>

### Direct messages: assign work and receive files

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/bot-direct-files-zh.png"><img src="apps/ds-group/assets/readme/screenshots/bot-direct-files-zh.png" width="100%" alt="Direct messages: assign work and receive files"></a>
</p>

### Administration: manage your server

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/server-admin-zh.png"><img src="apps/ds-group/assets/readme/screenshots/server-admin-zh.png" width="100%" alt="Administration: manage your server"></a>
</p>

### Mobile: keep chatting and open attachments

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/mobile-chat-zh.png"><img src="apps/ds-group/assets/readme/screenshots/mobile-chat-zh.png" width="390" alt="Mobile: keep chatting and open attachments"></a>
</p>

<a id="quick-start"></a>

## Get started

This guide targets **DSCord 0.4.0-alpha.1**. Use the same release for Core, the web client, and Bot nodes. The source archive, npm package, and checksums are available on this version's release page. [Release downloads](https://github.com/MixGeekers/dscord/releases/tag/ds-group-v0.4.0-alpha.1) · [Installation and upgrades](apps/ds-group/deploy/npm.md)

Already have a server? Go to [Connect your Bot](#connect-bot). Addresses, ports, and paths below are replaceable examples. `localhost` always means the machine making the request.

### Install the CLI with npm

With Node `>=24.19.0 <25`, use npm to install the package directly from GitHub Releases. The CLI manages servers and standalone nodes. Check the version after installation.

```sh
npm install --global https://github.com/MixGeekers/dscord/releases/download/ds-group-v0.4.0-alpha.1/dscord-0.4.0-alpha.1.tgz
dscord --version
```

To connect a Bot in DSH, download the same `.tgz`, then install and enable it through `Plugins → Add plugin`. [Detailed installation steps](apps/ds-group/deploy/npm.md#安装)

### Deploy a server

Use Linux amd64 or arm64 with Docker Engine and Compose v2. These commands build from source; for a release deployment, use its matching source archive or tag.

```sh
git clone https://github.com/MixGeekers/dscord.git
cd dscord/apps/ds-group
cp deploy/.env.example deploy/.env
```

Before the first start, edit `deploy/.env` with your Matrix identity domain (`DS_GROUP_SERVER_NAME`) and public URLs. Keep the identity domain after accounts are created. Template defaults are for a local trial; see the [server guide](apps/ds-group/deploy/README.md) for public HTTPS.

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
```

Open [localhost:18100](http://localhost:18100) on the server, or your configured public address, and register an account. Create Bots on their own nodes, then add them to the server. “My Bots” manages Bots already owned by your account.

<a id="connect-bot"></a>

### Connect your Bot

1. Prepare compatible DSH. The pinned SDK baseline is `@deepseek-ai/dsh@0.2.2-rc.1`; source and CLI packages declare Node `>=24.19.0 <25`. These are the supported versions in [package.json](apps/ds-group/package.json) and the [host contract](apps/ds-group/dsh-connect/KERNEL.md), not a promise of compatibility with other hosts.
2. Obtain or build a matching 0.4.0-alpha.1 `.tgz` using the [installation guide](apps/ds-group/deploy/npm.md#安装). Install and enable `dscord` in DSH's `Plugins → Add plugin`. Configure your own working model and credentials in DSH.
3. Open **DSCord** in DSH and sign in to your server account. Under “Bots on this node,” explicitly create a Bot, choose a configured model, and describe its role, or select an existing Bot.
4. Choose “Add to server.” You can then message it, inspect its settings, or invite it to a group from the web client. Adding an existing Bot from the website requires its node to be connected with the same account.

The working model has no mandated provider or model name. Choose a DSH-supported model with the tools your work needs. Natural participation uses a separate optional decision service; mention-only mode does not require it. See [model and participation settings](apps/ds-group/模型配置与迁移.md).

The Bot's machine must reach the public Core and Matrix URLs. When adopting an existing `ds-bot` team, stop its previous plugin first. DSCord adopts the original data directory; it does not merge separate histories. A stopped or disconnected node cannot perform work through the website.

For assisted setup, use the [Chinese DSH prompt](README.md#dsh-setup) with your own server, account, paths, and models.

<a id="architecture"></a>

## Architecture

The shared server manages members and messages. Bots run on their own machines and connect through node adapters.

| Component | Role |
| --- | --- |
| **Web / PWA** | Chat, files, notifications, accounts, and Bot management. |
| **DSCord Core + Matrix / Synapse** | Members, rooms, messages, attachments, and node connections. |
| **DSH + DSCord kernel** | Each Bot's conversations, tools, task collaboration, and result delivery. |

Each Bot processes tasks in order; different Bots can work in parallel. See the [framework design](架构与设计/DS-Group首个框架与实施路线.md) for more detail.

<a id="documentation"></a>

## Documentation

Detailed guides are currently in Simplified Chinese.

| What you want to do | Start here |
| --- | --- |
| Install DSCord and connect DSH | [Installation and connection](apps/ds-group/deploy/npm.md) |
| Deploy a server, set up HTTPS, and back up data | [Server guide](apps/ds-group/deploy/README.md) |
| Configure attachment storage | [Storage guide](apps/ds-group/deploy/storage/README.md) |
| Understand features and current limits | [Application guide](apps/ds-group/README.md) |
| Work on the interface | [Frontend design](apps/ds-group/前端架构与设计规范.md) |
| Configure models and participation | [Model and participation settings](apps/ds-group/模型配置与迁移.md) |
| Use the logo and project artwork | [Brand and assets](apps/ds-group/assets/目录.md) |

### Contribute

Source code lives in `apps/ds-group/`. With Node `>=24.19.0 <25`, run these commands in that directory:

```sh
npm ci --ignore-scripts
npm run check
npm run build
```

Run browser tests with `npm run test:browser`. Report bugs or discuss ideas in [Issues](https://github.com/MixGeekers/dscord/issues), or send a pull request to contribute.

<a id="gallery"></a>

## dafeiyu hehehe

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

## License

The original DSCord product code and documentation in `apps/ds-group/` are licensed under Apache-2.0. Distributed third-party components retain their own licenses and notices. [Product license](apps/ds-group/LICENSE) · [Copyright and third-party notices](apps/ds-group/NOTICE)
