import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { packageRoot } from '../src/paths.mjs';

async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') await checkDirectory(filename);
    else if (/\.(mjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
for (const folder of ['src', 'scripts', 'web', 'tests', 'dsh-plugin']) await checkDirectory(path.join(packageRoot, folder));
const tests = spawnSync(process.execPath, ['--test', 'tests/*.test.mjs'], { cwd: packageRoot, stdio: 'inherit' });
if (tests.error) console.error(tests.error.message);
process.exit(tests.status ?? 1);
