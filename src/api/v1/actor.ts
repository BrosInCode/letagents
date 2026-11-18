import { ApiError } from "../../../shared/api/core.mjs";
import { inProcessPrincipal } from "../remote-mcp/in-process-dispatch.js";
import { classifyRoomAccess, decideRoomRead, roomAccessPrincipal, type RoomAccessPrincipal } from "../rooms/access-decision.js";
import { resolveExistingRoomRequest } from "../rooms/resolution.js";
import { normalizeRoomId } from "../rooms/routing.js";
import type { ApiCallerIdentifier, ApiRoomAccessResolver } from "./context.js";

// GitHub gave no answer to the repository access check; the same wait the
// older room routes send in Retry-After.
const ACCESS_RETRY_AFTER_MS = 30_000;

/** A remote MCP session (ChatGPT, Claude connectors) calls with the person's owner token, through this integration. */
export const REMOTE_MCP_INTEGRATION_ID = "remote-mcp";

/**
 * Who sent the request:
 * - an app session or an owner token: the person. A remote MCP session's
 *   call arrives in process with the person's owner token; it is marked as
 *   that integration.
 * - a worker bearer: the agent, bound to its session's room.
 * - a page grant: the person who opened the page, through that page
 *   version, bound to the room it was minted for.
 * Supervisor grants (and MCP OAuth tokens, which the middleware keeps on
 * /mcp) are not API credentials: `not_granted`.
 */
export const identifyCaller: ApiCallerIdentifier = async (req) => {
  const account = req.sessionAccount ?? null;
  switch (req.authKind) {
    case "session":
    case "owner_token":
      if (!account) return null;
      return {
        principal: { kind: "person", id: account.account_id, login: account.login },
        ...(req.authKind === "owner_token" && inProcessPrincipal(req)
          ? { via: { kind: "integration" as const, id: REMOTE_MCP_INTEGRATION_ID } }
          : {}),
        account,
      };
    case "agent_session": {
      const session = req.agentSession;
      if (!session) return null;
      return { principal: { kind: "agent", id: session.agent_key }, account: null, roomId: session.room_id };
    }
    case "page_grant": {
      const grant = req.pageGrant;
      if (!account || !grant) return null;
      return {
        principal: { kind: "person", id: account.account_id, login: account.login },
        via: { kind: "page", id: grant.page_id, version: grant.page_version },
        account,
        roomId: grant.room_id,
      };
    }
    case "supervisor_grant":
    case "mcp_oauth":
      throw new ApiError("not_granted", "This credential cannot use the LetAgents API.");
    default:
      return null;
  }
};

/**
 * The room in the URL, and whether this caller may read it. A page grant
 * opens only its own room: `not_granted` elsewhere, before any lookup that
 * could tell whether another room exists. A worker opens only its session's
 * room. Room access then runs as the person behind the call, so a grant
 * never opens a room its person cannot: `not_participant`. Room ids with
 * slashes (github.com/owner/repo) arrive as one encoded segment. Join codes
 * are not room ids here: a code admits, it does not name.
 */
export const resolveRoomAccess: ApiRoomAccessResolver = async (caller, roomParam) => {
  const room = roomParam ? await resolveExistingRoomRequest(normalizeRoomId(roomParam)) : undefined;
  if (caller.via?.kind === "page" && (!caller.roomId || room?.id !== caller.roomId)) {
    throw new ApiError("not_granted", "This page may only use the room it is pinned in.");
  }
  if (!room) throw new ApiError("not_found", "Room not found.");

  const principal: RoomAccessPrincipal = caller.principal.kind === "agent"
    ? { kind: "worker", roomId: caller.roomId ?? null }
    : roomAccessPrincipal(caller.account);
  const decision = await decideRoomRead({ project: room, principal });
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
