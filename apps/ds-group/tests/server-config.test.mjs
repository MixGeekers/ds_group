import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createCore } from '../src/core.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const stop = server => new Promise(resolve => server.close(resolve));

test('mounted server data configures password login and distinguishes readiness from liveness', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-server-'));
  let available = true;
  const matrix = http.createServer((request, response) => {
    if (request.url === '/_matrix/client/versions' && available) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ versions: ['v1.11'] }));
    } else { response.writeHead(503); response.end('{}'); }
  });
  const homeserverUrl = await listen(matrix);
  const setup = { homeserverUrl, publicHomeserverUrl: 'https://chat.example.test', roomId: '!server:example.test',
    deploymentMode: 'server', participants: [
      { id: '@alice:example.test', localpart: 'alice', name: 'Alice', kind: 'human', accessToken: 'private-test-token' },
    ] };
  await writeFile(path.join(directory, 'matrix-setup.json'), JSON.stringify(setup));
  await writeFile(path.join(directory, 'core-config.json'), JSON.stringify({ nodeSecret: 'test-server-secret', demoLogin: false }));
  let core;
  try {
    core = await createCore({ dataRoot: directory, enablePush: false });
    const base = await listen(core.server);
    const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
    assert.equal(bootstrap.roomId, setup.roomId);
    assert.equal(bootstrap.homeserverUrl, setup.publicHomeserverUrl);
    assert.equal(bootstrap.demoLogin, false);
    assert.equal(bootstrap.mode, 'server');
    assert.equal(JSON.stringify(bootstrap).includes('private-test-token'), false);
    assert.equal((await fetch(base + '/api/demo-login?user=alice')).status, 404);
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await fetch(base + '/readyz')).status, 200);
    available = false;
    assert.equal((await fetch(base + '/readyz')).status, 503);
    assert.equal((await fetch(base + '/healthz')).status, 200);
    const status = await (await fetch(base + '/api/status')).json();
    assert.equal(status.core.evidenceScope, 'server');
    assert.equal(status.budget.used, 0);
  } finally {
    if (core) await core.close();
    await stop(matrix);
    await rm(directory, { recursive: true, force: true });
  }
});

test('first core config is created in the supplied data directory and reused on restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-config-'));
  const setup = { homeserverUrl: 'http://127.0.0.1:1', roomId: '!server:test', participants: [] };
  await writeFile(path.join(directory, 'matrix-setup.json'), JSON.stringify(setup));
  let core;
  try {
    core = await createCore({ dataRoot: directory, enablePush: false });
    await listen(core.server);
    const original = await readFile(path.join(directory, 'core-config.json'), 'utf8');
    assert.equal(JSON.parse(original).nodeSecret.length, 64);
    await core.close();
    core = await createCore({ dataRoot: directory, enablePush: false });
    await listen(core.server);
    assert.equal(await readFile(path.join(directory, 'core-config.json'), 'utf8'), original);
  } finally {
    if (core) await core.close();
    await rm(directory, { recursive: true, force: true });
  }
});
