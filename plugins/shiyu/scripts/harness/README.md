# scripts/harness

薄启动器：真正的实现在 `tests/harness/*.ts`（与测试一起被 `npx tsc --noEmit` 检查），这里只是让文档命令可从插件根直接运行。

| 命令 | 作用 |
|---|---|
| `node scripts/harness/manifest.mjs` | 冻结源码/构建/环境/fixture/oracle/VCS 摘要到 `artifacts/dsh/harness/manifest.json`，生成期脱敏 fail-closed |
| `node scripts/harness/selfproof.mjs` | 运行全部 `tests/harness-*.test.ts`（TAP），冻结 `tool-selfproof.json` / `.tap` |
| `node scripts/harness/traceability.mjs [--strict]` | 来源核验 + 证据计算，生成 `traceability.json` / `traceability.md`；`--strict` 在 H0 能力未全部 `self_proven` 时退出 3 |

均从 `plugins/shiyu/` 目录执行；详细说明、证据复核步骤与限制见 [tests/harness/README.md](../../tests/harness/README.md)。

固定顺序：`manifest.mjs` → `selfproof.mjs` → `traceability.mjs --strict`。任何 harness 源文件变化后重跑该顺序；traceability 会把过期 selfproof 标为 stale 而非继续通过。
