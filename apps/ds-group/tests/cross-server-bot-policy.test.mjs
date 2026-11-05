import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BotWorkService } from '../src/bot-work.mjs';
import { emptyPolicy } from '../src/governance.mjs';
import {
  ROOM_WORK_EVENT,
  validateOwnerGrants,
  verifyRoomWorkState,
} from '../src/bot-work-policy.mjs';
import { checkScopedFile } from '../dsh-plugin/scoped-work.mjs';
import { NodeFiles } from '../src/node-files.mjs';
import { scopedTaskRequest } from '../src/node-work.mjs';

const botId = '@helper:a.test';
const ownerId = '@owner:a.test';
const humanId = '@alice:b.test';
const roomId = '!work:b.test';
const issuerId = '@dscord-control:b.test';
const tools = ['read', 'write', 'edit', 'read_image'];

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-bot-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bot = {
    id: botId,
    kind: 'bot',
    name: 'Helper',
    ownerId,
    localpart: 'helper',
    accessToken: 'synthetic-bot-token',
  };
  const locals = [{ id: ownerId, kind: 'human', name: 'Owner' }, bot];
  const event = {
    event_id: '$request',
    room_id: roomId,
    type: 'm.room.message',
    sender: humanId,
    content: {
      body: 'Read my file and write a report',
      'org.ds_group': { to: [botId] },
    },
  };
  let policy = emptyPolicy('a.test');
  policy.partners = [{ serverName: 'b.test', name: 'B', enabled: true }];
  policy.members = [
    { id: humanId, kind: 'human', name: 'Alice', enabled: true },
  ];
  policy.rooms = [
    {
      roomId,
      authority: 'b.test',
      name: 'Work',
      enabled: true,
      memberIds: [botId, humanId],
      botIds: [botId],
      tools,
    },
  ];
  policy.botPolicies = [
    {
      botId,
      enabled: true,
      requesterIds: [humanId],
      roomIds: [roomId],
      tools,
      canDelegate: true,
    },
  ];
  const state = {
    type: ROOM_WORK_EVENT,
    state_key: '',
    event_id: '$policy-1',
    sender: issuerId,
    content: {
      schemaVersion: 1,
      roomId,
      authority: 'b.test',
      issuerId,
      revision: 1,
      enabled: true,
      localMemberAdmission: 'matrix-membership',
      memberIds: [botId],
      botIds: [botId],
      tools,
    },
  };
  const power = {
    type: 'm.room.power_levels',
    state_key: '',
    content: { users: { [issuerId]: 100 } },
  };
  let joinedIds = [botId, humanId, issuerId];
  const events = new Map([[event.event_id, event]]);
  const matrix = {
    request: async (_method, route) => {
      if (route.endsWith('/joined_members'))
        return { joined: Object.fromEntries(joinedIds.map((id) => [id, {}])) };
      if (route.endsWith('/state')) return [state, power];
      if (route.includes('/event/')) {
        const found = events.get(decodeURIComponent(route.split('/event/')[1]));
        if (!found) throw Object.assign(new Error('No event'), { status: 404 });
        return structuredClone(found);
      }
      throw new Error(`Unexpected Matrix route ${route}`);
    },
  };
  const service = new BotWorkService({
    setup: { serverName: 'a.test' },
    accounts: {
      person: (id) => locals.find((person) => person.id === id),
      publicParticipants: () => locals,
    },
    governance: { read: async () => policy },
    dataRoot: directory,
    matrixFor: () => matrix,
  });
  t.after(() => service.close());
  const grant = {
    revision: 0,
    grants: [{ roomId, enabled: true, requesterIds: [humanId], tools }],
  };
  const admit = () =>
    service.admit(
      botId,
      { roomId, eventId: event.event_id, nodeTools: tools },
      { botId },
    );
  return {
    directory,
    service,
    bot,
    locals,
    event,
    events,
    policy,
    state,
    power,
    matrix,
    grant,
    admit,
    setJoined: (ids) => {
      joinedIds = ids;
    },
    setPolicy: (value) => {
      policy = value;
    },
  };
}

