# macOS「AI Agent 完全控制 Mac」项目调研报告

调研日期：2026-10-30 ｜ 调研人：识雨（子代理）
核实方式：原调研会话记载 web_fetch / web_search 工具不可用，改用 `curl` 抓取 GitHub API 与 README/文档原文。**star 数与活跃度是原调研在 2026-10-30 记录的快照**，原始材料保存在 `research/2026-10-30-macos-agent/raw/`。本轮阶段清理未重新联网核验这些项目或运行候选。

> 本文保留历史调研与方案建议，不是当前运行指令。阶段与执行范围见 [工作区约定](<../../AGENTS.md>)；能力现状见 [macOS 候选](<../../技术候选/macOS完全控制.md>)。

面向场景：宿主是 `/Applications/DeepSeek Harness.app`（macOS 26.6.2 Tahoe），agent 通过宿主派生的 bash 子进程执行命令；理想状态 = 一次性给宿主 app 授权「屏幕录制 + 辅助功能」→ 子进程继承权限 → agent 完全自主（截屏、移动鼠标、点击、打字、读 UI 树、甚至自己点权限弹窗）。

---

## 0. 先回答最关键的问题：子进程能不能继承宿主 app 的 TCC 权限？

**能，这正是 macOS TCC 的"责任进程（responsible process）"模型**：权限检查时，系统把子进程（bash → python/swift CLI）归因到启动它的 GUI 宿主 app。宿主 app 被授权后，它派生的命令行工具调用 CGWindowList 截屏、AXUIElement 读写、CGEvent 注入时，以宿主 app 的授权为准。这一点 Apple 没有一页式官方文档，但生产级项目有明确佐证：

- **Peekaboo 权限文档**（https://github.com/openclaw/Peekaboo/blob/main/docs/permissions.md）直接写了这种场景的处理："This is useful for **app-launched subprocess runners where the parent process has TCC grants** but the selected host does not. … For SSH, LaunchAgent, Codex, and other background launchd sessions, prefer the Bridge path even when TCC appears granted; CoreGraphics can otherwise report success while returning only the desktop wallpaper or a redacted image."（Peekaboo 提供了 `--no-remote` 本地回退来利用父进程权限，也有 `peekaboo permissions status` 的 `Source:` 行显示当前归因到哪个宿主。）
- **对宿主工程的三个硬性推论**（均出自上述文档与 Cua 文档）：
  1. **签名身份必须稳定**：TCC 按 code signing 身份识别客户端。Peekaboo 3.9.6 只是把签名团队从 Peter Steinberger 换成 OpenClaw Foundation，所有用户就被要求重新授权。宿主 app 必须用固定的 Developer ID 签名，ad-hoc/本地重签会丢授权。
  2. **权限归因要验证而非假设**：CLI 在宿主下跑时先跑一次 `peekaboo permissions status --all-sources` 之类的自检（`Source:` 行会写明是宿主还是 Bridge），防止"看似授权、实际截到只有壁纸"的静默失败。
  3. **macOS 26/27 的权限面在变大**：Peekaboo 文档显示 macOS 15/26 上 Accessibility 行仍在 Privacy & Security 下；后台键盘输入需要新的 **Event Synthesizing** 授权（macOS 27 的请求弹窗叫 "Device Control and Data Access (Events)"）。 Tahoe 26.6.2 上做后台打字要预留这个第三授权。

---

## 1. 逐项核实（用户指定的 9 个项目）

