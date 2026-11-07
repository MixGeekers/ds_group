import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { readOptionalJson, savePrivateJson } from '../scripts/server-init.mjs';
import { prepareWorkFiles, collectArtifacts, collectStagedArtifacts, MAX_ARTIFACTS } from '../dsh-plugin/work-files.mjs';
import { nativeMessage, observedMemoryInput } from '../src/message-context.mjs';
import { HANDOFF_ACK } from '../vendor/ds-bot/src/host/constants.js';
import { isModelQuotaFailure } from '../src/model-failure.mjs';

const textOf = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
const terminal = record => ['completed', 'failed', 'cancelled', 'unknown'].includes(record?.status);
const digest = value => createHash('sha256').update(value).digest('hex');
const error = code => Object.assign(new Error(code), { code });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const interruption = signal => signal?.reason?.code === 'TASK_CANCELLED' ? error('TASK_CANCELLED') : error('CONNECTION_DETACHED');
async function interruptible(operation, signal) {
  if (signal?.aborted) throw interruption(signal);
  let abort;
  try {
    return await Promise.race([Promise.resolve().then(() => { if (signal?.aborted) throw interruption(signal); return operation(); }),
      new Promise((_, reject) => { abort = () => reject(interruption(signal)); signal?.addEventListener('abort', abort, { once: true }); })]);
  } finally { signal?.removeEventListener('abort', abort); }
}


// Native answers may introduce their explicit delivery JSON with a sentence or
// a Markdown fence. Only a complete trailing text/artifacts envelope opts in.
function nativeArtifactOutput(text) {
  const candidate = text.trim().replace(/```\s*$/, '').trim();
  for (let start = candidate.lastIndexOf('{'); start >= 0; start = candidate.lastIndexOf('{', start - 1)) {
    try {
      const output = JSON.parse(candidate.slice(start));
      if (typeof output?.text === 'string' && Array.isArray(output.artifacts)) {
        // The prose can contain the answer (a table, instructions, findings),
        // followed by a delivery receipt saying only "see above". Keep both.
        const prefix = candidate.slice(0, start).replace(/```(?:json)?\s*$/i, '').trim();
        if (prefix && prefix !== output.text.trim()) output.text = [prefix, output.text.trim()].filter(Boolean).join('\n\n');
        return { text: JSON.stringify(output), explicitArtifacts: true };
      }
    } catch { /* This brace is nested or belongs to ordinary prose. */ }
    if (start === 0) break;
  }
  return { text, explicitArtifacts: false };
}

function nativeLinkedArtifacts(text, cwd) {
  const prose=text.replace(/```[\s\S]*?```/g,'').replace(/`[^`\n]*`/g,'');
  const files=[];
  for(const match of prose.matchAll(/\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g)) {
    let target=match[1].replace(/^<|>$/g,'').trim();
    if(/^file:/i.test(target)) { try { target=fileURLToPath(target); } catch { continue; } }
    else if(/^[a-z][a-z\d+.-]*:/i.test(target)||target.startsWith('#')||target.startsWith('//'))continue;
    if(!path.extname(target)||!path.isAbsolute(target)&&!cwd)continue;
    files.push({path:path.isAbsolute(target)?target:path.resolve(cwd,target)});
  }
  return [...new Map(files.map(file=>[file.path,file])).values()];
}

// A shell can create or verify a deliverable without using the file tools.
// Accept only ordinary SHA-256 receipts, then verify the bytes independently.
// No shell parsing, workspace crawl, or stale delivery history is involved.
function nativeHashedArtifacts(text, cwd) {
  const files=[];
  for(const match of text.matchAll(/^\s*([a-f\d]{64})[ \t]+\*?([^\r\n]+)$/gmi)) {
    const filename=match[2].trim();
    if(!path.extname(filename)||filename.includes('\0')||/^[a-z][a-z\d+.-]*:\/\//i.test(filename))continue;
    if(!path.isAbsolute(filename)&&!cwd)continue;
    files.push({path:path.resolve(cwd||'',filename),sha256:match[1].toLowerCase()});
  }
  return files;
}

function namesFile(text,name) {
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_.-])${escaped}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}_-])`,'u')
    .test(text.replace(/```[\s\S]*?```/g,''));
}

