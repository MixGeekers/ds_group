# 凭据引用 · 系统机密设施优先

[所属区域](<../README.md>) · [完整目录](<../../目录.md>) · [验证与验收](<../../验证与验收.md>)

更新：2026-11-01。模块 ID：`credentials`。**建议验证基线，未实施、未实测。** 本页定义方案，不创建运行数据库或数据根。

## 主方案

**复用核查结论：直接使用 OS 安全设施；不复制 Superagent 普通 KV 或 Ombre YAML 存秘密。** macOS 的现成能力为 Security.framework 的 SecItemAdd / SecItemCopyMatching / SecItemUpdate / SecItemDelete 与 Keychain 访问控制；识雨只做用途受限门面。Node 到系统接口的成熟绑定兼容性尚未核实，不能把“薄适配”写成现成可用 SDK；下一阶段先核 DSH 已提供的凭据 API 与可复用系统桥接，再选固定维护版本。不因 API 缺口自写密码库，也不默认采用已停止维护的绑定。

DSH provider 若已有可用认证接口，直接让 provider 使用其既有凭据路径，并把真实落点、继承与轮换加入清单；只有新增的设备 / 服务秘密才进入 Keychain 门面。离线恢复继续使用 age，许可证与工具版本需在验证锁清单登记；没有许可引用就不复制第三方桥接代码。源码和平台证据见[本轮核查](<../../../../research/2026-11-01-复用核查/数据空间.md>)。

中心为 macOS 时采用 OS Keychain 保存短秘密，识雨 DB 只存 SecretRef 与可用状态；CredentialBroker 通过系统 Keychain 接口或受限系统适配器取值，交给固定用途的网络 / 设备适配器。复用系统安全存储，不自建密码库或加密算法。薄适配器不得提供“按名字返回明文”的模型工具。

DSH 自有 provider 凭据的真实保存位置、环境继承和日志策略必须纳入外置项盘点；不能仅把识雨 DB 改成 SecretRef，就声称宿主所有凭据都受 Keychain 保护。

## 接口与元数据

SecretRef：secretId、provider（首版 keychain）、locatorRef、purpose、principalRef、allowedDestinations、version、expiresAt、revokedAt。secret_bindings 记录服务用途与引用；secret_status 记录 locked / available / expired / revoked / unknown、lastProbeAt 及不含秘密的错误码。

业务调用为“使用该引用执行某个获准操作”，而非 resolveSecret 给 worker。Broker 校验当前 Mandate / authEpoch、目标地址与用途，再在受信适配器内短暂取值；不得进入模型上下文、任务 payload、shell argv、日志、崩溃附件或普通导出。第三方工具需要环境变量时只传最小子进程环境，生命周期结束清理；同进程内存 / OS崩溃转储风险单独记录，不承诺零残留。

## 运行与恢复

启动先检查目标会话下钥匙串可访问性。后台 launchd、用户未登录、锁屏、首次授权提示、签名身份变化分别验证；无法解锁就停止相关能力并明确报告，不改为明文配置、关闭系统保护或无限弹窗。轮换先添加新版本并验证用途，再切绑定、撤销旧版本；丢失或过期秘密不会由模型猜测恢复。

同进程受信插件共享 OS 身份，工具白名单不能抵挡恶意原生插件；若需要防此威胁，应按宿主专题将秘密使用和不可信执行隔离到独立受限进程 / 身份，而非以 README 声称硬隔离。

## 备份与跨平台

常规 BackupBundle 仅含 SecretRef，不复制系统 Keychain 数据库。灾难恢复所需秘密由独立恢复包管理，可用成熟 age 工具对指定接收者加密；恢复身份与备份解密材料分开保存，必须演练但本轮未生成密钥。age 的用途是离线恢复材料，不是每次推理都解密的自建在线 vault。

跨平台中心迁移时优先采用对应 OS 凭据设施或已部署的成熟 Secret Manager；接口不变。尚无真实平台时用内存替身只验证调用边界，不将替身视为持久安全方案。

## 验收

[V17](<../../验证与验收.md#v17>) 注入唯一合成 secret 标记，完成一次获准网络适配调用后扫描模型输入、outbox、产物、诊断和备份：标记泄漏为零。replyer / worker不能调用明文解析；撤权后新调用拒绝；Keychain locked 返回可解释不可用，不能降级明文。恢复演练同时验证 SecretRef 存在但秘密缺失时不会假报能力可用。

## 证据与适用限制

一手资料、静态核查范围与具体链接见[数据空间证据](<../../../../research/2026-11-01-完整架构/数据空间.md>)。以上业务字段、默认参数与通过标准是识雨的设计建议，不是上游软件自动提供的能力。

