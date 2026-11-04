import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { MatrixClient, MatrixError } from '../src/matrix-client.mjs';

async function mockServer(t, handler) {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    await handler(request, response, body ? JSON.parse(body) : undefined);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('send preserves identity-independent routing, task reference and Matrix reply relation', async t => {
  const baseUrl = await mockServer(t, (request, response, body) => {
    assert.equal(request.method, 'PUT');
    assert.equal(request.url, '/_matrix/client/v3/rooms/!room%3Ads-group.local/send/m.room.message/stable%2Ftransaction');
    assert.equal(request.headers.authorization, 'Bearer synthetic-access-token');
    assert.equal(body.msgtype, 'm.text');
    assert.equal(body.body, 'Please check the budget');
    assert.deepEqual(body['org.ds_group'], {
      to: ['@finance:ds-group.local'],
      replyTo: '$previous',
      taskId: 'task-1',
      returnTo: '@hr:ds-group.local',
      kind: 'task-result',
      hop: 2,
      originSenderId: '@alice:ds-group.local',
      originRoomId: '!private:ds-group.local',
      originEventId: '$original-request',
    });
    assert.deepEqual(body['m.relates_to'], { 'm.in_reply_to': { event_id: '$previous' } });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ event_id: '$message' }));
  });
  const client = new MatrixClient({ baseUrl, accessToken: 'synthetic-access-token' });
  assert.deepEqual(await client.send('!room:ds-group.local', 'Please check the budget', {
    transactionId: 'stable/transaction',
    to: ['@finance:ds-group.local'],
    replyTo: '$previous',
    taskId: 'task-1',
    returnTo: '@hr:ds-group.local',
    kind: 'task-result',
    hop: 2,
    originSenderId: '@alice:ds-group.local',
    originRoomId: '!private:ds-group.local',
    originEventId: '$original-request',
  }), { event_id: '$message' });
});

test('timeline returns events in chronological order and sync keeps its cursor', async t => {
  const baseUrl = await mockServer(t, (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url.includes('/messages?')) {
      assert.match(request.url, /\?dir=b&limit=20$/);
      response.end(JSON.stringify({ chunk: [{ event_id: '$newer' }, { event_id: '$older' }] }));
    } else {
      assert.equal(request.url, '/_matrix/client/v3/sync?timeout=1500&since=cursor%2Fone');
      response.end(JSON.stringify({ next_batch: 'cursor-two', rooms: {} }));
    }
  });
  const client = new MatrixClient({ baseUrl });
  assert.deepEqual(await client.timeline('!room:local', 20), [{ event_id: '$older' }, { event_id: '$newer' }]);
  assert.equal((await client.sync({ since: 'cursor/one', timeout: 1500 })).next_batch, 'cursor-two');
});

test('login uses an explicit user identity and returns the native Matrix receipt', async t => {
  const baseUrl = await mockServer(t, (request, response, body) => {
    assert.equal(request.url, '/_matrix/client/v3/login');
    assert.equal(request.headers.authorization, undefined);
    assert.deepEqual(body.identifier, { type: 'm.id.user', user: '@alice:local' });
    assert.equal(body.password, 'synthetic-password');
    assert.equal(body.device_id, 'DS_GROUP_FRAMEWORK');
    response.end(JSON.stringify({ user_id: '@alice:local', access_token: 'synthetic-token' }));
  });
  assert.deepEqual(await MatrixClient.login(baseUrl, '@alice:local', 'synthetic-password'), {
    user_id: '@alice:local', access_token: 'synthetic-token',
  });
});

test('Matrix errors retain their status and errcode without returning success', async t => {
  const baseUrl = await mockServer(t, (_request, response) => {
    response.statusCode = 401;
    response.end(JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown access token' }));
  });
  const client = new MatrixClient({ baseUrl });
  await assert.rejects(client.whoami(), error => error instanceof MatrixError && error.status === 401 && error.errcode === 'M_UNKNOWN_TOKEN');
  assert.throws(() => client.send('!room:local', 'message', { to: '@finance:local' }), /array/);
  assert.throws(() => client.send('!room:local', 'message', { originRoomId: '' }), /non-empty strings/);
  assert.throws(() => client.send('!room:local', 'message', { originEventId: 42 }), /non-empty strings/);
  assert.throws(() => client.sync({ timeout: -1 }), /timeout/);
});
