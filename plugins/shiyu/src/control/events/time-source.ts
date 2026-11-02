import type { EventService } from './index.js';
import type { EventRuleStore, ObservationRule, SubscriptionRuleDocument, TimeRule, TimeSourceState } from './rules.js';
import type { EventPayload, EventPrincipal, EventTypeDefinition, StoredSubscription } from '../../contracts/events.js';

// ---------------------------------------------------------------------------
// H2b time source: plugin-owned declarative schedules driven by an injected
// cooperative tick. The production tick is supplied by Runtime integration and
// must be zero-model and must not occupy operation slots. This module never
// imports the DSH host schedule service: a host-schedule adapter could only be a
// future optional port implementation, never the semantic authority.
// ---------------------------------------------------------------------------

/** One declarative schedule bound to a subscription rule revision. */
export interface TimeScheduleRecord {
  scheduleRef: string;
  subscriptionId: string;
  ruleRevision: number;
  timing: TimeRule;
  enabled: boolean;
  /** Trusted native/port revision; only used to detect replacement, never identity. */
  expectedUpdatedAt?: string;
  sourceGeneration?: number;
}
export interface SchedulePort {
  list(): Promise<readonly TimeScheduleRecord[]>;
}
export interface ReadonlyObservationResult {
  version: number;
  changed: boolean;
  digest?: string;
  /** True when the observation is incomplete and must not be treated as unchanged. */
  gap?: string;
}
export interface ReadonlyObservationPort {
  observe(observationRef: string): Promise<ReadonlyObservationResult>;
}
export interface TimeSourceOptions {
  events: EventService;
  rules: EventRuleStore;
  /** Injected declaration source (runtime-owned). */
  schedule: SchedulePort;
  /** Trusted publisher identity (component; bounded event types only). */
  principal: EventPrincipal;
  /** Trusted read-only subscription inspector identity (optional if readSubscription is supplied). */
  inspector?: EventPrincipal;
  /** Trusted read-only subscription reader for pause/retire/revision fencing. */
  readSubscription?(subscriptionId: string): Promise<StoredSubscription | undefined>;
  /** Registered trigger event type; the control-store catalog must declare it. */
  triggerEventType: string;
  /** Registered external-change event type; defaults to the trigger type. */
  observationEventType?: string;
  clock?: () => number;
  observation?: ReadonlyObservationPort;
  /** Hard cap per tick; excess work is reported as deferred, never silently dropped. */
  maxOccurrencesPerTick?: number;
  maxSchedules?: number;
  now?: () => number;
}
export interface TimeOccurrenceReceipt {
  subscriptionId: string; ruleRevision: number; scheduleRef: string; occurrence: string; scheduledFor: number;
  status: 'accepted' | 'duplicate' | 'skipped' | 'stale' | 'deferred'; reason?: string;
}
export interface TimeTickReceipt {
  evaluatedAt: number; schedules: number; occurrences: number; accepted: number; duplicate: number; skipped: number;
  deferred: number; gaps: string[]; items: TimeOccurrenceReceipt[];
}
export interface ObservationTickReceipt {
  evaluatedAt: number; observations: number; accepted: number; duplicate: number; skipped: number;
  deferred: number; gaps: string[]; items: { subscriptionId: string; observationRef: string; version?: number; status: 'accepted' | 'duplicate' | 'skipped' | 'stale' | 'deferred'; reason?: string }[];
}
const MAX_SCHEDULES = 100;
const MAX_OCCURRENCES = 20;
const DEFAULT_GRACE_MS = 0;
function iso(ms: number): string { return new Date(ms).toISOString(); }
function intervalOccurrence(rule: TimeRule, lastEvaluatedAt: number, now: number): number | undefined {
  const interval = rule.intervalMs!;
  if (now < lastEvaluatedAt) return undefined;
  const elapsed = now - lastEvaluatedAt;
  if (elapsed < interval) return undefined;
  // Latest-only collapses every elapsed period into the most recent boundary.
  return lastEvaluatedAt + Math.floor(elapsed / interval) * interval;
}
function dailyOccurrence(rule: TimeRule, lastEvaluatedAt: number, now: number, lastOffsetMinutes: number | undefined): { scheduledFor: number; offsetChanged: boolean } {
  const { hour, minute, zoneOffsetMinutes } = rule.dailyAt!;
  const offsetChanged = lastOffsetMinutes !== undefined && lastOffsetMinutes !== zoneOffsetMinutes;
  const localNow = new Date(now + zoneOffsetMinutes * 60000);
  const scheduledLocal = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), hour, minute, 0, 0);
  const scheduledFor = scheduledLocal - zoneOffsetMinutes * 60000;
  if (scheduledFor <= lastEvaluatedAt) {
    // The current local day's occurrence is already processed; the next due day is due.
    const next = scheduledFor - 86400000;
    return { scheduledFor: next, offsetChanged };
  }
  return { scheduledFor, offsetChanged };
}
/** Deterministic plugin-owned time source. `tick()` is idempotent for the same
 * canonical occurrence and never calls a model. */
