#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { MatrixClient } from '../src/matrix-client.mjs';
import { workRequestId } from '../src/bot-work-policy.mjs';
import { packageRoot } from '../src/paths.mjs';
import { importNodeBundle } from './server-admin.mjs';

const { values } = parseArgs({
  options: {
    prepare: { type: 'boolean' },
    run: { type: 'boolean' },
    'real-model': { type: 'boolean' },
    'data-root': { type: 'string' },
    report: { type: 'string' },
  },
});
if (!values.prepare && !values.run)
  throw new Error(
    'Use --prepare or --run --real-model with an isolated federation-lab deployment',
  );
if (values.run && !values['real-model'])
  throw new Error(
    'This acceptance uses the real allowed model; select --run --real-model explicitly',
  );
const execute = promisify(execFile);
const root = path.resolve(
  values['data-root'] ||
    path.join(packageRoot, '.local/cross-server-federation'),
);
const lab = JSON.parse(await readFile(path.join(root, 'lab.json'), 'utf8'));
assert.equal(lab.root, root);
assert.equal(lab.project, 'dscord-bot-work');
const nodeRoot = path.join(root, 'original-finance-node');
const pendingPath = path.join(root, 'bot-work-fixture.json');
const reportPath =
  values.report ||
  path.join(
    root,
    `bot-work-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const tools = ['read', 'write', 'edit', 'read_image'];
const bridgePort = 24560;
const webPort = 24562;
const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
const report = {
  startedAt: new Date().toISOString(),
  date: new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()),
  status: 'running',
  level:
    'real-three-Synapse-federation-Core-native-DSH-and-allowed-remote-model',
  model: 'opencode-go/deepseek-v4.1-flash',
  physicalHosts: 1,
  remoteModelCalls: 0,
  checks: [],
  sourceHashes: {},
};
for (const file of [
  'src/core.mjs',
  'src/bot-work.mjs',
  'src/bot-work-policy.mjs',
  'src/bot-node.mjs',
  'src/node-work.mjs',
  'src/node-files.mjs',
  'src/node-store.mjs',
  'src/node-delivery.mjs',
  'src/governance.mjs',
  'src/synapse-control.mjs',
  'deploy/synapse/dscord_guard.py',
  'dsh-plugin/runtime.mjs',
  'dsh-plugin/scoped-work.mjs',
  'scripts/verify-cross-server-bot.mjs',
]) {
  report.sourceHashes[file] = hash(
    await readFile(path.join(packageRoot, file)),
  );
}
await mkdir(root, { recursive: true });
async function save() {
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
}
async function api(
  server,
  route,
  {
    token,
    body,
    method = body === undefined ? 'GET' : 'POST',
    expected = 200,
    admin = false,
  } = {},
) {
  const response = await fetch(
    new URL(route, admin ? server.adminUrl : server.coreUrl),
    {
      method,
      redirect: 'error',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const data = await response.json();
  assert.equal(
    response.status,
    expected,
    `${route}: HTTP ${response.status}, expected ${expected}; ${data.error || ''}`,
  );
  return data;
}
async function check(name, operation) {
  console.log(`Checking ${name}`);
  try {
    const details = await operation();
    report.checks.push({ name, status: 'passed', details });
    return details;
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: error.message });
    throw error;
  } finally {
    await save();
  }
}
async function poll(operation, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await delay(150);
  }
  throw new Error('Cross-server Bot acceptance timed out');
}
async function harness(command) {
  await execute(
    process.execPath,
    [
      path.join(packageRoot, 'scripts/federation-lab.mjs'),
      command,
      '--project',
      lab.project,
      '--port-base',
      String(lab.portBase),
      '--data-root',
      root,
    ],
    { cwd: packageRoot, timeout: 180_000, maxBuffer: 1024 * 1024 },
  );
}
for (const server of lab.servers) {
  server.setup = JSON.parse(
    await readFile(path.join(server.dataRoot, 'matrix-setup.json'), 'utf8'),
  );
  server.alice = server.setup.participants.find(
    (person) => person.localpart === 'alice',
  );
  server.bob = server.setup.participants.find(
    (person) => person.localpart === 'bob',
  );
  server.client = new MatrixClient({
    baseUrl: server.matrixUrl,
    accessToken: server.alice.accessToken,
  });
  const admin = JSON.parse(
    await readFile(
      path.join(server.dataRoot, 'lab-administrator.json'),
      'utf8',
    ),
  );
  server.adminToken = (
    await api(server, '/admin-api/login', { body: admin, admin: true })
  ).access_token;
}
const [a, b, c] = lab.servers;
const bot = a.setup.participants.find(
  (person) => person.localpart === 'finance',
);
const roomId = b.setup.roomId;
const grantRoute = `/api/bots/${encodeURIComponent(bot.id)}/work-grants`;
let dsh;
let adapter;
let log;
let fixture;
let nodeConfig;
let nodeDb;
let budgetBefore;
async function native(route, input) {
  const response = await fetch(
    new URL(`/api/ds-group-node${route}`, bridgeUrl),
    {
      method: input === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}
async function free(port) {
  const probe = createServer();
  probe.listen(port, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise((resolve) => probe.close(resolve));
}
function launch(file, args, env) {
  const child = spawn(
    process.execPath,
    [path.join(packageRoot, file), ...args],
    {
      cwd: packageRoot,
      env,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    },
  );
  child.done = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let timer;
  const done = await Promise.race([
    child.done.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 40_000);
    }),
  ]);
  clearTimeout(timer);
  if (!done) {
    process.kill(-child.pid, 'SIGKILL');
    await child.done;
    throw new Error('The owned test process required a forced stop');
  }
}
const environment = {
  ...process.env,
  DS_GROUP_DATA_DIR: nodeRoot,
  DS_GROUP_CORE_URL: a.coreUrl,
  DS_GROUP_MATRIX_SETUP_PATH: path.join(nodeRoot, 'matrix-setup.json'),
  DS_GROUP_CORE_CONFIG_PATH: path.join(nodeRoot, 'core-config.json'),
  DS_GROUP_BRIDGE_PORT: String(bridgePort),
  DS_GROUP_DSH_WEB_PORT: String(webPort),
};
async function startAdapter() {
  adapter = launch(
    'src/bot-node.mjs',
    ['--bot', 'finance', '--endpoint', bridgeUrl],
    environment,
  );
  await poll(async () => {
    if (adapter.exitCode !== null)
      throw new Error(`Adapter exited ${adapter.exitCode}`);
    const status = await api(a, '/api/status');
    return status.nodes.some(
      (node) => node.botId === bot.id && node.status !== 'offline',
    );
  });
}
function inbox(eventId) {
  const row = nodeDb
    .prepare('SELECT * FROM inbox WHERE event_id=?')
    .get(eventId);
  return (
    row && {
      ...row,
      request: row.request_json && JSON.parse(row.request_json),
      response: row.response_json && JSON.parse(row.response_json),
    }
  );
}
async function resultFor(client, targetRoom, eventId) {
  return poll(async () => {
    const item = inbox(eventId);
    if (item && ['failed', 'unknown', 'cancelled'].includes(item.status))
      throw new Error(`Bot task ${item.status}: ${item.error}`);
    if (item?.status !== 'completed') return;
    return (await client.timeline(targetRoom, 100)).find(
      (event) =>
        event.sender === bot.id &&
        event.content?.['org.ds_group']?.replyTo === eventId,
    );
  }, 300_000);
}
async function foreignTask(body, transactionId) {
  return b.client.send(roomId, body, {
    transactionId,
    to: [bot.id],
    attachments: [fixture.inputAttachment],
  });
}
async function receivedArtifact(event) {
  const file = event.content?.['org.ds_group']?.attachments?.[0];
  assert.ok(file, 'A real result attachment is required');
  const route = `/api/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(file.id)}?eventId=${encodeURIComponent(event.event_id)}`;
  const response = await fetch(new URL(route, b.coreUrl), {
    headers: { Authorization: `Bearer ${b.alice.accessToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(bytes), file.sha256);
  assert.equal(bytes.length, file.size);
  assert.equal(bytes.toString().trim(), `total=${fixture.expectedTotal}`);
  return {
    id: file.id,
    sha256: file.sha256,
    size: file.size,
    content: bytes.toString(),
  };
}