test('external work needs a distinct owner grant despite room membership and administrator policy', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.admit(), { code: 'BOT_WORK_DENIED' });
  f.service.saveGrants(f.bot, f.grant);
  const accepted = await f.admit();
  assert.equal(accepted.work.ownerId, ownerId);
  assert.equal(accepted.work.botId, botId);
  assert.equal(accepted.work.requesterId, humanId);
  assert.equal(accepted.work.canDelegate, false);
  assert.equal(
    accepted.participants.some((person) => person.id === issuerId),
    false,
  );
  assert.equal(
    accepted.participants.some(
      (person) => 'accessToken' in person || 'instructions' in person,
    ),
    false,
  );
  assert.equal((await f.admit()).work.requestId, accepted.work.requestId);
  assert.equal(
    f.service.db.prepare('SELECT COUNT(*) AS n FROM bot_work_admissions').get()
      .n,
    1,
  );
});

test('effective tools intersect owner, home room, Bot policy, actual origin state, node and task scope', async (t) => {
  const f = await fixture(t);
  f.service.saveGrants(f.bot, {
    revision: 0,
    grants: [{ ...f.grant.grants[0], tools: ['read', 'write'] }],
  });
  f.policy.botPolicies[0].tools = ['write', 'edit'];
  f.state.content.tools = ['read', 'write'];
  f.event.content['org.ds_group'].taskTools = ['write'];
  const { work } = await f.admit();
  assert.deepEqual(work.tools, ['write']);
  await assert.rejects(
    f.service.check(
      { requestId: work.requestId, botId, stage: 'tool', tool: 'bash' },
      { botId },
    ),
    { code: 'BOT_WORK_DENIED' },
  );
  await assert.rejects(
    f.service.check(
      { requestId: work.requestId, botId, stage: 'tool', tool: 'read' },
      { botId },
    ),
    { code: 'BOT_WORK_DENIED' },
  );
  assert.equal(
    (
      await f.service.check(
        {
          requestId: work.requestId,
          botId,
          stage: 'tool',
          tool: 'write',
          callId: 'tool-1',
        },
        { botId },
      )
    ).authorized,
    true,
  );
});

test('same localpart, claimed owner and claimed origin never authorize another full Matrix identity', async (t) => {
  const f = await fixture(t);
  f.service.saveGrants(f.bot, f.grant);
  f.event.content['org.ds_group'].ownerId = ownerId;
  f.event.content['org.ds_group'].originSenderId = humanId;
  f.event.sender = '@alice:c.test';
  await assert.rejects(f.admit(), { code: 'BOT_WORK_DENIED' });
  f.event.sender = humanId;
  f.event.content['org.ds_group'].kind = 'task.request';
  await assert.rejects(f.admit(), { code: 'BOT_WORK_DENIED' });
});

test('fixed issuer, actual membership and actual Matrix state power are all required', async (t) => {
  const f = await fixture(t);
  const verify = () =>
    verifyRoomWorkState({
      state: f.state,
      power: f.power,
      roomId,
      authority: 'b.test',
      joinedIds: [botId, humanId, issuerId],
    });
  assert.equal(verify().senderId, issuerId);
  f.state.sender = '@admin:b.test';
  assert.throws(verify, { code: 'BOT_WORK_DENIED' });
  f.state.sender = issuerId;
  f.power.content.users[issuerId] = 49;
  assert.throws(verify, { code: 'BOT_WORK_DENIED' });
  f.power.content.users[issuerId] = 100;
  f.state.content.roomId = '!other:b.test';
  assert.throws(verify, { code: 'BOT_WORK_DENIED' });
  f.state.content.roomId = roomId;
  assert.throws(
    () =>
      verifyRoomWorkState({
        state: f.state,
        power: f.power,
        roomId,
        authority: 'b.test',
        joinedIds: [botId, humanId],
      }),
    { code: 'BOT_WORK_DENIED' },
  );
});

test('owner revocation stops each later action, keeps prior effects and accepts late observations', async (t) => {
  const f = await fixture(t);
  const grant = f.service.saveGrants(f.bot, f.grant);
  const { work } = await f.admit();
  const action = { requestId: work.requestId, botId };
  await f.service.check(
    { ...action, stage: 'tool', tool: 'write', callId: 'write-before-revoke' },
    { botId },
  );
  f.service.saveGrants(f.bot, { revision: grant.revision, grants: [] });
  for (const stage of [
    'run',
    'model',
    'tool',
    'download',
    'upload',
    'deliver',
  ]) {
    await assert.rejects(
      f.service.check({ ...action, stage, tool: 'read' }, { botId }),
      { code: 'BOT_WORK_DENIED' },
    );
  }
  assert.deepEqual(
    await f.service.check(
      {
        ...action,
        stage: 'observe',
        callId: 'write-before-revoke',
        effectStatus: 'completed',
      },
      { botId },
    ),
    { authorized: false, late: true, effectStatus: 'completed' },
  );
  const audit = f.service.db
    .prepare('SELECT * FROM bot_work_audit ORDER BY sequence')
    .all();
  assert.equal(
    audit.filter((row) => row.decision === 'authorized' && row.stage === 'tool')
      .length,
    1,
  );
  assert.equal(audit.at(-1).decision, 'late_observation');
  assert.equal(
    f.service.db.prepare('SELECT COUNT(*) AS n FROM bot_work_admissions').get()
      .n,
    1,
  );
});

