# SQLite 与识雨领域事务

[候选目录](<目录.md>) · [数据空间方案](<../架构与设计/A方案全景/06-预留空间/README.md>)

记录日期：2026-11-01。状态：**已初评，选为本轮验证基线**；不是已实施。证据为官方文档与限定源码核查，未运行数据库或故障实验。

复用 Superagent 局部 Store 的本地 SQLite 控制 / 任务账本、事务 / 约束 / 在线备份。**2026-11-01 复用核查改为组件分域优先：Ombre 记忆正文不强迁入该库，FTS5 为本地对照 / 回退。** Node 24.22.2 的内置绑定是首验证候选，实际 SQLite 需达到 WAL 修复门槛；SQLite 本体为 public domain，绑定 API 的成熟度和宿主版本另记。[官方使用范围](<https://sqlite.org/whentouse.html>)、[许可](<https://sqlite.org/copyright.html>)。

DSH storage-domain 可以原子保存一条聚合及 pendingEvents；不能把多次 put 称为跨表事务。已有 Superagent atomic / 聚合 JSON / receipt / effect 片段优先局部复制，识雨只补受限提交、授权与未知结果处理，不自写通用 Repository。控制库本地事务与 Ombre 操作通过 MemoryOperation / 核对衔接，不承诺跨服务原子；单库不是采用组件的硬门槛。[新核查](<../research/2026-11-01-复用核查/数据空间.md>)记录精确闭包、SAVEPOINT / Promise / rollback 补丁和恢复限制。

| 机制 | 证据与限制 | 验证 |
|---|---|---|
| WAL 与事务 | [官方WAL](<https://sqlite.org/wal.html>)：同机访问、网络文件系统限制；多库不是整体原子；运行版本需核查修复 | V01/V06/V12 |
| FULL同步、外键、短事务 | 不是断电可靠性的自动保证；模型和网络不在事务中 | V15及崩溃断点 |
| FTS5 与中文检索 | 本地对照 / 回退复用FTS5，中文预分词用Intl.Segmenter；组件路线先复用Ombre原生检索 | V07/V25 |
| 一致备份 | 在线备份与对象引用清单共同形成恢复材料 | V22/V27 |

详细来源与绑定备选见[数据证据](<../research/2026-11-01-完整架构/数据空间.md>)。内置绑定门槛失败才评估固定版 better-sqlite3；多中心写入或实测吞吐确有需求时再比较服务型数据库。2026-11-01 的选择来自本轮规划，未新增安装或运行授权。
