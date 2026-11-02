import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  CORE_CONTINUATION_DENIAL_REASONS, CoreGoalContinuationTarget, coreContinuationText,
  type CoreGoalContinuationState, type ContinuationContextReceipt,
} from '../src/control/events/index.js';
import { createWorkerEventTools } from '../src/adapters/dsh/event-tools.js';
import { WorkerSessionDriver } from '../src/adapters/dsh/workers.js';
import {
  EffectLedger, HANDLER_A, OWNER_SCOPE, agentSubscriber, componentPublisher, coordinatorFor, eventStore,
  fakeWorkerHost, readerPrincipal, workerRequest,
} from './events-fixtures.js';

interface GoalWorld {
  state: CoreGoalContinuationState;
  baselineAvailable: boolean;
  baselineSessionIds: string[];
  background: EffectLedger;
  appended: { deliveryId: string; eventId: string; text: string }[];
  wakes: number;
  failDispatchOnce: boolean;
  dedupe: Map<string, ContinuationContextReceipt>;
  changeDuringBaseline?: (world: GoalWorld) => void;
  target: CoreGoalContinuationTarget;
}

function goalWorld(overrides: Partial<CoreGoalContinuationState> = {}): GoalWorld {
  const world: GoalWorld = {
    state: { goalId: 'goal-1', sessionId: 'shiyu-core-goal-synthetic', goalActive: true, authorized: true,
      authorizationEpoch: 7, instanceValid: true, budgetAvailable: true, ...overrides },
    baselineAvailable: true, baselineSessionIds: [], background: new EffectLedger(), appended: [], wakes: 0, failDispatchOnce: false,
    dedupe: new Map(), target: undefined as unknown as CoreGoalContinuationTarget,
  };
  world.target = new CoreGoalContinuationTarget({
    bindingId: 'core-goal:goal-1', goalId: 'goal-1', expectedSessionId: 'shiyu-core-goal-synthetic', expectedAuthorizationEpoch: 7,
    async readState() { return structuredClone(world.state); },
    assertNativeBaseline(sessionId) {
      world.baselineSessionIds.push(sessionId);
      world.changeDuringBaseline?.(world);
      if (!world.baselineAvailable) throw new Error('H1 cold baseline unavailable');
    },
    async background(input) {
      const recorded = world.background.record(input.deliveryId, input.eventId);
      return { referenceId: recorded.effectRef, duplicate: recorded.duplicate };
    },
    async dispatch(input) {
      if (world.failDispatchOnce) { world.failDispatchOnce = false; throw Object.assign(new Error('native append response lost'), { code: 'DISPATCH_UNKNOWN' }); }
      const existing = world.dedupe.get(input.deliveryId);
      if (existing) return existing;
      const receipt: ContinuationContextReceipt = { sessionId: input.sessionId, eventSeq: world.appended.length,
        messageId: `native-user-${world.appended.length + 1}`, durability: 'confirmed' };
      world.appended.push({ deliveryId: input.deliveryId, eventId: input.eventId, text: input.text });
      world.wakes++; world.dedupe.set(input.deliveryId, receipt);
      return receipt;
    },
  });
  return world;
}

async function pendingEvent(f: Awaited<ReturnType<typeof eventStore>>, key = 'core-1') {
  const subscriber = agentSubscriber(['core-goal:goal-1'], ['component.observation.reported']);
  await f.events.subscribe(subscriber, { id: `core-sub-${key}`, types: ['component.observation.reported'], scope: OWNER_SCOPE,
    target: { kind: 'agent', bindingId: 'core-goal:goal-1' }, deliveryMode: 'background', start: { kind: 'from_now' } });
  return f.events.publish(componentPublisher(), { type: 'component.observation.reported', scope: OWNER_SCOPE,
    payload: { message: 'component fact', sourceRef: 'file:core' }, idempotencyKey: key });
}

function coordinator(f: Awaited<ReturnType<typeof eventStore>>, world: GoalWorld, timeoutMs = 1000) {
  return coordinatorFor(f.events, [], [world.target], ['core-goal:goal-1'], timeoutMs);
}

