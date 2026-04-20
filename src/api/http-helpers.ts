import type express from "express";
import type { Response } from "express";

import { getPollTimeoutCapMs } from "../shared/poll-timeout-cap.js";
import type { OwnerTokenAccount, SessionAccount } from "./db.js";

export interface AuthenticatedRequest extends express.Request {
  sessionAccount?: SessionAccount | OwnerTokenAccount | null;
  authKind?: "session" | "owner_token" | null;
  rawBody?: Buffer;
}

export interface ResolvedRequestAuth {
  account: SessionAccount | OwnerTokenAccount | null;
  authKind: "session" | "owner_token" | null;
}

export function parsePollTimeout(timeoutValue: string | undefined): number {
  if (!timeoutValue) {
    return 30000;
  }

  const parsed = Number.parseInt(timeoutValue, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return 30000;
  }

  const cap = getPollTimeoutCapMs();
  return Math.min(parsed, cap);
}

export function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};

  return header.split(";").reduce<Record<string, string>>((acc, pair) => {
    const index = pair.indexOf("=");
    if (index === -1) return acc;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

export function setSessionCookie(res: express.Response, token: string): void {
  const secure = (process.env.LETAGENTS_BASE_URL || "").startsWith("https://");
  const cookieParts = [
    `letagents_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (secure) {
    cookieParts.push("Secure");
  }

  res.setHeader("Set-Cookie", cookieParts.join("; "));
}

export function clearSessionCookie(res: express.Response): void {
  res.setHeader(
    "Set-Cookie",
    "letagents_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
}

export function sanitizeRedirectPath(
  pathValue: string | null | undefined,
  fallback = "/"
): string {
  const trimmed = pathValue?.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return fallback;
  }

  try {
    const parsed = new URL(trimmed, "http://localhost");
    if (parsed.origin !== "http://localhost") {
      return fallback;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

const SAFE_BAD_REQUEST_PATTERNS = [
  /^Invalid transition:/,
  /^display_name must be between 2 and 64 characters$/,
];

function logServerError(context: string, error: unknown): void {
  console.error(`[${context}]`, error);
}

function isSafeBadRequestError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    SAFE_BAD_REQUEST_PATTERNS.some((pattern) => pattern.test(error.message))
  );
}

export function respondWithInternalError(
  res: Response,
  context: string,
  error: unknown,
  message: string
): void {
  return respondWithError(res, 500, context, message, error);
}

export function respondWithBadRequest(
  res: Response,
  context: string,
  error: unknown,
  fallbackMessage: string
): void {
  if (isSafeBadRequestError(error)) {
    res.status(400).json({ error: error.message });
    return;
  }

  respondWithError(res, 400, context, fallbackMessage, error);
}

export function respondWithError(
  res: Response,
  status: number,
  context: string,
  message: string,
  error?: unknown
): void {
  if (error !== undefined) {
    logServerError(context, error);
  }
  res.status(status).json({ error: message });
}
