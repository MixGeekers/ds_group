import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { TaskService } from '../src/tasks.mjs';

const people = [
  { id: '@alice:delivery.test', kind: 'human' }, { id: '@bob:delivery.test', kind: 'human' },
  { id: '@finance:delivery.test', kind: 'bot' }, { id: '@hr:delivery.test', kind: 'bot' },
];
const setup = { homeserverUrl: 'http://127.0.0.1:1', participants: people };
const parent = { requestId: 'parent', taskId: 'family', botId: people[2].id, roomId: '!source:delivery.test', eventId: '$parent' };
const child = { ...parent, requestId: 'child', botId: people[3].id, eventId: '$child' };
const artifact = { id: 'private-result', name: 'summary.csv', mimeType: 'text/csv', size: 12, contentUri: 'mxc://delivery.test/private-result' };
const direct = { kind: 'direct', recipientId: people[0].id, state: 'requested', authoritative: true,
  originBotId: people[2].id, sourceEventId: '$delivery-directive' };

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-task-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('delivery authority and revisions persist and delegated controls follow the original task', async t => {
  const directory = await temporary(t);
  let tasks = new TaskService({ setup, dataRoot: directory });
  tasks.update({ ...parent, status: 'running', delivery: { kind: 'origin', state: 'requested', authoritative: true } });
  tasks.update({ ...child, status: 'running', delivery: { kind: 'origin', state: 'requested', authoritative: false, originBotId: people[2].id } });
  const updated = tasks.update({ ...parent, status: 'running', delivery: direct });
  assert.equal(updated.deliveryRevision, 2);
  assert.equal(updated.roomId, parent.roomId);
  assert.deepEqual(tasks.control(child.requestId).delivery, updated.delivery);
  tasks.update({ ...child, status: 'running', delivery: { kind: 'direct', recipientId: people[1].id, state: 'requested', authoritative: false, originBotId: people[2].id } });
  assert.equal(tasks.control(child.requestId).delivery.recipientId, people[0].id);
  assert.equal(tasks.control(child.requestId).deliveryRevision, 2);
  assert.equal(tasks.update({ ...parent, status: 'running', delivery: { sourceEventId: direct.sourceEventId, authoritative: true,
    recipientId: direct.recipientId, originBotId: direct.originBotId, kind: 'direct', state: 'requested' } }).deliveryRevision, 2);
  tasks.close();
  tasks = new TaskService({ setup, dataRoot: directory });
  try {
    assert.deepEqual(tasks.control(child.requestId).delivery, updated.delivery);
    assert.equal(tasks.get(parent.requestId).deliveryRevision, 2);
    const unrelated = { ...parent, requestId: 'new-work', taskId: 'new-family', eventId: '$new' };
    tasks.update({ ...unrelated, status: 'running', delivery: { kind: 'origin', authoritative: true } });
    assert.equal(tasks.control(unrelated.requestId).delivery.kind, 'origin');
    assert.deepEqual(tasks.control('unknown-request'), { requestId: 'unknown-request', cancelRequested: false });
  } finally { tasks.close(); }
});

test('the first sending state freezes the recipient and room while completion can advance to sent', async t => {
  const tasks = new TaskService({ setup, dataRoot: await temporary(t) });
  try {
    const frozen = { ...direct, roomId: '!private:delivery.test', state: 'sending' };
    const first = tasks.update({ ...parent, status: 'running', delivery: frozen });
    const late = tasks.update({ ...parent, status: 'running', delivery: { kind: 'origin', authoritative: true, sourceEventId: '$late' } });
    assert.deepEqual(late.delivery, first.delivery);
    assert.equal(late.deliveryRevision, first.deliveryRevision);
    const final = tasks.update({ ...parent, status: 'completed', delivery: { ...frozen, state: 'sent' }, artifacts: [artifact] });
    assert.equal(final.delivery.state, 'sent');
    assert.equal(final.deliveryRevision, first.deliveryRevision + 1);
    assert.equal(tasks.update({ ...parent, status: 'failed', delivery: direct }).status, 'completed');
    assert.equal(tasks.visibleInRoom(final, parent.roomId).artifacts.length, 0);
    assert.equal(tasks.visibleInRoom(final, frozen.roomId).artifacts.length, 1);
  } finally { tasks.close(); }
});

