# 桌面设备

[所属区域](<../README.md>) · [设备协议](<../01-设备能力接口/README.md>) · [来源](<../../../../research/2026-11-01-完整架构/设备执行面.md>)

更新：2026-11-01。模块 ID：`desktop-device`。状态：建议基线，未安装或实测。

## 主方案与平台分工

文件、结构化 API 和命令行优先于 GUI；GUI 用于没有稳定结构化入口的任务。接口报告实际能力，不提供“该设备拥有完全控制”的笼统承诺。

| 平台 / 工作 | 复用基线 | 条件与降级 |
|---|---|---|
| Linux/macOS 文件、进程 | DSH SSH family + 系统 OpenSSH，每设备独立执行上下文 | provider要求POSIX两端、固定helper、严格host key；作用域不能分离时用OpenSSH固定入口，主DSH profile保持本地 |
| 本机 macOS 原生 GUI | 先验证 DSH cua/cua-macos 的应用/窗口对象、AX/截图/输入、应用许可与撤销；远端或既有安装使用 Peekaboo CLI/MCP | DSH审阅版macOS14+、独立签名helper持有TCC；Peekaboo发布版macOS15+、npm Node22+；缺权限报告blocked，不自动改TCC |
| Windows 文件、进程 | Windows OpenSSH + 固定PowerShell非交互入口 | 不复用POSIX helper；账号、盘符、编码和路径约束单独验证 |
| Windows GUI | Windows-MCP工具层，经受控代理路由到已登录交互用户会话 | 审阅版Windows10/11、Python3.14+；锁屏、UAC安全桌面、Session0不承诺自动操作 |
| Linux 原生 GUI | 网页先Playwright，文件/进程先SSH；原生桌面能力单独验证执行器 | 不把X11方案外推到Wayland；未适配能力为unavailable，转应用API或用户接管 |

来源：[DSH](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/ssh/ssh/README.md>)、[Peekaboo](<https://github.com/openclaw/Peekaboo/blob/653645cbddb596c8077940fce2506a32cb48f580/README.md>)、[Windows-MCP](<https://github.com/CursorTouch/Windows-MCP/blob/a736a72f888af83c6d07d93bc99d1ecb34826ba8/README.md>)。这些是固定文档核查，不是兼容性实测。

## 能力与输入输出

最小能力集合为 `fs.read`、`fs.write_conditional`、`process.start/status/cancel`、`desktop.observe`、`desktop.act`；每项独立定义版本、schema、范围和效果核对方法。

读文件需设备身份、逻辑路径和最大字节数；写文件需期望旧摘要和新内容引用；启动进程需executableId、参数数组、cwdRef、环境变量允许集、deadline与输出预算。模型不能任意指定环境变量、解释器或安装脚本绕过能力范围。

GUI输入含deviceId、交互sessionId、app/window稳定身份、最近observationId、动作类型/参数及DeviceCommand公共字段。输出含前后observationRef、目标身份、工具结果、效果证据及错误分类。截图/AX observation默认有效5秒；动作前重新核对窗口/PID/会话，过期或目标变化则重新观察，不盲点坐标。

## GUI独占与用户接管

每个 `desktop:{deviceId}:{sessionId}` 资源只有一个有效assignment。输入、焦点、截图使用同一上下文；计划可并行准备，操纵不能并发。中心资源租约结合执行器已有本地接管/队列机制维护独占；需要端侧gate的路线另行验证，不能假设现成工具已经接受识雨fence。

用户操作、锁屏、会话切换、显示拓扑变化、targetChanged使连续GUI动作暂停。用户接管优先；恢复后重新观察和授权核验，不从旧坐标继续。取消待执行器停止证明后释放；SSH进程退出不自动等于所有子进程或输入注入已停止。

## 权限、数据与失败恢复

- CLI执行账号与交互GUI账号分开。按具体能力提升权限，不将所有worker常态化置于root/Administrator。
- 工具路径、摘要和环境来自批准配置；安装/升级是独立变更，不由新工具声明自动触发。
- 文件端侧canonicalize，写入用版本guard、临时文件和原子替换；断连后mutation可能已完成，须查目标摘要而非重放。
- 进程状态、终止确认、产物摘要、业务完成分别记录。SSH lease cleanup是端侧动作，中心仍可能不知道终止结果，保留unknown。[进程语义](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/ssh/subprocess-ssh/README.md>)
- GUI按任务截取必要区域，默认不持续录屏；证据默认7天，删除/保留遵守数据方案。凭据不进入任务说明、截图标注或普通模型上下文。

## 验证与替代

V18/V19先用POSIX与Windows盘符、大小写、UNC样例，确认远端路径不映射成本机；断连写入核对摘要，100次重复/乱序不额外写入。

V26每种OS单独执行20个基础场景：文件读写、进程状态/终止、窗口观察/输入、锁屏/会话切换、权限缺失。每个结果均有证据；未覆盖应用不宣称支持。100次双worker桌面竞争不得发生输入交错；目标窗口变化必须停止原动作；旧会话未释放不能接受新输入。

单项失败仅禁用该能力，不整体降级到无限制shell。若目标GUI任务集稳定完成率不足95%，优先缩小范围或采用应用API；只有任务必须视觉交互且收益明确时比较cua等替代执行器，不再叠加完整Agent中枢。

## 固定接口、依赖与复用决策

[本轮源码与许可证据](<../../../../research/2026-11-01-复用核查/设备.md>)：DSH `ce7073d`（MIT）已有`cua/src/bridge.ts::connectCua`与`cua-macos::apply/installCua`；优先调用`getCapabilities/getApp/getAXState`和窗口动作，省去自研AX/输入与应用授权UI。`getApp`可能启动应用；动作只确认dispatched，效果仍需重新观察。原生helper启用/构建有本机副作用，留V26激活。

Peekaboo固定`653645cb`/4.9.7（MIT），直接用`peekaboo mcp`和producer-bound snapshot，HTTP/SSE服务端未实现。Windows-MCP固定`a736a72f`/0.8.8（MIT、Beta），已有Snapshot/输入/ControlStatus及本地接管；不重写UIA与输入，但该owner不能代替识雨跨worker租约。Python3.14+/FastMCP3+等在独立进程锁依赖；仅暴露批准工具，不能顺带开放shell/registry。其PostHog默认初始化，配置显式空`POSTHOG_API_KEY`并验无外发，再处理任务证据。顶层MIT不代表子依赖许可全部核查完成。

已有Cua Driver时复用DSH `computer-use-cua-driver-mcp`（上游`cua-driver-rs-v0.28.0`、MIT），不用另做DSH桥。上述API都不要求复制上游源码。本轮无复制、无安装。V26在相同20场景集比较现成执行器、100次资源竞争检验无混合输入，并验证锁屏/撤销/遥测设置；未通过的能力单独禁用。
