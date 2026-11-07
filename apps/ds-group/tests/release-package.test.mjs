import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildRelease, collectReleaseFiles, createTar } from '../scripts/release-pack.mjs';
import { readReleaseArchive, verifyRelease } from '../scripts/release-verify.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ds-group-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({ version: '0.1.0', engines: { node: '>=24.19.0 <25' }, dependencies: {} }),
    'package-lock.json': '{}', 'src/core.mjs': 'export const value = "你好";',
    'web/index.html': '<!doctype html>', Dockerfile: 'FROM node:24',
    'web/src/client-config.ts': 'export {};', 'web/client-config.json': '{}', 'dsh-connect/index.mjs': 'export {};',
    'ui/controls.tsx': 'export {};', 'ui/overlays.tsx': 'export {};', 'ui/tailwind.css': '@source "./";', 'web/licenses/ui-foundation.txt': 'MIT',
    'src/identity.mjs': 'export {};', 'src/web-mode.mjs': 'export {};', 'src/admin.mjs': 'export {};',
    'scripts/central-init.mjs': 'export {};', 'scripts/admin.mjs': 'export {};', 'bin/dscord.mjs': '// CLI',
    'admin/index.html': '<!doctype html>', 'admin/vite.config.ts': 'export default {};',
    'deploy/synapse/dscord_guard.py': '# guard', '中央身份实施记录.md': '# Identity', '统一客户端实施记录.md': '# Client',
    'deploy/compose.yaml': 'services: {}', 'deploy/.env.example': 'DOMAIN=localhost',
    'vendor/ds-bot/LICENSE': 'upstream license', 'vendor/ds-bot/NOTICE': 'upstream notice',
    'vendor/ds-bot/package.json': JSON.stringify({ dependencies: {} }),
    'dsh-plugin/index.mjs': 'export {};', 'dsh-plugin/runtime-dependencies.json': '{"dependencies":{}}',
    'dsh-plugin/runtime-dependencies-lock.json': '{"packages":{"":{"dependencies":{}}}}',
    'dsh-plugin/runtime-dependencies-pnpm-lock.yaml': 'lockfileVersion: 9.0',
    'dsh-connect/kernel-runtime.mjs': 'export {};', 'vendor/ds-bot/src/host/message-source.js': 'export {};',
    '.local/credential.json': 'PRIVATE', 'artifacts/evidence.json': 'PRIVATE',
    'deploy/.env': 'PRIVATE', 'deploy/backup.sqlite': 'PRIVATE',
  };
  for (const [filename, contents] of Object.entries(files)) {
    const destination = path.join(root, filename);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  return root;
}

test('release packages are reproducible and extract a verified self-contained source tree', async t => {
  const root = await fixture(t);
  const first = await buildRelease({ root, output: path.join(root, '.local', 'first') });
  const second = await buildRelease({ root, output: path.join(root, '.local', 'second') });
  assert.equal(first.sha256, second.sha256);
  const extracted = path.join(root, '.local', 'unpacked');
  const result = await verifyRelease({ archive: first.archive, extract: extracted });
  assert.equal(result.version, '0.1.0');
  assert.equal(await readFile(path.join(extracted, 'src/core.mjs'), 'utf8'), 'export const value = "你好";');
  const files = [...readReleaseArchive(await readFile(first.archive)).keys()];
  assert.ok(files.includes('ds-group-0.1.0/deploy/.env.example'));
  assert.ok(files.includes('ds-group-0.1.0/vendor/ds-bot/LICENSE'));
  for (const file of ['ui/controls.tsx', 'ui/overlays.tsx', 'ui/tailwind.css', 'web/licenses/ui-foundation.txt']) assert.ok(files.includes(`ds-group-0.1.0/${file}`), file);
  for (const file of ['src/identity.mjs', 'src/web-mode.mjs', 'src/admin.mjs', 'scripts/central-init.mjs', 'scripts/admin.mjs',
    'admin/vite.config.ts', 'deploy/synapse/dscord_guard.py', '中央身份实施记录.md']) assert.ok(files.includes(`ds-group-0.1.0/${file}`), file);
  assert.equal(files.some(filename => /credential|evidence|backup|\/\.env$/.test(filename)), false);
  await assert.rejects(verifyRelease({ archive: first.archive, extract: extracted }), /must be empty/);
});

test('source packaging refuses a missing central or administration deployment entry', async t => {
  const root = await fixture(t);
  await rm(path.join(root, 'scripts/central-init.mjs'));
  await assert.rejects(buildRelease({ root }), /missing scripts\/central-init/);
});

test('dependency directory symlinks are excluded while source symlinks fail packaging', async t => {
  const root = await fixture(t);
  await symlink(path.join(root, '.local'), path.join(root, 'vendor/ds-bot/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await collectReleaseFiles(root)).some(file => file.path.includes('node_modules')), false);
  await symlink(path.join(root, '.local'), path.join(root, 'src/private'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(collectReleaseFiles(root), /symlink/);
});

test('verification rejects altered archives and path traversal', async t => {
  const root = await fixture(t);
  const release = await buildRelease({ root });
  const altered = await readFile(release.archive);
  altered[altered.length - 1] ^= 1;
  await writeFile(release.archive, altered);
  await assert.rejects(verifyRelease({ archive: release.archive }), /SHA256/);
  const unsafe = gzipSync(createTar([{ path: 'ds-group-0.1.0/../escape', bytes: Buffer.from('bad') }]));
  assert.throws(() => readReleaseArchive(unsafe), /Unsafe/);
});
