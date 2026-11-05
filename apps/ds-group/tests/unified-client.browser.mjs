import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { packageRoot } from "../src/paths.mjs";

const checks = [];
const pageErrors = [];
const records = [];
const assetRequests = [];
const trapRequests = [];
const routeFailures = [];
const privateRouteJobs = new Set();
const servers = [];
const output = path.join(packageRoot, ".local/unified-client-browser");
const homeUser = "@alice:home.test";
const botId = "@bot-owned:home.test";
const homeRoom = "!general:home.test";
const aRoom = "!same:a.test";
const bRoom = "!same:b.test";
const deniedRoom = "!denied:c.test";
const people = [
  { id: homeUser, name: "Alice Chen · Cross Server Collaboration Team", kind: "human" },
  { id: "@bob:home.test", name: "Bob Home", kind: "human" },
  { id: "@bob:a.test", name: "Bob", kind: "human" },
  { id: "@bob:b.test", name: "Bob", kind: "human" },
  { id: botId, name: "Helper", kind: "bot", ownerId: homeUser },
  { id: "@bot-foreign:a.test", name: "Helper", kind: "bot", ownerId: homeUser },
];
const room = (roomId, name) => ({
  roomId,
  name,
  kind: "group",
  participantIds: people.map((person) => person.id),
  permissions: { inviteMembers: roomId === homeRoom },
});
const roomRows = [
  room(homeRoom, "General"),
  room(aRoom, "A channel"),
  room(bRoom, "B channel"),
];
const events = new Map(
  roomRows.map((row) => [
    row.roomId,
    [
      {
        event_id: "$same-event-fixture",
        room_id: row.roomId,
        sender: row.roomId === bRoom ? "@bob:b.test" : "@bob:a.test",
        type: "m.room.message",
        origin_server_ts: Date.now(),
        content: {
          body: `${row.name} message`,
          ...(row.roomId === homeRoom
            ? {}
            : {
                "org.ds_group": {
                  attachments: [
                    {
                      id: "same-file",
                      name: "same.txt",
                      mimeType: "text/plain",
                      size: 7,
                    },
                  ],
                },
              }),
        },
      },
    ],
  ]),
);
const state = {
  joined: new Set([homeRoom, aRoom]),
  tokens: new Map([["legacy-fixture-token", homeUser]]),
  uploads: [],
  messages: [],
  logout: [],
  grantDoc: { revision: 0, grants: [] },
  grantWrites: [],
  grantFailure: null,
  configMode: "split",
  holdMessage: false,
  delayedMessages: null,
  aRestricted: false,
  direct: null,
};
let clientOrigin;
let homeOrigin;
let unknownOrigin;
let trapOrigin;
let browser;
let page;
let failure;
let build;

