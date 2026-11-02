import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerSessionDriver, WORKER_PRESET_ID } from '../src/adapters/dsh/workers.js';
import type { WorkerRunRequest, WorkerPermitContext, WorkerPermitIdentity, WorkerToolContext } from '../src/adapters/dsh/workers.js';
import type { DshAgent, DshAgentContext, DshContext, DshSession, SessionEvent } from '../src/adapters/dsh/sessions.js';

type Hook = (...args: any[]) => any;
class Hooks {
  listeners = new Map<string, Hook[]>();
  on(name: string, handler: Hook) { const list = this.listeners.get(name) ?? []; list.push(handler); this.listeners.set(name, list); return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); }; }
  async emit(name: string, ...args: any[]) { for (const handler of [...this.listeners.get(name) ?? []]) await handler(...args); }
  async waterfall(name: string, args: any[], terminal: () => Promise<any>) {
    const list = [...this.listeners.get(name) ?? []]; let index = 0;
    const next = (): Promise<any> => list[index++]?.(...args, next) ?? terminal();
    return next();
  }
}
interface FakeAgent extends DshAgent { hooks: Hooks; guards: Hook[]; registered: Map<string, any>; cancelled: boolean }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const pause = () => new Promise<void>(done => setImmediate(done));
function fakeHost() {
  const hooks = new Hooks(), live = new Map<string, FakeAgent>(), presets = new Set<string>();
  const persisted = new Map<string, { header: DshSession['header']; events: SessionEvent[] }>();
  const trace: string[] = [], requests: any[] = [], assemblies: any[] = [];
  let creates = 0, resumes = 0, disposals = 0, followups = 0, cancellations = 0;
  let steps = 1, outputTokens: number | undefined = 5, candidate: unknown = { summary: 'candidate only', evidenceRequests: ['artifact:one'] };
  let compaction: 'success' | 'failed' | undefined;
  const titles = new Map<string, { title: string; source: { kind: string } }>();
  let titleCalls = 0, titleFault: 'missing' | 'rename' | 'readback' | 'flush' | undefined, forceTitle = false;
  let createGate: Promise<void> | undefined, waitForModel = false, failDispose = false;
  let beforeStep: (() => void) | undefined, afterRequest: (() => void) | undefined, afterAssistant: (() => void) | undefined, afterDispose: (() => void) | undefined;
  let call: { name: string; args: Record<string, unknown> } | undefined, lastAgent: FakeAgent | undefined;
  const make = async (options: any, resume: boolean) => {
    if (createGate) await createGate; // Deliberately ignores signal: exercise late native creation.
    const id = resume ? options.resumeSessionId : options.sessionId;
    const stored: { header: DshSession['header']; events: SessionEvent[] } | undefined = resume ? persisted.get(id) : { header: options.meta, events: [] };
    if (!stored) throw new Error('Session not found');
    const local = new Hooks(), registered = new Map<string, any>(), guards: Hook[] = [];
    const session: DshSession = { id, header: stored.header };
    let idle = Promise.resolve(), wake: (() => void) | undefined;
    const emit = async (event: SessionEvent) => { stored.events.push(event); await local.emit('session/event', session, event); };
    const ctx = {
      on: (name: string, handler: Hook) => local.on(name, handler),
      tools: {
        schemas: () => [{ name: 'shell' }, { name: 'read_file' }, { name: 'network' }, { name: 'run_code' }, ...[...registered.values()].map(tool => ({ name: tool.name }))],
        presentAs: () => () => {}, restrict: () => () => {},
        guard(handler: Hook) { guards.push(handler); return () => { const i = guards.indexOf(handler); if (i >= 0) guards.splice(i, 1); }; },
        register(tool: any) { assert.equal(registered.has(tool.name), false); registered.set(tool.name, tool); return () => { registered.delete(tool.name); }; },
      },
      systemPrompt: {
        suppressRuntimeContext: () => () => {}, section: () => () => {},
        assemble: () => local.waterfall('system-prompt/assemble', [{}, {}], async () => ({ tools: [{ name: 'shell' }, { name: 'dynamic_future_tool' }] })),
      },
    } as DshAgentContext;
    const agent: FakeAgent = {
      id, session, ctx, hooks: local, guards, registered, status: 'idle', cancelled: false,
      followup(input) {
        followups++; trace.push('followup'); agent.status = 'running';
        idle = (async () => {
          try {
            await emit({ type: 'user/message', data: input });
            if (forceTitle || titles.get(session.id)?.source.kind !== 'user') {
              titleCalls++; await emit({ type: 'session/title-llm-request', data: { system: 'do not expose this synthetic title prompt' } });
            }
            if (compaction) {
              await emit({ type: 'compaction/start', data: { compactionId: 'compact-1' } });
              if (compaction === 'success') await emit({ type: 'compaction/summary', data: { compactionId: 'compact-1', llmStreamCall: true, usage: { inputTokens: 20, outputTokens: 7, totalTokens: 27 } } });
              await emit({ type: 'compaction/end', data: { compactionId: 'compact-1', ...(compaction === 'failed' ? { error: 'unknown summary attempt' } : {}) } });
            }
            for (let step = 0; step < steps; step++) {
              beforeStep?.();
              const decision = await local.waterfall('agent/pre-step', [{ agent }], async () => ({ kind: 'enter' }));
              if (decision.kind === 'reject') throw new Error('Step rejected');
              assemblies.push(await ctx.systemPrompt.assemble({ scope: agent }));
              const request = await local.waterfall('agent/request', [{}], async () => ({ provider: 'host-default', model: 'host-default', reasoningEffort: 'max', maxTokens: 99999 }));
              requests.push(request); afterRequest?.();
              if (waitForModel) await new Promise<void>(resolve => { wake = resolve; if (agent.cancelled) resolve(); });
              if (agent.cancelled) throw new Error('Cancelled');
              if (call) {
                const denied = guards.map(guard => guard(call)).find(Boolean); if (denied) throw new Error(String(denied));
                const tool = registered.get(call.name); if (!tool) throw new Error('No registered tool');
                await tool.execute(call.args, { signal: new AbortController().signal });
              }
              await emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: step === steps - 1 ? JSON.stringify(candidate) : 'intermediate' }] }, usage: { inputTokens: 10, ...(outputTokens === undefined ? {} : { outputTokens, totalTokens: 10 + outputTokens }) } } });
              afterAssistant?.();
            }
            await emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
          } catch { await emit({ type: 'turn/end', data: { reason: { kind: 'blocked' } } }); }
          finally { agent.status = 'idle'; }
        })();
      },
      whenIdle: () => idle,
      cancel() { agent.cancelled = true; cancellations++; wake?.(); },
    };
    lastAgent = agent;
    await options.setup(ctx, agent); await hooks.emit('agent/created', { agent });
    persisted.set(id, stored); live.set(id, agent);
    if (resume) resumes++; else creates++;
    return { agent, async dispose() { disposals++; trace.push('dispose'); agent.cancel({ kind: 'hook', reason: 'disposed' }); await idle; if (failDispose) throw new Error('Native dispose failed'); live.delete(id); afterDispose?.(); } };
  };
  const ctx: DshContext = {
    on: (name, handler) => hooks.on(name, handler),
    get(name) {
      if (name === 'agentPresets') return { async register(value: { id: string }) { if (presets.has(value.id)) throw new Error('Duplicate preset'); presets.add(value.id); return () => { presets.delete(value.id); }; } };
      if (name === 'sessionPersistence') return {};
      if (name === 'sessions') return { async flush(session: DshSession) { trace.push('flush'); assert.equal(live.get(session.id)?.session, session); return titleFault !== 'flush'; } };
      if (name === 'sessionTitle' && titleFault !== 'missing') return {
        rename(session: DshSession, title: string) {
          assert.equal(live.get(session.id)?.session, session);
          if (titleFault === 'rename') throw new Error('Title rename failed');
          trace.push('title'); const snapshot = { title, source: { kind: 'user' } }; titles.set(session.id, snapshot); return snapshot;
        },
        get(session: DshSession) { return titleFault === 'readback' ? undefined : titles.get(session.id); },
      };
      if (name === 'llm') return { async resolveCallConfig(model: any) { return { ...model }; } };
    },
    agents: { create: options => make(options, false), resume: options => make(options, true), list: () => [...live.values()] },
  };
  return {
    ctx, live, persisted, presets, trace, requests, assemblies, titles,
    titleCalls: () => titleCalls,
    failTitle(value: typeof titleFault) { titleFault = value; },
    forceTitleRequest() { forceTitle = true; },
    counts: () => ({ creates, resumes, disposals, followups, cancellations }), agent: () => lastAgent!,
    setSteps(value: number) { steps = value; }, setUsage(value: number | undefined) { outputTokens = value; },
    setCandidate(value: unknown) { candidate = value; }, setCreateGate(value: Promise<void>) { createGate = value; },
    setCompaction(value: 'success' | 'failed') { compaction = value; },
    holdModel() { waitForModel = true; }, failDispose() { failDispose = true; },
    beforeStep(hook: () => void) { beforeStep = hook; }, afterRequest(hook: () => void) { afterRequest = hook; }, afterAssistant(hook: () => void) { afterAssistant = hook; },
    afterDispose(hook: () => void) { afterDispose = hook; },
    toolCall(name: string, args: Record<string, unknown>) { call = { name, args }; },
    async uiResume(id: string) { const stored = persisted.get(id)!; if (!presets.has(stored.header.agentPreset as string)) throw new Error('Unknown agent preset'); return make({ resumeSessionId: id, setup: () => {} }, true); },
  };
}
function request(overrides: Partial<WorkerRunRequest> = {}) {
  const checks: WorkerPermitContext[] = [];
  const identity: WorkerPermitIdentity = { taskId: 'task-1', assignmentId: 'assignment-1', scope: 'local-owner', hostEpoch: 'host-1', installationGeneration: 'install-1', fencingToken: 1, leaseExpiresAt: new Date(Date.now() + 120000).toISOString() };
  const policy = { allowed: true, override: {} as Partial<WorkerPermitIdentity>, revokeAt: undefined as string | undefined };
  const input: WorkerRunRequest = {
    taskId: identity.taskId, assignmentId: identity.assignmentId, scope: identity.scope, cwd: '/tmp/shiyu-worker-test', prompt: 'Return a candidate only.',
    permit: { ...identity, check: context => { checks.push(context); if (policy.revokeAt === context.phase) policy.allowed = false; return policy.allowed ? { allowed: true, ...identity, ...policy.override } : { allowed: false }; } },
    onBound: async () => {}, ...overrides,
  };
  return { input, policy, checks, identity };
}

