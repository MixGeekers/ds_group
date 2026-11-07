# 自然运行维护策略 v2

2026-11-07，针对 full01 两次在第64条后的测试支架整理中超时，调整执行器维护方式。故事、独立判据和既有报告保持原样；后续 attempt 在自身记录中写入 `maintenancePolicy.version=2`，不回填旧 attempt。

自然场景的压缩、重启及收尾不再要求全体 Bot 先把全部来源做完 LLM 整理。压缩显式传 `settleMemory:false`，直接调用正常 `rt.checkpointBot`；共享 visible-host 调用未传此参数时，仍保留原先目标 Bot 的整理行为。600秒整体 HTTP deadline 继续覆盖真实原生 checkpoint。

新的 `memory-observations` 操作只读 SQLite，按 Bot 保存实际观察水位、原文 `id/revision/sequence/digest`、作者/房间/事件标识和待整理引用，不返回原文正文，不触发模型或补写事实。证据写入运行目录的 `memory-maintenance-evidence.jsonl`，并随维护结果和最终快照记录。

压缩和重启前后核对：

- 所有先前原文引用及内容摘要仍在，观察水位不倒退，Bot 身份与原生 Session 相同。
- 待整理项仍保留，或有实际 `reviewed` 标记或来源失效依据；单凭数量减少不能算已整理。
- 仍待整理的来源继续标成 pending；观察持久化不代表模型已理解或已完成整理。

本轮相关 **49/49 零模型检查通过**。新增9项包含真实 SQLite 关闭/重开、只读快照不写 journal、删除待整理队列而没有整理标记时拒绝通过、已整理与失效的区别、来源头丢失不能冒充正常失效、内容或 Session 变化，以及从第64条恢复的真实 runner/adapter 路径。恢复回归保留32/64两次压缩边界及36/72两次重启边界，最终没有任何 `flush` 调用，每Bot的96条来源均仍明确待整理。回归中的 checkpoint 回执是脚本替身，不能替代原生模型压缩验收；续跑必须另提供真实回执。

隔离验证分支的旧 `memory/` 尚无观察水位接口；本轮用忽略目录中的临时只读解析 hook，直接导入主集成树当前实际 `memory/` 模块验证，没有复制或修改产品文件。验证期间相关模块摘要保持不变，准确提交和摘要见验证记录；合入该集成树后可直接执行：

```sh
node --test tests/platform-natural-memory.test.mjs tests/platform-natural-validation.test.mjs tests/platform-natural-maintenance.test.mjs tests/memory-host-http.test.mjs
```

另以 `DatabaseSync(readOnly:true)` 对 full01 第二次失败后的真实数据库做了一次独立快照，全部原文摘要正确：

| Bot | 已持久观察引用 | 待整理引用 |
|---|---:|---:|
| 识雨 | 175 | 0 |
| 知秋 | 155 | 0 |
| 听澜 | 96 | 43 |

这份只读快照没有把听澜的43条待整理来源算作已整理，也不改变任何既有运行结论。本补丁没有新建模型流程、发出模型调用或注入事实答案。细节与输入摘要见[验证记录](natural-maintenance-policy-v2-validation.json)。
