import { DatabaseSync } from 'node:sqlite';

/** Durable Matrix inbox and send outbox for one Bot identity. */
export class NodeStore {
  constructor(filename, botId) {
    this.botId = botId;
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS node_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox (
        event_id TEXT PRIMARY KEY REFERENCES messages(event_id),
        status TEXT NOT NULL,
        request_json TEXT,
        response_json TEXT,
        error TEXT,
        session_id TEXT
      );
      CREATE TABLE IF NOT EXISTS outbox (
        transaction_id TEXT PRIMARY KEY,
        source_event_id TEXT NOT NULL REFERENCES inbox(event_id),
        ordinal INTEGER NOT NULL,
        room_id TEXT NOT NULL,
        body TEXT NOT NULL,
        options_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        sent_event_id TEXT,
        last_error TEXT,
        routing_frozen INTEGER NOT NULL DEFAULT 0,
        UNIQUE(source_event_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS delivery_routes (
        event_id TEXT PRIMARY KEY REFERENCES inbox(event_id), route_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, frozen INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS delivery_controls (
        event_id TEXT PRIMARY KEY REFERENCES inbox(event_id), control_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifact_uploads (
        event_id TEXT NOT NULL REFERENCES inbox(event_id),
        artifact_key TEXT NOT NULL,
        attachment_json TEXT NOT NULL,
        PRIMARY KEY(event_id, artifact_key)
      );
      CREATE TABLE IF NOT EXISTS task_updates (
        event_id TEXT PRIMARY KEY REFERENCES inbox(event_id),
        payload_json TEXT NOT NULL,
        dirty INTEGER NOT NULL DEFAULT 1
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(column => column.name === 'routing_frozen')) {
      this.transaction(() => this.db.exec('ALTER TABLE outbox ADD COLUMN routing_frozen INTEGER NOT NULL DEFAULT 0; UPDATE outbox SET routing_frozen=1'));
    }
    const identity = this.db.prepare('SELECT value FROM node_meta WHERE key=\'botId\'').get();
    if (identity && identity.value !== botId) {
      this.db.close();
      throw new Error('Node data belongs to a different Bot identity');
    }
    this.db.prepare('INSERT OR IGNORE INTO node_meta VALUES (\'botId\', ?)').run(botId);
    // A request interrupted before its result was persisted needs reconciliation.
    // It is never silently sent to the model again on process restart.
    this.db.prepare("UPDATE inbox SET status='unknown', error='Node stopped while awaiting a model result' WHERE status='running'").run();
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  cursor() {
    return this.db.prepare('SELECT value FROM node_meta WHERE key=\'syncCursor\'').get()?.value;
  }

  hasEvent(eventId) {
    return Boolean(this.db.prepare('SELECT 1 FROM messages WHERE event_id=?').get(eventId));
  }

  message(eventId) {
    const row = this.db.prepare('SELECT event_json FROM messages WHERE event_id=?').get(eventId);
    return row ? JSON.parse(row.event_json) : undefined;
  }

  messageBatch(event) {
    const batchId = event.content?.['org.ds_group']?.fileBatch?.id;
    if (!batchId) return [event];
    return this.db.prepare('SELECT event_json FROM messages WHERE room_id=? AND sender_id=? AND json_extract(event_json,?)=? ORDER BY sequence')
      .all(event.room_id, event.sender, '$.content."org.ds_group".fileBatch.id', batchId).map(row => JSON.parse(row.event_json));
  }

  ingest(events, cursor, onAccepted) {
    return this.transaction(() => {
      let accepted = 0;
      for (const event of events) {
        if (event.type !== 'm.room.message' || typeof event.event_id !== 'string'
          || typeof event.room_id !== 'string' || typeof event.sender !== 'string'
          || typeof event.content?.body !== 'string') continue;
        const result = this.db.prepare('INSERT OR IGNORE INTO messages(event_id,room_id,sender_id,event_json) VALUES (?,?,?,?)')
          .run(event.event_id, event.room_id, event.sender, JSON.stringify(event));
        if (!result.changes) continue;
        accepted++;
        const targets = event.content['org.ds_group']?.to;
        if (event.sender !== this.botId && Array.isArray(targets) && targets.includes(this.botId)) {
          this.db.prepare("INSERT INTO inbox(event_id,status) VALUES (?, 'queued')").run(event.event_id);
          if (onAccepted) onAccepted(event);
        }
      }
      if (cursor !== undefined) {
        if (typeof cursor !== 'string' || !cursor) throw new Error('Invalid Matrix sync cursor');
        this.db.prepare("INSERT INTO node_meta VALUES ('syncCursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(cursor);
      }
      return accepted;
    });
  }

  next() {
    const row = this.db.prepare(`SELECT inbox.*, messages.event_json FROM inbox
      JOIN messages USING(event_id) WHERE inbox.status='queued' ORDER BY messages.sequence LIMIT 1`).get();
    return row ? { ...row, event: JSON.parse(row.event_json) } : undefined;
  }

  item(eventId) {
    if (typeof eventId !== 'string') return undefined;
    const row = this.db.prepare('SELECT inbox.*, messages.event_json FROM inbox JOIN messages USING(event_id) WHERE event_id=?').get(eventId);
    return row ? { ...row, event: JSON.parse(row.event_json), request: row.request_json ? JSON.parse(row.request_json) : null,
      response: row.response_json ? JSON.parse(row.response_json) : null } : undefined;
  }

  previousRequest(event) {
    const row = this.db.prepare(`SELECT inbox.event_id FROM inbox JOIN messages USING(event_id)
      WHERE room_id=? AND sender_id=? AND sequence<(SELECT sequence FROM messages WHERE event_id=?)
      ORDER BY sequence DESC LIMIT 1`).get(event.room_id, event.sender, event.event_id);
    return row ? this.item(row.event_id) : undefined;
  }

  sourceForSentEvent(eventId) {
    const row = this.db.prepare('SELECT source_event_id FROM outbox WHERE sent_event_id=?').get(eventId);
    return row ? this.item(row.source_event_id) : undefined;
  }

  frozenFinal(eventId) {
    const item = this.item(eventId);
    if (item?.response?.delegated) return undefined;
    return this.db.prepare('SELECT room_id,status FROM outbox WHERE source_event_id=? AND routing_frozen=1 ORDER BY ordinal LIMIT 1').get(eventId);
  }

  inheritFrozenDelivery(eventId, delivery) {
    const current = this.route(eventId);
    if (!current || current.frozen) return;
    const { revision, frozen, ...route } = current;
    this.db.prepare('UPDATE delivery_routes SET route_json=?,frozen=1 WHERE event_id=?')
      .run(JSON.stringify({ ...route, roomId: delivery.room_id, state: delivery.status === 'sent' ? 'sent' : 'sending' }), eventId);
  }

  interveningHuman(event, previousEventId, humanIds) {
    if (!humanIds.length) return false;
    return Boolean(this.db.prepare(`SELECT 1 FROM messages WHERE room_id=? AND sender_id<>?
      AND sender_id IN (${humanIds.map(() => '?').join(',')})
      AND sequence>(SELECT sequence FROM messages WHERE event_id=?)
      AND sequence<(SELECT sequence FROM messages WHERE event_id=?) LIMIT 1`)
      .get(event.room_id, event.sender, ...humanIds, previousEventId, event.event_id));
  }

  finalResult(eventId) {
    const item = this.item(eventId);
    if (!item?.response?.delegated) return item;
    const row = this.db.prepare(`SELECT inbox.event_id FROM inbox JOIN messages USING(event_id)
      WHERE inbox.status='completed' AND json_extract(event_json,?)=?
      AND json_extract(event_json,?)='task.result' AND COALESCE(json_extract(response_json,'$.delegated'),0)=0
      ORDER BY sequence DESC LIMIT 1`).get('$.content."org.ds_group".originEventId', eventId, '$.content."org.ds_group".kind');
    return row ? this.item(row.event_id) : item;
  }

  route(eventId) {
    const row = this.db.prepare('SELECT * FROM delivery_routes WHERE event_id=?').get(eventId);
    return row ? { ...JSON.parse(row.route_json), revision: row.revision, frozen: Boolean(row.frozen) } : undefined;
  }

  setRoute(eventId, value) {
    const current = this.route(eventId);
    if (current?.frozen) return current;
    const { revision: ignoredRevision, frozen: ignoredFrozen, ...route } = value;
    const serialized = JSON.stringify(route);
    this.db.prepare(`INSERT INTO delivery_routes(event_id,route_json) VALUES (?,?)
      ON CONFLICT(event_id) DO UPDATE SET route_json=excluded.route_json,revision=delivery_routes.revision+1
      WHERE delivery_routes.frozen=0 AND delivery_routes.route_json<>excluded.route_json`).run(eventId, serialized);
    return this.route(eventId);
  }

  control(eventId) {
    const row = this.db.prepare('SELECT control_json FROM delivery_controls WHERE event_id=?').get(eventId);
    return row ? JSON.parse(row.control_json) : undefined;
  }

  setControl(eventId, control) {
    this.db.prepare('INSERT INTO delivery_controls VALUES (?,?) ON CONFLICT(event_id) DO UPDATE SET control_json=excluded.control_json')
      .run(eventId, JSON.stringify(control));
  }

  delivery(transactionId) {
    const row = this.db.prepare('SELECT * FROM outbox WHERE transaction_id=?').get(transactionId);
    return row ? { ...row, options: JSON.parse(row.options_json) } : undefined;
  }

  freezeDeliveries({ eventId, role, routeEventId, revision, roomId, intent, optionsFor, freezeTask }) {
    return this.transaction(() => {
      const current = this.route(routeEventId);
      if (!current || current.revision !== revision) return false;
      const rows = this.db.prepare("SELECT * FROM outbox WHERE source_event_id=? AND status='pending'").all(eventId)
        .map(row => ({ ...row, options: JSON.parse(row.options_json) })).filter(row => row.options.deliveryRole === role);
      if (rows.some(row => row.routing_frozen)) return true;
      for (const row of rows) {
        const prepared = optionsFor(row);
        this.db.prepare('UPDATE outbox SET room_id=?,body=?,options_json=?,routing_frozen=1 WHERE transaction_id=?')
          .run(roomId, prepared.body ?? row.body, JSON.stringify(prepared.options), row.transaction_id);
      }
      if (freezeTask) {
        const { revision: ignoredRevision, frozen: ignoredFrozen, ...route } = current;
        route.roomId = roomId;
        route.state = 'sending';
        this.db.prepare('UPDATE delivery_routes SET route_json=?,revision=revision+1,frozen=1 WHERE event_id=?')
          .run(JSON.stringify(route), routeEventId);
        if (routeEventId !== eventId) {
          const own = this.route(eventId);
          const { revision: ownRevision, frozen: ownFrozen, ...ownRoute } = own || {};
          this.db.prepare(`INSERT INTO delivery_routes(event_id,route_json,frozen) VALUES (?,?,1)
            ON CONFLICT(event_id) DO UPDATE SET route_json=excluded.route_json,revision=delivery_routes.revision+1,frozen=1`)
            .run(eventId, JSON.stringify({ ...ownRoute, ...intent, roomId, state: 'sending', authoritative: false }));
        }
      }
      return true;
    });
  }

  deliverySent(eventId) {
    const current = this.route(eventId);
    if (!current?.frozen) return;
    const { revision: ignoredRevision, frozen: ignoredFrozen, ...route } = current;
    this.db.prepare('UPDATE delivery_routes SET route_json=? WHERE event_id=?').run(JSON.stringify({ ...route, state: 'sent' }), eventId);
  }

  pendingResult() {
    const row = this.db.prepare("SELECT inbox.event_id FROM inbox JOIN messages USING(event_id) WHERE inbox.status='produced' ORDER BY messages.sequence LIMIT 1").get();
    return row ? this.item(row.event_id) : undefined;
  }

  interrupted() {
    return this.db.prepare("SELECT event_id FROM inbox WHERE status='unknown' AND request_json IS NOT NULL").all().map(row => this.item(row.event_id));
  }

  historyBefore(eventId, limit = 40) {
    return this.db.prepare(`SELECT event_json FROM messages WHERE room_id =
      (SELECT room_id FROM messages WHERE event_id=?) AND sequence <
      (SELECT sequence FROM messages WHERE event_id=?) ORDER BY sequence DESC LIMIT ?`)
      .all(eventId, eventId, limit).reverse().map(row => JSON.parse(row.event_json));
  }

  begin(eventId, request) {
    const result = this.db.prepare("UPDATE inbox SET status='running',request_json=? WHERE event_id=? AND status='queued'")
      .run(JSON.stringify(request), eventId);
    if (result.changes !== 1) throw new Error('Inbox item is not queued');
  }

  prepared(eventId, request) {
    const result = this.db.prepare("UPDATE inbox SET request_json=? WHERE event_id=? AND status='running'").run(JSON.stringify(request), eventId);
    if (result.changes !== 1) throw new Error('Inbox item is not running');
  }

  resume(eventId) {
    const result = this.db.prepare("UPDATE inbox SET status='running',error=NULL WHERE event_id=? AND status='unknown'").run(eventId);
    if (result.changes !== 1) throw new Error('Inbox item has no interrupted request');
  }

  produced(eventId, response) {
    const result = this.db.prepare("UPDATE inbox SET status='produced',response_json=?,session_id=?,error=NULL WHERE event_id=? AND status IN ('running','unknown','produced')")
      .run(JSON.stringify(response), response.sessionId ?? null, eventId);
    if (result.changes !== 1) throw new Error('Inbox item cannot accept a generation result');
  }

  uploaded(eventId, key) {
    const row = this.db.prepare('SELECT attachment_json FROM artifact_uploads WHERE event_id=? AND artifact_key=?').get(eventId, key);
    return row ? JSON.parse(row.attachment_json) : undefined;
  }

  recordUpload(eventId, key, attachment) {
    this.db.prepare('INSERT INTO artifact_uploads VALUES (?,?,?) ON CONFLICT(event_id,artifact_key) DO UPDATE SET attachment_json=excluded.attachment_json')
      .run(eventId, key, JSON.stringify(attachment));
  }

  task(eventId) {
    const row = this.db.prepare('SELECT payload_json FROM task_updates WHERE event_id=?').get(eventId);
    return row ? JSON.parse(row.payload_json) : undefined;
  }

  updateTask(eventId, payload) {
    this.db.prepare('INSERT INTO task_updates VALUES (?,?,1) ON CONFLICT(event_id) DO UPDATE SET payload_json=excluded.payload_json,dirty=1')
      .run(eventId, JSON.stringify(payload));
  }

  pendingTaskUpdates() {
    return this.db.prepare('SELECT event_id,payload_json FROM task_updates WHERE dirty=1').all()
      .map(row => ({ eventId: row.event_id, payload: JSON.parse(row.payload_json) }));
  }

  waitingTasks() {
    return this.db.prepare("SELECT event_id,payload_json FROM task_updates WHERE json_extract(payload_json,'$.status')='running' AND json_extract(payload_json,'$.stage')='waiting_for_bot'")
      .all().map(row => ({ eventId: row.event_id, payload: JSON.parse(row.payload_json) }));
  }

  acknowledgeTask(eventId, payload) {
    this.db.prepare('UPDATE task_updates SET dirty=0 WHERE event_id=? AND payload_json=?').run(eventId, JSON.stringify(payload));
  }

  generated(eventId, response, deliveries) {
    this.transaction(() => {
      const result = this.db.prepare("UPDATE inbox SET status='generated',response_json=?,session_id=? WHERE event_id=? AND status IN ('running','produced')")
        .run(JSON.stringify(response), response.sessionId ?? null, eventId);
      if (result.changes !== 1) throw new Error('Inbox item is not running');
      for (const [ordinal, delivery] of deliveries.entries()) {
        this.db.prepare('INSERT INTO outbox(transaction_id,source_event_id,ordinal,room_id,body,options_json) VALUES (?,?,?,?,?,?)')
          .run(delivery.options.transactionId, eventId, ordinal, delivery.roomId, delivery.body, JSON.stringify(delivery.options));
      }
      if (!deliveries.length) this.db.prepare("UPDATE inbox SET status='completed' WHERE event_id=?").run(eventId);
    });
  }

  failed(eventId, error, status = 'failed') {
    if (!['failed', 'unknown', 'cancelled'].includes(status)) throw new Error('Invalid failure status');
    this.db.prepare("UPDATE inbox SET status=?,error=? WHERE event_id=? AND status IN ('queued','running','produced','unknown')")
      .run(status, String(error).slice(0, 1000), eventId);
  }

  pendingDelivery() {
    const row = this.db.prepare(`SELECT outbox.* FROM outbox JOIN messages ON messages.event_id=outbox.source_event_id
      WHERE outbox.status='pending' ORDER BY messages.sequence,outbox.ordinal LIMIT 1`).get();
    return row ? { ...row, options: JSON.parse(row.options_json) } : undefined;
  }

  sent(transactionId, sentEventId, onCommittedReceipt) {
    if (typeof sentEventId !== 'string' || !sentEventId) throw new Error('Missing Matrix event receipt');
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM outbox WHERE transaction_id=?').get(transactionId);
      if (!row) throw new Error('Unknown delivery transaction');
      if (row.status === 'sent' && row.sent_event_id !== sentEventId) throw new Error('Matrix receipt changed for a sent transaction');
      this.db.prepare("UPDATE outbox SET status='sent',sent_event_id=?,last_error=NULL WHERE transaction_id=?")
        .run(sentEventId, transactionId);
      const pending = this.db.prepare("SELECT 1 FROM outbox WHERE source_event_id=? AND status='pending'").get(row.source_event_id);
      if (!pending) this.db.prepare("UPDATE inbox SET status=CASE WHEN json_extract(response_json,'$.failure')=1 THEN 'failed' ELSE 'completed' END WHERE event_id=? AND status='generated'")
        .run(row.source_event_id);
      if (onCommittedReceipt) onCommittedReceipt();
    });
  }

  deliveryFailed(transactionId, error, { terminal = false } = {}) {
    const message = String(error).slice(0, 1000);
    if (!terminal) {
      this.db.prepare("UPDATE outbox SET last_error=? WHERE transaction_id=? AND status='pending'").run(message, transactionId);
      return;
    }
    this.transaction(() => {
      const row = this.db.prepare('SELECT source_event_id FROM outbox WHERE transaction_id=?').get(transactionId);
      if (!row) throw new Error('Unknown delivery transaction');
      this.db.prepare("UPDATE outbox SET status='failed',last_error=? WHERE source_event_id=? AND status='pending'").run(message, row.source_event_id);
      this.db.prepare("UPDATE inbox SET status='failed',error=? WHERE event_id=? AND status='generated'").run(message, row.source_event_id);
    });
  }

  cancelDelivery(eventId) {
    this.transaction(() => {
      this.db.prepare("UPDATE outbox SET status='cancelled',last_error='Task cancelled before delivery' WHERE source_event_id=? AND status='pending'").run(eventId);
      this.db.prepare("UPDATE inbox SET status='cancelled',error='Task cancelled before delivery' WHERE event_id=? AND status='generated'").run(eventId);
    });
  }

  snapshot() {
    const counts = Object.fromEntries(this.db.prepare('SELECT status,COUNT(*) AS count FROM inbox GROUP BY status').all().map(row => [row.status, row.count]));
    const latest = this.db.prepare('SELECT session_id FROM inbox WHERE session_id IS NOT NULL ORDER BY rowid DESC LIMIT 1').get();
    const failure = this.db.prepare("SELECT error FROM inbox WHERE error IS NOT NULL AND status IN ('failed','unknown') ORDER BY rowid DESC LIMIT 1").get();
    const pendingSends = this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status='pending'").get().count;
    return { processed: counts.completed ?? 0, pending: (counts.queued ?? 0) + (counts.running ?? 0) + (counts.produced ?? 0) + (counts.generated ?? 0),
      failed: counts.failed ?? 0, unknown: counts.unknown ?? 0, pendingSends, sessionId: latest?.session_id ?? null,
      lastError: failure?.error ?? null, counts, cursor: this.cursor() ?? null };
  }

  close() { this.db.close(); }
}
