import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MemoryTestHost, MODEL, delay } from './memory-host.mjs';
import { buildCorpus, roomNames, senders as fixtureSenders } from './memory-long-corpus.mjs';
import { packageRoot } from '../src/paths.mjs';
import { savePrivateJson } from './server-init.mjs';
import { importNodeBundle } from './server-admin.mjs';
import { MatrixClient } from '../src/matrix-client.mjs';
import { resolveDsh } from './runtime-config.mjs';

const env = JSON.parse(await readFile(path.join(packageRoot, '.local/memory-visible-active.json'), 'utf8'));
const directory = env.directory, hostDir = path.join(directory, 'host');
await mkdir(hostDir, { recursive: true });
const setup = JSON.parse(await readFile(path.join(directory, 'core/matrix-setup.json'), 'utf8'));
const owner = setup.participants.find(person => person.localpart === 'watch');
const humans = ['lin_a','lin_b','song'].map(localpart => setup.participants.find(person => person.localpart === localpart));
const senders = humans.map(person => person.id), corpus = buildCorpus();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { schemaVersion: 1, status: 'preparing', model: MODEL, plannedRounds: 240, plannedCheckpoints: 72,
  startedAt: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse','HEAD'], { cwd: packageRoot, encoding: 'utf8' }).trim(),
  topology: 'real Synapse container + real Core and production React UI + NativeConnections/BotNode/NativeBridge + DSH + Ombre/Harrier',
  browserUrl: env.coreUrl, serverName: env.serverName, rounds: [], attempts: [], checkpoints: [], failures: [], maintenance: [], embeddingByBoot: [] };
const reportPath = path.join(directory, 'report.json');
let prior;
try { prior = JSON.parse(await readFile(reportPath, 'utf8')); } catch (error) { if(error.code !== 'ENOENT') throw error; }
if(prior) {
  await mkdir(path.join(directory,'prior-attempts'),{recursive:true});
  await savePrivateJson(path.join(directory,'prior-attempts',`report-${Date.now()}.json`),prior);
  for(const key of ['rounds','attempts','checkpoints','failures','maintenance','embeddingByBoot'])report[key]=prior[key]||[];
  report.maintenance.push({type:'runner-restart',at:new Date().toISOString(),previousStatus:prior.status,previousError:prior.error,completed:report.rounds.length});
}
report.generation=(prior?.generation||0)+1;
const resumeOffset=report.rounds.length;
const save = async () => { await savePrivateJson(reportPath, report); await savePrivateJson(path.join(directory, 'progress.json'), {
  status: report.status, completed: report.rounds.length, planned: 240, current: report.current, failures: report.failures.length,
  checkpoints: report.checkpoints.length, at: new Date().toISOString(), browserUrl: env.coreUrl,
}); };
async function api(route, { person = owner, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(env.coreUrl + route, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${person.accessToken}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(`Core ${route} HTTP ${response.status}: ${value.error}`), { status: response.status });
  return value;
}
const post = (roomId, body, transactionId, person = owner, to = []) => api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
  person, body: { body, transactionId, to, mentions: { users: to, roles: [], everyone: false, here: false } },
});
const announce = (body, id = randomUUID()) => post(env.roomId, body, `visible-status-${id}`);
for (const step of corpus.steps) for (const [index, fixtureId] of fixtureSenders.entries()) step.body = step.body.replaceAll(fixtureId, senders[index]);
const host = new MemoryTestHost(hostDir);
const labels = { learn:'记忆写入', preference:'联系人偏好', rename:'改名', quote:'转述与事实', correction:'事实纠正', expiry:'短期有效性',
  'withdraw-learn':'临时便签', withdraw:'撤回记忆', work:'日常协作', file:'文件交付', delegate:'Bot 协作', relay:'来源转述', query:'记忆核对',
  'tool-evidence':'工具观察', 'identity-query':'身份核对', 'expiry-query':'过期核对', 'withdraw-query':'撤回核对', 'quote-query':'转述核对' };
