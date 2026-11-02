/**
 * H0c coverage index builder.
 *
 * Maps the existing public S/FL sources (design docs, case documents, matrix
 * requirements) to the generated fixture/answer assets, verifies the source
 * step counts against the real Markdown, and states honestly what is missing:
 * un-materialised design steps, variants/noise trajectories, load plans,
 * HOLDOUT, annotators and any product run evidence.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import type { CheckResult, JsonValue, Violation } from '../invariant.js';
import { finish, violation } from '../invariant.js';
import { ALL_SCENARIOS } from './catalog.js';
import { checkSplitPolicy, defaultSplitPolicy, SPLIT_RULES, type SplitEntry } from './splits.js';
import type { ScenarioId, Split, StepAnswers } from './types.js';

export const COVERAGE_VERSION = '1.0.0';

const DOC_S = '测试/2026-11-01-测试集设计/';
const DOC_FL = '测试/2026-11-01-信息流Lab/';
const DOC_CONTRACT = `${DOC_FL}覆盖与拟验契约.md`;
const DOC_GRADE = `${DOC_S}判分与数据拆分.md`;
const DOC_WORLD = `${DOC_FL}合成公司与标注约定.md`;
const DOC_LAB_PLAN = `${DOC_FL}实验计划.md`;

export interface SourceVerification {
  readonly scenarioId: ScenarioId;
  readonly sourcePath: string;
  readonly kind: string;
  readonly exists: boolean;
  readonly expectedStepCount: number;
  readonly observedStepCount: number;
  readonly observedStepIds: readonly string[];
  readonly matrixMentionsScenario: boolean | null;
  readonly issues: readonly string[];
}

export interface CoverageStepRow {
  readonly stepId: string;
  readonly publicEvent: true;
  readonly fourClassAnswers: true;
  readonly oracleChecks: number;
  readonly frozenCounts: number;
  readonly milestones: number;
  readonly hDimensions: number;
  readonly materialized: true;
}

export interface CoverageScenarioRow {
  readonly scenarioId: ScenarioId;
  readonly familyId: string;
  readonly title: string;
  readonly split: Split;
  readonly source: { readonly path: string; readonly kind: string; readonly existingStepCount: number };
  readonly relatedV: readonly string[];
  readonly hDimensions: readonly string[];
  readonly milestones: number;
  readonly materializedSteps: number;
  readonly designSteps: number;
  readonly uncoveredDesignStepIds: readonly string[];
  readonly steps: readonly CoverageStepRow[];
  readonly variants: readonly { readonly id: string; readonly expectation: string; readonly materialised: boolean }[];
  readonly qualitySteps: readonly string[];
  readonly pairingIds: readonly string[];
  readonly verificationStatus: 'synthetic-fixture-only-not-run';
  readonly runEvidence: 0;
  readonly holdout: 'not_materialised';
  readonly historicalSampleUpgraded: false;
  readonly cannotUseForBusinessAcceptance: true;
  readonly gaps: readonly string[];
}

export interface MissingAsset {
  readonly id: string;
  readonly description: string;
  readonly blocksBusinessAcceptance: boolean;
  readonly owner: string;
}

export interface CoverageIndex {
  readonly schemaVersion: number;
  readonly kind: 'shiyu.harness.business.coverage';
  readonly generatedAt: string;
  readonly catalogVersion: string;
  readonly seed: number;
  readonly sources: readonly SourceVerification[];
  readonly summary: {
    readonly scenarios: number;
    readonly materializedSteps: number;
    readonly designSteps: number;
    readonly uncoveredDesignSteps: number;
    readonly fixtures: number;
    readonly answers: number;
    readonly splits: Readonly<Record<Split, number>>;
    readonly runEvidence: 0;
    readonly holdoutMaterialized: 0;
    readonly annotatorScores: 0;
    readonly realModelCalls: 0;
    readonly realEmbeddingCalls: 0;
    readonly labRooms: 0;
    readonly hostOperations: 0;
  };
  readonly rows: readonly CoverageScenarioRow[];
  readonly splitPolicy: { readonly rules: readonly string[]; readonly state: string; readonly result: 'pass' | 'fail' };
  readonly missingAssets: readonly MissingAsset[];
  readonly cannotUseForBusinessAcceptance: true;
  readonly disclaimer: string;
  readonly commands: readonly string[];
}

function stepIdsFromDocument(text: string, prefix: 'S' | 'FL'): string[] {
  const pattern = prefix === 'S' ? /\bS0[1-8]\.\d+\b/g : /\bFL0[1-8]\.\d+[A-Z]?\b/g;
  const found = text.match(pattern) ?? [];
  const ordered: string[] = [];
  for (const match of found) {
    const normalized = match.replace(/[A-Z]$/, '');
    if (!ordered.includes(normalized)) ordered.push(normalized);
  }
  return ordered;
}

export async function verifySourceDocuments(workspaceRoot: string): Promise<readonly SourceVerification[]> {
  const root = resolve(workspaceRoot);
  const cache = new Map<string, string>();
  const read = async (path: string): Promise<string | undefined> => {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    try {
      const text = await readFile(join(root, path), 'utf8');
      cache.set(path, text);
      return text;
    } catch {
      return undefined;
    }
  };
  const contract = await read(DOC_CONTRACT);
  const results: SourceVerification[] = [];
  for (const scenario of ALL_SCENARIOS) {
    const sourcePath = scenario.source.sourcePath;
    const text = await read(sourcePath);
    const issues: string[] = [];
    let observedStepCount = 0;
    let observedStepIds: string[] = [];
    let matrixMentionsScenario: boolean | null = null;
    if (text === undefined) {
      issues.push(`source document ${sourcePath} is missing`);
    } else if (scenario.source.kind === 'case-doc') {
      observedStepIds = stepIdsFromDocument(text, scenario.scenarioId.startsWith('FL') ? 'FL' : 'S');
      // Count only table rows that define a step, e.g. `| S01.1／...` or `| FL03.2／...`.
      const stepRowPattern = new RegExp(`^\\|\\s*${scenario.scenarioId}\\.\\d+`, 'gm');
      observedStepCount = (text.match(stepRowPattern) ?? []).length;
      if (observedStepCount !== scenario.source.existingStepCount) {
        issues.push(`step row count ${observedStepCount} != declared ${scenario.source.existingStepCount}`);
      }
    } else {
      observedStepCount = 0;
      matrixMentionsScenario = contract === undefined ? false : contract.includes(scenario.scenarioId);
      if (contract === undefined) issues.push(`matrix document ${DOC_CONTRACT} is missing`);
      else if (matrixMentionsScenario !== true) issues.push(`matrix document does not mention ${scenario.scenarioId}`);
    }
    results.push({
      scenarioId: scenario.scenarioId,
      sourcePath,
      kind: scenario.source.kind,
      exists: text !== undefined,
      expectedStepCount: scenario.source.existingStepCount,
      observedStepCount,
      observedStepIds,
      matrixMentionsScenario,
      issues,
    });
  }
  return results;
}

export async function verifyCompanionDocuments(workspaceRoot: string): Promise<readonly string[]> {
  const root = resolve(workspaceRoot);
  const issues: string[] = [];
  const checks: readonly { readonly path: string; readonly needed: readonly string[] }[] = [
    { path: DOC_GRADE, needed: ['硬约束：逐断言零违规', '开发、回归与保留集', '不压成一个总分'] },
    { path: DOC_WORLD, needed: ['四类预期必须独立标注', '自主判断与本组采用的设定', '评估输入与可见性'] },
    { path: DOC_CONTRACT, needed: ['覆盖映射', '差异 C-D1', 'FL02'] },
    { path: DOC_LAB_PLAN, needed: ['L1', 'L2', 'L3'] },
  ];
  for (const check of checks) {
    try {
      const text = await readFile(join(root, check.path), 'utf8');
      for (const needed of check.needed) {
        if (!text.includes(needed)) issues.push(`${check.path} does not contain required section/marker ${JSON.stringify(needed)}`);
      }
    } catch {
      issues.push(`companion document ${check.path} is missing`);
    }
  }
  return issues;
}

function stepRow(step: StepAnswers): CoverageStepRow {
  return {
    stepId: step.stepId,
    publicEvent: true,
    fourClassAnswers: true,
    oracleChecks: step.oracleChecks.length,
    frozenCounts: Object.keys(step.counts).length,
    milestones: step.milestones.length,
    hDimensions: step.hDimensions.length,
    materialized: true,
  };
}

function gapsForScenario(scenarioId: ScenarioId, uncovered: readonly string[]): string[] {
  const gaps: string[] = [];
  if (uncovered.length > 0) gaps.push(`历史设计步骤未物化：${uncovered.join(', ')}`);
  const row = ALL_SCENARIOS.find(scenario => scenario.scenarioId === scenarioId);
  if (row?.source.kind === 'matrix-only') gaps.push('历史无 case 文档/答案，仅有矩阵要求；本骨架为新写代表轨迹');
  gaps.push('无任何运行证据（模型/宿主/Lab/渠道=0）');
  gaps.push('变体未物化：改名/翻译/加噪/换种子/重排已声明但未生成');
  gaps.push('无双人盲评与相处质量分数（annotatorScores=0）');
  return gaps;
}

const MISSING_ASSETS: readonly MissingAsset[] = [
  { id: 'MISSING.FL02-06-07-08-cases', description: 'FL02/FL06/FL07/FL08 没有历史 case 文档与历史答案，只有矩阵要求；本骨架只新写 3 步代表轨迹', blocksBusinessAcceptance: true, owner: 'H0c+' },
  { id: 'MISSING.design-steps', description: 'S 54 步与 FL01/03/04/05 26 步中未物化的历史步骤（见各行 uncovered）', blocksBusinessAcceptance: true, owner: 'H0c+' },
  { id: 'MISSING.variants', description: '每个场景的答案不变/答案改变变体只冻结规格，未生成输入轨迹', blocksBusinessAcceptance: true, owner: 'H0c+' },
  { id: 'MISSING.noise-trajectories', description: 'FL01 的 0/16/76 条噪音轨迹、FL04 的 1,000 条负载计划未生成', blocksBusinessAcceptance: true, owner: 'H1+/Lab 切片' },
  { id: 'MISSING.holdout', description: 'HOLDOUT 保留集未制作：需独立作者、答案冻结后保管、真实权限/流程隔离；当前 0 条', blocksBusinessAcceptance: true, owner: '独立作者/流程' },
  { id: 'MISSING.annotators', description: '相处质量 1–5 分无人工双标注与分歧记录；讨论门槛未冻结', blocksBusinessAcceptance: true, owner: '人工评审' },
  { id: 'MISSING.run-evidence', description: '0 真实模型/embedding/Lab 房间/宿主/渠道运行；所有场景状态只能是 synthetic-fixture-only-not-run', blocksBusinessAcceptance: true, owner: 'H1+ 运行切片' },
  { id: 'MISSING.attachment-corpus', description: 'FL06 附件/转写语料未物化，附件不可解析分支仅有 1 个合成事件', blocksBusinessAcceptance: true, owner: 'H0c+' },
  { id: 'MISSING.b0-r1-contract', description: 'B0/R1 回复失效与 core 容量配置差异仍是并列契约，尚未映射到公共 API', blocksBusinessAcceptance: true, owner: 'H1+/架构切片' },
  { id: 'MISSING.canary-surfaces', description: '评估侧 canary 仅存在于答案包；尚未在实际视图/模型输入/发送面上运行扫描', blocksBusinessAcceptance: true, owner: 'H1+ 运行切片' },
];

export interface BuildCoverageOptions {
  readonly workspaceRoot: string;
  readonly seed: number;
  readonly generatedAt: string;
  readonly catalogVersion: string;
}

export async function buildCoverageIndex(options: BuildCoverageOptions): Promise<{ index: CoverageIndex; result: CheckResult }> {
  const sources = await verifySourceDocuments(options.workspaceRoot);
  const companionIssues = await verifyCompanionDocuments(options.workspaceRoot);
  const violations: Violation[] = [];
  const splitEntries: SplitEntry[] = [];
  for (const verification of sources) {
    for (const issue of verification.issues) {
      violations.push(violation(verification.exists ? 'source_content_mismatch' : 'source_missing', `$["sources"][${JSON.stringify(verification.scenarioId)}]`, issue));
    }
    splitEntries.push({
      scenarioId: verification.scenarioId,
      familyId: ALL_SCENARIOS.find(scenario => scenario.scenarioId === verification.scenarioId)!.familyId,
      split: 'DEV',
      materialized: true,
    });
  }
  for (const issue of companionIssues) violations.push(violation('companion_document_mismatch', '$', issue));
  const splitPolicy = defaultSplitPolicy();
  const splitCheck = checkSplitPolicy(splitPolicy);
  for (const item of splitCheck.violations) violations.push(item);
  const rows: CoverageScenarioRow[] = ALL_SCENARIOS.map(scenario => {
    const verification = sources.find(item => item.scenarioId === scenario.scenarioId)!;
    const qualitySteps = scenario.steps.filter(step => (step.quality?.applicable.length ?? 0) > 0).map(step => step.stepId);
    const pairingIds = [...new Set(scenario.steps.map(step => step.quality?.pairing).filter((value): value is string => value !== undefined))];
    return {
      scenarioId: scenario.scenarioId,
      familyId: scenario.familyId,
      title: scenario.title,
      split: scenario.split,
      source: { path: scenario.source.sourcePath, kind: scenario.source.kind, existingStepCount: scenario.source.existingStepCount },
      relatedV: scenario.relatedV,
      hDimensions: scenario.hDimensions,
      milestones: scenario.milestones.length,
      materializedSteps: scenario.steps.length,
      designSteps: scenario.designStepIds.length,
      uncoveredDesignStepIds: scenario.uncoveredDesignStepIds,
      steps: scenario.steps.map(stepRow),
      variants: scenario.variants.map(variant => ({ id: variant.id, expectation: variant.expectation, materialised: variant.materialised })),
      qualitySteps,
      pairingIds,
      verificationStatus: 'synthetic-fixture-only-not-run',
      runEvidence: 0,
      holdout: 'not_materialised',
      historicalSampleUpgraded: false,
      cannotUseForBusinessAcceptance: true,
      gaps: gapsForScenario(scenario.scenarioId, scenario.uncoveredDesignStepIds),
    };
  });
  const materializedSteps = rows.reduce((sum, row) => sum + row.materializedSteps, 0);
  const designSteps = rows.reduce((sum, row) => sum + row.designSteps, 0);
  const uncovered = rows.reduce((sum, row) => sum + row.uncoveredDesignStepIds.length, 0);
  const index: CoverageIndex = {
    schemaVersion: 1,
    kind: 'shiyu.harness.business.coverage',
    generatedAt: options.generatedAt,
    catalogVersion: options.catalogVersion,
    seed: options.seed,
    sources,
    summary: {
      scenarios: rows.length,
      materializedSteps,
      designSteps,
      uncoveredDesignSteps: uncovered,
      fixtures: rows.length,
      answers: rows.length,
      splits: { DEV: rows.filter(row => row.split === 'DEV').length, REG: 0, HOLDOUT: 0 },
      runEvidence: 0,
      holdoutMaterialized: 0,
      annotatorScores: 0,
      realModelCalls: 0,
      realEmbeddingCalls: 0,
      labRooms: 0,
      hostOperations: 0,
    },
    rows,
    splitPolicy: { rules: SPLIT_RULES, state: splitPolicy.holdoutState, result: splitCheck.ok ? 'pass' : 'fail' },
    missingAssets: MISSING_ASSETS,
    cannotUseForBusinessAcceptance: true,
    disclaimer:
      '本索引只说明 S/FL 合成 fixture 与独立答案集骨架已物化、来源步骤计数已核对。' +
      '没有任何产品/宿主/模型/Lab/渠道运行，所有场景状态为 synthetic-fixture-only-not-run；' +
      '它不能用于业务验收，也不能被后续切片当作已验证证据或 HOLDOUT。',
    commands: [
      'node scripts/harness/fl-scenarios.mjs',
      'node --import tsx --test --test-concurrency=1 tests/harness-business.test.ts',
      'node --import tsx --test --test-concurrency=1 tests/harness-*.test.ts',
    ],
  };
  const result = finish(
    {
      oracle: 'business-coverage',
      version: COVERAGE_VERSION,
      boundary:
        '核对 16 个场景的来源文档/步骤计数/矩阵提及，并汇总未物化步骤、变体、负载、HOLDOUT、标注与运行证据缺口；' +
        '不证明业务语义或运行行为。',
      scope: 'sfl-coverage',
    },
    rows.length,
    violations,
    {
      scenarios: rows.length,
      materializedSteps,
      designSteps,
      uncoveredDesignSteps: uncovered,
      sourcesVerified: sources.filter(source => source.issues.length === 0).length,
    },
  );
  return { index, result };
}

/* --------------------------- markdown --------------------------- */

