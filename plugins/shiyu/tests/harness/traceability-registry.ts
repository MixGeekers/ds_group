/**
 * Machine-readable requirement registry for the H0 traceability report.
 *
 * Rows are transcribed from the handoff documents:
 * - 01 §2–§10: the nine systems and their remaining goals;
 * - 02 §1: required test assets; §3.2: tool-verification samples;
 *   §5: acceptance matrix; §6.1–§6.10: combined/long-run/fault scenarios;
 *   §8: S01–S08, FL01–FL08 and the H1–H8 scoring dimensions;
 * - 九系统计划 §5: V01–V27 thresholds (original V wording stays in
 *   A方案全景/验证与验收.md and is referenced, not re-numbered).
 *
 * IMPORTANT: product-facing rows (nine-system/v-item/business/fl/combo/
 * matrix/scoring) are registered so coverage can be audited; their status is
 * always computed as `not_covered` in H0 because no product verification ran
 * here. Only `harness-capability` rows can become `self_proven`, and only
 * from the frozen self-proof artifact plus verified file/oracle identities.
 *
 * `source` refs are verified against the real markdown headings by the
 * generator (`verifySourceReferences`); a drifted document fails the report
 * instead of silently losing traceability.
 */
import type { RequirementSource } from './traceability-types.js';

export const SOURCE_DOCUMENTS: readonly { readonly id: string; readonly path: string; readonly title: string }[] = [
  { id: 'doc-01', path: '架构与设计/DSH交接/01-九系统剩余目标与边界.md', title: '01 九系统剩余目标与边界' },
  { id: 'doc-02', path: '架构与设计/DSH交接/02-测试设计与验收标准.md', title: '02 测试设计与验收标准' },
  { id: 'doc-plan', path: '架构与设计/九大系统实施与验证计划.md', title: '九大系统实施与验证计划' },
  { id: 'doc-v', path: '架构与设计/A方案全景/验证与验收.md', title: 'A 方案验证与验收（V01–V27 原文）' },
];

export type RequirementKind =
  | 'nine-system'
  | 'v-item'
  | 'business-scenario'
  | 'fl-scenario'
  | 'scoring-dimension'
  | 'combo-scenario'
  | 'system-matrix'
  | 'tool-verification'
  | 'harness-asset'
  | 'harness-capability';

export interface VerificationSpec {
  /** TAP test names that must be present and passing in the self-proof artifact. */
  readonly requiredTests?: readonly string[];
  /** Artifacts that must exist and validate: manifest / selfproof / traceability. */
  readonly requiredArtifacts?: readonly ('manifest' | 'selfproof' | 'traceability')[];
  /** Oracle catalogue entries that must be self-proof verified. */
  readonly oracleRefs?: readonly string[];
  /** Files whose existence is part of the capability. */
  readonly requiredPaths?: readonly string[];
  /** Downgrade to partial_tooling when only some checks pass (H0 assets in progress). */
  readonly allowPartial?: boolean;
  readonly missingNote?: string;
}

export interface RequirementRow {
  readonly id: string;
  readonly kind: RequirementKind;
  readonly title: string;
  readonly source: RequirementSource;
  readonly systems: readonly string[];
  readonly refs: { readonly v?: readonly string[]; readonly s?: readonly string[]; readonly fl?: readonly string[] };
  /** Frozen threshold/expectation summary; original wording remains in the source doc. */
  readonly thresholds: readonly string[];
  /** Product code paths; intentionally empty in H0 (no product mapping was made). */
  readonly codePaths: readonly string[];
  /** Test IDs (TAP names or planned scenario IDs). */
  readonly testIds: readonly string[];
  /** Oracle catalogue ids used by this requirement. */
  readonly oracles: readonly string[];
  /** Historical limited evidence, never counted as coverage. */
  readonly historicalEvidence: readonly string[];
  readonly note: string;
  readonly verification?: VerificationSpec;
}

function source(doc: string, heading: string, contains: string): RequirementSource {
  return { doc, heading, contains };
}

function row(
  id: string,
  kind: RequirementKind,
  title: string,
  ref: RequirementSource,
  extra: Partial<Omit<RequirementRow, 'id' | 'kind' | 'title' | 'source'>> = {},
): RequirementRow {
  return {
    id,
    kind,
    title,
    source: ref,
    systems: extra.systems ?? [],
    refs: extra.refs ?? {},
    thresholds: extra.thresholds ?? [],
    codePaths: extra.codePaths ?? [],
    testIds: extra.testIds ?? [],
    oracles: extra.oracles ?? [],
    historicalEvidence: extra.historicalEvidence ?? [],
    note: extra.note ?? '',
    ...(extra.verification === undefined ? {} : { verification: extra.verification }),
  };
}

/* ------------------------------------------------------------------ */
/* H0 harness capabilities (the only rows that may become self_proven). */
/* ------------------------------------------------------------------ */

