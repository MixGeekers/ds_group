import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, realpath, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeBridge } from '../dsh-connect/native-bridge.mjs';
import { NativeBots } from '../dsh-connect/native-bots.mjs';
import { parseBotOutput } from '../src/bot-node.mjs';

async function fixture(t, { idle = Promise.resolve(), send, cwd } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'native-bridge-'));
  const handlers = new Map(); let cancelled = 0; let turn = 0;
  const ctx = { get(name) { return name === 'workingDirectory' && cwd ? { get: () => cwd } : undefined; }, on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); } };
  const native = new NativeBots(ctx);
  native.bot = async () => ({ id: 'native-one', name: 'Original', role: 'Research', sessionId: 'native-one', model: 'dsh/model' });
  native.agent = async () => ({ whenIdle: () => idle, cancel: () => cancelled++, ctx: { tools: { schemas: () => ['create_bot','remember','bash'].map(name => ({ name })) } } });
  const calls = [];
  const event = async (type, data, sessionId = 'native-one') => handlers.get('session/event')?.({ id: sessionId }, { type, data });
  native.call = async (endpoint, payload) => {
    if (endpoint === 'observe') return { accepted: payload.inputs.length };
    if (endpoint === 'attention-view') return { schema: 2, currentClaims: [], recentSources: [], historyGaps: [] };
    assert.equal(endpoint, 'send');
    assert.equal(payload.requestId, JSON.parse(payload.text.split('\n').at(-1)).requestId);
    calls.push(JSON.parse(payload.text.split('\n').at(-1))); turn++;
    await event('turn/start', { turn });
    await event('user/message', { content: [{ type: 'text', text: payload.text }], source: payload.source });
    if (send) return send({ event, turn, payload });
    await event('assistant/message', { turn, message: { content: [{ type: 'text', text: calls.at(-1).currentMessage.body }] } });
    await event('turn/end', { turn, reason: { kind: 'completed' } });
  };
  const node = { id: '@native:home.test', nativeBotId: 'native-one', directory };
  const bridge = await new NativeBridge({ ctx, native, node, timeoutMs: 2000 }).initialize();
  t.after(async () => { await bridge.detach(); await rm(directory, { recursive: true, force: true }); });
  const request = (id, room = '!a:home.test') => ({ requestId: id, botId: node.id,
    event: { roomId: room, eventId: `$${id}`, senderId: '@same:home.test', senderName: 'Same', senderKind: 'human', body: `Reply for ${room}` } });
  return { bridge, native, node, calls, event, handlers, request, cancelled: () => cancelled };
}

test('native inputs keep original tools, distinguish interleaved rooms and persist retries without generation', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.bridge.createBot({ botId: f.node.id })).tools, ['create_bot','remember','bash']);
  const a = f.request('one'); const b = f.request('two', '!b:other.test');
  const [first, second] = await Promise.all([f.bridge.turn(a), f.bridge.turn(b)]);
  assert.equal(first.text, 'Reply for !a:home.test'); assert.equal(second.text, 'Reply for !b:other.test');
  assert.equal(first.sessionId, second.sessionId);
  assert.notEqual(f.calls[0].context.key, f.calls[1].context.key);
  assert.equal(f.calls[1].replyRoute.eventId, '$two');
  await f.bridge.turn(a); assert.equal(f.calls.length, 2);
  await f.bridge.detach();
  const restarted = await new NativeBridge({ ctx: { on: () => () => {} }, native: f.native, node: f.node }).initialize();
  assert.equal((await restarted.turn(a)).text, first.text);
  await assert.rejects(restarted.turn({ ...a, event: { ...a.event, body: 'changed' } }), { code: 'REQUEST_ID_CONFLICT' });
  await restarted.detach();
});

test('disconnect while original Bot is busy returns promptly and never cancels its native work', async t => {
  const f = await fixture(t, { idle: new Promise(() => {}) });
  const pending = f.bridge.turn(f.request('waiting'));
  while (!f.bridge.waiting) await new Promise(resolve => setTimeout(resolve, 1));
  await f.bridge.detach();
  assert.equal((await pending).status, 'unknown');
  assert.equal(f.cancelled(), 0); assert.equal(f.calls.length, 0);
});