test('zero-tool native worker returns an unverified candidate after durable binding and release', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }), r = request();
  r.input.onBound = async binding => { assert.equal(fake.counts().followups, 0); fake.trace.push('bound'); assert.equal(binding.assignmentId, r.input.assignmentId); };
  const result = await driver.run(r.input);
  assert.equal(result.verified, false); assert.equal(result.candidate.summary, 'candidate only');
  assert.deepEqual(fake.trace, ['bound', 'title', 'flush', 'followup', 'dispose']); assert.deepEqual(fake.assemblies[0].tools, []);
  assert.deepEqual(fake.requests[0], { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high', maxTokens: 4096 });
  assert.equal(result.usage.outputTokens, 5); assert.equal(result.usage.cacheReadTokens, undefined);
  assert.equal(fake.live.size, 0); assert.equal(result.steps, 1);
  assert.equal(result.modelCalls, 1);
  assert.equal(fake.persisted.get(result.sessionId)?.header.agentPreset, WORKER_PRESET_ID);
  await assert.rejects(fake.uiResume(result.sessionId), /resumed by Shiyu/);
  await driver.close(); await assert.rejects(fake.uiResume(result.sessionId), /Unknown agent preset/);
});

test('native compaction success or failure makes calls unknown instead of reusing the step count', async () => {
  for (const mode of ['success', 'failed'] as const) {
    const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }); fake.setCompaction(mode);
    const result = await driver.run(request().input);
    assert.equal(result.steps, 1); assert.equal(result.modelCalls, null);
    assert.deepEqual(result.usage, { status: 'unknown', inputTokens: mode === 'success' ? 30 : 10, outputTokens: mode === 'success' ? 12 : 5, totalTokens: mode === 'success' ? 42 : 15 }); assert.equal(fake.requests.length, 1);
    assert.ok(result.nativeObservations.some(event => event.type === 'compaction/start'));
    await driver.close();
  }
});

