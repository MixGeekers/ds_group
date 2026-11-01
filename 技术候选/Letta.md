# Letta

> 2026-11-01 复用核查更新：明确局部复制reflection筛选及核心记忆维护规则的计划，交DSH执行带来源提案；不再停留于“机制参考”。完整CLI/harness可另作内部服务比较，但当前无需为复用这两份策略引入全部运行依赖。未安装、运行、复制到产品或采用，详见[复用核查](<../research/2026-11-01-复用核查/记忆关系认知.md>)。

[返回技术候选目录](<目录.md>)

## 基本信息

- **类型 / 方向：**有状态 agent harness；文件化记忆、后台回顾和技能维护。
- **来源：**[原仓库与迁移说明](<https://github.com/letta-ai/letta/blob/8816d3a8516893bfdc0fa14bfb1235226012e295/README.md#L5-L38>)、[当前代码库](<https://github.com/letta-ai/letta-code>)、[官方文档](<https://docs.letta.com/>)。
- **审阅快照：**letta-code [89a757f93cf2a84c74bc16a27b63b6c61f95892c](<https://github.com/letta-ai/letta-code/commit/89a757f93cf2a84c74bc16a27b63b6c61f95892c>)，2026-10-30；原仓库在本次快照已指向新实现，archive 为退役 V1 服务。
- **记录日期：**2026-10-30（America/Caracas）；未标发布日期的在线文档以此为获取日。
- **状态：**已初评；限定源码与官方文档阅读，未运行或实测。

## 一句话判断

可借鉴“记忆是可维护、可追溯的上下文，回顾提出并修改持久知识”的工程做法。**本次核验的是通用模型管理外部上下文，而不是更新模型权重的专门记忆决策模型。**

## 2026-11-01 可直接复用与复制范围

固定89a757…的[package.json](https://github.com/letta-ai/letta-code/blob/89a757f93cf2a84c74bc16a27b63b6c61f95892c/package.json)版本0.34.34，Node `^22.23.4 || ^24.22.1 || ^26.12.1`、Bun>=1.3.2；完整包依赖Letta agent SDK/client、MCP、PTY、sharp等，不是可零成本嵌入的独立记忆函数。[LICENSE](https://github.com/letta-ai/letta-code/blob/89a757f93cf2a84c74bc16a27b63b6c61f95892c/LICENSE)为Apache-2.0，品牌名称/图标等有单独排除；复制保留许可、适用归属和修改说明，不取品牌资产。

| 路线 | 精确复用范围 | 修改与依赖 |
|---|---|---|
| **局部策略，优先** | reflection-v2.md27–37的Trajectory review及maintaining-core-memory/SKILL.md的稳定模式/纠正/假设验证/检索入口规则 | 文本闭包，无SDK依赖。去掉Bash/Edit、Git提交及直接改system prompt，输出Claim/RevisionCandidate/sourceRefs；修改“最新证据胜出”为主体/时间/来源核对，来源留在识雨证据层 |
| 文件校验，条件使用 | [memory-constraints.ts](https://github.com/letta-ai/letta-code/blob/89a757f93cf2a84c74bc16a27b63b6c61f95892c/src/memory-constraints.ts) `validateMemoryTreeConstraints`与`parseMemoryConstraintsConfig`，也有公开包导出 | 主函数依赖reader与标准语言能力，头部另重导出memory-frontmatter。需要文件导入/导出时可复制函数闭包并保留同版测试；不为此额外建立MemFS |
| 完整服务/CLI，备选比较 | 原生MemFS和reflection运行 | 允许隔离为core管理的内部服务，并不因可写或独立库自动排除；需明确Git记忆权威、DSH模型/任务接口、提交回执和历史清除。为当前仅需提示策略的范围引入成本较大，故非首选 |

`memory-confinement`虽有公开导出，却依赖权限launcher和sandbox探测，不是可独立抄几行的路径过滤器；不能把“只读文件校验”当操作系统隔离或语义真实性保证。完整服务的API/认证与故障恢复未在本轮验证。

V07/V25使用同模型同材料比较局部策略与原DSH提示，测来源归属、矛盾处理、重复错误和预算；V16若使用Git记忆则清理历史/工作树/备份，不以当前文件删除代替清除。**本轮形成复制计划，实际复制产品文件为0**。

## 当前机制

- MemFS 将 agent 的 Git 记忆仓库投射为可读写文件；根部记忆进入上下文，分层目录中的资料按需查阅。
- 当前默认没有语义 / 向量索引；普通文件查找与读取是基础路线，额外检索可以另行扩展。
- reflection / dreaming 根据会话材料整理耐久知识、纠正行为和维护技能，使用通用模型及可编辑提示词 / skills。
- 写入策略优先错误与纠正、偏好与模式、耐久事实、矛盾、可复用流程；跳过一次性状态、临时路径和已有内容，无值得保存的材料时不修改。
- 核心记忆维护提示强调“模式或明确指令”而非单个含糊事件，并将一次记忆编辑称为需要未来交互检验的假设。

依据：[MemFS 文档](<https://docs.letta.com/concepts/memfs/index.md>)、[reflection 规则](<https://github.com/letta-ai/letta-code/blob/89a757f93cf2a84c74bc16a27b63b6c61f95892c/src/agent/subagents/builtin/reflection-v2.md#L1-L43>)、[核心记忆维护规则](<https://github.com/letta-ai/letta-code/blob/89a757f93cf2a84c74bc16a27b63b6c61f95892c/src/skills/builtin/maintaining-core-memory/SKILL.md#L56-L121>)。

这里的 core memory 是 Letta 的上下文分类，不等于我们已经确定的 core 角色实现。

## 可借鉴与限制

- **适合参考：**耐久性筛选、层次化索引、来源与版本历史、回顾独立于可见回复、把改进视为待验证假设。
- **不能原样放到只读外层：**当前 agent 与反思子代理可以编辑记忆。识雨需要将决定与提交权留在受控内部通道，replyer 不获得同样写权。
- **提示词不是可靠性证明：**“只从明确证据更新”等规则存在，不代表所有模型输出都遵守；本次未核验到当前实现的独立逐事实写入准确率。
- **版本历史不等于隐私删除：**删掉当前文件不代表 Git 历史、会话和备份中的副本都消失；彻底遗忘需要另外设计。
- **记忆与上级规则不能混淆：**即使一套系统把记忆投射为系统提示，识雨仍需控制哪些经过审核的内容可影响行为，不能让外来记录中的命令自动获得权限。

官方也明确说明，其学习路径是主动管理上下文，而非更新模型权重：[官方概览](<https://docs.letta.com/llms.txt>)。

## 成熟度与待验证

有公开的现行运行框架和记忆维护机制，可作受控工程参考；不把框架的“自我改进”表述视为已经验证的通用成长能力。

- [ ] 用明确事实、含糊感受、纠正与过时信息测试保存 / 不保存 / 改写行为。
- [ ] 将反思结果改为带来源的提案，比较自动写入与 core 审核的差异。
- [ ] 验证目录可发现性、回滚与所有副本清除。
- [ ] 将记忆维护权限与对话表现权限真正分开。

**2026-10-30：**收录作文件化记忆与回顾机制候选；未决定接入。旧 MemGPT / Letta 服务教程不可直接当作本次快照的实现说明。
