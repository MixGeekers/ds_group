import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createHash } from "node:crypto";
import { AdminAuth } from "../src/admin-auth.mjs";
import {
  Governance,
  admitted,
  roomAllows,
  roomAcl,
  validatePolicy,
} from "../src/governance.mjs";
import { createAdmin } from "../src/admin.mjs";
import { CollaborationService } from "../src/collaboration.mjs";
import { createCore } from "../src/core.mjs";
import { SynapseControl } from "../src/synapse-control.mjs";

const temp = () => mkdtemp(path.join(os.tmpdir(), "dscord-governance-"));
const password = "synthetic-admin-password-1234";
const request = (token) => ({ headers: { authorization: `Bearer ${token}` } });
const setup = {
  serverName: "home.test",
  homeserverUrl: "http://127.0.0.1:1",
  roomId: "!local:home.test",
  participants: [
    {
      id: "@alice:home.test",
      name: "Alice",
      kind: "human",
      localpart: "alice",
      accessToken: "synthetic-chat-token",
    },
  ],
};
async function createAuth(root) {
  const auth = await new AdminAuth(root).initialize();
  await auth.change(
    "console",
    { username: "admin", password, role: "owner", enabled: true },
    { bootstrap: true },
  );
  return auth;
}

test("management sessions are instance-specific, revocable and independent from Matrix and room permissions", async () => {
  const [root, otherRoot] = await Promise.all([temp(), temp()]);
  const [auth, other] = await Promise.all([
    createAuth(root),
    createAuth(otherRoot),
  ]);
  try {
    const session = await auth.login(
      { username: "admin", password },
      "test-client",
    );
    assert.equal(auth.authorize(request(session.access_token)).role, "owner");
    for (const token of [
      "synthetic-chat-token",
      "synthetic-node-secret",
      "room-admin-token",
      "dscord_admin_unknown",
    ])
      assert.throws(() => auth.authorize(request(token)), { status: 401 });
    assert.throws(() => other.authorize(request(session.access_token)), {
      status: 401,
    });
    await assert.rejects(
      auth.change("admin", {
        username: "admin",
        role: "operator",
        enabled: true,
      }),
      { status: 409 },
    );
    await auth.change("admin", {
      username: "reviewer",
      password,
      role: "auditor",
      enabled: true,
    });
    const review = await auth.login(
      { username: "reviewer", password },
      "test-client",
    );
    assert.equal(auth.authorize(request(review.access_token)).role, "auditor");
    assert.throws(
      () => auth.authorize(request(review.access_token), ["owner", "operator"]),
      { status: 403 },
    );
    await auth.change("admin", {
      username: "reviewer",
      role: "auditor",
      enabled: false,
    });
    assert.throws(() => auth.authorize(request(review.access_token)), {
      status: 401,
    });
    auth.logout(auth.authorize(request(session.access_token)));
    assert.throws(() => auth.authorize(request(session.access_token)), {
      status: 401,
    });
    assert.equal(JSON.stringify(auth.events()).includes(password), false);
    assert.equal(
      JSON.stringify(auth.events()).includes(session.access_token),
      false,
    );
  } finally {
    auth.close();
    other.close();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(otherRoot, { recursive: true, force: true }),
    ]);
  }
});

