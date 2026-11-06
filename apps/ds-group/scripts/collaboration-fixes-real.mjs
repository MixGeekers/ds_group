// Focused real native regression. Separate from the live Matrix long run.
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {MemoryTestHost,MODEL} from './memory-host.mjs';
import {scenarioInstructions} from './collaboration-long-corpus.mjs';
import {packageRoot} from '../src/paths.mjs';
await mkdir(path.join(packageRoot,'.local'),{recursive:true});
const directory=await mkdtemp(path.join(packageRoot,'.local/collaboration-fixes-')),host=new MemoryTestHost(directory);
const report={startedAt:new Date().toISOString(),status:'running',model:MODEL,topology:'real native DSH/DS-Bot/Ombre/Harrier with synthetic Matrix envelopes; no Matrix network claim',rounds:[],checks:[],maintenance:[]};
const save=()=>writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
const check=(name,passed,detail)=>report.checks.push({name,passed:Boolean(passed),detail});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceFiles=['memory/native.mjs','memory/service.mjs','memory/review.mjs','dsh-connect/native-bridge.mjs','dsh-plugin/work-files.mjs','scripts/memory-host-plugin.mjs','scripts/collaboration-fixes-real.mjs'];
async function sourceHashes(){const hashes={};for(const file of sourceFiles)hashes[file]=sha(await readFile(path.join(packageRoot,file)));return hashes;}
const room='!harbor:fix.test',other='!break:fix.test';
const people={planner:{id:'@lin_a:fix.test',name:'林青',kind:'human'},data:{id:'@lin_b:fix.test',name:'林青',kind:'human'},field:{id:'@song:fix.test',name:'宋禾',kind:'human'}};
const histories=new Map();
const statement=(id,person,body,roomId=room)=>({eventId:`$${id}`,roomId,senderId:people[person].id,senderName:people[person].name,senderKind:'human',body,timestamp:Date.now()});
const addHistory=e=>{const h=histories.get(e.roomId)||[];h.push(e);histories.set(e.roomId,h);};
async function turn(id,person,body,roomId=room){
  const event=statement(id,person,body,roomId),request={requestId:id,botId:'@bot0:memory.test',event,
    context:{room:{id:roomId,name:roomId===room?'码头活动筹备':'休息区'},source:{transport:'matrix',eventId:event.eventId,roomId,timestamp:event.timestamp,sender:people[person]}},
    history:histories.get(roomId)||[]};
  const result=await host.api('turn',{index:0,request});addHistory(event);
  const row={id,prompt:body,request,...result};report.rounds.push(row);await save();console.log(JSON.stringify({id,status:result.record.status,artifacts:result.record.artifacts.map(x=>x.name),reviewError:result.reviewError}));
  return row;
}
try{
  report.sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:packageRoot,encoding:'utf8'}).trim();report.sourceHashes={};
  report.sourceHashes=await sourceHashes();report.sourceHashesByBoot=[{boot:1,hashes:report.sourceHashes}];
  await writeFile(path.join(directory,'scenario-profile.json'),JSON.stringify({instructions:scenarioInstructions}));await save();
  await host.start();const bots=report.bots=await host.api('init');
  const staged=await turn('staged-summary','planner','请在这次附件目录的 outputs 子目录里生成 organizer-summary.md：写出58人每人3份资料一共多少份，以及预算1800减去支出1623的余额。完成后只回一句普通的简短说明。');
  const file=staged.record.artifacts.find(x=>x.name==='organizer-summary.md');let bytes=file?await readFile(file.path):null;
  check('actualStagedFileBytes',file&&bytes.includes('174')&&bytes.includes('177')&&sha(bytes)===file.sha256,{artifactDelivery:staged.record.artifactDelivery,files:staged.record.artifacts});
  check('stagedFallbackPathActuallyUsed',staged.record.artifactDelivery==='staged-output');
  const before=await readFile(path.join(directory,'calls.jsonl'),'utf8');const retry=await host.api('turn',{index:0,request:staged.request});
  check('sameRequestRetainsArtifactsWithoutNewGeneration',JSON.stringify(retry.record.artifacts)===JSON.stringify(staged.record.artifacts)&&(await readFile(path.join(directory,'calls.jsonl'),'utf8'))===before);
  const unknown=statement('unaddressed-elevator','field','场地方还没答复电梯能不能用，先按待确认写。我负责现场入口。');addHistory(unknown);
  const preference=statement('unaddressed-planner-style','planner','平时项目进度给我中文短版就行，最多三条，太长我看不过来。');addHistory(preference);
  await turn('venue-notes','planner','把我们已经知道的现场条件和待确认事项整理成 venue-status.md，方便我接着问场地方。');
  let memory=await host.api('memory');const source=memory.sources.find(x=>x.eventId===unknown.eventId);
  check('unaddressedDiscussionAutomaticallyStoredWithOriginalAuthor',source&&memory.entries.some(x=>x.derivation==='current'&&x.sourceRefs.some(ref=>ref.id===source.id)&&x.text.includes('电梯')),{sourceId:source?.id,authorId:source?.authorId});
  await turn('data-preference','data','For number reviews I normally use an English table. Current spending is 1623 against a cap of 1800, and registration is 18 people. Give me a quick check of those figures.');
  await turn('casual-break','planner','我去倒了杯淡茶，窗外风挺大。陪我随便聊两句就好，不用给我安排下一步。',other);
  const code=await turn('small-code','planner','做一个 count.mjs，导出 count(items) 返回数组长度，给空数组和三元素数组各跑一个测试，把代码文件给我。');
  check('ordinaryCodeFileActuallyDelivered',code.record.artifacts.some(x=>x.name==='count.mjs'),code.record.artifactDelivery);
  report.maintenance.push({type:'compact',result:await host.api('compact',{index:0})});
  memory=await host.api('memory');report.beforeRestart=memory;await save();await host.stop();
  report.sourceHashesByBoot.push({boot:2,hashes:await sourceHashes()});await host.start();const rebound=await host.api('init');
  check('nativeIdentitySurvivesRestart',bots[0].dsBotId===rebound[0].dsBotId);report.maintenance.push({type:'restart'});
  const data=await turn('data-after-restart','data','给我当前的数字概览。');check('dataPreferenceAfterRestart',/\|/.test(data.record.text)&&/spen|expense|budget|allowance|registr/i.test(data.record.text)&&/177/.test(data.record.text),data.record.text);
  const planner=await turn('planner-after-restart','planner','我也要一份现在的项目进度。');report.manualReviews=[{id:planner.id,criteria:'Same-name planner receives concise Chinese, at most three main points',text:planner.record.text}];
  await turn('elevator-confirmed','field','管理员刚确认当天电梯可以用，由他操作。我会在南门接需要帮助的人，再一起上二楼。请给值班同事一句清楚的说明。');
  await turn('pause-chat','planner','听到事情终于有了答复，心里松了一口气。你也歇一下吧。',other);
  report.maintenance.push({type:'compact',result:await host.api('compact',{index:0})});
  const final=await turn('elevator-handoff','field','现场电梯现在是什么情况，需要帮助的来宾该找谁？');
  check('confirmedPlanSurvivesCompaction',/管理员/.test(final.record.text)&&/宋禾|你/.test(final.record.text)&&/南门/.test(final.record.text)&&!/电梯.*(?:还没确认|不能用|没有电梯)/.test(final.record.text),final.record.text);
  report.finalMemory=await host.api('memory');await host.api('flush');
  const events=(await readFile(path.join(directory,'calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),ends=events.filter(x=>x.event==='end'),ended=new Set(ends.map(x=>x.callId));
  report.accounting={modelIds:[...new Set(events.map(x=>x.model))],calls:ends.length,failed:ends.filter(x=>x.status==='failed').length,unfinished:events.filter(x=>x.event==='start'&&!ended.has(x.callId)).length,costComplete:false};
  check('specifiedRemoteModelOnly',JSON.stringify(report.accounting.modelIds)===JSON.stringify([MODEL]));
  report.finalSourceHashes=await sourceHashes();check('fixedSourcesThroughout',report.sourceHashesByBoot.every(x=>JSON.stringify(x.hashes)===JSON.stringify(report.sourceHashes))&&JSON.stringify(report.finalSourceHashes)===JSON.stringify(report.sourceHashes));
  check('noAutomaticReviewFailure',report.rounds.every(x=>!x.reviewError),report.rounds.filter(x=>x.reviewError).map(x=>({id:x.id,error:x.reviewError})));
  report.status=report.checks.every(x=>x.passed)?'checks-passed-manual-review-pending':'completed-with-failures';
}catch(error){report.status='failed';report.error=error.stack;process.exitCode=1;}
finally{await host.stop();report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({directory,status:report.status,checks:report.checks}));}
