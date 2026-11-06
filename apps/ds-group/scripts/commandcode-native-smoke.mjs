import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {MemoryTestHost,MODEL} from './memory-host.mjs';
import {COMMANDCODE_TEST_MODEL} from './memory-test-model.mjs';
import {readCommandCodeCatalog} from './commandcode-preflight.mjs';
import {scenarioInstructions} from './collaboration-long-corpus.mjs';
assert.equal(MODEL,COMMANDCODE_TEST_MODEL);
const active=JSON.parse(await readFile('.local/commandcode-check-active.json','utf8'));
const directory=await mkdtemp(path.join(active.directory,'native-'));
await writeFile(path.join(active.directory,'native-current.json'),JSON.stringify({directory}));
const host=new MemoryTestHost(directory),report={startedAt:new Date().toISOString(),model:MODEL,status:'running',checks:[],turns:[]};
report.sourceHashes=Object.fromEntries(await Promise.all(['memory/native.mjs','memory/model-options.mjs','scripts/memory-host.mjs','scripts/memory-host-plugin.mjs','scripts/memory-test-model.mjs','scripts/commandcode-preflight.mjs','scripts/commandcode-native-smoke.mjs'].map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
const save=()=>writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
const histories=[];
async function turn(n,body){const event={eventId:`$goat-probe-${n}`,roomId:'!procurement:probe.test',senderId:'@lin:probe.test',body};
  const result=await host.api('turn',{request:{requestId:`goat-probe-${n}`,botId:'@bot0:memory.test',event,
    context:{source:{transport:'matrix',...event,sender:{id:event.senderId,name:'林青',kind:'human'},timestamp:Date.now()},room:{name:'采购'}},history:structuredClone(histories)}});
  histories.push({...event,senderName:'林青',senderKind:'human',timestamp:Date.now()});report.turns.push({n,body,...result});await save();
  assert.equal(result.record.status,'completed');assert.ok(!result.reviewError,result.reviewError);return result.record;}
try{
  await writeFile(path.join(directory,'scenario-profile.json'),JSON.stringify({instructions:scenarioInstructions}));
  await host.prepare();report.catalog=await readCommandCodeCatalog(host.home);assert.equal(report.catalog.available,true);
  await host.start();report.bots=await host.api('init');
  const first=await turn(1,'我叫林青，平时采购情况给我中文短版就行。这次订27盒，每盒8支笔。请用终端算出总支数，保存成 procurement-probe.txt 并把文件发我。');
  const file=first.artifacts.find(row=>row.name==='procurement-probe.txt');assert.ok(file,'No actual delivered file');
  const bytes=await readFile(file.path);assert.match(bytes.toString(),/216/);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
  assert.ok(first.toolReceipts.some(row=>row.name==='bash'&&row.status==='completed'));
  report.checks.push('nativeDSHToolExecution','actualDeliveredFileBytes');
  report.compaction=await host.api('compact',{index:0});assert.equal(report.compaction.compacted,true);report.checks.push('nativeCompaction');report.embeddingBeforeRestart=(await host.api('memory')).usage;await save();
  await host.stop();await host.start();const rebound=await host.api('init');assert.equal(rebound[0].dsBotId,report.bots[0].dsBotId);report.checks.push('sameBotAfterHostRestart');
  const second=await turn(2,'采购表我又打开了，刚才一共订了多少支笔？一句话告诉我就好。');assert.match(second.text,/216/);report.checks.push('replyAfterCompactionAndRestart');
  const memory=await host.api('memory');report.memory={entries:memory.entries.length,sources:memory.sources.length,usage:memory.usage,errors:memory.errors};
  assert.ok((memory.usage?.queryCalls||0)+(memory.usage?.indexCalls||0)>0);report.checks.push('realMemoryBackendUsed');
  report.status='passed';
}catch(error){report.status='failed';report.error=error.stack;process.exitCode=1;}
finally{await host.stop();try{const calls=(await readFile(path.join(directory,'calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),ends=calls.filter(row=>row.event==='end');
  report.accounting={streamLifecycles:ends.length,failed:ends.filter(row=>row.status==='failed').length,modelIds:[...new Set(calls.map(row=>row.model))],costComplete:false};
  if(report.accounting.modelIds.some(model=>model!==MODEL)){report.status='failed';report.error='Unexpected model observed';process.exitCode=1;}}catch{}
  report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({directory,status:report.status,checks:report.checks,accounting:report.accounting,error:report.error}));}
