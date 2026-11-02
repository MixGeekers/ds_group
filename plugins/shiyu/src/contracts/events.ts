/** The caller supplies a trusted host identity, never a model-authored identity. */
export interface EventPrincipal {
  principalId: string;
  kind: "agent" | "component" | "user";
  scopes: string[];
  publishTypes: string[];
  subscribeTypes: string[];
  targetRefs: string[];
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type EventPayload = { [key: string]: JsonValue };
export type PayloadFieldType = "string" | "number" | "boolean" | "null" | "object" | "array";

/** Deliberately bounded schema, not an interpreter for arbitrary JSON Schema/code. */
export interface EventTypeDefinition {
  type: string;
  schemaVersion: number;
  description: string;
  publisherKinds: EventPrincipal["kind"][];
  publisherIds?: string[];
  payloadSchema: {
    properties: Record<string, PayloadFieldType>;
    required: string[];
    additionalProperties: false;
  };
  filterableFields: string[];
}

export interface PublishEventInput {
  type: string;
  scope: string;
  payload: EventPayload;
  idempotencyKey: string;
  correlationId?: string;
  causationId?: string;
  expiresAt?: string;
}

export interface StoredEvent {
  eventId: string;
  sequence: number;
  type: string;
  schemaVersion: number;
  scope: string;
  actor: Pick<EventPrincipal, "principalId" | "kind">;
  payload: EventPayload;
  receivedAt: string;
  correlationId: string;
  causationId?: string;
  expiresAt?: string;
}

export interface PublishReceipt {
  eventId: string;
  sequence: number;
  status: "accepted" | "duplicate";
  receivedAt: string;
  deliveryCount: number;
}

export type SubscriptionTarget =
  | { kind: "component"; handlerRef: string }
  | { kind: "agent"; bindingId: string };
export type DeliveryMode = "component" | "background";
export type SubscriptionStart =
  | { kind: "from_now" }
  | { kind: "replay"; afterSequence: number; limit: number };

export interface SubscribeInput {
  id?: string;
  types: string[];
  scope: string;
  target: SubscriptionTarget;
  deliveryMode: DeliveryMode;
  start: SubscriptionStart;
  filter?: Record<string, JsonPrimitive>;
  once?: boolean;
  expiresAt?: string;
  maxAttempts?: number;
}

export interface StoredSubscription extends Omit<SubscribeInput, "id" | "start"> {
  id: string;
  ownerId: string;
  revision: number;
  ruleRevision: number;
  activationGeneration: number;
  status: "active" | "paused" | "retired";
  startSequence: number;
  createdAt: string;
  updatedAt: string;
  replayedCount: number;
  /** A bounded replay omitted older matching events; callers must surface this gap. */
  replayTruncated: boolean;
}

export interface SubscriptionPatch {
  types?: string[];
  filter?: Record<string, JsonPrimitive>;
  status?: "active" | "paused";
  expiresAt?: string | null;
}

export type DeliveryStatus = "pending" | "claimed" | "acked" | "failed" | "cancelled";
export interface StoredDelivery {
  deliveryId: string;
  eventId: string;
  subscriptionId: string;
  ruleRevision: number;
  activationGeneration: number;
  target: SubscriptionTarget;
  deliveryMode: DeliveryMode;
  status: DeliveryStatus;
  attempts: number;
  availableAt: string;
  claimedBy?: string;
  leaseUntil?: string;
  lastError?: string;
  acknowledgedAt?: string;
}

export interface ClaimedDelivery extends StoredDelivery {
  status: "claimed";
  claimToken: string;
  event: StoredEvent;
}

export interface ClaimInput {
  consumerId: string;
  deliveryMode: DeliveryMode;
  subscriptionId?: string;
  limit?: number;
  leaseMs?: number;
}
export interface AckInput { deliveryId: string; claimToken: string }
export interface FailInput extends AckInput { error: string; retryAfterMs?: number }

export interface StoreInfo {
  sqliteVersion: string;
  journalMode: string;
  journalReason: string;
  synchronous: number;
  foreignKeys: boolean;
  busyTimeoutMs: number;
  workerThreadId: number;
}

export interface EventStats {
  events: number;
  subscriptions: number;
  pending: number;
  claimed: number;
  acknowledged: number;
  failed: number;
  cancelled: number;
}

export class EventServiceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "EventServiceError";
  }
}

export const SHIYU_EVENT_TYPES: EventTypeDefinition[] = [
  {
    type: "agent.observation.reported", schemaVersion: 1,
    description: "An agent reports an observation; this does not establish a verified business fact.",
    publisherKinds: ["agent"],
    payloadSchema: { properties: { message: "string", sourceRef: "string" }, required: ["message"], additionalProperties: false },
    filterableFields: ["sourceRef"],
  },
  {
    type: "component.observation.reported", schemaVersion: 1,
    description: "A registered component reports a scoped observation.",
    publisherKinds: ["component"],
    payloadSchema: { properties: { message: "string", sourceRef: "string" }, required: ["message"], additionalProperties: false },
    filterableFields: ["sourceRef"],
  },
  {
    type: "worker.result.reported", schemaVersion: 1,
    description: "An agent reports a result; TaskService must independently verify completion.",
    publisherKinds: ["agent"],
    payloadSchema: { properties: { taskId: "string", message: "string" }, required: ["taskId", "message"], additionalProperties: false },
    filterableFields: ["taskId"],
  },
  {
    type: "task.succeeded", schemaVersion: 1,
    description: "Reserved for TaskService after verified state commit; publishing never changes Task state.",
    publisherKinds: ["component"], publisherIds: ["task-service"],
    payloadSchema: { properties: { taskId: "string" }, required: ["taskId"], additionalProperties: false },
    filterableFields: ["taskId"],
  },
];
