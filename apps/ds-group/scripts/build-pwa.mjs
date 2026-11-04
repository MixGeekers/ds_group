import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { packageRoot } from '../src/paths.mjs';

const source = path.join(packageRoot, 'web');
const output = path.join(packageRoot, 'dist', 'web');
await readFile(path.join(output, 'index.html'));
await mkdir(output, { recursive: true });
for (const filename of ['theme.js', 'manifest.webmanifest', 'icons', 'licenses']) {
  await cp(path.join(source, filename), path.join(output, filename), { recursive: true });
}

async function publicFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.endsWith('.map') || entry.name === 'sw.js') continue;
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await publicFiles(path.join(directory, entry.name), name));
    else files.push(name);
  }
  return files.sort();
}

const assets = await publicFiles(output);
const hash = createHash('sha256');
for (const filename of assets) {
  hash.update(filename);
  hash.update(await readFile(path.join(output, filename)));
}
const buildId = hash.digest('hex').slice(0, 16);
const shellPaths = ['/', ...assets];
const worker = (await readFile(path.join(source, 'sw.js'), 'utf8'))
  .replace(/const CACHE_NAME = [^;]+;/, `const CACHE_NAME = 'ds-group-shell-${buildId}';`)
  .replace(/const SHELL_PATHS = \[[\s\S]*?\];/, `const SHELL_PATHS = ${JSON.stringify(shellPaths, null, 2)};`);
await writeFile(path.join(output, 'sw.js'), worker);
console.log(JSON.stringify({ buildId, precachedFiles: shellPaths.length, output: 'dist/web' }));
