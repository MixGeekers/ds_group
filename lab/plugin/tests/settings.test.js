import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GymService } from '../service.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const follow = () => ({ mode: 'follow_host' });
const explicit = (model, reasoningEffort) => ({ mode: 'explicit', model: { provider: 'test-provider', model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } });
function host() {
  const ctx = { selected: { provider: 'test-provider', model: 'host', reasoningEffort: 'standard' }, handles: [], calls: 0, globalSaves: 0, resolutions: [],
    get(name) { return name === 'agentDefaultModel' ? { currentSelection: () => ({ ...this.selected }), save: () => { this.globalSaves++; throw new Error('must not save Host selection'); } } : name === 'llm' ? this.llm : name === 'agents' ? this.agents : undefined; },
  };
  ctx.llm = { async resolveCallConfig(config) {
    ctx.resolutions.push({ ...config });
    assert.equal(config.provider, 'test-provider', 'unknown provider');
    assert.ok(['host', 'trainer', 'judge', 'next'].includes(config.model), 'unknown model');
    assert.ok(config.reasoningEffort === undefined || ['standard', 'deep'].includes(config.reasoningEffort), 'unsupported reasoning effort');
    return { ...config, reasoningEffort: config.reasoningEffort ?? 'standard', maxTokens: 9999 };
  } };
  ctx.agents = { async create(options) {
    const definitions = new Map(), disposers = [], sections = [];
    const agentCtx = { tools: {
      schemas: () => [...definitions.values()], presentAs: () => () => {}, restrict: () => () => {}, guard: () => () => {},
      register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name); },
    }, systemPrompt: { suppressRuntimeContext: () => () => {}, section(s) { sections.push(s); return () => {}; }, async assemble() { return { sections, contexts: [], tools: [...definitions.values()] }; } },
    effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose; }, on: () => () => {} };
    const agent = { id: options.sessionId, session: { id: options.sessionId }, ctx: agentCtx, followup() { ctx.calls++; }, whenIdle: () => Promise.resolve(), cancel() {} };
    const handle = { agent, options, disposed: false, async dispose() { this.disposed = true; for (const dispose of disposers.splice(0).reverse()) await dispose(); } };
    await options.setup(agentCtx, agent); ctx.handles.push(handle); return handle;
  } };
  return ctx;
}
async function fixture(t) {
  await mkdir(path.join(root, 'runtime'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'runtime', 'test-gym-settings-'));
  const ctx = host(), service = new GymService(ctx, { runtimeDir: dir }); await service.init();
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const save = (settings, expectedRevision, idempotencyKey = randomUUID()) => service.dispatch({ action: 'settings_save', settings, expectedRevision, idempotencyKey });
  return { dir, ctx, service, save };
}

test('Lab settings follow Host by default and validate independent choices without model calls or global writes', async t => {
  const { service, ctx, save, dir } = await fixture(t);
  const initial = await service.dispatch({ action: 'settings_get' });
  assert.deepEqual(initial.settings, { target: follow(), judge: follow() }); assert.equal(initial.revision, 0);
  assert.deepEqual(initial.effective.target, ctx.selected);
  const saved = await save({ target: explicit('trainer', 'deep'), judge: explicit('judge') }, 0, 'settings-once');
  assert.equal(saved.revision, 1); assert.equal(saved.settings.judge.model.reasoningEffort, undefined);
  assert.deepEqual(await service.resolveModel('judge'), { provider: 'test-provider', model: 'judge', reasoningEffort: 'standard' });
  await assert.rejects(save({ target: explicit('trainer', 'imaginary-effort'), judge: follow() }, 1), /unsupported reasoning/);
  await assert.rejects(save({ target: { ...explicit('trainer'), apiKey: 'no-secret-storage' }, judge: follow() }, 1), /不支持/);
  assert.equal(service.settings.snapshot().revision, 1);
  const stored = JSON.parse(await readFile(path.join(dir, 'gym-state.json'), 'utf8'));
  assert.equal(stored.settings.settings.target.model.model, 'trainer');
  assert.equal(JSON.stringify(stored).includes('no-secret-storage'), false);
  assert.equal(ctx.calls, 0); assert.equal(ctx.handles.length, 0); assert.equal(ctx.globalSaves, 0);
  assert.equal(ctx.selected.model, 'host');
});

