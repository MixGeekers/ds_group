#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { initializeServer } from "./server-init.mjs";
import { bootstrapServer } from "./server-bootstrap.mjs";
import { packageRoot } from "../src/paths.mjs";
import { Governance, privateJson } from "../src/governance.mjs";
import { MatrixClient } from "../src/matrix-client.mjs";
import { AdminAuth } from "../src/admin-auth.mjs";

const execute = promisify(execFile);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "data-root": { type: "string" },
    project: { type: "string", default: "dscord-federation" },
    "port-base": { type: "string", default: "24100" },
    report: { type: "string" },
  },
});
const [command = "status"] = positionals;
const project = values.project;
assert.match(
  project,
  /^[a-z][a-z0-9-]{2,40}$/,
  "Use an isolated Docker project name",
);
const basePort = Number(values["port-base"]);
assert.ok(
  Number.isInteger(basePort) && basePort >= 1024 && basePort <= 65475,
  "Invalid port base",
);
const root = path.resolve(
  values["data-root"] ||
    path.join(packageRoot, ".local/federation-lab", project),
);
const statePath = path.join(root, "lab.json");
const image =
  "ghcr.io/element-hq/synapse@sha256:f0df87cff259872637b4b5e5174b9977e5e3046dd421505407803b5e45c5f842";
