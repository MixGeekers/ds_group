import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultModel } from './dsh/sessions.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
/** Fixed implementation inputs, not a caller-selected registry or the whole plugin bundle. */
export const LOCAL_NOTE_IMPLEMENTATION_FILES = Object.freeze([
  './capability-identity', '../contracts/capability', './control-store/capability-domain', './control-store/task-domain',
  '../control/task-runner', './artifacts/index', '../control/tasks/index', '../control/tasks/types',
  '../control/tasks/upstream/engine', '../control/tasks/upstream/model', '../control/goal-lifecycle',
  '../control/tasks/upstream/intake', '../control/tasks/upstream/tickets', '../control/tasks/upstream/replies',
  '../control/tasks/upstream/evals', '../control/tasks/upstream/assignments', '../control/tasks/upstream/stage',
  '../control/tasks/upstream/part', '../control/tasks/upstream/ids', '../control/tasks/upstream/reasons', '../control/tasks/upstream/errors',
  '../control/effects/index', '../control/effects/contracts', '../control/policy/mandates',
  './control-store/task-repositories', './control-store/authority', './control-store/transaction', './control-store/commit-watermark',
  './dsh/workers', './dsh/native-message', './dsh/session-title',
]);

/** Local package bytes only; source-mode fixtures and installed builds have distinct, honest identities. */
export function localNoteDefinitionDigest(): string {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return hash(JSON.stringify({ protocol: 'shiyu-fixed-local-note-v1', model: defaultModel('worker'), inputs: LOCAL_NOTE_IMPLEMENTATION_FILES.map(name =>
    [name, hash(readFileSync(new URL(`${name}${extension}`, import.meta.url)))]) }));
}

/** No paths, host epoch, timestamps, credentials or task/session identifiers enter this identity. */
export function localNoteEnvironmentFingerprint(dependencyFingerprint: string): string {
  if (!/^[a-f0-9]{64}$/.test(dependencyFingerprint)) throw new Error('Invalid worker dependency fingerprint');
  return hash(JSON.stringify({ dependencyFingerprint, node: process.versions.node, platform: process.platform,
    arch: process.arch, artifactRootPolicy: 'owned-private-directory-no-symlink-held-anchor-v1' }));
}

/** Read the exact official public seam bytes and owning package metadata; does not create a Session. */
export function nativeWorkerDependencyFingerprint(entries: readonly string[]): string {
  if (entries.length !== 2) throw new Error('Expected the two fixed native worker public seams');
  const inputs = entries.map(url => {
    if (!url.startsWith('file:')) throw new Error('Native worker dependency has no inspectable installed file');
    const filename = fileURLToPath(url);
    let directory = dirname(filename);
    for (let depth = 0; depth < 8; depth++) {
      try {
        const bytes = readFileSync(join(directory, 'package.json'));
        const metadata = JSON.parse(bytes.toString('utf8')) as { name?: string; version?: string };
        if (metadata.name === '@deepseek-ai/dsh-llm' && typeof metadata.version === 'string') {
          return { packageName: metadata.name, version: metadata.version, packageDigest: hash(bytes), entryDigest: hash(readFileSync(filename)) };
        }
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      const parent = dirname(directory); if (parent === directory) break; directory = parent;
    }
    throw new Error('Native worker package identity is unavailable');
  });
  return hash(JSON.stringify(inputs));
}

/** A failed preflight is a stable unavailable environment, never a usable fallback. */
export const UNAVAILABLE_WORKER_DEPENDENCY = hash('shiyu-worker-dependency-unavailable-v1');
