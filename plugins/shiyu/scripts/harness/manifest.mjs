#!/usr/bin/env node
/**
 * Launcher for the H0 run-manifest freezer.
 *
 * The implementation lives in `tests/harness/manifest.ts` so it is
 * type-checked together with the test suite; this wrapper only makes the
 * documented command runnable from the plugin root without requiring callers
 * to remember the tsx loader invocation.
 *
 *   node scripts/harness/manifest.mjs [--plugin-root <dir>] [--workspace-root <dir>] [--out <file>] [--no-build] [--groups a,b,c]
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const entry = resolve(pluginRoot, 'tests/harness/manifest.ts');
const result = spawnSync(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: process.env,
});
if (result.error !== undefined) {
  process.stderr.write(`manifest launcher failed to start: ${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
