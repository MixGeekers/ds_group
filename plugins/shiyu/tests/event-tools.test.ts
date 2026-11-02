import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { EventService } from '../src/control/events/index.js';
import { SHIYU_EVENT_TYPES, type EventPrincipal } from '../src/contracts/events.js';
import { EVENT_TOOL_NAMES, installEventTools, type EventToolContext, type EventToolDefinition, type EventToolExecution, type EventToolResult } from '../src/adapters/dsh/event-tools.js';

const eventType = 'agent.observation.reported';
const actor: EventPrincipal = { principalId: 'managed-core', kind: 'agent', scopes: ['team-a'],
  publishTypes: SHIYU_EVENT_TYPES.map(item => item.type), subscribeTypes: SHIYU_EVENT_TYPES.map(item => item.type), targetRefs: ['binding-a', 'notes.handler'] };
const trustedAgent = Object.freeze({ id: 'host-agent-a' });
const exec: EventToolExecution = { agent: trustedAgent, signal: new AbortController().signal };
function success(result: EventToolResult): Record<string, any> { assert.equal(result.ok, true, JSON.stringify(result)); return (result as Extract<EventToolResult, { ok: true }>).value; }
function code(result: EventToolResult, expected: string) { assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, expected); }
function registry() {
  const definitions = new Map<string, EventToolDefinition>();
  let registrations = 0, removals = 0, failAt = Infinity;
  const ctx: EventToolContext = { tools: { register(tool) {
    registrations++;
    if (registrations === failAt) throw new Error('registration failed');
    assert.equal(definitions.has(tool.name), false);
    definitions.set(tool.name, tool);
    return () => { removals++; definitions.delete(tool.name); };
  } } };
  return { ctx, definitions, counts: () => ({ registrations, removals }), failAt(value: number) { failAt = value; } };
}
async function fixture(t: TestContext) {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), '../.local/event-tools-tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'run-'));
  const store = await ControlStore.open({ filename: join(directory, 'control.sqlite'), eventTypes: SHIYU_EVENT_TYPES, componentHandlers: ['notes.handler'] });
  const service = new EventService(store), fake = registry();
  let current: EventPrincipal | undefined = structuredClone(actor), resolves = 0;
  const resolver = (execution: EventToolExecution) => { resolves++; return execution.agent === trustedAgent ? current : undefined; };
  const dispose = installEventTools(fake.ctx, service, resolver);
  const invoke = (name: string, args: unknown = {}, execution: EventToolExecution | undefined = exec) => fake.definitions.get(`shiyu_event_${name}`)!.execute(args, execution);
  t.after(async () => { dispose(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, service, fake, resolver, dispose, invoke, setPrincipal(value?: EventPrincipal) { current = value; }, resolveCount: () => resolves };
}
const publication = (key = 'event-1') => ({ type: eventType, scope: 'team-a', payload: { message: 'Synthetic observation', sourceRef: 'source-a' }, idempotencyKey: key });
const subscription = (id = 'sub-1') => ({ id, types: [eventType], scope: 'team-a', target: { kind: 'agent', bindingId: 'binding-a' }, deliveryMode: 'background', start: { kind: 'from_now' } });

test('event tool registration uses the real DSH schema/render shape, rolls back failures and is idempotent per Session', async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.fake.definitions.keys()], [...EVENT_TOOL_NAMES]);
  const supported = new Set(['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf']);
  const inspect = (schema: any): void => {
    for (const key of Object.keys(schema)) assert.ok(supported.has(key), `Unsupported DSH schema keyword ${key}`);
    if (schema.properties) for (const property of Object.values(schema.properties)) inspect(property);
    if (schema.items) inspect(schema.items);
    if (schema.oneOf) for (const alternative of schema.oneOf) inspect(alternative);
    if ('additionalProperties' in schema) assert.equal(typeof schema.additionalProperties, 'boolean');
    if ('const' in schema) assert.ok(schema.type || schema.oneOf, 'DSH requires const to declare a type or oneOf');
  };
  for (const tool of f.fake.definitions.values()) {
    inspect(tool.parameters); inspect(tool.output.schema);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(typeof tool.description, 'string');
    const rendered = tool.output.render({}, { ok: false, operation: tool.name, error: { code: 'FORBIDDEN', message: 'denied', nextAction: 'check grant' } });
    assert.equal(rendered[0]?.type, 'text'); assert.equal(JSON.parse(rendered[0]!.text).error.code, 'FORBIDDEN');
  }
  assert.equal(installEventTools(f.fake.ctx, f.service, f.resolver), f.dispose);
  assert.equal(f.fake.counts().registrations, 7);
  assert.throws(() => installEventTools(f.fake.ctx, f.service, () => actor), /different trusted binding/);
  const failed = registry(); failed.failAt(4);
  assert.throws(() => installEventTools(failed.ctx, f.service, f.resolver), /registration failed/);
  assert.equal(failed.definitions.size, 0); assert.equal(failed.counts().removals, 3);
});

