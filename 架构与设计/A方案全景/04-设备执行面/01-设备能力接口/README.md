# 设备能力接口

[所属区域](<../README.md>) · [完整目录](<../../目录.md>) · [来源](<../../../../research/2026-11-01-完整架构/设备执行面.md>)

更新：2026-11-01。模块 ID：`device-gateway`。状态：建议主方案已细化，未实现、未接入。

## 目标与复用边界

DeviceGateway 是插件内确定性路由服务，把同一任务语义送到不同设备并带回实际效果。复用 DSH MCP/SSH、OpenSSH 和端侧工具，不开发传输加密、通用远控协议或新设备管理中枢。

SSH/MCP 的请求 ID、连接恢复和取消消息不是业务效果账本。DeviceCommand首先是插件内部封套，现成工具可直接映射参数和结果，无须全都实现识雨协议。缺乏持久去重的工具标记 `supportsDedup=false`，默认开放只读能力；经明确授权的单次副作用可走不自动重放路线，未知结果必须人工或业务查询核对且阻塞资源改派。只有远端持续执行、排队或重启续接要求，才增加命令校验、持久去重、回执与成熟执行器绑定的端侧gate。

## 数据对象与责任

| 对象 | 必须表达的字段 | 权威维护者 |
|---|---|---|
| DeviceRecord | `deviceId`、OS/架构、端点、transport、主机密钥/证书指纹、`credentialRef`、`enrollmentRevision`、注册状态 | 中心登记服务；设备只能声明自身信息 |
| CapabilityInstance | `deviceId + capabilityId + version/contentDigest`、`environmentFingerprint`、`healthObservedAt/healthTtl`、`verifiedAt/validUntil`、实例状态 | 能力模块批准定义/验证；Gateway 维护绑定和观测 |
| 执行约束 | 输入/输出 schema、`sideEffectClass`、`resourceClass`、`supportsStatus/Cancel/Dedup`、`offlinePolicy`、并发与超时上限 | 能力模块批准版本；不直接信任端侧新声明 |
| DeviceCommand | `schemaVersion`、`effectId`、`taskId`、`assignmentId/attempt`、`installationGeneration`、`hostEpoch`、整数 `fencingToken`、`leaseExpiresAt`、`idempotencyKey`、`payloadHash`、设备/能力版本、`resourceId/resourceEpoch`、`mandateId/mandateVersion`、`policyVersion`、`expiresAt`、参数/产物引用 | TaskService 经策略校验产生，worker 不能扩大范围 |
| DeviceReceipt | `effectId`、设备/能力/实例、`assignmentId`、`installationGeneration`、`hostEpoch`、整数 `fencingToken`、`resourceId/resourceEpoch`、`receiptSeq`、接收/开始/完成时间、状态、错误分类、结果引用与效果证据 | 端侧产生；中心按认证连接身份及关联字段接纳 |
| ArtifactRef | `deviceId`、`artifactId`、逻辑路径、摘要、字节数、MIME、可读主体、到期时间 | 设备产物服务，中心登记引用与接收证据 |

字段遵循[跨模块契约](<../../跨模块契约.md>)。`fencingToken` 是中心在当前安装世代中持久分配的单调递增整数，不是复合对象；`installationGeneration` 表示安装/恢复世代，`hostEpoch` 表示宿主启动实例，三者共同校验。一次执行由 `assignmentId`、`attempt`、`fencingToken` 关联，不另建 assignment 世代字段。

`resourceEpoch` 是独立的资源占用世代，用于桌面/机器人等互斥资源，不能代替执行实例的 fence。声明持久gate的设备执行入口持久保存当前可信中心世代、宿主实例及资源已接受的最高 token/占用世代；同一有效命令的重复投递走 effect 去重，不因 token 相等重复执行。新动作必须同时满足当前中心身份、当前 Assignment、有效租约与资源所有权，旧宿主或旧所有者不能派发新动作。

中心从备份恢复时生成新的 `installationGeneration`，启动时产生新 `hostEpoch`；持久gate设备经受认证的控制会话重新绑定、退休旧执行资格并核对未终结效果后，才接受新世代命令。不能把旧备份的计数加一当成全局更新的 fence，也不能因为新世代建立就认定旧物理动作已经停止。迟到回执只用于原 Effect 的事实核对，不能直接更新新 Assignment 或提交旧 Proposal。

## 配对、撤销与版本

1. 从用户授权设备清单开始；管理员通过可信通道确认 host key/证书指纹、账号和可用根，不按自报 hostname 自动信任。deviceId 为中心生成的稳定随机 ID，重装换身份重新登记。
2. `pending → active` 需要协议、工具摘要、非破坏 probe、能力范围和凭据可用性通过。未批准工具不注入模型。
3. `active → quarantined/revoked` 立即阻止中心新 dispatch；在线端取消/撤权、关闭通道并轮换凭据。离线端记为撤销待同步；持久gate用经验证本地短租约限制继续动作，普通工具保留unknown并阻止资源改派，不能提前宣称已收回效果。
4. 主机密钥、程序摘要、major协议或关键schema变化进入隔离。未知major拒绝；同major只协商明确支持字段，不能忽略未知授权字段后继续执行。
5. 独立账号/密钥及最小文件根；模型只见能力和状态，不能读取凭据、SSH配置或端侧授权密钥。

