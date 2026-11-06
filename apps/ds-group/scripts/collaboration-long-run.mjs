import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir,access} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {MemoryTestHost,MODEL,delay} from './memory-host.mjs';
import {buildCollaborationCorpus,roomNames,assets as originalAssets,scenarioInstructions} from './collaboration-long-corpus.mjs';
import {buildCollaborationContinuation,continuationAssets} from './collaboration-continuation-corpus.mjs';
import {checkCollaborationStep} from './collaboration-long-check.mjs';
import {researchTraceEvidence} from './collaboration-long-audit.mjs';
import {packageRoot} from '../src/paths.mjs';
import {savePrivateJson} from './server-init.mjs';
import {importNodeBundle} from './server-admin.mjs';
import {resolveDsh} from './runtime-config.mjs';
import {MatrixClient} from '../src/matrix-client.mjs';
import {isModelQuotaFailure} from '../src/model-failure.mjs';
import {readGoQuota} from './go-quota.mjs';
import {readCommandCodeCatalog} from './commandcode-preflight.mjs';
import {ORIGINAL_TEST_MODEL} from './memory-test-model.mjs';

const env=JSON.parse(await readFile(path.join(packageRoot,'.local/collaboration-live-active.json'),'utf8'));
assert.ok(process.argv.slice(2).every(arg=>arg==='--continuation'),'Only --continuation is supported');
const continuation=process.argv.includes('--continuation');
const corpus=continuation?buildCollaborationContinuation():buildCollaborationCorpus(),assets=continuation?continuationAssets:originalAssets;
const directory=continuation?path.join(env.directory,corpus.id):env.directory,hostDir=path.join(env.directory,'host'),protocolDir=path.join(directory,'host');
const compactAt=corpus.maintenance?.compactions||[48,88,128,168,208,224],restartAt=corpus.maintenance?.restarts||[80,160,208];
let parent;
if(continuation){const raw=await readFile(path.join(env.directory,'report.json'),'utf8'),previous=JSON.parse(raw);
  assert.equal(previous.status,'provider-blocked','The continuation is registered for the frozen interrupted run');
  assert.equal(previous.rounds.length,208,'This continuation requires the 208-message history');
  parent={run:path.basename(env.directory),rawReportSha256:createHash('sha256').update(raw).digest('hex'),postedMessages:previous.rounds.length,
    deliveredBotReplies:previous.rounds.filter(row=>row.replyEventIds?.length).length,nativeBotIds:previous.bots.map(bot=>bot.nativeBotId),
    matrixBotIds:previous.bots.map(bot=>bot.id),roomIds:previous.rooms.map(room=>room.roomId)};}
await mkdir(hostDir,{recursive:true});
await mkdir(protocolDir,{recursive:true});
const setup=JSON.parse(await readFile(path.join(env.directory,'core/matrix-setup.json'),'utf8'));
const owner=setup.participants.find(p=>p.localpart==='watch');
const humans=['lin_a','lin_b','song'].map(name=>setup.participants.find(p=>p.localpart===name));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const host=new MemoryTestHost(hostDir);
const report={schemaVersion:2,scenario:corpus.scenario,model:MODEL,status:'preparing',startedAt:new Date().toISOString(),
  ...(parent?{parent}:{}),plannedMaintenance:{compactions:compactAt,restarts:restartAt},
  runtimeDirectory:hostDir,
  sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:packageRoot,encoding:'utf8'}).trim(),
  plannedMessages:corpus.steps.length,plannedBotRequests:corpus.steps.filter(s=>s.index!==null).length,
  topology:'real Synapse + real DSCord Core/UI + native BotNode/NativeConnections + DSH + Ombre/Harrier; one physical host',
  browserUrl:env.coreUrl,rounds:[],attempts:[],failures:[],manualReviews:[],maintenance:[],embeddingByBoot:[]};
