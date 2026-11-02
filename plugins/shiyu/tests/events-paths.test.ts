import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundPump } from '../src/control/background-pump.js';
import { EventDeliveryCoordinator, type AgentEventTarget, type ComponentEventConsumer, type ContinuationContextReceipt } from '../src/control/events/index.js';
import { createWorkerEventTools } from '../src/adapters/dsh/event-tools.js';
import { WorkerSessionDriver } from '../src/adapters/dsh/workers.js';
import type { EventPrincipal, SubscribeInput } from '../src/contracts/events.js';
import {
  EffectLedger, HANDLER_A, HANDLER_B, SyntheticAgentSession, coordinatorPrincipal, eventStore,
  fakeWorkerHost, readerPrincipal, workerRequest,
} from './events-fixtures.js';

const componentPublisher = (types = ['component.observation.reported'], principalId = 'trusted-component:files'): EventPrincipal => ({
  principalId, kind: 'component', scopes: ['local-owner'], publishTypes: types, subscribeTypes: [], targetRefs: [],
});
const agentSubscriber = (targetRefs: string[], subscribeTypes = ['task.succeeded', 'component.observation.reported', 'worker.result.reported', 'agent.observation.reported']): EventPrincipal => ({
  principalId: 'core-agent:goal-1', kind: 'agent', scopes: ['local-owner'], publishTypes: ['agent.observation.reported'],
  subscribeTypes, targetRefs,
});
const subscription = (id: string, types: string[], patch: Partial<SubscribeInput> = {}): SubscribeInput => ({
  id, types, scope: 'local-owner', target: { kind: 'component', handlerRef: HANDLER_A }, deliveryMode: 'component', start: { kind: 'from_now' }, ...patch,
});

function componentConsumer(handlerRef: string, ledger: EffectLedger, calls?: () => void): ComponentEventConsumer {
  return { handlerRef, async consume(input) {
    calls?.();
    const recorded = ledger.record(input.deliveryId, `${input.event.type}:${input.event.eventId}`);
    return { effectRef: recorded.effectRef };
  } };
}

interface GoalPorts {
  target: AgentEventTarget;
  model: SyntheticAgentSession;
  references: EffectLedger;
  wakes: () => number;
  setPaused(value: boolean): void;
  setAllowed(value: boolean): void;
  setReason(value: string | undefined): void;
  gateCalls: number;
  dispatches: number;
}
function goalTarget(bindingId: string, mode: 'background' | 'continuation', model = new SyntheticAgentSession()): GoalPorts {
  const references = new EffectLedger();
  const state = { paused: false, allowed: true, reason: undefined as string | undefined };
  const ports: GoalPorts = {
    model, references, gateCalls: 0, dispatches: 0,
    wakes: () => model.modelWakes,
    setPaused(value) { state.paused = value; },
    setAllowed(value) { state.allowed = value; },
    setReason(value) { state.reason = value; },
    target: {
      bindingId, mode,
      async updateBackground(input) {
        const recorded = references.record(input.deliveryId, input.eventId);
        return { referenceId: recorded.effectRef, duplicate: recorded.duplicate };
      },
      async evaluateContinuation() {
        ports.gateCalls++;
        if (state.paused) return { allowed: false, reason: 'PAUSED' };
        return state.allowed ? { allowed: true } : { allowed: false, reason: state.reason ?? 'REVOKED' };
      },
      async dispatchContinuation(input) {
        ports.dispatches++;
        return model.append({ deliveryId: input.deliveryId, eventId: input.eventId, text: `${input.event.type}:${input.event.eventId}` }) as ContinuationContextReceipt;
      },
    },
  };
  return ports;
}

function coordinator(events: any, handlers: ComponentEventConsumer[], agentTargets: AgentEventTarget[], targetRefs: string[], timeoutMs = 1000) {
  return new EventDeliveryCoordinator({ events, principal: coordinatorPrincipal(targetRefs), handlers, agentTargets, handlerTimeoutMs: timeoutMs, retryDelayMs: 0 });
}

