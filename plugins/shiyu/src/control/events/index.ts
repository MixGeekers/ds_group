import { ControlStore } from "../../adapters/control-store/index.js";
import { EventServiceError } from "../../contracts/events.js";
import type {
  AckInput, ClaimInput, ClaimedDelivery, EventPrincipal, FailInput, PublishEventInput,
  StoredDelivery, StoredEvent, StoredSubscription, SubscribeInput, SubscriptionPatch,
} from "../../contracts/events.js";

/** Shared Agent/host facade. The trusted caller binds principal outside model tool arguments. */
export class EventService {
  constructor(private readonly store: ControlStore) {}
  types(principal: EventPrincipal) { return this.store.request("types", { principal }); }
  publish(principal: EventPrincipal, input: PublishEventInput) { return this.store.request("publish", { principal, input }); }
  subscribe(principal: EventPrincipal, input: SubscribeInput) { return this.store.request("subscribe", { principal, input }); }
  listSubscriptions(principal: EventPrincipal) { return this.store.request("listSubscriptions", { principal }); }
  update(principal: EventPrincipal, id: string, expectedRevision: number, patch: SubscriptionPatch) {
    return this.store.request("update", { principal, id, expectedRevision, patch });
  }
  unsubscribe(principal: EventPrincipal, id: string, expectedRevision: number) {
    return this.store.request("unsubscribe", { principal, id, expectedRevision });
  }
  listEvents(principal: EventPrincipal, options: { limit?: number } = {}) {
    return this.store.request("listEvents", { principal, ...options });
  }
  listDeliveries(principal: EventPrincipal, options: { subscriptionId?: string; limit?: number } = {}) {
    return this.store.request("listDeliveries", { principal, ...options });
  }
  claim(principal: EventPrincipal, input: ClaimInput) { return this.store.request("claim", { principal, input }); }
  ack(principal: EventPrincipal, input: AckInput) { return this.store.request("ack", { principal, input }); }
  fail(principal: EventPrincipal, input: FailInput) { return this.store.request("fail", { principal, input }); }
  stats(principal: EventPrincipal) { return this.store.request("stats", { principal }); }
}

// ---------------------------------------------------------------------------
// Durable delivery coordination for the four publication/subscription paths.
//
// The control store owns acceptance, subscription revisions/generations and
// per-delivery claim/ack durability. This coordinator is the trusted runtime
// bridge between those durable deliveries and their concrete consumers:
//
//   component -> component : registered, zero-model handler + independent effect
//   component -> agent     : durable background reference and/or continuation gate
//   agent -> component     : model reports through mounted tools, component consumes
//   agent -> agent         : model reports, a bound Agent consumes after a gate
//
// It never calls a model itself. A continuation is dispatched only after the
// injected trusted gate accepts the *current* Goal/authorization/instance/budget
// state; a rejected or revoked gate degrades to a durable background reference
// and does not wake anything. Delivery ack, background-reference commit and the
// native "context loaded" receipt are distinct outcomes in every batch receipt.
// ---------------------------------------------------------------------------

export type DeliveryMode = "component" | "background";

export interface ComponentEventDelivery {
  deliveryId: string;
  eventId: string;
  subscriptionId: string;
  ruleRevision: number;
  activationGeneration: number;
  event: StoredEvent;
  signal: AbortSignal;
}

export interface AgentEventDelivery {
  deliveryId: string;
  eventId: string;
  subscriptionId: string;
  ruleRevision: number;
  activationGeneration: number;
  bindingId: string;
  event: StoredEvent;
  signal: AbortSignal;
}

export interface BackgroundReferenceReceipt {
  /** Stable consumer-side reference identity, normally derived from deliveryId. */
  referenceId: string;
  /** True when this exact delivery was already projected (idempotent retry). */
  duplicate: boolean;
}

export interface ContinuationEvaluation {
  /** False means "background reference only"; no native inbox or model wake. */
  allowed: boolean;
  /** Stable machine-readable cause when denied, e.g. PAUSED/REVOKED/BUDGET. */
  reason?: string;
}

