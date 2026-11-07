import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const PUBLIC_SOURCE_POLICY = 'public-source-v1';
export const sourceRootFiles = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'cordis.patch.yml',
  'README.md', 'README.en.md', 'README.es.md', '模型配置与迁移.md',
  '.gitignore', '.gitattributes', '.dockerignore', 'Dockerfile',
  'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'LICENCE.txt', 'NOTICE', 'NOTICE.md',
];
export const sourceDirectories = ['bin', 'src', 'memory', 'service', 'scripts', 'tests', 'web', 'admin', 'ui', 'deploy', 'dsh-plugin', 'dsh-connect', 'vendor'];
const publicDocuments = new Set([
  ...sourceRootFiles.filter(name => name.endsWith('.md')),
  'admin/README.md', 'dsh-plugin/README.md', 'dsh-connect/KERNEL.md',
  'memory/复用与运行.md', 'memory/当前上下文与回顾.md',
  'deploy/README.md', 'deploy/npm.md', 'deploy/api-only.md', 'deploy/kernel-runtime.md', 'deploy/releasing.md',
  'deploy/client/README.md', 'deploy/storage/README.md', 'deploy/systemd/README.md',
]);
const deployFiles = new Set([
  'deploy/.env.example', 'deploy/Caddyfile', 'deploy/compose.yaml', 'deploy/compose.https.yaml',
  'deploy/synapse/dscord_guard.py', 'deploy/client/nginx.conf', 'deploy/client/client-config.example.json',
  'deploy/storage/Dockerfile.synapse-s3', 'deploy/storage/compose.s3.yaml', 'deploy/storage/compose.rclone.yaml',
  'deploy/systemd/ds-group-bot@.service', 'deploy/systemd/ds-group-dsh@.service',
]);
const pluginManifests = new Set([
  'dsh-plugin/package.json', 'dsh-plugin/runtime-dependencies.json',
  'dsh-plugin/runtime-dependencies-lock.json', 'dsh-plugin/runtime-dependencies-pnpm-lock.yaml',
]);
const excludedDirectories = new Set(['node_modules', '.local', '.git', '.cache', '.venv', '__pycache__',
  'artifacts', 'evidence', 'reports', 'test-results', 'playwright-report', '.DS_Store']);
const code = /\.(?:mjs|cjs|js|ts|tsx|py|sh)$/;
const asset = /\.(?:css|html|json|webmanifest|png|ico|svg|jpg|jpeg|webp|woff|woff2|ttf)$/;
const licenseFile = /^(?:LICENSE|LICENCE|NOTICE)(?:\.(?:md|txt))?$/i;

export function excludedReleasePath(relative) {
  const parts = relative.split('/');
  return parts.some(part => excludedDirectories.has(part))
    || parts.some(part => part.startsWith('.') && !sourceRootFiles.includes(relative) && relative !== 'deploy/.env.example')
    || /\.(?:sqlite(?:-shm|-wal)?|db|log|pem|key|p12|pfx|map)$/.test(relative);
}

export function includedSourceFile(relative) {
  if (excludedReleasePath(relative) || relative.split('/').includes('dist')) return false;
  if (!relative.includes('/') && licenseFile.test(relative)) return true;
  if (sourceRootFiles.includes(relative) || publicDocuments.has(relative) || deployFiles.has(relative)) return true;
  const [directory] = relative.split('/');
  if (!sourceDirectories.includes(directory)) return false;
  if (directory === 'deploy') return false;
  if (code.test(relative)) return true;
  if (relative.startsWith('tests/fixtures/')) return true;
  if (relative.startsWith('vendor/')) return licenseFile.test(path.basename(relative))
    || /\/(?:package\.json|UPSTREAM\.json|cordis\.patch\.yml|SKILL\.md)$/.test(relative);
  if (relative.startsWith('service/')) return licenseFile.test(path.basename(relative))
    || /\/(?:SOURCE\.json|requirements(?:\.lock)?\.txt)$/.test(relative);
  if (pluginManifests.has(relative)) return true;
  if (['web', 'admin', 'ui'].includes(directory)) return asset.test(relative) && !relative.endsWith('.json')
    || ['web/client-config.json', 'admin/tsconfig.json'].includes(relative)
    || /\/licenses\/[^/]+\.txt$/.test(relative);
  return false;
}

export function includedNpmFile(relative) {
  if (excludedReleasePath(relative)) return false;
  if (relative.startsWith('dist/web/') || relative.startsWith('dist/admin/')) return asset.test(relative)
    || code.test(relative) || /\/licenses\/[^/]+\.txt$/.test(relative);
  return includedSourceFile(relative);
}

export async function projectLicense(root, pkg) {
  if (typeof pkg.license !== 'string' || !pkg.license.trim() || pkg.license === 'UNLICENSED') {
    throw new Error('Choose the project license in package.json before building a public release');
  }
  const files = (await readdir(root)).filter(name => /^(?:LICENSE|LICENCE)(?:\.(?:md|txt))?$/i.test(name));
  if (!files.includes('LICENSE')) throw new Error('Public releases require the project LICENSE file at the package root');
  for (const filename of files) if (!(await readFile(path.join(root, filename), 'utf8')).trim()) {
    throw new Error('Project license text must not be empty');
  }
  return (await readdir(root)).filter(name => licenseFile.test(name));
}
