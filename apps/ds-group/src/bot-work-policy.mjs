import { createHash } from 'node:crypto';
import {
  FILE_TOOLS,
  admitted,
  partnersOf,
  policyError,
  serverOf,
} from './governance.mjs';

export const ROOM_WORK_EVENT = 'org.dscord.work_policy';
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const workHash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export const workRequestId = (botId, eventId) =>
  `matrix-${createHash('sha256').update(`${botId}\0${eventId}`).digest('hex')}`;
export const denyWork = (message) =>
  Object.assign(policyError(403, message), { code: 'BOT_WORK_DENIED' });
const unique = (value) =>
  Array.isArray(value) &&
  value.every((id) => typeof id === 'string' && id) &&
  new Set(value).size === value.length;

export function validateOwnerGrants(input) {
  if (
    !input ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !Array.isArray(input.grants) ||
    input.grants.length > 100
  ) {
    throw policyError(400, 'Invalid owner work grants');
  }
  const seen = new Set();
  return {
    revision: input.revision,
    grants: input.grants.map((grant) => {
      if (
        !grant ||
        typeof grant.roomId !== 'string' ||
        !/^![^\s]{1,500}$/.test(grant.roomId) ||
        seen.has(grant.roomId) ||
        typeof grant.enabled !== 'boolean' ||
        !unique(grant.requesterIds) ||
        grant.requesterIds.length > 100 ||
        grant.requesterIds.some((id) => !/^@[^:\s]+:[^\s]+$/.test(id)) ||
        !unique(grant.tools) ||
        grant.tools.some((tool) => !FILE_TOOLS.includes(tool))
      )
        throw policyError(400, 'Invalid owner room grant');
      seen.add(grant.roomId);
      return {
        roomId: grant.roomId,
        enabled: grant.enabled,
        requesterIds: [...grant.requesterIds].sort(),
        tools: [...grant.tools].sort(),
      };
    }),
  };
}

export function trustedRoomParticipants({ policy, locals, joinedIds }) {
  const local = new Map(locals.map((person) => [person.id, person]));
  return joinedIds.flatMap((id) => {
    const person =
      local.get(id) ||
      (serverOf(id) !== policy.serverName && admitted(policy, id)
        ? policy.members.find((person) => person.id === id && person.enabled)
        : undefined);
    if (!person) return [];
    return [
      {
        id: person.id,
        name: person.name,
        kind: person.kind,
        homeServer: serverOf(person.id),
        ...(person.localpart ? { localpart: person.localpart } : {}),
        ...(person.ownerId ? { ownerId: person.ownerId } : {}),
        ...(person.role ? { role: person.role } : {}),
      },
    ];
  });
}

/** A room state can only narrow an owner grant; power and publisher identity are verified independently. */
export function verifyRoomWorkState({
  state,
  power,
  roomId,
  authority,
  joinedIds,
}) {
  const content = state?.content;
  const issuerId = `@dscord-control:${authority}`;
  if (
    state?.type !== ROOM_WORK_EVENT ||
    state.state_key !== '' ||
    typeof state.event_id !== 'string' ||
    (state.room_id && state.room_id !== roomId) ||
    state.sender !== issuerId ||
    content?.issuerId !== issuerId ||
    !joinedIds.includes(state.sender) ||
    content?.schemaVersion !== 1 ||
    content.roomId !== roomId ||
    content.authority !== authority ||
    !Number.isSafeInteger(content.revision) ||
    content.revision < 1 ||
    typeof content.enabled !== 'boolean' ||
    content.localMemberAdmission !== 'matrix-membership' ||
    !unique(content.memberIds) ||
    !unique(content.botIds) ||
    !unique(content.tools) ||
    content.tools.some((tool) => !FILE_TOOLS.includes(tool))
  )
    throw denyWork('The room work policy lacks a valid Matrix authority proof');
  const levels = power?.content || {};
  const actual = levels.users?.[state.sender] ?? levels.users_default ?? 0;
  const needed = Math.max(
    50,
    levels.events?.[ROOM_WORK_EVENT] ?? levels.state_default ?? 50,
  );
  if (!Number.isFinite(actual) || actual < needed)
    throw denyWork(
      'The room work policy sender has no current Matrix state power',
    );
  return {
    eventId: state.event_id,
    senderId: state.sender,
    revision: content.revision,
    content,
  };
}

