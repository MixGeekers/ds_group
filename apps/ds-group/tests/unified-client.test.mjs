import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { parseClientConfig, discoverHome } from "../web/src/client-config.ts";
import {
  bindSession,
  migrateIdentityStorage,
  readScoped,
  restoreSession,
  sessionStorageKey,
  storageKey,
} from "../web/src/session.ts";
import { createApi, createRequest } from "../web/src/api.ts";
import {
  discoverServer,
  legacySpaces,
  roomsInSpace,
  validateSpaces,
} from "../web/src/spaces.ts";

class Storage {
  values = new Map();
  get length() {
    return this.values.size;
  }
  key(index) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
  removeItem(key) {
    this.values.delete(key);
  }
}
const originalFetch = globalThis.fetch;
const originalStorage = globalThis.sessionStorage;
const asset = "https://client.example";
const config = parseClientConfig(
  {
    schemaVersion: 1,
    homeCoreUrl: "https://core.example",
    homeMatrixUrl: "https://matrix.example",
  },
  asset,
);
const local = parseClientConfig({ schemaVersion: 1 }, asset);
const receipt = {
  access_token: "synthetic-test-token",
  user_id: "@alice:home.example",
};
const discovery = {
  schemaVersion: 1,
  authorityId: "urn:uuid:home",
  home: {
    serverName: "home.example",
    coreUrl: config.homeCoreUrl,
    matrixUrl: config.homeMatrixUrl,
  },
  auth: { mode: "matrix-password", cookieCredentials: false },
};
const centralReceipt = {
  ...receipt,
  identity: {
    authorityId: discovery.authorityId,
    subjectId: "alice-subject",
    matrixUserId: receipt.user_id,
    kind: "human",
  },
  home: discovery.home,
};
beforeEach(() => {
  globalThis.sessionStorage = new Storage();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage === undefined) delete globalThis.sessionStorage;
  else globalThis.sessionStorage = originalStorage;
});

test("client deployment pins separate asset, Core, Matrix and auth origins", () => {
  assert.equal(config.assetOrigin, asset);
  assert.equal(config.homeCoreUrl, "https://core.example");
  assert.equal(config.authUrl, config.homeCoreUrl);
  assert.deepEqual(parseClientConfig({ schemaVersion: 1 }, asset), {
    schemaVersion: 1,
    assetOrigin: asset,
    homeCoreUrl: asset,
    authUrl: asset,
    homeMatrixUrl: null,
  });
  assert.equal(
    parseClientConfig(
      { schemaVersion: 1, authUrl: "https://auth.example" },
      asset,
    ).authUrl,
    "https://auth.example",
  );
});

test("invalid deployment origins fail before credentials are read or sent", () => {
  for (const homeCoreUrl of [
    "http://remote.example",
    "https://u:p@remote.example",
    "https://remote.example/api",
    "https://remote.example/?target=x",
    "https://remote.example/#x",
    "//remote.example",
    "file:///tmp/home",
    "javascript:alert(1)",
    null,
  ]) {
    assert.throws(() =>
      parseClientConfig({ schemaVersion: 1, homeCoreUrl }, asset),
    );
  }
  assert.throws(() => parseClientConfig({ schemaVersion: 2 }, asset));
  assert.throws(() =>
    parseClientConfig(
      { schemaVersion: 1, homeCoreUrl: "http://127.0.0.1:24300" },
      asset,
    ),
  );
  assert.equal(
    parseClientConfig({ schemaVersion: 1 }, "http://127.0.0.1:24300")
      .homeCoreUrl,
    "http://127.0.0.1:24300",
  );
});

test("legacy unbound session migrates only at its original same-origin deployment", () => {
  sessionStorage.setItem("ds-group.session", JSON.stringify(receipt));
  assert.equal(restoreSession(config), null);
  assert.equal(sessionStorage.getItem(sessionStorageKey(config)), null);
  const migrated = restoreSession(local);
  assert.equal(migrated.user_id, receipt.user_id);
  assert.equal(migrated.binding.homeCoreUrl, asset);
  assert.equal(sessionStorage.getItem("ds-group.session"), null);
  assert.deepEqual(restoreSession(local), migrated);
});

test("a foreign or malformed binding is never restored as a local session", () => {
  const session = bindSession(receipt, config);
  sessionStorage.setItem(sessionStorageKey(local), JSON.stringify(session));
  sessionStorage.setItem("ds-group.session", JSON.stringify(session));
  assert.equal(restoreSession(local), null);
  sessionStorage.setItem(
    sessionStorageKey(config),
    JSON.stringify({ user_id: "invalid", access_token: "" }),
  );
  sessionStorage.removeItem("ds-group.session");
  assert.equal(restoreSession(config), null);
});

