import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdmin } from '../src/admin.mjs';

test('management serves the three published license texts without exposing other files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dscord-admin-license-'));
  const webRoot = path.join(root, 'web');
  await mkdir(path.join(webRoot, 'licenses'), { recursive: true });
  const names = ['bundled-dependencies', 'ui-foundation', 'lucide'];
  for (const name of names) await writeFile(path.join(webRoot, 'licenses', `${name}.txt`), `Copyright fixture: ${name}\n`);
  await writeFile(path.join(webRoot, 'licenses/private.txt'), 'PRIVATE');
  await writeFile(path.join(webRoot, 'config.json'), '{"private":true}');
  const admin = await createAdmin({ dataRoot: path.join(root, 'data'), webRoot,
    setup: { serverName: 'licenses.test', participants: [], roomId: null },
    controlFactory: () => ({ status: async () => ({}) }) });
  t.after(async () => { await admin.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => admin.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${admin.server.address().port}`;
  for (const name of names) {
    const response = await fetch(`${base}/licenses/${name}.txt`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await response.text(), `Copyright fixture: ${name}\n`);
  }
  for (const route of ['/licenses/private.txt', '/config.json', '/licenses/..%2Fconfig.json']) {
    assert.equal((await fetch(base + route)).status, 404);
  }
  assert.equal((await fetch(`${base}/licenses/lucide.txt`, { method: 'POST' })).status, 404);
});
