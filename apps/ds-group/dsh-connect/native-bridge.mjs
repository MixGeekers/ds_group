import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readOptionalJson, savePrivateJson } from '../scripts/server-init.mjs';
import { prepareWorkFiles, collectArtifacts, collectStagedArtifacts, MAX_ARTIFACTS } from '../dsh-plugin/work-files.mjs';
import { nativeMessage } from '../src/message-context.mjs';
import { HANDOFF_ACK } from '../vendor/ds-bot/src/host/constants.js';

const textOf = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
const terminal = record => ['completed', 'failed', 'cancelled', 'unknown'].includes(record?.status);
const digest = value => createHash('sha256').update(value).digest('hex');
const error = code => Object.assign(new Error(code), { code });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));


// Native answers may introduce their explicit delivery JSON with a sentence or
// a Markdown fence. Only a complete trailing text/artifacts envelope opts in.
function nativeArtifactOutput(text) {
  const candidate = text.trim().replace(/```\s*$/, '').trim();
  for (let start = candidate.lastIndexOf('{'); start >= 0; start = candidate.lastIndexOf('{', start - 1)) {
    try {
      const output = JSON.parse(candidate.slice(start));
      if (typeof output?.text === 'string' && Array.isArray(output.artifacts)) return { text: JSON.stringify(output), explicitArtifacts: true };
    } catch { /* This brace is nested or belongs to ordinary prose. */ }
    if (start === 0) break;
  }
  return { text, explicitArtifacts: false };
}

/** DSCord is another input/output for the original Bot. Its native Session,
 * model, tools, permissions, working folder and autonomous work are untouched. */
export class NativeBridge {
  constructor({ ctx, native, node, timeoutMs = 0 }) {
    Object.assign(this, { ctx, native, node, timeoutMs });
    this.filename = path.join(node.directory, 'native-bridge.json');
    this.pending = new Map();
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
    return { model: bot.model, modelConfig: { model: bot.model }, mode: 'native' };
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
      const text = textOf(event.data?.message);
      if (text.trim() === HANDOFF_ACK || /^\[(?:PASS|HANDOFF[^\]]*)\]$/.test(text.trim())) run.text = '';
      else if (text) run.text = text;
    }
    if (event.type === 'tool/call') {
      run.record.toolReceipts.push({ callId: event.data.callId, name: event.data.name, status: 'running' });
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
      if (receipt?.name === 'present' && !message.isError) {
        for (const file of run.presentCalls.get(message.toolCallId) || []) run.presented.set(file.path, file);
      }
    }
    if (event.type === 'turn/end') {
      run.reason = event.data?.reason?.kind;
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
    await this.save();
    const pending = this.native.enqueue(this.node.nativeBotId, () => this.execute(record, input, options));
    this.pending.set(input.requestId, pending);
    try { return await pending; }
    finally { this.pending.delete(input.requestId); }
  }

  async execute(record, input, { signal, onProgress, control } = {}) {
    let timer, progressTimer, abort;
    try {
      if (this.closed) throw error('CONNECTION_DETACHED');
      if (record.cancelRequested) throw error('TASK_CANCELLED');
      const bot = await this.native.bot(this.node.nativeBotId);
      const agent = await this.native.agent(bot.sessionId);
      await Promise.race([agent.whenIdle(), new Promise((_, reject) => { this.waiting = { record, reject }; })]);
      this.waiting = null;
      if (this.closed || signal?.aborted) throw error('CONNECTION_DETACHED');
      const files = await prepareWorkFiles({ dataDir: this.node.directory, requestId: input.requestId, workdir: input.workdir, files: input.files });
      let resolve;
      const done = new Promise(done => { resolve = done; });
      const marker = `DSCORD_REQUEST=${input.requestId}`;
      const run = this.run = { marker, resolve, record, text: '', exchanges: new Set(), presentCalls: new Map(), presented: new Map() };
      Object.assign(record, { status: 'running', stage: 'working', sessionId: bot.sessionId, model: bot.model,
        contextKey: input.context?.key, source: input.context?.source,
        summary: '原生 Bot 正在处理', startedAt: new Date().toISOString() });
      await this.save();
      if (this.timeoutMs > 0) timer = setTimeout(() => { run.error = 'NATIVE_TASK_TIMEOUT'; resolve(); }, this.timeoutMs);
      abort = () => { run.error = 'CONNECTION_DETACHED'; resolve(); };
      signal?.addEventListener('abort', abort, { once: true });
      let reporting = false;
      progressTimer = setInterval(async () => {
        if (reporting) return; reporting = true;
        try {
          await onProgress?.(await this.status(record.requestId));
          if ((await control?.(record.requestId))?.cancelRequested) await this.cancel(record.requestId);
        } catch { /* A temporary status failure does not stop the native Bot. */ }
        finally { reporting = false; }
      }, 500);
      const text = nativeMessage({ input, bot, files });
      await this.native.call('send', { sessionId: bot.id, text, memoryContext: input });
      await done;
      if (run.error) throw error(run.error);
      if (run.reason !== 'completed') throw error('NATIVE_TURN_FAILED');
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
      if (!artifacts.length && !delivery.explicitArtifacts) {
        const staged = await collectStagedArtifacts(files.workdir);
        if (staged.length) { artifacts.push(...staged); record.artifactDelivery = 'staged-output'; }
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
    if (this.run?.record === record) {
      const agent = await this.native.agent(record.sessionId);
      agent.cancel({ kind: 'user' });
      this.run.error = 'TASK_CANCELLED'; this.run.resolve();
    }
    await this.save();
    return record;
  }

  async detach() {
    this.closed = true;
    this.waiting?.reject(error('CONNECTION_DETACHED'));
    // Disconnect never cancels or stops the underlying native Bot.
    if (this.run) { this.run.error = 'CONNECTION_DETACHED'; this.run.resolve(); }
    this.disposeEvents?.(); this.disposeUsage?.();
    await this.writes;
  }
}
