import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { packageRoot } from '../src/paths.mjs';
import { verifyRuntimeDependencyManifests } from './runtime-dependencies.mjs';
import { sourceRootFiles, sourceDirectories, excludedReleasePath, includedSourceFile, projectLicense, PUBLIC_SOURCE_POLICY } from './release-content.mjs';
import { assertReleaseVersions } from './release-version.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function collectReleaseFiles(root) {
  const files = [];
  async function visit(relative) {
    if (excludedReleasePath(relative) || relative.split('/').includes('dist')) return;
    const filename = path.join(root, ...relative.split('/'));
    let stat;
    try { stat = await lstat(filename); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Release source contains a symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const child of (await readdir(filename)).sort()) await visit(`${relative}/${child}`);
    } else if (stat.isFile() && includedSourceFile(relative)) {
      files.push({ path: relative, bytes: await readFile(filename) });
    } else if (!stat.isFile()) {
      throw new Error(`Release source contains a special file: ${relative}`);
    }
  }
  const legalFiles = (await readdir(root)).filter(name => /^(?:LICENSE|LICENCE|NOTICE)(?:\.(?:md|txt))?$/i.test(name));
  for (const entry of new Set([...sourceRootFiles, ...legalFiles, ...sourceDirectories])) await visit(entry);
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function putString(header, value, offset, size) {
  if (Buffer.byteLength(value) > size) throw new Error(`Value exceeds tar field: ${value}`);
  header.write(value, offset, size, 'utf8');
}

function putOctal(header, value, offset, size) {
  putString(header, value.toString(8).padStart(size - 1, '0') + '\0', offset, size);
}

// USTAR regular files with fixed metadata keep archives reproducible on every OS.
export function createTar(files) {
  const blocks = [];
  for (const file of files) {
    let name = file.path;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const slash = name.lastIndexOf('/', name.length - 2);
      prefix = name.slice(0, slash);
      name = name.slice(slash + 1);
    }
    const header = Buffer.alloc(512);
    putString(header, name, 0, 100);
    putOctal(header, 0o644, 100, 8);
    putOctal(header, 0, 108, 8);
    putOctal(header, 0, 116, 8);
    putOctal(header, file.bytes.length, 124, 12);
    putOctal(header, 0, 136, 12);
    header.fill(32, 148, 156);
    putString(header, '0', 156, 1);
    putString(header, 'ustar\0', 257, 6);
    putString(header, '00', 263, 2);
    putString(header, prefix, 345, 155);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    putString(header, checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, file.bytes, Buffer.alloc((512 - file.bytes.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

export async function buildRelease({ root = packageRoot, output = path.join(root, '.local', 'release') } = {}) {
  await verifyRuntimeDependencyManifests(root);
  const source = await collectReleaseFiles(root);
  const packageFile = source.find(file => file.path === 'package.json');
  if (!packageFile) throw new Error('Release source needs package.json');
  const pkg = JSON.parse(packageFile.bytes.toString('utf8'));
  const lock = source.find(file => file.path === 'package-lock.json');
  assertReleaseVersions(pkg, JSON.parse(lock?.bytes.toString('utf8') || '{}'));
  await projectLicense(root, pkg);
  const required = ['package-lock.json', 'src/core.mjs', 'src/identity.mjs', 'src/web-mode.mjs', 'src/admin.mjs',
    'scripts/central-init.mjs', 'scripts/admin.mjs', 'bin/dscord.mjs', 'web/index.html', 'web/src/client-config.ts', 'web/client-config.json', 'admin/index.html', 'admin/vite.config.ts',
    'Dockerfile', 'deploy/compose.yaml', 'deploy/synapse/dscord_guard.py', 'ui/controls.tsx', 'ui/overlays.tsx', 'ui/tailwind.css', 'web/licenses/ui-foundation.txt',
    'dsh-plugin/index.mjs', 'dsh-plugin/runtime-dependencies.json', 'dsh-plugin/runtime-dependencies-lock.json', 'dsh-plugin/runtime-dependencies-pnpm-lock.yaml',
    'dsh-connect/kernel-runtime.mjs', 'memory/snapshot-context.mjs', 'src/native-request.mjs', 'vendor/ds-bot/src/host/message-source.js',
    'vendor/ds-bot/LICENSE', 'vendor/ds-bot/NOTICE', 'vendor/ds-bot/UPSTREAM.json', 'service/ombre/LICENSE', 'service/ombre/SOURCE.json'];
  for (const filename of required) {
    if (!source.some(file => file.path === filename)) throw new Error(`Release is missing ${filename}`);
  }
  const manifest = {
    schemaVersion: 1,
    contentPolicy: PUBLIC_SOURCE_POLICY,
    name: 'ds-group',
    version: pkg.version,
    node: pkg.engines.node,
    files: source.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: sha256(file.bytes) })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const prefix = `ds-group-${pkg.version}`;
  const archive = gzipSync(createTar([...source, { path: 'release-manifest.json', bytes: manifestBytes }]
    .map(file => ({ ...file, path: `${prefix}/${file.path}` }))), { level: 9 });
  archive[9] = 255; // gzip OS byte is normalized so Windows and Unix produce identical bytes.
  const archiveName = `${prefix}-source.tar.gz`;
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, archiveName), archive);
  await writeFile(path.join(output, 'release-manifest.json'), manifestBytes);
  await writeFile(path.join(output, 'SHA256SUMS'), `${sha256(archive)}  ${archiveName}\n${sha256(manifestBytes)}  release-manifest.json\n`);
  return { version: pkg.version, archive: path.join(output, archiveName), sha256: sha256(archive), files: source.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Use release-pack.mjs [--output DIRECTORY]');
  console.log(JSON.stringify(await buildRelease({ output: args[1] ? path.resolve(args[1]) : undefined }), null, 2));
}