export const HARNESS_CAPABILITY_ROWS: readonly RequirementRow[] = [
  row('H0.ORACLE', 'harness-capability', '判定器套件：无损 JSON/结构/CAS/状态机/计数/因果/版本/权限/canary', source('doc-02', '## 1. 判定约定与必须交付的测试资产', '判定器与工具验真集合'), {
    codePaths: ['tests/harness/invariant.ts', 'tests/harness/json.ts', 'tests/harness/schema.ts', 'tests/harness/cas.ts', 'tests/harness/state-machine.ts', 'tests/harness/counts.ts', 'tests/harness/causal.ts', 'tests/harness/version-domains.ts', 'tests/harness/authority.ts'],
    testIds: ['oracle-manifest:contract', 'oracle-selfproof:aggregate', 'selfproof:framework-rejects-accepting-oracle'],
    oracles: ['lossless-json', 'json-text', 'schema', 'cas', 'state-machine', 'counts', 'causal', 'version', 'authority', 'canary'],
    verification: {
      requiredArtifacts: ['selfproof'],
      oracleRefs: ['lossless-json', 'json-text', 'schema', 'cas', 'state-machine', 'counts', 'causal', 'version', 'authority', 'canary'],
      requiredTests: ['oracle-manifest:contract', 'oracle-selfproof:aggregate', 'selfproof:framework-rejects-accepting-oracle'],
    },
    note: '每个判定器必须同时有 known-accept 与 known-reject 样本；会误纳错误样本的 oracle 使自证失败。',
  }),
  row('H0.SELFCHECK', 'harness-capability', '工具验真执行器：真实运行全部 known-pass/known-fail 并冻结 TAP', source('doc-02', '### 3.2 必须先过的工具验真样本', '工具自身失败条件'), {
    codePaths: ['tests/harness/selfproof.ts', 'tests/harness-oracles.test.ts'],
    testIds: ['oracle-selfproof:aggregate', 'selfproof:tap-parser', 'selfproof:artifact-honesty-validation', 'selfproof:artifact-staleness-detection', 'selfproof:framework-rejects-accepting-oracle'],
    verification: {
      requiredArtifacts: ['selfproof'],
      requiredTests: ['oracle-selfproof:aggregate', 'selfproof:tap-parser', 'selfproof:artifact-honesty-validation', 'selfproof:artifact-staleness-detection', 'selfproof:framework-rejects-accepting-oracle'],
    },
    note: 'artifact 记录逐测试名、逐文件 hash、逐 oracle 通过状态；失败自证仍写入 artifact（passed=false），不得隐藏。',
  }),
  row('H0.FAULTS', 'harness-capability', '驱动/时钟/故障控制：绝对期限、假业务时钟、确定性断点', source('doc-02', '## 1. 判定约定与必须交付的测试资产', '驱动、时钟与故障控制'), {
    codePaths: ['tests/harness/faults.ts'],
    testIds: ['faults:deadline-real-timer', 'faults:deadline-manual-and-combined-signals', 'faults:fault-injector-deterministic-plan', 'faults:fault-injector-abort-and-guards', 'faults:business-clock-utc-recurrence', 'faults:business-clock-deterministic-timer-queue'],
    oracles: ['deadline', 'business-clock', 'fault-injection'],
    verification: {
      requiredArtifacts: ['selfproof'],
      oracleRefs: ['deadline', 'business-clock', 'fault-injection'],
      requiredTests: ['faults:deadline-real-timer', 'faults:deadline-manual-and-combined-signals', 'faults:fault-injector-deterministic-plan', 'faults:fault-injector-abort-and-guards', 'faults:business-clock-utc-recurrence', 'faults:business-clock-deterministic-timer-queue'],
    },
    note: '故障命中位置由命名断点+序号证明；不用 sleep 猜竞态。',
  }),
  row('H0.OBSERVER', 'harness-capability', '独立观察器与效果账本：崩溃后可取证的 append-only JSONL', source('doc-02', '## 1. 判定约定与必须交付的测试资产', '独立观察器与效果账本'), {
    codePaths: ['tests/harness/observer.ts', 'tests/harness/fixtures/crash-child.ts'],
    testIds: ['observer:ledger-append-read-roundtrip', 'observer:ledger-real-sqlite-child-crash-survives', 'observer:effect-ledger-lost-receipt', 'observer:observer-independence-and-alignment'],
    oracles: ['observer-ledger', 'observer-counter'],
    verification: {
      requiredArtifacts: ['selfproof'],
      oracleRefs: ['observer-ledger', 'observer-counter'],
      requiredTests: ['observer:ledger-append-read-roundtrip', 'observer:ledger-real-sqlite-child-crash-survives', 'observer:effect-ledger-lost-receipt', 'observer:observer-independence-and-alignment'],
    },
    note: '子进程真实崩溃后父进程核对 SQLite 行与 JSONL 效果账本；执行一次丢回执仍只计 1 次效果。',
  }),
  row('H0.MANIFEST', 'harness-capability', 'manifest/证据包：源码/构建/环境/fixture/oracle 摘要与脱敏', source('doc-02', '### 4.2 执行前 manifest', '必须冻结'), {
    codePaths: ['tests/harness/manifest.ts', 'scripts/harness/manifest.mjs'],
    testIds: ['manifest:builds-hashed-sanitized-evidence', 'manifest:sanitizer-rejects-leaks', 'manifest:cli-temp-root-and-atomic-write', 'manifest:verify-detects-drift'],
    verification: {
      requiredArtifacts: ['manifest', 'selfproof'],
      requiredTests: ['manifest:builds-hashed-sanitized-evidence', 'manifest:sanitizer-rejects-leaks', 'manifest:cli-temp-root-and-atomic-write', 'manifest:verify-detects-drift'],
    },
    note: 'manifest 不含绝对路径/凭据；含源码、构建、环境、fixture、oracle 与 VCS 摘要。',
  }),
  row('H0.TRACEABILITY', 'harness-capability', '覆盖追踪：需求→代码→测试ID→oracle→证据→状态/未覆盖', source('doc-02', '## 1. 判定约定与必须交付的测试资产', '用例与覆盖清单'), {
    codePaths: ['tests/harness/traceability.ts', 'tests/harness/traceability-registry.ts', 'scripts/harness/traceability.mjs'],
    testIds: ['traceability:registry-complete-and-sourced', 'traceability:statuses-are-evidence-derived', 'traceability:cli-generates-json-and-markdown', 'traceability:rejects-unsupported-pass-claims'],
    verification: {
      requiredArtifacts: ['manifest', 'selfproof'],
      requiredTests: ['traceability:registry-complete-and-sourced', 'traceability:statuses-are-evidence-derived', 'traceability:cli-generates-json-and-markdown', 'traceability:rejects-unsupported-pass-claims'],
    },
    note: '产品行状态固定为 not_covered；只有 harness 能力行可凭 artifact 变 self_proven。',
  }),
  row('H0.DOCS', 'harness-capability', '使用说明：运行、接入后续切片、证据复核方法', source('doc-02', '## 1. 判定约定与必须交付的测试资产', 'DSH 必须交付以下实际可运行资产及使用说明'), {
    codePaths: ['tests/harness/README.md', 'scripts/harness/README.md'],
    testIds: ['docs:readme-contract'],
    verification: {
      requiredArtifacts: ['manifest', 'selfproof'],
      requiredPaths: ['tests/harness/README.md', 'scripts/harness/README.md'],
      requiredTests: ['docs:readme-contract'],
    },
  }),
];

