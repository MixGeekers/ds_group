import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GymService } from '../service.js';
import { managementTool } from '../tools.js';
import { serveRequest, serveTarget, serveDownload } from '../index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const terminal = s => ['completed', 'stopped', 'failed', 'interrupted'].includes(s);
function fakeHost() {
  const globals = new Map([['bash', { name: 'bash', parameters: {} }]]);
  const host = { handles: [], modelCalls: 0, script: undefined, cleanup: [], get(k) { return k === 'agents' ? this.agents : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'test', model: 'stub' }) } : undefined; }, effect(fn) { const dispose = fn(); this.cleanup.push(dispose); return dispose; }, tools: { schemas: () => [...globals.values()] } };
  host.agents = { async create(options) {
    const definitions = new Map(), guards = [], listeners = new Map(), disposers = [], sections = []; let denied = new Set();
    const ctx = {
      tools: {
        presentAs: () => () => {},
        schemas: () => [...globals.values()].filter(t => !denied.has(t.name)).concat([...definitions.values()]).map(({ name, parameters, description }) => ({ name, parameters, description })),
        restrict({ deny }) { denied = new Set(deny); return () => { denied.clear(); }; },
        guard(fn) { guards.push(fn); return () => { guards.splice(guards.indexOf(fn), 1); }; },
        register(def) { if (definitions.has(def.name)) throw new Error('duplicate'); definitions.set(def.name, def); return () => { definitions.delete(def.name); }; },
      },
      systemPrompt: { suppressRuntimeContext: () => () => {}, section(s) { sections.push(s); return () => {}; }, async assemble() { return { sections, contexts: [], tools: ctx.tools.schemas() }; } },
      effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose; },
      on(name, fn) { const values = listeners.get(name) ?? []; values.push(fn); listeners.set(name, values); return () => { values.splice(values.indexOf(fn), 1); }; },
    };
    let idle = Promise.resolve(), aborted = false;
    const agent = { id: options.sessionId, ctx, session: { id: options.sessionId }, followup(message) {
      if (aborted) throw new Error('disposed'); host.modelCalls++;
      idle = Promise.resolve().then(() => host.script?.(handle, message)).then(() => { for (const fn of listeners.get('session/event') ?? []) fn(agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } }); });
    }, whenIdle: () => idle, cancel() { aborted = true; } };
    const handle = { agent, options, disposed: false, async dispose() { this.disposed = true; aborted = true; for (const fn of disposers.splice(0).reverse()) await fn(); }, async invoke(name, args) {
      if (!ctx.tools.schemas().some(t => t.name === name)) throw new Error('UNKNOWN_TOOL');
      const execution = { name, agent, signal: new AbortController().signal, concludeTurn() {} };
      for (const guard of guards) { const reason = guard(execution); if (reason) throw new Error(reason); }
      for (const fn of listeners.get('agent/pre-step') ?? []) if ((await fn({ agent }, async () => ({ kind: 'enter', messages: [] }))).kind === 'reject') throw new Error('step rejected');
      return definitions.get(name).execute(args, execution);
    } };
    await options.setup(ctx, agent); host.handles.push(handle); return handle;
  } };
  return host;
}
async function fixture(t) {
  await mkdir(path.join(root, 'runtime'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'runtime', 'test-gym-'));
  const ctx = fakeHost(), service = new GymService(ctx, { runtimeDir: dir }); await service.init();
  t.after(async () => { await service.close(); assert.ok(dir.startsWith(path.join(root, 'runtime', 'test-gym-'))); await rm(dir, { recursive: true, force: true }); });
  return { service, ctx, dir };
}
const request = body => new Request('http://localhost/api/shiyu-gym', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function event(service, id, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let off = () => {};
    const timer = setTimeout(() => { off(); reject(new Error('event timeout')); }, timeout);
    off = service.engine.subscribe(id, e => { if (predicate(e)) { clearTimeout(timer); off(); setImmediate(resolve); } });
  });
}
async function external(t, overrides = {}) {
  const f = await fixture(t);
  const result = await f.service.dispatch({ action: 'create', driver: 'external', idempotencyKey: randomUUID(), config: { scenarioId: 'mixed-office', evaluationMode: 'outcome', speed: 100, noiseCount: 0, maxDurationMs: 10000, ...overrides } });
  if (!f.service.engine.getRun(result.run.id).tasks.every(t => t.introduced)) await event(f.service, result.run.id, e => e.type === 'input.request' && e.taskId === 'T08');
  return { ...f, ...result };
}

