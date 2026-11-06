import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingMaintenance} from '../scripts/collaboration-maintenance.mjs';

const plan={compactions:[24,48,72,88],restarts:[32,64,88]};
test('a stopped boundary resumes missing maintenance in order without replaying successful work',()=>{
  const records=[{type:'native-compaction',round:24,result:{compacted:true}},
    {type:'native-compaction',round:88,result:{compacted:false}},
    {type:'recovery-restart',round:88,identitiesPreserved:true}];
  assert.deepEqual(pendingMaintenance(24,plan,records),[]);
  assert.deepEqual(pendingMaintenance(88,plan,records),[{type:'compact',index:0},{type:'restart'}]);
  records.push({type:'native-compaction',round:88,result:{compacted:true}});
  assert.deepEqual(pendingMaintenance(88,plan,records),[{type:'restart'}]);
  records.push({type:'planned-restart',round:88,identitiesPreserved:true});
  assert.deepEqual(pendingMaintenance(88,plan,records),[]);
});
test('recovery cannot backfill an earlier missed boundary after later messages',()=>{
  assert.deepEqual(pendingMaintenance(25,plan,[]),[]);
  assert.deepEqual(pendingMaintenance(32,plan,[]),[{type:'restart'}]);
  assert.deepEqual(pendingMaintenance(48,plan,[]),[{type:'compact',index:1}]);
});
