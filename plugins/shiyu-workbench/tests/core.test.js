import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  mkdtemp, mkdir, writeFile, readFile, readdir, realpath, stat, lstat, open, symlink, rm,
} from 'node:fs/promises';
import {
  ShiyuWorkbench, MAX_BYTES, MAX_FILES, VERSION, parseDocument, parseIndex,
  toolDefinition, serveRequest,
} from '../core.js';

// These are test adapters, not a Harness filesystem/storage implementation.
// Checked against Host Service.listService(fs/storage), 2026-10-30:
// - FsTarget.targetKey is opaque; resolve follows existing symlinks.
// - contains is canonical; listDir is stable and follows resolved child targets.
// - stat returns undefined for missing paths; readBytes has an inclusive byte cap
//   and throws FS_TOO_LARGE, never returning truncated data.
// - KvUnit uses loadAll(), setGlobal(value), close().
// No React, DOM, Cordis runtime, installed plugin state, or user-data writes.
const REAL_WORKSPACE = fileURLToPath(new URL('../../../', import.meta.url));
const PREFIX = 'shiyu-workbench-test-';
const TEST_OPTIONS = { timeout: 15000 };
const CANDIDATE_NAMES = [
  'Ombre-Brain.md', 'MaiBot.md', 'Mem0.md', 'Letta.md',
  'Memory-R1.md', 'AgeMem.md', 'MemRL.md', 'macOS完全控制.md',
];
const DESIGN_NAMES = ['总体架构.md', '内外双工与角色边界.md', '记忆决策模型调研.md'];

