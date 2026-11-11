import type { Response } from "express";

import {
  REPO_ACCESS_UNAVAILABLE,
  REPO_ACCESS_UNAVAILABLE_MESSAGE,
  repoCollaboratorRequiredBody,
  roomMembershipRequiredBody,
} from "../../../shared/room-membership.mjs";
import {
  getGitRoomBindingForRoom,
  type GitRoomBinding,
  type Project,
} from "../db.js";
import {
  GitHubAccessUnavailableError,
  parseGitHubRepoName,
  type RepoRoomAccessDecision,
} from "../github/repo-access.js";
import {
  sanitizeRedirectPath,
  type AuthenticatedRequest,
} from "../http/helpers.js";
import { resolveRequestAuth } from "../request/auth.js";
import { getLatestRoomJoinRequest } from "../db/room-members.js";
import {
  classifyRoomAccess,
  decideRoomAdmin,
  decideRoomRead,
  getProjectAccessRoomId,
  resolveProjectRepoAccessTarget,
  resolveRepoRoomAccessDecision,
  roomAccessPrincipal,
  type RepoRoomAccessDenial,
  type RoomAccessAccount,
  type RoomAccessDecisionDeps,
  type RoomAccessTarget,
  type RoomRole,
} from "./access-decision.js";
import { isRepoBackedRoomId } from "./room-ids.js";
import { isRepoAccessRoom } from "./room-nature.js";

export { isRepoBackedRoomId };
export {
  getProjectAccessRoomId,
  resolveProjectRepoAccessTarget,
  resolveRepoRoomAccessDecision,
};
export type { RepoRoomAccessDecision, RepoRoomAccessDenial, RoomAccessAccount, RoomRole };

type RequestAccount = RoomAccessAccount | null | undefined;

export interface ProjectRepoAccessDecision {
  isRepoBacked: boolean;
  roomName: string | null;
  repoRoomName: string | null;
  binding: GitRoomBinding | null;
  decision: RepoRoomAccessDecision;
}

export type ProjectRepoAccessDeps = RoomAccessDecisionDeps;

