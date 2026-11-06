import { canonicalIdentity, canonical } from './store.mjs';
const fail = (code, index) => { throw new Error(`${code}${index === undefined ? '' : ` at changes[${index}]`}`); };

// A truncated proposal cannot be parsed or committed. Retry a smaller prefix;
// the caller acknowledges only the returned refs and keeps the rest pending.
export async function prepareReviewBatch({ refs, prepare, onOutputLimit = () => {} }) {
  let batch = refs.slice();
  for (;;) {
    try { return { refs: batch, value: await prepare(batch) }; }
    catch (error) {
      if (error.code !== 'MEMORY_OUTPUT_LIMIT' || batch.length < 2) throw error;
      const smaller = batch.slice(0, Math.ceil(batch.length / 2));
      onOutputLimit({ error, attempted: batch, next: smaller });
      batch = smaller;
    }
  }
}

export function validateReviewProposal(result, sources, existingMemories = []) {
  if (!Array.isArray(result?.changes)) fail('MEMORY_REVIEW_INVALID');
  const known = new Map(existingMemories.map(row => [row.id,row])), modified = new Set();
  // Validate the whole proposal before a caller applies any mutation.
  return result.changes.map((change, index) => {
    if (!change || !['add', 'replace', 'forget'].includes(change.op)) fail('MEMORY_REVIEW_OPERATION', index);
    if (change.op !== 'add' && !known.has(change.replaceId)) fail('MEMORY_REVIEW_TARGET', index);
    if (change.op !== 'add') {
      if (modified.has(change.replaceId)) fail('MEMORY_REVIEW_DUPLICATE_TARGET', index);
      modified.add(change.replaceId);
    }
    if (!Array.isArray(change.sourceIds) || !change.sourceIds.length) fail('MEMORY_REVIEW_SOURCE', index);
    const refs = change.sourceIds.map(id => {
      if (typeof id !== 'string') fail('MEMORY_REVIEW_SOURCE', index);
      const matches = sources.filter(source => source.id === id || source.eventId === id);
      if (matches.length !== 1) fail('MEMORY_REVIEW_SOURCE', index);
      return { id: matches[0].id, revision: matches[0].revision };
    });
    if (change.op !== 'forget' && (typeof change.text !== 'string' || !change.text.trim())) fail('MEMORY_REVIEW_TEXT', index);
    const sourceRefs = [...new Map(refs.map(ref => [`${ref.id}:${ref.revision}`, ref])).values()];
    if (change.op === 'replace') {
      const previous = known.get(change.replaceId);
      if (change.scope && previous.scope && change.scope !== previous.scope) fail('MEMORY_REVIEW_SCOPE', index);
      const sorted = refs => [...(refs||[])].sort((a,b)=>a.id.localeCompare(b.id)||a.revision-b.revision);
      const metadataOnly = previous.text === change.text && canonical(sorted(previous.sourceRefs)) === canonical(sorted(sourceRefs));
      if (change.subjectId && previous.subjectId && canonicalIdentity(change.subjectId) !== canonicalIdentity(previous.subjectId) && !metadataOnly) fail('MEMORY_REVIEW_SUBJECT', index);
    }
    return { ...change, sourceIds: sourceRefs.map(ref => ref.id), sourceRefs };
  });
}

export async function prepareReviewProposal({ input, generate, onProposal = () => {}, onInvalid = () => {} }) {
  let validationError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await generate({ ...input, ...(validationError ? { validationError } : {}) });
    let result;
    try {
      result = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      onProposal(result, attempt);
      return validateReviewProposal(result, input.sources, input.existingMemories);
    } catch (error) {
      onInvalid(error, attempt);
      if (attempt) throw error;
      validationError = { error: error.message, previousProposal: result || raw.slice(0, 12000),
        instruction: 'Return the complete corrected JSON proposal. Every change, including forget, must cite exact IDs from the current sources array. For forget cite the current correction, not the old memory evidence. Use only listed existingMemories IDs for replaceId, and modify each target at most once. Replace preserves scope and subject; to move a general personal preference from a room to own, add it in own and forget the old room entry, both citing its actual current source. Omit unsupported or unchanged claims; do not invent a source. Nothing from this invalid proposal has been applied.' };
    }
  }
}
