/**
 * Thin public-MCP boundary for audited Ombre-Brain 3.6.14. No memory store,
 * Python internals, fallback, retry, daemon, or model client is owned here.
 * API shapes were independently implemented from the pinned public signatures;
 * no upstream implementation is copied. See README.md for evidence and limits.
 */
export const OMBRE_AUDITED_SOURCE = Object.freeze({
  version: '3.6.14',
  revision: '115d831d979bf67efc7150f976e2cb34c333c935',
});

export const OMBRE_CAPABILITIES = Object.freeze({
  automaticWrites: false,
  nativeIdempotency: false,
  atomicCompareAndSwap: false,
  perRequestNamespace: false,
  deletionProof: false,
  lifecycleSideEffects: true,
} as const);

export interface OmbreDeploymentBinding {
  /** Trusted host configuration, never fields accepted from an agent's body. */
  backendId: string;
  vaultScope: string;
  /** Evidence for deployment/config verification; this is not a remote attestation. */
  deploymentEvidenceRef: string;
  version: typeof OMBRE_AUDITED_SOURCE.version;
  revision: typeof OMBRE_AUDITED_SOURCE.revision;
  relationsDisabled: true;
  /** Reads can start native decay and write logs/notices. Authorization must include this. */
  nativeLifecycleAuthorized: true;
}

export interface OmbreMcpRequest {
  name: 'breath_advanced' | 'feel' | 'I';
  arguments: Readonly<Record<string, string | number | boolean>>;
}

export interface OmbreMcpTransport {
  /**
   * Supply an existing trusted MCP client. It owns authentication, connection,
   * deadlines and cancellation. It MUST NOT retry these tools automatically:
   * even a retrieval can trigger native lifecycle side effects.
   */
  callTool(request: OmbreMcpRequest): Promise<unknown>;
}

export interface OmbreRetrievalRequest {
  /** Trusted routing scope. Domain is a topical filter, never an ACL. */
  scope: string;
  query: string;
  maxTokens?: number;
  maxResults?: number;
  domain?: string;
}

export interface OmbreTextObservation {
  kind: 'unverified-backend-text';
  backendId: string;
  vaultScope: string;
  tool: OmbreMcpRequest['name'];
  text: string;
  /** A detected error is useful; false never proves semantic success. */
  reportsBackendError: boolean;
  /** Only untrusted reference hints, never authorization, CAS, or a write receipt. */
  resultIds:
    | { status: 'absent' | 'invalid'; nativeIds: readonly [] }
    | { status: 'unverified'; nativeIds: readonly string[]; omittedByPolicy: number };
}

export class OmbreBoundaryError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'SCOPE_MISMATCH' | 'UNSUPPORTED_DEPLOYMENT'
    | 'INVALID_RESPONSE' | 'RESPONSE_TOO_LARGE' | 'TOOL_ERROR', message: string) {
    super(message);
    this.name = 'OmbreBoundaryError';
  }
}

const ID_MARKER = '=== ombre:result-ids ===';
const utf8Bytes = (value: string) => Buffer.byteLength(value, 'utf8');

function textValue(value: unknown, field: string, maximum: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && value.trim().length === 0)
      || utf8Bytes(value) > maximum || value.includes('\u0000')) {
    throw new OmbreBoundaryError('INVALID_INPUT', `Invalid ${field}`);
  }
  return value;
}

