# 其他终端

[所属区域](<../README.md>) · [设备协议](<../01-设备能力接口/README.md>) · [来源](<../../../../research/2026-11-01-完整架构/设备执行面.md>)

更新：2026-11-01。模块 ID：`other-device`。状态：建议方案，未接入或实测。

## 主方案

浏览器和移动端先承担交互入口、材料提交和明确的局部能力，不要求每台运行完整模型或复制内部记忆。统一DeviceCapability协议保留平台差异，不具备的能力明确缺席。

| 终端 | 首选成熟能力 | 激活路径与边界 |
|---|---|---|
| 浏览器执行 | 先复用DSH browser-use-playwright-mcp及Session runtime；确定性步骤直接Playwright | provider已实现隔离launch/每Session串行与生命周期；只补Task映射、业务核对和权限；默认不开放任意run-code |
| 移动浏览器 | DSH Web、标准表单、用户选择的文件分享 | 作为认证对话渠道；网页不能读全盘或后台常驻监听，只接收获准材料 |
| Android测试设备 | 官方ADB + Appium/UIAutomator2候选驱动 | 先模拟器，真机由用户完成USB/无线调试配对；serial与deviceId显式绑定 |
| iPhone/iPad日常使用 | 用户触发的Apple Shortcuts和既有应用动作 | 白名单shortcutId与参数schema，结果经认证回执入口；不接收任意URL scheme或脚本 |
| iOS应用自动化 | Appium XCUITest + WebDriverAgent | 完整基线macOS/Xcode/签名；已具备WDA的iOS18+真机存在非macOS有限路线，非首轮系统依赖 |
| 专用设备 | 厂商已有API/SDK、行业协议适配器 | 先定义有界能力、查询和停止方式，不用shell猜测设备协议 |

官方依据：[Playwright context](<https://playwright.dev/docs/browser-contexts>)、[ADB](<https://developer.android.com/tools/adb>)、[Shortcuts](<https://support.apple.com/guide/shortcuts/open-create-and-run-a-shortcut-apda283236d7/ios>)、[XCUITest要求](<https://github.com/appium/appium-xcuitest-driver/blob/master/docs/getting-started/system-requirements.md>)。

## 输入输出与隔离

浏览器命令含profileId/contextId/pageId、目标origin、允许操作、observationId及公共DeviceCommand字段；输出为结构化DOM/可访问性结果、必要截图、ArtifactRef与业务效果证据。登录、点击和提交完成分别处理。

Playwright MCP支持隔离上下文，但其文档明确origin过滤和MCP本身不是安全边界。采用工具白名单、专用OS账号/沙箱及真实网络策略共同限权，不能把 `--allowed-origins` 当作阻断重定向外发的保证。个人浏览器profile不默认接管；需持久化的账号状态保存在受限账户域，不跨任务任意共享。[固定版说明](<https://github.com/microsoft/playwright-mcp/blob/be26c080edfae7c761db1e757c4aff9f6453b4d7/README.md>)

移动命令只引用已登记能力和参数。回执携带effectId且来自认证入口，URL回调任意成功字符串不作为证明。cookie、token、调试密钥通过凭据引用管理，模型不可读。

## 流程、失败与恢复

浏览器执行顺序为获取上下文、观察、检查目标/授权、执行、核验、释放。网页内容为低信任输入，不能改变Mandate；发送/提交遇到断连先查业务ID，点击后无证据时unknown，禁止再次提交。

Android重连先核对serial、调试授权与目标应用；不能把第一个在线设备当原设备。Shortcuts未返回可信回执则等待或unknown，不持续重发唤醒。renderer崩溃后打开页面只能恢复观察，不重放最后一次动作。

默认离线不接新任务，已接受的只读采集可在期限内完成。回执、截图、下载采用设备协议容量和清理规则，任务退出销毁临时context；需保留的storage state单独授权、受限存储。

## 验证与替代

V20在合成站点运行20个隔离、登录、提交、下载和异常场景；两任务cookie/storage不串用；未授权跳转被实际网络策略拒绝；重复effect不产生第二条记录。移动端先用协议替身，未配对、serial变化、伪造回执全部拒绝。

V26：Android模拟器通过后逐设备激活；iOS Shortcuts验证成功、拒绝、超时、重复回调、用户取消五类结果。真机授权/签名成本记入激活记录，不阻塞核心架构验证。

若网页/Shortcuts满足需求，不开发原生客户端；只有后台感知、系统事件或稳定离线执行具有明确收益才评估客户端。确定性脚本足够就不引入完整浏览器agent；移动GUI不稳则降到应用API/用户交接，不绕过OS约束。

## 固定复用接口与替换边界

[复用核查](<../../../../research/2026-11-01-复用核查/设备.md>)已追到DSH `ce7073d`的provider `apply`、runtime `mountSessionMcp/SessionResources`：已有scope/工具归属检查、串行/清理和禁自动重连。原方案中自行组织浏览器生命周期的部分由这些现成实现替代。它只支持Chromium；reload/resume不恢复cookies/pages，attach独占也只在provider实例内。MIT的DSH桥固定Apache-2.0的MCP **0.0.80** / Playwright **1.63.0-alpha-2026-08-31**；上一轮0.0.84是备选，不能混作已兼容版本。需Firefox/WebKit/专用持久账号时才比较独立上游执行器。

Android直接接Appium UiAutomator2 **v8.7.3**；iOS用XCUITest **v12.22.8**；均Apache-2.0，复用W3C WebDriver元素、输入、截图与会话。两者需Appium3/相应Node运行时，Android需SDK/JDK与API26+；不用在DSH主进程实现移动客户端。显式deviceId→`appium:udid`，`deviceName`不能选机。XCUITest完整基线需macOS/Xcode/WDA；Win/Linux有限路线仅满足iOS/tvOS18+真机、RemoteXPC、预装或外部WDA等前提时比较，不能外推模拟器支持。

驱动创建会话可能安装测试服务/WDA、启动应用或调整偏好，不能当作无副作用probe。V20/V26增加依赖版本对应、双udid防串机、驱动初始化实际变更、重载浏览器状态丢失和取消不重放；本轮未复制或运行驱动。
