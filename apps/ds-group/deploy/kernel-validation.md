# 自有内核发行验证（2026-11-07）

本轮为 DSCord `0.4.0` / npm `0.4.0-alpha.1` 候选，内核 `dscord-kernel@0.4.0`、owner API `1`、上游 DS-Bot `0.3.1`、官方 DSH `0.2.2-rc.1`。本文件覆盖 11 月 6 日至 7 日的固定源码验证；此前 `0.2` / `0.3` 的已发布历史证据保留。

机器可读总表为[发行验证汇总](evidence/release-validation-summary.json)。公共报告保留状态、检查项、源码 hash 和用量，宿主路径与临时认证值已脱敏；完整诊断留在各验证工作树的忽略目录。

## 固定源码与发行包

本线最终产品基准为 `b3add9b`，叠加运行时 `1c02640` / `135c61f`、记忆 schema `5e716dd`、打包后 UI 复验脚本 `ff76c07`，以及发行门禁 `738f9ab`。跨服脚本的只读目录适配为 `f33f21b`。后续自然语义改动需要新的源码与验证记录。

| 产物快照 | SHA-256 | 本次使用范围 |
| --- | --- | --- |
| 524 文件校验源码包 | `f863461da7cfb3c8acbd90a0fefd8ec45c6069cb6baabbc0d559a8f636083ce3` | SDK、内核、Session、原生及文件任务、两架构 Core 镜像与 Compose |
| 跨服脚本目录修补后的源码包 | `a2fa392e4078adf3bcda57c782035a6f9209c7f24e06c7b583a334770f85aef9` | 两架构跨服 scoped 真实宿主复验 |
| npm `dscord-0.4.0-alpha.1.tgz`，248 文件 | `fda5e4d313e66d932e1bd49f171af02af97fd697a975a4fd443574250fc1dfba` | 干净安装、真实 Matrix/Core 与打包后的真实 DSH UI |

Linux 宿主检查只读挂载提取后的源码包，容器内单独安装官方 DSH；没有挂载宿主或仓库的 `node_modules`。真实 SDK 契约通过同一宿主与冻结私有依赖解析，不另装一份 DSH。ARM64 为本机 Docker 原生执行，amd64 为本机模拟执行。

## 本线实测

下表两架构的每个报告均独立保留。列出的本地响应来自脚本 provider，远端业务模型调用均为 0。

| 检查 | Linux ARM64 原生 | Linux amd64 模拟 | 用量与证据级别 |
| --- | --- | --- | --- |
| SDK / 内核 / Memory 工具契约 | 11/11 | 11/11 | 实际 DSH SDK 编译，含 basis reference 必填字段、整数修订号和额外字段约束；合成服务及实际合成 ACP CLI |
| 内核健康、真实 Bot/Session 与工具注册 | [10/10](evidence/kernel-linux-arm64.json) | [10/10](evidence/kernel-linux-amd64.json) | 0 provider 请求；真实编译 64 个工具，含记忆及文件工具 |
| 独立节点 Session、模型配置与迁移 | [17/17](evidence/runtime-linux-arm64.json) | [17/17](evidence/runtime-linux-amd64.json) | 0 provider 请求；重启身份保留，中断请求不重放 |
| 完整 native 工具、来源与自动记忆回顾 | [5/5](evidence/native-linux-arm64.json) | [5/5](evidence/native-linux-amd64.json) | 各 3 次本地响应：2 次任务生成、1 次自动记忆回顾；0 legacy claim |
| 实际文件工具、成品与后台取消 | [6/6](evidence/work-linux-arm64.json) | [6/6](evidence/work-linux-amd64.json) | 各 6 次本地响应；真实 read/bash/read、文件 hash、账目回执与后台进程停止 |
| 跨服授权及同步工具守卫 | [8/8](evidence/scoped-linux-arm64.json) | [8/8](evidence/scoped-linux-amd64.json) | 各 10 次本地响应；合成权威，实际宿主、文件与撤销检查 |
| Compose 聊天、节点观察、重建及备份恢复 | [10/10](evidence/deploy-linux-arm64.json) | [10/10](evidence/deploy-linux-amd64.json) | 真实 Core/Synapse、真实适配进程；推理桥接为注册、观察与只读夹具，禁止生成 |
| API-only 中央身份与独立后台 | [5/5](evidence/platform-linux-arm64.json) | [5/5](evidence/platform-linux-amd64.json) | 真实 Compose、治理模块、持久卷及容器重建，0 模型 |