test('every call resolves trusted context and missing or forged identity fails closed', async t => {
  const f = await fixture(t);
  const publish = f.fake.definitions.get('shiyu_event_publish')!;
  code(await publish.execute(publication()), 'FORBIDDEN');
  code(await f.invoke('publish', publication(), { agent: { id: 'host-agent-a' } }), 'FORBIDDEN');
  code(await f.invoke('publish', { ...publication(), principal: { ...actor, principalId: 'task-service', kind: 'component' } }), 'INVALID_INPUT');
  code(await f.invoke('publish', { ...publication(), scope: 'private-team' }), 'FORBIDDEN');
  success(await f.invoke('publish', publication()));
  f.setPrincipal(undefined);
  code(await f.invoke('publish', publication('after-revocation')), 'FORBIDDEN');
  code(await f.invoke('status'), 'FORBIDDEN');
  assert.equal((await f.service.stats(actor)).events, 1);
  assert.equal((await f.service.listEvents(actor))[0]!.actor.principalId, actor.principalId);
  assert.ok(f.resolveCount() >= 6);
});

test('types expose usable payload rules while reserved task completion cannot be model-published', async t => {
  const f = await fixture(t);
  const types = success(await f.invoke('types'));
  const reserved = types.items.find((item: any) => item.type === 'task.succeeded');
  assert.equal(reserved.canPublish, false); assert.equal(reserved.canSubscribe, true);
  assert.equal(types.wakeSupported, false);
  code(await f.invoke('publish', { ...publication('unknown'), type: 'unknown.type' }), 'UNKNOWN_TYPE');
  code(await f.invoke('publish', { ...publication('invalid-payload'), payload: { message: 12 } }), 'INVALID_PAYLOAD');
  code(await f.invoke('publish', { ...publication('reserved'), type: 'task.succeeded', payload: { taskId: 'task-1' } }), 'FORBIDDEN');
  // Even an accidentally overbroad trusted resolver cannot turn model tool arguments into a TaskService commit.
  f.setPrincipal({ ...actor, kind: 'component', principalId: 'task-service' });
  code(await f.invoke('publish', { ...publication('reserved-component'), type: 'task.succeeded', payload: { taskId: 'task-1' } }), 'FORBIDDEN');
  assert.equal((await f.service.stats(actor)).events, 0);
});

test('stable publish/subscribe identities deduplicate reentry and background remains pending without a model wake', async t => {
  const f = await fixture(t);
  const sub = success(await f.invoke('subscribe', subscription()));
  const subAgain = success(await f.invoke('subscribe', subscription()));
  assert.equal(sub.id, subAgain.id); assert.equal(sub.revision, subAgain.revision);
  const [first, second] = await Promise.all([f.invoke('publish', publication()), f.invoke('publish', publication())]);
  assert.equal(success(first).eventId, success(second).eventId);
  assert.deepEqual([success(first).status, success(second).status].sort(), ['accepted', 'duplicate']);
  const status = success(await f.invoke('status', { subscriptionId: sub.id }));
  assert.equal(status.counts.events, 1); assert.equal(status.counts.subscriptions, 1); assert.equal(status.counts.pending, 1);
  assert.equal(status.items[0].status, 'pending'); assert.equal(status.items[0].deliveryMode, 'background');
  const component: EventPrincipal = { ...actor, principalId: 'component-reader', kind: 'component' };
  assert.deepEqual(await f.service.claim(component, { consumerId: 'component-loop', deliveryMode: 'component' }), []);
  assert.equal((await f.service.listDeliveries(actor))[0]!.attempts, 0);
  code(await f.invoke('subscribe', { ...subscription(), once: true }), 'IDEMPOTENCY_CONFLICT');
  code(await f.invoke('publish', { ...publication(), payload: { message: 'different' } }), 'IDEMPOTENCY_CONFLICT');
});

test('only granted registered targets are allowed; wake, arbitrary callbacks and patch authority are rejected', async t => {
  const f = await fixture(t);
  code(await f.invoke('subscribe', { ...subscription(), deliveryMode: 'wake' }), 'UNSUPPORTED');
  code(await f.invoke('subscribe', { ...subscription(), target: { kind: 'agent', bindingId: 'other-session' } }), 'FORBIDDEN');
  code(await f.invoke('subscribe', { ...subscription(), callback: 'https://example.invalid/execute' }), 'INVALID_INPUT');
  code(await f.invoke('subscribe', { ...subscription(), target: { kind: 'component', handlerRef: 'https://example.invalid/execute' }, deliveryMode: 'component' }), 'FORBIDDEN');
  f.setPrincipal({ ...actor, targetRefs: [...actor.targetRefs, 'unregistered.handler'] });
  code(await f.invoke('subscribe', { ...subscription(), target: { kind: 'component', handlerRef: 'unregistered.handler' }, deliveryMode: 'component' }), 'FORBIDDEN');
  success(await f.invoke('subscribe', { ...subscription(), target: { kind: 'component', handlerRef: 'notes.handler' }, deliveryMode: 'component' }));
  code(await f.invoke('update', { id: 'sub-1', expectedRevision: 1, patch: { scope: 'private-team' } }), 'INVALID_INPUT');
  code(await f.invoke('update', { id: 'sub-1', expectedRevision: 1, patch: { target: { kind: 'agent', bindingId: 'other' } } }), 'INVALID_INPUT');
});

