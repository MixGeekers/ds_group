import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homeLock } from '../vendor/ds-bot/src/host/home-lock.js';

export const KERNEL_ID = 'dscord-kernel';
export const KERNEL_VERSION = '0.4.0';
export const KERNEL_UPSTREAM_VERSION = '0.3.1';
export const KERNEL_API = '/api/dscord/kernel';
export const KERNEL_API_VERSION = 1;
const registryKey = Symbol.for('dscord/kernel/homes');
const registry = globalThis[registryKey] ??= new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = filename => {
  try { return JSON.parse(readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
};

export function kernelConflict(message, details = {}) {
  return Object.assign(new Error(message), { code: 'DSCORD_KERNEL_CONFLICT', details: {
    ...details, action: 'stop-legacy-and-reload', plugins: ['ds-bot'],
    steps: ['Stop the previous DS-Bot plugin or the DSH process owning this home.', 'Reload DSCord; the existing Bot and Session identities are adopted in place.'],
  } });
}

/** A pure route probe; unlike legacy state, kernel-info never bootstraps a Bot. */
export async function detectLegacyRuntime(ctx) {
  const handler = ctx.connection.createSharedFetchHandler('/api');
  const response = await handler.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'kernel-info', payload: {} }),
  }), ctx.connection.browserPeer);
  if (response.status === 404) return undefined;
  let value;
  try { value = await response.json(); } catch { /* An occupied route still conflicts. */ }
  return { api: '/api/bot', status: response.status, runtime: value?.value?.runtime ?? null };
}

/** Claim the original home before installing listeners or background work.
 * Adoption never clones Sessions, moves files, or replays an uncertain task. */
export function claimKernelHome(home, { owner } = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  home = realpathSync(home);
  const existing = registry.get(home);
  if (existing) throw kernelConflict('This Bot home already has a DSCord kernel in this process.', { home, runtime: existing.info() });
  const lock = homeLock(path.join(home, 'state.lock'));
  const holder = lock.claim();
  if (holder !== undefined) throw kernelConflict('Another runtime owns this Bot home; DSCord did not start a second writer.', { home, holder });

  const filename = path.join(home, 'dscord-kernel.json');
  const instanceId = randomUUID();
  let status = 'starting', rt, disposed = false;
  let adoption;
  try {
    const previous = read(filename);
    if (previous && previous.dataVersion !== 1) throw Object.assign(new Error('This Bot home was adopted by a newer DSCord data format.'), { code: 'DSCORD_KERNEL_DATA_VERSION' });
    const statePath = path.join(home, 'state.json');
    const bytes = existsSync(statePath) ? readFileSync(statePath) : undefined;
    const state = bytes === undefined ? undefined : JSON.parse(bytes);
    if (state && state.version !== 1) throw Object.assign(new Error('The saved Bot team has an unsupported data version.'), { code: 'DSCORD_KERNEL_DATA_VERSION' });
    adoption = previous?.adoption;
    if (!adoption) {
      const directory = path.join(home, 'migrations', `dscord-${KERNEL_VERSION}`);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const sha256 = bytes === undefined ? null : hash(bytes);
      const snapshot = bytes === undefined ? null : path.join(directory, `state-${sha256}.json`);
      if (snapshot) {
        try { copyFileSync(statePath, snapshot, constants.COPYFILE_EXCL); }
        catch (error) { if (error.code !== 'EEXIST' || hash(readFileSync(snapshot)) !== sha256) throw error; }
        chmodSync(snapshot, 0o600);
      }
      const inflight = path.join(home, 'inflight.json');
      let inflightSnapshot = null;
      if (existsSync(inflight)) {
        inflightSnapshot = path.join(directory, `inflight-${hash(readFileSync(inflight))}.json`);
        try { copyFileSync(inflight, inflightSnapshot, constants.COPYFILE_EXCL); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        chmodSync(inflightSnapshot, 0o600);
      }
      adoption = { at: new Date().toISOString(), from: state ? 'existing-ds-bot-home' : 'new-home', snapshot, sha256,
        inflightSnapshot, botIds: Object.keys(state?.bots ?? {}), sessionPolicy: 'preserve-native-identities', tasksReplayed: false };
      const manifest = path.join(directory, 'adoption.json');
      try { writeFileSync(manifest, JSON.stringify(adoption, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const info = () => ({ id: KERNEL_ID, version: KERNEL_VERSION, upstreamVersion: KERNEL_UPSTREAM_VERSION,
      apiVersion: KERNEL_API_VERSION, api: KERNEL_API, instanceId, status, home,
      dataVersion: 1, hostCompatibility: { minimum: '0.2.2-rc.1', sessionSource: 'native-agent-inbox' },
      memoryBackend: rt?.memoryBackend ?? 'source-aware', adoption,
      ...(rt?.migrationWorkView ? { migrationWork: rt.migrationWorkView() } : {}),
      ...(rt?.readOnly?.() ? { readOnly: rt.readOnly() } : {}),
    });
    const persist = () => {
      const temporary = `${filename}.${instanceId}.tmp`;
      writeFileSync(temporary, JSON.stringify(info(), null, 2) + '\n', { mode: 0o600 });
      renameSync(temporary, filename);
    };
    const release = () => {
      if (disposed) return;
      disposed = true; status = 'stopped';
      // A replacement may have started after its predecessor released the state
      // lock. Never overwrite that replacement's lifecycle record.
      try { if (read(filename)?.instanceId === instanceId) persist(); }
      finally {
        if (registry.get(home)?.instanceId === instanceId) registry.delete(home);
        lock.release();
      }
    };
    const lease = { home, lock, instanceId, owner, adoption, adopted: adoption.from === 'existing-ds-bot-home' && adoption.prepared !== true, info, release,
      ready(runtime) { rt = runtime; adoption.prepared = true; status = 'running'; persist(); return runtime; },
    };
    registry.set(home, lease);
    persist();
    return lease;
  } catch (error) {
    if (registry.get(home)?.instanceId === instanceId) registry.delete(home);
    lock.release();
    throw error;
  }
}
