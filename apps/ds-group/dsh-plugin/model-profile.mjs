// Boot-free, read-only composition using the installed DSH patch implementation.
// The launcher captures stdout privately. Never print the returned configuration in a UI or log.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { providerConfiguration } from '../scripts/runtime-config.mjs';

export async function readModelProfile({ runtime, sourceHome, sourceProfile, env = process.env, previousSelection }) {
  const require = createRequire(path.join(runtime, 'package.json'));
  const sdk = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
  const yaml = require('yaml');
  // DSH's own environment loader resolves profile credential references with its native precedence.
  if (env === process.env) {
    process.env.DSH_HOME = sourceHome;
    sdk.loadLayeredEnv('DSCord', process.cwd(), () => {});
  }
  const directory = path.join(sourceHome, 'profiles', sourceProfile);
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const layers = [];
  for (const name of manifest.dsh?.profile?.bundles ?? []) {
    const bundleDir = sdk.resolveBundleDir('DSCord', name, path.join(runtime, 'package.json'), directory);
    const bundle = JSON.parse(await readFile(path.join(bundleDir, 'package.json'), 'utf8')).dsh?.bundle;
    for (const filename of sdk.bundlePatchPaths(bundleDir, bundle)) layers.push(sdk.loadOverlayPatches('DSCord', filename));
  }
  for (const filename of [path.join(directory, 'cordis.patch.yml'), path.join(sourceHome, 'cordis.patch.yml')]) {
    layers.push(sdk.loadOptionalPatches('DSCord', filename) ?? []);
  }
  const rows = sdk.composeEntries(layers);
  const entries = rows.flatMap(function flatten(row) {
    if (row.disabled) return [];
    return [row, ...(Array.isArray(row.config) ? row.config.flatMap(flatten) : [])];
  });
  const sourceProviders = entries.find(row => row.id === 'llm-pi-ai')?.config?.providers || {};
  const defaults = entries.find(row => row.id === 'agent-default-model')?.config;
  const sourceSelection = defaults?.provider && defaults?.model ? {
    model: `${defaults.provider}/${defaults.model}`, reasoningEffort: defaults.reasoningEffort,
  } : undefined;
  let sourceCredentials;
  try { sourceCredentials = yaml.parse(await readFile(path.join(sourceHome, '.credentials.yaml'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return providerConfiguration({ env, sourceProviders, sourceCredentials, sourceSelection, previousSelection });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const [runtime, sourceHome, sourceProfile] = process.argv.slice(2);
    process.stdout.write(JSON.stringify(await readModelProfile({ runtime, sourceHome, sourceProfile })));
  } catch (error) {
    // Native config parser errors can contain a secret-bearing YAML line.
    process.stderr.write(`${error.code === 'MISSING_CREDENTIAL' ? 'MISSING_CREDENTIAL' : 'MODEL_PROFILE_INVALID'}\n`);
    process.exitCode = 1;
  }
}
