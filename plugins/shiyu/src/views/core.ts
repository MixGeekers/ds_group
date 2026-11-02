import type { CoreReadCapture } from '../contracts/core.js';
import { ReadViewError, ReadViewService, type ViewSourceRef } from './index.js';

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const sourceKey = (value: ViewSourceRef) => canonical([value.sourceId, value.revision, value.contentHash]);

/** A thin read-only projection of one persisted Core evaluation. It owns no
 * capability state, model loop, permissions or Task admission path. */
export function createCoreReadView(capture: CoreReadCapture, options: {
  validate(): Promise<CoreReadCapture>; now?: () => Date;
}) {
  const saved = structuredClone(capture);
  const current = async () => {
    const checked = await options.validate();
    if (canonical(checked) !== canonical(saved)) throw new ReadViewError('VIEW_INVALIDATED', 'The persisted Core capability capture changed');
    return checked;
  };
  const sources = new Map(saved.component.records.flatMap(record => record.sourceRefs).map(ref => [sourceKey(ref), ref]));
  const service = new ReadViewService({ now: options.now, authority: {
    async resolve(actor, request) {
      if (actor.principalId !== saved.actor.principalId || actor.role !== 'core' || request.purpose !== 'core_decision'
        || request.requestId !== saved.evaluationId || request.conversationId || request.taskId) return null;
      return (await current()).access;
    },
    async checkSources(_access, refs) {
      await current();
      return refs.map(ref => ({ sourceId: ref.sourceId, revision: ref.revision, ...(ref.contentHash ? { contentHash: ref.contentHash } : {}),
        status: sources.has(sourceKey(ref)) ? 'visible' as const : 'unavailable' as const }));
    },
  }, components: [{ backendId: 'control-ability', async read() { return (await current()).component; } }] });
  return {
    async read() {
      const view = await service.read(saved.actor, { requestId: saved.evaluationId, purpose: 'core_decision', maxItems: 1, maxBytes: 16384 });
      if (view.freshness.status !== 'current' || view.truncated.items || view.truncated.bytes || view.data.length !== 1
        || view.data[0]!.backendId !== 'control-ability' || view.data[0]!.recordId !== saved.capability.ref.capabilityId
        || canonical(view.data[0]!.fields.capability) !== canonical(saved.capability.record)) {
        throw new ReadViewError('VIEW_INVALIDATED', 'A complete current capability metadata view is required');
      }
      return view;
    },
    assertCurrent: (viewId: string) => service.assertCurrent(saved.actor, viewId, { purpose: 'core_decision' }),
    dispose: () => service.dispose(),
  };
}
