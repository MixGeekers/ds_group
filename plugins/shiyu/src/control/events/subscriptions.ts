import { EventService } from './index.js';
import { EventRuleStore, evaluateCondition, validateDeclarativeCondition, validateNotificationRule, validateObservationRule, validateOnceWaitRule, validateTimeRule,
  type DeclarativeCondition, type NotificationRule, type ObservationRule, type OnceWaitRule, type SubscriptionRuleDocument, type TimeRule } from './rules.js';
import type { EventPrincipal, EventTypeDefinition, JsonPrimitive, StoredEvent, StoredSubscription, SubscribeInput, SubscriptionPatch } from '../../contracts/events.js';

/** Trusted caller input. Declarative H2b extensions are stored plugin-side and
 * never grant delivery, model or effect authority by themselves. */
export interface H2bSubscribeInput extends SubscribeInput {
  condition?: DeclarativeCondition;
  notification?: NotificationRule;
  time?: TimeRule;
  observation?: ObservationRule;
  onceWait?: OnceWaitRule;
}
export interface H2bSubscriptionPatch extends SubscriptionPatch {
  condition?: DeclarativeCondition | null;
  notification?: NotificationRule | null;
  time?: TimeRule | null;
  observation?: ObservationRule | null;
}
export interface H2bSubscriptionView extends StoredSubscription {
  conditionRevision: number;
  condition?: DeclarativeCondition;
  notification?: NotificationRule;
  time?: TimeRule;
  observation?: ObservationRule;
  onceWait?: OnceWaitRule;
  retiredAt?: string;
  gaps: string[];
}
export interface ConditionDecision { matched: boolean; reason?: string; conditionRevision?: number }
const RULE_STORE_KEYS = ['condition', 'notification', 'time', 'observation'] as const;
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function gapFor(rule: SubscriptionRuleDocument | undefined, subscription: StoredSubscription, now: number): string[] {
  if (!rule) return ['RULE_METADATA_MISSING'];
  const gaps: string[] = [];
  if (rule.retiredAt && subscription.status !== 'retired') gaps.push('RULE_RETIRED_BUT_SUBSCRIPTION_ACTIVE');
  if (subscription.expiresAt && Date.parse(subscription.expiresAt) <= now && subscription.status !== 'retired') gaps.push('SUBSCRIPTION_EXPIRED');
  return gaps;
}
/** Subscription lifecycle + declarative condition layer over the durable control
 * store. The store remains authoritative for acceptance/delivery/generation; the
 * plugin-owned rule file only holds bounded declarative metadata and observations. */
