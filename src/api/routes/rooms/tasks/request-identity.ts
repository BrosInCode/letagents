import type { Response } from "express";

import type { AuthenticatedRequest } from "../../../http/helpers.js";
import {
  requireWorkerRequestAgentIdentity,
  type ResolvedRequestAgentIdentity,
} from "../../../request/agent-identity.js";

export type OwnerTokenWorkerWriteIdentity =
  | { kind: "not_owner_token" }
  | { kind: "worker"; identity: ResolvedRequestAgentIdentity }
  | { kind: "responded" };

export async function resolveOwnerTokenWorkerWriteIdentity(input: {
  req: AuthenticatedRequest;
  res: Response;
  room_id: string;
  body: Record<string, unknown>;
}): Promise<OwnerTokenWorkerWriteIdentity> {
  if (input.req.authKind !== "owner_token" && input.req.authKind !== "agent_session") {
    return { kind: "not_owner_token" };
  }

  const result = await requireWorkerRequestAgentIdentity({
    req: input.req,
    body: input.body,
    room_id: input.room_id,
  });
  if (!result.ok) {
    input.res.status(result.status).json({ error: result.error });
    return { kind: "responded" };
  }

  return { kind: "worker", identity: result.identity };
}
