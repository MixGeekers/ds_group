import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventRuleStore } from '../src/control/events/rules.js';
import { SubscriptionLifecycleService } from '../src/control/events/subscriptions.js';
import { NotificationRouter, type NotificationEffectPort, type NotificationView } from '../src/control/events/notifications.js';
import { SHIYU_EVENT_TYPES, type EventPrincipal, type StoredEvent } from '../src/contracts/events.js';
import { eventStore, readerPrincipal } from './events-fixtures.js';

const OWNER = 'local-owner';
const actor: EventPrincipal = { principalId: 'core-agent:notify', kind: 'agent', scopes: [OWNER], publishTypes: ['agent.observation.reported'],
  subscribeTypes: SHIYU_EVENT_TYPES.map(type => type.type), targetRefs: ['h2b.handler'] };
const publisher: EventPrincipal = { principalId: 'trusted-component:notify', kind: 'component', scopes: [OWNER],
  publishTypes: ['component.observation.reported'], subscribeTypes: [], targetRefs: [] };
class EffectDouble implements NotificationEffectPort {
  readonly sends: { intentRef: string; destination: unknown; view: NotificationView }[] = [];
  readonly queries: string[] = [];
  private readonly receipts = new Map<string, { status: 'delivered' | 'unknown' | 'failed'; receiptRef?: string; reason?: string }>();
  constructor(private readonly behavior?: (intentRef: string, view: NotificationView) => { status: 'delivered' | 'unknown' | 'failed'; receiptRef?: string; reason?: string }) {}
  async send(input: { intentRef: string; destination: unknown; view: NotificationView }) {
    this.sends.push(structuredClone(input));
    const receipt = this.behavior?.(input.intentRef, input.view) ?? { status: 'delivered' as const, receiptRef: `receipt:${this.sends.length}` };
    this.receipts.set(input.intentRef, receipt); return receipt;
  }
  async query(intentRef: string) { this.queries.push(intentRef); return this.receipts.get(intentRef); }
  setReceipt(intentRef: string, receipt: { status: 'delivered' | 'unknown' | 'failed'; receiptRef?: string }) { this.receipts.set(intentRef, receipt); }
}
async function fixture(t: import('node:test').TestContext, behavior?: ConstructorParameters<typeof EffectDouble>[0]) {
  const f = await eventStore(t, ['h2b.handler']);
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-h2b-notify-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rules = new EventRuleStore({ filename: join(directory, 'rules.json') });
  const lifecycle = new SubscriptionLifecycleService({ events: f.events, rules });
  const effect = new EffectDouble(behavior);
  const router = (options: Record<string, unknown> = {}) => new NotificationRouter({ events: f.events, rules, effect, ...options });
  return { ...f, directory, rules, lifecycle, effect, router };
}
let key = 0;
async function publishResult(f: Awaited<ReturnType<typeof fixture>>, options: { key?: string; sourceRef?: string } = {}) {
  const idempotencyKey = options.key ?? `notify-${++key}`;
  await f.events.publish(publisher, { type: 'component.observation.reported', scope: OWNER,
    payload: { message: `result ${idempotencyKey}`, sourceRef: options.sourceRef ?? 'file:a' }, idempotencyKey });
  const events = await f.events.listEvents(readerPrincipal());
  return events.find(event => event.payload.message === `result ${idempotencyKey}`)!;
}
const subscription = (id: string, notification: Record<string, unknown>) => ({
  id, types: ['component.observation.reported'], scope: OWNER, target: { kind: 'component' as const, handlerRef: 'h2b.handler' },
  deliveryMode: 'component' as const, start: { kind: 'from_now' as const }, notification,
} as any);
function intentRefs(receipt: any): string[] { return receipt.items.map((item: any) => item.intentRef).filter(Boolean); }

