/**
 * Counting / denominator oracles.
 *
 * These implement the "never claim more than you measured" rules from
 * 02 §3.2 and §9:
 * - missing counters are distinct from zero counters;
 * - arithmetic identities must hold on the recorded denominators;
 * - a run cannot claim completion when planned work is still unattempted;
 * - model usage counts include compressed/retried/failed calls, and missing
 *   usage keeps accounting incomplete instead of being zero-filled;
 * - recurring occurrences need explicit missed-occurrence accounting;
 * - quiet windows must record zero model calls.
 *
 * Boundary: the oracle checks the arithmetic and declared denominators. It
 * cannot prove the recorded numbers were observed independently (the
 * observer/effect ledger oracles guard that).
 */
import type { CheckResult, JsonValue, OracleSelfProof, Violation } from './invariant.js';
import { finish, jsonPointerChild, violation } from './invariant.js';

const ORACLE = 'counts';
const VERSION = '1.1.0';
const BOUNDARY =
  '判定计数分母与守恒：缺失计数≠0、方程两边一致、声称完成时不得有未尝试计划、调用数含压缩/重试/失败、缺失用量保持未知、' +
  '周期遗漏必须显式记账、静默窗口模型调用为 0。不证明计数来自独立观察。';

export type CountValue = number | null | undefined;
export type CountSnapshot = Readonly<Record<string, CountValue>>;

export interface CountEquation {
  readonly name: string;
  /** Counter names whose sum must equal `equals`. */
  readonly sumOf: readonly string[];
  readonly equals: string;
  /** Optional additive constant, e.g. pending counts. */
  readonly plus?: number;
}

export interface DeliveryCompletion {
  readonly planned: string;
  readonly attempted: string;
  readonly pending?: string;
}

export interface CountCheckInput {
  readonly counts: CountSnapshot;
  readonly required?: readonly string[];
  readonly equations?: readonly CountEquation[];
  readonly completion?: DeliveryCompletion;
  readonly claimedComplete?: boolean;
  readonly expected?: CountSnapshot;
}

function isMissing(counts: CountSnapshot, key: string): boolean {
  return counts[key] === undefined;
}

function requireCounter(
  counts: CountSnapshot,
  key: string,
  where: string,
  violations: Violation[],
  required: Set<string>,
): boolean {
  if (isMissing(counts, key)) {
    violations.push(violation('missing_counter', jsonPointerChild(where, key), `counter ${key} is absent; missing is not zero`));
    required.add(key);
    return false;
  }
  return true;
}