### 1.1 trycua/cua — ⭐ 31,354｜2025-01 创建，今天（2026-10-30）仍在推送｜MIT｜极度活跃
- URL：https://github.com/trycua/cua （官网 https://cua.ai ）
- **现状与定位**：定位已升级为 "Computer-Use 2.0" 基础设施：**Cua Driver**（桌面自动化驱动，Rust/Swift）、Cua Spaces（给 agent 的完整桌面）、Lume（本地 macOS/Windows VM）、CUA-S1 决策模型、CUA Bench 评测。仓库 12,000+ 文件，重大 pivot 中。
- **控制方式**：driver 以守护进程形式跑，CLI/MCP/SDK/daemon 每次调用都过同一授权层；工具包括 observe windows、click、type、scroll、drag、浏览器隔离等（见权限文档中的工具清单）。
- **macOS TCC 处理（特色，值得重点借鉴）**：
  - 权限文档：https://github.com/trycua/cua/blob/main/docs/content/docs/cua-driver/guides/permissions.mdx
  - 三档权限模式：`standard`（本地 CLI/MCP 免提示跑观察+输入）/ `bounded`（无人值守：能力清单 YAML，越界即拒）/ `unrestricted`（须同时显式给 `--dangerously-bypass-approvals`，否则拒绝启动）。另有 YAML/Rego 策略文件与能力清单（deny-by-default、可带过期时间/idle 超时）。
  - 内部设计文档 https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/driver-permission-modes-and-consent-plan.md 明确区分 "OS permission（TCC、Accessibility、Screen Recording）" 与自家 consent 层；源码里有 `permissions/gate.rs`、`panel.rs`（启动时做 TCC gate、可打open 系统设置面板）、`--no-permissions-gate` 开关。
  - **硬性安全不变量**：standard 模式下 "**raise an OS permission prompt from a tool → Deny**"（工具不允许触发/点系统权限弹窗）；agent 操作 Cua 自己的同意 UI 是硬拒绝。宿主嵌入可用 `DriverAuthorizationHost` 回调接管剩余边界决策。
- **对我们的启发**：最适合抄的是它的**分层授权架构**（模式 + 能力清单 + 策略文件 + 宿主回调），以及"agent 不可自我提权"的边界设计。缺点：体量大、复杂度高；其 consent 层对"完全自主"有额外摩擦（unrestricted 要显式双开关）。

### 1.2 steipete/Peekaboo → 已迁移 openclaw/Peekaboo — ⭐ 5,415｜今天仍在推送｜v4.9.7｜MIT｜极度活跃
- URL：https://github.com/openclaw/Peekaboo （旧地址 steipete/Peekaboo 301 重定向；官网 http://www.peekaboo.boo ）
- **现状与定位**："Mac automation that sees the screen and does the clicks." macOS 15+ 的 CLI + 菜单栏 app：截屏（CGWindow）、**无障碍树检查**、原生 UI 自动化、自带 agent 和 **MCP server**（npm 包 `@steipete/peekaboo`，`npx -y @steipete/peekaboo`）。注意 3.9.6 起由 OpenClaw Foundation Developer ID 签名（从个人团队迁出，说明项目被捐赠/交接给基金会）。
- **控制方式**：视觉 + 结构双通道——`peekaboo see --app Finder --json` 返回**带不透明元素 ID 的结构化 UI 映射**+标注截图；动作命令 `click / type / press / scroll / drag / set-value / action`，还有 `app / window / menu / menubar / dock / dialog / space`。**语义目标优先（后台投递，不抢焦点），必要时才坐标/前台输入（要显式 `--allow-foreground`/`--foreground` 同意）**。
- **macOS TCC 处理**（最详细，见第 0 节引用的 permissions.md）：
  - 必需：Screen Recording + Accessibility；可选第三项 **Event Synthesizing**（后台键盘、WebKit 精确滚轮等），有 `peekaboo permissions request screen-recording` / `request event-synthesizing` 可编程触发系统弹窗；`permissions status / status --all-sources / grant` 做自检与指引。
  - **Bridge/daemon 架构**：授权归因到"实际执行捕获/输入的宿主进程"（Peekaboo.app 或常驻 daemon），明确文档化"app-launched subprocess runners where the parent process has TCC grants"的场景，并给出 `--no-remote` 本地回退。**不要求 Apple Events Automation 权限**。
  - 明确要求 macOS 15+；粘贴板读取有独立的 caller-local 策略（Bridge 的授权不自动给 CLI 读剪贴板的权限——归因隔离做得很细）。
