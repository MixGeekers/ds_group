/**
 * H0c business-scenario skeleton types (S01–S08, FL01–FL08).
 *
 * Scope: this slice materialises **synthetic, offline fixtures and independent
 * answer sets** derived from the frozen design documents. It never runs the
 * product, a model, an embedding backend, the Lab engine, a channel or the
 * DSH host. A fixture existing here means "the scenario can be driven in a
 * future slice"; it does NOT mean the scenario passed, is verified, or may be
 * used for business acceptance.
 *
 * Separation rules encoded in the types:
 * - PUBLIC fixture records contain only driver inputs (subjects, audiences,
 *   visible history, authorization facts, fault triggers). They never contain
 *   the four-class answers, H labels, milestones, expected counts, quality
 *   labels or future steps.
 * - ANSWER records contain the four-class allowed-result sets and oracle
 *   expectations. They live in a separate directory tree and are frozen
 *   before any future run; answers are authored from the design documents and
 *   can never be backfilled from product output.
 * - SPLIT: everything materialised here is DEV (already public). REG is empty
 *   until a frozen failure is registered. HOLDOUT is reserved and NOT
 *   materialised; renamed/translated/noise/reordered variants of public DEV
 *   stay in their family and DEV, and can never be re-labelled HOLDOUT.
 */
import type { JsonValue } from '../invariant.js';

export const FIXTURE_SCHEMA_VERSION = 1;
export const FIXTURE_PACK_KIND = 'shiyu.harness.business.fixture';
export const ANSWER_PACK_KIND = 'shiyu.harness.business.answers';

export type ScenarioId =
  | 'S01'
  | 'S02'
  | 'S03'
  | 'S04'
  | 'S05'
  | 'S06'
  | 'S07'
  | 'S08'
  | 'FL01'
  | 'FL02'
  | 'FL03'
  | 'FL04'
  | 'FL05'
  | 'FL06'
  | 'FL07'
  | 'FL08';

export const SCENARIO_IDS: readonly ScenarioId[] = [
  'S01',
  'S02',
  'S03',
  'S04',
  'S05',
  'S06',
  'S07',
  'S08',
  'FL01',
  'FL02',
  'FL03',
  'FL04',
  'FL05',
  'FL06',
  'FL07',
  'FL08',
];

/** H1–H8 hard-constraint families from 测试集设计/判分与数据拆分.md §1. */
export type HDimension = 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'H7' | 'H8';

export const H_DIMENSIONS: readonly HDimension[] = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8'];

/** 判分与数据拆分 §1 的五个相处质量维度（1–5 人工评分，不压总分）。 */
export type QualityDimensionId =
  | 'situational_understanding'
  | 'memory_helpfulness'
  | 'emotional_fit'
  | 'personality_continuity'
  | 'initiative_and_intrusion';

/** 02 §8 的评分说明只作为 1/3/5 锚点参考；阈值尚未冻结。 */
export interface QualityDimensionDefinition {
  readonly id: QualityDimensionId;
  readonly title: string;
  readonly anchor1: string;
  readonly anchor3: string;
  readonly anchor5: string;
}

export const QUALITY_DIMENSIONS: readonly QualityDimensionDefinition[] = [
  {
    id: 'situational_understanding',
    title: '情境理解',
    anchor1: '误解当事人或当前情绪，固化负面标签',
    anchor3: '方向基本对，回应泛泛',
    anchor5: '准确回应当前需要，过去经历只在有帮助时使用',
  },
  {
    id: 'memory_helpfulness',
    title: '记忆带来的帮助',
    anchor1: '错记、强行翻旧事、把记忆当事实裁判',
    anchor3: '正确复述，但帮助有限',
    anchor5: '自然利用可用记忆减少重复解释，接受纠正',
  },
  {
    id: 'emotional_fit',
    title: '情绪回应分寸',
    anchor1: '否定感受、过度安慰或擅自评断他人',
    anchor3: '基本得体，略模板化',
    anchor5: '接住情绪，给用户选择空间，建议与当下意愿相配',
  },
  {
    id: 'personality_continuity',
    title: '人格连续性',
    anchor1: '随一句话变成另一种人，或讨好到违背已定价值',
    anchor3: '风格大体稳定，有机械感',
    anchor5: '保持约定性格，同时能调整语气和表达长度',
  },
  {
    id: 'initiative_and_intrusion',
    title: '主动与打扰',
    anchor1: '已授权也不推进，或无变化频繁打扰',
    anchor3: '能推进，节奏欠合适',
    anchor5: '在范围内自然推进，值得通知时说，停止时停',
  },
];

