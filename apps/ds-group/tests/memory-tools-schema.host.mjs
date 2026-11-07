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
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(home, { recursive: true });
  }
});
