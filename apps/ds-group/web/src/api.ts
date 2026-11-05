import { defaultClientConfig } from "./client-config.ts";
import type { ClientConfig } from "./client-config.ts";
import { sameBinding, sessionIdentity } from "./session.ts";
import type { Api, RawRequest, RequestOptions, Session } from "./types";
export { readStored } from "./session.ts";

export class ApiError extends Error {
  public readonly status: number;
  public readonly retryAfterMs: number;
  public readonly code: string;
  constructor(message: string, status: number, retryAfterMs = 0, code = "") {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}
export function apiUrl(
  config: ClientConfig,
  route: string,
  target: "core" | "auth" = "core",
): string {
  if (
    !route.startsWith("/api/") ||
    route.includes("\\") ||
    /[\r\n]/.test(route)
  )
    throw new Error("API routes must be relative /api/ paths");
  const origin = target === "auth" ? config.authUrl : config.homeCoreUrl;
  const url = new URL(route, origin);
  if (url.origin !== origin || !url.pathname.startsWith("/api/"))
    throw new Error("API route escapes the pinned service");
  return url.href;
}

export function createRequest(
  getSession: () => Session | null,
  config: ClientConfig = defaultClientConfig(),
  target: "core" | "auth" = "core",
  transform: (route: string) => string = (route) => route,
): RawRequest {
  return async (route, options = {}) => {
    const session = options.auth === false ? null : getSession();
    const headers = new Headers(options.headers);
    // Callers cannot inject a different account's credential.
    headers.delete("Authorization");
    if (session) {
      const legacySameOrigin =
        !session.binding &&
        config.homeCoreUrl === config.assetOrigin &&
        config.authUrl === config.assetOrigin;
      if (!sameBinding(session, config) && !legacySameOrigin)
        throw new Error("Session is not bound to this home service");
      headers.set("Authorization", `Bearer ${session.access_token}`);
    }
    const identity = sessionIdentity(session);
    const { auth: _auth, ...init } = options;
    const response = await fetch(apiUrl(config, transform(route), target), {
      ...init,
      headers,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    if (session && sessionIdentity(getSession()) !== identity)
      throw new DOMException(
        "The account changed while the request was in flight",
        "AbortError",
      );
    return response;
  };
}

export function createApi(
  getSession: () => Session | null,
  config: ClientConfig = defaultClientConfig(),
  target: "core" | "auth" = "core",
  transform?: (route: string) => string,
): Api {
  const raw = createRequest(getSession, config, target, transform);
  return async function request<T>(
    route: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined)
      headers["Content-Type"] = "application/json";
    const timeout = AbortSignal.timeout(options.timeout ?? 15000);
    const response = await raw(route, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
        ? AbortSignal.any([timeout, options.signal])
        : timeout,
      auth: options.auth,
    });
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError(`HTTP ${response.status}`, response.status);
    }
    if (!response.ok) {
      const error = data as {
        error?: string;
        message?: string;
        retry_after_ms?: number;
        code?: string;
      };
      const retryAfter = response.headers.get("Retry-After");
      const headerDelay = retryAfter
        ? Number.isFinite(Number(retryAfter))
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - Date.now()
        : 0;
      const bodyDelay = error.retry_after_ms;
      const retryAfterMs =
        typeof bodyDelay === "number" && Number.isFinite(bodyDelay)
          ? Math.max(0, bodyDelay)
          : Number.isFinite(headerDelay)
            ? Math.max(0, headerDelay)
            : 0;
      throw new ApiError(
        typeof error.error === "string"
          ? error.error
          : error.message || `HTTP ${response.status}`,
        response.status,
        retryAfterMs,
        typeof error.code === "string" ? error.code : "",
      );
    }
    return data as T;
  };
}
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
