import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from '../memory/service.mjs';
import { NativeBridge } from '../dsh-connect/native-bridge.mjs';

const withMemory = async run => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-disposition-'));
  const memory = new MemoryService({ directory, clock: () => 10000 });
  try { await run(memory, directory); } finally { await memory.close(); await rm(directory, { recursive: true }); }
};
const event = (id, body, room = '!project:test', sender = '@alice:test') => ({ event: {
  eventId: `$${id}`, roomId: room, senderId: sender, senderKind: 'human', body, timestamp: 1000,
}, context: { source: { transport: 'matrix', sender: { id: sender, name: 'Alice', kind: 'human' } } } });
const observe = (memory, bot, input, kind = 'pending-request', forEventId) => memory.observe(bot, input,
  { sourceDispositions: { [input.event.eventId]: { kind, ...(forEventId ? { forEventId } : {}) } } });
const textOf = view => JSON.stringify(view);

test('a later independently queued request is metadata-only while new facts and current task updates stay live', async () => withMemory(async memory => {
  memory.ingest('a', event('current', '核对当前交接'), { sessionId: 's' });
  const other = event('other', '独立的新指令内容');
  observe(memory, 'a', other);
  observe(memory, 'a', event('fact', '前台刚更正到17:10'), 'context');
  observe(memory, 'a', event('update', '当前稿先停下'), 'task-update', '$current');
  const view = memory.contextSnapshot('a', 's');
  assert.equal(textOf(view).includes(other.event.body), false);
  assert.ok(view.pendingRequests.some(row => row.eventId === '$other' && row.status === 'not-admitted-to-this-turn'));
  assert.ok(view.recentSources.some(row => row.eventId === '$fact'));
  assert.ok(view.recentSources.some(row => row.eventId === '$update'));
  assert.equal(memory.current('a', 's').authorId, 'matrix:@alice:test');
  assert.equal(memory.store.sources().find(source => source.eventId === '$other').body, other.event.body);
}));

test('only entering the native turn admits a queued source; contextual history and caller-provided snapshot context do not', async () => withMemory(async memory => {
  memory.ingest('a', event('current', '当前消息'), { sessionId: 's' });
  const other = event('other', '新的独立工作');
  const receipt = observe(memory, 'a', other), ref = receipt.sourceRefs[0];
  memory.ingest('a', { ...event('history-reader', '继续'), history: [other.event] }, { sessionId: 's' });
  assert.equal(memory.store.sourceAdmitted('a', ref), false);
  assert.equal(memory.attentionView('a', { context: { sourceRefs: [ref], roomId: other.event.roomId } }).recentSources.some(row => row.eventId === '$other'), false);
  memory.ingest('a', other, { sessionId: 's' });
  assert.equal(memory.store.sourceAdmitted('a', ref), true);
  const view = memory.contextSnapshot('a', 's');
  assert.ok(view.recentSources.some(row => row.eventId === '$other'));
  assert.equal(view.pendingRequests.some(row => row.eventId === '$other'), false);
  await memory.remember('a', { text: '已接纳的新工作来源可用于本回合', predicate: 'task-context', sourceRefs: [ref] });
}));

test('an accepted request from another turn is not reintroduced as a fresh raw instruction', async () => withMemory(async memory => {
  const old = event('old', '上一回合的独立命令');
  observe(memory, 'a', old); memory.ingest('a', old, { sessionId: 'old-session' });
  const saved = await memory.remember('a', { text: '上一回合学到的有效事实', predicate: 'project-fact' });
  memory.ingest('a', event('new', '新的当前请求'), { sessionId: 'new-session' });
  const view = memory.contextSnapshot('a', 'new-session');
  assert.equal(view.recentSources.some(row => row.eventId === '$old'), false);
  assert.ok(view.currentClaims.some(row => row.id === saved.id));
}));

test('pending dispositions and admission survive restart and remain specific to each Bot', async () => withMemory(async (memory, directory) => {
  const other = event('other', '只对A保留的工作');
  const ref = observe(memory, 'a', other).sourceRefs[0];
  observe(memory, 'b', other, 'context');
  assert.equal(memory.sourceUse('a', ref).allowed, false);
  assert.equal(memory.sourceUse('b', ref).allowed, true);
  const reopened = new MemoryService({ directory, clock: () => 10000 });
  try {
    assert.equal(reopened.sourceUse('a', ref).allowed, false);
    reopened.ingest('a', other, { sessionId: 'processing' });
    assert.equal(memory.sourceUse('a', ref).allowed, true);
  } finally { await reopened.close(); }
}));

test('a source replay can add a trusted reservation without changing bytes or allowing a later contextual downgrade', async () => withMemory(async memory => {
  const other = event('other', '排队正文');
  const first = memory.observe('a', other, { streamId: 'stream', cursor: 1 });
  const second = memory.observe('a', other, { streamId: 'stream', cursor: 1, sourceDispositions: { '$other': { kind: 'pending-request' } } });
  assert.equal(second.duplicate, true); assert.deepEqual(second.sourceRefs, first.sourceRefs);
  observe(memory, 'a', other, 'context');
  assert.equal(memory.sourceUse('a', first.sourceRefs[0]).allowed, false);
  assert.equal(memory.store.source(first.sourceRefs[0].id).revision, 1);
}));