/* ------------------------------------------------------------------ */
/* Product-facing requirements (registered, never claimed as covered). */
/* ------------------------------------------------------------------ */

export const NINE_SYSTEM_ROWS: readonly RequirementRow[] = [
  row('SYS.1', 'nine-system', '接入、对话与话题协作', source('doc-01', '## 2. 系统 1', '接入、对话与话题协作'), {
    systems: ['1'], refs: { v: ['V02', 'V03', 'V04', 'V05', 'V13', 'V23', 'V24', 'V25'], s: ['S02', 'S04'], fl: ['FL01', 'FL02', 'FL03', 'FL04', 'FL05'] },
    thresholds: ['稳定原生 Session 复用', '旧代次草稿失效', '跨范围暴露 0', '实际送达与生成分开'],
  }),
  row('SYS.2', 'nine-system', 'Agent 与组件共用事件系统', source('doc-01', '## 3. 系统 2', 'Agent 与组件共用事件系统'), {
    systems: ['2'], refs: { v: ['V03', 'V04', 'V10', 'V12', 'V14', 'V21', 'V23', 'V24'], s: ['S03', 'S08'], fl: ['FL07', 'FL08'] },
    thresholds: ['四条发布订阅路径', '一次性等待/期限/取消', '背景更新零模型', 'ack 与 context-loaded 分开'],
  }),
  row('SYS.3', 'nine-system', 'core 判断与持续规划', source('doc-01', '## 4. 系统 3', 'core 判断与持续规划'), {
    systems: ['3'], refs: { v: ['V02', 'V06', 'V09', 'V10', 'V13', 'V23', 'V24', 'V25'], s: ['S03', 'S04', 'S08'], fl: ['FL01', 'FL04', 'FL08'] },
    thresholds: ['结构化计划/修订', '模型不扩 Mandate', '安静期不空转', '独立完成证明后才提交 Goal 完成'],
  }),
  row('SYS.4', 'nine-system', '目标、任务、worker 与外部效果', source('doc-01', '## 5. 系统 4', '目标、任务、worker 与外部效果'), {
    systems: ['4'], refs: { v: ['V10', 'V11', 'V12', 'V18', 'V19', 'V20', 'V21', 'V22', 'V23', 'V24', 'V26'], s: ['S04', 'S05'], fl: ['FL07'] },
    thresholds: ['Assignment 独立栅栏', '旧 worker 迟到不覆盖', '非幂等 unknown 不自动重放', 'Task/记忆/通知分别记录'],
  }),
  row('SYS.5', 'nine-system', '六部分内层与只读视图', source('doc-01', '## 6. 系统 5', '六部分内层与只读视图'), {
    systems: ['5'], refs: { v: ['V06', 'V07', 'V08', 'V09', 'V16', 'V23', 'V24', 'V25'], s: ['S01', 'S02', 'S06', 'S07'], fl: ['FL02', 'FL05'] },
    thresholds: ['六域各有权威/来源/版本/撤回', 'unavailable 不伪装空数据', '普通消息不改人格/权限'],
  }),
  row('SYS.6', 'nine-system', '模型、Session、上下文与缓存', source('doc-01', '## 7. 系统 6', '模型、Session、上下文与缓存'), {
    systems: ['6'], refs: { v: ['V04', 'V13', 'V14', 'V24', 'V25'], s: ['S04', 'S05', 'S08'], fl: ['FL03', 'FL06', 'FL07'] },
    thresholds: ['长历史冷恢复', '正常复用一个 Session', '压缩/并路计量', '缓存字段缺失即未知'],
  }),
  row('SYS.7', 'nine-system', '身份、授权、预算与控制', source('doc-01', '## 8. 系统 7', '身份、授权、预算与控制'), {
    systems: ['7'], refs: { v: ['V02', 'V04', 'V10', 'V13', 'V16', 'V17', 'V18', 'V19', 'V20', 'V24', 'V26'], s: ['S02', 'S05', 'S08'], fl: ['FL05', 'FL06'] },
    thresholds: ['执行点复查', '暂停持久有效', 'unknown 不释放/不冒成功', 'canary 明文 0'],
  }),
  row('SYS.8', 'nine-system', '数据、生命周期、恢复与备份', source('doc-01', '## 9. 系统 8', '数据、生命周期、恢复与备份'), {
    systems: ['8'], refs: { v: ['V01', 'V06', 'V12', 'V14', 'V15', 'V16', 'V17', 'V19', 'V21', 'V22', 'V23', 'V24', 'V27'], s: ['S05', 'S06', 'S08'], fl: ['FL07', 'FL08'] },
    thresholds: ['单 writer/唯一数据根', '跨组件恢复先 maintenance', '旧删除/授权屏障', '独立故障域才叫备份'],
  }),
  row('SYS.9', 'nine-system', '运行仪表盘', source('doc-01', '## 10. 系统 9', '运行仪表盘'), {
    systems: ['9'], refs: { v: ['V04', 'V05', 'V09', 'V13', 'V14', 'V23', 'V24'] },
    thresholds: ['1000 次刷新无业务副作用', 'unknown/stale/unavailable 如实显示', 'GET 不生成/不派工/不重连', '秘密不持久化'],
  }),
];

