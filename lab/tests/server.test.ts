import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/server.ts';
import type { RunConfig, RunDetail, TargetAction, TaskRecord } from '../src/types.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config: RunConfig = {
  scenarioId: 'mixed-office', target: 'external', seed: 42, noiseCount: 0,
  speed: 1, workerConcurrency: 2, taskDelayMs: 20, fault: 'none', maxDurationMs: 60000,
};

async function fixture(t: TestContext) {
  await mkdir(path.join(projectRoot, 'runtime'), { recursive: true });
  const runtimeDir = await mkdtemp(path.join(projectRoot, 'runtime', 'test-api-'));
  const instance = await buildApp({ runtimeDir, serveWeb: false, logger: false });
  t.after(async () => {
    try { await instance.app.close(); }
    finally { await rm(runtimeDir, { recursive: true, force: true }); }
  });
  return { ...instance, runtimeDir };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function create(f: Fixture, overrides: Partial<RunConfig> = {}, key = randomUUID()) {
  const response = await f.app.inject({
    method: 'POST', url: '/api/runs', payload: { config: { ...config, ...overrides }, idempotencyKey: key },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json<{ run: RunDetail; targetToken: string }>();
  assert.ok(body.run.id);
  assert.ok(body.targetToken);
  return body;
}
const authorization = (token: string) => ({ authorization: `Bearer ${token}` });
async function act(f: Fixture, id: string, token: string, action: TargetAction | Record<string, unknown>, operationId = randomUUID()) {
  return f.app.inject({ method: 'POST', url: `/target/runs/${id}/actions`, headers: authorization(token), payload: { action, operationId } });
}
async function firstTask(f: Fixture, id: string, token: string): Promise<TaskRecord> {
  const until = Date.now() + 3000;
  do {
    const response = await f.app.inject({ method: 'GET', url: `/target/runs/${id}`, headers: authorization(token) });
    assert.equal(response.statusCode, 200, response.body);
    const tasks = response.json<{ tasks: TaskRecord[] }>().tasks;
    if (tasks.length) return tasks[0];
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < until);
  assert.fail('First scheduled request was not released');
}

test('API exposes company catalog and returns 404 for an unknown run', async t => {
  const f = await fixture(t);
  const health = await f.app.inject('/api/health');
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().ok, true);
  const response = await f.app.inject('/api/catalog');
  assert.equal(response.statusCode, 200);
  const catalog = response.json();
  assert.equal(catalog.subjects.length, 8);
  assert.ok(catalog.actors.length >= 12);
  assert.ok(catalog.scenarios.some((s: { id: string }) => s.id === config.scenarioId));
  assert.equal((await f.app.inject('/api/runs/not-a-real-run')).statusCode, 404);
  assert.deepEqual((await f.app.inject('/api/runs')).json(), []);
});

test('creation rejects invalid configuration before starting a run', async t => {
  const f = await fixture(t);
  for (const changes of [{ scenarioId: 'missing' }, { noiseCount: -1 }, { speed: 0 }, { workerConcurrency: 0 }, { target: 'unknown' }, { fault: 'unlimited-failure' }]) {
    const response = await f.app.inject({ method: 'POST', url: '/api/runs', payload: { config: { ...config, ...changes }, idempotencyKey: randomUUID() } });
    assert.equal(response.statusCode, 400, JSON.stringify(changes));
  }
  const missingKey = await f.app.inject({ method: 'POST', url: '/api/runs', payload: { config } });
  assert.equal(missingKey.statusCode, 400);
  assert.deepEqual((await f.app.inject('/api/runs')).json(), []);
});

test('run creation is idempotent and rejects reuse of a key for a different config', async t => {
  const f = await fixture(t);
  const key = randomUUID();
  const [one, two] = await Promise.all([create(f, {}, key), create(f, {}, key)]);
  assert.equal(one.run.id, two.run.id);
  assert.equal(one.targetToken, two.targetToken);
  assert.equal((await f.app.inject('/api/runs')).json().length, 1);
  const conflict = await f.app.inject({ method: 'POST', url: '/api/runs', payload: { config: { ...config, seed: 11 }, idempotencyKey: key } });
  assert.equal(conflict.statusCode, 409);
  assert.equal((await f.app.inject('/api/runs')).json().length, 1);
});

test('target credentials are required and scoped to one external run', async t => {
  const f = await fixture(t);
  const one = await create(f);
  const two = await create(f, { seed: 9 });
  assert.equal((await f.app.inject(`/target/runs/${one.run.id}`)).statusCode, 401);
  assert.equal((await f.app.inject({ url: `/target/runs/${one.run.id}`, headers: authorization('wrong') })).statusCode, 401);
  assert.equal((await f.app.inject({ url: `/target/runs/${two.run.id}`, headers: authorization(one.targetToken) })).statusCode, 401);
  assert.equal((await f.app.inject({ url: `/target/runs/${one.run.id}`, headers: authorization(one.targetToken) })).statusCode, 200);
});

test('simultaneous creation reserves capacity before asynchronous workspace initialization', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 5 }, (_, index) => f.app.inject({
    method: 'POST', url: '/api/runs', payload: { config: { ...config, seed: index }, idempotencyKey: randomUUID() },
  })));
  assert.equal(responses.filter(response => response.statusCode === 200).length, 4, responses.map(r => `${r.statusCode}: ${r.body}`).join('\n'));
  assert.equal(responses.filter(response => response.statusCode === 409).length, 1);
  assert.equal((await f.app.inject('/api/runs')).json().length, 4);
});

