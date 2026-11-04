import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import webPush from 'web-push';
import { MatrixClient } from './matrix-client.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const pause = (milliseconds, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, milliseconds);
  signal?.addEventListener('abort', finish, { once: true });
});

function failure(status, message) { return Object.assign(new Error(message), { status }); }

function checkedSubscription(input) {
  if (!input || typeof input !== 'object' || typeof input.endpoint !== 'string' || input.endpoint.length > 4096) {
    throw failure(400, 'Invalid push subscription');
  }
  let endpoint;
  try { endpoint = new URL(input.endpoint); } catch { throw failure(400, 'Invalid push endpoint'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) {
    throw failure(400, 'Push endpoint must use HTTPS');
  }
  for (const [name, length] of [['p256dh', 65], ['auth', 16]]) {
    const value = input.keys?.[name];
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value) || Buffer.from(value, 'base64url').length !== length) {
      throw failure(400, `Invalid push ${name} key`);
    }
  }
  return { endpoint: input.endpoint, expirationTime: Number.isFinite(input.expirationTime) ? input.expirationTime : null,
    keys: { p256dh: input.keys.p256dh, auth: input.keys.auth } };
}

/** Standard Web Push delivery and per-human Matrix notification cursors. */
export class PushService {
  constructor({ dataRoot, setup, transport, clientFactory, now = Date.now, pollTimeout = 10000, retryDelays = [30000, 120000], onError = console.error } = {}) {
    if (!dataRoot || !setup?.participants || !setup.homeserverUrl) throw new Error('Push service needs a data root and Matrix setup');
    this.setup = setup;
    this.dataRoot = dataRoot;
    this.now = now;
    this.pollTimeout = pollTimeout;
    this.retryDelays = retryDelays;
    this.onError = onError;
    this.transport = transport || ((subscription, payload, options) => webPush.sendNotification(subscription, payload, options));
    this.humans = setup.participants.filter(person => person.kind === 'human');
    this.clients = new Map(this.humans.map(person => [person.id, clientFactory ? clientFactory(person) : new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: person.accessToken })]));
    this.controller = new AbortController();
    this.loops = [];
    this.roomNames = new Map();
    this.deliveryWork = null;
    this.started = false;
    this.closed = false;
    this.ready = this.initialize();
  }

  async initialize() {
    await mkdir(this.dataRoot, { recursive: true });
    const keyPath = path.join(this.dataRoot, 'push-vapid.json');
    try { this.vapid = JSON.parse(await readFile(keyPath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const generated = { ...webPush.generateVAPIDKeys(), subject: process.env.DS_GROUP_PUSH_SUBJECT || 'https://github.com/MixGeekers/shiyu' };
      try { await writeFile(keyPath, JSON.stringify(generated, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); this.vapid = generated; }
      catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
        this.vapid = JSON.parse(await readFile(keyPath, 'utf8'));
      }
    }
    if (!this.vapid.publicKey || !this.vapid.privateKey || !this.vapid.subject) throw new Error('Stored VAPID keys are incomplete');
    await chmod(keyPath, 0o600);
    const filename = path.join(this.dataRoot, 'push.sqlite');
    this.db = new DatabaseSync(filename);
    await chmod(filename, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE,
        subscription_json TEXT NOT NULL, device_label TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_cursors (user_id TEXT PRIMARY KEY, cursor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_seen_events (user_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(user_id,event_id));
      CREATE TABLE IF NOT EXISTS push_deliveries (
        subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL, user_id TEXT NOT NULL, payload_json TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
        created_at INTEGER NOT NULL, sent_at INTEGER, last_error TEXT,
        PRIMARY KEY(subscription_id,event_id)
      );
      UPDATE push_deliveries SET status='unknown',last_error='PROCESS_STOPPED_DURING_SEND' WHERE status='sending';
    `);
  }

  human(userId) {
    const person = this.humans.find(item => item.id === userId);
    if (!person) throw failure(403, 'Notifications are available to registered human members');
    return person;
  }

  async getConfig() {
    await this.ready;
    return { enabled: true, publicKey: this.vapid.publicKey, requiresSecureContext: true };
  }

  async subscriptions(userId) {
    await this.ready;
    this.human(userId);
    return this.db.prepare('SELECT id,device_label,created_at,updated_at FROM push_subscriptions WHERE user_id=? ORDER BY created_at').all(userId)
      .map(row => ({ id: row.id, deviceLabel: row.device_label, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  async subscribe(userId, { subscription, deviceLabel = '' } = {}) {
    await this.ready;
    this.human(userId);
    const clean = checkedSubscription(subscription);
    if (typeof deviceLabel !== 'string' || deviceLabel.length > 120) throw failure(400, 'Invalid device label');
    const id = digest(clean.endpoint);
    const previous = this.db.prepare('SELECT user_id FROM push_subscriptions WHERE id=?').get(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // One browser subscription follows its current signed-in human identity.
      if (previous && previous.user_id !== userId) this.db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(id);
      this.db.prepare(`INSERT INTO push_subscriptions VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,subscription_json=excluded.subscription_json,
          device_label=excluded.device_label,updated_at=excluded.updated_at`).run(id, userId, clean.endpoint, JSON.stringify(clean), deviceLabel, this.now(), this.now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { subscribed: true, id, deviceLabel };
  }

  async unsubscribe(userId, endpoint) {
    await this.ready;
    this.human(userId);
    if (typeof endpoint !== 'string' || endpoint.length > 4096) throw failure(400, 'Invalid push endpoint');
    const result = this.db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(userId, endpoint);
    return { unsubscribed: result.changes > 0 };
  }

  payload(event) {
    const sender = this.setup.participants.find(person => person.id === event.sender)?.name || event.sender;
    const group = Boolean(event.room_name) || event.room_id === this.setup.roomId;
    const roomName = event.room_name || (group ? '初次协作' : sender);
    const text = [...event.content.body].slice(0, 180).join('');
    return { title: group ? `DS-Group · ${roomName}` : sender, body: group ? `${sender}：${text}` : text,
      tag: `ds-group-${digest(event.event_id).slice(0, 32)}`, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      data: { url: `/?roomId=${encodeURIComponent(event.room_id)}&eventId=${encodeURIComponent(event.event_id)}`, roomId: event.room_id, eventId: event.event_id } };
  }

  enqueueFor(userId, event) {
    if (event.type !== 'm.room.message' || typeof event.event_id !== 'string' || typeof event.room_id !== 'string'
      || typeof event.sender !== 'string' || typeof event.content?.body !== 'string' || !event.content.body.trim() || event.sender === userId) return 0;
    const payload = JSON.stringify(this.payload(event));
    const occurredAt = Number.isFinite(event.origin_server_ts) ? event.origin_server_ts : this.now();
    const subscriptions = this.db.prepare('SELECT id FROM push_subscriptions WHERE user_id=? AND created_at<=?').all(userId, occurredAt);
    let queued = 0;
    for (const subscription of subscriptions) {
      queued += this.db.prepare(`INSERT OR IGNORE INTO push_deliveries
        (subscription_id,event_id,user_id,payload_json,status,next_attempt,created_at) VALUES (?,?,?,?, 'pending',?,?)`)
        .run(subscription.id, event.event_id, userId, payload, this.now(), this.now()).changes;
    }
    return queued;
  }

  async notifyMessage(event, recipientIds) {
    await this.ready;
    let recipients = recipientIds;
    if (!recipients) {
      recipients = [];
      for (const [userId, client] of this.clients) {
        try {
          const members = await client.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(event.room_id)}/joined_members`, undefined, { signal: this.controller.signal });
          recipients = Object.keys(members.joined || {});
          break;
        } catch (error) { if (error.status !== 403 && error.status !== 404) throw error; }
      }
    }
    let queued = 0;
    for (const person of this.humans) if (recipients.includes(person.id)) queued += this.enqueueFor(person.id, event);
    const delivery = await this.drain();
    return { queued, ...delivery };
  }

  async sendTest(userId) {
    await this.ready;
    this.human(userId);
    const subscriptions = this.db.prepare('SELECT id FROM push_subscriptions WHERE user_id=?').all(userId);
    if (!subscriptions.length) throw failure(404, 'Enable notifications on this device first');
    const eventId = `test-${randomUUID()}`;
    const payload = JSON.stringify({ title: 'DS-Group', body: '通知已启用', tag: eventId,
      icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: '/', test: true } });
    for (const subscription of subscriptions) this.db.prepare(`INSERT INTO push_deliveries
      (subscription_id,event_id,user_id,payload_json,status,next_attempt,created_at) VALUES (?,?,?,?, 'pending',?,?)`)
      .run(subscription.id, eventId, userId, payload, this.now(), this.now());
    await this.drain();
    const rows = this.db.prepare('SELECT status FROM push_deliveries WHERE event_id=? AND user_id=?').all(eventId, userId);
    return { eventId, devices: subscriptions.length, sent: rows.filter(row => row.status === 'sent').length,
      pending: rows.filter(row => row.status === 'pending').length, failed: subscriptions.length - rows.filter(row => ['sent', 'pending'].includes(row.status)).length };
  }

  async drain() {
    await this.ready;
    if (this.deliveryWork) return this.deliveryWork;
    const work = this.deliverPending();
    this.deliveryWork = work;
    try { return await work; } finally { if (this.deliveryWork === work) this.deliveryWork = null; }
  }

  async deliverPending() {
    const rows = this.db.prepare(`SELECT d.*,s.subscription_json FROM push_deliveries d
      JOIN push_subscriptions s ON s.id=d.subscription_id WHERE d.status='pending' AND d.next_attempt<=?
      ORDER BY d.created_at LIMIT 100`).all(this.now());
    const result = { sent: 0, failed: 0, pending: 0 };
    for (const row of rows) {
      if (this.closed) break;
      const claimed = this.db.prepare("UPDATE push_deliveries SET status='sending',attempts=attempts+1 WHERE subscription_id=? AND event_id=? AND status='pending'").run(row.subscription_id, row.event_id);
      if (!claimed.changes) continue;
      try {
        await this.transport(JSON.parse(row.subscription_json), row.payload_json, { vapidDetails: this.vapid, timeout: 8000, TTL: 86400, urgency: 'normal' });
        this.db.prepare("UPDATE push_deliveries SET status='sent',sent_at=?,last_error=NULL WHERE subscription_id=? AND event_id=?").run(this.now(), row.subscription_id, row.event_id);
        result.sent++;
      } catch (error) {
        const status = error.statusCode || error.status;
        const code = Number.isInteger(status) ? `PUSH_HTTP_${status}` : 'PUSH_TRANSPORT_ERROR';
        if (status === 404 || status === 410) {
          this.db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(row.subscription_id);
          result.failed++;
          continue;
        }
        const retryable = !status || status === 408 || status === 429 || status >= 500;
        const retryDelay = this.retryDelays[row.attempts];
        const retry = retryable && retryDelay !== undefined;
        this.db.prepare('UPDATE push_deliveries SET status=?,next_attempt=?,last_error=? WHERE subscription_id=? AND event_id=?')
          .run(retry ? 'pending' : 'failed', this.now() + (retryDelay || 0), code, row.subscription_id, row.event_id);
        result[retry ? 'pending' : 'failed']++;
      }
    }
    return result;
  }

  async collectEvents(userId, roomId, room) {
    const timeline = room.timeline || {};
    const current = (timeline.events || []).map(event => ({ ...event, room_id: roomId }));
    const since = this.db.prepare('SELECT cursor FROM push_cursors WHERE user_id=?').get(userId);
    if (!since || !timeline.limited || !timeline.prev_batch) return current;
    const older = [];
    const tokens = new Set();
    let token = timeline.prev_batch;
    for (let page = 0; page < 100; page++) {
      if (tokens.has(token)) throw new Error('Push Matrix history pagination did not advance');
      tokens.add(token);
      const result = await this.clients.get(userId).request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=100&from=${encodeURIComponent(token)}`, undefined, { signal: this.controller.signal });
      const chunk = result.chunk || [];
      const boundary = chunk.findIndex(event => this.db.prepare('SELECT 1 FROM push_seen_events WHERE user_id=? AND event_id=?').get(userId, event.event_id));
      older.push(...(boundary < 0 ? chunk : chunk.slice(0, boundary)));
      if (boundary >= 0 || !chunk.length || !result.end) return [...older.reverse().map(event => ({ ...event, room_id: roomId })), ...current];
      token = result.end;
    }
    throw new Error('Push Matrix history gap exceeded 100 pages');
  }

  async roomName(userId, roomId, room) {
    const names = [...(room.state?.events || []), ...(room.timeline?.events || [])].filter(event => event.type === 'm.room.name');
    const current = names.at(-1)?.content?.name;
    if (typeof current === 'string') this.roomNames.set(roomId, current.slice(0, 80));
    if (this.roomNames.has(roomId)) return this.roomNames.get(roomId);
    if (typeof this.clients.get(userId).request !== 'function') return undefined;
    try {
      const state = await this.clients.get(userId).request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`, undefined, { signal: this.controller.signal });
      if (typeof state.name === 'string') this.roomNames.set(roomId, state.name.slice(0, 80));
    } catch (error) { if (error.status !== 403 && error.status !== 404) throw error; }
    return this.roomNames.get(roomId);
  }

  async syncOnce(userId) {
    await this.ready;
    this.human(userId);
    const since = this.db.prepare('SELECT cursor FROM push_cursors WHERE user_id=?').get(userId)?.cursor;
    const response = await this.clients.get(userId).sync({ since, timeout: this.pollTimeout, signal: this.controller.signal });
    if (this.closed) return { queued: 0 };
    if (typeof response.next_batch !== 'string' || !response.next_batch) throw new Error('Matrix did not return a sync cursor');
    const events = [];
    for (const [roomId, room] of Object.entries(response.rooms?.join || {})) {
      const roomName = await this.roomName(userId, roomId, room);
      events.push(...(await this.collectEvents(userId, roomId, room)).map(event => ({ ...event, ...(roomName ? { room_name: roomName } : {}) })));
    }
    if (this.closed) return { queued: 0 };
    this.db.exec('BEGIN IMMEDIATE');
    let queued = 0;
    try {
      for (const event of events) {
        if (typeof event.event_id !== 'string') continue;
        const inserted = this.db.prepare('INSERT OR IGNORE INTO push_seen_events VALUES (?,?)').run(userId, event.event_id);
        if (inserted.changes) queued += this.enqueueFor(userId, event);
      }
      this.db.prepare('INSERT INTO push_cursors VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET cursor=excluded.cursor').run(userId, response.next_batch);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    await this.drain();
    return { queued };
  }

  async syncLoop(userId) {
    let delay = 1000;
    while (!this.controller.signal.aborted) {
      try { await this.syncOnce(userId); delay = 1000; await pause(100, this.controller.signal); }
      catch (error) {
        if (this.controller.signal.aborted) break;
        this.onError(`Push sync paused for ${userId}: ${error.status || 'transport'}`);
        await pause(delay, this.controller.signal);
        delay = Math.min(delay * 2, 30000);
      }
    }
  }

  async start() {
    await this.ready;
    if (this.closed) throw new Error('Push service is closed');
    if (this.started) return;
    this.started = true;
    this.loops = this.humans.map(person => this.syncLoop(person.id));
    this.loops.push((async () => {
      while (!this.controller.signal.aborted) {
        try { await this.drain(); } catch { this.onError('Push delivery queue is temporarily unavailable'); }
        await pause(1000, this.controller.signal);
      }
    })());
  }

  async close() {
    await this.ready;
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    await Promise.allSettled(this.loops);
    await this.deliveryWork?.catch(() => {});
    this.db.close();
  }
}
