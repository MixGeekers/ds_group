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
