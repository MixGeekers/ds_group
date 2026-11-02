#!/usr/bin/env node
/**
 * Launcher for the H0 requirement-traceability generator.
 *
 *   node scripts/harness/traceability.mjs [--plugin-root <dir>] [--workspace-root <dir>] \
 *     [--out-dir <dir>] [--selfproof <file>] [--manifest <file>] [--strict]
 *
 * `--strict` exits 3 when any H0 capability is not `self_proven`.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const entry = resolve(pluginRoot, 'tests/harness/traceability.ts');
const result = spawnSync(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: process.env,
});
if (result.error !== undefined) {
  process.stderr.write(`traceability launcher failed to start: ${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
