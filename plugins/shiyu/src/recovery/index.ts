/**
 * Offline local-checkpoint / isolated-restore module.
 *
 * H5-B1 provides the pure capture/restore engine; H5b adds the Runtime
 * composition adapters in `host-ports.ts` and the owner-only command handler in
 * `runtime-command.ts`. The actual RuntimeService wiring is delivered as a
 * precise integration diff in artifacts/dsh/h5/runtime-checkpoint-capture.diff
 * and is applied by the Lead (this slice does not edit runtime.ts).
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
export {
  HOST_GOAL_SESSION_REQUIRED_SCOPE,
  HOST_MEMORY_REQUIRED_SCOPE,
  HOST_PORT_PROVENANCE,
  computeDataRootId,
  computeWorkspaceRootId,
  createHostControlSourcePort,
  createHostGoalSessionPort,
  createHostMemoryExportPort,
  createHostWorkspaceObjectPort,
  createRuntimeCheckpointComposition,
  detectSessionPersistenceLogResolver,
  newCheckpointSnapshotId,
  summarizeCaptureResult,
} from './host-ports.js';
export type {
  ControlStoreRequestPort,
  HostCheckpointAvailability,
  HostCheckpointCompositionOptions,
  HostComponentAvailability,
  HostControlFactsPreview,
  HostControlSourceOptions,
  HostGoalSessionLog,
  HostGoalSessionResolver,
  HostGoalSessionSourceOptions,
  HostMemoryExportOptions,
  HostNativeGoalState,
  HostProjectionExport,
  HostWorkspaceObjectOptions,
  HostWorkspaceObjectPort,
  RuntimeCheckpointComposition,
} from './host-ports.js';
export { RuntimeCheckpointCommand, RuntimeCheckpointProbeCommand } from './runtime-command.js';
export type {
  RuntimeCheckpointCommandDeps,
  RuntimeCheckpointCommandResult,
  RuntimeCheckpointComponentState,
  RuntimeCheckpointProbeDeps,
} from './runtime-command.js';
export {
  CHECKPOINT_PROBE_REASON_CODES,
  probeCheckpointAvailability,
  validateCheckpointProbeResult,
} from './checkpoint-probe.js';
export type {
  CheckpointProbeControlStore,
  CheckpointProbeGoalSeams,
  CheckpointProbeOptions,
  CheckpointProbeValidation,
  CheckpointProbeViolation,
} from './checkpoint-probe.js';
