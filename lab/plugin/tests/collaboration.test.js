import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GymService } from '../service.js';
import { managementTool, managementSchema } from '../tools.js';
import { collaborationActions } from '../collaboration.js';
import { apply, serveRequest, serveTarget, serveDownload, serveAsset } from '../index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const signal = () => new AbortController().signal;
const request = body => new Request('http://localhost/api/shiyu-gym', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function fixture(t, overrides = {}) {
  await mkdir(path.join(root, 'runtime'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'runtime', 'test-gym-collaboration-'));
  const ctx = { get: () => undefined };
  const service = new GymService(ctx, { runtimeDir: dir }); await service.init();
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const call = (action, args = {}) => service.dispatch({ action, idempotencyKey: randomUUID(), ...args });
  const created = await call('create', { driver: 'external', config: { scenarioId: 'free-chat', evaluationMode: 'outcome', keepOpen: true, noiseCount: 0, speed: 1, maxDurationMs: 600000, ...overrides } });
  return { ctx, service, dir, call, ...created };
}

test('management schema exposes the room protocol and passes the real calling Agent', async t => {
  for (const action of collaborationActions) assert.ok(managementSchema.parameters.properties.action.enum.includes(action), action);
  assert.equal(managementSchema.parameters.properties.config.properties.keepOpen.type, 'boolean');
  const { service, run, call } = await fixture(t);
  const tool = managementTool(service), agent = { id: 'test-target-session' }, exec = { agent, signal: signal() };
  const connection = await call('connection', { runId: run.id });
  const body = { action: 'target_connect', runId: run.id, targetToken: connection.targetToken, clientName: '测试识雨' };
  await assert.rejects(tool.execute(body, { signal: signal() }), /待接入的 DSH/);
  const connected = await tool.execute(body, exec);
  assert.equal(connected.connection.sessionId, agent.id);
  assert.equal(connected.tokenConsumed, true);
  assert.equal(service.engine.authorizeTarget(run.id, connection.targetToken), false);
  await assert.rejects(tool.execute({ action: 'workspace', runId: run.id }, exec), /只能使用本房间/);
  await assert.rejects(tool.execute({ action: 'target_inputs', runId: 'another-run' }, exec), /只能使用本房间/);
  await assert.rejects(tool.execute({ action: 'target_inputs', runId: run.id }, { agent: { id: 'unrelated' }, signal: signal() }), /尚未接入/);
  await call('send_message', { runId: run.id, channelId: 'D-SHIYU', text: '请在这里回复。' });
  const inputs = await tool.execute({ action: 'target_inputs', runId: run.id, after: 0 }, exec);
  assert.ok(inputs.inputs.some(input => input.event.text === '请在这里回复。'));
  const reply = await tool.execute({ action: 'target_action', runId: run.id, idempotencyKey: 'reply-once', operation: { type: 'message.send', channelId: 'D-SHIYU', text: '已经收到。' } }, exec);
  assert.equal(reply.ok, true);
  assert.ok((await call('chat', { runId: run.id, channelId: 'D-SHIYU' })).messages.some(message => message.text === '已经收到。' && message.source === 'target'));
  await tool.execute({ action: 'target_disconnect', runId: run.id }, exec);
  assert.equal((await tool.execute({ action: 'snapshot' }, exec)).runs.length, 1);
});

test('HTTP target enters participant state, respects occupancy, and revokes disconnected credentials', async t => {
  const { service, run, targetToken, call } = await fixture(t);
  const invoke = body => serveTarget(service, request({ runId: run.id, targetToken, request: body }));
  const connected = await invoke({ action: 'connect', clientName: 'HTTP 测试目标' });
  assert.equal(connected.status, 200);
  assert.equal(service.get(run.id).participants.find(actor => actor.id === 'SHIYU').name, 'HTTP 测试目标');
  await assert.rejects(call('connection', { runId: run.id }), /先断开/);
  service.state.bindings.push({ runId: run.id, role: 'target', sessionId: 'native-test', status: 'running' });
  const occupied = await invoke({ action: 'inspect' });
  assert.equal(occupied.status, 400); assert.match((await occupied.json()).error, /已有 DSH/);
  service.state.bindings[0].status = 'cancelled';
  const disconnected = await invoke({ action: 'disconnect' });
  assert.equal(disconnected.status, 200);
  assert.equal((await invoke({ action: 'inspect' })).status, 403);
  assert.equal(service.get(run.id).participants.find(actor => actor.id === 'SHIYU').status, 'cancelled');
  const renewed = await call('connection', { runId: run.id });
  const next = await serveTarget(service, request({ runId: run.id, targetToken: renewed.targetToken, request: { action: 'inspect' } }));
  assert.equal(next.status, 200);
});

test('room completion retains read-only identity until unload, without starting any model', async t => {
  const { service, run, targetToken, call, dir, ctx } = await fixture(t);
  await serveTarget(service, request({ runId: run.id, targetToken, request: { action: 'connect' } }));
  await call('control', { runId: run.id, command: 'drain' });
  assert.equal(service.state.connections[run.id].status, 'sealed');
  assert.equal(service.collaboration.watchers.size, 0);
  const crashSnapshot = await readFile(path.join(dir, 'gym-state.json'), 'utf8');
  await service.close();
  // Restore only the test's pre-close snapshot to emulate an abrupt restart.
  await writeFile(path.join(dir, 'gym-state.json'), crashSnapshot);
  const next = new GymService(ctx, { runtimeDir: dir }); await next.init();
  t.after(() => next.close());
  assert.equal(next.state.connections[run.id].status, 'disconnected');
  assert.equal(next.snapshot().capabilities.dshAgent, false);
  const stale = await serveTarget(next, request({ runId: run.id, targetToken, request: { action: 'inspect' } }));
  assert.equal(stale.status, 400);
  await next.close();
});

test('connection and attachment preflight refusals can retry the same key after prerequisites recover', async t => {
  const { service, run, targetToken } = await fixture(t);
  const connection = { action: 'connection', runId: run.id, idempotencyKey: 'connection-after-release' };
  const attachment = { action: 'attach_target', runId: run.id, driver: 'dsh', idempotencyKey: 'attachment-after-release' };
  await serveTarget(service, request({ runId: run.id, targetToken, request: { action: 'connect' } }));
  await assert.rejects(service.dispatch(connection), /先断开/);
  await assert.rejects(service.dispatch(attachment), /尚未配置/);
  assert.equal(service.state.requests['room:connection:connection-after-release'], undefined);
  assert.equal(service.state.requests['room:attach_target:attachment-after-release'], undefined);
  service.capabilities = () => ({ dshAgent: true });
  await assert.rejects(service.dispatch(attachment), /已有目标/);
  assert.equal(service.state.requests['room:attach_target:attachment-after-release'], undefined);
  await serveTarget(service, request({ runId: run.id, targetToken, request: { action: 'disconnect' } }));
  const renewed = await service.dispatch(connection);
  assert.equal(service.engine.authorizeTarget(run.id, renewed.targetToken), true);
  assert.deepEqual(await service.dispatch(connection), renewed);
  let starts = 0;
  service.driver.startTarget = async id => { starts++; return { runId: id, sessionId: 'stub-no-model', status: 'running' }; };
  const attached = await service.dispatch(attachment);
  assert.equal(attached.binding.sessionId, 'stub-no-model');
  assert.deepEqual(await service.dispatch(attachment), attached);
  assert.equal(starts, 1);
  await assert.rejects(service.dispatch({ ...attachment, driver: 'external' }), /同一请求标识不能改变/);
});

for (const transport of ['http', 'session']) test(`${transport}: final lost receipt remains queryable after sealing, while new effects and revoked identities are rejected`, async t => {
  const { service, run, targetToken, call } = await fixture(t, { fault: 'lost-receipt' });
  const tool = managementTool(service), exec = { agent: { id: `receipt-${transport}` }, signal: signal() };
  let invoke;
  if (transport === 'http') {
    invoke = async body => {
      const response = await serveTarget(service, request({ runId: run.id, targetToken, request: body }));
      const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
    };
    await invoke({ action: 'connect' });
  } else {
    await tool.execute({ action: 'target_connect', runId: run.id, targetToken, clientName: '回执测试' }, exec);
    invoke = body => tool.execute({ action: 'target_action', runId: run.id, request: body }, exec);
  }
  const { task } = await call('publish_task', { runId: run.id, channelId: 'D-SHIYU', title: '正文建议', text: '请用正文交付下一步安排。' });
  await call('control', { runId: run.id, command: 'drain' });
  const delivery = { action: 'act', operationId: 'last-delivery', operation: { type: 'task.deliver', taskId: task.id, paths: [], text: '建议先确认需求和交付日期，然后分配责任人，在截止日期之前检查交付情况并记录剩余风险。' } };
  const first = await invoke(delivery);
  assert.equal(first.unknown, true);
  assert.equal(service.engine.getRun(run.id).status, 'completed');
  assert.equal(service.state.connections[run.id].status, 'sealed');
  const retry = await invoke(delivery);
  assert.equal(retry.ok, true);
  assert.equal((await invoke({ action: 'inspect' })).status, 'completed');
  assert.equal((await invoke({ action: 'inputs', after: 0 })).status, 'completed');
  const changed = await invoke({ ...delivery, operation: { ...delivery.operation, text: '修改后的正文。' } });
  assert.equal(changed.ok, false); assert.match(changed.error, /内容不可改变/);
  const newEffect = await invoke({ action: 'act', operationId: 'sealed-write', operation: { type: 'file.write', taskId: task.id, path: `outputs/${task.id}/late.txt`, content: '不能新增' } });
  assert.equal(newEffect.ok, false); assert.match(newEffect.error, /已封存/);
  const sealed = service.engine.getRun(run.id);
  assert.equal(sealed.events.filter(event => event.type === 'task.delivered').length, 1);
  assert.equal(sealed.events.filter(event => event.type === 'message.delivered').length, 1);
  assert.equal(sealed.artifacts.length, 0);
  if (transport === 'http') await invoke({ action: 'disconnect' });
  else await tool.execute({ action: 'target_disconnect', runId: run.id }, exec);
  await assert.rejects(invoke(delivery), /断开或失效|尚未接入/);
  if (transport === 'session') await assert.rejects(tool.execute({ action: 'target_connect', runId: run.id, targetToken, clientName: '再次连接' }, exec), /房间已结束/);
});

test('uploads stay private until shared; workspace download and target previews read real bytes', async t => {
  const { service, run, call } = await fixture(t);
  const upload = { action: 'workspace_upload', runId: run.id, path: 'inputs/user/会议.txt', content: '会议结论：分两批交付。', encoding: 'utf8', idempotencyKey: 'upload-once' };
  const [first, retry] = await Promise.all([service.dispatch(upload), service.dispatch(upload)]);
  assert.deepEqual(first, retry);
  assert.ok(!service.targetView(run.id).readableFiles.includes(upload.path));
  await assert.rejects(service.targetCall(run.id, { action: 'preview', path: upload.path }), /只读证据范围/);
  const downloaded = await serveDownload(service, new Request(`http://localhost/api/shiyu-gym/workspace?runId=${run.id}&path=${encodeURIComponent(upload.path)}`), 'workspace');
  assert.equal(downloaded.status, 200); assert.equal(await downloaded.text(), upload.content);
  assert.match(downloaded.headers.get('content-disposition'), /attachment/);
  await call('send_message', { runId: run.id, channelId: 'D-SHIYU', text: '请查看资料', attachments: [upload.path] });
  assert.equal((await service.targetCall(run.id, { action: 'preview', path: upload.path })).content, upload.content);
  const traversal = await serveDownload(service, new Request(`http://localhost/api/shiyu-gym/workspace?runId=${run.id}&path=../../package.json`), 'workspace');
  assert.equal(traversal.status, 404);
  const outputOnly = await serveDownload(service, new Request(`http://localhost/api/shiyu-gym/artifact?runId=${run.id}&path=${encodeURIComponent(upload.path)}`), 'artifact');
  assert.equal(outputOnly.status, 404);
});

test('human task publishing and explicit target delivery produce one visible delivery', async t => {
  const { service, run, call } = await fixture(t);
  const body = { action: 'publish_task', runId: run.id, channelId: 'D-SHIYU', title: '梳理建议', text: '请用正文给出下一步建议。', paths: [], idempotencyKey: 'task-once' };
  const response = await (await serveRequest(service, request(body))).json();
  const retried = await service.dispatch(body);
  assert.equal(response.task.id, retried.task.id);
  const taskId = response.task.id;
  const delivered = await service.targetCall(run.id, { action: 'act', operationId: 'deliver-once', operation: { type: 'task.deliver', taskId, paths: [], text: '建议先确认交付日期，再按责任人与截止时间登记行动项，并在下一次会议回顾完成情况。' } });
  assert.equal(delivered.ok, true);
  const chat = await call('chat', { runId: run.id, channelId: 'D-SHIYU' });
  assert.equal(chat.messages.filter(message => message.kind === 'delivery' && message.taskId === taskId).length, 1);
  const evaluated = new Promise((resolve, reject) => {
    let off = () => {};
    const timer = setTimeout(() => { off(); reject(new Error('evaluation timeout')); }, 5000);
    off = service.engine.subscribe(run.id, event => { if (event.type === 'evaluation.completed' || event.type === 'evaluation.error') { clearTimeout(timer); off(); resolve(); } });
  });
  await call('control', { runId: run.id, command: 'drain' }); await evaluated;
  assert.equal(service.engine.getRun(run.id).factReport.tasksSubmitted, 1);
});

test('custom scenario HTTP save is durable, idempotent, and rejects stale revisions', async t => {
  const { service, call, dir } = await fixture(t);
  const original = await call('scenario_get', { scenarioId: 'free-chat' });
  const scenario = { ...original.scenario, id: '', name: '接口验证剧本' };
  const body = { action: 'scenario_save', scenario, idempotencyKey: 'save-once' };
  const saved = await (await serveRequest(service, request(body))).json();
  assert.equal(saved.builtin, false); assert.equal(saved.revision, 1);
  assert.equal((await service.dispatch(body)).scenario.id, saved.scenario.id);
  const persisted = JSON.parse(await readFile(path.join(dir, 'scenarios', `${saved.scenario.id}.json`), 'utf8'));
  assert.equal(persisted.scenario.name, '接口验证剧本');
  await call('scenario_save', { scenario: { ...saved.scenario, name: '新版本' }, expectedRevision: 1 });
  await assert.rejects(call('scenario_save', { scenario: saved.scenario, expectedRevision: 1 }), /revision 冲突/);
});

test('local icon endpoints serve packaged font assets and reject arbitrary paths', async () => {
  for (const [name, contentType] of [['icons.css', 'text/css'], ['tabler-icons.core.woff2', 'font/woff2'], ['tabler-icons.devices-1.woff2', 'font/woff2']]) {
    const response = await serveAsset(name);
    assert.equal(response.status, 200, name); assert.ok(response.headers.get('content-type').startsWith(contentType));
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  assert.equal((await serveAsset('../../package.json')).status, 404);
});

test('registered GET routes survive the DSH HTTP bridge and retain download query parameters', async t => {
  await mkdir(path.join(root, 'runtime'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'runtime', 'test-gym-routes-'));
  const routes = new Map(), cleanup = [];
  let service;
  const ctx = {
    get: () => undefined,
    effect(fn) { const dispose = fn(); cleanup.push(dispose); return dispose; },
    provide(name, value) { if (name === 'shiyuGym') service = value; },
    on: () => () => {},
    agents: { list: () => [] },
    tools: { register: () => () => {} },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
  };
  t.after(async () => { for (const dispose of cleanup.reverse()) await dispose?.(); await rm(dir, { recursive: true, force: true }); });
  await apply(ctx, { runtimeDir: dir });
  const { run } = await service.dispatch({ action: 'create', driver: 'external', idempotencyKey: 'bridge-run', config: { scenarioId: 'free-chat', evaluationMode: 'outcome', keepOpen: true, noiseCount: 0 } });
  await service.dispatch({ action: 'workspace_upload', runId: run.id, path: 'inputs/user/桥接资料.txt', content: 'GET 下载的真实内容。', encoding: 'utf8', idempotencyKey: 'bridge-upload' });
  await service.dispatch({ action: 'control', runId: run.id, command: 'stop' });
  // Match the installed DSH bridge: only explicit buffered mode omits a GET
  // body. Otherwise WHATWG Request rejects it before route.fetch is reached.
  const get = async (pathname, values = {}) => {
    const route = routes.get(pathname); assert.ok(route);
    const url = new URL(pathname, 'http://dsh.internal');
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    const native = new Request(url, { method: 'GET', ...(route.requestBody === 'buffered' ? {} : { body: new ReadableStream(), duplex: 'half' }) });
    return route.fetch(native);
  };
  for (const route of routes.values()) assert.equal(route.requestBody, 'buffered', `${route.methods.join(',')} ${route.path}`);
  const workspace = await get('/api/shiyu-gym/workspace', { runId: run.id, path: 'inputs/user/桥接资料.txt' });
  assert.equal(workspace.status, 200); assert.equal(await workspace.text(), 'GET 下载的真实内容。');
  const evidence = await get('/api/shiyu-gym/evidence', { runId: run.id });
  assert.equal(evidence.status, 200); assert.equal((await evidence.json()).runId, run.id);
  const css = await get('/api/shiyu-gym/assets/icons.css');
  assert.equal(css.status, 200); assert.match(await css.text(), /@font-face/);
});
