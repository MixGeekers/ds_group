/**
 * Version-domain oracle.
 *
 * The handoff documents (01 §1, 02 §4.3, plan §7) insist that
 * authority / epoch / generation / entity version / commitSeq / stateVersion
 * / native seq are different facts and must not be collapsed into one
 * "version". This oracle:
 * - checks per-field transitions against frozen read-only / mutation rules;
 * - detects missing or unknown version domains (unknown is not 0);
 * - rejects unsupported "single global version" claims crossing authorities.
 *
 * Boundary: it judges declared version fields and transition rules. It
 * cannot prove two backends were read atomically; a global-snapshot claim is
 * rejected as unsupported rather than silently accepted.
 */
import type { CheckResult, JsonValue, OracleSelfProof, Violation } from './invariant.js';
import { finish, jsonPointerChild, violation } from './invariant.js';

const ORACLE = 'version'; // version-domain transitions; not the harness version constants
const VERSION = '1.1.0';
const BOUNDARY =
  '判定各版本域按冻结规则变化（read-only 不得推进、任务进度不得推进 stateVersion、gen 变化不等于换 Session 等），' +
  '缺失/未知版本域显式标记，跨权威“单一全局版本”声明拒绝。不证明跨后端原子快照，也不能替代各权威自身一致性检查。';

export type VersionValue = number | string | null | undefined;
export type VersionSnapshot = Readonly<Record<string, VersionValue>>;
export type VersionExpectation = 'unchanged' | 'increase' | 'decrease' | 'non_decreasing' | 'any';

export interface VersionRule {
  readonly field: string;
  readonly expectation: VersionExpectation;
  readonly why?: string;
}

export interface VersionTransitionInput {
  readonly before: VersionSnapshot;
  readonly after: VersionSnapshot;
  readonly rules: readonly VersionRule[];
}

function comparable(value: VersionValue): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

export function checkVersionTransitions(input: VersionTransitionInput): CheckResult {
  const violations: Violation[] = [];
  input.rules.forEach((rule, index) => {
    const path = jsonPointerChild('$["rules"]', index);
    const before = input.before[rule.field];
    const after = input.after[rule.field];
    if (before === undefined || after === undefined) {
      violations.push(violation('missing_version_field', jsonPointerChild(path, rule.field), `version field ${rule.field} is absent from one or both snapshots`));
      return;
    }
    if (before === null || after === null) {
      violations.push(violation('version_unknown', jsonPointerChild(path, rule.field), `version field ${rule.field} is explicitly unknown; transition is not decidable`));
      return;
    }
    if (rule.expectation === 'any') return;
    const beforeNumber = comparable(before);
    const afterNumber = comparable(after);
    if (beforeNumber === undefined || afterNumber === undefined) {
      if (rule.expectation === 'unchanged') {
        if (before !== after) {
          violations.push(violation('unexpected_version_change', jsonPointerChild(path, rule.field), `${rule.field} changed ${String(before)} -> ${String(after)} but must stay unchanged`, { field: rule.field, before, after }));
        }
      } else {
        violations.push(violation('non_numeric_version', jsonPointerChild(path, rule.field), `${rule.field} is not numeric; ${rule.expectation} is not decidable`));
      }
      return;
    }
    switch (rule.expectation) {
      case 'unchanged':
        if (afterNumber !== beforeNumber) {
          violations.push(
            violation('unexpected_version_change', jsonPointerChild(path, rule.field), `${rule.field} changed ${beforeNumber} -> ${afterNumber} but must stay unchanged`, {
              field: rule.field,
              before: beforeNumber,
              after: afterNumber,
            }),
          );
        }
        break;
      case 'increase':
        if (afterNumber <= beforeNumber) {
          violations.push(violation('version_not_increased', jsonPointerChild(path, rule.field), `${rule.field} must increase, stayed ${beforeNumber} -> ${afterNumber}`));
        }
        break;
      case 'decrease':
        if (afterNumber >= beforeNumber) {
          violations.push(violation('version_not_decreased', jsonPointerChild(path, rule.field), `${rule.field} must decrease, stayed ${beforeNumber} -> ${afterNumber}`));
        }
        break;
      case 'non_decreasing':
        if (afterNumber < beforeNumber) {
          violations.push(violation('version_decreased', jsonPointerChild(path, rule.field), `${rule.field} decreased ${beforeNumber} -> ${afterNumber}`));
        }
        break;
      default:
        violations.push(violation('unknown_expectation', path, `unknown expectation ${String(rule.expectation)}`));
    }
  });
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'version-transition' }, input.rules.length, violations, {
    rules: input.rules.length,
  });
}

