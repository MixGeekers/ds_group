import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { SHIYU_EVENT_TYPES, type EventPrincipal } from '../src/contracts/events.js';
import { EventDeliveryCoordinator } from '../src/control/events/index.js';
import {
  EffectLedger, HANDLER_A, HANDLER_B, OWNER_SCOPE, agentSubscriber, componentConsumer,
  componentPublisher, coordinatorFor, eventStore, goalTarget, readerPrincipal, subscriptionFor,
} from './events-fixtures.js';

async function publish(events: any, principal: EventPrincipal, type: string, payload: Record<string, unknown>, key: string,
  extra: Record<string, unknown> = {}) {
  return events.publish(principal, { type, scope: OWNER_SCOPE, payload, idempotencyKey: key, ...extra });
}
const observation = (message: string) => ({ message, sourceRef: 'file:synthetic' });

test('one-shot waiting: only the first match is delivered and consumed', async t => {
  const f = await eventStore(t);
  const ledger = new EffectLedger();
  const subscriber = agentSubscriber([HANDLER_A], ['component.observation.reported']);
  const sub = await f.events.subscribe(subscriber, subscriptionFor('once-wait', ['component.observation.reported'],
    { once: true, filter: { sourceRef: 'file:synthetic' } }));
  assert.equal(sub.once, true);
  const first = await publish(f.events, componentPublisher(), 'component.observation.reported', observation('first'), 'once-1');
  const second = await publish(f.events, componentPublisher(), 'component.observation.reported', observation('second'), 'once-2');
  assert.equal(first.deliveryCount, 1);
  assert.equal(second.deliveryCount, 0, 'a one-shot subscription must not create a second delivery');
  const batch = await coordinatorFor(f.events, [componentConsumer(HANDLER_A, ledger)], [], [HANDLER_A]).consume(10);
  assert.equal(batch.claimed, 1);
  assert.equal(batch.processed, 1);
  assert.equal(ledger.count, 1);
  assert.equal((await coordinatorFor(f.events, [componentConsumer(HANDLER_A, ledger)], [], [HANDLER_A]).consume(10)).claimed, 0);
  assert.equal(ledger.count, 1);
});

test('deadline and cancel: expired or paused subscriptions never dispatch, old claims go stale', async t => {
  const f = await eventStore(t);
  const ledger = new EffectLedger();
  const subscriber = agentSubscriber([HANDLER_A], ['component.observation.reported']);
  // 1. Expired subscription deadline: the durable delivery is cancelled before consumption.
  await f.events.subscribe(subscriber, subscriptionFor('expiring', ['component.observation.reported'],
    { expiresAt: new Date(Date.now() + 40).toISOString() }));
  await publish(f.events, componentPublisher(), 'component.observation.reported', observation('expires'), 'exp-1');
  await delay(60);
  const expired = await coordinatorFor(f.events, [componentConsumer(HANDLER_A, ledger)], [], [HANDLER_A]).consume(10);
  assert.equal(expired.claimed, 0, 'an expired subscription creates no new dispatch eligibility');
  assert.equal(ledger.count, 0);
  // 2. Pause cancels the pending delivery and increments the activation generation.
  const active = await f.events.subscribe(subscriber, subscriptionFor('pausable', ['component.observation.reported']));
  await publish(f.events, componentPublisher(), 'component.observation.reported', observation('paused'), 'pause-1');
  const paused = await f.events.update(subscriber, active.id, active.revision, { status: 'paused' });
  assert.ok(paused.activationGeneration > active.activationGeneration);
  assert.equal((await coordinatorFor(f.events, [componentConsumer(HANDLER_A, ledger)], [], [HANDLER_A]).consume(10)).claimed, 0);
  const resumed = await f.events.update(subscriber, paused.id, paused.revision, { status: 'active' });
  assert.ok(resumed.activationGeneration > paused.activationGeneration);
  await delay(5);
  assert.equal((await coordinatorFor(f.events, [componentConsumer(HANDLER_A, ledger)], [], [HANDLER_A]).consume(10)).claimed, 0,
    'the event accepted while paused must not regain dispatch eligibility after resume');
  assert.equal(ledger.count, 0);
  // 3. Unsubscribe retires the rule; a late event produces no delivery at all.
  await f.events.unsubscribe(subscriber, resumed.id, resumed.revision);
  const late = await publish(f.events, componentPublisher(), 'component.observation.reported', observation('late'), 'late-1');
  assert.equal(late.deliveryCount, 0);
  assert.equal((await coordinatorFor(f.events, [componentConsumer(HANDLER_A, ledger)], [], [HANDLER_A]).consume(10)).claimed, 0);
  assert.equal(ledger.count, 0);
});

