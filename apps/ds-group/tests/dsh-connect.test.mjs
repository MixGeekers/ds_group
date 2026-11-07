import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConnectController } from '../dsh-connect/controller.mjs';
import { NodeProcesses } from '../dsh-connect/processes.mjs';

const serverUrl = 'https://chat.example';
const userId = '@alice:chat.example';
const bot = { id: '@alice-helper:chat.example', name: 'Helper', kind: 'bot', localpart: 'alice-helper', ownerId: userId };

function bundle() {
  return {
    schemaVersion: 1, nodeId: bot.localpart, coreUrl: serverUrl,
    setup: { serverName: 'chat.example', roomId: '!lobby:chat.example', homeserverUrl: 'https://matrix.example',
      publicHomeserverUrl: 'https://matrix.example', participants: [{ ...bot, accessToken: 'synthetic-bot-token' }] },
    coreConfig: { nodeSecret: 'synthetic-node-key', publicUrl: serverUrl, modelCallLimit: 0, maxOutputTokens: 1024 },
  };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-connect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const live = new Set();
  const effects = [];
  const processes = {
    async available() { return { available: true, message: null }; },
    async start(node) { effects.push(['start', node.id]); live.add(node.id); },
    async stop(node) { effects.push(['stop', node.id]); live.delete(node.id); },
    async probe(node) { return { status: live.has(node.id) ? 'online' : 'offline', lastError: null }; },
    ...options.processes,
  };
  let logins = 0;
  const request = async (url, init) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, init });
    if (pathname === '/api/login') {
      logins++;
      return Response.json({ user_id: userId, access_token: `synthetic-human-token-${logins}` });
    }
    if (pathname === '/api/status') return Response.json({ budget: options.policy || { maxTokens: 8192, allowedModels: null } });
    if (pathname === '/api/bots') return Response.json({ bots: [bot] });
    if (pathname === `/api/bots/${encodeURIComponent(bot.id)}/connect`) {
      await options.beforeBundle?.();
      return Response.json({ bundle: options.bundle?.() || bundle() });
    }
    if (pathname === '/api/logout') return Response.json({});
    return Response.json({ error: 'Unknown route' }, { status: 404 });
  };
  const settings = { directory, processes, models: options.models, request, selectPort: async () => 23100 };
  const controller = await new ConnectController(settings).initialize();
  await controller.restoring;
  const login = () => controller.handle({ action: 'login', serverUrl, user: 'alice', password: 'synthetic-password' });
  return { directory, calls, effects, live, processes, controller, settings, login };
}

test('DSH connection login stores a private client token and never persists or returns the password', async t => {
  const { directory, controller, login, calls } = await fixture(t);
  assert.deepEqual(await readdir(directory), []);
  assert.equal((await controller.handle({ action: 'status' })).user, null);
  const result = await login();
  assert.equal(result.user.id, userId);
  assert.equal(result.bots[0].status, 'offline');
  assert.equal(result.dataDirectory, directory);
  assert.equal(JSON.stringify(result).includes('synthetic-human-token'), false);
  const filename = path.join(directory, 'connection.json');
  const saved = await readFile(filename, 'utf8');
  assert.equal(saved.includes('synthetic-password'), false);
  assert.equal(JSON.parse(saved).accessToken, 'synthetic-human-token-1');
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);
  await login();
  const logout = calls.find(call => call.pathname === '/api/logout');
  assert.equal(logout.init.headers.Authorization, 'Bearer synthetic-human-token-1');
  await controller.dispose();
});

test('DSH decision settings action forwards the selected protocol route without dropping it', async t => {
  const received = [];
  const { controller } = await fixture(t, { processes: {
    async saveDecisionProvider(settings) { received.push(settings); return { configured: true, model: settings.model }; },
  } });
  t.after(() => controller.dispose());
  const input = { apiKey: 'synthetic-private-decision-key', enabled: true,
    model: 'company/decision-v2', endpoint: 'https://decision.example/v2/decisions' };
  const result = await controller.handle({ action: 'save-decision-provider', ...input });
  assert.deepEqual(received, [input]);
  assert.equal(result.model, input.model);
  assert.equal(JSON.stringify(result).includes(input.apiKey), false);
});

