import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseMentionTokens, mentionKindsFor } from '../web/mention-tokens.js';

const failure = (status, message) => Object.assign(new Error(message), { status });
const unique = values => [...new Set(values)];
const defaults = { mode: 'all', suppressEveryone: false, suppressRoles: false, muted: false };

export class ChatFeatures {
  constructor({ setup, dataRoot, now = Date.now } = {}) {
    this.setup = setup;
    this.now = now;
    this.ownerId = setup.participants.find(person => person.kind === 'human')?.id;
    this.db = new DatabaseSync(path.join(dataRoot, 'chat-features.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chat_roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL,
        member_ids TEXT NOT NULL, mentionable INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_preferences (user_id TEXT NOT NULL, room_id TEXT NOT NULL,
        value_json TEXT NOT NULL, PRIMARY KEY(user_id,room_id));
      CREATE TABLE IF NOT EXISTS chat_presence (user_id TEXT PRIMARY KEY, status TEXT NOT NULL, touched_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
        event_id TEXT NOT NULL, room_id TEXT NOT NULL, sender_id TEXT NOT NULL, event_ts INTEGER NOT NULL,
        event_json TEXT NOT NULL, mention_kinds_json TEXT NOT NULL, UNIQUE(user_id,event_id));
      CREATE INDEX IF NOT EXISTS chat_events_user_room ON chat_events(user_id,room_id,event_ts,sequence);
      CREATE TABLE IF NOT EXISTS chat_read_markers (user_id TEXT NOT NULL, room_id TEXT NOT NULL,
        event_id TEXT NOT NULL, event_ts INTEGER NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(user_id,room_id));
    `);
    this.closed = false;
  }

  person(userId) { return this.setup.participants.find(person => person.id === userId); }

  roles() {
    return this.db.prepare('SELECT * FROM chat_roles ORDER BY name,id').all().map(row => ({
      id: row.id, name: row.name, color: row.color, memberIds: JSON.parse(row.member_ids), mentionable: Boolean(row.mentionable),
    }));
  }

  saveRole(userId, input, id) {
    if (userId !== this.ownerId) throw failure(403, 'Only the server owner can manage roles');
    if (id && !this.db.prepare('SELECT id FROM chat_roles WHERE id=?').get(id)) throw failure(404, 'Role not found');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 40
      || ['everyone', 'here'].includes(input.name.trim().toLowerCase())) throw failure(400, 'Choose a role name of 1–40 characters');
    const color = input.color || '#949ba4';
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw failure(400, 'Role color must be a six-digit hex color');
    if (!Array.isArray(input.memberIds) || input.memberIds.some(memberId => !this.person(memberId))) throw failure(400, 'Role members must be registered members');
    if (input.mentionable !== undefined && typeof input.mentionable !== 'boolean') throw failure(400, 'Invalid role mention setting');
    if (this.roles().some(role => role.id !== id && role.name.toLocaleLowerCase() === input.name.trim().toLocaleLowerCase())) {
      throw failure(409, 'A role with this name already exists');
    }
    const role = { id: id || `role-${randomUUID()}`, name: input.name.trim(), color,
      memberIds: unique(input.memberIds), mentionable: input.mentionable !== false };
    this.db.prepare(`INSERT INTO chat_roles VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,color=excluded.color,member_ids=excluded.member_ids,mentionable=excluded.mentionable`)
      .run(role.id, role.name, role.color, JSON.stringify(role.memberIds), Number(role.mentionable));
    return role;
  }

  touchPresence(userId, { status = 'online' } = {}) {
    if (!this.person(userId)) throw failure(403, 'Unknown member');
    if (!['online', 'idle', 'offline'].includes(status)) throw failure(400, 'Invalid presence');
    this.db.prepare(`INSERT INTO chat_presence VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET
      status=excluded.status,touched_at=excluded.touched_at`).run(userId, status, this.now());
    return { status };
  }

  presence(userId) {
    const current = this.db.prepare('SELECT status,touched_at FROM chat_presence WHERE user_id=?').get(userId);
    return current && this.now() - current.touched_at < 60000 ? current.status : 'offline';
  }

  preferences(userId, roomId) {
    const row = this.db.prepare('SELECT value_json FROM chat_preferences WHERE user_id=? AND room_id=?').get(userId, roomId);
    return { ...defaults, ...(row ? JSON.parse(row.value_json) : {}) };
  }

  savePreferences(userId, roomId, input) {
    const value = { ...this.preferences(userId, roomId), ...input };
    if (!['all', 'mentions', 'nothing'].includes(value.mode)) throw failure(400, 'Invalid notification mode');
    for (const name of ['suppressEveryone', 'suppressRoles', 'muted']) {
      if (typeof value[name] !== 'boolean') throw failure(400, 'Invalid notification preference');
    }
    const clean = Object.fromEntries(Object.keys(defaults).map(name => [name, value[name]]));
    this.db.prepare(`INSERT INTO chat_preferences VALUES (?,?,?) ON CONFLICT(user_id,room_id)
      DO UPDATE SET value_json=excluded.value_json`).run(userId, roomId, JSON.stringify(clean));
    return clean;
  }

  shouldNotify(userId, event) {
    if (event.sender === userId) return false;
    const preference = this.preferences(userId, event.room_id);
    if (preference.muted || preference.mode === 'nothing') return false;
    const kinds = mentionKindsFor(event, userId);
    const allowed = kinds.filter(kind => !((kind === 'everyone' || kind === 'here') && preference.suppressEveryone)
      && !(kind === 'role' && preference.suppressRoles));
    if (kinds.length && !allowed.length) return false;
    return preference.mode === 'all' || allowed.length > 0;
  }

  async roomMembers(client, roomId, userId) {
    const response = await client.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`);
    const members = Object.keys(response.joined || {});
    if (!members.includes(userId)) throw failure(403, 'Join this conversation first');
    return members;
  }

  async resolveMessage({ userId, roomId, input, client, members, directIds = [] }) {
    const joined = members || await this.roomMembers(client, roomId, userId);
    if (!joined.includes(userId)) throw failure(403, 'Join this conversation first');
    const body = input.body || '';
    if (input.replyMention !== undefined && typeof input.replyMention !== 'boolean') throw failure(400, 'Invalid reply mention setting');
    if (input.replyTo !== undefined && (typeof input.replyTo !== 'string' || !input.replyTo)) throw failure(400, 'Invalid reply target');
    const parsed = parseMentionTokens(body);
    for (const id of parsed.users) if (!joined.includes(id) || !this.person(id)) throw failure(400, 'Mentioned member is not in this conversation');
    const roles = this.roles();
    const selectedRoles = parsed.roles.map(id => {
      const role = roles.find(item => item.id === id);
      if (!role) throw failure(400, 'Mentioned role no longer exists');
      if (!role.mentionable && userId !== this.ownerId) throw failure(403, 'This role cannot be mentioned');
      return role;
    });
    if ((parsed.everyone || parsed.here) && userId !== this.ownerId) throw failure(403, 'Only the server owner can mention everyone or here');
    if (input.mentions !== undefined) {
      if (!input.mentions || typeof input.mentions !== 'object' || Array.isArray(input.mentions)) throw failure(400, 'Invalid mention metadata');
      for (const key of ['users', 'roles']) {
        const declared = input.mentions[key] ?? [];
        if (!Array.isArray(declared) || JSON.stringify(unique(declared).sort()) !== JSON.stringify([...parsed[key]].sort())) {
          throw failure(400, 'Mention metadata does not match the message');
        }
      }
      for (const key of ['everyone', 'here']) {
        if (input.mentions[key] !== undefined && typeof input.mentions[key] !== 'boolean') throw failure(400, 'Invalid mention metadata');
        if (Boolean(input.mentions[key]) !== parsed[key]) throw failure(400, 'Mention metadata does not match the message');
      }
    }
    let replyUserId;
    if (input.replyTo && input.replyMention !== false) {
      const reply = await client.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(input.replyTo)}`);
      if (reply.type !== 'm.room.message' || !joined.includes(reply.sender)) throw failure(400, 'The reply target is unavailable');
      replyUserId = reply.sender;
    }
    const humans = joined.filter(id => this.person(id)?.kind === 'human');
    const mentions = {
      users: parsed.users, roles: parsed.roles, everyone: parsed.everyone, here: parsed.here,
      ...(replyUserId ? { replyUserId } : {}),
      roleUsers: unique(selectedRoles.flatMap(role => role.memberIds)).filter(id => joined.includes(id)),
      roleLabels: Object.fromEntries(selectedRoles.map(role => [role.id, role.name])),
      everyoneUsers: parsed.everyone ? humans : [],
      hereUsers: parsed.here ? humans.filter(id => this.presence(id) === 'online') : [],
    };
    const notificationUsers = unique([...mentions.users, ...mentions.roleUsers, ...mentions.everyoneUsers,
      ...mentions.hereUsers, ...(replyUserId ? [replyUserId] : [])]).filter(id => id !== userId);
    const legacyTargets = input.to || [];
    if (!Array.isArray(legacyTargets) || legacyTargets.some(id => !joined.includes(id) || !this.person(id))) throw failure(400, 'Unknown recipient');
    const explicitBots = [...mentions.users, ...(replyUserId ? [replyUserId] : [])].filter(id => this.person(id)?.kind === 'bot');
    const directBots = directIds.includes(userId) ? directIds.filter(id => id !== userId && this.person(id)?.kind === 'bot' && joined.includes(id)) : [];
    return { body, to: unique([...legacyTargets, ...explicitBots, ...directBots]).filter(id => id !== userId), mentions,
      mMentions: { user_ids: notificationUsers, ...(parsed.everyone ? { room: true } : {}) }, replyMention: input.replyMention !== false };
  }

  recordEvents(userId, events) {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO chat_events
      (user_id,event_id,room_id,sender_id,event_ts,event_json,mention_kinds_json) VALUES (?,?,?,?,?,?,?)`);
    for (const event of events) {
      if (event.type !== 'm.room.message' || !event.event_id || !event.room_id || !event.sender || typeof event.content?.body !== 'string') continue;
      insert.run(userId, event.event_id, event.room_id, event.sender,
        Number.isFinite(event.origin_server_ts) ? event.origin_server_ts : this.now(), JSON.stringify(event), JSON.stringify(mentionKindsFor(event, userId)));
    }
  }

