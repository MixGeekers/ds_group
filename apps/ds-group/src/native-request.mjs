const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Derived attention/turn views belong to the current runtime frame. */
export function withoutNativeMemoryViews(value) {
  if (!object(value)) return value;
  const attention = value.context?.attention;
  const nested = object(attention) && Object.hasOwn(attention, 'memoryView');
  if (!Object.hasOwn(value, 'memoryView') && !nested) return value;
  const result = { ...value }; delete result.memoryView;
  if (nested) {
    const current = { ...attention }; delete current.memoryView;
    result.context = { ...value.context, attention: current };
  }
  return result;
}

/** Recognize a native routing envelope by its durable source identities, never
 * by a marker in arbitrary human text. Preserve the original message identity,
 * source, body, history, route and non-text blocks in the model projection. */
export function projectNativeRequestMessage(message) {
  const source = message?.source, first = message?.content?.[0];
  if (message?.role !== 'user' || !['user', 'bot'].includes(source?.kind)
    || first?.type !== 'text' || !first.text.includes('"memoryView"')) return message;
  const requestId = source.requestId || source.rpcId;
  if (typeof requestId !== 'string' || !requestId || source.requestId && source.rpcId && source.requestId !== source.rpcId
    || typeof source.eventId !== 'string' || typeof source.roomId !== 'string' || typeof source.sender?.id !== 'string'
    || !source.eventId || !source.roomId || !source.sender.id
    || !first.text.startsWith(`DSCORD_REQUEST=${requestId}\n`)) return message;
  const at = first.text.lastIndexOf('\n');
  let envelope;
  try { envelope = JSON.parse(first.text.slice(at + 1)); } catch { return message; }
  const current = envelope?.currentMessage, context = envelope?.context, route = envelope?.replyRoute;
  if (!object(envelope) || envelope.requestId !== requestId || context?.version !== 1
    || typeof envelope.self?.nativeBotId !== 'string' || !envelope.self.nativeBotId
    || typeof current?.body !== 'string' || route?.requestId !== requestId
    || [current.eventId, context.source?.eventId, route.eventId].some(id => id !== source.eventId)
    || [current.roomId, context.source?.roomId, context.room?.id, route.roomId].some(id => id !== source.roomId)
    || [current.senderId, context.source?.sender?.id].some(id => id !== source.sender.id)) return message;
  const projected = withoutNativeMemoryViews(envelope);
  if (projected === envelope) return message;
  return { ...message, content: [{ ...first, text: first.text.slice(0, at + 1) + JSON.stringify(projected) }, ...message.content.slice(1)] };
}
