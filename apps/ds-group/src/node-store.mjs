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
      CREATE TABLE IF NOT EXISTS room_invitations (
        room_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        last_error TEXT,
        attempt_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS attention_events (
        event_id TEXT PRIMARY KEY REFERENCES messages(event_id),
        thread_key TEXT NOT NULL,
        status TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        expires_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        decision_id TEXT,
        reason TEXT
      );
      CREATE TABLE IF NOT EXISTS observation_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL,
        message_sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attention_due ON attention_events(status,available_at);
      CREATE TABLE IF NOT EXISTS attention_decisions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        completed_at INTEGER,
        outcome TEXT
      );
      CREATE TABLE IF NOT EXISTS local_task_controls (
        event_id TEXT PRIMARY KEY REFERENCES inbox(event_id),
        source_event_id TEXT NOT NULL REFERENCES messages(event_id),
        reason TEXT NOT NULL
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(inbox)').all().some(column => column.name === 'attention_json')) {
      this.db.exec('ALTER TABLE inbox ADD COLUMN attention_json TEXT');
    }
    this.db.exec('INSERT OR IGNORE INTO observation_events(event_id,room_id,message_sequence,event_json) SELECT event_id,room_id,sequence,event_json FROM messages ORDER BY sequence');
    if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(column => column.name === 'routing_frozen')) {
      this.transaction(() => this.db.exec('ALTER TABLE outbox ADD COLUMN routing_frozen INTEGER NOT NULL DEFAULT 0; UPDATE outbox SET routing_frozen=1'));
    }
    if (!this.db.prepare('PRAGMA table_info(room_invitations)').all().some(column => column.name === 'attempt_order')) {
      this.db.exec('ALTER TABLE room_invitations ADD COLUMN attempt_order INTEGER NOT NULL DEFAULT 0');
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
    // Missed casual conversation must not turn into a burst of unsolicited
    // replies after restarting. Reliable inbox/work recovery remains unchanged.
    this.db.prepare("UPDATE attention_events SET status=CASE WHEN status='evaluating' THEN 'error' ELSE 'expired' END,reason='node_restarted' WHERE status IN ('queued','waiting','evaluating')").run();
    this.db.prepare("UPDATE attention_decisions SET status='error',error_code='ATTENTION_INTERRUPTED',completed_at=? WHERE status='evaluating'").run(Date.now());
    this.db.prepare("UPDATE inbox SET status='cancelled',error='Natural conversation expired while node was offline' WHERE status='queued' AND json_extract(attention_json,'$.kind')='natural'").run();
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

  roomContext(roomId) {
    const row = this.db.prepare('SELECT value FROM node_meta WHERE key=?').get(`room:${roomId}`);
    return row ? JSON.parse(row.value) : {};
  }

  noteRoomState(roomId, events) {
    const room = this.roomContext(roomId);
    const members = new Set(room.members || []);
    const parents = new Set(room.parentSpaceIds || []);
    for (const event of events) {
      if (event.type === 'm.room.name') room.name = event.content?.name || '';
      if (event.type === 'm.room.topic') room.topic = event.content?.topic || '';
      if (event.type === 'm.room.create') room.creatorId = event.sender || event.content?.creator;
      if (event.type === 'm.room.member' && event.state_key) {
        if (event.content?.membership === 'join') members.add(event.state_key);
        else members.delete(event.state_key);
      }
      if (event.type === 'm.space.parent' && event.state_key) {
        if (event.content?.via?.length) parents.add(event.state_key); else parents.delete(event.state_key);
      }
    }
    Object.assign(room, { members: [...members], parentSpaceIds: [...parents] });
    this.db.prepare('INSERT OR REPLACE INTO node_meta VALUES (?, ?)').run(`room:${roomId}`, JSON.stringify(room));
  }

  noteRoomMembership(roomId, membership) {
    const room = { ...this.roomContext(roomId), membership };
    this.db.prepare('INSERT OR REPLACE INTO node_meta VALUES (?, ?)').run(`room:${roomId}`, JSON.stringify(room));
    if (membership === 'leave') this.settleAttention('room_left', { roomId });
  }

  historyCountBefore(eventId) {
    return this.db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE room_id =
      (SELECT room_id FROM messages WHERE event_id=?) AND sequence <
      (SELECT sequence FROM messages WHERE event_id=?)`).get(eventId, eventId).count;
  }

  noteInvitation(roomId) {
    this.db.prepare('INSERT OR IGNORE INTO room_invitations(room_id,received_at) VALUES (?,?)').run(roomId, Date.now());
  }

  pendingInvitations() {
    return this.db.prepare('SELECT * FROM room_invitations ORDER BY attempt_order,received_at,room_id LIMIT 100').all();
  }

  finishInvitation(roomId) {
    this.db.prepare('DELETE FROM room_invitations WHERE room_id=?').run(roomId);
  }

  invitationFailed(roomId, error) {
    this.db.prepare('UPDATE room_invitations SET last_error=?,attempt_order=(SELECT COALESCE(MAX(attempt_order),0)+1 FROM room_invitations) WHERE room_id=?')
      .run(String(error).slice(0, 1000), roomId);
  }

  hasEvent(eventId) {
    return Boolean(this.db.prepare('SELECT 1 FROM messages WHERE event_id=?').get(eventId));
  }

  message(eventId) {
    if (typeof eventId !== 'string') return undefined;
    const row = this.db.prepare('SELECT event_json FROM messages WHERE event_id=?').get(eventId);
    return row ? JSON.parse(row.event_json) : undefined;
  }

  messageBatch(event) {
    const batchId = event.content?.['org.ds_group']?.fileBatch?.id;
    if (!batchId) return [event];
    return this.db.prepare('SELECT event_json FROM messages WHERE room_id=? AND sender_id=? AND json_extract(event_json,?)=? ORDER BY sequence')
      .all(event.room_id, event.sender, '$.content."org.ds_group".fileBatch.id', batchId).map(row => JSON.parse(row.event_json));
  }

  ingest(events, cursor, onAccepted, { route, now = Date.now() } = {}) {
    return this.transaction(() => {
      let accepted = 0;
      for (const event of events) {
        if (event.type === 'm.room.redaction' && typeof event.event_id === 'string'
          && typeof event.room_id === 'string' && typeof event.sender === 'string'
          && typeof (event.redacts || event.content?.redacts) === 'string') {
          this.db.prepare('INSERT OR IGNORE INTO observation_events(event_id,room_id,message_sequence,event_json) VALUES (?,?,?,?)')
            .run(event.event_id, event.room_id, this.messageWatermark(event.room_id).sequence, JSON.stringify(event));
          continue;
        }
        if (event.type !== 'm.room.message' || typeof event.event_id !== 'string'
          || typeof event.room_id !== 'string' || typeof event.sender !== 'string'
          || typeof event.content?.body !== 'string') continue;
        const result = this.db.prepare('INSERT OR IGNORE INTO messages(event_id,room_id,sender_id,event_json) VALUES (?,?,?,?)')
          .run(event.event_id, event.room_id, event.sender, JSON.stringify(event));
        if (!result.changes) continue;
        this.db.prepare('INSERT OR IGNORE INTO observation_events(event_id,room_id,message_sequence,event_json) VALUES (?,?,?,?)')
          .run(event.event_id, event.room_id, Number(result.lastInsertRowid), JSON.stringify(event));
        accepted++;
        const targets = event.content['org.ds_group']?.to;
        const evidence = event.sender === this.botId ? undefined : route?.(event)
          || (Array.isArray(targets) && targets.includes(this.botId) ? { kind: 'reliable', reason: 'targeted' } : undefined);
        const relation = event.content['m.relates_to'];
        const thread = relation?.rel_type === 'm.thread' && typeof relation.event_id === 'string' ? relation.event_id : '';
        // A related new event wakes WAIT; a successful LISTEN is not requeued.
        this.db.prepare("UPDATE attention_events SET available_at=?,reason='new_message' WHERE status='waiting' AND thread_key=? AND event_id IN (SELECT event_id FROM messages WHERE room_id=?)")
          .run(now, thread, event.room_id);
        this.db.prepare('INSERT INTO attention_events(event_id,thread_key,status,received_at,available_at) VALUES (?,?,?,?,?)')
          .run(event.event_id, thread, event.sender === this.botId ? 'self' : evidence ? 'routed' : 'queued', now, now);
        if (evidence) {
          this.db.prepare("INSERT INTO inbox(event_id,status,attention_json) VALUES (?, 'queued', ?)")
            .run(event.event_id, JSON.stringify(evidence));
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
      JOIN messages USING(event_id) WHERE inbox.status='queued'
      AND COALESCE(json_extract(attention_json,'$.notBefore'),0)<=?
      ORDER BY CASE WHEN json_extract(attention_json,'$.kind')='natural' THEN 1 ELSE 0 END,messages.sequence LIMIT 1`).get(Date.now());
    return row ? { ...row, event: JSON.parse(row.event_json), attention: row.attention_json ? JSON.parse(row.attention_json) : null } : undefined;
  }

  item(eventId) {
    if (typeof eventId !== 'string') return undefined;
    const row = this.db.prepare('SELECT inbox.*, messages.event_json FROM inbox JOIN messages USING(event_id) WHERE event_id=?').get(eventId);
    return row ? { ...row, event: JSON.parse(row.event_json), attention: row.attention_json ? JSON.parse(row.attention_json) : null,
      request: row.request_json ? JSON.parse(row.request_json) : null,
      response: row.response_json ? JSON.parse(row.response_json) : null } : undefined;
  }

  requestItem(requestId) {
    const row = this.db.prepare("SELECT event_id FROM inbox WHERE json_extract(request_json,'$.requestId')=?").get(requestId);
    return row ? this.item(row.event_id) : undefined;
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

  /** Local sequence is a receipt order, not a claim of complete Matrix history. */
  messageWatermark(roomId) {
    const row = roomId ? this.db.prepare('SELECT sequence,event_id,room_id FROM messages WHERE room_id=? ORDER BY sequence DESC LIMIT 1').get(roomId)
      : this.db.prepare('SELECT sequence,event_id,room_id FROM messages ORDER BY sequence DESC LIMIT 1').get();
    return row ? { sequence: row.sequence, eventId: row.event_id, roomId: row.room_id } : { sequence: 0, eventId: null, roomId: roomId || null };
  }

  messagesThrough(roomId, sequence, limit = 40) {
    return this.db.prepare('SELECT event_json FROM messages WHERE room_id=? AND sequence<=? ORDER BY sequence DESC LIMIT ?')
      .all(roomId, sequence, limit).reverse().map(row => JSON.parse(row.event_json));
  }

  messagesAfter(roomId, sequence) {
    return this.db.prepare('SELECT event_json FROM messages WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT 500')
      .all(roomId, sequence).map(row => JSON.parse(row.event_json));
  }

  observationBatch(limit = 100) {
    const after = Number(this.db.prepare("SELECT value FROM node_meta WHERE key='observationSequence'").get()?.value || 0);
    const rows = this.db.prepare('SELECT * FROM observation_events WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, limit);
    const last = rows.at(-1);
    return { after, events: rows.map(row => JSON.parse(row.event_json)), cursor: this.cursor(),
      watermark: last ? { sequence: last.sequence, eventId: last.event_id, roomId: last.room_id } : null };
  }

  withdrawnAttentionSource(evidence) {
    if (!evidence?.eventIds?.length) return false;
    const rows = this.db.prepare('SELECT event_json FROM observation_events WHERE room_id=? AND message_sequence>=?')
      .all(evidence.watermark.roomId, evidence.watermark.sequence);
    return rows.some(row => {
      const event = JSON.parse(row.event_json);
      return event.type === 'm.room.redaction' && evidence.eventIds.includes(event.redacts || event.content?.redacts);
    });
  }

  acknowledgeObservation(after, sequence) {
    if (!Number.isSafeInteger(sequence) || sequence <= after) throw new Error('Invalid observation watermark');
    const current = Number(this.db.prepare("SELECT value FROM node_meta WHERE key='observationSequence'").get()?.value || 0);
    if (current !== after) throw new Error('Observation watermark changed');
    this.db.prepare("INSERT INTO node_meta VALUES ('observationSequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(sequence));
  }

  correlatedActiveTask(event) {
    const meta = event.content?.['org.ds_group'] || {};
    const reference = meta.replyTo || event.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;
    const referenced = reference && (this.item(reference) || this.sourceForSentEvent(reference));
    const candidates = this.db.prepare(`SELECT inbox.event_id FROM inbox JOIN messages USING(event_id)
      LEFT JOIN task_updates USING(event_id) WHERE room_id=? AND sender_id=?
      AND (inbox.status IN ('queued','running','produced','generated','unknown') OR json_extract(payload_json,'$.status')='running')
      ORDER BY sequence DESC LIMIT 20`).all(event.room_id, event.sender).map(row => this.item(row.event_id)).filter(item => !this.cancelledEvent(item.event_id));
    if (referenced) return candidates.find(item => item.event_id === referenced.event_id);
    if (meta.taskId) return candidates.find(item => item.event.content?.['org.ds_group']?.taskId === meta.taskId || this.task(item.event_id)?.taskId === meta.taskId);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  requestLocalCancellation(eventId, controlEventId, reason = 'cancelled') {
    this.db.prepare('INSERT INTO local_task_controls VALUES (?,?,?) ON CONFLICT(event_id) DO UPDATE SET source_event_id=excluded.source_event_id,reason=excluded.reason')
      .run(eventId, controlEventId, reason);
  }

  localCancellation(requestId) {
    const row = this.db.prepare("SELECT local_task_controls.* FROM local_task_controls JOIN inbox USING(event_id) WHERE json_extract(request_json,'$.requestId')=?").get(requestId);
    return row ? { cancelRequested: true, reason: row.reason, sourceEventId: row.source_event_id } : undefined;
  }

  cancelledEvent(eventId) { return Boolean(this.db.prepare('SELECT 1 FROM local_task_controls WHERE event_id=?').get(eventId)); }

  activeTaskView(roomId) {
    return this.db.prepare(`SELECT inbox.event_id,inbox.status,request_json,payload_json FROM inbox JOIN messages USING(event_id)
      LEFT JOIN task_updates USING(event_id) WHERE room_id=? AND
      (inbox.status IN ('queued','running','produced','generated','unknown') OR json_extract(payload_json,'$.status')='running')
      ORDER BY sequence DESC LIMIT 20`).all(roomId).map(row => {
      const task = row.payload_json ? JSON.parse(row.payload_json) : {};
      const request = row.request_json ? JSON.parse(row.request_json) : {};
      return { eventId: row.event_id, requestId: request.requestId || task.requestId || null,
        status: task.status || row.status, stage: task.stage || null, summary: task.summary || '', cancelled: this.cancelledEvent(row.event_id) };
    });
  }

  nextAttentionBatch({ now = Date.now(), batchMs = 350, maxAgeMs = 30_000, limit = 40 } = {}) {
    this.db.prepare(`UPDATE attention_events SET status='expired',reason='expired' WHERE status IN ('queued','waiting') AND
      (COALESCE(expires_at,received_at+?)<=? OR event_id IN (SELECT event_id FROM messages WHERE
        json_type(event_json,'$.origin_server_ts') IN ('integer','real') AND json_extract(event_json,'$.origin_server_ts')<?))`)
      .run(maxAgeMs, now, now - maxAgeMs);
    const first = this.db.prepare(`SELECT attention_events.*,messages.room_id FROM attention_events JOIN messages USING(event_id)
      WHERE (status='queued' AND available_at<=?) OR (status='waiting' AND available_at<=?) ORDER BY sequence LIMIT 1`).get(now - batchMs, now);
    if (!first) return undefined;
    const rows = this.db.prepare(`SELECT attention_events.*,messages.event_json FROM attention_events JOIN messages USING(event_id)
      WHERE room_id=? AND thread_key=? AND status IN ('queued','waiting') AND available_at<=? ORDER BY sequence DESC LIMIT ?`)
      .all(first.room_id, first.thread_key, now, limit).reverse();
    if (rows.length === limit) {
      this.db.prepare(`UPDATE attention_events SET status='observed',reason='superseded_by_recent_batch'
        WHERE thread_key=? AND status IN ('queued','waiting') AND event_id IN (SELECT event_id FROM messages WHERE room_id=? AND sequence<
          (SELECT sequence FROM messages WHERE event_id=?))`).run(first.thread_key, first.room_id, rows[0].event_id);
    }
    return { roomId: first.room_id, threadRootId: first.thread_key || null, eventIds: rows.map(row => row.event_id),
      events: rows.map(row => JSON.parse(row.event_json)), watermark: this.messageWatermark(first.room_id),
      reason: rows.find(row => row.status === 'waiting')?.reason || 'room_messages',
      expiresAt: Math.min(...rows.map(row => row.expires_at ?? row.received_at + maxAgeMs)) };
  }

  beginAttentionDecision(id, batch, input, now = Date.now()) {
    this.transaction(() => {
      for (const eventId of batch.eventIds) {
        const result = this.db.prepare("UPDATE attention_events SET status='evaluating',decision_id=?,attempts=attempts+1,expires_at=COALESCE(expires_at,?) WHERE event_id=? AND status IN ('queued','waiting')")
          .run(id, batch.expiresAt, eventId);
        if (!result.changes) throw new Error('Attention batch is no longer pending');
      }
      this.db.prepare("INSERT INTO attention_decisions(id,status,created_at,input_json) VALUES (?,'evaluating',?,?)").run(id, now, JSON.stringify(input));
    });
  }

  finishAttentionDecision(id, result, { now = Date.now(), outcome, waitMs = 4000, waitTtlMs = 30_000, evidence } = {}) {
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM attention_decisions WHERE id=? AND status='evaluating'").get(id);
      if (!row) throw new Error('Attention decision is not evaluating');
      const input = JSON.parse(row.input_json);
      this.db.prepare("UPDATE attention_decisions SET status='decided',result_json=?,completed_at=?,outcome=? WHERE id=?")
        .run(JSON.stringify(result), now, outcome || result.action.toLowerCase(), id);
      const state = evidence ? 'speaking' : result.action === 'WAIT' && !outcome ? 'waiting' : result.action === 'LISTEN' && !outcome ? 'listened' : 'observed';
      this.db.prepare('UPDATE attention_events SET status=?,available_at=?,expires_at=MIN(expires_at,?),reason=? WHERE decision_id=? AND status=\'evaluating\'')
        .run(state, now + waitMs, now + waitTtlMs, result.action === 'WAIT' ? 'wait_timer' : outcome || result.action, id);
      if (evidence) {
        const eventId = input.currentMessages.at(-1).eventId;
        this.db.prepare("INSERT OR IGNORE INTO inbox(event_id,status,attention_json) VALUES (?,'queued',?)")
          .run(eventId, JSON.stringify(evidence));
      }
    });
  }

  failAttentionDecision(id, code, now = Date.now()) {
    this.transaction(() => {
      this.db.prepare("UPDATE attention_decisions SET status='error',error_code=?,completed_at=? WHERE id=? AND status='evaluating'").run(code, now, id);
      this.db.prepare("UPDATE attention_events SET status='error',reason=? WHERE decision_id=? AND status='evaluating'").run(code, id);
    });
  }

  attentionDecision(id) {
    const row = this.db.prepare('SELECT * FROM attention_decisions WHERE id=?').get(id);
    return row ? { ...row, input: JSON.parse(row.input_json), result: row.result_json ? JSON.parse(row.result_json) : null } : undefined;
  }

  settleAttention(outcome, { roomId, threadRootId } = {}) {
    const conditions = ["status IN ('queued','waiting')"];
    const args = [outcome];
    if (roomId) { conditions.push('event_id IN (SELECT event_id FROM messages WHERE room_id=?)'); args.push(roomId); }
    if (threadRootId !== undefined) { conditions.push('thread_key=?'); args.push(threadRootId || ''); }
    return this.db.prepare(`UPDATE attention_events SET status='observed',reason=? WHERE ${conditions.join(' AND ')}`).run(...args).changes;
  }

  wakeAttention(reason, { roomId, threadRootId } = {}, now = Date.now()) {
    const conditions = ["status='waiting'", 'expires_at>?'];
    const args = [now, String(reason).slice(0, 100), now];
    if (roomId) { conditions.push('event_id IN (SELECT event_id FROM messages WHERE room_id=?)'); args.push(roomId); }
    if (threadRootId !== undefined) { conditions.push('thread_key=?'); args.push(threadRootId || ''); }
    return this.db.prepare(`UPDATE attention_events SET available_at=?,reason=? WHERE ${conditions.join(' AND ')}`).run(...args).changes;
  }

  updateAttentionEvidence(eventId, changes) {
    const current = this.item(eventId)?.attention;
    if (!current) return;
    this.db.prepare('UPDATE inbox SET attention_json=? WHERE event_id=?').run(JSON.stringify({ ...current, ...changes }), eventId);
  }

  attentionOutcome(eventId, outcome) {
    const evidence = this.item(eventId)?.attention;
    if (evidence?.kind !== 'natural') return;
    this.db.prepare('UPDATE attention_decisions SET outcome=? WHERE id=?').run(outcome, evidence.decisionId);
    this.db.prepare('UPDATE attention_events SET status=?,reason=? WHERE decision_id=?').run(outcome === 'delivered' ? 'spoken' : 'suppressed', outcome, evidence.decisionId);
  }

  attentionSnapshot() {
    const counts = Object.fromEntries(this.db.prepare('SELECT status,COUNT(*) AS count FROM attention_events GROUP BY status').all().map(row => [row.status, row.count]));
    const last = this.db.prepare('SELECT * FROM attention_decisions ORDER BY created_at DESC,rowid DESC LIMIT 1').get();
    const input = last ? JSON.parse(last.input_json) : null;
    const result = last?.result_json ? JSON.parse(last.result_json) : null;
    const lastError = this.db.prepare("SELECT error_code,completed_at FROM attention_decisions WHERE status='error' ORDER BY rowid DESC LIMIT 1").get();
    return { queue: { pending: counts.queued || 0, waiting: counts.waiting || 0, evaluating: counts.evaluating || 0, errors: counts.error || 0 },
      watermark: this.messageWatermark(), observationSequence: Number(this.db.prepare("SELECT value FROM node_meta WHERE key='observationSequence'").get()?.value || 0),
      lastDecision: last ? { id: last.id, action: result?.action || null, status: last.status, outcome: last.outcome,
        at: last.completed_at || last.created_at, eventIds: input.eventIds, watermark: input.watermark,
        latencyMs: last.completed_at ? last.completed_at - last.created_at : null } : null,
      lastError: lastError ? { code: lastError.error_code, at: lastError.completed_at } : null };
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
