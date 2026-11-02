# scripts/harness

薄启动器：真正的实现在 `tests/harness/*.ts`（与测试一起被 `npx tsc --noEmit` 检查），这里只是让文档命令可从插件根直接运行。

| 命令 | 作用 |
|---|---|
| `node scripts/harness/manifest.mjs` | 冻结源码/构建/环境/fixture/oracle/VCS 摘要到 `artifacts/dsh/harness/manifest.json`，生成期脱敏 fail-closed |
| `node scripts/harness/selfproof.mjs` | 运行全部 `tests/harness-*.test.ts`（TAP），冻结 `tool-selfproof.json` / `.tap` |
| `node scripts/harness/traceability.mjs [--strict]` | 来源核验 + 证据计算，生成 `traceability.json` / `traceability.md`；`--strict` 在 H0 能力未全部 `self_proven` 时退出 3 |
| `node scripts/harness/fl-scenarios.mjs [--require-selfproof]` | H0c S/FL 业务骨架：生成合成 fixture、独立答案集、覆盖索引与 H1–H8/功能/质量分离的评分骨架到 `artifacts/dsh/harness/fl-scenarios/`；0 真实模型/Lab/宿主调用，状态只能是 `synthetic-fixture-only-not-run`，**还不能用于业务验收** |

均从 `plugins/shiyu/` 目录执行；详细说明、证据复核步骤与限制见 [tests/harness/README.md](../../tests/harness/README.md)。

固定顺序：`manifest.mjs` → `selfproof.mjs` → `traceability.mjs --strict` → `fl-scenarios.mjs --require-selfproof`。任何 harness 源文件变化后重跑该顺序；traceability 会把过期 selfproof 标为 stale 而非继续通过。H0c 产物是 DEV 合成骨架（含 `answers/` 评估侧答案集与 `coverage.*`），不是 HOLDOUT、不是已验证、不是业务验收。