export class TimeSourceService {
  private readonly events: EventService;
  private readonly rules: EventRuleStore;
  private readonly schedule: SchedulePort;
  private readonly principal: EventPrincipal;
  private readonly inspector?: EventPrincipal;
  private readonly readSubscription?: (subscriptionId: string) => Promise<StoredSubscription | undefined>;
  private readonly triggerEventType: string;
  private readonly observationEventType: string;
  private readonly now: () => number;
  private readonly observation?: ReadonlyObservationPort;
  private readonly maxOccurrences: number;
  private readonly maxSchedules: number;
  private ticking?: Promise<TimeTickReceipt>;
  constructor(options: TimeSourceOptions) {
    if (!options?.events || !options.rules || !options.schedule || !options.principal
      || typeof options.triggerEventType !== 'string' || !options.triggerEventType) throw new Error('Time source requires event service, rule store, schedule port and trusted identities');
    if (!options.inspector && !options.readSubscription) throw new Error('Time source requires a trusted subscription reader');
    this.events = options.events; this.rules = options.rules; this.schedule = options.schedule;
    this.principal = Object.freeze({ ...options.principal, scopes: [...options.principal.scopes], publishTypes: [...options.principal.publishTypes],
      subscribeTypes: [...options.principal.subscribeTypes], targetRefs: [...options.principal.targetRefs] });
    this.inspector = options.inspector ? Object.freeze({ ...options.inspector, scopes: [...options.inspector.scopes],
      publishTypes: [...options.inspector.publishTypes], subscribeTypes: [...options.inspector.subscribeTypes], targetRefs: [...options.inspector.targetRefs] }) : undefined;
    this.readSubscription = options.readSubscription;
    this.triggerEventType = options.triggerEventType;
    this.observationEventType = options.observationEventType ?? options.triggerEventType;
    this.now = options.clock ?? options.now ?? (() => Date.now());
    this.observation = options.observation;
    const maxOccurrences = options.maxOccurrencesPerTick ?? MAX_OCCURRENCES;
    const maxSchedules = options.maxSchedules ?? MAX_SCHEDULES;
    if (!Number.isSafeInteger(maxOccurrences) || maxOccurrences < 1 || maxOccurrences > 100
      || !Number.isSafeInteger(maxSchedules) || maxSchedules < 1 || maxSchedules > MAX_SCHEDULES) throw new Error('Invalid time source bounds');
    this.maxOccurrences = maxOccurrences; this.maxSchedules = maxSchedules;
  }
  private async subscriptions(): Promise<Map<string, StoredSubscription>> {
    if (!this.inspector) return new Map();
    const subscriptions = await this.events.listSubscriptions(this.inspector);
    return new Map(subscriptions.map(subscription => [subscription.id, subscription]));
  }
  private async currentSubscription(subscriptionId: string, preloaded: Map<string, StoredSubscription>): Promise<StoredSubscription | undefined> {
    if (this.readSubscription) return this.readSubscription(subscriptionId);
    return preloaded.get(subscriptionId);
  }
  private async state(subscriptionId: string): Promise<TimeSourceState> {
    const state = await this.rules.getTimeState(subscriptionId);
    return { ...state, schemaVersion: 1, gaps: state.gaps ?? [] };
  }
  /** Cooperative tick: at most one in-flight scan; duplicate calls coalesce. */
  tick(): Promise<TimeTickReceipt> {
    if (this.ticking) return this.ticking;
    this.ticking = this.scan().finally(() => { this.ticking = undefined; });
    return this.ticking as Promise<TimeTickReceipt>;
  }
  private async scan(): Promise<TimeTickReceipt> {
    const evaluatedAt = this.now();
    const receipt: TimeTickReceipt = { evaluatedAt, schedules: 0, occurrences: 0, accepted: 0, duplicate: 0, skipped: 0, deferred: 0, gaps: [], items: [] };
    const schedules = (await this.schedule.list()).slice(0, this.maxSchedules);
    receipt.schedules = schedules.length;
    const subscriptions = await this.subscriptions();
    const seen = new Set<string>();
    for (const schedule of schedules) {
      const occurrenceIdentity = `${schedule.subscriptionId}:${schedule.ruleRevision}:${schedule.scheduleRef}`;
      if (seen.has(`${occurrenceIdentity}:${evaluatedAt}`)) continue;
      const subscription = await this.currentSubscription(schedule.subscriptionId, subscriptions);
      const rule = await this.rules.getRule(schedule.subscriptionId);
      const state = await this.state(schedule.subscriptionId);
      const skip = async (reason: string, itemStatus: TimeOccurrenceReceipt['status'] = 'skipped'): Promise<void> => {
        receipt.skipped++; receipt.gaps.push(reason);
        receipt.items.push({ subscriptionId: schedule.subscriptionId, ruleRevision: schedule.ruleRevision, scheduleRef: schedule.scheduleRef,
          occurrence: '', scheduledFor: evaluatedAt, status: itemStatus, reason });
        await this.rules.recordGap(schedule.subscriptionId, reason);
      };
      if (receipt.occurrences >= this.maxOccurrences) { receipt.deferred++; await skip('TICK_BACKPRESSURE', 'deferred'); continue; }
      if (!schedule.enabled) { await skip('SCHEDULE_DISABLED'); continue; }
      if (!subscription) { await skip('SUBSCRIPTION_INACTIVE'); continue; }
      if (!rule || rule.retiredAt) { await skip('RULE_RETIRED'); continue; }
      if (rule.time?.scheduleRef !== schedule.scheduleRef) { await skip('SCHEDULE_NOT_BOUND'); continue; }
      if (schedule.ruleRevision !== rule.conditionRevision) { await skip('SCHEDULE_REVISION_STALE'); continue; }
      if (subscription.status !== 'active') { await skip('SUBSCRIPTION_INACTIVE'); continue; }
      if (subscription.expiresAt && Date.parse(subscription.expiresAt) <= evaluatedAt) { await skip('SUBSCRIPTION_EXPIRED'); continue; }
      if (state.lastEvaluatedAt === undefined) {
        // Fresh installation/restart without prior state: establish the baseline
        // at now, never replay historical occurrences.
        await this.rules.putTimeState(schedule.subscriptionId, { ...state, lastEvaluatedAt: evaluatedAt });
        await skip('BASELINE_ESTABLISHED');
        continue;
      }
      if (rule.time.kind === 'once') {
        const at = rule.time.atMs!;
        if (state.lastOccurrence && Date.parse(state.lastOccurrence) === at) { await skip('OCCURRENCE_ALREADY_HANDLED'); continue; }
        if (at <= (state.lastEvaluatedAt ?? evaluatedAt)) { await skip('MISSED_BEFORE_BASELINE'); continue; }
        if (at > evaluatedAt) { await skip('NOT_DUE_YET'); continue; }
        const occurrence = `once:${schedule.ruleRevision}:${iso(at)}`;
        if (await this.fire(subscription, rule, schedule, occurrence, at, evaluatedAt, receipt, state)) { await skip('', 'accepted'); }
        await this.rules.putTimeState(schedule.subscriptionId, { ...state, lastEvaluatedAt: evaluatedAt, lastOccurrence: iso(at), gaps: state.gaps.slice(-32) });
        continue;
      }
      if (evaluatedAt < (state.lastEvaluatedAt ?? evaluatedAt)) {
        await skip('CLOCK_ROLLBACK'); await this.rules.putTimeState(schedule.subscriptionId, { ...state, lastEvaluatedAt: evaluatedAt }); continue;
      }
      let scheduledFor: number;
      if (rule.time.kind === 'interval') {
        const due = intervalOccurrence(rule.time, state.lastEvaluatedAt!, evaluatedAt);
        // Do not move the interval anchor forward: a partial period must accumulate.
        if (due === undefined) continue;
        scheduledFor = due;
      } else {
        const { scheduledFor: due, offsetChanged } = dailyOccurrence(rule.time, state.lastEvaluatedAt!, evaluatedAt, state.lastOffsetMinutes);
        if (offsetChanged) { await skip('TIMEZONE_CHANGED'); await this.rules.putTimeState(schedule.subscriptionId, { ...state, lastEvaluatedAt: evaluatedAt, lastOffsetMinutes: rule.time.dailyAt!.zoneOffsetMinutes }); continue; }
        if (due > evaluatedAt) { continue; }
        scheduledFor = due;
      }
      const grace = rule.time.graceMs ?? DEFAULT_GRACE_MS;
      const occurrence = `${rule.time.kind}:${schedule.ruleRevision}:${iso(scheduledFor)}`;
      if (grace > 0 && evaluatedAt - scheduledFor > grace) {
        await skip('MISSED_OCCURRENCE');
        await this.rules.putTimeState(schedule.subscriptionId, { ...state, lastEvaluatedAt: evaluatedAt });
        continue;
      }
      const key = `${schedule.subscriptionId}:${rule.time.scheduleRef}:${occurrence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      receipt.occurrences++;
      const fired = await this.fire(subscription, rule, schedule, occurrence, scheduledFor, evaluatedAt, receipt, state);
      if (fired) await this.rules.putTimeState(schedule.subscriptionId, { ...state, lastEvaluatedAt: fired.lastEvaluatedAt,
        lastOccurrence: iso(scheduledFor), ...(rule.time.kind === 'daily' ? { lastOffsetMinutes: rule.time.dailyAt!.zoneOffsetMinutes } : {}),
        gaps: state.gaps.slice(-32) });
      else await this.rules.putTimeState(schedule.subscriptionId, { ...state, lastEvaluatedAt: evaluatedAt });
    }
    return receipt;
  }
  private async fire(subscription: StoredSubscription, rule: SubscriptionRuleDocument, schedule: TimeScheduleRecord,
    occurrence: string, scheduledFor: number, evaluatedAt: number, receipt: TimeTickReceipt, state: TimeSourceState): Promise<{ lastEvaluatedAt: number } | undefined> {
    const payload: EventPayload = { subscriptionId: subscription.id, ruleRevision: schedule.ruleRevision, scheduleRef: schedule.scheduleRef,
      occurrence, scheduledFor: iso(scheduledFor) };
    try {
      const accepted = await this.events.publish(this.principal, { type: this.triggerEventType, scope: subscription.scope,
        payload, idempotencyKey: `time:${subscription.id}:${schedule.ruleRevision}:${occurrence}`,
        correlationId: `time:${subscription.id}:${schedule.ruleRevision}`, ...(subscription.expiresAt ? { expiresAt: subscription.expiresAt } : {}) });
      receipt.items.push({ subscriptionId: subscription.id, ruleRevision: schedule.ruleRevision, scheduleRef: schedule.scheduleRef,
        occurrence, scheduledFor, status: accepted.status === 'duplicate' ? 'duplicate' : 'accepted' });
      if (accepted.status === 'duplicate') receipt.duplicate++; else receipt.accepted++;
      return { lastEvaluatedAt: evaluatedAt };
    } catch (error) {
      const reason = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: string }).code === 'string'
        ? (error as { code: string }).code : 'TRIGGER_PUBLISH_FAILED';
      receipt.items.push({ subscriptionId: subscription.id, ruleRevision: schedule.ruleRevision, scheduleRef: schedule.scheduleRef,
        occurrence, scheduledFor, status: 'skipped', reason });
      receipt.skipped++;
      await this.rules.recordGap(subscription.id, reason);
      return undefined;
    }
  }
  /** Bounded read-only external observation scan; never calls a model and never
   * treats observer failure as "no change". */
  async scanObservations(): Promise<ObservationTickReceipt> {
    const evaluatedAt = this.now();
    const receipt: ObservationTickReceipt = { evaluatedAt, observations: 0, accepted: 0, duplicate: 0, skipped: 0, deferred: 0, gaps: [], items: [] };
    if (!this.observation) return receipt;
    const subscriptions = await this.subscriptions();
    const rules = await this.rules.listRules();
    for (const rule of rules) {
      if (!rule.observation || rule.retiredAt) continue;
      const subscription = await this.currentSubscription(rule.subscriptionId, subscriptions);
      if (!subscription || subscription.status !== 'active') { receipt.skipped++; receipt.items.push({ subscriptionId: rule.subscriptionId,
        observationRef: rule.observation.observationRef, status: 'stale', reason: 'SUBSCRIPTION_INACTIVE' }); continue; }
      if (subscription.expiresAt && Date.parse(subscription.expiresAt) <= evaluatedAt) { receipt.skipped++; continue; }
      const state = await this.state(rule.subscriptionId);
      const minInterval = rule.observation.minIntervalMs ?? 1000;
      if (state.lastObservationAt !== undefined && evaluatedAt - state.lastObservationAt < minInterval) { receipt.deferred++; continue; }
      receipt.observations++;
      let observed: ReadonlyObservationResult;
      try { observed = await this.observation.observe(rule.observation.observationRef); }
      catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 120) : 'OBSERVATION_FAILED';
        receipt.gaps.push(reason); await this.rules.recordGap(rule.subscriptionId, reason);
        await this.rules.putTimeState(rule.subscriptionId, { ...state, lastObservationAt: evaluatedAt });
        receipt.items.push({ subscriptionId: rule.subscriptionId, observationRef: rule.observation.observationRef, status: 'skipped', reason }); continue;
      }
      if (!observed || !Number.isSafeInteger(observed.version) || typeof observed.changed !== 'boolean') {
        receipt.gaps.push('OBSERVATION_INVALID'); await this.rules.recordGap(rule.subscriptionId, 'OBSERVATION_INVALID');
        receipt.items.push({ subscriptionId: rule.subscriptionId, observationRef: rule.observation.observationRef, status: 'skipped', reason: 'OBSERVATION_INVALID' });
        await this.rules.putTimeState(rule.subscriptionId, { ...state, lastObservationAt: evaluatedAt }); continue;
      }
      const versionAdvanced = state.lastObservationVersion === undefined || observed.version > state.lastObservationVersion;
      const matches = rule.observation.policy === 'changed' ? observed.changed && versionAdvanced : versionAdvanced;
      if (!matches) { receipt.skipped++; receipt.items.push({ subscriptionId: rule.subscriptionId, observationRef: rule.observation.observationRef,
        version: observed.version, status: 'skipped', reason: observed.gap ?? 'NO_CHANGE' }); await this.rules.putTimeState(rule.subscriptionId, { ...state, lastObservationAt: evaluatedAt }); continue; }
      const digest = observed.digest ?? String(observed.version);
      try {
        const accepted = await this.events.publish(this.principal, { type: this.observationEventType, scope: subscription.scope,
          payload: { subscriptionId: subscription.id, ruleRevision: rule.conditionRevision, observationRef: rule.observation.observationRef,
            version: observed.version, digest }, idempotencyKey: `obs:${subscription.id}:${rule.conditionRevision}:${observed.version}:${digest}`.slice(0, 240),
          correlationId: `obs:${subscription.id}:${rule.conditionRevision}`, ...(subscription.expiresAt ? { expiresAt: subscription.expiresAt } : {}) });
        receipt.items.push({ subscriptionId: rule.subscriptionId, observationRef: rule.observation.observationRef, version: observed.version,
          status: accepted.status === 'duplicate' ? 'duplicate' : 'accepted' });
        if (accepted.status === 'duplicate') receipt.duplicate++; else receipt.accepted++;
      } catch (error) {
        const reason = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : 'OBSERVATION_PUBLISH_FAILED';
        receipt.gaps.push(reason); await this.rules.recordGap(rule.subscriptionId, reason);
        receipt.items.push({ subscriptionId: rule.subscriptionId, observationRef: rule.observation.observationRef, status: 'skipped', reason });
      }
      await this.rules.putTimeState(rule.subscriptionId, { ...state, lastObservationAt: evaluatedAt, lastObservationVersion: observed.version, gaps: state.gaps.slice(-32) });
    }
    return receipt;
  }
  /** Read-only operational state; never mutates subscriptions or deliveries. */
  async status(subscriptionId: string): Promise<{ state: TimeSourceState; rule?: SubscriptionRuleDocument; schedule?: TimeScheduleRecord[] }> {
    const [state, rule, schedules] = await Promise.all([this.state(subscriptionId), this.rules.getRule(subscriptionId),
      this.schedule.list()]);
    return { state, ...(rule ? { rule } : {}), schedule: schedules.filter(schedule => schedule.subscriptionId === subscriptionId) };
  }
}

/** Declarative event types for the plugin-owned time source. Runtime integration
 * adds these to the trusted catalog; tests open their own temporary catalog with
 * the same definitions. */
export const H2B_EVENT_TYPES: EventTypeDefinition[] = [
  { type: 'time.occurred', schemaVersion: 1, description: 'A declaration-only schedule occurrence; identity is subscription + rule revision + scheduled occurrence.',
    publisherKinds: ['component' as const], publisherIds: ['shiyu-time-source'],
    payloadSchema: { properties: { subscriptionId: 'string' as const, ruleRevision: 'number' as const, scheduleRef: 'string' as const,
      occurrence: 'string' as const, scheduledFor: 'string' as const }, required: ['subscriptionId', 'ruleRevision', 'scheduleRef', 'occurrence', 'scheduledFor'],
      additionalProperties: false as const },
    filterableFields: ['subscriptionId', 'scheduleRef'] },
  { type: 'observation.changed', schemaVersion: 1, description: 'A read-only observed external change; identity is subscription + rule revision + observed version/digest.',
    publisherKinds: ['component' as const], publisherIds: ['shiyu-time-source'],
    payloadSchema: { properties: { subscriptionId: 'string' as const, ruleRevision: 'number' as const, observationRef: 'string' as const,
      version: 'number' as const, digest: 'string' as const }, required: ['subscriptionId', 'ruleRevision', 'observationRef', 'version', 'digest'],
      additionalProperties: false as const },
    filterableFields: ['subscriptionId', 'observationRef'] },
];
/** Production schedule source: reads the plugin-owned declarative rule file. */
export class RuleBasedSchedulePort implements SchedulePort {
  constructor(private readonly rules: EventRuleStore) {}
  async list(): Promise<readonly TimeScheduleRecord[]> {
    const rules = await this.rules.listRules();
    const records: TimeScheduleRecord[] = [];
    for (const rule of rules) {
      if (!rule.time || rule.retiredAt) continue;
      records.push({ scheduleRef: rule.time.scheduleRef, subscriptionId: rule.subscriptionId, ruleRevision: rule.conditionRevision,
        timing: rule.time, enabled: true });
    }
    return records;
  }
}

/** Cooperative runtime tick for the plugin-owned time source. It is deliberately
 * NOT an operation slot and never calls a model: each tick only runs the
 * deterministic scan above. Interval coalescing prevents overlapping scans. */
export interface TimeSourcePumpState {
  state: 'idle' | 'running' | 'degraded' | 'stopped';
  lastTickAt?: string; lastObservationAt?: string; lastFailure?: string;
  lastTick?: TimeTickReceipt; lastObservation?: ObservationTickReceipt;
}
export class TimeSourcePump {
  private timer?: ReturnType<typeof setInterval>;
  private observationTimer?: ReturnType<typeof setInterval>;
  private observationRunning = false;
  private ticking = false;
  private closed = false;
  private wakeInFlight?: Promise<void>;
  private observationInFlight?: Promise<void>;
  private observation: TimeSourcePumpState = { state: 'idle' };
  private readonly tickIntervalMs: number;
  private readonly observationIntervalMs: number;
  private readonly now: () => number;
  constructor(private readonly options: { source: TimeSourceService; tickIntervalMs?: number; observationIntervalMs?: number;
    now?: () => number; onFailure?(error: unknown): void; allowed?: () => boolean }) {
    const tickMs = options.tickIntervalMs ?? 5000;
    const observationMs = options.observationIntervalMs ?? 30000;
    if (!Number.isSafeInteger(tickMs) || tickMs < 100 || tickMs > 300000
      || !Number.isSafeInteger(observationMs) || observationMs < 1000 || observationMs > 3600000) throw new Error('Invalid time source pump intervals');
    this.tickIntervalMs = tickMs; this.observationIntervalMs = observationMs;
    this.now = options.now ?? (() => Date.now());
  }
  snapshot(): TimeSourcePumpState { return structuredClone(this.observation); }
  start(): void {
    if (this.closed || this.timer !== undefined) return;
    this.timer = setInterval(() => { void this.wake(); }, this.tickIntervalMs);
    this.timer.unref?.();
    this.observationTimer = setInterval(() => { void this.wakeObservations(); }, this.observationIntervalMs);
    this.observationTimer.unref?.();
  }
  private isAllowed(): boolean {
    if (this.closed) return false;
    try { return this.options.allowed ? this.options.allowed() !== false : true; } catch { return false; }
  }
  async wake(): Promise<void> {
    if (!this.isAllowed() || this.ticking) return;
    const running = this.scanTick();
    this.wakeInFlight = running;
    try { await running; } finally { if (this.wakeInFlight === running) this.wakeInFlight = undefined; }
  }
  private async scanTick(): Promise<void> {
    if (this.closed) return;
    this.ticking = true;
    this.observation.state = 'running';
    try {
      const receipt = await this.options.source.tick();
      if (!this.closed) this.observation = { ...this.observation, state: receipt.gaps.length ? 'degraded' : 'idle', lastTickAt: new Date(this.now()).toISOString(), lastTick: receipt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.closed) this.observation = { ...this.observation, state: 'degraded', lastFailure: message.slice(0, 500) };
      try { this.options.onFailure?.(error); } catch { /* failure callback cannot change pump state */ }
    } finally { this.ticking = false; }
  }
  async wakeObservations(): Promise<void> {
    if (!this.isAllowed() || this.observationRunning) return;
    const running = this.scanObservations();
    this.observationInFlight = running;
    try { await running; } finally { if (this.observationInFlight === running) this.observationInFlight = undefined; }
  }
  private async scanObservations(): Promise<void> {
    if (this.closed) return;
    this.observationRunning = true;
    try {
      const receipt = await this.options.source.scanObservations();
      if (!this.closed) this.observation = { ...this.observation, ...(receipt.gaps.length ? { state: 'degraded' as const } : {}),
        lastObservationAt: new Date(this.now()).toISOString(), lastObservation: receipt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.closed) this.observation = { ...this.observation, state: 'degraded', lastFailure: message.slice(0, 500) };
      try { this.options.onFailure?.(error); } catch { /* ignore */ }
    } finally { this.observationRunning = false; }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.observationTimer) clearInterval(this.observationTimer);
    this.timer = undefined; this.observationTimer = undefined;
    await Promise.allSettled([this.wakeInFlight, this.observationInFlight].filter(Boolean) as Promise<unknown>[]);
    this.observation.state = 'stopped';
  }
}
