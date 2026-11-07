// Modified by DSCord: durable producer identity is separate from the model role.
import { createHash } from 'node:crypto'

const CONTEXT_KINDS = new Set(['runtime-context', 'knowledge-context', 'background-context', 'tool-context', 'workspace-instructions', 'skills', 'skill-catalog', 'compaction'])
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value
const clone = value => value === undefined ? undefined : sorted(JSON.parse(JSON.stringify(value)))

export function isContextMessage(message) {
  const source = message?.source ?? {}
  return CONTEXT_KINDS.has(source.kind) || source.actor?.kind === 'background' || source.actor?.kind === 'tool'
    || source.sender?.kind === 'background' || source.sender?.kind === 'tool'
    || source.input === 'context'
}

export function messageSource({ source, memoryContext, requestId, home = '' } = {}) {
  if (source !== undefined && (source === null || typeof source !== 'object' || Array.isArray(source))) throw Object.assign(new Error('Message source must be an object'), { code: 'bot/invalid' })
  if (typeof requestId !== 'string' || requestId.trim() === '') throw Object.assign(new Error('Message requestId must be a nonempty string'), { code: 'bot/invalid' })
  const supplied = clone(source) ?? {}
  const context = memoryContext?.context?.source ?? memoryContext?.source ?? {}
  const event = memoryContext?.event ?? {}
  const sender = clone(supplied.sender ?? supplied.actor ?? context.sender) ?? {
    id: event.senderId ?? event.sender ?? `user-${createHash('sha256').update(home).digest('hex').slice(0, 16)}`,
    name: event.senderName ?? 'Local user', kind: event.senderKind ?? (context.transport === 'matrix' ? 'unknown' : 'human'),
  }
  if (typeof sender.id !== 'string' || sender.id.trim() === '') throw Object.assign(new Error('A message producer needs a stable identity'), { code: 'bot/invalid' })
  sender.kind ??= 'unknown'
  const kind = sender.kind === 'bot' ? 'bot' : sender.kind === 'tool' ? 'tool-context'
    : sender.kind === 'background' ? 'background-context' : supplied.kind ?? 'user'
  const roomId = supplied.roomId ?? context.roomId ?? event.roomId
  const eventId = supplied.eventId ?? event.eventId ?? event.event_id
  return {
    ...supplied, kind, rpcId: requestId, requestId, sender, actor: sender,
    ...(context.transport || supplied.transport ? { transport: supplied.transport ?? context.transport } : {}),
    ...(roomId ? { roomId } : {}), ...(eventId ? { eventId } : {}),
    ...(context.timestamp === undefined ? {} : { timestamp: context.timestamp }),
    ...(sender.kind === 'bot' ? { senderSessionId: supplied.senderSessionId ?? sender.id, senderName: sender.name ?? sender.id } : {}),
    ...(sender.kind === 'bot' ? { role: supplied.role ?? 'message' } : {}),
    ...(roomId || eventId ? { memoryOrigin: { ...(roomId ? { roomId } : {}), ...(eventId ? { eventId } : {}), authorId: sender.id, authorKind: sender.kind, ...supplied.memoryOrigin } } : {}),
  }
}

export function sourceLabel(message) {
  const source = message.source ?? {}
  const sender = source.sender ?? source.actor
  if (isContextMessage(message)) return `Context (${source.kind ?? sender?.kind ?? 'background'}${sender?.id ? `; ${sender.id}` : ''})`
  if (source.kind === 'bot' || sender?.kind === 'bot') return `Bot (${sender?.id ?? source.senderSessionId ?? source.senderName ?? 'unknown'}${source.roomId ? `; room ${source.roomId}` : ''})`
  if (message.role === 'assistant') return 'You'
  if (message.role === 'tool') return `Tool result (${message.toolCallId ?? 'call'})`
  return sender?.id ? `${sender.kind === 'human' ? 'Human' : 'Participant'} (${sender.id}${source.roomId ? `; room ${source.roomId}` : ''})` : 'User'
}

export function sourceText(message) {
  const text = (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
  return `${sourceLabel(message)}: ${text}`
}
