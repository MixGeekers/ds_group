import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { parentPort, threadId, workerData } from "node:worker_threads";
import {
  EventServiceError,
  type AckInput, type ClaimedDelivery, type ClaimInput, type EventPayload, type EventPrincipal,
  type EventStats, type EventTypeDefinition, type FailInput, type PublishEventInput,
  type PublishReceipt, type StoredDelivery, type StoredEvent, type StoredSubscription,
  type StoreInfo, type SubscribeInput, type SubscriptionPatch,
} from "../../contracts/events.js";
import type { ControlStoreOptions, StoreRequest, StoreResponse } from "./protocol.js";
import { SqliteTransactions } from './transaction.js';
import { TaskDomain, type TaskDomainRequest } from './task-domain.js';
import { SQLiteGoalBindingStore } from './goal-bindings.js';
import { ConversationDomain, conversationEventPrincipal, type ConversationDomainRequest } from './conversation-domain.js';
import { installCommitWatermark, type CommitWatermarkReader } from './commit-watermark.js';
import { ViewDomain, type ViewDomainRequest } from './view-domain.js';
import { StatePublicationStore, createStatePublisher, initialStateManifest, type StatePublisher } from '../../state/publication.js';
import { LocalReadSafetyStore } from '../../state/safety.js';
import { MemoryDomain, type MemoryDomainRequest } from './memory-domain.js';
import { MemoryIndexDomain, type MemoryIndexRequest } from './memory-index-domain.js';
import { CoreDomain } from './core-domain.js';
import type { CoreDomainRequest } from '../../contracts/core.js';
import { LabDomain } from './lab-domain.js';
import { IngressDomain } from './ingress-domain.js';
import type { ChannelDomainRequest } from '../../contracts/channel.js';
import type { LocalReplyOperation } from './local-reply-domain.js';
import type { LabDomainRequest } from '../../contracts/lab.js';
import { CapabilityDomain } from './capability-domain.js';
import type { CapabilityDomainRequest } from '../../contracts/capability.js';
import { RelationshipDomain, type RelationshipDomainRequest } from './relationship-domain.js';
import { EmotionDomain, type EmotionDomainRequest } from './emotion-domain.js';
import { CognitionDomain, type CognitionDomainRequest } from './cognition-domain.js';
import { PersonalityDomain, type PersonalityDomainRequest } from './personality-domain.js';
import {
  INNER_DOMAINS, INNER_DOMAIN_BACKENDS, type InnerConversationFacts, type InnerDomain,
  type InnerEvidenceFacts, type InnerSourceRef,
} from '../../contracts/inner.js';
import type { InnerDomainAvailability } from '../../state/publication.js';
import { localNoteDefinitionDigest } from '../capability-identity.js';

type Row = Record<string, unknown>;
const port = parentPort;
if (!port) throw new Error("Control store must run in a worker thread.");
const options = workerData as ControlStoreOptions;
const catalog = new Map<string, EventTypeDefinition>();
let db: DatabaseSync;
let info!: StoreInfo;
let transactions!: SqliteTransactions;
let tasks: TaskDomain | undefined;
let goalBindings: SQLiteGoalBindingStore | undefined;
let conversations: ConversationDomain | undefined;
let views: ViewDomain | undefined;
let memories: MemoryDomain | undefined;
let memoryError: string | undefined;
let memoryIndex: MemoryIndexDomain | undefined;
let memoryIndexError: string | undefined;
let core: CoreDomain | undefined;
let coreError: string | undefined;
let ability: CapabilityDomain | undefined;
let abilityError: string | undefined;
let lab: LabDomain | undefined;
let labError: string | undefined;
let ingress: IngressDomain | undefined;
let ingressError: string | undefined;
let relationship: RelationshipDomain | undefined;
let relationshipError: string | undefined;
let emotion: EmotionDomain | undefined;
let emotionError: string | undefined;
let cognition: CognitionDomain | undefined;
let cognitionError: string | undefined;
let personality: PersonalityDomain | undefined;
let personalityError: string | undefined;
let publication: StatePublicationStore | undefined;
let statePublisher: StatePublisher | undefined;
let commitWatermark: CommitWatermarkReader;
const fail = (code: string, message: string): never => { throw new EventServiceError(code, message); };
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function string(value: unknown, name: string, max = 256): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) fail("INVALID_INPUT", `${name} must be a nonempty string of at most ${max} characters.`);
}
function integer(value: unknown, name: string, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail("INVALID_INPUT", `${name} is outside its supported range.`);
}
function strings(value: unknown, name: string, max = 100): asserts value is string[] {
  if (!Array.isArray(value) || value.length > max) fail("INVALID_INPUT", `${name} must be a bounded string list.`);
  for (const entry of value as unknown[]) string(entry, name);
}
function timestamp(value: unknown, name: string): void {
  if (value !== undefined && (typeof value !== "string" || !Number.isFinite(Date.parse(value)))) fail("INVALID_INPUT", `${name} must be an ISO timestamp.`);
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) return fail("INVALID_INPUT", "JSON nesting is too deep.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
  return fail("INVALID_INPUT", "Payload must contain only finite JSON values.");
}
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const rows = (sql: string, ...args: SQLInputValue[]): Row[] => db.prepare(sql).all(...args) as Row[];
const one = (sql: string, ...args: SQLInputValue[]): Row | undefined => db.prepare(sql).get(...args) as Row | undefined;
const run = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args);
const holes = (values: unknown[]) => values.map(() => "?").join(",");
const nowISO = () => new Date().toISOString();
const watermark = () => Number(one("SELECT COALESCE(MAX(sequence), 0) AS value FROM events")!.value);

/** No asynchronous operation or callback enters a SQLite transaction. */
function transaction<T>(operation: () => T): T {
  return transactions.atomic<T>(operation as () => T & (T extends PromiseLike<unknown> ? never : T));
}

function principal(value: EventPrincipal): void {
  if (!isObject(value)) fail("FORBIDDEN", "A trusted principal is required.");
  string(value.principalId, "principalId");
  if (!["agent", "component", "user"].includes(value.kind)) fail("FORBIDDEN", "Invalid principal kind.");
  strings(value.scopes, "scopes"); strings(value.publishTypes, "publishTypes");
  strings(value.subscribeTypes, "subscribeTypes"); strings(value.targetRefs, "targetRefs");
}
function typeDefinition(type: string): EventTypeDefinition {
  return catalog.get(type) ?? fail("UNKNOWN_TYPE", "Event type is not registered.");
}
function canRead(actor: EventPrincipal, event: StoredEvent): boolean {
  return actor.scopes.includes(event.scope) && actor.subscribeTypes.includes(event.type);
}
function scope(actor: EventPrincipal, value: string): void {
  string(value, "scope");
  if (!actor.scopes.includes(value)) fail("FORBIDDEN", "Scope is not granted.");
}
function validatePublish(actor: EventPrincipal, input: PublishEventInput, acceptedRetry = false): EventTypeDefinition {
  principal(actor); scope(actor, input.scope);
  string(input.type, "type"); string(input.idempotencyKey, "idempotencyKey");
  const definition = typeDefinition(input.type);
  if (!actor.publishTypes.includes(input.type) || !definition.publisherKinds.includes(actor.kind)
    || (definition.publisherIds && !definition.publisherIds.includes(actor.principalId))) fail("FORBIDDEN", "This principal cannot publish this event type.");
  if (!isObject(input.payload)) fail("INVALID_PAYLOAD", "Event payload must be an object.");
  const encoded = canonical(input.payload);
  if (Buffer.byteLength(encoded) > 65_536) fail("PAYLOAD_TOO_LARGE", "Event payload exceeds 64 KiB.");
  for (const key of acceptedRetry ? [] : definition.payloadSchema.required) {
    if (!Object.hasOwn(input.payload, key)) fail("INVALID_PAYLOAD", `Missing payload field: ${key}.`);
  }
  for (const [key, value] of acceptedRetry ? [] : Object.entries(input.payload)) {
    if (!Object.hasOwn(definition.payloadSchema.properties, key)) fail("INVALID_PAYLOAD", `Unknown payload field: ${key}.`);
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (actual !== definition.payloadSchema.properties[key]) fail("INVALID_PAYLOAD", `Invalid payload field type: ${key}.`);
  }
  if (input.correlationId !== undefined) string(input.correlationId, "correlationId");
  if (input.causationId !== undefined) {
    string(input.causationId, "causationId");
    const cause = one("SELECT envelope FROM events WHERE event_id = ?", input.causationId);
    if (!cause || !canRead(actor, JSON.parse(String(cause.envelope)))) fail("FORBIDDEN", "Causation event is not visible to this publisher.");
  }
  timestamp(input.expiresAt, "expiresAt");
  return definition;
}

