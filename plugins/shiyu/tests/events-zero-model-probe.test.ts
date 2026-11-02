import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerSessionDriver, WORKER_PRESET_ID, WORKER_PROBE_SESSION_PREFIX, WORKER_PROBE_TASK_TOOL } from '../src/adapters/dsh/workers.js';
import { createWorkerEventToolSource, WORKER_EVENT_TOOL_NAMES } from '../src/adapters/dsh/event-tools.js';
import { eventStore, fakeWorkerHost, workerRequest, readerPrincipal } from './events-fixtures.js';

const PROBE_CWD = '/tmp/shiyu-worker-event-probe';

function sourceFor(events: any) {
  return createWorkerEventToolSource({ service: events, grant: ({ binding }) => ({
    principalId: `worker:${binding.assignmentId}`, scope: binding.scope,
    publishTypes: ['agent.observation.reported', 'worker.result.reported'],
  }) });
}

async function fixture(t: import('node:test').TestContext, options: { eventTools?: boolean } = {}) {
  const stored = await eventStore(t, []);
  const fake = fakeWorkerHost();
  const source = sourceFor(stored.events);
  const driver = new WorkerSessionDriver({ ctx: fake.ctx, createUserMessage: fake.factory,
    ...(options.eventTools === false ? {} : { eventTools: source }) });
  t.after(async () => { await driver.close().catch(() => undefined); });
  return { ...stored, fake, driver, source };
}

test('zero-model probe assembles exactly the restricted task slot plus the two event tools and releases without inference', async t => {
  const f = await fixture(t);
  const result = await f.driver.probeEventTools({ cwd: PROBE_CWD });
  assert.equal(result.ok, true);
  assert.equal(result.preset, WORKER_PRESET_ID);
  assert.ok(result.probeSessionId.startsWith(WORKER_PROBE_SESSION_PREFIX));
  assert.deepEqual(result.assignmentTools, [WORKER_PROBE_TASK_TOOL]);
  assert.deepEqual(result.eventTools, [...WORKER_EVENT_TOOL_NAMES]);
  assert.deepEqual(result.tools.map(tool => tool.name), [WORKER_PROBE_TASK_TOOL, ...WORKER_EVENT_TOOL_NAMES]);
  assert.deepEqual(result.tools.map(tool => tool.source), ['assignment', 'event', 'event']);
  // Only trusted injected schemas: no host tool (shell/read_file/network/run_code) survives.
  assert.deepEqual(result.tools.map(tool => tool.name).filter(name => (result.hostTools as string[]).includes(name)), []);
  assert.ok(result.hostTools.includes('shell') && result.hostTools.includes('network'));
  for (const tool of result.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 20, 'description must come from the controlled tool declaration');
    assert.equal(tool.parameters.additionalProperties, false);
  }
  // Authority fields cannot appear anywhere the model could fill them in.
  assert.deepEqual(result.authorityFields, []);
  const scan = (value: any, found = new Set<string>()): Set<string> => {
    const forbidden = ['actor', 'permit', 'scope', 'taskId', 'assignmentId', 'principalId', 'authorization', 'ownerId'];
    if (!value || typeof value !== 'object') return found;
    if (Array.isArray(value)) { for (const item of value) scan(item, found); return found; }
    for (const [key, item] of Object.entries(value.properties ?? {})) { if (forbidden.includes(key)) found.add(key); scan(item, found); }
    for (const key of ['items', 'additionalProperties', 'oneOf']) if (value[key] !== undefined) scan(value[key], found);
    return found;
  };
  for (const tool of result.tools) assert.deepEqual([...scan(tool.parameters)], []);
  // No inference, tool execution or business state was produced.
  assert.deepEqual(result.counters, { modelRequests: 0, modelStreams: 0, assistantMessages: 0, userMessages: 0, toolEvents: 0, usageEvents: 0 });
  assert.equal(result.released, true);
  assert.equal(result.disposed, true);
  assert.equal(f.fake.counts().followups, 0);
  assert.deepEqual(f.fake.requests, []);
  assert.equal(f.fake.counts().creates, 1);
  assert.equal(f.fake.counts().disposals, 1);
  assert.equal(result.scope, 'local-owner');
  // The probe Session carries only creation/release plumbing and no model events.
  const events = f.fake.persisted.get(result.probeSessionId)?.events ?? [];
  assert.equal(events.filter(event => event.type === 'user/message' || event.type === 'assistant/message'
    || event.type.startsWith('tool/') || event.type === 'agent/request').length, 0);
  // No business Task/binding/event side effects: the probe never publishes.
  assert.equal((await f.events.stats(readerPrincipal())).events, 0);
  assert.equal((await f.events.stats(readerPrincipal())).subscriptions, 0);
});

test('the probe does not disturb a subsequent real restricted worker run with the same driver', async t => {
  const f = await fixture(t);
  const probe = await f.driver.probeEventTools({ cwd: PROBE_CWD });
  assert.equal(probe.ok, true);
  f.fake.toolCall('shiyu_worker_event_report', { type: 'agent.observation.reported',
    payload: { message: 'after probe', sourceRef: 'probe:after' }, idempotencyKey: 'after-probe' });
  const run = await f.driver.run(workerRequest().input);
  assert.equal(run.verified, false);
  assert.deepEqual(f.fake.assemblies[0].tools.map((tool: any) => tool.name), [...WORKER_EVENT_TOOL_NAMES]);
  assert.equal((await f.events.stats(readerPrincipal())).events, 1);
});