test('update and unsubscribe use current revision and ownership, and changed grants take effect immediately', async t => {
  const f = await fixture(t);
  success(await f.invoke('subscribe', subscription()));
  const paused = success(await f.invoke('update', { id: 'sub-1', expectedRevision: 1, patch: { status: 'paused' } }));
  assert.equal(paused.status, 'paused'); assert.equal(paused.revision, 2);
  code(await f.invoke('update', { id: 'sub-1', expectedRevision: 1, patch: { status: 'active' } }), 'REVISION_CONFLICT');
  f.setPrincipal({ ...actor, principalId: 'other-agent' });
  assert.deepEqual(success(await f.invoke('list')).items, []);
  code(await f.invoke('unsubscribe', { id: 'sub-1', expectedRevision: 2 }), 'NOT_FOUND');
  f.setPrincipal({ ...actor, scopes: ['private-team'] });
  assert.deepEqual(success(await f.invoke('list')).items, []);
  code(await f.invoke('update', { id: 'sub-1', expectedRevision: 2, patch: { status: 'active' } }), 'FORBIDDEN');
  f.setPrincipal(actor);
  assert.equal(success(await f.invoke('unsubscribe', { id: 'sub-1', expectedRevision: 2 })).status, 'retired');
});

test('tool inputs and outputs are bounded and replay omissions remain explicit', async t => {
  const f = await fixture(t);
  code(await f.invoke('publish', { ...publication(), payload: { message: 'x'.repeat(8193) } }), 'INVALID_INPUT');
  code(await f.invoke('list', { limit: 1000 }), 'INVALID_INPUT');
  code(await f.invoke('subscribe', { ...subscription(), start: { kind: 'replay', afterSequence: 0, limit: 101 } }), 'INVALID_INPUT');
  await f.invoke('publish', publication('old-1')); await f.invoke('publish', publication('old-2'));
  const sub = success(await f.invoke('subscribe', { ...subscription(), start: { kind: 'replay', afterSequence: 0, limit: 1 } }));
  assert.equal(sub.replayedCount, 1); assert.equal(sub.replayTruncated, true);
  for (let i = 0; i < 3; i++) success(await f.invoke('subscribe', subscription(`sub-extra-${i}`)));
  const first = success(await f.invoke('list', { limit: 2 }));
  assert.equal(first.items.length, 2); assert.equal(first.nextOffset, 2); assert.equal(first.truncated, true);
  const second = success(await f.invoke('list', { offset: first.nextOffset, limit: 2 }));
  assert.equal(second.items.length, 2); assert.equal(second.nextOffset, null);
  const tool = f.fake.definitions.get('shiyu_event_list')!;
  const result = await f.invoke('list');
  assert.ok(Buffer.byteLength(tool.output.render({}, result)[0]!.text) <= 16384);
  const oversized: EventToolResult = { ok: true, operation: tool.name, value: { text: 'x'.repeat(20000) } };
  assert.ok(Buffer.byteLength(tool.output.render({}, oversized)[0]!.text) <= 16384);
});

test('disposed tools reject captured executions, cancellation stops dispatch and failed resolver messages do not leak', async t => {
  const f = await fixture(t);
  const publish = f.fake.definitions.get('shiyu_event_publish')!;
  const cancelled = new AbortController(); cancelled.abort();
  code(await f.invoke('publish', publication(), { agent: trustedAgent, signal: cancelled.signal }), 'CANCELLED');
  f.dispose(); f.dispose();
  assert.equal(f.fake.definitions.size, 0); assert.equal(f.fake.counts().removals, 7);
  code(await publish.execute(publication(), exec), 'TOOL_INACTIVE');
  const fake = registry();
  const remove = installEventTools(fake.ctx, f.service, () => { throw new Error('private session details'); });
  const result = await fake.definitions.get('shiyu_event_status')!.execute({}, exec);
  code(result, 'FORBIDDEN'); assert.equal(JSON.stringify(result).includes('private session details'), false);
  remove(); assert.equal((await f.service.stats(actor)).events, 0);
});

test('large preexisting subscription rules keep a bounded and explicit mutation receipt', async t => {
  const f = await fixture(t);
  await f.service.subscribe(actor, { id: 'large-existing', types: [eventType], scope: 'team-a', target: { kind: 'agent', bindingId: 'binding-a' },
    deliveryMode: 'background', start: { kind: 'from_now' }, filter: { sourceRef: 'x'.repeat(20000) } });
  const result = success(await f.invoke('update', { id: 'large-existing', expectedRevision: 1, patch: { status: 'paused' } }));
  assert.equal(result.status, 'paused'); assert.equal(result.revision, 2);
  assert.equal(result.projectionTruncated, true); assert.equal(result.filter, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 9000);
});
