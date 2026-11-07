import { createHash } from 'node:crypto';
import { messageSource, threadOf } from './message-context.mjs';
import { parseDeliveryDirective } from './delivery-policy.mjs';
import { eventAttachments } from './node-files.mjs';

export const ATTENTION_DEFAULTS = Object.freeze({ mode: 'mention', batchMs: 350, maxAgeMs: 30_000,
  waitMs: 4000, waitTtlMs: 30_000, cooldownMs: 1500, coordinationMs: 600,
  maxBotTurns: 2, historyLimit: 40, providerTimeoutMs: 5000 });
const ranges = { batchMs: [0, 5000], maxAgeMs: [1000, 300_000], waitMs: [100, 60_000],
  waitTtlMs: [1000, 300_000], cooldownMs: [0, 60_000], coordinationMs: [0, 5000],
  maxBotTurns: [1, 6], historyLimit: [1, 100], providerTimeoutMs: [100, 60_000] };
export function normalizeAttentionConfig(patch = {}, current = ATTENTION_DEFAULTS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || Object.keys(patch).some(key => !Object.hasOwn(ATTENTION_DEFAULTS, key))) throw new TypeError('Invalid attention configuration');
  const result = { ...current, ...patch };
  if (!['mention', 'shadow', 'natural'].includes(result.mode)) throw new RangeError('Invalid attention mode');
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isSafeInteger(result[key]) || result[key] < min || result[key] > max) throw new RangeError(`${key} must be between ${min} and ${max}`);
  }
  return result;
}

export const attentionThread = event => threadOf(event) || '';
const metadata = event => event.content?.['org.ds_group'] || {};
export const replyId = event => metadata(event).replyTo || event.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;

export function attentionMessage(event, participants) {
  const meta = metadata(event);
  return { eventId: event.event_id, roomId: event.room_id, senderId: event.sender,
    senderName: participants.find(person => person.id === event.sender)?.name || event.sender,
    senderKind: participants.find(person => person.id === event.sender)?.kind || 'unknown',
    body: event.content?.['m.new_content']?.body ?? event.content?.body ?? '',
    ...(event.unsigned?.redacted || event.unsigned?.redacted_because ? { withdrawn: true } : {}),
    source: messageSource(event, participants), to: Array.isArray(meta.to) ? meta.to : [],
    attachments: eventAttachments(event),
    ...(meta.kind ? { kind: meta.kind } : {}), ...(meta.taskId ? { taskId: meta.taskId } : {}),
    ...(meta.fileBatch ? { fileBatch: meta.fileBatch } : {}), ...(meta.originSenderId ? { originSenderId: meta.originSenderId } : {}) };
}