export function checkCounts(input: CountCheckInput): CheckResult {
  const violations: Violation[] = [];
  const counts = input.counts;
  const required = new Set(input.required ?? []);
  let checked = 0;
  for (const key of input.required ?? []) {
    checked++;
    if (isMissing(counts, key)) {
      violations.push(violation('missing_counter', jsonPointerChild('$["counts"]', key), `required counter ${key} is absent; missing is not zero`));
    } else if (counts[key] === null) {
      violations.push(violation('counter_unknown', jsonPointerChild('$["counts"]', key), `required counter ${key} is explicitly unknown; it cannot satisfy the frozen denominator`));
    }
  }
  for (const equation of input.equations ?? []) {
    checked++;
    const terms = [...equation.sumOf];
    let sum = equation.plus ?? 0;
    let usable = true;
    for (const term of terms) {
      if (!requireCounter(counts, term, '$["counts"]', violations, required)) {
        usable = false;
        continue;
      }
      const value = counts[term];
      if (value === null) {
        violations.push(violation('counter_unknown', jsonPointerChild('$["counts"]', term), `counter ${term} is explicitly unknown; cannot satisfy ${equation.name}`));
        usable = false;
        continue;
      }
      sum += value!;
    }
    if (usable) {
      const target = counts[equation.equals];
      if (target === undefined) {
        violations.push(violation('missing_counter', jsonPointerChild('$["counts"]', equation.equals), `counter ${equation.equals} is absent; missing is not zero`));
      } else if (target === null) {
        violations.push(violation('counter_unknown', jsonPointerChild('$["counts"]', equation.equals), `counter ${equation.equals} is explicitly unknown`));
      } else if (target !== sum) {
        violations.push(
          violation('count_equation_mismatch', '$["counts"]', `${equation.name}: ${equation.sumOf.join('+')}=${sum} but ${equation.equals}=${target}`, {
            equation: equation.name,
            sum,
            actual: target,
          }),
        );
      }
    }
  }
  if (input.expected !== undefined) {
    for (const [key, expectedValue] of Object.entries(input.expected)) {
      checked++;
      const actual = counts[key];
      if (actual === undefined) {
        violations.push(violation('missing_counter', jsonPointerChild('$["counts"]', key), `expected counter ${key} is absent`));
      } else if (actual !== expectedValue) {
        violations.push(
          violation('unexpected_counter_value', jsonPointerChild('$["counts"]', key), `expected ${String(expectedValue)}, got ${String(actual)}`, {
            expected: expectedValue ?? null,
            actual: actual ?? null,
          }),
        );
      }
    }
  }
  if (input.claimedComplete) {
    checked++;
    const completion = input.completion;
    if (completion === undefined) {
      violations.push(violation('completion_basis_missing', '$', 'claimed completion without a frozen completion denominator (planned/attempted)'));
    } else if (
      requireCounter(counts, completion.planned, '$["counts"]', violations, required) &&
      requireCounter(counts, completion.attempted, '$["counts"]', violations, required)
    ) {
      const planned = counts[completion.planned]!;
      const attempted = counts[completion.attempted]!;
      const pending = completion.pending === undefined ? 0 : (counts[completion.pending] ?? 0);
      if (planned === null || attempted === null) {
        violations.push(violation('counter_unknown', '$["counts"]', 'planned/attempted is explicitly unknown; completion is not decidable'));
      } else if (attempted + pending < planned) {
        violations.push(
          violation('premature_completion', '$', `run claims completion with ${planned - attempted - pending} planned item(s) unattempted`, {
            planned,
            attempted,
            pending,
            shortfall: planned - attempted - pending,
          }),
        );
      }
    }
  }
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'counts' }, checked, violations, {
    counters: counts as JsonValue,
  });
}

/* --------------------------- model usage --------------------------- */

export interface UsageRoleBreakdown {
  readonly role: string;
  readonly calls: number;
  readonly tokensKnown: boolean;
}

export interface UsageAccountingInput {
  /** Calls the independent observer saw. */
  readonly observedCalls: number;
  /** Calls the product reports as accounted. */
  readonly reportedCalls: number;
  readonly callsWithCompleteUsage: number;
  readonly callsMissingUsage: number;
  readonly callsCompressed?: number;
  readonly callsRetried?: number;
  readonly callsFailed?: number;
  readonly zeroFilledMissing?: boolean;
  readonly reportedComplete?: boolean;
  readonly roles?: readonly UsageRoleBreakdown[];
  readonly expectedTotalCalls?: number;
}

export function checkUsageAccounting(input: UsageAccountingInput): CheckResult {
  const violations: Violation[] = [];
  let checked = 1;
  if (input.expectedTotalCalls !== undefined) {
    checked++;
    if (input.observedCalls !== input.expectedTotalCalls) {
      violations.push(
        violation('planned_calls_mismatch', '$["observedCalls"]', `plan froze ${input.expectedTotalCalls} calls, observed ${input.observedCalls}`, {
          planned: input.expectedTotalCalls,
          observed: input.observedCalls,
        }),
      );
    }
  }
  checked++;
  if (input.reportedCalls !== input.observedCalls) {
    violations.push(
      violation('call_count_mismatch', '$["reportedCalls"]', `observer saw ${input.observedCalls} calls but product reports ${input.reportedCalls}`, {
        observedCalls: input.observedCalls,
        reportedCalls: input.reportedCalls,
      }),
    );
  }
  checked++;
  const breakdown = input.callsWithCompleteUsage + input.callsMissingUsage;
  if (breakdown !== input.observedCalls) {
    violations.push(
      violation('usage_breakdown_incomplete', '$', `complete(${input.callsWithCompleteUsage}) + missing(${input.callsMissingUsage}) != observed(${input.observedCalls})`, {
        complete: input.callsWithCompleteUsage,
        missing: input.callsMissingUsage,
        observed: input.observedCalls,
      }),
    );
  }
  checked++;
  if (input.callsMissingUsage > 0 && input.reportedComplete === true) {
    violations.push(
      violation('usage_reported_complete_with_missing', '$', `${input.callsMissingUsage} call(s) lack usage but accounting is reported complete`),
    );
  }
  checked++;
  if (input.zeroFilledMissing === true && input.callsMissingUsage > 0) {
    violations.push(violation('usage_missing_counted_as_zero', '$', 'missing usage was zero-filled instead of kept unknown'));
  }
  if (input.roles !== undefined) {
    checked++;
    const roleCalls = input.roles.reduce((sum, role) => sum + role.calls, 0);
    if (roleCalls !== input.observedCalls) {
      violations.push(
        violation('role_breakdown_mismatch', '$["roles"]', `role breakdown sums to ${roleCalls}, observed ${input.observedCalls}`, {
          roleCalls,
          observedCalls: input.observedCalls,
        }),
      );
    }
    for (const role of input.roles) {
      if (!role.tokensKnown && input.reportedComplete === true) {
        violations.push(violation('role_usage_incomplete', `$["roles"][${JSON.stringify(role.role)}]`, `role ${role.role} has calls without known usage but accounting is complete`));
      }
    }
  }
  const accountingComplete = input.callsMissingUsage === 0 && input.reportedCalls === input.observedCalls;
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'usage-accounting' }, checked, violations, {
    observedCalls: input.observedCalls,
    accountingComplete,
    compressed: input.callsCompressed ?? null,
    retried: input.callsRetried ?? null,
    failed: input.callsFailed ?? null,
  });
}

