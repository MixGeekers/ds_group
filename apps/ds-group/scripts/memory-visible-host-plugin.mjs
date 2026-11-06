// Test orchestration only. Chat work runs through the product NativeConnections,
// BotNode, Matrix sync, work admission and delivery paths, without synthetic replies.
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRuntime } from '../vendor/ds-bot/index.js';
import { installNativeMemory } from '../memory/native.mjs';
import { NativeBots } from '../dsh-connect/native-bots.mjs';
import { NativeConnections } from '../dsh-connect/native-connections.mjs';
const MODEL = 'opencode-go/deepseek-v4.1-flash';
export const inject = ['llm','tools','systemPrompt','sessionController','sessions','sessionTitle','workspaceRegistry','connection'];
export async function apply(ctx, config) {
  const rt = createRuntime(ctx, { mainName: '识雨', workspace: config.workspace, memoryBackend: installNativeMemory, memoryReviewDelayMs: 250 });
  const native = new NativeBots(ctx), connections = new NativeConnections({ ctx, native });
  let writes = Promise.resolve();
  const log = (file, value) => { writes = writes.catch(() => {}).then(() => appendFile(join(config.directory, file), JSON.stringify(value) + '\n')); return writes; };
  ctx.on('session/event', (session, event) => log('events.jsonl', { sessionId: session.id, ...event }));
  ctx.on('llm/stream', async function* (options, next) {
    const model = `${options.provider}/${options.model}`;
    if (model !== MODEL) throw new Error(`TEST_MODEL_MISMATCH:${model}`);
    const row = { callId: randomUUID(), model, sessionId: options.sessionId, purpose: options.purpose || 'generation', startedAt: Date.now() };
    await log('calls.jsonl', { ...row, event: 'start' });
    try { for await (const chunk of next()) {
      if (chunk.type === 'usage') row.usage = chunk.usage;
      if (chunk.type === 'error') row.failure = chunk.error || chunk.failure || { kind: 'error' };
      if (chunk.type === 'finish') row.finish = chunk.reason;
      yield chunk;
    } row.status = row.failure || row.finish?.kind === 'error' ? 'failed' : 'completed';
    } catch (error) { row.status = 'failed'; row.error = error.message; throw error; }
    finally { await log('calls.jsonl', { ...row, event: 'end', finishedAt: Date.now() }); }
  });
  async function init() {
    let state = await native.state();
    for (const bot of state.bots) await (await native.agent(bot.sessionId)).whenIdle();
    for (const name of ['知秋', '听澜']) if (!state.bots.some(bot => bot.name === name)) {
      await native.call('create-bot', { name, role: '协作助手', model: MODEL,
        instructions: '用简体中文完成协作；保留完整账号、群范围和原始来源；用户要求查询记忆时本轮实际调用 recall。' });
      state = await native.state();
      await (await native.agent(state.bots.find(bot => bot.name === name).sessionId)).whenIdle();
    }
    for (const bot of state.bots) {
      await native.selectModel(bot.id, { model: MODEL, reasoningEffort: 'low', maxTokens: 4096 });
      await rt.setPermission(rt.botOf(bot.id), 'danger-full-access');
    }
    return native.list();
  }
  ctx.effect(() => async () => {
    for (const { node } of [...connections.connections.values()]) await connections.stop(node);
    await writes;
  });
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/memory-test', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    try {
      const { action, input = {} } = await request.json(); let value;
      if (action === 'state') value = await native.state();
      else if (action === 'init') value = await init();
      else if (action === 'connect') {
        const nodes = JSON.parse(await readFile(join(config.directory, 'nodes.json'), 'utf8'));
        for (const node of nodes) await connections.start(node);
        value = await Promise.all(nodes.map(async node => ({ id: node.id, nativeBotId: node.nativeBotId, ...await connections.probe(node) })));
      } else if (action === 'receipts') value = [...connections.connections.values()].flatMap(entry => Object.values(entry.bridge.state.requests).map(record => ({ ...record, nativeBotId: entry.node.nativeBotId })));
      else if (action === 'receipt') { const entry = connections.connections.get(input.botId); value = entry?.bridge.state.requests[input.requestId] || null; }
      else if (action === 'connection-state') value = [...connections.connections.values()].map(entry => ({ id: entry.node.id, state: entry.botNode.state, lastError: entry.botNode.lastError || entry.lastError, snapshot: entry.botNode.store.snapshot() }));
      else if (action === 'flush') { for (const bot of (await native.state()).bots) await rt.memoryFlush(bot.id); value = true; }
      else if (action === 'memory') value = { entries: rt.knowledge.store.list({ history: true }), sources: rt.knowledge.store.sources(), contacts: rt.knowledge.store.contacts(), errors: rt.knowledge.errors, usage: rt.knowledge.backend?.usage };
      else if (action === 'compact') { const bot = (await native.state()).bots[input.index || 0]; await rt.memoryFlush(bot.id); value = { compacted: await rt.checkpointBot(bot.id), bot: await native.bot(bot.id) }; }
      else throw new Error('Unknown visible-test action');
      await writes; return Response.json({ ok: true, value });
    } catch (error) { return Response.json({ ok: false, error: { message: error.message, stack: error.stack } }); }
  } }));
}
