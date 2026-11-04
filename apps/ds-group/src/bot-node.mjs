import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MatrixClient } from './matrix-client.mjs';
import { localPath } from './paths.mjs';
import { NodeStore } from './node-store.mjs';

const metadataOf = event => event.content?.['org.ds_group'] || {};
const digest = value => createHash('sha256').update(value).digest('hex');
const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener('abort', finish, { once: true });
});

export function parseBotOutput(raw, botId, participants) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Bot returned an empty response');
  const text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let parsed;
  try { parsed = JSON.parse(fenced ? fenced[1] : text); }
  catch { return { text }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.text !== 'string' || !parsed.text.trim()) {
    throw new Error('Structured Bot response requires non-empty text');
  }
  if (parsed.text.length > 16000) throw new Error('Bot response is too long');
  if (parsed.delegate === undefined) return { text: parsed.text.trim() };
  const delegate = parsed.delegate;
  if (!delegate || typeof delegate !== 'object' || Array.isArray(delegate)
    || Object.keys(delegate).some(key => !['to', 'body'].includes(key))
    || !participants.some(p => p.kind === 'bot' && p.id === delegate.to)
    || delegate.to === botId || typeof delegate.body !== 'string' || !delegate.body.trim() || delegate.body.length > 16000) {
    throw new Error('Bot delegation must name one other registered Bot and a non-empty request');
  }
  return { text: parsed.text.trim(), delegate: { to: delegate.to, body: delegate.body.trim() } };
}

export function deliveriesFor(event, output, botId, participants, collaborationRoomId = event.room_id) {
  const meta = metadataOf(event);
  const hop = Number.isInteger(meta.hop) && meta.hop >= 0 ? meta.hop : 0;
  if (hop > 4 || (output.delegate && hop >= 4)) throw new Error('Collaboration hop limit reached');
  const taskId = typeof meta.taskId === 'string' && meta.taskId ? meta.taskId : `task-${digest(event.event_id).slice(0, 24)}`;
  const requestedByBot = participants.some(p => p.kind === 'bot' && p.id === event.sender);
  const originSenderId = requestedByBot && typeof meta.originSenderId === 'string' ? meta.originSenderId : event.sender;
  const originRoomId = requestedByBot && typeof meta.originRoomId === 'string' ? meta.originRoomId : event.room_id;
  const originEventId = requestedByBot && typeof meta.originEventId === 'string' ? meta.originEventId : event.event_id;
  const returnTo = requestedByBot && meta.kind === 'task.request'
    && meta.returnTo === event.sender ? meta.returnTo : undefined;
  const prefix = `ds-group-${digest(`${botId}\0${event.event_id}`).slice(0, 40)}`;
  const isFinalResult = requestedByBot && meta.kind === 'task.result' && !output.delegate;
  const replyRoomId = isFinalResult ? originRoomId : event.room_id;
  const replyEventId = isFinalResult ? originEventId : event.event_id;
  const common = { taskId, originSenderId, originRoomId, originEventId, hop: hop + 1 };
  const result = [{ roomId: replyRoomId, body: output.text, options: {
    ...common, replyTo: replyEventId, transactionId: `${prefix}-reply`, to: returnTo && !output.delegate ? [returnTo] : [],
    kind: returnTo && !output.delegate ? 'task.result' : 'reply',
  } }];
  if (output.delegate) {
    result.push({ roomId: collaborationRoomId, body: output.delegate.body, options: {
      ...common, transactionId: `${prefix}-delegate`, to: [output.delegate.to], returnTo: botId, kind: 'task.request',
      ...(event.room_id === collaborationRoomId ? { replyTo: event.event_id } : {}),
    } });
  }
  return result;
}

export class BotNode {
  constructor({ participant, participants, roomId, matrix, store, bridge, heartbeat, pollTimeout = 10000, onError = console.error }) {
    this.participant = participant;
    this.participants = participants;
    this.roomId = roomId;
    this.matrix = matrix;
    this.store = store;
    this.bridge = bridge;
    this.sendHeartbeat = heartbeat;
    this.pollTimeout = pollTimeout;
    this.onError = onError;
    this.runtimeId = randomUUID();
    this.controller = new AbortController();
    this.state = 'idle';
    this.lastError = null;
    this.processing = null;
  }

