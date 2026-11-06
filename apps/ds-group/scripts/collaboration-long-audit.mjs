// Independent reconciliation, never rewrites the frozen runner's raw verdicts.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {buildCollaborationCorpus} from './collaboration-long-corpus.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
export function researchTraceEvidence(receipt,events) {
  const ids=new Set((receipt.toolReceipts||[]).map(t=>t.callId)),proof=[];
  for(const event of events) {
    if(event.type!=='tool/call'||!ids.has(event.data?.callId))continue;
    const call=event.data,result=events.find(e=>e.type==='tool/result'&&e.data?.message?.toolCallId===call.callId);
    if(!result||result.data.message.isError)continue;
    const args=typeof call.arguments==='string'?call.arguments:JSON.stringify(call.arguments);
    const urls=[...args.matchAll(/https?:\/\/[^\s\\"'<>]+/g)].map(m=>m[0]).filter(url=>{try{return /(^|\.)(w3\.org|nodejs\.org|rfc-editor\.org|ietf\.org)$/.test(new URL(url).hostname);}catch{return false;}});
    if(!urls.length)continue;
    const output=(result.data.message.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
    if(!/web_fetch|bash|terminal|exec/.test(call.name))continue;
    // A URL in an echo is not a fetch. A successful shell exit is not HTTP 200.
    const networkCommand=/\b(curl|wget)\b|(?:await\s+)?fetch\(|requests\.get\(|urlopen\(/.test(args);
    const nativeFetch=call.name==='web_fetch';
    const http200=/(?:^|\n|\s)200(?:\s|$)|HTTP\/\S+\s+200\b/.test(output);
    proof.push({callId:call.callId,tool:call.name,urls:[...new Set(urls)],resultSha256:sha(output),
      level:nativeFetch?'native-fetch-returned':networkCommand&&http200?'observed-http-200':networkCommand?'request-completed-needs-content-review':'url-only-not-proof'});
  }
  return proof;
}
export async function auditRun(directory) {
  const raw=await readFile(path.join(directory,'report.json'),'utf8'),report=JSON.parse(raw),corpus=buildCollaborationCorpus();
  const events=(await readFile(path.join(directory,'host/events.jsonl'),'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.type.startsWith('tool/'));
  let interventions=[];try{interventions=(await readFile(path.join(directory,'interventions.jsonl'),'utf8')).split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code!=='ENOENT')throw e;}
  const clarifiedAt=interventions.find(e=>e.type==='natural-requirement-refinement')?.at;
  const research=[];
  for(const row of report.rounds)if(corpus.steps[row.round-1].research) {
    const attempt=report.attempts.find(a=>a.round===row.round),evidence=researchTraceEvidence(attempt.receipt,events);
    research.push({round:row.round,rawVerdict:row.checks.find(c=>c.name==='actualResearchTool')?.passed,
      fullTraceVerdict:evidence.some(p=>['native-fetch-returned','observed-http-200'].includes(p.level))?'verified-fetch':'needs-content-review',evidence});
  }
  const contractClarifications=[];
  for(const row of report.rounds) {
    const check=row.checks.find(c=>c.name==='independentCodeContract'&&!c.passed);if(!check)continue;
    let cases;try{cases=JSON.parse(check.detail);}catch{continue;}
    const failed=cases.filter(c=>!c.passed);
    if(failed.length===1&&failed[0].name==='trimmed-number'&&clarifiedAt&&row.finishedAt<clarifiedAt)
      contractClarifications.push({round:row.round,rawVerdict:false,classification:'initial-contract-did-not-specify-surrounding-whitespace',
        clarifiedAt,remainingCases:cases.filter(c=>c.passed).length,note:'Retain the raw failure; assess whitespace only after the normal follow-up requirement. This is not retroactive evidence of success.'});
  }
  const calls=(await readFile(path.join(directory,'host/calls.jsonl'),'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const ends=calls.filter(x=>x.event==='end'),ended=new Set(ends.map(x=>x.callId));
  const result={schemaVersion:1,at:new Date().toISOString(),rawReportSha256:sha(raw),completed:report.rounds.length,
    rawStatus:report.status,rawFailures:report.failures,research,contractClarifications,interventions,
    accounting:{modelIds:[...new Set(calls.map(c=>c.model))],completedCalls:ends.length,failedCalls:ends.filter(c=>c.status==='failed').length,
      pendingCalls:calls.filter(c=>c.event==='start'&&!ended.has(c.callId)).length,costComplete:false},
    artifacts:report.rounds.flatMap(r=>(r.artifacts||[]).map(f=>({round:r.round,name:f.name,size:f.size,sha256:f.sha256}))),
    manualReviews:report.manualReviews};
  await writeFile(path.join(directory,'independent-audit.json'),JSON.stringify(result,null,2),{mode:0o600});return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  if(!process.argv[2])throw new Error('Pass the isolated run directory');const r=await auditRun(path.resolve(process.argv[2]));
  console.log(JSON.stringify({completed:r.completed,rawFailureCount:r.rawFailures.length,verifiedResearch:r.research.filter(x=>x.fullTraceVerdict==='verified-fetch').length,
    researchCount:r.research.length,contractClarifications:r.contractClarifications,models:r.accounting,deliveredFiles:r.artifacts.length}));
}
