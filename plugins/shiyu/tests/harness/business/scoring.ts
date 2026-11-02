/**
 * H1–H8 scoring + functional/coexistence aggregation for the H0c skeleton.
 *
 * Two report families stay strictly separate (判分与数据拆分.md §1):
 * - hard constraints H1–H8 are zero-tolerance per case and are never averaged;
 * - functional milestones report achieved/applicable per scenario;
 * - coexistence quality is human 1–5 per dimension and is never combined with
 *   function into one "total score" (thresholds are not frozen either).
 *
 * The aggregator only computes; `checkAggregationHonesty` re-derives the
 * denominators from the raw case results and rejects reports that hide hard
 * violations, count unknown/skipped/not-run as pass, invent a total score,
 * claim business acceptance without a complete run, or turn quality into
 * functional evidence. H0c has no real run: the default report for the
 * skeleton is "undecidable / not claimed", never "passed".
 */
import type { CheckResult, JsonValue, Violation } from '../invariant.js';
import { finish, violation } from '../invariant.js';
import {
  H_DIMENSIONS,
  QUALITY_DIMENSIONS,
  type HDimension,
  type QualityDimensionId,
  type ScenarioId,
  type Split,
} from './types.js';

export type CaseExecutionStatus = 'executed' | 'not_run' | 'skipped' | 'not_applicable' | 'unknown';
export type CaseSourceKind = 'synthetic-fixture' | 'historical-limited' | 'real-run';

export interface FunctionalMilestoneResult {
  readonly milestoneId: string;
  readonly achieved: boolean;
  readonly evidenceRef: string | null;
}

export interface CaseQualityScore {
  readonly dimension: QualityDimensionId;
  readonly score: 1 | 2 | 3 | 4 | 5;
  readonly annotatorId: string;
}

