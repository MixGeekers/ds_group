import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { packageRoot } from '../src/paths.mjs';

const rootFiles = ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'README.md', '发行验证.md', '前端架构与设计规范.md', '.gitignore', '.gitattributes', '.dockerignore', 'Dockerfile'];
const sourceDirectories = ['src', 'scripts', 'tests', 'web', 'deploy', 'dsh-plugin', 'vendor'];
const excludedNames = new Set(['node_modules', '.local', '.git', 'artifacts', 'dist', 'test-results', 'playwright-report', '.DS_Store']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function excluded(name) {
  return excludedNames.has(name) || (name.startsWith('.env') && name !== '.env.example')
    || /\.(?:sqlite(?:-shm|-wal)?|db|log|pem|key)$/.test(name);
}

export async function collectReleaseFiles(root) {
  const files = [];
  async function visit(relative) {
    if (relative.split('/').some(excluded)) return;
    const filename = path.join(root, ...relative.split('/'));
    let stat;
    try { stat = await lstat(filename); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Release source contains a symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const child of (await readdir(filename)).sort()) await visit(`${relative}/${child}`);
    } else if (stat.isFile()) {
      files.push({ path: relative, bytes: await readFile(filename) });
    } else {
      throw new Error(`Release source contains a special file: ${relative}`);
    }
  }
  for (const entry of [...rootFiles, ...sourceDirectories]) await visit(entry);
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
  const source = await collectReleaseFiles(root);
  const packageFile = source.find(file => file.path === 'package.json');
  if (!packageFile) throw new Error('Release source needs package.json');
  const pkg = JSON.parse(packageFile.bytes.toString('utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('Invalid release version');
  const required = ['package-lock.json', 'src/core.mjs', 'web/index.html', 'Dockerfile', 'deploy/compose.yaml', 'vendor/ds-bot/LICENSE', 'vendor/ds-bot/NOTICE'];
  for (const filename of required) {
    if (!source.some(file => file.path === filename)) throw new Error(`Release is missing ${filename}`);
  }
  const manifest = {
    schemaVersion: 1,
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