test('an effect committed before a lost ack survives restart without a second business effect', async t => {
  const f = await eventStore(t);
  const ledger = new EffectLedger();
  const subscriber = agentSubscriber([HANDLER_A], ['component.observation.reported']);
  await f.events.subscribe(subscriber, subscriptionFor('crashy', ['component.observation.reported']));
  await publish(f.events, componentPublisher(), 'component.observation.reported', observation('once'), 'crash-1');
  // The handler commits its effect, then "crashes" before the coordinator can ack.
  const crashing: ComponentConsumerLike = { handlerRef: HANDLER_A, async consume(input) {
    const recorded = ledger.record(input.deliveryId, input.eventId);
    throw Object.assign(new Error('consumer crashed after effect'), { code: 'CONSUMER_CRASHED', effectRef: recorded.effectRef });
  } };
  const first = await coordinatorFor(f.events, [crashing], [], [HANDLER_A]).consume(10);
  assert.equal(first.deliveries[0]!.outcome, 'retrying');
  assert.equal(ledger.count, 1);
  // Process restart: a new store handle on the same durable file and a new
  // coordinator. The retried delivery keeps its stable deliveryId, so the
  // idempotent consumer recognises it and acknowledges exactly once.
  await f.store.close();
  const reopened = await f.open();
  const second = await coordinatorFor(reopened.events, [componentConsumer(HANDLER_A, ledger)], [], [HANDLER_A]).consume(10);
  assert.equal(second.claimed, 1);
  assert.equal(second.processed, 1);
  assert.equal(second.deliveries[0]!.deliveryId, first.deliveries[0]!.deliveryId);
  assert.equal(ledger.count, 1, 'at-least-once retry must not duplicate the business effect');
  assert.deepEqual(ledger.duplicates, [first.deliveries[0]!.deliveryId]);
  assert.equal((await coordinatorFor(reopened.events, [componentConsumer(HANDLER_A, ledger)], [], [HANDLER_A]).consume(10)).claimed, 0);
});
type ComponentConsumerLike = { handlerRef: string; consume(input: any): Promise<{ effectRef: string }> };

test('a lost continuation ack retries the durable delivery but never appends the native context twice', async t => {
  const f = await eventStore(t);
  const ports = goalTarget('goal:lost-ack', 'continuation');
  const subscriber = agentSubscriber(['goal:lost-ack'], ['component.observation.reported']);
  await f.events.subscribe(subscriber, subscriptionFor('lost-ack', ['component.observation.reported'],
    { target: { kind: 'agent', bindingId: 'goal:lost-ack' }, deliveryMode: 'background' }));
  await publish(f.events, componentPublisher(), 'component.observation.reported', observation('context'), 'lost-1');
  const dispatch = ports.target.dispatchContinuation!;
  let calls = 0;
  ports.target.dispatchContinuation = async input => {
    const receipt = await dispatch(input);
    if (++calls === 1) throw Object.assign(new Error('ack response lost'), { code: 'CONTEXT_ACK_LOST' });
    return receipt;
  };
  const first = await coordinatorFor(f.events, [], [ports.target], ['goal:lost-ack']).consumeAgentDeliveries(10);
  assert.equal(first.deliveries[0]!.outcome, 'retrying');
  assert.equal(first.deliveries[0]!.contextReceipt, undefined, 'no confirmed context receipt may be reported for a failed dispatch');
  assert.equal(ports.model.appended.length, 1);
  const second = await coordinatorFor(f.events, [], [ports.target], ['goal:lost-ack']).consumeAgentDeliveries(10);
  assert.equal(second.processed, 1);
  assert.equal(second.deliveries[0]!.outcome, 'acked');
  assert.equal(second.deliveries[0]!.contextReceipt?.durability, 'confirmed');
  assert.equal(ports.model.appended.length, 1, 'native dispatch is idempotent per deliveryId');
  assert.equal(ports.wakes(), 1);
  assert.equal(ports.references.count, 1);
});

