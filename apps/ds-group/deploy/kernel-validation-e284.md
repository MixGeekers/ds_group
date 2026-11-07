# `e284b21` 最终候选发行验证（2026-11-07）

本批次固定源码 `e284b218c0550a7ccd406ae3c6e1c1de35ebd2c8`，内核 `0.4.0`、上游 DS-Bot `0.3.1`、官方 DSH `0.2.2-rc.1`、Node `24.19.0`。本线合并后文件树与该提交一致，再冻结打包和只读宿主验证。[机器可读汇总](evidence/e284b21/summary.json)与[正式 CI 记录](evidence/e284b21/ci-run-42345080280.json)保留源码、包摘要和具体平台。

| 候选产物 | SHA-256 | 内容 |
| --- | --- | --- |
| `ds-group-0.4.0-source.tar.gz` | `26c8c5d51e14cacea4b421f5d5db5931def86be9f9328460b773db1d87028683` | 617 文件；含 Compose、源码、冻结依赖锁与复验入口 |
| `dscord-0.4.0-alpha.1.tgz` | `4050984460fa6e027f9a354cebd2cd02526d5f92fbd786b6d5f09ac2b57a2e16` | 251 文件，2,422,651 bytes；预构建前端与实际内核、记忆模块 |

源码可从[该固定 CI 的下载产物](https://github.com/MixGeekers/dscord/actions/runs/42345080280/artifacts/13563491397)取得。本线实际下载、检查清单和 SHA-256，确认其源码包与本地候选**逐字节相同**。npm 包在最终交付中单独提供，同名历史包按各自 hash 保留；此处记录候选包验证，不表示已发布到 npm registry。

## 本线最后增量

本次针对 `fcfe4a2` 的后台回顾中止与数据库关闭顺序复验。两架构均在只读提取后的源码包运行真实官方 SDK，私有依赖单独按随包锁安装。ARM64 为本机 Docker 原生，amd64 为同机 Docker 模拟。未修改共享 SDK 安装，也未修改父线程正在运行的业务源码。

| 检查 | Linux ARM64 | Linux amd64 | 本轮实际覆盖 |
| --- | --- | --- | --- |
| 官方 SDK、回顾停机与 stream 顺序 | [26/26](evidence/e284b21/sdk-arm64.json) | [26/26](evidence/e284b21/sdk-amd64.json) | 实际官方 LlmRuntime 与进程内挂起/晚结束/失败 adapter；1 秒内 abort、保留未回顾来源、重开可续、60 秒重试及 idle 等待中止、关闭后 SQL 为 0；SDK 不依赖 testkit |
| native 成员、完整工具、观察、自动回顾与重启 | [6/6](evidence/e284b21/native-arm64.json) | [6/6](evidence/e284b21/native-amd64.json) | 各 4 次本地 HTTP 脚本响应与 4 次观察；三条 Bridge 回执分别计 1 次调用 |
| 当前快照、冷恢复、原生自动/手动压缩与 part 转移 | [8/8](evidence/e284b21/snapshot-arm64.json) | [8/8](evidence/e284b21/snapshot-amd64.json) | 各 13 次本地 HTTP 脚本响应；保留原始人类/Bot/工具事件及同一原生 Session |
| 文件、账目与运行/排队取消 | [6/6](evidence/e284b21/work-arm64.json) | [6/6](evidence/e284b21/work-amd64.json) | 各 6 次本地 HTTP 脚本响应；首任务 4 请求对应 4 claim，成品 hash 与后台进程停止确认 |
| owner、实际工具编译与同 home 重启 | [10/10](evidence/e284b21/kernel-arm64.json) | [10/10](evidence/e284b21/kernel-amd64.json) | 65 个唯一工具、纯读空状态、重复 owner 拒绝；0 provider 请求 |

新 npm hash [干净安装 7/7](evidence/e284b21/npm-clean.json)，包含真实 Synapse 的双人登录、消息、回复及附件往返；同包[真实 DSH 界面 9/9](evidence/e284b21/native-ui.json)，0 本地/远端生成、0 浏览器异常。两项运行于 macOS ARM64，Matrix 为 Linux ARM64 容器。生产前端重新构建通过。

SDK 生命周期检查的进程内 adapter 属于合成测试，各断言内部检查其实际调用；测试 runner 未汇出 adapter 总计，不把它们写成零本地调用。上表 native、snapshot、work 的本地 HTTP 响应次数独立记录。全部检查的远端模型调用均为 0。

## 最终正式 CI

[Actions 42345080280](https://github.com/MixGeekers/dscord/actions/runs/42345080280) 的 head 为同一完整 `e284b21`，**10/10 success**：四组 Linux/Node、两组 DSH、两组 Docker/Compose、一组 Chromium 和汇总门禁。通过连接器分别核对 run、jobs 与下载产物，另读取 Native Linux amd64 / Node 24.19 日志确认原 checkout 和干净安装提取包两遍均为 725/725。

Core、前端与 Docker 实现相对 `9898c62` 未改，本机未重复原两架构 Compose 运行，原[本地部署证据](evidence/9898c62/summary.json)仍保留其源码与镜像身份；本次正式 CI 已在两个对应 Linux runner 从 `e284b21` 源码包重新构建并通过 Compose 聊天、备份恢复及 API-only 治理检查。

此前[重复账目失败](kernel-validation-9898.md)及其[修补复验](kernel-validation-increment.md)继续保留。远端模型的自然工作验收与本地发行检查分开记载；这批同机容器检查也不扩展为物理跨机器网络验收。

源码包解压后即可执行以下入口，完整参数见[内核运行说明](kernel-runtime.md)。

```sh
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
curl --fail http://127.0.0.1:18100/readyz
```
