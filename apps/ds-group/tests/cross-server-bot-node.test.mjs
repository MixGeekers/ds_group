import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { BotNode } from '../src/bot-node.mjs';
import { NodeStore } from '../src/node-store.mjs';
import { NodeFiles } from '../src/node-files.mjs';
import { workHash, workRequestId } from '../src/bot-work-policy.mjs';

const botId = '@helper:a.node.test';
const humanId = '@alice:b.node.test';
const roomId = '!work:b.node.test';
async function fixture(t, { meta = {}, sender = humanId } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-node-work-'));
  const filename = path.join(directory, 'node.sqlite');
  let store = new NodeStore(filename, botId);
  const participant = {
    id: botId,
    localpart: 'helper',
    name: 'Helper',
    kind: 'bot',
    ownerId: '@owner:a.node.test',
  };
  const participants = [
    participant,
    { id: humanId, name: 'Alice', kind: 'human' },
    { id: '@peer:b.node.test', name: 'Peer', kind: 'bot' },
  ];
  const event = {
    event_id: '$node-request',
    room_id: roomId,
    sender,
    type: 'm.room.message',
    content: {
      body: 'Write and return my result',
      'org.ds_group': { to: [botId], ...meta },
    },
  };
  const work = {
    kind: 'scoped',
    requestId: workRequestId(botId, event.event_id),
    botId,
    ownerId: participant.ownerId,
    requesterId: humanId,
    roomId,
    eventId: event.event_id,
    authority: 'b.node.test',
    tools: ['read', 'write'],
    proofHash: workHash('proof'),
    domainId: workHash('domain'),
    conversationKind: 'group',
    canDelegate: false,
  };
  let revoked = false;
  let calls = 0;
  const decisions = [];
  const sent = [];
  const client = {
    admit: async () => {
      if (revoked) throw Object.assign(new Error('Revoked'), { status: 403 });
      return { mode: 'scoped', work, event, participants, inputs: [] };
    },
    check: async (request, stage, details = {}) => {
      decisions.push({ stage, details, request });
      assert.equal(request.authorization?.kind, 'scoped');
      if (revoked && stage !== 'observe')
        throw Object.assign(new Error('Revoked'), { status: 403 });
      return { authorized: !revoked };
    },
  };
  const bridge = {
    turn: async (request) => {
      calls++;
      return {
        status: 'completed',
        text: JSON.stringify({ text: 'Done.' }),
        sessionId: 'native-room-session',
        artifacts: [],
        toolReceipts: [],
      };
    },
  };
  const matrix = {
    send: async (roomId, body, options) => {
      sent.push({ roomId, body, options });
      return { event_id: '$result' };
    },
  };
  function node() {
    return new BotNode({
      participant,
      participants,
      roomId: '!home:a.node.test',
      store,
      matrix,
      bridge,
      heartbeat: async () => {},
      work: client,
      onError: () => {},
    });
  }
  const runtime = node();
  store.ingest([event], 'cursor', (event) => runtime.delivery.register(event));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    filename,
    runtime,
    event,
    work,
    bridge,
    client,
    matrix,
    sent,
    decisions,
    store: () => store,
    calls: () => calls,
    revoke: () => {
      revoked = true;
    },
    restart: () => {
      store.close();
      store = new NodeStore(filename, botId);
      return node();
    },
  };
}

test('scoped admission is durable before a download fails and never falls back to another delivery route', async (t) => {
  const f = await fixture(t, {
    meta: { delivery: { kind: 'direct', recipientId: humanId } },
  });
  f.runtime.files = {
    prepare: async (request) => {
      assert.equal(
        f.store().item(f.event.event_id).request.authorization.domainId,
        f.work.domainId,
      );
      assert.equal(request.authorization.domainId, f.work.domainId);
      throw Object.assign(new Error('Input read denied after admission'), {
        status: 403,
      });
    },
  };
  await f.runtime.processOne();
  assert.equal(f.calls(), 0);
  assert.equal(f.store().item(f.event.event_id).status, 'failed');
  assert.equal(
    f.store().item(f.event.event_id).request.authorization.domainId,
    f.work.domainId,
  );
  assert.equal(f.store().pendingDelivery(), undefined);
  assert.deepEqual(f.sent, []);
});

test('a denied Bot delegation event cannot generate an unscoped failure or direct message', async (t) => {
  const f = await fixture(t, {
    sender: '@peer:b.node.test',
    meta: {
      kind: 'task.request',
      returnTo: '@peer:b.node.test',
      originSenderId: humanId,
    },
  });
  f.revoke();
  await f.runtime.processOne();
  assert.equal(f.calls(), 0);
  assert.equal(f.store().item(f.event.event_id).status, 'failed');
  assert.equal(f.store().pendingDelivery(), undefined);
});

