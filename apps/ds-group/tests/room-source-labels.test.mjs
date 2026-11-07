import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { speakerOf, messageSource, observedMemoryInput, conversationContext } from '../src/message-context.mjs';
import { MemoryService } from '../memory/service.mjs';
import { sourceId } from '../memory/store.mjs';
import { NativeConnections } from '../dsh-connect/native-connections.mjs';
import { NativeBridge } from '../dsh-connect/native-bridge.mjs';

const alice = { id: '@zhou:home.test', name: '周宁', kind: 'human' };
const other = { id: '@zhou:else.test', name: '周宁', kind: 'human' };
const bot = { id: '@bot:home.test', name: '小雨', kind: 'bot', ownerId: alice.id };
const people = [alice, other, bot];
const event = (id, sender = alice.id, room = '!work:test', at = 1000) => ({ type: 'm.room.message', event_id: id,
  room_id: room, sender, origin_server_ts: at, content: { body: id } });
const room = (name, eventId = '$rename', at = 2000) => ({ id: '!work:test', name: '工作群', members: [alice.id, other.id, bot.id],
  memberProfiles: { [alice.id]: { id: alice.id, displayname: name, membership: 'join', eventId, observedAt: at + 1,
    eventTimestamp: at, observedSequence: 1, source: 'matrix-member-state' } } });

test('a room rename changes the label of its exact account and cannot supply kind or ownership', () => {
  const renamed = room('阿宁');
  Object.assign(renamed.memberProfiles[alice.id], { id: other.id, kind: 'bot', ownerId: other.id });
  const person = speakerOf(alice.id, people, renamed);
  assert.equal(person.id, alice.id);
  assert.equal(person.name, '阿宁');
  assert.equal(person.kind, 'human');
  assert.equal(person.ownerId, undefined);
  assert.equal(person.identitySource, 'account-directory');
  assert.equal(person.nameSource, 'matrix-member-state');
  assert.equal(person.nameEventId, '$rename');
  assert.equal(person.nameObservedAt, 2001);
  assert.equal(person.nameEventTimestamp, 2000);
  assert.equal(speakerOf(other.id, people, renamed).name, '周宁');
  assert.equal(speakerOf(alice.id, people, room(null)).name, alice.id, 'explicit removal must not restore a stale global name');
  assert.equal(speakerOf(alice.id, people, room('   ')).name, alice.id);
  const fallback = room('阿宁'); fallback.memberProfiles[alice.id].source = 'room-directory';
  assert.equal(speakerOf(alice.id, people, fallback).nameSource, 'room-directory');
  assert.equal(alice.name, '周宁');
});

test('observed source labels stay in their room while stable source IDs ignore labels', () => {
  const current = event('$current');
  const a = observedMemoryInput(current, people, room('阿宁'));
  const b = observedMemoryInput({ ...current, room_id: '!chat:test' }, people, { ...room('宁宁'), id: '!chat:test' });
  assert.equal(a.context.source.sender.name, '阿宁');
  assert.equal(b.context.source.sender.name, '宁宁');
  assert.equal(a.context.source.sender.id, b.context.source.sender.id);
  assert.equal(a.context.members.find(person => person.id === alice.id).name, '阿宁');
  assert.equal(a.context.members.find(person => person.id === bot.id).ownerId, alice.id);
  assert.equal(sourceId(a.context.source.transport, current.room_id, current.event_id), sourceId('matrix', current.room_id, current.event_id));
  assert.equal(messageSource(current, people, room('另一个标签')).eventId, a.context.source.eventId);
});

test('current membership and per-event source snapshots are separate for a renamed speaker and an old quote', () => {
  const anchor = event('$anchor', alice.id, '!work:test', 1500);
  anchor.content['org.ds_group'] = { replyTo: '$reply' };
  anchor.content['m.relates_to'] = { rel_type: 'm.thread', event_id: '$root' };
  const before = room('周宁', '$join', 900), after = room('阿宁');
  const replyRoom = { ...before, memberProfiles: { ...before.memberProfiles, [other.id]: { displayname: '另一个周宁', eventId: '$other-label' } } };
  const context = conversationContext({ event: anchor, participants: people, room: after, sourceRoom: before,
    reply: event('$reply', other.id), replyRoom, threadRoot: event('$root'), threadRootRoom: before });
  assert.equal(context.source.sender.name, '周宁');
  assert.equal(context.source.sender.nameEventId, '$join');
  assert.equal(context.members.find(person => person.id === alice.id).name, '阿宁');
  assert.equal(context.reply.source.sender.name, '另一个周宁');
  assert.equal(context.reply.source.sender.id, other.id);
  assert.equal(context.threadRoot.source.sender.name, '周宁');
  assert.equal(context.threadRoot.source.sender.id, alice.id);
});

test('native observation retains before/after rename snapshots, aliases and same-name identities with a stale global directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'room-label-observe-'));
  const memory = new MemoryService({ directory });
  const captured = [];
  const native = { call: async (operation, payload) => {
    assert.equal(operation, 'observe');
    captured.push(payload);
    return memory.observe(payload.botId, payload.inputs, payload.options);
  } };
  const bridge = new NativeBridge({ ctx: {}, native, node: { directory, id: bot.id, nativeBotId: 'native-a' } });
  const connections = new NativeConnections({ ctx: {}, native });
  const before = room('周宁', '$join', 900), after = room('阿宁');
  const botNode = { participants: people, store: { roomContext: () => after } };
  try {
    const old = event('$before'), current = event('$after', alice.id, '!work:test', 3000);
    const chat = event('$chat', alice.id, '!chat:test', 3500);
    const sameName = event('$other', other.id, '!work:test', 4000);
    const otherSnapshot = { ...after, memberProfiles: { ...after.memberProfiles, [other.id]: { displayname: '阿宁', source: 'matrix-member-state', eventId: '$other-rename' } } };
    await connections.observe({ bridge, botNode }, { events: [old, current, chat, sameName], cursor: 'sync-1', watermark: { sequence: 4 },
      rooms: { '!work:test': after, '!chat:test': { ...room('宁宁'), id: '!chat:test' } },
      eventRooms: { '$before': before, '$after': after, '$other': otherSnapshot } });
    assert.deepEqual(captured[0].inputs.map(input => input.context.source.sender.name), ['周宁', '阿宁', '宁宁', '阿宁']);
    assert.equal(captured[0].inputs[2].context.source.roomId, '!chat:test');
    const first = memory.store.source(sourceId('matrix', '!work:test', '$before'));
    assert.equal(first.authorId, 'matrix:@zhou:home.test');
    assert.equal(memory.store.getContact('matrix:@zhou:home.test').aliases.includes('阿宁'), true);
    assert.equal(memory.store.getContact('matrix:@zhou:home.test').aliases.includes('周宁'), true);
    assert.equal(memory.store.getContact('matrix:@zhou:home.test').aliases.includes('宁宁'), true);
    assert.equal(memory.store.contacts('阿宁').filter(person => person.kind === 'human').length, 2);
    assert.notEqual(memory.store.getContact('matrix:@zhou:home.test').id, memory.store.getContact('matrix:@zhou:else.test').id);
    const duplicate = await connections.observe({ bridge, botNode }, { events: [old], watermark: { sequence: 5 },
      rooms: { '!work:test': after }, eventRooms: { '$before': before } });
    assert.equal(duplicate.sourceRefs[0].id, first.id);
    assert.equal(memory.store.source(first.id).revision, 1);
    assert.equal(alice.name, '周宁');
  } finally { await memory.close(); await rm(directory, { recursive: true }); }
});
