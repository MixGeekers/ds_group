export interface ClientConfig {
  schemaVersion: 1;
  assetOrigin: string;
  homeCoreUrl: string;
  homeMatrixUrl: string | null;
  authUrl: string;
}

export interface ClientDiscovery {
  schemaVersion: 1;
  authorityId: string;
  home: { serverName: string; coreUrl: string | null; matrixUrl: string };
  auth: { mode: string; cookieCredentials: false };
}

/** Deployment configuration is read from the client origin, never from navigation. */
export function httpOrigin(
  value: unknown,
  label = "URL",
  allowHttp = false,
): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be an HTTP(S) origin`);
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && (loopback || allowHttp))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      `${label} must be an HTTPS origin (HTTP is allowed on loopback)`,
    );
  return url.origin;
}

export function parseClientConfig(
  value: unknown,
  assetOrigin: string,
): ClientConfig {
  // An existing browser origin is already the same-origin credential target.
  // Keep HTTP intranet deployments; additional credential targets stay explicit.
  const asset = httpOrigin(assetOrigin, "Client origin", true);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid client-config.json");
  const input = value as Record<string, unknown>;
  const allowed = ["schemaVersion", "homeCoreUrl", "homeMatrixUrl", "authUrl"];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error("Unknown client configuration field");
  if (input.schemaVersion !== 1)
    throw new Error("Unsupported client configuration version");
  const homeCoreUrl =
    input.homeCoreUrl === undefined
      ? asset
      : httpOrigin(
          input.homeCoreUrl,
          "Home Core",
          input.homeCoreUrl === asset || input.homeCoreUrl === asset + "/",
        );
  const authUrl =
    input.authUrl === undefined
      ? homeCoreUrl
      : httpOrigin(
          input.authUrl,
          "Authentication origin",
          input.authUrl === asset || input.authUrl === asset + "/",
        );
  const sameOrigin = homeCoreUrl === asset && authUrl === asset;
  const homeMatrixUrl =
    input.homeMatrixUrl === undefined
      ? null
      : httpOrigin(input.homeMatrixUrl, "Home Matrix", sameOrigin);
  if (
    asset.startsWith("https:") &&
    [homeCoreUrl, authUrl, ...(sameOrigin ? [] : [homeMatrixUrl])].some((url) =>
      url?.startsWith("http:"),
    )
  )
    throw new Error("An HTTPS client requires HTTPS services");
  return Object.freeze({
    schemaVersion: 1,
    assetOrigin: asset,
    homeCoreUrl,
    homeMatrixUrl,
    authUrl,
  });
}

export function defaultClientConfig(
  assetOrigin = location.origin,
): ClientConfig {
  return parseClientConfig({ schemaVersion: 1 }, assetOrigin);
}

export async function loadClientConfig(): Promise<ClientConfig> {
  const response = await fetch(
    new URL("/client-config.json", location.origin),
    {
      credentials: "omit",
      redirect: "error",
      cache: "no-cache",
      signal: AbortSignal.timeout(10000),
    },
  );
  // Older same-origin packages did not ship this file.
  if (response.status === 404) return defaultClientConfig();
  if (!response.ok)
    throw new Error(`Client configuration: HTTP ${response.status}`);
  return parseClientConfig(await response.json(), location.origin);
}

export async function discoverHome(
  config: ClientConfig,
  signal?: AbortSignal,
): Promise<ClientDiscovery | null> {
  const response = await fetch(
    new URL("/.well-known/dscord/client", config.authUrl),
    {
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Home discovery: HTTP ${response.status}`);
  const value = (await response.json()) as ClientDiscovery;
  if (
    value.schemaVersion !== 1 ||
    typeof value.authorityId !== "string" ||
    !value.authorityId ||
    typeof value.home?.serverName !== "string" ||
    !value.home.serverName ||
    value.auth?.mode !== "matrix-password" ||
    value.auth.cookieCredentials !== false
  )
    throw new Error("Invalid home discovery");
  const coreUrl =
    value.home.coreUrl === null
      ? config.authUrl
      : httpOrigin(
          value.home.coreUrl,
          "Discovered home Core",
          config.homeCoreUrl === config.assetOrigin &&
            config.authUrl === config.assetOrigin,
        );
  if (coreUrl !== config.homeCoreUrl)
    throw new Error(
      "The discovered Core differs from the deployment's pinned home Core",
    );
  const matrixUrl = httpOrigin(
    value.home.matrixUrl,
    "Discovered home Matrix",
    config.homeCoreUrl === config.assetOrigin &&
      config.authUrl === config.assetOrigin,
  );
  if (config.homeMatrixUrl && config.homeMatrixUrl !== matrixUrl)
    throw new Error(
      "The discovered Matrix differs from the deployment's pinned home Matrix",
    );
  return value;
}

export function bindingKey(config: ClientConfig): string {
  return encodeURIComponent(
    JSON.stringify([config.homeCoreUrl, config.authUrl, config.homeMatrixUrl]),
  );
}
