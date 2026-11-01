# proper-lockfile

[候选目录](<目录.md>) · [复用证据](<../research/2026-11-01-复用核查/恢复备份.md>)

日期：2026-11-01。类型：进程间文件锁库。状态：**已初评，v1.1单实例保护验证基线**；未安装、未运行、未接入。

固定版本：[moxystudio/node-proper-lockfile v4.1.2](<https://github.com/moxystudio/node-proper-lockfile/tree/v4.1.2>)；[MIT许可](<https://github.com/moxystudio/node-proper-lockfile/blob/v4.1.2/LICENSE>)。Superagent固定快照已直接使用它；具体调用顺序见[runtime.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/runtime.ts>)。

## 选择与边界

直接使用lockSync/release，由唯一宿主生命周期所有者先取得stateDir锁再开控制库，关库后释放；不再自造PID文件锁。局部复制Superagent调用顺序时保留其MIT声明，不引入完整Runtime的渠道、UI和执行依赖。

锁过期不证明旧进程已经停止；长暂停、睡眠、锁失陷与跨主机fencing不同。检测compromised须停止新业务并进入核对，不能只重新抢锁继续写。应用仍使用独立hostEpoch和恢复门控。

## 验证与回退

V21覆盖两个实例竞争、崩溃、长暂停、stale与compromised、关闭顺序和用户停用。复用失败保持单实例人工启动/诊断，不自己增加第二锁服务。完整传递依赖由实际锁文件清单确认；当前只有源码和许可静态证据。

2026-11-01：按全架构复用要求纳入设计验证基线，未修改系统服务或目录锁配置。
