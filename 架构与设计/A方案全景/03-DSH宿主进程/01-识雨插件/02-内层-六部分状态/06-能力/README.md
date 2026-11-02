# 能力

[所属区域](<../README.md>) · [完整目录](<../../../../目录.md>) · [证据与选型](<../../../../../../research/2026-11-01-复用核查/情绪人格能力.md>)

- 更新：2026-11-02（America/Caracas）。模块 ID：`ability`。
- 设计状态：复用 DSH 工具、MCP 与 Agent Skills 的建议基线，准备验证。
- 实现状态：3I 已接线固定本地便签的声明、当前可用性与成功证据，1021项模块和204项模拟UI通过（后续文案14项复验）；未接入动态工具、技能或设备。结果以[本体实施记录](<../../../../../../plugins/shiyu/实施记录.md>)为准。

## 3I 固定本地便签的实施范围

本页下方的严格验证、发布、TTL 与 bootstrap 是新候选及动态扩展的建议基线。2026-11-02 实施切片对**已经部署的固定 `task.local-note.execute`**采用明确的 `verificationPolicy: informational`：固定批准定义及当前实现绑定匹配、enabled、当前依赖观察可用，且原有 owner/Goal Mandate、预算、Task/Assignment 和 Effect gate 全部通过时，允许普通任务首次调用。成功证据 unknown/stale 本身不取消原有授权；它也不能授予授权。

成功证据仅由同 Worker 内部重读已独立核验的 Task、Assignment、Effect 与 artifact receipt 产生，绑定该任务持久保存的实现身份。旧历史成功不补当前 proof。稳定身份为相关实际代码摘要、installationGeneration 与环境指纹；hostEpoch 单独约束当前实例，普通有序重载不必销毁同一实现的旧证据。启动只做零模型依赖观察，不宣称工具已实际执行或模型已经可用。下线/停用不抹掉既发生效果和费用；最终文件发布前仍重新核查执行资格。

此例外不推广到新发现工具、动态技能、额外安装、权限扩大或真实设备；不新增验证 Task、验证按钮、探针循环、第二执行器或独立预算账本。六域 publication schema3 只增加 ability 读取描述并保留 memory，其他四域仍 unavailable。当前切片先完成离线集成及模拟 UI；尚未进行 3I 真实宿主或模型验收，不将其标为完整 V09 通过。

## 1. 主方案与复用取舍

本模块维护“识雨有哪些能力、在哪个版本和设备上可用、最近验证到什么程度”，不重新实现通用工具总线。执行复用 **DSH 工具注册与守卫管线**；外部工具优先使用 **DSH MCP client**；可复用操作流程直接使用 **DSH现有 `ctx.skills` registry、skill-filesystem provider与tool-skill consumer**。不只参考SKILL.md格式，也不重新实现发现、解析、缓存、按需加载、目录注入和更新通知。识雨只追加批准绑定、验证门、任务范围和提案提交。

| 能力种类 | 复用方式 | 识雨额外负责 |
|---|---|---|
| 原生工具 | 复用 DSH `ctx.tools` 与既有 schema / 输出校验 | 每项能力的范围、注册来源、版本、任务授权与结果核验 |
| 外部服务工具 | 优先官方或已审查 MCP server，经 DSH client 接入 | 服务器信任、出站数据范围、断连失效、精确版本与验证记录 |
| 设备动作 | 复用 SSH、既有代理等适配器，交给 DeviceGateway 路由 | 能力定义与验证标准；实例在线、租约、取消和路由由设备区域负责 |
| 复用工作流程 | DSH `ctx.skills.snapshot/get`、skill-filesystem、`skill({name})`原有实现 | 来源审查、内容摘要绑定、允许工具集合、测试和发布状态 |
| 自我改进 | 复用上述候选与验证流程 | 提出可审阅变更和收益比较；不直接修改运行中的自身代码 |

