import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryTestHost, requestMemoryHost } from '../scripts/memory-host.mjs';

async function serverFor(t, handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

test('local API waits for delayed headers and body, retains cookie and sends exact JSON', async t => {
  let auths = 0, apiCalls = 0;
  const { port, url } = await serverFor(t, (request, response) => {
    if (request.url === '/login') {
      auths++; response.writeHead(302, { 'set-cookie': 'dsh=synthetic-session; HttpOnly', location: '/must-not-follow' }); response.end(); return;
    }
    assert.equal(request.url, '/api/memory-test'); assert.equal(request.method, 'POST');
    assert.equal(request.headers.cookie, 'dsh=synthetic-session'); assert.equal(request.headers['content-type'], 'application/json');
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      apiCalls++; assert.deepEqual(JSON.parse(body), { action: 'compact', input: { index: 1, text: '中文' } });
      setTimeout(() => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"ok":true,');
        setTimeout(() => response.end('"value":{"compacted":true}}'), 30); }, 50);
    });
  });
  const directory = await mkdtemp(path.join(tmpdir(), 'memory-host-http-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const host = new MemoryTestHost(directory, { requestTimeoutMs: 1000 }); host.port = port; host.logfile = path.join(directory, 'host.log');
  await writeFile(host.logfile, `dsh web: ${url}/login\n`);
  for (let n = 0; n < 2; n++) assert.deepEqual(await host.api('compact', { index: 1, text: '中文' }), { compacted: true });
  assert.equal(auths, 1); assert.equal(apiCalls, 2);
});

test('local API deadline covers waiting for headers and exposes ETIMEDOUT', async t => {
  const { port } = await serverFor(t, () => {});
  const host = new MemoryTestHost(tmpdir(), { requestTimeoutMs: 40 }); host.port = port; host.cookie = 'dsh=test';
  await assert.rejects(host.api('flush'), error => error.code === 'ETIMEDOUT' && error.timeoutMs === 40);
});

test('overall deadline expires even while the response body keeps arriving', async t => {
  const { url } = await serverFor(t, (_request, response) => {
    response.writeHead(200); response.write('x');
    const timer = setInterval(() => response.write('x'), 10);
    response.on('close', () => clearInterval(timer));
  });
  await assert.rejects(requestMemoryHost(url, { timeoutMs: 60 }), error => error.code === 'ETIMEDOUT');
});

test('connection failure retains the native network cause code', async () => {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  await assert.rejects(requestMemoryHost(`http://127.0.0.1:${port}`, { timeoutMs: 1000 }), error => error.code === 'ECONNREFUSED');
});

test('truncated HTTP response is a network error rather than a JSON success', async t => {
  const { url } = await serverFor(t, (_request, response) => {
    response.writeHead(200, { 'content-length': 200 }); response.write('{"ok":true');
    setTimeout(() => response.destroy(), 10);
  });
  await assert.rejects(requestMemoryHost(url, { timeoutMs: 1000 }), error => error.code === 'ECONNRESET');
});

test('response bytes are bounded independently of HTTP Content-Length', async t => {
  const { url } = await serverFor(t, (_request, response) => { response.writeHead(200); response.end('x'.repeat(100)); });
  await assert.rejects(requestMemoryHost(url, { maxResponseBytes: 16 }), error => error.code === 'MEMORY_HOST_RESPONSE_TOO_LARGE' && error.maxResponseBytes === 16);
});

test('API structured error code, HTTP status and malformed JSON remain distinguishable', async t => {
  const replies = [{ status: 200, body: JSON.stringify({ ok: false, error: { code: 'NATIVE_REVIEW_BLOCKED', message: 'review blocked' } }) },
    { status: 503, body: JSON.stringify({ ok: false, error: { message: 'temporarily unavailable' } }) }, { status: 200, body: '{broken' }];
  const { port } = await serverFor(t, (_request, response) => { const next = replies.shift(); response.writeHead(next.status); response.end(next.body); });
  const host = new MemoryTestHost(tmpdir()); host.port = port; host.cookie = 'dsh=test';
  await assert.rejects(host.api('flush'), error => error.code === 'NATIVE_REVIEW_BLOCKED' && error.message === 'review blocked' && error.remoteError.code === error.code);
  await assert.rejects(host.api('flush'), error => error.code === 'HTTP_503' && error.statusCode === 503);
  await assert.rejects(host.api('flush'), error => error.code === 'MEMORY_HOST_INVALID_JSON' && error.cause instanceof SyntaxError);
});
