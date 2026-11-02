/**
 * CAS / single-row version oracle.
 *
 * The oracle replays *observed* attempts against serial compare-and-swap
 * semantics: an attempt is legal only when its expected version equals the
 * version visible before it, and an accepted write must advance the version
 * by exactly one. It then enforces the frozen "exactly one winner" gate.
 *
 * Boundary: it does not perform real concurrency, does not prove storage
 * atomicity and cannot see interleavings the caller did not record. It
 * judges the recording, so a test must capture expectedVersion /
 * accepted / deniedFor / postVersion for every attempt. Cross-row write
 * skew is judged only by the explicit `checkWriteSkew` read/write versions.
 */
import type { CheckResult, JsonValue, OracleSelfProof, Violation } from './invariant.js';
import { finish, jsonPointerChild, violation } from './invariant.js';

const ORACLE = 'cas';
const VERSION = '1.1.0';
const BOUNDARY =
  '按串行 CAS 语义重放观察到的 attempts：expectedVersion 必须等于写入前版本，成功写入必须使版本 +1，' +
  '并按冻结期望核对赢家数（默认恰 1）。不制造真实并发、不证明事务原子性；未记录的尝试无法判定。';

export type DenialReason = 'stale' | 'authority' | 'paused' | 'budget' | 'validation' | 'other';

export interface CasAttempt {
  readonly id: string;
  readonly expectedVersion: number;
  readonly accepted: boolean;
  readonly deniedFor?: DenialReason;
  readonly postVersion?: number;
}

export interface CasRaceInput {
  readonly initialVersion: number;
  readonly attempts: readonly CasAttempt[];
  /** Frozen expected number of accepted writers. Default 1. */
  readonly expectedWinners?: number;
}

export function checkCasRace(input: CasRaceInput): CheckResult {
  const violations: Violation[] = [];
  const expectedWinners = input.expectedWinners ?? 1;
  let version = input.initialVersion;
  const versionsSeen = new Set<number>([input.initialVersion]);
  let acceptedCount = 0;
  let rejectedCount = 0;
  let staleRejections = 0;
  let checked = 1;
  // Phase 1: accepted writes are ordered by their recorded position and must
  // each advance exactly one version from the snapshot they expected.
  for (let index = 0; index < input.attempts.length; index++) {
    const attempt = input.attempts[index];
    const path = jsonPointerChild('$["attempts"]', index);
    checked++;
    if (typeof attempt.expectedVersion !== 'number' || !Number.isSafeInteger(attempt.expectedVersion)) {
      violations.push(violation('attempt_malformed', `${path}["expectedVersion"]`, 'expectedVersion must be a safe integer'));
      continue;
    }
    if (!attempt.accepted) continue;
    acceptedCount++;
    if (attempt.deniedFor !== undefined) {
      violations.push(violation('contradictory_denial', path, 'accepted attempt also declares a denial reason'));
    }
    if (attempt.expectedVersion !== version) {
      violations.push(
        violation('stale_write', path, `accepted write used stale expectedVersion ${attempt.expectedVersion}, current version is ${version}`, {
          attempt: attempt.id,
          expectedVersion: attempt.expectedVersion,
          currentVersion: version,
        }),
      );
      continue;
    }
    if (attempt.postVersion !== version + 1) {
      violations.push(
        violation('version_not_advanced', path, `accepted write must advance ${version} -> ${version + 1}, recorded ${String(attempt.postVersion)}`, {
          attempt: attempt.id,
          expected: version + 1,
          actual: attempt.postVersion ?? null,
        }),
      );
      if (typeof attempt.postVersion === 'number') {
        version = attempt.postVersion;
        versionsSeen.add(version);
      }
      continue;
    }
    version = attempt.postVersion;
    versionsSeen.add(version);
  }
  // Phase 2: a stale denial is consistent when the denied writer expected a
  // version that really existed and was superseded by a recorded winner. A
  // denial "against a future version" is inconsistent.
  for (let index = 0; index < input.attempts.length; index++) {
    const attempt = input.attempts[index];
    const path = jsonPointerChild('$["attempts"]', index);
    if (attempt.accepted) continue;
    rejectedCount++;
    if (attempt.deniedFor === undefined) {
      violations.push(violation('denial_reason_missing', path, 'rejected attempt must declare deniedFor so stale/auth failures stay distinguishable'));
      continue;
    }
    if (attempt.deniedFor !== 'stale') continue;
    staleRejections++;
    if (!versionsSeen.has(attempt.expectedVersion)) {
      violations.push(
        violation('stale_denial_against_unseen_version', path, `stale denial expects version ${attempt.expectedVersion}, which never existed in this race`, {
          attempt: attempt.id,
          expectedVersion: attempt.expectedVersion,
          versionsSeen: [...versionsSeen],
        }),
      );
    }
  }
  if (acceptedCount === 0) {
    violations.push(violation('missing_winner', '$', `expected ${expectedWinners} accepted writer(s), observed 0`));
  } else if (acceptedCount !== expectedWinners) {
    violations.push(
      violation('winner_count_mismatch', '$', `expected ${expectedWinners} accepted writer(s), observed ${acceptedCount}`, {
        expectedWinners,
        acceptedCount,
      }),
    );
  }
  const metrics: Record<string, JsonValue> = {
    attempted: input.attempts.length,
    accepted: acceptedCount,
    rejected: rejectedCount,
    staleRejections,
    finalVersion: version,
  };
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'cas-race' }, checked, violations, metrics);
}

