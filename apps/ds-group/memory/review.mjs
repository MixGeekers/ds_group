const fail = (code, index) => { throw new Error(`${code}${index === undefined ? '' : ` at changes[${index}]`}`); };

export function validateReviewProposal(result, sources, existingMemories = []) {
  if (!Array.isArray(result?.changes)) fail('MEMORY_REVIEW_INVALID');
  const known = new Set(existingMemories.map(row => row.id));
  // Validate the whole proposal before a caller applies any mutation.
  return result.changes.map((change, index) => {
    if (!change || !['add', 'replace', 'forget'].includes(change.op)) fail('MEMORY_REVIEW_OPERATION', index);
    if (change.op !== 'add' && !known.has(change.replaceId)) fail('MEMORY_REVIEW_TARGET', index);
    if (!Array.isArray(change.sourceIds) || !change.sourceIds.length) fail('MEMORY_REVIEW_SOURCE', index);
    const refs = change.sourceIds.map(id => {
      if (typeof id !== 'string') fail('MEMORY_REVIEW_SOURCE', index);
      const matches = sources.filter(source => source.id === id || source.eventId === id);
      if (matches.length !== 1) fail('MEMORY_REVIEW_SOURCE', index);
      return { id: matches[0].id, revision: matches[0].revision };
    });
    if (change.op !== 'forget' && (typeof change.text !== 'string' || !change.text.trim())) fail('MEMORY_REVIEW_TEXT', index);
    const sourceRefs = [...new Map(refs.map(ref => [`${ref.id}:${ref.revision}`, ref])).values()];
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
        instruction: 'Return the complete corrected JSON proposal. Every change, including forget, must cite exact IDs from the current sources array. For forget cite the current correction, not the old memory evidence. Use only listed existingMemories IDs for replaceId. Omit unsupported or unchanged claims; do not invent a source. Nothing from this invalid proposal has been applied.' };
    }
  }
}
