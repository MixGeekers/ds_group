# H1 独立验证最终报告（task-3 收口）

- 结论对象：H1/3J「原生 Session 长历史冷恢复、恢复前缀身份与授权/派发边界」离线切片
- 被测提交：`92c857fcfe5d823836b48ea9c9df09fcdeb14981`（feat(shiyu): recover long native Session history with bounded paging (H1/3J)，2026-11-02 14:48:57 -0400）
- 独立运行：`2026-11-02T18-49-33-366Z-final-92c857f`（`artifacts/dsh/verify/runs/2026-11-02T18-49-33-366Z-final-92c857f/`）
- 独立类型检查：`npx tsc -p tests/verify --noEmit` 通过
- 判定器自证：C00a–C00f 通过（手工应过/应拒样本 + 1 正确/3 故障突变体端到端突变测试）
- 产品行为缺口：**无**（117 条独立用例全部通过；失败/blocked/unobservable/skip/unreported 均为 0）
- 证据真实性复核：实现者最终 check、独立复现、Lead 隔离切片验证三者一致（见 §5）
- 证据层级：**G1 离线（合成原生替身 + 固定 SDK 静态契约）+ 组合级业务路径**；不冒充真实宿主/模型/压缩/长期运行验收

## 1. 运行与冻结清单

| 项 | 值 |
|---|---|
| 运行命令 | `node --import tsx tests/verify/report.mjs --label final-92c857f`（内部：`node --import tsx --test --test-concurrency=1 --test-reporter=tap tests/verify/*.test.ts`） |
| 独立 tsconfig | `tests/verify/tsconfig.json`；`npx tsc -p tests/verify --noEmit` = 0 退出 |
| 环境 | Node `v24.19.0`，`darwin/arm64`，工作目录 `plugins/shiyu` |
| 时间/耗时/退出码 | `2026-11-02T18:49:33.366Z` / `37.4s` / `0` |
| git | HEAD `92c857fcfe5d823836b48ea9c9df09fcdeb14981`，分支 `codex/start-shiyu-implementation`；H1 9 文件在工作树与提交中一致（`git show 92c857f:<path>` 逐项核对） |
| 隔离声明 | 合成内存原生世界 + 合成业务宿主；不连接真实 DSH 宿主、模型、embedding、频道或用户数据；SDK 仅只读静态核对，未执行 |

冻结指纹（完整见 `manifest.json`）：

产品 6 文件：
  - `src/adapters/dsh/native-context.ts` `747450b8b7c63087961f9faf68802c7d78704a5ac175e84900bcaaf1bdf5b794`
  - `src/adapters/dsh/native-message.ts` `41211c6646e7c3f999976cb330fd1c6f2ffbcd2e5c5f92906787391525337d72`
  - `src/adapters/dsh/session-title.ts` `624039d6d2bb927d7648826d991795875422f1a09197735d5a0e6ef77dc0d052`
  - `src/adapters/dsh/sessions.ts` `c856085a936d958071eb3c71a249696be136f802a52f07f5401badef9c290e90`
  - `src/adapters/dsh/goals.ts` `788cf6a237c1f0bc9cf50b6e08f2f8f1d0b5ebf02cbbf8cf9ac0689716d8470c`
  - `src/adapters/dsh/core-decision.ts` `4ceb0a291fc08129a365dc304d260e1268c5993f610cdec55a4af8ada7e67769`
固定 SDK 0.2.1-rc.5（app.asar 只读）7 包：
  - `dsh-session/lib/index.js` `2f5dd07cb5c744a29abbb8003a8a4cefd9e582c6e2538074ca299a0ddd02a3bf`
  - `dsh-session-persistence/lib/index.js` `cc0b6d3a224133af611b428d5a49020e300f86c3b4ba28037aeb219029bde3eb`
  - `dsh-session-persistence-jsonl/lib/index.js` `973dd78679b2661d6f492343bc22b124ae958aa597d3b36c698a2c650f909984`
  - `dsh-session-projection/lib/index.js` `7dc2b212819baf4fc292751054d30b97afcbdee0a4733230abf92c6722e6550c`
  - `dsh-agent-loop/lib/index.js` `cf57e3ecd487ac5c2553455aaa5cef2c6fb41e6bd61be5aa455675d1d7193033`
  - `dsh-session-title/lib/index.js` `eb814490ca3d0aaabf8f6ddc705a031f99a98709c484c1502c5f28f101cf0eeb`
  - `dsh-goal/lib/index.js` `8ec52107ead3d31f4d8ca95894c851046a2cbbd1b2033a0ea22fedf17c043ae4`
