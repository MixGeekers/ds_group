# 内层发布与本地读取权威

本模块是 3C 的最小控制接缝。`publication.ts` 持久保存已发布的内层组合投影清单；`safety.ts` 管理仅限本地 Task 状态读取的政策和来源撤回屏障。二者都共用控制 Worker 的 SQLite 连接及 `SqliteTransactions`，不存 Ombre 正文、不启动模型或后台循环。

`StatePublicationStore` 的版本由真实发布产生。首次显式发布六域 `unavailable/not_connected` 才得到 `stateVersion=1`；初始化前 `get()` 返回 `undefined`，GET 不补发布。六域为记忆、关系、情绪、认知、人格、能力，当前 schema 拒绝声称任何一域已连接或提供正文。Task/Conversation/commitSeq 的变化均不推进这个版本。以后发布须同时提供当前 `expectedBaselineId`、`expectedStateVersion`；完整清单和发布回执原子提交。相同清单的新命令会保存 `unchanged` 回执而不改已发布版本；幂等重试返回该命令原来的历史回执。

可信 composition 用 `createStatePublisher()` 创建不可经 JSON 复制的进程内能力；发布者配置固定保存在基线中，变更需显式迁移。发布清单自带 `baselineId/stateVersion/manifestHash/publishedAt/publisherId`，不能将 hash 或本地序号当作远端后端 CAS。当前清单只说明接入可用性，不代表内层业务已实现。

`LocalReadSafetyStore` 在启动显式安装持久政策：`policyAuthorityId/policyVersion/enabled`。读取禁用/恢复通过可信 owner 能力和基线＋版本 CAS 变更；重开保留禁用状态，不自动恢复。`authEpoch` 始终读取现有 `MandateStore.health()` 的全局真实值，本模块没有第二个授权 epoch。

`deletionAuthorityId/tombstoneWatermark` 的范围明确为 `local-task-source`，仅负责从本地 Task ReadView 撤回来源；初始零来自真实持久行，含 `installedAt` 和 `since-local-read-authority-installation` 基线，不代表历史删除已补齐。撤回永久保留来源屏障并使旧 capture 失效；尚无恢复命令。此机制不声称已删除 Task 原始账本、Ombre 正文、索引或备份。读取政策和删除元行缺失时失败关闭，不通过 GET 重新创建。

`ViewDomain` 在同一同步只读事务中捕获这些头与 Task/Conversation 来源；`views/local.ts` 只组合这份固定 capture。ReadView 的可选 `authority` 身份包含发布、政策、删除基线，进入安全摘要。没有接入派生检索索引，明确返回 `indexMode: 'not-used'`；兼容数值字段 `indexWatermark=0` 不是索引就绪证明。

2026-11-02 本轮合成验证使用真实临时 SQLite，不调用模型、Ombre 或真实宿主。发布测试 13 项涵盖双连接 CAS、基线、no-op、历史幂等、重开及写头后回执失败的原子回滚；本地 capture/Worker 的最终批次见控制库 README。实现为识雨新增代码，没有复制第三方状态库。
