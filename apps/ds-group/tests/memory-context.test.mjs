import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from '../memory/service.mjs';
import { canonical, sha } from '../memory/store.mjs';
import { nativeMemoryInput, automaticReviewAllowed } from '../memory/ingress.mjs';
import { observedMemoryInput } from '../src/message-context.mjs';

const withMemory = async run => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-context-'));
  const memory = new MemoryService({ directory, clock: () => 10000 });
  try { await run(memory, directory); } finally { await memory.close(); await rm(directory, { recursive: true }); }
};
const input = (id, body, { sender = '@lin:a.test', kind = 'human', room = '!river:test', at = 1000, name = '林青' } = {}) => ({
  event: { eventId: `$${id}`, roomId: room, senderId: sender, senderKind: kind, body, timestamp: at },
  context: { room: { id: room, name: '河湾' }, source: { transport: 'matrix', timestamp: at, sender: { id: sender, name, kind } } },
});
const matrix = (id, body, extra = {}) => ({ type: 'm.room.message', event_id: `$${id}`, room_id: '!river:test', sender: '@lin:a.test',
  origin_server_ts: 1000, content: { body }, ...extra });

test('continuous observation is durable and idempotent without changing the active speaker or calling a backend', async () => withMemory(async (memory, directory) => {
  memory.ingest('a', input('request', '写报告', { sender: '@song:test' }), { sessionId: 's' });
  const active = memory.current('a', 's');
  let calls = 0;
  memory.backend = { save: async () => { calls++; }, close: async () => {} };
  const received = memory.observe('a', [input('discussion', '电梯还没有确认'), input('correction', '二楼方案取消')], { streamId: 'matrix', cursor: 20, afterCursor: null });
  assert.equal(received.watermarks.receivedThrough, 3);
  assert.equal(received.watermarks.pendingReviewCount, 3);
  assert.equal(received.watermarks.reviewedThrough, 0);
  assert.equal(calls, 0);
  assert.deepEqual(memory.current('a', 's'), active);
  const renamed = input('discussion', '电梯还没有确认', { name: '青禾' });
  assert.equal(memory.observe('a', [renamed, input('correction', '二楼方案取消')], { streamId: 'matrix', cursor: 20 }).duplicate, true);
  const reopened = new MemoryService({ directory, clock: () => 10000 });
  try {
    assert.equal(reopened.observe('a', [renamed, input('correction', '二楼方案取消')], { streamId: 'matrix', cursor: 20 }).duplicate, true);
    assert.equal(reopened.store.watermarks('a').receivedThrough, 3);
    assert.throws(() => reopened.observe('a', input('changed', '不同字节'), { streamId: 'matrix', cursor: 20 }), /MEMORY_STREAM_CONTENT_CONFLICT/);
    assert.throws(() => reopened.observe('a', input('tail', '尾部'), { streamId: 'matrix', cursor: 21, afterCursor: 19 }), /MEMORY_STREAM_CONFLICT/);
  } finally { await reopened.close(); }
}));

test('a conflicting later event rolls back an entire observation batch and its cursor', async () => withMemory(async memory => {
  memory.observe('a', input('old', '原文'), { streamId: 'matrix', cursor: 1 });
  assert.throws(() => memory.observe('a', [input('new', '不应持久化'), input('old', '篡改原文')], { streamId: 'matrix', cursor: 2, afterCursor: 1 }), /SOURCE_CONTENT_CONFLICT/);
  assert.equal(memory.store.sources().some(source => source.eventId === '$new'), false);
  assert.equal(memory.store.watermarks('a').receivedThrough, 1);
  assert.equal(memory.store.getMeta('observation-stream:a:matrix').cursor, 1);
  assert.equal(memory.store.getMeta('unreviewed:a').length, 1);
}));

