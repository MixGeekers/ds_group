import { canonical, canonicalIdentity, sha } from './store.mjs';

const limit = (value, fallback, maximum) => Number.isFinite(value) ? Math.min(maximum, Math.max(1, Math.floor(value))) : fallback;
const short = (value, length = 512) => typeof value === 'string' ? value.slice(0, length) : value;
const unique = values => [...new Set(values.filter(Boolean).map(canonicalIdentity))];
const preferencePredicates = new Set(['preference', 'language', 'report-language', 'report-style', 'report-format', 'preferred-language', 'communication-style', 'response-length', 'tone']);
const isPreference = row => row.facets?.includes('preference') || preferencePredicates.has(row.predicate);
const person = id => /^(matrix:@|native:|tool:)/.test(id || '') && !id.startsWith('tool:');
const project = id => /^(project:|matrix:!)/.test(id || '');
const refKey = ref => `${ref.id}:${ref.revision}`;
const tokens = text => [...new Set((String(text || '').toLowerCase().match(/[a-z\d_@:.!-]{2,}|[\p{Script=Han}]{2,}/gu) || [])
  .flatMap(term => /\p{Script=Han}/u.test(term) ? Array.from({ length: Math.max(1, term.length - 1) }, (_, index) => term.slice(index, index + 2)) : [term]))].slice(0, 100);
const lexical = (text, terms) => terms.reduce((score, term) => score + (String(text || '').toLowerCase().includes(term) ? 1 : 0), 0);

// Historical stores did not attach a Bot to every source. Recover only evidence
// referenced by this Bot's records/current context; never assign the whole source
// table to every Bot. New ingress records exact per-Bot observations.
export function knownSources(memory, botId) {
  const { store } = memory;
  const refs = new Map(store.observations(botId).map(ref => [refKey(ref), ref]));
  const current = memory.current(botId);
  const add = ref => {
    const key = refKey(ref); if (refs.has(key)) return;
    refs.set(key, ref);
    const source = store.source(ref.id, ref.revision);
    for (const origin of source?.originRefs || []) if (store.source(origin.id, origin.revision)) add(origin);
  };
  for (const row of store.list({ botId, history: true })) for (const ref of row.sourceRefs) add(ref);
  for (const ref of [...(current?.sourceRefs || []), ...(current?.contextSources || []), ...(current?.toolSources || [])]) add(ref);
  return [...refs.values()].map(ref => {
    const source = store.source(ref.id, ref.revision), head = store.source(ref.id);
    return source && { ...source, sequence: ref.sequence ?? null, currentRevision: head?.revision ?? null,
      derivation: !head || head.withdrawn ? 'source-withdrawn' : head.revision !== ref.revision ? 'source-revised' : 'current',
      reviewed: store.getMeta(`reviewed:${botId}:${ref.id}:${ref.revision}`) === true };
  }).filter(Boolean);
}

const sourceSummary = source => source && ({ id: source.id, revision: source.revision, authorId: source.authorId,
  authorKind: source.authorKind || 'unknown', eventId: source.eventId || null, roomId: source.roomId || null,
  timestamp: source.timestamp ?? null, digest: source.digest, ...(source.relay ? { relay: source.relay } : {}) });
