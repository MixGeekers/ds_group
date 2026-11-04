import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createRuntime } from '../vendor/ds-bot/index.js';
import { PROTOCOL, botInstructions } from './runtime-rules.mjs';

export const name = 'ds-group-node';
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection'];

const MODEL = 'opencode-go/deepseek-v4.1-flash';
const LOADED_RUNTIME_SHA256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const DEFAULT_OUTPUT_TOKENS = 4096;
const TURN_TIMEOUT_MS = 120_000;

function fail(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 256_000) throw fail('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail('INVALID_JSON'); }
}

function textOf(message) {
  return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('');
}

function required(value, field, maximum = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw fail('INVALID_INPUT', `Invalid ${field}`);
  return value;
}

function publicError(error) {
  return /^[A-Z][A-Z0-9_]{0,100}$/.test(error?.code ?? '') ? error.code : 'NODE_OPERATION_FAILED';
}

export async function apply(ctx, config) {
  const nodeId = required(config.nodeId, 'nodeId');
  const dataDir = required(config.dataDir, 'dataDir', 4096);
  const port = Number(config.port);
  const outputTokens = config.maxTokens ?? DEFAULT_OUTPUT_TOKENS;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('INVALID_PORT');
  if (!Number.isInteger(outputTokens) || outputTokens < 1 || outputTokens > 8192) throw fail('INVALID_OUTPUT_LIMIT');
  await mkdir(dataDir, { recursive: true });
  const statePath = join(dataDir, 'node-state.json');
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { schemaVersion: 1, nodeId, bots: {}, requests: {} };
  }
  if (state.nodeId !== nodeId || state.schemaVersion !== 1) throw fail('NODE_STATE_MISMATCH');
  for (const request of Object.values(state.requests)) {
    if (request.status === 'queued' || request.status === 'running') {
      request.status = 'unknown';
      request.errorCode = 'NODE_RESTARTED_DURING_REQUEST';
      request.finishedAt = new Date().toISOString();
    }
  }
  let writes = Promise.resolve();
  const save = () => {
    writes = writes.catch(() => {}).then(async () => {
      const temporary = `${statePath}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, statePath);
    });
    return writes;
  };
  await save();
  const active = new Map();
  const inFlight = new Map();
  const botQueues = new Map();
  const protectedAgents = new WeakSet();
  const progress = { requests: 0, completed: 0, failed: 0, streamClaims: 0, blockedStreams: 0 };
  let closing = false;

  async function ledger(action, value) {
    const core = JSON.parse(await readFile(config.coreConfigPath, 'utf8'));
    required(core.nodeSecret, 'nodeSecret', 8192);
    const response = await fetch(`${config.coreUrl}/internal/model/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${core.nodeSecret}` },
      body: JSON.stringify(value), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw fail('MODEL_LEDGER_REJECTED');
    return response.json();
  }

  // Every generation path, including upstream auxiliary work, passes this gate.
  ctx.on('llm/stream', (options, next) => (async function* () {
    const run = active.get(options.sessionId);
    if (closing || !run || options.purpose !== undefined || run.streamRequested) {
      progress.blockedStreams++;
      throw fail('UNSCHEDULED_MODEL_REQUEST');
    }
    if (options.provider !== 'opencode-go' || options.model !== 'deepseek-v4.1-flash'
      || options.reasoningEffort !== 'low' || options.maxTokens !== outputTokens
      || (options.tools?.length ?? 0) > 0) throw fail('MODEL_REQUEST_OUTSIDE_SCOPE');
    run.streamRequested = true;
    const claim = await ledger('claim', { nodeId, requestId: run.request.requestId, model: MODEL, maxTokens: outputTokens, kind: 'generation' });
    run.claimId = required(claim.claimId, 'claimId');
    run.streamStarted = true;
    progress.streamClaims++;
    let streamStatus = 'failed';
    let chunks = 0;
    let bytes = 0;
    try {
      for await (const chunk of next()) {
        chunks++;
        if (chunk?.type === 'usage') run.usage = chunk.usage;
        if (chunk?.type === 'text-delta') bytes += Buffer.byteLength(chunk.text ?? '');
        if (chunk?.type === 'error' || chunk?.type === 'finish' && chunk.reason?.kind === 'error') run.streamError = 'MODEL_STREAM_FAILED';
        yield chunk;
      }
      if (!chunks) throw fail('EMPTY_PROVIDER_STREAM');
      streamStatus = run.streamError ? 'failed' : 'completed';
    } catch (error) {
      run.streamError = publicError(error);
      throw error;
    } finally {
      run.textBytes = bytes;
      try {
        await ledger('complete', { claimId: run.claimId, status: streamStatus, usage: run.usage ?? null,
          textBytes: bytes, ...(run.streamError ? { errorCode: run.streamError } : {}) });
        run.ledgerComplete = true;
      } catch { run.ledgerError = 'MODEL_LEDGER_COMPLETION_FAILED'; }
    }
  })());

  const rt = createRuntime(ctx, { home: join(dataDir, 'ds-bot'), memory: true, memoryReview: false, diagnosticsFile: false,
    mainName: `${nodeId} coordinator`, mainRole: 'DS-Group node' });
  await rt.load();

  function protect(agent) {
    if (protectedAgents.has(agent)) return;
    protectedAgents.add(agent);
    agent.ctx.tools.presentAs('native');
    agent.ctx.tools.guard(() => 'DS-Group pilot uses the remote delegation reply protocol.');
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => ({ ...await next(), tools: [] }));
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const run = active.get(agent.session.id);
      if (!run || run.steps++ > 0 || closing) return { kind: 'reject' };
      return next();
    });
    agent.ctx.on('agent/request', async (_payload, next) => {
      const run = active.get(agent.session.id);
      if (!run || run.requests++ > 0) throw fail('UNSCHEDULED_MODEL_REQUEST');
      const request = await next();
      return { ...request, provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'low', maxTokens: outputTokens,
        tools: [], toolHistory: { tools: [], updates: [] } };
    });
    agent.ctx.on('agent/request-error', async () => ({ kind: 'abort' }), { prepend: true });
  }

  function botResult(bot) {
    return { botId: bot.botId, name: bot.name, role: bot.role, nodeId, dsBotId: bot.dsBotId, sessionId: rt.chatOf(bot.dsBotId), model: MODEL };
  }

  async function createBot(input) {
    required(input.botId, 'botId');
    required(input.name, 'name', 40);
    required(input.role, 'role', 200);
    const previous = state.bots[input.botId];
    if (previous?.setupStatus === 'ready') return botResult(previous);
    let bot = previous ? rt.botOf(previous.dsBotId) : rt.findBot(input.name);
    if (bot && !previous && !bot.instructions?.includes(PROTOCOL)) throw fail('BOT_NAME_CONFLICT');
    bot ??= await rt.createBot({ name: input.name, role: input.role,
      instructions: botInstructions(input.instructions), pickModel: true });
    const record = previous ?? { botId: input.botId, dsBotId: bot.id, name: input.name, role: input.role,
      seenEventIds: [], setupStatus: 'creating', createdAt: new Date().toISOString() };
    state.bots[input.botId] = record;
    await save();
    delete bot.kickoff;
    await rt.save();
    const agent = await rt.resolveAgent(rt.chatOf(bot.id));
    protect(agent);
    await rt.updateBot(bot.id, { model: MODEL, effort: 'low' });
    record.setupStatus = 'ready';
    await save();
    return botResult(record);
  }

  ctx.on('session/event', (session, event) => {
    const run = active.get(session.id);
    if (!run) return;
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message);
      if (text) run.text = text;
      if (event.data?.usage) run.usage = event.data.usage;
    }
    if (event.type === 'turn/end') {
      run.endReason = event.data?.reason?.kind ?? 'unknown';
      run.resolve();
    }
  });

  async function execute(record, input) {
    const bot = state.bots[input.botId];
    let sessionId;
    let agent;
    let timeout;
    let resolve;
    const ended = new Promise(done => { resolve = done; });
    const run = { request: record, resolve, requests: 0, steps: 0, streamStarted: false, text: '' };
    record.status = 'running';
    record.startedAt = new Date().toISOString();
    try {
      await save();
      sessionId = rt.chatOf(bot.dsBotId);
      agent = await rt.resolveAgent(sessionId);
      protect(agent);
      const seen = new Set(bot.seenEventIds);
      const history = (input.history ?? []).filter(item => item && typeof item.eventId === 'string' && !seen.has(item.eventId) && item.eventId !== input.event.eventId)
        .slice(-100).map(item => ({ eventId: item.eventId, senderId: item.senderId, senderName: item.senderName, body: item.body }));
      const context = { kind: 'ds-group-turn', botId: input.botId, requestId: input.requestId, event: input.event, previousUnseenRoomEvents: history };
    const inputText = `${PROTOCOL}\n\n${JSON.stringify(context)}`;
    record.inputEvidence = { messageSha256: createHash('sha256').update(inputText).digest('hex'),
      historyEventIds: history.map(item => item.eventId), currentEventId: input.event.eventId, inputText };
    const message = createUserMessage({ content: [{ type: 'text', text: inputText }],
        source: { kind: 'user', dsGroupRequestId: input.requestId, senderId: input.event.senderId, roomId: input.event.roomId, eventId: input.event.eventId } });
      active.set(sessionId, run);
      record.sessionId = sessionId;
      await save();
      timeout = setTimeout(() => {
        run.timeout = true;
        agent.cancel({ kind: 'hook', reason: 'DS-Group bounded turn deadline' });
        resolve();
      }, TURN_TIMEOUT_MS);
      agent.followup(message);
      await ctx.sessions.flush(agent.session);
      bot.seenEventIds = [...new Set([...bot.seenEventIds, ...history.map(item => item.eventId), input.event.eventId])].slice(-20000);
      await save();
      await ended;
      await agent.whenIdle();
      await ctx.sessions.flush(agent.session);
      if (run.timeout) throw fail('TURN_TIMEOUT');
      if (run.ledgerError) throw fail(run.ledgerError);
      if (run.endReason !== 'completed' || !run.text || !run.streamStarted || !run.ledgerComplete) {
        throw fail(run.streamError ?? 'MODEL_TURN_FAILED');
      }
      record.status = 'completed';
      record.text = run.text;
      record.usage = run.usage ?? null;
      record.claimId = run.claimId;
      progress.completed++;
    } catch (error) {
      record.status = run.streamStarted ? 'unknown' : 'failed';
      record.errorCode = publicError(error);
      record.usage = run.usage ?? null;
      if (run.claimId) record.claimId = run.claimId;
      progress.failed++;
    } finally {
      clearTimeout(timeout);
      active.delete(sessionId);
      record.finishedAt = new Date().toISOString();
      await save();
    }
    return { ...record, duplicate: false };
  }

  async function turn(input) {
    required(input.requestId, 'requestId');
    required(input.botId, 'botId');
    if (!state.bots[input.botId]) throw fail('BOT_NOT_FOUND');
    required(input.event?.eventId, 'eventId');
    required(input.event?.roomId, 'roomId');
    required(input.event?.senderId, 'senderId');
    required(input.event?.body, 'body', 50000);
    if (input.history !== undefined && (!Array.isArray(input.history) || input.history.length > 500)) throw fail('INVALID_HISTORY');
    const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const previous = state.requests[input.requestId];
    if (previous) {
      if (previous.inputHash !== inputHash || previous.botId !== input.botId) throw fail('REQUEST_ID_CONFLICT');
      if (inFlight.has(input.requestId)) return inFlight.get(input.requestId);
      return { ...previous, duplicate: true };
    }
    const record = { requestId: input.requestId, botId: input.botId, inputHash, eventId: input.event.eventId, status: 'queued', acceptedAt: new Date().toISOString() };
    state.requests[input.requestId] = record;
    const accepted = save();
    accepted.catch(() => {});
    progress.requests++;
    const queued = (botQueues.get(input.botId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      try {
        await accepted;
        return await execute(record, input);
      } catch (error) {
        record.status = 'failed';
        record.errorCode = publicError(error);
        record.finishedAt = new Date().toISOString();
        await save();
        return { ...record, duplicate: false };
      }
    });
    botQueues.set(input.botId, queued);
    inFlight.set(input.requestId, queued);
    queued.finally(() => {
      inFlight.delete(input.requestId);
      if (botQueues.get(input.botId) === queued) botQueues.delete(input.botId);
    }).catch(() => {});
    return queued;
  }

  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
      if (request.method === 'GET' && (path === '/health' || path === '/api/ds-group-node/status')) {
        return json(response, 200, { status: closing ? 'stopping' : 'ready', nodeId, engine: 'DS-Bot', engineVersion: '0.2.7',
          loadedRuntimeSha256: LOADED_RUNTIME_SHA256, model: MODEL, maxOutputTokens: outputTokens,
          activeTurns: active.size, progress, bots: Object.values(state.bots).map(botResult) });
      }
      if (request.method === 'GET' && path === '/api/ds-group-node/models') {
        const providers = ctx.llm.listProviders();
        const models = await Promise.all(providers.map(async provider => {
          try { return { id: provider.id, models: (await ctx.llm.listModels(provider.id)).map(model => model.id) }; }
          catch (error) { return { id: provider.id, errorCode: publicError(error) }; }
        }));
        return json(response, 200, { providers: models });
      }
      if (closing) return json(response, 503, { status: 'stopping' });
      if (request.method === 'POST' && path === '/api/ds-group-node/bots') return json(response, 200, await createBot(await body(request)));
      if (request.method === 'POST' && path === '/api/ds-group-node/turns') return json(response, 200, await turn(await body(request)));
      return json(response, 404, { errorCode: 'NOT_FOUND' });
    } catch (error) {
      await writeFile(join(dataDir, 'last-error.json'), JSON.stringify({ at: new Date().toISOString(), code: publicError(error),
        message: error?.message, stack: error?.stack }, null, 2), { mode: 0o600 }).catch(() => {});
      return json(response, 400, { status: 'failed', errorCode: publicError(error) });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  ctx.effect(() => async () => {
    closing = true;
    server.close();
    for (const sessionId of active.keys()) {
      const agent = await rt.resolveAgent(sessionId).catch(() => undefined);
      agent?.cancel({ kind: 'hook', reason: 'DS-Group node stopping' });
    }
    await Promise.allSettled([...inFlight.values()]);
    await writes;
  });
}