test('a revocation between the continuation gate and dispatch prevents the stale dispatch', async t => {
  const f = await eventStore(t);
  const ports = goalTarget('goal:race', 'continuation');
  const subscriber = agentSubscriber(['goal:race'], ['component.observation.reported']);
  const sub = await f.events.subscribe(subscriber, subscriptionFor('race-sub', ['component.observation.reported'],
    { target: { kind: 'agent', bindingId: 'goal:race' }, deliveryMode: 'background' }));
  await publish(f.events, componentPublisher(), 'component.observation.reported', observation('racing'), 'race-1');
  // The trusted gate accepts, but the subscription is paused while it runs.
  ports.target.evaluateContinuation = async () => {
    await f.events.update(subscriber, sub.id, sub.revision, { status: 'paused' });
    return { allowed: true };
  };
  const batch = await coordinatorFor(f.events, [], [ports.target], ['goal:race']).consumeAgentDeliveries(10);
  assert.equal(batch.deliveries[0]!.outcome, 'stale');
  assert.equal(ports.dispatches, 0, 'an old activation generation cannot restore dispatch eligibility');
  assert.equal(ports.wakes(), 0);
  assert.equal(ports.model.appended.length, 0);
});

test('a paused or revoked Goal keeps only the background reference and never revives on resume', async t => {
  const f = await eventStore(t);
  const ports = goalTarget('goal:paused', 'continuation');
  const subscriber = agentSubscriber(['goal:paused'], ['component.observation.reported']);
  await f.events.subscribe(subscriber, subscriptionFor('paused-goal', ['component.observation.reported'],
    { target: { kind: 'agent', bindingId: 'goal:paused' }, deliveryMode: 'background' }));
  ports.setPaused(true);
  await publish(f.events, componentPublisher(), 'component.observation.reported', observation('while-paused'), 'paused-1');
  const paused = await coordinatorFor(f.events, [], [ports.target], ['goal:paused']).consumeAgentDeliveries(10);
  assert.equal(paused.processed, 1);
  assert.equal(paused.deliveries[0]!.outcome, 'acked');
  assert.equal(paused.deliveries[0]!.dispatched, false);
  assert.equal(paused.deliveries[0]!.continuationReason, 'PAUSED');
  assert.equal(paused.deliveries[0]!.referenceId, 'effect:1');
  assert.equal(ports.wakes(), 0, 'pause never wakes a model');
  // Resuming does not recreate eligibility for the already-consumed event.
  ports.setPaused(false);
  await delay(5);
  assert.equal((await coordinatorFor(f.events, [], [ports.target], ['goal:paused']).consumeAgentDeliveries(10)).claimed, 0);
  assert.equal(ports.wakes(), 0);
  // Only a genuinely new event after resume can continue.
  await publish(f.events, componentPublisher(), 'component.observation.reported', observation('after-resume'), 'paused-2');
  const fresh = await coordinatorFor(f.events, [], [ports.target], ['goal:paused']).consumeAgentDeliveries(10);
  assert.equal(fresh.processed, 1);
  assert.equal(fresh.deliveries[0]!.dispatched, true);
  assert.equal(ports.wakes(), 1);
  assert.equal(ports.references.count, 2);
});

