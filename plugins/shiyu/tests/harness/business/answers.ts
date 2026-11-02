/**
 * Four-class allowed-result oracle + answer provenance / anti-backfill guard.
 *
 * The four classes come from 02 §8 and 合成公司与标注约定.md §3:
 * A（关注）, S（允许的内层变化）, E（是否/向谁表达）, X（允许动作）.
 * A step's answer is a *set* of allowed results: `required` must happen,
 * `allowed` may happen, `forbidden` must not happen. Ambiguities that need a
 * user policy are marked `policy_pending` and can never be scored as pass.
 *
 * The provenance guard implements "答案不可从被测输出回填": answers must be
 * frozen from design documents before the first observation, their semantic
 * digest must be stable, and a candidate answer based on product output is
 * rejected outright.
 */
import { sha256Hex, type CheckResult, type JsonValue, type Violation } from './../invariant.js';
import { canonicalJsonString } from './../json.js';
import { finish, violation } from './../invariant.js';
import type {
  ActionToken,
  AttentionToken,
  ClassExpectation,
  ExpectedCounts,
  ExpressionToken,
  InternalToken,
  StepAnswers,
  AnswerFreezeMetadata,
} from './types.js';

export type ObservationStatus = 'executed' | 'not_run' | 'unknown' | 'skipped' | 'not_applicable';

export interface ObservedStep {
  readonly stepId: string;
  readonly status: ObservationStatus;
  readonly attention?: AttentionToken;
  readonly internal?: readonly InternalToken[];
  readonly expression?: readonly ExpressionToken[];
  readonly audiences?: readonly string[];
  readonly action?: readonly ActionToken[];
  readonly counts?: ExpectedCounts;
}

const ORACLE = 'four-class-answers';
const VERSION = '1.0.0';
const BOUNDARY =
  '按四类允许结果集合判定单步观察：required 必须出现、allowed 之外（且非 required）的动作拒绝、forbidden 出现即失败、' +
  '受众必须在允许集合内、计数与冻结期望一致、policy_pending 不得被计为通过、未执行/未知/跳过不得视为通过。' +
  '不证明语义质量，也不替代独立效果账本。';

function allowedSet<T extends string>(expectation: ClassExpectation<T>): Set<string> {
  return new Set<string>([...expectation.required, ...expectation.allowed]);
}

function checkSetClass<T extends string>(
  label: string,
  expectation: ClassExpectation<T>,
  observed: readonly T[] | undefined,
  path: string,
  violations: Violation[],
): void {
  const allowed = allowedSet(expectation);
  const observedSet = new Set(observed ?? []);
  if (observed === undefined) {
    if (expectation.required.length > 0) {
      violations.push(violation('observation_incomplete', path, `${label} observation is missing but class has required results`));
    }
    return;
  }
  for (const token of observedSet) {
    if (expectation.forbidden.includes(token)) {
      violations.push(violation('forbidden_result_observed', path, `${label} observed forbidden ${token}`));
    } else if (!allowed.has(token)) {
      violations.push(violation('result_not_allowed', path, `${label} observed ${token}, which is neither required nor allowed`));
    }
  }
  for (const required of expectation.required) {
    if (!observedSet.has(required)) {
      violations.push(violation('required_result_missing', path, `${label} required ${required} was not observed`));
    }
  }
}

function compareCounts(expected: ExpectedCounts, observed: ExpectedCounts | undefined, path: string, violations: Violation[]): number {
  let checked = 0;
  const keys = Object.keys(expected) as (keyof ExpectedCounts)[];
  for (const key of keys) {
    checked++;
    const expectedValue = expected[key];
    const observedValue = observed?.[key];
    if (observedValue === undefined) {
      violations.push(violation('count_unobserved', path, `expected ${String(key)}=${String(expectedValue)} was not observed`));
    } else if (observedValue !== expectedValue) {
      violations.push(violation('count_mismatch', path, `${String(key)} expected ${String(expectedValue)}, observed ${String(observedValue)}`));
    }
  }
  return checked;
}

