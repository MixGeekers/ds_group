# 控制库事务与提交水位

`SqliteTransactions` 管理同一连接的同步事务、嵌套 SAVEPOINT、回滚隔离和提交后通知。`commit-watermark.ts` 在此基础上增加真实同库提交水位，不使用事件序号、`total_changes()`、进程内计数或快照 hash 代替数据库提交。

## 接线顺序

```ts
const db = new DatabaseSync(filename);
// 先设置本模块既有的 busy_timeout、foreign_keys、journal_mode、synchronous。
const transactions = new SqliteTransactions(db);
const watermark = installCommitWatermark(db, transactions);
// 再构造 Task / Goal / Conversation 等仓储；全部共用上面两个对象。
// 所有领域写操作仍走原有 transactions.atomic(...)。
const snapshotWatermark = watermark.read();
```

必须在仓储构造前安装，包含重开：持久触发器已在旧库里，需先注册本连接的执行期 guard。API 构造自身的元表/触发器是独立原子初始化，建立 `commitSeq=0` 起点。已有数据不回填历史，后续仓储初始化中真正发生的变更正常计数。

`read()` 返回 `{schemaVersion:1, commitSeq, baselineId, startedAt, history:'since-installation'}`，使用受控读事务从数据库取得当前值。相同 `baselineId` 的序号才可比较；首次安装和替换数据库不能凭序号大小推断连续历史。元数据缺失、损坏或残留 dirty 不自动重置。调用者若需将水位与多个查询视为一个快照，应在同一个外层只读 `atomic()` 内取得它们；未提交写入存在时 `read()` 拒绝发布水位。

## 精确语义

- 包含至少一次有效行变化或受支持 schema 变化的成功外层提交，序号增加一次。多个表、多个 SAVEPOINT、同事务内领域操作归并为一次。
- 纯读取、零行 DML、忽略冲突、同值 UPDATE、无变化的 `IF NOT EXISTS` 不增加；NOCASE 排序规则下实际字节变化仍会增加。
- 内层回滚会回滚该层 dirty；整个外层回滚不增加。先写再删或改回原值仍属于发生过有效写入的成功提交，会增加一次；它不是净状态差异计数器。
- `OR FAIL` 已保留的部分行变化若由调用者明确提交，会计入；`ABORT` 撤销的语句不泄漏 marker。触发器标记用 `INSERT ... WHERE NOT EXISTS`，不依赖可能被外层 SQL 覆盖的 `OR IGNORE` 策略。
- 计数更新发生在真正 COMMIT 之前，与业务数据同事务持久化；不是 afterCommit 再补写。COMMIT 前失败保持旧值，真正提交后丢确认保留 unknown/quarantine，重开核对真实值。通知失败不撤销已提交水位。
- 多个规范接入的独立连接通过 `BEGIN IMMEDIATE` 串行取得写权，再由 SQL `commit_seq=commit_seq+1` 增加；不读出后用旧值覆盖。

## 覆盖与升级边界

安装时追踪全部普通 main 业务表，不依赖领域自行调用 dirty。INSERT/DELETE 和实际值变化的 UPDATE 会在数据库事务内设置持久 marker。执行期 UDF 检查事务归属，涵盖已预编译语句；未安装 guard 的其他连接不能写这些表。authorizer 还保护元数据、事务控制和追踪定义，但它只是编译期补充，不能单独承担执行期检查。

新表及其首批数据可在同一个受控 `atomic()` 中创建：真实 schema 变更计一次，提交前补齐新表追踪，因此不会漏掉在触发器安装前写入该新表的数据。新 index 和 `user_version` 变化也纳入 schema 指纹。普通 index 重建不改变业务状态或 schema，不作为新领域提交。现有表定义变更若会破坏当前追踪定义会拒绝，需要单独的版本迁移设计，不能静默重装后声称中间历史已覆盖。

Schema 变更、写入 `user_version` 和 REINDEX 只允许经受控事务内的同步 `db.exec()` 执行，不能通过 `db.prepare()` 缓存。authorizer 只在编译阶段检查；即使编译时拥有事务，执行缓存语句前 SQLite 仍可能因 `OR ROLLBACK` 自动退出事务。实际事务状态与直接执行入口一起检查，安装前缓存的 schema 语句也在新 authorizer 下被拒绝；业务预编译 DML 保留执行期触发器检查。

