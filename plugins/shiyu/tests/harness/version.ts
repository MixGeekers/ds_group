/** Version of the H0 harness tool surface. Bumped when oracle contracts change. */
export const HARNESS_VERSION = '0.1.0';

/**
 * Version of the oracle result contract (`CheckResult`, violation codes,
 * self-proof shape). Independent from HARNESS_VERSION so evidence can
 * state which contract it was produced under.
 */
export const ORACLE_API_VERSION = 1;

/**
 * The exact revision of the self-proof corpus. Manifest generation freezes
 * this value together with SHA256 of the oracle sources; traceability
 * refuses to mark a capability self-proven when the artifact and current
 * sources disagree.
 */
export const SELF_PROOF_CORPUS = 'h0-selfproof-1';
