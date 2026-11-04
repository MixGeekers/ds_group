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
        UNIQUE(source_event_id, ordinal)
      );
    `);
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

  ingest(events, cursor) {
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

  generated(eventId, response, deliveries) {
    this.transaction(() => {
      const result = this.db.prepare("UPDATE inbox SET status='generated',response_json=?,session_id=? WHERE event_id=? AND status='running'")
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
    if (!['failed', 'unknown'].includes(status)) throw new Error('Invalid failure status');
    this.db.prepare("UPDATE inbox SET status=?,error=? WHERE event_id=? AND status IN ('queued','running')")
      .run(status, String(error).slice(0, 1000), eventId);
  }

  pendingDelivery() {
    const row = this.db.prepare(`SELECT outbox.* FROM outbox JOIN messages ON messages.event_id=outbox.source_event_id
      WHERE outbox.status='pending' ORDER BY messages.sequence,outbox.ordinal LIMIT 1`).get();
    return row ? { ...row, options: JSON.parse(row.options_json) } : undefined;
  }

  sent(transactionId, sentEventId) {
    if (typeof sentEventId !== 'string' || !sentEventId) throw new Error('Missing Matrix event receipt');
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM outbox WHERE transaction_id=?').get(transactionId);
      if (!row) throw new Error('Unknown delivery transaction');
      if (row.status === 'sent' && row.sent_event_id !== sentEventId) throw new Error('Matrix receipt changed for a sent transaction');
      this.db.prepare("UPDATE outbox SET status='sent',sent_event_id=?,last_error=NULL WHERE transaction_id=?")
        .run(sentEventId, transactionId);
      const pending = this.db.prepare("SELECT 1 FROM outbox WHERE source_event_id=? AND status='pending'").get(row.source_event_id);
      if (!pending) this.db.prepare("UPDATE inbox SET status='completed' WHERE event_id=? AND status='generated'").run(row.source_event_id);
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

  snapshot() {
    const counts = Object.fromEntries(this.db.prepare('SELECT status,COUNT(*) AS count FROM inbox GROUP BY status').all().map(row => [row.status, row.count]));
    const latest = this.db.prepare('SELECT session_id FROM inbox WHERE session_id IS NOT NULL ORDER BY rowid DESC LIMIT 1').get();
    const failure = this.db.prepare('SELECT error FROM inbox WHERE error IS NOT NULL ORDER BY rowid DESC LIMIT 1').get();
    const pendingSends = this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status='pending'").get().count;
    return { processed: counts.completed ?? 0, pending: (counts.queued ?? 0) + (counts.running ?? 0) + (counts.generated ?? 0),
      failed: counts.failed ?? 0, unknown: counts.unknown ?? 0, pendingSends, sessionId: latest?.session_id ?? null,
      lastError: failure?.error ?? null, counts, cursor: this.cursor() ?? null };
  }

  close() { this.db.close(); }
}
