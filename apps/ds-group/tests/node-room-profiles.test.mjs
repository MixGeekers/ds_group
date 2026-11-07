import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../src/node-store.mjs';
import { BotNode } from '../src/bot-node.mjs';
import { createScriptDecisionProvider } from '../src/decision-provider.mjs';

const one = '!one:profiles.test', two = '!two:profiles.test';
const alice = { id: '@alice:profiles.test', name: 'Account Alice', kind: 'human' };
const bob = { id: '@bob:profiles.test', name: 'Account Bob', kind: 'human' };
const bot = { id: '@bot:profiles.test', localpart: 'bot', name: 'Bot', kind: 'bot' };
const people = [alice, bob, bot];
const member = (id, displayname, { roomId = one, person = alice.id, timestamp, membership = 'join' } = {}) => ({
  type: 'm.room.member', event_id: id, room_id: roomId, sender: person, state_key: person,
  ...(timestamp !== undefined ? { origin_server_ts: timestamp } : {}), content: { membership, displayname },
});
const message = (id, { roomId = one, sender = alice.id, timestamp, replyTo, thread } = {}) => ({
  type: 'm.room.message', event_id: id, room_id: roomId, sender,
  ...(timestamp !== undefined ? { origin_server_ts: timestamp } : {}),
  content: { body: '周末一起散步吧。', 'org.ds_group': { to: [bot.id], ...(replyTo ? { replyTo } : {}) },
    ...(thread ? { 'm.relates_to': { rel_type: 'm.thread', event_id: thread } } : {}) },
});

function fixture(t, options = {}) {
  const store = new NodeStore(options.filename || ':memory:', bot.id);
  t.after(() => { try { store.close(); } catch {} });
  const participants = structuredClone(people), observations = [], decisions = [];
  const node = new BotNode({ participant: participants[2], participants, roomId: one, store,
    matrix: options.matrix || {}, bridge: {}, heartbeat: async () => {}, onError: () => {},
    roster: { read: async () => ({ participants: structuredClone(people) }) }, work: options.work,
    attention: { mode: 'natural', batchMs: 0, coordinationMs: 0 },
    decisionProvider: createScriptDecisionProvider(input => { decisions.push(input); return { action: 'LISTEN' }; }),
    observe: async input => observations.push(input),
  });
  return { store, node, participants, observations, decisions };
}

test('member profiles retain full IDs, exact labels and a durable observation order', t => {
  const f = fixture(t);
  f.store.noteRoomState(one, [member('$alice-name', '小林', { timestamp: 10 }), member('$bob-name', '小林', { person: bob.id, timestamp: 11 })]);
  const room = f.store.roomContext(one);
  assert.deepEqual(room.members, [alice.id, bob.id]);
  assert.equal(room.memberProfiles[alice.id].id, alice.id);
  assert.equal(room.memberProfiles[bob.id].id, bob.id);
  assert.equal(room.memberProfiles[alice.id].displayname, '小林');
  assert.equal(room.memberProfiles[bob.id].displayname, '小林');
  assert(room.memberProfiles[bob.id].observedSequence > room.memberProfiles[alice.id].observedSequence);
  assert.equal(room.memberProfiles[alice.id].eventTimestamp, 10);
  assert.equal(room.memberProfiles[alice.id].eventId, '$alice-name');
  assert.equal(room.memberProfiles[alice.id].source, 'matrix-member-state');
  assert.equal(f.participants[0].name, 'Account Alice');
});

test('a replay or older backfilled membership event cannot undo the latest label or membership', t => {
  const f = fixture(t);
  const old = member('$old-label', '旧名字', { timestamp: 10 });
  const current = member('$new-label', '新名字', { timestamp: 30 });
  f.store.noteRoomState(one, [old, current]);
  const before = f.store.roomContext(one).memberProfiles[alice.id];
  f.store.noteRoomState(one, [old, member('$older-leave', '旧名字', { timestamp: 20, membership: 'leave' })]);
  assert.deepEqual(f.store.roomContext(one).memberProfiles[alice.id], before);
  assert(f.store.roomContext(one).members.includes(alice.id));
  f.store.noteRoomState(one, [member('$latest-leave', null, { timestamp: 40, membership: 'leave' }), old]);
  assert.equal(f.store.roomContext(one).members.includes(alice.id), false);
  assert.equal(f.store.roomContext(one).memberProfiles[alice.id].membership, 'leave');
});