/* ------------------------- occurrence / quiet ------------------------- */

export interface OccurrenceAccountingInput {
  readonly plannedOccurrences: number;
  readonly due: number;
  readonly executed: number;
  readonly skippedMissed?: number | null;
  readonly latestOnlyPolicy?: boolean;
  readonly expectedExecuted?: number;
}

export function checkOccurrenceAccounting(input: OccurrenceAccountingInput): CheckResult {
  const violations: Violation[] = [];
  let checked = 2;
  const accounted = input.executed + (input.skippedMissed ?? 0);
  if (input.skippedMissed === null) {
    violations.push(violation('missed_occurrence_unknown', '$.skippedMissed', 'missed occurrences are explicitly unknown; catch-up/scan policy cannot be claimed'));
  } else if (input.skippedMissed === undefined && input.due > input.executed) {
    violations.push(
      violation('missed_occurrence_silently_dropped', '$', `${input.due - input.executed} due occurrence(s) are neither executed nor declared missed`, {
        due: input.due,
        executed: input.executed,
      }),
    );
  } else if (accounted < input.due) {
    violations.push(
      violation('missed_occurrence_silently_dropped', '$', `${input.due - accounted} due occurrence(s) unaccounted (executed ${input.executed} + missed ${input.skippedMissed ?? 0})`),
    );
  }
  if (input.expectedExecuted !== undefined) {
    checked++;
    if (input.executed !== input.expectedExecuted) {
      violations.push(
        violation('occurrence_execution_mismatch', '$.executed', `expected ${input.expectedExecuted} execution(s), observed ${input.executed}`, {
          expected: input.expectedExecuted,
          actual: input.executed,
        }),
      );
    }
  }
  if (input.latestOnlyPolicy === true && input.executed > 1 && input.expectedExecuted === undefined) {
    violations.push(violation('duplicate_occurrence_execution', '$.executed', 'latest-only catch-up policy executed more than one missed occurrence'));
  }
  if (input.due > input.plannedOccurrences) {
    violations.push(
      violation('due_exceeds_planned', '$', `due occurrences (${input.due}) exceed the declared plan (${input.plannedOccurrences})`),
    );
  }
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'occurrence-accounting' }, checked, violations, {
    plannedOccurrences: input.plannedOccurrences,
    due: input.due,
    executed: input.executed,
    skippedMissed: input.skippedMissed ?? null,
  });
}

export interface QuietWindowInput {
  readonly modelCalls: number;
  readonly newTasks: number;
  readonly newEffects: number;
  readonly allowedByExplicitSchedule?: boolean;
}

