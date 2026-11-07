import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { packageRoot } from '../src/paths.mjs';

const execute = promisify(execFile);
const script = path.join(packageRoot, 'scripts/memory-setup.mjs');

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dscord-memory-setup-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'ombre/src'), { recursive: true });
  await writeFile(path.join(directory, 'ombre/src/embedding_engine.py'), '# configuration fixture; never executed\n');
  return { directory, args: ['--python', process.execPath, '--ombre', './ombre', '--endpoint', 'http://127.0.0.1:9/v1/embeddings'],
    options: { cwd: directory, env: { ...process.env, DSH_HOME: path.join(directory, 'unrelated-dsh') } } };
}

test('memory setup can target the actual independent kernel home without starting a backend', async t => {
  const f = await fixture(t);
  const result = await execute(process.execPath, [script, '--kernel-home', './node/runtime/ds-bot', ...f.args], f.options);
  const report = JSON.parse(result.stdout);
  const filename = path.join(f.directory, 'node/runtime/ds-bot/knowledge/backend.json');
  assert.equal(report.filename, filename);
  const config = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(config.upstream, path.join(f.directory, 'ombre'));
  assert.equal(config.endpoint, 'http://127.0.0.1:9/v1/embeddings');
  await assert.rejects(readFile(path.join(f.options.env.DSH_HOME, 'bot/knowledge/backend.json')), { code: 'ENOENT' });
});

test('memory setup preserves the existing DSH-home interpretation of --home', async t => {
  const f = await fixture(t);
  const result = await execute(process.execPath, [script, '--home', './chosen-dsh', ...f.args], f.options);
  assert.equal(JSON.parse(result.stdout).filename, path.join(f.directory, 'chosen-dsh/bot/knowledge/backend.json'));
});

test('memory setup rejects ambiguous targets and unknown flags instead of writing another home', async t => {
  const f = await fixture(t);
  await assert.rejects(execute(process.execPath, [script, '--home', './one', '--kernel-home', './two', ...f.args], f.options), /Choose --home/);
  await assert.rejects(execute(process.execPath, [script, '--kernel-hom', './typo', ...f.args], f.options), /Unknown option/);
  await assert.rejects(readFile(path.join(f.options.env.DSH_HOME, 'bot/knowledge/backend.json')), { code: 'ENOENT' });
});