MCP 提供工具发现、schema 和调用约定；注解不是权限凭据。Agent Skills 的 `allowed-tools` 支持仍有实现差异，不能取代识雨任务授权。[MCP 工具规范 2026-07-28](<https://modelcontextprotocol.io/specification/2026-07-28/server/tools>)、[Agent Skills 规范](<https://agentskills.io/specification>)

DSH 固定审阅版中，MCP 工具失联后可能继续列在旧工具清单里，因此“发现过”不等于“现在可用”。首验复用既有重连机制，同时保留独立健康与验证状态。[DSH MCP client](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/mcp/mcp-client/README.md>)

## 2. 台账结构与所有者

| 对象 | 关键字段 | 所有者 |
|---|---|---|
| `CapabilityDefinition`（宿主对象的批准扩展，不是第二工具registry） | `capabilityId, version, contentDigest, kind, providerRef, inputSchema, outputSchema, sideEffectClass, resourceClass, requiredScopes, dependencies, licenseRef, sourceRefs` | 能力领域，经 core 受控提交；模型不能注册 |
| `CapabilityInstance` | `capabilityId, version, deviceId, providerGeneration, environmentFingerprint, enabled, healthObservedAt, healthTtl, availabilityReason` | DeviceGateway / 宿主探测产生事实，领域服务记录；设备方案定义连接细节 |
| `VerificationRecord` | `verificationId, capabilityId, version, deviceId, environmentFingerprint, testSuiteVersion, result, verifiedAt, validUntil, evidenceRefs` | 验证任务产生证据，结果核验服务确认；能力领域保存 |
| `CapabilityRelease` | `releaseId, activeVersion, previousVersion, state, allowedScopes, rolloutLimit, reviewRef` | 能力领域维护，经受控发布 |
| `CapabilityView` | `declared, available, verificationStatus, releaseState, unavailableReason, checkedAt, version` 及标准 ReadView 元数据 | 只读视图服务 |
| `CapabilityChangeProposal` | 新版本、精确差异、预期收益、依赖/权限变化、来源、验证/回退计划，外包统一 Proposal 字段 | core 或 worker 可提出，不能自行激活 |

稳定 identity 不以远端自报名称或描述文本为准。MCP 绑定本地批准的 serverName、原始 toolName 与 schema / 发布内容摘要；技能绑定受信来源和文件内容摘要；设备能力再绑定 deviceId。仅改一个名字不能继承旧验证状态。没有可固定的服务版本时，标记为 `unversioned_remote` 并缩短验证有效期，不假称已经 pin 住实现。

执行谓词为：

```text
可调用 =
  已批准声明
  AND releaseState = active（或该任务被纳入 canary）
  AND 当前实例 enabled 且健康信息未过期
  AND 对相同 version + environment 的验证仍有效
  AND 当前 Mandate 匹配 requiredScopes / effect 范围
  AND 当前任务租约有效
```

这些条件只表示该次调用可以开始，不保证外部动作一定成功，也不保证恰好一次。发现、提示组装、执行三个时点各自检查；提示中出现过的旧工具不能凭旧视图继续执行。执行前与权限撤销竞争时，以任务领域的原子受理 / fencing 规则为准。

## 3. 接口与过程

直接使用宿主入口，撤回旧版另造 `registry.list/resolve` 通用平台的暗示：

- 工具：`ctx.tools.register(definition)`、`resolve(context)`、`execute(input)`；`guard`追加识雨单调拒绝条件。注册/执行清单的唯一来源为DSH，能力表只引用其对象并追加已批准版本。
- 技能：`ctx.skills.registerProvider/register/list/snapshot/get`。使用现成filesystem provider及 `skill({name})` 工具；`skills/change`仅通知失效，重新读取本scope的snapshot，不维护第二发现缓存。只有新增非文件来源时才编写单个provider。
- 识雨保留 `verification.record` 与统一Proposal中的批准变更：核验服务记录证据，模型不能自报验证/发布；`CapabilityView`是宿主目录与本地批准、健康、验证信息的联结投影。
- 任务调用绑定effect、taskId、assignmentId、mandateId、能力版本、参数摘要及幂等键，再走现成executor/DeviceGateway；能力模块不新建执行器。

DSH技能正文每次get重读，目录未变不代表代码或指令未变。批准绑定需含provider、scope、name和内容摘要；将未批准文件正文交模型前必须阻止，正文摘要变更重新验证。现成registry会处理同名覆盖和不完整发现，但不会替识雨判断版本是否批准。首验选受信固定bundle和批准根；加载结果后置核对的具体宿主挂点必须在V09验证，未过前禁用动态技能来源。

动态工具变化流程为：探测 / 订阅发现 → 记录候选 generation → 规范化与 schema 检查 → 对比批准范围 → 验证 → 原子替换获准 generation。旧一代可继续解释历史，但不以同名替换自动赋予新能力。删除、权限扩大、schema 变化或依赖更新都触发重新验证。

**宿主限制必须正视。** 已核查的 DSH ToolRestriction 主要约束继承工具，scope 自己注册的工具不受该过滤影响；自定义 executor 也可能不使用默认执行管线。因此 V1 仅加载受信、固定版本的宿主插件，限制谁能注册，统一通过选定 executor，再在执行时检查授权。replyer 不加载内部写工具和任意执行器；不能只加工具 allow-list 就宣称操作系统级隔离。需要运行不受信代码时，复用宿主已有进程 / 沙箱机制并验证隔离，不把它放进同进程插件。[DSH 工具边界](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/tools.md>)

## 4. 验证有效期与自我改进

以下默认值供第一轮合成验证，均可由策略降低，不能由模型提高：

| 项目 | 建议默认值 |
|---|---|
| 健康新鲜度 | 活跃设备 / 服务 60 秒；过期为 unknown，下一次执行先做获准的无副作用探测 |
| 只读能力验证有效期 | 相同版本、环境和权限下最多 24 小时；失联、配置变化或撤权立即失效 |
| 写入能力验证 | 相同版本与环境的验证最多 24 小时；激活前必须在合成目标上通过对应操作场景，真实执行仍逐任务核查目标范围与前置状态；不可逆操作不得用昨日验证代替当次确认条件 |
| 能力发布灰度 | 最多 5 个已授权的可回退任务或合成任务，出现边界失败立即停用；不能为凑样本自动发起真实动作 |
| 技能候选大小 | 主文建议不超过规范推荐量级；只加载所需资源，引用不得逃逸技能包与获准资源范围 |
| 验证工具自身 | 新能力首次验证由固定受信测试执行器在隔离环境完成，不要求候选已经 active，避免循环依赖 |

发布状态为 `discovered → quarantined → validated → canary → active → retired`，任一阶段可进入 `rejected / revoked`。验证与灰度均使用单独的验证 Mandate，限定合成目标、预算和退出方式。安装依赖、扩大权限或调用新真实设备不能被“改进能力”默认涵盖。

成熟项目优先的审查顺序：现有 DSH 工具 → 已评审 MCP / 设备适配器 → 已有技能 → 小型领域适配。确需自研时，提案必须说明现有方案具体缺口、维护成本、退出方式和同任务比较。验证阶段的最低收益门槛建议为：在至少 30 个代表任务中，成功率提升 ≥ 10 个百分点或中位耗时 / 成本下降 ≥ 20%，同时边界测试无新增失败；否则保留既有方案。这是工程筛选阈值，不是已经获得的结果。

## 5. 失败恢复与数据生命周期

- 健康探测失败只更新 availability，不覆盖最后一次 verification 证据；对外明确显示“曾验证但当前离线”。
- 版本、依赖、授权、设备环境或 schema 改变后失效旧验证，不因服务重连就自动恢复旧资格。已运行任务保留其原版本绑定，必要时按任务规则取消或核对结果。
- 非幂等操作超时记录 unknown，由任务账本查询效果或交给用户裁决，不自动重放。能力模块只能声明是否支持状态查询、取消与去重；不能把声明当实测保证。
- 能力回退切换执行绑定至已知可用版本，不能回滚外部世界或重做已完成动作。数据库迁移、依赖退回由恢复方案另行核验。
- 注册清单和验证结果仅保存必要元数据、证据引用；凭据经专用设施引用，不进入 manifest、技能正文或模型普通上下文。
- 权威定义变更影响六内层能力状态，按统一 stateVersion / commitSeq / revision 协议提交；纯连接心跳属于运行健康状态，只增加相应运行记录与必要业务序号，不无意义地改写人格或记忆。
- 删除来源触发 EvidenceRevoked；由该来源学习出的技能说明或派生能力提案先停用，再删除可归因内容。独立提供的工具包不会仅因一条已删除使用日志而自动卸载，但对其已删除验证证据不能继续声称可追溯。
- DSH MCP server instructions 会进入模型上下文；仅允许受信服务，裁剪与来源标识不能替代执行权限，发现越界指令不扩大任务范围。

## 6. 验证计划与替代

以下属于 **V09**，联调覆盖 **V23**；本轮未运行。

| 场景 | 通过标准 |
|---|---|
| 三种状态分离 | 发现但未验证、曾验证但离线、在线但已撤权三种 fixture 均不可调用；说明与实际工具集一致 |
| 版本与 schema 变化 | 同名换 schema / 内容摘要 / 设备环境后 100% 失效原验证；不使用旧许可调用新版本 |
| 发现更新失败 | 保留可解释旧清单，但按真实健康状态拒绝调用；部分失败不发布半个新 generation |
| 原生技能边界 | 同名项目技能覆盖、body-only修改、provider不完整、scope变化均可检测；加载内容与批准摘要一致才交给模型；现成加载器不重复实现 |
| 权限绕过 | 新 scoped registration、custom executor、技能 allowed-tools、MCP 注解均不能绕过执行授权；失败时不允许该扩展上线 |
| 验证 bootstrap | 新候选未 active 仍可在合成验证 Mandate 下测试，无法借测试访问生产目标 |
| 幂等与取消 | 同 effect 重复受理只生成一条执行记录；未知结果不自动重发，不支持幂等或查询的外部能力转人工核对；旧 Assignment 迟到结果被 fencing 拒绝 |
| 提案与发布 | 验证通过不自动激活；灰度仅使用获准任务，失败可恢复旧绑定且不重放外部动作 |
| 隐私与来源 | Manifest / ReadView / 日志不含凭据；删除源后相关候选与视图不可继续导出可归因内容 |

**替代与切换：**若 DSH 特定扩展点无法在目标版本可靠限定调用，先退回固定可信工具集合；需要异步远程协议时优先已有 SDK / 适配器，不能绕开守卫直接调用。当前DSH已有原生技能支持，不以格式不兼容为由先自建加载器；实际有不支持字段时先省略非必要元数据或提供一个受信provider，脚本仍经既有工具执行。若重复领域工作达到上表收益门槛，再实施最薄适配。

## 7. 证据与其他区域

能力声明格式参考 [MCP 2026-07-28](<https://modelcontextprotocol.io/specification/2026-07-28/server/tools>) 与 [Agent Skills](<https://agentskills.io/specification>)；执行和技能分别复用固定审阅版DSH原生工具与技能包；[技能registry源码](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/skill/skill/src/index.ts#L390-L523>)、[skill工具加载与检查](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/skill/tool-skill/src/index.ts#L130-L165>)；[DSH 工具接口](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/tools.md>)。本轮完成上述限定源码核查，未证明某个MCP server或设备已经可用。相关包0.2.2-alpha.2、MIT，Node≥24.9.0；skill-filesystem使用chokidar5.0.0与yaml，MCP client使用官方client2.2.0及宿主配套依赖，精确依赖与许可见证据页。直接使用发布包；本轮没有复制registry源码。第三方技能自身许可另核。

[设备能力接口](<../../../../04-设备执行面/01-设备能力接口/README.md>)管理实例与路由；[任务执行](<../../03-任务与执行/README.md>)管理任务和效果；[只读状态视图](<../07-只读状态视图/README.md>)对外解释当前能力。详细版本、证据边界与不采用项见本页上方证据链接。

