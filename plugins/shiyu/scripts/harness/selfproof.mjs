#!/usr/bin/env node
/**
 * Launcher for the H0 self-proof runner.
 *
 * Runs every `tests/harness-*.test.ts` file with the Node test runner + TAP
 * reporter and freezes `artifacts/dsh/harness/tool-selfproof.json` and the raw
 * `tool-selfproof.tap`. See tests/harness/README.md for review steps.
 *
 *   node scripts/harness/selfproof.mjs [--plugin-root <dir>] [--out-dir <dir>]
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const entry = resolve(pluginRoot, 'tests/harness/selfproof.ts');
const result = spawnSync(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: process.env,
});
if (result.error !== undefined) {
  process.stderr.write(`self-proof launcher failed to start: ${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