test('messages in one timeline retain the label at their own source time through later renames', t => {
  const f = fixture(t);
  f.store.ingest([member('$before', '小林', { timestamp: 10 }), message('$old-message', { timestamp: 20 }),
    member('$rename', '阿林', { timestamp: 30 }), message('$new-message', { timestamp: 40 })]);
  assert.equal(f.store.roomContext(one).memberProfiles[alice.id].displayname, '阿林');
  assert.equal(f.store.roomContextForEvent('$old-message').memberProfiles[alice.id].displayname, '小林');
  assert.equal(f.store.roomContextForEvent('$new-message').memberProfiles[alice.id].displayname, '阿林');
  f.store.ingest([message('$late-history', { timestamp: 25 })]);
  assert.equal(f.store.roomContextForEvent('$late-history').memberProfiles[alice.id].displayname, '小林');
  f.store.noteRoomState(one, [member('$rename-again', '林同学', { timestamp: 50 })]);
  assert.equal(f.store.roomContextForEvent('$new-message').memberProfiles[alice.id].displayname, '阿林');
});

test('room labels and accepted message snapshots survive restart without becoming global names', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-room-profiles-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'node.sqlite');
  const before = fixture(t, { filename });
  await before.node.ingestEvents([member('$a', '甲群昵称'), message('$a-message'),
    member('$b', '乙群昵称', { roomId: two }), message('$b-message', { roomId: two })]);
  const sequence = before.store.roomContext(two).memberProfiles[alice.id].observedSequence;
  before.store.close();
  const after = fixture(t, { filename });
  await after.node.refreshRoster();
  assert.equal(after.store.roomContext(one).memberProfiles[alice.id].displayname, '甲群昵称');
  assert.equal(after.store.roomContext(two).memberProfiles[alice.id].displayname, '乙群昵称');
  assert.equal(after.store.roomContext(two).memberProfiles[alice.id].observedSequence, sequence);
  assert.equal(after.node.requestFor(after.store.item('$a-message')).event.senderName, '甲群昵称');
  assert.equal(after.node.requestFor(after.store.item('$b-message')).event.senderName, '乙群昵称');
  assert.equal(after.participants[0].name, 'Account Alice');
});

test('sync processes state at the timeline start and membership changes in chronological order', async t => {
  let pass = 0;
  const f = fixture(t, { matrix: { sync: async () => {
    if (++pass === 1) return { next_batch: 'one', rooms: { join: { [one]: {
      state: { events: [member('$initial-state', '小林', { timestamp: 10 })] },
      timeline: { events: [message('$before-rename', { timestamp: 20 }), member('$new-state', '阿林', { timestamp: 30 }), message('$after-rename', { timestamp: 40 })] },
    } } } };
    return { next_batch: 'two', rooms: { join: { [one]: { timeline: { events: [message('$after-refresh', { timestamp: 50 })] } } } } };
  } } });
  await f.node.syncOnce(); await f.node.syncOnce();
  assert.equal(f.node.requestFor(f.store.item('$before-rename')).event.senderName, '小林');
  const newer = f.node.requestFor(f.store.item('$after-rename'));
  assert.equal(newer.event.senderName, '阿林');
  assert.equal(newer.history.find(row => row.eventId === '$before-rename').senderName, '小林');
  assert.equal(f.node.requestFor(f.store.item('$after-refresh')).event.senderName, '阿林');
  assert.equal(f.participants[0].name, 'Account Alice');
});

