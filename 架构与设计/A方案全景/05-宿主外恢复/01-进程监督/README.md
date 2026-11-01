# 进程监督

[所属区域](<../README.md>) · [完整目录](<../../目录.md>) · [全景图](<../../../图示/识雨全景架构-A.html>)

- 模块 ID：`supervisor`。更新：2026-11-01。
- 状态：验证基线设计；未安装、未执行。

## 主方案与复用

使用 macOS 自带 launchd；固定可执行文件、专用用户数据范围及 DSH Web profile，监听回环地址。首验证采用 `dsh web --no-open` 所对应的固定版本启动清单，不使用一次性 headless runner。LaunchAgent 依赖登录会话，不能据此承诺注销后运行。[Apple 官方服务说明](<https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html>)。

服务设置候选为 `RunAtLoad`、`KeepAlive.SuccessfulExit=false` 和有限的 `ThrottleInterval`；实际支持以目标 macOS 手册及 V21 为准。RunGate 把预期停止映射为成功退出，把应恢复的宿主失败映射为异常退出，不使用无条件 KeepAlive 抵消用户停用。平台字段依据[Apple launchd 手册源码](<https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5>)。

RunGate 只做固定配置校验、信号转发、意图检查、持久故障预算、启动代际分配和有界就绪检查；不接收任意 shell 文本，不自行更新二进制。进程托管与重启交给 OS，不另造守护框架。单实例锁只有一个所有者：宿主 Runtime 的数据根打开生命周期；直接使用 Superagent 已有的 proper-lockfile 4.1.2 调用路径，RunGate 不另写锁库。

本轮复用核查将原 RunGate 的单实例实现计划替换为现成锁库和宿主生命周期。固定 Superagent `6337fc8` 的 `src/app/runtime.ts` 先锁后开库、先关库后释放，MIT；proper-lockfile 4.1.2 亦 MIT。只计划局部复用生命周期顺序，保留许可证，不引入其整个 Runtime 和渠道依赖。其 `stale:30000` 不构成跨备份 fencing，须验证 macOS 睡眠、长暂停与锁失效时先停业务再关库。launchd 使用系统程序而不复制 Apple 历史源码；Linux 对照 systemd v262，原生限流作为额外上限，不与 RunGate 建立竞争的重试计数。精确来源、许可与补丁边界见[复用核查](<../../../../research/2026-11-01-复用核查/恢复备份.md>)；尚未复制或运行。

## 控制记录与所有者

| 对象 | 最低字段 | 所有者 / 生命周期 |
|---|---|---|
| RunIntent | schemaVersion、intentSeq、desiredState、requestedAt、requestedBy、reason | 可信用户控制入口；宿主外持久保存，原子替换，目录仅服务账号可写；哈希用于发现损坏，不当认证 |
| SupervisorState | installationGeneration、hostEpoch、attemptWindow、attemptCount、nextStartAt、lastFailure、mode、observedIntentSeq | RunGate；重启后仍读取故障预算，不能靠自身重启清零 |
| RuntimeHealth | hostEpoch、intentSeq、lastHeartbeatAt、ready、schemaCompatible、reconcileRequired、degradedReasons | 插件发布给本地受限通道；监督器只读，不含模型上下文或密钥 |
| StartManifest | 固定可执行路径、版本 / 摘要、profile 引用、数据根引用、兼容范围 | 已发布配置；只由受控变更流程替换，不由模型生成即时启动参数 |

控制记录不存数据库密码或备份密码，损坏或缺失时默认 `maintenance`，不默认 running。宿主持有的单实例锁与 hostEpoch 一起核对，不能只检查 PID 文件或把锁超时当作旧执行者已失效。当前阶段仅定义这些对象，没有创建运行文件。

DSH Goal 的权威状态来自目标专用 Session log。正常重启或备份恢复都先关闭目标调度/派工出口，恢复目标保持 `disarmed`；必须由任务恢复协调器核对 GoalBinding、GoalRef/revision、原生 phase、本地 stop/取消记录与当前授权。旧日志中的 armed 不能成为自动唤醒授权；必要日志/投影定义缺失或核对未完成时保持 maintenance / reconcileRequired，不发业务 ready，也不靠循环重启绕过。

## 意图与状态机

| desiredState | 已运行时 | 宿主退出后 |
|---|---|---|
| running | 允许通过业务授权的主动判断与派工 | 按故障预算自动恢复；未知任务仍须核对 |
| paused | 停止新主动工作，保留只读状态界面；任务暂停另有作用域 | 不自动拉起；显式恢复意图后再启动 |
| stopped | 排空并退出 | 保持停止 |
| maintenance | 只允许受控诊断、迁移或恢复 | 不自动进入业务运行 |

观察状态为 stopped → starting → ready；故障进入 degraded / backoff；连续失败进入 safe-mode，已知配置也失败则 quarantined。更新意图先持久写入新的 intentSeq，再排空 / 发送停止信号；宕机窗口内新的实例也会看到停止意图。普通聊天消息不能解除停用。

默认验证参数：10 秒心跳；连续 3 次缺失后再做独立的本地功能探测，探测失败才恢复进程。启动就绪预算 60 秒；模型或网络不可用只标 degraded，不因模型超时循环重启。重试等待 10 / 30 / 60 / 120 / 300 秒，10 分钟内最多 5 次自动启动，safe-mode 也计入这 5 次总预算；已有已发布 safe-mode 时可用它替代第 5 次普通启动，不在额度外追加第 6 次。总预算耗尽或 safe-mode 失败即隔离，等待明确修复 / 恢复操作。稳定 ready 10 分钟后清预算。

## 退出、权限和恢复

DSH 固定快照的插件 dispose 预算有限，识雨内部排空目标 ≤4 秒：先停派工，再将运行中任务及外部 effect 写为可恢复状态，然后让宿主退出；无法在预算内收齐的外部结果保留 unknown。监督器不给任务追加授权，不把新 hostEpoch 当任务完成证据。

错误分成进程意外退出、应用未就绪、依赖降级、配置不兼容和数据损坏；后两者交恢复入口，不由监督器修改数据库。用户停用优先于重试计时。没有足够空间记录控制状态时停止新动作，保留可读诊断；禁止通过删除权威数据释放启动空间。

## 备选与切换条件

Linux 迁移复用 systemd 的 `Restart=on-failure`、`RestartSec`、`StartLimitIntervalSec`、`StartLimitBurst`；只有集成了通知协议才能启用 WatchdogSec，不把进程存在当就绪。[systemd 官方服务手册](<https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html>)、[限流配置](<https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html>)。

仅当“无人登录仍工作”或 Mac 睡眠导致可用性不达标时迁移宿主；单纯需要多设备不引入 Kubernetes、PM2 或额外 supervisor 产品。

## 验证与通过条件

按 [V21](<../../验证与验收.md>) 使用替身宿主和合成控制记录：意外杀进程后在无外部故障时 ≤120 秒恢复 ready；paused / stopped 下观察 10 分钟无自动业务启动；5 次失败后无第 6 次自动启动（含 safe-mode）；损坏控制记录默认 maintenance；SIGTERM 排空后未知 effect 保持 unknown；旧 hostEpoch 结果不能提交新状态。记录退出码、intentSeq、attemptCount、就绪时长及派工计数。未满足即停在手动启动方案，保留数据与诊断，不扩大自动恢复范围。

证据分级及 DSH 固定版本信息见[核查记录](<../../../../research/2026-11-01-完整架构/恢复与备份.md>)；本轮未实测上述参数。

