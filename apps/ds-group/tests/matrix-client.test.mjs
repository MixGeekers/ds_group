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

test('threaded file delivery keeps the root, explicit reply, mentions and original task thread separate', async t => {
  const attachment = { id: 'artifact', name: '结果.txt', contentUri: 'mxc://test/file', mimeType: 'text/plain', size: 5, sha256: 'a'.repeat(64) };
  const baseUrl = await mockServer(t, (request, response, content) => {
    assert.equal(request.method, 'PUT');
    assert.equal(content.msgtype, 'm.file');
    assert.equal(content.url, attachment.contentUri);
    assert.deepEqual(content['m.relates_to'], { rel_type: 'm.thread', event_id: '$thread-root', 'm.in_reply_to': { event_id: '$quoted-event' }, is_falling_back: false });
    assert.equal(content['org.ds_group'].threadRootId, '$thread-root');
    assert.equal(content['org.ds_group'].replyTo, '$quoted-event');
    assert.equal(content['org.ds_group'].originThreadRootId, '$original-thread');
    assert.equal(content['org.ds_group'].taskId, 'original-task');
    assert.deepEqual(content['org.ds_group'].attachments, [attachment]);
    assert.deepEqual(content['m.mentions'], { user_ids: ['@owner:test'] });
    response.end(JSON.stringify({ event_id: '$threaded-file' }));
  });
  const client = new MatrixClient({ baseUrl });
  assert.deepEqual(await client.send('!room:test', '结果', { transactionId: 'thread-file', threadRootId: '$thread-root', replyTo: '$quoted-event',
    taskId: 'original-task', originThreadRootId: '$original-thread', attachments: [attachment], mMentions: { user_ids: ['@owner:test'] } }), { event_id: '$threaded-file' });
});

test('a thread continuation without an explicit reply uses the standard root fallback and validates thread references', async t => {
  const contents = [];
  const baseUrl = await mockServer(t, (_request, response, content) => {
    contents.push(content);
    response.end(JSON.stringify({ event_id: `$sent-${contents.length}` }));
  });
  const client = new MatrixClient({ baseUrl });
  await client.send('!room:test', '线程消息', { threadRootId: '$root' });
  assert.deepEqual(contents[0]['m.relates_to'], { rel_type: 'm.thread', event_id: '$root', 'm.in_reply_to': { event_id: '$root' }, is_falling_back: true });
  assert.equal(contents[0]['org.ds_group'].replyTo, undefined);
  await client.send('!room:test', '普通消息', { originThreadRootId: '$source-thread' });
  assert.equal(contents[1]['m.relates_to'], undefined, 'Origin provenance alone does not put a delivery into a thread');
  assert.equal(contents[1]['org.ds_group'].originThreadRootId, '$source-thread');
  for (const options of [{ threadRootId: '' }, { threadRootId: 42 }, { originThreadRootId: null }]) {
    assert.throws(() => client.send('!room:test', '无效引用', options), /non-empty strings/);
  }
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
    assert.match(body.device_id, /^DSCORD_[a-f0-9-]+$/);
    response.end(JSON.stringify({ user_id: '@alice:local', access_token: 'synthetic-token' }));
  });
  assert.deepEqual(await MatrixClient.login(baseUrl, '@alice:local', 'synthetic-password'), {
    user_id: '@alice:local', access_token: 'synthetic-token',
  });
});

test('login permits a separate stable service device without reusing browser device IDs', async t => {
  const devices = [];
  const baseUrl = await mockServer(t, (_request, response, body) => {
    devices.push(body.device_id);
    response.end(JSON.stringify({ user_id: '@alice:local', access_token: `token-${devices.length}` }));
  });
  await MatrixClient.login(baseUrl, '@alice:local', 'password');
  await MatrixClient.login(baseUrl, '@alice:local', 'password');
  await MatrixClient.login(baseUrl, '@alice:local', 'password', { deviceId: 'DSCORD_CORE_ALICE', deviceName: 'Server' });
  assert.notEqual(devices[0], devices[1]);
  assert.equal(devices[2], 'DSCORD_CORE_ALICE');
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

test('Matrix rate-limit errors retain millisecond retry hints and fall back to Retry-After headers', async t => {
  const baseUrl = await mockServer(t, (request, response) => {
    response.statusCode = 429;
    const hints = {
      '/milliseconds': { body: { retry_after_ms: 1250 }, header: '99' },
      '/seconds': { body: {}, header: '5' },
      '/date': { body: {}, header: new Date(Date.now() + 60000).toUTCString() },
      '/invalid': { body: { retry_after_ms: -1 }, header: 'invalid' },
    }[request.url];
    response.setHeader('Retry-After', hints.header);
    response.end(JSON.stringify({ errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests', ...hints.body }));
  });
  const client = new MatrixClient({ baseUrl });
  await assert.rejects(client.request('GET', '/milliseconds'), error => error.retryAfterMs === 1250 && error.errcode === 'M_LIMIT_EXCEEDED' && error.status === 429);
  await assert.rejects(client.request('GET', '/seconds'), error => error.retryAfterMs === 5000);
  await assert.rejects(client.request('GET', '/date'), error => error.retryAfterMs > 58000 && error.retryAfterMs <= 60000);
  await assert.rejects(client.request('GET', '/invalid'), error => error.retryAfterMs === undefined);
});

test('Matrix requests forward only a validated client address supplied by the caller', async t => {
  const addresses = [];
  const baseUrl = await mockServer(t, (request, response) => {
    addresses.push(request.headers['x-forwarded-for']);
    response.end('{}');
  });
  const client = new MatrixClient({ baseUrl });
  await client.request('POST', '/login', {}, { clientIp: '192.0.2.10' });
  await client.request('POST', '/login', {}, { clientIp: '2001:db8::7' });
  await client.request('POST', '/login', {});
  for (const clientIp of ['', '192.0.2.1, 192.0.2.2', '127.0.0.1\r\nX-Test: value', 'a'.repeat(20000), 123]) {
    await assert.rejects(client.request('POST', '/login', {}, { clientIp }), /Invalid client IP/);
  }
  assert.deepEqual(addresses, ['192.0.2.10', '2001:db8::7', undefined]);
});
