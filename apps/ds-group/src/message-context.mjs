import { withoutNativeMemoryViews } from './native-request.mjs';

const metadata = event => event.content?.['org.ds_group'] || {};
export const homeOf = id => typeof id === 'string' && id.startsWith('@') && id.includes(':') ? id.slice(id.indexOf(':') + 1) : null;

/** Names are labels. Only the full Matrix ID identifies a speaker. */
export function speakerOf(id, participants = [], room = {}) {
  const person = participants.find(person => person.id === id);
  const profile = Object.hasOwn(room.memberProfiles || {}, id) ? room.memberProfiles[id] : undefined;
  const roomLabel = profile && Object.hasOwn(profile, 'displayname');
  // Matrix membership supplies only the label of this exact account in this
  // room/snapshot. It cannot supply identity kind, ownership or another ID.
  const name = roomLabel ? typeof profile.displayname === 'string' && profile.displayname.trim() || id : person?.name || id;
  return { id, name, kind: person?.kind || 'unknown', homeServer: homeOf(id),
    identitySource: person?.identitySource || (person ? 'account-directory' : 'matrix-event'),
    ...(roomLabel ? { nameSource: profile.source === 'room-directory' ? 'room-directory' : 'matrix-member-state',
      nameObservedAt: Number.isFinite(profile.observedAt) ? profile.observedAt : null,
      nameEventTimestamp: Number.isFinite(profile.eventTimestamp) ? profile.eventTimestamp : null,
      nameEventId: typeof profile.eventId === 'string' ? profile.eventId : null } : {}),
    ...(person?.ownerId ? { ownerId: person.ownerId } : {}) };
}

export function threadOf(event) {
  const relation = event.content?.['m.relates_to'];
  return relation?.rel_type === 'm.thread' && typeof relation.event_id === 'string' ? relation.event_id : null;
}

/** Retain source facts separately from statements quoted or relayed by a sender. */
export function messageSource(event, participants, room = {}) {
  const meta = metadata(event);
  const replyTo = meta.replyTo || event.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;
  return { transport: 'matrix', eventId: event.event_id, roomId: event.room_id,
    ...(event.withdrawn || event.unsigned?.redacted || event.unsigned?.redacted_because ? { withdrawn: true } : {}),
    ...(event.type === 'm.room.redaction' && (event.redacts || event.content?.redacts) ? { retractsEventId: event.redacts || event.content.redacts } : {}),
    ...(event.content?.['m.relates_to']?.rel_type === 'm.replace' ? { replacesEventId: event.content['m.relates_to'].event_id } : {}),
    sender: speakerOf(event.sender, participants, room), timestamp: event.origin_server_ts ?? null,
    threadRootId: threadOf(event), ...(replyTo ? { replyTo } : {}),
    ...(meta.originSenderId || meta.originEventId ? { relay: {
      source: 'sender-metadata', senderId: meta.originSenderId || null,
      roomId: meta.originRoomId || null, eventId: meta.originEventId || null,
      taskId: meta.taskId || null,
    } } : {}) };
}

/** The observation and addressed-message paths use the same source contract. */
export function observedMemoryInput(event, participants = [], room = {}) {
  const source = messageSource(event, participants, room);
  const content = event.content?.['m.new_content'] || event.content || {};
  return { event: { eventId: event.event_id, roomId: event.room_id, senderId: event.sender,
    senderKind: source.sender.kind, body: content.body || '', timestamp: event.origin_server_ts ?? null },
    context: { source, room: { id: event.room_id, name: room.name || event.room_id, topic: room.topic || '' },
      members: (room.members || []).map(id => speakerOf(id, participants, room)) } };
}

