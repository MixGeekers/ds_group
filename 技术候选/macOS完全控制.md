# macOS 完全控制与权限自助

> 2026-11-01 复用复核：补查DSH自带MCP/SSH、browser-use与macOS CUA后，优先验证宿主现成接入；Peekaboo/Windows-MCP/Appium/ROS按局部能力直接使用，不要求全机自研客户端。固定API、许可、依赖及回退见[设备复用核查](<../research/2026-11-01-复用核查/设备.md>)。本轮未复制源码、安装或运行；历史最高权限/常驻整套平台建议不代表当前授权。
[返回技术候选目录](<目录.md>)

- **类型**:调研 / 点子(多项目综合候选)
- **方向**:感知与行动——全机操控能力、TCC 权限自助
- **来源**:既有记录中的“授权一次后完整操控 Mac”需求与项目/TCC 调研，原始材料见 [research/2026-10-30-macos-agent/](<../research/2026-10-30-macos-agent/>)
- **记录日期**:2026-10-30(America/Caracas)
- **当前状态**:已初评；保留历史实验记载，本轮未开展实验或复验，未正式接入识雨运行系统。
- **阶段说明**:项目已于 2026-11-01 开始实现，见[工作区约定](<../AGENTS.md>)。此前仅设计阶段清理时，旧运行规程已移除、旧操作日志已归档；本候选仍未正式接入，设备控制按具体任务与授权范围实施，历史规程不作为当前执行指令。

## 1. 需求与问题

原探索以 DeepSeek Harness.app 为宿主背景。目标是研究：在用户指定的设备与任务范围内，如何实现截屏、读屏、点击、打字、操作系统弹窗与访问文件等完整控制能力，并减少重复授权。宿主上的历史实验不等于识雨已经具备正式运行系统，也不自动适用于当前 Codex 宿主。

## 2. 历史实验记载

旧文档记录的环境为 2026-10-30、macOS 26.6.2、DSH 宿主。本轮只读取历史资料，没有重跑实验、读取 TCC 数据库或修改系统设置。记录来源见 [旧操作日志与说明](<../测试/归档/2026-10-30-macos-permissions/说明.md>)、[TCC 调研报告](<../research/2026-10-30-macos-agent/tcc-权限自助-调研报告.md>)；原始实验材料并不完整，不能把所有记载当作本轮独立验证。

| 项目 | 旧资料记载 | 证据边界 |
|---|---|---|
| 截屏、AX 读取、受保护目录读取 | 宿主授权后可用 | 原宿主与当时环境，不推定当前状态 |
| Peekaboo 权限自检 | 曾经 npx 下载并显示 Granted | 不等于 GUI 动作、MCP 接入或长期安装已验证 |
| 前台键入与后台 AX 改值 | 记载成功 | 仅限原实验范围 |
| 后台 PID 键事件注入 | 记载系统丢弃 | 不能用前台成功推断后台成功 |
| AppleEvents 权限弹窗 | 记载自动点击并落库 | 不推广为所有权限、认证弹窗均通过 |
| replayd 录屏提醒 | 日志先记载只读检查，后记载日期改为 3024 | 本轮未核实当前状态，也未回滚；工作区清理不等于系统恢复 |

## 3. 既有调研中的机制判断

以下保留旧 [TCC 调研报告](<../research/2026-10-30-macos-agent/tcc-权限自助-调研报告.md>) 的判断与限制，本轮没有重新验证其时效性；它们是后续比较和实验的输入，不是执行规程。