export interface ContinuationContextReceipt {
  sessionId: string;
  eventSeq: number;
  messageId: string;
  /** Confirmed only after official flush + independent durable readback. */
  durability: "confirmed";
}

/** Durable component consumer. Must not call a model and must be idempotent per deliveryId. */
export interface ComponentEventConsumer {
  handlerRef: string;
  consume(input: ComponentEventDelivery): Promise<{ effectRef: string }>;
}

/** Trusted binding of one Agent subscription target. Supplied by host composition. */
export interface AgentEventTarget {
  bindingId: string;
  /** "background" never wakes; "continuation" first projects a reference, then may continue. */
  mode: "background" | "continuation";
  /** Durable zero-model background marker. Required for every claimed delivery. */
  updateBackground(input: AgentEventDelivery): Promise<BackgroundReferenceReceipt>;
  /** Current Goal/authorization/instance/budget gate. Only called in continuation mode. */
  evaluateContinuation?(input: AgentEventDelivery): Promise<ContinuationEvaluation>;
  /** Native inbox dispatch with precise readback; never a model call in this slice. */
  dispatchContinuation?(input: AgentEventDelivery & { reference: BackgroundReferenceReceipt }): Promise<ContinuationContextReceipt>;
}

export type DeliveryDecisionKind = "component" | "background" | "continuation";
export type DeliveryOutcome = "acked" | "retrying" | "failed" | "stale";

export interface DeliveryDecision {
  deliveryId: string;
  eventId: string;
  subscriptionId: string;
  target: "component" | "agent";
  kind: DeliveryDecisionKind;
  outcome: DeliveryOutcome;
  /** Component consumption or background reference receipt. */
  effectRef?: string;
  referenceId?: string;
  /** Continuation only: true when a native inbox dispatch was confirmed. */
  dispatched?: boolean;
  contextReceipt?: ContinuationContextReceipt;
  /** Why a continuation was not dispatched (e.g. PAUSED) while the reference was still committed. */
  continuationReason?: string;
  errorCode?: string;
}

export interface DeliveryBatch {
  claimed: number;
  processed: number;
  failed: number;
  deliveries: DeliveryDecision[];
}

export interface EventDeliveryCoordinatorOptions {
  events: EventService;
  /** Trusted runtime component identity. Its grants must cover every handler/binding below. */
  principal: EventPrincipal;
  handlers?: readonly ComponentEventConsumer[];
  agentTargets?: readonly AgentEventTarget[];
  consumerId?: string;
  /** Bounds one handler/port call so a slow consumer cannot starve the batch forever. */
  handlerTimeoutMs?: number;
  /** Bounded retry backoff written for failed deliveries. */
  retryDelayMs?: number;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_MS = 1000;
const MAX_LIMIT = 20;
const codeOf = (error: unknown): string =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z_]{1,80}$/.test(error.code)
    ? error.code : "CONSUMER_FAILED";

class DeliveryTimeoutError extends Error {
  readonly code = "CONSUMER_TIMEOUT";
  constructor() { super("Durable delivery consumer exceeded its bounded time"); this.name = "DeliveryTimeoutError"; }
}

function deadline<T>(work: Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  if (parent?.aborted) return Promise.reject(parent.reason ?? new EventServiceError("CANCELLED", "Delivery consumer cancelled."));
  let timer!: ReturnType<typeof setTimeout>;
  const controller = new AbortController();
  const stop = () => controller.abort(parent?.reason ?? new EventServiceError("CANCELLED", "Delivery consumer cancelled."));
  parent?.addEventListener("abort", stop, { once: true });
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(new DeliveryTimeoutError()); reject(new DeliveryTimeoutError()); }, ms);
    }),
  ]).finally(() => { clearTimeout(timer); parent?.removeEventListener("abort", stop); });
}

