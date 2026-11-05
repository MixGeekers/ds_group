#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { chromium } from "@playwright/test";
import { packageRoot } from "../src/paths.mjs";
import { MatrixClient } from "../src/matrix-client.mjs";

const { values } = parseArgs({
  options: {
    run: { type: "boolean", default: false },
    "backend-root": { type: "string" },
    project: { type: "string" },
    "port-base": { type: "string", default: "24300" },
    "client-port": { type: "string", default: "24370" },
  },
});
const backendRoot = path.resolve(
  values["backend-root"] ||
    process.env.DS_GROUP_CLIENT_BACKEND_ROOT ||
    packageRoot,
);
const base = Number(values["port-base"]);
const clientPort = Number(values["client-port"]);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const project =
  values.project ||
  `dscord-ui-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
assert.match(project, /^[a-z][a-z0-9-]{2,40}$/);
assert.ok(Number.isInteger(base) && base > 1024 && base < 65000);
assert.ok(
  Number.isInteger(clientPort) && clientPort > 1024 && clientPort < 65536,
);
const clientUrl = `http://127.0.0.1:${clientPort}`;
const directory = path.join(packageRoot, ".local/federated-client", runId);
const labRoot = path.join(directory, "lab");
const reportPath = path.join(
  packageRoot,
  "artifacts/unified-client",
  `federated-ui-${runId}.json`,
);
const plan = {
  backendRoot,
  clientUrl,
  project,
  portBase: base,
  labRoot,
  reportPath,
  modelCalls: 0,
  physicalHosts: 1,
};
if (!values.run) {
  console.log(JSON.stringify({ status: "plan-only", ...plan }, null, 2));
  process.exit(0);
}
await access(path.join(backendRoot, "src/room-media.mjs"));
await access(path.join(backendRoot, "src/bot-work.mjs"));
const { initializeServer } = await import(
  pathToFileURL(path.join(backendRoot, "scripts/server-init.mjs"))
);
const { initializeCentralIdentity } = await import(
  pathToFileURL(path.join(backendRoot, "scripts/central-init.mjs"))
);
const execute = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secretValues = new Set();
const report = {
  schemaVersion: 1,
  date: new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" }),
  runId,
  status: "running",
  evidenceLevel:
    "normal production React/PWA; real independent A/B/C Synapse/Core/admin; verified private-CA Matrix federation; synthetic accounts",
  ...plan,
  checks: [],
  sourceSha256: {},
};
let startedLab = false;
let browser;
let page;
let staticServer;
let bSession;
const pageErrors = [];
const browserCredentials = [];
const browserMedia = [];

