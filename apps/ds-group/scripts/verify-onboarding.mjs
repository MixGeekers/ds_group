#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const { values } = parseArgs({ options: { 'scope-refresh': { type: 'boolean', default: false }, 'rate-limit': { type: 'boolean', default: false }, credentials: { type: 'string' }, report: { type: 'string' } } });
assert.ok(!(values['scope-refresh'] && values['rate-limit']), 'Choose one verification mode');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.local', 'onboarding');
const service = JSON.parse(await readFile(path.join(directory, 'qa-server.json'), 'utf8'));
assert.equal(service.coreUrl, 'http://127.0.0.1:22100');
assert.equal(service.matrixUrl, 'http://127.0.0.1:22008');
assert.equal(service.containerName, 'dscord-onboarding-matrix');
const runId = `onboarding-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const reportPath = values.report ? path.resolve(values.report) : path.join(root, 'artifacts', 'onboarding', `${runId}.json`);
const credentialsPath = values.credentials ? path.resolve(values.credentials) : path.join(directory, values['rate-limit'] ? `${runId}-rate-limit-credentials.json` : 'qa-credentials.json');
const report = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), status: 'running',
  scope: 'real-matrix-core-registration-ownership-zero-model', modelCalls: 0, coreUrl: service.coreUrl, checks: [] };
const privateState = values['scope-refresh'] ? JSON.parse(await readFile(credentialsPath, 'utf8'))
  : { schemaVersion: 1, runId, coreUrl: service.coreUrl, matrixUrl: service.matrixUrl, humans: [], bots: [] };
const digest = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['src/core.mjs', 'src/accounts.mjs', 'src/node-auth.mjs', 'src/tasks.mjs', 'src/budget.mjs', 'src/matrix-client.mjs', 'scripts/server-admin.mjs', 'scripts/server-init.mjs'];

async function privateSave() {
  await writeFile(credentialsPath, JSON.stringify(privateState, null, 2) + '\n', { mode: 0o600 });
}
async function save() {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
async function request(route, { token, body, expected = 200, method = body === undefined ? 'GET' : 'POST', matrix = false } = {}) {
  const response = await fetch(new URL(route, matrix ? service.matrixUrl : service.coreUrl), {
    method, signal: AbortSignal.timeout(30000), headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${route} returned ${response.status}, expected ${expected}`);
  return data;
}
async function check(name, work) {
  console.log(`Checking ${name}`);
  try {
    const details = await work();
    report.checks.push({ name, status: 'passed', details });
    console.log(`Passed ${name}`);
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: error.message });
    throw error;
  } finally { await save(); }
}
function serviceSessions() {
  const db = new DatabaseSync(path.join(service.options.dataRoot, 'accounts.sqlite'), { readOnly: true });
  try { return Object.fromEntries(privateState.humans.map(person => [person.id, db.prepare('SELECT service_token FROM accounts WHERE user_id=?').get(person.id).service_token])); }
  finally { db.close(); }
}
async function validateServiceSessions(previous) {
  const current = serviceSessions();
  for (const [id, token] of Object.entries(current)) {
    assert.equal((await request('/_matrix/client/v3/account/whoami', { token, matrix: true })).user_id, id);
    if (previous) assert.equal(token, previous[id]);
    const person = privateState.humans.find(human => human.id === id);
    assert.notEqual(token, person.first.access_token);
    assert.notEqual(token, person.second.access_token);
  }
  return current;
}

async function applyLoginDefaults() {
  const owner = (await execute('docker', ['inspect', service.containerName, '--format', '{{index .Config.Labels "dscord.onboarding"}}'])).stdout.trim();
  assert.equal(owner, '22100');
  const env = { ...process.env, ...service.stopCore.env, DS_GROUP_MATRIX_URL: service.matrixUrl, DS_GROUP_HOST: '127.0.0.1' };
  await execute(process.execPath, ['scripts/service.mjs', 'down', 'core'], { cwd: root, env, timeout: 60000 });
  const { initializeServer } = await import('./server-init.mjs');
  await initializeServer(service.options);
  const config = JSON.parse(await readFile(path.join(service.options.synapseRoot, 'homeserver.yaml'), 'utf8'));
  assert.deepEqual(config.rc_login, {
    address: { per_second: 1, burst_count: 20 },
    account: { per_second: 0.003, burst_count: 5 },
    failed_attempts: { per_second: 0.17, burst_count: 3 },
  });
  report.synapseConfig = { rc_login: config.rc_login, x_forwarded: config.listeners[0].x_forwarded, source: 'initializeServer product defaults' };
  await execute('docker', ['restart', '--time', '20', service.containerName], { timeout: 60000 });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`${service.matrixUrl}/_matrix/client/versions`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Restarted Matrix must become ready');
  await execute(process.execPath, ['scripts/service.mjs', 'up', 'core'], { cwd: root, env, timeout: 60000 });
}

