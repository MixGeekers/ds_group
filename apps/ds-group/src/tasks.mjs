import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MatrixClient } from './matrix-client.mjs';
import { requireNodeScope } from './node-auth.mjs';

const states = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown']);
const terminalStates = new Set(['completed', 'failed', 'cancelled']);

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function requiredString(value, name, maxLength = 1000) {
  if (typeof value !== 'string' || !value || value.length > maxLength) throw fail(`Invalid ${name}`);
  return value;
}

function publicArtifact(value) {
  if (!value || typeof value !== 'object') throw fail('Invalid task artifact');
  return {
    id: requiredString(value.id, 'artifact ID', 200),
    name: requiredString(value.name, 'artifact name', 500),
    mimeType: requiredString(value.mimeType, 'artifact MIME type', 200),
    size: Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : 0,
    ...(typeof value.sha256 === 'string' ? { sha256: value.sha256 } : {}),
    ...(typeof value.contentUri === 'string' ? { contentUri: value.contentUri } : {}),
  };
}

function taskDelivery(value, setup, botId) {
  if (!value || typeof value !== 'object' || !['origin', 'direct'].includes(value.kind)) throw fail('Invalid task delivery');
  const delivery = { kind: value.kind };
  if (value.kind === 'direct') {
    delivery.recipientId = requiredString(value.recipientId, 'delivery recipient');
    if (!setup.participants.some(person => person.id === delivery.recipientId && person.kind === 'human')) throw fail('Delivery recipient must be a registered human');
  }
  if (value.roomId !== undefined) delivery.roomId = requiredString(value.roomId, 'delivery room');
  delivery.state = value.state ?? 'requested';
  if (!['requested', 'resolved', 'sending', 'sent'].includes(delivery.state)) throw fail('Invalid delivery state');
  if (value.authoritative !== undefined && typeof value.authoritative !== 'boolean') throw fail('Invalid delivery authority');
  delivery.authoritative = value.authoritative === true;
  if (value.originBotId !== undefined) {
    delivery.originBotId = requiredString(value.originBotId, 'delivery origin Bot');
    if (!setup.participants.some(person => person.id === delivery.originBotId && person.kind === 'bot')) throw fail('Unknown delivery origin Bot');
  } else if (delivery.authoritative) delivery.originBotId = botId;
  if (delivery.authoritative && delivery.originBotId !== botId) throw fail('Only the original Bot may publish authoritative delivery');
  if (value.sourceEventId !== undefined) delivery.sourceEventId = requiredString(value.sourceEventId, 'delivery source event');
  return delivery;
}

function deliveryAfter(previous, incoming) {
  if (!previous) return incoming;
  if (previous.authoritative !== incoming.authoritative) throw fail('Task delivery authority cannot change', 409);
  if (previous.originBotId && incoming.originBotId !== previous.originBotId) throw fail('Task delivery origin cannot change', 409);
  if (!['sending', 'sent'].includes(previous.state)) return incoming;
  const sameDestination = previous.kind === incoming.kind && previous.recipientId === incoming.recipientId
    && previous.roomId === incoming.roomId && previous.sourceEventId === incoming.sourceEventId;
  if (!sameDestination || previous.state === 'sent' || !['sending', 'sent'].includes(incoming.state)) return previous;
  return incoming;
}

