<div align="center">
  <h1>🪟 Windows-MCP</h1>

  <a href="https://github.com/CursorTouch/Windows-MCP/blob/main/LICENSE.md">
    <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  </a>
  <img src="https://img.shields.io/badge/python-3.14%2B-blue" alt="Python">
  <img src="https://img.shields.io/badge/platform-Windows%2010–11-blue" alt="Platform: Windows 10 and 11">
  <img src="https://img.shields.io/github/last-commit/CursorTouch/Windows-MCP" alt="Last Commit">
  <a href="https://pepy.tech/projects/windows-mcp">
    <img src="https://static.pepy.tech/personalized-badge/windows-mcp?period=total&amp;units=INTERNATIONAL_SYSTEM&amp;left_color=BLACK&amp;right_color=GREEN&amp;left_text=downloads" alt="PyPI Downloads">
  </a>
  <br>
  <a href="https://x.com/CursorTouch">
    <img src="https://img.shields.io/badge/follow-%40CursorTouch-1DA1F2?logo=twitter&style=flat" alt="Follow on Twitter">
  </a>
  <a href="https://discord.com/invite/Aue9Yj2VzS">
    <img src="https://img.shields.io/badge/Join%20on-Discord-5865F2?logo=discord&logoColor=white&style=flat" alt="Join us on Discord">
  </a>

  <a href="https://trendshift.io/repositories/20935?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-20935" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/20935/daily?language=Python" alt="CursorTouch%2FWindows-MCP | Trendshift" width="250" height="55"/></a>

</div>

**Windows-MCP** is a lightweight, open-source project that enables seamless integration between AI agents and the Windows operating system. Acting as an MCP server bridges the gap between LLMs and the Windows operating system, allowing agents to perform tasks such as **file navigation, application control, UI interaction, QA testing,** and more.

mcp-name: io.github.CursorTouch/Windows-MCP

## Updates
- Windows-MCP reached `2M+ Users` in [Claude Desktop Extensiosn](https://claude.ai/directory). 
- Try out [🪟Windows-Use](https://pypi.org/project/windows-use/), an agent built using Windows-MCP.
- Windows-MCP is now available on [PyPI](https://pypi.org/project/windows-mcp/) (thus supports `uvx windows-mcp`)
- Windows-MCP is added to [MCP Registry](https://github.com/modelcontextprotocol/registry)

### Supported Operating Systems

- Windows 10
- Windows 11

The current package requires Python 3.14+, which [supports Windows 10 and newer](https://docs.python.org/3.14/using/windows.html#supported-versions). Earlier Windows versions are not supported by the current installation.

## 🎥 Demos

<https://github.com/user-attachments/assets/d0e7ed1d-6189-4de6-838a-5ef8e1cad54e>

<https://github.com/user-attachments/assets/d2b372dc-8d00-4d71-9677-4c64f5987485>

## ✨ Key Features

- **Seamless Windows Integration**  
  Interacts natively with Windows UI elements, opens apps, controls windows, simulates user input, and more.

- **Use Any LLM (Vision Optional)**
   Unlike many automation tools, Windows-MCP doesn't rely on any traditional computer vision techniques or specific fine-tuned models; it works with any LLMs, reducing complexity and setup time.

- **Rich Toolset for UI Automation**  
  Includes tools for basic keyboard, mouse operation and capturing window/UI state.

- **Lightweight & Open-Source**  
  Minimal dependencies and easy setup with full source code available under MIT license.

- **Customizable & Extendable**  
  Easily adapt or extend tools to suit your unique automation or AI integration needs.

- **Real-Time Interaction**  
  Typical latency between actions (e.g., from one mouse click to the next) ranges from **0.2 to 0.5 secs**, and may slightly vary based on the number of active applications and system load, also the inferencing speed of the llm.

- **DOM Mode for Browser Automation**  
  Special `use_dom=True` mode for State-Tool that focuses exclusively on web page content, filtering out browser UI elements for cleaner, more efficient web automation. Supports Chrome, Edge, and Firefox (Firefox uses an IAccessible2 fallback since it doesn't expose `RootWebArea` via UIA).

## 🛠️Installation

**Note:** When you install this MCP server for the first time it may take a minute or two because of installing the dependencies in `pyproject.toml`. In the first run the server may timeout ignore it and restart it.

### Prerequisites

- Python 3.14+
- UV (Package Manager) from Astra, install with `pip install uv` or `curl -LsSf https://astral.sh/uv/install.sh | sh`
- The `App` tool resolves localized Start Menu display names as well as internal app names; an English Windows display language is not required.

