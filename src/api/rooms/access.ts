import type { Response } from "express";

import {
  repoCollaboratorRequiredBody,
  roomMembershipRequiredBody,
} from "../../../shared/room-membership.mjs";
import {
  assignProjectAdmin,
  getGitRoomBindingForRoom,
  getProjectById,
  isProjectAdmin,
  type GitRoomBinding,
  type OwnerTokenAccount,
  type Project,
  type SessionAccount,
} from "../db.js";
import {
  isGitHubRepoAdmin,
  parseGitHubRepoName,
  resolveGitHubRepoRoomAccessDecision,
  type RepoRoomAccessDecision,
} from "../github/repo-access.js";
import {
  sanitizeRedirectPath,
  type AuthenticatedRequest,
} from "../http/helpers.js";
import { resolveRequestAuth } from "../request/auth.js";
import { getLatestRoomJoinRequest, getRoomMemberRole } from "../db/room-members.js";
import { isRepoBackedRoomId } from "./room-ids.js";

export { isRepoBackedRoomId };
export type { RepoRoomAccessDecision };

export type RoomAccessAccount = Pick<
  SessionAccount | OwnerTokenAccount,
  "account_id" | "provider" | "login" | "provider_access_token"
>;

type RequestAccount = RoomAccessAccount | null | undefined;

export type RoomRole = "admin" | "participant" | "anonymous";

export type RepoRoomAccessDenial = Exclude<RepoRoomAccessDecision, { kind: "allow" }>;

export interface ProjectRepoAccessDecision {
  isRepoBacked: boolean;
  roomName: string | null;
  repoRoomName: string | null;
  binding: GitRoomBinding | null;
  decision: RepoRoomAccessDecision;
}

export interface ProjectRepoAccessDeps {
  getGitRoomBindingForRoom(roomId: string): Promise<GitRoomBinding | null>;
  resolveRepoRoomAccessDecision(input: {
    roomName: string;
    sessionAccount: RequestAccount;
    freshCollaboratorCheck?: boolean;
    throwOnIndeterminate?: boolean;
  }): Promise<RepoRoomAccessDecision>;
}

export function getProjectAccessRoomId(project: Project): string {
  return project.parent_room_id ?? project.id;
}

export function isRepoBackedProject(project: Project): boolean {
  return isRepoBackedRoomId(getProjectAccessRoomId(project));
}

const requestRepoAccessRoomNames = new WeakMap<AuthenticatedRequest, string>();
const requestUsesRepoAuthorization = new WeakMap<AuthenticatedRequest, boolean>();

/** Reuses the entry check's canonical cache key; falls back for worker paths. */
export async function resolveRequestProjectRepoAccessRoomName(
  req: AuthenticatedRequest,
  project: Project,
): Promise<string> {
  const resolved = requestRepoAccessRoomNames.get(req);
  if (resolved) return resolved;
  const target = await resolveProjectRepoAccessTarget(project, { getGitRoomBindingForRoom });
  return target?.repoRoomName ?? getProjectAccessRoomId(project);
}

function gitRoomBindingRepoRoomName(binding: GitRoomBinding): string | null {
  if (binding.provider !== "github") {
    return null;
  }

  return `${binding.host}/${binding.repository_full_name}`;
}

