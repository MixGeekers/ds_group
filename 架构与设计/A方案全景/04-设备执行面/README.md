# 设备执行面

[上级](<../README.md>) · [完整目录](<../目录.md>) · [来源与核查](<../../../research/2026-11-01-完整架构/设备执行面.md>)

更新：2026-11-01。区域 ID：`devices`。**本篇为进入验证阶段的建议基线；设备尚未接入，全部数值为验收设计值。**

## 主方案与边界

采用“插件内 DeviceGateway + 成熟传输与执行器 + 必要的端侧效果回执适配”。DeviceGateway 属于识雨插件的能力基础设施，只做登记、授权复核、路由和回执归一；图中单列设备区域用于表达远端执行边界，不要求另建网关服务或独立智能核心。core 仍在 DSH 内，设备端不保存六部分权威状态、不自行重新解释用户授权。

优先复用 DSH 的 POSIX SSH、MCP、browser-use-playwright-mcp/session runtime 与本机 macOS CUA；不足部分限于设备身份映射、能力范围、任务效果账本与版本适配。这些是识雨特有的业务一致性要求，不另造 SSH、VPN、浏览器驱动、桌面控制框架或机器人控制器。

| 层次 | 规划基线 | 引入条件与替代 |
|---|---|---|
| 网络可达 | 已有可信局域网 / 已配置网络；SSH 保留端到端主机认证 | 跨 NAT、多地点时优先 Tailscale 网络与显式 grants；有自托管控制面要求再比较 Headscale，不预先部署两套组网 |
| POSIX 文件与进程 | DSH 固定版本 SSH helper/provider，在独立设备执行上下文中使用 | provider 作用域不能与主 Web profile 安全分离时，使用 OpenSSH 非交互命令调用固定端侧入口；不全局替换主宿主文件系统 |
| 工具协议 | 本机 stdio MCP；远端优先 SSH 启动固定 MCP 入口或隧道访问端侧 loopback 服务 | 直接 HTTP 需 Streamable HTTP、TLS、成熟鉴权及 Origin 检查；tailnet 身份不代替任务授权 |
| 浏览器 / 桌面 | 网页先验证 DSH Playwright provider；本机 macOS 先验证 DSH CUA，远端/既有 Mac 用 Peekaboo；Windows GUI 验证 Windows-MCP | 工具无法满足目标应用才比较通用视觉桌面执行器；不采用工具自带 agent 作为另一识雨 core |
| 机器人 | ROS 2 原生 Action 客户端调用已有高层动作，本地控制器负责运动与停止 | 已有 rosbridge 时复用受限桥；无 ROS 时封装厂商 SDK，不实现运动控制栈 |
| 资产平台 | 起步不引入 MeshCentral、Salt、RMM 中枢 | 超过约 10 台无人值守设备或装机/轮换成本成为主要负担，再量化比较 MeshCentral；旧整套中枢路线保留为扩展备选 |

所查 DSH SSH provider **两端仅 Linux/macOS**，依赖预配置主机别名和已安装 helper，没有自动配对、Windows 端或断线重放；Web workspace 路径仍有本地假设，因此设备上下文与主宿主工作区必须分开。[固定版本说明](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/ssh/ssh/README.md>)

## 支持与验证顺序

| 平台 | 第一轮验证范围 | 后续激活方案 | 不推导的能力 |
|---|---|---|---|
| Linux / macOS | 两个设备替身、带身份的文件读取与进程状态；受控临时写入须经过回执适配 | 固定 helper、最小账号/目录范围；macOS GUI 单独比较 DSH CUA / Peekaboo 权限和窗口绑定 | SSH 可用不等于 GUI、系统权限或后台会话可用 |
| Windows | 相同协议替身和 Windows 路径用例 | Windows OpenSSH + 固定 PowerShell 入口处理文件/进程；Windows-MCP 在交互用户会话处理 GUI | 不复用 POSIX helper，不把 Session 0 服务当作交互桌面 |
| 浏览器 | Playwright 隔离 context 中的合成站点与下载 | 按账号/任务独立 profile，确定性步骤优先脚本，探索操作用受限 MCP | context 不是 OS 沙箱，网页文本不是授权 |
| Android / iOS | 浏览器入口、通知/提交材料等有限交互协议替身 | Android 测试设备用 ADB/Appium；iOS 优先用户触发 Shortcuts，应用自动化用 XCUITest | 不承诺后台全设备控制，不自动启用调试或绕过权限 |
| 机器人 | ROS Action 与本地停止的模拟器/替身 | ROS 2 Jazzy 长期支持基线；真实设备沿用受支持厂商栈 | 协议通过不证明物理安全，模型不维持实时控制 |

