#!/usr/bin/env node
/**
 * H1 independent verification runner + report generator.
 *
 * Usage (from plugins/shiyu):
 *   node --import tsx tests/verify/report.mjs [--label <text>] [--no-run]
 *
 * Runs every tests/verify/*.test.ts with its own evidence directory, then merges
 * the node:test TAP outcome with the structured per-case evidence records into:
 *   artifacts/dsh/verify/runs/<runId>/manifest.json
 *   artifacts/dsh/verify/runs/<runId>/results.json
 *   artifacts/dsh/verify/runs/<runId>/results.md
 *   artifacts/dsh/verify/latest.json / latest.md (copy of the newest run)
 *
 * A TAP-green test without a recorded case is reported as "unreported" and is
 * never counted as a pass; blocked/unobservable cases are kept in their own
 * denominator. The script does not modify product source.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '../..');
const homeDirectory = process.env.HOME ?? '';
const HOME_TOKEN = '<home>';
/** Redact the local home directory from emitted evidence (public repo hygiene). */
function sanitizeText(text) {
  if (!homeDirectory) return text;
  return String(text).split(homeDirectory).join(HOME_TOKEN);
}
function sanitizeValue(value) {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item)]));
  return value;
}
const relativeToPackage = path => (path.startsWith(packageRoot) ? path.slice(packageRoot.length + 1) : sanitizeText(path));
const verifyDir = join(packageRoot, 'tests/verify');
const artifactsRoot = join(packageRoot, 'artifacts/dsh/verify');
const files = readdirSync(verifyDir).filter(name => name.endsWith('.test.ts')).sort();
if (!files.length) { console.error('no tests/verify/*.test.ts found'); process.exit(2); }
const args = process.argv.slice(2);
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : undefined;
const noRun = args.includes('--no-run');

const now = new Date();
const runId = `${now.toISOString().replace(/[:.]/g, '-')}${label ? `-${label.replace(/[^A-Za-z0-9._-]/g, '_')}` : ''}`;
const runDir = join(artifactsRoot, 'runs', runId);
const rawDir = join(runDir, 'raw');
mkdirSync(rawDir, { recursive: true });

