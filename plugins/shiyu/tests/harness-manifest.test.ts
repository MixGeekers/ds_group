/**
 * Manifest / evidence-package tests (H0.MANIFEST).
 *
 * Verifies that the generated manifest is a real freeze (independent SHA256
 * recomputation, aggregate digest, oracle versions, environment facts), that
 * absolute paths/credentials are rejected, and that drift is detected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST_KIND,
  ManifestSanitizationError,
  assertSanitized,
  buildManifest,
  findForbiddenPatterns,
  verifyManifestFiles,
  writeManifest,
  type HarnessManifest,
} from './harness/manifest.js';
import { ALL_SELF_PROOFS } from './harness/index.js';
import { checkSchema, type Schema } from './harness/schema.js';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = join(pluginRoot, '..', '..');
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

async function withTempDirectory<T>(prefix: string, body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const manifestSchema: Schema = {
  type: 'object',
  required: ['schemaVersion', 'kind', 'generatedAt', 'harness', 'aggregates', 'environment', 'vcs', 'sanitization', 'oracleCatalog'],
  additionalProperties: true,
  properties: {
    schemaVersion: { type: 'number', const: 2 },
    kind: { type: 'string', const: MANIFEST_KIND },
    generatedAt: { type: 'string', format: 'iso8601' },
    harness: {
      type: 'object',
      required: ['version', 'oracleApiVersion', 'selfProofCorpus'],
      additionalProperties: true,
      properties: { version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' }, oracleApiVersion: { type: 'number', const: 1 }, selfProofCorpus: { type: 'string' } },
    },
    aggregates: {
      type: 'object',
      required: ['fileCount', 'totalBytes', 'digest'],
      additionalProperties: true,
      properties: { fileCount: { type: 'number', minimum: 1 }, totalBytes: { type: 'number', minimum: 1 }, digest: { type: 'string', format: 'sha256' } },
    },
    environment: {
      type: 'object',
      required: ['node', 'platform', 'arch', 'sqliteVersion', 'typescript'],
      additionalProperties: true,
      properties: { node: { type: 'string' }, platform: { type: 'string' }, arch: { type: 'string' }, sqliteVersion: { type: 'string' }, typescript: { type: 'string' } },
    },
    vcs: { type: 'object', required: ['available'], additionalProperties: true, properties: { available: { type: 'boolean' } } },
    sanitization: {
      type: 'object',
      required: ['checked', 'leaks'],
      additionalProperties: true,
      properties: { checked: { type: 'boolean', const: true }, leaks: { type: 'number', const: 0 } },
    },
    oracleCatalog: { type: 'array', minItems: 15, items: { type: 'object', required: ['name', 'version', 'module'], additionalProperties: true, properties: { name: { type: 'string' }, version: { type: 'string' } } } },
  },
};

test('manifest:builds-hashed-sanitized-evidence', async () => {
  await withTempDirectory('shiyu-harness-manifest-', async directory => {
    const outFile = join(directory, 'manifest.json');
    const manifest = await buildManifest({
      pluginRoot,
      workspaceRoot,
      includeBuild: false,
      roots: ['package.json', 'tests/harness/fixtures', 'tests/harness/manifest.ts'],
      generatedAt: new Date('2026-11-02T00:00:00.000Z'),
    });
    const shape = checkSchema(JSON.parse(JSON.stringify(manifest)) as unknown, manifestSchema);
    assert.equal(shape.ok, true, JSON.stringify(shape.violations));
    assert.equal(manifest.generatedAt, '2026-11-02T00:00:00.000Z');
    // Independent file hash recomputation.
    const fixture = manifest.fixtures.find(entry => entry.path === 'tests/harness/fixtures/crash-child.ts');
    assert.ok(fixture !== undefined, 'fixtures must be frozen in the manifest');
    assert.equal(fixture!.sha256, sha256(await readFile(join(pluginRoot, fixture!.path))));
    const manifestSource = manifest.groups.flatMap(group => group.files).find(entry => entry.path === 'tests/harness/manifest.ts');
    assert.ok(manifestSource !== undefined);
    assert.equal(manifestSource!.sha256, sha256(await readFile(join(pluginRoot, 'tests/harness/manifest.ts'))));
    // Independent aggregate digest recomputation.
    const entries = manifest.groups.flatMap(group => group.files);
    const aggregate = sha256(
      entries
        .map(entry => `${entry.sha256}  ${entry.path}\n`)
        .sort()
        .join(''),
    );
    assert.equal(manifest.aggregates.digest, aggregate);
    assert.equal(manifest.aggregates.fileCount, entries.length);
    // Oracle catalogue is frozen from code, not hand-written.
    assert.equal(manifest.oracleCatalog.length, ALL_SELF_PROOFS.length);
    for (const proof of ALL_SELF_PROOFS) {
      const entry = manifest.oracleCatalog.find(item => item.name === proof.name);
      assert.ok(entry !== undefined, `oracle ${proof.name} must be frozen`);
      assert.equal(entry!.version, proof.version);
      assert.equal(entry!.module, proof.module);
    }
    // Sanitisation: no absolute roots, home directory or credential shapes.
    const text = JSON.stringify(manifest);
    assert.deepEqual(findForbiddenPatterns(text, { pluginRoot, workspaceRoot }), []);
    assert.equal(text.includes(homedir()), false);
    assert.equal(text.includes(pluginRoot), false);
    // writeManifest writes atomically.
    const written = await writeManifest({ pluginRoot, workspaceRoot, outFile, includeBuild: false, roots: ['package.json'], generatedAt: new Date('2026-11-02T00:00:00.000Z') });
    assert.equal(written.sha256, sha256(await readFile(outFile)));
    assert.deepEqual((await readdir(directory)).filter(name => name.includes('.tmp')), []);
    const verify = verifyManifestFiles(written.manifest, { pluginRoot });
    assert.equal(verify.ok, true, JSON.stringify(verify.violations));
  });
});

test('manifest:sanitizer-rejects-leaks', () => {
  const context = { pluginRoot: '/private/plugin-root', workspaceRoot: '/private/workspace-root' };
  assert.ok(findForbiddenPatterns(`{"root":"${context.pluginRoot}"}`, context).length > 0);
  assert.ok(findForbiddenPatterns('{"home":"/Users/someone/secret"}', context).length > 0);
  assert.ok(findForbiddenPatterns('{"key":"sk-live-abcdefghijklmnop"}', context).length > 0);
  assert.ok(findForbiddenPatterns('{"key":"-----BEGIN RSA PRIVATE KEY-----"}', context).length > 0);
  assert.deepEqual(findForbiddenPatterns('{"path":"src/runtime.ts","sha256":"' + 'a'.repeat(64) + '"}', context), []);
  assert.throws(() => assertSanitized('/Users/someone/x', context), (error: unknown) => error instanceof ManifestSanitizationError && error.code === 'UNSANITIZED_MANIFEST');
  const clean = JSON.stringify({ files: [{ path: 'src/runtime.ts', sha256: 'a'.repeat(64) }] });
  assertSanitized(clean, context);
});

test('manifest:cli-temp-root-and-atomic-write', async () => {
  await withTempDirectory('shiyu-harness-manifest-cli-', async directory => {
    const fakePlugin = join(directory, 'plugin');
    const fakeWorkspace = join(directory, 'workspace');
    const outFile = join(directory, 'out', 'manifest.json');
    await mkdir(join(fakePlugin, 'src'), { recursive: true });
    await mkdir(join(fakePlugin, 'tests/harness/fixtures'), { recursive: true });
    await mkdir(fakeWorkspace, { recursive: true });
    await writeFile(join(fakePlugin, 'src/main.ts'), 'export const value = 1;\n');
    await writeFile(join(fakePlugin, 'tests/harness/fixtures/note.txt'), 'synthetic fixture\n');
    await writeFile(
      join(fakePlugin, 'package.json'),
      JSON.stringify({ name: '@shiyu/fake', version: '9.9.9', engines: { node: '>=24', dsh: '>=0.2.1' } }, null, 2),
    );
    const launcher = join(pluginRoot, 'scripts/harness/manifest.mjs');
    const result = spawnSync(process.execPath, [launcher, '--plugin-root', fakePlugin, '--workspace-root', fakeWorkspace, '--out', outFile, '--no-build'], {
      cwd: pluginRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `manifest CLI failed: ${result.stderr}`);
    const manifest = JSON.parse(await readFile(outFile, 'utf8')) as HarnessManifest;
    assert.equal(manifest.kind, MANIFEST_KIND);
    assert.equal(manifest.environment.dshPluginVersion, '9.9.9');
    const srcGroup = manifest.groups.find(group => group.name === 'src');
    assert.ok(srcGroup?.present);
    assert.equal(srcGroup!.files.length, 1);
    assert.equal(srcGroup!.files[0].path, 'src/main.ts');
    assert.equal(srcGroup!.files[0].sha256, sha256('export const value = 1;\n'));
    const fixture = manifest.fixtures.find(entry => entry.path.endsWith('note.txt'));
    assert.ok(fixture !== undefined);
    assert.equal(fixture!.sha256, sha256('synthetic fixture\n'));
    assert.deepEqual((await readdir(join(directory, 'out'))).filter(name => name.includes('.tmp')), []);
    // The CLI refuses to overwrite with an unsanitised payload only when a leak
    // is present; here paths are relative by construction, so no leaks exist.
    const verify = verifyManifestFiles(manifest, { pluginRoot: fakePlugin });
    assert.equal(verify.ok, true, JSON.stringify(verify.violations));
  });
});

test('manifest:verify-detects-drift', async () => {
  await withTempDirectory('shiyu-harness-manifest-drift-', async directory => {
    const fakePlugin = join(directory, 'plugin');
    await mkdir(join(fakePlugin, 'src'), { recursive: true });
    await writeFile(join(fakePlugin, 'src/a.txt'), 'alpha\n');
    const written = await writeManifest({
      pluginRoot: fakePlugin,
      workspaceRoot: directory,
      outFile: join(directory, 'manifest.json'),
      includeBuild: false,
      roots: ['src'],
      generatedAt: new Date('2026-11-02T00:00:00.000Z'),
    });
    const clean = verifyManifestFiles(written.manifest, { pluginRoot: fakePlugin });
    assert.equal(clean.ok, true, JSON.stringify(clean.violations));
    await writeFile(join(fakePlugin, 'src/a.txt'), 'alpha changed\n');
    const drifted = verifyManifestFiles(written.manifest, { pluginRoot: fakePlugin });
    assert.equal(drifted.ok, false);
    assert.ok(drifted.violations.some(item => item.code === 'file_hash_mismatch'));
    const tampered = JSON.parse(JSON.stringify(written.manifest)) as HarnessManifest;
    const versionTampered: HarnessManifest = { ...tampered, oracleCatalog: tampered.oracleCatalog.map(entry => ({ ...entry, version: '9.9.9' })) };
    const versionCheck = verifyManifestFiles(versionTampered, { pluginRoot: fakePlugin });
    assert.ok(versionCheck.violations.some(item => item.code === 'oracle_version_mismatch' || item.code === 'oracle_missing'));
  });
});