  unreadFor(userId, roomId) {
    const read = this.db.prepare('SELECT event_ts,sequence FROM chat_read_markers WHERE user_id=? AND room_id=?').get(userId, roomId);
    const counts = this.db.prepare(`SELECT COUNT(*) AS unread_count,
      COALESCE(SUM(CASE WHEN mention_kinds_json<>'[]' THEN 1 ELSE 0 END),0) AS mention_count
      FROM chat_events WHERE user_id=? AND room_id=? AND sender_id<>?
      AND (event_ts>? OR (event_ts=? AND sequence>?))`).get(userId, roomId, userId,
      read?.event_ts || 0, read?.event_ts || 0, read?.sequence || 0);
    const last = this.db.prepare('SELECT event_id FROM chat_events WHERE user_id=? AND room_id=? ORDER BY event_ts DESC,sequence DESC LIMIT 1').get(userId, roomId);
    return { unreadCount: counts.unread_count, mentionCount: counts.mention_count, lastEventId: last?.event_id || null };
  }

  markRead(userId, roomId, eventId) {
    const event = eventId
      ? this.db.prepare('SELECT * FROM chat_events WHERE user_id=? AND room_id=? AND event_id=?').get(userId, roomId, eventId)
      : this.db.prepare('SELECT * FROM chat_events WHERE user_id=? AND room_id=? ORDER BY event_ts DESC,sequence DESC LIMIT 1').get(userId, roomId);
    if (!event) return { read: false, ...this.unreadFor(userId, roomId) };
    this.db.prepare(`INSERT INTO chat_read_markers VALUES (?,?,?,?,?) ON CONFLICT(user_id,room_id) DO UPDATE SET
      event_id=excluded.event_id,event_ts=excluded.event_ts,sequence=excluded.sequence
      WHERE excluded.event_ts>chat_read_markers.event_ts OR (excluded.event_ts=chat_read_markers.event_ts AND excluded.sequence>chat_read_markers.sequence)`)
      .run(userId, roomId, event.event_id, event.event_ts, event.sequence);
    return { read: true, eventId: event.event_id, ...this.unreadFor(userId, roomId) };
  }