独立测试 9 文件：
  - `00-oracle-selftest.test.ts` `4472404437b94b585e8d4ca4c78cbc9ad2ee05ec674441b1ba34156bfacd52cb`
  - `10-legal-history.test.ts` `28c561371c2a268574fef6b1cfff300ac3a93dc00caf86cdad55eebc6a069e7e`
  - `20-invalid-history.test.ts` `5e12e3e81fe9850fa9bdcfa5d8f3e93f3baf4cb9680bf6c729023672474ce051`
  - `30-races.test.ts` `ccc0a728be631ad829e88f1cb6305e5bf84c117dbe9b8cb2f2145006d2ecf8bb`
  - `40-limits.test.ts` `340b534e42aa564fdadbc9a141a805b61355ec9cb949666f9aef3a76f31382a7`
  - `50-recovery.test.ts` `bf62bb1e8827e18643faceb59249051e4e997233248cf337544ec9cfafcd9b11`
  - `60-business-loadonly.test.ts` `fcc5ec47d8354f9ba59b3ca749c965bb90c32616dc1f23f142cc174f3110c13b`
  - `70-business-replyer.test.ts` `be76c9b936b4d989f24bc27bb4978b0d6337f58b4070074d7148bdc83d967552`
  - `80-business-core.test.ts` `4900aba41215a30e6c16924bb1ba21f01072079b719ad171023e483c41a08533`

## 2. 分母（与 `results.json.summary` 一致）

| 类别 | 用例 | 通过 | 失败 | blocked | unobservable |
|---|---|---|---|---|---|
| B declared capacity bounds | 7 | 7 | 0 | 0 | 0 |
| C judge self-verification | 6 | 6 | 0 | 0 | 0 |
| CO core business path | 5 | 5 | 0 | 0 | 0 |
| I invalid history/backend | 28 | 28 | 0 | 0 | 0 |
| L legal long history | 13 | 13 | 0 | 0 | 0 |
| LO load-only business path | 13 | 13 | 0 | 0 | 0 |
| R races/cancellation/limits | 12 | 12 | 0 | 0 | 0 |
| RP replyer business path | 10 | 10 | 0 | 0 | 0 |
| S recovery continuity | 23 | 23 | 0 | 0 | 0 |
| **合计** | **117** | **117** | **0** | **0** | **0** |

TAP 测试级：`103` 个 = 通过 `103` / 失败 `0` / blocked `0` / unobservable `0` / unreported `0` / skip `0`。
判定口径：TAP 绿 **且** 关联证据全部 pass 才算通过；blocked/unobservable/unreported 单列、不计通过。聚合器否定对照见 `negative-control.json`（故意失败/blocked/无证据三类注入均被正确判非通过，退出码 1）。

## 3. 03 §5 覆盖矩阵（行为目标 → 本套件测试 ID → 结果）

| # | 03 §5 行为目标 | 有记录/计划 | 状态 | 失败 |
|---|---|---|---|---|
| 1 | 03 §5 row1: 空史/2048±/远超一页/页间inbox插入移除/继承seed 恢复正确官方投影，同业务 Session 身份保留，不能只证明超限拒绝 | 21/21 | covered | — |
| 2 | 03 §5 row2: 短页合法继续；缺号/重复乱序/页超量/坏header/preset/继承/−0 失效无接受回执、资源释放 | 30/30 | covered | — |
| 3 | 03 §5 row3: 读取中/EOF后/投影中追加；同长度早段变化、缩短 被检测或按受信规则重取，不默默拼混合历史 | 8/8 | covered | — |
| 4 | 03 §5 row4: 原生合法中断收尾/end-seed/固定标题与异源 user 混入；合法恢复成功、未知输入不被丢/自动执行 | 8/8 | covered | — |
| 5 | 03 §5 row5: 授权await、onDispatch await、冷读后 live.seq/inbox 变化 → 最终接纳门拒绝失效基准，不产生错误 context receipt/草稿资格 | 10/10 | covered | — |
| 6 | 03 §5 row6: 取消、期限、读/投影/关闭失败、关闭后迟到 → handle/agent 生命周期可核对，无静默新 Session/重试未知效果，不泄漏正文 | 7/7 | covered | — |
| 7 | 03 §5 row7: load-only、replyer、Core 各自正常长史路径；精确本次原生消息+flush+独立回读才给 receipt；生成路径在明确预算下推进 | 9/9 | covered | — |
| 8 | 02 §3.2 / 03 §5 row8: 判定器自证（应过/应拒样本），测试/替身/SDK静态分别留证不互相冒充 | 8/8 | covered | — |

