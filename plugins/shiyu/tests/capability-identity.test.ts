import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { localNoteDefinitionDigest, localNoteEnvironmentFingerprint, nativeWorkerDependencyFingerprint } from '../src/adapters/capability-identity.js';

test('actual native seam bytes and owning package metadata affect identity while physical paths do not', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shiyu-capability-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = { name: '@deepseek-ai/dsh-llm', version: 'synthetic-only-1' };
  async function install(name: string) {
    const directory = path.join(root, name); await mkdir(path.join(directory, 'dist'), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify(metadata));
    await writeFile(path.join(directory, 'dist', 'message.js'), 'export const syntheticMessageFactory = 1;');
    await writeFile(path.join(directory, 'dist', 'index.js'), 'export const syntheticMain = 1;');
    return { directory, entries: ['message', 'index'].map(file => pathToFileURL(path.join(directory, 'dist', `${file}.js`)).href) };
  }
  const first = await install('first'), second = await install('second');
  const original = nativeWorkerDependencyFingerprint(first.entries);
  assert.equal(nativeWorkerDependencyFingerprint(second.entries), original);
  await writeFile(path.join(second.directory, 'dist', 'message.js'), 'export const syntheticMessageFactory = 2;');
  const changedCode = nativeWorkerDependencyFingerprint(second.entries);
  assert.notEqual(changedCode, original);
  await writeFile(path.join(second.directory, 'package.json'), JSON.stringify({ ...metadata, version: 'synthetic-only-2' }));
  assert.notEqual(nativeWorkerDependencyFingerprint(second.entries), changedCode);
  assert.notEqual(localNoteEnvironmentFingerprint(original), localNoteEnvironmentFingerprint(changedCode));
  assert.match(localNoteDefinitionDigest(), /^[a-f0-9]{64}$/);
});

test('missing or opaque dependency identity never becomes a usable empty fingerprint', () => {
  assert.throws(() => nativeWorkerDependencyFingerprint(['data:text/javascript,export{}', 'data:text/javascript,export{}']), /inspectable/);
  assert.throws(() => nativeWorkerDependencyFingerprint([]), /fixed native/);
  assert.throws(() => localNoteEnvironmentFingerprint('unavailable'), /Invalid/);
});