export interface CaseRunResult {
  readonly caseId: string;
  readonly scenarioId: ScenarioId;
  readonly split: Split;
  readonly sourceKind: CaseSourceKind;
  readonly executionStatus: CaseExecutionStatus;
  readonly hardViolations: readonly HDimension[];
  readonly functional: readonly FunctionalMilestoneResult[];
  readonly quality?: readonly CaseQualityScore[];
  readonly unknownReasons?: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface AggregationPlanCase {
  readonly caseId: string;
  readonly scenarioId: ScenarioId;
  /** Milestones that must be achieved for this case to count as functional pass. */
  readonly requiredMilestones: readonly string[];
}

export interface AggregationPlan {
  readonly planId: string;
  readonly freezeRef: string;
  readonly cases: readonly AggregationPlanCase[];
}

export interface FunctionalScenarioReport {
  readonly scenarioId: ScenarioId;
  readonly cases: number;
  readonly milestonesAchieved: number;
  readonly milestonesApplicable: number;
  readonly missingMilestones: readonly string[];
  readonly ratio: number | null;
}

export interface QualityDimensionReport {
  readonly dimension: QualityDimensionId;
  readonly title: string;
  readonly annotations: number;
  readonly scoredCases: number;
  readonly median: number | null;
  readonly annotatorDisagreements: number;
  readonly notApplicableCases: number;
}

export interface AggregationReport {
  readonly schemaVersion: number;
  readonly kind: 'shiyu.harness.business.aggregation';
  readonly planId: string;
  readonly planFreezeRef: string;
  readonly denominators: {
    readonly planned: number;
    readonly executed: number;
    readonly passed: number;
    readonly failed: number;
    readonly unknown: number;
    readonly skipped: number;
    readonly notRun: number;
    readonly notApplicable: number;
  };
  readonly hardConstraints: {
    readonly zeroTolerance: true;
    readonly gate: 'pass' | 'fail' | 'undecidable';
    readonly casesWithViolations: number;
    readonly violationsByDimension: Readonly<Partial<Record<HDimension, number>>>;
    readonly details: readonly { readonly caseId: string; readonly dimensions: readonly HDimension[] }[];
  };
  readonly functional: {
    readonly byScenario: readonly FunctionalScenarioReport[];
    readonly overall: { readonly milestonesAchieved: number; readonly milestonesApplicable: number; readonly ratio: number | null };
  };
  readonly quality: {
    readonly byDimension: readonly QualityDimensionReport[];
    readonly annotatorPairs: number;
    readonly note: string;
  };
  readonly separation: {
    readonly functionalAndQualitySeparate: true;
    readonly totalScorePresent: false;
    readonly qualityCannotCompensateFunction: true;
  };
  readonly claims: {
    readonly businessAcceptance: 'not_claimed' | 'claimed';
    readonly basis: string;
  };
  readonly cannotClaim: readonly string[];
  readonly totalScore?: number;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** Build the separate hard/functional/quality report from raw case results. */
export function aggregateCaseResults(plan: AggregationPlan, results: readonly CaseRunResult[]): AggregationReport {
  const byCase = new Map(results.map(result => [result.caseId, result]));
  const planCases = new Map(plan.cases.map(item => [item.caseId, item]));
  const violations: { caseId: string; dimensions: HDimension[] }[] = [];
  const violationsByDimension: Partial<Record<HDimension, number>> = {};
  let executed = 0;
  let passed = 0;
  let failed = 0;
  let unknown = 0;
  let skipped = 0;
  let notRun = 0;
  let notApplicable = 0;
  const scenarioMap = new Map<ScenarioId, { cases: number; achieved: number; applicable: number; missing: string[] }>();
  for (const planCase of plan.cases) {
    const aggregate = scenarioMap.get(planCase.scenarioId) ?? { cases: 0, achieved: 0, applicable: 0, missing: [] };
    aggregate.cases++;
    aggregate.applicable += planCase.requiredMilestones.length;
    const result = byCase.get(planCase.caseId);
    if (result === undefined || result.executionStatus === 'not_run') {
      notRun++;
      aggregate.missing.push(...planCase.requiredMilestones);
      scenarioMap.set(planCase.scenarioId, aggregate);
      continue;
    }
    if (result.executionStatus === 'skipped') {
      skipped++;
      aggregate.missing.push(...planCase.requiredMilestones);
      scenarioMap.set(planCase.scenarioId, aggregate);
      continue;
    }
    if (result.executionStatus === 'unknown') {
      unknown++;
      aggregate.missing.push(...planCase.requiredMilestones);
      scenarioMap.set(planCase.scenarioId, aggregate);
      continue;
    }
    if (result.executionStatus === 'not_applicable') {
      notApplicable++;
      scenarioMap.set(planCase.scenarioId, aggregate);
      continue;
    }
    executed++;
    const violationsForCase = [...new Set(result.hardViolations)];
    if (violationsForCase.length > 0) {
      violations.push({ caseId: result.caseId, dimensions: violationsForCase });
      for (const dimension of violationsForCase) violationsByDimension[dimension] = (violationsByDimension[dimension] ?? 0) + 1;
    }
    const achieved = new Set(result.functional.filter(item => item.achieved).map(item => item.milestoneId));
    for (const milestone of planCase.requiredMilestones) {
      if (achieved.has(milestone)) aggregate.achieved++;
      else aggregate.missing.push(milestone);
    }
    scenarioMap.set(planCase.scenarioId, aggregate);
    const functionalPass = planCase.requiredMilestones.every(milestone => achieved.has(milestone));
    if (violationsForCase.length === 0 && functionalPass) passed++;
    else failed++;
  }
  for (const [caseId, result] of byCase) {
    if (!planCases.has(caseId)) {
      violations.push({ caseId, dimensions: [...result.hardViolations] });
    }
  }
  const milestonesAchieved = [...scenarioMap.values()].reduce((sum, item) => sum + item.achieved, 0);
  const milestonesApplicable = [...scenarioMap.values()].reduce((sum, item) => sum + item.applicable, 0);
  const hardGate: AggregationReport['hardConstraints']['gate'] =
    violations.length > 0 ? 'fail' : executed === 0 ? 'undecidable' : executed < plan.cases.length ? 'undecidable' : 'pass';
  // Quality is reported separately and only for executed cases with annotations.
  const qualityByDimension: QualityDimensionReport[] = QUALITY_DIMENSIONS.map(definition => {
    const annotations: { caseId: string; annotatorId: string; score: number }[] = [];
    let notApplicableCount = 0;
    let annotatorPairs = 0;
    const disagreements: number[] = [];
    for (const result of results) {
      if (result.executionStatus !== 'executed') continue;
      const scores = (result.quality ?? []).filter(item => item.dimension === definition.id);
      if (scores.length === 0) notApplicableCount++;
      for (const score of scores) annotations.push({ caseId: result.caseId, annotatorId: score.annotatorId, score: score.score });
      if (scores.length >= 2) {
        annotatorPairs++;
        for (let left = 0; left < scores.length; left++) {
          for (let right = left + 1; right < scores.length; right++) {
            if (Math.abs(scores[left].score - scores[right].score) > 1) disagreements.push(1);
          }
        }
      }
    }
    return {
      dimension: definition.id,
      title: definition.title,
      annotations: annotations.length,
      scoredCases: new Set(annotations.map(item => item.caseId)).size,
      median: median(annotations.map(item => item.score)),
      annotatorDisagreements: disagreements.reduce((sum, item) => sum + item, 0),
      notApplicableCases: notApplicableCount,
    };
  });
  const cannotClaim: string[] = [];
  if (notRun + unknown + skipped + notApplicable > 0) {
    cannotClaim.push(`存在未运行/未知/跳过/不适用用例 ${notRun + unknown + skipped + notApplicable}/${plan.cases.length}，不能用于业务验收`);
  }
  if (hardGate === 'fail') cannotClaim.push('存在 H1–H8 硬约束违规，按零容忍规则不得用于业务验收');
  if (hardGate === 'undecidable') cannotClaim.push('硬约束门不可判定：缺少已执行用例或覆盖不完整');
  if (results.every(result => result.sourceKind === 'synthetic-fixture')) {
    cannotClaim.push('当前只有 H0c 合成骨架 fixture，没有任何产品/宿主/模型运行证据');
  }
  if (results.some(result => result.sourceKind === 'historical-limited')) {
    cannotClaim.push('历史有限样本不能升级为本切片通过证据');
  }
  cannotClaim.push('相处质量分数为人工 1–5 分维度，不参与功能/硬约束判定，也不汇总为总分');
  return {
    schemaVersion: 1,
    kind: 'shiyu.harness.business.aggregation',
    planId: plan.planId,
    planFreezeRef: plan.freezeRef,
    denominators: { planned: plan.cases.length, executed, passed, failed, unknown, skipped, notRun, notApplicable },
    hardConstraints: {
      zeroTolerance: true,
      gate: hardGate,
      casesWithViolations: violations.length,
      violationsByDimension,
      details: violations,
    },
    functional: {
      byScenario: [...scenarioMap.entries()]
        .map(([scenarioId, value]) => ({
          scenarioId,
          cases: value.cases,
          milestonesAchieved: value.achieved,
          milestonesApplicable: value.applicable,
          missingMilestones: [...new Set(value.missing)],
          ratio: value.applicable === 0 ? null : value.achieved / value.applicable,
        }))
        .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId)),
      overall: { milestonesAchieved, milestonesApplicable, ratio: milestonesApplicable === 0 ? null : milestonesAchieved / milestonesApplicable },
    },
    quality: {
      byDimension: qualityByDimension,
      annotatorPairs: Math.max(...qualityByDimension.map(item => item.scoredCases), 0),
      note: '人工 1–5 分逐维保留；无适用内容标不适用；讨论门槛（中位数≥4）尚未冻结，不并入功能或硬约束。',
    },
    separation: { functionalAndQualitySeparate: true, totalScorePresent: false, qualityCannotCompensateFunction: true },
    claims: {
      businessAcceptance: 'not_claimed',
      basis: 'H0c 只生成合成 fixture 与独立答案；没有任何运行结果，因此不声称业务验收。',
    },
    cannotClaim,
  };
}