test('DSH connect is idempotent, preserves identity across reload, and explicit disconnect stays offline', async t => {
  const { controller, login, settings, directory, effects } = await fixture(t);
  await login();
  await Promise.all([controller.handle({ action: 'connect', botId: bot.id }), controller.handle({ action: 'connect', botId: bot.id })]);
  assert.deepEqual(effects, [['start', bot.id]]);
  const node = controller.state.nodes[bot.id];
  assert.ok(node.directory.startsWith(path.join(directory, 'nodes') + path.sep));
  const setupPath = path.join(node.directory, 'matrix-setup.json');
  const initialSetup = await readFile(setupPath, 'utf8');
  if (process.platform !== 'win32') assert.equal((await stat(setupPath)).mode & 0o777, 0o600);
  await writeFile(path.join(node.directory, 'history-marker'), 'keep');
  await controller.dispose();
  assert.equal(JSON.parse(await readFile(path.join(directory, 'connection.json'), 'utf8')).nodes[bot.id].desired, true);
  const restored = await new ConnectController(settings).initialize();
  await restored.restoring;
  assert.equal((await restored.handle({ action: 'status' })).bots[0].status, 'online');
  assert.equal(await readFile(setupPath, 'utf8'), initialSetup);
  assert.equal(await readFile(path.join(node.directory, 'history-marker'), 'utf8'), 'keep');
  await restored.handle({ action: 'disconnect', botId: bot.id });
  await restored.dispose();
  const offline = await new ConnectController(settings).initialize();
  await offline.restoring;
  assert.equal((await offline.handle({ action: 'status' })).bots[0].status, 'offline');
  assert.deepEqual(effects, [['start', bot.id], ['stop', bot.id], ['start', bot.id], ['stop', bot.id]]);
  await offline.dispose();
});

test('failed Bot start drains partial processes and remains retryable', async t => {
  let fail = true;
  let starts = 0;
  let stops = 0;
  const { controller, login } = await fixture(t, { processes: {
    async start() { starts++; if (fail) throw new Error('synthetic startup failure'); },
    async stop() { stops++; },
    async probe() { return { status: 'online', lastError: null }; },
  } });
  await login();
  await assert.rejects(controller.handle({ action: 'connect', botId: bot.id }), /synthetic startup failure/);
  assert.equal(stops, 1);
  const failed = await controller.handle({ action: 'status' });
  assert.equal(failed.bots[0].status, 'error');
  assert.equal(failed.bots[0].connected, true);
  fail = false;
  assert.equal((await controller.handle({ action: 'connect', botId: bot.id })).bots[0].status, 'online');
  assert.equal(starts, 2);
  await controller.handle({ action: 'logout' });
  assert.equal((await controller.handle({ action: 'status' })).user, null);
  await controller.dispose();
});

test('DSH connection rejects unknown ownership and mismatched node bundle before spawning', async t => {
  const { controller, login, effects, directory } = await fixture(t, { bundle: () => ({ ...bundle(), nodeId: 'another-bot' }) });
  await login();
  await assert.rejects(controller.handle({ action: 'connect', botId: '@other:chat.example' }), /自己的 Bot/);
  await assert.rejects(controller.handle({ action: 'connect', botId: bot.id }), /身份不匹配/);
  await assert.rejects(controller.handle({ action: 'login', serverUrl: 'https://name:secret@example.com', user: 'alice', password: 'synthetic' }), /without credentials/);
  assert.deepEqual(effects, []);
  assert.deepEqual(await readdir(directory), ['connection.json']);
  await controller.dispose();
});

test('isolated node environment uses the selected server bundle and its own absolute data paths', () => {
  const runner = new NodeProcesses({ sourceHome: '/fixture/source', sourceProfile: 'web', env: {
    DS_GROUP_DATA_DIR: '/unrelated', DS_GROUP_MATRIX_URL: 'http://unrelated-matrix', PATH: '/fixture/bin',
  } });
  const directory = path.resolve('synthetic-node');
  const env = runner.environment({ directory, serverUrl, port: 23104 });
  assert.equal(env.DS_GROUP_DATA_DIR, directory);
  assert.equal(env.DS_GROUP_MATRIX_SETUP_PATH, path.join(directory, 'matrix-setup.json'));
  assert.equal(env.DS_GROUP_MATRIX_URL, undefined);
  assert.equal(env.DS_GROUP_DSH_SOURCE_HOME, '/fixture/source');
  assert.equal(env.DS_GROUP_DSH_SOURCE_PROFILE, 'web');
  assert.equal(env.DS_GROUP_CORE_URL, serverUrl);
  assert.equal(env.DS_GROUP_BOT_ENDPOINT, 'http://127.0.0.1:23104');
});