const clone = value => value === undefined ? undefined : structuredClone(value);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';
const coded = (code, message) => Object.assign(new Error(message), { code });
const fileType = info => info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other';
const version = info => `test-version:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;

async function canonical(input) {
  try { return await realpath(input); }
  catch (error) {
    if (!missing(error)) throw error;
    const parent = path.dirname(input);
    if (parent === input) throw error;
    return path.join(await canonical(parent), path.basename(input));
  }
}

class ReadOnlyFsAdapter {
  constructor(allowedRoots, hook = async () => {}) {
    this.allowedRoots = allowedRoots;
    this.hook = hook;
    this.calls = [];
    this.targets = new Map();
    this.paths = new WeakMap();
  }
  async record(method, targetPath, details = {}) {
    this.calls.push({ method, path: targetPath, ...details });
    await this.hook(method, targetPath, details);
  }
  targetPath(target) {
    const result = this.paths.get(target);
    assert.ok(result, 'FsTarget must belong to this provider');
    return result;
  }
  assertReadable(targetPath) {
    assert.ok(this.allowedRoots.some(root => within(root, targetPath)), `test adapter cannot read outside explicitly allowed roots: ${targetPath}`);
  }
  async resolve(input, options = {}) {
    options.signal?.throwIfAborted();
    const targetPath = await canonical(path.resolve(options.cwd || this.allowedRoots[0], input));
    await this.record('resolve', targetPath);
    options.signal?.throwIfAborted();
    if (!this.targets.has(targetPath)) {
      const target = Object.freeze({ targetKey: `opaque-target-${this.targets.size + 1}`, displayPath: input });
      this.targets.set(targetPath, target);
      this.paths.set(target, targetPath);
    }
    return this.targets.get(targetPath);
  }
  processPath(target) { return this.targetPath(target); }
  contains(parent, child) { return within(this.targetPath(parent), this.targetPath(child)); }
  async stat(target, signal) {
    signal?.throwIfAborted();
    const targetPath = this.targetPath(target);
    this.assertReadable(targetPath);
    await this.record('stat', targetPath);
    signal?.throwIfAborted();
    try {
      const info = await stat(targetPath);
      return { type: fileType(info), version: version(info), size: info.size };
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  async listDir(target, signal) {
    signal?.throwIfAborted();
    const targetPath = this.targetPath(target);
    this.assertReadable(targetPath);
    await this.record('listDir', targetPath);
    const names = (await readdir(targetPath)).sort();
    const entries = [];
    for (const name of names) {
      signal?.throwIfAborted();
      const child = await this.resolve(name, { cwd: targetPath, signal });
      const info = await this.stat(child, signal);
      entries.push({ name, target: child, type: info?.type || 'other', size: info?.size, version: info?.version });
    }
    return entries;
  }
  async readBytes(target, signal, maxBytes) {
    signal?.throwIfAborted();
    assert.ok(Number.isSafeInteger(maxBytes) && maxBytes >= 0, 'readBytes requires a finite bound');
    const targetPath = this.targetPath(target);
    this.assertReadable(targetPath);
    await this.record('readBytes', targetPath, { maxBytes });
    signal?.throwIfAborted();
    const handle = await open(targetPath, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw coded('FS_NOT_FILE', 'Not a regular file');
      if (info.size > maxBytes) throw coded('FS_TOO_LARGE', 'File exceeds bounded byte read');
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length <= maxBytes) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > maxBytes) throw coded('FS_TOO_LARGE', 'File grew beyond bounded byte read');
      signal?.throwIfAborted();
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  }
}

// All synthetic documents AND persistent test state live under this one owned
// mkdtemp directory. Before deletion we verify canonical absolute ownership and
// the original directory identity; no cleanup path is derived from user input.
async function withFixture(run) {
  const parent = await realpath(os.tmpdir());
  const created = await mkdtemp(path.join(parent, PREFIX));
  const root = await realpath(created);
  assert.ok(path.isAbsolute(root));
  assert.equal(root, created);
  assert.equal(path.dirname(root), parent);
  assert.ok(path.basename(root).startsWith(PREFIX));
  assert.notEqual(root, REAL_WORKSPACE);
  const identity = await lstat(root);
  assert.ok(identity.isDirectory() && !identity.isSymbolicLink());
  const services = [];
  const owned = relative => {
    assert.equal(typeof relative, 'string');
    assert.ok(!path.isAbsolute(relative), 'fixture paths are relative to the owned root');
    const result = path.resolve(root, relative);
    assert.ok(result !== root && within(root, result), 'fixture path must stay below the owned root');
    return result;
  };
  const fixture = {
    root, owned, services,
    async mkdir(relative) {
      const destination = owned(relative);
      assert.ok(within(root, await canonical(path.dirname(destination))));
      await mkdir(destination, { recursive: true });
      assert.ok(within(root, await realpath(destination)));
      return destination;
    },
    async write(relative, content) {
      const destination = owned(relative);
      assert.ok(within(root, await canonical(destination)));
      await mkdir(path.dirname(destination), { recursive: true });
      assert.ok(within(root, await realpath(path.dirname(destination))));
      await writeFile(destination, content);
      return destination;
    },
    async link(targetRelative, linkRelative) {
      const target = owned(targetRelative), destination = owned(linkRelative);
      assert.ok(within(root, await canonical(target)));
      await mkdir(path.dirname(destination), { recursive: true });
      assert.ok(within(root, await realpath(path.dirname(destination))));
      await symlink(target, destination);
      return destination;
    },
  };
  try { return await run(fixture); }
  finally {
    try {
      for (const service of services) if (!service.closed) await service.close();
    } finally {
      const current = await lstat(root);
      assert.equal(await realpath(root), root, 'cleanup root must not have become an alias');
      assert.equal(path.dirname(root), parent);
      assert.ok(path.basename(root).startsWith(PREFIX));
      assert.ok(current.isDirectory() && !current.isSymbolicLink());
      assert.equal(current.dev, identity.dev);
      assert.equal(current.ino, identity.ino, 'cleanup must delete only the mkdtemp directory created by this test');
      await rm(root, { recursive: true, force: false });
    }
  }
}

class FixtureKvUnit {
  constructor(fixture, relative = 'state/settings.json') {
    this.fixture = fixture;
    this.relative = relative;
    this.filename = fixture.owned(relative);
    this.writes = [];
    this.activeWrites = 0;
    this.maxActiveWrites = 0;
    this.closed = false;
    this.beforeSet = async () => {};
  }
  async loadAll() {
    assert.equal(this.closed, false);
    try { return { tables: {}, global: JSON.parse(await readFile(this.filename, 'utf8')) }; }
    catch (error) {
      if (error.code === 'ENOENT') return { tables: {}, global: undefined };
      throw error;
    }
  }
  async setGlobal(value) {
    assert.equal(this.closed, false);
    const saved = clone(value);
    this.activeWrites++;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    try {
      await this.beforeSet(saved);
      await this.fixture.write(this.relative, JSON.stringify(saved));
      this.writes.push(saved);
    } finally { this.activeWrites--; }
  }
  async close() {
    assert.equal(this.activeWrites, 0, 'storage must not close while a selection is committing');
    this.closed = true;
  }
}

async function harness(fixture, options = {}) {
  const initialWorkspace = options.initialWorkspace || await fixture.mkdir('workspace');
  const fs = options.fs || new ReadOnlyFsAdapter([fixture.root]);
  const unit = options.unit || new FixtureKvUnit(fixture, options.store || 'state/settings.json');
  const service = new ShiyuWorkbench(fs, unit, { initialWorkspace });
  fixture.services.push(service);
  await service.initialize();
  return { fs, unit, service, initialWorkspace };
}

function expectError(result, code) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code);
  assert.equal(typeof result.error.message, 'string');
  assert.ok(result.error.message.length > 0);
}
async function operate(service, request) {
  const result = await service.operate(request);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
async function throughBoth(service, input) {
  const tool = toolDefinition(service);
  const toolResult = await tool.execute(input, { signal: new AbortController().signal });
  const response = await serveRequest(service, new Request('http://test.invalid/api/shiyu-workbench', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }));
  const httpResult = await response.json();
  assert.equal(response.status, toolResult.ok ? 200 : 400);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  // snapshot timestamps are intentionally volatile; all other fields must match.
  const comparable = result => {
    const copy = clone(result);
    if (input?.action === 'snapshot' && copy.ok) {
      assert.ok(Number.isFinite(Date.parse(copy.data.scannedAt)));
      delete copy.data.scannedAt;
    }
    return copy;
  };
  assert.deepEqual(comparable(httpResult), comparable(toolResult));
  assert.deepEqual(JSON.parse(tool.output.render(input, toolResult)[0].text), toolResult);
  return toolResult;
}

function candidateIndex(names) {
  return '| 项目 | 类型 | 方向 | 状态 | 当前判断 | 日期 |\n|---|---|---|---|---|---|\n'
    + names.map((name, index) => `| [索引标题${index}](<${name}>) | 项目 | 测试 | 已初评 | 摘要${index} | 2026-10-30 |`).join('\n');
}

// Integration against the real repository: read-only adapter + fixture-owned KV.
test('真实文档：8 个目录候选、3 份设计、4 张图纸，顺序和源行号可追溯', TEST_OPTIONS, async t => {
  await withFixture(async fixture => {
    const root = await realpath(REAL_WORKSPACE);
    const fs = new ReadOnlyFsAdapter([root]);
    const { service, unit } = await harness(fixture, { initialWorkspace: root, fs });
    const namesIn = async folder => (await readdir(path.join(root, folder), { withFileTypes: true }))
      .filter(entry => entry.isFile() && /\.md$/i.test(entry.name)).map(entry => entry.name);
    const candidateFiles = await namesIn('技术候选');
    const architectureFiles = await namesIn('架构与设计');
    const sourcePaths = [
      ...candidateFiles.map(name => `技术候选/${name}`),
      ...architectureFiles.map(name => `架构与设计/${name}`),
    ];
    // Independent expected ordering from the actual table, not parseIndex itself.
    const indexedNames = async folder => [...(await readFile(path.join(root, folder, '目录.md'), 'utf8'))
      .matchAll(/^\|\s*\[[^\]]+\]\(<([^>]+\.md)>\)/gm)].map(match => decodeURIComponent(match[1]));
    const candidateOrder = await indexedNames('技术候选');
    const architectureOrder = await indexedNames('架构与设计');
    const fingerprints = new Map();
    for (const relative of sourcePaths) {
      fingerprints.set(relative, createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex'));
    }
    const data = await operate(service, { action: 'snapshot' });
    assert.equal(data.version, VERSION);
    const baselineDesigns = data.architecture.filter(item => DESIGN_NAMES.includes(path.basename(item.path)));
    const baselineCandidates = data.candidates.filter(item => CANDIDATE_NAMES.includes(path.basename(item.path)));
    assert.deepEqual(baselineDesigns.map(item => path.basename(item.path)), DESIGN_NAMES);
    assert.deepEqual(baselineCandidates.map(item => path.basename(item.path)), CANDIDATE_NAMES);
    assert.equal(baselineCandidates.filter(item => item.indexed).length, 8);
    assert.equal(baselineDesigns.length, 3);
    assert.equal(baselineDesigns.reduce((sum, item) => sum + item.diagramCount, 0), 4);
    assert.deepEqual(data.candidates.filter(item => item.indexed).map(item => path.basename(item.path)), candidateOrder.filter(name => candidateFiles.includes(name)));
    assert.deepEqual(data.architecture.filter(item => item.indexed).map(item => path.basename(item.path)), architectureOrder.filter(name => architectureFiles.includes(name)));
    assert.equal(data.counts.candidates, candidateFiles.filter(name => name !== '目录.md').length);
    assert.equal(data.counts.architecture, architectureFiles.filter(name => name !== '目录.md').length);
    assert.equal(data.counts.diagrams, data.architecture.reduce((sum, item) => sum + item.diagramCount, 0));
    const missingIndexed = [
      ...candidateOrder.filter(name => !candidateFiles.includes(name)).map(name => `技术候选/${name}`),
      ...architectureOrder.filter(name => !architectureFiles.includes(name)).map(name => `架构与设计/${name}`),
    ];
    assert.deepEqual(data.warnings.map(w => [w.code, w.path]), missingIndexed.map(p => ['INDEX_TARGET_MISSING', p]));
    assert.deepEqual(data.indexes, [
      { section: 'candidates', path: '技术候选/目录.md' },
      { section: 'architecture', path: '架构与设计/目录.md' },
    ]);
    const extra = data.candidates.filter(item => !item.indexed);
    t.diagnostic(`实际目录：${data.counts.candidates} 候选（${candidateOrder.length} 已索引、${extra.length} 未索引），${data.counts.architecture} 设计，${data.counts.diagrams} 图；原始 8 候选 / 3 设计 / 4 图子集全部保留。`);
    assert.equal(data.counts.candidates, data.candidates.length);
    assert.deepEqual(data.candidates.slice(0, 8).map(item => path.basename(item.path)), CANDIDATE_NAMES);
    const expected = [
      ['架构与设计/总体架构.md', 26, '2. 总体分层'],
      ['架构与设计/总体架构.md', 99, '4. 信息流候选，而非既定实现'],
      ['架构与设计/内外双工与角色边界.md', 39, '对话与通知通道：可以双向'],
      ['架构与设计/记忆决策模型调研.md', 82, '5. 识雨第一版的决策链候选'],
    ];
    assert.deepEqual(baselineDesigns.flatMap(item => item.diagrams.map(diagram => [item.path, diagram.line, diagram.title])), expected);
    for (const item of [...data.candidates, ...data.architecture]) {
      const doc = await operate(service, { action: 'read_document', path: item.path, workspacePath: root });
      assert.equal(doc.bytes, Buffer.byteLength(doc.text, 'utf8'));
      assert.equal(doc.version, item.version);
      for (const diagram of doc.diagrams) {
        assert.equal(diagram.id, `${item.path}:${diagram.line}`);
        assert.equal(diagram.language, 'text');
        assert.equal(doc.text.split('\n').slice(diagram.line - 1, diagram.line - 1 + diagram.source.split('\n').length).join('\n'), diagram.source);
        assert.match(doc.text.split('\n')[diagram.line - 2], /^\s*(?:`{3,}|~{3,})(?:text|plaintext|mermaid)?\s*$/);
      }
    }
    for (const [relative, digest] of fingerprints) {
      assert.equal(createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex'), digest, `real document changed: ${relative}`);
    }
    assert.equal(unit.writes.length, 1, 'only fixture-owned initial settings were saved');
    assert.ok(fs.calls.filter(call => call.method === 'readBytes').every(call => sourcePaths.includes(path.relative(root, call.path)) || extra.some(item => path.join(root, item.path) === call.path)));
  });
});

