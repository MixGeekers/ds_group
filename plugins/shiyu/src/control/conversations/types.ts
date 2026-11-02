import type { TrustedPolicyActor } from "../policy/mandates.js";

/** Injected by the host/controller, never read from model or channel arguments. */
export type ConversationActor = TrustedPolicyActor;
export type ConversationPermission = "read" | "manage" | "background" | "reply";
export interface ConversationKey {
  connectionId: string;
  platformConversationId: string;
  threadId?: string;
  kind: "direct" | "group" | "channel";
  /** An audience boundary, not a topic name or transient socket identity. */
  scope: string;
}
export interface ConversationRecord {
  conversationId: string;
  key: ConversationKey;
  revision: number;
  audienceVersion: number;
  conversationGeneration: number;
  archived: boolean;
  lastAudienceChange?: { reasonRef: string; at: string };
  createdAt: string;
  updatedAt: string;
}
export interface BusinessReference { kind: "task" | "goal" | "source"; id: string }
export interface TopicRecord {
  topicId: string;
  scope: string;
  revision: number;
  parentTopicId?: string;
  canonicalTopicId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface TopicRelation {
  relationId: string;
  kind: "branch" | "merge" | "separate";
  scope: string;
  fromTopicId: string;
  toTopicId: string;
  evidenceRefs: string[];
  actorId: string;
  createdAt: string;
}
export interface ReplyBinding {
  bindingId: string;
  conversationId: string;
  topicId?: string;
  scope: string;
  revision: number;
  routingRevision: number;
  contextVersion: number;
  syncedContextVersion: number;
  syncedRoutingRevision: number;
  sessionEpoch: number;
  /** Stable adapter input; changes only when an explicit context reset is required. */
  businessId: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ConversationBindingVersion {
  bindingId: string;
  conversationId: string;
  scope: string;
  audienceVersion: number;
  conversationGeneration: number;
  routingRevision: number;
  sessionEpoch: number;
  contextVersion: number;
}
export interface SourceVersion { reference: BusinessReference; sourceVersion: number }
export interface BackgroundUpdate {
  eventId: string;
  scope: string;
  reference: BusinessReference;
  sourceVersion: number;
  evidenceRef: string;
}
export interface BackgroundReceipt {
  eventId: string;
  scope: string;
  status: "recorded" | "duplicate" | "obsolete";
  affectedBindingIds: string[];
}
export interface PendingBackground {
  contextVersion: number;
  eventId: string;
  reference: BusinessReference;
  sourceVersion: number;
  evidenceRef: string;
  gap: boolean;
}
export interface ContextToken extends ConversationBindingVersion {}
export interface ContextSnapshot {
  token: ContextToken;
  sources: SourceVersion[];
  pending: PendingBackground[];
  needsSync: boolean;
}
export interface ContextAcknowledgement {
  token: ContextToken;
  /** Exactly the reference versions loaded from this snapshot, not the current latest view. */
  sources: SourceVersion[];
}
export interface ReplyDraft {
  draftId: string;
  bindingId: string;
  conversationId: string;
  scope: string;
  token: ContextToken;
  dependencies: SourceVersion[];
  status: "generating" | "ready" | "abandoned";
  /** Object-store reference only; no draft text or native Session events. */
  draftRef?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ConversationStoreOptions {
  ownerIds: string[];
  /** Component IDs and capabilities are trusted installation configuration. */
  componentPermissions: Record<string, ConversationPermission[]>;
  /** The owning business domain decides if this audience may use a reference. */
  authorizeReference(input: { actor: ConversationActor; scope: string; reference: BusinessReference; access: "link" | "read" | "background" }): boolean;
  now?: () => Date;
}
