import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { createCore } from "../src/core.mjs";

const good = Buffer.from("verified attachment body\n");
const userId = "@alice:verify.test";
const roomId = "!verified";
const eventId = "$verified-source";
const descriptor = {
  id: "attachment-verified",
  name: "verified.txt",
  mimeType: "text/plain",
  size: good.length,
  sha256: createHash("sha256").update(good).digest("hex"),
  contentUri: "mxc://verify.test/object",
};
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function eventually(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Verification observation timed out");
}

async function fixture(t, config = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "dscord-verified-media-"),
  );
  const state = {
    mode: "good",
    joined: true,
    downloads: 0,
    ranges: [],
    held: [],
    revokeAfterTransfer: false,
    disableAfterTransfer: false,
  };
  const matrix = createServer((request, response) => {
    const route = decodeURIComponent(
      new URL(request.url, "http://matrix").pathname,
    );
    const json = (data) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (route === "/_matrix/client/v3/account/whoami")
      return json({ user_id: userId });
    if (route.endsWith("/joined_members"))
      return json({ joined: state.joined ? { [userId]: {} } : {} });
    if (route.endsWith("/state"))
      return json([{ type: "m.room.create", sender: userId }]);
    if (route.endsWith(`/event/${eventId}`))
      return json({
        event_id: eventId,
        room_id: roomId,
        sender: userId,
        type: "m.room.message",
        content: { "org.ds_group": { attachments: [descriptor] } },
      });
    if (route === "/_matrix/client/v1/media/download/verify.test/object") {
      state.downloads++;
      state.ranges.push(request.headers.range);
      let bytes = good;
      if (state.mode === "corrupt") {
        bytes = Buffer.from(good);
        bytes[bytes.length - 1] ^= 1;
      }
      if (state.mode === "overflow")
        bytes = Buffer.concat([good, Buffer.from("unexpected extra bytes")]);
      if (state.mode === "truncated") bytes = good.subarray(0, good.length - 1);
      if (state.mode === "gzip") {
        bytes = gzipSync(good);
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-encoding": "gzip",
          "content-length": String(bytes.length),
        });
      } else if (
        ["overflow", "truncated", "hold", "chunked"].includes(state.mode)
      ) {
        response.writeHead(200, {
          "content-type": "text/plain",
          "transfer-encoding": "chunked",
        });
      } else
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-length": String(bytes.length),
        });
      if (state.mode === "hold") {
        response.write(bytes.subarray(0, 1));
        state.held.push(() => response.end(bytes.subarray(1)));
      } else {
        if (state.revokeAfterTransfer) state.joined = false;
        if (state.disableAfterTransfer) state.disableAccount();
        response.end(bytes);
      }
      return;
    }
    response.writeHead(404);
    response.end("{}");
  });
  const matrixUrl = await listen(matrix);
  const core = await createCore({
    dataRoot: directory,
    enablePush: false,
    config: { nodeSecret: "synthetic-verification-secret", ...config },
    setup: {
      serverName: "verify.test",
      homeserverUrl: matrixUrl,
      roomId,
      participants: [
        {
          id: userId,
          name: "Alice",
          kind: "human",
          localpart: "alice",
          accessToken: "synthetic-token",
        },
      ],
    },
  });
  const coreUrl = await listen(core.server);
  state.disableAccount = () =>
    core.accounts.db
      .prepare("UPDATE accounts SET status='disabled' WHERE user_id=?")
      .run(userId);
  t.after(async () => {
    assert.equal(core.budget.snapshot().used, 0);
    await core.close();
    await new Promise((resolve) => matrix.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    state,
    core,
    directory,
    get: (options = {}) =>
      fetch(
        `${coreUrl}/api/rooms/${encodeURIComponent(roomId)}/attachments/${descriptor.id}?eventId=${encodeURIComponent(eventId)}`,
        {
          headers: {
            authorization: "Bearer synthetic-token",
            ...options.headers,
          },
          signal: options.signal,
        },
      ),
    files: async () => {
      try {
        return await readdir(core.media.verified.directory);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return [];
      }
    },
  };
}

test("proven full downloads verify actual length/hash before returning good bytes, including absent length and compressed transfer", async (t) => {
  const value = await fixture(t);
  for (const mode of ["good", "chunked", "gzip"]) {
    value.state.mode = mode;
    const response = await value.get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("content-length"), String(good.length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), good);
    await eventually(async () => (await value.files()).length === 0);
  }
});