test('目录顺序优先于稳定文件名排序，元数据来自目录，缺失项有警告', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    await fixture.write('workspace/技术候选/目录.md', candidateIndex(['z.md', 'a.md', 'gone.md']));
    await fixture.write('workspace/技术候选/a.md', '# 文件 a\n| 当前状态 | 文件状态 |\n');
    await fixture.write('workspace/技术候选/z.md', '# 文件 z\n');
    await fixture.write('workspace/技术候选/u.md', '# A 未索引\n');
    await fixture.write('workspace/技术候选/v.md', '# B 未索引\n');
    await fixture.mkdir('workspace/技术候选/目录状.md');
    await fixture.write('workspace/技术候选/ignore.txt', 'not markdown');
    await fixture.mkdir('workspace/架构与设计');
    const { service } = await harness(fixture);
    const result = await operate(service, { action: 'snapshot' });
    assert.deepEqual(result.candidates.map(item => path.basename(item.path)), ['z.md', 'a.md', 'u.md', 'v.md']);
    assert.equal(result.candidates[0].title, '索引标题0');
    assert.equal(result.candidates[0].summary, '摘要0');
    assert.equal(result.candidates[1].status, '已初评');
    assert.equal(result.candidates[1].statusDetail, '文件状态');
    assert.deepEqual(result.candidates.map(item => item.indexed), [true, true, false, false]);
    assert.deepEqual(result.warnings.map(item => [item.code, item.path]), [['INDEX_TARGET_MISSING', '技术候选/gone.md']]);
  });
});