async function save() {
  let text = JSON.stringify(report, null, 2);
  for (const value of secretValues)
    if (value) text = text.replaceAll(value, "[REDACTED]");
  await writeFile(reportPath, text + "\n");
}
async function check(name, work) {
  console.log(`Checking ${name}`);
  try {
    report.checks.push({ name, status: "passed", details: await work() });
  } catch (error) {
    report.checks.push({ name, status: "failed", error: error.message });
    throw error;
  } finally {
    await save();
  }
}
async function lab(command) {
  const result = await execute(
    process.execPath,
    [
      path.join(backendRoot, "scripts/federation-lab.mjs"),
      command,
      "--project",
      project,
      "--port-base",
      String(base),
      "--data-root",
      labRoot,
    ],
    { cwd: backendRoot, timeout: 240000, maxBuffer: 8 * 1024 * 1024 },
  );
  await writeFile(
    path.join(directory, `lab-${command}.log`),
    result.stdout + result.stderr,
    { mode: 0o600 },
  );
  return result;
}
async function ready(url) {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Readiness timed out: ${url}`);
}
async function poll(work) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await work();
    if (value) return value;
    await delay(250);
  }
  throw new Error("Federated observation timed out");
}
async function api(
  server,
  route,
  {
    token,
    body,
    method = body === undefined ? "GET" : "POST",
    admin = false,
    status = 200,
  } = {},
) {
  const response = await fetch(
    new URL(route, admin ? server.adminUrl : server.coreUrl),
    {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const value = await response.json();
  assert.equal(
    response.status,
    status,
    `${method} ${route}: ${response.status}; ${value.error || ""}`,
  );
  return value;
}
async function savePolicy(server, next) {
  const result = await api(server, "/admin-api/policy", {
    admin: true,
    token: server.adminToken,
    method: "PUT",
    body: { ...next, revision: server.policy.revision },
  });
  server.policy = result.policy;
  await api(server, "/admin-api/apply", {
    admin: true,
    token: server.adminToken,
    body: { revision: server.policy.revision },
  });
  await poll(
    async () =>
      (
        await api(server, "/admin-api/policy", {
          admin: true,
          token: server.adminToken,
        })
      ).application.livePolicyObserved,
  );
}
async function ownedRestart(server) {
  const { stdout } = await execute("docker", ["inspect", server.container]);
  assert.equal(
    JSON.parse(stdout)[0].Config.Labels["org.dscord.federation-lab"],
    labRoot,
  );
  await execute("docker", ["restart", "--time", "20", server.container], {
    timeout: 30000,
  });
  await ready(server.matrixUrl + "/_matrix/client/versions");
}
async function selectedRoom(id) {
  await page.waitForFunction(
    (roomId) => new URL(location.href).searchParams.get("roomId") === roomId,
    id,
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector("#message-input")
        .getAttribute("contenteditable") === "true",
  );
}
async function sessionInPage() {
  return page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((key) =>
      key.startsWith("ds-group.session.v2."),
    );
    return key ? JSON.parse(sessionStorage.getItem(key)) : null;
  });
}

await mkdir(directory, { recursive: true, mode: 0o700 });
await mkdir(path.dirname(reportPath), { recursive: true });
try {
  for (const port of [
    ...new Set([
      base,
      base + 8,
      base + 10,
      base + 20,
      base + 28,
      base + 30,
      base + 40,
      base + 48,
      base + 50,
      clientPort,
    ]),
  ]) {
    const socket = net.createServer();
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(port, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => socket.close(resolve));
  }
  report.backendCommit = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: backendRoot })
  ).stdout.trim();
  report.clientCommit = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: packageRoot })
  ).stdout.trim();
  for (const [kind, root, files] of [
    [
      "client",
      packageRoot,
      [
        "web/src/App.tsx",
        "web/attachments.js",
        "web/src/attachment-proof.ts",
        "web/src/components/BotWorkGrants.tsx",
        "scripts/verify-federated-client.mjs",
      ],
    ],
    [
      "backend",
      backendRoot,
      [
        "src/core.mjs",
        "src/collaboration.mjs",
        "src/room-media.mjs",
        "src/bot-work.mjs",
        "scripts/federation-lab.mjs",
        "deploy/synapse/dscord_guard.py",
      ],
    ],
  ])
    for (const file of files)
      report.sourceSha256[`${kind}/${file}`] = hash(
        await readFile(path.join(root, file)),
      );
  await execute("npm", ["run", "build"], {
    cwd: packageRoot,
    maxBuffer: 2 ** 20,
  });
  // Persist API-only before the lab adds its verified TLS federation listener.
  await initializeServer(
    {
      dataRoot: path.join(labRoot, "b/core"),
      synapseRoot: path.join(labRoot, "b/synapse"),
      serverName: `b.${project}.test:8448`,
      homeserverUrl: `http://127.0.0.1:${base + 28}`,
      publicHomeserverUrl: `http://127.0.0.1:${base + 28}`,
      publicUrl: `http://127.0.0.1:${base + 20}`,
      webMode: "api-only",
    },
    { containerOwnership: false },
  );
  console.log("Starting isolated A/B/C federation lab");
  startedLab = true;
  await lab("up");
  const state = JSON.parse(
    await readFile(path.join(labRoot, "lab.json"), "utf8"),
  );
  const [a, b, c] = state.servers;
  for (const server of state.servers) {
    server.setup = JSON.parse(
      await readFile(path.join(server.dataRoot, "matrix-setup.json"), "utf8"),
    );
    server.alice = server.setup.participants.find(
      (person) => person.localpart === "alice",
    );
    server.bot = server.setup.participants.find(
      (person) => person.kind === "bot" && person.ownerId === server.alice.id,
    );
    for (const person of server.setup.participants) {
      secretValues.add(person.accessToken);
      secretValues.add(person.password);
    }
    server.client = new MatrixClient({
      baseUrl: server.matrixUrl,
      accessToken: server.alice.accessToken,
    });
  }
  report.servers = state.servers.map(
    ({ name, serverName, coreUrl, matrixUrl, adminUrl }) => ({
      name,
      serverName,
      coreUrl,
      matrixUrl,
      adminUrl,
    }),
  );
  await check(
    "B becomes a persistent default home with exact independent client Origin and API-only hosting",
    async () => {
      await initializeCentralIdentity({
        dataRoot: b.dataRoot,
        coreUrl: b.coreUrl,
        matrixUrl: b.matrixUrl,
        clientOrigins: [clientUrl],
      });
      await lab("reload");
      assert.equal((await fetch(b.coreUrl + "/")).status, 404);
      const discovery = await (
        await fetch(b.coreUrl + "/.well-known/dscord/client")
      ).json();
      assert.equal(discovery.mode, "central");
      assert.equal(discovery.home.serverName, b.serverName);
      return {
        serverName: b.serverName,
        apiOnly: true,
        authorityId: discovery.authorityId,
        clientOrigin: clientUrl,
      };
    },
  );
  for (const server of state.servers) {
    const credentials = JSON.parse(
      await readFile(
        path.join(server.dataRoot, "lab-administrator.json"),
        "utf8",
      ),
    );
    secretValues.add(credentials.password);
    server.adminToken = (
      await api(server, "/admin-api/login", { admin: true, body: credentials })
    ).access_token;
    secretValues.add(server.adminToken);
    server.policy = (
      await api(server, "/admin-api/policy", {
        admin: true,
        token: server.adminToken,
      })
    ).policy;
  }
  const sharedRoom = a.setup.roomId;
  const initialRoom = b.setup.roomId;
  await check(
    "A/B use real partner/member/room administration and an actual Matrix invitation",
    async () => {
      for (const [server, partner] of [
        [a, b],
        [b, a],
      ]) {
        await savePolicy(server, {
          ...server.policy,
          partners: [
            {
              serverName: partner.serverName,
              name: `Partner ${partner.name.toUpperCase()}`,
              enabled: true,
            },
          ],
          members: [
            {
              id: partner.alice.id,
              name: `Alice ${partner.name.toUpperCase()}`,
              kind: "human",
              enabled: true,
            },
          ],
          rooms: [
            {
              roomId: sharedRoom,
              authority: a.serverName,
              name: "Shared A/B",
              enabled: true,
              memberIds: [b.alice.id],
              tools: [],
              botIds: [],
            },
          ],
        });
        await ownedRestart(server);
      }
      await api(a, `/api/rooms/${encodeURIComponent(sharedRoom)}/invite`, {
        token: a.alice.accessToken,
        body: { participantId: b.alice.id },
      });
      return {
        sharedRoom,
        homeRoom: initialRoom,
        invitedUser: b.alice.id,
        shadowAccountCreated: false,
      };
    },
  );
  const mime = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webmanifest": "application/manifest+json",
  };
  staticServer = createServer(
    (request, response) =>
      void (async () => {
        const url = new URL(request.url, clientUrl);
        if (url.pathname === "/client-config.json") {
          response.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
          });
          response.end(
            JSON.stringify({
              schemaVersion: 1,
              homeCoreUrl: b.coreUrl,
              homeMatrixUrl: b.matrixUrl,
            }),
          );
          return;
        }
        const filename = path.resolve(
          packageRoot,
          "dist/web",
          "." + (url.pathname === "/" ? "/index.html" : url.pathname),
        );
        if (
          !filename.startsWith(path.join(packageRoot, "dist/web") + path.sep)
        ) {
          response.writeHead(404);
          response.end();
          return;
        }
        try {
          const bytes = await readFile(filename);
          response.writeHead(200, {
            "Content-Type":
              mime[path.extname(filename)] || "application/octet-stream",
            "Cache-Control": "no-cache",
          });
          response.end(bytes);
        } catch {
          response.writeHead(404);
          response.end();
        }
      })().catch(() => {
        response.writeHead(500);
        response.end();
      }),
  );
  await new Promise((resolve, reject) => {
    staticServer.once("error", reject);
    staticServer.listen(clientPort, "127.0.0.1", resolve);
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1440, height: 1000 },
  });
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.headers().authorization)
      browserCredentials.push({ origin: url.origin, path: url.pathname });
    if (url.pathname.includes("/attachments/"))
      browserMedia.push({
        origin: url.origin,
        path: url.pathname,
        eventId: url.searchParams.get("eventId"),
      });
  });
  await check(
    "one real B home login accepts A invitation and switches A/B while preserving its subject",
    async () => {
      await page.goto(clientUrl);
      await page.locator("#login-user").fill("alice");
      await page.locator("#login-password").fill(b.alice.password);
      await page.locator("#login-submit").click();
      await page.locator("#login-dialog").waitFor({ state: "hidden" });
      await selectedRoom(initialRoom);
      bSession = await sessionInPage();
      secretValues.add(bSession.access_token);
      assert.equal(bSession.user_id, b.alice.id);
      report.identity = {
        userId: bSession.user_id,
        subjectId: bSession.identity.subjectId,
        authorityId: bSession.identity.authorityId,
      };
      await page.locator(`[data-server="${a.serverName}"]`).waitFor();
      await page.locator("#server-settings-button").click();
      await page
        .locator(`[data-invitation="${sharedRoom}"]`)
        .getByRole("button", { name: "Join", exact: true })
        .click();
      await page.locator("#spaces-dialog").waitFor({ state: "hidden" });
      await selectedRoom(sharedRoom);
      assert.equal(await page.locator("#current-id").textContent(), b.alice.id);
      await page.locator("#message-input").fill("Independent draft in A");
      await page.waitForTimeout(220);
      await page.locator(`[data-server="${b.serverName}"]`).click();
      await selectedRoom(initialRoom);
      await page.locator("#message-input").fill("Independent draft in B");
      await page.waitForTimeout(220);
      await page.locator(`[data-server="${a.serverName}"]`).click();
      await selectedRoom(sharedRoom);
      assert.equal(
        await page.locator("#message-input").textContent(),
        "Independent draft in A",
      );
      await page.locator("#message-input").fill("");
      assert.equal(
        (await sessionInPage()).identity.subjectId,
        report.identity.subjectId,
      );
      return {
        homeUser: b.alice.id,
        sharedRoom,
        sameSubject: true,
        roomDraftsIndependent: true,
      };
    },
  );
  const incomingBody = `A to B through real federation ${runId}`;
  const incoming = await api(
    a,
    `/api/rooms/${encodeURIComponent(sharedRoom)}/messages`,
    {
      token: a.alice.accessToken,
      body: { body: incomingBody, transactionId: `ui-a-${Date.now()}` },
    },
  );
  await check(
    "foreign text and same-name member resolve to full A identity, and a UI reply arrives as the original B human",
    async () => {
      await page.getByText(incomingBody, { exact: true }).waitFor();
      const article = page.locator(`[data-event-id="${incoming.event_id}"]`);
      await article.locator(".message-name").click();
      await page.locator("#member-dialog[open]").waitFor();
      assert.equal(
        await page.locator("#member-dialog-id").textContent(),
        a.alice.id,
      );
      await page.locator("#close-member").click();
      await article.hover();
      await article
        .getByRole("button", { name: "Reply to Alice", exact: false })
        .click();
      const body = `B replies from independent UI ${runId}`;
      await page.locator("#message-input").fill(body);
      await page.locator("#send-button").click();
      await page.waitForFunction(
        () => document.querySelector("#message-input").textContent === "",
      );
      const event = await poll(async () =>
        (await a.client.timeline(sharedRoom, 100)).find(
          (event) => event.content.body === body,
        ),
      );
      assert.equal(event.sender, b.alice.id);
      assert.equal(event.content["org.ds_group"].replyTo, incoming.event_id);
      return {
        sentEventId: event.event_id,
        sender: event.sender,
        replyTo: incoming.event_id,
      };
    },
  );
  let foreignAttachment;
  let foreignEvent;
  const foreignBytes = Buffer.from(`Real foreign A attachment ${runId}\n`);
  await check(
    "A-origin message attachment previews and downloads through B home room/event proof",
    async () => {
      const upload = await fetch(
        a.coreUrl + "/api/attachments?filename=foreign-a.txt",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${a.alice.accessToken}`,
            "Content-Type": "text/plain",
            "X-Upload-Id": `foreign-${Date.now()}`,
          },
          body: foreignBytes,
        },
      );
      assert.equal(upload.status, 200);
      foreignAttachment = (await upload.json()).attachment;
      foreignEvent = await api(
        a,
        `/api/rooms/${encodeURIComponent(sharedRoom)}/messages`,
        {
          token: a.alice.accessToken,
          body: {
            body: "Foreign A proof attachment",
            transactionId: `proof-a-${Date.now()}`,
            attachments: [foreignAttachment.id],
          },
        },
      );
      await page
        .locator(`[data-attachment-id="${foreignAttachment.id}"]`)
        .waitFor();
      await page
        .getByRole("button", { name: "Preview foreign-a.txt", exact: true })
        .click();
      await page
        .locator(".preview-text")
        .filter({ hasText: foreignBytes.toString().trim() })
        .waitFor();
      await page.locator("#close-preview").click();
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Download foreign-a.txt", exact: true })
        .click();
      const bytes = await readFile(await (await download).path());
      assert.equal(hash(bytes), hash(foreignBytes));
      assert.ok(
        browserMedia.some(
          (request) =>
            request.origin === b.coreUrl &&
            request.eventId === foreignEvent.event_id &&
            request.path.includes(encodeURIComponent(sharedRoom)),
        ),
      );
      assert.equal(
        browserMedia.some((request) =>
          request.path.startsWith("/api/attachments/"),
        ),
        false,
      );
      return {
        attachmentId: foreignAttachment.id,
        eventId: foreignEvent.event_id,
        bytes: bytes.length,
        independentlyMatchedSha256: hash(bytes),
        serverRejectsArbitraryBadStreamHashes:
          "not claimed by this positive-byte test",
      };
    },
  );
  await check(
    "file uploaded in the A view stays a B-home file on the actual A message",
    async () => {
      const bytes = Buffer.from(`Real B uploaded file ${runId}`);
      await page.locator("#attachment-input").setInputFiles({
        name: "from-b-ui.txt",
        mimeType: "text/plain",
        buffer: bytes,
      });
      await page.locator(".attachment-draft-ready").waitFor();
      const body = `B UI file message ${runId}`;
      await page.locator("#message-input").fill(body);
      await page.locator("#send-button").click();
      await page.locator(".attachment-draft").waitFor({ state: "detached" });
      const event = await poll(async () =>
        (await a.client.timeline(sharedRoom, 100)).find(
          (event) => event.content.body === body,
        ),
      );
      assert.equal(event.sender, b.alice.id);
      const file = event.content["org.ds_group"].attachments[0];
      assert.ok(file.contentUri.startsWith(`mxc://${b.serverName}/`));
      const response = await fetch(
        a.coreUrl +
          `/api/rooms/${encodeURIComponent(sharedRoom)}/attachments/${encodeURIComponent(file.id)}?eventId=${encodeURIComponent(event.event_id)}`,
        { headers: { Authorization: `Bearer ${a.alice.accessToken}` } },
      );
      assert.equal(response.status, 200);
      assert.equal(
        hash(Buffer.from(await response.arrayBuffer())),
        hash(bytes),
      );
      return {
        eventId: event.event_id,
        sender: event.sender,
        attachmentId: file.id,
        mxcHome: b.serverName,
        bytes: bytes.length,
      };
    },
  );
  await check(
    "the actual B Bot owner explicitly saves, reads back and disables a real A-room work grant with CAS revisions",
    async () => {
      await page.locator("#manage-bots-button").click();
      await page.locator(`[data-work-grants-button="${b.bot.id}"]`).click();
      await page.waitForFunction(
        () => !document.querySelector("#add-work-grant").disabled,
      );
      await page.locator("#add-work-grant").click();
      await page.locator("#work-grant-room-0").selectOption(sharedRoom);
      await page.locator(`[data-grant-requester="${a.alice.id}"]`).check();
      await page.locator('[data-grant-tool="read"]').check();
      await page.locator("[data-grant-enabled]").check();
      await page.locator("#save-work-grants").click();
      await page
        .locator("#work-grant-feedback")
        .filter({ hasText: "Permissions saved" })
        .waitFor();
      const granted = await api(
        b,
        `/api/bots/${encodeURIComponent(b.bot.id)}/work-grants`,
        { token: bSession.access_token },
      );
      assert.equal(granted.revision, 1);
      assert.equal(granted.grants[0].roomId, sharedRoom);
      assert.deepEqual(granted.grants[0].requesterIds, [a.alice.id]);
      assert.equal(granted.grants[0].enabled, true);
      await page.locator("#reload-work-grants").click();
      await page.waitForFunction(
        () => !document.querySelector("#add-work-grant").disabled,
      );
      await page.locator("[data-grant-enabled]").uncheck();
      await page.locator("#save-work-grants").click();
      await page
        .locator("#work-grant-feedback")
        .filter({ hasText: "Permissions saved" })
        .waitFor();
      const disabled = await api(
        b,
        `/api/bots/${encodeURIComponent(b.bot.id)}/work-grants`,
        { token: bSession.access_token },
      );
      assert.equal(disabled.revision, 2);
      assert.equal(disabled.grants[0].enabled, false);
      await page.locator("#my-bots-dialog .dialog-heading button").click();
      return {
        botId: b.bot.id,
        ownerId: b.alice.id,
        requesterId: a.alice.id,
        savedRevision: 1,
        disabledRevision: 2,
        nodeStarted: false,
        modelCalls: 0,
      };
    },
  );
  await check(
    "an unsupported C room remains a real rejection without a phantom server membership",
    async () => {
      await page.locator("#server-settings-button").click();
      await page.locator("#join-room-id").fill(c.setup.roomId);
      await page.locator("#join-room").click();
      await page
        .locator("#space-feedback")
        .filter({ hasText: "Join rejected" })
        .waitFor();
      await page.locator("#spaces-dialog .dialog-heading button").click();
      assert.equal(
        await page.locator(`[data-server="${c.serverName}"]`).count(),
        0,
      );
      return { rejectedRoomId: c.setup.roomId, phantomSpace: false };
    },
  );
  await check(
    "actual B partner revocation removes A channels and denies fresh room-proven bytes",
    async () => {
      await savePolicy(b, {
        ...b.policy,
        partners: b.policy.partners.map((partner) => ({
          ...partner,
          enabled: false,
        })),
      });
      await page.waitForFunction(
        (server) =>
          document
            .querySelector(`[data-server="${server}"]`)
            ?.classList.contains("server-revoked"),
        a.serverName,
      );
      assert.equal(await page.locator("#send-button").isDisabled(), true);
      const response = await fetch(
        b.coreUrl +
          `/api/rooms/${encodeURIComponent(sharedRoom)}/attachments/${encodeURIComponent(foreignAttachment.id)}?eventId=${encodeURIComponent(foreignEvent.event_id)}`,
        { headers: { Authorization: `Bearer ${bSession.access_token}` } },
      );
      assert.equal(response.status, 403);
      return {
        authority: a.serverName,
        currentViewRestricted: true,
        proofReadStatus: response.status,
        previousCopiesErased: false,
      };
    },
  );
  await check(
    "explicit reapproval, browser offline reload and formal Core restart preserve B identity and A draft",
    async () => {
      await savePolicy(b, {
        ...b.policy,
        partners: b.policy.partners.map((partner) => ({
          ...partner,
          enabled: true,
        })),
      });
      await page.waitForFunction(
        (server) =>
          !document
            .querySelector(`[data-server="${server}"]`)
            ?.classList.contains("server-revoked"),
        a.serverName,
      );
      await page.locator(`[data-server="${a.serverName}"]`).click();
      await selectedRoom(sharedRoom);
      await page.locator("#message-input").fill("Real A offline draft");
      await page.waitForTimeout(220);
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      await page.waitForFunction(() => navigator.serviceWorker.controller);
      await context.setOffline(true);
      await page.reload();
      await page.waitForFunction(
        () =>
          document.querySelector("#message-input").textContent ===
          "Real A offline draft",
      );
      assert.equal(await page.locator("#send-button").isDisabled(), true);
      const resumed = `A message while client offline ${runId}`;
      await api(a, `/api/rooms/${encodeURIComponent(sharedRoom)}/messages`, {
        token: a.alice.accessToken,
        body: { body: resumed, transactionId: `offline-${Date.now()}` },
      });
      await lab("reload");
      await context.setOffline(false);
      await page.waitForFunction(
        () =>
          document.querySelector("#connection-text").textContent ===
          "Connected",
      );
      await page.getByText(resumed, { exact: true }).waitFor();
      assert.equal(
        (await sessionInPage()).identity.subjectId,
        report.identity.subjectId,
      );
      assert.equal(
        await page.locator("#message-input").textContent(),
        "Real A offline draft",
      );
      return {
        sameSubject: true,
        sameHomeUser: b.alice.id,
        formalServiceReload: true,
        foreignMessageRecovered: true,
        draftPreserved: true,
      };
    },
  );
  await page.screenshot({ path: path.join(directory, "real-a-room.png") });
  assert.deepEqual(pageErrors, []);
  assert.ok(
    browserCredentials.every((request) => request.origin === b.coreUrl),
  );
  report.credentialOrigins = [
    ...new Set(browserCredentials.map((request) => request.origin)),
  ];
  report.browserMediaRequests = browserMedia;
  report.budgets = {};
  for (const server of state.servers) {
    const status = await api(server, "/api/status");
    assert.equal(status.budget.used, 0);
    report.budgets[server.name] = {
      modelCalls: status.budget.used,
      loadedCoreSha256: status.core.loadedCoreSha256,
    };
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  process.exitCode = 1;
  if (page)
    await page
      .screenshot({ path: path.join(directory, "failure.png") })
      .catch(() => {});
} finally {
  await browser?.close();
  if (staticServer) {
    staticServer.closeAllConnections();
    await new Promise((resolve) => staticServer.close(resolve));
  }
  if (startedLab) {
    try {
      await lab("down");
      report.cleanup = {
        labStopped: true,
        retainedPrivateData: labRoot,
        staticClientStopped: true,
      };
    } catch (error) {
      report.cleanup = {
        labStopped: false,
        error: error.message,
        retainedPrivateData: labRoot,
      };
      report.status = "failed";
      process.exitCode = 1;
    }
  }
  report.pageErrors = pageErrors;
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      status: report.status,
      report: reportPath,
      checks: report.checks.length,
      modelCalls: 0,
      cleanup: report.cleanup?.labStopped,
    }),
  );
}
