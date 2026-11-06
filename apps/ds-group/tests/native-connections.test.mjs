import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeConnections } from '../dsh-connect/native-connections.mjs';
import { NativeBots } from '../dsh-connect/native-bots.mjs';

test('native connection processes Matrix traffic in the original Bot and disconnects only its transport', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'native-connection-'));
  const bot = { id: '@bot:home.test', localpart: 'bot', name: 'Native', kind: 'bot', accessToken: 'synthetic' };
  const human = { id: '@alice:home.test', name: 'Alice', kind: 'human' };
  const participants = [bot, human]; const room = '!group:home.test';
  const incoming = { type: 'm.room.message', event_id: '$input', room_id: room, sender: human.id,
    content: { body: '请回复当前群', 'org.ds_group': { to: [bot.id], conversationKind: 'group' } } };
  const sent = []; const failures = []; let synced = false; let streamCalls = 0; let cancelled = 0; let heartbeat;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      let value = {};
      if (url.pathname === '/api/bootstrap') value = { participants };
      else if (url.pathname === '/internal/nodes/heartbeat') {
        const next = JSON.parse(Buffer.concat(chunks));
        if (heartbeat && heartbeat.status !== 'offline' && heartbeat.runtimeId !== next.runtimeId) {
          response.writeHead(409, { 'content-type': 'application/json' }); response.end('{"error":"Node already has an active runtime"}'); return;
        }
        heartbeat = next;
      }
      else if (url.pathname.endsWith('/directory')) value = { participants };
      else if (url.pathname.endsWith('/work')) value = { mode: 'native', participants, event: incoming };
      else if (url.pathname.endsWith('/sync')) {
        await new Promise(resolve => setTimeout(resolve, 30));
        value = { next_batch: 'next', rooms: { join: { [room]: { state: { events: [{ type: 'm.room.name', content: { name: '测试群' } }] }, timeline: { events: synced ? [] : [incoming] } } } } }; synced = true;
      } else if (url.pathname.endsWith('/messages')) value = { chunk: [incoming] };
      else if (url.pathname.includes('/send/')) { sent.push({ roomId: decodeURIComponent(url.pathname.split('/rooms/')[1].split('/')[0]), content: JSON.parse(Buffer.concat(chunks)) }); value = { event_id: '$reply' }; }
      else if (url.pathname.endsWith('/control')) value = { cancelRequested: false };
      else if (url.pathname.endsWith('/check-local-delivery')) value = { authorized: true };
      else if (!['/internal/tasks/update','/internal/nodes/heartbeat'].includes(url.pathname)) failures.push(url.pathname);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
    } catch (error) { failures.push(error.message); response.writeHead(500); response.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const handlers = new Map(); const ctx = { on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); } };
  const native = new NativeBots(ctx);
  native.list = async () => [bot];
  native.bot = async () => ({ id: 'original', sessionId: 'original', name: 'Native', model: 'native/model' });
  native.agent = async () => ({ whenIdle: async () => {}, cancel: () => cancelled++, ctx: { tools: { schemas: () => [{ name: 'create_bot' }, { name: 'remember' }] } } });
  native.call = async (_endpoint, { text }) => {
    streamCalls++;
    const input = JSON.parse(text.split('\n').at(-1));
    assert.equal(input.context.room.name, '测试群'); assert.equal(input.context.source.sender.id, human.id);
    const event = (type, data) => handlers.get('session/event')({ id: 'original' }, { type, data });
    await event('turn/start', { turn: 1 });
    await event('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } });
    await event('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '原生 Bot 的群回复' }] } });
    await event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  };
  await writeFile(path.join(directory, 'matrix-setup.json'), JSON.stringify({ homeserverUrl: serverUrl, roomId: room, participants }));
  await writeFile(path.join(directory, 'core-config.json'), JSON.stringify({ nodeSecret: 'synthetic' }));
  const connections = new NativeConnections({ ctx, native });
  const node = { id: bot.id, localpart: bot.localpart, directory, serverUrl, nativeBotId: 'original' };
  t.after(async () => { await connections.stop(node); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await connections.start(node);
  const deadline = Date.now() + 6000;
  while (!sent.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(sent.length, 1, connections.connections.get(node.id)?.botNode.lastError);
  assert.equal(sent[0].roomId, room); assert.equal(sent[0].content.body, '原生 Bot 的群回复');
  assert.equal(sent[0].content['org.ds_group'].originEventId, '$input');
  await connections.stop(node);
  assert.equal(heartbeat.status, 'offline');
  const oldRuntime = heartbeat.runtimeId;
  await connections.start(node);
  assert.notEqual(heartbeat.runtimeId, oldRuntime);
  await connections.stop(node);
  assert.equal(heartbeat.status, 'offline');
  assert.equal(streamCalls, 1); assert.equal(cancelled, 0); assert.equal((await connections.probe(node)).status, 'offline');
  assert.deepEqual(failures, []);
});
