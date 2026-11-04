import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { packageRoot } from './paths.mjs';
import { writeZip } from '../vendor/ds-bot/src/office/zip.js';

const execute = promisify(execFile);
const officeCli = path.join(packageRoot, 'vendor', 'ds-bot', 'office.js');
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.js', '.mjs', '.ts', '.py', '.yaml', '.yml', '.html', '.css', '.xml', '.log']);
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function positiveInteger(value, fallback, name, maximum) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw failure('INVALID_OPTION', `${name} must be between 1 and ${maximum}`);
  return result;
}

async function sourceBytes(filename) {
  const info = await stat(filename);
  if (!info.isFile()) throw failure('NOT_A_FILE', 'Choose a regular file');
  if (info.size > MAX_FILE_BYTES) throw failure('FILE_TOO_LARGE', 'File parsing supports files up to 50 MiB');
  return readFile(filename);
}

function decodeText(bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw failure('TEXT_ENCODING', 'Text must use UTF-8 or UTF-16 with a byte-order mark'); }
}

function checkOfficeArchive(bytes) {
  let directoryEnd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65558); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { directoryEnd = offset; break; }
  }
  if (directoryEnd < 0) throw failure('INVALID_OFFICE_FILE', 'Office file is not a readable ZIP package');
  const count = bytes.readUInt16LE(directoryEnd + 10);
  let offset = bytes.readUInt32LE(directoryEnd + 16);
  if (count > 10000 || offset === 0xffffffff) throw failure('OFFICE_LIMIT', 'Office package exceeds supported entry limits');
  let expandedBytes = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw failure('INVALID_OFFICE_FILE', 'Office ZIP directory is incomplete');
    expandedBytes += bytes.readUInt32LE(offset + 24);
    if (expandedBytes > 128 * 1024 * 1024) throw failure('OFFICE_LIMIT', 'Expanded Office content exceeds 128 MiB');
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
}

async function office(args) {
  try {
    const { stdout } = await execute(process.execPath, [officeCli, ...args, '--json'], { timeout: 45000, maxBuffer: 16 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    if (!result.ok) throw failure('OFFICE_PARSE_FAILED', result.error?.message || 'Office file could not be parsed');
    return result.data;
  } catch (error) {
    if (error.stdout) {
      try {
        const result = JSON.parse(error.stdout);
        if (result.error?.message) throw failure('OFFICE_PARSE_FAILED', result.error.message);
      } catch (parsedError) { if (parsedError.code === 'OFFICE_PARSE_FAILED') throw parsedError; }
    }
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw failure('OFFICE_LIMIT', 'Office content is too large to read as one result');
    throw error;
  }
}

export function parseCsv(text, delimiter = ',') {
  if (![',', '\t', ';'].includes(delimiter)) throw failure('INVALID_DELIMITER', 'CSV delimiter must be comma, tab or semicolon');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { cell += '"'; index++; }
      else if (character === '"') { quoted = false; closedQuote = true; }
      else cell += character;
      continue;
    }
    if (character === delimiter) { row.push(cell); cell = ''; closedQuote = false; }
    else if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') index++;
      row.push(cell); rows.push(row); row = []; cell = ''; closedQuote = false;
    } else if (character === '"' && cell === '' && !closedQuote) quoted = true;
    else {
      if (closedQuote || character === '"') throw failure('INVALID_CSV', 'CSV contains an invalid quoted field');
      cell += character;
    }
  }
  if (quoted) throw failure('INVALID_CSV', 'CSV has an unclosed quoted field');
  if (cell || row.length || closedQuote) { row.push(cell); rows.push(row); }
  return rows;
}

