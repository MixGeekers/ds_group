import type { DshContext, DshSession } from './sessions.js';

export interface NativeSessionTitleSnapshot {
  title: string;
  source: { kind: string };
  messageSeqs?: number[];
  eventSeq?: number;
  updatedAt?: number;
}

/**
 * Public native rename pins a title with source.kind=user, suppressing both
 * first-prompt and all-prompts automatic title providers. Call after the native
 * handle is published and before followup. A deliberate owner refresh can unpin.
 */
export async function pinOwnedSessionTitle(ctx: DshContext, session: DshSession, title: string): Promise<void> {
  if (typeof title !== 'string' || !title.trim() || title !== title.trim()) throw new Error('A fixed managed Session title is required');
  const titles = ctx.get('sessionTitle'), sessions = ctx.get('sessions');
  if (typeof titles?.rename !== 'function' || typeof titles?.get !== 'function' || typeof sessions?.flush !== 'function') throw new Error('Native Session title pinning and durability services are required');
  const matches = (value: NativeSessionTitleSnapshot | undefined): boolean => value?.title === title && value?.source?.kind === 'user';
  if (!matches(titles.get(session))) {
    if (!matches(titles.rename(session, title))) throw new Error('Native Session title pin was not accepted');
  }
  if (!matches(titles.get(session))) throw new Error('Native Session title pin could not be read back');
  if (await sessions.flush(session) !== true) throw new Error('Native Session title pin was not durably flushed');
  if (!matches(titles.get(session))) throw new Error('Native Session title pin changed before dispatch');
}
