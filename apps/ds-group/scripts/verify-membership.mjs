#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { localPath, packageRoot } from '../src/paths.mjs';
import { MatrixClient } from '../src/matrix-client.mjs';

const setup = JSON.parse(await readFile(localPath('matrix-setup.json'), 'utf8'));
const members = Object.fromEntries(setup.participants.map(person => [person.localpart, person]));
const base = 'http://127.0.0.1:18100';
async function api(user, endpoint, method = 'GET', body) {
  const response = await fetch(base + endpoint, { method,
    headers: { Authorization: `Bearer ${members[user].accessToken}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, value: await response.json() };
}
const evidence = { schemaVersion: 1, startedAt: new Date().toISOString(), scope: 'real-Matrix-ownership-group-invite-and-one-real-Bot-reply', checks: [] };
try {
  const alice = await api('alice', '/api/bots');
  const bob = await api('bob', '/api/bots');
  assert.equal(alice.value.bots.length, 2);
  assert.equal(bob.value.bots.length, 0);
  evidence.checks.push({ name: 'one human owns two independent Bots', passed: true, ownerId: members.alice.id, botIds: alice.value.bots.map(bot => bot.id) });
  const group = await api('alice', '/api/rooms', 'POST', { name: '入职协作', inviteIds: [members.bob.id] });
  assert.equal(group.status, 200);
  const roomId = group.value.roomId;
  const denied = await api('bob', `/api/rooms/${encodeURIComponent(roomId)}/invite`, 'POST', { participantId: members.hr.id });
  assert.equal(denied.status, 403);
  for (let attempt = 0; attempt < 2; attempt++) {
    const invite = await api('alice', `/api/rooms/${encodeURIComponent(roomId)}/invite`, 'POST', { participantId: members.finance.id });
    assert.equal(invite.status, 200);
    assert.equal(invite.value.status, 'joined');
  }
  const rooms = await api('alice', '/api/rooms');
  const created = rooms.value.rooms.find(room => room.roomId === roomId);
  assert.deepEqual(new Set(created.participantIds), new Set([members.alice.id, members.bob.id, members.finance.id]));
  evidence.checks.push({ name: 'owner invites own Bot into a new group idempotently', passed: true, roomId, memberIds: created.participantIds, otherOwnerInviteStatus: denied.status });
  const message = await api('alice', `/api/rooms/${encodeURIComponent(roomId)}/messages`, 'POST', {
    body: '欢迎加入我们的入职协作群。请计算两份材料、每份15元，一共多少元？', to: [members.finance.id], transactionId: `membership-${randomUUID()}`,
  });
  assert.equal(message.status, 200);
  const client = new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: members.alice.accessToken });
  let answer;
  for (let attempt = 0; attempt < 240; attempt++) {
    answer = (await client.timeline(roomId, 100)).find(event => event.sender === members.finance.id && event.content?.['org.ds_group']?.replyTo === message.value.event_id);
    if (answer) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(answer, 'Invited Bot should answer in the newly joined room');
  assert.match(answer.content.body, /30/);
  evidence.checks.push({ name: 'invited Bot participates with its own identity and replies in the new room', passed: true, roomId,
    humanEventId: message.value.event_id, botEventId: answer.event_id, replyText: answer.content.body });
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error.message;
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  await writeFile(path.join(packageRoot, 'artifacts', 'membership-flow.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}