test('UI and agent management share identical state, idempotency and errors', async t => {
  const { service } = await fixture(t);
  const tool = managementTool(service), exec = { signal: new AbortController().signal };
  assert.deepEqual(await tool.execute({ action: 'snapshot' }, exec), await (await serveRequest(service, request({ action: 'snapshot' }))).json());
  const body = { action: 'create', driver: 'external', idempotencyKey: 'shared-create', config: { speed: 100, noiseCount: 0 } };
  const [a, b] = await Promise.all([tool.execute(body, exec), (async () => (await serveRequest(service, request(body))).json())()]);
  assert.equal(a.run.id, b.run.id); assert.equal(service.snapshot().runs.length, 1);
  await assert.rejects(tool.execute({ ...body, config: { noiseCount: 3 } }, exec), /不同参数/);
  assert.equal((await serveRequest(service, request({ action: 'unknown' }))).status, 400);
  const stopped = await tool.execute({ action: 'control', runId: a.run.id, command: 'stop' }, exec);
  assert.equal(stopped.run.status, 'stopped');
});

test('request receipts survive restart without replaying a run', async t => {
  const { service, ctx, dir } = await fixture(t);
  const body = { action: 'create', driver: 'external', idempotencyKey: 'durable-create' };
  const first = await service.dispatch(body); await service.close();
  const next = new GymService(ctx, { runtimeDir: dir }); await next.init(); t.after(() => next.close());
  const second = await next.dispatch(body);
  assert.equal(second.run.id, first.run.id); assert.equal(second.replayed, true); assert.equal(second.targetToken, undefined);
  await next.close();
});

test('one writer, bounded events, run token and unregistered path boundaries', async t => {
  const { service, ctx, dir, run } = await external(t);
  const other = new GymService(ctx, { runtimeDir: dir }); await assert.rejects(other.init(), /另一个活动实例/);
  const invalid = await serveTarget(service, request({ runId: run.id, targetToken: 'wrong', request: { action: 'inspect' } })); assert.equal(invalid.status, 403);
  const page = service.get(run.id, 0, 2).eventPage; assert.equal(page.events.length, 2); assert.equal(page.hasMore, true);
  const second = service.get(run.id, page.nextAfter, 2).eventPage; assert.ok(second.events[0].seq > page.nextAfter);
  await assert.rejects(service.artifact(run.id, '../../package.json'));
  await assert.rejects(service.dispatch({ action: 'judge', runId: run.id, idempotencyKey: 'before-seal' }), /尚未/);
  assert.equal(ctx.modelCalls, 0);
});

test('generic Office writers produce real files and preserve lost-receipt identity', async t => {
  const { service, run } = await external(t, { fault: 'lost-receipt' });
  const args = { action: 'write_spreadsheet', taskId: 'T01', path: 'outputs/T01/任意报表.xlsx', operationId: 'table-1', rows: [['项目', '净收入'], ['测试', 120]] };
  const first = await service.targetCall(run.id, args); assert.equal(first.unknown, true);
  const retry = await service.targetCall(run.id, args); assert.equal(retry.ok, true);
  assert.equal(service.engine.getRun(run.id).events.filter(e => e.type === 'file.written' && e.data.operationId === 'table-1').length, 1);
  await assert.rejects(service.targetCall(run.id, { ...args, rows: [['changed']] }), /不可改变/);
  const table = await service.preview(run.id, args.path); assert.match(table.content, /净收入/); assert.match(table.content, /120/);
  const doc = await service.targetCall(run.id, { action: 'write_document', taskId: 'T03', path: 'outputs/T03/纪要.docx', operationId: 'document-1', paragraphs: ['会议决定：分批交付。', '行动项：由项目经理确认时间。'] }); assert.equal(doc.ok, true);
  assert.match((await service.preview(run.id, 'outputs/T03/纪要.docx')).content, /分批交付/);
  const response = await serveDownload(service, new Request(`http://localhost/api/shiyu-gym/artifact?runId=${run.id}&path=${encodeURIComponent(args.path)}`), 'artifact');
  assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/); assert.equal(response.headers.get('content-type'), 'application/octet-stream');
});

