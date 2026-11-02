/**
 * Authority / permission oracle and secret-canary scanner.
 *
 * 02 §1 requires a permission oracle; §3.2 requires that an artificially
 * constructed second send, an old-fence overwrite and a cross-audience
 * canary each trip a must-gate. This module supplies the frozen-grant
 * judge (`checkAuthorityAttempts`) and the leak scanner
 * (`checkCanarySurfaces`).
 *
 * Boundary:
 * - Authority: judges subject/action/resource/audience/expiry/revocation/
 *   budget against a frozen grant table. It does not perform real platform
 *   authentication and cannot see credentials; factSource only records
 *   where the control fact came from.
 * - Canary: detects the exact canary substring in the declared surfaces and
 *   fails when an expected surface was never scanned. It does not decode
 *   encodings, search binaries or prove absence in unscanned surfaces.
 */
import type { CheckResult, JsonValue, OracleSelfProof, Violation } from './invariant.js';
import { finish, jsonPointerChild, violation } from './invariant.js';

const ORACLE = 'authority';
const VERSION = '1.1.0';
const BOUNDARY =
  '按冻结授权表核对主体/动作/资源前缀/受众/期限/撤销/预算：未授权动作 allowed、受众越界、过期/撤销授权被用、' +
  '无信任来源的控制动作均为违规；同时要求正常获准动作成功（期望=allow 被误拒也标记）。不替代真实平台鉴权。';

export interface AuthorityGrant {
  readonly id: string;
  readonly subject: string;
  /** Exact action, `*`, or prefix form `message.*`. */
  readonly actions: readonly string[];
  readonly resourcePrefix?: string;
  readonly audiences?: readonly string[];
  readonly notBefore?: string;
  readonly expiresAt?: string;
  readonly budgetRemaining?: number;
  readonly revokedAt?: string;
}

export type AttemptFactSource = 'trusted-control' | 'message-body' | 'model-output' | 'view' | 'unknown';

export interface AuthorityAttempt {
  readonly id: string;
  readonly at: string;
  readonly subject: string;
  readonly action: string;
  readonly resource?: string;
  readonly audience?: string;
  readonly kind?: 'business' | 'control' | 'read';
  readonly factSource?: AttemptFactSource;
  readonly allowed: boolean;
  /** Frozen answer set: what the attempt should have produced. */
  readonly expected?: 'allow' | 'deny';
}

export interface AuthorityInput {
  readonly grants: readonly AuthorityGrant[];
  readonly attempts: readonly AuthorityAttempt[];
}

type MatchFailure = 'none' | 'subject' | 'action' | 'resource' | 'audience' | 'expired' | 'revoked' | 'budget';

interface GrantMatch {
  readonly grant: AuthorityGrant;
  readonly failure: MatchFailure;
}

function matchesAction(grantAction: string, action: string): boolean {
  if (grantAction === action || grantAction === '*') return true;
  if (grantAction.endsWith('.*')) return action.startsWith(grantAction.slice(0, -1));
  return false;
}

function matchGrant(input: AuthorityInput, attempt: AuthorityAttempt): GrantMatch | undefined {
  let best: GrantMatch | undefined;
  const attemptTime = Date.parse(attempt.at);
  for (const grant of input.grants) {
    if (grant.subject !== attempt.subject) continue;
    if (!grant.actions.some(action => matchesAction(action, attempt.action))) continue;
    let failure: MatchFailure = 'none';
    if (grant.resourcePrefix !== undefined) {
      if (attempt.resource === undefined || !attempt.resource.startsWith(grant.resourcePrefix)) failure = 'resource';
    }
    if (failure === 'none' && grant.audiences !== undefined) {
      if (attempt.audience === undefined || !grant.audiences.includes(attempt.audience)) failure = 'audience';
    }
    if (failure === 'none' && grant.revokedAt !== undefined) {
      const revokedAt = Date.parse(grant.revokedAt);
      if (Number.isNaN(revokedAt) || (Number.isNaN(attemptTime) ? true : revokedAt <= attemptTime)) failure = 'revoked';
    }
    if (failure === 'none') {
      if (grant.notBefore !== undefined) {
        const notBefore = Date.parse(grant.notBefore);
        if (!Number.isNaN(notBefore) && !Number.isNaN(attemptTime) && attemptTime < notBefore) failure = 'expired';
      }
      if (failure === 'none' && grant.expiresAt !== undefined) {
        const expiresAt = Date.parse(grant.expiresAt);
        if (!Number.isNaN(expiresAt) && !Number.isNaN(attemptTime) && attemptTime >= expiresAt) failure = 'expired';
      }
    }
    if (failure === 'none' && grant.budgetRemaining !== undefined && grant.budgetRemaining <= 0) failure = 'budget';
    if (failure === 'none') return { grant, failure };
    if (best === undefined) best = { grant, failure };
  }
  return best;
}

