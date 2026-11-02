import type { Budget, BudgetReservation, PermitRequest } from '../control/policy/mandates.js';
import type { EffectClaim, EffectRecord } from '../control/effects/index.js';

export interface LabChannelApproval { channelId: string; kind: 'direct' | 'group'; membersDigest: string }
export interface LabInputRef { eventId: string; channelId: string; actorId: string; type: string; seq: number; bodyHash: string; bodyBytes: number }
export interface LabConnectInput { requestId: string; runId: string; channels: LabChannelApproval[]; budget: Budget; expiresAt: string }
export interface LabChannel extends LabChannelApproval {
  conversationId: string; inputVersion: number; cursor: number; latestInput?: LabInputRef;
  pendingInputs: LabInputRef[]; lastReplyId?: string;
}
export interface LabConnection {
  connectionId: string; requestId: string; runId: string; version: number; epoch: number;
  status: 'connected' | 'paused' | 'disconnected' | 'needs_reconnect';
  mandateId: string; budget: Budget; expiresAt: string; channels: LabChannel[];
  createdAt: string; updatedAt: string;
}
export interface LabReplyPermit {
  replyId: string; connectionId: string; connectionEpoch: number; channelId: string; inputVersion: number;
  anchorEventId: string; claimToken: string; installationGeneration: string; hostEpoch: string;
  authorization: PermitRequest; leaseExpiresAt: string;
}
export interface LabReply {
  replyId: string; connectionId: string; channelId: string; conversationId: string;
  anchorEventId: string; inputRefs: LabInputRef[]; permit: LabReplyPermit;
  status: 'claimed' | 'accounted' | 'unknown' | 'sent'; reservation: BudgetReservation;
  reasonCode?: string; sendId?: string; createdAt: string;
}
export interface LabSendObservation {
  eventId: string; channelId: string; opId: string; bodyHash: string; observedAt: string;
}
export interface LabSendPlan {
  opId: string; connectionId: string; channelId: string; replyId: string; draftOperationId: string;
  bodyHash: string; bodyBytes: number; conversationGeneration: number;
  effect: EffectRecord; claim?: EffectClaim; reservation: BudgetReservation;
  observation?: LabSendObservation; canReconcile: boolean;
}
export interface LabConnectionDetail extends LabConnection {
  balance: { limits: Budget; spent: Budget; held: Budget; available: Budget };
  replies: LabReply[]; sends: LabSendPlan[];
}
/** Worker commands are trusted composition ports, never automatically public routes. */
export interface LabCommands {
  'lab.connect': { input: LabConnectInput; output: LabConnectionDetail & { duplicate: boolean } };
  'lab.get': { input: { connectionId: string }; output: LabConnectionDetail };
  'lab.snapshot': { input: Record<string, never>; output: LabConnectionDetail[] };
  'lab.ingest': { input: { connectionId: string; events: LabInputRef[] }; output: LabConnectionDetail };
  'lab.claimReply': { input: { connectionId: string; channelId: string }; output: LabReply | undefined };
  'lab.assertReply': { input: { permit: LabReplyPermit }; output: LabReply };
  'lab.recordReplyAccounting': { input: { permit: LabReplyPermit; receiptId: string; complete: boolean; tokens?: number; calls?: number; evidenceRef: string }; output: LabReply };
  'lab.markReplyUnknown': { input: { permit: LabReplyPermit; reasonCode: string }; output: LabReply };
  'lab.prepareSend': { input: { permit: LabReplyPermit; draftOperationId: string; bodyHash: string; bodyBytes: number }; output: LabSendPlan };
  'lab.assertSend': { input: { opId: string; claim: EffectClaim }; output: LabSendPlan };
  /** Admits a pure metadata receipt lookup. Never reissues an act or grants a fresh attempt. */
  'lab.reconcileSend': { input: { opId: string; claim: EffectClaim; expectedVersion?: number }; output: LabSendPlan };
  'lab.recordSendReceipt': { input: { opId: string; claim: EffectClaim; observation: LabSendObservation; reconciliation: boolean }; output: LabSendPlan };
  'lab.markSendUnknown': { input: { opId: string; claim: EffectClaim; reasonCode: string }; output: LabSendPlan };
  'lab.pause': { input: { connectionId: string; expectedVersion?: number }; output: LabConnectionDetail };
  'lab.resume': { input: { connectionId: string; expectedVersion?: number }; output: LabConnectionDetail };
  'lab.disconnect': { input: { connectionId: string; expectedVersion?: number }; output: LabConnectionDetail };
}
export type LabDomainRequest = { [K in keyof LabCommands]: { command: K; args: LabCommands[K]['input'] } }[keyof LabCommands];
