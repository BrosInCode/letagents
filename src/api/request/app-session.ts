import type { Response } from "express";
import type { AuthenticatedRequest } from "../http/helpers.js";
import { parseBearerAuthorization } from "./bearer-authorization.js";

/** Human authority comes from a session issued by an interactive sign-in. */
export function isAppSession(req: AuthenticatedRequest): boolean {
  return req.authKind === "session" && Boolean(req.sessionAccount);
}

export function isHumanAppWrite(
  req: AuthenticatedRequest,
  input: Record<string, unknown> = {},
): boolean {
  return (
    isAppSession(req) &&
    ![input.agent_session_id, input.agent_session_token].some(
      (value) => typeof value === "string" && value.trim(),
    )
  );
}

/**
 * Whether a write may be trusted to come from our own UI: cookie-authenticated
 * writes must carry this app's own Origin (CSRF). A native bearer session
 * uses no ambient cookie and needs none, and a read changes nothing.
 */
export function isSameOriginCookieWrite(req: AuthenticatedRequest): boolean {
  if (parseBearerAuthorization(req.headers.authorization).kind === "token") return true;
  if (["GET", "HEAD"].includes(req.method)) return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  const expected = process.env.LETAGENTS_BASE_URL || process.env.PUBLIC_API_URL;
  return expected ? origin === new URL(expected).origin : origin === `${req.protocol}://${req.get("host")}`;
}

export const CROSS_SITE_WRITE_REFUSED = "Open this action from LetAgents.";

export function requireAppSession(
  req: AuthenticatedRequest,
  res: Response,
): string | null {
  if (!isAppSession(req)) {
    res
      .status(req.authKind ? 403 : 401)
      .json({ error: "Sign in to LetAgents to open private messages." });
    return null;
  }
  if (!isSameOriginCookieWrite(req)) {
    res.status(403).json({ error: CROSS_SITE_WRITE_REFUSED });
    return null;
  }
  return req.sessionAccount!.account_id;
}
