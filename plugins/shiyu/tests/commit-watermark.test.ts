import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { SqliteTransactions, TransactionFailure, TransactionPoisonedError } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';

function fixture(t: TestContext, historical = false) {
  const directory = mkdtempSync(path.join(tmpdir(), 'shiyu-commit-watermark-'));
  const filename = path.join(directory, 'control.sqlite');
  const connections: DatabaseSync[] = [];
  const connect = () => { const db = new DatabaseSync(filename); db.exec('PRAGMA busy_timeout=10000;PRAGMA synchronous=FULL'); connections.push(db); return db; };
  const db = connect();
  db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY, value TEXT COLLATE NOCASE);CREATE TABLE other(id INTEGER PRIMARY KEY)');
  if (historical) db.exec("INSERT INTO item VALUES(90,'historical-before-tracking')");
  t.after(() => { for (const connection of connections) if (connection.isOpen) connection.close(); rmSync(directory, { recursive: true, force: true }); });
  const tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx);
  const insert = (id: number) => db.prepare('INSERT INTO item VALUES(?,?)').run(id, `value-${id}`);
  return { db, tx, watermark, insert, filename, connect };
}

test('one successful outer commit includes all nested tables and notifications observe the committed sequence', t => {
  const f = fixture(t); assert.equal(f.watermark.read().commitSeq, 0);
  let observed = -1;
  f.tx.atomic(() => {
    f.insert(1); f.tx.atomic(() => { f.insert(2); f.db.exec('INSERT INTO other VALUES(1)'); });
    f.tx.afterCommit(() => { observed = f.watermark.read().commitSeq; });
  });
  assert.equal(observed, 1); assert.equal(f.watermark.read().commitSeq, 1);
});

test('reads, no-row writes, ignored conflicts and same-value updates do not advance the watermark', t => {
  const f = fixture(t); f.tx.atomic(() => f.insert(1));
  for (let i = 0; i < 3; i++) {
    f.tx.atomic(() => {
      f.db.exec('UPDATE item SET value=value;DELETE FROM item WHERE id=999;INSERT OR IGNORE INTO item VALUES(1,\'ignored\')');
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM item').get()?.n, 1);
      assert.equal(f.watermark.read().commitSeq, 1);
    });
    assert.equal(f.watermark.read().commitSeq, 1);
  }
});

test('byte changes under NOCASE and hidden rowid changes are effective writes', t => {
  const f = fixture(t); f.tx.atomic(() => f.db.exec("INSERT INTO item VALUES(1,'A')"));
  f.tx.atomic(() => f.db.exec("UPDATE item SET value='a'")); assert.equal(f.watermark.read().commitSeq, 2);
  f.tx.atomic(() => f.db.exec('UPDATE item SET rowid=2')); assert.equal(f.watermark.read().commitSeq, 3);
});

test('rollback including inner-only writes does not leak dirty state or afterCommit notifications', t => {
  const f = fixture(t); let notified = false;
  f.tx.atomic(() => {
    assert.throws(() => f.tx.atomic(() => { f.insert(1); f.tx.afterCommit(() => { notified = true; }); throw new Error('inner'); }), /inner/);
  });
  assert.equal(f.watermark.read().commitSeq, 0); assert.equal(notified, false);
  assert.throws(() => f.tx.atomic(() => { f.insert(2); f.tx.atomic(() => f.insert(3)); throw new Error('outer'); }), /outer/);
  assert.equal(f.watermark.read().commitSeq, 0);
  assert.deepEqual(f.db.prepare('SELECT * FROM item').all(), []);
});

test('caught ABORT statements roll back their marker; OR FAIL surviving rows still count once', t => {
  const f = fixture(t);
  f.tx.atomic(() => { assert.throws(() => f.db.exec("INSERT INTO item VALUES(1,'a'),(1,'b')")); });
  assert.equal(f.watermark.read().commitSeq, 0);
  f.tx.atomic(() => { assert.throws(() => f.db.exec("INSERT OR FAIL INTO item VALUES(1,'a'),(1,'b')")); });
  assert.equal(f.watermark.read().commitSeq, 1); assert.equal(f.db.prepare('SELECT count(*) AS n FROM item').get()?.n, 1);
});

test('outer conflict policies cannot override dirty insertion and cause duplicate-marker failures', t => {
  const f = fixture(t);
  f.tx.atomic(() => {
    f.insert(1); f.db.exec("INSERT OR REPLACE INTO item VALUES(1,'b');INSERT INTO item VALUES(2,'c') ON CONFLICT(id) DO UPDATE SET value=excluded.value");
  });
  assert.equal(f.watermark.read().commitSeq, 1);
});