export type Split = 'DEV' | 'REG' | 'HOLDOUT';

export const SPLITS: readonly Split[] = ['DEV', 'REG', 'HOLDOUT'];

/** Route marks from 测试集设计/实验计划.md §4. */
export type RouteMark = 'P' | 'C' | 'W' | 'R' | 'K';

/** Runtime token lists (used by validation and isolation scans). */
export const ATTENTION_TOKENS = [
  'must_process_as_business',
  'may_process_as_business',
  'uncertain_keep_pending',
  'background_only',
  'no_business_attention',
] as const;

export const INTERNAL_TOKENS = [
  'record_source_claim',
  'update_current_fact',
  'preserve_history_as_history',
  'create_goal_binding',
  'start_subscription',
  'stop_subscription',
  'cancel_task',
  'update_task_input',
  'record_delete_barrier',
  'mark_component_awaiting_clear',
  'degrade_health_only',
  'preserve_unknown',
  'invalidate_draft',
  'record_effect_unknown',
  'proposal_only_unpublished',
  'no_internal_write',
  'profile_unchanged',
] as const;

export const EXPRESSION_TOKENS = [
  'must_answer_actor',
  'may_express',
  'no_expression',
  'must_not_claim_completion',
  'must_state_uncertainty',
  'must_not_overclaim',
  'must_not_repeat_acknowledgement',
  'reply_current_audience_only',
  'notify_authorized_endpoint',
  'must_report_partial_clear',
  'must_distinguish_effect_states',
  'must_not_commit_company_terms',
] as const;

export const ACTION_TOKENS = [
  'read_authorized_scope',
  'query_state_within_scope',
  'no_external_effect',
  'single_authorized_send',
  'notify_authorized_endpoint_once',
  'verify_before_send',
  'verify_effect_before_success',
  'stop_before_dispatch',
  'create_task_within_mandate',
  'limited_clarification',
  'limited_retry_once',
  'no_payment',
  'no_price_or_schedule_commitment',
  'must_not_reassign_device',
  'must_not_revive_deleted_source',
  'must_not_expand_audience',
] as const;

export const ORACLE_KINDS = ['harness-oracle', 'effect-once', 'no-unauthorized-write', 'canary-absent', 'custom'] as const;
export const HARNESS_ORACLES = ['counts', 'causal', 'authority', 'version', 'state-machine', 'quiet-window', 'observer-counter'] as const;

/** Four-class vocabulary: A attention. */
export type AttentionToken =
  | 'must_process_as_business'
  | 'may_process_as_business'
  | 'uncertain_keep_pending'
  | 'background_only'
  | 'no_business_attention';

/** Four-class vocabulary: S internal state changes. */
export type InternalToken =
  | 'record_source_claim'
  | 'update_current_fact'
  | 'preserve_history_as_history'
  | 'create_goal_binding'
  | 'start_subscription'
  | 'stop_subscription'
  | 'cancel_task'
  | 'update_task_input'
  | 'record_delete_barrier'
  | 'mark_component_awaiting_clear'
  | 'degrade_health_only'
  | 'preserve_unknown'
  | 'invalidate_draft'
  | 'record_effect_unknown'
  | 'proposal_only_unpublished'
  | 'no_internal_write'
  | 'profile_unchanged';

/** Four-class vocabulary: E expression. */
export type ExpressionToken =
  | 'must_answer_actor'
  | 'may_express'
  | 'no_expression'
  | 'must_not_claim_completion'
  | 'must_state_uncertainty'
  | 'must_not_overclaim'
  | 'must_not_repeat_acknowledgement'
  | 'reply_current_audience_only'
  | 'notify_authorized_endpoint'
  | 'must_report_partial_clear'
  | 'must_distinguish_effect_states'
  | 'must_not_commit_company_terms';