export function renderCoverageMarkdown(index: CoverageIndex): string {
  const lines: string[] = [];
  lines.push('# H0c S/FL 业务测试集骨架覆盖索引');
  lines.push('');
  lines.push(`生成时间：${index.generatedAt}；catalog ${index.catalogVersion}；seed ${index.seed}。`);
  lines.push('');
  lines.push('> **还不能用于业务验收。** 本索引只说明合成 fixture 与独立答案集骨架已物化、来源计数已核对；' +
    '0 真实模型/embedding/Lab/宿主/渠道运行，所有场景为 `synthetic-fixture-only-not-run`。');
  lines.push('');
  lines.push('## 1. 汇总');
  lines.push('');
  lines.push('| 项目 | 计数 | 说明 |');
  lines.push('| --- | --- | --- |');
  lines.push(`| 场景 | ${index.summary.scenarios} | S01–S08 + FL01–FL08 |`);
  lines.push(`| 已物化代表步骤 | ${index.summary.materializedSteps} | 每场景 3–5 步；不是历史 80 步全量 |`);
  lines.push(`| 历史设计步骤 | ${index.summary.designSteps} | 54 S + 26 FL（FL02/06/07/08 无历史步骤） |`);
  lines.push(`| 未物化设计步骤 | ${index.summary.uncoveredDesignSteps} | 见各行 uncovered |`);
  lines.push(`| fixture / answers | ${index.summary.fixtures} / ${index.summary.answers} | 公开输入与评估侧答案分开 |`);
  lines.push(`| 运行证据 | 0 | 无模型/embedding/Lab/宿主/渠道 |`);
  lines.push(`| HOLDOUT | 0 | 保留集未制作，仅保留规则 |`);
  lines.push(`| 人工标注 | 0 | 无双人盲评、无质量分数 |`);
  lines.push('');
  lines.push('## 2. 场景覆盖（状态只能是 synthetic-fixture-only-not-run）');
  lines.push('');
  lines.push('| 场景 | split | 物化/历史步 | 未物化步骤 | 里程碑 | H | 质量步骤 | 变体 | 来源 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of index.rows) {
    lines.push(
      `| ${row.scenarioId} ${row.title} | ${row.split} | ${row.materializedSteps}/${row.designSteps} | ${row.uncoveredDesignStepIds.join(', ') || '—'} | ${row.milestones} | ${row.hDimensions.join(',')} | ${row.qualitySteps.join(', ') || '—'} | ${row.variants.length} | ${row.source.kind}: ${row.source.path} |`,
    );
  }
  lines.push('');
  lines.push('## 3. 来源核验');
  lines.push('');
  lines.push('| 场景 | 来源 | 存在 | 声明步数 | 实际步数 | 问题 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const source of index.sources) {
    lines.push(`| ${source.scenarioId} | ${source.sourcePath} | ${source.exists ? 'yes' : 'no'} | ${source.expectedStepCount} | ${source.observedStepCount} | ${source.issues.join('; ') || '—'} |`);
  }
  lines.push('');
  lines.push(`历史文档步骤计数与来源正文逐项核对；companion 文档（判分/合成公司/覆盖契约/Lab 计划）问题见 coverage.json issues。`);
  lines.push('');
  lines.push('## 4. 拆分规则（DEV / REG / HOLDOUT）');
  lines.push('');
  lines.push(`当前状态：DEV=${index.summary.splits.DEV}，REG=${index.summary.splits.REG}，HOLDOUT=${index.summary.splits.HOLDOUT}；holdout=${index.splitPolicy.state}。`);
  lines.push('');
  for (const rule of index.splitPolicy.rules) lines.push(`- ${rule}`);
  lines.push('');
  lines.push('## 5. 缺失资产（全部阻断业务验收）');
  lines.push('');
  lines.push('| ID | 缺口 | 影响 | 负责切片 |');
  lines.push('| --- | --- | --- | --- |');
  for (const asset of index.missingAssets) {
    lines.push(`| ${asset.id} | ${asset.description} | ${asset.blocksBusinessAcceptance ? '阻断业务验收' : '不阻断'} | ${asset.owner} |`);
  }
  lines.push('');
  lines.push('## 6. 复核方法');
  lines.push('');
  for (const command of index.commands) lines.push(`- \`${command}\``);
  lines.push('');
  lines.push('复核要点：');
  lines.push('1. `fixtures/` 只含公开驱动输入；`answers/` 才含四类允许结果、里程碑、oracle 期望与评估 canary，二者目录分离且扫描通过。');
  lines.push('2. 每个场景的 answers 必须早于任何运行冻结（`freeze.derivedFromProductOutput=false`），语义摘要稳定；不接受由产品输出回填的答案。');
  lines.push('3. 聚合器把硬约束 H1–H8（零容忍）、功能里程碑、相处质量分开；任何 unknown/skip/未运行不得计为通过，也不得有总分。');
  lines.push('4. 历史 case 文档只是公开 DEV 设计来源；其未物化步骤、变体、噪音/负载、HOLDOUT 与人工标注仍是缺口。');
  lines.push('5. 任何“业务通过/已验证”措辞都与本索引矛盾；先由后续切片在真实/沙箱运行中提供独立证据。');
  lines.push('');
  lines.push('## 7. 免责声明');
  lines.push('');
  lines.push(index.disclaimer);
  lines.push('');
  return lines.join('\n');
}