export function checkFourClassCompliance(answers: StepAnswers, observed: ObservedStep): CheckResult {
  const violations: Violation[] = [];
  if (observed.stepId !== answers.stepId) {
    violations.push(violation('step_id_mismatch', '$', `observed ${observed.stepId} vs frozen ${answers.stepId}`));
  }
  if (observed.status !== 'executed') {
    violations.push(
      violation(
        observed.status === 'not_applicable' ? 'not_applicable_cannot_pass' : 'status_not_executed',
        '$.status',
        `observation status ${observed.status} cannot be scored as a pass for the frozen answer`,
      ),
    );
    return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'four-class' }, 1, violations, { status: observed.status });
  }
  let checked = 1;
  // A attention: a single token must be allowed, and one of required when required is non-empty.
  const attentionAllowed = allowedSet(answers.attention);
  if (observed.attention === undefined) {
    violations.push(violation('observation_incomplete', '$.attention', 'attention classification is missing'));
  } else {
    checked++;
    if (answers.attention.forbidden.includes(observed.attention)) {
      violations.push(violation('forbidden_result_observed', '$.attention', `attention ${observed.attention} is forbidden`));
    } else if (!attentionAllowed.has(observed.attention)) {
      violations.push(violation('result_not_allowed', '$.attention', `attention ${observed.attention} is neither required nor allowed`));
    }
    if (answers.attention.required.length > 0 && !answers.attention.required.includes(observed.attention)) {
      violations.push(violation('required_result_missing', '$.attention', `attention must be one of ${answers.attention.required.join(',')}, observed ${observed.attention}`));
    }
  }
  checkSetClass('internal', answers.internal, observed.internal, '$.internal', violations);
  checked += observed.internal?.length ?? 0;
  checkSetClass('expression', answers.expression, observed.expression, '$.expression', violations);
  checked += observed.expression?.length ?? 0;
  checkSetClass('action', answers.action, observed.action, '$.action', violations);
  checked += observed.action?.length ?? 0;
  if (answers.expression.allowedAudiences !== undefined) {
    checked++;
    for (const audience of observed.audiences ?? []) {
      if (!answers.expression.allowedAudiences.includes(audience)) {
        violations.push(violation('audience_not_allowed', '$.audiences', `audience ${audience} is not in the frozen allowed audiences`));
      }
    }
  }
  for (const audience of observed.audiences ?? []) {
    if (answers.expression.forbiddenAudiences?.includes(audience) === true) {
      violations.push(violation('forbidden_audience_observed', '$.audiences', `audience ${audience} is forbidden by the frozen answer`));
    }
  }
  checked += compareCounts(answers.counts, observed.counts, '$.counts', violations);
  const pending = [...(answers.policyPending ?? []), ...(answers.attention.policyPending ?? []), ...(answers.internal.policyPending ?? [])];
  if (pending.length > 0) {
    violations.push(violation('policy_pending_scored_as_pass', '$', `step keeps unfrozen policy choices: ${pending.join(', ')}`));
  }
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'four-class' }, checked, violations, {
    stepId: answers.stepId,
    requiredClasses: {
      attention: answers.attention.required.length,
      internal: answers.internal.required.length,
      expression: answers.expression.required.length,
      action: answers.action.required.length,
    } as JsonValue,
  });
}

/* ------------------------------------------------------------------ */
/* Answer provenance / anti-backfill guard.                            */
/* ------------------------------------------------------------------ */

const PROVENANCE_ORACLE = 'answer-provenance';
const PROVENANCE_VERSION = '1.0.0';
const PROVENANCE_BOUNDARY =
  '判定答案来源与冻结时序：答案必须来自设计文档/作者冻结，不得标记为来自产品输出；必须早于首个观察；' +
  '语义摘要必须与冻结值一致；重复修改必须有版本记录。不能证明作者是否真的没看过输出（需流程隔离），但能拒绝可观察的回填形态。';

export interface AnswerRevisionRecord {
  readonly revision: number;
  readonly changedAt: string;
  readonly reason: string;
  readonly beforeDigest: string;
  readonly afterDigest: string;
}

export interface AnswerFreezeCheckInput {
  readonly freeze: AnswerFreezeMetadata;
  readonly semanticDigest: string;
  readonly expectedSemanticDigest?: string;
  /** ISO time of the first product observation/run, if any. */
  readonly firstObservationAt?: string;
  readonly revisions?: readonly AnswerRevisionRecord[];
}