test('managed title is durably pinned before every dispatch and suppresses both new and resumed automatic titles', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }), r = request();
  const first = await driver.run(r.input);
  assert.equal(fake.titleCalls(), 0);
  assert.ok(fake.trace.indexOf('title') < fake.trace.indexOf('flush'));
  assert.ok(fake.trace.indexOf('flush') < fake.trace.indexOf('followup'));
  fake.titles.set(first.sessionId, { title: 'owner explicitly refreshed', source: { kind: 'provider' } });
  await driver.run(r.input);
  assert.equal(fake.titleCalls(), 0); assert.equal(fake.titles.get(first.sessionId)?.source.kind, 'user');
  await driver.close();
});

test('missing title service, failed rename/readback or failed flush prevents any worker followup', async () => {
  for (const fault of ['missing', 'rename', 'readback', 'flush'] as const) {
    const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }); fake.failTitle(fault);
    await assert.rejects(driver.run(request().input), /[Tt]itle/);
    assert.equal(fake.counts().followups, 0); assert.equal(fake.requests.length, 0); assert.equal(fake.live.size, 0);
    await driver.close();
  }
});

test('unexpected auxiliary title event keeps calls and total accounting unresolved without losing main usage', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }); fake.forceTitleRequest();
  const result = await driver.run(request().input);
  assert.equal(result.modelCalls, null);
  assert.deepEqual(result.usage, { status: 'unknown', inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.deepEqual(result.nativeObservations, [
    { type: 'session/title-llm-request' },
    { type: 'assistant/message', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  ]);
  assert.equal(JSON.stringify(result.nativeObservations).includes('prompt'), false);
  await driver.close();
});

test('one Assignment reuses native history; a new driver can resume only the bound identity', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }), r = request();
  const first = await driver.run(r.input), second = await driver.run(r.input);
  assert.equal(first.sessionId, second.sessionId); assert.equal(fake.counts().creates, 1); assert.equal(fake.counts().resumes, 1);
  await driver.close();
  const resumed = new WorkerSessionDriver({ ctx: fake.ctx });
  await assert.rejects(resumed.run({ ...r.input, scope: 'other-scope', sessionId: first.sessionId }), /does not belong/);
  const third = await resumed.run({ ...r.input, sessionId: first.sessionId });
  assert.equal(third.sessionId, first.sessionId); assert.equal(fake.counts().resumes, 2);
  assert.equal(fake.persisted.get(first.sessionId)?.events.filter(event => event.type === 'user/message').length, 3);
  await resumed.close();
});