try {
  if (values.prepare) {
    await harness('reload');
    await check(
      'real A/B server ceilings and owner grants are configured independently',
      async () => {
        for (const [server, other] of [
          [a, b],
          [b, a],
        ]) {
          const { policy } = await api(server, '/admin-api/policy', {
            token: server.adminToken,
            admin: true,
          });
          const members =
            server === a
              ? b.setup.participants.map(({ id, name, kind, ownerId }) => ({
                  id,
                  name,
                  kind,
                  enabled: true,
                  ...(ownerId ? { ownerId } : {}),
                }))
              : [
                  {
                    id: bot.id,
                    name: bot.name,
                    kind: 'bot',
                    ownerId: bot.ownerId,
                    enabled: true,
                  },
                ];
          const memberIds = [
            bot.id,
            ...b.setup.participants.map((person) => person.id),
          ];
          const saved = await api(server, '/admin-api/policy', {
            token: server.adminToken,
            admin: true,
            method: 'PUT',
            body: {
              ...policy,
              partners: [
                {
                  serverName: other.serverName,
                  name: `Partner ${other.name}`,
                  enabled: true,
                },
              ],
              members,
              rooms: [
                {
                  roomId,
                  authority: b.serverName,
                  name: 'Foreign Bot file work',
                  enabled: true,
                  memberIds,
                  botIds: [bot.id],
                  tools,
                },
              ],
              botPolicies: [
                {
                  botId: bot.id,
                  enabled: true,
                  roomIds: [roomId],
                  requesterIds: [b.alice.id],
                  tools,
                  canDelegate: false,
                },
              ],
            },
          });
          await api(server, '/admin-api/apply', {
            token: server.adminToken,
            admin: true,
            body: { revision: saved.policy.revision },
          });
        }
        await harness('refresh-guard');
        const grants = await api(a, grantRoute, { token: a.alice.accessToken });
        await api(a, grantRoute, {
          token: a.alice.accessToken,
          method: 'PUT',
          body: {
            revision: grants.revision,
            grants: [
              { roomId, enabled: true, requesterIds: [b.alice.id], tools },
            ],
          },
        });
        return {
          botId: bot.id,
          ownerId: bot.ownerId,
          originRoomId: roomId,
          requesterId: b.alice.id,
        };
      },
    );
    await check(
      'same original Bot is invited without a shadow account and an exact node bundle is retained',
      async () => {
        const { bundle } = await api(
          a,
          `/api/bots/${encodeURIComponent(bot.id)}/connect`,
          { token: a.alice.accessToken, body: {} },
        );
        await importNodeBundle(bundle, nodeRoot);
        nodeConfig = bundle.coreConfig;
        await api(b, `/api/rooms/${encodeURIComponent(roomId)}/invite`, {
          token: b.alice.accessToken,
          body: { participantId: bot.id },
        });
        const q1 = randomInt(1, 10),
          q2 = randomInt(1, 10),
          p1 = randomInt(10, 50),
          p2 = randomInt(10, 50);
        const bytes = Buffer.from(
          `item,qty,price\napple,${q1},${p1}\npear,${q2},${p2}\n`,
        );
        const upload = async (server, content, name) => {
          const response = await fetch(
            new URL(`/api/attachments?filename=${name}`, server.coreUrl),
            {
              method: 'POST',
              redirect: 'error',
              headers: {
                Authorization: `Bearer ${server.alice.accessToken}`,
                'Content-Type': 'text/plain',
                'Content-Length': String(content.length),
                'X-Upload-Id': `synthetic-${hash(Buffer.concat([Buffer.from(name), content]))}`,
              },
              body: content,
            },
          );
          const result = await response.json();
          assert.equal(response.status, 200, result.error);
          return result.attachment;
        };
        const collision = await upload(
          a,
          Buffer.from('OWNER_PRIVATE_BLOB_NEVER_SHARE'),
          'private.txt',
        );
        const remote = await upload(b, bytes, 'input.csv');
        fixture = {
          botId: bot.id,
          ownerId: bot.ownerId,
          roomId,
          expectedTotal: q1 * p1 + q2 * p2,
          inputAttachment: { ...remote, id: collision.id },
          actualRemoteAttachmentId: remote.id,
          homeCollisionId: collision.id,
          runId: randomBytes(8).toString('hex'),
          privateMarker: `PRIVATE_${randomBytes(12).toString('hex')}`,
        };
        await writeFile(pendingPath, JSON.stringify(fixture, null, 2), {
          mode: 0o600,
        });
        return {
          botId: bot.id,
          ownerId: bot.ownerId,
          nodeDirectory: nodeRoot,
          forcedAttachmentIdCollision: collision.id,
          inputSha256: remote.sha256,
          inputSize: remote.size,
        };
      },
    );
    report.status = 'prepared';
  }
  if (values.run) {
    fixture ||= JSON.parse(await readFile(pendingPath, 'utf8'));
    nodeConfig ||= JSON.parse(
      await readFile(path.join(nodeRoot, 'core-config.json'), 'utf8'),
    );
    budgetBefore = (await api(a, '/api/status')).budget;
    report.runtime = {};
    for (const server of [a, b, c]) {
      const status = await api(server, '/api/status');
      const guard = await (
        await fetch(
          new URL(
            '/_synapse/client/dscord-governance/status',
            server.matrixUrl,
          ),
          { redirect: 'error' },
        )
      ).json();
      assert.equal(
        status.core.loadedCoreSha256,
        report.sourceHashes['src/core.mjs'],
      );
      assert.equal(
        guard.sourceSha256,
        report.sourceHashes['deploy/synapse/dscord_guard.py'],
      );
      report.runtime[server.name] = {
        loadedCoreSha256: status.core.loadedCoreSha256,
        guardSourceSha256: guard.sourceSha256,
        guardBootId: guard.bootId,
      };
    }
    await free(bridgePort);
    await free(webPort);
    log = await open(path.join(root, 'bot-work-host.log'), 'a', 0o600);
    dsh = launch('scripts/dsh-node.mjs', ['run', 'finance'], environment);
    await poll(async () => {
      if (dsh.exitCode !== null)
        throw new Error(
          `DSH exited ${dsh.exitCode}; inspect isolated host log`,
        );
      try {
        const status = await native('/status');
        assert.equal(
          status.loadedRuntimeSha256,
          report.sourceHashes['dsh-plugin/runtime.mjs'],
        );
        return status;
      } catch {
        return undefined;
      }
    });
    await startAdapter();
    nodeDb = new DatabaseSync(
      path.join(nodeRoot, 'nodes/finance/node.sqlite'),
      { readOnly: true },
    );
    const nativeBefore = (await native('/status')).bots.find(
      (item) => item.botId === bot.id,
    );
    report.originalBinding = {
      botId: bot.id,
      ownerId: bot.ownerId,
      dsBotId: nativeBefore.dsBotId,
      privateSessionId: nativeBefore.sessionId,
      nodeDirectory: nodeRoot,
    };
    await check(
      'owner and per-node authentication never inherit external room or deployment administration',
      async () => {
        await api(a, grantRoute, { token: a.bob.accessToken, expected: 403 });
        await api(a, grantRoute, { token: b.alice.accessToken, expected: 401 });
        await api(a, grantRoute, { token: b.adminToken, expected: 401 });
        const local = await api(a, '/api/bootstrap');
        assert.equal(
          local.participants.some((person) => person.id === b.alice.id),
          false,
        );
        await poll(async () =>
          (
            await new MatrixClient({
              baseUrl: a.matrixUrl,
              accessToken: bot.accessToken,
            }).request('GET', '/_matrix/client/v3/joined_rooms')
          ).joined_rooms.includes(roomId),
        );
        const directoryRoute = `/internal/bots/${encodeURIComponent(bot.id)}/rooms/${encodeURIComponent(roomId)}/directory`;
        const directory = await api(a, directoryRoute, {
          token: nodeConfig.nodeSecret,
        });
        assert.ok(
          directory.participants.some((person) => person.id === b.alice.id),
        );
        assert.equal(
          directory.participants.some(
            (person) => person.id === a.bob.id || person.id === c.alice.id,
          ),
          false,
        );
        assert.ok(
          directory.participants.every(
            (person) =>
              !('accessToken' in person) && !('instructions' in person),
          ),
        );
        await api(a, directoryRoute, {
          token: a.alice.accessToken,
          expected: 401,
        });
        return {
          originalBotId: bot.id,
          actualJoinedRoom: roomId,
          minimalRoomParticipants: directory.participants.map(
            (person) => person.id,
          ),
        };
      },
    );
    await check(
      'an actual owner private native Session is retained separately',
      async () => {
        const direct = await api(a, '/api/dm', {
          token: a.alice.accessToken,
          body: { participantId: bot.id },
        });
        const sent = await api(
          a,
          `/api/rooms/${encodeURIComponent(direct.roomId)}/messages`,
          {
            token: a.alice.accessToken,
            body: {
              body: `私聊专属随机标记 ${fixture.privateMarker}。只在此私人会话保留。现在只回复：已记住。`,
              to: [bot.id],
              transactionId: `owner-${fixture.runId}`,
            },
          },
        );
        const result = await resultFor(a.client, direct.roomId, sent.event_id);
        const nativeRequest = await native(
          `/turns/${workRequestId(bot.id, sent.event_id)}`,
        );
        assert.equal(nativeRequest.sessionId, nativeBefore.sessionId);
        return {
          roomId: direct.roomId,
          eventId: sent.event_id,
          resultEventId: result.event_id,
          sessionId: nativeRequest.sessionId,
          claims: nativeRequest.claims.length,
        };
      },
    );
    let first;
    let firstResult;
    let firstSession;
    await check(
      'B attachment with a colliding A ID is read and real file work returns to B as the original A Bot',
      async () => {
        first = await foreignTask(
          '请实际读取附件CSV，以每行 qty × price 求和。只使用当前文件工具，将合计写入本任务 result.txt，内容严格一行 total=实际合计数字。写好后实际读取成品核验，在最终JSON artifacts中交付。不要委派。',
          `foreign-${fixture.runId}`,
        );
        firstResult = await resultFor(b.client, roomId, first.event_id);
        assert.equal(firstResult.sender, bot.id);
        const meta = firstResult.content['org.ds_group'];
        assert.equal(meta.originSenderId, b.alice.id);
        assert.equal(meta.originRoomId, roomId);
        assert.equal(meta.originEventId, first.event_id);
        const artifact = await receivedArtifact(firstResult);
        const task = await native(
          `/turns/${workRequestId(bot.id, first.event_id)}`,
        );
        assert.equal(task.status, 'completed');
        assert.notEqual(task.sessionId, nativeBefore.sessionId);
        firstSession = task.sessionId;
        assert.ok(
          task.toolReceipts.some(
            (tool) => tool.name === 'read' && tool.status === 'completed',
          ),
        );
        assert.ok(
          task.toolReceipts.some(
            (tool) => tool.name === 'write' && tool.status === 'completed',
          ),
        );
        assert.ok(
          task.toolReceipts.every(
            (tool) =>
              tools.includes(tool.name) ||
              (tool.status === 'failed' &&
                tool.effectStatus === 'not_executed'),
          ),
        );
        const state = JSON.parse(
          await readFile(
            path.join(nodeRoot, 'dsh-finance/runtime/node-state.json'),
            'utf8',
          ),
        );
        const evidence = state.requests[task.requestId].inputEvidence;
        assert.equal(evidence.inputText.includes(fixture.privateMarker), false);
        const binding = (await native('/status')).bots.find(
          (item) => item.botId === bot.id,
        );
        assert.equal(binding.dsBotId, nativeBefore.dsBotId);
        assert.equal(binding.sessionId, nativeBefore.sessionId);
        return {
          requestEventId: first.event_id,
          resultEventId: firstResult.event_id,
          senderId: firstResult.sender,
          recipientId: meta.originSenderId,
          roomId,
          scopedSessionId: task.sessionId,
          nativeTools: task.toolReceipts.map((tool) => ({
            name: tool.name,
            status: tool.status,
            effectStatus: tool.effectStatus,
          })),
          modelClaims: task.claims.length,
          forcedAttachmentIdCollision: fixture.homeCollisionId,
          verifiedInputSha256: fixture.inputAttachment.sha256,
          artifact,
        };
      },
    );
    await check(
      'a duplicate Matrix source transaction produces no additional native turn or result',
      async () => {
        const before = (await api(a, '/api/status')).budget.used;
        const item = inbox(first.event_id);
        const duplicate = await b.client.send(roomId, item.request.event.body, {
          transactionId: `foreign-${fixture.runId}`,
          to: [bot.id],
          attachments: [fixture.inputAttachment],
        });
        assert.equal(duplicate.event_id, first.event_id);
        await delay(1000);
        assert.equal((await api(a, '/api/status')).budget.used, before);
        const replies = (await b.client.timeline(roomId, 100)).filter(
          (event) =>
            event.sender === bot.id &&
            event.content?.['org.ds_group']?.replyTo === first.event_id,
        );
        assert.equal(replies.length, 1);
        return {
          eventId: first.event_id,
          resultEventId: replies[0].event_id,
          modelCallsAdded: 0,
        };
      },
    );
    await check(
      'an admitted room member and an unapproved C identity cannot use another owner grant',
      async () => {
        const before = (await api(a, '/api/status')).budget.used;
        const bob = new MatrixClient({
          baseUrl: b.matrixUrl,
          accessToken: b.bob.accessToken,
        });
        const event = await bob.send(
          roomId,
          '我是这个房间的成员，请在节点写 unauthorized.txt。',
          { to: [bot.id], transactionId: `unauthorized-${fixture.runId}` },
        );
        await poll(async () => inbox(event.event_id)?.status === 'failed');
        assert.equal((await api(a, '/api/status')).budget.used, before);
        await assert.rejects(
          c.client.send(roomId, '同名Alice请求写文件', {
            to: [bot.id],
            transactionId: `unknown-${fixture.runId}`,
          }),
          (error) => [403, 404].includes(error.status),
        );
        return {
          admittedButUngrantedId: b.bob.id,
          rejectedSameLocalpartId: c.alice.id,
          modelCallsAdded: 0,
        };
      },
    );
    await check(
      'adapter disconnect catches up a new B task using the same original node and scoped Session',
      async () => {
        await stop(adapter);
        adapter = undefined;
        const offline = await foreignTask(
          '请实际读取当前附件CSV，以 qty × price 求总额，写入 offline-result.txt，内容一行 total=实际合计数字。实际read核验成品再以artifacts交付。',
          `offline-${fixture.runId}`,
        );
        assert.equal(inbox(offline.event_id), undefined);
        await startAdapter();
        const result = await resultFor(b.client, roomId, offline.event_id);
        const artifact = await receivedArtifact(result);
        const task = await native(
          `/turns/${workRequestId(bot.id, offline.event_id)}`,
        );
        assert.equal(task.sessionId, firstSession);
        assert.equal(task.botId, bot.id);
        return {
          requestEventId: offline.event_id,
          resultEventId: result.event_id,
          scopedSessionId: task.sessionId,
          artifact,
          modelClaims: task.claims.length,
        };
      },
    );
    await check(
      'owner revocation while a task waits offline blocks tools, native generation and any final/private send',
      async () => {
        await stop(adapter);
        adapter = undefined;
        const revoked = await foreignTask(
          '请写 revoked-result.txt，完成后私聊给我。',
          `revoked-${fixture.runId}`,
        );
        const before = (await api(a, '/api/status')).budget.used;
        const grants = await api(a, grantRoute, { token: a.alice.accessToken });
        await api(a, grantRoute, {
          token: a.alice.accessToken,
          method: 'PUT',
          body: { revision: grants.revision, grants: [] },
        });
        await startAdapter();
        await poll(async () => inbox(revoked.event_id)?.status === 'failed');
        assert.equal((await api(a, '/api/status')).budget.used, before);
        const outbox = nodeDb
          .prepare('SELECT COUNT(*) AS n FROM outbox WHERE source_event_id=?')
          .get(revoked.event_id).n;
        assert.equal(outbox, 0);
        assert.equal(inbox(revoked.event_id).request.workGate, 'pending');
        return {
          requestEventId: revoked.event_id,
          ownerId: bot.ownerId,
          nativeCallsAdded: 0,
          outboxEntries: 0,
          error: inbox(revoked.event_id).error,
        };
      },
    );
    report.status = 'passed';
  }
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  try {
    await stop(adapter);
    await stop(dsh);
  } catch (error) {
    report.cleanupError = error.message;
    report.status = 'failed';
    process.exitCode = 1;
  }
  nodeDb?.close();
  await log?.close();
  if (budgetBefore) {
    const after = (await api(a, '/api/status')).budget;
    report.remoteModelCalls = after.used - budgetBefore.used;
    report.budgetBefore = budgetBefore;
    report.budgetAfter = after;
    const state = JSON.parse(
      await readFile(
        path.join(nodeRoot, 'dsh-finance/runtime/node-state.json'),
        'utf8',
      ),
    );
    report.modelLedger = Object.values(state.requests)
      .filter((request) => request.acceptedAt >= report.startedAt)
      .map((request) => ({
        requestId: request.requestId,
        botId: request.botId,
        eventId: request.eventId,
        status: request.status,
        sessionId: request.sessionId,
        contextDomainId: request.contextDomainId,
        claims: request.claims,
        usage: request.usage,
        tools: (request.toolReceipts || []).map(
          ({ callId, name, status, effectStatus, late }) => ({
            callId,
            name,
            status,
            effectStatus,
            late,
          }),
        ),
      }));
    report.ledgerCallCount = report.modelLedger.reduce(
      (total, request) => total + request.claims.length,
      0,
    );
    if (report.ledgerCallCount !== report.remoteModelCalls) {
      report.ledgerMismatch = true;
      report.status = 'failed';
      process.exitCode = 1;
    }
    report.cleanup = {
      adapterStopped:
        !adapter || adapter.exitCode !== null || adapter.signalCode !== null,
      dshStopped: !dsh || dsh.exitCode !== null || dsh.signalCode !== null,
      federationServices: 'retained for explicit owned-lab teardown',
    };
  }
  report.completedAt = new Date().toISOString();
  report.coverageLimits = [
    'One physical host, isolated processes and Docker homeservers',
    'Cross-server terminal/jobs/skills/delegation disabled',
    'In-flight tool revocation and unknown send receipts additionally covered by native scripted/module evidence; real federation revocation here occurs before queued work is accepted',
    'Provider billing/cache and full external request bodies are not observed by this acceptance',
  ];
  await save();
  console.log(
    JSON.stringify(
      {
        report: reportPath,
        status: report.status,
        checks: report.checks,
        remoteModelCalls: report.remoteModelCalls,
      },
      null,
      2,
    ),
  );
}
