# H4d 证据独立复核（follow-up，commit `66a9428`）

- 复核对象：`66a9428848ed8dfba61187e9ebc802df802e0ab4`（feat(shiyu): add explicit inner sources to reply prepare and Lab inner path (H4d)），父提交 `7f354ac4f5176796c1e48ef7cf0a864149106fe1`。
- 只读复核 commit blob、证据与 `.local` 日志；未运行真实宿主/模型/embedding；未改文件、未 git 提交。
- 结构化结果：`artifacts/dsh/verify/h4d-evidence-review.json`（12 项检查）。

## 结论

**H4d 证据真实、内部一致，证据层级诚实。** 4 个代码/测试文件的 commit blob 哈希与声明一致；实现者隔离 1345/1345（`911b8e7a…`/146824）、Lead 独立 slice 1345/1345（`55b0d880…`/146852）、targeted 54/54（`0563a70e…`）与 116/116（`8f28952e…`）均匹配；`h4d-verify.json` 的 files[] 与日志 sha 可核；prepare 持久/回读/重开、幂等、旧记录 not_provided、封闭负例、撤回/降级、Lab 30s/120s 边界、跨会话拒绝均有真实断言；无 `.skip/.only/恒真断言`；提交范围仅 9 文件（无 runtime/index/client/views/dsh adapters）；无绝对 home 路径/秘密/正文；边界 G1 自述与 DSH §18 一致；H4c G5 修正版已入库（`e8a529e8…`/11901），`h4c-slice-summary` 的 26+6 残留已改为 “25 既有 + 7 新增”。

## 唯一非阻断差异（H4D-F1）

提交内 `h4d-prepare-inner.json` 是旧 blob `b0017279…`/14963B（无 `lifetimeNote`）；工作树新版本 `2f7911c5…`/16503B（含 lifetimeNote）未提交。实质内容/计数/日志哈希/边界均无差异，lifetimeNote 只是解释性持久化说明；建议可选单文件后续提交，否则记录为有意差异。

## 边界

- 本轮为 task-18 之后的 H4d follow-up 复核，不替代已冻结于 `a68eeb2` 的 H2–H6 报告；HEAD 现为 `66a9428`。
- 未独立重跑套件（只读；以保留日志+Lead slice-verify 二次执行为证）；真实模型使用 innerSources、真实 Lab 房间未测（证据已声明）。