test("login binds stable subjects and rejects a changed home authority, identity or Matrix target", () => {
  const session = bindSession(centralReceipt, config, discovery);
  assert.equal(session.binding.authorityId, discovery.authorityId);
  assert.equal(session.identity.subjectId, "alice-subject");
  for (const invalid of [
    { ...centralReceipt, user_id: "@alice:other.example" },
    {
      ...centralReceipt,
      identity: { ...centralReceipt.identity, authorityId: "foreign" },
    },
    {
      ...centralReceipt,
      identity: { ...centralReceipt.identity, subjectId: "" },
    },
    {
      ...centralReceipt,
      home: { ...centralReceipt.home, matrixUrl: "https://foreign.example" },
    },
    {
      ...centralReceipt,
      home: { ...centralReceipt.home, coreUrl: "https://foreign.example" },
    },
  ])
    assert.throws(() => bindSession(invalid, config, discovery));
});

test("room, draft, retry and Bot keys distinguish deployment, full identity and space", () => {
  const session = bindSession(receipt, config);
  const a = storageKey(
    config,
    "draft",
    session,
    "a.example",
    "!same:a.example",
  );
  const b = storageKey(
    config,
    "draft",
    session,
    "b.example",
    "!same:a.example",
  );
  assert.notEqual(a, b);
  assert.notEqual(
    a,
    storageKey(local, "draft", session, "a.example", "!same:a.example"),
  );
  assert.notEqual(
    a,
    storageKey(
      config,
      "draft",
      bindSession({ ...receipt, user_id: "@alice:other.example" }, config),
      "a.example",
      "!same:a.example",
    ),
  );
  assert.notEqual(
    a,
    storageKey(config, "pending", session, "a.example", "!same:a.example"),
  );
});

test("legacy drafts are copied into the original account scope without crossing a remote deployment", () => {
  const session = bindSession(receipt, local);
  sessionStorage.setItem(
    "old-draft",
    JSON.stringify({ body: "retained", attachments: [] }),
  );
  assert.equal(
    readScoped(
      config,
      "draft",
      bindSession(receipt, config),
      "home.example",
      "!one:home.example",
      "old-draft",
    ),
    null,
  );
  assert.equal(
    readScoped(
      local,
      "draft",
      session,
      "home.example",
      "!one:home.example",
      "old-draft",
    ).body,
    "retained",
  );
  assert.equal(sessionStorage.getItem("old-draft"), null);
  assert.equal(
    readScoped(local, "draft", session, "home.example", "!one:home.example")
      .body,
    "retained",
  );
});

test("authenticated identity upgrade retains the same users scoped drafts and pending transactions", () => {
  const old = bindSession(receipt, config);
  const next = bindSession(centralReceipt, config, discovery);
  const oldKey = storageKey(
    config,
    "pending",
    old,
    "a.example",
    "!one:a.example",
  );
  sessionStorage.setItem(
    oldKey,
    JSON.stringify({ transactionId: "same-retry", body: "preserved" }),
  );
  migrateIdentityStorage(config, old, next);
  assert.equal(sessionStorage.getItem(oldKey), null);
  assert.equal(
    readScoped(config, "pending", next, "a.example", "!one:a.example")
      .transactionId,
    "same-retry",
  );
  const stranger = bindSession(
    { ...receipt, user_id: "@bob:home.example" },
    config,
  );
  migrateIdentityStorage(config, next, stranger);
  assert.equal(
    readScoped(config, "pending", stranger, "a.example", "!one:a.example"),
    null,
  );
});

test("ordinary API requests carry only the bound credential with no cookie or redirect forwarding", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ ok: true });
  };
  const session = bindSession(receipt, config);
  const api = createApi(() => session, config);
  await api("/api/rooms", { headers: { Authorization: "Bearer injected" } });
  await api("/api/bootstrap", {
    auth: false,
    headers: { Authorization: "Bearer injected" },
  });
  assert.equal(calls[0].url, config.homeCoreUrl + "/api/rooms");
  assert.equal(
    calls[0].options.headers.get("Authorization"),
    `Bearer ${receipt.access_token}`,
  );
  assert.equal(calls[1].options.headers.has("Authorization"), false);
  for (const { options } of calls) {
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
  }
});

test("unbound split-origin and foreign sessions fail before any network request", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({});
  };
  await assert.rejects(
    createApi(() => receipt, config)("/api/me"),
    /not bound/,
  );
  await assert.rejects(
    createApi(() => bindSession(receipt, local), config)("/api/me"),
    /not bound/,
  );
  for (const route of [
    "https://evil.example/api/me",
    "//evil.example/api/me",
    "/api/../../secret",
    "/api/\\evil",
  ]) {
    await assert.rejects(
      createApi(() => bindSession(receipt, config), config)(route),
    );
  }
  assert.equal(calls, 0);
});