export function checkAuthorityAttempts(input: AuthorityInput): CheckResult {
  const violations: Violation[] = [];
  let allowedCount = 0;
  input.attempts.forEach((attempt, index) => {
    const path = jsonPointerChild('$["attempts"]', index);
    const match = matchGrant(input, attempt);
    const authorized = match !== undefined && match.failure === 'none';
    if (attempt.allowed) allowedCount++;
    if (attempt.allowed) {
      if (!authorized) {
        if (match === undefined) {
          violations.push(
            violation('unauthorized_action_allowed', path, `action ${attempt.action} by ${attempt.subject} has no matching grant`, {
              attempt: attempt.id,
              action: attempt.action,
              subject: attempt.subject,
            }),
          );
        } else {
          const codeByFailure: Record<Exclude<MatchFailure, 'none'>, string> = {
            subject: 'unauthorized_action_allowed',
            action: 'unauthorized_action_allowed',
            resource: 'scope_escalation',
            audience: 'audience_scope_escalation',
            expired: 'expired_grant_used',
            revoked: 'revoked_grant_used',
            budget: 'budget_exhausted_allowed',
          };
          violations.push(
            violation(codeByFailure[match.failure as Exclude<MatchFailure, 'none'>], path, `action ${attempt.action} matched grant ${match.grant.id} but failed ${match.failure} check`, {
              attempt: attempt.id,
              grant: match.grant.id,
              failure: match.failure,
            }),
          );
        }
      }
      if (attempt.kind === 'control' && attempt.factSource !== 'trusted-control') {
        violations.push(
          violation('untrusted_control_source_allowed', path, `control action ${attempt.action} was allowed from factSource=${attempt.factSource ?? 'unknown'}`, {
            attempt: attempt.id,
            factSource: attempt.factSource ?? 'unknown',
          }),
        );
      }
    } else if (attempt.expected === 'allow') {
      violations.push(violation('expected_allowed_but_denied', path, `frozen answer set expects allow for ${attempt.id}, observed deny`));
    }
    if (attempt.allowed && attempt.expected === 'deny') {
      violations.push(violation('expected_denied_but_allowed', path, `frozen answer set expects deny for ${attempt.id}, observed allow`));
    }
  });
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'authority' }, input.attempts.length, violations, {
    attempts: input.attempts.length,
    allowed: allowedCount,
    denied: input.attempts.length - allowedCount,
    grants: input.grants.length,
  });
}

/* --------------------------- canary scanner --------------------------- */

const CANARY_ORACLE = 'canary';
const CANARY_VERSION = '1.1.0';
const CANARY_BOUNDARY =
  '检测精确 canary 子串出现在被检表面；要求运行前声明的预期表面确实被扫描（缺失即失败，防“扫描器静默未运行”）；' +
  '相似负对照不得误报；显式标记 may-contain 的授权提交面除外。不解码变形/二进制，不证明未扫描表面无泄漏。';

export interface CanarySurface {
  readonly name: string;
  readonly text: string;
  /** `may-contain` = explicitly allowed surface such as the frozen submit payload. */
  readonly expected?: 'clean' | 'may-contain';
}

export interface CanaryInput {
  readonly canary: string;
  readonly surfaces: readonly CanarySurface[];
  /** Surfaces that the scanner claims to have covered; absence is a failure. */
  readonly expectedSurfaces?: readonly string[];
  /** Similar-but-not-secret strings that must not be reported as leaks. */
  readonly negativeControls?: readonly string[];
}

export function checkCanarySurfaces(input: CanaryInput): CheckResult {
  const violations: Violation[] = [];
  const canary = input.canary;
  if (typeof canary !== 'string' || canary.length < 8) {
    violations.push(violation('canary_definition_invalid', '$.canary', 'canary must be a non-trivial string (>= 8 chars) so scanning is meaningful'));
  }
  for (const control of input.negativeControls ?? []) {
    if (control === canary) violations.push(violation('canary_definition_invalid', '$.negativeControls', 'negative control equals the canary'));
  }
  const present = new Set(input.surfaces.map(surface => surface.name));
  for (const expected of input.expectedSurfaces ?? []) {
    if (!present.has(expected)) {
      violations.push(violation('surface_not_scanned', '$', `expected surface ${expected} was not scanned`));
    }
  }
  let leaked = 0;
  let allowed = 0;
  input.surfaces.forEach((surface, index) => {
    const path = jsonPointerChild('$["surfaces"]', index);
    const contains = typeof canary === 'string' && canary.length > 0 && surface.text.includes(canary);
    if (!contains) return;
    if (surface.expected === 'may-contain') {
      allowed++;
      return;
    }
    leaked++;
    violations.push(violation('secret_canary_leak', path, `canary leaked into surface ${surface.name}`, { surface: surface.name }));
  });
  return finish({ oracle: CANARY_ORACLE, version: CANARY_VERSION, boundary: CANARY_BOUNDARY, scope: 'canary-scan' }, input.surfaces.length, violations, {
    scanCovered: present.size,
    leakedSurfaces: leaked,
    allowedSurfaces: allowed,
  });
}

