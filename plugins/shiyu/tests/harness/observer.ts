/**
 * Independent observer and effect ledger.
 *
 * The observer lives outside the component under test and persists an
 * append-only JSONL ledger with:
 * - durable appends (fsync by default) so evidence survives a child-process
 *   crash and can be read back afterwards;
 * - a SHA256 hash chain plus contiguous sequence numbers so tampering,
 *   truncation and reordering are reported instead of silently skipped;
 * - a separate receiver-side effect ledger (attempts / executions /
 *   receipts / lost receipts) that can prove "executed once, receipt lost"
 *   while the product is still allowed to report `unknown`.
 *
 * Boundary: the hash chain is an integrity check against corruption and
 * naive edits, not a signature/MAC; anyone who can rewrite the whole file
 * can recompute it. Two directories under the same OS user are not a secret
 * isolation boundary. The ledger records facts, never product state.
 */
import { mkdir, open as openFile, readFile, truncate, type FileHandle } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { CheckResult, JsonValue, OracleSelfProof, Violation } from './invariant.js';
import { finish, jsonPointerChild, sha256Hex, violation } from './invariant.js';
import { canonicalJsonString, checkLosslessJson } from './json.js';
import { checkEffectAccounting, checkCausalAlignment, type EffectObservation } from './causal.js';

const GENESIS = 'GENESIS';
const LEDGER_SCHEMA_VERSION = 1;
const KIND_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;

export interface LedgerIdentity {
  readonly [key: string]: string | number;
}

export interface LedgerRecord {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly seq: number;
  readonly at: string;
  readonly actor: string;
  readonly kind: string;
  readonly identity?: LedgerIdentity;
  readonly causalKey?: string;
  readonly payload: JsonValue;
  readonly prevHash: string;
  readonly hash: string;
}

export interface LedgerIssue {
  readonly code: string;
  readonly message: string;
  readonly line?: number;
  readonly recordHash?: string;
}

export interface LedgerRead {
  readonly ok: boolean;
  readonly file: string;
  readonly records: readonly LedgerRecord[];
  readonly issues: readonly LedgerIssue[];
  readonly stats: {
    readonly bytes: number;
    readonly lines: number;
    readonly completeRecords: number;
    readonly truncatedTailBytes: number;
  };
}

export class LedgerIntegrityError extends Error {
  readonly code = 'LEDGER_INTEGRITY';
  readonly read: LedgerRead;

  constructor(read: LedgerRead) {
    super(`ledger ${read.file} failed integrity: ${read.issues.map(item => `${item.code}${item.line === undefined ? '' : `@${item.line}`}`).join(', ')}`);
    this.name = 'LedgerIntegrityError';
    this.read = read;
  }
}

export interface LedgerAppendInput {
  readonly kind: string;
  readonly payload: JsonValue;
  readonly identity?: LedgerIdentity;
  readonly causalKey?: string;
  readonly at?: string;
}

export interface LedgerOpenOptions {
  readonly file: string;
  readonly runId: string;
  readonly actor: string;
  /** fsync each record (default) or rely on OS buffering. */
  readonly durability?: 'fsync' | 'buffered';
  /** What to do when the file ends with a partial record. */
  readonly repairPolicy?: 'fail' | 'truncate-tail';
  readonly now?: () => Date;
}

function sansHash(record: Omit<LedgerRecord, 'hash'>): JsonValue {
  const base: Record<string, JsonValue> = {
    schemaVersion: record.schemaVersion,
    runId: record.runId,
    seq: record.seq,
    at: record.at,
    actor: record.actor,
    kind: record.kind,
    payload: record.payload,
  };
  if (record.identity !== undefined) base.identity = record.identity as JsonValue;
  if (record.causalKey !== undefined) base.causalKey = record.causalKey;
  base.prevHash = record.prevHash;
  return base;
}

