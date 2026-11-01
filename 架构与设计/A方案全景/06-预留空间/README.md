# 预留空间 · 组件分域与恢复边界

[上级](<../README.md>) · [完整目录](<../目录.md>) · [验证与验收](<../验证与验收.md>) · [证据索引](<../../../research/2026-11-01-完整架构/数据空间.md>)

更新：2026-11-01。区域 ID：`data`。**方案已细化，待验证；本轮没有创建真实运行空间。**

## 1. 主方案与复用边界

**2026-11-01 复用核查后的优先验证路线：Superagent 局部 Store / Engine 保存控制与任务账本，Ombre 作为单一记忆正文权威，保留各组件原有存储与导出能力。** 识雨只补授权、跨组件操作记录、删除屏障和裁剪视图，不再从零编写完整通用仓储。单库是此前的对照方案，不是用户硬约束；下文 SQLite 参数只约束控制库和本地 FTS 对照，不能强加给 Ombre 的全部数据库。[逐模块复用证据与复制清单](<../../../research/2026-11-01-复用核查/数据空间.md>)。

DSH storage-domain 可直接保存低频独立记录，也可把一个聚合及 pendingEvents 放在单条记录中原子 put；不能把多次 put 称为跨记录事务。任务已有 Superagent 的聚合 JSON、索引、receipt / effect 与 atomic 实现，优先局部复制它们，避免另造一套相同账本。控制库与 DSH Session 数据各有所有者；小记录无需为了统一库迁移。详见[宿主持久化接口](<../03-DSH宿主进程/02-DSH运行底座/04-持久化接口/README.md>)。

- 首验证锁定官方 Node 24.22.2 构建，与固定 DSH 提交兼容性一起验证；上游源码包含 SQLite 3.53.4，但运行时必须读取实际 `sqlite_version()` 与编译选项。
- `node:sqlite` 在所核 v24 文档仍是 RC；采用它是复用 DSH 已用绑定，不能称其 API 已完全稳定。如兼容 / 备份 / FTS5 门槛失败，先更换宿主支持的修复构建；仍失败才评估固定版本 better-sqlite3，保持仓储契约不变。
- WAL 主方案要求 SQLite ≥3.51.3，或有官方回补证据的 3.44.6 / 3.50.7，规避已披露的 WAL-reset bug；不能只检查 Node 主版本。

## 2. 物理空间与自知清单

生产建议为 macOS 本地加密 APFS 专用卷，设置 reserve / quota，再在卷内设唯一 `dataRoot`。容量估算默认 reserve 10 GiB、quota 40 GiB，实际值为部署输入，不能将默认值称为本轮已分配容量。专用目录降级只满足逻辑归属与应用预算，不满足物理预留；在获得真正 reserve 前，状态视图必须显示 `physicalReservation=false`。独立备份另处于不同故障域。

未来逻辑路径如下；不是在本资料目录创建运行子目录：

| 路径 / 外置项 | 内容 | 所有者 |
|---|---|---|
| `{dataRoot}/state/control.db` 及其 WAL/SHM | 控制、任务、授权、提交记录、操作 outbox；不重复保存 Ombre 记忆正文 | Superagent Store 局部复用，CoreCommitService 受限门面 |
| `{dataRoot}/components/ombre/` | Ombre vault、原文、媒体及其数据库；路径以实际配置和探测为准 | Ombre 单一组件写者；只能经获准适配调用 |
| `{dataRoot}/objects/` | 不可变对象；随机 objectId 作地址，私有元数据记录 SHA-256 | ObjectStore |
| `{dataRoot}/work/{taskId}/{assignmentId}/` | 有范围与预算的临时任务文件 | 受控 worker 执行器 |
| `{dataRoot}/derived/{indexEpoch}/` | 控制侧派生缓存；本地 FTS / LanceDB 仅对照或切换后使用 | Indexer；Ombre 自有索引归其组件管理 |
| `{dataRoot}/config/`、`checkpoints/` | 非秘密配置、版本清单、已验证本地 BackupBundle | ConfigService / CheckpointService |
| 专用 DSH home、OS Keychain、监督器状态、系统诊断日志 | 宿主要求的外置项及机密设施 | 逐项登记路径、保留与访问范围；不假定 cwd 能重定向全部项 |

`RootManifest` 至少含 rootId、canonicalPath、volumeId、filesystem、reservationBytes、quotaBytes、physicalReservation、externalLocations、schemaVersion。HealthProbe 提供采样时间、可用字节、各类占用、WAL 大小、最旧 reader、GC 与备份状态。路径须规范化并校验卷身份；卷丢失不在同名挂载点悄悄新建空库。macOS 钥匙串无法解锁时相关能力不可用，不将秘密复制到普通目录。

## 3. 写入与版本协议

CoreCommitService 是控制库受控提交门面，底层复用 Superagent 的 atomic / afterCommit 和仓储片段；TaskService 保留上游 Engine 聚合规则并补产品要求。Ombre 自己持有记忆存储，不共享 SQLite 连接。worker、replyer、模型均不持有写连接或原始写接口。该边界是受信组件约束，不等于阻挡恶意同进程原生代码的 OS 隔离。

