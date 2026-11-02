import { createHash, randomUUID } from 'node:crypto';
import { constants as C, type DatabaseSync } from 'node:sqlite';
import { SqliteTransactions } from './transaction.js';

const PREFIX = 'shiyu_commit_';
const META = `${PREFIX}watermark`;
const DIRTY = `${PREFIX}dirty`;
const OWNED = `${PREFIX}owned_guard`;
const INTERNAL = `${PREFIX}internal_guard`;
const VERSION = 1;
const META_SQL = `CREATE TABLE ${META}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,commit_seq INTEGER NOT NULL CHECK(commit_seq>=0),baseline_id TEXT NOT NULL,started_at TEXT NOT NULL,schema_hash TEXT NOT NULL)`;
const DIRTY_SQL = `CREATE TABLE ${DIRTY}(id INTEGER PRIMARY KEY CHECK(id=1))`;
const installed = new WeakSet<DatabaseSync>();
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message: string): never => { throw new Error(`Commit watermark: ${message}`); };
interface SchemaRow { type: string; name: string; tbl_name: string; sql: string | null }
interface Metadata { version: number; commit_seq: number; baseline_id: string; started_at: string; schema_hash: string }
export interface CommitWatermark {
  schemaVersion: 1;
  commitSeq: number;
  baselineId: string;
  startedAt: string;
  history: 'since-installation';
}
export interface CommitWatermarkReader { read(): CommitWatermark }

/**
 * Install once, after connection PRAGMAs and BEFORE constructing repositories.
 * Existing database contents begin at an explicit zero baseline; no historical
 * commits are guessed. Reopen installs the guard functions before old triggers
 * can execute. This owns the connection authorizer; do not replace it, expose
 * this connection to untrusted SQL, or use another transaction owner.
 *
 * All ordinary main tables are covered, including newly created tables in an
 * owned atomic(). Actual schema changes count once, and new tracking triggers
 * are installed before that outer transaction commits. Schema mutations must
 * use synchronous db.exec(): cached DDL/PRAGMA statements are not permitted,
 * because authorizer is compile-time only and SQLite may auto-ROLLBACK before
 * a cached statement is run. Ordinary prepared DML keeps its trigger guard.
 * Additional application
 * triggers, virtual/temp/attached tables and writable PRAGMAs are rejected.
 * In particular RAISE(IGNORE) in another AFTER trigger could skip tracking.
 *
 * Triggers and execution-time UDF guards also reject cached statements outside
 * atomic(), and unmanaged connections without these UDFs cannot write tracked
 * tables. This is not isolation from an administrator who can replace database
 * files or native functions. An out-of-band schema change fails closed on the
 * next read/transaction; it is not silently repaired into a false watermark.
 */