  senderName(id) { return this.participants.find(p => p.id === id)?.name || id; }

  async start() {
    await this.bridge.createBot({ botId: this.participant.id, name: this.participant.name,
      role: this.participant.localpart === 'finance' ? '财务' : '人事',
      instructions: this.instructions() });
    await this.heartbeat();
    this.processing = this.processLoop();
    this.syncing = this.syncLoop();
    this.heartbeats = this.heartbeatLoop();
    return this;
  }

  instructions() {
    const peers = this.participants.filter(p => p.kind === 'bot' && p.id !== this.participant.id).map(p => `${p.name} (${p.id})`).join('、');
    return `你是 DS-Group 中独立的${this.participant.name}，身份 ${this.participant.id}。你的职责是${this.participant.localpart === 'finance' ? '财务核算、预算和金额核对' : '人事、入职安排和人员事项协调'}。保留自己的经历并区分每个人的身份。\n`
      + `消息源附有发送者、房间、原消息、任务和回复关系。按这些关系回答当前发送者。可协作的 Bot 为 ${peers}。\n`
      + '每轮输出一个 JSON 对象，格式为 {"text":"你向群里说的话"}。确实需要其他 Bot 完成工作时，使用 {"text":"你的受理说明","delegate":{"to":"目标 Bot 的完整 ID","body":"具体工作要求及所需事实"}}。\n'
      + 'delegate 会真实投递到另一台节点，由对方返回结果。收到 kind=task.result 后，结合结果向原请求者总结。已经收到的结果不要再次委派同一任务。每轮最多一次委派。当前试验通过这个协议协作，直接给出 JSON，无需调用本地 message_bot 或其他工具。';
  }

