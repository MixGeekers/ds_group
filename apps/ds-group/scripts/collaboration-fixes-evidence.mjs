// Publish focused synthetic regressions separately from the live Matrix run.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {packageRoot} from '../src/paths.mjs';
import {parseBotOutput} from '../src/bot-node.mjs';
const directories=process.argv.slice(2).map(x=>path.resolve(x));
if(!directories.length)throw new Error('Pass the isolated focused run directories in order');
const sha=x=>createHash('sha256').update(x).digest('hex');
const runs=[];
for(const directory of directories) {
  const raw=await readFile(path.join(directory,'report.json'),'utf8'),report=JSON.parse(raw);
  const notes=JSON.parse(await readFile(path.join(directory,'evaluation-notes.json'),'utf8'));
  const events=(await readFile(path.join(directory,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const rounds=[];
  for(const row of report.rounds) {
    const record=row.record;
    // Earlier harness reports held a mutable history array. The exact delivered
    // native user event, recorded before generation, is the evidence authority.
    const sent=events.find(e=>e.type==='user/message'&&(e.data.content||[]).some(b=>b.type==='text'&&b.text.startsWith(`DSCORD_REQUEST=${row.id}\n`)));
    const sentText=sent?.data.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
    const nativeInput=sentText?JSON.parse(sentText.split('\n').at(-1)):null;
    rounds.push({id:row.id,prompt:row.prompt,source:row.request.event,
      actualDeliveredHistory:nativeInput?.recentRoomHistory,nativeInputSha256:sentText?sha(sentText):null,
      status:record.status,reply:parseBotOutput(record.text||'',record.botId,[]).text,
      reviewError:row.reviewError,diagnostics:row.diagnostics,artifactDelivery:record.artifactDelivery,
      artifacts:record.artifacts.map(({name,size,sha256})=>({name,size,sha256})),toolReceipts:record.toolReceipts,
      startedAt:record.startedAt,finishedAt:record.finishedAt});
  }
  const code=report.rounds.find(x=>x.id==='small-code')?.record.artifacts.find(x=>x.name==='count.mjs');
  let independentCode=null;
  if(code) {
    const bytes=await readFile(code.path),mod=await import(pathToFileURL(code.path).href);
    independentCode={actualFileSha256:sha(bytes),matchesDelivery:sha(bytes)===code.sha256,empty:mod.count([])===0,three:mod.count(['a','b','c'])===3};
  }
  const workspace=JSON.parse(await readFile(path.join(directory,'workspace.json'),'utf8')).path;
  const clean=value=>JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='string'
    ?item.replaceAll(directory,'<run>').replaceAll(path.dirname(path.dirname(directory)),'<package>').replaceAll('/private'+workspace,'<native-workspace>').replaceAll(workspace,'<native-workspace>'):item));
  runs.push(clean({run:path.basename(directory),rawStatus:report.status,assessment:{...notes,status:notes.status||notes.adjudicatedStatus},rawReportSha256:sha(raw),
    topology:report.topology,model:report.model,startedAt:report.startedAt,finishedAt:report.finishedAt,
    sourceCommit:report.sourceCommit,sourceHashesByBoot:report.sourceHashesByBoot,sourceHashes:report.sourceHashes,finalSourceHashes:report.finalSourceHashes,
    checks:report.checks,rounds,independentCode,maintenance:report.maintenance,
    accounting:{...report.accounting,unit:'Observed llm/stream lifecycles; full provider HTTP accounting and cost are not independently verified.',
      embeddingReceiptsByBoot:[report.beforeRestart?.usage,report.finalMemory?.usage]},
    finalMemory:{entryCount:report.finalMemory?.entries?.length,errors:report.finalMemory?.errors,
      entries:report.finalMemory?.entries?.map(({id,botId,scope,subjectId,predicate,text,kind,saidBy,sourceRefs,derivation})=>({id,botId,scope,subjectId,predicate,text,kind,saidBy,sourceRefs,derivation}))}}));
}
const output={schemaVersion:1,at:new Date().toISOString(),scope:'Focused real DSH/DS-Bot/Ombre/Harrier. Synthetic Matrix envelopes, no Matrix network or 240-message rerun claim.',runs};
const destination=path.join(packageRoot,'artifacts/memory/collaboration-fixes.json');await mkdir(path.dirname(destination),{recursive:true});
await writeFile(destination,JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({destination,runs:runs.map(x=>({run:x.run,status:x.assessment.status,checks:x.checks.length,independentCode:x.independentCode}))}));
