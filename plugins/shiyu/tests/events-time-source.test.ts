import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventRuleStore } from '../src/control/events/rules.js';
import { RuleStoreSubscriptionReader, SubscriptionLifecycleService } from '../src/control/events/subscriptions.js';
import { H2B_EVENT_TYPES, RuleBasedSchedulePort, TimeSourcePump, TimeSourceService, type ReadonlyObservationPort, type SchedulePort, type TimeScheduleRecord } from '../src/control/events/time-source.js';
import { SHIYU_EVENT_TYPES, type EventPrincipal } from '../src/contracts/events.js';
import { eventStore, readerPrincipal } from './events-fixtures.js';

const OWNER = 'local-owner';
const TYPES = [...SHIYU_EVENT_TYPES, ...H2B_EVENT_TYPES];
const publisher: EventPrincipal = { principalId: 'shiyu-time-source', kind: 'component', scopes: [OWNER],
  publishTypes: ['time.occurred', 'observation.changed'], subscribeTypes: [], targetRefs: [] };
const inspector: EventPrincipal = { principalId: 'test-time-inspector', kind: 'component', scopes: [OWNER], publishTypes: [],
  subscribeTypes: TYPES.map(type => type.type), targetRefs: ['h2b.handler', 'goal:h2b'] };
const actor: EventPrincipal = { principalId: 'core-agent:h2b-time', kind: 'agent', scopes: [OWNER], publishTypes: ['agent.observation.reported'],
  subscribeTypes: TYPES.map(type => type.type), targetRefs: ['goal:h2b', 'h2b.handler'] };
const subscriptionInput = (id: string, time: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id, types: ['component.observation.reported'], scope: OWNER, target: { kind: 'component' as const, handlerRef: 'h2b.handler' },
  deliveryMode: 'component' as const, start: { kind: 'from_now' as const }, time, ...extra,
} as any);
async function fixture(t: import('node:test').TestContext, options: { observation?: ReadonlyObservationPort } = {}) {
  const f = await eventStore(t, ['h2b.handler'], TYPES);
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-h2b-time-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let nowMs = Date.UTC(2026, 0, 1, 8, 0, 0);
  const clock = () => nowMs;
  const advance = (ms: number) => { nowMs += ms; };
  const setNow = (ms: number) => { nowMs = ms; };
  const rules = new EventRuleStore({ filename: join(directory, 'rules.json'), now: clock });
  const lifecycle = new SubscriptionLifecycleService({ events: f.events, rules, now: clock });
  const schedules: TimeScheduleRecord[] = [];
  const port: SchedulePort = { async list() { return schedules.map(record => structuredClone(record)); } };
  const readSubscription = async (id: string) => (await lifecycle.list(actor)).find(item => item.id === id);
  const service = (overrides: Record<string, unknown> = {}) => new TimeSourceService({ events: f.events, rules, schedule: port,
    principal: publisher, readSubscription, triggerEventType: 'time.occurred', observationEventType: 'observation.changed', clock,
    ...(options.observation ? { observation: options.observation } : {}), ...overrides });
  return { ...f, directory, rules, lifecycle, schedules, port, service, clock, advance, setNow };
}
async function bindSchedule(f: Awaited<ReturnType<typeof fixture>>, subscriptionId: string, time: Record<string, unknown>) {
  const created = await f.lifecycle.subscribe(actor, subscriptionInput(subscriptionId, time));
  const rule = await f.rules.getRule(subscriptionId);
  assert.ok(rule?.time);
  f.schedules.push({ scheduleRef: String(time.scheduleRef), subscriptionId, ruleRevision: rule!.conditionRevision, timing: rule!.time, enabled: true });
  return { created, rule: rule! };
}

test('time source establishes a baseline, fires latest-only once per canonical occurrence and never replays duplicates', async t => {
  const f = await fixture(t);
  await bindSchedule(f, 'h2b-interval', { scheduleRef: 'every-second', kind: 'interval', intervalMs: 1000, misfirePolicy: 'latest' });
  const source = f.service();
  const baseline = await source.tick();
  assert.equal(baseline.accepted, 0, 'fresh state establishes a baseline instead of replaying history');
  assert.ok(baseline.gaps.includes('BASELINE_ESTABLISHED'));
  assert.equal((await f.events.listEvents(readerPrincipal())).filter(event => event.type === 'time.occurred').length, 0);
  f.advance(999);
  assert.equal((await source.tick()).accepted, 0, 'nothing is due before the interval elapses');
  f.advance(1);
  const first = await source.tick();
  assert.equal(first.accepted, 1);
  assert.equal(first.duplicate, 0);
  const events = (await f.events.listEvents(inspector)).filter(event => event.type === 'time.occurred');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actor.principalId, 'shiyu-time-source');
  assert.equal(events[0]!.payload.subscriptionId, 'h2b-interval');
  assert.equal(events[0]!.payload.scheduledFor, new Date(Date.UTC(2026, 0, 1, 8, 0, 1)).toISOString());
  assert.match(String(events[0]!.payload.occurrence), /^interval:1:/);
  // Same clock again: no second occurrence identity.
  assert.equal((await source.tick()).accepted, 0);
  assert.equal((await source.tick()).accepted, 0);
  // Four missed intervals collapse to the latest boundary only.
  f.advance(4000);
  const merged = await source.tick();
  assert.equal(merged.accepted, 1);
  assert.equal((await f.events.listEvents(inspector)).filter(event => event.type === 'time.occurred').length, 2,
    'latest-only merges missed periods instead of replaying each one');
});

