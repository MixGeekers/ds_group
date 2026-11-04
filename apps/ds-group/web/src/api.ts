import type { Api, RequestOptions, Session } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
export function createApi(getSession: () => Session | null): Api {
  return async function request<T>(
    route: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...options.headers };
    const session = getSession();
    if (session && options.auth !== false)
      headers.Authorization = `Bearer ${session.access_token}`;
    if (options.body !== undefined)
      headers["Content-Type"] = "application/json";
    const response = await fetch(route, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeout ?? 15000),
    });
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError(`HTTP ${response.status}`, response.status);
    }
    if (!response.ok) {
      const error = data as { error?: string; message?: string };
      throw new ApiError(
        typeof error.error === "string"
          ? error.error
          : error.message || `HTTP ${response.status}`,
        response.status,
      );
    }
    return data as T;
  };
}
export function readStored<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