export const SYSTEM_MATRIX_ROWS: readonly RequirementRow[] = [
  row('MATRIX.1', 'system-matrix', '系统1 验收矩阵：身份/会话/草稿失效/渠道事件', source('doc-02', '## 5. 九大系统验收矩阵', '1 接入与对话'), {
    systems: ['1'], refs: { v: ['V02', 'V03', 'V04', 'V05', 'V13', 'V23', 'V24', 'V25'] },
    thresholds: ['正例/拒绝例/并发过时例/故障恢复例', '独立证据（渠道原始事件/实际模型输入/原生 Session 身份）'],
  }),
  row('MATRIX.2', 'system-matrix', '系统2 验收矩阵：重复/乱序/一次性等待/背景零模型', source('doc-02', '## 5. 九大系统验收矩阵', '2 事件与订阅'), {
    systems: ['2'], refs: { v: ['V03', 'V04', 'V10', 'V12', 'V14', 'V21', 'V23', 'V24'] },
    thresholds: ['接纳/处理/提交/上下文加载分别有证据', '背景通知本身零模型'],
  }),
  row('MATRIX.3', 'system-matrix', '系统3 验收矩阵：事实变化/无变化/预算耗尽', source('doc-02', '## 5. 九大系统验收矩阵', '3 core 判断与规划'), {
    systems: ['3'], refs: { v: ['V02', 'V06', 'V09', 'V10', 'V13', 'V23', 'V24', 'V25'] },
    thresholds: ['无变化不空转', '模型不能改权威状态/扩权/自报完成'],
  }),
  row('MATRIX.4', 'system-matrix', '系统4 验收矩阵：租约/取消/迟到/写后丢回执', source('doc-02', '## 5. 九大系统验收矩阵', '4 目标、任务与执行'), {
    systems: ['4'], refs: { v: ['V10', 'V11', 'V12', 'V18', 'V19', 'V20', 'V21', 'V22', 'V23', 'V24', 'V26'] },
    thresholds: ['有效实例执行后独立核验完成', 'unknown 不自动重派或释放预算'],
  }),
  row('MATRIX.5', 'system-matrix', '系统5 验收矩阵：六域正反例与删除复活 0', source('doc-02', '## 5. 九大系统验收矩阵', '5 六部分内层'), {
    systems: ['5'], refs: { v: ['V06', 'V07', 'V08', 'V09', 'V16', 'V23', 'V24', 'V25'] },
    thresholds: ['六部分分别覆盖', '不可用明确展示', '无来源伪事实/人格改写/情绪扩权/删除复活为 0'],
  }),
  row('MATRIX.6', 'system-matrix', '系统6 验收矩阵：历史/分页/压缩/注入/usage 缺失', source('doc-02', '## 5. 九大系统验收矩阵', '6 模型与 Session'), {
    systems: ['6'], refs: { v: ['V04', 'V13', 'V14', 'V24', 'V25'] },
    thresholds: ['历史无静默截断', '全部已观测调用记账', '缺失为未知'],
  }),
  row('MATRIX.7', 'system-matrix', '系统7 验收矩阵：接纳/排队/生成/派发前撤权', source('doc-02', '## 5. 九大系统验收矩阵', '7 权限与控制'), {
    systems: ['7'], refs: { v: ['V02', 'V04', 'V10', 'V13', 'V16', 'V17', 'V18', 'V19', 'V20', 'V24', 'V26'] },
    thresholds: ['每次新动作复查', '暂停跨重启', 'unknown 不被恢复掩盖'],
  }),
  row('MATRIX.8', 'system-matrix', '系统8 验收矩阵：CAS/写偏斜/单writer/满盘/迁移/恢复', source('doc-02', '## 5. 九大系统验收矩阵', '8 数据与运行保障'), {
    systems: ['8'], refs: { v: ['V01', 'V06', 'V12', 'V14', 'V15', 'V16', 'V17', 'V19', 'V21', 'V22', 'V23', 'V24', 'V27'] },
    thresholds: ['无半提交/双活动根/删除复活/暂停自动运行', '独立 desired_state'],
  }),
  row('MATRIX.9', 'system-matrix', '系统9 验收矩阵：仪表盘真实状态/只读/秘密', source('doc-02', '## 5. 九大系统验收矩阵', '9 运行仪表盘'), {
    systems: ['9'], refs: { v: ['V04', 'V05', 'V09', 'V13', 'V14', 'V23', 'V24'] },
    thresholds: ['API trace 与读前后账本', 'GET 不生成/派发/重连', '秘密不持久化'],
  }),
];

