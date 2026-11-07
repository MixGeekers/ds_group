import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from '../memory/service.mjs';

const input = (eventId, senderId, name, roomId, { timestamp = 100, members = [] } = {}) => ({
  event: { eventId, senderId, roomId, body: '普通讨论。', timestamp }, context: { room: { id: roomId, name: `Room ${roomId}` }, members,
    source: { transport: 'matrix', eventId, roomId, sender: { id: senderId, name, kind: 'human' }, timestamp } },
});
async function withMemory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'memory-contact-scope-')), memory = new MemoryService({ directory });
  try { await run(memory, directory); } finally { await memory.close(); await rm(directory, { recursive: true }); }
}

test('contact discovery excludes another Bot strangers and private rooms without deleting their shared identity registration', async () => withMemory(async memory => {
  memory.observe('a', input('$a', '@stranger:test', 'A-only alias', '!a-private:test'));
  memory.ingest('b', input('$b', '@bob:test', 'Bob', '!b:test'), { sessionId: 'b-session' });
  const before = memory.store.watermarks('b'), global = memory.store.contacts();
  assert.ok(global.some(contact => contact.id === 'matrix:@stranger:test'));
  const contacts = memory.contacts('b', { history: true });
  assert.equal(contacts.some(contact => contact.id === 'matrix:@stranger:test' || contact.id === 'matrix:!a-private:test'), false);
  assert.equal(JSON.stringify(contacts).includes('A-only alias'), false);
  assert.deepEqual(memory.store.contacts(), global);
  assert.deepEqual(memory.store.watermarks('b'), before);
  assert.throws(() => memory.contacts(undefined), /MEMORY_BOT_REQUIRED/);
}));

test('an already known shared account does not acquire another Bot private nickname through contacts, people or profiles', async () => withMemory(async memory => {
  const id = '@same:test';
  memory.ingest('b', input('$b', id, 'B-known label', '!b:test'), { sessionId: 'b-session' });
  memory.observe('a', input('$a', id, 'A-private label', '!a-private:test', { timestamp: 200 }));
  assert.equal(memory.store.getContact(`matrix:${id}`).name, 'A-private label');
  const contact = memory.contacts('b').find(contact => contact.id === `matrix:${id}`);
  assert.equal(contact.name, 'B-known label'); assert.deepEqual(contact.aliases, ['B-known label']);
  assert.deepEqual(memory.contacts('b', { query: 'A-private label' }), []);
  const view = memory.contextSnapshot('b', 'b-session');
  assert.equal(view.speaker.name, 'B-known label');
  assert.equal(view.people.find(person => person.id === `matrix:${id}`).name, 'B-known label');
  const profile = memory.profile('b', { kind: 'person', id });
  assert.equal(profile.identity.name, 'B-known label');
  assert.equal(JSON.stringify(profile).includes('A-private label'), false);
}));

test('current room members and legally shared source identities remain discoverable with exact source aliases', async () => withMemory(async memory => {
  memory.ingest('b', input('$members', '@bob:test', 'Bob', '!b:test', { members: [{ id: '@silent:test', name: 'Silent member', kind: 'human' }] }), { sessionId: 'b-session' });
  assert.ok(memory.contacts('b').some(contact => contact.id === 'matrix:@silent:test' && contact.name === 'Silent member'));
  memory.ingest('a', input('$shared-origin', '@author:test', 'Shared-source name', '!a:test'), { sessionId: 'a-session' });
  await memory.remember('a', { text: '明确共享的协作联系人事实', scope: 'team', subjectId: '@author:test', predicate: 'shared-role' });
  memory.observe('a', input('$later-private', '@author:test', 'Unshared later alias', '!a-private:test', { timestamp: 200 }));
  const author = memory.contacts('b').find(contact => contact.id === 'matrix:@author:test');
  assert.equal(author.name, 'Shared-source name'); assert.deepEqual(author.aliases, ['Shared-source name']);
  assert.equal(JSON.stringify(memory.contacts('b', { history: true })).includes('Unshared later alias'), false);
}));

test('a legal memory can establish an identity ID without exposing an unobserved registry name', async () => withMemory(async memory => {
  memory.observe('a', input('$private', '@mentioned:test', 'Unobserved private name', '!a-private:test'));
  memory.ingest('b', input('$b', '@bob:test', 'Bob', '!b:test'), { sessionId: 'b-session' });
  await memory.remember('b', { text: '已知该完整账号参与协作', subjectId: '@mentioned:test', predicate: 'collaborator' });
  const known = memory.contacts('b').find(contact => contact.id === 'matrix:@mentioned:test');
  assert.ok(known); assert.equal(known.name, known.id); assert.deepEqual(known.aliases, []);
  assert.equal(memory.profile('b', { kind: 'person', id: '@mentioned:test' }).identity.name, known.id);
}));

test('historical stores scope labels by exact observed transport, room and event rather than all aliases of a known account', async () => withMemory(async memory => {
  memory.ingest('b', input('$same-event', '@same:test', 'Old B label', '!b:test'), { sessionId: 'b-session' });
  memory.observe('a', input('$same-event', '@same:test', 'Private A label', '!a:test', { timestamp: 200 }));
  // Simulate a store created before the per-Bot identity projection existed.
  memory.store.db.prepare('DELETE FROM meta WHERE key LIKE ?').run('contact:%');
  const contact = memory.contacts('b', { history: true }).find(contact => contact.id === 'matrix:@same:test');
  assert.equal(contact.name, 'Old B label'); assert.deepEqual(contact.aliases, ['Old B label']);
  assert.equal(contact.observations.every(row => row.source.roomId === '!b:test'), true);
  assert.equal(JSON.stringify(memory.contextSnapshot('b', 'b-session')).includes('Private A label'), false);
}));

test('per-Bot aliases survive other Bot global history churn and restart without importing its private aliases', async () => withMemory(async (memory, directory) => {
  memory.observe('b', input('$first', '@same:test', 'Retained B label', '!b:test', { timestamp: 1 }));
  for (let index = 0; index < 105; index++) memory.observe('a', input(`$a-${index}`, '@same:test', `Private-${index}`, '!a:test', { timestamp: index + 2 }));
  assert.equal(memory.store.getContact('matrix:@same:test').observations.some(row => row.name === 'Retained B label'), false);
  const reopened = new MemoryService({ directory });
  try {
    const contact = reopened.contacts('b', { history: true }).find(contact => contact.id === 'matrix:@same:test');
    assert.equal(contact.name, 'Retained B label'); assert.deepEqual(contact.aliases, ['Retained B label']);
    assert.equal(JSON.stringify(contact).includes('Private-'), false);
  } finally { await reopened.close(); }
}));