test('effective writes restored to their original values still represent one write commit', t => {
  const f = fixture(t);
  f.tx.atomic(() => { f.insert(1); f.db.exec('DELETE FROM item'); });
  assert.equal(f.watermark.read().commitSeq, 1); assert.deepEqual(f.db.prepare('SELECT * FROM item').all(), []);
});

test('new table and first writes in the same transaction are covered; schema rollback and no-op DDL are not counted', t => {
  const f = fixture(t);
  f.tx.atomic(() => f.db.exec('CREATE TABLE fresh(id INTEGER PRIMARY KEY);CREATE INDEX fresh_idx ON fresh(id);INSERT INTO fresh VALUES(1);PRAGMA user_version=1'));
  assert.equal(f.watermark.read().commitSeq, 1);
  f.tx.atomic(() => f.db.exec('CREATE TABLE IF NOT EXISTS fresh(id INTEGER PRIMARY KEY);PRAGMA user_version=1'));
  assert.equal(f.watermark.read().commitSeq, 1);
  f.tx.atomic(() => f.db.exec('INSERT INTO fresh VALUES(2)')); assert.equal(f.watermark.read().commitSeq, 2);
  assert.throws(() => f.tx.atomic(() => { f.db.exec('CREATE TABLE rolled_back(id INTEGER);INSERT INTO rolled_back VALUES(1)'); throw new Error('stop'); }), /stop/);
  assert.equal(f.watermark.read().commitSeq, 2);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_schema WHERE name='rolled_back'").get(), undefined);
});

test('precompiled statements and unmanaged connections cannot perform uncounted writes', t => {
  const f = fixture(t), statement = f.db.prepare("INSERT INTO item VALUES(1,'x')");
  assert.throws(() => statement.run(), /owned atomic/);
  f.tx.atomic(() => statement.run()); assert.equal(f.watermark.read().commitSeq, 1);
  const other = f.connect();
  assert.throws(() => other.exec("INSERT INTO item VALUES(2,'y')"), /no such function/);
  assert.throws(() => f.db.exec('BEGIN'), /not authorized/);
  assert.throws(() => f.tx.atomic(() => f.db.exec('UPDATE shiyu_commit_watermark SET commit_seq=999')), /not authorized/);
  assert.throws(() => f.tx.atomic(() => f.db.exec('DELETE FROM shiyu_commit_dirty')), /not authorized/);
  assert.equal(f.watermark.read().commitSeq, 1);
});

test('extra triggers, writable pragmas and temporary/virtual tables are rejected', t => {
  const f = fixture(t);
  for (const sql of [
    'CREATE TRIGGER swallow AFTER INSERT ON item BEGIN SELECT RAISE(IGNORE); END',
    'CREATE TEMP TABLE temp_item(id INTEGER)', 'CREATE VIRTUAL TABLE search USING fts5(text)',
    'PRAGMA writable_schema=ON', 'PRAGMA trusted_schema=OFF',
  ]) assert.throws(() => f.tx.atomic(() => f.db.exec(sql)), /not authorized/);
  assert.equal(f.watermark.read().commitSeq, 0);
});

test('out-of-band schema edits quarantine before publishing another sequence', t => {
  const f = fixture(t), other = f.connect(); other.exec('CREATE TABLE bypass(id INTEGER);INSERT INTO bypass VALUES(1)');
  assert.throws(() => f.watermark.read(), TransactionFailure);
  assert.equal(f.tx.poisoned, true); assert.throws(() => f.tx.atomic(() => f.insert(1)), TransactionPoisonedError);
});

