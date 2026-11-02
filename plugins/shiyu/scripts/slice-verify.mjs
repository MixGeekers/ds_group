#!/usr/bin/env node
/**
 * Verify one reviewable slice in an isolated git worktree.
 *
 * The shared working tree contains several independent slices at once. A final
 * `npm run check` run there cannot honestly be attributed to one slice. This
 * tool copies exactly the files of one slice onto committed HEAD in a throwaway
 * git worktree, runs the package check there, and records the evidence bundle
 * (file hashes, test denominators, log hash) as JSON.
 *
 * Usage (from the repository root):
 *   node plugins/shiyu/scripts/slice-verify.mjs --slice h1 --manifest <manifest.json>
 *        [--keep] [--worktree <path>] [--timeout-ms <ms>]
 *
 * Manifest JSON shape:
 *   { "slice": "h1", "files": ["plugins/shiyu/src/...", "plugins/shiyu/tests/..."] }
 * Paths are repository-root relative (as git reports them). New files are
 * allowed; they must exist in the current working tree.
 *
 * The isolated worktree gets a symlink to the current package `node_modules` and
 * to `.local/ombre` (the pinned Python/Ombre fixture) so no dependency install
 * is needed. Nothing is written to the shared working tree and the worktree is
 * removed unless --keep is passed.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageDir, '..', '..');
const pluginRelative = packageDir.slice(repoRoot.length + 1);

function parseArgs(argv) {
  const options = { manifest: undefined, keep: false, worktree: undefined, timeoutMs: 30 * 60 * 1000 };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--slice') options.slice = argv[++index];
    else if (argument === '--manifest') options.manifest = resolve(argv[++index]);
    else if (argument === '--keep') options.keep = true;
    else if (argument === '--worktree') options.worktree = resolve(argv[++index]);
    else if (argument === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.manifest) throw new Error('--manifest is required');
  return options;
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const homedir = process.env.HOME ?? '';
/** Evidence hygiene: committed artifacts must not leak absolute home paths. */
const sanitizePath = (value) => String(value).replaceAll(repoRoot, '<repo>').replaceAll(homedir, '<home>');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function materialize(options) {
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
  const slice = options.slice ?? manifest.slice ?? 'slice';
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('manifest.files must be a non-empty array');
  const files = [...new Set(manifest.files.map((path) => String(path).trim()).filter(Boolean))];
  for (const path of files) if (!existsSync(join(repoRoot, path))) throw new Error(`Manifest file does not exist in the working tree: ${path}`);
  const head = git(repoRoot, 'rev-parse', 'HEAD');
  const worktree = options.worktree ?? join(repoRoot, 'plugins', 'shiyu', '.local', `slice-verify-${slice}-${Date.now()}`);
  rmSync(worktree, { recursive: true, force: true });
  git(repoRoot, 'worktree', 'add', '--detach', worktree, head);
  // Copy the exact slice over the committed baseline.
  for (const path of files) {
    const target = join(worktree, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repoRoot, path), target);
  }
  // Reuse the installed dependencies and the pinned Python/Ombre fixture.
  const isolatedPackage = join(worktree, pluginRelative);
  const links = [
    [join(packageDir, 'node_modules'), join(isolatedPackage, 'node_modules')],
    [join(packageDir, '.local', 'ombre'), join(isolatedPackage, '.local', 'ombre')],
  ];
  for (const [source, target] of links) {
    if (!existsSync(source)) continue;
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { recursive: true, force: true });
    symlinkSync(source, target);
  }
  return { slice, files, head, worktree, isolatedPackage };
}

function runCheck(cwd, timeoutMs, logPath) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    const child = spawn('npm', ['run', 'check'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const collect = (chunk) => chunks.push(chunk);
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks);
      writeFileSync(logPath, output);
      const text = output.toString('utf8');
      const match = text.match(/ℹ tests (\d+)\nℹ suites \d+\nℹ pass (\d+)\nℹ fail (\d+)\nℹ cancelled (\d+)\nℹ skipped (\d+)\nℹ todo \d+/);
      resolveRun({ exitCode: code, signal, timedOut, durationMs: Date.now() - startedAt, bytes: output.length, sha256: sha256(output),
        tests: match ? { tests: Number(match[1]), pass: Number(match[2]), fail: Number(match[3]), cancelled: Number(match[4]), skipped: Number(match[5]) } : null,
        tail: text.replace(/\u001b\[[0-9;]*m/g, '').split('\n').filter(Boolean).slice(-6) });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const materialized = materialize(options);
  const logPath = join(packageDir, '.local', `slice-verify-${materialized.slice}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  const result = await runCheck(materialized.isolatedPackage, options.timeoutMs, logPath);
  const evidence = {
    schemaVersion: 1,
    kind: 'isolated-slice-verification',
    slice: materialized.slice,
    capturedAt: new Date().toISOString(),
    head: materialized.head,
    worktree: sanitizePath(materialized.worktree),
    files: materialized.files.map((path) => ({ path, bytes: readFileSync(join(repoRoot, path)).length, sha256: sha256(readFileSync(join(repoRoot, path))) })),
    check: { command: 'npm run check (typecheck + node --test tests/*.test.ts + build + client syntax)', ...result },
    log: { path: sanitizePath(logPath), bytes: result.bytes, sha256: result.sha256 },
    verdict: result.exitCode === 0 && result.tests?.fail === 0 && result.tests?.skipped === 0 ? 'pass' : (result.timedOut ? 'timeout' : 'fail'),
  };
  const evidencePath = join(packageDir, 'artifacts', 'dsh', 'slices', `${materialized.slice}-verify.json`);
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  if (!options.keep) git(repoRoot, 'worktree', 'remove', '--force', materialized.worktree);
  process.stdout.write(`${JSON.stringify({ verdict: evidence.verdict, tests: result.tests, log: logPath, evidence: evidencePath }, null, 2)}\n`);
  process.exitCode = evidence.verdict === 'pass' ? 0 : 1;
}

main().catch((error) => { process.stderr.write(`slice-verify: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; });
