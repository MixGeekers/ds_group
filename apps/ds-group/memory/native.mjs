import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { join, basename } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { MemoryService } from './service.mjs';
import { sha, sourceId } from './store.mjs';
import { createMemoryPanel } from './panel.mjs';
import { prepareReviewProposal } from './review.mjs';
import { isModelQuotaFailure } from '../src/model-failure.mjs';

const textOf = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const RULES = `# Source-aware memory
You are the same native Bot in every conversation. remember/recall/forget and contacts use one persistent store.
Full account IDs identify people. Equal display names do not imply the same person. Keep subject, original author, relayer and Bot interpretation separate.
The per-step speakerFacts are current source-backed claims about this exact speaker, not a new message. Apply relevant language and report-format preferences without requiring the person to repeat them; keep scope, uncertainty and conflicting claims visible. Casual conversation does not automatically require a work plan.
Room decisions apply to that room/project. Recall returns exact source references, validity and unresolved conflicting claims. Never present a reported claim or inference as the person's own statement.
Separate confirmed decisions, proposals and unknowns when revising plans or files. A change to one field does not confirm changes to other fields. Your earlier drafts, summaries and generated files are derived work, not independent confirmation about the real world; reconcile them against the person's later corrections before reusing them.
When asked to remember, call remember before saying it is saved. Automatic review also keeps durable facts. Use recall before answering from old memories, especially after compaction, corrections or restart. When the current user explicitly requests recall or a fresh history/status check, call recall in this turn even if an identical question was recently answered. A previous turn’s result is not a fresh lookup for a new request. For another room use scope room:<ID>, or all and name the source room in your answer. Expired, withdrawn and superseded facts are historical only.
Use replaceId from recall for corrections to one fact. Distinct concurrent claims remain visible until resolved. Deduplicate relays by original evidence; repetition is not corroboration. Contacts are identity records; claims and opinions belong to the Bot that learned them.
Tools and native tasks continue normally. Memory summaries are pointers to records, not a second editable fact store.`;
const REVIEW = `Maintain this Bot's durable source-aware memories. Return ONLY JSON {"changes":[...]} (empty if nothing durable).
Read source bodies as statements by their authorId, NOT by one universal user. Each change: {op:"add"|"replace"|"forget",text,subjectId,predicate,kind:"stated"|"reported"|"observation"|"inference",saidBy,sourceIds:[exact source id],scope:"own"|"team"|"room:<exact room ID>",replaceId?,validUntil?}.
Use exact identity IDs from the input; for project facts use the room identity or an explicitly named project. Use short stable predicates for one attribute. Save durable facts, decisions, preferences, assignments and corrections. Skip transient chatter, questions, test instructions and mere acknowledgements.
Direct statements are stated; quotes/relays are reported with saidBy identifying who actually said it, and subjectId who it concerns. Bot interpretations are inference. Tool results are observation from tool:<name>, never statements by the human who requested the task. Save a tool result only when it is durable task evidence the user asked to keep. A Bot relay is never a new direct human statement. Keep originRefs and source IDs; never count repeats as independent evidence.
Default scope to the source room, own for native personal chat. Stable personal communication preferences stated as usual/general behavior belong in own unless the person limits them to a room or task; a one-time request or mood is not a permanent preference. Use team only when explicitly shared team-wide. Different room values can coexist.
Human statements seen in room history keep their own author and event. Saving or reading a generated draft only proves the file operation; it does not confirm the draft's venue details, decisions or proposals. Classify unsupported derived claims as inference, and retain explicit unknowns/corrections instead of reviving an earlier draft's unsupported assertion.
For explicit correction use replaceId of the old memory (same subject and scope). Do not rewrite an entry merely to polish its language. To repair subject metadata on an otherwise identical fact, keep the exact text and exact original sourceIds and set reclassify:true. A different speaker's conflicting statement is a new claim, not silent replacement. For deletion use forget and replaceId, citing the current correction in sourceIds. Every operation requires exact sourceIds from the current sources array, including forget; the old memory's evidence is not the source of its cancellation. Resolve dates only when stated, using source timestamp; validUntil is epoch milliseconds. Otherwise omit it.
Preserve the user's language, one self-contained fact per entry. Do not duplicate an existing same fact with the same evidence. Never copy an entire source envelope or invent missing evidence.`;