test('directory room aliases remain scoped and cannot overwrite a later member-state label', async t => {
  const f = fixture(t, { work: { directory: async roomId => ({ participants: people.map(person => ({ ...person,
    name: person.id === alice.id ? roomId === one ? '目录甲群名' : '目录乙群名' : person.name })) }) } });
  await f.node.ingestEvents([message('$directory-a'), message('$directory-b', { roomId: two })]);
  assert.equal(f.node.requestFor(f.store.item('$directory-a')).event.senderName, '目录甲群名');
  assert.equal(f.node.requestFor(f.store.item('$directory-b')).event.senderName, '目录乙群名');
  await f.node.ingestEvents([member('$current-member', '最新成员名'), message('$member-a')]);
  await f.node.refreshRoster();
  assert.equal(f.node.requestFor(f.store.item('$member-a')).event.senderName, '最新成员名');
  assert.equal(f.node.requestFor(f.store.item('$directory-a')).event.senderName, '目录甲群名');
  assert.equal(f.participants[0].name, 'Account Alice');
});

test('same-name people and different room aliases keep sender identity and observed labels separate', async t => {
  const f = fixture(t);
  await f.node.ingestEvents([member('$same-a', '小林'), member('$same-b', '小林', { person: bob.id }),
    message('$alice-line'), message('$bob-line', { sender: bob.id }), member('$other-a', 'A.L.', { roomId: two }),
    message('$alice-other', { roomId: two })]);
  const a = f.node.requestFor(f.store.item('$alice-line')), b = f.node.requestFor(f.store.item('$bob-line'));
  assert.equal(a.context.source.sender.name, '小林');
  assert.equal(b.context.source.sender.name, '小林');
  assert.equal(a.context.source.sender.id, alice.id);
  assert.equal(b.context.source.sender.id, bob.id);
  assert.equal(f.node.requestFor(f.store.item('$alice-other')).context.source.sender.name, 'A.L.');
});

test('an explicitly cleared room display name uses the full ID instead of a stale account label', async t => {
  const f = fixture(t);
  await f.node.ingestEvents([member('$named', '曾用名'), message('$named-line'), member('$cleared', null), message('$cleared-line'),
    member('$empty', ''), message('$empty-line')]);
  assert.equal(f.node.requestFor(f.store.item('$named-line')).event.senderName, '曾用名');
  assert.equal(f.node.requestFor(f.store.item('$cleared-line')).event.senderName, alice.id);
  assert.equal(f.node.requestFor(f.store.item('$empty-line')).event.senderName, alice.id);
});

test('observation batches expose per-event room snapshots and current rooms without changing raw source bytes', async t => {
  const f = fixture(t);
  const first = message('$observed-before');
  await f.node.ingestEvents([member('$name-before', '小林'), first, member('$name-after', '阿林'), message('$observed-after')], 'sync-room');
  await f.node.flushObservations();
  const payload = f.observations[0];
  assert.equal(payload.rooms[one].memberProfiles[alice.id].displayname, '阿林');
  assert.equal(payload.eventRooms['$observed-before'].memberProfiles[alice.id].displayname, '小林');
  assert.equal(payload.eventRooms['$observed-after'].memberProfiles[alice.id].displayname, '阿林');
  assert.deepEqual(payload.events[0], first);
  assert.deepEqual(payload.events.map(event => event.type), ['m.room.message', 'm.room.message']);
});

test('attention and quoted native sources use their own name observations while member lists use current labels', async t => {
  const f = fixture(t);
  const old = message('$quoted-root'); old.content['org.ds_group'].to = [];
  const now = message('$current', { replyTo: '$quoted-root', thread: '$quoted-root' }); now.content['org.ds_group'].to = [];
  await f.node.ingestEvents([member('$old-source-name', '小林'), old, member('$new-source-name', '阿林'), now]);
  await f.node.processAttentionOnce(); await f.node.processAttentionOnce();
  const input = f.decisions.at(-1);
  assert.equal(input.recentMessages[0].senderName, '小林');
  assert.equal(input.currentMessages[0].senderName, '阿林');
  assert.equal(input.context.source.sender.name, '阿林');
  assert.equal(input.context.reply.source.sender.name, '小林');
  assert.equal(input.context.threadRoot.source.sender.name, '小林');
  assert.equal(input.context.members.find(person => person.id === alice.id).name, '阿林');
  assert.equal(f.participants[0].name, 'Account Alice');
});
