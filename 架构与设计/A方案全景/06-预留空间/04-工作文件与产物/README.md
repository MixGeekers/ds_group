# 工作文件与产物 · 对象发布与回收

[所属区域](<../README.md>) · [完整目录](<../../目录.md>) · [验证与验收](<../../验证与验收.md>)

更新：2026-11-01。模块 ID：`artifacts`。**建议验证基线，未实施、未实测。** 本页定义方案，不创建运行数据库或数据根。

## 主方案

**复用更新：**Ombre 记忆附件直接使用其 `MediaStore`；已核它具有限额、临时来源允许范围、稳定 hash 路径与临时写入 / fsync / replace。不要再复制一套记忆媒体存储。它面向受限媒体附件，不自动覆盖任意任务目录、可执行产物、任务租约或配额；通用任务产物仍复用 Node 标准 fs / crypto 原语，识雨只补授权目录、对象引用与 GC 政策。不是再建通用对象服务。

本页随机 objectId 协议仅管识雨通用产物；Ombre 原生内容寻址路径由组件内部持有，以 opaque backendRef 隔离，并纳入显式删除。MediaStore 原接口没有证明目录 fsync、跨 Store 事务、完整备份包含媒体，均列入 V15 / V16 / V22，不因已有原子 replace 就宣称全部耐断电。组件方案与源码路径见[复用核查](<../../../../research/2026-11-01-复用核查/数据空间.md>)。

复用本地文件系统、SHA-256 与 Node 文件 API，构建薄 ObjectStore 协议，不自造分布式对象存储。worker 的可变工作目录和对外可引用的不可变产物分离；每个 taskId / assignmentId 限定路径、容量和保留时间。最终 ObjectRef 使用随机 objectId，hash 作为私有完整性校验而非公开地址或跨主体关联键。

## 接口与元数据

| 对象 / 操作 | 定义 |
|---|---|
| ArtifactIntent | taskId、assignmentId、hostEpoch、fencingToken、mime、maxBytes、retentionClass、privacyClass |
| object_records | objectId、sha256、size、mime、storageKey、createdAt、status、retentionClass、privacyClass；objectId主键 |
| object_refs | ownerType、ownerId、ownerRevision、objectId、purpose；有效引用与所属业务事务同提交 |
| object_pins | objectId、pinType、pinId、expiresAt；用于活动任务、检查点、恢复、明确用户保留 |
| publish / resolve / release | 只有 ObjectStore 接触实际路径；ReadView取得限时授权引用，不得到任意文件读取能力 |

## 文件与数据库一致性

1. 在同一目标文件系统的 staging 创建独占临时文件；流式计算 SHA-256、限额并校验 MIME / 大小。不能直接把 worker 可继续修改的文件作为最终对象，也不能信任传入的摘要。
2. 完成写入并显式同步文件，关闭后以对象 ID 发布到最终路径，按目标 OS 的目录同步能力完成持久化步骤；禁止跨卷 rename、路径穿越、符号链接逃逸或覆盖已有不同对象。平台未验证此步骤时，不承诺断电持久性。
3. 文件发布成功后，UnitOfWork 事务记录 object_records 与 object_refs 并提交对应业务状态 / outbox。文件系统与 DB 没有跨系统原子事务，采用“先发布对象，再提交引用”的可恢复协议。
4. 发布后 DB 失败只留下未引用孤儿，按宽限期回收；DB 已引用而文件缺失是完整性故障，读取失败并进入核对 / 备份恢复，不能让模型补造内容。

重启扫描只处理 staging / 未引用对象；GC 先标候选、在事务里核对引用、pin、删除水位与宽限期，再删除物理文件并记结果。新引用只允许指向 live 对象，不能与已进入删除阶段的对象竞态复活。对象 hash 与随机身份均按删除政策清除；正文不留在命令行、常规诊断或审计副本中。

## 预算与恢复

验证默认单产物上限 100 MiB、单任务工作空间 500 MiB，均为配置参数。工作临时文件终态后 7 天、未 pin 产物 30 天进入清理；活动 / unknown / 交付中的产物保持 pin。磁盘压力先拒绝新下载和大产物，只回收无引用无 pin 的可删除项。APFS 本地快照不能替代独立备份。

## 验收与替代条件

[V15](<../../验证与验收.md#v15>) 在写入、同步、发布、DB 引用前后逐点中断：无业务引用指向半写文件，孤儿可收敛，已提交产物 hash 不变。用小临时卷 / 注入 I/O 错误验证限额，不填满用户真盘；路径逃逸、符号链接和同名覆盖全部拒绝。[V22](<../../验证与验收.md#v22>) 验证 GC 与检查点并发不会删除已 pin 产物。

当数据必须由多个独立主机共享或本地容量明确不足，再用现成 S3 兼容存储适配 ObjectRef；不改变业务引用协议，也不通过 NFS 共享 SQLite 文件。

## 证据与适用限制

一手资料、静态核查范围与具体链接见[数据空间证据](<../../../../research/2026-11-01-完整架构/数据空间.md>)。以上业务字段、默认参数与通过标准是识雨的设计建议，不是上游软件自动提供的能力。