- **对我们的启发**：**这就是"授权一次 → 子进程完全自主"的现成生产级实现**，且 MCP 形态可直接挂进宿主。最值得抄：`permissions status` 自检命令、语义目标优先 + 显式前台同意的输入分级、Bridge 与本地回退的归因检查。

### 1.3 OthersideAI/self-operating-computer — ⭐ 10,296｜2026-10-19 仍有推送｜MIT｜半活跃
- URL：https://github.com/OthersideAI/self-operating-computer
- **做什么**：多模态模型操作电脑的框架，截图→模型给坐标→动作执行。topics：`automation, openai, pyautogui`。
- **控制方式**：**纯视觉 + 像素坐标（pyautogui）**，无 AX 树。
- **macOS TCC 处理**：README 明确是**人工一次性授权**："Give Terminal app the required permissions … 'Screen Recording' and 'Accessibility'"——授权对象是终端 app 而非项目自身，没有自动/半自动方案，也没有子进程继承的讨论。
- **对我们的启发**：反面教材价值：视觉+坐标路线在没有 AX 树辅助时可靠性差；授权挂在 Terminal 上也不符合宿主 app 场景。

### 1.4 openinterpreter/open-interpreter（--os 模式）— ⭐ 68,739｜2026-10-11 仍有推送｜极活跃但已转型
- URL：https://github.com/openinterpreter/open-interpreter （301 重定向到 openinterpreter/openinterpreter）
- **现状**：当前 README 自述为 "A coding agent for open models like Kimi K3 and GLM 5.3"（支持 exec、MCP、skills、hooks、AGENTS.md）——**已 pivot 成编码 agent，--os 模式在当前主线中已不存在**。
- **--os 模式的历史证据**：v0.2.6 README（https://github.com/openinterpreter/openinterpreter/blob/v0.2.6/README.md ）原文："**The New Computer Update** introduced `--os` and a new Computer API"。当时模式 = 本机 pyautogui 鼠标键盘控制 + 截图视觉循环，README（2024 版）要求给 Terminal 授 Screen Recording + Accessibility。
- **对我们的启发**：注意项目漂移风险——star 高 ≠ 现在还能用；引用方案时要 pin 版本。

### 1.5 OpenAdaptAI/OpenAdapt — ⭐ 1,854｜今天仍有推送｜MIT｜活跃但定位变了
- URL：https://github.com/OpenAdaptAI/OpenAdapt （官网 https://openadapt.ai ）
- **现状**：从"RPA 模仿学习"pivot 成 **"demonstration compiler"**：人/agent 示范一次 → 编译成本地确定性回放程序，**零模型调用**，逐步做效果校验（effect verification）、保存前检查、不匹配即停。monorepo 拆包（engine/desktop/privacy/MCP…）。
- **控制方式**：按可靠性分层取用："page structure (DOM, Windows UI Automation, **macOS Accessibility**, Linux …) → direct API → pixels only for remote desktops"；README 的测试表写明 macOS apps = "The screen, plus Accessibility"。
- **macOS TCC 处理**：文档未见自动授权方案（传统上要求给终端/Python 手动授权）。它的亮点不在授权而在**录制→结构化→确定性回放**的流水线。
- **对我们的启发**：把"成功执行的轨迹"编译成可回放+可校验的脚本，是 agent 自主性落地的另一极：少幻觉、可审计。适合吸收为宿主里的"任务固化"层。