export async function resolveProjectRepoAccessTarget(
  project: Project,
  deps: Pick<ProjectRepoAccessDeps, "getGitRoomBindingForRoom"> = { getGitRoomBindingForRoom },
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

function getPublicBaseUrl(): string {
  const configuredBaseUrl = process.env.LETAGENTS_BASE_URL || process.env.PUBLIC_API_URL;
  if (configuredBaseUrl?.trim()) {
    return configuredBaseUrl.replace(/\/+$/, "");
  }

  return `http://localhost:${process.env.PORT || "3001"}`;
}

function buildDeviceFlowUrl(roomName: string): string {
  const url = new URL("/auth/device/start", `${getPublicBaseUrl()}/`);
  url.searchParams.set("room_id", roomName);
  return url.toString();
}

type LandingRedirectReason =
  | "repo_signin_required"
  | "repo_access_denied"
  | "repo_provider_unsupported";

function landingRedirectReason(decision: RepoRoomAccessDenial): LandingRedirectReason {
  switch (decision.kind) {
    case "auth_required":
      return "repo_signin_required";
    case "unsupported_repo_provider":
      return "repo_provider_unsupported";
    case "private_repo_no_access":
    case "repo_collaborator_required":
      return "repo_access_denied";
  }
}

function buildLandingRedirect(input: {
  reason: LandingRedirectReason;
  roomName: string;
  redirectTo: string;
}): string {
  const params = new URLSearchParams({
    reason: input.reason,
    room: input.roomName,
    redirect_to: sanitizeRedirectPath(input.redirectTo, "/"),
  });
  return `/?${params.toString()}`;
}

const UNSUPPORTED_REPO_PROVIDER_MESSAGE =
  "Repo rooms are supported for github.com repositories only";

/**
 * The refusal text for a repo-shaped room id on a host other than github.com.
 * Every reply names the host, explains the shape and gives the two ways out: a
 * name without two slashes, or a .letagents.json room field. People hit this
 * with names they did not expect to be repo-shaped (`team/design/ideas`), with
 * SSH config aliases (`github-work/acme/app`, `github.com-work/acme/app`) and
 * with hosts that are real but unsupported (`gitlab.com/group/sub/project`).
 */
export function unsupportedRepoProviderMessage(roomName: string): string {
  const host = roomName.split("/")[0] ?? "";
  if (!host) {
    return UNSUPPORTED_REPO_PROVIDER_MESSAGE;
  }

  return (
    `${UNSUPPORTED_REPO_PROVIDER_MESSAGE}. A room name shaped host/owner/repo, such as ${roomName}, ` +
    `is read as a repo room, here on the host '${host}'. ` +
    "For a plain room, use a name without two slashes, for example team-design-ideas. " +
    "If the host is an SSH config alias, put the real repository in a .letagents.json file " +
    'with a room field, for example {"room": "github.com/owner/repo"}.'
  );
}

export function replyRepoRoomAccessDecision(
  res: Response,
  roomName: string,
  decision: RepoRoomAccessDenial
): false {
  if (decision.kind === "auth_required") {
    res.status(401).json({
      error: "auth_required",
      code: "NOT_AUTHENTICATED",
      message: "Sign in to LetAgents to open this room",
      room_id: roomName,
      device_flow_url: buildDeviceFlowUrl(roomName),
    });
    return false;
  }

  if (decision.kind === "unsupported_repo_provider") {
    // Not a sign-in problem: no account can open a repo room on this host.
    res.status(403).json({
      error: "unsupported_repo_provider",
      code: "UNSUPPORTED_REPO_PROVIDER",
      message: unsupportedRepoProviderMessage(roomName),
      room_id: roomName,
    });
    return false;
  }

  if (decision.kind === "repo_collaborator_required") {
    res.status(403).json(repoCollaboratorRequiredBody({ room_id: roomName }));
    return false;
  }

  res.status(403).json({
    error: "private_repo_no_access",
    code: "PRIVATE_REPO_NO_ACCESS",
    message: "Authenticated account does not have access to this private repo room",
    room_id: roomName,
  });
  return false;
}

export async function resolveRepoRoomAccessDecision(input: {
  roomName: string;
  sessionAccount: RequestAccount;
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

export async function resolveProjectRepoRoomAccessDecision(input: {
  project: Project;
  sessionAccount: RequestAccount;
  freshCollaboratorCheck?: boolean;
  throwOnIndeterminate?: boolean;
}, deps: ProjectRepoAccessDeps = {
  getGitRoomBindingForRoom,
  resolveRepoRoomAccessDecision,
}): Promise<ProjectRepoAccessDecision> {
  const target = await resolveProjectRepoAccessTarget(input.project, deps);
  if (!target) {
    return {
      isRepoBacked: false,
      roomName: null,
      repoRoomName: null,
      binding: null,
      decision: { kind: "allow" },
    };
  }

  return {
    isRepoBacked: true,
    roomName: target.roomName,
    repoRoomName: target.repoRoomName,
    binding: target.binding,
    decision: await deps.resolveRepoRoomAccessDecision({
      roomName: target.repoRoomName,
      sessionAccount: input.sessionAccount,
      freshCollaboratorCheck: input.freshCollaboratorCheck,
      throwOnIndeterminate: input.throwOnIndeterminate,
    }),
  };
}

async function resolveProjectRoleForAccessDecision(
  project: Project,
  sessionAccount: RequestAccount,
  accessDecision: ProjectRepoAccessDecision
): Promise<RoomRole> {
  const accessRoomId = getProjectAccessRoomId(project);
  if (!sessionAccount) {
    return "anonymous";
  }

  if (
    (await isProjectAdmin(project.id, sessionAccount.account_id)) ||
    (accessRoomId !== project.id && (await isProjectAdmin(accessRoomId, sessionAccount.account_id)))
  ) {
    return "admin";
  }

  const adminRepoRoomName = accessDecision.repoRoomName ?? accessRoomId;
  if (parseGitHubRepoName(adminRepoRoomName) && sessionAccount.provider === "github") {
    const eligible = await isGitHubRepoAdmin({
      roomName: adminRepoRoomName,
      login: sessionAccount.login,
      accessToken: sessionAccount.provider_access_token ?? "",
    });

    if (eligible) {
      await assignProjectAdmin(project.id, sessionAccount.account_id);
      return "admin";
    }
  }

  return "participant";
}

export async function resolveProjectRole(
  project: Project,
  sessionAccount: RequestAccount
): Promise<RoomRole> {
  const accessRoomId = getProjectAccessRoomId(project);
  const repoBacked = isRepoBackedProject(project);

  return resolveProjectRoleForAccessDecision(project, sessionAccount, {
    isRepoBacked: repoBacked,
    roomName: repoBacked ? accessRoomId : null,
    repoRoomName: repoBacked ? accessRoomId : null,
    binding: null,
    decision: { kind: "allow" },
  });
}

export async function resolveGitRoomProjectRole(
  project: Project,
  sessionAccount: RequestAccount
): Promise<RoomRole> {
  const accessDecision = await resolveProjectRepoRoomAccessDecision({
    project,
    sessionAccount,
  });

  return resolveProjectRoleForAccessDecision(project, sessionAccount, accessDecision);
}

/** Whether the account is a member of the project's access room (its parent, for a focus room). */
export async function isProjectRoomMember(project: Project, accountId: string): Promise<boolean> {
  return (await getRoomMemberRole(getProjectAccessRoomId(project), accountId)) !== null;
}

export type RoomMembershipDecision =
  | { kind: "allow" }
  | { kind: "auth_required" }
  | { kind: "membership_required" };

/**
 * A room that is not tied to a repository admits its members only: the
 * members of the room, or of the parent of a focus room. A room admin is
 * always a member.
 */
export async function resolveRoomMembershipDecision(
  project: Project,
  sessionAccount: RequestAccount,
): Promise<RoomMembershipDecision> {
  if (!sessionAccount) return { kind: "auth_required" };
  const role = await getRoomMemberRole(getProjectAccessRoomId(project), sessionAccount.account_id);
  return role ? { kind: "allow" } : { kind: "membership_required" };
}

/**
 * No sign-in is a 401, so the MCP client starts its device flow. A signed-in
 * person who is not a member is a 403, never a 401: the MCP client deletes its
 * saved sign-in on any 401. The 403 carries the person's latest join request,
 * so a client can show "Ask to join", "Waiting" or "Declined" at once.
 */
export async function replyRoomMembershipDecision(
  res: Response,
  project: Project,
  sessionAccount: RequestAccount,
  decision: Exclude<RoomMembershipDecision, { kind: "allow" }>,
): Promise<false> {
  const accessRoomId = getProjectAccessRoomId(project);
  if (decision.kind === "auth_required" || !sessionAccount) {
    return replyRepoRoomAccessDecision(res, accessRoomId, { kind: "auth_required" });
  }
  const accessRoom = accessRoomId === project.id ? project : await getProjectById(accessRoomId);
  res.status(403).json(roomMembershipRequiredBody({
    room_id: project.id,
    display_name: accessRoom?.display_name ?? null,
    join_request: await getLatestRoomJoinRequest(accessRoomId, sessionAccount.account_id),
  }));
  return false;
}

export async function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  project: Project
): Promise<boolean> {
  if (req.authKind === "agent_session") {
    res.status(403).json({ error: "Worker bearers cannot perform owner or admin actions." });
    return false;
  }
  if (!req.sessionAccount) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }

  const role = await resolveProjectRole(project, req.sessionAccount);
  if (role !== "admin") {
    res.status(403).json({ error: "Admin privileges required" });
    return false;
  }

  return true;
}

export async function requireGitRoomAdmin(
  req: AuthenticatedRequest,
  res: Response,
  project: Project
): Promise<boolean> {
  if (req.authKind === "agent_session") {
    res.status(403).json({ error: "Worker bearers cannot perform owner or admin actions." });
    return false;
  }
  if (!req.sessionAccount) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }

  const role = await resolveGitRoomProjectRole(project, req.sessionAccount);
  if (role !== "admin") {
    res.status(403).json({ error: "Admin privileges required" });
    return false;
  }

  return true;
}

