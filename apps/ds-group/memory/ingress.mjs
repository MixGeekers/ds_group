import { sha } from './store.mjs';

// Native source metadata identifies the actor; the local-user fallback applies
// only when an older host supplies no stable actor at all.
export function nativeMemoryInput({ source = {}, text, home, sessionId, sequence, messageId, timestamp, roomId: fallbackRoom, stableOnly = false }) {
  const supplied = source.memoryContext || source.context;
  if (supplied?.event) return supplied;
  const context = supplied?.context || supplied || {};
  const sender = context.source?.sender || source.sender || source.actor || (source.kind === 'bot' && source.senderSessionId
    ? { id: source.senderSessionId, name: source.senderName, kind: 'bot' }
    : { id: `user-${sha(home).slice(0, 16)}`, name: 'Local user', kind: 'human' });
  const roomId = context.source?.roomId || context.room?.id || source.memoryOrigin?.roomId || source.roomId || fallbackRoom;
  const eventId = context.source?.eventId || source.eventId || source.memoryOrigin?.eventId
    || (source.requestId || source.rpcId ? `${sessionId}:request:${source.requestId || source.rpcId}` : messageId ? `${sessionId}:message:${messageId}` : undefined)
    || (!stableOnly ? `${sessionId}:${sequence ?? sha(text)}` : undefined);
  if (!eventId) return undefined;
  return { event: { eventId,
    roomId, sender: sender.id, body: text, timestamp }, context: { ...context, source: { ...context.source,
    transport: context.source?.transport || source.transport || (/^(?:@|matrix:)/.test(sender.id || '') ? 'matrix' : 'native'),
    sender, roomId, timestamp: context.source?.timestamp ?? timestamp,
    originRefs: context.source?.originRefs || source.memoryOrigin?.sourceRefs || [],
    relay: context.source?.relay || (source.kind === 'bot' ? { exchangeId: source.exchangeId, replyTo: source.replyTo } : null) } } };
}

export const isSourceMessage = message => ['user', 'bot', 'user-question-reply'].includes(message?.source?.kind)
  && !message.source.handoff && !['goal', 'kickoff', 'resume'].includes(message.source.role);

// New entries use the receiving Bot as namespace so a claimed message can move
// to a new native part. Legacy Session keys remain readable by the caller.
// Equal text, senders or event IDs in another room/receiving Bot never collide.
export function heldIngressKey(receiverId, source = {}) {
  const eventId = source.eventId || source.memoryOrigin?.eventId;
  const roomId = source.roomId || source.memoryOrigin?.roomId;
  return eventId ? `ingress-source:${sha(JSON.stringify([receiverId, roomId || null, eventId]))}` : undefined;
}

export function prepareClaimedSources({ memory, botId, sessionId, messages, home, fallbackRoom, clock = Date.now }) {
  let current;
  for (const message of messages || []) {
    if (!isSourceMessage(message)) continue;
    const text = (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    const source = message.source;
    const heldKey = heldIngressKey(botId, source), legacyKey = heldIngressKey(sessionId, source);
    const preparedKey = message.id ? `prepared-source:${sessionId}:${message.id}` : undefined;
    const input = (heldKey && memory.store.getMeta(heldKey)) || (legacyKey && memory.store.getMeta(legacyKey)) || (preparedKey && memory.store.getMeta(preparedKey))
      || nativeMemoryInput({ source, text, home, sessionId, messageId: message.id, timestamp: source.timestamp ?? clock(), roomId: fallbackRoom, stableOnly: true });
    if (!input?.event?.eventId) {
      current = memory.clearCurrent(botId, sessionId, 'claimed-message-has-no-stable-source-id');
      continue;
    }
    if (preparedKey) memory.store.setMeta(preparedKey, input);
    current = memory.ingest(botId, input, { sessionId });
  }
  return current;
}

export const automaticReviewAllowed = (config, botId) => config.memoryReview !== false
  && (typeof config.memoryReviewForBot !== 'function' || config.memoryReviewForBot(botId) === true);
