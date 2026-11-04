import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MatrixClient } from './matrix-client.mjs';

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

export class TaskService {
  constructor({ setup, dataRoot, authorizeNode, readJsonBody }) {
    this.setup = setup;
    this.authorizeNode = authorizeNode;
    this.readJsonBody = readJsonBody;
    mkdirSync(dataRoot, { recursive: true });
    this.db = new DatabaseSync(path.join(dataRoot, 'tasks.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS file_tasks (
        request_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, room_id TEXT NOT NULL,
        event_id TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL,
        summary TEXT NOT NULL, artifacts_json TEXT NOT NULL, tool_calls INTEGER NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        task_id TEXT
      );
      CREATE INDEX IF NOT EXISTS file_tasks_room ON file_tasks(room_id,updated_at);`);
    if (!this.db.prepare('PRAGMA table_info(file_tasks)').all().some(column => column.name === 'task_id')) {
      this.db.exec('ALTER TABLE file_tasks ADD COLUMN task_id TEXT');
    }
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
    };
  }

  update(input) {
    const requestId = requiredString(input.requestId, 'task ID', 200);
    if (!/^[a-zA-Z0-9_.:-]+$/.test(requestId)) throw fail('Invalid task ID');
    const botId = requiredString(input.botId, 'Bot ID');
    if (!this.setup.participants.some(person => person.id === botId && person.kind === 'bot')) throw fail('Unknown Bot');
    const roomId = requiredString(input.roomId, 'room ID');
    const eventId = requiredString(input.eventId, 'event ID');
    if (!states.has(input.status)) throw fail('Invalid task status');
    const previous = this.get(requestId);
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
    const now = Date.now();
    const familyCancelled = Boolean(this.db.prepare('SELECT 1 FROM file_tasks WHERE task_id=? AND cancel_requested=1 LIMIT 1').get(taskId));
    this.db.prepare(`INSERT INTO file_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(request_id) DO UPDATE SET status=excluded.status,stage=excluded.stage,
      summary=excluded.summary,artifacts_json=excluded.artifacts_json,tool_calls=excluded.tool_calls,updated_at=excluded.updated_at`)
      .run(requestId, botId, roomId, eventId, input.status, stage, summary, JSON.stringify(artifacts), toolCalls,
        Number(previous?.cancelRequested || familyCancelled), previous?.createdAt ?? now, now, taskId);
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
      this.authorizeNode(request);
      if (pathname === '/internal/tasks/update' && request.method === 'POST') {
        return send(200, { task: this.update(await this.readJsonBody(request)) });
      }
      const control = pathname.match(/^\/internal\/tasks\/([^/]+)\/control$/);
      if (control && request.method === 'GET') {
        const requestId = decodeURIComponent(control[1]);
        return send(200, { requestId, cancelRequested: this.get(requestId)?.cancelRequested ?? false });
      }
      return send(405, { error: 'Unsupported task operation' });
    }
    const room = pathname.match(/^\/api\/rooms\/([^/]+)\/tasks$/);
    if (room && request.method === 'GET') {
      const roomId = decodeURIComponent(room[1]);
      await this.authorizeRoom(request, roomId);
      const tasks = this.db.prepare('SELECT * FROM file_tasks WHERE room_id=? ORDER BY updated_at DESC LIMIT 100').all(roomId).map(row => this.view(row));
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
      return send(200, { task: this.get(task.requestId) });
    }
    return send(405, { error: 'Unsupported task operation' });
  }

  close() { this.db.close(); }
}
