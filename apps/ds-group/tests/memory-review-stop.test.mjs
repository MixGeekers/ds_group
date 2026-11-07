import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from '../memory/service.mjs';

test('review cancellation while staging an external body cannot publish the fact or acknowledge its source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-review-stage-stop-')), memory = new MemoryService({ directory });
  let staged, release;
  const began = new Promise(resolve => { staged = resolve; }), receipt = new Promise(resolve => { release = resolve; });
  memory.backend = { async save(row) { staged(); await receipt; return { bodyDigest: row.bodyDigest, bodyDurable: true }; },
    async index() { throw new Error('Cancelled fact cannot be indexed'); }, async close() {} };
  try {
    const current = memory.ingest('a', { event: { eventId: '$source', senderId: '@alice:test', roomId: '!project:test', body: 'Actual original', timestamp: 100 } }, { sessionId: 's' });
    const ref = current.sourceRefs[0], source = memory.store.source(ref.id);
    const controller = new AbortController();
    const work = memory.applyReview('a', { sources: [source], existingMemories: [] }, [{ op: 'add', text: 'Proposed durable fact',
      subjectId: source.authorId, predicate: 'staged-fact', scope: 'room:!project:test', sourceIds: [ref.id] }], { signal: controller.signal });
    const rejected = assert.rejects(work, /Review stopped/);
    await began; controller.abort(new Error('Review stopped')); release(); await rejected;
    assert.equal(memory.store.list({ botId: 'a' }).length, 0);
    assert.deepEqual(memory.store.getMeta('unreviewed:a'), [ref]);
    assert.equal(memory.store.getMeta(`reviewed:a:${ref.id}:1`), undefined);
    assert.equal(memory.readSource('a', ref).body, 'Actual original');
  } finally { release(); await memory.close(); await rm(directory, { recursive: true }); }
});
