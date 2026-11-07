import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { packageRoot } from '../src/paths.mjs';
import { verifyRuntimeDependencyManifests } from './runtime-dependencies.mjs';
import { excludedReleasePath, includedNpmFile, projectLicense } from './release-content.mjs';
import { assertReleaseVersions, releaseVersion } from './release-version.mjs';

const execute = promisify(execFile);
const runtimeFiles = [
  'bin/dscord.mjs', 'src', 'memory', 'service/ombre', 'web/mention-tokens.js', 'dist/web', 'dist/admin', 'deploy/synapse', 'dsh-plugin', 'dsh-connect', 'cordis.patch.yml', 'vendor/ds-bot',
  ...['service', 'matrix', 'runtime-config', 'runtime-dependencies', 'dsh-node', 'file-work', 'server-init', 'server-bootstrap', 'server-admin', 'central-init', 'admin', 'memory-setup']
    .map(name => `scripts/${name}.mjs`),
  '模型配置与迁移.md',
];

async function rewriteGuideLinks(staging, version) {
  async function visit(relative) {
    const filename = path.join(staging, relative), stat = await lstat(filename);
    if (stat.isDirectory()) {
      for (const child of await readdir(filename)) await visit(relative ? `${relative}/${child}` : child);
      return;
    }
    if (!relative.endsWith('.md') || relative.startsWith('vendor/') || /^(?:LICENSE|LICENCE|NOTICE)(?:\.|$)/i.test(path.basename(relative))) return;
    const sourcePath = relative === 'README.md' ? 'deploy/npm.md' : relative;
    const text = await readFile(filename, 'utf8');
    let result = '', cursor = 0;
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const href = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) continue;
      const pathname = href.split(/[?#]/)[0], suffix = href.slice(pathname.length);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), decodeURIComponent(pathname)));
      let exists = false;
      if (!target.startsWith('../')) {
        try { exists = (await lstat(path.join(staging, target))).isFile(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const url = exists ? `${path.posix.relative(path.posix.dirname(relative), target)}${suffix}`
        : `https://github.com/MixGeekers/dscord/blob/ds-group-v${version}/${path.posix.normalize(`apps/ds-group/${target}`)}${suffix}`;
      result += text.slice(cursor, match.index) + `](${url})`;
      cursor = match.index + match[0].length;
    }
    if (cursor) await writeFile(filename, result + text.slice(cursor));
  }
  await visit('');
}

async function copyRuntime(root, staging, relative) {
  if (excludedReleasePath(relative)) return;
  const source = path.join(root, relative), destination = path.join(staging, relative);
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to package a symlink: ${source}`);
  if (stat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of (await readdir(source)).sort()) {
      await copyRuntime(root, staging, `${relative}/${name}`);
    }
  } else if (stat.isFile() && includedNpmFile(relative)) {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  } else if (!stat.isFile()) {
    throw new Error(`Unsupported runtime package entry: ${source}`);
  }
}

export async function packNpm({ root = packageRoot, output = path.join(root, '.local', 'npm-release'), version } = {}) {
  const source = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  version ||= source.version;
  const { npmTag } = releaseVersion(version);
  assertReleaseVersions(source, JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8')), version);
  const legalFiles = await projectLicense(root, source);
  await verifyRuntimeDependencyManifests(root);
  for (const filename of ['dist/web/index.html', 'dist/web/sw.js', 'dist/web/client-config.json', 'dist/web/licenses/lucide.txt', 'dist/web/licenses/ui-foundation.txt', 'dist/admin/index.html', 'dist/admin/licenses/ui-foundation.txt', 'deploy/synapse/dscord_guard.py',
    'dsh-connect/kernel-runtime.mjs', 'memory/snapshot-context.mjs', 'src/native-request.mjs', 'vendor/ds-bot/src/host/message-source.js', 'vendor/ds-bot/LICENSE', 'vendor/ds-bot/NOTICE',
    'vendor/ds-bot/UPSTREAM.json', 'service/ombre/LICENSE', 'service/ombre/SOURCE.json']) {
    await readFile(path.join(root, filename));
  }
  const manifest = {
    name: 'dscord', version, type: 'module',
    license: source.license,
    description: 'DSCord collaboration server and independent Bot nodes, with a prebuilt chat PWA',
    engines: source.engines,
    main: './dsh-connect/index.mjs',
    exports: { '.': './dsh-connect/index.mjs', './client': './dsh-connect/client.js', './package.json': './package.json' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', immediately: true } },
    bin: { dscord: 'bin/dscord.mjs' },
    files: ['bin', 'src', 'memory', 'service/ombre', 'scripts', 'web/mention-tokens.js', 'dist/web', 'dist/admin', 'deploy/synapse', 'dsh-plugin', 'dsh-connect', 'cordis.patch.yml', 'vendor/ds-bot', '模型配置与迁移.md', ...legalFiles],
    dependencies: source.dependencies,
    repository: { type: 'git', url: 'git+https://github.com/MixGeekers/dscord.git', directory: 'apps/ds-group' },
    homepage: 'https://github.com/MixGeekers/dscord',
    bugs: { url: 'https://github.com/MixGeekers/dscord/issues' },
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/', tag: npmTag },
  };
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(path.join(output, 'staging-'));
  try {
    for (const filename of [...runtimeFiles, ...legalFiles]) await copyRuntime(root, staging, filename);
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
    await rewriteGuideLinks(staging, version);
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
