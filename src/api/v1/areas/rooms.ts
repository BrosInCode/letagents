import { ApiError } from "../../../../shared/api/core.mjs";
import {
  getRoom,
  listRoomPolicies,
  setRoomPolicy,
  type RoomApiPolicies,
  type RoomRepo,
  type RoomSummary,
} from "../../../../shared/api/rooms.mjs";
import { getGitRoomBindingForRoom, type GitRoomBinding, type Project } from "../../db.js";
import { parseGitHubRepoName } from "../../github/repo-access.js";
import { isHumanAppWrite, isSameOriginCookieWrite } from "../../request/app-session.js";
import { decideRoomAdmin, roomAccessPrincipal, type RoomAccessTarget } from "../../rooms/access-decision.js";
import { setApiActionTarget } from "../actions.js";
import type { ApiCallContext } from "../context.js";
import * as policies from "../policy.js";
import { defineRoute, type ApiRoute } from "../route.js";

// Routes for the methods in shared/api/rooms.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  defineRoute(getRoom, async (_input, { room, access }) => toRoomSummary(room, access, await repoBinding(room, access))),
  defineRoute(listRoomPolicies, async (_input, call) => {
    await requireRoomAdminInPerson(call, false);
    return roomPolicies(call.room.id);
  }),
  defineRoute(setRoomPolicy, async ({ capability, mode }, call) => {
    // Owner tokens are what MCP agents hold, so a policy change needs the
    // person's own app session, from this app's origin.
    await requireRoomAdminInPerson(call, true);
    setApiActionTarget(call, capability);
    await policies.setRoomPolicy({ roomId: call.room.id, capability, mode, accountId: call.account!.account_id });
    return roomPolicies(call.room.id);
  }),
];

/**
 * A room admin acting for themselves: no page, no agent, no integration.
 * A write also needs an app session (not an owner token) and this app's origin.
 */
async function requireRoomAdminInPerson(call: ApiCallContext, write: boolean): Promise<void> {
  const refused = new ApiError("not_granted", "Only a room admin, signed in to LetAgents, can manage this room's API policy.");
  if (call.actor.principal.kind !== "person" || call.actor.via || !call.account) throw refused;
  if (write && (!isHumanAppWrite(call.req) || !isSameOriginCookieWrite(call.req))) throw refused;
  const decision = await decideRoomAdmin({ project: call.room, principal: roomAccessPrincipal(call.account), outage: "throw" });
  if (decision.role !== "admin") throw refused;
}

async function roomPolicies(roomId: string): Promise<RoomApiPolicies> {
  const list = await policies.listRoomPolicies(roomId);
  return { policies: list.map(({ capability, configured, source, rule }) => ({ capability, mode: configured, source, rule })) };
}

/**
 * A room named like its repository (github.com/owner/repo) is decided by its
 * name, so the access check reads no binding; the binding still holds the
 * visibility and the ref. The room's own binding (a branch room's) comes first.
 */
export async function repoBinding(room: Project, access: RoomAccessTarget): Promise<GitRoomBinding | null> {
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