test('parseIndex 拒绝索引路径穿越、外链与坏转义，解码中文文件名', () => {
  const source = [
    '| [中文](<%E4%B8%AD%E6%96%87.md>) | **类型** | `方向` | 状态 | [摘要](<https://example.invalid/>) | 日期 |',
    '| [逃逸](<../escape.md>) | 类型 |',
    '| [编码逃逸](<%2e%2e%2fescape.md>) | 类型 |',
    '| [反斜杠](<..%5cescape.md>) | 类型 |',
    '| [外链](<https://example.invalid/a.md>) | 类型 |',
    '| [坏转义](<%ZZ.md>) | 类型 |',
    '| [普通文件](<a.txt>) | 类型 |',
  ].join('\n');
  const index = parseIndex(source, 'candidates');
  assert.deepEqual([...index.keys()], ['中文.md']);
  assert.deepEqual(index.get('中文.md'), { title: '中文', type: '类型', direction: '方向', status: '状态', summary: '摘要', updated: '日期' });
});

test('parseDocument 保留 CRLF 对应源行，支持文本/Mermaid/波浪围栏，不误收代码或未闭合图', () => {
  const lines = ['# 标题', '', '## 第一图', '```text', 'A → B', '```', '## 第二图', '~~~mermaid', 'graph TD', 'A-->B', '~~~', '```js', 'console.log(1)', '```', '````plaintext', '```', 'still inside', '````', '```text', 'unclosed'];
  const parsed = parseDocument(lines.join('\r\n'), '架构与设计/example.md');
  assert.equal(parsed.title, '标题');
  assert.equal(parsed.lineCount, lines.length);
  assert.deepEqual(parsed.diagrams.map(diagram => [diagram.line, diagram.language, diagram.source]), [
    [5, 'text', 'A → B'], [9, 'mermaid', 'graph TD\nA-->B'], [16, 'plaintext', '```\nstill inside'],
  ]);
  for (const diagram of parsed.diagrams) {
    assert.equal(lines.slice(diagram.line - 1, diagram.line - 1 + diagram.source.split('\n').length).join('\n'), diagram.source);
  }
});