test('slow and failing consumers stay isolated and cannot starve the batch or other subscriptions', async t => {
  const f = await eventStore(t);
  const ledger = new EffectLedger();
  const subscriber = agentSubscriber([HANDLER_A, HANDLER_B], ['component.observation.reported']);
  await f.events.subscribe(subscriber, subscriptionFor('slow-sub', ['component.observation.reported'],
    { filter: { sourceRef: 'file:slow' } }));
  await f.events.subscribe(subscriber, subscriptionFor('fast-sub', ['component.observation.reported'],
    { filter: { sourceRef: 'file:fast' }, target: { kind: 'component', handlerRef: HANDLER_B } }));
  await publish(f.events, componentPublisher(), 'component.observation.reported', { message: 'slow', sourceRef: 'file:slow' }, 'slow-1');
  await publish(f.events, componentPublisher(), 'component.observation.reported', { message: 'fast', sourceRef: 'file:fast' }, 'fast-1');
  let slowStarted = false;
  const slow = { handlerRef: HANDLER_A, async consume() { slowStarted = true; await delay(5000); return { effectRef: 'never' }; } };
  const fast = componentConsumer(HANDLER_B, ledger);
  const started = Date.now();
  const batch = await coordinatorFor(f.events, [slow, fast], [], [HANDLER_A, HANDLER_B], 30).consume(10);
  const elapsed = Date.now() - started;
  assert.equal(slowStarted, true);
  assert.ok(elapsed < 2000, 'the slow consumer must be bounded instead of blocking the batch');
  assert.equal(batch.failed, 1);
  assert.equal(batch.processed, 1);
  const slowOutcome = batch.deliveries.find(item => item.errorCode === 'CONSUMER_TIMEOUT');
  const fastOutcome = batch.deliveries.find(item => item.outcome === 'acked');
  assert.ok(slowOutcome && slowOutcome.outcome === 'retrying');
  assert.equal(fastOutcome?.kind, 'component');
  assert.equal(ledger.count, 1, 'the healthy consumer effect is independent of the slow one');
});

test('unregistered handlers and Agent bindings fail closed without a model wake', async t => {
  const f = await eventStore(t);
  const ledger = new EffectLedger();
  const subscriber = agentSubscriber([HANDLER_A, 'goal:unregistered'], ['component.observation.reported']);
  await f.events.subscribe(subscriber, subscriptionFor('unregistered-handler', ['component.observation.reported']));
  await publish(f.events, componentPublisher(), 'component.observation.reported', observation('no handler'), 'unreg-1');
  // The coordinator knows fewer handlers than the control-store allowlist.
  const wrong = await coordinatorFor(f.events, [componentConsumer(HANDLER_B, ledger)], [], [HANDLER_A]).consume(10);
  assert.equal(wrong.deliveries[0]!.outcome, 'retrying');
  assert.equal(wrong.deliveries[0]!.errorCode, 'UNREGISTERED_HANDLER');
  assert.equal(ledger.count, 0);
  // An Agent subscription target that has no trusted binding port is never woken.
  await f.events.subscribe(subscriber, subscriptionFor('unregistered-binding', ['component.observation.reported'],
    { target: { kind: 'agent', bindingId: 'goal:unregistered' }, deliveryMode: 'background' }));
  await publish(f.events, componentPublisher(), 'component.observation.reported', observation('no binding'), 'unreg-2');
  const agentBatch = await coordinatorFor(f.events, [], [{
    bindingId: 'goal:registered-elsewhere', mode: 'background', async updateBackground() { return { referenceId: 'unused', duplicate: false }; },
  }], ['goal:unregistered']).consumeAgentDeliveries(10);
  assert.equal(agentBatch.deliveries[0]!.errorCode, 'UNREGISTERED_AGENT_BINDING');
  assert.equal(agentBatch.deliveries[0]!.kind, 'background');
});

test('forged authority, cross-scope access and program-owned events are rejected before delivery', async t => {
  const f = await eventStore(t);
  // Reserved business facts stay with TaskService and the trusted component path.
  await assert.rejects(publish(f.events, componentPublisher(), 'task.succeeded', { taskId: 'task-1' }, 'forged-1'), /FORBIDDEN|cannot publish/);
  const foreignComponent: EventPrincipal = { principalId: 'untrusted-component', kind: 'component', scopes: [OWNER_SCOPE],
    publishTypes: ['task.succeeded'], subscribeTypes: [], targetRefs: [] };
  await assert.rejects(publish(f.events, foreignComponent, 'task.succeeded', { taskId: 'task-1' }, 'forged-2'),
    /FORBIDDEN|cannot publish/, 'even a principal that lists the type cannot publish a program-owned fact as another identity');
  await assert.rejects(publish(f.events, componentPublisher(), 'component.observation.reported', observation('cross'), 'cross-1', { scope: 'private' }),
    /FORBIDDEN|not granted/);
  const subscriber = agentSubscriber([HANDLER_A], ['component.observation.reported']);
  await assert.rejects(f.events.subscribe(subscriber, subscriptionFor('cross-sub', ['component.observation.reported'], { scope: 'private' })), /FORBIDDEN|not granted/);
  // Only the trusted task-service identity may accept the reserved completion fact.
  const taskService: EventPrincipal = { principalId: 'task-service', kind: 'component', scopes: [OWNER_SCOPE],
    publishTypes: ['task.succeeded'], subscribeTypes: [], targetRefs: [] };
  const accepted = await publish(f.events, taskService, 'task.succeeded', { taskId: 'task-1' }, 'accepted-1');
  assert.equal(accepted.status, 'accepted');
  const events = await f.events.listEvents(readerPrincipal());
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actor.principalId, 'task-service');
});

