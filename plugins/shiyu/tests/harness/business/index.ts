/**
 * H0c business skeleton barrel.
 *
 * `BUSINESS_SELF_PROOFS` are executed by `tests/harness-business.test.ts` with
 * the same self-proof framework as H0b (`runSelfProof`, known-accept +
 * known-reject). They are kept separate from `ALL_SELF_PROOFS` so the H0b
 * oracle catalogue/version semantics stay stable.
 */
import type { OracleSelfProof } from '../invariant.js';
import { catalogSelfProof } from './catalog.js';
import { fixtureIsolationSelfProof } from './fixtures.js';
import { fourClassAnswersSelfProof, answerProvenanceSelfProof } from './answers.js';
import { aggregationSelfProof } from './scoring.js';
import { splitPolicySelfProof } from './splits.js';
import { coverageSelfProof } from './coverage.js';

export * from './types.js';
export * from './catalog.js';
export * from './fixtures.js';
export * from './answers.js';
export * from './scoring.js';
export * from './splits.js';
export * from './coverage.js';

export const BUSINESS_ORACLE_TEST_PREFIX = 'business-oracle:';

export function businessOracleTestName(oracle: string): string {
  return `${BUSINESS_ORACLE_TEST_PREFIX}${oracle}`;
}

export const BUSINESS_SELF_PROOFS: readonly OracleSelfProof[] = [
  catalogSelfProof as OracleSelfProof,
  fixtureIsolationSelfProof as OracleSelfProof,
  fourClassAnswersSelfProof as OracleSelfProof,
  answerProvenanceSelfProof as OracleSelfProof,
  aggregationSelfProof as OracleSelfProof,
  splitPolicySelfProof as OracleSelfProof,
  coverageSelfProof as OracleSelfProof,
];

export const BUSINESS_TEST_IDS: readonly string[] = [
  ...BUSINESS_SELF_PROOFS.map(proof => businessOracleTestName(proof.name)),
  'business:fixture-determinism',
  'business:answers-independent-of-seed',
  'business:isolation-and-driver-boundary',
  'business:no-product-or-lab-imports',
  'business:coverage-index',
  'business:aggregation-honesty',
  'business:cli-artifacts',
  'business:docs-contract',
];

export const H0C_REQUIRED_ZERO_REMOTE: Readonly<Record<string, number>> = {
  modelCalls: 0,
  embeddingCalls: 0,
  labRooms: 0,
  hostCalls: 0,
  channelSends: 0,
};