export interface VersionDomain {
  readonly field: string;
  /** Authority/source owning this version, e.g. control-store, native-session, memory-backend. */
  readonly authority: string;
  readonly version: number | string;
}

export interface VersionDomainsInput {
  readonly domains: readonly VersionDomain[];
  readonly claim: 'separate' | 'single-global-version';
  /** Domains the release evidence claims to keep separate (frozen list). */
  readonly knownDomains?: readonly string[];
}

export function checkVersionDomains(input: VersionDomainsInput): CheckResult {
  const violations: Violation[] = [];
  const seenFields = new Set<string>();
  input.domains.forEach((domain, index) => {
    const path = jsonPointerChild('$["domains"]', index);
    if (seenFields.has(domain.field)) {
      violations.push(violation('duplicate_version_domain', path, `duplicate version field ${domain.field}`));
    }
    seenFields.add(domain.field);
    if (domain.authority.trim().length === 0) {
      violations.push(violation('missing_version_authority', path, `version domain ${domain.field} has no authority`));
    }
    if (domain.version === null || domain.version === undefined) {
      violations.push(violation('version_unknown', path, `version domain ${domain.field} is unknown`));
    }
  });
  if (input.claim === 'single-global-version') {
    if (input.domains.length > 1) {
      violations.push(
        violation('unsupported_global_snapshot_claim', '$', 'multiple version domains cannot be presented as one atomic global version', {
          domains: input.domains.map(domain => domain.field),
        }),
      );
    }
    const authorities = new Set(input.domains.map(domain => domain.authority));
    if (authorities.size > 1) {
      violations.push(violation('global_version_across_authorities', '$', `single version claim spans authorities ${[...authorities].join(',')}`));
    }
  } else {
    for (const expectedField of input.knownDomains ?? []) {
      if (!seenFields.has(expectedField)) {
        violations.push(violation('missing_version_domain', '$', `required version domain ${expectedField} is absent`));
      }
    }
    if ((input.knownDomains ?? []).length >= 2 && input.domains.every(domain => ['version', 'revision', 'seq'].includes(domain.field))) {
      violations.push(
        violation('conflated_version_field', '$', 'distinct domains were all reported under one generic version/revision field'),
      );
    }
  }
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'version-domains' }, input.domains.length, violations, {
    claim: input.claim,
    domains: input.domains.map(domain => domain.field),
  });
}

/* --------------------------- self-proof --------------------------- */

const controlBefore = { commitSeq: 280, stateVersion: 5, authorityEpoch: 1, generation: 3, entityVersion: 7, nativeSeq: 42 };
const controlAfterRead = { commitSeq: 280, stateVersion: 5, authorityEpoch: 1, generation: 3, entityVersion: 7, nativeSeq: 42 };