test('target sees released inputs and introduced tasks without observer scoring metadata', async t => {
  const f = await fixture(t);
  const { run, targetToken } = await create(f);
  await firstTask(f, run.id, targetToken);
  const view = (await f.app.inject({ url: `/target/runs/${run.id}`, headers: authorization(targetToken) })).json();
  assert.ok(view.tasks.length > 0 && view.tasks.length < run.tasks.length);
  assert.ok(view.tasks.every((task: TaskRecord) => task.introduced));
  for (const privateKey of ['factReport', 'manifest', 'reviews', 'events']) assert.equal(privateKey in view, false, privateKey);
  const response = await f.app.inject({ url: `/target/runs/${run.id}/inputs?after=0`, headers: authorization(targetToken) });
  assert.equal(response.statusCode, 200);
  const inputs = response.json().inputs;
  assert.ok(inputs.length > 0);
  assert.ok(inputs.every((entry: any) => entry.event.type.startsWith('input.')));
  assert.ok(inputs.every((entry: any) => entry.event.businessMs <= 3000));
  const seq = Math.max(...inputs.map((entry: any) => entry.seq));
  const following = (await f.app.inject({ url: `/target/runs/${run.id}/inputs?after=${seq}`, headers: authorization(targetToken) })).json().inputs;
  assert.ok(following.every((entry: any) => entry.seq > seq));
  const invalidCursor = await f.app.inject({ url: `/target/runs/${run.id}/inputs?after=-1`, headers: authorization(targetToken) });
  assert.equal(invalidCursor.statusCode, 400);
});

test('target action validation rejects unknown actions and cannot forge Lab observations', async t => {
  const f = await fixture(t);
  const { run, targetToken } = await create(f);
  for (const action of [
    { type: 'shell.exec', command: 'anything' },
    { type: 'observe', role: 'lab', text: 'All tests pass' },
    { type: 'file.write', taskId: 'T01', path: 'outputs/T01/data.txt', content: 'ok', encoding: 'unknown' },
    { type: 'task.update', taskId: 'T01', status: 'certified' },
  ]) assert.equal((await act(f, run.id, targetToken, action)).statusCode, 400);
});

