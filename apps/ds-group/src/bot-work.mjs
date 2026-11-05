import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MatrixClient } from './matrix-client.mjs';
import { requireNodeScope } from './node-auth.mjs';
import { DEFAULT_MAX_UPLOAD_BYTES } from './media.mjs';
import { FILE_TOOLS, serverOf, policyError } from './governance.mjs';
import {
  ROOM_WORK_EVENT,
  denyWork,
  effectiveRoomWork,
  trustedRoomParticipants,
  validateOwnerGrants,
  workRequestId,
} from './bot-work-policy.mjs';

const memberPath = (roomId) =>
  `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;
const publicFile = (file, event, maxBytes) => {
  if (
    !file ||
    typeof file.id !== 'string' ||
    !file.id ||
    file.id.length > 200 ||
    typeof file.name !== 'string' ||
    !/^[a-f0-9]{64}$/.test(file.sha256 || '') ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > maxBytes ||
    typeof file.mimeType !== 'string' ||
    !/^mxc:\/\/[^/?#]+\/[^/?#]+$/.test(file.contentUri || '')
  )
    throw denyWork('The Matrix attachment descriptor is incomplete');
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    sha256: file.sha256,
    contentUri: file.contentUri,
    source: {
      roomId: event.room_id,
      eventId: event.event_id,
      senderId: event.sender,
    },
  };
};

/** Home-side owner grants and durable authorization receipts. No remote Core credentials are used. */
export class BotWorkService {
  constructor({
    setup,
    accounts,
    governance,
    dataRoot,
    authorizeNode,
    readJsonBody,
    matrixFor,
    tasks,
    maxBytes = () => DEFAULT_MAX_UPLOAD_BYTES,
  }) {
    Object.assign(this, {
      setup,
      accounts,
      governance,
      authorizeNode,
      readJsonBody,
      tasks,
      maxBytes,
    });
    this.matrixFor =
      matrixFor ||
      ((bot) =>
        new MatrixClient({
          baseUrl: setup.homeserverUrl,
          accessToken: bot.accessToken,
        }));
    this.db = new DatabaseSync(path.join(dataRoot, 'bot-work.sqlite'));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS owner_work_grants (bot_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,revision INTEGER NOT NULL,grants_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_work_admissions (request_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,room_id TEXT NOT NULL,event_id TEXT NOT NULL,
        node_tools_json TEXT NOT NULL,work_json TEXT NOT NULL,accepted_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_work_versions (room_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,event_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_work_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL,bot_id TEXT NOT NULL,
        stage TEXT NOT NULL,tool TEXT,call_id TEXT,decision TEXT NOT NULL,detail TEXT NOT NULL,at TEXT NOT NULL);`);
    if (
      !this.db
        .prepare('PRAGMA table_info(bot_work_admissions)')
        .all()
        .some((column) => column.name === 'node_max_bytes')
    ) {
      this.db.exec(
        'ALTER TABLE bot_work_admissions ADD COLUMN node_max_bytes INTEGER',
      );
    }
  }

  bot(botId) {
    const bot = this.accounts.person(botId);
    if (
      !bot ||
      bot.kind !== 'bot' ||
      !bot.accessToken ||
      !this.accounts.publicParticipants().some((person) => person.id === botId)
    )
      throw denyWork('Unknown active local Bot');
    this.accounts.assertActive?.(bot.id);
    if (bot.ownerId) this.accounts.assertActive?.(bot.ownerId);
    return bot;
  }

  grants(bot) {
    const row = this.db
      .prepare('SELECT * FROM owner_work_grants WHERE bot_id=?')
      .get(bot.id);
    if (row && row.owner_id !== bot.ownerId)
      throw denyWork('The work grant belongs to a different Bot owner');
    return row
      ? { revision: row.revision, grants: JSON.parse(row.grants_json) }
      : { revision: 0, grants: [] };
  }

  saveGrants(bot, input) {
    const next = validateOwnerGrants(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.grants(bot);
      if (previous.revision !== next.revision)
        throw policyError(
          409,
          'Owner work grants changed; reload before saving',
        );
      next.revision++;
      this.db
        .prepare(
          'INSERT INTO owner_work_grants VALUES (?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET revision=excluded.revision,grants_json=excluded.grants_json',
        )
        .run(bot.id, bot.ownerId, next.revision, JSON.stringify(next.grants));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return next;
  }

  audit(input, decision, detail = '') {
    this.db
      .prepare(
        'INSERT INTO bot_work_audit(request_id,bot_id,stage,tool,call_id,decision,detail,at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        input.requestId,
        input.botId,
        input.stage || 'accept',
        input.tool || null,
        input.callId || null,
        decision,
        String(detail).slice(0, 2000),
        new Date().toISOString(),
      );
  }

  async room(bot, roomId) {
    if (
      typeof roomId !== 'string' ||
      !roomId.startsWith('!') ||
      roomId.length > 512
    )
      throw policyError(400, 'An exact Matrix room ID is required');
    const client = this.matrixFor(bot);
    const [members, policy] = await Promise.all([
      client.request('GET', `${memberPath(roomId)}/joined_members`),
      this.governance.read(),
    ]);
    const joinedIds = Object.keys(members.joined || {}).sort();
    if (!joinedIds.includes(bot.id))
      throw denyWork('The original Bot is not joined to this room');
    const participants = trustedRoomParticipants({
      policy,
      locals: this.accounts.publicParticipants(),
      joinedIds,
    });
    return { client, policy, joinedIds, participants };
  }

  async event(client, roomId, eventId) {
    if (
      typeof eventId !== 'string' ||
      !eventId.startsWith('$') ||
      eventId.length > 512
    )
      throw policyError(400, 'An exact Matrix event ID is required');
    const event = await client.request(
      'GET',
      `${memberPath(roomId)}/event/${encodeURIComponent(eventId)}`,
    );
    if (
      event.event_id !== eventId ||
      (event.room_id && event.room_id !== roomId) ||
      event.type !== 'm.room.message' ||
      typeof event.sender !== 'string' ||
      typeof event.content?.body !== 'string'
    )
      throw denyWork('The source Matrix event does not match this request');
    return { ...event, room_id: roomId };
  }

  async evaluate(
    bot,
    { roomId, eventId, nodeTools, nodeMaxBytes = DEFAULT_MAX_UPLOAD_BYTES },
  ) {
    const room = await this.room(bot, roomId);
    const event = await this.event(room.client, roomId, eventId);
    const { policy, joinedIds, participants, client } = room;
    if (!participants.some((person) => person.id === event.sender))
      throw denyWork('The actual Matrix sender has not been admitted');
    if (serverOf(event.sender) === policy.serverName)
      this.accounts.assertActive?.(event.sender);
    const rule = policy.rooms.find((row) => row.roomId === roomId);
    const scoped =
      (rule?.authority !== undefined && rule.authority !== policy.serverName) ||
      joinedIds.some((id) => serverOf(id) !== policy.serverName);
    if (!scoped) return { mode: 'local', event, participants };
    if (!Number.isSafeInteger(nodeMaxBytes) || nodeMaxBytes < 1)
      throw policyError(400, 'Invalid node input byte limit');
    const maxBytes = Math.min(nodeMaxBytes, this.maxBytes());
    if (!bot.ownerId)
      throw denyWork('This Bot has no owner work authorization');
    const states = await client.request('GET', `${memberPath(roomId)}/state`);
    const state = states.find(
      (row) => row.type === ROOM_WORK_EVENT && row.state_key === '',
    );
    const power = states.find(
      (row) => row.type === 'm.room.power_levels' && row.state_key === '',
    );
    const work = effectiveRoomWork({
      bot,
      event,
      participants,
      policy,
      joinedIds,
      grants: this.grants(bot),
      state,
      power,
      nodeTools,
      maxBytes,
    });
    const version = this.db
      .prepare('SELECT * FROM room_work_versions WHERE room_id=?')
      .get(roomId);
    if (
      version &&
      (work.policyRevision < version.revision ||
        (work.policyRevision === version.revision &&
          work.policyEventId !== version.event_id))
    ) {
      throw denyWork(
        'Room work policy revisions must increase for each published state',
      );
    }
    this.db
      .prepare(
        'INSERT INTO room_work_versions VALUES (?,?,?) ON CONFLICT(room_id) DO UPDATE SET revision=excluded.revision,event_id=excluded.event_id',
      )
      .run(roomId, work.policyRevision, work.policyEventId);
    const inputs = [];
    const addFiles = (source) => {
      const values = source.content?.['org.ds_group']?.attachments || [];
      if (!Array.isArray(values) || values.length > 10)
        throw denyWork('Invalid Matrix attachment list');
      for (const file of values)
        inputs.push(publicFile(file, source, maxBytes));
    };
    addFiles(event);
    const replyTo =
      event.content['org.ds_group']?.replyTo ||
      event.content['m.relates_to']?.['m.in_reply_to']?.event_id;
    if (replyTo && !inputs.length) {
      const replied = await this.event(client, roomId, replyTo);
      if (!participants.some((person) => person.id === replied.sender))
        throw denyWork(
          'The referenced file sender is no longer admitted in this room',
        );
      addFiles(replied);
    }
    return { mode: 'scoped', work, event, participants, inputs };
  }

  async admit(botId, input, scope) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      typeof input.eventId !== 'string' ||
      typeof input.roomId !== 'string'
    )
      throw policyError(400, 'Invalid work admission');
    requireNodeScope(scope, { botId });
    const bot = this.bot(botId);
    const requestId = workRequestId(bot.id, input.eventId);
    const action = { requestId, botId, stage: 'accept' };
    try {
      const result = await this.evaluate(bot, input);
      if (result.mode === 'local') return result;
      const previous = this.db
        .prepare('SELECT * FROM bot_work_admissions WHERE request_id=?')
        .get(requestId);
      if (
        previous &&
        (previous.room_id !== input.roomId ||
          JSON.parse(previous.work_json).proofHash !== result.work.proofHash)
      ) {
        throw denyWork(
          'This task authorization changed; the original task cannot be readmitted',
        );
      }
      this.db
        .prepare(
          'INSERT OR IGNORE INTO bot_work_admissions(request_id,bot_id,room_id,event_id,node_tools_json,work_json,accepted_at,node_max_bytes) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          requestId,
          botId,
          input.roomId,
          input.eventId,
          JSON.stringify(input.nodeTools),
          JSON.stringify(result.work),
          new Date().toISOString(),
          input.nodeMaxBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
        );
      this.audit(action, previous ? 'duplicate' : 'authorized');
      return result;
    } catch (error) {
      this.audit(action, 'denied', error.code || error.message);
      throw error;
    }
  }

  async check(input, scope) {
    if (
      !input ||
      typeof input.requestId !== 'string' ||
      typeof input.botId !== 'string' ||
      ![
        'run',
        'model',
        'tool',
        'download',
        'upload',
        'deliver',
        'observe',
      ].includes(input.stage) ||
      [input.tool, input.callId].some(
        (value) =>
          value !== undefined &&
          (typeof value !== 'string' || value.length > 512),
      )
    )
      throw policyError(400, 'Invalid work check');
    requireNodeScope(scope, { botId: input.botId });
    const saved = this.db
      .prepare('SELECT * FROM bot_work_admissions WHERE request_id=?')
      .get(input.requestId);
    if (!saved || saved.bot_id !== input.botId)
      throw denyWork('This task has no matching work admission');
    const baseline = JSON.parse(saved.work_json);
    try {
      if (this.tasks?.get(input.requestId)?.cancelRequested)
        throw denyWork('This task has been cancelled');
      const current = await this.evaluate(this.bot(input.botId), {
        roomId: saved.room_id,
        eventId: saved.event_id,
        nodeTools: JSON.parse(saved.node_tools_json),
        nodeMaxBytes: saved.node_max_bytes ?? DEFAULT_MAX_UPLOAD_BYTES,
      });
      if (
        current.mode !== 'scoped' ||
        current.work.proofHash !== baseline.proofHash
      )
        throw denyWork(
          'The admitted work authorization has changed or been revoked',
        );
      if (
        input.stage === 'tool' &&
        (!FILE_TOOLS.includes(input.tool) ||
          !baseline.tools.includes(input.tool))
      )
        throw denyWork('This tool is outside the effective work capability');
      if (input.stage === 'download') {
        if (
          !current.inputs.some(
            (file) =>
              file.id === input.attachment?.id &&
              file.contentUri === input.attachment?.contentUri &&
              file.sha256 === input.attachment?.sha256 &&
              file.size === input.attachment?.size &&
              file.source.eventId === input.attachment?.source?.eventId &&
              file.source.senderId === input.attachment?.source?.senderId &&
              file.source.roomId === input.attachment?.source?.roomId,
          )
        )
          throw denyWork(
            'This attachment is not proven by the admitted Matrix event',
          );
      }
      if (
        input.stage === 'deliver' &&
        (input.destinationRoomId !== saved.room_id ||
          input.recipientId !== baseline.requesterId ||
          input.replyTo !== saved.event_id)
      )
        throw denyWork(
          'Results must return to the exact original room, event and full human identity',
        );
      this.audit(
        input,
        input.stage === 'observe'
          ? `observed:${['completed', 'failed', 'unknown'].includes(input.effectStatus) ? input.effectStatus : 'unknown'}`
          : 'authorized',
      );
      return {
        authorized: true,
        work: baseline,
        ...(input.stage === 'run' ? { event: current.event } : {}),
      };
    } catch (error) {
      this.audit(
        input,
        input.stage === 'observe' ? 'late_observation' : 'denied',
        input.stage === 'observe'
          ? JSON.stringify({
              effectStatus: input.effectStatus || 'unknown',
              reason: error.code || error.message,
            })
          : error.code || error.message,
      );
      if (input.stage === 'observe')
        return {
          authorized: false,
          late: true,
          effectStatus: input.effectStatus || 'unknown',
        };
      throw error;
    }
  }

  handles(pathname) {
    return (
      /^\/api\/bots\/[^/]+\/work-grants$/.test(pathname) ||
      /^\/internal\/bots\/[^/]+\/(work|rooms\/[^/]+\/directory)$/.test(
        pathname,
      ) ||
      pathname === '/internal/bot-work/check'
    );
  }

  async handle({ request, url, send }) {
    const grant = url.pathname.match(/^\/api\/bots\/([^/]+)\/work-grants$/);
    if (grant) {
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      const { user } = await this.accounts.me(token);
      const bot = this.bot(decodeURIComponent(grant[1]));
      if (bot.ownerId !== user.id)
        throw denyWork(
          'Only the existing Bot owner can change node work grants',
        );
      if (request.method === 'GET') return send(200, this.grants(bot));
      if (request.method === 'PUT')
        return send(
          200,
          this.saveGrants(bot, await this.readJsonBody(request)),
        );
      throw policyError(405, 'Unsupported owner grant operation');
    }
    const scope = this.authorizeNode(request);
    const directory = url.pathname.match(
      /^\/internal\/bots\/([^/]+)\/rooms\/([^/]+)\/directory$/,
    );
    if (request.method === 'GET' && directory) {
      const botId = decodeURIComponent(directory[1]);
      requireNodeScope(scope, { botId });
      const { participants } = await this.room(
        this.bot(botId),
        decodeURIComponent(directory[2]),
      );
      return send(200, { participants });
    }
    const admission = url.pathname.match(/^\/internal\/bots\/([^/]+)\/work$/);
    if (request.method === 'POST' && admission)
      return send(
        200,
        await this.admit(
          decodeURIComponent(admission[1]),
          await this.readJsonBody(request),
          scope,
        ),
      );
    if (
      request.method === 'POST' &&
      url.pathname === '/internal/bot-work/check'
    )
      return send(
        200,
        await this.check(await this.readJsonBody(request), scope),
      );
    throw policyError(405, 'Unsupported Bot work operation');
  }

  close() {
    this.db.close();
  }
}