/** The Matrix binding and its native kernel Bot share one durable identity. */
export class NativeBridge {
  constructor({ ctx, native, node, timeoutMs = 0 }) {
    Object.assign(this, { ctx, native, node, timeoutMs });
    this.filename = path.join(node.directory, 'native-bridge.json');
    this.pending = new Map();
    this.jobs = new Map();
    this.writes = Promise.resolve();
    this.closed = false;
  }

  async initialize() {
    await mkdir(this.node.directory, { recursive: true, mode: 0o700 });
    this.state = await readOptionalJson(this.filename) || { version: 1, nativeBotId: this.node.nativeBotId, requests: {} };
    if (this.state.nativeBotId !== this.node.nativeBotId) throw error('NATIVE_BINDING_CONFLICT');
    for (const record of Object.values(this.state.requests)) if (!terminal(record)) {
      record.status = 'unknown'; record.errorCode = 'HOST_RESTARTED';
    }
    await this.save();
    this.durable = new Set(Object.values(this.state.requests).filter(terminal).map(record => record.requestId));
    this.disposeEvents = this.ctx.on('session/event', (session, event) => this.event(session, event));
    this.disposeUsage = this.ctx.on('llm/stream', (options, next) => this.observeUsage(options, next));
    return this;
  }

  save() {
    this.writes = this.writes.catch(() => {}).then(() => savePrivateJson(this.filename, this.state));
    return this.writes;
  }