### 1.6 block/goose → 已迁移 aaif-goose/goose — ⭐ 55,967｜今天仍在推送｜活跃
- URL：https://github.com/block/goose （301 重定向到 aaif-goose/goose；项目已从 Block 移交给 aaif 基金会组织，主页 goose-docs.ai）
- **computer-controller / desktop-use 扩展现状**（关键更新）：**2026-04 起内置的 Computer Controller 扩展已整体重写为基于 Peekaboo CLI**。
  - 文档：https://github.com/aaif-goose/goose/blob/main/documentation/docs/mcp/computer-controller-mcp.md （"macOS UI automation via the Peekaboo CLI"，内置扩展，桌面端一键装）
  - 博客：https://github.com/aaif-goose/goose/blob/main/documentation/blog/2026-04-29-computer-controller-peekaboo/index.md ——"see → click → type" 循环：标注截图给元素 ID（B1/T1…），**按 ID 点击而非像素坐标**；可操作菜单、菜单栏、对话框（Peekaboo 的 `menu/menubar/dialog` 命令）。
- **控制方式**：goose（agent 外壳）+ Peekaboo（视觉+AX 双通道执行）。goose 自身另有完整的工具审批体系（crates/goose/src/permission/ 下有 permission_judge、permission_store 等）。
- **macOS TCC 处理**：转嫁给 Peekaboo（见 1.2）；goose 桌面版自身负责权限引导。
- **对我们的启发**：**权威背书了"agent harness + Peekaboo 执行层"的组合**——和 DeepSeek Harness.app 的形态（宿主 app + bash 调 CLI）完全同构。可直接抄它的扩展划分方式：把"控制层"做成宿主可装卸的内置扩展。

### 1.7 simular-ai/Agent-S — ⭐ 12,829｜2026-10-24 仍有推送｜Apache-2.0｜活跃（研究线）
- URL：https://github.com/simular-ai/Agent-S （官网 simular.ai；2026-10-20 发布 Agent S4，arXiv 2610.28601；S3 是首个 OSWorld 超人类的开源 agent 72.60%）
- **是否支持 macOS**：**支持**（README 明确 Windows/macOS/Linux 徽章与三平台说明）。
- **控制方式**：`gui-agents` 包：截图 + **pyautogui** 执行 + 自研 grounding/规划（S3 README 的示例代码就是 `pyautogui.screenshot()`）；强调 Agent-Computer Interface、ACI 进化（S4：agent 自己进化工具接口）。
- **macOS TCC 处理**：S3 README 原话："**System Permissions: The agent runs with the same permissions as the user executing it**"——即需要给运行它的终端/宿主授权 Accessibility + Screen Recording，无自动方案。
- **对我们的启发**：其**经验式 ACI 自进化**思路值得跟踪；执行层本身（pyautogui）对我们没加分，反而是 Peekaboo 类 AX-first 方案更强。生产路线他们已商业化成 Simular API/云端 Sai。

### 1.8 OpenCUA — 实际仓库 xlang-ai/OpenCUA — ⭐ 872｜2026-05-25 最后推送｜NeurIPS 2025 Spotlight｜研究线，趋缓
- URL：https://github.com/xlang-ai/OpenCUA （**用户给的 OpenCUA/OpenCUA 不存在（404）**；官网 https://opencua.xlang.ai ）
- **做什么**：三件套——**AgentNet** 轨迹数据集（22.6K 条人工示范，覆盖 Windows/macOS/Ubuntu）、**AgentNetTool** 跨平台录制器（同步采集屏幕视频 + 鼠标键盘事件 + **无障碍树**，Windows/macOS/Ubuntu 可用）、训练/评测代码（OpenCUA-72B 在 OSWorld-Verified 45.0%）+ AgentNetBench 离线评测器。
- **控制方式**：数据管线把原始信号压缩成 **PyAutoGUI 动作**（"collapsing mouse moves → click …"）——训练用 pyautogui 风格动作空间。
- **macOS TCC 处理**：不适用——它是给标注者用的录制工具（录制器本身需要目标机器授权，未提供自动方案）+ 研究训练框架，不是给宿主 agent 用的控制层。
- **对我们的启发**：想训练自己的决策/grounding 模型时，它的数据集与动作空间设计可直接复用。

