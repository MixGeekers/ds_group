# H0 测试工具（识雨 DSH 插件）

本目录是 H0 交接包的测试基础设施实现：独立 oracle 判定器、故障注入/时钟、独立观察器与效果账本、运行 manifest、覆盖追踪。**这些工具自身经过 known-pass / known-reject 验真；它们不是产品实现，也不构成任何 V/S/FL 验收结论。**

依据：[02-测试设计与验收标准](../../../../架构与设计/DSH交接/02-测试设计与验收标准.md) §1–§4、§9；[01-九系统剩余目标与边界](../../../../架构与设计/DSH交接/01-九系统剩余目标与边界.md)；[九大系统实施与验证计划](../../../../架构与设计/九大系统实施与验证计划.md) §5/§7。

## 文件布局

| 路径 | 作用 |
|---|---|
| `invariant.ts` | `CheckResult`/`Violation` 判定器契约、`assertCheck` 发布门适配器、自证框架（每个 oracle 必须同时有 known-accept 与 known-reject） |
| `json.ts` | 无损 JSON 判定（undefined/NaN/±Infinity/-0/稀疏数组/非普通原型/符号键/访问器/循环引用），JSON 文本重复键与孤立代理项，`canonicalJsonString` |
| `schema.ts` | 声明式结构 schema 判定（type/required/additionalProperties/enum/pattern/format/范围/uniqueItems/oneOf） |
| `cas.ts` | 单行 CAS 重放（同版本竞争恰 1 胜、旧 expectedVersion 拒绝、写偏斜） |
| `state-machine.ts` | 显式转移表模拟与观测历史判定（终态推进/非法转移/断链/歧义表） |
| `counts.ts` | 分母与守恒（缺失≠0、90/100 不得宣称完成、调用数含压缩/重试、缺失用量未知、周期遗漏、静默窗口 0 模型调用） |
| `causal.ts` | 效果账本与产品知识对齐（执行一次丢回执=1 次效果、unknown 不得冒充成功、非幂等重复=失败）、event→…→delivery 因果链 |
| `version-domains.ts` | 版本域判定（read-only 不得推进、任务进度不改 stateVersion、单一全局版本声明拒绝） |
| `authority.ts` | 授权表判定（主体/动作/资源/受众/期限/撤销/预算）、正文冒充控制、canary 泄露扫描（含“扫描器未运行”失败） |
| `faults.ts` | `AbsoluteDeadline`+AbortSignal 绝对期限、`BusinessClock` 假业务时钟（DST 跳过/重复、latest-only 漏过）、命名断点 `FaultInjector` |
| `observer.ts` | append-only JSONL 观察账本（fsync、序号、SHA256 链、截断/篡改检出）、接收端独立效果账本、独立计数与因果对齐 |
| `manifest.ts` | 运行 manifest 冻结与脱敏（源码/构建/环境/fixture/oracle/VCS 摘要） |
| `traceability-registry.ts` | 需求注册表：01 九系统、02 §1/§3.2/§5/§6/§8、计划 V01–V27 与 S/FL/H 维度 |
| `selfproof.ts` | 自证执行器：真实运行 `tests/harness-*.test.ts`，解析 TAP，冻结 artifact，校验 stale/伪通过 |
| `traceability.ts` | 覆盖追踪生成器：来源核验→证据计算→JSON+Markdown→诚实性门 |
| `fixtures/crash-child.ts` | 真实子进程崩溃夹具（临时 SQLite + 观察账本 + 命名崩溃断点） |
| `../../tests/harness-*.test.ts` | 根级主 glob 测试：全部 oracle 自证、故障/时钟、观察器/崩溃、manifest、追踪、自证 artifact 校验 |

工具实现在本目录（被测试 import，因此 `npx tsc --noEmit` 会传递检查）。`scripts/harness/*.mjs` 只是薄启动器，方便从插件根运行 TypeScript 实现。

## 如何运行

从 `plugins/shiyu/` 目录：