test('controlled tool schemas hide host capabilities and receive only trusted binding authority', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }), r = request();
  let called = 0, received!: WorkerToolContext;
  r.input.tools = [{ name: 'shiyu_worker_read', description: 'Read a synthetic artifact.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
    async execute(args, context) { called++; received = context; assert.deepEqual(args, { ref: 'artifact:one' }); await context.assertPermit(); return { value: 'synthetic' }; } }];
  fake.toolCall('shiyu_worker_read', { ref: 'artifact:one' });
  const result = await driver.run(r.input);
  assert.equal(called, 1); assert.equal(received.assignmentId, r.input.assignmentId); assert.equal(received.sessionId, result.sessionId);
  assert.equal(received.permit.fencingToken, 1); assert.equal(received.signal.aborted, true);
  await assert.rejects(received.assertPermit(), /settled|released/);
  assert.deepEqual(fake.assemblies[0].tools.map((tool: any) => tool.name), ['shiyu_worker_read']);
  assert.equal(fake.assemblies[0].tools[0].parameters.additionalProperties, false);
  assert.ok(r.checks.some(check => check.phase === 'tool' && check.toolName === 'shiyu_worker_read'));
  await driver.close();
});

test('host and future tool names remain denied by the execution guard', async () => {
  for (const name of ['shell', 'run_code', 'dynamic_future_tool']) {
    const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }); fake.toolCall(name, {});
    await assert.rejects(driver.run(request().input), /blocked/);
    assert.equal(fake.live.size, 0); await driver.close();
  }
});