## 执行、幂等与未知状态

以下端侧账本与世代检查适用于声明持久gate的能力；普通现成工具只有中心映射，不虚构其端侧保证。端侧持久账本键为 `(中心身份,effectId)`；规范化参数产生 payloadHash。同键同摘要返回已有回执，同键异摘要拒绝 `IDEMPOTENCY_CONFLICT`。去重保留期覆盖中心最大重试窗口，默认 7 天；过期效果禁止直接重发，必须查询或人工核对。

接收顺序为真实对端认证、schema/版本、Mandate与能力范围、有效期/fence、原子记录 accepted 与资源所有权、调用执行器、保存结果、返回回执。模型和网络调用不占账本写事务。

端侧状态 `accepted → executing → succeeded/failed/cancelled`，不能判定效果则 `unknown`；执行前拒绝用 `rejected`。accepted 不证明执行，退出码不证明业务完成，后置条件仍由结果核验模块判断。

“副作用完成、回执未落盘”窗口不能承诺恰好一次。写能力必须声明核对方式，如目标文件摘要、业务对象ID、作业ID；没有核对方式时保留unknown、停止自动重试。取消只是请求，执行器确认停止/终态前不得释放独占资源；租约到期不代替停止证明。

默认租约30秒、心跳10秒。端侧用单调时钟维护租约，expiresAt结合认证时间基准校验；偏移超过5秒禁止新副作用并报告。重连先查询未终结effectId，再派工；改派新assignment前核对旧效果并提升资源代际。DSH MCP断连时旧工具可能仍列出，必须订阅真实连接/健康状态，不能用工具存在性判断available。

## 文件传输与生命周期

远端路径必须带deviceId；不能直接在宿主fs打开。端侧canonicalize，检查批准根、符号链接/穿越、权限和期望版本。传输复用SSH/SFTP或受认证的已有HTTP文件通道；任意设备自报URL不自动成为可信下载源。

默认单产物100 MiB、任务累计1 GiB。分块传输、临时文件、SHA-256校验后同盘原子发布；半文件不标成功。DSH fs-ssh单次读取及帧限制须遵守，使用流/分块。[文件语义](<https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/ssh/fs-ssh/README.md>)

截图、屏幕文本和日志按任务最小取用，临时证据默认7天；删除传播到端侧、中心产物与备份政策。未核对效果的标识/状态不随缓存清理；必须清除证据时同步禁用自动恢复并明确不可核对。

## 失败与降级

| 故障 | 处理 |
|---|---|
| 心跳过期 | 禁止新动作，已有动作按既有离线政策/截止处理 |
| 身份/摘要/schema变化 | 隔离并重新验证，不自动接受新权限 |
| 端侧账本损坏或满盘 | 禁止新副作用，保留能执行的只读诊断；不清空账本伪装新设备 |
| 输出过载 | 控制流与有界产物流分离、反压、预算拒绝；不能丢取消或回执后报成功 |
| 效果/取消未知 | 保留unknown与资源阻塞，查询或人工核对；不得换ID重放 |

## 验证与替代条件

V18：两个替身同名 `/work/result.txt` 的100次交错请求无串机；错误host key、未批准能力、过期验证、major不兼容全部拒绝。

V19：重复、乱序、断线、重启、旧fence各100次；受控计数器只在合法新effect时递增；丢回执恢复为核对或unknown，不重放。10秒心跳下35秒内识别离线；撤权后中心新dispatch为0；已开始动作停止时限单列。

V23：Goal→Task→设备产物→核验→只读回复贯通，删除设备或失效回执给明确失败。V26再于真实设备重复对应场景。

若DSH设备作用域无法独立，退回OpenSSH固定入口；若成熟目标系统已有持久业务ID和状态查询，省去重复本地执行层，只保留映射。资产平台只在设备规模/运维成本证明收益后引入，不能替代上述业务契约。

## 直接复用清单与替代的旧工作

[完整复用证据](<../../../../research/2026-11-01-复用核查/设备.md>)固定DSH `ce7073d`：`mcp/mcp-client/src/index.ts`的`apply/StdioConfig/StreamableHttpConfig/createMcpToolDefinition`，`ssh/ssh/src/index.ts`的`SshConnection.ready/dispose`及fs/subprocess provider。许可MIT，直接挂载插件，不复制传输实现。每设备单独scope，模型只见批准目录；MCP连接、工具发现、取消、结果投影与重连由现成组件负责。

因此旧“小型端侧适配”不再泛指所有设备必须安装一套新客户端。优先映射现成工具、作业ID和状态接口；没有远端持久gate时禁止离线新增/自动重放，旧执行资格未确认终止不转移资源。中心fence校验不等于远端已停止旧进程。V18/V19须分别验收直接工具与持久gate两类保证，失败退只读/人工核对；V23/V26按实际能力激活。
