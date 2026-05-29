import type { Response } from "express";

import type { AuthenticatedRequest } from "../../http/helpers.js";
import type { RentalInternalRouteDeps } from "./types.js";
import { isRentEnabled } from "./validation.js";

export function requireRentEnabled(res: Response): boolean {
  if (!isRentEnabled()) {
    res.status(404).json({ error: "rent_disabled" });
    return false;
  }
  return true;
}

export function requireAccountId(req: AuthenticatedRequest, res: Response): string | null {
  const sa = req.sessionAccount;
  if (!sa) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return sa.account_id;
}

export async function emitRentalActivity(
  deps: RentalInternalRouteDeps,
  sessionId: string,
  eventType: string,
  source: "agent" | "patch_gate" | "tool" | "system",
  payload: Record<string, unknown>,
): Promise<void> {
  const session = await deps.getSessionLifecycle(sessionId);
  if (!session?.room_id) return;
  await deps.emitActivityEvent({
    sessionId,
    roomId: session.room_id,
    eventType: eventType as any,
    source,
    payload,
    verified: source !== "agent",
  });
}

export async function requireSessionAccess(
  req: AuthenticatedRequest,
  res: Response,
  deps: RentalInternalRouteDeps,
): Promise<string | null> {
  if (!requireRentEnabled(res)) return null;
  const accountId = requireAccountId(req, res);
  if (!accountId) return null;

  const sessionId = req.params.id as string;
  const access = await deps.resolveSessionAccess(sessionId, accountId);
  if (!access) {
    res.status(404).json({ error: "session not found" });
    return null;
  }
  return sessionId;
}
