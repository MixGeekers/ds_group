export function legacyNativeRequest({ requestId = 'legacy-request', botId = 'a', eventId = '$legacy', roomId = '!legacy:test', senderId = '@alice:test', body = 'Original human wording.' } = {}) {
  const source = { kind: 'user', transport: 'matrix', requestId, rpcId: requestId, eventId, roomId, sender: { id: senderId, kind: 'human' } };
  const envelope = { requestId, self: { nativeBotId: botId, matrixId: '@bot:test' },
    context: { version: 1, room: { id: roomId }, source, attention: { participationOnly: false, memoryView: { marker: 'obsolete-derived-view-attention' } } },
    currentMessage: { eventId, roomId, senderId, body }, recentRoomHistory: [{ body: 'Prior human words.' }],
    memoryView: { schemaVersion: 2, marker: 'obsolete-derived-view-turn' }, files: [], attachmentsDirectory: '/synthetic/attachments',
    replyRoute: { requestId, eventId, roomId, delivery: { kind: 'origin' } } };
  return { id: `message-${requestId}`, role: 'user', source,
    content: [{ type: 'text', text: `DSCORD_REQUEST=${requestId}\nNative DSCord routing envelope.\n${JSON.stringify(envelope)}` }] };
}

export const requestEnvelope = message => JSON.parse(message.content[0].text.split('\n').at(-1));