test('target writes are scoped and retries do not create duplicate effects', async t => {
  const f = await fixture(t);
  const { run, targetToken } = await create(f);
  const task = await firstTask(f, run.id, targetToken);
  const filePath = `outputs/${task.id}/api-proof.txt`;
  const action: TargetAction = { type: 'file.write', taskId: task.id, path: filePath, content: 'test artifact' };
  const operationId = randomUUID();
  const one = await act(f, run.id, targetToken, action, operationId);
  const two = await act(f, run.id, targetToken, action, operationId);
  assert.equal(one.statusCode, 200, one.body);
  assert.equal(one.json().ok, true, one.body);
  assert.deepEqual(two.json(), one.json());
  const conflict = await act(f, run.id, targetToken, { ...action, content: 'changed' }, operationId);
  assert.equal(conflict.json().ok, false);
  assert.equal(await readFile(path.join(f.engine.runDir(run.id), 'workspace', filePath), 'utf8'), 'test artifact');
  const detail = (await f.app.inject(`/api/runs/${run.id}`)).json<RunDetail>();
  assert.equal(detail.artifacts.filter(a => a.path === filePath).length, 1);
  for (const unsafePath of ['../escape.txt', '/tmp/lab-escape.txt', 'inputs/overwrite.json', 'outputs/another-task/escape.txt']) {
    const rejected = await act(f, run.id, targetToken, { ...action, path: unsafePath });
    assert.equal(rejected.json().ok, false, unsafePath);
  }
  const escapedRead = await act(f, run.id, targetToken, { type: 'file.read', path: '../manifest.json' });
  assert.equal(escapedRead.json().ok, false);
});

test('stopping a run rejects new effects and leaves previous artifacts unchanged', async t => {
  const f = await fixture(t);
  const { run, targetToken } = await create(f);
  const task = await firstTask(f, run.id, targetToken);
  const filePath = `outputs/${task.id}/before-stop.txt`;
  assert.equal((await act(f, run.id, targetToken, { type: 'file.write', taskId: task.id, path: filePath, content: 'before' })).json().ok, true);
  const stopped = await f.app.inject({ method: 'POST', url: `/api/runs/${run.id}/control`, payload: { command: 'stop' } });
  assert.equal(stopped.statusCode, 200, stopped.body);
  assert.equal(stopped.json().status, 'stopped');
  const late = await act(f, run.id, targetToken, { type: 'file.write', taskId: task.id, path: filePath, content: 'after' });
  assert.equal(late.json().ok, false);
  assert.equal(await readFile(path.join(f.engine.runDir(run.id), 'workspace', filePath), 'utf8'), 'before');
});

test('unfinished runs cannot produce sealed evidence or Agent review', async t => {
  const f = await fixture(t);
  const { run } = await create(f);
  assert.equal((await f.app.inject(`/api/runs/${run.id}/evidence`)).statusCode, 409);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/runs/${run.id}/reviews`, payload: {} })).statusCode, 409);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/runs/${run.id}/reviews/import`, payload: { review: {} } })).statusCode, 409);
});

test('external Agent can deliver its final result after marking the last task completed', async t => {
  const f = await fixture(t);
  const { run, targetToken } = await create(f, { speed: 100 });
  let detail: RunDetail = run;
  const until = Date.now() + 3000;
  do {
    detail = (await f.app.inject(`/api/runs/${run.id}`)).json<RunDetail>();
    if (detail.status === 'draining') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < until);
  assert.equal(detail.status, 'draining');
  const [lastTask, ...others] = detail.tasks.filter(task => task.introduced);
  assert.ok(lastTask);
  for (const task of others) {
    const response = await act(f, run.id, targetToken, { type: 'task.update', taskId: task.id, status: 'cancelled', detail: 'Unrelated work cancelled in this focused protocol test' });
    assert.equal(response.json().ok, true, response.body);
  }
  const completed = await act(f, run.id, targetToken, { type: 'task.update', taskId: lastTask.id, status: 'completed' });
  assert.equal(completed.json().ok, true, completed.body);
  // A real Agent may need another model/network round before communicating its result.
  // Sealing after a small fixed grace period silently rejects otherwise valid async delivery.
  await new Promise(resolve => setTimeout(resolve, 800));
  const delivered = await act(f, run.id, targetToken, { type: 'message.send', taskId: lastTask.id, channelId: lastTask.channelId, text: '最后一个工作结果已就绪，请检查交付物。' });
  assert.equal(delivered.json().ok, true, 'Last completion must not seal the run before the Agent can deliver its result');
});

