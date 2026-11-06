import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { packageRoot } from '../src/paths.mjs';
import { MemoryTestHost, MODEL, delay } from './memory-host.mjs';

await mkdir(join(packageRoot, '.local'), { recursive: true });
const directory = await mkdtemp(join(packageRoot, '.local/memory-compat-'));
const host = new MemoryTestHost(directory), hash = value => createHash('sha256').update(value).digest('hex');
const report = { startedAt: new Date().toISOString(), status: 'failed', model: MODEL, checks: [], turns: [] };
async function owner(endpoint, payload) {
  const response = await fetch(`http://127.0.0.1:${host.port}/api/bot`, { method: 'POST',
    headers: { 'content-type': 'application/json', cookie: host.cookie }, body: JSON.stringify({ endpoint, payload }), signal: AbortSignal.timeout(300000) });
  const result = await response.json(); if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value;
}
function request(n, sender, body) { return { requestId: `compat-${n}`, botId: '@bot0:memory.test',
  event: { eventId: `$compat-${n}`, roomId: '!conflict:memory.test', senderId: sender, body }, history: [],
  context: { room: { id: '!conflict:memory.test', name: '砂桥协作组' }, source: { transport: 'matrix', roomId: '!conflict:memory.test',
    timestamp: Date.now(), sender: { id: sender, name: '林青', kind: 'human' } } } }; }
async function turn(n, sender, text) {
  const result = await host.api('turn', { request: request(n, sender, text) }); report.turns.push(result);
  assert.equal(result.record.status, 'completed'); assert.ok(!result.reviewError, result.reviewError); return result.record;
}
try {
  await host.start(); const bots = report.bots = await host.api('init');
  const room = await owner('create-room', { members: bots.map(bot => bot.dsBotId), admin: bots[0].dsBotId, name: '归档组', greet: false });
  report.room = { id: room.id, name: room.name }; await host.stop();
  const files = [
    [join(host.home, 'bot/memory/bots', bots[0].dsBotId, 'MEMORY.md'), '# Memory\n\n- 旧档案代号是落霞-403。\n'],
    [join(host.home, 'bot/memory/team/MEMORY.md'), '# Team\n\n- 团队打印机的名字是云舟-52。\n'],
    [join(host.home, 'bot/memory/groups', room.id, 'MEMORY.md'), '# Group\n\n- 归档组资料存放在银色盒-16。\n'],
  ];
  for (const [file, content] of files) { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, content); }
  await host.start(); await host.api('init');
  let snapshot;
  for (let i = 0; i < 120; i++) { snapshot = await host.api('memory'); if (snapshot.entries.filter(row => row.kind === 'legacy' && row.status === 'active').length === 5) break; await delay(250); }
  const legacy = snapshot.entries.filter(row => row.kind === 'legacy'); assert.equal(legacy.length, 5);
  assert.ok(legacy.every(row => row.status === 'active'));
  assert.ok(snapshot.sources.filter(row => row.transport === 'legacy').every(row => row.authorKind === 'bot'));
  for (const [file, content] of files) assert.equal(hash(await readFile(file)), hash(content));
  report.checks.push('personalTeamAndNativeGroupMarkdownImportedWithoutInventedHumanAuthor', 'legacyFilesUnchanged');
  await host.stop(); await host.start(); const rebound = await host.api('init');
  assert.deepEqual(rebound.map(bot => bot.dsBotId), bots.map(bot => bot.dsBotId));
  const again = await host.api('memory'); assert.deepEqual(again.entries.filter(row => row.kind === 'legacy').map(row => row.id).sort(), legacy.map(row => row.id).sort());
  report.checks.push('legacyMigrationIdempotentAfterRestart');
  const groupBody = { roomId: room.id };
  const before = await owner('memory-view', groupBody); assert.equal(before.entries.length, 3);
  const answer = await owner('memory-ask', { ...groupBody, text: '请记住归档组的新设备信息：扫描仪的标记是黄鹂-66。简短确认。' });
  const entry = answer.view.entries.find(row => row.text.includes('黄鹂-66')); assert.ok(entry);
  assert.equal(entry.memoryScope, `room:${room.id}`); assert.ok(answer.changes.some(change => change.ok && change.scope === 'group'));
  report.panelAnswer = answer.reply; report.checks.push('nativeGroupPanelModelEditUsesGroupScope');
  for (let n = 0; n < 2; n++) {
    const removed = await owner('memory-forget', { ...groupBody, id: entry.id }); assert.ok(!removed.entries.some(row => row.id === entry.id));
    const history = await owner('memory-history', groupBody); const change = history.rows.find(row => row.op === 'remove' && !row.restored);
    assert.ok(change); const restored = await owner('memory-restore', { ...groupBody, id: change.id });
    const row = restored.entries.find(row => row.id === entry.id); assert.ok(row); assert.deepEqual(row.sourceRefs, entry.sourceRefs);
  }
  report.checks.push('nativeGroupPanelRepeatedForgetAndRestorePreservesOriginalEvidence');
  await turn(1, '@lin:a.test', '请 remember 保存一条尚有争议的项目判断：砂桥项目的上线日为周六。subjectId=project:砂桥，predicate=release-day，kind=stated，scope=group；保留我是 @lin:a.test 这个来源，不代表另一个人同意。');
  await turn(2, '@lin:b.test', '我是另一个林青 @lin:b.test。我认为砂桥项目上线日是周日，与 @lin:a.test 的说法不同，尚未达成一致。请 remember 保留两条并列说法，不替换他的记录。subjectId=project:砂桥，predicate=release-day，kind=stated，scope=group。');
  const conflictReply = await turn(3, '@song:memory.test', '请 recall 查询砂桥项目的上线日。还没有共同决定，请分别报告两位原始说话人的完整账号和各自说法，不要自选一个日子。');
  assert.ok(conflictReply.toolReceipts.some(row => row.name === 'recall' && row.status === 'completed'));
  for (const text of ['@lin:a.test', '@lin:b.test', '周六', '周日']) assert.ok(conflictReply.text.includes(text));
  snapshot = await host.api('memory');
  const conflicting = snapshot.entries.filter(row => row.derivation === 'current' && row.subjectId === 'project:砂桥' && row.predicate === 'release-day');
  assert.ok(conflicting.some(row => row.text.includes('周六'))); assert.ok(conflicting.some(row => row.text.includes('周日')));
  report.conflicting = conflicting.map(({ receipt, index, ...row }) => row); report.checks.push('realModelKeepsConflictingSpeakersSeparate');
  await host.api('detach'); const local = await host.api('local', { text: '请 recall scope all 查找旧档案代号，简短报告，来源不明的部分不要猜作者。' });
  assert.ok(local.text.includes('落霞-403')); report.localReply = local.text; report.checks.push('legacyRecallInDisconnectedNativeChat');
  report.memory = await host.api('memory'); report.status = 'passed';
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  await host.stop(); report.finishedAt = new Date().toISOString(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks, error: report.error, directory }, null, 2));
}
