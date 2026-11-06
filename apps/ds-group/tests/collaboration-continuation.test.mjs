import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {buildCollaborationContinuation,continuationAssets} from '../scripts/collaboration-continuation-corpus.mjs';
import {checkCollaborationStep,csvRows} from '../scripts/collaboration-long-check.mjs';
import {researchTraceEvidence} from '../scripts/collaboration-long-audit.mjs';

test('continuation covers natural work, chat and delayed withdrawn proposals without replaying old steps',()=>{
  const corpus=buildCollaborationContinuation();
  assert.equal(corpus.steps.length,96);assert.equal(corpus.steps.filter(row=>row.index!==null).length,72);
  assert.equal(corpus.steps.filter(row=>row.type==='chat').length,37);
  assert.ok(corpus.steps.filter(row=>row.research).length>=4);assert.ok(corpus.steps.filter(row=>row.delegation).length>=7);
  const withdrawal=corpus.steps.findIndex(row=>row.body.includes('窗台那个提议我撤回'));
  const laterUse=corpus.steps.findIndex(row=>row.body.includes('陶安问空白名牌在哪里取'));
  assert.ok(laterUse-withdrawal>=24);assert.ok(corpus.maintenance.restarts.some(at=>at>withdrawal+1&&at<laterUse+1));
  assert.equal(corpus.steps.slice(withdrawal+1,laterUse).some(row=>/二楼签到台|一楼窗台/.test(row.body)),false,'The delayed question must not be preceded by a reminder of the answer');
});
test('private numeric expectations follow the actual replacement fixtures and known unit prices',()=>{
  const total=name=>{const[head,...rows]=csvRows(continuationAssets[name]);const records=rows.map(row=>Object.fromEntries(head.map((key,i)=>[key,row[i]])));
    const latest=new Map(records.map(row=>[row.id,row]));const counts={total:0,morning:0,afternoon:0};
    for(const row of latest.values())if(row.status==='confirmed'){counts.total+=Number(row.people);counts[row.slot]+=Number(row.people);}return counts;};
  assert.deepEqual(total('报名续表.csv'),{total:17,morning:6,afternoon:11});
  assert.deepEqual(total('报名终表.csv'),{total:16,morning:6,afternoon:10});
  const amount=160*1.5+30*12.5+600+60*2.8+180;assert.equal(amount,1563);assert.equal(1800-amount,237);
});
test('multi-file delivery checks actual received files and validates the named JSON rather than the CSV',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'dscord-continuation-check-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const csv=path.join(directory,'budget.csv'),json=path.join(directory,'numbers.json');
  await writeFile(csv,'category,total\nprinting,240\nbadges,375\nvenue,600\nwater,168\nreserve,180\n');
  await writeFile(json,JSON.stringify({expenseTotal:1563,budgetRemaining:237,attendees:16}));
  const input={step:{artifact:'budget.csv',alsoArtifact:'numbers.json',requiredArtifacts:['tests.txt'],jsonArtifact:'numbers.json',budgetExpected:1563,jsonEquals:{expenseTotal:1563,attendees:16}},
    delivered:[{content:{body:'Files attached'}}],receipt:{toolReceipts:[]},artifacts:[{name:'budget.csv',path:csv},{name:'numbers.json',path:json}],directory};
  const result=await checkCollaborationStep(input);
  assert.equal(result.checks.find(row=>row.name==='delivered:tests.txt').passed,false);
  assert.equal(result.checks.find(row=>row.name==='downloadedBudgetCategorySum').passed,true);
  assert.equal(result.checks.find(row=>row.name==='json:attendees').passed,true);
  await writeFile(json,JSON.stringify({expenseTotal:1563,attendees:42}));
  assert.equal((await checkCollaborationStep(input)).checks.find(row=>row.name==='json:attendees').passed,false);
});
test('research checks inspect recorded calls and results rather than an echoed URL or abbreviated receipt',async()=>{
  const receipt={toolReceipts:[{callId:'c1',name:'bash',status:'completed'}]};
  const events=[{type:'tool/call',data:{callId:'c1',name:'bash',arguments:{command:'curl -L -w "HTTP %{http_code}" https://www.w3.org/TR/WCAG22/'}}},
    {type:'tool/result',data:{message:{toolCallId:'c1',content:[{type:'text',text:'HTTP 200\n<html>official content</html>'}]}}}];
  const step={research:true,links:['w3.org']},delivered=[{content:{body:'Source: https://www.w3.org/TR/WCAG22/'}}];
  const good=await checkCollaborationStep({step,receipt,delivered,artifacts:[],researchEvidence:researchTraceEvidence(receipt,events)});
  assert.equal(good.checks.find(row=>row.name==='actualResearchTool').passed,true);
  events[0].data.arguments.command='echo https://www.w3.org/TR/WCAG22/';
  const bad=await checkCollaborationStep({step,receipt,delivered,artifacts:[],researchEvidence:researchTraceEvidence(receipt,events)});
  assert.equal(bad.checks.find(row=>row.name==='actualResearchTool').passed,false);
});