async function verifyLoginBurst() {
  const sharedCredentials = path.join(directory, 'qa-credentials.json');
  const originalCredentialsHash = digest(await readFile(sharedCredentials));
  const suffix = randomBytes(4).toString('hex');
  const startedAt = new Date().toISOString();
  const started = Date.now();
  report.registrationRequests = [];
  await check('eight different humans register and log in consecutively with product rate limits', async () => {
    for (let index = 1; index <= 8; index++) {
      const human = { username: `rate_${suffix}_${index}`, displayName: `Rate QA ${index}`, password: randomBytes(24).toString('base64url') };
      privateState.humans.push(human);
      await privateSave();
      const response = await fetch(`${service.coreUrl}/api/register`, { method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(human) });
      report.registrationRequests.push({ index, httpStatus: response.status, elapsedMs: Date.now() - started });
      assert.equal(response.status, 201, `Registration ${index} must succeed on its first request`);
      human.session = await response.json();
      human.id = human.session.user_id;
      assert.equal(human.id, `@${human.username}:onboarding.local`);
      assert.equal((await request('/api/me', { token: human.session.access_token })).user.id, human.id);
      await privateSave();
    }
    assert.equal(new Set(privateState.humans.map(human => human.id)).size, 8);
    assert.equal(digest(await readFile(sharedCredentials)), originalCredentialsHash);
    return { differentHumans: 8, registrationRequests: 8, automaticClientLogins: 8, requestRetries: 0, durationMs: Date.now() - started, existingCredentialsFilePreserved: true };
  });
  await check('Synapse access logs record the real client address for all eight successful logins', async () => {
    const logs = await execute('docker', ['logs', '--since', startedAt, service.containerName], { maxBuffer: 8 * 1024 * 1024 });
    const lines = `${logs.stdout}\n${logs.stderr}`.split('\n').filter(line => line.includes('Processed request:') && line.includes('"POST /_matrix/client/v3/login '));
    assert.equal(lines.length, 8, 'Each account registration must cause exactly one client login');
    const records = lines.map(line => ({ clientIp: line.match(/ - POST-\d+ - (\S+) - 8008 -/)?.[1], status: Number(line.match(/ (\d{3}) "POST \/_matrix\/client\/v3\/login /)?.[1]) }));
    assert.ok(records.every(record => record.clientIp === '127.0.0.1' && record.status === 200));
    report.synapseLoginEvidence = { records, lines };
    return { successfulLogins: records.length, observedClientIp: '127.0.0.1', statuses: records.map(record => record.status) };
  });
}

async function refreshScopes() {
  const [nora, omar] = privateState.humans;
  const [firstBot, secondBot] = privateState.bots;
  const previousSessions = await validateServiceSessions();
  const heartbeat = bot => ({ botId: bot.id, id: bot.localpart, runtimeId: runId, status: 'offline' });
  await check('existing client and service sessions survive the credential-store reload', async () => {
    for (const human of privateState.humans) assert.equal((await request('/api/me', { token: human.accessToken })).user.id, human.id);
    await validateServiceSessions(previousSessions);
    const oldCredentials = await readFile(credentialsPath);
    await writeFile(path.join(directory, `${runId}-credentials-before-refresh.json`), oldCredentials, { mode: 0o600, flag: 'wx' });
    for (const bot of privateState.bots) {
      const owner = privateState.humans.find(human => human.id === bot.ownerId);
      const other = privateState.humans.find(human => human.id !== bot.ownerId);
      const route = `/api/bots/${encodeURIComponent(bot.id)}/connect`;
      const { bundle } = await request(route, { token: owner.accessToken, body: {} });
      await request(route, { token: other.accessToken, body: {}, expected: 403 });
      bot.bundle = bundle;
    }
    privateState.lastScopeRefresh = runId;
    await privateSave();
    return { reusedHumans: privateState.humans.length, refreshedBotBundles: privateState.bots.length, loginRequests: 0 };
  });
  await check('SQLite-backed credentials keep heartbeat model and task permissions scoped', async () => {
    const firstSecret = firstBot.bundle.coreConfig.nodeSecret;
    const secondSecret = secondBot.bundle.coreConfig.nodeSecret;
    assert.notEqual(firstSecret, secondSecret);
    assert.equal((await request('/internal/nodes/heartbeat', { token: firstSecret, body: heartbeat(firstBot) })).accepted, true);
    await request('/internal/nodes/heartbeat', { token: firstSecret, body: heartbeat(secondBot), expected: 403 });
    await request('/internal/nodes/heartbeat', { token: firstSecret, body: { ...heartbeat(firstBot), id: secondBot.localpart }, expected: 403 });
    await request('/internal/model/claim', { token: firstSecret, body: { nodeId: secondBot.localpart, requestId: `${runId}-denied`, model: 'opencode-go/deepseek-v4.1-flash', maxTokens: 1 }, expected: 403 });
    const oldTasks = await request(`/api/rooms/${encodeURIComponent(privateState.groupRoomId)}/tasks`, { token: omar.accessToken });
    const task = oldTasks.tasks.find(item => item.botId === secondBot.id);
    assert.ok(task, 'The original synthetic permission task must survive reload');
    await request(`/internal/tasks/${task.requestId}/control`, { token: firstSecret, expected: 403 });
    await request('/internal/tasks/update', { token: firstSecret, body: task, expected: 403 });
    assert.equal((await request(`/internal/tasks/${task.requestId}/control`, { token: secondSecret })).requestId, task.requestId);
    const config = JSON.parse(await readFile(path.join(service.options.dataRoot, 'core-config.json'), 'utf8'));
    assert.notEqual(firstSecret, config.nodeSecret);
    assert.equal((await request(`/internal/tasks/${task.requestId}/control`, { token: config.nodeSecret })).requestId, task.requestId);
    return { crossBotRejections: 5, legacyGlobalControlAccepted: true, modelClaims: 0 };
  });
  await check('CLI export of a dynamic Bot immediately authorizes against the already-running Core', async () => {
    const before = await request('/api/status');
    const { bot } = await request('/api/bots', { token: nora.accessToken, body: { name: 'CLI 凭据验证', requestId: runId }, expected: 201 });
    const database = new DatabaseSync(path.join(service.options.dataRoot, 'node-credentials.sqlite'), { readOnly: true });
    try { assert.equal(database.prepare('SELECT count(*) AS count FROM node_credentials WHERE bot_id=?').get(bot.id).count, 0); }
    finally { database.close(); }
    const env = { ...process.env, DS_GROUP_DATA_DIR: service.options.dataRoot };
    const { stdout } = await execute(process.execPath, ['bin/dscord.mjs', 'admin', 'export-node', bot.localpart], { cwd: root, env, timeout: 30000 });
    const bundle = JSON.parse(stdout);
    assert.equal(bundle.nodeId, bot.localpart);
    assert.equal(bundle.setup.participants.filter(peer => peer.accessToken).length, 1);
    assert.equal(bundle.setup.participants.find(peer => peer.accessToken).id, bot.id);
    assert.equal((await request('/internal/nodes/heartbeat', { token: bundle.coreConfig.nodeSecret, body: heartbeat(bot) })).accepted, true);
    await request('/internal/nodes/heartbeat', { token: bundle.coreConfig.nodeSecret, body: heartbeat(secondBot), expected: 403 });
    const viaHttp = await request(`/api/bots/${encodeURIComponent(bot.id)}/connect`, { token: nora.accessToken, body: {} });
    assert.equal(viaHttp.bundle.coreConfig.nodeSecret, bundle.coreConfig.nodeSecret);
    assert.equal((await request('/api/status')).core.startedAt, before.core.startedAt);
    privateState.bots.push({ ...bot, bundle });
    await privateSave();
    await validateServiceSessions(previousSessions);
    return { botId: bot.id, cli: 'dscord admin export-node', credentialAbsentBeforeExport: true, httpAndCliCredentialMatch: true, coreStartedAt: before.core.startedAt, coreRestartedAfterExport: false };
  });
}

try {
  if (values['rate-limit']) {
    report.scope = 'real-matrix-login-address-rate-limit-fix-zero-model';
    await applyLoginDefaults();
  }
  if (values['scope-refresh']) {
    report.scope = 'real-core-sqlite-node-credentials-cli-live-visibility-zero-model';
    const env = { ...process.env, ...service.stopCore.env, DS_GROUP_MATRIX_URL: service.matrixUrl, DS_GROUP_HOST: '127.0.0.1' };
    await execute(process.execPath, ['scripts/service.mjs', 'restart', 'core'], { cwd: root, env, timeout: 60000 });
  }
  assert.equal((await request('/readyz')).status, 'ready');
  const containerOwner = (await execute('docker', ['inspect', service.containerName, '--format', '{{index .Config.Labels "dscord.onboarding"}}'])).stdout.trim();
  assert.equal(containerOwner, '22100');
  const initial = await request('/api/status');
  assert.equal(initial.budget.used, 0, 'Run this suite before DSH generation');
  report.sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, digest(await readFile(path.join(root, file)))])));
  assert.equal(initial.core.loadedCoreSha256, report.sourceHashes['src/core.mjs'], 'Reload Core to the current source before verification');
  const bootstrap = await request('/api/bootstrap');
  assert.equal(bootstrap.registration.enabled, true);
  assert.ok(!/accessToken|password|nodeSecret|service_token/.test(JSON.stringify(bootstrap)));
  if (values['rate-limit']) {
    await verifyLoginBurst();
  } else if (values['scope-refresh']) {
    await refreshScopes();
  } else {
    const suffix = randomBytes(4).toString('hex');
    await check('two new humans register through HTTP and join the initial room', async () => {
      for (const label of ['nora', 'omar']) {
        const person = { username: `${label}_${suffix}`, password: randomBytes(24).toString('base64url'), displayName: label === 'nora' ? 'Nora QA' : 'Omar QA' };
        privateState.humans.push(person);
        await privateSave();
        person.first = await request('/api/register', { body: person, expected: 201 });
        person.id = person.first.user_id;
        assert.equal(person.id, `@${person.username}:onboarding.local`);
        assert.equal((await request('/api/me', { token: person.first.access_token })).user.id, person.id);
        const rooms = await request('/api/rooms', { token: person.first.access_token });
        assert.ok(rooms.rooms.some(room => room.roomId === bootstrap.roomId));
        await privateSave();
      }
      return { ids: privateState.humans.map(person => person.id), loginRequests: 2 };
    });
    await check('each human has independent simultaneous devices and logout revokes only one device', async () => {
      for (const person of privateState.humans) {
        person.second = await request('/api/login', { body: { user: person.id, password: person.password } });
        assert.notEqual(person.first.access_token, person.second.access_token);
        assert.notEqual(person.first.device_id, person.second.device_id);
        assert.equal((await request('/api/me', { token: person.first.access_token })).user.id, person.id);
        assert.equal((await request('/api/me', { token: person.second.access_token })).user.id, person.id);
        assert.equal((await request('/api/logout', { token: person.first.access_token, body: {} })).loggedOut, true);
        await request('/api/me', { token: person.first.access_token, expected: 401 });
        assert.equal((await request('/api/me', { token: person.second.access_token })).user.id, person.id);
        person.accessToken = person.second.access_token;
        await privateSave();
      }
      await validateServiceSessions();
      return { independentDevicesPerHuman: 2, extraLoginRequests: 2, loginRetries: 0, serviceSessionsValid: true };
    });
    const [nora, omar] = privateState.humans;
    await check('different owners create same-name Bots with distinct stable identities', async () => {
      for (const person of privateState.humans) {
        const input = { name: '共同名字', requestId: `${runId}-bot` };
        const { bot } = await request('/api/bots', { token: person.accessToken, body: input, expected: 201 });
        assert.equal(bot.ownerId, person.id);
        assert.equal((await request('/api/bots', { token: person.accessToken, body: input, expected: 201 })).bot.id, bot.id);
        privateState.bots.push(bot);
        await privateSave();
      }
      assert.notEqual(privateState.bots[0].id, privateState.bots[1].id);
      assert.equal(privateState.bots[0].name, privateState.bots[1].name);
      for (const person of privateState.humans) {
        const expected = privateState.bots.filter(bot => bot.ownerId === person.id).map(bot => bot.id);
        for (const endpoint of ['/api/bots', '/api/my-bots']) assert.deepEqual((await request(endpoint, { token: person.accessToken })).bots.map(bot => bot.id), expected);
      }
      return { bots: privateState.bots.map(({ id, ownerId, name }) => ({ id, ownerId, name })), requestRetriesStable: true };
    });
    const [firstBot, secondBot] = privateState.bots;
    await check('only owners can obtain their Bot connection bundle and credentials are scoped', async () => {
      for (const [person, bot, other] of [[nora, firstBot, omar], [omar, secondBot, nora]]) {
        const route = `/api/bots/${encodeURIComponent(bot.id)}/connect`;
        const { bundle } = await request(route, { token: person.accessToken, body: {} });
        assert.equal(bundle.nodeId, bot.localpart);
        assert.equal(bundle.setup.participants.filter(peer => peer.accessToken).length, 1);
        assert.equal(bundle.setup.participants.find(peer => peer.accessToken).id, bot.id);
        assert.ok(!JSON.stringify(bundle).includes('password'));
        assert.equal((await request(route, { token: person.accessToken, body: {} })).bundle.coreConfig.nodeSecret, bundle.coreConfig.nodeSecret);
        await request(route, { token: other.accessToken, body: {}, expected: 403 });
        bot.bundle = bundle;
        await privateSave();
      }
      assert.notEqual(firstBot.bundle.coreConfig.nodeSecret, secondBot.bundle.coreConfig.nodeSecret);
      return { scopedSecretsDistinct: true, ownerOnly: true, credentialCountPerBundle: 1 };
    });
    let group;
    let message;
    let humanDm;
    await check('service sessions still invite members and open DMs after client logout', async () => {
      group = await request('/api/rooms', { token: nora.accessToken, body: { name: 'Onboarding QA', inviteIds: [omar.id, firstBot.id], requestId: runId } });
      assert.equal(group.status, 'joined');
      assert.deepEqual(new Set(group.participantIds), new Set([nora.id, omar.id, firstBot.id]));
      await request(`/api/rooms/${encodeURIComponent(group.roomId)}/invite`, { token: omar.accessToken, body: { participantId: secondBot.id } });
      humanDm = await request('/api/dm', { token: nora.accessToken, body: { participantId: omar.id } });
      const visible = await request('/api/rooms', { token: omar.accessToken });
      assert.ok(visible.rooms.some(room => room.roomId === humanDm.roomId && room.kind === 'direct'));
      privateState.groupRoomId = group.roomId;
      privateState.humanDmRoomId = humanDm.roomId;
      await privateSave();
      return { groupRoomId: group.roomId, humanDmRoomId: humanDm.roomId, fourMembersJoined: true };
    });
    await check('new humans exchange a real file and a canonical group mention', async () => {
      const content = Buffer.from(`Onboarding synthetic file ${runId}\n`);
      const response = await fetch(`${service.coreUrl}/api/attachments?filename=onboarding.txt`, { method: 'POST',
        headers: { Authorization: `Bearer ${nora.accessToken}`, 'Content-Type': 'text/plain', 'X-Upload-Id': runId }, body: content });
      assert.equal(response.status, 200);
      const { attachment } = await response.json();
      const route = `/api/rooms/${encodeURIComponent(group.roomId)}/messages`;
      const input = { body: `<@${omar.id}> 合成附件`, attachments: [attachment.id], transactionId: runId,
        mentions: { users: [omar.id], roles: [], everyone: false, here: false } };
      message = await request(route, { token: nora.accessToken, body: input });
      assert.equal((await request(route, { token: nora.accessToken, body: input })).event_id, message.event_id);
      const { events } = await request(route, { token: omar.accessToken });
      const event = events.find(event => event.event_id === message.event_id);
      assert.equal(event.sender, nora.id);
      assert.deepEqual(event.content['m.mentions'].user_ids, [omar.id]);
      assert.equal(event.content['org.ds_group'].conversationKind, 'group');
      assert.deepEqual(event.content['org.ds_group'].to, []);
      assert.equal(event.content['org.ds_group'].attachments[0].sha256, digest(content));
      const downloaded = await fetch(`${service.coreUrl}/api/attachments/${encodeURIComponent(attachment.id)}?download=1`, { headers: { Authorization: `Bearer ${omar.accessToken}` } });
      assert.equal(downloaded.status, 200);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), content);
      return { sourceEventId: message.event_id, mentionUserId: omar.id, bytes: content.length, sha256: digest(content), botTargets: 0 };
    });
    await check('scoped node credentials reject other Bot heartbeat model claims and tasks', async () => {
      const firstSecret = firstBot.bundle.coreConfig.nodeSecret;
      const secondSecret = secondBot.bundle.coreConfig.nodeSecret;
      const heartbeat = bot => ({ botId: bot.id, id: bot.localpart, runtimeId: runId, status: 'offline' });
      assert.equal((await request('/internal/nodes/heartbeat', { token: firstSecret, body: heartbeat(firstBot) })).accepted, true);
      await request('/internal/nodes/heartbeat', { token: firstSecret, body: heartbeat(secondBot), expected: 403 });
      await request('/internal/nodes/heartbeat', { token: firstSecret, body: { ...heartbeat(firstBot), id: secondBot.localpart }, expected: 403 });
      await request('/internal/model/claim', { token: firstSecret, body: { nodeId: secondBot.localpart, requestId: `${runId}-denied`, model: 'opencode-go/deepseek-v4.1-flash', maxTokens: 1 }, expected: 403 });
      const task = { requestId: `${runId}-scope-task`, botId: secondBot.id, roomId: group.roomId, eventId: message.event_id,
        status: 'cancelled', summary: 'Synthetic zero-model permission check', toolCalls: 0 };
      await request('/internal/tasks/update', { token: firstSecret, body: task, expected: 403 });
      assert.equal((await request('/internal/tasks/update', { token: secondSecret, body: task })).task.botId, secondBot.id);
      await request(`/internal/tasks/${task.requestId}/control`, { token: firstSecret, expected: 403 });
      assert.equal((await request(`/internal/tasks/${task.requestId}/control`, { token: secondSecret })).requestId, task.requestId);
      const config = JSON.parse(await readFile(path.join(service.options.dataRoot, 'core-config.json'), 'utf8'));
      assert.notEqual(firstSecret, config.nodeSecret);
      const legacyBot = bootstrap.participants.find(person => person.localpart === 'finance');
      assert.equal((await request('/internal/nodes/heartbeat', { token: config.nodeSecret, body: heartbeat(legacyBot) })).accepted, true);
      assert.equal((await request(`/internal/tasks/${task.requestId}/control`, { token: config.nodeSecret })).requestId, task.requestId);
      assert.equal((await request('/api/status')).budget.used, 0);
      return { rejectedCrossBotOperations: ['heartbeat-bot', 'heartbeat-node', 'model-claim', 'task-update', 'task-control'], legacyHeartbeatAndTaskControl: true, acceptedModelClaims: 0 };
    });
    await check('Core restart retains accounts sessions owned Bots scoped secrets and conversations', async () => {
      const previousSessions = await validateServiceSessions();
      const env = { ...process.env, ...service.stopCore.env, DS_GROUP_MATRIX_URL: service.matrixUrl, DS_GROUP_HOST: '127.0.0.1' };
      await execute(process.execPath, ['scripts/service.mjs', 'restart', 'core'], { cwd: root, env, timeout: 60000, maxBuffer: 1024 * 1024 });
      assert.equal((await request('/readyz')).status, 'ready');
      await validateServiceSessions(previousSessions);
      for (const person of privateState.humans) {
        assert.equal((await request('/api/me', { token: person.accessToken })).user.id, person.id);
        const bot = privateState.bots.find(item => item.ownerId === person.id);
        const { bundle } = await request(`/api/bots/${encodeURIComponent(bot.id)}/connect`, { token: person.accessToken, body: {} });
        assert.equal(bundle.coreConfig.nodeSecret, bot.bundle.coreConfig.nodeSecret);
        assert.equal((await request('/api/bots', { token: person.accessToken })).bots[0].id, bot.id);
      }
      assert.equal((await request('/api/dm', { token: nora.accessToken, body: { participantId: omar.id } })).roomId, humanDm.roomId);
      const history = await request(`/api/rooms/${encodeURIComponent(group.roomId)}/messages`, { token: omar.accessToken });
      assert.ok(history.events.some(event => event.event_id === message.event_id));
      return { accountsRecovered: 2, ownedBotsRecovered: 2, clientAndServiceSessionsValid: true, scopedSecretsStable: true, conversationHistoryPreserved: true };
    });
  }
  const final = await request('/api/status');
  assert.equal(final.budget.used, 0);
  assert.equal(final.core.loadedCoreSha256, report.sourceHashes['src/core.mjs']);
  for (const [file, hash] of Object.entries(report.sourceHashes)) assert.equal(digest(await readFile(path.join(root, file))), hash, `${file} changed during verification`);
  report.finalNodes = final.nodes.map(({ id, status }) => ({ id, status }));
  report.status = 'passed';
  privateState.status = 'ready-for-dsh-connect';
  await privateSave();
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.servicesRetained = { core: 22100, matrix: 22008, stopInstructions: '.local/onboarding/qa-server.json' };
  report.completedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: reportPath, ...(report.error ? { error: report.error } : {}) }));
}
