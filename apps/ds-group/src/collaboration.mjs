import { MatrixClient } from "./matrix-client.mjs";
import {
  admitted,
  roomAllows,
  serverOf,
  policyError,
  partnersOf,
} from "./governance.mjs";

/** User collaboration requests always use the user's home Core and homeserver. */
export class CollaborationService {
  constructor({ setup, governance, accounts }) {
    Object.assign(this, { setup, governance, accounts });
  }
  async directory() {
    return [
      ...this.accounts
        .publicParticipants()
        .map((person) => ({ ...person, homeServer: serverOf(person.id) })),
      ...(await this.governance.admittedParticipants()),
    ];
  }
  async identity(request) {
    const authorization = request.headers.authorization || "";
    if (!authorization.startsWith("Bearer "))
      throw policyError(401, "Please sign in");
    const token = authorization.slice(7);
    const client = new MatrixClient({
      baseUrl: this.setup.homeserverUrl,
      accessToken: token,
    });
    // Share /api/me's active-account checks and central identity binding.
    const { user } = await this.accounts.me(token);
    const userId = user.id;
    if (serverOf(userId) !== this.setup.serverName)
      throw policyError(403, "Use your identity’s home server");
    return { userId, client };
  }
  async spaces(client, userId) {
    const policy = await this.governance.read();
    const sync = await client.sync({ timeout: 0 });
    const spaces = new Map();
    const home = this.setup.serverName;
    const add = (authority) => {
      if (!spaces.has(authority)) {
        const partner = policy.partners.find(
          (row) => row.serverName === authority,
        );
        spaces.set(authority, {
          serverName: authority,
          name: partner?.name || authority,
          home: authority === home,
          status:
            authority === home || partner?.enabled ? "connected" : "revoked",
          rooms: [],
          invitations: [],
        });
      }
      return spaces.get(authority);
    };
    add(home);
    for (const [roomId, room] of Object.entries(sync.rooms?.join || {})) {
      const rule = policy.rooms.find((row) => row.roomId === roomId);
      const events = [
        ...(room.state?.events || []),
        ...(room.timeline?.events || []),
      ];
      let creator = events.find((event) => event.type === "m.room.create");
      if (!creator) {
        try {
          creator = (
            await client.request(
              "GET",
              `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`,
            )
          ).find((event) => event.type === "m.room.create");
        } catch {
          /* The room remains available under its explicit rule if state retrieval is delayed. */
        }
      }
      const authority = rule?.authority || serverOf(creator?.sender);
      if (!authority) continue;
      const allowed =
        authority === home ||
        (partnersOf(policy).includes(authority) &&
          rule?.authority === authority &&
          roomAllows(policy, roomId, userId));
      const name =
        events.find((event) => event.type === "m.room.name")?.content?.name ||
        rule?.name ||
        roomId;
      add(authority).rooms.push({
        roomId,
        name,
        status: allowed ? "joined" : "restricted",
        canSend: allowed,
        authoritySource: rule ? "registered" : "creator_compatibility",
      });
    }
    for (const [roomId, invitation] of Object.entries(
      sync.rooms?.invite || {},
    )) {
      const states = invitation.invite_state?.events || [];
      const rule = policy.rooms.find((row) => row.roomId === roomId);
      const inviter = states.find(
        (event) => event.type === "m.room.member" && event.state_key === userId,
      )?.sender;
      const authority =
        rule?.authority ||
        serverOf(
          states.find((event) => event.type === "m.room.create")?.sender,
        ) ||
        serverOf(inviter);
      if (!authority) continue;
      const canJoin =
        authority === home ||
        (partnersOf(policy).includes(authority) &&
          rule?.authority === authority &&
          roomAllows(policy, roomId, userId) &&
          admitted(policy, inviter));
      add(authority).invitations.push({
        roomId,
        name:
          states.find((event) => event.type === "m.room.name")?.content?.name ||
          rule?.name ||
          roomId,
        inviterId: inviter,
        canJoin,
        status: canJoin ? "invited" : "approval_required",
        authoritySource: rule ? "registered" : "creator_compatibility",
      });
    }
    return { homeServer: home, userId, spaces: [...spaces.values()] };
  }
  handles(pathname) {
    return (
      ["/api/directory", "/api/spaces"].includes(pathname) ||
      /^\/api\/rooms\/[^/]+\/(join|leave)$/.test(pathname)
    );
  }
  async handle({ request, url, send }) {
    const { userId, client } = await this.identity(request);
    if (request.method === "GET" && url.pathname === "/api/directory")
      return send(200, { participants: await this.directory() });
    if (request.method === "GET" && url.pathname === "/api/spaces")
      return send(200, await this.spaces(client, userId));
    const action = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(join|leave)$/);
    if (request.method === "POST" && action) {
      const roomId = decodeURIComponent(action[1]);
      if (action[2] === "leave") {
        await client.request(
          "POST",
          `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
          {},
        );
        return send(200, { roomId, status: "left" });
      }
      const policy = await this.governance.read();
      const rule = policy.rooms.find((row) => row.roomId === roomId);
      if (
        !rule?.enabled ||
        !roomAllows(policy, roomId, userId) ||
        (rule.authority !== policy.serverName &&
          !partnersOf(policy).includes(rule.authority))
      )
        throw policyError(
          403,
          "This exact collaboration room needs approval on your home server",
        );
      const result = await client.join(roomId);
      return send(200, {
        roomId: result.room_id,
        status: "joined",
        serverName: rule.authority,
      });
    }
    throw policyError(404, "Unknown collaboration endpoint");
  }
}