function signalWithin(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const stop = () => controller.abort(parent?.reason ?? new EventServiceError("CANCELLED", "Delivery consumer cancelled."));
  parent?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => controller.abort(new DeliveryTimeoutError()), ms);
  return { signal: controller.signal, close: () => { clearTimeout(timer); parent?.removeEventListener("abort", stop); } };
}

export class EventDeliveryCoordinator {
  private readonly events: EventService;
  private readonly principal: EventPrincipal;
  private readonly consumerId: string;
  private readonly handlers: readonly ComponentEventConsumer[];
  private readonly agentTargets = new Map<string, AgentEventTarget>();
  private readonly retiredBindings = new Set<string>();
  private readonly baseTargetRefs: readonly string[];
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;

  constructor(options: EventDeliveryCoordinatorOptions) {
    if (!options || typeof options.events !== "object") throw new Error("A durable event service is required");
    if (!options.principal || options.principal.kind !== "component") throw new Error("Delivery coordination requires a trusted component principal");
    const handlers = options.handlers ?? [];
    const targets = options.agentTargets ?? [];
    const handlerNames = new Set<string>();
    for (const handler of handlers) {
      if (!handler || typeof handler.consume !== "function" || typeof handler.handlerRef !== "string" || !handler.handlerRef
        || handlerNames.has(handler.handlerRef)) throw new Error("Invalid or duplicate component event handler");
      handlerNames.add(handler.handlerRef);
    }
    const bindingNames = new Set<string>();
    for (const target of targets) {
      if (!target || typeof target.bindingId !== "string" || !target.bindingId || bindingNames.has(target.bindingId)
        || !["background", "continuation"].includes(target.mode) || typeof target.updateBackground !== "function") throw new Error("Invalid or duplicate Agent event target");
      if (target.mode === "continuation" && (typeof target.evaluateContinuation !== "function" || typeof target.dispatchContinuation !== "function")) {
        throw new Error("Continuation targets require both a trusted gate and a native dispatch port");
      }
      bindingNames.add(target.bindingId);
    }
    // An empty coordinator is valid: runtime composition may start before any
    // component consumer or live Goal binding is registered. It claims nothing.
    const timeoutMs = options.handlerTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("handlerTimeoutMs must be 1–60000");
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_MS;
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 3600000) throw new Error("retryDelayMs must be 0–3600000");
    this.events = options.events;
    this.principal = Object.freeze({ ...options.principal, scopes: [...options.principal.scopes], publishTypes: [...options.principal.publishTypes],
      subscribeTypes: [...options.principal.subscribeTypes], targetRefs: [...options.principal.targetRefs] });
    this.consumerId = options.consumerId ?? "shiyu-event-coordinator";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(this.consumerId)) throw new Error("Invalid coordinator consumerId");
    this.handlers = handlers;
    for (const target of targets) this.agentTargets.set(target.bindingId, target);
    this.baseTargetRefs = Object.freeze([...options.principal.targetRefs]);
    this.timeoutMs = timeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Register a trusted Agent binding while the runtime is live. A Goal binding
   * becomes claimable only after this call; the model can never register one.
   */
  registerAgentTarget(target: AgentEventTarget): void {
    if (!target || typeof target.bindingId !== "string" || !target.bindingId || this.agentTargets.has(target.bindingId)
      || this.retiredBindings.has(target.bindingId)) throw new Error("Invalid, duplicate or retired Agent event target");
    if (!["background", "continuation"].includes(target.mode) || typeof target.updateBackground !== "function") throw new Error("Invalid Agent event target mode");
    if (target.mode === "continuation" && (typeof target.evaluateContinuation !== "function" || typeof target.dispatchContinuation !== "function")) {
      throw new Error("Continuation targets require both a trusted gate and a native dispatch port");
    }
    this.agentTargets.set(target.bindingId, target);
    if (!this.principal.targetRefs.includes(target.bindingId)) this.principal.targetRefs.push(target.bindingId);
  }

  /**
   * Retire one binding (Goal stopped/cancelled/authorization revoked). Pending
   * deliveries stay visible and are failed without dispatch, so an old delivery
   * can never restore the retired target's eligibility. New subscriptions to the
   * retired binding are refused by the control store target-ref check.
   */
  retireAgentTarget(bindingId: string): void {
    if (typeof bindingId !== "string" || !bindingId || !this.agentTargets.has(bindingId)) throw new Error("Unknown Agent event target");
    this.agentTargets.delete(bindingId);
    this.retiredBindings.add(bindingId);
    // Keep the target ref so already-accepted deliveries remain auditable/consumable
    // by this coordinator; the store refuses new kinds of authorization changes.
  }

  /** Current live binding ids, exposed for dashboards/tests (never authorization). */
  agentBindingIds(): string[] { return [...this.agentTargets.keys()].sort(); }

  /**
   * BackgroundPump-compatible receipt. Intentional no-dispatch decisions
   * ("stale": claim superseded by pause/retire/another attempt) are settled
   * attempts, not retrying failures. The pump validates processed+failed===claimed.
   */
  async scan(limit = 10): Promise<{ claimed: number; processed: number; failed: number }> {
    const batch = await this.consumeAgentDeliveries(limit);
    const failed = batch.deliveries.filter(item => item.outcome === "retrying" || item.outcome === "failed").length;
    return { claimed: batch.claimed, processed: batch.claimed - failed, failed };
  }

  /** Claim and consume one bounded batch. All durable state stays in the control ledger. */
  async consume(limit = 10): Promise<DeliveryBatch> {
    return this.consumeClaims(limit, true);
  }

  /**
   * Agent-target deliveries only. Merge this into the single existing
   * BackgroundPump scan (together with conversation background projection)
   * instead of running a second delivery loop.
   */
  async consumeAgentDeliveries(limit = 10): Promise<DeliveryBatch> {
    return this.consumeClaims(limit, false);
  }

  private async consumeClaims(limit: number, includeComponents: boolean): Promise<DeliveryBatch> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`Delivery batch limit must be 1–${MAX_LIMIT}`);
    const component = includeComponents
      ? await this.events.claim(this.principal, { consumerId: this.consumerId, deliveryMode: "component", limit, leaseMs: 30000 })
      : [];
    const agent = await this.events.claim(this.principal, { consumerId: this.consumerId, deliveryMode: "background", limit, leaseMs: 30000 });
    const claims = [...component, ...agent];
    const batch: DeliveryBatch = { claimed: claims.length, processed: 0, failed: 0, deliveries: [] };
    for (const claim of claims) {
      try {
        const decision = claim.deliveryMode === "component" ? await this.component(claim) : await this.agent(claim);
        batch.deliveries.push(decision);
        if (decision.outcome === "acked") batch.processed++;
        else if (decision.outcome === "failed" || decision.outcome === "retrying") batch.failed++;
      } catch (error) {
        // Coordinator invariants (not consumer failures) abort the batch only
        // after preserving whatever durable attempt facts are already known.
        throw new AggregateError([error, new EventServiceError("DELIVERY_COORDINATION_FAILED", "Durable delivery coordination failed")],
          "Event delivery coordination failed");
      }
    }
    return batch;
  }

  private decisions(claim: ClaimedDelivery, kind: DeliveryDecisionKind): DeliveryDecision {
    return { deliveryId: claim.deliveryId, eventId: claim.eventId, subscriptionId: claim.subscriptionId,
      target: claim.target.kind === "component" ? "component" : "agent", kind, outcome: "retrying" };
  }

  /** Revalidate this exact claim attempt before an externally visible effect. */
  private async assertCurrentAttempt(claim: ClaimedDelivery): Promise<void> {
    const visible = await this.events.listDeliveries(this.principal, { subscriptionId: claim.subscriptionId, limit: 100 });
    const current = visible.find((delivery: StoredDelivery) => delivery.deliveryId === claim.deliveryId);
    if (!current || current.status !== "claimed" || current.attempts !== claim.attempts || current.claimedBy !== this.consumerId
      || current.ruleRevision !== claim.ruleRevision || current.activationGeneration !== claim.activationGeneration) {
      throw new EventServiceError("STALE_CLAIM", "Delivery claim changed before the controlled consumer ran.");
    }
  }

  private async ack(claim: ClaimedDelivery): Promise<void> {
    await this.events.ack(this.principal, { deliveryId: claim.deliveryId, claimToken: claim.claimToken });
  }

  private async fail(claim: ClaimedDelivery, errorCode: string): Promise<DeliveryOutcome> {
    try {
      const delivery = await this.events.fail(this.principal, { deliveryId: claim.deliveryId, claimToken: claim.claimToken,
        error: errorCode, retryAfterMs: this.retryDelayMs });
      return delivery.status === "failed" ? "failed" : "retrying";
    } catch (error) {
      if (codeOf(error) === "STALE_CLAIM") return "stale";
      throw error;
    }
  }

  private async component(claim: ClaimedDelivery): Promise<DeliveryDecision> {
    const decision = this.decisions(claim, "component");
    if (claim.target.kind !== "component") return { ...decision, outcome: await this.fail(claim, "TARGET_MISMATCH") };
    const target = claim.target;
    const handler = this.handlers.find(value => value.handlerRef === target.handlerRef);
    if (!handler) return { ...decision, outcome: await this.fail(claim, "UNREGISTERED_HANDLER"), errorCode: "UNREGISTERED_HANDLER" };
    const scoped = signalWithin(undefined, this.timeoutMs);
    try {
      await this.assertCurrentAttempt(claim);
      const receipt = await deadline(handler.consume({ deliveryId: claim.deliveryId, eventId: claim.eventId, subscriptionId: claim.subscriptionId,
        ruleRevision: claim.ruleRevision, activationGeneration: claim.activationGeneration, event: claim.event, signal: scoped.signal }), this.timeoutMs);
      if (!receipt || typeof receipt.effectRef !== "string" || !receipt.effectRef) throw new EventServiceError("CONSUMER_FAILED", "Component consumer returned no durable effect reference.");
      // The effect is committed; ack may still lose a race with pause/retire.
      try { await this.ack(claim); } catch (error) {
        if (codeOf(error) === "STALE_CLAIM") return { ...decision, outcome: "stale", effectRef: receipt.effectRef };
        throw error;
      }
      return { ...decision, outcome: "acked", effectRef: receipt.effectRef };
    } catch (error) {
      const code = codeOf(error);
      return { ...decision, outcome: await this.fail(claim, code), errorCode: code };
    } finally { scoped.close(); }
  }

  private async agent(claim: ClaimedDelivery): Promise<DeliveryDecision> {
    const decision = this.decisions(claim, "background");
    if (claim.target.kind !== "agent") return { ...decision, outcome: await this.fail(claim, "TARGET_MISMATCH") };
    const bindingId = claim.target.bindingId;
    const target = this.agentTargets.get(bindingId);
    if (!target) {
      const code = this.retiredBindings.has(bindingId) ? "AGENT_BINDING_RETIRED" : "UNREGISTERED_AGENT_BINDING";
      return { ...decision, outcome: await this.fail(claim, code), errorCode: code };
    }
    const kind: DeliveryDecisionKind = target.mode === "continuation" ? "continuation" : "background";
    const delivery: AgentEventDelivery = { deliveryId: claim.deliveryId, eventId: claim.eventId, subscriptionId: claim.subscriptionId,
      ruleRevision: claim.ruleRevision, activationGeneration: claim.activationGeneration, bindingId,
      event: claim.event, signal: undefined as unknown as AbortSignal };
    const scoped = signalWithin(undefined, this.timeoutMs);
    const scopedDelivery = Object.freeze({ ...delivery, signal: scoped.signal });
    try {
      await this.assertCurrentAttempt(claim);
      // 1. Durable background reference commit (zero model) is authoritative for
      // "this delivery was consumed"; it is idempotent per deliveryId.
      const reference = await deadline(target.updateBackground(scopedDelivery), this.timeoutMs, scoped.signal);
      if (!reference || typeof reference.referenceId !== "string" || !reference.referenceId) throw new EventServiceError("CONSUMER_FAILED", "Background reference has no stable identity.");
      if (target.mode !== "continuation") {
        try { await this.ack(claim); } catch (error) {
          if (codeOf(error) === "STALE_CLAIM") return { ...decision, kind, outcome: "stale", referenceId: reference.referenceId };
          throw error;
        }
        return { ...decision, kind, outcome: "acked", referenceId: reference.referenceId };
      }
      // 2. Continuation is a separate, re-authorized decision. A denied or
      // revoked gate keeps only the background reference: no inbox, no wake.
      const evaluation = await deadline(target.evaluateContinuation!(scopedDelivery), this.timeoutMs, scoped.signal);
      if (!evaluation || typeof evaluation.allowed !== "boolean") throw new EventServiceError("CONSUMER_FAILED", "Continuation gate returned no explicit decision.");
      if (!evaluation.allowed) {
        try { await this.ack(claim); } catch (error) {
          if (codeOf(error) === "STALE_CLAIM") return { ...decision, kind, outcome: "stale", referenceId: reference.referenceId };
          throw error;
        }
        return { ...decision, kind, outcome: "acked", referenceId: reference.referenceId, dispatched: false,
          ...(evaluation.reason ? { continuationReason: evaluation.reason } : {}) };
      }
      // 3. The gate may await arbitrary trusted storage. Recheck this exact
      // attempt so a pause/retire/revision change cannot still dispatch.
      await this.assertCurrentAttempt(claim);
      const contextReceipt = await deadline(target.dispatchContinuation!(Object.freeze({ ...scopedDelivery, reference })), this.timeoutMs, scoped.signal);
      if (!contextReceipt || contextReceipt.durability !== "confirmed" || typeof contextReceipt.sessionId !== "string"
        || !Number.isSafeInteger(contextReceipt.eventSeq) || typeof contextReceipt.messageId !== "string") {
        throw new EventServiceError("CONTEXT_UNCONFIRMED", "Native context receipt is not confirmed durable.");
      }
      // Ack is deliberately separate from the context receipt: a lost ack does
      // not unload the native history, and a confirmed context is not an ack.
      try { await this.ack(claim); } catch (error) {
        if (codeOf(error) === "STALE_CLAIM") return { ...decision, kind, outcome: "stale", referenceId: reference.referenceId,
          dispatched: true, contextReceipt };
        throw error;
      }
      return { ...decision, kind, outcome: "acked", referenceId: reference.referenceId, dispatched: true, contextReceipt };
    } catch (error) {
      const code = codeOf(error);
      return { ...decision, kind, outcome: await this.fail(claim, code), errorCode: code };
    } finally { scoped.close(); }
  }
}