test('native handoff follows its exchange and ignores an unrelated local conversation', async t => {
  const f = await fixture(t, { send: async ({ event, turn }) => {
    await event('user/message', { source: { kind: 'bot', role: 'request', senderSessionId: 'native-one', exchangeId: 'work-1' } }, 'native-peer');
    await event('assistant/message', { turn, message: { content: [{ type: 'text', text: '[HANDOFF_WAIT]' }] } });
    await event('turn/end', { turn, reason: { kind: 'completed' } });
    await event('turn/start', { turn: 99 });
    await event('user/message', { content: [{ type: 'text', text: 'Local user request' }], source: { kind: 'user' } });
    await event('user/message', { source: { kind: 'bot', role: 'request', senderSessionId: 'native-one', exchangeId: 'unrelated-work' } }, 'native-peer');
    await event('assistant/message', { turn: 99, message: { content: [{ type: 'text', text: 'Local-only answer' }] } });
    await event('turn/end', { turn: 99, reason: { kind: 'completed' } });
    await event('turn/start', { turn: 101 });
    await event('user/message', { source: { kind: 'bot', role: 'reply', replyTo: 'unrelated-work' } });
    await event('assistant/message', { turn: 101, message: { content: [{ type: 'text', text: 'Unrelated delegated answer' }] } });
    await event('turn/end', { turn: 101, reason: { kind: 'completed' } });
    await event('turn/start', { turn: 100 });
    await event('user/message', { source: { kind: 'bot', role: 'reply', replyTo: 'work-1' } });
    await event('assistant/message', { turn: 100, message: { content: [{ type: 'text', text: 'Delegated result' }] } });
    await event('turn/end', { turn: 100, reason: { kind: 'completed' } });
  } });
  const result = await f.bridge.turn(f.request('handoff'));
  assert.equal(result.status, 'completed'); assert.equal(result.text, 'Delegated result');
});

test('usage observation cannot fail or restrict a native model stream', async t => {
  const f = await fixture(t);
  f.bridge.run = { seen: true, record: { sessionId: 'native-one', calls: [] } };
  const save = f.bridge.save; f.bridge.save = async () => { throw new Error('synthetic persistence outage'); };
  const chunks = [];
  for await (const chunk of f.bridge.observeUsage({ sessionId: 'native-one', provider: 'native', model: 'model' }, async function* () { yield { type: 'text', text: 'unchanged' }; })) chunks.push(chunk);
  assert.deepEqual(chunks, [{ type: 'text', text: 'unchanged' }]);
  f.bridge.save = save; f.bridge.run = null;
});

test('native account quota failures remain distinguishable from other failed turns', async t => {
  let failure={code:'QUOTA',message:'429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}'};
  const f=await fixture(t,{send:async({event,turn})=>{
    await event('turn/end',{turn,reason:{kind:'error',error:failure}});
  }});
  const blocked=await f.bridge.turn(f.request('quota'));
  assert.equal(blocked.status,'failed');assert.equal(blocked.errorCode,'MODEL_QUOTA_EXCEEDED');
  assert.deepEqual(blocked.nativeFailure,failure);
  failure={code:'INVALID_REQUEST',message:'Invalid tool id'};
  assert.equal((await f.bridge.turn(f.request('other-error'))).errorCode,'NATIVE_TURN_FAILED');
});

