const metadata = event => event.content?.['org.ds_group'] || {};
export const homeOf = id => typeof id === 'string' && id.startsWith('@') && id.includes(':') ? id.slice(id.indexOf(':') + 1) : null;

/** Names are labels. Only the full Matrix ID identifies a speaker. */
export function speakerOf(id, participants = []) {
  const person = participants.find(person => person.id === id);
  return { id, name: person?.name || id, kind: person?.kind || 'unknown', homeServer: homeOf(id),
    identitySource: person?.identitySource || (person ? 'account-directory' : 'matrix-event'),
    ...(person?.ownerId ? { ownerId: person.ownerId } : {}) };
}

export function threadOf(event) {
  const relation = event.content?.['m.relates_to'];
  return relation?.rel_type === 'm.thread' && typeof relation.event_id === 'string' ? relation.event_id : null;
}

/** Retain source facts separately from statements quoted or relayed by a sender. */
export function messageSource(event, participants) {
  const meta = metadata(event);
  const replyTo = meta.replyTo || event.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;
  return { transport: 'matrix', eventId: event.event_id, roomId: event.room_id,
    ...(event.content?.['m.relates_to']?.rel_type === 'm.replace' ? { replacesEventId: event.content['m.relates_to'].event_id } : {}),
    sender: speakerOf(event.sender, participants), timestamp: event.origin_server_ts ?? null,
    threadRootId: threadOf(event), ...(replyTo ? { replyTo } : {}),
    ...(meta.originSenderId || meta.originEventId ? { relay: {
      source: 'sender-metadata', senderId: meta.originSenderId || null,
      roomId: meta.originRoomId || null, eventId: meta.originEventId || null,
      taskId: meta.taskId || null,
    } } : {}) };
}

export function conversationContext({ event, participants, room = {}, history = [], earlierCount = 0, reply, threadRoot }) {
  const threadRootId = threadOf(event);
  const source = messageSource(event, participants);
  const quote = value => value ? { source: messageSource(value, participants), body: value.content?.body || '' } : null;
  return {
    version: 1,
    key: JSON.stringify(['matrix', event.room_id, threadRootId]),
    room: { id: event.room_id, name: room.name || event.room_id, topic: room.topic || '',
      kind: metadata(event).conversationKind || 'group', creatorId: room.creatorId || null,
      creatorHomeServer: homeOf(room.creatorId), parentSpaceIds: room.parentSpaceIds || [] },
    source,
    threadRoot: threadRootId ? quote(threadRoot) || { eventId: threadRootId, available: false } : null,
    reply: source.replyTo ? quote(reply) || { eventId: source.replyTo, available: false } : null,
    members: (room.members || []).map(id => speakerOf(id, participants)),
    history: { scope: 'current-room', count: history.length, earlierMessagesOmitted: earlierCount,
      complete: false, note: 'Recent locally synchronized room history; not the entire conversation.' },
  };
}

/** A routing envelope in the existing native Session, not another tool scope. */
export function nativeMessage({ input, bot, files }) {
  const context = input.context || { version: 1, key: JSON.stringify(['matrix', input.event.roomId, null]),
    room: { id: input.event.roomId, kind: input.event.conversationKind || 'group' },
    source: { transport: 'matrix', eventId: input.event.eventId, roomId: input.event.roomId,
      sender: { id: input.event.senderId, name: input.event.senderName || input.event.senderId, kind: input.event.senderKind || 'unknown' } } };
  const envelope = { requestId: input.requestId,
    self: { nativeBotId: bot.id, matrixId: input.botId, name: bot.name, role: bot.role || '' },
    context: { ...context, history: context.history ? { ...context.history, count: input.history?.length || 0 } : undefined },
    currentMessage: input.event, recentRoomHistory: input.history || [],
    historyWarnings: input.historyWarnings || [], attachmentWarnings: input.attachmentWarnings || [],
    attachmentsDirectory: files.workdir, files: files.files,
    replyRoute: { requestId: input.requestId, eventId: input.event.eventId, roomId: input.event.roomId,
      delivery: input.event.delivery || { kind: 'origin' } },
  };
  return `DSCORD_REQUEST=${input.requestId}\n你收到一条 DSCord 消息，继续使用你的原生身份、上下文、记忆和全部工具。`
    + '\n本次说话人以 context.source.sender 的完整 ID 为准，名称只是显示标签；同名的人或 Bot 不是同一身份。'
    + '\ncontext 标明当前群组、话题和消息来源。recentRoomHistory 是这个群的近期历史，不代表全部历史；引用和转述保留各自作者，不把 Bot 转述当作原作者亲口说的话。'
    + '\n你仍保留其他群和本地对话的经历；切换群组时以这次 context 为当前对话，使用跨群知识时说明来源，不把其他群的说法当成本群已经达成的决定。记录长期记忆时一并保留相关的人、群 ID 和来源事件。'
    + '\n直接回答当前发送者，接入层按本次 requestId 的投递记录发送；之前任务的回复目标不会改变本次目标。'
    + '\n交付文件可用 {"text":"说明","artifacts":[{"path":"文件绝对路径","name":"文件名"}]}。附件目录只是收件位置，你仍使用原生工作目录和全部工具。'
    + '\n本机 Bot 协作继续使用 message_bot；跨 DSCord 节点可使用 {"text":"说明","delegate":{"to":"完整 Bot ID","body":"任务"}}，并在任务内容中带上相关来源。'
    + `\n${JSON.stringify(envelope)}`;
}
