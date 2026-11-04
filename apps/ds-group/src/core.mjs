import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MatrixClient } from './matrix-client.mjs';
import { ModelBudget } from './budget.mjs';
import { PushService } from './push.mjs';
import { MediaService, MAX_ATTACHMENTS } from './media.mjs';
import { TaskService } from './tasks.mjs';
import { ChatFeatures } from './mentions.mjs';
import { localPath, packageRoot } from './paths.mjs';

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const loadedCoreSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

export async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 131072) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString('utf8');
  try { return body ? JSON.parse(body) : {}; }
  catch { throw Object.assign(new Error('Expected JSON body'), { status: 400 }); }
}

function bearer(request) {
  const authorization = request.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) throw Object.assign(new Error('Please sign in'), { status: 401 });
  return authorization.slice(7);
}

async function loadCoreConfig(dataRoot, filename = process.env.DS_GROUP_CORE_CONFIG_PATH || path.join(dataRoot, 'core-config.json')) {
  await mkdir(path.dirname(filename), { recursive: true });
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const config = { nodeSecret: randomBytes(32).toString('hex'), modelCallLimit: null, maxOutputTokens: 8192 };
    await writeFile(filename, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return config;
  }
}

export async function createCore({ setup, config, dataRoot = localPath(), webRoot = process.env.DS_GROUP_WEB_DIR || path.join(packageRoot, 'dist', 'web'), enablePush = true } = {}) {
  setup ||= JSON.parse(await readFile(process.env.DS_GROUP_MATRIX_SETUP_PATH || path.join(dataRoot, 'matrix-setup.json'), 'utf8'));
  setup = { ...setup, homeserverUrl: process.env.DS_GROUP_MATRIX_URL || setup.homeserverUrl };
  config ||= await loadCoreConfig(dataRoot);
  const demoLogin = process.env.DS_GROUP_DEMO_LOGIN === undefined ? config.demoLogin !== false : process.env.DS_GROUP_DEMO_LOGIN === 'true';
  if (process.env.DS_GROUP_DEMO_LOGIN !== undefined && !['true', 'false'].includes(process.env.DS_GROUP_DEMO_LOGIN)) {
    throw new Error('DS_GROUP_DEMO_LOGIN must be true or false');
  }
  if (typeof config.nodeSecret !== 'string' || !config.nodeSecret) throw new Error('Core nodeSecret is required');
  await mkdir(dataRoot, { recursive: true });
  const budget = new ModelBudget(path.join(dataRoot, 'model-budget.sqlite'), { limit: config.modelCallLimit, maxTokens: config.maxOutputTokens });
  const media = new MediaService({ dataRoot, maxBytes: config.maxUploadBytes ?? process.env.DS_GROUP_MAX_UPLOAD_BYTES });
  const chat = new DatabaseSync(path.join(dataRoot, 'chat.sqlite'));
  chat.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS direct_rooms (pair_key TEXT PRIMARY KEY, room_id TEXT NOT NULL, participants_json TEXT NOT NULL)');
  chat.exec(`CREATE TABLE IF NOT EXISTS group_requests (request_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, status TEXT NOT NULL, room_id TEXT);
    UPDATE group_requests SET status='unknown' WHERE status='creating';
    CREATE TABLE IF NOT EXISTS message_requests (request_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL, token_hash TEXT NOT NULL, event_id TEXT);`);
  const creatingDirectRooms = new Map();
  const sendingMessages = new Map();
  const chatFeatures = new ChatFeatures({ setup, dataRoot });
  const push = enablePush ? new PushService({ dataRoot, setup,
    onEvent: (userId, event) => chatFeatures.recordEvents(userId, [event]),
    shouldNotify: (userId, event) => chatFeatures.shouldNotify(userId, event),
  }) : null;
  if (push) await push.start();
  const nodes = new Map();
  const startedAt = new Date().toISOString();
  const defaultOwnerId = setup.participants.find(person => person.kind === 'human')?.id;
  const publicParticipants = setup.participants.map(({ id, localpart, name, kind, ownerId }) => ({ id, localpart, name, kind,
    ...(kind === 'bot' ? { ownerId: ownerId || defaultOwnerId } : {}) }));
  function authorizeNode(request) {
    const provided = Buffer.from(bearer(request));
    const expected = Buffer.from(config.nodeSecret);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw Object.assign(new Error('Invalid node credential'), { status: 401 });
  }
  const tasks = new TaskService({ setup, dataRoot, authorizeNode, readJsonBody });
  async function directRoomFor(client, userId, target) {
    const ids = [userId, target.id].sort();
    const key = JSON.stringify(ids);
    if (!creatingDirectRooms.has(key)) {
      const work = (async () => {
        let roomId = chat.prepare('SELECT room_id FROM direct_rooms WHERE pair_key=?').get(key)?.room_id;
        if (!roomId) {
          const localAlias = `ds-group-dm-${createHash('sha256').update(key).digest('hex')}`;
          const domain = setup.serverName || userId.slice(userId.indexOf(':') + 1);
          const alias = `#${localAlias}:${domain}`;
          const findAlias = async () => {
            try { return (await client.request('GET', `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`)).room_id; }
            catch (error) { if (error.errcode === 'M_NOT_FOUND') return undefined; throw error; }
          };
          roomId = await findAlias();
          if (!roomId) {
            try {
              const created = await client.createRoom({ is_direct: true, preset: 'private_chat', room_alias_name: localAlias,
                invite: [target.id], name: ids.map(id => publicParticipants.find(person => person.id === id)?.name).join(' · ') });
              roomId = created.room_id;
            } catch (error) {
              // A lost create response or a concurrent creator is resolved by the stable alias.
              roomId = await findAlias();
              if (!roomId) throw error;
            }
          }
        }
        await client.join(roomId);
        await new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: target.accessToken }).join(roomId);
        const members = await client.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`);
        const joined = Object.keys(members.joined || {}).sort();
        if (JSON.stringify(joined) !== key) throw Object.assign(new Error('The direct conversation has unexpected members'), { status: 409 });
        chat.prepare('INSERT OR IGNORE INTO direct_rooms VALUES (?, ?, ?)').run(key, roomId, key);
        const saved = chat.prepare('SELECT room_id FROM direct_rooms WHERE pair_key=?').get(key);
        if (saved.room_id !== roomId) throw Object.assign(new Error('The direct conversation changed during creation'), { status: 409 });
        return roomId;
      })();
      creatingDirectRooms.set(key, work);
      void work.finally(() => creatingDirectRooms.delete(key)).catch(() => {});
    }
    return { roomId: await creatingDirectRooms.get(key), name: target.name, kind: 'direct', participantIds: ids };
  }
  async function sendMessage({ client, userId, roomId, input, attachments, members, token }) {
    const key = JSON.stringify([userId, roomId, input.transactionId]);
    const identity = { body: input.body, attachments: attachments.map(file => file.id), to: [...new Set(input.to)].sort(),
      replyMention: input.replyMention !== false };
    for (const field of ['replyTo', 'taskId', 'returnTo', 'kind', 'hop', 'originSenderId', 'originRoomId', 'originEventId']) {
      if (input[field] !== undefined) identity[field] = input[field];
    }
    const inputHash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const previous = chat.prepare('SELECT * FROM message_requests WHERE request_key=?').get(key);
    const active = sendingMessages.get(key);
    if ((previous && previous.input_hash !== inputHash) || (active && active.inputHash !== inputHash)) {
      throw Object.assign(new Error('This message transaction belongs to different content'), { status: 409 });
    }
    if (previous?.event_id) return { event_id: previous.event_id };
    if (active) return active.promise;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    if (previous && previous.token_hash !== tokenHash) {
      throw Object.assign(new Error('Check the conversation for this pending message before sending it from another login'), { status: 409 });
    }
    const promise = (async () => {
      let payload;
      if (previous) payload = JSON.parse(previous.payload_json);
      else {
        const direct = chat.prepare('SELECT participants_json FROM direct_rooms WHERE room_id=?').get(roomId);
        const directIds = direct ? JSON.parse(direct.participants_json) : [];
        const conversationKind = directIds.length === 2 && members.length === 2 && directIds.every(id => members.includes(id)) ? 'direct' : 'group';
        const resolved = await chatFeatures.resolveMessage({ userId, roomId, input, client, members,
          directIds: conversationKind === 'direct' ? directIds : [] });
        payload = { ...input, ...resolved, attachments, conversationKind };
        chat.prepare('INSERT INTO message_requests VALUES (?,?,?,?,NULL)').run(key, inputHash, JSON.stringify(payload), tokenHash);
      }
      const receipt = await client.send(roomId, payload.body, payload);
      chat.prepare('UPDATE message_requests SET event_id=? WHERE request_key=?').run(receipt.event_id, key);
      return receipt;
    })();
    sendingMessages.set(key, { inputHash, promise });
    try { return await promise; }
    finally { sendingMessages.delete(key); }
  }
  function nodeSnapshot() {
    return publicParticipants.filter(p => p.kind === 'bot').map(participant => {
      const active = nodes.get(participant.id);
      if (!active) return { id: participant.localpart, botId: participant.id, name: participant.name, status: 'offline', engine: 'DS-Bot 0.2.7' };
      return { ...active, status: Date.now() - active.heartbeatAt > 20000 ? 'offline' : active.status };
    });
  }
  async function dispatch(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const send = (status, value) => { response.writeHead(status, jsonHeaders); response.end(JSON.stringify(value)); };
    if (request.method === 'GET' && url.pathname === '/healthz') return send(200, { status: 'ok' });
    if (request.method === 'GET' && url.pathname === '/readyz') {
      try {
        const upstream = await fetch(new URL('/_matrix/client/versions', setup.homeserverUrl), { signal: AbortSignal.timeout(3000) });
        const versions = await upstream.json();
        if (!upstream.ok || !Array.isArray(versions.versions)) throw new Error('Matrix is unavailable');
        return send(200, { status: 'ready', matrix: 'ready' });
      } catch { return send(503, { status: 'unavailable', matrix: 'unavailable' }); }
    }
    if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
      response.setHeader('Access-Control-Allow-Origin', '*');
      return send(200, { name: 'DS-Group', roomId: setup.roomId, homeserverUrl: setup.publicHomeserverUrl || setup.homeserverUrl, participants: publicParticipants, nodes: nodeSnapshot(), demoLogin, mode: demoLogin ? 'local-synthetic-demo' : 'server',
        attachments: { maxBytes: media.maxBytes, maxPerMessage: MAX_ATTACHMENTS } });
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      return send(200, { nodes: nodeSnapshot(), budget: budget.snapshot(), core: { startedAt, storage: 'Matrix Synapse', roomId: setup.roomId, evidenceScope: setup.deploymentMode || 'local-multiprocess', loadedCoreSha256 } });
    }
    if (request.method === 'GET' && url.pathname === '/api/push/config') {
      return send(200, push ? await push.getConfig() : { enabled: false, requiresSecureContext: true });
    }
    if (url.pathname.startsWith('/api/push/')) {
      if (!push) return send(503, { error: 'Notifications are not enabled' });
      const client = new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: bearer(request) });
      const { user_id: userId } = await client.whoami();
      if (!publicParticipants.some(p => p.id === userId && p.kind === 'human')) return send(403, { error: 'Choose a human notification recipient' });
      if (url.pathname === '/api/push/subscriptions') {
        if (request.method === 'GET') return send(200, { subscriptions: await push.subscriptions(userId) });
        if (request.method === 'POST') return send(200, await push.subscribe(userId, await readJsonBody(request)));
        if (request.method === 'DELETE') return send(200, await push.unsubscribe(userId, (await readJsonBody(request)).endpoint));
      }
      if (request.method === 'POST' && url.pathname === '/api/push/test') return send(200, await push.sendTest(userId));
      return send(404, { error: 'Unknown notification endpoint' });
    }
    if (request.method === 'GET' && url.pathname === '/api/demo-login') {
      if (!demoLogin) return send(404, { error: 'Demo login is disabled' });
      const participant = setup.participants.find(p => p.kind === 'human' && (p.localpart === url.searchParams.get('user') || p.id === url.searchParams.get('user')));
      if (!participant) return send(404, { error: 'Unknown demo human' });
      return send(200, { access_token: participant.accessToken, user_id: participant.id, mode: 'synthetic-demo-account' });
    }
    if (request.method === 'POST' && url.pathname === '/api/login') {
      const input = await readJsonBody(request);
      return send(200, await MatrixClient.login(setup.homeserverUrl, input.user, input.password));
    }
    if (tasks.handles(url.pathname)) return tasks.handle({ request, url, send });
    if (chatFeatures.handles(url.pathname)) {
      const client = new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: bearer(request) });
      const { user_id: userId } = await client.whoami();
      return chatFeatures.handle({ request, url, userId, client, readJsonBody, send });
    }
    if (url.pathname === '/api/attachments' || url.pathname.startsWith('/api/attachments/')) {
      const client = new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: bearer(request) });
      const { user_id: userId } = await client.whoami();
      if (!publicParticipants.some(person => person.id === userId)) return send(403, { error: 'A registered member is required' });
      if (request.method === 'POST' && url.pathname === '/api/attachments') {
        const controller = new AbortController();
        const disconnected = () => { if (!response.writableFinished) controller.abort(); };
        response.once('close', disconnected);
        try {
          const attachment = await media.upload({ request, filename: url.searchParams.get('filename'), ownerId: userId, client, signal: controller.signal });
          return send(200, { attachment });
        } finally { response.off('close', disconnected); }
      }
      const attachment = url.pathname.match(/^\/api\/attachments\/([^/]+)(\/metadata)?$/);
      if (request.method === 'GET' && attachment) {
        const id = decodeURIComponent(attachment[1]);
        if (attachment[2]) return send(200, { attachment: media.get(id) });
        return media.download({ id, client, request, response, asDownload: url.searchParams.get('download') === '1' });
      }
      return send(404, { error: 'Unknown attachment endpoint' });
    }
    if (request.method === 'GET' && url.pathname === '/api/bots') {
      const client = new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: bearer(request) });
      const { user_id: userId } = await client.whoami();
      return send(200, { bots: publicParticipants.filter(person => person.kind === 'bot' && person.ownerId === userId) });
    }
    if (request.method === 'GET' && url.pathname === '/api/rooms') {
      const client = new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: bearer(request) });
      const { user_id: userId } = await client.whoami();
      const { joined_rooms: joined } = await client.request('GET', '/_matrix/client/v3/joined_rooms');
      const rooms = [];
      for (const row of chat.prepare('SELECT * FROM direct_rooms').all()) {
        const ids = JSON.parse(row.participants_json);
        if (!ids.includes(userId) || !joined.includes(row.room_id)) continue;
        const other = publicParticipants.find(p => p.id === ids.find(id => id !== userId));
        rooms.push({ roomId: row.room_id, name: other?.name || '私聊', kind: 'direct', participantIds: ids });
      }
      for (const roomId of joined) {
        if (rooms.some(room => room.roomId === roomId)) continue;
        const [roomName, members] = await Promise.all([
          client.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`).catch(() => ({ name: '群聊' })),
          client.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`),
        ]);
        rooms.push({ roomId, name: roomId === setup.roomId ? '初次协作' : roomName.name || '群聊', kind: 'group', participantIds: Object.keys(members.joined || {}) });
      }
      return send(200, { rooms: rooms.filter(room => joined.includes(room.roomId))
        .map(room => ({ ...room, ...chatFeatures.unreadFor(userId, room.roomId) })) });
    }
    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      const client = new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: bearer(request) });
      const { user_id: userId } = await client.whoami();
      const input = await readJsonBody(request);
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || !Array.isArray(input.inviteIds)) return send(400, { error: 'A group name and member list are required' });
      const invited = [...new Set(input.inviteIds)].filter(id => id !== userId);
      for (const id of invited) {
        const person = publicParticipants.find(p => p.id === id);
        if (!person || (person.kind === 'bot' && person.ownerId !== userId)) return send(403, { error: 'Only your own Bots can be invited' });
      }
      const requestId = input.requestId || randomBytes(16).toString('hex');
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(requestId)) return send(400, { error: 'Invalid group request ID' });
      const requestKey = `${userId}/${requestId}`;
      const inputHash = createHash('sha256').update(JSON.stringify({ name: input.name.trim(), invited: [...invited].sort() })).digest('hex');
      const previous = chat.prepare('SELECT * FROM group_requests WHERE request_key=?').get(requestKey);
      if (previous && previous.input_hash !== inputHash) return send(409, { error: 'This group request ID belongs to different content' });
      if (previous && previous.status !== 'created') return send(409, { error: 'Group creation is pending confirmation; check your room list', requestId });
      let roomId = previous?.room_id;
      if (!roomId) {
        chat.prepare("INSERT INTO group_requests VALUES (?, ?, 'creating', NULL)").run(requestKey, inputHash);
        try {
          roomId = (await client.createRoom({ name: input.name.trim(), preset: 'private_chat', invite: invited })).room_id;
          chat.prepare("UPDATE group_requests SET status='created',room_id=? WHERE request_key=?").run(roomId, requestKey);
        } catch (error) {
          chat.prepare("UPDATE group_requests SET status='unknown' WHERE request_key=?").run(requestKey);
          return send(409, { error: 'Group creation result is unknown; check your room list before creating another group', requestId });
        }
      }
      const joinResults = [];
      for (const id of invited) {
        const participant = setup.participants.find(p => p.id === id);
        try {
          await new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: participant.accessToken }).join(roomId);
          joinResults.push({ participantId: id, status: 'joined' });
        } catch (error) {
          joinResults.push({ participantId: id, status: 'pending', reason: error.errcode || 'JOIN_UNCONFIRMED' });
        }
      }
      return send(200, { roomId, requestId, name: input.name.trim(), kind: 'group',
        status: joinResults.every(item => item.status === 'joined') ? 'joined' : 'partially_joined', joinResults,
        participantIds: [userId, ...joinResults.filter(item => item.status === 'joined').map(item => item.participantId)] });
    }
    const invite = url.pathname.match(/^\/api\/rooms\/([^/]+)\/invite$/);
    if (request.method === 'POST' && invite) {
      const client = new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: bearer(request) });
      const { user_id: userId } = await client.whoami();
      const input = await readJsonBody(request);
      const participant = setup.participants.find(p => p.id === input.participantId && p.kind === 'bot');
      const profile = publicParticipants.find(p => p.id === input.participantId);
      if (!participant || profile.ownerId !== userId) return send(403, { error: 'Choose one of your own Bots' });
      const roomId = decodeURIComponent(invite[1]);
      const currentMembers = await client.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`);
      if (!currentMembers.joined?.[participant.id]) {
        await client.request('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, { user_id: participant.id });
      }
      await new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: participant.accessToken }).join(roomId);
      return send(200, { roomId, participantId: participant.id, status: 'joined' });
    }
    if (request.method === 'POST' && url.pathname === '/api/dm') {
      const client = new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: bearer(request) });
      const { user_id: userId } = await client.whoami();
      const input = await readJsonBody(request);
      const target = setup.participants.find(p => p.id === input.participantId);
      if (!target || target.id === userId || !publicParticipants.some(p => p.id === userId)) return send(400, { error: 'Choose a different demo participant' });
      return send(200, await directRoomFor(client, userId, target));
    }
    const context = url.pathname.match(/^\/api\/rooms\/([^/]+)\/context\/([^/]+)$/);
    if (request.method === 'GET' && context) {
      const roomId = decodeURIComponent(context[1]);
      const eventId = decodeURIComponent(context[2]);
      const client = new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: bearer(request) });
      const { user_id: userId } = await client.whoami();
      const result = await client.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(eventId)}?limit=30`);
      const events = [...(result.events_before || []).toReversed(), ...(result.event ? [result.event] : []), ...(result.events_after || [])]
        .map(event => ({ ...event, room_id: roomId }));
      chatFeatures.recordEvents(userId, events);
      return send(200, { eventId, events });
    }
    const messages = url.pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
    if (messages) {
      const roomId = decodeURIComponent(messages[1]);
      const client = new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: bearer(request) });
      if (request.method === 'GET') {
        const { user_id: userId } = await client.whoami();
        const events = (await client.timeline(roomId, Math.min(Number(url.searchParams.get('limit')) || 100, 200)))
          .map(event => ({ ...event, room_id: roomId }));
        chatFeatures.recordEvents(userId, events);
        return send(200, { events });
      }
      if (request.method === 'POST') {
        const input = await readJsonBody(request);
        const attachments = media.resolve(input.attachments);
        const body = input.body ?? '';
        const to = input.to ?? [];
        if (typeof body !== 'string' || (!body.trim() && !attachments.length) || body.length > 16000) return send(400, { error: 'A message needs text or an attachment, with at most 16000 text characters' });
        if (!Array.isArray(to) || to.some(id => !publicParticipants.some(p => p.id === id))) return send(400, { error: 'Unknown recipient' });
        if (typeof input.transactionId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(input.transactionId)) return send(400, { error: 'A stable transaction ID is required' });
        const { user_id: userId } = await client.whoami();
        const members = await chatFeatures.roomMembers(client, roomId, userId);
        return send(200, await sendMessage({ client, userId, roomId, input: { ...input, body, to }, attachments, members, token: bearer(request) }));
      }
    }
    if (url.pathname.startsWith('/internal/')) {
      authorizeNode(request);
      const input = await readJsonBody(request);
      if (request.method === 'POST' && url.pathname === '/internal/model/claim') return send(200, budget.claim(input));
      if (request.method === 'POST' && url.pathname === '/internal/model/complete') return send(200, budget.complete(input));
      if (request.method === 'POST' && url.pathname === '/internal/nodes/heartbeat') {
        const participant = publicParticipants.find(p => p.id === input.botId && p.kind === 'bot');
        if (!participant || typeof input.id !== 'string' || !input.id) return send(400, { error: 'Unknown Bot node' });
        const current = nodes.get(input.botId);
        if (current && current.status !== 'offline' && current.runtimeId !== input.runtimeId && Date.now() - current.heartbeatAt < 20000) return send(409, { error: 'Node already has an active runtime' });
        const node = { id: input.id, botId: input.botId, name: participant.name, runtimeId: input.runtimeId,
          status: input.status, processed: input.processed ?? 0, pending: input.pending ?? 0,
          sessionId: input.sessionId ?? null, lastError: input.lastError ?? null,
          engine: input.engine || 'DS-Bot 0.2.7', heartbeatAt: Date.now() };
        nodes.set(input.botId, node);
        chatFeatures.touchPresence(input.botId, { status: input.status === 'offline' ? 'offline' : 'online' });
        return send(200, { accepted: true });
      }
      return send(404, { error: 'Unknown internal endpoint' });
    }
    if (request.method === 'GET') {
      const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const filename = path.resolve(webRoot, requested);
      if (!filename.startsWith(path.resolve(webRoot) + path.sep)) return send(404, { error: 'Not found' });
      try {
        const body = await readFile(filename);
        response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        response.end(body);
        return;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    send(404, { error: 'Not found' });
  }
  const server = http.createServer((request, response) => {
    dispatch(request, response).catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(error.status || error.statusCode || 500, jsonHeaders);
      response.end(JSON.stringify({ error: error.message, code: error.code || 'REQUEST_FAILED' }));
    });
  });
  return { server, budget, push, media, tasks, chatFeatures, close: async () => {
    if (push) await push.close();
    await new Promise(resolve => server.close(resolve));
    await media.close();
    tasks.close();
    chatFeatures.close();
    budget.close();
    chat.close();
  } };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const core = await createCore();
  const port = Number(process.env.DS_GROUP_PORT || 18100);
  const host = process.env.DS_GROUP_HOST || '127.0.0.1';
  core.server.listen(port, host, () => console.log(`DS-Group ready at http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await core.close(); process.exit(0); });
}