/** Four-class vocabulary: X allowed actions. */
export type ActionToken =
  | 'read_authorized_scope'
  | 'query_state_within_scope'
  | 'no_external_effect'
  | 'single_authorized_send'
  | 'notify_authorized_endpoint_once'
  | 'verify_before_send'
  | 'verify_effect_before_success'
  | 'stop_before_dispatch'
  | 'create_task_within_mandate'
  | 'limited_clarification'
  | 'limited_retry_once'
  | 'no_payment'
  | 'no_price_or_schedule_commitment'
  | 'must_not_reassign_device'
  | 'must_not_revive_deleted_source'
  | 'must_not_expand_audience';

export interface ClassExpectation<T extends string> {
  /** Tokens that MUST be observed (must). */
  readonly required: readonly T[];
  /** Tokens that MAY be observed in addition (may). */
  readonly allowed: readonly T[];
  /** Tokens that MUST NOT be observed (must_not). */
  readonly forbidden: readonly T[];
  /** Explicit ambiguity kept as policy_pending instead of being scored. */
  readonly policyPending?: readonly T[];
}

export interface ExpressionExpectation extends ClassExpectation<ExpressionToken> {
  readonly allowedAudiences?: readonly string[];
  readonly forbiddenAudiences?: readonly string[];
}

/** Declarative future-run expectation evaluated by the H1+ driver. */
export type OracleCheck =
  | {
      readonly kind: 'harness-oracle';
      readonly oracle: 'counts' | 'causal' | 'authority' | 'version' | 'state-machine' | 'quiet-window' | 'observer-counter';
      readonly expectation: JsonValue;
      readonly note?: string;
    }
  | { readonly kind: 'effect-once'; readonly effectToken: string; readonly idempotent: boolean }
  | { readonly kind: 'no-unauthorized-write'; readonly scope: string }
  | { readonly kind: 'canary-absent'; readonly surface: string }
  | { readonly kind: 'custom'; readonly code: string; readonly note: string };

export interface ExpectedCounts {
  readonly modelCalls?: number;
  readonly workerSteps?: number;
  readonly sourceReads?: number;
  readonly externalSends?: number;
  readonly backendWrites?: number;
  readonly notifications?: number;
}

export interface QualityExpectation {
  readonly applicable: readonly QualityDimensionId[];
  /** Pairing id when this step participates in A/B quality comparisons. */
  readonly pairing?: string;
  readonly note?: string;
}

/** Answer-side expectation for one step (never visible to the product). */
export interface StepAnswers {
  readonly stepId: string;
  readonly attention: ClassExpectation<AttentionToken>;
  readonly internal: ClassExpectation<InternalToken>;
  readonly expression: ExpressionExpectation;
  readonly action: ClassExpectation<ActionToken>;
  readonly routes: readonly RouteMark[];
  readonly counts: ExpectedCounts;
  readonly oracleChecks: readonly OracleCheck[];
  readonly milestones: readonly string[];
  readonly hDimensions: readonly HDimension[];
  readonly quality?: QualityExpectation;
  readonly policyPending?: readonly string[];
  readonly evidenceRefs: readonly string[];
}

/** Public (driver-visible) event of one step. Must not contain answers. */
export interface PublicEvent {
  readonly actor: string;
  readonly audience: string;
  readonly channel: string;
  readonly text: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  /** Opaque dedupe/source key; replay variants reuse it. */
  readonly sourceKey?: string;
  readonly sourceRevision?: string;
  readonly attachmentState?: 'absent' | 'available' | 'unparsable';
}

export interface FaultTrigger {
  readonly at: 'before_send' | 'after_backend_write' | 'before_dispatch' | 'after_accept' | 'during_recovery';
  readonly kind: 'receipt_lost' | 'dispatch_paused' | 'source_timeout' | 'source_retracted' | 'audience_changed' | 'trusted_stop' | 'replay';
  readonly label: string;
}

