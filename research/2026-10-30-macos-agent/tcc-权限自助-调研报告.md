# macOS TCC 权限自助授权调研报告

调研日期:2026-10-30(America/Caracas)。原调研记载以 bash + curl 抓取资料。原始材料位于 `tcc-raw/`；其中四个自写辅助脚本已迁至 [测试归档](<../../测试/归档/2026-10-30-research-helpers/说明.md>)，来源快照仍保留。

> 以下“已核实”“本机实测”均为旧调研所述时间与宿主下的记录，本轮未复验。旧操作日志见 [历史实验](<../../测试/归档/2026-10-30-macos-permissions/说明.md>)。本文中的命令仅作机制研究材料，不构成执行许可；当前阶段见 [工作区约定](<../../AGENTS.md>)。

## 1. TCC 机制本身

**已核实:**
- **服务名与双库位置**:系统级 `/Library/Application Support/com.apple.TCC/TCC.db`;用户级 `~/Library/Application Support/com.apple.TCC/TCC.db`。常见服务关键词(大小写敏感):Accessibility、All、ScreenCapture(录屏)、SystemPolicyAllFiles(FDA)、SpeechRecognition 等;完整服务名可用 `strings /System/Library/PrivateFrameworks/TCC.framework/Support/tccd | grep -F kTCCService | ...` 枚举(Monterey+)。来源:https://ss64.com/mac/tccutil.html ;服务名机制详解:https://hacktricks.wiki/en/macos-hardening/macos-security-and-privilege-escalation/macos-security-protections/macos-tcc/index.html ;从 tccd 二进制枚举 kTCCService* 的完整实例:https://entonos.com/2023/06/23/how-to-modify-tcc-on-macos/
- **服务分布**:FDA、辅助功能、屏幕录制等高敏服务通常存**系统级库**;camera/麦克风/Automation(AppleEvents)/文件夹类通常存**用户级库**("usually",非绝对)。来源:https://www.tccparser.com/en/blog/tcc-db-location-acquisition (2026-09);https://www.macforensics.app/en/blog/tcc-database-forensics 。**本机实测佐证**(SIP 开启的本机):系统库中可见 kTCCServiceAccessibility/kTCCServiceScreenCapture/kTCCServiceSystemPolicyAllFiles 条目,用户库中是 kTCCServiceAppleEvents 条目——与"通常"分布一致。
- **保护模型(三方一致)**:读任一库需要进程持有完全磁盘访问(root 也不行);**SIP 阻止修改系统级库(root 也不行)**;用户级库**不受 SIP 保护**,持 FDA 的进程可写。来源:tccparser + HackTricks + entonos。entonos 在 macOS Ventura 13.4.1 上给出可用的 `INSERT INTO access VALUES(...)` 实操(写 kTCCServiceAppleEvents+csreq blob 成功,Terminal 持 FDA、SIP 开启):https://entonos.com/2023/06/23/how-to-modify-tcc-on-macos/
- **其它结构**:auth_value 2=允许/0=拒绝;csreq BLOB 把授权绑定到代码签名(同 bundle id 不同签名不生效);另有 REG.db 与 MDMOverrides.plist(PPPC 决定存放处)。来源:HackTricks + tccparser。
- 本机实测:sqlite3 读出系统库中宿主 app(com.deepseek.dsh)的 Accessibility/ScreenCapture/FDA 三项授权(auth_value=2)——"人工授权一次"确实落库,且子进程(bash)借继承的 FDA 能读系统库。

**存疑/部分核实**:用户级库"持 FDA 即可写"的实证是 Ventura 13.4.1(entonos)+ HackTricks 现行页面;未找到 macOS 15/26 上的独立复验报告。系统级库需关闭 SIP 才能改:三方一致,已核实。

## 2. Responsible process(子进程继承)