test('caught SQLite automatic ROLLBACK cannot escape into autocommitted DDL, index maintenance or schema-version writes', t => {
  const f = fixture(t);
  f.tx.atomic(() => { f.insert(1); f.db.exec('CREATE INDEX item_value ON item(value);CREATE TABLE numbers(id INTEGER PRIMARY KEY AUTOINCREMENT);INSERT INTO numbers DEFAULT VALUES'); });
  assert.equal(f.watermark.read().commitSeq, 1);
  assert.throws(() => f.tx.atomic(() => {
    assert.throws(() => f.db.exec("INSERT OR ROLLBACK INTO item VALUES(1,'duplicate')"), /UNIQUE/);
    assert.equal(f.db.isTransaction, false); assert.equal(f.tx.depth, 1);
    // The JS frame survives the caught exception; SQLite's real transaction does not.
    assert.throws(() => f.db.exec('CREATE TABLE escaped(id INTEGER);INSERT INTO escaped VALUES(9)'), /not authorized/);
    assert.throws(() => f.db.exec('PRAGMA user_version=7'), /not authorized/);
    assert.throws(() => f.db.exec('REINDEX item_value'), /not authorized/);
    assert.throws(() => f.db.exec("UPDATE sqlite_sequence SET seq=999 WHERE name='numbers'"), /not authorized/);
    assert.throws(() => f.db.exec("DELETE FROM sqlite_sequence WHERE name='numbers'"), /not authorized/);
  }), (error: unknown) => error instanceof TransactionFailure && error.outcome === 'unknown' && error.poisoned);
  assert.equal(f.tx.poisoned, true);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_schema WHERE name='escaped'").get(), undefined);
  assert.equal(f.db.prepare('PRAGMA user_version').get()?.user_version, 0);
  assert.equal(f.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='numbers'").get()?.seq, 1);
  assert.deepEqual(f.db.prepare('SELECT id FROM item').all().map(row => row.id), [1]);
  f.db.close(); const reopened = f.connect(), tx = new SqliteTransactions(reopened), watermark = installCommitWatermark(reopened, tx);
  assert.equal(watermark.read().commitSeq, 1);
  assert.equal(reopened.prepare("SELECT name FROM sqlite_schema WHERE name='escaped'").get(), undefined);
  tx.atomic(() => reopened.exec("INSERT INTO item VALUES(2,'after-reconciliation')"));
  assert.equal(watermark.read().commitSeq, 2);
});

test('schema-mutating statements cannot be cached even while an owned transaction is active', t => {
  for (const sql of ['CREATE TABLE escaped(id INTEGER)', 'PRAGMA user_version=2', 'REINDEX item_value']) {
    const f = fixture(t);
    f.tx.atomic(() => { f.insert(1); f.db.exec('CREATE INDEX item_value ON item(value)'); });
    assert.throws(() => f.tx.atomic(() => {
      assert.throws(() => f.db.prepare(sql), /not authorized/);
      assert.throws(() => f.db.exec("INSERT OR ROLLBACK INTO item VALUES(1,'duplicate')"), /UNIQUE/);
      assert.equal(f.db.isTransaction, false);
    }), (error: unknown) => error instanceof TransactionFailure && error.outcome === 'unknown');
    assert.equal(f.db.prepare("SELECT name FROM sqlite_schema WHERE name='escaped'").get(), undefined);
    assert.equal(f.db.prepare('PRAGMA user_version').get()?.user_version, 0);
    f.db.close(); const reopened = f.connect(), tx = new SqliteTransactions(reopened);
    assert.equal(installCommitWatermark(reopened, tx).read().commitSeq, 1);
  }
});

test('schema statements cached before watermark installation cannot escape after an automatic rollback', t => {
  for (const sql of ['CREATE TABLE escaped(id INTEGER)', 'PRAGMA user_version=2']) {
    const directory = mkdtempSync(path.join(tmpdir(), 'shiyu-old-statement-')), filename = path.join(directory, 'control.sqlite');
    const db = new DatabaseSync(filename);
    t.after(() => { if (db.isOpen) db.close(); rmSync(directory, { recursive: true, force: true }); });
    db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY);INSERT INTO item VALUES(1)');
    const cached = db.prepare(sql), tx = new SqliteTransactions(db);
    installCommitWatermark(db, tx);
    assert.throws(() => tx.atomic(() => {
      assert.throws(() => db.exec('INSERT OR ROLLBACK INTO item VALUES(1)'), /UNIQUE/);
      assert.equal(db.isTransaction, false);
      assert.throws(() => cached.run(), /not authorized/);
    }), (error: unknown) => error instanceof TransactionFailure && error.outcome === 'unknown');
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='escaped'").get(), undefined);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 0);
  }
});

test('uncommitted data never gets presented as a committed watermark', t => {
  const f = fixture(t);
  f.tx.atomic(() => { f.insert(1); assert.throws(() => f.watermark.read(), /uncommitted/); });
  assert.equal(f.watermark.read().commitSeq, 1);
});

test('historical data receives a truthful zero baseline and managed reopen retains identity and progress', t => {
  const f = fixture(t, true); assert.equal(f.watermark.read().commitSeq, 0);
  assert.equal(f.db.prepare('SELECT value FROM item WHERE id=90').get()?.value, 'historical-before-tracking');
  f.tx.atomic(() => f.insert(1));
  const before = f.watermark.read(); f.db.close();
  const db = f.connect(), tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx);
  assert.deepEqual(watermark.read(), before);
  assert.equal(before.history, 'since-installation');
  tx.atomic(() => db.exec("INSERT INTO item VALUES(2,'reopened')")); assert.equal(watermark.read().commitSeq, 2);
});

test('another managed connection learns committed new-table tracking before its next write', t => {
  const f = fixture(t), db = f.connect(), tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx);
  f.tx.atomic(() => f.db.exec('CREATE TABLE later(id INTEGER PRIMARY KEY);INSERT INTO later VALUES(1)'));
  tx.atomic(() => db.exec('INSERT INTO later VALUES(2)'));
  assert.equal(watermark.read().commitSeq, 2); assert.equal(f.watermark.read().commitSeq, 2);
});