test('settings saves have durable receipts and revisions while follow Host remains dynamic', async t => {
  const { service, ctx, save, dir } = await fixture(t);
  const settings = { target: explicit('trainer'), judge: follow() };
  const saved = await save(settings, 0, 'save-one');
  assert.deepEqual(await save(settings, 0, 'save-one'), saved);
  const writes = await Promise.allSettled([save({ target: follow(), judge: explicit('judge') }, 1), save({ target: explicit('next'), judge: follow() }, 1)]);
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(writes.find(result => result.status === 'rejected').reason.message, /revision 冲突/);
  ctx.selected = { provider: 'test-provider', model: 'next', reasoningEffort: 'deep' };
  assert.equal(service.model('target').model, 'next');
  await service.close();
  const restored = new GymService(ctx, { runtimeDir: dir }); await restored.init(); t.after(() => restored.close());
  assert.equal(restored.settings.snapshot().revision, 2); assert.equal(restored.model('judge').model, 'judge');
  assert.equal(restored.model('target').model, 'next'); await restored.close();
});

test('target and Judge bind their own resolved model once and active sessions keep that snapshot', async t => {
  const { service, ctx, save } = await fixture(t);
  await save({ target: explicit('trainer', 'deep'), judge: explicit('judge') }, 0);
  const created = await service.dispatch({ action: 'create', driver: 'external', idempotencyKey: 'settings-run', config: { scenarioId: 'free-chat', keepOpen: true, evaluationMode: 'outcome', noiseCount: 0 } });
  const target = await service.driver.startTarget(created.run.id);
  assert.equal(ctx.handles[0].options.agentOptions.model, 'trainer');
  assert.equal(ctx.handles[0].options.agentOptions.reasoningEffort, 'deep');
  await save({ target: explicit('next'), judge: explicit('judge', 'deep') }, 1);
  assert.equal(target.model.model, 'trainer'); assert.equal(ctx.handles[0].options.agentOptions.model, 'trainer');
  await service.dispatch({ action: 'control', runId: created.run.id, command: 'stop' });
  const judge = await service.driver.startJudge(created.run.id);
  assert.equal(judge.model.model, 'judge'); assert.equal(judge.model.reasoningEffort, 'deep');
  assert.equal(ctx.handles[1].options.agentOptions.model, 'judge');
  assert.equal(ctx.globalSaves, 0);
});

test('a probe awaiting model metadata cannot create a Session after unload', async t => {
  const { service, ctx } = await fixture(t);
  let release;
  ctx.llm.resolveCallConfig = config => new Promise(resolve => { release = () => resolve(config); });
  const probe = service.driver.probe();
  const rejection = assert.rejects(probe, /已关闭/);
  await service.close(); release(); await rejection;
  assert.equal(ctx.handles.length, 0); assert.equal(ctx.calls, 0); assert.equal(service.state.bindings.length, 0);
});

test('target reserves its binding during metadata lookup and cancellation prevents late startup', async t => {
  const { service, ctx } = await fixture(t);
  const created = await service.dispatch({ action: 'create', driver: 'external', idempotencyKey: 'metadata-cancel-run', config: { scenarioId: 'free-chat', keepOpen: true, evaluationMode: 'outcome', noiseCount: 0 } });
  let release;
  ctx.llm.resolveCallConfig = config => new Promise(resolve => { release = () => resolve(config); });
  const starting = service.driver.startTarget(created.run.id);
  assert.equal(service.bindings(created.run.id)[0].status, 'starting');
  await assert.rejects(service.dispatch({ action: 'connection', runId: created.run.id, idempotencyKey: 'metadata-occupied' }), /先断开/);
  await service.driver.cancel(created.run.id, 'target'); release();
  assert.equal((await starting).status, 'cancelled');
  assert.equal(ctx.handles.length, 0); assert.equal(ctx.calls, 0);
});

test('unload waits for a late probe Session and disposes it without invoking the model', async t => {
  const { service, ctx } = await fixture(t);
  let release, reached;
  const entered = new Promise(resolve => { reached = resolve; });
  const original = ctx.agents.create;
  ctx.agents.create = async options => { reached(); await new Promise(resolve => { release = resolve; }); return original(options); };
  const probe = service.driver.probe(); const rejection = assert.rejects(probe, /已关闭/); await entered;
  let closed = false; const closing = service.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  release(); await closing; await rejection;
  assert.equal(ctx.handles.length, 1); assert.equal(ctx.handles[0].disposed, true); assert.equal(ctx.calls, 0);
});
