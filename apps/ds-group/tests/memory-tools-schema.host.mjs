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

const contactBoundaryInput = (eventId, senderId, name, roomId, roomName, timestamp = 100) => ({
  event: { eventId, senderId, roomId, body: '本房间的普通讨论。', timestamp },
  context: { room: { id: roomId, name: roomName, kind: 'direct' }, source: { transport: 'matrix', eventId, roomId,
    sender: { id: senderId, name, kind: 'human' }, timestamp } },
});

test('review input and the actual contacts tool omit a stranger and aliases known only to another Bot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'memory-contact-boundary-')), cleanups = [], captured = [];
  const bots = new Set(['a', 'b']);
  const rt = { home, config: { memoryReview: false }, teamTools: [], selfOf: id => id, botOf: id => bots.has(id) ? { id } : null,
    desiredModel: async () => 'capture/local', defaultModel: async () => 'capture/local', chatOf: id => id,
    resolveAgent: async () => ({ whenIdle: async () => {} }), warn() {},
    ctx: { on() {}, systemPrompt: { section: () => () => {} },
      effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
      llm: { resolveModelInfo: async () => ({}), async *stream(options) {
        // Capture the actual prepared request, then stop before any provider.
        captured.push(JSON.parse(options.messages[0].content[0].text));
        throw new Error('REVIEW_CAPTURE_STOP');
      } } } };
  try {
    installNativeMemory(rt);
    rt.memoryObserve('a', contactBoundaryInput('$private-old', '@stranger:test', '私聊旧称', '!a-private:test', '仅A知道的房名', 100));
    rt.memoryObserve('a', contactBoundaryInput('$private-new', '@stranger:test', '私聊新称', '!a-private:test', '仅A知道的房名', 200));
    rt.memoryObserve('b', contactBoundaryInput('$b-discussion', '@bob:test', 'Bob', '!b-room:test', 'B的独立房间', 300));
    await assert.rejects(rt.memoryFlush('b'), /REVIEW_CAPTURE_STOP/);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].botId, 'b');
    assert.equal(captured[0].sources.length, 1);
    assert.equal(captured[0].contacts.find(contact => contact.id === 'matrix:@stranger:test'), undefined);
    assert.equal(JSON.stringify(captured[0]).includes('私聊旧称'), false);
    assert.equal(JSON.stringify(captured[0]).includes('私聊新称'), false);
    assert.equal(JSON.stringify(captured[0]).includes('仅A知道的房名'), false);
    assert.ok(captured[0].contacts.some(contact => contact.id === 'matrix:@bob:test' && contact.name === 'Bob'));
    const contacts = rt.teamTools.find(tool => tool.name === 'contacts');
    const bContacts = JSON.parse(await contacts.execute({ history: true }, { agent: { id: 'b' } }));
    assert.equal(bContacts.some(contact => contact.id === 'matrix:@stranger:test'), false);
    const aContacts = JSON.parse(await contacts.execute({}, { agent: { id: 'a' } }));
    assert.deepEqual(aContacts.find(contact => contact.id === 'matrix:@stranger:test').aliases, ['私聊旧称', '私聊新称']);
    assert.ok(rt.knowledge.store.getContact('matrix:@stranger:test'));
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(home, { recursive: true }); }
});
