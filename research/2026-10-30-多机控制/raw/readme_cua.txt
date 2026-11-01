<div align="center">
  <a href="https://cua.ai" target="_blank" rel="noopener noreferrer">
    <picture>
      <source media="(prefers-color-scheme: dark)" alt="Cua logo" width="150" srcset="img/logo_white.svg">
      <source media="(prefers-color-scheme: light)" alt="Cua logo" width="150" srcset="img/logo_black.svg">
      <img alt="Cua logo" width="150" src="img/logo_black.svg">
    </picture>
  </a>

  <p align="center"><strong>Give AI agents computers they can use.</strong><br>Cua Spaces gives your agents full desktops on your Mac and on machines you own. This repository also holds Cua Driver for desktop automation, Lume for local VMs, CUA-S1 decision models and Cua Bench for evaluating computer-use agents.</p>

  <p align="center"><strong><a href="https://spaces.cua.ai">Get Cua Spaces</a></strong></p>

  <p align="center">
    <a href="https://cua.ai" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/cua.ai-0ea5e9" alt="cua.ai"></a>
    <a href="https://discord.gg/mVnXXpdE85" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/Discord-Join%20Server-10b981?logo=discord&logoColor=white" alt="Discord"></a>
    <a href="https://x.com/trycua" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/twitter/follow/trycua?style=social" alt="Twitter"></a>
    <a href="https://cua.ai/docs" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/Docs-0ea5e9.svg" alt="Documentation"></a>
    <br>
<a href="https://www.star-history.com/#trycua/cua" target="_blank" rel="noopener noreferrer"><img src="https://api.star-history.com/badge?repo=trycua/cua&type=trending" alt="trycua/cua | GitHub Trending on Star History" width="266" height="64"/></a>
  </p>

</div>

## Choose your path

<div align="center">
  <table width="100%">
    <tr>
      <td colspan="3" align="center" valign="top">
        <a href="#cua-spaces">
          <img src="img/card-cua-spaces-wide.webp" alt="Cua Spaces: full desktops for your agents. macOS and Linux Spaces on machines you own." width="100%">
        </a>
      </td>
    </tr>
    <tr>
      <td align="center" valign="top" width="33.33%">
        <a href="#cua-driver">
          <img src="img/card-cua-driver.webp" alt="Cua Driver: inspect and operate apps on macOS, Windows, and Linux" width="100%">
        </a>
      </td>
      <td align="center" valign="top" width="33.33%">
        <a href="#lume">
          <img src="img/card-cua-lume.webp" alt="Lume: local macOS and Linux VMs on Apple Silicon" width="100%">
        </a>
      </td>
      <td align="center" valign="top" width="33.33%">
        <a href="#cua-bench">
          <img src="img/card-cua-bench.webp" alt="Cua Bench: create tasks, evaluate agents, and export trajectories" width="100%">
        </a>
      </td>
    </tr>
  </table>
</div>

- **Cua Spaces:** [Install the app and run your first Space](https://cua.ai/docs/spaces/quickstart).
- **Cua Driver:** [Operate Calculator and verify its result](https://cua.ai/docs/cua-driver/quickstart).
- **Lume:** [Create a Tahoe VM and connect over SSH](https://cua.ai/docs/lume/quickstart).
- **Cua SDK and CLI:** [Install `cua` and create a local sandbox](#cua-sdk-and-cli).
- **CUA-S1:** [Explore small, specialized models for computer-use decisions](#cua-s1).
- **Cua Bench:** [Create and verify a simulated task](https://cua.ai/docs/cua-bench/quickstart).

Bring your own agent and model, or explore CUA-S1 for specialized decisions. Cua provides the computer and automation tools. [Computer-Use 2.0](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works) describes an agent moving between code, APIs, and graphical interfaces within the same task.

---

## Cua Spaces

Cua Spaces is a desktop app that gives your agents full desktops. Each desktop is a Space: a macOS VM built locally on your Mac, or a Linux or Omarchy image. Spaces run on your Mac, on other machines you own, and in [your own cloud account](https://cua.ai/docs/cua-sdk/guides/local-runtimes#your-own-cloud) (AWS, Google Cloud or Modal), and the app keeps them in your menu bar and notch.

- **Teleport.** Move a signed-in app, such as Chrome or Slack, into a Space and it opens there still signed in. Your sessions stay in the Cua Keyvault, encrypted on your Mac, and reach a Space only after you approve.
- **Multiplayer.** You and your agents work on the same desktop, each with your own cursor. Step in to make a choice, then hand the desktop back.
- **Agent-ready images.** Spaces images ship with [cua-spacesd](libs/cua-spacesd/README.md), so agents get processes, files, screenshots and input as soon as a Space starts.

https://github.com/user-attachments/assets/a2ccc86b-10d0-48c0-bee6-7ae652ba1c59

**Install on macOS 26 or later**

```sh
curl -fsSL https://cua.ai/install.sh | sh
```

On macOS the installer selects the Cua Spaces app by default and adds the `cua` CLI. You can also [download the signed `.dmg`](https://github.com/trycua/cua/releases/download/cua-spaces-v0.9.4/cua-spaces-0.9.4-darwin-universal.dmg), or get the `.pkg` from the [Cua Spaces 0.9.4 release](https://github.com/trycua/cua/releases/tag/cua-spaces-v0.9.4).

Spaces is free for individuals. Pro is $18 a month and Teams is $30 per seat a month, available now from 1 seat. See [pricing](https://cua.ai/pricing). The app is source-available under [FSL-1.1-MIT](#licensing).

**[Quickstart](https://cua.ai/docs/spaces/quickstart)** | **[Teleport an app](https://cua.ai/docs/spaces/guides/teleport-an-app)** | **[Share a Space](https://cua.ai/docs/spaces/guides/share-a-space)** | **[Host Spaces on a spare Mac (relay, Tailscale or SSH)](https://cua.ai/docs/spaces/guides/add-a-computer#use-a-spare-mac-to-host-spaces)** | **[Your own cloud](https://cua.ai/docs/cua-sdk/guides/local-runtimes#your-own-cloud)** | **[App source](apps/cua-spaces-macos/README.md)**

---

## Cua Driver

Give your agent tools to inspect and operate native desktop apps and browsers on macOS, Windows, and Linux. Connect through the CLI, MCP, or typed SDKs. Background delivery lets agents work without moving your pointer or taking focus when the app and platform support it; see [platform support](https://cua.ai/docs/cua-driver/concepts/platform-support) for the boundaries.

**macOS / Linux**

```sh
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
```

**Windows (PowerShell)**

```powershell
irm https://cua.ai/driver/install.ps1 | iex
```

**Your first result:** connect your agent, ask it to compute 6 × 7 in Calculator, and have it verify that the app displays 42. The tutorial covers platform setup, permissions, and agent connection.

**[Drive your first app](https://cua.ai/docs/cua-driver/quickstart)** | **[Installation](https://cua.ai/docs/cua-driver/quickstart)** | **[CLI Reference](https://cua.ai/docs/cua-driver/reference/cli)**

Using Claude Code, Codex, Cursor, OpenClaw, or another agent? [Find your integration](https://cua.ai/docs/cua-driver/guides/connect-your-agent). Source documentation and architecture notes live in [`libs/cua-driver/README.md`](libs/cua-driver/README.md).

### See Cua Driver in action

Two Cua Driver sessions select cells in LibreOffice Calc and objects in Inkscape on an Omarchy desktop while a terminal stays in the foreground. Watch the 50-second demo.

https://github.com/user-attachments/assets/b4e5517c-d2db-4758-b4cf-07131b0753b2

---