function format(step) {
  if (step.type === 'query') return '\n请严格输出 JSON：{"value":"当前字段值","roomId":"适用群完整ID","speakerId":"原始说话人完整账号"}。';
  if (step.type === 'identity-query') return '\n请严格输出 JSON，以两个完整账号为键，每个值包含 language、format、name。';
  if (step.type === 'expiry-query') return '\n请严格输出 JSON：{"status":"expired 或 current 或 unknown"}。';
  if (step.type === 'withdraw-query') return '\n请严格输出 JSON：{"status":"withdrawn 或 current 或 unknown"}。';
  if (step.type === 'quote-query') return '\n请严格输出 JSON：{"relayerId":"转述者完整账号","saidBy":"声称原作者完整账号","official":true或false,"officialValue":"原项目记录的标签"}。';
  return '';
}
const object = text => { try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { return null; } };
const same = (text, value) => String(text).replace(/[\s，,。:：、\-「」“”]/g, '').includes(String(value).replace(/[\s，,。:：、\-「」“”]/g, ''));
const account = value => typeof value === 'string' ? value.replace(/^(?:matrix:|room:)/, '') : value;
let rooms, bots;
function check(step, receipt, delivered, n) {
  const text = delivered.map(event => event.content.body).join('\n'), data = object(text), checks = [];
  const test = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  test('realMatrixReplyDelivered', delivered.length > 0);
  if (step.type.includes('query')) {
    test('usesRecall', receipt.toolReceipts?.some(tool => tool.name === 'recall' && tool.status === 'completed'));
    test('structuredAnswer', data);
    if (step.type === 'query') {
      const fact = corpus.facts[step.fact];
      let matched = same(data?.value, fact.value);
      if (fact.attribute === '发布时段') { const normalized = String(data?.value).replace(/星期|礼拜/g, '周').replace(/十一/g,'11').replace(/十/g,'10').replace(/九/g,'9'); matched = normalized.includes(`周${fact.value[1]}`) && normalized.includes(fact.value.match(/\d+/)?.[0]); }
      test('correctCurrentValue', matched); test('correctRoom', account(data?.roomId) === rooms[fact.room].roomId); test('correctOriginalSpeaker', account(data?.speakerId) === senders[fact.sender]);
      if (step.longGap) test('over100TurnsSinceLearning', n - (step.fact === 1 ? 48 : fact.learnedAt) >= 100);
    } else if (step.type === 'identity-query') {
      const identities = Object.fromEntries(Object.entries(data || {}).map(([id,v]) => [account(id),v])); const a = identities[senders[0]], b = identities[senders[1]];
      test('firstPersonChinese', /中文|Chinese/i.test(a?.language)); test('firstPersonRenamed', a?.name === '青禾');
      test('secondPersonEnglish', /英文|English/i.test(b?.language)); test('secondPersonNotMerged', b?.name === '林青');
      test('firstPersonBrief', /五|5|five/i.test(a?.format)); test('secondPersonDetailedTable', /详|detail/i.test(b?.format) && /表|table|spreadsheet/i.test(b?.format));
    } else if (step.type === 'expiry-query') test('expired', data?.status === 'expired');
    else if (step.type === 'withdraw-query') test('withdrawn', data?.status === 'withdrawn');
    else if (step.type === 'quote-query') { test('relayer', account(data?.relayerId) === senders[2]); test('reportedSpeaker', account(data?.saidBy) === senders[1]); test('notOfficial', data?.official === false); test('originalValue', data?.officialValue === corpus.facts[0].value); }
    report.checkpoints.push({ round: n + 1, type: step.type, checks, passed: checks.every(item => item.passed), text });
  }
  if (step.type === 'delegate' || step.type === 'relay') { test('nativeDelegation', receipt.toolReceipts?.some(tool => tool.name === 'message_bot' && tool.status === 'completed')); test('delegatedResult', text.includes(step.expected)); }
  if (step.type === 'tool-evidence') test('actualComputedHash', text.includes(hash(step.hashText)));
  if (checks.some(item => !item.passed)) report.failures.push({ round: n + 1, type: step.type, checks: checks.filter(item => !item.passed), text });
  return checks;
}
async function flush(n) {
  for (let attempt = 0; ; attempt++) {
    try { await host.api('flush'); return; }
    catch (error) { report.maintenance.push({ type:'memory-flush-failure', round:n+1, attempt, error:error.message, at:Date.now() }); await save(); if(attempt>=5) throw error; await delay(Math.min(45000,(attempt+1)*10000)); }
  }
}
async function waitForReply(step, eventId, requestId) {
  const roomId = rooms[step.room].roomId, botId = bots[step.index].id;
  const deadline = Date.now() + 12 * 60_000;
  let receipt, delivered = [], lastStatus;
  while (Date.now() < deadline) {
    receipt = await host.api('receipt', { botId, requestId });
    if (receipt?.status !== lastStatus) { lastStatus = receipt?.status; report.current.stage = lastStatus || 'waiting-node'; await save(); }
    if (receipt && ['failed','cancelled','unknown'].includes(receipt.status)) return { receipt, delivered };
    if (receipt?.status === 'completed') {
      const result = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages?limit=100`);
      delivered = result.events.filter(event => event.sender === botId && (event.content?.['org.ds_group']?.replyTo === eventId || event.content?.['m.relates_to']?.['m.in_reply_to']?.event_id === eventId));
      if (delivered.length) return { receipt, delivered };
    }
    const tasks = await api(`/api/rooms/${encodeURIComponent(roomId)}/tasks`);
    const task = tasks.tasks?.find(item => item.requestId === requestId);
    if (task && ['failed','cancelled','unknown'].includes(task.status)) return { receipt: receipt || { requestId, status:task.status, errorCode:task.summary, toolReceipts:[] }, delivered, task };
    await delay(1500);
  }
  return { receipt: receipt || { requestId, status:'unknown', errorCode:'VISIBLE_TEST_TIMEOUT', toolReceipts:[] }, delivered, timedOut:true };
}
async function runRound(step, n) {
  const room = rooms[step.room], bot = bots[step.index], sender = humans[step.sender];
  if (step.type === 'rename') {
    const client = new MatrixClient({ baseUrl:env.matrixUrl, accessToken:sender.accessToken });
    await client.request('PUT', `/_matrix/client/v3/profile/${encodeURIComponent(sender.id)}/displayname`, { displayname:'青禾' });
    report.maintenance.push({ type:'actual-matrix-display-name-change', round:n+1, userId:sender.id, name:'青禾' });
  }
  for (let attempt=0; attempt<3; attempt++) {
    report.current = { round:n+1, type:step.type, roomId:room.roomId, roomName:room.name, bot:bot.name, attempt:attempt+1, stage:'posting' }; await save();
    let body = `【长测 ${String(n+1).padStart(3,'0')}/240 · ${labels[step.type]}${attempt ? ` · 重试 ${attempt}` : ''}】\n<@${bot.id}> ${step.body}${format(step)}`;
    if(step.type==='expiry') { const end=Date.now()+120000; body += `\n明确到期时间：${new Date(end).toISOString()}（epoch ${end}）。`; }
    const event = await post(room.roomId,body,`visible-round-${n}-attempt-${attempt}-run-${report.generation}`,sender,[bot.id]);
    const requestId = `matrix-${hash(`${bot.id}\0${event.event_id}`)}`;
    report.current.eventId=event.event_id; report.current.requestId=requestId; await save();
    const result=await waitForReply(step,event.event_id,requestId);
    report.attempts.push({ round:n+1, attempt:attempt+1, eventId:event.event_id, roomId:room.roomId, ...result }); await save();
    if(result.receipt.status==='completed'&&result.delivered.length) { await flush(n); return { ...result, eventId:event.event_id, requestId }; }
    await announce(`【长测异常保留】第 ${n+1}/240 轮，${bot.name}，${room.name}：${result.receipt.errorCode||result.receipt.status}。${attempt<2?'稍后以明确的新消息重试。':'本轮执行未完成，停止后续轮次等待修复。'}`);
    if(result.timedOut) throw new Error(`Round ${n+1} still pending; refusing overlapping automatic retry`);
    await delay(15000*(attempt+1));
  }
  throw new Error(`Round ${n+1} failed after 3 visible attempts`);
}
try {
  await save(); await savePrivateJson(path.join(directory,'corpus.json'),corpus);
  report.corpusHash=hash(JSON.stringify(corpus));
  try {
    host.workspace=JSON.parse(await readFile(path.join(hostDir,'workspace.json'),'utf8')).path;
    host.installation=await resolveDsh();
    host.boot=Math.max(0,...(await readdir(hostDir)).map(name=>Number(/^host-(\d+)\.log$/.exec(name)?.[1]||0)));
  } catch(error) { if(error.code!=='ENOENT')throw error; await host.prepare(); }
  const harness=path.join(hostDir,'harness.mjs'); await writeFile(harness,(await readFile(harness,'utf8')).replace('scripts/memory-host-plugin.mjs','scripts/memory-visible-host-plugin.mjs'));
  await host.start();
  await savePrivateJson(path.join(directory,'host-current.json'),{pid:host.child.pid,port:host.port,logfile:host.logfile,home:host.home});
  const nativeBots=await host.api('init'); assert.equal(nativeBots.length,3);
  const hostId=`visible-${path.basename(directory)}`;
  await api('/api/bot-catalog',{body:{hostId,label:'实时长测 DSH',bots:nativeBots}});
  bots=[]; const nodes=[];
  for (const nativeBot of nativeBots) {
    const {bot}=await api('/api/bots/attach',{body:{hostId,nativeBotId:nativeBot.id}}); bots.push({...bot,nativeBotId:nativeBot.id});
    const {bundle}=await api(`/api/bots/${encodeURIComponent(bot.id)}/connect`,{body:{}});
    const nodeDir=path.join(hostDir,`node-${bots.length-1}`);
    try { const existing=JSON.parse(await readFile(path.join(nodeDir,'matrix-setup.json'),'utf8'));assert.ok(existing.participants.some(p=>p.id===bot.id&&p.accessToken)); }
    catch(error) { if(error.code!=='ENOENT')throw error;await importNodeBundle(bundle,nodeDir); }
    nodes.push({...bot,nativeBotId:nativeBot.id,directory:nodeDir,serverUrl:env.coreUrl});
  }
  report.bots=bots; await savePrivateJson(path.join(hostDir,'nodes.json'),nodes);
  rooms=[];
  for(const [index,name]of roomNames.entries())rooms.push(await api('/api/rooms',{body:{name:`${name} · 长程测试`,requestId:`visible-room-${index}`,inviteIds:[...humans.map(h=>h.id),...bots.map(b=>b.id)]}}));
  report.rooms=rooms; await savePrivateJson(path.join(directory,'rooms.json'),rooms);
  report.connections=await host.api('connect');
  await announce('【实时长程测试 · 已就绪】\n识雨、知秋、听澜已通过真实 Bot 节点接入。左侧新增北组、南组、设计组、现场组四个测试频道。每条输入标注当前轮数，Bot 回答由指定模型现场生成。现在从北组第 001/240 轮开始。');
  report.status='ready'; await save(); console.log(JSON.stringify({stage:'ready',directory,coreUrl:env.coreUrl,rooms:rooms.map(r=>({roomId:r.roomId,name:r.name})),bots:bots.map(b=>({id:b.id,name:b.name}))}));
  while(true) { try { await access(path.join(directory,'start')); break; } catch { await delay(500); } }
  report.status='running'; await save();
  for(const [n,step]of corpus.steps.entries()) {
    if(n<resumeOffset)continue;
    const result=await runRound(step,n), checks=check(step,result.receipt,result.delivered,n);
    if(step.type==='file') {
      const files=result.delivered.flatMap(event=>(event.content['org.ds_group']?.attachments||[]).map(file=>({file,eventId:event.event_id})));
      const artifact=files.find(({file})=>file.name?.includes(step.artifact)); let valid=false;
      if(artifact){const url=`${env.coreUrl}/api/rooms/${encodeURIComponent(rooms[step.room].roomId)}/attachments/${encodeURIComponent(artifact.file.id)}?eventId=${encodeURIComponent(artifact.eventId)}`;const response=await fetch(url,{headers:{authorization:`Bearer ${owner.accessToken}`}});const bytes=await response.text();valid=response.ok&&bytes.includes(String(step.expectedNumber))&&bytes.includes(rooms[step.room].roomId);}
      checks.push({name:'realDownloadedArtifactContent',passed:valid});if(!valid)report.failures.push({round:n+1,type:'artifact',reason:'Delivered file missing expected contents'});
    }
    report.rounds.push({round:n+1,type:step.type,roomId:rooms[step.room].roomId,botId:bots[step.index].id,requestId:result.requestId,eventId:result.eventId,replyEventIds:result.delivered.map(e=>e.event_id),checks,finishedAt:new Date().toISOString()});
    if([47,79,111,143,175,207].includes(n)){const index=[47,79,111,143,175,207].indexOf(n)%3;await announce(`【恢复检查】第 ${n+1} 轮后，执行 ${bots[index].name} 的原生上下文压缩；原消息和长期记忆继续保留。`);const result=await host.api('compact',{index});report.maintenance.push({type:'native-compaction',round:n+1,index,result});if(!result.compacted)report.failures.push({round:n+1,type:'compaction',result});}
    if([63,127,191].includes(n)){await flush(n);const snapshot=await host.api('memory');report.embeddingByBoot.push(snapshot.usage);await savePrivateJson(path.join(directory,`memory-before-restart-${n+1}.json`),snapshot);await announce(`【恢复检查】完成 ${n+1}/240 轮，重启独立 DSH 与三个 Bot 节点；随后核对原身份和持久记忆。`);await host.stop();await host.start();const rebound=await host.api('init');assert.deepEqual(rebound.map(b=>b.id),nativeBots.map(b=>b.id));await host.api('connect');await savePrivateJson(path.join(directory,'host-current.json'),{pid:host.child.pid,port:host.port,logfile:host.logfile,home:host.home});report.maintenance.push({type:'planned-restart',round:n+1,identitiesPreserved:true});}
    if((n+1)%12===0||step.type.includes('query'))await announce(`【长测进度】已完成 ${n+1}/240 轮；当前 ${rooms[step.room].name} / ${bots[step.index].name}。已核对 ${report.checkpoints.length}/72 项记忆问题，已记录 ${report.failures.length} 项失败。`);
    await save();console.log(JSON.stringify({completed:n+1,type:step.type,room:rooms[step.room].name,failures:report.failures.length}));
  }
  await flush(239);report.finalMemory=await host.api('memory');report.embeddingByBoot.push(report.finalMemory.usage);
  const logs=(await readFile(path.join(hostDir,'calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);const ends=logs.filter(r=>r.event==='end'),ended=new Set(ends.map(r=>r.callId));
  report.accounting={calls:ends.length,failedCalls:ends.filter(r=>r.status==='failed').length,unfinished:logs.filter(r=>r.event==='start'&&!ended.has(r.callId)).length,modelIds:[...new Set(logs.map(r=>r.model))],costComplete:false};
  assert.deepEqual(report.accounting.modelIds,[MODEL]);assert.equal(report.checkpoints.length,72);
  report.status=report.failures.length?'failed':'passed';await announce(`【长程测试结束】完成 240/240 轮，${report.checkpoints.filter(c=>c.passed).length}/72 项记忆检查通过，保留 ${report.failures.length} 项失败。完整消息、文件和原始证据已保存。本轮结果：${report.status}。`);
} catch(error) {report.status='failed';report.error=error.stack;process.exitCode=1;await announce(`【测试已停止】已完成 ${report.rounds.length}/240 轮。${error.message}。原始失败与消息保留，正在诊断。`).catch(()=>{});
} finally {await host.stop();report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,rounds:report.rounds.length,error:report.error,directory}));}
