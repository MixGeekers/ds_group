import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { EventService } from '../src/control/events/index.js';
import { EventRuleStore } from '../src/control/events/rules.js';
import { probeLiveTimeTrigger, TIME_TRIGGER_PROBE_SCOPE, TIME_TRIGGER_PROBE_TOOL_NAME } from '../src/control/events/probe.js';
import { H2B_EVENT_TYPES, RuleBasedSchedulePort, TimeSourcePump, TimeSourceService } from '../src/control/events/time-source.js';
import { SHIYU_EVENT_TYPES, type EventPrincipal } from '../src/contracts/events.js';

const TYPES = [...SHIYU_EVENT_TYPES, ...H2B_EVENT_TYPES];
async function fixture(t: import('node:test').TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-live-time-trigger-'));
  const store = await ControlStore.open({ filename: join(directory, 'events.sqlite'), eventTypes: TYPES, componentHandlers: [] });
  const events = new EventService(store);
  const rules = new EventRuleStore({ filename: join(directory, 'rules.json') });
  const source = new TimeSourceService({ events, rules, schedule: new RuleBasedSchedulePort(rules),
    principal: { principalId: 'shiyu-time-source', kind: 'component', scopes: ['local-owner', TIME_TRIGGER_PROBE_SCOPE],
      publishTypes: ['time.occurred', 'observation.changed'], subscribeTypes: [], targetRefs: [] },
    readSubscription: async () => undefined, triggerEventType: 'time.occurred', observationEventType: 'observation.changed' });
  const pump = new TimeSourcePump({ source, tickIntervalMs: 100 });
  const inspector: EventPrincipal = { principalId: 'test-live-trigger-inspector', kind: 'component',
    scopes: [TIME_TRIGGER_PROBE_SCOPE], publishTypes: [], subscribeTypes: ['time.occurred'], targetRefs: [] };
  t.after(async () => {
    await pump.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store, events, rules, source, pump, inspector };
}
const probe = (f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) => probeLiveTimeTrigger({
  events: f.events, rules: f.rules, timeSource: f.source, pump: f.pump, dueInMs: 150, timeoutMs: 3000, pollIntervalMs: 20, ...extra });
const liveEvents = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.events.listEvents(f.inspector, { limit: 100 }))
  .filter(event => event.type === 'time.occurred');

test('live probe appends exactly one canonical time.occurred through the real pump tick path', async t => {
  const f = await fixture(t);
  const result = await probe(f);
  assert.equal(result.ok, true);
  assert.equal(result.toolName, TIME_TRIGGER_PROBE_TOOL_NAME);
  assert.equal(result.liveDataTouched, 'control-events-append-only');
  assert.equal(result.zeroModel, true); assert.equal(result.zeroEmbedding, true); assert.equal(result.zeroTaskOrEffect, true);
  assert.equal(result.pumpDriven, true);
  assert.ok(result.rule.subscriptionId.startsWith('probe-time-trigger-'));
  assert.equal(result.rule.ruleRevision, 1);
  assert.ok(result.observed.ticksObserved >= 3, 'baseline + due + repeat ticks were requested');
  assert.equal(result.observed.eventCount, 1);
  assert.equal(result.sideEffects.controlEventAppended, true);
  assert.equal(result.sideEffects.appendOnly, true);
  assert.equal(result.sideEffects.eventDeletable, false);
  assert.deepEqual(result.sideEffects.businessTablesWritten, []);
  assert.equal(result.sideEffects.externalEffects, 0);
  for (const check of result.checks) assert.equal(check.ok, true, `${check.id}: ${check.detail ?? ''}`);
  const events = await liveEvents(f);
  assert.equal(events.length, 1, 'the control ledger now contains exactly one append-only probe event');
  assert.equal(events[0]!.eventId, result.sideEffects.eventId);
  assert.equal(events[0]!.scope, TIME_TRIGGER_PROBE_SCOPE);
  assert.equal(events[0]!.payload.subscriptionId, result.rule.subscriptionId);
  assert.equal(events[0]!.payload.ruleRevision, 1);
  assert.equal(events[0]!.payload.occurrence, result.observed.identity.occurrence);
  assert.equal(events[0]!.payload.scheduledFor, result.rule.dueAt);
});

test('repeated pump ticks after the probe never create a second canonical event', async t => {
  const f = await fixture(t);
  const result = await probe(f);
  await f.pump.wake();
  await f.pump.wake();
  const events = await liveEvents(f);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.eventId, result.sideEffects.eventId);
  assert.ok(result.checks.find(check => check.id === 'repeat_tick_no_second_event')?.ok);
});

