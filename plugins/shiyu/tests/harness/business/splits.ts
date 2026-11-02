/**
 * DEV / REG / HOLDOUT split policy for the H0c skeleton.
 *
 * Frozen rules (判分与数据拆分.md §3, 合成公司与标注约定.md §5):
 * - Every scenario materialised here is already public DEV; it can never be
 *   re-labelled HOLDOUT by renaming, translating, adding noise, re-seeding or
 *   reordering.
 * - Variants of one family stay in the same split as the family.
 * - REG is only created after a frozen failure is registered, with a bug/
 *   source reference; it must not be a renamed copy of a DEV story.
 * - HOLDOUT is **reserved, not materialised**: it requires an independent
 *   author and real permission/process isolation. A directory name is not a
 *   secrecy boundary.
 * - Historical limited samples cannot be upgraded to HOLDOUT or verified.
 */
import type { CheckResult, JsonValue, Violation } from '../invariant.js';
import { finish, violation } from '../invariant.js';
import { ALL_SCENARIOS } from './catalog.js';
import type { ScenarioId, Split } from './types.js';

export const SPLIT_POLICY_VERSION = '1.0.0';

export const SPLIT_RULES: readonly string[] = [
  '本切片所有 S/FL 场景均为公开 DEV；改名/翻译/加噪/换种子/重排不得变成 HOLDOUT',
  '同一 family 的所有变体必须与 family 同属一个集合',
  'REG 只在冻结故事与已修复失败上按来源登记（含 bug 引用），不得由 DEV 改名复制',
  'HOLDOUT 尚未制作：需独立作者、答案先冻结、真实权限与流程隔离；目录名不构成秘密隔离',
  '历史有限样本（phase3h/3i 等）不得升级为 HOLDOUT 或已验证业务证据',
  '同机/同用户目录不是秘密隔离；开发 agent 拥有工作区读取权限时不能自称对 HOLDOUT 盲测',
];

export interface SplitEntry {
  readonly scenarioId: ScenarioId;
  readonly familyId: string;
  readonly split: Split;
  readonly materialized: boolean;
  /** For derived variants: the family they came from. */
  readonly derivedFromFamily?: string;
  /** For REG entries: frozen source/bug reference. */
  readonly frozenSourceRef?: string;
  /** True only for independently-authored holdout stories. */
  readonly independentAuthoring?: boolean;
  /** Marks entries built from historical limited samples. */
  readonly historicalLimitedSample?: boolean;
}

export interface SplitPolicyInput {
  readonly entries: readonly SplitEntry[];
  readonly holdoutState: 'reserved_not_materialised' | 'materialised';
}

export function defaultSplitEntries(): readonly SplitEntry[] {
  return ALL_SCENARIOS.map(scenario => ({
    scenarioId: scenario.scenarioId,
    familyId: scenario.familyId,
    split: scenario.split,
    materialized: scenario.split === 'DEV',
  }));
}

export function defaultSplitPolicy(): SplitPolicyInput {
  return { entries: defaultSplitEntries(), holdoutState: 'reserved_not_materialised' };
}

export function checkSplitPolicy(input: SplitPolicyInput): CheckResult {
  const violations: Violation[] = [];
  const familySplits = new Map<string, Set<Split>>();
  let dev = 0;
  let reg = 0;
  let holdout = 0;
  let holdoutMaterialised = 0;
  for (const entry of input.entries) {
    if (entry.split === 'DEV') dev++;
    if (entry.split === 'REG') reg++;
    if (entry.split === 'HOLDOUT') {
      holdout++;
      if (entry.materialized) holdoutMaterialised++;
    }
    if (entry.historicalLimitedSample === true) {
      violations.push(violation('historical_limited_sample_upgraded', `$["entries"][${JSON.stringify(entry.scenarioId)}]`, 'historical limited sample cannot be part of the frozen business set'));
    }
    if (entry.split === 'HOLDOUT') {
      if (entry.materialized) {
        violations.push(violation('holdout_materialised_without_authoring', `$["entries"][${JSON.stringify(entry.scenarioId)}]`, 'HOLDOUT must not be materialised from public DEV material'));
      }
      if (entry.independentAuthoring !== true) {
        violations.push(violation('holdout_without_independent_author', `$["entries"][${JSON.stringify(entry.scenarioId)}]`, 'HOLDOUT requires an independent author and isolated process'));
      }
      if (entry.derivedFromFamily !== undefined) {
        violations.push(violation('holdout_derived_from_public_family', `$["entries"][${JSON.stringify(entry.scenarioId)}]`, 'a holdout entry derived from a public family is a leak, not a new sample'));
      }
    }
    if (entry.split === 'REG' && (entry.frozenSourceRef === undefined || entry.frozenSourceRef.length === 0)) {
      violations.push(violation('reg_without_frozen_source', `$["entries"][${JSON.stringify(entry.scenarioId)}]`, 'REG entry needs a frozen story/bug reference'));
    }
    const splits = familySplits.get(entry.familyId) ?? new Set<Split>();
    splits.add(entry.split);
    familySplits.set(entry.familyId, splits);
    if (entry.derivedFromFamily !== undefined && entry.derivedFromFamily !== entry.familyId) {
      const origin = input.entries.find(item => item.familyId === entry.derivedFromFamily);
      if (origin === undefined) {
        violations.push(violation('variant_unknown_family', `$["entries"][${JSON.stringify(entry.scenarioId)}]`, `derivedFromFamily ${entry.derivedFromFamily} is unknown`));
      } else if (origin.split !== entry.split) {
        violations.push(
          violation('family_split_across_sets', `$["entries"][${JSON.stringify(entry.scenarioId)}]`, `variant ${entry.scenarioId} (${entry.split}) is in a different split from ${origin.scenarioId} (${origin.split})`),
        );
      }
    }
  }
  for (const [familyId, splits] of familySplits) {
    if (splits.size > 1) violations.push(violation('family_split_across_sets', '$', `family ${familyId} spans splits ${[...splits].join(',')}`));
  }
  if (input.holdoutState === 'materialised' && holdoutMaterialised === 0) {
    violations.push(violation('holdout_state_claim_mismatch', '$["holdoutState"]', 'holdoutState claims materialised but no holdout entry is materialised'));
  }
  if (input.holdoutState === 'reserved_not_materialised' && holdoutMaterialised > 0) {
    violations.push(violation('holdout_state_claim_mismatch', '$["holdoutState"]', 'holdoutState claims reserved but holdout entries are materialised'));
  }
  return finish(
    {
      oracle: 'split-policy',
      version: SPLIT_POLICY_VERSION,
      boundary:
        '判定 DEV/REG/HOLDOUT 拆分：本切片产品场景只能是公开 DEV；REG 需冻结来源；HOLDOUT 必须未物化且独立授权，禁止由公开 DEV 改名/变体伪装；' +
        '历史有限样本不得升级。目录名不是秘密隔离，本判定不证明实际权限隔离。',
      scope: 'split-policy',
    },
    input.entries.length,
    violations,
    { dev, reg, holdout, holdoutMaterialised, holdoutState: input.holdoutState },
  );
}

