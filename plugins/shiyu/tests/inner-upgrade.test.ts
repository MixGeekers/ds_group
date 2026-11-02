import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';

/**
 * Regression for the live-upgrade path: an already-installed H4 inner domain
 * (pre-H4e schema) must upgrade additively without altering any table that is
 * already covered by commit-watermark triggers. The derivation authority lives
 * in a separate table, so the watermark trigger SQL never embeds a changed
 * column list and the next tracked transaction still passes verification.
 */
test('an existing pre-H4e inner schema upgrades additively and reopens with consistent tracking', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-inner-upgrade-'));
  const filename = join(directory, 'control.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
 	const at = new Date().toISOString();
  {
    const db = new DatabaseSync(filename);
    db.exec(`
      CREATE TABLE shiyu_relationship_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,authority_id TEXT NOT NULL,
        installation_generation TEXT NOT NULL,policy_version INTEGER NOT NULL,revision INTEGER NOT NULL,
        tombstone_watermark INTEGER NOT NULL,baseline_id TEXT NOT NULL,installed_at TEXT NOT NULL);
      CREATE TABLE shiyu_relationship_records(record_id TEXT PRIMARY KEY,identity TEXT NOT NULL,revision INTEGER NOT NULL,
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),UNIQUE(identity,revision));
      CREATE INDEX shiyu_relationship_records_identity ON shiyu_relationship_records(identity,revision DESC);
      CREATE TABLE shiyu_relationship_bodies(record_id TEXT PRIMARY KEY REFERENCES shiyu_relationship_records(record_id),
        payload_digest TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)));
      CREATE TABLE shiyu_relationship_evidence_tombstones(kind TEXT NOT NULL,source_id TEXT NOT NULL,watermark INTEGER NOT NULL,
        withdrawn_at TEXT NOT NULL,PRIMARY KEY(kind,source_id));
      CREATE TABLE shiyu_relationship_record_tombstones(identity TEXT PRIMARY KEY,watermark INTEGER NOT NULL,withdrawn_at TEXT NOT NULL);
      CREATE TABLE shiyu_relationship_commands(request_id TEXT PRIMARY KEY,kind TEXT NOT NULL,intent_hash TEXT NOT NULL,
        receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)));
    `);
    db.prepare(`INSERT INTO shiyu_relationship_meta VALUES(1,1,?,?,?,0,0,?,?)`).run(
      'synthetic-upgrade-authority', 'synthetic-upgrade-generation', 1, randomUUID(), at);
    db.close();
  }
  const open = () => ControlStore.open({ filename, eventTypes: SHIYU_EVENT_TYPES, componentHandlers: ['conversation.background'],
    runtimeIdentity: { hostEpoch: 'synthetic-upgrade-host', installationGeneration: 'synthetic-upgrade-generation' } });
  const store = await open();
  try {
    const watermark = await store.request('control.watermark', {});
    assert.equal(watermark.baselineId.length, 36);
    assert.ok(watermark.commitSeq >= 1, 'the additive upgrade must be one tracked schema commit');
  } finally { await store.close(); }
  // A second open proves the installed tracking triggers still match the schema.
  const reopened = await open();
  try {
    const watermark = await reopened.request('control.watermark', {});
    assert.ok(watermark.commitSeq >= 1);
  } finally { await reopened.close(); }
  // The old meta stays unchanged; the derivation authority is additive.
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const metaColumns = (db.prepare('PRAGMA table_info(shiyu_relationship_meta)').all() as Array<{ name: string }>).map(column => column.name);
    assert.deepEqual(metaColumns, ['id', 'schema_version', 'authority_id', 'installation_generation', 'policy_version', 'revision',
      'tombstone_watermark', 'baseline_id', 'installed_at']);
    const derived = db.prepare('SELECT derived_revision,derivation_digest FROM shiyu_relationship_derivation_meta WHERE id=1').get() as
      { derived_revision: number; derivation_digest: string } | undefined;
    assert.deepEqual({ ...derived }, { derived_revision: 0, derivation_digest: '' });
  } finally { db.close(); }
});