function resolveScopedWorkerParticipation(
  req: AuthenticatedRequest,
  res: Response,
  project: Project,
): boolean | null {
  if (req.authKind !== "agent_session") return null;
  if (req.agentSession?.room_id === project.id) return true;
  res.status(403).json({ error: "Worker bearer is scoped to a different room." });
  return false;
}

/** The same gate as requireGitRoomParticipant; kept for callers that import this name. */
export async function requireParticipant(
  req: AuthenticatedRequest,
  res: Response,
  project: Project
): Promise<boolean> {
  return requireGitRoomParticipant(req, res, project);
}

export async function requireGitRoomParticipant(
  req: AuthenticatedRequest,
  res: Response,
  project: Project,
  options: { freshCollaboratorCheck?: boolean; throwOnIndeterminate?: boolean } = {}
): Promise<boolean> {
  // Worker bearers are already authenticated, capability-checked, and scoped
  // to one exact room by the request middleware. They intentionally have no
  // human session account, so sending them through the GitHub collaborator
  // check would misclassify a valid worker as an anonymous user and return
  // 401 for Git-backed Focus rooms.
  const workerParticipation = resolveScopedWorkerParticipation(req, res, project);
  if (workerParticipation !== null) return workerParticipation;

  // Every room needs a sign-in, so no lookup can admit a caller without one.
  // A repo-shaped id on a host other than github.com keeps its own 403: no
  // sign-in could open it, so a sign-in request would mislead.
  const accessRoomId = getProjectAccessRoomId(project);
  if (!req.sessionAccount && (!isRepoBackedRoomId(accessRoomId) || parseGitHubRepoName(accessRoomId))) {
    return replyRepoRoomAccessDecision(res, accessRoomId, { kind: "auth_required" });
  }

  const accessDecision = await resolveProjectRepoRoomAccessDecision({
    project,
    sessionAccount: req.sessionAccount,
    freshCollaboratorCheck: options.freshCollaboratorCheck,
    throwOnIndeterminate: options.throwOnIndeterminate,
  });
  requestRepoAccessRoomNames.set(
    req,
    accessDecision.repoRoomName ?? getProjectAccessRoomId(project),
  );
  requestUsesRepoAuthorization.set(req, accessDecision.isRepoBacked);

  if (!accessDecision.isRepoBacked) {
    const membership = await resolveRoomMembershipDecision(project, req.sessionAccount);
    if (membership.kind === "allow") return true;
    return replyRoomMembershipDecision(res, project, req.sessionAccount, membership);
  }

  if (accessDecision.decision.kind === "allow") {
    return true;
  }

  return replyRepoRoomAccessDecision(
    res,
    accessDecision.roomName ?? getProjectAccessRoomId(project),
    accessDecision.decision
  );
}