// ---------------------------------------------------------------------------
// Trusted core Goal continuation port.
//
// H1 keeps the core decision Session deliberately zero-tool and single-request.
// H2a therefore does *not* mount model-callable event tools into that Session
// (that remains an explicit H2c gap that depends on H3 reworking core budget and
// accounting). Instead, an Agent-target delivery for a core Goal binding is
// admitted through this host-owned port: it re-reads the *current* Goal phase,
// authorization epoch, execution instance and budget, requires the H1 native
// baseline/maintenance check before dispatch, and only then lets the host append
// one bounded event reference into the native Session. The port never calls a
// model itself; a confirmed context receipt is returned separately from the
// delivery ack.
// ---------------------------------------------------------------------------

export interface CoreGoalContinuationState {
  goalId: string;
  sessionId: string;
  /** Native Goal phase is active (not paused/blocked/complete). */
  goalActive: boolean;
  /** Current owner/Mandate authorization is still in force. */
  authorized: boolean;
  /** Monotonic authorization generation; a change invalidates old deliveries. */
  authorizationEpoch: number;
  /** Current Assignment/instance qualification and fencing are valid. */
  instanceValid: boolean;
  /** The current Goal budget still allows one bounded continuation. */
  budgetAvailable: boolean;
}

export interface CoreGoalContinuationTargetOptions {
  bindingId: string;
  goalId: string;
  /** Exact native Session identity bound to this Goal; never re-created implicitly. */
  expectedSessionId: string;
  /** Expected authorization generation captured when the subscription was established. */
  expectedAuthorizationEpoch: number;
  /** Trusted read of current durable/native facts. Must not call a model. */
  readState(): Promise<CoreGoalContinuationState>;
  /** H1-verified maintenance/baseline check (observeNativeBaseline/assertNativeLiveHistory). */
  assertNativeBaseline?(sessionId: string): void | Promise<void>;
  /** Durable zero-model background marker commit. */
  background(input: { deliveryId: string; eventId: string; text: string }): Promise<BackgroundReferenceReceipt>;
  /** Host-owned native append + flush + independent readback of exactly one event reference. */
  dispatch(input: { goalId: string; sessionId: string; deliveryId: string; eventId: string; text: string; signal: AbortSignal }): Promise<ContinuationContextReceipt>;
  now?: () => number;
}

