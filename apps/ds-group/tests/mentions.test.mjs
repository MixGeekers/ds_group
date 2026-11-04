import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatFeatures } from '../src/mentions.mjs';
import { parseMentionTokens, mentionKindsFor, displayMentionText } from '../web/mention-tokens.js';

const alice = '@alice:example.test';
const bob = '@bob:example.test';
const bot = '@finance:example.test';
const roomId = '!group:example.test';
const setup = { participants: [
  { id: alice, localpart: 'alice', name: 'Alice', kind: 'human' },
  { id: bob, localpart: 'bob', name: 'Bob', kind: 'human' },
  { id: bot, localpart: 'finance', name: '财务', kind: 'bot' },
] };
const members = setup.participants.map(person => person.id);

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-mentions-'));
  const feature = new ChatFeatures({ setup, dataRoot: directory, now: () => 10000 });
  t.after(async () => { feature.close(); await rm(directory, { recursive: true, force: true }); });
  return { feature, directory };
}

const event = (id, mentions, ts = 1000) => ({
  type: 'm.room.message', event_id: id, room_id: roomId, sender: alice, origin_server_ts: ts,
  content: { body: 'message', 'org.ds_group': { mentions } },
});

test('mention parser handles stable IDs and skips escapes, code, email and URL text', () => {
  const body = `<@${bob}> <@${bob}> <@&finance> @everyone @here \\@everyone \\<@${alice}> \`<@${alice}>\`\n\`\`\`\n@everyone\n\`\`\`\nmail@everyone https://example.test/@here`;
  const parsed = parseMentionTokens(body);
  assert.deepEqual(parsed.users, [bob]);
  assert.deepEqual(parsed.roles, ['finance']);
  assert.equal(parsed.everyone, true);
  assert.equal(parsed.here, true);
  assert.equal(parsed.tokens.length, 5);
  assert.deepEqual(parseMentionTokens('email@everyone @everyoneish \\@here `@here` ~~~\n@here\n~~~').tokens, []);
  assert.equal(displayMentionText(`<@${bob}> <@&finance>`, setup.participants, [{ id: 'finance', name: '财务部' }]), '@Bob @财务部');
});

test('explicit Bot mentions and Bot direct messages route work while groups only expand notification recipients', async t => {
  const { feature } = await fixture(t);
  feature.touchPresence(bob, { status: 'online' });
  const direct = await feature.resolveMessage({ userId: alice, roomId, members, input: { body: `<@${bot}> calculate`, mentions: { users: [bot] } } });
  assert.deepEqual(direct.to, [bot]);
  assert.deepEqual(direct.mMentions.user_ids, [bot]);
  const broad = await feature.resolveMessage({ userId: alice, roomId, members, input: { body: '@everyone @here hello' } });
  assert.deepEqual(broad.to, []);
  assert.deepEqual(broad.mentions.everyoneUsers, [alice, bob]);
  assert.deepEqual(broad.mentions.hereUsers, [bob]);
  assert.equal(broad.mMentions.room, true);
  const dm = await feature.resolveMessage({ userId: alice, roomId, members: [alice, bot], directIds: [alice, bot], input: { body: 'hello' } });
  assert.deepEqual(dm.to, [bot]);
});

test('mentions reject stale members, hidden payload pings and unpermitted group mentions', async t => {
  const { feature } = await fixture(t);
  await assert.rejects(feature.resolveMessage({ userId: alice, roomId, members: [alice], input: { body: `<@${bob}>` } }), /not in this conversation/);
  await assert.rejects(feature.resolveMessage({ userId: alice, roomId, members, input: { body: 'hello', mentions: { users: [bob] } } }), /does not match/);
  await assert.rejects(feature.resolveMessage({ userId: bob, roomId, members, input: { body: '@everyone' } }), /server owner/);
  await assert.rejects(feature.resolveMessage({ userId: alice, roomId, members, input: { body: '<@&deleted-role>' } }), /no longer exists/);
});

test('role mentions intersect current room membership and respect role mentionability', async t => {
  const { feature } = await fixture(t);
  const role = feature.saveRole(alice, { name: '项目组', color: '#abcdef', memberIds: [bob, bot], mentionable: true });
  const resolved = await feature.resolveMessage({ userId: alice, roomId, members: [alice, bob], input: { body: `<@&${role.id}> review` } });
  assert.deepEqual(resolved.mentions.roleUsers, [bob]);
  assert.deepEqual(resolved.to, []);
  assert.equal(resolved.mentions.roleLabels[role.id], '项目组');
  feature.saveRole(alice, { ...role, mentionable: false }, role.id);
  await assert.rejects(feature.resolveMessage({ userId: bob, roomId, members, input: { body: `<@&${role.id}>` } }), /cannot be mentioned/);
  assert.throws(() => feature.saveRole(bob, { name: 'hidden', memberIds: [] }), /server owner/);
  assert.throws(() => feature.saveRole(alice, { name: '项目组', memberIds: [] }), /already exists/);
});

