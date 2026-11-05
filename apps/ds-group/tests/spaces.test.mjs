import test from "node:test";
import assert from "node:assert/strict";
import { CollaborationService } from "../src/collaboration.mjs";
import { emptyPolicy } from "../src/governance.mjs";

function fixture() {
  const userId = "@alice:home.test";
  const policy = {
    ...emptyPolicy("home.test"),
    partners: [{ serverName: "partner.test", name: "Partner", enabled: true }],
    rooms: [
      {
        roomId: "!foreign",
        authority: "partner.test",
        name: "Registered space",
        enabled: true,
        memberIds: [userId],
        tools: [],
        botIds: [],
      },
    ],
  };
  const states = {
    "!new": [
      { type: "m.room.create", sender: userId },
      { type: "m.room.name", content: { name: "New joined room" } },
      {
        type: "m.room.member",
        state_key: userId,
        content: { membership: "join" },
      },
    ],
    "!foreign": [
      { type: "m.room.create", sender: userId },
      {
        type: "m.room.member",
        state_key: userId,
        content: { membership: "join" },
      },
    ],
  };
  let joined = ["!new", "!foreign"];
  const client = {
    sync: async () => ({ rooms: { join: {} } }),
    request: async (_method, route) => {
      if (route.endsWith("/joined_rooms")) return { joined_rooms: joined };
      const roomId = decodeURIComponent(
        route.match(/\/rooms\/([^/]+)\/state$/)?.[1] || "",
      );
      return states[roomId];
    },
  };
  return {
    userId,
    policy,
    states,
    client,
    setJoined: (value) => {
      joined = value;
    },
    service: new CollaborationService({
      setup: { serverName: "home.test" },
      accounts: {},
      governance: { read: async () => policy },
    }),
  };
}

test("empty sync joined results cannot hide actual newly joined rooms or replace their current state", async () => {
  const value = fixture();
  const result = await value.service.spaces(value.client, value.userId);
  const home = result.spaces.find((space) => space.home);
  assert.deepEqual(
    home.rooms.map((room) => [room.roomId, room.name, room.canSend]),
    [["!new", "New joined room", true]],
  );
  const remote = result.spaces.find((space) => !space.home);
  assert.equal(remote.serverName, "partner.test");
  assert.equal(remote.rooms[0].authoritySource, "registered");
  assert.equal(remote.rooms[0].canSend, true);
});

test("stale sync history cannot restore departed rooms or override revoked room and partner policy", async () => {
  const value = fixture();
  value.client.sync = async () => ({
    rooms: {
      join: {
        "!departed": {
          state: { events: [{ type: "m.room.create", sender: value.userId }] },
        },
      },
    },
  });
  value.policy.rooms[0].enabled = false;
  let result = await value.service.spaces(value.client, value.userId);
  assert.equal(
    result.spaces.some((space) =>
      space.rooms.some((room) => room.roomId === "!departed"),
    ),
    false,
  );
  assert.equal(
    result.spaces.find((space) => !space.home).rooms[0].canSend,
    false,
  );
  value.policy.rooms[0].enabled = true;
  value.policy.partners[0].enabled = false;
  result = await value.service.spaces(value.client, value.userId);
  assert.equal(result.spaces.find((space) => !space.home).status, "revoked");
  assert.equal(
    result.spaces.find((space) => !space.home).rooms[0].canSend,
    false,
  );
  value.setJoined(["!new"]);
  result = await value.service.spaces(value.client, value.userId);
  assert.equal(
    result.spaces.some((space) => !space.home),
    false,
  );
});
