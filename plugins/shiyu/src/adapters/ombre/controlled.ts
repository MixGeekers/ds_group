import { assertMemoryBody, canonicalMemoryCommand, memoryBodyDigest, memoryCommandDigest, validateMemoryCreateCommand,
  type MemoryBackendObservation, type MemoryCreateCommand } from '../../contracts/memory.js';
import { memoryIndexCommandDigest, validateMemoryIndexCommand, validateMemoryIndexObservation, validateMemorySearchRequest,
  validateMemorySearchResult, validateSemanticBackendStatus, type MemoryIndexCommand, type MemoryIndexObservation,
  type MemorySearchRequest, type MemorySearchResult, type SemanticBackendStatus } from '../../contracts/semantic-memory.js';

export interface ControlledOmbreBinding { backendId: string; deploymentId: string; scope: 'local-owner' }
export interface MemoryCallOptions { signal?: AbortSignal; timeoutMs?: number }
export interface ControlledOmbreOptions {
  /** Trusted protocol selection, never inferred from a remote response. */
  semanticApi?: boolean;
  now?: () => number;
  onSemanticObservation?(observation: SemanticBackendStatus | MemoryIndexObservation | MemorySearchResult): void;
}
export interface ControlledMemoryTransport {
  callTool(request: { name: string; arguments: Readonly<Record<string, unknown>> }, options?: MemoryCallOptions): Promise<unknown>;
}
export interface NativeMemoryReceipt {
  schemaVersion: 1; receiptId: string; operationId: string; backendId: string; deploymentId: string; scope: string;
  commandDigest: string; nativeId: string; bodyDigest: string; bodyBytes: number; sourceRefs: MemoryCreateCommand['sourceRefs'];
  componentVersion: string; outcome: 'applied'; bodyDurable: true; indexState: 'disabled' | 'unknown'; observedAt: string; reconciled: boolean;
}
export interface MemoryOperationObservation {
  schemaVersion: 1; backendId: string; deploymentId: string; scope: string; operationId: string;
  state: 'absent' | 'unknown' | 'applied' | 'rejected'; command: MemoryCreateCommand | null; commandDigest: string | null;
  plannedNativeId: string | null; nativeId: string | null; receipt: NativeMemoryReceipt | null; reason: string | null;
}
export class ControlledOmbreError extends Error {
  constructor(readonly code: 'INVALID_BINDING' | 'INVALID_RESPONSE' | 'TOOL_ERROR' | 'IDENTITY_MISMATCH' | 'UNSETTLED_OPERATION' | 'NATIVE_MISMATCH' | 'SEMANTIC_DISABLED' | 'DEADLINE_EXCEEDED') {
    super(`Controlled memory ${code}`); this.name = 'ControlledOmbreError';
  }
}
function fail(code: ControlledOmbreError['code'] = 'INVALID_RESPONSE'): never { throw new ControlledOmbreError(code); }
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return fail();
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const nativeId = (value: unknown): value is string => typeof value === 'string' && /^shiyu_[a-f0-9]{32}$/.test(value);
const instant = (value: unknown): value is string => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validReason = (value: unknown) => value === null || (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value));