/**
 * True when the entry check of this same request already made the exact
 * decision the live recheck would make now. Rooms without a repository use no
 * cache: the entry check read the membership from the database moments ago,
 * so the first live body needs no second read.
 */
export function liveRecheckIsFreshAtEntry(req: AuthenticatedRequest): boolean {
  return requestUsesRepoAuthorization.get(req) === false;
}

/**
 * Re-resolves the exact bearer/cookie and bypasses collaborator caches for a
 * live delivery lease. It has no Response side effects, so it is safe after
 * SSE headers have already been committed.
 */
export async function reauthorizeGitRoomParticipant(
  req: AuthenticatedRequest,
  project: Project,
): Promise<boolean> {
  const humanCredential = req.authKind === "session"
    || req.authKind === "owner_token"
    || req.authKind === "mcp_oauth";
  const fresh = await resolveRequestAuth(req);
  // A session or owner token revoked after entry must not keep a stream
  // alive, and a stream may never move to another account.
  if (
    humanCredential
    && (fresh.authKind !== req.authKind || fresh.account?.account_id !== req.sessionAccount?.account_id)
  ) {
    return false;
  }
  if (fresh.authKind === "agent_session") {
    return fresh.agentSession?.room_id === project.id;
  }
  const accessDecision = await resolveProjectRepoRoomAccessDecision({
    project,
    sessionAccount: fresh.account,
    freshCollaboratorCheck: true,
  });
  if (!accessDecision.isRepoBacked) {
    return (await resolveRoomMembershipDecision(project, fresh.account)).kind === "allow";
  }
  return accessDecision.decision.kind === "allow";
}

