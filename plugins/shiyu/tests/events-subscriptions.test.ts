import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { EventRuleStore, evaluateCondition, validateDeclarativeCondition } from '../src/control/events/rules.js';
import { OnceWaitService, SubscriptionLifecycleService, withDeclarativeCondition } from '../src/control/events/subscriptions.js';
import { SHIYU_EVENT_TYPES, type EventPrincipal } from '../src/contracts/events.js';
import { EventDeliveryCoordinator } from '../src/control/events/index.js';
import { eventStore, goalTarget, coordinatorPrincipal } from './events-fixtures.js';

const OWNER = 'local-owner';
const actor: EventPrincipal = { principalId: 'core-agent:h2b', kind: 'agent', scopes: [OWNER], publishTypes: ['agent.observation.reported'],
  subscribeTypes: SHIYU_EVENT_TYPES.map(type => type.type), targetRefs: ['goal:h2b'] };
const publisher: EventPrincipal = { principalId: 'trusted-component:h2b', kind: 'component', scopes: [OWNER],
  publishTypes: ['component.observation.reported'], subscribeTypes: [], targetRefs: [] };
const observer: EventPrincipal = { principalId: 'test-reader', kind: 'component', scopes: [OWNER], publishTypes: [],
  subscribeTypes: SHIYU_EVENT_TYPES.map(type => type.type), targetRefs: ['goal:h2b', 'component-handler:h2b'] };
const publish = (events: any, key: string, sourceRef = 'file:a', message = 'synthetic') =>
  events.publish(publisher, { type: 'component.observation.reported', scope: OWNER, payload: { message, sourceRef }, idempotencyKey: key });

async function fixture(t: import('node:test').TestContext) {
  const f = await eventStore(t, []);
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-h2b-rules-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let nowMs = Date.now();
  const rules = new EventRuleStore({ filename: join(directory, 'rules.json'), now: () => nowMs });
  const lifecycle = new SubscriptionLifecycleService({ events: f.events, rules, now: () => nowMs });
  const wait = new OnceWaitService({ events: f.events, lifecycle, rules, now: () => nowMs });
  return { ...f, directory, rules, lifecycle, wait, now: () => nowMs, advance: (ms: number) => { nowMs += ms; } };
}
const agentSubscription = (id: string, patch: Record<string, unknown> = {}) => ({
  id, types: ['component.observation.reported'], scope: OWNER, target: { kind: 'agent' as const, bindingId: 'goal:h2b' },
  deliveryMode: 'background' as const, start: { kind: 'from_now' as const }, filter: { sourceRef: 'file:a' }, ...patch });

test('subscription lifecycle keeps revisions/activation generations and closes eligibility on unsubscribe', async t => {
  const f = await fixture(t);
  const created = await f.lifecycle.subscribe(actor, agentSubscription('h2b-life', {
    condition: { schemaVersion: 1, predicates: [{ field: 'sourceRef', op: 'eq', value: 'file:a' }] },
    notification: { category: 'result', destinations: [{ kind: 'channel', ref: 'room:a', allowedFields: ['sourceRef'] }] },
  }));
  assert.equal(created.conditionRevision, 1);
  assert.equal(created.revision, 1);
  assert.equal(created.status, 'active');
  assert.equal(created.condition?.predicates[0]!.field, 'sourceRef');
  const listed = await f.lifecycle.list(actor);
  assert.equal(listed.length, 1); assert.equal(listed[0]!.notification?.category, 'result');
  await assert.rejects(f.lifecycle.update(actor, 'h2b-life', 99, { status: 'paused' }), /REVISION_CONFLICT/);
  const paused = await f.lifecycle.pause(actor, 'h2b-life', created.revision);
  assert.equal(paused.status, 'paused');
  assert.ok(paused.activationGeneration > created.activationGeneration);
  const resumed = await f.lifecycle.resume(actor, 'h2b-life', paused.revision);
  assert.equal(resumed.status, 'active');
  assert.ok(resumed.activationGeneration > paused.activationGeneration);
  assert.equal(resumed.ruleRevision, created.ruleRevision, 'pause/resume does not invent a new rule revision');
  const status = await f.lifecycle.status(actor, 'h2b-life');
  assert.deepEqual(status.gaps, []);
  assert.equal(status.counts.subscriptions, 1);
  const retired = await f.lifecycle.unsubscribe(actor, 'h2b-life', resumed.revision);
  assert.equal(retired.status, 'retired');
  assert.ok(retired.retiredAt);
  const receipt = await publish(f.events, 'after-retire');
  assert.equal(receipt.deliveryCount, 0, 'unsubscribe closes new dispatch eligibility immediately');
  assert.equal((await f.events.claim(observer, { consumerId: 'late', deliveryMode: 'background' })).length, 0);
});