### 1.9 Hammerspoon + hs.ipc — ⭐ 16,349｜2026-07-08 推送｜老牌稳定
- URL：https://github.com/Hammerspoon/hammerspoon （官网 hammerspoon.org）
- **被用作 AI 控制层的证据**：
  - **mobabur94/hammerspoon-mcp**（⭐ 2，2026-08 推送）：MCP server 把 Hammerspoon 的 macOS 自动化 API 暴露给 AI agent——75 个工具：窗口、Spaces、剪贴板、电源/bluetooth/battery/USB 等；对比表自称支持 "Virtual desktop (Spaces) control ✅"、"Arbitrary OS scripting ✅ (Lua)"、AX 树经 `hs_eval`。URL：https://github.com/mobabur94/hammerspoon-mcp
  - **ochen1/chrome-devtools-mcp-auto-allow-macos**（⭐ 3）：**用 Hammerspoon + Accessibility 自动点 Chrome "remote debugging approval" 弹窗的 Allow 按钮**——"It does not disable Chrome's permission prompt; it watches for the dialog and presses the visible `Allow` button"。URL：https://github.com/ochen1/chrome-devtools-mcp-auto-allow-macos ——这是"agent 自己点权限弹窗"的现成最小先例。
  - 社区还有若干 hamerspoon×AI 的 dictation/voice 类小项目。
- **hs.ipc 机制**（https://www.hammerspoon.org/docs/hs.ipc.html ）：`hs.ipc.cliInstall()` 安装 `hs` CLI，把 Lua 代码发给常驻的 Hammerspoon.app 执行。
- **TCC 关键点**：**Lua 在 Hammerspoon.app 进程内执行 → TCC 归因到 Hammerspoon**，这正好是"宿主 app 持权限、子进程借道"的模式（把 Hammerspoon 换成你自己的宿主 app 同理）。注意 mobabur94 的 README 仍写 "Accessibility → add your terminal"，说明不同实现的归因处理不一，要实测。
- **对我们的启发**：① `hs` CLI 是"子进程 → 常驻特权 app"IPC 的极简范本（本地 socket/消息端口）；② Hammerspoon 能补 Peekaboo 的空缺：**Spaces 虚拟桌面、窗口管理、系统级 Lua 脚本**；③ 它**没有屏幕录制能力**，截屏还得靠宿主/Peekaboo。

---

## 2. MCP 服务器专题（"macos mcp server" / "apple mcp" / "peekaboo mcp"）

GitHub 站内搜索（2026-10-30，按 star 排序）核实：

| 项目 | ⭐ | 活跃度 | 能控制 macOS GUI？ | 说明 |
|---|---|---|---|---|
| **Peekaboo 内置 MCP**（openclaw/Peekaboo）| 5,415 | 活跃 | ✅ 最强 | `npx -y @steipete/peekaboo`（Node 22+），see/click/type/menu/dialog 全套；文档 https://github.com/openclaw/Peekaboo/blob/main/docs/MCP.md |
| **supermemoryai/apple-mcp** | 3,114 | 2025-08 后停更 | ❌（只做数据） | Apple 原生应用数据工具（Notes/Mail/Messages/Reminders 等），**不做 UI 控制** |
| **mediar-ai/mcp-server-macos-use** | 357 | 2026-09 推送 | ✅ | Swift MCP + MacosUseSDK：AX 树遍历 + 坐标点击/打字/按键，按 PID 定位（screenpipe 团队） |
| **baryhuang/mcp-remote-macos-use** | 490 | 2025-06 后停更 | ✅ | 远程 macOS-use MCP |
| **mobabur94/hammerspoon-mcp** | 2 | 2026-08 推送 | ✅（广度大） | 75 工具（窗口/Spaces/系统控制），但项目很小 |
| **AmrDab/clawdcursor** | 406 | 今天推送 | ✅ | 本地 MCP："safe desktop control on Windows, macOS and Linux"，读 UI 树 |
| **QwenLM/open-computer-use** | 299 | 2026-06 推送 | ✅ | MCP 形态 computer-use 服务（Qwen Code 生态） |
| **getsentry/MobileBuildMCP** | 6,525 | 活跃 | ❌ | iOS 构建辅助，非桌面控制 |