```bash
# 1) 只跑 H0 工具自证（也会被 npm test 主 glob 包含）
node --import tsx --test --test-concurrency=1 tests/harness-*.test.ts

# 2) 冻结 manifest（源码/构建/环境/fixture/oracle/VCS）
node scripts/harness/manifest.mjs

# 3) 运行全部自证并冻结 TAP 与结果（零 skip；失败也写 artifact，passed=false）
node scripts/harness/selfproof.mjs

# 4) 生成覆盖追踪 JSON + Markdown；--strict 在 H0 能力未全部 self_proven 时退出码 3
node scripts/harness/traceability.mjs --strict

# 5) 全量检查（typecheck + 主 glob 全部测试 + build + client 语法）
npm run check
```

产物在 `plugins/shiyu/artifacts/dsh/harness/`：

| 产物 | 内容 |
|---|---|
| `manifest.json` | 冻结文件 SHA256/聚合摘要、Node/SQLite/TS/tsx/DSH 插件版本、oracle 目录、VCS head、脱敏声明 |
| `tool-selfproof.json` / `.tap` | 每个 harness 测试文件 hash/exit/逐测试名通过状态、每个 `oracle:<name>` 自证结果、源码 hash（用于 stale 检测） |
| `traceability.json` / `traceability.md` | 需求→来源→代码路径→测试 ID→oracle→证据→状态/未覆盖；产品行与 H0 能力行分开计数 |

重新生成顺序固定为 manifest → selfproof → traceability；selfproof 之后源文件若变化，traceability 会把自证标为 stale 而不是继续绿。

## 自证如何工作（判定器先验真）

- 每个 oracle 导出一个 `OracleSelfProof`：`samples`（同步输入）和/或 `scenarios`（真实文件/SQLite/子进程/时钟），每条都声明 `expect: accept|reject`；reject 必须声明预期 violation codes。
- `tests/harness-oracles.test.ts` 对每个 oracle 运行 `runSelfProof`：known-reject 被接受 → 测试失败；known-accept 被误拒 → 测试失败；没有 reject 样本 → 契约失败。每个 oracle 的输出行包含 `samples/scenarios/known-accept-pass/known-reject-caught`。
- `selfproof:framework-rejects-accepting-oracle` 额外注入一个“永远接受”的假 oracle，证明框架本身会让它失败——防止“判定器只证明自己会对正确样本返回 true”。
- `selfproof.ts` 把这些真实 TAP 结果冻结成 artifact；`checkSelfProofArtifact` 拒绝 `passed:true` 与失败并存、缺 oracle 测试、缺测试文件、源码 hash 与当前树不一致（stale）的 artifact。

## 如何接入后续切片

> **H0b 交接规则（机器可读字段即 traceability JSON 的 `handoff`）**：H0b 之后产品行由后续切片按其实际证据更新；禁止后续切片复用 H0 的 `tooling_ready` 冒充产品通过，也不得用 H0 oracle 自证或历史有限证据覆盖 `not_covered`。`tooling_ready` 只表示“判定器已自证、产品场景未运行”。

1. **新增 oracle**：在 `tests/harness/` 新模块实现 `checkXxx(...): CheckResult`（不要 throw），导出 `OracleSelfProof`（必须 ≥1 known-accept、≥1 known-reject），在 `index.ts` 注册进 `ALL_SELF_PROOFS`；主 glob 的 oracle 测试会自动执行它并计入 artifact。
2. **新增场景/组合/故障用例**：放在根级 `tests/harness-<topic>.test.ts`（主 glob `tests/*.test.ts` 会包含），测试名用唯一前缀（例如 `channel:pause-mid-dispatch`），不要依赖 sleep 猜竞态；用 `FaultInjector` 命名断点与 `BusinessClock` 显式推进。
3. **接入独立证据**：用 `AppendOnlyLedger`/`IndependentEffectLedger` 在**产品数据根之外**记录接收端事实；把产品事实与接收端事实用 `causalKey`/identity 对齐后再写断言。
4. **登记需求覆盖**：在 `traceability-registry.ts` 增加或补全行的 `testIds`/`oracles`/`codePaths`/`verification.requiredTests`；产品行只能填 `codePaths`/`testIds`（真实运行后由证据层决定状态），不得手写通过。
5. **H0 能力行**：`verification.requiredTests` 必须指向真实测试名，`requiredArtifacts`/`oracleRefs` 必须能由 artifact 验证；否则状态只会停在 `partial_tooling`/`not_covered`。
6. **证据保留**：产品运行另建 `artifacts/` 切片清单（manifest、逐例结果、原始脱敏 trace、独立效果账本、失败/unknown/skip 分母）；H0 的三个 artifact 只证明工具自身。

