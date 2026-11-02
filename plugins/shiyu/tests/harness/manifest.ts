/**
 * Run manifest / evidence-package freezer.
 *
 * Freezes SHA256 identities for the harness source, plugin source, build
 * output, configuration, dependency lock, fixtures, the oracle catalogue
 * and the actual environment (Node/SQLite/TS/DSH package versions and VCS
 * head). The generated JSON is sanitised: absolute workspace/plugin/home
 * paths and credential-shaped strings are rejected (fail-closed) instead of
 * being written into evidence.
 *
 * Boundary: a manifest hash proves file identity, not business correctness,
 * authorisation or complete environment coverage. Build output under `dist/`
 * is recorded only if present; its absence is explicit (`present:false`).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckResult, JsonValue, Violation } from './invariant.js';
import { finish, sha256Hex, violation } from './invariant.js';
import { canonicalJsonString } from './json.js';
import { ALL_SELF_PROOFS } from './index.js';
import { HARNESS_VERSION, ORACLE_API_VERSION, SELF_PROOF_CORPUS } from './version.js';

export const MANIFEST_SCHEMA_VERSION = 2;
export const MANIFEST_KIND = 'shiyu.harness.manifest';

const DEFAULT_ROOTS = [
  'src',
  'client/index.js',
  'package.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'cordis.patch.yml',
  'package-lock.json',
  'tests/harness',
  'scripts/harness',
  'assets',
  'locale',
];
const BUILD_ROOTS = ['dist'];
const EXCLUDED_DIRS = new Set(['node_modules', '.local', '.git', '__pycache__', 'test-results', 'playwright-report', 'coverage']);
const EXCLUDED_FILE_NAMES = new Set(['.DS_Store']);
const EXCLUDED_SUFFIXES = ['.tsbuildinfo', '.log'];

const FORBIDDEN_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'absolute-user-home', pattern: /\/Users\/[^/\s"']+/ },
  { name: 'absolute-home-linux', pattern: /\/home\/[^/\s"']+/ },
  { name: 'openai-style-key', pattern: /(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{12,}/ },
  { name: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{16,}/ },
  { name: 'github-pat', pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'bearer-token', pattern: /Bearer\s+[A-Za-z0-9._-]{12,}/ },
  { name: 'authorization-header', pattern: /"authorization"\s*:\s*"[^"]+"/i },
];

export interface ManifestFileEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ManifestGroup {
  readonly name: string;
  readonly root: string;
  readonly present: boolean;
  readonly files: readonly ManifestFileEntry[];
  readonly totalBytes: number;
  readonly digest: string | null;
}

export interface OracleCatalogEntry {
  readonly name: string;
  readonly version: string;
  readonly module: string;
  readonly samples: number;
  readonly scenarios: number;
  readonly moduleSha256: string | null;
}

export interface EnvironmentFacts {
  readonly node: string;
  readonly modulesAbi: string;
  readonly platform: string;
  readonly arch: string;
  readonly sqliteVersion: string;
  readonly npmVersion: string;
  readonly timezone: string;
  readonly typescript: string;
  readonly tsx: string;
  readonly dshPluginVersion: string;
  readonly dshEngine: string;
  readonly nodeEngine: string;
}

export interface VcsFacts {
  readonly available: boolean;
  readonly head?: string;
  readonly branch?: string;
  readonly dirty?: boolean;
  readonly dirtyEntries?: number;
  readonly reason?: string;
}

export interface HarnessManifest {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly generatedAt: string;
  readonly generator: { readonly path: string; readonly sha256: string | null; readonly module: string; readonly moduleSha256: string | null };
  readonly harness: { readonly version: string; readonly oracleApiVersion: number; readonly selfProofCorpus: string };
  readonly command: readonly string[];
  readonly groups: readonly ManifestGroup[];
  readonly aggregates: { readonly fileCount: number; readonly totalBytes: number; readonly digest: string };
  readonly fixtures: readonly ManifestFileEntry[];
  readonly oracleCatalog: readonly OracleCatalogEntry[];
  readonly oracleCatalogDigest: string;
  readonly environment: EnvironmentFacts;
  readonly vcs: VcsFacts;
  readonly sanitization: { readonly checked: true; readonly rules: readonly string[]; readonly leaks: number; readonly rootsRedactedAs: string };
  readonly limits: { readonly modelCalls: 0; readonly networkCalls: 0; readonly writes: 'plugin-tree-artifacts-only'; readonly note: string };
}

export class ManifestSanitizationError extends Error {
  readonly code = 'UNSANITIZED_MANIFEST';
  readonly leaks: readonly string[];

  constructor(leaks: readonly string[]) {
    super(`manifest contains forbidden evidence patterns: ${leaks.join(', ')}`);
    this.name = 'ManifestSanitizationError';
    this.leaks = leaks;
  }
}

export interface BuildManifestOptions {
  readonly pluginRoot: string;
  readonly workspaceRoot: string;
  readonly includeBuild?: boolean;
  readonly roots?: readonly string[];
  readonly generatedAt?: Date;
  readonly command?: readonly string[];
}

async function isFile(target: string): Promise<boolean> {
  try {
    const info = await lstat(target);
    return info.isFile();
  } catch {
    return false;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    const info = await lstat(target);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function walk(rootAbs: string, relPrefix: string, out: { abs: string; rel: string }[]): Promise<void> {
  const info = await lstat(rootAbs);
  if (info.isFile()) {
    out.push({ abs: rootAbs, rel: relPrefix });
    return;
  }
  if (!info.isDirectory()) return;
  const entries = await readdir(rootAbs, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const name = entry.name;
    if (EXCLUDED_FILE_NAMES.has(name)) continue;
    if (entry.isDirectory() && EXCLUDED_DIRS.has(name)) continue;
    if (EXCLUDED_SUFFIXES.some(suffix => name.endsWith(suffix))) continue;
    const childAbs = join(rootAbs, name);
    const childRel = relPrefix.length === 0 ? name : `${relPrefix}/${name}`;
    if (entry.isDirectory()) await walk(childAbs, childRel, out);
    else if (entry.isFile()) out.push({ abs: childAbs, rel: childRel });
  }
}

function digestEntries(entries: readonly ManifestFileEntry[]): string {
  return sha256Hex(entries.map(entry => `${entry.sha256}  ${entry.path}\n`).join(''));
}

async function readJson(target: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function packageVersionFrom(nodeModules: string, packageName: string): string {
  try {
    // Synchronous small read; manifest generation is a CLI, not the hot path.
    const text = requireFromFile(join(nodeModules, packageName, 'package.json'));
    return text;
  } catch {
    return 'absent';
  }
}

function requireFromFile(target: string): string {
  // Keep dependency-injected but avoid importing the module: parse the JSON text.
  const { readFileSync } = globalThis.process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const parsed = JSON.parse(readFileSync(target, 'utf8')) as { version?: string };
  return typeof parsed.version === 'string' ? parsed.version : 'unknown';
}

function commandVersion(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], { encoding: 'utf8', timeout: 5000 });
  if (result.error !== undefined || result.status !== 0) return 'unavailable';
  return `${result.stdout}`.trim();
}

async function sqliteVersion(): Promise<string> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(':memory:');
    const row = database.prepare('SELECT sqlite_version() AS version').get() as { version?: string } | undefined;
    database.close();
    return row?.version ?? 'unknown';
  } catch {
    return 'unavailable';
  }
}

function sanitizeRelPath(absolute: string, root: string): string {
  return relative(root, absolute).split('\\').join('/');
}

/** Find forbidden evidence patterns in serialised manifest text. */
export function findForbiddenPatterns(text: string, context: { pluginRoot: string; workspaceRoot: string }): string[] {
  const leaks: string[] = [];
  const absoluteRoots = [resolve(context.pluginRoot), resolve(context.workspaceRoot), resolve(homedir())];
  for (const root of absoluteRoots) {
    if (root.length > 1 && text.includes(root)) leaks.push(`absolute-root:${basename(root)}`);
  }
  for (const rule of FORBIDDEN_PATTERNS) {
    const match = rule.pattern.exec(text);
    if (match !== null) leaks.push(`${rule.name}:${match[0].slice(0, 24)}`);
  }
  return [...new Set(leaks)];
}