test('duplicate schedule records sharing one canonical occurrence fire exactly once', async t => {
  const f = await fixture(t);
  const bound = await bindSchedule(f, 'h2b-duplicate-schedule', { scheduleRef: 'dup', kind: 'interval', intervalMs: 1000, misfirePolicy: 'latest' });
  f.schedules.push(structuredClone(f.schedules[0]!));
  assert.equal(f.schedules.length, 2, 'two declarations bind to the same occurrence identity');
  const source = f.service();
  await source.tick();
  f.advance(1000);
  const tick = await source.tick();
  assert.equal(tick.accepted + tick.duplicate, 1);
  assert.equal((await f.events.listEvents(inspector)).filter(event => event.type === 'time.occurred').length, 1);
  assert.equal(bound.rule.conditionRevision, 1);
});

test('cancel/pause/resume, clock rollback and restart never revive old triggers', async t => {
  const f = await fixture(t);
  const bound = await bindSchedule(f, 'h2b-control', { scheduleRef: 'ctl', kind: 'interval', intervalMs: 1000, misfirePolicy: 'latest' });
  const source = f.service();
  await source.tick();
  f.advance(1000);
  assert.equal((await source.tick()).accepted, 1);
  // Pause blocks dispatch; elapsed periods are not replayed one by one.
  const paused = await f.lifecycle.pause(actor, 'h2b-control', bound.created.revision);
  f.advance(5000);
  const whilePaused = await source.tick();
  assert.equal(whilePaused.accepted, 0);
  assert.ok(whilePaused.gaps.includes('SUBSCRIPTION_INACTIVE'));
  const resumed = await f.lifecycle.resume(actor, 'h2b-control', paused.revision);
  const afterResume = await source.tick();
  assert.ok(afterResume.accepted <= 1, 'resume merges at most one current occurrence, never the whole backlog');
  const countAfterResume = (await f.events.listEvents(inspector)).filter(event => event.type === 'time.occurred').length;
  assert.equal((await source.tick()).accepted, 0);
  // Clock rollback records a gap and never re-fires.
  f.advance(-60000);
  const rollback = await source.tick();
  assert.equal(rollback.accepted, 0);
  assert.ok(rollback.gaps.includes('CLOCK_ROLLBACK'));
  // Restart with the same durable rules/state does not replay accepted occurrences.
  const beforeRestart = (await f.events.listEvents(inspector)).filter(event => event.type === 'time.occurred').length;
  const restarted = f.service();
  f.advance(60000);
  const rolledBackOccurrence = (await restarted.tick());
  assert.equal(rolledBackOccurrence.duplicate + rolledBackOccurrence.accepted, 1);
  assert.equal((await f.events.listEvents(inspector)).filter(event => event.type === 'time.occurred').length, beforeRestart,
    'a rolled-back causally identical occurrence is deduplicated, never a second event');
  f.advance(2000);
  await restarted.tick();
  assert.equal((await f.events.listEvents(inspector)).filter(event => event.type === 'time.occurred').length, beforeRestart + 1,
    'restart may fire at most the current latest occurrence, not old ones');
  assert.equal(resumed.status, 'active');
  // Retired subscription/schedule leaves the declarative source.
  await f.lifecycle.unsubscribe(actor, 'h2b-control', (await f.lifecycle.list(actor)).find(item => item.id === 'h2b-control')!.revision);
  const port = new RuleBasedSchedulePort(f.rules);
  assert.equal((await port.list()).some(record => record.subscriptionId === 'h2b-control'), false);
  f.advance(1000);
  const afterRetire = await f.service().tick();
  assert.equal(afterRetire.accepted, 0);
  assert.equal(new Set((await f.events.listEvents(inspector)).filter(event => event.type === 'time.occurred').map(event => event.payload.occurrence)).size,
    (await f.events.listEvents(inspector)).filter(event => event.type === 'time.occurred').length, 'occurrence identities stay unique');
});

