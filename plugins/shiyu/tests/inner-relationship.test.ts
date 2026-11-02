import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { Worker } from 'node:worker_threads';
import { RelationshipDomain } from '../src/adapters/control-store/relationship-domain.js';
import type { InnerConversationFacts, InnerEvidenceFacts, InnerSourceRef } from '../src/contracts/inner.js';

const start = '2026-11-02T12:00:00.000Z';
const dm = 'conversation-dm', group = 'conversation-group';
const code = (...codes: string[]) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && codes.includes(String(error.code));
const account = (externalSubjectId: string, patch: Record<string, string> = {}) => ({
  connectionId: 'synthetic-connection', identityNamespace: 'synthetic-lab', identityType: 'member', externalSubjectId, ...patch,
});

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shiyu-inner-relationship-'));
  const filename = join(directory, 'control.sqlite');
  const connections = new Set<DatabaseSync>();
  let clock = Date.parse(start);
  const conversations = new Map<string, InnerConversationFacts>([
    [dm, { audience: { scope: 'local-owner', kind: 'direct', audienceId: dm }, revision: 1, audienceVersion: 1, active: true }],
    [group, { audience: { scope: 'local-owner', kind: 'group', audienceId: group }, revision: 1, audienceVersion: 1, active: true }],
  ]);
  const evidence = new Map<string, InnerEvidenceFacts>();
  const open = () => {
    const db = new DatabaseSync(filename); connections.add(db);
    db.exec('PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000');
    const tx = new SqliteTransactions(db);
    const domain = new RelationshipDomain(db, tx, {
      runtimeIdentity: { hostEpoch: 'inner-host', installationGeneration: 'inner-install' }, now: () => new Date(clock),
      resolveConversation: id => conversations.get(id),
      resolveEvidence: ref => evidence.get(`${ref.kind}:${ref.sourceId}@${ref.revision}`),
    });
    return { db, tx, domain, close() { if (connections.delete(db)) db.close(); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  const f = open();
  const observation = (id = dm, revision = 1): InnerSourceRef => ({ kind: 'conversation-observation', sourceId: id, revision });
  const ownerCommand = (requestId: string): InnerSourceRef => ({ kind: 'owner-command', sourceId: `owner-command:${requestId}`, revision: 1 });
  const subject = (key: string, displayName = '同名', requestKey = key) => f.domain.registerSubject({ requestId: `subject-${requestKey}`, account: account(key), entityKind: 'person', displayName });
  const assertFact = (requestId: string, conversationId: string, subjectId: string, sourceRefs: InnerSourceRef[], patch: Record<string, unknown> = {}) => f.domain.assert({
    requestId, conversationId, subjectId, predicate: 'interaction', value: 'message-exchange', sourceRefs, ...patch,
  });
  return { ...f, open, filename, conversations, evidence, observation, ownerCommand, subject, assertFact,
    advance(ms: number) { clock += ms; }, setActive(id: string, active: boolean) { const facts = conversations.get(id)!; conversations.set(id, { ...facts, active }); },
    reads<T>(read: () => T): { value: T; changes: number } { const before = Number(f.db.prepare('SELECT total_changes() AS n').get()!.n); const value = read(); return { value, changes: Number(f.db.prepare('SELECT total_changes() AS n').get()!.n) - before }; } };
}

test('stable subject mapping keys on the full trusted account, never on identical display names', t => {
  const f = fixture(t);
  const one = f.subject('person-1'), two = f.subject('person-2');
  assert.notEqual(one.record.entityId, two.record.entityId);
  assert.equal(one.record.created, true);
  const duplicate = f.subject('person-1', '同名', 'person-1-second-request');
  assert.equal(duplicate.record.created, false); assert.equal(duplicate.record.entityId, one.record.entityId);
  assert.equal(duplicate.record.canonicalEntityId, one.record.entityId);
  assert.throws(() => f.domain.registerSubject({ requestId: 'subject-person-1', account: account('person-1'), entityKind: 'person', displayName: '改了名字' }), code('IDEMPOTENCY_CONFLICT'));
  // A same short id under another namespace/type is a different trusted account.
  const secondary = f.domain.registerSubject({ requestId: 'subject-person-1-second', account: account('person-1', { identityType: 'guest' }), entityKind: 'person', displayName: '同名' });
  assert.notEqual(secondary.record.entityId, one.record.entityId);
  f.close(); const reopened = f.open();
  assert.equal(reopened.domain.resolveSubject({ entityId: one.record.entityId }).canonicalEntityId, one.record.entityId);
  assert.equal(reopened.domain.resolveSubject({ entityId: secondary.record.entityId }).canonicalEntityId, secondary.record.entityId);
});

test('sourced interaction facts stay in their audience and bodies are read separately from capture metadata', t => {
  const f = fixture(t), entity = f.subject('person-1').record.entityId;
  const written = f.assertFact('interaction-dm', dm, entity, [f.observation()], { saidBy: f.subject('person-2').record.entityId });
  const capture = f.domain.captureForView({ conversationId: dm });
  const metadata = capture.records.find(record => record.recordId === written.record.recordId)!;
  assert.equal(metadata.kind, 'assertion'); assert.equal(metadata.status, 'active'); assert.equal(metadata.evidenceState, 'valid');
  assert.equal(metadata.audience.audienceId, dm); assert.equal(JSON.stringify(metadata).includes('message-exchange'), false);
  const bodies = f.domain.readBodies({ capture, recordIds: [written.record.recordId] });
  const payload = bodies.bodies[0]!.payload as Record<string, unknown>;
  assert.equal(payload.predicate, 'interaction'); assert.equal(payload.value, 'message-exchange');
  assert.equal(payload.epistemicStatus, 'reported'); assert.notEqual(payload.saidBy, payload.subjectId);
  // Owner-private directory records are visible everywhere in the owner scope; the DM fact is not.
  const groupCapture = f.domain.captureForView({ conversationId: group });
  assert.equal(groupCapture.records.some(record => record.recordId === written.record.recordId), false);
  assert.ok(groupCapture.records.some(record => record.kind === 'entity'));
  assert.throws(() => f.domain.readBodies({ capture: groupCapture, recordIds: [written.record.recordId] }), code('INNER_BODY_FORBIDDEN'));
  assert.throws(() => f.domain.captureForView({ conversationId: group, recordIds: [written.record.recordId] }), code('INNER_VIEW_FORBIDDEN'));
});

test('a claim without an independently observable source is refused; metadata and permission fields are not accepted', t => {
  const f = fixture(t), entity = f.subject('person-1').record.entityId;
  assert.throws(() => f.assertFact('no-source', dm, entity, []), code('INVALID_INNER_INPUT'));
  assert.throws(() => f.assertFact('own-command-only', dm, entity, [f.ownerCommand('own-command-only')]), code('INNER_SOURCE_REQUIRED'));
  assert.throws(() => f.assertFact('unknown-source', dm, entity, [{ kind: 'memory-operation', sourceId: 'memory-missing', revision: 1 }]), code('INNER_SOURCE_UNAVAILABLE'));
  assert.throws(() => f.assertFact('cross-audience-source', group, entity, [f.observation(dm)]), code('INNER_SOURCE_UNAVAILABLE'));
  assert.throws(() => f.assertFact('wrong-owner-command', dm, entity, [f.observation(), f.ownerCommand('another-command')]), code('INNER_SOURCE_INVALID'));
  for (const extra of [{ actor: 'owner' }, { scope: 'private' }, { permission: 'tool.execute' }, { audience: { kind: 'owner' } }]) {
    assert.throws(() => f.assertFact('smuggled', dm, entity, [f.observation()], extra), code('INVALID_INNER_INPUT'));
  }
  assert.throws(() => f.assertFact('bad-predicate', dm, entity, [f.observation()], { predicate: 'permission-grant' }), code('INVALID_INNER_INPUT'));
  assert.throws(() => f.assertFact('assessed-grant', dm, entity, [f.observation()], { predicate: 'owner-assessment', value: 'trusted-socially' }), code('INVALID_RELATIONSHIP_PAYLOAD'));
  // The labelled assessment remains an explicitly non-authoritative statement.
  const assessed = f.assertFact('assessment', dm, entity, [f.observation()], { predicate: 'owner-assessment', value: 'socially-close' });
  const capture = f.domain.captureForView({ conversationId: dm });
  const body = f.domain.readBodies({ capture, recordIds: [assessed.record.recordId] }).bodies[0]!.payload as Record<string, unknown>;
  assert.equal(body.epistemicStatus, 'assessed');
  assert.equal(['permission', 'allowedActions', 'grant', 'scope'].some(key => Object.hasOwn(body, key)), false);
});

test('corrections supersede with CAS and invalidate an old capture; stale corrections are refused', t => {
  const f = fixture(t), entity = f.subject('person-1').record.entityId;
  const first = f.assertFact('initial', dm, entity, [f.observation()]);
  const capture = f.domain.captureForView({ conversationId: dm });
  f.advance(1000);
  const revised = f.domain.reviseAssertion({ requestId: 'correction', conversationId: dm, assertionId: first.record.assertionId,
    expectedRevision: 1, predicate: 'interaction', value: 'call', sourceRefs: [f.observation()] });
  assert.equal(revised.record.revision, 2);
  assert.throws(() => f.domain.reviseAssertion({ requestId: 'stale-correction', conversationId: dm, assertionId: first.record.assertionId,
    expectedRevision: 1, predicate: 'interaction', value: 'meeting', sourceRefs: [f.observation()] }), code('INNER_RECORD_CONFLICT'));
  assert.throws(() => f.domain.validateForView({ capture }), code('INNER_CAPTURE_INVALIDATED'));
  const current = f.domain.captureForView({ conversationId: dm });
  const body = f.domain.readBodies({ capture: current, recordIds: [revised.record.recordId] }).bodies[0]!.payload as Record<string, unknown>;
  assert.equal(body.value, 'call');
  assert.equal(current.records.some(record => record.recordId === first.record.recordId), false);
  assert.throws(() => f.domain.reviseAssertion({ requestId: 'other-audience', conversationId: group, assertionId: first.record.assertionId,
    expectedRevision: 2, predicate: 'interaction', value: 'call', sourceRefs: [f.observation(group)] }), code('INNER_AUDIENCE_FORBIDDEN'));
});

test('explicit merges resolve canonically, can be split without rewriting history, and reject cycles', t => {
  const f = fixture(t), first = f.subject('person-1').record.entityId, second = f.subject('person-2').record.entityId;
  const assertion = f.assertFact('before-merge', dm, first, [f.observation()]);
  const merged = f.domain.mergeSubjects({ requestId: 'merge-one', fromEntityId: first, intoEntityId: second, sourceRefs: [f.observation()] });
  assert.equal(merged.record.canonicalEntityId, second);
  assert.deepEqual(f.domain.resolveSubject({ entityId: first }), { entityId: first, canonicalEntityId: second, mergeIds: [merged.record.mergeId] });
  const split = f.domain.splitSubjects({ requestId: 'split-one', mergeId: merged.record.mergeId, expectedRevision: 1, sourceRefs: [f.observation()] });
  assert.equal(split.record.canonicalEntityId, first);
  assert.deepEqual(f.domain.resolveSubject({ entityId: first }).mergeIds, []);
  assert.throws(() => f.domain.splitSubjects({ requestId: 'split-again', mergeId: merged.record.mergeId, expectedRevision: 2, sourceRefs: [f.observation()] }), code('INNER_RECORD_CONFLICT'));
  // The stored assertion still names the original subject identity; merging never rewrites history.
  const capture = f.domain.captureForView({ conversationId: dm });
  const body = f.domain.readBodies({ capture, recordIds: [assertion.record.recordId] }).bodies[0]!.payload as Record<string, unknown>;
  assert.equal(body.subjectId, first);
  f.domain.mergeSubjects({ requestId: 'merge-two', fromEntityId: first, intoEntityId: second, sourceRefs: [f.observation()] });
  assert.throws(() => f.domain.mergeSubjects({ requestId: 'merge-cycle', fromEntityId: second, intoEntityId: first, sourceRefs: [f.observation()] }), code('INNER_ENTITY_CYCLE'));
});

test('withdrawal tombstones evidence and identities durably, and the same command replays exactly', t => {
  const f = fixture(t), entity = f.subject('person-1').record.entityId;
  const written = f.assertFact('withdraw-target', dm, entity, [f.observation()]);
  const capture = f.domain.captureForView({ conversationId: dm });
  const receipt = f.domain.withdraw({ requestId: 'withdraw-evidence', evidenceRefs: [f.observation()] });
  assert.equal(receipt.tombstoneWatermark, 1);
  assert.deepEqual(f.domain.withdraw({ requestId: 'withdraw-evidence', evidenceRefs: [f.observation()] }), receipt);
  assert.throws(() => f.domain.validateForView({ capture }), code('INNER_CAPTURE_INVALIDATED'));
  const after = f.domain.captureForView({ conversationId: dm });
  const metadata = after.records.find(record => record.recordId === written.record.recordId)!;
  assert.equal(metadata.evidenceState, 'revoked'); assert.equal(metadata.bodyAvailable, false);
  assert.throws(() => f.domain.readBodies({ capture: after, recordIds: [written.record.recordId] }), code('INNER_BODY_FORBIDDEN'));
  assert.throws(() => f.assertFact('citation-after-withdrawal', dm, entity, [f.observation()]), code('INNER_SOURCE_UNAVAILABLE'));
  const identityReceipt = f.domain.withdraw({ requestId: 'withdraw-record', recordIds: [written.record.recordId] });
  assert.equal(identityReceipt.tombstoneWatermark, 2);
  assert.equal(f.domain.captureForView({ conversationId: dm }).records.some(record => record.recordId === written.record.recordId), false);
  const validMemory: InnerSourceRef = { kind: 'memory-operation', sourceId: 'memory-valid', revision: 1 };
  f.evidence.set('memory-operation:memory-valid@1', { valid: true, audience: { scope: 'local-owner', kind: 'direct', audienceId: dm }, revision: 1 });
  assert.throws(() => f.domain.reviseAssertion({ requestId: 'revive', conversationId: dm, assertionId: written.record.assertionId,
    expectedRevision: 1, predicate: 'interaction', value: 'call', sourceRefs: [validMemory] }), code('INNER_TOMBSTONED'));
  f.close(); const reopened = f.open();
  assert.equal(reopened.domain.captureForView({ conversationId: dm }).records.find(record => record.recordId === written.record.recordId), undefined);
  assert.throws(() => reopened.domain.captureForView({ conversationId: dm, recordIds: [written.record.recordId] }), code('INNER_VIEW_FORBIDDEN'));
});

test('sources that disappear later degrade or revoke dependants without rewriting the record', t => {
  const f = fixture(t), entity = f.subject('person-1').record.entityId;
  const memoryRef: InnerSourceRef = { kind: 'memory-operation', sourceId: 'memory-source-one', revision: 1 };
  f.evidence.set('memory-operation:memory-source-one@1', { valid: true, audience: { scope: 'local-owner', kind: 'direct', audienceId: dm }, revision: 1 });
  const written = f.assertFact('memory-backed', dm, entity, [f.observation(), memoryRef]);
  const capture = f.domain.captureForView({ conversationId: dm });
  assert.equal(capture.records.find(record => record.recordId === written.record.recordId)!.evidenceState, 'valid');
  f.evidence.set('memory-operation:memory-source-one@1', { valid: false, audience: { scope: 'local-owner', kind: 'direct', audienceId: dm }, revision: 1 });
  const degraded = f.domain.captureForView({ conversationId: dm }).records.find(record => record.recordId === written.record.recordId)!;
  assert.equal(degraded.evidenceState, 'degraded'); assert.equal(degraded.bodyAvailable, true);
  assert.throws(() => f.domain.validateForView({ capture }), code('INNER_CAPTURE_INVALIDATED'));
  f.setActive(dm, false);
  assert.throws(() => f.domain.captureForView({ conversationId: dm }), code('INNER_CONVERSATION_INACTIVE'));
  assert.throws(() => f.domain.readBodies({ capture: f.domain.captureForView({ conversationId: group }), recordIds: [written.record.recordId] }), code('INNER_BODY_FORBIDDEN'));
});

test('reads and captures are pure; a new installation generation invalidates pinned captures', t => {
  const f = fixture(t), entity = f.subject('person-1').record.entityId;
  f.assertFact('read-purity', dm, entity, [f.observation()]);
  const before = Number(f.db.prepare('SELECT total_changes() AS n').get()!.n);
  const capture = f.domain.captureForView({ conversationId: dm });
  for (let i = 0; i < 20; i++) {
    const metadata = f.domain.captureForView({ conversationId: dm });
    f.domain.validateForView({ capture: metadata });
    f.domain.readBodies({ capture: metadata, recordIds: metadata.records.map(record => record.recordId) });
    f.domain.resolveSubject({ entityId: entity });
  }
  assert.equal(Number(f.db.prepare('SELECT total_changes() AS n').get()!.n), before);
  f.close(); const restored = f.open();
  assert.deepEqual(restored.domain.validateForView({ capture }), capture);
  const other = new RelationshipDomain(restored.db, restored.tx, { runtimeIdentity: { hostEpoch: 'new-host', installationGeneration: 'other-install' },
    now: () => new Date(start), resolveConversation: id => f.conversations.get(id), resolveEvidence: ref => f.evidence.get(`${ref.kind}:${ref.sourceId}@${ref.revision}`) });
  assert.throws(() => other.validateForView({ capture }), code('INNER_CAPTURE_INVALIDATED'));
});

test('missing or partial authority metadata fails closed instead of rebuilding empty state', t => {
  const f = fixture(t);
  f.subject('person-1'); f.db.exec('DELETE FROM shiyu_relationship_meta');
  assert.throws(() => f.domain.captureForView({ conversationId: dm }), code('CORRUPT_INNER_DOMAIN'));
  assert.throws(() => new RelationshipDomain(f.db, f.tx, { runtimeIdentity: { hostEpoch: 'h', installationGeneration: 'i' }, now: () => new Date(start), resolveConversation: id => f.conversations.get(id) }), code('CORRUPT_INNER_DOMAIN'));
  assert.equal(Number(f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name LIKE 'shiyu_relationship_%'").get()!.n) >= 1, true);
});

test('the record store holds no conversation or memory body copy', t => {
  const f = fixture(t), entity = f.subject('person-1').record.entityId;
  f.assertFact('no-body-copy', dm, entity, [f.observation()]);
  const tables = f.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'shiyu_relationship_%'").all() as { name: string }[];
  for (const table of tables) {
    assert.equal(JSON.stringify(f.db.prepare(`SELECT * FROM ${table.name}`).all()).includes('message-exchange') && table.name.endsWith('_records'), false);
  }
  const captures = JSON.stringify(f.domain.captureForView({ conversationId: dm }));
  assert.equal(captures.includes('message-exchange'), false);
});

test('role and membership predicates require explicit entity objects and never imply authority', t => {
  const f = fixture(t), person = f.subject('person-1').record.entityId, organisation = f.subject('org-1').record.entityId;
  const membership = f.assertFact('membership', dm, person, [f.observation()], { predicate: 'member-of', objectId: organisation, value: undefined });
  assert.throws(() => f.assertFact('membership-no-object', dm, person, [f.observation()], { predicate: 'member-of' }), code('INVALID_RELATIONSHIP_PAYLOAD'));
  assert.throws(() => f.assertFact('membership-value', dm, person, [f.observation()], { predicate: 'member-of', objectId: organisation, value: 'admin' }), code('INVALID_RELATIONSHIP_PAYLOAD'));
  const capture = f.domain.captureForView({ conversationId: dm });
  const body = f.domain.readBodies({ capture, recordIds: [membership.record.recordId] }).bodies[0]!.payload as Record<string, unknown>;
  assert.equal(body.predicate, 'member-of'); assert.equal(body.objectId, organisation);
  assert.deepEqual(Object.keys(body).sort(), ['assertionId', 'epistemicStatus', 'kind', 'objectId', 'predicate', 'subjectId']);
});

test('two independently managed connections revise one assertion with exactly one CAS winner', async t => {
  const f = fixture(t), entity = f.subject('person-1').record.entityId;
  const first = f.assertFact('race-target', dm, entity, [f.observation()]);
  const command = (requestId: string) => ({ requestId, conversationId: dm, assertionId: first.record.assertionId, expectedRevision: 1,
    predicate: 'interaction', value: 'call', sourceRefs: [f.observation()] });
  const source = `const {parentPort,workerData}=require('node:worker_threads');(async()=>{
    const {tsImport}=await import('tsx/esm/api'); const {DatabaseSync}=await import('node:sqlite');
    const {SqliteTransactions}=await tsImport(workerData.tx,workerData.base);
    const {RelationshipDomain}=await tsImport(workerData.domain,workerData.base);
    const db=new DatabaseSync(workerData.filename); db.exec('PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL');
    const facts=(id)=>({audience:{scope:'local-owner',kind:'direct',audienceId:id},revision:1,audienceVersion:1,active:true});
    const domain=new RelationshipDomain(db,new SqliteTransactions(db),{runtimeIdentity:{hostEpoch:'race-host',installationGeneration:'inner-install'},resolveConversation:(id)=>facts(id)});
    parentPort.once('message',()=>{try{const value=domain.reviseAssertion(workerData.command);parentPort.postMessage({ok:true,revision:value.record.revision});}
      catch(error){parentPort.postMessage({ok:false,code:error.code});}finally{db.close();parentPort.close();}});
    parentPort.postMessage({ready:true});
  })().catch(error=>{parentPort.postMessage({error:String(error)});process.exitCode=1;});`;
  const workers = ['race-a', 'race-b'].map(requestId => new Worker(source, { eval: true, workerData: {
    filename: f.filename, command: command(requestId), base: import.meta.url,
    tx: new URL('../src/adapters/control-store/transaction.ts', import.meta.url).href,
    domain: new URL('../src/adapters/control-store/relationship-domain.ts', import.meta.url).href,
  } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
    worker.once('error', reject); worker.once('message', value => value.ready ? resolve() : reject(new Error(String(value.error))));
  })));
  const results = await Promise.all(workers.map(worker => new Promise<{ ok: boolean; revision?: number; code?: string }>((resolve, reject) => {
    worker.once('error', reject); worker.once('message', resolve); worker.postMessage('revise');
  })));
  assert.equal(results.filter(value => value.ok).length, 1);
  assert.equal(results.filter(value => !value.ok && value.code === 'INNER_RECORD_CONFLICT').length, 1);
  assert.equal(f.domain.captureForView({ conversationId: dm }).records.filter(record => record.recordId.startsWith(`assertion:${first.record.assertionId}:`)).length, 1);
  assert.equal(f.domain.captureForView({ conversationId: dm }).records.find(record => record.recordId.startsWith(`assertion:${first.record.assertionId}:`))!.revision, 2);
});