const reportPath=path.join(directory,'report.json');let prior;
try{prior=JSON.parse(await readFile(reportPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(prior){if(continuation&&prior.rounds?.length){assert.equal(prior.corpusHash,sha(JSON.stringify(corpus)),'Do not change a continuation after posting scenario messages');
    assert.equal(prior.parent?.rawReportSha256,parent.rawReportSha256,'The interrupted parent report must stay frozen');}
  await mkdir(path.join(directory,'prior-attempts'),{recursive:true});const stamp=Date.now();await savePrivateJson(path.join(directory,'prior-attempts',`report-${stamp}.json`),prior);
  if(continuation)try{const previousCorpus=JSON.parse(await readFile(path.join(directory,'corpus-private.json'),'utf8'));await savePrivateJson(path.join(directory,'prior-attempts',`corpus-${stamp}.json`),previousCorpus);}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const key of ['rounds','attempts','failures','manualReviews','maintenance','embeddingByBoot','bots','rooms'])report[key]=prior[key]||[];
  report.initialStartedAt=prior.initialStartedAt||prior.startedAt;
  report.generations=[...(prior.generations||[{generation:prior.generation,sourceCommit:prior.sourceCommit,startedAt:prior.startedAt,model:prior.model}]),
    {generation:(prior.generation||0)+1,sourceCommit:report.sourceCommit,startedAt:report.startedAt,resumedAfter:report.rounds.length,model:MODEL}];
  if(prior.model!==MODEL)report.maintenance.push({type:'authorized-provider-change',at:new Date().toISOString(),previousModel:prior.model,model:MODEL,afterPostedMessages:report.rounds.length});
  report.maintenance.push({type:'runner-restart',at:new Date().toISOString(),previousStatus:prior.status,error:prior.error,completed:report.rounds.length});}
report.generation=(prior?.generation||0)+1;
let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;});
const exists=async file=>{try{await access(file);return true;}catch{return false;}};
async function save(){await savePrivateJson(reportPath,report);await savePrivateJson(path.join(directory,'progress.json'),{
  status:report.status,completed:report.rounds.length,postedMessages:report.rounds.length,planned:corpus.steps.length,
  attemptedBotRequests:report.rounds.filter(r=>r.botId).length,botReplies:report.rounds.filter(r=>r.replyEventIds?.length).length,
  current:report.current,failures:report.failures.length,manualReviewCount:report.manualReviews.length,at:new Date().toISOString(),browserUrl:env.coreUrl});}
