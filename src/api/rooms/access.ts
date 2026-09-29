import type { Response } from "express";

import {
  assignProjectAdmin,
  getGitRoomBindingForRoom,
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
} from "../github/repo-access.js";
import {
  sanitizeRedirectPath,
  type AuthenticatedRequest,
} from "../http/helpers.js";
import { resolveRequestAuth } from "../request/auth.js";

export type RoomAccessAccount = Pick<
  SessionAccount | OwnerTokenAccount,
  "account_id" | "provider" | "login" | "provider_access_token"
>;

type RequestAccount = RoomAccessAccount | null | undefined;

export type RoomRole = "admin" | "participant" | "anonymous";

export type RepoRoomAccessDecision =
  | { kind: "allow" }
  | { kind: "auth_required" }
  | { kind: "private_repo_no_access" };

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

export function isRepoBackedRoomId(roomId: string): boolean {
  return /^[A-Za-z0-9.-]+\/[^/]+\/[^/]+$/.test(roomId);
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

export function getPublicBaseUrl(): string {
  const configuredBaseUrl = process.env.LETAGENTS_BASE_URL || process.env.PUBLIC_API_URL;
  if (configuredBaseUrl?.trim()) {
    return configuredBaseUrl.replace(/\/+$/, "");
  }

  return `http://localhost:${process.env.PORT || "3001"}`;
}

export function buildDeviceFlowUrl(roomName: string): string {
  const url = new URL("/auth/device/start", `${getPublicBaseUrl()}/`);
  url.searchParams.set("room_id", roomName);
  return url.toString();
}

function buildLandingRedirect(input: {
  reason: "repo_signin_required" | "repo_access_denied";
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

export function replyRepoRoomAccessDecision(
  res: Response,
  roomName: string,
  decision: RepoRoomAccessDenial
): false {
  if (decision.kind === "auth_required") {
    res.status(401).json({
      error: "auth_required",
      code: "NOT_AUTHENTICATED",
      message: "Authentication is required for repo-backed rooms",
      room_id: roomName,
      device_flow_url: buildDeviceFlowUrl(roomName),
    });
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
    return accessDecision.isRepoBacked ? "anonymous" : "participant";
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

export async function requireParticipant(
  req: AuthenticatedRequest,
  res: Response,
  project: Project
): Promise<boolean> {
  const workerParticipation = resolveScopedWorkerParticipation(req, res, project);
  if (workerParticipation !== null) return workerParticipation;
  if (!isRepoBackedProject(project)) {
    return true;
  }

  const decision = await resolveRepoRoomAccessDecision({
    roomName: getProjectAccessRoomId(project),
    sessionAccount: req.sessionAccount,
  });

  if (decision.kind === "allow") {
    return true;
  }

  return replyRepoRoomAccessDecision(res, getProjectAccessRoomId(project), decision);
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

  if (!accessDecision.isRepoBacked || accessDecision.decision.kind === "allow") {
    return true;
  }

  return replyRepoRoomAccessDecision(
    res,
    accessDecision.roomName ?? getProjectAccessRoomId(project),
    accessDecision.decision
  );
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
  if (requestUsesRepoAuthorization.get(req) === false) return true;
  const fresh = await resolveRequestAuth(req);
  if (fresh.authKind === "agent_session") {
    return fresh.agentSession?.room_id === project.id;
  }
  const accessDecision = await resolveProjectRepoRoomAccessDecision({
    project,
    sessionAccount: fresh.account,
    freshCollaboratorCheck: true,
  });
  return !accessDecision.isRepoBacked || accessDecision.decision.kind === "allow";
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
      reason: accessDecision.decision.kind === "auth_required"
        ? "repo_signin_required"
        : "repo_access_denied",
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
      reason: decision.kind === "auth_required" ? "repo_signin_required" : "repo_access_denied",
      roomName: input.roomName,
      redirectTo: input.redirectTo,
    }),
  };
}
