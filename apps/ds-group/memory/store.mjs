// Adapted from Shiyu relationship-domain, cognition-domain and ingress-domain.
// Accounts, source revisions and claims remain separate; labels never establish identity.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
export const sha = value => createHash('sha256').update(value).digest('hex');
export const identityId = (transport, account) => `${transport}:${account}`;
export const canonicalIdentity = id => typeof id === 'string' && /^[@!]/.test(id) ? `matrix:${id}` : id;
export const sourceId = (transport, room, event) => `source_${sha(canonical([transport, room, event]))}`;
const parsed = row => row ? JSON.parse(row.json) : undefined;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const nonempty = (value, code) => typeof value === 'string' && value.trim() ? value.trim() : fail(code);

export class MemoryStore {
  constructor(filename, { clock = Date.now } = {}) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.clock = clock;
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(id TEXT, revision INTEGER, json TEXT NOT NULL, PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS source_heads(id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,bot TEXT NOT NULL,scope TEXT NOT NULL,status TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_lookup ON memories(bot,scope,status);
      CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,json TEXT NOT NULL);`);
    this.deploymentId = this.getMeta('deployment') || `dscord_${randomUUID()}`;
    this.setMeta('deployment', this.deploymentId);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getMeta(key) { return parsed(this.db.prepare('SELECT json FROM meta WHERE key=?').get(key)); }
  setMeta(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, canonical(value)); }
  log(action, value) { this.db.prepare('INSERT INTO journal(json) VALUES(?)').run(canonical({ changeId: randomUUID(), action, at: this.clock(), ...value })); }
  contact({ id, name = id, kind = 'human', ownerId, source, observedAt = this.clock() }) {
    nonempty(id, 'IDENTITY_REQUIRED');
    const old = this.getContact(id);
    const newer = !old || observedAt >= (old.nameAt || 0);
    const effectiveKind = kind === 'unknown' && old ? old.kind : newer ? kind : old.kind;
    const effectiveOwner = ownerId || old?.ownerId;
    const next = { id, kind: effectiveKind, ...(effectiveOwner ? { ownerId: effectiveOwner } : {}),
      name: newer ? name : old.name, nameAt: newer ? observedAt : old.nameAt,
      aliases: [...new Set([...(old?.aliases || []), name])],
      observations: [...(old?.observations || []), { name, kind, source, at: observedAt }].slice(-100) };
    if (old?.name === name && old.kind === effectiveKind && old.ownerId === effectiveOwner && observedAt <= (old.nameAt || 0)) return old;
    this.db.prepare('INSERT OR REPLACE INTO contacts VALUES(?,?)').run(id, canonical(next));
    return next;
  }
  getContact(id) { return parsed(this.db.prepare('SELECT json FROM contacts WHERE id=?').get(id)); }
  contacts(query = '') {
    return this.db.prepare('SELECT json FROM contacts ORDER BY id').all().map(parsed)
      .filter(row => !query || row.id.includes(query) || row.aliases.some(name => name.includes(query)));
  }
  observe({ id, revision = 1, body = '', ...metadata }) {
    nonempty(id, 'SOURCE_REQUIRED');
    if (!Number.isSafeInteger(revision) || revision < 1) fail('SOURCE_REVISION_REQUIRED');
    const next = { ...metadata, id, revision, body, digest: sha(body), observedAt: this.clock() };
    const old = this.source(id, revision);
    if (old) {
      // Same event can arrive with a newer display label. Event content and authorship cannot change in place.
      if (old.digest !== next.digest || old.authorId !== next.authorId || old.roomId !== next.roomId || old.withdrawn !== next.withdrawn) fail('SOURCE_CONTENT_CONFLICT');
      return old;
    }
    return this.transaction(() => {
      const head = this.source(id);
      if (head && revision <= head.revision) fail('STALE_SOURCE_REVISION');
      this.db.prepare('INSERT INTO sources VALUES(?,?,?)').run(id, revision, canonical(next));
      this.db.prepare('INSERT OR REPLACE INTO source_heads VALUES(?,?)').run(id, revision);
      this.log('source', { id, revision });
      return next;
    });
  }
  source(id, revision) {
    if (revision === undefined) revision = this.db.prepare('SELECT revision FROM source_heads WHERE id=?').get(id)?.revision;
    return revision === undefined ? undefined : parsed(this.db.prepare('SELECT json FROM sources WHERE id=? AND revision=?').get(id, revision));
  }
  sources() { return this.db.prepare('SELECT s.json FROM sources s JOIN source_heads h ON h.id=s.id AND h.revision=s.revision ORDER BY s.rowid').all().map(parsed); }
  evidenceRoots(refs, seen = new Set()) {
    const roots = new Map();
    for (const ref of refs) {
      const key = `${ref.id}:${ref.revision}`; if (seen.has(key)) continue; seen.add(key);
      const source = this.source(ref.id, ref.revision);
      const origins = source?.originRefs?.filter(origin => this.source(origin.id, origin.revision)) || [];
      if (origins.length) for (const root of this.evidenceRoots(origins, seen)) roots.set(`${root.id}:${root.revision}`, root);
      else roots.set(key, { id: ref.id, revision: ref.revision });
    }
    return [...roots.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  retractSource(id) {
    const old = this.source(id); if (!old) fail('SOURCE_NOT_FOUND');
    return this.observe({ ...old, revision: old.revision + 1, withdrawn: true });
  }
  get(id) { return parsed(this.db.prepare('SELECT json FROM memories WHERE id=?').get(id)); }
  write(row) {
    this.db.prepare('INSERT OR REPLACE INTO memories VALUES(?,?,?,?,?)').run(row.id, row.botId, row.scope, row.status, canonical(row));
    return row;
  }
  prepare(input) {
    const botId = nonempty(input.botId, 'BOT_REQUIRED'), scope = nonempty(input.scope, 'SCOPE_REQUIRED');
    const text = nonempty(input.text, 'MEMORY_EMPTY');
    if (Buffer.byteLength(text) > 15000) fail('MEMORY_TOO_LONG');
    const sourceRefs = [...new Map((input.sourceRefs || []).map(ref => [`${ref.id}:${ref.revision}`, ref])).values()]
      .sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision);
    if (!sourceRefs.length) fail('MEMORY_SOURCE_REQUIRED');
    for (const ref of sourceRefs) {
      const source = this.source(ref.id);
      if (!source || source.revision !== ref.revision || source.withdrawn) fail('MEMORY_SOURCE_STALE');
    }
    const subjectId = canonicalIdentity(nonempty(input.subjectId, 'SUBJECT_REQUIRED'));
    const predicate = input.predicate?.trim() || 'note';
    const kind = input.kind || 'stated';
    if (!['stated', 'reported', 'observation', 'inference', 'legacy'].includes(kind)) fail('INVALID_CLAIM_KIND');
    const validFrom = input.validFrom ?? Math.min(...sourceRefs.map(ref => this.source(ref.id).timestamp || this.clock()));
    const validUntil = input.validUntil ?? null;
    const saidBy = canonicalIdentity(input.saidBy) || null;
    if (!Number.isFinite(validFrom) || validUntil !== null && (!Number.isFinite(validUntil) || validUntil <= validFrom)) fail('INVALID_VALIDITY');
    const fingerprint = sha(canonical({ botId, scope, text, sourceRefs, subjectId, predicate, kind,
      saidBy, validFrom, validUntil, replaces: input.replaces || null }));
    const id = `memory_${fingerprint}`;
    const duplicate = this.get(id); if (duplicate) return duplicate;
    const old = input.replaces ? this.get(input.replaces) : undefined;
    const reclassify = old && input.reclassify === true && old.text === text
      && canonical(old.sourceRefs) === canonical(sourceRefs);
    if (input.replaces && (!old || old.status !== 'active' || old.revision !== input.expectedRevision
      || old.botId !== botId || old.scope !== scope || canonicalIdentity(old.subjectId) !== subjectId && !reclassify)) fail('MEMORY_REVISION_CONFLICT');
    return this.write({ id, rootId: old?.rootId || id, revision: (old?.revision || 0) + 1,
      botId, scope, text, subjectId, predicate, kind, saidBy, topic: input.topic || null,
      sourceRefs, validFrom, validUntil, observedAt: this.clock(), replaces: old?.id || null,
      ...(reclassify ? { reclassifiedFrom: old.subjectId } : {}),
      status: 'pending', bodyDigest: sha(text), receipt: null, index: null });
  }
  activate(id, receipt) {
    return this.transaction(() => {
      const row = this.get(id); if (!row) fail('MEMORY_NOT_FOUND');
      if (row.status === 'active') return row;
      if (row.status !== 'pending') fail('MEMORY_NOT_PENDING');
      if (receipt.bodyDigest !== row.bodyDigest) fail('MEMORY_BODY_MISMATCH');
      if (row.replaces) {
        const old = this.get(row.replaces);
        if (old.status !== 'active' || old.revision + 1 !== row.revision) fail('MEMORY_REVISION_CONFLICT');
        this.write({ ...old, status: 'superseded', supersededBy: row.id });
      }
      const saved = this.write({ ...row, status: 'active', receipt });
      this.log('remember', { id, revision: row.revision, replaces: row.replaces, botId: row.botId }); return saved;
    });
  }
  indexed(id, index) { const row = this.get(id); return this.write({ ...row, index }); }
  forget(id, expectedRevision) {
    return this.transaction(() => {
      const row = this.get(id);
      if (!row || row.status !== 'active' || row.revision !== expectedRevision) fail('MEMORY_REVISION_CONFLICT');
      this.log('forget', { id, revision: row.revision, botId: row.botId });
      return this.write({ ...row, status: 'withdrawn', withdrawnAt: this.clock() });
    });
  }
  undo(changeId) {
    return this.transaction(() => {
      const change = this.history().find(item => item.changeId === changeId || `${item.action}:${item.id}` === changeId);
      if (!change) fail('MEMORY_CHANGE_NOT_FOUND');
      changeId = change.changeId || `${change.action}:${change.id}`;
      if (this.getMeta(`undone:${changeId}`)) fail('MEMORY_ALREADY_RESTORED');
      const action = change.action, row = this.get(change.id);
      if (!row) fail('MEMORY_NOT_FOUND');
      if (change.revision !== undefined && row.revision !== change.revision) fail('MEMORY_REVISION_CONFLICT');
      if (action === 'forget') {
        if (row.status !== 'withdrawn') fail('MEMORY_REVISION_CONFLICT');
        this.write({ ...row, status: 'active', revision: row.revision + 1 });
      } else if (action === 'remember') {
        if (row.status !== 'active') fail('MEMORY_REVISION_CONFLICT');
        this.write({ ...row, status: 'withdrawn', withdrawnAt: this.clock() });
        if (row.replaces) {
          const old = this.get(row.replaces);
          if (old.status !== 'superseded' || old.supersededBy !== row.id) fail('MEMORY_REVISION_CONFLICT');
          this.write({ ...old, status: 'active', revision: row.revision + 1 });
        }
      } else fail('MEMORY_CHANGE_NOT_FOUND');
      this.setMeta(`undone:${changeId}`, true); this.log('restore', { changeId, botId: row.botId });
      return this.get(row.replaces && action === 'remember' ? row.replaces : row.id);
    });
  }
  derivation(row, asOf = this.clock()) {
    if (row.status !== 'active') return row.status;
    if (asOf < row.validFrom) return 'not-yet-valid';
    if (row.validUntil !== null && asOf >= row.validUntil) return 'expired';
    const pending = [...row.sourceRefs], visited = new Set();
    for (const ref of pending) {
      const key = `${ref.id}:${ref.revision}`; if (visited.has(key)) continue; visited.add(key);
      const source = this.source(ref.id);
      if (!source || source.withdrawn) return 'source-withdrawn';
      if (source.revision !== ref.revision) return 'source-revised';
      // A known original event invalidates its relay chain as well. An explicitly
      // unavailable original stays a reported source, never fabricated evidence.
      pending.push(...(source.originRefs || []).filter(origin => this.source(origin.id)));
    }
    return 'current';
  }
  list({ botId, scopes, subjectId, topic, asOf, history = false } = {}) {
    const rows = this.db.prepare('SELECT json FROM memories ORDER BY rowid').all().map(parsed)
      .filter(row => (!botId || row.botId === botId || row.scope === 'team')
        && (!scopes || scopes.includes(row.scope)) && (!subjectId || canonicalIdentity(row.subjectId) === canonicalIdentity(subjectId)) && (!topic || row.topic === topic))
      .map(row => ({ ...row, derivation: this.derivation(row, asOf) }));
    return history ? rows : rows.filter(row => row.derivation === 'current');
  }
  conflicts(row) {
    if (row.predicate === 'note' || !['stated', 'observation'].includes(row.kind)) return [];
    return this.list({ botId: row.botId, scopes: [row.scope], subjectId: row.subjectId })
      .filter(other => other.id !== row.id && other.predicate === row.predicate && other.text !== row.text
        && ['stated', 'observation'].includes(other.kind)).map(other => other.id);
  }
  history() { return this.db.prepare('SELECT json FROM journal ORDER BY seq DESC').all().map(parsed); }
}
