import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, identityId } from '../memory/store.mjs';
import { MemoryService } from '../memory/service.mjs';
import { createMemoryPanel } from '../memory/panel.mjs';

const withService = async fn => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-unit-'));
  const service = new MemoryService({ directory, clock: () => 5000 });
  try { await fn(service, directory); } finally { await service.close(); await rm(directory, { recursive: true }); }
};
const event = (n, body, room = '!a:test', sender = '@lin:a.test', name = '林青') => ({
  event: { eventId: `$${n}`, roomId: room, senderId: sender, body, timestamp: 1000 },
  context: { source: { sender: { id: sender, name, kind: 'human' }, timestamp: 1000 } },
});
test('contacts preserve full accounts, display-name changes and cross-connection identity', async () => withService(async service => {
  service.ingest('a', event(1, '中文报告')); service.ingest('b', event(1, '中文报告'));
  service.ingest('a', event(2, '英文报告', '!a:test', '@lin:b.test'));
  service.ingest('a', event(3, '改名', '!b:test', '@lin:a.test', '青禾'));
  assert.equal(service.store.contacts('林青').length, 2);
  assert.deepEqual(service.store.getContact(identityId('matrix', '@lin:a.test')).aliases, ['林青', '青禾']);
  const oldHistory = event(4, '旧历史', '!a:test', '@lin:a.test', '林青'); oldHistory.context.source.timestamp = 500;
  service.ingest('a', oldHistory);
  assert.equal(service.store.getContact(identityId('matrix', '@lin:a.test')).name, '青禾');
  const current = event(5, '继续', '!a:test', '@lin:a.test', '青禾'); current.context.source.timestamp = 9000;
  service.ingest('a', current);
  const intermediate = event(6, '稍早历史', '!a:test', '@lin:a.test', '林青'); intermediate.context.source.timestamp = 8000;
  service.ingest('a', intermediate);
  assert.equal(service.store.getContact(identityId('matrix', '@lin:a.test')).name, '青禾');
}));
test('source duplicate is idempotent; conflicting event bytes fail; source revision invalidates dependent facts', async () => withService(async service => {
  const current = service.ingest('a', event(1, '中文报告'));
  const row = await service.remember('a', { text: '中文报告', predicate: 'report-language' });
  service.ingest('a', event(1, '中文报告'));
  assert.equal((await service.remember('a', { text: '中文报告', predicate: 'report-language' })).id, row.id);
  assert.throws(() => service.ingest('a', event(1, '英文报告')), /SOURCE_CONTENT_CONFLICT/);
  const source = service.store.source(current.sourceRefs[0].id);
  service.store.observe({ ...source, revision: 2, body: '英文报告' });
  assert.equal((await service.recall('a')).entries.length, 0);
  assert.equal((await service.recall('a', { history: true })).entries[0].derivation, 'source-revised');
}));
test('rooms and Bot memories remain distinct; intentional all-scope recall labels origins', async () => withService(async service => {
  service.ingest('a', event(1, '周六')); await service.remember('a', { text: '周六发布', subjectId: 'project:发布', predicate: 'release' });
  service.ingest('a', event(2, '周日', '!b:test')); await service.remember('a', { text: '周日发布', subjectId: 'project:发布', predicate: 'release' });
  service.ingest('b', event(1, '周六')); assert.equal((await service.recall('b')).entries.length, 0);
  assert.deepEqual((await service.recall('a')).entries.map(row => row.text), ['周日发布']);
  assert.equal((await service.recall('a', { scope: 'all' })).entries.length, 2);
  assert.ok((await service.recall('a', { scope: 'all' })).entries.every(row => row.conflicts.length === 0));
}));
test('conflicting facts remain visible; reported speech is not promoted to independent observed evidence', async () => withService(async service => {
  service.ingest('a', event(1, '周六')); const a = await service.remember('a', { text: '周六发布', subjectId: 'project:x', predicate: 'release' });
  service.ingest('a', event(2, '周日', '!a:test', '@other:test'));
  const b = await service.remember('a', { text: '周日发布', subjectId: 'project:x', predicate: 'release' });
  assert.deepEqual(b.conflicts, [a.id]);
  const c = await service.remember('a', { text: '据林青说周一发布', subjectId: 'project:x', predicate: 'release', kind: 'reported', saidBy: 'matrix:@lin:a.test' });
  assert.equal(c.kind, 'reported'); assert.equal(c.sources[0].authorId, 'matrix:@other:test'); assert.equal(c.saidBy, 'matrix:@lin:a.test');
  assert.deepEqual(c.conflicts, []);
}));
test('corrections require a current revision and are atomic; expiry/withdrawal remain historical', async () => withService(async service => {
  service.ingest('a', event(1, '中文')); const old = await service.remember('a', { text: '中文', predicate: 'language' });
  service.ingest('a', event(2, '英文')); const next = await service.remember('a', { text: '英文', predicate: 'language', replaceId: old.id, expectedRevision: 1 });
  await assert.rejects(service.remember('a', { text: '法文', replaceId: old.id, expectedRevision: 1 }), /MEMORY_REVISION_CONFLICT/);
  assert.equal(next.revision, 2); assert.deepEqual((await service.recall('a')).entries.map(row => row.text), ['英文']);
  await service.remember('a', { text: '临时角色', validFrom: 1000, validUntil: 4000 });
  assert.equal((await service.recall('a')).entries.length, 1);
  service.forget('a', { id: next.id }); assert.equal((await service.recall('a')).entries.length, 0);
  assert.deepEqual(new Set((await service.recall('a', { history: true })).entries.map(row => row.derivation)), new Set(['superseded', 'expired', 'withdrawn']));
}));
test('restart preserves exact identity, source, receipt and withdrawal; pending body is not current', async () => withService(async (service, directory) => {
  service.ingest('a', event(1, '事实')); const fact = await service.remember('a', { text: '事实' });
  const reopened = new MemoryStore(join(directory, 'knowledge.sqlite'));
  try {
    assert.equal(reopened.get(fact.id).bodyDigest, service.store.get(fact.id).bodyDigest);
    assert.equal(reopened.getContact('matrix:@lin:a.test').name, '林青');
    const row = reopened.prepare({ botId: 'a', scope: 'own', subjectId: 'matrix:@lin:a.test', text: '未完成', sourceRefs: fact.sourceRefs });
    assert.equal(reopened.derivation(row), 'pending');
    reopened.forget(fact.id, fact.revision);
    assert.equal((await service.recall('a')).entries.length, 0);
  } finally { reopened.close(); }
}));
test('Matrix edits retain original source identity and do not roll back on old history', async () => withService(async service => {
  const original = event(1, '旧日期'); const ctx = service.ingest('a', original);
  await service.remember('a', { text: '旧日期' });
  const edit = event(2, '新日期'); edit.context.source.replacesEventId = '$1';
  const changed = service.ingest('a', edit);
  assert.equal(changed.sourceRefs[0].id, ctx.sourceRefs[0].id); assert.equal(changed.sourceRefs[0].revision, 2);
  assert.equal(service.ingest('a', edit).sourceRefs[0].revision, 2);
  assert.equal((await service.recall('a')).entries.length, 0);
  service.ingest('a', { ...event(3, '询问'), history: [original.event] });
  assert.equal(service.store.source(ctx.sourceRefs[0].id).revision, 2);
}));
test('tool evidence is attributed to the tool and repeated Bot relays share one original evidence root', async () => withService(async service => {
  const ctx = service.ingest('a', event(1, '请计算'));
  const tool = service.observeTool('a', { sessionId: 's', callId: 't1', name: 'bash', body: '437', timestamp: 1000 });
  const observation = await service.remember('a', { text: '计算结果437', kind: 'observation', subjectId: 'task:calc' });
  assert.equal(observation.sources[0].authorId, 'tool:bash'); assert.equal(observation.sourceRefs[0].id, tool.id);
  const one = service.store.observe({ id: 'relay_1', body: '转述计算请求', authorId: 'native:bot1', originRefs: ctx.sourceRefs });
  const two = service.store.observe({ id: 'relay_2', body: '再次转述', authorId: 'native:bot2', originRefs: [{ id: one.id, revision: 1 }] });
  assert.deepEqual(service.store.evidenceRoots([{ id: one.id, revision: 1 }, { id: two.id, revision: 1 }]), ctx.sourceRefs);
  service.store.retractSource(ctx.sourceRefs[0].id);
  assert.equal((await service.recall('a')).entries.length, 0);
}));
test('native panel undo restores the prior revision without inventing a new speaker', async () => withService(async service => {
  service.ingest('a', event(1, '旧值')); const old = await service.remember('a', { text: '旧值' });
  service.ingest('a', event(2, '新值')); const changed = await service.remember('a', { text: '新值', replaceId: old.id });
  service.store.undo(`remember:${changed.id}`);
  const restored = (await service.recall('a')).entries[0]; assert.equal(restored.text, '旧值'); assert.equal(restored.revision, 3);
  assert.deepEqual(restored.sourceRefs, old.sourceRefs);
  assert.throws(() => service.store.undo(`remember:${changed.id}`), /MEMORY_ALREADY_RESTORED/);
  service.forget('a', { id: old.id, expectedRevision: 3 }); service.store.undo(`forget:${old.id}`);
  assert.equal((await service.recall('a')).entries[0].revision, 4);
}));
test('metadata repair keeps identical evidence and content; it cannot reassign a different fact', async () => withService(async service => {
  service.ingest('a', event(1, '项目标签为苍鹭')); const old = await service.remember('a', { text: '项目标签为苍鹭' });
  await assert.rejects(service.remember('a', { text: '他人偏好红色', subjectId: 'matrix:@other:test', replaceId: old.id, reclassify: true }), /MEMORY_REVISION_CONFLICT/);
  const corrected = await service.remember('a', { text: old.text, subjectId: 'project:x', replaceId: old.id, reclassify: true });
  assert.equal(corrected.subjectId, 'project:x'); assert.deepEqual(corrected.sourceRefs, old.sourceRefs);
}));
test('native group panel has a keeper, complete history and independently repeatable undo', async () => withService(async service => {
  const bots = { a: { id: 'a' }, b: { id: 'b' } }, room = { id: '!a:test', admin: 'a', members: ['a','b'] };
  const rt = { home: '/synthetic/bot', load: async () => {}, botOf: id => bots[id], roomOf: id => id === room.id ? room : undefined };
  const calls = [];
  const endpoint = createMemoryPanel(rt, service, { flush: async id => { calls.push(id); await service.remember(id, { text: '群内新决定' }); },
    botShot: async (bot, _system, input) => { assert.equal(bot.id, 'a'); assert.ok(JSON.parse(input).memories.entries.length); return '已保存群内决定'; } });
  service.ingest('a', event(1, '事实')); const row = await service.remember('a', { text: '事实' });
  const body = { roomId: room.id };
  assert.equal((await endpoint('memory-view', body)).entries[0].id, row.id);
  for (let i = 0; i < 2; i++) {
    await endpoint('memory-forget', { ...body, id: row.id });
    const history = await endpoint('memory-history', body); const change = history.rows[0];
    assert.equal(change.scope, 'group'); assert.equal(typeof change.time, 'string');
    await endpoint('memory-restore', { ...body, id: change.id });
    assert.equal((await endpoint('memory-view', body)).entries.length, 1);
    assert.equal((await endpoint('memory-history', body)).rows[0].restored, true);
  }
  const answer = await endpoint('memory-ask', { ...body, text: '请记住群内新决定' });
  assert.deepEqual(calls, ['a']); assert.equal(answer.changes[0].scope, 'group');
  assert.equal(service.current('a').roomId, room.id);
  assert.equal(service.store.sources().at(-1).authorKind, 'human');
  await assert.rejects(endpoint('memory-view', { botId: 'missing' }), /Unknown Bot/);
}));
test('temporary vector-index failure preserves the exact body and a later recall repairs the index', async () => withService(async service => {
  let unavailable = true, indexed = 0;
  service.backend = { save: async row => ({ nativeId: row.id, bodyDigest: row.bodyDigest }),
    index: async () => { if (unavailable) throw new Error('embedding unavailable'); indexed++; return { state: 'applied' }; },
    search: async (_query, rows) => ({ mode: 'semantic', matches: rows.map(row => ({ memoryOperationId: row.id })) }),
    read: async row => row.text, close: async () => {} };
  service.ingest('a', event(1, '苍鹭备份')); const saved = await service.remember('a', { text: '苍鹭备份' });
  assert.equal(saved.indexed, false);
  const fallback = await service.recall('a', { query: '苍鹭' });
  assert.equal(fallback.mode, 'lexical-fallback'); assert.equal(fallback.entries[0].id, saved.id);
  unavailable = false;
  const repaired = await service.recall('a', { query: '苍鹭' });
  assert.equal(repaired.mode, 'semantic'); assert.equal(repaired.entries[0].id, saved.id); assert.equal(indexed, 1);
}));
test('one Bot can interleave native Sessions without moving the author, room or tool evidence', async () => withService(async service => {
  service.ingest('a', event(1, '北组任务'), { sessionId: 'north-session' });
  service.ingest('a', event(2, '南组任务', '!b:test', '@lin:b.test'), { sessionId: 'south-session' });
  service.observeTool('a', { sessionId: 'north-session', callId: 'north-tool', name: 'bash', body: '437', timestamp: 1000 });
  const north = service.current('a', 'north-session'), south = service.current('a', 'south-session');
  assert.equal(north.authorId, 'matrix:@lin:a.test'); assert.equal(north.scope, 'room:!a:test');
  assert.equal(south.authorId, 'matrix:@lin:b.test'); assert.equal(south.scope, 'room:!b:test');
  assert.equal(south.toolSources, undefined);
  const saved = await service.remember('a', { text: '计算结果437', kind: 'observation' }, north);
  assert.equal(saved.scope, north.scope); assert.equal(saved.sources[0].roomId, '!a:test');
  service.carry('a', 'north-session', 'north-new-part');
  assert.deepEqual(service.current('a', 'north-new-part').sourceRefs, north.sourceRefs);
  assert.equal(service.current('a', 'south-session').scope, south.scope);
  assert.equal(service.current('a', 'unknown-session'), undefined);
}));