## 证据如何复核

```bash
cd plugins/shiyu

# artifact 摘要独立重算
shasum -a 256 artifacts/dsh/harness/manifest.json
python3 - <<'EA'
import json,hashlib
m=json.load(open('artifacts/dsh/harness/manifest.json'))
entries=[f for g in m['groups'] for f in g['files']]
text=''.join(sorted(f"{e['sha256']}  {e['path']}\n" for e in entries))
print('aggregate', hashlib.sha256(text.encode()).hexdigest())
print('recorded ', m['aggregates']['digest'])
EA

# self-proof 逐 oracle 通过名
node -e "const a=require('./artifacts/dsh/harness/tool-selfproof.json'); console.log(a.passed, a.totals); for (const o of a.oracleSelfProofs) console.log(o.name,o.verified)"
```

人工复核步骤：

1. 用 `shasum -a 256` 核对 README/报告声明的 artifact SHA256 与文件一致。
2. 打开 `tool-selfproof.json`：`passed:true`、`totals.fail=0`、每个 `oracleSelfProofs[].verified=true`、`files[]` 覆盖所有 `tests/harness-*.test.ts`；再核对 `sourceHashes` 与当前 `tests/harness/**` 一致（不一致 = 过期证据，必须重跑 selfproof 与 traceability）。
3. 打开 `manifest.json`：任取 `groups[].files[].path` 重算 SHA256；`environment` 应为本机实际版本；`vcs.head` 应是本次源码基线；全文不得出现 `/Users/`、home 路径、`sk-*`、私钥块等（生成期会 fail-closed 拒绝）。
4. 打开 `traceability.json`：`summary.product.covered` 必须为 `0`；产品行（九系统/矩阵/V/S/FL/H/组合场景）状态只能 `not_covered`；H0 能力行 `self_proven` 必须有 `verifiedTests`/`artifactChecks` 或 `oracleStatus` 证据，`tooling_ready` 只表示判定器就绪而场景**未运行**。
5. 对任一需求行沿 `source.doc + heading/contains` 追回原始 Markdown；`sourceVerified=false` 或生成期 `issues` 非空即报告不可用。
6. 单独查看 `historicalEvidence`：历史有限证据（phase3h/3i 等）只作线索，状态一律不计入。

## 已知限制与边界

- **只证明工具自身**：H0 artifact 不证明产品 V01–V27、九系统、S/FL/E1–E3、真实宿主、模型语义、费用或设备行为；报告中的 `not_covered` 不得读作通过。
- **不是秘密隔离**：同一机器/同一用户下的两个目录不构成安全边界；HOLDOUT 答案隔离需独立保管与访问控制，本工具只检查观察器账本不在产品数据根内。
- **哈希链不是签名**：SHA256 前后链能发现截断/坏行/普通篡改，但不能抵御拥有整文件写权限者的完整重写；manifest 只证明文件一致，不证明业务正确或采集完整。
- **时钟边界**：假业务时钟覆盖 DST 跳过/重复与遗漏周期记账，但假时钟 7 天 ≠ 连续真实运行 7 天；真实期限测试用单调时钟与 AbortSignal，只能证明“停止被请求/观察到”，不证明所有在途外部效果已停止。
- **观察器边界**：只能记录被接线路径的事实；未观察到的目录、网络、provider 内部请求/缓存/费用为 `unknown`，不能填 0。
- **故障注入边界**：命名断点证明故障发生位置，不证明未覆盖代码路径的故障行为；崩溃夹具用真实子进程+临时 SQLite+独立 JSONL，但仍限于合成路径。
- **不触达真实资源**：这些命令不调用模型/embedding/渠道/设备/宿主运行时，不修改产品 `src`、`runtime.ts`、`package.json` 脚本。
- **证据新鲜度**：任何 harness/产品代码变化后必须重跑 manifest → selfproof → traceability；traceability 会把 stale selfproof 降级并列出问题，不沿用旧绿。
