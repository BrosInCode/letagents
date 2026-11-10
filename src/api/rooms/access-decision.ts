/**
 * The one decision for "may this principal read this room" and "is this
 * principal an admin of this room". Every route, stream, push and background
 * job asks here; each keeps its own way of answering (an HTTP reply, closing a
 * socket, skipping a room, a null count).
 *
 * How a room is decided:
 * 1. The access room is the room itself, or the parent of a focus room.
 * 2. The room is a repo room when its access room id is `host/owner/repo`, or
 *    when the access room or the room has a GitHub binding. Otherwise it is a
 *    membership room.
 * 3. A membership room admits a row in `room_members` or `project_admins` on
 *    the access room. An admin row on a focus room counts only for a member of
 *    the parent.
 * 4. A repo room admits the person's GitHub role on the repository: any role
 *    on a private repository, triage or higher on a public one. Only
 *    github.com repositories can be checked; any other host is refused.
 * 5. A worker bearer is scoped to one room and never follows its owner.
 * 6. When GitHub gives no answer the read is `indeterminate`, never a "no",
 *    and nothing is cached as a "no". The caller's outage policy can turn
 *    that into a throw instead.
 */
import type { GitRoomBinding, OwnerTokenAccount, Project, SessionAccount } from "../db.js";
import { assignProjectAdmin, getGitRoomBindingForRoom, isProjectAdmin } from "../db.js";
import { getRoomMemberRole } from "../db/room-members.js";
import {
  GitHubAccessUnavailableError,
  isGitHubRepoAdmin,
  parseGitHubRepoName,
  resolveGitHubRepoRoomAccessDecision,
  type RepoRoomAccessDecision,
} from "../github/repo-access.js";
import { isRepoBackedRoomId } from "./room-ids.js";

export type RoomAccessAccount = Pick<
  SessionAccount | OwnerTokenAccount,
  "account_id" | "provider" | "login" | "provider_access_token"
>;

export type RoomRole = "admin" | "participant" | "anonymous";

export type RepoRoomAccessDenial = Exclude<RepoRoomAccessDecision, { kind: "allow" }>;

/**
 * Who asks.
 * - `person`: a signed-in person with the GitHub credential the check may use.
 * - `account`: a known account id with no credential loaded. It is enough for
 *   a membership room; a repo room answers `auth_required` for it.
 * - `worker`: a worker bearer scoped to one room.
 */
export type RoomAccessPrincipal =
  | { kind: "anonymous" }
  | { kind: "person"; account: RoomAccessAccount }
  | { kind: "account"; accountId: string }
  | { kind: "worker"; roomId: string | null };

export function roomAccessPrincipal(account: RoomAccessAccount | null | undefined): RoomAccessPrincipal {
  return account ? { kind: "person", account } : { kind: "anonymous" };
}

/** What the room is decided by. */
export type RoomAccessTarget =
  | { kind: "membership"; accessRoomId: string }
  | {
    kind: "repo";
    accessRoomId: string;
    /** The room the refusal names: the access room, or the bound room. */
    roomName: string;
    /** `github.com/owner/repo` (or the repo-shaped id itself). */
    repoRoomName: string;
    binding: GitRoomBinding | null;
  };

/** `cached` may use the positive GitHub cache; `fresh` asks GitHub now. */
export type RoomAccessFreshness = "cached" | "fresh";

/**
 * What a repo room's check does when GitHub gives no answer.
 * - `indeterminate` (default): the result kind is `indeterminate`.
 * - `throw`: throw GitHubAccessUnavailableError (a caller with no reply of its own).
 * - `revalidation`: authority revalidation; any unanswered GitHub response,
 *   a 401 or a plain 403 included, throws, so a grant is never revoked on doubt.
 */
export type RoomAccessOutagePolicy = "indeterminate" | "throw" | "revalidation";

/**
 * The admin check adds `stored_row`: the stored admin row decides while GitHub
 * gives no answer. Only the background tracker-rule owner check uses it.
 */
export type RoomAdminOutagePolicy = RoomAccessOutagePolicy | "stored_row";

export type RoomReadDecision =
  | { kind: "allow"; target: RoomAccessTarget | null; repo: RepoRoomAccessDecision | null }
  | { kind: "auth_required"; target: RoomAccessTarget | null; repo: RepoRoomAccessDecision | null }
  | { kind: "membership_required"; target: RoomAccessTarget; repo: null }
  | { kind: "repo_access_denied"; target: RoomAccessTarget; repo: RepoRoomAccessDenial }
  | { kind: "indeterminate"; target: RoomAccessTarget; repo: { kind: "repo_access_unavailable" } }
  | { kind: "worker_scope_mismatch"; target: null; repo: null };

export type RoomAdminDecision = RoomReadDecision & { role: RoomRole };

