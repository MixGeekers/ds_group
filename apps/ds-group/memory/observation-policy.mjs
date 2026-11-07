// Work dispositions come from this Bot's queue/route, not text classification.
// They qualify evidence use without mutating the shared source or task state.
const refKey = ref => `${ref.id}:${ref.revision}`;
const eventMatches = (store, context, eventId, roomId) => (context?.sourceRefs || []).some(ref => {
  const source = store.source(ref.id, ref.revision);
  return source?.eventId === eventId && (!roomId || source.roomId === roomId);
});

export function sourceUse(store, botId, ref, context, { raw = false, seen = new Set() } = {}) {
  const key = refKey(ref); if (seen.has(key)) return { allowed: true, blocked: [] }; seen.add(key);
  const source = store.source(ref.id, ref.revision);
  if (!source) return { allowed: false, blocked: [{ ...ref, reason: 'source-missing' }] };
  const disposition = store.sourceDisposition(botId, ref);
  const blocked = [];
  const admitted = store.sourceAdmitted(botId, ref);
  if (disposition.kind === 'pending-request' && (!admitted || raw && !eventMatches(store, context, source.eventId, source.roomId))) blocked.push({ ...ref,
    eventId: source.eventId, roomId: source.roomId, kind: disposition.kind, reason: admitted ? 'request-for-other-turn' : 'request-not-admitted' });
  if (disposition.kind === 'task-update' && !(raw ? eventMatches(store, context, disposition.forEventId)
    : store.eventAdmitted(botId, disposition.forEventId))) blocked.push({ ...ref, eventId: source.eventId,
    roomId: source.roomId, kind: disposition.kind, forEventId: disposition.forEventId, reason: 'update-for-other-work' });
  for (const origin of source.originRefs || []) if (store.source(origin.id, origin.revision))
    // Actual tool output is attributed observation of the accepted work, not a
    // replay of its request. An unadmitted origin still blocks it recursively.
    blocked.push(...sourceUse(store, botId, origin, context, { raw: raw && source.authorKind !== 'tool', seen }).blocked);
  return { allowed: !blocked.length, blocked };
}

export function memoryUse(store, botId, row, context, seen = new Set()) {
  if (!row || seen.has(row.id)) return { allowed: Boolean(row), blocked: [] };
  seen.add(row.id);
  const blocked = row.sourceRefs.flatMap(ref => sourceUse(store, botId, ref, context).blocked);
  for (const ref of row.basisRefs || []) {
    const basis = store.get(ref.id);
    if (basis) blocked.push(...memoryUse(store, botId, basis, context, seen).blocked);
  }
  return { allowed: !blocked.length, blocked };
}

export function sourceWorkContext(store, botId, ref, context) {
  const source = store.source(ref.id, ref.revision), disposition = store.sourceDisposition(botId, ref);
  const admission = store.getMeta(`admitted-source:${botId}:${ref.id}`);
  const currentRequest = source && eventMatches(store, context, source.eventId, source.roomId);
  const currentUpdate = disposition.kind === 'task-update' && eventMatches(store, context, disposition.forEventId);
  return { ...disposition, admitted: Boolean(admission), ...(admission ? { admission } : {}),
    role: disposition.kind === 'context' ? 'observed-context' : currentRequest || currentUpdate ? 'current-work-source'
      : disposition.kind === 'pending-request' && !admission ? 'unadmitted-request' : 'other-or-prior-work-evidence',
    isCurrentRequest: Boolean(currentRequest), executableAsNewRequest: false,
    originWork: (source?.originRefs || []).slice(0, 8).map(origin => {
      const evidence = store.source(origin.id, origin.revision), admitted = store.getMeta(`admitted-source:${botId}:${origin.id}`);
      return { ...origin, eventId: evidence?.eventId || null, roomId: evidence?.roomId || null,
        disposition: store.sourceDisposition(botId, origin), ...(admitted ? { admission: admitted } : {}) };
    }), completion: 'not-established-by-memory' };
}

export function pendingRequests(store, botId, context) {
  const pending = new Map();
  for (const ref of store.observations(botId)) {
    const source = store.source(ref.id, ref.revision), head = store.source(ref.id);
    if (!source || source.revision !== head?.revision || head.withdrawn) continue;
    const disposition = store.sourceDisposition(botId, ref);
    if (disposition.kind !== 'pending-request' || store.sourceAdmitted(botId, ref)) continue;
    // No command body, file names, or model-written summary is exposed here.
    pending.set(source.eventId, { eventId: source.eventId, roomId: source.roomId, senderId: source.authorId,
      kind: 'pending-request', status: 'not-admitted-to-this-turn', currentWork: eventMatches(store, context, source.eventId, source.roomId) });
  }
  return [...pending.values()];
}