export function effectiveRoomWork({
  bot,
  event,
  participants,
  joinedIds,
  policy,
  grants,
  state,
  power,
  nodeTools,
  maxBytes,
}) {
  const requester = participants.find((person) => person.id === event.sender);
  if (!requester || requester.kind !== 'human' || !joinedIds.includes(bot.id))
    throw denyWork('Work needs an admitted human and the original joined Bot');
  const meta = event.content?.['org.ds_group'] || {};
  if (!Array.isArray(meta.to) || !meta.to.includes(bot.id))
    throw denyWork('This Matrix event does not address this Bot');
  if (['task.request', 'task.result', 'task.failure'].includes(meta.kind))
    throw denyWork('Cross-server Bot delegation has not been granted');
  const room = policy.rooms.find((room) => room.roomId === event.room_id);
  const botRule = policy.botPolicies.find((row) => row.botId === bot.id);
  const owner = grants.grants.find((grant) => grant.roomId === event.room_id);
  const homeAllows = (id) =>
    room?.memberIds.includes(id) ||
    (room?.authority === policy.serverName &&
      serverOf(id) === policy.serverName);
  if (
    !room?.enabled ||
    !room.botIds.includes(bot.id) ||
    !homeAllows(bot.id) ||
    !homeAllows(event.sender) ||
    (room.authority !== policy.serverName &&
      !partnersOf(policy).includes(room.authority)) ||
    !botRule?.enabled ||
    !botRule.roomIds.includes(event.room_id) ||
    !botRule.requesterIds.includes(event.sender) ||
    !owner?.enabled ||
    !owner.requesterIds.includes(event.sender)
  )
    throw denyWork(
      'Owner, home server and room must all permit this exact work request',
    );
  const proof = verifyRoomWorkState({
    state,
    power,
    roomId: event.room_id,
    authority: room.authority,
    joinedIds,
  });
  const originAllows = (id) =>
    serverOf(id) === room.authority || proof.content.memberIds.includes(id);
  if (
    !proof.content.enabled ||
    !originAllows(event.sender) ||
    !originAllows(bot.id) ||
    !proof.content.botIds.includes(bot.id)
  )
    throw denyWork(
      'The origin collaboration room has withdrawn work permission',
    );
  const admittedIds = new Set(participants.map((person) => person.id));
  if (
    joinedIds.some(
      (id) =>
        id !== proof.senderId &&
        (!admittedIds.has(id) || !homeAllows(id) || !originAllows(id)),
    )
  ) {
    throw denyWork(
      'The collaboration room contains a member outside the approved work audience',
    );
  }
  const taskTools = meta.taskTools === undefined ? FILE_TOOLS : meta.taskTools;
  if (
    !unique(taskTools) ||
    taskTools.some((tool) => !FILE_TOOLS.includes(tool)) ||
    !unique(nodeTools)
  )
    throw denyWork('Invalid task or node capability scope');
  const tools = FILE_TOOLS.filter(
    (tool) =>
      owner.tools.includes(tool) &&
      botRule.tools.includes(tool) &&
      room.tools.includes(tool) &&
      proof.content.tools.includes(tool) &&
      nodeTools.includes(tool) &&
      taskTools.includes(tool),
  ).sort();
  const binding = {
    botId: bot.id,
    ownerId: bot.ownerId,
    roomId: event.room_id,
    requesterId: event.sender,
    authority: room.authority,
    ownerRevision: grants.revision,
    ownerGrant: owner,
    botRule,
    roomRule: room,
    policyEventId: proof.eventId,
    policySenderId: proof.senderId,
    policyRevision: proof.revision,
    policyContent: proof.content,
    audience: joinedIds.toSorted(),
    tools,
    maxBytes,
  };
  const proofHash = workHash(binding);
  return {
    kind: 'scoped',
    requestId: workRequestId(bot.id, event.event_id),
    botId: bot.id,
    ownerId: bot.ownerId,
    roomId: event.room_id,
    eventId: event.event_id,
    requesterId: event.sender,
    authority: room.authority,
    ownerRevision: grants.revision,
    policyEventId: proof.eventId,
    policyRevision: proof.revision,
    proofHash,
    tools,
    domainId: workHash([bot.id, room.authority, event.room_id, proofHash]),
    maxInputBytes: maxBytes,
    conversationKind:
      joinedIds.length === 2 && joinedIds.includes(event.sender)
        ? 'direct'
        : 'group',
    canDelegate: false,
  };
}