  inbox(userId, roomIds, { filter = 'mentions', includeEveryone = true, includeRoles = true, limit = 100 } = {}) {
    const joined = new Set(roomIds);
    const rows = this.db.prepare(`SELECT e.*,r.event_ts AS read_ts,r.sequence AS read_sequence FROM chat_events e
      LEFT JOIN chat_read_markers r ON r.user_id=e.user_id AND r.room_id=e.room_id
      WHERE e.user_id=? AND e.sender_id<>? ORDER BY e.event_ts DESC,e.sequence DESC`).iterate(userId, userId);
    const events = [];
    for (const row of rows) {
      if (!joined.has(row.room_id)) continue;
      const read = row.event_ts < (row.read_ts || 0) || (row.event_ts === row.read_ts && row.sequence <= row.read_sequence);
      const mentionKinds = JSON.parse(row.mention_kinds_json);
      // Discord's Mentions inbox includes direct, reply, role and everyone mentions. Here is visible under Unreads.
      const matchingKinds = mentionKinds.filter(kind => kind !== 'here' && (includeEveryone || kind !== 'everyone') && (includeRoles || kind !== 'role'));
      if (filter === 'unread' ? read : !matchingKinds.length) continue;
      events.push({ ...JSON.parse(row.event_json), mentionKinds, read });
      if (events.length >= limit) break;
    }
    const counts = roomIds.map(roomId => this.unreadFor(userId, roomId));
    return { events, unreadCount: counts.reduce((sum, item) => sum + item.unreadCount, 0), mentionCount: counts.reduce((sum, item) => sum + item.mentionCount, 0) };
  }

