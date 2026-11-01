# 独立域备份

> 2026-11-01 复用核查：restic 0.19.1 直接负责备份引擎；BackupBundle 仅为数据模块唯一 CheckpointService 的组合包，不另建导出器。采用 Ombre 时直接使用固定 `115d831` 的 `build_export_archive_file` / `GET /api/export`，复用其 SQLite snapshot、流式 hash manifest 与引用闭包。新增组件列表/水位/静默证明由数据模块产生；本模块只验证 ready 契约并调用 restic，不扫描活跃源或重做内部 manifest。源码、许可、CLI、补丁和替代路线见[复用核查](<../../../../research/2026-11-01-复用核查/恢复备份.md>)。未复制源码、安装或运行。

Ombre 自带 GitHub sync 是已存在的组件同步路线，其 Git ref 发布与每文件恢复原子性不能代表源目录同截面或全系统切换；可读原文上传与独立加密仓库有不同数据去向。主路线保留 restic，避免同时维护两套传输/保留引擎。Ombre 当前解压总上限 512 MiB，组件验证样本 ≤256 MiB；更大规模需固定限额补丁及资源验证，总 1 GiB 目标可由该组件与其他对象共同组成。

[所属区域](<../README.md>) · [完整目录](<../../目录.md>) · [全景图](<../../../图示/识雨全景架构-A.html>)

- 模块 ID：`backup-copy`。更新：2026-11-01。
- 状态：完整设计建议，待 V22 / V27 验证；未安装或创建仓库。

## 复用选择与非目标

主方案采用 **restic 0.19.1 + 独立 SFTP 仓库**；使用官方现成加密、去重和快照，不二次包裹自研密码学。目标设备没有 SFTP 时，可验证受支持的 S3 兼容对象存储或独立物理盘；要重新测试权限、吞吐和故障域。早期“tar 全量足够”的文档场景不适用于活跃数据库与长期恢复。

restic 仓库访问密码与服务端访问凭据分别管理。自动进程通过受信 `--password-command` 提供程序取得专用秘密，模型只看到引用和可用状态；避免把秘密放参数、普通环境日志、bundle 或代码库。另保留离线恢复凭据，验证主机完全丢失时仍可解密；没有密码就不能恢复，这是工具性质，不是可由模型推测解决的问题。[restic 仓库与密码官方文档](<https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html>)。

## 输入、状态和产物

| 对象 | 必需字段 / 规则 |
|---|---|
| BackupRequest | backupId、snapshotId、bundleRef、expectedManifestHash、repositoryRef、retentionPolicyVersion；仅接受 ready bundle |
| BackupRecord | queued / transferring / verified / failed / stale、resticSnapshotId、captureTime、completedAt、manifestHash、bytes、checkStatus、errorCode |
| RepositoryHealth | lastVerifiedCaptureTime、actualRecoveryPointAge、lastMetadataCheck、lastDataCheck、lastRestoreDrill、capacity / connectivity 状态 |
| RetentionDecision | 候选 snapshot ID、保留原因、删除请求关联、dry-run 差异、执行者与校验结果 |

备份服务只有读取 ready bundle、写指定仓库的权限；不获取内部提交入口、设备控制或任意恢复根目录写权限。prune 管理凭据与日常备份凭据分离，至少在具备相应后端隔离能力时执行；普通 SFTP 同账号有删除权限时不能宣称具备防篡改备份。

组件闭包必须包含 `dsh-goal-sessions`：由 CheckpointService 收集 GoalBinding 绑定的目标专用 Session log、必要 projection 定义/配置，以及实际 log seq、GoalRef revision、原生 phase/armed、DSH/plugin/projection 版本。须有受控 flush 或静默/停宿主闭合复制的证据，不能边写边裸拷日志；缺失、截断或无法核对则 bundle 不得 ready，restic 返回成功也不能标业务 complete。范围仅目标专用 Session，不备份无关聊天；本模块不另造 Session 导出器。

## 一致备份步骤

