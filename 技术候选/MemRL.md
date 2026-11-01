# MemRL

[返回技术候选目录](<目录.md>)

## 基本信息

- **类型 / 方向：**研究方法与代码；以任务反馈调整经验记忆的检索效用。
- **论文：**[MemRL: Self-Evolving Agents via Runtime Reinforcement Learning on Episodic Memory](<https://arxiv.org/abs/2601.03192v2>)，Shengtao Zhang、Jiaqian Wang 等。
- **日期：**首版 2026-01-06；本次核得 v2 为 2026-02-12。
- **作者代码：**[MemTensor/MemRL](<https://github.com/MemTensor/MemRL>)；审阅提交 [c1b322ca43de36ddf64c6712f89d0095bfc35ce0](<https://github.com/MemTensor/MemRL/commit/c1b322ca43de36ddf64c6712f89d0095bfc35ce0>)。
- **记录日期 / 状态：**2026-10-30（America/Caracas）；已初评，限定静态阅读，未运行或复现实验。

## 它真正学习的对象

**冻结 LLM，在运行时更新每条经验记忆的 Q 效用值，再用它影响检索排序。**

先通过语义相关性找候选，再结合效用分数重排；根据环境 / 任务反馈更新记忆 metadata。典型单步、无 bootstrap 情况可写为：

```text
Q_new = (1 - alpha) * Q_old + alpha * reward
```

代码也支持 bootstrap 项；该公式不是对所有配置的完整描述。[实际 Q 更新](<https://github.com/MemTensor/MemRL/blob/c1b322ca43de36ddf64c6712f89d0095bfc35ce0/memrl/service/value_driven.py#L181-L219>)、[检索重排](<https://github.com/MemTensor/MemRL/blob/c1b322ca43de36ddf64c6712f89d0095bfc35ce0/memrl/service/memory_service.py#L1437-L1473>)。

它也有经验生成和记忆整理等配套机制，但核心贡献不等于学会了通用 ADD / UPDATE / DELETE 决策，更不是在每次使用时微调 LLM 权重。

## 实际发展阶段与证据

作者提供实际库代码和 HLE、BigCodeBench、ALFWorld、Lifelong Agent Bench 入口，适合有明确结果反馈的任务经验研究。[作者说明](<https://github.com/MemTensor/MemRL/blob/c1b322ca43de36ddf64c6712f89d0095bfc35ce0/README.md#L1-L51>)。

需要注意作者实验的口径：

- 运行时多轮累计成功率不等于一次性未见任务准确率。
- HLE 部分没有 holdout-transfer；论文说明其增长主要来自重复暴露下的运行时记忆化，不能转述为普遍推理能力提升。
- 其他任务有迁移实验，但仍受任务类型、相似经验密度和反馈质量限制。
- 本次未独立运行。存在外部复现讨论，但设置不一致且未核得完整纠正后结果，不据此声称已复现成功或已被证伪。[论文全文](<https://arxiv.org/html/2601.03192v2>)、[复现讨论](<https://github.com/MemTensor/MemRL/issues/12>)。

## 对识雨的价值与边界

- **适合候选：**以后为 worker 的可验证任务经验排序，让曾经真正帮助完成任务的经验更容易被找回。
- **不宜替代：**用户许可、事实真实性、人格变化和“这段经历是否值得永久保存”的完整判断。
- **反馈有风险：**误判成功会强化错误经验；多条记忆同时被使用时，很难准确分配功劳。
- **Q 值也是内部状态。** 外层只能回传结果或反馈，不能直接改 Q；不能用“只是调检索权重”为理由绕过只读边界。

## 待验证与决定

- [ ] 先确定可信任务结果，以及哪些反馈不能作为奖励。
- [ ] 用保留任务集区分重复任务记忆化与未见任务迁移。
- [ ] 比较纯相关性检索与效用重排的真实增益、成本和错误强化。
- [ ] 将 Q 更新纳入 core 控制的版本、审计与回退机制。

**2026-10-30：**收录为运行时经验检索优化候选，不作为已解决存储决策的证明，未决定采用。
