import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { packageRoot } from "../src/paths.mjs";
import { MatrixClient } from "../src/matrix-client.mjs";

const { values } = parseArgs({
  options: { "data-root": { type: "string" }, report: { type: "string" } },
});
const root = path.resolve(
  values["data-root"] ||
    path.join(packageRoot, ".local/federation-lab/dscord-federation"),
);
const lab = JSON.parse(await readFile(path.join(root, "lab.json"), "utf8"));
const [a, b] = lab.servers;
const reportPath = path.resolve(
  values.report ||
    path.join(
      packageRoot,
      "artifacts/governance",
      `spaces-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    ),
);
const report = {
  startedAt: new Date().toISOString(),
  scope:
    "Real Core and Matrix normal room APIs, three-server isolated fixture; zero model calls",
  status: "running",
  collaborationSha256: createHash("sha256")
    .update(await readFile(path.join(packageRoot, "src/collaboration.mjs")))
    .digest("hex"),
  checks: [],
};
async function api(
  server,
  route,
  token,
  body,
  method = body === undefined ? "GET" : "POST",
  admin = false,
) {
  const response = await fetch(
    new URL(route, admin ? server.adminUrl : server.coreUrl),
    {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const value = await response.json();
  assert.equal(
    response.status,
    200,
    `${route}: ${response.status} ${value.error || ""}`,
  );
  return value;
}
let original;
let restoreRevision;
let adminToken;
try {
  a.setup = JSON.parse(
    await readFile(path.join(a.dataRoot, "matrix-setup.json"), "utf8"),
  );
  b.setup = JSON.parse(
    await readFile(path.join(b.dataRoot, "matrix-setup.json"), "utf8"),
  );
  const alice = a.setup.participants.find(
    (person) => person.localpart === "alice",
  );
  const bobHome = b.setup.participants.find(
    (person) => person.localpart === "alice",
  );
  const matrix = new MatrixClient({
    baseUrl: a.matrixUrl,
    accessToken: alice.accessToken,
  });
  await matrix.sync({ timeout: 0 });
  const created = await api(a, "/api/rooms", alice.accessToken, {
    name: `Spaces regression ${randomBytes(5).toString("hex")}`,
    inviteIds: [],
    requestId: `spaces-${randomBytes(8).toString("hex")}`,
  });
  const [joined, sync, rooms, spaces] = await Promise.all([
    matrix.request("GET", "/_matrix/client/v3/joined_rooms"),
    matrix.sync({ timeout: 0 }),
    api(a, "/api/rooms", alice.accessToken),
    api(a, "/api/spaces", alice.accessToken),
  ]);
  assert.ok(joined.joined_rooms.includes(created.roomId));
  assert.ok(rooms.rooms.some((room) => room.roomId === created.roomId));
  const displayed = spaces.spaces
    .find((space) => space.home)
    ?.rooms.find((room) => room.roomId === created.roomId);
  assert.ok(displayed);
  assert.equal(displayed.canSend, true);
  report.checks.push({
    name: "new room created through normal API appears in actual joined rooms and spaces",
    status: "passed",
    roomId: created.roomId,
    singleSyncIncludedNewRoom: Boolean(sync.rooms?.join?.[created.roomId]),
    displayed,
  });
  const credentials = JSON.parse(
    await readFile(path.join(b.dataRoot, "lab-administrator.json"), "utf8"),
  );
  adminToken = (
    await api(b, "/admin-api/login", null, credentials, "POST", true)
  ).access_token;
  original = (
    await api(b, "/admin-api/policy", adminToken, undefined, "GET", true)
  ).policy;
  const foreignRoom = original.rooms.find(
    (room) => room.authority === a.serverName,
  );
  assert.ok(foreignRoom);
  const disabled = await api(
    b,
    "/admin-api/policy",
    adminToken,
    {
      ...original,
      rooms: original.rooms.map((room) =>
        room.roomId === foreignRoom.roomId ? { ...room, enabled: false } : room,
      ),
    },
    "PUT",
    true,
  );
  restoreRevision = disabled.policy.revision;
  const restricted = (await api(b, "/api/spaces", bobHome.accessToken)).spaces
    .find((space) => space.serverName === a.serverName)
    ?.rooms.find((room) => room.roomId === foreignRoom.roomId);
  assert.ok(restricted);
  assert.equal(restricted.canSend, false);
  assert.equal(restricted.status, "restricted");
  report.checks.push({
    name: "actual joined foreign room remains restricted after local room revocation",
    status: "passed",
    room: restricted,
  });
  const restored = await api(
    b,
    "/admin-api/policy",
    adminToken,
    { ...original, revision: restoreRevision },
    "PUT",
    true,
  );
  restoreRevision = undefined;
  assert.ok(
    restored.policy.rooms.find((room) => room.roomId === foreignRoom.roomId)
      .enabled,
  );
  const enabled = (await api(b, "/api/spaces", bobHome.accessToken)).spaces
    .find((space) => space.serverName === a.serverName)
    ?.rooms.find((room) => room.roomId === foreignRoom.roomId);
  assert.equal(enabled.canSend, true);
  report.checks.push({
    name: "explicit reapproval restores the current joined association",
    status: "passed",
    room: enabled,
  });
  const statuses = await Promise.all(
    lab.servers.map((server) => api(server, "/api/status")),
  );
  assert.ok(statuses.every((status) => status.budget.used === 0));
  report.modelCalls = 0;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  throw error;
} finally {
  if (restoreRevision !== undefined) {
    const current = (
      await api(b, "/admin-api/policy", adminToken, undefined, "GET", true)
    ).policy;
    if (current.revision === restoreRevision)
      await api(
        b,
        "/admin-api/policy",
        adminToken,
        { ...original, revision: restoreRevision },
        "PUT",
        true,
      );
    else
      report.restore =
        "Skipped because another administrator changed the policy";
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      reportPath,
      status: report.status,
      checks: report.checks.length,
    }),
  );
}
