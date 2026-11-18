import { ApiError } from "../../../shared/api/core.mjs";
import { inProcessPrincipal } from "../remote-mcp/in-process-dispatch.js";
import { classifyRoomAccess, decideRoomRead, roomAccessPrincipal } from "../rooms/access-decision.js";
import { resolveExistingRoomRequest } from "../rooms/resolution.js";
import { normalizeRoomId } from "../rooms/routing.js";
import type { ApiCallerIdentifier, ApiRoomAccessResolver } from "./context.js";

// GitHub gave no answer to the repository access check; the same wait the
// older room routes send in Retry-After.
const ACCESS_RETRY_AFTER_MS = 30_000;

/**
 * Who sent the request. Today: a person signed in with an app session or an
 * owner token. A remote MCP session's call arrives in process with the
 * person's owner token; it is marked as that integration. Agents and page
 * grants (`page_grant`) are added here with the full actor chain.
 */
export const identifyCaller: ApiCallerIdentifier = async (req) => {
  const account = req.sessionAccount ?? null;
  if (!account || !req.authKind) return null;
  if (req.authKind !== "session" && req.authKind !== "owner_token") {
    throw new ApiError("not_granted", "This credential cannot use the LetAgents API yet.");
  }
  return {
    principal: { kind: "person", id: account.account_id, login: account.login },
    ...(req.authKind === "owner_token" && inProcessPrincipal(req) ? { via: { kind: "integration" as const, id: "remote-mcp" } } : {}),
    account,
  };
};

/**
 * The room in the URL, and whether this caller may read it. Room ids with
 * slashes (github.com/owner/repo) arrive as one encoded segment. Join codes
 * are not room ids here: a code admits, it does not name.
 */
export const resolveRoomAccess: ApiRoomAccessResolver = async (caller, roomParam) => {
  const room = roomParam ? await resolveExistingRoomRequest(normalizeRoomId(roomParam)) : undefined;
  if (!room) throw new ApiError("not_found", "Room not found.");

  const decision = await decideRoomRead({ project: room, principal: roomAccessPrincipal(caller.account) });
  switch (decision.kind) {
    case "allow":
      break;
    case "auth_required":
      throw new ApiError("unauthenticated", "Sign in to LetAgents to open this room.");
    case "indeterminate":
      throw new ApiError("source_unavailable", "GitHub did not answer the room access check. Try again shortly.", {
        retryAfterMs: ACCESS_RETRY_AFTER_MS,
      });
    default:
      throw new ApiError("not_participant", "You are not a participant in this room.");
  }

  return {
    actor: { principal: caller.principal, ...(caller.via ? { via: caller.via } : {}), roomId: room.id },
    room,
    access: decision.target ?? (await classifyRoomAccess(room)),
  };
};