test('room revision changes, publisher demotion and foreign member withdrawal invalidate an admitted task', async (t) => {
  for (const change of [
    (f) => {
      f.state.content.revision++;
      f.state.event_id = '$new-policy';
    },
    (f) => {
      f.power.content.users[issuerId] = 0;
    },
    (f) => {
      f.policy.members[0].enabled = false;
    },
    (f) => {
      f.setJoined([botId, issuerId]);
    },
    (f) => {
      f.policy.rooms[0].enabled = false;
    },
  ]) {
    const f = await fixture(t);
    f.service.saveGrants(f.bot, f.grant);
    const { work } = await f.admit();
    change(f);
    await assert.rejects(
      f.service.check(
        { requestId: work.requestId, botId, stage: 'run' },
        { botId },
      ),
      { code: 'BOT_WORK_DENIED' },
    );
  }
});

test('owner grant CAS, Bot-scoped credential and new task binding cannot be bypassed', async (t) => {
  const f = await fixture(t);
  f.service.saveGrants(f.bot, f.grant);
  assert.throws(() => f.service.saveGrants(f.bot, f.grant), { status: 409 });
  assert.throws(
    () =>
      validateOwnerGrants({
        ...f.grant,
        grants: [{ ...f.grant.grants[0], tools: ['bash'] }],
      }),
    { status: 400 },
  );
  await assert.rejects(
    f.service.admit(
      botId,
      { roomId, eventId: '$request', nodeTools: tools },
      { botId: '@other:a.test' },
    ),
    { status: 403 },
  );
  const { work } = await f.admit();
  await assert.rejects(
    f.service.check(
      { requestId: work.requestId, botId: '@other:a.test', stage: 'run' },
      { botId: '@other:a.test' },
    ),
    { status: 403 },
  );
  await assert.rejects(
    f.service.check(
      {
        requestId: work.requestId,
        botId,
        stage: 'deliver',
        destinationRoomId: '!wrong:b.test',
        recipientId: humanId,
        replyTo: '$request',
      },
      { botId },
    ),
    { status: 403 },
  );
  assert.equal(
    (
      await f.service.check(
        {
          requestId: work.requestId,
          botId,
          stage: 'deliver',
          destinationRoomId: roomId,
          recipientId: humanId,
          replyTo: '$request',
        },
        { botId },
      )
    ).authorized,
    true,
  );
});

test('room directories expose only admitted joined identities and never the rest of the admission list', async (t) => {
  const f = await fixture(t);
  f.policy.members.push({
    id: '@other:b.test',
    name: 'Other',
    kind: 'human',
    enabled: true,
  });
  const { participants } = await f.service.room(f.bot, roomId);
  assert.deepEqual(
    participants.map((person) => person.id).sort(),
    [botId, humanId].sort(),
  );
  f.setJoined([botId, humanId, issuerId, '@stranger:b.test']);
  f.service.saveGrants(f.bot, f.grant);
  await assert.rejects(f.admit(), { code: 'BOT_WORK_DENIED' });
});

test('task file guards refuse traversal, private memory, other task directories and symlinks', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-file-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'task');
  const privateFile = path.join(directory, 'private-memory.txt');
  await mkdir(workspace);
  await writeFile(privateFile, 'PRIVATE');
  await symlink(privateFile, path.join(workspace, 'alias'));
  await symlink(directory, path.join(workspace, 'escape'));
  for (const file_path of [
    '../private-memory.txt',
    privateFile,
    path.join(workspace, 'alias'),
    path.join(workspace, 'escape', 'new.txt'),
  ]) {
    await assert.rejects(
      checkScopedFile(
        { name: 'read', arguments: { file_path } },
        workspace,
        tools,
      ),
      { code: 'WORK_FILE_SCOPE_DENIED' },
    );
  }
  await assert.rejects(
    checkScopedFile(
      { name: 'bash', arguments: { command: 'cat ../private-memory.txt' } },
      workspace,
      tools,
    ),
    { code: 'WORK_FILE_SCOPE_DENIED' },
  );
  assert.equal(
    await checkScopedFile(
      { name: 'write', arguments: { file_path: 'new/report.txt' } },
      workspace,
      tools,
    ),
    path.join(await realpath(workspace), 'new', 'report.txt'),
  );
});