export async function resolveProjectRoomEntryDecision(input: {
  project: Project;
  sessionAccount: RequestAccount;
  redirectTo: string;
}): Promise<
  | { kind: "allow" }
  | { kind: "redirect"; location: string }
> {
  const accessDecision = await resolveProjectRepoRoomAccessDecision({
    project: input.project,
    sessionAccount: input.sessionAccount,
  });

  if (!accessDecision.isRepoBacked || accessDecision.decision.kind === "allow") {
    return { kind: "allow" };
  }

  return {
    kind: "redirect",
    location: buildLandingRedirect({
      reason: landingRedirectReason(accessDecision.decision),
      roomName: accessDecision.roomName ?? getProjectAccessRoomId(input.project),
      redirectTo: input.redirectTo,
    }),
  };
}

export async function resolveGitHubRoomEntryDecision(input: {
  roomName: string;
  sessionAccount: RequestAccount;
  redirectTo: string;
}): Promise<
  | { kind: "allow" }
  | { kind: "redirect"; location: string }
> {
  const decision = await resolveRepoRoomAccessDecision({
    roomName: input.roomName,
    sessionAccount: input.sessionAccount,
  });

  if (decision.kind === "allow") {
    return { kind: "allow" };
  }

  return {
    kind: "redirect",
    location: buildLandingRedirect({
      reason: landingRedirectReason(decision),
      roomName: input.roomName,
      redirectTo: input.redirectTo,
    }),
  };
}