function targetRef(target: SubscribeInput["target"]): string {
  return target.kind === "component" ? target.handlerRef : target.bindingId;
}
function validateSubscription(actor: EventPrincipal, input: SubscribeInput): void {
  principal(actor); scope(actor, input.scope);
  strings(input.types, "types");
  if (input.types.length === 0 || new Set(input.types).size !== input.types.length) fail("INVALID_INPUT", "Subscription types must be nonempty and unique.");
  for (const type of input.types) {
    typeDefinition(type);
    if (!actor.subscribeTypes.includes(type)) fail("FORBIDDEN", "Event type is not granted for subscription.");
  }
  if (!isObject(input.target)) fail("INVALID_INPUT", "A registered target is required.");
  if (input.target.kind === "component") {
    string(input.target.handlerRef, "handlerRef");
    if (input.deliveryMode !== "component" || !options.componentHandlers.includes(input.target.handlerRef)) fail("FORBIDDEN", "Component handler is not registered.");
  } else if (input.target.kind === "agent") {
    string(input.target.bindingId, "bindingId");
    if (input.deliveryMode !== "background") fail("UNSUPPORTED", "This slice supports background Agent delivery only; native Session continuation is not implemented.");
  } else fail("INVALID_INPUT", "Invalid subscription target.");
  if (!actor.targetRefs.includes(targetRef(input.target))) fail("FORBIDDEN", "Subscription target is not granted.");
  if (input.id !== undefined) string(input.id, "subscriptionId");
  if (input.once !== undefined && typeof input.once !== "boolean") fail("INVALID_INPUT", "once must be boolean.");
  if (input.maxAttempts !== undefined) integer(input.maxAttempts, "maxAttempts", 1, 10);
  timestamp(input.expiresAt, "expiresAt");
  if (input.filter !== undefined) {
    if (!isObject(input.filter) || Object.keys(input.filter).length > 8) fail("INVALID_INPUT", "At most eight equality filters are supported.");
    for (const [field, value] of Object.entries(input.filter)) {
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) fail("INVALID_INPUT", "Filter values must be JSON primitives.");
      canonical(value);
      if (input.types.some((type) => !typeDefinition(type).filterableFields.includes(field))) fail("INVALID_INPUT", "Filter field is not declared by every selected event type.");
    }
  }
  if (!isObject(input.start)) fail("INVALID_INPUT", "An explicit subscription start policy is required.");
  if (input.start.kind === "replay") {
    integer(input.start.afterSequence, "afterSequence", 0, Number.MAX_SAFE_INTEGER);
    integer(input.start.limit, "replay limit", 1, 1000);
  } else if (input.start.kind !== "from_now") fail("INVALID_INPUT", "Unknown start policy.");
}

function subscription(row: Row): StoredSubscription {
  return {
    ...JSON.parse(String(row.spec)), id: String(row.id), ownerId: String(row.owner_id),
    revision: Number(row.revision), ruleRevision: Number(row.rule_revision), activationGeneration: Number(row.activation_generation),
    status: String(row.status) as StoredSubscription["status"], startSequence: Number(row.start_sequence),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), replayedCount: Number(row.replayed_count), replayTruncated: Boolean(row.replay_truncated),
  };
}
function delivery(row: Row): StoredDelivery {
  return {
    deliveryId: String(row.id), eventId: String(row.event_id), subscriptionId: String(row.subscription_id),
    ruleRevision: Number(row.rule_revision), activationGeneration: Number(row.activation_generation),
    target: JSON.parse(String(row.target)), deliveryMode: String(row.delivery_mode) as StoredDelivery["deliveryMode"],
    status: String(row.status) as StoredDelivery["status"], attempts: Number(row.attempts), availableAt: new Date(Number(row.available_at)).toISOString(),
    ...(row.consumer_id ? { claimedBy: String(row.consumer_id) } : {}),
    ...(row.lease_until ? { leaseUntil: new Date(Number(row.lease_until)).toISOString() } : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    ...(row.acknowledged_at ? { acknowledgedAt: String(row.acknowledged_at) } : {}),
  };
}
function eventMatches(sub: StoredSubscription, event: StoredEvent, now: number): boolean {
  return sub.scope === event.scope && sub.types.includes(event.type)
    && (!sub.expiresAt || Date.parse(sub.expiresAt) > now)
    && (!event.expiresAt || Date.parse(event.expiresAt) > now)
    && Object.entries(sub.filter ?? {}).every(([key, value]) => Object.hasOwn(event.payload, key) && event.payload[key] === value);
}
function addDelivery(sub: StoredSubscription, event: StoredEvent): boolean {
  const once = one("SELECT once_event_id FROM subscriptions WHERE id = ?", sub.id);
  if (sub.once && once?.once_event_id) return false;
  if (Number(one("SELECT COUNT(*) AS value FROM deliveries WHERE status IN ('pending','claimed')")!.value) >= 10_000) fail("BACKPRESSURE", "Durable delivery queue is full; event was not accepted.");
  const id = createHash("sha256").update(canonical([sub.id, sub.ruleRevision, event.eventId])).digest("hex");
  const inserted = run(`INSERT OR IGNORE INTO deliveries
    (id,event_id,subscription_id,rule_revision,activation_generation,target,target_ref,delivery_mode,status,attempts,available_at)
    VALUES (?,?,?,?,?,?,?,?, 'pending',0,?)`, id, event.eventId, sub.id, sub.ruleRevision, sub.activationGeneration, canonical(sub.target), targetRef(sub.target), sub.deliveryMode, Date.now());
  if (inserted.changes && sub.once) run("UPDATE subscriptions SET once_event_id = ? WHERE id = ?", event.eventId, sub.id);
  return Boolean(inserted.changes);
}

function publish(actor: EventPrincipal, input: PublishEventInput): PublishReceipt {
  return transaction(() => {
    principal(actor); scope(actor, input.scope); string(input.idempotencyKey, "idempotencyKey");
    const previous = one("SELECT * FROM events WHERE actor_id=? AND actor_kind=? AND scope=? AND idempotency_key=?", actor.principalId, actor.kind, input.scope, input.idempotencyKey);
    // A retry is compared with the accepted request, not reinterpreted under a new payload schema.
    // Current publisher and scope grants are still checked before returning its old receipt.
    const definition = validatePublish(actor, input, Boolean(previous));
    const fingerprint = digest({ type: input.type, scope: input.scope, payload: input.payload,
      correlationId: input.correlationId ?? null, causationId: input.causationId ?? null, expiresAt: input.expiresAt ?? null });
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with different content.");
      const event = JSON.parse(String(previous.envelope)) as StoredEvent;
      return { eventId: event.eventId, sequence: event.sequence, receivedAt: event.receivedAt, status: "duplicate", deliveryCount: Number(one("SELECT COUNT(*) AS value FROM deliveries WHERE event_id=?", event.eventId)!.value) };
    }
    const eventId = randomUUID();
    const event: StoredEvent = { eventId, sequence: 0, type: input.type, schemaVersion: definition.schemaVersion, scope: input.scope,
      actor: { principalId: actor.principalId, kind: actor.kind }, payload: input.payload, receivedAt: nowISO(), correlationId: input.correlationId ?? eventId,
      ...(input.causationId ? { causationId: input.causationId } : {}), ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) };
    const inserted = run("INSERT INTO events(event_id,type,schema_version,scope,actor_id,actor_kind,idempotency_key,fingerprint,envelope) VALUES(?,?,?,?,?,?,?,?,?)",
      eventId, event.type, event.schemaVersion, event.scope, actor.principalId, actor.kind, input.idempotencyKey, fingerprint, "{}");
    event.sequence = Number(inserted.lastInsertRowid);
    run("UPDATE events SET envelope=? WHERE event_id=?", canonical(event), eventId);
    let count = 0;
    for (const row of rows("SELECT * FROM subscriptions WHERE status='active' AND scope=?", event.scope)) {
      const sub = subscription(row);
      if (event.sequence > sub.startSequence && eventMatches(sub, event, Date.now()) && addDelivery(sub, event)) count++;
    }
    return { eventId, sequence: event.sequence, receivedAt: event.receivedAt, status: "accepted", deliveryCount: count };
  });
}

