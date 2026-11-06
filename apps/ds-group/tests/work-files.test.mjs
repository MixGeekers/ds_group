import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareWorkFiles, collectArtifacts, parseFinalOutput } from '../dsh-plugin/work-files.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const coded = code => error => error.code === code;

test('native Bots can return existing files from their original working directory', async t => {
  const root = await temporary(t);
  const attachments = path.join(root, 'attachments'); await mkdir(attachments);
  const original = path.join(root, 'native-result.txt'); await writeFile(original, 'original native output');
  const artifacts = await collectArtifacts(JSON.stringify({ text: '完成', artifacts: [{ path: original }] }), attachments, { allowExternalPaths: true });
  assert.equal(artifacts[0].path, original); assert.equal(artifacts[0].sha256, hash('original native output'));
});

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ds-group-work-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

test('task work directories are stable and input descriptors verify the actual bytes', async t => {
  const root = await temporary(t);
  const initial = await prepareWorkFiles({ dataDir: root, requestId: '../request/一' });
  const bytes = Buffer.from('部门,费用\n人事,320\n');
  await writeFile(path.join(initial.workdir, 'costs.csv'), bytes);
  const descriptor = { id: 'attachment-one', path: 'costs.csv', name: '费用.csv', size: bytes.length, sha256: hash(bytes) };
  const prepared = await prepareWorkFiles({ dataDir: root, requestId: '../request/一', files: [descriptor] });
  assert.equal(prepared.workdir, initial.workdir);
  assert.equal(path.basename(prepared.workdir), hash('../request/一'));
  assert.deepEqual(prepared.files, [{ id: 'attachment-one', name: '费用.csv', path: path.join(prepared.workdir, 'costs.csv'),
    mimeType: 'text/csv', size: bytes.length, sha256: hash(bytes) }]);
  await assert.rejects(prepareWorkFiles({ dataDir: root, requestId: 'other', workdir: initial.workdir,
    files: [{ ...descriptor, sha256: 'a'.repeat(64) }] }), coded('WORK_FILE_HASH_MISMATCH'));
  await assert.rejects(prepareWorkFiles({ dataDir: root, requestId: 'other', workdir: initial.workdir,
    files: [{ ...descriptor, size: bytes.length + 1 }] }), coded('WORK_FILE_SIZE_MISMATCH'));
});

test('only explicitly declared real artifacts are returned and empty files remain valid', async t => {
  const root = await temporary(t);
  await writeFile(path.join(root, 'result.xlsx'), 'synthetic-office-bytes');
  await writeFile(path.join(root, 'empty.txt'), '');
  await writeFile(path.join(root, 'unlisted.csv'), 'ignored');
  const text = '```json\n' + JSON.stringify({ text: '处理完成', artifacts: [{ path: 'result.xlsx' }, { path: 'empty.txt' }],
    delegate: { to: '@hr:test', body: '请汇总' } }) + '\n```';
  const artifacts = await collectArtifacts(text, root);
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0].mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(artifacts[0].sha256, hash('synthetic-office-bytes'));
  assert.equal(artifacts[1].size, 0);
  assert.equal(artifacts[1].sha256, hash(''));
  assert.equal(parseFinalOutput(text).delegate.to, '@hr:test');
  assert.deepEqual(await collectArtifacts('文件位于 result.xlsx', root), []);
  assert.deepEqual(await collectArtifacts('{"text":"普通回复"}', root), []);
});