function authority(store, row) {
  const sources = row.sourceRefs.map(ref => store.source(ref.id, ref.revision)).filter(Boolean);
  if (row.kind === 'inference' || row.kind === 'legacy' || row.kind === 'reported') return row.kind;
  if (row.kind === 'observation' && sources.some(source => source.authorKind === 'tool')) return 'tool-observation';
  if (sources.some(source => source.authorKind === 'human' && !source.relay && (!row.saidBy || source.authorId === row.saidBy))) return 'direct-human';
  return sources.some(source => source.authorKind === 'bot') ? 'bot-authored' : 'attributed-claim';
}
function focusOf(memory, botId, options, rows, sources) {
  let current = options.context || memory.current(botId, options.sessionId) || {};
  const roomId = options.roomId ?? current.roomId;
  const eventIds = new Set(options.eventIds || []);
  const focusedSources = sources.filter(source => source.derivation === 'current' &&
    (eventIds.size ? eventIds.has(source.eventId) : current.sourceRefs?.some(ref => ref.id === source.id && ref.revision === source.revision)));
  if (!options.context && eventIds.size) {
    const latest = focusedSources.filter(source => !roomId || source.roomId === roomId)
      .sort((a,b) => (b.sequence || 0) - (a.sequence || 0) || b.timestamp - a.timestamp)[0];
    current = { roomId, scope: roomId ? `room:${roomId}` : 'own', authorId: options.speakerId || latest?.authorId,
      sourceRefs: focusedSources.map(({ id, revision }) => ({ id, revision })), threadRootId: options.threadRootId,
      projectIds: latest?.projectIds || [] };
  } else if (!options.context && options.roomId && current.roomId !== options.roomId) current = { roomId: options.roomId, scope: `room:${options.roomId}`, authorId: options.speakerId };
  const query = short(options.query ?? focusedSources.map(source => source.body).join('\n'), 2400) || '';
  const subjects = new Set(unique([...(options.subjectIds || []), options.kind === 'person' ? options.id : null, current.authorId,
    ...focusedSources.map(source => source.authorId)]));
  const projects = new Set(unique([...(options.projectIds || []), options.kind === 'project' ? options.id : null, ...(current.projectIds || []),
    roomId ? canonicalIdentity(roomId) : null]));
  const knownIds = new Set(sources.map(source => source.authorId));
  for (const row of rows) for (const id of [row.subjectId, ...(row.entityIds || [])]) knownIds.add(id);
  for (const contact of memory.store.contacts()) if (knownIds.has(contact.id) && person(contact.id)
    && (query.includes(contact.id) || query.includes(contact.id.replace(/^matrix:/, '')) || contact.aliases.some(alias => alias.length > 1 && query.includes(alias)))) subjects.add(contact.id);
  const scopes = options.scopes || (options.allScopes ? undefined : unique(['own', 'team', roomId ? `room:${roomId}` : current.scope]));
  return { current, roomId, query, subjects, projects, scopes, terms: tokens(query), eventIds };
}
function scoreOf(row, focus, store) {
  const preference = isPreference(row), subject = focus.subjects.has(canonicalIdentity(row.subjectId));
  const relevant = (subject ? preference ? 180 : 75 : 0) + (focus.projects.has(canonicalIdentity(row.subjectId)) ? 110 : 0)
    + (row.projectIds?.some(id => focus.projects.has(canonicalIdentity(id))) ? 90 : 0)
    + (row.entityIds?.some(id => focus.subjects.has(canonicalIdentity(id))) ? 50 : 0)
    + (row.scope === `room:${focus.roomId}` ? 35 : 0) + Math.min(60, lexical(`${row.text} ${row.predicate} ${row.topic || ''}`, focus.terms) * 6);
  return relevant ? relevant + (row.replaces ? 14 : 0) + (authority(store, row) === 'direct-human' ? 12 : 0) : 0;
}
const matchesProfile = (row, options, focus) => options.kind === 'person'
  ? focus.subjects.has(row.subjectId) || row.entityIds?.some(id => focus.subjects.has(id))
  : options.kind === 'project' ? focus.projects.has(row.subjectId) || row.projectIds?.some(id => focus.projects.has(id))
    || row.scope.startsWith('room:') && focus.projects.has(canonicalIdentity(row.scope.slice(5))) : true;
function identity(store, id) {
  const contact = store.getContact(id);
  return { id, name: short(contact?.name || id, 256), kind: contact?.kind || (project(id) ? 'project' : 'unknown'),
    ...(contact?.aliases ? { aliases: contact.aliases.slice(-6).map(alias => short(alias, 128)), aliasesTruncated: contact.aliases.length > 6 } : {}) };
}
function claimView(memory, row, currentRows) {
  const { store } = memory;
  const conflicts = row.predicate === 'note' ? [] : currentRows.filter(other => other.id !== row.id && other.scope === row.scope
    && other.subjectId === row.subjectId && other.predicate === row.predicate && other.text !== row.text).map(other => other.id);
  return { id: row.id, revision: row.revision, subjectId: row.subjectId, predicate: row.predicate, text: short(row.text, 1000),
    truncated: row.text.length > 1000, scope: row.scope, kind: row.kind, claimState: row.claimState || 'statement',
    facets: row.facets || [], entityIds: row.entityIds || [], projectIds: row.projectIds || [], saidBy: row.saidBy,
    authority: authority(store, row), learnedBy: row.botId, sharedAwareness: false,
    validFrom: row.validFrom, validUntil: row.validUntil, sourceRefs: row.sourceRefs, basisRefs: row.basisRefs || [],
    sources: row.sourceRefs.slice(0, 3).map(ref => sourceSummary(store.source(ref.id, ref.revision))),
    sourceCount: row.sourceRefs.length, conflicts, resolution: conflicts.length ? 'unresolved' : 'no-recorded-conflict',
    derivation: store.derivation(row), replaces: row.replaces || null };
}
function bounded(base, candidates, budgetChars) {
  const view = { ...base, budget: { maxChars: budgetChars, usedChars: 0, omitted: {} } };
  for (const key of ['workView', 'contextSources', 'toolSources']) if (JSON.stringify(view).length > budgetChars - 400) {
    delete view[key]; view.budget.omitted[key] = 1;
  }
  for (const key of Object.keys(candidates)) view[key] = [];
  // Interleave high-value sections so a large fact does not hide a fresh human
  // correction or every source pointer. A skipped item is counted explicitly.
  const order = ['currentClaims', 'recentSources', 'changes', 'people', 'preferences', 'projectFacts', 'speakerFacts', 'memoryPointers', 'pendingQuestions', 'historyGaps'];
  const maximum = Math.max(0, ...Object.values(candidates).map(rows => rows.length));
  for (let index = 0; index < maximum; index++) for (const key of order) {
    const item = candidates[key]?.[index]; if (!item) continue;
    view[key].push(item);
    if (JSON.stringify(view).length > budgetChars - 150) { view[key].pop(); view.budget.omitted[key] = (view.budget.omitted[key] || 0) + 1; }
  }
  for (let pass = 0; pass < 3; pass++) view.budget.usedChars = JSON.stringify(view).length;
  return view;
}

