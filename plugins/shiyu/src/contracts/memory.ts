import { createHash } from 'node:crypto';

/** Ordinary-memory create contract shared by the control domain and private backend. */
export interface MemoryCreateCommand {
  schemaVersion: 1; kind: 'create'; operationId: string; backendId: string; scope: string;
  targetRef: string; bodyDigest: string; bodyBytes: number;
  sourceRefs: { sourceId: string; revision: number }[];
}
export const MAX_MEMORY_BODY_BYTES = 16384;
/** Trusted private-adapter observation carried over internal Worker IPC, never accepted from a public command. */
export interface MemoryBackendObservation {
  command: MemoryCreateCommand; commandDigest: string; deploymentId: string; nativeId: string;
  receiptId: string; componentVersion: string; bodyDigest: string; bodyBytes: number;
  sourceRefs: MemoryCreateCommand['sourceRefs']; observedAt: string;
}
export class MemoryContractError extends Error {
  constructor(readonly code: 'INVALID_MEMORY_COMMAND' | 'INVALID_MEMORY_BODY' | 'MEMORY_BODY_MISMATCH') {
    super(code); this.name = 'MemoryContractError';
  }
}
function invalid(): never { throw new MemoryContractError('INVALID_MEMORY_COMMAND'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(fields).length !== keys.length || keys.some(key => !Object.hasOwn(fields, key))
    || Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) return invalid();
  return value as Record<string, unknown>;
}
function identity(value: unknown, max = 200): string {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9:._\/-]{0,199}$/.test(value)) return invalid();
  return value;
}
function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) return invalid();
  return value as number;
}
/** Refuses ambiguous envelopes rather than changing an approved intent. */
export function validateMemoryCreateCommand(value: unknown): MemoryCreateCommand {
  const raw = record(value, ['schemaVersion', 'kind', 'operationId', 'backendId', 'scope', 'targetRef', 'bodyDigest', 'bodyBytes', 'sourceRefs']);
  if (raw.schemaVersion !== 1 || raw.kind !== 'create' || typeof raw.bodyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(raw.bodyDigest)
    || !Array.isArray(raw.sourceRefs) || !raw.sourceRefs.length || raw.sourceRefs.length > 32) return invalid();
  const sourceRefs = raw.sourceRefs.map(value => {
    const source = record(value, ['sourceId', 'revision']);
    return { sourceId: identity(source.sourceId), revision: positive(source.revision) };
  });
  if (sourceRefs.some((source, index) => index > 0 && sourceRefs[index - 1]!.sourceId >= source.sourceId)) return invalid();
  return { schemaVersion: 1, kind: 'create', operationId: identity(raw.operationId, 150), backendId: identity(raw.backendId),
    scope: identity(raw.scope), targetRef: identity(raw.targetRef), bodyDigest: raw.bodyDigest,
    bodyBytes: positive(raw.bodyBytes, MAX_MEMORY_BODY_BYTES), sourceRefs };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Sorted ASCII keys, valid UTF-8 values, safe integers, no whitespace; mirrored by the Python service. */
export function canonicalMemoryCommand(command: MemoryCreateCommand): string { return canonical(validateMemoryCreateCommand(command)); }
export function memoryCommandDigest(command: MemoryCreateCommand): string { return createHash('sha256').update(canonicalMemoryCommand(command)).digest('hex'); }
/** Caller explicitly normalizes owner input before this boundary; dispatch never changes it. */
export function memoryBodyDigest(body: string): { bodyDigest: string; bodyBytes: number } {
  if (typeof body !== 'string' || !body.trim() || body !== body.trim() || /\p{Surrogate}/u.test(body)
    || /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(body)) throw new MemoryContractError('INVALID_MEMORY_BODY');
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > MAX_MEMORY_BODY_BYTES) throw new MemoryContractError('INVALID_MEMORY_BODY');
  return { bodyDigest: createHash('sha256').update(body, 'utf8').digest('hex'), bodyBytes };
}
export function assertMemoryBody(command: MemoryCreateCommand, body: string): void {
  const observed = memoryBodyDigest(body);
  if (observed.bodyDigest !== command.bodyDigest || observed.bodyBytes !== command.bodyBytes) throw new MemoryContractError('MEMORY_BODY_MISMATCH');
}
