# round-19 证据独立复核（task-79，完成）

- 最终身份：X=`7ffc08b`、X+1=`4a0a00a`、host=`fba0179`；code `7ed9aa7`、H7 `7ffc08b`。
- 只读复核 commit blob/evidence/`.local` 日志/只读 DB/4 audits；未改他人文件、未 git 提交。
- 结论：**最小真实模型调用明确 empty-provider-stream；0 重试/无业务写；reply diagnostic 读取旧操作诚实无伪造；H7/X+1 不升级；P0 聊天记忆仍未通过。** F19 findings 均为 info。

## 0. reply-stream / model-transport 仪器化 — 通过

- `7ed9aa7`：model transport 10 tests/isolated1817、reply diag 13 new/isolated1820、Lead targeted32/32；8 类受控标签、有界≤16KB/≤400B、无正文/路径/prompt、首因保留、0 自动重试；只读查看工具。
- 分类为受控标签，不声称根因已修复。

## 1. 宿主最小真实模型调用 — empty-provider-stream，诚实

| 项 | 结果 |
|---|---|
| request | provider `opencode-go`/model `deepseek-v4.1-flash`/effort `low`/maxTokens 8、messageCount0/toolCount0；单轮单槽、0 重试 |
| result | **empty-provider-stream**、chunks0/textBytes0/usage unknown；receipt 1095B/sha `ebaf13bd…` |
| Session | `shiyu-model-transport-6521365b…` released/disposed/archived/cleanup.ok |
| 审计 | commitSeq **617→617**、events70、goals8/tasks/state 不变、effects23/budget37 settled31 不变；sessions40→41 仅 +1 disposable Session → **无业务/Goal/Task/Effect 写入** |
| 结论 | 最小空调用**不是 chat/core 通过**；P0 聊天记忆仍未通过；0 重试/未再发聊天尝试 |

## 2. 零模型 reply diagnostic 读取 — 诚实

- round18 失败 operation：found=true、status=unknown、reasonCode=`REPLY_FAILED`、streamDiagnostic=null；旧 operation 早于仪器化，明确不伪造。

## 3. H7 / X+1 — 通过

- H7 105 sources/454 files；product 79/79 not_covered；gate incomplete；full1819/harness205；archived3；H7-round19 仍映射 round18 sources；新 transport/reply 诊断尚未映射（下一轮），无 product/V25/业务/九系统升级。
- X+1 `4a0a00a`：11 M artifacts、code diff0、manifest head=7ffc08b/dirty=false/leaks0、aggregates 432/8,069,665/`97d9464e…`；clean **1844/1844**（`ed8ed1b8…`/192868）；pipeline `58133e43…`/3799；archive `9db90be1…`/839；selfproof 24/205；**105/105 sources/454 files、0 unknown**；产品 79/79；gate incomplete/executed=passed=0；11 artifact SHA/bytes 已记录。

## 4. findings/边界

- **F19-R1**（info-boundary）：Minimal empty-provider-stream is not a chat/core pass; P0 chat memory remains unpassed
- **F19-R2**（info-scope）：Round-19 transport/reply diagnostics not yet mapped into H7; next round
- **F19-R3**（info-observation）：Historical reply diagnostic has no streamDiagnostic (old operation)

- 最小空调用不是聊天/core 通过；P0 聊天记忆闭环仍未通过；未再发聊天尝试；provider 需恢复后新显式 owner 决定。
- 新 reply-stream/model-transport 仪器化尚未在 H7-round19 映射（下一轮），无产品/V25/九系统升级；H7 limitations 已包含 F18 effects/budget 披露。