**已核实:**
- XNU 为每个进程维护 `p_responsible_pid`/`p_responsible_uuid`;fork/posix_spawn 时子进程**继承**父进程的 responsible(`bsd/kern/kern_fork.c:1053`,`proc_set_responsible_pid()` 位于 `kern_proc.c`);**TCC 检查的是 responsible process(通常是发起动作链顶端的 GUI 宿主 app),而非直接调用的子进程**。可用 `log stream --debug --predicate 'subsystem == "com.apple.TCC" AND eventMessage BEGINSWITH "AttributionChain"'` 观察归因。来源:HackTricks TCC 页(同上 URL)。
- **真实 AI-agent 案例(直接命中本场景)**:OpenClaw(AI agent)在 macOS Tahoe 上 `screencapture` 经 exec 工具执行失败,即使父 app 已获录屏授权——根因即 TCC 按 responsible process 归因:LaunchAgent wrapper 里的 `exec` 替换了进程,授权目标漂移到未授权的 node 二进制;解法是给确切的 node 二进制授权。来源:https://github.com/openclaw/openclaw/issues/14138
- cliclick README 明确:cliclick 需要所在终端 app(Terminal/iTerm)先有辅助功能权限才能发 CGEvent——即宿主授权、子进程工具受益的直接例子。来源:https://github.com/BlueM/cliclick (README 实抓)

**结论(已核实)**:宿主 app 获得的录屏/辅助功能/FDA 授权,其 bash 子进程链默认归因到宿主、可继承使用;但 **LaunchAgent/脚本 exec 包装会改变归因对象**,需保证授权落在"负责进程"上。

## 3. 现成工具