- **继承**:子进程默认继承宿主 TCC 授权(XNU responsible process 机制);反例警示:LaunchAgent / `exec` 包装会让归因漂移到未授权的二进制(openclaw#14138 案例)。
- **授权主体是签名身份**:TCC 用 csreq BLOB 绑定代码签名,宿主 app 更新/重签名可能需要重新授权(Peekaboo 换签名团队后全员重授的先例)。
- **三道墙(设计上不可自助逾越)**:① 系统级 TCC.db 受 SIP 保护,root 也不能改;② PPPC 静默预授权必须 user-approved MDM,且**录屏在 PPPC 中 deny-only(只能拒不能授)**;③ 现成改库工具(tccplus 等)都要求关 SIP+AMFI,且多已停维护。
- **自助空间(授权一次之后)**:继承授权 + UI 脚本点击权限弹窗按钮(需从另一进程发起,"app 不能 GUI script 自己")+ 持 FDA 写用户级 TCC.db(Ventura 实证,Tahoe 待复验)+ 自消每月录屏提醒(改 replayd 的 ScreenCaptureApprovals.plist)+ `tccutil reset` 撤销。
- **未实证的一环**:旧报告对新版录屏授权弹窗及系统设置切换链路仍有疑问，需要另行规划验证。

## 4. 候选项目（⭐ 与项目判断为 2026-10-30 旧调研快照）

### 第一梯队:最贴合"一次授权→完全自主"

| 项目 | ⭐ | 判断 |
|---|---|---|
| [openclaw/Peekaboo](https://github.com/openclaw/Peekaboo)(原 steipete/Peekaboo) | 5.4k | **生产级现成实现**:截图+AX 树+点击/打字/菜单/dialog,`permissions status/request/grant` 自检与请求;明确支持"宿主持权、子进程借道"(Bridge/daemon);goose 官方执行层。macOS 15+ |
| [browser-use/macos-harness](https://github.com/browser-use/macos-harness) | 973 | **形态最贴合**:11 个细粒度 CLI(`get_app_state`/`click`/`type_text`…),AX 优先后台控制不动指针;`doctor` 权限自检;policy.toml 默认放行、排除密码 sheet。Experimental |

### 第二梯队:架构借鉴

| 项目 | ⭐ | 借鉴点 |
|---|---|---|
| [trycua/cua](https://github.com/trycua/cua) | 31.4k | 权限三模式(standard/bounded/unrestricted)+能力清单+策略引擎;其"工具触发 OS 权限弹窗=Deny"的边界设计值得抄 |
| [aaif-goose/goose](https://github.com/aaif-goose/goose)(原 block/goose) | 56k | 2026-04 起 Computer Controller 整体重写为基于 Peekaboo——权威验证了"宿主 harness + Peekaboo 执行层"组合 |
| [Hammerspoon](https://github.com/Hammerspoon/hammerspoon) | 16.3k | hs.ipc 让 Lua 在持权 app 进程内执行,是"借道"模式范本;可补窗口/Spaces/系统控制;[ochen1/chrome-devtools-mcp-auto-allow-macos](https://github.com/ochen1/chrome-devtools-mcp-auto-allow-macos) 是"agent 扫 AX 树自动点 Allow"的最小现成先例 |
| [amontlabs/lcu](https://github.com/amontlabs/lcu) | 2.3k | per-app 审批粒度 + `--approval auto` 无人值守模式 |
| [OpenAdaptAI/OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt) | 1.9k | 成功轨迹→确定性回放固化(演示编译器)思路 |

### 反面教材/不选

- [OthersideAI/self-operating-computer](https://github.com/OthersideAI/self-operating-computer)(10.3k):纯视觉+像素坐标,授权挂 Terminal,无继承设计。
- [openinterpreter/open-interpreter](https://github.com/openinterpreter/open-interpreter)(68.7k):`--os` 模式已从主线移除,star 高≠现在可用;引用须 pin 版本。
- browser-use/macOS-use(2k):停更约 20 个月,已被 macos-harness 接棒。
- xlang-ai/OpenCUA(872)、simular-ai/Agent-S(12.8k):非宿主控制层;前者是训练数据/动作空间来源,后者 "agent runs with the same permissions as the user"、需给终端授权。

## 5. 可借鉴之处与设计选项

2026-11-01 当前优先级：本机 DSH 先验证固定版本的 `cua/cua-macos`，直接复用其独立 `DSH Computer Use.app`、应用授权与撤销、窗口对象、AX/截图和输入；远端Mac或已有Peekaboo安装采用其stdio MCP/CLI。DSH审阅版要求macOS14+，Peekaboo发布版要求macOS15+，两者不能混成相同平台条件。现成接口已经覆盖的授权UI/输入/截图不再重复开发；识雨补充任务授权、设备身份、GUI独占和效果核对。完整版本/许可见顶部复用证据。该独立helper设计也说明旧“必须一直借宿主权限”不是通用前提，应验证所选执行器实际签名和归因。

旧调研建议比较“签名稳定的宿主/helper + 细粒度执行工具”的组织方式；是否需要常驻进程、如何通信和如何处理任务范围，仍待架构设计。

- **系统自带工具路径**：比较 `screencapture`、`osascript` 等原生接口能覆盖哪些功能，以及宿主变化后的限制。
- **第三方执行层路径**：比较 Peekaboo 与 macos-harness 的能力、维护和接入成本，不因列为增强候选就安装。
- **权限与状态路径**：将权限归因、授权请求、凭据来源、操作追溯和撤销作为设计问题，不能把历史实验中的系统修改变成默认运行机制。

## 6. 限制与取舍

- 用户提出的完整设备控制目标继续保留；当前阶段限制的是实施范围，不重新替用户设定产品能力上限。旧规程中的“全权模式常态化运行”已撤下，设计中的目标权限与当前任务的执行权限分开。
- 归因漂移风险:不要把识雨的能力寄托在 LaunchAgent/exec 包装的进程上;保持在宿主直启的子进程内。
- 授权绑签名:宿主 app 升级后需复跑权限自检。
- macOS 27 方向是 declarative management,PPPC 多键 deprecated——长期方案别押注改库。

## 7. 待验证事项

以下是待讨论的实验方向；本轮未执行。若用户要求验证，使用 [测试目录](<../测试/README.md>)，先确定宿主、测试设备、数据与通过条件。

1. 当前目标宿主下，前台输入与后台 AX 操作的可用范围是否与旧记录一致。
2. 区分 AppleEvents、录屏和认证类弹窗，不以某一类成功代表完整链路。
3. 比较官方授权接口与直接改库方案的可维护性、恢复成本及必要性；先做文档与源码核查。
4. Peekaboo GUI 动作与 MCP 接入是否满足需求；旧权限自检不足以证明这一点。
5. 宿主更新、重签名及执行链变化对权限归因和稳定性的影响。

## 8. 决策记录

| 日期 | 事项 | 状态与范围 |
|---|---|---|
| 2026-10-30 | 既有资料记录项目与 TCC 调研，以及原宿主下的权限实验 | 保留为候选与历史证据；不当作本轮实测或正式集成 |
| 2026-10-30 | 旧日志记载权限规程变化与 replayd 日期修改 | 仅保留历史事实线索；本轮未复核或恢复系统设置 |
| 2026-10-30 | 用户重申仍处于架构设计与技术候选阶段，要求清理越界内容 | 移除旧运行规程，归档日志，状态回到已初评；后续实验按新目录与明确任务范围进行 |