逐目标测试 ID（详见 `runs/2026-11-02T18-49-33-366Z-final-92c857f/results.md` §3 与 §5）：
- row1 合法长史/边界/多页/继承 seed/身份：L01–L13、R02–R03、S17、LO02/LO08/LO11/LO13、RP02/RP06/RP10、CO01
- row2 非法输入/坏 header/preset/继承/−0/资源释放：I01–I27、L06、L12
- row3 读取中/EOF 后/投影中变更/同长度改写/缩短：R01–R07、S07
- row4 合法恢复后缀 vs 异源输入：S02–S06、S12、S14、S19、RP08/RP09、LO11
- row5 授权/onDispatch await 后基准失效：S13/S16、LO03/L04/L07/L09/L12、RP03/RP04、CO02/CO03/CO04
- row6 取消/期限/读/投影/关闭失败：I21/I22、R08–R12、LO06/LO07
- row7 三类业务路径精确消息+flush+独立回读+预算：LO01/LO10、RP01/RP05、CO01
- row8 判定器自证与分层证据：C00a–C00f、B00、S00/S18、negative-control.json

判定器自证要点：C00a/C00b/C00c/C00d 为手工应过/应拒样本；C00e 校验替身语义；C00f 用 1 个正确手写 reader 通过、3 个故障 reader（单遍、陈旧 cut、短页当 EOF）全部被拒；聚合器否定对照证明 fail/blocked/unreported 不会被记成 pass。

## 4. Issue 清单（最终）

**A. 产品行为问题：无。** 117/117 通过；未发现静默截断、错误接收回执、异源输入被吞、重复派发、旧基准放行或正文泄漏。

**B. 证据/环境事项（均不改变产品行为结论）：**
| ID | 状态 | 事实 | 证据 |
|---|---|---|---|
| B-01 主套件曾红（旧夹具） | **已解决** | 曾被 `tests/session-reply-accounting.test.ts` 旧夹具阻塞；已由实现者按新契约更新（加 canonical version-4 header、seq/inherited/append、runMaintenance、sessions.get、projector asOfSeq、真实 fixed-title append），未删除/跳过断言 | `92c857f` 提交；`phase3j-final-check.log` 1058/1058/0；独立复现一致 |
| B-02 全量 check 受并行 WIP 干扰 | **已规避** | 主树同时有 H4/H5 等未跟踪 WIP，直接全量 check 不可归因；实现者与 Lead 均在隔离 worktree 运行并留哈希 | 实现者 `/tmp/shiyu-h1-check`；Lead `artifacts/dsh/slices/h1-verify.json` |
| B-03 实现者自测覆盖缺口 | **已解决** | 最终版新增 `tests/native-history.test.ts` 14 项业务路径集成测试 + core-goal +3；模块级 22 项真实断言 | `92c857f` 测试文件与 EV-07 |
| B-04 最终 check 证据 | **已核实** | 日志 SHA256 `8c05c87f…` 与声明一致；独立复现 exit 0、1058/1058/0/skip 0；源文件哈希前后不变 | `implementer-evidence-review.json` EV-02/EV-03；`replication-final-check.log` |
| B-05 文档时间戳小差异 | **记录** | 实现者 `h1-verification.json` 记 startedAt=18:39:49Z，保留日志头为 18:42:44Z（计数/哈希/退出码/复现均一致，属元数据不一致） | `implementer-evidence-review.json` EV-09 |

**C. 明确未覆盖/不可观察项（按 03 §5 最后一行分层留证，不是失败）：**
| 未覆盖行为目标 | 原因 | 需要的后续证据 |
|---|---|---|
| 真实 DSH 宿主上的长历史冷恢复/恢复（真实 JSONL、projection、agent resume；零模型） | 本套件为合成原生替身+固定 SDK 静态契约层，不执行真实宿主 | Lead 冻结的 G3/V24 零模型重载/隔离根验证 |
| 真实模型生成、标题/压缩旁路、provider 内部重试与计费/缓存完整性 | 不调用模型或网络 | 有界真实模型批次与独立观测器；压缩单独评估 |
| 原生压缩/检查点之后的恢复 | H1 实现尚未接线压缩 | H1 后续切片（03 §2 明确为长期目标） |
| 跨进程或任意外部写者条件下的原子快照 | 固定 SDK 是 append-only 合同而非原子快照（03 §3 已声明边界） | 不承诺；按观察/使用边界留证 |
| 真实后端内存/IO 成本与资源上界、长期运行稳定性 | 替身不提供真实解码/存储成本 | 宿主性能与长期运行测试 |
| 真实频道、设备、备份与恢复（H2+、V21/V22/V26/V27） | 资源与授权范围之外 | 后续切片 |

## 5. 实现者证据真实性复核结论