test('a same-cursor trusted peer replay can upgrade its disposition without changing source bytes or parent admission', async () => withMemory(async memory => {
  const parent = event('parent', '已接纳的工作');
  memory.ingest('a', parent, { sessionId: 'parent-session' });
  const parentRef = memory.current('a').sourceRefs[0], admission = memory.store.getMeta(`admitted-source:a:${parentRef.id}`);
  const peer = event('peer', '真实同行回执');
  const options = { streamId: 'trusted-stream', cursor: 1, sourceDispositions: { '$peer': { kind: 'pending-request' } } };
  const first = memory.observe('a', peer, options);
  assert.equal(memory.sourceUse('a', first.sourceRefs[0]).allowed, false);
  const replay = memory.observe('a', peer, { ...options, sourceDispositions: { '$peer': { kind: 'task-update', forEventId: '$parent' } } });
  assert.equal(replay.duplicate, true); assert.deepEqual(replay.sourceRefs, first.sourceRefs);
  assert.equal(memory.sourceUse('a', first.sourceRefs[0], memory.current('a'), { raw: true }).allowed, true);
  assert.equal(memory.store.source(first.sourceRefs[0].id).body, peer.event.body);
  assert.equal(memory.store.source(first.sourceRefs[0].id).revision, 1);
  assert.deepEqual(memory.store.getMeta(`admitted-source:a:${parentRef.id}`), admission);
}));

test('task updates require the admitted exact parent and trusted cross-room updates remain usable', async () => withMemory(async memory => {
  memory.ingest('a', event('current', '当前项目工作'), { sessionId: 's' });
  observe(memory, 'a', event('peer', '队友回信中的有效当前更新', '!peer:test'), 'task-update', '$current');
  observe(memory, 'a', event('unrelated', '另一个工作的更新'), 'task-update', '$never-admitted');
  const view = memory.attentionView('a', { context: memory.current('a'), allScopes: true });
  assert.ok(memory.reviewableRefs('a').some(ref => memory.store.source(ref.id).eventId === '$peer'));
  assert.equal(view.recentSources.some(row => row.eventId === '$unrelated'), false);
  assert.equal(memory.reviewableRefs('a').some(ref => memory.store.source(ref.id).eventId === '$unrelated'), false);
  const peer = memory.store.sources().find(row => row.eventId === '$peer');
  assert.equal(memory.sourceUse('a', peer, memory.current('a'), { raw: true }).allowed, true);
}));

test('stored summaries and preferences cannot launder an unadmitted request through view, recall or retrospective', async () => withMemory(async memory => {
  memory.ingest('a', event('current', '当前事情'), { sessionId: 's' });
  const later = event('later', '尚未接纳的独立命令正文');
  const ref = memory.observe('a', later).sourceRefs[0];
  const claim = await memory.remember('a', { text: '从未接纳来源抽出的旧摘要', predicate: 'format', facets: ['preference'], scope: 'own', sourceRefs: [ref] });
  const derived = await memory.remember('a', { text: '旧摘要的派生执行计划', kind: 'inference', basisRefs: [{ id: claim.id, revision: 1 }] });
  observe(memory, 'a', later);
  const view = memory.contextSnapshot('a', 's');
  assert.equal(textOf(view).includes(claim.text), false);
  assert.equal(textOf(view).includes(derived.text), false);
  assert.ok(view.selection.workBoundClaimsOmitted >= 2);
  assert.equal((await memory.recall('a', { history: true, scope: 'all' })).entries.some(row => [claim.id, derived.id].includes(row.id)), false);
  const packet = memory.reviewPacket('a', { kind: 'person', id: '@alice:test', allScopes: true });
  assert.equal(packet.sources.some(row => row.id === ref.id), false);
  assert.equal(packet.existingMemories.some(row => [claim.id, derived.id].includes(row.id)), false);
  assert.throws(() => memory.readSource('a', ref), /MEMORY_SOURCE_PENDING_REQUEST/);
  memory.ingest('a', later, { sessionId: 's' });
  assert.ok((await memory.recall('a', { scope: 'all' })).entries.some(row => row.id === claim.id));
}));

test('source origin chains and memory basis chains retain the pending-work boundary', async () => withMemory(async memory => {
  const later = event('later', '需要等独立回合接管');
  const ref = memory.observe('a', later).sourceRefs[0];
  const relay = memory.store.observe({ id: 'relay', revision: 1, body: '转述独立命令', authorId: 'native:peer', originRefs: [ref] });
  memory.store.observeFor('a', [{ id: relay.id, revision: relay.revision }]);
  memory.ingest('a', event('current', '当前工作'));
  const legacy = await memory.remember('a', { text: '另一段转述摘要', sourceRefs: [{ id: relay.id, revision: 1 }], kind: 'reported' });
  observe(memory, 'a', later);
  assert.equal(memory.memoryUse('a', memory.store.get(legacy.id)).allowed, false);
  assert.equal(memory.sourceUse('a', { id: relay.id, revision: 1 }).allowed, false);
  await assert.rejects(memory.remember('a', { text: '绕过的派生条目', basisRefs: [{ id: legacy.id, revision: legacy.revision }] }), /MEMORY_SOURCE_PENDING_REQUEST/);
}));