const label = "org.dscord.federation-lab";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const optional = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
};
const docker = async (args) =>
  (
    await execute("docker", args, {
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();
await mkdir(root, { recursive: true, mode: 0o700 });
let state = await optional(statePath);
if (
  state &&
  (state.project !== project ||
    state.portBase !== basePort ||
    state.root !== root)
)
  throw new Error(
    "Existing lab identity differs; use its original project, directory and port base",
  );
state ||= {
  schemaVersion: 1,
  project,
  portBase: basePort,
  root,
  network: `${project}-network`,
  servers: ["a", "b", "c"].map((name, index) => ({
    name,
    serverName: `${name}.${project}.test:8448`,
    container: `${project}-${name}`,
    dataRoot: path.join(root, name, "core"),
    synapseRoot: path.join(root, name, "synapse"),
    coreUrl: `http://127.0.0.1:${basePort + index * 20}`,
    matrixUrl: `http://127.0.0.1:${basePort + index * 20 + 8}`,
    adminUrl: `http://127.0.0.1:${basePort + index * 20 + 10}`,
  })),
};
const saveState = () => privateJson(statePath, state);
const endpoints = () => ({
  project,
  dataRoot: root,
  physicalHosts: 1,
  topology:
    "three independent Synapse containers, Core processes and administration processes; private TLS federation on an isolated Docker network",
  servers: state.servers.map(
    ({ name, serverName, coreUrl, matrixUrl, adminUrl }) => ({
      name,
      serverName,
      coreUrl,
      matrixUrl,
      adminUrl,
    }),
  ),
  commands: {
    up: `node scripts/federation-lab.mjs up --project ${project} --port-base ${basePort} --data-root '${root}'`,
    verify: `node scripts/federation-lab.mjs verify --project ${project} --port-base ${basePort} --data-root '${root}'`,
    down: `node scripts/federation-lab.mjs down --project ${project} --port-base ${basePort} --data-root '${root}'`,
  },
});

async function inspectOwned(name, network = false) {
  try {
    const [item] = JSON.parse(
      await docker([...(network ? ["network"] : []), "inspect", name]),
    );
    const owner = network ? item.Labels?.[label] : item.Config?.Labels?.[label];
    if (owner !== root)
      throw new Error(
        `Refusing to modify an unrelated Docker resource: ${name}`,
      );
    return item;
  } catch (error) {
    if (
      /no such (object|container|network)|network [^\n]+ not found/i.test(
        error.stderr || "",
      )
    )
      return null;
    throw error;
  }
}
async function waitReady(url, milliseconds = 90000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1500),
        redirect: "error",
      });
      if (response.ok) return;
    } catch {}
    await delay(300);
  }
  throw new Error(`Service did not become ready: ${url}`);
}
async function portFree(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}
async function startProcess(server, kind) {
  const pidKey = `${kind}Pid`;
  if (server[pidKey]) {
    try {
      process.kill(server[pidKey], 0);
      throw new Error(
        `Existing ${kind} process is still running; use status or down first`,
      );
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  }
  const url = new URL(kind === "core" ? server.coreUrl : server.adminUrl);
  await portFree(Number(url.port));
  const logfile = await open(
    path.join(root, server.name, `${kind}.log`),
    "a",
    0o600,
  );
  const child = spawn(
    process.execPath,
    [
      kind === "core" ? "src/core.mjs" : "src/admin.mjs",
      "--federation-lab-root",
      root,
      "--federation-lab-server",
      server.name,
    ],
    {
      cwd: packageRoot,
      detached: true,
      stdio: ["ignore", logfile.fd, logfile.fd],
      env: {
        ...process.env,
        DS_GROUP_DATA_DIR: server.dataRoot,
        DS_GROUP_GOVERNANCE_DIR: path.join(server.dataRoot, "governance"),
        DS_GROUP_MATRIX_URL: server.matrixUrl,
        DS_GROUP_SYNAPSE_DIR: server.synapseRoot,
        DS_GROUP_PORT: new URL(server.coreUrl).port,
        DS_GROUP_HOST: "127.0.0.1",
        DS_GROUP_DEMO_LOGIN: "false",
        DS_GROUP_ADMIN_PORT: new URL(server.adminUrl).port,
        DS_GROUP_ADMIN_HOST: "127.0.0.1",
      },
    },
  );
  child.unref();
  server[pidKey] = child.pid;
  await saveState();
  await logfile.close();
  await waitReady(`${url.origin}/healthz`);
}
async function up() {
  if (!(await inspectOwned(state.network, true)))
    await docker([
      "network",
      "create",
      "--label",
      `${label}=${root}`,
      state.network,
    ]);
  await saveState();
  const ca = path.join(root, "ca.pem");
  try {
    await readFile(ca);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    await createTestCA();
  }
  for (const server of state.servers) {
    const options = {
      dataRoot: server.dataRoot,
      synapseRoot: server.synapseRoot,
      serverName: server.serverName,
      homeserverUrl: server.matrixUrl,
      publicHomeserverUrl: server.matrixUrl,
      publicUrl: server.coreUrl,
    };
    await initializeServer(options, { containerOwnership: false });
    await execute("openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(server.synapseRoot, "tls.key"),
      "-out",
      path.join(server.synapseRoot, "tls.csr"),
      "-subj",
      `/CN=${server.serverName.split(":")[0]}`,
    ]);
    await writeFile(
      path.join(server.synapseRoot, "tls.ext"),
      certificateExtensions(server),
    );
    await execute("openssl", [
      "x509",
      "-req",
      "-in",
      path.join(server.synapseRoot, "tls.csr"),
      "-CA",
      ca,
      "-CAkey",
      path.join(root, "ca.key"),
      "-CAcreateserial",
      "-out",
      path.join(server.synapseRoot, "tls.pem"),
      "-days",
      "30",
      "-extfile",
      path.join(server.synapseRoot, "tls.ext"),
    ]);
    await writeFile(
      path.join(server.synapseRoot, "ca.pem"),
      await readFile(ca),
    );
    const configFile = path.join(server.synapseRoot, "homeserver.yaml");
    const config = JSON.parse(await readFile(configFile, "utf8"));
    Object.assign(config, {
      tls_certificate_path: "/data/tls.pem",
      tls_private_key_path: "/data/tls.key",
      federation_custom_ca_list: ["/data/ca.pem"],
      federation_ip_range_blacklist: [],
    });
    config.listeners.push({
      port: 8448,
      tls: true,
      type: "http",
      bind_addresses: ["0.0.0.0"],
      resources: [{ names: ["federation"], compress: false }],
    });
    await privateJson(configFile, config);
    const existing = await inspectOwned(server.container);
    if (!existing) {
      await portFree(Number(new URL(server.matrixUrl).port));
      await docker([
        "create",
        "--name",
        server.container,
        "--label",
        `${label}=${root}`,
        "--network",
        state.network,
        "--network-alias",
        server.serverName.split(":")[0],
        "-p",
        `127.0.0.1:${new URL(server.matrixUrl).port}:8008`,
        "-v",
        `${server.synapseRoot}:/data`,
        "-v",
        `${path.join(server.dataRoot, "governance")}:/dscord-policy`,
        "-e",
        "UID=0",
        "-e",
        "GID=0",
        "-e",
        "PYTHONPATH=/data",
        image,
        "run",
        "-m",
        "synapse.app.homeserver",
        "--config-path=/data/homeserver.yaml",
        "--config-path=/data/governance.generated.yaml",
      ]);
    }
    await docker(["start", server.container]);
    await waitReady(`${server.matrixUrl}/_matrix/client/versions`);
    await bootstrapServer(options);
    const auth = await new AdminAuth(server.dataRoot).initialize();
    try {
      if (!auth.list().length) {
        const password = randomBytes(32).toString("base64url");
        await auth.change(
          "lab-console",
          { username: "admin", password, role: "owner", enabled: true },
          { bootstrap: true },
        );
        await privateJson(
          path.join(server.dataRoot, "lab-administrator.json"),
          { username: "admin", password },
        );
      }
    } finally {
      auth.close();
    }
    await startProcess(server, "core");
    await startProcess(server, "admin");
  }
  await privateJson(path.join(root, "endpoints.json"), endpoints());
  console.log(JSON.stringify(endpoints(), null, 2));
}