export interface SkewTransaction {
  readonly id: string;
  /** Version of the row set read before deciding to write. */
  readonly readVersion: number;
  /** Version the write asserts after commit. */
  readonly writeVersion: number;
  readonly accepted: boolean;
}

/**
 * Cross-row write-skew detector: a committed transaction must write
 * `readVersion + 1` on the same authoritative row set, otherwise the
 * snapshot it decided on is not the snapshot it committed against.
 */
export function checkWriteSkew(transactions: readonly SkewTransaction[], expectedCommitted?: number): CheckResult {
  const violations: Violation[] = [];
  let committed = 0;
  const acceptedReadVersions = new Map<number, string>();
  transactions.forEach((transaction, index) => {
    const path = jsonPointerChild('$["transactions"]', index);
    if (!transaction.accepted) return;
    committed++;
    if (transaction.writeVersion !== transaction.readVersion + 1) {
      violations.push(
        violation('write_skew_committed', path, `transaction ${transaction.id} read v${transaction.readVersion} but committed v${transaction.writeVersion}`, {
          transaction: transaction.id,
          readVersion: transaction.readVersion,
          writeVersion: transaction.writeVersion,
        }),
      );
    }
    const previous = acceptedReadVersions.get(transaction.readVersion);
    if (previous !== undefined) {
      violations.push(
        violation('write_skew_committed', path, `transactions ${previous} and ${transaction.id} both committed from snapshot v${transaction.readVersion}`, {
          transaction: transaction.id,
          firstTransaction: previous,
          readVersion: transaction.readVersion,
        }),
      );
    } else {
      acceptedReadVersions.set(transaction.readVersion, transaction.id);
    }
  });
  if (expectedCommitted !== undefined && committed !== expectedCommitted) {
    violations.push(violation('committed_count_mismatch', '$', `expected ${expectedCommitted} committed transaction(s), observed ${committed}`));
  }
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'write-skew' }, transactions.length, violations, { committed });
}

/* --------------------------- self-proof --------------------------- */

function race(acceptedIndexes: readonly number[], total = 100, initial = 7): CasRaceInput {
  return {
    initialVersion: initial,
    attempts: Array.from({ length: total }, (_unused, index) => {
      const accepted = acceptedIndexes.includes(index);
      return {
        id: `writer-${index}`,
        expectedVersion: initial,
        accepted,
        deniedFor: accepted ? undefined : 'stale',
        postVersion: accepted ? initial + 1 : undefined,
      } satisfies CasAttempt;
    }),
  };
}