test('foreign attachment IDs use proven room events and home Matrix bytes, including cache authorization', async (t) => {
  const f = await fixture(t);
  const data = Buffer.from('remote-file-contents');
  const descriptor = {
    id: 'same-local-id',
    name: 'remote.txt',
    mimeType: 'text/plain',
    contentUri: 'mxc://b.test/remote',
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
  f.event.content['org.ds_group'].attachments = [descriptor];
  f.service.saveGrants(f.bot, f.grant);
  const admission = await f.admit();
  const request = scopedTaskRequest(
    {
      requestId: admission.work.requestId,
      botId,
      event: {
        eventId: '$request',
        roomId,
        senderId: humanId,
        attachments: [descriptor],
        body: f.event.content.body,
      },
      history: [],
    },
    admission,
    f.event,
  );
  let downloads = 0;
  const work = {
    check: (request, stage, details) =>
      f.service.check(
        { requestId: request.requestId, botId, stage, ...details },
        { botId },
      ),
  };
  const files = new NodeFiles({
    coreUrl: 'https://unused.example',
    accessToken: 'synthetic',
    directory: path.join(f.directory, 'files'),
    work,
    matrix: {
      downloadMedia: async (uri) => {
        assert.equal(uri, descriptor.contentUri);
        downloads++;
        return new Response(data);
      },
    },
    fetchImpl: async () => {
      throw new Error('Foreign IDs must never use a local media index');
    },
  });
  const first = await files.prepare(request);
  assert.equal(first.files[0].sha256, descriptor.sha256);
  await files.prepare(request);
  assert.equal(downloads, 1);
  f.service.saveGrants(f.bot, { revision: 1, grants: [] });
  await assert.rejects(files.prepare(request), { code: 'BOT_WORK_DENIED' });
  assert.equal(downloads, 1);
});

test('equivalent Matrix object key order and a new authority connection preserve the durable proof', async (t) => {
  const f = await fixture(t);
  f.service.saveGrants(f.bot, f.grant);
  const { work } = await f.admit();
  f.state.content = Object.fromEntries(
    Object.entries(f.state.content).reverse(),
  );
  f.policy.rooms[0] = Object.fromEntries(
    Object.entries(f.policy.rooms[0]).reverse(),
  );
  assert.equal((await f.admit()).work.proofHash, work.proofHash);
  const restored = new BotWorkService({
    setup: f.service.setup,
    accounts: f.service.accounts,
    governance: f.service.governance,
    dataRoot: f.directory,
    matrixFor: () => f.matrix,
  });
  t.after(() => restored.close());
  assert.equal(
    (
      await restored.check(
        { requestId: work.requestId, botId, stage: 'run' },
        { botId },
      )
    ).work.domainId,
    work.domainId,
  );
});

test('input descriptors use the smaller current home and actual node byte limits', async (t) => {
  const f = await fixture(t);
  f.event.content['org.ds_group'].attachments = [
    {
      id: 'limit',
      name: 'limit.txt',
      mimeType: 'text/plain',
      contentUri: 'mxc://b.test/limit',
      size: 120,
      sha256: 'a'.repeat(64),
    },
  ];
  f.service.saveGrants(f.bot, f.grant);
  f.service.maxBytes = () => 100;
  await assert.rejects(f.admit(), { code: 'BOT_WORK_DENIED' });
  f.service.maxBytes = () => 1000;
  await assert.rejects(
    f.service.admit(
      botId,
      { roomId, eventId: '$request', nodeTools: tools, nodeMaxBytes: 110 },
      { botId },
    ),
    { code: 'BOT_WORK_DENIED' },
  );
  const { work } = await f.service.admit(
    botId,
    { roomId, eventId: '$request', nodeTools: tools, nodeMaxBytes: 200 },
    { botId },
  );
  assert.equal(work.maxInputBytes, 200);
});
