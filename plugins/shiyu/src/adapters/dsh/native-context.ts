import type { DshContext, DshSession, SessionEvent } from './sessions.js';
import { nativeMessageHash } from './native-message.js';

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
      || nativeMessageHash(actual.data) !== nativeMessageHash(expected.data)) throw new Error('Native durable event readback did not match this operation');
    signal?.throwIfAborted();
  } finally { await handle.close(); }
}
