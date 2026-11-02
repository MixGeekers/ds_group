import { EventService } from '../../control/events/index.js';
import type { WorkerTool, WorkerToolContext } from './workers.js';
import { EventServiceError } from '../../contracts/events.js';
import type { EventPayload, EventPrincipal, JsonPrimitive, JsonValue, StoredSubscription, SubscribeInput, SubscriptionPatch } from '../../contracts/events.js';

export interface EventToolExecution {
  /** The actual calling DSH Agent; identity is resolved from trusted runtime bindings. */
  agent?: object;
  signal?: AbortSignal;
  callId?: string;
  [key: string]: unknown;
}
export type ResolveEventPrincipal = (execution: EventToolExecution) => EventPrincipal | null | undefined | Promise<EventPrincipal | null | undefined>;
export type EventToolResult =
  | { ok: true; operation: string; value: Record<string, unknown> }
  | { ok: false; operation: string; error: { code: string; message: string; nextAction: string } };
export interface EventToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe: boolean;
  execute(args: unknown, execution?: EventToolExecution): Promise<EventToolResult>;
  output: { schema: Record<string, unknown>; render(args: unknown, result: EventToolResult): { type: 'text'; text: string }[] };
}
export interface EventToolContext { tools: { register(tool: EventToolDefinition): () => void } }

