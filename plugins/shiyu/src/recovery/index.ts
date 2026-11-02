/**
 * H5-B1 offline local-checkpoint / isolated-restore module.
 *
 * Not wired into RuntimeService in this slice: capture and restore are driven
 * by the injected ports in `ports.ts`; the future runtime integration point is
 * the composition that owns the control data root, the native Goal Session
 * service, the memory export adapter and the object store.
 *
 * Boundaries (do not upgrade these without new evidence):
 *  - offline module + synthetic adapters in tests;
 *  - component snapshot vector, never a proven cross-component common section;
 *  - restore only into a fresh isolated root, always maintenance/disarmed;
 *  - no model calls, no live host, no independent backup fault domain, no RPO/
 *    RTO claim (V22/V27 remain open).
 */
export * from './errors.js';
export type * from './types.js';
export * from './ports.js';
export { sealDeletionLedger, IsolatedRestoreService, assertIsolatedTarget } from './restore.js';
export type { RestoreRequest, RestoreResult, RestoreServiceOptions } from './restore.js';
export { CheckpointCaptureService } from './capture.js';
export type { CaptureFaultInjection, CaptureRequest, CaptureServiceOptions, CaptureStage } from './capture.js';
export { verifyBundleDirectory, readBundleManifest, deriveSeqChain } from './verify.js';
export type { BundleCheck, BundleVerification, VerifyBundleOptions } from './verify.js';
export {
  assertValid,
  assertValidActivation,
  assertValidBarrier,
  assertValidBundle,
  assertValidDeletionLedger,
  assertValidGeneration,
  assertValidGenerationIdentity,
  assertValidLastGood,
  assertValidRecoveryLock,
  assertValidRestoreReport,
  assertValidRuntimeManifest,
  assertValidStagingJournal,
  validateActivationRecord,
  validateBackupBundle,
  validateControlComponentManifest,
  validateDeletionLedger,
  validateGenerationIdentityValue,
  validateGenerationTransition,
  validateGoalSessionsComponentManifest,
  validateLastGoodPointer,
  validateMemoryComponentManifest,
  validateRecoveryBarrierEvidence,
  validateRecoveryLockRecord,
  validateRestoreReport,
  validateRuntimeManifestValue,
  validateSharedObjectsComponentManifest,
  validateStagingJournal,
} from './schema.js';
export type { ValidationOptions, ValidationResult, ValidationViolation } from './schema.js';
export { readControlFacts, readControlTombstones, compareControlFacts } from './control-facts.js';
export type { ControlFacts, ControlTombstone } from './control-facts.js';