test('core continuation admits one event only after current Goal/auth/instance/budget checks and a baseline check', async t => {
  const f = await eventStore(t);
  const world = goalWorld();
  await pendingEvent(f);
  const batch = await coordinator(f, world).consumeAgentDeliveries(10);
  assert.equal(batch.processed, 1);
  const decision = batch.deliveries[0]!;
  assert.equal(decision.kind, 'continuation');
  assert.equal(decision.outcome, 'acked');
  assert.equal(decision.dispatched, true);
  assert.equal(decision.referenceId, 'effect:1');
  assert.equal(decision.contextReceipt?.sessionId, 'shiyu-core-goal-synthetic');
  assert.equal(decision.contextReceipt?.durability, 'confirmed');
  assert.equal(world.background.count, 1);
  assert.deepEqual(world.baselineSessionIds, ['shiyu-core-goal-synthetic']);
  assert.equal(world.appended.length, 1);
  assert.equal(world.wakes, 1);
  const snapshot = world.target.snapshot();
  // One gate decision for the coordinator, then two inside the dispatch port:
  // immediately before the baseline await and again after it.
  assert.equal(snapshot.gateChecks, 3, 'dispatch re-reads current conditions around the H1 baseline check');
  assert.equal(snapshot.denials, 0);
  assert.equal(snapshot.dispatches, 1);
  assert.match(world.appended[0]!.text, /component\.observation\.reported/);
  // A second scan never repeats an acked continuation.
  assert.equal((await coordinator(f, world).consumeAgentDeliveries(10)).claimed, 0);
  assert.equal(world.wakes, 1);
});

test('every stale core condition degrades to a zero-model background reference with a concrete reason', async t => {
  const cases: { patch: Partial<CoreGoalContinuationState>; reason: string }[] = [
    { patch: { goalActive: false }, reason: 'GOAL_INACTIVE' },
    { patch: { authorized: false }, reason: 'REVOKED' },
    { patch: { authorizationEpoch: 8 }, reason: 'AUTH_CHANGED' },
    { patch: { instanceValid: false }, reason: 'STALE_INSTANCE' },
    { patch: { budgetAvailable: false }, reason: 'BUDGET_EXHAUSTED' },
    { patch: { sessionId: 'shiyu-core-goal-other' }, reason: 'STALE_SESSION' },
  ];
  for (const [index, item] of cases.entries()) {
    assert.ok(CORE_CONTINUATION_DENIAL_REASONS.has(item.reason));
    const f = await eventStore(t);
    const world = goalWorld(item.patch);
    await pendingEvent(f, `denied-${index}`);
    const batch = await coordinator(f, world).consumeAgentDeliveries(10);
    const decision = batch.deliveries[0]!;
    assert.equal(decision.outcome, 'acked', item.reason);
    assert.equal(decision.dispatched, false, item.reason);
    assert.equal(decision.continuationReason, item.reason);
    assert.equal(decision.contextReceipt, undefined);
    assert.equal(world.wakes, 0, `${item.reason} must not wake a model`);
    assert.equal(world.appended.length, 0);
    assert.equal(world.background.count, 1, `${item.reason} still keeps one durable background reference`);
    assert.equal(world.baselineSessionIds.length, 0, `${item.reason} never reaches native dispatch`);
  }
});

test('a failed H1 baseline check blocks dispatch and retries without a model wake or a second context', async t => {
  const f = await eventStore(t);
  const world = goalWorld();
  world.baselineAvailable = false;
  await pendingEvent(f);
  const first = await coordinator(f, world).consumeAgentDeliveries(10);
  assert.equal(first.deliveries[0]!.outcome, 'retrying');
  assert.equal(first.deliveries[0]!.errorCode, 'NATIVE_BASELINE_UNAVAILABLE');
  assert.equal(world.appended.length, 0);
  assert.equal(world.target.snapshot().lastReason, 'NATIVE_BASELINE_UNAVAILABLE');
  // Maintenance recovers; the same durable delivery retries exactly one dispatch.
  world.baselineAvailable = true;
  const second = await coordinator(f, world).consumeAgentDeliveries(10);
  assert.equal(second.processed, 1);
  assert.equal(second.deliveries[0]!.dispatched, true);
  assert.equal(world.appended.length, 1);
  assert.equal(world.wakes, 1);
  assert.equal(world.background.count, 1, 'background retry is idempotent per deliveryId');
});

