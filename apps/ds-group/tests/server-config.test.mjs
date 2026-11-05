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

test('login rate limits preserve the upstream retry interval for clients', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-login-limit-'));
  const matrix = http.createServer((request, response) => {
    request.resume();
    response.writeHead(429, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests', retry_after_ms: 2300 }));
  });
  const homeserverUrl = await listen(matrix);
  let core;
  try {
    core = await createCore({ dataRoot: directory, enablePush: false,
      setup: { homeserverUrl, serverName: 'rate.test', participants: [] },
      config: { nodeSecret: 'synthetic-rate-secret', demoLogin: false } });
    const base = await listen(core.server);
    const response = await fetch(base + '/api/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'test', password: 'synthetic-password' }) });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '3');
    assert.deepEqual(await response.json(), { error: 'Too many requests', code: 'M_LIMIT_EXCEEDED', retry_after_ms: 2300 });
  } finally {
    if (core) await core.close();
    await stop(matrix);
    await rm(directory, { recursive: true, force: true });
  }
});

test('login forwards the socket IP and accepts only the last valid hop from an explicitly trusted proxy', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-client-ip-'));
  const received = [];
  const matrix = http.createServer((request, response) => {
    received.push(request.headers['x-forwarded-for']);
    request.resume();
    response.writeHead(429, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ errcode: 'M_LIMIT_EXCEEDED', error: 'Synthetic limit' }));
  });
  const homeserverUrl = await listen(matrix);
  try {
    for (const trustProxy of [false, true]) {
      const core = await createCore({ dataRoot: path.join(directory, String(trustProxy)), enablePush: false,
        setup: { homeserverUrl, serverName: 'ip.test', participants: [] },
        config: { nodeSecret: 'synthetic-ip-secret', demoLogin: false, trustProxy } });
      try {
        const base = await listen(core.server);
        for (const forwarded of ['198.51.100.9, 203.0.113.4', 'invalid']) {
          const response = await fetch(base + '/api/login', { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwarded },
            body: JSON.stringify({ user: 'test', password: 'synthetic-password' }) });
          assert.equal(response.status, 429);
        }
      } finally { await core.close(); }
    }
    assert.deepEqual(received, ['127.0.0.1', '127.0.0.1', '203.0.113.4', '127.0.0.1']);
  } finally {
    await stop(matrix);
    await rm(directory, { recursive: true, force: true });
  }
});
