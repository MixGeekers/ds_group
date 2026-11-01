# replyer · 表现

[所属区域](<../README.md>) · [完整目录](<../../../../目录.md>) · [全景图](<../../../../../图示/识雨全景架构-A.html>)

- 创建：2026-11-01（America/Caracas）。模块 ID：`replyer`，对应 2026-10-31 全景图。
- 实现状态：仅设计资料；运行系统未实现。
- 设计状态：2026-11-01 细化为验证用建议基线；未实施、未运行候选。
- 证据：[本轮一手来源与核查范围](<../../../../../../research/2026-11-01-完整架构/输入与外层.md>)。数值是首轮合成验证配置，不是已测性能。

## 渠道连接与队列补充（2026-11-01）

无论渠道走 OpenClaw 侧车还是官方 SDK，replyer 继续运行于 DSH 的受限表达面。侧车只接管输入与发送，不生成第二份智能体回复，不把 OpenClaw session、工具或记忆链接入 replyer。平台格式由渠道适配器处理，识雨完成声明仍只读取已核实回执。

程序只读快路足以回答时直接生成 ReplyDraft；按公共契约允许返回 needs_core{eventId,reason} 提示程序接管。程序以原 eventId 去重、记录一次升级；replyer 不产生 TaskSpec、Mandate、订阅或持久记忆写入。控制命令绕过长模型等待但必须认证。

第一阶段输出完整草稿再过门禁。OpenClaw/飞书 SDK 的流式占位卡、打字提示或预览也可能产生真实发送，不能因名为预览就绕过授权；流式能力另按 V04/V05 验证。过时草稿、撤权、删除、取消后的旧成果不得进入平台发送。

固定来源、许可、真实 API 和未验证项见[渠道连接核查](<../../../../../../research/2026-11-01-连接订阅与技术栈/渠道连接.md>)。仅规划，尚未安装或接入。

## 2026-11-01 复用核查决定

**局部源码复用 + 直接调用宿主。** 计划复制 DS-Bot `btw.js::callAside` 的结果分类、`side.js::pairsOf/complete/alive/settle/sideCancel` 子集；流组装器直接 import DSH `BlockAssembler`，模型直接 `ctx.llm.stream`，不复制通用推理循环。上游 side.test.js 的快照、取消、工具重试、重启与删除/卸载断言作为适配验证样本。

必要修改：callAside 原来继承 header.tools，改为显式 tools=[]；messages 仅来自已裁剪 ReadView 与当前受众对话，不传完整主 Session/toolHistory；移除 locatePrivate/roster 自动取数。alive/settle 加入 conversationGeneration 检查，side JSON/rt.save 改经 ConversationService 写局部记录，发送只交 Effect。函数子集依赖 DSH LLM、AbortSignal、受控状态 facade、usage/logger 与错误常量；不需要 deep-view、Bot memory、群聊、Office 或浏览器模块。Apache-2.0 许可证、原版权、适用 NOTICE 与修改说明一并保留。

这取代“只借鉴 side chat”结论；并未复制/安装运行。私聊上下文来源、取消后封口、授权失效与保留是必须修改的接缝，原文件不能零改动视为只读 replyer。V04 检查实际模型请求和工具执行次数，V05 检查迟到输出；失败回退为程序注入快照的状态卡。

固定版本、源码位置、依赖和许可见[复用核查](<../../../../../../research/2026-11-01-复用核查/输入与外层.md>)；以下业务契约继续有效。

## 主方案与复用

replyer 是受限表达角色，使用 DSH 已配置模型和独立的对话上下文，基于程序提供的 ReadView 生成 ReplyDraft。复用 DSH 的模型适配、取消和既有上下文压缩；按上述闭包局部复制 DS-Bot side chat 的模型调用、结果分类和取消封口，视图来源改为识雨 ReadView。

默认 tools=[]，系统只注入此会话允许读取的视图、当前用户输入和有限近期对话。可选受限查询 facade 仅在零工具无法满足交互质量且通过 V04 后启用。不得向模型附带 Shell、文件、设备、MCP 或任意内部提交工具 schema。

