// Separate, real Matrix regression after the frozen 96-message phase.
// No original message or verdict is replayed or rewritten.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,readdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {packageRoot} from '../src/paths.mjs';
import {MemoryTestHost,MODEL,delay} from './memory-host.mjs';
import {COMMANDCODE_TEST_MODEL} from './memory-test-model.mjs';
import {resolveDsh} from './runtime-config.mjs';
import {checkCollaborationStep} from './collaboration-long-check.mjs';
assert.equal(MODEL,COMMANDCODE_TEST_MODEL);
const env=JSON.parse(await readFile(path.join(packageRoot,'.local/collaboration-live-active.json'),'utf8'));
const phase=path.join(env.directory,'natural-continuation-01'),prior=JSON.parse(await readFile(path.join(phase,'report.json'),'utf8'));
assert.equal(prior.rounds.length,96);assert.match(prior.status,/^completed-/);
const directory=await mkdtemp(path.join(env.directory,'delivery-recheck-')),evidenceDirectory=path.join(directory,'host');await mkdir(evidenceDirectory);
const hostDir=path.join(env.directory,'host'),host=new MemoryTestHost(hostDir);
const setup=JSON.parse(await readFile(path.join(env.directory,'core/matrix-setup.json'),'utf8'));
const observer=setup.participants.find(x=>x.localpart==='watch'),person=setup.participants.find(x=>x.localpart==='lin_b');
const bot=prior.bots[1],roomId=prior.rounds.find(x=>x.round===81).roomId;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const frozenFiles=['report.json','corpus-private.json','host/calls.jsonl','host/events.jsonl'];
const hashes=async()=>Object.fromEntries(await Promise.all(frozenFiles.map(async file=>[file,sha(await readFile(path.join(phase,file)))])));
const sourceFiles=['dsh-connect/native-bridge.mjs','src/message-context.mjs','scripts/collaboration-delivery-recheck.mjs'];
const sourceHashes=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,sha(await readFile(path.join(packageRoot,file)))])));
const report={startedAt:new Date().toISOString(),status:'running',model:MODEL,topology:'real DSCord/Core/Matrix/native DS-Bot/Ombre/Harrier on one physical host',
  parentFrozenBefore:await hashes(),sourceHashes:await sourceHashes(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),rounds:[],checks:[]};
