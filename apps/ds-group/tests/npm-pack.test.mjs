import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packNpm } from '../scripts/npm-pack.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dscord-npm-pack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({ name: 'ds-group', version: '0.2.0', private: true, license: 'MIT',
      engines: { node: '>=24.19.0 <25' }, dependencies: {} }),
    'package-lock.json': JSON.stringify({ version: '0.2.0', packages: { '': { version: '0.2.0' } } }),
    LICENSE: 'MIT fixture license',
    'bin/dscord.mjs': '#!/usr/bin/env node\nconsole.log("fixture");',
    'dsh-connect/index.mjs': 'export {};', 'dsh-connect/client.js': '// DSH client', 'cordis.patch.yml': '[]',
    'src/core.mjs': 'import "../web/mention-tokens.js";',
    'memory/native.mjs': 'export {};', 'service/ombre/service.py': '# memory service', 'service/ombre/LICENSE': 'MIT',
    'service/ombre/SOURCE.json': '{}', 'vendor/ds-bot/UPSTREAM.json': '{}',
    'memory/复用与运行.md': '# User memory guide',
    'memory/实施与长程测试.md': 'INTERNAL EXPERIMENT', 'vendor/ds-bot/README.md': 'INTERNAL UPSTREAM SETUP',
    'vendor/ds-bot/src/office/skills/office/SKILL.md': '# Runtime skill',
    'dsh-plugin/.credentials.yaml': 'PRIVATE', 'src/personal-config.json': 'PRIVATE',
    'web/mention-tokens.js': 'export {};',
    'dist/web/index.html': '<!doctype html>', 'dist/web/sw.js': '// worker',
    'dist/web/client-config.json': '{}',
    'dist/admin/index.html': '<!doctype html>', 'dist/admin/theme.js': '// theme',
    'deploy/synapse/dscord_guard.py': '# Synapse admission module',
    'dist/web/licenses/lucide.txt': 'ISC and MIT notices',
    'dist/web/licenses/ui-foundation.txt': 'MIT and Apache-2.0 notices',
    'dist/admin/licenses/ui-foundation.txt': 'MIT and Apache-2.0 notices',
    'dist/web/licenses/bundled-dependencies.txt': 'Bundled licenses', 'dist/admin/licenses/bundled-dependencies.txt': 'Bundled licenses',
    'dist/web/.vite/manifest.json': '{}',
    'dsh-plugin/index.mjs': 'export {};', 'dsh-plugin/runtime-dependencies-lock.json': '{}',
    'dsh-plugin/runtime-dependencies.json': '{"dependencies":{}}',
    'dsh-plugin/runtime-dependencies-pnpm-lock.yaml': 'lockfileVersion: 9.0',
    'vendor/ds-bot/package.json': JSON.stringify({ dependencies: {} }),
    'dsh-connect/kernel-runtime.mjs': 'export {};', 'vendor/ds-bot/src/host/message-source.js': 'export {};',
    'memory/snapshot-context.mjs': 'export {};',
    'src/native-request.mjs': 'export {};',
    'vendor/ds-bot/LICENSE': 'Apache-2.0', 'vendor/ds-bot/NOTICE': 'DS-Bot notice',
    'vendor/ds-bot/client.js': 'window.__ModuleLoader__.load({\n  id: "ds-bot",\n  factory: (require) => {\n    return { apply() {} };\n  },\n});',
    'deploy/npm.md': '# DSCord\n[Package](../package.json)\n[Compose](README.md)\n[Models](../模型配置与迁移.md)',
    '模型配置与迁移.md': '# Model configuration',
    '.local/credentials.json': 'PRIVATE', '.npmrc': 'PRIVATE',
    'artifacts/chat.json': 'PRIVATE', 'deploy/.env': 'PRIVATE',
  };
  for (const name of ['service', 'matrix', 'runtime-config', 'runtime-dependencies', 'dsh-node', 'file-work', 'server-init', 'server-bootstrap', 'server-admin', 'central-init', 'admin', 'memory-setup']) {
    files[`scripts/${name}.mjs`] = 'export {};';
  }
  for (const [filename, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await writeFile(path.join(root, filename), content);
  }
  return root;
}

