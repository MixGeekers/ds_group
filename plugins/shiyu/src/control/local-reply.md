# 本地只读回复与上下文控制

下列 3C 基础路径为已关联本地 Task 的只读业务回复；3F 的记忆和零推理加载扩展见文末。`LocalReplyService` 编排现有 ReadView 与 DSH replyer；`LocalReplyDomain` 把输入引用、加载证据和草稿资格放在同一控制库。它不创建消息历史、原生 inbox 或第二个模型循环，也不提供渠道发送、记忆写入或工具能力。

## 受理与稳定 Session

公开入口参数为 `conversationId/inputId/text`，可附调用方取消信号及不超过 512 的输出 token 上限。主体、scope、模型与关联 Task 权限来自可信 Runtime/Worker。控制库只保存 text 的 SHA-256，不保存输入或回复正文。

同 Conversation 的同 inputId、同内容返回原操作元信息；不同内容拒绝。重复请求不重新 prepare/followup，即使旧状态是 unknown。新输入推进 `conversationGeneration` 并中止同 Conversation 的在途尝试；稳定 `businessId/sessionEpoch` 不因每条输入改变。Session 唯一绑定仍通过 ConversationStore 完成；已有 ID 必须交给原生适配器恢复，不能偷偷替换。

## 捕获、加载与草稿

1. 真实 Worker capture 在同一控制库事务中读取发布头、权限水位、Conversation 和 Task 版本。ReadView 从不可变 capture 裁剪数据；检查时重新读取当前权威。Task 变更不递增内层 stateVersion。
2. 服务只接受 current、非截断且含本地 Task 的视图。实际加载集合由 `control-task` 记录、Task sourceRef 与 aggregateVersion 共同确定；prepare 不能把 capture 的其他来源顺带当作已加载。
3. prepare 保存 view/capture 引用、强 token 和来源版本，创建草稿。原生 `onBound` 在 followup 前登记 Session、message ID/hash 和 dispatch intent。提交后发生断线，保留 unknown，不自动再次 followup。
4. 只有精确 `user/message`、原生 flush 与持久 readback 完成后，原生适配器才提交加载回执。Worker 在一个事务里保存回执并 `ackContext`；迟到、新 generation、撤权、epoch 改变或过期不能确认。期间新增的背景版本仍留在 pending。
5. 加载成功与模型成功分开记录。模型失败可以保留已确认加载，但不能产生 ready 草稿。返回草稿前必须通过 ReadView 的当前 Task 版本检查，以及 ConversationStore 的背景依赖/强 token 检查。控制库只保存 native Session/assistant event 引用，不复制回复正文。

原生生成期限取 View 与 capture 的较早到期时间（最多 30 秒），每次最多一个原生 followup，工具由受限 replyer 禁用。Session 额外标题、压缩和真实用量必须另行观察，不能从此编排的调用数推断全部费用。

## 运行状态与边界

输入状态为 admitted/prepared/dispatching/ready/failed/cancelled/unknown，独立 `durability` 表示上下文是否取得原生耐久证据。仪表盘可读 `latestReply` 元信息；读取不消费背景、不调模型、不写确认。内存 controller 只用于取消与关闭排空，重启不会从控制记录重造 inbox 或自动重放输入。

当前控制域上限 4,096 条输入元记录，服务最多 32 个并发在途请求；Runtime 可施加更严格容量限制。到达上限明确拒绝，不静默删旧元记录。长期元记录保留/清理与完整跨进程恢复仍待后续实现。

## 本轮合成验证

`node --import tsx --test tests/local-reply.test.ts tests/local-reply-domain.test.ts`：20/20 通过。10 项使用真实 SQLite、ConversationStore、commit 水位和注入 capture authority；10 项使用真实 ControlStore Worker、StatePublication、ViewDomain、ReadView 与原生 driver 替身。覆盖输入去重、稳定绑定、新输入取消、旧背景确认保留新 pending、同事务故障回滚、Task 版本变化、无关写提交、过期/暂停、unknown 不重放、模型失败后的加载证据、关闭排空及最终校验/ready 回执期间的取消。

本文件的验证没有调用真实模型或原生宿主；原生适配器的单测及宿主验收由对应记录单列，不能把替身回执称作原生耐久证明。

最终只读复核发现原生返回后的 View 校验等待窗口可能跨过取消/暂停；已在 ready 前后复查 Runtime 许可与信号，并用两个门控测试验证。若 ready 事务已提交才收到取消，保留原回执，但不再返回 transient 回复正文；重复输入仍只返回元信息，不重新生成。

## 3F：记忆、累积暴露和只加载路径

可信 `memory.select/read` 端口返回同会话获准 ID 与独立原生读取证明，控制 Worker 重新捕获并核对；原生正文仅瞬时进入 ReadView 和 Session。索引进度不能代替授权，记忆有独立删除基线与水位。完整视图被截断、来源变化、过期或失去权限时拒绝派发。

绑定前耐久记录本 epoch 可能暴露的每个来源，最多 200 条；达到上限明确拒绝，不丢来源或自动换代。即使下一轮只用 Task，也重新核对累积暴露来源。撤回钩子在同一 SQL 事务里重置受影响的 native 绑定及安全代次，原生日志保留；异步取消仅作辅助，进程中断不取消持久 fence。

`load()` 走原生 `loadContextOnly`：独占空闲 maintenance，拒绝已有 inbox 和任何生成请求，追加官方完整 user/message、flush 并精确冷读，获得独立 `loaded` 状态；不创建 assistant/draft，也不调用 followup。重复输入只回既有元信息，不伪造新加载成功。冷恢复和新 Session 初始化可能追加原生生命周期事件，固定标题不等于标题模型请求，需核对事件来源。

3F 全模块 676 项及限定宿主两次 load-only 的结果见[实施记录](<../../实施记录.md>)。历史 3C 的 20 项替身测试不升级为此路径真实证据；本轮证明加载与撤回失效，不声称模型理解或回复验收。
