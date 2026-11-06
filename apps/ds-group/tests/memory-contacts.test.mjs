import test from 'node:test';
import assert from 'node:assert/strict';
import { contactReadView } from '../memory/contacts.mjs';

test('long identity histories do not crowd routine model input or merge people with equal names', () => {
  const rows = ['a', 'b'].map((id, index) => ({ id: `matrix:@${id}:test`, name: index ? '林青' : '青禾',
    kind: 'human', aliases: index ? ['林青'] : ['林青', '青禾'], nameAt: 99,
    observations: Array.from({ length: 100 }, (_, at) => ({ name: at < 50 ? '林青' : index ? '林青' : '青禾',
      kind: 'human', at, source: { eventId: `event-${at}`, roomId: 'room' } })).reverse() }));
  const before = JSON.stringify(rows), view = contactReadView(rows);
  assert.equal(view.length, 2);
  assert.deepEqual(view.map(row => row.id), ['matrix:@a:test', 'matrix:@b:test']);
  assert.deepEqual(view[0].aliases, ['林青', '青禾']);
  assert.equal(view[0].latestObservation.source.eventId, 'event-99');
  assert.equal(view[0].retainedObservationCount, 100);
  assert.ok(JSON.stringify(view).length < before.length / 10);
  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual(contactReadView(rows, { history: true }), rows);
});

test('contacts without observations retain owner, current identity and aliases', () => {
  const [bot] = contactReadView([{ id: 'matrix:@bot:test', name: '识雨', aliases: ['识雨'], kind: 'bot', ownerId: 'matrix:@a:test' }]);
  assert.equal(bot.ownerId, 'matrix:@a:test');
  assert.equal(bot.retainedObservationCount, 0);
  assert.equal(bot.latestObservation, undefined);
});
