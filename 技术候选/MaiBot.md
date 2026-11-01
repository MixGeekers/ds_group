# MaiBot

[返回技术候选目录](<目录.md>) · [相关总体架构](<../架构与设计/总体架构.md>)

## 基本信息

| 项目 | 内容 |
|---|---|
| 类型 | 开源项目 |
| 方向 | 对话组织、表现、渠道连接、会话调度；同时包含记忆与学习相关机制 |
| 来源 | 用户提供的 [GitHub 仓库](<https://github.com/Mai-with-u/MaiBot>) |
| 审阅快照 | main · [c6429547af711555e3d4d1b8d04b413572cb616c](<https://github.com/Mai-with-u/MaiBot/commit/c6429547af711555e3d4d1b8d04b413572cb616c>) |
| 版本标识 | [项目配置](<https://github.com/Mai-with-u/MaiBot/blob/c6429547af711555e3d4d1b8d04b413572cb616c/pyproject.toml#L5-L10>) 声明 1.3.19；说明页有其他版本文字，本次以提交为准，不据此断言最新发布版本 |
| 收录 / 更新日期 | 2026-10-30 收录；2026-11-01 复用核查更新（America/Caracas） |
| 当前状态 | 已初评；仅静态阅读，未运行、未安装、未接入 |
| 审阅范围 | 项目说明、部分会话运行与调度、Planner / Replyer 分工、消息收发及记忆自动写回入口；不是全面审计 |

## 2026-11-01 复用核查补充

已核查固定提交的 [LICENSE](https://github.com/Mai-with-u/MaiBot/blob/c6429547af711555e3d4d1b8d04b413572cb616c/LICENSE) 为 GPL v3 文本，不是 MIT。`runtime.py` 的队列使用 Python asyncio.Queue，运行体同时导入 chat_manager、message_repository、全局配置、工具 providers、ExpressionLearner/JargonLearner；不是可以单独安装的调度库。

当前外层选择 DSH 公共接缝、DS-Bot 可分离的回复函数与 p-queue，不复制 MaiBot runtime。依据是同栈成熟实现已覆盖需求、只抽取 asyncio.Queue 调用收益小，而移植运行体需要额外 Python↔Node 与状态闭包；并非因其他路径写记忆就排除所有代码。若未来明确采用其平台生态，再比较独立 sidecar/平台组件，并核查完整依赖与 GPL v3 分发边界。仍未安装、未运行、未接入；详见[复用核查](<../research/2026-11-01-复用核查/输入与外层.md>)。

## 一句话判断

**可以参考其对话组织与调度，但不能把 MaiBot 的模块划分直接当作识雨“外层只负责对话、不主动记忆、不主动干预内部”的权限边界。**

## 为什么收录

用户提出识雨采用内外两层：内层包含记忆、关系、情绪、认知、人格、能力；外层包含表现、链接及串行 / 并行队列系统，并指出思路与 MaiBot 相近。

因此，本次重点不是评估 MaiBot 能否整体替代识雨，而是了解哪些对话机制可供参考，以及哪些行为需要与我们自己的边界重新划分。

## 已核对的机制

### 1. Planner 与 Replyer 有分工，但不等于内外层权限隔离

在被动 Replyer 模式启用时，Planner 的正文可以作为回复指导，再交由 Replyer 生成可见回复；Planner 也可以调用工具。这是决策与措辞分工，不能仅靠名称判断谁能读写内部状态。

依据：[Planner 处理与 Replyer 调用](<https://github.com/Mai-with-u/MaiBot/blob/c6429547af711555e3d4d1b8d04b413572cb616c/src/maisaka/reasoning_engine.py#L405-L485>)。

**适配判断：**可借鉴“表达实现与其他处理分开”，但识雨外层能拿到哪些状态、暴露哪些工具、拥有哪些凭据，需要单独约束。

### 2. 独立会话有串行触发队列，不是逐条消息 FIFO 回复队列

非 Focus 路径中，每个会话维护消息缓存、`message / timeout / proactive` 触发队列与消息登记锁，并只保持一个主推理循环。消费者会合并已就绪触发信号，批量处理消息，因此不能描述成“一条消息必对应一次回复，严格按到达顺序逐条回复”。

依据：[会话状态与触发队列](<https://github.com/Mai-with-u/MaiBot/blob/c6429547af711555e3d4d1b8d04b413572cb616c/src/maisaka/runtime.py#L139-L165>)、[单一循环与 Focus 分支](<https://github.com/Mai-with-u/MaiBot/blob/c6429547af711555e3d4d1b8d04b413572cb616c/src/maisaka/runtime.py#L1289-L1306>)、[信号合并](<https://github.com/Mai-with-u/MaiBot/blob/c6429547af711555e3d4d1b8d04b413572cb616c/src/maisaka/reasoning_engine.py#L1093-L1119>)。

Focus 模式交由共享组处理，不适用以上独立会话循环的完整描述；本次未展开审阅共享组实现。

**适配判断：**我们应先决定队列存“消息”“触发信号”还是“任务”，以及合并、打断、顺序和重试语义，再选实现。

### 3. 跨会话主要通过多个运行体的协程并发

会话管理器按 session 创建运行体，分别运行会话循环。平台入站经过路由校验和技术去重后，可以为消息创建异步分发任务。本次阅读的链路未显示一个统一的中央并行工作队列或完整全局并发配额，不能因存在异步任务就推定这些能力已经具备。

依据：[按会话创建运行体](<https://github.com/Mai-with-u/MaiBot/blob/c6429547af711555e3d4d1b8d04b413572cb616c/src/chat/heart_flow/heartflow_manager.py#L34-L62>)、[平台入站分发](<https://github.com/Mai-with-u/MaiBot/blob/c6429547af711555e3d4d1b8d04b413572cb616c/src/platform_io/manager.py#L478-L509>)。

**适配判断：**保留其会话内有序、独立会话并发场景作为比较；识雨的背压/公平/失效规则需定义，但通用并发和取消采用 DSH/p-queue，业务恢复走现有账本。

### 4. 聊天链路会触发记忆写回与学习，不是纯只读表现层

- 收到消息后，处理链会存储消息、登记会话，再调用记忆自动化入口。
- 发送消息后，也会调用记忆自动化入口。
- 在相应配置启用时，自动化服务可以观察身份、安排图片、人物事实及聊天摘要写回。
- 会话运行体还可以将裁切的历史提交给表达与黑话学习器。

依据：[接收入口](<https://github.com/Mai-with-u/MaiBot/blob/c6429547af711555e3d4d1b8d04b413572cb616c/src/chat/heart_flow/heartflow_message_processor.py#L54-L65>)、[发送后入口](<https://github.com/Mai-with-u/MaiBot/blob/c6429547af711555e3d4d1b8d04b413572cb616c/src/chat/message_receive/uni_message_sender.py#L312-L326>)、[自动写回调度](<https://github.com/Mai-with-u/MaiBot/blob/c6429547af711555e3d4d1b8d04b413572cb616c/src/services/memory_flow_service.py#L994-L1029>)、[后台学习提交](<https://github.com/Mai-with-u/MaiBot/blob/c6429547af711555e3d4d1b8d04b413572cb616c/src/maisaka/runtime.py#L1840-L1933>)。

**适配判断：**这并不等于“文本生成函数直接改全部内部状态”，也不是在指认漏洞；它说明 MaiBot 的现成职责划分不能原样套用为识雨外层。若借用代码，需要区分技术消息记录、长期记忆、学习入口以及它们各自的决定权。

## 与识雨的边界对照

| 识雨当前方向 | 可以借鉴的部分 | 仍需自己设计或核查 |
|---|---|---|
| 外层表现 | 回复组织、表达与富文本处理 | 外层是否只能使用受限的表达依据，而不是修改内部 |
| 外层链接 | 平台路由、入站分发与出站发送 | 身份映射、数据范围、回执与错误处理 |
| 串行 / 并行队列 | 每会话触发队列、单循环及多会话并发 | 串行键、并发上限、背压、取消和合并语义 |
| 外层不能主动记忆或干预内部 | 参考其事件与服务拆分 | 记忆写入、学习与状态更新应归属哪里；接口如何防止绕过 |

## 待验证事项

- [x] 当前外层复用选择已明确：不复制 MaiBot runtime，使用 DSH / DS-Bot 子集 / p-queue；平台专项仍待具体需求。
- [ ] 明确内外接口、状态写权限、临时上下文与长期记录的区别。
- [ ] 用模拟内部状态验证：外层正常对话不需要内部写权限；越权写入应被拒绝。
- [ ] 验证两个会话并发、同会话连续输入、慢回复和中途打断时的顺序与数据隔离。
- [ ] 验证重试与重启不会导致重复发送或重复内部处理。
- [ ] 许可证文本与 runtime 导入闭包已静态核查；若进入其平台专项或代码复用，仍须核对完整依赖、模型成本、平台权限和数据流向。

## 决策记录

| 日期 | 事项 | 结论与范围 |
|---|---|---|
| 2026-10-30 | 用户提供 MaiBot 作为双层思路的参考 | 收录候选，围绕对话与调度做限定阅读 |
| 2026-10-30 | 完成初评 | 借鉴机制，不将模块拆分等同权限隔离；未运行项目或测试，未安装、未接入 |

以上结论仅对应审阅快照。队列、学习及可选模式仍需在实际选型时结合配置与运行测试重新核对。