export class SubscriptionLifecycleService {
  private readonly events: EventService;
  private readonly rules: EventRuleStore;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(options: { events: EventService; rules: EventRuleStore; now?: () => number }) {
    if (!options?.events || !options.rules) throw new Error('Subscription lifecycle requires the durable event service and rule store');
    this.events = options.events; this.rules = options.rules; this.now = options.now ?? (() => Date.now());
  }
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.locks.set(id, next);
    void next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id); }).catch(() => undefined);
    return next;
  }
  private async typeDefinitions(actor: EventPrincipal, types: readonly string[]): Promise<EventTypeDefinition[]> {
    const all = await this.events.types(actor);
    return all.filter(definition => types.includes(definition.type));
  }
  private validateExtensions(types: readonly EventTypeDefinition[], extensions: {
    condition?: unknown; notification?: unknown; time?: unknown; observation?: unknown; onceWait?: unknown;
  }): { condition?: DeclarativeCondition; notification?: NotificationRule; time?: TimeRule; observation?: ObservationRule; onceWait?: OnceWaitRule } {
    if (Object.keys(extensions).some(key => ![...RULE_STORE_KEYS, 'onceWait'].includes(key))) throw new Error('RULE_INVALID_EXTENSION');
    return {
      ...(extensions.condition !== undefined ? { condition: validateDeclarativeCondition(extensions.condition, types) } : {}),
      ...(extensions.notification !== undefined ? { notification: validateNotificationRule(extensions.notification) } : {}),
      ...(extensions.time !== undefined ? { time: validateTimeRule(extensions.time) } : {}),
      ...(extensions.observation !== undefined ? { observation: validateObservationRule(extensions.observation) } : {}),
      ...(extensions.onceWait !== undefined ? { onceWait: validateOnceWaitRule(extensions.onceWait) } : {}),
    };
  }
  private async view(subscription: StoredSubscription): Promise<H2bSubscriptionView> {
    const rule = await this.rules.getRule(subscription.id);
    return { ...structuredClone(subscription), conditionRevision: rule?.conditionRevision ?? 0,
      ...(rule?.condition ? { condition: structuredClone(rule.condition) } : {}),
      ...(rule?.notification ? { notification: structuredClone(rule.notification) } : {}),
      ...(rule?.time ? { time: structuredClone(rule.time) } : {}),
      ...(rule?.observation ? { observation: structuredClone(rule.observation) } : {}),
      ...(rule?.onceWait ? { onceWait: structuredClone(rule.onceWait) } : {}),
      ...(rule?.retiredAt ? { retiredAt: rule.retiredAt } : {}),
      gaps: gapFor(rule, subscription, this.now()) };
  }
  private async owned(actor: EventPrincipal, id: string): Promise<StoredSubscription> {
    const subscription = (await this.events.listSubscriptions(actor)).find(item => item.id === id);
    if (!subscription) throw new Error('NOT_FOUND');
    return subscription;
  }
  async subscribe(actor: EventPrincipal, input: H2bSubscribeInput): Promise<H2bSubscriptionView> {
    if (!isObject(input)) throw new Error('RULE_INVALID_INPUT');
    const { condition, notification, time, observation, onceWait, ...storeInput } = input;
    const types = await this.typeDefinitions(actor, storeInput.types);
    const extensions = this.validateExtensions(types, { condition, notification, time, observation, onceWait });
    if (extensions.onceWait) {
      if (storeInput.deliveryMode !== 'background' || storeInput.target?.kind !== 'agent' || storeInput.target.bindingId !== extensions.onceWait.targetBindingId
        || storeInput.once !== true) throw new Error('RULE_INVALID_WAIT');
      if (storeInput.expiresAt !== extensions.onceWait.expiresAt) throw new Error('RULE_INVALID_WAIT');
    }
    const subscription = await this.events.subscribe(actor, storeInput);
    const rule = await this.rules.putRule({ subscriptionId: subscription.id, conditionRevision: 1,
      ownerPrincipal: { principalId: actor.principalId, kind: actor.kind, scopes: [...actor.scopes], publishTypes: [...actor.publishTypes],
        subscribeTypes: [...actor.subscribeTypes], targetRefs: [...actor.targetRefs] }, ...extensions });
    return this.viewWith(subscription, rule);
  }
  private viewWith(subscription: StoredSubscription, rule: SubscriptionRuleDocument): H2bSubscriptionView {
    return { ...structuredClone(subscription), conditionRevision: rule.conditionRevision,
      ...(rule.condition ? { condition: structuredClone(rule.condition) } : {}),
      ...(rule.notification ? { notification: structuredClone(rule.notification) } : {}),
      ...(rule.time ? { time: structuredClone(rule.time) } : {}),
      ...(rule.observation ? { observation: structuredClone(rule.observation) } : {}),
      ...(rule.onceWait ? { onceWait: structuredClone(rule.onceWait) } : {}),
      gaps: gapFor(rule, subscription, this.now()) };
  }
  /** Update store-level rule fields and/or declarative extensions with CAS.
   * Changing declarative-only metadata fences the old activation generation via
   * pause/resume so already-created pending deliveries cannot be dispatched under
   * the previous rule; the same event still never becomes a second match because
   * the durable delivery identity excludes activationGeneration. */
  async update(actor: EventPrincipal, id: string, expectedRevision: number, patch: H2bSubscriptionPatch): Promise<H2bSubscriptionView> {
    const rawPatch: unknown = patch;
    if (!isObject(rawPatch)) throw new Error('RULE_INVALID_INPUT');
    return this.serial(id, async () => {
      const current = await this.owned(actor, id);
      if (current.revision !== expectedRevision) throw new Error('REVISION_CONFLICT');
      const storePatch: SubscriptionPatch = {};
      for (const key of ['types', 'filter', 'status', 'expiresAt'] as const) if (patch[key] !== undefined) (storePatch as Record<string, unknown>)[key] = patch[key];
      const hasStore = Object.keys(storePatch).length > 0;
      const hasExtensions = RULE_STORE_KEYS.some(key => patch[key] !== undefined);
      if (!hasStore && !hasExtensions) throw new Error('RULE_INVALID_INPUT');
      const selectedTypes: readonly string[] = patch.types !== undefined ? patch.types : current.types;
      const types = await this.typeDefinitions(actor, selectedTypes);
      const priorRule = await this.rules.getRule(id);
      const validated = this.validateExtensions(types, { condition: patch.condition ?? undefined, notification: patch.notification ?? undefined,
        time: patch.time ?? undefined, observation: patch.observation ?? undefined });
      const removed = { condition: patch.condition === null, notification: patch.notification === null, time: patch.time === null, observation: patch.observation === null };
      let subscription = current;
      if (hasStore) subscription = await this.events.update(actor, id, expectedRevision, storePatch);
      if (hasExtensions) {
        const conditionRevision = (priorRule?.conditionRevision ?? 0) + 1;
        const condition = removed.condition ? undefined : (validated.condition ?? priorRule?.condition);
        const notification = removed.notification ? undefined : (validated.notification ?? priorRule?.notification);
        const timeRule = removed.time ? undefined : (validated.time ?? priorRule?.time);
        const observation = removed.observation ? undefined : (validated.observation ?? priorRule?.observation);
        await this.rules.putRule({ subscriptionId: id, conditionRevision,
          ...(condition ? { condition } : {}), ...(notification ? { notification } : {}),
          ...(timeRule ? { time: timeRule } : {}), ...(observation ? { observation } : {}),
          ...(priorRule?.onceWait ? { onceWait: priorRule.onceWait } : {}),
          ...(priorRule?.ownerPrincipal ? { ownerPrincipal: priorRule.ownerPrincipal } : {}),
          ...(priorRule?.retiredAt ? { retiredAt: priorRule.retiredAt } : {}) });
        // A declarative-only change does not change the store's ruleRevision, so
        // explicitly close the current activation generation and cancel pending
        // deliveries. Paused/retired subscriptions are not reactivated.
        const ruleChanged = hasStore && (patch.types !== undefined || patch.filter !== undefined || patch.expiresAt !== undefined);
        if (!ruleChanged && subscription.status === 'active') {
          const paused = await this.events.update(actor, id, subscription.revision, { status: 'paused' });
          subscription = await this.events.update(actor, id, paused.revision, { status: 'active' });
        }
      }
      return this.view(subscription);
    });
  }
  async pause(actor: EventPrincipal, id: string, expectedRevision: number): Promise<H2bSubscriptionView> {
    return this.update(actor, id, expectedRevision, { status: 'paused' });
  }
  async resume(actor: EventPrincipal, id: string, expectedRevision: number): Promise<H2bSubscriptionView> {
    return this.update(actor, id, expectedRevision, { status: 'active' });
  }
  async unsubscribe(actor: EventPrincipal, id: string, expectedRevision: number): Promise<H2bSubscriptionView> {
    return this.serial(id, async () => {
      const subscription = await this.events.unsubscribe(actor, id, expectedRevision);
      await this.rules.retireRule(id);
      return this.view(subscription);
    });
  }
  async list(actor: EventPrincipal): Promise<H2bSubscriptionView[]> {
    const subscriptions = await this.events.listSubscriptions(actor);
    return Promise.all(subscriptions.map(subscription => this.view(subscription)));
  }
  async status(actor: EventPrincipal, id: string): Promise<H2bSubscriptionView & { deliveries: Awaited<ReturnType<EventService['listDeliveries']>>; counts: Awaited<ReturnType<EventService['stats']>> }> {
    const view = await this.serial(id, async () => this.view(await this.owned(actor, id)));
    return { ...view, deliveries: await this.events.listDeliveries(actor, { subscriptionId: id, limit: 20 }), counts: await this.events.stats(actor) };
  }
  /** Deterministic declarative condition evaluation for one claimed delivery.
   * `changed` compares against the last value observed for this subscription. */
  async evaluateDelivery(actor: EventPrincipal, subscriptionId: string, event: StoredEvent): Promise<ConditionDecision> {
    const subscription = await this.owned(actor, subscriptionId);
    const rule = await this.rules.getRule(subscriptionId);
    if (!rule) return { matched: false, reason: 'RULE_METADATA_MISSING' };
    if (subscription.status !== 'active') return { matched: false, reason: 'SUBSCRIPTION_INACTIVE' };
    if (subscription.expiresAt && Date.parse(subscription.expiresAt) <= this.now()) return { matched: false, reason: 'SUBSCRIPTION_EXPIRED' };
    if (!rule.condition) return { matched: true };
    const state = await this.rules.getConditionState(subscriptionId);
    const previous = state?.lastSeen ?? {};
    const matched = evaluateCondition(rule.condition, event.payload as Record<string, unknown>, previous);
    const nextSeen: Record<string, JsonPrimitive> = { ...previous };
    for (const predicate of rule.condition.predicates) {
      const value = (event.payload as Record<string, unknown>)[predicate.field];
      if (value === null || typeof value === 'boolean' || typeof value === 'number' || (typeof value === 'string' && value.length <= 256)) nextSeen[predicate.field] = value as JsonPrimitive;
    }
    await this.rules.putConditionState(subscriptionId, { schemaVersion: 1, lastSeen: nextSeen, at: new Date(this.now()).toISOString() });
    return { matched, ...(matched ? {} : { reason: 'CONDITION_NOT_MATCHED' }), conditionRevision: rule.conditionRevision };
  }
}
/** Owner-scoped durable subscription reader for trusted runtime composition
 * (time source, dashboards). It reconstructs only the trusted creating
 * principal recorded with the rule and never accepts a caller-supplied owner. */
