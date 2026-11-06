import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReviewProposal, validateReviewProposal } from '../memory/review.mjs';

const sources = [{ id: 'source_correction', eventId: '$changed', revision: 2 }];
const existingMemories = [{ id: 'memory_old', sourceRefs: [{ id: 'source_original', revision: 1 }] }];
const good = { op: 'forget', replaceId: 'memory_old', sourceIds: ['$changed'] };
test('cancellation cites its new correction and preserves the exact reviewed revision', () => {
  assert.deepEqual(validateReviewProposal({ changes: [good] }, sources, existingMemories)[0].sourceRefs, [{ id: 'source_correction', revision: 2 }]);
  for (const sourceIds of [undefined, [], ['source_original']]) assert.throws(() => validateReviewProposal({ changes: [{ ...good, sourceIds }] }, sources, existingMemories), /MEMORY_REVIEW_SOURCE/);
  assert.throws(() => validateReviewProposal({ changes: [{ ...good, replaceId: 'invented' }] }, sources, existingMemories), /MEMORY_REVIEW_TARGET/);
});
test('invalid late cancellation rejects the full proposal and supplies actionable feedback once', async () => {
  const inputs = [], proposals = [], errors = [];
  const changes = await prepareReviewProposal({ input: { sources, existingMemories },
    generate: async input => { inputs.push(input); return JSON.stringify({ changes: inputs.length === 1
      ? [{ op: 'add', text: 'new arrangement', sourceIds: ['$changed'] }, { ...good, sourceIds: ['source_original'] }] : [good] }); },
    onProposal: value => proposals.push(value), onInvalid: error => errors.push(error.message) });
  assert.equal(inputs.length, 2); assert.match(inputs[1].validationError.error, /changes\[1\]/);
  assert.match(inputs[1].validationError.instruction, /Nothing.*has been applied/);
  assert.equal(changes.length, 1); assert.equal(changes[0].op, 'forget');
  assert.equal(proposals.length, 2); assert.equal(errors.length, 1);
});
test('malformed JSON and persistent invalid proposals never become successful empty reviews', async () => {
  let calls = 0;
  await assert.rejects(prepareReviewProposal({ input: { sources, existingMemories }, generate: async () => { calls++; return 'invalid'; } }), SyntaxError);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(prepareReviewProposal({ input: { sources, existingMemories }, generate: async () => { calls++; return JSON.stringify({ changes: [{ ...good, sourceIds: [] }] }); } }), /MEMORY_REVIEW_SOURCE/);
  assert.equal(calls, 2);
});

test('a scope relocation cannot partially fail after applying earlier changes', async () => {
  const old={id:'memory_old',scope:'room:!a:test',subjectId:'matrix:@lin:test',text:'Use short Chinese reports',sourceRefs:[{id:'source_correction',revision:2}]};
  const move={op:'replace',replaceId:old.id,scope:'own',subjectId:old.subjectId,text:old.text,sourceIds:['$changed']};
  assert.throws(()=>validateReviewProposal({changes:[move]},sources,[old]),/MEMORY_REVIEW_SCOPE/);
  let calls=0;
  const changes=await prepareReviewProposal({input:{sources,existingMemories:[old]},generate:async input=>{
    calls++;
    if(calls===1)return JSON.stringify({changes:[move]});
    assert.match(input.validationError.instruction,/add it in own and forget/);
    return JSON.stringify({changes:[{...move,op:'add',replaceId:undefined},good]});
  }});
  assert.deepEqual(changes.map(x=>x.op),['add','forget']);
  assert.throws(()=>validateReviewProposal({changes:[good,good]},sources,[old]),/MEMORY_REVIEW_DUPLICATE_TARGET/);
});