function columnNumber(reference) {
  return [...reference.match(/^[A-Z]+/)[0]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

export function columnName(number) {
  let name = '';
  for (let current = number; current > 0; current = Math.floor((current - 1) / 26)) name = String.fromCharCode(65 + (current - 1) % 26) + name;
  return name;
}

function sheetRows(data) {
  return data.rows.map(row => {
    const values = [];
    for (const [reference, value] of Object.entries(row.cells)) values[columnNumber(reference) - 1] = value.v ?? '';
    return { row: row.row, values: Array.from(values, value => value ?? '') };
  });
}

export async function readTable(filename, { sheet, delimiter = ',', maxRows = 50000 } = {}) {
  const absolute = path.resolve(filename);
  const extension = path.extname(absolute).toLowerCase();
  const bytes = await sourceBytes(absolute);
  const rowLimit = positiveInteger(maxRows, 50000, 'maxRows', 100000);
  let rows;
  let sheetName = sheet;
  const warnings = [];
  if (extension === '.csv' || extension === '.tsv') {
    rows = parseCsv(decodeText(bytes), extension === '.tsv' ? '\t' : delimiter).map((values, index) => ({ row: index + 1, values }));
  } else if (extension === '.xlsx') {
    checkOfficeArchive(bytes);
    const inventory = await office(['xlsx', 'inventory', absolute]);
    const selected = sheet ? inventory.sheets.find(item => item.name === sheet) : inventory.sheets[0];
    if (!selected) throw failure('SHEET_NOT_FOUND', `Worksheet ${sheet || '(first worksheet)'} was not found`);
    sheetName = selected.name;
    rows = sheetRows(await office(['xlsx', 'read', absolute, '--sheet', selected.name]));
    if (selected.formulas) warnings.push('Formula cells use saved cached values; this reader does not recalculate formulas.');
    if (selected.uncachedFormulas) throw failure('UNCALCULATED_FORMULA', 'Workbook has formula cells without saved values; calculate them before summarizing');
  } else throw failure('UNSUPPORTED_TABLE', 'Table input must be CSV, TSV or XLSX');
  if (rows.length > rowLimit) throw failure('TABLE_LIMIT', `Table has more than ${rowLimit} nonempty rows`);
  return { sheet: sheetName || path.basename(absolute), rows, warnings };
}

class BoundedText {
  constructor(maximum) { this.maximum = maximum; this.text = ''; this.truncated = false; }
  append(line) {
    const value = `${line}\n`;
    const remaining = this.maximum - this.text.length;
    if (value.length > remaining) this.truncated = true;
    this.text += value.slice(0, Math.max(0, remaining));
    return this.text.length < this.maximum;
  }
}

async function extractPdf(bytes, writer, maxPages, warnings) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfRoot = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
  // PDF.js requires slash-terminated directories while its Node factory reads filesystem paths.
  const resourceDirectory = name => path.join(pdfRoot, name).split(path.sep).join('/') + '/';
  const task = getDocument({ data: Uint8Array.from(bytes), disableFontFace: true, isEvalSupported: false,
    useSystemFonts: true, verbosity: 0, cMapUrl: resourceDirectory('cmaps'), cMapPacked: true,
    standardFontDataUrl: resourceDirectory('standard_fonts') });
  let textFound = false;
  try {
    const document = await task.promise;
    if (document.numPages > maxPages) { writer.truncated = true; warnings.push(`Read the first ${maxPages} of ${document.numPages} pages.`); }
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, maxPages); pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      writer.append(`[page ${pageNumber}]`);
      let line = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        if (item.str.trim()) textFound = true;
        line += item.str + (item.hasEOL ? '\n' : ' ');
      }
      const more = writer.append(line.trim());
      page.cleanup();
      if (!more) break;
    }
  } finally { await task.destroy(); }
  if (!textFound) warnings.push('This PDF has no extractable text. Scanned pages need image rendering and visual reading or local OCR.');
  return textFound;
}

