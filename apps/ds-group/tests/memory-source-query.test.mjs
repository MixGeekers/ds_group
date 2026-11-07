import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from '../memory/service.mjs';
import { sha } from '../memory/store.mjs';

const project = '!project:test', work = '!work:test', direct = '!direct:test';
const members = ['@alice:test', '@bot:test', '@other:test'].map(id => ({ id, name: id, kind: id === '@bot:test' ? 'bot' : 'human' }));
const input = (id, body, roomId = work, { senderId = '@alice:test', kind = 'human', privateChat = false, timestamp = 1000 } = {}) => ({
  event: { eventId: `$${id}`, senderId, senderKind: kind, roomId, body, timestamp },
  context: { room: { id: roomId, name: roomId, kind: privateChat ? 'direct' : 'group' },
    members: privateChat ? members.slice(0, 2) : members,
    source: { transport: 'matrix', eventId: `$${id}`, roomId, sender: { id: senderId, name: 'Same name', kind }, timestamp } },
});
const observe = (memory, botId, source, disposition = { kind: 'context' }) => memory.observe(botId, source,
  { sourceDispositions: { [source.event.eventId]: disposition } }).sourceRefs[0];
async function withMemory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'memory-source-query-')), memory = new MemoryService({ directory, clock: () => 2000 });
  try { await run(memory, directory); } finally { await memory.close(); await rm(directory, { recursive: true }); }
}

test('unreviewed work-room evidence helps a current project through a few safe local topic seeds', async () => withMemory(async memory => {
  const fact = input('work-fact', '录音间那批银杏线材先别动，来领的人下午才到。', work, { timestamp: 100 });
  const ref = observe(memory, 'a', fact);
  observe(memory, 'a', input('local-topic', '这个交接群是跟录音间的银杏线材有关。', project, { senderId: '@other:test', timestamp: 150 }));
  memory.ingest('a', input('current', '来领的人什么时候到？', project, { timestamp: 200 }), { sessionId: 's' });
  const before = memory.store.watermarks('a'), view = memory.contextSnapshot('a', 's');
  const selected = view.relatedSources.find(source => source.id === ref.id);
  assert.ok(selected); assert.equal(selected.body, fact.event.body);
  assert.equal(selected.roomId, work); assert.equal(selected.authorId, 'matrix:@alice:test'); assert.equal(selected.timestamp, 100);
  assert.equal(selected.audience.sharedAwareness, false); assert.equal(selected.audience.disclosureScope, 'original-audience');
  assert.deepEqual(selected.sourceRefs, [ref]); assert.equal(selected.digest, sha(fact.event.body));
  assert.equal(memory.readSource('a', selected.originalRead).body, fact.event.body);
  assert.equal(memory.store.list({ botId: 'a' }).length, 0);
  assert.deepEqual(memory.store.watermarks('a'), before);
  const packet = memory.reviewPacket('a', { roomId: project, query: '来领的人什么时候到？' });
  assert.ok(packet.sources.some(source => source.id === ref.id && source.crossRoomEvidence.roomId === work));
}));

test('the same author and equal display names do not pull unrelated private content into a project', async () => withMemory(async memory => {
  const privateSource = input('private', '我周六去医院复查，家人还不知道，不用跟别人说。', direct, { privateChat: true });
  const ref = observe(memory, 'a', privateSource);
  observe(memory, 'a', input('other-person', '明天家里请维修师傅。', '!other:test', { senderId: '@different:test' }));
  memory.ingest('a', input('current', '银杏线材的交接安排怎样？', project), { sessionId: 's' });
  assert.equal(memory.contextSnapshot('a', 's').relatedSources.some(source => source.id === ref.id), false);
  assert.equal(memory.querySources('a', { query: '银杏线材的交接安排怎样？' }).entries.some(source => source.id === ref.id), false);
  assert.equal(memory.reviewPacket('a', { roomId: project, query: '银杏线材交接' }).sources.some(source => source.id === ref.id), false);
  assert.equal(JSON.stringify(memory.contextSnapshot('a', 's')).includes(privateSource.event.body), false);
  const generic = observe(memory, 'a', input('private-generic', '文件进度怎样，之前的检查结果还没发给家里。', direct, { privateChat: true }));
  assert.equal(memory.querySources('a', { query: '之前的文件进度怎样？' }).entries.some(source => source.id === generic.id), false);
}));

test('a strongly related private project fact can continue across rooms while preserving the private audience', async () => withMemory(async memory => {
  const ref = observe(memory, 'a', input('private-project', '北原审校稿由林旻负责，周四再核对。', direct, { privateChat: true }));
  memory.ingest('a', input('current', '北原审校稿上次私聊说由谁负责？', project), { sessionId: 's' });
  const evidence = memory.contextSnapshot('a', 's').relatedSources.find(source => source.id === ref.id);
  assert.ok(evidence); assert.equal(evidence.audience.kind, 'direct'); assert.equal(evidence.audience.sharedAwareness, false);
  assert.equal(evidence.roomId, direct); assert.equal(evidence.authorId, 'matrix:@alice:test');
}));

