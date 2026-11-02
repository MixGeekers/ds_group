import { createHash } from 'node:crypto';
import { ReadViewError, ReadViewService, type ReadView, type ViewInnerAuthority, type ViewSourceRef } from './index.js';
import {
  INNER_VIEW_BODY_FIELDS, INNER_VIEW_FIELDS, MEMORY_VIEW_BACKEND,
  type InnerBodyReadOutput, type LocalViewCapture, type MemoryViewSource,
} from '../adapters/control-store/view-domain.js';
import { assertMemoryBody, canonicalMemoryCommand, memoryCommandDigest, type MemoryBackendObservation } from '../contracts/memory.js';
import type { JsonValue } from '../contracts/events.js';
import {
  INNER_DOMAINS, INNER_DOMAIN_BACKENDS, validateInnerCapture,
  type InnerAuthority, type InnerCapture, type InnerDomain, type InnerSourceRef,
} from '../contracts/inner.js';

export interface LocalReadViewOptions {
  /** Trusted Worker IPC; must freshly validate authority AND sources, not echo the supplied capture. */
  validate(captureId: string): Promise<LocalViewCapture>;
  /** Private exact native read. The body is transient; this callback is never supplied by public JSON. */
  memoryRead?(source: Readonly<MemoryViewSource>, signal?: AbortSignal): Promise<{ body: string; observation: MemoryBackendObservation }>;
  /** Search observation, never a deletion barrier or permission. Omit for an exact-only view. */
  memoryIndex?: LocalMemoryIndexObservation;
  /**
   * Trusted Worker exact-content read for one inner-domain capture. The caller
   * maps this to the `view.readInnerBodies` IPC command; it is never supplied by
   * public JSON. It is only invoked after audience/source metadata trimming.
   */
  innerRead?(domain: InnerDomain, capture: Readonly<InnerCapture>, recordIds: readonly string[], signal?: AbortSignal): Promise<InnerBodyReadOutput>;
  now?: () => Date;
}
export interface LocalMemoryIndexObservation { profileFingerprint: string; indexBaselineId: string; indexWatermark: number }
export interface LocalReadView {
  read(options?: { maxItems?: number; maxBytes?: number }): Promise<ReadView>;
  assertCurrent(viewId: string): Promise<void>;
  close(): void;
}
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (value: Pick<ViewSourceRef, 'sourceId' | 'revision' | 'contentHash'>) => JSON.stringify([value.sourceId, value.revision, value.contentHash ?? null]);

const innerSourceRef = (domain: InnerDomain, ref: InnerSourceRef, observedAt: string): ViewSourceRef =>
  ({ sourceId: `inner:${domain}:${ref.kind}:${ref.sourceId}`, revision: ref.revision, observedAt, trustClass: 'inner-domain-source' });
const viewInnerAuthority = (authority: InnerAuthority): ViewInnerAuthority => ({ domain: authority.domain,
  authorityId: authority.authorityId, installationGeneration: authority.installationGeneration,
  policyVersion: authority.policyVersion, tombstoneWatermark: authority.tombstoneWatermark, baselineId: authority.baselineId });
/**
 * Validate the Worker-side inner-domain capture bundle at one projection seam.
 * Every captured domain must have a matching grant and authority vector in the
 * capture; a bundle without them is refused instead of silently dropping content.
 */
function innerCaptures(capture: LocalViewCapture): [InnerDomain, InnerCapture][] {
  if (!capture.inner) return [];
  if (!capture.inner.domains || typeof capture.inner.domains !== 'object' || Array.isArray(capture.inner.domains)) {
    throw new ReadViewError('INVALID_INNER_CAPTURE', 'Inner-domain capture bundle is not an object');
  }
  const entries: [InnerDomain, InnerCapture][] = [];
  for (const [domain, value] of Object.entries(capture.inner.domains)) {
    if (!(INNER_DOMAINS as readonly string[]).includes(domain)) throw new ReadViewError('INVALID_INNER_CAPTURE', 'Unknown inner-domain capture identity');
    let parsed: InnerCapture;
    try { parsed = validateInnerCapture(value); }
    catch { throw new ReadViewError('INVALID_INNER_CAPTURE', 'Inner-domain capture metadata is incomplete or inconsistent'); }
    if (parsed.domain !== domain || parsed.conversationId !== capture.context.token.conversationId || parsed.conversationId !== capture.access.conversation?.conversationId) {
      throw new ReadViewError('INVALID_INNER_CAPTURE', 'Inner-domain capture belongs to another conversation');
    }
    const authority = capture.access.authority?.inner?.[domain as InnerDomain];
    if (!authority || fingerprint(viewInnerAuthority(parsed.authority)) !== fingerprint(authority)) {
      throw new ReadViewError('INVALID_INNER_CAPTURE', 'Inner-domain capture authority is not part of this view authority');
    }
    const grant = capture.access.components.find(component => component.backendId === INNER_DOMAIN_BACKENDS[domain as InnerDomain]);
    if (!grant || grant.authority !== domain || !Array.isArray(grant.bodyFields) || !grant.bodyFields.includes('body')) {
      throw new ReadViewError('INVALID_INNER_CAPTURE', 'Inner-domain capture has no explicit content-read grant');
    }
    entries.push([domain as InnerDomain, parsed]);
  }
  if (new Set(entries.map(([domain]) => domain)).size !== entries.length) throw new ReadViewError('INVALID_INNER_CAPTURE', 'Duplicate inner-domain capture');
  return entries.sort(([left], [right]) => left.localeCompare(right));
}
/**
 * One instance per immutable Worker capture. Task bytes are pinned; native
 * memory bodies are read asynchronously against the exact captured identity.
 * Both authority passes and source checks freshly validate with the Worker;
 * the pinned deadline is never renewed. Closing releases ephemeral metadata.
 *
 * Inner domains follow the same two-phase rule: the ReadView service first
 * trims metadata-only records by scope, audience, resource refs and source
 * visibility, then requests exact bodies only for the eligible record ids. A
 * missing body reader is an explicit unavailable component, never empty success.
 */
