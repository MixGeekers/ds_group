import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { startNativeTeam } from '../dsh-connect/native-team.mjs';
import { NativeBots } from '../dsh-connect/native-bots.mjs';
import { NativeBridge } from '../dsh-connect/native-bridge.mjs';
import { PROTOCOL, NATIVE_PROTOCOL, WORK_TOOLS, botInstructions, nativeBotInstructions } from './runtime-rules.mjs';
import { prepareWorkFiles, collectArtifacts } from './work-files.mjs';
import { SCOPED_PROTOCOL, checkScopedFile, validateScopedInput } from './scoped-work.mjs';
import { checkModel, modelSelection, modelReference } from '../src/model-config.mjs';

export const name = 'ds-group-node';
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection'];

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
  const defaults = ctx.get?.('agentDefaultModel')?.currentSelection?.();
  const selection = modelSelection({
    model: config.model ?? (defaults?.provider && defaults?.model ? `${defaults.provider}/${defaults.model}` : undefined),
    maxTokens: config.maxTokens ?? DEFAULT_OUTPUT_TOKENS,
    reasoningEffort: config.model ? config.reasoningEffort : defaults?.reasoningEffort,
  });
  const route = modelReference(selection.model);
  const outputTokens = selection.maxTokens;
  const taskTimeoutMs = config.taskTimeoutMs ?? 15 * 60_000;
  const maxSteps = config.maxSteps ?? 64;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('INVALID_PORT');
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
  state.nativeUsage ??= [];
  for (const call of state.nativeUsage) if (call.status === 'running') {
    call.status = 'unknown';
    call.errorCode = 'NODE_RESTARTED_DURING_STREAM';
    call.finishedAt = new Date().toISOString();
  }
  for (const request of Object.values(state.requests)) {
    if (['queued', 'running', 'cancelling'].includes(request.status)) {
      request.status = 'unknown';
      request.stage = 'unknown';
      request.errorCode = 'NODE_RESTARTED_DURING_REQUEST';
      request.finishedAt = new Date().toISOString();
      for (const tool of request.toolReceipts || []) if (tool.status === 'running') {
        tool.status = 'unknown';
        tool.effectStatus = 'unknown';
      }
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
  const scopedSessions = new Map();
  const nativeBridges = new Map();
  const progress = { requests: 0, completed: 0, failed: 0, streamClaims: 0, blockedStreams: 0 };
  let closing = false;
  let rt;

  const legacyBot = id => Object.values(state.bots).some(bot => bot.dsBotId === id && bot.mode !== 'native');
  const nativeSession = id => {
    const owner = rt?.selfOf?.(id) ?? (rt?.botOf?.(id) ? id : undefined);
    return owner !== undefined && !legacyBot(owner);
  };
  // Native subagents retain their root Bot's identity and original execution surface.
  async function nativeOwner(sessionId) {
    const seen = new Set();
    while (sessionId && !seen.has(sessionId)) {
      seen.add(sessionId);
      const owner = rt?.selfOf?.(sessionId) ?? (rt?.botOf?.(sessionId) ? sessionId : undefined);
      if (owner !== undefined) return legacyBot(owner) ? undefined : owner;
      const agent = await rt?.resolveAgent?.(sessionId).catch(() => undefined);
      sessionId = agent?.session?.header?.parentSession;
    }
    return undefined;
  }

  async function* observeNativeStream(options, next, nativeBotId) {
    const call = { nativeBotId, sessionId: options.sessionId, model: `${options.provider}/${options.model}`,
      kind: options.purpose || 'generation', status: 'running', startedAt: new Date().toISOString(), usage: null };
    state.nativeUsage.push(call);
    // This is an observation log, not a claim that every native/background call is known.
    state.nativeUsage = state.nativeUsage.slice(-20000);
    await save().catch(() => {});
    try {
      for await (const chunk of next()) {
        if (chunk?.type === 'usage') call.usage = chunk.usage;
        if (chunk?.type === 'error' || chunk?.type === 'finish' && chunk.reason?.kind === 'error') call.errorCode = 'MODEL_STREAM_FAILED';
        yield chunk;
      }
      call.status = call.errorCode ? 'failed' : 'completed';
    } catch (error) {
      call.status = 'failed';
      call.errorCode = publicError(error);
      throw error;
    } finally {
      if (call.status === 'running') call.status = 'unknown';
      call.finishedAt = new Date().toISOString();
      await save().catch(() => {});
    }
  }

  async function workCheck(run, stage, details = {}) {
    if (!run?.input?.authorization) return undefined;
    const core = JSON.parse(await readFile(config.coreConfigPath, 'utf8'));
    const response = await fetch(new URL('/internal/bot-work/check', config.coreUrl), {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${core.nodeSecret}` },
      body: JSON.stringify({ ...details, requestId: run.record.requestId, botId: run.record.botId, stage }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      run.failureCode = 'WORK_AUTHORIZATION_REVOKED';
      throw fail('WORK_AUTHORIZATION_REVOKED');
    }
    const result = await response.json();
    if (stage !== 'observe') run.authorization = validateScopedInput(run.input, result.work);
    return result;
  }

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

  // Legacy/scoped streams retain admission claims. Native work is observed independently.
  ctx.on('llm/stream', (options, next) => (async function* () {
    const run = active.get(options.sessionId);
    if (!run) {
      const owner = await nativeOwner(options.sessionId);
      if (owner !== undefined) { yield* observeNativeStream(options, next, owner); return; }
    }
    if (closing || !run || run.record.cancelRequested || run.record.claims.length >= maxSteps * 2) {
      progress.blockedStreams++;
      throw fail('UNSCHEDULED_MODEL_REQUEST');
    }
    if (options.provider !== route.provider || options.model !== route.model
      || !Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > outputTokens) {
      throw fail('MODEL_REQUEST_OUTSIDE_SCOPE');
    }
    await checkModel(ctx.llm, selection);
    await workCheck(run, 'model');
    const sequence = run.record.claims.length + 1;
    const kind = options.purpose ? `auxiliary:${String(options.purpose).slice(0, 80)}` : 'generation';
    const claim = await ledger('claim', { nodeId, requestId: `${run.record.requestId}/call-${sequence}`, model: `${options.provider}/${options.model}`, maxTokens: options.maxTokens, kind });
    const call = { claimId: required(claim.claimId, 'claimId'), model: selection.model, kind, status: 'claimed', startedAt: new Date().toISOString(), usage: null };
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

  rt = await startNativeTeam(ctx, { home: join(dataDir, 'ds-bot'), memory: true, diagnosticsFile: false,
    memoryReviewForBot: id => !legacyBot(id), mainName: `${nodeId} coordinator`, mainRole: 'DS-Group node' });
  const native = new NativeBots(ctx);
  async function nativeBridge(bot) {
    let pending = nativeBridges.get(bot.dsBotId);
    if (!pending) {
      pending = new NativeBridge({ ctx, native, timeoutMs: taskTimeoutMs,
        node: { id: bot.botId, nativeBotId: bot.dsBotId, ownerId: rt.botOf(bot.dsBotId)?.owner?.id,
          directory: join(dataDir, 'native-bridges', createHash('sha256').update(bot.botId).digest('hex')) } }).initialize();
      nativeBridges.set(bot.dsBotId, pending);
      pending.catch(() => { if (nativeBridges.get(bot.dsBotId) === pending) nativeBridges.delete(bot.dsBotId); });
    }
    return pending;
  }
  if (ctx.systemPrompt) ctx.effect(() => ctx.systemPrompt.section({ name: 'ds-group-scoped-identity', order: 642, interpolate: false,
    text: context => scopedSessions.get(context?.agent?.id)?.instructions || '' }), 'DS-Group scoped identity');

  function configureAgent(agent) {
    if (protectedAgents.has(agent)) return;
    protectedAgents.add(agent);
    const toolsFor = () => {
      const run = active.get(agent.session.id);
      if (!run && scopedSessions.has(agent.session.id)) return new Set();
      return run?.input?.authorization ? new Set(run.authorization?.tools || []) : nativeSession(agent.session.id) ? undefined : WORK_TOOLS;
    };
    agent.ctx.tools.guard(exec => {
      const run = active.get(agent.session.id);
      if (scopedSessions.has(agent.session.id) && !run) return 'This collaboration Session has no active authorized task.';
      if (!toolsFor() || toolsFor().has(exec.name)) return undefined;
      run?.blockedTools.add(exec.callId || exec.id);
      return 'Use only the current authorized task tools.';
    });
    agent.ctx.on('tools/execute', async (exec, next) => {
      const run = active.get(agent.session.id);
      if (run?.input?.authorization) {
        try {
          await checkScopedFile(exec, run.record.workdir, run.authorization?.tools || []);
          await workCheck(run, 'tool', { tool: exec.name, callId: exec.callId || exec.id });
        } catch (error) {
          run.blockedTools.add(exec.callId || exec.id);
          throw error;
        }
      }
      return next();
    });
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next();
      const tools = toolsFor();
      return tools ? { ...assembled, tools: (assembled.tools ?? []).filter(tool => tools.has(tool.name)) } : assembled;
    });
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const run = active.get(agent.session.id);
      if (!run && nativeSession(agent.session.id)) return next();
      if (!run || closing || run.record.cancelRequested) return { kind: 'reject' };
      try { await workCheck(run, 'model'); }
      catch { return { kind: 'reject' }; }
      if (++run.steps > maxSteps) {
        run.failureCode = 'TASK_STEP_LIMIT';
        return { kind: 'reject' };
      }
      updateProgress(run.record, 'working', `正在处理，第 ${run.steps} 步`);
      return next();
    });
    agent.ctx.on('agent/request', async (_payload, next) => {
      const run = active.get(agent.session.id);
      if (!run && nativeSession(agent.session.id)) return next();
      if (!run || run.record.cancelRequested) throw fail('UNSCHEDULED_MODEL_REQUEST');
      const request = await next();
      run.requests++;
      return { ...request, ...route, reasoningEffort: selection.reasoningEffort, maxTokens: outputTokens,
        tools: toolsFor() ? (request.tools ?? []).filter(tool => toolsFor().has(tool.name)) : request.tools };
    });
    agent.ctx.on('agent/request-error', async (_payload, next) => nativeSession(agent.session.id) ? next() : { kind: 'abort' }, { prepend: true });
  }

  function botResult(bot) {
    const nativeProfile = bot.mode === 'native' ? rt.botOf(bot.dsBotId) : undefined;
    const model = nativeProfile ? nativeProfile.model || rt.cachedDefault?.() || selection.model : selection.model;
    return { botId: bot.botId, name: bot.name, role: bot.role, nodeId, dsBotId: bot.dsBotId, sessionId: rt.chatOf(bot.dsBotId),
      ...(bot.mode === 'native' ? { mode: 'native' } : {}),
      tools: bot.tools ?? [], model, modelConfig: nativeProfile ? { model, ...(nativeProfile.effort ? { reasoningEffort: nativeProfile.effort } : {}) } : selection,
      scopedWork: { tools: (bot.tools || []).filter(tool => ['read', 'write', 'edit', 'read_image'].includes(tool)),
        domains: Object.values(bot.domains || {}).map(({ sessionId, roomId, authority }) => ({ sessionId, roomId, authority })) } };
  }

  const botSetups = new Map();
  async function createBot(input) {
    required(input.botId, 'botId');
    required(input.name, 'name', 80);
    required(input.role, 'role', 200);
    if (input.mode !== undefined && input.mode !== 'native') throw fail('INVALID_BOT_MODE');
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
    const requestedNativeId = input.nativeBotId ?? input.nativeBinding?.nativeBotId ?? config.nativeBinding?.nativeBotId;
    if (requestedNativeId !== undefined) required(requestedNativeId, 'nativeBotId');
    if (input.nativeBinding?.botId && input.nativeBinding.botId !== input.botId
      || config.nativeBinding?.botId && config.nativeBinding.botId !== input.botId) throw fail('BOT_BINDING_CONFLICT');
    const mode = input.mode ?? previous?.mode ?? (requestedNativeId ? 'native' : undefined);
    if (previous && mode === 'native' && previous.mode !== 'native'
      && Object.values(state.requests).some(record => record.botId === input.botId && !TERMINAL.has(record.status))) throw fail('BOT_BUSY');
    const internalName = `ds-group-${createHash('sha256').update(input.botId).digest('hex').slice(0, 31)}`;
    const binding = `\n\nDS_GROUP_MATRIX_BOT_ID=${JSON.stringify(input.botId)}`;
    const instructions = `${mode === 'native' ? nativeBotInstructions(input.instructions) : botInstructions(input.instructions)}${binding}`;
    // Persist the identity in the first DS-Bot write so retries can recover before the bridge mapping exists.
    if (previous && requestedNativeId && previous.dsBotId !== requestedNativeId) throw fail('BOT_BINDING_CONFLICT');
    let bot = requestedNativeId ? rt.botOf(requestedNativeId) : previous ? rt.botOf(previous.dsBotId) : rt.findBot(internalName);
    if ((previous || requestedNativeId) && !bot) throw fail('BOT_BINDING_MISSING', 'Restore the existing DS-Bot state before retrying this saved binding.');
    const preserveNative = mode === 'native' && !!bot && (requestedNativeId !== undefined || previous?.mode === 'native');
    if (!preserveNative) await checkModel(ctx.llm, selection);
    const boundElsewhere = bot && Object.entries(state.bots).some(([botId, record]) => botId !== input.botId && record.dsBotId === bot.id);
    if (boundElsewhere || bot && !previous && !requestedNativeId && ((!bot.instructions?.includes(PROTOCOL) && !bot.instructions?.includes(NATIVE_PROTOCOL)) || !bot.instructions.endsWith(binding))) {
      throw fail('BOT_BINDING_CONFLICT');
    }
    if (!bot) bot = await rt.createBot({ name: internalName, role: input.role, instructions, pickModel: true,
      ...(mode === 'native' ? { main: !rt.state?.mainBotIds?.length, greet: false,
        ...(input.owner || input.ownerId ? { owner: input.owner || { id: input.ownerId, kind: 'human' } } : {}),
        source: { transport: 'ds-group-node', nodeId, matrixId: input.botId } } : {}) });
    const record = previous ?? { botId: input.botId, dsBotId: bot.id, name: input.name, role: input.role,
      seenEventIds: [], setupStatus: 'creating', createdAt: new Date().toISOString() };
    record.name = input.name;
    record.role = input.role;
    if (mode === 'native') record.mode = mode;
    state.bots[input.botId] = record;
    await save();
    if (!preserveNative) {
      delete bot.kickoff;
      await rt.save();
    }
    const agent = await rt.resolveAgent(rt.chatOf(bot.id));
    if (mode !== 'native') configureAgent(agent);
    record.tools = agent.ctx.tools.schemas(agent).map(tool => tool.name).filter(tool => mode === 'native' || WORK_TOOLS.has(tool));
    // Bridge setup must not send the vendor's profile-update message and start an unsolicited turn.
    if (!preserveNative) await rt.updateBot(bot.id, { model: selection.model, effort: selection.reasoningEffort ?? '', instructions }, bot.id, rt.chatOf(bot.id));
    const presets = ctx.get?.('permissionPresets');
    if (presets && mode !== 'native') await rt.setPermission(bot, 'danger-full-access');
    record.setupStatus = 'ready';
    await save();
    return botResult(record);
  }

  function boundBot(input) {
    required(input?.botId, 'botId');
    const bot = state.bots[input.botId];
    if (!bot) throw fail('BOT_NOT_FOUND');
    return bot;
  }

  async function nativeOperation(operation, input) {
    const bot = boundBot(input);
    const bridge = await nativeBridge(bot);
    if (typeof bridge[operation] !== 'function') throw fail('KERNEL_CAPABILITY_UNAVAILABLE');
    return bridge[operation]({ ...input, botId: bot.dsBotId });
  }

  async function executeNative(record, input) {
    const bot = state.bots[input.botId];
    const bridge = await nativeBridge(bot);
    const bridgeInput = { ...input, mode: 'native' };
    record.mode = 'native';
    record.status = 'running';
    record.startedAt = new Date().toISOString();
    updateProgress(record, 'working', '原生 Bot 正在处理');
    try {
      const pending = bridge.turn(bridgeInput, { onProgress: snapshot => {
        Object.assign(record, { sessionId: snapshot.sessionId, toolCalls: snapshot.toolCalls ?? snapshot.toolReceipts?.length ?? 0,
          toolReceipts: snapshot.toolReceipts ?? [], summary: snapshot.summary || record.summary, stage: snapshot.stage || record.stage });
        return save();
      } });
      if (record.cancelRequested) await bridge.cancel(record.requestId);
      const result = await pending;
      // Keep the transport's original idempotency hash and the native receipt's facts.
      const { inputHash: nativeInputHash, ...facts } = result;
      Object.assign(record, facts, { nativeInputHash });
      if (record.status === 'completed') progress.completed++;
      else progress.failed++;
    } catch (error) {
      record.status = record.cancelRequested ? 'cancelled' : 'failed';
      record.stage = record.status;
      record.errorCode = publicError(error);
      progress.failed++;
    } finally {
      record.finishedAt ||= new Date().toISOString();
      await save();
      durableTerminals.add(record.requestId);
    }
    return receipt(record);
  }

  ctx.on('session/event', async (session, event) => {
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
        if (run.input?.authorization) {
          item.effectStatus = run.blockedTools.has(item.callId) ? 'not_executed' : message.isError ? 'unknown' : 'completed';
          try {
            const observation = await workCheck(run, 'observe', { tool: item.name, callId: item.callId, effectStatus: item.effectStatus });
            if (observation.late) item.late = true;
          } catch { item.observationPending = true; }
        }
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
    if (!input.authorization && state.bots[input.botId]?.mode === 'native') return executeNative(record, input);
    const bot = state.bots[input.botId];
    let sessionId;
    let agent;
    let timeout;
    let resolve;
    const ended = new Promise(done => { resolve = done; });
    const run = { record, input, resolve, requests: 0, steps: 0, streamStarted: false, text: '', blockedTools: new Set() };
    record.status = 'running';
    record.startedAt = new Date().toISOString();
    updateProgress(record, 'preparing', '正在准备文件');
    try {
      await checkModel(ctx.llm, selection);
      await workCheck(run, 'run');
      const workspace = await prepareWorkFiles({ dataDir, requestId: record.requestId, workdir: input.workdir, files: input.files });
      record.workdir = workspace.workdir;
      record.files = workspace.files;
      let domain;
      if (input.authorization) {
        if (!ctx.systemPrompt) throw fail('SCOPED_IDENTITY_UNAVAILABLE');
        const work = run.authorization;
        bot.domains ||= {};
        domain = bot.domains[work.domainId];
        if (!domain) {
          const directory = join(dataDir, 'collaboration-domains', work.domainId);
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const created = await rt.createSession(`${bot.name} · ${work.authority} · collaboration`, { dir: directory });
          domain = { sessionId: created, roomId: work.roomId, authority: work.authority, seenEventIds: [] };
          bot.domains[work.domainId] = domain;
          await save();
        }
        sessionId = domain.sessionId;
        scopedSessions.set(sessionId, { instructions: `你是 ${bot.name} (${bot.botId})，所有者 ${work.ownerId}。当前授权协作域为 ${work.authority} 的房间 ${work.roomId}。\n\n${SCOPED_PROTOCOL}` });
        record.authorization = work;
        record.contextDomainId = work.domainId;
      } else sessionId = rt.chatOf(bot.dsBotId);
      agent = await rt.resolveAgent(sessionId);
      configureAgent(agent);
      const directory = ctx.get?.('workingDirectory');
      if (!directory) throw fail('WORKING_DIRECTORY_UNAVAILABLE');
      await directory.set(agent, workspace.workdir);
      const presets = ctx.get?.('permissionPresets');
      if (presets) presets.set(agent.session, 'danger-full-access');
      if (record.cancelRequested) throw fail('TASK_CANCELLED');
      const seenRecord = domain || bot;
      const seen = new Set(seenRecord.seenEventIds);
      const history = (input.history ?? []).filter(item => item && typeof item.eventId === 'string' && !seen.has(item.eventId) && item.eventId !== input.event.eventId)
        .slice(-100).map(item => ({ eventId: item.eventId, senderId: item.senderId, senderName: item.senderName, body: item.body, attachments: item.attachments }));
      const context = { kind: 'ds-group-turn', botId: input.botId, requestId: input.requestId, event: input.event,
        workdir: workspace.workdir, files: workspace.files,
        attachmentWarnings: input.attachmentWarnings ?? [], historyWarnings: input.historyWarnings ?? [],
        fileTools: input.authorization ? { available: run.authorization.tools } : { node: process.execPath, cli: fileWorkCli,
          commands: ['extract INPUT [--output-dir DIR]', 'table INPUT [--sheet NAME]', 'summarize INPUT --group COLUMN --sum COLUMN --output OUT.xlsx [--sheet NAME] [--unique COLUMN]',
            'xlsx-create --input SPEC.json --output OUT.xlsx', 'docx-create --input SPEC.json --output OUT.docx', 'docx-edit INPUT --ops OPS.json --output OUT.docx'] },
        previousUnseenRoomEvents: history };
      const inputText = `${input.authorization ? SCOPED_PROTOCOL : PROTOCOL}\n\n${JSON.stringify(context)}`;
      record.inputEvidence = { messageSha256: createHash('sha256').update(inputText).digest('hex'),
        historyEventIds: history.map(item => item.eventId), currentEventId: input.event.eventId, inputText };
      const message = createUserMessage({ content: [{ type: 'text', text: inputText }],
        source: { kind: input.event.senderKind === 'bot' ? 'bot' : 'user', dsGroupRequestId: input.requestId,
          sender: { id: input.event.senderId, name: input.event.senderName || input.event.senderId,
            kind: input.event.senderKind === 'bot' ? 'bot' : 'human' },
          senderId: input.event.senderId, roomId: input.event.roomId, eventId: input.event.eventId } });
      active.set(sessionId, run);
      record.sessionId = sessionId;
      await save();
      timeout = setTimeout(() => {
        run.failureCode = 'TASK_TIMEOUT';
        stopJobs(sessionId, 'DS-Group task timeout');
        agent.cancel({ kind: 'hook', reason: 'DS-Group task timeout' });
        resolve();
      }, taskTimeoutMs);
      if (!input.authorization) await rt.memoryIngress?.(sessionId, inputText, input);
      agent.followup(message);
      await ctx.sessions.flush(agent.session);
      seenRecord.seenEventIds = [...new Set([...seenRecord.seenEventIds, ...history.map(item => item.eventId), input.event.eventId])].slice(-20000);
      await save();
      await ended;
      await agent.whenIdle();
      await ctx.sessions.flush(agent.session);
      if (record.cancelRequested) throw fail('TASK_CANCELLED');
      if (run.failureCode) throw fail(run.failureCode);
      if (run.ledgerError) throw fail(run.ledgerError);
      await workCheck(run, 'run');
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
    if (payload.mode !== undefined && payload.mode !== 'native') throw fail('INVALID_BOT_MODE');
    if (payload.mode === 'native' && state.bots[payload.botId].mode !== 'native') throw fail('BOT_MODE_MISMATCH');
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
      status: 'queued', stage: 'queued', model: selection.model, modelConfig: selection, summary: '等待处理', claims: [], toolCalls: 0, toolReceipts: [], artifacts: [], acceptedAt: new Date().toISOString() };
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
      if (record.mode === 'native') {
        const bot = state.bots[record.botId];
        await (await nativeBridge(bot)).cancel(requestId);
      }
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
        let modelStatus;
        try { await checkModel(ctx.llm, selection); modelStatus = { status: 'ready' }; }
        catch (error) { modelStatus = { status: 'unavailable', errorCode: publicError(error) }; }
        const runtime = rt.runtimeInfo?.();
        return json(response, 200, { status: closing ? 'stopping' : 'ready', nodeId, engine: 'DS-Bot', engineVersion: runtime?.upstreamVersion,
          runtime,
          loadedRuntimeSha256: LOADED_RUNTIME_SHA256, model: selection.model, modelConfig: selection, modelStatus,
          maxOutputTokens: outputTokens, maxSteps, taskTimeoutMs,
          capabilities: { fileWork: true, tools: [...WORK_TOOLS], asyncTasks: true, native: true,
            sourceMemory: true, backgroundObservation: true, attentionView: true, kernelState: true, memoryProfiles: true },
          nativeUsage: { accounting: 'observed-native-streams', complete: false, observedCalls: state.nativeUsage.length,
            activeCalls: state.nativeUsage.filter(call => call.status === 'running').length },
          activeTurns: active.size + Object.values(state.requests).filter(record => record.mode === 'native' && record.status === 'running').length,
          progress, bots: Object.values(state.bots).map(botResult) });
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
      const kernelOperations = new Map([
        ['/api/ds-group-node/observe', 'observe'],
        ['/api/ds-group-node/attention/view', 'readAttentionView'],
        ['/api/ds-group-node/kernel/state', 'kernelState'],
        ['/api/ds-group-node/memory/profiles', 'memoryProfiles'],
        ['/api/ds-group-node/memory/profile', 'memoryProfile'],
      ]);
      if (request.method === 'POST' && kernelOperations.has(path)) return json(response, 200, await nativeOperation(kernelOperations.get(path), await body(request)));
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
    await Promise.allSettled([...nativeBridges.values()].map(async pending => (await pending).detach()));
    await Promise.allSettled([...inFlight.values()]);
    await writes;
  });
}
