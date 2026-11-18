import type { ActorVia, ApiActor } from "../../../shared/api/actor.mjs";
import { ApiError } from "../../../shared/api/core.mjs";
import type { OwnerTokenAccount, SessionAccount } from "../db.js";
import type { AuthenticatedRequest, PageGrantRequestGrant } from "../http/helpers.js";
import { inProcessPrincipal } from "../remote-mcp/in-process-dispatch.js";
import { classifyRoomAccess, decideRoomRead, roomAccessPrincipal, type RoomAccessPrincipal } from "../rooms/access-decision.js";
import { resolveExistingRoomRequest } from "../rooms/resolution.js";
import { normalizeRoomId } from "../rooms/routing.js";
import type { ApiActorResolver, ResolvedApiActor } from "./context.js";

// GitHub gave no answer to the repository access check; the same wait the
// older room routes send in Retry-After.
const ACCESS_RETRY_AFTER_MS = 30_000;

/** A remote MCP session (ChatGPT, Claude connectors) calls with the person's owner token, through this integration. */
export const REMOTE_MCP_INTEGRATION_ID = "remote-mcp";

/**
 * Who is calling, before any room is looked at.
 * - `person`: an app session or an owner token. A remote MCP session's
 *   in-process call is a person through the `remote-mcp` integration.
 * - `agent`: a worker bearer, bound to the one room of its session.
 * - `page`: a page grant, the person who opened the page, bound to the one
 *   room and page version it was minted for.
 */
export type ApiCallerIdentity =
  | { kind: "person"; account: SessionAccount | OwnerTokenAccount; via?: ActorVia }
  | { kind: "agent"; agentKey: string; roomId: string }
  | { kind: "page"; account: SessionAccount | OwnerTokenAccount; grant: PageGrantRequestGrant };

/**
 * Step 1 of the pipeline: the caller from the request's credential. Throws
 * `unauthenticated` without one, `not_granted` for a credential the API does
 * not take (supervisor grants; MCP OAuth tokens never get here, the
 * middleware keeps them on /mcp).
 */
export function identifyCaller(req: AuthenticatedRequest): ApiCallerIdentity {
  switch (req.authKind) {
    case "session":
    case "owner_token": {
      const account = req.sessionAccount;
      if (!account) break;
      return inProcessPrincipal(req)
        ? { kind: "person", account, via: { kind: "integration", id: REMOTE_MCP_INTEGRATION_ID } }
        : { kind: "person", account };
    }
    case "agent_session": {
      const session = req.agentSession;
      if (!session) break;
      return { kind: "agent", agentKey: session.agent_key, roomId: session.room_id };
    }
    case "page_grant": {
      if (!req.sessionAccount || !req.pageGrant) break;
      return { kind: "page", account: req.sessionAccount, grant: req.pageGrant };
    }
    case "supervisor_grant":
    case "mcp_oauth":
      throw new ApiError("not_granted", "This credential cannot use the LetAgents API.");
    default:
      break;
  }
  throw new ApiError("unauthenticated", "Sign in to LetAgents to use the API.");
}

/** The actor as far as it is known before the room: what the per-actor rate limit counts. */
export function callerActor(identity: ApiCallerIdentity, roomId: string): ApiActor {
  switch (identity.kind) {
    case "person":
      return {
        principal: { kind: "person", id: identity.account.account_id, login: identity.account.login },
        ...(identity.via ? { via: identity.via } : {}),
        roomId,
      };
    case "agent":
      return { principal: { kind: "agent", id: identity.agentKey }, roomId };
    case "page":
      return {
        principal: { kind: "person", id: identity.account.account_id, login: identity.account.login },
        via: { kind: "page", id: identity.grant.page_id, version: identity.grant.page_version },
        roomId,
      };
  }
}

/**
 * Step 2: the room in the URL, and whether the caller may read it. A page
 * grant opens only its own room (`not_granted` elsewhere, before any lookup
 * that could tell whether another room exists); a worker only its session's
 * room. Room access then runs as the person behind the call, so a grant
 * never opens a room its person cannot: `not_participant`.
 */
export async function resolveRoomAccess(identity: ApiCallerIdentity, roomParam: string): Promise<ResolvedApiActor> {
  // Room ids with slashes (github.com/owner/repo) arrive as one encoded
  // segment. Join codes are not room ids here: a code admits, it does not name.
  const room = roomParam ? await resolveExistingRoomRequest(normalizeRoomId(roomParam)) : undefined;
  if (identity.kind === "page" && room?.id !== identity.grant.room_id) {
    throw new ApiError("not_granted", "This page may only use the room it is pinned in.");
  }
  if (!room) throw new ApiError("not_found", "Room not found.");

  const principal: RoomAccessPrincipal = identity.kind === "agent"
    ? { kind: "worker", roomId: identity.roomId }
    : roomAccessPrincipal(identity.account);
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
    actor: callerActor(identity, room.id),
    room,
    access: decision.target ?? (await classifyRoomAccess(room)),
    account: identity.kind === "agent" ? null : identity.account,
  };
}

/** Both steps, for the router: the caller, then the room. */
export const resolveApiActor: ApiActorResolver = async (req, roomParam) => resolveRoomAccess(identifyCaller(req), roomParam);