## 共同调用链

1. 能力模块维护批准的 `CapabilityDefinition` 与验证记录；Gateway 维护 `DeviceRecord`、端点、实例和健康观测。
2. TaskService 校验 worker 的授权请求、预算、能力版本、deadline 与资源租约，原子记录 Effect/outbox。
3. dispatch 前再次核验设备与授权版本、当前中心/Assignment及资源所有权。持久gate路线另由端侧校验已认证中心、`installationGeneration`、`hostEpoch`、整数 `fencingToken`、有效期与去重键；普通现成工具路线不声称具备这些端侧保证。
4. 成熟工具执行后返回 `DeviceReceipt` 与产物引用；中心核验任务结果，core 决定内部提交，replyer 解释只读结果。
5. 断连后先核对效果。无法证明未执行时保留 `unknown`，不能通过换 worker、设备或 commandId 绕过去重。

## 默认值与所有者

控制租约默认 30 秒、心跳 10 秒、健康 TTL 30 秒；命令有效期不得晚于 Mandate 或 Task deadline。机器人本地停止时限单独实测，不能拿 30 秒控制租约充当运动安全时限。同一桌面或机器人的控制资源只能有一个有效所有者；读取指标可独立并行。

默认离线策略 `stop-and-reconcile`；仅明确允许离线、具有独立截止条件的既有授权任务可继续。撤权在中心下一次 dispatch 必须生效；离线端未收到撤权前不能宣称已停止；持久gate路线用已验证本地短租约限制继续，普通现成工具路线保持unknown并阻止资源改派，停止能力须独立核验。

中心持有注册与摘要回执；大截图/日志/文件进入工作产物区。端侧只保留命令账本与临时产物；临时证据默认 7 天，未核对效果保留至解决，隐私删除及备份保留由数据方案裁决。设备实例状态采用声明支持、当前可用、最近验证分开表示，不能仅因 `tools/list` 仍有工具便判断在线。

## 子模块与验收

- [设备能力接口](<01-设备能力接口/README.md>)：协议、配对、认证、去重、版本、文件传输；V18/V19。
- [桌面设备](<02-桌面设备/README.md>)：POSIX、Windows 和 GUI 资源；V18/V19/V26。
- [其他终端](<03-其他终端/README.md>)：网页、Android、iOS、专用终端；V20/V26。
- [机器人](<04-机器人/README.md>)：Action 适配、本地控制与停止；V20/V26。

第一轮要求：两个替身的同名路径不串机；100 次重复/乱序/旧租约命令不产生额外副作用；丢回执保持 unknown 并能核对；过期/撤销能力不再 dispatch；核心宿主退出后不出现第二个调度中心。纳入 V23 合成端到端；真实 OS/设备的结论仅由 V26 激活记录产生。

## 证据与成熟度

本轮核对固定版本 DSH 与执行器官方说明，以及 MCP、OpenSSH、Playwright、Android、ROS 一手资料；未安装、连接设备或实测。来源支持复用方向，识雨的授权/回执/资源一致性仍需验证。详见[来源与核查](<../../../research/2026-11-01-完整架构/设备执行面.md>)。

## 复用核查后的接入收敛

[2026-11-01复用核查](<../../../research/2026-11-01-复用核查/设备.md>)补齐固定API/源码、许可、运行时与验收。DSH现成能力虽然有experimental标记，也应先验证复用；不重写已有MCP生命周期、每Session浏览器串行、AX/输入与应用授权。DSH Playwright provider固定MCP0.0.80，上一轮审阅的0.0.84仅作为备选，不能视为兼容。

DeviceCommand是插件内部封套，现成工具不必全部实现它。直接工具路线保留中心授权、资源独占、单次派发与未知结果核对；不具备远端持久gate时明确缺少端侧fencing/离线恢复保证，不重放、不改派未知资源。只有要求远端持续/排队/重启续接的能力才补端侧小适配。无整机客户端是接入前提的要求；移动设备可直接使用Appium会话，机器人直接使用rclpy ActionClient。本轮复制源码0、安装/运行0。