  async *observeUsage(options, next) {
    const run = this.run;
    if (!run?.seen || run.currentTurn !== run.turn || options.sessionId !== run.record.sessionId) { yield* next(); return; }
    const call = { model: `${options.provider}/${options.model}`, kind: options.purpose || 'generation', status: 'running', usage: null };
    run.record.calls.push(call);
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') call.usage = chunk.usage;
        if (chunk.type === 'error' || chunk.type === 'finish' && chunk.reason?.kind === 'error') call.error = true;
        yield chunk;
      }
      call.status = call.error ? 'failed' : 'completed';
    } catch (cause) { call.status = 'failed'; throw cause; }
    finally {
      if (call.status === 'running') call.status = 'unknown';
      await this.save().catch(() => {});
    }
  }

  async createBot(input) {
    if (input.botId !== this.node.id) throw error('NATIVE_BINDING_CONFLICT');
    const bot = await this.native.bot(this.node.nativeBotId);
    const agent = await this.native.agent(bot.sessionId);
    // "createBot" is the legacy transport method name. This only binds a Bot.
    return { botId: this.node.id, dsBotId: bot.id, sessionId: bot.sessionId, model: bot.model,
      tools: agent.ctx.tools.schemas(agent).map(tool => tool.name), mode: 'native' };
  }

  async runtimeStatus() {
    const bot = await this.native.bot(this.node.nativeBotId);
    return { model: bot.model, modelConfig: { model: bot.model }, mode: 'native',
      runtime: this.native.runtimeInfo || null };
  }

  async observe({ events = [], participants = [], rooms = {}, eventRooms = {}, cursor, watermark, streamId } = {}) {
    const inputs = events.map(event => observedMemoryInput(event, participants, eventRooms[event.event_id] || rooms[event.room_id] || {}));
    if (!inputs.length) return null;
    return this.native.call('observe', { botId: this.node.nativeBotId, inputs,
      options: { streamId: streamId || `matrix:${this.node.id}`,
        ...(watermark?.sequence !== undefined ? { cursor: String(watermark.sequence) } : {}),
        ...(cursor ? { transportCursor: cursor } : {}) } });
  }

  async kernelState() {
    const state = await this.native.state();
    const bot = state.bots?.find(bot => bot.id === this.node.nativeBotId);
    if (!bot) throw error('NATIVE_BINDING_CONFLICT');
    const activity = state.work?.bots?.[bot.id];
    const waiting = state.work?.waiting?.[bot.id] || state.work?.waiting?.[bot.sessionId] || null;
    const requests = Object.values(this.state?.requests || {}).filter(record => !terminal(record));
    return {
      runtime: { ...state.runtime, available: Boolean(state.runtime) },
      self: { nativeBotId: bot.id, matrixId: this.node.id, name: bot.name, role: bot.role || '',
        instructions: bot.instructions || '', ownerId: this.node.ownerId || null },
      work: { status: activity ? 'working' : waiting ? 'waiting' : 'idle',
        activeTasks: Math.max(requests.length, activity ? 1 : 0),
        tasks: requests.map(record => ({ requestId: record.requestId, status: record.status,
          stage: record.stage || null, summary: record.summary || '', roomId: record.source?.roomId || null })),
        activity: activity || null, waiting: waiting ? Array.isArray(waiting) ? waiting.length : 1 : 0,
        waitDetails: waiting },
      memorySummary: { people: null, projects: null, pendingReview: null },
    };
  }

  async readAttentionView({ roomId, threadRootId, watermark, eventIds = [], recentMessages = [],
    query, subjectIds, budgetChars = 6500 } = {}) {
    const kernel = await this.kernelState();
    const last = recentMessages.at(-1);
    const authorId = last?.senderId || last?.sender || last?.source?.sender?.id;
    const memory = await this.native.call('attention-view', { botId: this.node.nativeBotId,
      options: { roomId, eventIds, watermark, subjectIds, budgetChars,
        context: { roomId, ...(authorId ? { authorId } : {}) },
        query: query ?? recentMessages.map(message => message.body ?? message.content?.body ?? '').join('\n').slice(-2400),
        self: kernel.self } });
    return { self: kernel.self, memory, tasks: kernel.work,
      runtime: { ...kernel.runtime, status: kernel.work.status,
        interruptible: kernel.work.status === 'idle', observedAt: Date.now() },
      roomId, threadRootId, watermark };
  }

  memoryProfiles(options = {}) {
    return this.native.call('memory-profiles', { ...options, botId: this.node.nativeBotId });
  }

  memoryProfile(options = {}) {
    return this.native.call('memory-profile', { ...options, botId: this.node.nativeBotId });
  }

  async event(session, event) {
    const run = this.run;
    if (!run) return;
    const message = event.data?.message || event.data;
    const source = message?.source;
    // Native Bot-to-Bot replies carry the exchange they answer. Record it where
    // it is delivered, so unrelated local chats cannot become DSCord answers.
    if (event.type === 'user/message' && source?.kind === 'bot' && source.role === 'request'
      && source.senderSessionId === this.node.nativeBotId && source.audience !== 'user'
      && run.seen && run.currentTurn === run.turn && source.exchangeId) {
      run.exchanges.add(source.exchangeId);
    }
    if (session.id !== run.record.sessionId) {
      const bot = await this.native.bot(this.node.nativeBotId);
      if (session.id !== bot.sessionId) return;
      run.partContinuation = run.seen && run.currentTurn === run.turn;
      run.record.sessionId = session.id;
    }
    if (event.type === 'turn/start') run.currentTurn = event.data.turn;
    if (event.type === 'user/message') {
      if (textOf(message).startsWith(`${run.marker}\n`)
        || source?.kind === 'bot' && run.exchanges.has(source.replyTo)
        || run.partContinuation && source?.handoff === true && source.resume === true) {
        run.seen = true;
        run.turn = run.currentTurn;
        run.partContinuation = false;
        if (source?.replyTo) run.exchanges.delete(source.replyTo);
      }
    }
    if (!run.seen) return;
    if (event.data?.turn !== undefined && event.data.turn !== run.turn) return;
    if (event.type === 'assistant/message') {
      run.cwd = this.ctx.get?.('workingDirectory')?.get?.(session) || session.header?.cwd || run.cwd;
      const text = textOf(event.data?.message);
      if (text.trim() === HANDOFF_ACK || /^\[(?:PASS|HANDOFF[^\]]*)\]$/.test(text.trim())) run.text = '';
      else if (text) run.text = text;
    }
    if (event.type === 'tool/call') {
      run.record.toolReceipts.push({ callId: event.data.callId, name: event.data.name, status: 'running' });
      if(event.data.name==='bash')run.shellCalls.set(event.data.callId,
        event.data.meta?.cwd||this.ctx.get?.('workingDirectory')?.get?.(session)||session.header?.cwd);
      if (['write','write_file','edit','edit_file'].includes(event.data.name)) {
        try {
          const args=typeof event.data.arguments==='string'?JSON.parse(event.data.arguments):event.data.arguments;
          const filename=args?.file_path||args?.path||args?.filename;
          const cwd=event.data.meta?.cwd||this.ctx.get?.('workingDirectory')?.get?.(session)||session.header?.cwd;
          if(typeof filename==='string'&&(path.isAbsolute(filename)||typeof cwd==='string'))run.writeCalls.set(event.data.callId,{path:path.resolve(cwd||'',filename)});
        } catch { /* Only an actual successful file-tool result can publish it. */ }
      }
      if (event.data.name === 'present') {
        try {
          const args = typeof event.data.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data.arguments;
          const cwd = event.data.meta?.cwd || this.ctx.get?.('workingDirectory')?.get?.(session) || session.header?.cwd;
          const files = (args?.files || []).filter(file => typeof file.path === 'string')
            .filter(file => path.isAbsolute(file.path) || typeof cwd === 'string')
            .map(file => ({ path: path.isAbsolute(file.path) ? file.path : path.resolve(cwd, file.path) }));
          run.presentCalls.set(event.data.callId, files);
        } catch { /* Invalid arguments cannot produce a successful file receipt. */ }
      }
      run.record.toolCalls = run.record.toolReceipts.length;
      run.record.summary = `正在使用 ${event.data.name}`;
    }
    if (event.type === 'tool/result') {
      const message = event.data?.message;
      const receipt = run.record.toolReceipts.find(tool => tool.callId === message?.toolCallId);
      if (receipt) receipt.status = message.isError ? 'failed' : 'completed';
      if (!message.isError && run.writeCalls.has(message.toolCallId)) {
        const descriptor=run.writeCalls.get(message.toolCallId);run.written.set(descriptor.path,descriptor);
      }
      if(!message.isError&&run.shellCalls.has(message.toolCallId)) {
        for(const descriptor of nativeHashedArtifacts(textOf(message),run.shellCalls.get(message.toolCallId)))
          run.hashed.set(descriptor.path,{...descriptor,callId:message.toolCallId});
      }
      if (receipt?.name === 'present' && !message.isError) {
        for (const file of run.presentCalls.get(message.toolCallId) || []) run.presented.set(file.path, file);
      }
    }
    if (event.type === 'turn/end') {
      run.reason = event.data?.reason?.kind;
      run.failure = event.data?.reason?.error;
      // An acknowledgement is not completion while a teammate still owes a
      // reply to this Bot. Native direct-to-user work has a different destination.
      if (run.reason === 'completed' && run.text && run.exchanges.size === 0 || run.reason === 'error' || run.reason === 'cancelled') run.resolve();
    }
  }

  async status(requestId) {
    const record = this.state.requests[requestId];
    if (!record) throw Object.assign(error('REQUEST_NOT_FOUND'), { status: 404 });
    if (terminal(record) && !this.durable.has(requestId)) return { ...structuredClone(record),
      status: 'running', stage: 'saving', text: undefined, artifacts: [] };
    return structuredClone(record);
  }

  async wait(requestId, initial, { signal, onProgress, control } = {}) {
    let record = initial || await this.status(requestId);
    while (!terminal(record)) {
      if (signal?.aborted) return { ...record, status: 'unknown', errorCode: 'CONNECTION_DETACHED' };
      if ((await control?.(requestId))?.cancelRequested) await this.cancel(requestId);
      await onProgress?.(record);
      await sleep(500);
      record = await this.status(requestId);
    }
    return record;
  }

  async turn(input, options = {}) {
    if (this.closed) throw error('CONNECTION_CLOSED');
    if (input.botId !== this.node.id) throw error('NATIVE_BINDING_CONFLICT');
    const hash = digest(JSON.stringify(input));
    const old = this.state.requests[input.requestId];
    if (old && old.inputHash !== hash) throw error('REQUEST_ID_CONFLICT');
    if (old) return this.pending.get(input.requestId) || this.status(input.requestId);
    const record = { requestId: input.requestId, botId: input.botId, inputHash: hash, status: 'queued',
      stage: 'queued', summary: '等待原生 Bot', artifacts: [], calls: [], toolReceipts: [], mode: 'native' };
    this.state.requests[input.requestId] = record;
    const pending = this.queue(record, input, options);
    this.pending.set(input.requestId, pending);
    try { return await pending; }
    finally { this.pending.delete(input.requestId); }
  }

  async queue(record, input, options) {
    await this.save();
    const controller = new AbortController(), job = { controller, record, started: false, skipped: false };
    this.jobs.set(record.requestId, job);
    let stopQueued;
    const interrupted = new Promise(resolve => {
      stopQueued = () => {
        if (job.started) return;
        job.skipped = true;
        const cause = interruption(controller.signal);
        Object.assign(record, { status: cause.code === 'TASK_CANCELLED' ? 'cancelled' : 'unknown', errorCode: cause.code,
          stage: cause.code === 'TASK_CANCELLED' ? 'cancelled' : 'unknown', finishedAt: new Date().toISOString() });
        resolve(this.save().then(() => { this.durable.add(record.requestId); return structuredClone(record); }));
      };
      controller.signal.addEventListener('abort', stopQueued, { once: true });
    });
    const abort = () => controller.abort(error('CONNECTION_DETACHED'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (record.cancelRequested) controller.abort(error('TASK_CANCELLED'));
    else if (this.closed || options.signal?.aborted) abort();
    const queued = this.native.enqueue(this.node.nativeBotId, () => {
      if (job.skipped) return interrupted;
      job.started = true;
      return this.execute(record, input, { ...options, signal: controller.signal });
    });
    try { return await Promise.race([queued, interrupted]); }
    finally {
      options.signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', stopQueued);
      this.jobs.delete(record.requestId);
    }
  }

  async execute(record, input, { signal, onProgress, control } = {}) {
    let timer, progressTimer, abort;
    const check = () => { if (record.cancelRequested) throw error('TASK_CANCELLED'); if (this.closed || signal?.aborted) throw interruption(signal); };
    try {
      check();
      let reporting = false;
      const report = async () => {
        if (reporting) return; reporting = true;
        try {
          await onProgress?.(await this.status(record.requestId));
          if ((await control?.(record.requestId))?.cancelRequested) await this.cancel(record.requestId);
        } catch { /* A temporary status failure does not stop the native Bot. */ }
        finally { reporting = false; }
      };
      progressTimer = setInterval(report, 500);
      await report(); check();
      const bot = await interruptible(() => this.native.bot(this.node.nativeBotId), signal);
      const agent = await interruptible(() => this.native.agent(bot.sessionId), signal);
      await interruptible(() => Promise.race([agent.whenIdle(), new Promise((_, reject) => { this.waiting = { record, reject }; })]), signal);
      this.waiting = null;
      check();
      const files = await prepareWorkFiles({ dataDir: this.node.directory, requestId: input.requestId, workdir: input.workdir, files: input.files });
      check();
      let resolve;
      const done = new Promise(done => { resolve = done; });
      const marker = `DSCORD_REQUEST=${input.requestId}`;
      const run = this.run = { marker, resolve, record, text: '', exchanges: new Set(), presentCalls: new Map(), presented: new Map(), writeCalls: new Map(), written: new Map(), shellCalls: new Map(), hashed: new Map() };
      Object.assign(record, { status: 'running', stage: 'working', sessionId: bot.sessionId, model: bot.model,
        contextKey: input.context?.key, source: input.context?.source,
        summary: '原生 Bot 正在处理', startedAt: new Date().toISOString() });
      await this.save();
      check();
      if (this.timeoutMs > 0) timer = setTimeout(() => { run.error = 'NATIVE_TASK_TIMEOUT'; resolve(); }, this.timeoutMs);
      abort = () => { run.error = interruption(signal).code; resolve(); };
      signal?.addEventListener('abort', abort, { once: true });
      await interruptible(() => this.native.call('observe', { botId: bot.id, inputs: [input] }), signal);
      const memoryView = await interruptible(() => this.native.call('attention-view', { botId: bot.id,
        options: { sessionId: bot.sessionId, roomId: input.event.roomId,
          context: { roomId: input.event.roomId, authorId: input.event.senderId },
          eventIds: [input.event.eventId], query: input.event.body, budgetChars: 8000 } }), signal);
      check();
      const text = nativeMessage({ input: { ...input, memoryView }, bot, files });
      await this.native.call('send', { sessionId: bot.id, requestId: input.requestId, text,
        source: input.context?.source || { sender: { id: input.event.senderId,
          name: input.event.senderName || input.event.senderId, kind: input.event.senderKind || 'human' },
          roomId: input.event.roomId, eventId: input.event.eventId }, memoryContext: input });
      run.sent = true;
      if (record.cancelRequested) run.cancelling ??= this.cancelNative(run);
      await run.cancelling;
      check();
      await done;
      await run.cancelling;
      if (run.error) throw error(run.error);
      if (run.reason !== 'completed') {
        if (run.failure) record.nativeFailure = { code: run.failure.code, message: String(run.failure.message||'').slice(0,4096) };
        throw error(isModelQuotaFailure(run.failure) ? 'MODEL_QUOTA_EXCEEDED' : 'NATIVE_TURN_FAILED');
      }
      const delivery = nativeArtifactOutput(run.text), deliveryOutput = delivery.text;
      record.text = deliveryOutput;
      const artifacts = await collectArtifacts(deliveryOutput, files.workdir, { allowExternalPaths: true });
      const paths = new Set(artifacts.map(file => file.path));
      // Native present is the Bot's ordinary file delivery tool. Successful
      // receipts are deliveries even when the final answer is plain Markdown.
      for (const descriptor of run.presented.values()) {
        const [file] = await collectArtifacts(JSON.stringify({ text: 'Native file delivery', artifacts: [descriptor] }), files.workdir, { allowExternalPaths: true });
        if (paths.has(file.path)) continue;
        if (artifacts.length >= MAX_ARTIFACTS) throw error('TOO_MANY_ARTIFACTS');
        paths.add(file.path); artifacts.push(file);
      }
      if (!delivery.explicitArtifacts) for (const descriptor of nativeLinkedArtifacts(run.text,run.cwd||files.workdir)) {
        const [file]=await collectArtifacts(JSON.stringify({text:'Linked native file',artifacts:[descriptor]}),files.workdir,{allowExternalPaths:true});
        if(paths.has(file.path))continue;
        if(artifacts.length>=MAX_ARTIFACTS)throw error('TOO_MANY_ARTIFACTS');
        paths.add(file.path);artifacts.push(file);record.artifactDelivery='native-file-link';
      }
      if (!artifacts.length && !delivery.explicitArtifacts) {
        const staged = await collectStagedArtifacts(files.workdir);
        if (staged.length) { artifacts.push(...staged); record.artifactDelivery = 'staged-output'; }
      }
      if (!artifacts.length && !delivery.explicitArtifacts) {
        const mentioned=[...run.written.values()].filter(file=>run.text.includes(path.basename(file.path)));
        if(mentioned.length){artifacts.push(...await collectArtifacts(JSON.stringify({text:'Mentioned file-tool outputs',artifacts:mentioned}),files.workdir,{allowExternalPaths:true}));record.artifactDelivery='mentioned-tool-output';}
      }
      if(!delivery.explicitArtifacts) {
        const candidates=new Map();
        for(const descriptor of run.hashed.values()) {
          const name=path.basename(descriptor.path);
          if(!namesFile(input.event.body||'',name)||!namesFile(run.text,name)||artifacts.some(file=>file.name===name))continue;
          let file;
          try { [file]=await collectArtifacts(JSON.stringify({text:'Verified shell output',artifacts:[{path:descriptor.path}]}),files.workdir,{allowExternalPaths:true}); }
          catch(cause) { if(['WORK_FILE_NOT_FOUND','WORK_FILE_NOT_REGULAR'].includes(cause.code))continue;throw cause; }
          if(file.sha256!==descriptor.sha256)continue;
          const group=candidates.get(name)||[];group.push({file,callId:descriptor.callId});candidates.set(name,group);
        }
        for(const group of candidates.values()) {
          // Two different byte versions with the same requested name are
          // ambiguous. Identical copies need only one actual attachment.
          if(new Set(group.map(({file})=>file.sha256)).size!==1)continue;
          const {file,callId}=group.at(-1);
          if(artifacts.some(existing=>existing.path===file.path))continue;
          if(artifacts.length>=MAX_ARTIFACTS)throw error('TOO_MANY_ARTIFACTS');
          artifacts.push(file);record.artifactDelivery='verified-tool-output';
          (record.verifiedArtifactReceipts||=[]).push({name:file.name,sha256:file.sha256,callId});
        }
      }
      record.artifacts = artifacts;
      record.status = 'completed'; record.stage = 'completed'; record.summary = '处理完成';
      record.usage = { accounting: 'native-ds-bot', complete: false, observedCalls: record.calls.length };
    } catch (cause) {
      record.status = cause.code === 'TASK_CANCELLED' ? 'cancelled' : ['CONNECTION_DETACHED','NATIVE_TASK_TIMEOUT'].includes(cause.code) ? 'unknown' : 'failed';
      record.stage = record.status; record.errorCode = cause.code || 'NATIVE_OPERATION_FAILED';
    } finally {
      clearTimeout(timer); clearInterval(progressTimer);
      signal?.removeEventListener('abort', abort);
      this.run = null;
      this.waiting = null;
      record.finishedAt = new Date().toISOString();
      await this.save();
      this.durable.add(record.requestId);
    }
    return structuredClone(record);
  }

  async cancel(requestId) {
    const record = this.state.requests[requestId];
    if (!record || terminal(record)) return record;
    record.cancelRequested = true;
    if (this.waiting?.record === record) this.waiting.reject(error('TASK_CANCELLED'));
    const run = this.run?.record === record ? this.run : null;
    if (run?.record === record) {
      run.error = 'TASK_CANCELLED';
      if (run.sent) run.cancelling ??= this.cancelNative(run);
      run.resolve();
    }
    this.jobs.get(requestId)?.controller.abort(error('TASK_CANCELLED'));
    await run?.cancelling;
    await this.save();
    return record;
  }

  async cancelNative(run) {
    const agent = await this.native.agent(run.record.sessionId);
    if (this.run !== run || terminal(run.record) || run.reason === 'completed' && run.exchanges.size === 0) return;
    // Remove only this request if admission queued it behind different work.
    for (const message of [...(agent.inbox?.nextTurn || []), ...(agent.inbox?.nextStep || [])]) {
      if (message.source?.rpcId === run.record.requestId || message.source?.requestId === run.record.requestId || textOf(message).startsWith(`${run.marker}\n`)) {
        agent.inbox.remove?.(message.id);
        await this.ctx.sessions?.flush(agent.session);
        return;
      }
    }
    if (run.seen && run.currentTurn === run.turn) agent.cancel({ kind: 'user' });
  }

  async detach() {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(error('CONNECTION_DETACHED'));
    this.waiting?.reject(error('CONNECTION_DETACHED'));
    // Disconnect never cancels or stops the underlying native Bot.
    if (this.run) { this.run.error = 'CONNECTION_DETACHED'; this.run.resolve(); }
    this.disposeEvents?.(); this.disposeUsage?.();
    await Promise.allSettled([...this.pending.values()]);
    await this.writes;
  }
}
