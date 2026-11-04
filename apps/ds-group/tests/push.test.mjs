import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import webPush from 'web-push';
import { PushService } from '../src/push.mjs';

const setup = { homeserverUrl: 'https://matrix.example', roomId: '!group:test', participants: [
  { id: '@alice:test', kind: 'human', name: 'Alice', accessToken: 'synthetic-alice' },
  { id: '@bob:test', kind: 'human', name: 'Bob', accessToken: 'synthetic-bob' },
  { id: '@finance:test', kind: 'bot', name: '财务小雨', accessToken: 'synthetic-finance' },
] };
const subscription = name => ({ endpoint: `https://push.example/${name}`, expirationTime: null,
  keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: Buffer.alloc(16, 9).toString('base64url') } });
const message = (id, sender = '@finance:test', room = '!group:test', time = 2000) => ({
  event_id: id, sender, room_id: room, type: 'm.room.message', origin_server_ts: time, content: { msgtype: 'm.text', body: '费用合计960元。' },
});
async function fixture(options = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'ds-group-push-'));
  const sent = [];
  const service = new PushService({ dataRoot, setup, now: () => 1000,
    transport: async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); return { statusCode: 201 }; },
    onError() {}, ...options });
  await service.getConfig();
  return { service, sent, dataRoot, async close() { await service.close(); await rm(dataRoot, { recursive: true, force: true }); } };
}