| 序号 / 版本 | 唯一定义 |
|---|---|
| `commitSeq` | 控制账本成功业务提交序号；不能证明 Ombre 已写入或检索可见 |
| `stateVersion` | 已发布组合投影的版本；不是跨库原子快照，也不代替组件真实 revision |
| `componentVersion` | 组件返回的真实 revision；未提供时用已验证对象的 source hash / 内容版本与 capturedAt 表达局部证据，不伪造全局版本 |
| `revision` | 单聚合版本；Proposal 的 readSet 逐项 CAS，跨实体谓词带 collectionVersion 或唯一约束 |
| `authEpoch` | 授权撤销、范围收窄等访问规则失效水位；视图与效果派发复核 |
| `tombstoneWatermark` | 已提交删除屏障的单调序号；索引与恢复不能低于必要删除水位 |
| `indexWatermark` | 某索引完整处理到的 commitSeq，另带 tokenizer / embedding / indexEpoch |

**原子边界只覆盖控制库内的一次提交**：身份与能力校验 → 本库 readSet / 授权检查 → 控制领域变化 → audit / durable operation / outbox。远端记忆操作在提交后执行，状态为 approved → dispatching → applied / unknown / rejected；只有组件效果核对成功才记录 applied。缺少后端幂等或 CAS 的写操作不能靠本库 outbox 自动获得这些性质，须先完成适配补丁与故障验证；结果未知先查询核对，禁止盲重试。旧单库「六域 + event + outbox 同事务」仅在本地对照路线成立，不延伸到 Ombre。

记忆操作按公共契约命名为 MemoryOperation，使用上述状态。ReadView 返回 control.commitSeq / authEpoch / tombstoneWatermark，以及 components[{backendId, componentRevision?, verifiedSourceHash?, capturedAt, indexVersion?, freshness}]。源 hash 只能核对内容，不是后端 CAS。构建后再次检查删除与授权水位；新鲜度不足或仍有相关 unknown 操作时返回 stale / pending，不能声称完整最新。需要跨源同时满足的硬约束，先用维护屏障与核对；组件无法支持时拒绝该操作。识雨不实现分布式两阶段提交。

控制库配置建议：WAL、synchronous=FULL、foreign_keys=ON、busy_timeout=5000 ms；Superagent 已设置 WAL / FULL，其余须适配后读回。可把 Store 执行端置于宿主内 DB WorkerThread，句柄不共享；这是隔离同步等待的部署选项，不能复制上游 callback 到跨线程消息，更不传递任意 SQL。先验证现有同步 Store 的短事务与延迟，达到主线程阻塞门槛再启用线程门面。Ombre module_sqlite.py 使用 DELETE / FULL，应保持组件默认并单独验证。一个组件一个受控写者，短读事务；满盘 / I/O / 损坏不能无穷重试。

## 4. 模块与权威所有者

| 模块 | 设计入口 | 主要负责 |
|---|---|---|
| 内部权威状态 | [方案](<01-内部权威状态/README.md>) | 六域实体、来源、CAS、受控提交 |
| 目标 / 授权 / 任务 | [方案](<02-目标与授权及任务/README.md>) | 持久状态机、执行租约与 effect/outbox |
| 经历 / 证据 / 回执 | [方案](<03-经历与证据及回执/README.md>) | 输入去重、证据引用、保留与删除传播 |
| 工作文件 / 产物 | [方案](<04-工作文件与产物/README.md>) | 对象发布、文件与 DB 一致性、GC |
| 索引 / 缓存 | [方案](<05-索引与缓存/README.md>) | Ombre 原生检索优先；FTS5 对照、失效与收益门槛 |
| 配置 / 版本清单 | [方案](<06-配置与版本清单/README.md>) | 版本锁、迁移、回滚与实际状态探测 |
| 凭据引用 | [方案](<07-凭据引用/README.md>) | 系统机密设施与受限 CredentialBroker |
| 本地检查点 | [方案](<08-本地检查点/README.md>) | 复用组件导出、组合 Bundle、对象 pin、恢复闸门 |

## 5. 容量与保留默认值

以下是供合成验证使用的可配置起点，不把配置默认值视为用户永久保存授权：原始事件正文 30 天；诊断日志 7 天；临时工作文件终态后 7 天；未 pin 产物终态后 30 天；终态任务 / 回执最小元数据 180 天；候选记忆 7 天；正式记忆 90 天复核但不因复核自动删除。活动 / unknown 任务、未交付 outbox 和仍被引用对象不得按终态 TTL 回收。删除请求的权威屏障优先于普通 TTL。

配额使用率 80% 预警、90% 拒绝新大文件与非必要任务、95% 或真实可用空间低于应急余量时暂停新副作用与普通写入；优先清理已声明可重建且无 pin 的缓存及过期工作项。应急余量验证默认 512 MiB；它是预算，不自动保证磁盘存在这些字节。任何真实 ENOSPC 使当前事务回滚、标记存储降级；绝不通过默认删除权威记忆释放空间，也不能把内存队列回执宣称持久提交成功。

## 6. 下一阶段闸门

[V06](<../验证与验收.md#v06>)验证 CAS 与写偏斜；[V12](<../验证与验收.md#v12>)验证事务 outbox；[V15](<../验证与验收.md#v15>)验证版本、并发、迁移、空间与故障注入；[V16](<../验证与验收.md#v16>)验证删除传播；[V17](<../验证与验收.md#v17>)验证机密边界；[V22](<../验证与验收.md#v22>)验证检查点与恢复。全部只在下一阶段的测试目录与合成数据开展，本轮未运行。