const ORACLE = 'business-aggregation';
const VERSION = '1.0.0';
const BOUNDARY =
  '重算硬约束/功能/质量三张成绩单并核对报告：拒绝隐藏 H1–H8 违规、把 unknown/skipped/not-run 计为通过、' +
  '把质量分当功能证据、伪造分母、出现总分、在完整运行前声称业务验收。不证明语义质量，也不替代真实运行。';

const CASE_RESULT_BASE = {
  split: 'DEV' as Split,
  sourceKind: 'synthetic-fixture' as CaseSourceKind,
  executionStatus: 'executed' as CaseExecutionStatus,
  hardViolations: [] as readonly HDimension[],
  evidenceRefs: ['fixture:selftest'],
};

function planFor(cases: readonly { caseId: string; scenarioId: ScenarioId; milestones: readonly string[] }[]): AggregationPlan {
  return {
    planId: 'plan-selftest',
    freezeRef: 'fixture:selftest-plan',
    cases: cases.map(item => ({ caseId: item.caseId, scenarioId: item.scenarioId, requiredMilestones: item.milestones })),
  };
}

export function checkAggregationHonesty(report: AggregationReport, plan: AggregationPlan, results: readonly CaseRunResult[]): CheckResult {
  const violations: Violation[] = [];
  let checked = 1;
  const recomputed = aggregateCaseResults(plan, results);
  // Plan integrity.
  const caseIds = plan.cases.map(item => item.caseId);
  if (new Set(caseIds).size !== caseIds.length) violations.push(violation('duplicate_plan_case', '$["plan"]["cases"]', 'aggregation plan contains duplicate case ids'));
  checked += plan.cases.length;
  // Single total score is forbidden.
  if ((report as { totalScore?: number }).totalScore !== undefined) {
    violations.push(violation('total_score_present', '$["totalScore"]', 'functional and coexistence scores must not be combined into one total'));
  }
  if (report.separation?.totalScorePresent !== false || report.separation?.functionalAndQualitySeparate !== true) {
    violations.push(violation('separation_invalid', '$["separation"]', 'report must state functional/quality separation and no total score'));
  }
  // Denominators must match the raw run.
  const denominatorKeys = Object.keys(recomputed.denominators) as (keyof AggregationReport['denominators'])[];
  for (const key of denominatorKeys) {
    checked++;
    if (report.denominators[key] !== recomputed.denominators[key]) {
      violations.push(violation('denominator_mismatch', `$["denominators"]["${String(key)}"]`, `reported ${report.denominators[key]}, recomputed ${recomputed.denominators[key]}`));
    }
  }
  // Hidden hard violations.
  if (recomputed.hardConstraints.gate === 'fail' && report.hardConstraints.gate !== 'fail') {
    violations.push(violation('hard_violation_ignored', '$["hardConstraints"]["gate"]', 'raw results contain H1–H8 violations but the report does not fail the hard gate'));
  }
  for (const detail of recomputed.hardConstraints.details) {
    if (!report.hardConstraints.details.some(item => item.caseId === detail.caseId)) {
      violations.push(violation('hard_violation_ignored', '$["hardConstraints"]["details"]', `case ${detail.caseId} has hard violations hidden from the report`));
    }
  }
  // Unknown/skip/not-run must never inflate passed.
  const statusByCase = new Map(results.map(result => [result.caseId, result]));
  const statusCounts: Record<'unknown' | 'skipped' | 'not_run', number> = { unknown: 0, skipped: 0, not_run: 0 };
  for (const result of results) {
    if (result.executionStatus === 'unknown') statusCounts.unknown++;
    if (result.executionStatus === 'skipped') statusCounts.skipped++;
    if (result.executionStatus === 'not_run') statusCounts.not_run++;
  }
  if (report.denominators.unknown < statusCounts.unknown) violations.push(violation('unknown_counted_pass', '$["denominators"]["unknown"]', 'unknown cases were not preserved in denominators'));
  if (report.denominators.skipped < statusCounts.skipped) violations.push(violation('skipped_counted_pass', '$["denominators"]["skipped"]', 'skipped cases were dropped from denominators'));
  if (report.denominators.notRun < statusCounts.not_run) violations.push(violation('not_run_counted_pass', '$["denominators"]["notRun"]', 'not-run cases were dropped from denominators'));
  // Functional denominators.
  if (report.functional.overall.milestonesApplicable !== recomputed.functional.overall.milestonesApplicable) {
    violations.push(violation('functional_denominator_tampered', '$["functional"]["overall"]', 'functional applicable denominator differs from the frozen plan'));
  }
  if (report.functional.overall.milestonesAchieved > recomputed.functional.overall.milestonesAchieved) {
    violations.push(violation('functional_denominator_tampered', '$["functional"]["overall"]', 'achieved milestones exceed the raw run'));
  }
  if (recomputed.functional.overall.milestonesApplicable === 0) {
    checked++;
    if (report.functional.overall.ratio !== null) {
      violations.push(violation('zero_denominator_claimed_full', '$["functional"]["overall"]["ratio"]', 'zero applicable milestones must stay not-applicable, not 100%'));
    }
  }
  // Quality cannot compensate function.
  const highQualityCases = results.filter(result => (result.quality ?? []).some(score => score.score >= 4));
  const functionalFailures = results.filter(result => {
    const planCase = plan.cases.find(item => item.caseId === result.caseId);
    if (planCase === undefined) return false;
    const achieved = new Set(result.functional.filter(item => item.achieved).map(item => item.milestoneId));
    return planCase.requiredMilestones.some(milestone => !achieved.has(milestone)) || result.hardViolations.length > 0;
  });
  if (highQualityCases.length > 0 && functionalFailures.length > 0 && report.claims.businessAcceptance === 'claimed') {
    violations.push(violation('quality_compensates_function', '$["claims"]["businessAcceptance"]', 'quality scores cannot compensate hard/functional failures'));
  }
  // Business acceptance claims require a complete, hard-passing, non-historical run.
  if (report.claims.businessAcceptance === 'claimed') {
    checked++;
    const incomplete = statusCounts.unknown + statusCounts.skipped + statusCounts.not_run > 0;
    if (incomplete) violations.push(violation('business_acceptance_claimed_without_evidence', '$["claims"]["businessAcceptance"]', 'business acceptance claimed while unknown/skipped/not-run cases exist'));
    if (recomputed.hardConstraints.gate !== 'pass') {
      violations.push(violation('business_acceptance_claimed_without_evidence', '$["claims"]["businessAcceptance"]', 'business acceptance claimed without a passing hard gate'));
    }
    if (recomputed.functional.overall.milestonesApplicable === 0) {
      violations.push(violation('quality_used_as_functional_evidence', '$["functional"]', 'no applicable functional milestone but business acceptance is claimed'));
    }
    if (results.some(result => result.sourceKind === 'historical-limited')) {
      violations.push(violation('historical_sample_upgraded', '$["claims"]', 'historical limited sample cannot support a business acceptance claim'));
    }
    if (results.every(result => result.sourceKind !== 'real-run')) {
      violations.push(violation('business_acceptance_claimed_without_real_run', '$["claims"]', 'no real-run case source; synthetic fixtures cannot claim business acceptance'));
    }
  }
  void statusByCase;
  return finish(
    { oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'aggregation-honesty' },
    checked + recomputed.denominators.planned,
    violations,
    {
      planned: plan.cases.length,
      executed: recomputed.denominators.executed,
      hardGate: recomputed.hardConstraints.gate,
      totalScorePresent: (report as { totalScore?: number }).totalScore !== undefined,
    },
  );
}

