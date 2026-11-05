import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function runtimeDependencyInstaller(runtime) {
  const dependencies = path.resolve(runtime, '..', '..', 'runtime', 'primary-runtime', 'dependencies');
  const node = path.join(dependencies, 'node', 'bin', 'node');
  const pnpm = path.join(dependencies, 'pnpm', 'bin', 'pnpm.cjs');
  try {
    await access(node, constants.X_OK);
    await access(pnpm, constants.R_OK);
    return { command: node, args: [pnpm, 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-workspace',
      '--config.auto-install-peers=false', '--config.strict-peer-dependencies=false', '--config.confirm-modules-purge=false'] };
  } catch (error) {
    if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
    return { command: 'npm', args: ['ci', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'] };
  }
}

export async function prepareRuntimeDependencies({ directory, plugin, runtime, run = execute }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = await readFile(path.join(plugin, 'runtime-dependencies.json'), 'utf8');
  const lock = await readFile(path.join(plugin, 'runtime-dependencies-lock.json'), 'utf8');
  const pnpmLock = await readFile(path.join(plugin, 'runtime-dependencies-pnpm-lock.yaml'), 'utf8');
  const fingerprint = createHash('sha256').update(manifest).update(lock).update(pnpmLock).digest('hex');
  const marker = path.join(directory, '.runtime-lock.sha256');
  const required = createRequire(path.join(directory, 'package.json'));
  const expected = JSON.parse(manifest).dependencies;
  async function verify() {
    required.resolve('deep-view/core');
    required.resolve('yaml');
    for (const [name, version] of Object.entries(expected)) {
      const installed = JSON.parse(await readFile(path.join(directory, 'node_modules', name, 'package.json'), 'utf8'));
      if (installed.version !== version) throw new Error(`Unexpected runtime dependency version for ${name}`);
    }
  }
  let ready = false;
  try {
    ready = (await readFile(marker, 'utf8')) === fingerprint;
    if (ready) await verify();
  } catch { ready = false; }
  if (!ready) {
    await writeFile(path.join(directory, 'package.json'), manifest);
    await writeFile(path.join(directory, 'package-lock.json'), lock);
    await writeFile(path.join(directory, 'pnpm-lock.yaml'), pnpmLock);
    const installer = await runtimeDependencyInstaller(runtime);
    await run(installer.command, installer.args, { cwd: directory, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
    await verify();
    await writeFile(marker, fingerprint, { mode: 0o600 });
  }
  return required;
}
