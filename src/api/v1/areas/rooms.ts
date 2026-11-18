import { getRoom, type RoomRepo, type RoomSummary } from "../../../../shared/api/rooms.mjs";
import { getGitRoomBindingForRoom, type GitRoomBinding, type Project } from "../../db.js";
import { parseGitHubRepoName } from "../../github/repo-access.js";
import type { RoomAccessTarget } from "../../rooms/access-decision.js";
import { defineRoute, type ApiRoute } from "../route.js";

// Routes for the methods in shared/api/rooms.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  defineRoute(getRoom, async (_input, { room, access }) => toRoomSummary(room, access, await repoBinding(room, access))),
];

/**
 * A room named like its repository (github.com/owner/repo) is decided by its
 * name, so the access check reads no binding; the binding still holds the
 * visibility and the ref. The room's own binding (a branch room's) comes first.
 */
async function repoBinding(room: Project, access: RoomAccessTarget): Promise<GitRoomBinding | null> {
  if (access.kind !== "repo") return null;
  if (access.binding) return access.binding;
  for (const roomId of new Set([room.id, access.accessRoomId])) {
    const binding = await getGitRoomBindingForRoom(roomId);
    if (binding) return binding;
  }
  return null;
}

export function toRoomSummary(room: Project, access: RoomAccessTarget, binding: GitRoomBinding | null): RoomSummary {
  return {
    id: room.id,
    name: room.display_name,
    kind: room.kind,
    parentRoomId: room.parent_room_id,
    repo: access.kind === "repo" ? toRoomRepo(access, binding) : null,
    visibility: access.kind === "repo" ? binding?.visibility ?? "unknown" : "members",
  };
}

function toRoomRepo(access: Extract<RoomAccessTarget, { kind: "repo" }>, binding: GitRoomBinding | null): RoomRepo | null {
  if (binding) {
    return {
      provider: binding.provider,
      host: binding.host,
      owner: binding.repository_owner,
      name: binding.repository_name,
      fullName: binding.repository_full_name,
      url: `https://${binding.host}/${binding.repository_full_name}`,
      ref: { type: binding.ref_type, name: binding.ref_name },
    };
  }
  // A repo-shaped room with no binding row yet: the name is the repository.
  const repo = parseGitHubRepoName(access.repoRoomName);
  if (!repo) return null;
  return {
    provider: "github",
    host: "github.com",
    owner: repo.owner,
    name: repo.repo,
    fullName: `${repo.owner}/${repo.repo}`,
    url: `https://github.com/${repo.owner}/${repo.repo}`,
    ref: null,
  };
}
