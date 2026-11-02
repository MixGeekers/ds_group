#!/usr/bin/env node
/**
 * Launcher for the H0c S/FL business-skeleton generator.
 *
 *   node scripts/harness/fl-scenarios.mjs [--out-dir <dir>] [--seed <int>]
 *     [--plugin-root <dir>] [--workspace-root <dir>] [--selfproof <file>]
 *     [--require-selfproof] [--print]
 *
 * Generates synthetic fixtures (public inputs), independent answer sets
 * (evaluation side), coverage index and scoring skeleton. It never calls a
 * model, embedding backend, Lab room, channel or DSH host.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const entry = resolve(pluginRoot, 'tests/harness/fl-scenarios.ts');
const result = spawnSync(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: process.env,
});
if (result.error !== undefined) {
  process.stderr.write(`fl-scenarios launcher failed to start: ${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
