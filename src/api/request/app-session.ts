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
  // Cookie-authenticated writes must come from our own UI. Native bearer
  // sessions do not use ambient cookies and are not subject to CSRF.
  if (
    parseBearerAuthorization(req.headers.authorization).kind !== "token" &&
    !["GET", "HEAD"].includes(req.method)
  ) {
    const origin = req.headers.origin;
    const expected =
      process.env.LETAGENTS_BASE_URL || process.env.PUBLIC_API_URL;
    if (
      !origin ||
      (expected && origin !== new URL(expected).origin) ||
      (!expected && origin !== `${req.protocol}://${req.get("host")}`)
    ) {
      res.status(403).json({ error: "Open this action from LetAgents." });
      return null;
    }
  }
  return req.sessionAccount!.account_id;
}
