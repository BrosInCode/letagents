import type { Express, Response } from "express";

import type { GitRoomBinding, Project } from "../../db.js";
import { parseGitHubRefRoomLocator } from "../../github/git-room-routing.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import type { ProjectRepoAccessDecision } from "../../rooms/access.js";
import { normalizeRoomId } from "../../rooms/routing.js";

type RoomRole = "admin" | "participant" | "anonymous";

type RepoRoomAccessDecision =
  | { kind: "allow" }
  | { kind: "auth_required" }
  | { kind: "private_repo_no_access" };

type RepoRoomAccessDenial = Exclude<RepoRoomAccessDecision, { kind: "allow" }>;

export interface RoomJoinRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  isRepoBackedRoomId(roomId: string): boolean;
  resolveRepoRoomAccessDecision(input: {
    roomName: string;
    sessionAccount: AuthenticatedRequest["sessionAccount"];
  }): Promise<RepoRoomAccessDecision>;
  replyRepoRoomAccessDecision(
    res: Response,
    roomName: string,
    decision: RepoRoomAccessDenial
  ): false;
  resolveRoomOrReply(
    roomId: string,
    res: Response,
    options: { allowCreate: boolean }
  ): Promise<Project | null>;
  getProjectAccessRoomId(project: Project): string;
  getGitRoomBindingForRoom?(roomId: string): Promise<GitRoomBinding | null>;
  isRepoBackedProject(project: Project): boolean;
  resolveProjectRepoRoomAccessDecision(input: {
    project: Project;
    sessionAccount: AuthenticatedRequest["sessionAccount"];
  }): Promise<ProjectRepoAccessDecision>;
  resolveProjectRole(
    project: Project,
    sessionAccount: AuthenticatedRequest["sessionAccount"]
  ): Promise<RoomRole>;
  rememberHumanRoomParticipant(input: {
    projectId: string;
    sessionAccount: AuthenticatedRequest["sessionAccount"];
  }): Promise<void>;
  rememberAccountRoom(input: {
    accountId: string;
    roomId: string;
    displayName?: string | null;
    source?: string | null;
  }): Promise<void>;
  assignInitialProjectAdmin(input: {
    projectId: string;
    accountId: string;
  }): Promise<void>;
  toRoomResponse(
    project: Project,
    options?: {
      role?: RoomRole;
      authenticated?: boolean;
      gitRoomBinding?: GitRoomBinding | null;
    }
  ): Record<string, unknown>;
}

const joinRateLimit = new Map<string, { count: number; resetAt: number }>();
const JOIN_RATE_WINDOW_MS = 60_000;
const JOIN_RATE_MAX = 10;

function checkJoinRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = joinRateLimit.get(ip);

  if (!entry || now > entry.resetAt) {
    joinRateLimit.set(ip, { count: 1, resetAt: now + JOIN_RATE_WINDOW_MS });
    return true;
  }

  entry.count += 1;
  if (entry.count > JOIN_RATE_MAX) {
    return false;
  }

  return true;
}

function getJoinAccessRoomName(roomId: string, deps: RoomJoinRouteDeps): string | null {
  if (deps.isRepoBackedRoomId(roomId)) {
    return roomId;
  }

  const gitRefRoom = parseGitHubRefRoomLocator(roomId);
  if (gitRefRoom) {
    return `github.com/${gitRefRoom.repositoryFullName}`;
  }

  return null;
}

function allowsJoinCreate(value: unknown): boolean {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized !== "false" && normalized !== "0";
}

export function registerRoomJoinRoutes(
  app: Express,
  deps: RoomJoinRouteDeps
): void {
  app.post(/^\/rooms\/(.+)\/join$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const requestedRoomId = normalizeRoomId(rawId);
    const roomId = await deps.resolveCanonicalRoomRequestId(requestedRoomId);

    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ??
      req.socket.remoteAddress ??
      "unknown";
    if (!checkJoinRateLimit(ip)) {
      res.status(429).json({
        error: "Too many join attempts. Please slow down.",
        code: "RATE_LIMITED",
      });
      return;
    }

    const joinAccessRoomName = getJoinAccessRoomName(roomId, deps);
    if (joinAccessRoomName) {
      const decision = await deps.resolveRepoRoomAccessDecision({
        roomName: joinAccessRoomName,
        sessionAccount: req.sessionAccount,
      });
      if (decision.kind !== "allow") {
        deps.replyRepoRoomAccessDecision(res, joinAccessRoomName, decision);
        return;
      }
    }

    const project = await deps.resolveRoomOrReply(roomId, res, {
      allowCreate: allowsJoinCreate(
        (req.query as Record<string, unknown> | undefined)?.create
      ),
    });
    if (!project) return;

    const accessRoomId = deps.getProjectAccessRoomId(project);
    const projectAccess = await deps.resolveProjectRepoRoomAccessDecision({
      project,
      sessionAccount: req.sessionAccount,
    });
    if (projectAccess.isRepoBacked && projectAccess.decision.kind !== "allow") {
      deps.replyRepoRoomAccessDecision(
        res,
        projectAccess.roomName ?? accessRoomId,
        projectAccess.decision
      );
      return;
    }

    if (req.sessionAccount) {
      if (projectAccess.isRepoBacked) {
        await deps.resolveProjectRole(project, req.sessionAccount);
      } else {
        await deps.assignInitialProjectAdmin({
          projectId: project.id,
          accountId: req.sessionAccount.account_id,
        });
      }
    }

    const role = await deps.resolveProjectRole(project, req.sessionAccount);
    const currentRoomBinding = deps.getGitRoomBindingForRoom
      ? await deps.getGitRoomBindingForRoom(project.id)
      : null;
    const parentRoomBinding =
      !currentRoomBinding && deps.getGitRoomBindingForRoom && accessRoomId !== project.id
        ? await deps.getGitRoomBindingForRoom(accessRoomId)
        : null;
    const gitRoomBinding = currentRoomBinding ?? projectAccess.binding ?? parentRoomBinding;

    if (req.sessionAccount) {
      await deps.rememberHumanRoomParticipant({
        projectId: project.id,
        sessionAccount: req.sessionAccount,
      });
      await deps.rememberAccountRoom({
        accountId: req.sessionAccount.account_id,
        roomId: project.id,
        displayName: project.display_name,
        source: "join",
      });
    }

    res.status(200).json({
      ...deps.toRoomResponse(project, {
        role,
        authenticated: Boolean(req.sessionAccount),
        gitRoomBinding,
      }),
    });
  });
}
