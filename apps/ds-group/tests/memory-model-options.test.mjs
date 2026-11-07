import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryModelOptions} from '../memory/model-options.mjs';
test('memory review omits an unsupported effort on a custom model while preserving its exact provider route',async()=>{
  const options=await memoryModelOptions({resolveModelInfo:async(provider,model)=>{assert.equal(provider,'commandcode-goat');assert.equal(model,'deepseek/deepseek-v4.1-flash');return{context:1000000};}},'commandcode-goat/deepseek/deepseek-v4.1-flash');
  assert.deepEqual(options,{provider:'commandcode-goat',model:'deepseek/deepseek-v4.1-flash'});
});
test('memory review retains low when advertised and does not invent a fallback effort',async()=>{
  for(const efforts of [[{id:'low'},{id:'high'}],[{id:'high'}]]){
    const options=await memoryModelOptions({resolveModelInfo:async()=>({reasoning:{efforts}})},'opencode-go/deepseek-v4.1-flash');
    assert.equal(options.reasoningEffort,efforts.some(row=>row.id==='low')?'low':undefined);
  }
});
test('memory model metadata receives the same cancellation signal as background review', async () => {
  const controller = new AbortController();
  const options = await memoryModelOptions({ resolveModelInfo: async (provider, model, signal) => {
    assert.equal(signal, controller.signal); return {};
  } }, 'local-lifecycle/model', controller.signal);
  assert.deepEqual(options, { provider: 'local-lifecycle', model: 'model' });
});