test('model tool args cannot supply Assignment authority', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }), r = request(); let calls = 0;
  r.input.tools = [{ name: 'shiyu_worker_read', description: 'Synthetic', parameters: { type: 'object', properties: {} }, execute: () => { calls++; return {}; } }];
  fake.toolCall('shiyu_worker_read', { assignmentId: 'other' });
  await assert.rejects(driver.run(r.input), /blocked/); assert.equal(calls, 0); await driver.close();
});

test('revoked start, bound, dispatch and pre-step permits cannot issue a model request', async () => {
  for (const phase of ['start', 'bound', 'dispatch', 'pre-step', 'request']) {
    const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }), r = request(); r.policy.revokeAt = phase;
    await assert.rejects(driver.run(r.input), /permit revoked/);
    assert.equal(fake.requests.length, 0); assert.equal(fake.live.size, 0);
    if (phase === 'start') assert.equal(fake.counts().creates, 0);
    await driver.close();
  }
});

test('revocation during a controlled tool and during native release suppresses all late results', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }), r = request(), gate = deferred(); let entered = false;
  r.input.tools = [{ name: 'shiyu_worker_read', description: 'Synthetic', parameters: { type: 'object', properties: {} }, async execute() { entered = true; await gate.promise; return { evidence: 'late' }; } }];
  fake.toolCall('shiyu_worker_read', {});
  const run = driver.run(r.input), rejected = assert.rejects(run, /permit revoked/);
  while (!entered) await pause(); r.policy.allowed = false; gate.resolve();
  await rejected; assert.equal(fake.live.size, 0); await driver.close();
  const next = fakeHost(), nextDriver = new WorkerSessionDriver({ ctx: next.ctx }), r2 = request();
  next.afterDispose(() => { r2.policy.allowed = false; });
  await assert.rejects(nextDriver.run(r2.input), /permit revoked/); assert.equal(next.live.size, 0); await nextDriver.close();
});

test('old host epoch, installation generation or fencing token is rejected independently', async () => {
  for (const override of [{ hostEpoch: 'old-host' }, { installationGeneration: 'old-installation' }, { fencingToken: 2 }]) {
    const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }), r = request(); r.policy.override = override;
    await assert.rejects(driver.run(r.input), /Stale worker permit/); assert.equal(fake.requests.length, 0); await driver.close();
  }
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }), r = request();
  fake.afterRequest(() => { r.policy.override.fencingToken = 2; });
  await assert.rejects(driver.run(r.input), /Stale worker permit: fencingToken/);
  assert.equal(fake.requests.length, 1); assert.equal(fake.live.size, 0); await driver.close();
});

test('tool permit revocation prevents execution; result revocation suppresses a completed model report', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }), r = request(); let calls = 0;
  r.input.tools = [{ name: 'shiyu_worker_read', description: 'Synthetic', parameters: { type: 'object', properties: {} }, execute: () => { calls++; return {}; } }];
  fake.toolCall('shiyu_worker_read', {}); r.policy.revokeAt = 'tool';
  await assert.rejects(driver.run(r.input), /permit revoked/); assert.equal(calls, 0); await driver.close();
  const second = fakeHost(), next = new WorkerSessionDriver({ ctx: second.ctx }), r2 = request();
  second.afterAssistant(() => { r2.policy.allowed = false; });
  await assert.rejects(next.run(r2.input), /permit revoked/); assert.equal(second.live.size, 0); await next.close();
});

