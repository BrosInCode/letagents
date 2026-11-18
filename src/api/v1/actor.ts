import { ApiError } from "../../../shared/api/core.mjs";
import { classifyRoomAccess, decideRoomRead, roomAccessPrincipal } from "../rooms/access-decision.js";
import { resolveExistingRoomRequest } from "../rooms/resolution.js";
import { normalizeRoomId } from "../rooms/routing.js";
import type { ApiActorResolver } from "./context.js";

// GitHub gave no answer to the repository access check; the same wait the
// older room routes send in Retry-After.
const ACCESS_RETRY_AFTER_MS = 30_000;

/**
 * The first actor resolver: a person signed in with an app session or an
 * owner token, in a room they may read. Agents, pages (`page_grant`), jobs
 * and integrations come with the full actor chain, which replaces this file.
 */
export const resolveApiActor: ApiActorResolver = async (req, roomParam) => {
  const account = req.sessionAccount ?? null;
  if (!account || !req.authKind) throw new ApiError("unauthenticated", "Sign in to LetAgents to use the API.");
  if (req.authKind !== "session" && req.authKind !== "owner_token") {
    throw new ApiError("not_granted", "This credential cannot use the LetAgents API yet.");
  }

  // Room ids with slashes (github.com/owner/repo) arrive as one encoded
  // segment. Join codes are not room ids here: a code admits, it does not name.
  const room = roomParam ? await resolveExistingRoomRequest(normalizeRoomId(roomParam)) : undefined;
  if (!room) throw new ApiError("not_found", "Room not found.");

  const decision = await decideRoomRead({ project: room, principal: roomAccessPrincipal(account) });
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
    actor: {
      principal: { kind: "person", id: account.account_id, login: account.login },
      roomId: room.id,
    },
    room,
    access: decision.target ?? (await classifyRoomAccess(room)),
    account,
  };
};