test('空目录是有效工作区；快照不创建资料目录或文档', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    const { service, initialWorkspace } = await harness(fixture);
    const result = await operate(service, { action: 'snapshot' });
    assert.deepEqual(result.counts, { candidates: 0, architecture: 0, diagrams: 0 });
    assert.deepEqual(result.warnings.map(warning => [warning.code, warning.path]), [
      ['MISSING_DIRECTORY', '技术候选'], ['MISSING_DIRECTORY', '架构与设计'],
    ]);
    assert.deepEqual(await readdir(initialWorkspace), []);
    await fixture.mkdir('workspace/技术候选');
    await fixture.mkdir('workspace/架构与设计');
    assert.deepEqual((await operate(service, { action: 'snapshot' })).warnings, []);
  });
});

test('无效目录选择保留内存与已持久化状态，失败后队列仍可工作', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    const { service, unit } = await harness(fixture);
    const before = clone(service.state), persisted = await readFile(unit.filename, 'utf8');
    await fixture.write('not-directory.md', '# not a directory');
    for (const [input, code] of [[undefined, 'INVALID_PATH'], ['', 'INVALID_PATH'], ['relative/path', 'INVALID_PATH'], [fixture.owned('missing'), 'NOT_DIRECTORY'], [fixture.owned('not-directory.md'), 'NOT_DIRECTORY']]) {
      expectError(await service.operate({ action: 'select_workspace', path: input }), code);
      assert.deepEqual(service.state, before);
      assert.equal(await readFile(unit.filename, 'utf8'), persisted);
    }
    const next = await fixture.mkdir('next');
    assert.equal((await operate(service, { action: 'select_workspace', path: `  ${next}  ` })).workspacePath, next);
    assert.equal(unit.writes.length, 2);
  });
});

test('持久化跨实例恢复，最近目录去重且最多八项，重启不覆盖已有选择', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    const first = await harness(fixture);
    const roots = [];
    for (let i = 0; i < 10; i++) roots.push(await fixture.mkdir(`workspace-${i}`));
    for (const root of roots) await operate(first.service, { action: 'select_workspace', path: root });
    await operate(first.service, { action: 'select_workspace', path: roots[8] });
    const expected = [roots[8], roots[9], roots[7], roots[6], roots[5], roots[4], roots[3], roots[2]];
    assert.deepEqual(first.service.state.recent, expected);
    await first.service.close();
    const reopened = await harness(fixture, { initialWorkspace: roots[0] });
    assert.deepEqual(reopened.service.state, { workspacePath: roots[8], recent: expected });
    assert.deepEqual(reopened.unit.writes, []);
  });
});

test('损坏的存储设置拒绝初始化且原字节不被覆盖', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    const contents = JSON.stringify({ workspacePath: 42, recent: ['preserve me'], unknown: 'do not overwrite' });
    await fixture.write('state/settings.json', contents);
    await assert.rejects(harness(fixture), error => error.code === 'INVALID_STATE');
    assert.equal(await readFile(fixture.owned('state/settings.json'), 'utf8'), contents);
  });
});

test('已保存目录消失时给出空快照警告而不替换或写回设置', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    const stale = { workspacePath: fixture.owned('never-created'), recent: [fixture.owned('never-created')] };
    await fixture.write('state/settings.json', JSON.stringify(stale));
    const { service, unit } = await harness(fixture);
    const result = await operate(service, { action: 'snapshot' });
    assert.deepEqual(result.counts, { candidates: 0, architecture: 0, diagrams: 0 });
    assert.equal(result.warnings[0].code, 'NOT_DIRECTORY');
    assert.deepEqual(service.state, stale);
    assert.equal(unit.writes.length, 0);
  });
});

test('路径穿越、绝对路径、反斜杠、NUL、非 Markdown 均在读取前拒绝', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    await fixture.write('outside.md', '# OUTSIDE SECRET');
    const { service, fs } = await harness(fixture);
    for (const input of ['../outside.md', 'x/../../outside.md', '/outside.md', '..\\outside.md', 'bad\0.md', 'file.txt', '.', null, 12]) {
      expectError(await service.operate({ action: 'read_document', path: input }), 'INVALID_DOCUMENT');
    }
    assert.equal(fs.calls.filter(call => call.method === 'readBytes').length, 0);
    await fixture.write('workspace/inside.md', '# inside');
    assert.equal((await operate(service, { action: 'read_document', path: './x/../inside.md' })).path, 'inside.md');
  });
});