function publicConfig(origin = homeOrigin) {
  return {
    schemaVersion: 1,
    name: "DSCord",
    authorityId: "urn:uuid:fixture-home",
    home: {
      serverName: "home.test",
      coreUrl: origin,
      matrixUrl: "https://matrix.home.test",
    },
    auth: { mode: "matrix-password", cookieCredentials: false },
  };
}
function identity(userId) {
  return {
    authorityId: "urn:uuid:fixture-home",
    subjectId: `subject-${userId}`,
    matrixUserId: userId,
    kind: "human",
  };
}
function session(userId, origin = homeOrigin) {
  const access_token = `${userId}-synthetic-${state.tokens.size}`;
  state.tokens.set(access_token, userId);
  return {
    access_token,
    user_id: userId,
    identity: identity(userId),
    home: publicConfig(origin).home,
  };
}
function spaces(userId) {
  return {
    homeServer: "home.test",
    userId,
    spaces: [
      {
        serverName: "home.test",
        name: "My home",
        home: true,
        status: "connected",
        rooms: [...state.joined]
          .filter((id) => [homeRoom, state.direct?.roomId].includes(id))
          .map((roomId) => ({
            roomId,
            name: roomId === homeRoom ? "General" : "Bob",
            status: "joined",
            canSend: true,
          })),
        invitations: [],
      },
      {
        serverName: "a.test",
        name: "Team A",
        home: false,
        status: state.aRestricted ? "revoked" : "connected",
        rooms: state.joined.has(aRoom)
          ? [
              {
                roomId: aRoom,
                name: "A channel",
                status: state.aRestricted ? "restricted" : "joined",
                canSend: !state.aRestricted,
              },
            ]
          : [],
        invitations: [],
      },
      {
        serverName: "b.test",
        name: "Team B",
        home: false,
        status: "connected",
        rooms: state.joined.has(bRoom)
          ? [
              {
                roomId: bRoom,
                name: "B channel",
                status: "joined",
                canSend: true,
              },
            ]
          : [],
        invitations: state.joined.has(bRoom)
          ? []
          : [
              {
                roomId: bRoom,
                name: "B invitation",
                inviterId: "@bob:b.test",
                status: "invited",
                canJoin: true,
              },
            ],
      },
      {
        serverName: "c.test",
        name: "Unapproved C",
        home: false,
        status: "revoked",
        rooms: [],
        invitations: [
          {
            roomId: deniedRoom,
            name: "Needs approval",
            inviterId: "@bob:c.test",
            status: "approval_required",
            canJoin: false,
          },
        ],
      },
    ],
  };
}
async function readBody(request) {
  const parts = [];
  for await (const chunk of request) parts.push(chunk);
  return Buffer.concat(parts);
}
function json(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}
async function apiHandler(request, response, origin = homeOrigin) {
  const url = new URL(request.url, origin);
  const token = request.headers.authorization?.replace(/^Bearer /, "");
  const userId = state.tokens.get(token);
  records.push({
    origin,
    method: request.method,
    path: url.pathname,
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
  });
  if (request.headers.origin === clientOrigin)
    response.setHeader("Access-Control-Allow-Origin", clientOrigin);
  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Upload-Id",
  );
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === "/.well-known/dscord/client")
    return json(response, 200, publicConfig(origin));
  if (url.pathname === "/api/bootstrap")
    return json(response, 200, {
      name: "My home",
      serverName: "home.test",
      roomId: homeRoom,
      roomName: "General",
      participants: people.slice(0, 2),
      demoLogin: false,
      registration: { enabled: true, mode: "open" },
      attachments: { maxBytes: 10000000, maxPerMessage: 10 },
    });
  if (url.pathname === "/api/status")
    return json(response, 200, {
      nodes: [{ botId, id: "owned-node", name: "Helper", status: "ready" }],
      core: { roomId: homeRoom },
    });
  if (url.pathname === "/api/push/config")
    return json(response, 200, { enabled: false });
  if (url.pathname === "/api/login") {
    const input = JSON.parse(await readBody(request));
    if (input.user === "redirect") {
      response.writeHead(307, { Location: trapOrigin + "/credential-trap" });
      response.end();
      return;
    }
    if (
      !["alice", "bob"].includes(input.user) ||
      input.password !== "synthetic-password"
    )
      return json(response, 401, { error: "Invalid synthetic credentials" });
    return json(
      response,
      200,
      session(input.user === "alice" ? homeUser : "@bob:home.test", origin),
    );
  }
  if (!userId)
    return json(response, 401, { error: "Invalid synthetic session" });
  if (url.pathname === "/api/me")
    return json(response, 200, {
      user: people.find((person) => person.id === userId),
      ownedBots:
        userId === homeUser
          ? [people.find((person) => person.id === botId)]
          : [],
      identity: identity(userId),
      home: publicConfig(origin).home,
    });
  if (url.pathname === "/api/logout") {
    state.logout.push(token);
    state.tokens.delete(token);
    return json(response, 200, { loggedOut: true });
  }
  const ownerGrant = url.pathname.match(/^\/api\/bots\/([^/]+)\/work-grants$/);
  if (ownerGrant) {
    if (
      decodeURIComponent(ownerGrant[1]) !== botId ||
      userId !== homeUser ||
      state.grantFailure === "denied"
    )
      return json(response, 403, {
        error: "Only the original owner may save grants",
      });
    if (request.method === "GET") return json(response, 200, state.grantDoc);
    const input = JSON.parse(await readBody(request));
    state.grantWrites.push(input);
    if (input.revision !== state.grantDoc.revision)
      return json(response, 409, { error: "Permissions changed elsewhere" });
    state.grantDoc = { revision: input.revision + 1, grants: input.grants };
    if (state.grantFailure === "unknown") {
      state.grantFailure = null;
      return json(response, 503, { error: "Receipt lost after saving" });
    }
    return json(response, 200, state.grantDoc);
  }
  if (url.pathname === "/api/rooms")
    return json(response, 200, {
      rooms: [...roomRows, ...(state.direct ? [state.direct] : [])].filter(
        (row) => state.joined.has(row.roomId),
      ),
    });
  if (url.pathname === "/api/spaces")
    return json(response, 200, spaces(userId));
  if (url.pathname === "/api/directory")
    return json(response, 200, { participants: people });
  if (url.pathname === "/api/roles")
    return json(response, 200, { roles: [], canManage: false });
  if (url.pathname === "/api/presence")
    return json(response, 200, { accepted: true });
  if (url.pathname === "/api/inbox")
    return json(response, 200, { events: [], unreadCount: 0, mentionCount: 0 });
  if (url.pathname === "/api/dm") {
    const input = JSON.parse(await readBody(request));
    state.direct = {
      roomId: "!personal-dm:home.test",
      name: "Bob",
      kind: "direct",
      participantIds: [userId, input.participantId],
    };
    state.joined.add(state.direct.roomId);
    events.set(state.direct.roomId, []);
    return json(response, 200, state.direct);
  }
  if (url.pathname === "/api/attachments" && request.method === "POST") {
    const bytes = await readBody(request);
    const attachment = {
      id: `uploaded-${state.uploads.length}`,
      name: url.searchParams.get("filename"),
      size: bytes.length,
      mimeType: request.headers["content-type"],
    };
    state.uploads.push({
      attachment,
      bytes: bytes.toString(),
      userId,
      uploadId: request.headers["x-upload-id"],
      origin,
    });
    return json(response, 200, { attachment });
  }
  const proofMedia = url.pathname.match(
    /^\/api\/rooms\/([^/]+)\/attachments\/([^/]+)(\/metadata)?$/,
  );
  if (proofMedia) {
    const roomId = decodeURIComponent(proofMedia[1]);
    if (
      !state.joined.has(roomId) ||
      (roomId === aRoom && state.aRestricted) ||
      state.mediaDenied
    )
      return json(response, 403, { error: "Room media permission revoked" });
    if (url.searchParams.get("eventId") !== "$same-event-fixture")
      return json(response, 404, {
        error: "This exact message does not prove the attachment",
      });
    if (proofMedia[3])
      return json(response, 200, {
        attachment: {
          id: decodeURIComponent(proofMedia[2]),
          name: "same.txt",
          mimeType: "text/plain",
          size: 7,
        },
        proof: { roomId, eventId: url.searchParams.get("eventId") },
      });
    response.writeHead(200, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    });
    response.end(roomId === bRoom ? "B bytes" : "A bytes");
    return;
  }
  if (url.pathname.startsWith("/api/attachments/")) {
    const roomId = url.searchParams.get("roomId");
    response.writeHead(200, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    });
    response.end(roomId === bRoom ? "B bytes" : "A bytes");
    return;
  }
  const match = url.pathname.match(
    /^\/api\/rooms\/([^/]+)\/(messages|tasks|mentionables|read|join|leave|context\/[^/]+)$/,
  );
  if (match) {
    const roomId = decodeURIComponent(match[1]);
    const action = match[2];
    if (action === "join") {
      if (roomId === deniedRoom)
        return json(response, 403, {
          error: "This exact room needs approval on your home server",
        });
      state.joined.add(roomId);
      return json(response, 200, {
        roomId,
        status: "joined",
        serverName: "b.test",
      });
    }
    if (action === "leave") {
      state.joined.delete(roomId);
      return json(response, 200, { roomId, status: "left" });
    }
    if (!state.joined.has(roomId) || (state.aRestricted && roomId === aRoom))
      return json(response, 403, { error: "Room access revoked" });
    if (action === "read") return json(response, 200, { read: true });
    if (action === "tasks")
      return json(response, 200, {
        tasks:
          roomId === homeRoom
            ? []
            : [
                {
                  requestId: `task-${roomId}`,
                  roomId,
                  botId,
                  eventId: "$same-event-fixture",
                  status: "running",
                  stage: "working",
                  summary: "Task",
                  artifacts: [],
                  toolCalls: 1,
                  cancelRequested: false,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                },
              ],
      });
    if (action === "mentionables")
      return json(response, 200, {
        members: people,
        roles: [],
        canMentionEveryone: false,
        canMentionHere: false,
      });
    if (request.method === "POST" && action === "messages") {
      const input = JSON.parse(await readBody(request));
      state.messages.push({ roomId, userId, body: input });
      if (state.holdMessage) {
        state.holdMessage = false;
        await new Promise((resolve) => {
          state.releaseSend = resolve;
        });
      }
      events.get(roomId).push({
        event_id: "$sent-" + state.messages.length,
        room_id: roomId,
        sender: userId,
        type: "m.room.message",
        origin_server_ts: Date.now(),
        content: { body: input.body },
      });
      return json(response, 200, {
        event_id: "$sent-" + state.messages.length,
      });
    }
    const snapshot = [...(events.get(roomId) ?? [])];
    if (roomId === aRoom && state.delayedMessages) {
      const delay = state.delayedMessages;
      state.delayedMessages = null;
      delay.started();
      await delay.wait;
    }
    return json(response, 200, { events: snapshot });
  }
  return json(response, 404, {
    error: "Unhandled synthetic endpoint",
    path: url.pathname,
  });
}
async function listen(handler, port) {
  const server = createServer(
    (request, response) =>
      void Promise.resolve(handler(request, response)).catch((error) =>
        json(response, 500, { error: error.message }),
      ),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
const contentTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

try {
  await mkdir(output, { recursive: true });
  build = await promisify(execFile)("npm", ["run", "build"], {
    cwd: packageRoot,
    maxBuffer: 2 ** 20,
  });
  clientOrigin = await listen(async (request, response) => {
    const url = new URL(request.url, clientOrigin);
    assetRequests.push(url.pathname);
    if (url.pathname === "/client-config.json")
      return json(
        response,
        200,
        state.configMode === "same"
          ? { schemaVersion: 1 }
          : {
              schemaVersion: 1,
              homeCoreUrl:
                state.configMode === "changed" ? unknownOrigin : homeOrigin,
              homeMatrixUrl: "https://matrix.home.test",
            },
      );
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/.well-known/")
    )
      return apiHandler(request, response, clientOrigin);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filename = path.resolve(packageRoot, "dist/web", "." + pathname);
    if (!filename.startsWith(path.join(packageRoot, "dist/web") + path.sep))
      return json(response, 404, {});
    try {
      response.writeHead(200, {
        "Content-Type":
          contentTypes[path.extname(filename)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      response.end(await readFile(filename));
    } catch {
      json(response, 404, {});
    }
  }, 24360);
  homeOrigin = await listen(apiHandler, 24361);
  unknownOrigin = await listen((request, response) => {
    records.push({
      origin: unknownOrigin,
      path: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    response.setHeader("Access-Control-Allow-Origin", clientOrigin);
    return json(response, 200, {
      ...publicConfig(unknownOrigin),
      name: "Public discovery",
      authorityId: "urn:uuid:unknown",
      home: {
        serverName: "unknown.test",
        coreUrl: unknownOrigin,
        matrixUrl: "https://matrix.home.test",
      },
    });
  }, 24362);
  trapOrigin = await listen((request, response) => {
    if (request.url.startsWith("/.well-known")) {
      response.setHeader("Access-Control-Allow-Origin", clientOrigin);
      response.writeHead(302, {
        Location: unknownOrigin + "/.well-known/dscord/client",
      });
      response.end();
      return;
    }
    trapRequests.push({
      path: request.url,
      method: request.method,
      authorization: request.headers.authorization,
    });
    return json(response, 200, {});
  }, 24363);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
  });
  await context.addCookies([
    { name: "must-not-forward", value: "synthetic-cookie", url: clientOrigin },
  ]);
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(clientOrigin);
  await page.locator("#login-dialog[open]").waitFor();
  await page.locator("#login-user").fill("alice");
  await page.locator("#login-password").fill("synthetic-password");
  await page.locator("#login-submit").click();
  await page.locator("#login-dialog").waitFor({ state: "hidden" });
  await page.locator("#room-title").filter({ hasText: "General" }).waitFor();
  await page.locator('[data-server="a.test"]').waitFor();
  assert.equal(await page.locator("[data-server]").count(), 4);
  assert.equal(await page.locator("#current-id").textContent(), homeUser);
  checks.push(
    "productionEntryLoadsSplitConfigAndLogsIntoOneStableHomeIdentity",
  );

  assert.equal(await page.locator(".server-rail #identity-button").count(), 1);
  assert.equal(await page.locator(".identity-bar").count(), 0);
  assert.ok(await page.locator("#home-button .brand-mark").evaluate((mark) =>
    getComputedStyle(mark).maskImage.includes("mark-128"),
  ));
  assert.equal(await page.locator("#home-button").evaluate((button) =>
    getComputedStyle(button).backgroundColor,
  ), "rgba(0, 0, 0, 0)");
  assert.ok(await page.locator("#identity-button").evaluate((button) => {
    const box = button.getBoundingClientRect();
    return box.left < 24 && box.bottom > innerHeight - 24;
  }));
  await page.locator("#identity-button").focus();
  await page.keyboard.press("Enter");
  await page.locator("#account-menu[data-open]").waitFor();
  await page.waitForFunction(() => document.activeElement?.id === "settings-button");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "account-switch-button");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "settings-button");
  await page.keyboard.press("Escape");
  await page.locator("#account-menu").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement.id), "identity-button");
  await page.locator("#identity-button").click();
  await page.locator("#room-title").click();
  await page.locator("#account-menu").waitFor({ state: "hidden" });
  checks.push("railAccountMenuSupportsKeyboardFocusEscapeAndOutsideDismissalWithBrandedHome");

  await page.locator("#message-input").fill("Draft while changing appearance");
  await page.locator("#identity-button").click();
  await page.locator("#account-language-select").selectOption("zh-CN");
  assert.equal(await page.locator("#settings-button").textContent(), "个人设置");
  await page.locator("#account-theme-select").selectOption("light");
  await page.locator('#account-menu [data-color="teal"]').click();
  const menuSelectStyle = await page.locator("#account-language-select").evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.borderColor, style.borderRadius, style.paddingTop];
  });
  assert.equal(await page.locator("#home-button .brand-mark").evaluate((mark) =>
    getComputedStyle(mark).backgroundColor,
  ), "rgb(78, 80, 88)");
  assert.equal(await page.locator("html").getAttribute("data-accent"), "teal");
  await page.waitForFunction(() =>
    getComputedStyle(document.querySelector(".server-list .server-icon.active")).backgroundColor
      === "rgb(15, 118, 110)",
  );
  await page.screenshot({ path: path.join(output, "desktop-account-menu-light-zh.png"), animations: "disabled" });
  await page.locator("#settings-button").click();
  await page.screenshot({ path: path.join(output, "desktop-settings-account-light-zh.png"), animations: "disabled" });
  await page.locator('[data-settings-tab="appearance"]').click();
  await page.screenshot({ path: path.join(output, "desktop-settings-appearance-light-zh.png"), animations: "disabled" });
  assert.equal(await page.locator("#theme-select").inputValue(), "light");
  assert.equal(await page.locator("#language-select").inputValue(), "zh-CN");
  assert.deepEqual(await page.locator("#language-select").evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.borderColor, style.borderRadius, style.paddingTop];
  }), menuSelectStyle);
  assert.equal(await page.locator('[data-settings-tab="appearance"]').getAttribute("aria-current"), "page");
  assert.equal(await page.locator('#settings-dialog [data-color="teal"]').getAttribute("aria-pressed"), "true");
  await page.locator("#language-select").focus();
  await page.screenshot({ path: path.join(output, "desktop-settings-appearance-focus-light-zh.png"), animations: "disabled" });
  await page.locator("#close-settings").click();
  await page.locator("#settings-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement.id), "identity-button");
  await page.reload();
  await page.locator("#room-title").filter({ hasText: "General" }).waitFor();
  await page.locator("#identity-button").click();
  assert.equal(await page.locator("#account-theme-select").inputValue(), "light");
  assert.equal(await page.locator("#account-language-select").inputValue(), "zh-CN");
  assert.equal(await page.locator('#account-menu [data-color="teal"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#message-input").textContent(), "Draft while changing appearance");
  assert.equal(await page.locator("#current-id").textContent(), homeUser);

  const appearanceTab = await context.newPage();
  await appearanceTab.goto(clientOrigin);
  await appearanceTab.evaluate(() => {
    window.DSGroupTheme.setColor("rose");
    window.DSGroupTheme.setPreference("dark");
    localStorage.setItem("ds-group.language", "en");
  });
  await page.waitForFunction(() =>
    document.documentElement.dataset.accent === "rose"
    && document.documentElement.dataset.theme === "dark"
    && document.documentElement.lang === "en",
  );
  assert.equal(await page.locator("#home-button .brand-mark").evaluate((mark) =>
    getComputedStyle(mark).backgroundColor,
  ), "rgb(181, 186, 193)");
  assert.equal(await page.locator('#account-menu [data-color="rose"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#account-theme-select").inputValue(), "dark");
  assert.equal(await page.locator("#account-language-select").inputValue(), "en");
  await appearanceTab.close();
  await page.screenshot({ path: path.join(output, "desktop-account-menu-dark-en.png"), animations: "disabled" });
  await page.locator('#account-menu [data-color="indigo"]').click();
  await page.keyboard.press("Escape");
  await page.locator("#message-input").fill("");
  checks.push("accountAppearancePersistsAcrossReloadAndSyncsWithSettingsAndOtherTabsWithoutLosingDraftOrIdentity");

  await page.locator('[data-server="a.test"]').click();
  await page.locator("#room-title").filter({ hasText: "A channel" }).waitFor();
  await page.getByText("A channel message", { exact: true }).waitFor();
  assert.equal(await page.locator("#invite-bot-button").isHidden(), true);
  assert.equal(await page.locator("#create-room-button").isHidden(), true);
  await page
    .locator('.attachment-card button[aria-label="Preview same.txt"]')
    .click();
  await page.locator(".preview-text").filter({ hasText: "A bytes" }).waitFor();
  await page.locator("#close-preview").click();
  await page.locator("#message-input").fill("A independent draft");
  await page.waitForTimeout(220);
  await page.locator('[data-server="b.test"]').click();
  assert.equal(await page.locator("#additional-rooms .room-item").count(), 0);
  assert.equal(await page.locator("#send-button").isDisabled(), true);
  checks.push(
    "spacesAndJoinedChannelsComeFromMembershipWithNoPhantomInvitationRoom",
  );

  await page.locator("#server-settings-button").click();
  await page
    .locator('[data-invitation="!same:b.test"] button')
    .filter({ hasText: /^Join$/ })
    .click();
  await page.locator("#spaces-dialog").waitFor({ state: "hidden" });
  await page.locator("#room-title").filter({ hasText: "B channel" }).waitFor();
  await page.getByText("B channel message", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("A channel message", { exact: true }).count(),
    0,
  );
  await page
    .locator('.attachment-card button[aria-label="Preview same.txt"]')
    .click();
  await page.locator(".preview-text").filter({ hasText: "B bytes" }).waitFor();
  await page.locator("#close-preview").click();
  checks.push(
    "acceptedInvitationUsesHomeJoinAndFullRoomIdWithSeparateAttachmentBytes",
  );
  const oldRouteReads = records.filter(
    (row) => row.method === "GET" && row.path.startsWith("/api/attachments/"),
  ).length;
  state.mediaDenied = true;
  await page
    .locator('.attachment-card button[aria-label="Download same.txt"]')
    .click();
  await page
    .locator(".attachment-view ~ .send-error, .message-attachments .send-error")
    .filter({ hasText: "Room media permission revoked" })
    .waitFor();
  assert.equal(
    records.filter(
      (row) => row.method === "GET" && row.path.startsWith("/api/attachments/"),
    ).length,
    oldRouteReads,
  );
  state.mediaDenied = false;
  await page
    .locator('.attachment-card button[aria-label="Preview same.txt"]')
    .click();
  await page.locator(".preview-text").filter({ hasText: "B bytes" }).waitFor();
  await page.locator("#close-preview").click();
  checks.push(
    "cachedAttachmentActionsRecheckOriginalEventProofAndNeverDowngradeOnPermissionDenial",
  );

  await page.locator("#server-settings-button").click();
  assert.equal(
    await page
      .locator('[data-invitation="!denied:c.test"] button')
      .filter({ hasText: /^Join$/ })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page.locator("#join-room-id").evaluate((input) => {
      input.value = "!opaque-matrix-v12-room";
      return input.checkValidity();
    }),
    true,
  );
  await page.locator("#join-room-id").fill(deniedRoom);
  await page.locator("#join-room").click();
  await page
    .locator("#space-feedback")
    .filter({ hasText: "Join rejected" })
    .waitFor();
  await page.locator("#server-url").fill(unknownOrigin);
  await page.locator("#check-server").click();
  await page
    .locator("#server-feedback")
    .filter({ hasText: "Public discovery" })
    .waitFor();
  const discoveredRequests = records.filter(
    (row) => row.origin === unknownOrigin,
  );
  assert.ok(discoveredRequests.length > 0);
  assert.ok(
    discoveredRequests.every((row) => !row.authorization && !row.cookie),
  );
  await page.locator("#server-url").fill(trapOrigin);
  await page.locator("#check-server").click();
  await page
    .locator("#server-feedback")
    .filter({ hasText: "Failed to fetch" })
    .waitFor();
  assert.equal(trapRequests.length, 0);
  await page.locator("#spaces-dialog .dialog-heading button").click();
  checks.push(
    "rejectedJoinRemainsRejectedAndUnknownDiscoveryOmitsCookiesTokensAndRedirects",
  );

  await page.locator("#identity-button").click();
  await page.locator("#settings-button").click();
  assert.deepEqual(
    await page
      .locator("[data-settings-tab]")
      .evaluateAll((elements) =>
        elements.map((element) => element.dataset.settingsTab),
      ),
    ["account", "appearance", "notifications"],
  );
  await page.locator("#close-settings").click();
  await page.locator("#manage-bots-button").click();
  assert.deepEqual(
    await page
      .locator("[data-owned-bot]")
      .evaluateAll((elements) =>
        elements.map((element) => element.dataset.ownedBot),
      ),
    [botId],
  );
  await page.locator("[data-work-grants-button]").click();
  await page.waitForFunction(
    () => !document.querySelector("#add-work-grant").disabled,
  );
  assert.equal(state.grantWrites.length, 0);
  await page.locator("#add-work-grant").click();
  await page.locator("#work-grant-room-0").selectOption(aRoom);
  await page.locator("[data-grant-enabled]").check();
  await page.locator("#save-work-grants").click();
  await page
    .locator("#work-grant-feedback")
    .filter({ hasText: "at least one person" })
    .waitFor();
  assert.equal(state.grantWrites.length, 0);
  assert.deepEqual(
    await page
      .locator("[data-grant-tool]")
      .evaluateAll((elements) =>
        elements.map((element) => element.dataset.grantTool),
      ),
    ["read", "write", "edit", "read_image"],
  );
  await page.locator('[data-grant-requester="@bob:a.test"]').check();
  await page.locator('[data-grant-tool="read"]').check();
  await page.locator('[data-grant-tool="write"]').check();
  await page.locator("#save-work-grants").click();
  await page
    .locator("#work-grant-feedback")
    .filter({ hasText: "Permissions saved" })
    .waitFor();
  assert.deepEqual(state.grantDoc, {
    revision: 1,
    grants: [
      {
        roomId: aRoom,
        requesterIds: ["@bob:a.test"],
        tools: ["read", "write"],
        enabled: true,
      },
    ],
  });
  checks.push(
    "ownedBotGrantsUseExactRoomFullRequesterIdsFourFileToolsAndExplicitVersionedSave",
  );

  state.grantDoc = {
    revision: 2,
    grants: [{ ...state.grantDoc.grants[0], tools: ["read"] }],
  };
  await page.locator('[data-grant-tool="edit"]').check();
  await page.locator("#save-work-grants").click();
  await page
    .locator("#work-grant-feedback")
    .filter({ hasText: "changed elsewhere" })
    .waitFor();
  assert.equal(
    await page.locator('[data-grant-tool="edit"]').isChecked(),
    true,
  );
  assert.equal(await page.locator("#save-work-grants").isDisabled(), true);
  await page.locator("#reload-work-grants").click();
  await page.waitForFunction(
    () => !document.querySelector("#add-work-grant").disabled,
  );
  assert.equal(
    await page.locator('[data-grant-tool="edit"]').isChecked(),
    false,
  );
  state.grantFailure = "denied";
  await page.locator("#reload-work-grants").click();
  await page
    .locator("#work-grant-feedback")
    .filter({ hasText: "Permission denied" })
    .waitFor();
  assert.equal(await page.locator("[data-grant-tool]").count(), 0);
  state.grantFailure = null;
  await page.locator("#reload-work-grants").click();
  await page.waitForFunction(
    () => !document.querySelector("#add-work-grant").disabled,
  );
  state.grantFailure = "unknown";
  await page.locator('[data-grant-tool="write"]').check();
  await page.locator("#save-work-grants").click();
  await page
    .locator("#work-grant-feedback")
    .filter({ hasText: "not confirmed" })
    .waitFor();
  assert.equal(await page.locator("#save-work-grants").isDisabled(), true);
  await page.locator("#reload-work-grants").click();
  await page.waitForFunction(
    () => !document.querySelector("#add-work-grant").disabled,
  );
  assert.equal(
    await page.locator('[data-grant-tool="write"]').isChecked(),
    true,
  );
  await page.locator("[data-grant-enabled]").uncheck();
  await page.locator("#save-work-grants").click();
  await page
    .locator("#work-grant-feedback")
    .filter({ hasText: "Permissions saved" })
    .waitFor();
  assert.equal(state.grantDoc.grants[0].enabled, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, "owner-grants-mobile.png") });
  assert.ok(
    await page.locator("#my-bots-dialog").evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth + 1;
    }),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });

  checks.push(
    "ownerGrantConflictDenialUnknownSaveAndExplicitRevocationKeepAuthoritativeState",
  );
  await page.locator("#my-bots-dialog .dialog-heading button").click();
  checks.push(
    "personalSettingsAndOwnedBotManagementExcludeDeploymentAndForeignBotControls",
  );

  await page.locator('[data-server="a.test"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector("#message-input").textContent ===
      "A independent draft",
  );
  await page.locator(".message").first().hover();
  await page.locator('.message-action[title="Reply"]').first().click();
  await page.locator("#attachment-input").setInputFiles({
    name: "request.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("original task attachment"),
  });
  await page.locator(".attachment-draft-ready").waitFor();
  state.holdMessage = true;
  await page.locator("#send-button").click();
  await page.waitForFunction(
    () => document.querySelector("#send-button-text").textContent === "Sending",
  );
  await page.locator('[data-server="b.test"]').click();
  await page.locator("#room-title").filter({ hasText: "B channel" }).waitFor();
  await page.locator("#message-input").fill("B draft survives A receipt");
  assert.equal(await page.locator("#reply-preview").isHidden(), true);
  assert.equal(await page.locator(".attachment-draft").count(), 0);
  state.releaseSend();
  await page.waitForTimeout(250);
  assert.equal(
    await page.locator("#message-input").textContent(),
    "B draft survives A receipt",
  );
  const sent = state.messages.at(-1);
  assert.equal(sent.roomId, aRoom);
  assert.equal(sent.userId, homeUser);
  assert.equal(sent.body.replyTo, "$same-event-fixture");
  assert.deepEqual(sent.body.attachments, [state.uploads.at(-1).attachment.id]);
  assert.equal(state.uploads.at(-1).bytes, "original task attachment");
  assert.ok(state.uploads.at(-1).uploadId);
  checks.push(
    "inFlightSendReplyAndUploadedTaskAttachmentRemainBoundToOriginalSpace",
  );

  await page.locator('[data-server="a.test"]').click();
  await page.locator("#room-title").filter({ hasText: "A channel" }).waitFor();
  let started;
  const awaitingRequest = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  state.delayedMessages = {
    started,
    wait: new Promise((resolve) => {
      release = resolve;
    }),
  };
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await awaitingRequest;
  await page.locator('[data-server="b.test"]').click();
  release();
  await page.getByText("B channel message", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("A channel message", { exact: true }).count(),
    0,
  );
  checks.push(
    "latePollResponsesCannotMergeMessagesTasksOrMentionsIntoNewSpace",
  );

  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.evaluate(
    ({ homeUser, homeOrigin, homeRoom }) =>
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent("message", {
          source: navigator.serviceWorker.controller,
          data: {
            type: "ds-group:open-room",
            roomId: homeRoom,
            userId: "@stranger:home.test",
            homeCoreUrl: homeOrigin,
            authorityId: "urn:uuid:fixture-home",
          },
        }),
      ),
    { homeUser, homeOrigin, homeRoom },
  );
  assert.equal(await page.locator("#room-title").textContent(), "B channel");
  await page.evaluate(
    ({ homeUser, homeOrigin, homeRoom }) =>
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent("message", {
          source: navigator.serviceWorker.controller,
          data: {
            type: "ds-group:open-room",
            roomId: homeRoom,
            userId: homeUser,
            homeCoreUrl: homeOrigin,
            authorityId: "urn:uuid:fixture-home",
          },
        }),
      ),
    { homeUser, homeOrigin, homeRoom },
  );
  await page.locator("#room-title").filter({ hasText: "General" }).waitFor();
  checks.push(
    "notificationNavigationRequiresCurrentUserHomeAuthorityAndActualJoinedRoom",
  );

  await page.locator('[data-server="b.test"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector("#message-input").textContent ===
      "B draft survives A receipt",
  );
  await context.setOffline(true);
  await page.reload();
  await page.locator("#message-input").waitFor();
  assert.equal(
    await page.locator("#message-input").textContent(),
    "B draft survives A receipt",
  );
  assert.equal(await page.locator("#send-button").isDisabled(), true);
  const cacheNames = await page.evaluate(() => caches.keys());
  assert.ok(cacheNames.some((name) => name.startsWith("ds-group-shell-")));
  const cached = await page.evaluate(async () =>
    (
      await Promise.all(
        (await caches.keys()).map(async (name) =>
          (await (await caches.open(name)).keys()).map(
            (request) => new URL(request.url).pathname,
          ),
        ),
      )
    ).flat(),
  );
  assert.ok(
    cached.every(
      (name) => !name.startsWith("/api/") && !name.startsWith("/.well-known/"),
    ),
  );
  await context.setOffline(false);
  await page.waitForFunction(
    () =>
      document.querySelector("#connection-text").textContent === "Connected",
  );
  await page.getByText("B channel message", { exact: true }).waitFor();
  checks.push(
    "productionPwaCachesOnlyStaticShellAndReconnectsSameHomeSessionAndDraft",
  );

  state.aRestricted = true;
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await page.locator('[data-server="a.test"]').click();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-server="a.test"]')
      .classList.contains("server-revoked"),
  );
  assert.equal(await page.locator("#send-button").isDisabled(), true);
  assert.equal(await page.locator("#additional-rooms .room-item").count(), 0);
  checks.push(
    "revocationRemovesAccessibleChannelWithoutClaimingRemoteServerOffline",
  );

  await page.locator('[data-server="b.test"]').click();
  await page.locator("#identity-button").click();
  await page.locator("#settings-button").click();
  await page.locator('[data-settings-tab="appearance"]').click();
  await page.locator("#theme-select").selectOption("light");
  await page.locator("#language-select").selectOption("zh-CN");
  await page.locator("#close-settings").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, "mobile-light-zh.png") });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.locator("#channels-button").click();
  await page.locator("#identity-button").click();
  await page.screenshot({ path: path.join(output, "mobile-account-menu-light-zh.png"), animations: "disabled" });
  assert.ok(await page.locator("#account-menu").evaluate((menu) => {
    const box = menu.getBoundingClientRect();
    return box.left >= 64 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
  }));
  await page.keyboard.press("Escape");
  await page.locator("#account-menu").waitFor({ state: "hidden" });
  assert.ok(await page.locator("#channel-panel").evaluate((panel) => panel.classList.contains("open")));
  await page.locator("#identity-button").click();
  await page.locator("#settings-button").click();
  await page.locator('[data-settings-tab="appearance"]').click();
  await page.screenshot({ path: path.join(output, "mobile-settings-appearance-light-zh.png"), animations: "disabled" });
  await page.locator('[data-settings-tab="notifications"]').click();
  await page.screenshot({ path: path.join(output, "mobile-settings-notifications-light-zh.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await page.locator("#settings-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement.id), "identity-button");
  assert.ok(await page.locator("#channel-panel").evaluate((panel) => panel.classList.contains("open")));
  checks.push("mobileAccountMenuFitsViewportAndEscapeKeepsNavigationOpen");
  await page.locator("#server-settings-button").click();
  await page.screenshot({ path: path.join(output, "mobile-spaces.png") });
  assert.ok(
    await page.locator("#spaces-dialog").evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth + 1;
    }),
  );
  await page.locator("#spaces-dialog .dialog-heading button").click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#identity-button").click();
  await page.locator("#settings-button").click();
  await page.locator('[data-settings-tab="appearance"]').click();
  await page.locator("#language-select").selectOption("en");
  await page.locator("#theme-select").selectOption("dark");
  await page.locator("#close-settings").click();
  await page.screenshot({ path: path.join(output, "desktop-dark-en.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#channels-button").click();
  await page.locator("#identity-button").click();
  await page.screenshot({ path: path.join(output, "mobile-account-menu-dark-en.png"), animations: "disabled" });
  await page.locator("#settings-button").click();
  await page.locator('[data-settings-tab="appearance"]').click();
  await page.screenshot({ path: path.join(output, "mobile-settings-appearance-dark-en.png"), animations: "disabled" });
  await page.locator("#close-settings").click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  checks.push(
    "desktopAndNarrowLayoutsSupportBothLanguagesThemesAndServerDialogs",
  );

  await page.locator("#identity-button").click();
  await page.locator("#settings-button").click();
  await page.locator("#logout-button").click();
  await page.locator("#login-dialog[open]").waitFor();
  await page.locator("#login-user").fill("redirect");
  await page.locator("#login-password").fill("synthetic-password");
  await page.locator("#login-submit").click();
  await page
    .locator("#login-error")
    .filter({ hasText: "Failed to fetch" })
    .waitFor();
  assert.equal(trapRequests.length, 0);
  await page.locator("#login-user").fill("bob");
  await page.locator("#login-submit").click();
  await page.locator("#login-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () =>
      document.querySelector("#current-id").textContent === "@bob:home.test",
  );
  assert.equal(await page.locator("#owned-bots .contact-row").count(), 0);
  assert.equal(await page.locator("#message-input").textContent(), "");
  checks.push(
    "logoutReloginClearsIdentityStateAndPasswordRequestsNeverFollowRedirects",
  );

  state.configMode = "same";
  const legacyContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
  });
  await legacyContext.addInitScript(
    ({ homeUser, homeRoom }) => {
      if (sessionStorage.getItem("legacy-seeded")) return;
      sessionStorage.setItem("legacy-seeded", "true");
      sessionStorage.setItem(
        "ds-group.session",
        JSON.stringify({
          user_id: homeUser,
          access_token: "legacy-fixture-token",
        }),
      );
      sessionStorage.setItem(
        `ds-group.room.${homeUser}`,
        JSON.stringify(homeRoom),
      );
      sessionStorage.setItem(
        `ds-group.draft.${homeUser}.${homeRoom}`,
        JSON.stringify({ body: "Existing same-origin draft", attachments: [] }),
      );
    },
    { homeUser, homeRoom },
  );
  const legacyPage = await legacyContext.newPage();
  legacyPage.on("pageerror", (error) => pageErrors.push(error.message));
  await legacyPage.goto(clientOrigin);
  await legacyPage.waitForFunction(
    () =>
      document.querySelector("#message-input").textContent ===
      "Existing same-origin draft",
  );
  assert.equal(
    await legacyPage
      .locator("#login-dialog")
      .evaluate((element) => element.open),
    false,
  );
  assert.equal(
    await legacyPage.evaluate(() => sessionStorage.getItem("ds-group.session")),
    null,
  );
  assert.equal(await legacyPage.locator("#current-id").textContent(), homeUser);
  await legacyContext.close();
  checks.push("sameOriginLegacySessionAndDraftUpgradeToVerifiedCentralSubject");

  const privateOrigin = "http://192.168.50.25:24360";
  const privateContext = await browser.newContext({ locale: "en-US" });
  await privateContext.addInitScript(
    ({ homeUser, homeRoom }) => {
      sessionStorage.setItem(
        "ds-group.session",
        JSON.stringify({
          user_id: homeUser,
          access_token: "legacy-fixture-token",
        }),
      );
      sessionStorage.setItem(
        `ds-group.room.${homeUser}`,
        JSON.stringify(homeRoom),
      );
      sessionStorage.setItem(
        `ds-group.draft.${homeUser}.${homeRoom}`,
        JSON.stringify({
          body: "Private HTTP same-origin draft",
          attachments: [],
        }),
      );
    },
    { homeUser, homeRoom },
  );
  await privateContext.route(privateOrigin + "/**", (route) => {
    const work = (async () => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/.well-known/dscord/client") {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ...publicConfig(privateOrigin),
            home: {
              ...publicConfig(privateOrigin).home,
              matrixUrl: "http://10.30.40.50:18008",
            },
          }),
        });
      }
      const response = await route.fetch({
        url: request.url().replace(privateOrigin, clientOrigin),
      });
      if (url.pathname === "/api/me") {
        const profile = await response.json();
        profile.home = {
          ...publicConfig(privateOrigin).home,
          matrixUrl: "http://10.30.40.50:18008",
        };
        return route.fulfill({ response, body: JSON.stringify(profile) });
      }
      return route.fulfill({ response });
    })();
    const tracked = work.catch((error) => {
      routeFailures.push(error.message);
    });
    privateRouteJobs.add(tracked);
    void tracked.finally(() => privateRouteJobs.delete(tracked));
    return tracked;
  });
  const privatePage = await privateContext.newPage();
  privatePage.on("pageerror", (error) => pageErrors.push(error.message));
  await privatePage.goto(privateOrigin);
  await privatePage.waitForFunction(
    () =>
      document.querySelector("#message-input").textContent ===
      "Private HTTP same-origin draft",
  );
  await privatePage.waitForFunction(
    () =>
      document.querySelector("#connection-text").textContent === "Connected",
  );
  assert.equal(
    await privatePage.locator("#current-id").textContent(),
    homeUser,
  );
  assert.equal(
    await privatePage
      .locator("#login-dialog")
      .evaluate((element) => element.open),
    false,
  );
  assert.equal(await privatePage.evaluate(() => isSecureContext), false);
  assert.equal(
    await privatePage.evaluate(() => typeof crypto.randomUUID),
    "undefined",
  );
  await privatePage
    .locator("#message-input")
    .fill("HTTP intranet message keeps home identity");
  await privatePage.locator("#send-button").click();
  await privatePage.waitForFunction(
    () => document.querySelector("#message-input").textContent === "",
  );
  assert.equal(state.messages.at(-1).userId, homeUser);
  assert.match(state.messages.at(-1).body.transactionId, /^[a-f0-9-]{36}$/);
  await privateContext.unrouteAll({ behavior: "wait" });
  await Promise.all([...privateRouteJobs]);
  assert.deepEqual(routeFailures, []);
  await privateContext.close();
  checks.push(
    "normalEntryPreservesPrivateHttpSameOriginSessionAndPrivateMatrixDiscoveryWithRouteBackedOrigin",
  );

  state.configMode = "split";
  const unboundContext = await browser.newContext({ locale: "en-US" });
  await unboundContext.addInitScript(
    (homeUser) =>
      sessionStorage.setItem(
        "ds-group.session",
        JSON.stringify({
          user_id: homeUser,
          access_token: "legacy-must-not-travel",
        }),
      ),
    homeUser,
  );
  const unboundPage = await unboundContext.newPage();
  await unboundPage.goto(clientOrigin);
  await unboundPage.locator("#login-dialog[open]").waitFor();
  assert.equal(
    records.some((row) =>
      row.authorization?.includes("legacy-must-not-travel"),
    ),
    false,
  );
  await unboundContext.close();
  checks.push("splitDeploymentNeverMigratesUnboundLegacyCredential");

  assert.ok(
    records
      .filter((row) => row.origin === homeOrigin)
      .every((row) => !row.cookie),
  );
  assert.ok(
    records
      .filter((row) => row.authorization)
      .every((row) => [homeOrigin, clientOrigin].includes(row.origin)),
  );
  assert.equal(trapRequests.length, 0);
  assert.deepEqual(pageErrors, []);
  checks.push(
    "allCredentialReceiversArePinnedHomeServicesWithNoAmbientCookiesOrPageErrors",
  );
} catch (error) {
  failure = error;
} finally {
  if (failure && page)
    await page
      .screenshot({ path: path.join(output, "failure.png") })
      .catch(() => {});
  const report = {
    status: failure ? "failed" : "passed",
    evidence:
      "Production build and real Chromium, separate static/home/discovery HTTP origins with synthetic API fixtures; no real Matrix or model calls",
    checks,
    pageErrors,
    routeFailures,
    credentialOrigins: [
      ...new Set(
        records.filter((row) => row.authorization).map((row) => row.origin),
      ),
    ],
    publicDiscoveryRequests: records.filter(
      (row) => row.origin === unknownOrigin,
    ).length,
    trapRequests: trapRequests.length,
    modelCalls: 0,
    physicalHosts: 1,
    realBackend: false,
    ...(failure ? { error: failure.stack } : {}),
  };
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser?.close();
  for (const server of servers.reverse()) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(JSON.stringify(report));
}
if (failure) throw failure;