test('server shutdown waits for a naturally finishing run to seal its fact report', async t => {
  const f = await fixture(t);
  const { run, targetToken } = await create(f, { speed: 100 });
  let detail: RunDetail = run;
  const until = Date.now() + 3000;
  do {
    detail = (await f.app.inject(`/api/runs/${run.id}`)).json<RunDetail>();
    if (detail.status === 'draining') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < until);
  assert.equal(detail.status, 'draining');
  for (const task of detail.tasks.filter(task => task.introduced)) {
    assert.equal((await act(f, run.id, targetToken, { type: 'task.update', taskId: task.id, status: 'cancelled' })).json().ok, true);
  }
  const runDir = f.engine.runDir(run.id);
  // The final transition starts asynchronous file-based evaluation. Closing immediately
  // must wait for it instead of closing SQLite underneath the evaluator.
  await f.app.close();
  const sealed = f.engine.getRun(run.id);
  assert.ok(sealed.factReport, 'Closing the service must wait for the final facts to be available');
  const facts = JSON.parse(await readFile(path.join(runDir, 'facts.json'), 'utf8'));
  assert.equal(facts.id, sealed.factReport.id);
});

test('cross-site command requests are refused without creating a run', async t => {
  const f = await fixture(t);
  const response = await f.app.inject({ method: 'POST', url: '/api/runs', headers: { origin: 'https://malicious.example' }, payload: { config, idempotencyKey: randomUUID() } });
  assert.equal(response.statusCode, 403);
  assert.deepEqual((await f.app.inject('/api/runs')).json(), []);
});

test('artifact endpoints only serve registered intact outputs and never arbitrary files', async t => {
  const f = await fixture(t);
  const { run, targetToken } = await create(f);
  const task = await firstTask(f, run.id, targetToken);
  const filePath = `outputs/${task.id}/preview-proof.txt`;
  const response = await act(f, run.id, targetToken, { type: 'file.write', taskId: task.id, path: filePath, content: '<script>not executable</script>\nproof' });
  assert.equal(response.json().ok, true, response.body);
  const url = `/api/runs/${run.id}/artifacts?path=${encodeURIComponent(filePath)}`;
  const download = await f.app.inject(url);
  assert.equal(download.statusCode, 200);
  assert.match(download.headers['content-disposition'] as string, /^attachment;/);
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  const preview = await f.app.inject(`/api/runs/${run.id}/preview?path=${encodeURIComponent(filePath)}`);
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().content, '<script>not executable</script>\nproof');
  const unrelated = await f.app.inject(`/api/runs/${run.id}/artifacts?path=${encodeURIComponent('inputs/orders.json')}`);
  assert.equal(unrelated.statusCode, 404);
  const traversal = await f.app.inject(`/api/runs/${run.id}/artifacts?path=${encodeURIComponent('../manifest.json')}`);
  assert.equal(traversal.statusCode, 404);
  await writeFile(path.join(f.engine.runDir(run.id), 'workspace', filePath), 'tampered outside API');
  assert.equal((await f.app.inject(url)).statusCode, 409);
  assert.equal((await f.app.inject(`/api/runs/${run.id}/preview?path=${encodeURIComponent(filePath)}`)).statusCode, 409);
});
