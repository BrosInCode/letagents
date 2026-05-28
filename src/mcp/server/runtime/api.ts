import {
  clearStoredAuth,
  getStoredAuth,
} from "../../local-state.js";
import { clearAuthenticatedAccountCache } from "./auth-cache.js";

export const API_URL = (process.env.LETAGENTS_API_URL || "http://localhost:3001").replace(/\/+$/, "");

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`API error ${status}: ${body}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function getLetagentsToken(): string {
  return process.env.LETAGENTS_TOKEN || getStoredAuth()?.token || "";
}

export function getAuthorizationHeader(): string | null {
  const letagentsToken = getLetagentsToken();
  return letagentsToken ? `Bearer ${letagentsToken}` : null;
}

export function isMissingRouteError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 405) &&
    /Cannot (GET|POST|PATCH)|Not Found|Cannot GET \/rooms|Cannot POST \/rooms/i.test(error.body)
  );
}

export function parseApiErrorPayload(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ApiError)) {
    return null;
  }

  try {
    const parsed = JSON.parse(error.body) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveApiPath(urlOrPath: string | undefined): string {
  if (!urlOrPath) {
    return "/auth/device/start";
  }

  try {
    const parsed = new URL(urlOrPath, `${API_URL}/`);
    const apiBase = new URL(`${API_URL}/`);
    if (parsed.origin !== apiBase.origin) {
      return "/auth/device/start";
    }

    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/auth/device/start";
  }
}

export async function apiCall<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string> | undefined),
  };

  const authorizationHeader = getAuthorizationHeader();
  if (authorizationHeader && !headers.Authorization) {
    headers.Authorization = authorizationHeader;
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) {
      // Only clear on 401 (invalid/expired credential), NOT on 403
      // (valid credential but insufficient permissions, e.g., private repo access)
      clearStoredAuth();
      clearAuthenticatedAccountCache();
    }
    throw new ApiError(res.status, body);
  }

  const body = await res.text();
  if (!body) {
    return null as T;
  }

  return JSON.parse(body) as T;
}