export class RuleStoreSubscriptionReader {
  constructor(private readonly rules: EventRuleStore, private readonly events: EventService) {}
  async read(subscriptionId: string): Promise<StoredSubscription | undefined> {
    const rule = await this.rules.getRule(subscriptionId);
    const owner = rule?.ownerPrincipal;
    if (!owner) return undefined;
    const subscriptions = await this.events.listSubscriptions(owner as EventPrincipal);
    return subscriptions.find(subscription => subscription.id === subscriptionId);
  }
  async list(): Promise<StoredSubscription[]> {
    const rules = await this.rules.listRules();
    const result: StoredSubscription[] = [];
    for (const rule of rules) {
      const subscription = await this.read(rule.subscriptionId);
      if (subscription) result.push(subscription);
    }
    return result;
  }
}

/** Wrap one trusted Agent continuation target with declarative condition checks. */
export interface AgentContinuationTargetLike {
  bindingId: string;
  mode: 'background' | 'continuation';
  updateBackground(input: any): Promise<{ referenceId: string; duplicate: boolean }>;
  evaluateContinuation?(input: any): Promise<{ allowed: boolean; reason?: string }>;
  dispatchContinuation?(input: any): Promise<any>;
}
export function withDeclarativeCondition<T extends AgentContinuationTargetLike>(target: T, lifecycle: SubscriptionLifecycleService,
  actor: EventPrincipal): T {
  const evaluate = async (input: any): Promise<{ allowed: boolean; reason?: string }> => {
    const decision = await lifecycle.evaluateDelivery(actor, input.subscriptionId, input.event);
    if (!decision.matched) return { allowed: false, reason: decision.reason ?? 'CONDITION_NOT_MATCHED' };
    return target.evaluateContinuation ? target.evaluateContinuation(input) : { allowed: false, reason: 'NO_CONTINUATION_GATE' };
  };
  return {
    ...target,
    async updateBackground(input: any) {
      // A failed/blocked condition still commits the durable zero-model reference;
      // it only suppresses continuation wake.
      return target.updateBackground(input);
    },
    async evaluateContinuation(input: any) { return evaluate(input); },
    async dispatchContinuation(input: any) {
      const decision = await evaluate(input);
      if (!decision.allowed) throw new Error(`Core continuation denied: ${decision.reason ?? 'CONDITION_NOT_MATCHED'}`);
      return target.dispatchContinuation!(input);
    },
  } as T;
}