/** Explicit envelope facts and narrowly correlated task controls bypass classification. */
export function reliableAttentionRoute(event, { botId, store, participants = [] }) {
  if (event.sender === botId) return undefined;
  const meta = metadata(event);
  const isHuman = participants.some(person => person.id === event.sender && person.kind === 'human');
  const isBot = participants.some(person => person.id === event.sender && person.kind === 'bot');
  const targeted = Array.isArray(meta.to) && meta.to.includes(botId);
  const replyNotification = isBot && meta.kind === 'reply' && meta.mentions?.replyUserId === botId
    && !meta.mentions.users?.includes(botId);
  const mentioned = !replyNotification && event.content?.['m.mentions']?.user_ids?.includes(botId);
  // An explicit recipient for another member wins over an incidental reply quote.
  if (!targeted && !mentioned && (meta.to?.length || event.content?.['m.mentions']?.user_ids?.length)) return undefined;
  const replacementId = event.content?.['m.relates_to']?.rel_type === 'm.replace' ? event.content['m.relates_to'].event_id : undefined;
  const replaced = replacementId && store.item(replacementId);
  if (isHuman && replaced?.event.sender === event.sender && replaced.event.room_id === event.room_id
    && ['queued', 'running', 'produced', 'generated', 'unknown'].includes(replaced.status)) {
    return { kind: 'reliable', reason: 'active_task_control', sourceEventId: replaced.event_id };
  }
  const task = isHuman && store.correlatedActiveTask(event);
  const body = event.content?.['m.new_content']?.body ?? event.content.body;
  const deliveryOnly = parseDeliveryDirective(body.replace(/^(?:请\s*)?(?:改成|改为)\s*/u, ''), event.sender)?.routingOnly;
  if (task && !deliveryOnly && (['task.cancel', 'task.update'].includes(meta.kind)
    || /^(?:请\s*)?(?:取消(?:这个|该|刚才的)?任务|停止(?:这个|该|刚才的)?任务|别做了|不用做了|cancel(?:\s+(?:this|the))?\s+task|stop\s+(?:this\s+)?task)[。.!！\s]*$/iu.test(body)
    || /^(?:请\s*)?(?:改成|改为|改一下|更正|补充要求|任务更新|update\s+(?:the\s+)?task\b)/iu.test(body))) {
    return { kind: 'reliable', reason: 'active_task_control', sourceEventId: task.event_id,
      ...(meta.kind === 'task.cancel' || /取消|停止|别做了|不用做了|^(?:cancel|stop)\b/iu.test(body) ? { cancel: true } : {}) };
  }
  if (targeted) return { kind: 'reliable', reason: 'targeted' };
  if (mentioned) return { kind: 'reliable', reason: 'matrix_mention' };
  const reference = replyId(event);
  if (reference) {
    const source = store.message(reference);
    const request = store.item(reference) || store.sourceForSentEvent(reference);
    if (isHuman && (source?.room_id === event.room_id && source.sender === botId
      || request?.event.room_id === event.room_id && request.event.sender === event.sender)) {
      return { kind: 'reliable', reason: 'reply_to_conversation', sourceEventId: request?.event_id || reference };
    }
  }
  if (isHuman && meta.conversationKind === 'direct') {
    const roomMembers = store.roomContext(event.room_id).members || [];
    if (roomMembers.length === 2 && roomMembers.includes(event.sender) && roomMembers.includes(botId)) {
      return { kind: 'reliable', reason: 'direct_conversation' };
    }
  }
  // Task controls are correlated to this sender's actual task; they do not turn
  // arbitrary unaddressed text into a new task or grant any new capability.
  return undefined;
}

/** Stagger contenders using shared facts; recent speakers take a later slot. */
export function participationDelay({ botId, eventId, participants, recentMessages, coordinationMs }) {
  const candidates = participants.filter(person => person.kind === 'bot').map(person => person.id);
  if (candidates.length < 2 || !coordinationMs) return 0;
  const counts = new Map(candidates.map(id => [id, recentMessages.filter(message => message.senderId === id).length]));
  const hash = id => createHash('sha256').update(`${eventId}\0${id}`).digest('hex');
  candidates.sort((a, b) => counts.get(a) - counts.get(b) || hash(a).localeCompare(hash(b)));
  return Math.max(0, candidates.indexOf(botId)) * coordinationMs;
}

export function attentionConflict(evidence, source, newer, participants) {
  const knownBots = new Set(participants.filter(person => person.kind === 'bot').map(person => person.id));
  const triggers = new Set(evidence.eventIds);
  for (const event of newer) {
    if (event.sender === evidence.botId) continue;
    const meta = metadata(event);
    // Explicit task chains keep their reliable routing and are not loop chatter.
    if (['task.request', 'task.result', 'task.failure'].includes(meta.kind)) continue;
    const reference = replyId(event);
    const sameThread = attentionThread(event) === attentionThread(source);
    const referencesTrigger = triggers.has(reference) || triggers.has(event.content?.['m.relates_to']?.event_id);
    if (knownBots.has(event.sender) && referencesTrigger) return 'peer_responded';
    if (event.sender === source.sender && (sameThread || referencesTrigger)) return 'conversation_changed';
    if (referencesTrigger && !knownBots.has(event.sender)) return 'conversation_changed';
  }
  return undefined;
}

export function trailingBotTurns(messages) {
  let count = 0;
  for (const message of [...messages].reverse()) {
    if (message.senderKind !== 'bot') break;
    if (!['task.request', 'task.result', 'task.failure'].includes(message.kind)) count++;
  }
  return count;
}