/* ------------------------------------------------------------------ */
/* Self-proofs.                                                        */
/* ------------------------------------------------------------------ */

const SIMPLE_PLAN = planFor([
  { caseId: 'S01-a', scenarioId: 'S01', milestones: ['M.S01.save-source-separation', 'M.S01.corrected-fact-current'] },
  { caseId: 'S01-b', scenarioId: 'S01', milestones: ['M.S01.uncertainty-distinguished'] },
]);

function simpleResults(): CaseRunResult[] {
  return [
    {
      caseId: 'S01-a',
      scenarioId: 'S01',
      ...CASE_RESULT_BASE,
      functional: [
        { milestoneId: 'M.S01.save-source-separation', achieved: true, evidenceRef: 'ledger:selftest-a1' },
        { milestoneId: 'M.S01.corrected-fact-current', achieved: true, evidenceRef: 'ledger:selftest-a2' },
      ],
      quality: [
        { dimension: 'situational_understanding', score: 4, annotatorId: 'annotator-1' },
        { dimension: 'situational_understanding', score: 5, annotatorId: 'annotator-2' },
      ],
    },
    {
      caseId: 'S01-b',
      scenarioId: 'S01',
      ...CASE_RESULT_BASE,
      executionStatus: 'not_run',
      functional: [],
    },
  ];
}

