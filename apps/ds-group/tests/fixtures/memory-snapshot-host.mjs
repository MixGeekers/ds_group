// Loaded only by the isolated, localhost scripted-provider regression.
import { createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { startNativeTeam } from '../../dsh-connect/native-team.mjs';
export { inject } from '../../dsh-plugin/index.mjs';

const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function apply(ctx, config) {
  const rt = await startNativeTeam(ctx, { home: config.botHome, workspace: config.workspace, memoryReview: false });
  async function inspect(botId) {
    const agent = await rt.resolveAgent(rt.chatOf(botId));
    await agent.whenIdle(); await ctx.sessions.flush(agent.session);
    const throughSeq = agent.session.seq - 1, records = [];
    let beforeSeq;
    do {
      const page = await ctx.sessionController.events({ address: { kind: 'session', sessionId: agent.id }, throughSeq,
        maxMessages: 1000, ...(beforeSeq === undefined ? {} : { beforeSeq }) }, AbortSignal.timeout(30000));
      records.unshift(...page.records);
      if (!page.hasMore) break;
      const seqs = page.records.map(record => record.event.seq);
      if (seqs.length === 0) throw new Error('Native event history did not advance');
      beforeSeq = Math.min(...seqs);
    } while (true);
    const raw = records.map(record => record.event), derived = agent.session.deriveMessages();
    const snapshots = raw.filter(event => event.type === 'user/message' && event.data.source?.kind === 'knowledge-context');
    return { sessionId: agent.id, seq: agent.session.seq, derived, contextTokens: ctx.get('tokenMeter').measure(agent.session).totalTokens,
      lastTurnEnd: raw.findLast(event => event.type === 'turn/end')?.data,
      activeSnapshots: derived.filter(message => message.source?.kind === 'knowledge-context').map(message => ({ id: message.id, text: textOf(message) })),
      rawSnapshots: snapshots.map(event => ({ seq: event.seq, id: event.data.id, hash: hash(event), textLength: textOf(event.data).length })),
      rawKinds: raw.map(event => ({ seq: event.seq, type: event.type, sourceKind: (event.data.message ?? event.data).source?.kind })),
      retired: raw.filter(event => event.type === 'user/message' && event.data.source?.kind === 'knowledge-context-retired')
        .map(event => ({ seq: event.seq, sourceEventSeqs: event.sourceEventSeqs, surfaceOp: event.surfaceOp })),
      humanMessages: raw.filter(event => event.type === 'user/message' && event.data.source?.kind === 'user').map(event => ({ id: event.data.id, text: textOf(event.data), source: event.data.source })),
      toolResults: raw.filter(event => event.type === 'tool/result').map(event => ({ seq: event.seq, text: textOf(event.data.message), callId: event.data.message.toolCallId })),
      botMessages: raw.filter(event => event.type === 'user/message' && event.data.source?.kind === 'bot').map(event => ({ id: event.data.id, text: textOf(event.data), source: event.data.source })),
    };
  }
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/memory-snapshot-test', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    try {
      const { action, ...input } = await request.json();
      let value;
      if (action === 'init') {
        const create = name => rt.createBot({ name, role: 'Snapshot regression', model: 'snapshot-fixture/chat', main: name === 'Snapshot Bot',
          owner: { id: '@owner:snapshot.local', kind: 'human' }, workDir: config.workspace, greet: false });
        const bots = Object.values(rt.state.bots);
        value = { bot: bots.find(bot => bot.name === 'Snapshot Bot') ?? await create('Snapshot Bot'),
          peer: bots.find(bot => bot.name === 'Snapshot Peer') ?? await create('Snapshot Peer') };
      } else if (action === 'turn') {
        const timestamp = Date.now();
        const sender = { id: input.senderId, name: input.senderName ?? input.senderId, kind: 'human' };
        const source = { transport: 'matrix', sender, eventId: `$${input.requestId}`, roomId: input.roomId, requestId: input.requestId, timestamp };
        await rt.sendUser({ sessionId: input.botId, requestId: input.requestId, content: [{ type: 'text', text: input.text }], source,
          memoryContext: { event: { eventId: source.eventId, roomId: source.roomId, sender: sender.id, body: input.text, timestamp }, context: { source } } });
        value = await inspect(input.botId);
        if (value.lastTurnEnd?.reason?.kind !== 'completed') throw new Error(`Native turn did not complete: ${JSON.stringify(value.lastTurnEnd)}`);
      } else if (action === 'relay') {
        await rt.deliver({ fromId: input.peerId, toId: input.botId, text: input.text, role: 'message' });
        value = await inspect(input.botId);
        if (value.lastTurnEnd?.reason?.kind !== 'completed') throw new Error(`Native relay did not complete: ${JSON.stringify(value.lastTurnEnd)}`);
      } else if (action === 'seed') {
        const agent = await rt.resolveAgent(rt.chatOf(input.botId)); await agent.whenIdle();
        for (let n = 0; n < input.count; n++) agent.session.append('user/message', createUserMessage({
          source: { kind: 'knowledge-context', form: 'snapshot' }, content: [{ type: 'text', text: `Seed snapshot ${n}: ${'x'.repeat(input.chars ?? 9000)}` }],
        }), { surfaceOp: 'append' });
        value = await inspect(input.botId);
      } else if (action === 'pressure') {
        const agent = await rt.resolveAgent(rt.chatOf(input.botId)); await agent.whenIdle();
        for (const text of ['Synthetic background pressure: ' + 'x'.repeat(400000), 'Small complete background tail.']) {
          agent.session.append('user/message', createUserMessage({ source: { kind: 'background-context', input: 'context' },
            content: [{ type: 'text', text }] }), { surfaceOp: 'append' });
        }
        value = await inspect(input.botId);
      } else if (action === 'held-part') {
        const previousSessionId = rt.chatOf(input.botId), timestamp = Date.now();
        const sender = { id: '@bob:snapshot.local', name: 'Bob', kind: 'human' };
        const source = { kind: 'user', transport: 'matrix', eventId: '$held-across-parts', roomId: '!south:snapshot.local', sender, requestId: 'held-across-parts', timestamp };
        const wrapped = 'DSCORD_REQUEST synthetic routing envelope; not the original Matrix body.';
        rt.memoryIngress(previousSessionId, wrapped, { event: { eventId: source.eventId, roomId: source.roomId, sender: sender.id,
          body: 'Exact original Matrix body held across native parts.', timestamp }, context: { source } });
        await rt.newPart(previousSessionId);
        for (let n = 0; n < 200 && (rt.chatOf(input.botId) === previousSessionId || [...rt.switchJobs()].length > 0); n++) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (rt.chatOf(input.botId) === previousSessionId) throw new Error('The explicit native part did not switch');
        const agent = await rt.resolveAgent(rt.chatOf(input.botId));
        agent.followup(createUserMessage({ source, content: [{ type: 'text', text: wrapped }] }));
        value = { previousSessionId, ...await inspect(input.botId) };
        if (value.lastTurnEnd?.reason?.kind !== 'completed') throw new Error(`Transferred native turn did not complete: ${JSON.stringify(value.lastTurnEnd)}`);
      } else if (action === 'checkpoint') {
        const result = await rt.checkpointBot(input.botId);
        value = { checkpointed: result, ...await inspect(input.botId) };
      } else if (action === 'inspect') value = await inspect(input.botId);
      else throw new Error(`Unknown snapshot test action ${action}`);
      return Response.json({ ok: true, value });
    } catch (error) { return Response.json({ ok: false, error: error.stack ?? String(error) }, { status: 500 }); }
  } }), 'snapshot test route');
}