test("same-length wrong bytes fail as JSON before any successful file headers or blob body can be cached", async (t) => {
  const value = await fixture(t);
  value.state.mode = "corrupt";
  const response = await value.get();
  assert.equal(response.status, 502);
  assert.equal(response.ok, false);
  assert.equal(response.headers.get("content-disposition"), null);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const error = await response.json();
  assert.equal(error.code, "MEDIA_INTEGRITY_FAILED");
  assert.match(error.error, /SHA256/);
  assert.deepEqual(await value.files(), []);
});

test("headerless overrun and cleanly ended truncation fail actual byte-count verification and remove temporary bytes", async (t) => {
  const value = await fixture(t);
  for (const mode of ["overflow", "truncated"]) {
    value.state.mode = mode;
    const response = await value.get();
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("content-disposition"), null);
    assert.equal((await response.json()).code, "MEDIA_INTEGRITY_FAILED");
    assert.deepEqual(await value.files(), []);
    assert.equal(value.core.media.verified.active, 0);
    assert.equal(value.core.media.verified.reserved, 0);
  }
});

test("Range is served from a verified full object and detects corruption outside the requested range", async (t) => {
  const value = await fixture(t);
  const range = await value.get({ headers: { Range: "bytes=0-3" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 0-3/${good.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), good.subarray(0, 4));
  assert.equal(
    value.state.ranges[0],
    undefined,
    "Upstream receives a full-object request for SHA256 verification",
  );
  value.state.mode = "corrupt";
  const corrupt = await value.get({ headers: { Range: "bytes=0-3" } });
  assert.equal(corrupt.status, 502);
  assert.equal((await corrupt.json()).code, "MEDIA_INTEGRITY_FAILED");
});

test("verification limits reject oversized objects before fetching and count retained orphan files against the storage budget", async (t) => {
  const small = await fixture(t, { verifiedDownloadMaxBytes: good.length - 1 });
  const response = await small.get();
  assert.equal(response.status, 413);
  assert.equal(small.state.downloads, 0);
  const full = await fixture(t, {
    verifiedDownloadMaxBytes: good.length,
    verifiedDownloadConcurrency: 1,
  });
  await mkdir(full.core.media.verified.directory, { recursive: true });
  await writeFile(
    path.join(full.core.media.verified.directory, "synthetic-orphan.part"),
    Buffer.alloc(1),
  );
  const denied = await full.get();
  assert.equal(denied.status, 507);
  assert.equal(full.state.downloads, 0);
  assert.deepEqual(
    await full.files(),
    ["synthetic-orphan.part"],
    "Unknown retained files are counted, not silently deleted",
  );
});

test("concurrent verification is bounded, queued requests can be cancelled, and slots resume after cleanup", async (t) => {
  const value = await fixture(t, {
    verifiedDownloadConcurrency: 1,
    verifiedDownloadMaxBytes: 1024,
  });
  value.state.mode = "hold";
  const first = value.get();
  await eventually(() => value.state.held.length === 1);
  const controller = new AbortController();
  const second = value.get({ signal: controller.signal });
  await eventually(() => value.core.media.verified.waiters.length === 1);
  assert.equal(value.state.downloads, 1);
  controller.abort();
  await assert.rejects(second);
  await eventually(() => value.core.media.verified.waiters.length === 0);
  value.state.held[0]();
  assert.deepEqual(Buffer.from(await (await first).arrayBuffer()), good);
  await eventually(() => value.core.media.verified.active === 0);
  value.state.mode = "good";
  assert.equal((await value.get()).status, 200);
  await eventually(async () => (await value.files()).length === 0);
});

test("membership revoked while bytes are staged is rechecked before any verified file is sent", async (t) => {
  const value = await fixture(t);
  value.state.revokeAfterTransfer = true;
  const response = await value.get();
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("content-disposition"), null);
  assert.deepEqual(await value.files(), []);
});

test("home account disabled while bytes are staged cannot complete a verified download", async (t) => {
  const value = await fixture(t);
  value.state.disableAfterTransfer = true;
  const response = await value.get();
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("content-disposition"), null);
  assert.deepEqual(await value.files(), []);
});

test("stopping the verified media service cancels a staging stream and cleans up its private file", async (t) => {
  const value = await fixture(t);
  value.state.mode = "hold";
  const pending = value.get();
  await eventually(() => value.state.held.length === 1);
  value.core.media.verified.stop();
  assert.equal((await pending).status, 503);
  assert.deepEqual(await value.files(), []);
});
