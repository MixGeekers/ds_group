import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const launcher = fileURLToPath(new URL('../scripts/dsh-node.mjs', import.meta.url));

test('exported native Bot identities cannot prepare or start a second standalone kernel', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-native-owner-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, 'core-config.json');
  await writeFile(config, JSON.stringify({ executionMode: 'native',
    nativeBinding: { hostId: 'owner-host', nativeBotId: 'native-bot', botId: '@test:synthetic.local' } }));
  const env = { ...process.env, DS_GROUP_DATA_DIR: directory, DS_GROUP_BRIDGE_PORT: '23199',
    DS_GROUP_CORE_CONFIG_PATH: config, DS_GROUP_CORE_URL: 'http://127.0.0.1:9',
    DS_GROUP_DSH_CLI: '/a-dsh-cli-that-must-not-be-resolved', DS_GROUP_DSH_SOURCE_HOME: path.join(directory, 'unused-source') };
  for (const operation of ['prepare', 'run', 'start']) {
    await assert.rejects(execute(process.execPath, [launcher, operation, 'native-owner'], { env, timeout: 10_000 }), error => {
      assert.match(error.stderr, /DSCORD_NATIVE_BOT_HOST_REQUIRED/);
      assert.doesNotMatch(error.stderr, /does not name an executable|MISSING_CREDENTIAL/);
      return true;
    });
  }
  assert.deepEqual(await readdir(directory), ['core-config.json'], 'The rejected identity must not create a second home, dependencies or process');
});