async function api(route,{person=owner,body,method=body===undefined?'GET':'POST'}={}) {
  const response=await fetch(env.coreUrl+route,{method,headers:{'content-type':'application/json',authorization:`Bearer ${person.accessToken}`},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const value=await response.json();if(!response.ok)throw new Error(`Core ${route} HTTP ${response.status}: ${value.error}`);return value;
}
const post=(roomId,body,transactionId,person=owner,to=[],attachments=[])=>api(`/api/rooms/${encodeURIComponent(roomId)}/messages`,{
  person,body:{body,transactionId,to,attachments,mentions:{users:to,roles:[],everyone:false,here:false}}});
const announce=body=>post(env.roomId,body,`collaboration-status-${randomUUID()}`);
const extensions={'.csv':'text/csv','.md':'text/markdown','.mjs':'text/javascript','.txt':'text/plain'};
async function upload(name,person) {
  const bytes=Buffer.from(assets[name]);assert.ok(bytes.length);
  const response=await fetch(`${env.coreUrl}/api/attachments?filename=${encodeURIComponent(name)}`,{method:'POST',
    headers:{authorization:`Bearer ${person.accessToken}`,'content-type':extensions[path.extname(name)]||'application/octet-stream','x-upload-id':`scenario-${person.localpart}-${sha(bytes)}`},body:bytes});
  const result=await response.json();if(!response.ok)throw new Error(`Upload ${name}: ${result.error}`);
  assert.equal(result.attachment.sha256,sha(bytes));return result.attachment.id;
}
let rooms,bots,nativeBots;
async function waitForReply(room,bot,eventId,requestId) {
  const deadline=Date.now()+12*60000;let receipt,stage;
  while(Date.now()<deadline) {
    receipt=await host.api('receipt',{botId:bot.id,requestId});
    if(receipt?.status!==stage){stage=receipt?.status;report.current.stage=stage||'waiting-node';await save();}
    if(receipt&&['failed','cancelled','unknown'].includes(receipt.status))return{receipt,delivered:[]};
    if(receipt?.status==='completed') {
      const result=await api(`/api/rooms/${encodeURIComponent(room.roomId)}/messages?limit=100`);
      const delivered=result.events.filter(e=>e.sender===bot.id&&(e.content?.['org.ds_group']?.replyTo===eventId||e.content?.['m.relates_to']?.['m.in_reply_to']?.event_id===eventId));
      if(delivered.length)return{receipt,delivered};
    }
    const tasks=(await api(`/api/rooms/${encodeURIComponent(room.roomId)}/tasks`)).tasks;
    const task=tasks.find(t=>t.requestId===requestId);
    if(task&&['failed','cancelled','unknown'].includes(task.status))return{receipt:receipt||{requestId,status:task.status,errorCode:task.summary},delivered:[]};
    await delay(1500);
  }
  throw new Error(`Pending task exceeded 12 minutes: ${requestId}; no overlapping retry started`);
}
async function downloadArtifacts(delivered,room,n) {
  const result=[];const root=path.join(directory,'downloads',String(n+1).padStart(3,'0'));await mkdir(root,{recursive:true});
  for(const event of delivered)for(const file of event.content?.['org.ds_group']?.attachments||[]) {
    if(result.some(f=>f.id===file.id))continue;
    const response=await fetch(`${env.coreUrl}/api/rooms/${encodeURIComponent(room.roomId)}/attachments/${encodeURIComponent(file.id)}?eventId=${encodeURIComponent(event.event_id)}`,
      {headers:{authorization:`Bearer ${owner.accessToken}`},signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`Artifact ${file.name} download HTTP ${response.status}`);
    const bytes=Buffer.from(await response.arrayBuffer());assert.equal(sha(bytes),file.sha256);assert.equal(bytes.length,file.size);
    const filename=path.join(root,`${file.id}-${path.basename(file.name)}`);await writeFile(filename,bytes,{mode:0o600});
    result.push({id:file.id,name:file.name,path:filename,size:bytes.length,sha256:sha(bytes),eventId:event.event_id});
  }return result;
}
async function flush() {for(let attempt=0;;attempt++)try{return await host.api('flush');}catch(error){report.maintenance.push({type:'flush-error',at:new Date().toISOString(),error:error.message,attempt});await save();if(isModelQuotaFailure(error)||attempt>=3)throw error;await delay(10000*(attempt+1));}}
async function snapshot(name) {await flush();const memory=await host.api('memory');await savePrivateJson(path.join(directory,`${name}.json`),memory);return memory;}
async function checkAllowance() {
  const quota=MODEL===ORIGINAL_TEST_MODEL?await readGoQuota(host.home):await readCommandCodeCatalog(host.home);
  await savePrivateJson(path.join(directory,'provider-quota.json'),quota);
  if(!quota.available)throw Object.assign(new Error(quota.kind==='model-catalog'?'Authorized ordinary CommandCode model absent from catalog':`Go allowance exhausted (${quota.blockedWindows.join(', ')}); provider reset: ${quota.resetAt}`),{code:quota.kind==='model-catalog'?'MODEL_UNAVAILABLE':'MODEL_QUOTA_EXCEEDED'});
}
async function sourceManifest(name) {
  const files=execFileSync('git',['ls-files','-z','src','dsh-connect','memory','vendor/ds-bot','scripts/collaboration-long-corpus.mjs','scripts/collaboration-long-check.mjs','scripts/collaboration-long-run.mjs','scripts/memory-visible-host-plugin.mjs'],{cwd:packageRoot}).toString().split('\0').filter(Boolean);
  for(const file of ['scripts/collaboration-long-corpus.mjs','scripts/collaboration-continuation-corpus.mjs','scripts/collaboration-long-check.mjs','scripts/collaboration-long-run.mjs','scripts/collaboration-long-audit.mjs','scripts/go-quota.mjs','scripts/commandcode-preflight.mjs','scripts/memory-test-model.mjs','scripts/memory-host.mjs','scripts/memory-host-plugin.mjs'])if(!files.includes(file))files.push(file);
  const hashes={};for(const file of files)hashes[file]=sha(await readFile(path.join(packageRoot,file)));
  await savePrivateJson(path.join(directory,name),{at:new Date().toISOString(),hashes});
}
try {
  await save();await savePrivateJson(path.join(directory,'corpus-private.json'),corpus);
  report.corpusHash=sha(JSON.stringify(corpus));await sourceManifest(`source-hashes-start-${report.generation}.json`);
  try{host.workspace=JSON.parse(await readFile(path.join(hostDir,'workspace.json'),'utf8')).path;host.installation=await resolveDsh();host.boot=Math.max(0,...(await readdir(hostDir)).map(name=>Number(/^host-(\d+)\.log$/.exec(name)?.[1]||0)));}
  catch(error){if(error.code!=='ENOENT')throw error;await host.prepare();}
  await checkAllowance();
  await savePrivateJson(path.join(hostDir,'scenario-profile.json'),{instructions:scenarioInstructions,...(continuation?{evidenceDirectory:protocolDir}:{})});
  if(continuation)await savePrivateJson(path.join(protocolDir,'workspace.json'),{path:host.workspace});
  const harness=path.join(hostDir,'harness.mjs');await writeFile(harness,(await readFile(harness,'utf8')).replace('scripts/memory-host-plugin.mjs','scripts/memory-visible-host-plugin.mjs'));
  await host.start();
  const saveHost=()=>savePrivateJson(path.join(directory,'host-current.json'),{pid:host.child.pid,port:host.port,logfile:host.logfile,home:host.home});await saveHost();
  nativeBots=await host.api('init');assert.equal(nativeBots.length,3);
  if(parent)assert.deepEqual(nativeBots.map(bot=>bot.id),parent.nativeBotIds,'Continuation must keep the original Bot identities');
  const hostId=`collaboration-${path.basename(env.directory)}`;await api('/api/bot-catalog',{body:{hostId,label:'自然协作长测',bots:nativeBots}});
  bots=[];const nodes=[];
  for(const nativeBot of nativeBots) {
    const {bot}=await api('/api/bots/attach',{body:{hostId,nativeBotId:nativeBot.id}});bots.push({...bot,nativeBotId:nativeBot.id});
    const {bundle}=await api(`/api/bots/${encodeURIComponent(bot.id)}/connect`,{body:{}});const nodeDir=path.join(hostDir,`node-${bots.length-1}`);
    if(!(await exists(path.join(nodeDir,'matrix-setup.json'))))await importNodeBundle(bundle,nodeDir);
    nodes.push({...bot,nativeBotId:nativeBot.id,directory:nodeDir,serverUrl:env.coreUrl});
  }
  if(parent)assert.deepEqual(bots.map(bot=>bot.id),parent.matrixBotIds,'Continuation must keep the original Matrix Bot accounts');
  report.bots=bots;await savePrivateJson(path.join(hostDir,'nodes.json'),nodes);rooms=[];
  for(const [index,name]of roomNames.entries())rooms.push(await api('/api/rooms',{body:{name,requestId:`collaboration-room-${index}`,inviteIds:[...humans.map(h=>h.id),...bots.map(b=>b.id)]}}));
  if(parent)assert.deepEqual(rooms.map(room=>room.roomId),parent.roomIds,'Continuation must keep the original room histories');
  report.rooms=rooms;await savePrivateJson(path.join(directory,'rooms.json'),rooms);
  report.connections=await host.api('connect');
  if(continuation&&!prior?.rounds?.length){const memory=await snapshot('memory-phase-start');report.embeddingByBoot.push(memory.usage);
    report.maintenance.push({type:'phase-start-recovery',identitiesPreserved:true,pendingReviewFlushed:true,parent:parent.run});await save();}
  if(prior?.rounds?.length){
    assert.deepEqual(bots.map(bot=>bot.nativeBotId),prior.bots.map(bot=>bot.nativeBotId));
    const recovered=await snapshot(`memory-resume-${report.generation}`);
    report.maintenance.push({type:'recovery-restart',round:report.rounds.length,identitiesPreserved:true,pendingReviewFlushed:true,sourceCommit:report.sourceCommit});
    report.embeddingByBoot.push(recovered.usage);await save();
    await announce(`${corpus.scenario}已恢复，将从第 ${report.rounds.length+1}/${corpus.steps.length} 条继续。Bot 身份、原生会话、文件与既有记忆沿用；中断和修复版本单独记录，之前的失败保留。`);
  }else await announce(`${corpus.scenario}已就绪：${corpus.steps.length} 条参与者消息，包含 ${corpus.steps.filter(row=>row.type==='chat').length} 条闲聊；${report.plannedBotRequests} 次点名请求。${continuation?'这是独立续篇，前段的 208 条及失败保持原样。':'四个频道同时保留工作上下文。'}文件、研究、代码执行与聊天分别留证。`);
  report.status='ready';await save();console.log(JSON.stringify({stage:'ready',directory,url:env.coreUrl,rooms:rooms.map(r=>({name:r.name,roomId:r.roomId}))}));
  while(!(await exists(path.join(directory,'start')))){if(stopping)break;await delay(500);}
  report.status='running';await save();
  for(const [n,step]of corpus.steps.entries()) {
    if(n<report.rounds.length)continue;
    while(await exists(path.join(directory,'pause'))||continuation&&await exists(path.join(env.directory,'pause'))){report.status='paused-by-operator';await save();if(stopping)break;await delay(1000);}
    if(stopping||await exists(path.join(directory,'stop'))){report.status='stopped-by-operator';break;}
    report.status='running';
    if(n%12===0)await announce(`${corpus.scenario} · 第 ${Math.floor(n/12)+1}/${corpus.scenes.length} 幕：${step.scene}。已投放 ${n}/${corpus.steps.length} 条参与者消息。`);
    const room=rooms[step.room],person=humans[step.sender],bot=step.index===null?null:bots[step.index];
    report.current={round:n+1,scene:step.scene,type:step.type,roomId:room.roomId,roomName:room.name,bot:bot?.name||null,stage:'posting'};await save();
    if(step.rename){const client=new MatrixClient({baseUrl:env.matrixUrl,accessToken:person.accessToken});await client.request('PUT',`/_matrix/client/v3/profile/${encodeURIComponent(person.id)}/displayname`,{displayname:step.rename});report.maintenance.push({type:'matrix-profile-change',round:n+1,userId:person.id,name:step.rename});}
    const attachments=[];for(const file of step.files||[])attachments.push(await upload(file,person));
    const body=bot?`<@${bot.id}> ${step.body}`:step.body;
    const event=await post(room.roomId,body,`natural-${corpus.id||'original'}-${report.generation}-${n}`,person,bot?[bot.id]:[],attachments);
    report.current.eventId=event.event_id;await save();
    const row={round:n+1,scene:step.scene,type:step.type,roomId:room.roomId,senderId:person.id,eventId:event.event_id,startedAt:new Date().toISOString(),checks:[]};
    if(bot) {
      const requestId=`matrix-${sha(`${bot.id}\0${event.event_id}`)}`;report.current.requestId=requestId;await save();
      const result=await waitForReply(room,bot,event.event_id,requestId);report.attempts.push({round:n+1,eventId:event.event_id,requestId,...result});
      row.botId=bot.id;row.requestId=requestId;row.replyEventIds=result.delivered.map(e=>e.event_id);
      if(result.receipt.status!=='completed'||!result.delivered.length) {
        row.checks.push({name:'completedRealReply',passed:false,detail:result.receipt.errorCode||result.receipt.status});
      }else {
        const artifacts=await downloadArtifacts(result.delivered,room,n);row.artifacts=artifacts;
        let researchEvidence;
        if(continuation&&step.research){const events=(await readFile(path.join(protocolDir,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);researchEvidence=researchTraceEvidence(result.receipt,events);}
        const checked=await checkCollaborationStep({step,...result,artifacts,researchEvidence,directory:path.join(directory,'independent-checks',String(n+1))});
        row.checks=checked.checks;row.reply=checked.reply;row.checkpoint=checked.checkpoint;
        if(checked.manualReview.length)report.manualReviews.push({round:n+1,criteria:checked.manualReview,reply:checked.reply,artifacts:artifacts.map(f=>({name:f.name,path:f.path})),status:'pending'});
      }
      const failed=row.checks.filter(c=>!c.passed);if(failed.length)report.failures.push({round:n+1,type:step.type,checks:failed});
    }else{await delay(1200);row.checks.push({name:'realHumanChatPosted',passed:true});}
    row.finishedAt=new Date().toISOString();report.rounds.push(row);await save();
    console.log(JSON.stringify({completed:n+1,type:step.type,room:room.name,failures:report.failures.length}));
    if(isModelQuotaFailure(report.attempts.find(attempt=>attempt.round===n+1)?.receipt))throw Object.assign(new Error(`${MODEL} allowance exhausted; no later scenario messages were posted`),{code:'MODEL_QUOTA_EXCEEDED'});
    if(compactAt.includes(n+1)) {
      const index=compactAt.indexOf(n+1)%3;await flush();const result=await host.api('compact',{index});
      report.maintenance.push({type:'native-compaction',round:n+1,index,result});if(!result.compacted)report.failures.push({round:n+1,type:'compaction',result});await save();
      if(!result.compacted)await checkAllowance();
    }
    if(restartAt.includes(n+1)) {
      await announce(`${corpus.scenario}已投放 ${n+1}/${corpus.steps.length} 条，正在做一次宿主恢复检查；原对话、文件与 Bot 身份保留。`);
      const memory=await snapshot(`memory-before-restart-${n+1}`);report.embeddingByBoot.push(memory.usage);await save();
      await host.api('disconnect');await host.stop();await host.start();const rebound=await host.api('init');assert.deepEqual(rebound.map(b=>b.id),nativeBots.map(b=>b.id));await host.api('connect');await saveHost();
      report.maintenance.push({type:'planned-restart',round:n+1,identitiesPreserved:true});await save();
    }
    if((n+1)%12===0)await announce(`本幕结束：已投放 ${n+1}/${corpus.steps.length} 条，实际 Bot 回复 ${report.rounds.filter(r=>r.botId&&r.replyEventIds?.length).length} 条。自动检查记录 ${report.failures.length} 项未通过；开放式聊天和交接另行逐条审阅。`);
  }
  report.finalMemory=await snapshot('memory-final');report.embeddingByBoot.push(report.finalMemory.usage);
  const calls=(await readFile(path.join(protocolDir,'calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),ends=calls.filter(c=>c.event==='end'),ended=new Set(ends.map(c=>c.callId));
  report.accounting={calls:ends.length,failedCalls:ends.filter(c=>c.status==='failed').length,unfinished:calls.filter(c=>c.event==='start'&&!ended.has(c.callId)).length,modelIds:[...new Set(calls.map(c=>c.model))],costComplete:false};
  assert.deepEqual(report.accounting.modelIds,[MODEL]);
  if(report.rounds.length===corpus.steps.length)report.status=report.failures.length?'completed-with-failures':'completed-awaiting-review';
  await sourceManifest(`source-hashes-end-${report.generation}.json`);
  await announce(`本轮 ${report.status}：已投放 ${report.rounds.length}/${corpus.steps.length} 条参与者消息，自动检查未通过 ${report.failures.length} 项，开放式行为待审阅 ${report.manualReviews.length} 项。真实消息、文件和原始失败已保留。`);
}catch(error){report.status=isModelQuotaFailure(error)?'provider-blocked':'failed';report.error=error.stack;process.exitCode=1;
  if(host.child)try{const memory=await host.api('memory');await savePrivateJson(path.join(directory,'memory-after-stop.json'),{...memory,reviewFlushed:false,reason:report.status});}catch{}
  await announce(`${corpus.scenario}执行已停止，已投放 ${report.rounds.length}/${corpus.steps.length} 条（不等于全部获得有效回复）。原因：${error.message}。原始记录保留。`).catch(()=>{});}
finally{if(host.child)await host.api('disconnect').catch(()=>{});await host.stop();await sourceManifest(`source-hashes-end-${report.generation}.json`).catch(()=>{});report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,completed:report.rounds.length,error:report.error,directory}));}
