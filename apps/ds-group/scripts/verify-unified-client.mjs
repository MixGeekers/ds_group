#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { packageRoot } from "../src/paths.mjs";
import { MatrixClient } from "../src/matrix-client.mjs";

const execute = promisify(execFile);
const backendRoot = path.resolve(
  process.env.DS_GROUP_CLIENT_BACKEND_ROOT || packageRoot,
);
const { initializeServer } = await import(
  pathToFileURL(path.join(backendRoot, "scripts/server-init.mjs"))
);
const { initializeCentralIdentity } = await import(
  pathToFileURL(path.join(backendRoot, "scripts/central-init.mjs"))
);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const directory = path.join(packageRoot, ".local/unified-client-real", runId);
const reportPath = path.join(
  packageRoot,
  "artifacts/unified-client",
  `real-${runId}.json`,
);
const coreUrl = "http://127.0.0.1:24370";
const clientUrl = "http://127.0.0.1:24371";
const matrixUrl = "http://127.0.0.1:24378";
const containerName = `dscord-unified-client-${runId.toLowerCase()}`;
const image =
  "ghcr.io/element-hq/synapse@sha256:f0df87cff259872637b4b5e5174b9977e5e3046dd421505407803b5e45c5f842";
const dataRoot = path.join(directory, "core");
const synapseRoot = path.join(directory, "matrix");
const privateState = { password: randomBytes(24).toString("base64url") };
const report = {
  schemaVersion: 1,
  runId,
  date: "2026-11-04",
  status: "running",
  evidenceLevel:
    "normal-production-React-client-real-local-Core-and-Synapse-separate-HTTP-origins-synthetic-accounts-zero-model",
  image,
  origins: { coreUrl, clientUrl, matrixUrl },
  checks: [],
  modelCalls: 0,
  physicalCrossMachine: false,
  federatedRooms: "not run in this central-only script",
};
const pageErrors = [];
const credentialRequests = [];
let core;
let coreLog = "";
let browser;
let page;
let staticServer;
let containerStarted = false;

