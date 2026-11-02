import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { EventService } from '../src/control/events/index.js';
import { SHIYU_EVENT_TYPES, type EventPrincipal } from '../src/contracts/events.js';
import { WorkerSessionDriver } from '../src/adapters/dsh/workers.js';
import { createWorkerEventToolSource, createWorkerEventTools, WORKER_EVENT_PUBLISH_TYPES, WORKER_EVENT_TOOL_NAMES } from '../src/adapters/dsh/event-tools.js';
import { fakeWorkerHost, workerRequest, eventStore, readerPrincipal } from './events-fixtures.js';

const workerPrincipal = (context: { assignmentId: string; scope: string }): EventPrincipal => ({
  principalId: `worker:${context.assignmentId}`, kind: 'agent', scopes: [context.scope],
  publishTypes: [...WORKER_EVENT_PUBLISH_TYPES], subscribeTypes: [], targetRefs: [],
});

async function fixture(t: import('node:test').TestContext, overrides: { publishTypes?: string[]; componentHandlers?: string[] } = {}) {
  const stored = await eventStore(t, overrides.componentHandlers ?? []);
  const fake = fakeWorkerHost();
  const resolved: unknown[] = [];
  const published: { eventId: string; sequence: number; status: string }[] = [];
  const eventTools = createWorkerEventTools({ service: stored.events, resolvePrincipal(context) {
    resolved.push(context); return workerPrincipal(context);
  }, onPublished: receipt => published.push(receipt) });
  const driver = new WorkerSessionDriver({ ctx: fake.ctx, createUserMessage: fake.factory });
  const source = {
    calls: [] as { binding: unknown; identity: unknown }[],
    tools(input: any) { source.calls.push(structuredClone({ binding: input.binding, identity: input.identity })); return eventTools; },
  };
  driver.attachEventTools(source);
  t.after(async () => { await driver.close().catch(() => undefined); });
  return { ...stored, fake, driver, source, resolved, eventTools, published };
}

const reportArgs = (key = 'report-1') => ({
  type: 'agent.observation.reported', payload: { message: 'synthetic observation', sourceRef: 'artifact:a' }, idempotencyKey: key,
});

function toolResultTexts(fake: ReturnType<typeof fakeWorkerHost>, sessionId: string): string[] {
  const events = fake.persisted.get(sessionId)?.events ?? [];
  return events.filter(event => event.type === 'tool/result').map(event => {
    const content = event.data?.message?.content;
    return Array.isArray(content) ? content.map((part: any) => String(part.text ?? '')).join('') : '';
  });
}

test('worker event tools are mounted into the real restricted native Session and publish only the host-injected actor', async t => {
  const f = await fixture(t);
  f.fake.toolCall('shiyu_worker_event_report', reportArgs());
  const result = await f.driver.run(workerRequest().input);
  assert.equal(result.verified, false);
  // Mounted tool schemas are exactly the restricted worker surfaces and are the
  // only tools the native Session ever sees, regardless of host capabilities.
  assert.deepEqual(f.fake.assemblies[0].tools.map((tool: any) => tool.name), [...WORKER_EVENT_TOOL_NAMES]);
  for (const tool of f.fake.assemblies[0].tools) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.parameters.properties.scope, undefined);
    assert.equal(tool.parameters.properties.actor, undefined);
    assert.equal(tool.parameters.properties.permit, undefined);
    assert.equal(tool.parameters.properties.taskId, undefined);
  }
  // The trusted driver supplied the Assignment binding/identity to the source.
  assert.equal(f.source.calls.length, 1);
  assert.deepEqual(f.source.calls[0].binding, { taskId: 'task-1', assignmentId: 'assignment-1', scope: 'local-owner', sessionId: result.sessionId });
  assert.equal((f.source.calls[0].identity as any).fencingToken, 1);
  // The tool resolved its identity from the native execution context, not args.
  assert.equal(f.resolved.length, 1);
  assert.equal((f.resolved[0] as any).scope, 'local-owner');
  // Exactly one accepted event with the host principal identity.
  const events = await f.events.listEvents(readerPrincipal());
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actor.principalId, 'worker:assignment-1');
  assert.equal(events[0]!.actor.kind, 'agent');
  assert.equal(events[0]!.payload.message, 'synthetic observation');
  assert.equal(events[0]!.scope, 'local-owner');
  const receipts = toolResultTexts(f.fake, result.sessionId);
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(receipts[0]!);
  assert.equal(receipt.status, 'accepted');
  // The trusted post-acceptance hook observed exactly the durable receipt.
  assert.equal(f.published.length, 1);
  assert.deepEqual(f.published[0], { eventId: receipt.eventId, sequence: receipt.sequence, status: 'accepted' });
  assert.equal(receipt.meaning.includes('not task completion'), true);
  assert.equal((await f.events.stats(readerPrincipal())).events, 1);
});