test('an upgraded default claim keeps its pre-v2 identity instead of duplicating persistent memories', async () => withMemory(async memory => {
  const context = memory.ingest('a', input('legacy-id', '已有条目'));
  const row = await memory.remember('a', { text: '已有条目', predicate: 'note' });
  const legacyId = `memory_${sha(canonical({ botId: 'a', scope: 'room:!river:test', text: '已有条目', sourceRefs: context.sourceRefs,
    subjectId: 'matrix:@lin:a.test', predicate: 'note', kind: 'stated', saidBy: 'matrix:@lin:a.test', validFrom: 1000, validUntil: null, replaces: null }))}`;
  assert.equal(row.id, legacyId);
  assert.equal((await memory.remember('a', { text: '已有条目', predicate: 'note', claimState: 'statement', facets: [], basisRefs: [] })).id, legacyId);
  assert.equal(memory.store.list({ botId: 'a' }).length, 1);
}));

test('raw Matrix edits and known redactions preserve provenance and invalidate old facts', async () => withMemory(async memory => {
  memory.ingest('a', observedMemoryInput(matrix('original', '周六开放'), [{ id: '@lin:a.test', kind: 'human' }]));
  const old = await memory.remember('a', { text: '周六开放', predicate: 'opening', subjectId: 'project:open-day' });
  const edited = matrix('edit', '* 周日开放', { content: { body: '* 周日开放', 'm.new_content': { body: '周日开放' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$original' } } });
  memory.observe('a', observedMemoryInput(edited, [{ id: '@lin:a.test', kind: 'human' }]));
  assert.equal(memory.store.source(old.sourceRefs[0].id).body, '周日开放');
  assert.equal(memory.store.derivation(memory.store.get(old.id)), 'source-revised');
  const redaction = matrix('redaction', '', { type: 'm.room.redaction', sender: '@moderator:test', content: { redacts: '$original' } });
  memory.observe('a', observedMemoryInput(redaction));
  assert.equal(memory.store.source(old.sourceRefs[0].id).withdrawn, true);
  assert.equal(memory.store.source(old.sourceRefs[0].id).authorId, 'matrix:@lin:a.test');
  assert.equal(memory.store.source(old.sourceRefs[0].id).retractedBy, 'matrix:@moderator:test');
  assert.equal(memory.attentionView('a', { roomId: '!river:test' }).currentClaims.length, 0);
  assert.ok(memory.attentionView('a', { roomId: '!river:test' }).changes.some(change => change.derivation === 'source-withdrawn'));
}));

test('an edit before its original retains its own identity and cannot poison later original ingress', async () => withMemory(async memory => {
  const edit = observedMemoryInput(matrix('edit-first', '周日开放', { content: { body: '周日开放', 'm.relates_to': { rel_type: 'm.replace', event_id: '$original-late' } } }));
  memory.observe('a', edit);
  assert.ok(memory.attentionView('a', { roomId: '!river:test' }).historyGaps.some(gap => gap.kind === 'unverified-edit-relation' && gap.reason === 'target-unavailable'));
  memory.observe('a', observedMemoryInput(matrix('original-late', '周六开放')));
  const original = memory.store.sources().find(source => source.eventId === '$original-late');
  assert.equal(original.body, '周六开放');
  memory.observe('a', edit);
  assert.equal(memory.store.source(original.id).body, '周日开放');
  assert.equal(memory.store.source(original.id).revision, 2);
  assert.equal(memory.attentionView('a', { roomId: '!river:test' }).historyGaps.some(gap => gap.kind === 'unverified-edit-relation'), false);
}));

test('an edit from a different author is retained as a relation without changing the target source', async () => withMemory(async memory => {
  const original = memory.ingest('a', input('owned', '本人通常中文'));
  const edit = observedMemoryInput(matrix('foreign-edit', '别人把偏好改成英文', { sender: '@other:test', content: { body: '别人把偏好改成英文', 'm.relates_to': { rel_type: 'm.replace', event_id: '$owned' } } }));
  memory.observe('a', edit);
  assert.equal(memory.store.source(original.sourceRefs[0].id).body, '本人通常中文');
  const view = memory.attentionView('a', { roomId: '!river:test' });
  assert.ok(view.historyGaps.some(gap => gap.kind === 'unverified-edit-relation' && gap.reason === 'author-mismatch'));
  assert.ok(view.recentSources.some(source => source.eventId === '$foreign-edit' && source.authorId === 'matrix:@other:test'));
}));

test('an unavailable redaction target remains an explicit gap and a late original cannot revive it', async () => withMemory(async memory => {
  const redaction = matrix('redaction', '', { type: 'm.room.redaction', redacts: '$late' });
  const receipt = memory.observe('a', observedMemoryInput(redaction), { streamId: 'matrix', cursor: 1 });
  assert.equal(receipt.watermarks.receivedThrough, 1);
  assert.equal(receipt.watermarks.pendingReviewCount, 0);
  const view = memory.attentionView('a', { roomId: '!river:test' });
  assert.ok(view.historyGaps.some(gap => gap.kind === 'unavailable-redaction-target' && gap.targetEventId === '$late'));
  assert.equal(view.recentSources[0].role, 'source-retraction-notice');
  memory.observe('a', observedMemoryInput(matrix('late', '已删除的旧安排')));
  assert.equal(memory.store.sources().find(source => source.eventId === '$late').withdrawn, true);
  assert.equal(memory.attentionView('a', { roomId: '!river:test' }).recentSources.some(source => source.body.includes('已删除的旧安排')), false);
  assert.equal(memory.attentionView('a', { roomId: '!river:test' }).historyGaps.some(gap => gap.kind === 'unavailable-redaction-target'), false);
}));

test('redacted visible history is metadata rather than conflicting new bytes from the original author', async () => withMemory(async memory => {
  const first = memory.ingest('a', input('original', '原始决定'));
  const saved = await memory.remember('a', { text: '原始决定', predicate: 'venue' });
  memory.observe('a', observedMemoryInput(matrix('redact', '', { type: 'm.room.redaction', redacts: '$original' })));
  const withdrawn = memory.store.source(first.sourceRefs[0].id);
  memory.ingest('a', { ...input('next', '继续讨论'), history: [{ ...input('original', '[message withdrawn]').event, withdrawn: true }] });
  assert.equal(memory.store.source(first.sourceRefs[0].id).revision, withdrawn.revision);
  assert.equal(memory.store.source(first.sourceRefs[0].id, 1).body, '原始决定');
  assert.equal(memory.store.derivation(memory.store.get(saved.id)), 'source-withdrawn');
  memory.ingest('b', { ...input('ask', '早先是什么？'), history: [{ ...input('unknown', '[message withdrawn]').event, withdrawn: true }] });
  const placeholder = memory.store.sources().find(source => source.eventId === '$unknown');
  assert.equal(placeholder.contentUnavailable, true);
  assert.equal(placeholder.body, '');
  assert.ok(memory.attentionView('b', { roomId: '!river:test' }).historyGaps.some(gap => gap.kind === 'withdrawn-content-unavailable'));
  memory.observe('b', input('unknown', '迟到的已撤回原文'));
  memory.observe('b', input('unknown', '迟到的已撤回原文'));
  assert.equal(memory.store.source(placeholder.id).withdrawn, true);
  assert.equal(memory.store.source(placeholder.id).originalContentRecovered, true);
  assert.equal(memory.attentionView('b', { roomId: '!river:test' }).recentSources.some(source => source.body.includes('迟到的已撤回原文')), false);
}));

test('each Bot sees its own observed sources and an observed old revision cannot reveal a newer unseen body', async () => withMemory(async memory => {
  const context = memory.ingest('a', input('fact', '旧内容'));
  await memory.remember('a', { text: '旧内容', predicate: 'venue', subjectId: 'project:open-day' });
  memory.observe('b', input('other', '另一位 Bot 的私有经历', { room: '!other:test' }));
  const edit = input('edit', '只有 b 看见的新内容'); edit.context.source.replacesEventId = '$fact';
  memory.observe('b', edit);
  const a = memory.attentionView('a', { roomId: '!river:test' });
  assert.equal(JSON.stringify(a).includes('只有 b 看见的新内容'), false);
  assert.equal(memory.attentionView('b', { roomId: '!river:test' }).currentClaims.length, 0);
  assert.equal(memory.readSource('a', context.sourceRefs[0]).body, '旧内容');
  assert.throws(() => memory.readSource('a', { id: context.sourceRefs[0].id, revision: 2 }), /MEMORY_SOURCE_NOT_OBSERVED/);
}));

test('an early relevant project decision survives many newer unrelated facts within the same room', async () => withMemory(async memory => {
  memory.ingest('a', input('project', '河湾使用二楼抽屉'));
  const wanted = await memory.remember('a', { text: '物料放二楼抽屉', subjectId: 'project:river', projectIds: ['project:river'], predicate: 'storage', claimState: 'confirmed', facets: ['decision'] });
  for (let index = 0; index < 40; index++) {
    memory.ingest('a', input(`noise${index}`, `其它事项${index}`, { sender: '@other:test', at: 2000 + index }));
    await memory.remember('a', { text: `其它事项${index}`, subjectId: `project:noise-${index}`, predicate: 'note' });
  }
  const view = memory.attentionView('a', { roomId: '!river:test', projectIds: ['project:river'], query: '物料在哪里？', budgetChars: 7000 });
  assert.ok(view.currentClaims.some(row => row.id === wanted.id));
  assert.ok(view.projectFacts.some(row => row.id === wanted.id));
  assert.equal(view.selection.wholeHistoryLoaded, false);
}));

test('attention event focus follows the observed speaker without moving the native Session context', async () => withMemory(async memory => {
  memory.ingest('a', input('pref-b', '通常英文', { sender: '@lin:b.test' }));
  const pref = await memory.remember('a', { text: '通常英文', predicate: 'language', scope: 'own', facets: ['preference'] });
  memory.ingest('a', input('active', '保持这个任务', { sender: '@song:test', room: '!other:test' }), { sessionId: 'active' });
  const active = memory.current('a', 'active');
  memory.observe('a', input('new-speaker', '这边现在如何？', { sender: '@lin:b.test', at: 5000 }));
  const view = memory.attentionView('a', { roomId: '!river:test', eventIds: ['$new-speaker'] });
  assert.equal(view.speaker.id, 'matrix:@lin:b.test');
  assert.ok(view.preferences.some(row => row.id === pref.id));
  assert.deepEqual(memory.current('a', 'active'), active);
  assert.equal(view.sourceRefs.some(ref => active.sourceRefs.some(old => old.id === ref.id)), false);
}));

test('a newer human correction ranks above a later readback of an older Bot draft without silently resolving conflict', async () => withMemory(async memory => {
  memory.ingest('a', input('draft', '旧文件：需要加购空白牌', { kind: 'bot', sender: '@bot:test', at: 1000 }));
  const draft = await memory.remember('a', { text: '空白牌采购清单：数量30、单价1，另购加购', subjectId: 'project:river', predicate: 'blank-cards', kind: 'inference', claimState: 'proposal' });
  memory.ingest('a', input('correct', '空白牌已含在30张里，不要额外采购', { at: 3000 }));
  const correction = await memory.remember('a', { text: '空白牌已包含在30张内，无需加购', subjectId: 'project:river', predicate: 'blank-cards', claimState: 'confirmed' });
  memory.observe('a', input('reread', '重新读取旧 Bot 文件：空白牌另购', { sender: '@bot:test', kind: 'bot', at: 4000 }));
  const view = memory.attentionView('a', { roomId: '!river:test', projectIds: ['project:river'], query: '空白牌采购清单数量单价加购', budgetChars: 16000 });
  const relevant = view.currentClaims.filter(row => row.predicate === 'blank-cards');
  assert.deepEqual(relevant.map(row => row.id), [correction.id, draft.id]);
  assert.equal(relevant[0].authority, 'direct-human');
  assert.equal(relevant[1].claimState, 'proposal');
  assert.equal(relevant[1].kind, 'inference');
  assert.deepEqual(relevant[0].conflicts, [draft.id]);
  assert.equal(relevant[0].resolution, 'unresolved');
  assert.equal(view.recentSources[0].eventId, '$correct');
}));

test('an unreviewed human change stays visible and a stable scoped preference survives unrelated work', async () => withMemory(async memory => {
  memory.ingest('a', input('pref', '通常用英文短表格', { sender: '@lin:b.test' }));
  const pref = await memory.remember('a', { text: '通常用英文短表格', predicate: 'custom-format', facets: ['preference'], scope: 'own' });
  memory.ingest('a', input('same-name', '给我中文五点'));
  await memory.remember('a', { text: '中文五点', predicate: 'custom-format', facets: ['preference'], scope: 'own' });
  memory.ingest('a', input('other-room', '这里详细些', { sender: '@lin:b.test', room: '!other:test' }));
  const local = await memory.remember('a', { text: '本群详细些', predicate: 'format', facets: ['preference'] });
  memory.observe('a', input('change', '场地取消，先不要安排', { sender: '@song:test', at: 4000 }));
  memory.ingest('a', input('current', '给我物料表', { sender: '@lin:b.test', at: 5000 }), { sessionId: 's' });
  const view = memory.contextSnapshot('a', 's');
  assert.ok(view.preferences.some(row => row.id === pref.id));
  assert.equal(view.currentClaims.some(row => row.id === local.id), false);
  assert.ok(view.recentSources.some(source => source.eventId === '$change' && !source.reviewed));
  assert.equal(view.speakerFacts.some(row => row.saidBy === 'matrix:@lin:a.test'), false);
}));

test('a recent actual tool observation precedes a human’s older estimate without erasing the conflict', async () => withMemory(async memory => {
  memory.ingest('a', input('estimate', '表格人数清单估计总数30，分组统计待核', { at: 1000 }));
  const estimate = await memory.remember('a', { text: '表格人数清单估计总数30，分组统计待核', subjectId: 'task:registration', predicate: 'row-count' });
  memory.observeTool('a', { sessionId: 's', callId: 'actual-count', name: 'bash', body: 'Actual downloaded CSV: 27 data rows; exit=0', timestamp: 4000 });
  const actual = await memory.remember('a', { text: '实测27行', subjectId: 'task:registration', predicate: 'row-count', kind: 'observation' });
  const view = memory.attentionView('a', { roomId: '!river:test', subjectIds: ['task:registration'], query: '表格人数清单估计总数分组统计待核', budgetChars: 16000 });
  const relevant = view.currentClaims.filter(row => row.predicate === 'row-count');
  assert.deepEqual(relevant.map(row => row.id), [actual.id, estimate.id]);
  assert.equal(relevant[0].authority, 'tool-observation');
  assert.equal(relevant[0].saidBy, 'tool:bash');
  assert.deepEqual(relevant[0].conflicts, [estimate.id]);
  assert.equal(relevant[0].resolution, 'unresolved');
}));

test('source and memory revisions invalidate dependent drafts, including multi-hop derived understanding', async () => withMemory(async memory => {
  const source = memory.ingest('a', input('venue', '使用二楼'));
  const basis = await memory.remember('a', { text: '使用二楼', predicate: 'venue', subjectId: 'project:river' });
  const draft = await memory.remember('a', { text: '二楼海报草稿', kind: 'inference', subjectId: 'project:river', basisRefs: [{ id: basis.id, revision: basis.revision }] });
  const summary = await memory.remember('a', { text: '草稿摘要', kind: 'inference', subjectId: 'project:river', basisRefs: [{ id: draft.id, revision: draft.revision }] });
  memory.ingest('a', input('correction', '改到一楼'));
  await memory.remember('a', { text: '使用一楼', predicate: 'venue', subjectId: 'project:river', replaceId: basis.id });
  assert.equal(memory.store.derivation(memory.store.get(draft.id)), 'basis-superseded');
  assert.equal(memory.store.derivation(memory.store.get(summary.id)), 'basis-basis-superseded');
  const view = memory.attentionView('a', { roomId: '!river:test', projectIds: ['project:river'] });
  assert.equal(view.currentClaims.some(row => row.id === draft.id), false);
  assert.ok(view.changes.some(row => row.id === draft.id && row.requiresReview));
  assert.equal(memory.store.basisStatus({ sourceRefs: source.sourceRefs }).status, 'current');
  memory.store.retractSource(source.sourceRefs[0].id);
  assert.equal(memory.store.basisStatus({ sourceRefs: source.sourceRefs }).status, 'needs-review');
}));

test('a source edit during external save cannot publish a stale new fact', async () => withMemory(async memory => {
  const context = memory.ingest('a', input('fact', '旧安排'));
  memory.backend = { save: async row => {
    memory.store.observe({ ...memory.store.source(context.sourceRefs[0].id), revision: 2, body: '新安排' });
    return { bodyDigest: row.bodyDigest, nativeId: row.id };
  }, close: async () => {} };
  await assert.rejects(memory.remember('a', { text: '旧安排' }), /MEMORY_SOURCE_STALE/);
  assert.equal(memory.store.list({ botId: 'a' }).length, 0);
  assert.equal(memory.store.list({ botId: 'a', history: true })[0].status, 'pending');
}));

test('review publication is atomic when a later body receipt fails', async () => withMemory(async memory => {
  const original = memory.ingest('a', input('old', '旧安排'));
  const old = await memory.remember('a', { text: '旧安排', predicate: 'venue' });
  memory.observe('a', input('fix', '改一楼，并带地图'));
  const packet = memory.reviewPacket('a', { query: '安排', roomId: '!river:test' });
  const fix = packet.sources.find(source => source.eventId === '$fix');
  let saves = 0;
  memory.backend = { save: async row => ({ bodyDigest: ++saves === 2 ? 'wrong' : row.bodyDigest, nativeId: row.id }), close: async () => {} };
  await assert.rejects(memory.applyReview('a', packet, [
    { op: 'replace', replaceId: old.id, text: '改为一楼', sourceIds: [fix.id] },
    { op: 'add', text: '带地图', sourceIds: [fix.id] },
  ]), /MEMORY_BODY_MISMATCH/);
  assert.equal(memory.store.get(old.id).status, 'active');
  assert.deepEqual(memory.store.list({ botId: 'a' }).map(row => row.id), [old.id]);
  assert.equal(memory.store.source(original.sourceRefs[0].id).withdrawn, false);
}));

test('retrospective corrects one person through the existing versioned store and rejects a stale target', async () => withMemory(async memory => {
  memory.ingest('a', input('old', '中文表格'));
  const old = await memory.remember('a', { text: '中文表格', predicate: 'language', scope: 'own' });
  memory.observe('a', input('correction', '一般用英文表格', { at: 4000 }));
  const result = await memory.retrospect('a', { kind: 'person', id: '@lin:a.test', query: '语言偏好' }, async packet => {
    const correction = packet.sources.find(source => source.eventId === '$correction');
    assert.ok(packet.existingMemories.some(row => row.id === old.id && row.revision === 1));
    return JSON.stringify({ changes: [{ op: 'replace', replaceId: old.id, text: '一般用英文表格', predicate: 'language', scope: 'own', sourceIds: [correction.id], facets: ['preference'] }] });
  });
  assert.equal(result.mode, 'source-checked-review');
  assert.equal(result.changes[0].revision, 2);
  assert.equal(memory.store.get(old.id).status, 'superseded');
  const current = result.changes[0];
  await assert.rejects(memory.retrospect('a', { kind: 'person', id: '@lin:a.test' }, async packet => {
    memory.forget('a', { id: current.id, scope: 'own' });
    return JSON.stringify({ changes: [{ op: 'forget', replaceId: current.id, sourceIds: [packet.sources[0].id] }] });
  }), /MEMORY_REVISION_CONFLICT/);
}));

test('a retrospective result keeps original evidence addressable without reinjecting its unbounded body', async () => withMemory(async memory => {
  memory.observe('a', input('long-source', '原文'.repeat(18000)));
  const result = await memory.retrospect('a', { kind: 'person', id: '@lin:a.test', query: '回顾' }, async packet => {
    assert.equal(packet.sources[0].truncated, true);
    return JSON.stringify({ changes: [{ op: 'add', text: '来源很长，内容尚未全部核对', subjectId: 'matrix:@lin:a.test', scope: 'own',
      kind: 'inference', claimState: 'uncertain', sourceIds: [packet.sources[0].id] }] });
  });
  assert.ok(JSON.stringify(result).length <= 24000);
  assert.equal(result.totalChanges, 1);
  assert.equal(result.changes[0].sources, undefined);
  assert.equal(memory.readSource('a', result.changes[0].sourceRefs[0]).body.length, 36000);
}));

test('person and project profiles distinguish equal names, unknown identities and another Bot’s private source', async () => withMemory(async memory => {
  for (const sender of ['@lin:a.test', '@lin:b.test']) {
    memory.ingest('a', input(sender, sender.endsWith('a.test') ? '中文' : 'English', { sender }));
    await memory.remember('a', { text: sender.endsWith('a.test') ? '中文' : 'English', predicate: 'language', scope: 'own', facets: ['preference'] });
  }
  memory.ingest('a', input('project', '河湾预算确定'));
  const projectFact = await memory.remember('a', { text: '河湾预算确定', subjectId: 'project:river', projectIds: ['open-day-2026'], claimState: 'confirmed' });
  memory.observe('b', input('secret', '只被 b 看到', { sender: '@private:test', room: '!private:test' }));
  const list = memory.profiles('a', { kind: 'person' });
  assert.equal(list.items.filter(item => item.name === '林青').length, 2);
  assert.ok(list.items.every(item => item.kind === 'person' && item.entityKind === 'human'));
  assert.equal(list.items.some(item => item.id === 'matrix:@private:test'), false);
  const profile = memory.profile('a', { kind: 'person', id: '@lin:b.test' });
  assert.equal(profile.identity.id, 'matrix:@lin:b.test');
  assert.deepEqual(profile.view.preferences.map(row => row.text), ['English']);
  assert.equal(profile.view.currentClaims.some(row => row.id === projectFact.id), false);
  const projects = memory.profiles('a', { kind: 'project' });
  assert.ok(projects.items.every(item => item.kind === 'project' && item.entityKind));
  assert.ok(projects.items.some(item => item.id === 'open-day-2026'));
  assert.throws(() => memory.profile('a', { kind: 'person', id: '@private:test' }), /MEMORY_PROFILE_NOT_KNOWN/);
}));

test('bounded views and review packets stay within their budgets and pure reads do not advance processing', async () => withMemory(async memory => {
  for (let index = 0; index < 14; index++) {
    memory.ingest('a', input(`long${index}`, `重要事实${index} ` + '河湾'.repeat(700), { at: index + 1000 }));
    await memory.remember('a', { text: `长期${index} ` + '相关'.repeat(500), subjectId: 'project:river', predicate: `field-${index}` });
  }
  const before = memory.store.watermarks('a');
  const view = memory.attentionView('a', { roomId: '!river:test', projectIds: ['project:river'], budgetChars: 4096,
    workView: { text: 'large'.repeat(5000) }, pendingQuestions: ['question'.repeat(2000)] });
  assert.ok(JSON.stringify(view).length <= 4096, JSON.stringify(view).length);
  assert.ok(Object.keys(view.budget.omitted).length > 0);
  assert.equal(view.workViewOmitted, 'runtime view exceeds memory context budget');
  assert.deepEqual(memory.store.watermarks('a'), before);
  const packet = memory.reviewPacket('a', { projectIds: ['project:river'], roomId: '!river:test', budgetChars: 6000 });
  assert.ok(JSON.stringify(packet).length <= 6000);
  assert.ok(packet.sources.length <= 24);
  memory.acknowledgeContext('a', view);
  assert.equal(memory.store.watermarks('a').contextThrough, before.receivedThrough);
  assert.equal(memory.store.watermarks('a').reviewedThrough, 0);
}));

test('structured native actor/context preserves stable human identities and automatic review policy only selects background work', () => {
  const full = input('matrix', '原始发言');
  assert.equal(nativeMemoryInput({ source: { memoryContext: full }, text: 'routing envelope' }), full);
  const alice = nativeMemoryInput({ source: { kind: 'user', actor: { id: '@alice:test', kind: 'human', name: '相同名字' },
    context: { source: { eventId: '$alice', roomId: '!river:test', timestamp: 0 } } }, text: 'hello', home: '/synthetic', sessionId: 's', sequence: 2, timestamp: 42 });
  assert.equal(alice.context.source.sender.id, '@alice:test');
  assert.equal(alice.context.source.transport, 'matrix');
  assert.equal(alice.context.source.timestamp, 0);
  assert.equal(alice.event.eventId, '$alice');
  assert.equal(automaticReviewAllowed({}, 'native'), true);
  const ids = [];
  const config = { memoryReviewForBot: id => { ids.push(id); return id !== 'legacy'; } };
  assert.equal(automaticReviewAllowed(config, 'legacy'), false);
  assert.equal(automaticReviewAllowed(config, 'native'), true);
  assert.deepEqual(ids, ['legacy', 'native']);
  assert.equal(automaticReviewAllowed({ memoryReview: false, ...config }, 'native'), false);
});