async function publish(events: any, principal: EventPrincipal, type: string, payload: Record<string, unknown>, key: string) {
  return events.publish(principal, { type, scope: 'local-owner', payload, idempotencyKey: key });
}

test('component -> component: zero-model handler consumes a durable delivery exactly once', async t => {
  const f = await eventStore(t);
  const ledger = new EffectLedger();
  let modelCalls = 0;
  const consumer = componentConsumer(HANDLER_A, ledger, () => { modelCalls++; });
  const subscriber = agentSubscriber([HANDLER_A], ['component.observation.reported']);
  await f.events.subscribe(subscriber, subscription('cc-sub', ['component.observation.reported']));
  const receipt = await publish(f.events, componentPublisher(), 'component.observation.reported', { message: 'file changed', sourceRef: 'file:a' }, 'cc-1');
  assert.equal(receipt.deliveryCount, 1);
  const batch = await coordinator(f.events, [consumer], [], [HANDLER_A]).consume(10);
  assert.equal(batch.claimed, 1);
  assert.equal(batch.processed, 1);
  assert.equal(batch.deliveries[0]!.kind, 'component');
  assert.equal(batch.deliveries[0]!.outcome, 'acked');
  assert.equal(ledger.count, 1);
  assert.equal(modelCalls, 1, 'the synthetic handler counter proves the component path was actually executed');
  // A duplicate publisher retry is the same accepted event: no second effect.
  const duplicate = await publish(f.events, componentPublisher(), 'component.observation.reported', { message: 'file changed', sourceRef: 'file:a' }, 'cc-1');
  assert.equal(duplicate.status, 'duplicate');
  assert.equal((await f.events.listDeliveries(readerPrincipal(['local-owner'], [HANDLER_A]))).length, 1);
  const again = await coordinator(f.events, [consumer], [], [HANDLER_A]).consume(10);
  assert.equal(again.claimed, 0);
  assert.equal(ledger.count, 1);
});

test('component -> agent: a background reference is durable, zero-model and acked independently', async t => {
  const f = await eventStore(t);
  const ports = goalTarget('goal:background', 'background');
  const subscriber = agentSubscriber(['goal:background'], ['component.observation.reported']);
  await f.events.subscribe(subscriber, subscription('ca-background', ['component.observation.reported'],
    { target: { kind: 'agent', bindingId: 'goal:background' }, deliveryMode: 'background' }));
  await publish(f.events, componentPublisher(), 'component.observation.reported', { message: 'index changed', sourceRef: 'file:b' }, 'ca-1');
  const batch = await coordinator(f.events, [], [ports.target], ['goal:background']).consumeAgentDeliveries(10);
  assert.equal(batch.claimed, 1);
  assert.equal(batch.processed, 1);
  const decision = batch.deliveries[0]!;
  assert.equal(decision.kind, 'background');
  assert.equal(decision.outcome, 'acked');
  assert.equal(decision.dispatched, undefined);
  assert.equal(decision.contextReceipt, undefined);
  assert.equal(decision.referenceId, 'effect:1');
  assert.equal(ports.references.count, 1, 'background marker committed once');
  assert.equal(ports.wakes(), 0, 'background-only consumption never wakes a model');
  assert.equal(ports.dispatches, 0);
  assert.equal((await f.events.stats(readerPrincipal(['local-owner'], ['goal:background']))).acknowledged, 1);
});