function chainHash(record: Omit<LedgerRecord, 'hash'>): string {
  return sha256Hex(`${record.prevHash}\n${canonicalJsonString(sansHash(record))}`);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

function validateRecordShape(value: unknown, line: number, issues: LedgerIssue[]): value is LedgerRecord {
  const add = (code: string, message: string): void => {
    issues.push({ code, message, line });
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    add('record_not_object', 'ledger line is not a JSON object');
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== LEDGER_SCHEMA_VERSION) add('unsupported_schema_version', `schemaVersion ${String(record.schemaVersion)} is not ${LEDGER_SCHEMA_VERSION}`);
  if (typeof record.runId !== 'string' || record.runId.length === 0) add('record_field_invalid', 'runId is missing');
  if (typeof record.seq !== 'number' || !Number.isSafeInteger(record.seq) || record.seq < 1) add('record_field_invalid', 'seq must be a positive integer');
  if (!isIsoTimestamp(record.at)) add('record_field_invalid', 'at is not an ISO timestamp');
  if (typeof record.actor !== 'string' || record.actor.length === 0) add('record_field_invalid', 'actor is missing');
  if (typeof record.kind !== 'string' || !KIND_PATTERN.test(record.kind)) add('record_field_invalid', `kind ${String(record.kind)} is not a dotted kind`);
  if (record.identity !== undefined) {
    if (record.identity === null || typeof record.identity !== 'object' || Array.isArray(record.identity)) add('record_field_invalid', 'identity must be an object');
    else {
      for (const [key, item] of Object.entries(record.identity)) {
        if (typeof item !== 'string' && typeof item !== 'number') add('record_field_invalid', `identity.${key} must be string or number`);
      }
    }
  }
  if (record.causalKey !== undefined && typeof record.causalKey !== 'string') add('record_field_invalid', 'causalKey must be a string');
  if (record.payload === undefined) add('record_field_invalid', 'payload is required');
  if (typeof record.prevHash !== 'string' || record.prevHash.length === 0) add('record_field_invalid', 'prevHash is missing');
  if (typeof record.hash !== 'string' || !/^[0-9a-f]{64}$/.test(record.hash)) add('record_field_invalid', 'hash must be a sha256 hex digest');
  return issues.every(issue => issue.line !== line);
}

/** Read and verify a ledger file without trusting any product component. */
export async function readLedgerFile(file: string, options: { expectedRunId?: string } = {}): Promise<LedgerRead> {
  let buffer: Buffer;
  try {
    buffer = await readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const issue: LedgerIssue = { code: code === 'ENOENT' ? 'ledger_missing' : 'ledger_unreadable', message: error instanceof Error ? error.message : String(error) };
    return { ok: false, file, records: [], issues: [issue], stats: { bytes: 0, lines: 0, completeRecords: 0, truncatedTailBytes: 0 } };
  }
  const text = buffer.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  const completeText = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
  const tail = lastNewline === -1 ? text : text.slice(lastNewline + 1);
  const issues: LedgerIssue[] = [];
  if (tail.length > 0) {
    issues.push({
      code: 'truncated_tail',
      message: `ledger ends with ${Buffer.byteLength(tail, 'utf8')} byte(s) of an incomplete record (crash window)`,
    });
  }
  const lines = completeText.length === 0 ? [] : completeText.slice(0, -1).split('\n');
  const records: LedgerRecord[] = [];
  let expectedSeq = 1;
  let expectedPrevHash = GENESIS;
  let chainBroken = false;
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      issues.push({ code: 'corrupt_record', message: `line is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, line: lineNumber });
      chainBroken = true;
      return;
    }
    const localIssues: LedgerIssue[] = [];
    if (!validateRecordShape(parsed, lineNumber, localIssues)) {
      issues.push(...localIssues);
      chainBroken = true;
      return;
    }
    const record = parsed as LedgerRecord;
    const structural: Violation[] = [];
    const lossless = checkLosslessJson(record.payload);
    if (!lossless.ok) {
      structural.push(violation('payload_not_lossless', '$', `payload loses data when serialised: ${lossless.violations.map(item => item.code).join(',')}`));
    }
    if (record.seq !== expectedSeq) {
      structural.push(violation(record.seq <= expectedSeq - 1 ? 'duplicate_sequence' : 'sequence_gap', '$.seq', `expected seq ${expectedSeq}, got ${record.seq}`));
    }
    if (record.prevHash !== expectedPrevHash) {
      structural.push(violation('hash_chain_mismatch', '$.prevHash', `expected prevHash ${expectedPrevHash.slice(0, 12)}…, got ${record.prevHash.slice(0, 12)}…`));
    }
    const recomputed = chainHash({ ...record, hash: undefined } as unknown as Omit<LedgerRecord, 'hash'>);
    if (recomputed !== record.hash) {
      structural.push(violation('hash_mismatch', '$.hash', 'record content does not match its recorded hash (tampered or corrupted)'));
    }
    if (options.expectedRunId !== undefined && record.runId !== options.expectedRunId) {
      structural.push(violation('run_id_mismatch', '$.runId', `record belongs to run ${record.runId}, expected ${options.expectedRunId}`));
    }
    for (const item of structural) {
      issues.push({ code: item.code, message: item.message, line: lineNumber, recordHash: typeof record.hash === 'string' ? record.hash : undefined });
    }
    if (structural.some(item => item.code === 'sequence_gap' || item.code === 'duplicate_sequence' || item.code === 'hash_chain_mismatch' || item.code === 'hash_mismatch')) chainBroken = true;
    records.push(record);
    expectedSeq = record.seq + 1;
    expectedPrevHash = record.hash;
  });
  if (chainBroken) issues.push({ code: 'chain_unverifiable_after_failure', message: 'records after the first chain failure cannot be trusted as a continuous ledger' });
  return {
    ok: issues.length === 0,
    file,
    records,
    issues,
    stats: {
      bytes: buffer.byteLength,
      lines: lines.length,
      completeRecords: records.length,
      truncatedTailBytes: tail.length === 0 ? 0 : Buffer.byteLength(tail, 'utf8'),
    },
  };
}

/** Map ledger issues to a standard CheckResult (evidence gaps block release gates). */
export function checkLedgerIntegrity(read: LedgerRead): CheckResult {
  const violations = read.issues.map(issue =>
    violation(
      issue.code,
      issue.line === undefined ? '$' : jsonPointerChild('$["lines"]', issue.line),
      issue.message,
      issue.recordHash === undefined ? undefined : { recordHash: issue.recordHash },
    ),
  );
  return finish(
    {
      oracle: 'observer-ledger',
      version: '1.1.0',
      boundary:
        '按 append-only JSONL 的序号、prevHash、内容 hash、runId、可解析性与载荷无损性核对独立观察账本；截断尾/坏记录/失序/篡改/错 run 均报告为证据问题，不静默跳过。' +
        '哈希链不是签名，无法抵御完整重写。',
      scope: 'ledger-integrity',
    },
    read.stats.completeRecords,
    violations,
    {
      bytes: read.stats.bytes,
      completeRecords: read.stats.completeRecords,
      truncatedTailBytes: read.stats.truncatedTailBytes,
    },
  );
}

/**
 * Append-only JSONL ledger used by the test harness / receiving endpoint.
 */
export class AppendOnlyLedger {
  readonly file: string;
  readonly runId: string;
  readonly actor: string;
  private readonly handle: FileHandle;
  private readonly durability: 'fsync' | 'buffered';
  private readonly now: () => Date;
  private seq: number;
  private prevHash: string;
  private closed = false;

  private constructor(file: string, runId: string, actor: string, handle: FileHandle, durability: 'fsync' | 'buffered', now: () => Date, seq: number, prevHash: string) {
    this.file = file;
    this.runId = runId;
    this.actor = actor;
    this.handle = handle;
    this.durability = durability;
    this.now = now;
    this.seq = seq;
    this.prevHash = prevHash;
  }

  static async open(options: LedgerOpenOptions): Promise<AppendOnlyLedger> {
    const file = resolve(options.file);
    await mkdir(dirname(file), { recursive: true });
    let seq = 1;
    let prevHash = GENESIS;
    let repair: { droppedBytes: number } | undefined;
    const before = await readLedgerFile(file, { expectedRunId: options.runId });
    const missing = before.issues.length === 1 && before.issues[0].code === 'ledger_missing';
    if (!before.ok && !missing) {
      const onlyTailIssue = before.issues.every(issue => issue.code === 'truncated_tail');
      const repairPolicy = options.repairPolicy ?? 'fail';
      if (repairPolicy !== 'truncate-tail' || !onlyTailIssue || before.stats.truncatedTailBytes === 0) {
        throw new LedgerIntegrityError(before);
      }
      const size = (await readFile(file)).byteLength;
      await truncate(file, size - before.stats.truncatedTailBytes);
      const reread = await readLedgerFile(file, { expectedRunId: options.runId });
      if (!reread.ok) throw new LedgerIntegrityError(reread);
      repair = { droppedBytes: before.stats.truncatedTailBytes };
      const last = reread.records[reread.records.length - 1];
      if (last !== undefined) {
        seq = last.seq + 1;
        prevHash = last.hash;
      }
    } else if (before.ok) {
      const last = before.records[before.records.length - 1];
      if (last !== undefined) {
        seq = last.seq + 1;
        prevHash = last.hash;
      }
    }
    const handle = await openFile(file, 'a');
    const ledger = new AppendOnlyLedger(file, options.runId, options.actor, handle, options.durability ?? 'fsync', options.now ?? (() => new Date()), seq, prevHash);
    if (repair !== undefined) {
      await ledger.append({ kind: 'ledger.repair', payload: { droppedBytes: repair.droppedBytes, reason: 'truncated_tail' } });
    }
    return ledger;
  }

  get lastSeq(): number {
    return this.seq - 1;
  }

  async append(input: LedgerAppendInput): Promise<LedgerRecord> {
    if (this.closed) throw new Error('ledger is closed');
    if (!KIND_PATTERN.test(input.kind)) throw new Error(`invalid ledger kind ${input.kind}`);
    const payloadCheck = checkLosslessJson(input.payload);
    if (!payloadCheck.ok) {
      const error = new Error(`ledger payload is not lossless JSON: ${payloadCheck.violations.map(item => `${item.code}@${item.path}`).join(', ')}`);
      Object.assign(error, { code: 'NOT_LOSSLESS_JSON', result: payloadCheck });
      throw error;
    }
    if (input.identity !== undefined) {
      for (const [key, value] of Object.entries(input.identity)) {
        if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`identity.${key} must be string or number`);
      }
    }
    const at = input.at ?? this.now().toISOString();
    if (!isIsoTimestamp(at)) throw new Error(`invalid record timestamp ${at}`);
    const base: Omit<LedgerRecord, 'hash'> = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      runId: this.runId,
      seq: this.seq,
      at,
      actor: this.actor,
      kind: input.kind,
      payload: input.payload,
      prevHash: this.prevHash,
      ...(input.identity === undefined ? {} : { identity: input.identity }),
      ...(input.causalKey === undefined ? {} : { causalKey: input.causalKey }),
    };
    const hash = chainHash(base);
    const record: LedgerRecord = { ...base, hash };
    await this.handle.write(`${JSON.stringify(record)}\n`);
    if (this.durability === 'fsync') await this.handle.sync();
    this.seq += 1;
    this.prevHash = hash;
    return record;
  }

  async read(): Promise<LedgerRead> {
    return readLedgerFile(this.file, { expectedRunId: this.runId });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}

/* ------------------------------------------------------------------ */
/* Receiver-side effect ledger.                                        */
/* ------------------------------------------------------------------ */

export type Idempotency = 'non-idempotent' | 'idempotent';

export interface EffectExecutionInput {
  readonly effectId: string;
  readonly operation: string;
  readonly requestId: string;
  readonly idempotency: Idempotency;
  readonly payloadDigest: string;
  readonly endpoint?: string;
}

export interface ExecutionRecordResult {
  readonly recorded: boolean;
  readonly duplicateSuppressed: boolean;
  readonly executionIndex: number;
}

export interface EffectSummary {
  readonly effectId: string;
  readonly operations: readonly string[];
  readonly attempts: number;
  readonly executions: number;
  readonly receipts: number;
  readonly receiptsLost: number;
  readonly duplicateSuppressed: number;
}

export class IndependentEffectLedger {
  static readonly FILE_NAME = 'independent-effect-ledger.jsonl';
  readonly ledger: AppendOnlyLedger;
  readonly directory: string;

  private constructor(directory: string, ledger: AppendOnlyLedger) {
    this.directory = directory;
    this.ledger = ledger;
  }

  static async open(options: {
    readonly directory: string;
    readonly runId: string;
    readonly actor?: string;
    readonly now?: () => Date;
    readonly durability?: 'fsync' | 'buffered';
  }): Promise<IndependentEffectLedger> {
    const directory = resolve(options.directory);
    const ledger = await AppendOnlyLedger.open({
      file: join(directory, IndependentEffectLedger.FILE_NAME),
      runId: options.runId,
      actor: options.actor ?? 'independent-endpoint',
      now: options.now,
      durability: options.durability,
    });
    return new IndependentEffectLedger(directory, ledger);
  }

  async recordAttempt(input: { operation: string; requestId: string; endpoint?: string; causalKey?: string }): Promise<void> {
    await this.ledger.append({
      kind: 'effect.attempt',
      identity: { requestId: input.requestId, ...(input.causalKey === undefined ? {} : { causalKey: input.causalKey }) },
      payload: { operation: input.operation, requestId: input.requestId, endpoint: input.endpoint ?? null },
      ...(input.causalKey === undefined ? {} : { causalKey: input.causalKey }),
    });
  }

  /**
   * Record an actual execution. A repeated (effectId, requestId) execution
   * is suppressed and audited instead of double-counted; a duplicate with a
   * different requestId is still recorded so the accounting oracle can flag
   * the duplicate non-idempotent effect.
   */
  async recordExecution(input: EffectExecutionInput): Promise<ExecutionRecordResult> {
    const read = await this.ledger.read();
    const previous = read.records.filter(
      record => record.kind === 'effect.execution' && record.identity?.effectId === input.effectId && record.identity?.requestId === input.requestId,
    );
    if (previous.length > 0) {
      await this.ledger.append({
        kind: 'effect.duplicate-suppressed',
        identity: { effectId: input.effectId, requestId: input.requestId },
        payload: { operation: input.operation, reason: 'same effectId/requestId already executed' },
      });
      return { recorded: false, duplicateSuppressed: true, executionIndex: previous.length };
    }
    const executionsForEffect = read.records.filter(record => record.kind === 'effect.execution' && record.identity?.effectId === input.effectId).length;
    await this.ledger.append({
      kind: 'effect.execution',
      identity: { effectId: input.effectId, requestId: input.requestId },
      payload: {
        operation: input.operation,
        idempotency: input.idempotency,
        payloadDigest: input.payloadDigest,
        endpoint: input.endpoint ?? null,
        executionIndex: executionsForEffect + 1,
      },
    });
    return { recorded: true, duplicateSuppressed: false, executionIndex: executionsForEffect + 1 };
  }

  async recordReceipt(input: { effectId: string; receiptId: string; status: 'accepted' | 'delivered'; evidenceRef?: string }): Promise<void> {
    await this.ledger.append({
      kind: 'effect.receipt',
      identity: { effectId: input.effectId, receiptId: input.receiptId },
      payload: { status: input.status, evidenceRef: input.evidenceRef ?? null },
    });
  }

  async recordReceiptLost(input: { effectId: string; reason: string }): Promise<void> {
    await this.ledger.append({
      kind: 'effect.receipt-lost',
      identity: { effectId: input.effectId },
      payload: { reason: input.reason },
    });
  }

  async read(): Promise<LedgerRead> {
    return this.ledger.read();
  }

  async summary(effectId: string): Promise<EffectSummary> {
    const read = await this.ledger.read();
    return summarizeEffect(read.records, effectId);
  }

  /** Judge one effect against what the product currently knows. */
  async check(input: { effectId: string; productKnowledge: EffectObservation['productKnowledge']; idempotent?: boolean }): Promise<CheckResult> {
    const read = await this.ledger.read();
    const summary = summarizeEffect(read.records, input.effectId);
    const effect: EffectObservation = {
      effectId: input.effectId,
      operation: summary.operations[0] ?? 'unknown',
      idempotent: input.idempotent ?? true,
      attempts: summary.attempts,
      executions: summary.executions,
      receipts: summary.receipts,
      productKnowledge: input.productKnowledge,
    };
    return checkEffectAccounting([effect]);
  }

  /**
   * Verify the observer ledger is physically separate from the product
   * data root. Same machine/user is not a secrecy boundary; this only
   * prevents recording observer facts inside the product's own store.
   */
  checkIndependence(input: { productRoot: string }): CheckResult {
    const violations: Violation[] = [];
    const productRoot = resolve(input.productRoot);
    const ledgerFile = resolve(this.ledger.file);
    const relation = relative(productRoot, ledgerFile);
    const inside = relation.length > 0 && !relation.startsWith('..') && !relation.startsWith('/');
    if (inside) {
      violations.push(
        violation('observer_file_inside_product_root', '$', `observer ledger ${renderRelative(ledgerFile)} lives inside the product root`, {
          productRoot: '<product-root>',
          ledgerFile: '<product-root>/observer',
        }),
      );
    }
    if (ledgerFile === productRoot) violations.push(violation('observer_not_separate', '$', 'observer file and product root are the same path'));
    if (resolve(this.directory) === productRoot) violations.push(violation('observer_not_separate', '$', 'observer directory equals the product root'));
    return finish(
      {
        oracle: 'observer-independence',
        version: '1.1.0',
        boundary: '检查观察器账本路径不在产品数据根内；同一机器/用户下的两个目录仍不构成秘密隔离，不证明 HOLDOUT 隔离。',
        scope: 'observer-independence',
      },
      2,
      violations,
      { separateRoots: violations.length === 0 },
    );
  }

  async close(): Promise<void> {
    await this.ledger.close();
  }
}

function renderRelative(file: string): string {
  const parts = file.split('/');
  return parts.length <= 2 ? file : `…/${parts.slice(-2).join('/')}`;
}

function summarizeEffect(records: readonly LedgerRecord[], effectId: string): EffectSummary {
  const operations = new Set<string>();
  let attempts = 0;
  let executions = 0;
  let receipts = 0;
  let receiptsLost = 0;
  let duplicateSuppressed = 0;
  for (const record of records) {
    const recordEffect = record.identity?.effectId;
    if (record.kind === 'effect.attempt' && record.identity?.requestId !== undefined) attempts++;
    if (recordEffect !== effectId && record.kind !== 'effect.attempt') continue;
    if (record.kind === 'effect.attempt' && record.payload !== null && typeof record.payload === 'object' && !Array.isArray(record.payload)) {
      const operation = (record.payload as Record<string, JsonValue>).operation;
      if (typeof operation === 'string') operations.add(operation);
    }
    if (record.kind === 'effect.execution' && recordEffect === effectId) {
      executions++;
      const operation = (record.payload as Record<string, JsonValue>).operation;
      if (typeof operation === 'string') operations.add(operation);
    }
    if (record.kind === 'effect.receipt' && recordEffect === effectId) receipts++;
    if (record.kind === 'effect.receipt-lost' && recordEffect === effectId) receiptsLost++;
    if (record.kind === 'effect.duplicate-suppressed' && recordEffect === effectId) duplicateSuppressed++;
  }
  return { effectId, operations: [...operations], attempts, executions, receipts, receiptsLost, duplicateSuppressed };
}

/* ------------------------------------------------------------------ */
/* Independent counters and causal pairing.                            */
/* ------------------------------------------------------------------ */

export function checkCounterAgreement(
  independent: Readonly<Record<string, number>>,
  product: Readonly<Record<string, number>>,
  options: { keys?: readonly string[] } = {},
): CheckResult {
  const violations: Violation[] = [];
  const keys = options.keys ?? [...new Set([...Object.keys(independent), ...Object.keys(product)])].sort();
  for (const key of keys) {
    const independentValue = independent[key];
    const productValue = product[key];
    if (independentValue === undefined) {
      violations.push(violation('missing_independent_counter', jsonPointerChild('$["independent"]', key), `no independent observation for ${key}; product value ${String(productValue)} is not verified`));
      continue;
    }
    if (productValue === undefined) {
      violations.push(violation('missing_product_counter', jsonPointerChild('$["product"]', key), `product does not expose ${key}; independent value is ${independentValue}`));
      continue;
    }
    if (independentValue !== productValue) {
      violations.push(
        violation('counter_disagreement', jsonPointerChild('$["product"]', key), `product reports ${productValue}, independent observation is ${independentValue}`, {
          key,
          product: productValue,
          independent: independentValue,
        }),
      );
    }
  }
  return finish(
    {
      oracle: 'observer-counter',
      version: '1.1.0',
      boundary: '按独立观察计数核对产品自报计数；缺失独立计数不等于 0，计数不一致即证据失败。不证明计数口径相同。',
      scope: 'counter-agreement',
    },
    keys.length,
    violations,
  );
}

export interface ObserverCausalInput {
  readonly records: readonly LedgerRecord[];
  readonly productFacts: readonly { readonly kind: string; readonly id: string; readonly causalKey: string; readonly status?: 'success' | 'unknown' | 'failed' | 'skipped' | 'info' }[];
  readonly expectedRunId: string;
  readonly requiredKinds?: { readonly product: readonly string[]; readonly observer: readonly string[] };
}

/** Align ledger records with product facts by explicit causal keys. */
export function alignObserverWithProduct(input: ObserverCausalInput): CheckResult {
  const facts = input.records.map(record => ({
    side: 'observer' as const,
    runId: record.runId,
    kind: record.kind,
    id: typeof record.hash === 'string' ? record.hash.slice(0, 16) : String(record.seq),
    causalKey: record.causalKey ?? record.identity?.effectId?.toString() ?? `seq:${record.seq}`,
    status: 'info' as const,
  }));
  const product = input.productFacts.map(fact => ({ side: 'product' as const, runId: input.expectedRunId, ...fact }));
  return checkCausalAlignment({ expectedRunId: input.expectedRunId, facts: [...product, ...facts], requiredKinds: input.requiredKinds });
}

/* ------------------------------------------------------------------ */
/* Self-proofs.                                                        */
/* ------------------------------------------------------------------ */

const OBSERVER_BOUNDARY =
  '独立 append-only JSONL 账本：fsync 持久、序号连续、SHA256 前后哈希链；截断尾/坏行/失序/篡改/错 run 均报告。' +
  '接收端效果账本区分 attempt/execution/receipt/lost/duplicate；执行一次但回执丢失时效果数仍为 1，产品可保持 unknown。' +
  '哈希链不是签名，两个目录不构成秘密隔离。';

async function tempDirectory(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  return mkdtemp(join(tmpdir(), prefix));
}

function combine(...results: CheckResult[]): CheckResult {
  const violations = results.flatMap(result => result.violations);
  const metrics: Record<string, JsonValue> = {};
  for (const result of results) Object.assign(metrics, result.metrics);
  return finish(
    { oracle: 'observer-ledger', version: '1.1.0', boundary: OBSERVER_BOUNDARY, scope: 'scenario' },
    results.reduce((sum, result) => sum + result.checked, 0),
    violations,
    metrics,
  );
}

export const observerCounterSelfProof: OracleSelfProof = {
  name: 'observer-counter',
  version: '1.1.0',
  module: 'tests/harness/observer.ts',
  boundary: '按独立观察计数核对产品自报计数：缺失独立计数不是 0，计数不一致即证据失败；不证明计数口径相同。',
  evaluate: input => {
    const { independent, product, keys } = input as {
      independent: Record<string, number>;
      product: Record<string, number>;
      keys?: string[];
    };
    return checkCounterAgreement(independent, product, { keys });
  },
  samples: [
    {
      label: 'accept-independent-counter-agreement',
      input: { independent: { executions: 1, receipts: 0, attempts: 2 }, product: { executions: 1, receipts: 0, attempts: 2 } },
      expect: 'accept',
      why: '独立接收端与产品自报计数一致',
    },
    {
      label: 'reject-counter-disagreement',
      input: { independent: { executions: 1 }, product: { executions: 2 } },
      expect: 'reject',
      expectCodes: ['counter_disagreement'],
      why: '产品自报执行 2 次而独立端只看到 1 次',
    },
    {
      label: 'reject-missing-independent-counter',
      input: { independent: {}, product: { executions: 1 } },
      expect: 'reject',
      expectCodes: ['missing_independent_counter'],
      why: '没有独立观察时产品计数不能当作已核',
    },
  ],
};

export const observerSelfProof: OracleSelfProof = {
  name: 'observer-ledger',
  version: '1.1.0',
  module: 'tests/harness/observer.ts',
  boundary: OBSERVER_BOUNDARY,
  scenarios: [
    {
      label: 'accept-executed-once-lost-receipt-stays-unknown',
      expect: 'accept',
      why: '端点执行一次后丢回执：独立效果数为 1，产品保持 unknown；同 requestId 重试被抑制；凭回执才可收敛，无回执宣称成功被拒',
      run: async () => {
        const directory = await tempDirectory('shiyu-observer-effect-');
        const ledger = await IndependentEffectLedger.open({ directory, runId: 'run-observer-1' });
        try {
          await ledger.recordAttempt({ operation: 'message.send', requestId: 'req-1' });
          const first = await ledger.recordExecution({
            effectId: 'effect-1',
            operation: 'message.send',
            requestId: 'req-1',
            idempotency: 'non-idempotent',
            payloadDigest: sha256Hex('synthetic-message'),
          });
          await ledger.recordReceiptLost({ effectId: 'effect-1', reason: 'socket closed after write' });
          const retry = await ledger.recordExecution({
            effectId: 'effect-1',
            operation: 'message.send',
            requestId: 'req-1',
            idempotency: 'non-idempotent',
            payloadDigest: sha256Hex('synthetic-message'),
          });
          const unknownCheck = await ledger.check({ effectId: 'effect-1', productKnowledge: 'unknown', idempotent: false });
          const successCheck = await ledger.check({ effectId: 'effect-1', productKnowledge: 'succeeded', idempotent: false });
          const summary = await ledger.summary('effect-1');
          const violations: Violation[] = [];
          if (!first.recorded) violations.push(violation('execution_not_recorded', '$', 'first execution was not recorded'));
          if (!retry.duplicateSuppressed) violations.push(violation('duplicate_not_suppressed', '$', 'same requestId execution was not suppressed'));
          if (summary.executions !== 1) violations.push(violation('effect_count_not_one', '$', `expected 1 execution, got ${summary.executions}`));
          if (summary.receipts !== 0) violations.push(violation('unexpected_receipt', '$', 'lost receipt must not be recorded as delivered'));
          if (successCheck.ok) violations.push(violation('success_without_receipt_accepted', '$', 'success without independent receipt must be rejected'));
          return combine(
            finish({ oracle: 'observer-ledger', version: '1.1.0', boundary: OBSERVER_BOUNDARY, scope: 'lost-receipt' }, 6, violations, {
              executions: summary.executions,
              receipts: summary.receipts,
              duplicateSuppressed: summary.duplicateSuppressed,
            }),
            unknownCheck,
          );
        } finally {
          await ledger.close();
          const { rm } = await import('node:fs/promises');
          await rm(directory, { recursive: true, force: true });
        }
      },
    },
    {
      label: 'accept-truncated-tail-repaired-and-audited',
      expect: 'accept',
      why: '模拟崩溃留下的半行 JSONL：读取必须报告 truncated_tail 而不是静默跳过；显式重新打开可截断修复并继续追加修复记录',
      run: async () => {
        const directory = await tempDirectory('shiyu-observer-repair-');
        const file = join(directory, 'ledger.jsonl');
        try {
          const first = await AppendOnlyLedger.open({ file, runId: 'run-repair', actor: 'observer' });
          await first.append({ kind: 'effect.attempt', payload: { operation: 'note.write' } });
          await first.append({ kind: 'effect.execution', payload: { operation: 'note.write' } });
          await first.close();
          const { appendFile } = await import('node:fs/promises');
          await appendFile(file, '{"schemaVersion":1,"runId":"run-rep');
          const broken = await readLedgerFile(file, { expectedRunId: 'run-repair' });
          const brokenCheck = checkLedgerIntegrity(broken);
          const repaired = await AppendOnlyLedger.open({ file, runId: 'run-repair', actor: 'observer', repairPolicy: 'truncate-tail' });
          await repaired.append({ kind: 'effect.receipt', payload: { status: 'delivered' } });
          await repaired.close();
          const healed = await readLedgerFile(file, { expectedRunId: 'run-repair' });
          const violations: Violation[] = [];
          if (broken.issues.every(issue => issue.code !== 'truncated_tail')) {
            violations.push(violation('truncated_tail_not_reported', '$', 'partial final line was not reported as truncated_tail'));
          }
          if (brokenCheck.ok) violations.push(violation('broken_ledger_accepted', '$', 'ledger with a truncated tail passed the integrity gate'));
          if (!healed.ok) violations.push(...healed.issues.map(issue => violation(issue.code, '$', issue.message)));
          const repairRecords = healed.records.filter(record => record.kind === 'ledger.repair');
          if (repairRecords.length !== 1) violations.push(violation('repair_not_audited', '$', `expected one ledger.repair record, got ${repairRecords.length}`));
          if (healed.records.filter(record => record.kind !== 'ledger.repair').length !== 3) {
            violations.push(violation('repaired_record_count', '$', 'repaired ledger lost or duplicated complete records'));
          }
          return finish({ oracle: 'observer-ledger', version: '1.1.0', boundary: OBSERVER_BOUNDARY, scope: 'truncated-tail' }, 5, violations, {
            truncatedTailBytes: broken.stats.truncatedTailBytes,
            repairedRecords: healed.records.length,
          });
        } finally {
          const { rm } = await import('node:fs/promises');
          await rm(directory, { recursive: true, force: true });
        }
      },
    },
    {
      label: 'reject-tampered-record-detected',
      expect: 'reject',
      expectCodes: ['hash_mismatch'],
      why: '直接改写账本中间记录后，读取必须报告 hash_mismatch，不能把篡改后的内容当证据',
      run: async () => {
        const directory = await tempDirectory('shiyu-observer-tamper-');
        const file = join(directory, 'ledger.jsonl');
        try {
          const ledger = await AppendOnlyLedger.open({ file, runId: 'run-tamper', actor: 'observer' });
          await ledger.append({ kind: 'effect.attempt', payload: { operation: 'message.send', requestId: 'req-1' } });
          await ledger.append({ kind: 'effect.execution', payload: { operation: 'message.send', requestId: 'req-1' } });
          await ledger.close();
          const { readFile: read, writeFile } = await import('node:fs/promises');
          const text = await read(file, 'utf8');
          const tampered = text.replace('"requestId":"req-1"', '"requestId":"req-2"');
          if (tampered === text) throw new Error('tamper fixture did not change the ledger');
          await writeFile(file, tampered);
          const result = await readLedgerFile(file, { expectedRunId: 'run-tamper' });
          return checkLedgerIntegrity(result);
        } finally {
          const { rm } = await import('node:fs/promises');
          await rm(directory, { recursive: true, force: true });
        }
      },
    },
    {
      label: 'reject-observer-inside-product-root',
      expect: 'reject',
      expectCodes: ['observer_file_inside_product_root'],
      why: '观察器账本落在产品数据根内时，产品崩溃/清理会一并带走证据，独立性不成立',
      run: async () => {
        const directory = await tempDirectory('shiyu-observer-independence-');
        const productRoot = join(directory, 'product');
        const observerDir = join(productRoot, 'observer');
        const ledger = await IndependentEffectLedger.open({ directory: observerDir, runId: 'run-independence' });
        try {
          return ledger.checkIndependence({ productRoot });
        } finally {
          await ledger.close();
          const { rm } = await import('node:fs/promises');
          await rm(directory, { recursive: true, force: true });
        }
      },
    },
    {
      label: 'accept-separate-observer-root',
      expect: 'accept',
      why: '观察器目录与产品数据根分离时可以取证',
      run: async () => {
        const directory = await tempDirectory('shiyu-observer-separate-');
        const productRoot = join(directory, 'product');
        const observerDir = join(directory, 'observer');
        const ledger = await IndependentEffectLedger.open({ directory: observerDir, runId: 'run-separate' });
        try {
          return ledger.checkIndependence({ productRoot });
        } finally {
          await ledger.close();
          const { rm } = await import('node:fs/promises');
          await rm(directory, { recursive: true, force: true });
        }
      },
    },
  ],
};