（另有 goose 内置 computercontroller 扩展，见 1.6；Cua Driver 也提供 MCP 入口 `cua-driver mcp`。）

**结论**：MCP 生态里**能真正控制 macOS UI 的最佳选择就是 Peekaboo 的 MCP**，其次 mediar-ai/mcp-server-macos-use；"apple mcp" 这类名字接近的项目多为应用数据操作而非 GUI 控制。

---

## 3. 2025–2026 新项目（"macos computer use agent" / "macos-use" 方向）

按与本需求贴合度排序（star 为 2026-10-30 实测）：

1. **browser-use/macos-harness** — ⭐ 973｜2026-10-23 推送｜实验期但非常活跃｜**最贴合需求**。URL：https://github.com/browser-use/macos-harness
   - 定位原话："The simplest, thinnest harness that gives an LLM **complete freedom** to control a Mac"，"Give any coding agent the apps on your Mac. **One shell command per step.**"
   - 控制方式：**11 个 CLI 工具**（get_app_state / click / type_text / press_key / set_value / scroll / drag / paste / select_text / perform_secondary_action / list_apps）。`get_app_state` 把窗口输出为**带编号的文本行**+截图路径；动作**AX action 优先，否则向目标 app 自己的进程发事件**——"your pointer does not move and your front app stays in front"（后台控制！）。首次调用自动起一个 helper 守护进程（本地 socket）。
   - TCC 处理：`macos-harness doctor` 自检 **Accessibility + Screen Recording（归属于"启动 harness 的那个 app"——即宿主）**+两个可选授权；缺权限时主动打开 System Settings（半自动引导）。默认全放行，仅排除宿主自身与系统密码弹窗；`policy.toml` 可收紧（ask_before_first_use / strict / blocked_urls）。
   - 启发：**这就是 DeepSeek Harness.app 该有的控制层蓝本**——细 CLI + AX-first 后台操作 + doctor 自检 + policy 文件。
2. **amontlabs/lcu** — ⭐ 2,323｜今天推送。URL：https://github.com/amontlabs/lcu
   - "Codex computer use, decoupled from the app, for usage inside any harness"：把 ChatGPT/Codex 桌面版的 computer-use 能力解耦给任意 harness；**per-app 审批**（每台 app 粒度决定 agent 能否触碰，任何权限模式下都生效）；`lcu setup --approval auto` 为无人值守机器（VM/CI）预放行；权限层面依赖已签名的宿主 app（"The signed ChatGPT app, with Accessibility and screen-recording permissions approved during first use"）。
   - 启发：**per-app 审批 + approval mode 分级**（自动/每次询问）是宿主里值得实现的策略面。
3. **vercel-labs/agent-desktop** — ⭐ 1,833｜今天推送。URL：https://github.com/vercel-labs/agent-desktop
   - Rust 实现的 AX 树 computer use："read and operate desktop apps through the OS accessibility tree"；**headless 默认**：ref 动作走 AX API，**不移动指针、不抢焦点**；macOS 上"CLI calls reuse a private command host for each snapshot namespace"（常驻特权宿主进程模式），`agent-desktop permissions --guide` 给权限指引。注意其 headless 调用**禁止前台激活与合成输入**——纯 AX 操作，不走 CGEvent。
   - 启发：AX-only 后台路线的安全版；与企业/desktop 场景契合；但需要真正模拟鼠标/键盘时不够用。
4. **ghostwright/ghost-os** — ⭐ 1,681｜2026-03 后趋缓。URL：https://github.com/ghostwright/ghost-os
   - 亮点："**No screenshots required**"：观察 = **CGEvent tap + AX 树**（记录人类示范→合成可参数化回放 recipe，自学习工作流）；AX 不够时本地 VLM（ShowUI-2B）兜底。权限：**Input Monitoring**（CGEvent tap 所需）+ Accessibility，`ghost setup` 一键配置权限/MCP/模型。
   - 启发：示范→回放的自学习路线 + Input Monitoring 这个第三授权的提示；我们做"agent 观察人类操作并固化"时可参考。