export const EVENT_TOOL_NAMES = Object.freeze([
  'shiyu_event_types', 'shiyu_event_publish', 'shiyu_event_subscribe', 'shiyu_event_list',
  'shiyu_event_update', 'shiyu_event_unsubscribe', 'shiyu_event_status',
] as const);
const MAX_INPUT_BYTES = 24576;
const MAX_OUTPUT_BYTES = 16384;
const MAX_PAGE_BYTES = 11000;
const blockedPublishTypes = new Set(['task.succeeded']);
const failure = (code: string, message: string): never => { throw new EventServiceError(code, message); };
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function object(value: unknown, keys?: string[]): Record<string, unknown> {
  if (!isObject(value)) return failure('INVALID_INPUT', 'Expected a JSON object.');
  if (keys && Object.keys(value).some(key => !keys.includes(key))) return failure('INVALID_INPUT', 'Unexpected field; identity and authority cannot be supplied in tool arguments.');
  return value;
}
function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) return failure('INVALID_INPUT', `${name} must contain 1–${max} characters.`);
  return value;
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) return failure('INVALID_INPUT', `${name} is outside its allowed integer range.`);
  return Number(value);
}
function strings(value: unknown, name: string, max = 16): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return failure('INVALID_INPUT', `${name} must be a list of 1–${max} strings.`);
  const result = value.map(item => text(item, name));
  if (new Set(result).size !== result.length) return failure('INVALID_INPUT', `${name} must not contain duplicates.`);
  return result;
}
function json(value: unknown, depth = 0): JsonValue {
  if (depth > 8) return failure('INVALID_INPUT', 'JSON nesting exceeds eight levels.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.length <= 8192) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 64) return value.map(item => json(item, depth + 1));
  if (isObject(value) && Object.keys(value).length <= 64) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key, 'JSON key', 128), json(item, depth + 1)]));
  }
  return failure('INVALID_INPUT', 'Only bounded, finite JSON values are supported.');
}
function input(value: unknown, keys: string[]): Record<string, unknown> {
  const checked = object(value, keys);
  const cloned = json(checked) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(cloned)) > MAX_INPUT_BYTES) return failure('INVALID_INPUT', 'Tool input exceeds 24 KiB.');
  return cloned;
}
function timestamp(value: unknown, name: string): string {
  const result = text(value, name, 64);
  if (!Number.isFinite(Date.parse(result))) return failure('INVALID_INPUT', `${name} must be an ISO timestamp.`);
  return result;
}
function filters(value: unknown): Record<string, JsonPrimitive> {
  const source = object(value);
  if (Object.keys(source).length > 8) return failure('INVALID_INPUT', 'At most eight equality filters are supported.');
  const result: Record<string, JsonPrimitive> = {};
  for (const [key, item] of Object.entries(source)) {
    text(key, 'filter field', 128);
    if (item !== null && typeof item !== 'boolean' && !(typeof item === 'number' && Number.isFinite(item)) && !(typeof item === 'string' && item.length <= 256)) {
      return failure('INVALID_INPUT', 'Filter values must be finite JSON primitives; strings are limited to 256 characters.');
    }
    Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function principalSnapshot(value: unknown): EventPrincipal {
  const source = object(value);
  if (!['agent', 'component', 'user'].includes(String(source.kind))) return failure('FORBIDDEN', 'A current trusted principal is required.');
  const granted = (name: string): string[] => {
    const value = source[name];
    if (!Array.isArray(value) || value.length > 100) return failure('FORBIDDEN', 'Trusted principal grants are invalid.');
    return value.map(item => text(item, name));
  };
  return { principalId: text(source.principalId, 'principalId'), kind: source.kind as EventPrincipal['kind'],
    scopes: granted('scopes'), publishTypes: granted('publishTypes'), subscribeTypes: granted('subscribeTypes'), targetRefs: granted('targetRefs') };
}
const errors: Record<string, [string, string]> = {
  FORBIDDEN: ['The current Session is not authorized for this operation.', 'Use an already granted scope, event type and target; request missing authority through the trusted control path.'],
  INVALID_INPUT: ['Arguments do not match this bounded tool contract.', 'Read the tool schema; do not provide a principal, arbitrary callback, code or URL.'],
  INVALID_PAYLOAD: ['Payload does not match the registered event type.', 'Call shiyu_event_types and use exactly its declared payload fields.'],
  UNKNOWN_TYPE: ['This event type is not registered.', 'Call shiyu_event_types; tools cannot register new event types.'],
  UNSUPPORTED: ['This delivery mode is not supported. Agent subscriptions support background references only; wake does not start a model.', 'Use background for an authorized Agent binding, or component for an authorized registered component handler.'],
  IDEMPOTENCY_CONFLICT: ['This stable request identity was already used for different content.', 'Reuse the original arguments when retrying, or create a new identity for genuinely new work.'],
  REVISION_CONFLICT: ['The subscription changed since the supplied revision.', 'Read shiyu_event_list and reconsider the change using its current revision.'],
  NOT_FOUND: ['No accessible subscription matches this identifier.', 'Read shiyu_event_list for subscriptions owned by the current principal.'],
  RETIRED: ['A retired subscription cannot be resumed.', 'Create a new subscription with a new stable id if authorized.'],
  BACKPRESSURE: ['The event service cannot accept more work at present.', 'Pause and retry the same request identity later; do not generate more subscriptions.'],
  STORE_CLOSED: ['The event store is unavailable.', 'Wait for the trusted runtime to restore the service.'],
  STORE_ISOLATED: ['The event store is isolated pending reconciliation.', 'Use the trusted runtime recovery path; do not assume this operation completed.'],
  CANCELLED: ['This tool invocation was cancelled before dispatch.', 'Check current state before retrying an earlier invocation.'],
  TOOL_INACTIVE: ['These Session event tools have been disposed.', 'Use the current managed Session.'],
};
function errorResult(operation: string, error: unknown): EventToolResult {
  const code = error instanceof EventServiceError && errors[error.code] ? error.code : 'INTERNAL_ERROR';
  const [message, nextAction] = errors[code] ?? ['The event operation did not return a confirmed result.', 'Inspect current status or retry the same publish/subscription identity; do not assume completion.'];
  return { ok: false, operation, error: { code, message, nextAction } };
}
function page<T>(all: T[], offset: number, limit: number): Record<string, unknown> {
  const items: T[] = [];
  let bytes = 2;
  for (const item of all.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > MAX_PAGE_BYTES) break;
    items.push(item); bytes += size;
  }
  if (!items.length && offset < all.length) return failure('INVALID_INPUT', 'One record exceeds the tool output limit.');
  const next = offset + items.length;
  return { items, total: all.length, nextOffset: next < all.length ? next : null, truncated: next < all.length };
}
function pagination(args: Record<string, unknown>) {
  return { offset: args.offset === undefined ? 0 : integer(args.offset, 'offset', 0, 1000000), limit: args.limit === undefined ? 10 : integer(args.limit, 'limit', 1, 20) };
}
function subscriptionView(sub: StoredSubscription): Record<string, unknown> {
  const summary = { id: sub.id, revision: sub.revision, status: sub.status, scope: sub.scope, target: sub.target,
    deliveryMode: sub.deliveryMode, once: sub.once ?? false, expiresAt: sub.expiresAt ?? null,
    startSequence: sub.startSequence, replayedCount: sub.replayedCount, replayTruncated: sub.replayTruncated,
    deliveryMeaning: sub.deliveryMode === 'background' ? 'Durable pending reference only; no LLM wake or successful processing is implied.' : 'Delivery to a registered component; acceptance is not a completion receipt.' };
  const complete = { ...summary, types: sub.types, filter: sub.filter ?? {}, projectionTruncated: false };
  if (Buffer.byteLength(JSON.stringify(complete)) <= 9000) return complete;
  // Other trusted callers can create a larger definition than this tool allows. Preserve its mutation receipt
  // without returning unbounded rule text or silently presenting a clipped string as the complete filter.
  return { ...summary, typesCount: sub.types.length, filterFieldsCount: Object.keys(sub.filter ?? {}).length, projectionTruncated: true,
    projectionNote: 'The full rule exceeds this tool view. Its current revision and status are shown; inspect the trusted control view before changing rule fields.' };
}

// Current DSH accepts this JSON Schema subset. Bounds are enforced above, not silently delegated to unsupported keywords.
const stringSchema = (description: string) => ({ type: 'string', description });
const integerSchema = (description: string) => ({ type: 'integer', description });
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const scopeSchema = stringSchema('Already granted data scope, 1–256 characters. This selects a scope; it does not grant one.');
const typeListSchema = { type: 'array', items: stringSchema('A type returned by shiyu_event_types.'), description: '1–16 distinct, currently granted event types.' };
const filterSchema = { type: 'object', additionalProperties: true, description: 'At most eight equality filters on registered filterable fields; primitive values only, string values at most 256 characters.' };
const pageSchema = { offset: integerSchema('Offset in the current list, 0–1000000; default 0.'), limit: integerSchema('Maximum items, 1–20; default 10. Output byte limits may return fewer.') };
const targetSchema = { oneOf: [
  objectSchema({ kind: { type: 'string', const: 'agent' }, bindingId: stringSchema('An existing Agent binding already granted by trusted targetRefs, 1–256 characters.') }, ['kind', 'bindingId']),
  objectSchema({ kind: { type: 'string', const: 'component' }, handlerRef: stringSchema('An existing registered component handler already granted by trusted targetRefs; no callback/code/URL.') }, ['kind', 'handlerRef']),
] };
const startSchema = { oneOf: [
  objectSchema({ kind: { type: 'string', const: 'from_now' } }, ['kind']),
  objectSchema({ kind: { type: 'string', const: 'replay' }, afterSequence: integerSchema('Nonnegative accepted event sequence.'), limit: integerSchema('Maximum replay events, 1–100; replayTruncated explicitly reports omitted history.') }, ['kind', 'afterSequence', 'limit']),
] };
const output = {
  schema: objectSchema({ ok: { type: 'boolean' }, operation: { type: 'string' }, value: { type: 'object', additionalProperties: true },
    error: objectSchema({ code: { type: 'string' }, message: { type: 'string' }, nextAction: { type: 'string' } }, ['code', 'message', 'nextAction']) }, ['ok', 'operation']),
  render: (_args: unknown, result: EventToolResult): { type: 'text'; text: string }[] => {
    const encoded = JSON.stringify(result);
    return [{ type: 'text', text: Buffer.byteLength(encoded) <= MAX_OUTPUT_BYTES ? encoded : JSON.stringify(errorResult(result.operation, new Error('Output too large'))) }];
  },
};
interface Installation { service: EventService; resolver: ResolveEventPrincipal; dispose: () => void }
const installations = new WeakMap<EventToolContext, Installation>();

/** Call only inside a managed Agent setup with agent.ctx. This module never registers global tools on import. */
export function installEventTools(ctx: EventToolContext, eventService: EventService, resolvePrincipal: ResolveEventPrincipal): () => void {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function' || typeof resolvePrincipal !== 'function') throw new Error('Session tools and a trusted principal resolver are required');
  const previous = installations.get(ctx);
  if (previous) {
    if (previous.service !== eventService || previous.resolver !== resolvePrincipal) throw new Error('This Session already has event tools with a different trusted binding');
    return previous.dispose;
  }
  let active = true;
  const disposers: (() => void)[] = [];
  const current = (execution?: EventToolExecution) => {
    if (!active) return failure('TOOL_INACTIVE', 'Disposed');
    if (!execution?.agent || typeof execution.agent !== 'object') return failure('FORBIDDEN', 'Trusted execution Agent is required');
    if (execution.signal?.aborted) return failure('CANCELLED', 'Cancelled');
  };
  const register = (name: string, description: string, parameters: Record<string, unknown>, readOnly: boolean,
    action: (actor: EventPrincipal, args: unknown, check: () => void) => Promise<Record<string, unknown>>) => {
    const definition: EventToolDefinition = { name, description, parameters, isConcurrencySafe: readOnly, output,
      async execute(args, execution) {
        try {
          current(execution);
          let actor: EventPrincipal;
          try { actor = principalSnapshot(await resolvePrincipal(execution!)); } catch { return errorResult(name, new EventServiceError('FORBIDDEN', 'Trusted principal resolution failed')); }
          current(execution);
          const value = await action(actor, args, () => current(execution));
          const result: EventToolResult = { ok: true, operation: name, value };
          if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) throw new Error('Tool output exceeds bounded projection');
          return result;
        } catch (error) { return errorResult(name, error); }
      },
    };
    const dispose = ctx.tools.register(definition);
    if (typeof dispose !== 'function') throw new Error('DSH tools.register must return a disposer');
    disposers.push(dispose);
  };
  const dispose = () => {
    if (!active) return;
    active = false; installations.delete(ctx);
    const failures: unknown[] = [];
    for (const unregister of disposers.reverse()) { try { unregister(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'Some event tools could not be unregistered');
  };
  try {
    register('shiyu_event_types', 'Discover currently visible event types and payload rules. This does not grant publish or subscribe authority.', objectSchema(pageSchema), true, async (actor, raw) => {
      const args = input(raw, ['offset', 'limit']); const { offset, limit } = pagination(args);
      const types = (await eventService.types(actor)).map(type => ({ type: type.type, schemaVersion: type.schemaVersion, description: type.description.slice(0, 1000),
        canPublish: !blockedPublishTypes.has(type.type) && !type.publisherIds && actor.publishTypes.includes(type.type) && type.publisherKinds.includes(actor.kind),
        canSubscribe: actor.subscribeTypes.includes(type.type), payloadSchema: type.payloadSchema, filterableFields: type.filterableFields }));
      return { ...page(types, offset, limit), supportedDeliveryModes: ['component', 'background'], wakeSupported: false };
    });
    register('shiyu_event_publish', 'Publish a scoped observation or reported result. Acceptance is not verified task success. Retry with the same idempotencyKey and identical content.', objectSchema({
      type: stringSchema('Registered, granted event type; task.succeeded is reserved and cannot be published by this tool.'), scope: scopeSchema,
      payload: { type: 'object', additionalProperties: true, description: 'Exactly the registered payload schema. Maximum total tool input 24 KiB; each string at most 8192 characters.' },
      idempotencyKey: stringSchema('Stable identity for this logical event, 1–256 characters; keep unchanged across retries.'),
      correlationId: stringSchema('Optional known correlation identity, 1–256 characters.'), causationId: stringSchema('Optional visible accepted event ID, 1–256 characters.'), expiresAt: stringSchema('Optional ISO expiry timestamp, at most 64 characters.'),
    }, ['type', 'scope', 'payload', 'idempotencyKey']), false, async (actor, raw, check) => {
      const args = input(raw, ['type', 'scope', 'payload', 'idempotencyKey', 'correlationId', 'causationId', 'expiresAt']);
      const type = text(args.type, 'type');
      if (blockedPublishTypes.has(type)) return failure('FORBIDDEN', 'Reserved outcome event');
      const definition = (await eventService.types(actor)).find(item => item.type === type);
      if (definition?.publisherIds) return failure('FORBIDDEN', 'Program-owned publisher event');
      check();
      const receipt = await eventService.publish(actor, { type, scope: text(args.scope, 'scope'), payload: object(args.payload) as EventPayload,
        idempotencyKey: text(args.idempotencyKey, 'idempotencyKey'),
        ...(args.correlationId === undefined ? {} : { correlationId: text(args.correlationId, 'correlationId') }),
        ...(args.causationId === undefined ? {} : { causationId: text(args.causationId, 'causationId') }),
        ...(args.expiresAt === undefined ? {} : { expiresAt: timestamp(args.expiresAt, 'expiresAt') }),
      });
      return { ...receipt, meaning: 'Event acceptance only; not task completion, delivery acknowledgement, or LLM execution.' };
    });
    register('shiyu_event_subscribe', 'Create a scoped subscription with a stable id. Agent background delivery only stores a pending reference; it never starts or wakes an LLM.', objectSchema({
      id: stringSchema('Required stable subscription ID, 1–256 characters. Retry the same ID and same definition.'), types: typeListSchema, scope: scopeSchema, target: targetSchema,
      deliveryMode: { type: 'string', enum: ['component', 'background'], description: 'component requires a registered handler; background requires a granted Agent binding. wake is unsupported.' },
      start: startSchema, filter: filterSchema, once: { type: 'boolean' }, expiresAt: stringSchema('Optional ISO expiry timestamp, at most 64 characters.'), maxAttempts: integerSchema('Delivery attempts, 1–10; no model retry loop is created.'),
    }, ['id', 'types', 'scope', 'target', 'deliveryMode', 'start']), false, async (actor, raw) => {
      const args = input(raw, ['id', 'types', 'scope', 'target', 'deliveryMode', 'start', 'filter', 'once', 'expiresAt', 'maxAttempts']);
      if (!['component', 'background'].includes(String(args.deliveryMode))) return failure('UNSUPPORTED', 'Unsupported delivery mode');
      const target = object(args.target, ['kind', 'bindingId', 'handlerRef']);
      let selected: SubscribeInput['target'];
      if (target.kind === 'agent') {
        object(target, ['kind', 'bindingId']); selected = { kind: 'agent', bindingId: text(target.bindingId, 'bindingId') };
      } else if (target.kind === 'component') {
        object(target, ['kind', 'handlerRef']); selected = { kind: 'component', handlerRef: text(target.handlerRef, 'handlerRef') };
      } else return failure('INVALID_INPUT', 'Unknown subscription target');
      const ref = selected.kind === 'agent' ? selected.bindingId : selected.handlerRef;
      if (!actor.targetRefs.includes(ref)) return failure('FORBIDDEN', 'Target is not granted');
      const start = object(args.start, ['kind', 'afterSequence', 'limit']);
      let selectedStart: SubscribeInput['start'];
      if (start.kind === 'from_now') { object(start, ['kind']); selectedStart = { kind: 'from_now' }; }
      else if (start.kind === 'replay') selectedStart = { kind: 'replay', afterSequence: integer(start.afterSequence, 'afterSequence', 0, Number.MAX_SAFE_INTEGER), limit: integer(start.limit, 'replay limit', 1, 100) };
      else return failure('INVALID_INPUT', 'Unknown subscription start');
      if (args.once !== undefined && typeof args.once !== 'boolean') return failure('INVALID_INPUT', 'once must be boolean');
      const sub = await eventService.subscribe(actor, { id: text(args.id, 'id'), types: strings(args.types, 'types'), scope: text(args.scope, 'scope'), target: selected,
        deliveryMode: args.deliveryMode as SubscribeInput['deliveryMode'], start: selectedStart,
        ...(args.filter === undefined ? {} : { filter: filters(args.filter) }), ...(args.once === undefined ? {} : { once: args.once as boolean }),
        ...(args.expiresAt === undefined ? {} : { expiresAt: timestamp(args.expiresAt, 'expiresAt') }),
        ...(args.maxAttempts === undefined ? {} : { maxAttempts: integer(args.maxAttempts, 'maxAttempts', 1, 10) }),
      });
      return subscriptionView(sub);
    });
    register('shiyu_event_list', 'List subscriptions owned by the current principal and still within its grants. Read the current revision before changing a subscription.', objectSchema(pageSchema), true, async (actor, raw) => {
      const args = input(raw, ['offset', 'limit']); const { offset, limit } = pagination(args);
      return page((await eventService.listSubscriptions(actor)).map(subscriptionView), offset, limit);
    });
    register('shiyu_event_update', 'Change only event types, filters, expiry or active/paused state of an owned subscription. Target and scope cannot be reassigned.', objectSchema({
      id: stringSchema('Owned subscription ID, 1–256 characters.'), expectedRevision: integerSchema('Current positive revision from shiyu_event_list.'),
      patch: objectSchema({ types: typeListSchema, filter: filterSchema, status: { type: 'string', enum: ['active', 'paused'] }, expiresAt: { oneOf: [stringSchema('ISO timestamp, at most 64 characters.'), { type: 'null' }] } }),
    }, ['id', 'expectedRevision', 'patch']), false, async (actor, raw) => {
      const args = input(raw, ['id', 'expectedRevision', 'patch']); const rawPatch = object(args.patch, ['types', 'filter', 'status', 'expiresAt']);
      if (!Object.keys(rawPatch).length) return failure('INVALID_INPUT', 'Patch must change a declared field');
      const patch: SubscriptionPatch = {};
      if (rawPatch.types !== undefined) patch.types = strings(rawPatch.types, 'types');
      if (rawPatch.filter !== undefined) patch.filter = filters(rawPatch.filter);
      if (rawPatch.status !== undefined) {
        if (!['active', 'paused'].includes(String(rawPatch.status))) return failure('INVALID_INPUT', 'Invalid subscription status');
        patch.status = rawPatch.status as 'active' | 'paused';
      }
      if (rawPatch.expiresAt !== undefined) patch.expiresAt = rawPatch.expiresAt === null ? null : timestamp(rawPatch.expiresAt, 'expiresAt');
      return subscriptionView(await eventService.update(actor, text(args.id, 'id'), integer(args.expectedRevision, 'expectedRevision', 1, Number.MAX_SAFE_INTEGER), patch));
    });
    register('shiyu_event_unsubscribe', 'Retire an owned subscription at its current revision. Pending deliveries are cancelled; previously completed effects are not undone.', objectSchema({
      id: stringSchema('Owned subscription ID, 1–256 characters.'), expectedRevision: integerSchema('Current positive revision from shiyu_event_list.'),
    }, ['id', 'expectedRevision']), false, async (actor, raw) => {
      const args = input(raw, ['id', 'expectedRevision']);
      return subscriptionView(await eventService.unsubscribe(actor, text(args.id, 'id'), integer(args.expectedRevision, 'expectedRevision', 1, Number.MAX_SAFE_INTEGER)));
    });
    register('shiyu_event_status', 'Read current scoped counts and recent delivery references. This neither claims nor acknowledges deliveries and never wakes a model.', objectSchema({
      subscriptionId: stringSchema('Optional accessible subscription ID.'), limit: integerSchema('Maximum recent delivery references, 1–20; default 10.'),
    }), true, async (actor, raw) => {
      const args = input(raw, ['subscriptionId', 'limit']);
      const limit = args.limit === undefined ? 10 : integer(args.limit, 'limit', 1, 20);
      const stats = await eventService.stats(actor);
      const deliveries = await eventService.listDeliveries(actor, { limit, ...(args.subscriptionId === undefined ? {} : { subscriptionId: text(args.subscriptionId, 'subscriptionId') }) });
      return { counts: stats, countsScope: 'All currently granted events and deliveries, independent of the optional subscription filter.',
        ...page(deliveries.map(item => ({ deliveryId: item.deliveryId, eventId: item.eventId, subscriptionId: item.subscriptionId,
          deliveryMode: item.deliveryMode, status: item.status, attempts: item.attempts, availableAt: item.availableAt })), 0, limit),
        sampleOnly: true, wakeSupported: false, backgroundMeaning: 'Pending references do not imply an Agent has processed them.' };
    });
    installations.set(ctx, { service: eventService, resolver: resolvePrincipal, dispose });
    return dispose;
  } catch (error) {
    try { dispose(); } catch { /* Preserve the registration error; all disposers were attempted. */ }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Worker-side event tools.
//
// A managed worker runs inside the restricted `WorkerSessionDriver` environment:
// only driver-approved tools exist, every call is gated by the current
// Assignment permit, and model arguments can never carry execution authority.
// These helpers are the trusted *source* of the worker's event tools. The
// driver attaches them per Assignment; a worker only ever publishes the event
// types its host-issued principal is granted. `task.succeeded`, verification
// receipts, owner grants and accounting facts stay with their trusted
// components and are not publishable through this surface.
// ---------------------------------------------------------------------------


/** Model-publishable worker report types. Reserved stable business facts are absent by design. */
export const WORKER_EVENT_PUBLISH_TYPES: readonly string[] = Object.freeze(['agent.observation.reported', 'worker.result.reported']);
export const WORKER_EVENT_TOOL_NAMES: readonly string[] = Object.freeze(['shiyu_worker_event_types', 'shiyu_worker_event_report']);

export interface WorkerEventToolOptions {
  service: EventService;
  /** Trusted post-acceptance hook (e.g. wake the single background scanner). Never a model call. */
  onPublished?(receipt: { eventId: string; sequence: number; status: 'accepted' | 'duplicate' }): void;
  /**
   * Trusted host injection. The runtime derives this from the current Assignment
   * binding/permit; the model can never supply or override it. Returning
   * undefined disables both tools for that call (fails closed).
   */
  resolvePrincipal(context: WorkerToolContext): EventPrincipal | null | undefined | Promise<EventPrincipal | null | undefined>;
}

const WORKER_EVENT_INPUT_LIMIT = 16384;

function workerEventInput(value: unknown, keys: string[]): Record<string, unknown> {
  const source = object(value, keys);
  const cloned = json(source) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(cloned)) > WORKER_EVENT_INPUT_LIMIT) return failure('INVALID_INPUT', 'Worker event input exceeds 16 KiB.');
  return cloned;
}

function workerPrincipal(value: unknown): EventPrincipal {
  let actor: EventPrincipal;
  try { actor = principalSnapshot(value); } catch { return failure('FORBIDDEN', 'A current trusted worker event principal is unavailable.'); }
  if (actor.kind !== 'agent') return failure('FORBIDDEN', 'A worker event principal must be a trusted Agent identity.');
  if (actor.scopes.length !== 1) return failure('FORBIDDEN', 'A worker event principal must carry exactly its assignment scope.');
  if (actor.subscribeTypes.length || actor.targetRefs.length) return failure('FORBIDDEN', 'A worker event principal cannot hold subscription authority.');
  const granted = actor.publishTypes.filter(type => WORKER_EVENT_PUBLISH_TYPES.includes(type));
  if (!granted.length) return failure('FORBIDDEN', 'This worker has no granted event report type.');
  return Object.freeze({ ...actor, publishTypes: granted });
}

/**
 * Build the two restricted worker event tools. Names, schemas and handlers are
 * fixed here; the driver additionally enforces its own tool budget, permit
 * gates, authority-key rejection and per-call pre/post rechecks.
 */
export function createWorkerEventTools(options: WorkerEventToolOptions): WorkerTool[] {
  if (!options || typeof options.service !== 'object' || typeof options.resolvePrincipal !== 'function') {
    throw new Error('A worker event tool source needs the durable event service and a trusted principal resolver');
  }
  const { service, resolvePrincipal, onPublished } = options;
  if (onPublished !== undefined && typeof onPublished !== 'function') throw new Error('onPublished must be a function');
  const current = async (context: WorkerToolContext): Promise<EventPrincipal> => {
    context.signal.throwIfAborted();
    const actor = workerPrincipal(await resolvePrincipal(context));
    context.signal.throwIfAborted();
    return actor;
  };
  return [
    {
      name: 'shiyu_worker_event_types',
      description: 'Discover the event report types this Assignment may publish. Returns type, schema version, payload fields, required fields, filterable fields and the trusted assignment scope. This grants nothing and cannot subscribe, wake a model or change task state.',
      parameters: objectSchema({}),
      async execute(raw, context) {
        workerEventInput(raw, []);
        const actor = await current(context);
        await context.assertPermit();
        const types = (await service.types(actor)).map(definition => ({
          type: definition.type, schemaVersion: definition.schemaVersion, description: definition.description.slice(0, 1000),
          canPublish: !blockedPublishTypes.has(definition.type) && !definition.publisherIds && actor.publishTypes.includes(definition.type)
            && definition.publisherKinds.includes(actor.kind),
          payloadFields: definition.payloadSchema.properties, requiredFields: definition.payloadSchema.required,
          filterableFields: definition.filterableFields,
        })).filter(definition => definition.canPublish);
        await context.assertPermit();
        return { scope: actor.scopes[0], canPublish: types.map(definition => definition.type), subscribeSupported: false,
          wakeSupported: false, types,
          meaning: 'Report acceptance is not task completion and does not imply any model was woken.' };
      },
    },
    {
      name: 'shiyu_worker_event_report',
      description: 'Publish one scoped observation or reported result for this Assignment. Actor, scope, source trust level and allowed types are injected by the trusted runtime; they cannot be supplied in arguments. Reserved success facts (task.succeeded), verification receipts, owner grants and accounting facts are rejected. Retry with the same idempotencyKey and identical content.',
      parameters: objectSchema({
        type: stringSchema('A type returned by shiyu_worker_event_types.'),
        payload: { type: 'object', additionalProperties: true, description: 'Exactly the registered payload fields. Maximum input 16 KiB; each string at most 8192 characters.' },
        idempotencyKey: stringSchema('Stable identity for this logical report, 1–256 characters; keep unchanged across retries.'),
        correlationId: stringSchema('Optional bounded correlation identity, 1–256 characters.'),
      }, ['type', 'payload', 'idempotencyKey']),
      async execute(raw, context) {
        const args = workerEventInput(raw, ['type', 'payload', 'idempotencyKey', 'correlationId']);
        const actor = await current(context);
        const type = text(args.type, 'type');
        if (blockedPublishTypes.has(type)) return failure('FORBIDDEN', 'Reserved outcome event');
        if (!WORKER_EVENT_PUBLISH_TYPES.includes(type)) return failure('FORBIDDEN', 'This worker surface cannot publish that event type.');
        if (!actor.publishTypes.includes(type)) return failure('FORBIDDEN', 'Event type is not granted to this worker.');
        const definition = (await service.types(actor)).find(item => item.type === type);
        if (!definition || definition.publisherIds || !definition.publisherKinds.includes('agent')) return failure('FORBIDDEN', 'Program-owned event types cannot be published from a worker.');
        await context.assertPermit();
        const receipt = await service.publish(actor, {
          type, scope: actor.scopes[0]!, payload: object(args.payload) as EventPayload,
          idempotencyKey: text(args.idempotencyKey, 'idempotencyKey'),
          ...(args.correlationId === undefined ? {} : { correlationId: text(args.correlationId, 'correlationId') }),
        });
        await context.assertPermit();
        if (onPublished) { try { onPublished({ eventId: receipt.eventId, sequence: receipt.sequence, status: receipt.status }); } catch { /* wake hints cannot change an already-accepted receipt */ } }
        return { ...receipt, scope: actor.scopes[0], meaning: 'Event acceptance only; not task completion, independent verification, delivery acknowledgement or model execution.' };
      },
    },
  ];
}

/**
 * Per-Assignment event tool source for trusted runtime composition. The grant
 * callback is host-owned: it decides whether an Assignment gets event tools at
 * all and which report types/scope it may use. Returning undefined leaves that
 * Assignment event-free, so this surface is never globally open by default.
 */
export interface WorkerEventGrantInput {
  binding: Readonly<{ taskId: string; assignmentId: string; scope: string; sessionId: string }>;
  identity: Readonly<{ taskId: string; assignmentId: string; scope: string; hostEpoch: string;
    installationGeneration: string; fencingToken: number; leaseExpiresAt: string }>;
}
export interface WorkerEventGrant {
  /** Trusted principal identity for this Assignment (never model arguments). */
  principalId: string;
  scope: string;
  publishTypes: readonly string[];
}
export function createWorkerEventToolSource(options: {
  service: EventService;
  grant(input: WorkerEventGrantInput): WorkerEventGrant | null | undefined;
  /** Trusted wake hint after a durable acceptance; cannot alter the receipt. */
  onPublished?(receipt: { eventId: string; sequence: number; status: 'accepted' | 'duplicate' }): void;
}): import('./workers.js').WorkerEventToolSource {
  if (!options || typeof options.service !== 'object' || typeof options.grant !== 'function') {
    throw new Error('A worker event tool source needs the durable event service and a trusted grant callback');
  }
  return {
    tools(input) {
      const grant = options.grant(input);
      if (!grant) return [];
      if (typeof grant.principalId !== 'string' || !grant.principalId || typeof grant.scope !== 'string' || !grant.scope
        || grant.scope !== input.binding.scope || !Array.isArray(grant.publishTypes) || grant.publishTypes.length > 16
        || grant.publishTypes.some(type => typeof type !== 'string' || !WORKER_EVENT_PUBLISH_TYPES.includes(type))) {
        throw new Error('Worker event grant is invalid or outside the Assignment scope');
      }
      const principal: EventPrincipal = Object.freeze({ principalId: grant.principalId, kind: 'agent' as const,
        scopes: Object.freeze([grant.scope]) as unknown as string[], publishTypes: Object.freeze([...grant.publishTypes]) as unknown as string[],
        subscribeTypes: Object.freeze([]) as unknown as string[], targetRefs: Object.freeze([]) as unknown as string[] });
      return createWorkerEventTools({ service: options.service, resolvePrincipal: () => principal,
        ...(options.onPublished ? { onPublished: options.onPublished } : {}) });
    },
  };
}