test('component -> agent: continuation re-checks the trusted gate, then dispatches with a separate context receipt', async t => {
  const f = await eventStore(t);
  const ports = goalTarget('goal:continue', 'continuation');
  const subscriber = agentSubscriber(['goal:continue'], ['component.observation.reported']);
  await f.events.subscribe(subscriber, subscription('ca-continue', ['component.observation.reported'],
    { target: { kind: 'agent', bindingId: 'goal:continue' }, deliveryMode: 'background', once: true }));
  await publish(f.events, componentPublisher(), 'component.observation.reported', { message: 'verified result', sourceRef: 'file:c' }, 'ca-2');
  const batch = await coordinator(f.events, [], [ports.target], ['goal:continue']).consumeAgentDeliveries(10);
  const decision = batch.deliveries[0]!;
  assert.equal(decision.kind, 'continuation');
  assert.equal(decision.outcome, 'acked');
  assert.equal(decision.dispatched, true);
  assert.equal(decision.referenceId, 'effect:1');
  assert.equal(decision.contextReceipt?.durability, 'confirmed');
  assert.equal(decision.contextReceipt?.sessionId, ports.model.sessionId);
  assert.equal(decision.contextReceipt?.messageId, 'native-user-1');
  assert.equal(ports.references.count, 1, 'background marker and context receipt are distinct commits');
  assert.equal(ports.model.appended.length, 1);
  assert.equal(ports.wakes(), 1);
  // Acked delivery is not replayed, even after another scan.
  assert.equal((await coordinator(f.events, [], [ports.target], ['goal:continue']).consumeAgentDeliveries(10)).claimed, 0);
  assert.equal(ports.wakes(), 1);
});

test('agent -> component: a real mounted worker tool report is consumed by a zero-model component handler', async t => {
  const f = await eventStore(t);
  const ledger = new EffectLedger();
  const subscriber = agentSubscriber([HANDLER_A], ['agent.observation.reported']);
  await f.events.subscribe(subscriber, subscription('ac-sub', ['agent.observation.reported']));
  const fake = fakeWorkerHost();
  const driver = new WorkerSessionDriver({ ctx: fake.ctx, createUserMessage: fake.factory,
    eventTools: { tools: () => createWorkerEventTools({ service: f.events, resolvePrincipal: context => ({
      principalId: `worker:${context.assignmentId}`, kind: 'agent', scopes: [context.scope],
      publishTypes: ['agent.observation.reported', 'worker.result.reported'], subscribeTypes: [], targetRefs: [] }) }) } });
  try {
    fake.toolCall('shiyu_worker_event_report', { type: 'agent.observation.reported',
      payload: { message: 'worker observed a synthetic change', sourceRef: 'artifact:a' }, idempotencyKey: 'ac-1' });
    const result = await driver.run(workerRequest().input);
    assert.equal(result.verified, false);
    const batch = await coordinator(f.events, [componentConsumer(HANDLER_A, ledger)], [], [HANDLER_A]).consume(10);
    assert.equal(batch.processed, 1);
    assert.equal(ledger.count, 1);
    const [event] = await f.events.listEvents(readerPrincipal());
    assert.equal(event!.actor.principalId, 'worker:assignment-1');
    assert.equal(event!.actor.kind, 'agent');
    assert.equal(event!.type, 'agent.observation.reported');
  } finally { await driver.close(); }
});

test('agent -> agent: a real worker report reaches a bound Agent only after its goal/authorization/instance/budget gate', async t => {
  const f = await eventStore(t);
  const ports = goalTarget('goal:agent', 'continuation');
  const subscriber = agentSubscriber(['goal:agent'], ['worker.result.reported']);
  await f.events.subscribe(subscriber, subscription('aa-sub', ['worker.result.reported'],
    { target: { kind: 'agent', bindingId: 'goal:agent' }, deliveryMode: 'background' }));
  const fake = fakeWorkerHost();
  const driver = new WorkerSessionDriver({ ctx: fake.ctx, createUserMessage: fake.factory,
    eventTools: { tools: () => createWorkerEventTools({ service: f.events, resolvePrincipal: context => ({
      principalId: `worker:${context.assignmentId}`, kind: 'agent', scopes: [context.scope],
      publishTypes: ['agent.observation.reported', 'worker.result.reported'], subscribeTypes: [], targetRefs: [] }) }) } });
  try {
    fake.toolCall('shiyu_worker_event_report', { type: 'worker.result.reported',
      payload: { taskId: 'task-1', message: 'candidate result requires review' }, idempotencyKey: 'aa-1' });
    await driver.run(workerRequest().input);
    const batch = await coordinator(f.events, [], [ports.target], ['goal:agent']).consumeAgentDeliveries(10);
    assert.equal(batch.processed, 1);
    assert.equal(ports.gateCalls, 1);
    assert.equal(ports.dispatches, 1);
    assert.equal(ports.wakes(), 1);
    assert.equal(ports.references.count, 1);
    // The published observation is not task success: only TaskService can publish
    // task.succeeded, and a worker cannot even name it through its tool surface.
    fake.toolCall('shiyu_worker_event_report', { type: 'task.succeeded', payload: { taskId: 'task-1' }, idempotencyKey: 'aa-forged' });
    await assert.rejects(driver.run(workerRequest().input), /Reserved outcome/);
    assert.equal((await f.events.listEvents(readerPrincipal())).filter(event => event.type === 'task.succeeded').length, 0);
  } finally { await driver.close(); }
});