export function assembleAttentionView(memory, botId, options = {}) {
  const { store } = memory, sources = knownSources(memory, botId);
  const allRows = store.list({ botId, history: true }), focus = focusOf(memory, botId, options, allRows, sources);
  const eligible = allRows.filter(row => (!focus.scopes || focus.scopes.includes(row.scope)) && matchesProfile(row, options, focus));
  const ranked = eligible.map((row, index) => ({ row, index, score: scoreOf(row, focus, store) }))
    .filter(item => item.score > 0 || options.allScopes && !focus.subjects.size && !focus.projects.size)
    .sort((a,b) => b.score - a.score || b.row.validFrom - a.row.validFrom || a.index - b.index);
  const current = ranked.filter(item => store.derivation(item.row) === 'current').map(item => item.row);
  const claims = current.slice(0, 24).map(row => claimView(memory, row, current));
  const supporting = new Set(current.flatMap(row => row.sourceRefs.map(ref => ref.id)));
  const raw = sources.filter(source => source.derivation === 'current'
    && (options.kind === 'person' ? focus.subjects.has(source.authorId) || supporting.has(source.id)
      : options.kind === 'project' ? focus.projects.has(canonicalIdentity(source.roomId)) || source.projectIds?.some(id => focus.projects.has(id)) || supporting.has(source.id)
        : !focus.roomId || source.roomId === focus.roomId || focus.subjects.has(source.authorId) && options.allScopes)).sort((a,b) =>
    Number(focus.eventIds.has(b.eventId)) - Number(focus.eventIds.has(a.eventId))
    || Number(b.authorKind === 'human') - Number(a.authorKind === 'human')
    || b.timestamp - a.timestamp || (b.sequence || 0) - (a.sequence || 0)).slice(0, 8);
  const recentSources = raw.map(source => ({ ...sourceSummary(source), sequence: source.sequence, reviewed: source.reviewed,
    body: short(source.body, 800), truncated: source.body.length > 800,
    ...(source.eventKind === 'redaction-notice' ? { targetEventId: source.targetEventId, targetSourceId: source.targetSourceId } : {}),
    role: source.eventKind === 'redaction-notice' ? 'source-retraction-notice' : 'original-evidence-not-an-extracted-fact' }));
  const changes = ranked.filter(item => !['current', 'pending'].includes(store.derivation(item.row))).slice(0, 12).map(({ row }) => ({
    ...claimView(memory, row, current), text: short(row.text, 400), truncated: row.text.length > 400,
    supersededBy: row.supersededBy || null, requiresReview: true, basis: store.basisStatus(row),
  }));
  const people = unique([...focus.subjects, ...claims.flatMap(row => [row.subjectId, ...row.entityIds])]).filter(person).slice(0, 12).map(id => identity(store, id));
  const speaker = identity(store, focus.current.authorId || options.speakerId || 'unknown');
  const budgetChars = Math.max(4096, limit(options.budgetChars, 12000, 32000));
  const watermarks = store.watermarks(botId);
  const version = sha(canonical({ botId, roomId: focus.roomId, query: focus.query, watermarks,
    claims: claims.map(row => [row.id, row.revision, row.conflicts]), sources: recentSources.map(row => [row.id, row.revision]), changes,
    subjects: [...focus.subjects], projects: [...focus.projects], pendingQuestions: options.pendingQuestions || [] }));
  const base = { version, schemaVersion: 2, botId, sessionId: focus.current.sessionId, transport: focus.current.transport,
    self: { nativeBotId: botId, ...(options.self?.matrixId ? { matrixId: options.self.matrixId } : {}), ...(options.self?.name ? { name: short(options.self.name, 256) } : {}) }, scope: focus.roomId ? `room:${focus.roomId}` : 'own',
    roomId: focus.roomId || null, threadRootId: options.threadRootId || focus.current.threadRootId || null,
    authorId: focus.current.authorId || options.speakerId || null, sourceRefs: (focus.current.sourceRefs || []).slice(0, 8),
    contextSources: (focus.current.contextSources || []).slice(-4), toolSources: (focus.current.toolSources || []).slice(-4), speaker,
    watermarks, externalWatermark: options.watermark ? { sequence: options.watermark.sequence, eventId: options.watermark.eventId, roomId: options.watermark.roomId } : null,
    knowledgeBoundary: 'This is this Bot\'s source-attributed knowledge. Room scope is applicability, not proof that every member knows or agrees. Missing evidence is unknown. Task completion and delivery require the task/delivery runtime, not a memory summary.',
    selection: { eligibleClaims: ranked.length, currentClaims: current.length, knownSources: sources.length,
      strategy: 'identity-project-query-validity-changes', wholeHistoryLoaded: false },
    ...(options.workView && JSON.stringify(options.workView).length < budgetChars / 4 ? { workView: { providedBy: 'caller-runtime', data: options.workView } }
      : options.workView ? { workViewOmitted: 'runtime view exceeds memory context budget' } : {}),
  };
  const defaultGaps = [{ kind: 'coverage', text: 'Only observed events and this Bot\'s referenced evidence are available; no claim of complete room or member history.' }];
  for (const source of sources.filter(source => source.eventKind === 'redaction-notice' && !store.source(source.targetSourceId)
    && (!focus.roomId || source.roomId === focus.roomId)).slice(-4)) defaultGaps.push({ kind: 'unavailable-redaction-target',
      roomId: source.roomId, targetEventId: source.targetEventId, sourceRef: { id: source.id, revision: source.revision } });
  if (focus.current.history?.earlierMessagesOmitted) defaultGaps.push({ kind: 'earlier-messages', count: focus.current.history.earlierMessagesOmitted });
  return bounded(base, { currentClaims: claims, recentSources, changes, people,
    preferences: claims.filter(isPreference), projectFacts: claims.filter(row => focus.projects.has(row.subjectId) || row.projectIds.some(id => focus.projects.has(id))),
    speakerFacts: eligible.filter(row => row.subjectId === focus.current.authorId && claims.some(claim => claim.id === row.id)).map(row => claims.find(claim => claim.id === row.id)),
    memoryPointers: claims.filter(row => row.subjectId !== focus.current.authorId).map(({ id, revision, subjectId, predicate, scope }) => ({ id, revision, subjectId, predicate, scope })),
    pendingQuestions: (options.pendingQuestions || []).slice(0, 8).map(value => ({ providedBy: 'caller', value })),
    historyGaps: [...defaultGaps, ...(options.historyGaps || []).slice(0, 8)] }, budgetChars);
}

