# Matrix / Synapse

## 基本信息

| 项目 | 当前记录 |
|---|---|
| 类型 | Matrix 聊天协议与 Synapse homeserver |
| 用途 | DS-Group 的人类与 Bot 成员、群组与私聊、消息持久化和离线同步 |
| 来源 | [Matrix 客户端—服务器规范](https://spec.matrix.org/latest/client-server-api/)、[Synapse 官方仓库](https://github.com/element-hq/synapse) |
| 固定版本 | Synapse 1.164.2，官方 `ghcr.io/element-hq/synapse` ARM64 镜像 |
| 固定镜像摘要 | `sha256:37090b4e5f26171922321a6acd1acf2675cb862f3b0cdf368f0dbbae6a70439a` |
| 采用依据 | 用户授权 DS-Group 首框架、真实逻辑闭环和无人值守自主选型后，实施代理选择此服务作为首切片聊天核心 |
| 状态 | 首切片采用并完成限定本机实测 |
| 实施位置 | `apps/ds-group/scripts/matrix.mjs`、`src/matrix-client.mjs` 与 `src/core.mjs` |
| 运行数据 | `apps/ds-group/.local/matrix/`，Git 排除 |

## 机制与本轮证据

| 结论 | 证据类型 | 核查与验证范围 | 限制 |
|---|---|---|---|
| 人类与 Bot 使用独立成员身份 | 本轮真实 HTTP | Alice、Bob、财务、人事四账号入群，发送者 ID 可核对 | 合成成员 |
| 消息引用与发送去重可复用 | 本轮真实 HTTP | 原生回复关系，同一发送 transactionId 返回同一 eventId | 首批文本场景 |
| 私聊可以沿用房间机制 | 本轮真实界面与模型链路 | 真人间私聊、真人与 Bot 私聊、共同群与私聊切换 | 固定演示目录 |
| 离线成员可从游标补收 | 本轮真实节点恢复及模块验证 | Bot 接入进程停止后补收一次，不重复生成 | 完整物理网络故障待验 |
| 核心可有序停止再启动 | 本轮真实服务验证 | 容器、核心和节点重启，身份/Session/消息记录保持，零新增生成 | 单台 Mac |

证据入口为[Matrix 实测](<../apps/ds-group/artifacts/matrix-smoke.json>)、[服务生命周期](<../apps/ds-group/artifacts/service-lifecycle.json>)和[DS-Group 实施记录](<../apps/ds-group/实施记录.md>)。

## 适配选择

Matrix 保存共同会话，Bot 的原生 Session、主对话队列与工作状态分别留在独立节点。DS-Group 在消息扩展字段记录目标 Bot、任务与原始房间，使用确定的 transactionId 恢复发送。模型生成由 DS-Bot/DSH 承接。

首切片以一个 homeserver 和 SQLite 运行为基线，关闭开放注册，初始化四个合成成员。未来扩展真实多机、任意成员、附件与更大容量时分别验证。当前网页为本机演示身份入口，生产账号体验仍需独立实现。

## 待验证事项

物理跨机器加入、长时间断网后的大批量补收、附件传递、成员变更、跨服务器联邦和持续负载尚待验证。首版任务不依赖联邦。