function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function git(...gitArgs) {
  const result = spawnSync('git', ['-C', resolve(packageRoot, '../..'), ...gitArgs], { encoding: 'utf8' });
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: packageRoot, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...options });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// Manifest: frozen inputs of this verification run.
// ---------------------------------------------------------------------------
const productFiles = [
  'src/adapters/dsh/native-context.ts',
  'src/adapters/dsh/native-message.ts',
  'src/adapters/dsh/session-title.ts',
  'src/adapters/dsh/sessions.ts',
  'src/adapters/dsh/goals.ts',
  'src/adapters/dsh/core-decision.ts',
];
const sdkPackages = [
  'dsh-session/lib/index.js',
  'dsh-session-persistence/lib/index.js',
  'dsh-session-persistence-jsonl/lib/index.js',
  'dsh-session-projection/lib/index.js',
  'dsh-agent-loop/lib/index.js',
  'dsh-session-title/lib/index.js',
  'dsh-goal/lib/index.js',
];
const sdkHashes = sdkPackages.map(name => {
  const result = run('node', ['scripts/read-dsh-asar.mjs', 'hash', `dsh/node_modules/@deepseek-ai/${name}`]);
  const [hash, bytes] = result.stdout.trim().split('\t');
  return { package: name, sha256: hash, bytes: Number(bytes), ok: result.status === 0 };
});
// Static suite-integrity scan: the judge support must not reuse product parsing
// code, and the suite must not contain skips/tautologies that could hide a fail.
const supportDir = join(verifyDir, 'support');
const supportFiles = readdirSync(supportDir).filter(name => name.endsWith('.ts'));
const judgeSource = readFileSync(join(supportDir, 'independent.ts'), 'utf8');
const productImportPattern = /from\s+['"][^'"]*src\/adapters\/dsh\//;
const judgeImportsProduct = productImportPattern.test(judgeSource) || /from\s+['"][^'"]*src\//.test(judgeSource);
const testSources = Object.fromEntries(files.map(file => [file, readFileSync(join(verifyDir, file), 'utf8')]));
const antiPatterns = {
  skip: Object.values(testSources).join('\n').match(/\.(skip|todo)\s*\(/g) ?? [],
  only: Object.values(testSources).join('\n').match(/\.only\s*\(/g) ?? [],
  tautology: Object.values(testSources).join('\n').match(/assert\.ok\(true\)/g) ?? [],
  unconditionalPass: Object.values(testSources).join('\n').match(/c\.pass\([^)]*\)\s*;\s*return\s*;\s*\/\/\s*skip/g) ?? [],
};
const casesPerFile = Object.fromEntries(files.map(file => [file, (testSources[file].match(/verifyCase\(/g) ?? []).length]));
const integrity = {
  judgeImportsProduct,
  judgeSupportFiles: supportFiles,
  antiPatterns,
  casesRecordedPerTestFile: casesPerFile,
  everyTestFileHasEvidence: Object.values(casesPerFile).every(count => count > 0),
};
const gitHead = git('rev-parse', 'HEAD').stdout;
const gitBranch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout;
const gitStatus = git('status', '--porcelain', '--', 'plugins/shiyu/src', 'plugins/shiyu/tests/verify').stdout.split('\n').filter(Boolean);
const manifest = {
  runId,
  label,
  startedAt: now.toISOString(),
  command: 'node --import tsx --test --test-concurrency=1 --test-reporter=tap tests/verify/*.test.ts',
  environment: {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    workingDirectory: sanitizeText(packageRoot),
    harnessAsar: process.env.DSH_ASAR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  },
  git: { head: gitHead, branch: gitBranch, dirtyPaths: gitStatus },
  product: Object.fromEntries(productFiles.map(file => [file, existsSync(join(packageRoot, file)) ? { sha256: sha256File(join(packageRoot, file)), bytes: readFileSync(join(packageRoot, file)).length } : { missing: true }])),
  sdk: sdkHashes,
  tests: Object.fromEntries(files.map(file => [file, { sha256: sha256File(join(verifyDir, file)), bytes: readFileSync(join(verifyDir, file)).length }])),
  suite: (() => {
    const entries = {};
    const walk = directory => {
      for (const name of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, name.name);
        if (name.isDirectory()) { walk(path); continue; }
        if (!name.isFile()) continue;
        entries[path.slice(verifyDir.length + 1).split('\\').join('/')] = { sha256: sha256File(path), bytes: readFileSync(path).length };
      }
    };
    walk(verifyDir);
    return entries;
  })(),
  isolation: 'synthetic in-memory native host; no real DSH host, model, embedding, channel or user data is read or written',
  homePathRedaction: `${HOME_TOKEN} replaces the local home directory; artifact-internal paths are relative to the package root`,
  independence: 'expectations derived from 架构与设计/DSH交接 00-03 + frozen SDK 0.2.1-rc.5 static source; the judge does not import product parsers/hash helpers; see 00-oracle-selftest.test.ts for the judge self-verification',
  integrity,
};
// (manifest is written after the run so duration/exitStatus are frozen with it)

// ---------------------------------------------------------------------------
// Execute the suite (unless --no-run regenerates from an existing raw dir).
// ---------------------------------------------------------------------------
let tap = '';
if (!noRun) {
  console.log(`[report] run ${runId}: ${files.length} files`);
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', ...files.map(file => join('tests/verify', file))], {
    cwd: packageRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, VERIFY_RUN_DIR: rawDir, VERIFY_RUN_ID: runId },
  });
  tap = result.stdout ?? '';
  writeFileSync(join(runDir, 'tap.txt'), sanitizeText(`${tap}\n[stderr]\n${result.stderr ?? ''}`));
  if (existsSync(rawDir)) for (const file of readdirSync(rawDir)) {
    if (!file.endsWith('.jsonl')) continue;
    const rawPath = join(rawDir, file);
    writeFileSync(rawPath, sanitizeText(readFileSync(rawPath, 'utf8')));
  }
  manifest.durationMs = Date.now() - started;
  manifest.exitStatus = result.status;
  console.log(`[report] suite exit=${result.status} duration=${Math.round(manifest.durationMs / 1000)}s`);
} else {
  tap = readFileSync(join(runDir, 'tap.txt'), 'utf8').split('\n[stderr]')[0];
}