export function checkAnswerFreeze(input: AnswerFreezeCheckInput): CheckResult {
  const violations: Violation[] = [];
  let checked = 1;
  if (input.freeze.derivedFromProductOutput !== false) {
    violations.push(violation('answer_derived_from_product_output', '$["freeze"]["derivedFromProductOutput"]', 'answers must not be derived from product output'));
  }
  if (input.freeze.historicalSamplesReused !== false) {
    violations.push(violation('historical_sample_reused', '$["freeze"]["historicalSamplesReused"]', 'historical limited samples cannot be reused as frozen answers for this slice'));
  }
  if (input.freeze.sourceRefs.length === 0) {
    violations.push(violation('missing_source_refs', '$["freeze"]["sourceRefs"]', 'answers need design-document source refs'));
  }
  const frozenAt = Date.parse(input.freeze.frozenAt);
  if (Number.isNaN(frozenAt)) {
    violations.push(violation('missing_freeze_time', '$["freeze"]["frozenAt"]', 'frozenAt must be a real timestamp'));
  }
  if (input.firstObservationAt !== undefined) {
    checked++;
    const observedAt = Date.parse(input.firstObservationAt);
    if (Number.isNaN(observedAt)) {
      violations.push(violation('invalid_observation_time', '$.firstObservationAt', 'firstObservationAt must be a real timestamp'));
    } else if (!Number.isNaN(frozenAt) && frozenAt >= observedAt) {
      violations.push(violation('answers_frozen_after_first_observation', '$["freeze"]["frozenAt"]', 'answers were frozen at/after the first observation; treat as backfilled'));
    }
  }
  if (input.expectedSemanticDigest !== undefined) {
    checked++;
    if (input.expectedSemanticDigest !== input.semanticDigest) {
      violations.push(violation('semantic_digest_mismatch', '$.semanticDigest', 'answer semantic digest changed after freeze'));
    }
  }
  const revisions = input.revisions ?? [];
  let previousRevision = 0;
  let previousDigest = input.semanticDigest;
  for (const record of revisions) {
    checked++;
    if (record.revision <= previousRevision) {
      violations.push(violation('answers_revision_nonmonotonic', '$.revisions', `revision ${record.revision} does not follow ${previousRevision}`));
    }
    if (record.afterDigest !== previousDigest) {
      violations.push(violation('answers_mutated_without_revision_record', '$.revisions', `revision ${record.revision} does not chain from the previous digest`));
    }
    previousRevision = record.revision;
    previousDigest = record.beforeDigest;
  }
  if (input.freeze.revision !== revisions.length + 1 && revisions.length > 0) {
    violations.push(violation('answers_revision_mismatch', '$["freeze"]["revision"]', 'freeze revision does not match the revision history'));
  }
  return finish({ oracle: PROVENANCE_ORACLE, version: PROVENANCE_VERSION, boundary: PROVENANCE_BOUNDARY, scope: 'answer-freeze' }, checked, violations, {
    frozenAt: input.freeze.frozenAt,
    revision: input.freeze.revision,
  });
}

export interface AnswerCandidateProvenanceInput {
  readonly source: 'design-doc' | 'fixture-authoring' | 'product-output' | 'model-output' | 'historical-sample' | 'unknown';
  readonly basedOnObservationIds: readonly string[];
  readonly generatedAt: string;
  readonly frozenAt?: string;
}

export function checkAnswerCandidateProvenance(input: AnswerCandidateProvenanceInput): CheckResult {
  const violations: Violation[] = [];
  if (input.source === 'product-output' || input.source === 'model-output') {
    violations.push(violation('answer_candidate_from_product_output', '$.source', `answer candidate source ${input.source} is backfilling`));
  }
  if (input.source === 'unknown') {
    violations.push(violation('answer_candidate_unknown_source', '$.source', 'answer candidate provenance is unknown'));
  }
  if (input.source === 'historical-sample') {
    violations.push(violation('answer_candidate_from_historical_sample', '$.source', 'historical limited sample cannot seed a frozen answer'));
  }
  if (input.basedOnObservationIds.length > 0) {
    violations.push(violation('answer_candidate_uses_observations', '$.basedOnObservationIds', 'answer candidate was authored from observed run outputs'));
  }
  const generatedAt = Date.parse(input.generatedAt);
  if (input.frozenAt !== undefined && !Number.isNaN(generatedAt) && generatedAt > Date.parse(input.frozenAt)) {
    violations.push(violation('answer_candidate_generated_after_freeze', '$.generatedAt', 'candidate was generated after the answer freeze'));
  }
  return finish({ oracle: PROVENANCE_ORACLE, version: PROVENANCE_VERSION, boundary: PROVENANCE_BOUNDARY, scope: 'candidate-provenance' }, 5, violations, {
    source: input.source,
  });
}

/* ------------------------------------------------------------------ */
/* Self-proofs.                                                        */
/* ------------------------------------------------------------------ */

const VALID_ANSWERS: StepAnswers = {
  stepId: 'X.1',
  attention: { required: ['must_process_as_business'], allowed: [], forbidden: ['no_business_attention'] },
  internal: { required: ['update_current_fact'], allowed: ['record_source_claim', 'preserve_history_as_history'], forbidden: ['no_internal_write'] },
  expression: {
    required: ['must_answer_actor'],
    allowed: ['may_express'],
    forbidden: ['must_not_commit_company_terms'],
    allowedAudiences: ['C-priv'],
  },
  action: { required: ['read_authorized_scope'], allowed: ['query_state_within_scope'], forbidden: ['no_payment'] },
  routes: ['C', 'R'],
  counts: { externalSends: 1, backendWrites: 1 },
  oracleChecks: [],
  milestones: [],
  hDimensions: ['H1'],
  evidenceRefs: ['answer:selftest'],
};