test('delivery establishment watermark and bounded replay never invent or lose a completion event', async t => {
  const f = await eventStore(t);
  const ledger = new EffectLedger();
  const subscriber = agentSubscriber([HANDLER_A], ['component.observation.reported']);
  await publish(f.events, componentPublisher(), 'component.observation.reported', observation('before'), 'wm-1');
  // from_now must not backfill an event accepted before the subscription watermark.
  const fresh = await f.events.subscribe(subscriber, subscriptionFor('from-now', ['component.observation.reported']));
  assert.equal(fresh.startSequence, 1);
  assert.equal(fresh.replayedCount, 0);
  // A bounded replay explicitly selects previously accepted events.
  const replay = await f.events.subscribe(subscriber, subscriptionFor('bounded-replay', ['component.observation.reported'],
    { start: { kind: 'replay', afterSequence: 0, limit: 10 } }));
  assert.equal(replay.replayedCount, 1);
  assert.equal(replay.replayTruncated, false);
  // An event accepted after the watermark is matched exactly once per subscription.
  await publish(f.events, componentPublisher(), 'component.observation.reported', observation('after'), 'wm-2');
  const batch = await coordinatorFor(f.events, [componentConsumer(HANDLER_A, ledger)], [], [HANDLER_A]).consume(10);
  assert.equal(batch.claimed, 3, 'from_now and bounded replay are independent deliveries plus the post-watermark event');
  assert.equal(batch.processed, 3);
  assert.equal(ledger.count, 3);
  const subscriptions = await f.events.listSubscriptions(subscriber);
  assert.equal(subscriptions.every(sub => sub.status === 'active'), true);
  await f.events.unsubscribe(subscriber, fresh.id, fresh.revision);
  // A replay-truncated subscription is explicit, never silently claimed complete.
  for (const key of ['t-1', 't-2', 't-3']) await publish(f.events, componentPublisher(), 'component.observation.reported', observation(key), key);
  const truncated = await f.events.subscribe(subscriber, subscriptionFor('truncated', ['component.observation.reported'],
    { start: { kind: 'replay', afterSequence: 0, limit: 1 } }));
  assert.equal(truncated.replayTruncated, true);
  assert.equal(truncated.replayedCount, 1);
});

test('two coordinators on separate store handles serialize claims: one winner per delivery', async t => {
  const f = await eventStore(t);
  const ledger = new EffectLedger();
  const subscriber = agentSubscriber([HANDLER_A], ['component.observation.reported']);
  await f.events.subscribe(subscriber, subscriptionFor('two-workers', ['component.observation.reported']));
  await publish(f.events, componentPublisher(), 'component.observation.reported', observation('one'), 'two-1');
  const second = await f.open();
  const left = coordinatorFor(f.events, [componentConsumer(HANDLER_A, ledger)], [], [HANDLER_A]);
  const right = coordinatorFor(second.events, [componentConsumer(HANDLER_A, ledger)], [], [HANDLER_A]);
  const [a, b] = await Promise.all([left.consume(10), right.consume(10)]);
  assert.equal(a.claimed + b.claimed, 1);
  assert.equal(a.processed + b.processed, 1);
  assert.equal(ledger.count, 1);
});