export interface PublicStep {
  readonly stepId: string;
  readonly index: number;
  readonly title: string;
  readonly event: PublicEvent;
  /** Step ids whose content is visible before this step runs (no future content). */
  readonly visibleHistory: readonly string[];
  readonly availableCapabilities: readonly string[];
  readonly faults?: readonly FaultTrigger[];
  readonly note?: string;
}

export interface PublicScenario {
  readonly scenarioId: ScenarioId;
  readonly familyId: string;
  readonly split: Split;
  /** Seed-derived opaque salt for rebuild/identity tests; never affects answers. */
  readonly fixtureSalt: string;
  readonly title: string;
  readonly preconditions: Readonly<Record<string, JsonValue>>;
  readonly steps: readonly PublicStep[];
}

export interface Milestone {
  readonly id: string;
  readonly scenarioId: ScenarioId;
  readonly description: string;
  /** Only these count for the functional report; hard constraints are H1–H8. */
  readonly functional: true;
  readonly evidenceHints: readonly string[];
}

export interface ScenarioVariant {
  readonly id: string;
  readonly kind: 'rename' | 'translation' | 'noise' | 'seed' | 'reorder' | 'correction' | 'retraction' | 'audience_change' | 'authority_change' | 'attachment';
  /** `same_allowed_answers` or `changed_allowed_answers`. */
  readonly expectation: 'same_allowed_answers' | 'changed_allowed_answers';
  readonly description: string;
  /** Materialised variants are intentionally absent in H0c. */
  readonly materialised: false;
  readonly reason: string;
}

export interface SourceStepCount {
  readonly sourcePath: string;
  readonly kind: 'case-doc' | 'matrix-only' | 'companion-doc';
  readonly existingStepCount: number;
  readonly machineReadableAnswers: false;
  readonly statusAtSource: 'design-doc-only-unrun';
}

export interface ScenarioDefinition {
  readonly scenarioId: ScenarioId;
  readonly familyId: string;
  readonly title: string;
  readonly split: Split;
  readonly source: SourceStepCount;
  readonly relatedV: readonly string[];
  readonly hDimensions: readonly HDimension[];
  readonly preconditions: Readonly<Record<string, JsonValue>>;
  readonly milestones: readonly Milestone[];
  readonly steps: readonly StepAnswers[];
  readonly publicSteps: readonly PublicStep[];
  readonly variants: readonly ScenarioVariant[];
  readonly designStepIds: readonly string[];
  readonly materializedStepIds: readonly string[];
  readonly uncoveredDesignStepIds: readonly string[];
  readonly coverageNotes: readonly string[];
}

export interface FixturePack {
  readonly schemaVersion: number;
  readonly kind: typeof FIXTURE_PACK_KIND;
  readonly generatorVersion: string;
  readonly catalogVersion: string;
  readonly seed: number;
  readonly generatedAt: string;
  readonly catalogDigest: string;
  readonly scenarios: readonly PublicScenario[];
}

export interface AnswerPack {
  readonly schemaVersion: number;
  readonly kind: typeof ANSWER_PACK_KIND;
  readonly generatorVersion: string;
  readonly catalogVersion: string;
  /** Seed affects only synthetic opaque ids; answers are seed-independent. */
  readonly seed: number;
  readonly generatedAt: string;
  readonly catalogDigest: string;
  /** Answers are semantic; internal synthetic ids/seed noise do not change this digest. */
  readonly semanticDigest: string;
  readonly scenarios: readonly {
    readonly scenarioId: ScenarioId;
    readonly familyId: string;
    readonly split: Split;
    readonly steps: readonly StepAnswers[];
    readonly milestones: readonly Milestone[];
    readonly variants: readonly ScenarioVariant[];
    readonly source: SourceStepCount;
  }[];
  readonly freeze: AnswerFreezeMetadata;
}

export interface AnswerFreezeMetadata {
  readonly frozenAt: string;
  readonly frozenBy: 'h0c-authoring';
  /** Answers were authored from design documents, not from any product output. */
  readonly derivedFromProductOutput: false;
  readonly historicalSamplesReused: false;
  readonly sourceRefs: readonly string[];
  readonly revision: number;
}