test('a revocation occurring during the baseline check prevents the already-allowed dispatch', async t => {
  const f = await eventStore(t);
  const world = goalWorld();
  world.changeDuringBaseline = value => { value.state.authorized = false; };
  await pendingEvent(f);
  const batch = await coordinator(f, world).consumeAgentDeliveries(10);
  const decision = batch.deliveries[0]!;
  assert.equal(decision.outcome, 'retrying');
  assert.equal(decision.errorCode, 'CONTINUATION_DENIED');
  assert.equal(world.appended.length, 0, 'the first gate decision is not a capability');
  assert.equal(world.wakes, 0);
  assert.equal(world.background.count, 1);
});

test('an unknown native append outcome retries by delivery identity; the host dedupe keeps one append', async t => {
  const f = await eventStore(t);
  const world = goalWorld();
  world.failDispatchOnce = true;
  await pendingEvent(f);
  const first = await coordinator(f, world).consumeAgentDeliveries(10);
  assert.equal(first.deliveries[0]!.outcome, 'retrying');
  assert.equal(first.deliveries[0]!.contextReceipt, undefined, 'an unconfirmed append is not reported as a context receipt');
  const second = await coordinator(f, world).consumeAgentDeliveries(10);
  assert.equal(second.processed, 1);
  assert.equal(second.deliveries[0]!.contextReceipt?.durability, 'confirmed');
  assert.equal(world.appended.length, 1);
  assert.equal(world.wakes, 1);
  assert.deepEqual(world.background.duplicates, [second.deliveries[0]!.deliveryId]);
});

test('core continuation text is bounded, deterministic and clearly marked as data, not authorization', () => {
  const event = { eventId: 'event-1', sequence: 4, type: 'worker.result.reported', schemaVersion: 1, scope: 'local-owner',
    actor: { principalId: 'worker:assignment-1', kind: 'agent' },
    payload: { taskId: 'task-1', message: 'x'.repeat(20000) }, receivedAt: '2026-11-02T00:00:00.000Z',
    correlationId: 'event-1' } as any;
  const first = coreContinuationText(event);
  const second = coreContinuationText(event);
  assert.equal(first, second);
  assert.ok(Buffer.byteLength(first) <= 8192);
  assert.match(first, /Background event reference/);
  assert.match(first, /not a new authorization/);
  assert.match(first, /"eventId":"event-1"/);
  assert.match(first, /"type":"worker\.result\.reported"/);
  assert.match(first, /"payloadSummary":"\{\\"taskId\\":\\"task-1\\"/);
});

test('core continuation accepts a real worker report but never lets it become an authoritative success fact', async t => {
  const f = await eventStore(t);
  const world = goalWorld();
  const subscriber = agentSubscriber(['core-goal:goal-1'], ['worker.result.reported']);
  await f.events.subscribe(subscriber, { id: 'core-worker-report', types: ['worker.result.reported'], scope: OWNER_SCOPE,
    target: { kind: 'agent', bindingId: 'core-goal:goal-1' }, deliveryMode: 'background', start: { kind: 'from_now' } });
  const fake = fakeWorkerHost();
  const driver = new WorkerSessionDriver({ ctx: fake.ctx, createUserMessage: fake.factory,
    eventTools: { tools: () => createWorkerEventTools({ service: f.events, resolvePrincipal: context => ({
      principalId: `worker:${context.assignmentId}`, kind: 'agent', scopes: [context.scope],
      publishTypes: ['agent.observation.reported', 'worker.result.reported'], subscribeTypes: [], targetRefs: [] }) }) } });
  try {
    fake.toolCall('shiyu_worker_event_report', { type: 'worker.result.reported',
      payload: { taskId: 'task-1', message: 'candidate only; independent verification pending' }, idempotencyKey: 'core-worker-1' });
    await driver.run(workerRequest().input);
    const batch = await coordinator(f, world).consumeAgentDeliveries(10);
    assert.equal(batch.processed, 1);
    assert.equal(world.appended.length, 1);
    const events = await f.events.listEvents(readerPrincipal());
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'worker.result.reported');
    assert.equal(events[0]!.actor.kind, 'agent');
    // No `task.succeeded` fact exists; the core decision Session is never given
    // model-callable event tools by this port (H1 zero-tool invariant preserved).
    assert.equal(events.some(event => event.type === 'task.succeeded'), false);
    assert.match(world.appended[0]!.text, /worker\.result\.reported/);
    // The port's own gate is observable and has no hidden model call.
    assert.equal(world.target.snapshot().dispatches, 1);
    assert.equal(world.wakes, 1);
  } finally { await driver.close(); }
});

