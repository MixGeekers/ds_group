# `79ae498` 固定候选发行复验（2026-11-07）

当前候选固定源码 `79ae498bbf6cfede961cfdb6643c83046ea433e2`，内核 `0.4.0`、DS-Bot 上游 `0.3.1`、官方 DSH `0.2.2-rc.1`、Node `24.19.0`。本线合并后的文件树与该提交一致，随后冻结包并只读验证。[汇总及原件摘要](evidence/79ae498/summary.json)与[push CI 记录](evidence/79ae498/ci-run-42348699620.json)独立保存；较早 [e284b21 候选](kernel-validation-e284.md)的包、通过结果和历史失败均未覆盖。

| 候选产物 | SHA-256 | 内容 |
| --- | --- | --- |
| `ds-group-0.4.0-source.tar.gz` | `580de36cf5ab66c7087e8805c82bf2cd400ec8b01f53c7d4ed45167e6d5516f5` | 638 文件；源码、Compose、冻结依赖和复验脚本 |
| `dscord-0.4.0-alpha.1.tgz` | `c07243c95b963a99da567387a936cb2514a639b197cd845ec81f16c8a0de5e09` | 252 文件，2,427,071 bytes；含新的必需 `src/native-request.mjs` 和预构建前端 |

本线已从[固定 CI 的源码下载产物](https://github.com/MixGeekers/dscord/actions/runs/42348699620/artifacts/13563809712)实际下载并逐文件核验，源码包与本地候选 SHA-256 完全一致。npm 候选在交付中单独提供，以上 hash 不表示 npm registry 已发布该版本。

## 受影响路径的本轮实测

此次增量涵盖通用自主交付/自包含提示、可选 `raw_source_query.authorKind`、可靠历史请求中旧派生 `memoryView` 的官方投影，以及正常 NativeBridge 和 direct-checkpoint 的当前快照替换。原始人类、Bot、工具消息保留；上下文投影与原始持久事件分别验证。打包门禁要求新 helper 存在，私有依赖和锁没有新增包。

两架构测试只读挂载校验后提取的源码，SDK 和冻结私有依赖在独立目录。ARM64 为本机 Docker 原生，amd64 为本机 Docker 模拟。共享 SDK 和主线程业务源码未修改。

| 检查 | Linux ARM64 | Linux amd64 | 具体范围 |
| --- | --- | --- | --- |
| 官方 SDK 契约 | [28/28](evidence/79ae498/sdk-arm64.json) | [28/28](evidence/79ae498/sdk-amd64.json) | 真实 Session/Projection、来源和联系人范围、可靠请求派生视图投影、stream 账目及后台回顾 abort/重开/关闭后 SQL 检查；无 testkit 依赖 |
| native 成员、完整工具、观察和回顾 | [6/6](evidence/79ae498/native-arm64.json) | [6/6](evidence/79ae498/native-amd64.json) | 各 4 次本地 HTTP 脚本响应与 4 次观察；三条 Bridge 回执各计 1 次调用 |
| 增强快照、冷恢复、原生压缩及 checkpoint | [10/10](evidence/79ae498/snapshot-arm64.json) | [10/10](evidence/79ae498/snapshot-amd64.json) | 各 14 次本地 HTTP 脚本响应；旧持久请求、正常 NativeBridge、direct-checkpoint、自动/手动压缩及原文保留 |
| 文件工具、成品、账目及取消 | [6/6](evidence/79ae498/work-arm64.json) | [6/6](evidence/79ae498/work-amd64.json) | 各 6 次本地 HTTP 响应；首任务 4 请求/4 claim，成品 hash、运行及排队取消、后台进程停止 |
| owner、工具注册和同 home 重启 | [10/10](evidence/79ae498/kernel-arm64.json) | [10/10](evidence/79ae498/kernel-amd64.json) | 实际 65 个唯一工具，报告包含新 helper 的源码 hash；0 provider 请求 |

生产前端重新构建通过。同一 npm hash 在 macOS ARM64 上[干净安装 7/7](evidence/79ae498/npm-clean.json)，连接真实 Linux ARM64 Synapse 验证双人消息、回复和附件往返；[真实打包 DSH 界面 9/9](evidence/79ae498/native-ui.json)，0 本地/远端生成、0 浏览器异常。

所有网络模型响应均来自本地脚本 provider，远端模型调用为 0。SDK 另外使用进程内合成 adapter 验证挂起、晚结束和中止，其调用在测试内部断言，不记作零本地调用；runner 未汇出 adapter 总计。

## 固定 head 的正式 CI

[push run 42348699620](https://github.com/MixGeekers/dscord/actions/runs/42348699620) 的 head 为同一完整 `79ae498`，**10/10 success**：四组 Linux/Node、两组 DSH、两组 Docker/Compose、一组 Chromium 和汇总门禁。连接器分别核对 run、jobs、产物及 Native Linux amd64 / Node 24.19 日志，后者原 checkout 与干净提取包两遍都是 738/738。

本机沿用既有 Core/Compose 固定证据，没有重复完整部署矩阵；Core 服务、UI 与部署逻辑未新增变化。此轮正式 CI 已从 `79ae498` 源码包在对应 Linux runner 重新构建两个架构镜像，并通过聊天、备份恢复和 API-only 治理部署检查。

这批记录只属于 `79ae498` 候选。主线程后续业务修复反馈和原始 96 消息审阅另有证据；追加文档的后续 head 及其 CI 状态另按实际记录。本线没有执行远端模型或物理跨机器验收。部署和健康入口见[内核运行说明](kernel-runtime.md)。

```sh
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
curl --fail http://127.0.0.1:18100/readyz
```
