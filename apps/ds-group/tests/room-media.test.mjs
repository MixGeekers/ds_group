import test from "node:test";
import assert from "node:assert/strict";
import { RoomMedia } from "../src/room-media.mjs";
import { emptyPolicy, roomWorkPolicy } from "../src/governance.mjs";

const userId = "@alice:b.test";
const roomId = "!shared";
const eventId = "$attachment-source";
const attachment = {
  id: "attachment-synthetic",
  name: "shared.csv",
  mimeType: "text/csv",
  size: 12,
  sha256: "a".repeat(64),
  contentUri: "mxc://a.test/stable-media",
};
function fixture() {
  const policy = {
    ...emptyPolicy("b.test"),
    partners: [{ serverName: "a.test", name: "A", enabled: true }],
    members: [
      { id: "@author:a.test", name: "Author", kind: "human", enabled: true },
    ],
    rooms: [
      {
        roomId,
        authority: "a.test",
        name: "Shared",
        enabled: true,
        memberIds: [userId],
        botIds: [],
        tools: [],
      },
    ],
  };
  const event = {
    event_id: eventId,
    room_id: roomId,
    type: "m.room.message",
    sender: "@author:a.test",
    content: { "org.ds_group": { attachments: [attachment] } },
  };
  const client = {
    request: async (_method, route) => {
      if (route.endsWith("/joined_members"))
        return { joined: { [userId]: {} } };
      if (route.endsWith("/state"))
        return [{ type: "m.room.create", sender: "@creator:central.test" }];
      if (route.includes("/event/")) return event;
      throw new Error("Unexpected request");
    },
  };
  return {
    policy,
    event,
    client,
    media: new RoomMedia({ governance: { read: async () => policy } }),
    input: { client, userId, roomId, eventId, attachmentId: attachment.id },
  };
}

test("cross-server media requires an exact event proof and current membership, using explicit room association before creator inference", async () => {
  const { media, input } = fixture();
  const result = await media.prove(input);
  assert.deepEqual(result.attachment, attachment);
  assert.deepEqual(result.proof, {
    roomId,
    eventId,
    senderId: "@author:a.test",
    authority: "a.test",
    policyRevision: 0,
  });
  await assert.rejects(media.prove({ ...input, userId: "@outsider:b.test" }), {
    status: 403,
  });
  await assert.rejects(
    media.prove({ ...input, attachmentId: "guessed-private-id" }),
    { status: 404 },
  );
  await assert.rejects(
    media.prove({ ...input, eventId: "not-a-matrix-event" }),
    { status: 400 },
  );
});

test("foreign room, revoked partner/member scope and unlisted media server cannot be substituted into an attachment proof", async () => {
  const value = fixture();
  value.event.room_id = "!another-private-room";
  await assert.rejects(value.media.prove(value.input), { status: 403 });
  value.event.room_id = roomId;
  value.policy.partners[0].enabled = false;
  await assert.rejects(value.media.prove(value.input), { status: 403 });
  value.policy.partners[0].enabled = true;
  value.policy.rooms[0].memberIds = [];
  await assert.rejects(value.media.prove(value.input), { status: 403 });
  value.policy.rooms[0].memberIds = [userId];
  value.event.content["org.ds_group"].attachments = [
    { ...attachment, contentUri: "mxc://third.test/denied" },
  ];
  await assert.rejects(value.media.prove(value.input), { status: 403 });
});

test("event attachment descriptors reject ambiguous IDs and unsafe headers before any byte transfer", async () => {
  const value = fixture();
  value.event.content["org.ds_group"].attachments = [attachment, attachment];
  await assert.rejects(value.media.prove(value.input), { status: 409 });
  value.event.content["org.ds_group"].attachments = [
    { ...attachment, mimeType: "text/plain\r\nX-Injected: yes" },
  ];
  await assert.rejects(value.media.prove(value.input), { status: 400 });
  value.event.content["org.ds_group"].attachments = [
    { ...attachment, sha256: "unverified" },
  ];
  await assert.rejects(value.media.prove(value.input), { status: 400 });
});

test("published work policy binds issuer, room and version and removes revoked external identities", () => {
  const { policy } = fixture();
  const rule = {
    ...policy.rooms[0],
    authority: "b.test",
    botIds: ["@worker:b.test", "@helper:a.test"],
    memberIds: ["@author:a.test"],
  };
  const first = roomWorkPolicy(policy, rule);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.issuerId, "@dscord-control:b.test");
  assert.equal(first.roomId, roomId);
  assert.equal(first.revision, 0);
  assert.deepEqual(first.botIds, ["@worker:b.test"]);
  assert.deepEqual(first.memberIds, ["@author:a.test"]);
  policy.members[0].enabled = false;
  assert.deepEqual(roomWorkPolicy(policy, rule).memberIds, []);
});

test("proven reads support existing files above the default upload ceiling and reject unsafe declared sizes", async () => {
  const value = fixture();
  value.event.content["org.ds_group"].attachments = [
    { ...attachment, size: 100 * 1024 * 1024 },
  ];
  assert.equal(
    (await value.media.prove(value.input)).attachment.size,
    100 * 1024 * 1024,
  );
  value.event.content["org.ds_group"].attachments[0].size =
    Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(value.media.prove(value.input), { status: 400 });
  value.event.content["org.ds_group"].attachments[0].size = -1;
  await assert.rejects(value.media.prove(value.input), { status: 400 });
});