test('host probe creates scoped Session without a model call or shell exposure', async t => {
  const { service, ctx } = await fixture(t);
  const probe = await service.dispatch({ action: 'probe_host' });
  assert.equal(probe.ready, true); assert.deepEqual(probe.tools, ['gym_target']); assert.equal(ctx.modelCalls, 0);
  assert.equal(ctx.handles[0].disposed, true); assert.ok(ctx.handles[0].options.meta.cwd.startsWith(service.runtimeDir));
});

test('DSH target is tool-scoped and stopping drains its handle', async t => {
  const { service, ctx } = await fixture(t); let observed;
  ctx.script = async handle => { await assert.rejects(handle.invoke('bash', {}), /UNKNOWN_TOOL/); observed = await handle.invoke('gym_target', { action: 'inspect' }); };
  const created = await service.dispatch({ action: 'create', driver: 'dsh', idempotencyKey: 'real-driver-stub', config: { speed: 1, noiseCount: 0 } });
  await ctx.handles[0].agent.whenIdle();
  assert.equal(observed.runId, created.run.id); assert.equal(created.run.config.evaluationMode, 'outcome');
  assert.equal(created.targetToken, undefined); assert.ok(ctx.modelCalls >= 1);
  await service.dispatch({ action: 'control', runId: created.run.id, command: 'stop' });
  assert.equal(ctx.handles[0].disposed, true); assert.ok(!service.bindings(created.run.id).some(b => b.status === 'running'));
});

test('independent Judge sees sources read-only and imports a separate cited opinion', async t => {
  const { service, ctx, run } = await external(t);
  await service.dispatch({ action: 'control', runId: run.id, command: 'stop' });
  const before = service.engine.getRun(run.id).factReport;
  ctx.script = async handle => {
    await assert.rejects(handle.invoke('gym_target', { action: 'inspect' }), /UNKNOWN_TOOL/);
    const p = await handle.invoke('gym_review', { action: 'overview' });
    const input = await handle.invoke('gym_review', { action: 'read', path: 'inputs/orders.json' }); assert.match(input.content, /orders/);
    const accepted = await handle.invoke('gym_review', { action: 'submit', review: { dimensions: [{ name: 'T01 证据覆盖', status: 'insufficient_evidence', reason: '运行停止且没有业务成果，保留不可判定。', evidenceRefs: [p.facts.assertions[0].id] }], needsHumanReview: true } });
    assert.equal(accepted.accepted, true);
  };
  const { binding } = await service.dispatch({ action: 'judge', runId: run.id, idempotencyKey: 'judge-1' });
  await ctx.handles[0].agent.whenIdle(); await new Promise(setImmediate);
  assert.notEqual(binding.sessionId, run.id);
  assert.deepEqual(service.engine.getRun(run.id).factReport, before);
  assert.equal(service.engine.getRun(run.id).reviews.length, 1);
  assert.equal(service.engine.getRun(run.id).reviews[0].provider, 'dsh:test/stub');
  assert.equal(service.engine.getRun(run.id).reviews[0].dimensions[0].score, undefined);
});

test('Judge missing submission is an explicit error, never a fabricated score', async t => {
  const { service, ctx, run } = await external(t); await service.dispatch({ action: 'control', runId: run.id, command: 'stop' });
  ctx.script = async () => {};
  await service.dispatch({ action: 'judge', runId: run.id, idempotencyKey: 'judge-no-result' });
  await ctx.handles[0].agent.whenIdle(); await new Promise(setImmediate);
  const review = service.engine.getRun(run.id).reviews[0]; assert.equal(review.status, 'judge_error'); assert.deepEqual(review.dimensions, []);
});

test('package includes localized metadata, original icon and no extra Client runtime', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@shiyu/gym'); assert.equal(manifest.exports['./client'], './plugin/client.js');
  for (const lang of ['zh', 'en']) { const locale = JSON.parse(await readFile(path.join(root, 'plugin', 'locale', `${lang}.json`), 'utf8')); assert.match(locale.meta.title, /识雨健身房/); assert.ok(locale.meta.description.length > 20); }
  const icon = await readFile(path.join(root, 'plugin/icon.svg'), 'utf8'); assert.match(icon, /<svg[^>]+viewBox=/); assert.ok(Buffer.byteLength(icon) < 256 * 1024);
});