export function conversationContext({ event, participants, room = {}, sourceRoom = room, replyRoom = sourceRoom,
  threadRootRoom = sourceRoom, history = [], earlierCount = 0, reply, threadRoot }) {
  const threadRootId = threadOf(event);
  const source = messageSource(event, participants, sourceRoom);
  const quote = (value, snapshot) => value ? { source: messageSource(value, participants, snapshot), body: value.content?.body || '' } : null;
  return {
    version: 1,
    key: JSON.stringify(['matrix', event.room_id, threadRootId]),
    room: { id: event.room_id, name: room.name || event.room_id, topic: room.topic || '',
      kind: metadata(event).conversationKind || 'group', creatorId: room.creatorId || null,
      creatorHomeServer: homeOf(room.creatorId), parentSpaceIds: room.parentSpaceIds || [] },
    source,
    threadRoot: threadRootId ? quote(threadRoot, threadRootRoom) || { eventId: threadRootId, available: false } : null,
    reply: source.replyTo ? quote(reply, replyRoom) || { eventId: source.replyTo, available: false } : null,
    members: (room.members || []).map(id => speakerOf(id, participants, room)),
    history: { scope: 'current-room', count: history.length, earlierMessagesOmitted: earlierCount,
      complete: false, note: 'Recent locally synchronized room history; not the entire conversation.' },
  };
}

/** A routing envelope in the existing native Session, not another tool scope. */
export function nativeMessage({ input, bot, files }) {
  input = withoutNativeMemoryViews(input);
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
    + '\n称呼优先采用当前房间成员资料或最新身份视图中的显示名；source、引用和历史快照里的旧名只说明当时标签。完整 ID 用于内部关联，需要消歧时只呈现必要信息，不必在普通交流里反复报账号。'
    + '\ncontext 标明当前群组、话题和消息来源。recentRoomHistory 是这个群的近期历史，不代表全部历史；引用和转述保留各自作者，不把 Bot 转述当作原作者亲口说的话。'
    + '\n你仍保留其他群和本地对话的经历；切换群组时以这次 context 为当前对话，使用跨群知识时说明来源，不把其他群的说法当成本群已经达成的决定。记录长期记忆时一并保留相关的人、群 ID 和来源事件。'
    + '\n本次可执行工作来自这条可靠请求，或运行时已经委托且尚未完成的事项。若 context.attention.participationOnly 为 true，这是交流回合；可自然回应、澄清、跟进已有承诺，但不要把旁听中的后到请求或普通 Bot 提议自动接成新的文件/工具任务。待处理请求由其队列和回合接管，Bot 提议先保留为建议；普通事实、更正与当前工作的有效更新仍可立即采用。'
    + '\n直接回答当前发送者，桥接层在回合结束后按本次 replyRoute 提交 Matrix 回复；之前任务的回复目标不会改变本次目标。本机群工具使用独立的原生群 ID，其回执只说明那次群调用；当前 Matrix 回合的最终送达回执在提交后产生。'
    + '\n需要交付文件时，调用 present 或在最终回复列出 {"text":"说明","artifacts":[{"path":"文件绝对路径","name":"文件名"}]}，逐个包括本轮要发的文件。重发已有文件、终端生成的文件也一样；只说文件名、哈希或“已附上”不构成交付。附件目录只是收件位置，你仍使用原生工作目录和全部工具。'
    + '\n已授权工具工作中的可逆实现选择应自主完成，发现可修复的问题后继续修复并完成交付；仅在缺少影响结果的实质事实或必要授权时提问。'
    + '\n用户需要可运行或可复现的交付时，带齐复跑所需的输入、测试数据和运行说明，形成自包含文件集；仅用实际交付内容在干净目录验证，排除工作区未交付文件的隐含依赖。按真实工具结果和实际产物差异描述完成与验证状态，明确尚未验证或未通过的部分。'
    + '\n本机 Bot 协作继续使用 message_bot；跨 DSCord 节点可使用 {"text":"说明","delegate":{"to":"完整 Bot ID","body":"任务"}}，并在任务内容中带上相关来源。'
    + `\n${JSON.stringify(envelope)}`;
}