  async collectRoomEvents(roomId, joined) {
    const timeline = joined.timeline || {};
    const current = (timeline.events || []).map(event => ({ ...event, room_id: roomId }));
    if (!timeline.limited || !timeline.prev_batch) return current;
    const older = [];
    let token = timeline.prev_batch;
    const seenTokens = new Set();
    for (let page = 0; page < 100; page++) {
      if (seenTokens.has(token)) throw new Error('Matrix history pagination did not advance');
      seenTokens.add(token);
      const result = await this.matrix.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=100&from=${encodeURIComponent(token)}`);
      const chunk = result.chunk || [];
      const boundary = chunk.findIndex(event => this.store.hasEvent(event.event_id));
      older.push(...(boundary < 0 ? chunk : chunk.slice(0, boundary)));
      if (boundary >= 0 || !chunk.length || !result.end) {
        return [...older.reverse().map(event => ({ ...event, room_id: roomId })), ...current];
      }
      token = result.end;
    }
    throw new Error('Matrix history gap exceeded 100 pages; sync cursor preserved for inspection');
  }

  async syncOnce() {
    const response = await this.matrix.sync({ since: this.store.cursor(), timeout: this.pollTimeout });
    const events = [];
    for (const [roomId, room] of Object.entries(response.rooms?.join || {})) {
      events.push(...await this.collectRoomEvents(roomId, room));
    }
    this.store.ingest(events, response.next_batch);
    return events.length;
  }

  async syncLoop() {
    let delay = 500;
    while (!this.controller.signal.aborted) {
      try { await this.syncOnce(); delay = 500; }
      catch (error) {
        if (this.controller.signal.aborted) break;
        this.lastError = `Matrix sync failed: ${error.message}`;
        this.onError(this.lastError);
        await sleep(delay, this.controller.signal);
        delay = Math.min(delay * 2, 10000);
      }
    }
  }

  requestFor(item) {
    const event = item.event;
    const meta = metadataOf(event);
    return { requestId: `matrix-${digest(`${this.participant.id}\0${event.event_id}`)}`, botId: this.participant.id,
      event: { eventId: event.event_id, roomId: event.room_id, senderId: event.sender, senderName: this.senderName(event.sender),
        body: event.content.body, to: Array.isArray(meta.to) ? meta.to : [],
        ...(meta.taskId ? { taskId: meta.taskId } : {}),
        ...(meta.replyTo || event.content['m.relates_to']?.['m.in_reply_to']?.event_id
          ? { replyTo: meta.replyTo || event.content['m.relates_to']['m.in_reply_to'].event_id } : {}),
        ...(meta.kind ? { kind: meta.kind } : {}), ...(meta.returnTo ? { returnTo: meta.returnTo } : {}),
        ...(meta.originSenderId ? { originSenderId: meta.originSenderId } : {}), ...(Number.isInteger(meta.hop) ? { hop: meta.hop } : {}),
        ...(meta.originRoomId ? { originRoomId: meta.originRoomId } : {}), ...(meta.originEventId ? { originEventId: meta.originEventId } : {}),
      },
      history: this.store.historyBefore(event.event_id).map(previous => ({ eventId: previous.event_id,
        senderId: previous.sender, senderName: this.senderName(previous.sender), body: previous.content.body })),
    };
  }

  async processOne() {
    const delivery = this.store.pendingDelivery();
    if (delivery) {
      try {
        const receipt = await this.matrix.send(delivery.room_id, delivery.body, delivery.options);
        this.store.sent(delivery.transaction_id, receipt.event_id);
        this.lastError = null;
      } catch (error) {
        const terminal = error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
        this.store.deliveryFailed(delivery.transaction_id, error.message, { terminal });
        this.lastError = `Matrix delivery ${terminal ? 'failed' : 'pending'}: ${error.message}`;
        if (terminal) { this.onError(this.lastError); return true; }
        throw error;
      }
      return true;
    }
    const item = this.store.next();
    if (!item) return false;
    const request = this.requestFor(item);
    this.store.begin(item.event_id, request);
    this.state = 'thinking';
    try {
      if ((request.event.hop ?? 0) > 4) throw new Error('Collaboration hop limit reached');
      const response = await this.bridge.turn(request);
      if (response.status !== 'completed') {
        this.store.failed(item.event_id, response.errorCode || `Bridge returned ${response.status}`, response.status === 'unknown' ? 'unknown' : 'failed');
        this.lastError = response.errorCode || `Bridge returned ${response.status}`;
        return true;
      }
      const output = parseBotOutput(response.text, this.participant.id, this.participants);
      const deliveries = deliveriesFor(item.event, output, this.participant.id, this.participants, this.roomId);
      this.store.generated(item.event_id, response, deliveries);
      this.lastError = null;
    } catch (error) {
      const uncertain = error.networkError === true || error.name === 'TimeoutError' || error.name === 'AbortError';
      this.store.failed(item.event_id, error.message, uncertain ? 'unknown' : 'failed');
      this.lastError = error.message;
      this.onError(`Bot turn ${request.requestId} ended: ${error.message}`);
    } finally { this.state = 'idle'; }
    return true;
  }

  async processLoop() {
    while (!this.controller.signal.aborted) {
      try {
        if (!await this.processOne()) await sleep(100, this.controller.signal);
      } catch (error) {
        this.onError(`Delivery retry keeps the same Matrix transaction: ${error.message}`);
        await sleep(2000, this.controller.signal);
      }
    }
  }

  async heartbeat() {
    const snapshot = this.store.snapshot();
    await this.sendHeartbeat({ id: this.participant.localpart, botId: this.participant.id, name: this.participant.name,
      runtimeId: this.runtimeId, status: this.lastError && this.state === 'idle' ? 'error' : this.state,
      processed: snapshot.processed, pending: snapshot.pending, sessionId: snapshot.sessionId,
      lastError: this.lastError || snapshot.lastError, engine: 'DS-Bot 0.2.7' });
  }

  async heartbeatLoop() {
    while (!this.controller.signal.aborted) {
      await sleep(5000, this.controller.signal);
      if (this.controller.signal.aborted) break;
      try { await this.heartbeat(); }
      catch (error) { this.onError(`Heartbeat failed: ${error.message}`); }
    }
  }

  async stop() {
    this.controller.abort();
    await Promise.allSettled([this.processing, this.syncing, this.heartbeats]);
    this.state = 'offline';
    await this.heartbeat().catch(() => {});
    this.store.close();
  }
}

export function createBridge(endpoint, { token, fetchImpl = fetch, timeoutMs = 180000 } = {}) {
  async function request(pathname, body) {
    let response;
    try {
      response = await fetchImpl(new URL(pathname, endpoint), { method: 'POST', headers: {
        'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) { throw Object.assign(new Error(`DS-Bot bridge connection failed: ${cause.message}`), { networkError: true, cause }); }
    let result;
    try { result = await response.json(); }
    catch (cause) { throw Object.assign(new Error('DS-Bot bridge returned an unreadable receipt'), { networkError: true, cause }); }
    if (!response.ok) throw Object.assign(new Error(result.error || result.message || `Bridge HTTP ${response.status}`), {
      status: response.status, networkError: response.status >= 500,
    });
    return result;
  }
  return { createBot: input => request('/api/ds-group-node/bots', input), turn: input => request('/api/ds-group-node/turns', input) };
}

export async function runNode(argv = process.argv.slice(2)) {
  const argument = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  const name = argument('--bot');
  if (!name) throw new Error('Usage: node src/bot-node.mjs --bot finance|hr [--endpoint URL]');
  const setup = JSON.parse(await readFile(process.env.DS_GROUP_MATRIX_SETUP_PATH || localPath('matrix-setup.json'), 'utf8'));
  const config = JSON.parse(await readFile(process.env.DS_GROUP_CORE_CONFIG_PATH || localPath('core-config.json'), 'utf8'));
  if (process.env.DS_GROUP_MATRIX_URL) setup.homeserverUrl = process.env.DS_GROUP_MATRIX_URL;
  const participant = setup.participants.find(p => p.localpart === name && p.kind === 'bot');
  if (!participant) throw new Error(`Unknown Bot ${name}`);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Bot name must be a local account name');
  if (!participant.accessToken) throw new Error('This node needs its own Matrix access token');
  const directory = localPath('nodes', name);
  await mkdir(directory, { recursive: true });
  const releaseLock = await acquireNodeLock(path.join(directory, 'process.lock'));
  const bridgePort = process.env.DS_GROUP_BRIDGE_PORT || process.env[`DS_GROUP_${name.toUpperCase()}_PORT`] || (name === 'finance' ? 18091 : 18092);
  const endpoint = argument('--endpoint') || process.env.DS_GROUP_BOT_ENDPOINT || `http://127.0.0.1:${bridgePort}`;
  const coreUrl = process.env.DS_GROUP_CORE_URL || config.publicUrl || `http://127.0.0.1:${process.env.DS_GROUP_PORT || 18100}`;
  const store = new NodeStore(path.join(directory, 'node.sqlite'), participant.id);
  const node = new BotNode({ participant, participants: setup.participants, roomId: setup.roomId,
    matrix: new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: participant.accessToken }), store,
    bridge: createBridge(endpoint, { token: process.env.DS_GROUP_BRIDGE_TOKEN }),
    heartbeat: async body => {
      const response = await fetch(new URL('/internal/nodes/heartbeat', coreUrl), { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.nodeSecret}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Core heartbeat HTTP ${response.status}`);
    },
  });
  try { await node.start(); }
  catch (error) { store.close(); await releaseLock(); throw error; }
  console.log(`DS-Group node ${name} connected as ${participant.id}`);
  let stopping;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    stopping ||= node.stop().then(releaseLock).then(() => process.exit(0));
  });
  return node;
}

export async function acquireNodeLock(filename) {
  const identity = { pid: process.pid, runtimeId: randomUUID() };
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,runtime_id TEXT NOT NULL)');
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare('SELECT * FROM owner WHERE id=1').get();
    if (previous) {
      let alive = true;
      try { process.kill(previous.pid, 0); }
      catch (error) {
        if (error.code !== 'ESRCH') throw new Error('Node process ownership could not be checked');
        alive = false;
      }
      if (alive) throw new Error(`This Bot already has a local process (${previous.pid})`);
    }
    db.prepare('INSERT INTO owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,runtime_id=excluded.runtime_id')
      .run(identity.pid, identity.runtimeId);
    db.exec('COMMIT');
  }
  catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  return async () => {
    db.prepare('DELETE FROM owner WHERE runtime_id=?').run(identity.runtimeId);
    db.close();
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runNode().catch(error => { console.error(error.message); process.exitCode = 1; });
}