export function checkQuietWindow(input: QuietWindowInput): CheckResult {
  const violations: Violation[] = [];
  const allowed = input.allowedByExplicitSchedule === true;
  if (!allowed && input.modelCalls !== 0) {
    violations.push(violation('silent_period_model_call', '$.modelCalls', `quiet window made ${input.modelCalls} model call(s)`));
  }
  if (input.newTasks !== 0) {
    violations.push(violation('silent_period_new_task', '$.newTasks', `quiet window created ${input.newTasks} task(s); noise must not extend/schedule work`));
  }
  if (input.newEffects !== 0) {
    violations.push(violation('silent_period_new_effect', '$.newEffects', `quiet window produced ${input.newEffects} external effect(s)`));
  }
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'quiet-window' }, 3, violations, {
    modelCalls: input.modelCalls,
    allowedByExplicitSchedule: allowed,
  });
}

/* --------------------------- self-proof --------------------------- */

const plan100: CountCheckInput = {
  counts: {
    planned: 100,
    attempted: 90,
    accepted: 90,
    rejected: 0,
    deduped: 0,
    delayed: 10,
    notAttempted: 10,
    delivered: 80,
  },
  required: ['planned', 'attempted', 'accepted', 'rejected', 'deduped', 'delayed', 'delivered'],
  equations: [
    { name: 'attempted-split', sumOf: ['accepted', 'rejected', 'deduped'], equals: 'attempted' },
    { name: 'plan-split', sumOf: ['attempted', 'notAttempted'], equals: 'planned' },
  ],
  completion: { planned: 'planned', attempted: 'attempted' },
  claimedComplete: false,
};

