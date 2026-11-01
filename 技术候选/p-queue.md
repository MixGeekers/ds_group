# p-queue

[候选目录](<目录.md>) · [复用证据](<../research/2026-11-01-复用核查/输入与外层.md>)

日期：2026-11-01。类型：Promise并发队列库。状态：**已初评，v1.1旁路replyer队列验证基线**；未安装、未运行、未接入。

固定来源：[sindresorhus/p-queue v9.0.1](<https://github.com/sindresorhus/p-queue/tree/v9.0.1>)；[MIT许可](<https://github.com/sindresorhus/p-queue/blob/v9.0.1/license>)；[包清单](<https://github.com/sindresorhus/p-queue/blob/v9.0.1/package.json>)。原生ESM，Node>=20，依赖eventemitter3与p-timeout；已读基线许可，实际版本/传递依赖在验证锁文件确认。

## 选择与边界

无工具的旁路模型调用直接用new PQueue/add(signal)/pause/onPendingZero/onSizeLessThan，复用有限并发、取消与排空，不自制Promise队列。专用DSH Agent路径继续用原生inbox/send/cancel，不额外套同职责队列。

本库是内存任务队列，不是持久inbox、事务outbox、授权引擎或设备去重机制。运行中的函数要自行响应AbortSignal；超时不证明没有副作用。容量等待不构成原子受理锁。识雨只补会话公平、代次、唯一接纳器与持久游标，并与后台共享总模型预算。

## 验证与回退

V05验证每会话只放一个候选、并发额度、取消中旧生成、排空及重启后由账本重建队列；V23验证端到端发送身份。若DSH统一预算能力已覆盖同样调度，直接注入共享实现，撤掉重复队列。当前只静态核查文档、包清单与许可，没有性能或可靠性实测。

2026-11-01：根据用户全架构复用要求纳入设计验证基线，不表示用户逐项确认安装。