当前不支持额外业务触发器、虚拟表、临时表或 attached 数据库。额外 `AFTER ... RAISE(IGNORE)` 能跳过追踪，故不能仅确认本模块的触发器还在就接受它。每次外层事务持锁后复核元数据、完整追踪定义与 schema 指纹；外部未托管 schema 改动会拒绝服务，不能自动修补成可信连续水位。

此模块独占连接 authorizer，要求当前 Node `node:sqlite` 提供 `setAuthorizer/function`，以及 `trusted_schema=ON` 以运行非 innocuous UDF；不擅自修改该配置。它不是对有权改数据库文件、替换 UDF 或移除 authorizer 的管理员的隔离机制。SQL 连接仍只由受信控制 Worker 持有，未增加公开 SQL 入口。

## 本轮证据

2026-11-02，本机 Node 24.19.0：`tests/commit-watermark.test.ts` 20 项、原 `tests/transaction.test.ts` 16 项，共 36/36 通过；其中五个真实 WorkerThread/SQLite 连接提交 50 次，得到不重复且完整的 1–50 序列。覆盖真实临时文件 DB、重开、旧数据零基线、损坏元数据、动态新表、提交前后故障和通知失败。Conversation Worker 定向组合在首次接线修正后 11/11 通过。没有运行真实 DSH 宿主或模型；宿主打包 Node 能力仍由独立 smoke 留证。

同日后续复核发现两个自动回滚边界：捕获 `INSERT OR ROLLBACK` 后继续 `exec` 建表会逃逸；仅增加 `db.isTransaction` 仍挡不住之前缓存的 CREATE TABLE / 写 PRAGMA。两者均已在真实临时文件数据库复现并修复，未以“最后 quarantine”代替阻止写入。直接执行修复后水位 21 项＋事务 16 项为 37/37；缓存变更入口修复后水位 23 项＋事务 16 项＋Conversation Worker 11 项同批 50/50，通过类型检查。回归核对新表不存在、PRAGMA 未改变、REINDEX 及 `sqlite_sequence` 直接 DML 被拒绝、原数据保留、重开序号能继续。上述早期通过批次保留为发现前历史，不作为最终补丁的全部验证。

事务封装的上游适配许可与固定来源保留在 `transaction.ts`；水位实现为识雨新增代码，未复制第三方计数实现。

## 3C：已发布内层清单与可信本地 capture

`worker.ts` 在已有 Task/Conversation 仓储后构造 `StatePublicationStore`、`LocalReadSafetyStore`、`ViewDomain`。首次启动明确发布六域均 unavailable 的清单；重开有发布头时不再发布。内层发布与真实 `commitSeq` 是独立语义，Task 进度使用自己的 aggregate version。详细字段与受信写边界见 [state README](../../state/README.md)。

可信 IPC 仅提供 `view.captureLocal({conversationId,purpose})`、`view.validateCapture({captureId,phase?})` 和纯读 `view.state({})`。身份、scope、字段和来源版本均不能来自公开参数。capture 启动一段同步只读事务，读取持久发布头、policy/auth/tombstone 权威、control baseline/seq、Conversation context/business/session 及关联 Task 的真实 version。只输出 Task 的 `taskId/title/state/version/updatedAt/stopRequested`，不含模型正文、输入、产物路径或预算能力。

capture 最长 30 秒，最多 256 个，Worker 重启全部失效；GET 不写 DB、不消费事件、不 ackContext。组件读取绑定捕获的字节，不能在异步拼装中再次读出更晚的 Task 内容。每次 authority resolve/source check 都经 Worker 新鲜校验当前来源；固定 expiresAt 不因 resolve 而续期。无关 commitSeq 增长不使视图失效，真实 Task aggregate/关联变化则阻止 prepare/ready。

`ack` 只核对当前强安全向量和固定期限，允许后台在加载期间继续增长；Conversation 同事务回执只确认实际加载的捕获来源，后续 pending 仍保留。`prepare/ready` 另核对捕获来源与 Task.version。初次原生 Session 绑定可填入同 epoch 的 sessionId；已有 sessionId、generation、audience、routing 或安全权威变化均拒绝旧 capture。确认原生持久接收与源 cursor 的写入由 Conversation reply 控制域承担，读取接口本身不宣称已加载。