test('npm packs the exact source version, runtime and licenses without internal reports or local data', async t => {
  const root = await fixture(t);
  const result = await packNpm({ root });
  assert.equal(result.name, 'dscord');
  assert.equal(result.version, '0.2.0');
  assert.ok(result.size > 0);
  for (const name of ['package.json', 'README.md', 'bin/dscord.mjs', 'src/core.mjs', 'web/mention-tokens.js',
    'LICENSE', 'memory/复用与运行.md', 'vendor/ds-bot/src/office/skills/office/SKILL.md',
    'memory/native.mjs', 'service/ombre/service.py', 'service/ombre/LICENSE',
    'dist/web/index.html', 'dist/web/sw.js', 'dist/web/licenses/lucide.txt', 'dist/web/licenses/ui-foundation.txt', 'dist/admin/licenses/ui-foundation.txt', 'vendor/ds-bot/LICENSE',
    'dist/web/licenses/bundled-dependencies.txt', 'dist/admin/licenses/bundled-dependencies.txt',
    'vendor/ds-bot/NOTICE', 'dsh-plugin/runtime-dependencies-lock.json', 'dsh-connect/index.mjs',
    'dsh-connect/client.js', 'cordis.patch.yml', 'dist/admin/index.html', 'dist/admin/theme.js', 'deploy/synapse/dscord_guard.py', 'scripts/admin.mjs', 'scripts/central-init.mjs']) assert.ok(result.files.includes(name), name);
  assert.equal(result.files.some(name => /\.local|\.npmrc|artifacts|\.env|\.vite|credentials|personal-config|实施与长程测试|vendor\/ds-bot\/README/.test(name)), false);
  assert.equal(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).private, true);
  const { stdout } = await promisify(execFile)('tar', ['-xOf', result.archive, 'package/package.json']);
  const manifest = JSON.parse(stdout);
  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.publishConfig.tag, 'latest');
  const guide = (await promisify(execFile)('tar', ['-xOf', result.archive, 'package/README.md'])).stdout;
  assert.match(guide, /\[Package\]\(package\.json\)/);
  assert.match(guide, /blob\/ds-group-v0\.2\.0\/apps\/ds-group\/deploy\/README\.md/);
  assert.match(guide, /\[Models\]\(模型配置与迁移\.md\)/);
});

test('npm prereleases retain the source version and alpha channel; unlicensed packages cannot ship', async t => {
  const root = await fixture(t);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  pkg.version = '0.4.0-alpha.1';
  await writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
  await assert.rejects(packNpm({ root }), /versions must match/);
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version: pkg.version, packages: { '': { version: pkg.version } } }));
  const result = await packNpm({ root });
  const { stdout } = await promisify(execFile)('tar', ['-xOf', result.archive, 'package/package.json']);
  assert.equal(JSON.parse(stdout).publishConfig.tag, 'alpha');
  assert.equal(result.version, pkg.version);
  delete pkg.license;
  await writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
  await assert.rejects(packNpm({ root }), /Choose the project license/);
});

test('npm packaging refuses runtime symlinks and requires a built PWA', async t => {
  const root = await fixture(t);
  await symlink(path.join(root, '.local/credentials.json'), path.join(root, 'src/secret.mjs'));
  await assert.rejects(packNpm({ root }), /symlink/);
  await rm(path.join(root, 'src/secret.mjs'));
  await rm(path.join(root, 'dist/web/sw.js'));
  await assert.rejects(packNpm({ root }), { code: 'ENOENT' });
  await assert.rejects(packNpm({ root, version: '0.3.0' }), /versions must match/);
});