test('符号链接文件、目录、索引和前缀相似兄弟目录不能逃逸，内部别名可读', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    await fixture.write('workspace-neighbor/secret.md', '# NEVER READ OUTSIDE');
    await fixture.write('workspace/技术候选/ok.md', '# inside');
    await fixture.link('workspace-neighbor/secret.md', 'workspace/技术候选/escape.md');
    await fixture.link('workspace-neighbor/secret.md', 'workspace/技术候选/目录.md');
    await fixture.link('workspace-neighbor', 'workspace/架构与设计');
    await fixture.link('workspace/技术候选/ok.md', 'workspace/alias.md');
    const { service, fs } = await harness(fixture);
    for (const relative of ['技术候选/escape.md', '技术候选/目录.md', '架构与设计/secret.md']) {
      expectError(await service.operate({ action: 'read_document', path: relative }), 'OUTSIDE_WORKSPACE');
    }
    const snapshot = await operate(service, { action: 'snapshot' });
    assert.deepEqual(snapshot.candidates.map(item => item.path), ['技术候选/ok.md']);
    assert.equal(snapshot.warnings.filter(warning => warning.code === 'OUTSIDE_WORKSPACE').length, 3);
    const original = await fs.resolve('workspace/技术候选/ok.md', { cwd: fixture.root });
    const alias = await fs.resolve('workspace/alias.md', { cwd: fixture.root });
    assert.equal(original.targetKey, alias.targetKey);
    assert.ok(!original.targetKey.includes(fixture.root), 'target identity is not a parseable path');
    assert.equal((await operate(service, { action: 'read_document', path: 'alias.md' })).text, '# inside');
    assert.ok(fs.calls.filter(call => call.method === 'readBytes').every(call => within(fixture.owned('workspace'), call.path)));
  });
});

test('512 KiB 按字节且含上界；UTF-8 中文/emoji 保真，超限、损坏编码和 NUL 拒绝', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    const unicode = '识雨🙂\r\n';
    const exact = Buffer.concat([Buffer.from(unicode), Buffer.alloc(MAX_BYTES - Buffer.byteLength(unicode), 0x61)]);
    await fixture.write('workspace/exact.md', exact);
    await fixture.write('workspace/too-big.md', Buffer.alloc(MAX_BYTES + 1, 0x61));
    await fixture.write('workspace/multibyte-too-big.md', '雨'.repeat(Math.ceil(MAX_BYTES / 3)));
    await fixture.write('workspace/bad-utf8.md', Buffer.from([0xc3, 0x28]));
    await fixture.write('workspace/truncated-utf8.md', Buffer.from([0xf0, 0x9f, 0x99]));
    await fixture.write('workspace/nul.md', Buffer.from('a\0b'));
    const { service, fs } = await harness(fixture);
    const doc = await operate(service, { action: 'read_document', path: 'exact.md' });
    assert.equal(doc.bytes, 512 * 1024);
    assert.equal(doc.text, exact.toString('utf8'));
    for (const name of ['too-big.md', 'multibyte-too-big.md']) {
      expectError(await service.operate({ action: 'read_document', path: name }), 'TOO_LARGE');
      assert.ok(!fs.calls.some(call => call.method === 'readBytes' && call.path.endsWith(`/${name}`)));
    }
    for (const name of ['bad-utf8.md', 'truncated-utf8.md']) {
      const result = await service.operate({ action: 'read_document', path: name });
      assert.equal(result.ok, false, 'malformed UTF-8 must never silently decode to replacement characters');
      assert.ok(result.error.code);
    }
    expectError(await service.operate({ action: 'read_document', path: 'nul.md' }), 'NOT_TEXT');
    assert.ok(fs.calls.filter(call => call.method === 'readBytes').every(call => call.maxBytes === MAX_BYTES));
  });
});

test('文件在 stat 后增长也遵守 Fs.readBytes 上界，不返回截断数据', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    const target = await fixture.write('workspace/growing.md', '# small');
    let grown = false;
    const fs = new ReadOnlyFsAdapter([fixture.root], async (method, input) => {
      if (method === 'readBytes' && input === target && !grown) {
        grown = true;
        await fixture.write('workspace/growing.md', Buffer.alloc(MAX_BYTES + 1, 0x61));
      }
    });
    const { service } = await harness(fixture, { fs });
    expectError(await service.operate({ action: 'read_document', path: 'growing.md' }), 'FS_TOO_LARGE');
  });
});

test('扫描错误隔离至单文档，合法文档继续展示', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    await fixture.write('workspace/技术候选/good.md', '# good');
    await fixture.write('workspace/技术候选/large.md', Buffer.alloc(MAX_BYTES + 1));
    await fixture.write('workspace/技术候选/binary.md', Buffer.from([0, 1, 2]));
    await fixture.write('workspace/技术候选/bad-utf8.md', Buffer.from([0xff]));
    await fixture.mkdir('workspace/架构与设计');
    const { service } = await harness(fixture);
    const result = await operate(service, { action: 'snapshot' });
    assert.deepEqual(result.candidates.map(item => item.path), ['技术候选/good.md']);
    assert.equal(result.warnings.length, 3);
    assert.equal(result.warnings.find(warning => warning.path.endsWith('large.md')).code, 'TOO_LARGE');
    assert.equal(result.warnings.find(warning => warning.path.endsWith('binary.md')).code, 'NOT_TEXT');
  });
});

test('扫描最多 MAX_FILES 份文档且报告上限', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    for (let i = 0; i < MAX_FILES + 2; i++) await fixture.write(`workspace/技术候选/${String(i).padStart(3, '0')}.md`, `# ${i}`);
    await fixture.mkdir('workspace/架构与设计');
    const { service } = await harness(fixture);
    const result = await operate(service, { action: 'snapshot' });
    assert.equal(result.counts.candidates, MAX_FILES);
    assert.equal(result.warnings.filter(warning => warning.code === 'FILE_LIMIT').length, 1);
  });
});