**已核实:**
- **jacobsalmela/tccutil**(python "tccutil.py",552★,活跃):只支持 **Accessibility 库**的 --list/--insert/--remove/--enable/--disable;README 明言 "Due to SIP, this utility will no longer work to modify the database"(Sierra 起,issue #18)。`brew install tccutil` 装的就是它。来源:https://github.com/jacobsalmela/tccutil (README 实抓)
- **tccplus**:真实仓库是 **jslegendre/tccplus**(285★,**已归档**,最后 push 2024-09)。README 关键句:**"Requires SIP and AMFI to be disabled"**(用私有 TCC.framework 写库),支持 Accessibility/ScreenCapture/SystemPolicyAllFiles/AppleEvents/PostEvent 等 38 项服务。**"用 FDA 写库即可授权"的说法与该工具实际情况不符——它要求关 SIP+AMFI**。fork eugenesvk/tccplus 2020 年起停滞(0★)。来源:https://github.com/jslegendre/tccplus (README/API 实抓)
- **privacy_services_manager**(univ-of-utah-marriott-library-apple):El Capitan 时代工具,管 contacts/accessibility/calendar/icloud/location,同样属于 SIP 收紧前的产物。来源:https://github.com/univ-of-utah-marriott-library-apple/privacy_services_manager (README 实抓)
- timsutton/scripts 的 tccmanager.py:仅见于 jacobsalmela README 提及,未单独核验——**未能核实**。

**结论(已核实)**:**没有任何一款现成工具能在 SIP 开启的 macOS 15/26 上静默插入 Accessibility/FDA/ScreenCapture 授权**。能对用户级服务(camera/mic/AppleEvents 等)做手工 INSERT 的前提是写入进程持 FDA(见第 1 点,版本适用性存疑)。

## 4. MDM / PPPC 路线

**已核实(Apple 官方文档 JSON 实抓):**
- PPPC payload 页面明确三行:**"Requires user-approved MDM: macOS"**;**"Allow manual install: N/A"**;user channel N/A。即:PPPC 对 TCC 生效必须经(user-approved)MDM 下发,手动双击安装 .mobileconfig 不构成授权。来源:https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol
- PPPC Services 官方清单(services-data 页实抓):含 Accessibility、AppleEvents、PostEvent、SystemPolicyAllFiles(可 Allow=静默授予 FDA)、SystemPolicyDesktop/Documents/DownloadsFolder、SpeechRecognition 等;**ScreenCapture 与 ListenEvent 为 deny-only——官方原文 "A profile can't grant access…; it can only deny it"**(系统摄像头/麦克风同样只能 deny);Accessibility 条目另注明 macOS 27.0 起应用设置时显示非阻塞通知;**大量条目标注 "Deprecated: macOS 27+"(迁往 declarative management)**。来源:https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol/services-data
- Jamf 官方 PPPC-Utility 的服务清单与 Apple 文档一致,且 ScreenCapture 的 denyOnly 标记**自 2022-01-27 初始版本就存在**(非新变化)。来源:https://github.com/jamf/PPPC-Utility (Resources/PPPCServices.json 及其 git 历史)
- PPPC 决定落地在 `/Library/Application Support/com.apple.TCC/MDMOverrides.plist`(本机实测:无此文件——非受管机)。来源:HackTricks + tccparser。
- **MicroMDM:v1 已进入 maintenance mode 并弃用**,官方转向 NanoMDM(micromdm.io 首页原话)。repo 仍活跃(2697★)。来源:https://micromdm.io/ ;https://github.com/micromdm/micromdm

**结论(已核实)**:个人 Mac 上走 PPPC 自助授权不可行——既需 MDM(且 user-approved),**录屏又是 deny-only 授不了**;能静默授予的恰是 FDA/Accessibility/AppleEvents 等,但前提是整条 MDM 链路。个人设备自建 MDM 技术上可行但需管理员注册+批准,超出"只授权一次宿主 app"的目标(未深挖,标注)。

## 5. 用辅助功能权限点击授权弹窗

**已核实:**
- HackTricks AppleScript 页原文:"use System Events/Accessibility to **click a permission dialog**",并给出样例:`tell window 1 of process "SecurityAgent" → click button "Always Allow" of group 1`。同页核实 AppleEvents 授权是**方向性**的(source→target),Terminal→Finder 允许一次后可长期复用,且 Finder 恒有 FDA——可当 AppleScript/JXA 代理读 TCC 保护文件。来源:https://hacktricks.wiki/en/macos-hardening/macos-security-and-privilege-escalation/macos-security-protections/macos-tcc/macos-tcc-bypasses/macos-apple-scripts.html
- MacScripter(2025-01)实例:GUI scripting 可点"文件夹访问权限"对话框的 OK 按钮;关键限制:"**an App can't GUI script itself**"——必须由**另一个进程**(如 `do shell script "osascript"`)执行点击。来源:https://www.macscripter.net/t/automating-button-click-in-macos-file-access-permission-dialog/76710 (实抓全文)
- Apple 官方 UI 自动化指南(Automate the User Interface):https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/AutomatetheUserInterface.html (命中核实,未逐字精读)
- cliclick 路径成立:宿主持辅助功能 → 子进程 cliclick 发 CGEvent 点任何前台对话框(README 见第 2 点)。

**未能核实/存疑:**
- 当前 macOS 15/26 的**屏幕录制授权弹窗按钮结构**:多份资料暗示其只提供"打开系统设置"而非"允许"按钮,意味着自动点击需进一步操作 System Settings 开关;此细节未获权威实证(Stack Exchange 抓取被 403 拦截)。
- "宿主有辅助功能即可自动点掉自己未来所有 TCC 弹窗"**没有找到端到端公开实证**;理论可行 + 部分组件实证(SecurityAgent/codesign 对话框、GUI scripting),整链路需自测。
- System Settings 中的权限开关是否可被 UI 脚本稳定切换、是否免管理员密码:未能核实。

## 6. 新版系统变化

**已核实:**
- **macOS 15 Sequoia**:引入录屏权限**定期重确认**提醒——beta 期每周,正式版放宽为**每月**(多方一致)。来源:Jeff Johnson(Lapcat)https://lapcatsoftware.com/articles/2024/8/10.html ;汇总 https://mjtsai.com/blog/2024/08/08/sequoia-screen-recording-prompts-and-the-persistent-content-capture-entitlement/ ;https://9to5mac.com/2024/09/24/macos-sequoia-screen-recording-permission-nags-can-now-be-permanently-vanquished/
- 提醒状态存于 **`~/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist`**(TCC 保护、需 FDA 读写);把日期改到远未来(如 3024 年)+ 重登即可永久消除。来源:Lapcat(同上)+ https://blog.eternalstorms.at/2024/09/23/psa-no-more-macos-15-sequoia-monthly-screen-recording-permission-reminders/
- **macOS 15.1**:新增官方 MDM 键 **`forceBypassScreenCaptureAlert`**(域 `com.apple.applicationaccess`,布尔,仅 15.1+、仅受管设备)关闭该提醒。来源:Rich Trouton(Der Flounder,引 15.1 release notes)https://derflounder.wordpress.com/2024/10/31/managing-user-notifications-for-apps-which-request-screen-access-on-macos-sequoia-15-1/
- **macOS 26 Tahoe**:Apple 官方企业更新页:设备管理配置允许标准用户启用的录屏权限在系统设置中正确显示;"App privacy permissions configured by device management are now shown in System Settings > Privacy & Security"。来源:https://support.apple.com/en-us/124963 。AI-agent 在 Tahoe 的 TCC 归因实际案例见第 2 点(openclaw issue)。
- **macOS 27(当前文档口径)**:PPPC 多数服务键标 "Deprecated: macOS 27+",迁往 declarative management;Accessibility 的 PPPC 应用时出现非阻塞通知。来源:https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol/services-data (实抓)

**未能核实**:Tahoe 是否引入录屏提醒的进一步强化(未找到权威页面;注意有第三方 SEO 文章称 Tahoe 仍有类似提醒,证据力弱,不计)。

## 7. 撤销与安全(tccutil reset)

**已核实:**
- 语法:`tccutil reset SERVICE [BUNDLE_ID]`;可选服务含 Accessibility、All、ScreenCapture、SystemPolicyAllFiles、AddressBook、Camera 等(大小写敏感);指定 bundle id 只重置该 app。"Reset all decisions for the specified service, causing apps to prompt again"。示例含 `sudo tccutil reset Accessibility`、`sudo tccutil reset All com.apple.Terminal`。来源:https://ss64.com/mac/tccutil.html
- Apple 内置 tccutil **只有 reset 一个写操作**,无查询功能(HackTricks 与 jacobsalmela README 一致确认)。reset 是**官方认可、无需关 SIP** 即可生效的 TCC 写操作(通过 tccd)。

**未能核实**:`tccutil reset Accessibility` 重置系统级库条目时的权限要求细节(是否必须 sudo、作用域是否横跨两库)。

---

# 最终结论:在"只人工授权一次录屏+辅助功能(建议加 FDA)给宿主 app"的前提下

**Agent 理论上能自助完成(多数有实证):**
1. **继承宿主授权**:bash 子进程链按 responsible process 归因宿主,直接使用宿主的录屏/辅助功能/FDA 授权(HackTricks 机制页 + openclaw 案例 + 本机实测可读系统 TCC.db)。注意 LaunchAgent/`exec` 包装会漂移归因对象。
2. **自动点击其它对话框/按钮**:宿主有辅助功能后,从**另一个进程**发 System Events UI 脚本或 cliclick CGEvent,可点击权限类对话框按钮(HackTricks SecurityAgent 样例、MacScripter 实例);并可用 AppleEvents 一次性允许后把 Finder(恒有 FDA)当文件代理。
3. **写用户级 TCC.db**:持 FDA 进程可对用户库做 sqlite INSERT(entonos 在 13.4.1 实证;新版待复验)——理论上可预插 AppleEvents/文件夹类等用户级授权,绕过对应弹窗。
4. **消除自己的每月录屏提醒**:改 replayd 的 ScreenCaptureApprovals.plist 日期到远未来(Lapcat/Eternal Storms 实证,需 FDA)。
5. **重置/管理 TCC 状态**:`tccutil reset`(官方唯一写操作)。

**做不到(无论多自主,都需人工/MDM):**
1. **改系统级 TCC.db**:SIP 保护,root 也不行 → 无法用脚本给自己或其它 app 静默追加 Accessibility/FDA/ScreenCapture 的系统级授权。
2. **PPPC 自助路线**:必须 user-approved MDM 下发;**录屏在 PPPC 里 deny-only 根本授不了**;手动双击 profile 无效。
3. **现成工具均失效**:tccplus 要关 SIP+AMFI(已归档);jacobsalmela/tccutil 在 SIP 后即失效且只管旧时代 Accessibility 库。
4. **首次"录屏+辅助功能"授权本身必须人工完成**(这正是设定中的那一次人工授权);其后弹窗点击路径虽理论可行,但**录屏弹窗在新系统疑似只给"打开系统设置"按钮**、System Settings 开关能否脚本化切换未获实证——这是整条自助链里最需要实测的一环。
5. macOS 27 起 PPPC 多服务 deprecated,苹果方向是 declarative management——长期自动化应关注 Declarative Device Management 而非直接改库。

**一句话**:授权一次后,agent 的自主空间 = 继承授权 + UI 自动化点击 + 用户级库写操作 + 提醒自消;系统级授权、录屏的静默预授权(PPPC deny-only)、以及关闭 SIP 这三道墙是设计上不可自助逾越的。