| 证据 | 检查 | 结论 |
|---|---|---|
| H1 提交 9 文件 SHA256 | `git show 92c857f:<path>` vs 独立 manifest 逐项 | **完全一致** |
| 实现者最终 `npm run check` 日志 | SHA256 `8c05c87f719afc9ea2ecc7b3fac690d89827e741b00b2c455d36505b0da5c258` 与声明一致；日志自身含 worktree/HEAD/9 文件哈希、typecheck、1058/1058/0/0、build、client 语法、exit 0 | **真实且内部一致** |
| 独立复现实现者 check | 在同一隔离 worktree 重跑 `npm run check`：exit 0、1058/1058/0/skip 0、build 通过；运行前后 9 文件哈希不变 | **可复现**（`replication-final-check.log`，SHA256 `c6181832…`） |
| Lead 隔离切片验证 | `artifacts/dsh/slices/h1-verify.json`：HEAD 08995d1 + 9 文件、1058/1058/0/skip 0、exit 0；日志 SHA256 `aa342679…` 与声明一致；工具 `scripts/slice-verify.mjs` 经审阅为真实隔离 worktree + `npm run check` + 原始日志哈希，不是硬编码结论 | **真实且与实现者一致** |
| 测试计数算术 | 1021（H0 前基线日志）+ 4（H0 host-status，已在 08995d1）+ 33（H1：native-context 6→22、native-history +14、core-goal 17→20）= 1058 | **一致，无删除基线测试** |
| 静默跳过/削弱断言 | 5 个改动测试无 `.skip/.only/assert.ok(true)`；日志 skipped=0/todo=0；diff 未见删除断言；旧测试放宽的少数错误正则仍保留“必须拒绝+零回执+句柄闭合/异源保留”断言 | **未发现静默通过** |
| 报告诚实性 | 实现者明确列出真实宿主/模型/压缩/非 core Goal/协作式取消/非原子快照等未覆盖项，未宣称宿主验收 | **与证据层一致** |

实现者自测覆盖评价：模块级 22 项 + 业务集成 14 项 + core 3 项，含边界值、错误码、canary、两遍复读、expectedPrefix 正反例、授权/派发窗口竞态与重启复用，均为真实断言；未发现“复制实现逻辑当 oracle”的证据。少数断言较宽松（如取消测试 `opens >= closes`）或正则放宽，但都有独立的“零回执/不派发/异源保留”硬断言兜底，不构成静默通过。

## 6. 独立验证自身的独立性声明与边界

- 预期仅来自 DSH交接 00–03 与固定 SDK 0.2.1-rc.5 静态契约；未读取实现者测试断言作为预期来源。
- 判定器 `tests/verify/support/independent.ts` 不 import 产品源码（report 静态检查 `judgeImportsProduct=false`，命中即退出码非 0）；世界/宿主替身独立实现；业务路径替身不复用实现者夹具。
- 判定器经手工应过/应拒样本、替身语义自检、端到端突变测试与聚合器否定对照验真。
- 任何产品/SDK/测试变更都会使本结论失效；本报告绑定精确 SHA256（manifest.json）。
- **证据层级：G1 离线（合成原生替身 + 固定 SDK 静态契约）+ 组合级业务路径**。不替代真实宿主（G3/V24 零模型或长对话）、真实模型生成/压缩/计费/缓存、长期运行与真实渠道/设备/备份验收。

## 7. 下一步

1. H1 后续：真实固定宿主零模型长历史/重载验证（Lead 冻结隔离根与重载窗口），再把有界真实长对话纳入；不得用本离线结论冒充宿主验收。
2. 原生压缩/检查点集成（03 §2 长期目标）单独切片评估；缓存/旁路计量按 6.7 留证。
3. 生命周期（非 core）Goal namespace 的恢复基准接线如需，另行评估（实现者已声明保持旧行为）。
4. 若后续任何 H1 文件变化：重跑 `node --import tsx tests/verify/report.mjs`，以新 manifest 覆盖本报告结论。

## 8. 证据索引

- 独立结果：`artifacts/dsh/verify/runs/2026-11-02T18-49-33-366Z-final-92c857f/results.json`、`results.md`、`tap.txt`、`manifest.json`、`raw/*.jsonl`
- 本轮最新：`artifacts/dsh/verify/latest.md` / `latest.json`
- 判定器自证与否定对照：`00-oracle-selftest.test.ts`、`artifacts/dsh/verify/negative-control.json`
- 实现者证据复核：`artifacts/dsh/verify/implementer-evidence-review.json`、`replication-final-check.log`、`replication-before/after-hashes.txt`
- 实现者与 Lead 证据（只引用，不复制）：`plugins/shiyu/.local/phase3j-final-check.log`（8c05c87f…）、`artifacts/dsh/slices/h1-verify.json`、`.local/slice-verify-h1.log`（aa342679…）、`artifacts/dsh/h1/h1-verification.json`
- 复核方法：`tests/verify/README.md` §6