5. **browser-use/macOS-use（mlx-use）** — ⭐ 1,999｜**2025-03 后停更（约 20 个月）**。URL：https://github.com/browser-use/macOS-use
   - "Make Mac apps accessible for AI agents"（browser-use 团队早期 macOS 项目，pip 包 `mlx-use`）。基本可判定已被自家的 macos-harness 接棒。⭐ 高但别选它。
6. 其他活跃候选：**ComputerUseAgent/AutoCua**（⭐ 933，今天推送，macOS/Windows/Linux/浏览器/移动端 CUA）、**iFurySt/open-computer-use**（⭐ 2,781，今天推送，"Open-Source Alternative to Codex Computer Use"）、**injaneity/pi-computer-use**（⭐ 2,111）、**AmberSahdev/Open-Interface**（⭐ 2,729，LLM 控电脑）、**skalesapp/skales**（⭐ 2,221，个人 agent harness）。
7. **franzenzenhofer/big-arrow-on-the-screen**（⭐ 826）：agent 在屏幕上画箭头/框的 CLI——agent↔人视觉沟通层，小而有用。

---

## 4. 对比小结：谁最接近「授权一次录屏+无障碍 → agent 完全自主」

| 排名 | 项目 | 自主闭环完整度 | 缺口 |
|---|---|---|---|
| 1 | **Peekaboo（openclaw）** | 生产级。录屏+AX 全覆盖，CLI+MCP+daemon，权限自检/请求命令齐全 | 需 macOS 15+；后台键盘要多授 **Event Synthesizing**；Bridge 归因需要 `permissions status` 验证；重签名/升级可能触发重新授权；前台输入默认要显式同意 |
| 2 | **browser-use/macos-harness** | 形态最贴合宿主+bash：细 CLI、AX-first 后台操作、doctor 自检、policy.toml | 自称 Experimental；无自带 planner（靠宿主 agent）；单次调用有 10 次点击/2 万字符上限；生态比 Peekaboo 小 |
| 3 | **Cua Driver（trycua）** | 工程化最强：权限模式+能力清单+策略+宿主回调，明确支持嵌入宿主 app | 重；自家 consent 层与"完全自主"有摩擦（unrestricted 需双开关）；TCC gate 细节埋在源码里 |
| 4 | **goose + computer-controller** | 证明 harness+Peekaboo 组合可行（2026-04 起） | 绑定 goose 外壳；权限转嫁给 Peekaboo，自身无 TCC 创新 |
| 5 | **vercel agent-desktop / mediar macos-use MCP / hammerspoon 组合** | AX-only 后台控制 + 常驻特权宿主进程模式，安全面好 | AX-only：无法真正"移动鼠标/全局键盘"；hammerspoon 生态项目都太小 |
| 6 | **self-operating-computer / open-interpreter --os / Agent-S / AutoCua 等 pyautogui 系** | 有自主循环，但执行层老旧 | 前台+像素坐标，脆弱；授权挂 Terminal，无继承设计；OI 已转型、SOC 半停滞 |
| 7 | **OpenCUA / OpenAdapt** | 不是控制层（数据集/录制回放编译器） | 只能当训练数据来源（OpenCUA）或任务固化层（OpenAdapt） |

**"agent 自己点权限弹窗上的允许"**：技术上成立——Accessibility 已授权后，AX 树扫描对话框并点 Allow 即可，现成先例是 `ochen1/chrome-devtools-mcp-auto-allow-macos`（Hammerspoon 扫 AX 树按 Allow）。但成熟项目都刻意设界：**Cua 把"工具触发 OS 权限弹窗"列为 Deny、把 agent 触碰自家同意 UI 列为硬拒绝；macos-harness 默认排除系统密码弹窗**。建议宿主采取折中：允许 agent 处理**自身功能所需的 TCC 弹窗**（录屏/辅助功能这类一次性行），但硬编码排除密码/安全密钥类系统 sheet，并做日志审计。

