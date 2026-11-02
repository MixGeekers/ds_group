import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../adapters/control-store/index.js';
import { SHIYU_EVENT_TYPES, type EventPrincipal, type StoredEvent } from '../../contracts/events.js';
import { EventService } from './index.js';
import { EventRuleStore } from './rules.js';
import { OnceWaitService, RuleStoreSubscriptionReader, SubscriptionLifecycleService } from './subscriptions.js';
import { H2B_EVENT_TYPES, RuleBasedSchedulePort, TimeSourceService } from './time-source.js';

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
