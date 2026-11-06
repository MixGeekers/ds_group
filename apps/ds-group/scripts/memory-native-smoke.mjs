import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packageRoot } from '../src/paths.mjs';
import { MemoryTestHost, MODEL } from './memory-host.mjs';

await mkdir(join(packageRoot, '.local'), { recursive: true });
const directory = await mkdtemp(join(packageRoot, '.local/memory-native-'));
const host = new MemoryTestHost(directory);
const report = { startedAt: new Date().toISOString(), model: MODEL, status: 'failed', checks: [], turns: [] };
function request(n, body) { return { requestId: `memory-native-${n}`, botId: '@bot0:memory.test',
  event: { eventId: `$memory-${n}`, roomId: '!north:memory.test', senderId: '@lin:a.test', body },
  context: { source: { transport: 'matrix', roomId: '!north:memory.test', eventId: `$memory-${n}`,
    sender: { id: '@lin:a.test', name: '林青', kind: 'human' }, timestamp: Date.now() }, room: { name: '北组' } }, history: [] }; }
try {
  await host.start(); report.bots = await host.api('init'); console.log(JSON.stringify({ stage: 'ready', directory, bots: report.bots.map(bot => bot.dsBotId) }));
  const first = await host.api('turn', { request: request(1, '我叫林青。请记住：北组的河湾项目，离线备份标签是「苍鹭-8472」，存放在蓝色硬盘。以后问备份标签就用这一条，简短确认即可。') });
  report.turns.push(first); assert.equal(first.record.status, 'completed', JSON.stringify(first)); assert.ok(!first.reviewError, first.reviewError);
  console.log(JSON.stringify({ stage: 'remembered', text: first.record.text }));
  const memory = await host.api('memory'); assert.ok(memory.entries.some(row => row.status === 'active' && row.text.includes('苍鹭-8472')));
  assert.ok(memory.entries.filter(row => row.text.includes('苍鹭-8472')).every(row => row.sourceRefs.length === 1));
  assert.ok(!memory.entries.some(row => /runtime context|AGENTS.md|skill-catalog/.test(row.text)));
  assert.ok(memory.sources.every(source => source.eventId === '$memory-1'));
  report.checks.push('realModelRememberAndAutoReview');
  report.compaction = await host.api('compact'); assert.equal(report.compaction.compacted, true); report.checks.push('nativeCompaction');
  await host.stop(); await host.start(); const rebound = await host.api('init'); assert.equal(rebound[0].dsBotId, report.bots[0].dsBotId); report.checks.push('restartSameBotIdentity');
  const second = await host.api('turn', { request: request(2, '请先 recall 查询北组河湾项目的离线备份，然后只答标签和存放介质，不要猜。') });
  report.turns.push(second); assert.equal(second.record.status, 'completed', JSON.stringify(second)); assert.ok(second.record.text.includes('苍鹭-8472'));
  assert.ok(second.record.toolReceipts.some(tool => tool.name === 'recall' && tool.status === 'completed')); report.checks.push('semanticRecallAfterCompactionAndRestart');
  console.log(JSON.stringify({ stage: 'recalled', text: second.record.text }));
  await host.api('detach'); const local = await host.api('local', { text: '在原生普通聊天中，请 recall scope all 查询刚才北组河湾项目的备份标签和介质，简短回答。' });
  report.local = local; assert.ok(local.text.includes('苍鹭-8472')); assert.equal(local.bot.id, report.bots[0].dsBotId); report.checks.push('disconnectedNativeChatRetainsMemory');
  report.memory = await host.api('memory'); report.status = 'passed';
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally { await host.stop(); report.finishedAt = new Date().toISOString(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: report.checks, error: report.error, directory }, null, 2)); }