test('multiple Bots addressed by one event keep independent authoritative delivery routes', async t => {
  const directory = await temporary(t);
  let tasks = new TaskService({ setup, dataRoot: directory });
  const hrRoot = { ...parent, requestId: 'hr-root', botId: people[3].id };
  const hrChild = { ...parent, requestId: 'hr-child', eventId: '$hr-child' };
  tasks.update({ ...parent, status: 'running', delivery: direct });
  tasks.update({ ...child, status: 'running', delivery: { kind: 'origin', authoritative: false, originBotId: parent.botId } });
  tasks.update({ ...hrRoot, status: 'running', delivery: { kind: 'origin', authoritative: true } });
  tasks.update({ ...hrChild, status: 'running', delivery: { kind: 'origin', authoritative: false, originBotId: hrRoot.botId } });
  assert.equal(tasks.control(parent.requestId).delivery.kind, 'direct');
  assert.equal(tasks.control(child.requestId).delivery.originBotId, parent.botId);
  assert.equal(tasks.control(hrRoot.requestId).delivery.kind, 'origin');
  assert.equal(tasks.control(hrChild.requestId).delivery.originBotId, hrRoot.botId);
  tasks.update({ ...parent, status: 'running', delivery: { ...direct, roomId: '!finance-dm:delivery.test', state: 'resolved' } });
  assert.equal(tasks.control(hrRoot.requestId).delivery.kind, 'origin');
  assert.equal(tasks.control(hrChild.requestId).delivery.kind, 'origin');
  tasks.close();
  tasks = new TaskService({ setup, dataRoot: directory });
  try {
    assert.equal(tasks.control(child.requestId).delivery.roomId, '!finance-dm:delivery.test');
    assert.equal(tasks.control(hrChild.requestId).delivery.kind, 'origin');
  } finally { tasks.close(); }
});

test('legacy task databases gain delivery columns without altering prior receipts', async t => {
  const directory = await temporary(t);
  const db = new DatabaseSync(path.join(directory, 'tasks.sqlite'));
  db.exec(`CREATE TABLE file_tasks (request_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,room_id TEXT NOT NULL,
    event_id TEXT NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL,summary TEXT NOT NULL,artifacts_json TEXT NOT NULL,
    tool_calls INTEGER NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,task_id TEXT)`);
  db.prepare('INSERT INTO file_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(parent.requestId, parent.botId, parent.roomId,
    parent.eventId, 'running', 'tool', 'existing state', '[]', 4, 0, 100, 101, parent.taskId);
  db.close();
  const tasks = new TaskService({ setup, dataRoot: directory });
  try {
    const before = tasks.get(parent.requestId);
    assert.equal(before.summary, 'existing state');
    assert.equal(before.createdAt, 100);
    assert.equal(before.delivery, undefined);
    const after = tasks.update({ ...parent, status: 'running', delivery: direct });
    assert.equal(after.toolCalls, 4);
    assert.equal(after.createdAt, 100);
    assert.equal(after.deliveryRevision, 1);
  } finally { tasks.close(); }
});

test('delivery input rejects nonhuman recipients and a child cannot claim another Bot’s authority', async t => {
  const tasks = new TaskService({ setup, dataRoot: await temporary(t) });
  try {
    assert.throws(() => tasks.update({ ...parent, status: 'running', delivery: { ...direct, recipientId: people[3].id } }), /registered human/);
    assert.throws(() => tasks.update({ ...child, status: 'running', delivery: direct }), /original Bot/);
    tasks.update({ ...parent, status: 'running', delivery: direct });
    assert.throws(() => tasks.update({ ...parent, status: 'running', delivery: { ...direct, authoritative: false } }), /authority cannot change/);
    assert.throws(() => tasks.update({ ...parent, status: 'running', delivery: { ...direct, state: 'unrecognized' } }), /Invalid delivery state/);
  } finally { tasks.close(); }
});