function subscribe(actor: EventPrincipal, input: SubscribeInput): StoredSubscription {
  return transaction(() => {
    validateSubscription(actor, input);
    const requestHash = digest(input);
    if (input.id) {
      const existing = one("SELECT * FROM subscriptions WHERE id=?", input.id);
      if (existing) {
        if (existing.owner_id !== actor.principalId) fail("FORBIDDEN", "Subscription belongs to another principal.");
        if (existing.creation_hash !== requestHash) fail("IDEMPOTENCY_CONFLICT", "Subscription id already has a different creation request.");
        return subscription(existing);
      }
    }
    if (Number(one("SELECT COUNT(*) AS value FROM subscriptions WHERE owner_id=? AND status!='retired'", actor.principalId)!.value) >= 100) fail("BACKPRESSURE", "Principal subscription limit reached.");
    const id = input.id ?? randomUUID();
    const startSequence = watermark();
    if (input.start.kind === "replay" && input.start.afterSequence > startSequence) fail("INVALID_INPUT", "Replay cursor is ahead of the accepted event watermark.");
    const { id: _id, start: _start, ...spec } = input;
    const createdAt = nowISO();
    run(`INSERT INTO subscriptions(id,owner_id,scope,spec,creation_hash,revision,rule_revision,activation_generation,status,start_sequence,created_at,updated_at,replayed_count,replay_truncated)
      VALUES(?,?,?,?,?,1,1,1,'active',?,?,?,0,0)`, id, actor.principalId, input.scope, canonical(spec), requestHash, startSequence, createdAt, createdAt);
    const sub = subscription(one("SELECT * FROM subscriptions WHERE id=?", id)!);
    if (input.start.kind === "replay") {
      const candidates = rows(`SELECT envelope FROM events WHERE sequence>? AND sequence<=? AND scope=? AND type IN (${holes(input.types)}) ORDER BY sequence DESC LIMIT 1001`,
        input.start.afterSequence, startSequence, input.scope, ...input.types);
      const matching = candidates.slice(0, 1000).map((row) => JSON.parse(String(row.envelope)) as StoredEvent).filter((event) => eventMatches(sub, event, Date.now()));
      const selected = matching.slice(0, sub.once ? 1 : input.start.limit).reverse();
      let count = 0;
      for (const event of selected) if (addDelivery(sub, event)) count++;
      const truncated = candidates.length > 1000 || (!sub.once && matching.length > input.start.limit);
      run("UPDATE subscriptions SET replayed_count=?,replay_truncated=? WHERE id=?", count, truncated ? 1 : 0, id);
    }
    return subscription(one("SELECT * FROM subscriptions WHERE id=?", id)!);
  });
}

function ownedSubscription(actor: EventPrincipal, id: string): StoredSubscription {
  principal(actor); string(id, "subscriptionId");
  const row = one("SELECT * FROM subscriptions WHERE id=?", id);
  if (!row || row.owner_id !== actor.principalId) return fail("NOT_FOUND", "Subscription not found in this principal's scope.");
  const sub = subscription(row); scope(actor, sub.scope);
  if (sub.types.some((type) => !actor.subscribeTypes.includes(type)) || !actor.targetRefs.includes(targetRef(sub.target))) fail("FORBIDDEN", "Subscription authorization is no longer current.");
  return sub;
}