### 给 DeepSeek Harness.app 的落地建议（综合各项目）
1. **执行层直接采用或借鉴 Peekaboo / macos-harness**（都 MIT、都是"宿主持权限 + bash 调 CLI"形态）。宿主进程常驻（或 helper daemon）持有 TCC，子进程只发 IPC 命令——Peekaboo daemon、macos-harness helper、agent-desktop command host、cua-driver 四家全部收敛到这个架构。
2. **签名策略**：宿主 app 用固定 Developer ID，任何重签/更新后跑一次权限自检；首次运行引导用户授录屏+辅助功能（+Tahoe 上的 Event Synthesizing，如需后台打字）。
3. **自检优先**：每次会话开始跑 `permissions status` 类自检（Peekaboo 的 `Source:` 行验证归因），防"截到壁纸"式静默失败；SSH/launchd 等非 Aqua 会话一律走 Bridge。
4. **策略面**：抄 cua 的模式+能力清单（bounded：允许的工具+可触碰的 app 白名单）+ macos-harness 的 policy.toml（排除密码 sheet、blocked_urls）+ lcu 的 per-app 审批与 auto 模式。
5. **能力补全**：AX/CGEvent 之外，用 Hammerspoon（hs.ipc 模式）补 Spaces/窗口管理/系统控制，用 OpenAdapt 思路做"示范→确定性回放"固化，用 OpenCUA 数据训练自家 grounding 可以后置。

---
### 主要来源（均为本次实抓）
- GitHub API 元数据（star/活跃度，2026-10-30）：api.github.com/repos/{trycua/cua, openclaw/Peekaboo, OthersideAI/self-operating-computer, openinterpreter/openinterpreter, OpenAdaptAI/OpenAdapt, aaif-goose/goose, simular-ai/Agent-S, xlang-ai/OpenCUA, Hammerspoon/hammerspoon, browser-use/macos-harness, …}
- Peekaboo 权限文档：https://github.com/openclaw/Peekaboo/blob/main/docs/permissions.md ；README：https://github.com/openclaw/Peekaboo/blob/main/README.md
- Cua 权限文档：https://github.com/trycua/cua/blob/main/docs/content/docs/cua-driver/guides/permissions.mdx ；consent 设计：https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/driver-permission-modes-and-consent-plan.md
- goose computer-controller：https://github.com/aaif-goose/goose/blob/main/documentation/docs/mcp/computer-controller-mcp.md ；博客：https://github.com/aaif-goose/goose/blob/main/documentation/blog/2026-04-29-computer-controller-peekaboo/index.md
- Agent-S3 README：https://github.com/simular-ai/Agent-S/blob/main/gui_agents/s3/README.md ；OpenCUA README：https://github.com/xlang-ai/OpenCUA/blob/main/README.md
- hs.ipc 文档：https://www.hammerspoon.org/docs/hs.ipc.html ；hammerspoon-mcp：https://github.com/mobabur94/hammerspoon-mcp ；auto-allow：https://github.com/ochen1/chrome-devtools-mcp-auto-allow-macos
- macos-harness：https://github.com/browser-use/macos-harness ；macOS-use：https://github.com/browser-use/macOS-use ；lcu：https://github.com/amontlabs/lcu ；agent-desktop：https://github.com/vercel-labs/agent-desktop ；ghost-os：https://github.com/ghostwright/ghost-os ；mediar MCP：https://github.com/mediar-ai/mcp-server-macos-use ；apple-mcp：https://github.com/supermemoryai/apple-mcp
- open-interpreter --os 历史证据：https://github.com/openinterpreter/openinterpreter/blob/v0.2.6/README.md ；SOC README：https://github.com/OthersideAI/self-operating-computer#readme
- 原始抓取件：`research/2026-10-30-macos-agent/raw/`（各 README、permissions.mdx、consent plan、goose 文档、hsipc.html、仓库树 JSON 等）