export function installNativeMemory(rt) {
  const { ctx, config, home } = rt;
  const root = join(home, 'knowledge');
  const file = join(root, 'backend.json');
  const env = process.env;
  const configured = config.knowledgeBackend || (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined)
    || (env.DSCORD_MEMORY_PYTHON && env.DSCORD_MEMORY_OMBRE ? { python: env.DSCORD_MEMORY_PYTHON, upstream: env.DSCORD_MEMORY_OMBRE,
      endpoint: env.DSCORD_MEMORY_ENDPOINT, serverBinary: env.DSCORD_MEMORY_LLAMA_SERVER, modelArtifact: env.DSCORD_MEMORY_GGUF } : undefined);
  const memory = new MemoryService({ directory: root, backend: configured, clock: config.memoryClock });
  const store = memory.store, news = new Map(), timers = new Map(), reviewing = new Map();
  let reviewChain = Promise.resolve();
  let disposed = false;
  const caller = exec => rt.selfOf(exec.agent?.id);
  const stringify = value => JSON.stringify(value);
  const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] };
  const string = description => ({ type: 'string', description });
  const params = {
    text: { ...string('One self-contained durable fact in the speaker’s language'), required: true },
    subjectId: string('Full identity ID of whom/what the fact concerns, as shown by contacts or source context'),
    predicate: string('Stable attribute such as report-language, release-window, member-of or role'),
    kind: string('stated, reported, observation or inference'), saidBy: string('Full original speaker identity ID for a quoted/reported statement'),
    sourceIds: { type: 'array', items: { type: 'string' }, description: 'Source IDs from current context/recall, or unambiguous original event IDs such as $event in the current room; defaults to current message' },
    scope: string('group (current room), own, team or room:<full room ID>'), topic: string('Optional topic'),
    replaceId: string('Exact existing memory ID to correct, from recall'), replace: string('Legacy unique text match to replace'),
    reclassify: { type: 'boolean', description: 'Repair subject metadata only; requires identical original text and source IDs' },
    expectedRevision: { type: 'number', description: 'Revision read before replacing' },
    validFrom: { type: 'number', description: 'Optional UTC epoch milliseconds when fact begins to apply' },
    validUntil: { type: 'number', description: 'Optional UTC epoch milliseconds when fact expires' },
  };
  rt.teamTools.push(defineTool({ name: 'remember', description: 'Save or correct one source-attributed fact in your persistent memory; returns the stored record and sources.', parameters: params, output,
    async execute(args, exec) { const id = caller(exec); const result = await memory.remember(id, args, memory.current(id, exec.agent?.id) || null); news.set(id, Date.now()); return stringify(result); } }));
  rt.teamTools.push(defineTool({ name: 'recall', description: 'Search durable memories semantically with exact source readback. Scope defaults to own/team/current room. Use all for other rooms, history to inspect withdrawn/expired records.',
    parameters: { query: string('Natural-language search'), scope: string('own, team, group, room:<ID> or all'), topic: string('Topic'), subjectId: string('Exact identity to filter'),
      history: { type: 'boolean', description: 'Include old records with explicit status, never treat these as current facts' }, limit: { type: 'number', description: 'Maximum records (1–30)' } }, output,
    async execute(args, exec) { const id = caller(exec); return stringify(await memory.recall(id, args, memory.current(id, exec.agent?.id) || null)); } }));
  rt.teamTools.push(defineTool({ name: 'forget', description: 'Withdraw one memory by its exact ID or unique text; history is retained and current recall excludes it.',
    parameters: { id: string('Memory ID'), entry: string('Legacy unique text match'), scope: string('Current room by default; own, team, all or room:<ID>'), expectedRevision: { type: 'number' } }, output,
    async execute(args, exec) { const id = caller(exec); const result = memory.forget(id, args, memory.current(id, exec.agent?.id) || null); news.set(id, Date.now()); return stringify(result); } }));
  rt.teamTools.push(defineTool({ name: 'contacts', description: 'Find stable people/Bot/group identities and historical display names. Equal names stay separate accounts.',
    parameters: { query: string('Full account ID or display-name fragment; omit to list') }, output,
    async execute(args) { return stringify(store.contacts(args.query)); } }));

  async function oneShot(bot, system, text, tag = {}) {
    const reference = await rt.desiredModel(bot) ?? await rt.defaultModel();
    const slash = reference?.indexOf('/'); if (!(slash > 0)) throw new Error('MEMORY_MODEL_UNAVAILABLE');
    const messages = [{ role: 'user', content: [{ type: 'text', text }] }];
    rt.tagUsage?.(messages, { sessionId: tag.sessionId || rt.chatOf(bot.id), kind: 'memory' });
    const assembled = new BlockAssembler();
    for await (const chunk of ctx.llm.stream({ provider: reference.slice(0, slash), model: reference.slice(slash + 1),
      sessionId: tag.sessionId || rt.chatOf(bot.id), purpose: 'memory', system, messages, maxTokens: 8192,
      reasoningEffort: 'low', signal: AbortSignal.timeout(120000) })) assembled.push(chunk);
    if (['error', 'aborted', 'max-tokens'].includes(assembled.finish.kind)) throw Object.assign(new Error(`MEMORY_MODEL_${assembled.finish.kind}: ${assembled.finish.failure?.code || ''} ${assembled.finish.failure?.message || ''}`), { code: assembled.finish.failure?.code });
    const reply = assembled.blocks().filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (!reply.trim()) throw new Error('MEMORY_MODEL_EMPTY'); return reply;
  }
  async function botShot(bot, system, text, tag = {}) {
    const delays = config.memoryRetryDelaysMs || [2000, 5000, 10000];
    for (let attempt = 0; ; attempt++) {
      try { return await oneShot(bot, system, text, tag); }
      catch (error) {
        memory.errors.push({ operation: 'model', botId: bot.id, attempt: attempt + 1, error: error.message, at: Date.now() });
        if (disposed || attempt >= delays.length || !['RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'SERVER_ERROR', 'OVERLOADED'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      }
    }
  }
  async function review(botId) {
    const refs = (store.getMeta(`unreviewed:${botId}`) || []).slice(0, 8);
    if (!refs.length || disposed) return;
    const bot = rt.botOf(botId); if (!bot) return;
    await (await rt.resolveAgent(rt.chatOf(botId))).whenIdle();
    const sources = refs.map(ref => store.source(ref.id, ref.revision)).filter(Boolean).map(source =>
      source.authorKind === 'tool' && source.body.length > 6000 ? { ...source, body: source.body.slice(0, 6000), truncated: true } : source);
    const relevant = new Map(store.list({ botId, history: true }).filter(row => row.status === 'active').slice(-40).map(row => [row.id, row]));
    for (const source of sources) {
      if (!source.body.trim()) continue;
      const matches = await memory.recall(botId, { query: source.body.slice(0, 1800), limit: 10 },
        { scope: source.roomId ? `room:${source.roomId}` : 'own' });
      for (const row of matches.entries) relevant.set(row.id, store.get(row.id));
    }
    const known = [...relevant.values()].map(row => ({
      id: row.id, text: row.text, subjectId: row.subjectId, predicate: row.predicate, scope: row.scope, kind: row.kind, saidBy: row.saidBy, sourceRefs: row.sourceRefs,
    }));
    const changes = await prepareReviewProposal({ input: { botId, contacts: store.contacts(), sources, existingMemories: known },
      generate: input => botShot(bot, REVIEW, stringify(input)),
      onProposal: (result, attempt) => store.log('review-proposal', { botId, sourceRefs: refs, changes: result.changes, attempt }),
      onInvalid: (error, attempt) => { memory.errors.push({ operation: 'review-validation', botId, attempt, error: error.message, at: Date.now() });
        store.log('review-validation-error', { botId, sourceRefs: refs, attempt, error: error.message }); } });
    for (const change of changes) {
      const source = sources.find(source => source.id === change.sourceIds[0]);
      const context = { botId, scope: source.roomId ? `room:${source.roomId}` : 'own', authorId: source.authorId,
        sourceRefs: [{ id: source.id, revision: source.revision }] };
      if (change.op === 'forget') {
        const old = store.get(change.replaceId);
        if (old?.status === 'active') memory.forget(botId, { id: old.id, scope: old.scope }, context);
      } else {
        const previous = change.op === 'replace' ? store.get(change.replaceId) : undefined;
        await memory.remember(botId, { ...change,
          ...(previous && previous.text === change.text ? { reclassify: true } : {}),
          ...(change.op === 'add' ? { replaceId: undefined } : {}) }, context);
      }
      news.set(botId, Date.now());
    }
    // Advance only after all parsed changes are durable. A failed batch remains retryable.
    for (const ref of refs) store.setMeta(`reviewed:${botId}:${ref.id}:${ref.revision}`, true);
    store.setMeta(`unreviewed:${botId}`, (store.getMeta(`unreviewed:${botId}`) || []).filter(ref => !refs.some(old => old.id === ref.id && old.revision === ref.revision)));
    store.log('review', { botId, sourceRefs: refs, changes: changes.length });
  }
  function flush(botId) {
    if (!rt.botOf(botId)) return Promise.reject(new Error('MEMORY_BOT_NOT_FOUND'));
    clearTimeout(timers.get(botId)); timers.delete(botId);
    if (reviewing.has(botId)) return reviewing.get(botId);
    const work = reviewChain.catch(() => {}).then(async () => { while (!disposed && rt.botOf(botId) && (store.getMeta(`unreviewed:${botId}`) || []).length) await review(botId); });
    reviewChain = work;
    reviewing.set(botId, work);
    work.finally(() => reviewing.delete(botId)).catch(() => {}); return work;
  }
  function schedule(botId) {
    if (config.memoryReview === false || disposed) return;
    clearTimeout(timers.get(botId));
    const timer = setTimeout(() => { timers.delete(botId); void flush(botId).catch(error => {
      memory.errors.push({ operation: 'review', botId, error: error.message, at: Date.now() }); rt.warn('ds-bot: source memory review failed: %s', error.message);
      if (!disposed && !isModelQuotaFailure(error)) {
        const retry = setTimeout(() => { timers.delete(botId); schedule(botId); }, 60000);
        retry.unref?.(); timers.set(botId, retry);
      }
    }); }, config.memoryReviewDelayMs ?? 2000); timer.unref?.(); timers.set(botId, timer);
  }
  ctx.on('session/event', (session, event) => {
    const botId = rt.selfOf(session.id); if (!rt.botOf(botId)) return;
    if (event.type === 'tool/call') { store.setMeta(`tool:${session.id}:${event.data.callId}`, event.data.name); return; }
    if (event.type === 'tool/result') {
      const result = event.data?.message, name = store.getMeta(`tool:${session.id}:${result?.toolCallId}`);
      if (name && !['remember', 'recall', 'forget', 'contacts'].includes(name) && !result.isError) memory.observeTool(botId,
        { sessionId: session.id, callId: result.toolCallId, name, body: textOf(result), timestamp: event.time });
      return;
    }
    if (event.type !== 'user/message') return;
    const message = event.data?.message || event.data, text = textOf(message), nativeSource = message.source || {};
    // DSH also writes runtime snapshots, instructions, skill catalogues and
    // compaction notes as user/message events. They are not new human statements.
    if (!['user', 'bot', 'user-question-reply'].includes(nativeSource.kind)) return;
    if (nativeSource.handoff || ['goal', 'kickoff', 'resume'].includes(nativeSource.role)) return;
    const held = store.getMeta(`ingress:${sha(text)}`);
    if (held) { memory.ingest(botId, held, { sessionId: session.id }); return; }
    // Native chat and native Bot delegation remain usable without any DSCord connection.
    const sender = nativeSource.kind === 'bot' && nativeSource.senderSessionId ? { id: nativeSource.senderSessionId, name: nativeSource.senderName, kind: 'bot' }
      : { id: `user-${sha(home).slice(0, 16)}`, name: 'Local user', kind: 'human' };
    const roomId = nativeSource.memoryOrigin?.roomId || rt.groupOwners.get(session.id)?.roomId || nativeSource.roomId;
    memory.ingest(botId, { event: { eventId: `${session.id}:${event.seq ?? event.sequence ?? sha(text)}`, roomId, sender: sender.id, body: text },
      context: { source: { transport: 'native', sender, roomId,
        timestamp: event.time || Date.now(), originRefs: nativeSource.memoryOrigin?.sourceRefs || [],
        relay: nativeSource.kind === 'bot' ? { exchangeId: nativeSource.exchangeId, replyTo: nativeSource.replyTo } : null } } }, { sessionId: session.id });
  });
  ctx.on('agent/status', ({ agent, status }) => {
    const id = rt.selfOf(agent?.id); if (!rt.botOf(id)) return;
    if (status === 'idle') schedule(id);
    else { clearTimeout(timers.get(id)); timers.delete(id); }
  });
  // Native prompt sections may be cached for an entire part. The current room and
  // source must follow every turn even when one Session alternates many rooms.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next();
    const id = rt.selfOf(agent.id);
    if (!rt.botOf(id) || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision;
    const snapshot = memory.contextSnapshot(id, agent.id); if (!snapshot) return decision;
    const message = createUserMessage({ source: { kind: 'knowledge-context', form: 'snapshot' },
      content: [{ type: 'text', text: `Current memory source context (metadata and attributed claims, not a new speaker). Use these exact source IDs for remember; omitted sourceIds defaults to the current message. For tool observations use toolSources. speakerFacts concern only the identified current speaker; use relevant preferences with their source and scope. Recall memoryPointers for other current facts.\n${stringify(snapshot)}` }] });
    return { ...decision, messages: [...decision.messages.filter(item => item.source?.kind !== 'knowledge-context'), message] };
  });
  ctx.effect(() => ctx.systemPrompt.section({ name: 'bot-memory', order: 645, interpolate: false, text: context => {
    const id = rt.selfOf(context?.agent?.id); if (!rt.botOf(id)) return '';
    // Keep the prefix stable when remember/forget change state. Dynamic context
    // belongs in the per-step snapshot; putting it here invalidates the full cache.
    return RULES;
  } }), 'ds-bot: source-aware memory section');

  const memoryEndpoint = createMemoryPanel(rt, memory, { flush, botShot });
  // Import legacy Markdown once, preserving exact source text and leaving the original files untouched.
  async function migrateLegacy(parseMemory) {
    if (!parseMemory) return;
    const bots = Object.values(rt.state.bots);
    const targets = bots.map(bot => ({ botId: bot.id, scope: 'own', directory: join(home, 'memory/bots', bot.id) }));
    if (bots[0]) targets.push({ botId: bots[0].id, scope: 'team', directory: join(home, 'memory/team') });
    for (const room of Object.values(rt.state.rooms)) {
      const safe = /^[\w-]{1,128}$/.test(room.id) ? room.id : sha(room.id).slice(0, 32);
      for (const botId of room.members || []) targets.push({ botId, scope: `room:${room.id}`, directory: join(home, 'memory/groups', safe) });
    }
    for (const { botId, scope, directory } of targets) {
      const key = `legacy:${botId}:${scope}`;
      if (!existsSync(directory) || store.getMeta(key)) continue;
      for (const filename of readdirSync(directory).filter(name => name.endsWith('.md'))) {
        const content = readFileSync(join(directory, filename), 'utf8');
        const entries = parseMemory(content).entries;
        for (const entry of entries) {
          const source = store.observe({ id: sourceId('legacy', directory, `${filename}:${entry.line}`), body: entry.text,
            authorId: scope === 'own' ? `native:${botId}` : `legacy:${scope}`, authorKind: 'bot', timestamp: Date.now(), legacyMetadata: entry.meta });
          await memory.remember(botId, { text: entry.text, scope, subjectId: `native:${botId}`, kind: 'legacy',
            topic: filename === 'MEMORY.md' ? null : basename(filename, '.md'), sourceRefs: [{ id: source.id, revision: 1 }] },
          { botId, scope, authorId: source.authorId, sourceRefs: [{ id: source.id, revision: 1 }] });
        }
      }
      store.setMeta(key, true);
    }
  }
  Object.assign(rt, { knowledge: memory, memoryEnabled: true, memoryBackend: 'source-aware-v1', botShot,
    memoryIngress: (_sessionId, text, input) => { if (input) store.setMeta(`ingress:${sha(text)}`, input); },
    memoryRelay: (botId, sessionId) => { const current = memory.current(botId, sessionId || rt.chatOf(botId)); return current ? { memoryOrigin: current } : {}; },
    memoryCarry: (botId, before, after) => memory.carry(botId, before, after),
    memoryFlush: flush, memoryMigrate: migrateLegacy, memoryEndpoint, renewMemory: () => {},
    archiveBotMemory: async () => {}, archiveGroupMemory: async () => {}, memoryNews: () => Object.fromEntries(news), memoryReviews: () => timers.size + reviewing.size });
  ctx.effect(() => () => {
    disposed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear();
    return Promise.allSettled([...reviewing.values()]).then(() => memory.close());
  }, 'ds-bot: source-aware memory lifecycle');
}