function observed(patch: Partial<ObservedStep> = {}): ObservedStep {
  return {
    stepId: 'X.1',
    status: 'executed',
    attention: 'must_process_as_business',
    internal: ['update_current_fact'],
    expression: ['must_answer_actor'],
    audiences: ['C-priv'],
    action: ['read_authorized_scope'],
    counts: { externalSends: 1, backendWrites: 1 },
    ...patch,
  };
}

export const fourClassAnswersSelfProof = {
  name: ORACLE,
  version: VERSION,
  module: 'tests/harness/business/answers.ts',
  boundary: BOUNDARY,
  evaluate: (input: unknown) => {
    const { answers: answerValue, observed: observedValue } = input as { answers: StepAnswers; observed: ObservedStep };
    return checkFourClassCompliance(answerValue, observedValue);
  },
  samples: [
    {
      label: 'accept-required-and-allowed-results',
      input: { answers: VALID_ANSWERS, observed: observed() },
      expect: 'accept' as const,
      why: 'required 出现且允许的附加结果未越界，计数一致',
    },
    {
      label: 'accept-allowed-alternative-strategy',
      input: {
        answers: { ...VALID_ANSWERS, expression: { required: [], allowed: ['may_express', 'no_expression'], forbidden: ['must_not_commit_company_terms'] } },
        observed: observed({ expression: ['no_expression'] }),
      },
      expect: 'accept' as const,
      why: '多个合理策略（表达或静默）都属于允许结果集合，不要求唯一答案',
    },
    {
      label: 'reject-missing-required-attention',
      input: { answers: VALID_ANSWERS, observed: observed({ attention: 'no_business_attention' }) },
      expect: 'reject' as const,
      expectCodes: ['forbidden_result_observed', 'required_result_missing'],
      why: '把业务消息当普通闲聊，违反 required 关注',
    },
    {
      label: 'reject-forbidden-action',
      input: { answers: VALID_ANSWERS, observed: observed({ action: ['read_authorized_scope', 'no_payment'] }) },
      expect: 'reject' as const,
      expectCodes: ['forbidden_result_observed'],
      why: '出现冻结禁止的动作（付款）必须失败',
    },
    {
      label: 'reject-forbidden-expression',
      input: { answers: VALID_ANSWERS, observed: observed({ expression: ['must_not_commit_company_terms'] }) },
      expect: 'reject' as const,
      expectCodes: ['forbidden_result_observed'],
      why: '禁止的公司承诺出现在表达中',
    },
    {
      label: 'reject-not-allowed-action',
      input: { answers: VALID_ANSWERS, observed: observed({ action: ['read_authorized_scope', 'single_authorized_send'] }) },
      expect: 'reject' as const,
      expectCodes: ['result_not_allowed'],
      why: '动作既非 required 也非 allowed',
    },
    {
      label: 'reject-audience-not-allowed',
      input: { answers: VALID_ANSWERS, observed: observed({ audiences: ['C-group'] }) },
      expect: 'reject' as const,
      expectCodes: ['audience_not_allowed'],
      why: '把内容发到了冻结受众之外',
    },
    {
      label: 'reject-count-mismatch',
      input: { answers: VALID_ANSWERS, observed: observed({ counts: { externalSends: 2, backendWrites: 1 } }) },
      expect: 'reject' as const,
      expectCodes: ['count_mismatch'],
      why: '实际发送次数与冻结期望不一致',
    },
    {
      label: 'reject-policy-pending-as-pass',
      input: { answers: { ...VALID_ANSWERS, policyPending: ['auto-save-policy-not-frozen'] }, observed: observed() },
      expect: 'reject' as const,
      expectCodes: ['policy_pending_scored_as_pass'],
      why: '政策未冻结的答案不能当通过',
    },
    {
      label: 'reject-unknown-status',
      input: { answers: VALID_ANSWERS, observed: observed({ status: 'unknown' }) },
      expect: 'reject' as const,
      expectCodes: ['status_not_executed'],
      why: 'unknown/跳过/未运行不能视为通过',
    },
    {
      label: 'reject-missing-required-internal',
      input: { answers: VALID_ANSWERS, observed: observed({ internal: ['record_source_claim'] }) },
      expect: 'reject' as const,
      expectCodes: ['required_result_missing'],
      why: '要求的当前事实更新未发生',
    },
    {
      label: 'reject-missing-count-observation',
      input: { answers: VALID_ANSWERS, observed: observed({ counts: undefined }) },
      expect: 'reject' as const,
      expectCodes: ['count_unobserved'],
      why: '没有独立计数观察时不能默认通过',
    },
  ],
};