## ReadView 与输出契约

ReadView 必需 viewId、schemaVersion、commitSeq、stateVersion、authEpoch、tombstoneWatermark、indexWatermark、aggregateVersions、generatedAt、expiresAt、policyVersion、scopeHash、issuedTo、purpose、sourceRefs、freshness、data；内容由内部按 actor/channel/conversation/purpose 裁剪，不能包含凭据、私聊全集或未授权其他会话记录。viewId 本身不是 bearer token，每次查询重新校验访问范围。commitSeq 代表业务快照，stateVersion 只代表六部分内层版本；authEpoch 和 tombstoneWatermark 控制撤权、删除的硬失效，不能用一个 stateVersion 兼任全部版本。freshness 使用 current / stale / unavailable，未知状态为 unavailable 并附 reason。

ReplyDraft 只输出可发送文本、引用依据和与 viewId/stateVersion 的关联；模型自述的 taskStatus 不成为权威字段。任务阶段、承诺与“已记住”之类结论必须来自结构化回执；程序检查无相应证据的完成声明，无法确定时改为可核实状态模板或重新生成。

首轮允许直接显示的结构化状态包括收到、等待、执行中、结果未知、已核验完成、发送失败。表达可以自然，但不能把 expected、simulated、accepted 改写为实际成功。

## 新鲜度、上下文和故障

运行状态视图默认有效期 30 s；依赖时间敏感任务时缩短，静态人格表达依据使用状态版本而非反复全量查询。普通内部版本前进可使用标明时点的快照；撤权、删除、会话新 conversationGeneration 或关联任务/目标已取消，必须在送出前重新核验；旧成果回复作废，当前请求的取消状态查询可以新视图表达。过期最多重取 2 次，随后返回确定性等待/不可用状态，避免刷新循环。

首轮单次 replyer 输入预算上限 8000 token、输出 1024 token，并受真实模型窗口和全局预算进一步收紧；先保留当前输入、授权边界、未答问题和已核实状态，再截取近期对话。摘要是缓存，必须可追到原文且不得扩展受众；不能用长期记忆写入解决上下文过长。

模型返回工具调用时默认拒绝而不分发，可重试一次无工具生成；仍失败则输出可核实失败状态。空输出、截断、提供方错误、取消均分开记录，不能把部分流拼成任务成功。第一阶段先生成完整草稿并过门禁再发送；流式呈现留待能明确标注草稿、撤销和最终状态后启用。

## 写入与执行边界

replyer 只能触及局部对话草稿与查询 facade；无权获得内部数据库句柄、可变内部对象或凭据。工具集 allowlist 与执行时 RoleGuard 同时限制；DSH ToolRestriction 对 scope 自注册的例外要求注册准入与最终执行 Guard，不能仅靠 tools=[] 或提示词。自定义 executor 绕过标准管道被视为验证失败。

查询不触发记忆权重、关系更新或学习；访问审计记录由可信外围写入独立审计域。模型提出“应该记住”只作为随输入交回 core 的内容，不成为 replyer 的写操作。发送由 Effect/ChannelAdapter 执行，replyer 不自行调用平台 API。

## 验证与备选

V04：注入跨会话 canary、恶意 prompt、强制 tool_calls、自注册工具、绕过 executor；受保护状态哈希和记忆权重保持不变，未授权工具执行次数为 0，其他受众 canary 不进入模型请求。检查实际发送给模型的 tools、上下文及提供方日志范围。

V05：在生成与发送之间撤权、删除或推进 conversationGeneration，过时内容发送数为 0。V23：所有完成声明能追到任务/内部提交/发送各自回执。质量评测用合成问答集覆盖纠正、来源缺失、未知状态和长对话压缩，不仅检查“听起来合理”。

若只读查询工具无法可靠约束，固定回退为程序注入快照的零工具 replyer；若模型仍常混淆阶段，先采用结构化状态卡 + 简短表达，而不是授予它更多工具或复制整套 DS-Bot。