/* --------------------------- self-proof --------------------------- */

const splitSelfProof = {
  name: 'split-policy',
  version: SPLIT_POLICY_VERSION,
  module: 'tests/harness/business/splits.ts',
  boundary:
    '判定 DEV/REG/HOLDOUT 拆分：本切片产品场景只能是公开 DEV；REG 需冻结来源；HOLDOUT 必须未物化且独立授权，禁止由公开 DEV 改名/变体伪装；' +
    '历史有限样本不得升级。目录名不是秘密隔离，本判定不证明实际权限隔离。',
  evaluate: (input: unknown) => checkSplitPolicy(input as SplitPolicyInput),
  samples: [
    {
      label: 'accept-all-public-dev-with-holdout-reserved',
      input: { entries: defaultSplitEntries(), holdoutState: 'reserved_not_materialised' },
      expect: 'accept' as const,
      why: '16 个场景全部公开 DEV，HOLDOUT 明确未物化',
    },
    {
      label: 'reject-renamed-variant-as-holdout',
      input: {
        entries: [
          { scenarioId: 'S01' as ScenarioId, familyId: 'F-S01', split: 'DEV' as Split, materialized: true },
          { scenarioId: 'FL01' as ScenarioId, familyId: 'F-FL01', split: 'HOLDOUT' as Split, materialized: true, derivedFromFamily: 'F-S01', independentAuthoring: true },
        ],
        holdoutState: 'materialised' as const,
      },
      expect: 'reject' as const,
      expectCodes: ['holdout_materialised_without_authoring', 'holdout_derived_from_public_family'],
      why: '公开 DEV 的改名变体被标成 HOLDOUT 且已物化',
    },
    {
      label: 'reject-family-split-across-sets',
      input: {
        entries: [
          { scenarioId: 'S01' as ScenarioId, familyId: 'F-S01', split: 'DEV' as Split, materialized: true },
          { scenarioId: 'S01' as ScenarioId, familyId: 'F-S01', split: 'REG' as Split, materialized: true, frozenSourceRef: 'bug-1' },
        ],
        holdoutState: 'reserved_not_materialised' as const,
      },
      expect: 'reject' as const,
      expectCodes: ['family_split_across_sets'],
      why: '同一 family 的变体跨了 DEV/REG',
    },
    {
      label: 'reject-historical-sample-upgraded',
      input: {
        entries: [{ scenarioId: 'S01' as ScenarioId, familyId: 'F-S01', split: 'HOLDOUT' as Split, materialized: false, independentAuthoring: true, historicalLimitedSample: true }],
        holdoutState: 'reserved_not_materialised' as const,
      },
      expect: 'reject' as const,
      expectCodes: ['historical_limited_sample_upgraded'],
      why: '历史有限样本被当成保留集',
    },
    {
      label: 'accept-registered-regression',
      input: {
        entries: [
          { scenarioId: 'S01' as ScenarioId, familyId: 'F-S01', split: 'DEV' as Split, materialized: true },
          { scenarioId: 'S03' as ScenarioId, familyId: 'F-S03', split: 'REG' as Split, materialized: true, frozenSourceRef: 'fixed-failure:memory-receipt-unknown' },
        ],
        holdoutState: 'reserved_not_materialised' as const,
      },
      expect: 'accept' as const,
      why: 'REG 条目带冻结失败来源，允许',
    },
  ],
};

export const splitPolicySelfProof = splitSelfProof;
