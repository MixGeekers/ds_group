import assert from "node:assert/strict";
import { test } from "node:test";
import {
  equalWorkGrants,
  fileTools,
  parseWorkGrants,
} from "../web/src/bot-work-grants.ts";
import {
  attachmentResponse,
  roomAttachmentRoute,
} from "../web/src/attachment-proof.ts";

const document = {
  revision: 3,
  grants: [
    {
      roomId: "!opaque-v12-room",
      requesterIds: ["@sam:b.example", "@sam:a.example"],
      tools: ["write", "read"],
      enabled: true,
    },
  ],
};
test("owner work documents retain exact room and human IDs with only the four supported file tools", () => {
  const value = parseWorkGrants(document);
  assert.equal(value.revision, 3);
  assert.deepEqual(value.grants[0].requesterIds, [
    "@sam:a.example",
    "@sam:b.example",
  ]);
  assert.deepEqual(value.grants[0].tools, ["read", "write"]);
  assert.deepEqual(fileTools, ["read", "write", "edit", "read_image"]);
  assert.equal(document.grants[0].requesterIds[0], "@sam:b.example");
});
test("invalid owner grant documents reject version, duplicate rooms, incomplete IDs and expanded tool scopes", () => {
  for (const value of [
    null,
    { ...document, revision: -1 },
    { ...document, revision: 1.5 },
    { ...document, grants: [...document.grants, ...document.grants] },
    { ...document, grants: [{ ...document.grants[0], requesterIds: ["sam"] }] },
    { ...document, grants: [{ ...document.grants[0], tools: ["bash"] }] },
    {
      ...document,
      grants: [{ ...document.grants[0], tools: ["read", "read"] }],
    },
    { ...document, grants: [{ ...document.grants[0], enabled: "yes" }] },
  ])
    assert.throws(() => parseWorkGrants(value));
});
test("normalized save receipts can change ordering but cannot silently broaden a requester or tool", () => {
  assert.equal(
    equalWorkGrants(document, {
      ...document,
      revision: 4,
      grants: [
        {
          ...document.grants[0],
          requesterIds: document.grants[0].requesterIds.toReversed(),
          tools: ["read", "write"],
        },
      ],
    }),
    true,
  );
  assert.equal(
    equalWorkGrants(document, {
      ...document,
      grants: [{ ...document.grants[0], tools: ["read", "write", "edit"] }],
    }),
    false,
  );
  assert.equal(
    equalWorkGrants(document, {
      ...document,
      grants: [{ ...document.grants[0], requesterIds: ["@sam:c.example"] }],
    }),
    false,
  );
});

const attachment = {
  id: "same-index-id",
  name: "proof.txt",
  mimeType: "text/plain",
  size: 7,
  sha256: "a".repeat(64),
  contentUri: "mxc://home.example/proof",
};
const source = { roomId: "!opaque-v12-room", eventId: "$original-event" };
test("room media route always includes the original complete event and room IDs", () => {
  assert.equal(
    roomAttachmentRoute("id/with?chars", source),
    "/api/rooms/!opaque-v12-room/attachments/id%2Fwith%3Fchars?eventId=%24original-event",
  );
  assert.equal(
    roomAttachmentRoute(attachment.id, source, true),
    "/api/rooms/!opaque-v12-room/attachments/same-index-id/metadata?eventId=%24original-event",
  );
});
test("an authenticated room proof denial or missing foreign proof never downgrades", async () => {
  for (const status of [401, 403, 404]) {
    const calls = [];
    const response = await attachmentResponse({
      attachment,
      source,
      request: async (path) => {
        calls.push(path);
        return Response.json({ error: "Denied proof" }, { status });
      },
    });
    assert.equal(response.status, status);
    assert.equal(calls.length, 1);
  }
  const calls = [];
  const response = await attachmentResponse({
    attachment,
    source,
    allowLegacy: true,
    homeServerName: "home.example",
    request: async (path) => {
      calls.push(path);
      return new Response("", { status: 403 });
    },
  });
  assert.equal(response.status, 403);
  assert.equal(calls.length, 1);
});
test("a known legacy home uses a verified matching index only after proof route 404", async () => {
  const calls = [];
  const response = await attachmentResponse({
    attachment,
    source,
    allowLegacy: true,
    homeServerName: "home.example",
    request: async (path) => {
      calls.push(path);
      if (path.startsWith("/api/rooms/"))
        return new Response("", { status: 404 });
      if (path.endsWith("/metadata")) return Response.json({ attachment });
      return new Response("bytes");
    },
  });
  assert.equal(await response.text(), "bytes");
  assert.deepEqual(calls, [
    roomAttachmentRoute(attachment.id, source),
    roomAttachmentRoute(attachment.id, {}, true),
    roomAttachmentRoute(attachment.id, {}),
  ]);
});
test("legacy lookup cannot confuse a foreign mxc, collision, digest, size or revoked old permission", async () => {
  for (const current of [
    { ...attachment, contentUri: "mxc://elsewhere.example/proof" },
    { ...attachment, sha256: "b".repeat(64) },
    { ...attachment, size: 99 },
    { ...attachment, id: "wrong-index" },
  ]) {
    let reads = 0;
    await assert.rejects(
      attachmentResponse({
        attachment,
        source,
        allowLegacy: true,
        homeServerName: "home.example",
        request: async (path) => {
          if (path.startsWith("/api/rooms/"))
            return new Response("", { status: 404 });
          if (path.endsWith("/metadata"))
            return Response.json({ attachment: current });
          reads++;
          return new Response("must not read");
        },
      }),
      /does not match/,
    );
    assert.equal(reads, 0);
  }
  const calls = [];
  const response = await attachmentResponse({
    attachment,
    source,
    allowLegacy: true,
    homeServerName: "home.example",
    request: async (path) => {
      calls.push(path);
      return new Response("", {
        status: path.startsWith("/api/rooms/") ? 404 : 403,
      });
    },
  });
  assert.equal(response.status, 403);
  assert.equal(calls.length, 2);
});

test("cached attachment metadata must prove the same message and the same descriptor", async () => {
  const valid = { attachment, proof: source };
  const response = await attachmentResponse({
    attachment,
    source,
    metadata: true,
    request: async () => Response.json(valid),
  });
  assert.equal(response.status, 200);
  for (const value of [
    { ...valid, proof: { ...source, eventId: "$other" } },
    { ...valid, proof: { ...source, roomId: "!other-room" } },
    { ...valid, attachment: { ...attachment, sha256: "b".repeat(64) } },
    { attachment },
  ])
    await assert.rejects(
      attachmentResponse({
        attachment,
        source,
        metadata: true,
        request: async () => Response.json(value),
      }),
      /does not match/,
    );
});
