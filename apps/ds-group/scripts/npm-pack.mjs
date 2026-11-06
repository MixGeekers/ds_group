import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { packageRoot } from '../src/paths.mjs';

const execute = promisify(execFile);
const runtimeFiles = [
  'bin/dscord.mjs', 'src', 'memory', 'service/ombre', 'web/mention-tokens.js', 'dist/web', 'dist/admin', 'deploy/synapse', 'dsh-plugin', 'dsh-connect', 'cordis.patch.yml', 'vendor/ds-bot',
  ...['service', 'matrix', 'runtime-config', 'runtime-dependencies', 'dsh-node', 'file-work', 'server-init', 'server-bootstrap', 'server-admin', 'central-init', 'admin', 'memory-setup']
    .map(name => `scripts/${name}.mjs`),
];

async function copyRuntime(source, destination) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to package a symlink: ${source}`);
  if (stat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of (await readdir(source)).sort()) {
      if (name === '.vite') continue;
      if (name.startsWith('.') || ['node_modules', 'artifacts', 'test-results'].includes(name)
        || /\.(?:log|sqlite(?:-shm|-wal)?|db|pem|key)$/.test(name)) {
        throw new Error(`Unexpected runtime package entry: ${path.join(source, name)}`);
      }
      await copyRuntime(path.join(source, name), path.join(destination, name));
    }
  } else if (stat.isFile()) {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  } else {
    throw new Error(`Unsupported runtime package entry: ${source}`);
  }
}

export async function packNpm({ root = packageRoot, output = path.join(root, '.local', 'npm-release'), version } = {}) {
  const source = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  version ||= `${source.version}-alpha.1`;
  if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(version)) throw new Error('Use an explicit alpha version such as 0.2.0-alpha.1');
  for (const filename of ['dist/web/index.html', 'dist/web/sw.js', 'dist/web/client-config.json', 'dist/web/licenses/lucide.txt', 'dist/web/licenses/ui-foundation.txt', 'dist/admin/index.html', 'dist/admin/licenses/ui-foundation.txt', 'deploy/synapse/dscord_guard.py', 'vendor/ds-bot/LICENSE', 'vendor/ds-bot/NOTICE']) {
    await readFile(path.join(root, filename));
  }
  const manifest = {
    name: 'dscord', version, type: 'module',
    description: 'DSCord collaboration server and independent Bot nodes, with a prebuilt chat PWA',
    engines: source.engines,
    main: './dsh-connect/index.mjs',
    exports: { '.': './dsh-connect/index.mjs', './client': './dsh-connect/client.js', './package.json': './package.json' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', immediately: true } },
    bin: { dscord: 'bin/dscord.mjs' },
    files: ['bin', 'src', 'memory', 'service/ombre', 'scripts', 'web/mention-tokens.js', 'dist/web', 'dist/admin', 'deploy/synapse', 'dsh-plugin', 'dsh-connect', 'cordis.patch.yml', 'vendor/ds-bot'],
    dependencies: source.dependencies,
    repository: { type: 'git', url: 'git+https://github.com/MixGeekers/ds_group.git', directory: 'apps/ds-group' },
    homepage: 'https://github.com/MixGeekers/ds_group',
    bugs: { url: 'https://github.com/MixGeekers/ds_group/issues' },
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/', tag: 'alpha' },
  };
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(path.join(output, 'staging-'));
  try {
    for (const filename of runtimeFiles) await copyRuntime(path.join(root, filename), path.join(staging, filename));
    const nativeClient = await readFile(path.join(root, 'vendor/ds-bot/client.js'), 'utf8');
    const start = nativeClient.indexOf('  factory: (require) => {') + '  factory: '.length;
    const end = nativeClient.lastIndexOf('\n  },');
    if (start < '  factory: '.length || end < start) throw new Error('Unexpected native DS-Bot client bundle format');
    const factory = nativeClient.slice(start, end) + '\n  }';
    const connectorClient = await readFile(path.join(root, 'dsh-connect/client.js'), 'utf8');
    // One module registration, retaining the original native UI factory verbatim.
    await writeFile(path.join(staging, 'dsh-connect/client.js'), `const dscordNativeFactory = ${factory};\n${connectorClient}`);
    await chmod(path.join(staging, 'bin/dscord.mjs'), 0o755);
    await writeFile(path.join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    await copyFile(path.join(root, 'deploy/npm.md'), path.join(staging, 'README.md'));
    const { stdout } = await execute('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', path.resolve(output)], {
      cwd: staging, maxBuffer: 4 * 1024 * 1024,
    });
    const [packed] = JSON.parse(stdout);
    const result = { name: manifest.name, version, archive: path.resolve(output, packed.filename),
      integrity: packed.integrity, shasum: packed.shasum, size: packed.size, files: packed.files.map(file => file.path) };
    await writeFile(path.join(output, `${manifest.name}-${version}.json`), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [version, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Use npm-pack.mjs [VERSION]');
  const result = await packNpm({ version });
  console.log(JSON.stringify({ ...result, files: result.files.length }, null, 2));
}