test('probe fails closed without an attached event source or when the trusted source is malformed', async t => {
  const withoutSource = await fixture(t, { eventTools: false });
  await assert.rejects(withoutSource.driver.probeEventTools({ cwd: PROBE_CWD }), /no trusted worker event tool source/);
  assert.equal(withoutSource.fake.counts().creates, 0);

  const stored = await eventStore(t, []);
  const fake = fakeWorkerHost();
  const cases: { source: any; expected: RegExp }[] = [
    { source: { tools: () => [] }, expected: /bounded event tool set/ },
    { source: { tools: () => [
      { name: 'shiyu_worker_event_a', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => ({}) },
      { name: 'shiyu_worker_event_b', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => ({}) },
      { name: 'shiyu_worker_event_c', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => ({}) },
    ] }, expected: /bounded event tool set/ },
    { source: { tools: () => [{ name: 'shell', description: 'host tool disguised as event tool', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => ({}) }] }, expected: /names are invalid/ },
    { source: { tools: () => [
      { name: 'shiyu_worker_event_bad', description: 'top-level authority surface', execute: () => ({}),
        parameters: { type: 'object', properties: { taskId: { type: 'string' } }, additionalProperties: false } },
    ] }, expected: /execution authority/ },
    { source: { tools: () => [
      { name: 'shiyu_worker_event_nested', description: 'nested authority surface', execute: () => ({}),
        parameters: { type: 'object', properties: { payload: { type: 'object', properties: { permit: { type: 'string' }, actor: { type: 'string' } } } }, additionalProperties: false } },
    ] }, expected: /authority fields/ },
  ];
  for (const [index, item] of cases.entries()) {
    const local = fakeWorkerHost();
    const driver = new WorkerSessionDriver({ ctx: local.ctx, createUserMessage: local.factory, eventTools: item.source });
    try {
      await assert.rejects(driver.probeEventTools({ cwd: PROBE_CWD }), item.expected, `case ${index}`);
      assert.equal(local.counts().followups, 0);
    } finally { await driver.close(); }
  }
  assert.equal((await stored.events.stats(readerPrincipal())).events, 0);
});

test('probe fails explicitly when native creation or disposal fails, and no followup is issued', async t => {
  const createFailure = await fixture(t);
  createFailure.fake.setCreateFault(new Error('Native probe creation refused'));
  await assert.rejects(createFailure.driver.probeEventTools({ cwd: PROBE_CWD }), /Native probe creation refused/);
  assert.equal(createFailure.fake.counts().followups, 0);
  assert.equal(createFailure.fake.counts().disposals, 0);

  const disposeFailure = await fixture(t);
  disposeFailure.fake.failDispose();
  await assert.rejects(disposeFailure.driver.probeEventTools({ cwd: PROBE_CWD }), /cleanup failed/);
  assert.equal(disposeFailure.fake.counts().followups, 0);

  const assemblyFailure = await fixture(t);
  assemblyFailure.fake.setSetupHook(async (_agent, helpers) => {
    await helpers.request();
  });
  await assert.rejects(assemblyFailure.driver.probeEventTools({ cwd: PROBE_CWD }), /must not issue a model request/);
  assert.equal(assemblyFailure.fake.counts().followups, 0);
});

test('a late or aborted probe handle is cancelled and disposed without assembling or dispatching', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.fake.setCreateGate(gate);
  const probing = f.driver.probeEventTools({ cwd: PROBE_CWD, signal: controller.signal });
  const rejected = assert.rejects(probing, /cancel|abort/i);
  for (let index = 0; index < 200 && f.fake.counts().attempts === 0; index++) await new Promise<void>(done => setImmediate(done));
  assert.equal(f.fake.counts().attempts, 1);
  controller.abort(new Error('probe cancelled by owner'));
  release();
  await rejected;
  assert.equal(f.fake.counts().followups, 0);
  assert.equal(f.fake.counts().disposals, 1);
  assert.equal(f.fake.requests.length, 0);
  // The driver remains usable after the cancelled probe.
  f.fake.setCreateGate(Promise.resolve());
  f.fake.toolCall('shiyu_worker_event_report', { type: 'worker.result.reported',
    payload: { taskId: 'task-1', message: 'after cancellation' }, idempotencyKey: 'probe-cancel-after' });
  const run = await f.driver.run(workerRequest().input);
  assert.equal(run.verified, false);
});

test('probe rejects model-facing events emitted during creation instead of claiming a silent mount', async t => {
  const f = await fixture(t);
  f.fake.setSetupHook(async (_agent, helpers) => {
    await helpers.emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'not allowed' }] }, usage: { inputTokens: 1, outputTokens: 1 } } });
  });
  await assert.rejects(f.driver.probeEventTools({ cwd: PROBE_CWD }), /model activity|assistant/);
  assert.equal(f.fake.counts().followups, 0);
});