export class TaskService {
  constructor({ setup, dataRoot, authorizeNode, readJsonBody, participants = () => setup.participants }) {
    this.setup = setup;
    this.authorizeNode = authorizeNode;
    this.readJsonBody = readJsonBody;
    this.participants = participants;
    mkdirSync(dataRoot, { recursive: true });
    this.db = new DatabaseSync(path.join(dataRoot, 'tasks.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS file_tasks (
        request_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, room_id TEXT NOT NULL,
        event_id TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL,
        summary TEXT NOT NULL, artifacts_json TEXT NOT NULL, tool_calls INTEGER NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        task_id TEXT, delivery_json TEXT, delivery_revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS file_tasks_room ON file_tasks(room_id,updated_at);`);
    if (!this.db.prepare('PRAGMA table_info(file_tasks)').all().some(column => column.name === 'task_id')) {
      this.db.exec('ALTER TABLE file_tasks ADD COLUMN task_id TEXT');
    }
    const columns = this.db.prepare('PRAGMA table_info(file_tasks)').all();
    if (!columns.some(column => column.name === 'delivery_json')) this.db.exec('ALTER TABLE file_tasks ADD COLUMN delivery_json TEXT');
    if (!columns.some(column => column.name === 'delivery_revision')) this.db.exec('ALTER TABLE file_tasks ADD COLUMN delivery_revision INTEGER NOT NULL DEFAULT 0');
  }

  get(requestId) {
    const row = this.db.prepare('SELECT * FROM file_tasks WHERE request_id=?').get(requestId);
    return row ? this.view(row) : undefined;
  }

  view(row) {
    return {
      requestId: row.request_id, taskId: row.task_id || row.request_id, botId: row.bot_id, roomId: row.room_id, eventId: row.event_id,
      status: row.status, stage: row.stage, summary: row.summary,
      artifacts: JSON.parse(row.artifacts_json), toolCalls: row.tool_calls,
      cancelRequested: Boolean(row.cancel_requested), createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.delivery_json ? { delivery: JSON.parse(row.delivery_json), deliveryRevision: row.delivery_revision } : {}),
    };
  }

  visibleInRoom(task, roomId) {
    if (task.delivery?.kind === 'direct' && task.delivery.roomId !== roomId) return { ...task, artifacts: [] };
    return task;
  }

  control(requestId) {
    const task = this.get(requestId);
    if (!task) return { requestId, cancelRequested: false };
    const originBotId = task.delivery?.originBotId ?? task.botId;
    const authoritative = this.db.prepare(`SELECT * FROM file_tasks WHERE task_id=?
      AND bot_id=? AND json_extract(delivery_json,'$.authoritative')=1
      ORDER BY updated_at DESC,rowid DESC LIMIT 1`).get(task.taskId, originBotId);
    const source = authoritative ? this.view(authoritative) : task;
    return { requestId, cancelRequested: task.cancelRequested,
      ...(source.delivery ? { delivery: source.delivery, deliveryRevision: source.deliveryRevision } : {}) };
  }

  update(input, scope) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Invalid task update');
    const requestId = requiredString(input.requestId, 'task ID', 200);
    if (!/^[a-zA-Z0-9_.:-]+$/.test(requestId)) throw fail('Invalid task ID');
    const botId = requiredString(input.botId, 'Bot ID');
    requireNodeScope(scope, { botId });
    if (!this.setup.participants.some(person => person.id === botId && person.kind === 'bot')) throw fail('Unknown Bot');
    const roomId = requiredString(input.roomId, 'room ID');
    const eventId = requiredString(input.eventId, 'event ID');
    if (!states.has(input.status)) throw fail('Invalid task status');
    const previous = this.get(requestId);
    if (previous) requireNodeScope(scope, { botId: previous.botId });
    const taskId = requiredString(input.taskId ?? previous?.taskId ?? requestId, 'collaboration task ID', 200);
    if (previous && (previous.botId !== botId || previous.roomId !== roomId || previous.eventId !== eventId)) {
      throw fail('Task identity does not match the existing request', 409);
    }
    if (previous && previous.taskId !== taskId) throw fail('Collaboration task identity does not match', 409);
    if (previous && terminalStates.has(previous.status)) return previous;
    if (previous?.status === 'unknown' && !terminalStates.has(input.status) && input.status !== 'unknown' && input.reconciled !== true) return previous;
    if (previous?.status === 'running' && input.status === 'queued') return previous;
    const stage = String(input.stage ?? input.status).slice(0, 100);
    const summary = String(input.summary ?? previous?.summary ?? '').slice(0, 2000);
    if (input.artifacts !== undefined && (!Array.isArray(input.artifacts) || input.artifacts.length > 50)) throw fail('Invalid task artifacts');
    const artifacts = input.artifacts === undefined ? previous?.artifacts ?? [] : input.artifacts.map(publicArtifact);
    const reportedCalls = Number.isInteger(input.toolCalls) && input.toolCalls >= 0 ? input.toolCalls : 0;
    const toolCalls = Math.max(previous?.toolCalls ?? 0, reportedCalls);
    const delivery = input.delivery === undefined ? previous?.delivery
      : deliveryAfter(previous?.delivery, taskDelivery(input.delivery, { participants: this.participants() }, botId));
    const deliveryChanged = JSON.stringify(delivery) !== JSON.stringify(previous?.delivery);
    const deliveryRevision = (previous?.deliveryRevision ?? 0) + Number(deliveryChanged);
    const now = Date.now();
    const familyCancelled = Boolean(this.db.prepare('SELECT 1 FROM file_tasks WHERE task_id=? AND cancel_requested=1 LIMIT 1').get(taskId));
    this.db.prepare(`INSERT INTO file_tasks (request_id,bot_id,room_id,event_id,status,stage,summary,artifacts_json,tool_calls,
      cancel_requested,created_at,updated_at,task_id,delivery_json,delivery_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(request_id) DO UPDATE SET status=excluded.status,stage=excluded.stage,
      summary=excluded.summary,artifacts_json=excluded.artifacts_json,tool_calls=excluded.tool_calls,updated_at=excluded.updated_at,
      cancel_requested=MAX(file_tasks.cancel_requested,excluded.cancel_requested),delivery_json=excluded.delivery_json,delivery_revision=excluded.delivery_revision`)
      .run(requestId, botId, roomId, eventId, input.status, stage, summary, JSON.stringify(artifacts), toolCalls,
        Number(previous?.cancelRequested || familyCancelled), previous?.createdAt ?? now, now, taskId,
        delivery ? JSON.stringify(delivery) : null, deliveryRevision);
    return this.get(requestId);
  }

  handles(pathname) {
    return pathname === '/internal/tasks/update' || /^\/internal\/tasks\/[^/]+\/control$/.test(pathname)
      || /^\/api\/rooms\/[^/]+\/tasks$/.test(pathname) || /^\/api\/tasks\/[^/]+\/cancel$/.test(pathname);
  }

  async authorizeRoom(request, roomId) {
    const authorization = request.headers.authorization ?? '';
    if (!authorization.startsWith('Bearer ')) throw fail('Please sign in', 401);
    const client = new MatrixClient({ baseUrl: this.setup.homeserverUrl, accessToken: authorization.slice(7) });
    const identity = await client.whoami();
    if (!this.setup.participants.some(person => person.id === identity.user_id && person.kind === 'human')) throw fail('A human account is required', 403);
    const members = await client.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`);
    if (!members.joined?.[identity.user_id]) throw fail('Join this conversation first', 403);
    return identity.user_id;
  }

  async handle({ request, url, send }) {
    const pathname = url.pathname;
    if (pathname.startsWith('/internal/tasks/')) {
      const scope = this.authorizeNode(request);
      if (pathname === '/internal/tasks/update' && request.method === 'POST') {
        const input = await this.readJsonBody(request);
        return send(200, { task: this.update(input, scope) });
      }
      const control = pathname.match(/^\/internal\/tasks\/([^/]+)\/control$/);
      if (control && request.method === 'GET') {
        const requestId = decodeURIComponent(control[1]);
        const task = this.get(requestId);
        if (task) requireNodeScope(scope, { botId: task.botId });
        return send(200, this.control(requestId));
      }
      return send(405, { error: 'Unsupported task operation' });
    }
    const room = pathname.match(/^\/api\/rooms\/([^/]+)\/tasks$/);
    if (room && request.method === 'GET') {
      const roomId = decodeURIComponent(room[1]);
      await this.authorizeRoom(request, roomId);
      const tasks = this.db.prepare(`SELECT * FROM file_tasks WHERE room_id=?
        OR (json_extract(delivery_json,'$.roomId')=? AND json_extract(delivery_json,'$.authoritative')=1)
        ORDER BY updated_at DESC LIMIT 100`)
        .all(roomId, roomId).map(row => this.visibleInRoom(this.view(row), roomId));
      return send(200, { tasks });
    }
    const cancel = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (cancel && request.method === 'POST') {
      const task = this.get(decodeURIComponent(cancel[1]));
      if (!task) return send(404, { error: 'Unknown task' });
      await this.authorizeRoom(request, task.roomId);
      if (!terminalStates.has(task.status)) {
        this.db.prepare("UPDATE file_tasks SET cancel_requested=1,updated_at=? WHERE (request_id=? OR task_id=?) AND status NOT IN ('completed','failed','cancelled')")
          .run(Date.now(), task.requestId, task.taskId);
      }
      return send(200, { task: this.visibleInRoom(this.get(task.requestId), task.roomId) });
    }
    return send(405, { error: 'Unsupported task operation' });
  }

  close() { this.db.close(); }
}