test('a native context-part handoff keeps the request and does not publish its acknowledgement', async t => {
  const f = await fixture(t, { send: async ({ event, turn }) => {
    await event('assistant/message', { turn, message: { content: [{ type: 'text', text: 'Still working' }] } });
    await event('turn/end', { turn, reason: { kind: 'blocked' } });
    f.native.bot = async () => ({ id: 'native-one', sessionId: 'native-next', model: 'dsh/model' });
    await event('turn/start', { turn: 2 }, 'native-next');
    await event('user/message', { source: { kind: 'bot', handoff: true, resume: true } }, 'native-next');
    await event('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'Noted. I have my handoff note and carry on from here.' }] } }, 'native-next');
    await event('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'Final result after native context handoff' }] } }, 'native-next');
    await event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 'native-next');
  } });
  const result = await f.bridge.turn(f.request('part-switch'));
  assert.equal(result.status, 'completed'); assert.equal(result.sessionId, 'native-next');
  assert.equal(result.text, 'Final result after native context handoff');
});

test('native present delivers actual files with an ordinary final answer and resolves the native working folder', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'native-present-work-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, 'absolute.txt'), '441 !north:memory.test');
  await writeFile(path.join(cwd, 'relative.txt'), 'independent native working folder');
  const f = await fixture(t, { cwd, send: async ({ event, turn }) => {
    await event('tool/call', { turn, callId: 'present-files', name: 'present', arguments: JSON.stringify({ files: [
      { path: path.join(cwd, 'absolute.txt') }, { path: 'relative.txt' },
    ] }) });
    await event('tool/result', { turn, message: { toolCallId: 'present-files', isError: false, content: [{ type: 'text', text: 'Presented both files' }] } });
    await event('assistant/message', { turn, message: { content: [{ type: 'text', text: 'Files are ready.' }] } });
    await event('turn/end', { turn, reason: { kind: 'completed' } });
  } });
  const result = await f.bridge.turn(f.request('present-files'));
  assert.equal(result.status, 'completed'); assert.equal(result.text, 'Files are ready.');
  assert.deepEqual(result.artifacts.map(file => file.path), await Promise.all(['absolute.txt', 'relative.txt'].map(name => realpath(path.join(cwd, name)))));
  assert.equal(await readFile(result.artifacts[0].path, 'utf8'), '441 !north:memory.test');
  assert.equal(result.artifacts[0].size, Buffer.byteLength('441 !north:memory.test'));
  assert.match(result.artifacts[0].sha256, /^[a-f0-9]{64}$/);
});

test('an intentionally staged task output is delivered when the native answer forgets its envelope', async t => {
  const f = await fixture(t, { send: async ({ event, turn }) => {
    const workdir=f.calls.at(-1).attachmentsDirectory;
    await mkdir(path.join(workdir,'outputs'),{recursive:true});
    await writeFile(path.join(workdir,'outputs','organizer-summary.md'),'Expense 1548; allowance 252; attendance 18.');
    await writeFile(path.join(workdir,'input.csv'),'not a deliverable');
    await event('assistant/message',{turn,message:{content:[{type:'text',text:'The organizer summary is attached.'}]}});
    await event('turn/end',{turn,reason:{kind:'completed'}});
  }});
  const request=f.request('staged-output'),result=await f.bridge.turn(request);
  assert.equal(result.status,'completed');assert.equal(result.artifacts.length,1);
  assert.equal(result.artifacts[0].name,'organizer-summary.md');
  assert.equal(await readFile(result.artifacts[0].path,'utf8'),'Expense 1548; allowance 252; attendance 18.');
  assert.equal(result.artifactDelivery,'staged-output');
  assert.deepEqual((await f.bridge.turn(request)).artifacts,result.artifacts);assert.equal(f.calls.length,1);
});

test('explicit native delivery remains authoritative over other staged files', async t => {
  const f = await fixture(t, { send: async ({ event, turn }) => {
    const workdir=f.calls.at(-1).attachmentsDirectory;
    await mkdir(path.join(workdir,'outputs'),{recursive:true});
    const selected=path.join(workdir,'outputs','selected.md');await writeFile(selected,'selected');
    await writeFile(path.join(workdir,'outputs','draft.md'),'not selected');
    await event('assistant/message',{turn,message:{content:[{type:'text',text:JSON.stringify({text:'Only selected',artifacts:[{path:selected}]})}]}});
    await event('turn/end',{turn,reason:{kind:'completed'}});
  }});
  const result=await f.bridge.turn(f.request('selected-output'));
  assert.equal(result.status,'completed');assert.deepEqual(result.artifacts.map(x=>x.name),['selected.md']);
});

test('an explicit empty artifact list does not publish staged drafts', async t => {
  const f=await fixture(t,{send:async({event,turn})=>{
    const workdir=f.calls.at(-1).attachmentsDirectory;
    await mkdir(path.join(workdir,'outputs'),{recursive:true});await writeFile(path.join(workdir,'outputs','draft.md'),'draft');
    await event('assistant/message',{turn,message:{content:[{type:'text',text:JSON.stringify({text:'No files to deliver yet',artifacts:[]})}]}});
    await event('turn/end',{turn,reason:{kind:'completed'}});
  }});
  assert.deepEqual((await f.bridge.turn(f.request('empty-explicit'))).artifacts,[]);
});