export function assertSanitized(text: string, context: { pluginRoot: string; workspaceRoot: string }): void {
  const leaks = findForbiddenPatterns(text, context);
  if (leaks.length > 0) throw new ManifestSanitizationError(leaks);
}

export async function buildManifest(options: BuildManifestOptions): Promise<HarnessManifest> {
  const pluginRoot = resolve(options.pluginRoot);
  const workspaceRoot = resolve(options.workspaceRoot);
  const roots = options.roots ?? [...DEFAULT_ROOTS, ...(options.includeBuild === false ? [] : BUILD_ROOTS)];
  const groups: ManifestGroup[] = [];
  const allEntries = new Map<string, ManifestFileEntry>();
  for (const root of roots) {
    const absRoot = join(pluginRoot, root);
    const collected: { abs: string; rel: string }[] = [];
    try {
      await walk(absRoot, root, collected);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        groups.push({ name: root, root, present: false, files: [], totalBytes: 0, digest: null });
        continue;
      }
      throw error;
    }
    const files: ManifestFileEntry[] = [];
    for (const item of collected) {
      const bytes = await readFile(item.abs);
      const entry: ManifestFileEntry = { path: item.rel.split('\\').join('/'), sha256: sha256Hex(bytes), bytes: bytes.byteLength };
      files.push(entry);
      allEntries.set(entry.path, entry);
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    groups.push({
      name: root,
      root,
      present: true,
      files,
      totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
      digest: digestEntries(files),
    });
  }
  const files = [...allEntries.values()].sort((left, right) => left.path.localeCompare(right.path));
  const aggregate = { fileCount: files.length, totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0), digest: digestEntries(files) };
  const fileMap = new Map(files.map(entry => [entry.path, entry]));
  const oracleCatalog: OracleCatalogEntry[] = ALL_SELF_PROOFS.map(proof => ({
    name: proof.name,
    version: proof.version,
    module: proof.module,
    samples: (proof.samples ?? []).length,
    scenarios: (proof.scenarios ?? []).length,
    moduleSha256: fileMap.get(proof.module)?.sha256 ?? null,
  })).sort((left, right) => left.name.localeCompare(right.name));
  const oracleCatalogDigest = sha256Hex(canonicalJsonString(oracleCatalog as unknown as JsonValue));

  const pluginPackage = (await readJson(join(pluginRoot, 'package.json'))) ?? {};
  const engines = (pluginPackage['engines'] as Record<string, unknown> | undefined) ?? {};
  const dependencies = (pluginPackage['dependencies'] as Record<string, unknown> | undefined) ?? {};
  const nodeModules = join(pluginRoot, 'node_modules');
  const environment: EnvironmentFacts = {
    node: process.version,
    modulesAbi: process.versions.modules ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    sqliteVersion: await sqliteVersion(),
    npmVersion: commandVersion('npm', ['--version']),
    timezone: process.env.TZ ?? 'process-default',
    typescript: packageVersionFrom(nodeModules, 'typescript'),
    tsx: packageVersionFrom(nodeModules, 'tsx'),
    dshPluginVersion: typeof pluginPackage['version'] === 'string' ? pluginPackage['version'] : 'unknown',
    dshEngine: typeof engines['dsh'] === 'string' ? engines['dsh'] : 'unknown',
    nodeEngine: typeof engines['node'] === 'string' ? engines['node'] : 'unknown',
  };
  void dependencies;

  const vcs = readVcs(workspaceRoot);
  const fixtures = files.filter(entry => entry.path.startsWith('tests/harness/fixtures/'));
  const generatorModulePath = 'tests/harness/manifest.ts';
  const generatorScriptPath = 'scripts/harness/manifest.mjs';
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  const command = (options.command ?? []).map(part => part.replaceAll(resolve(pluginRoot), '<plugin-root>').replaceAll(resolve(workspaceRoot), '<workspace-root>'));
  const manifest: HarnessManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    generatedAt,
    generator: {
      path: generatorScriptPath,
      sha256: fileMap.get(generatorScriptPath)?.sha256 ?? null,
      module: generatorModulePath,
      moduleSha256: fileMap.get(generatorModulePath)?.sha256 ?? null,
    },
    harness: { version: HARNESS_VERSION, oracleApiVersion: ORACLE_API_VERSION, selfProofCorpus: SELF_PROOF_CORPUS },
    command,
    groups,
    aggregates: aggregate,
    fixtures,
    oracleCatalog,
    oracleCatalogDigest,
    environment,
    vcs,
    sanitization: {
      checked: true,
      rules: ['absolute plugin/workspace/home roots', ...FORBIDDEN_PATTERNS.map(rule => rule.name)],
      leaks: 0,
      rootsRedactedAs: '<plugin-root>|<workspace-root>',
    },
    limits: {
      modelCalls: 0,
      networkCalls: 0,
      writes: 'plugin-tree-artifacts-only',
      note: 'manifest generation reads files and local package metadata only; it does not call models, embeddings, channels, devices or the host runtime',
    },
  };
  const text = JSON.stringify(manifest, null, 2);
  assertSanitized(text, { pluginRoot, workspaceRoot });
  return JSON.parse(text) as HarnessManifest;
}