test('Web Push VAPID keys persist with private file modes and only the public key is returned', async () => {
  const f = await fixture();
  try {
    const config = await f.service.getConfig();
    assert.equal(config.enabled, true);
    assert.equal(config.requiresSecureContext, true);
    assert.equal('privateKey' in config, false);
    assert.equal((await stat(path.join(f.dataRoot, 'push-vapid.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(f.dataRoot, 'push.sqlite'))).mode & 0o777, 0o600);
    const stored = JSON.parse(await readFile(path.join(f.dataRoot, 'push-vapid.json'), 'utf8'));
    assert.equal(config.publicKey, stored.publicKey);
    await f.service.close();
    const restored = new PushService({ dataRoot: f.dataRoot, setup, transport: async () => ({ statusCode: 201 }) });
    assert.equal((await restored.getConfig()).publicKey, config.publicKey);
    await restored.close();
  } finally { await f.close(); }
});

test('the installed Web Push library encrypts a synthetic payload and signs its VAPID request', async () => {
  const receiver = createECDH('prime256v1');
  const publicKey = receiver.generateKeys();
  const vapid = { ...webPush.generateVAPIDKeys(), subject: 'https://github.com/MixGeekers/shiyu' };
  const request = webPush.generateRequestDetails({ endpoint: 'https://push.example/crypto-check',
    keys: { p256dh: publicKey.toString('base64url'), auth: randomBytes(16).toString('base64url') } },
  JSON.stringify({ title: 'DS-Group', body: '合成通知' }), { vapidDetails: vapid });
  assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
  assert.match(request.headers.Authorization, /^vapid /);
  assert.ok(Buffer.isBuffer(request.body));
  assert.equal(request.body.includes(Buffer.from('合成通知')), false);
});

test('synthetic push delivers to multiple devices, skips the author and deduplicates repeated events', async () => {
  const f = await fixture();
  try {
    await f.service.subscribe('@alice:test', { subscription: subscription('alice-phone'), deviceLabel: 'Phone' });
    await f.service.subscribe('@alice:test', { subscription: subscription('alice-desktop'), deviceLabel: 'Desktop' });
    await f.service.subscribe('@bob:test', { subscription: subscription('bob-phone') });
    const event = message('$group-1', '@bob:test');
    assert.equal((await f.service.notifyMessage(event, ['@alice:test', '@bob:test'])).queued, 2);
    assert.equal(f.sent.length, 2);
    assert.ok(f.sent.every(item => item.payload.body.startsWith('Bob：')));
    assert.ok(f.sent.every(item => item.payload.data.roomId === '!group:test'));
    assert.equal(f.sent[0].payload.tag, f.sent[1].payload.tag);
    assert.equal((await f.service.notifyMessage(event, ['@alice:test', '@bob:test'])).queued, 0);
    assert.equal(f.sent.length, 2);
    const listed = await f.service.subscriptions('@alice:test');
    assert.equal(listed.length, 2);
    assert.equal(JSON.stringify(listed).includes('push.example'), false);
  } finally { await f.close(); }
});

test('subscription changes follow the signed-in human and old pending deliveries are removed', async () => {
  const f = await fixture();
  try {
    const shared = subscription('same-browser');
    await f.service.subscribe('@alice:test', { subscription: shared });
    f.service.enqueueFor('@alice:test', message('$old-account'));
    await f.service.subscribe('@bob:test', { subscription: shared });
    assert.equal((await f.service.subscriptions('@alice:test')).length, 0);
    assert.equal((await f.service.subscriptions('@bob:test')).length, 1);
    await f.service.drain();
    assert.equal(f.sent.length, 0);
    assert.equal((await f.service.unsubscribe('@alice:test', shared.endpoint)).unsubscribed, false);
    assert.equal((await f.service.unsubscribe('@bob:test', shared.endpoint)).unsubscribed, true);
    await assert.rejects(f.service.subscribe('@finance:test', { subscription: shared }), /human members/);
    await assert.rejects(f.service.subscribe('@alice:test', { subscription: { ...shared, endpoint: 'http://push.example/x' } }), /HTTPS/);
  } finally { await f.close(); }
});

test('new subscriptions do not receive historical notifications and private titles use the sender', async () => {
  const f = await fixture();
  try {
    await f.service.subscribe('@alice:test', { subscription: subscription('phone') });
    assert.equal((await f.service.notifyMessage(message('$old', '@finance:test', '!private:test', 999), ['@alice:test'])).queued, 0);
    await f.service.notifyMessage(message('$private', '@finance:test', '!private:test'), ['@alice:test']);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].payload.title, '财务小雨');
    assert.equal(f.sent[0].payload.body, '费用合计960元。');
    assert.equal(f.sent[0].payload.data.url, '/?roomId=!private%3Atest&eventId=%24private');
  } finally { await f.close(); }
});

test('expired push endpoints are removed and transient errors have a finite retry schedule', async () => {
  let clock = 1000;
  let attempts = 0;
  const f = await fixture({ now: () => clock, retryDelays: [10, 20], transport: async sub => {
    attempts++;
    throw Object.assign(new Error('synthetic transport failure'), { statusCode: sub.endpoint.endsWith('expired') ? 410 : 503 });
  } });
  try {
    await f.service.subscribe('@alice:test', { subscription: subscription('expired') });
    await f.service.subscribe('@bob:test', { subscription: subscription('retry') });
    await f.service.notifyMessage(message('$retry'), ['@alice:test', '@bob:test']);
    assert.equal((await f.service.subscriptions('@alice:test')).length, 0);
    assert.equal(attempts, 2);
    await f.service.drain();
    assert.equal(attempts, 2);
    clock += 10;
    await f.service.drain();
    clock += 20;
    await f.service.drain();
    clock += 1000;
    await f.service.drain();
    assert.equal(attempts, 4);
    const row = f.service.db.prepare('SELECT status,attempts,last_error FROM push_deliveries').get();
    assert.deepEqual({ ...row }, { status: 'failed', attempts: 3, last_error: 'PUSH_HTTP_503' });
  } finally { await f.close(); }
});

test('restarting preserves sent-event dedup and marks interrupted sends unknown', async () => {
  const f = await fixture();
  let restored;
  try {
    await f.service.subscribe('@alice:test', { subscription: subscription('phone') });
    await f.service.notifyMessage(message('$sent'), ['@alice:test']);
    f.service.enqueueFor('@alice:test', message('$interrupted'));
    f.service.db.prepare("UPDATE push_deliveries SET status='sending' WHERE event_id='$interrupted'").run();
    await f.service.close();
    const sent = [];
    restored = new PushService({ dataRoot: f.dataRoot, setup, now: () => 3000, transport: async sub => { sent.push(sub); return { statusCode: 201 }; } });
    await restored.getConfig();
    await restored.notifyMessage(message('$sent'), ['@alice:test']);
    await restored.drain();
    assert.equal(sent.length, 0);
    assert.equal(restored.db.prepare("SELECT status FROM push_deliveries WHERE event_id='$interrupted'").get().status, 'unknown');
  } finally { await restored?.close(); await f.close(); }
});

test('per-human Matrix sync includes private rooms and replays do not resend', async () => {
  const responses = new Map([['@alice:test', { next_batch: 'alice-1', rooms: { join: {
    '!private:test': { timeline: { events: [message('$alice-private', '@finance:test', '!private:test')] } },
  } } }], ['@bob:test', { next_batch: 'bob-1', rooms: { join: {
    '!group:test': { timeline: { events: [message('$bob-group')] } },
  } } }]]);
  const f = await fixture({ clientFactory: person => ({ sync: async () => responses.get(person.id) }) });
  try {
    await f.service.subscribe('@alice:test', { subscription: subscription('alice') });
    await f.service.subscribe('@bob:test', { subscription: subscription('bob') });
    await f.service.syncOnce('@alice:test');
    await f.service.syncOnce('@bob:test');
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent.find(item => item.endpoint.endsWith('alice')).payload.data.roomId, '!private:test');
    await f.service.syncOnce('@alice:test');
    await f.service.syncOnce('@bob:test');
    assert.equal(f.sent.length, 2);
    assert.equal(f.service.db.prepare('SELECT COUNT(*) AS count FROM push_cursors').get().count, 2);
  } finally { await f.close(); }
});

test('limited Matrix history is backfilled before advancing a notification cursor', async () => {
  let response = { next_batch: 'before', rooms: { join: { '!group:test': { timeline: { events: [message('$known')] } } } } };
  const f = await fixture({ clientFactory: () => ({ sync: async () => response,
    request: async () => ({ chunk: [message('$gap'), message('$known')], end: 'older' }) }) });
  try {
    await f.service.subscribe('@alice:test', { subscription: subscription('alice') });
    await f.service.syncOnce('@alice:test');
    response = {
      next_batch: 'after',
      rooms: { join: { '!group:test': {
        timeline: { limited: true, prev_batch: 'gap', events: [message('$latest')] },
      } } },
    };
    await f.service.syncOnce('@alice:test');
    assert.deepEqual(f.sent.map(item => item.payload.data.eventId), ['$known', '$gap', '$latest']);
    assert.equal(f.service.db.prepare("SELECT cursor FROM push_cursors WHERE user_id='@alice:test'").get().cursor, 'after');
  } finally { await f.close(); }
});

test('test notification requires a current device and reports push-service acceptance only', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.sendTest('@alice:test'), /Enable notifications/);
    await f.service.subscribe('@alice:test', { subscription: subscription('phone') });
    const receipt = await f.service.sendTest('@alice:test');
    assert.equal(receipt.sent, 1);
    assert.equal(receipt.failed, 0);
    assert.equal(f.sent[0].payload.body, '通知已启用');
    assert.equal(f.sent[0].payload.data.test, true);
  } finally { await f.close(); }
});

test('closing the listener aborts Matrix polling', async () => {
  const f = await fixture({ clientFactory: () => ({ sync: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) }) });
  try {
    await f.service.start();
    await f.service.close();
    assert.equal(f.service.closed, true);
  } finally { await f.close(); }
});