function reportWith(base: AggregationReport, patch: (report: Record<string, unknown>) => void): AggregationReport {
  const clone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  patch(clone);
  return clone as unknown as AggregationReport;
}

export const aggregationSelfProof = {
  name: ORACLE,
  version: VERSION,
  module: 'tests/harness/business/scoring.ts',
  boundary: BOUNDARY,
  evaluate: (input: unknown) => {
    const { plan, results, report } = input as { plan: AggregationPlan; results: CaseRunResult[]; report?: AggregationReport };
    const actual = report ?? aggregateCaseResults(plan, results);
    return checkAggregationHonesty(actual, plan, results);
  },
  samples: [
    {
      label: 'accept-honest-partial-skeleton-report',
      input: { plan: SIMPLE_PLAN, results: simpleResults() },
      expect: 'accept' as const,
      why: '如实报告 executed=1/planned=2、unknown/skip/not-run 保留、业务验收未声称',
    },
    {
      label: 'accept-zero-applicable-milestones-not-applicable',
      input: {
        plan: planFor([{ caseId: 'S07-q', scenarioId: 'S07', milestones: [] }]),
        results: [{ caseId: 'S07-q', scenarioId: 'S07', ...CASE_RESULT_BASE, functional: [] }],
      },
      expect: 'accept' as const,
      why: '没有适用功能里程碑时 ratio=null（不适用），不冒充 100% 通过',
    },
    {
      label: 'reject-hidden-hard-violation',
      input: {
        plan: SIMPLE_PLAN,
        results: [{ ...simpleResults()[0], hardViolations: ['H2'] }, simpleResults()[1]],
        report: reportWith(aggregateCaseResults(SIMPLE_PLAN, simpleResults()), report => {
          (report.hardConstraints as Record<string, unknown>).gate = 'pass';
        }),
      },
      expect: 'reject' as const,
      expectCodes: ['hard_violation_ignored'],
      why: '原始结果含 H2 违规但报告硬门为 pass',
    },
    {
      label: 'reject-business-acceptance-without-run',
      input: {
        plan: SIMPLE_PLAN,
        results: simpleResults(),
        report: reportWith(aggregateCaseResults(SIMPLE_PLAN, simpleResults()), report => {
          (report.claims as Record<string, unknown>).businessAcceptance = 'claimed';
        }),
      },
      expect: 'reject' as const,
      expectCodes: ['business_acceptance_claimed_without_evidence'],
      why: '存在未运行用例却声称业务验收',
    },
    {
      label: 'reject-total-score',
      input: {
        plan: SIMPLE_PLAN,
        results: simpleResults(),
        report: reportWith(aggregateCaseResults(SIMPLE_PLAN, simpleResults()), report => {
          report.totalScore = 0.93;
        }),
      },
      expect: 'reject' as const,
      expectCodes: ['total_score_present'],
      why: '禁止把功能与相处质量压成一个总分',
    },
    {
      label: 'reject-unknown-counted-as-pass',
      input: {
        plan: SIMPLE_PLAN,
        results: simpleResults(),
        report: reportWith(aggregateCaseResults(SIMPLE_PLAN, simpleResults()), report => {
          (report.denominators as Record<string, unknown>).notRun = 0;
          (report.denominators as Record<string, unknown>).passed = 2;
        }),
      },
      expect: 'reject' as const,
      expectCodes: ['denominator_mismatch', 'not_run_counted_pass'],
      why: '把未运行用例从分母删除并计入通过',
    },
    {
      label: 'reject-zero-denominator-claimed-full',
      input: {
        plan: planFor([{ caseId: 'S07-q', scenarioId: 'S07', milestones: [] }]),
        results: [{ caseId: 'S07-q', scenarioId: 'S07', ...CASE_RESULT_BASE, functional: [] }],
        report: reportWith(
          aggregateCaseResults(planFor([{ caseId: 'S07-q', scenarioId: 'S07', milestones: [] }]), [
            { caseId: 'S07-q', scenarioId: 'S07', ...CASE_RESULT_BASE, functional: [] },
          ]),
          report => {
            (report.functional as Record<string, unknown>).overall = { milestonesAchieved: 0, milestonesApplicable: 0, ratio: 1 };
          },
        ),
      },
      expect: 'reject' as const,
      expectCodes: ['zero_denominator_claimed_full'],
      why: '分母为 0 时声称 100% 通过',
    },
    {
      label: 'reject-quality-compensates-functional-failure',
      input: {
        plan: SIMPLE_PLAN,
        results: [
          {
            ...simpleResults()[0],
            hardViolations: ['H1'],
            quality: [
              { dimension: 'emotional_fit', score: 5, annotatorId: 'annotator-1' },
              { dimension: 'emotional_fit', score: 5, annotatorId: 'annotator-2' },
            ],
          },
          simpleResults()[1],
        ],
        report: reportWith(aggregateCaseResults(SIMPLE_PLAN, simpleResults()), report => {
          (report.claims as Record<string, unknown>).businessAcceptance = 'claimed';
        }),
      },
      expect: 'reject' as const,
      expectCodes: ['business_acceptance_claimed_without_evidence', 'hard_violation_ignored', 'quality_compensates_function'],
      why: '相处质量高分不能抵消硬违规/功能失败',
    },
    {
      label: 'reject-historical-sample-upgraded',
      input: {
        plan: planFor([{ caseId: 'FL01-h', scenarioId: 'FL01', milestones: ['M.FL01.capture-business-without-at'] }]),
        results: [
          {
            caseId: 'FL01-h',
            scenarioId: 'FL01',
            split: 'HOLDOUT',
            sourceKind: 'historical-limited',
            executionStatus: 'executed',
            hardViolations: [],
            functional: [{ milestoneId: 'M.FL01.capture-business-without-at', achieved: true, evidenceRef: 'historical:phase3h' }],
            evidenceRefs: ['historical:phase3h'],
          },
        ],
        report: reportWith(
          aggregateCaseResults(planFor([{ caseId: 'FL01-h', scenarioId: 'FL01', milestones: ['M.FL01.capture-business-without-at'] }]), [
            {
              caseId: 'FL01-h',
              scenarioId: 'FL01',
              split: 'HOLDOUT',
              sourceKind: 'historical-limited',
              executionStatus: 'executed',
              hardViolations: [],
              functional: [{ milestoneId: 'M.FL01.capture-business-without-at', achieved: true, evidenceRef: 'historical:phase3h' }],
              evidenceRefs: ['historical:phase3h'],
            },
          ]),
          report => {
            (report.claims as Record<string, unknown>).businessAcceptance = 'claimed';
          },
        ),
      },
      expect: 'reject' as const,
      expectCodes: ['historical_sample_upgraded', 'business_acceptance_claimed_without_real_run'],
      why: '历史有限样本不得被提升为 HOLDOUT/业务通过',
    },
  ],
};

export { H_DIMENSIONS, QUALITY_DIMENSIONS };
export type { JsonValue };
