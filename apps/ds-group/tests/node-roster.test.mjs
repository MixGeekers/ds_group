import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotNode, createRosterClient } from '../src/bot-node.mjs';
import { NodeStore } from '../src/node-store.mjs';

const alice = { id: '@alice:roster.test', localpart: 'alice', name: 'Alice', kind: 'human' };
const bot = { id: '@bot-one:roster.test', localpart: 'bot-one', name: 'Helper', kind: 'bot', accessToken: 'synthetic-own-token' };
const newcomer = { id: '@new-human:roster.test', localpart: 'new-human', name: 'New human', kind: 'human' };
const peer = { id: '@bot-two:roster.test', localpart: 'bot-two', name: 'Helper', kind: 'bot', ownerId: newcomer.id };
const roomId = '!group:roster.test';
const message = (id, sender, metadata = {}) => ({ type: 'm.room.message', event_id: id, room_id: roomId, sender,
  content: { body: 'Create a summary.', 'org.ds_group': { to: [bot.id], ...metadata } } });

function fixture(t, options = {}) {
  const participants = structuredClone([alice, bot]);
  const participant = participants[1];
  const store = new NodeStore(options.filename || ':memory:', participant.id);
  t.after(() => { try { store.close(); } catch {} });
  const calls = [];
  const creates = [];
  let roster = structuredClone([alice, bot]);
  let rosterError;
  let syncEvents = [];
  let timeline = [];
  const node = new BotNode({ participant, participants, roomId, store, onError: () => {}, heartbeat: async () => {},
    roster: { read: async () => { if (rosterError) throw rosterError; return { participants: roster }; } },
    matrix: { sync: async () => ({ next_batch: 'next', rooms: { join: { [roomId]: { timeline: { events: syncEvents } } } } }),
      timeline: async () => timeline, send: async () => ({ event_id: '$sent' }) },
    bridge: { createBot: async input => creates.push(input), turn: async request => {
      calls.push(request); return { status: 'completed', text: '{"text":"Done"}', sessionId: 'synthetic-session' };
    } },
    delivery: { direct: async () => '!human-dm:roster.test' },
  });
  return { node, store, participants, participant, calls, creates,
    roster: value => { roster = structuredClone(value); }, error: value => { rosterError = value; },
    events: value => { syncEvents = value; }, timeline: value => { timeline = value; } };
}

test('new humans and Bots are known before sync persists their delivery identity', async t => {
  const f = fixture(t);
  const setup = { participants: f.participants };
  f.roster([alice, { ...bot, name: 'Renamed helper', accessToken: 'must-not-replace-own-token' }, newcomer, peer]);
  f.events([message('$new-human', newcomer.id, { conversationKind: 'direct' })]);
  await f.node.syncOnce();
  assert.equal(setup.participants, f.node.participants);
  assert.equal(f.node.delivery.participants, setup.participants);
  assert.equal(f.node.participant, f.participant);
  assert.equal(f.participant.name, 'Renamed helper');
  assert.equal(f.participant.accessToken, 'synthetic-own-token');
  assert.equal(f.store.route('$new-human').authoritative, true);
  assert.equal(f.store.route('$new-human').recipientId, newcomer.id);
  await f.node.processOne();
  assert.equal(f.calls[0].event.senderKind, 'human');
  assert.equal(f.calls[0].event.senderName, newcomer.name);
  assert.equal(f.calls[0].event.botIdentity.role, '通用助手');
  assert.deepEqual(f.calls[0].event.availableBots, [{ id: peer.id, name: peer.name, role: '通用助手' }]);
});

test('a failed or incomplete roster leaves unknown messages and the sync cursor unconsumed', async t => {
  const f = fixture(t);
  f.events([message('$waiting', newcomer.id)]);
  f.error(new Error('Synthetic roster outage'));
  await assert.rejects(f.node.syncOnce(), /roster outage/);
  assert.equal(f.store.cursor(), undefined);
  assert.equal(f.store.hasEvent('$waiting'), false);
  f.error(undefined);
  await assert.rejects(f.node.syncOnce(), /not yet registered/);
  assert.equal(f.store.route('$waiting'), undefined);
  assert.equal(f.store.cursor(), undefined);
  f.roster([alice, bot, newcomer]);
  await f.node.syncOnce();
  assert.equal(f.store.cursor(), 'next');
  assert.equal(f.store.route('$waiting').authoritative, true);
});

