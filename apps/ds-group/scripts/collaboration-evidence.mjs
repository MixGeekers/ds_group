// Export synthetic scenario evidence; never copy profiles, login URLs or native reasoning logs.
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {packageRoot} from '../src/paths.mjs';
import {auditRun} from './collaboration-long-audit.mjs';
const directory=path.resolve(process.argv[2]||'');
if(!process.argv[2])throw new Error('Pass a finished collaboration run directory');
const read=async file=>JSON.parse(await readFile(path.join(directory,file),'utf8'));
const optional=async file=>{try{return await read(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const lines=async file=>{try{return(await readFile(path.join(directory,file),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return[];throw e;}};
const sha=value=>createHash('sha256').update(value).digest('hex');
const raw=await readFile(path.join(directory,'report.json'),'utf8'),report=JSON.parse(raw);
if(['running','ready','preparing','paused-by-operator'].includes(report.status))throw new Error('Wait until the run stops before publishing a final result');
const corpus=await read('corpus-private.json'),audit=await auditRun(directory),manual=await optional('manual-review.json'),observations=await lines('observations.jsonl'),oracleReview=await optional('oracle-review.json');
const workspace=(await optional('host/workspace.json'))?.path;
const clean=value=>JSON.parse(JSON.stringify(value,(_key,item)=>{
  if(typeof item!=='string')return item;
  let result=item.replaceAll(directory,'<run>').replaceAll(packageRoot,'<package>');
  if(workspace)result=result.replaceAll('/private'+workspace,'<native-workspace>').replaceAll(workspace,'<native-workspace>');
  return result.replace(/\/private\/var\/folders\/[^\s"'`\)]+/g,'<temporary-file>').replace(/\/tmp\/[a-zA-Z0-9._\/-]+/g,'<temporary-file>');
}));
const files=row=>(row.artifacts||[]).map(({name,size,sha256,eventId})=>({name,size,sha256,eventId}));
const calls=await lines('host/calls.jsonl'),ends=calls.filter(x=>x.event==='end'),ended=new Set(ends.map(x=>x.callId));
const manifests=[];for(const name of(await readdir(directory)).filter(x=>/^source-hashes-(start|end)-\d+\.json$/.test(x)))manifests.push({name,...await read(name)});
const body=report.finalMemory;
const unresolvedManual=(report.manualReviews||[]).filter(x=>!manual?.reviews?.some(y=>y.round===x.round));
const published=clean({schemaVersion:1,run:path.basename(directory),status:report.rounds.length===240?'completed-with-findings':report.status,
  acceptance:'The original verdicts, human review and evaluator limitations remain separate; completion does not mean all behavior passed.',
  startedAt:report.initialStartedAt||report.startedAt,finishedAt:report.finishedAt,elapsedMs:Date.parse(report.finishedAt)-Date.parse(report.initialStartedAt||report.startedAt),
  topology:report.topology,model:report.model,browserUrl:report.browserUrl,rawReportSha256:sha(raw),corpusHash:report.corpusHash,
  corpusHashMatches:sha(JSON.stringify(corpus))===report.corpusHash,generations:report.generations||[{generation:1,sourceCommit:report.sourceCommit}],sourceManifests:manifests,
  coverage:{plannedMessages:report.plannedMessages,completedMessages:report.rounds.length,plannedBotRequests:report.plannedBotRequests,
    deliveredBotReplies:report.rounds.filter(x=>x.replyEventIds?.length).length,additionalNaturalMessages:audit.interventions.length,
    types:Object.fromEntries([...new Set(corpus.steps.map(x=>x.type))].map(type=>[type,corpus.steps.filter(x=>x.type===type).length])),
    deliveredFiles:audit.artifacts.length,plannedCompactions:6,completedCompactions:report.maintenance.filter(x=>x.type==='native-compaction'&&x.result?.compacted).length,
    successfulRestarts:report.maintenance.filter(x=>['planned-restart','recovery-restart'].includes(x.type)&&x.identitiesPreserved).length},
  bots:report.bots.map(({id,name,nativeBotId})=>({id,name,nativeBotId})),rooms:report.rooms,
  rounds:report.rounds.map(row=>({...row,artifacts:files(row),prompt:corpus.steps[row.round-1].body})),
  attempts:report.attempts.map(x=>({round:x.round,eventId:x.eventId,requestId:x.requestId,status:x.receipt?.status,sessionId:x.receipt?.sessionId,
    errorCode:x.receipt?.errorCode,toolReceipts:x.receipt?.toolReceipts,artifactDelivery:x.receipt?.artifactDelivery,
    deliveredEvents:x.delivered?.map(e=>({eventId:e.event_id,sender:e.sender,replyTo:e.content?.['org.ds_group']?.replyTo}))})),
  rawFailures:report.failures,maintenance:report.maintenance,contextRecovery:{failedCheckpoint:await optional('context-recovery-144-attempt1.json'),recovery:await optional('context-recovery-144-attempt2.json')},
  independentReview:{research:audit.research,contractClarifications:audit.contractClarifications,replyOmissions:audit.replyOmissions,oracleReview,manual,observations,
    unresolvedCheckpoints:unresolvedManual.map(x=>({round:x.round,criteria:x.criteria})),
    botChatRounds:audit.conversationReviewQueue.map(x=>({round:x.round,reviewed:Boolean(manual?.reviews?.some(y=>y.round===x.round))}))},
  interventions:audit.interventions,accounting:{...audit.accounting,byPurpose:Object.fromEntries([...new Set(ends.map(x=>x.purpose))].map(p=>[p,ends.filter(x=>x.purpose===p).length])),
    usageRecords:ends.filter(x=>x.usage).length,observedUsage:ends.reduce((sum,row)=>{for(const[k,v]of Object.entries(row.usage||{}))if(typeof v==='number')sum[k]=(sum[k]||0)+v;return sum;},{}),
    interrupted:calls.filter(x=>x.event==='start'&&!ended.has(x.callId)).length,
    embeddingByBoot:report.embeddingByBoot,embeddingComplete:!report.maintenance.some(x=>x.type==='runner-restart'),
    embeddingNote:'Counters are client protocol receipts. The first interrupted boot was not captured at shutdown; full-run embedding totals are incomplete. Full provider cost is unknown.'},
  finalMemory:body?{entries:body.entries.map(({id,botId,scope,subjectId,predicate,text,kind,saidBy,sourceRefs,status,derivation,validFrom,validUntil,index,receipt})=>({id,botId,scope,subjectId,predicate,text,kind,saidBy,sourceRefs,status,derivation,validFrom,validUntil,indexed:index?.state==='applied',bodyDurable:receipt?.bodyDurable})),
    sourceMetadata:body.sources.map(({id,eventId,authorId,authorKind,roomId,revision,body,originRefs,withdrawn})=>({id,eventId,authorId,authorKind,roomId,revision,bodySha256:sha(body||''),originRefs,withdrawn})),
    contacts:body.contacts.map(({id,name,aliases,kind})=>({id,name,aliases,kind})),errors:body.errors}:null});
const destination=path.join(packageRoot,'artifacts/memory');await mkdir(destination,{recursive:true});
await writeFile(path.join(destination,'collaboration-live.json'),JSON.stringify(published,null,2)+'\n');
await writeFile(path.join(destination,'collaboration-corpus.json'),JSON.stringify(corpus,null,2)+'\n');
console.log(JSON.stringify({destination,status:published.status,coverage:published.coverage,unresolvedManual:unresolvedManual.length}));