test('input extraction preserves format details and requires a real sidecar within the task directory', async t => {
  const root = await temporary(t);
  const workspace = path.join(root, 'task');
  const outside = path.join(root, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(path.join(workspace, 'source.xlsx'), 'synthetic-office-bytes');
  await writeFile(path.join(workspace, 'extracted.txt'), 'Sheet1!A1 = 部门');
  await writeFile(path.join(outside, 'other.txt'), 'outside');
  await symlink(outside, path.join(workspace, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const descriptor = { path: 'source.xlsx', extraction: { type: 'xlsx', textPath: 'extracted.txt',
    supported: true, truncated: true, warnings: ['Only the first worksheet was extracted'] } };
  const prepared = await prepareWorkFiles({ requestId: 'extract', workdir: workspace, files: [descriptor] });
  assert.deepEqual(prepared.files[0].extraction, { ...descriptor.extraction, textPath: path.join(workspace, 'extracted.txt') });
  const unsupported = await prepareWorkFiles({ requestId: 'unknown', workdir: workspace,
    files: [{ path: 'source.xlsx', extraction: { type: 'binary', supported: false, truncated: false, warnings: ['Unsupported format'] } }] });
  assert.equal(unsupported.files[0].extraction.supported, false);
  assert.equal(unsupported.files[0].extraction.textPath, undefined);
  for (const textPath of ['../outside/other.txt', 'outside-link/other.txt']) {
    await assert.rejects(prepareWorkFiles({ requestId: 'escape', workdir: workspace,
      files: [{ ...descriptor, extraction: { ...descriptor.extraction, textPath } }] }), coded('WORK_FILE_OUTSIDE_DIRECTORY'));
  }
  await assert.rejects(prepareWorkFiles({ requestId: 'missing', workdir: workspace,
    files: [{ ...descriptor, extraction: { ...descriptor.extraction, textPath: 'missing.txt' } }] }), coded('WORK_FILE_NOT_FOUND'));
});

test('equivalent directory aliases resolve to the same task files', async t => {
  const root = await temporary(t);
  const workspace = path.join(root, 'task');
  const alias = path.join(root, 'task-alias');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'input.csv'), 'department,cost\nHR,320\n');
  await writeFile(path.join(workspace, 'extracted.txt'), 'HR costs 320');
  await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const input = { path: path.join(alias, 'input.csv'), extraction: { type: 'csv',
    textPath: path.join(alias, 'extracted.txt'), supported: true, truncated: false, warnings: [] } };
  const prepared = await prepareWorkFiles({ requestId: 'alias', workdir: alias, files: [input] });
  assert.equal(prepared.workdir, workspace);
  assert.equal(prepared.files[0].path, path.join(workspace, 'input.csv'));
  assert.equal(prepared.files[0].extraction.textPath, path.join(workspace, 'extracted.txt'));
  const artifacts = await collectArtifacts(JSON.stringify({ text: '完成', artifacts: [{ path: input.path }] }), alias);
  assert.equal(artifacts[0].path, path.join(workspace, 'input.csv'));
});

test('missing paths, duplicate artifacts, directories and oversized results fail before publication', async t => {
  const root = await temporary(t);
  await writeFile(path.join(root, 'result.txt'), '123456');
  await mkdir(path.join(root, 'folder'));
  const output = artifacts => JSON.stringify({ text: '完成', artifacts });
  await assert.rejects(collectArtifacts(output([{ path: 'missing' }]), root), coded('WORK_FILE_NOT_FOUND'));
  await assert.rejects(collectArtifacts(output([{ path: 'folder' }]), root), coded('WORK_FILE_NOT_REGULAR'));
  await assert.rejects(collectArtifacts(output([{ path: 'result.txt' }, { path: './result.txt' }]), root), coded('DUPLICATE_ARTIFACT'));
  await assert.rejects(collectArtifacts(output([{ path: 'result.txt' }]), root, { maxBytes: 5 }), coded('WORK_FILE_TOO_LARGE'));
  await assert.rejects(collectArtifacts(output(Array.from({ length: 17 }, () => ({ path: 'result.txt' }))), root), coded('TOO_MANY_ARTIFACTS'));
  await assert.rejects(prepareWorkFiles({ requestId: 'one', workdir: root,
    files: [{ id: 'a', path: 'result.txt' }, { id: 'a', path: 'result.txt' }] }), coded('DUPLICATE_WORK_FILE'));
});

test('files outside the task directory and symbolic-link escapes are rejected', async t => {
  const root = await temporary(t);
  const workspace = path.join(root, 'task');
  const outside = path.join(root, 'other');
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(path.join(outside, 'private.txt'), 'outside');
  await symlink(outside, path.join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const output = filename => JSON.stringify({ text: '完成', artifacts: [{ path: filename }] });
  await assert.rejects(collectArtifacts(output('../other/private.txt'), workspace), coded('WORK_FILE_OUTSIDE_DIRECTORY'));
  await assert.rejects(collectArtifacts(output('link/private.txt'), workspace), coded('WORK_FILE_OUTSIDE_DIRECTORY'));
  await assert.rejects(prepareWorkFiles({ requestId: 'one', workdir: workspace,
    files: [{ path: 'link/private.txt' }] }), coded('WORK_FILE_OUTSIDE_DIRECTORY'));
  await assert.rejects(prepareWorkFiles({ requestId: 'one', workdir: 'relative' }), coded('INVALID_WORK_DIRECTORY'));
});

test('structured output rejects invalid declarations and unsafe display names', async t => {
  const root = await temporary(t);
  await writeFile(path.join(root, 'result.txt'), 'text');
  assert.throws(() => parseFinalOutput('{"artifacts":[]}'), coded('INVALID_FINAL_OUTPUT'));
  assert.throws(() => parseFinalOutput('{"text":"  ","artifacts":[]}'), coded('INVALID_FINAL_OUTPUT'));
  assert.throws(() => parseFinalOutput('{"text":"完成","artifacts":"result.txt"}'), coded('INVALID_FINAL_OUTPUT'));
  await assert.rejects(collectArtifacts(JSON.stringify({ text: '完成', artifacts: [{ path: 'result.txt', name: '../result.txt' }] }), root), coded('INVALID_WORK_FILE'));
});
