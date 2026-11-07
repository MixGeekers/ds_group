import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { packageRoot } from '../src/paths.mjs';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

test('detached DSH launcher preserves caller-relative paths for a non-demo Bot', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dscord-portable-cli-')));
  const nodeId = 'independent-editor';
  const local = path.join(directory, 'data', `dsh-${nodeId}`);
  const script = path.join(packageRoot, 'scripts/dsh-node.mjs');
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('DS_GROUP_') || key === 'OPENCODE_API_KEY' || key === 'NODE_OPTIONS') delete env[key];
  Object.assign(env, { DS_GROUP_DATA_DIR: './data', DS_GROUP_CORE_CONFIG_PATH: './settings/core.json',
    DS_GROUP_BRIDGE_PORT: String(port), DS_GROUP_DSH_RUNTIME: './sdk', DS_GROUP_DSH_CLI: './sdk/cli.mjs',
    DS_GROUP_MODEL_SOURCE_PATH: './settings/model.json', PORTABILITY_MARKER: path.join(directory, 'launched.json') });
  let record;
  t.after(async () => {
    if (record?.pid) {
      try { process.kill(-record.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, 'settings'));
  await writeFile(path.join(directory, 'settings/core.json'), JSON.stringify({ nodeSecret: 'synthetic', publicUrl: 'https://collaboration.example' }));
  await writeFile(path.join(directory, 'settings/model.json'), JSON.stringify({
    selection: { model: 'local-company/team/editor', maxTokens: 8192 }, providers: {
      'local-company': { api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'team/editor' }] },
    },
  }));
  // The CLI double records its invocation only; no SDK host or provider is started.
  await mkdir(path.join(directory, 'sdk'));
  await writeFile(path.join(directory, 'sdk/cli.mjs'), `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';
writeFileSync(process.env.PORTABILITY_MARKER,JSON.stringify({home:process.env.DSH_HOME,cwd:process.cwd(),args:process.argv.slice(2)}));
process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);\n`);
  await chmod(path.join(directory, 'sdk/cli.mjs'), 0o755);
  const dependencies = path.join(directory, 'data/dsh-deps');
  await mkdir(dependencies, { recursive: true });
  const source = path.join(packageRoot, 'dsh-plugin');
  const locks = await Promise.all(['runtime-dependencies.json', 'runtime-dependencies-lock.json', 'runtime-dependencies-pnpm-lock.yaml']
    .map(name => readFile(path.join(source, name))));
  const modules = path.resolve(path.dirname(require.resolve('yaml/package.json')), '..');
  await symlink(modules, path.join(dependencies, 'node_modules'), 'dir');
  await writeFile(path.join(dependencies, 'package.json'), locks[0]);
  await writeFile(path.join(dependencies, '.runtime-lock.sha256'), createHash('sha256').update(locks[0]).update(locks[1]).update(locks[2]).digest('hex'));

  const start = await execute(process.execPath, [script, 'start', nodeId], { cwd: directory, env, timeout: 5000 });
  record = JSON.parse(start.stdout);
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(env.PORTABILITY_MARKER); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await delay(50); }
  }
  const launched = JSON.parse(await readFile(env.PORTABILITY_MARKER, 'utf8'));
  const config = JSON.parse(await readFile(path.join(local, 'node-config.json'), 'utf8'));
  assert.equal(config.model, 'local-company/team/editor');
  assert.equal(config.maxTokens, 8192);
  assert.equal(config.coreUrl, 'https://collaboration.example');
  assert.equal(config.dataDir, path.join(local, 'runtime'));
  assert.equal(launched.home, path.join(local, 'home'));
  assert.equal(launched.cwd, local);
  assert.equal(launched.args[0], 'web');
  await execute(process.execPath, [script, 'stop', nodeId], { cwd: directory, env, timeout: 5000 });
  record = undefined;
});
