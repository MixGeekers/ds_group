import { sha } from './store.mjs';

// Native source metadata identifies the actor; the local-user fallback applies
// only when an older host supplies no stable actor at all.
export function nativeMemoryInput({ source = {}, text, home, sessionId, sequence, timestamp, roomId: fallbackRoom }) {
  const supplied = source.memoryContext || source.context;
  if (supplied?.event) return supplied;
  const context = supplied?.context || supplied || {};
  const sender = context.source?.sender || source.sender || source.actor || (source.kind === 'bot' && source.senderSessionId
    ? { id: source.senderSessionId, name: source.senderName, kind: 'bot' }
    : { id: `user-${sha(home).slice(0, 16)}`, name: 'Local user', kind: 'human' });
  const roomId = context.source?.roomId || context.room?.id || source.memoryOrigin?.roomId || source.roomId || fallbackRoom;
  return { event: { eventId: context.source?.eventId || source.eventId || `${sessionId}:${sequence ?? sha(text)}`,
    roomId, sender: sender.id, body: text, timestamp }, context: { ...context, source: { ...context.source,
    transport: context.source?.transport || source.transport || (/^(?:@|matrix:)/.test(sender.id || '') ? 'matrix' : 'native'),
    sender, roomId, timestamp: context.source?.timestamp ?? timestamp,
    originRefs: context.source?.originRefs || source.memoryOrigin?.sourceRefs || [],
    relay: context.source?.relay || (source.kind === 'bot' ? { exchangeId: source.exchangeId, replyTo: source.replyTo } : null) } } };
}

export const automaticReviewAllowed = (config, botId) => config.memoryReview !== false
  && (typeof config.memoryReviewForBot !== 'function' || config.memoryReviewForBot(botId) === true);
