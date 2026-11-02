/**
 * SQLite adapter for the Repositories contract and ordering semantics in
 * deepseek-ai/dsh-superagent-prototype src/core/{ports,memory}.ts,
 * commit 6337fc823ce20251c8de8085948165c81aaa701e.
 * Local changes: namespaced/versioned SQLite schema, immutable trigger hashes,
 * trigger-thread index, and TaskRecord metadata using the same transaction owner.
 * No application settings, destructive migration or model executor is imported.
 *
 * MIT License — Copyright (c) 2026 DeepSeek Harness Team
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { threadKey } from '../../control/tasks/upstream/model.js';
import type { Decision, Thread, Ticket, Trigger, TriggerDisposition } from '../../control/tasks/upstream/model.js';
import type { Repositories } from '../../control/tasks/upstream/ports.js';
import type { TaskRecord, TaskRecordStore } from '../../control/tasks/types.js';
import { SqliteTransactions } from './transaction.js';

export const TASK_REPOSITORY_SCHEMA_VERSION = 1;
const SCHEMA_OWNER = 'task-repositories';
type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;
type Row = Record<string, unknown>;

export class TriggerPayloadConflict extends Error {
  readonly code = 'TRIGGER_PAYLOAD_CONFLICT';
  constructor(readonly triggerId: string) { super(`Trigger ${triggerId} already identifies a different original input`); }
}

/** JSON metadata cannot silently turn NaN into null, or discard executable values. */
function json(value: unknown, ancestors = new Set<object>(), depth = 0): string {
  if (depth > 128) throw new TypeError('Task repository JSON nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || value === null) throw new TypeError('Task repositories accept finite JSON values only');
  if (ancestors.has(value)) throw new TypeError('Task repository JSON must not contain cycles');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError('Task repository metadata must use plain JSON objects');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${Array.from(value, item => json(item, ancestors, depth + 1)).join(',')}]`;
    const object = value as Record<string, unknown>;
    // Optional domain fields may be present as undefined; omit them as JSON.stringify does.
    return `{${Object.keys(object).filter(key => object[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${json(object[key], ancestors, depth + 1)}`).join(',')}}`;
  } finally { ancestors.delete(value); }
}

function identity(value: string, field: string): void {
  if (typeof value !== 'string' || !value) throw new TypeError(`${field} must be a nonempty string`);
}

/**
 * Construct in the control DB WorkerThread in production. This class owns no
 * connection or worker lifecycle. Engine, records and durable effects must share
 * this instance's transactions; wrapping the same DB in another owner is unsafe.
 */
export class SQLiteTaskRepositories implements Repositories {
  constructor(private readonly db: DatabaseSync, readonly transactions = new SqliteTransactions(db)) {
    if (!transactions.owns(db)) throw new Error('Task repositories and transactions must use the same SQLite connection');
    this.initialize();
  }

  /** The upstream port is unconstrained; the shared owner still rejects async callbacks at runtime. */
  atomic<T>(work: () => T): T {
    return this.transactions.atomic<T>(work as () => T & Synchronous<T>);
  }

  private one(sql: string, ...args: SQLInputValue[]): Row | undefined {
    this.transactions.assertUsable();
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    this.transactions.assertUsable();
    return (this.db.prepare(sql).all(...args) as Row[]).map(row => JSON.parse(String(row.value)) as T);
  }
  private get<T>(table: string, key: string): T | undefined {
    identity(key, 'repository key');
    const row = this.one(`SELECT value FROM ${table} WHERE id = ?`, key);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  private save(table: string, key: string, value: unknown): void {
    identity(key, 'repository key');
    const serialized = json(value);
    this.atomic(() => {
      this.db.prepare(`INSERT INTO ${table}(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(key, serialized);
    });
  }

  readonly triggers = {
    get: (id: string): Trigger | undefined => this.get('shiyu_task_trigger', id),
    save: (trigger: Trigger): void => {
      identity(trigger.id, 'trigger.id');
      const value = json(trigger);
      const payloadHash = createHash('sha256').update(value).digest('hex');
      this.atomic(() => {
        const previous = this.one('SELECT payload_hash FROM shiyu_task_trigger WHERE id=?', trigger.id);
        if (previous) {
          if (previous.payload_hash !== payloadHash) throw new TriggerPayloadConflict(trigger.id);
          return;
        }
        this.db.prepare('INSERT INTO shiyu_task_trigger(id,value,payload_hash) VALUES(?,?,?)').run(trigger.id, value, payloadHash);
        const link = this.db.prepare('INSERT OR IGNORE INTO shiyu_task_trigger_thread(trigger_id,thread_key,at,human) VALUES(?,?,?,?)');
        for (const ref of trigger.threads) link.run(trigger.id, threadKey(ref), trigger.at, trigger.human ? 1 : 0);
      });
    },
    disposition: (id: string): TriggerDisposition | undefined => this.get('shiyu_task_disposition', id),
    saveDisposition: (id: string, value: TriggerDisposition): void => this.save('shiyu_task_disposition', id, value),
  };

  readonly threads = {
    get: (key: string): Thread | undefined => this.get('shiyu_task_thread', key),
    save: (thread: Thread): void => this.save('shiyu_task_thread', thread.key, thread),
    // Map insertion order in upstream MemoryRepositories, preserved on update.
    list: (): Thread[] => this.all('SELECT value FROM shiyu_task_thread ORDER BY sequence'),
    active: (): Thread[] => this.all('SELECT value FROM shiyu_task_thread WHERE active=1 ORDER BY sequence'),
  };

  readonly tickets = {
    get: (id: string): Ticket | undefined => this.get('shiyu_task_ticket', id),
    save: (ticket: Ticket): void => this.save('shiyu_task_ticket', ticket.id, ticket),
    // Newest insertion first, not updatedAt/createdAt order; updates keep their position.
    list: (): Ticket[] => this.all('SELECT value FROM shiyu_task_ticket ORDER BY sequence DESC'),
    open: (): Ticket[] => this.all('SELECT value FROM shiyu_task_ticket WHERE open=1 ORDER BY sequence DESC'),
    active: (): Ticket[] => this.all('SELECT value FROM shiyu_task_ticket WHERE active=1 ORDER BY sequence DESC'),
  };

  readonly decisions = {
    get: (id: string): Decision | undefined => this.get('shiyu_task_decision', id),
    save: (decision: Decision): void => this.save('shiyu_task_decision', decision.id, decision),
    byThread: (key: string): Decision[] => {
      identity(key, 'thread key');
      return this.all('SELECT value FROM shiyu_task_decision WHERE thread_key=? ORDER BY sequence', key);
    },
  };

  readonly records: TaskRecordStore = {
    get: (taskId: string): TaskRecord | undefined => this.get('shiyu_task_record', taskId),
    save: (record: TaskRecord): void => this.save('shiyu_task_record', record.taskId, record),
    list: (): TaskRecord[] => this.all('SELECT value FROM shiyu_task_record ORDER BY sequence DESC'),
  };

  private initialize(): void {
    this.atomic(() => {
      this.db.exec('CREATE TABLE IF NOT EXISTS shiyu_component_schema(owner TEXT PRIMARY KEY,version INTEGER NOT NULL)');
      const existing = this.one('SELECT version FROM shiyu_component_schema WHERE owner=?', SCHEMA_OWNER);
      if (existing && existing.version !== TASK_REPOSITORY_SCHEMA_VERSION) {
        throw new Error(`Unsupported task repository schema version ${String(existing.version)}; explicit migration is required`);
      }
      // This component does not own PRAGMA user_version, the event schema, or any other component's tables.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS shiyu_task_trigger(
          id TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value)), payload_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS shiyu_task_disposition(
          id TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value))
        );
        CREATE TABLE IF NOT EXISTS shiyu_task_trigger_thread(
          trigger_id TEXT NOT NULL REFERENCES shiyu_task_trigger(id), thread_key TEXT NOT NULL,
          at TEXT NOT NULL, human INTEGER NOT NULL CHECK(human IN (0,1)), PRIMARY KEY(trigger_id,thread_key)
        );
        CREATE INDEX IF NOT EXISTS shiyu_task_trigger_thread_timeline ON shiyu_task_trigger_thread(thread_key,at,trigger_id);
        CREATE TABLE IF NOT EXISTS shiyu_task_thread(
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, value TEXT NOT NULL CHECK(json_valid(value)),
          active INTEGER GENERATED ALWAYS AS (CASE WHEN json_array_length(value,'$.pending')>0 OR json_type(value,'$.evaluating') IS NOT NULL THEN 1 ELSE 0 END) VIRTUAL
        );
        CREATE INDEX IF NOT EXISTS shiyu_task_thread_active ON shiyu_task_thread(sequence) WHERE active=1;
        CREATE TABLE IF NOT EXISTS shiyu_task_ticket(
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, value TEXT NOT NULL CHECK(json_valid(value)),
          open INTEGER GENERATED ALWAYS AS (CASE WHEN json_extract(value,'$.ended') IS NULL THEN 1 ELSE 0 END) VIRTUAL,
          active INTEGER GENERATED ALWAYS AS (CASE WHEN json_array_length(value,'$.undelivered')>0 OR json_extract(value,'$.assignments[#-1].state') IN ('pending','running') THEN 1 ELSE 0 END) VIRTUAL
        );
        CREATE INDEX IF NOT EXISTS shiyu_task_ticket_open ON shiyu_task_ticket(sequence) WHERE open=1;
        CREATE INDEX IF NOT EXISTS shiyu_task_ticket_active ON shiyu_task_ticket(sequence) WHERE active=1;
        CREATE TABLE IF NOT EXISTS shiyu_task_decision(
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, value TEXT NOT NULL CHECK(json_valid(value)),
          thread_key TEXT GENERATED ALWAYS AS (json_extract(value,'$.threadKey')) VIRTUAL
        );
        CREATE INDEX IF NOT EXISTS shiyu_task_decision_thread ON shiyu_task_decision(thread_key,sequence);
        CREATE TABLE IF NOT EXISTS shiyu_task_record(
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, value TEXT NOT NULL CHECK(json_valid(value))
        );
      `);
      this.db.prepare('INSERT OR IGNORE INTO shiyu_component_schema(owner,version) VALUES(?,?)').run(SCHEMA_OWNER, TASK_REPOSITORY_SCHEMA_VERSION);
    });
  }
}