export async function extractFile(filename, options = {}) {
  const absolute = path.resolve(filename);
  const bytes = await sourceBytes(absolute);
  const extension = path.extname(absolute).toLowerCase();
  const maximum = positiveInteger(options.maxCharacters, 60000, 'maxCharacters', 1000000);
  const maxPages = positiveInteger(options.maxPages, 100, 'maxPages', 1000);
  const maxRows = positiveInteger(options.maxRows, 5000, 'maxRows', 50000);
  const writer = new BoundedText(maximum);
  const warnings = [];
  const result = { type: extension.slice(1) || 'binary', supported: true, text: '', truncated: false, warnings,
    source: { name: path.basename(absolute), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
  if (TEXT_EXTENSIONS.has(extension)) {
    const text = decodeText(bytes);
    if (text.includes('\0')) throw failure('BINARY_TEXT', 'This file contains binary data and cannot be read as text');
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) if (!writer.append(`[line ${index + 1}] ${lines[index]}`)) break;
  } else if (extension === '.csv' || extension === '.tsv') {
    const rows = parseCsv(decodeText(bytes), extension === '.tsv' ? '\t' : options.delimiter || ',');
    if (rows.length > maxRows) writer.truncated = true;
    for (let index = 0; index < Math.min(rows.length, maxRows); index++) {
      if (!writer.append(`[row ${index + 1}] ${JSON.stringify(rows[index])}`)) break;
    }
  } else if (extension === '.xlsx') {
    checkOfficeArchive(bytes);
    const inventory = await office(['xlsx', 'inventory', absolute]);
    for (const sheet of inventory.sheets) {
      if (!writer.append(`[sheet ${JSON.stringify(sheet.name)}]`)) break;
      if (sheet.formulas) warnings.push(`${sheet.name} contains formulas. Extracted values are saved cached values.`);
      if (sheet.uncachedFormulas) warnings.push(`${sheet.name} has ${sheet.uncachedFormulas} formulas without saved values.`);
      const end = sheet.dimension?.split(':').at(-1);
      if (end && (/\d+$/.exec(end)?.[0] > maxRows || columnNumber(end) > 256)) {
        writer.truncated = true;
        warnings.push(`${sheet.name} extraction covers A1:IV${maxRows}; use table or Office tools for other cells.`);
      }
      const data = await office(['xlsx', 'read', absolute, '--sheet', sheet.name, '--range', `A1:IV${maxRows}`]);
      for (const row of data.rows) {
        const cells = Object.entries(row.cells).map(([reference, cell]) => `${reference}=${JSON.stringify(cell.v ?? '')}${cell.f ? ` (formula ${cell.f})` : ''}`);
        if (!writer.append(`[row ${row.row}] ${cells.join(' | ')}`)) break;
      }
      if (writer.text.length >= maximum) break;
    }
  } else if (extension === '.docx') {
    checkOfficeArchive(bytes);
    const data = await office(['docx', 'read', absolute]);
    for (const block of data.blocks) {
      if (block.type === 'paragraph') { if (!writer.append(`[paragraph ${block.id}] ${block.text}`)) break; }
      else {
        for (let index = 0; index < block.rows.length; index++) {
          if (!writer.append(`[table ${block.id} row ${index + 1}] ${JSON.stringify(block.rows[index].map(cell => cell.text))}`)) break;
        }
      }
      if (writer.text.length >= maximum) break;
    }
    for (const section of data.sections) if (!writer.append(`[${section.kind} ${section.part}] ${section.text}`)) break;
    for (const note of data.notes) if (!writer.append(`[${note.kind} ${note.id}] ${note.text}`)) break;
    for (const comment of data.comments) if (!writer.append(`[comment ${comment.id} by ${comment.author || 'unknown'}] ${comment.text}`)) break;
  } else if (extension === '.pdf') result.supported = await extractPdf(bytes, writer, maxPages, warnings);
  else {
    result.supported = false;
    warnings.push(/\.(png|jpe?g|webp|gif|tiff?|bmp)$/i.test(extension)
      ? 'Use the native read_image tool on the original image for visual reading. Automatic text extraction is unavailable.'
      : `Automatic text extraction is unavailable for ${extension || 'this file type'}; use the original file with an appropriate tool.`);
  }
  result.text = writer.text;
  result.truncated = writer.truncated;
  if (writer.truncated) warnings.push('The extracted text is limited. Read the original file when more detail is needed.');
  if (options.outputDirectory) {
    const outputDirectory = path.resolve(options.outputDirectory);
    await mkdir(outputDirectory, { recursive: true });
    result.textPath = path.join(outputDirectory, `${result.source.sha256}.extracted.txt`);
    const content = [`Source: ${result.source.name}`, `Type: ${result.type}`, `SHA256: ${result.source.sha256}`,
      ...warnings.map(warning => `Notice: ${warning}`), '', result.text].join('\n');
    await atomicWrite(result.textPath, Buffer.from(content));
  }
  return result;
}

function xml(value) {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function atomicWrite(filename, bytes) {
  const absolute = path.resolve(filename);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, absolute);
}

function packageBytes(parts) {
  return writeZip(Object.entries(parts).map(([name, content]) => ({ name, data: Buffer.from(content) })));
}

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length > 50000 || rows.some(row => !Array.isArray(row) || row.length > 1024)) {
    throw failure('INVALID_ROWS', 'Rows must be arrays with at most 50000 rows and 1024 columns');
  }
  for (const row of rows) for (const value of row) {
    if (value !== null && value !== undefined && !['string', 'number', 'boolean'].includes(typeof value)) throw failure('INVALID_CELL', 'Cell values must be strings, finite numbers, booleans or null');
    if (typeof value === 'number' && !Number.isFinite(value)) throw failure('INVALID_CELL', 'Cell numbers must be finite');
    if (typeof value === 'string' && value.length > 32767) throw failure('INVALID_CELL', 'Cell text exceeds Excel’s 32767-character limit');
  }
}

