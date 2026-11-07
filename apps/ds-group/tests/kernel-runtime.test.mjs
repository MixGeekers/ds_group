import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { claimKernelHome, detectLegacyRuntime, KERNEL_API, KERNEL_ID } from '../dsh-connect/kernel-runtime.mjs';
import { NativeBots } from '../dsh-connect/native-bots.mjs';
import { homeLock } from '../vendor/ds-bot/src/host/home-lock.js';
import { isContextMessage, messageSource, sourceLabel } from '../vendor/ds-bot/src/host/message-source.js';

const temporary = async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-kernel-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fetchContext = fetch => ({ connection: { browserPeer: 'authenticated-owner', createSharedFetchHandler: () => ({ fetch }) } });

test('adoption preserves exact Bot/Session bytes and takes one durable snapshot', async t => {
  const home = await temporary(t);
  const bytes = JSON.stringify({ version: 1, bots: { original: { id: 'original', sessionId: 'current-part', name: '识雨' } }, requests: { known: { outcome: 'uncertain' } } });
  const inflight = '{"turns":{"current-part":{"botId":"original"}},"queued":{}}';
  await writeFile(path.join(home, 'state.json'), bytes);
  await writeFile(path.join(home, 'inflight.json'), inflight);
  const first = claimKernelHome(home);
  assert.equal(first.adopted, true);
  assert.equal(first.info().id, KERNEL_ID);
  assert.equal(first.info().version, '0.4.0');
  assert.equal(first.info().upstreamVersion, '0.3.1');
  assert.equal(await readFile(path.join(home, 'state.json'), 'utf8'), bytes);
  assert.equal(digest(await readFile(first.adoption.snapshot)), digest(bytes));
  assert.equal(await readFile(first.adoption.inflightSnapshot, 'utf8'), inflight);
  first.ready({ memoryBackend: 'source-aware', readOnly: () => undefined }); first.release();
  const second = claimKernelHome(home); t.after(() => second.release());
  assert.equal(second.adopted, false);
  assert.equal(second.adoption.snapshot, first.adoption.snapshot);
  assert.notEqual(second.instanceId, first.instanceId);
  assert.deepEqual(second.adoption.botIds, ['original']);
});

test('unfinished adoption is retried without inventing a new migration or replaying work', async t => {
  const home = await temporary(t); await writeFile(path.join(home, 'state.json'), '{"version":1,"bots":{}}');
  const first = claimKernelHome(home); const snapshot = first.adoption.snapshot; first.release();
  const resumed = claimKernelHome(home); t.after(() => resumed.release());
  assert.equal(resumed.adopted, true); assert.equal(resumed.adoption.snapshot, snapshot);
  assert.equal(resumed.info().adoption.tasksReplayed, false);
});

test('canonical homes and same-process locks prevent a second writer', async t => {
  const home = await temporary(t), alias = `${home}-alias`;
  await symlink(home, alias); t.after(() => rm(alias, { force: true }));
  const first = claimKernelHome(home); t.after(() => first.release());
  assert.throws(() => claimKernelHome(alias), error => error.code === 'DSCORD_KERNEL_CONFLICT');
  const other = homeLock(path.join(home, 'state.lock'));
  assert.equal(other.claim().pid, process.pid); assert.equal(first.lock.owns(), true); other.release();
});

test('a paused live local writer is not replaced after a stale heartbeat', async t => {
  const home = await temporary(t), filename = path.join(home, 'lock'); let now = Date.now();
  const first = homeLock(filename, { host: 'same', pid: 10, isAlive: () => true, now: () => now });
  assert.equal(first.claim(), undefined); t.after(() => first.release()); now += 120000;
  const next = homeLock(filename, { host: 'same', pid: 20, isAlive: () => true, now: () => now });
  assert.equal(next.claim().pid, 10); assert.equal(first.owns(), true);
});

test('unreadable or future state cannot be replaced by an empty kernel', async t => {
  for (const bytes of ['{broken', '{"version":99}']) {
    const home = await temporary(t); await writeFile(path.join(home, 'state.json'), bytes);
    assert.throws(() => claimKernelHome(home));
    assert.equal(await readFile(path.join(home, 'state.json'), 'utf8'), bytes);
    await assert.rejects(readFile(path.join(home, 'state.lock')), { code: 'ENOENT' });
  }
});

test('legacy detection uses a read-only probe and reports occupied non-JSON routes', async () => {
  const seen = [];
  const ctx = fetchContext(async (request, peer) => {
    seen.push({ path: new URL(request.url).pathname, body: await request.json(), peer });
    return new Response('old plugin', { status: 500 });
  });
  assert.equal((await detectLegacyRuntime(ctx)).api, '/api/bot');
  assert.deepEqual(seen[0], { path: '/api/bot', body: { endpoint: 'kernel-info', payload: {} }, peer: 'authenticated-owner' });
});

test('NativeBots eagerly selects only the owned kernel, coalesces startup and verifies identity', async () => {
  const paths = []; let ready = false, starts = 0;
  const ctx = fetchContext(async request => {
    paths.push(new URL(request.url).pathname);
    if (!ready) return new Response('', { status: 404 });
    const { endpoint } = await request.json();
    return Response.json({ ok: true, value: endpoint === 'kernel-info' ? { runtime: { id: KERNEL_ID, apiVersion: 1, status: 'running' } }
      : { bots: [], mainBotIds: [], models: [] } });
  });
  const native = new NativeBots(ctx, { ensureTeam: async () => { starts++; await Promise.resolve(); ready = true; } });
  assert.deepEqual(await Promise.all([native.list(), native.list()]), [[], []]);
  assert.equal(starts, 1); assert.ok(paths.every(value => value === KERNEL_API)); assert.equal(native.bundled, true);
  const foreign = new NativeBots(fetchContext(async () => Response.json({ ok: true, value: { runtime: { id: 'ds-bot', apiVersion: 1 } } })));
  await assert.rejects(foreign.state(), { code: 'DSCORD_KERNEL_INCOMPATIBLE' });
});

test('source normalization keeps full IDs, transport, room, event and producer kinds', () => {
  const context = id => ({ event: { eventId: '$event', roomId: '!room:test', senderId: id, body: 'hello' }, context: { source: { transport: 'matrix', sender: { id, name: '林青', kind: 'human' } } } });
  const a = messageSource({ requestId: 'one', memoryContext: context('@lin:a.test') });
  const b = messageSource({ requestId: 'two', memoryContext: context('@lin:b.test') });
  assert.notEqual(a.sender.id, b.sender.id); assert.equal(a.kind, 'user'); assert.equal(a.roomId, '!room:test');
  assert.equal(a.eventId, '$event'); assert.equal(a.transport, 'matrix'); assert.equal(a.memoryOrigin.authorId, '@lin:a.test');
  for (const kind of ['bot', 'tool', 'background']) {
    const source = messageSource({ requestId: kind, source: { sender: { id: `${kind}:original`, kind }, roomId: '!room:test' } });
    assert.equal(source.actor.kind, kind); assert.equal(isContextMessage({ source }), kind !== 'bot');
    assert.match(sourceLabel({ source }), new RegExp(kind === 'bot' ? 'Bot' : 'Context'));
  }
  assert.equal(isContextMessage({ source: { kind: 'knowledge-context' } }), true);
});