const FROZEN_AT = '2026-11-01T00:00:00.000Z';

export const answerProvenanceSelfProof = {
  name: PROVENANCE_ORACLE,
  version: PROVENANCE_VERSION,
  module: 'tests/harness/business/answers.ts',
  boundary: PROVENANCE_BOUNDARY,
  evaluate: (input: unknown) => {
    const candidate = input as { freeze?: AnswerFreezeCheckInput; provenance?: AnswerCandidateProvenanceInput };
    if (candidate.provenance !== undefined) return checkAnswerCandidateProvenance(candidate.provenance);
    return checkAnswerFreeze(candidate.freeze!);
  },
  samples: [
    {
      label: 'accept-frozen-before-observation',
      input: {
        freeze: {
          freeze: { frozenAt: FROZEN_AT, frozenBy: 'h0c-authoring', derivedFromProductOutput: false, historicalSamplesReused: false, sourceRefs: ['doc:S01'], revision: 1 },
          semanticDigest: 'a'.repeat(64),
          expectedSemanticDigest: 'a'.repeat(64),
          firstObservationAt: '2026-11-02T00:00:00.000Z',
        },
      },
      expect: 'accept' as const,
      why: '答案在设计文档阶段冻结，早于首个观察，且语义摘要稳定',
    },
    {
      label: 'accept-authoring-candidate',
      input: { provenance: { source: 'design-doc', basedOnObservationIds: [], generatedAt: FROZEN_AT } },
      expect: 'accept' as const,
      why: '答案候选来自设计文档且不使用观察输出',
    },
    {
      label: 'reject-derived-from-product-output',
      input: {
        freeze: {
          freeze: { frozenAt: FROZEN_AT, frozenBy: 'h0c-authoring', derivedFromProductOutput: true, historicalSamplesReused: false, sourceRefs: ['doc:S01'], revision: 1 },
          semanticDigest: 'a'.repeat(64),
        },
      },
      expect: 'reject' as const,
      expectCodes: ['answer_derived_from_product_output'],
      why: '答案标记为来自产品输出，即回填',
    },
    {
      label: 'reject-frozen-after-observation',
      input: {
        freeze: {
          freeze: { frozenAt: '2026-11-03T00:00:00.000Z', frozenBy: 'h0c-authoring', derivedFromProductOutput: false, historicalSamplesReused: false, sourceRefs: ['doc:S01'], revision: 1 },
          semanticDigest: 'a'.repeat(64),
          firstObservationAt: '2026-11-02T00:00:00.000Z',
        },
      },
      expect: 'reject' as const,
      expectCodes: ['answers_frozen_after_first_observation'],
      why: '先看输出再冻结答案属于回填',
    },
    {
      label: 'reject-candidate-from-product-output',
      input: { provenance: { source: 'product-output', basedOnObservationIds: ['obs-1'], generatedAt: FROZEN_AT } },
      expect: 'reject' as const,
      expectCodes: ['answer_candidate_from_product_output', 'answer_candidate_uses_observations'],
      why: '候选答案引用产品观察，必须拒绝',
    },
    {
      label: 'reject-historical-sample-as-answer',
      input: { provenance: { source: 'historical-sample', basedOnObservationIds: [], generatedAt: FROZEN_AT } },
      expect: 'reject' as const,
      expectCodes: ['answer_candidate_from_historical_sample'],
      why: '历史有限样本不得升级/复用为冻结答案',
    },
    {
      label: 'reject-digest-mismatch',
      input: {
        freeze: {
          freeze: { frozenAt: FROZEN_AT, frozenBy: 'h0c-authoring', derivedFromProductOutput: false, historicalSamplesReused: false, sourceRefs: ['doc:S01'], revision: 1 },
          semanticDigest: 'b'.repeat(64),
          expectedSemanticDigest: 'a'.repeat(64),
        },
      },
      expect: 'reject' as const,
      expectCodes: ['semantic_digest_mismatch'],
      why: '冻结后语义摘要变化必须报告',
    },
  ],
};

/** Digest helper shared by generator/CLI tests. */
export function stepAnswerDigest(answer: StepAnswers): string {
  return sha256Hex(canonicalJsonString(answer as unknown as JsonValue));
}