for (const damage of ['missing-row', 'leftover-dirty'] as const) test(`persisted ${damage} fails closed instead of resetting or inventing commits`, t => {
  const f = fixture(t), raw = f.connect(); f.tx.atomic(() => f.insert(1));
  // Deliberate administrator-level corruption, not an ordinary unmanaged write.
  raw.function('shiyu_commit_internal_guard', () => 1); raw.function('shiyu_commit_owned_guard', () => 1);
  raw.exec(damage === 'missing-row' ? 'DELETE FROM shiyu_commit_watermark' : 'INSERT INTO shiyu_commit_dirty VALUES(1)');
  assert.throws(() => f.watermark.read(), TransactionFailure); assert.equal(f.tx.poisoned, true);
  const reopen = f.connect(); assert.throws(() => installCommitWatermark(reopen, new SqliteTransactions(reopen)), /Commit watermark:/);
});

for (const after of [false, true]) test(`COMMIT failure ${after ? 'after actual commit is unknown' : 'before commit rolls back'} without losing quarantine`, t => {
  const f = fixture(t), exec = f.db.exec.bind(f.db); let fault = true;
  f.db.exec = sql => { if (sql === 'COMMIT' && fault) { fault = false; if (after) exec(sql); throw new Error('synthetic COMMIT fault'); } exec(sql); };
  assert.throws(() => f.tx.atomic(() => f.insert(1)), (error: unknown) => error instanceof TransactionFailure && error.outcome === (after ? 'unknown' : 'rolled_back'));
  assert.equal(f.tx.poisoned, true); assert.throws(() => f.watermark.read(), TransactionPoisonedError);
  f.db.close(); const reopened = f.connect(), tx = new SqliteTransactions(reopened), watermark = installCommitWatermark(reopened, tx);
  assert.equal(watermark.read().commitSeq, after ? 1 : 0);
  assert.equal(reopened.prepare('SELECT count(*) AS n FROM item').get()?.n, after ? 1 : 0);
});

test('afterCommit wake-up failures do not undo a committed watermark', t => {
  const f = fixture(t);
  f.tx.atomic(() => { f.insert(1); f.tx.afterCommit(() => { throw new Error('synthetic notification'); }); });
  assert.equal(f.watermark.read().commitSeq, 1); assert.equal(f.tx.lastNotificationFailure?.committed, true);
});

test('five independently managed SQLite connections commit fifty strictly ordered writes', async t => {
  const f = fixture(t);
  const source = `const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{const {register}=await import('tsx/esm/api');const unregister=register();
    const {DatabaseSync}=require('node:sqlite');const {SqliteTransactions}=await import(workerData.tx);
    const {installCommitWatermark}=await import(workerData.wm);const db=new DatabaseSync(workerData.filename);db.exec('PRAGMA busy_timeout=10000');
    const tx=new SqliteTransactions(db),watermark=installCommitWatermark(db,tx);
    parentPort.on('message',async()=>{const sequences=[];try{for(let i=0;i<10;i++)sequences.push(tx.atomic(()=>{const next=watermark.read().commitSeq+1;db.prepare('INSERT INTO item VALUES(?,?)').run(next,String(next));return next;}));parentPort.postMessage({sequences});}
      catch(error){parentPort.postMessage({error:String(error)});}finally{db.close();await unregister();parentPort.close();}});parentPort.postMessage({ready:true});
    })().catch(error=>{parentPort.postMessage({error:String(error)});process.exitCode=1;});`;
  const pool = Array.from({ length: 5 }, () => new Worker(source, { eval: true, workerData: {
    tx: new URL('../src/adapters/control-store/transaction.ts', import.meta.url).href,
    wm: new URL('../src/adapters/control-store/commit-watermark.ts', import.meta.url).href, filename: f.filename,
  } }));
  t.after(async () => { await Promise.all(pool.map(worker => worker.terminate())); });
  await Promise.all(pool.map(worker => new Promise<void>((resolve, reject) => { worker.once('error', reject); worker.once('message', message => message.ready ? resolve() : reject(new Error(message.error))); })));
  const results = await Promise.all(pool.map(worker => new Promise<number[]>((resolve, reject) => {
    worker.once('error', reject); worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message.sequences)); worker.postMessage('run');
  })));
  assert.deepEqual(results.flat().sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.equal(f.watermark.read().commitSeq, 50); assert.equal(f.db.prepare('SELECT count(*) AS n FROM item').get()?.n, 50);
  await Promise.all(pool.map(worker => new Promise<void>((resolve, reject) => { if (worker.threadId === -1) return resolve(); worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`))); })));
});