/* --------------------------- self-proof --------------------------- */

const canary = 'SYN-CANARY-7f3a9c';

export const canarySelfProof: OracleSelfProof = {
  name: CANARY_ORACLE,
  version: CANARY_VERSION,
  module: 'tests/harness/authority.ts',
  boundary: CANARY_BOUNDARY,
  evaluate: input => {
    const candidate = input as { canary?: CanaryInput };
    return checkCanarySurfaces(candidate.canary!);
  },
  samples: [
    {
      label: 'accept-clean-surfaces',
      input: {
        canary: {
          canary,
          expectedSurfaces: ['log', 'snapshot', 'model-input'],
          negativeControls: ['SYN-CANARY-0000', 'SYN-CANARY'],
          surfaces: [
            { name: 'log', text: 'request handled; canary-like value SYN-CANARY-0000 is a negative control', expected: 'clean' },
            { name: 'snapshot', text: '{"ability":{"status":"available"}}', expected: 'clean' },
            { name: 'model-input', text: '合成背景，无秘密', expected: 'clean' },
          ],
        },
      },
      expect: 'accept',
      why: '预期表面都被扫描且只有相似词，不被误报',
    },
    {
      label: 'reject-canary-in-log',
      input: {
        canary: {
          canary,
          surfaces: [{ name: 'log', text: `credential=${canary}`, expected: 'clean' }],
        },
      },
      expect: 'reject',
      expectCodes: ['secret_canary_leak'],
      why: 'canary 明文进入普通日志',
    },
    {
      label: 'reject-surface-not-scanned',
      input: {
        canary: {
          canary,
          expectedSurfaces: ['log', 'export'],
          surfaces: [{ name: 'log', text: 'clean', expected: 'clean' }],
        },
      },
      expect: 'reject',
      expectCodes: ['surface_not_scanned'],
      why: '声明要检查导出面但扫描器没有覆盖它，静默未运行即失败',
    },
    {
      label: 'accept-explicit-submit-surface',
      input: {
        canary: {
          canary,
          expectedSurfaces: ['submit-payload', 'log'],
          surfaces: [
            { name: 'submit-payload', text: `targetToken=${canary}`, expected: 'may-contain' },
            { name: 'log', text: 'clean', expected: 'clean' },
          ],
        },
      },
      expect: 'accept',
      why: '显式提交面允许携带 token，但日志面必须干净',
    },
    {
      label: 'reject-weak-canary',
      input: {
        canary: { canary: 'abc', surfaces: [] },
      },
      expect: 'reject',
      expectCodes: ['canary_definition_invalid'],
      why: '过短 canary 使扫描无意义，必须拒绝该证据',
    },
  ],
};


const ownerGrant: AuthorityGrant = {
  id: 'grant-1',
  subject: 'owner',
  actions: ['message.send', 'note.write'],
  resourcePrefix: 'channel-a',
  audiences: ['group-a'],
  notBefore: '2026-11-02T00:00:00.000Z',
  expiresAt: '2026-11-03T00:00:00.000Z',
  budgetRemaining: 5,
};

