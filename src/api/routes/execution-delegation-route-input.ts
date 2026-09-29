import type { Response } from "express";

import type { AuthenticatedRequest } from "../http/helpers.js";

export function requiredExecutionDelegationString(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() === value && value.length > 0
    ? value
    : null;
}

export function executionDelegationInventoryQuery(
  req: AuthenticatedRequest,
  res: Response,
): { room_id: string; agent_key: string; after: string | null } | null {
  const query = req.query ?? {};
  if (Object.keys(query).some((key) => !["room_id", "agent_key", "after"].includes(key))) {
    res.status(400).json({ error: "Invalid execution delegation inventory request." });
    return null;
  }
  const bounded = (value: unknown, required: boolean): string | null => {
    if (value === undefined && !required) return null;
    return typeof value === "string"
      && value.length > 0
      && value.length <= 512
      && value.trim() === value
      && !/[\u0000-\u001f\u007f]/.test(value)
      ? value
      : null;
  };
  const roomId = bounded(query.room_id, true);
  const agentKey = bounded(query.agent_key, true);
  const after = bounded(query.after, false);
  if (!roomId || !agentKey || (query.after !== undefined && !after)) {
    res.status(400).json({ error: "Invalid execution delegation inventory request." });
    return null;
  }
  return { room_id: roomId, agent_key: agentKey, after };
}
