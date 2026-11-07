import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { join, basename } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { MemoryService } from './service.mjs';
import { sha, sourceId } from './store.mjs';
import { createMemoryPanel } from './panel.mjs';
import { generateReviewWithBudget, prepareReviewBatch, prepareReviewProposal } from './review.mjs';
import { isModelQuotaFailure } from '../src/model-failure.mjs';
import { memoryModelOptions } from './model-options.mjs';
import { contactReadView } from './contacts.mjs';
import { nativeMemoryInput, automaticReviewAllowed } from './ingress.mjs';

const textOf = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const RULES = `# Source-aware memory
You are the same native Bot in every conversation. remember/recall/forget and contacts use one persistent store.
Full account IDs identify people. Equal display names do not imply the same person. Keep subject, original author, relayer and Bot interpretation separate.
The per-step currentClaims/speakerFacts are current source-backed claims, not a new message. Apply relevant language and report-format preferences without requiring the person to repeat them; keep scope, uncertainty and conflicting claims visible. Casual conversation does not automatically require a work plan.
Read recentSources for newer human corrections not yet organized into memory, and changes for invalidated evidence or derived drafts that require review. A later Bot file/readback does not independently confirm its contents or override a human correction. claimState distinguishes statement, proposal, confirmed and uncertain; inference stays an inference even if repeated. The view records what this Bot has observed, not what every room member knows, wants or privately believes. Use review_memory for bounded on-demand review of a person/project or repeated error, and memory_source to inspect exact original evidence. Neither tool proves task completion or successful delivery; use runtime receipts for those.
Room decisions apply to that room/project. Recall returns exact source references, validity and unresolved conflicting claims. Never present a reported claim or inference as the person's own statement.
Separate confirmed decisions, proposals and unknowns when revising plans or files. A change to one field does not confirm changes to other fields. Your earlier drafts, summaries and generated files are derived work, not independent confirmation about the real world; reconcile them against the person's later corrections before reusing them.
When asked to remember, call remember before saying it is saved. Automatic review also keeps durable facts. Use recall before answering from old memories, especially after compaction, corrections or restart. When the current user explicitly requests recall or a fresh history/status check, call recall in this turn even if an identical question was recently answered. A previous turn’s result is not a fresh lookup for a new request. For another room use scope room:<ID>, or all and name the source room in your answer. Expired, withdrawn and superseded facts are historical only.
Use replaceId from recall for corrections to one fact. Distinct concurrent claims remain visible until resolved. Deduplicate relays by original evidence; repetition is not corroboration. Contacts are identity records; claims and opinions belong to the Bot that learned them.
Tools and native tasks continue normally. Memory summaries are pointers to records, not a second editable fact store.`;
const REVIEW = `Maintain this Bot's durable source-aware memories. Return ONLY JSON {"changes":[...]} (empty if nothing durable).
Read source bodies as statements by their authorId, NOT by one universal user. Each change: {op:"add"|"replace"|"forget",text,subjectId,predicate,kind:"stated"|"reported"|"observation"|"inference",saidBy,sourceIds:[exact source id],scope:"own"|"team"|"room:<exact room ID>",replaceId?,validUntil?,claimState?:"statement"|"proposal"|"confirmed"|"uncertain",facets?:["preference"|"decision"|"relationship"|"question"|"commitment"|"experience"],entityIds?:[exact person IDs],projectIds?:[exact project IDs],basisRefs?:[{id:existing memory ID,revision:exact revision}]}.
Use exact identity IDs from the input; for project facts use the room identity or an explicitly named project. Use short stable predicates for one attribute. Save durable facts, decisions, preferences, assignments and corrections. Skip transient chatter, questions, test instructions and mere acknowledgements.
Direct statements are stated; quotes/relays are reported with saidBy identifying who actually said it, and subjectId who it concerns. Bot interpretations are inference. Tool results are observation from tool:<name>, never statements by the human who requested the task. Save a tool result only when it is durable task evidence the user asked to keep. A Bot relay is never a new direct human statement. Keep originRefs and source IDs; never count repeats as independent evidence.
Default scope to the source room, own for native personal chat. Stable personal communication preferences stated as usual/general behavior belong in own unless the person limits them to a room or task; a one-time request or mood is not a permanent preference. Use team only when explicitly shared team-wide. Different room values can coexist.
Human statements seen in room history keep their own author and event. Saving or reading a generated draft only proves the file operation; it does not confirm the draft's venue details, decisions or proposals. Classify unsupported derived claims as inference, and retain explicit unknowns/corrections instead of reviving an earlier draft's unsupported assertion.
For explicit correction use replaceId of the old memory (same subject and scope). Do not rewrite an entry merely to polish its language. To repair subject metadata on an otherwise identical fact, keep the exact text and exact original sourceIds and set reclassify:true. A different speaker's conflicting statement is a new claim, not silent replacement. For deletion use forget and replaceId, citing the current correction in sourceIds. Every operation requires exact sourceIds from the current sources array, including forget; the old memory's evidence is not the source of its cancellation. Resolve dates only when stated, using source timestamp; validUntil is epoch milliseconds. Otherwise omit it.
Preserve the user's language, one self-contained fact per entry. Do not duplicate an existing same fact with the same evidence. Never copy an entire source envelope or invent missing evidence. Do not infer unexpressed emotions, motives, private beliefs or psychological traits; retain the expressed perspective and its uncertainty.`;

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
    claimState: string('statement, proposal, confirmed or uncertain; confirmation needs actual confirming evidence'),
    facets: { type: 'array', items: string('preference, decision, relationship, question, commitment or experience') },
    entityIds: { type: 'array', items: string('Exact related person/account IDs; never merge names') },
    projectIds: { type: 'array', items: string('Exact related project IDs or matrix:!room IDs') },
    basisRefs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { ...string('Existing memory ID'), required: true },
      revision: { type: 'integer', required: true } } }, description: 'Current memory revisions used to derive a draft, understanding or plan; later changes invalidate this derived record' },
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
    parameters: { query: string('Full account ID or display-name fragment; omit to list'),
      history: { type: 'boolean', description: 'Include retained identity observations; default returns identities, all aliases and latest observation only' } }, output,
    async execute(args) { return stringify(contactReadView(store.contacts(args.query), { history: args.history === true })); } }));
  rt.teamTools.push(defineTool({ name: 'memory_source', description: 'Read exact original evidence by source ID and optional revision. Historical evidence is labelled; this does not mark it current.',
    parameters: { id: { ...string('Exact source ID from a memory/view'), required: true }, revision: { type: 'number' } }, output,
    async execute(args, exec) { return stringify(memory.readSource(caller(exec), args)); } }));
  rt.teamTools.push(defineTool({ name: 'review_memory', description: 'On demand, review a bounded set of original evidence and current/old memories about a person, project or recurring error. Correct only source-backed understanding; never infer private psychology or task completion.',
    parameters: { kind: string('person or project'), id: string('Exact person/project ID'), query: string('Current question or failure to revisit'), roomId: string('Optional source room restriction') }, output,
    async execute(args, exec) { const id = caller(exec), bot = rt.botOf(id);
      return stringify(await memory.retrospect(id, args, input => generateReviewWithBudget({ generate: maxTokens => botShot(bot, `${REVIEW}\nThis is a bounded retrospective, not a request to rewrite every memory. Look for incorrect certainty, obsolete derived drafts, relevant preferences and unresolved questions. Do not infer unexpressed psychological traits or shared knowledge. HistoricalEvidence is for comparison only and cannot be cited as a current source.`, stringify(input), { maxTokens, sessionId: exec.agent?.id }) })));
    } }));

  async function oneShot(bot, system, text, tag = {}) {
    const reference = await rt.desiredModel(bot) ?? await rt.defaultModel();
    const slash = reference?.indexOf('/'); if (!(slash > 0)) throw new Error('MEMORY_MODEL_UNAVAILABLE');
    const modelOptions=await memoryModelOptions(ctx.llm,reference);
    const messages = [{ role: 'user', content: [{ type: 'text', text }] }];
    rt.tagUsage?.(messages, { sessionId: tag.sessionId || rt.chatOf(bot.id), kind: 'memory' });
    const assembled = new BlockAssembler();
    const maxTokens = tag.maxTokens || 8192;
    for await (const chunk of ctx.llm.stream({ ...modelOptions,
      sessionId: tag.sessionId || rt.chatOf(bot.id), purpose: 'memory', system, messages, maxTokens,
      signal: AbortSignal.timeout(Math.ceil(maxTokens / 8192) * 120000) })) assembled.push(chunk);
    if (['error', 'aborted', 'max-tokens'].includes(assembled.finish.kind)) throw Object.assign(new Error(`MEMORY_MODEL_${assembled.finish.kind}: ${assembled.finish.failure?.code || ''} ${assembled.finish.failure?.message || ''}`), {
      code: assembled.finish.kind === 'max-tokens' ? 'MEMORY_OUTPUT_LIMIT' : assembled.finish.failure?.code });
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
    memory.enqueueReview(botId, []);
    const calibrated = store.getMeta(`review-batch-limit:${botId}`);
    const batchLimit = Number.isInteger(calibrated) && calibrated >= 1 && calibrated <= 8 ? calibrated : 8;
    const pending = (store.getMeta(`unreviewed:${botId}`) || []).slice(0, batchLimit);
    if (!pending.length || disposed) return;
    const bot = rt.botOf(botId); if (!bot) return;
    await (await rt.resolveAgent(rt.chatOf(botId))).whenIdle();
    const { refs, value: { sources, changes, known } } = await prepareReviewBatch({ refs: pending,
      onOutputLimit: ({ error, attempted, next }) => {
        store.setMeta(`review-batch-limit:${botId}`, next.length);
        store.log('review-output-limit', { botId, sourceRefs: attempted, nextBatchSize: next.length, error: error.message });
      },
      prepare: async refs => {
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
          id: row.id, revision: row.revision, text: row.text, subjectId: row.subjectId, predicate: row.predicate, scope: row.scope, kind: row.kind,
          claimState: row.claimState || 'statement', facets: row.facets || [], entityIds: row.entityIds || [], projectIds: row.projectIds || [], basisRefs: row.basisRefs || [],
          derivation: store.derivation(row), saidBy: row.saidBy, sourceRefs: row.sourceRefs,
        }));
        const reference = await rt.desiredModel(bot) ?? await rt.defaultModel();
        const budgetKey = `review-output-budget:${reference}`;
        const changes = await prepareReviewProposal({ input: { botId, contacts: contactReadView(store.contacts()), sources, existingMemories: known },
          generate: input => refs.length > 1 ? botShot(bot, REVIEW, stringify(input)) : generateReviewWithBudget({
            initialMaxTokens: store.getMeta(budgetKey),
            generate: maxTokens => botShot(bot, REVIEW, stringify(input), { maxTokens }),
            onOutputLimit: ({ error, maxTokens, nextMaxTokens }) => {
              store.setMeta(budgetKey, nextMaxTokens);
              store.log('review-output-budget', { botId, model: reference, sourceRefs: refs, maxTokens, nextMaxTokens, error: error.message });
            },
          }),
          onProposal: (result, attempt) => store.log('review-proposal', { botId, sourceRefs: refs, changes: result.changes, attempt }),
          onInvalid: (error, attempt) => { memory.errors.push({ operation: 'review-validation', botId, attempt, error: error.message, at: Date.now() });
            store.log('review-validation-error', { botId, sourceRefs: refs, attempt, error: error.message }); } });
        return { sources, changes, known };
      } });
    await memory.applyReview(botId, { sources, existingMemories: known }, changes);
    if (changes.length) news.set(botId, Date.now());
    // Advance only after all parsed changes are durable. A failed batch remains retryable.
    for (const ref of refs) store.setMeta(`reviewed:${botId}:${ref.id}:${ref.revision}`, true);
    store.setMeta(`unreviewed:${botId}`, (store.getMeta(`unreviewed:${botId}`) || []).filter(ref => !refs.some(old => old.id === ref.id && old.revision === ref.revision)));
    store.log('review', { botId, sourceRefs: refs, changes: changes.length });
  }
  function flush(botId, { automatic = false } = {}) {
    if (!rt.botOf(botId)) return Promise.reject(new Error('MEMORY_BOT_NOT_FOUND'));
    if (automatic && !automaticReviewAllowed(config, botId)) return Promise.resolve({ skipped: 'automatic-review-disabled' });
    clearTimeout(timers.get(botId)); timers.delete(botId);
    if (reviewing.has(botId)) return reviewing.get(botId);
    const work = reviewChain.catch(() => {}).then(async () => { while (!disposed && rt.botOf(botId) && (!automatic || automaticReviewAllowed(config, botId)) && (store.getMeta(`unreviewed:${botId}`) || []).length) await review(botId); });
    reviewChain = work;
    reviewing.set(botId, work);
    work.finally(() => reviewing.delete(botId)).catch(() => {}); return work;
  }
  function schedule(botId, delayMs = config.memoryReviewDelayMs ?? 2000) {
    if (!automaticReviewAllowed(config, botId) || disposed) return;
    clearTimeout(timers.get(botId));
    const timer = setTimeout(() => { timers.delete(botId); void flush(botId, { automatic: true }).catch(error => {
      memory.errors.push({ operation: 'review', botId, error: error.message, at: Date.now() }); rt.warn('ds-bot: source memory review failed: %s', error.message);
      if (!disposed && !isModelQuotaFailure(error)) {
        const retry = setTimeout(() => { timers.delete(botId); schedule(botId); }, 60000);
        retry.unref?.(); timers.set(botId, retry);
      }
    }); }, delayMs); timer.unref?.(); timers.set(botId, timer);
  }
  ctx.on('session/event', (session, event) => {
    const botId = rt.selfOf(session.id); if (!rt.botOf(botId)) return;
    if (event.type === 'tool/call') { store.setMeta(`tool:${session.id}:${event.data.callId}`, event.data.name); return; }
    if (event.type === 'tool/result') {
      const result = event.data?.message, name = store.getMeta(`tool:${session.id}:${result?.toolCallId}`);
      if (name && !['remember', 'recall', 'forget', 'contacts', 'memory_source', 'review_memory'].includes(name) && !result.isError) memory.observeTool(botId,
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
    memory.ingest(botId, nativeMemoryInput({ source: nativeSource, text, home, sessionId: session.id,
      sequence: event.seq ?? event.sequence, timestamp: event.time ?? Date.now(), roomId: rt.groupOwners.get(session.id)?.roomId }), { sessionId: session.id });
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
      content: [{ type: 'text', text: `Current memory source context (metadata and attributed claims, not a new speaker). Use these exact source IDs for remember; omitted sourceIds defaults to the current message. For tool observations use toolSources. Reconcile currentClaims with recentSources and changes before reusing an older draft. Apply relevant preferences with their source and scope. Conflicts stay unresolved until evidence resolves them; room membership does not imply shared knowledge. Task and delivery facts require runtime receipts.\n${stringify(snapshot)}` }] });
    memory.acknowledgeContext(id, snapshot);
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
    memoryObserve: (botId, input, options) => {
      if (!rt.botOf(botId)) throw new Error('MEMORY_BOT_NOT_FOUND');
      const receipt = memory.observe(botId, input, options);
      const enough = receipt.watermarks.pendingReviewCount >= (config.memoryObservationBatchSize || 8);
      if (receipt.watermarks.pendingReviewCount && (enough || !timers.has(botId))) schedule(botId, enough ? config.memoryReviewDelayMs ?? 2000 : config.memoryObservationReviewDelayMs ?? 60000);
      return receipt;
    },
    memoryAttentionView: (botId, options) => { if (!rt.botOf(botId)) throw new Error('MEMORY_BOT_NOT_FOUND'); return memory.attentionView(botId, options); },
    memoryProfiles: ({ botId, ...options }) => { if (!rt.botOf(botId)) throw new Error('MEMORY_BOT_NOT_FOUND'); return memory.profiles(botId, options); },
    memoryProfile: ({ botId, ...options }) => { if (!rt.botOf(botId)) throw new Error('MEMORY_BOT_NOT_FOUND'); return memory.profile(botId, options); },
    memoryValidateBasis: (_botId, refs) => store.basisStatus(refs),
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
