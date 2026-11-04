import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { extractFile, parseCsv, readTable, writeSpreadsheet, writeDocument, editDocument, summarizeTable } from '../src/file-formats.mjs';
import { packageRoot } from '../src/paths.mjs';

const execute = promisify(execFile);

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-file-formats-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function pdfFixture(text) {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : 'q Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let document = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}

test('CSV reading preserves quoted commas, escaped quotes, newlines and row markers', async t => {
  const directory = await fixture(t);
  const source = '\uFEFF姓名,说明,金额\r\n小雨,"包含,逗号",0.10\r\n小晴,"第一行\n第二行""引号""",0.20\r\n';
  const filename = path.join(directory, '人员.csv');
  await writeFile(filename, source);
  assert.deepEqual(parseCsv(source), [['姓名', '说明', '金额'], ['小雨', '包含,逗号', '0.10'], ['小晴', '第一行\n第二行"引号"', '0.20']]);
  const extracted = await extractFile(filename, { outputDirectory: path.join(directory, 'extracted') });
  assert.equal(extracted.supported, true);
  assert.match(extracted.text, /\[row 3\].*小晴/);
  assert.match(await readFile(extracted.textPath, 'utf8'), /SHA256:/);
  assert.equal(extracted.source.sha256, createHash('sha256').update(source).digest('hex'));
  assert.throws(() => parseCsv('"unclosed'), /unclosed/);
  assert.throws(() => parseCsv('"value"unexpected'), /invalid quoted/);
  const utf16 = path.join(directory, 'excel-export.tsv');
  await writeFile(utf16, Buffer.from('\uFEFF姓名\t金额\n小晴\t25', 'utf16le'));
  assert.deepEqual((await readTable(utf16)).rows[1].values, ['小晴', '25']);
});

test('bounded extraction preserves the source and reports truncation and unsupported image handling', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'notes.md');
  const original = 'alpha\n' + '中'.repeat(1000);
  await writeFile(filename, original);
  const extracted = await extractFile(filename, { maxCharacters: 80 });
  assert.equal(extracted.text.length, 80);
  assert.equal(extracted.truncated, true);
  assert.equal(await readFile(filename, 'utf8'), original);
  const image = path.join(directory, 'image.png');
  await writeFile(image, Buffer.from([137, 80, 78, 71]));
  const unsupported = await extractFile(image);
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.warnings[0], /read_image/);
});

test('XLSX output round-trips text, numeric values, booleans and source cell references', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, '费用表.xlsx');
  const spec = { sheets: [{ name: '人员 & 费用', rows: [['姓名', '金额', '确认'], ['小雨 <主管>', 120.25, true], ['小晴', 250, false]] }] };
  await writeSpreadsheet(filename, spec);
  const first = await readFile(filename);
  await writeSpreadsheet(filename, spec);
  assert.deepEqual(await readFile(filename), first, 'OOXML generation is deterministic');
  const table = await readTable(filename);
  assert.deepEqual(table.rows[1], { row: 2, values: ['小雨 <主管>', '120.25', true] });
  const extracted = await extractFile(filename);
  assert.match(extracted.text, /\[sheet "人员 & 费用"\]/);
  assert.match(extracted.text, /B2="120.25"/);
  const { stdout } = await execute(process.execPath, [path.join(packageRoot, 'vendor/ds-bot/office.js'), 'check', filename, '--json']);
  assert.deepEqual(JSON.parse(stdout).data.findings, []);
});

test('expense summary calculates decimal totals, reports duplicates and writes a readable workbook', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, '费用.csv');
  await writeFile(filename, '编号,部门,金额\nA,财务,0.10\nB,财务,0.20\nA,人事,25.00\nC,人事,-5.50\n');
  const output = path.join(directory, '汇总.xlsx');
  const result = await summarizeTable(filename, { group: '部门', sum: '金额', unique: '编号', output });
  assert.deepEqual(result.totals, [{ group: '财务', total: 0.3, count: 2 }, { group: '人事', total: 19.5, count: 2 }]);
  assert.deepEqual(result.duplicates, [{ value: 'A', firstRow: 2, row: 4 }]);
  const summary = await readTable(output, { sheet: '汇总' });
  assert.deepEqual(summary.rows[1].values, ['财务', '0.3', '2']);
  const duplicates = await readTable(output, { sheet: '重复记录' });
  assert.deepEqual(duplicates.rows[1].values, ['A', '2', '4']);
  await assert.rejects(summarizeTable(filename, { group: '不存在', sum: '金额', output }), /exactly once/);
  await writeFile(filename, '部门,金额\n财务,unknown\n');
  await assert.rejects(summarizeTable(filename, { group: '部门', sum: '金额', output }), /Row 2/);
});

test('DOCX creation and existing Office edit operations preserve original input and expose paragraph/table markers', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, '说明.docx');
  const output = path.join(directory, '说明-第二版.docx');
  await writeDocument(filename, { title: '费用说明', paragraphs: ['每人标准为320元', '请核对 & 确认'], tables: [[['部门', '金额'], ['人事', 960]]] });
  const original = await readFile(filename);
  const extracted = await extractFile(filename);
  assert.match(extracted.text, /\[paragraph p2\] 每人标准为320元/);
  assert.match(extracted.text, /\[table t1 row 2\].*960/);
  await editDocument(filename, output, [{ replace: { find: '320元', with: '350元' } }]);
  assert.match((await extractFile(output)).text, /350元/);
  assert.deepEqual(await readFile(filename), original);
  const { stdout } = await execute(process.execPath, [path.join(packageRoot, 'vendor/ds-bot/office.js'), 'check', output, '--json']);
  assert.deepEqual(JSON.parse(stdout).data.findings, []);
});

test('text PDF extraction retains page references and reports scan-only pages', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'report.pdf');
  await writeFile(filename, pdfFixture('Training total is 960'));
  const extracted = await extractFile(filename);
  assert.equal(extracted.supported, true);
  assert.match(extracted.text, /\[page 1\]/);
  assert.match(extracted.text, /Training total is 960/);
  await writeFile(filename, pdfFixture(''));
  const scan = await extractFile(filename);
  assert.equal(scan.supported, false);
  assert.ok(scan.warnings.some(warning => /no extractable text/.test(warning)));
});

test('the file-work CLI runs the normal summary entry point using paths with spaces', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'team expenses.csv');
  const output = path.join(directory, 'team summary.csv');
  await writeFile(filename, 'team,amount\nHR,10\nHR,20\n');
  const { stdout } = await execute(process.execPath, [path.join(packageRoot, 'scripts/file-work.mjs'), 'summarize', filename,
    '--group', 'team', '--sum', 'amount', '--output', output]);
  assert.equal(JSON.parse(stdout).ok, true);
  assert.deepEqual(parseCsv(await readFile(output, 'utf8')), [['team', 'amount', '记录数'], ['HR', '30', '2']]);
});
