#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const [command = 'help', ...args] = process.argv.slice(2);
const entries = new Map([
  ['server', 'src/core.mjs'],
  ['init', 'scripts/server-init.mjs'],
  ['bootstrap', 'scripts/server-bootstrap.mjs'],
  ['admin', 'scripts/server-admin.mjs'],
  ['node', 'src/bot-node.mjs'],
  ['dsh', 'scripts/dsh-node.mjs'],
  ['service', 'scripts/service.mjs'],
]);
const help = `Usage: dscord <command> [arguments]

  server                 Run the core server in its configured web mode
  init [--web-mode MODE]  Prepare configuration (MODE: bundled or api-only)
  bootstrap              Register initial members on the configured Synapse
  admin <arguments>      Manage server credentials and node exports
  node <arguments>       Run a Matrix Bot adapter
  dsh <arguments>        Manage a Bot's DSH host
  service <arguments>    Manage explicitly selected local services
  path                   Print the installed package directory
  version                Print the installed version
  help                   Show this help

DS_GROUP_DATA_DIR defaults to .dscord in the current directory.
DS_GROUP_WEB_MODE overrides web hosting; init persists it in core-config.json.
`;

async function run() {
  if (['help', '--help', '-h'].includes(command)) {
    process.stdout.write(help);
    return;
  }
  if (['version', '--version', '-v'].includes(command)) {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    console.log(manifest.version);
    return;
  }
  if (command === 'path') {
    console.log(path.resolve(packageRoot));
    return;
  }
  const entry = entries.get(command);
  if (!entry) throw new Error(`Unknown command "${command}". Run dscord help.`);
  if (command === 'service' && ['up', 'down', 'restart'].includes(args[0]) && !args[1]) {
    throw new Error('Choose a service component explicitly: all, core, or a local Bot account name.');
  }
  if (command === 'dsh' && args.length < 2) {
    throw new Error('Use dscord dsh <start|run|stop|status|prepare> <bot-account>.');
  }

  const env = { ...process.env };
  env.DS_GROUP_DATA_DIR = path.resolve(env.DS_GROUP_DATA_DIR || '.dscord');
  env.DS_GROUP_SYNAPSE_DIR = path.resolve(env.DS_GROUP_SYNAPSE_DIR || path.join(env.DS_GROUP_DATA_DIR, 'synapse'));
  env.DS_GROUP_MATRIX_REPORT = path.resolve(env.DS_GROUP_MATRIX_REPORT || path.join(env.DS_GROUP_DATA_DIR, 'matrix-smoke.json'));
  for (const name of ['DS_GROUP_CORE_CONFIG_PATH', 'DS_GROUP_MATRIX_SETUP_PATH', 'DS_GROUP_WEB_DIR',
    'DS_GROUP_DSH_SOURCE_HOME', 'DS_GROUP_DSH_RUNTIME', 'DS_GROUP_RUNTIME_DEPS_DIR']) {
    if (env[name]) env[name] = path.resolve(env[name]);
  }
  if (env.DS_GROUP_DSH_CLI && /[\\/]/.test(env.DS_GROUP_DSH_CLI)) env.DS_GROUP_DSH_CLI = path.resolve(env.DS_GROUP_DSH_CLI);
  if (command === 'init' || command === 'bootstrap') env.DS_GROUP_MATRIX_URL ||= 'http://127.0.0.1:18008';

  const child = spawn(process.execPath, [path.join(packageRoot, entry), ...args], { stdio: 'inherit', env });
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 1;
}

run().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
