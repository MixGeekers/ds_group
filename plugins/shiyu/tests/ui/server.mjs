import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { makeSession, makeSnapshot } from './fixtures.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.env.SHIYU_UI_PORT ?? 4341);
let snapshot = makeSnapshot(), failReads = false, stateReads = 0, commands = [];
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const readJson = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === '/__test/control' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.reset) { snapshot = makeSnapshot(body); stateReads = 0; commands = []; failReads = false; }
      if (Object.hasOwn(body, 'failReads')) failReads = Boolean(body.failReads);
      if (body.snapshot) snapshot = body.snapshot;
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__test/stats' && req.method === 'GET') return json(res, 200, { stateReads, commands });
    if (url.pathname === '/api/shiyu/state') {
      if (req.method !== 'GET') return json(res, 405, { error: 'Only GET is supported.' });
      stateReads++;
      return failReads ? json(res, 503, { error: { code: 'TEST_UNAVAILABLE', message: '合成测试：状态读取暂不可用。' } }) : json(res, 200, snapshot);
    }
    if (url.pathname === '/api/shiyu/commands') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Only POST is supported.' });
      const body = await readJson(req);
      if (!['session.probe', 'runtime.pause', 'runtime.resume'].includes(body.action)) return json(res, 400, { error: 'Unknown synthetic command.' });
      commands.push(body);
      if (body.action === 'runtime.pause') snapshot = { ...snapshot, state: 'paused' };
      else if (body.action === 'runtime.resume') snapshot = { ...snapshot, state: 'idle' };
      else {
        snapshot = { ...snapshot, sessions: [makeSession()], activities: [{ id: 'test-probe-activity', at: snapshot.observedAt, kind: 'diagnostic', title: '合成测试活动：无模型会话检查完成', status: 'succeeded' }] };
      }
      return json(res, 200, { ok: true, action: body.action, ...(body.action === 'session.probe' ? { ready: true, noModelCalled: true, released: true, archived: true } : {}), snapshot });
    }
    return vite.middlewares(req, res);
  } catch (error) {
    return json(res, 500, { error: { message: error.message } });
  }
});
// Vite 8's client still opens its transport when HMR is off. Attach that
// transport to this same loopback server, rather than opening another port.
const vite = await createServer({
  configFile: false, root: fileURLToPath(new URL('./', import.meta.url)),
  cacheDir: path.join(packageRoot, '.local', 'ui', 'vite'), appType: 'spa',
  server: { middlewareMode: true, hmr: false, ws: { server }, fs: { allow: [packageRoot] } },
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
let closing;
const close = () => closing ??= (async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await vite.close(); })();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void close().then(() => process.exit(0)));
console.log(`Shiyu synthetic UI harness, no models: http://127.0.0.1:${port}`);
