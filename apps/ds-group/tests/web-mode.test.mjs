import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createCore } from '../src/core.mjs';
import { effectiveWebMode, parseWebMode } from '../src/web-mode.mjs';
import { initializeServer, serverOptions } from '../scripts/server-init.mjs';

const execute = promisify(execFile);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

async function fixture(t, webMode) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-web-mode-'));
  const webRoot = path.join(directory, 'web'); await mkdir(path.join(webRoot, 'assets'), { recursive: true });
  for (const file of ['index.html', 'assets/client.js', 'manifest.webmanifest', 'sw.js', 'theme.js']) await writeFile(path.join(webRoot, file), `fixture:${file}`);
  const matrix = http.createServer((req, res) => { req.resume(); res.end(JSON.stringify({ versions: ['v1.16'] })); });
  const homeserverUrl = await listen(matrix);
  const config = { nodeSecret: 'synthetic-web-mode-secret', demoLogin: false, ...(webMode === undefined ? {} : { webMode }) };
  const setup = { homeserverUrl, serverName: 'mode.test', participants: [] };
  const core = await createCore({ dataRoot: path.join(directory, 'core'), webRoot, setup, config, enablePush: false });
  const base = await listen(core.server);
  t.after(async () => { await core.close(); await new Promise(resolve => matrix.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { base, core };
}

test('a legacy config without webMode still serves its existing webpage and static resources', async t => {
  const { base } = await fixture(t);
  assert.equal(await (await fetch(base + '/')).text(), 'fixture:index.html');
  assert.equal(await (await fetch(base + '/assets/client.js')).text(), 'fixture:assets/client.js');
  assert.equal((await (await fetch(base + '/api/bootstrap')).json()).web.mode, 'bundled');
});

test('api-only denies existing root/PWA/static files while public APIs and authentication gates remain live', async t => {
  const { base } = await fixture(t, 'api-only');
  for (const file of ['/', '/index.html', '/assets/client.js', '/manifest.webmanifest', '/sw.js', '/theme.js', '/admin']) {
    const response = await fetch(base + file);
    assert.equal(response.status, 404, file);
    assert.equal((await response.json()).code, 'WEB_DISABLED');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await fetch(base + '/', { method: 'HEAD' })).status, 404);
  for (const file of ['/healthz', '/readyz', '/api/bootstrap', '/api/client-config', '/.well-known/dscord/client', '/.well-known/matrix/client']) {
    assert.equal((await fetch(base + file)).status, 200, file);
  }
  assert.equal((await (await fetch(base + '/api/status')).json()).core.webMode, 'api-only');
  assert.equal((await fetch(base + '/api/rooms')).status, 401);
});

test('web mode validation is strict and a runtime environment override never mutates saved input', () => {
  assert.equal(parseWebMode(), 'bundled');
  const config = { webMode: 'api-only' };
  assert.equal(effectiveWebMode(config, {}), 'api-only');
  assert.equal(effectiveWebMode(config, { DS_GROUP_WEB_MODE: '' }), 'api-only');
  assert.equal(effectiveWebMode(config, { DS_GROUP_WEB_MODE: 'bundled' }), 'bundled');
  assert.deepEqual(config, { webMode: 'api-only' });
  for (const value of ['', false, null, 'api', 'true']) assert.throws(() => parseWebMode(value), /bundled or api-only/);
  assert.throws(() => serverOptions({ DS_GROUP_WEB_MODE: 'false' }), /bundled or api-only/);
});

test('initialization persists explicit api-only, keeps it when omitted and permits an explicit bundled rollback', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-mode-init-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = serverOptions({ DS_GROUP_DATA_DIR: path.join(directory, 'core'), DS_GROUP_SYNAPSE_DIR: path.join(directory, 'matrix'), DS_GROUP_WEB_MODE: 'api-only' });
  await initializeServer(options, { containerOwnership: false });
  const read = async () => JSON.parse(await readFile(path.join(options.dataRoot, 'core-config.json'), 'utf8'));
  const original = await read();
  assert.equal(original.webMode, 'api-only');
  await initializeServer({ ...options, webMode: undefined }, { containerOwnership: false });
  assert.deepEqual(await read(), original);
  await initializeServer({ ...options, webMode: 'bundled' }, { containerOwnership: false });
  assert.deepEqual(await read(), { ...original, webMode: 'bundled' });
  const before = await readFile(path.join(options.dataRoot, 'core-config.json'), 'utf8');
  await assert.rejects(initializeServer({ ...options, webMode: 'invalid' }, { containerOwnership: false }), /bundled or api-only/);
  assert.equal(await readFile(path.join(options.dataRoot, 'core-config.json'), 'utf8'), before);
});

test('the actual dscord init CLI supports a persistent mode flag and retains it on an argument-free retry', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-mode-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DS_GROUP_')));
  const cli = path.resolve('bin/dscord.mjs');
  const env = { ...clean, DS_GROUP_DATA_DIR: path.join(directory, 'core'), DS_GROUP_SYNAPSE_DIR: path.join(directory, 'matrix') };
  const result = await execute(process.execPath, [cli, 'init', '--web-mode', 'api-only'], { cwd: directory, env });
  assert.equal(JSON.parse(result.stdout).webMode, 'api-only');
  const result2 = await execute(process.execPath, [cli, 'init'], { cwd: directory, env });
  assert.equal(JSON.parse(result2.stdout).webMode, 'api-only');
  await assert.rejects(execute(process.execPath, [cli, 'init', '--web-mode', 'invalid'], { cwd: directory, env }));
  const config = JSON.parse(await readFile(path.join(directory, 'core', 'core-config.json'), 'utf8'));
  assert.equal(config.webMode, 'api-only');
});