test('worker event type discovery reports payload rules, scope and that no wake/subscription exists', async t => {
  const f = await fixture(t);
  f.fake.toolCall('shiyu_worker_event_types', {});
  const result = await f.driver.run(workerRequest().input);
  const texts = toolResultTexts(f.fake, result.sessionId);
  assert.equal(texts.length, 1);
  const discovery = JSON.parse(texts[0]!);
  assert.equal(discovery.scope, 'local-owner');
  assert.equal(discovery.subscribeSupported, false);
  assert.equal(discovery.wakeSupported, false);
  assert.deepEqual(discovery.canPublish.sort(), [...WORKER_EVENT_PUBLISH_TYPES].sort());
  const observation = discovery.types.find((type: any) => type.type === 'agent.observation.reported');
  assert.equal(observation.canPublish, true);
  assert.equal(observation.schemaVersion, 1);
  assert.deepEqual(observation.requiredFields, ['message']);
  assert.ok(observation.filterableFields.includes('sourceRef'));
  assert.equal(observation.payloadFields.sourceRef, 'string');
  assert.equal(discovery.types.some((type: any) => type.type === 'task.succeeded'), false);
});

test('mounted worker tools cannot forge authority facts, out-of-scope types or reserved success events', async t => {
  for (const [name, args, expected] of [
    ['shiyu_worker_event_report', { ...reportArgs('forged-success'), type: 'task.succeeded', payload: { taskId: 'task-1' } }, /Reserved outcome/],
    ['shiyu_worker_event_report', { ...reportArgs('forged-receipt'), type: 'worker.verification.receipt', payload: { ok: true } }, /cannot publish that event type/],
    ['shiyu_worker_event_report', { ...reportArgs('authority-args'), scope: 'private', payload: { message: 'x' } }, /authority/],
    ['shiyu_worker_event_report', { ...reportArgs('owner-args'), permit: { fencingToken: 9 } }, /authority/],
    ['shiyu_worker_event_report', { ...reportArgs('actor-args'), actor: { principalId: 'task-service', kind: 'component' } }, /authority/],
    ['shiyu_worker_event_types', { scope: 'private' }, /authority|Unexpected field/],
    ['shell', {}, /registered controlled tools|blocked/],
  ] as const) {
    const f = await fixture(t);
    f.fake.toolCall(name, args as Record<string, unknown>);
    await assert.rejects(f.driver.run(workerRequest().input), expected, `expected rejection for ${name} ${JSON.stringify(args)}`);
    assert.equal((await f.events.stats(readerPrincipal())).events, 0);
  }
});

test('a trusted principal resolver that fails or over-grants is rejected closed', async t => {
  const cases: ((context: any) => EventPrincipal | undefined)[] = [
    () => undefined,
    context => ({ ...workerPrincipal(context), kind: 'component' }),
    context => ({ ...workerPrincipal(context), scopes: ['local-owner', 'private'] }),
    context => ({ ...workerPrincipal(context), subscribeTypes: ['agent.observation.reported'] }),
    context => ({ ...workerPrincipal(context), publishTypes: ['task.succeeded'] }),
  ];
  for (const resolve of cases) {
    const stored = await eventStore(t, []);
    const fake = fakeWorkerHost();
    const driver = new WorkerSessionDriver({ ctx: fake.ctx, createUserMessage: fake.factory,
      eventTools: { tools: () => createWorkerEventTools({ service: stored.events, resolvePrincipal: resolve }) } });
    try {
      fake.toolCall('shiyu_worker_event_report', reportArgs());
      await assert.rejects(driver.run(workerRequest().input), /FORBIDDEN|authority|worker event|unavailable|granted/);
      assert.equal((await stored.events.stats(readerPrincipal())).events, 0);
    } finally { await driver.close(); }
  }
});

