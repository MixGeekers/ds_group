/**
 * Generic channel-ingress contract (H6a, offline slice).
 *
 * Trusted adapter metadata and untrusted content are structurally separate:
 * every identity used for routing, dedupe, revisions and audience is derived
 * from the inbound envelope (`conversation`, `actor`, `message`, `kind`), never
 * from `content` or any free text. A summary may claim "I am the owner"; that
 * claim stays data and can never become a participant role, scope or right.
 *
 * The domain stores normalized identity metadata plus content digests and
 * trusted references only. Message bodies stay with the channel/native
 * Session; this contract deliberately has no body field and must not grow a
 * second chat-history authority.
 *
 * All commands are trusted Worker composition ports (same host, same SQLite
 * connection owner). They are not model tools and never accept an actor,
 * scope, permission or role from message content.
 */

export type ChannelAudienceMode = 'direct' | 'group' | 'channel';
export type ChannelEventKind = 'message.create' | 'message.edit' | 'message.retract' | 'message.delete';
export type ChannelParticipantKind = 'human' | 'bot' | 'system';
export type ChannelPrivacyClass = 'public' | 'internal' | 'private';
export type ChannelAccountKind = 'bot' | 'service' | 'human';
export type ChannelMessageStatus = 'active' | 'edited' | 'retracted' | 'deleted';
export type ChannelConversationStatus = 'pending' | 'current' | 'revoked';
export type ChannelIntakeStatus = 'accepted' | 'duplicate' | 'stale' | 'rejected';
export type ChannelInvalidationType = 'audience_changed' | 'participant_revoked' | 'conversation_access_revoked' | 'message_deleted';

export interface ChannelPlatformRef {
  /** Platform family, e.g. `synthetic-chat`; declared by the trusted adapter. */
  provider: string;
  /** Deployment/tenant envelope inside the platform namespace. */
  deployment: string;
}

export interface ChannelAccountRef {
  /** Stable opaque account identity inside this source namespace. */
  accountId: string;
  /** Native platform account identifier; evidence only, never used for merging. */
  nativeAccountId: string;
  kind: ChannelAccountKind;
}

/** Adapter capability declaration. A declaration is not a permission grant. */
export interface ChannelCapabilities {
  edit: boolean;
  retract: boolean;
  delete: boolean;
  receipts: boolean;
  idempotentSend: boolean;
}

/** Trusted adapter registration. The connection identity is derived, not asserted. */
export interface ChannelConnectionRegistration {
  sourceNamespace: string;
  platform: ChannelPlatformRef;
  account: ChannelAccountRef;
  capabilities: ChannelCapabilities;
}

export interface ChannelConnectionView {
  connectionId: string;
  sourceNamespace: string;
  platform: ChannelPlatformRef;
  account: ChannelAccountRef;
  capabilities: ChannelCapabilities;
  /** Trusted registration revision; reconnect never grants a new identity. */
  revision: number;
  registeredAt: string;
  updatedAt: string;
}

export interface ChannelConversationInput {
  /** Native conversation/group identity; unique only inside this account. */
  nativeConversationId: string;
  /** Native thread/topic identity when the platform distinguishes it. */
  threadId?: string;
  mode: ChannelAudienceMode;
}

export interface ChannelParticipantInput {
  /** Native participant identity; unique only inside this account. */
  nativeParticipantId: string;
  kind: ChannelParticipantKind;
}

export interface ChannelAttachmentRef {
  /** Trusted object/user reference; the ingress never opens it. */
  ref: string;
  kind: 'file' | 'image' | 'audio' | 'video' | 'other';
  sha256?: string;
  byteLength?: number;
}

/**
 * Untrusted content metadata. Bodies never cross this boundary: `contentHash`
 * is the adapter's digest of the exact native content, `bodyRef` is an opaque
 * trusted reference resolved elsewhere, and `summary` is bounded display text
 * that grants nothing.
 */
export interface ChannelContent {
  contentHash?: string;
  bodyRef?: string;
  summary?: string;
  attachments?: ChannelAttachmentRef[];
}