/** The room's access room is a repository room, by its stored origin (rooms/room-nature.ts). */
export function isRepoBackedProject(project: Project): boolean {
  return isRepoAccessRoom(project);
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

/** The name live leases and invalidation events use for a room: its repository, or its access room. */
export function roomAccessName(target: RoomAccessTarget): string {
  return target.kind === "repo" ? target.repoRoomName : target.accessRoomId;
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
    case "repo_access_unavailable":
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

  if (decision.kind === "repo_access_unavailable") {
    // Not a refusal: GitHub gave no answer, so the client should retry.
    res.setHeader?.("Retry-After", "30");
    res.status(503).json({ ...REPO_ACCESS_UNAVAILABLE, message: REPO_ACCESS_UNAVAILABLE_MESSAGE, room_id: roomName });
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

/**
 * The answer for a GitHubAccessUnavailableError from a check that has no
 * response of its own: the retryable 503 with Retry-After, never a refusal.
 */
export function replyIfGitHubAccessUnavailable(res: Response, error: unknown, roomId: string | null = null): boolean {
  if (!(error instanceof GitHubAccessUnavailableError)) return false;
  res.setHeader?.("Retry-After", "30");
  res.status(503).json({ ...REPO_ACCESS_UNAVAILABLE, message: REPO_ACCESS_UNAVAILABLE_MESSAGE, room_id: roomId });
  return true;
}

/**
 * The repository half of a room's decision, for callers that already handle
 * the membership half themselves (room join and creation flows). Other callers
 * use decideRoomRead.
 */
export async function resolveProjectRepoRoomAccessDecision(input: {
  project: Project;
  sessionAccount: RequestAccount;
  freshCollaboratorCheck?: boolean;
  throwOnIndeterminate?: boolean;
}, deps: ProjectRepoAccessDeps = {
  getGitRoomBindingForRoom,
  resolveRepoRoomAccessDecision,
}): Promise<ProjectRepoAccessDecision> {
  const target = await classifyRoomAccess(input.project, deps);
  if (target.kind === "membership") {
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

export async function resolveGitRoomProjectRole(
  project: Project,
  sessionAccount: RequestAccount,
  deps?: ProjectRepoAccessDeps,
): Promise<RoomRole> {
  return (await decideRoomAdmin({ project, principal: roomAccessPrincipal(sessionAccount) }, deps)).role;
}

/**
 * Whether the account is a room admin now, for a check with no response of
 * its own (a background job, or a route that answers its own errors). In a
 * repo room an admin row counts only while GitHub still admits the person.
 * When GitHub gives no answer it throws GitHubAccessUnavailableError, never
 * "not admin": the caller retries or answers 503.
 */
export async function isCurrentProjectAdmin(
  project: Project,
  account: RequestAccount,
  deps?: ProjectRepoAccessDeps,
): Promise<boolean> {
  const decision = await decideRoomAdmin({ project, principal: roomAccessPrincipal(account), outage: "throw" }, deps);
  return decision.role === "admin";
}

/** Whether the account is a member of the project's access room (its parent, for a focus room). */
export async function isProjectRoomMember(project: Project, accountId: string): Promise<boolean> {
  const decision = await decideRoomRead({
    project,
    principal: { kind: "account", accountId },
    target: { kind: "membership", accessRoomId: getProjectAccessRoomId(project) },
  });
  return decision.kind === "allow";
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
  const decision = await decideRoomRead({
    project,
    principal: roomAccessPrincipal(sessionAccount),
    target: { kind: "membership", accessRoomId: getProjectAccessRoomId(project) },
  });
  return decision.kind === "allow" ? { kind: "allow" }
    : decision.kind === "membership_required" ? { kind: "membership_required" }
      : { kind: "auth_required" };
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
    return replyRepoRoomAccessDecision(res, project.id, { kind: "auth_required" });
  }
  // Focus room ids are easy to guess (focus_1, focus_2, ...), so a refusal for
  // one names neither its parent nor the parent's name. A top-level room's
  // name and the person's request are shown: the caller already has its id.
  const topLevel = accessRoomId === project.id;
  res.status(403).json(roomMembershipRequiredBody({
    room_id: project.id,
    display_name: topLevel ? project.display_name : null,
    join_request: topLevel ? await getLatestRoomJoinRequest(accessRoomId, sessionAccount.account_id) : null,
  }));
  return false;
}

export async function requireGitRoomAdmin(
  req: AuthenticatedRequest,
  res: Response,
  project: Project,
  deps?: ProjectRepoAccessDeps,
): Promise<boolean> {
  if (req.authKind === "agent_session") {
    res.status(403).json({ error: "Worker bearers cannot perform owner or admin actions." });
    return false;
  }
  if (!req.sessionAccount) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }

  const decision = await decideRoomAdmin({ project, principal: roomAccessPrincipal(req.sessionAccount) }, deps);
  // The same answers as requireGitRoomParticipant: a refusal for someone
  // GitHub no longer admits, and a 503 to retry when GitHub gives no answer.
  if (decision.target?.kind === "repo" && decision.kind !== "allow" && decision.repo && decision.repo.kind !== "allow") {
    return replyRepoRoomAccessDecision(res, decision.target.roomName, decision.repo);
  }

  if (decision.role !== "admin") {
    res.status(403).json({ error: "Admin privileges required" });
    return false;
  }

  return true;
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
  // Every room needs a sign-in, so no lookup admits a caller without one. A
  // repo-shaped id on a host other than github.com keeps its own 403: no
  // sign-in could open it, so a sign-in request would mislead.
  const decision = await decideRoomRead({
    project,
    principal: req.authKind === "agent_session"
      ? { kind: "worker", roomId: req.agentSession?.room_id ?? null }
      : roomAccessPrincipal(req.sessionAccount),
    freshness: options.freshCollaboratorCheck ? "fresh" : "cached",
    outage: options.throwOnIndeterminate ? "revalidation" : "indeterminate",
  });
  if (decision.target) {
    requestRepoAccessRoomNames.set(req, roomAccessName(decision.target));
    requestUsesRepoAuthorization.set(req, decision.target.kind === "repo");
  }

  switch (decision.kind) {
    case "allow":
      return true;
    case "worker_scope_mismatch":
      res.status(403).json({ error: "Worker bearer is scoped to a different room." });
      return false;
    case "auth_required":
      // The id the caller asked for: a focus room id never reveals its parent.
      return replyRepoRoomAccessDecision(res, project.id, { kind: "auth_required" });
    case "membership_required":
      return replyRoomMembershipDecision(res, project, req.sessionAccount, decision);
    case "repo_access_denied":
    case "indeterminate":
      return replyRepoRoomAccessDecision(res, (decision.target as Extract<RoomAccessTarget, { kind: "repo" }>).roomName, decision.repo);
  }
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
  const decision = await decideRoomRead({
    project,
    principal: fresh.authKind === "agent_session"
      ? { kind: "worker", roomId: fresh.agentSession?.room_id ?? null }
      : roomAccessPrincipal(fresh.account),
    freshness: "fresh",
  });
  return decision.kind === "allow";
}

export async function resolveProjectRoomEntryDecision(input: {
  project: Project;
  sessionAccount: RequestAccount;
  redirectTo: string;
}): Promise<
  | { kind: "allow" }
  | { kind: "redirect"; location: string }
> {
  // A membership room always serves the app: its own room calls answer a
  // non-member with the "Ask to join" refusal.
  const target = await classifyRoomAccess(input.project);
  if (target.kind === "membership") return { kind: "allow" };
  const decision = await decideRoomRead({
    project: input.project,
    principal: roomAccessPrincipal(input.sessionAccount),
    target,
  });

  // GitHub gave no answer: serve the app, whose own room calls get the 503
  // and retry, instead of a landing page that says the access is missing.
  if (decision.kind === "allow" || decision.kind === "indeterminate" || !decision.repo || decision.repo.kind === "allow") {
    return { kind: "allow" };
  }

  return {
    kind: "redirect",
    location: buildLandingRedirect({
      reason: landingRedirectReason(decision.repo),
      roomName: target.roomName,
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

  if (decision.kind === "allow" || decision.kind === "repo_access_unavailable") {
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
