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
function contactObservation(old, { id, name, kind, ownerId, source, observedAt }) {
  const newer = !old || observedAt >= (old.nameAt || 0);
  const effectiveKind = kind === 'unknown' && old ? old.kind : newer ? kind : old.kind;
  const effectiveOwner = ownerId || old?.ownerId;
  if (old?.name === name && old.kind === effectiveKind && old.ownerId === effectiveOwner && observedAt <= (old.nameAt || 0)) return old;
  return { id, kind: effectiveKind, ...(effectiveOwner ? { ownerId: effectiveOwner } : {}),
    name: newer ? name : old.name, nameAt: newer ? observedAt : old.nameAt,
    aliases: [...new Set([...(old?.aliases || []), name])],
    observations: [...(old?.observations || []), { name, kind, source, at: observedAt }].slice(-100) };
}

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
      CREATE TABLE IF NOT EXISTS observations(bot TEXT NOT NULL,seq INTEGER NOT NULL,source TEXT NOT NULL,revision INTEGER NOT NULL,
        PRIMARY KEY(bot,seq),UNIQUE(bot,source,revision));
      CREATE TABLE IF NOT EXISTS observation_dispositions(bot TEXT NOT NULL,source TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,
        PRIMARY KEY(bot,source,revision));
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,json TEXT NOT NULL);`);
    this.deploymentId = this.getMeta('deployment') || `dscord_${randomUUID()}`;
    this.setMeta('deployment', this.deploymentId);
  }
  close() { this.db.close(); }
  transaction(fn) {
    // Batch ingress/review composes these same synchronous store operations.
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  getMeta(key) { return parsed(this.db.prepare('SELECT json FROM meta WHERE key=?').get(key)); }
  setMeta(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, canonical(value)); }
  log(action, value) { this.db.prepare('INSERT INTO journal(json) VALUES(?)').run(canonical({ changeId: randomUUID(), action, at: this.clock(), ...value })); }
  contact({ id, name = id, kind = 'human', ownerId, source, observedAt = this.clock(), botId }) {
    nonempty(id, 'IDENTITY_REQUIRED');
    const observation = { id, name, kind, ownerId, source, observedAt }, old = this.getContact(id), next = contactObservation(old, observation);
    if (next !== old) this.db.prepare('INSERT OR REPLACE INTO contacts VALUES(?,?)').run(id, canonical(next));
    if (botId) {
      const key = `contact:${botId}:${id}`, prior = this.getMeta(key), own = contactObservation(prior, observation);
      if (own !== prior) this.setMeta(key, own);
    }
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
      if (head && head.authorId !== next.authorId) fail('SOURCE_AUTHOR_CONFLICT');
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
  observeFor(botId, refs) {
    nonempty(botId, 'BOT_REQUIRED');
    return this.transaction(() => refs.map(ref => {
      if (!this.source(ref.id, ref.revision)) fail('SOURCE_NOT_FOUND');
      const old = this.db.prepare('SELECT seq FROM observations WHERE bot=? AND source=? AND revision=?').get(botId, ref.id, ref.revision);
      if (old) return { sequence: old.seq, ...ref };
      const sequence = this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM observations WHERE bot=?').get(botId).seq;
      this.db.prepare('INSERT INTO observations VALUES(?,?,?,?)').run(botId, sequence, ref.id, ref.revision);
      return { sequence, ...ref };
    }));
  }
  observations(botId) {
    return this.db.prepare('SELECT seq AS sequence,source AS id,revision FROM observations WHERE bot=? ORDER BY seq').all(botId);
  }
  setSourceDisposition(botId, ref, disposition) {
    if (!disposition || !['context', 'pending-request', 'task-update'].includes(disposition.kind)
      || disposition.kind === 'task-update' && (typeof disposition.forEventId !== 'string' || !disposition.forEventId || disposition.forEventId.length > 1024)) fail('MEMORY_DISPOSITION_INVALID');
    if (!this.db.prepare('SELECT 1 FROM observations WHERE bot=? AND source=? AND revision=?').get(botId, ref.id, ref.revision)) fail('MEMORY_SOURCE_NOT_OBSERVED');
    const old = this.sourceDisposition(botId, ref);
    // A generic contextual replay cannot downgrade a trusted queued-work marker.
    if (old.kind !== 'context' && disposition.kind === 'context') return old;
    const value = { kind: disposition.kind, ...(disposition.kind === 'task-update' ? { forEventId: disposition.forEventId } : {}) };
    this.db.prepare('INSERT OR REPLACE INTO observation_dispositions VALUES(?,?,?,?)').run(botId, ref.id, ref.revision, canonical(value));
    return value;
  }
  sourceDisposition(botId, ref) {
    return parsed(this.db.prepare('SELECT json FROM observation_dispositions WHERE bot=? AND source=? AND revision=?').get(botId, ref.id, ref.revision)) || { kind: 'context' };
  }
  admitSources(botId, current) {
    for (const ref of current.sourceRefs || []) {
      const source = this.source(ref.id, ref.revision); if (!source) continue;
      if (!this.getMeta(`admitted-source:${botId}:${ref.id}`)) this.setMeta(`admitted-source:${botId}:${ref.id}`,
        { revision: ref.revision, eventId: source.eventId, sessionId: current.sessionId || null, at: this.clock() });
    }
  }
  sourceAdmitted(botId, ref) { return Boolean(this.getMeta(`admitted-source:${botId}:${ref.id}`)); }
  eventAdmitted(botId, eventId, roomId) {
    return this.observations(botId).some(ref => {
      const source = this.source(ref.id, ref.revision);
      return source?.eventId === eventId && (!roomId || source.roomId === roomId) && this.sourceAdmitted(botId, ref);
    });
  }
  watermarks(botId) {
    const rows = this.observations(botId);
    let reviewedThrough = 0, settledThrough = 0, reviewedCount = 0, invalidatedCount = 0;
    for (const row of rows) {
      const head = this.source(row.id);
      const invalidated = !head || head.revision !== row.revision || head.withdrawn;
      const notice = head?.eventKind === 'redaction-notice';
      const reviewed = this.getMeta(`reviewed:${botId}:${row.id}:${row.revision}`) === true;
      if (reviewed) reviewedCount++;
      if (invalidated) invalidatedCount++;
      if (row.sequence === reviewedThrough + 1 && reviewed) reviewedThrough = row.sequence;
      if (row.sequence === settledThrough + 1 && (reviewed || invalidated || notice)) settledThrough = row.sequence;
    }
    return { receivedThrough: rows.at(-1)?.sequence || 0, reviewedThrough, settledThrough, reviewedCount, invalidatedCount,
      contextThrough: this.getMeta(`context-through:${botId}`) || 0,
      pendingReviewCount: (this.getMeta(`unreviewed:${botId}`) || []).filter(ref => {
        const source = this.source(ref.id);
        return source && source.revision === ref.revision && !source.withdrawn && !this.getMeta(`reviewed:${botId}:${ref.id}:${ref.revision}`);
      }).length };
  }
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
    const validFrom = input.validFrom ?? Math.min(...sourceRefs.map(ref => this.source(ref.id).timestamp ?? this.clock()));
    const validUntil = input.validUntil ?? null;
    const saidBy = canonicalIdentity(input.saidBy) || null;
    if (!Number.isFinite(validFrom) || validUntil !== null && (!Number.isFinite(validUntil) || validUntil <= validFrom)) fail('INVALID_VALIDITY');
    const claimState = input.claimState || 'statement';
    if (!['statement', 'proposal', 'confirmed', 'uncertain'].includes(claimState)) fail('INVALID_CLAIM_STATE');
    const ids = values => {
      if (values === undefined) return [];
      if (!Array.isArray(values) || values.length > 32 || values.some(id => typeof id !== 'string' || !id.trim() || id.length > 512)) fail('INVALID_MEMORY_ENTITIES');
      return [...new Set(values.map(id => canonicalIdentity(id.trim())))].sort();
    };
    const entityIds = ids(input.entityIds), projectIds = ids(input.projectIds), facets = ids(input.facets);
    if (input.basisRefs !== undefined && (!Array.isArray(input.basisRefs) || input.basisRefs.some(ref => !ref || typeof ref.id !== 'string' || !Number.isSafeInteger(ref.revision) || ref.revision < 1))) fail('INVALID_MEMORY_BASIS');
    const basisRefs = [...new Map((input.basisRefs || []).map(ref => [`${ref.id}:${ref.revision}`, { id: ref.id, revision: ref.revision }])).values()]
      .sort((a,b) => a.id.localeCompare(b.id));
    if (basisRefs.length > 32) fail('INVALID_MEMORY_BASIS');
    for (const ref of basisRefs) {
      const basis = this.get(ref.id);
      if (!basis || basis.revision !== ref.revision || basis.botId !== botId && basis.scope !== 'team' || this.derivation(basis) !== 'current') fail('MEMORY_BASIS_STALE');
    }
    // Keep the pre-v2 identity for claims without added semantic metadata. An
    // upgrade/retry must not duplicate every legacy record in an existing store.
    const fingerprint = sha(canonical({ botId, scope, text, sourceRefs, subjectId, predicate, kind,
      ...(claimState !== 'statement' ? { claimState } : {}), ...(entityIds.length ? { entityIds } : {}),
      ...(projectIds.length ? { projectIds } : {}), ...(facets.length ? { facets } : {}), ...(basisRefs.length ? { basisRefs } : {}),
      saidBy, validFrom, validUntil, replaces: input.replaces || null }));
    const id = `memory_${fingerprint}`;
    const duplicate = this.get(id); if (duplicate) return duplicate;
    const old = input.replaces ? this.get(input.replaces) : undefined;
    const reclassify = old && input.reclassify === true && old.text === text
      && canonical(old.sourceRefs) === canonical(sourceRefs);
    if (input.replaces && (!old || old.status !== 'active' || old.revision !== input.expectedRevision
      || old.botId !== botId || old.scope !== scope || canonicalIdentity(old.subjectId) !== subjectId && !reclassify)) fail('MEMORY_REVISION_CONFLICT');
    return this.write({ id, rootId: old?.rootId || id, revision: (old?.revision || 0) + 1,
      botId, scope, text, subjectId, predicate, kind, claimState, entityIds, projectIds, facets, basisRefs, saidBy, topic: input.topic || null,
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
      if (this.basisStatus(row).status !== 'current') fail('MEMORY_SOURCE_STALE');
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
  basisStatus({ sourceRefs = [], basisRefs = [] }, asOf = this.clock(), seen = new Set()) {
    const issues = [], pending = [...sourceRefs], visited = new Set();
    for (const ref of pending) {
      const key = `${ref.id}:${ref.revision}`; if (visited.has(key)) continue; visited.add(key);
      const head = this.source(ref.id);
      if (!head || head.withdrawn || head.revision !== ref.revision) issues.push({ type: 'source', ...ref, currentRevision: head?.revision ?? null,
        reason: !head || head.withdrawn ? 'source-withdrawn' : 'source-revised' });
      const source = this.source(ref.id, ref.revision);
      pending.push(...(source?.originRefs || []).filter(origin => this.source(origin.id)));
    }
    for (const ref of basisRefs) {
      const row = this.get(ref.id), state = row ? this.derivation(row, asOf, seen) : 'missing';
      if (!row || row.revision !== ref.revision || state !== 'current') issues.push({ type: 'memory', ...ref,
        currentRevision: row?.revision ?? null, reason: row && row.revision !== ref.revision ? 'basis-revised' : `basis-${state}` });
    }
    return { status: issues.length ? 'needs-review' : 'current', issues };
  }
  derivation(row, asOf = this.clock(), seen = new Set()) {
    if (!row) return 'missing';
    if (seen.has(row.id)) return 'basis-cycle';
    seen = new Set([...seen, row.id]);
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
    const basis = this.basisStatus({ basisRefs: row.basisRefs }, asOf, seen);
    if (basis.status !== 'current') return basis.issues[0].reason;
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