test('a missing trusted state read or malformed binding identity fails closed before any effect', async t => {
  const f = await eventStore(t);
  const world = goalWorld();
  await pendingEvent(f);
  // The state port is authoritative: if it cannot read current facts, no
  // continuation may be admitted.
  const broken = new CoreGoalContinuationTarget({ bindingId: 'core-goal:goal-1', goalId: 'goal-1',
    expectedSessionId: 'shiyu-core-goal-synthetic', expectedAuthorizationEpoch: 7,
    readState: async () => { throw new Error('state store unavailable'); },
    background: async () => ({ referenceId: 'x', duplicate: false }),
    dispatch: async () => { throw new Error('must not dispatch'); } });
  const batch = await coordinatorFor(f.events, [], [broken], ['core-goal:goal-1']).consumeAgentDeliveries(10);
  assert.equal(batch.deliveries[0]!.outcome, 'retrying');
  assert.equal(batch.deliveries[0]!.errorCode, 'CONSUMER_FAILED');
  // Invalid binding identities are rejected at construction time.
  assert.throws(() => new CoreGoalContinuationTarget({ bindingId: '', goalId: 'goal-1', expectedSessionId: 's',
    expectedAuthorizationEpoch: 0, readState: async () => world.state, background: async () => ({ referenceId: 'x', duplicate: false }),
    dispatch: async () => ({ sessionId: 's', eventSeq: 0, messageId: 'm', durability: 'confirmed' }) }), /invalid/);
});

test('a slow trusted state read is bounded by the coordinator and causes no dispatch', async t => {
  const f = await eventStore(t);
  const world = goalWorld();
  await pendingEvent(f);
  const slowTarget = new CoreGoalContinuationTarget({ bindingId: 'core-goal:goal-1', goalId: 'goal-1',
    expectedSessionId: 'shiyu-core-goal-synthetic', expectedAuthorizationEpoch: 7,
    readState: async () => { await delay(5000); return world.state; },
    background: async input => { const recorded = world.background.record(input.deliveryId, input.eventId); return { referenceId: recorded.effectRef, duplicate: recorded.duplicate }; },
    dispatch: async () => { throw new Error('must not dispatch'); } });
  const started = Date.now();
  const batch = await coordinatorFor(f.events, [], [slowTarget], ['core-goal:goal-1'], 30).consumeAgentDeliveries(10);
  assert.ok(Date.now() - started < 2000);
  assert.equal(batch.deliveries[0]!.outcome, 'retrying');
  assert.equal(batch.deliveries[0]!.errorCode, 'CONSUMER_TIMEOUT');
  assert.equal(world.appended.length, 0);
});

test('handler and target failures do not leak one consumer error into another delivery decision', async t => {
  const f = await eventStore(t);
  const ledger = new EffectLedger();
  const world = goalWorld();
  world.state.authorized = false;
  const subscriber = agentSubscriber([HANDLER_A, 'core-goal:goal-1'], ['component.observation.reported']);
  await f.events.subscribe(subscriber, { id: 'mixed-handler', types: ['component.observation.reported'], scope: OWNER_SCOPE,
    target: { kind: 'component', handlerRef: HANDLER_A }, deliveryMode: 'component', start: { kind: 'from_now' } });
  await pendingEvent(f, 'mixed-1');
  const batch = await coordinatorFor(f.events, [{ handlerRef: HANDLER_A, async consume() { throw Object.assign(new Error('handler failed'), { code: 'HANDLER_BOOM' }); } }],
    [world.target], [HANDLER_A, 'core-goal:goal-1']).consume(10);
  assert.equal(batch.claimed, 2);
  assert.equal(batch.processed, 1, 'the revoked continuation is still consumed as a background reference');
  assert.equal(batch.failed, 1, 'only the failing component handler retries');
  const handlerFailure = batch.deliveries.find(item => item.kind === 'component')!;
  const agentDecision = batch.deliveries.find(item => item.kind === 'continuation')!;
  assert.equal(handlerFailure.errorCode, 'HANDLER_BOOM');
  assert.equal(agentDecision.outcome, 'acked');
  assert.equal(agentDecision.continuationReason, 'REVOKED');
  assert.equal(ledger.count, 0);
  assert.equal(world.wakes, 0);
});