test('out-of-order and duplicate attempts keep the business key stable per subscription revision and event', async t => {
  const f = await eventStore(t);
  const subscriber = agentSubscriber([HANDLER_A], ['component.observation.reported']);
  const sub = await f.events.subscribe(subscriber, subscriptionFor('ordered', ['component.observation.reported']));
  const first = await publish(f.events, componentPublisher(), 'component.observation.reported', observation('first'), 'ord-1');
  const second = await publish(f.events, componentPublisher(), 'component.observation.reported', observation('second'), 'ord-2');
  assert.ok(second.sequence > first.sequence);
  const deliveries = await f.events.listDeliveries(readerPrincipal([OWNER_SCOPE], [HANDLER_A]), { subscriptionId: sub.id, limit: 100 });
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries.map(item => item.ruleRevision), [sub.ruleRevision, sub.ruleRevision]);
  assert.deepEqual(deliveries.map(item => item.activationGeneration), [sub.activationGeneration, sub.activationGeneration]);
  // Delivery identity is subscriptionId + ruleRevision + eventId, so a rule
  // change creates new eligibility but never duplicates the same accepted event.
  const updated = await f.events.update(subscriber, sub.id, sub.revision, { filter: { sourceRef: 'file:other' } });
  assert.ok(updated.ruleRevision > sub.ruleRevision);
  const late = await publish(f.events, componentPublisher(), 'component.observation.reported', observation('late'), 'ord-3');
  assert.equal(late.deliveryCount, 0, 'the changed filter no longer matches the source');
  const beforeUpdate = await f.events.listDeliveries(readerPrincipal([OWNER_SCOPE], [HANDLER_A]), { subscriptionId: sub.id, limit: 100 });
  assert.equal(beforeUpdate.filter(item => item.ruleRevision === sub.ruleRevision).length, 2);
});

test('a revoked coordinator grant cannot claim, acknowledge or consume pending deliveries', async t => {
  const f = await eventStore(t);
  const ledger = new EffectLedger();
  const subscriber = agentSubscriber([HANDLER_A], ['component.observation.reported']);
  await f.events.subscribe(subscriber, subscriptionFor('revoked-coordinator', ['component.observation.reported']));
  await publish(f.events, componentPublisher(), 'component.observation.reported', observation('revoked'), 'rev-1');
  const revoked = new EventDeliveryCoordinator({ events: f.events,
    principal: { principalId: 'shiyu-runtime-coordinator', kind: 'component', scopes: [], publishTypes: [], subscribeTypes: [], targetRefs: [] },
    handlers: [componentConsumer(HANDLER_A, ledger)], handlerTimeoutMs: 1000, retryDelayMs: 0 });
  const batch = await revoked.consume(10);
  assert.equal(batch.claimed, 0);
  assert.equal(ledger.count, 0);
  // The still-authorized coordinator can consume the untouched durable delivery.
  const allowed = await coordinatorFor(f.events, [componentConsumer(HANDLER_A, ledger)], [], [HANDLER_A]).consume(10);
  assert.equal(allowed.processed, 1);
  assert.equal(ledger.count, 1);
});

test('bad input and unregistered subscription targets are rejected by the durable store', async t => {
  const f = await eventStore(t);
  const subscriber = agentSubscriber([HANDLER_B], ['component.observation.reported']);
  await assert.rejects(f.events.subscribe(subscriber, subscriptionFor('bad-handler', ['component.observation.reported'],
    { target: { kind: 'component', handlerRef: 'arbitrary.callback' } })), /FORBIDDEN|not registered/);
  await assert.rejects(f.events.subscribe(subscriber, subscriptionFor('bad-binding', ['component.observation.reported'],
    { target: { kind: 'agent', bindingId: 'goal:other' }, deliveryMode: 'background' })), /FORBIDDEN|not granted/);
  await assert.rejects(f.events.subscribe(subscriber, subscriptionFor('bad-mode', ['component.observation.reported'],
    { target: { kind: 'agent', bindingId: HANDLER_B }, deliveryMode: 'component' })), /FORBIDDEN|UNSUPPORTED|not implemented/);
  const coordinator = new EventDeliveryCoordinator({ events: f.events, principal: coordinatorPrincipal([]),
    handlers: [componentConsumer(HANDLER_A, new EffectLedger())], handlerTimeoutMs: 1000 });
  await assert.rejects(coordinator.consume(0), /limit/);
  await assert.rejects(coordinator.consume(21), /limit/);
});
function coordinatorPrincipal(targetRefs: string[]): EventPrincipal {
  return { principalId: 'shiyu-runtime-coordinator', kind: 'component', scopes: [OWNER_SCOPE], publishTypes: [],
    subscribeTypes: SHIYU_EVENT_TYPES.map(type => type.type), targetRefs };
}