// ---------------------------------------------------------------------------
// One-shot wait over a background Agent subscription. Waiting is pure durable
// control state: it never occupies a worker slot and never calls a model. On a
// matched delivery the trusted gate must still revalidate current Assignment /
// Goal qualification, pause state and budget before any continuation.
// ---------------------------------------------------------------------------
export interface OnceWaitGateContext {
  subscriptionId: string;
  wait: OnceWaitRule;
  deliveryId: string;
  event: StoredEvent;
}
export type OnceWaitGate = (context: OnceWaitGateContext) => Promise<{ allowed: boolean; reason?: string }>;
export interface OnceWaitOptions { events: EventService; lifecycle: SubscriptionLifecycleService; rules: EventRuleStore; now?: () => number }
export class OnceWaitService {
  private readonly events: EventService;
  private readonly lifecycle: SubscriptionLifecycleService;
  private readonly rules: EventRuleStore;
  private readonly now: () => number;
  constructor(options: OnceWaitOptions) {
    if (!options?.events || !options.lifecycle || !options.rules) throw new Error('Once wait requires event service, lifecycle and rule store');
    this.events = options.events; this.lifecycle = options.lifecycle; this.rules = options.rules; this.now = options.now ?? (() => Date.now());
  }
  /** Create the one-shot wait. `input.once` and `input.expiresAt` are mandatory. */
  async start(actor: EventPrincipal, input: H2bSubscribeInput): Promise<H2bSubscriptionView> {
    if (!input?.onceWait) throw new Error('RULE_INVALID_WAIT');
    return this.lifecycle.subscribe(actor, { ...input, deliveryMode: 'background', once: true,
      target: { kind: 'agent', bindingId: input.onceWait.targetBindingId } });
  }
  async cancel(actor: EventPrincipal, subscriptionId: string, expectedRevision: number): Promise<H2bSubscriptionView> {
    const view = await this.lifecycle.unsubscribe(actor, subscriptionId, expectedRevision);
    await this.rules.putWaitOutcome({ schemaVersion: 1, subscriptionId, state: 'cancelled', at: new Date(this.now()).toISOString() });
    return view;
  }
  async status(actor: EventPrincipal, subscriptionId: string): Promise<{ view: H2bSubscriptionView; outcome: Awaited<ReturnType<EventRuleStore['getWaitOutcome']>> }> {
    return { view: await this.lifecycle.status(actor, subscriptionId), outcome: await this.rules.getWaitOutcome(subscriptionId) };
  }
  /**
   * Claim and settle at most one bounded batch of background deliveries for the
   * trusted consumer. A failed qualification keeps only the zero-model background
   * reference; no continuation or retry loop is invented here.
   */
  async consume(actor: EventPrincipal, consumer: EventPrincipal, gate: OnceWaitGate, limit = 10): Promise<{
    claimed: number; matched: number; backgroundOnly: number; expired: number;
    outcomes: { subscriptionId: string; deliveryId: string; state: string; reason?: string; eventId?: string }[];
  }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('INVALID_INPUT');
    const claims = await this.events.claim(consumer, { consumerId: 'shiyu-once-wait', deliveryMode: 'background', limit, leaseMs: 30000 });
    const outcomes: { subscriptionId: string; deliveryId: string; state: string; reason?: string; eventId?: string }[] = [];
    let matched = 0, backgroundOnly = 0, expired = 0;
    for (const claim of claims) {
      const subscription = (await this.events.listSubscriptions(actor)).find(item => item.id === claim.subscriptionId);
      const rule = subscription && await this.rules.getRule(claim.subscriptionId);
      const wait = rule?.onceWait;
      const receipt = { subscriptionId: claim.subscriptionId, deliveryId: claim.deliveryId, state: 'background_only', eventId: claim.eventId } as { subscriptionId: string; deliveryId: string; state: string; reason?: string; eventId?: string };
      try {
        if (!subscription || !wait || !rule || subscription.status !== 'active' || (subscription.target.kind === 'agent' ? subscription.target.bindingId : '') !== wait.targetBindingId) {
          receipt.state = 'background_only'; receipt.reason = 'WAIT_NOT_CURRENT';
        } else if (subscription.expiresAt && Date.parse(subscription.expiresAt) <= this.now()) {
          receipt.state = 'expired'; receipt.reason = 'WAIT_EXPIRED'; expired++;
        } else {
          const condition = await this.lifecycle.evaluateDelivery(actor, claim.subscriptionId, claim.event);
          if (!condition.matched) { receipt.reason = condition.reason ?? 'CONDITION_NOT_MATCHED'; }
          else {
            const verdict = await gate({ subscriptionId: claim.subscriptionId, wait, deliveryId: claim.deliveryId, event: claim.event });
            if (!verdict || typeof verdict.allowed !== 'boolean') throw new Error('WAIT_GATE_INVALID');
            if (verdict.allowed) { receipt.state = 'matched'; matched++; }
            else { receipt.reason = verdict.reason ?? 'QUALIFICATION_DENIED'; }
          }
        }
      } catch (error) {
        receipt.state = 'background_only'; receipt.reason = error instanceof Error ? error.message.slice(0, 200) : 'WAIT_FAILED';
      }
      try { await this.events.ack(consumer, { deliveryId: claim.deliveryId, claimToken: claim.claimToken }); }
      catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code) : '';
        receipt.state = 'background_only'; receipt.reason = code === 'STALE_CLAIM' ? 'STALE_CLAIM' : receipt.reason ?? 'ACK_UNCONFIRMED';
      }
      if (receipt.state !== 'matched' && receipt.state !== 'expired') backgroundOnly++;
      await this.rules.putWaitOutcome({ schemaVersion: 1, subscriptionId: claim.subscriptionId, state: receipt.state as 'matched' | 'background_only' | 'expired',
        eventId: claim.eventId, deliveryId: claim.deliveryId, ...(receipt.reason ? { reason: receipt.reason } : {}), at: new Date(this.now()).toISOString() });
      outcomes.push(receipt);
    }
    return { claimed: claims.length, matched, backgroundOnly, expired, outcomes };
  }
}