export interface ChannelInboundEvent {
  /** Native stable event id. When absent the adapter-provided message identity,
   * revision and event kind are composed into a stable source event id. */
  nativeEventId?: string;
  kind: ChannelEventKind;
  message: { nativeMessageId: string; revision: number; occurredAt: string };
  /** Trusted per-conversation source order when the platform supplies it. */
  sequence?: number;
  actor: ChannelParticipantInput;
  privacyClass: ChannelPrivacyClass;
  content: ChannelContent;
  /** Optional trusted explanation reference for retract/delete revisions. */
  reasonRef?: string;
}

export interface ChannelIngestInput {
  connectionId: string;
  conversation: ChannelConversationInput;
  events: ChannelInboundEvent[];
}

export interface ChannelIntakeReceipt {
  status: ChannelIntakeStatus;
  /** Stable dedupe identity: native event id or the composed identity. */
  sourceEventId: string;
  composedSourceEventId: boolean;
  conversationRef: string;
  intakeSeq: number;
  receivedAt: string;
  nativeEventId?: string;
  messageId?: string;
  /** Our monotonic revision count after applying this event. */
  messageRevision?: number;
  nativeRevision?: number;
  reasonCode?: string;
}

export interface ChannelIngestResult {
  results: ChannelIntakeReceipt[];
}

export interface ChannelAudienceParticipant {
  participantRef: string;
  kind: ChannelParticipantKind;
  addedVersion: number;
}

export interface ChannelAudienceRevocation {
  participantRef: string;
  /** Audience version in which the participant stopped being an active member. */
  version: number;
  watermark: number;
  reasonRef: string;
  at: string;
}

export interface ChannelConversationView {
  conversationRef: string;
  connectionId: string;
  sourceNamespace: string;
  accountId: string;
  nativeConversationId: string;
  threadId?: string;
  mode: ChannelAudienceMode;
  /** 0 with `pending` until the trusted adapter supplies membership. */
  audienceVersion: number;
  audienceStatus: ChannelConversationStatus;
  participants: ChannelAudienceParticipant[];
  revokedParticipants: ChannelAudienceRevocation[];
  createdAt: string;
  updatedAt: string;
  lastAudienceChange?: { audienceVersion: number; reasonRef: string; at: string };
}

export interface ChannelParticipantView {
  participantRef: string;
  connectionId: string;
  sourceNamespace: string;
  accountId: string;
  nativeParticipantId: string;
  kind: ChannelParticipantKind;
  firstSeenAt: string;
  /** Stable trusted account tuple for the inner relationship identity map. */
  innerAccount: { connectionId: string; identityNamespace: string; identityType: string; externalSubjectId: string };
}

export interface ChannelMessageMetadata {
  messageId: string;
  conversationRef: string;
  participantRef: string;
  participantKind: ChannelParticipantKind;
  privacyClass: ChannelPrivacyClass;
  status: ChannelMessageStatus;
  /** Our monotonic accepted revision count, starting at 1 on create. */
  revision: number;
  /** Adapter-provided native revision of the current state. */
  nativeRevision: number;
  kind: ChannelEventKind;
  contentHash?: string;
  /** Trusted per-conversation source order when the adapter supplied one. */
  sourceSequence?: number;
  /** True when a trusted body reference exists; the reference is not exposed here. */
  hasBodyRef: boolean;
  summaryBytes: number;
  attachmentCount: number;
  nativeMessageId: string;
  occurredAt: string;
  firstReceivedAt: string;
  updatedAt: string;
  deleted?: {
    kind: 'message.retract' | 'message.delete';
    revision: number;
    nativeRevision: number;
    deletionWatermark: number;
    reasonRef?: string;
    at: string;
  };
}

/** Second-phase read result; only returned after re-validating the capture. */
export interface ChannelContentReference {
  messageId: string;
  revision: number;
  nativeRevision: number;
  contentHash?: string;
  bodyRef?: string;
  summary?: string;
  attachments: ChannelAttachmentRef[];
}

