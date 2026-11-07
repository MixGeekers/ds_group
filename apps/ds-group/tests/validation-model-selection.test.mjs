import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { visibleEnvironmentModelSettings } from '../scripts/memory-visible-environment.mjs';

test('service model policy is optional or caller-defined, with no vendor restriction',()=>{
  assert.deepEqual(visibleEnvironmentModelSettings({model:null}),{model:null,allowedModels:null});
  assert.deepEqual(visibleEnvironmentModelSettings({model:'own/team/fast'}),{model:'own/team/fast',allowedModels:['own/team/fast']});
  assert.deepEqual(visibleEnvironmentModelSettings({model:'own/team/fast',allowedModels:null}),{model:'own/team/fast',allowedModels:null});
  assert.throws(()=>visibleEnvironmentModelSettings({model:'own/team/fast',allowedModels:['local/model']}),/selected model/);
  assert.throws(()=>visibleEnvironmentModelSettings({model:'invalid'}),{code:'INVALID_MODEL'});
});

test('no configured model fails before preparing a home, resolving DSH or contacting a service',async()=>{
  const env={...process.env};delete env.DSCORD_MEMORY_TEST_MODEL;delete env.DS_GROUP_MODEL;
  const source=`
    import assert from 'node:assert/strict';
    import {access} from 'node:fs/promises';
    import {MODEL,memoryTestModel} from './scripts/memory-test-model.mjs';
    import {MemoryTestHost} from './scripts/memory-host.mjs';
    import {NaturalLiveAdapter} from './scripts/platform-natural-live.mjs';
    const directory='/tmp/dscord-no-model-'+process.pid;
    globalThis.fetch=()=>{throw new Error('Unexpected service request');};
    assert.equal(MODEL,null);
    assert.throws(()=>memoryTestModel(),{code:'TEST_MODEL_REQUIRED'});
    const host=new MemoryTestHost(directory);
    for(const action of ['prepare','configureModel','start'])await assert.rejects(host[action](),{code:'TEST_MODEL_REQUIRED'});
    await assert.rejects(access(directory),{code:'ENOENT'});
    const adapter=new NaturalLiveAdapter({environment:{},directory,corpus:{}});
    await assert.rejects(adapter.initialize(),{code:'TEST_MODEL_REQUIRED'});
  `;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',source],{cwd:new URL('..',import.meta.url),env,timeout:10000});
});
