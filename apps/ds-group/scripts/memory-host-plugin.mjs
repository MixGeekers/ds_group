// Loaded only by the acceptance harness, never the product profile.
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startNativeTeam } from '../dsh-connect/native-team.mjs';
import { NativeBots } from '../dsh-connect/native-bots.mjs';
import { NativeBridge } from '../dsh-connect/native-bridge.mjs';
import {MODEL,testModelSelection} from './memory-test-model.mjs';

export const inject = ['llm','tools','systemPrompt','sessionController','sessions','sessionTitle','workspaceRegistry','connection'];
export async function apply(ctx, config) {
  const directory = config.directory;
  let scenario;
  try { scenario=JSON.parse(await readFile(join(directory,'scenario-profile.json'),'utf8')); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  const rt = await startNativeTeam(ctx, { mainName: '识雨', workspace: config.workspace,
    ...(scenario ? {} : { memoryReviewDelayMs: 50 }) });
  const native = new NativeBots(ctx), bridges = new Map();
  let eventWrites = Promise.resolve();
  const log = (filename, entry) => { eventWrites = eventWrites.catch(() => {}).then(() => appendFile(join(directory, filename), JSON.stringify(entry) + '\n')); return eventWrites; };
  ctx.on('session/event', (session, event) => log('events.jsonl', { sessionId: session.id, ...event }));
  ctx.on('llm/stream', async function* (options, next) {
    const model = `${options.provider}/${options.model}`;
    if (model !== MODEL) throw new Error(`TEST_MODEL_MISMATCH:${model}`);
    const record = { callId: randomUUID(), model, sessionId: options.sessionId, purpose: options.purpose || 'generation', startedAt: Date.now(),
      maxTokens: options.maxTokens, reasoningEffort: options.reasoningEffort };
    await log('calls.jsonl', { ...record, event: 'start' });
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') record.usage = chunk.usage;
        if (chunk.type === 'error') record.failure = chunk.error || chunk.failure || { kind: 'error' };
        if (chunk.type === 'finish') record.finish = chunk.reason;
        yield chunk;
      }
      record.status = record.failure || record.finish?.kind === 'error' ? 'failed' : record.finish?.kind === 'max-tokens' ? 'truncated' : 'completed';
    } catch (error) { record.status = 'failed'; record.error = error.message; throw error; }
    finally { await log('calls.jsonl', { ...record, event: 'end', finishedAt: Date.now() }); }
  });
  async function bind(id, index) {
    const bot = await native.bot(id);
    await native.selectModel(id, await testModelSelection(ctx.llm));
    await rt.setPermission(rt.botOf(id), 'danger-full-access');
    const bridge = await new NativeBridge({ ctx, native, node: { id: `@bot${index}:memory.test`, name: bot.name, nativeBotId: id,
      directory: join(directory, `bridge-${index}`) }, timeoutMs: 300000 }).initialize();
    bridges.set(index, bridge);
    return bridge.createBot({ botId: `@bot${index}:memory.test` });
  }
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/memory-test', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    try {
      const { action, input = {} } = await request.json(); let value;
      if (action === 'state') value = await native.state();
      else if (action === 'init') {
        let state = await native.state();
        for (const bot of state.bots) await (await native.agent(bot.sessionId)).whenIdle();
        for (const name of ['识雨', '知秋', '听澜']) if (!state.bots.some(bot => bot.name === name)) {
          await native.call('create-bot', { name, role: '协作助手', model: MODEL, main: name === '识雨', greet: false,
            instructions: scenario?.instructions || '用简体中文完成协作；记忆保留完整账号与来源；需要历史事实时调用 recall。' });
          state = await native.state();
          await (await native.agent(state.bots.find(bot => bot.name === name).sessionId)).whenIdle();
        }
        value = [];
        for (const [index, bot] of state.bots.entries()) {
          if(scenario)await native.call('update-bot',{id:bot.id,instructions:scenario.instructions});
          value.push(await bind(bot.id, index));
        }
        for (const bot of state.bots) await (await native.agent((await native.bot(bot.id)).sessionId)).whenIdle();
      } else if (action === 'turn') {
        const bridge = bridges.get(input.index || 0);
        const record = await bridge.turn(input.request);
        await new Promise(resolve => setTimeout(resolve, 150));
        let reviewError;
        try { await rt.memoryFlush(bridge.node.nativeBotId); } catch (error) { reviewError = error.message; }
        value = { record, reviewError, diagnostics: rt.knowledge.errors.slice(-5) };
      } else if (action === 'compact') {
        const id = bridges.get(input.index || 0).node.nativeBotId;
        await rt.memoryFlush(id); value = { compacted: await rt.checkpointBot(id), bot: await native.bot(id) };
      } else if (action === 'memory') value = { entries: rt.knowledge.store.list({ botId: input.botId, history: true }),
        sources: rt.knowledge.store.sources(),
        contacts: rt.knowledge.store.contacts(), errors: rt.knowledge.errors, usage: rt.knowledge.backend?.usage,
        pending: (await native.state()).bots.map(bot => ({ botId: bot.id, refs: rt.knowledge.store.getMeta(`unreviewed:${bot.id}`) || [] })) };
      else if (action === 'forget') value = rt.knowledge.forget(bridges.get(input.index || 0).node.nativeBotId, input.args);
      else if (action === 'flush') { for (const bot of (await native.state()).bots) await rt.memoryFlush(bot.id); value = true; }
      else if (action === 'detach') { await bridges.get(input.index || 0).detach(); value = true; }
      else if (action === 'local') {
        const bridge = bridges.get(input.index || 0), bot = await native.bot(bridge.node.nativeBotId);
        let seen = false, reply = '', end;
        const done = new Promise(resolve => { end = resolve; });
        const dispose = ctx.on('session/event', (session, event) => {
          if (session.id !== bot.sessionId) return;
          const message = event.data?.message || event.data;
          const text = (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
          if (event.type === 'user/message' && text === input.text) seen = true;
          if (seen && event.type === 'assistant/message' && text) reply = text;
          if (seen && event.type === 'turn/end') end(event.data.reason);
        });
        try {
          await native.call('send', { sessionId: bot.id, text: input.text });
          const reason = await Promise.race([done, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('LOCAL_TIMEOUT')), 180000); timer.unref(); })]);
          await rt.memoryFlush(bot.id); value = { text: reply, reason, bot: await native.bot(bot.id) };
        } finally { dispose(); }
      } else throw new Error('Unknown test action');
      await eventWrites; return Response.json({ ok: true, value });
    } catch (error) { return Response.json({ ok: false, error: { message: error.message, stack: error.stack } }); }
  } }));
}
