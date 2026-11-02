import { createHash } from 'node:crypto';
import type { EventService } from './index.js';
import { EventRuleStore, type NotificationDestinationRule, type NotificationIntentState } from './rules.js';
import type { EventPrincipal, JsonValue, StoredEvent } from '../../contracts/events.js';

// ---------------------------------------------------------------------------
// H2b notification routing basics.
//
// Destinations are declared by the accepted request/subscription, never inferred
// from association. Every destination receives its own restricted view; there is
// no broadcast. Notification intents are durable plugin-side records so a
// reconnect/restart does not clear delivered/unknown facts. An `unknown` send is
// never retried automatically: only an explicit read-only receipt query can
// converge it. Causation chains are bounded to stop self-echo loops.
// ---------------------------------------------------------------------------

export interface EffectDeliveryReceipt { status: 'delivered' | 'unknown' | 'failed'; receiptRef?: string; reason?: string }
export interface NotificationEffectPort {
  send(input: { intentRef: string; destination: NotificationDestinationRule; view: NotificationView; signal?: AbortSignal }): Promise<EffectDeliveryReceipt>;
  /** Read-only receipt lookup; must not send or re-authorize a new effect. */
  query?(intentRef: string): Promise<EffectDeliveryReceipt | undefined>;
}
export interface NotificationView {
  schemaVersion: 1;
  eventId: string; eventType: string; scope: string; receivedAt: string;
  category: string; destination: { kind: NotificationDestinationRule['kind']; ref: string };
  /** Only fields explicitly allowed for this destination; the rest never leaves. */
  payload: Record<string, JsonValue>;
  payloadFieldNames: string[];
  digest: string;
}
export interface NotificationRouteReceipt {
  evaluatedAt: string;
  rootEventId: string;
  chainDepth: number;
  status: 'no_destination' | 'routed' | 'loop_blocked' | 'deferred' | 'no_change';
  destinations: number;
  sent: number; delivered: number; unknown: number; failed: number; skipped: number; deferred: number;
  items: { destination: { kind: string; ref: string }; state: string; reason?: string; intentRef: string }[];
}
export interface NotificationRouterOptions {
  events: EventService;
  rules: EventRuleStore;
  effect: NotificationEffectPort;
  now?: () => number;
  maxFanout?: number;
  maxChainDepth?: number;
  maxPendingIntents?: number;
}
const DEFAULT_MAX_FANOUT = 8;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_PENDING = 500;
function stableHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export class NotificationRouter {
  private readonly events: EventService;
  private readonly rules: EventRuleStore;
  private readonly effect: NotificationEffectPort;
  private readonly now: () => number;
  private readonly maxFanout: number;
  private readonly maxChainDepth: number;
  private readonly maxPendingIntents: number;
  constructor(options: NotificationRouterOptions) {
    if (!options?.events || !options.rules || !options.effect) throw new Error('Notification router requires event service, rule store and effect port');
    this.events = options.events; this.rules = options.rules; this.effect = options.effect;
    this.now = options.now ?? (() => Date.now());
    const fanout = options.maxFanout ?? DEFAULT_MAX_FANOUT;
    const depth = options.maxChainDepth ?? DEFAULT_MAX_DEPTH;
    const pending = options.maxPendingIntents ?? DEFAULT_MAX_PENDING;
    if (!Number.isSafeInteger(fanout) || fanout < 1 || fanout > 64 || !Number.isSafeInteger(depth) || depth < 1 || depth > 32
      || !Number.isSafeInteger(pending) || pending < 1 || pending > 5000) throw new Error('Invalid notification bounds');
    this.maxFanout = fanout; this.maxChainDepth = depth; this.maxPendingIntents = pending;
  }
  /** Resolve the causal chain depth and root identity from durable events. */
  private async causal(actor: EventPrincipal, event: StoredEvent): Promise<{ depth: number; rootEventId: string; cycle: boolean }> {
    const events = await this.events.listEvents(actor, { limit: 500 });
    const byId = new Map(events.map(item => [item.eventId, item]));
    const visited = new Set<string>([event.eventId]);
    let current: StoredEvent | undefined = event;
    let depth = 1;
    while (current?.causationId) {
      if (visited.has(current.causationId)) return { depth, rootEventId: current.causationId, cycle: true };
      visited.add(current.causationId);
      const cause = byId.get(current.causationId);
      if (!cause) return { depth, rootEventId: current.causationId, cycle: false };
      current = cause;
      depth++;
      if (depth > this.maxChainDepth + 1) break;
    }
    return { depth, rootEventId: current?.eventId ?? event.eventId, cycle: false };
  }
  private restrictedView(event: StoredEvent, destination: NotificationDestinationRule, category: string): NotificationView {
    const allowed = new Set(destination.allowedFields ?? []);
    const payload: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(event.payload)) if (allowed.has(key)) payload[key] = structuredClone(value);
    const payloadFieldNames = Object.keys(payload).sort();
    const view = { schemaVersion: 1 as const, eventId: event.eventId, eventType: event.type, scope: event.scope, receivedAt: event.receivedAt,
      category, destination: { kind: destination.kind, ref: destination.ref }, payload, payloadFieldNames,
      digest: '' };
    view.digest = stableHash({ eventId: event.eventId, eventType: event.type, scope: event.scope, category, destination: view.destination, payload: view.payload });
    return view;
  }
  /**
   * Route one result event to the declared destinations. The caller supplies the
   * durable event and, when relevant, the accepting subscription id whose
   * notification rule is authoritative.
   */
  async route(actor: EventPrincipal, input: { event: StoredEvent; subscriptionId?: string; signal?: AbortSignal }): Promise<NotificationRouteReceipt> {
    const evaluatedAt = new Date(this.now()).toISOString();
    const event = input?.event;
    if (!event || typeof event.eventId !== 'string') throw new Error('INVALID_INPUT');
    const rule = input.subscriptionId ? (await this.rules.getRule(input.subscriptionId))?.notification : undefined;
    if (!rule) return { evaluatedAt, rootEventId: event.correlationId ?? event.eventId, chainDepth: 1, status: 'no_destination',
      destinations: 0, sent: 0, delivered: 0, unknown: 0, failed: 0, skipped: 0, deferred: 0, items: [] };
    const causal = await this.causal(actor, event);
    if (causal.cycle || causal.depth > this.maxChainDepth) {
      await this.rules.recordGap(input.subscriptionId!, causal.cycle ? 'NOTIFICATION_CAUSAL_CYCLE' : 'NOTIFICATION_CHAIN_DEPTH_LIMIT');
      return { evaluatedAt, rootEventId: causal.rootEventId, chainDepth: causal.depth, status: 'loop_blocked',
        destinations: rule.destinations.length, sent: 0, delivered: 0, unknown: 0, failed: 0, skipped: rule.destinations.length, deferred: 0,
        items: rule.destinations.map(destination => ({ destination: { kind: destination.kind, ref: destination.ref }, state: 'skipped', reason: causal.cycle ? 'CAUSAL_CYCLE' : 'CHAIN_DEPTH_LIMIT', intentRef: '' })) };
    }
    const selected = rule.destinations.slice(0, this.maxFanout);
    const deferred = rule.destinations.length - selected.length;
    const intents = await this.rules.listNotificationIntents();
    if (intents.filter(intent => intent.state === 'pending' || intent.state === 'unknown').length >= this.maxPendingIntents) {
      return { evaluatedAt, rootEventId: causal.rootEventId, chainDepth: causal.depth, status: 'deferred',
        destinations: rule.destinations.length, sent: 0, delivered: 0, unknown: 0, failed: 0, skipped: 0, deferred: rule.destinations.length, items: [] };
    }
    const receipt: NotificationRouteReceipt = { evaluatedAt, rootEventId: causal.rootEventId, chainDepth: causal.depth, status: 'routed',
      destinations: rule.destinations.length, sent: 0, delivered: 0, unknown: 0, failed: 0, skipped: 0, deferred, items: [] };
    for (const destination of selected) {
      input.signal?.throwIfAborted();
      const intentRef = `notify:${causal.rootEventId}:${event.eventId}:${destination.kind}:${destination.ref}:${rule.category}`.slice(0, 400);
      const previous = await this.rules.getNotificationIntent(intentRef);
      if (previous) {
        receipt.skipped++;
        receipt.items.push({ destination: { kind: destination.kind, ref: destination.ref }, state: previous.state,
          reason: previous.state === 'unknown' ? 'UNKNOWN_NOT_RETRIED' : 'INTENT_ALREADY_SETTLED', intentRef });
        continue;
      }
      const view = this.restrictedView(event, destination, rule.category);
      const pending: NotificationIntentState = { schemaVersion: 1, intentRef, destinationRef: `${destination.kind}:${destination.ref}`,
        category: rule.category, state: 'pending', at: new Date(this.now()).toISOString(), viewDigest: view.digest };
      await this.rules.putNotificationIntent(pending);
      let delivery: EffectDeliveryReceipt;
      try {
        delivery = await this.effect.send({ intentRef, destination, view, ...(input.signal ? { signal: input.signal } : {}) });
      } catch (error) {
        delivery = { status: 'unknown', reason: error instanceof Error ? error.message.slice(0, 200) : 'EFFECT_SEND_THREW' };
      }
      if (!delivery || !['delivered', 'unknown', 'failed'].includes(delivery.status)) delivery = { status: 'unknown', reason: 'EFFECT_RECEIPT_INVALID' };
      receipt.sent++;
      const settled: NotificationIntentState = { ...pending, state: delivery.status,
        ...(delivery.receiptRef ? { receiptRef: delivery.receiptRef } : {}), at: new Date(this.now()).toISOString() };
      await this.rules.putNotificationIntent(settled);
      if (delivery.status === 'delivered') receipt.delivered++;
      else if (delivery.status === 'unknown') receipt.unknown++;
      else receipt.failed++;
      receipt.items.push({ destination: { kind: destination.kind, ref: destination.ref }, state: delivery.status,
        ...(delivery.reason ? { reason: delivery.reason } : {}), intentRef });
    }
    if (deferred) receipt.items.push({ destination: { kind: 'deferred', ref: `${deferred}` }, state: 'deferred', reason: 'FANOUT_LIMIT', intentRef: '' });
    return receipt;
  }
  /** Read-only convergence for an unknown/lost receipt. Never sends again. */
  async reconcile(intentRef: string): Promise<{ intent: NotificationIntentState; receipt?: EffectDeliveryReceipt; changed: boolean }> {
    const intent = await this.rules.getNotificationIntent(intentRef);
    if (!intent) throw new Error('NOT_FOUND');
    if (!this.effect.query) return { intent, changed: false };
    const receipt = await this.effect.query(intentRef);
    if (!receipt || !['delivered', 'unknown', 'failed'].includes(receipt.status)) return { intent, ...(receipt ? { receipt } : {}), changed: false };
    if (receipt.status === intent.state && receipt.receiptRef === intent.receiptRef) return { intent, receipt, changed: false };
    const next: NotificationIntentState = { ...intent, state: receipt.status, ...(receipt.receiptRef ? { receiptRef: receipt.receiptRef } : {}),
      at: new Date(this.now()).toISOString() };
    await this.rules.putNotificationIntent(next);
    return { intent: next, receipt, changed: true };
  }
}
