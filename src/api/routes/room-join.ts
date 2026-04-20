import type { Express, Response } from "express";

import {
  assignProjectAdmin,
  type Project,
} from "../db.js";
import type { AuthenticatedRequest } from "../http-helpers.js";
import { normalizeRoomId } from "../room-routing.js";

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
  isRepoBackedProject(project: Project): boolean;
  resolveProjectRole(
    project: Project,
    sessionAccount: AuthenticatedRequest["sessionAccount"]
  ): Promise<RoomRole>;
  rememberHumanRoomParticipant(input: {
    projectId: string;
    sessionAccount: AuthenticatedRequest["sessionAccount"];
  }): Promise<void>;
  toRoomResponse(
    project: Project,
    options?: {
      role?: RoomRole;
      authenticated?: boolean;
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

    if (deps.isRepoBackedRoomId(roomId)) {
      const decision = await deps.resolveRepoRoomAccessDecision({
        roomName: roomId,
        sessionAccount: req.sessionAccount,
      });
      if (decision.kind !== "allow") {
        deps.replyRepoRoomAccessDecision(res, roomId, decision);
        return;
      }
    }

    const project = await deps.resolveRoomOrReply(roomId, res, { allowCreate: true });
    if (!project) return;

    const accessRoomId = deps.getProjectAccessRoomId(project);
    if (accessRoomId !== roomId && deps.isRepoBackedRoomId(accessRoomId)) {
      const decision = await deps.resolveRepoRoomAccessDecision({
        roomName: accessRoomId,
        sessionAccount: req.sessionAccount,
      });
      if (decision.kind !== "allow") {
        deps.replyRepoRoomAccessDecision(res, accessRoomId, decision);
        return;
      }
    }

    if (req.sessionAccount) {
      if (deps.isRepoBackedProject(project)) {
        await deps.resolveProjectRole(project, req.sessionAccount);
      } else {
        await assignProjectAdmin(project.id, req.sessionAccount.account_id);
      }
    }

    const role = await deps.resolveProjectRole(project, req.sessionAccount);

    if (req.sessionAccount) {
      await deps.rememberHumanRoomParticipant({
        projectId: project.id,
        sessionAccount: req.sessionAccount,
      });
    }

    res.status(200).json({
      ...deps.toRoomResponse(project, {
        role,
        authenticated: Boolean(req.sessionAccount),
      }),
    });
  });
}
