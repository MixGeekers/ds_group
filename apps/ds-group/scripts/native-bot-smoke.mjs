#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, open, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { packageRoot } from '../src/paths.mjs';
import { resolveDsh } from './runtime-config.mjs';
import { prepareRuntimeDependencies } from './runtime-dependencies.mjs';
const installation = await resolveDsh();
const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-native-bots-'));
const home = path.join(directory, 'home');
const profile = path.join(home, 'profiles/web');
const report = { status: 'failed', level: 'real-native-dsh-scripted-local-provider', remoteModelCalls: 0, checks: [], requests: [] };
const stages = new Map();
const nativeResult = path.join(home, 'bot/workspace/native-result.txt');
const model = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    const messages = input.messages || [];
    const texts = messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : (message.content || []).map(block => block.text || '').join('\n'));
    const content = texts.findLast(text => text.includes('DSCORD_REQUEST=') || text === 'native-local-after-detach') || '';
    const marker = content.match(/^DSCORD_REQUEST=([^\n]+)/)?.[1] || 'ordinary';
    const names = (input.tools || []).map(tool => tool.function.name);
    const creating = marker === 'native-create-probe' && names.includes('create_bot');
    const key = marker;
    const stage = stages.get(key) || 0; stages.set(key, stage + 1);
    const tool = creating && stage === 0 ? { name: 'create_bot', arguments: { name: '研究伙伴', role: '研究', instructions: '核查资料并报告来源。', model: 'native-local/chat' } }
      : marker === 'native-file-probe' && stage === 0 ? { name: 'write', arguments: { file_path: nativeResult, content: 'native tools preserved\n' } }
        : marker === 'native-memory-probe' && stage === 0 ? { name: 'remember', arguments: { text: '合成用户 @owner:native.test 的报告偏好为简体中文，来源群 !server:native.test，事件 $memory。' } }
          : marker === 'native-memory-probe' && stage === 1 ? { name: 'recall', arguments: { query: '@owner:native.test' } } : undefined;
    report.requests.push({ tools: names, model: input.model, marker, createTool: tool?.name === 'create_bot', tool: tool?.name,
      afterDetach: content === 'native-local-after-detach', recalled: messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('报告偏好')) });
    const chunk = delta => ({ id: `local-${report.requests.length}`, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: null }] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify(chunk({ role: 'assistant' }))}\n\n`);
    if (tool) response.write(`data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, id: `tool-${report.requests.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }))}\n\n`);
    else response.write(`data: ${JSON.stringify(chunk({ content: creating ? '已创建研究伙伴，模型和职责已配置。'
      : marker === 'native-file-probe' ? JSON.stringify({ text: '已使用原生 write 保存文件', artifacts: [{ path: nativeResult }] }) : 'native-local-ok' }))}\n\n`);
    const finish = chunk({}); finish.choices[0].finish_reason = tool ? 'tool_calls' : 'stop'; finish.usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
    response.end(`data: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`);
  } catch (error) { report.providerError = error.message; response.writeHead(500); response.end('{}'); }
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
await mkdir(profile, { recursive: true });
const deps = path.join(directory, 'dependencies');
await prepareRuntimeDependencies({ directory: deps, plugin: path.join(packageRoot, 'dsh-plugin'), runtime: installation.runtime });
const harness = path.join(directory, 'native-harness.mjs');
await writeFile(harness, `import {appendFile} from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = ${JSON.stringify(packageRoot)};
const hooks = registerHooks({ resolve(specifier, context, next) {
 if (context.parentURL?.startsWith(pathToFileURL(root).href) && specifier.startsWith('@deepseek-ai/')) return next(specifier, {...context,parentURL:pathToFileURL(${JSON.stringify(path.join(installation.runtime,'package.json'))}).href});
 if (context.parentURL?.startsWith(pathToFileURL(root).href) && (specifier === 'yaml' || specifier === 'deep-view' || specifier.startsWith('deep-view/'))) return next(specifier,{...context,parentURL:pathToFileURL(${JSON.stringify(path.join(deps,'package.json'))}).href});
 return next(specifier,context);
}});
export const inject = ['llm','tools','systemPrompt','sessionController','sessions','sessionTitle','workspaceRegistry','connection'];
export async function apply(ctx) {
 ctx.on('session/event',(session,event)=>appendFile(${JSON.stringify(path.join(directory,'events.jsonl'))},JSON.stringify({sessionId:session.id,...event})+'\\n'));
 const {createRuntime} = await import(pathToFileURL(root+'/vendor/ds-bot/index.js').href);
 const rt = createRuntime(ctx, {mainName:'主理 Bot', memoryReview:false});
 const {NativeBots} = await import(pathToFileURL(root+'/dsh-connect/native-bots.mjs').href);
 const {NativeBridge} = await import(pathToFileURL(root+'/dsh-connect/native-bridge.mjs').href);
 const native = new NativeBots(ctx); let bridge;
 ctx.effect(() => ctx.connection.fetch.register({path:'/api/native-probe',methods:['POST'],requestBody:'buffered',async fetch(request) {
  try {
   const input=await request.json();let value;
   if(input.action==='bind') { const state=await native.state();const id=state.mainBotIds[0];await native.selectModel(id,{model:'native-local/chat'}); await rt.setPermission(rt.botOf(id),'danger-full-access');
    bridge=await new NativeBridge({ctx,native,node:{id:'@main:native.test',name:'主理 Bot',nativeBotId:id,directory:${JSON.stringify(path.join(directory,'bridge'))}},timeoutMs:15000}).initialize();value=await bridge.createBot({botId:'@main:native.test'});
   } else if(input.action==='turn') value=await bridge.turn(input.input);
   else if(input.action==='detach') {await bridge.detach();value=true;}
   else if(input.action==='state') value=await native.state();
   else if(input.action==='local') { const state=await native.state(); const bot=state.bots.find(bot=>bot.id===state.mainBotIds[0]);const agent=await native.agent(bot.sessionId);await native.call('send',{sessionId:bot.id,text:'native-local-after-detach'});await agent.whenIdle();value={sessionId:bot.sessionId,tools:agent.ctx.tools.schemas(agent).map(tool=>tool.name)}; }
   return Response.json({ok:true,value});
  }catch(error){return Response.json({ok:false,error:{message:error.message,stack:error.stack}});}
 }}));
 ctx.effect(()=>()=>hooks.deregister());
}
`);
await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'native-bot-smoke', private: true, type: 'module', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'] } } }));
await writeFile(path.join(profile, 'cordis.yml'), '[]\n');
await writeFile(path.join(home, '.credentials.yaml'), JSON.stringify({version:1,refs:{NATIVE_TEST_KEY:'synthetic-local-key'},records:{}}),{mode:0o600});
await writeFile(path.join(profile, 'cordis.patch.yml'), JSON.stringify([
 { id:'llm-pi-ai',config:{providers:{'native-local':{api:'openai-completions',baseURL:`http://127.0.0.1:${model.address().port}/v1`,models:[{id:'chat'}],apiKeyEnv:'NATIVE_TEST_KEY'}}}},
 { id:'agent-default-model',config:{provider:'native-local',model:'chat'}},
 { id:'web-runtime',config:{openBrowser:false,printUrl:true,surfaceContext:false}},
 { insert:[{id:'native-harness',name:harness}] },
]));
const log = await open(path.join(directory,'host.log'),'a',0o600);
const child=spawn(installation.cli,['web','--host','127.0.0.1','--port',String(port),'--no-open'],{cwd:directory,detached:true,stdio:['ignore',log.fd,log.fd],env:{...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'}});
const exited=new Promise(resolve=>child.once('close',resolve));
let cookie;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(action,input) {
 if(!cookie){const output=await readFile(path.join(directory,'host.log'),'utf8');const url=output.match(/dsh web: (http:\/\/[^\s]+)/)?.[1];if(!url)throw new Error('Waiting for host');const response=await fetch(url,{redirect:'manual'});cookie=response.headers.get('set-cookie')?.split(';')[0];}
 const response=await fetch(`http://127.0.0.1:${port}/api/native-probe`,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({action,input}),signal:AbortSignal.timeout(60000)});
 const result=await response.json();assert.ok(result.ok,JSON.stringify(result.error));return result.value;
}
try {
 let state;for(let i=0;i<100;i++){try{state=await api('state');break;}catch{await delay(500);}}
 assert.ok(state,'native host unavailable');
 const initialId=state.mainBotIds[0];
 const binding=await api('bind');assert.equal(binding.dsBotId,initialId);assert.ok(binding.tools.includes('create_bot'));report.nativeTools = binding.tools; report.checks.push('bindsExistingMainBotWithNativeTools');
 const request={requestId:'native-create-probe',botId:'@main:native.test',event:{eventId:'$create',roomId:'!server:native.test',senderId:'@owner:native.test',body:'native-create-probe: 创建一个研究伙伴，配置模型和职责。'}};
 const result=await api('turn',request);assert.equal(result.status,'completed',JSON.stringify(result));
 state=await api('state');const teammate=state.bots.find(bot=>bot.name==='研究伙伴');assert.ok(teammate);assert.equal(teammate.createdBy,initialId);assert.equal(teammate.model,'native-local/chat');assert.equal(teammate.instructions,'核查资料并报告来源。');report.checks.push('nativeMainBotCreatesAndConfiguresBotFromDscord');
 assert.equal(result.sessionId,initialId);assert.equal(state.rooms.length,0);report.checks.push('serverMessagesUseOriginalNativeSessionWithoutIsolation');
 const count=report.requests.filter(request=>request.createTool).length;const duplicate=await api('turn',request);assert.equal(duplicate.status,'completed');assert.equal(report.requests.filter(request=>request.createTool).length,count);report.checks.push('transportRetryDoesNotRepeatCreation');
 const fileResult=await api('turn',{...request,requestId:'native-file-probe',event:{...request.event,eventId:'$file',body:'用原生 write 保存文件并交付。'}});
 assert.equal(fileResult.status,'completed',JSON.stringify(fileResult));assert.equal(fileResult.artifacts.length,1);assert.equal(await readFile(nativeResult,'utf8'),'native tools preserved\n');report.checks.push('nativeWriteAndArtifactFromOriginalWorkingDirectory');
 const memoryResult=await api('turn',{...request,requestId:'native-memory-probe',event:{...request.event,eventId:'$memory',body:'记住合成用户的报告语言偏好并读取。'}});
 assert.equal(memoryResult.status,'completed',JSON.stringify(memoryResult));assert.ok(report.requests.some(item=>item.marker==='native-memory-probe' && item.recalled));assert.ok(memoryResult.toolReceipts.some(item=>item.name==='remember'&&item.status==='completed'));report.checks.push('originalRememberAndRecallToolsExecute');
 await api('detach');const before=report.requests.filter(item=>item.afterDetach).length;const local=await api('local');assert.equal(local.sessionId,initialId);assert.ok(local.tools.includes('create_bot'));await delay(500);assert.equal(report.requests.filter(item=>item.afterDetach).length,before+1);report.checks.push('ordinaryNativeModeWorksAfterDisconnect');
 state=await api('state');assert.equal(state.bots.length,2);assert.equal(state.bots.find(bot=>bot.id===initialId).name,'主理 Bot');report.checks.push('sameIdentityAndNativeRosterPreserved');
 report.status='passed';
}catch(error){report.error=error.message;process.exitCode=1;}
finally{try{process.kill(-child.pid,'SIGTERM');}catch{}await Promise.race([exited,delay(5000)]);if(child.exitCode===null){try{process.kill(-child.pid,'SIGKILL');}catch{}}await log.close();model.closeAllConnections();await new Promise(resolve=>model.close(resolve));await mkdir(path.join(packageRoot,'.local'),{recursive:true});await writeFile(path.join(packageRoot,'.local/native-bot-smoke.json'),JSON.stringify({...report,directory},null,2));await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:report.checks,error:report.error,directory,calls:report.requests.length},null,2));}