async function save() {
  let text = JSON.stringify(report, null, 2);
  for (const item of Object.values(privateState)) {
    if (typeof item === "string" && item.length > 16)
      text = text.replaceAll(item, "[REDACTED]");
    if (item && typeof item === "object")
      for (const [key, value] of Object.entries(item))
        if (/token|password/i.test(key) && typeof value === "string")
          text = text.replaceAll(value, "[REDACTED]");
  }
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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ready(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (core && core.exitCode !== null)
      throw new Error(`Core exited (${core.exitCode})`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Readiness timed out: ${url}`);
}
async function assertFreePorts() {
  for (const port of [24370, 24371, 24378]) {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => server.close(resolve));
  }
}
async function currentSession() {
  return page.evaluate(async () => {
    // Production bundles do not expose TS modules. Read the one deployment-scoped session slot.
    const key = Object.keys(sessionStorage).find((key) =>
      key.startsWith("ds-group.session.v2."),
    );
    return key ? JSON.parse(sessionStorage.getItem(key)) : null;
  });
}

await mkdir(directory, { recursive: true, mode: 0o700 });
await mkdir(path.dirname(reportPath), { recursive: true });
try {
  await assertFreePorts();
  report.backendCommit = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: backendRoot })
  ).stdout.trim();
  for (const [label, root, names] of [
    [
      "client",
      packageRoot,
      [
        "web/src/App.tsx",
        "web/src/api.ts",
        "web/src/client-config.ts",
        "web/src/session.ts",
        "web/src/identifiers.ts",
        "web/src/components/Composer.tsx",
        "web/src/components/Shell.tsx",
        "web/src/components/SpacesDialog.tsx",
        "web/attachments.js",
        "web/pwa.js",
        "web/sw.js",
        "scripts/verify-unified-client.mjs",
      ],
    ],
    [
      "backend",
      backendRoot,
      [
        "src/core.mjs",
        "src/accounts.mjs",
        "src/identity.mjs",
        "scripts/central-init.mjs",
      ],
    ],
  ])
    for (const name of names)
      (report.sourceSha256 ||= {})[`${label}/${name}`] = createHash("sha256")
        .update(await readFile(path.join(root, name)))
        .digest("hex");
  await execute("npm", ["run", "build"], {
    cwd: packageRoot,
    maxBuffer: 2 ** 20,
  });
  await initializeServer(
    {
      dataRoot,
      synapseRoot,
      serverName: "client-qa.test",
      homeserverUrl: matrixUrl,
      publicUrl: coreUrl,
      publicHomeserverUrl: matrixUrl,
    },
    { containerOwnership: false },
  );
  await initializeCentralIdentity({
    dataRoot,
    coreUrl,
    matrixUrl,
    clientOrigins: [clientUrl],
  });
  await execute(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      containerName,
      "--publish",
      "127.0.0.1:24378:8008",
      "--mount",
      `type=bind,source=${synapseRoot},target=/data`,
      "--env",
      "UID=0",
      "--env",
      "GID=0",
      image,
      "run",
      "-m",
      "synapse.app.homeserver",
      "--config-path=/data/homeserver.yaml",
    ],
    { timeout: 30000 },
  );
  containerStarted = true;
  await ready(matrixUrl + "/_matrix/client/versions");
  core = spawn(process.execPath, ["src/core.mjs"], {
    cwd: backendRoot,
    env: {
      ...process.env,
      DS_GROUP_DATA_DIR: dataRoot,
      DS_GROUP_MATRIX_URL: matrixUrl,
      DS_GROUP_PORT: "24370",
      DS_GROUP_HOST: "127.0.0.1",
      DS_GROUP_DEMO_LOGIN: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  core.stdout.on("data", (bytes) => {
    coreLog += bytes;
  });
  core.stderr.on("data", (bytes) => {
    coreLog += bytes;
  });
  await ready(coreUrl + "/readyz");
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
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
              homeCoreUrl: coreUrl,
              homeMatrixUrl: matrixUrl,
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
          response.writeHead(200, {
            "Content-Type":
              types[path.extname(filename)] || "application/octet-stream",
            "Cache-Control": "no-cache",
          });
          response.end(await readFile(filename));
        } catch {
          response.writeHead(404);
          response.end();
        }
      })().catch(() => {
        response.writeHead(500);
        response.end();
      }),
  );
  await new Promise((resolve) =>
    staticServer.listen(24371, "127.0.0.1", resolve),
  );
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (request.headers().authorization)
      credentialRequests.push({
        origin: new URL(request.url()).origin,
        path: new URL(request.url()).pathname,
      });
  });
  await check(
    "normal production entry registers the first central account with no fabricated initial room",
    async () => {
      await page.goto(clientUrl);
      await page.locator("#auth-toggle-mode").click();
      await page.locator("#login-user").fill("alice");
      await page.locator("#register-name").fill("QA Alice");
      await page.locator("#login-password").fill(privateState.password);
      await page.locator("#login-submit").click();
      await page.locator("#login-dialog").waitFor({ state: "hidden" });
      await page.waitForFunction(
        () =>
          document.querySelector("#current-id").textContent ===
          "@alice:client-qa.test",
      );
      await page.locator("#create-room-button").waitFor({ state: "visible" });
      assert.equal(await page.locator(".room-item").count(), 0);
      privateState.session = await currentSession();
      report.identity = {
        userId: privateState.session.user_id,
        subjectId: privateState.session.identity.subjectId,
        authorityId: privateState.session.identity.authorityId,
      };
      return {
        userId: report.identity.userId,
        initialJoinedRooms: 0,
        stableSubject: Boolean(report.identity.subjectId),
      };
    },
  );
  await check(
    "room creation and text send from the normal UI reach the real home Matrix room",
    async () => {
      await page.locator("#create-room-button").click();
      await page.locator("#new-room-name").fill("Unified client QA");
      await page.locator("#room-submit").click();
      await page.locator("#room-dialog").waitFor({ state: "hidden" });
      await page
        .locator("#room-title")
        .filter({ hasText: "Unified client QA" })
        .waitFor();
      await page.locator("#message-input").fill("Real central client message");
      await page.locator("#send-button").click();
      await page.waitForFunction(
        () => document.querySelector("#message-input").textContent === "",
      );
      await page
        .getByText("Real central client message", { exact: true })
        .waitFor();
      const listed = await (
        await fetch(coreUrl + "/api/rooms", {
          headers: {
            Authorization: `Bearer ${privateState.session.access_token}`,
          },
        })
      ).json();
      report.roomId = listed.rooms.find(
        (room) => room.name === "Unified client QA",
      ).roomId;
      const matrix = new MatrixClient({
        baseUrl: matrixUrl,
        accessToken: privateState.session.access_token,
      });
      const history = await matrix.request(
        "GET",
        `/_matrix/client/v3/rooms/${encodeURIComponent(report.roomId)}/messages?dir=b&limit=50`,
      );
      assert.ok(
        history.chunk.some(
          (event) =>
            event.sender === report.identity.userId &&
            event.content.body === "Real central client message",
        ),
      );
      return { roomId: report.roomId, independentlyReadMatrixMessage: true };
    },
  );
  await check(
    "cross-origin file upload sends real bytes and the returned attachment stays on its originating message",
    async () => {
      await page.locator("#attachment-input").setInputFiles({
        name: "client-proof.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Real unified-client attachment bytes"),
      });
      await page.locator(".attachment-draft-ready").waitFor();
      await page
        .locator("#message-input")
        .fill("Attachment from independent client");
      await page.locator("#send-button").click();
      await page.locator(".attachment-draft").waitFor({ state: "detached" });
      await page.locator(".attachment-card[data-attachment-id]").waitFor();
      await page
        .locator(
          '.attachment-card button[aria-label="Preview client-proof.txt"]',
        )
        .click();
      await page
        .locator(".preview-text")
        .filter({ hasText: "Real unified-client attachment bytes" })
        .waitFor();
      await page.locator("#close-preview").click();
      return {
        bytesRoundTrip: true,
        attachmentCards: await page.locator(".attachment-card").count(),
      };
    },
  );
  await check(
    "the account owns a newly created Bot and its DM remains the same full home identity",
    async () => {
      await page.locator("#create-bot-button").click();
      await page.locator("#bot-name").fill("QA Helper");
      await page.locator("#create-bot-submit").click();
      await page.locator("#bot-connection-id").waitFor();
      report.botId = await page.locator("#bot-connection-id").inputValue();
      await page.locator("#close-create-bot").click();
      await page
        .locator("#owned-bots .contact-row")
        .filter({ hasText: "QA Helper" })
        .click();
      await page
        .locator("#room-title")
        .filter({ hasText: "QA Helper" })
        .waitFor();
      assert.equal(
        await page.locator("#current-id").textContent(),
        report.identity.userId,
      );
      assert.ok(report.botId.endsWith(":client-qa.test"));
      return { botId: report.botId, modelCalls: 0, nodeStarted: false };
    },
  );
  await check(
    "reload and offline reconnect preserve the actual home subject and an independent DM draft",
    async () => {
      await page.locator("#message-input").fill("Offline real central draft");
      await page.waitForTimeout(220);
      await page.reload();
      await page.waitForFunction(
        () =>
          document.querySelector("#message-input").textContent ===
          "Offline real central draft",
      );
      assert.equal(
        (await currentSession()).identity.subjectId,
        report.identity.subjectId,
      );
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      await page.waitForFunction(() => navigator.serviceWorker.controller);
      await context.setOffline(true);
      await page.reload();
      await page.waitForFunction(
        () =>
          document.querySelector("#message-input").textContent ===
          "Offline real central draft",
      );
      assert.equal(await page.locator("#send-button").isDisabled(), true);
      await context.setOffline(false);
      await page.waitForFunction(
        () =>
          document.querySelector("#connection-text").textContent ===
          "Connected",
      );
      assert.equal(
        (await currentSession()).identity.subjectId,
        report.identity.subjectId,
      );
      return { sameSubject: true, offlineDraft: true, reconnect: true };
    },
  );
  await check(
    "logout revokes only this real browser device and password login returns the same subject",
    async () => {
      const oldToken = privateState.session.access_token;
      await page.locator("#settings-button").click();
      await page.locator("#logout-button").click();
      await page.locator("#login-dialog[open]").waitFor();
      assert.equal(
        (
          await fetch(matrixUrl + "/_matrix/client/v3/account/whoami", {
            headers: { Authorization: `Bearer ${oldToken}` },
          })
        ).status,
        401,
      );
      await page.locator("#login-user").fill("alice");
      await page.locator("#login-password").fill(privateState.password);
      await page.locator("#login-submit").click();
      await page.locator("#login-dialog").waitFor({ state: "hidden" });
      await page
        .locator("#owned-bots .contact-row")
        .filter({ hasText: "QA Helper" })
        .waitFor();
      const next = await currentSession();
      assert.equal(next.identity.subjectId, report.identity.subjectId);
      assert.notEqual(next.access_token, oldToken);
      assert.ok(
        credentialRequests.length > 0 &&
          credentialRequests.every((request) => request.origin === coreUrl),
      );
      assert.deepEqual(pageErrors, []);
      return {
        previousDeviceRevoked: true,
        sameSubject: true,
        credentialOrigins: [
          ...new Set(credentialRequests.map((request) => request.origin)),
        ],
        pageErrors,
      };
    },
  );
  await page.screenshot({ path: path.join(directory, "desktop.png") });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  if (privateState.session?.access_token) {
    try {
      const headers = {
        Authorization: `Bearer ${privateState.session.access_token}`,
      };
      const read = async (route) => {
        const response = await fetch(coreUrl + route, { headers });
        return { status: response.status, body: await response.json() };
      };
      const listed = await read("/api/rooms");
      const spaces = await read("/api/spaces");
      const matrix = new MatrixClient({
        baseUrl: matrixUrl,
        accessToken: privateState.session.access_token,
      });
      const sync = await matrix.sync();
      const states = [];
      for (const room of listed.body.rooms ?? []) {
        const state = await matrix.request(
          "GET",
          `/_matrix/client/v3/rooms/${encodeURIComponent(room.roomId)}/state`,
        );
        states.push({
          roomId: room.roomId,
          createEvents: state
            .filter((event) => event.type === "m.room.create")
            .map((event) => ({ sender: event.sender, content: event.content })),
        });
      }
      report.failureDiagnostics = {
        listed,
        spaces,
        matrixSyncJoinedRoomIds: Object.keys(sync.rooms?.join ?? {}),
        states,
      };
    } catch (diagnosticError) {
      report.failureDiagnostics = { error: diagnosticError.message };
    }
  }

  if (page)
    await page
      .screenshot({ path: path.join(directory, "failure.png") })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (staticServer) {
    staticServer.closeAllConnections();
    await new Promise((resolve) => staticServer.close(resolve));
  }
  if (core && core.exitCode === null)
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        report.forcedCoreStop = true;
        core.kill("SIGKILL");
      }, 12000);
      core.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      core.kill("SIGTERM");
    });
  await writeFile(path.join(directory, "core.log"), coreLog);
  if (containerStarted) {
    await execute("docker", ["rm", "--force", containerName], {
      timeout: 30000,
    });
    report.containerStopped = true;
  }
  report.finishedAt = new Date().toISOString();
  report.pageErrors = pageErrors;
  await save();
  console.log(
    JSON.stringify({
      status: report.status,
      report: reportPath,
      checks: report.checks.length,
      modelCalls: 0,
    }),
  );
}
