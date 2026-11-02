/**
 * H0 harness barrel.
 *
 * `ALL_SELF_PROOFS` is the single machine-readable oracle catalogue used by:
 * - `tests/harness-oracles.test.ts` (executes every sample/scenario),
 * - `scripts/harness/selfproof.mjs` (runs that suite and freezes results),
 * - `tests/harness/manifest.ts` (freezes oracle names/versions into the
 *   run manifest),
 * - `tests/harness/traceability.ts` (only marks an oracle verified when the
 *   self-proof artifact shows the matching test passed).
 */
import type { OracleSelfProof } from './invariant.js';
import { losslessJsonSelfProof, jsonTextSelfProof } from './json.js';
import { schemaSelfProof } from './schema.js';
import { casSelfProof } from './cas.js';
import { stateMachineSelfProof } from './state-machine.js';
import { countsSelfProof } from './counts.js';
import { causalSelfProof } from './causal.js';
import { versionSelfProof } from './version-domains.js';
import { authoritySelfProof, canarySelfProof } from './authority.js';
import { deadlineSelfProof, businessClockSelfProof, faultInjectionSelfProof } from './faults.js';
import { observerSelfProof, observerCounterSelfProof } from './observer.js';

export * from './invariant.js';
export * from './json.js';
export * from './schema.js';
export * from './cas.js';
export * from './state-machine.js';
export * from './counts.js';
export * from './causal.js';
export * from './version-domains.js';
export * from './authority.js';
export * from './faults.js';
export * from './observer.js';
export { HARNESS_VERSION, ORACLE_API_VERSION, SELF_PROOF_CORPUS } from './version.js';

export const ALL_SELF_PROOFS: readonly OracleSelfProof[] = [
  losslessJsonSelfProof,
  jsonTextSelfProof,
  schemaSelfProof,
  casSelfProof,
  stateMachineSelfProof,
  countsSelfProof,
  causalSelfProof,
  versionSelfProof,
  authoritySelfProof,
  canarySelfProof,
  deadlineSelfProof,
  businessClockSelfProof,
  faultInjectionSelfProof,
  observerSelfProof,
  observerCounterSelfProof,
];

/** Test-name prefix used by the self-proof suite and matched from TAP results. */
export function oracleTestName(oracle: string): string {
  return `oracle:${oracle}`;
}