export const casSelfProof: OracleSelfProof = {
  name: ORACLE,
  version: VERSION,
  module: 'tests/harness/cas.ts',
  boundary: BOUNDARY,
  evaluate: input => {
    const { race: raceInput, transactions, expectedCommitted } = input as {
      race?: CasRaceInput;
      transactions?: SkewTransaction[];
      expectedCommitted?: number;
    };
    if (transactions !== undefined) return checkWriteSkew(transactions, expectedCommitted);
    return checkCasRace(raceInput!);
  },
  samples: [
    {
      label: 'accept-100-writers-exactly-one-winner',
      input: { race: race([37]) },
      expect: 'accept',
      why: '100 个同版本竞争仅第 37 个成功并将版本推进到 8，其余以 stale 拒绝',
    },
    {
      label: 'accept-authority-denial-keeps-one-winner',
      input: {
        race: {
          initialVersion: 3,
          attempts: [
            { id: 'a', expectedVersion: 3, accepted: true, postVersion: 4 },
            { id: 'b', expectedVersion: 3, accepted: false, deniedFor: 'authority' },
            { id: 'c', expectedVersion: 3, accepted: false, deniedFor: 'stale' },
          ],
        },
      },
      expect: 'accept',
      why: '合法尝试因授权被拒不改变赢家计数；被拒原因仍可区分',
    },
    {
      label: 'reject-two-winners',
      input: { race: race([4, 9]) },
      expect: 'reject',
      expectCodes: ['winner_count_mismatch'],
      why: '同版本 CAS 出现两个成功写入，必须门失败',
    },
    {
      label: 'reject-stale-write-accepted',
      input: {
        race: {
          initialVersion: 7,
          attempts: [
            { id: 'fresh', expectedVersion: 7, accepted: true, postVersion: 8 },
            { id: 'stale', expectedVersion: 6, accepted: true, postVersion: 9 },
          ],
        },
      },
      expect: 'reject',
      expectCodes: ['stale_write'],
      why: '用旧 expectedVersion 的成功写入即旧结果覆盖当前版本',
    },
    {
      label: 'reject-window-not-advanced',
      input: {
        race: {
          initialVersion: 1,
          attempts: [{ id: 'a', expectedVersion: 1, accepted: true, postVersion: 1 }],
        },
      },
      expect: 'reject',
      expectCodes: ['version_not_advanced'],
      why: '成功写入没有推进版本号',
    },
    {
      label: 'reject-missing-winner',
      input: { race: { initialVersion: 7, attempts: [{ id: 'a', expectedVersion: 6, accepted: false, deniedFor: 'stale' }] } },
      expect: 'reject',
      expectCodes: ['missing_winner'],
      why: '期望有赢家但记录全为拒绝',
    },
    {
      label: 'reject-denial-without-reason',
      input: { race: { initialVersion: 2, attempts: [{ id: 'a', expectedVersion: 2, accepted: false }] } },
      expect: 'reject',
      expectCodes: ['denial_reason_missing'],
      why: '拒绝原因缺失时无法区分过期与授权、暂停等业务原因',
    },
    {
      label: 'reject-stale-denial-against-unseen-version',
      input: { race: { initialVersion: 5, attempts: [{ id: 'winner', expectedVersion: 5, accepted: true, postVersion: 6 }, { id: 'a', expectedVersion: 9, accepted: false, deniedFor: 'stale' }] } },
      expect: 'reject',
      expectCodes: ['stale_denial_against_unseen_version'],
      why: 'stale 拒绝声称期望 v9，但本竞争中从未出现 v9',
    },
    {
      label: 'accept-write-skew-consistent',
      input: httpSkew(),
      expect: 'accept',
      why: '所有提交事务 readVersion+1 === writeVersion',
    },
    {
      label: 'reject-write-skew-committed',
      input: { transactions: [{ id: 't1', readVersion: 3, writeVersion: 4, accepted: true }, { id: 't2', readVersion: 3, writeVersion: 4, accepted: true }, { id: 't3', readVersion: 3, writeVersion: 4, accepted: false }], expectedCommitted: 2 },
      expect: 'reject',
      expectCodes: ['write_skew_committed'],
      why: 't1/t2 都从同一 v3 快照提交 v4，是写偏斜而不是串行 CAS',
    },
  ],
};

function httpSkew(): { transactions: SkewTransaction[]; expectedCommitted: number } {
  return {
    transactions: [
      { id: 't1', readVersion: 0, writeVersion: 1, accepted: true },
      { id: 't2', readVersion: 0, writeVersion: 1, accepted: false },
      { id: 't3', readVersion: 1, writeVersion: 2, accepted: true },
    ],
    expectedCommitted: 2,
  };
}