test('DSH process controller rejects aggregate service commands as Bot identities', async () => {
  const runner = new NodeProcesses();
  for (const localpart of ['all', 'core', '../core']) {
    await assert.rejects(runner.command({ localpart }, 'scripts/service.mjs', ['up', localpart]), /保留名称/);
  }
});

test('failed login persistence retains the previous identity and revokes the unused new session', async t => {
  const { controller, login, calls, directory } = await fixture(t);
  await login();
  const previous = controller.state;
  const savedFilename = controller.filename;
  controller.filename = path.join(directory, 'missing-parent', 'connection.json');
  await assert.rejects(login(), /ENOENT/);
  assert.equal(controller.state, previous);
  assert.equal(JSON.parse(await readFile(savedFilename, 'utf8')).accessToken, 'synthetic-human-token-1');
  const logout = calls.find(call => call.pathname === '/api/logout');
  assert.equal(logout.init.headers.Authorization, 'Bearer synthetic-human-token-2');
  controller.filename = savedFilename;
  await controller.dispose();
});

test('host disposal starts every Bot cleanup before waiting for an individual drain', async t => {
  const stops = [];
  const finish = [];
  const { controller } = await fixture(t, { processes: {
    async stop(node) { stops.push(node.id); await new Promise(resolve => finish.push(resolve)); },
  } });
  for (const id of ['one', 'two']) {
    controller.state.nodes[id] = { id, desired: true };
    controller.running.set(id, { status: 'online', lastError: null });
  }
  const disposing = controller.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(stops, ['one', 'two']);
  for (const resolve of finish) resolve();
  await disposing;
  assert.equal(controller.state.nodes.one.desired, true);
  assert.equal(controller.state.nodes.two.desired, true);
});