test('cleanup removes the live rule and time state but honestly keeps the append-only event', async t => {
  const f = await fixture(t);
  const result = await probe(f);
  assert.equal(await f.rules.getRule(result.rule.subscriptionId), undefined);
  assert.equal((await f.rules.getTimeState(result.rule.subscriptionId)).lastEvaluatedAt, undefined);
  assert.deepEqual(f.source.ephemeralSubscriptionIds(), []);
  assert.equal(result.cleanup.ephemeralReleased, true);
  assert.equal(result.cleanup.ruleRemoved, true);
  assert.equal(result.cleanup.timeStateRemoved, true);
  const file = await readFile(join(f.directory, 'rules.json'), 'utf8');
  assert.equal(file.includes(result.rule.subscriptionId), false, 'no probe rule entry survives in the live rule file');
  assert.equal(result.sideEffects.residualRule, false);
  // A second probe gets a unique identity and independently appends exactly one more event.
  const second = await probe(f);
  assert.notEqual(second.rule.subscriptionId, result.rule.subscriptionId);
  assert.notEqual(second.sideEffects.eventId, result.sideEffects.eventId);
  assert.notEqual(second.observed.identity.occurrence, result.observed.identity.occurrence);
  const events = await liveEvents(f);
  assert.equal(events.length, 2);
  assert.deepEqual(new Set(events.map(event => String(event.payload.subscriptionId))).size, 2);
});

test('a paused runtime gate aborts before any rule or event is written', async t => {
  const f = await fixture(t);
  await assert.rejects(probe(f, { allowed: () => false }), /TIME_TRIGGER_PROBE_PAUSED/);
  assert.deepEqual(f.source.ephemeralSubscriptionIds(), []);
  assert.equal((await f.rules.listRules()).length, 0);
  assert.equal((await liveEvents(f)).length, 0);
});

test('a pause during the wait aborts, cleans the rule and never appends an event', async t => {
  const f = await fixture(t);
  let allowed = true;
  const running = probe(f, { allowed: () => allowed, dueInMs: 500, timeoutMs: 3000, pollIntervalMs: 20 });
  await delay(60);
  allowed = false;
  await assert.rejects(running, /TIME_TRIGGER_PROBE_PAUSED/);
  assert.deepEqual(f.source.ephemeralSubscriptionIds(), []);
  assert.equal((await f.rules.listRules()).length, 0);
  assert.equal((await liveEvents(f)).length, 0);
});

test('the probe deadline aborts without a trigger and still removes its rule', async t => {
  const f = await fixture(t);
  await assert.rejects(probe(f, { dueInMs: 1000, timeoutMs: 200, pollIntervalMs: 20 }), /TIME_TRIGGER_PROBE_TIMEOUT/);
  assert.deepEqual(f.source.ephemeralSubscriptionIds(), []);
  assert.equal((await f.rules.listRules()).length, 0);
  assert.equal((await liveEvents(f)).length, 0);
});

test('a real auto-ticking TimeSourcePump also drives the live rule without an explicit wake', async t => {
  const f = await fixture(t);
  f.pump.start();
  const result = await probeLiveTimeTrigger({ events: f.events, rules: f.rules, timeSource: f.source,
    dueInMs: 250, timeoutMs: 3000, pollIntervalMs: 20 });
  assert.equal(result.pumpDriven, false, 'no explicit pump handle was supplied');
  assert.equal(result.observed.eventCount, 1);
  assert.equal(result.checks.find(check => check.id === 'exactly_one_live_event')?.ok, true);
  await f.pump.wake();
  assert.equal((await liveEvents(f)).length, 1);
});

test('the receipt is lossless JSON and an aborted signal leaves no probe rule behind', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const reason = new Error('owner cancelled the live trigger probe');
  controller.abort(reason);
  await assert.rejects(probe(f, { signal: controller.signal }), (error) => error === reason);
  assert.deepEqual(f.source.ephemeralSubscriptionIds(), []);
  assert.equal((await f.rules.listRules()).length, 0);
  const result = await probe(f);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes('undefined'), false);
  assert.deepEqual(JSON.parse(encoded), JSON.parse(JSON.stringify(result)));
  const walk = (value: unknown): void => {
    if (value === undefined) assert.fail('undefined in receipt');
    if (typeof value === 'number') assert.equal(Number.isFinite(value), true);
    if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item);
  };
  walk(result);
});