test('reply mention uses the actual replied sender and can be disabled', async t => {
  const { feature } = await fixture(t);
  const calls = [];
  const client = { async request(method, route) { calls.push(route); return { type: 'm.room.message', sender: bot }; } };
  const ping = await feature.resolveMessage({ userId: alice, roomId, members, client, input: { body: 'continue', replyTo: '$prior' } });
  assert.equal(ping.mentions.replyUserId, bot);
  assert.deepEqual(ping.to, [bot]);
  const quiet = await feature.resolveMessage({ userId: alice, roomId, members, client, input: { body: 'reference', replyTo: '$prior', replyMention: false } });
  assert.equal(quiet.mentions.replyUserId, undefined);
  assert.deepEqual(quiet.to, []);
  assert.equal(calls.length, 1);
});

test('presence expires and here recipients remain the send-time snapshot', async t => {
  const { directory, feature: initial } = await fixture(t);
  initial.close();
  let now = 1000;
  const feature = new ChatFeatures({ setup, dataRoot: directory, now: () => now });
  t.after(() => feature.close());
  feature.touchPresence(bob);
  const first = await feature.resolveMessage({ userId: alice, roomId, members, input: { body: '@here' } });
  now = 62000;
  assert.equal(feature.presence(bob), 'offline');
  const second = await feature.resolveMessage({ userId: alice, roomId, members, input: { body: '@here' } });
  assert.deepEqual(first.mentions.hereUsers, [bob]);
  assert.deepEqual(second.mentions.hereUsers, []);
});

test('notification preferences distinguish direct, role and broad mentions and persist after reopening', async t => {
  const { feature, directory } = await fixture(t);
  feature.savePreferences(bob, roomId, { mode: 'mentions', suppressEveryone: true, suppressRoles: true });
  assert.equal(feature.shouldNotify(bob, event('$ordinary', {})), false);
  assert.equal(feature.shouldNotify(bob, event('$all', { everyoneUsers: [bob] })), false);
  assert.equal(feature.shouldNotify(bob, event('$role', { roleUsers: [bob] })), false);
  assert.equal(feature.shouldNotify(bob, event('$direct', { users: [bob], everyoneUsers: [bob] })), true);
  assert.equal(feature.shouldNotify(bob, event('$reply', { replyUserId: bob })), true);
  feature.close();
  const restored = new ChatFeatures({ setup, dataRoot: directory });
  t.after(() => restored.close());
  assert.equal(restored.preferences(bob, roomId).mode, 'mentions');
  restored.savePreferences(bob, roomId, { muted: true });
  assert.equal(restored.shouldNotify(bob, event('$muted', { users: [bob] })), false);
});

test('unreads deduplicate replay, preserve read markers and keep here under the unread inbox', async t => {
  const { feature, directory } = await fixture(t);
  const one = event('$one', { users: [bob] }, 1000);
  const two = event('$two', { hereUsers: [bob] }, 2000);
  const three = event('$three', { roleUsers: [bob] }, 3000);
  feature.recordEvents(bob, [one, two, three, one]);
  assert.deepEqual(feature.unreadFor(bob, roomId), { unreadCount: 3, mentionCount: 3, lastEventId: '$three' });
  assert.deepEqual(feature.inbox(bob, [roomId]).events.map(item => item.event_id), ['$three', '$one']);
  assert.deepEqual(feature.inbox(bob, [roomId], { includeRoles: false }).events.map(item => item.event_id), ['$one']);
  feature.markRead(bob, roomId, '$two');
  assert.equal(feature.unreadFor(bob, roomId).unreadCount, 1);
  assert.equal(feature.inbox(bob, [roomId], { filter: 'unread' }).events[0].event_id, '$three');
  feature.markRead(bob, roomId, '$one');
  assert.equal(feature.unreadFor(bob, roomId).unreadCount, 1);
  feature.recordEvents(bob, [event('$backfilled', { users: [bob] }, 500)]);
  assert.equal(feature.unreadFor(bob, roomId).unreadCount, 1);
  assert.equal(feature.inbox(bob, []).events.length, 0);
  feature.close();
  const restored = new ChatFeatures({ setup, dataRoot: directory });
  t.after(() => restored.close());
  assert.equal(restored.unreadFor(bob, roomId).unreadCount, 1);
  assert.deepEqual(mentionKindsFor(one, bob), ['user']);
});
