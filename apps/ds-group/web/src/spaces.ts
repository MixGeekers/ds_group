import { httpOrigin } from "./client-config.ts";
import type { Bootstrap, Room } from "./types";

export interface SpaceRoom {
  roomId: string;
  name: string;
  status: "joined" | "restricted";
  canSend: boolean;
}
export interface SpaceInvitation {
  roomId: string;
  name: string;
  inviterId?: string;
  canJoin: boolean;
  status: "invited" | "approval_required";
}
export interface CollaborationSpace {
  serverName: string;
  name: string;
  home: boolean;
  status: "connected" | "revoked" | "offline";
  rooms: SpaceRoom[];
  invitations: SpaceInvitation[];
}
export interface SpacesResult {
  homeServer: string;
  userId: string;
  spaces: CollaborationSpace[];
}

export function matrixServer(id: string): string {
  return id.slice(id.indexOf(":") + 1);
}

export function validateSpaces(
  value: SpacesResult,
  userId: string,
): SpacesResult {
  if (
    value.userId !== userId ||
    value.homeServer !== matrixServer(userId) ||
    !Array.isArray(value.spaces)
  )
    throw new Error(
      "Collaboration spaces do not match the signed-in home identity",
    );
  const ids = new Set<string>();
  const rooms = new Set<string>();
  for (const space of value.spaces) {
    if (
      !space.serverName ||
      ids.has(space.serverName) ||
      typeof space.name !== "string" ||
      space.home !== (space.serverName === value.homeServer) ||
      !["connected", "revoked", "offline"].includes(space.status) ||
      !Array.isArray(space.rooms) ||
      !Array.isArray(space.invitations)
    )
      throw new Error("Invalid collaboration space");
    ids.add(space.serverName);
    for (const room of space.rooms) {
      if (
        typeof room.roomId !== "string" ||
        !room.roomId.startsWith("!") ||
        rooms.has(room.roomId) ||
        !["joined", "restricted"].includes(room.status) ||
        typeof room.canSend !== "boolean"
      )
        throw new Error("Invalid collaboration room membership");
      rooms.add(room.roomId);
    }
    for (const invitation of space.invitations) {
      if (
        !invitation.roomId?.startsWith("!") ||
        typeof invitation.canJoin !== "boolean" ||
        !["invited", "approval_required"].includes(invitation.status)
      )
        throw new Error("Invalid collaboration invitation");
    }
  }
  return value;
}

/** Only verified /api/rooms facts are used when a legacy Core has no space API. */
export function legacySpaces(
  userId: string,
  rooms: Room[],
  bootstrap: Bootstrap | null,
): SpacesResult {
  const homeServer = matrixServer(userId);
  return {
    homeServer,
    userId,
    spaces: [
      {
        serverName: homeServer,
        name: bootstrap?.name || homeServer,
        home: true,
        status: "connected",
        rooms: rooms.map((room) => ({
          roomId: room.roomId,
          name: room.name,
          status: "joined",
          canSend: true,
        })),
        invitations: [],
      },
    ],
  };
}

export function roomsInSpace(
  rooms: Room[],
  space: CollaborationSpace | null,
): Room[] {
  if (space?.status === "revoked") return [];
  const membership = new Map(
    space?.rooms.map((room) => [room.roomId, room]) ?? [],
  );
  return rooms.flatMap((room) => {
    const fact = membership.get(room.roomId);
    if (!fact || fact.status !== "joined") return [];
    return [
      {
        ...room,
        serverId: space!.serverName,
        membership: "joined" as const,
        permissions: { ...room.permissions, sendMessages: fact.canSend },
      },
    ];
  });
}

export interface DiscoveredServer {
  origin: string;
  name: string;
  serverName: string | null;
  authorityId: string | null;
}

export async function discoverServer(
  address: string,
  signal?: AbortSignal,
): Promise<DiscoveredServer> {
  const origin = httpOrigin(address.trim(), "Server address", true);
  const options: RequestInit = {
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
  };
  const response = await fetch(
    new URL("/.well-known/dscord/client", origin),
    options,
  );
  if (response.status === 404) {
    const fallback = await fetch(new URL("/api/bootstrap", origin), options);
    if (!fallback.ok) throw new Error(`HTTP ${fallback.status}`);
    const value = (await fallback.json()) as Bootstrap;
    if (
      (value.roomId !== null &&
        (typeof value.roomId !== "string" || !value.roomId.startsWith("!"))) ||
      !Array.isArray(value.participants)
    )
      throw new Error("This address is not a DSCord service");
    return {
      origin,
      name: value.name || "DSCord",
      serverName: null,
      authorityId: null,
    };
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const value = (await response.json()) as {
    schemaVersion: number;
    name?: string;
    authorityId: string;
    home: { serverName: string };
  };
  if (
    value.schemaVersion !== 1 ||
    !value.authorityId ||
    !value.home?.serverName
  )
    throw new Error("This address is not a DSCord service");
  return {
    origin,
    name: value.name || value.home.serverName,
    serverName: value.home.serverName,
    authorityId: value.authorityId,
  };
}