export interface CoreContinuationObservation {
  gateChecks: number;
  denials: number;
  dispatches: number;
  lastReason?: string;
  lastCheckedAt?: string;
}

const MAX_CONTEXT_TEXT_BYTES = 8192;
const DENIAL_REASONS = new Set(["GOAL_INACTIVE", "REVOKED", "AUTH_CHANGED", "STALE_SESSION", "STALE_INSTANCE", "BUDGET_EXHAUSTED", "NATIVE_BASELINE_UNAVAILABLE"]);

/** Deterministic, bounded, model-facing rendering of one accepted event reference. */
export function coreContinuationText(event: StoredEvent): string {
  const payload = JSON.stringify(event.payload);
  const body = `Background event reference (data only; not a new authorization): ${JSON.stringify({ schemaVersion: 1,
    eventId: event.eventId, sequence: event.sequence, type: event.type, scope: event.scope, actor: event.actor,
    payloadSummary: payload.length > 6000 ? `${payload.slice(0, 6000)}…` : payload })}`;
  return Buffer.byteLength(body) > MAX_CONTEXT_TEXT_BYTES ? body.slice(0, MAX_CONTEXT_TEXT_BYTES) : body;
}

/**
 * Host-owned continuation target for one core Goal binding. The coordinator only
 * learns "allowed/denied"; every actual condition is re-read from trusted state
 * on each attempt, and dispatch performs one final re-read so a pause, revoke or
 * instance change racing with the baseline check can never restore eligibility.
 */
