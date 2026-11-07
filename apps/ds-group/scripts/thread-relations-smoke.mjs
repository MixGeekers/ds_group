#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MatrixClient } from '../src/matrix-client.mjs';
import { packageRoot } from '../src/paths.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.parse(JSON.stringify(value));
const baseCommit = '2f7a93691d50f04ded6a0ecef49147f33815cdc3';
const relation = (root, reply = root, fallback = true) => ({ rel_type: 'm.thread', event_id: root,
  'm.in_reply_to': { event_id: reply }, is_falling_back: fallback });

/** Uses existing services and two new human-only rooms. No Bot, provider,
 * decision endpoint, host process or story room is contacted by this script.
 */
export async function verifyThreadRelations({ coreUrl, setupPath, reportPath, run = false, actorId, peerId } = {}) {
  const core = new URL(coreUrl);
  assert.ok(['http:', 'https:'].includes(core.protocol) && !core.username && !core.password && core.pathname === '/' && !core.search && !core.hash, 'Use the existing Core origin');
  const setup = JSON.parse(await readFile(setupPath, 'utf8'));
  const humans = setup.participants.filter(person => person.kind === 'human' && person.accessToken);
  const actor = humans.find(person => !actorId || [person.id, person.localpart].includes(actorId));
  const peer = humans.find(person => person.id !== actor?.id && (!peerId || [person.id, person.localpart].includes(peerId)));
  assert.ok(actor && peer, 'Two distinct synthetic humans with existing credentials are required');
  const secrets = setup.participants.flatMap(person => [person.accessToken, person.password]).filter(value => typeof value === 'string' && value.length > 6);
  const clients = new Map([actor, peer].map(person => [person.id, new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: person.accessToken })]));
  const matrix = person => clients.get(person.id);
  const runId = `thread-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  reportPath ||= path.join(packageRoot, 'artifacts', 'thread-relations', `${runId}.json`);
  const report = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), status: 'running',
    level: run ? 'real-existing-core-synapse-zero-model' : 'read-only-preflight', sourceBase: baseCommit,
    specification: 'https://spec.matrix.org/latest/client-server-api/#threading', coreUrl: core.origin,
    credentialSource: 'private Matrix setup; credentials are not copied into evidence',
    participants: [actor, peer].map(({ id, kind }) => ({ id, kind })), rooms: [], cases: [], events: [],
    modelCallsInitiated: 0, servicesStarted: 0, storyRoomsAccessed: 0 };
  async function save() {
    const encoded = JSON.stringify(report, null, 2) + '\n';
    assert.ok(secrets.every(secret => !encoded.includes(secret)), 'Credentials must never enter evidence');
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, encoded);
  }
  async function check(name, work) {
    try { const details = await work(); report.cases.push({ name, status: 'passed', details: json(details ?? {}) }); return details; }
    catch (error) {
      let message = error.message;
      for (const secret of secrets) message = message.replaceAll(secret, '[redacted]');
      report.cases.push({ name, status: 'failed', error: message });
      throw error;
    } finally { await save(); }
  }
  async function api(route, { person = actor, body, method = body === undefined ? 'GET' : 'POST', expected = 200, headers = {} } = {}) {
    const response = await fetch(new URL(route, core), { method, redirect: 'error',
      headers: { authorization: `Bearer ${person.accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const value = await response.json();
    assert.equal(response.status, expected, `Core ${method} ${route} returned HTTP ${response.status} (${value.code || 'no code'})`);
    return value;
  }
  async function send(roomId, input, person = actor, expected = 200) {
    return api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { person, body: { to: [], ...input }, expected });
  }
  async function event(roomId, eventId, person = actor) {
    const value = await matrix(person).request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`);
    assert.equal(value.room_id, roomId); assert.equal(value.event_id, eventId);
    return value;
  }
  function recordEvent(value) {
    const meta = value.content?.['org.ds_group'] || {};
    report.events.push({ eventId: value.event_id, roomId: value.room_id, sender: value.sender, type: value.type,
      body: value.content?.body, relation: value.content?.['m.relates_to'] || null, mentions: value.content?.['m.mentions'] || null,
      metadata: { replyTo: meta.replyTo || null, threadRootId: meta.threadRootId || null, originThreadRootId: meta.originThreadRootId || null,
        attachments: (meta.attachments || []).map(({ id, name, sha256, size }) => ({ id, name, sha256, size })) } });
    return value;
  }
  async function members(roomId) {
    const value = await matrix(actor).request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`);
    const ids = Object.keys(value.joined || {}).sort();
    assert.deepEqual(ids, [actor.id, peer.id].sort(), 'Every verification room must contain only the two synthetic humans');
    return ids;
  }
  try {
    await check('existing-service-and-source-preflight', async () => {
      const status = await api('/api/status');
      report.coreLoadedSha256 = status.core.loadedCoreSha256;
      const expectedCoreSha256 = sha(await readFile(new URL('../src/core.mjs', import.meta.url)));
      assert.equal(status.core.loadedCoreSha256, expectedCoreSha256, 'The running Core must match this validation source');
      assert.equal((await matrix(actor).whoami()).user_id, actor.id);
      assert.equal((await matrix(peer).whoami()).user_id, peer.id);
      assert.equal((await api('/api/me')).user.id, actor.id);
      const versions = await matrix(actor).request('GET', '/_matrix/client/versions');
      const synapse = await matrix(actor).request('GET', '/_synapse/admin/v1/server_version');
      report.synapseVersion = synapse.server_version;
      report.sharedBudgetBefore = status.budget.used;
      return { loadedCoreMatches: true, serverName: setup.serverName, synapseVersion: synapse.server_version, versions: versions.versions, authenticatedHumans: 2 };
    });
    if (!run) { report.status = 'preflight-passed'; await save(); return { reportPath, report }; }
    const [roomA, roomB] = await check('create-two-independent-human-only-rooms', async () => {
      const rooms = [];
      for (const suffix of ['a', 'b']) {
        const created = await api('/api/rooms', { body: { name: `线程协议零模型核对 ${runId} ${suffix}`, requestId: `${runId}-${suffix}`, inviteIds: [peer.id] } });
        await members(created.roomId);
        report.rooms.push({ roomId: created.roomId, purpose: suffix === 'a' ? 'thread-and-file-verification' : 'cross-room-rejection', humanOnly: true });
        await save(); rooms.push(created.roomId);
      }
      return rooms;
    });
    const root = await check('plain-root-and-ordinary-reply', async () => {
      const first = await send(roomA, { transactionId: `${runId}-root`, body: `合成线程根 ${runId}` });
      const root = recordEvent(await event(roomA, first.event_id));
      assert.equal(root.content['m.relates_to'], undefined);
      const quote = await send(roomA, { transactionId: `${runId}-quote`, body: `合成引用 ${runId}` }, peer);
      const ordinary = await send(roomA, { transactionId: `${runId}-ordinary-reply`, body: `普通引用 ${runId}`, replyTo: quote.event_id });
      const reply = recordEvent(await event(roomA, ordinary.event_id));
      assert.deepEqual(reply.content['m.relates_to'], { 'm.in_reply_to': { event_id: quote.event_id } });
      assert.deepEqual(reply.content['m.mentions'].user_ids, [peer.id]);
      return { rootId: first.event_id, quoteId: quote.event_id, ordinaryReplyId: ordinary.event_id };
    });
    const explicit = await check('thread-root-and-explicit-reply-are-distinct', async () => {
      const sent = await send(roomA, { transactionId: `${runId}-thread-explicit`, body: `线程中的直接引用 ${runId}`, threadRootId: root.rootId, replyTo: root.quoteId });
      const actual = recordEvent(await event(roomA, sent.event_id, peer));
      assert.deepEqual(actual.content['m.relates_to'], relation(root.rootId, root.quoteId, false));
      assert.deepEqual(actual.content['m.mentions'].user_ids, [peer.id]);
      return { eventId: sent.event_id };
    });
    const fallback = await check('root-only-thread-uses-a-non-pinging-fallback', async () => {
      const sent = await send(roomA, { transactionId: `${runId}-thread-fallback`, body: `线程续话 ${runId}`, threadRootId: root.rootId });
      const actual = recordEvent(await event(roomA, sent.event_id));
      assert.deepEqual(actual.content['m.relates_to'], relation(root.rootId));
      assert.equal(actual.content['org.ds_group'].replyTo, undefined);
      assert.deepEqual(actual.content['m.mentions'].user_ids, []);
      return { eventId: sent.event_id };
    });
    const mixed = await check('quiet-cross-thread-quote-stays-in-the-selected-thread', async () => {
      const other = await send(roomA, { transactionId: `${runId}-other-root`, body: `第二个合成主题 ${runId}` }, peer);
      const quote = await send(roomA, { transactionId: `${runId}-other-child`, body: `第二主题原话 ${runId}`, threadRootId: other.event_id }, peer);
      const sent = await send(roomA, { transactionId: `${runId}-mixed`, body: `引用第二主题但继续第一主题 ${runId}`, threadRootId: root.rootId, replyTo: quote.event_id, replyMention: false });
      const actual = recordEvent(await event(roomA, sent.event_id));
      assert.deepEqual(actual.content['m.relates_to'], relation(root.rootId, quote.event_id, false));
      assert.deepEqual(actual.content['m.mentions'].user_ids, []);
      return { eventId: sent.event_id, otherRootId: other.event_id };
    });
    await check('foreign-room-and-nested-thread-references-are-rejected', async () => {
      for (const [index, references] of [{ threadRootId: root.rootId }, { replyTo: root.quoteId, replyMention: false }].entries()) {
        await send(roomB, { transactionId: `${runId}-foreign-${index}`, body: '此消息必须被拒绝', ...references }, actor, 400);
      }
      const nested = await send(roomA, { transactionId: `${runId}-nested`, body: '此消息必须被拒绝', threadRootId: explicit.eventId }, actor, 400);
      assert.equal(nested.code, 'INVALID_THREAD_ROOT');
      const timeline = await matrix(actor).timeline(roomB, 100);
      assert.equal(timeline.filter(value => value.type === 'm.room.message').length, 0);
      return { foreignRootRejected: true, quietForeignReplyRejected: true, nestedThreadRejected: true, destinationMessageCount: 0 };
    });
    const file = await check('threaded-attachment-has-real-bytes-and-an-independent-reply', async () => {
      const bytes = Buffer.from(`合成线程附件\n${runId}\n`, 'utf8');
      const upload = await api('/api/attachments?filename=' + encodeURIComponent('线程核对.txt'), { body: bytes,
        headers: { 'Content-Type': 'text/plain', 'X-Upload-Id': `${runId}-upload` } });
      const attachment = upload.attachment;
      assert.equal(attachment.sha256, sha(bytes)); assert.equal(attachment.size, bytes.length);
      const input = { transactionId: `${runId}-file`, body: `线程附件 ${runId}`, attachments: [attachment.id],
        threadRootId: root.rootId, replyTo: root.quoteId, originThreadRootId: root.rootId };
      const sent = await send(roomA, input);
      const actual = recordEvent(await event(roomA, sent.event_id, peer));
      assert.deepEqual(actual.content['m.relates_to'], relation(root.rootId, root.quoteId, false));
      assert.equal(actual.content.msgtype, 'm.file');
      assert.equal(actual.content['org.ds_group'].attachments[0].sha256, attachment.sha256);
      const download = await fetch(new URL(`/api/rooms/${encodeURIComponent(roomA)}/attachments/${encodeURIComponent(attachment.id)}?eventId=${encodeURIComponent(sent.event_id)}`, core),
        { redirect: 'error', headers: { authorization: `Bearer ${peer.accessToken}` }, signal: AbortSignal.timeout(30000) });
      assert.equal(download.status, 200);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
      return { eventId: sent.event_id, attachmentId: attachment.id, sha256: attachment.sha256, bytes: bytes.length, downloadedByOtherHuman: true, input };
    });
    await check('delivery-retries-are-idempotent-and-thread-changes-conflict', async () => {
      const repeated = await Promise.all([send(roomA, file.input), send(roomA, file.input)]);
      assert.ok(repeated.every(value => value.event_id === file.eventId));
      for (const changed of [{ threadRootId: mixed.otherRootId }, { threadRootId: undefined }, { originThreadRootId: mixed.otherRootId }]) {
        await send(roomA, { ...file.input, ...changed }, actor, 409);
      }
      const timeline = await matrix(actor).timeline(roomA, 100);
      assert.equal(timeline.filter(value => value.sender === actor.id && value.content?.body === file.input.body).length, 1);
      return { eventId: file.eventId, duplicateReceipts: repeated.length, unchangedEventCount: 1, changedThreadRejected: true };
    });
    await check('synapse-independently-aggregates-the-correct-thread', async () => {
      const related = await matrix(peer).request('GET', `/_matrix/client/v1/rooms/${encodeURIComponent(roomA)}/relations/${encodeURIComponent(root.rootId)}/m.thread?limit=100`);
      const ids = related.chunk.map(value => value.event_id);
      for (const expected of [explicit.eventId, fallback.eventId, mixed.eventId, file.eventId]) assert.ok(ids.includes(expected));
      assert.ok(!ids.includes(root.ordinaryReplyId));
      assert.ok(related.chunk.every(value => value.content['m.relates_to'].event_id === root.rootId));
      return { rootId: root.rootId, relatedEventIds: ids, plainReplyExcluded: true };
    });
    await check('verification-rooms-have-no-bot-members-or-tasks', async () => {
      for (const roomId of [roomA, roomB]) {
        await members(roomId);
        assert.equal((await api(`/api/rooms/${encodeURIComponent(roomId)}/tasks`)).tasks.length, 0);
      }
      const status = await api('/api/status');
      report.sharedBudgetAfter = status.budget.used;
      report.sharedBudgetDelta = status.budget.used - report.sharedBudgetBefore;
      report.sharedBudgetScope = 'Shared diagnostic environment; concurrent scenario calls are not attributable to this human-only script.';
      return { humanOnlyRooms: 2, botMembers: 0, roomTasks: 0, modelEndpointsCalled: 0 };
    });
    delete file.input; // Request bodies are already represented by the exact, synthetic event evidence.
    report.status = 'passed'; report.finishedAt = new Date().toISOString(); await save();
    return { reportPath, report };
  } catch (error) {
    report.status = 'failed'; report.finishedAt = new Date().toISOString(); await save();
    throw Object.assign(new Error('Thread verification failed; see the credential-free evidence report'), { reportPath });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { run: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    'core-url': { type: 'string' }, setup: { type: 'string' }, report: { type: 'string' }, actor: { type: 'string' }, peer: { type: 'string' } } });
  if (values.help) console.log('Use: node scripts/thread-relations-smoke.mjs [--run] --core-url URL --setup PRIVATE_JSON [--report FILE] [--actor ID] [--peer ID]');
  else {
    try {
      const result = await verifyThreadRelations({ coreUrl: values['core-url'] || process.env.DS_GROUP_CORE_URL,
        setupPath: values.setup || process.env.DS_GROUP_MATRIX_SETUP_PATH, reportPath: values.report,
        actorId: values.actor, peerId: values.peer, run: values.run });
      console.log(JSON.stringify({ status: result.report.status, checks: result.report.cases.length, reportPath: result.reportPath, modelCallsInitiated: 0 }));
    } catch (error) { console.error(JSON.stringify({ status: 'failed', reportPath: error.reportPath || null })); process.exitCode = 1; }
  }
}