test('once schedules fire once after their canonical due time and not after restart', async t => {
  const f = await fixture(t);
  const at = f.clock() + 5000;
  await bindSchedule(f, 'h2b-once', { scheduleRef: 'once', kind: 'once', atMs: at, misfirePolicy: 'latest' });
  const source = f.service();
  await source.tick();
  f.advance(4999);
  assert.equal((await source.tick()).accepted, 0, 'a one-shot time trigger waits for its due time');
  f.advance(1);
  assert.equal((await source.tick()).accepted, 1);
  assert.equal((await source.tick()).accepted, 0);
  const restarted = f.service();
  f.advance(600000);
  await restarted.tick();
  assert.equal((await f.events.listEvents(inspector)).filter(event => event.type === 'time.occurred').length, 1,
    'a restart never replays an already handled once occurrence');
});

test('daily schedules change timezone/time only once, record the change and never duplicate a day', async t => {
  const f = await fixture(t);
  const bound = await bindSchedule(f, 'h2b-daily', { scheduleRef: 'daily-8', kind: 'daily', dailyAt: { hour: 9, minute: 0, zoneOffsetMinutes: 0 }, misfirePolicy: 'latest' });
  const source = f.service();
  await source.tick();
  f.advance(3600000); // 09:00 UTC
  assert.equal((await source.tick()).accepted, 1);
  // Rule revision changes (e.g. timezone edit) fence the previous state; stale
  // schedule records for older revisions never fire.
  const updated = await f.lifecycle.update(actor, 'h2b-daily', bound.created.revision,
    { time: { scheduleRef: 'daily-8', kind: 'daily', dailyAt: { hour: 9, minute: 0, zoneOffsetMinutes: 60 }, misfirePolicy: 'latest' } });
  const ruled = await f.rules.getRule('h2b-daily');
  f.schedules[0] = { ...f.schedules[0]!, ruleRevision: ruled!.conditionRevision, timing: ruled!.time! };
  f.advance(1800000);
  const changed = await source.tick();
  assert.ok(changed.gaps.includes('TIMEZONE_CHANGED'));
  assert.equal(changed.accepted, 0);
  assert.equal((await f.events.listEvents(inspector)).filter(event => event.type === 'time.occurred').length, 1,
    'a timezone change does not duplicate or replay the previous day');
  assert.equal(updated.conditionRevision, 2);
});

test('external changes use a bounded read-only observation port and never wake a model', async t => {
  const observed: string[] = [];
  let result: { version: number; changed: boolean; digest?: string; gap?: string } = { version: 1, changed: false };
  let failure: Error | undefined;
  const observation: ReadonlyObservationPort = { async observe(ref) {
    observed.push(ref); if (failure) throw failure;
    return { ...result };
  } };
  const f = await fixture(t, { observation });
  await f.lifecycle.subscribe(actor, subscriptionInput('h2b-observation', undefined as any, {
    time: undefined, observation: { observationRef: 'capability:file-status', minIntervalMs: 1000, policy: 'changed' },
  }));
  const source = f.service();
  // No model port exists at all; only the injected observation port is called.
  const first = await source.scanObservations();
  assert.equal(first.observations, 1);
  assert.equal(first.accepted, 0);
  assert.deepEqual(observed, ['capability:file-status']);
  assert.equal((await f.events.listEvents(inspector)).length, 0);
  // Unchanged next scan stays quiet and a throttled scan defers.
  result = { version: 1, changed: false };
  f.advance(500);
  assert.equal((await source.scanObservations()).deferred, 1);
  f.advance(600);
  assert.equal((await source.scanObservations()).accepted, 0);
  // A changed, newer observation publishes exactly one deterministic event.
  result = { version: 2, changed: true, digest: 'sha256:abc' };
  f.advance(1000);
  const changed = await source.scanObservations();
  assert.equal(changed.accepted, 1);
  const events = await f.events.listEvents(inspector);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'observation.changed');
  assert.equal(events[0]!.payload.version, 2);
  assert.equal(events[0]!.payload.digest, 'sha256:abc');
  // Same version again is not a new change.
  f.advance(1000);
  assert.equal((await source.scanObservations()).accepted, 0);
  // Observer failure is a visible gap, never "no change".
  failure = new Error('observation backend unavailable');
  f.advance(60000);
  const failed = await source.scanObservations();
  assert.ok(failed.gaps.includes('observation backend unavailable'));
  assert.equal(failed.accepted, 0);
  assert.equal((await f.events.listEvents(inspector)).length, 1);
});

