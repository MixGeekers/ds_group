// A real Gym service behind a simulated DSH connection. Never invokes a model.
import http from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { apply } from '../../index.js';
import { resolveModel } from './model-catalog.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const port = Number(process.env.GYM_UI_PORT ?? 4339);
await mkdir(path.join(root, 'runtime'), { recursive: true });
const runtimeDir = await mkdtemp(path.join(root, 'runtime', 'plugin-ui-'));
const routes = new Map(), disposers = [];
const ctx = {
  get: name => name === 'llm' ? { resolveCallConfig: async selection => resolveModel(selection) } : undefined, on: () => () => {}, provide() {},
  agents: { list: () => [], create() { throw new Error('Model calls are forbidden in this UI harness'); } },
  tools: { register: () => () => {} },
  effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose; },
  connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
};
await apply(ctx, { runtimeDir });
const vite = await createServer({
  configFile: false, root: fileURLToPath(new URL('./', import.meta.url)),
  cacheDir: path.join(root, '.cache', 'plugin-ui', 'vite'), appType: 'spa',
  server: { middlewareMode: true, hmr: false, fs: { allow: [root] } },
});
const server = http.createServer(async (req, res) => {
  const route = routes.get(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
  if (!route) return vite.middlewares(req, res);
  if (!route.methods.includes(req.method)) { res.writeHead(405); res.end(); return; }
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const response = await route.fetch(new Request(new URL(req.url, `http://127.0.0.1:${port}`), { method: req.method, headers: req.headers, ...(req.method === 'GET' ? {} : { body: Buffer.concat(chunks) }) }));
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
let closing;
const close = () => closing ??= (async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await vite.close(); for (const dispose of disposers.reverse()) await dispose?.(); })();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void close().then(() => process.exit(0)));
console.log(`Simulated DSH UI host, real Lab service: http://127.0.0.1:${port}`);
