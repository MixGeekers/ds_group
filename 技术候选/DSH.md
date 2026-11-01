# DSH（DeepSeek Harness）

> 2026-11-01 完整方案更新：当前验证基线为专用Web profile、固定DSH提交与Node24.22.2候选；领域状态使用专用SQLite事务仓储，工具采用可信注册准入与执行时授权。原先未定的进程形态与存储方案已在v1.0给出，具体provider/预算/设备和数据根是激活参数。 本轮仍未安装或运行候选；除已选DSH宿主外，候选状态保持已初评。具体[选型基线](<../架构与设计/A方案全景/技术选型与决策.md>)与[新增证据](<../research/2026-11-01-完整架构/宿主与依赖.md>)优先于本文早期适配建议。

[返回候选目录](<目录.md>) · [主动运行、自愈与多设备](<../架构与设计/主动运行、自愈与多设备.md>)

## 基本信息与决定

| 项目 | 内容 |
|---|---|
| 类型 / 方向 | 开源 Agent 宿主与插件框架；模型、会话、工具、存储、运行调度和界面 |
| 来源 | [官方入口](<https://www.deepseek.com/en/harness/>)、[官方仓库](<https://github.com/deepseek-ai/deepseek-harness>) |
| 审阅日期 | 2026-10-31（America/Caracas） |
| 固定提交 | [ce7073d51254c26cd63b22a60835b8f948deb447](<https://github.com/deepseek-ai/deepseek-harness/commit/ce7073d51254c26cd63b22a60835b8f948deb447>)；提交时间 2026-10-29T16:13:15Z |
| 版本与许可 | 审阅快照中的 dsh-base 包为 0.2.2-alpha.2；MIT。README 标为 developer preview，明确可能破坏兼容 |
| 本机只读版本检查 | /Applications/DeepSeek Harness.app 的 Info.plist 为 0.2.1-rc.5；没有检查或改动运行配置，不将上游快照能力直接视为本机验证结果 |
| 候选状态 | **已采用：当前设计选择 A，识雨核心运行于 DSH 插件内**；来自用户明确决定 |
| 实施状态 | 识雨运行插件未实现、未接入；既有资料工作台不等于识雨内核 |
| 激活参数与验证 | A 的 Web宿主、运行管理与存储已形成验证基线；实际provider/model、预算、数据根和设备授权在激活清单固定；独立核心作为未来触发条件下的备选 |
| 证据层级 | 官方文档阅读、限定源码静态核查、本机应用版本元数据读取；未安装、启动、运行测试或验证能力 |
| 证据索引 | [本轮来源与核查范围](<../research/2026-10-31-识雨主动运行/来源与核查范围.md>) |

## 当前判断

2026-11-01 [六模块复用核查](<../research/2026-11-01-复用核查/宿主与依赖.md>)已明确直接使用的公共API、DSH许可与局部复制计划：不再自建模型路由/重试/流拼接、工具registry、日历解析或插件装载器；领域事务优先局部复用Superagent `Store.atomic/afterCommit`并修复已查明错误路径。DSH storage-domain可直接原子保存“单聚合+嵌入出箱”记录，不能再笼统说它不能保存业务状态；跨聚合SQL事务方案来自业务需求比较。未复制产品代码或运行验证。

**DSH 插件形态可以承载有状态、主动工作的识雨，当前不必因“插件”这个名称而另造完整宿主。** 但 DSH 的通用会话与工具能力不会自动提供识雨自己的六部分内层、持续目标、自愈策略或跨设备一致性。

识雨身份、数据、任务状态及接口应有独立定义。DSH 提供当前实现这些定义的运行依托；若将来要脱离宿主存续，可再抽出核心服务，而不是将整个产品与某个 Session 绑定。

## 机制、证据与局限

| 能力 | 核查结果与依据 | 适配限制 |
|---|---|---|
| 插件扩展范围 | 模型适配、工具、会话日志和 Agent loop 都是插件；可注册服务、事件、UI 与持久数据。[架构](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/architecture.md#L7-L27>) | “可扩展”不是识雨内层已实现；插件默认不是相互隔离的安全进程 |
| 多种运行形态 | Web、SDK、ACP 等 profile；headless 是一次性执行形态。[说明](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/architecture.md#L39-L53>) | 持续运行仍需要选定进程管理方案；不能把 headless 自动称为后台常驻服务 |
| UI 与宿主分离 | README 支持 Web 服务不开浏览器；桌面文档区分隐藏窗口和退出。[Web](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/README.md#L18-L26>)、[桌面](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/apps/desktop/README.md#L70-L80>) | 本机窗口关闭、宿主退出及自动恢复未实测 |
| 定时触发 | Host Schedule 持久保存任务并恢复目标 Session；源码打开 schedule domain、挂载 Session 恢复入口，卸载时释放运行时。[实现](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/schedule/schedule/src/index.ts#L247-L295>) | 需要 Host 活着；投递回执不等于模型或外部任务完成；崩溃窗口可能重复投递。不能单独作为识雨业务任务账本 |
| 持久化与空间 | Session 日志和领域存储分开；有 JSON / SQLite provider、版本和生命周期接口。[存储](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/storage.md#L1-L7>) | DSH_HOME、工作目录、设备远程路径与 Electron 数据并非同一范围；需要逐项盘点 |
| MCP | 已有 stdio / Streamable HTTP 客户端、工具注册与重连机制；本轮静态核查激活与卸载路径。[说明](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/mcp/mcp-client/README.md#L26-L67>)、[实现](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/mcp/mcp-client/src/index.ts#L154-L202>) | 默认没有启用某个 MCP server；外部 server 本身仍是需要明确部署与信任的组件 |
| 远程执行 | POSIX SSH provider 可提供远程文件、进程及 sandbox 接口，依赖远端 helper。[架构](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/ssh/README.md>) | 不能外推为所有 OS、GUI、手机或机器人能力；断连后不自动重放，结果仍需核对 |
| 部分恢复基础 | 启动诊断、插件激活失败处理；sanitizeProfile 可在停止 profile 后备份 patch 并恢复 bundle 列表。[失败规则](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/boot/app-boot/README.md#L94-L115>)、[恢复源码](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/boot/app-boot/src/profile-sanitize.ts>) | 主进程致命失败会退出；并未因此提供识雨自己的宿主外自主恢复 |
| 数据流 | 上游 base 挂载 session-log-deepseek，组件默认 enabled=true；官方 API 会话日志贡献和反馈遥测分属不同机制。[配置](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/bundle/base/cordis.patch.yml#L43-L44>)、[贡献说明](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/session/session-log-deepseek/README.md#L26-L44>) | 本地存放不等于只在本地处理；没有读取本机配置或核查实际外发，不声称本机正在上传 |

## 适配取舍

- **收益：**可复用宿主的模型调用、工具、Session、事件、存储接口和界面，优先研究识雨自己的行为与状态。
- **成本：**需要维护插件与宿主 API 的兼容，约束工具与数据访问，正确处理插件卸载、进程退出和版本迁移。上游仍标为开发预览。
- **替换边界：**任务与领域状态采用识雨自己的结构，DSH Session ID 作为执行绑定；worker 输出和 replyer 视图通过协议交换。独立核心方案仍有通信与部署成本，未决定采用。
- **数据与费用：**模型请求、会话日志贡献、反馈遥测和备份应各自说明；资源预算不能只计算模型 token，也需计算并发、后台进程、日志与工作文件。
- **当前基线：**识雨已有设计文档与资料工作台。本轮把 DSH 从历史宿主背景升级为用户明确选择的当前宿主形态；没有把 DS-Bot 或 DSH-Superagent 升级为已采用。

## 待验证：计划

使用固定目标版本，在测试目录中验证：专用数据范围和必要外置项、角色工具权限、关 UI / 停 Host 的行为、持久任务和未知结果恢复、热更新 / 升级后的状态兼容、MCP / SSH 的实际设备能力。原始业务记录和模型侧会话记录的保留及删除也应分别验证。

完整的 A / B 比较与故障用例见[主动运行专题](<../架构与设计/主动运行、自愈与多设备.md>)。没有运行上述实验。

## 决策记录

- **2026-10-31，用户明确决定：**识雨目前在 DSH 中作为插件存在。
- **2026-10-31，用户明确保留待定：**先比较随 DSH 持续运行与独立核心两种形态。
- **2026-10-31，助手核查：**完成本文证据与设计适配分析；推荐复用当前宿主并预留核心分离接口，此推荐不等于用户确认长期部署或批准实施。
- **2026-10-31，用户后续决定：**明确“按照 A 来”，选定插件内核心为当前基线并要求绘制全景图；未授权安装、部署或实现运行系统。[架构图](<../架构与设计/图示/识雨全景架构-A.html>)中的模块接口仍为草案。