function integer(value: unknown, fallback: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new OmbreBoundaryError('INVALID_INPUT', `Invalid ${field}`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resultIds(text: string): OmbreTextObservation['resultIds'] {
  const markerAt = text.indexOf(ID_MARKER);
  if (markerAt < 0) return { status: 'absent', nativeIds: [] };
  // A stored memory may contain a forged marker; do not choose between duplicates.
  if (text.indexOf(ID_MARKER, markerAt + ID_MARKER.length) >= 0) {
    return { status: 'invalid', nativeIds: [] };
  }
  const match = /^\r?\n```json\r?\n([^\r\n]+)\r?\n```(?:\r?\n|$)/.exec(
    text.slice(markerAt + ID_MARKER.length),
  );
  if (!match) return { status: 'invalid', nativeIds: [] };
  try {
    const parsed: unknown = JSON.parse(match[1]!);
    if (!isRecord(parsed) || parsed.schema !== 1 || parsed.mode !== 'automatic'
        || !Array.isArray(parsed.bucket_ids) || parsed.bucket_ids.length > 50
        || parsed.count !== parsed.bucket_ids.length || !Number.isSafeInteger(parsed.omitted_by_policy)
        || (parsed.omitted_by_policy as number) < 0
        || parsed.bucket_ids.some(id => typeof id !== 'string' || !id.trim()
          || utf8Bytes(id) > 512 || /[\r\n\u0000]/.test(id))
        || new Set(parsed.bucket_ids).size !== parsed.bucket_ids.length) {
      return { status: 'invalid', nativeIds: [] };
    }
    return {
      status: 'unverified', nativeIds: Object.freeze([...parsed.bucket_ids] as string[]),
      omittedByPolicy: parsed.omitted_by_policy as number,
    };
  } catch {
    return { status: 'invalid', nativeIds: [] };
  }
}

/**
 * Core-only adapter, not a tool exposed to replyers or agent-controlled JSON.
 * A matching scope does not authenticate an actor. The caller must authorize
 * access before invoking this object. Bind one instance to one isolated vault;
 * it cannot safely share a vault between mutually private audiences.
 *
 * This API deliberately has no hold, trace, dream, write-I, export, or delete.
 * Enabling those requires a separately reviewed MemoryOperation dispatch path.
 */
export class OmbrePublicApiAdapter {
  readonly capabilities = OMBRE_CAPABILITIES;
  readonly binding: Readonly<OmbreDeploymentBinding>;
  readonly #transport: OmbreMcpTransport;
  readonly #maxResponseBytes: number;

  constructor(transport: OmbreMcpTransport, binding: OmbreDeploymentBinding,
    options: { maxResponseBytes?: number } = {}) {
    if (!isRecord(binding) || binding.version !== OMBRE_AUDITED_SOURCE.version
        || binding.revision !== OMBRE_AUDITED_SOURCE.revision
        || binding.relationsDisabled !== true || binding.nativeLifecycleAuthorized !== true) {
      throw new OmbreBoundaryError('UNSUPPORTED_DEPLOYMENT', 'Deployment does not match the audited boundary');
    }
    for (const key of ['backendId', 'vaultScope', 'deploymentEvidenceRef'] as const) {
      textValue(binding[key], key, 512);
    }
    this.binding = Object.freeze({ ...binding });
    this.#transport = transport;
    this.#maxResponseBytes = integer(options.maxResponseBytes, 262144, 1048576, 'maxResponseBytes');
  }

  async search(request: OmbreRetrievalRequest): Promise<OmbreTextObservation> {
    this.#assertScope(request.scope);
    return this.#call({ name: 'breath_advanced', arguments: {
      query: textValue(request.query, 'query', 16384),
      max_tokens: integer(request.maxTokens, 4000, 10000, 'maxTokens'),
      max_results: integer(request.maxResults, 10, 50, 'maxResults'),
      domain: textValue(request.domain ?? '', 'domain', 512, true),
      mode: 'automatic', with_ids: true, catalog: false, quotes: false,
    } });
  }

  async readFeel(request: Pick<OmbreRetrievalRequest, 'scope' | 'query' | 'maxTokens'>): Promise<OmbreTextObservation> {
    this.#assertScope(request.scope);
    return this.#call({ name: 'feel', arguments: {
      query: textValue(request.query, 'query', 16384),
      max_tokens: integer(request.maxTokens, 4000, 10000, 'maxTokens'),
    } });
  }

  async readI(request: { scope: string; limit?: number }): Promise<OmbreTextObservation> {
    this.#assertScope(request.scope);
    return this.#call({ name: 'I', arguments: {
      read: true, content: '', aspect: '', promote: '', supersedes: '',
      limit: integer(request.limit, 20, 50, 'limit'),
    } });
  }

  #assertScope(scope: unknown): void {
    if (scope !== this.binding.vaultScope) {
      throw new OmbreBoundaryError('SCOPE_MISMATCH', 'Request is outside the bound vault scope');
    }
  }

  async #call(request: OmbreMcpRequest): Promise<OmbreTextObservation> {
    // No catch-and-retry: transport rejection propagates once with its cause.
    const result = await this.#transport.callTool(request);
    if (!isRecord(result) || (result.isError !== undefined && typeof result.isError !== 'boolean')
        || !Array.isArray(result.content) || result.content.length < 1 || result.content.length > 64) {
      throw new OmbreBoundaryError('INVALID_RESPONSE', 'Expected bounded MCP text content');
    }
    if (result.isError === true) throw new OmbreBoundaryError('TOOL_ERROR', 'Ombre reported a tool error');
    const chunks: string[] = [];
    let bytes = 0;
    for (const item of result.content) {
      if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') {
        throw new OmbreBoundaryError('INVALID_RESPONSE', 'Unexpected MCP content type');
      }
      bytes += utf8Bytes(item.text) + (chunks.length ? 1 : 0);
      if (bytes > this.#maxResponseBytes) {
        throw new OmbreBoundaryError('RESPONSE_TOO_LARGE', 'Ombre response exceeded the configured byte bound');
      }
      chunks.push(item.text);
    }
    const text = chunks.join('\n');
    return {
      kind: 'unverified-backend-text', backendId: this.binding.backendId,
      vaultScope: this.binding.vaultScope, tool: request.name, text,
      reportsBackendError: text.includes('[OB-E004]'),
      resultIds: request.name === 'breath_advanced' ? resultIds(text) : { status: 'absent', nativeIds: [] },
    };
  }
}