export function installCommitWatermark(db: DatabaseSync, tx: SqliteTransactions): CommitWatermarkReader {
  if (!tx.owns(db) || tx.depth || db.isTransaction || installed.has(db)) fail('requires one fresh transaction owner on the exact connection');
  tx.assertUsable();
  if (Number(db.prepare('PRAGMA trusted_schema').get()?.trusted_schema) !== 1) fail('trusted_schema=ON is required for execution-time UDF guards');
  if (db.prepare('PRAGMA database_list').all().some(row => row.name !== 'main')) fail('attached or temporary databases are not supported');
  let internal = false;
  let triggerNames = new Set<string>();
  const owned = () => { tx.assertUsable(); if (!tx.depth || !db.isTransaction) fail('writes require the owned atomic transaction'); return 1; };
  db.function(OWNED, owned);
  db.function(INTERNAL, () => { owned(); if (!internal) fail('reserved metadata cannot be modified directly'); return 1; });
  const internally = <T>(work: () => T): T => {
    const previous = internal; internal = true;
    try { return work(); } finally { internal = previous; }
  };
  const rows = (): SchemaRow[] => db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all() as unknown as SchemaRow[];
  const ordinary = (schema: SchemaRow[]) => schema.filter(row => !row.name.startsWith('sqlite_') && !row.name.startsWith(PREFIX));
  const schemaHash = (schema: SchemaRow[]) => digest([ordinary(schema), db.prepare('PRAGMA user_version').get()?.user_version]);
  const metadata = (): Metadata => {
    const values = db.prepare(`SELECT version,commit_seq,baseline_id,started_at,schema_hash FROM ${META}`).all();
    if (values.length !== 1) fail('missing or duplicate metadata; historical progress cannot be reconstructed');
    const value = values[0]! as unknown as Metadata;
    if (value.version !== VERSION || !Number.isSafeInteger(value.commit_seq) || value.commit_seq < 0
      || typeof value.baseline_id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.baseline_id)
      || typeof value.started_at !== 'string' || !Number.isFinite(Date.parse(value.started_at))
      || typeof value.schema_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.schema_hash)) fail('invalid persisted metadata');
    return value;
  };
  const isDirty = () => {
    const values = db.prepare(`SELECT id FROM ${DIRTY}`).all();
    if (values.length > 1 || values.some(row => row.id !== 1)) fail('invalid dirty marker');
    return values.length === 1;
  };
  const definitions = (schema: SchemaRow[]): Map<string, string> => {
    const result = new Map<string, string>();
    const tableList = db.prepare('PRAGMA main.table_list').all();
    for (const table of [META, DIRTY]) for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      const name = `${PREFIX}guard_${table === META ? 'meta' : 'dirty'}_${action.toLowerCase()}`;
      result.set(name, `CREATE TRIGGER ${quote(name)} BEFORE ${action} ON ${quote(table)} BEGIN SELECT ${table === META ? INTERNAL : OWNED}(); END`);
    }
    for (const row of ordinary(schema)) {
      if (row.type === 'trigger') fail('application triggers require a separately reviewed tracking policy');
      if (row.type !== 'table') continue;
      if (!row.sql || /^CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql)) fail('virtual tables are unsupported');
      const columns = db.prepare(`PRAGMA main.table_xinfo(${quote(row.name)})`).all();
      if (!columns.length) fail('could not enumerate table columns');
      const names = columns.map(column => String(column.name));
      const withoutRowid = tableList.find(table => table.name === row.name && table.schema === 'main')?.wr === 1;
      const comparisons = names.map(name => `typeof(OLD.${quote(name)}) IS NOT typeof(NEW.${quote(name)}) OR OLD.${quote(name)} COLLATE BINARY IS NOT NEW.${quote(name)} COLLATE BINARY`);
      if (!withoutRowid) {
        const alias = ['rowid', '_rowid_', 'oid'].find(name => !names.some(column => column.toLowerCase() === name));
        if (!alias) fail('table shadows every rowid alias');
        comparisons.push(`OLD.${alias} IS NOT NEW.${alias}`);
      }
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        const name = `${PREFIX}track_${digest(row.name).slice(0, 24)}_${action.toLowerCase()}`;
        const when = action === 'UPDATE' ? ` WHEN ${comparisons.map(value => `(${value})`).join(' OR ')}` : '';
        // Outer INSERT/UPDATE conflict policy can override a trigger's OR IGNORE;
        // avoid a conflict entirely instead of relying on its conflict handler.
        result.set(name, `CREATE TRIGGER ${quote(name)} AFTER ${action} ON ${quote(row.name)}${when} BEGIN SELECT ${OWNED}(); INSERT INTO ${DIRTY}(id) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM ${DIRTY}); END`);
      }
    }
    return result;
  };
  const verify = (schema: SchemaRow[], expected: Map<string, string>, allowMissing = false) => {
    for (const row of schema.filter(row => row.name.startsWith(PREFIX))) {
      if (row.type === 'table' && [META, DIRTY].includes(row.name)) {
        if (row.sql !== (row.name === META ? META_SQL : DIRTY_SQL)) fail('reserved table definition changed');
        continue;
      }
      if (row.type !== 'trigger' || !expected.has(row.name) || row.sql !== expected.get(row.name)) fail('tracking schema was modified or uses a reserved name');
    }
    if (!allowMissing) for (const [name, sql] of expected) {
      if (!schema.some(row => row.type === 'trigger' && row.name === name && row.sql === sql)) fail('tracking trigger is missing');
    }
  };
  const installMissing = (schema: SchemaRow[], expected: Map<string, string>) => internally(() => {
    verify(schema, expected, true);
    for (const [name, sql] of expected) if (!schema.some(row => row.name === name)) db.exec(sql);
    triggerNames = new Set(expected.keys());
  });

  // Bootstrap is deliberately not a historical control commit. Once this
  // atomic initialization commits, every later owned write is covered.
  tx.atomic(() => internally(() => {
    const schema = rows();
    const present = schema.some(row => row.name === META);
    if (!present) {
      if (schema.some(row => row.name.startsWith(PREFIX))) fail('partial tracking schema; refusing to reset progress');
      db.exec(`${META_SQL};${DIRTY_SQL};`);
      db.prepare(`INSERT INTO ${META} VALUES(1,?,?,?,?,?)`).run(VERSION, 0, randomUUID(), new Date().toISOString(), schemaHash(schema));
      installMissing(rows(), definitions(rows()));
    } else {
      const meta = metadata();
      const expected = definitions(schema); verify(schema, expected);
      if (meta.schema_hash !== schemaHash(schema) || isDirty()) fail('unmanaged schema change or unfinished commit marker requires reconciliation');
      triggerNames = new Set(expected.keys());
    }
  }));

  // Authorizer is preparation-time defense. Persistent UDF triggers above
  // separately enforce transaction ownership when cached statements execute.
  const schemaActions = new Set<number>([C.SQLITE_CREATE_INDEX, C.SQLITE_CREATE_TABLE, C.SQLITE_CREATE_VIEW,
    C.SQLITE_DROP_INDEX, C.SQLITE_DROP_TABLE, C.SQLITE_DROP_VIEW, C.SQLITE_ALTER_TABLE]);
  const denied = new Set<number>([C.SQLITE_ATTACH, C.SQLITE_DETACH, C.SQLITE_CREATE_VTABLE, C.SQLITE_DROP_VTABLE,
    C.SQLITE_CREATE_TEMP_INDEX, C.SQLITE_CREATE_TEMP_TABLE, C.SQLITE_CREATE_TEMP_TRIGGER, C.SQLITE_CREATE_TEMP_VIEW,
    C.SQLITE_DROP_TEMP_INDEX, C.SQLITE_DROP_TEMP_TABLE, C.SQLITE_DROP_TEMP_TRIGGER, C.SQLITE_DROP_TEMP_VIEW,
    C.SQLITE_ANALYZE]);
  let directSqlDepth = 0;
  const execute = db.exec.bind(db);
  db.exec = (sql: string): void => {
    directSqlDepth++;
    try { execute(sql); } finally { directSqlDepth--; }
  };
  db.setAuthorizer((action, arg1, arg2, database, source) => {
    if (internal) return C.SQLITE_OK;
    if (denied.has(action) || (database && database !== 'main')) return C.SQLITE_DENY;
    if (action === C.SQLITE_TRANSACTION || action === C.SQLITE_SAVEPOINT) return tx.controlsTransaction ? C.SQLITE_OK : C.SQLITE_DENY;
    // SQLite also authorizes REINDEX while creating a new ordinary index.
    if (action === C.SQLITE_REINDEX) return directSqlDepth > 0 && tx.depth > 0 && db.isTransaction ? C.SQLITE_OK : C.SQLITE_DENY;
    if (action === C.SQLITE_CREATE_TRIGGER || action === C.SQLITE_DROP_TRIGGER) return C.SQLITE_DENY;
    if (schemaActions.has(action)) {
      if (!directSqlDepth || !tx.depth || !db.isTransaction || arg1?.startsWith(PREFIX) || arg2?.startsWith(PREFIX)) return C.SQLITE_DENY;
    }
    if ([C.SQLITE_INSERT, C.SQLITE_UPDATE, C.SQLITE_DELETE].includes(action)
      && arg1?.startsWith(PREFIX)) {
      return arg1 === DIRTY && action === C.SQLITE_INSERT && source !== null && triggerNames.has(source) ? C.SQLITE_OK : C.SQLITE_DENY;
    }
    if ([C.SQLITE_INSERT, C.SQLITE_UPDATE, C.SQLITE_DELETE].includes(action)
      && arg1?.startsWith('sqlite_') && !['sqlite_master', 'sqlite_schema'].includes(arg1)) return C.SQLITE_DENY;
    if (action === C.SQLITE_PRAGMA) {
      if (arg1?.toLowerCase() === 'user_version' && arg2 !== null) return directSqlDepth > 0 && tx.depth > 0 && db.isTransaction ? C.SQLITE_OK : C.SQLITE_DENY;
      const reads = new Set(['table_xinfo', 'table_list', 'table_info', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list']);
      return arg1 !== null && (reads.has(arg1.toLowerCase()) || (arg2 === null && ['schema_version', 'user_version', 'trusted_schema', 'foreign_keys', 'journal_mode', 'synchronous', 'busy_timeout'].includes(arg1.toLowerCase()))) ? C.SQLITE_OK : C.SQLITE_DENY;
    }
    if (action === C.SQLITE_FUNCTION && arg2 === 'load_extension') return C.SQLITE_DENY;
    return C.SQLITE_OK;
  });

  tx.installHooks({
    afterBegin() {
      const schema = rows(), meta = metadata(), expected = definitions(schema); verify(schema, expected);
      if (meta.schema_hash !== schemaHash(schema) || isDirty()) fail('unmanaged schema or dirty metadata; no trustworthy commit sequence');
      triggerNames = new Set(expected.keys());
    },
    beforeCommit() {
      const schema = rows(), expected = definitions(schema), meta = metadata();
      // New tables and their first inserts are covered by the actual schema
      // change, even before their AFTER triggers are installed below.
      const changedSchema = meta.schema_hash !== schemaHash(schema);
      installMissing(schema, expected);
      if (changedSchema || isDirty()) internally(() => {
        if (meta.commit_seq >= Number.MAX_SAFE_INTEGER) fail('commit sequence exhausted');
        db.prepare(`UPDATE ${META} SET commit_seq=commit_seq+1,schema_hash=? WHERE id=1`).run(schemaHash(schema));
        db.exec(`DELETE FROM ${DIRTY}`);
      });
    },
  });
  installed.add(db);
  return Object.freeze({ read(): CommitWatermark {
    return tx.atomic(() => {
      if (isDirty()) fail('cannot publish a watermark for uncommitted writes');
      const value = metadata();
      if (value.schema_hash !== schemaHash(rows())) fail('cannot publish an uncommitted schema change');
      return { schemaVersion: 1, commitSeq: value.commit_seq, baselineId: value.baseline_id,
        startedAt: value.started_at, history: 'since-installation' };
    });
  } });
}
