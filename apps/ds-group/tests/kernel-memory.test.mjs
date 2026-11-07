import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../src/core.mjs';
import { MemoryService } from '../memory/service.mjs';

const ownerId = '@owner:memory-rpc.test';
const botId = '@bot:memory-rpc.test';
const nativeBotId = 'original-native-bot';
const roomId = '!river:memory-rpc.test';
const input = (id, body, { sender = '@lin:a.test', kind = 'human', at = 1000 } = {}) => ({
  event: { eventId: `$${id}`, roomId, senderId: sender, senderKind: kind, body, timestamp: at },
  context: { room: { id: roomId, name: '河湾' }, source: { transport: 'matrix', timestamp: at, sender: { id: sender, name: '林青', kind } } },
});

// This fixture uses the actual SQLite memory service and the actual Core HTTP
// transport. Only Matrix account authentication is synthetic; no model runs.
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-kernel-memory-'));
  const memory = new MemoryService({ directory: path.join(directory, 'memory'), clock: () => 10000 });
  const matrix = createServer((request, response) => {
    const allowed = request.headers.authorization === 'Bearer synthetic-owner-token';
    response.writeHead(allowed ? 200 : 401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(allowed ? { user_id: ownerId } : { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown account' }));
  });
  await new Promise(resolve => matrix.listen(0, '127.0.0.1', resolve));
  const bot = { id: botId, localpart: 'bot', kind: 'bot', name: 'Bot', ownerId };
  const core = await createCore({ dataRoot: path.join(directory, 'core'), enablePush: false,
    config: { nodeSecret: 'synthetic-node-secret' },
    setup: { serverName: 'memory-rpc.test', homeserverUrl: `http://127.0.0.1:${matrix.address().port}`, roomId,
      participants: [{ id: ownerId, localpart: 'owner', kind: 'human', name: 'Owner' }, bot] } });
  await new Promise(resolve => core.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${core.server.address().port}`;
  const nodeSecret = await core.nodeCredentials.issue(bot);
  const identity = { botId, nodeId: bot.localpart, runtimeId: 'runtime-one' };
  t.after(async () => { await core.close(); await memory.close(); await new Promise(resolve => matrix.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  async function node(route, value) {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${nodeSecret}` }, body: JSON.stringify(value) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await node('/internal/nodes/heartbeat', { id: identity.nodeId, botId, runtimeId: identity.runtimeId, status: 'idle', kernelControl: { version: 1 } })).status, 200);
  async function read(options) {
    const query = new URLSearchParams(options);
    const pending = fetch(`${base}/api/bots/${encodeURIComponent(botId)}/memory/profile?${query}`, { headers: { authorization: 'Bearer synthetic-owner-token' } });
    let command;
    for (let attempt = 0; attempt < 100; attempt++) {
      const poll = await node('/internal/kernel/poll', identity);
      assert.equal(poll.status, 200);
      [command] = poll.body.commands;
      if (command) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(command, 'Core queued a memory management command');
    let nativeResult;
    let receipt;
    try {
      nativeResult = command.operation === 'memory-profiles' ? memory.profiles(nativeBotId, command.args) : memory.profile(nativeBotId, command.args);
      receipt = { ...command, status: 'completed', result: nativeResult };
    } catch (error) { receipt = { ...command, status: 'failed', error: { code: error.code || error.message } }; }
    const recorded = await node('/internal/kernel/result', receipt);
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
    const response = await pending;
    return { status: response.status, body: await response.json(), native: nativeResult && JSON.parse(JSON.stringify(nativeResult)) };
  }
  return { memory, read };
}

test('actual memory person and room-project lists survive Core RPC with category and entity kind intact', async t => {
  const { memory, read } = await fixture(t);
  for (const sender of ['@lin:a.test', '@lin:b.test']) {
    memory.ingest(nativeBotId, input(sender, '使用中文', { sender }));
    await memory.remember(nativeBotId, { text: `${sender}使用中文`, predicate: 'language', scope: 'own', facets: ['preference'] });
  }
  memory.ingest(nativeBotId, input('bot-draft', 'Bot草稿', { sender: '@peer:a.test', kind: 'bot', at: 2000 }));
  memory.observe('another-native-bot', input('private', '另一个Bot的经历', { sender: '@private:a.test' }));
  const people = await read({ kind: 'person' });
  assert.equal(people.status, 200);
  assert.deepEqual(people.body, people.native);
  assert.equal(people.body.items.filter(item => item.name === '林青' && item.entityKind === 'human').length, 2);
  assert.ok(people.body.items.every(item => item.kind === 'person'));
  assert.ok(people.body.items.some(item => item.entityKind === 'bot'));
  assert.equal(people.body.items.some(item => item.id === 'matrix:@private:a.test'), false);
  const projects = await read({ kind: 'project' });
  assert.equal(projects.status, 200);
  assert.deepEqual(projects.body, projects.native);
  assert.ok(projects.body.items.some(item => item.id === `matrix:${roomId}` && item.kind === 'project' && item.entityKind === 'group'));
});

test('actual person profile retains bounded scope, speaker, source and selection metadata through HTTP', async t => {
  const { memory, read } = await fixture(t);
  memory.ingest(nativeBotId, input('preference', '中文短表格'));
  const fact = await memory.remember(nativeBotId, { text: '中文短表格', predicate: 'language', facets: ['preference'], scope: 'own' });
  memory.observe(nativeBotId, input('unreviewed', '临时更换场地', { at: 2000 }));
  const result = await read({ kind: 'person', id: 'matrix:@lin:a.test' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, result.native, 'Core preserves the complete already-bounded source-attributed view');
  const { view, identity } = result.body;
  assert.equal(identity.kind, 'person');
  assert.equal(identity.entityKind, 'human');
  assert.equal(view.botId, nativeBotId);
  assert.equal(view.schemaVersion, 2);
  assert.equal(view.scope, 'own');
  assert.equal(view.speaker.id, 'matrix:@lin:a.test');
  assert.equal(view.selection.wholeHistoryLoaded, false);
  assert.equal(view.preferences[0].id, fact.id);
  assert.equal(view.preferences[0].sources[0].authorId, 'matrix:@lin:a.test');
  assert.ok(view.recentSources.some(source => source.eventId === '$unreviewed' && !source.reviewed));
  assert.equal(view.watermarks.receivedThrough, 2);
  assert.ok(view.historyGaps.length);
  assert.ok(view.budget.usedChars > 0);
});

test('actual project profile preserves conflicts, superseded claims and source evidence while unknown evidence stays 404', async t => {
  const { memory, read } = await fixture(t);
  memory.ingest(nativeBotId, input('proposal', '计划使用二楼', { sender: '@peer:a.test', kind: 'bot' }));
  const proposal = await memory.remember(nativeBotId, { text: '计划使用二楼', subjectId: 'project:river', predicate: 'venue', kind: 'inference', claimState: 'proposal' });
  memory.ingest(nativeBotId, input('confirmed', '确认使用一楼', { at: 2000 }));
  const previous = await memory.remember(nativeBotId, { text: '确认使用一楼', subjectId: 'project:river', predicate: 'venue', claimState: 'confirmed' });
  memory.ingest(nativeBotId, input('correction', '改为庭院', { at: 3000 }));
  const corrected = await memory.remember(nativeBotId, { text: '改为庭院', subjectId: 'project:river', predicate: 'venue', claimState: 'confirmed', replaceId: previous.id });
  const result = await read({ kind: 'project', id: 'project:river' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, result.native);
  const current = result.body.view.currentClaims.find(claim => claim.id === corrected.id);
  assert.equal(current.claimState, 'confirmed');
  assert.ok(current.conflicts.includes(proposal.id));
  assert.equal(current.resolution, 'unresolved');
  assert.equal(current.sources[0].eventId, '$correction');
  assert.equal(current.sources[0].authorId, 'matrix:@lin:a.test');
  assert.ok(current.sources[0].digest);
  assert.ok(result.body.view.changes.some(change => change.id === previous.id && change.derivation === 'superseded'));
  const unknown = await read({ kind: 'project', id: 'project:unobserved' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'MEMORY_PROFILE_NOT_KNOWN');
});
