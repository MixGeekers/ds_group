import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createRuntime } from '../vendor/ds-bot/index.js';
import { PROTOCOL, WORK_TOOLS, botInstructions } from './runtime-rules.mjs';
import { prepareWorkFiles, collectArtifacts } from './work-files.mjs';

export const name = 'ds-group-node';
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection'];

const MODEL = 'opencode-go/deepseek-v4.1-flash';
const LOADED_RUNTIME_SHA256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const DEFAULT_OUTPUT_TOKENS = 4096;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'unknown']);
const fileWorkCli = fileURLToPath(new URL('../scripts/file-work.mjs', import.meta.url));

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
    if (bytes > 512_000) throw fail('INPUT_TOO_LARGE');
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

function usageOf(claims) {
  const result = { calls: claims.length };
  for (const claim of claims) {
    for (const [key, value] of Object.entries(claim.usage ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value)) result[key] = (result[key] ?? 0) + value;
    }
  }
  return result;
}

export async function apply(ctx, config) {
  const nodeId = required(config.nodeId, 'nodeId');
  const dataDir = required(config.dataDir, 'dataDir', 4096);
  const port = Number(config.port);
  const outputTokens = config.maxTokens ?? DEFAULT_OUTPUT_TOKENS;
  const taskTimeoutMs = config.taskTimeoutMs ?? 15 * 60_000;
  const maxSteps = config.maxSteps ?? 64;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('INVALID_PORT');
  if (!Number.isInteger(outputTokens) || outputTokens < 1 || outputTokens > 8192) throw fail('INVALID_OUTPUT_LIMIT');
  if (!Number.isInteger(taskTimeoutMs) || taskTimeoutMs < 1000 || taskTimeoutMs > 3_600_000) throw fail('INVALID_TASK_TIMEOUT');
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 256) throw fail('INVALID_STEP_LIMIT');
  await mkdir(dataDir, { recursive: true });
  const statePath = join(dataDir, 'node-state.json');
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { schemaVersion: 2, nodeId, bots: {}, requests: {} };
  }
  if (state.nodeId !== nodeId || ![1, 2].includes(state.schemaVersion)) throw fail('NODE_STATE_MISMATCH');
  state.schemaVersion = 2;
  for (const request of Object.values(state.requests)) {
    if (['queued', 'running', 'cancelling'].includes(request.status)) {
      request.status = 'unknown';
      request.stage = 'unknown';
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
  const durableTerminals = new Set(Object.values(state.requests).filter(request => TERMINAL.has(request.status)).map(request => request.requestId));

  function receipt(record, duplicate = false) {
    const { inputEvidence, ...result } = record;
    if (TERMINAL.has(record.status) && !durableTerminals.has(record.requestId)) {
      // Polling callers can publish a completed result as soon as they see it.
      // Keep it pending until its persistent receipt has committed successfully.
      return { ...result, status: 'running', stage: 'saving', summary: '正在保存结果',
        text: undefined, artifacts: [], finishedAt: undefined, duplicate };
    }
    return { ...result, duplicate };
  }

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

  function updateProgress(record, stage, summary) {
    record.stage = stage;
    record.summary = summary;
    record.updatedAt = new Date().toISOString();
    void save().catch(() => {});
  }

  // Every native or auxiliary model stream belongs to one admitted task and gets its own receipt.
  ctx.on('llm/stream', (options, next) => (async function* () {
    const run = active.get(options.sessionId);
    if (closing || !run || run.record.cancelRequested || run.record.claims.length >= maxSteps * 2) {
      progress.blockedStreams++;
      throw fail('UNSCHEDULED_MODEL_REQUEST');
    }
    if (options.provider !== 'opencode-go' || options.model !== 'deepseek-v4.1-flash'
      || !Number.isInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > 8192) {
      throw fail('MODEL_REQUEST_OUTSIDE_SCOPE');
    }
    const sequence = run.record.claims.length + 1;
    const kind = options.purpose ? `auxiliary:${String(options.purpose).slice(0, 80)}` : 'generation';
    const claim = await ledger('claim', { nodeId, requestId: `${run.record.requestId}/call-${sequence}`, model: MODEL, maxTokens: options.maxTokens, kind });
    const call = { claimId: required(claim.claimId, 'claimId'), kind, status: 'claimed', startedAt: new Date().toISOString(), usage: null };
    run.record.claims.push(call);
    run.record.claimId = call.claimId;
    run.streamStarted = true;
    progress.streamClaims++;
    await save();
    let chunks = 0;
    let bytes = 0;
    try {
      for await (const chunk of next()) {
        chunks++;
        if (chunk?.type === 'usage') call.usage = chunk.usage;
        if (chunk?.type === 'text-delta') bytes += Buffer.byteLength(chunk.text ?? '');
        if (chunk?.type === 'error' || chunk?.type === 'finish' && chunk.reason?.kind === 'error') call.errorCode = 'MODEL_STREAM_FAILED';
        yield chunk;
      }
      if (!chunks) throw fail('EMPTY_PROVIDER_STREAM');
      call.status = call.errorCode ? 'failed' : 'completed';
    } catch (error) {
      call.errorCode = publicError(error);
      call.status = run.record.cancelRequested ? 'cancelled' : 'failed';
      throw error;
    } finally {
      if (call.status === 'claimed') {
        call.status = run.record.cancelRequested ? 'cancelled' : 'unknown';
        call.errorCode = 'MODEL_STREAM_INTERRUPTED';
      }
      call.textBytes = bytes;
      call.finishedAt = new Date().toISOString();
      try {
        await ledger('complete', { claimId: call.claimId, status: call.status, usage: call.usage,
          textBytes: bytes, ...(call.errorCode ? { errorCode: call.errorCode } : {}) });
        call.recorded = true;
      } catch { run.ledgerError = 'MODEL_LEDGER_COMPLETION_FAILED'; }
      run.record.usage = usageOf(run.record.claims);
      await save();
    }
  })());

  const rt = createRuntime(ctx, { home: join(dataDir, 'ds-bot'), memory: true, memoryReview: false, diagnosticsFile: false,
    mainName: `${nodeId} coordinator`, mainRole: 'DS-Group node' });
  await rt.load();

  function configureAgent(agent) {
    if (protectedAgents.has(agent)) return;
    protectedAgents.add(agent);
    agent.ctx.tools.presentAs('native');
    agent.ctx.tools.guard(exec => WORK_TOOLS.has(exec.name) ? undefined : 'Use the task file tools and the final delegate field for collaboration.');
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next();
      return { ...assembled, tools: (assembled.tools ?? []).filter(tool => WORK_TOOLS.has(tool.name)) };
    });
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const run = active.get(agent.session.id);
      if (!run || closing || run.record.cancelRequested) return { kind: 'reject' };
      if (++run.steps > maxSteps) {
        run.failureCode = 'TASK_STEP_LIMIT';
        return { kind: 'reject' };
      }
      updateProgress(run.record, 'working', `正在处理，第 ${run.steps} 步`);
      return next();
    });
    agent.ctx.on('agent/request', async (_payload, next) => {
      const run = active.get(agent.session.id);
      if (!run || run.record.cancelRequested) throw fail('UNSCHEDULED_MODEL_REQUEST');
      const request = await next();
      run.requests++;
      return { ...request, provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'low', maxTokens: outputTokens,
        tools: (request.tools ?? []).filter(tool => WORK_TOOLS.has(tool.name)) };
    });
    agent.ctx.on('agent/request-error', async () => ({ kind: 'abort' }), { prepend: true });
  }

  function botResult(bot) {
    return { botId: bot.botId, name: bot.name, role: bot.role, nodeId, dsBotId: bot.dsBotId, sessionId: rt.chatOf(bot.dsBotId),
      tools: bot.tools ?? [], model: MODEL };
  }

  const botSetups = new Map();
  async function createBot(input) {
    required(input.botId, 'botId');
    required(input.name, 'name', 80);
    required(input.role, 'role', 200);
    const setup = (botSetups.get(input.botId) ?? Promise.resolve()).catch(() => {}).then(() => setupBot(input));
    botSetups.set(input.botId, setup);
    try {
      return await setup;
    } finally {
      if (botSetups.get(input.botId) === setup) botSetups.delete(input.botId);
    }
  }

  async function setupBot(input) {
    const previous = state.bots[input.botId];
    const internalName = `ds-group-${createHash('sha256').update(input.botId).digest('hex').slice(0, 31)}`;
    const binding = `\n\nDS_GROUP_MATRIX_BOT_ID=${JSON.stringify(input.botId)}`;
    const instructions = `${botInstructions(input.instructions)}${binding}`;
    // Persist the identity in the first DS-Bot write so retries can recover before the bridge mapping exists.
    let bot = previous ? rt.botOf(previous.dsBotId) : rt.findBot(internalName);
    if (previous && !bot) throw fail('BOT_BINDING_MISSING', 'Restore the existing DS-Bot state before retrying this saved binding.');
    const boundElsewhere = bot && Object.entries(state.bots).some(([botId, record]) => botId !== input.botId && record.dsBotId === bot.id);
    if (boundElsewhere || bot && !previous && (!bot.instructions?.includes(PROTOCOL) || !bot.instructions.endsWith(binding))) {
      throw fail('BOT_BINDING_CONFLICT');
    }
    if (!bot) bot = await rt.createBot({ name: internalName, role: input.role, instructions, pickModel: true });
    const record = previous ?? { botId: input.botId, dsBotId: bot.id, name: input.name, role: input.role,
      seenEventIds: [], setupStatus: 'creating', createdAt: new Date().toISOString() };
    record.name = input.name;
    record.role = input.role;
    state.bots[input.botId] = record;
    await save();
    delete bot.kickoff;
    await rt.save();
    const agent = await rt.resolveAgent(rt.chatOf(bot.id));
    configureAgent(agent);
    record.tools = agent.ctx.tools.schemas(agent).map(tool => tool.name).filter(tool => WORK_TOOLS.has(tool));
    // Bridge setup must not send the vendor's profile-update message and start an unsolicited turn.
    await rt.updateBot(bot.id, { model: MODEL, effort: 'low', instructions }, bot.id, rt.chatOf(bot.id));
    const presets = ctx.get?.('permissionPresets');
    if (presets) await rt.setPermission(bot, 'danger-full-access');
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
    }
    if (event.type === 'tool/call') {
      const data = event.data;
      run.record.toolReceipts.push({ callId: data.callId, name: data.name, status: 'running', startedAt: new Date().toISOString() });
      run.record.toolCalls = run.record.toolReceipts.length;
      updateProgress(run.record, 'working', `正在使用 ${data.name}`);
    }
    if (event.type === 'tool/result') {
      const message = event.data?.message;
      const item = run.record.toolReceipts.find(tool => tool.callId === message?.toolCallId);
      if (item) {
        item.status = message.isError ? 'failed' : 'completed';
        item.finishedAt = new Date().toISOString();
        item.summary = textOf(message).slice(0, 2000);
      }
      void save().catch(() => {});
    }
    if (event.type === 'turn/end') {
      run.endReason = event.data?.reason?.kind ?? 'unknown';
      run.resolve();
    }
  });

  function stopJobs(sessionId, reason) {
    if (!sessionId) return;
    const jobs = ctx.get?.('jobs');
    if (!jobs) return;
    for (const job of jobs.list(sessionId)) {
      if (['running', 'stopping'].includes(job.status)) {
        try { jobs.kill(job.id, sessionId, reason); } catch {}
      }
    }
  }

  async function execute(record, input) {
    if (record.cancelRequested) return receipt(record);
    if (closing) {
      record.status = 'unknown';
      record.stage = 'unknown';
      record.errorCode = 'NODE_STOPPING';
      record.finishedAt = new Date().toISOString();
      await save();
      durableTerminals.add(record.requestId);
      return receipt(record);
    }
    const bot = state.bots[input.botId];
    let sessionId;
    let agent;
    let timeout;
    let resolve;
    const ended = new Promise(done => { resolve = done; });
    const run = { record, resolve, requests: 0, steps: 0, streamStarted: false, text: '' };
    record.status = 'running';
    record.startedAt = new Date().toISOString();
    updateProgress(record, 'preparing', '正在准备文件');
    try {
      const workspace = await prepareWorkFiles({ dataDir, requestId: record.requestId, workdir: input.workdir, files: input.files });
      record.workdir = workspace.workdir;
      record.files = workspace.files;
      sessionId = rt.chatOf(bot.dsBotId);
      agent = await rt.resolveAgent(sessionId);
      configureAgent(agent);
      const directory = ctx.get?.('workingDirectory');
      if (!directory) throw fail('WORKING_DIRECTORY_UNAVAILABLE');
      await directory.set(agent, workspace.workdir);
      const presets = ctx.get?.('permissionPresets');
      if (presets) presets.set(agent.session, 'danger-full-access');
      if (record.cancelRequested) throw fail('TASK_CANCELLED');
      const seen = new Set(bot.seenEventIds);
      const history = (input.history ?? []).filter(item => item && typeof item.eventId === 'string' && !seen.has(item.eventId) && item.eventId !== input.event.eventId)
        .slice(-100).map(item => ({ eventId: item.eventId, senderId: item.senderId, senderName: item.senderName, body: item.body, attachments: item.attachments }));
      const context = { kind: 'ds-group-turn', botId: input.botId, requestId: input.requestId, event: input.event,
        workdir: workspace.workdir, files: workspace.files,
        attachmentWarnings: input.attachmentWarnings ?? [], historyWarnings: input.historyWarnings ?? [],
        fileTools: { node: process.execPath, cli: fileWorkCli,
          commands: ['extract INPUT [--output-dir DIR]', 'table INPUT [--sheet NAME]', 'summarize INPUT --group COLUMN --sum COLUMN --output OUT.xlsx [--sheet NAME] [--unique COLUMN]',
            'xlsx-create --input SPEC.json --output OUT.xlsx', 'docx-create --input SPEC.json --output OUT.docx', 'docx-edit INPUT --ops OPS.json --output OUT.docx'] },
        previousUnseenRoomEvents: history };
      const inputText = `${PROTOCOL}\n\n${JSON.stringify(context)}`;
      record.inputEvidence = { messageSha256: createHash('sha256').update(inputText).digest('hex'),
        historyEventIds: history.map(item => item.eventId), currentEventId: input.event.eventId, inputText };
      const message = createUserMessage({ content: [{ type: 'text', text: inputText }],
        source: { kind: 'user', dsGroupRequestId: input.requestId, senderId: input.event.senderId, roomId: input.event.roomId, eventId: input.event.eventId } });
      active.set(sessionId, run);
      record.sessionId = sessionId;
      await save();
      timeout = setTimeout(() => {
        run.failureCode = 'TASK_TIMEOUT';
        stopJobs(sessionId, 'DS-Group task timeout');
        agent.cancel({ kind: 'hook', reason: 'DS-Group task timeout' });
        resolve();
      }, taskTimeoutMs);
      agent.followup(message);
      await ctx.sessions.flush(agent.session);
      bot.seenEventIds = [...new Set([...bot.seenEventIds, ...history.map(item => item.eventId), input.event.eventId])].slice(-20000);
      await save();
      await ended;
      await agent.whenIdle();
      await ctx.sessions.flush(agent.session);
      if (record.cancelRequested) throw fail('TASK_CANCELLED');
      if (run.failureCode) throw fail(run.failureCode);
      if (run.ledgerError) throw fail(run.ledgerError);
      if (run.endReason !== 'completed' || !run.text || !run.streamStarted || record.claims.some(call => !call.recorded)) throw fail('MODEL_TURN_FAILED');
      const jobs = ctx.get?.('jobs')?.list(sessionId) ?? [];
      if (jobs.some(job => ['running', 'stopping'].includes(job.status))) throw fail('TASK_HAS_RUNNING_JOBS');
      updateProgress(record, 'verifying', '正在检查成果');
      record.artifacts = await collectArtifacts(run.text, workspace.workdir);
      record.text = run.text;
      record.usage = usageOf(record.claims);
      record.status = 'completed';
      updateProgress(record, 'completed', record.artifacts.length ? '成果文件已准备好' : '处理完成');
      progress.completed++;
    } catch (error) {
      const code = publicError(error);
      record.status = record.cancelRequested || code === 'TASK_CANCELLED' ? 'cancelled'
        : closing || run.streamStarted && !run.endReason ? 'unknown' : 'failed';
      record.errorCode = code;
      record.usage = usageOf(record.claims);
      updateProgress(record, record.status, record.status === 'cancelled' ? '已取消' : code);
      stopJobs(sessionId, 'DS-Group task finished without completion');
      progress.failed++;
    } finally {
      clearTimeout(timeout);
      active.delete(sessionId);
      record.finishedAt = new Date().toISOString();
      await save();
      durableTerminals.add(record.requestId);
    }
    return receipt(record);
  }

  async function turn(input) {
    const asynchronous = input.async === true;
    const { async: ignored, ...payload } = input;
    required(payload.requestId, 'requestId');
    required(payload.botId, 'botId');
    if (!state.bots[payload.botId]) throw fail('BOT_NOT_FOUND');
    required(payload.event?.eventId, 'eventId');
    required(payload.event?.roomId, 'roomId');
    required(payload.event?.senderId, 'senderId');
    if (typeof payload.event?.body !== 'string' || payload.event.body.length > 50000 || (!payload.event.body.trim() && !payload.files?.length)) throw fail('INVALID_INPUT', 'A message or attachment is required');
    if (payload.history !== undefined && (!Array.isArray(payload.history) || payload.history.length > 500)) throw fail('INVALID_HISTORY');
    const inputHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const previous = state.requests[payload.requestId];
    if (previous) {
      if (previous.inputHash !== inputHash || previous.botId !== payload.botId) throw fail('REQUEST_ID_CONFLICT');
      if (!asynchronous && inFlight.has(payload.requestId)) return inFlight.get(payload.requestId);
      return receipt(previous, true);
    }
    const record = { requestId: payload.requestId, botId: payload.botId, inputHash, eventId: payload.event.eventId,
      status: 'queued', stage: 'queued', summary: '等待处理', claims: [], toolCalls: 0, toolReceipts: [], artifacts: [], acceptedAt: new Date().toISOString() };
    state.requests[payload.requestId] = record;
    const accepted = save();
    accepted.catch(() => {});
    progress.requests++;
    const queued = (botQueues.get(payload.botId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      try { await accepted; return await execute(record, payload); }
      catch (error) {
        record.status = 'failed';
        record.stage = 'failed';
        record.errorCode = publicError(error);
        record.finishedAt = new Date().toISOString();
        await save();
        durableTerminals.add(record.requestId);
        return receipt(record);
      }
    });
    botQueues.set(payload.botId, queued);
    inFlight.set(payload.requestId, queued);
    queued.finally(() => {
      inFlight.delete(payload.requestId);
      if (botQueues.get(payload.botId) === queued) botQueues.delete(payload.botId);
    }).catch(() => {});
    await accepted;
    return asynchronous ? receipt(record) : queued;
  }

  async function cancel(requestId) {
    const record = state.requests[requestId];
    if (!record) throw fail('REQUEST_NOT_FOUND');
    if (TERMINAL.has(record.status)) return receipt(record, true);
    record.cancelRequested = true;
    if (record.status === 'queued') {
      record.status = 'cancelled';
      record.finishedAt = new Date().toISOString();
      updateProgress(record, 'cancelled', '已取消');
    } else {
      updateProgress(record, 'cancelling', '正在取消');
      const run = active.get(record.sessionId);
      if (run) {
        stopJobs(record.sessionId, 'DS-Group task cancelled');
        const agent = await rt.resolveAgent(record.sessionId);
        agent.cancel({ kind: 'hook', reason: 'DS-Group task cancelled' });
        run.resolve();
      }
    }
    await save();
    if (TERMINAL.has(record.status)) durableTerminals.add(record.requestId);
    return receipt(record);
  }

  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
      if (request.method === 'GET' && (path === '/health' || path === '/api/ds-group-node/status')) {
        return json(response, 200, { status: closing ? 'stopping' : 'ready', nodeId, engine: 'DS-Bot', engineVersion: '0.2.7',
          loadedRuntimeSha256: LOADED_RUNTIME_SHA256, model: MODEL, maxOutputTokens: outputTokens, maxSteps, taskTimeoutMs,
          capabilities: { fileWork: true, tools: [...WORK_TOOLS], asyncTasks: true },
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
      const lookup = path.match(/^\/api\/ds-group-node\/turns\/([^/]+)$/);
      if (request.method === 'GET' && lookup) {
        const record = state.requests[decodeURIComponent(lookup[1])];
        return record ? json(response, 200, receipt(record)) : json(response, 404, { errorCode: 'REQUEST_NOT_FOUND' });
      }
      if (closing) return json(response, 503, { status: 'stopping' });
      const cancellation = path.match(/^\/api\/ds-group-node\/turns\/([^/]+)\/cancel$/);
      if (request.method === 'POST' && cancellation) return json(response, 200, await cancel(decodeURIComponent(cancellation[1])));
      if (request.method === 'POST' && path === '/api/ds-group-node/bots') return json(response, 200, await createBot(await body(request)));
      if (request.method === 'POST' && path === '/api/ds-group-node/turns') {
        const input = await body(request);
        const result = await turn(input);
        return json(response, input.async && !TERMINAL.has(result.status) ? 202 : 200, result);
      }
      return json(response, 404, { errorCode: 'NOT_FOUND' });
    } catch (error) {
      await writeFile(join(dataDir, 'last-error.json'), JSON.stringify({ at: new Date().toISOString(), code: publicError(error),
        message: error?.message, stack: error?.stack }, null, 2), { mode: 0o600 }).catch(() => {});
      return json(response, error?.code === 'REQUEST_NOT_FOUND' ? 404 : 400, { status: 'failed', errorCode: publicError(error) });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  ctx.effect(() => async () => {
    closing = true;
    server.close();
    for (const [sessionId, run] of active) {
      run.failureCode = 'NODE_STOPPING';
      stopJobs(sessionId, 'DS-Group node stopping');
      const agent = await rt.resolveAgent(sessionId).catch(() => undefined);
      agent?.cancel({ kind: 'hook', reason: 'DS-Group node stopping' });
      run.resolve();
    }
    await Promise.allSettled([...inFlight.values()]);
    await writes;
  });
}