/** V01–V27 thresholds condensed from 九系统计划 §5; original wording in A方案验证与验收. */
const V_ITEMS: readonly (readonly [string, string, readonly string[], readonly string[]])[] = [
  ['V01', '契约覆盖、版本和事务能力门槛', ['8'], ['40/40 模块', '实际 SQLite 构建能力', '关键契约冲突已处理']],
  ['V02', '输入、主体、目标与可信控制来源', ['1', '3', '7'], ['40 身份/控制组合', '同名误合并=0', '正文伪造授权=0', '原生 Goal 与本地绑定分别核对']],
  ['V03', '事件重放、乱序和接收回执', ['2', '1'], ['100 唯一事件×10 重送', '20 乱序种子', '同键异内容拒绝', '接纳/处理/提交分开']],
  ['V04', '外层只读、注册准入与执行授权', ['7', '1', '6', '9'], ['≥30 越权路径零成功', '1000 次读取纯度', '工具创建/恢复/执行检查']],
  ['V05', '对话队列、过时回复与发送状态', ['1', '9'], ['20 会话/1000 消息/20 种子', '接纳 p95≤500ms', '停止失效 p95≤1s', '旧回复发送=0']],
  ['V06', 'core 提案、readSet/CAS 与领域原子提交', ['3', '5', '8'], ['100 提案竞争恰 1 成功', '100 独立聚合可分别提交', '适用断点×20']],
  ['V07', '记忆、关系与认知的证据语义', ['5'], ['40 oracle 全匹配', '10,000 记录 / ≥200 查询', '本地 p95≤200ms', '真实后端与检索语义另报']],
  ['V08', '情绪记忆、自我认识与人格稳定性', ['5'], ['100 轮无合法变更不漂移', '1000 读取不写', '来源/回顾/删除可归因']],
  ['V09', '能力声明、实际可用与技能变更', ['5', '7', '9'], ['≥24 能力组合', '声明/健康/验证分开', '过期/撤销/错环境阻止新效果']],
  ['V10', 'Mandate、预算、暂停和撤权', ['7', '3', '4'], ['≥32 授权/预算/暂停组合', '无越界动作', '派发前复查', '暂停跨重启']],
  ['V11', '任务、Assignment、租约与迟到结果', ['4'], ['50 worker 竞争最多一个有效资格', '各竞态×20 零旧结果覆盖', 'unknown 不降为可重派']],
  ['V12', '事务 outbox、跨服务未知结果与回执', ['4', '2', '8'], ['适用断点×20', '幂等每 effect 至多一次', '非幂等 unknown 自动重放=0']],
  ['V13', '模型/工具数据注入、路由与外发控制', ['6', '7'], ['≥80 边界输入零未允许动作', 'fallback 不扩权', '用量缺失不记零']],
  ['V14', 'DSH 接口替身、事件定时与生命周期', ['2', '6', '8', '9'], ['20 次装载/卸载', '一份订阅/定时器', 'drain≤4s']],
  ['V15', '数据空间、磁盘满、写锁与迁移', ['8'], ['12 适用断点×20', '单 writer/唯一有效根', '锁等待不阻塞停止']],
  ['V16', '保留、删除、派生传播与恢复防复活', ['5', '7', '8'], ['20 主体/事实', '7/30/90/180 天边界', '最新删除水位无法证明则恢复锁']],
  ['V17', '凭据引用、轮换与诊断脱敏', ['7', '8'], ['20 异常分支', '明文 canary=0', '不可解析凭据=不可用']],
  ['V18', '设备配对、能力版本与资源身份', ['4', '7'], ['100 同路径访问', '≥30 授权组合', 'direct/gated 分别证明']],
  ['V19', '掉线、取消、撤权与重新接入', ['4', '7', '8'], ['适用断点×20', '5 类异常各 100', 'unknown 不自动重放/改派']],
  ['V20', '平台能力差异与机器人本地停止', ['4', '7'], ['网页 20 场景/机器人协议 10 类', '重复 effect 100 次最多一个活动 goal']],
  ['V21', '暂停、进程退出与宿主外恢复', ['8', '2', '4'], ['paused/stopped 自动拉起=0', '≥20 次恢复 ready≤120s', '恢复先核对']],
  ['V22', '一致检查点、备份与合成恢复', ['8', '4', '5'], ['20 故障场景组件可核验', '1GiB/1000 Task/100 unknown', 'RTO≤30min', 'unknown 保持']],
  ['V23', '合成端到端与最终观察一致性', ['1', '2', '3', '4', '5', '6', '7', '8', '9'], ['E1/E2/E3 各 20 种子', '40 模块主断言有证据', '全因果链可追']],
  ['V24', '固定 DSH、实际 SQLite 与 profile 适配', ['1', '2', '3', '4', '5', '6', '7', '8', '9'], ['实际版本/API/持久事实', '20 生命周期', 'drain≤4s', '零读副作用']],
  ['V25', '真实模型的有界语义评测', ['1', '3', '5', '6'], ['≥300 段对话/120 保存候选/200 检索问句/≥80 注入', '3 轮或如实报告截断', '保存 P≥.95/R≥.80，Recall@10≥.85，误报≤.05']],
  ['V26', '获准真实设备的能力切片', ['4', '7'], ['明确设备/动作/测试根', '20 同任务请求', '多设备结论需≥2 实际设备']],
  ['V27', '独立故障域备份与恢复演练', ['8'], ['实际目的地/故障域可证明', '1GiB 基准 capture age≤15min', 'RTO≤30min', '3 次独立恢复']],
];