test('changing a declarative condition fences the old activation generation and old pending deliveries', async t => {
  const f = await fixture(t);
  const created = await f.lifecycle.subscribe(actor, {
    id: 'h2b-condition-fence', types: ['component.observation.reported'], scope: OWNER, target: { kind: 'agent', bindingId: 'goal:h2b' },
    deliveryMode: 'background', start: { kind: 'from_now' },
    condition: { schemaVersion: 1, predicates: [{ field: 'sourceRef', op: 'eq', value: 'file:a' }] },
  });
  await publish(f.events, 'before-change', 'file:a');
  assert.equal((await f.events.listDeliveries(observer, { subscriptionId: 'h2b-condition-fence' })).length, 1);
  const updated = await f.lifecycle.update(actor, 'h2b-condition-fence', created.revision, {
    condition: { schemaVersion: 1, predicates: [{ field: 'sourceRef', op: 'eq', value: 'file:b' }] },
  });
  assert.equal(updated.condition?.predicates[0]!.value, 'file:b');
  assert.equal(updated.conditionRevision, 2);
  assert.ok(updated.activationGeneration > created.activationGeneration, 'condition-only change closes the old activation');
  assert.equal((await f.events.listDeliveries(observer, { subscriptionId: 'h2b-condition-fence' }))[0]!.status, 'cancelled');
  assert.equal((await f.events.claim(observer, { consumerId: 'stale', deliveryMode: 'background' })).length, 0,
    'a delivery created under the old condition cannot be dispatched after the fence');
  const fresh = await publish(f.events, 'after-change', 'file:b');
  assert.equal(fresh.deliveryCount, 1);
  const [claimed] = await f.events.claim(observer, { consumerId: 'fresh', deliveryMode: 'background' });
  assert.ok(claimed);
  assert.equal((await f.lifecycle.evaluateDelivery(actor, 'h2b-condition-fence', claimed!.event)).matched, true);
  await f.events.ack(observer, claimed!);
});

test('pause/resume does not turn the same event into a second match', async t => {
  const f = await fixture(t);
  const created = await f.lifecycle.subscribe(actor, agentSubscription('h2b-dedupe'));
  const first = await publish(f.events, 'once-only', 'file:a');
  assert.equal(first.deliveryCount, 1);
  const paused = await f.lifecycle.pause(actor, 'h2b-dedupe', created.revision);
  const resumed = await f.lifecycle.resume(actor, 'h2b-dedupe', paused.revision);
  const duplicate = await publish(f.events, 'once-only', 'file:a');
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.eventId, first.eventId);
  assert.equal((await f.events.listDeliveries(observer, { subscriptionId: 'h2b-dedupe' })).length, 1);
  assert.equal((await f.events.claim(observer, { consumerId: 'after-resume', deliveryMode: 'background' })).length, 0);
  // A genuinely new event matches exactly once under the current activation.
  assert.equal((await publish(f.events, 'second-event', 'file:a')).deliveryCount, 1);
  assert.equal(resumed.activationGeneration > paused.activationGeneration, true);
});