test('cancellation during Agent creation disposes the late handle without model calls', async t => {
  const { service, ctx } = await fixture(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const create = ctx.agents.create;
  ctx.agents.create = async options => { entered(); await gate; return create(options); };
  const starting = service.dispatch({ action: 'create', driver: 'dsh', idempotencyKey: 'slow-create', config: { noiseCount: 0, speed: 1 } });
  await started;
  const runId = service.engine.listRuns()[0].id;
  const cancelling = service.driver.cancel(runId, 'target');
  release(); await Promise.all([starting, cancelling]);
  assert.equal(ctx.modelCalls, 0); assert.equal(ctx.handles[0].disposed, true); assert.equal(service.driver.live.size, 0);
});

test('concurrent Office retries reserve one byte generation and reject changed contents immediately', async t => {
  const { service, run } = await external(t, { fault: 'lost-receipt' });
  const args = { action: 'write_document', taskId: 'T03', path: 'outputs/T03/concurrent.docx', operationId: 'same-office', paragraphs: ['明确的会议决定与行动项。'] };
  const first = service.targetCall(run.id, args);
  await assert.rejects(service.targetCall(run.id, { ...args, paragraphs: ['另一个请求'] }), /不可改变/);
  const second = service.targetCall(run.id, args);
  const outcomes = await Promise.all([first, second]);
  assert.ok(outcomes.some(v => v.unknown)); assert.ok(outcomes.some(v => v.ok));
  assert.equal((await service.targetCall(run.id, args)).ok, true);
  assert.equal(service.engine.getRun(run.id).events.filter(e => e.type === 'file.written' && e.data.operationId === args.operationId).length, 1);
});

test('Judge can cite verified files and events omitted from its initial bounded packet', async t => {
  const { service, ctx, run } = await external(t); await service.dispatch({ action: 'control', runId: run.id, command: 'stop' });
  const full = await service.packet(run.id);
  service.packet = async () => ({ ...full, events: [], evidence: full.evidence.filter(e => !e.ref.startsWith(`${run.id}:`) && e.ref !== 'artifact:inputs/orders.json') });
  ctx.script = async handle => {
    const file = await handle.invoke('gym_review', { action: 'read', path: 'inputs/orders.json' });
    const page = await handle.invoke('gym_review', { action: 'events', after: 0 });
    const submitted = await handle.invoke('gym_review', { action: 'submit', review: { dimensions: [{ name: '证据核查', status: 'insufficient_evidence', reason: '真实输入可读，但没有最终成果。', evidenceRefs: [file.evidenceRef, page.events[0].id] }], needsHumanReview: true } });
    assert.equal(submitted.accepted, true, submitted.error);
  };
  await service.dispatch({ action: 'judge', runId: run.id, idempotencyKey: 'late-refs' });
  await ctx.handles[0].agent.whenIdle(); await new Promise(setImmediate);
  assert.equal(service.engine.getRun(run.id).reviews[0].status, 'completed');
});

test('target file reads have explicit, lossless text pagination and never dump Office base64', async t => {
  const { service, run } = await external(t);
  const content = '业务资料'.repeat(20000);
  await service.targetCall(run.id, { action: 'act', operationId: 'large-write', operation: { type: 'file.write', taskId: 'T01', path: 'outputs/T01/long.md', content } });
  let collected = '', offset = 0;
  do {
    const result = await service.targetCall(run.id, { action: 'act', operationId: `large-read-${offset}`, operation: { type: 'file.read', path: 'outputs/T01/long.md', offset } });
    assert.ok(result.data.content.length <= 24000); collected += result.data.content;
    offset = result.data.nextOffset;
    if (!result.data.truncated) break;
  } while (offset < content.length);
  assert.equal(collected, content);
  await service.targetCall(run.id, { action: 'write_document', taskId: 'T03', path: 'outputs/T03/binary.docx', operationId: 'binary-doc', paragraphs: ['真实正文'] });
  const binary = await service.targetCall(run.id, { action: 'act', operationId: 'read-binary', operation: { type: 'file.read', path: 'outputs/T03/binary.docx' } });
  assert.equal(binary.data.contentOmitted, true); assert.equal(binary.data.content, undefined);
  assert.match((await service.targetCall(run.id, { action: 'preview', path: 'outputs/T03/binary.docx' })).content, /真实正文/);
});