test('the final timeline refresh updates the roster before registering a newly added sender', async t => {
  const f = fixture(t);
  await f.node.ingestEvents([message('$original', alice.id)]);
  f.roster([alice, bot, newcomer]);
  f.timeline([message('$late-human', newcomer.id, { conversationKind: 'direct' })]);
  await f.node.delivery.refresh(f.store.item('$original'));
  assert.equal(f.store.route('$late-human').authoritative, true);
  assert.equal(f.store.route('$late-human').recipientId, newcomer.id);
});

test('a new delegated Bot and original human retain their distinct identities', async t => {
  const f = fixture(t);
  f.roster([alice, bot, newcomer, peer]);
  f.events([message('$new-peer', peer.id, { kind: 'task.request', returnTo: peer.id,
    originSenderId: newcomer.id, originEventId: '$remote-root', originRoomId: roomId,
    delivery: { kind: 'direct', recipientId: newcomer.id, originBotId: peer.id } })]);
  await f.node.syncOnce();
  const route = f.store.route('$new-peer');
  assert.equal(route.authoritative, false);
  assert.equal(route.originBotId, peer.id);
  assert.equal(route.recipientId, newcomer.id);
  assert.equal(route.error, undefined);
  await f.node.processOne();
  assert.equal(f.calls[0].event.senderKind, 'bot');
  assert.equal(f.calls[0].event.originSenderId, newcomer.id);
});

test('restart refreshes a stale exported roster before resuming persisted queued work', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-roster-'));
  const filename = path.join(directory, 'node.sqlite');
  const first = fixture(t, { filename });
  first.roster([alice, bot, newcomer]);
  await first.node.ingestEvents([message('$queued', newcomer.id, { conversationKind: 'direct' })]);
  first.store.close();
  const restarted = fixture(t, { filename });
  t.after(() => rm(directory, { recursive: true, force: true }));
  restarted.roster([alice, { ...bot, name: 'Current helper' }, newcomer, peer]);
  restarted.node.processLoop = async () => {};
  restarted.node.syncLoop = async () => {};
  restarted.node.heartbeatLoop = async () => {};
  await restarted.node.start();
  assert.equal(restarted.creates[0].name, 'Current helper');
  assert.equal(restarted.creates[0].role, '通用助手');
  await restarted.node.processOne();
  assert.equal(restarted.calls[0].event.senderKind, 'human');
  assert.equal(restarted.store.route('$queued').recipientId, newcomer.id);
});

test('invalid roster updates preserve existing objects and legacy roles remain specific', async t => {
  const f = fixture(t);
  f.roster([alice, { ...bot, name: 'Unexpected rename' }, { ...newcomer, id: alice.id }]);
  await assert.rejects(f.node.refreshRoster(), /invalid participant roster/);
  assert.equal(f.participant.name, bot.name);
  assert.equal(f.participants.length, 2);
  assert.equal(f.node.roleOf({ localpart: 'finance' }), '财务');
  assert.equal(f.node.roleOf({ localpart: 'hr' }), '人事');
  assert.equal(f.node.roleOf({ localpart: 'custom' }), '通用助手');
  assert.equal(f.node.roleOf({ localpart: 'constructor' }), '通用助手');
});

test('roster reads use the core bootstrap endpoint and preserve HTTP failure status', async () => {
  const client = createRosterClient('https://core.example', 'synthetic-node-token', async (url, options) => {
    assert.equal(url.href, 'https://core.example/api/bootstrap');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return Response.json({ participants: [alice, bot] });
  });
  assert.deepEqual(await client.read(), { participants: [alice, bot] });
  const unavailable = createRosterClient('https://core.example', 'synthetic-node-token', async () => new Response('', { status: 503 }));
  await assert.rejects(unavailable.read(), { status: 503 });
});