test('cross-room raw selection requires this Bot observation, even when a shared memory cites another Bot source', async () => withMemory(async memory => {
  const unseen = input('other-bot-only', '银杏线材的来领人下午到达。');
  const ref = observe(memory, 'b', unseen);
  memory.ingest('b', unseen, { sessionId: 'b-session' });
  await memory.remember('b', { text: '共享的银杏线材备忘指针', predicate: 'handover-note', scope: 'team' });
  memory.ingest('a', input('current', '银杏线材来领安排？', project), { sessionId: 'a-session' });
  assert.equal(memory.querySources('a', { query: '银杏线材' }).entries.some(source => source.id === ref.id), false);
  assert.equal(memory.contextSnapshot('a', 'a-session').relatedSources.some(source => source.id === ref.id), false);
  assert.ok(memory.querySources('b', { query: '银杏线材' }).entries.some(source => source.id === ref.id));
}));

test('new queued work stays excluded while earlier admitted request originals remain explicitly reviewable', async () => withMemory(async memory => {
  const earlier = input('earlier', '请核对 ginkgo-check.json 交接数据。', direct, { privateChat: true });
  const earlierRef = observe(memory, 'a', earlier, { kind: 'pending-request' });
  memory.ingest('a', earlier, { sessionId: 'earlier-session' });
  const queued = input('queued', '请立即另做 ginkgo-check.json 的独立新版本。');
  const queuedRef = observe(memory, 'a', queued, { kind: 'pending-request' });
  const unadmittedTool = memory.store.observe({ id: 'unadmitted-tool', transport: 'tool', eventId: 'unadmitted-call', roomId: work,
    conversationKind: 'group', authorId: 'tool:read', authorKind: 'tool', body: 'ginkgo-check.json 未经接纳请求的派生工具材料', originRefs: [queuedRef] });
  memory.store.observeFor('a', [{ id: unadmittedTool.id, revision: 1 }]);
  memory.ingest('a', input('current', 'ginkgo-check.json 之前交代的核对怎么做的？', project), { sessionId: 'current-session' });
  const view = memory.contextSnapshot('a', 'current-session');
  assert.equal(view.relatedSources.some(source => source.id === earlierRef.id || source.id === queuedRef.id), false);
  assert.ok(view.pendingRequests.some(source => source.eventId === queued.event.eventId));
  const query = memory.querySources('a', { query: 'ginkgo-check.json 之前的核对' });
  const old = query.entries.find(source => source.id === earlierRef.id);
  assert.ok(old); assert.equal(old.workDisposition.role, 'other-or-prior-work-evidence');
  assert.equal(old.workDisposition.admission.sessionId, 'earlier-session');
  assert.equal(old.workDisposition.executableAsNewRequest, false);
  assert.equal(old.workDisposition.completion, 'not-established-by-memory');
  assert.equal(query.entries.some(source => source.id === queuedRef.id), false);
  assert.equal(query.entries.some(source => source.id === unadmittedTool.id), false);
  assert.equal(memory.readSource('a', earlierRef).body, earlier.event.body);
  assert.throws(() => memory.readSource('a', queuedRef), /MEMORY_SOURCE_PENDING_REQUEST/);
}));

test('a prior direct-chat actual file readback is available for a later group question with its original work attribution', async () => withMemory(async (memory, directory) => {
  const previous = input('private-task', '请检查 ginkgo-check.json。', direct, { privateChat: true });
  const requestRef = observe(memory, 'a', previous, { kind: 'pending-request' });
  memory.ingest('a', previous, { sessionId: 'private-session' });
  const filename = join(directory, 'ginkgo-check.json');
  await writeFile(filename, '{"validation":"passed","rows":2}\n');
  const actual = await readFile(filename, 'utf8');
  const tool = memory.observeTool('a', { sessionId: 'private-session', callId: 'file-readback', name: 'read',
    body: JSON.stringify({ path: 'ginkgo-check.json', body: actual, sha256: sha(actual) }), timestamp: 1100 });
  memory.ingest('a', input('current', 'ginkgo-check.json 的检查结果怎样？', project, { timestamp: 1200 }), { sessionId: 'project-session' });
  const view = memory.contextSnapshot('a', 'project-session', { workView: { tasks: [{ sourceEventId: previous.event.eventId, status: 'completed', receipt: 'runtime-file-check' }] } });
  const evidence = view.relatedSources.find(source => source.id === tool.id);
  assert.ok(evidence); assert.equal(evidence.conversationKind, 'direct'); assert.equal(evidence.authorId, 'tool:read');
  assert.deepEqual(evidence.workDisposition.originWork[0].id, requestRef.id);
  assert.equal(evidence.workDisposition.originWork[0].admission.sessionId, 'private-session');
  assert.equal(evidence.workDisposition.executableAsNewRequest, false);
  assert.ok(evidence.body.includes(sha(actual)));
  assert.equal(view.relatedSources.some(source => source.id === requestRef.id), false);
  assert.equal(memory.querySources('a', { query: 'ginkgo-check.json' }).entries.find(source => source.id === tool.id).audience.disclosureScope, 'original-audience');
  assert.equal(memory.querySources('a', { query: 'ginkgo-check.json', includeDirect: false }).entries.some(source => source.id === tool.id), false);
  const source = memory.readSource('a', { id: tool.id });
  assert.equal(JSON.parse(source.body).body, actual);
  assert.equal(source.workDisposition.completion, 'not-established-by-memory');
  assert.equal(view.workView.data.tasks[0].status, 'completed');
}));