test('event tools share the three-tool worker budget and cannot displace the controlled task tool', async t => {
  const f = await fixture(t);
  let controlledCalls = 0;
  const controlled = { name: 'shiyu_worker_write_note', description: 'Synthetic controlled tool.',
    parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
    execute: async () => { controlledCalls++; return { accepted: true }; } };
  const second = { ...controlled, name: 'shiyu_worker_read' };
  // Two task tools + two event tools = 4 > the fixed worker ceiling.
  await assert.rejects(f.driver.run(workerRequest('local-owner', { tools: [controlled, second] }).input), /At most three controlled worker tools/);
  assert.equal(f.fake.counts().creates, 0);
  assert.equal(controlledCalls, 0);
  // One task tool + two event tools fit and remain the complete mounted set.
  f.fake.toolCall('shiyu_worker_write_note', { content: 'x' });
  const result = await f.driver.run(workerRequest('local-owner', { tools: [controlled] }).input);
  assert.equal(result.verified, false);
  assert.equal(controlledCalls, 1);
  assert.deepEqual(f.fake.assemblies[0].tools.map((tool: any) => tool.name).sort(), ['shiyu_worker_event_report', 'shiyu_worker_event_types', 'shiyu_worker_write_note']);
});

test('a worker retry with the same idempotency key preserves one accepted event and one delivery', async t => {
  const f = await fixture(t);
  f.fake.toolCall('shiyu_worker_event_report', reportArgs('stable-key'));
  const first = await f.driver.run(workerRequest().input);
  const successes = toolResultTexts(f.fake, first.sessionId).map(text => JSON.parse(text));
  assert.equal(successes[0].status, 'accepted');
  // Same Assignment Session is resumed for a second controlled run.
  f.fake.toolCall('shiyu_worker_event_report', reportArgs('stable-key'));
  await f.driver.run(workerRequest().input);
  const events = await f.events.listEvents(readerPrincipal());
  assert.equal(events.length, 1, 'the stable idempotency key must not create a second accepted event');
  const receipts = toolResultTexts(f.fake, first.sessionId).map(text => JSON.parse(text));
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].eventId, receipts[1].eventId);
  assert.equal(receipts[1].status, 'duplicate');
  // A genuinely new logical report still becomes its own event.
  f.fake.toolCall('shiyu_worker_event_report', reportArgs('different-key'));
  await f.driver.run(workerRequest().input);
  assert.equal((await f.events.listEvents(readerPrincipal())).length, 2);
});

test('worker attachments fail closed: swapped sources, no source, revoked permit and disposed driver', async t => {
  const stored = await eventStore(t, []);
  const fake = fakeWorkerHost();
  const driver = new WorkerSessionDriver({ ctx: fake.ctx, createUserMessage: fake.factory });
  // No event source: the worker stays event-free and the host tool remains denied.
  const withoutEvents = await driver.run(workerRequest().input);
  assert.equal(withoutEvents.verified, false);
  assert.deepEqual(fake.assemblies[0].tools, []);
  const eventTools = createWorkerEventTools({ service: stored.events, resolvePrincipal: context => workerPrincipal(context) });
  driver.attachEventTools({ tools: () => eventTools });
  assert.throws(() => driver.attachEventTools({ tools: () => eventTools }), /different worker event tool source/);
  // Event tool calls stay behind the existing Assignment permit gate.
  const identity = workerRequest().identity;
  const revoked = workerRequest();
  revoked.input.permit.check = () => ({ allowed: false });
  fake.toolCall('shiyu_worker_event_report', reportArgs());
  await assert.rejects(driver.run(revoked.input), /permit revoked/);
  assert.equal((await stored.events.stats(readerPrincipal())).events, 0);
  await driver.close();
  await assert.rejects(driver.run(workerRequest().input), /closed/);
  assert.equal(identity.fencingToken, 1);
});

test('event tool inputs stay bounded and payload schema violations never reach durable acceptance', async t => {
  const f = await fixture(t);
  for (const args of [
    { type: 'agent.observation.reported', payload: { message: 42 }, idempotencyKey: 'bad-payload' },
    { type: 'agent.observation.reported', payload: { message: 'x'.repeat(8193) }, idempotencyKey: 'oversized' },
    { type: 'agent.observation.reported', payload: { message: 'x' }, idempotencyKey: '' },
  ]) {
    f.fake.toolCall('shiyu_worker_event_report', args);
    await assert.rejects(f.driver.run(workerRequest().input), /INVALID|payload|Invalid|tool|bounded|idempotency/);
    assert.equal((await f.events.stats(readerPrincipal())).events, 0);
  }
});