export interface RoomAccessDecisionDeps {
  getGitRoomBindingForRoom(roomId: string): Promise<GitRoomBinding | null>;
  resolveRepoRoomAccessDecision(input: {
    roomName: string;
    sessionAccount: RoomAccessAccount | null | undefined;
    freshCollaboratorCheck?: boolean;
    throwOnIndeterminate?: boolean;
  }): Promise<RepoRoomAccessDecision>;
}

export interface RoomAccessInput {
  project: Project;
  principal: RoomAccessPrincipal;
  freshness?: RoomAccessFreshness;
  /** A classification the caller already made, so the room is not classified twice. */
  target?: RoomAccessTarget;
}

export function getProjectAccessRoomId(project: Project): string {
  return project.parent_room_id ?? project.id;
}

/** The repo room a repo-shaped room id names, for any host. */
export async function resolveRepoRoomAccessDecision(input: {
  roomName: string;
  sessionAccount: RoomAccessAccount | null | undefined;
  freshCollaboratorCheck?: boolean;
  throwOnIndeterminate?: boolean;
}): Promise<RepoRoomAccessDecision> {
  if (!isRepoBackedRoomId(input.roomName)) {
    return { kind: "allow" };
  }

  // Fail closed before any provider lookup: a `host/owner/repo` id on any host
  // other than github.com has no visibility or collaborator check to run.
  if (!parseGitHubRepoName(input.roomName)) {
    return { kind: "unsupported_repo_provider" };
  }

  return resolveGitHubRepoRoomAccessDecision(input);
}

const defaultDeps: RoomAccessDecisionDeps = {
  getGitRoomBindingForRoom,
  resolveRepoRoomAccessDecision,
};

function gitRoomBindingRepoRoomName(binding: GitRoomBinding): string | null {
  if (binding.provider !== "github") {
    return null;
  }

  return `${binding.host}/${binding.repository_full_name}`;
}

/** The repository a room is decided by, or null for a membership room. */
export async function resolveProjectRepoAccessTarget(
  project: Project,
  deps: Pick<RoomAccessDecisionDeps, "getGitRoomBindingForRoom"> = defaultDeps,
): Promise<{
  roomName: string;
  repoRoomName: string;
  binding: GitRoomBinding | null;
} | null> {
  const accessRoomId = getProjectAccessRoomId(project);
  if (isRepoBackedRoomId(accessRoomId)) {
    return {
      roomName: accessRoomId,
      repoRoomName: accessRoomId,
      binding: null,
    };
  }

  const candidateRoomIds = [...new Set([accessRoomId, project.id])];
  for (const roomId of candidateRoomIds) {
    const binding = await deps.getGitRoomBindingForRoom(roomId);
    if (!binding) {
      continue;
    }

    const repoRoomName = gitRoomBindingRepoRoomName(binding);
    if (!repoRoomName) {
      continue;
    }

    return {
      roomName: roomId,
      repoRoomName,
      binding,
    };
  }

  return null;
}

/** Repo room or membership room. */
export async function classifyRoomAccess(
  project: Project,
  deps: Pick<RoomAccessDecisionDeps, "getGitRoomBindingForRoom"> = defaultDeps,
): Promise<RoomAccessTarget> {
  const accessRoomId = getProjectAccessRoomId(project);
  const repo = await resolveProjectRepoAccessTarget(project, deps);
  return repo ? { kind: "repo", accessRoomId, ...repo } : { kind: "membership", accessRoomId };
}

/**
 * The batch form of classifyRoomAccess for top-level rooms (no focus rooms):
 * one binding read for all of them.
 */
export function classifyTopLevelRoomIds(
  roomIds: readonly string[],
  bindings: ReadonlyMap<string, GitRoomBinding>,
): Map<string, RoomAccessTarget["kind"]> {
  const kinds = new Map<string, RoomAccessTarget["kind"]>();
  for (const roomId of roomIds) {
    const binding = bindings.get(roomId);
    kinds.set(
      roomId,
      isRepoBackedRoomId(roomId) || (binding && gitRoomBindingRepoRoomName(binding)) ? "repo" : "membership",
    );
  }
  return kinds;
}

interface InternalReadDecision {
  decision: RoomReadDecision;
  /** The member role on the access room, read for a membership room. */
  memberRole: "admin" | "member" | null;
}