test('a source revision or withdrawal cannot revive old cross-room evidence or expose another Bot unseen revision', async () => withMemory(async memory => {
  const original = input('revised', '银杏线材来领安排在下午。');
  const ref = observe(memory, 'a', original);
  memory.ingest('a', input('current', '银杏线材的来领安排？', project), { sessionId: 's' });
  assert.ok(memory.querySources('a', { query: '银杏线材' }).entries.some(source => source.id === ref.id));
  const old = memory.store.source(ref.id);
  memory.store.observe({ ...old, revision: 2, body: '银杏线材来领改为明早。' });
  memory.store.observeFor('b', [{ id: ref.id, revision: 2 }]);
  assert.equal(memory.querySources('a', { query: '银杏线材' }).entries.some(source => source.id === ref.id), false);
  assert.throws(() => memory.readSource('a', { id: ref.id, revision: 2 }), /MEMORY_SOURCE_NOT_OBSERVED/);
  memory.store.observeFor('a', [{ id: ref.id, revision: 2 }]);
  assert.equal(memory.querySources('a', { query: '银杏线材' }).entries.find(source => source.id === ref.id).revision, 2);
  memory.store.observe({ ...memory.store.source(ref.id), revision: 3, body: '', withdrawn: true });
  assert.equal(memory.contextSnapshot('a', 's').relatedSources.some(source => source.id === ref.id), false);
}));

test('source queries and their automatic view remain bounded pure reads with original readback pointers', async () => withMemory(async memory => {
  for (let index = 0; index < 20; index++) observe(memory, 'a', input(`source-${index}`, `银杏线材交接 ginkgo-check.json ${'原始材料'.repeat(1000)}`, work, { timestamp: index }));
  memory.ingest('a', input('current', 'ginkgo-check.json 银杏线材交接', project), { sessionId: 's' });
  const before = memory.store.watermarks('a'), count = memory.store.sources().length;
  const result = memory.querySources('a', { query: 'ginkgo-check.json 银杏线材', onlyOtherRooms: true, budgetChars: 3000, limit: 3, bodyChars: 100 });
  assert.ok(result.entries.length > 0 && result.entries.length <= 3);
  assert.ok(result.budget.omitted > 0); assert.equal(result.budget.usedChars, JSON.stringify(result).length);
  assert.ok(JSON.stringify(result).length <= 3000);
  for (const source of result.entries) { assert.equal(source.truncated, true); assert.equal(source.bodyLength > source.body.length, true); assert.equal(memory.readSource('a', source.originalRead).digest, source.digest); }
  const view = memory.contextSnapshot('a', 's', { budgetChars: 4096 });
  assert.ok(JSON.stringify(view).length <= 4096);
  assert.deepEqual(memory.store.watermarks('a'), before); assert.equal(memory.store.sources().length, count);
}));

test('bounded retrospective can correct a project fact from relevant unreviewed work-room originals', async () => withMemory(async memory => {
  memory.ingest('a', input('draft', '银杏线材来领暂填15:00。', project, { senderId: '@bot:test', kind: 'bot', timestamp: 100 }), { sessionId: 's' });
  const old = await memory.remember('a', { text: '银杏线材来领时间为15:00', predicate: 'pickup-time', subjectId: `matrix:${project}`, kind: 'inference' });
  const correction = input('correction', '银杏线材来领的时间确认17:10，先前15:00作废。', work, { timestamp: 200 });
  const ref = observe(memory, 'a', correction);
  memory.ingest('a', input('question', '银杏线材来领时间再核对一下。', project, { timestamp: 300 }), { sessionId: 's' });
  const result = await memory.retrospect('a', { roomId: project, query: '银杏线材来领时间' }, async packet => {
    assert.ok(packet.sources.some(source => source.id === ref.id && source.crossRoomEvidence));
    return JSON.stringify({ changes: [{ op: 'replace', replaceId: old.id, text: '银杏线材来领时间确认17:10，15:00已作废',
      subjectId: `matrix:${project}`, predicate: 'pickup-time', kind: 'stated', scope: `room:${project}`, sourceIds: [ref.id], claimState: 'confirmed' }] });
  });
  assert.equal(result.mode, 'source-checked-review'); assert.equal(result.totalChanges, 1);
  assert.equal(memory.store.derivation(memory.store.get(old.id)), 'superseded');
  assert.equal(memory.readSource('a', ref).body, correction.event.body);
}));