export const countsSelfProof: OracleSelfProof = {
  name: ORACLE,
  version: VERSION,
  module: 'tests/harness/counts.ts',
  boundary: BOUNDARY,
  evaluate: input => {
    const candidate = input as {
      counts?: CountCheckInput;
      usage?: UsageAccountingInput;
      occurrence?: OccurrenceAccountingInput;
      quiet?: QuietWindowInput;
    };
    if (candidate.usage !== undefined) return checkUsageAccounting(candidate.usage);
    if (candidate.occurrence !== undefined) return checkOccurrenceAccounting(candidate.occurrence);
    if (candidate.quiet !== undefined) return checkQuietWindow(candidate.quiet);
    return checkCounts(candidate as unknown as CountCheckInput);
  },
  samples: [
    {
      label: 'accept-90-of-100-with-explicit-not-attempted',
      input: plan100,
      expect: 'accept',
      why: '90 尝试 + 10 未尝试 = 100 计划，且 delayed=10 显式列出，未声称完成',
    },
    {
      label: 'reject-90-of-90-claimed-complete',
      input: { ...plan100, claimedComplete: true },
      expect: 'reject',
      expectCodes: ['premature_completion'],
      why: '只注入 90/100 却宣称完成 100 条目标负载',
    },
    {
      label: 'reject-claimed-complete-without-basis',
      input: { planned: 100, attempted: 100, claimedComplete: true },
      expect: 'reject',
      expectCodes: ['completion_basis_missing'],
      why: '没有冻结 completion 分母时完成不可判定',
    },
    {
      label: 'reject-missing-counter-is-not-zero',
      input: {
        counts: { planned: 100, attempted: 90, accepted: 90, rejected: 0, deduped: 0, delivered: 80 },
        required: ['planned', 'attempted', 'accepted', 'rejected', 'deduped', 'delayed', 'delivered'],
      },
      // note: counts wrapper is the CountCheckInput shape itself

      expect: 'reject',
      expectCodes: ['missing_counter'],
      why: '缺少 delayed 计数不能默认当 0',
    },
    {
      label: 'reject-unknown-counter',
      input: {
        counts: { planned: 10, attempted: 10, accepted: 8, rejected: 0, deduped: 0, delayed: null },
        required: ['delayed'],
      },
      expect: 'reject',
      expectCodes: ['counter_unknown'],
      why: '显式未知计数与 0 区分，无法满足冻结分母时不可判定',
    },
    {
      label: 'reject-equation-mismatch',
      input: {
        counts: { planned: 100, attempted: 90, accepted: 89, rejected: 0, deduped: 0, delayed: 10, delivered: 80 },
        equations: [{ name: 'attempted-split', sumOf: ['accepted', 'rejected', 'deduped'], equals: 'attempted' }],
      },
      expect: 'reject',
      expectCodes: ['count_equation_mismatch'],
      why: '接纳 89 与尝试 90 的守恒方程不成立',
    },
    {
      label: 'reject-unexpected-counter-value',
      input: { counts: { planned: 100, attempted: 90 }, expected: { planned: 100, attempted: 100 } },
      expect: 'reject',
      expectCodes: ['unexpected_counter_value'],
      why: '与运行前冻结的期望计数不一致',
    },
    {
      label: 'accept-usage-three-calls-one-missing',
      input: {
        usage: {
          observedCalls: 3,
          reportedCalls: 3,
          callsWithCompleteUsage: 2,
          callsMissingUsage: 1,
          callsCompressed: 1,
          callsRetried: 1,
          reportedComplete: false,
          roles: [
            { role: 'main', calls: 2, tokensKnown: true },
            { role: 'compaction', calls: 1, tokensKnown: false },
          ],
        },
      },
      expect: 'accept',
      why: '3 次调用全部列出，其中 1 次缺用量且明确未完成核算',
    },
    {
      label: 'reject-usage-final-answer-only',
      input: {
        usage: {
          observedCalls: 3,
          reportedCalls: 1,
          callsWithCompleteUsage: 2,
          callsMissingUsage: 1,
          reportedComplete: false,
          roles: [{ role: 'main', calls: 1, tokensKnown: true }],
        },
      },
      expect: 'reject',
      expectCodes: ['call_count_mismatch', 'role_breakdown_mismatch'],
      why: '仅统计最终回答会漏掉压缩与重试调用',
    },
    {
      label: 'reject-usage-missing-zero-filled',
      input: { usage: { observedCalls: 3, reportedCalls: 3, callsWithCompleteUsage: 2, callsMissingUsage: 1, zeroFilledMissing: true, reportedComplete: true } },
      expect: 'reject',
      expectCodes: ['usage_reported_complete_with_missing', 'usage_missing_counted_as_zero'],
      why: '缺失用量被填 0 且声称完整核算',
    },
    {
      label: 'reject-planned-calls-mismatch',
      input: { usage: { observedCalls: 2, reportedCalls: 2, callsWithCompleteUsage: 2, callsMissingUsage: 0, expectedTotalCalls: 3 } },
      expect: 'reject',
      expectCodes: ['planned_calls_mismatch'],
      why: '实际调用数少于运行前冻结的调用上限计划',
    },
    {
      label: 'accept-occurrence-latest-only',
      input: { occurrence: { plannedOccurrences: 3, due: 3, executed: 1, skippedMissed: 2, latestOnlyPolicy: true, expectedExecuted: 1 } },
      expect: 'accept',
      why: '错过 3 个周期，按 latest-only 执行 1 次并显式记录漏过 2 次',
    },
    {
      label: 'reject-occurrence-unaccounted',
      input: { occurrence: { plannedOccurrences: 3, due: 3, executed: 1, latestOnlyPolicy: true } },
      expect: 'reject',
      expectCodes: ['missed_occurrence_silently_dropped'],
      why: '3 个到期周期只执行 1 个且未记录漏过，属于静默丢弃',
    },
    {
      label: 'reject-due-exceeds-plan',
      input: { occurrence: { plannedOccurrences: 2, due: 3, executed: 3, skippedMissed: 0 } },
      expect: 'reject',
      expectCodes: ['due_exceeds_planned'],
      why: '到期数超过冻结计划，分母被改写',
    },
    {
      label: 'accept-quiet-window-zero-calls',
      input: { quiet: { modelCalls: 0, newTasks: 0, newEffects: 0 } },
      expect: 'accept',
      why: '无变化窗口零模型调用、零新任务、零新效果',
    },
    {
      label: 'reject-quiet-window-model-call',
      input: { quiet: { modelCalls: 1, newTasks: 0, newEffects: 0 } },
      expect: 'reject',
      expectCodes: ['silent_period_model_call'],
      why: '无独立到期授权工作时模型调用必须为 0',
    },
    {
      label: 'reject-quiet-window-new-task',
      input: { quiet: { modelCalls: 0, newTasks: 1, newEffects: 0 } },
      expect: 'reject',
      expectCodes: ['silent_period_new_task'],
      why: '噪音不能续命暂停目标或新增任务',
    },
  ],
};