test('notification destinations get distinct restricted views and never broadcast to unregistered associations', async t => {
  const f = await fixture(t);
  await f.lifecycle.subscribe(actor, subscription('h2b-notify-views', {
    category: 'result', destinations: [
      { kind: 'channel', ref: 'room:a', allowedFields: ['sourceRef'] },
      { kind: 'agent', ref: 'goal:owner', allowedFields: ['message'] },
    ],
  }));
  const event = await publishResult(f);
  const receipt = await f.router().route(actor, { event, subscriptionId: 'h2b-notify-views' });
  assert.equal(receipt.status, 'routed');
  assert.equal(receipt.destinations, 2);
  assert.equal(receipt.delivered, 2);
  assert.equal(f.effect.sends.length, 2);
  const first = f.effect.sends[0]!.view;
  const second = f.effect.sends[1]!.view;
  assert.deepEqual(first.payload, { sourceRef: 'file:a' });
  assert.deepEqual(second.payload, { message: 'result notify-1' });
  assert.notEqual(first.digest, second.digest);
  assert.equal(JSON.stringify(first).includes('result notify-1'), false, 'unallowed payload fields never leave the router');
  assert.equal(intentRefs(receipt).length, 2);
  // An associated-but-unregistered destination is never inferred.
  assert.equal(f.effect.sends.some(send => (send.view.destination.ref as string) === 'room:b'), false);
  const none = await f.router().route(actor, { event });
  assert.equal(none.status, 'no_destination');
  assert.equal(f.effect.sends.length, 2);
});

test('notification intent dedupe survives restart and never resends an already delivered result', async t => {
  const f = await fixture(t);
  await f.lifecycle.subscribe(actor, subscription('h2b-notify-dedupe', {
    category: 'result', destinations: [{ kind: 'channel', ref: 'room:a', allowedFields: ['message'] }],
  }));
  const event = await publishResult(f, { key: 'dedupe-result' });
  assert.equal((await f.router().route(actor, { event, subscriptionId: 'h2b-notify-dedupe' })).delivered, 1);
  assert.equal(f.effect.sends.length, 1);
  const again = await f.router().route(actor, { event, subscriptionId: 'h2b-notify-dedupe' });
  assert.equal(again.skipped, 1);
  assert.equal(again.items[0]!.reason, 'INTENT_ALREADY_SETTLED');
  assert.equal(f.effect.sends.length, 1);
  // A restarted router using the same durable rule store still dedupes.
  const restarted = f.router();
  const afterRestart = await restarted.route(actor, { event, subscriptionId: 'h2b-notify-dedupe' });
  assert.equal(afterRestart.skipped, 1);
  assert.equal(f.effect.sends.length, 1, 'reconnect/restart does not clear the delivered intent record');
});

test('an unknown send is not retried; only a read-only receipt query converges it', async t => {
  const f = await fixture(t, () => ({ status: 'unknown', reason: 'transport lost after send' }));
  await f.lifecycle.subscribe(actor, subscription('h2b-notify-unknown', {
    category: 'result', destinations: [{ kind: 'channel', ref: 'room:a', allowedFields: ['message'] }],
  }));
  const event = await publishResult(f);
  const first = await f.router().route(actor, { event, subscriptionId: 'h2b-notify-unknown' });
  assert.equal(first.unknown, 1);
  assert.equal(f.effect.sends.length, 1);
  const second = await f.router().route(actor, { event, subscriptionId: 'h2b-notify-unknown' });
  assert.equal(second.items[0]!.reason, 'UNKNOWN_NOT_RETRIED');
  assert.equal(f.effect.sends.length, 1, 'unknown is never blindly resent');
  const intentRef = intentRefs(first)[0]!;
  f.effect.setReceipt(intentRef, { status: 'delivered', receiptRef: 'remote:receipt-1' });
  const reconciled = await f.router().reconcile(intentRef);
  assert.equal(reconciled.changed, true);
  assert.equal(reconciled.intent.state, 'delivered');
  assert.equal(reconciled.intent.receiptRef, 'remote:receipt-1');
  assert.equal(f.effect.sends.length, 1, 'receipt reconciliation performs no new send');
  assert.equal(f.effect.queries.length, 1);
});