export const authoritySelfProof: OracleSelfProof = {
  name: ORACLE,
  version: VERSION,
  module: 'tests/harness/authority.ts',
  boundary: BOUNDARY,
  evaluate: input => {
    const candidate = input as { authority?: AuthorityInput };
    return checkAuthorityAttempts(candidate.authority!);
  },
  samples: [
    {
      label: 'accept-authorized-message-send',
      input: {
        authority: {
          grants: [ownerGrant],
          attempts: [
            {
              id: 'a1',
              at: '2026-11-02T10:00:00.000Z',
              subject: 'owner',
              action: 'message.send',
              resource: 'channel-a/group-a',
              audience: 'group-a',
              kind: 'business',
              factSource: 'trusted-control',
              allowed: true,
              expected: 'allow',
            },
          ],
        },
      },
      expect: 'accept',
      why: '主体/动作/资源前缀/受众/期限都匹配的获准发送',
    },
    {
      label: 'accept-expected-deny-out-of-scope',
      input: {
        authority: {
          grants: [ownerGrant],
          attempts: [
            { id: 'a2', at: '2026-11-02T10:00:00.000Z', subject: 'owner', action: 'message.send', resource: 'channel-b/x', audience: 'group-b', allowed: false, expected: 'deny', factSource: 'trusted-control' },
          ],
        },
      },
      expect: 'accept',
      why: '冻结答案集期望拒绝，观察到的确拒绝',
    },
    {
      label: 'reject-unauthorized-action-allowed',
      input: {
        authority: {
          grants: [ownerGrant],
          attempts: [
            { id: 'a3', at: '2026-11-02T10:00:00.000Z', subject: 'owner', action: 'device.command', resource: 'channel-a/group-a', allowed: true, factSource: 'trusted-control' },
          ],
        },
      },
      expect: 'reject',
      expectCodes: ['unauthorized_action_allowed'],
      why: '动作不在授权表内却被执行，零容忍',
    },
    {
      label: 'reject-expired-grant-used',
      input: {
        authority: {
          grants: [ownerGrant],
          attempts: [
            { id: 'a4', at: '2026-11-04T10:00:00.000Z', subject: 'owner', action: 'message.send', resource: 'channel-a/group-a', audience: 'group-a', allowed: true, factSource: 'trusted-control' },
          ],
        },
      },
      expect: 'reject',
      expectCodes: ['expired_grant_used'],
      why: '授权到期后继续使用',
    },
    {
      label: 'reject-revoked-grant-used',
      input: {
        authority: {
          grants: [{ ...ownerGrant, revokedAt: '2026-11-02T09:00:00.000Z' }],
          attempts: [
            { id: 'a5', at: '2026-11-02T10:00:00.000Z', subject: 'owner', action: 'message.send', resource: 'channel-a/group-a', audience: 'group-a', allowed: true, factSource: 'trusted-control' },
          ],
        },
      },
      expect: 'reject',
      expectCodes: ['revoked_grant_used'],
      why: '撤权后继续发送',
    },
    {
      label: 'reject-audience-escalation',
      input: {
        authority: {
          grants: [ownerGrant],
          attempts: [
            { id: 'a6', at: '2026-11-02T10:00:00.000Z', subject: 'owner', action: 'message.send', resource: 'channel-a/group-b', audience: 'group-b', allowed: true, factSource: 'trusted-control' },
          ],
        },
      },
      expect: 'reject',
      expectCodes: ['audience_scope_escalation'],
      why: '授权受众是 group-a，却向 group-b 发送',
    },
    {
      label: 'reject-untrusted-control-source',
      input: {
        authority: {
          grants: [{ id: 'grant-control', subject: 'owner', actions: ['control.pause'] }],
          attempts: [
            { id: 'a7', at: '2026-11-02T10:00:00.000Z', subject: 'owner', action: 'control.pause', kind: 'control', factSource: 'message-body', allowed: true, expected: 'deny' },
          ],
        },
      },
      expect: 'reject',
      expectCodes: ['untrusted_control_source_allowed', 'expected_denied_but_allowed'],
      why: '普通正文冒充控制指令',
    },
    {
      label: 'reject-expected-allow-but-denied',
      input: {
        authority: {
          grants: [ownerGrant],
          attempts: [
            { id: 'a8', at: '2026-11-02T10:00:00.000Z', subject: 'owner', action: 'message.send', resource: 'channel-a/group-a', audience: 'group-a', allowed: false, expected: 'allow', factSource: 'trusted-control' },
          ],
        },
      },
      expect: 'reject',
      expectCodes: ['expected_allowed_but_denied'],
      why: '全拒绝不算隔离成功，获准动作被误拒同样失败',
    },
    {
      label: 'reject-budget-exhausted',
      input: {
        authority: {
          grants: [{ ...ownerGrant, budgetRemaining: 0 }],
          attempts: [
            { id: 'a9', at: '2026-11-02T10:00:00.000Z', subject: 'owner', action: 'message.send', resource: 'channel-a/group-a', audience: 'group-a', allowed: true, factSource: 'trusted-control' },
          ],
        },
      },
      expect: 'reject',
      expectCodes: ['budget_exhausted_allowed'],
      why: '预算耗尽仍执行动作',
    },
    {
      label: 'reject-resource-scope-escalation',
      input: {
        authority: {
          grants: [ownerGrant],
          attempts: [
            { id: 'a10', at: '2026-11-02T10:00:00.000Z', subject: 'owner', action: 'note.write', resource: 'workspace-root/other', audience: 'group-a', allowed: true, factSource: 'trusted-control' },
          ],
        },
      },
      expect: 'reject',
      expectCodes: ['scope_escalation'],
      why: '资源前缀不匹配却写入',
    },
  ],
};
