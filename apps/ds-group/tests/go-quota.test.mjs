import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readGoQuota} from '../scripts/go-quota.mjs';
async function profile(t) {
  const home=await mkdtemp(path.join(os.tmpdir(),'dscord-quota-test-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(path.join(home,'profiles/web'),{recursive:true});
  await writeFile(path.join(home,'profiles/web/cordis.patch.yml'),'- id: llm-pi-ai\n  config:\n    providers:\n      opencode-go:\n        apiKeyEnv: GO_TEST\n');
  await writeFile(path.join(home,'.credentials.yaml'),'refs:\n  GO_TEST: synthetic-go-credential\n');
  return home;
}
const usage=()=>({rolling:{status:'ok',percent:5,resetsAt:'2026-11-06T19:00:00Z'},
  weekly:{status:'ok',percent:50,resetsAt:'2026-11-09T00:00:00Z'},monthly:{status:'ok',percent:53,resetsAt:'2026-11-28T00:00:00Z'}});
test('allowance preflight checks the configured credential without returning it',async t=>{
  const home=await profile(t);let requests=0;
  const result=await readGoQuota(home,{fetchImpl:async(url,options)=>{
    requests++;assert.equal(url,'https://opencode.ai/zen/go/v1/usage');
    assert.equal(options.headers.authorization,'Bearer synthetic-go-credential');
    return Response.json({usage:usage()});
  }});
  assert.equal(requests,1);assert.equal(result.available,true);assert.equal(result.resetAt,null);
  assert.equal(JSON.stringify(result).includes('synthetic-go-credential'),false);
});
test('weekly exhaustion blocks even when the short window is available',async t=>{
  const home=await profile(t),windows=usage();windows.weekly.status='rate-limited';windows.weekly.percent=100;
  const result=await readGoQuota(home,{fetchImpl:async()=>Response.json({usage:windows})});
  assert.equal(result.available,false);assert.deepEqual(result.blockedWindows,['weekly']);
  assert.equal(result.resetAt,windows.weekly.resetsAt);
});
test('a missing or failed allowance response does not silently permit a run',async t=>{
  const home=await profile(t);
  await assert.rejects(readGoQuota(home,{fetchImpl:async()=>new Response(null,{status:401})}),/HTTP 401/);
  await assert.rejects(readGoQuota(home,{fetchImpl:async()=>Response.json({usage:{}})}),/Unrecognized/);
});
