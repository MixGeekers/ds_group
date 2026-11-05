import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AdminAuth } from "./admin-auth.mjs";
import { Governance, policyError } from "./governance.mjs";
import { SynapseControl } from "./synapse-control.mjs";
import { localPath, packageRoot } from "./paths.mjs";
import { readJsonBody } from "./http-json.mjs";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};
const optional = async (filename) => {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
};

export async function createAdmin({
  dataRoot = localPath(),
  setup,
  webRoot = process.env.DS_GROUP_ADMIN_WEB_DIR ||
    path.join(packageRoot, "dist/admin"),
  synapseRoot,
  controlFactory,
  governanceRoot,
} = {}) {
  setup ||= await optional(path.join(dataRoot, "matrix-setup.json"));
  if (!setup?.serverName)
    throw new Error(
      "Initialize the server before starting its administration service",
    );
  const auth = await new AdminAuth(dataRoot).initialize();
  const governance = new Governance({
    dataRoot,
    serverName: setup.serverName,
    governanceRoot,
  });
  await governance.ensure();
  const control = controlFactory
    ? controlFactory({ dataRoot, setup, governance, synapseRoot })
    : new SynapseControl({ dataRoot, setup, governance, synapseRoot });
  const startedAt = Date.now();
  const server = http.createServer((request, response) => {
    const send = (status, data) => {
      response.writeHead(status, headers);
      response.end(JSON.stringify(data));
    };
    (async () => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/healthz")
        return send(200, { status: "ok", service: "dscord-administration" });
      if (url.pathname.startsWith("/admin-api/")) {
        // No cookies, no wildcard CORS, no cross-origin password or session use.
        if (request.headers.origin) {
          let origin;
          try {
            origin = new URL(request.headers.origin);
          } catch {
            throw policyError(403, "Invalid management origin");
          }
          if (origin.host !== request.headers.host)
            throw policyError(403, "Use this instance’s management origin");
        }
        if (request.method === "POST" && url.pathname === "/admin-api/login") {
          return send(
            200,
            await auth.login(
              await readJsonBody(request),
              request.socket.remoteAddress,
            ),
          );
        }
        const actor = auth.authorize(request);
        const write = () => auth.authorize(request, ["owner", "operator"]);
        if (request.method === "GET" && url.pathname === "/admin-api/me")
          return send(200, {
            username: actor.username,
            role: actor.role,
            serverName: setup.serverName,
          });
        if (request.method === "POST" && url.pathname === "/admin-api/logout") {
          auth.logout(actor);
          return send(200, { signedOut: true });
        }
        if (request.method === "GET" && url.pathname === "/admin-api/policy")
          return send(200, {
            policy: await governance.read(),
            application: await control.status(),
          });
        if (request.method === "PUT" && url.pathname === "/admin-api/policy") {
          write();
          const input = await readJsonBody(request);
          const policy = await governance.save(input, (next) =>
            auth.audit(actor.username, "policy.save", {
              revision: next.revision,
            }),
          );
          return send(200, { policy, application: await control.status() });
        }
        if (request.method === "POST" && url.pathname === "/admin-api/apply") {
          write();
          const { revision } = await readJsonBody(request);
          auth.audit(actor.username, "policy.apply_started", { revision });
          const application = await control.apply(revision);
          auth.audit(actor.username, "policy.apply_finished", {
            revision,
            status: application.application?.status,
          });
          return send(200, application);
        }
        if (request.method === "POST" && url.pathname === "/admin-api/invite") {
          write();
          const input = await readJsonBody(request);
          const receipt = await control.invite(input);
          auth.audit(actor.username, "room.invite", {
            roomId: input.roomId,
            memberId: input.memberId,
            revision: input.revision,
          });
          return send(200, receipt);
        }
        if (url.pathname === "/admin-api/administrators") {
          if (request.method === "GET")
            return send(200, { administrators: auth.list() });
          if (request.method === "PUT") {
            auth.authorize(request, ["owner"]);
            return send(200, {
              administrators: await auth.change(
                actor.username,
                await readJsonBody(request),
              ),
            });
          }
        }
        if (request.method === "GET" && url.pathname === "/admin-api/audit")
          return send(200, {
            events: auth.events(
              Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER,
            ),
          });
        if (
          request.method === "GET" &&
          url.pathname === "/admin-api/overview"
        ) {
          const storage = await optional(
            path.join(dataRoot, "media-storage.json"),
          );
          const files = [];
          for (const filename of [
            "accounts.sqlite",
            "chat.sqlite",
            "tasks.sqlite",
            "media.sqlite",
            "model-budget.sqlite",
            "administrators.sqlite",
          ]) {
            try {
              const result = await stat(path.join(dataRoot, filename));
              files.push({ filename, bytes: result.size });
            } catch (e) {
              if (e.code !== "ENOENT") throw e;
            }
          }
          const config = await optional(
            path.join(dataRoot, "core-config.json"),
          );
          return send(200, {
            serverName: setup.serverName,
            publicUrl: config?.publicUrl,
            homeserverUrl: setup.publicHomeserverUrl,
            startedAt,
            initialRoomId: setup.roomId,
            application: await control.status(),
            storage: {
              backend: storage?.backend || "local",
              ...(storage?.bucket
                ? {
                    bucket: storage.bucket,
                    region: storage.region,
                    prefix: storage.prefix,
                  }
                : {}),
              files,
              backup:
                "Stop Core, administration and Synapse; back up all persistent data volumes together. Live SQLite file copies are not a complete backup.",
            },
          });
        }
        throw policyError(404, "Unknown management endpoint");
      }
      if (
        request.method !== "GET" ||
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/internal/") ||
        url.pathname.startsWith("/_matrix/") ||
        url.pathname.startsWith("/_synapse/")
      )
        throw policyError(404, "Not found");
      const relative =
        url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      // Only management HTML and immutable built resources are served on this listener.
      if (
        relative !== "index.html" &&
        !relative.startsWith("assets/") &&
        relative !== "theme.js"
      )
        throw policyError(404, "Not found");
      const filename = path.resolve(webRoot, relative);
      if (!filename.startsWith(path.resolve(webRoot) + path.sep))
        throw policyError(404, "Not found");
      let body;
      try {
        body = await readFile(filename);
      } catch (error) {
        if (error.code === "ENOENT")
          throw policyError(
            404,
            "Build the management frontend before opening it",
          );
        throw error;
      }
      response.writeHead(200, {
        ...headers,
        "Content-Type":
          mime[path.extname(filename)] || "application/octet-stream",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      });
      response.end(body);
    })().catch((error) => {
      if (response.headersSent) return response.destroy();
      send(error.status || 500, {
        error: error.status
          ? error.message
          : "Management operation failed; inspect the local service log",
      });
      if (!error.status) console.error(error);
    });
  });
  return {
    server,
    auth,
    governance,
    control,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      auth.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const admin = await createAdmin();
  const host = process.env.DS_GROUP_ADMIN_HOST || "127.0.0.1";
  const port = Number(process.env.DS_GROUP_ADMIN_PORT || 18110);
  admin.server.listen(port, host, () =>
    console.log(`DSCord administration ready at http://${host}:${port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await admin.close();
      process.exit(0);
    });
}