export const V_ITEM_ROWS: readonly RequirementRow[] = V_ITEMS.map(([id, title, systems, thresholds]) =>
  row(id, 'v-item', title, source('doc-v', `### ${id}`, title), {
    systems,
    thresholds,
    note: '完整门槛与步骤以 A方案全景/验证与验收.md 原文为准；计划 §5 明确当前没有完整 V 项通过记录。',
  }),
);

const S_SCENARIOS: readonly (readonly [string, string, readonly string[]])[] = [
  ['S01', '记忆与纠正', ['V03', 'V04', 'V07', 'V08', 'V25']],
  ['S02', '身份与群隐私', ['V02', 'V04', 'V05', 'V07', 'V16']],
  ['S03', '订阅与主动任务', ['V02', 'V03', 'V10', 'V12', 'V14', 'V23']],
  ['S04', '聊天与任务', ['V04', 'V05', 'V10', 'V11', 'V23']],
  ['S05', '未知效果与恢复', ['V10', 'V11', 'V12', 'V21', 'V23']],
  ['S06', '删除与旧备份', ['V07', 'V16', 'V21', 'V22', 'V23']],
  ['S07', '情绪与人格', ['V04', 'V07', 'V08', 'V25']],
  ['S08', '时间与预算', ['V03', 'V10', 'V13', 'V14', 'V21']],
];

export const BUSINESS_SCENARIO_ROWS: readonly RequirementRow[] = S_SCENARIOS.map(([id, title, vRefs]) =>
  row(id, 'business-scenario', title, source('doc-02', '## 8. S / FL 业务集合保留与补全', `${id} ${title}`), {
    refs: { v: vRefs },
    note: '公开 DEV 样本；HOLDOUT 未建立。历史有限样本不能整体通过该场景。',
  }),
);

const FL_SCENARIOS: readonly (readonly [string, string, readonly string[]])[] = [
  ['FL01', '业务藏在闲聊中', ['V05', 'V07', 'V25']],
  ['FL02', '语境改变答案', ['V07', 'V25']],
  ['FL03', '刷屏与纠正', ['V03', 'V05', 'V10']],
  ['FL04', '单源洪峰', ['V05', 'V10', 'V23']],
  ['FL05', '多人跨供应商', ['V02', 'V04', 'V10', 'V13']],
  ['FL06', '不确定与附件', ['V09', 'V13', 'V25']],
  ['FL07', '重放与恢复', ['V03', 'V12', 'V21']],
  ['FL08', '订阅与长期业务', ['V10', 'V14', 'V23']],
];

export const FL_SCENARIO_ROWS: readonly RequirementRow[] = FL_SCENARIOS.map(([id, title, vRefs]) =>
  row(id, 'fl-scenario', title, source('doc-02', '## 8. S / FL 业务集合保留与补全', `${id} ${title}`), {
    refs: { v: vRefs },
    note: 'FL02/06/07/08 仍为缺失轨迹/答案/变体，需要物化而非只运行现有文件。',
  }),
);