export class CoreGoalContinuationTarget implements AgentEventTarget {
  readonly bindingId: string;
  readonly mode = "continuation" as const;
  private readonly options: CoreGoalContinuationTargetOptions;
  private readonly observation: CoreContinuationObservation = { gateChecks: 0, denials: 0, dispatches: 0 };

  constructor(options: CoreGoalContinuationTargetOptions) {
    if (!options || typeof options.readState !== "function" || typeof options.background !== "function" || typeof options.dispatch !== "function") {
      throw new Error("Core continuation requires trusted state, background and dispatch ports");
    }
    if (typeof options.bindingId !== "string" || !options.bindingId || typeof options.goalId !== "string" || !options.goalId
      || typeof options.expectedSessionId !== "string" || !options.expectedSessionId
      || !Number.isSafeInteger(options.expectedAuthorizationEpoch) || options.expectedAuthorizationEpoch < 0) {
      throw new Error("Core continuation binding identity is invalid");
    }
    if (options.assertNativeBaseline !== undefined && typeof options.assertNativeBaseline !== "function") throw new Error("assertNativeBaseline must be a function");
    this.options = options;
    this.bindingId = options.bindingId;
  }
  private now(): string { return new Date(this.options.now?.() ?? Date.now()).toISOString(); }
  snapshot(): Readonly<CoreContinuationObservation> { return Object.freeze({ ...this.observation }); }