async function decide(
  input: RoomAccessInput & { outage?: RoomAccessOutagePolicy },
  deps: RoomAccessDecisionDeps,
): Promise<InternalReadDecision> {
  const { project, principal } = input;
  if (principal.kind === "worker") {
    return {
      decision: principal.roomId === project.id
        ? { kind: "allow", target: null, repo: null }
        : { kind: "worker_scope_mismatch", target: null, repo: null },
      memberRole: null,
    };
  }

  // Every room needs a sign-in, so no lookup can admit a caller without one.
  // A repo-shaped id on a host other than github.com keeps its own refusal:
  // no sign-in could open it.
  const accessRoomId = getProjectAccessRoomId(project);
  if (principal.kind === "anonymous") {
    if (isRepoBackedRoomId(accessRoomId) && !parseGitHubRepoName(accessRoomId)) {
      return {
        decision: {
          kind: "repo_access_denied",
          target: input.target
            ?? { kind: "repo", accessRoomId, roomName: accessRoomId, repoRoomName: accessRoomId, binding: null },
          repo: { kind: "unsupported_repo_provider" },
        },
        memberRole: null,
      };
    }
    return {
      decision: {
        kind: "auth_required",
        target: input.target ?? null,
        repo: input.target?.kind === "repo" ? { kind: "auth_required" } : null,
      },
      memberRole: null,
    };
  }

  const target = input.target ?? await classifyRoomAccess(project, deps);
  const accountId = principal.kind === "person" ? principal.account.account_id : principal.accountId;
  if (target.kind === "membership") {
    const memberRole = await getRoomMemberRole(target.accessRoomId, accountId);
    return {
      decision: memberRole
        ? { kind: "allow", target, repo: null }
        : { kind: "membership_required", target, repo: null },
      memberRole,
    };
  }

  if (principal.kind === "account") {
    // No credential to ask GitHub with.
    return { decision: { kind: "auth_required", target, repo: { kind: "auth_required" } }, memberRole: null };
  }

  const repo = await deps.resolveRepoRoomAccessDecision({
    roomName: target.repoRoomName,
    sessionAccount: principal.account,
    freshCollaboratorCheck: input.freshness === "fresh",
    throwOnIndeterminate: input.outage === "revalidation",
  });
  switch (repo.kind) {
    case "allow":
      return { decision: { kind: "allow", target, repo }, memberRole: null };
    case "auth_required":
      return { decision: { kind: "auth_required", target, repo }, memberRole: null };
    case "repo_access_unavailable":
      if (input.outage === "throw") throw new GitHubAccessUnavailableError(null);
      return { decision: { kind: "indeterminate", target, repo }, memberRole: null };
    default:
      return { decision: { kind: "repo_access_denied", target, repo }, memberRole: null };
  }
}

/** May this principal read this room now. */
export async function decideRoomRead(
  input: RoomAccessInput & { outage?: RoomAccessOutagePolicy },
  deps: RoomAccessDecisionDeps = defaultDeps,
): Promise<RoomReadDecision> {
  return (await decide(input, deps)).decision;
}

/**
 * The read decision plus the principal's role. Only `role === "admin"` is an
 * admin. In a repo room an admin row counts only while GitHub still admits
 * the person; a GitHub owner or `admin` collaborator who can read the room
 * gets a stored admin row here.
 */
export async function decideRoomAdmin(
  input: RoomAccessInput & { outage?: RoomAdminOutagePolicy },
  deps: RoomAccessDecisionDeps = defaultDeps,
): Promise<RoomAdminDecision> {
  const { project, principal } = input;
  const outage = input.outage ?? "indeterminate";
  const { decision, memberRole } = await decide(
    { ...input, outage: outage === "stored_row" ? "indeterminate" : outage },
    deps,
  );
  if (principal.kind === "worker" || principal.kind === "anonymous") {
    // A worker bearer never holds a room role of its own.
    return { ...decision, role: principal.kind === "worker" && decision.kind === "allow" ? "participant" : "anonymous" };
  }
  const accountId = principal.kind === "person" ? principal.account.account_id : principal.accountId;
  const target = decision.target!;
  const accessRoomId = target.accessRoomId;

  if (target.kind === "membership") {
    // A focus-room admin row counts only for a member of the parent (the old
    // "first joiner" rule left such rows for strangers).
    if (!memberRole) return { ...decision, role: "anonymous" };
    if (memberRole === "admin") return { ...decision, role: "admin" };
    const focusAdmin = accessRoomId !== project.id && (await isProjectAdmin(project.id, accountId));
    return { ...decision, role: focusAdmin ? "admin" : "participant" };
  }

  const storedAdminRow = async () => (await isProjectAdmin(project.id, accountId))
    || (accessRoomId !== project.id && (await isProjectAdmin(accessRoomId, accountId)));

  if (decision.kind === "indeterminate") {
    if (outage === "stored_row") {
      // GitHub gave no answer: the stored row decides, as before the repo check.
      return { ...decision, role: (await storedAdminRow()) ? "admin" : "participant" };
    }
    return { ...decision, role: "participant" };
  }

  // An admin row is never removed when someone leaves the repository, so it
  // counts only while GitHub still admits the person to the room now.
  if (decision.kind !== "allow" || principal.kind !== "person") {
    return { ...decision, role: "participant" };
  }

  if (await storedAdminRow()) return { ...decision, role: "admin" };

  const account = principal.account;
  if (parseGitHubRepoName(target.repoRoomName) && account.provider === "github") {
    const eligible = await isGitHubRepoAdmin({
      roomName: target.repoRoomName,
      login: account.login,
      accessToken: account.provider_access_token ?? "",
    });
    if (eligible) {
      await assignProjectAdmin(project.id, accountId);
      return { ...decision, role: "admin" };
    }
  }

  return { ...decision, role: "participant" };
}
