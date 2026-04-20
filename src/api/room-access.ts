import type { Response } from "express";

import {
  assignProjectAdmin,
  isProjectAdmin,
  type OwnerTokenAccount,
  type Project,
  type SessionAccount,
} from "./db.js";
import {
  isGitHubRepoAdmin,
  parseGitHubRepoName,
  resolveGitHubRepoRoomAccessDecision,
} from "./github-repo-access.js";
import {
  sanitizeRedirectPath,
  type AuthenticatedRequest,
} from "./http-helpers.js";

type RequestAccount = SessionAccount | OwnerTokenAccount | null | undefined;

export type RoomRole = "admin" | "participant" | "anonymous";

export type RepoRoomAccessDecision =
  | { kind: "allow" }
  | { kind: "auth_required" }
  | { kind: "private_repo_no_access" };

export type RepoRoomAccessDenial = Exclude<RepoRoomAccessDecision, { kind: "allow" }>;

export function isRepoBackedRoomId(roomId: string): boolean {
  return /^[A-Za-z0-9.-]+\/[^/]+\/[^/]+$/.test(roomId);
}

export function getProjectAccessRoomId(project: Project): string {
  return project.parent_room_id ?? project.id;
}

export function isRepoBackedProject(project: Project): boolean {
  return isRepoBackedRoomId(getProjectAccessRoomId(project));
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
}): Promise<RepoRoomAccessDecision> {
  if (!isRepoBackedRoomId(input.roomName)) {
    return { kind: "allow" };
  }

  return resolveGitHubRepoRoomAccessDecision(input);
}

export async function resolveProjectRole(
  project: Project,
  sessionAccount: RequestAccount
): Promise<RoomRole> {
  const accessRoomId = getProjectAccessRoomId(project);
  if (!sessionAccount) {
    return isRepoBackedProject(project) ? "anonymous" : "participant";
  }

  if (
    (await isProjectAdmin(project.id, sessionAccount.account_id)) ||
    (accessRoomId !== project.id && (await isProjectAdmin(accessRoomId, sessionAccount.account_id)))
  ) {
    return "admin";
  }

  if (parseGitHubRepoName(accessRoomId) && sessionAccount.provider === "github") {
    const eligible = await isGitHubRepoAdmin({
      roomName: accessRoomId,
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

export async function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  project: Project
): Promise<boolean> {
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

export async function requireParticipant(
  req: AuthenticatedRequest,
  res: Response,
  project: Project
): Promise<boolean> {
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