  /** Trusted denial decision with the concrete condition that failed. */
  private async evaluate(input: AgentEventDelivery): Promise<ContinuationEvaluation> {
    this.observation.gateChecks++;
    const state = await this.options.readState();
    const deny = (reason: string): ContinuationEvaluation => {
      this.observation.denials++; this.observation.lastReason = reason; this.observation.lastCheckedAt = this.now();
      return { allowed: false, reason };
    };
    if (!state || state.goalId !== this.options.goalId) return deny("GOAL_INACTIVE");
    if (state.sessionId !== this.options.expectedSessionId) return deny("STALE_SESSION");
    if (!state.goalActive) return deny("GOAL_INACTIVE");
    if (!state.authorized) return deny("REVOKED");
    if (state.authorizationEpoch !== this.options.expectedAuthorizationEpoch) return deny("AUTH_CHANGED");
    if (!state.instanceValid) return deny("STALE_INSTANCE");
    if (!state.budgetAvailable) return deny("BUDGET_EXHAUSTED");
    this.observation.lastReason = undefined; this.observation.lastCheckedAt = this.now();
    return { allowed: true };
  }

  async updateBackground(input: AgentEventDelivery): Promise<BackgroundReferenceReceipt> {
    const text = coreContinuationText(input.event);
    return this.options.background({ deliveryId: input.deliveryId, eventId: input.eventId, text });
  }