function certificateExtensions(server) {
  return `subjectAltName=DNS:${server.serverName.split(":")[0]}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`;
}
async function createTestCA() {
  const config = path.join(root, "ca.cnf");
  await writeFile(
    config,
    "[req]\ndistinguished_name=dn\nx509_extensions=v3_ca\nprompt=no\n[dn]\nCN=DSCord isolated federation test CA\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always,issuer\n",
  );
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path.join(root, "ca.key"),
    "-out",
    path.join(root, "ca.pem"),
    "-days",
    "30",
    "-config",
    config,
  ]);
}
async function refreshTls() {
  await createTestCA();
  for (const server of state.servers) {
    if (!(await inspectOwned(server.container)))
      throw new Error("Start the lab before updating its test certificates");
    await writeFile(
      path.join(server.synapseRoot, "tls.ext"),
      certificateExtensions(server),
    );
    await execute("openssl", [
      "x509",
      "-req",
      "-in",
      path.join(server.synapseRoot, "tls.csr"),
      "-CA",
      path.join(root, "ca.pem"),
      "-CAkey",
      path.join(root, "ca.key"),
      "-CAcreateserial",
      "-out",
      path.join(server.synapseRoot, "tls.pem"),
      "-days",
      "30",
      "-extfile",
      path.join(server.synapseRoot, "tls.ext"),
    ]);
    await copyFile(
      path.join(root, "ca.pem"),
      path.join(server.synapseRoot, "ca.pem"),
    );
    await docker(["restart", "--time", "20", server.container]);
    await waitReady(`${server.matrixUrl}/_matrix/client/versions`);
  }
}
async function down() {
  for (const server of state.servers) {
    for (const kind of ["admin", "core"]) {
      const key = `${kind}Pid`;
      if (server[key]) {
        // Verify this PID's command before touching it; stale PID files cannot kill unrelated work.
        try {
          const { stdout } = await execute("ps", [
            "eww",
            "-p",
            String(server[key]),
            "-o",
            "command=",
          ]);
          if (
            !stdout.includes(
              kind === "core" ? "src/core.mjs" : "src/admin.mjs",
            ) ||
            !stdout.includes(`DS_GROUP_DATA_DIR=${server.dataRoot}`)
          )
            throw new Error(`Refusing to stop unrelated PID ${server[key]}`);
          process.kill(server[key], "SIGTERM");
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            try {
              process.kill(server[key], 0);
            } catch (e) {
              if (e.code === "ESRCH") break;
              throw e;
            }
            await delay(100);
          }
          try {
            process.kill(server[key], 0);
            throw new Error(
              `Process ${server[key]} did not stop within 15 seconds`,
            );
          } catch (e) {
            if (e.code !== "ESRCH") throw e;
          }
        } catch (e) {
          if (e.code !== "ESRCH" && e.code !== 1) throw e;
        }
        delete server[key];
        await saveState();
      }
    }
    if (await inspectOwned(server.container)) {
      await docker(["stop", "--time", "20", server.container]);
      await docker(["rm", server.container]);
    }
  }
  if (await inspectOwned(state.network, true))
    await docker(["network", "rm", state.network]);
  console.log(JSON.stringify({ status: "stopped", retainedDataRoot: root }));
}

