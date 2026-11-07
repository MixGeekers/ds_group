import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateJsonSchemaValue, ToolArgsError } from '@deepseek-ai/dsh-tools';
import { installNativeMemory } from '../memory/native.mjs';

// Use the actual pinned DSH defineTool compiler, not a local JSON Schema mock.
test('native memory installs with DSH value schemas and enforces every basis reference field', async () => {
  const home = await mkdtemp(join(tmpdir(), 'memory-schema-host-'));
  const cleanups = [];
  const rt = { home, config: { memoryReview: false }, teamTools: [], ctx: {
    on() {}, systemPrompt: { section: () => () => {} },
    effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
  } };
  try {
    installNativeMemory(rt);
    const remember = rt.teamTools.find(tool => tool.name === 'remember');
    const schema = remember.parameters.properties.basisRefs.items;
    assert.deepEqual(schema.required, ['id', 'revision']);
    assert.equal(schema.properties.revision.type, 'integer');
    const valid = { text: 'derived draft', basisRefs: [{ id: 'memory_current', revision: 2 }] };
    assert.deepEqual(validateJsonSchemaValue(remember.parameters, valid), []);
    for (const ref of [{}, { id: 'memory_current' }, { revision: 2 }, { id: 'memory_current', revision: 1.5 }, { id: 'memory_current', revision: 2, extra: true }]) {
      const args = { text: 'derived draft', basisRefs: [ref] };
      assert.ok(validateJsonSchemaValue(remember.parameters, args).length);
      await assert.rejects(remember.execute(args, {}), error => error instanceof ToolArgsError);
    }
    assert.ok(rt.teamTools.some(tool => tool.name === 'review_memory'));
    assert.ok(rt.teamTools.some(tool => tool.name === 'memory_source'));
    const raw = rt.teamTools.find(tool => tool.name === 'raw_source_query');
    assert.ok(raw);
    assert.deepEqual(raw.parameters.required, ['query']);
    assert.deepEqual(validateJsonSchemaValue(raw.parameters, { query: 'project-file.json', limit: 3, includeDirect: true }), []);
    await assert.rejects(raw.execute({ query: 'project-file.json', limit: 1.5 }, {}), error => error instanceof ToolArgsError);
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(home, { recursive: true });
  }
});

test('a background flush leaves reserved-only sources unreviewed and returns without a model loop', async () => {
  const home = await mkdtemp(join(tmpdir(), 'memory-reserved-flush-')), cleanups = [];
  let models = 0, agentLookups = 0;
  const rt = { home, config: { memoryReview: false }, teamTools: [], botOf: id => id === 'a' ? { id } : null,
    resolveAgent: async () => { agentLookups++; throw new Error('Blocked-only review must not wait for or resolve an Agent'); },
    ctx: { on() {}, systemPrompt: { section: () => () => {} }, llm: { stream: () => { models++; throw new Error('No model call expected'); } },
      effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') cleanups.push(cleanup); } } };
  try {
    installNativeMemory(rt);
    const receipt = rt.memoryObserve('a', { event: { eventId: '$queued', roomId: '!project:test', senderId: '@alice:test', body: 'Later work' } },
      { sourceDispositions: { '$queued': { kind: 'pending-request' } } });
    await rt.memoryFlush('a');
    assert.equal(models, 0); assert.equal(agentLookups, 0);
    assert.equal(rt.knowledge.store.getMeta('unreviewed:a').length, 1);
    assert.equal(rt.knowledge.store.getMeta(`reviewed:a:${receipt.sourceRefs[0].id}:1`), undefined);
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(home, { recursive: true }); }
});