const SCORING_DIMENSIONS: readonly (readonly [string, string])[] = [
  ['H1', '授权'],
  ['H2', '身份/受众'],
  ['H3', '效果与 unknown'],
  ['H4', '停止/旧资格'],
  ['H5', '删除'],
  ['H6', '时间/订阅/预算'],
  ['H7', '证据语义'],
  ['H8', '人格与读取纯度'],
];

export const SCORING_ROWS: readonly RequirementRow[] = SCORING_DIMENSIONS.map(([id, title]) =>
  row(`H.${id}`, 'scoring-dimension', `${id} 判分维度：${title}`, source('doc-02', '## 8. S / FL 业务集合保留与补全', 'H1–H8 沿'), {
    note: '功能里程碑与相处质量分别计分，H1–H8 维度不压成一个总分。',
  }),
);

const COMBO_SCENARIOS: readonly (readonly [string, string, string])[] = [
  ['6.1', '多频道持续输入与公平', 'CHAN'],
  ['6.2', '事件、订阅与零模型背景加载', 'EVENT'],
  ['6.3', 'core、worker 与完成核验', 'CORE'],
  ['6.4', 'unknown、取消、暂停与回执查询', 'UNKNOWN'],
  ['6.5', '撤回、删除、身份拆分与上下文失效', 'DELETE'],
  ['6.6', '原生长历史、冷恢复与压缩', 'HISTORY'],
  ['6.7', '缓存、模型用量与预算 oracle', 'USAGE'],
  ['6.8', '内层六域、能力与仪表盘', 'INNER'],
  ['6.9', '检查点、迁移、长期运行与恢复', 'LONGRUN'],
  ['6.10', '三条端到端链不得省略', 'E2E'],
];

export const COMBO_SCENARIO_ROWS: readonly RequirementRow[] = COMBO_SCENARIOS.map(([section, title, suffix]) =>
  row(`COMBO.${suffix}`, 'combo-scenario', `02 §${section} ${title}`, source('doc-02', `### ${section}`, title), {
    thresholds: ['准备→显式屏障/触发→观察→持久回读→断言', '失败时先停止新效果并保留独立事实'],
  }),
);

const TOOL_VERIFICATION_SPECS: readonly (readonly [string, string, string, readonly string[], readonly string[]])[] = [
  ['TV.1', '重复事件/同键异内容/跨来源同外部 ID 的独立计数与冲突拒绝', '事件重复 10 次', ['counts', 'causal', 'cas'], ['不能只按输入行数或产品 processed 计数']],
  ['TV.2', '接收端执行一次后丢回执，产品保持 unknown', '执行一次后丢回执', ['causal', 'observer-ledger', 'observer-counter'], ['不能把无响应判为未执行']],
  ['TV.3', '第二次实际发送/旧 fence 覆盖/跨受众 canary 必须触发失败', '旧 fence 结果覆盖', ['causal', 'version', 'canary', 'authority'], ['任一已知错误被判通过即失败']],
  ['TV.4', '缺失/截断 trace、重复序号、非法 schema、错 runId、无法关联 receipt', '缺失/截断 trace', ['observer-ledger', 'json-text', 'schema', 'causal'], ['不得默默跳过坏记录']],
  ['TV.5', '假模型 3 次调用中 1 次用量缺失、1 次压缩、1 次重试', '假模型计数 3 次', ['counts'], ['不能只统计最终回答、缺失填 0']],
  ['TV.6', '驱动计划 100 条仅注入 90 条其中 10 条延迟', '驱动计划 100 条', ['counts'], ['不能以 90/90 宣称完成 100 条']],
  ['TV.7', '已删除 canary 混入摘要/历史/导出，未删除同类词负对照', '已删除 canary', ['canary'], ['只搜最终回复或扫描器静默未运行均失败']],
  ['TV.8', '正确/明确错误/允许澄清或等待的歧义结果判定', '允许澄清/等待的歧义结果', [], ['Judge 任意文字不得当成功；policy_pending 保留']],
  ['TV.9', '观察器/判定器自身中断，产品继续产生效果', '观察器/判定器自身中断', ['observer-ledger', 'causal', 'counts'], ['监控死亡期间继续累加成功即失败']],
];

export const TOOL_VERIFICATION_ROWS: readonly RequirementRow[] = TOOL_VERIFICATION_SPECS.map(([id, title, contains, oracleRefs, threshold]) =>
  row(id, 'tool-verification', title, source('doc-02', '### 3.2 必须先过的工具验真样本', contains), {
    oracles: oracleRefs,
    thresholds: threshold,
    note: 'oracleRefs 指向 H0 已自证的判定器能力；这不表示产品场景已运行。',
    ...(oracleRefs.length === 0
      ? {}
      : {
          verification: {
            allowPartial: true,
            oracleRefs,
            missingNote: 'H0 提供相关 oracle 自证；对应产品场景未运行，状态不得升级为通过。',
          },
        }),
  }),
);

