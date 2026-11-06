import test from 'node:test';
import assert from 'node:assert/strict';
import { generateReviewWithBudget, prepareReviewBatch, prepareReviewProposal, validateReviewProposal } from '../memory/review.mjs';

const sources = [{ id: 'source_correction', eventId: '$changed', revision: 2 }];
const existingMemories = [{ id: 'memory_old', sourceRefs: [{ id: 'source_original', revision: 1 }] }];
const good = { op: 'forget', replaceId: 'memory_old', sourceIds: ['$changed'] };

test('an indivisible review increases output budget without accepting a truncated proposal', async () => {
  const calls = [], changes = [], complete = '{"changes":[]}';
  const result = await generateReviewWithBudget({ generate: async maxTokens => {
    calls.push(maxTokens);
    if (maxTokens === 8192) throw Object.assign(new Error('truncated JSON'), { code: 'MEMORY_OUTPUT_LIMIT' });
    return complete;
  }, onOutputLimit: ({ maxTokens, nextMaxTokens }) => changes.push([maxTokens, nextMaxTokens]) });
  assert.equal(result, complete);
  assert.deepEqual(calls, [8192, 16384]);
  assert.deepEqual(changes, [[8192, 16384]]);
});

test('a calibrated review budget is reused and truncation stops at the finite cap', async () => {
  const calls = [], error = Object.assign(new Error('still truncated'), { code: 'MEMORY_OUTPUT_LIMIT' });
  await assert.rejects(generateReviewWithBudget({ initialMaxTokens: 16384, generate: async limit => {
    calls.push(limit); throw error;
  } }), value => value === error);
  assert.deepEqual(calls, [16384, 32768]);
});

test('quota and invalid proposals are not retried with a larger output budget', async () => {
  for (const code of ['MODEL_QUOTA_EXCEEDED', 'MEMORY_REVIEW_INVALID', 'NETWORK']) {
    let calls = 0; const error = Object.assign(new Error(code), { code });
    await assert.rejects(generateReviewWithBudget({ generate: async () => { calls++; throw error; } }), value => value === error);
    assert.equal(calls, 1);
  }
});
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

test('truncated reviews shrink their source prefix without acknowledging the rest', async () => {
  const refs = Array.from({length:8}, (_,i) => ({id:`source_${i}`,revision:i+1}));
  const attempts=[], limits=[];
  const result=await prepareReviewBatch({refs,
    prepare:async batch=>{
      attempts.push(batch.map(row=>row.id));
      return prepareReviewProposal({input:{sources:batch,existingMemories:[]},generate:async()=>{
        if(batch.length>2)throw Object.assign(new Error('incomplete JSON at output ceiling'),{code:'MEMORY_OUTPUT_LIMIT'});
        return JSON.stringify({changes:batch.map(ref=>({op:'add',text:`fact ${ref.id}`,sourceIds:[ref.id]}))});
      }});
    },onOutputLimit:event=>limits.push(event.next.length)});
  assert.deepEqual(attempts.map(rows=>rows.length),[8,4,2]);
  assert.deepEqual(limits,[4,2]);
  assert.deepEqual(result.refs,refs.slice(0,2));
  assert.deepEqual(result.value.map(change=>change.sourceRefs[0]),refs.slice(0,2));
  assert.equal(refs.length,8);
  assert.deepEqual(refs.slice(result.refs.length).map(row=>row.id),['source_2','source_3','source_4','source_5','source_6','source_7']);
});

test('single-source truncation and unrelated errors stay failed without speculative retries', async () => {
  for(const [refs,code] of [[sources,'MEMORY_OUTPUT_LIMIT'],[[...sources,...sources],'QUOTA'],[[...sources,...sources],'NETWORK']]) {
    let calls=0;
    await assert.rejects(prepareReviewBatch({refs,prepare:async()=>{calls++;throw Object.assign(new Error(code),{code});}}),error=>error.code===code);
    assert.equal(calls,1);
  }
});

test('a smaller successful prefix leaves later corrections for their own validated review', async () => {
  const refs=[{id:'source_first',revision:1},{id:'source_fix',revision:3},{id:'source_tail',revision:1}];
  let pending=refs.slice();const completed=[];
  while(pending.length){
    const result=await prepareReviewBatch({refs:pending,prepare:async batch=>{
      if(batch.length>1)throw Object.assign(new Error('output ceiling'),{code:'MEMORY_OUTPUT_LIMIT'});
      return validateReviewProposal({changes:batch.map(ref=>({op:'add',text:`fact ${ref.id}`,sourceIds:[ref.id]}))},batch);
    }});
    completed.push(...result.value.flatMap(change=>change.sourceRefs));
    pending=pending.filter(ref=>!result.refs.some(done=>done.id===ref.id&&done.revision===ref.revision));
  }
  assert.deepEqual(completed,refs);
});
