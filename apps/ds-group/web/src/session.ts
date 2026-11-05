import { bindingKey } from "./client-config.ts";
import type { ClientConfig, ClientDiscovery } from "./client-config.ts";
import type { Session } from "./types";

export interface SessionBinding {
  schemaVersion: 1;
  homeCoreUrl: string;
  authUrl: string;
  homeMatrixUrl: string | null;
  authorityId: string | null;
}

export function sameBinding(session: Session, config: ClientConfig): boolean {
  return (
    session.binding?.schemaVersion === 1 &&
    session.binding.homeCoreUrl === config.homeCoreUrl &&
    session.binding.authUrl === config.authUrl &&
    session.binding.homeMatrixUrl === config.homeMatrixUrl
  );
}

export function bindSession(
  input: Session,
  config: ClientConfig,
  discovery: ClientDiscovery | null = null,
): Session {
  if (
    typeof input.access_token !== "string" ||
    !input.access_token ||
    typeof input.user_id !== "string" ||
    !/^@[^\s:]+:[^\s]+$/.test(input.user_id)
  )
    throw new Error("Invalid login session");
  if (input.home?.coreUrl && input.home.coreUrl !== config.homeCoreUrl)
    throw new Error("Login returned a different home Core");
  if (
    discovery &&
    (input.user_id.slice(input.user_id.indexOf(":") + 1) !==
      discovery.home.serverName ||
      input.identity?.authorityId !== discovery.authorityId ||
      input.identity?.matrixUserId !== input.user_id ||
      typeof input.identity?.subjectId !== "string" ||
      !input.identity.subjectId ||
      input.identity.kind !== "human")
  )
    throw new Error("Login identity does not match the pinned home authority");
  if (
    discovery &&
    (!input.home ||
      input.home.serverName !== discovery.home.serverName ||
      (input.home.coreUrl ?? config.authUrl) !== config.homeCoreUrl ||
      input.home.matrixUrl !== discovery.home.matrixUrl)
  )
    throw new Error("Login home does not match the pinned discovery");
  if (
    input.home?.matrixUrl &&
    config.homeMatrixUrl &&
    input.home.matrixUrl !== config.homeMatrixUrl
  )
    throw new Error("Login returned a different home Matrix");
  return {
    ...input,
    binding: {
      schemaVersion: 1,
      homeCoreUrl: config.homeCoreUrl,
      authUrl: config.authUrl,
      homeMatrixUrl: config.homeMatrixUrl,
      authorityId:
        discovery?.authorityId ?? input.identity?.authorityId ?? null,
    },
  };
}

export function sessionIdentity(session: Session | null): string {
  return session
    ? JSON.stringify([
        session.binding,
        session.identity?.subjectId,
        session.user_id,
        session.access_token,
      ])
    : "";
}

export function sessionStorageKey(config: ClientConfig): string {
  return `ds-group.session.v2.${bindingKey(config)}`;
}

export function readStored<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}

export function restoreSession(config: ClientConfig): Session | null {
  const value = readStored<Session>(sessionStorageKey(config));
  if (
    typeof value?.access_token === "string" &&
    value.access_token &&
    typeof value.user_id === "string" &&
    /^@[^\s:]+:[^\s]+$/.test(value.user_id) &&
    sameBinding(value, config)
  )
    return value;
  const legacy = readStored<Session>("ds-group.session");
  if (!legacy?.access_token || !legacy.user_id) return null;
  const sameOriginLegacy =
    config.homeCoreUrl === config.assetOrigin &&
    config.authUrl === config.assetOrigin;
  if (legacy.binding ? !sameBinding(legacy, config) : !sameOriginLegacy)
    return null;
  try {
    const migrated = bindSession(legacy, config);
    sessionStorage.setItem(sessionStorageKey(config), JSON.stringify(migrated));
    sessionStorage.removeItem("ds-group.session");
    return migrated;
  } catch {
    return null;
  }
}

/** Persisted room, draft and retry keys use the full identity and the producing space. */
export function storageKey(
  config: ClientConfig,
  kind: string,
  session?: Session | null,
  spaceId?: string | null,
  roomId?: string | null,
): string {
  return `ds-group.v2.${bindingKey(config)}.${encodeURIComponent(
    JSON.stringify([
      kind,
      session?.binding?.authorityId ?? null,
      session?.identity?.subjectId ?? null,
      session?.user_id ?? null,
      spaceId ?? null,
      roomId ?? null,
    ]),
  )}`;
}

export function readScoped<T>(
  config: ClientConfig,
  kind: string,
  session?: Session | null,
  spaceId?: string | null,
  roomId?: string | null,
  legacyKey?: string,
): T | null {
  const key = storageKey(config, kind, session, spaceId, roomId);
  const current = readStored<T>(key);
  if (current !== null) return current;
  if (
    !legacyKey ||
    config.homeCoreUrl !== config.assetOrigin ||
    config.authUrl !== config.assetOrigin
  )
    return null;
  const old = readStored<T>(legacyKey);
  if (old !== null) {
    sessionStorage.setItem(key, JSON.stringify(old));
    sessionStorage.removeItem(legacyKey);
  }
  return old;
}

/** Only an authenticated /me at the original home may add a central subject to legacy data. */
export function migrateIdentityStorage(
  config: ClientConfig,
  previous: Session,
  next: Session,
): void {
  if (
    !sameBinding(previous, config) ||
    !sameBinding(next, config) ||
    previous.user_id !== next.user_id ||
    (previous.binding?.authorityId &&
      previous.binding.authorityId !== next.binding?.authorityId)
  )
    return;
  const prefix = `ds-group.v2.${bindingKey(config)}.`;
  const keys = Array.from({ length: sessionStorage.length }, (_, index) =>
    sessionStorage.key(index),
  );
  for (const key of keys) {
    if (!key?.startsWith(prefix)) continue;
    try {
      const parts = JSON.parse(
        decodeURIComponent(key.slice(prefix.length)),
      ) as unknown[];
      if (
        parts[1] !== (previous.binding?.authorityId ?? null) ||
        parts[2] !== (previous.identity?.subjectId ?? null) ||
        parts[3] !== previous.user_id
      )
        continue;
      parts[1] = next.binding?.authorityId ?? null;
      parts[2] = next.identity?.subjectId ?? null;
      const target = prefix + encodeURIComponent(JSON.stringify(parts));
      if (target !== key) {
        const value = sessionStorage.getItem(key);
        if (value !== null && sessionStorage.getItem(target) === null)
          sessionStorage.setItem(target, value);
        sessionStorage.removeItem(key);
      }
    } catch {
      /* An unrelated or malformed key is left untouched. */
    }
  }
}