test('mixed request and tool evidence chooses the actual observer at write time', async () => withService(async service => {
  const context = service.ingest('a', event(1, '请计算并保存工具观察'));
  const tool = service.observeTool('a', { sessionId: 's', callId: 'mixed', name: 'bash', body: '437', timestamp: 1000 });
  for (const [index, refs] of [[context.sourceRefs[0], { id: tool.id, revision: 1 }], [{ id: tool.id, revision: 1 }, context.sourceRefs[0]]].entries()) {
    for (const saidBy of [undefined, 'matrix:@lin:a.test']) {
      const saved = await service.remember('a', { text: `工具观察437-${index}-${saidBy || 'default'}`, kind: 'observation',
        subjectId: 'task:calc', sourceRefs: refs, saidBy });
      assert.equal(saved.saidBy, 'tool:bash');
      assert.equal(saved.sources.length, 2);
      assert.deepEqual(new Set(saved.sources.map(source => source.authorKind)), new Set(['human', 'tool']));
      assert.deepEqual(saved.evidenceRoots, context.sourceRefs);
    }
  }
  const quoted = await service.remember('a', { text: '转述另一人的说法', kind: 'reported', saidBy: 'matrix:@other:test' });
  assert.equal(quoted.saidBy, 'matrix:@other:test');
}));
