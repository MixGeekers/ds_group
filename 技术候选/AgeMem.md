# AgeMem

[返回技术候选目录](<目录.md>)

## 基本信息

- **类型 / 方向：**研究方法与训练代码；统一长期记忆和短期上下文管理。
- **论文：**[Agentic Memory: Learning Unified Long-Term and Short-Term Memory Management for Large Language Model Agents](<https://arxiv.org/abs/2601.01885v3>)，Yi Yu、Liuyi Yao 等。
- **日期：**首版 2026-01-05；本次核得 v3 为 2026-07-23。
- **作者代码：**[y1y5/AgeMem](<https://github.com/y1y5/AgeMem>)；审阅提交 [98f563f907d67b2f2436e3ae7b7ceff32e482814](<https://github.com/y1y5/AgeMem/commit/98f563f907d67b2f2436e3ae7b7ceff32e482814>)。
- **记录日期 / 状态：**2026-10-30（America/Caracas）；已初评，静态阅读，未训练、未测试、未部署。

## 它学什么

用三阶段强化学习和 step-wise GRPO 优化统一的工具调用策略，训练更新模型参数：

| 对象 | 动作 |
|---|---|
| 长期记忆 | Add / Update / Delete |
| 当前上下文 | Retrieve / Summary / Filter |

公开代码的流程是先学习保存上下文事实，再引入干扰材料学习压缩 / 清理，最后完成检索与推理任务。[作者说明](<https://github.com/y1y5/AgeMem/blob/98f563f907d67b2f2436e3ae7b7ceff32e482814/README.md#L17-L38>)。

检索动作由模型选择时机和查询，底层公开实现仍是 embedding 余弦检索；不能称为端到端学习向量检索器。Summary / Filter 管理消息上下文，不是修改模型隐藏状态。

## 实际发展阶段

有实际 Trinity-RFT 训练、评估、六种工具与示例代码，较仅有论文的方案更接近可试验阶段。但默认 `InMemoryVectorStore` 明确表示持久化需替换存储；训练流程按 run 重置记忆，**不是装上即可长期运行的记忆服务**。[默认存储边界](<https://github.com/y1y5/AgeMem/blob/98f563f907d67b2f2436e3ae7b7ceff32e482814/trinity/common/workflows/memory_context/memory_store.py#L31-L40>)。

作者报告以 HotpotQA 训练，在 ALFWorld、SciWorld、PDDL、BabyAI、HotpotQA 五类受控任务中评估。本次不将这些结果直接外推为长期个人对话、隐私删除或人格更新的可靠性。

## 复现与适配限制

- 本次未核实可下载的完整训练 checkpoint 或同设置的独立复现成功。
- 论文与本次公开训练代码的奖励权重存在差异：代码还包含 tool-efficiency 项。需要先核对版本与配置，不能假定按当前默认参数即重现论文。[训练权重与重置](<https://github.com/y1y5/AgeMem/blob/98f563f907d67b2f2436e3ae7b7ceff32e482814/trinity/common/workflows/memory_context/train_hotpotQA.py#L348-L362>)、[公开差异讨论](<https://github.com/y1y5/AgeMem/issues/3>)。
- “答对任务、控制上下文长度、记忆质量”这类奖励仍需与识雨自己的长期目标对齐。
- 研究动作中的 Delete 不能直接承担用户数据彻底清除；生产中还涉及来源、历史、索引与备份。

## 对识雨的价值

适合参考**统一的决策动作接口与训练任务设计**，而不是现在就让它直接写真实内部状态。若将来训练专门决策 worker，应先明确样本、可观测奖励与拒绝 / 延迟决策机制，由 core 控制写入。

- [ ] 先在影子模式比较规则、通用模型和学习策略的建议。
- [ ] 明确需要优化的是保存决策、上下文预算，还是两者；避免把它们混为一个分数。
- [ ] 补持久化、版本与权限边界后，再考虑受控原型。

**2026-10-30：**收录为统一记忆策略研究候选；未决定训练或采用。
