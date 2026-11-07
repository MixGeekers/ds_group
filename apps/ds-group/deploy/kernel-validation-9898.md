# `9898c62` 固定源码发行增量（2026-11-07）

本批次基于产品提交 `9898c624431f76123f6dc03346503af8e65ab744`，内核 `0.4.0`、上游 DS-Bot `0.3.1`、官方 DSH `0.2.2-rc.1`、Node `24.19.0`。机器可读记录为[本批次汇总](evidence/9898c62/summary.json)。上一批 `b3add9b` 组合的[验证记录](kernel-validation.md)、原包与失败证据保留，不将其结果扩展到本次源码。

本批次状态为**部分通过**：部署、打包、真实工具注册与快照生命周期检查通过；多步独立文件任务暴露重复账目回执，新增 SDK 夹具另待开发依赖接线。此记录不表示当前候选已完成全部发行验收。

## 固定产物

| 产物 | SHA-256 | 验证范围 |
| --- | --- | --- |
| 569 文件源码包 | `eb24dd88d3a4f35bc71a0b563c3e232e1c857fd4076e3fdd5a7873cbccb3dcff` | 两架构真实宿主、Core 镜像及 Compose；增加必需快照源码入口的打包门禁 |
| 严格工具门禁源码包 | `0f697fc28c803b7ff651bb731870c2b4320f3fc64da5adb3807933949e812820` | 同产品源码，加发行检查提交 `9565006`，要求实际注册 65 个唯一工具名 |
| npm `0.4.0-alpha.1`，251 文件，2,418,657 bytes | `37f6c314d38745e393d8e61b4f8635426dac62bc84c6b5b37e9eb846fa21e067` | 新目录打包、干净安装及真实 DSH 界面；旧 `fda5e4…` 包未覆盖 |

源码包经 SHA-256 与逐文件清单校验后提取，Linux 测试只读挂载该提取目录。官方 SDK、冻结私有依赖和合成 home 分别安装；没有使用用户 DSH home 或凭据。新 `memory/snapshot-context.mjs` 必须随源码包与 npm 包发行，标准 `zod` 及官方 token meter 在实际快照测试中解析执行。

## 本轮实测

ARM64 为同机 Docker 原生执行，amd64 为同机 Docker 模拟执行。下表本地响应均来自脚本 provider，远端模型调用均为 0。

| 检查 | Linux ARM64 | Linux amd64 | 证据与用量 |
| --- | --- | --- | --- |
| 真实内核、空状态、重复 owner、重启 | [10/10](evidence/9898c62/kernel-strict-arm64.json) | [10/10](evidence/9898c62/kernel-strict-amd64.json) | 0 provider 请求；实际编译全部 65 个唯一工具，含 `raw_source_query`，报告保留完整名单 |
| 独立节点身份、配置与迁移 | [17/17](evidence/9898c62/runtime-arm64.json) | [17/17](evidence/9898c62/runtime-amd64.json) | 0 provider 请求；中断任务不重放 |
| native 成员、完整工具、旁听与自动回顾 | [5/5](evidence/9898c62/native-arm64.json) | [5/5](evidence/9898c62/native-amd64.json) | 各 3 次本地响应，含 1 次自动记忆回顾；0 legacy claim |
| 当前快照、冷恢复、原生自动/手动压缩及 part 转移 | [8/8](evidence/9898c62/snapshot-arm64.json) | [8/8](evidence/9898c62/snapshot-amd64.json) | 各 13 次本地响应；原始快照事件保留，每次请求只有当前派生快照 |
| 多步文件工作与账目 | [失败](evidence/9898c62/work-arm64.json) | [失败](evidence/9898c62/work-amd64.json) | 各 4 次实际响应、3 次真实工具执行，成品与 hash 正确；却生成 7 个完成 claim，未进入后续取消检查 |
| 跨服 scoped 工具与撤销 | [8/8](evidence/9898c62/scoped-arm64.json) | [8/8](evidence/9898c62/scoped-amd64.json) | 各 10 次本地响应、37 项授权断言；合成权威、实际 DSH 与文件工具 |
| Compose 聊天、观察、重建、备份恢复 | [10/10](evidence/9898c62/deploy-arm64.json) | [10/10](evidence/9898c62/deploy-amd64.json) | 实际 Core/Synapse/适配进程；桥接夹具禁止生成，容器架构逐项核对 |
| API-only、中央身份、独立后台与治理 | [5/5](evidence/9898c62/platform-arm64.json) | [5/5](evidence/9898c62/platform-amd64.json) | 实际 Compose、持久卷及重建；所有测试容器/卷清理完成 |

本工作树另通过 694/694 模块检查、生产构建及 14 项打包/冻结依赖/解析检查。新 npm 包在 macOS ARM64 上[干净安装 7/7](evidence/9898c62/npm-clean.json)，连接真实 Linux ARM64 Synapse 验证双人消息与附件往返；同一 npm hash 的[真实 DSH 界面 9/9](evidence/9898c62/native-ui.json)，0 本地/远端生成、0 浏览器异常。新增 SDK projection/claimed-context 夹具的开发 testkit 安装尚未收敛，未将它们计为本线通过。

## 未解决项及后续复验边界

文件任务的失败由快照请求改写再次进入 `llm/stream` 钩子触发：首步一个 claim，后续三步各两个 claim，底层只有四次 provider 请求。不得把断言改成允许七个 claim；需修复重复账目，再用新源码单独记录文件工具、回执与取消复验。当前快照 13 次响应的通过证明请求构造及生命周期，不证明旧独立节点账目路径正确。

发行检查 `9565006` 在既有十项 CI 矩阵中补入真实 snapshot-runtime 检查，并上传其报告；源码与 npm 打包都要求快照 helper 存在。旧远端 CI `42335611379` 的十项全绿仅属于 `0294a3f`，本批次没有借用该状态。后续业务及账目修补需固定新源码后复验与重新跑 CI。

本批次全部容器仍在同一物理机器，不构成物理跨机器或远端模型语义验收。实际部署与健康入口沿用[内核运行说明](kernel-runtime.md)：

```sh
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
curl --fail http://127.0.0.1:18100/readyz
```
