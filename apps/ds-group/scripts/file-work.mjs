#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { extractFile, readTable, summarizeTable, writeSpreadsheet, writeDocument, editDocument } from '../src/file-formats.mjs';

export const usage = `File work commands
  extract FILE [--output-dir DIRECTORY] [--max-characters 60000]
  table FILE [--sheet NAME]
  summarize FILE --group COLUMN --sum COLUMN --output RESULT.xlsx [--sheet NAME] [--unique COLUMN] [--precision 2]
  xlsx-create --input SPEC.json --output RESULT.xlsx
    SPEC is {"sheets":[{"name":"Sheet1","rows":[["name","amount"],["Alice",20]]}]}
  docx-create --input SPEC.json --output RESULT.docx
    SPEC is {"title":"Report","paragraphs":["Text"],"tables":[[["name","amount"],["Alice",20]]]}
  docx-edit FILE --ops OPS.json --output RESULT.docx
    OPS is an array of DS-Bot Office operations, for example [{"replace":{"find":"old","with":"new"}}]
All commands emit JSON. Extraction preserves source locations. Summaries use saved workbook values, require numeric decimal amounts, and report duplicates while including them in totals.`;

export async function runFileWork(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    input: { type: 'string' }, output: { type: 'string' }, 'output-dir': { type: 'string' },
    'max-characters': { type: 'string' }, sheet: { type: 'string' }, group: { type: 'string' },
    sum: { type: 'string' }, unique: { type: 'string' }, precision: { type: 'string' },
    ops: { type: 'string' }, help: { type: 'boolean' },
  } });
  const [command, filename] = positionals;
  if (values.help || !command || command === 'help') return { help: usage };
  const requireInput = () => {
    if (!filename) throw new Error(`${command} requires an input file`);
    return filename;
  };
  const requireOutput = () => {
    if (!values.output) throw new Error(`${command} requires --output FILE`);
    return values.output;
  };
  const loadJson = async filename => {
    if (!filename) throw new Error(`${command} requires a JSON input file`);
    return JSON.parse(await readFile(filename, 'utf8'));
  };
  if (command === 'extract') return extractFile(requireInput(), { outputDirectory: values['output-dir'],
    ...(values['max-characters'] ? { maxCharacters: Number(values['max-characters']) } : {}) });
  if (command === 'table') return readTable(requireInput(), { sheet: values.sheet });
  if (command === 'summarize') return summarizeTable(requireInput(), { group: values.group, sum: values.sum,
    output: requireOutput(), sheet: values.sheet, unique: values.unique,
    ...(values.precision ? { precision: Number(values.precision) } : {}) });
  if (command === 'xlsx-create') return writeSpreadsheet(requireOutput(), await loadJson(values.input));
  if (command === 'docx-create') return writeDocument(requireOutput(), await loadJson(values.input));
  if (command === 'docx-edit') return editDocument(requireInput(), requireOutput(), await loadJson(values.ops));
  throw new Error(`Unknown file-work command ${command}. Use --help for supported commands.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { console.log(JSON.stringify({ ok: true, data: await runFileWork(process.argv.slice(2)) })); }
  catch (error) {
    console.error(JSON.stringify({ ok: false, error: { code: error.code || 'FILE_WORK_FAILED', message: error.message } }));
    process.exitCode = 1;
  }
}
