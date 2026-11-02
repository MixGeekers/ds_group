/** Explicit one-shot product client probe. Uses a separate empty synthetic vault. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { PrivateStdioMcpClient } from '../../../plugins/shiyu/dist/adapters/mcp/index.js';
import { OMBRE_AUDITED_SOURCE, OmbrePublicApiAdapter } from '../../../plugins/shiyu/dist/adapters/ombre/index.js';

const base = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(base, '../..');
const runtime = join(base, 'runtime-stdio');
const source = join(base, 'vendor', `Ombre-Brain-${OMBRE_AUDITED_SOURCE.revision}`);
const hashFile = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const evidence = {
  schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running',
  scope: 'one empty isolated vault, one readI; no embedding/generation/DSH/record writes',
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  calls: 0,
};
let client;
let ownedPid;
try {
  await mkdir(runtime); // Existing run is refused, never silently reused.
  await mkdir(join(runtime, 'tmp'));
  const config = join(runtime, 'config.yaml');
  await writeFile(config, JSON.stringify({
    transport: 'stdio', timezone: 'America/Caracas', log_level: 'INFO',
    embedding: { enabled: false, background_indexing: false },
    dehydration: { api_key: '', api_format: 'openai_compat', base_url: 'http://127.0.0.1:1/v1', model: 'disabled', timeout_seconds: 1 },
    github_sync: { auto_interval_minutes: 0, repo: '', token: '' },
    hooks: { allow_public: false }, decay: { check_interval_hours: 24 },
  }), { mode: 0o600 });
  const env = {
    PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1',
    TMPDIR: join(runtime, 'tmp'), NO_PROXY: '127.0.0.1,localhost',
    OMBRE_CONFIG_PATH: config, OMBRE_VAULT_DIR: join(runtime, 'vault'),
    OMBRE_BUCKETS_DIR: join(runtime, 'vault'), OMBRE_LOG_DIR: join(runtime, 'logs'),
    OMBRE_MEDIA_DIR: join(runtime, 'vault', '_media'), OMBRE_BIND_HOST: '127.0.0.1', OMBRE_HOOK_SKIP: '1',
  };
  const files = [
    'plugins/shiyu/dist/adapters/mcp/index.js', 'plugins/shiyu/dist/adapters/ombre/index.js',
    'plugins/shiyu/package.json', 'plugins/shiyu/package-lock.json',
  ];
  evidence.productFiles = await Promise.all(files.map(async path => ({ path, sha256: await hashFile(join(root, path)) })));
  evidence.source = JSON.parse(await readFile(join(base, 'artifacts/source.json'), 'utf8'));
  evidence.serverSha256 = await hashFile(join(source, 'src/server.py'));
  evidence.configSha256 = await hashFile(config);
  evidence.environmentNames = Object.keys(env).sort();
  client = new PrivateStdioMcpClient({
    command: join(base, '.venv/bin/python'), args: [join(source, 'src/server.py')], cwd: source, env,
    connectTimeoutMs: 30000, callTimeoutMs: 15000,
  });
  evidence.beforeConnect = client.status();
  assert.equal(evidence.beforeConnect.pid, null);
  assert.equal(evidence.beforeConnect.state, 'idle');
  await client.connect();
  evidence.connected = client.status();
  ownedPid = evidence.connected.pid;
  assert.ok(Number.isInteger(ownedPid) && ownedPid > 0);
  evidence.tools = client.listTools().map(tool => tool.name);
  assert.ok(evidence.tools.includes('I'));
  assert.ok(!evidence.tools.some(name => ['you', 'them'].includes(name.toLowerCase())));
  const adapter = new OmbrePublicApiAdapter(client, {
    ...OMBRE_AUDITED_SOURCE, backendId: 'stdio-probe-empty-ombre', vaultScope: 'synthetic-empty-owner',
    deploymentEvidenceRef: 'test:2026-11-02-Ombre服务验证/stdio', relationsDisabled: true, nativeLifecycleAuthorized: true,
  });
  evidence.calls++;
  const result = await adapter.readI({ scope: 'synthetic-empty-owner' });
  assert.equal(result.kind, 'unverified-backend-text');
  assert.equal(result.reportsBackendError, false);
  assert.equal(result.text.trim(), '还没有任何自我认知记录，也没有正在沉淀的候选。');
  evidence.observation = result;
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = { name: error.name, message: String(error.message).slice(0, 500) };
  process.exitCode = 1;
} finally {
  if (client) {
    try { await client.close(); } catch (error) {
      evidence.status = 'failed'; evidence.closeError = error.name; process.exitCode = 1;
    }
    evidence.closed = client.status();
  }
  if (ownedPid !== undefined) {
    try { process.kill(ownedPid, 0); evidence.ownedPidExited = false; }
    catch (error) { evidence.ownedPidExited = error.code === 'ESRCH'; }
    if (!evidence.ownedPidExited) { evidence.status = 'failed'; process.exitCode = 1; }
  }
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(base, 'artifacts/stdio-run.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ status: evidence.status, calls: evidence.calls, ownedPidExited: evidence.ownedPidExited, failure: evidence.failure }));
}