/* --------------------------- honesty + self-proof --------------------------- */

export function checkCoverageHonesty(index: CoverageIndex): CheckResult {
  const violations: Violation[] = [];
  if (index.cannotUseForBusinessAcceptance !== true) {
    violations.push(violation('missing_cannot_use_flag_in_index', '$.cannotUseForBusinessAcceptance', 'index must state it cannot be used for business acceptance'));
  }
  if (index.summary.runEvidence !== 0) {
    violations.push(violation('coverage_claims_run_evidence', '$.summary.runEvidence', `${index.summary.runEvidence} run evidence claimed, but H0c has no product/host/model run`));
  }
  if (index.summary.holdoutMaterialized !== 0) {
    violations.push(violation('coverage_claims_holdout_materialized', '$.summary.holdoutMaterialized', 'HOLDOUT must stay unmaterialised'));
  }
  if (index.summary.realModelCalls !== 0 || index.summary.realEmbeddingCalls !== 0 || index.summary.labRooms !== 0 || index.summary.hostOperations !== 0) {
    violations.push(violation('coverage_claims_real_calls', '$.summary', '0-real-call declaration is violated'));
  }
  for (const row of index.rows) {
    if (row.verificationStatus !== 'synthetic-fixture-only-not-run') {
      violations.push(violation('coverage_status_upgraded', `$["rows"][${JSON.stringify(row.scenarioId)}]`, `scenario status ${row.verificationStatus} claims more than a synthetic skeleton`));
    }
    if (row.holdout !== 'not_materialised') violations.push(violation('coverage_claims_holdout_materialized', `$["rows"][${JSON.stringify(row.scenarioId)}]`, 'row claims a materialised holdout'));
    if (row.historicalSampleUpgraded !== false) violations.push(violation('coverage_historical_sample_upgraded', `$["rows"][${JSON.stringify(row.scenarioId)}]`, 'historical sample upgrade flag must be false'));
    if (row.cannotUseForBusinessAcceptance !== true) violations.push(violation('missing_cannot_use_flag_in_rows', `$["rows"][${JSON.stringify(row.scenarioId)}]`, 'row must state it cannot be used for business acceptance'));
    if (row.designSteps > row.materializedSteps && row.uncoveredDesignStepIds.length === 0) {
      violations.push(violation('missing_uncovered_accounting', `$["rows"][${JSON.stringify(row.scenarioId)}]`, 'design steps exceed materialised steps but no uncovered ids are listed'));
    }
    if (row.verificationStatus === 'synthetic-fixture-only-not-run' && row.runEvidence !== 0) {
      violations.push(violation('coverage_claims_run_evidence', `$["rows"][${JSON.stringify(row.scenarioId)}]`, 'row claims run evidence while status says not run'));
    }
  }
  if (index.splitPolicy.state !== 'reserved_not_materialised') {
    violations.push(violation('coverage_claims_holdout_materialized', '$.splitPolicy.state', 'holdout state must be reserved_not_materialised in H0c'));
  }
  return finish(
    {
      oracle: 'business-coverage',
      version: COVERAGE_VERSION,
      boundary:
        '核对覆盖索引的诚实性：运行证据=0、HOLDOUT 未物化、历史样本未升级、状态只能是 synthetic-fixture-only-not-run、' +
        '未物化步骤必须有清单且声明不可用于业务验收。',
      scope: 'coverage-honesty',
    },
    index.rows.length,
    violations,
    { scenarios: index.rows.length },
  );
}

