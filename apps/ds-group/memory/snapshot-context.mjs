import { z } from 'zod';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate';
import { projectNativeRequestMessage } from '../src/native-request.mjs';

export const SNAPSHOT_INDEX_KEY = 'dscord-memory-snapshots';
export const RETIRED_SNAPSHOT_KIND = 'knowledge-context-retired';

// The official registry owns replay, checkpoints and per-Session watermarks.
// Keep only identities here, never a second copy of the snapshot bodies.
export const snapshotProjection = {
  key: SNAPSHOT_INDEX_KEY,
  stateVersion: 2,
  stateSchema: z.object({
    frames: z.array(z.object({ seq: z.number().int().nonnegative(), id: z.string().min(1) }).strict()),
    requests: z.array(z.object({ seq: z.number().int().nonnegative(), id: z.string().min(1) }).strict()),
  }).strict(),
  init: () => ({ frames: [], requests: [] }),
  apply(state, event) {
    let frames = state.frames, requests = state.requests;
    // A native compaction may already have replaced a snapshot along with its
    // surrounding history. Those nodes are no longer ours to retire either.
    if (event.surfaceOp?.op === 'replace') {
      const replaced = new Set(event.sourceEventSeqs ?? []);
      const kept = frames.filter(frame => !replaced.has(frame.seq));
      if (kept.length !== frames.length) frames = kept;
      const retained = requests.filter(frame => !replaced.has(frame.seq));
      if (retained.length !== requests.length) requests = retained;
    }
    if (event.type === 'user/message' && event.surfaceOp !== undefined && event.data.source?.kind === 'knowledge-context') {
      frames = [...frames, { seq: event.seq, id: event.data.id }];
    }
    if (event.type === 'user/message' && event.surfaceOp !== undefined && projectNativeRequestMessage(event.data) !== event.data) {
      requests = [...requests, { seq: event.seq, id: event.data.id }];
    }
    return frames === state.frames && requests === state.requests ? state : { frames, requests };
  },
};

export const isRetiredSnapshot = message => message.source?.kind === RETIRED_SNAPSHOT_KIND
  && message.source.input === 'context' && message.content.length === 0;

// The official surface cannot remove a node outright. Its durable empty
// replacement records the absence; omit only that empty node at dispatch.
export function snapshotRequestMessages(messages) {
  return messages?.some(isRetiredSnapshot) ? messages.filter(message => !isRetiredSnapshot(message)) : messages;
}

/** Remove derived views from verified request envelopes and replace old
 * memory-only surface nodes. Their original events remain intact.
 * User replacements are legal both between turns and before step/start. The
 * empty replacement needs no custom event interpreter during cold restore. */
export function createSnapshotContext(ctx) {
  let registration;
  return {
    async retire(session, { keepLatest = false } = {}) {
      const projections = ctx.get?.('sessionProjections');
      if (!projections?.register || !session?.surface || typeof session.append !== 'function') {
        throw Object.assign(new Error('Native Session surface and projection services are required for replaceable memory context'), { code: 'MEMORY_SNAPSHOT_SURFACE_UNAVAILABLE' });
      }
      registration ??= Promise.resolve(projections.register(snapshotProjection));
      const index = await registration;
      const active = new Set(session.surface.nodes);
      const messages = new Map(session.deriveMessages().map(message => [message.id, message]));
      const state = index.stateOf(session);
      const frames = state.frames.filter(frame => active.has(frame.seq) && messages.has(frame.id));
      const keep = keepLatest ? frames.at(-1)?.seq : undefined;
      const retired = [];
      const replace = (frame, message) => {
        const prune = session.append('compaction/prune', { shadowedRange: { start: frame.seq, end: frame.seq },
          shadowedSeqs: [frame.seq], shadowedTokenCount: estimateMessage(messages.get(frame.id)) });
        const event = session.append('user/message', message, {
          surfaceOp: { op: 'replace', startSeq: frame.seq, endSeq: frame.seq }, sourceEventSeqs: [frame.seq, prune.seq],
        });
        retired.push({ seq: frame.seq, id: frame.id, replacementSeq: event.seq });
      };
      for (const frame of state.requests) {
        if (!active.has(frame.seq) || !messages.has(frame.id)) continue;
        const original = messages.get(frame.id), message = projectNativeRequestMessage(original);
        if (message !== original) replace(frame, message);
      }
      for (const frame of frames) {
        if (frame.seq === keep) continue;
        const message = createUserMessage({ content: [], source: {
          kind: RETIRED_SNAPSHOT_KIND, form: 'notice', input: 'context', summary: 'Superseded memory snapshot removed from active model context.',
          retiredSeq: frame.seq, retiredMessageId: frame.id,
        } });
        // The native meter's incremental fold requires an adjacent exact price
        // for a replaced range. This is pruning metadata, not model compaction.
        replace(frame, message);
      }
      return retired;
    },
  };
}