test('task HTTP exposes private artifacts in their delivery room and hides them in the source room', async t => {
  const directory = await temporary(t);
  const dmRoom = '!private:delivery.test';
  const childRoom = '!bot-private:delivery.test';
  const roomMembers = new Map([
    [parent.roomId, people.map(person => person.id)],
    [dmRoom, [people[0].id, people[2].id]],
    [childRoom, [people[2].id, people[3].id]],
  ]);
  const matrix = createServer((request, response) => {
    const actor = request.headers.authorization === 'Bearer alice' ? people[0].id : people[1].id;
    response.setHeader('Content-Type', 'application/json');
    if (request.url.endsWith('/whoami')) return response.end(JSON.stringify({ user_id: actor }));
    const roomId = decodeURIComponent(request.url).match(/\/rooms\/([^/]+)\/joined_members$/)?.[1];
    const members = roomMembers.get(roomId) ?? [];
    response.end(JSON.stringify({ joined: Object.fromEntries(members.map(id => [id, {}])) }));
  });
  await new Promise(resolve => matrix.listen(0, '127.0.0.1', resolve));
  const tasks = new TaskService({ setup: { ...setup, homeserverUrl: `http://127.0.0.1:${matrix.address().port}` }, dataRoot: directory,
    authorizeNode(request) { if (request.headers.authorization !== 'Bearer node') throw Object.assign(new Error('Invalid node'), { status: 401 }); },
    async readJsonBody() { return {}; } });
  tasks.update({ ...parent, status: 'running', delivery: { ...direct, roomId: dmRoom, state: 'resolved' }, artifacts: [artifact] });
  tasks.update({ ...child, roomId: childRoom, status: 'running',
    delivery: { ...direct, roomId: dmRoom, state: 'resolved', authoritative: false } });
  const server = createServer((request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    tasks.handle({ request, url: new URL(request.url, 'http://fixture'), send }).catch(error => send(error.status || 500, { error: error.message }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const read = async (roomId, token) => fetch(`${base}/api/rooms/${encodeURIComponent(roomId)}/tasks`, { headers: { Authorization: `Bearer ${token}` } });
    const source = await (await read(parent.roomId, 'bob')).json();
    assert.equal(source.tasks.length, 1);
    assert.equal(source.tasks.find(task => task.requestId === parent.requestId).artifacts.length, 0);
    const delivered = await (await read(dmRoom, 'alice')).json();
    assert.equal(delivered.tasks.length, 1);
    assert.equal(delivered.tasks[0].roomId, parent.roomId);
    assert.equal(delivered.tasks[0].delivery.roomId, dmRoom);
    assert.equal(delivered.tasks[0].artifacts[0].id, artifact.id);
    assert.equal((await read(dmRoom, 'bob')).status, 403);
    assert.equal((await read(childRoom, 'alice')).status, 403);
    const deniedChildCancel = await fetch(`${base}/api/tasks/${child.requestId}/cancel`, { method: 'POST', headers: { Authorization: 'Bearer alice' } });
    assert.equal(deniedChildCancel.status, 403);
    roomMembers.get(childRoom).push(people[0].id);
    const childSource = await (await read(childRoom, 'alice')).json();
    assert.deepEqual(childSource.tasks.map(task => task.requestId), [child.requestId]);
    const control = await fetch(`${base}/internal/tasks/${child.requestId}/control`, { headers: { Authorization: 'Bearer node' } });
    assert.equal((await control.json()).delivery.recipientId, people[0].id);
    const cancelled = await fetch(`${base}/api/tasks/${parent.requestId}/cancel`, { method: 'POST', headers: { Authorization: 'Bearer alice' } });
    assert.equal((await cancelled.json()).task.artifacts.length, 0);
    assert.equal(tasks.control(child.requestId).cancelRequested, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => matrix.close(resolve));
    tasks.close();
  }
});
