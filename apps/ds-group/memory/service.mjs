import { MemoryStore, sourceId, identityId, canonicalIdentity, sha } from './store.mjs';
import { OmbreBackend } from './ombre.mjs';
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
  ingest(botId, input, { contextual = false, sessionId } = {}) {
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
    const sender = source.sender || { id: event.senderId || event.sender, name: event.senderName || event.senderId || event.sender, kind: 'human' };
    if (!sender.id || !event.eventId) throw new Error('EVENT_IDENTITY_REQUIRED');
    const authorId = identityId(transport, sender.id);
    const members = context.members || context.participants || [];
    for (const member of [...members, sender]) {
      if (!member.id) continue;
      this.store.contact({ id: identityId(transport, member.id), name: member.name || member.id, kind: member.kind || 'human', ownerId: member.ownerId,
        source: { transport, roomId, eventId: event.eventId }, observedAt: source.timestamp || event.timestamp || this.store.clock() });
    }
    if (roomId) {
      const roomIdentity = identityId(transport, roomId);
      this.store.contact({ id: roomIdentity, name: context.room?.name || this.store.getContact(roomIdentity)?.name || roomId, kind: 'group',
        observedAt: source.timestamp || event.timestamp || this.store.clock() });
    }
    const id = sourceId(transport, roomId, source.replacesEventId || event.eventId);
    const edited = source.replacesEventId ? this.store.getMeta(`edit:${id}:${event.eventId}`) : undefined;
    const revision = edited || (source.replacesEventId ? (this.store.source(id)?.revision || 0) + 1 : event.revision || 1);
    const observed = this.store.observe({ id, body: event.body || '', authorId, authorKind: sender.kind || 'human', roomId,
      transport, eventId: event.eventId, timestamp: source.timestamp || event.timestamp || this.store.clock(),
      replyTo: source.replyTo || context.replyTo || null, relay: source.relay || null,
      originRefs: source.originRefs || [], revision, withdrawn: Boolean(event.withdrawn) });
    if (source.replacesEventId) this.store.setMeta(`edit:${id}:${event.eventId}`, revision);
    const scope = roomId ? `room:${roomId}` : 'own';
    const current = { botId, ...(sessionId ? { sessionId } : {}), scope, roomId, transport, authorId, sourceRefs: [{ id: observed.id, revision: observed.revision }], timestamp: observed.timestamp,
      contextSources: [...new Map(contextRefs.map(ref => [ref.id, ref])).values()].map(ref => ({ ...ref, eventId: this.store.source(ref.id, ref.revision)?.eventId,
        authorId: this.store.source(ref.id, ref.revision)?.authorId })) };
    if (contextual) return current;
    this.setCurrent(botId, current);
    const pending = this.store.getMeta(`unreviewed:${botId}`) || [];
    if (!pending.some(ref => ref.id === id && ref.revision === observed.revision) && !this.store.getMeta(`reviewed:${botId}:${id}:${observed.revision}`)) {
      this.store.setMeta(`unreviewed:${botId}`, [...pending, ...current.sourceRefs]);
    }
    return current;
  }
  setCurrent(botId, current) {
    this.store.setMeta(`current:${botId}`, current);
    if (current.sessionId) this.store.setMeta(`current-session:${botId}:${current.sessionId}`, current);
  }
  current(botId, sessionId) {
    const exact = sessionId && this.store.getMeta(`current-session:${botId}:${sessionId}`);
    if (exact) return exact;
    const latest = this.store.getMeta(`current:${botId}`);
    return !sessionId || !latest?.sessionId || latest.sessionId === sessionId ? latest : undefined;
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
      originRefs: current.sourceRefs, toolName: name });
    const ref = { id: source.id, revision: source.revision };
    this.setCurrent(botId, { ...current, toolSources: [...(current.toolSources || []), { ...ref, name }].slice(-12) });
    const pending = this.store.getMeta(`unreviewed:${botId}`) || [];
    if (!pending.some(item => item.id === ref.id)) this.store.setMeta(`unreviewed:${botId}`, [...pending, ref]);
    return source;
  }
  scope(current, requested) {
    if (!requested || requested === 'group') return current?.scope || 'own';
    if (requested === 'own' || requested === 'team' || requested.startsWith('room:')) return requested;
    throw new Error('Use scope own, team, group, or room:<full room ID>');
  }
  remember(botId, args, context = this.current(botId)) { return this.serial(botId, async () => {
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
    const row = this.store.prepare({ ...args, botId, scope, subjectId, predicate: args.predicate || previous?.predicate, sourceRefs: refs, replaces,
      expectedRevision: args.expectedRevision ?? previous?.revision,
      kind, saidBy });
    if (row.status !== 'pending') return this.describe(row);
    const receipt = this.backend ? await this.backend.save(row) : { bodyDigest: row.bodyDigest, backend: 'local-exact', bodyDurable: true };
    let saved = this.store.activate(row.id, receipt);
    // A durable fact remains readable when its derived vector index is temporarily unavailable.
    if (this.backend) {
      try { saved = this.store.indexed(saved.id, await this.backend.index(saved)); }
      catch (error) { this.errors.push({ operation: 'index', id: saved.id, error: error.message, at: Date.now() }); }
    }
    return this.describe(saved);
  }); }
  describe(row) {
    return { id: row.id, revision: row.revision, text: row.text, botId: row.botId, scope: row.scope,
      subjectId: row.subjectId, predicate: row.predicate, kind: row.kind, saidBy: row.saidBy,
      validFrom: row.validFrom, validUntil: row.validUntil, derivation: this.store.derivation(row),
      conflicts: this.store.conflicts(row), sourceRefs: row.sourceRefs,
      evidenceRoots: this.store.evidenceRoots(row.sourceRefs),
      sources: row.sourceRefs.map(ref => this.store.source(ref.id, ref.revision)),
      topic: row.topic, indexed: row.index?.state === 'applied' };
  }
  async recall(botId, args = {}, context = this.current(botId)) {
    const scopes = args.scope === 'all' ? undefined : args.scope ? [this.scope(context, args.scope)]
      : [...new Set(['own', 'team', context?.scope].filter(Boolean))];
    const rows = this.store.list({ botId, scopes, subjectId: args.subjectId, topic: args.topic, asOf: args.asOf, history: args.history });
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
      try {
        if (this.backend && fresh.receipt?.nativeId) await this.backend.read(fresh);
        entries.push(this.describe(fresh));
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