export function createLocalReadView(input: LocalViewCapture, options: LocalReadViewOptions): LocalReadView {
  const capture = structuredClone(input), expected = fingerprint(capture);
  const inner = innerCaptures(capture);
  const memoryIndex = options.memoryIndex && structuredClone(options.memoryIndex);
  if (memoryIndex) {
    const published = capture.publication.manifest.domains.memory;
    if (!capture.memory || published.status !== 'available' || !published.capabilities.some(capability => capability === 'semantic_search')
      || memoryIndex.profileFingerprint !== published.profileFingerprint || !/^[a-f0-9]{64}$/.test(memoryIndex.profileFingerprint)
      || typeof memoryIndex.indexBaselineId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(memoryIndex.indexBaselineId)
      || !Number.isSafeInteger(memoryIndex.indexWatermark) || memoryIndex.indexWatermark < 0
      || Object.keys(memoryIndex).some(key => !['profileFingerprint', 'indexBaselineId', 'indexWatermark'].includes(key))) {
      throw new ReadViewError('INVALID_INDEX_OBSERVATION', 'Semantic index observation does not match the published memory profile');
    }
  }
  const allowed = new Set(capture.component.records.flatMap(record => record.sourceRefs).map(key));
  for (const source of capture.memory?.sources ?? []) allowed.add(key({ sourceId: `memory:${source.sourceId}`, revision: source.sourceRevision, contentHash: source.command.bodyDigest }));
  for (const [domain, captured] of inner) for (const record of captured.records) for (const ref of record.sourceRefs) allowed.add(key(innerSourceRef(domain, ref, captured.capturedAt)));
  const current = async () => {
    const checked = await options.validate(capture.captureId);
    if (fingerprint(checked) !== expected) throw new ReadViewError('VIEW_INVALIDATED', 'Worker capture identity or bytes changed');
  };
  const service = new ReadViewService({ now: options.now, ...(capture.replyExecution ? { executionProfile: 'lab-reply-v1' as const } : {}),
    authority: {
      resolve: async (actor, request) => {
        if (actor.principalId !== capture.actor.principalId || actor.role !== capture.actor.role || request.purpose !== capture.access.purpose
          || request.conversationId !== capture.context.token.conversationId || request.taskId !== undefined) return null;
        await current(); return structuredClone(capture.access);
      },
      checkSources: async (_access, refs) => {
        await current(); return refs.map(ref => ({ ...ref, status: allowed.has(key(ref)) ? 'visible' as const : 'unavailable' as const }));
      },
    },
    components: [{ backendId: 'control-task', read: () => structuredClone(capture.component) }, ...(capture.memory ? [{ backendId: MEMORY_VIEW_BACKEND,
      read: async (_request: unknown, signal?: AbortSignal) => {
        const memory = capture.memory!;
        if (!options.memoryRead && memory.sources.length) throw new ReadViewError('DEPENDENCY_UNAVAILABLE', 'Exact native memory reads are not connected');
        const records = [];
        for (const source of memory.sources) {
          signal?.throwIfAborted(); await current(); signal?.throwIfAborted();
          const result = await options.memoryRead!(structuredClone(source), signal);
          signal?.throwIfAborted();
          const observation = result.observation;
          if (typeof result.body !== 'string' || canonicalMemoryCommand(observation.command) !== canonicalMemoryCommand(source.command)
            || observation.commandDigest !== source.commandDigest || observation.commandDigest !== memoryCommandDigest(source.command)
            || observation.deploymentId !== memory.authority.deploymentId || observation.nativeId !== source.nativeId
            || observation.componentVersion !== source.componentVersion || observation.bodyDigest !== source.command.bodyDigest
            || observation.bodyBytes !== source.command.bodyBytes || fingerprint(observation.sourceRefs) !== fingerprint(source.command.sourceRefs)
            || source.readToken.nativeId !== observation.nativeId || source.readToken.componentVersion !== observation.componentVersion) {
            throw new ReadViewError('MEMORY_MISMATCH', 'The exact native memory does not match the captured reference');
          }
          assertMemoryBody(source.command, result.body);
          await current(); signal?.throwIfAborted();
          records.push({ recordId: source.operationId, scope: capture.access.scope, audienceIds: [...capture.access.audienceIds], resourceRefs: [`memory:${source.operationId}`],
            fields: { text: result.body }, sourceRefs: [{ sourceId: `memory:${source.sourceId}`, revision: source.sourceRevision, contentHash: source.command.bodyDigest,
              observedAt: capture.capturedAt, trustClass: 'owner-confirmed-memory' }],
            aggregateVersion: { aggregateType: 'memory', aggregateId: source.operationId, version: source.readToken.operationVersion } });
        }
        await current(); signal?.throwIfAborted();
        return { capturedAt: capture.capturedAt, expiresAt: capture.expiresAt, verifiedSourceHash: memory.snapshotHash,
          ...(memoryIndex ? { indexVersion: `${memoryIndex.indexBaselineId}@${memoryIndex.indexWatermark}/${memoryIndex.profileFingerprint}` } : {}),
          freshness: { status: 'current' as const }, appliedSafety: structuredClone(capture.access.appliedSafety), memoryAuthority: structuredClone(memory.authority), records };
      } }] : []),
      ...inner.map(([domain, captured]) => ({
        backendId: INNER_DOMAIN_BACKENDS[domain], authority: domain, fields: [...INNER_VIEW_FIELDS], bodyFields: [...INNER_VIEW_BODY_FIELDS],
        read: async (_request: unknown, signal?: AbortSignal) => {
          signal?.throwIfAborted(); await current(); signal?.throwIfAborted();
          const records = captured.records.map(record => ({ recordId: record.recordId, scope: capture.access.scope, audienceIds: [...capture.access.audienceIds],
            resourceRefs: [`inner:${domain}:${record.recordId}`],
            fields: { recordId: record.recordId, revision: record.revision, kind: record.kind, status: record.status,
              evidenceState: record.evidenceState, observedAt: record.observedAt, bodyAvailable: record.bodyAvailable },
            sourceRefs: record.sourceRefs.map(ref => innerSourceRef(domain, ref, captured.capturedAt)),
            aggregateVersion: { aggregateType: `inner-${domain}`, aggregateId: `${domain}:${record.recordId}`, version: record.revision } }));
          return { capturedAt: captured.capturedAt, expiresAt: capture.expiresAt, verifiedSourceHash: captured.snapshotHash,
            freshness: { status: 'current' as const }, appliedSafety: structuredClone(capture.access.appliedSafety),
            innerAuthority: viewInnerAuthority(captured.authority), records };
        },
        ...(options.innerRead ? { readBody: async (request: { recordIds: readonly string[] }, signal?: AbortSignal) => {
          signal?.throwIfAborted(); await current(); signal?.throwIfAborted();
          const result = await options.innerRead!(domain, structuredClone(captured), [...request.recordIds], signal);
          signal?.throwIfAborted(); await current(); signal?.throwIfAborted();
          if (!result || result.domain !== domain || result.capturedAt !== captured.capturedAt
            || fingerprint(viewInnerAuthority(result.authority)) !== fingerprint(viewInnerAuthority(captured.authority))) {
            throw new ReadViewError('INNER_BODY_MISMATCH', 'Inner-domain body read does not match the captured authority');
          }
          if (!Array.isArray(result.bodies) || result.bodies.length !== request.recordIds.length
            || new Set(result.bodies.map(body => body.recordId)).size !== request.recordIds.length
            || !request.recordIds.every(recordId => result.bodies.some(body => body.recordId === recordId))) {
            throw new ReadViewError('INNER_BODY_MISMATCH', 'Inner-domain body read returned an incomplete or unknown selection');
          }
          return result.bodies.map(body => {
            const metadata = captured.records.find(record => record.recordId === body.recordId);
            if (!metadata || metadata.revision !== body.revision || metadata.kind !== body.kind || metadata.evidenceState !== body.evidenceState) {
              throw new ReadViewError('INNER_BODY_MISMATCH', 'Inner-domain body read disagrees with its captured metadata');
            }
            if (body.evidenceState === 'revoked') throw new ReadViewError('INNER_SOURCE_REVOKED', 'A withdrawn inner-domain source has no readable body');
            return { recordId: body.recordId, fields: { body: body.payload as unknown as JsonValue } };
          });
        } } : {}),
      }))],
  });
  return {
    read: (limits = {}) => service.read(capture.actor, { requestId: capture.captureId, purpose: capture.access.purpose, conversationId: capture.context.token.conversationId, ...limits }),
    assertCurrent: viewId => service.assertCurrent(capture.actor, viewId, { purpose: capture.access.purpose, conversationId: capture.context.token.conversationId }),
    close: () => service.dispose(),
  };
}