export function memoryProfiles(memory, botId, { kind = 'person', query = '', roomId, limit: requestedLimit } = {}) {
  if (!['person', 'project'].includes(kind)) throw new Error('MEMORY_PROFILE_KIND');
  const rows = memory.store.list({ botId, ...(roomId ? { scopes: ['own', 'team', `room:${roomId}`] } : {}), history: true });
  const sources = knownSources(memory, botId).filter(source => !roomId || source.roomId === roomId);
  const ids = kind === 'person' ? unique([...rows.flatMap(row => [row.subjectId, ...(row.entityIds || [])]), ...sources.map(source => source.authorId)]).filter(person)
    : unique([...rows.map(row => row.subjectId).filter(project), ...rows.flatMap(row => row.projectIds || []), ...sources.map(source => source.roomId && canonicalIdentity(source.roomId))]);
  const matches = ids.map(id => {
    const relevant = rows.filter(row => row.subjectId === id || (kind === 'person' ? row.entityIds : row.projectIds)?.includes(id));
    const entity = identity(memory.store, id);
    return { ...entity, kind, entityKind: entity.kind, currentCount: relevant.filter(row => memory.store.derivation(row) === 'current').length,
      historyCount: relevant.length, scopes: [...new Set(relevant.map(row => row.scope))] };
  }).filter(item => !query || `${item.id} ${item.name} ${item.aliases?.join(' ') || ''}`.toLowerCase().includes(query.toLowerCase()));
  const count = limit(requestedLimit, 50, 100);
  return { kind, items: matches.slice(0, count), more: matches.length > count };
}