export interface ChannelCapturedAudience {
  captureId: string;
  connectionId: string;
  conversationRef: string;
  mode: ChannelAudienceMode;
  audienceVersion: number;
  audienceStatus: ChannelConversationStatus;
  participants: ChannelAudienceParticipant[];
  /** Metadata-only snapshot. No summary, body reference or attachment reference. */
  messages: ChannelMessageMetadata[];
  truncated: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface ChannelContentReadResult {
  captureId: string;
  conversationRef: string;
  audienceVersion: number;
  content: ChannelContentReference[];
}

export interface ChannelWatermark {
  intakeSeq: number;
  invalidationWatermark: number;
  deletionWatermark: number;
  revocationWatermark: number;
}

export interface ChannelInvalidation {
  watermark: number;
  type: ChannelInvalidationType;
  conversationRef: string;
  connectionId: string;
  audienceVersion: number;
  reasonRef: string;
  at: string;
  messageId?: string;
  participantRef?: string;
}

/** Trusted same-Worker invalidation signal; a synchronous callback only. */
export interface ChannelInvalidationSignal extends ChannelInvalidation {
  /** Participants removed by this audience change (empty for other types). */
  removedParticipants: string[];
}

export interface ChannelDeletion {
  watermark: number;
  conversationRef: string;
  messageId: string;
  /** Our revision count of the terminal revision. */
  messageRevision: number;
  nativeRevision: number;
  kind: 'message.retract' | 'message.delete';
  reasonRef?: string;
  sourceEventId: string;
  at: string;
}

export interface ChannelRevocation {
  watermark: number;
  conversationRef: string;
  participantRef?: string;
  scope: 'participant' | 'conversation';
  audienceVersion: number;
  reasonRef: string;
  at: string;
}

export interface ChannelAudienceChange {
  conversationRef: string;
  previousVersion: number;
  audienceVersion: number;
  previousStatus: ChannelConversationStatus;
  mode: ChannelAudienceMode;
  added: string[];
  removed: string[];
  reasonRef: string;
  invalidationWatermark: number;
  at: string;
}

export interface ChannelSnapshot {
  status: { ready: boolean; schemaVersion: number };
  watermark: ChannelWatermark;
  connections: ChannelConnectionView[];
  conversations: ChannelConversationView[];
}

/**
 * Worker composition ports for the generic channel-ingress ledger.
 *
 * Identity fields are trusted adapter metadata. `content` is data only. The
 * two-phase `captureAudience`/`readContentRefs` pair exposes content references
 * only after re-checking the current audience version, capture snapshot and
 * message revision; no send or model call exists in this domain.
 */
export interface ChannelCommands {
  'channel.status': { input: Record<string, never>; output: { ready: boolean; schemaVersion: number; errorCode?: string } };
  'channel.registerConnection': { input: ChannelConnectionRegistration; output: ChannelConnectionView & { duplicate: boolean } };
  'channel.ensureConversation': {
    input: { connectionId: string; conversation: ChannelConversationInput; reasonRef: string };
    output: ChannelConversationView & { created: boolean };
  };
  'channel.updateAudience': {
    input: { conversationRef: string; participants: ChannelParticipantInput[]; reasonRef: string; expectedAudienceVersion: number };
    output: { conversation: ChannelConversationView; change?: ChannelAudienceChange };
  };
  'channel.revokeAccess': {
    input: { conversationRef: string; scope: 'participant' | 'conversation'; participantRef?: string; reasonRef: string; expectedAudienceVersion: number };
    output: { conversation: ChannelConversationView; revocation: ChannelRevocation };
  };
  'channel.ingest': { input: ChannelIngestInput; output: ChannelIngestResult };
  'channel.getMessage': { input: { messageId: string; expectedAudienceVersion?: number }; output: ChannelMessageMetadata };
  'channel.getParticipant': { input: { participantRef: string }; output: ChannelParticipantView };
  'channel.captureAudience': {
    input: { conversationRef: string; expectedAudienceVersion?: number; limit?: number };
    output: ChannelCapturedAudience;
  };
  'channel.readContentRefs': { input: { captureId: string; messageIds: string[] }; output: ChannelContentReadResult };
  'channel.watermark': { input: Record<string, never>; output: ChannelWatermark };
  'channel.invalidationsAfter': { input: { afterWatermark?: number; limit?: number }; output: ChannelInvalidation[] };
  'channel.deletionsAfter': { input: { afterWatermark?: number; limit?: number }; output: ChannelDeletion[] };
  'channel.revocationsAfter': { input: { afterWatermark?: number; limit?: number }; output: ChannelRevocation[] };
  'channel.snapshot': { input: { connectionId?: string; limit?: number }; output: ChannelSnapshot };
}

export type ChannelDomainRequest = {
  [K in keyof ChannelCommands]: { command: K; args: ChannelCommands[K]['input'] };
}[keyof ChannelCommands];