export const versionSelfProof: OracleSelfProof = {
  name: ORACLE,
  version: VERSION,
  module: 'tests/harness/version-domains.ts',
  boundary: BOUNDARY,
  evaluate: input => {
    const candidate = input as { transition?: VersionTransitionInput; domains?: VersionDomainsInput };
    if (candidate.domains !== undefined) return checkVersionDomains(candidate.domains);
    return checkVersionTransitions(candidate.transition!);
  },
  samples: [
    {
      label: 'accept-read-only-refresh-unchanged',
      input: {
        transition: {
          before: controlBefore,
          after: controlAfterRead,
          rules: [
            { field: 'commitSeq', expectation: 'unchanged' },
            { field: 'stateVersion', expectation: 'unchanged' },
            { field: 'authorityEpoch', expectation: 'unchanged' },
            { field: 'generation', expectation: 'unchanged' },
          ],
        },
      },
      expect: 'accept',
      why: '1000 次只读刷新期间所有版本域保持不变',
    },
    {
      label: 'accept-task-progress-changes-entity-not-stateversion',
      input: {
        transition: {
          before: controlBefore,
          after: { ...controlBefore, entityVersion: 8, nativeSeq: 43 },
          rules: [
            { field: 'entityVersion', expectation: 'increase' },
            { field: 'nativeSeq', expectation: 'increase' },
            { field: 'stateVersion', expectation: 'unchanged' },
            { field: 'commitSeq', expectation: 'unchanged' },
          ],
        },
      },
      expect: 'accept',
      why: '任务进度推进实体版本与原生 seq，但不推动内层 stateVersion/commitSeq',
    },
    {
      label: 'accept-generation-change-keeps-session-epoch',
      input: {
        transition: {
          before: controlBefore,
          after: { ...controlBefore, generation: 4 },
          rules: [{ field: 'generation', expectation: 'increase' }, { field: 'authorityEpoch', expectation: 'unchanged' }],
        },
      },
      expect: 'accept',
      why: '草稿代次推进不等于 Session epoch 变化',
    },
    {
      label: 'reject-read-refresh-advances-stateversion',
      input: {
        transition: {
          before: controlBefore,
          after: { ...controlBefore, stateVersion: 6 },
          rules: [{ field: 'stateVersion', expectation: 'unchanged' }],
        },
      },
      expect: 'reject',
      expectCodes: ['unexpected_version_change'],
      why: '只读刷新推进内层 stateVersion 是发布副作用',
    },
    {
      label: 'reject-generation-change-bumps-epoch',
      input: {
        transition: {
          before: controlBefore,
          after: { ...controlBefore, generation: 4, authorityEpoch: 2 },
          rules: [{ field: 'authorityEpoch', expectation: 'unchanged' }],
        },
      },
      expect: 'reject',
      expectCodes: ['unexpected_version_change'],
      why: '普通代次变化不得造成授权 epoch 变化/换 Session',
    },
    {
      label: 'reject-version-decreased',
      input: {
        transition: {
          before: controlBefore,
          after: { ...controlBefore, commitSeq: 279 },
          rules: [{ field: 'commitSeq', expectation: 'non_decreasing' }],
        },
      },
      expect: 'reject',
      expectCodes: ['version_decreased'],
      why: '提交水位回退不可接受',
    },
    {
      label: 'reject-expected-increase-missing',
      input: {
        transition: { before: controlBefore, after: controlBefore, rules: [{ field: 'commitSeq', expectation: 'increase' }] },
      },
      expect: 'reject',
      expectCodes: ['version_not_increased'],
      why: '承诺发生提交但版本未推进',
    },
    {
      label: 'reject-missing-version-field',
      input: {
        transition: { before: { commitSeq: 1 }, after: { commitSeq: 2 }, rules: [{ field: 'stateVersion', expectation: 'unchanged' }] },
      },
      expect: 'reject',
      expectCodes: ['missing_version_field'],
      why: '快照缺少被冻结的版本域，缺失不能当 0',
    },
    {
      label: 'reject-unknown-version-field',
      input: {
        transition: { before: { nativeSeq: null }, after: { nativeSeq: 3 }, rules: [{ field: 'nativeSeq', expectation: 'increase' }] },
      },
      expect: 'reject',
      expectCodes: ['version_unknown'],
      why: '原生 seq 未知时无法判定增加，必须保持未知',
    },
    {
      label: 'accept-separate-version-domains',
      input: {
        domains: {
          claim: 'separate',
          knownDomains: ['commitSeq', 'stateVersion', 'authorityEpoch', 'generation', 'nativeSeq'],
          domains: [
            { field: 'commitSeq', authority: 'control-store', version: 280 },
            { field: 'stateVersion', authority: 'state-publication', version: 5 },
            { field: 'authorityEpoch', authority: 'mandates', version: 1 },
            { field: 'generation', authority: 'runtime', version: 3 },
            { field: 'nativeSeq', authority: 'native-session', version: 42 },
          ],
        },
      },
      expect: 'accept',
      why: '五个版本域各自带权威，分别冻结',
    },
    {
      label: 'reject-global-version-claim',
      input: {
        domains: {
          claim: 'single-global-version',
          domains: [
            { field: 'commitSeq', authority: 'control-store', version: 280 },
            { field: 'stateVersion', authority: 'state-publication', version: 5 },
          ],
        },
      },
      expect: 'reject',
      expectCodes: ['unsupported_global_snapshot_claim', 'global_version_across_authorities'],
      why: '控制库 commitSeq 与内层 stateVersion 被冒充成单一全局版本',
    },
    {
      label: 'reject-missing-required-domain',
      input: {
        domains: {
          claim: 'separate',
          knownDomains: ['commitSeq', 'stateVersion'],
          domains: [{ field: 'commitSeq', authority: 'control-store', version: 1 }],
        },
      },
      expect: 'reject',
      expectCodes: ['missing_version_domain'],
      why: '契约要求分开的版本域缺失',
    },
  ],
};
