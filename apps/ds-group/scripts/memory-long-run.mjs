import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { packageRoot } from '../src/paths.mjs';
import { MemoryTestHost, MODEL, delay } from './memory-host.mjs';
import { buildCorpus, rooms, roomNames, senders } from './memory-long-corpus.mjs';

await mkdir(join(packageRoot, '.local'), { recursive: true });
const directory = await mkdtemp(join(packageRoot, '.local/memory-long-'));
const host = new MemoryTestHost(directory), corpus = buildCorpus();
const hash = text => createHash('sha256').update(text).digest('hex');
const report = { version: 1, model: MODEL, status: 'running', startedAt: new Date().toISOString(),
  topology: 'real local DSH + native DS-Bot bridge with synthetic Matrix envelopes + local Ombre/Harrier',
  plannedRounds: 240, plannedCheckpoints: 72, rounds: [], attempts: [], checkpoints: [], maintenance: [], failures: [], embeddingByBoot: [] };
async function sourceHashes() {
  const result = {};
  async function walk(dir) { for (const entry of await readdir(join(packageRoot, dir), { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`; if (entry.isDirectory()) await walk(file);
    else if (/\.(?:mjs|js|py)$/.test(file)) result[file] = hash(await readFile(join(packageRoot, file)));
  } }
  for (const dir of ['memory', 'service/ombre', 'dsh-connect', 'dsh-plugin', 'src', 'vendor/ds-bot/src/host']) await walk(dir);
  for (const name of ['memory-long-corpus', 'memory-long-run', 'memory-host', 'memory-host-plugin']) result[`scripts/${name}.mjs`] = hash(await readFile(join(packageRoot, `scripts/${name}.mjs`)));
  return result;
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
const object = text => { try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { return null; } };
const same = (text, value) => String(text).replace(/[\s，,。:：、\-「」“”]/g, '').includes(String(value).replace(/[\s，,。:：、\-「」“”]/g, ''));
const account = value => typeof value === 'string' ? value.replace(/^(?:matrix:|room:)/, '') : value;
function queryFormat(step) {
  if (step.type === 'query') return '\n严格只输出 JSON：{"value":"当前字段值","roomId":"适用群完整ID","speakerId":"原始说话人完整账号"}。';
  if (step.type === 'identity-query') return '\n严格只输出 JSON，以两个完整账号为键，每个值包含 language、format、name。';
  if (step.type === 'expiry-query') return '\n严格只输出 JSON：{"status":"expired 或 current 或 unknown"}。';
  if (step.type === 'withdraw-query') return '\n严格只输出 JSON：{"status":"withdrawn 或 current 或 unknown"}。';
  if (step.type === 'quote-query') return '\n严格只输出 JSON：{"relayerId":"转述者完整账号","saidBy":"声称原作者完整账号","official":true或false,"officialValue":"原项目记录的标签"}。';
  return '';
}
function check(step, record, n) {
  const checks = [], data = object(record.text || '');
  const test = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  if (step.type.includes('query')) {
    test('usesRecall', record.toolReceipts.some(tool => tool.name === 'recall' && tool.status === 'completed'));
    test('structuredAnswer', data);
    if (step.type === 'query') {
      const fact = corpus.facts[step.fact];
      let matched = same(data?.value, fact.value);
      if (fact.attribute === '发布时段') {
        const weekdays = { 二: 2, 三: 3, 四: 4, 五: 5 };
        const expectedDay = weekdays[fact.value[1]], expectedHour = fact.value.match(/\d+/)?.[0];
        const normalized = String(data?.value).replace(/星期|礼拜/g, '周').replace(/十一/g, '11').replace(/十/g, '10').replace(/九/g, '9');
        matched = (normalized.includes(`周${fact.value[1]}`) || normalized.includes(`周${expectedDay}`)) && normalized.includes(expectedHour);
      }
      test('correctCurrentValue', matched); test('correctRoom', account(data?.roomId) === rooms[fact.room]); test('correctOriginalSpeaker', account(data?.speakerId) === senders[fact.sender]);
      if (step.longGap) test('over100TurnsSinceLearning', n - fact.learnedAt >= 100);
    } else if (step.type === 'identity-query') {
      const identities = Object.fromEntries(Object.entries(data || {}).map(([id, value]) => [account(id), value]));
      const a = identities[senders[0]], b = identities[senders[1]];
      test('firstPersonChinese', /中文|Chinese/i.test(a?.language)); test('firstPersonRenamed', a?.name === '青禾');
      test('secondPersonEnglish', /英文|English/i.test(b?.language)); test('secondPersonNotMerged', b?.name === '林青');
      test('firstPersonBriefFormat', /五|5|five/i.test(a?.format));
      test('secondPersonDetailedTable', /详|detail/i.test(b?.format) && /表|table|spreadsheet/i.test(b?.format));
    } else if (step.type === 'expiry-query') test('expired', data?.status === 'expired');
    else if (step.type === 'withdraw-query') test('withdrawn', data?.status === 'withdrawn');
    else if (step.type === 'quote-query') {
      test('relayer', account(data?.relayerId) === senders[2]); test('reportedSpeaker', account(data?.saidBy) === senders[1]);
      test('notOfficial', data?.official === false); test('originalOfficialValue', data?.officialValue === corpus.facts[0].value);
    }
    report.checkpoints.push({ round: n, type: step.type, checks, passed: checks.every(item => item.passed), text: record.text });
  }
  if (step.type === 'delegate' || step.type === 'relay') {
    test('nativeDelegationTool', record.toolReceipts.some(tool => tool.name === 'message_bot' && tool.status === 'completed'));
    test('delegatedResult', record.text.includes(step.expected));
  }
  if (step.type === 'tool-evidence') test('computedHash', record.text.includes(hash(step.hashText)));
  if (checks.some(item => !item.passed)) report.failures.push({ round: n, type: step.type, checks: checks.filter(item => !item.passed), text: record.text });
  return checks;
}
async function callWithRetry(step, n) {
  const timestamp = Date.now();
  const request = { requestId: `long-${n}`, botId: `@bot${step.index}:memory.test`,
    event: { eventId: `$long-${n}`, roomId: rooms[step.room], senderId: senders[step.sender], body: step.body + queryFormat(step) },
    context: { room: { id: rooms[step.room], name: roomNames[step.room] },
      source: { transport: 'matrix', roomId: rooms[step.room], eventId: `$long-${n}`, timestamp,
        sender: { id: senders[step.sender], name: step.sender === 0 && n >= 44 ? '青禾' : step.sender === 2 ? '宋禾' : '林青', kind: 'human' } } }, history: [] };
  if (step.type === 'expiry') request.event.body += `\n明确到期时间：${new Date(timestamp + 120000).toISOString()}（epoch ${timestamp + 120000}）。`;
  for (let attempt = 0; attempt < 8; attempt++) {
    request.requestId = `long-${n}-attempt-${attempt}`;
    let result;
    try { result = await host.api('turn', { index: step.index, request }); }
    catch (error) { result = { transportError: error.message, record: { requestId: request.requestId, status: 'unknown', text: '', toolReceipts: [], artifacts: [], calls: [] } }; }
    report.attempts.push({ round: n, attempt, ...result }); await save();
    if (result.record.status === 'completed' && !result.reviewError) return result.record;
    if (result.record.status === 'completed' && result.reviewError) {
      await delay(15000);
      try { await host.api('flush'); return result.record; } catch { /* pending review is retained */ }
    }
    if (result.record.status === 'unknown') {
      let usage;
      try { usage = (await host.api('memory')).usage; } catch { /* preserve unknown usage below */ }
      report.embeddingByBoot.push({ ...(usage || { complete: false }), boot: host.boot, reason: 'recovery' });
      await host.stop(); await host.start(); await host.api('init');
      report.maintenance.push({ type: 'recovery-restart', round: n, at: new Date().toISOString(), embeddingSnapshot: Boolean(usage) });
    }
    console.log(JSON.stringify({ round: n, status: result.record.status, reviewError: result.reviewError, retry: attempt + 1 }));
    await delay(Math.min(60000, 10000 * (attempt + 1)));
  }
  throw new Error(`Round ${n} did not complete after 8 attempts`);
}
try {
  report.sourceHashes = await sourceHashes();
  await writeFile(join(directory, 'corpus.json'), JSON.stringify(corpus, null, 2)); report.corpusHash = hash(JSON.stringify(corpus));
  await save(); await host.start(); report.bots = await host.api('init');
  assert.equal(report.bots.length, 3); console.log(JSON.stringify({ stage: 'started', directory, model: MODEL, rounds: 240 }));
  for (const [n, step] of corpus.steps.entries()) {
    const record = await callWithRetry(step, n); const checks = check(step, record, n);
    report.rounds.push({ round: n, type: step.type, bot: step.index, room: step.room, requestId: record.requestId, sessionId: record.sessionId, checks, finishedAt: new Date().toISOString() });
    if (step.type === 'file') {
      const artifact = record.artifacts.find(item => (item.name || item.path || '').includes(step.artifact));
      const path = artifact?.path || artifact?.filePath;
      let bytes = ''; if (path) bytes = await readFile(path, 'utf8').catch(() => '');
      if (!bytes.includes(String(step.expectedNumber)) || !bytes.includes(rooms[step.room])) report.failures.push({ round: n, type: 'artifact', artifact, reason: 'file missing expected number or room' });
    }
    if (n < 36) {
      const snapshot = await host.api('memory'); const fact = corpus.facts[step.fact];
      if (!snapshot.entries.some(row => row.botId === report.bots[step.index].dsBotId && row.status === 'active' && same(row.text, fact.attribute === '存放位置' && step.fact === 1 ? '蓝色硬盘-2号柜' : fact.value))) {
        throw new Error(`Initial learning missing in durable memory at round ${n}`);
      }
      assert.ok(snapshot.sources.every(source => source.transport === 'matrix' || source.authorKind === 'tool' || source.authorKind === 'bot'), 'runtime instructions contaminated source memory');
    }
    if ([47, 79, 111, 143, 175, 207].includes(n)) {
      const index = [47, 79, 111, 143, 175, 207].indexOf(n) % 3;
      const result = await host.api('compact', { index }); report.maintenance.push({ type: 'native-compaction', round: n, index, result });
      if (!result.compacted) report.failures.push({ round: n, type: 'compaction', result });
    }
    if ([63, 127, 191].includes(n)) {
      await host.api('flush'); const snapshot = await host.api('memory'); await writeFile(join(directory, `memory-before-restart-${n}.json`), JSON.stringify(snapshot, null, 2));
      report.embeddingByBoot.push(snapshot.usage);
      await host.stop(); await host.start(); const rebound = await host.api('init');
      assert.deepEqual(rebound.map(bot => bot.dsBotId), report.bots.map(bot => bot.dsBotId));
      report.maintenance.push({ type: 'planned-restart', round: n, identitiesPreserved: true });
    }
    await save(); console.log(JSON.stringify({ completed: n + 1, type: step.type, failures: report.failures.length, text: record.text.slice(0, 150) }));
  }
  await host.api('flush'); report.finalMemory = await host.api('memory');
  await host.api('detach', { index: 0 });
  report.detached = await host.api('local', { index: 0, text: '请在普通原生聊天中 recall scope all 查询北组河湾1号的备份标签和当前存放位置，保留来源，简短回答。' });
  assert.ok(report.detached.text.includes(corpus.facts[0].value)); assert.ok(report.detached.text.includes(corpus.facts[1].value));
  assert.equal(report.detached.bot.id, report.bots[0].dsBotId);
  report.embeddingByBoot.push((await host.api('memory')).usage);
  assert.deepEqual(await sourceHashes(), report.sourceHashes, 'Code changed during the long run');
  const callEvents = (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const calls = callEvents.filter(row => row.event === 'end');
  const ended = new Set(calls.map(row => row.callId));
  const unfinished = callEvents.filter(row => row.event === 'start' && !ended.has(row.callId));
  report.accounting = { calls: calls.length, failedCalls: calls.filter(row => row.status === 'failed').length,
    byPurpose: Object.fromEntries([...new Set(calls.map(row => row.purpose))].map(purpose => [purpose, calls.filter(row => row.purpose === purpose).length])),
    observedUsage: calls.reduce((total, row) => { for (const [key, value] of Object.entries(row.usage || {})) if (typeof value === 'number') total[key] = (total[key] || 0) + value; return total; }, {}),
    usageRecords: calls.filter(row => row.usage).length, unknownCalls: unfinished.length + calls.filter(row => !row.status).length,
    unfinishedCalls: unfinished, costComplete: false,
    modelIds: [...new Set(calls.map(row => row.model))],
    embedding: report.embeddingByBoot.reduce((sum, usage) => ({ indexCalls: sum.indexCalls + (usage?.indexCalls || 0), queryCalls: sum.queryCalls + (usage?.queryCalls || 0), complete: sum.complete && usage?.complete === true }), { indexCalls: 0, queryCalls: 0, complete: true }) };
  assert.deepEqual(report.accounting.modelIds, [MODEL]);
  assert.equal(report.checkpoints.length, 72);
  report.status = report.failures.length ? 'failed' : 'passed';
  if (report.status === 'failed') process.exitCode = 1;
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  await host.stop(); report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt); await save();
  console.log(JSON.stringify({ status: report.status, rounds: report.rounds.length, checkpoints: report.checkpoints.length,
    failures: report.failures.length, elapsedMs: report.elapsedMs, error: report.error, directory }, null, 2));
}
