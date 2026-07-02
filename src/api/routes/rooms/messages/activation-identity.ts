import {
  LETAGENTS_AGENT_SESSION_ID_HEADER,
  LETAGENTS_AGENT_SESSION_TOKEN_HEADER,
} from "../../../../shared/request-headers.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import type { ResolvedRequestAgentIdentity } from "../../../request/agent-identity.js";

type ResolveRequestAgentIdentity = typeof import("../../../request/agent-identity.js").resolveRequestAgentIdentity;

type ResolveMessageActivationIdentityDeps = {
  resolveRequestAgentIdentity?: ResolveRequestAgentIdentity;
};

export async function resolveMessageActivationIdentity(
  req: AuthenticatedRequest,
  roomId: string,
  deps: ResolveMessageActivationIdentityDeps = {},
): Promise<ResolvedRequestAgentIdentity | null> {
  const agentSessionId = getOptionalHeaderString(req, LETAGENTS_AGENT_SESSION_ID_HEADER);
  const agentSessionToken = getOptionalHeaderString(req, LETAGENTS_AGENT_SESSION_TOKEN_HEADER);
  if (!agentSessionId || !agentSessionToken) {
    return null;
  }

  const resolveRequestAgentIdentity = deps.resolveRequestAgentIdentity ?? resolveDefaultRequestAgentIdentity;
  const identity = await resolveRequestAgentIdentity({
    req,
    room_id: roomId,
    agent_session_id: agentSessionId,
    agent_session_token: agentSessionToken,
  });

  return identity?.session_kind === "worker" ? identity : null;
}

async function resolveDefaultRequestAgentIdentity(
  input: Parameters<ResolveRequestAgentIdentity>[0],
): ReturnType<ResolveRequestAgentIdentity> {
  const { resolveRequestAgentIdentity } = await import("../../../request/agent-identity.js");
  return resolveRequestAgentIdentity(input);
}

function getOptionalHeaderString(req: AuthenticatedRequest, headerName: string): string | null {
  const normalized = String(req.get?.(headerName) ?? "").trim();
  return normalized || null;
}