function readVcs(workspaceRoot: string): VcsFacts {
  const head = spawnSync('git', ['-C', workspaceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
  if (head.error !== undefined || head.status !== 0) {
    return { available: false, reason: 'git unavailable or not a repository' };
  }
  const branch = spawnSync('git', ['-C', workspaceRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
  const status = spawnSync('git', ['-C', workspaceRoot, 'status', '--porcelain', '-z'], { encoding: 'utf8', timeout: 10_000 });
  const dirtyEntries = status.status === 0 && status.stdout.length > 0 ? status.stdout.split('\u0000').filter(part => part.length > 0).length : 0;
  return {
    available: true,
    head: head.stdout.trim(),
    branch: branch.status === 0 ? branch.stdout.trim() : 'unknown',
    dirty: dirtyEntries > 0,
    dirtyEntries,
  };
}

export async function writeManifest(options: BuildManifestOptions & { outFile: string }): Promise<{ manifest: HarnessManifest; path: string; sha256: string }> {
  const manifest = await buildManifest(options);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const outFile = resolve(options.outFile);
  await mkdir(dirname(outFile), { recursive: true });
  const temporary = `${outFile}.tmp-${process.pid}`;
  const handle = await open(temporary, 'w');
  try {
    await handle.write(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, outFile);
  return { manifest, path: outFile, sha256: sha256Hex(text) };
}

/** Recompute file hashes, aggregate digest, oracle versions and harness version. */
export function verifyManifestFiles(manifest: HarnessManifest, options: { pluginRoot: string }): CheckResult {
  const violations: Violation[] = [];
  const pluginRoot = resolve(options.pluginRoot);
  const entries: ManifestFileEntry[] = manifest.groups.flatMap(group => group.files);
  for (const entry of entries) {
    try {
      const bytes = readFileSync(join(pluginRoot, entry.path));
      const digest = sha256Hex(bytes);
      if (digest !== entry.sha256) violations.push(violation('file_hash_mismatch', `$["files"][${JSON.stringify(entry.path)}]`, `recorded ${entry.sha256.slice(0, 12)}…, current ${digest.slice(0, 12)}…`));
      if (bytes.byteLength !== entry.bytes) violations.push(violation('file_size_mismatch', `$["files"][${JSON.stringify(entry.path)}]`, `recorded ${entry.bytes} bytes, current ${bytes.byteLength}`));
    } catch {
      violations.push(violation('file_missing', `$["files"][${JSON.stringify(entry.path)}]`, 'file recorded in manifest is absent now'));
    }
  }
  const recomputed = digestEntries([...entries].sort((left, right) => left.path.localeCompare(right.path)));
  if (recomputed !== manifest.aggregates.digest) {
    violations.push(violation('aggregate_digest_mismatch', '$["aggregates"]["digest"]', 'aggregate digest does not match the recorded file list'));
  }
  for (const oracle of manifest.oracleCatalog) {
    const current = ALL_SELF_PROOFS.find(proof => proof.name === oracle.name);
    if (current === undefined) violations.push(violation('oracle_missing', '$["oracleCatalog"]', `oracle ${oracle.name} is declared in manifest but absent from code`));
    else if (current.version !== oracle.version) violations.push(violation('oracle_version_mismatch', '$["oracleCatalog"]', `oracle ${oracle.name} version ${oracle.version} != current ${current.version}`));
  }
  if (manifest.harness.version !== HARNESS_VERSION) {
    violations.push(violation('harness_version_mismatch', '$["harness"]["version"]', `manifest ${manifest.harness.version} != current ${HARNESS_VERSION}`));
  }
  return finish(
    {
      oracle: 'manifest',
      version: '1.0.0',
      boundary: '按 manifest 记录的路径重算 SHA256/大小/聚合摘要，并核对 oracle 与 harness 版本；证明文件一致，不证明业务正确或环境完整。',
      scope: 'manifest-files',
    },
    entries.length,
    violations,
    { files: entries.length, aggregateDigest: recomputed },
  );
}

function readFileSync(target: string): Buffer {
  const { readFileSync: sync } = globalThis.process.getBuiltinModule('node:fs') as typeof import('node:fs');
  return sync(target);
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export interface ManifestCliResult {
  readonly exitCode: number;
  readonly outFile?: string;
  readonly sha256?: string;
  readonly summary: string;
}

export function parseCliArgs(argv: readonly string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error(`unexpected argument ${item}`);
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(key, next);
      index++;
    } else {
      args.set(key, true);
    }
  }
  return args;
}

export async function runManifestCli(argv: readonly string[], defaults?: { pluginRoot?: string; workspaceRoot?: string }): Promise<ManifestCliResult> {
  const args = parseCliArgs(argv);
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const pluginRoot = resolve(args.get('plugin-root') === undefined || args.get('plugin-root') === true ? defaults?.pluginRoot ?? moduleRoot : String(args.get('plugin-root')));
  const workspaceRoot = resolve(
    args.get('workspace-root') === undefined || args.get('workspace-root') === true ? defaults?.workspaceRoot ?? resolve(pluginRoot, '../..') : String(args.get('workspace-root')),
  );
  const outFile = resolve(
    args.get('out') === undefined || args.get('out') === true ? join(pluginRoot, 'artifacts/dsh/harness/manifest.json') : String(args.get('out')),
  );
  const rootsArgument = args.get('groups');
  const includeBuild = args.get('no-build') !== true;
  const roots = rootsArgument === undefined || rootsArgument === true ? undefined : String(rootsArgument).split(',').filter(item => item.length > 0);
  const command = ['node', '--import', 'tsx', 'scripts/harness/manifest.mjs', ...argv];
  try {
    const { manifest, path, sha256 } = await writeManifest({ pluginRoot, workspaceRoot, outFile, includeBuild, roots, command });
    const summary =
      `manifest written: ${relative(workspaceRoot, path)}\n` +
      `  files=${manifest.aggregates.fileCount} bytes=${manifest.aggregates.totalBytes} digest=${manifest.aggregates.digest}\n` +
      `  harness=${manifest.harness.version} oracles=${manifest.oracleCatalog.length} catalogDigest=${manifest.oracleCatalogDigest}\n` +
      `  node=${manifest.environment.node} sqlite=${manifest.environment.sqliteVersion} vcs=${manifest.vcs.head ?? 'unavailable'}\n` +
      `  sha256=${sha256}`;
    return { exitCode: 0, outFile: path, sha256, summary };
  } catch (error) {
    if (error instanceof ManifestSanitizationError) return { exitCode: 2, summary: `manifest rejected (sanitization): ${error.leaks.join(', ')}` };
    return { exitCode: 1, summary: `manifest generation failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}` };
  }
}

function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(moduleUrl));
}

if (isMain(import.meta.url)) {
  const result = await runManifestCli(process.argv.slice(2));
  process.stderr.write(`${result.summary}\n`);
  process.exitCode = result.exitCode;
}

/** Remove a leftover temporary file (defensive helper for tests/CLI). */
export async function cleanupTemporary(outFile: string): Promise<void> {
  await rm(`${outFile}.tmp-${process.pid}`, { force: true });
}