async function reload() {
  for (const server of state.servers)
    for (const kind of ["admin", "core"]) {
      const key = `${kind}Pid`;
      if (server[key]) {
        try {
          const { stdout } = await execute("ps", [
            "eww",
            "-p",
            String(server[key]),
            "-o",
            "command=",
          ]);
          if (
            !stdout.includes(
              kind === "core" ? "src/core.mjs" : "src/admin.mjs",
            ) ||
            !stdout.includes(`DS_GROUP_DATA_DIR=${server.dataRoot}`)
          )
            throw new Error("Process identity mismatch");
          process.kill(server[key], "SIGTERM");
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            try {
              process.kill(server[key], 0);
            } catch (e) {
              if (e.code === "ESRCH") break;
              throw e;
            }
            await delay(100);
          }
          try {
            process.kill(server[key], 0);
            throw new Error("Service did not drain");
          } catch (e) {
            if (e.code !== "ESRCH") throw e;
          }
        } catch (e) {
          if (e.code !== "ESRCH" && e.code !== 1) throw e;
        }
        delete server[key];
        await saveState();
      }
      await startProcess(server, kind);
    }
  console.log(
    JSON.stringify({ status: "services-reloaded", endpoints: endpoints() }),
  );
}

async function refreshGuard() {
  for (const server of state.servers) {
    if (!(await inspectOwned(server.container)))
      throw new Error("Start the lab before updating its guard");
    await copyFile(
      path.join(packageRoot, "deploy/synapse/dscord_guard.py"),
      path.join(server.synapseRoot, "dscord_guard.py"),
    );
    await docker(["restart", "--time", "20", server.container]);
    await waitReady(`${server.matrixUrl}/_matrix/client/versions`);
  }
}

