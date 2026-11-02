#!/usr/bin/env node
/**
 * Launcher for the H7-acceptance full acceptance tracking / gate runner.
 *
 *   node scripts/harness/acceptance.mjs [--plugin-root <dir>] [--workspace-root <dir>]
 *     [--out-dir <dir>] [--traceability <file>] [--selfproof <file>]
 *     [--manifest <file>] [--coverage <file>] [--generated-at <iso>] [--print]
 *
 * Reads the committed traceability matrix, tool self-proof, run manifest and
 * H0c coverage plus the 40-module registry, then writes
 * `acceptance-report.json` and `acceptance-report.md`. The gate is always
 * "incomplete": H7-prep has no product/host/model/business acceptance run.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const entry = resolve(pluginRoot, 'tests/harness/acceptance.ts');
const result = spawnSync(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: process.env,
});
if (result.error !== undefined) {
  process.stderr.write(`acceptance launcher failed to start: ${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
