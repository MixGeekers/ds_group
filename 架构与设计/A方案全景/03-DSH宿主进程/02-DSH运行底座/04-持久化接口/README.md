# 持久化接口

[全景目录](<../../../目录.md>) · [证据与版本](<../../../../../research/2026-11-01-完整架构/宿主与依赖.md>) · [验证与验收](<../../../验证与验收.md>)

- 更新：2026-11-01（America/Caracas）；原图模块 ID：`persistence`。
- 状态：完整架构的建议基线，待验证；未安装、运行或接入。A 的插件内核心由用户选定，其余技术为本轮规划选择。

## 选择结论

本轮[复用核查](<../../../../../research/2026-11-01-复用核查/宿主与依赖.md>)收缩“薄Repository”含义：事务内核优先局部复制 MIT 的 Superagent 固定提交 `6337fc8…701e` 中 `src/app/store.ts` 的 `atomic/afterCommit` 与层级回调小闭包，接入现有 `node:sqlite`；持久 Effects/Outbox 的复用与任务专题统一。删除从零编写通用嵌套事务、提交回调和存储框架的计划。CoreCommitService只保留权限、CAS、领域规则和具名命令边界。本轮仅列复制计划，产品源码尚未复制。

复制前明确补丁：原实现 SAVEPOINT 在 try 外，失败可留下 depth；ROLLBACK TO/RELEASE失败也未隔离连接。适配须清理层级、保留原错误与回滚错误、隔离未知状态，参考 DSH `SqliteKvUnit.write` 的失败处理；禁止异步事务callback。V14必须分别注入这些失败，不能把源码复用写成已验证可靠。

**DSH 继续保存自己的 Session 与宿主配置；识雨领域状态、任务和 outbox 使用一个专用 SQLite 数据库，由薄 Repository 事务入口持有。** SQLite 驱动优先使用当前 DSH 已依赖的 `node:sqlite`，不自建数据库或通用存储框架。

`DatabaseSync` 与 UnitOfWork 执行端放在同一 DSH 进程内的专用 DB WorkerThread，连接句柄只在线程内使用；主线程通过一个 MessagePort 和有界队列发送具名 typed commands，等待异步结果。不传任意 SQL、函数或数据库句柄。授权版本、CAS 与领域不变量在实际提交事务内核验，不能仅靠主线程提前检查。该线程只隔离同步数据库调用对主事件循环的阻塞，不是智能角色 worker、第二 core 或 OS 权限沙箱。

理由来自静态接口核查：DSH storage-domain 的 `put/update/delete` 是逐记录提交，`deleteMany` 仅覆盖一次同表批量删除；`KvUnit` 没有公开的任意跨记录 transaction。SQLite backend 内部的版本戳事务和批量删除事务，不能被领域消费者组合成“状态 + 事件 + outbox”的原子提交。也不能在 `domain/changed` 回调中补写 outbox 伪装成一个事务。

直接宿主路线仍可成立：将单一聚合及其 pendingEvents 放在同一 JSON 记录，`table.update` 可一起原子持久化并在更新函数中校验版本；独立小状态优先用它。全系统合为一个记录也不是逻辑错误，但每次重写/恢复装载与总量相关，跨聚合约束和查询需重构。因此 SQL 事务推荐来自当前真实跨聚合需求，而非“必须单库”的先验限制；V14可比较该低数据量替代。DSH `openDatabase` 包含宿主特有units表和user_version，不作为通用打开函数复制进领域库。

## 数据所有权与事务

| 数据 | 所有者与接口 | 原子性 |
|---|---|---|
| DSH Session / prompt投影 | DSH Session persistence；需要时 await flush | 仅宿主自身日志保证，不与领域库组成分布式事务 |
| 六部分权威状态 | CoreCommitService + 领域handler → 单库事务 | 状态版本、领域事件与待发送 effect 同一次提交 |
| Task / Assignment / Effect / Receipt | TaskService经受控仓储命令 | 按转换原子更新并核对版本与 fencing |
| 对话接收与发送记录 | Inbox / Outbox 服务经受控仓储命令 | 接收去重、状态与generation在业务库内提交 |
| 基线全文索引 | 同库 search_docs / FTS5，由受控 UnitOfWork 更新 | 正式聚合、search_docs、全文更新及相应 indexWatermark 同事务；派生属性不变，仍可清空重建 |
| 大文件 / 产物 | 内容引用与文件储存 | 先写入临时文件、校验、发布，再提交引用；失败清理孤儿，不声称文件与SQL同事务 |

所有写由同一受控写服务调度，按命令授予特定表/操作能力；“单 writer”不是所有业务规则写进一个函数。外层拿 ReadView 对象，不直接持有数据库连接。网络、模型与长计算在事务外完成；提交时重读授权与期望版本。

中文分词与正文准备在事务外进行，提交时校验来源 revision / hash；FTS5 更新失败时整个相关事务回滚。基线不同时建立异步 FTS5 写入链；只有重建新 epoch 或条件启用外部 LanceDB 时，才使用持久 outbox 和消费水位追平。删除屏障即时生效，FTS5 删除并不等于 WAL、空闲页和备份已物理清除。

跨 DSH Session 与领域库的映射使用业务 ID 和幂等记录：先持久化业务动作，再投递Session，保存绑定；崩溃后按同一动作 ID 核对。不能用两次成功写入推导跨库原子性或任意副作用恰好一次。

## 驱动准入与恢复

首验证 Node `24.22.2` 标签的 SQLite 源码为 `3.53.4`，但必须检查实际 `sqlite_version()` 和 `compile_options`；WAL 门槛为 `>=3.51.3` 或有明确回补证据。内置 `node:sqlite` 在该 Node 版本仍为 Release candidate，API风险保留在适配边界，不包装成全平台稳定保证。

数据库放本地文件系统，禁止用网络盘或同步盘承载活动 WAL。事务边界、busy预算、synchronous、检查点和备份以[数据空间方案](<../../../06-预留空间/README.md>)为准；所有连接同一规范化路径，避免两个“单 writer”打开同一数据根。

DB 线程失败时先停止派发和写入，不将未收到返回的命令当作失败重做；恢复后按 command / proposal 幂等键查回执。同步调用的锁等待不能被主线程 AbortSignal 瞬间打断；drain 达到 4 秒上限时记录未确认写入并进入下次启动核对，不声称强退前已成功 flush。

驱动初始化、版本、schema或回滚结果不确定时隔离写入并进入恢复；不继续用陈旧内存快照接单。若内置驱动在目标平台不满足兼容/备份/性能准入，先升级受支持 Node 并重复验证；仍不满足才评估锁定 `better-sqlite3` adapter。两者都复用 SQLite，不做自定义存储引擎。未来 DSH 提供可验证的跨表事务 API 时，可经同一Repository契约替换，不能直接拿私有连接绕过宿主缓存。

## 验证与证据

V01 查实际引擎版本；V14 对 Repository/HostAdapter 注入提交前后崩溃、busy、回滚失败与重复投递；V24 证明同一目标组合下状态与 outbox 要么一起存在、要么都不提交。无法保证该条件则不进入主动副作用验证。

[DSH domain 实现](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/storage/storage-domain/src/domain.ts>)、[KvUnit接口](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/storage/storage/src/backend.ts>)、[SQLite backend](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/storage/storage-sqlite/src/index.ts>)均已静态核查；[Node固定SQLite源码](<https://github.com/nodejs/node/blob/v24.22.2/deps/sqlite/sqlite3.h#L149-L155>)与[SQLite WAL限制及修复](<https://sqlite.org/wal.html#walreset>)已核查。未运行事务或故障注入。