3C 本轮定向批次（2026-11-02）：新 publication 13 项、local capture 12 项、真实 Worker view 6 项、ReadView 14 项、原 Conversation Worker 11 项，共 **56/56 通过**，全包类型检查通过。包括 50 个并发 capture 不写水位、重开保留基线、纯读不发布/不 ack、真正 Task 版本变化、无关事件提交仍可使用、政策/全局 epoch/本地来源屏障独立失效、异步读期间来源变化拒绝输出。只读复核另外复现了“BEGIN 等锁跨过 TTL”边界：验证进入前尚有效、等待第二连接后已过期仍返回；已加入事务内前后期限检查，真实双连接持锁回归通过。所有数据库和来源均为临时合成数据，没有运行真实 DSH 宿主、付费模型或 Ombre。

## 3G：有界 Core 判断到既有 Task 准入

`core-domain.ts` 只保存 owner 明确授权的 local-note deliverables、规划触发、调用资格、结构化决定和原生回执。DSH 仍拥有 Goal phase、rounds 和 Session；`authorized/paused/controlEpoch` 是本地授权控制，不是另一套 Goal 状态。当前模型只能选择一个已授权事项、defer、no_action 或提出完成候选，不具备任意拆解任务、扩大正文/资源或自行签发授权的能力。首轮上下文仅含 owner 目标、同 Goal Task/Effect 元信息，不读取可撤回 Memory 正文。

`core.prepareGoal` 先保存不可变 owner 范围；受信宿主确认原生绑定后，显式 `core.authorizeGoal` 只签发一份共享 Mandate。Core 每轮账本预留为 16384 tokens / 2 generation calls / 0 effects，Task 为 16384 / 2 / 1；两者从同一总额扣留。token 预留不是调用前的精确计费硬上限：按观测用量对账，超额后冻结后续准入，无法撤销已经产生的用量；原生请求次数与输出上限另行限制。`authority.ts` 的 V4 是固定 V3 的显式目录迁移，只新增固定 Core dispatcher/verifier 的 `core.evaluate`，不扩大旧 grant。没有每 Task 新增额度、自动释放未知用量或复制预算上限。

模型 I/O 在事务外。`recordDispatch` 在 native followup 前持久绑定 round/session/message；独立持久回读形成 `recordNativeResult`，包含精确输入与 assistant 消息引用和输出原文哈希。`commitCandidate` 在短事务中瞬态解析原文，复核哈希、schema、共享预算结算、原生引用、controlEpoch、同目标 Task/Effect 版本、依赖和唯一归属。TaskFacade 仍是唯一 Task 状态机：非人类 `shiyu-core` Trigger 使用原 owner 委派 basis，Task/Assignment、共享预留、start intent、Goal 的 Task 关联和 proposal receipt 同库原子提交。无关 control commit 不使 read set 失效。

只有全覆盖原生用量才释放规划差额。未知调用/用量在重开后仍 unknown，不自动重派；已知原生结果和完整用量对应的确定性拒绝可经 `rejectEvaluation` 终结本轮，但不产生新触发。纯读 pending 过滤冻结、过期、额度不足、冷却和轮数上限；snapshot 的 planning 诊断不写预算账。已派发 round 由原生适配器每次 gate 实查 Goal，并受固定 lease 约束，不因开始前观察超过 60 秒就错误否定合法的 90 秒调用；首次进入仍必须新鲜确认。

全局暂停在 Task 同一事务中使活跃 Core round 失效。Goal 暂停先 suspend 共享授权；已 claim 的 Task 进入 unknown，必须独立核对。只有证明从未 claim、绑定 Session 或产生 Effect 的排队 Task，才可在 owner 明确恢复且获得新的 confirmed native resume 后，把旧未用预留按零用量结清，并在同一总额下重新预留。暂停后旧资格不能因恢复而复活。

可信 Task 成功事件与 `enqueueTaskFact({taskId,eventId})` 可在同一 Worker 事务中提交，保留统一事件因果；没有第二消费队列。完成候选要求所有 deliverables 的完整 Task/Effect/receipt 证据，并由宿主逐项重新检查实际文件。Core 与原 Goal 生命周期诊断共用 `inspectTaskEvidence`；pending native complete 只允许其精确既存 proof 的第二次独立核验，unknown 不允许重发。

2026-11-02 本轮模块证据：Core 控制域 **19/19**，同批原 Task 13、Goal 生命周期 12、授权目录 26，共 **70/70** 通过，类型检查及 diff 检查通过。覆盖真实临时 SQLite 和 commit watermark、准入回滚、共同预算、非人类来源、旧轮失效、暂停恢复、重开、未知用量、来源冲突、无关提交和篡改完成回执；Native 回执是明确的合成替身，未调用真实 DSH 宿主或模型，不能视为业务宿主验收。