test('observation scan skips inactive subscriptions and keeps read-only state bounded', async t => {
  let calls = 0;
  const observation: ReadonlyObservationPort = { async observe() { calls++; return { version: 1, changed: true }; } };
  const f = await fixture(t, { observation });
  const created = await f.lifecycle.subscribe(actor, subscriptionInput('h2b-observation-paused', undefined as any, {
    time: undefined, observation: { observationRef: 'capability:health', minIntervalMs: 1000, policy: 'changed' },
  }));
  const source = f.service();
  await f.lifecycle.pause(actor, 'h2b-observation-paused', created.revision);
  const paused = await source.scanObservations();
  assert.equal(paused.observations, 0);
  assert.equal(calls, 0);
  const status = await source.status('h2b-observation-paused');
  assert.equal(status.rule?.observation?.observationRef, 'capability:health');
  assert.ok(Array.isArray(status.state.gaps));
});

test('cooperative pump drives ticks without operation slots or model calls and coalesces overlap', async t => {
  const f = await fixture(t);
  await bindSchedule(f, 'h2b-pump', { scheduleRef: 'pump', kind: 'interval', intervalMs: 1000, misfirePolicy: 'latest' });
  const source = f.service();
  await source.tick();
  const failures: unknown[] = [];
  const pump = new TimeSourcePump({ source, tickIntervalMs: 100, observationIntervalMs: 10000, now: f.clock, onFailure: error => failures.push(error) });
  t.after(() => pump.close());
  pump.start();
  f.advance(2500);
  await new Promise<void>(done => setTimeout(done, 160));
  const snapshot = pump.snapshot();
  assert.ok(snapshot.lastTick);
  assert.ok((snapshot.lastTick!.accepted + snapshot.lastTick!.duplicate) >= 1);
  assert.equal(snapshot.state === 'degraded', false);
  assert.deepEqual(failures, []);
  assert.equal((await f.events.listEvents(inspector)).filter(event => event.type === 'time.occurred').length, 1,
    'the pump merges elapsed periods instead of firing per tick');
  const before = snapshot.lastTickAt;
  f.advance(1000);
  await new Promise<void>(done => setTimeout(done, 140));
  assert.notEqual(pump.snapshot().lastTickAt, before);
  await pump.close();
  assert.equal(pump.snapshot().state, 'stopped');
  const afterClose = pump.snapshot().lastTickAt;
  f.advance(5000);
  await new Promise<void>(done => setTimeout(done, 30));
  assert.equal(pump.snapshot().lastTickAt, afterClose, 'a closed pump performs no more ticks');
});

test('owner-scoped reader exposes only subscriptions created by a recorded trusted principal', async t => {
  const f = await fixture(t);
  const created = await f.lifecycle.subscribe(actor, subscriptionInput('h2b-reader', { scheduleRef: 'reader', kind: 'interval', intervalMs: 1000, misfirePolicy: 'latest' }));
  const reader = new RuleStoreSubscriptionReader(f.rules, f.events);
  const read = await reader.read('h2b-reader');
  assert.equal(read?.id, 'h2b-reader');
  assert.equal(read?.ownerId, actor.principalId);
  const listed = await reader.list();
  assert.equal(listed.length, 1);
  await f.lifecycle.unsubscribe(actor, 'h2b-reader', (await f.lifecycle.list(actor)).find(item => item.id === 'h2b-reader')!.revision);
  assert.equal((await reader.read('h2b-reader'))?.status, 'retired');
  assert.equal(created.conditionRevision, 1);
});

test('the cooperative pump is gated by runtime pause/stop and resumes without replaying missed periods', async t => {
  const f = await fixture(t);
  await bindSchedule(f, 'h2b-pump-gate', { scheduleRef: 'gate', kind: 'interval', intervalMs: 1000, misfirePolicy: 'latest' });
  const source = f.service();
  await source.tick();
  let allowed = true;
  const pump = new TimeSourcePump({ source, tickIntervalMs: 100, observationIntervalMs: 10000, now: f.clock, allowed: () => allowed });
  t.after(() => pump.close());
  pump.start();
  allowed = false;
  f.advance(3000);
  await new Promise<void>(done => setTimeout(done, 140));
  assert.equal(pump.snapshot().lastTick, undefined, 'a paused runtime performs no time-source ticks');
  assert.equal((await f.events.listEvents(inspector)).filter(event => event.type === 'time.occurred').length, 0);
  allowed = true;
  await new Promise<void>(done => setTimeout(done, 140));
  assert.equal((await f.events.listEvents(inspector)).filter(event => event.type === 'time.occurred').length, 1,
    'resume merges at most one latest occurrence and never replays the backlog');
  await pump.close();
});