1. 向 CheckpointService 申请 snapshot。该服务先阻止物理对象 GC，用 SQLite Online Backup 得到独立数据库；完成后从该副本读取水位并列举 object_refs，不能用备份前的 live 数据猜水位。
2. 核对每个不可变对象存在及 hash / size，pin 住所有依赖直到 restic 完整确认；对象引用和数据库版本一起写 manifest，ready 标志最后原子发布。
3. restic 只读取 ready bundle；排除临时文件、可重建索引、运行锁、密钥明文和未关闭的活跃 DB / WAL。备份时仍可新增业务数据，GC 屏障防对象消失。
4. 收集成功退出码与 JSON summary，核对 snapshot 中 manifest 和预期源；restic 0.19.1 的 backup 退出码 0 表示完整成功，1 为致命失败，3 为部分源不可读的未完整快照。不可读文件、缺对象、部分备份或空快照均为失败，即使工具留下 snapshot ID 也不升级 verified。[固定版本退出语义](<https://github.com/restic/restic/blob/v0.19.1/doc/040_backup.rst>)。
5. 记备份结果并释放 bundle pin；若业务数据库不可写，把去敏 receipt 留在控制记录中供恢复后导入，不据此修改业务状态。
6. 每日元数据 check、每周完整 data check；大仓库可分片覆盖数据检查，但记录覆盖范围和完成周期。检查失败隔离仓库，保留最后已知良好副本，不自动 repair 后宣称健康。

SQLite 备份与 restic 传输分别处理不同一致性层。SQLite 官方支持在线备份；WAL 数据库需包含正确日志语义，不能只拷主文件。[SQLite 备份](<https://www.sqlite.org/backup.html>)、[WAL 说明](<https://www.sqlite.org/wal.html>)。restic 检查的数据范围取决于 check 选项，元数据 check 不等于读遍文件数据。[仓库检查](<https://restic.readthedocs.io/en/stable/045_working_with_repos.html>)。

## 保留、删除和密钥恢复

验证默认保留全部最近 7 天快照；30 天内每日保留 1 份，超过 30 天不自动保留，真实保留政策在启用前配置。执行前只列 dry-run 计划并核对最近有效快照与删除要求，执行后再次 check；备份、prune、restore 通过独占仓库维护锁协调。restic 的 forget 移除快照引用，prune 才回收不再引用的数据；二者完成前不能报告物理清除。[官方保留机制](<https://restic.readthedocs.io/en/stable/060_forget.html>)。

用户删除首先由内部生成墓碑，所有读视图和后续 bundle 遵守；备份中的旧数据仍可能存在。默认在备份保留窗到期清除；若要求更早清除，生成删除后的干净 bundle，明确列出受影响的旧快照并执行受控清理，接受相关旧恢复点丢失。恢复前总是叠加最新删除账本；最新账本无法取得则锁住恢复读取，不能从旧备份复活内容。restic 不理解单条业务记录，也不能在不重建数据库内容的情况下擦掉某份快照中的单条 SQLite 行。

仓库密码至少有独立离线恢复副本；验证能够在原机 Keychain 不可用时恢复。换访问密码或删除一个解锁 key 不等于重加密 / 擦除全部历史数据；疑似密钥泄露需要新仓库与新主密钥迁移，并按真实后端能力处置旧副本。append-only 后端可降低日常凭据删库能力，但官方文档指出恶意新快照仍可能影响保留策略；不把 `--keep-last` 单独当可信保留逻辑。

## 验证、失败与替代

[V22 / V27](<../../验证与验收.md>)：1 GiB 合成数据 3 轮写入与删除并发备份均可恢复；每轮 manifest 引用零缺失；阻断目的地与错误密码必须显示 failed / stale，不显示新鲜；故意去掉对象时不发布 verified；丢失原机后用离线凭据恢复；forget 后未 prune 不能误报已物理清除。RPO 以有效快照 captureTime 计算，超过 15 分钟告警；单批目标 ≤5 分钟，达不到则调低数据范围、增加带宽或调整明确的恢复目标，不掩盖实测。

Borg 仅在团队已有成熟运维、版本稳定且本用例实测明显更优时替换；Time Machine 可作额外机器级副本，不代替该业务一致性与恢复核对。没有独立目的地时只通过 V22，V27 保持未通过。证据见[核查记录](<../../../../research/2026-11-01-完整架构/恢复与备份.md>)。