test('a worker event source cannot run a second delivery loop or bypass the coordinator store', async t => {
  // The tool only publishes; it never claims, acks, subscribes or wakes.
  const base = await mkdtemp(join(tmpdir(), 'shiyu-events-worker-api-'));
  const store = await ControlStore.open({ filename: join(base, 'control.sqlite'), eventTypes: SHIYU_EVENT_TYPES,
    componentHandlers: ['shiyu.test.handler-a'] });
  try {
    const events = new EventService(store);
    const f = fakeWorkerHost();
    const driver = new WorkerSessionDriver({ ctx: f.ctx, createUserMessage: f.factory,
      eventTools: { tools: () => createWorkerEventTools({ service: events, resolvePrincipal: context => workerPrincipal(context) }) } });
    f.toolCall('shiyu_worker_event_report', { type: 'worker.result.reported', payload: { taskId: 'task-1', message: 'reported' }, idempotencyKey: 'result-1' });
    await driver.run(workerRequest().input);
    assert.equal((await events.stats(readerPrincipal())).events, 1);
    assert.equal((await events.stats(readerPrincipal())).subscriptions, 0);
    assert.equal((await events.stats(readerPrincipal())).pending, 0);
    await driver.close();
  } finally { await store.close(); await rm(base, { recursive: true, force: true }); }
});

test('per-Assignment grant policy decides whether and which event tools are mounted, without global opening', async t => {
  const f = await fixture(t);
  const host = fakeWorkerHost();
  const grants: any[] = [];
  const driver = new WorkerSessionDriver({ ctx: host.ctx, createUserMessage: host.factory,
    eventTools: createWorkerEventToolSource({ service: f.events, grant(input) {
      grants.push(input);
      return { principalId: `worker:${input.binding.assignmentId}`, scope: input.binding.scope, publishTypes: ['worker.result.reported'] };
    } }) });
  try {
    host.toolCall('shiyu_worker_event_report', { type: 'worker.result.reported',
      payload: { taskId: 'task-1', message: 'granted report' }, idempotencyKey: 'grant-1' });
    const result = await driver.run(workerRequest().input);
    assert.equal(result.verified, false);
    assert.deepEqual(grants[0].binding, { taskId: 'task-1', assignmentId: 'assignment-1', scope: 'local-owner', sessionId: result.sessionId });
    assert.deepEqual(host.assemblies[0].tools.map((tool: any) => tool.name), [...WORKER_EVENT_TOOL_NAMES]);
    // The grant only allowed worker.result.reported.
    host.toolCall('shiyu_worker_event_report', { type: 'agent.observation.reported',
      payload: { message: 'not granted' }, idempotencyKey: 'grant-2' });
    await assert.rejects(driver.run(workerRequest().input), /not granted/);
    assert.equal((await f.events.stats(readerPrincipal())).events, 1);
  } finally { await driver.close(); }
  // A grant that returns undefined leaves the Assignment event-free.
  const host2 = fakeWorkerHost();
  const driver2 = new WorkerSessionDriver({ ctx: host2.ctx, createUserMessage: host2.factory,
    eventTools: createWorkerEventToolSource({ service: f.events, grant: () => undefined }) });
  try {
    const result = await driver2.run(workerRequest().input);
    assert.equal(result.verified, false);
    assert.deepEqual(host2.assemblies[0].tools, []);
  } finally { await driver2.close(); }
  // A grant that tries to widen the Assignment scope is rejected before native creation.
  const host3 = fakeWorkerHost();
  const driver3 = new WorkerSessionDriver({ ctx: host3.ctx, createUserMessage: host3.factory,
    eventTools: createWorkerEventToolSource({ service: f.events,
      grant: input => ({ principalId: 'worker:x', scope: 'private-scope', publishTypes: ['agent.observation.reported'] }) }) });
  try {
    await assert.rejects(driver3.run(workerRequest().input), /invalid or outside the Assignment scope/);
    assert.equal(host3.counts().creates, 0);
  } finally { await driver3.close(); }
});
