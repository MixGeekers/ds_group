import { isDeepStrictEqual } from 'node:util';

/** All credentials and proofs stay at the Bot's original home. */
export function createNodeWorkClient(
  coreUrl,
  nodeSecret,
  botId,
  fetchImpl = fetch,
) {
  async function call(route, body) {
    let response;
    try {
      response = await fetchImpl(new URL(route, coreUrl), {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${nodeSecret}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw Object.assign(new Error('Home work authority is unavailable'), {
        networkError: true,
        cause,
      });
    }
    const result = await response.json();
    if (!response.ok)
      throw Object.assign(
        new Error(result.error || 'Bot work authorization rejected'),
        { status: response.status, code: result.code },
      );
    return result;
  }
  return {
    join: (roomId) =>
      call(`/internal/bots/${encodeURIComponent(botId)}/join`, { roomId }),
    directory: (roomId) =>
      call(
        `/internal/bots/${encodeURIComponent(botId)}/rooms/${encodeURIComponent(roomId)}/directory`,
      ),
    admit: (event, nodeTools, nodeMaxBytes) =>
      call(`/internal/bots/${encodeURIComponent(botId)}/work`, {
        roomId: event.room_id,
        eventId: event.event_id,
        nodeTools,
        nodeMaxBytes,
      }),
    check: (request, stage, details = {}) =>
      request.authorization?.kind === 'scoped'
        ? call('/internal/bot-work/check', {
            ...details,
            requestId: request.requestId,
            botId,
            stage,
          })
        : stage === 'deliver'
          ? call('/internal/bot-work/check-local-delivery', {
              ...details,
              botId,
              requestId: request.requestId,
              sourceRoomId: request.event.roomId,
              eventId: request.event.eventId,
            })
          : Promise.resolve({ authorized: true }),
  };
}

export function scopedTaskRequest(request, admission, event) {
  if (admission.mode !== 'scoped') {
    const home = request.botId.slice(request.botId.indexOf(':') + 1);
    return {
      ...request,
      event: {
        ...request.event,
        availableBots: (request.event.availableBots || []).filter(
          (person) => person.id.slice(person.id.indexOf(':') + 1) === home,
        ),
      },
    };
  }
  if (
    event.sender !== admission.event.sender ||
    event.room_id !== admission.event.room_id ||
    event.event_id !== admission.event.event_id ||
    !isDeepStrictEqual(event.content, admission.event.content)
  )
    throw Object.assign(
      new Error('The synced task differs from its Matrix event proof'),
      { status: 403 },
    );
  const participants = new Map(
    admission.participants.map((person) => [person.id, person]),
  );
  const {
    originSenderId,
    originRoomId,
    originEventId,
    returnTo,
    kind,
    hop,
    taskId,
    fileBatch,
    ...source
  } = request.event;
  return {
    ...request,
    authorization: admission.work,
    event: {
      ...source,
      senderId: admission.work.requesterId,
      senderName:
        participants.get(admission.work.requesterId)?.name ||
        admission.work.requesterId,
      senderKind: 'human',
      availableBots: [],
      attachments: admission.inputs,
      conversationKind: admission.work.conversationKind,
      taskId: `task-${admission.work.requestId.slice(7, 31)}`,
      hop: 0,
      originSenderId: admission.work.requesterId,
      originRoomId: admission.work.roomId,
      originEventId: admission.work.eventId,
    },
    history: (request.history || [])
      .filter((item) => participants.has(item.senderId))
      .map((item) => ({
        eventId: item.eventId,
        senderId: item.senderId,
        senderName: participants.get(item.senderId).name,
        senderKind: participants.get(item.senderId).kind,
        body: item.body,
      })),
  };
}