// ---------------------------------------------------------------------------
// Parse the TAP outcome.
// ---------------------------------------------------------------------------
const tests = [];
const tapFailures = [];
for (const line of tap.split('\n')) {
  const match = /^(not ok|ok) (\d+) - (.+?)(?: # (SKIP|TODO).*)?$/.exec(line);
  if (!match) continue;
  const test = { ok: match[1] === 'ok', number: Number(match[2]), title: match[3].trim(), skip: match[4] ?? null };
  tests.push(test);
  if (!test.ok) tapFailures.push(test);
}

// ---------------------------------------------------------------------------
// Load structured evidence.
// ---------------------------------------------------------------------------
const evidence = [];
const rawFiles = existsSync(rawDir) ? readdirSync(rawDir).filter(name => name.endsWith('.jsonl')) : [];
for (const file of rawFiles) {
  for (const line of readFileSync(join(rawDir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { evidence.push(JSON.parse(line)); } catch { /* a torn record is reported below */ }
  }
}
evidence.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
manifest.integrity.evidenceFiles = rawFiles.length;
manifest.integrity.evidenceRecords = evidence.length;

/** IDs mentioned by a TAP test title (including simple ranges such as I23-I25 / S03-S06). */
function titleIds(title) {
  const ids = new Set();
  for (const match of title.matchAll(/([A-Z]{1,2}\d+)(?:-([A-Z]{1,2})(\d+))?[a-z]?/g)) {
    ids.add(match[1]);
    if (match[2]) {
      const prefix = match[2];
      const digits = match[1].replace(/^[A-Z]+/, '');
      const start = Number(digits);
      const end = Number(match[3]);
      const pad = value => String(value).padStart(digits.length, '0');
      for (let value = start; value <= end; value++) ids.add(`${prefix}${pad(value)}`);
    }
  }
  return ids;
}
function evidenceForTitle(title) {
  const ids = [...titleIds(title)];
  return evidence.filter(record => ids.some(id => record.id === id || record.id.startsWith(id)));
}

// ---------------------------------------------------------------------------
// Judgement: a test is only a pass when TAP is green AND every associated
// evidence record is a pass. Blocked/unobservable are separate outcomes.
// ---------------------------------------------------------------------------
const testResults = tests.map(test => {
  const records = evidenceForTitle(test.title);
  const verdicts = records.map(record => record.verdict);
  let status;
  if (!test.ok) status = 'fail';
  else if (!records.length) status = 'unreported';
  else if (verdicts.includes('fail')) status = 'fail';
  else if (verdicts.every(verdict => verdict === 'pass')) status = 'pass';
  else if (verdicts.some(verdict => verdict === 'blocked')) status = 'blocked';
  else status = 'unobservable';
  return { ...test, evidenceIds: records.map(record => record.id), status };
});

const attributed = new Set(testResults.flatMap(result => result.evidenceIds));
const unattributedEvidence = evidence.filter(record => !attributed.has(record.id));
const unreportedTests = testResults.filter(result => result.status === 'unreported');
const failedTests = testResults.filter(result => result.status === 'fail');
const blockedTests = testResults.filter(result => result.status === 'blocked');
const unobservableTests = testResults.filter(result => result.status === 'unobservable');

const categoryOf = id => /^CO/.test(id) ? 'CO core business path' : /^RP/.test(id) ? 'RP replyer business path'
  : /^LO/.test(id) ? 'LO load-only business path' : /^C/.test(id) ? 'C judge self-verification'
    : /^L/.test(id) ? 'L legal long history' : /^I/.test(id) ? 'I invalid history/backend'
      : /^R/.test(id) ? 'R races/cancellation/limits' : /^B/.test(id) ? 'B declared capacity bounds'
        : /^S/.test(id) ? 'S recovery continuity' : 'other';
const categories = [...new Set(evidence.map(record => categoryOf(record.id)))].sort();
const categorySummary = categories.map(category => {
  const records = evidence.filter(record => categoryOf(record.id) === category);
  const count = verdict => records.filter(record => record.verdict === verdict).length;
  return {
    category,
    cases: records.length,
    pass: count('pass'), fail: count('fail'), blocked: count('blocked'), unobservable: count('unobservable'),
    issueIds: records.filter(record => record.verdict !== 'pass').map(record => record.id),
  };
});
const totalOf = key => categorySummary.reduce((sum, category) => sum + category[key], 0);
const summary = {
  categories: categories.length,
  cases: evidence.length,
  pass: totalOf('pass'), fail: totalOf('fail'), blocked: totalOf('blocked'), unobservable: totalOf('unobservable'),
  unreportedTests: unreportedTests.map(result => result.title),
  unattributedEvidence: unattributedEvidence.map(record => record.id),
  tap: {
    total: tests.length,
    pass: testResults.filter(result => result.status === 'pass').length,
    fail: failedTests.length,
    blocked: blockedTests.length,
    unobservable: unobservableTests.length,
    unreported: unreportedTests.length,
    skip: testResults.filter(result => result.skip === 'SKIP').length,
  },
};

// Coverage matrix: 03 §5 rows -> case ids present in this run.
const coverageMatrix = [
  { requirement: '03 §5 row1: 空史/2048±/远超一页/页间inbox插入移除/继承seed 恢复正确官方投影，同业务 Session 身份保留，不能只证明超限拒绝', cases: ['L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08', 'L09', 'L10', 'L11', 'L12', 'L13', 'R02', 'R03', 'S17', 'LO02', 'LO08', 'RP02', 'RP06', 'CO01'] },
  { requirement: '03 §5 row2: 短页合法继续；缺号/重复乱序/页超量/坏header/preset/继承/−0 失效无接受回执、资源释放', cases: ['L06', 'L12', 'I01', 'I02a', 'I02b', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I09', 'I10', 'I11', 'I12', 'I13', 'I14', 'I15', 'I16', 'I17', 'I18', 'I19', 'I20', 'I21', 'I22', 'I23', 'I24', 'I25', 'I26', 'I27'] },
  { requirement: '03 §5 row3: 读取中/EOF后/投影中追加；同长度早段变化、缩短 被检测或按受信规则重取，不默默拼混合历史', cases: ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'S07'] },
  { requirement: '03 §5 row4: 原生合法中断收尾/end-seed/固定标题与异源 user 混入；合法恢复成功、未知输入不被丢/自动执行', cases: ['S02', 'S12', 'S03', 'S04', 'S05', 'S06', 'S14', 'RP08'] },
  { requirement: '03 §5 row5: 授权await、onDispatch await、冷读后 live.seq/inbox 变化 → 最终接纳门拒绝失效基准，不产生错误 context receipt/草稿资格', cases: ['LO03', 'LO04', 'LO07', 'LO09', 'RP03', 'RP04', 'CO02', 'CO03', 'S13', 'S16'] },
  { requirement: '03 §5 row6: 取消、期限、读/投影/关闭失败、关闭后迟到 → handle/agent 生命周期可核对，无静默新 Session/重试未知效果，不泄漏正文', cases: ['I21', 'I22', 'R08', 'R09', 'R10', 'LO07', 'LO09'] },
  { requirement: '03 §5 row7: load-only、replyer、Core 各自正常长史路径；精确本次原生消息+flush+独立回读才给 receipt；生成路径在明确预算下推进', cases: ['LO01', 'LO10', 'LO02', 'LO08', 'RP01', 'RP02', 'RP05', 'RP06', 'CO01'] },
  { requirement: '02 §3.2 / 03 §5 row8: 判定器自证（应过/应拒样本），测试/替身/SDK静态分别留证不互相冒充', cases: ['C00a', 'C00b', 'C00c', 'C00d', 'C00e', 'B00', 'S00', 'S18'] },
];
const coverage = coverageMatrix.map(row => {
  const present = row.cases.filter(id => evidence.some(record => record.id === id || record.id.startsWith(id)));
  const missing = row.cases.filter(id => !present.includes(id));
  const failed = present.filter(id => evidence.some(record => (record.id === id || record.id.startsWith(id)) && record.verdict === 'fail'));
  const incomplete = present.filter(id => evidence.some(record => (record.id === id || record.id.startsWith(id)) && (record.verdict === 'blocked' || record.verdict === 'unobservable')));
  return { requirement: row.requirement, planned: row.cases.length, present: present.length, failed, incomplete, missing,
    status: missing.length ? 'incomplete-coverage' : failed.length ? 'fail' : incomplete.length ? 'partial' : 'covered' };
});

// ---------------------------------------------------------------------------
// Reports.
// ---------------------------------------------------------------------------
manifest.finishedAt = new Date().toISOString();
writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify(sanitizeValue(manifest), null, 2)}\n`);

const notCovered = [
  { target: '真实 DSH 宿主上的长历史冷恢复/恢复（真实 JSONL、projection、agent resume；零模型）', reason: '本套件为合成原生替身+固定 SDK 静态契约层，不执行真实宿主', required: 'Lead 冻结的 G3/V24 零模型重载/隔离根验证' },
  { target: '真实模型生成、标题/压缩旁路、provider 内部重试与计费/缓存完整性', reason: '不调用模型或网络', required: '有界真实模型批次与独立观测器；压缩单独评估' },
  { target: '原生压缩/检查点之后的恢复', reason: 'H1 实现尚未接线压缩', required: 'H1 后续切片（03 §2 明确为长期目标）' },
  { target: '跨进程或任意外部写者条件下的原子快照', reason: '固定 SDK 是 append-only 合同而非原子快照（03 §3 已声明边界）', required: '不承诺；按观察/使用边界留证' },
  { target: '真实后端内存/IO 成本与资源上界、长期运行稳定性', reason: '替身不提供真实解码/存储成本', required: '宿主性能与长期运行测试' },
  { target: '真实频道、设备、备份与恢复（H2+、V21/V22/V26/V27）', reason: '资源与授权范围之外', required: '后续切片' },
];
const results = {
  runId, label, startedAt: manifest.startedAt, durationMs: manifest.durationMs, exitStatus: manifest.exitStatus,
  summary, categories: categorySummary, tests: testResults, tapFailures, evidence, coverage, integrity, notCovered,
  manifestPath: relativeToPackage(join(runDir, 'manifest.json')), rawEvidenceDir: relativeToPackage(rawDir),
};
writeFileSync(join(runDir, 'results.json'), `${JSON.stringify(sanitizeValue(results), null, 2)}\n`);

function table(rows, columns) {
  const header = `| ${columns.map(column => column.title).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  return [header, divider, ...rows.map(row => `| ${columns.map(column => String(column.value(row)).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`)].join('\n');
}
function truncate(value, length = 220) { const text = String(value ?? ''); return text.length > length ? `${text.slice(0, length)}…` : text; }

const md = [];
md.push(`# H1 独立验证结果：${runId}`);
md.push('');
md.push(`- 运行命令：\`${manifest.command}\``);
md.push(`- 运行时间：${manifest.startedAt}${manifest.durationMs ? `，耗时 ${(manifest.durationMs / 1000).toFixed(1)}s` : ''}；退出码：${String(manifest.exitStatus)}`);
md.push(`- 环境：Node ${manifest.environment.node}，${manifest.environment.platform}；工作目录 \`${manifest.environment.workingDirectory}\``);
md.push(`- 产品源码指纹：HEAD ${manifest.git.head.slice(0, 12)}（分支 ${manifest.git.branch}），本切片 6 个适配文件 + 测试文件 SHA256 记录在 [manifest.json](manifest.json)`);
md.push(`- 固定 SDK：DSH app.asar 内 7 个 0.2.1-rc.5 包的只读 SHA256 已记录（见 manifest.json）；本运行未连接真实宿主、模型、embedding、频道或用户数据。`);
md.push('');
md.push('## 1. 判定口径');
md.push('');
md.push('- **通过**：TAP 绿 + 该测试关联的每条结构化证据记录均为 `pass`；两者缺一不可。');
md.push('- **失败**：观察到违反预期，或 TAP 红。');
md.push('- **blocked / unobservable**：接口/能力/可观测性不具备，单独分母，**不计通过**；TAP 绿但无证据记录记为 `unreported`，同样不计通过。');
md.push('');
md.push('## 2. 汇总（分母齐全）');
md.push('');
md.push(table(categorySummary, [
  { title: '类别', value: row => row.category },
  { title: '用例数', value: row => row.cases },
  { title: '通过', value: row => row.pass },
  { title: '失败', value: row => row.fail },
  { title: 'blocked', value: row => row.blocked },
  { title: 'unobservable', value: row => row.unobservable },
  { title: '非通过用例', value: row => row.issueIds.join(', ') || '—' },
]));
md.push('');
md.push(`**总计：${summary.cases} 条用例记录 = 通过 ${summary.pass} / 失败 ${summary.fail} / blocked ${summary.blocked} / unobservable ${summary.unobservable}。** TAP 测试级：${summary.tap.total} 个测试 = 通过 ${summary.tap.pass} / 失败 ${summary.tap.fail} / blocked ${summary.tap.blocked} / unobservable ${summary.tap.unobservable} / unreported ${summary.tap.unreported} / skip ${summary.tap.skip}。`);
md.push('');
md.push('## 3. 03 §5 场景覆盖矩阵');
md.push('');
md.push(table(coverage, [
  { title: '规范要求', value: row => row.requirement },
  { title: '计划', value: row => row.planned },
  { title: '本次有记录', value: row => row.present },
  { title: '失败', value: row => row.failed.join(', ') || '—' },
  { title: '不完整', value: row => row.incomplete.join(', ') || '—' },
  { title: '缺失', value: row => row.missing.join(', ') || '—' },
  { title: '状态', value: row => row.status },
]));
md.push('');
md.push('## 4. 判定器与套件完整性静态检查');
md.push('');
md.push(table([
  { item: '判定器 support/independent.ts 是否 import 产品源码', value: integrity.judgeImportsProduct ? '**是（失败：失去独立性）**' : '否' },
  { item: '测试中的 .skip/.todo 调用', value: integrity.antiPatterns.skip.length },
  { item: '测试中的 .only 调用', value: integrity.antiPatterns.only.length },
  { item: 'assert.ok(true) 恒真断言', value: integrity.antiPatterns.tautology.length },
  { item: '每个测试文件是否都写结构化证据', value: integrity.everyTestFileHasEvidence ? '是' : '**否（unreported 风险）**' },
  { item: '逐文件 verifyCase 记录数', value: JSON.stringify(integrity.casesRecordedPerTestFile) },
  { item: '判定器自证（C00*）', value: 'C00a–C00f：手工应过/应拒样本 + 1 正确/3 故障突变体端到端突变测试' },
], [
  { title: '检查项', value: row => row.item }, { title: '结果', value: row => String(row.value) },
]));
md.push('');
md.push('## 5. Issue 清单');
md.push('');
const issues = [];
for (const record of evidence.filter(record => record.verdict === 'fail')) issues.push({ id: record.id, severity: 'fail', title: record.title, detail: record.actual, expectation: record.expectation });
for (const test of failedTests.filter(test => !evidence.some(record => record.verdict === 'fail' && test.evidenceIds.includes(record.id)))) issues.push({ id: `TAP:${test.number}`, severity: 'fail', title: test.title, detail: 'TAP failed without a structured evidence failure record', expectation: 'n/a' });
for (const record of evidence.filter(record => record.verdict === 'blocked')) issues.push({ id: record.id, severity: 'blocked', title: record.title, detail: record.actual, expectation: record.expectation });
for (const record of evidence.filter(record => record.verdict === 'unobservable')) issues.push({ id: record.id, severity: 'unobservable', title: record.title, detail: record.actual, expectation: record.expectation });
if (issues.length === 0) md.push('本运行未发现失败用例，也没有 blocked/unobservable 用例。');
else md.push(table(issues, [
  { title: 'ID', value: row => row.id }, { title: '级别', value: row => row.severity }, { title: '标题', value: row => row.title },
  { title: '预期', value: row => truncate(row.expectation) }, { title: '实际', value: row => truncate(row.detail) },
]));
if (unattributedEvidence.length) {
  md.push('');
  md.push(`**未被测试标题认领的证据记录（需人工核对）：** ${unattributedEvidence.map(record => record.id).join(', ')}`);
}
md.push('');
md.push('## 6. 逐例结果');
md.push('');
md.push(table(evidence, [
  { title: 'ID', value: row => row.id }, { title: '判定', value: row => row.verdict }, { title: '预期', value: row => truncate(row.expectation, 160) },
  { title: '实际', value: row => truncate(row.actual, 220) }, { title: '规范来源', value: row => row.spec.join(' ') },
]));
md.push('');
md.push('## 7. 未覆盖行为目标（分层留证，不是失败）');
md.push('');
md.push(table(results.notCovered, [
  { title: '未覆盖行为目标', value: row => row.target },
  { title: '原因', value: row => row.reason },
  { title: '需要的后续证据', value: row => row.required },
]));
md.push('');
md.push('**证据边界：** 本验证为离线合成替身 + 固定 SDK 静态契约层。它证明适配逻辑在合成原生语义下的行为；不替代上表真实宿主/模型/压缩/长期运行验收（03 §5 最后一行要求分层留证，不得互相冒充）。');
md.push('');
md.push('## 8. 运行级证据');
md.push('');
md.push(`- 结构化逐例证据（JSONL，每进程一个文件）：\`${relativeToPackage(rawDir)}\``);
md.push(`- TAP 原始输出：\`${relativeToPackage(join(runDir, 'tap.txt'))}\``);
md.push(`- 冻结清单：\`${relativeToPackage(join(runDir, 'manifest.json'))}\``);
md.push(`- 本报告：\`${relativeToPackage(join(runDir, 'results.md'))}\` 与 \`${relativeToPackage(join(runDir, 'results.json'))}\``);
md.push('');
md.push('**证据边界：** 本验证为离线合成替身 + 固定 SDK 静态契约层。它证明适配逻辑在合成原生语义下的行为；不替代真实宿主/模型/压缩/长对话验收（03 §5 最后一行要求分层留证，不得互相冒充）。');
const mdText = sanitizeText(`${md.join('\n')}\n`);
writeFileSync(join(runDir, 'results.md'), mdText);

mkdirSync(artifactsRoot, { recursive: true });
writeFileSync(join(artifactsRoot, 'latest.json'), `${JSON.stringify(sanitizeValue(results), null, 2)}\n`);
writeFileSync(join(artifactsRoot, 'latest.md'), mdText);
const indexPath = join(artifactsRoot, 'index.md');
const indexLines = existsSync(indexPath) ? readFileSync(indexPath, 'utf8').split('\n').filter(line => line.trim()) : ['# H1 独立验证运行索引', ''];
const indexEntry = `- ${runId}: 用例 ${summary.cases} = 通过 ${summary.pass} / 失败 ${summary.fail} / blocked ${summary.blocked} / unobservable ${summary.unobservable}；TAP ${summary.tap.pass}/${summary.tap.total}，reported at runs/${runId}/results.md`;
if (!indexLines.some(line => line.includes(runId))) indexLines.push(indexEntry);
writeFileSync(indexPath, `${indexLines.join('\n')}\n`);

console.log(`[report] cases=${summary.cases} pass=${summary.pass} fail=${summary.fail} blocked=${summary.blocked} unobservable=${summary.unobservable}`);
console.log(`[report] TAP tests=${summary.tap.total} pass=${summary.tap.pass} fail=${summary.tap.fail} unreported=${summary.tap.unreported}`);
console.log(`[report] wrote ${join(runDir, 'results.md')}`);
if (summary.fail || summary.tap.fail || integrity.judgeImportsProduct || integrity.antiPatterns.skip.length || integrity.antiPatterns.only.length || integrity.antiPatterns.tautology.length) {
  process.exitCode = 1;
  if (integrity.judgeImportsProduct) console.error('[report] FAIL: judge support imports product source');
  if (integrity.antiPatterns.skip.length) console.error('[report] FAIL: skip/todo found in independent suite');
  if (integrity.antiPatterns.only.length) console.error('[report] FAIL: .only found in independent suite');
  if (integrity.antiPatterns.tautology.length) console.error('[report] FAIL: assert.ok(true) found');
}