test('ordinary Markdown links to actual native files become attachments, excluding web links and examples', async t => {
  const cwd=await mkdtemp(path.join(os.tmpdir(),'native-link-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  await writeFile(path.join(cwd,'count.mjs'),'export const count = a => a.length;');
  const f=await fixture(t,{cwd,send:async({event,turn})=>{
    const text='Here is [count.mjs](./count.mjs). See [docs](https://nodejs.org/api/test.html).\n```md\n[example](/missing/example.md)\n```';
    await event('assistant/message',{turn,message:{content:[{type:'text',text}]}});
    await event('turn/end',{turn,reason:{kind:'completed'}});
  }});
  const result=await f.bridge.turn(f.request('native-file-link'));
  assert.equal(result.status,'completed');assert.deepEqual(result.artifacts.map(x=>x.name),['count.mjs']);
  assert.equal(result.artifactDelivery,'native-file-link');
  assert.equal(await readFile(result.artifacts[0].path,'utf8'),'export const count = a => a.length;');
});

test('a final filename can deliver the matching successful file-tool output, but not unrelated or failed writes', async t => {
  const f=await fixture(t,{send:async({event,turn})=>{
    const workdir=f.calls.at(-1).attachmentsDirectory;
    for(const [name,failed]of [['venue-status.md',false],['draft.md',false],['failed.md',true]]){
      const filename=path.join(workdir,name);await writeFile(filename,name);
      await event('tool/call',{turn,callId:name,name:'write',arguments:JSON.stringify({file_path:filename,content:name})});
      await event('tool/result',{turn,message:{toolCallId:name,isError:failed}});
    }
    await event('assistant/message',{turn,message:{content:[{type:'text',text:'venue-status.md 已生成；failed.md 没写成功。'}]}});
    await event('turn/end',{turn,reason:{kind:'completed'}});
  }});
  const result=await f.bridge.turn(f.request('mentioned-output'));
  assert.equal(result.status,'completed');assert.deepEqual(result.artifacts.map(x=>x.name),['venue-status.md']);
  assert.equal(result.artifactDelivery,'mentioned-tool-output');
});

test('failed present calls and other turns never become native request attachments', async t => {
  const f = await fixture(t, { send: async ({ event, turn }) => {
    const arguments_ = JSON.stringify({ files: [{ path: path.join(f.node.directory, 'not-delivered.txt') }] });
    await event('tool/call', { turn, callId: 'failed-present', name: 'present', arguments: arguments_ });
    await event('tool/result', { turn, message: { toolCallId: 'failed-present', isError: true } });
    await event('tool/call', { turn: 999, callId: 'other-turn', name: 'present', arguments: arguments_ });
    await event('tool/result', { turn: 999, message: { toolCallId: 'other-turn', isError: false } });
    await event('tool/call', { turn, callId: 'other-session', name: 'present', arguments: arguments_ }, 'native-peer');
    await event('tool/result', { turn, message: { toolCallId: 'other-session', isError: false } }, 'native-peer');
    await event('assistant/message', { turn, message: { content: [{ type: 'text', text: 'No delivered file.' }] } });
    await event('turn/end', { turn, reason: { kind: 'completed' } });
  } });
  await writeFile(path.join(f.node.directory, 'not-delivered.txt'), 'exists but not delivered');
  const result = await f.bridge.turn(f.request('failed-present'));
  assert.equal(result.status, 'completed'); assert.deepEqual(result.artifacts, []);
});

test('native present plus an explicit delivery envelope returns one durable artifact on retry', async t => {
  const f = await fixture(t, { send: async ({ event, turn }) => {
    const filename = path.join(f.node.directory, 'once.txt');
    await event('tool/call', { turn, callId: 'present-once', name: 'present', arguments: { files: [{ path: filename }] } });
    await event('tool/result', { turn, message: { toolCallId: 'present-once', isError: false } });
    await event('assistant/message', { turn, message: { content: [{ type: 'text', text: JSON.stringify({ text: 'Delivered', artifacts: [{ path: filename }] }) }] } });
    await event('turn/end', { turn, reason: { kind: 'completed' } });
  } });
  await writeFile(path.join(f.node.directory, 'once.txt'), 'once');
  const request = f.request('present-once'), result = await f.bridge.turn(request);
  assert.equal(result.status, 'completed'); assert.equal(result.artifacts.length, 1);
  assert.deepEqual((await f.bridge.turn(request)).artifacts, result.artifacts); assert.equal(f.calls.length, 1);
});

test('a file removed after native present fails the actual-byte delivery check', async t => {
  const f = await fixture(t, { send: async ({ event, turn }) => {
    const filename = path.join(f.node.directory, 'removed.txt');
    await event('tool/call', { turn, callId: 'present-removed', name: 'present', arguments: JSON.stringify({ files: [{ path: filename }] }) });
    await event('tool/result', { turn, message: { toolCallId: 'present-removed', isError: false } });
    await rm(filename);
    await event('assistant/message', { turn, message: { content: [{ type: 'text', text: 'File was presented.' }] } });
    await event('turn/end', { turn, reason: { kind: 'completed' } });
  } });
  await writeFile(path.join(f.node.directory, 'removed.txt'), 'removed');
  const result = await f.bridge.turn(f.request('present-removed'));
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'WORK_FILE_NOT_FOUND'); assert.deepEqual(result.artifacts, []);
});

test('ordinary delegation acknowledgements wait for all correlated native replies', async t => {
  let replyWork;
  const f = await fixture(t, { send: async ({ event, turn }) => {
    for (const exchangeId of ['first', 'second']) await event('user/message', { source: {
      kind: 'bot', role: 'request', senderSessionId: 'native-one', exchangeId,
    } }, 'native-peer');
    await event('assistant/message', { turn, message: { content: [{ type: 'text', text: 'I delegated the work and will pass on the results later.' }] } });
    await event('turn/end', { turn, reason: { kind: 'completed' } });
    // Return from send before either reply, as the real native tool does.
    replyWork = (async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      await event('turn/start', { turn: 2 });
      await event('user/message', { source: { kind: 'bot', role: 'reply', replyTo: 'first' } });
      await event('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'The first answer is 437; still waiting for the second.' }] } });
      await event('turn/end', { turn: 2, reason: { kind: 'completed' } });
      await new Promise(resolve => setTimeout(resolve, 20));
      await event('turn/start', { turn: 3 });
      await event('user/message', { source: { kind: 'bot', role: 'reply', replyTo: 'second' } });
      await event('assistant/message', { turn: 3, message: { content: [{ type: 'text', text: 'Both actual answers: 437 and 391.' }] } });
      await event('turn/end', { turn: 3, reason: { kind: 'completed' } });
    })();
  } });
  const result = await f.bridge.turn(f.request('await-delegation')); await replyWork;
  assert.equal(result.status, 'completed'); assert.equal(result.text, 'Both actual answers: 437 and 391.');
});

test('native direct-to-user delegation does not wait for a reply to the originating Bot', async t => {
  const f = await fixture(t, { send: async ({ event, turn }) => {
    await event('user/message', { source: { kind: 'bot', role: 'request', senderSessionId: 'native-one', exchangeId: 'direct', audience: 'user' } }, 'native-peer');
    await event('assistant/message', { turn, message: { content: [{ type: 'text', text: 'The Bot will answer you in its own native chat.' }] } });
    await event('turn/end', { turn, reason: { kind: 'completed' } });
  } });
  const result = await f.bridge.turn(f.request('direct-user'));
  assert.equal(result.status, 'completed'); assert.equal(result.text, 'The Bot will answer you in its own native chat.');
});

test('native file envelopes after an explanation or Markdown fence still deliver actual bytes', async t => {
  let fenced = false;
  const f = await fixture(t, { send: async ({ event, turn }) => {
    const envelope = JSON.stringify({ text: 'Ready', artifacts: [{ path: path.join(f.node.directory, 'envelope.txt') }] });
    const text = `File is ready.\n\n${fenced ? `\`\`\`json\n${envelope}\n\`\`\`` : envelope}`;
    await event('assistant/message', { turn, message: { content: [{ type: 'text', text }] } });
    await event('turn/end', { turn, reason: { kind: 'completed' } });
  } });
  await writeFile(path.join(f.node.directory, 'envelope.txt'), '525 !north:memory.test');
  for (const mode of [false, true]) {
    fenced = mode;
    const result = await f.bridge.turn(f.request(`envelope-${mode}`));
    assert.equal(result.status, 'completed'); assert.equal(result.artifacts.length, 1);
    assert.equal(parseBotOutput(result.text, f.node.id, []).text, 'File is ready.\n\nReady');
    assert.equal(await readFile(result.artifacts[0].path, 'utf8'), '525 !north:memory.test');
  }
});

test('an answer table before an empty delivery envelope remains visible to the recipient', async t => {
  const table = '| Item | Value |\n|---|---|\n| Remaining | 177 |';
  const f = await fixture(t, { send: async ({ event, turn }) => {
    await event('assistant/message', { turn, message: { content: [{ type: 'text', text: `${table}\n\n{"text":"Figures verified — English table above.","artifacts":[]}` }] } });
    await event('turn/end', { turn, reason: { kind: 'completed' } });
  } });
  const result = await f.bridge.turn(f.request('table-with-receipt'));
  assert.equal(parseBotOutput(result.text, f.node.id, []).text, `${table}\n\nFigures verified — English table above.`);
  assert.deepEqual(result.artifacts, []);
});

test('ordinary structured native answers are kept verbatim through the native and chat output parsers', async t => {
  let answer;
  const f = await fixture(t, { send: async ({ event, turn }) => {
    await event('assistant/message', { turn, message: { content: [{ type: 'text', text: answer }] } });
    await event('turn/end', { turn, reason: { kind: 'completed' } });
  } });
  const answers = [JSON.stringify({ value: '苍鹭-7321', roomId: '!north:memory.test', speakerId: '@lin:a.test' }), '[1,2,3]', '437', 'true', 'null', '"quoted data"'];
  for (const [index, value] of answers.entries()) {
    answer = value;
    const result = await f.bridge.turn(f.request(`ordinary-data-${index}`));
    assert.equal(result.status, 'completed'); assert.equal(result.text, answer); assert.deepEqual(result.artifacts, []);
    assert.deepEqual(parseBotOutput(result.text, f.node.id, []), { text: answer });
  }
});

const hashBytes = bytes => import('node:crypto').then(({createHash})=>createHash('sha256').update(bytes).digest('hex'));

// Regressions from continuation rounds 81 and 88: actual shell work was done,
// but plain final answers omitted existing code and shell-generated JSON.
test('verified shell receipts supplement a partial delivery with the exact requested existing code', async t => {
  const cwd=await mkdtemp(path.join(os.tmpdir(),'native-resend-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  await mkdir(path.join(cwd,'code'));
  const module=path.join(cwd,'code','count.mjs'),tests=path.join(cwd,'code','count.test.mjs'),log=path.join(cwd,'tests.txt');
  await writeFile(module,'export const count = a => a.length;');await writeFile(tests,'test code');await writeFile(log,'2/2 pass');
  const f=await fixture(t,{cwd,send:async({event,turn})=>{
    await event('tool/call',{turn,callId:'verified-code',name:'bash',arguments:{command:'node --test'}});
    await event('tool/result',{turn,message:{toolCallId:'verified-code',content:[{type:'text',text:
      `${await hashBytes(await readFile(module))}  ${module}\n${await hashBytes(await readFile(tests))}  code/count.test.mjs\n`}] }});
    await event('tool/call',{turn,callId:'log-write',name:'write',arguments:{file_path:log}});
    await event('tool/result',{turn,message:{toolCallId:'log-write'}});
    await event('assistant/message',{turn,message:{content:[{type:'text',text:'Attached: count.mjs, count.test.mjs and tests.txt. The test run used these bytes.'}]}});
    await event('turn/end',{turn,reason:{kind:'completed'}});
  }});
  const request=f.request('resend');request.event.body='Give me count.mjs and count.test.mjs again, with tests.txt.';
  const result=await f.bridge.turn(request);
  assert.equal(result.status,'completed');
  assert.deepEqual(result.artifacts.map(x=>x.name),['tests.txt','count.mjs','count.test.mjs']);
  assert.equal(result.artifactDelivery,'verified-tool-output');
  assert.equal(result.verifiedArtifactReceipts.length,2);
  assert.equal(result.artifacts[1].sha256,await hashBytes(await readFile(module)));
  assert.deepEqual((await f.bridge.turn(request)).artifacts,result.artifacts);assert.equal(f.calls.length,1);
});

test('a shell-generated requested JSON reaches delivery without a write-tool receipt', async t => {
  const cwd=await mkdtemp(path.join(os.tmpdir(),'native-shell-json-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const bytes='{"count":17}\n',sha=await hashBytes(bytes);
  const f=await fixture(t,{cwd,send:async({event,turn})=>{
    await writeFile(path.join(cwd,'acceptance.json'),bytes);
    await event('tool/call',{turn,callId:'shell-json',name:'bash',arguments:{command:'node make-json.mjs'}});
    await event('tool/result',{turn,message:{toolCallId:'shell-json',content:[{type:'text',text:`${sha}  acceptance.json\n`}]}});
    await event('assistant/message',{turn,message:{content:[{type:'text',text:'acceptance.json 已写好。'}]}});
    await event('turn/end',{turn,reason:{kind:'completed'}});
  }});
  const request=f.request('shell-json');request.event.body='发 acceptance.json 给我。';
  const result=await f.bridge.turn(request);
  assert.equal(result.artifactDelivery,'verified-tool-output');assert.equal(result.artifacts.length,1);
  assert.equal(await readFile(result.artifacts[0].path,'utf8'),bytes);
});

test('shell receipts cannot deliver changed bytes, failed commands, other turns or unrequested references', async t => {
  const cwd=await mkdtemp(path.join(os.tmpdir(),'native-shell-filter-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const sha=await hashBytes('before');
  const f=await fixture(t,{cwd,send:async({event,turn})=>{
    for(const name of ['changed.txt','failed.txt','other-turn.txt','reference.txt','code.mjs']) {
      await writeFile(path.join(cwd,name),name==='changed.txt'?'after':'before');
      const toolTurn=name==='other-turn.txt'?999:turn;
      await event('tool/call',{turn:toolTurn,callId:name,name:'bash'});
      await event('tool/result',{turn:toolTurn,message:{toolCallId:name,isError:name==='failed.txt',content:[{type:'text',text:`${sha}  ${name}\n`}]}});
    }
    await event('assistant/message',{turn,message:{content:[{type:'text',text:'changed.txt failed.txt other-turn.txt reference.txt code.mjs'}]}});
    await event('turn/end',{turn,reason:{kind:'completed'}});
  }});
  const request=f.request('shell-filter');request.event.body='Send changed.txt failed.txt other-turn.txt, old-code.mjs and code.mjs.map.';
  const result=await f.bridge.turn(request);assert.equal(result.status,'completed');assert.deepEqual(result.artifacts,[]);
});

test('an explicit empty delivery overrides matching verified shell receipts', async t => {
  const cwd=await mkdtemp(path.join(os.tmpdir(),'native-shell-empty-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const sha=await hashBytes('draft');await writeFile(path.join(cwd,'draft.txt'),'draft');
  const f=await fixture(t,{cwd,send:async({event,turn})=>{
    await event('tool/call',{turn,callId:'draft',name:'bash'});
    await event('tool/result',{turn,message:{toolCallId:'draft',content:[{type:'text',text:`${sha}  draft.txt\n`}]}});
    await event('assistant/message',{turn,message:{content:[{type:'text',text:JSON.stringify({text:'draft.txt is unfinished.',artifacts:[]})}]}});
    await event('turn/end',{turn,reason:{kind:'completed'}});
  }});
  const request=f.request('shell-empty');request.event.body='Send draft.txt.';
  assert.deepEqual((await f.bridge.turn(request)).artifacts,[]);
});

test('identical shell-verified copies deliver once and different versions of the same name stay ambiguous', async t => {
  const cwd=await mkdtemp(path.join(os.tmpdir(),'native-shell-copies-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  for(const folder of ['a','b'])await mkdir(path.join(cwd,folder));
  let distinct=false;
  const f=await fixture(t,{cwd,send:async({event,turn})=>{
    const lines=[];
    for(const folder of ['a','b']) {
      const bytes=distinct?folder:'same',filename=path.join(cwd,folder,'code.mjs');await writeFile(filename,bytes);
      lines.push(`${await hashBytes(bytes)}  ${filename}`);
    }
    await event('tool/call',{turn,callId:'copies',name:'bash'});
    await event('tool/result',{turn,message:{toolCallId:'copies',content:[{type:'text',text:lines.join('\n')}]}});
    await event('assistant/message',{turn,message:{content:[{type:'text',text:'code.mjs is ready.'}]}});
    await event('turn/end',{turn,reason:{kind:'completed'}});
  }});
  const one=f.request('same-copies');one.event.body='Send code.mjs.';assert.equal((await f.bridge.turn(one)).artifacts.length,1);
  distinct=true;const two=f.request('different-copies');two.event.body=one.event.body;assert.deepEqual((await f.bridge.turn(two)).artifacts,[]);
});