  async evaluateContinuation(input: AgentEventDelivery): Promise<ContinuationEvaluation> {
    return this.evaluate(input);
  }

  async dispatchContinuation(input: AgentEventDelivery & { reference: BackgroundReferenceReceipt }): Promise<ContinuationContextReceipt> {
    input.signal.throwIfAborted();
    // A gate decision is not a capability: re-read after every await so pause,
    // revoke, instance change or budget exhaustion wins over the earlier check.
    const evaluation = await this.evaluate(input);
    if (!evaluation.allowed) {
      throw Object.assign(new Error(`Core continuation denied: ${evaluation.reason ?? "DENIED"}`), { code: "CONTINUATION_DENIED" });
    }
    try {
      await this.options.assertNativeBaseline?.(this.options.expectedSessionId);
    } catch (error) {
      this.observation.denials++; this.observation.lastReason = "NATIVE_BASELINE_UNAVAILABLE"; this.observation.lastCheckedAt = this.now();
      throw Object.assign(new Error("H1 native baseline/maintenance check denied the continuation"), { code: "NATIVE_BASELINE_UNAVAILABLE", cause: error });
    }
    input.signal.throwIfAborted();
    const fresh = await this.evaluate(input);
    if (!fresh.allowed) {
      throw Object.assign(new Error(`Core continuation changed before dispatch: ${fresh.reason ?? "DENIED"}`), { code: "CONTINUATION_DENIED" });
    }
    const receipt = await this.options.dispatch({ goalId: this.options.goalId, sessionId: this.options.expectedSessionId,
      deliveryId: input.deliveryId, eventId: input.eventId, text: coreContinuationText(input.event), signal: input.signal });
    if (!receipt || receipt.durability !== "confirmed" || receipt.sessionId !== this.options.expectedSessionId
      || typeof receipt.messageId !== "string" || !receipt.messageId || !Number.isSafeInteger(receipt.eventSeq)) {
      throw Object.assign(new Error("Native continuation did not confirm the exact Session/message readback"), { code: "CONTEXT_UNCONFIRMED" });
    }
    this.observation.dispatches++;
    return receipt;
  }
}

export { DENIAL_REASONS as CORE_CONTINUATION_DENIAL_REASONS };
