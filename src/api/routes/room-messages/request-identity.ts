import type { AuthenticatedRequest } from "../../http-helpers.js";
import { parseAgentActorLabel } from "../../../shared/agent-identity.js";

export function hasAgentSessionCredentials(input: {
  agent_session_id?: string;
  agent_session_token?: string;
}): boolean {
  return Boolean(
    (typeof input.agent_session_id === "string" && input.agent_session_id.trim())
      || (typeof input.agent_session_token === "string" && input.agent_session_token.trim())
  );
}

export function isAgentLikeSender(sender: unknown): boolean {
  if (typeof sender !== "string") {
    return false;
  }

  const parsed = parseAgentActorLabel(sender);
  return Boolean(parsed && (parsed.structured || parsed.owner_attribution || parsed.ide_label));
}

export function isDesktopHumanWrite(req: AuthenticatedRequest, input: {
  agent_session_id?: string;
  agent_session_token?: string;
}): boolean {
  return isDesktopHumanClient(req)
    && !hasAgentSessionCredentials(input)
    && req.authKind === "owner_token";
}

export function isDesktopHumanClient(req: AuthenticatedRequest): boolean {
  return req.authKind === "owner_token"
    && req.headers?.["x-letagents-desktop-client"] === "1";
}