test('host disposal dispatches cleanup while a Bot startup command is still pending', async t => {
  let releaseStartup;
  let started;
  const startup = new Promise(resolve => { releaseStartup = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  let stops = 0;
  const { controller, login } = await fixture(t, { processes: {
    async start() { started(); await startup; },
    async stop() { stops++; },
  } });
  await login();
  const connecting = controller.handle({ action: 'connect', botId: bot.id });
  await ready;
  const disposing = controller.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 1);
  releaseStartup();
  await Promise.all([connecting, disposing]);
  assert.equal(controller.running.size, 0);
});

test('a connection awaiting a remote bundle cannot launch after the plugin begins closing', async t => {
  let releaseBundle;
  let requested;
  const bundleReady = new Promise(resolve => { releaseBundle = resolve; });
  const arrived = new Promise(resolve => { requested = resolve; });
  const { controller, login, effects } = await fixture(t, { beforeBundle: async () => { requested(); await bundleReady; } });
  await login();
  const connecting = controller.handle({ action: 'connect', botId: bot.id });
  await arrived;
  const disposing = controller.dispose();
  releaseBundle();
  await assert.rejects(connecting, /正在关闭/);
  await disposing;
  assert.deepEqual(effects, []);
  assert.deepEqual(controller.state.nodes, {});
});

test('per-Bot selections persist before connection and apply on reconnect with only a private credential snapshot', async t => {
  const first = { model: 'first/team/chat', maxTokens: 2048 };
  const second = { model: 'second/other', maxTokens: 4096 };
  const models = {
    view: async () => ({ available: true, providers: [], defaultSelection: first }),
    async export(selection = first) {
      if (selection.model === 'invalid/model') throw Object.assign(new Error('Missing model'), { code: 'MODEL_UNAVAILABLE' });
      return { selection, providers: { [selection.model.split('/')[0]]: { apiKeyEnv: 'KEY' } },
        credentials: { version: 1, refs: { KEY: 'synthetic-private-model-key' }, records: {} } };
    },
  };
  const { controller, login, effects, directory, settings } = await fixture(t, { models });
  await login();
  const initial = await controller.handle({ action: 'save-model', botId: bot.id, selection: first });
  assert.deepEqual(initial.bots[0].modelSelection, first);
  assert.deepEqual(effects, []);
  await controller.handle({ action: 'connect', botId: bot.id });
  assert.deepEqual((await controller.status()).bots[0].activeModel, first);
  const saved = await controller.handle({ action: 'save-model', botId: bot.id, selection: second });
  assert.deepEqual(saved.bots[0].activeModel, first);
  assert.deepEqual(saved.bots[0].modelSelection, second);
  assert.deepEqual(effects, [['start', bot.id]]);
  const priorState = await readFile(path.join(directory, 'connection.json'), 'utf8');
  await assert.rejects(controller.handle({ action: 'save-model', botId: bot.id, selection: { model: 'invalid/model' } }), { code: 'MODEL_UNAVAILABLE' });
  assert.equal(await readFile(path.join(directory, 'connection.json'), 'utf8'), priorState);
  assert.equal(priorState.includes('synthetic-private-model-key'), false);
  assert.equal(JSON.stringify(saved).includes('synthetic-private-model-key'), false);
  await controller.handle({ action: 'disconnect', botId: bot.id });
  await controller.handle({ action: 'connect', botId: bot.id });
  const node = controller.state.nodes[bot.id];
  const sourcePath = path.join(node.directory, 'model-source.json');
  assert.deepEqual(JSON.parse(await readFile(sourcePath, 'utf8')).selection, second);
  if (process.platform !== 'win32') assert.equal((await stat(sourcePath)).mode & 0o777, 0o600);
  const runner = new NodeProcesses({ env: { DS_GROUP_MODEL: 'ambient/wrong', OPENCODE_API_KEY: 'ambient-secret' } });
  const env = runner.environment(node);
  assert.equal(env.DS_GROUP_MODEL_SOURCE_PATH, sourcePath);
  assert.equal(env.DS_GROUP_MODEL, undefined);
  assert.equal(env.OPENCODE_API_KEY, undefined);
  await controller.dispose();
  const restored = await new ConnectController(settings).initialize();
  await restored.restoring;
  assert.deepEqual((await restored.status()).bots[0].activeModel, second);
  await restored.dispose();
});

test('legacy connection state migrates its prepared model before a changed DSH default can run', async t => {
  const { controller, login, settings } = await fixture(t);
  await login();
  await controller.handle({ action: 'connect', botId: bot.id });
  const node = controller.state.nodes[bot.id];
  const preparedDirectory = path.join(node.directory, `dsh-${node.localpart}`);
  await mkdir(preparedDirectory, { recursive: true });
  await writeFile(path.join(preparedDirectory, 'node-config.json'), JSON.stringify({ model: 'legacy/model', maxTokens: 3072 }));
  await controller.dispose();
  const selections = [];
  settings.models = {
    view: async () => ({ providers: [] }),
    export: async selection => {
      selections.push(selection);
      return { selection, providers: {}, credentials: {} };
    },
  };
  const restored = await new ConnectController(settings).initialize();
  await restored.restoring;
  assert.deepEqual(selections, [{ model: 'legacy/model', maxTokens: 3072 }]);
  await restored.dispose();
});

test('server model policy rejects a selection before persistence or node startup', async t => {
  const selection = { model: 'first/chat', maxTokens: 4096 };
  const models = {
    view: async () => ({ available: true, providers: [], defaultSelection: selection }),
    export: async input => ({ selection: { ...selection, ...input }, providers: {}, credentials: {} }),
  };
  const { controller, login, directory, effects } = await fixture(t, { models,
    policy: { allowedModels: ['second/chat'], maxTokens: 8192 },
  });
  await login();
  const before = await readFile(path.join(directory, 'connection.json'), 'utf8');
  await assert.rejects(controller.handle({ action: 'save-model', botId: bot.id, selection }), { code: 'MODEL_POLICY_DENIED' });
  await assert.rejects(controller.handle({ action: 'connect', botId: bot.id }), { code: 'MODEL_POLICY_DENIED' });
  assert.equal(await readFile(path.join(directory, 'connection.json'), 'utf8'), before);
  assert.deepEqual(effects, []);
  await assert.rejects(controller.handle({ action: 'save-model', botId: bot.id,
    selection: { model: 'second/chat', maxTokens: 9000 } }), { code: 'MODEL_OUTPUT_LIMIT' });
  await controller.dispose();
});