test('one event fans out to a component handler and a bound Agent with independent durable decisions', async t => {
  const f = await eventStore(t);
  const ledger = new EffectLedger();
  const ports = goalTarget('goal:fanout', 'continuation');
  const subscriber = agentSubscriber([HANDLER_A, 'goal:fanout'], ['component.observation.reported']);
  await f.events.subscribe(subscriber, subscription('fan-component', ['component.observation.reported']));
  await f.events.subscribe(subscriber, subscription('fan-agent', ['component.observation.reported'],
    { target: { kind: 'agent', bindingId: 'goal:fanout' }, deliveryMode: 'background' }));
  const receipt = await publish(f.events, componentPublisher(), 'component.observation.reported', { message: 'fan out', sourceRef: 'file:d' }, 'fan-1');
  assert.equal(receipt.deliveryCount, 2);
  const batch = await coordinator(f.events, [componentConsumer(HANDLER_A, ledger)], [ports.target], [HANDLER_A, 'goal:fanout']).consume(10);
  assert.equal(batch.claimed, 2);
  assert.equal(batch.processed, 2);
  assert.deepEqual(batch.deliveries.map(item => item.kind).sort(), ['component', 'continuation']);
  assert.equal(ledger.count, 1);
  assert.equal(ports.references.count, 1);
  assert.equal(ports.wakes(), 1);
});

test('the coordinator merges into the single existing BackgroundPump scan instead of a second delivery loop', async t => {
  const f = await eventStore(t);
  const ports = goalTarget('goal:pump', 'continuation');
  const subscriber = agentSubscriber(['goal:pump'], ['component.observation.reported']);
  await f.events.subscribe(subscriber, subscription('pump-sub', ['component.observation.reported'],
    { target: { kind: 'agent', bindingId: 'goal:pump' }, deliveryMode: 'background' }));
  await publish(f.events, componentPublisher(), 'component.observation.reported', { message: 'pump', sourceRef: 'file:e' }, 'pump-1');
  const delivery = coordinator(f.events, [], [ports.target], ['goal:pump']);
  // Shape used by runtime integration: one pump consumes the existing
  // conversation projection and the new Agent deliveries in the same tick.
  // `scan` maps superseded claims to settled attempts, so the pump's
  // processed+failed===claimed receipt contract always holds.
  const pump = new BackgroundPump({ intervalMs: 60000, batchSize: 5, consume: async limit => {
    const projection = { claimed: 0, processed: 0, failed: 0 };
    const agent = await delivery.scan(limit);
    return { claimed: projection.claimed + agent.claimed, processed: projection.processed + agent.processed, failed: projection.failed + agent.failed };
  } });
  t.after(() => pump.close());
  await pump.start();
  assert.equal(pump.snapshot().state, 'idle');
  assert.equal(pump.snapshot().lastBatch?.claimed, 1);
  assert.equal(pump.snapshot().lastBatch?.processed, 1);
  assert.equal(ports.wakes(), 1);
  assert.equal((await pump.wake(), pump.snapshot().lastBatch?.claimed), 0);
});