export async function writeSpreadsheet(filename, { sheets } = {}) {
  if (!Array.isArray(sheets) || !sheets.length || sheets.length > 100) throw failure('INVALID_SHEETS', 'Provide between 1 and 100 worksheets');
  const names = new Set();
  for (const sheet of sheets) {
    if (typeof sheet.name !== 'string' || !sheet.name || sheet.name.length > 31 || /[\\/*?:\[\]]/.test(sheet.name) || /^'|'$/.test(sheet.name) || names.has(sheet.name.toLowerCase())) throw failure('INVALID_SHEET_NAME', 'Worksheet names must be unique, valid Excel names of at most 31 characters');
    names.add(sheet.name.toLowerCase()); validateRows(sheet.rows);
  }
  const parts = {
    '[Content_Types].xml': `${XML_HEADER}<Types xmlns="${CONTENT_TYPES}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': `${XML_HEADER}<Relationships xmlns="${RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE_RELATIONSHIPS}"><sheets>${sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML_HEADER}<Relationships xmlns="${RELATIONSHIPS}">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${OFFICE_RELATIONSHIPS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="styles" Type="${OFFICE_RELATIONSHIPS}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  };
  for (const [sheetIndex, sheet] of sheets.entries()) {
    const columns = Math.max(1, ...sheet.rows.map(row => row.length));
    const rows = sheet.rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => {
      if (value === null || value === undefined) return '';
      const reference = `${columnName(columnIndex + 1)}${rowIndex + 1}`;
      const style = rowIndex === 0 ? ' s="1"' : '';
      if (typeof value === 'number') return `<c r="${reference}"${style}><v>${value}</v></c>`;
      if (typeof value === 'boolean') return `<c r="${reference}" t="b"${style}><v>${value ? 1 : 0}</v></c>`;
      return `<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    }).join('')}</row>`).join('');
    parts[`xl/worksheets/sheet${sheetIndex + 1}.xml`] = `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${columnName(columns)}${Math.max(1, sheet.rows.length)}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${columns}" width="22" customWidth="1"/></cols><sheetData>${rows}</sheetData></worksheet>`;
  }
  await atomicWrite(filename, packageBytes(parts));
  return { path: path.resolve(filename), sheets: sheets.map(sheet => ({ name: sheet.name, rows: sheet.rows.length })) };
}

export async function writeDocument(filename, { title = '', paragraphs = [], tables = [] } = {}) {
  if (typeof title !== 'string' || !Array.isArray(paragraphs) || paragraphs.some(value => typeof value !== 'string') || !Array.isArray(tables)) throw failure('INVALID_DOCUMENT', 'Document needs a text title, text paragraphs and optional row-array tables');
  for (const rows of tables) validateRows(rows);
  const paragraph = (text, bold = false) => `<w:p><w:r>${bold ? '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>' : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
  const content = (title ? paragraph(title, true) : '') + paragraphs.map(value => paragraph(value)).join('')
    + tables.map(rows => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${rows.map(row => `<w:tr>${row.map(value => `<w:tc>${paragraph(value ?? '')}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`).join('');
  await atomicWrite(filename, packageBytes({
    '[Content_Types].xml': `${XML_HEADER}<Types xmlns="${CONTENT_TYPES}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `${XML_HEADER}<Relationships xmlns="${RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `${XML_HEADER}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${content}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  }));
  return { path: path.resolve(filename), paragraphs: paragraphs.length, tables: tables.length };
}

export async function editDocument(filename, output, operations) {
  if (!Array.isArray(operations) || !operations.length) throw failure('INVALID_OPERATIONS', 'Provide a nonempty array of Office edit operations');
  checkOfficeArchive(await sourceBytes(filename));
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  return office(['docx', 'edit', path.resolve(filename), '-o', path.resolve(output), '--ops', JSON.stringify(operations)]);
}

function decimalUnits(value, precision, row) {
  const text = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[3]?.length || 0) > precision) throw failure('INVALID_AMOUNT', `Row ${row} needs a decimal amount with at most ${precision} decimal places`);
  const units = BigInt(match[2] + (match[3] || '').padEnd(precision, '0'));
  return match[1] === '-' ? -units : units;
}

export async function summarizeTable(filename, { group, sum, output, sheet, unique, precision = 2 } = {}) {
  if (!group || !sum || !output) throw failure('INVALID_SUMMARY', 'Summary needs group, sum and output');
  if (!Number.isInteger(precision) || precision < 0 || precision > 8) throw failure('INVALID_PRECISION', 'precision must be between 0 and 8');
  const table = await readTable(filename, { sheet });
  const headers = table.rows[0]?.values.map(value => String(value).trim()) || [];
  const column = name => {
    const indexes = headers.flatMap((value, index) => value === name ? [index] : []);
    if (indexes.length !== 1) throw failure('COLUMN_NOT_FOUND', `Column ${name} must occur exactly once in the header`);
    return indexes[0];
  };
  const groupColumn = column(group);
  const sumColumn = column(sum);
  const uniqueColumn = unique ? column(unique) : null;
  const groups = new Map();
  const firstRows = new Map();
  const duplicates = [];
  for (const row of table.rows.slice(1)) {
    if (row.values.every(value => value === '')) continue;
    const key = String(row.values[groupColumn] ?? '').trim();
    if (!key) throw failure('MISSING_GROUP', `Row ${row.row} has no ${group} value`);
    const amount = decimalUnits(row.values[sumColumn] ?? '', precision, row.row);
    const current = groups.get(key) || { amount: 0n, count: 0 };
    current.amount += amount; current.count++;
    groups.set(key, current);
    if (uniqueColumn !== null) {
      const identity = String(row.values[uniqueColumn] ?? '').trim();
      if (identity && firstRows.has(identity)) duplicates.push({ value: identity, firstRow: firstRows.get(identity), row: row.row });
      else if (identity) firstRows.set(identity, row.row);
    }
  }
  const divisor = 10 ** precision;
  const totals = [...groups].map(([name, value]) => {
    if (value.amount > BigInt(Number.MAX_SAFE_INTEGER) || value.amount < BigInt(Number.MIN_SAFE_INTEGER)) throw failure('AMOUNT_LIMIT', 'Total exceeds safe spreadsheet numeric precision');
    return { group: name, total: Number(value.amount) / divisor, count: value.count };
  });
  const sheets = [{ name: '汇总', rows: [[group, sum, '记录数'], ...totals.map(item => [item.group, item.total, item.count])] }];
  if (unique) sheets.push({ name: '重复记录', rows: [[unique, '首次行号', '重复行号'], ...duplicates.map(item => [item.value, item.firstRow, item.row])] });
  if (path.extname(output).toLowerCase() === '.csv') {
    const csv = sheets[0].rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
    await atomicWrite(output, Buffer.from(csv));
  } else if (path.extname(output).toLowerCase() === '.xlsx') await writeSpreadsheet(output, { sheets });
  else throw failure('INVALID_OUTPUT', 'Summary output must have a .csv or .xlsx extension');
  return { path: path.resolve(output), totals, duplicates, duplicatePolicy: 'reported-and-included', warnings: table.warnings };
}
