import type { EffectAuthorization, EffectClaim, EffectOrigin, EffectState, DispatchVerdict, ClaimRequest } from '../effects/index.js';
import type { TrustedPolicyActor } from '../policy/mandates.js';

export type MemoryOperationState = 'approved' | 'dispatching' | 'applied' | 'unknown' | 'rejected';
export interface MemorySourceRef { sourceId: string; revision: number }
/** References and control facts only; no memory body or backend-native state. */
export interface MemoryOperationInput {
  operationId: string; backendId: string; proposalId: string;
  kind: 'append' | 'update'; commandRef: string; commandDigest: string;
  scope: string; targetRef: string; sourceRefs: MemorySourceRef[]; dependencyRefs: string[];
  expectedComponentVersion?: string; expectedTombstoneWatermark: number;
  origin: EffectOrigin; mandateRef: EffectAuthorization; expiresAt: string;
}
export interface MemoryOperation extends MemoryOperationInput {
  schemaVersion: 1; effectId: string; approvedBy: string; createdAt: string;
  /** Monotonic sum of local revision and the linked Effect revision (minus one). */
  version: number; status: MemoryOperationState; effectState: EffectState;
  /** Permanent deletion barrier; applied is a historical fact, not read permission. */
  blocked: boolean; blockedAtWatermark?: number;
  backendReceiptRef?: string; verificationRef?: string; backendOutcome?: 'applied' | 'rejected';
  nativeId?: string; componentVersion?: string; reasonCode?: string;
}
export type MemoryPolicyVerdict = { allowed: false; reasonCode: string } | {
  allowed: true; authorization: EffectAuthorization;
  /** Recheck source scope, revision and consent. Cross-scope references are unsupported. */
  sourcesVerified: boolean;
  /** All dependency references belong to this exact scope and are available now. */
  dependenciesVerified: boolean;
  observedComponentVersion: string | null;
  /** True only for a separately verified backend atomic conditional-write protocol. */
  atomicVersionCheck: boolean;
};
export type MemoryApprover = (operation: Readonly<MemoryOperationInput>, actor: Readonly<TrustedPolicyActor>) => MemoryPolicyVerdict;
export type MemoryDispatchVerdict = Extract<DispatchVerdict, { allowed: false }> | (Extract<DispatchVerdict, { allowed: true }> & {
  sourcesVerified: boolean; dependenciesVerified: boolean; observedComponentVersion: string | null; atomicVersionCheck: boolean;
});
export type MemoryDispatchAuthorizer = (operation: Readonly<MemoryOperation>, actor: Readonly<TrustedPolicyActor>) => MemoryDispatchVerdict;
export interface MemoryClaimRequest extends Omit<ClaimRequest, 'effectId'> { operationId: string; expectedVersion: number }
export interface MemoryBackendReceipt {
  receiptId: string; operationId: string; backendId: string; externalOperationId: string;
  commandDigest: string; outcome: 'applied' | 'rejected'; observedAt: string;
  nativeId: string | null; componentVersion: string | null;
  backendReceiptRef: string; verificationRef: string; evidenceRefs: string[];
}
export type MemoryReceiptVerdict = { verified: false; reasonCode: string } | {
  verified: true; operationId: string; backendId: string; externalOperationId: string;
  commandDigest: string; outcome: 'applied' | 'rejected'; installationGeneration: string;
  nativeId: string | null; componentVersion: string | null; sourceRefs: MemorySourceRef[];
  /** This is proof about this whole operation, not HTTP/MCP acceptance or an attempt error. */
  operationSettled: boolean; reconciled: boolean;
  /** Current authorization, provenance and scope allow publishing this result now. */
  publicationAllowed: boolean;
  /** Backend evidence of an atomic comparison, never a local hash observation. */
  atomicCas: { expectedVersion: string; resultVersion: string } | null;
};
/** Local facts produced by an adapter after its I/O, never a network call in this hook. */
export type MemoryReceiptVerifier = (operation: Readonly<MemoryOperation>, receipt: Readonly<MemoryBackendReceipt>) => MemoryReceiptVerdict;
export interface MemoryReceiptRecord extends MemoryBackendReceipt {
  effectId: string; claim: EffectClaim; receivedAt: string;
  mode: 'completion' | 'reconciliation'; published: boolean;
  verification: Extract<MemoryReceiptVerdict, { verified: true }>;
}
export interface MemoryTombstoneInput {
  deletionId: string; scope: string; refs: string[]; expectedWatermark: number; reasonCode: string;
}
export interface MemoryTombstone extends MemoryTombstoneInput { watermark: number; acceptedAt: string; acceptedBy: string }
export interface MemoryLedgerOptions {
  backendIds: string[]; approverIds: string[]; dispatcherIds: string[]; verifierIds: string[]; eraserIds: string[];
  now?: () => Date;
}
export class MemoryOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'MemoryOperationError'; }
}