async function verify() {
  const reportFile = path.resolve(
    values.report ||
      path.join(
        packageRoot,
        "artifacts/governance",
        `federation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      ),
  );
  const report = {
    startedAt: new Date().toISOString(),
    status: "running",
    level:
      "real Synapse/Core/administration, private CA-verified TLS federation, one physical Docker host",
    modelCalls: 0,
    endpoints: endpoints(),
    checks: [],
    sourceSha256: {},
  };
  for (const name of [
    "src/core.mjs",
    "src/collaboration.mjs",
    "src/governance.mjs",
    "src/synapse-control.mjs",
    "deploy/synapse/dscord_guard.py",
    "scripts/federation-lab.mjs",
  ])
    report.sourceSha256[name] = digest(
      await readFile(path.join(packageRoot, name)),
    );
  const save = async () => {
    await mkdir(path.dirname(reportFile), { recursive: true });
    await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  };
  const check = async (name, work) => {
    console.log(`Checking ${name}`);
    try {
      const details = await work();
      report.checks.push({ name, status: "passed", details });
    } catch (error) {
      report.checks.push({ name, status: "failed", error: error.message });
      throw error;
    } finally {
      await save();
    }
  };
  const api = async (
    server,
    route,
    {
      token,
      body,
      method = body === undefined ? "GET" : "POST",
      expected = 200,
      admin = false,
    } = {},
  ) => {
    const response = await fetch(
      new URL(route, admin ? server.adminUrl : server.coreUrl),
      {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const data = await response.json();
    assert.equal(
      response.status,
      expected,
      `${route}: HTTP ${response.status}, expected ${expected}; ${data.error || ""}`,
    );
    return data;
  };
  const servers = state.servers;
  try {
    for (const server of servers) {
      server.setup = await optional(
        path.join(server.dataRoot, "matrix-setup.json"),
      );
      assert.ok(server.setup, "Run up before verify");
      server.alice = server.setup.participants.find(
        (row) => row.localpart === "alice",
      );
      server.bob = server.setup.participants.find(
        (row) => row.localpart === "bob",
      );
      server.client = new MatrixClient({
        baseUrl: server.matrixUrl,
        accessToken: server.alice.accessToken,
      });
      const credentials = await optional(
        path.join(server.dataRoot, "lab-administrator.json"),
      );
      server.adminToken = (
        await api(server, "/admin-api/login", {
          body: credentials,
          admin: true,
        })
      ).access_token;
      server.policy = (
        await api(server, "/admin-api/policy", {
          token: server.adminToken,
          admin: true,
        })
      ).policy;
    }
    report.runtime = {};
    for (const server of servers) {
      const current = await api(server, "/api/status");
      const guard = await (
        await fetch(
          new URL(
            "/_synapse/client/dscord-governance/status",
            server.matrixUrl,
          ),
          { redirect: "error" },
        )
      ).json();
      assert.equal(
        current.core.loadedCoreSha256,
        report.sourceSha256["src/core.mjs"],
      );
      assert.equal(
        guard.sourceSha256,
        report.sourceSha256["deploy/synapse/dscord_guard.py"],
      );
      assert.equal(current.budget.used, 0);
      report.runtime[server.name] = {
        loadedCoreSha256: current.core.loadedCoreSha256,
        guardSourceSha256: guard.sourceSha256,
        guardBootId: guard.bootId,
        modelCalls: current.budget.used,
      };
    }
    const [a, b, c] = servers;
    const roomId = a.setup.roomId;
    const savePolicy = async (server, input) => {
      const value = await api(server, "/admin-api/policy", {
        token: server.adminToken,
        admin: true,
        method: "PUT",
        body: { ...input, revision: server.policy.revision },
      });
      server.policy = value.policy;
      return value;
    };
    const apply = (server) =>
      api(server, "/admin-api/apply", {
        token: server.adminToken,
        admin: true,
        body: { revision: server.policy.revision },
      });
    const restart = async (server) => {
      await inspectOwned(server.container);
      await docker(["restart", "--time", "20", server.container]);
      await waitReady(`${server.matrixUrl}/_matrix/client/versions`);
    };
    const poll = async (work) => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const value = await work();
        if (value) return value;
        await delay(300);
      }
      throw new Error("Federation observation timed out");
    };
    await check(
      "ordinary chat, room creator and foreign administration sessions cannot administer this instance",
      async () => {
        await api(a, "/admin-api/policy", {
          token: a.alice.accessToken,
          admin: true,
          expected: 401,
        });
        await api(a, "/admin-api/policy", {
          token: b.adminToken,
          admin: true,
          expected: 401,
        });
        await api(a, "/admin-api/policy", {
          token: a.adminToken,
          expected: 404,
        });
        return {
          chatRejected: true,
          roomCreatorRejected: true,
          foreignAdminRejected: true,
        };
      },
    );
    await check(
      "A/B explicit partner, identity and room rules save and apply separately from network restart",
      async () => {
        const external = (server) => ({
          id: server.alice.id,
          name: `Alice ${server.name}`,
          kind: "human",
          enabled: true,
        });
        await savePolicy(a, {
          ...a.policy,
          partners: [
            { serverName: b.serverName, name: "Partner B", enabled: true },
          ],
          members: [external(b)],
          rooms: [
            {
              roomId,
              authority: a.serverName,
              name: "Shared A/B",
              enabled: true,
              memberIds: [b.alice.id],
              tools: [],
              botIds: [],
            },
          ],
        });
        await savePolicy(b, {
          ...b.policy,
          partners: [
            { serverName: a.serverName, name: "Partner A", enabled: true },
          ],
          members: [external(a)],
          rooms: [
            {
              roomId,
              authority: a.serverName,
              name: "Shared A/B",
              enabled: true,
              memberIds: [b.alice.id],
              tools: [],
              botIds: [],
            },
          ],
        });
        for (const server of [a, b]) {
          const result = await apply(server);
          assert.equal(
            result.application.status,
            "prepared",
            JSON.stringify(result.application),
          );
          await poll(async () => {
            const observed = await api(server, "/admin-api/policy", {
              token: server.adminToken,
              admin: true,
            });
            return (
              observed.application.livePolicyObserved &&
              observed.application.savedRevision === server.policy.revision
            );
          });
        }
        for (const server of [a, b]) {
          await restart(server);
          const current = await api(server, "/admin-api/policy", {
            token: server.adminToken,
            admin: true,
          });
          assert.equal(current.application.restartRequired, false);
          assert.equal(current.application.livePolicyObserved, true);
        }
        return {
          roomId,
          participants: [a.alice.id, b.alice.id],
          staticRestartObserved: true,
        };
      },
    );
    await check(
      "home identity receives a real foreign invitation and joins without a shadow account",
      async () => {
        if (
          (
            await b.client.request("GET", "/_matrix/client/v3/joined_rooms")
          ).joined_rooms.includes(roomId)
        ) {
          await b.client.request(
            "POST",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
            {},
          );
          await poll(
            async () =>
              !(
                await a.client.request(
                  "GET",
                  `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
                )
              ).joined[b.alice.id],
          );
        }
        await api(a, `/api/rooms/${encodeURIComponent(roomId)}/invite`, {
          token: a.alice.accessToken,
          body: { participantId: b.alice.id },
        });
        const invitation = await poll(async () => {
          const result = await api(b, "/api/spaces", {
            token: b.alice.accessToken,
          });
          return result.spaces
            .find((row) => row.serverName === a.serverName)
            ?.invitations.find((row) => row.roomId === roomId && row.canJoin);
        });
        await api(b, `/api/rooms/${encodeURIComponent(roomId)}/join`, {
          token: b.alice.accessToken,
          body: {},
        });
        const joined = await a.client.request(
          "GET",
          `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
        );
        assert.ok(joined.joined[b.alice.id]);
        assert.equal((await b.client.whoami()).user_id, b.alice.id);
        const repeated = await api(
          a,
          `/api/rooms/${encodeURIComponent(roomId)}/invite`,
          { token: a.alice.accessToken, body: { participantId: b.alice.id } },
        );
        assert.equal(repeated.status, "joined");
        return { invitation, joinedIdentity: b.alice.id };
      },
    );
    await check(
      "two-way Core text and attachment bytes traverse the authenticated home federation",
      async () => {
        const receipts = [];
        for (const [source, target] of [
          [a, b],
          [b, a],
        ]) {
          const body = `Federation ${source.name} to ${target.name} ${randomBytes(6).toString("hex")}`;
          const transactionId = `federation-${digest(body).slice(0, 20)}`;
          const first = await api(
            source,
            `/api/rooms/${encodeURIComponent(roomId)}/messages`,
            { token: source.alice.accessToken, body: { body, transactionId } },
          );
          const repeat = await api(
            source,
            `/api/rooms/${encodeURIComponent(roomId)}/messages`,
            { token: source.alice.accessToken, body: { body, transactionId } },
          );
          assert.equal(first.event_id, repeat.event_id);
          await poll(async () =>
            (await target.client.timeline(roomId, 100)).find(
              (event) =>
                event.event_id === first.event_id &&
                event.sender === source.alice.id,
            ),
          );
          const bytes = Buffer.from(
            `synthetic attachment from ${source.name}\n${body}\n`,
          );
          const uploaded = await source.client.uploadMedia(bytes, {
            filename: `${source.name}.txt`,
            mimeType: "text/plain",
            size: bytes.length,
          });
          const media = await source.client.send(roomId, "Shared attachment", {
            transactionId: `${transactionId}-file`,
            attachments: [
              {
                id: `attachment-${randomBytes(16).toString("hex")}`,
                name: `${source.name}.txt`,
                mimeType: "text/plain",
                size: bytes.length,
                sha256: digest(bytes),
                contentUri: uploaded.content_uri,
              },
            ],
          });
          await poll(async () =>
            (await target.client.timeline(roomId, 100)).find(
              (event) => event.event_id === media.event_id,
            ),
          );
          const response = await target.client.downloadMedia(
            uploaded.content_uri,
          );
          assert.equal(
            digest(Buffer.from(await response.arrayBuffer())),
            digest(bytes),
          );
          receipts.push({
            source: source.alice.id,
            target: target.alice.id,
            eventId: first.event_id,
            attachmentEventId: media.event_id,
            sha256: digest(bytes),
            duplicateEventId: repeat.event_id,
          });
        }
        return receipts;
      },
    );
    await check(
      "direct Matrix API cannot admit an unapproved partner member or unlisted third server, or relax room rules",
      async () => {
        await assert.rejects(
          a.client.request(
            "POST",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
            { user_id: b.bob.id },
          ),
          { status: 403 },
        );
        await assert.rejects(
          a.client.request(
            "POST",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
            { user_id: c.alice.id },
          ),
          { status: 403 },
        );
        const unapproved = new MatrixClient({
          baseUrl: b.matrixUrl,
          accessToken: b.bob.accessToken,
        });
        await assert.rejects(
          unapproved.request(
            "POST",
            `/_matrix/client/v3/join/${encodeURIComponent(roomId)}?server_name=${encodeURIComponent(a.serverName)}`,
            {},
          ),
          { status: 403 },
        );
        await assert.rejects(
          c.client.request(
            "POST",
            `/_matrix/client/v3/join/${encodeURIComponent(roomId)}?server_name=${encodeURIComponent(a.serverName)}`,
            {},
          ),
          { status: 403 },
        );
        await assert.rejects(
          a.client.request(
            "PUT",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.server_acl/`,
            { allow: ["*"], deny: [], allow_ip_literals: true },
          ),
          { status: 403 },
        );
        await assert.rejects(
          a.client.request(
            "PUT",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.join_rules/`,
            { join_rule: "public" },
          ),
          { status: 403 },
        );
        return {
          unapprovedMember: b.bob.id,
          thirdServerIdentity: c.alice.id,
          bypassesRejected: 6,
        };
      },
    );
    await check(
      "A rejects an actual C-signed federation request over validated TLS",
      async () => {
        const input = JSON.stringify({
          origin: c.serverName,
          destination: a.serverName,
          roomId,
          userId: c.alice.id,
        });
        const code = `import json,ssl,urllib.request,urllib.error,urllib.parse\nfrom signedjson.key import read_signing_keys\nfrom signedjson.sign import sign_json\nx=json.loads(${JSON.stringify(input)})\nuri='/_matrix/federation/v1/make_join/'+urllib.parse.quote(x['roomId'],safe='')+'/'+urllib.parse.quote(x['userId'],safe='')+'?ver=12'\nkey=read_signing_keys(open('/data/signing.key'))[0]\nsigned=sign_json({'method':'GET','uri':uri,'origin':x['origin'],'destination':x['destination']},x['origin'],key)\nk,s=next(iter(signed['signatures'][x['origin']].items()))\nauth='X-Matrix origin="'+x['origin']+'",destination="'+x['destination']+'",key="'+k+'",sig="'+s+'"'\nrequest=urllib.request.Request('https://'+x['destination']+uri,headers={'Authorization':auth})\ntry:\n r=urllib.request.urlopen(request,context=ssl.create_default_context(cafile='/data/ca.pem'),timeout=15);print(json.dumps({'status':r.status}))\nexcept urllib.error.HTTPError as e:\n body=json.loads(e.read());print(json.dumps({'status':e.code,'errcode':body.get('errcode'),'error':body.get('error')}))`;
        const result = JSON.parse(
          await docker(["exec", c.container, "python", "-c", code]),
        );
        assert.equal(result.status, 403);
        return { origin: c.serverName, destination: a.serverName, ...result };
      },
    );
    await check(
      "remote server outage recovers room events with unchanged home identities and transaction IDs",
      async () => {
        await inspectOwned(b.container);
        await docker(["stop", "--time", "20", b.container]);
        const transactionId = `offline-${randomBytes(8).toString("hex")}`;
        const payload = {
          body: "Synthetic message while B is offline",
          transactionId,
        };
        const receipt = await api(
          a,
          `/api/rooms/${encodeURIComponent(roomId)}/messages`,
          { token: a.alice.accessToken, body: payload },
        );
        await docker(["start", b.container]);
        await waitReady(`${b.matrixUrl}/_matrix/client/versions`);
        await poll(async () =>
          (await b.client.timeline(roomId, 100)).find(
            (event) => event.event_id === receipt.event_id,
          ),
        );
        const repeated = await api(
          a,
          `/api/rooms/${encodeURIComponent(roomId)}/messages`,
          { token: a.alice.accessToken, body: payload },
        );
        assert.equal(repeated.event_id, receipt.event_id);
        assert.equal((await b.client.whoami()).user_id, b.alice.id);
        return { eventId: receipt.event_id, recoveredIdentity: b.alice.id };
      },
    );
    await check(
      "member revocation applies a real ban and rejects subsequent direct Matrix sends",
      async () => {
        await savePolicy(a, {
          ...a.policy,
          members: a.policy.members.map((row) =>
            row.id === b.alice.id ? { ...row, enabled: false } : row,
          ),
        });
        const result = await apply(a);
        const room = result.application.rooms.find(
          (row) => row.roomId === roomId,
        );
        assert.equal(room.status, "applied", JSON.stringify(room));
        assert.ok(
          room.bans.some(
            (row) => row.id === b.alice.id && row.status === "applied",
          ),
        );
        await poll(
          async () =>
            !(
              await b.client.request("GET", "/_matrix/client/v3/joined_rooms")
            ).joined_rooms.includes(roomId),
        );
        await assert.rejects(
          b.client.send(roomId, "Must not be delivered after revocation", {
            transactionId: `denied-${randomBytes(6).toString("hex")}`,
          }),
          { status: 403 },
        );
        return {
          revokedIdentity: b.alice.id,
          bans: room.bans,
          actualAcl: room.acl,
        };
      },
    );
    await check(
      "partner revocation distinguishes live admission, room application and network restart, then explicit reapproval restores the same identity",
      async () => {
        await savePolicy(a, {
          ...a.policy,
          partners: a.policy.partners.map((row) => ({
            ...row,
            enabled: false,
          })),
        });
        const result = await apply(a);
        assert.equal(result.livePolicyObserved, true);
        assert.equal(result.restartRequired, true);
        await assert.rejects(
          a.client.request(
            "POST",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
            { user_id: b.alice.id },
          ),
          { status: 403 },
        );
        await restart(a);
        const stopped = await api(a, "/admin-api/policy", {
          token: a.adminToken,
          admin: true,
        });
        assert.equal(stopped.application.restartRequired, false);
        assert.deepEqual(stopped.application.guard.loadedPartners, []);
        await savePolicy(a, {
          ...a.policy,
          partners: a.policy.partners.map((row) => ({ ...row, enabled: true })),
          members: a.policy.members.map((row) => ({ ...row, enabled: true })),
        });
        await apply(a);
        await restart(a);
        const credentials = await optional(
          path.join(a.dataRoot, "synapse-control.json"),
        );
        const control = new MatrixClient({
          baseUrl: a.matrixUrl,
          accessToken: credentials.accessToken,
        });
        await control.request(
          "POST",
          `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/unban`,
          { user_id: b.alice.id },
        );
        await api(a, `/api/rooms/${encodeURIComponent(roomId)}/invite`, {
          token: a.alice.accessToken,
          body: { participantId: b.alice.id },
        });
        await api(b, `/api/rooms/${encodeURIComponent(roomId)}/join`, {
          token: b.alice.accessToken,
          body: {},
        });
        assert.ok(
          (
            await a.client.request(
              "GET",
              `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
            )
          ).joined[b.alice.id],
        );
        return {
          deniedPartner: b.serverName,
          reapprovedIdentity: b.alice.id,
          oldReplicatedHistoryErased: false,
          restoration: "explicit unban, new invitation and home join",
        };
      },
    );
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await save();
    console.log(
      JSON.stringify({
        reportFile,
        status: report.status,
        checks: report.checks.length,
      }),
    );
  }
}

if (command === "up") await up();
else if (command === "down") await down();
else if (command === "verify") await verify();
else if (command === "reload") await reload();
else if (command === "refresh-guard") await refreshGuard();
else if (command === "refresh-tls") await refreshTls();
else if (command === "status")
  console.log(JSON.stringify(endpoints(), null, 2));
else
  throw new Error(
    "Use federation-lab.mjs up|verify|status|down [--data-root DIR] [--project NAME] [--port-base 24100] [--report FILE]",
  );
