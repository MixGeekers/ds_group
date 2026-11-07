import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../src/core.mjs';

const roomId = '!attachments:fixture.test';
const participants = [
  { id: '@alice:fixture.test', localpart: 'alice', name: 'Alice', kind: 'human', accessToken: 'synthetic-alice' },
  { id: '@bob:fixture.test', localpart: 'bob', name: 'Bob', kind: 'human', accessToken: 'synthetic-bob' },
  { id: '@finance:fixture.test', localpart: 'finance', name: 'Finance', kind: 'bot', accessToken: 'synthetic-finance' },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, { maxUploadBytes = 1024, uploadDelay = 0, upstreamRanges = false } = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'ds-group-media-'));
  const storedMedia = new Map();
  const events = new Map();
  const transactions = new Map();
  const calls = [];
  const matrix = createServer(async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      const actor = participants.find(person => request.headers.authorization === `Bearer ${person.accessToken}`);
      if (!actor) return json(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown fixture token' });
      const url = new URL(request.url, 'http://matrix.fixture');
      const pathname = decodeURIComponent(url.pathname);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      calls.push({ method: request.method, pathname, actor: actor.id, bytes });

      if (request.method === 'GET' && pathname === '/_matrix/client/v3/account/whoami') {
        return json(200, { user_id: actor.id });
      }
      if (request.method === 'POST' && pathname === '/_matrix/media/v3/upload') {
        assert.equal(request.headers['content-length'], String(bytes.length), 'Synapse requires the exact Content-Length for streamed media');
        assert.equal(request.headers['transfer-encoding'], undefined, 'The known-size media stream must not use chunked transfer encoding');
        if (uploadDelay) await new Promise(resolve => setTimeout(resolve, uploadDelay));
        const mediaId = `media-${storedMedia.size + 1}`;
        storedMedia.set(mediaId, { bytes, mimeType: request.headers['content-type'], name: url.searchParams.get('filename') });
        return json(200, { content_uri: `mxc://fixture.test/${mediaId}` });
      }
      const download = pathname.match(/^\/_matrix\/client\/v1\/media\/download\/fixture\.test\/(media-[0-9]+)$/);
      if (request.method === 'GET' && download) {
        const media = storedMedia.get(download[1]);
        if (!media) return json(404, { errcode: 'M_NOT_FOUND', error: 'Unknown fixture media' });
        if (upstreamRanges && request.headers.range) {
          const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
          const start = Number(first);
          const end = Math.min(Number(last), media.bytes.length - 1);
          response.writeHead(206, { 'Content-Type': media.mimeType, 'Content-Length': media.declaredRangeLength ?? end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${media.bytes.length}` });
          response.end(media.bytes.subarray(start, end + 1));
          return;
        }
        response.writeHead(200, { 'Content-Type': media.mimeType, 'Content-Length': media.bytes.length });
        response.end(media.bytes);
        return;
      }
      if (request.method === 'GET' && pathname === '/_matrix/client/v3/joined_rooms') {
        return json(200, { joined_rooms: [roomId] });
      }
      const room = pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/(.+)$/);
      if (room && room[1] === roomId) {
        if (request.method === 'GET' && room[2] === 'joined_members') {
          return json(200, { joined: Object.fromEntries(participants.map(person => [person.id, { display_name: person.name }])) });
        }
        if (request.method === 'GET' && room[2] === 'state/m.room.name/') return json(200, { name: 'Attachments' });
        if (request.method === 'GET' && room[2] === 'state/m.room.power_levels/') {
          return json(200, { users: { [participants[0].id]: 100 }, users_default: 0 });
        }
        if (request.method === 'GET' && room[2].startsWith('state/m.room.member/')) {
          return json(200, { membership: 'join' });
        }
        if (request.method === 'GET' && room[2] === 'messages') {
          return json(200, { chunk: [...events.values()].reverse() });
        }
        if (request.method === 'GET' && room[2].startsWith('event/')) {
          const event = events.get(room[2].slice('event/'.length));
          return event ? json(200, event) : json(404, { errcode: 'M_NOT_FOUND', error: 'Unknown fixture event' });
        }
        if (request.method === 'PUT' && room[2].startsWith('send/m.room.message/')) {
          const key = `${actor.id}/${room[2]}`;
          let eventId = transactions.get(key);
          if (!eventId) {
            eventId = `$event-${events.size + 1}`;
            transactions.set(key, eventId);
            events.set(eventId, { event_id: eventId, room_id: roomId, sender: actor.id,
              type: 'm.room.message', origin_server_ts: Date.now(), content: JSON.parse(bytes.toString('utf8')) });
          }
          return json(200, { event_id: eventId });
        }
      }
      return json(404, { errcode: 'M_UNRECOGNIZED', error: `Unimplemented fixture route ${pathname}` });
    } catch (error) {
      if (!response.headersSent) json(500, { errcode: 'M_UNKNOWN', error: error.message });
      else response.destroy(error);
    }
  });
  const homeserverUrl = await listen(matrix);
  let core;
  let baseUrl;
  async function startCore() {
    core = await createCore({ setup: { homeserverUrl, roomId, participants },
      config: { nodeSecret: 'synthetic-node-secret', maxUploadBytes }, dataRoot, enablePush: false });
    baseUrl = await listen(core.server);
  }
  t.after(async () => {
    if (core) await core.close();
    await new Promise(resolve => matrix.close(resolve));
    await rm(dataRoot, { recursive: true, force: true });
  });
  await startCore();
  const tokenFor = name => participants.find(person => person.localpart === name)?.accessToken;
  async function upload({ actor = 'alice', id = 'upload-one', name = 'sample.bin', mimeType = 'application/octet-stream', bytes = Buffer.from('sample'), chunked = false } = {}) {
    const body = chunked ? new ReadableStream({
      start(stream) {
        stream.enqueue(bytes.subarray(0, Math.floor(bytes.length / 2)));
        stream.enqueue(bytes.subarray(Math.floor(bytes.length / 2)));
        stream.close();
      },
    }) : bytes;
    const response = await fetch(`${baseUrl}/api/attachments?filename=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${tokenFor(actor)}`, 'Content-Type': mimeType, 'X-Upload-Id': id }, body,
      ...(chunked ? { duplex: 'half' } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  async function request(actor, method, route, body, headers = {}) {
    return fetch(baseUrl + route, { method,
      headers: { ...headers, ...(actor ? { Authorization: `Bearer ${tokenFor(actor)}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function send(actor, input) {
    const response = await request(actor, 'POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, input);
    return { status: response.status, body: await response.json() };
  }
  async function abortUpload(id) {
    const controller = new AbortController();
    const body = new ReadableStream({ start(stream) { stream.enqueue(Buffer.from('partial upload')); } });
    const pending = fetch(`${baseUrl}/api/attachments?filename=interrupted.txt`, {
      method: 'POST', duplex: 'half', body, signal: controller.signal,
      headers: { Authorization: `Bearer ${tokenFor('alice')}`, 'Content-Type': 'text/plain', 'X-Upload-Id': id },
    });
    const cancellation = setTimeout(() => controller.abort(), 50);
    try { await assert.rejects(pending, error => error.name === 'AbortError'); }
    finally { clearTimeout(cancellation); }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  async function restart() {
    await core.close();
    core = undefined;
    await startCore();
  }
  return { upload, request, send, abortUpload, restart, events, storedMedia, calls };
}

function successfulUpload(result) {
  assert.ok([200, 201].includes(result.status), JSON.stringify(result));
  assert.ok(result.body.attachment?.id);
  return result.body.attachment;
}

test('binary attachments preserve original bytes and Unicode names through upload, message and authenticated download', async t => {
  const app = await fixture(t);
  const bytes = Buffer.from([0, 255, 254, 128, 13, 10, 0, 241, 127]);
  const name = '费用明细 你好.bin';
  const attachment = successfulUpload(await app.upload({ bytes, name }));
  assert.equal(attachment.name, name);
  assert.equal(attachment.mimeType, 'application/octet-stream');
  assert.equal(attachment.size, bytes.length);
  assert.equal(attachment.sha256, hash(bytes));
  assert.match(attachment.contentUri, /^mxc:\/\/fixture\.test\//);
  assert.equal(app.storedMedia.size, 1);
  assert.deepEqual([...app.storedMedia.values()][0].bytes, bytes);

  const sent = await app.send('alice', { body: '', attachments: [attachment.id], to: [], transactionId: 'file-message-one' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const downloaded = await app.request('bob', 'GET', `/api/attachments/${encodeURIComponent(attachment.id)}?download=1`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), attachment.mimeType);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  const metadata = await app.request('alice', 'GET', `/api/attachments/${encodeURIComponent(attachment.id)}/metadata`);
  assert.equal(metadata.status, 200);
  const value = await metadata.json();
  assert.equal((value.attachment || value).sha256, hash(bytes));
  assert.equal((await app.request(undefined, 'GET', `/api/attachments/${encodeURIComponent(attachment.id)}`)).status, 401);
});

test('single byte ranges stream from a full upstream response and survive a Core restart', async t => {
  const app = await fixture(t, { maxUploadBytes: 1024 * 1024 });
  const bytes = Buffer.alloc(256 * 1024);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const attachment = successfulUpload(await app.upload({ bytes }));
  const route = `/api/attachments/${attachment.id}`;
  for (const [range, start, end] of [['bytes=65530-131100', 65530, 131100], ['bytes=262100-', 262100, bytes.length - 1],
    ['bytes=-31', bytes.length - 31, bytes.length - 1], ['bytes=0-999999', 0, bytes.length - 1]]) {
    const response = await app.request('alice', 'GET', route, undefined, { Range: range });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.equal(response.headers.get('content-length'), String(end - start + 1));
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  await app.restart();
  const reopened = await app.request('alice', 'GET', route, undefined, { Range: 'bytes=17-39' });
  assert.equal(reopened.status, 206);
  assert.deepEqual(Buffer.from(await reopened.arrayBuffer()), bytes.subarray(17, 40));
  const whole = await app.request('alice', 'GET', route);
  assert.equal(whole.status, 200);
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);
});

test('unsatisfiable and malformed ranges are rejected before contacting the media provider', async t => {
  const app = await fixture(t);
  const attachment = successfulUpload(await app.upload({ bytes: Buffer.from('12345') }));
  const route = `/api/attachments/${attachment.id}`;
  for (const range of ['bytes=5-', 'bytes=4-2', 'bytes=-0', 'bytes=99999999999999999999999-']) {
    const response = await app.request('alice', 'GET', route, undefined, { Range: range });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */5');
    await response.arrayBuffer();
  }
  for (const range of ['bytes=-', 'bytes=0-1,3-4', 'bytes=a-b']) {
    const response = await app.request('alice', 'GET', route, undefined, { Range: range });
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  }
  assert.equal(app.calls.filter(call => call.pathname.includes('/media/download/')).length, 0);
});

test('a provider with native partial responses keeps its byte range and changed media size is rejected', async t => {
  const app = await fixture(t, { upstreamRanges: true });
  const bytes = Buffer.from('original-media');
  const attachment = successfulUpload(await app.upload({ bytes }));
  const route = `/api/attachments/${attachment.id}`;
  const partial = await app.request('alice', 'GET', route, undefined, { Range: 'bytes=2-5' });
  assert.equal(partial.status, 206);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(2, 6));
  const stored = app.storedMedia.values().next().value;
  stored.declaredRangeLength = 1;
  const invalidLength = await app.request('alice', 'GET', route, undefined, { Range: 'bytes=2-5' });
  assert.equal(invalidLength.status, 502);
  assert.match((await invalidLength.json()).error, /unexpected byte range/);
  delete stored.declaredRangeLength;
  app.storedMedia.values().next().value.bytes = Buffer.from('changed');
  const changed = await app.request('alice', 'GET', route);
  assert.equal(changed.status, 502);
  assert.match((await changed.json()).error, /size differs/);
  const invalidRange = await app.request('alice', 'GET', route, undefined, { Range: 'bytes=2-5' });
  assert.equal(invalidRange.status, 502);
  assert.match((await invalidRange.json()).error, /unexpected byte range/);
});

test('upload identity deduplicates concurrent retries and survives core restart while conflicting content is rejected', async t => {
  const app = await fixture(t, { uploadDelay: 30 });
  const input = { id: 'same-upload', name: 'data.csv', mimeType: 'text/csv', bytes: Buffer.from('name,value\nA,4\n') };
  const concurrent = await Promise.all([app.upload(input), app.upload(input)]);
  const first = successfulUpload(concurrent[0]);
  const second = successfulUpload(concurrent[1]);
  assert.equal(second.id, first.id);
  assert.equal(app.storedMedia.size, 1);
  await app.restart();
  const repeated = successfulUpload(await app.upload(input));
  assert.deepEqual(repeated, first);
  assert.equal(app.storedMedia.size, 1);
  const conflict = await app.upload({ ...input, bytes: Buffer.from('name,value\nA,9\n') });
  assert.equal(conflict.status, 409);
  assert.equal(app.storedMedia.size, 1);
});

test('attachment-only multi-file messages deduplicate concurrent delivery and reject changed content after restart', async t => {
  const app = await fixture(t);
  const sheet = successfulUpload(await app.upload({ id: 'sheet', name: 'expenses.csv', mimeType: 'text/csv', bytes: Buffer.from('amount\n120\n') }));
  const note = successfulUpload(await app.upload({ id: 'note', name: 'instructions.txt', mimeType: 'text/plain', bytes: Buffer.from('Calculate the total.') }));
  const input = { body: '', attachments: [sheet.id, note.id], to: [participants[2].id], transactionId: 'two-files' };
  const [first, concurrent] = await Promise.all([app.send('alice', input), app.send('alice', input)]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(concurrent.status, 200, JSON.stringify(concurrent.body));
  assert.equal(concurrent.body.event_id, first.body.event_id);
  assert.equal(app.events.size, 1);
  const event = app.events.get(first.body.event_id);
  assert.equal(event.content.msgtype, 'm.file');
  assert.equal(event.content.url, sheet.contentUri);
  assert.equal(event.content.filename, sheet.name);
  assert.deepEqual(event.content['org.ds_group'].to, [participants[2].id]);
  assert.deepEqual(event.content['org.ds_group'].attachments.map(item => item.id), [sheet.id, note.id]);
  assert.ok(event.content.body.length > 0);
  await app.restart();
  const repeated = await app.send('alice', input);
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(repeated.body.event_id, first.body.event_id);
  const changedBody = await app.send('alice', { ...input, body: 'A changed instruction' });
  assert.equal(changedBody.status, 409, JSON.stringify(changedBody.body));
  const changedAttachmentOrder = await app.send('alice', { ...input, attachments: [note.id, sheet.id] });
  assert.equal(changedAttachmentOrder.status, 409, JSON.stringify(changedAttachmentOrder.body));
  assert.equal(app.events.size, 1);
  const downloaded = await app.request('finance', 'GET', `/api/attachments/${encodeURIComponent(note.id)}`);
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), 'Calculate the total.');
});

test('Bot-generated artifacts upload with Bot credentials and preserve original task and reply references', async t => {
  const app = await fixture(t);
  const source = await app.send('alice', { body: 'Please calculate the expense total.', to: [], transactionId: 'source-request' });
  assert.equal(source.status, 200);
  const artifact = successfulUpload(await app.upload({ actor: 'finance', id: 'task-output-v1', name: 'summary.csv', mimeType: 'text/csv', bytes: Buffer.from('total\n360\n') }));
  const sent = await app.send('finance', { body: '核算完成', attachments: [artifact.id], to: [], transactionId: 'task-delivery',
    replyTo: source.body.event_id, taskId: 'task-expense', kind: 'reply', originRoomId: roomId,
    originEventId: source.body.event_id, originSenderId: participants[0].id });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const event = app.events.get(sent.body.event_id);
  assert.equal(event.sender, participants[2].id);
  assert.equal(event.content['org.ds_group'].taskId, 'task-expense');
  assert.equal(event.content['m.relates_to']['m.in_reply_to'].event_id, source.body.event_id);
  assert.equal(event.content['org.ds_group'].attachments[0].sha256, artifact.sha256);
  const downloaded = await app.request('alice', 'GET', `/api/attachments/${encodeURIComponent(artifact.id)}`);
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), 'total\n360\n');
});

test('threaded Bot artifacts retain the root and explicit reply alongside files and reply mentions', async t => {
  const app = await fixture(t);
  const root = await app.send('alice', { body: '线程里的费用核算', transactionId: 'file-thread-root' });
  const request = await app.send('alice', { body: '请生成汇总文件', threadRootId: root.body.event_id, transactionId: 'file-thread-request' });
  assert.equal(request.status, 200);
  const artifact = successfulUpload(await app.upload({ actor: 'finance', id: 'thread-output', name: '线程汇总.csv', mimeType: 'text/csv', bytes: Buffer.from('total\n360\n') }));
  const sent = await app.send('finance', { body: '核算完成', attachments: [artifact.id], transactionId: 'file-thread-result',
    threadRootId: root.body.event_id, replyTo: request.body.event_id, originThreadRootId: root.body.event_id, taskId: 'thread-expense' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const event = app.events.get(sent.body.event_id);
  assert.equal(event.content.msgtype, 'm.file');
  assert.deepEqual(event.content['m.relates_to'], { rel_type: 'm.thread', event_id: root.body.event_id,
    'm.in_reply_to': { event_id: request.body.event_id }, is_falling_back: false });
  assert.deepEqual(event.content['m.mentions'].user_ids, [participants[0].id]);
  assert.equal(event.content['org.ds_group'].taskId, 'thread-expense');
  assert.equal(event.content['org.ds_group'].originThreadRootId, root.body.event_id);
  assert.equal(event.content['org.ds_group'].attachments[0].sha256, artifact.sha256);
});

test('oversized uploads fail before Matrix receives content and a later valid upload is usable', async t => {
  const app = await fixture(t, { maxUploadBytes: 32 });
  const oversized = await app.upload({ id: 'too-large', bytes: Buffer.alloc(33, 7) });
  assert.equal(oversized.status, 413, JSON.stringify(oversized.body));
  assert.equal(app.storedMedia.size, 0);
  const oversizedStream = await app.upload({ id: 'chunked-too-large', bytes: Buffer.alloc(33, 9), chunked: true });
  assert.equal(oversizedStream.status, 413, JSON.stringify(oversizedStream.body));
  assert.equal(app.storedMedia.size, 0);
  const small = successfulUpload(await app.upload({ id: 'small', bytes: Buffer.from('usable') }));
  assert.equal(small.size, 6);
  assert.equal(app.storedMedia.size, 1);
});

test('an interrupted upload can be retried with the same identity without publishing partial bytes', async t => {
  const app = await fixture(t);
  await app.abortUpload('interrupted-upload');
  assert.equal(app.storedMedia.size, 0);
  const bytes = Buffer.from('A complete retry.');
  const attachment = successfulUpload(await app.upload({ id: 'interrupted-upload', name: 'interrupted.txt', mimeType: 'text/plain', bytes }));
  assert.equal(attachment.sha256, hash(bytes));
  assert.deepEqual([...app.storedMedia.values()][0].bytes, bytes);
  assert.equal(app.storedMedia.size, 1);
});

test('unknown attachments fail before message delivery and client-supplied metadata cannot replace stored identity', async t => {
  const app = await fixture(t);
  const missing = await app.send('alice', { body: '', attachments: ['missing-attachment'], to: [], transactionId: 'missing-file' });
  assert.ok([400, 404].includes(missing.status), JSON.stringify(missing));
  assert.equal(app.events.size, 0);
  const attachment = successfulUpload(await app.upload({ id: 'trusted-metadata', name: 'original.txt', mimeType: 'text/plain', bytes: Buffer.from('original bytes') }));
  const sent = await app.send('alice', { body: 'Read this file', attachments: [{ id: attachment.id, name: 'forged.txt',
    sha256: '0'.repeat(64), contentUri: 'mxc://foreign.test/forged' }], to: [], transactionId: 'stored-metadata' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const stored = app.events.get(sent.body.event_id).content['org.ds_group'].attachments[0];
  assert.equal(stored.name, attachment.name);
  assert.equal(stored.sha256, attachment.sha256);
  assert.equal(stored.contentUri, attachment.contentUri);
});