export function memoryProfile(memory, botId, options = {}) {
  const id = canonicalIdentity(options.id);
  const known = memoryProfiles(memory, botId, { kind: options.kind, query: id, roomId: options.roomId, limit: 100 }).items.find(item => item.id === id);
  if (!known) throw new Error('MEMORY_PROFILE_NOT_KNOWN');
  const context = { ...(options.roomId ? { roomId: options.roomId, scope: `room:${options.roomId}` } : {}),
    ...(options.kind === 'person' ? { authorId: id } : {}) };
  return { kind: options.kind, id, identity: known, view: assembleAttentionView(memory, botId, { ...options, id,
    context, allScopes: !options.roomId, subjectIds: options.kind === 'person' ? [id] : [], projectIds: options.kind === 'project' ? [id] : [] }) };
}

export function reviewPacket(memory, botId, options = {}) {
  const sources = knownSources(memory, botId), rows = memory.store.list({ botId, history: true });
  const focus = focusOf(memory, botId, { ...options, allScopes: options.allScopes ?? !options.roomId }, rows, sources);
  const ranked = rows.filter(row => row.status === 'active' && (!focus.scopes || focus.scopes.includes(row.scope)) && matchesProfile(row, options, focus))
    .map(row => ({ row, score: scoreOf(row, focus, memory.store) })).filter(item => item.score > 0)
    .sort((a,b) => b.score - a.score || b.row.observedAt - a.row.observedAt);
  const selectedMemories = ranked.slice(0, limit(options.limitMemories, 24, 40)).map(({ row }) => row);
  const cited = new Set(selectedMemories.flatMap(row => row.sourceRefs.map(ref => ref.id)));
  const selectedSources = sources.filter(source => source.derivation === 'current' && (!focus.roomId || source.roomId === focus.roomId || cited.has(source.id)))
    .map(source => ({ source, score: (focus.subjects.has(source.authorId) ? 60 : 0) + (cited.has(source.id) ? 40 : 0)
      + (source.roomId === focus.roomId ? 20 : 0) + (focus.projects.has(canonicalIdentity(source.roomId)) || source.projectIds?.some(id => focus.projects.has(id)) ? 60 : 0)
      + lexical(source.body, focus.terms) * 5 })).filter(item => item.score > 0 || !focus.subjects.size && !focus.projects.size && !focus.query)
    .sort((a,b) => b.score - a.score || b.source.timestamp - a.source.timestamp || (b.source.sequence || 0) - (a.source.sequence || 0))
    .slice(0, limit(options.limitSources, 24, 40)).map(({ source }) => ({ ...source, body: short(source.body, 2400), truncated: source.body.length > 2400 }));
  const packet = { botId, purpose: 'bounded-on-demand-understanding-review', query: focus.query,
    subjectIds: [...focus.subjects], projectIds: [...focus.projects], sources: [], existingMemories: [], historicalEvidence: [],
    knowledgeBoundary: 'Revise only evidence-backed understanding. Proposed arrangements are not confirmed. No psychological diagnosis or invented private beliefs. Task/delivery status comes from runtime receipts. Source IDs/revisions and target versions are checked before publication.',
    version: sha(canonical({ sources: selectedSources.map(source => [source.id, source.revision]), memories: selectedMemories.map(row => [row.id, row.revision]) })) };
  const budget = Math.max(4000, limit(options.budgetChars, 24000, 48000));
  for (const row of selectedMemories) {
    packet.existingMemories.push({ ...row, derivation: memory.store.derivation(row), text: short(row.text, 2000), truncated: row.text.length > 2000 });
    if (JSON.stringify(packet).length > budget / 2) { packet.existingMemories.pop(); break; }
  }
  for (const source of selectedSources) { packet.sources.push(source); if (JSON.stringify(packet).length > budget) { packet.sources.pop(); break; } }
  for (const source of sources.filter(source => source.derivation !== 'current' && cited.has(source.id)).slice(0, 4)) {
    packet.historicalEvidence.push({ ...sourceSummary(source), body: short(source.body, 800), derivation: source.derivation,
      usableAsCurrentSource: false, currentRevision: source.currentRevision });
    if (JSON.stringify(packet).length > budget) { packet.historicalEvidence.pop(); break; }
  }
  return packet;
}