test('declarative conditions are white-listed, bounded and deterministic with durable changed-state', async t => {
  const f = await fixture(t);
  const types = await f.events.types(observer);
  const definition = types.filter(type => type.type === 'component.observation.reported');
  for (const bad of [
    { schemaVersion: 1, predicates: [{ field: 'sourceRef', op: 'regex', value: '.*' }] },
    { schemaVersion: 1, predicates: [{ field: 'callback', op: 'eq', value: 'x(' }] },
    { schemaVersion: 1, predicates: [{ field: 'sourceRef', op: 'eq', value: { nested: true } }] },
    { schemaVersion: 1, predicates: [{ field: 'sourceRef', op: 'gt', value: 'text' }] },
    { schemaVersion: 1, predicates: Array.from({ length: 9 }, () => ({ field: 'sourceRef', op: 'exists' })) },
    { schemaVersion: 1, predicates: [{ field: 'unregistered', op: 'exists' }] },
    { schemaVersion: 1, predicates: [{ field: 'sourceRef', op: 'exists' }], extra: true },
  ]) assert.throws(() => validateDeclarativeCondition(bad, definition), /RULE_/);
  const condition = validateDeclarativeCondition({ schemaVersion: 1, predicates: [{ field: 'sourceRef', op: 'in', value: ['file:a', 'file:b'] }] }, definition);
  assert.equal(evaluateCondition(condition, { sourceRef: 'file:b' }), true);
  assert.equal(evaluateCondition(condition, { sourceRef: 'file:c' }), false);
  assert.equal(evaluateCondition({ schemaVersion: 1, predicates: [{ field: 'sourceRef', op: 'exists' }] }, {}), false);
  // `changed` uses the durable per-subscription observation state.
  const created = await f.lifecycle.subscribe(actor, agentSubscription('h2b-changed', {
    condition: { schemaVersion: 1, predicates: [{ field: 'sourceRef', op: 'changed' }] },
  }));
  const first = await publish(f.events, 'changed-a', 'file:a');
  const firstEvent = (await f.events.listEvents(observer, { limit: 10 })).find(event => event.eventId === first.eventId)!;
  assert.equal((await f.lifecycle.evaluateDelivery(actor, 'h2b-changed', firstEvent)).matched, true);
  const second = await publish(f.events, 'changed-b', 'file:a');
  const secondEvent = (await f.events.listEvents(observer, { limit: 10 })).find(event => event.eventId === second.eventId)!;
  assert.equal((await f.lifecycle.evaluateDelivery(actor, 'h2b-changed', secondEvent)).matched, false, 'same value is not changed');
  const third = await publish(f.events, 'changed-c', 'file:b');
  const thirdEvent = (await f.events.listEvents(observer, { limit: 10 })).find(event => event.eventId === third.eventId)!;
  assert.equal((await f.lifecycle.evaluateDelivery(actor, 'h2b-changed', thirdEvent)).matched, true);
  assert.equal(created.condition?.predicates[0]!.op, 'changed');
});

test('declarative condition gates continuation without waking or authorizing side effects', async t => {
  const f = await eventStore(t, []);
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-h2b-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rules = new EventRuleStore({ filename: join(directory, 'rules.json') });
  const lifecycle = new SubscriptionLifecycleService({ events: f.events, rules });
  const target = goalTarget('goal:h2b', 'continuation');
  const gated = withDeclarativeCondition(target.target, lifecycle, actor);
  await lifecycle.subscribe(actor, {
    id: 'h2b-gated', types: ['component.observation.reported'], scope: OWNER, target: { kind: 'agent', bindingId: 'goal:h2b' },
    deliveryMode: 'background', start: { kind: 'from_now' },
    condition: { schemaVersion: 1, predicates: [{ field: 'sourceRef', op: 'eq', value: 'file:match' }] },
  });
  const coordinator = new EventDeliveryCoordinator({ events: f.events, principal: coordinatorPrincipal(['goal:h2b']),
    handlers: [], agentTargets: [gated as any], handlerTimeoutMs: 1000, retryDelayMs: 0 });
  await f.events.publish(publisher, { type: 'component.observation.reported', scope: OWNER, payload: { message: 'not matching', sourceRef: 'file:other' }, idempotencyKey: 'gate-a' });
  const denied = await coordinator.consumeAgentDeliveries(10);
  assert.equal(denied.processed, 1);
  assert.equal(denied.deliveries[0]!.dispatched, false);
  assert.equal(denied.deliveries[0]!.continuationReason, 'CONDITION_NOT_MATCHED');
  assert.equal(target.wakes(), 0, 'a condition miss never wakes a model');
  assert.equal(target.dispatches, 0);
  await f.events.publish(publisher, { type: 'component.observation.reported', scope: OWNER, payload: { message: 'matching', sourceRef: 'file:match' }, idempotencyKey: 'gate-b' });
  const allowed = await coordinator.consumeAgentDeliveries(10);
  assert.equal(allowed.deliveries[0]!.dispatched, true);
  assert.equal(target.wakes(), 1, 'only a matched condition may continue');
});