function update(actor: EventPrincipal, id: string, expectedRevision: number, patch: SubscriptionPatch, retire = false): StoredSubscription {
  return transaction(() => {
    const sub = ownedSubscription(actor, id);
    integer(expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
    if (sub.revision !== expectedRevision) fail("REVISION_CONFLICT", "Subscription changed; read its current revision.");
    if (sub.status === "retired") return retire ? sub : fail("RETIRED", "A retired subscription cannot be resumed.");
    if (!isObject(patch) || Object.keys(patch).some((key) => !["types", "filter", "status", "expiresAt"].includes(key))) fail("INVALID_INPUT", "Unsupported subscription patch.");
    if (patch.status !== undefined && !["active", "paused"].includes(patch.status)) fail("INVALID_INPUT", "Invalid subscription status.");
    const { id: _id, ownerId: _owner, revision: _revision, ruleRevision: _rule, activationGeneration: _activation,
      status: _status, startSequence: _sequence, createdAt: _created, updatedAt: _updated, replayedCount: _count, replayTruncated: _truncated, ...spec } = sub;
    if (patch.types !== undefined) spec.types = patch.types;
    if (patch.filter !== undefined) spec.filter = patch.filter;
    if (patch.expiresAt === null) delete spec.expiresAt;
    else if (patch.expiresAt !== undefined) spec.expiresAt = patch.expiresAt;
    validateSubscription(actor, { ...spec, start: { kind: "from_now" } });
    const nextStatus = retire ? "retired" : patch.status ?? sub.status;
    const changedRule = canonical([sub.types, sub.filter ?? {}, sub.expiresAt ?? null]) !== canonical([spec.types, spec.filter ?? {}, spec.expiresAt ?? null]);
    const changedActivation = changedRule || nextStatus !== sub.status;
    run("UPDATE subscriptions SET spec=?,status=?,revision=revision+1,rule_revision=rule_revision+?,activation_generation=activation_generation+?,start_sequence=?,updated_at=? WHERE id=?",
      canonical(spec), nextStatus, changedRule ? 1 : 0, changedActivation ? 1 : 0, changedActivation ? watermark() : sub.startSequence, nowISO(), id);
    if (changedActivation) run("UPDATE deliveries SET status='cancelled',claim_token=NULL,lease_until=NULL,last_error='Subscription eligibility changed' WHERE subscription_id=? AND status IN ('pending','claimed')", id);
    return subscription(one("SELECT * FROM subscriptions WHERE id=?", id)!);
  });
}

function visibleDelivery(actor: EventPrincipal, row: Row): boolean {
  const event = JSON.parse(String(row.envelope)) as StoredEvent;
  return canRead(actor, event) && (row.owner_id === actor.principalId || actor.targetRefs.includes(String(row.target_ref)));
}
function listDeliveries(actor: EventPrincipal, subscriptionId?: string, limit = 100): StoredDelivery[] {
  principal(actor); integer(limit, "limit", 1, 1000);
  if (subscriptionId !== undefined) string(subscriptionId, "subscriptionId");
  if (!actor.scopes.length || !actor.subscribeTypes.length) return [];
  const result = rows(`SELECT d.*,e.envelope,s.owner_id FROM deliveries d JOIN events e ON d.event_id=e.event_id JOIN subscriptions s ON d.subscription_id=s.id
    WHERE e.scope IN (${holes(actor.scopes)}) AND e.type IN (${holes(actor.subscribeTypes)})
    AND (s.owner_id=? ${actor.targetRefs.length ? `OR d.target_ref IN (${holes(actor.targetRefs)})` : ""})
    ${subscriptionId ? "AND d.subscription_id=?" : ""} ORDER BY e.sequence DESC,d.id LIMIT ?`,
    ...actor.scopes, ...actor.subscribeTypes, actor.principalId, ...actor.targetRefs, ...(subscriptionId ? [subscriptionId] : []), limit);
  return result.map(delivery);
}

function claim(actor: EventPrincipal, input: ClaimInput): ClaimedDelivery[] {
  principal(actor); string(input.consumerId, "consumerId");
  if (actor.kind !== "component") fail("FORBIDDEN", "Only a trusted component consumer may claim durable deliveries.");
  if (!["component", "background"].includes(input.deliveryMode)) fail("INVALID_INPUT", "An explicit delivery mode is required.");
  const limit = input.limit ?? 10; const leaseMs = input.leaseMs ?? 30_000;
  integer(limit, "claim limit", 1, 100); integer(leaseMs, "leaseMs", 1, 300_000);
  if (input.subscriptionId !== undefined) string(input.subscriptionId, "subscriptionId");
  if (!actor.scopes.length || !actor.subscribeTypes.length || !actor.targetRefs.length) return [];
  return transaction(() => {
    const now = Date.now();
    const candidates = rows(`SELECT d.*,e.envelope,s.spec,s.owner_id FROM deliveries d JOIN events e ON d.event_id=e.event_id JOIN subscriptions s ON d.subscription_id=s.id
      WHERE d.delivery_mode=? AND e.scope IN (${holes(actor.scopes)}) AND e.type IN (${holes(actor.subscribeTypes)}) AND d.target_ref IN (${holes(actor.targetRefs)})
      AND s.status='active' AND d.activation_generation=s.activation_generation AND d.rule_revision=s.rule_revision
      AND ((d.status='pending' AND d.available_at<=?) OR (d.status='claimed' AND d.lease_until<=?))
      ${input.subscriptionId ? "AND d.subscription_id=?" : ""} ORDER BY e.sequence,d.id LIMIT 1000`,
      input.deliveryMode, ...actor.scopes, ...actor.subscribeTypes, ...actor.targetRefs, now, now, ...(input.subscriptionId ? [input.subscriptionId] : []));
    const claimed: ClaimedDelivery[] = [];
    for (const row of candidates) {
      const spec = JSON.parse(String(row.spec)) as SubscribeInput;
      const event = JSON.parse(String(row.envelope)) as StoredEvent;
      if ((spec.expiresAt && Date.parse(spec.expiresAt) <= now) || (event.expiresAt && Date.parse(event.expiresAt) <= now)) {
        run("UPDATE deliveries SET status='cancelled',claim_token=NULL,last_error='Expired before consumption' WHERE id=?", String(row.id)); continue;
      }
      if (input.deliveryMode === "component" && !options.componentHandlers.includes(targetRef(spec.target))) continue;
      if (Number(row.attempts) >= (spec.maxAttempts ?? 5)) {
        run("UPDATE deliveries SET status='failed',claim_token=NULL,last_error='Attempt limit reached' WHERE id=?", String(row.id)); continue;
      }
      const token = randomUUID();
      run("UPDATE deliveries SET status='claimed',attempts=attempts+1,consumer_id=?,consumer_principal=?,claim_token=?,lease_until=? WHERE id=?", input.consumerId, actor.principalId, token, now + leaseMs, String(row.id));
      claimed.push({ ...delivery(one("SELECT * FROM deliveries WHERE id=?", String(row.id))!), status: "claimed", claimToken: token, event });
      if (claimed.length >= limit) break;
    }
    return claimed;
  });
}

function claimForReceipt(actor: EventPrincipal, input: AckInput): Row {
  principal(actor); string(input.deliveryId, "deliveryId"); string(input.claimToken, "claimToken");
  const row = one(`SELECT d.*,e.envelope,s.spec,s.owner_id,s.status AS subscription_status,s.activation_generation AS current_generation
    FROM deliveries d JOIN events e ON d.event_id=e.event_id JOIN subscriptions s ON d.subscription_id=s.id WHERE d.id=?`, input.deliveryId);
  if (!row || !visibleDelivery(actor, row) || actor.kind !== "component" || row.consumer_principal !== actor.principalId
    || !actor.targetRefs.includes(String(row.target_ref))) return fail("FORBIDDEN", "Delivery is not assigned to this consumer principal.");
  if (row.status === "acked" && row.claim_token === input.claimToken) return row;
  const currentSubscription = JSON.parse(String(row.spec)) as SubscribeInput;
  const currentEvent = JSON.parse(String(row.envelope)) as StoredEvent;
  if ((currentSubscription.expiresAt && Date.parse(currentSubscription.expiresAt) <= Date.now())
    || (currentEvent.expiresAt && Date.parse(currentEvent.expiresAt) <= Date.now())) fail("STALE_CLAIM", "Event or subscription expired before acknowledgement.");
  if (row.status !== "claimed" || row.claim_token !== input.claimToken || Number(row.lease_until) <= Date.now()
    || row.subscription_status !== "active" || row.activation_generation !== row.current_generation) fail("STALE_CLAIM", "Delivery claim is expired, cancelled, or superseded.");
  return row;
}
function ack(actor: EventPrincipal, input: AckInput): StoredDelivery {
  return transaction(() => {
    const row = claimForReceipt(actor, input);
    if (row.status !== "acked") run("UPDATE deliveries SET status='acked',acknowledged_at=?,lease_until=NULL WHERE id=?", nowISO(), input.deliveryId);
    return delivery(one("SELECT * FROM deliveries WHERE id=?", input.deliveryId)!);
  });
}
function failDelivery(actor: EventPrincipal, input: FailInput): StoredDelivery {
  string(input.error, "error", 1000);
  const retryAfterMs = input.retryAfterMs ?? 1000; integer(retryAfterMs, "retryAfterMs", 0, 3_600_000);
  return transaction(() => {
    const row = claimForReceipt(actor, input);
    if (row.status === "acked") fail("STALE_CLAIM", "Acknowledged delivery cannot fail.");
    const sub = one("SELECT spec FROM subscriptions WHERE id=?", String(row.subscription_id))!;
    const exhausted = Number(row.attempts) >= ((JSON.parse(String(sub.spec)) as SubscribeInput).maxAttempts ?? 5);
    run("UPDATE deliveries SET status=?,available_at=?,claim_token=NULL,lease_until=NULL,last_error=? WHERE id=?", exhausted ? "failed" : "pending", Date.now() + retryAfterMs, input.error, input.deliveryId);
    return delivery(one("SELECT * FROM deliveries WHERE id=?", input.deliveryId)!);
  });
}

function stats(actor: EventPrincipal): EventStats {
  principal(actor);
  const result: EventStats = { events: 0, subscriptions: 0, pending: 0, claimed: 0, acknowledged: 0, failed: 0, cancelled: 0 };
  if (!actor.scopes.length || !actor.subscribeTypes.length) return result;
  result.events = Number(one(`SELECT COUNT(*) AS value FROM events WHERE scope IN (${holes(actor.scopes)}) AND type IN (${holes(actor.subscribeTypes)})`, ...actor.scopes, ...actor.subscribeTypes)!.value);
  result.subscriptions = listSubscriptions(actor).length;
  const grouped = rows(`SELECT d.status,COUNT(*) AS value FROM deliveries d JOIN events e ON d.event_id=e.event_id JOIN subscriptions s ON d.subscription_id=s.id
    WHERE e.scope IN (${holes(actor.scopes)}) AND e.type IN (${holes(actor.subscribeTypes)})
    AND (s.owner_id=? ${actor.targetRefs.length ? `OR d.target_ref IN (${holes(actor.targetRefs)})` : ""}) GROUP BY d.status`,
    ...actor.scopes, ...actor.subscribeTypes, actor.principalId, ...actor.targetRefs);
  for (const row of grouped) {
    const key = row.status === "acked" ? "acknowledged" : String(row.status);
    if (["pending", "claimed", "acknowledged", "failed", "cancelled"].includes(key)) result[key as keyof EventStats] = Number(row.value);
  }
  return result;
}
function listSubscriptions(actor: EventPrincipal): StoredSubscription[] {
  principal(actor);
  return rows("SELECT * FROM subscriptions WHERE owner_id=? ORDER BY created_at,id", actor.principalId).map(subscription)
    .filter((sub) => actor.scopes.includes(sub.scope) && sub.types.every((type) => actor.subscribeTypes.includes(type)) && actor.targetRefs.includes(targetRef(sub.target)));
}

const OWNER_INNER_AUDIENCE = Object.freeze({ scope: 'local-owner', kind: 'owner' as const, audienceId: 'local-owner' });
/** Trusted same-Worker local conversation/audience read; never a public command or model input. */
function innerConversationFacts(conversationId: string): InnerConversationFacts | undefined {
  if (!conversations) return undefined;
  try {
    const record = conversations.getLocalConversation(conversationId);
    return { audience: { scope: record.key.scope, kind: record.key.kind, audienceId: record.conversationId },
      revision: record.revision, audienceVersion: record.audienceVersion, active: !record.archived };
  } catch (error) {
    const code = isObject(error) && typeof error.code === 'string' ? error.code : '';
    if (code === 'UNKNOWN_CONVERSATION' || code === 'NOT_FOUND') return undefined;
    throw error;
  }
}
/** Trusted same-Worker evidence read: memory operation readback or a succeeded local Task. */
function innerEvidence(ref: InnerSourceRef): InnerEvidenceFacts | undefined {
  const codeOf = (error: unknown): string => isObject(error) && typeof error.code === 'string' ? error.code : '';
  if (ref.kind === 'memory-operation') {
    if (!memories) return undefined;
    let entry: ReturnType<MemoryDomain['get']>;
    try { entry = memories.get(ref.sourceId); }
    catch (error) {
      const code = codeOf(error);
      if (code === 'UNKNOWN_MEMORY_OPERATION' || code === 'NOT_FOUND') return undefined;
      throw error;
    }
    const conversation = innerConversationFacts(entry.conversationId);
    if (!conversation) return undefined;
    return { valid: Boolean(entry.reference) && entry.operation.status === 'applied' && entry.source.revision === ref.revision,
      audience: conversation.audience, revision: entry.source.revision };
  }
  if (ref.kind === 'task-receipt') {
    if (!tasks) return undefined;
    let detail: ReturnType<TaskDomain['get']>;
    try { detail = tasks.get(ref.sourceId); }
    catch (error) {
      const code = codeOf(error);
      if (code === 'UNKNOWN_TASK' || code === 'NOT_FOUND') return undefined;
      throw error;
    }
    return { valid: detail.task.state === 'succeeded', audience: structuredClone(OWNER_INNER_AUDIENCE), revision: detail.task.version };
  }
  return undefined;
}
function innerAvailabilityReason(code: string | undefined): 'not_connected' | 'incompatible_version' | 'source_unavailable' | 'verification_pending' {
  if (!code) return 'verification_pending';
  if (code.startsWith('INCOMPATIBLE_')) return 'incompatible_version';
  if (code.startsWith('CORRUPT_') || code.startsWith('TRANSACTION_')) return 'source_unavailable';
  return 'verification_pending';
}
/**
 * Publish only domains that are truly instantiated on this control DB. A failed or
 * absent domain stays explicitly unavailable; the manifest is a read-availability
 * declaration, never a business acceptance or a permission grant.
 */
function publishInnerReadability(): void {
  if (!publication || !statePublisher) return;
  const current = publication.get();
  if (!current) return fail('VIEWS_UNAVAILABLE', 'Inner state publication is unavailable.');
  const instances: Record<InnerDomain, RelationshipDomain | EmotionDomain | CognitionDomain | PersonalityDomain | undefined> = { relationship, emotion, cognition, personality };
  const errors: Record<InnerDomain, string | undefined> = { relationship: relationshipError, emotion: emotionError, cognition: cognitionError, personality: personalityError };
  const availability = {} as InnerDomainAvailability;
  for (const domain of INNER_DOMAINS) {
    const instance = instances[domain];
    if (!instance) { availability[domain] = { status: 'unavailable', reason: innerAvailabilityReason(errors[domain]) }; continue; }
    try {
      availability[domain] = { status: 'available', backendId: INNER_DOMAIN_BACKENDS[domain], authorityId: instance.authority().authorityId,
        capabilities: ['metadata_read', 'content_read'] };
    } catch { availability[domain] = { status: 'unavailable', reason: 'source_unavailable' }; }
  }
  if (current.manifest.schemaVersion === 4) {
    if (INNER_DOMAINS.every(domain => canonical(current.manifest.domains[domain]) === canonical(availability[domain]))) return;
  } else if (INNER_DOMAINS.every(domain => availability[domain].status === 'unavailable')) {
    // Keep the legacy schema honest without a version bump: all four are already declared unavailable.
    return;
  }
  publication.publishInnerAvailability(statePublisher, { requestId: `inner-readability-${randomUUID()}`,
    expectedBaselineId: current.baselineId, expectedStateVersion: current.stateVersion, availability });
}
function publishAbilityReadability(): void {
  if (!publication || !statePublisher) return;
  const current = publication.get();
  if (!current) return fail('VIEWS_UNAVAILABLE', 'Inner state publication is unavailable.');
  if (!ability && current.manifest.schemaVersion !== 3) return;
  const availability = ability ? { status: 'available' as const, backendId: 'control-ability' as const,
    authorityId: ability.snapshot().authorityId, capabilities: ['state_read'] as ['state_read'] }
    : { status: 'unavailable' as const, reason: 'source_unavailable' as const };
  if (canonical(current.manifest.domains.ability) === canonical(availability)) return;
  publication.publishAbilityAvailability(statePublisher, { requestId: `ability-readability-${randomUUID()}`,
    expectedBaselineId: current.baselineId, expectedStateVersion: current.stateVersion, availability });
}
function execute(request: StoreRequest): unknown {
  if (request.command.startsWith('ability.')) {
    if (!ability) return fail(abilityError ?? 'CAPABILITY_UNAVAILABLE', 'Local-note capability state is unavailable.');
    if (request.command === 'ability.snapshot') return ability.execute({ command: request.command, args: request.args } as CapabilityDomainRequest);
    return transaction(() => {
      const result = ability!.execute({ command: request.command, args: request.args } as CapabilityDomainRequest);
      publishAbilityReadability();
      return result;
    });
  }
  if (transactions.poisoned && request.command !== "close") return fail("STORE_ISOLATED", "Control store is isolated after an unreconciled transaction failure.");
  if (request.command === 'channel.status') {
    if (!ingress) return { ready: false, schemaVersion: 0, ...(ingressError ? { errorCode: ingressError } : {}) };
    return ingress.execute(request as ChannelDomainRequest);
  }
  if (request.command.startsWith('channel.')) {
    if (!ingress) return fail(ingressError ?? 'CHANNEL_UNAVAILABLE', 'Channel ingress domain is unavailable.');
    return ingress.execute(request as ChannelDomainRequest);
  }
  if (request.command === 'lab.status') return { ready: Boolean(lab), ...(labError ? { errorCode: labError } : {}) };
  if (request.command.startsWith('lab.')) {
    if (!lab) return fail(labError ?? 'LAB_UNAVAILABLE', 'Lab control domain is unavailable.');
    return lab.execute(request as LabDomainRequest);
  }
  if (request.command === 'core.status') return { ready: Boolean(core), ...(coreError ? { errorCode: coreError } : {}) };
  if (request.command.startsWith('core.')) {
    if (!core) return fail(coreError ?? 'CORE_UNAVAILABLE', 'Core control domain is unavailable.');
    return core.execute(request as CoreDomainRequest);
  }
  const innerStatus = (instance: unknown, error: string | undefined) => ({
    configured: Boolean(options.runtimeIdentity), ready: Boolean(instance), ...(error ? { errorCode: error } : {}) });
  if (request.command.startsWith('relationship.')) {
    if (request.command === 'relationship.status') return innerStatus(relationship, relationshipError);
    if (!relationship) return fail(relationshipError ?? 'RELATIONSHIP_UNAVAILABLE', 'Relationship domain is unavailable.');
    return relationship.execute({ command: request.command, args: request.args } as RelationshipDomainRequest);
  }
  if (request.command.startsWith('emotion.')) {
    if (request.command === 'emotion.status') return innerStatus(emotion, emotionError);
    if (!emotion) return fail(emotionError ?? 'EMOTION_UNAVAILABLE', 'Emotion domain is unavailable.');
    return emotion.execute({ command: request.command, args: request.args } as EmotionDomainRequest);
  }
  if (request.command.startsWith('cognition.')) {
    if (request.command === 'cognition.status') return innerStatus(cognition, cognitionError);
    if (!cognition) return fail(cognitionError ?? 'COGNITION_UNAVAILABLE', 'Cognition domain is unavailable.');
    return cognition.execute({ command: request.command, args: request.args } as CognitionDomainRequest);
  }
  if (request.command.startsWith('personality.')) {
    if (request.command === 'personality.status') return innerStatus(personality, personalityError);
    if (!personality) return fail(personalityError ?? 'PERSONALITY_UNAVAILABLE', 'Personality domain is unavailable.');
    return personality.execute({ command: request.command, args: request.args } as PersonalityDomainRequest);
  }
  if (request.command === 'memory.status') return { configured: Boolean(options.memoryBackend), ready: Boolean(memories), ...(memoryError ? { errorCode: memoryError } : {}) };
  if (request.command === 'memory.index.status') return { configured: Boolean(options.memoryBackend), ready: Boolean(memoryIndex), ...(memoryIndexError || memoryError ? { errorCode: memoryIndexError ?? memoryError } : {}) };
  if (request.command.startsWith('memory.index.')) {
    if (!memoryIndex) return fail(memoryIndexError ?? memoryError ?? 'MEMORY_INDEX_UNCONFIGURED', 'Memory index control domain is unavailable.');
    return memoryIndex.execute(request as MemoryIndexRequest);
  }
  if (request.command.startsWith('memory.')) {
    if (!memories) return fail(memoryError ?? 'MEMORY_UNCONFIGURED', 'Memory control domain is unavailable.');
    return memories.execute(request as MemoryDomainRequest);
  }
  if (request.command.startsWith('view.')) {
    if (!views) return fail('VIEWS_UNAVAILABLE', 'Local views require the trusted runtime identity.');
    return views.execute(request as ViewDomainRequest);
  }
  if (request.command.startsWith('conversation.')) {
    if (!conversations) return fail('CONVERSATIONS_UNAVAILABLE', 'Local conversations require a trusted runtime identity.');
    return conversations.execute(request as ConversationDomainRequest);
  }
  if (request.command.startsWith('task.')) {
    if (!tasks) return fail('TASKS_UNAVAILABLE', 'Task commands require a trusted runtime identity at store initialization.');
    if (request.command === 'task.setPaused' && request.args.paused) return transaction(() => {
      const result = tasks!.execute(request);
      lab?.pauseAll();
      return result;
    });
    return tasks.execute(request as TaskDomainRequest);
  }
  if (request.command.startsWith('goal.binding.') && !goalBindings) return fail('GOALS_UNAVAILABLE', 'Goal bindings require a trusted runtime identity.');
  switch (request.command) {
    case 'state.publishMemoryAvailability': {
      if (!publication || !statePublisher) return fail('VIEWS_UNAVAILABLE', 'Publication requires the trusted runtime identity.');
      const input = request.args;
      if (!isObject(input) || Object.keys(input).some(key => !['requestId', 'expectedBaselineId', 'expectedStateVersion', 'availability'].includes(key))
        || !['requestId', 'expectedBaselineId', 'expectedStateVersion', 'availability'].every(key => Object.hasOwn(input, key))
        || !isObject(input.availability)) return fail('INVALID_SCHEMA', 'Invalid trusted memory availability command.');
      if (input.availability.status === 'available') {
        if (!memories || !options.memoryBackend) return fail(memoryError ?? 'MEMORY_UNCONFIGURED', 'Memory control domain cannot publish availability.');
        if (input.availability.backendId !== options.memoryBackend.backendId || input.availability.deploymentId !== options.memoryBackend.deploymentId) return fail('MEMORY_DEPLOYMENT_MISMATCH', 'Publication must match the configured memory deployment.');
        if (Array.isArray(input.availability.capabilities) && input.availability.capabilities.some(capability => capability === 'semantic_search') && !memoryIndex) return fail(memoryIndexError ?? 'MEMORY_INDEX_UNCONFIGURED', 'Semantic availability requires the index control domain.');
      }
      // The Worker retains the process-local publishing capability. This private
      // command carries verified capability metadata, never a public manifest or actor.
      return publication.publishMemoryAvailability(statePublisher, { requestId: input.requestId, expectedBaselineId: input.expectedBaselineId,
        expectedStateVersion: input.expectedStateVersion, availability: input.availability });
    }
    case 'control.watermark': return commitWatermark.read();
    case 'goal.binding.load': return goalBindings!.load(request.args.goalId);
    case 'goal.binding.loadCommand': return goalBindings!.loadCommand(request.args.goalId, request.args.commandId);
    case 'goal.binding.compareAndSet': return goalBindings!.compareAndSet(request.args.expectedMetadataVersion, request.args.binding);
    case 'goal.binding.list': return goalBindings!.list(request.args);
    case "info": return info;
    case "types": {
      const actor = request.args.principal; principal(actor);
      return [...catalog.values()].filter((type) => actor.subscribeTypes.includes(type.type)
        || (actor.publishTypes.includes(type.type) && type.publisherKinds.includes(actor.kind) && (!type.publisherIds || type.publisherIds.includes(actor.principalId))));
    }
    case "publish": return publish(request.args.principal, request.args.input);
    case "subscribe": return subscribe(request.args.principal, request.args.input);
    case "listSubscriptions": return listSubscriptions(request.args.principal);
    case "update": return update(request.args.principal, request.args.id, request.args.expectedRevision, request.args.patch);
    case "unsubscribe": return update(request.args.principal, request.args.id, request.args.expectedRevision, {}, true);
    case "listEvents": {
      const { principal: actor, limit = 100 } = request.args; principal(actor); integer(limit, "limit", 1, 1000);
      if (!actor.scopes.length || !actor.subscribeTypes.length) return [];
      return rows(`SELECT envelope FROM events WHERE scope IN (${holes(actor.scopes)}) AND type IN (${holes(actor.subscribeTypes)}) ORDER BY sequence DESC LIMIT ?`, ...actor.scopes, ...actor.subscribeTypes, limit)
        .map((row) => JSON.parse(String(row.envelope)) as StoredEvent);
    }
    case "listDeliveries": return listDeliveries(request.args.principal, request.args.subscriptionId, request.args.limit);
    case "claim": return claim(request.args.principal, request.args.input);
    case "ack": return ack(request.args.principal, request.args.input);
    case "fail": return failDelivery(request.args.principal, request.args.input);
    case "stats": return stats(request.args.principal);
    case "close": db.close(); return;
  }
  return fail("INVALID_COMMAND", "Unknown control store command.");
}

function initialize(): void {
  if (!options || !Array.isArray(options.eventTypes) || !Array.isArray(options.componentHandlers)) fail("INVALID_CONFIG", "A catalog and component handler whitelist are required.");
  string(options.filename, "filename", 4096); strings(options.componentHandlers, "componentHandlers");
  for (const definition of options.eventTypes) {
    string(definition.type, "event type"); integer(definition.schemaVersion, "schemaVersion", 1, 1_000_000);
    if (catalog.has(definition.type)) fail("INVALID_CONFIG", "Duplicate catalog event type.");
    if (!definition.payloadSchema || !isObject(definition.payloadSchema.properties) || definition.payloadSchema.additionalProperties !== false) fail("INVALID_CONFIG", "Catalog requires a closed payload schema.");
    strings(definition.payloadSchema.required, "required fields"); strings(definition.filterableFields, "filterableFields");
    strings(definition.publisherKinds, "publisherKinds");
    if (definition.publisherIds) strings(definition.publisherIds, "publisherIds");
    if (Object.values(definition.payloadSchema.properties).some((value) => !["string", "number", "boolean", "null", "object", "array"].includes(value))
      || [...definition.payloadSchema.required, ...definition.filterableFields].some((field) => !Object.hasOwn(definition.payloadSchema.properties, field))) fail("INVALID_CONFIG", "Invalid catalog payload schema.");
    catalog.set(definition.type, definition);
  }
  if (options.filename !== ":memory:") mkdirSync(dirname(options.filename), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(options.filename);
  transactions = new SqliteTransactions(db);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  const sqliteVersion = String(one("SELECT sqlite_version() AS version")!.version);
  const [major = 0, minor = 0, patch = 0] = sqliteVersion.split(".").map(Number);
  const walSafe = major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3)));
  const journalMode = String(one(`PRAGMA journal_mode=${walSafe ? "WAL" : "DELETE"}`)!.journal_mode);
  db.exec("PRAGMA synchronous=FULL;");
  // Register guards before any persisted repository trigger can run on reopen.
  commitWatermark = installCommitWatermark(db, transactions);
  info = { sqliteVersion, journalMode, journalReason: walSafe ? "SQLite meets the workspace WAL-reset fix baseline (>=3.51.3)." : "SQLite is below the verified WAL-reset fix baseline; DELETE is required.",
    synchronous: Number(one("PRAGMA synchronous")!.synchronous), foreignKeys: Number(one("PRAGMA foreign_keys")!.foreign_keys) === 1,
    busyTimeoutMs: Number(one("PRAGMA busy_timeout")!.timeout), workerThreadId: threadId };
  const schemaVersion = Number(one("PRAGMA user_version")!.user_version);
  if (schemaVersion !== 0 && schemaVersion !== 1) fail("SCHEMA_VERSION", "Unsupported control store schema version.");
  transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_catalog(type TEXT NOT NULL,schema_version INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(type,schema_version));
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,type TEXT NOT NULL,schema_version INTEGER NOT NULL,
        scope TEXT NOT NULL,actor_id TEXT NOT NULL,actor_kind TEXT NOT NULL,idempotency_key TEXT NOT NULL,fingerprint TEXT NOT NULL,envelope TEXT NOT NULL,
        UNIQUE(actor_id,actor_kind,scope,idempotency_key));
      CREATE INDEX IF NOT EXISTS events_scope_type ON events(scope,type,sequence);
      CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,scope TEXT NOT NULL,spec TEXT NOT NULL,creation_hash TEXT NOT NULL,
        revision INTEGER NOT NULL,rule_revision INTEGER NOT NULL,activation_generation INTEGER NOT NULL,status TEXT NOT NULL,start_sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,replayed_count INTEGER NOT NULL,replay_truncated INTEGER NOT NULL,once_event_id TEXT);
      CREATE INDEX IF NOT EXISTS subscriptions_scope ON subscriptions(scope,status);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(event_id),subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
        rule_revision INTEGER NOT NULL,activation_generation INTEGER NOT NULL,target TEXT NOT NULL,target_ref TEXT NOT NULL,delivery_mode TEXT NOT NULL,
        status TEXT NOT NULL,attempts INTEGER NOT NULL,available_at INTEGER NOT NULL,consumer_id TEXT,consumer_principal TEXT,claim_token TEXT,lease_until INTEGER,last_error TEXT,acknowledged_at TEXT,
        UNIQUE(subscription_id,rule_revision,event_id));
      CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(status,available_at,lease_until);
      PRAGMA user_version=1;
    `);
    for (const definition of catalog.values()) {
      const fingerprint = digest(definition);
      const existing = one("SELECT fingerprint FROM event_catalog WHERE type=? AND schema_version=?", definition.type, definition.schemaVersion);
      if (existing && existing.fingerprint !== fingerprint) fail("SCHEMA_VERSION", "An event type changed without a schema version increment.");
      run("INSERT OR IGNORE INTO event_catalog(type,schema_version,fingerprint) VALUES(?,?,?)", definition.type, definition.schemaVersion, fingerprint);
    }
  });
  // The generic channel ingress ledger needs no native identity; it is available
  // in event-only stores as well as the full runtime store.
  try { ingress = new IngressDomain(db, transactions); }
  catch (error) { ingressError = isObject(error) && typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'CHANNEL_INGRESS_INITIALIZATION_FAILED'; }
  if (options.runtimeIdentity) {
    goalBindings = new SQLiteGoalBindingStore(db, transactions);
    tasks = new TaskDomain(db, transactions, { runtimeIdentity: options.runtimeIdentity, onSucceeded: taskId => {
      // Completion facts share the Task transaction; no observer can see a half-committed success.
      const receipt = publish({ principalId: 'task-service', kind: 'component', scopes: ['local-owner'], publishTypes: ['task.succeeded'], subscribeTypes: [], targetRefs: [] },
        { type: 'task.succeeded', scope: 'local-owner', payload: { taskId }, idempotencyKey: `task-succeeded:${taskId}` });
      core?.enqueueTaskFact({ taskId, eventId: receipt.eventId });
      ability?.recordSuccessfulTask(taskId);
    } });
    const actor = conversationEventPrincipal();
    conversations = new ConversationDomain(db, transactions, {
      getTask: taskId => tasks!.get(taskId).task,
      events: {
        subscribe: input => subscribe(actor, input), listSubscriptions: () => listSubscriptions(actor), stats: () => stats(actor),
        claim: input => claim(actor, input),
        inspectClaim: input => {
          const row = claimForReceipt(actor, input);
          return { delivery: delivery(row), event: JSON.parse(String(row.envelope)) as StoredEvent };
        },
        ack: input => ack(actor, input), fail: input => failDelivery(actor, input),
      },
    });
    publication = new StatePublicationStore(db, transactions, { publisherIds: ['shiyu-state-service'] });
    statePublisher = createStatePublisher('shiyu-state-service');
    // Explicit initialization publication, not a GET side effect or a Task version mapping.
    if (!publication.get()) publication.publish(statePublisher, { requestId: 'initial-inner-availability-v1', manifest: initialStateManifest() });
    if (options.localNoteBinding) {
      try {
        if (options.localNoteBinding.definitionDigest !== localNoteDefinitionDigest()) fail('CAPABILITY_BINDING_MISMATCH', 'Installed local-note implementation differs from its trusted binding.');
        ability = new CapabilityDomain(db, transactions, { runtimeIdentity: options.runtimeIdentity, binding: options.localNoteBinding,
          taskEvidence: taskId => tasks!.inspectCapabilityEvidence(taskId) });
        publishAbilityReadability();
        tasks.setCapabilityAuthority(ability);
      } catch (error) {
        ability = undefined;
        abilityError = isObject(error) && typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'CAPABILITY_INITIALIZATION_FAILED';
      }
    }
    if (!ability) publishAbilityReadability();
    if (options.memoryBackend) {
      try {
        memories = new MemoryDomain(db, transactions, { runtimeIdentity: options.runtimeIdentity,
          ...options.memoryBackend, getConversation: conversationId => conversations!.getLocalConversation(conversationId),
          onWithdrawSources: input => conversations!.invalidateMemorySources(input) });
      } catch (error) {
        // A damaged/incompatible memory authority stays closed; the dashboard and unrelated domains remain inspectable.
        memoryError = isObject(error) && typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'MEMORY_INITIALIZATION_FAILED';
      }
      if (memories) {
        try { memoryIndex = new MemoryIndexDomain(db, transactions, { runtimeIdentity: options.runtimeIdentity, ...options.memoryBackend, memory: memories }); }
        catch (error) { memoryIndexError = isObject(error) && typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'MEMORY_INDEX_INITIALIZATION_FAILED'; }
      }
    }
    const innerOptions = { runtimeIdentity: options.runtimeIdentity, resolveConversation: innerConversationFacts, resolveEvidence: innerEvidence };
    const domainError = (error: unknown, fallback: string): string =>
      isObject(error) && typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : fallback;
    try { relationship = new RelationshipDomain(db, transactions, innerOptions); } catch (error) { relationshipError = domainError(error, 'RELATIONSHIP_INITIALIZATION_FAILED'); }
    try { emotion = new EmotionDomain(db, transactions, innerOptions); } catch (error) { emotionError = domainError(error, 'EMOTION_INITIALIZATION_FAILED'); }
    try { cognition = new CognitionDomain(db, transactions, innerOptions); } catch (error) { cognitionError = domainError(error, 'COGNITION_INITIALIZATION_FAILED'); }
    try { personality = new PersonalityDomain(db, transactions, innerOptions); } catch (error) { personalityError = domainError(error, 'PERSONALITY_INITIALIZATION_FAILED'); }
    publishInnerReadability();
    const safety = new LocalReadSafetyStore(db, transactions, { getAuthEpoch: () => tasks!.mandates.health().authEpoch });
    try {
      if (!ability) fail(abilityError ?? 'CAPABILITY_UNAVAILABLE', 'Core planning requires readable capability authority.');
      core = new CoreDomain(db, transactions, { runtimeIdentity: options.runtimeIdentity, tasks, goals: goalBindings,
        capability: ability!, publication, safety, watermark: commitWatermark });
    }
    catch (error) {
      coreError = isObject(error) && typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'CORE_INITIALIZATION_FAILED';
    }
    const innerPorts = {
      ...(relationship ? { relationship } : {}), ...(emotion ? { emotion } : {}),
      ...(cognition ? { cognition } : {}), ...(personality ? { personality } : {}),
    };
    views = new ViewDomain(db, transactions, { publication, safety, watermark: commitWatermark, ...(memories ? { memory: memories } : {}), inner: innerPorts,
      authorizeLabReply: (input, phase) => {
        if (!lab) return fail(labError ?? 'LAB_UNAVAILABLE', 'Lab reply capture authority is unavailable.');
        const operation = conversations!.execute({ command: 'conversation.reply.get', args: { operationId: input.operationId } }) as LocalReplyOperation;
        return lab.authorizeReplyCapture(input.permit, operation, phase);
      },
      context: conversationId => conversations!.replyContext(conversationId), getTask: taskId => tasks!.get(taskId).task });
    conversations.setReplyAuthority({ validateCapture: (captureId, phase) => views!.validateReplyCapture(captureId, { for: phase }),
      assertMemorySourcesCurrent: sources => {
        if (!memories) return fail(memoryError ?? 'MEMORY_UNCONFIGURED', 'Previously exposed memory cannot be revalidated.');
        memories.validateExposedSources(sources);
      } });
    try {
      lab = new LabDomain(db, transactions, { runtimeIdentity: options.runtimeIdentity,
        ensureChannel: input => conversations!.ensureLabChannel(input),
        advanceInput: input => conversations!.advanceLabInput(input),
        retireChannel: input => conversations!.retireLabChannel(input),
        assertDraft: operationId => conversations!.assertReadyDraft(operationId),
        assertRuntimeAllowed: () => { if (tasks!.isPaused()) fail('LAB_RUNTIME_PAUSED', 'Lab dispatch is paused.'); },
      });
    } catch (error) {
      labError = isObject(error) && typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'LAB_INITIALIZATION_FAILED';
    }
  }
}

function errorShape(error: unknown): { code: string; message: string } {
  const code = isObject(error) && typeof error.code === 'string' ? error.code : transactions?.poisoned ? 'STORE_ISOLATED' : 'STORE_ERROR';
  return { code, message: error instanceof Error ? error.message : String(error) };
}
try {
  initialize();
  port.on("message", (request: StoreRequest) => {
    try {
      const value = execute(request);
      port.postMessage({ kind: "result", id: request.id, value } satisfies StoreResponse);
      if (request.command === "close") port.close();
    } catch (error) { port.postMessage({ kind: "result", id: request.id, error: errorShape(error) } satisfies StoreResponse); }
  });
  port.postMessage({ kind: "ready", info } satisfies StoreResponse);
} catch (error) {
  try { db!.close(); } catch { /* Preserve initialization error. */ }
  port.postMessage({ kind: "fatal", error: errorShape(error) } satisfies StoreResponse);
  port.close();
}
