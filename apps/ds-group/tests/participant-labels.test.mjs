import test from 'node:test';
import assert from 'node:assert/strict';
import {withRoomDisplayNames} from '../src/participant-labels.mjs';
test('room renames remain labels on exact accounts and cannot change authority',()=>{
  const first={id:'@lin_a:test',name:'林青',kind:'human'},second={id:'@lin_b:test',name:'林青',kind:'human'};
  const bot={id:'@bot:test',name:'识雨',kind:'bot',ownerId:first.id};
  const result=withRoomDisplayNames([first,second,bot],{
    [first.id]:{display_name:'青禾',kind:'bot',id:second.id,ownerId:second.id},
    [second.id]:{display_name:'林青'},[bot.id]:{display_name:'新昵称',ownerId:second.id},
    '@not-admitted:test':{display_name:'extra'},
  });
  assert.deepEqual(result,[{...first,name:'青禾'},second,{...bot,name:'新昵称'}]);
  assert.equal(first.name,'林青');assert.equal(bot.ownerId,first.id);
  assert.deepEqual(withRoomDisplayNames([first,second],{[first.id]:{display_name:'  '}}),[first,second]);
});