test('once wait stays zero-model, revalidates current qualification and never revives an expired/cancelled wait', async t => {
  const f = await fixture(t);
  const consumer: EventPrincipal = { principalId: 'shiyu-once-wait', kind: 'component', scopes: [OWNER], publishTypes: [],
    subscribeTypes: ['component.observation.reported'], targetRefs: ['goal:h2b'] };
  const deadline = new Date(Date.now() + 60000).toISOString();
  const started = await f.wait.start(actor, agentSubscription('h2b-wait-a', { once: true, expiresAt: deadline,
    onceWait: { targetBindingId: 'goal:h2b', expiresAt: deadline, assignmentId: 'assignment-1', goalId: 'goal-1', once: true } }));
  assert.equal(started.once, true);
  assert.equal(started.onceWait?.targetBindingId, 'goal:h2b');
  const gateCalls: string[] = [];
  let allow = false;
  const gate = async () => { gateCalls.push('gate'); return allow ? { allowed: true } : { allowed: false, reason: 'QUALIFICATION_REVOKED' }; };
  const quiet = await f.wait.consume(actor, consumer, gate);
  assert.equal(quiet.claimed, 0); assert.equal(gateCalls.length, 0, 'no event = no model and no gate wake');
  await publish(f.events, 'wait-event-1', 'file:a');
  const denied = await f.wait.consume(actor, consumer, gate);
  assert.equal(denied.claimed, 1);
  assert.equal(denied.matched, 0);
  assert.equal(denied.backgroundOnly, 1);
  assert.equal(denied.outcomes[0]!.reason, 'QUALIFICATION_REVOKED');
  assert.equal((await f.wait.status(actor, 'h2b-wait-a')).outcome?.state, 'background_only');
  // New wait: qualification allowed -> matched; the once delivery is consumed once.
  const deadline2 = new Date(Date.now() + 60000).toISOString();
  await f.wait.start(actor, agentSubscription('h2b-wait-b', { once: true, expiresAt: deadline2,
    onceWait: { targetBindingId: 'goal:h2b', expiresAt: deadline2, once: true } }));
  allow = true;
  await publish(f.events, 'wait-event-2', 'file:a');
  const matched = await f.wait.consume(actor, consumer, gate);
  assert.equal(matched.matched, 1);
  assert.equal((await f.wait.status(actor, 'h2b-wait-b')).outcome?.state, 'matched');
  assert.equal((await f.wait.consume(actor, consumer, gate)).claimed, 0, 'once waiting never produces a second match');
  // Cancel closes dispatch eligibility.
  const view = (await f.lifecycle.list(actor)).find(item => item.id === 'h2b-wait-b')!;
  await f.wait.cancel(actor, 'h2b-wait-b', view.revision);
  assert.equal((await publish(f.events, 'wait-event-3', 'file:a')).deliveryCount, 0);
  // Expiry: a wait whose deadline passed claims nothing and never wakes a gate.
  const expiring = new Date(Date.now() + 30).toISOString();
  await f.wait.start(actor, agentSubscription('h2b-wait-expired', { once: true, expiresAt: expiring,
    onceWait: { targetBindingId: 'goal:h2b', expiresAt: expiring, once: true } }));
  await publish(f.events, 'wait-event-expired', 'file:a');
  await delay(60);
  const before = gateCalls.length;
  const expiredBatch = await f.wait.consume(actor, consumer, gate);
  assert.equal(expiredBatch.claimed, 0);
  assert.equal(gateCalls.length, before, 'an expired wait never calls its qualification gate');
});
