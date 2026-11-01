# hammerspoon-mcp

> Give AI agents deep control over macOS — windows, audio, Bluetooth, Spaces, Focus mode, and 200+ OS APIs — through one MCP server.

[![macOS 13+](https://img.shields.io/badge/macOS-13%2B-blue)](https://hammerspoon.org/)
[![Node 22+](https://img.shields.io/badge/Node-22%2B-green)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://typescriptlang.org)

## What is this?

An [MCP](https://modelcontextprotocol.io/) server that bridges AI agents to [Hammerspoon](https://hammerspoon.org/) — the most powerful macOS automation tool available. Unlike screenshot-and-click tools, this gives agents **programmatic OS-level access**: manage windows by ID, switch audio devices by name, move apps between Spaces, toggle Focus mode, and subscribe to real-time OS events.

**75 tools. 12 subscribable resources. Zero native dependencies.**

## Quick Start

```bash
# 1. Install Hammerspoon (if you haven't)
brew install --cask hammerspoon

# 2. Enable the IPC module (one-time setup)
#    Add this line to ~/.hammerspoon/init.lua:
#    require("hs.ipc")
#    Then reload your Hammerspoon config (Cmd+Alt+Ctrl+R or restart the app)

# 3. (Optional) Install the hs CLI symlink for convenience:
#    Run in Hammerspoon console: hs.ipc.cliInstall()
#    Or manually: ln -sf /Applications/Hammerspoon.app/Contents/Frameworks/hs/hs ~/.local/bin/hs

# 4. Run the MCP server
npx hammerspoon-mcp
```

> **Note:** The server auto-discovers the `hs` binary — it checks `~/.local/bin/hs`, `/usr/local/bin/hs`, `/opt/homebrew/bin/hs`, and the app bundle path. You don't need `hs` on your PATH if Hammerspoon is installed to `/Applications`.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  MCP Client (Claude, Cursor, MeshClaw, etc.)            │
└──────────────────────────┬──────────────────────────────┘
                           │ stdio (JSON-RPC)
┌──────────────────────────▼──────────────────────────────┐
│  hammerspoon-mcp (Node.js)                              │
│  ├─ tools → execSync("hs -c '...'")  (request/response)│
│  └─ watchers → named pipe reader     (push events)     │
└──────────────────────────┬──────────────────────────────┘
                           │ hs CLI / named pipe
┌──────────────────────────▼──────────────────────────────┐
│  Hammerspoon.app (Lua runtime + ObjC bridge)            │
│  200+ modules: window, screen, spaces, audio, wifi,     │
│  bluetooth, battery, USB, filesystem, accessibility...  │
└──────────────────────────┬──────────────────────────────┘
                           │
              macOS APIs (CoreGraphics, IOKit, etc.)
```

## MCP Client Configuration

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "hammerspoon": {
      "command": "npx",
      "args": ["hammerspoon-mcp"]
    }
  }
}
```
</details>

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add hammerspoon -- npx hammerspoon-mcp
```
</details>

<details>
<summary><strong>Cursor / VS Code / Copilot</strong></summary>

Add to `.vscode/mcp.json`:
```json
{
  "servers": {
    "hammerspoon": {
      "command": "npx",
      "args": ["hammerspoon-mcp"]
    }
  }
}
```
</details>

<details>
<summary><strong>Kiro</strong></summary>

Add to `~/.aws/amazonq/mcp.json`:
```json
{
  "mcpServers": {
    "hammerspoon": {
      "command": "npx",
      "args": ["hammerspoon-mcp"]
    }
  }
}
```
</details>

## Tools

### 🪟 Window Management (7)

| Tool | Description |
|------|-------------|
| `hs_list_windows` | All visible windows with app, title, frame, id |
| `hs_focus_window` | Bring window to front by id or title match |
| `hs_move_window` | Move/resize window by id |
| `hs_window_layout` | 16 presets (halves, thirds, quarters, grid, cascade, center…) + custom fractional layouts |
| `hs_save_layout` | Snapshot all window positions as a named layout |
| `hs_restore_layout` | Restore a saved layout (matches by app + title) |
| `hs_list_layouts` | List saved layout names |

### 🖥️ Spaces / Virtual Desktops (9)

| Tool | Description |
|------|-------------|
| `hs_spaces_list` | All spaces per screen with active markers |
| `hs_spaces_active` | Currently focused space + screen |
| `hs_spaces_goto` | Switch by ID or index |
| `hs_spaces_move_window` | Move window to another space (optionally follow) |
| `hs_spaces_add` | Create a new space |
| `hs_spaces_remove` | Remove a space (safety checks) |
| `hs_spaces_windows` | Windows on a specific space |
| `hs_spaces_window_spaces` | Which space(s) a window is on |
| `hs_spaces_mission_control` | Toggle Mission Control / Exposé / Launchpad / Show Desktop |

### 📱 Application Control (3)

| Tool | Description |
|------|-------------|
| `hs_list_apps` | Running applications with bundle ID, PID, hidden state |
| `hs_launch_app` | Launch or activate an app by name |
| `hs_kill_app` | Quit an app |

### ⌨️ Input (3)

| Tool | Description |
|------|-------------|
| `hs_click` | Click at coordinates with button + modifier options |
| `hs_type` | Type text (Unicode, CJK, emoji) |
| `hs_hotkey` | Press key combo (e.g. `"cmd+shift+4"`) |

### 🖼️ Screen (3)

| Tool | Description |
|------|-------------|
| `hs_screenshot` | Capture full screen or region (base64 PNG) |
| `hs_screens` | Display info (resolution, name, rotation) |
| `hs_mouse_position` | Current cursor coordinates |

### 🔊 Audio Devices (6)

| Tool | Description |
|------|-------------|
| `hs_audio_devices` | List all input/output with volume, mute, transport type |
| `hs_audio_default` | Get/set default devices (fuzzy name match) |
| `hs_audio_volume` | Volume on any specific device (0–100) |
| `hs_audio_mute` | Mute/unmute/toggle any device |
| `hs_audio_datasources` | List/switch data sources (speakers vs headphones) |
| `hs_audio_watch` | Watch for device changes |

### 🔵 Bluetooth (5)

| Tool | Description |
|------|-------------|
| `hs_bluetooth_status` | Power state and discoverability |
| `hs_bluetooth_power` | On / off / toggle |
| `hs_bluetooth_devices` | List paired or connected devices |
| `hs_bluetooth_connect` | Connect by name (fuzzy) or MAC address |
| `hs_bluetooth_disconnect` | Disconnect a device |

> Requires [blueutil](https://github.com/toy/blueutil): `brew install blueutil`

### 🌙 Focus / Do Not Disturb (6)

| Tool | Description |
|------|-------------|
| `hs_focus_status` | Check if DND/Focus is active + profile name |
| `hs_focus_toggle` | Toggle via Control Center (no setup needed) |
| `hs_focus_shortcut` | Enable/disable via macOS Shortcuts (most reliable) |
| `hs_focus_install_shortcut` | One-time setup guide |
| `hs_focus_schedule` | DND for N minutes with auto-disable |
| `hs_focus_cancel_timer` | Cancel scheduled disable |

### 🔋 System State (6)

| Tool | Description |
|------|-------------|
| `hs_battery` | Charge %, power source, time remaining |
| `hs_wifi` | Current SSID and interface details |
| `hs_volume` | System volume get/set |
| `hs_dark_mode` | Get/toggle dark mode |
| `hs_notify` | Post a macOS notification |
| `hs_clipboard` | Read/write system pasteboard |

### 🔆 Display (1)

| Tool | Description |
|------|-------------|
| `hs_brightness` | Get/set screen brightness (0–100) |

### ⏱️ Timers (3)

| Tool | Description |
|------|-------------|
| `hs_timer_start` | Named countdown with notification on fire |
| `hs_timer_cancel` | Cancel by name |
| `hs_timer_list` | List active timers |

### 📁 Finder / Files (4)

| Tool | Description |
|------|-------------|
| `hs_finder_selection` | Get currently selected Finder items |
| `hs_finder_open` | Open/reveal path in Finder |
| `hs_trash` | Move to Trash (reversible) |
| `hs_quicklook` | Quick Look preview |

### 🛠️ Utilities (5)

| Tool | Description |
|------|-------------|
| `hs_system_info` | CPU, memory, thermal state, uptime |
| `hs_caffeinate` | Prevent sleep for N minutes |
| `hs_execute` | Run shell command (user environment) |
| `hs_open_url` | Open URL in browser or specific app |
| `hs_alert` | HUD-style on-screen overlay message |

### 👁️ Watchers — Live OS Event Streams (13)

| Tool | Events |
|------|--------|
| `hs_watch_apps` | App activated, launched, terminated, hidden |
| `hs_watch_wifi` | Network changes |
| `hs_watch_usb` | Device connect/disconnect |
| `hs_watch_battery` | Charge level, power source |
| `hs_watch_screens` | Display configuration |
| `hs_watch_paths` | Filesystem changes |
| `hs_watch_sleep` | Sleep/wake/lock/unlock |
| `hs_watch_clipboard` | Every pasteboard change |
| `hs_watch_clipboard_history` | Ring buffer with source app tracking |
| `hs_get_clipboard_history` | Read the full buffer |
| `hs_watch_urls` | Incoming `hammerspoon://mcp/...` URLs |
| `hs_unwatch` | Stop a watcher |
| `hs_list_watchers` | List active watchers |

### 🧪 Escape Hatch (1)

| Tool | Description |
|------|-------------|
| `hs_eval` | Execute arbitrary Lua in the Hammerspoon runtime |

This gives access to **all 200+ Hammerspoon modules** not covered by dedicated tools — USB details, serial ports, network interfaces, Canvas drawing, menubar items, etc.

## Resources (Subscriptions)

MCP clients can subscribe to resource URIs and receive push notifications when OS events fire:

| URI | Triggers |
|-----|----------|
| `watcher://apps` | App lifecycle events |
| `watcher://wifi` | Network changes |
| `watcher://usb` | USB device events |
| `watcher://battery` | Battery/power changes |
| `watcher://screens` | Display reconfiguration |
| `watcher://paths` | Filesystem changes |
| `watcher://sleep` | Sleep/wake/lock events |
| `watcher://clipboard` | Pasteboard changes |
| `watcher://clipboard_history` | Clipboard ring buffer updates |
| `watcher://urls` | Incoming URL events |
| `watcher://audio` | Audio device changes |
| `hammerspoon://system` | System info snapshot |

### How event streaming works

```
Agent calls: hs_watch_wifi
  → Server injects Lua watcher into Hammerspoon runtime
  → macOS WiFi change fires
  → Watcher writes JSON to named pipe (/tmp/hs-mcp-events.pipe)
  → Node reader emits event
  → Server calls sendResourceUpdated("watcher://wifi")
  → Client reads resource → gets { ssid: "NewNetwork", ... }
```

## Examples

**"Tile my editor and terminal side by side"**
```
hs_window_layout({ preset: "side-by-side" })
```

**"Switch my audio to AirPods"**
```
hs_audio_default({ output: "airpods" })
→ "set default output: AirPods Pro"
```

**"Move Slack to Space 3"**
```
hs_list_windows({ app: "Slack" })  → { id: 4523, ... }
hs_spaces_move_window({ windowId: 4523, spaceIndex: 3 })
```

**"Start a 25-minute focus session"**
```
hs_focus_schedule({ minutes: 25 })
hs_timer_start({ name: "pomodoro", minutes: 25, message: "Break time!" })
```

**"Notify me when I switch away from my IDE"**
```
hs_watch_apps()
→ Events stream to watcher://apps whenever focus changes
```

**"Connect my headphones and set volume to 40%"**
```
hs_bluetooth_connect({ device: "WH-1000XM5" })
hs_audio_volume({ device: "WH-1000XM5", volume: 40 })
```

## Compared to Alternatives

| Capability | hammerspoon-mcp | mac-use-mcp | macos-automator-mcp |
|------------|:-:|:-:|:-:|
| Window management by ID | ✅ | ❌ | ❌ |
| Virtual desktop (Spaces) control | ✅ | ❌ | ❌ |
| Audio device switching | ✅ | ❌ | ❌ |
| Bluetooth control | ✅ | ❌ | ❌ |
| Focus / DND mode | ✅ | ❌ | ❌ |
| Real-time OS event subscriptions | ✅ | ❌ | ❌ |
| Clipboard history | ✅ | ✅ | ❌ |
| Arbitrary OS scripting | ✅ (Lua) | ❌ | ✅ (AppleScript) |
| Screenshot | ✅ | ✅ | ❌ |
| Click / type / hotkeys | ✅ | ✅ | ❌ |
| Accessibility tree queries | via `hs_eval` | ✅ | ❌ |
| Zero-install (no prerequisites) | ❌ | ✅ | ✅ |
| Total tools | **75** | 18 | ~10 |

## Prerequisites

| Requirement | Install |
|---|---|
| macOS 13+ | — |
| Node.js 22+ | `brew install node` |
| Hammerspoon | `brew install --cask hammerspoon` |
| `hs.ipc` module | Add `require("hs.ipc")` to `~/.hammerspoon/init.lua` |
| blueutil (optional) | `brew install blueutil` (for Bluetooth tools) |

> The `hs` CLI symlink (`hs.ipc.cliInstall()`) is optional — the server auto-discovers the binary inside the Hammerspoon app bundle.

### Verify setup

```bash
# If hs is on your PATH:
hs -c 'return "ok"'

# Or directly via the app bundle:
/Applications/Hammerspoon.app/Contents/Frameworks/hs/hs -c 'return "ok"'

# Should print: ok
```

If this works, `npx hammerspoon-mcp` will connect successfully.

## Permissions

| Permission | Required for | How to grant |
|---|---|---|
| **Accessibility** | Window, input, app control | System Settings → Privacy & Security → Accessibility → add your terminal |
| **Screen Recording** | `hs_screenshot` only | System Settings → Privacy & Security → Screen Recording |

## Project Structure

```
hammerspoon-mcp/
├── src/
│   ├── index.ts              MCP server entry point + resource registration
│   ├── bridge.ts             hs CLI bridge (auto-discovers binary, eval, evalJson)
│   ├── tools.ts              Core tools: window, app, input, screen, system, eval (23)
│   ├── watcher-tools.ts      Watcher management tools (13)
│   ├── watchers.ts           Named pipe event bridge
│   ├── spaces-tools.ts       Spaces / virtual desktop tools (9)
│   ├── audio-tools.ts        Audio device management (6)
│   ├── focus-tools.ts        DND / Focus mode (6)
│   ├── bluetooth-tools.ts    Bluetooth via blueutil (5)
│   └── extra-tools.ts        Brightness, timers, system info, Finder, utils (13)
├── package.json
├── tsconfig.json
├── LICENSE                   MIT
└── README.md
```

## Development

```bash
git clone <repo>
cd hammerspoon-mcp
npm install
npm run dev     # Run with tsx (hot reload)
npm run build   # Compile to dist/
npm start       # Run compiled version
```

## How It Works

1. **Startup** — the bridge auto-discovers the `hs` binary (checks `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, app bundle) and validates connectivity
2. **Tools** execute synchronously via `hs -c '<lua>'` — typically 30–80ms per call. Stdout noise (`-- Loading extension: ...`) is stripped automatically
3. **Watchers** inject Lua code that writes JSON lines to a FIFO pipe; a Node reader process emits them as MCP resource updates
4. **Resources** buffer the last 50 events per watcher; clients read on-demand after receiving update notifications
5. **Graceful shutdown** stops all watchers and cleans up the pipe on SIGINT/SIGTERM

## Known Limitations

- Node.js 22+ is specified in `engines` but the server builds and runs fine on Node 20 (tested)
- `hs_spaces_goto`, `addSpaceToScreen`, `removeSpace` briefly flash Mission Control (macOS limitation — enable "Reduce motion" to minimize)
- Bluetooth tools require [blueutil](https://github.com/toy/blueutil) (`brew install blueutil`)
- Focus/DND reading uses heuristics (no public Apple API exists)
- `hs_screenshot` returns base64 — large for full-screen captures
- Saved layouts persist only in Hammerspoon's runtime (lost on HS reload)
- Named pipe path is `/tmp/hs-mcp-events.pipe` — only one server instance at a time

## License

[MIT](LICENSE) © 2026 Mohammed Babur
