import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryService } from '../memory/service.mjs';
import { persistedNaturalMemoryEvidence, verifyNaturalMemoryPersistence, compactMemoryHost, naturalMaintenancePolicy } from '../scripts/platform-natural-memory.mjs';
import { NaturalLiveAdapter } from '../scripts/platform-natural-live.mjs';
import { definitionFor, runNaturalScenario } from '../scripts/platform-natural-run.mjs';

const bots = [0, 1, 2].map(i => ({ id: `native-${i}`, sessionId: `session-${i}` }));
async function directoryFor(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'natural-memory-maintenance-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
const input = n => ({ event: { eventId: `$event-${n}`, body: `A colleague's ordinary message ${n}`, roomId: '!room:synthetic', senderId: '@human:synthetic' } });
async function seeded(t) {
  const directory = await directoryFor(t), memory = new MemoryService({ directory });
  memory.observe(bots[0].id, [input(1), input(2)]);
  t.after(() => memory.close()); return { memory, directory };
}

test('observation snapshot is read-only and keeps unreviewed sources visibly pending', async t => {
  const { memory } = await seeded(t), beforeJournal = memory.store.history().length;
  const snapshot = persistedNaturalMemoryEvidence(memory.store, bots), bot = snapshot.bots[0];
  assert.equal(memory.store.history().length, beforeJournal);
  assert.equal(bot.watermarks.receivedThrough, 2); assert.equal(bot.watermarks.reviewedThrough, 0);
  assert.equal(bot.pendingReviewCount, 2); assert.equal(bot.pendingCountMatchesWatermark, true);
  assert.ok(bot.sourceRefs.every(ref => ref.present && ref.digestVerified && !ref.reviewed));
  assert.equal(JSON.stringify(snapshot).includes('ordinary message'), false);
});

test('actual SQLite close/reopen preserves source revisions, digests, watermarks and pending refs', async t => {
  const directory = await directoryFor(t), memory = new MemoryService({ directory });
  memory.observe(bots[0].id, [input(1), input(2)]);
  const before = persistedNaturalMemoryEvidence(memory.store, bots); await memory.close();
  const reopened = new MemoryService({ directory }); t.after(() => reopened.close());
  const after = persistedNaturalMemoryEvidence(reopened.store, bots), check = verifyNaturalMemoryPersistence(before, after);
  assert.equal(check.passed, true); assert.equal(after.bots[0].pendingReviewCount, 2);
  assert.ok(check.perBot[0].pendingTransitions.every(ref => ref.state === 'still-pending'));
});

test('discarding pending work without reviewed evidence fails even when sources remain', async t => {
  const { memory } = await seeded(t), before = persistedNaturalMemoryEvidence(memory.store, bots);
  memory.store.setMeta(`unreviewed:${bots[0].id}`, []);
  const check = verifyNaturalMemoryPersistence(before, persistedNaturalMemoryEvidence(memory.store, bots));
  assert.equal(check.observedSourceRefsPreserved, true); assert.equal(check.pendingReviewWorkPreserved, false); assert.equal(check.passed, false);
});

test('a real persisted review marker distinguishes a settled pending ref from lost work', async t => {
  const { memory } = await seeded(t), before = persistedNaturalMemoryEvidence(memory.store, bots);
  const [first, second] = before.bots[0].pendingReviewRefs;
  memory.store.setMeta(`reviewed:${bots[0].id}:${first.id}:${first.revision}`, true);
  memory.store.setMeta(`unreviewed:${bots[0].id}`, [second]);
  const check = verifyNaturalMemoryPersistence(before, persistedNaturalMemoryEvidence(memory.store, bots));
  assert.equal(check.passed, true); assert.deepEqual(check.perBot[0].pendingTransitions.map(ref => ref.state), ['reviewed', 'still-pending']);
});

test('withdrawal invalidates pending review without falsely marking it reviewed', async t => {
  const { memory } = await seeded(t), before = persistedNaturalMemoryEvidence(memory.store, bots);
  memory.store.retractSource(before.bots[0].pendingReviewRefs[0].id);
  const check = verifyNaturalMemoryPersistence(before, persistedNaturalMemoryEvidence(memory.store, bots));
  assert.equal(check.passed, true); assert.deepEqual(check.perBot[0].pendingTransitions.map(ref => ref.state), ['invalidated', 'still-pending']);
});

test('losing a source head cannot masquerade as a legitimate pending invalidation', async t => {
  const { memory } = await seeded(t), before = persistedNaturalMemoryEvidence(memory.store, bots);
  memory.store.db.prepare('DELETE FROM source_heads WHERE id=?').run(before.bots[0].pendingReviewRefs[0].id);
  const check = verifyNaturalMemoryPersistence(before, persistedNaturalMemoryEvidence(memory.store, bots));
  assert.equal(check.sourceIntegrityPassed, false); assert.equal(check.pendingReviewWorkPreserved, false); assert.equal(check.passed, false);
});

test('source replacement and native Session changes cannot pass a persistence check', async t => {
  const { memory } = await seeded(t), before = persistedNaturalMemoryEvidence(memory.store, bots);
  const changed = structuredClone(before); changed.bots[0].sourceRefs[0].digest = 'different'; changed.bots[0].sessionId = 'other';
  const check = verifyNaturalMemoryPersistence(before, changed);
  assert.equal(check.observedSourceRefsPreserved, false); assert.equal(check.sessionsPreserved, false); assert.equal(check.passed, false);
  assert.equal(verifyNaturalMemoryPersistence({ readOnly: true, bots: [] }, { readOnly: true, bots: [] }).passed, false);
});

test('visible-host checkpoint defaults remain unchanged and explicit false calls only native checkpoint', async () => {
  const calls = [], native = { state: async () => ({ bots }), bot: async id => bots.find(b => b.id === id) };
  const rt = { memoryFlush: async id => calls.push(['review', id]), checkpointBot: async id => { calls.push(['checkpoint', id]); return true; } };
  assert.equal((await compactMemoryHost(rt, native, { index: 1 })).compacted, true);
  assert.deepEqual(calls, [['review', 'native-1'], ['checkpoint', 'native-1']]); calls.length = 0;
  assert.equal((await compactMemoryHost(rt, native, { index: 2, settleMemory: false })).compacted, true);
  assert.deepEqual(calls, [['checkpoint', 'native-2']]);
});

// Real runner and live-adapter maintenance, with actual SQLite persistence and
// scripted checkpoint acknowledgements. This is deliberately not model/native
// checkpoint acceptance; the resumed real run must supply those receipts.
class LocalObservationAdapter extends NaturalLiveAdapter {
  constructor(directory, definition, { failAt64 = false } = {}) {
    super({ directory, environment: {}, corpus: definition.corpus, corpusHash: definition.corpusHash });
    this.evidenceLevel = 'synthetic-zero-model-maintenance-check'; this.posts = []; this.failAt64 = failAt64;
    this.bots = bots.map((bot, i) => ({ ...bot, id: `@bot-${i}:synthetic`, nativeBotId: bot.id }));
    const databaseDirectory = path.join(directory, 'knowledge');
    this.host = { actions: [], checkpointInputs: [], memory: null,
      async start() { this.memory = new MemoryService({ directory: databaseDirectory }); },
      async stop() { if (this.memory) { await this.memory.close(); this.memory = null; } },
      async api(action, value = {}) {
        this.actions.push(action);
        if (action === 'state') return { bots };
        if (action === 'memory-observations') return persistedNaturalMemoryEvidence(this.memory.store, bots);
        if (action === 'compact') {
          this.checkpointInputs.push(value);
          return compactMemoryHost({ memoryFlush: async () => { throw new Error('Unexpected model review'); }, checkpointBot: async () => true },
            { state: async () => ({ bots }), bot: async id => bots.find(b => b.id === id) }, value);
        }
        if (['connect', 'disconnect', 'init'].includes(action)) return true;
        throw new Error(`Unexpected host action ${action} in maintenance check`);
      } };
  }
  async initialize() { await this.host.start(); return { bots: this.bots, model: 'none' }; }
  async saveHostState() {}
  async post(step) {
    this.posts.push(step.id);
    const n = this.corpus.steps.findIndex(s => s.id === step.id) + 1;
    for (const bot of bots) this.host.memory.observe(bot.id, { event: { ...input(n).event, body: step.body } });
    const value = { eventId: `$event-${n}`, roomId: step.room, senderId: '@human:synthetic', botId: step.bot === null ? null : this.bots[step.bot].id, requestId: `request-${step.id}`, postedAt: Date.now() };
    this.requests.set(step.id, { ...value, step }); return value;
  }
  async inspectTarget(kind, targetId) { return { kind, targetId, requestId: `request-${targetId}`, observedStatus: 'running', observedActive: true, observedAt: Date.now() }; }
  async control(_kind, _target, observed) { return { ...observed, completedAt: Date.now() }; }
  async waitStarted() { return { observedActive: true, status: 'running', receipt: { status: 'running' } }; }
  async waitReply() { return { receipt: { status: 'completed' }, delivered: [] }; }
  async settle() { return { delivered: [], receipt: null }; }
  async capture() { return []; }
  async quiet() { return null; }
  async downloads() { return []; }
  async protocolEvents() { return []; }
  async compact(index) {
    if (this.failAt64 && this.posts.length === 64) throw Object.assign(new Error('Prior maintenance timeout'), { code: 'ETIMEDOUT' });
    return super.compact(index);
  }
  async finalize() { return { calls: [], decisions: [], memoryPersistence: await this.memoryEvidence('final-observation') }; }
  async close() { await this.host.stop(); }
}

test('resume at64 keeps two maintenance boundaries, pending SQLite work and avoids all flush calls including final', async t => {
  const directory = await directoryFor(t), definition = definitionFor('full'), first = new LocalObservationAdapter(directory, definition, { failAt64: true });
  first.maintenancePolicy = undefined; // An older attempt had no policy record.
  const partial = await runNaturalScenario({ definition, directory, adapter: first });
  assert.equal(partial.status, 'failed'); assert.equal(partial.rows.length, 64); assert.equal(partial.error.code, 'ETIMEDOUT');
  const oldAttempt = JSON.stringify(partial.attempts[0]);
  const second = new LocalObservationAdapter(directory, definition), resumed = await runNaturalScenario({ definition, directory, adapter: second, resume: true });
  assert.equal(resumed.rows.length, 96); assert.equal(second.posts.length, 32);
  assert.equal(JSON.stringify(resumed.attempts[0]), oldAttempt); assert.deepEqual(resumed.attempts[1].maintenancePolicy, naturalMaintenancePolicy);
  assert.equal(resumed.definitionHash, partial.definitionHash);
  assert.deepEqual(resumed.maintenance.filter(r => r.type === 'native-compaction').map(r => r.after), [32, 64]);
  assert.deepEqual(resumed.maintenance.filter(r => r.type === 'native-restart').map(r => r.after), [36, 72]);
  assert.ok(resumed.maintenance.filter(r => ['native-compaction', 'native-restart'].includes(r.type)).every(r => (r.result || r).memoryPersistence.verification.passed));
  assert.deepEqual(second.host.checkpointInputs, [{ index: definition.corpus.maintenance.compactions.find(item => item.after === 64).bot, settleMemory: false }]);
  assert.equal([...first.host.actions, ...second.host.actions].includes('flush'), false);
  assert.ok(resumed.final.memoryPersistence.bots.every(bot => bot.pendingReviewCount === 96 && bot.watermarks.reviewedThrough === 0));
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'frozen-definition.json'), 'utf8')).definitionHash, definition.definitionHash);
});