const save=()=>writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
const check=(name,passed,detail)=>report.checks.push({name,passed:Boolean(passed),detail});
async function api(route,body,who=observer){const res=await fetch(env.coreUrl+route,{method:body?'POST':'GET',headers:{authorization:'Bearer '+who.accessToken,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await res.json();if(!res.ok)throw new Error('Core HTTP '+res.status+': '+value.error);return value;}
async function turn(id,body,step){
  const event=await api('/api/rooms/'+encodeURIComponent(roomId)+'/messages',{body:'<@'+bot.id+'> '+body,transactionId:'delivery-recheck-'+id+'-'+randomUUID(),to:[bot.id],mentions:{users:[bot.id],roles:[],everyone:false,here:false}},person);
  const requestId='matrix-'+sha(bot.id+'\0'+event.event_id),row={id,prompt:body,eventId:event.event_id,requestId,startedAt:new Date().toISOString(),artifacts:[]};report.rounds.push(row);await save();
  const deadline=Date.now()+12*60000;
  while(Date.now()<deadline){
    row.receipt=await host.api('receipt',{botId:bot.id,requestId});
    if(row.receipt&&['failed','unknown','cancelled'].includes(row.receipt.status))throw new Error('Turn '+id+' '+row.receipt.status);
    if(row.receipt?.status==='completed'){
      const {events}=await api('/api/rooms/'+encodeURIComponent(roomId)+'/messages?limit=100');
      row.delivered=events.filter(e=>e.sender===bot.id&&e.content?.['org.ds_group']?.replyTo===event.event_id);
      if(row.delivered.length)break;
    }
    await delay(1500);
  }
  assert.ok(row.delivered?.length,'No delivered Matrix reply');
  const folder=path.join(directory,'downloads',id);await mkdir(folder,{recursive:true});
  for(const e of row.delivered)for(const file of e.content?.['org.ds_group']?.attachments||[]){
    if(row.artifacts.some(x=>x.id===file.id))continue;
    const res=await fetch(env.coreUrl+'/api/rooms/'+encodeURIComponent(roomId)+'/attachments/'+encodeURIComponent(file.id)+'?eventId='+encodeURIComponent(e.event_id),{headers:{authorization:'Bearer '+observer.accessToken}});
    assert.equal(res.status,200);const bytes=Buffer.from(await res.arrayBuffer());assert.equal(sha(bytes),file.sha256);assert.equal(bytes.length,file.size);
    const filename=path.join(folder,path.basename(file.name));await writeFile(filename,bytes);row.artifacts.push({...file,path:filename});
  }
  row.verdict=await checkCollaborationStep({step,receipt:row.receipt,delivered:row.delivered,artifacts:row.artifacts,directory:path.join(directory,'independent',id)});
  row.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({id,files:row.artifacts.map(x=>x.name),checks:row.verdict.checks,artifactDelivery:row.receipt.artifactDelivery}));return row;
}
try{
  host.workspace=JSON.parse(await readFile(path.join(hostDir,'workspace.json'),'utf8')).path;host.installation=await resolveDsh();
  host.boot=Math.max(0,...(await readdir(hostDir)).map(name=>Number(/^host-(\d+)\.log$/.exec(name)?.[1]||0)));
  const profile=JSON.parse(await readFile(path.join(hostDir,'scenario-profile.json'),'utf8'));profile.evidenceDirectory=evidenceDirectory;
  await writeFile(path.join(hostDir,'scenario-profile.json'),JSON.stringify(profile),{mode:0o600});
  await writeFile(path.join(directory,'host/workspace.json'),JSON.stringify({path:host.workspace}));await save();
  await host.start();await writeFile(path.join(directory,'host-current.json'),JSON.stringify({pid:host.child.pid,port:host.port,logfile:host.logfile,home:host.home}),{mode:0o600});
  const bots=await host.api('init');check('sameNativeIdentities',JSON.stringify(bots.map(x=>x.id))===JSON.stringify(prior.bots.map(x=>x.nativeBotId)));await host.api('connect');
  await api('/api/rooms/'+encodeURIComponent(env.roomId)+'/messages',{body:'96 条自然续篇已结束，原始结果冻结。现在独立验证代码重发和终端生成文件的交付修复；这两条补测不计入 96 条，也不覆盖原失败。',transactionId:'delivery-recheck-start-'+randomUUID(),to:[]});
  const code=await turn('code','Give me summarize.mjs and summarize.test.mjs again. Run those exact files in a clean directory and include delivered-tests-recheck.txt. Keep the reply short.',{requiredArtifacts:['summarize.mjs','summarize.test.mjs','delivered-tests-recheck.txt'],execution:true,codeContract:true});
  const module=code.artifacts.find(x=>x.name==='summarize.mjs'),suite=code.artifacts.find(x=>x.name==='summarize.test.mjs');
  if(module&&suite){const clean=path.join(directory,'received-code');await mkdir(clean);await copyFile(module.path,path.join(clean,'summarize.mjs'));await copyFile(suite.path,path.join(clean,'summarize.test.mjs'));
    try{const output=execFileSync(process.execPath,['--test'],{cwd:clean,encoding:'utf8',timeout:30000});await writeFile(path.join(directory,'received-code-tests.txt'),output);check('receivedBytesRunInIndependentEmptyDirectory',true,{moduleSha256:module.sha256,testSha256:suite.sha256,output});}
    catch(error){check('receivedBytesRunInIndependentEmptyDirectory',false,String(error.stdout||error.message));}}
  else check('receivedBytesRunInIndependentEmptyDirectory',false,'Missing downloaded code or test');
  const json=await turn('json','Use the terminal to generate acceptance-delivery-recheck.json from the current actual files and a fresh test run. Include expenseTotal, budgetRemaining, attendees and testStatus. Send me the file and a short note.',{artifact:'acceptance-delivery-recheck.json',execution:true,jsonEquals:{expenseTotal:1563,budgetRemaining:237,attendees:16}});
  const acceptance=json.artifacts.find(x=>x.name==='acceptance-delivery-recheck.json');
  const data=acceptance?JSON.parse(await readFile(acceptance.path,'utf8')):null;
  check('downloadedAcceptanceIncludesPassingTestStatus',data&&/pass|success|通过|成功/i.test(JSON.stringify(data.testStatus)));
  const events=(await readFile(path.join(evidenceDirectory,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  for(const row of report.rounds){
    const ids=new Set(row.receipt.toolReceipts.filter(x=>x.name==='bash'&&x.status==='completed').map(x=>x.callId));
    const runs=events.filter(e=>e.type==='tool/call'&&ids.has(e.data.callId)&&/node[^\n]*--test/.test(JSON.stringify(e.data.arguments)));
    const proof=runs.map(call=>{const result=events.find(e=>e.type==='tool/result'&&e.data.message?.toolCallId===call.data.callId);return{callId:call.data.callId,text:(result?.data.message?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n')};});
    row.testRunProof=proof;check(row.id+':actualFreshPassingTestRun',proof.some(x=>/pass\s+20/.test(x.text)&&/fail\s+0/.test(x.text)));
  }
  await host.api('flush');const memory=await host.api('memory');report.embedding=memory.usage;report.memoryErrors=memory.errors;
  report.finalSourceHashes=await sourceHashes();check('fixedRepairSources',JSON.stringify(report.sourceHashes)===JSON.stringify(report.finalSourceHashes));
  report.status=report.rounds.every(x=>x.verdict.checks.every(c=>c.passed))&&report.checks.every(x=>x.passed)?'passed':'completed-with-failures';
}catch(error){report.status='failed';report.error=error.stack;process.exitCode=1;}
finally{
  if(host.child)await host.api('disconnect').catch(()=>{});await host.stop();
  report.parentFrozenAfter=await hashes();check('original96MessagesAndProtocolUnchanged',JSON.stringify(report.parentFrozenBefore)===JSON.stringify(report.parentFrozenAfter));
  try{const calls=(await readFile(path.join(evidenceDirectory,'calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),ends=calls.filter(x=>x.event==='end'),ended=new Set(ends.map(x=>x.callId));
    report.accounting={modelIds:[...new Set(calls.map(x=>x.model))],starts:calls.filter(x=>x.event==='start').length,ended:ends.length,failed:ends.filter(x=>x.status==='failed').length,unfinished:calls.filter(x=>x.event==='start'&&!ended.has(x.callId)).length,costComplete:false};check('ordinaryModelOnly',report.accounting.modelIds.length===1&&report.accounting.modelIds[0]===MODEL);}catch(error){report.accountingError=error.message;}
  if(report.checks.some(x=>!x.passed))report.status='completed-with-failures';report.finishedAt=new Date().toISOString();await save();
  await writeFile(path.join(packageRoot,'.local/collaboration-delivery-recheck-active.json'),JSON.stringify({directory}),{mode:0o600});
  console.log(JSON.stringify({directory,status:report.status,checks:report.checks,accounting:report.accounting,error:report.error}));
}