test('failed sends stay failed without an automatic retry; explicit read-only query can only converge evidence', async t => {
  const f = await fixture(t, () => ({ status: 'failed', reason: 'destination rejected' }));
  await f.lifecycle.subscribe(actor, subscription('h2b-notify-failed', {
    category: 'result', destinations: [{ kind: 'channel', ref: 'room:a', allowedFields: ['message'] }],
  }));
  const event = await publishResult(f);
  const receipt = await f.router().route(actor, { event, subscriptionId: 'h2b-notify-failed' });
  assert.equal(receipt.failed, 1);
  const again = await f.router().route(actor, { event, subscriptionId: 'h2b-notify-failed' });
  assert.equal(again.items[0]!.reason, 'INTENT_ALREADY_SETTLED');
  assert.equal(f.effect.sends.length, 1);
  assert.equal((await f.router().reconcile(intentRefs(receipt)[0]!)).changed, false);
});

test('fan-out and pending-intent bounds defer work instead of silently dropping or broadcasting', async t => {
  const f = await fixture(t, () => ({ status: 'unknown' }));
  await f.lifecycle.subscribe(actor, subscription('h2b-notify-fanout', {
    category: 'result', destinations: [
      { kind: 'channel', ref: 'room:1', allowedFields: ['message'] },
      { kind: 'channel', ref: 'room:2', allowedFields: ['message'] },
      { kind: 'channel', ref: 'room:3', allowedFields: ['message'] },
    ],
  }));
  const event = await publishResult(f);
  const bounded = await f.router({ maxFanout: 2 }).route(actor, { event, subscriptionId: 'h2b-notify-fanout' });
  assert.equal(bounded.delivered + bounded.unknown, 2);
  assert.equal(bounded.deferred, 1);
  assert.equal(f.effect.sends.length, 2);
  // With pending/unknown intents above the configured cap, routing defers
  // everything rather than creating unbounded work.
  const event2 = await publishResult(f);
  const capped = await f.router({ maxFanout: 2, maxPendingIntents: 1 }).route(actor, { event: event2, subscriptionId: 'h2b-notify-fanout' });
  assert.equal(capped.status, 'deferred');
  assert.equal(capped.sent, 0);
  assert.equal(f.effect.sends.length, 2);
});

test('causation chains are bounded and cycles block notification routing (no self-echo loop)', async t => {
  const f = await fixture(t);
  await f.lifecycle.subscribe(actor, subscription('h2b-notify-loop', {
    category: 'result', destinations: [{ kind: 'channel', ref: 'room:a', allowedFields: ['message'] }],
  }));
  // Build a bounded causal chain of accepted events.
  let previous: string | undefined;
  let last: StoredEvent | undefined;
  const chainPublisher: EventPrincipal = { ...publisher, publishTypes: ['component.observation.reported'], subscribeTypes: ['component.observation.reported'] };
  for (let index = 0; index < 10; index++) {
    await f.events.publish(chainPublisher, { type: 'component.observation.reported', scope: OWNER,
      payload: { message: `chain-${index}`, sourceRef: 'file:chain' }, idempotencyKey: `chain-${index}`,
      ...(previous ? { causationId: previous } : {}) });
    const events = await f.events.listEvents(readerPrincipal());
    last = events.find(event => event.payload.message === `chain-${index}`)!;
    previous = last.eventId;
  }
  const blocked = await f.router({ maxChainDepth: 8 }).route(actor, { event: last!, subscriptionId: 'h2b-notify-loop' });
  assert.equal(blocked.status, 'loop_blocked');
  assert.ok(blocked.chainDepth > 8);
  assert.equal(f.effect.sends.length, 0);
  // A direct causal cycle is blocked as well.
  const cyclic = { ...last!, causationId: last!.eventId } as StoredEvent;
  const cycle = await f.router({ maxChainDepth: 8 }).route(actor, { event: cyclic, subscriptionId: 'h2b-notify-loop' });
  assert.equal(cycle.status, 'loop_blocked');
  assert.equal(f.effect.sends.length, 0);
  // The same chain within the depth bound routes normally.
  const shallowEvents = await f.events.listEvents(readerPrincipal());
  const shallow = shallowEvents.find(event => event.payload.message === 'chain-1')!;
  const routed = await f.router({ maxChainDepth: 8 }).route(actor, { event: shallow, subscriptionId: 'h2b-notify-loop' });
  assert.equal(routed.status, 'routed');
  assert.equal(routed.delivered, 1);
  assert.equal((await f.events.listEvents(readerPrincipal())).length > 0, true);
});