test('writes and review publication reject pending evidence, even if the packet was built before its disposition arrived', async () => withMemory(async memory => {
  memory.ingest('a', event('current', '当前工作'));
  const later = event('later', '未接纳的新工作'), ref = memory.observe('a', later).sourceRefs[0];
  const packet = memory.reviewPacket('a', { query: '工作', roomId: '!project:test' });
  observe(memory, 'a', later);
  await assert.rejects(memory.remember('a', { text: '新工作的计划', sourceRefs: [ref] }), /MEMORY_SOURCE_PENDING_REQUEST/);
  await assert.rejects(memory.applyReview('a', packet, [{ op: 'add', text: '稍早提案也不能用', sourceIds: [ref.id] }]), /MEMORY_SOURCE_PENDING_REQUEST/);
  assert.equal(memory.store.list({ botId: 'a' }).length, 0);
}));

test('a reservation arriving during external body IO cannot publish the staged fact', async () => withMemory(async memory => {
  memory.ingest('a', event('current', '当前工作'));
  const later = event('later', '还未被识别的新工作'), ref = memory.observe('a', later).sourceRefs[0];
  memory.backend = { save: async row => {
    observe(memory, 'a', later);
    return { nativeId: row.id, bodyDigest: row.bodyDigest };
  }, close: async () => {} };
  await assert.rejects(memory.remember('a', { text: '不得发布到当前上下文', sourceRefs: [ref] }), /MEMORY_SOURCE_PENDING_REQUEST/);
  assert.equal(memory.store.list({ botId: 'a' }).length, 0);
}));

test('late semantic ranking cannot reintroduce a now-reserved derived record', async () => withMemory(async memory => {
  memory.ingest('a', event('current', '当前工作'));
  const later = event('later', '排队前的材料'), ref = memory.observe('a', later).sourceRefs[0];
  const row = await memory.remember('a', { text: '材料摘要', sourceRefs: [ref] });
  memory.backend = { save: async item => ({ nativeId: item.id, bodyDigest: item.bodyDigest }), index: async () => ({ state: 'applied' }),
    search: async () => { observe(memory, 'a', later); return { mode: 'semantic', matches: [{ memoryOperationId: row.id }] }; },
    read: async () => { throw new Error('Reserved evidence must not be returned'); }, close: async () => {} };
  assert.equal((await memory.recall('a', { query: '材料' })).entries.length, 0);
}));

test('normal corrections and source withdrawals still invalidate and update current facts across later pending work', async () => withMemory(async memory => {
  const current = memory.ingest('a', event('current', '最初17:00'), { sessionId: 's' });
  const old = await memory.remember('a', { text: '17:00', predicate: 'pickup-time', subjectId: 'project:pickup' });
  observe(memory, 'a', event('later', '另一个待处理任务'));
  const correction = event('correction', '当前交接改为17:10');
  const refs = observe(memory, 'a', correction, 'context').sourceRefs;
  const next = await memory.remember('a', { text: '17:10', predicate: 'pickup-time', subjectId: 'project:pickup', replaceId: old.id, sourceRefs: refs });
  assert.ok(memory.contextSnapshot('a', 's').currentClaims.some(row => row.id === next.id));
  memory.store.retractSource(refs[0].id);
  assert.equal(memory.contextSnapshot('a', 's').currentClaims.some(row => row.id === next.id), false);
  assert.deepEqual(memory.current('a', 's').sourceRefs, current.sourceRefs);
}));

test('the native bridge forwards queue dispositions with the original source and room snapshot', async () => withMemory(async (memory, directory) => {
  memory.ingest('a', event('current', '当前回合'), { sessionId: 's' });
  const raw = { type: 'm.room.message', event_id: '$queued', room_id: '!project:test', sender: '@alice:test', origin_server_ts: 1000,
    content: { body: '等待另一个回合的新请求' } };
  const bridge = new NativeBridge({ ctx: {}, node: { directory, id: '@bot:test', nativeBotId: 'a' },
    native: { call: async (operation, payload) => {
      assert.equal(operation, 'observe');
      assert.equal(payload.options.sourceDispositions.$queued.kind, 'pending-request');
      return memory.observe(payload.botId, payload.inputs, payload.options);
    } } });
  await bridge.observe({ events: [raw], participants: [{ id: '@alice:test', name: 'Alice', kind: 'human' }],
    watermark: { sequence: 2 }, sourceDispositions: { '$queued': { kind: 'pending-request' } } });
  const view = memory.contextSnapshot('a', 's');
  assert.equal(textOf(view).includes(raw.content.body), false);
  assert.equal(view.pendingRequests[0].eventId, '$queued');
}));