test("late network responses cannot be reused by another account session", async () => {
  let account = bindSession(receipt, config);
  let release;
  globalThis.fetch = async () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = createRequest(() => account, config)("/api/rooms");
  account = bindSession(
    { user_id: "@bob:home.example", access_token: "bob-token" },
    config,
  );
  release(Response.json({ rooms: ["private Alice data"] }));
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("home discovery validates pinned addresses and never receives a credential", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json(discovery);
  };
  assert.equal((await discoverHome(config)).authorityId, discovery.authorityId);
  assert.equal(calls[0].url, config.authUrl + "/.well-known/dscord/client");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers, undefined);
  globalThis.fetch = async () =>
    Response.json({
      ...discovery,
      home: { ...discovery.home, coreUrl: "https://foreign.example" },
    });
  await assert.rejects(discoverHome(config), /differs/);
});

test("unknown-server discovery uses only the entered origin and public endpoints", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({
      ...discovery,
      home: {
        ...discovery.home,
        coreUrl: "https://advertised-untrusted.example",
      },
    });
  };
  const result = await discoverServer("https://unknown.example");
  assert.equal(result.origin, "https://unknown.example");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://unknown.example/.well-known/dscord/client",
  );
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.referrerPolicy, "no-referrer");
});

test("legacy discovery still does not establish membership or import credentials", async () => {
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1
      ? new Response("{}", { status: 404 })
      : Response.json({
          name: "Legacy",
          roomId: "!one:other.example",
          participants: [],
          access_token: "must-not-import",
        });
  assert.deepEqual(await discoverServer("https://legacy.example"), {
    origin: "https://legacy.example",
    name: "Legacy",
    serverName: null,
    authorityId: null,
  });
  assert.equal(sessionStorage.length, 0);
});

test("space lists validate the full home identity and never infer joined from a discovery", () => {
  const facts = {
    homeServer: "home.example",
    userId: receipt.user_id,
    spaces: [
      {
        serverName: "a.example",
        name: "A",
        home: false,
        status: "connected",
        rooms: [
          {
            roomId: "!one:a.example",
            name: "One",
            status: "joined",
            canSend: true,
          },
          {
            roomId: "!two:a.example",
            name: "Two",
            status: "restricted",
            canSend: false,
          },
        ],
        invitations: [
          {
            roomId: "!three:a.example",
            name: "Three",
            status: "approval_required",
            canJoin: false,
          },
        ],
      },
    ],
  };
  assert.equal(validateSpaces(facts, receipt.user_id), facts);
  const rooms = facts.spaces[0].rooms.map((room) => ({
    ...room,
    kind: "group",
    participantIds: [receipt.user_id],
  }));
  assert.deepEqual(
    roomsInSpace(rooms, facts.spaces[0]).map((room) => room.roomId),
    ["!one:a.example"],
  );
  assert.throws(() => validateSpaces(facts, "@alice:elsewhere.example"));
  assert.throws(() =>
    validateSpaces(
      { ...facts, spaces: [...facts.spaces, ...facts.spaces] },
      receipt.user_id,
    ),
  );
  assert.deepEqual(
    legacySpaces(receipt.user_id, [], { roomId: "!public:home.example" })
      .spaces[0].rooms,
    [],
  );
});

test("trusted same-origin HTTP intranet deployment keeps its original session and private Matrix discovery", async () => {
  const origin = "http://192.168.50.25:18100";
  const config = parseClientConfig({ schemaVersion: 1 }, origin);
  assert.equal(config.homeCoreUrl, origin);
  sessionStorage.setItem("ds-group.session", JSON.stringify(receipt));
  const restored = restoreSession(config);
  assert.equal(restored.binding.homeCoreUrl, origin);
  assert.equal(restored.user_id, receipt.user_id);
  const matrixUrl = "http://10.30.40.50:18008";
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return Response.json({
      ...discovery,
      home: { serverName: "home.example", coreUrl: null, matrixUrl },
    });
  };
  assert.equal((await discoverHome(config)).home.matrixUrl, matrixUrl);
  const explicit = parseClientConfig(
    {
      schemaVersion: 1,
      homeCoreUrl: origin,
      authUrl: origin,
      homeMatrixUrl: matrixUrl,
    },
    origin,
  );
  assert.equal(explicit.homeMatrixUrl, matrixUrl);
  await createApi(() => restored, config)("/api/rooms");
  assert.equal(requests.at(-1).url, origin + "/api/rooms");
  assert.equal(
    requests.at(-1).options.headers.get("Authorization"),
    `Bearer ${receipt.access_token}`,
  );
  assert.equal(requests.at(-1).options.credentials, "omit");
  assert.throws(() =>
    parseClientConfig(
      { schemaVersion: 1, homeCoreUrl: "http://192.168.50.26:18100" },
      origin,
    ),
  );
  assert.throws(() =>
    parseClientConfig(
      {
        schemaVersion: 1,
        homeCoreUrl: "https://core.example",
        homeMatrixUrl: matrixUrl,
      },
      asset,
    ),
  );
});