test('step and output ceilings are enforced by native hooks without a custom model loop', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }); fake.setSteps(3);
  await assert.rejects(driver.run(request({ maxSteps: 2, maxTokens: 100 }).input), /step budget/);
  assert.equal(fake.requests.length, 2); assert.deepEqual(fake.requests.map(request => request.maxTokens), [100, 95]);
  await driver.close();
  const unknown = fakeHost(), noUsage = new WorkerSessionDriver({ ctx: unknown.ctx }); unknown.setSteps(2); unknown.setUsage(undefined);
  await assert.rejects(noUsage.run(request().input), /output budget/); assert.equal(unknown.requests.length, 1); await noUsage.close();
});

test('a lease expiry actively cancels an in-flight native turn', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }), r = request(); fake.holdModel();
  const expires = new Date(Date.now() + 30).toISOString(); r.identity.leaseExpiresAt = expires; r.input.permit.leaseExpiresAt = expires;
  await assert.rejects(driver.run(r.input), /expired/); assert.ok(fake.counts().cancellations > 0); assert.equal(fake.live.size, 0); await driver.close();
});

test('explicit cancellation rejects the result and releases the native handle', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }), r = request(); fake.holdModel();
  const run = driver.run(r.input), rejected = assert.rejects(run, /cancelled/);
  while (!fake.requests.length) await pause();
  await driver.cancel(r.input.assignmentId); await rejected;
  assert.equal(fake.live.size, 0); await driver.close();
});

test('concurrent dispatch for the same Assignment is refused instead of opening a second Agent', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }), r = request(); fake.holdModel();
  const run = driver.run(r.input), rejected = assert.rejects(run, /cancelled/);
  while (!fake.requests.length) await pause();
  await assert.rejects(driver.run(r.input), /already running/);
  assert.equal(fake.counts().creates, 1); await driver.cancel(r.input.assignmentId); await rejected; await driver.close();
});

test('an already-cancelled dispatch does not initialize or create a worker', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx });
  await assert.rejects(driver.run(request({ signal: AbortSignal.abort(new Error('caller cancelled')) }).input), /caller cancelled/);
  assert.equal(fake.presets.size, 0); assert.equal(fake.counts().creates, 0); await driver.close();
});

test('unload during late native creation waits, releases it, and never dispatches', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }), gate = deferred(); fake.setCreateGate(gate.promise);
  const run = driver.run(request().input), rejected = assert.rejects(run, /closed/);
  await pause(); const closing = driver.close(); gate.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(fake.counts().followups, 0); assert.equal(fake.live.size, 0); assert.equal(fake.presets.size, 0);
});

test('a failed durable binding callback never starts inference', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx });
  await assert.rejects(driver.run(request({ onBound: async () => { throw new Error('Binding store failed'); } }).input), /Binding store failed/);
  assert.equal(fake.requests.length, 0); assert.equal(fake.counts().followups, 0); assert.equal(fake.live.size, 0); await driver.close();
});

test('native disposal failure cannot release a successful candidate or remove the deny hooks', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }); fake.failDispose();
  await assert.rejects(driver.run(request().input), /Native dispose failed/);
  assert.ok(fake.agent().guards.length > 0); assert.ok(fake.agent().guards.every(guard => typeof guard({ name: 'shell' }) === 'string'));
  await assert.rejects(driver.run(request().input), /cleanup is unresolved/);
  await assert.rejects(driver.close(), /cleanup failed/); assert.equal(fake.presets.size, 0);
});

test('a hung asynchronous permit check is bounded and cannot create an Agent after timeout', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx }), r = request({ timeoutMs: 10 });
  r.input.permit.check = () => new Promise(() => {});
  await assert.rejects(driver.run(r.input), /expired/);
  assert.equal(fake.counts().creates, 0); assert.equal(fake.requests.length, 0); await driver.close();
});

test('invalid candidate authority fields and oversized runtime budgets are refused', async () => {
  const fake = fakeHost(), driver = new WorkerSessionDriver({ ctx: fake.ctx });
  fake.setCandidate({ summary: 'done', evidenceRequests: [], assignmentId: 'fake', succeeded: true });
  await assert.rejects(driver.run(request().input), /unsupported fields/);
  for (const limits of [{ maxSteps: 9 }, { timeoutMs: 120001 }, { maxTokens: 4097 }]) await assert.rejects(driver.run(request(limits).input), /maximum/);
  await driver.close();
});
