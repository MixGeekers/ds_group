import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { MatrixClient } from "./matrix-client.mjs";
import { isDeepStrictEqual } from "node:util";
import {
  privateJson,
  partnersOf,
  roomAllows,
  roomAcl,
  policyError,
} from "./governance.mjs";
import { packageRoot } from "./paths.mjs";

async function optional(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

export function synapseGovernanceConfig(
  policy,
  {
    policyPath = "/dscord-policy/policy.json",
    statusPath = "/dscord-policy/synapse-status.json",
  } = {},
) {
  const partners = partnersOf(policy);
  return {
    federation_domain_whitelist: partners,
    modules: [
      {
        module: "dscord_guard.GovernanceModule",
        config: {
          server_name: policy.serverName,
          policy_path: policyPath,
          status_path: statusPath,
          loaded_partners: partners,
        },
      },
    ],
  };
}

export class SynapseControl {
  constructor({
    dataRoot,
    setup,
    governance,
    synapseRoot = process.env.DS_GROUP_SYNAPSE_DIR,
    clientFactory,
  }) {
    Object.assign(this, { dataRoot, setup, governance, synapseRoot });
    this.clientFactory =
      clientFactory ||
      ((token) =>
        new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: token }));
    this.stateFile = path.join(governance.root, "application.json");
  }
  async status() {
    const policy = await this.governance.read();
    let observed;
    let probeError;
    try {
      const response = await fetch(
        new URL(
          "/_synapse/client/dscord-governance/status",
          this.setup.homeserverUrl,
        ),
        { signal: AbortSignal.timeout(3000), redirect: "error" },
      );
      if (!response.ok) throw new Error(`Guard probe HTTP ${response.status}`);
      observed = await response.json();
    } catch (error) {
      probeError = error.message;
    }
    const application = await optional(this.stateFile);
    const loaded = observed?.serverName === policy.serverName ? observed : null;
    const expectedSource = createHash("sha256")
      .update(
        await readFile(
          path.join(packageRoot, "deploy/synapse/dscord_guard.py"),
        ),
      )
      .digest("hex");
    const currentGuard = Boolean(
      loaded && loaded.sourceSha256 === expectedSource,
    );
    return {
      savedRevision: policy.revision,
      guard: loaded,
      guardSourceCurrent: currentGuard,
      ...(probeError ? { probeError } : {}),
      livePolicyObserved: Boolean(
        currentGuard &&
          !loaded.error &&
          loaded.liveRevision === policy.revision,
      ),
      restartRequired:
        !currentGuard ||
        JSON.stringify([...(loaded.loadedPartners || [])].sort()) !==
          JSON.stringify(partnersOf(policy)),
      application: application || null,
      configurationWritable: Boolean(this.synapseRoot),
    };
  }
  async serviceClient() {
    const filename = path.join(this.dataRoot, "synapse-control.json");
    let credentials = await optional(filename);
    if (credentials?.accessToken) {
      const client = this.clientFactory(credentials.accessToken);
      try {
        if ((await client.whoami()).user_id === credentials.userId)
          return client;
      } catch (e) {
        if (![401, 403].includes(e.status)) throw e;
      }
    }
    const metadata = await optional(path.join(this.dataRoot, "server.json"));
    if (
      !metadata?.registrationSecret ||
      metadata.serverName !== this.setup.serverName
    )
      throw policyError(
        503,
        "Server registration metadata is required to provision the internal control identity",
      );
    credentials ||= {
      username: "dscord-control",
      userId: `@dscord-control:${this.setup.serverName}`,
      password: randomBytes(48).toString("base64url"),
    };
    if (credentials.userId !== `@dscord-control:${this.setup.serverName}`)
      throw policyError(
        409,
        "Internal control identity belongs to another server",
      );
    await privateJson(filename, credentials);
    const anonymous = this.clientFactory();
    const { nonce } = await anonymous.request(
      "GET",
      "/_synapse/admin/v1/register",
    );
    const mac = createHmac("sha1", metadata.registrationSecret)
      .update(
        [nonce, credentials.username, credentials.password, "admin"].join("\0"),
      )
      .digest("hex");
    let login;
    try {
      login = await anonymous.request("POST", "/_synapse/admin/v1/register", {
        nonce,
        username: credentials.username,
        password: credentials.password,
        admin: true,
        mac,
      });
    } catch (e) {
      if (e.errcode !== "M_USER_IN_USE") throw e;
      login = await MatrixClient.login(
        this.setup.homeserverUrl,
        credentials.userId,
        credentials.password,
      );
    }
    if (login.user_id !== credentials.userId || !login.access_token)
      throw policyError(502, "Internal Matrix control identity mismatch");
    credentials.accessToken = login.access_token;
    await privateJson(filename, credentials);
    return this.clientFactory(credentials.accessToken);
  }
  async prepare(policy) {
    if (!this.synapseRoot)
      throw policyError(
        503,
        "Set DS_GROUP_SYNAPSE_DIR to prepare the Synapse configuration",
      );
    await mkdir(this.synapseRoot, { recursive: true, mode: 0o700 });
    await copyFile(
      path.join(packageRoot, "deploy/synapse/dscord_guard.py"),
      path.join(this.synapseRoot, "dscord_guard.py"),
    );
    const overrides = synapseGovernanceConfig(policy);
    await privateJson(
      path.join(this.synapseRoot, "governance.generated.yaml"),
      overrides,
    );
    return {
      preparedPartners: partnersOf(policy),
      restartCommand: "docker compose -f deploy/compose.yaml restart synapse",
      note: "Synapse must load governance.generated.yaml and PYTHONPATH=/data. Restart is external to the management API.",
    };
  }
  async apply(expectedRevision) {
    if (this.applying)
      throw policyError(409, "Another policy application is running");
    this.applying = true;
    try {
      const policy = await this.governance.read();
      if (policy.revision !== expectedRevision)
        throw policyError(409, "Policy changed; reload before applying");
      const previous = await optional(this.stateFile);
      const application = {
        revision: policy.revision,
        startedAt: Date.now(),
        configuration: null,
        rooms: [],
        status: "applying",
      };
      const save = () => privateJson(this.stateFile, application);
      await save();
      try {
        application.configuration = {
          status: "prepared",
          ...(await this.prepare(policy)),
        };
      } catch (error) {
        application.configuration = { status: "failed", error: error.message };
      }
      const localRooms = new Set(
        [
          this.setup.roomId,
          ...policy.rooms
            .filter((row) => row.authority === policy.serverName)
            .map((row) => row.roomId),
          ...(previous?.rooms || []).map((row) => row.roomId),
        ].filter(Boolean),
      );
      let client;
      try {
        client = await this.serviceClient();
      } catch (error) {
        application.serviceError = error.message;
      }
      for (const roomId of localRooms) {
        const result = { roomId, status: "applying", bans: [] };
        application.rooms.push(result);
        try {
          if (!client) throw new Error(application.serviceError);
          if ((await this.governance.read()).revision !== policy.revision)
            throw new Error(
              "Policy changed during application; apply the latest revision",
            );
          const state = await client.request(
            "GET",
            `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}`,
          );
          const creatorDomain = state.creator?.slice(
            state.creator.indexOf(":") + 1,
          );
          const registeredRule = policy.rooms.find(
            (row) => row.roomId === roomId,
          );
          // Association is an explicit local decision; a creator's home is only
          // a compatibility inference for an unregistered legacy initial room.
          if (
            registeredRule
              ? registeredRule.authority !== policy.serverName
              : creatorDomain && creatorDomain !== policy.serverName
          ) {
            throw new Error(
              "No local collaboration authority is registered for this room",
            );
          }
          const self = (await client.whoami()).user_id;
          await client.request(
            "POST",
            `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/make_room_admin`,
            { user_id: self },
          );
          await client.join(roomId);
          const base = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`;
          const [power, joined] = await Promise.all([
            client.request("GET", `${base}/m.room.power_levels/`),
            client.request(
              "GET",
              `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
            ),
          ]);
          const level = power.users?.[self] ?? power.users_default ?? 0;
          const required = Math.max(
            power.state_default ?? 50,
            power.events?.["m.room.server_acl"] ?? 50,
            power.events?.["m.room.join_rules"] ?? 50,
            power.events?.["org.dscord.work_policy"] ?? 50,
            power.ban ?? 50,
          );
          if (!joined.joined?.[self] || level < required)
            throw new Error(
              "Internal control identity lacks actual Matrix membership or moderation power",
            );
          const members = await client.request(
            "GET",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/members`,
          );
          const rule = policy.rooms.find((row) => row.roomId === roomId) || {
            roomId,
            enabled: false,
            memberIds: [],
          };
          // Ban revoked members BEFORE reducing the room ACL, while federation can
          // still deliver the membership changes to the formerly allowed host.
          for (const event of members.chunk || []) {
            const id = event.state_key;
            if (
              id.slice(id.indexOf(":") + 1) === policy.serverName ||
              !["join", "invite", "knock"].includes(
                event.content?.membership,
              ) ||
              roomAllows(policy, roomId, id)
            )
              continue;
            try {
              const receipt = await client.request(
                "POST",
                `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/ban`,
                { user_id: id, reason: "DSCord admission revoked" },
              );
              result.bans.push({
                id,
                status: "applied",
                eventId: receipt.event_id,
              });
            } catch (error) {
              result.bans.push({ id, status: "failed", error: error.message });
            }
          }
          const acl = roomAcl(policy, rule);
          await client.request("PUT", `${base}/m.room.join_rules/`, {
            join_rule: "invite",
          });
          await client.request("PUT", `${base}/m.room.server_acl/`, acl);
          // This event contains public collaboration limits, never owner grants or credentials.
          const work = {
            revision: policy.revision,
            authority: policy.serverName,
            enabled: rule.enabled,
            botIds: rule.botIds || [],
            tools: rule.tools || [],
            memberIds: rule.memberIds || [],
          };
          await client.request("PUT", `${base}/org.dscord.work_policy/`, work);
          const actual = await client.request(
            "GET",
            `${base}/m.room.server_acl/`,
          );
          if (!isDeepStrictEqual(actual, acl))
            throw new Error("Room ACL readback did not match");
          result.status = result.bans.some((row) => row.status === "failed")
            ? "partial"
            : "applied";
          result.acl = actual;
        } catch (error) {
          result.status = "failed";
          result.error = error.message;
        }
        await save();
      }
      application.status =
        application.configuration.status === "prepared" &&
        application.rooms.every((row) => row.status === "applied")
          ? "prepared"
          : "partial";
      application.finishedAt = Date.now();
      await save();
      return this.status();
    } finally {
      this.applying = false;
    }
  }
  async invite({ roomId, memberId, revision }) {
    const policy = await this.governance.read();
    if (policy.revision !== revision)
      throw policyError(409, "Policy changed; reload before inviting");
    const room = policy.rooms.find(
      (row) => row.roomId === roomId && row.authority === policy.serverName,
    );
    if (!room || !roomAllows(policy, roomId, memberId))
      throw policyError(403, "Approve this exact member and local room first");
    const client = await this.serviceClient();
    return client.request(
      "POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      { user_id: memberId },
    );
  }
}
