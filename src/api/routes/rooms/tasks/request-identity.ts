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

function hasAgentSessionCredentials(input: Record<string, unknown>): boolean {
  return (typeof input.agent_session_id === "string" && input.agent_session_id.trim().length > 0)
    || (typeof input.agent_session_token === "string" && input.agent_session_token.trim().length > 0);
}

function isDesktopHumanClient(req: AuthenticatedRequest): boolean {
  return req.authKind === "owner_token"
    && req.headers?.["x-letagents-desktop-client"] === "1";
}

function hasDesktopHumanBodyMarker(body: Record<string, unknown>): boolean {
  return body.desktop_human_client === true || body.desktop_human_client === "true";
}

export function isDesktopHumanTaskWriteForTest(req: AuthenticatedRequest, body: Record<string, unknown>): boolean {
  return req.authKind === "owner_token"
    && (isDesktopHumanClient(req) || hasDesktopHumanBodyMarker(body))
    && !hasAgentSessionCredentials(body);
}

export function isDesktopHumanWrite(req: AuthenticatedRequest, body: Record<string, unknown>): boolean {
  return isDesktopHumanTaskWriteForTest(req, body);
}

export async function resolveOwnerTokenWorkerWriteIdentity(input: {
  req: AuthenticatedRequest;
  res: Response;
  room_id: string;
  body: Record<string, unknown>;
}): Promise<OwnerTokenWorkerWriteIdentity> {
  if (input.req.authKind !== "owner_token") {
    return { kind: "not_owner_token" };
  }
  if (isDesktopHumanWrite(input.req, input.body)) {
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
