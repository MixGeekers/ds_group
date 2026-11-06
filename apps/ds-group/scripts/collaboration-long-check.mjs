import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assets} from './collaboration-long-corpus.mjs';
const execute=promisify(execFile);
export function csvRows(text) {
  const rows=[];let row=[],value='',quoted=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
    else if(c===','&&!quoted){row.push(value);value='';}
    else if((c==='\r'||c==='\n')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(x=>x.length))rows.push(row);row=[];value='';}
    else value+=c;
  }
  if(value||row.length){row.push(value);rows.push(row);}
  if(quoted)throw new Error('Unclosed CSV quote');return rows;
}
const normalize=text=>String(text).normalize('NFKC').replace(/下午两点半/g,'14:30').replace(/下午五点一刻/g,'17:15').replace(/二楼|2楼/g,'二楼').replace(/[\s，。、「」“”]/g,'');
export async function checkCollaborationStep({step,receipt,delivered,artifacts,directory}) {
  const checks=[];const test=(name,passed,detail)=>checks.push({name,passed:Boolean(passed),...(detail?{detail}:{})});
  const reply=delivered.map(e=>e.content.body||'').join('\n');
  const contents=await Promise.all(artifacts.map(async f=>({name:f.name,text:await readFile(f.path,'utf8')})));
  const text=[reply,...contents.map(f=>f.text)].join('\n');
  test('actualMatrixReply',delivered.length>0);
  for(const filename of [step.artifact,step.alsoArtifact].filter(Boolean))test(`delivered:${filename}`,artifacts.some(f=>f.name===filename));
  for(const value of step.contains||[])test(`contains:${value}`,normalize(text).includes(normalize(value)));
  const tools=receipt?.toolReceipts||[];
  if(step.execution)test('actualExecution',tools.some(t=>/^(bash|terminal|exec|shell|python|run_command)$/.test(t.name)&&t.status==='completed'));
  if(step.delegation)test('nativeBotDelegation',tools.some(t=>t.name==='message_bot'&&t.status==='completed'));
  if(step.research) {
    test('citedRelevantDomain',(step.links||[]).some(domain=>text.includes(domain)));
    test('actualResearchTool',tools.some(t=>t.status==='completed'&&(/search|fetch|browse/i.test(t.name)||(/bash|terminal|exec|shell/i.test(t.name)&&/https?:|curl|wget|fetch\(/i.test(JSON.stringify(t))))));
  }
  if(step.csvRoundtrip) {
    try {const output=contents.find(f=>f.name===step.artifact);test('losslessQuotedCsvRoundtrip',JSON.stringify(csvRows(output.text))===JSON.stringify(csvRows(assets['留言.csv'])));}
    catch(error){test('losslessQuotedCsvRoundtrip',false,error.message);}
  }
  if(/^budget-v[123]\.csv$/.test(step.artifact||'')) {
    try {
      const rows=csvRows(contents.find(f=>f.name===step.artifact).text),header=rows[0].map(x=>x.toLowerCase());
      let amount=header.findIndex(x=>/total|amount|subtotal|cost|合计|总额/.test(x)&&!/unit/.test(x));
      if(amount<0)amount=header.length-1;
      const expected=step.artifact==='budget-v1.csv'?1492:step.artifact==='budget-v2.csv'?1548:1623;
      const detailRows=rows.slice(1).filter(r=>!/total|remaining|allowance|budget|总计|合计|余额|余量|上限/i.test(r[0]||''));
      const total=detailRows.reduce((sum,row)=>sum+Number(String(row[amount]||'').replace(/[¥￥$,\s]/g,'')),0);
      test('downloadedBudgetCategorySum',Math.abs(total-expected)<0.001,`observed ${total}; expected ${expected}`);
    }catch(error){test('downloadedBudgetCategorySum',false,error.message);}
  }
  if(/^signup-v[12]\.csv$/.test(step.artifact||'')) {
    try {
      const rows=csvRows(contents.find(f=>f.name===step.artifact).text),header=rows[0].map(x=>x.toLowerCase());
      let amount=header.findIndex(x=>/people|attendee|count|total|人数|数量/.test(x));if(amount<0)amount=header.length-1;
      const slot=header.findIndex(x=>/slot|batch|批次|时段/.test(x));
      const counts=Object.fromEntries(rows.slice(1).map(r=>[String(r[slot<0?0:slot]).toLowerCase(),Number(r[amount])]));
      test('downloadedSignupSlotCounts',counts.morning===(step.artifact==='signup-v1.csv'?10:6)&&counts.afternoon===(step.artifact==='signup-v1.csv'?10:12),JSON.stringify(counts));
    }catch(error){test('downloadedSignupSlotCounts',false,error.message);}
  }
  if(step.jsonEquals) {
    try{const data=JSON.parse(contents.find(f=>f.name===step.artifact).text);for(const [key,expected]of Object.entries(step.jsonEquals))test(`json:${key}`,data[key]===expected,`observed ${JSON.stringify(data[key])}`);}
    catch(error){test('validJsonArtifact',false,error.message);}
  }
  if(step.codeContract) {
    const module=artifacts.find(f=>f.name==='summarize.mjs');
    if(!module)test('independentCodeContract',false,'No delivered module');
    else {
      await mkdir(directory,{recursive:true});
      const probe=path.join(directory,'independent-contract.mjs');
      // These cases are written before the first Bot call and never uploaded.
      await writeFile(probe,`import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {summarize}=await import(pathToFileURL(process.argv[2]).href);
const row=(id,slot,people,status='confirmed')=>({id,slot,people,status,name:'同名'});
const checks=[];const test=(name,fn)=>{try{fn();checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,error:e.message});}};
test('empty',()=>assert.deepEqual(summarize([]),{total:0,bySlot:{morning:0,afternoon:0},activeIds:[]}));
test('latest-id-wins',()=>assert.deepEqual(summarize([row('a','morning',2),row('a','afternoon','3')]),{total:3,bySlot:{morning:0,afternoon:3},activeIds:['a']}));
test('cancelled',()=>assert.deepEqual(summarize([row('a','morning',2),row('a','morning','', 'cancelled')]),{total:0,bySlot:{morning:0,afternoon:0},activeIds:[]}));
test('same-name-distinct-id',()=>assert.equal(summarize([row('a','morning',2),row('b','morning',3)]).total,5));
test('negative',()=>assert.throws(()=>summarize([row('a','morning',-1)])));
test('fraction',()=>assert.throws(()=>summarize([row('a','morning',1.5)])));
test('non-number',()=>assert.throws(()=>summarize([row('a','morning','two')])));
test('unknown-slot',()=>assert.throws(()=>summarize([row('a','evening',2)])));
test('unknown-status',()=>assert.throws(()=>summarize([row('a','morning',2,'maybe')])));
test('trimmed-number',()=>assert.equal(summarize([row('a','morning',' 3 ')]).total,3));
test('special-ids',()=>assert.deepEqual(summarize([row('__proto__','morning',2),row('constructor','afternoon',3)]).activeIds,['__proto__','constructor']));
test('immutable-input',()=>{const input=Object.freeze([Object.freeze(row('a','morning',2))]);assert.equal(summarize(input).total,2);});
console.log(JSON.stringify(checks));if(checks.some(c=>!c.passed))process.exitCode=1;
`);
      let result;try{result=await execute(process.execPath,[probe,module.path],{timeout:30000,maxBuffer:256000});result.exitCode=0;}
      catch(error){result={stdout:error.stdout||'',stderr:error.stderr||error.message,exitCode:error.code};}
      await writeFile(path.join(directory,'independent-contract-result.json'),JSON.stringify(result,null,2));
      test('independentCodeContract',result.exitCode===0,result.stdout||result.stderr);
    }
  }
  return {checks,reply,manualReview:step.review||[],checkpoint:step.checkpoint||null};
}
