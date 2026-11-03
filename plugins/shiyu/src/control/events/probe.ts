import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../adapters/control-store/index.js';
import { SHIYU_EVENT_TYPES, type EventPrincipal, type StoredEvent } from '../../contracts/events.js';
import { EventService } from './index.js';
import { EventRuleStore, type TimeRule } from './rules.js';
import { OnceWaitService, RuleStoreSubscriptionReader, SubscriptionLifecycleService } from './subscriptions.js';
import { H2B_EVENT_TYPES, RuleBasedSchedulePort, TimeSourcePump, TimeSourceService, type EphemeralTimeSubscription } from './time-source.js';

// ---------------------------------------------------------------------------
// H2b zero-model host probe.
//
// Everything runs in one isolated in-memory ControlStore plus a throwaway
// plugin rule file. It never opens the live control database, never calls a
// model/embedding, never creates a Task or external Effect, and always closes
// its store and removes its temporary directory. The receipt is designed for
// the owner-only runtime diagnostic and must stay lossless JSON.
// ---------------------------------------------------------------------------

export const TIME_PROBE_TOOL_NAME = 'shiyu_diagnose_time_source';
export interface TimeSourceProbeCheck { id: string; ok: boolean; detail?: string }
export interface TimeSourceProbeTick {
  step: string; at: string; accepted: number; duplicate: number; skipped: number; deferred: number;
  gaps: string[]; eventsAfter: number;
}
export interface TimeSourceProbeEventIdentity {
  subscriptionId: string; ruleRevision: number; occurrence: string; scheduledFor: string;
  idempotencyKeyHash: string; eventIdHash: string;
}
export interface TimeSourceProbeResult {
  ok: true;
  toolName: typeof TIME_PROBE_TOOL_NAME;
  zeroModel: true; zeroEmbedding: true; zeroTaskOrEffect: true;
  store: { kind: 'in-memory'; liveDataTouched: false };
  catalog: { triggerType: string; observationType: string; registered: true };
  clock: { mode: 'deterministic'; base: string; stepsMs: number[] };
  ticks: TimeSourceProbeTick[];
  events: { count: number; types: string[]; identity?: TimeSourceProbeEventIdentity };
  onceWait: { claimed: number; matched: number; backgroundOnly: number; zeroModel: true };
  checks: TimeSourceProbeCheck[];
  released: true; disposed: true;
  diagnostics: {
    ruleStoreClosed: boolean; controlStoreClosed: boolean; tempDirectoryRemoved: boolean;
    cleanupErrors: string[]; durationMs: number; catalogTypes: string[];
  };
  observedAt: string;
}
export interface TimeSourceProbeOptions { signal?: AbortSignal; baseTimeMs?: number }
const OWNER_SCOPE = 'local-owner';
const ONCE_SCHEDULE = 'probe-once-schedule';
const LATEST_SCHEDULE = 'probe-latest-schedule';
const PAUSED_SCHEDULE = 'probe-paused-schedule';
const PROBE_HANDLER = 'probe.handler';
const PROBE_BINDING = 'probe.goal';
function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function checked(signal: AbortSignal | undefined): void { signal?.throwIfAborted(); }
export async function probeTimeSource(options: TimeSourceProbeOptions = {}): Promise<TimeSourceProbeResult> {
  if (!options || typeof options !== 'object') throw new Error('Invalid time source probe options');
  const signal = options.signal;
  checked(signal);
  const startedAt = Date.now();
  const base = options.baseTimeMs ?? Date.UTC(2026, 0, 1, 0, 0, 0);
  if (!Number.isSafeInteger(base) || base < 0) throw new Error('Invalid probe base time');
  let now = base;
  const clock = () => now;
  const advance = (ms: number) => { now += ms; };
  let store: ControlStore | undefined;
  let rulesDirectory: string | undefined;
  let eventRules: EventRuleStore | undefined;
  const cleanupErrors: string[] = [];
  let ruleStoreClosed = false;
  let controlStoreClosed = false;
  let tempDirectoryRemoved = false;
  const ticks: TimeSourceProbeTick[] = [];
  const stepsMs: number[] = [base];
  const checks: TimeSourceProbeCheck[] = [];
  let identity: TimeSourceProbeEventIdentity | undefined;
  let eventsSummary: { count: number; types: string[] } = { count: 0, types: [] };
  let onceWait = { claimed: 0, matched: 0, backgroundOnly: 0, zeroModel: true as const };
  let catalogTypes: string[] = [];
  let failure: unknown;
  try {
    store = await ControlStore.open({ filename: ':memory:', eventTypes: [...SHIYU_EVENT_TYPES, ...H2B_EVENT_TYPES], componentHandlers: [PROBE_HANDLER] });
    const events = new EventService(store);
    rulesDirectory = await mkdtemp(join(tmpdir(), 'shiyu-time-probe-'));
    eventRules = new EventRuleStore({ filename: join(rulesDirectory, 'rules.json'), now: clock });
    const lifecycle = new SubscriptionLifecycleService({ events, rules: eventRules, now: clock });
    const reader = new RuleStoreSubscriptionReader(eventRules, events);
    const owner: EventPrincipal = { principalId: 'probe-owner', kind: 'agent', scopes: [OWNER_SCOPE], publishTypes: ['agent.observation.reported'],
      subscribeTypes: [...SHIYU_EVENT_TYPES, ...H2B_EVENT_TYPES].map(type => type.type), targetRefs: [PROBE_HANDLER, PROBE_BINDING] };
    const timePublisher: EventPrincipal = { principalId: 'shiyu-time-source', kind: 'component', scopes: [OWNER_SCOPE],
      publishTypes: ['time.occurred', 'observation.changed'], subscribeTypes: [], targetRefs: [] };
    const eventPublisher: EventPrincipal = { principalId: 'probe-component', kind: 'component', scopes: [OWNER_SCOPE],
      publishTypes: ['component.observation.reported'], subscribeTypes: [], targetRefs: [] };
    const readerPrincipal: EventPrincipal = { principalId: 'probe-inspector', kind: 'component', scopes: [OWNER_SCOPE], publishTypes: [],
      subscribeTypes: [...SHIYU_EVENT_TYPES, ...H2B_EVENT_TYPES].map(type => type.type), targetRefs: [PROBE_HANDLER, PROBE_BINDING] };
    const waitConsumer: EventPrincipal = { principalId: 'probe-wait-consumer', kind: 'component', scopes: [OWNER_SCOPE], publishTypes: [],
      subscribeTypes: ['component.observation.reported'], targetRefs: [PROBE_BINDING] };
    const timeSource = new TimeSourceService({ events, rules: eventRules, schedule: new RuleBasedSchedulePort(eventRules),
      principal: timePublisher, readSubscription: id => reader.read(id), triggerEventType: 'time.occurred',
      observationEventType: 'observation.changed', clock });
    const wait = new OnceWaitService({ events, lifecycle, rules: eventRules, now: clock });
    const timeEvents = async (): Promise<StoredEvent[]> => (await events.listEvents(readerPrincipal)).filter(event => event.type === 'time.occurred');
    const tick = async (step: string): Promise<ReturnType<TimeSourceService['tick']> extends Promise<infer T> ? T : never> => {
      checked(signal);
      const receipt = await timeSource.tick();
      ticks.push({ step, at: new Date(now).toISOString(), accepted: receipt.accepted, duplicate: receipt.duplicate,
        skipped: receipt.skipped, deferred: receipt.deferred, gaps: receipt.gaps.slice(0, 8), eventsAfter: (await timeEvents()).length });
      stepsMs.push(now);
      checked(signal);
      return receipt;
    };
    const sub = (id: string, time: Record<string, unknown>, once = false) => lifecycle.subscribe(owner, {
      id, types: ['component.observation.reported'], scope: OWNER_SCOPE, target: { kind: 'component', handlerRef: PROBE_HANDLER },
      deliveryMode: 'component', start: { kind: 'from_now' }, ...(once ? { once: true } : {}), time,
    } as any);
    const times = (await events.types(readerPrincipal)).map(type => type.type);
    catalogTypes = times.filter(type => ['time.occurred', 'observation.changed'].includes(type)).sort();
    checks.push({ id: 'catalog_types', ok: catalogTypes.length === 2 && times.includes('time.occurred') && times.includes('observation.changed'),
      detail: catalogTypes.join(',') });
    // 1) Deterministic once rule due at base+5000.
    await sub('probe-once', { scheduleRef: ONCE_SCHEDULE, kind: 'once', atMs: base + 5000, misfirePolicy: 'latest' });
    const baseline = await tick('baseline');
    checks.push({ id: 'baseline_established', ok: baseline.gaps.includes('BASELINE_ESTABLISHED') && (await timeEvents()).length === 0 });
    advance(4000);
    await tick('before-due');
    checks.push({ id: 'not_due_before_occurrence', ok: (await timeEvents()).length === 0 });
    advance(1000);
    const due = await tick('once-due');
    const afterDue = await timeEvents();
    checks.push({ id: 'once_single_occurrence', ok: due.accepted === 1 && afterDue.length === 1
      && afterDue[0]!.payload.subscriptionId === 'probe-once' && afterDue[0]!.payload.ruleRevision === 1
      && afterDue[0]!.payload.scheduledFor === new Date(base + 5000).toISOString()
      && typeof afterDue[0]!.payload.occurrence === 'string' && (afterDue[0]!.payload.occurrence as string).startsWith('once:1:') });
    const onceEvent = afterDue[0]!;
    const idempotencyKey = `time:probe-once:1:${String(onceEvent.payload.occurrence)}`;
    identity = { subscriptionId: String(onceEvent.payload.subscriptionId), ruleRevision: Number(onceEvent.payload.ruleRevision),
      occurrence: String(onceEvent.payload.occurrence), scheduledFor: String(onceEvent.payload.scheduledFor),
      idempotencyKeyHash: sha(idempotencyKey), eventIdHash: sha(onceEvent.eventId).slice(0, 32) };
    const repeat = await tick('repeat-same-identity');
    checks.push({ id: 'repeat_tick_no_second_event', ok: repeat.accepted === 0 && repeat.duplicate === 0 && (await timeEvents()).length === 1 });
    // 2) latest-only interval rule merges missed periods.
    await sub('probe-latest', { scheduleRef: LATEST_SCHEDULE, kind: 'interval', intervalMs: 1000, misfirePolicy: 'latest' });
    await tick('latest-baseline');
    advance(3500);
    const merged = await tick('latest-multi-period');
    const latestEvents = (await timeEvents()).filter(event => event.payload.subscriptionId === 'probe-latest');
    const expectedScheduledFor = new Date(base + 8000).toISOString();
    checks.push({ id: 'latest_only_single_merged_occurrence', ok: merged.accepted === 1 && latestEvents.length === 1
      && latestEvents[0]!.payload.scheduledFor === expectedScheduledFor,
      detail: `expected ${expectedScheduledFor}, got ${String(latestEvents[0]?.payload.scheduledFor)}` });
    await tick('latest-repeat');
    checks.push({ id: 'latest_repeat_stays_silent', ok: (await timeEvents()).filter(event => event.payload.subscriptionId === 'probe-latest').length === 1 });
    // 3) clock rollback while the interval rule is still active is a visible gap.
    const beforeRollback = (await timeEvents()).length;
    advance(-1500);
    const rollback = await tick('clock-rollback');
    checks.push({ id: 'clock_rollback_gap_no_trigger', ok: rollback.gaps.includes('CLOCK_ROLLBACK') && (await timeEvents()).length === beforeRollback });
    advance(1500);
    // Stop the interval rule so later paused phases cannot add occurrences.
    await lifecycle.pause(owner, 'probe-latest', (await lifecycle.list(owner)).find(item => item.id === 'probe-latest')!.revision);
    // 4) paused rule never triggers while paused and does not revive its missed occurrence.
    const paused = await sub('probe-paused', { scheduleRef: PAUSED_SCHEDULE, kind: 'once', atMs: now + 2000, misfirePolicy: 'latest' }, true);
    await lifecycle.pause(owner, 'probe-paused', paused.revision);
    advance(2000);
    await tick('paused-due');
    const pausedCount = (await timeEvents()).filter(event => event.payload.subscriptionId === 'probe-paused').length;
    await lifecycle.resume(owner, 'probe-paused', (await lifecycle.list(owner)).find(item => item.id === 'probe-paused')!.revision);
    await tick('resumed-after-pause');
    const resumedCount = (await timeEvents()).filter(event => event.payload.subscriptionId === 'probe-paused').length;
    checks.push({ id: 'paused_not_triggered_no_replay', ok: pausedCount === 0 && resumedCount === 0, detail: `paused=${pausedCount}, resumed=${resumedCount}` });
    // 5) one-shot wait match is zero-model and consumes the once delivery.
    // Store expiry/claims use the real clock; the deterministic probe clock only
    // drives the declarative time source. Keep this wait subscription live in real time.
    const deadline = new Date(Date.now() + 60000).toISOString();
    const waitView = await wait.start(owner, { id: 'probe-wait', types: ['component.observation.reported'], scope: OWNER_SCOPE,
      target: { kind: 'agent', bindingId: PROBE_BINDING }, deliveryMode: 'background', start: { kind: 'from_now' }, once: true,
      expiresAt: deadline, onceWait: { targetBindingId: PROBE_BINDING, expiresAt: deadline, once: true } } as any);
    await events.publish(eventPublisher, { type: 'component.observation.reported', scope: OWNER_SCOPE,
      payload: { message: 'probe wait result', sourceRef: 'probe:wait' }, idempotencyKey: 'probe-wait-event' });
    const consumed = await wait.consume(owner, waitConsumer, async () => ({ allowed: true }));
    onceWait = { claimed: consumed.claimed, matched: consumed.matched, backgroundOnly: consumed.backgroundOnly, zeroModel: true };
    checks.push({ id: 'once_wait_matched_zero_model', ok: consumed.claimed === 1 && consumed.matched === 1 && consumed.backgroundOnly === 0, detail: `claimed=${consumed.claimed}, matched=${consumed.matched}, wait=${waitView.id}` });
    const occurredEvents = await timeEvents();
    eventsSummary = { count: occurredEvents.length, types: [...new Set(occurredEvents.map(event => event.type))].sort() };
    checks.push({ id: 'events_are_declared_types_only', ok: eventsSummary.types.every(type => type === 'time.occurred') && eventsSummary.count === 2,
      detail: `${eventsSummary.count} time.occurred` });
    // Owner/scope isolation of the probe event and identity.
    checks.push({ id: 'identity_scoped_to_probe', ok: occurredEvents.every(event => event.scope === OWNER_SCOPE
      && String(event.payload.subscriptionId).startsWith('probe-')) });
  } catch (error) { failure = error; }
  finally {
    if (eventRules) { try { await eventRules.ready(); ruleStoreClosed = true; } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); } }
    try { await store?.close(); controlStoreClosed = store !== undefined; } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    if (rulesDirectory) { try { await rm(rulesDirectory, { recursive: true, force: true }); tempDirectoryRemoved = true; } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); } }
  }
  if (failure) throw failure;
  checks.push({ id: 'isolated_in_memory_store', ok: true, detail: 'single :memory: ControlStore; no live data path' });
  checks.push({ id: 'zero_model_no_task_effect', ok: true, detail: 'no model/embedding/Task/Effect port exists in this probe' });
  checks.push({ id: 'cleanup_complete', ok: ruleStoreClosed && controlStoreClosed && tempDirectoryRemoved && cleanupErrors.length === 0,
    detail: cleanupErrors.join(';') });
  const failed = checks.filter(check => !check.ok);
  if (failed.length) throw new Error(`TIME_PROBE_FAILED: ${failed.map(check => `${check.id}${check.detail ? `(${check.detail.slice(0, 120)})` : ''}`).join(', ')}`);
  return { ok: true, toolName: TIME_PROBE_TOOL_NAME, zeroModel: true, zeroEmbedding: true, zeroTaskOrEffect: true,
    store: { kind: 'in-memory', liveDataTouched: false },
    catalog: { triggerType: 'time.occurred', observationType: 'observation.changed', registered: true },
    clock: { mode: 'deterministic', base: new Date(base).toISOString(), stepsMs: [...stepsMs].slice(0, 32) },
    ticks: ticks.slice(0, 16),
    events: { ...eventsSummary, ...(identity ? { identity } : {}) },
    onceWait, checks, released: true, disposed: true,
    diagnostics: { ruleStoreClosed, controlStoreClosed, tempDirectoryRemoved, cleanupErrors: cleanupErrors.slice(0, 8),
      durationMs: Date.now() - startedAt, catalogTypes },
    observedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// H2b LIVE time-trigger probe.
//
// Unlike probeTimeSource(), this probe intentionally writes one uniquely named
// one-shot rule into the *live* plugin EventRuleStore and lets the *live*
// TimeSourcePump tick publish one real `time.occurred` fact through the live
// EventService. It must not pretend to be side-effect free: the accepted event
// is appended to the live control ledger and cannot be deleted afterwards. The
// rule entry (and its derived time state) are removed again on cleanup; no other
// business table is written and no model/embedding/Task/Effect is involved.
//
// The probe publishes into the reserved probe scope so no live subscription can
// receive a delivery: only the append-only control event remains.
// ---------------------------------------------------------------------------

export const TIME_TRIGGER_PROBE_TOOL_NAME = 'shiyu_diagnose_time_trigger';
export const TIME_TRIGGER_PROBE_SCOPE = 'shiyu-time-probe';
export interface LiveTimeTriggerProbeOptions {
  events: EventService;
  rules: EventRuleStore;
  timeSource: TimeSourceService;
  /** The real live cooperative pump; its wake() drives the same tick path. */
  pump?: Pick<TimeSourcePump, 'wake'>;
  signal?: AbortSignal;
  /** Trusted admission gate (runtime pause/close); false aborts before writing. */
  allowed?: () => boolean;
  now?: () => number;
  dueInMs?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Test/trusted override; defaults to probe-time-trigger-<uuid>. */
  subscriptionId?: string;
  /** Trusted scope override for isolated tests; defaults to the reserved probe scope. */
  scope?: string;
}
export interface LiveTimeTriggerProbeCheck { id: string; ok: boolean; detail?: string }
export interface LiveTimeTriggerProbeResult {
  ok: true;
  toolName: typeof TIME_TRIGGER_PROBE_TOOL_NAME;
  liveDataTouched: 'control-events-append-only';
  zeroModel: true; zeroEmbedding: true; zeroTaskOrEffect: true;
  pumpDriven: boolean;
  rule: { subscriptionId: string; scheduleRef: string; ruleRevision: number; scope: string; dueAt: string; removed: true; timeStateRemoved: true };
  observed: {
    ticksObserved: number; pollCycles: number; eventCount: 1; occurredAt: string;
    identity: { subscriptionId: string; ruleRevision: number; occurrence: string; scheduledFor: string; eventIdHash: string };
  };
  /** Honest side-effect declaration. The appended event cannot be deleted. */
  sideEffects: {
    controlEventAppended: true; eventType: 'time.occurred'; eventId: string; appendOnly: true; eventDeletable: false;
    businessTablesWritten: []; ruleEntriesAddedThenRemoved: 1; residualRule: false; residualTimeState: false; externalEffects: 0;
  };
  checks: LiveTimeTriggerProbeCheck[];
  deadlines: { dueInMs: number; timeoutMs: number; pollIntervalMs: number };
  cleanup: { ephemeralReleased: true; ruleRemoved: true; timeStateRemoved: true; ruleFileEntriesForProbe: 0 };
  released: true; disposed: true; durationMs: number; observedAt: string;
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal!.reason ?? new Error('aborted')); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}
function probeSha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export async function probeLiveTimeTrigger(options: LiveTimeTriggerProbeOptions): Promise<LiveTimeTriggerProbeResult> {
  if (!options || typeof options !== 'object' || !options.events || !options.rules || !options.timeSource
    || typeof options.events.publish !== 'function' || typeof options.events.listEvents !== 'function') {
    throw new Error('TIME_TRIGGER_PROBE_INVALID: live EventService, EventRuleStore and TimeSourceService are required');
  }
  const signal = options.signal;
  const now = options.now ?? (() => Date.now());
  const allowed = options.allowed ?? (() => true);
  const dueInMs = options.dueInMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  if (!Number.isSafeInteger(dueInMs) || dueInMs < 50 || dueInMs > 4000
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 250) {
    throw new Error('TIME_TRIGGER_PROBE_INVALID: due/timeout/poll bounds are invalid');
  }
  const subscriptionId = options.subscriptionId ?? `probe-time-trigger-${randomUUID()}`;
  if (!/^probe-time-trigger-[A-Za-z0-9-]{8,160}$/.test(subscriptionId)) throw new Error('TIME_TRIGGER_PROBE_INVALID: invalid probe subscription id');
  const scope = options.scope ?? TIME_TRIGGER_PROBE_SCOPE;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(scope)) throw new Error('TIME_TRIGGER_PROBE_INVALID: invalid probe scope');
  const dueAt = now() + dueInMs;
  const scheduleRef = `probe-schedule-${subscriptionId.slice(-24)}`;
  const timing: TimeRule = { scheduleRef, kind: 'once', atMs: dueAt, misfirePolicy: 'latest' };
  const ephemeral: EphemeralTimeSubscription = { subscriptionId, ruleRevision: 1, scope, timing };
  const inspector: EventPrincipal = { principalId: 'shiyu-time-trigger-probe-inspector', kind: 'component', scopes: [scope],
    publishTypes: [], subscribeTypes: ['time.occurred'], targetRefs: [] };
  const startedAt = Date.now();
  const checks: LiveTimeTriggerProbeCheck[] = [];
  const ticks = { observed: 0, pollCycles: 0 };
  let releaseEphemeral: (() => void) | undefined;
  let ruleWritten = false;
  let observedEvent: StoredEvent | undefined;
  let eventCount = 0;
  let cleanupDone = false;
  let ruleRemoved = false;
  let timeStateRemoved = false;
  let ephemeralReleased = false;
  let failure: unknown;
  const probeEvents = async (): Promise<StoredEvent[]> => (await options.events.listEvents(inspector, { limit: 100 }))
    .filter(event => event.type === 'time.occurred' && event.payload.subscriptionId === subscriptionId && event.scope === scope);
  const admission = (phase: string): void => {
    signal?.throwIfAborted();
    if (!allowed()) throw new Error(`TIME_TRIGGER_PROBE_PAUSED: runtime is paused before ${phase}`);
  };
  const wake = async (): Promise<void> => {
    if (options.pump) { await options.pump.wake(); ticks.observed++; }
  };
  try {
    admission('writing the live probe rule');
    releaseEphemeral = options.timeSource.registerEphemeralTimeSubscription(ephemeral);
    await options.rules.putRule({ subscriptionId, conditionRevision: 1,
      ownerPrincipal: { principalId: 'shiyu-time-trigger-probe', kind: 'component', scopes: [scope],
        publishTypes: [], subscribeTypes: ['time.occurred'], targetRefs: [] },
      time: timing });
    ruleWritten = true;
    // Establish the declarative baseline before the due time. A later wake at
    // the due boundary publishes the canonical occurrence exactly once.
    await wake();
    if ((await probeEvents()).length !== 0) throw new Error('TIME_TRIGGER_PROBE_FAILED: probe event appeared before its due time');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      admission('waiting for the due trigger');
      ticks.pollCycles++;
      const events = await probeEvents();
      if (events.length) { observedEvent = events[0]; break; }
      if (now() >= dueAt) await wake();
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
    }
    if (!observedEvent) {
      const residue = await probeEvents();
      throw new Error(`TIME_TRIGGER_PROBE_TIMEOUT: no live time.occurred within ${timeoutMs} ms; controlEventAppended=${residue.length > 0}`);
    }
    eventCount = (await probeEvents()).length;
    const expectedOccurrence = `once:1:${new Date(dueAt).toISOString()}`;
    const identity = observedEvent.payload;
    checks.push({ id: 'exactly_one_live_event', ok: eventCount === 1, detail: `count=${eventCount}` });
    checks.push({ id: 'canonical_identity', ok: String(identity.subscriptionId) === subscriptionId
      && Number(identity.ruleRevision) === 1 && String(identity.occurrence) === expectedOccurrence
      && String(identity.scheduledFor) === new Date(dueAt).toISOString() && String(identity.scheduleRef) === scheduleRef,
      detail: `${String(identity.occurrence)}` });
    checks.push({ id: 'probe_scope_isolated', ok: observedEvent.scope === scope
      && scope !== 'local-owner', detail: scope });
    // Repeated pump ticks must stay idempotent for the canonical occurrence.
    await wake(); await wake();
    const afterRepeat = await probeEvents();
    checks.push({ id: 'repeat_tick_no_second_event', ok: afterRepeat.length === 1 && afterRepeat[0]!.eventId === observedEvent.eventId,
      detail: `after=${afterRepeat.length}` });
    eventCount = afterRepeat.length;
    // Only the intended control event type was produced by this probe.
    checks.push({ id: 'no_unexpected_event_types', ok: afterRepeat.every(event => event.type === 'time.occurred') });
  } catch (error) { failure = error; }
  finally {
    if (releaseEphemeral) { try { releaseEphemeral(); ephemeralReleased = options.timeSource.ephemeralSubscriptionIds().every(id => id !== subscriptionId); } catch { ephemeralReleased = false; } }
    if (ruleWritten) {
      try { ruleRemoved = await options.rules.deleteRule(subscriptionId); } catch { ruleRemoved = false; }
      try { timeStateRemoved = await options.rules.deleteTimeState(subscriptionId); } catch { timeStateRemoved = false; }
    }
    cleanupDone = true;
  }
  const residualRule = ruleWritten ? await options.rules.getRule(subscriptionId) !== undefined : false;
  const residualTimeState = timeStateRemoved ? false : (await options.rules.getTimeState(subscriptionId)).lastEvaluatedAt !== undefined;
  const appended = observedEvent !== undefined;
  const cleanupChecks: LiveTimeTriggerProbeCheck[] = [
    { id: 'cleanup_rule_removed', ok: ruleRemoved && !residualRule, detail: `ruleRemoved=${ruleRemoved}` },
    { id: 'cleanup_time_state_removed', ok: timeStateRemoved && !residualTimeState, detail: `timeStateRemoved=${timeStateRemoved}` },
    { id: 'cleanup_ephemeral_released', ok: ephemeralReleased, detail: `released=${ephemeralReleased}` },
  ];
  checks.push(...cleanupChecks);
  const failed = checks.filter(check => !check.ok);
  if (failure) {
    // Before any live write, preserve the exact cancellation/admission error (the
    // runtime abort path relies on the caller's reason). After a write, append the
    // honest side-effect/cleanup status so a caller cannot mistake it for clean.
    if (!ruleWritten && !appended) throw failure;
    const suffix = ` (controlEventAppended=${appended}; ruleRemoved=${ruleRemoved}; timeStateRemoved=${timeStateRemoved})`;
    throw new Error(`${failure instanceof Error ? failure.message : String(failure)}${suffix}`, { cause: failure });
  }
  if (failed.length) throw new Error(`TIME_TRIGGER_PROBE_FAILED: ${failed.map(check => `${check.id}${check.detail ? `(${check.detail.slice(0, 120)})` : ''}`).join(', ')} (controlEventAppended=${appended})`);
  if (!observedEvent) throw new Error(`TIME_TRIGGER_PROBE_FAILED: no observed live event (controlEventAppended=false)`);
  return {
    ok: true, toolName: TIME_TRIGGER_PROBE_TOOL_NAME, liveDataTouched: 'control-events-append-only',
    zeroModel: true, zeroEmbedding: true, zeroTaskOrEffect: true, pumpDriven: options.pump !== undefined,
    rule: { subscriptionId, scheduleRef, ruleRevision: 1, scope, dueAt: new Date(dueAt).toISOString(), removed: true as const, timeStateRemoved: timeStateRemoved as true },
    observed: { ticksObserved: ticks.observed, pollCycles: ticks.pollCycles, eventCount: 1, occurredAt: observedEvent.receivedAt,
      identity: { subscriptionId, ruleRevision: 1, occurrence: `once:1:${new Date(dueAt).toISOString()}`,
        scheduledFor: new Date(dueAt).toISOString(), eventIdHash: probeSha(observedEvent.eventId).slice(0, 32) } },
    sideEffects: { controlEventAppended: true, eventType: 'time.occurred', eventId: observedEvent.eventId,
      appendOnly: true, eventDeletable: false, businessTablesWritten: [], ruleEntriesAddedThenRemoved: 1,
      residualRule: false, residualTimeState: false, externalEffects: 0 },
    checks, deadlines: { dueInMs, timeoutMs, pollIntervalMs },
    cleanup: { ephemeralReleased: ephemeralReleased as true, ruleRemoved: ruleRemoved as true, timeStateRemoved: timeStateRemoved as true,
      ruleFileEntriesForProbe: 0 },
    released: true, disposed: true, durationMs: Date.now() - startedAt, observedAt: new Date().toISOString(),
  };
}
