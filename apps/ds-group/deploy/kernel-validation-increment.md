# 运行时与发行包修补复验（2026-11-07）

本批次统一来源为产品基准 `9898c624431f76123f6dc03346503af8e65ab744`，叠加 `9770272`（官方 Session 测试夹具）、`a542444`（快照重写先于用量观察）、`69caeef`（Bot 联系人知识隔离），发行门禁为 `9565006` / `9e1dda6`。内核 `0.4.0`、上游 DS-Bot `0.3.1`、DSH `0.2.2-rc.1`、Node `24.19.0`。[机器可读汇总](evidence/runtime-increment-69caeef/summary.json)记录本批次全部报告和原件摘要。

此前 `9898c62` 的[部分通过记录](kernel-validation-9898.md)保留了四次 provider 请求生成七条 claim 的失败。本次修补后的文件任务为四次请求对应四条完成回执；native 旁听也只记录一次实际调用。两个阶段分别留证。

| 固定产物 | SHA-256 |
| --- | --- |
| 594 文件源码包，校验后只读提取执行 | `8525539b71a9b22220a0cee31f32183fe0cf4f057a632fdbb8688d35df4660fd` |
| npm `0.4.0-alpha.1`，251 文件，2,420,929 bytes | `0cdd801dc83df8c7fb3451cab985d169f6dcf85fbb9fb183e6181c03b950d54d` |

## 本轮实测

两架构均使用单独安装的官方 CLI 和私有冻结依赖，没有挂载仓库 `node_modules`。ARM64 为原生 Docker，amd64 为同机模拟 Docker。下列脚本 provider 均监听容器本地，所有远端模型调用为 0。

| 检查 | Linux ARM64 | Linux amd64 | 实际覆盖 |
| --- | --- | --- | --- |
| 官方 SDK 契约 | [22/22](evidence/runtime-increment-69caeef/sdk-arm64.json) | [22/22](evidence/runtime-increment-69caeef/sdk-amd64.json) | 真实 SessionStore / SessionProjectionRegistry、schema、压缩及原文保留；联系人工具和回顾输入隔离；实际 Cordis stream 顺序。两份官方安装均确认没有 testkit，无新增开发或产品依赖 |
| owner、真实 Session、工具编译与重启 | [10/10](evidence/runtime-increment-69caeef/kernel-arm64.json) | [10/10](evidence/runtime-increment-69caeef/kernel-amd64.json) | 65 个唯一工具，含 `raw_source_query`；同 home 只有一个内核；0 provider 请求 |
| 文件、成品、回执、后台取消 | [6/6](evidence/runtime-increment-69caeef/work-arm64.json) | [6/6](evidence/runtime-increment-69caeef/work-amd64.json) | 各 6 次本地响应；首任务 4 请求/4 claim、真实 read/bash/read、成品 hash、运行及排队取消与后台进程停止 |
| native 成员、旁听、回顾、重启 | [6/6](evidence/runtime-increment-69caeef/native-arm64.json) | [6/6](evidence/runtime-increment-69caeef/native-amd64.json) | 各 4 次本地响应与 4 次观察，含自动记忆回顾；三次 NativeBridge 请求各计 1 次用量；0 legacy claim |
| 快照、冷恢复、自动/手动压缩及 part 转移 | [8/8](evidence/runtime-increment-69caeef/snapshot-arm64.json) | [8/8](evidence/runtime-increment-69caeef/snapshot-amd64.json) | 各 13 次本地响应；当前派生快照替换，原始人类/Bot/工具事件保留 |
| scoped 文件工具与授权撤销 | [8/8](evidence/runtime-increment-69caeef/scoped-arm64.json) | [8/8](evidence/runtime-increment-69caeef/scoped-amd64.json) | 各 10 次本地响应、37 项授权断言，实际宿主与文件工具 |

本组合通过 700/700 模块及类型检查。新 npm hash 在 macOS ARM64 上[干净安装 7/7](evidence/runtime-increment-69caeef/npm-clean.json)，包含真实 Linux ARM64 Synapse 的双人消息、回复和附件往返；同包[真实 DSH 界面 9/9](evidence/runtime-increment-69caeef/native-ui.json)，0 本地/远端生成、0 浏览器异常。前端源码与 `9898c62` 生产构建相同，此次包复用了该构建。

## 发行边界

本增量修改 Bot 记忆运行路径和测试夹具。Core 实现未改，按协调决定没有重复构建完全相同执行路径的 Core 镜像或重跑 Compose；其两架构各 10 项聊天部署及 5 项 API-only 部署证据继续属于[原 `9898c62` 源码和镜像身份](evidence/9898c62/summary.json)。本文件的运行时与 npm hash 独立记录。

`test:kernel-host` 已加入 stream 账目顺序检查，联系人隐私回归由同一 SDK 命令自动执行。十项正式 CI 矩阵保留，真实 snapshot-runtime 增加到既有两项 DSH 作业内。本地通过结果不能替代最终统一 head 的远端 CI；旧 CI `42335611379` 只覆盖其 `0294a3f`。

这些本地响应证明请求、工具与生命周期契约；远端模型的自然工作验收由主线程另记。所有容器位于同一物理机器，物理跨机器的网络与故障场景没有在本批次复验。实际部署入口见[内核运行说明](kernel-runtime.md)。