其他本线结果：647/647 模块检查、TypeScript/React 生产构建通过；[完整 Chromium 浏览器检查](evidence/browser-final.json)为 12 个文件、108 个命名交互检查，使用合成 API 夹具；[干净 npm 安装](evidence/npm-clean-final.json) 7/7，包含真实双人登录、消息、回复、附件字节往返和安装文件不变；[打包后的真实 DSH UI](evidence/npm-native-ui-final.json) 9/9，0 本地及远端生成，浏览器异常为空。后两项运行在 macOS ARM64，Matrix 为 Linux ARM64 容器。

独立运行时线的 macOS 报告另归档为 [Session](evidence/peer-runtime-macos-arm64.json)、[文件工作](evidence/peer-work-macos-arm64.json)和 [native 自动回顾](evidence/peer-native-macos-arm64.json)。它们基于各自记录的 `2f7a936` 组合，不以本线后来的 `b3add9b` 替换其源码身份。

## 正式远端 CI

[GitHub Actions 42335611379](https://github.com/MixGeekers/dscord/actions/runs/42335611379) 在固定 head `0294a3f8d380abfaa9283a7a96a7d2f6c5436451` 为 **10/10 success**：四组 Linux/Node、两组独立 DSH、两组 Compose、一组浏览器及汇总门禁。已分别通过 GitHub 连接器的 jobs 和 `gh run view` 核对，[原始状态摘要在此](evidence/ci-run-42335611379.json)。

这是该固定 head 的结果。后续自然语义修补、再打包及新 head 的 CI 由主线程统一验证，不能沿用此成功替代。

## 保留的失败与修复

- [首次 web 宿主就绪阻塞](evidence/kernel-runtime-initial-failure.json)：初始化 `state` 等待 provider catalog，内核已运行但宿主 loader 未就绪。0 模型；`bc2cd26` 改为缓存读取，显式模型查询才刷新。此前 [ARM64 空状态 8 项](evidence/kernel-runtime-linux-arm64.json)及 [amd64 空状态 8 项](evidence/kernel-runtime-linux-amd64.json)属于较早 `52b94eb` / `c2804aa` 快照，不作为最新工具注册证明；上表 10 项增加了明确创建 Bot 与实际工具编译。
- [首次独立节点工具失败](evidence/runtime-tools-initial-failure.json)：DSH 2.2 已移除 `tools.presentAs`；`1c02640` 适配。失败发生在 provider 执行前。
- [记忆 schema 失败](evidence/memory-schema-initial-failure.json)：`basisRefs.items.required` 不符合 DSH value schema DSL；`5e716dd` 保留必填、integer 和禁止额外字段的约束，真实 SDK 回归与实际 Bot 编译均通过。
- [旧 request header 失败](evidence/request-header-initial-failure.json)：旧 controls 含不合法 JSON / 已移除工具配置。`135c61f` 使用官方 `NativeToolExecutor` / `setExecutor`、提前选择模型，并发送合法请求 controls；文件及跨服 scoped 检查验证过滤和执行守卫仍有效。
- [部署夹具旧白名单失败](evidence/deployment-initial-fixture-failure.json)：新旁听读取被旧夹具拒绝。`738f9ab` 接受注册、纯读及观察，额外断言实际 Matrix event 到达，仍拒绝生成。
- [只读源码目录设置失败](evidence/scoped-readonly-initial-failure.json)：跨服脚本试图在源码中创建 `.local`，尚未启动该阶段的 provider。`f33f21b` 改用临时目录后，两架构各 8 项通过。[端口冲突](evidence/platform-port-initial-failure.json)在启动前被预检拒绝，改用空闲端口后通过。
- UI 线 [01](evidence/peer-native-ui-attempt-01.json)、[02](evidence/peer-native-ui-attempt-02.json)、[03](evidence/peer-native-ui-attempt-03.json)、[04](evidence/peer-native-ui-attempt-04.json)、[05](evidence/peer-native-ui-attempt-05.json)和 [06](evidence/peer-native-ui-attempt-06.json)保留各自包 hash 与结果，涵盖 schema 启动失败及欢迎弹窗、断言时点、宿主设置保存的脚本差异。前五次失败、最后一次 9 项通过，不回写旧结果。

这些验证没有使用远端业务模型，不能替代主线程的自然生活与工作剧本。所有本地容器位于同一物理机器；物理跨机器的网络及故障环境仍按实际设备条件另验。正式部署入口与健康查询见[内核运行说明](kernel-runtime.md)，默认本机命令为：

```sh
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
curl --fail http://127.0.0.1:18100/readyz
```