  handles(pathname) {
    return pathname === '/api/presence' || pathname === '/api/inbox' || /^\/api\/roles(?:\/[^/]+)?$/.test(pathname)
      || /^\/api\/rooms\/[^/]+\/(mentionables|notifications|read)$/.test(pathname);
  }

  async handle({ request, url, userId, client, readJsonBody, send }) {
    if (!this.person(userId)) throw failure(403, 'Unknown member');
    if (url.pathname === '/api/presence' && request.method === 'POST') return send(200, this.touchPresence(userId, await readJsonBody(request)));
    if (url.pathname === '/api/inbox' && request.method === 'GET') {
      const { joined_rooms: roomIds } = await client.request('GET', '/_matrix/client/v3/joined_rooms');
      return send(200, this.inbox(userId, roomIds, { filter: url.searchParams.get('filter') === 'unread' ? 'unread' : 'mentions',
        includeEveryone: url.searchParams.get('includeEveryone') !== 'false', includeRoles: url.searchParams.get('includeRoles') !== 'false',
        limit: Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 100, 200)) }));
    }
    if (url.pathname === '/api/roles') {
      if (request.method === 'GET') return send(200, { roles: this.roles(), canManage: userId === this.ownerId });
      if (request.method === 'POST') return send(201, { role: this.saveRole(userId, await readJsonBody(request)) });
    }
    const rolePath = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
    if (rolePath) {
      const id = decodeURIComponent(rolePath[1]);
      if (request.method === 'PUT') return send(200, { role: this.saveRole(userId, await readJsonBody(request), id) });
      if (request.method === 'DELETE') {
        if (userId !== this.ownerId) throw failure(403, 'Only the server owner can manage roles');
        return send(200, { deleted: this.db.prepare('DELETE FROM chat_roles WHERE id=?').run(id).changes > 0 });
      }
    }
    const roomPath = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(mentionables|notifications|read)$/);
    if (roomPath) {
      const roomId = decodeURIComponent(roomPath[1]);
      const members = await this.roomMembers(client, roomId, userId);
      if (roomPath[2] === 'mentionables' && request.method === 'GET') {
        return send(200, { members: members.map(id => this.person(id)).filter(Boolean).map(({ id, name, localpart, kind }) => ({ id, name, localpart, kind, status: this.presence(id) })),
          roles: this.roles().filter(role => role.memberIds.some(id => members.includes(id)))
            .map(role => ({ ...role, canMention: role.mentionable || userId === this.ownerId })),
          canMentionEveryone: userId === this.ownerId, canMentionHere: userId === this.ownerId });
      }
      if (roomPath[2] === 'notifications') {
        if (request.method === 'GET') return send(200, this.preferences(userId, roomId));
        if (request.method === 'PUT') return send(200, this.savePreferences(userId, roomId, await readJsonBody(request)));
      }
      if (roomPath[2] === 'read' && request.method === 'POST') {
        const input = await readJsonBody(request);
        return send(200, this.markRead(userId, roomId, input.eventId));
      }
    }
    return send(405, { error: 'Method not allowed' });
  }

  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
