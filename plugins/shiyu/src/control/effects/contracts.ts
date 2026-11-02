/** Effect facts are distinct from the queue and from a Task's completion. */
export type EffectState = 'pending' | 'dispatching' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
export type ReplayClass = 'idempotent' | 'reconcilable' | 'non_replayable';
export type EffectOrigin =
  | { kind: 'task'; taskId: string; assignmentId: string }
  | { kind: 'dialogue'; conversationId: string; turnId: string; conversationGeneration: number };
export interface EffectAuthorization {
  mandateId: string;
  mandateVersion: number;
  authEpoch: number;
  installationGeneration: string;
}
export interface EffectInput {
  effectId?: string;
  idempotencyKey: string;
  origin: EffectOrigin;
  action: string;
  /** Canonical resource identities from the trusted resource policy, not paths. */
  resourceScopes: string[];
  payloadRef: string;
  payloadHash: string;
  replayClass: ReplayClass;
  authorization: EffectAuthorization;
  expiresAt: string;
  maxAttempts?: number;
}
export interface EffectClaim {
  effectId: string;
  attempt: number;
  claimToken: string;
  ownerId: string;
  hostEpoch: string;
  installationGeneration: string;
  fencingToken: number;
  claimedAt: string;
  leaseExpiresAt: string;
}
export interface EffectRecord extends Omit<EffectInput, 'effectId' | 'maxAttempts'> {
  schemaVersion: 1;
  effectId: string;
  maxAttempts: number;
  status: EffectState;
  version: number;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  currentClaim?: EffectClaim;
  cancelRequestedAt?: string;
  cancelReason?: string;
  reasonCode?: string;
  receiptId?: string;
}
export interface EffectAttempt extends EffectClaim {
  status: 'dispatching' | 'unknown' | 'succeeded' | 'failed';
  reasonCode?: string;
  endedAt?: string;
}
export interface ClaimRequest {
  effectId: string;
  ownerId: string;
  hostEpoch: string;
  installationGeneration: string;
  fencingToken: number;
  leaseMs: number;
}
/** Built by a trusted policy component in the DB Worker, never by model text. */
export type DispatchVerdict =
  | { allowed: false; reasonCode: string }
  | ({ allowed: true; hostEpoch: string; fencingToken: number; conversationGeneration?: number } & EffectAuthorization);
/** Synchronous, local facts only. No model, network or device call in this hook. */
export type DispatchAuthorizer = (effect: Readonly<EffectRecord>) => DispatchVerdict;
export interface EffectReceiptInput {
  receiptId: string;
  serviceId: string;
  externalOperationId: string;
  observedAt: string;
  outcome: 'succeeded' | 'failed';
  payloadHash: string;
  evidenceRefs: string[];
}
export interface EffectReceipt extends EffectReceiptInput {
  effectId: string;
  claim: EffectClaim;
  receivedAt: string;
  mode: 'completion' | 'reconciliation';
  verification: Extract<ReceiptVerdict, { verified: true }>;
}
/** A verified receipt records an effect fact; it never grants dispatch authority. */
export type ReceiptVerdict = { verified: false; reasonCode: string } | {
  verified: true;
  installationGeneration: string;
  serviceId: string;
  externalOperationId: string;
  /** An independent provider/device query is required to reconcile uncertainty. */
  reconciled: boolean;
  /**
   * Whole-operation conclusion for this stable idempotency identity. null means
   * only an individual request/attempt was verified (e.g. a retry HTTP failure),
   * which cannot settle an earlier uncertain effect.
   */
  settledEffect: { idempotencyKey: string; payloadHash: string; outcome: 'succeeded' | 'failed' } | null;
};
export type ReceiptVerifier = (effect: Readonly<EffectRecord>, receipt: Readonly<EffectReceiptInput>) => ReceiptVerdict;

export class EffectError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'EffectError'; }
}