test('同 service 的 Tool 与 HTTP 入口：读取、快照、选择、过期/非法/路径/编码错误一致', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    await fixture.write('workspace/readme.md', '# 中文🙂\n```text\nA → B\n```');
    await fixture.write('workspace/binary.md', Buffer.from([0]));
    await fixture.write('workspace/bad-utf8.md', Buffer.from([0xff]));
    await fixture.write('workspace/large.md', Buffer.alloc(MAX_BYTES + 1));
    await fixture.mkdir('workspace/not-file.md');
    await fixture.write('outside.md', '# never read');
    await fixture.link('outside.md', 'workspace/escape.md');
    const { service, initialWorkspace } = await harness(fixture);
    const tool = toolDefinition(service);
    assert.equal(tool.isConcurrencySafe({ action: 'snapshot' }), true);
    assert.equal(tool.isConcurrencySafe({ action: 'read_document' }), true);
    assert.equal(tool.isConcurrencySafe({ action: 'select_workspace' }), false);
    await throughBoth(service, { action: 'read_document', path: 'readme.md', workspacePath: initialWorkspace });
    await throughBoth(service, { action: 'snapshot' });
    for (const [input, code] of [
      [null, 'INVALID_REQUEST'], [[], 'INVALID_REQUEST'], [{ action: 'unknown' }, 'INVALID_ACTION'],
      [{ action: 'select_workspace', path: 'relative' }, 'INVALID_PATH'],
      [{ action: 'select_workspace', path: fixture.owned('missing') }, 'NOT_DIRECTORY'],
      [{ action: 'read_document', path: '../outside.md' }, 'INVALID_DOCUMENT'],
      [{ action: 'read_document', path: 'escape.md' }, 'OUTSIDE_WORKSPACE'],
      [{ action: 'read_document', path: 'missing.md' }, 'NOT_FILE'],
      [{ action: 'read_document', path: 'not-file.md' }, 'NOT_FILE'],
      [{ action: 'read_document', path: 'binary.md' }, 'NOT_TEXT'],
      [{ action: 'read_document', path: 'large.md' }, 'TOO_LARGE'],
      [{ action: 'read_document', path: 'readme.md', workspacePath: fixture.owned('other') }, 'WORKSPACE_CHANGED'],
    ]) expectError(await throughBoth(service, input), code);
    assert.equal((await throughBoth(service, { action: 'read_document', path: 'bad-utf8.md' })).ok, false);
    const next = await fixture.mkdir('next');
    assert.equal((await throughBoth(service, { action: 'select_workspace', path: next })).data.workspacePath, next);
    await throughBoth(service, { action: 'snapshot' });
    expectError(await throughBoth(service, { action: 'read_document', path: 'readme.md', workspacePath: initialWorkspace }), 'WORKSPACE_CHANGED');
    await service.close();
    expectError(await throughBoth(service, { action: 'snapshot' }), 'CLOSED');
  });
});

test('HTTP 层的媒体类型、JSON、请求长度错误不调用业务 Service', TEST_OPTIONS, async () => {
  let calls = 0;
  const service = { operate() { calls++; throw new Error('must not be reached'); } };
  for (const [headers, body, status, code] of [
    [{ 'content-type': 'text/plain' }, '{}', 415, 'CONTENT_TYPE'],
    [{ 'content-type': 'application/json' }, '{', 400, 'INVALID_JSON'],
    [{ 'content-type': 'application/json' }, ' '.repeat(8193), 413, 'TOO_LARGE'],
  ]) {
    const response = await serveRequest(service, new Request('http://test.invalid/', { method: 'POST', headers, body }));
    assert.equal(response.status, status);
    expectError(await response.json(), code);
  }
  assert.equal(calls, 0);
});

test('并发目录选择串行持久化；未提交时快照保持旧状态，两入口共享同一队列', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    const { service, unit, initialWorkspace } = await harness(fixture);
    const one = await fixture.mkdir('one'), two = await fixture.mkdir('two');
    const entered = deferred(), release = deferred();
    unit.beforeSet = async value => {
      if (value.workspacePath === one) { entered.resolve(); await release.promise; }
    };
    const first = toolDefinition(service).execute({ action: 'select_workspace', path: one }, { signal: new AbortController().signal });
    await entered.promise;
    const second = serveRequest(service, new Request('http://test.invalid/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'select_workspace', path: two }) }));
    try {
      const snapshot = await operate(service, { action: 'snapshot' });
      assert.equal(snapshot.workspacePath, initialWorkspace);
      assert.deepEqual(snapshot.recent, [initialWorkspace]);
      snapshot.recent.push('caller-owned-copy');
      assert.deepEqual(service.state.recent, [initialWorkspace]);
      assert.equal(unit.activeWrites, 1);
      assert.deepEqual(JSON.parse(await readFile(unit.filename, 'utf8')), service.state);
    } finally { release.resolve(); }
    const [firstResult, secondResponse] = await Promise.all([first, second]);
    assert.equal(firstResult.ok, true);
    assert.equal((await secondResponse.json()).ok, true);
    assert.deepEqual(service.state, { workspacePath: two, recent: [two, one, initialWorkspace] });
    assert.deepEqual(unit.writes.map(value => value.workspacePath), [initialWorkspace, one, two]);
    assert.equal(unit.maxActiveWrites, 1);
    assert.deepEqual(JSON.parse(await readFile(unit.filename, 'utf8')), service.state);
  });
});

