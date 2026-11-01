import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist', 'gym', 'fixtures');
await mkdir(output, { recursive: true });
for (const name of await readdir(path.join(root, 'fixtures'))) {
  if (name.endsWith('.json')) await copyFile(path.join(root, 'fixtures', name), path.join(output, name));
}
console.log('Built DSH gym JavaScript and synthetic fixtures in lab/dist/gym.');
