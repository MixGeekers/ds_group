import test from 'node:test';
import assert from 'node:assert/strict';
import { BotNode, deliveriesFor, parseBotOutput } from '../src/bot-node.mjs';
import { botInstructions } from '../dsh-plugin/runtime-rules.mjs';

test('Bot instructions and delegation retain the configured Matrix server name', () => {
  const participants = [
    { id: '@alice:chat.example.org:8448', localpart: 'alice', name: 'Alice', kind: 'human' },
    { id: '@finance:chat.example.org:8448', localpart: 'finance', name: 'Finance', kind: 'bot' },
    { id: '@hr:chat.example.org:8448', localpart: 'hr', name: 'HR', kind: 'bot' },
  ];
  const hr = participants[2];
  const finance = participants[1];
  const instructions = botInstructions(BotNode.prototype.instructions.call({ participant: hr, participants }));
  assert.ok(instructions.includes(finance.id));
  assert.ok(instructions.includes(hr.id));
  assert.equal(instructions.includes('ds-group.local'), false);

  const output = parseBotOutput(JSON.stringify({
    text: '请财务核对预算', delegate: { to: finance.id, body: '核对两份 75 元的预算' },
  }), hr.id, participants);
  const event = { event_id: '$request', room_id: '!private:chat.example.org:8448', sender: participants[0].id, content: {} };
  const deliveries = deliveriesFor(event, output, hr.id, participants, '!team:chat.example.org:8448');
  assert.deepEqual(deliveries[1].options.to, [finance.id]);
  assert.equal(deliveries[1].roomId, '!team:chat.example.org:8448');
  assert.equal(deliveries[1].options.originRoomId, event.room_id);
  assert.throws(() => parseBotOutput(JSON.stringify({
    text: '旧服务器', delegate: { to: '@finance:ds-group.local', body: '预算' },
  }), hr.id, participants), /registered Bot/);
});
