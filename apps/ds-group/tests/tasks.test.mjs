import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskService } from '../src/tasks.mjs';

const identity = { requestId: 'matrix-task-one', botId: '@finance:test', roomId: '!room:test', eventId: '$event' };
const setup = { homeserverUrl: 'http://127.0.0.1:1', participants: [
  { id: '@finance:test', kind: 'bot' }, { id: '@alice:test', kind: 'human' }, { id: '@bob:test', kind: 'human' },
] };

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-tasks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('task receipts persist identity, monotonic tool counts and verified reconciliation', async t => {
  const directory = await temporary(t);
  let tasks = new TaskService({ setup, dataRoot: directory });
  tasks.update({ ...identity, status: 'queued' });
  tasks.update({ ...identity, status: 'running', stage: 'tool', toolCalls: 3 });
  assert.equal(tasks.update({ ...identity, status: 'queued', toolCalls: 0 }).status, 'running');
  assert.throws(() => tasks.update({ ...identity, roomId: '!another:test', status: 'running' }), /identity/);
  tasks.update({ ...identity, status: 'unknown', summary: 'Waiting for node reconciliation' });
  tasks.close();
  tasks = new TaskService({ setup, dataRoot: directory });
  try {
    assert.equal(tasks.update({ ...identity, status: 'running' }).status, 'unknown');
    const resumed = tasks.update({ ...identity, status: 'running', reconciled: true, toolCalls: 1 });
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.toolCalls, 3);
    tasks.update({ ...identity, status: 'completed', artifacts: [{ id: 'result-one', name: 'summary.csv', mimeType: 'text/csv', size: 20, path: '/private/local-file' }] });
    const final = tasks.update({ ...identity, status: 'failed', summary: 'late network receipt' });
    assert.equal(final.status, 'completed');
    assert.equal(final.artifacts.length, 1);
    assert.equal(Object.hasOwn(final.artifacts[0], 'path'), false);
  } finally { tasks.close(); }
});

test('task HTTP cancellation checks room membership and survives core restart', async t => {
  const directory = await temporary(t);
  const matrix = http.createServer((request, response) => {
    const caller = request.headers.authorization === 'Bearer alice' ? '@alice:test' : '@bob:test';
    response.setHeader('Content-Type', 'application/json');
    if (request.url.endsWith('/whoami')) response.end(JSON.stringify({ user_id: caller }));
    else response.end(JSON.stringify({ joined: { '@alice:test': {}, '@finance:test': {} } }));
  });
  await new Promise(resolve => matrix.listen(0, '127.0.0.1', resolve));
  const config = { setup: { ...setup, homeserverUrl: `http://127.0.0.1:${matrix.address().port}` }, dataRoot: directory,
    authorizeNode(request) { if (request.headers.authorization !== 'Bearer node') throw Object.assign(new Error('Invalid node'), { status: 401 }); },
    async readJsonBody(request) { let body = ''; for await (const chunk of request) body += chunk; return JSON.parse(body); },
  };
  let tasks = new TaskService(config);
  tasks.update({ ...identity, taskId: 'shared-collaboration', status: 'running' });
  tasks.update({ ...identity, requestId: 'child-task', eventId: '$child', taskId: 'shared-collaboration', status: 'running' });
  const core = http.createServer((request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    tasks.handle({ request, url: new URL(request.url, 'http://local'), send }).catch(error => send(error.status || 500, { error: error.message }));
  });
  await new Promise(resolve => core.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${core.address().port}`;
  try {
    const forbidden = await fetch(`${base}/api/tasks/${identity.requestId}/cancel`, { method: 'POST', headers: { Authorization: 'Bearer bob' } });
    assert.equal(forbidden.status, 403);
    const cancelled = await fetch(`${base}/api/tasks/${identity.requestId}/cancel`, { method: 'POST', headers: { Authorization: 'Bearer alice' } });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).task.cancelRequested, true);
    assert.equal(tasks.get('child-task').cancelRequested, true);
    tasks.update({ ...identity, requestId: 'late-child', eventId: '$late-child', taskId: 'shared-collaboration', status: 'queued' });
    assert.equal(tasks.get('late-child').cancelRequested, true);
    tasks.close();
    tasks = new TaskService(config);
    const control = await fetch(`${base}/internal/tasks/${identity.requestId}/control`, { headers: { Authorization: 'Bearer node' } });
    assert.equal((await control.json()).cancelRequested, true);
    const list = await fetch(`${base}/api/rooms/${encodeURIComponent(identity.roomId)}/tasks`, { headers: { Authorization: 'Bearer alice' } });
    assert.equal((await list.json()).tasks.length, 3);
    assert.equal((await fetch(`${base}/internal/tasks/${identity.requestId}/control`)).status, 401);
  } finally {
    await new Promise(resolve => core.close(resolve));
    await new Promise(resolve => matrix.close(resolve));
    tasks.close();
  }
});
