import test from 'node:test';
import assert from 'node:assert/strict';
import { findMentionQuery, mentionCandidates, mentionParts, mentionToken } from '../web/mention-editor.js';

const roster = {
  members: [
    { id: '@alice:example.test', name: 'Alice', localpart: 'alice', kind: 'human' },
    { id: '@finance:example.test', name: '小雨 · 财务', localpart: 'finance', kind: 'bot' },
  ],
  roles: [
    { id: 'finance-team', name: '财务组', color: '#00aaff', mentionable: true },
    { id: 'hidden-role', name: '管理员', mentionable: false },
  ],
  canMentionEveryone: true,
  canMentionHere: true,
};

test('mention completion recognizes caret-local Unicode queries and rejects code, escaped mentions and emails', () => {
  assert.deepEqual(findMentionQuery('请问 @小雨 · 财'), { start: 3, end: 10, query: '小雨 · 财' });
  assert.deepEqual(findMentionQuery('(@fi) text', 4), { start: 1, end: 4, query: 'fi' });
  for (const value of ['name@example.test', '\\@alice', '`@alice', '```js\n@alice', '~~~\n@alice', 'https://site/@alice', '<@@alice:example.test>']) {
    assert.equal(findMentionQuery(value), null, value);
  }
  assert.equal(findMentionQuery('`code` @ali').query, 'ali');
});

test('suggestions search names and handles, filter nonmentionable roles and retain stable member IDs', () => {
  assert.equal(mentionCandidates(roster, 'FIN').at(0).id, '@finance:example.test');
  assert.equal(mentionCandidates(roster, '财务').length, 2);
  assert.equal(mentionCandidates(roster).some(item => item.id === 'hidden-role'), false);
  const owner = { ...roster, roles: roster.roles.map(role => ({ ...role, canMention: true })) };
  assert.equal(mentionCandidates(owner).some(item => item.id === 'hidden-role'), true);
  assert.equal(mentionCandidates({ ...roster, canMentionEveryone: false, canMentionHere: false }).some(item => ['everyone', 'here'].includes(item.kind)), false);
  assert.equal(mentionToken(mentionCandidates(roster, 'FIN')[0]), '<@@finance:example.test>');
  assert.equal(mentionToken(mentionCandidates(roster, '财务组')[0]), '<@&finance-team>');
});

test('message rendering resolves renamed members while code and escaped mentions stay plain text', () => {
  const renamed = { ...roster, members: [{ ...roster.members[0], name: 'Alice New' }] };
  const body = '<@@alice:example.test> <@&finance-team> `@everyone` \\@here';
  const parts = mentionParts(body, renamed);
  assert.equal(parts[0].text, '@Alice New');
  assert.equal(parts[0].token, '<@@alice:example.test>');
  assert.equal(parts.filter(part => part.kind !== 'text').length, 2);
  assert.equal(parts.map(part => part.token || part.text).join(''), body);
});
