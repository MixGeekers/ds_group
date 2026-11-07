import { MemoryStore, sourceId, identityId, canonicalIdentity, canonical, sha } from './store.mjs';
import { OmbreBackend } from './ombre.mjs';
import { assembleAttentionView, memoryProfiles, memoryProfile, reviewPacket, memoryContacts } from './views.mjs';
import { prepareReviewProposal, validateReviewProposal } from './review.mjs';
import { sourceUse, memoryUse, pendingRequests, sourceWorkContext } from './observation-policy.mjs';
import { queryObservedSources } from './source-query.mjs';
import { join } from 'node:path';

export class MemoryService {
  constructor({ directory, backend, clock }) {
    this.store = new MemoryStore(join(directory, 'knowledge.sqlite'), { clock });
    this.backend = backend ? new OmbreBackend({ ...backend, directory: join(directory, 'ombre'), deploymentId: this.store.deploymentId }) : null;
    this.queues = new Map(); this.errors = [];
  }
  serial(botId, fn) {
    const task = (this.queues.get(botId) || Promise.resolve()).catch(() => {}).then(fn);
    this.queues.set(botId, task); return task;
  }
  enqueueReview(botId, refs) {
    const pending = new Map();
    for (const ref of [...(this.store.getMeta(`unreviewed:${botId}`) || []), ...refs]) {
      const head = this.store.source(ref.id);
      if (!head || head.withdrawn || head.eventKind === 'redaction-notice' || head.revision !== ref.revision || this.store.getMeta(`reviewed:${botId}:${ref.id}:${ref.revision}`)) continue;
      pending.set(`${ref.id}:${ref.revision}`, ref);
    }
    this.store.setMeta(`unreviewed:${botId}`, [...pending.values()]);
  }
  // Observation never moves the active native Session or claims that a model has
  // understood the evidence. The cursor belongs to the caller's stream only.
  observe(botId, input, options = {}) {
    const inputs = Array.isArray(input) ? input : [input];
    if (!inputs.length || inputs.length > 256) throw new Error('MEMORY_OBSERVATION_BATCH');
    return this.store.transaction(() => {
      const streamKey = options.streamId && `observation-stream:${botId}:${options.streamId}`;
      if (streamKey && (options.cursor === undefined || options.cursor === null || canonical(options.cursor)?.length > 2048)) throw new Error('MEMORY_STREAM_CURSOR_REQUIRED');
      // Display labels and membership sightings may change during a retry. They
      // do not change immutable event authorship or its source bytes.
      const digest = sha(canonical(inputs.map(({ event = {}, context = {} }) => {
        const source = context.source || event.source || {};
        return { eventId: event.eventId, body: event.body || '', roomId: source.roomId || event.roomId,
          authorId: source.sender?.id || event.senderId || event.sender, withdrawn: !!event.withdrawn,
          revision: event.revision || 1, replaces: source.replacesEventId, retracts: source.retractsEventId,
          originRefs: source.originRefs || [], relay: source.relay || null };
      })));
      const previous = streamKey && this.store.getMeta(streamKey);
      if (previous && canonical(previous.cursor) === canonical(options.cursor)) {
        if (previous.digest !== digest) throw new Error('MEMORY_STREAM_CONTENT_CONFLICT');
        for (const ref of previous.receipt.sourceRefs) {
          const disposition = options.sourceDispositions?.[this.store.source(ref.id, ref.revision)?.eventId];
          if (disposition) this.store.setSourceDisposition(botId, ref, disposition);
        }
        return { ...previous.receipt, watermarks: this.store.watermarks(botId), duplicate: true };
      }
      if (streamKey && Object.hasOwn(options, 'afterCursor') && canonical(previous?.cursor ?? null) !== canonical(options.afterCursor ?? null)) throw new Error('MEMORY_STREAM_CONFLICT');
      if (previous && typeof previous.cursor === 'number' && typeof options.cursor === 'number' && options.cursor <= previous.cursor) throw new Error('MEMORY_STREAM_CONFLICT');
      const contexts = inputs.map(item => this.ingest(botId, item, { contextual: true }));
      for (let index = 0; index < contexts.length; index++) {
        const disposition = options.sourceDispositions?.[inputs[index].event?.eventId];
        if (disposition) for (const ref of contexts[index].sourceRefs) this.store.setSourceDisposition(botId, ref, disposition);
      }
      const refs = [...new Map(contexts.flatMap(item => item.sourceRefs).map(ref => [`${ref.id}:${ref.revision}`, ref])).values()];
      this.enqueueReview(botId, refs);
      const receipt = { sourceRefs: refs, watermarks: this.store.watermarks(botId), duplicate: false,
        ...(streamKey ? { stream: { id: options.streamId, cursor: options.cursor ?? null } } : {}) };
      if (streamKey) this.store.setMeta(streamKey, { cursor: options.cursor ?? null, digest, receipt });
      return receipt;
    });
  }
  onObservedMessage(botId, input, options) { return this.observe(botId, input, options); }
  ingest(botId, input, options = {}) {
    return this.store.transaction(() => this.ingestOne(botId, input, options));
  }
  ingestOne(botId, input, { contextual = false, sessionId } = {}) {
    const contextRefs = [];
    if (!contextual) {
      for (const previous of input.history || []) {
        if (!previous.eventId || !(previous.senderId || previous.sender || previous.source?.sender?.id)) continue;
        const seen = this.ingest(botId, { event: previous, context: { source: previous.source } }, { contextual: true });
        contextRefs.push(...seen.sourceRefs);
      }
      for (const quoted of [input.context?.reply, input.context?.threadRoot].filter(item => item?.source?.eventId && typeof item.body === 'string')) {
        const source = quoted.source;
        const seen = this.ingest(botId, { event: { eventId: source.eventId, roomId: source.roomId, senderId: source.sender.id, body: quoted.body }, context: { source } }, { contextual: true });
        contextRefs.push(...seen.sourceRefs);
      }
    }
    const event = input.event, context = input.context || {};
    const source = context.source || event.source || {};
    const transport = source.transport || 'matrix';
    const roomId = source.roomId || event.roomId;
    const sender = source.sender || { id: event.senderId || event.sender, name: event.senderName || event.senderId || event.sender, kind: event.senderKind || 'human' };
    if (!sender.id || !event.eventId) throw new Error('EVENT_IDENTITY_REQUIRED');
    const account = id => id.startsWith(`${transport}:`) ? id : identityId(transport, id);
    const authorId = account(sender.id);
    const members = context.members || context.participants || [];
    const conversationKind = context.room?.kind === 'direct' || event.conversationKind === 'direct' || source.conversationKind === 'direct'
      || members.length > 0 && members.length <= 2 ? 'direct' : members.length > 2 ? 'group' : 'unknown';
    for (const member of [...members, sender]) {
      if (!member.id) continue;
      this.store.contact({ id: account(member.id), name: member.name || member.id, kind: member.kind || 'human', ownerId: member.ownerId, botId,
        source: { transport, roomId, eventId: event.eventId }, observedAt: source.timestamp ?? event.timestamp ?? this.store.clock() });
    }
    if (roomId) {
      const roomIdentity = account(roomId);
      this.store.contact({ id: roomIdentity, name: context.room?.name || this.store.getMeta(`contact:${botId}:${roomIdentity}`)?.name || roomId, kind: 'group', botId,
        source: { transport, roomId, eventId: event.eventId },
        observedAt: source.timestamp ?? event.timestamp ?? this.store.clock() });
    }
    const editTargetId = source.replacesEventId && sourceId(transport, roomId, source.replacesEventId);
    const editTarget = editTargetId && this.store.source(editTargetId);
    const unappliedEdit = source.replacesEventId && (!editTarget ? 'target-unavailable' : editTarget.authorId !== authorId ? 'author-mismatch' : null);
    // A relation alone cannot establish the missing event's author or overwrite
    // somebody else's source. Retain the edit as its own attributed evidence.
    const appliesEdit = source.replacesEventId && !unappliedEdit;
    const id = sourceId(transport, roomId, appliesEdit ? source.replacesEventId : event.eventId);
    const edited = appliesEdit ? this.store.getMeta(`edit:${id}:${event.eventId}`) : undefined;
    const revision = edited || (appliesEdit ? (this.store.source(id)?.revision || 0) + 1 : event.revision || 1);
    let observed, notice;
    if (source.retractsEventId) {
      const targetId = sourceId(transport, roomId, source.retractsEventId), old = this.store.source(targetId);
      notice = this.store.observe({ id, body: '', authorId, authorKind: sender.kind || 'unknown', transport, roomId,
        conversationKind, roomName: context.room?.name || null,
        eventId: event.eventId, eventKind: 'redaction-notice', targetEventId: source.retractsEventId, targetSourceId: targetId,
        timestamp: source.timestamp ?? event.timestamp ?? this.store.clock() });
      const key = `redaction:${targetId}:${event.eventId}`, applied = this.store.getMeta(key);
      if (old) {
        observed = applied ? this.store.source(targetId, applied) : old.withdrawn ? old : this.store.observe({ ...old, body: '', revision: old.revision + 1,
          withdrawn: true, retractedBy: authorId, retractionEventId: event.eventId });
        this.store.setMeta(key, observed.revision);
      } else observed = notice;
      this.store.setMeta(`pending-redaction:${targetId}`, { by: authorId, eventId: event.eventId, timestamp: notice.timestamp });
    } else {
      const head = this.store.source(id);
      if (event.withdrawn || source.withdrawn) {
        if (head && head.authorId !== authorId) throw new Error('SOURCE_AUTHOR_CONFLICT');
        // Visible room history may contain a redaction overlay. The placeholder
        // is transport metadata, never new bytes authored by the original person.
        observed = head?.withdrawn ? head : this.store.observe({ ...(head || { id, authorId, authorKind: sender.kind || 'unknown', roomId,
          transport, eventId: event.eventId, timestamp: source.timestamp ?? event.timestamp ?? this.store.clock(), contentUnavailable: true }),
          body: '', revision: head ? head.revision + 1 : revision, withdrawn: true, withdrawalEvidence: 'redacted-history-overlay' });
      } else if (head?.withdrawn && (head.contentUnavailable || head.originalContentRecovered)) {
        if (head.authorId !== authorId) throw new Error('SOURCE_AUTHOR_CONFLICT');
        if (head.originalContentRecovered) {
          if (head.body !== (event.body || '')) throw new Error('SOURCE_CONTENT_CONFLICT');
          observed = head;
        } else observed = this.store.observe({ ...head, revision: head.revision + 1, body: event.body || '', authorKind: sender.kind || head.authorKind,
          contentUnavailable: false, originalContentRecovered: true, withdrawn: true });
      } else observed = this.store.observe({ id, body: event.body || '', authorId, authorKind: sender.kind || 'human', roomId,
        conversationKind, roomName: context.room?.name || null,
        transport, eventId: event.eventId, timestamp: source.timestamp ?? event.timestamp ?? this.store.clock(),
        replyTo: source.replyTo || context.replyTo || null, relay: source.relay || null,
        threadRootId: source.threadRootId || null, projectIds: source.projectIds || context.projectIds || [],
        ...(unappliedEdit ? { eventKind: 'unverified-edit', editTargetId, targetEventId: source.replacesEventId, editVerification: unappliedEdit } : {}),
        originRefs: source.originRefs || [], revision, withdrawn: false });
    }
    if (!source.retractsEventId) {
      const pendingRedaction = this.store.getMeta(`pending-redaction:${observed.id}`), head = this.store.source(observed.id);
      if (pendingRedaction) observed = head.withdrawn ? head : this.store.observe({ ...head, body: '', revision: head.revision + 1,
        withdrawn: true, retractedBy: pendingRedaction.by, retractionEventId: pendingRedaction.eventId });
    }
    if (appliesEdit) this.store.setMeta(`edit:${id}:${event.eventId}`, revision);
    const sourceRefs = [...new Map([notice, observed].filter(Boolean).map(item => [`${item.id}:${item.revision}`, { id: item.id, revision: item.revision }])).values()];
    this.store.observeFor(botId, sourceRefs);
    const scope = roomId ? `room:${roomId}` : 'own';
    const current = { botId, ...(sessionId ? { sessionId } : {}), scope, roomId, transport, authorId, sourceRefs, timestamp: observed.timestamp,
      room: context.room, conversationKind, threadRootId: source.threadRootId || null, history: context.history, projectIds: source.projectIds || context.projectIds || [],
      contextSources: [...new Map(contextRefs.map(ref => [ref.id, ref])).values()].map(ref => ({ ...ref, eventId: this.store.source(ref.id, ref.revision)?.eventId,
        authorId: this.store.source(ref.id, ref.revision)?.authorId })) };
    if (contextual) return current;
    this.setCurrent(botId, current);
    // Ordinary human discussion is also evidence when this Bot sees it in the
    // actual room history. Keep its original author; do not promote a Bot's
    // generated draft in that history into another person's new statement.
    const humanContext = contextRefs.filter(ref => this.store.source(ref.id, ref.revision)?.authorKind === 'human');
    this.enqueueReview(botId, [...humanContext, ...current.sourceRefs]);
    return current;
  }
  setCurrent(botId, current) {
    this.store.admitSources(botId, current);
    this.store.setMeta(`current:${botId}`, current);
    if (current.sessionId) this.store.setMeta(`current-session:${botId}:${current.sessionId}`, current);
  }
  current(botId, sessionId) {
    const exact = sessionId && this.store.getMeta(`current-session:${botId}:${sessionId}`);
    if (exact) return exact;
    const latest = this.store.getMeta(`current:${botId}`);
    return !sessionId || !latest?.sessionId || latest.sessionId === sessionId ? latest : undefined;
  }
  clearCurrent(botId, sessionId, reason) {
    const current = { botId, sessionId, sourceStatus: 'unavailable', sourceReason: reason, sourceRefs: [], scope: 'own' };
    this.setCurrent(botId, current);
    return current;
  }
  contextSnapshot(botId, sessionId, options = {}) {
    const current = this.current(botId, sessionId);
    if (!current) return undefined;
    if (current.sourceStatus === 'unavailable') return { schemaVersion: 2, botId, sessionId,
      self: { nativeBotId: botId }, sourceStatus: current.sourceStatus, authorId: null, roomId: null, sourceRefs: [],
      currentClaims: [], preferences: [], projectFacts: [], recentSources: [], changes: [], people: [], toolSources: [], contextSources: [],
      historyGaps: [{ kind: 'current-source-unavailable', reason: current.sourceReason }],
      knowledgeBoundary: 'This claimed input has no stable source identity. Previous room, speaker and instructions are not the current context.',
      watermarks: this.store.watermarks(botId), version: sha(canonical(current)) };
    return this.attentionView(botId, { ...options, sessionId, context: current });
  }
  attentionView(botId, options = {}) { return assembleAttentionView(this, botId, options); }
  querySources(botId, options = {}) { return queryObservedSources(this, botId, options); }
  sourceUse(botId, ref, context = this.current(botId), options) { return sourceUse(this.store, botId, ref, context, options); }
  memoryUse(botId, row, context = this.current(botId)) { return memoryUse(this.store, botId, row, context); }
  pendingRequests(botId, context = this.current(botId)) { return pendingRequests(this.store, botId, context); }
  reviewableRefs(botId) {
    return (this.store.getMeta(`unreviewed:${botId}`) || []).filter(ref => this.sourceUse(botId, ref).allowed);
  }
  assertUsable(botId, row, context = this.current(botId)) {
    if (!this.memoryUse(botId, row, context).allowed) throw new Error('MEMORY_SOURCE_PENDING_REQUEST');
  }
  profiles(botId, options = {}) { return memoryProfiles(this, botId, options); }
  contacts(botId, options = {}) { return memoryContacts(this, botId, options); }
  profile(botId, options = {}) { return memoryProfile(this, botId, options); }
  reviewPacket(botId, options = {}) { return reviewPacket(this, botId, options); }
  acknowledgeContext(botId, view) {
    const through = view?.watermarks?.receivedThrough;
    if (view?.self?.nativeBotId !== botId || !Number.isSafeInteger(through) || through < 0 || through > this.store.watermarks(botId).receivedThrough) throw new Error('MEMORY_CONTEXT_ACK_INVALID');
    // This receipt acknowledges assembly of a bounded view, never full-history
    // loading, model comprehension or a successful external action.
    this.store.setMeta(`context-through:${botId}`, Math.max(through, this.store.getMeta(`context-through:${botId}`) || 0));
    return { through, version: view.version, meaning: 'bounded-view-assembled' };
  }
  carry(botId, before, after) {
    const current = this.current(botId, before);
    if (current) this.setCurrent(botId, { ...current, sessionId: after });
  }
  resolveSource(id, context) {
    const exact = this.store.source(id); if (exact) return exact;
    const matches = this.store.sources().filter(source => source.eventId === id && (!context?.roomId || source.roomId === context.roomId));
    if (matches.length !== 1) throw new Error(matches.length ? 'SOURCE_AMBIGUOUS' : 'SOURCE_NOT_FOUND');
    return matches[0];
  }
  observeTool(botId, { sessionId, callId, name, body, timestamp }) {
    const current = this.current(botId, sessionId); if (!current) return;
    const source = this.store.observe({ id: sourceId('tool', sessionId, callId), body, transport: 'tool', eventId: callId,
      authorId: `tool:${name}`, authorKind: 'tool', roomId: current.roomId, timestamp: timestamp || this.store.clock(),
      conversationKind: current.conversationKind || 'unknown', roomName: current.room?.name || null,
      originRefs: current.sourceRefs, toolName: name });
    const ref = { id: source.id, revision: source.revision };
    this.store.observeFor(botId, [ref]);
    this.setCurrent(botId, { ...current, toolSources: [...(current.toolSources || []), { ...ref, name }].slice(-12) });
    this.enqueueReview(botId, [ref]);
    return source;
  }
  scope(current, requested) {
    if (!requested || requested === 'group') return current?.scope || 'own';
    if (requested === 'own' || requested === 'team' || requested.startsWith('room:')) return requested;
    throw new Error('Use scope own, team, group, or room:<full room ID>');
  }
  prepareMemory(botId, args, context) {
    if (!context) throw new Error('MEMORY_SOURCE_REQUIRED');
    const refs = args.sourceRefs || (args.sourceIds?.length ? args.sourceIds.map(id => {
      const source = this.resolveSource(id, context);
      return { id: source.id, revision: source.revision };
    }) : args.kind === 'observation' && context.toolSources?.length ? [context.toolSources.at(-1)].map(({ id, revision }) => ({ id, revision })) : context.sourceRefs);
    const source = this.store.source(refs[0]?.id, refs[0]?.revision);
    const kind = args.kind || (source?.authorKind === 'bot' ? 'reported' : source?.authorKind === 'tool' ? 'observation' : 'stated');
    // A request and its tool result can both support an observation. Derive its
    // observing author from actual tool evidence, independent of reference order;
    // keep the human request in sourceRefs/originRefs as provenance.
    const observers = kind === 'observation' ? refs.map(ref => this.store.source(ref.id, ref.revision))
      .filter(item => item?.authorKind === 'tool') : [];
    const requestedAuthor = canonicalIdentity(args.saidBy);
    const saidBy = observers.length ? (observers.find(item => item.authorId === requestedAuthor) || observers[0]).authorId
      : requestedAuthor || source?.authorId;
    const scope = this.scope(context, args.scope);
    let replaces = args.replaces || args.replaceId;
    if (!replaces && args.replace) {
      const matches = this.store.list({ botId, scopes: [scope], history: true }).filter(row => row.status === 'active'
        && (row.id === args.replace || row.text.includes(args.replace)));
      if (matches.length !== 1) throw new Error('MEMORY_REPLACE_AMBIGUOUS'); replaces = matches[0].id;
    }
    const previous = replaces ? this.store.get(replaces) : null;
    const subjectId = canonicalIdentity(args.subjectId || previous?.subjectId || source?.authorId || context.authorId);
    this.assertUsable(botId, { sourceRefs: refs, basisRefs: args.basisRefs || [] }, context);
    return this.store.prepare({ ...args, botId, scope, subjectId, predicate: args.predicate || previous?.predicate, sourceRefs: refs, replaces,
      expectedRevision: args.expectedRevision ?? previous?.revision,
      kind, saidBy });
  }
  async persistPrepared(row) {
    if (row.status !== 'pending') return this.describe(row);
    const receipt = this.backend ? await this.backend.save(row) : { bodyDigest: row.bodyDigest, backend: 'local-exact', bodyDurable: true };
    this.assertUsable(row.botId, row);
    let saved = this.store.activate(row.id, receipt);
    // A durable fact remains readable when its derived vector index is temporarily unavailable.
    if (this.backend) {
      try { saved = this.store.indexed(saved.id, await this.backend.index(saved)); }
      catch (error) { this.errors.push({ operation: 'index', id: saved.id, error: error.message, at: Date.now() }); }
    }
    return this.describe(saved);
  }
  remember(botId, args, context = this.current(botId)) { return this.serial(botId, () => this.persistPrepared(this.prepareMemory(botId, args, context))); }
  applyReview(botId, packet, proposal, { signal } = {}) { return this.serial(botId, async () => {
    signal?.throwIfAborted();
    const changes = validateReviewProposal({ changes: proposal }, packet.sources, packet.existingMemories);
    const verify = () => {
      signal?.throwIfAborted();
      for (const ref of changes.flatMap(change => change.sourceRefs)) {
        if (this.store.source(ref.id)?.revision !== ref.revision) throw new Error('MEMORY_REVIEW_SOURCE_STALE');
        if (!this.sourceUse(botId, ref).allowed) throw new Error('MEMORY_SOURCE_PENDING_REQUEST');
      }
      for (const change of changes) this.assertUsable(botId, { sourceRefs: change.sourceRefs, basisRefs: change.basisRefs || [] });
      for (const change of changes.filter(change => change.op !== 'add')) {
        const expected = packet.existingMemories.find(row => row.id === change.replaceId), now = this.store.get(change.replaceId);
        if (!now || now.status !== 'active' || now.revision !== expected.revision) throw new Error('MEMORY_REVISION_CONFLICT');
      }
    };
    verify();
    const prepared = changes.map(change => {
      if (change.op === 'forget') return { change };
      const source = packet.sources.find(source => source.id === change.sourceRefs[0].id);
      const context = { botId, scope: source.roomId ? `room:${source.roomId}` : 'own', authorId: source.authorId, sourceRefs: change.sourceRefs };
      const old = change.op === 'replace' && this.store.get(change.replaceId);
      return { change, row: this.prepareMemory(botId, { ...change, replaceId: old?.id,
        expectedRevision: old?.revision, ...(old?.text === change.text ? { reclassify: true } : {}) }, context) };
    });
    // Stage external bodies before one local publication transaction. Source or
    // target changes while awaiting IO leave every staged fact non-current.
    for (const item of prepared) if (item.row?.status === 'pending') item.receipt = this.backend ? await this.backend.save(item.row)
      : { bodyDigest: item.row.bodyDigest, backend: 'local-exact', bodyDurable: true };
    const rows = this.store.transaction(() => {
      verify();
      return prepared.map(({ change, row, receipt }) => change.op === 'forget'
        ? this.store.forget(change.replaceId, packet.existingMemories.find(old => old.id === change.replaceId).revision)
        : row.status === 'pending' ? this.store.activate(row.id, receipt) : row);
    });
    if (this.backend) for (const row of rows.filter(row => row.status === 'active')) {
      try { this.store.indexed(row.id, await this.backend.index(row)); }
      catch (error) { this.errors.push({ operation: 'index', id: row.id, error: error.message, at: Date.now() }); }
    }
    return rows.map(row => this.describe(this.store.get(row.id)));
  }); }
  async retrospect(botId, options, generate) {
    if (typeof generate !== 'function') throw new Error('MEMORY_REVIEW_GENERATOR_REQUIRED');
    const packet = this.reviewPacket(botId, options);
    if (!packet.sources.length) return { mode: 'no-evidence', packetVersion: packet.version, changes: [] };
    const changes = await prepareReviewProposal({ input: packet, generate });
    const rows = await this.applyReview(botId, packet, changes);
    // A review tool result must not re-inject every full source body that the
    // bounded packet deliberately left out. Exact evidence stays addressable.
    const result = { mode: 'source-checked-review', packetVersion: packet.version, totalChanges: rows.length, changes: [], changesOmitted: 0,
      profile: options?.kind && options.id ? this.profile(botId, { ...options, budgetChars: 10000 }) : undefined };
    for (const row of rows) {
      result.changes.push({ id: row.id, revision: row.revision, text: row.text.slice(0, 600), truncated: row.text.length > 600,
        scope: row.scope, subjectId: row.subjectId, predicate: row.predicate, kind: row.kind, claimState: row.claimState,
        derivation: row.derivation, sourceRefs: row.sourceRefs.slice(0, 4), sourceCount: row.sourceRefs.length });
      if (JSON.stringify(result).length > 24000) { result.changes.pop(); result.changesOmitted++; }
    }
    return result;
  }
  readSource(botId, { id, revision }, context = this.current(botId)) {
    const allowed = [...this.store.observations(botId),
      ...this.store.list({ botId, history: true }).flatMap(row => [...row.sourceRefs, ...this.store.evidenceRoots(row.sourceRefs)])];
    revision ??= Math.max(0, ...allowed.filter(ref => ref.id === id).map(ref => ref.revision));
    if (!allowed.some(ref => ref.id === id && ref.revision === revision)) throw new Error('MEMORY_SOURCE_NOT_OBSERVED');
    if (!this.sourceUse(botId, { id, revision }, context).allowed) throw new Error('MEMORY_SOURCE_PENDING_REQUEST');
    const source = this.store.source(id, revision); if (!source) throw new Error('SOURCE_NOT_FOUND');
    const head = this.store.source(id);
    return { ...source, currentRevision: head.revision, derivation: head.withdrawn ? 'source-withdrawn' : source.revision !== head.revision ? 'source-revised' : 'current',
      workDisposition: sourceWorkContext(this.store, botId, { id, revision }, context) };
  }
  describe(row) {
    return { id: row.id, revision: row.revision, text: row.text, botId: row.botId, scope: row.scope,
      subjectId: row.subjectId, predicate: row.predicate, kind: row.kind, claimState: row.claimState || 'statement',
      facets: row.facets || [], entityIds: row.entityIds || [], projectIds: row.projectIds || [], basisRefs: row.basisRefs || [], saidBy: row.saidBy,
      validFrom: row.validFrom, validUntil: row.validUntil, derivation: this.store.derivation(row),
      conflicts: this.store.conflicts(row), sourceRefs: row.sourceRefs,
      evidenceRoots: this.store.evidenceRoots(row.sourceRefs),
      sources: row.sourceRefs.map(ref => this.store.source(ref.id, ref.revision)),
      topic: row.topic, indexed: row.index?.state === 'applied' };
  }
  async recall(botId, args = {}, context = this.current(botId)) {
    const scopes = args.scope === 'all' ? undefined : args.scope ? [this.scope(context, args.scope)]
      : [...new Set(['own', 'team', context?.scope].filter(Boolean))];
    const rows = this.store.list({ botId, scopes, subjectId: args.subjectId, topic: args.topic, asOf: args.asOf, history: args.history })
      .filter(row => this.memoryUse(botId, row, context).allowed);
    const limit = Math.min(30, Math.max(1, args.limit || 10));
    let selected = rows.slice(-limit).reverse(), mode = 'exact', issue;
    if (args.query && rows.length) {
      const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      const lexical = rows.map(row => ({ row, score: terms.reduce((sum, term) => sum + (row.text.toLowerCase().includes(term) ? 1 : 0), 0) }));
      selected = lexical.sort((a, b) => b.score - a.score || b.row.observedAt - a.row.observedAt).slice(0, limit).map(item => item.row);
      if (this.backend) {
        try {
          const indexed = [];
          for (let row of rows.filter(item => item.status !== 'pending')) {
            // Switching from local exact storage to Ombre does not rewrite facts.
            // Materialize the already stored, hash-checked body with the same ID.
            if (!row.receipt?.nativeId) {
              const receipt = await this.backend.save(row);
              row = this.store.write({ ...this.store.get(row.id), receipt, index: null });
            }
            const index = row.index?.state === 'applied' ? row.index : await this.backend.index(row);
            if (index) indexed.push(this.store.indexed(row.id, index));
          }
          const result = await this.backend.search(args.query, indexed, Math.min(limit, 10));
          if (result.mode === 'semantic') {
            mode = 'semantic';
            selected = result.matches.map(match => this.store.get(match.memoryOperationId)).filter(Boolean);
          }
        } catch (error) { issue = error.message; mode = 'lexical-fallback'; }
      }
    }
    const entries = [];
    for (const row of selected) {
      // Recheck after asynchronous ranking: revisions/withdrawals during an embedding cannot leak a stale current fact.
      const fresh = this.store.get(row.id);
      if (!args.history && this.store.derivation(fresh, args.asOf) !== 'current') continue;
      if (!this.memoryUse(botId, fresh, context).allowed) continue;
      try {
        if (this.backend && fresh.receipt?.nativeId) await this.backend.read(fresh);
        const afterRead = this.store.get(fresh.id);
        if ((!args.history && this.store.derivation(afterRead, args.asOf) !== 'current') || !this.memoryUse(botId, afterRead, context).allowed) continue;
        entries.push(this.describe(afterRead));
      } catch (error) { issue = error.message; }
    }
    return { mode, ...(issue ? { issue } : {}), totalEligible: rows.length, entries };
  }
  forget(botId, args, context = this.current(botId)) {
    const scopes = args.scope === 'all' ? undefined : [this.scope(context, args.scope)];
    const matches = this.store.list({ botId, scopes, history: true }).filter(row => row.status === 'active'
      && (row.id === args.id || args.entry && row.text.includes(args.entry)));
    if (matches.length !== 1) throw new Error('MEMORY_FORGET_AMBIGUOUS');
    return this.describe(this.store.forget(matches[0].id, args.expectedRevision ?? matches[0].revision));
  }
  async close() { await Promise.allSettled([...this.queues.values()]); await this.backend?.close(); this.store.close(); }
}