test('restart before admission cannot reconcile or publish a request through an older unscoped path', async (t) => {
  const f = await fixture(t);
  f.store().begin(f.event.event_id, {
    ...f.runtime.requestFor(f.store().item(f.event.event_id)),
    workGate: 'pending',
  });
  const restarted = f.restart();
  let lookups = 0;
  f.bridge.status = async () => {
    lookups++;
    throw new Error('Must not look up an unsubmitted native task');
  };
  await restarted.recoverInterrupted();
  assert.equal(lookups, 0);
  assert.equal(f.store().item(f.event.event_id).status, 'failed');
  assert.equal(f.store().pendingDelivery(), undefined);
});

test('late native results retain their effects but revoked tasks cannot upload or send', async (t) => {
  const f = await fixture(t);
  let finish;
  f.bridge.turn = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const processing = f.runtime.processOne();
  for (let pass = 0; pass < 20 && !finish; pass++) await Promise.resolve();
  assert.ok(finish);
  f.revoke();
  finish({
    status: 'completed',
    text: '{"text":"Already wrote the file"}',
    artifacts: [{ path: '/never-upload.txt' }],
    toolReceipts: [{ name: 'write', status: 'completed' }],
  });
  await processing;
  const item = f.store().item(f.event.event_id);
  assert.equal(item.status, 'failed');
  assert.equal(item.response.toolReceipts[0].status, 'completed');
  assert.equal(item.response.artifacts.length, 1);
  assert.equal(f.store().pendingDelivery(), undefined);
  assert.deepEqual(f.sent, []);
});

test('a frozen send retry rechecks work, keeps its transaction and never reruns the model', async (t) => {
  const f = await fixture(t, {
    meta: { taskId: 'foreign-user-supplied-task', hop: 100 },
  });
  let attempts = 0;
  f.matrix.send = async (destination, body, options) => {
    attempts++;
    f.sent.push({ destination, options });
    if (attempts === 1)
      throw Object.assign(new Error('Lost Matrix receipt'), {
        networkError: true,
      });
    return { event_id: '$same-result' };
  };
  await f.runtime.processOne();
  await assert.rejects(f.runtime.processOne(), /Lost Matrix receipt/);
  assert.ok(f.store().pendingDelivery().routing_frozen);
  await f.runtime.processOne();
  assert.equal(f.calls(), 1);
  assert.equal(f.sent.length, 2);
  assert.equal(
    f.sent[0].options.transactionId,
    f.sent[1].options.transactionId,
  );
  assert.notEqual(f.sent[0].options.taskId, 'foreign-user-supplied-task');
  assert.equal(f.sent[0].options.originSenderId, humanId);
  assert.equal(f.sent[0].destination, roomId);
  assert.equal(
    f.decisions.filter((decision) => decision.stage === 'deliver').length,
    2,
  );
  assert.ok(
    f.decisions.some(
      (decision) =>
        decision.stage === 'observe' &&
        decision.details.effectStatus === 'unknown',
    ),
  );
});

test('revocation after an unknown send prevents its next network attempt without rewriting the unknown effect', async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  f.matrix.send = async () => {
    attempts++;
    throw Object.assign(new Error('Lost Matrix receipt'), {
      networkError: true,
    });
  };
  await f.runtime.processOne();
  await assert.rejects(f.runtime.processOne(), /Lost Matrix receipt/);
  f.revoke();
  await f.runtime.processOne();
  assert.equal(attempts, 1);
  assert.equal(f.store().item(f.event.event_id).status, 'failed');
  assert.ok(
    f.decisions.some(
      (decision) =>
        decision.stage === 'observe' &&
        decision.details.effectStatus === 'unknown',
    ),
  );
});

test('a known uploaded attachment survives an observation outage as a separately pending audit', async (t) => {
  const f = await fixture(t);
  const artifactPath = path.join(f.directory, 'result.txt');
  const data = Buffer.from('actual artifact');
  await writeFile(artifactPath, data);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const files = new NodeFiles({
    directory: f.directory,
    coreUrl: 'https://home.test',
    accessToken: 'synthetic',
    work: {
      check: async (_request, stage) => {
        if (stage === 'observe') throw new Error('Audit unavailable');
      },
    },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          attachment: { id: 'known-upload', sha256, size: data.length },
        }),
        { status: 200 },
      ),
  });
  const result = await files.upload(
    { path: artifactPath, sha256, size: data.length },
    { requestId: 'upload', botId, workdir: f.directory },
  );
  assert.equal(result.id, 'known-upload');
  assert.equal(result.observationPending, true);
  assert.equal(await readFile(artifactPath, 'utf8'), 'actual artifact');
});
