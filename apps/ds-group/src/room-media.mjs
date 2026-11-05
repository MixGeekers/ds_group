import {
  admitted,
  partnersOf,
  roomAllows,
  serverOf,
  policyError,
} from "./governance.mjs";

function attachmentDescriptor(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,200}$/.test(value.id) ||
    typeof value.name !== "string" ||
    !value.name ||
    value.name.length > 500 ||
    /[\x00-\x1f\x7f]/.test(value.name) ||
    typeof value.mimeType !== "string" ||
    !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value.mimeType) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.contentUri !== "string" ||
    !/^mxc:\/\/[^/?#]+\/[^/?#]+$/.test(value.contentUri)
  ) {
    throw policyError(
      400,
      "The room event has an invalid attachment descriptor",
    );
  }
  return {
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    size: value.size,
    sha256: value.sha256,
    contentUri: value.contentUri,
  };
}

/** Attachment references are proven by an actual event in a currently joined room.
 * No remote Core receives a home token, and no arbitrary URI is accepted as proof.
 */
export class RoomMedia {
  constructor({ governance }) {
    this.governance = governance;
  }

  async prove({ client, userId, roomId, eventId, attachmentId }) {
    if (
      typeof eventId !== "string" ||
      !eventId.startsWith("$") ||
      eventId.length > 512
    )
      throw policyError(400, "An exact source event ID is required");
    const base = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;
    const joined = await client.request("GET", `${base}/joined_members`);
    if (!joined.joined?.[userId])
      throw policyError(
        403,
        "Current room membership is required for attachment access",
      );
    const [event, state] = await Promise.all([
      client.request("GET", `${base}/event/${encodeURIComponent(eventId)}`),
      client.request("GET", `${base}/state`),
    ]);
    if (
      event.event_id !== eventId ||
      (event.room_id && event.room_id !== roomId) ||
      event.type !== "m.room.message"
    )
      throw policyError(
        403,
        "The attachment source event does not belong to this room",
      );
    const matches = event.content?.["org.ds_group"]?.attachments;
    const candidates = Array.isArray(matches)
      ? matches.filter((value) => value?.id === attachmentId)
      : [];
    if (candidates.length !== 1)
      throw policyError(
        candidates.length ? 409 : 404,
        "The exact attachment is not uniquely referenced by this event",
      );
    const attachment = attachmentDescriptor(candidates[0]);
    const policy = await this.governance.read();
    const rule = policy.rooms.find((row) => row.roomId === roomId);
    const authority =
      rule?.authority ||
      serverOf(state.find((row) => row.type === "m.room.create")?.sender);
    if (
      !admitted(policy, userId) ||
      !authority ||
      (rule && !rule.enabled) ||
      (authority !== policy.serverName &&
        (!partnersOf(policy).includes(authority) ||
          !roomAllows(policy, roomId, userId)))
    ) {
      throw policyError(
        403,
        "This collaboration room is no longer approved for attachment access",
      );
    }
    const source = attachment.contentUri.slice(6).split("/")[0];
    if (source !== policy.serverName && !partnersOf(policy).includes(source))
      throw policyError(
        403,
        "The attachment media server is not an approved partner",
      );
    return {
      attachment,
      proof: {
        roomId,
        eventId,
        senderId: event.sender,
        authority,
        policyRevision: policy.revision,
      },
    };
  }
}