const ASSET_SOURCE_CONTAINS: Readonly<Record<string, string>> = {
  'ASSET.1': '用例与覆盖清单',
  'ASSET.2': '合成 fixture 与独立答案集',
  'ASSET.3': '驱动、时钟与故障控制',
  'ASSET.4': '独立观察器与效果账本',
  'ASSET.5': '判定器与工具验真集合',
  'ASSET.6': '固定宿主适配与恢复驱动',
  'ASSET.7': '报告与证据包',
  'ASSET.8': '资产及使用说明',
};

const HARNESS_ASSETS: readonly (readonly [string, string, readonly string[], readonly ('manifest' | 'selfproof' | 'traceability')[]])[] = [
  ['ASSET.1', '用例与覆盖清单', ['traceability:registry-complete-and-sourced', 'traceability:statuses-are-evidence-derived', 'traceability:cli-generates-json-and-markdown'], ['selfproof']],
  ['ASSET.2', '合成 fixture 与独立答案集', [], []],
  ['ASSET.3', '驱动、时钟与故障控制', ['faults:deadline-real-timer', 'faults:fault-injector-deterministic-plan', 'faults:business-clock-deterministic-timer-queue'], ['selfproof']],
  ['ASSET.4', '独立观察器与效果账本', ['observer:ledger-real-sqlite-child-crash-survives', 'observer:effect-ledger-lost-receipt', 'observer:observer-independence-and-alignment'], ['selfproof']],
  ['ASSET.5', '判定器与工具验真集合', ['oracle-selfproof:aggregate', 'selfproof:framework-rejects-accepting-oracle'], ['selfproof']],
  ['ASSET.6', '固定宿主适配与恢复驱动', [], []],
  ['ASSET.7', '报告与证据包', ['manifest:builds-hashed-sanitized-evidence', 'manifest:verify-detects-drift'], ['manifest', 'selfproof']],
  ['ASSET.8', '使用说明与复核方法', ['docs:readme-contract'], ['manifest']] as const,
];

export const HARNESS_ASSET_ROWS: readonly RequirementRow[] = HARNESS_ASSETS.map(([id, title, tests, artifacts]) =>
  row(id, 'harness-asset', title, source('doc-02', '## 1. 判定约定与必须交付的测试资产', ASSET_SOURCE_CONTAINS[id] ?? '使用说明'), {
    testIds: tests,
    verification:
      tests.length === 0 && artifacts.length === 0
        ? { allowPartial: true, missingNote: 'H0 未交付该资产；属后续切片（H1+）范围。' }
        : { allowPartial: true, requiredTests: tests, requiredArtifacts: artifacts, missingNote: '仅交付 H0 范围子能力；完整资产业务场景尚未运行。' },
  }),
);

export const ALL_REQUIREMENT_ROWS: readonly RequirementRow[] = [
  ...HARNESS_CAPABILITY_ROWS,
  ...HARNESS_ASSET_ROWS,
  ...TOOL_VERIFICATION_ROWS,
  ...NINE_SYSTEM_ROWS,
  ...SYSTEM_MATRIX_ROWS,
  ...V_ITEM_ROWS,
  ...BUSINESS_SCENARIO_ROWS,
  ...FL_SCENARIO_ROWS,
  ...SCORING_ROWS,
  ...COMBO_SCENARIO_ROWS,
];

/** Products of these kinds must never be reported as covered by H0. */
export const PRODUCT_KINDS: readonly RequirementKind[] = [
  'nine-system',
  'v-item',
  'business-scenario',
  'fl-scenario',
  'scoring-dimension',
  'combo-scenario',
  'system-matrix',
];

/**
 * Historical limited evidence referenced by the implementation record. These
 * are surfaced separately as "historical evidence, not counted" so reviewers
 * can follow them without any status being upgraded.
 */
export const HISTORICAL_EVIDENCE: readonly { readonly path: string; readonly scope: string; readonly refs: readonly string[] }[] = [
  { path: 'plugins/shiyu/artifacts/phase3i-capability-offline.json', scope: '3I 离线基线 1021 项模块/204 UI（历史）', refs: ['V04', 'V09'] },
  { path: 'plugins/shiyu/artifacts/phase3i-capability-host-zero-model.json', scope: '3I 固定宿主零模型重载（历史，限定）', refs: ['V14', 'V24'] },
  { path: 'plugins/shiyu/artifacts/phase3h-c-lab-host-validation.json', scope: '3H-C 双频道限定文本闭环（历史，限定）', refs: ['V05', 'V23', 'V24'] },
  { path: 'plugins/shiyu/artifacts/phase3g-core-host-success.json', scope: '3G-B owner local-note 限定闭环（历史，限定）', refs: ['V10', 'V23'] },
  { path: 'plugins/shiyu/artifacts/task-validation.json', scope: '受限本地任务与预算结算（历史，限定）', refs: ['V10', 'V12'] },
  { path: 'plugins/shiyu/artifacts/goal-validation.json', scope: '原生 Goal 零推理生命周期（历史，限定）', refs: ['V14'] },
  { path: 'plugins/shiyu/artifacts/context-validation.json', scope: '受限上下文与同 Session 回复（历史，限定）', refs: ['V24', 'V25'] },
  { path: 'plugins/shiyu/实施记录.md', scope: '本体实施记录与失败保留（历史）', refs: [] },
];
