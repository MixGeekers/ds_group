import type { DshAgent, DshContext, DshSession, SessionEvent } from './sessions.js';
import { nativeMessageHash, type NativeUserMessage } from './native-message.js';

export interface NativeInboxReference { messageId: string; messageHash: string; lane: 'next-turn' | 'next-step'; index: number }
const EVENT_CAP = 2048;
function references(value: unknown, lane: NativeInboxReference['lane']): NativeInboxReference[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('Native inbox projection is unavailable or exceeds its bound');
  return value.map((message: unknown, index) => {
    if (!message || typeof message !== 'object' || !('id' in message) || typeof message.id !== 'string' || !message.id) throw new Error('Native inbox contains an unidentified message');
    return { messageId: message.id, messageHash: nativeMessageHash(message), lane, index };
  });
}
export function nativeInboxReferences(inbox: { nextTurn: unknown; nextStep: unknown } | undefined): NativeInboxReference[] {
  if (!inbox) throw new Error('Native inbox inspection is unavailable');
  return [...references(inbox.nextTurn, 'next-turn'), ...references(inbox.nextStep, 'next-step')];
}
export function nativeContextServices(ctx: DshContext): void {
  if (typeof ctx.get('sessions')?.flush !== 'function' || typeof ctx.get('sessionPersistence')?.open !== 'function'
    || typeof ctx.get('sessionProjections')?.restore !== 'function') throw new Error('Native flush, read-only persistence and cold projection services are required');
}
/** Maintenance is the host's actual exclusive phase; status alone also reports maintenance as idle. */
export function assertNativeMaintenance(agent: DshAgent): void {
  if (typeof agent.runMaintenance !== 'function' || typeof agent.session.append !== 'function') throw new Error('Native exclusive maintenance and typed Session append are required');
  if (agent.status !== 'idle') throw new Error('Native context loading requires an idle Agent');
}
/** Called only inside an already acquired native maintenance phase. Does not enqueue or wake an Agent. */
export function appendNativeContextMessage(session: DshSession, message: NativeUserMessage): SessionEvent {
  if (typeof session.append !== 'function') throw new Error('Native typed Session append is unavailable');
  const event = session.append('user/message', message, { surfaceOp: 'append' });
  if (event?.type !== 'user/message' || event.surfaceOp !== 'append' || !Number.isSafeInteger(event.seq) || event.seq! < 0
    || event.data?.id !== message.id || nativeMessageHash(event.data) !== nativeMessageHash(message)) throw new Error('Native append did not return this exact complete context event');
  return structuredClone(event);
}
/** Use the registered native projector without creating an Agent or storing another history/checkpoint. */
export async function coldNativeInbox(ctx: DshContext, sessionId: string, preset: string, signal?: AbortSignal): Promise<NativeInboxReference[]> {
  nativeContextServices(ctx); signal?.throwIfAborted();
  const handle = await ctx.get('sessionPersistence').open(sessionId, 'read', { signal });
  try {
    if (handle.header?.agentPreset !== preset) throw new Error('Native Session preset does not match the managed binding');
    const result = await handle.read(0, EVENT_CAP + 1, { signal });
    if (!Array.isArray(result?.events) || result.events.length > EVENT_CAP) throw new Error('Native cold projection history exceeds the safe read bound');
    // A truncated native prefix must never be interpreted as an empty current inbox.
    if (result.events.some((event: SessionEvent, index: number) => event.seq !== index)) throw new Error('Native cold projection has an incomplete event sequence');
    // Public eventState describes aliasing (e.g. "detached"), not a total count.
    // Confirm the observed EOF through the same public reader instead of
    // inventing eventState.count or trusting a short prefix as complete history.
    const tail = await handle.read(result.events.length, 1, { signal });
    if (!Array.isArray(tail?.events) || tail.events.length !== 0) throw new Error('Native cold projection has an incomplete event tail');
    const restored = await ctx.get('sessionProjections').restore({}, result.events, 0, handle.header, handle.inheritedEventCount);
    const inbox = restored?.snapshot?.values?.inbox;
    if (!inbox) throw new Error('Registered native inbox projection is unavailable');
    signal?.throwIfAborted();
    return [...references(inbox['next-turn'], 'next-turn'), ...references(inbox['next-step'], 'next-step')];
  } finally { await handle.close(); }
}
export async function flushNative(ctx: DshContext, session: DshSession, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (await ctx.get('sessions').flush(session) !== true) throw new Error('Native Session durability listener did not handle the flush');
  signal?.throwIfAborted();
}
export async function verifyNativeEvent(ctx: DshContext, sessionId: string, expected: SessionEvent, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(expected.seq) || expected.seq! < 0) throw new Error('Native event has no exact sequence reference');
  signal?.throwIfAborted();
  const handle = await ctx.get('sessionPersistence').open(sessionId, 'read', { signal });
  try {
    const result = await handle.read(expected.seq, 1, { signal });
    const actual = result?.events?.[0];
    if (!Array.isArray(result?.events) || result.events.length !== 1 || actual.seq !== expected.seq || actual.type !== expected.type
      || (expected.surfaceOp !== undefined && actual.surfaceOp !== expected.surfaceOp)
      || nativeMessageHash(actual.data) !== nativeMessageHash(expected.data)) throw new Error('Native durable event readback did not match this operation');
    signal?.throwIfAborted();
  } finally { await handle.close(); }
}
