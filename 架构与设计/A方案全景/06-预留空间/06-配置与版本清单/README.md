# 配置与版本清单 · 可解释迁移

[所属区域](<../README.md>) · [完整目录](<../../目录.md>) · [验证与验收](<../../验证与验收.md>)

更新：2026-11-01。模块 ID：`config`。**建议验证基线，未实施、未实测。** 本页定义方案，不创建运行数据库或数据根。

## 主方案

**复用更新：**宿主自身配置继续调用 DSH 公共设置接口；识雨需历史与当前指针的配置，优先局部复制 Superagent `src/app/versions.ts` 的 `Versions.current/get/save/list` 与 `src/kv.ts` 的 `Key / Family / record / family`，不从零实现版本仓储。Versions 只依赖 get / set / keys / atomic；保留 MIT 声明，替换类型导入和 key namespace。产品 schema、用途权限、激活前验证及保留期限仍由识雨定义。

Ombre、控制 Store 与 DSH 各自维护 schema / 版本，不给它们强行共享 schemaVersion。RuntimeManifest 增加 componentId / upstreamCommit / localPatchDigest / dataSchema / compatibleRestoreVersions；组件升级分别预备备份并核对引用，混合版本不得冒充一次原子迁移。上游 Superagent schema10→11 的特定迁移不可直接当作识雨全版本迁移器。精确闭包与证据见[复用核查](<../../../../research/2026-11-01-复用核查/数据空间.md>)。

复用 JSON Schema 校验与宿主 profile / 生命周期，配置作为有版本的领域对象，不由模型改写任意运行文件。配置只存秘密引用。业务配置、软件部署清单、数据库 schemaVersion、模型版本与实际运行健康分开，不能因为文件宣称某能力存在就把它标为可用。

## 输入输出与清单

| 清单 / 表 | 字段与所有者 |
|---|---|
| RuntimeManifest | DSH commit、Node patch、实际SQLite版本 / compileOptions、插件版本、架构、Schema版本、构建摘要；宿主探测写报告 |
| RootManifest | rootId、规范绝对路径、volumeId、FS类型、reserve/quota、外置项；路径探测与管理员配置共同核对 |
| config_versions | configId、version、schemaVersion、bodyRef、sha256、createdBy、status、previousVersion；唯一版本不可变 |
| config_activation | configId、activeVersion、lastKnownGoodVersion、activatedAt、validationReceipt；由受控配置命令切换 |
| schema_migrations | migrationId、fromVersion、toVersion、checksum、minimumReaderVersion、checkpointId、status、completedAt |

配置输入只能来自明确设置或经审核的变更提案。流程为 schema 校验 → 引用 / 能力前置检查 → 隔离验证 → 小范围启用 → 功能探测 → 记录 lastKnownGood。任何一项失败保留旧活动版本并给具体失败原因。只读状态视图显示配置值与探测事实及时间，不显示明文密钥。

## 数据迁移与回滚

普通加列 / 索引等可逆迁移以固定校验和、显式 schemaVersion 运行；禁止启动时静默升级未知新 schema。迁移前进入维护状态、停止派工、清空写入队列并生成一致 BackupBundle。破坏性迁移在独立影子副本执行，校验 entity / task / object_ref / tombstone 约束后，在仍停写的窗口切换数据根版本；一次只允许一个迁移持有锁。

代码回退只在其 minimumReaderVersion 兼容当前数据时允许。迁移后已有新写入时，不能直接覆盖回旧快照造成数据丢失；选择兼容旧读取模式、修复迁移或停止后执行有明确信息损失评估的恢复流程。失败迁移不进入“已恢复”状态。

## 生命周期与权限

保留当前、lastKnownGood 和最近两个通过验证的候选配置；涉及未完结迁移或检查点引用的版本保持 pin。设备配对、授权策略和模型外发政策变更分别递增相应版本 / authEpoch。进程停用状态与 hostEpoch 按恢复专题管理，旧配置恢复不能自动恢复旧派工权限。

## 验收与替代条件

[V15](<../../验证与验收.md#v15>) 用旧schema→新schema、错误校验和、半途退出、不兼容旧代码、路径卷被替换等用例验证：不能开错库、不能部分迁移后继续派工、无静默丢失新任务。启动报告显示实际运行版本，拒绝已知不满足WAL门槛的构建。

先用显式短迁移脚本清单和 SQLite 事务，不建立自研迁移平台；表量或多人协作增大后可评估既有迁移工具，前提是保留上述维护锁与恢复契约。

## 证据与适用限制

一手资料、静态核查范围与具体链接见[数据空间证据](<../../../../research/2026-11-01-完整架构/数据空间.md>)。以上业务字段、默认参数与通过标准是识雨的设计建议，不是上游软件自动提供的能力。

