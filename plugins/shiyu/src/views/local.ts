import { createHash } from 'node:crypto';
import { ReadViewError, ReadViewService, type ReadView, type ViewSourceRef } from './index.js';
import { MEMORY_VIEW_BACKEND, type LocalViewCapture, type MemoryViewSource } from '../adapters/control-store/view-domain.js';
import { assertMemoryBody, canonicalMemoryCommand, memoryCommandDigest, type MemoryBackendObservation } from '../contracts/memory.js';

export interface LocalReadViewOptions {
  /** Trusted Worker IPC; must freshly validate authority AND sources, not echo the supplied capture. */
  validate(captureId: string): Promise<LocalViewCapture>;
  /** Private exact native read. The body is transient; this callback is never supplied by public JSON. */
  memoryRead?(source: Readonly<MemoryViewSource>, signal?: AbortSignal): Promise<{ body: string; observation: MemoryBackendObservation }>;
  /** Search observation, never a deletion barrier or permission. Omit for an exact-only view. */
  memoryIndex?: LocalMemoryIndexObservation;
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

/**
 * One instance per immutable Worker capture. Task bytes are pinned; native
 * memory bodies are read asynchronously against the exact captured identity.
 * Both authority passes and source checks freshly validate with the Worker;
 * the pinned deadline is never renewed. Closing releases ephemeral metadata.
 */
export function createLocalReadView(input: LocalViewCapture, options: LocalReadViewOptions): LocalReadView {
  const capture = structuredClone(input), expected = fingerprint(capture);
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
      } }] : [])],
  });
  return {
    read: (limits = {}) => service.read(capture.actor, { requestId: capture.captureId, purpose: capture.access.purpose, conversationId: capture.context.token.conversationId, ...limits }),
    assertCurrent: viewId => service.assertCurrent(capture.actor, viewId, { purpose: capture.access.purpose, conversationId: capture.context.token.conversationId }),
    close: () => service.dispose(),
  };
}
