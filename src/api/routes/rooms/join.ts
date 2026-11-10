import type { Express, Response } from "express";

import type { GitRoomBinding, Project } from "../../db.js";
import { parseGitHubRefRoomLocator } from "../../github/git-room-routing.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import type {
  ProjectRepoAccessDecision,
  RepoRoomAccessDecision,
  RepoRoomAccessDenial,
  RoomMembershipDecision,
} from "../../rooms/access.js";
import { normalizeRoomId, parseFocusRoomLocator } from "../../rooms/routing.js";
import { inProcessPrincipal } from "../../remote-mcp/in-process-dispatch.js";

type RoomRole = "admin" | "participant" | "anonymous";

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
  /** The room as it exists now, before this request may create it. */
  resolveExistingRoomRequest(roomId: string): Promise<Project | null | undefined>;
  /** Makes the person the creator of a room nobody holds yet; false when someone does. */
  claimRoomAsCreator(input: { projectId: string; accountId: string }): Promise<boolean>;
  resolveRoomMembershipDecision(
    project: Project,
    sessionAccount: AuthenticatedRequest["sessionAccount"],
  ): Promise<RoomMembershipDecision>;
  replyRoomMembershipDecision(
    res: Response,
    project: Project,
    sessionAccount: AuthenticatedRequest["sessionAccount"],
    decision: Exclude<RoomMembershipDecision, { kind: "allow" }>,
  ): Promise<false>;
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
  // A focus locator (`<parent>/focus/<key>`) can look like `host/owner/repo`
  // when its parent has one segment. Its access follows the parent. A parent
  // that is not repo-backed is checked later, on the resolved project.
  const focusLocator = parseFocusRoomLocator(roomId);
  if (focusLocator) {
    return deps.isRepoBackedRoomId(focusLocator.parentRoomId)
      ? focusLocator.parentRoomId
      : getGitRefRoomAccessName(roomId);
  }

  if (deps.isRepoBackedRoomId(roomId)) {
    return roomId;
  }

  return getGitRefRoomAccessName(roomId);
}

function getGitRefRoomAccessName(roomId: string): string | null {
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
    // Remote MCP sessions' in-process calls have no client address; they get
    // a budget per account. A signed-in caller gets one per account as well,
    // so people behind one office address do not share it. Everyone else
    // keeps the address key.
    const internal = inProcessPrincipal(req);
    const rateLimitKey = internal
      ? `account:${internal.account.account_id}`
      : req.sessionAccount
        ? `session-account:${req.sessionAccount.account_id}`
        : ip;
    if (!checkJoinRateLimit(rateLimitKey)) {
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

    // Every room needs a sign-in: only members may read a room or wake its
    // agents. A repo room answered above, with its own refusal when it has one.
    if (!req.sessionAccount) {
      deps.replyRepoRoomAccessDecision(res, joinAccessRoomName ?? roomId, { kind: "auth_required" });
      return;
    }

    const existedBefore = Boolean(await deps.resolveExistingRoomRequest(roomId));
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

    // A repo room's role (and its stored admin row) comes from the single
    // resolveProjectRole call below; a second call here cost GitHub requests.
    if (!projectAccess.isRepoBacked) {
      // The person who creates a room is its first admin and member. Everyone
      // else must already be a member; a stranger asks to join instead.
      const claimed = !existedBefore
        && project.id === accessRoomId
        && await deps.claimRoomAsCreator({ projectId: project.id, accountId: req.sessionAccount.account_id });
      if (!claimed) {
        const membership = await deps.resolveRoomMembershipDecision(project, req.sessionAccount);
        if (membership.kind !== "allow") {
          await deps.replyRoomMembershipDecision(res, project, req.sessionAccount, membership);
          return;
        }
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