test("administrator changes revoke saved sessions across restart, idle expiry and brute-force limits apply", async () => {
  const root = await temp();
  let auth = await createAuth(root);
  try {
    const session = await auth.login(
      { username: "admin", password },
      "client-one",
    );
    auth.close();
    auth = await new AdminAuth(root).initialize();
    assert.equal(
      auth.authorize(request(session.access_token)).username,
      "admin",
    );
    await auth.change("console", {
      username: "admin",
      role: "owner",
      enabled: true,
      password: `${password}-new`,
    });
    assert.throws(() => auth.authorize(request(session.access_token)), {
      status: 401,
    });
    const next = await auth.login(
      { username: "admin", password: `${password}-new` },
      "client-two",
    );
    auth.db
      .prepare("UPDATE admin_sessions SET last_seen=?")
      .run(Date.now() - 3600001);
    assert.throws(() => auth.authorize(request(next.access_token)), {
      status: 401,
    });
    for (let i = 0; i < 10; i++)
      await assert.rejects(
        auth.login(
          { username: "admin", password: "wrong-password-long-enough" },
          "attacker",
        ),
        { status: 401 },
      );
    await assert.rejects(
      auth.login(
        { username: "admin", password: `${password}-new` },
        "attacker",
      ),
      { status: 429 },
    );
  } finally {
    auth.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("policy separates partners, exact member IDs and rooms, persists CAS and fails closed on malformed input", async () => {
  const root = await temp();
  const governance = new Governance({
    dataRoot: root,
    serverName: "home.test",
  });
  try {
    const initial = await governance.ensure();
    const input = {
      ...initial,
      partners: [
        { serverName: "partner.test", name: "Partner", enabled: true },
      ],
      members: [
        { id: "@bob:partner.test", name: "Bob", kind: "human", enabled: true },
      ],
      rooms: [
        {
          roomId: "!shared:home.test",
          authority: "home.test",
          name: "Shared",
          enabled: true,
          memberIds: ["@bob:partner.test"],
          tools: ["read"],
          botIds: [],
        },
      ],
    };
    const [first, second] = await Promise.allSettled([
      governance.save(input),
      governance.save(input),
    ]);
    assert.equal(first.status, "fulfilled");
    assert.equal(second.status, "rejected");
    assert.equal(second.reason.status, 409);
    const policy = await governance.read();
    assert.equal(policy.revision, 1);
    assert.equal(admitted(policy, "@bob:partner.test"), true);
    assert.equal(admitted(policy, "@unapproved:partner.test"), false);
    assert.equal(admitted(policy, "@bob:third.test"), false);
    assert.equal(
      roomAllows(policy, "!shared:home.test", "@bob:partner.test"),
      true,
    );
    assert.equal(
      roomAllows(policy, "!private:home.test", "@bob:partner.test"),
      false,
    );
    assert.deepEqual(roomAcl(policy, policy.rooms[0]).allow, [
      "home.test",
      "partner.test",
    ]);
    const portPolicy = {
      ...policy,
      serverName: "home.test:8448",
      partners: [
        { serverName: "partner.test:9448", name: "Partner", enabled: true },
      ],
      members: [
        {
          id: "@bob:partner.test:9448",
          name: "Bob",
          kind: "human",
          enabled: true,
        },
      ],
    };
    assert.deepEqual(
      roomAcl(portPolicy, {
        enabled: true,
        memberIds: ["@bob:partner.test:9448"],
      }).allow,
      ["home.test", "home.test:8448", "partner.test", "partner.test:9448"],
    );
    assert.equal(admitted(portPolicy, "@bob:partner.test:8448"), false);
    const next = await governance.save({
      ...policy,
      partners: policy.partners.map((row) => ({ ...row, enabled: false })),
    });
    assert.equal(admitted(next, "@bob:partner.test"), false);
    assert.deepEqual(roomAcl(next, next.rooms[0]).allow, ["home.test"]);
    assert.throws(
      () => validatePolicy({ ...next, serverName: "other.test" }, "home.test"),
      { status: 400 },
    );
    await assert.rejects(
      governance.save({
        ...next,
        botPolicies: [
          {
            botId: "@bot:home.test",
            enabled: true,
            roomIds: ["!shared:home.test"],
            requesterIds: ["@bob:partner.test"],
            tools: ["bash"],
            canDelegate: false,
          },
        ],
      }),
      { status: 400 },
    );
    const before = await readFile(governance.filename, "utf8");
    await assert.rejects(
      governance.save({
        ...next,
        members: [{ id: "bob", name: "Bob", kind: "human", enabled: true }],
      }),
      { status: 400 },
    );
    assert.equal(await readFile(governance.filename, "utf8"), before);
    await writeFile(governance.filename, "{broken");
    await assert.rejects(governance.read());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("independent management HTTP enforces roles, origin checks, JSON limits and audit without exposing Synapse credentials", async () => {
  const root = await temp();
  const auth = await createAuth(root);
  auth.close();
  let applyCalls = 0;
  const admin = await createAdmin({
    dataRoot: root,
    setup,
    controlFactory: ({ governance }) => ({
      status: async () => ({
        savedRevision: (await governance.read()).revision,
        livePolicyObserved: false,
        restartRequired: true,
      }),
      apply: async (revision) => {
        applyCalls++;
        return { revision };
      },
      invite: async () => ({ event_id: "$invite" }),
    }),
  });
  await new Promise((resolve) => admin.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${admin.server.address().port}`;
  const call = (route, method = "GET", body, token, origin) =>
    fetch(base + route, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...(origin ? { origin } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal((await call("/healthz")).status, 200);
    assert.equal(
      (
        await call(
          "/admin-api/policy",
          "GET",
          undefined,
          "synthetic-chat-token",
        )
      ).status,
      401,
    );
    assert.equal((await call("/api/bootstrap")).status, 404);
    const signedIn = await (
      await call("/admin-api/login", "POST", { username: "admin", password })
    ).json();
    const token = signedIn.access_token;
    assert.equal(
      (
        await call(
          "/admin-api/policy",
          "GET",
          undefined,
          token,
          "https://attacker.test",
        )
      ).status,
      403,
    );
    const state = await (
      await call("/admin-api/policy", "GET", undefined, token, base)
    ).json();
    assert.equal(state.policy.serverName, "home.test");
    assert.equal(
      (
        await call(
          "/admin-api/policy",
          "PUT",
          {
            ...state.policy,
            settings: { registrationMode: "closed", maxUploadBytes: null },
          },
          token,
        )
      ).status,
      200,
    );
    assert.equal(
      (await call("/admin-api/policy", "PUT", state.policy, token)).status,
      409,
    );
    assert.equal(
      (
        await call(
          "/admin-api/administrators",
          "PUT",
          { username: "reader", password, enabled: true, role: "auditor" },
          token,
        )
      ).status,
      200,
    );
    const reader = await (
      await call("/admin-api/login", "POST", { username: "reader", password })
    ).json();
    assert.equal(
      (
        await call(
          "/admin-api/apply",
          "POST",
          { revision: 1 },
          reader.access_token,
        )
      ).status,
      403,
    );
    assert.equal(applyCalls, 0);
    assert.equal(
      (
        await call(
          "/admin-api/administrators",
          "PUT",
          { username: "evil", password, enabled: true, role: "owner" },
          reader.access_token,
        )
      ).status,
      403,
    );
    assert.equal(
      (await call("/admin-api/apply", "POST", { revision: 1 }, token)).status,
      200,
    );
    assert.equal(applyCalls, 1);
    const audit = await (
      await call("/admin-api/audit", "GET", undefined, token)
    ).json();
    assert.ok(audit.events.some((event) => event.action === "policy.save"));
    assert.equal(JSON.stringify(audit).includes(password), false);
    assert.equal(JSON.stringify(audit).includes(token), false);
    await call("/admin-api/logout", "POST", {}, token);
    assert.equal(
      (await call("/admin-api/overview", "GET", undefined, token)).status,
      401,
    );
  } finally {
    await admin.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("space grouping uses registered authority before creator inference and keeps invitation-only admission", async () => {
  const root = await temp();
  const governance = new Governance({
    dataRoot: root,
    serverName: "home.test",
  });
  try {
    await governance.save({
      ...(await governance.read()),
      partners: [
        { serverName: "partner.test", name: "Partner", enabled: true },
      ],
      members: [
        { id: "@bob:partner.test", name: "Bob", kind: "human", enabled: true },
      ],
      rooms: [
        {
          roomId: "!joined",
          authority: "partner.test",
          name: "Remote space",
          enabled: true,
          memberIds: ["@alice:home.test"],
          tools: [],
          botIds: [],
        },
        {
          roomId: "!invite",
          authority: "partner.test",
          name: "Invited",
          enabled: true,
          memberIds: ["@alice:home.test"],
          tools: [],
          botIds: [],
        },
      ],
    });
    const creation = {
      type: "m.room.create",
      sender: "@alice:home.test",
      content: {},
    };
    const client = {
      sync: async () => ({
        rooms: {
          join: { "!joined": { state: { events: [creation] } } },
          invite: {
            "!invite": {
              invite_state: {
                events: [
                  creation,
                  {
                    type: "m.room.member",
                    sender: "@bob:partner.test",
                    state_key: "@alice:home.test",
                  },
                ],
              },
            },
            "!unapproved": {
              invite_state: {
                events: [
                  { type: "m.room.create", sender: "@bob:partner.test" },
                  {
                    type: "m.room.member",
                    sender: "@bob:partner.test",
                    state_key: "@alice:home.test",
                  },
                ],
              },
            },
          },
        },
      }),
    };
    const service = new CollaborationService({
      setup,
      governance,
      accounts: {},
    });
    const result = await service.spaces(client, "@alice:home.test");
    assert.equal(result.spaces.length, 2);
    const remote = result.spaces.find((row) => !row.home);
    assert.equal(remote.serverName, "partner.test");
    assert.equal(remote.rooms[0].authoritySource, "registered");
    assert.equal(remote.rooms[0].canSend, true);
    assert.equal(
      remote.invitations.find((row) => row.roomId === "!invite").canJoin,
      true,
    );
    assert.equal(
      remote.invitations.find((row) => row.roomId === "!unapproved").canJoin,
      false,
    );
    service.accounts.me = async () => {
      throw Object.assign(new Error("This account is not active"), {
        status: 403,
      });
    };
    await assert.rejects(service.identity(request("inactive-token")), {
      status: 403,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy home Core stays compatible while administration policy changes registration without upgrading chat credentials", async () => {
  const root = await temp();
  const core = await createCore({
    setup: structuredClone(setup),
    dataRoot: root,
    config: { nodeSecret: "synthetic-node-secret" },
    enablePush: false,
  });
  await new Promise((resolve) => core.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${core.server.address().port}`;
  try {
    const before = await (await fetch(base + "/api/bootstrap")).json();
    assert.equal(before.serverName, "home.test");
    assert.equal(before.participants[0].id, setup.participants[0].id);
    await core.governance.save({
      ...(await core.governance.read()),
      settings: { registrationMode: "closed", maxUploadBytes: 2097152 },
      partners: [
        { serverName: "partner.test", name: "Partner", enabled: true },
      ],
      members: [
        { id: "@bob:partner.test", name: "Bob", kind: "human", enabled: true },
      ],
    });
    const after = await (await fetch(base + "/api/bootstrap")).json();
    assert.equal(after.registration.mode, "closed");
    assert.equal(after.attachments.maxBytes, 2097152);
    assert.equal(
      after.participants.some((person) => person.id === "@bob:partner.test"),
      false,
    );
    assert.equal(
      (
        await fetch(base + "/admin-api/policy", {
          headers: { authorization: "Bearer synthetic-chat-token" },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(base + "/api/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: "new",
            password: "synthetic-password",
          }),
        })
      ).status,
      403,
    );
  } finally {
    await core.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("registered collaboration authority may differ from the central creator but never substitutes for actual Matrix moderation power", async () => {
  const root = await temp();
  const governance = new Governance({
    dataRoot: root,
    serverName: "home.test",
  });
  try {
    const policy = await governance.save({
      ...(await governance.read()),
      rooms: [
        {
          roomId: "!central-created",
          authority: "home.test",
          name: "Local collaboration",
          enabled: true,
          memberIds: [],
          botIds: [],
          tools: [],
        },
      ],
    });
    let permission = "allowed";
    let mutations = 0;
    let acl;
    const self = "@dscord-control:home.test";
    const client = {
      whoami: async () => ({ user_id: self }),
      join: async () => ({}),
      request: async (method, route, body) => {
        if (route.endsWith("/make_room_admin")) {
          if (permission === "denied")
            throw Object.assign(
              new Error("No local Matrix administrator in the room"),
              { status: 403 },
            );
          return {};
        }
        if (route.startsWith("/_synapse/admin/v1/rooms/"))
          return { creator: "@creator:central.test" };
        if (route.endsWith("/m.room.power_levels/"))
          return { users: { [self]: permission === "insufficient" ? 0 : 100 } };
        if (route.endsWith("/joined_members"))
          return { joined: { [self]: {} } };
        if (route.endsWith("/members")) return { chunk: [] };
        if (method === "PUT") {
          mutations++;
          if (route.endsWith("/m.room.server_acl/")) acl = body;
          return {};
        }
        if (route.endsWith("/m.room.server_acl/"))
          return Object.fromEntries(Object.entries(acl).reverse());
        throw new Error("Unexpected Matrix request " + route);
      },
    };
    const control = new SynapseControl({
      dataRoot: root,
      setup: { ...setup, roomId: null },
      governance,
    });
    control.serviceClient = async () => client;
    control.prepare = async () => ({ preparedPartners: [] });
    control.status = async () => ({
      application: JSON.parse(await readFile(control.stateFile, "utf8")),
    });
    const allowed = await control.apply(policy.revision);
    assert.equal(allowed.application.rooms[0].status, "applied");
    assert.equal(mutations, 3);
    for (permission of ["denied", "insufficient"]) {
      mutations = 0;
      const denied = await control.apply(policy.revision);
      assert.equal(denied.application.rooms[0].status, "failed");
      assert.equal(mutations, 0);
      assert.match(
        denied.application.rooms[0].error,
        permission === "denied"
          ? /No local Matrix administrator/
          : /lacks actual Matrix/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime observation requires the current guard source and live matching policy rather than a saved status file", async () => {
  const root = await temp();
  const governance = new Governance({
    dataRoot: root,
    serverName: "home.test",
  });
  const currentHash = createHash("sha256")
    .update(
      await readFile(
        new URL("../deploy/synapse/dscord_guard.py", import.meta.url),
      ),
    )
    .digest("hex");
  let status = {
    serverName: "home.test",
    sourceSha256: "old-module-source",
    liveRevision: 0,
    loadedPartners: [],
    error: null,
  };
  let available = true;
  const upstream = http.createServer((_request, response) => {
    response.writeHead(available ? 200 : 503, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(status));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const control = new SynapseControl({
    dataRoot: root,
    governance,
    setup: {
      ...setup,
      homeserverUrl: `http://127.0.0.1:${upstream.address().port}`,
    },
  });
  try {
    const old = await control.status();
    assert.equal(old.livePolicyObserved, false);
    assert.equal(old.restartRequired, true);
    status = { ...status, sourceSha256: currentHash };
    assert.equal((await control.status()).livePolicyObserved, true);
    await governance.save(await governance.read());
    assert.equal((await control.status()).livePolicyObserved, false);
    status = { ...status, liveRevision: 1 };
    assert.equal((await control.status()).livePolicyObserved, true);
    available = false;
    const stopped = await control.status();
    assert.equal(stopped.guard, null);
    assert.equal(stopped.livePolicyObserved, false);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
