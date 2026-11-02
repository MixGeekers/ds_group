import { createHash } from 'node:crypto';
import { ReadViewError, ReadViewService, type ReadView, type ViewSourceRef } from './index.js';
import type { LocalViewCapture } from '../adapters/control-store/view-domain.js';

export interface LocalReadViewOptions {
  /** Trusted Worker IPC; must freshly validate authority AND sources, not echo the supplied capture. */
  validate(captureId: string): Promise<LocalViewCapture>;
  now?: () => Date;
}
export interface LocalReadView {
  read(options?: { maxItems?: number; maxBytes?: number }): Promise<ReadView>;
  assertCurrent(viewId: string): Promise<void>;
  close(): void;
}
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (value: Pick<ViewSourceRef, 'sourceId' | 'revision' | 'contentHash'>) => JSON.stringify([value.sourceId, value.revision, value.contentHash ?? null]);

/**
 * One instance per immutable Worker capture. Component reads return only these
 * captured bytes, never an asynchronous second read of newer Task state. Both
 * authority passes and source checks ask the Worker for fresh validation; the
 * pinned deadline is never renewed. Closing releases ephemeral view metadata.
 */
export function createLocalReadView(input: LocalViewCapture, options: LocalReadViewOptions): LocalReadView {
  const capture = structuredClone(input), expected = fingerprint(capture);
  const allowed = new Set(capture.component.records.flatMap(record => record.sourceRefs).map(key));
  const current = async () => {
    const checked = await options.validate(capture.captureId);
    if (fingerprint(checked) !== expected) throw new ReadViewError('VIEW_INVALIDATED', 'Worker capture identity or bytes changed');
  };
  const service = new ReadViewService({ now: options.now,
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
    components: [{ backendId: 'control-task', read: () => structuredClone(capture.component) }],
  });
  return {
    read: (limits = {}) => service.read(capture.actor, { requestId: capture.captureId, purpose: capture.access.purpose, conversationId: capture.context.token.conversationId, ...limits }),
    assertCurrent: viewId => service.assertCurrent(capture.actor, viewId, { purpose: capture.access.purpose, conversationId: capture.context.token.conversationId }),
    close: () => service.dispose(),
  };
}