function workspaceRootFromModule(): string {
  // .../tests/harness/business/coverage.ts -> workspace root is five levels up.
  return resolve(fileURLToPath(new URL('../../../../..', import.meta.url)));
}

export const coverageSelfProof = {
  name: 'business-coverage',
  version: COVERAGE_VERSION,
  module: 'tests/harness/business/coverage.ts',
  boundary:
    '核对 16 个场景的来源文档/步骤计数/矩阵提及，并汇总未物化步骤、变体、负载、HOLDOUT、标注与运行证据缺口；诚实性门拒绝任何运行/HOLDOUT/升级声明。' +
    '不证明业务语义或运行行为。',
  scenarios: [
    {
      label: 'accept-real-workspace-coverage-honest',
      expect: 'accept' as const,
      why: '真实工作区来源步骤计数与诚实覆盖索引一致',
      run: async () => {
        const workspaceRoot = workspaceRootFromModule();
        const { index, result } = await buildCoverageIndex({
          workspaceRoot,
          seed: 20261101,
          generatedAt: '2026-11-01T00:00:00.000Z',
          catalogVersion: '1.0.0',
        });
        const honesty = checkCoverageHonesty(index);
        const violations = [...result.violations, ...honesty.violations];
        return finish(
          { oracle: 'business-coverage', version: COVERAGE_VERSION, boundary: 'coverage-self-proof', scope: 'real-workspace' },
          result.checked + honesty.checked,
          violations,
          { sources: index.sources.length, scenarios: index.rows.length },
        );
      },
    },
    {
      label: 'reject-tampered-coverage-claims-run',
      expect: 'reject' as const,
      expectCodes: ['coverage_claims_run_evidence'],
      why: '把运行证据改成 1 的覆盖索引必须被拒绝',
      run: async () => {
        const workspaceRoot = workspaceRootFromModule();
        const { index } = await buildCoverageIndex({ workspaceRoot, seed: 20261101, generatedAt: '2026-11-01T00:00:00.000Z', catalogVersion: '1.0.0' });
        const tampered = JSON.parse(JSON.stringify(index)) as CoverageIndex;
        (tampered.summary as unknown as { runEvidence: number }).runEvidence = 1;
        return checkCoverageHonesty(tampered);
      },
    },
    {
      label: 'reject-tampered-coverage-claims-holdout',
      expect: 'reject' as const,
      expectCodes: ['coverage_claims_holdout_materialized'],
      why: '声称 HOLDOUT 已物化必须被拒绝',
      run: async () => {
        const workspaceRoot = workspaceRootFromModule();
        const { index } = await buildCoverageIndex({ workspaceRoot, seed: 20261101, generatedAt: '2026-11-01T00:00:00.000Z', catalogVersion: '1.0.0' });
        const tampered = JSON.parse(JSON.stringify(index)) as CoverageIndex;
        (tampered.summary as unknown as { holdoutMaterialized: number }).holdoutMaterialized = 3;
        return checkCoverageHonesty(tampered);
      },
    },
  ],
  samples: [],
};