test('持久化失败不改变当前状态，排队的下一次选择仍成功', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    const { service, unit } = await harness(fixture);
    const before = clone(service.state), persisted = await readFile(unit.filename, 'utf8');
    const one = await fixture.mkdir('one'), two = await fixture.mkdir('two');
    unit.beforeSet = async value => {
      if (value.workspacePath === one) throw coded('STORAGE_FAILURE', 'simulated fixture-only storage failure');
    };
    expectError(await service.operate({ action: 'select_workspace', path: one }), 'STORAGE_FAILURE');
    assert.deepEqual(service.state, before);
    assert.equal(await readFile(unit.filename, 'utf8'), persisted);
    const results = await Promise.all([
      service.operate({ action: 'select_workspace', path: one }),
      service.operate({ action: 'select_workspace', path: two }),
    ]);
    expectError(results[0], 'STORAGE_FAILURE');
    assert.equal(results[1].ok, true);
    assert.deepEqual(service.state.recent, [two, before.workspacePath]);
  });
});

test('快照与读取固定开始时的工作区，不把并发切换后的文件混进旧结果', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    const old = await fixture.write('workspace/技术候选/same.md', '# OLD');
    await fixture.mkdir('workspace/架构与设计');
    await fixture.write('new/技术候选/same.md', '# NEW');
    await fixture.mkdir('new/架构与设计');
    const entered = deferred(), release = deferred();
    let armed = false, blocked = false;
    const fs = new ReadOnlyFsAdapter([fixture.root], async (method, target) => {
      if (armed && !blocked && method === 'readBytes' && target === old) {
        blocked = true; entered.resolve(); await release.promise;
      }
    });
    const { service, initialWorkspace } = await harness(fixture, { fs });
    armed = true;
    const scanning = service.operate({ action: 'snapshot' });
    await entered.promise;
    try { await operate(service, { action: 'select_workspace', path: fixture.owned('new') }); }
    finally { release.resolve(); }
    const result = await scanning;
    assert.equal(result.ok, true);
    assert.equal(result.data.workspacePath, initialWorkspace);
    assert.equal(result.data.candidates[0].title, 'OLD');
    expectError(await service.operate({ action: 'read_document', path: '技术候选/same.md', workspacePath: initialWorkspace }), 'WORKSPACE_CHANGED');
    assert.equal((await operate(service, { action: 'read_document', path: '技术候选/same.md' })).text, '# NEW');
  });
});

test('排队时已取消的选择不会写入，close 等待已经提交中的保存并拒绝新请求', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    const { service, unit, initialWorkspace } = await harness(fixture);
    const one = await fixture.mkdir('one'), two = await fixture.mkdir('two');
    const entered = deferred(), release = deferred();
    unit.beforeSet = async value => {
      if (value.workspacePath === one) { entered.resolve(); await release.promise; }
    };
    const first = service.operate({ action: 'select_workspace', path: one });
    await entered.promise;
    const cancellation = new AbortController();
    const cancelled = service.operate({ action: 'select_workspace', path: two }, cancellation.signal);
    cancellation.abort(coded('ABORTED', 'test cancellation'));
    const closing = service.close();
    try {
      assert.equal(unit.closed, false);
      expectError(await service.operate({ action: 'snapshot' }), 'CLOSED');
    } finally { release.resolve(); }
    const [firstResult, cancelledResult] = await Promise.all([first, cancelled]);
    assert.equal(firstResult.ok, true);
    expectError(cancelledResult, 'ABORTED');
    await closing;
    assert.equal(unit.closed, true);
    assert.deepEqual(unit.writes.map(value => value.workspacePath), [initialWorkspace, one]);
  });
});

// Regression: an in-process tool caller must not gain a live reference to the
// service's recent array; otherwise it can bypass validation and persistence.
test('选择结果的 recent 数组不能被调用者用来修改 Service 的内部状态', TEST_OPTIONS, async () => {
  await withFixture(async fixture => {
    const { service, unit, initialWorkspace } = await harness(fixture);
    const next = await fixture.mkdir('next');
    const result = await toolDefinition(service).execute({ action: 'select_workspace', path: next }, { signal: new AbortController().signal });
    assert.equal(result.ok, true);
    const expected = { workspacePath: next, recent: [next, initialWorkspace] };
    result.data.recent.push('unvalidated caller mutation');
    assert.deepEqual(service.state, expected, 'returned state must be a detached value, not a live mutable reference');
    assert.deepEqual(JSON.parse(await readFile(unit.filename, 'utf8')), expected);
  });
});