test('a live runtime can register and retire an Agent binding; retired deliveries never dispatch', async t => {
  const f = await eventStore(t);
  const first = goalTarget('goal:first', 'continuation');
  const dynamic = goalTarget('goal:dynamic', 'continuation');
  const subscriber = agentSubscriber(['goal:first', 'goal:dynamic'], ['component.observation.reported']);
  await f.events.subscribe(subscriber, subscriptionFor('first-sub', ['component.observation.reported'],
    { target: { kind: 'agent', bindingId: 'goal:first' }, deliveryMode: 'background', filter: { sourceRef: 'file:first' } }));
  await f.events.subscribe(subscriber, subscriptionFor('dynamic-sub', ['component.observation.reported'],
    { target: { kind: 'agent', bindingId: 'goal:dynamic' }, deliveryMode: 'background', filter: { sourceRef: 'file:dyn' } }));
  const delivery = coordinatorFor(f.events, [], [first.target], ['goal:first']);
  await publish(f.events, componentPublisher(), 'component.observation.reported', { message: 'first', sourceRef: 'file:first' }, 'reg-1');
  const registered = await delivery.consumeAgentDeliveries(10);
  assert.equal(registered.claimed, 1);
  assert.equal(registered.deliveries[0]!.dispatched, true);
  assert.equal(first.wakes(), 1);
  // Live registration makes the new Goal binding claimable; before that its
  // pending delivery stays durable but invisible to this coordinator.
  await publish(f.events, componentPublisher(), 'component.observation.reported', { message: 'dynamic', sourceRef: 'file:dyn' }, 'reg-2');
  assert.equal((await delivery.consumeAgentDeliveries(10)).claimed, 0, 'an unregistered binding cannot be consumed or woken');
  delivery.registerAgentTarget(dynamic.target);
  assert.deepEqual(delivery.agentBindingIds(), ['goal:dynamic', 'goal:first']);
  assert.throws(() => delivery.registerAgentTarget(dynamic.target), /duplicate|retired/);
  const fresh = await delivery.consumeAgentDeliveries(10);
  assert.equal(fresh.claimed, 1, 'the pending delivery of the newly registered binding becomes claimable');
  assert.equal(fresh.deliveries[0]!.dispatched, true);
  assert.equal(dynamic.wakes(), 1);
  // Retirement removes dispatch eligibility; the pending delivery is failed
  // without a wake, and the retired binding cannot be registered again.
  await publish(f.events, componentPublisher(), 'component.observation.reported', { message: 'retired', sourceRef: 'file:dyn' }, 'reg-3');
  delivery.retireAgentTarget('goal:dynamic');
  const retired = await delivery.consumeAgentDeliveries(10);
  assert.equal(retired.claimed, 1, 'accepted deliveries stay auditable after retirement');
  assert.equal(retired.deliveries[0]!.outcome, 'retrying');
  assert.equal(retired.deliveries[0]!.errorCode, 'AGENT_BINDING_RETIRED');
  assert.equal(dynamic.wakes(), 1, 'a retired binding never wakes again');
  assert.throws(() => delivery.registerAgentTarget(dynamic.target), /retired/);
  assert.throws(() => delivery.retireAgentTarget('goal:never'), /Unknown/);
});

test('an idle coordinator with no registered consumers claims nothing and cannot be bypassed', async t => {
  const f = await eventStore(t);
  const subscriber = agentSubscriber([HANDLER_A], ['component.observation.reported']);
  await f.events.subscribe(subscriber, subscriptionFor('idle-sub', ['component.observation.reported']));
  await publish(f.events, componentPublisher(), 'component.observation.reported', observation('idle'), 'idle-1');
  const idle = new EventDeliveryCoordinator({ events: f.events, principal: coordinatorPrincipal([]), consumerId: 'shiyu-runtime-delivery' });
  const empty = await idle.consume(10);
  assert.deepEqual(empty, { claimed: 0, processed: 0, failed: 0, deliveries: [] });
  assert.deepEqual(await idle.scan(10), { claimed: 0, processed: 0, failed: 0 });
  // The delivery is still durable and untouched for a later registered consumer.
  const allowed = await coordinatorFor(f.events, [componentConsumer(HANDLER_A, new EffectLedger())], [], [HANDLER_A]).consume(10);
  assert.equal(allowed.processed, 1);
});