/** Private typed service extension. No raw grow/hold, fallback, retry, or implicit connection. */
export class ControlledOmbreAdapter {
  readonly binding: Readonly<ControlledOmbreBinding>;
  private readonly semanticApi: boolean;
  constructor(private readonly transport: ControlledMemoryTransport, binding: ControlledOmbreBinding, private readonly options: ControlledOmbreOptions = {}) {
    if (!binding || binding.scope !== 'local-owner' || [binding.backendId, binding.deploymentId].some(value => typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._\/-]{0,199}$/.test(value))) fail('INVALID_BINDING');
    this.binding = Object.freeze({ backendId: binding.backendId, deploymentId: binding.deploymentId, scope: binding.scope });
    if (options.semanticApi !== undefined && typeof options.semanticApi !== 'boolean') fail('INVALID_BINDING');
    this.semanticApi = options.semanticApi === true;
  }
  private identity(raw: Record<string, unknown>): void {
    if (raw.schemaVersion !== 1 || raw.backendId !== this.binding.backendId || raw.deploymentId !== this.binding.deploymentId || raw.scope !== this.binding.scope) fail('IDENTITY_MISMATCH');
  }
  private command(value: unknown, expected: MemoryCreateCommand): MemoryCreateCommand {
    let parsed: MemoryCreateCommand;
    try { parsed = validateMemoryCreateCommand(value); } catch { return fail(); }
    if (canonicalMemoryCommand(parsed) !== canonicalMemoryCommand(expected)) return fail('IDENTITY_MISMATCH');
    return parsed;
  }
  private admitted(command: MemoryCreateCommand): MemoryCreateCommand {
    const parsed = validateMemoryCreateCommand(command);
    if (parsed.backendId !== this.binding.backendId || parsed.scope !== this.binding.scope) fail('IDENTITY_MISMATCH');
    return parsed;
  }
  private receipt(value: unknown, command: MemoryCreateCommand): NativeMemoryReceipt {
    const raw = fields(value, ['schemaVersion', 'receiptId', 'operationId', 'backendId', 'deploymentId', 'scope', 'commandDigest', 'nativeId', 'bodyDigest', 'bodyBytes', 'sourceRefs', 'componentVersion', 'outcome', 'bodyDurable', 'indexState', 'observedAt', 'reconciled']);
    this.identity(raw);
    if (raw.operationId !== command.operationId || raw.commandDigest !== memoryCommandDigest(command)
      || raw.bodyDigest !== command.bodyDigest || raw.bodyBytes !== command.bodyBytes || !same(raw.sourceRefs, command.sourceRefs)) fail('IDENTITY_MISMATCH');
    if (typeof raw.receiptId !== 'string' || !/^receipt_[a-f0-9]{64}$/.test(raw.receiptId) || !nativeId(raw.nativeId)
      || typeof raw.componentVersion !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(raw.componentVersion) || raw.outcome !== 'applied'
      || raw.bodyDurable !== true || !['disabled', 'unknown'].includes(String(raw.indexState)) || !instant(raw.observedAt) || typeof raw.reconciled !== 'boolean') fail();
    return structuredClone(raw) as unknown as NativeMemoryReceipt;
  }
  private async call(name: string, args: Record<string, unknown>, options: MemoryCallOptions): Promise<Record<string, unknown>> {
    options.signal?.throwIfAborted();
    const raw = await this.transport.callTool({ name, arguments: args }, options);
    options.signal?.throwIfAborted();
    if (!isRecord(raw) || raw.isError === true) fail('TOOL_ERROR');
    if (raw.isError !== undefined && raw.isError !== false) fail();
    if (Buffer.byteLength(JSON.stringify(raw)) > 131072 || !Array.isArray(raw.content) || raw.content.length !== 1
      || !isRecord(raw.content[0]) || raw.content[0].type !== 'text' || typeof raw.content[0].text !== 'string') fail();
    let parsed: unknown;
    try { parsed = JSON.parse(raw.content[0].text); } catch { return fail(); }
    if (!isRecord(parsed) || (raw.structuredContent !== undefined && !same(raw.structuredContent, parsed))) return fail();
    return parsed;
  }
  private statusResult(raw: Record<string, unknown>, expected: MemoryCreateCommand): MemoryOperationObservation {
    fields(raw, ['schemaVersion', 'backendId', 'deploymentId', 'scope', 'operationId', 'state', 'command', 'commandDigest', 'plannedNativeId', 'nativeId', 'receipt', 'reason']);
    this.identity(raw);
    if (raw.operationId !== expected.operationId) fail('IDENTITY_MISMATCH');
    if (!['absent', 'unknown', 'applied', 'rejected'].includes(String(raw.state)) || !validReason(raw.reason)) fail();
    if (raw.state === 'absent') {
      if (['command', 'commandDigest', 'plannedNativeId', 'nativeId', 'receipt'].some(key => raw[key] !== null)) fail();
    } else {
      this.command(raw.command, expected);
      if (raw.commandDigest !== memoryCommandDigest(expected) || !nativeId(raw.plannedNativeId)) fail('IDENTITY_MISMATCH');
      if (raw.state === 'applied') {
        const receipt = this.receipt(raw.receipt, expected);
        if (raw.nativeId !== receipt.nativeId || raw.nativeId !== raw.plannedNativeId || raw.reason !== null) fail('IDENTITY_MISMATCH');
      } else if (raw.nativeId !== null || raw.receipt !== null) fail();
    }
    return structuredClone(raw) as unknown as MemoryOperationObservation;
  }
  /** Dispatches once. This response alone is not a verified control-ledger receipt. */
  async create(command: MemoryCreateCommand, body: string, options: MemoryCallOptions = {}): Promise<MemoryOperationObservation> {
    const approved = this.admitted(command); assertMemoryBody(approved, body);
    return this.statusResult(await this.call('shiyu_memory_create', { command: approved, commandDigest: memoryCommandDigest(approved), body }, options), approved);
  }
  async operationStatus(command: MemoryCreateCommand, options: MemoryCallOptions = {}): Promise<MemoryOperationObservation> {
    const approved = this.admitted(command);
    return this.statusResult(await this.call('shiyu_memory_operation_status', { operationId: approved.operationId, scope: this.binding.scope }, options), approved);
  }
  /** Two independent public observations; body remains transient and never enters the control receipt. */
  async verifyApplied(command: MemoryCreateCommand, options: MemoryCallOptions = {}): Promise<{ observation: MemoryBackendObservation; body: string }> {
    const approved = this.admitted(command);
    const status = await this.operationStatus(approved, options);
    if (status.state !== 'applied' || !status.receipt || !status.nativeId) fail('UNSETTLED_OPERATION');
    const read = await this.call('shiyu_memory_get', { nativeId: status.nativeId, scope: this.binding.scope }, options);
    fields(read, ['schemaVersion', 'backendId', 'deploymentId', 'scope', 'state', 'nativeId', 'command', 'commandDigest', 'receipt', 'body', 'bodyDigest', 'componentVersion', 'reason']);
    this.identity(read);
    if (read.state !== 'found') fail('NATIVE_MISMATCH');
    this.command(read.command, approved);
    const receipt = this.receipt(read.receipt, approved);
    if (read.nativeId !== status.nativeId || read.commandDigest !== status.commandDigest || read.componentVersion !== receipt.componentVersion
      || read.bodyDigest !== approved.bodyDigest || read.reason !== null || !same(receipt, status.receipt) || typeof read.body !== 'string') fail('NATIVE_MISMATCH');
    assertMemoryBody(approved, read.body);
    // Recompute instead of trusting the server's declared digest/length.
    const body = memoryBodyDigest(read.body);
    return { body: read.body, observation: {
      command: approved, commandDigest: memoryCommandDigest(approved), deploymentId: this.binding.deploymentId,
      nativeId: receipt.nativeId, receiptId: receipt.receiptId, componentVersion: receipt.componentVersion,
      ...body, sourceRefs: structuredClone(approved.sourceRefs), observedAt: receipt.observedAt,
    } };
  }
  private semantic(): void { if (!this.semanticApi) fail('SEMANTIC_DISABLED'); }
  private deadline(deadlineAtMs: number, options: MemoryCallOptions): MemoryCallOptions {
    const remaining = deadlineAtMs - (this.options.now?.() ?? Date.now());
    if (!Number.isSafeInteger(deadlineAtMs) || remaining <= 0 || remaining > 60000) fail('DEADLINE_EXCEEDED');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60000)) fail('INVALID_RESPONSE');
    options.signal?.throwIfAborted();
    return { ...options, timeoutMs: Math.max(1, Math.min(Math.floor(remaining), options.timeoutMs ?? 60000)) };
  }
  private indexCommand(value: MemoryIndexCommand): MemoryIndexCommand {
    const command = validateMemoryIndexCommand(value);
    if (command.backendId !== this.binding.backendId || command.deploymentId !== this.binding.deploymentId || command.scope !== this.binding.scope) fail('IDENTITY_MISMATCH');
    return command;
  }
  /** Pure backend read; configured/profile-compatible is not a successful inference probe. */
  async backendStatus(options: MemoryCallOptions = {}): Promise<SemanticBackendStatus> {
    this.semantic();
    const result = validateSemanticBackendStatus(await this.call('shiyu_memory_backend_status', { scope: this.binding.scope }, options), this.binding);
    this.options.onSemanticObservation?.(result); return result;
  }
  /** One explicitly authorized indexing attempt. Independent indexStatus is required before control-ledger confirmation. */
  async ensureIndex(value: MemoryIndexCommand, options: MemoryCallOptions = {}): Promise<MemoryIndexObservation> {
    this.semantic(); const command = this.indexCommand(value);
    const raw = await this.call('shiyu_memory_index_ensure', { command, commandDigest: memoryIndexCommandDigest(command) }, this.deadline(command.deadlineAtMs, options));
    this.deadline(command.deadlineAtMs, options);
    const result = validateMemoryIndexObservation(raw, command);
    this.options.onSemanticObservation?.(result); return result;
  }
  /** Historical command deadlines do not prohibit an explicit, read-only outcome reconciliation. */
  async indexStatus(value: MemoryIndexCommand, options: MemoryCallOptions = {}): Promise<MemoryIndexObservation> {
    this.semantic(); const command = this.indexCommand(value);
    const result = validateMemoryIndexObservation(await this.call('shiyu_memory_index_status', { indexOperationId: command.indexOperationId, scope: this.binding.scope }, options), command);
    this.options.onSemanticObservation?.(result); return result;
  }
  /** Candidate metadata only; no returned ID grants authority to read a body. */
  async searchCandidates(value: MemorySearchRequest, options: MemoryCallOptions = {}): Promise<MemorySearchResult> {
    this.semantic(); const request = validateMemorySearchRequest(value);
    if (request.scope !== this.binding.scope) fail('IDENTITY_MISMATCH');
    const raw = await this.call('shiyu_memory_search_candidates', { ...request }, this.deadline(request.deadlineAtMs, options));
    this.deadline(request.deadlineAtMs, options);
    const result = validateMemorySearchResult(raw, request, this.binding);
    this.options.onSemanticObservation?.(result); return result;
  }
}
