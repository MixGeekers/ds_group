import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ORIGINAL_TEST_MODEL,COMMANDCODE_TEST_MODEL,memoryTestModel,restrictTestProvider,testModelSelection} from '../scripts/memory-test-model.mjs';
import {readCommandCodeCatalog} from '../scripts/commandcode-preflight.mjs';

test('real test routes allow the two authorized ordinary models and reject Fast before any call',()=>{
  assert.equal(memoryTestModel(ORIGINAL_TEST_MODEL),ORIGINAL_TEST_MODEL);
  assert.equal(memoryTestModel(COMMANDCODE_TEST_MODEL),COMMANDCODE_TEST_MODEL);
  for(const model of [COMMANDCODE_TEST_MODEL+'-fast','commandcode-goat/deepseek/deepseek-v4-flash','other/deepseek-v4.1-flash'])assert.throws(()=>memoryTestModel(model),/NOT_AUTHORIZED/);
  const provider={api:'openai-completions',models:[{id:'deepseek/deepseek-v4.1-flash'},{id:'deepseek/deepseek-v4.1-flash-fast'}]};
  assert.deepEqual(restrictTestProvider(provider,COMMANDCODE_TEST_MODEL).models,[{id:'deepseek/deepseek-v4.1-flash'}]);assert.equal(provider.models.length,2);
  assert.throws(()=>restrictTestProvider({models:[{id:'deepseek/deepseek-v4.1-flash-fast'}]},COMMANDCODE_TEST_MODEL),/MISSING/);
});
test('native test selection uses only thinking settings actually advertised by DSH',async()=>{
  const noEfforts=await testModelSelection({resolveModelInfo:async(provider,model)=>{assert.equal(provider,'commandcode-goat');assert.equal(model,'deepseek/deepseek-v4.1-flash');return{};}},COMMANDCODE_TEST_MODEL);
  assert.equal(noEfforts.reasoningEffort,undefined);
  const supportsLow=await testModelSelection({resolveModelInfo:async()=>({reasoning:{efforts:[{id:'low'}]}})},COMMANDCODE_TEST_MODEL);
  assert.equal(supportsLow.reasoningEffort,'low');assert.equal(supportsLow.model,COMMANDCODE_TEST_MODEL);
});
test('CommandCode preflight distinguishes a model listing from known allowance and excludes Fast-only catalogs',async t=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'dscord-commandcode-'));t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(path.join(home,'profiles/web'),{recursive:true});
  await writeFile(path.join(home,'profiles/web/cordis.patch.yml'),JSON.stringify([{id:'llm-pi-ai',config:{providers:{'commandcode-goat':{baseURL:'https://api.commandcode.ai/provider/v1',apiKeyEnv:'SYNTHETIC'}}}}]));
  await writeFile(path.join(home,'.credentials.yaml'),JSON.stringify({refs:{SYNTHETIC:'test-only-credential'}}));
  const read=async data=>readCommandCodeCatalog(home,{fetchImpl:async(url,options)=>{assert.equal(url,'https://api.commandcode.ai/provider/v1/models');assert.equal(options.headers.authorization,'Bearer test-only-credential');return Response.json({data});}});
  const good=await read([{id:'deepseek/deepseek-v4.1-flash',context_length:1000000}]);assert.equal(good.available,true);assert.equal(good.allowanceKnown,false);assert.equal(JSON.stringify(good).includes('test-only-credential'),false);
  assert.equal((await read([{id:'deepseek/deepseek-v4.1-flash-fast'}])).available,false);
  await assert.rejects(readCommandCodeCatalog(home,{fetchImpl:async()=>new Response(null,{status:401})}),/HTTP 401/);
});
