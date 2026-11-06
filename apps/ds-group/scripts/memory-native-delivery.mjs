// Focused real-host regression for the native delivery gaps exposed by
// the frozen 240-round run. It does not replace or rewrite that run's failures.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { packageRoot } from '../src/paths.mjs';
import { MemoryTestHost, MODEL, delay } from './memory-host.mjs';
import { buildCorpus, rooms, roomNames, senders } from './memory-long-corpus.mjs';
import { parseBotOutput } from '../src/bot-node.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
await mkdir(join(packageRoot, '.local'), { recursive: true });
const directory = await mkdtemp(join(packageRoot, '.local/memory-delivery-'));
const host = new MemoryTestHost(directory);
const report = { startedAt: new Date().toISOString(), status: 'running', model: MODEL,
  checks: [], attempts: [], cases: [], sourceHashes: {}, topology: 'real local DSH/native DS-Bot + synthetic Matrix envelopes + Ombre/Harrier' };
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
async function flush() {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { await host.api('flush'); return; }
    catch (error) {
      report.attempts.push({ phase: 'flush', attempt, error: error.message }); await save();
      if (attempt === 7) throw error;
      await delay(Math.min(60000, 10000 * (attempt + 1)));
    }
  }
}
async function completedCalls() {
  return (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.event === 'end');
}
async function rawAssistant(record) {
  const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const matches = events.filter(event => event.sessionId === record.sessionId && event.type === 'assistant/message'
    && event.time >= Date.parse(record.startedAt) && event.time <= Date.parse(record.finishedAt));
  const message = matches.at(-1)?.data?.message || matches.at(-1)?.data;
  return (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}
try {
  for (const filename of ['dsh-connect/native-bridge.mjs', 'dsh-plugin/work-files.mjs', 'src/bot-node.mjs', 'memory/native.mjs', 'memory/service.mjs', 'scripts/memory-native-delivery.mjs']) {
    report.sourceHashes[filename] = hash(await readFile(join(packageRoot, filename)));
  }
  await save(); await host.start(); report.bots = await host.api('init');
  for (let index = 0; index < 3; index++) {
    const name = `native-present-${index}.txt`, expected = (63 + index) * 7;
    const request = { botId: `@bot${index}:memory.test`,
      event: { eventId: `$native-present-${index}`, roomId: rooms[index], senderId: senders[2],
        body: `请创建文件「${name}」，写入本轮样本统计：${63 + index} 乘以 7 的结果，以及当前群的完整 ID。请使用原生 present 给出实际文件，最后用普通中文简短说明即可。不要把这次任务要求当成长久偏好。` },
      context: { room: { id: rooms[index], name: roomNames[index] }, source: { transport: 'matrix', roomId: rooms[index],
        eventId: `$native-present-${index}`, timestamp: Date.now(), sender: { id: senders[2], name: '宋禾', kind: 'human' } } }, history: [] };
    let result;
    for (let attempt = 0; attempt < 8; attempt++) {
      request.requestId = `native-present-${index}-${attempt}`;
      result = await host.api('turn', { index, request });
      report.attempts.push({ phase: 'turn', index, attempt, ...result }); await save();
      if (result.record.status === 'completed') break;
      if (attempt === 7) throw new Error(`Native file ${index} never completed`);
      await delay(Math.min(60000, 10000 * (attempt + 1)));
    }
    await flush();
    assert.ok(result.record.toolReceipts.some(tool => tool.name === 'present' && tool.status === 'completed'));
    const file = result.record.artifacts.find(file => file.name === name);
    assert.ok(file, `Native present ${name} did not reach the bridge artifact list`);
    const bytes = await readFile(file.path), text = bytes.toString('utf8');
    assert.ok(text.includes(String(expected)), 'Actual file is missing the calculation result');
    assert.ok(text.includes(rooms[index]), 'Actual file is missing its original room');
    assert.equal(file.sha256, hash(bytes)); assert.equal(file.size, bytes.length);
    report.checks.push(`bot${index}NativePresentFileBytesAndRoom`);
    const before = (await completedCalls()).length;
    const retried = await host.api('turn', { index, request }); await flush();
    assert.deepEqual(retried.record.artifacts, result.record.artifacts);
    assert.equal((await completedCalls()).length, before, 'An idempotent transport retry generated new model work');
    report.checks.push(`bot${index}RetryReusesSameArtifactWithoutGeneration`);
    report.cases.push({ index, requestId: request.requestId, text: result.record.text, publicText: parseBotOutput(result.record.text, request.botId, []).text,
      file: { name: file.name, sha256: file.sha256, size: file.size, content: text }, toolReceipts: result.record.toolReceipts });
    await save(); console.log(JSON.stringify({ completed: index + 1, checks: report.checks.length }));
  }
  {
    const eventId = '$native-prefaced-envelope', name = 'native-envelope.txt', index = 2, room = 3;
    const request = { botId: `@bot${index}:memory.test`,
      event: { eventId, roomId: rooms[room], senderId: senders[2], body: `请用文件工具创建 ${name}，内容包括 13 乘以 11 的结果和当前群完整 ID。最后先写一句中文说明，再给出一个 JSON 代码块，包含 text 和 artifacts，artifacts 内列出文件绝对 path。此轮测试交付声明，不调用 present。不要将临时任务描述保存成长期偏好。` },
      context: { room: { id: rooms[room], name: roomNames[room] }, source: { transport: 'matrix', eventId, roomId: rooms[room],
        timestamp: Date.now(), sender: { id: senders[2], name: '宋禾', kind: 'human' } } }, history: [] };
    let result;
    for (let attempt = 0; attempt < 8; attempt++) {
      request.requestId = `native-prefaced-envelope-${attempt}`;
      result = await host.api('turn', { index, request });
      report.attempts.push({ phase: 'prefaced-envelope', attempt, ...result }); await save();
      if (result.record.status === 'completed') break;
      if (attempt === 7) throw new Error('Native prefaced envelope never completed');
      await delay(Math.min(60000, 10000 * (attempt + 1)));
    }
    await flush();
    const nativeText = await rawAssistant(result.record);
    assert.ok(!nativeText.trim().startsWith('{') && nativeText.includes('artifacts'));
    assert.ok(!result.record.toolReceipts.some(tool => tool.name === 'present'), 'This case must exercise the explicit envelope path');
    const file = result.record.artifacts.find(file => file.name === name);
    assert.ok(file, 'The prefaced native envelope lost its file');
    const bytes = await readFile(file.path), text = bytes.toString('utf8');
    assert.ok(text.includes('143') && text.includes(rooms[room])); assert.equal(file.sha256, hash(bytes));
    report.checks.push('prefacedNativeEnvelopeDeliversVerifiedFile');
    const publicText = parseBotOutput(result.record.text, request.botId, []).text;
    assert.ok(publicText && !publicText.includes('"artifacts"'));
    report.cases.push({ type: 'prefaced-envelope', requestId: request.requestId, text: result.record.text, nativeText, publicText,
      file: { name: file.name, sha256: file.sha256, size: file.size, content: text }, toolReceipts: result.record.toolReceipts });
    await save();
  }
  for (const [index, spec] of [
    { body: '23 乘以 19 是多少？严格只输出结果数字，不要保存长期记忆。', expected: 437 },
    { body: '严格只输出 JSON 数组 ["north","south"]，不要附加说明，不要保存长期记忆。', expected: ['north', 'south'] },
  ].entries()) {
    const eventId = `$native-structured-${index}`;
    const request = { botId: `@bot${index}:memory.test`,
      event: { eventId, roomId: rooms[index], senderId: senders[2], body: spec.body },
      context: { room: { id: rooms[index], name: roomNames[index] }, source: { transport: 'matrix', eventId,
        roomId: rooms[index], timestamp: Date.now(), sender: { id: senders[2], name: '宋禾', kind: 'human' } } }, history: [] };
    let result;
    for (let attempt = 0; attempt < 8; attempt++) {
      request.requestId = `native-structured-${index}-${attempt}`;
      result = await host.api('turn', { index, request });
      report.attempts.push({ phase: 'structured-data', index, attempt, ...result }); await save();
      if (result.record.status === 'completed') break;
      if (attempt === 7) throw new Error(`Native structured answer ${index} never completed`);
      await delay(Math.min(60000, 10000 * (attempt + 1)));
    }
    await flush();
    const publicText = parseBotOutput(result.record.text, request.botId, []).text;
    const json = publicText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    assert.deepEqual(JSON.parse(json), spec.expected); assert.equal(publicText, result.record.text.trim());
    assert.deepEqual(result.record.artifacts, []);
    report.checks.push(`nativeStructuredAnswer${index}ReachesChatParserUnchanged`);
    report.cases.push({ type: 'structured-data', requestId: request.requestId, text: result.record.text, publicText });
    await save();
  }
  {
    const index = 0, eventId = '$native-mixed-observation', expected = hash('mixed-source-observation');
    const request = { botId: '@bot0:memory.test',
      event: { eventId, roomId: rooms[0], senderId: senders[2],
        body: '本轮验收默认观察作者：请用终端计算无换行字符串 mixed-source-observation 的 SHA-256。然后 remember 保存实际哈希，kind 用 observation，subjectId 用 task:mixed-source；sourceIds 的第一项是当前用户请求来源 ID，第二项是 bash 结果来源 ID，且参数必须省略 saidBy，以测试后端如何确定观察作者。保存后 recall 查询这条工具观察，再简短报告结果。' },
      context: { room: { id: rooms[0], name: roomNames[0] }, source: { transport: 'matrix', eventId,
        roomId: rooms[0], timestamp: Date.now(), sender: { id: senders[2], name: '宋禾', kind: 'human' } } }, history: [] };
    let result;
    for (let attempt = 0; attempt < 8; attempt++) {
      request.requestId = `native-mixed-observation-${attempt}`;
      result = await host.api('turn', { index, request });
      report.attempts.push({ phase: 'mixed-observation', attempt, ...result }); await save();
      if (result.record.status === 'completed') break;
      if (attempt === 7) throw new Error('Native mixed observation never completed');
      await delay(Math.min(60000, 10000 * (attempt + 1)));
    }
    await flush();
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const calls = events.filter(event => event.type === 'tool/call' && result.record.toolReceipts.some(tool => tool.callId === event.data.callId));
    const valueOf = call => {
      const message = events.find(event => event.type === 'tool/result' && event.data.message?.toolCallId === call.data.callId)?.data.message;
      return JSON.parse((message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n'));
    };
    const remembered = calls.filter(call => call.data.name === 'remember').map(call => ({
      args: typeof call.data.arguments === 'string' ? JSON.parse(call.data.arguments) : call.data.arguments, value: valueOf(call),
    })).find(item => item.value.text?.includes(expected));
    assert.ok(remembered, 'Native remember did not return the actual hash');
    assert.ok(!Object.hasOwn(remembered.args, 'saidBy'), 'This case must exercise omitted-author attribution');
    const firstReference = remembered.args.sourceIds?.[0];
    assert.equal(remembered.value.sources.find(source => source.id === firstReference || source.eventId === firstReference)?.authorKind, 'human');
    assert.equal(remembered.value.kind, 'observation'); assert.equal(remembered.value.saidBy, 'tool:bash');
    assert.deepEqual(new Set(remembered.value.sources.map(source => source.authorKind)), new Set(['human', 'tool']));
    report.checks.push('nativeObservationUsesToolAuthorBeforeAutomaticReview');
    const recalled = calls.filter(call => call.data.name === 'recall').map(valueOf)
      .find(value => value.mode === 'semantic' && value.entries?.some(entry => entry.id === remembered.value.id && entry.saidBy === 'tool:bash'));
    assert.ok(recalled, 'Semantic recall did not preserve the written observation author');
    report.checks.push('nativeMixedEvidenceRetainsBothSourcesThroughSemanticRecall');
    report.cases.push({ type: 'mixed-observation', requestId: request.requestId, text: result.record.text,
      remembered: remembered.value, recallMode: recalled.mode, toolReceipts: result.record.toolReceipts });
    await save();
    await host.api('forget', { index, args: { id: remembered.value.id, scope: 'all' } });
    // Each new event explicitly asks for a fresh lookup. Previous turns may
    // contain the same correct answer, but cannot satisfy this new request.
    for (let repetition = 0; repetition < 3; repetition++) {
      const fresh = structuredClone(request), freshEvent = `$native-fresh-recall-${repetition}`;
      fresh.event.eventId = freshEvent;
      fresh.event.body = '请现在实际调用 recall（scope=all、history=true）查询 mixed-source-observation 的工具观察，确认该记忆当前是 current、withdrawn 还是 unknown。严格只返回 JSON，包含 status 字段。';
      fresh.context.source.eventId = freshEvent; fresh.context.source.timestamp = Date.now();
      let response;
      for (let attempt = 0; attempt < 8; attempt++) {
        fresh.requestId = `native-fresh-recall-${repetition}-${attempt}`;
        response = await host.api('turn', { index, request: fresh });
        report.attempts.push({ phase: 'fresh-recall', repetition, attempt, ...response }); await save();
        if (response.record.status === 'completed') break;
        if (attempt === 7) throw new Error(`Fresh recall ${repetition} never completed`);
        await delay(Math.min(60000, 10000 * (attempt + 1)));
      }
      await flush();
      assert.ok(response.record.toolReceipts.some(tool => tool.name === 'recall' && tool.status === 'completed'),
        'A previous answer replaced the explicitly requested fresh recall');
      const text = parseBotOutput(response.record.text, request.botId, []).text;
      const answer = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
      assert.equal(answer.status, 'withdrawn');
      report.checks.push(`explicitFreshRecall${repetition}ChecksNewStateWithActualToolCall`);
      report.cases.push({ type: 'fresh-recall', repetition, requestId: fresh.requestId,
        text: response.record.text, toolReceipts: response.record.toolReceipts });
      await save();
    }
  }
  const corpus = buildCorpus();
  for (const round of [66, 78]) {
    const step = corpus.steps[round], eventId = `$native-delegation-${round}`;
    const request = { botId: `@bot${step.index}:memory.test`,
      event: { eventId, roomId: rooms[step.room], senderId: senders[step.sender], body: step.body },
      context: { room: { id: rooms[step.room], name: roomNames[step.room] }, source: { transport: 'matrix', eventId,
        roomId: rooms[step.room], timestamp: Date.now(), sender: { id: senders[step.sender], name: step.sender === 2 ? '宋禾' : '青禾', kind: 'human' } } }, history: [] };
    let result;
    for (let attempt = 0; attempt < 8; attempt++) {
      request.requestId = `native-delegation-${round}-${attempt}`;
      result = await host.api('turn', { index: step.index, request });
      report.attempts.push({ phase: 'delegation', round, attempt, ...result }); await save();
      if (result.record.status === 'completed') break;
      if (attempt === 7) throw new Error(`Native delegation ${round} never completed`);
      await delay(Math.min(60000, 10000 * (attempt + 1)));
    }
    await flush();
    assert.ok(result.record.toolReceipts.some(tool => tool.name === 'message_bot' && tool.status === 'completed'));
    assert.ok(result.record.text.includes(step.expected), 'A delegation acknowledgement replaced the actual result');
    report.checks.push(`native${step.type}${round}ReturnsActualReply`);
    report.cases.push({ round, requestId: request.requestId, text: result.record.text, toolReceipts: result.record.toolReceipts });
    if (round === 78) {
      const memory = await host.api('memory');
      const source = memory.sources.find(source => source.transport === 'matrix' && source.eventId === eventId);
      assert.ok(source && memory.sources.some(row => row.authorKind === 'bot' && row.originRefs?.some(ref => ref.id === source.id)));
      report.checks.push('nativeRelayKeepsOriginalHumanSource');
    }
    await save(); console.log(JSON.stringify({ delegation: round, checks: report.checks.length }));
  }
  const calls = await completedCalls();
  report.accounting = { calls: calls.length, failedCalls: calls.filter(row => row.status === 'failed').length,
    modelIds: [...new Set(calls.map(row => row.model))], costComplete: false,
    observedUsage: calls.reduce((sum, row) => { for (const [key, value] of Object.entries(row.usage || {})) if (typeof value === 'number') sum[key] = (sum[key] || 0) + value; return sum; }, {}) };
  assert.deepEqual(report.accounting.modelIds, [MODEL]); report.checks.push('onlyRequestedGenerationModel');
  report.embedding = (await host.api('memory')).usage; report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  await host.stop(); report.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, error: report.error, directory }, null, 2));
}
