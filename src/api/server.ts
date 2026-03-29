import { EventEmitter } from "events";
import crypto from "crypto";
import fs from "fs";
import express, { type Response } from "express";
import path from "path";

import {
  addMessage,
  assignProjectAdmin,
  consumeAuthState,
  createAuthState,
  createProject,
  createSession,
  createTask,
  deleteSessionByToken,
  findTaskByPrUrl,
  getAllProjects,
  getAgentIdentitiesForOwner,
  getGitHubAppInstallationById,
  getGitHubAppRepositoryByFullName,
  getGitHubAppRepositoryByRoomId,
  getOwnerTokenAccountByToken,
  getMessages,
  getMessagesAfter,
  getOpenTasks,
  getOrCreateCanonicalRoom,
  getProjectByCode,
  getProjectById,
  getSessionAccountByToken,
  getTaskById,
  getTasks,
  hasMessagesFromSender,
  isProjectAdmin,
  markGitHubAppInstallationUninstalled,
  markGitHubAppRepositoryRemoved,
  markGitHubWebhookDeliveryProcessed,
  migrateGitHubRepositoryCanonicalRoom,
  recordGitHubWebhookDelivery,
  refreshProviderAccessTokenForAccount,
  registerAgentIdentity,
  rotateProjectCode,
  setGitHubAppInstallationSuspended,
  createOwnerToken,
  upsertGitHubAppInstallation,
  upsertGitHubAppRepository,
  upsertGitHubRepositoryLink,
  upsertAccount,
  updateProjectDisplayName,
  updateTask,
  type GitHubWebhookDeliveryStatus,
  type Message,
  type OwnerTokenAccount,
  type Project,
  type SessionAccount,
  type TaskStatus,
} from "./db.js";
import { getGitHubAppConfig, hasGitHubAppConfig } from "./github-config.js";
import {
  buildGitHubRepoRoomId,
  extractReferencedTaskId,
  formatGitHubPullRequestEventMessage,
  formatGitHubRepositoryEventMessage,
  getGitHubInstallationTarget,
  getGitHubRepositoryOwnerLogin,
  getGitHubWebhookMetadata,
  verifyGitHubWebhookSignature,
  type GitHubWebhookPayload,
  type GitHubWebhookPullRequest,
  type GitHubWebhookRepository,
} from "./github-app.js";
import {
  buildGitHubAppInstallationUrl,
  buildGitHubAppSetupRedirectPath,
  resolveGitHubAppRoomIntegrationStatus,
} from "./github-app-installation.js";
import {
  clearGitHubRepoAccessCacheForLogin,
  isGitHubRepoAdmin,
  parseGitHubRepoName,
  resolveGitHubRepoRoomAccessDecision,
} from "./github-repo-access.js";
import {
  buildGitHubAuthorizeUrl,
  exchangeGitHubDeviceCodeForAccessToken,
  exchangeGitHubCodeForAccessToken,
  fetchGitHubUser,
  requestGitHubDeviceCode,
} from "./github-oauth.js";
import {
  isInviteCode,
  isKnownProvider,
  normalizeRoomId,
  normalizeRoomName,
  resolveRoomIdentifier,
} from "./room-routing.js";
import { getAgentPrimaryLabel } from "../shared/agent-identity.js";
import {
  isPromptOnlyAgentMessage,
  normalizeAgentPromptKind,
  type AgentPromptKind,
} from "../shared/room-agent-prompts.js";

interface MessageCreatedEvent {
  projectId: string;
  message: Message;
}

interface AuthenticatedRequest extends express.Request {
  sessionAccount?: SessionAccount | OwnerTokenAccount | null;
  authKind?: "session" | "owner_token" | null;
  rawBody?: Buffer;
}

interface ResolvedRequestAuth {
  account: SessionAccount | OwnerTokenAccount | null;
  authKind: "session" | "owner_token" | null;
}

const messageEvents = new EventEmitter();

interface PendingDeviceAuth {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: number;
  lastPollAt: number | null;
}

const pendingDeviceAuths = new Map<string, PendingDeviceAuth>();
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

function cleanupExpiredDeviceAuths(): void {
  const now = Date.now();
  for (const [requestId, auth] of pendingDeviceAuths.entries()) {
    if (auth.expiresAt <= now) {
      pendingDeviceAuths.delete(requestId);
    }
  }
}

async function emitProjectMessage(
  projectId: string,
  sender: string,
  text: string,
  options?: {
    source?: string;
    agent_prompt_kind?: AgentPromptKind | null;
  }
): Promise<Message> {
  const message = await addMessage(projectId, sender, text, {
    source: options?.source,
    agent_prompt_kind: options?.agent_prompt_kind ?? null,
  });
  messageEvents.emit("message:created", { projectId, message } satisfies MessageCreatedEvent);
  return message;
}

function parseOptionalAgentPromptKind(value: unknown): AgentPromptKind | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalizedValue = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (normalizedValue === "join") {
    throw new Error("agent_prompt_kind must be one of: inline, auto");
  }

  const kind = normalizeAgentPromptKind(normalizedValue);
  if (!kind) {
    throw new Error("agent_prompt_kind must be one of: inline, auto");
  }

  return kind;
}

function shouldIncludePromptOnlyMessages(req: express.Request): boolean {
  const value = req.query.include_prompt_only;
  if (typeof value !== "string") {
    return false;
  }

  return value === "1" || value.toLowerCase() === "true";
}

function startSseStream(res: Response): NodeJS.Timeout {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // nginx will otherwise buffer SSE in front of staging/production.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.socket?.setKeepAlive(true, SSE_HEARTBEAT_INTERVAL_MS);
  res.write(": connected\n\n");

  return setInterval(() => {
    if (res.writableEnded) {
      return;
    }
    res.write(": heartbeat\n\n");
  }, SSE_HEARTBEAT_INTERVAL_MS);
}

function stopSseStream(res: Response, heartbeat: NodeJS.Timeout): void {
  clearInterval(heartbeat);
  if (!res.writableEnded) {
    res.end();
  }
}

function formatTaskLifecycleStatus(task: {
  id: string;
  title: string;
  status: TaskStatus;
  assignee: string | null;
}): string {
  const assigneeLabel = getAgentPrimaryLabel(task.assignee);
  switch (task.status) {
    case "assigned":
      return assigneeLabel
        ? `[status] ${assigneeLabel} claimed ${task.id}: ${task.title}`
        : `[status] ${task.id} moved to assigned: ${task.title}`;
    case "in_progress":
      return assigneeLabel
        ? `[status] ${assigneeLabel} is working on ${task.id}: ${task.title}`
        : `[status] ${task.id} is in progress: ${task.title}`;
    case "blocked":
      return `[status] ${task.id} is blocked: ${task.title}`;
    case "in_review":
      return `[status] ${task.id} is in review: ${task.title}`;
    case "merged":
      return `[status] ${task.id} was merged: ${task.title}`;
    case "done":
      return `[status] ${task.id} is done: ${task.title}`;
    case "cancelled":
      return `[status] ${task.id} was cancelled: ${task.title}`;
    default:
      return `[status] ${task.id} moved to ${task.status}: ${task.title}`;
  }
}

async function isTrustedAgentCreator(projectId: string, createdBy: string): Promise<boolean> {
  const normalizedSender = createdBy.trim().toLowerCase();
  if (!normalizedSender || normalizedSender === "human" || normalizedSender === "letagents") {
    return false;
  }

  return hasMessagesFromSender(projectId, createdBy);
}

function parsePollTimeout(timeoutValue: string | undefined): number {
  if (!timeoutValue) {
    return 30000;
  }

  const parsed = Number.parseInt(timeoutValue, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return 30000;
  }

  return Math.min(parsed, 180000);
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};

  return header.split(";").reduce<Record<string, string>>((acc, pair) => {
    const index = pair.indexOf("=");
    if (index === -1) return acc;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function setSessionCookie(res: express.Response, token: string): void {
  const secure = (process.env.LETAGENTS_BASE_URL || "").startsWith("https://");
  const cookieParts = [
    `letagents_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (secure) {
    cookieParts.push("Secure");
  }

  res.setHeader("Set-Cookie", cookieParts.join("; "));
}

function clearSessionCookie(res: express.Response): void {
  res.setHeader(
    "Set-Cookie",
    "letagents_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
}

function isRepoBackedRoomId(roomId: string): boolean {
  return /^[A-Za-z0-9.-]+\/[^/]+\/[^/]+$/.test(roomId);
}

function sanitizeRedirectPath(pathValue: string | null | undefined, fallback = "/"): string {
  const trimmed = pathValue?.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return fallback;
  }

  try {
    const parsed = new URL(trimmed, "http://localhost");
    if (parsed.origin !== "http://localhost") {
      return fallback;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
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

function isRepoBackedProject(project: Project): boolean {
  return isRepoBackedRoomId(project.id);
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

type RepoRoomAccessDecision =
  | { kind: "allow" }
  | { kind: "auth_required" }
  | { kind: "private_repo_no_access" };

function replyRepoRoomAccessDecision(
  res: express.Response,
  roomName: string,
  decision: Exclude<RepoRoomAccessDecision, { kind: "allow" }>
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

async function resolveRepoRoomAccessDecision(input: {
  roomName: string;
  sessionAccount: SessionAccount | OwnerTokenAccount | null | undefined;
}): Promise<RepoRoomAccessDecision> {
  if (!isRepoBackedRoomId(input.roomName)) {
    return { kind: "allow" };
  }

  return resolveGitHubRepoRoomAccessDecision(input);
}

async function resolveProjectRole(
  project: Project,
  sessionAccount: SessionAccount | OwnerTokenAccount | null | undefined
): Promise<"admin" | "participant" | "anonymous"> {
  if (!sessionAccount) {
    return isRepoBackedProject(project) ? "anonymous" : "participant";
  }

  if (await isProjectAdmin(project.id, sessionAccount.account_id)) {
    return "admin";
  }

  if (parseGitHubRepoName(project.id) && sessionAccount.provider === "github") {
    const eligible = await isGitHubRepoAdmin({
      roomName: project.id,
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

async function requireAdmin(
  req: AuthenticatedRequest,
  res: express.Response,
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

async function requireParticipant(
  req: AuthenticatedRequest,
  res: express.Response,
  project: Project
): Promise<boolean> {
  if (!isRepoBackedProject(project)) {
    return true;
  }

  const decision = await resolveRepoRoomAccessDecision({
    roomName: project.id,
    sessionAccount: req.sessionAccount,
  });

  if (decision.kind === "allow") {
    return true;
  }

  return replyRepoRoomAccessDecision(res, project.id, decision);
}

async function resolveGitHubRoomEntryDecision(input: {
  roomName: string;
  sessionAccount: SessionAccount | OwnerTokenAccount | null | undefined;
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

async function resolveRequestAuth(req: express.Request): Promise<ResolvedRequestAuth> {
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.letagents_session;
  if (sessionToken) {
    const sessionAccount = await getSessionAccountByToken(sessionToken);
    if (sessionAccount) {
      return {
        account: sessionAccount,
        authKind: "session",
      };
    }
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      account: null,
      authKind: null,
    };
  }

  const providerToken = authHeader.slice("Bearer ".length).trim();
  if (!providerToken) {
    return {
      account: null,
      authKind: null,
    };
  }

  const ownerTokenAccount = await getOwnerTokenAccountByToken(providerToken);
  if (ownerTokenAccount) {
    return {
      account: ownerTokenAccount,
      authKind: "owner_token",
    };
  }

  return {
    account: null,
    authKind: null,
  };
}

async function resolveRoomOrReply(
  roomId: string,
  res: express.Response,
  { allowCreate }: { allowCreate: boolean } = { allowCreate: false }
): Promise<Project | null> {
  // Handle invite codes (e.g., JA0E-4NYO or JA0E-4NYO-L2QP)
  if (isInviteCode(roomId)) {
    const project = await getProjectByCode(roomId);
    if (!project) {
      res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
      return null;
    }
    return project;
  }

  if (allowCreate) {
    const { room } = await getOrCreateCanonicalRoom(roomId);
    return room;
  }

  const found = await getProjectById(roomId);
  if (!found) {
    res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
    return null;
  }
  return found;
}

async function resolveCanonicalRoomRequestId(roomId: string): Promise<string> {
  if (isInviteCode(roomId)) {
    return roomId;
  }

  const existing = await getProjectById(roomId);
  return existing?.id ?? roomId;
}

function toGitHubWebhookId(value: string | number | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

async function syncGitHubAppInstallationFromPayload(
  payload: GitHubWebhookPayload,
  options?: {
    suspended_at?: string | null;
    uninstalled_at?: string | null;
  }
): Promise<string | null> {
  const installationId = toGitHubWebhookId(payload.installation?.id);
  if (!installationId) {
    return null;
  }

  const target = getGitHubInstallationTarget(payload);
  if (!target?.login) {
    return installationId;
  }

  await upsertGitHubAppInstallation({
    installation_id: installationId,
    target_type: payload.installation?.target_type ?? target.type ?? "Account",
    target_login: target.login,
    target_github_id: toGitHubWebhookId(target.id) ?? installationId,
    repository_selection: payload.installation?.repository_selection ?? "selected",
    permissions: payload.installation?.permissions,
    suspended_at: options?.suspended_at,
    uninstalled_at: options?.uninstalled_at,
  });

  return installationId;
}

async function syncGitHubAppRepositoryFromPayload(
  repository: GitHubWebhookRepository | undefined,
  installationId: string | null
): Promise<{
  installationId: string | null;
  githubRepoId: string | null;
  roomId: string | null;
}> {
  if (!repository) {
    return {
      installationId,
      githubRepoId: null,
      roomId: null,
    };
  }

  const githubRepoId = toGitHubWebhookId(repository.id);
  const roomId = buildGitHubRepoRoomId(repository.full_name);
  const ownerLogin = getGitHubRepositoryOwnerLogin(repository);
  let resolvedInstallationId = installationId;

  if (!resolvedInstallationId) {
    resolvedInstallationId =
      (await getGitHubAppRepositoryByFullName(repository.full_name))?.installation_id ?? null;
  }

  if (resolvedInstallationId && githubRepoId && ownerLogin && repository.name) {
    await upsertGitHubAppRepository({
      github_repo_id: githubRepoId,
      installation_id: resolvedInstallationId,
      owner_login: ownerLogin,
      repo_name: repository.name,
    });

    // Also populate the stable github_repositories mapping
    await upsertGitHubRepositoryLink({
      github_repo_id: githubRepoId,
      room_id: roomId,
      owner_login: ownerLogin,
      repo_name: repository.name,
    });
  }

  return {
    installationId: resolvedInstallationId,
    githubRepoId,
    roomId,
  };
}

async function maybeLinkGitHubPullRequestToTask(
  project: Project,
  pullRequest: GitHubWebhookPullRequest,
  action: string
): Promise<string | null> {
  let linkedTask = await findTaskByPrUrl(project.id, pullRequest.html_url);

  if (!linkedTask) {
    const referencedTaskId = extractReferencedTaskId(pullRequest.title, pullRequest.body);
    if (referencedTaskId) {
      linkedTask = await getTaskById(project.id, referencedTaskId);
    }
  }

  if (!linkedTask) {
    return null;
  }

  if (linkedTask.pr_url !== pullRequest.html_url) {
    linkedTask = (await updateTask(project.id, linkedTask.id, {
      pr_url: pullRequest.html_url,
    })) ?? linkedTask;
  }

  if (action === "closed" && pullRequest.merged && linkedTask.status === "in_review") {
    const mergedTask = await updateTask(project.id, linkedTask.id, {
      status: "merged",
      pr_url: pullRequest.html_url,
    });
    if (mergedTask) {
      linkedTask = mergedTask;
      await emitProjectMessage(project.id, "letagents", formatTaskLifecycleStatus(mergedTask));
    }
  }

  return linkedTask.id;
}

async function emitGitHubPullRequestEvent(
  project: Project,
  payload: GitHubWebhookPayload
): Promise<{
  status: Exclude<GitHubWebhookDeliveryStatus, "received">;
  installationId: string | null;
  githubRepoId: string | null;
  roomId: string | null;
}> {
  const installationId =
    (await syncGitHubAppInstallationFromPayload(payload)) ??
    toGitHubWebhookId(payload.installation?.id);
  const repositorySync = await syncGitHubAppRepositoryFromPayload(payload.repository, installationId);
  const roomId = repositorySync.roomId ?? project.id;

  if (!payload.repository || !payload.pull_request || !payload.action) {
    return {
      status: "ignored",
      installationId: repositorySync.installationId,
      githubRepoId: repositorySync.githubRepoId,
      roomId,
    };
  }

  const linkedTaskId = await maybeLinkGitHubPullRequestToTask(
    project,
    payload.pull_request,
    payload.action
  );
  const message = formatGitHubPullRequestEventMessage({
    action: payload.action,
    repositoryFullName: payload.repository.full_name,
    pullRequest: payload.pull_request,
    senderLogin: payload.sender?.login ?? null,
    linkedTaskId,
  });

  if (!message) {
    return {
      status: "ignored",
      installationId: repositorySync.installationId,
      githubRepoId: repositorySync.githubRepoId,
      roomId,
    };
  }

  await emitProjectMessage(project.id, "github", message, {
    source: "github",
  });

  return {
    status: "processed",
    installationId: repositorySync.installationId,
    githubRepoId: repositorySync.githubRepoId,
    roomId: project.id,
  };
}

async function handleGitHubWebhookEvent(
  eventName: string,
  payload: GitHubWebhookPayload
): Promise<{
  status: Exclude<GitHubWebhookDeliveryStatus, "received">;
  installationId: string | null;
  githubRepoId: string | null;
  roomId: string | null;
}> {
  const installationId = toGitHubWebhookId(payload.installation?.id);
  const githubRepoId = toGitHubWebhookId(payload.repository?.id);
  const roomId = payload.repository?.full_name
    ? buildGitHubRepoRoomId(payload.repository.full_name)
    : null;

  if (eventName === "ping") {
    return {
      status: "processed",
      installationId,
      githubRepoId,
      roomId,
    };
  }

  switch (eventName) {
    case "installation": {
      if (!installationId || !payload.action) {
        return {
          status: "ignored",
          installationId,
          githubRepoId,
          roomId,
        };
      }

      const now = new Date().toISOString();
      if (payload.action === "deleted") {
        await markGitHubAppInstallationUninstalled(installationId, now);
        return {
          status: "processed",
          installationId,
          githubRepoId,
          roomId,
        };
      }

      if (payload.action === "suspend") {
        const syncedInstallationId = await syncGitHubAppInstallationFromPayload(payload, {
          suspended_at: now,
          uninstalled_at: null,
        });
        if (!payload.installation?.account) {
          await setGitHubAppInstallationSuspended(installationId, now);
        }
        return {
          status: "processed",
          installationId: syncedInstallationId ?? installationId,
          githubRepoId,
          roomId,
        };
      }

      if (payload.action === "unsuspend") {
        const syncedInstallationId = await syncGitHubAppInstallationFromPayload(payload, {
          suspended_at: null,
          uninstalled_at: null,
        });
        if (!payload.installation?.account) {
          await setGitHubAppInstallationSuspended(installationId, null);
        }
        return {
          status: syncedInstallationId ? "processed" : "ignored",
          installationId: syncedInstallationId ?? installationId,
          githubRepoId,
          roomId,
        };
      }

      const syncedInstallationId = await syncGitHubAppInstallationFromPayload(payload, {
        suspended_at: null,
        uninstalled_at: null,
      });
      return {
        status: syncedInstallationId ? "processed" : "ignored",
        installationId: syncedInstallationId ?? installationId,
        githubRepoId,
        roomId,
      };
    }

    case "installation_repositories": {
      if (!installationId) {
        return {
          status: "ignored",
          installationId,
          githubRepoId,
          roomId,
        };
      }

      const syncedInstallationId =
        (await syncGitHubAppInstallationFromPayload(payload, {
          suspended_at: null,
          uninstalled_at: null,
        })) ?? installationId;

      for (const repository of payload.repositories_added ?? []) {
        const ownerLogin = getGitHubRepositoryOwnerLogin(repository);
        const repositoryId = toGitHubWebhookId(repository.id);
        if (!repositoryId || !ownerLogin || !repository.name) {
          continue;
        }

        await upsertGitHubAppRepository({
          github_repo_id: repositoryId,
          installation_id: syncedInstallationId,
          owner_login: ownerLogin,
          repo_name: repository.name,
        });

        // Also seed the stable github_repositories mapping for migration support
        const repoRoomId = buildGitHubRepoRoomId(repository.full_name);
        await upsertGitHubRepositoryLink({
          github_repo_id: repositoryId,
          room_id: repoRoomId,
          owner_login: ownerLogin,
          repo_name: repository.name,
        });
      }

      for (const repository of payload.repositories_removed ?? []) {
        const repositoryId = toGitHubWebhookId(repository.id);
        if (!repositoryId) {
          continue;
        }

        await markGitHubAppRepositoryRemoved(repositoryId);
      }

      return {
        status: "processed",
        installationId: syncedInstallationId,
        githubRepoId,
        roomId,
      };
    }

    case "pull_request": {
      if (!payload.repository) {
        return {
          status: "ignored",
          installationId,
          githubRepoId,
          roomId,
        };
      }

      const project = await getProjectById(roomId ?? "");
      if (!project) {
        const repositorySync = await syncGitHubAppRepositoryFromPayload(
          payload.repository,
          (await syncGitHubAppInstallationFromPayload(payload)) ?? installationId
        );
        return {
          status: "ignored",
          installationId: repositorySync.installationId,
          githubRepoId: repositorySync.githubRepoId,
          roomId: repositorySync.roomId,
        };
      }

      return emitGitHubPullRequestEvent(project, payload);
    }

    case "repository": {
      if (!payload.repository || !payload.action) {
        return {
          status: "ignored",
          installationId,
          githubRepoId,
          roomId,
        };
      }

      // Sync installation first (doesn't touch room mapping)
      const syncedInstallationId =
        (await syncGitHubAppInstallationFromPayload(payload)) ?? installationId;

      // For rename/transfer: migrate BEFORE syncing repo records to new path
      if (payload.action === "renamed" || payload.action === "transferred") {
        const currentOwner = getGitHubRepositoryOwnerLogin(payload.repository);
        const currentName = payload.repository.name;
        const currentFullName = payload.repository.full_name;
        const repoId = toGitHubWebhookId(payload.repository.id);

        // Compute the old full_name from changes
        let oldFullName: string | null = null;
        if (payload.action === "renamed" && payload.changes?.repository?.name?.from) {
          const oldName = payload.changes.repository.name.from;
          oldFullName = `${currentOwner}/${oldName}`;
        } else if (payload.action === "transferred" && payload.changes?.owner?.from?.login) {
          const oldOwner = payload.changes.owner.from.login;
          oldFullName = `${oldOwner}/${currentName}`;
        }

        // Migrate the canonical room ID FIRST (before sync updates the mapping)
        let migratedRoom = null;
        if (repoId) {
          migratedRoom = await migrateGitHubRepositoryCanonicalRoom({
            github_repo_id: repoId,
            owner_login: currentOwner,
            repo_name: currentName,
          });
        }

        // NOW sync repo records to the new path (safe because migration already ran)
        const repositorySync = await syncGitHubAppRepositoryFromPayload(
          payload.repository,
          syncedInstallationId
        );

        // Emit a system event into the room if it exists
        if (migratedRoom) {
          const message = formatGitHubRepositoryEventMessage({
            action: payload.action,
            repositoryFullName: currentFullName,
            oldFullName,
            senderLogin: payload.sender?.login ?? null,
          });
          if (message) {
            await emitProjectMessage(migratedRoom.id, "github", message, {
              source: "github",
            });
          }
        }

        return {
          status: "processed",
          installationId: syncedInstallationId,
          githubRepoId: repositorySync.githubRepoId,
          roomId: repositorySync.roomId,
        };
      }

      // For non-rename/transfer actions, sync normally
      const repositorySync = await syncGitHubAppRepositoryFromPayload(
        payload.repository,
        syncedInstallationId
      );

      return {
        status: "ignored",
        installationId: syncedInstallationId,
        githubRepoId: repositorySync.githubRepoId,
        roomId: repositorySync.roomId,
      };
    }

    default:
      return {
        status: "ignored",
        installationId,
        githubRepoId,
        roomId,
      };
  }
}

const WEB_DIR = path.resolve(process.cwd(), "src", "web");
const VUE_DIST_DIR = path.join(WEB_DIR, "dist");
const VUE_INDEX = path.join(VUE_DIST_DIR, "index.html");
const HAS_VUE_BUILD = fs.existsSync(VUE_INDEX);

function normalizeWebMode(rawMode: string | undefined): "legacy" | "vue" {
  const normalized = (rawMode || "legacy").trim().toLowerCase();
  if (normalized === "vue") {
    return "vue";
  }
  if (normalized !== "" && normalized !== "legacy") {
    const safeRawMode = JSON.stringify(rawMode ?? "");
    console.warn(
      `[web] Unknown LETAGENTS_WEB_MODE=${safeRawMode}. Falling back to legacy mode.`
    );
  }
  return "legacy";
}

const WEB_MODE = normalizeWebMode(process.env.LETAGENTS_WEB_MODE);
const SHOULD_SERVE_VUE = WEB_MODE === "vue" && HAS_VUE_BUILD;

if (WEB_MODE === "vue" && !HAS_VUE_BUILD) {
  console.warn(
    `[web] LETAGENTS_WEB_MODE=vue was set, but ${VUE_INDEX} is missing. Falling back to legacy pages.`
  );
}

console.log(
  `[web] Serving ${SHOULD_SERVE_VUE ? "vue" : "legacy"} web UI (requested mode: ${WEB_MODE}).`
);

const app = express();
app.use(
  express.json({
    verify(req, _res, buf) {
      const request = req as AuthenticatedRequest & { originalUrl?: string };
      if (request.originalUrl?.startsWith("/webhooks/github")) {
        request.rawBody = Buffer.from(buf);
      }
    },
  })
);

const SAFE_BAD_REQUEST_PATTERNS = [
  /^Invalid transition:/,
  /^display_name must be between 2 and 64 characters$/,
];

function logServerError(context: string, error: unknown): void {
  console.error(`[${context}]`, error);
}

function isSafeBadRequestError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    SAFE_BAD_REQUEST_PATTERNS.some((pattern) => pattern.test(error.message))
  );
}

function respondWithInternalError(
  res: Response,
  context: string,
  error: unknown,
  message: string
): void {
  return respondWithError(res, 500, context, message, error);
}

function respondWithBadRequest(
  res: Response,
  context: string,
  error: unknown,
  fallbackMessage: string
): void {
  if (isSafeBadRequestError(error)) {
    res.status(400).json({ error: error.message });
    return;
  }

  respondWithError(res, 400, context, fallbackMessage, error);
}

function respondWithError(
  res: Response,
  status: number,
  context: string,
  message: string,
  error?: unknown
): void {
  if (error !== undefined) {
    logServerError(context, error);
  }
  res.status(status).json({ error: message });
}

app.use(async (req: AuthenticatedRequest, _res, next) => {
  try {
    const auth = await resolveRequestAuth(req);
    req.sessionAccount = auth.account;
    req.authKind = auth.authKind;
    next();
  } catch (error) {
    next(error);
  }
});

// CORS: restrict to known origins instead of wildcard
const ALLOWED_ORIGINS = new Set([
  "https://letagents.chat",
  "http://localhost:3001",
  "http://localhost:3000",
  "http://127.0.0.1:3001",
  "http://127.0.0.1:3000",
  ...(process.env.LETAGENTS_BASE_URL
    ? [process.env.LETAGENTS_BASE_URL.replace(/\/+$/, "")]
    : []),
  ...(process.env.PUBLIC_API_URL
    ? [process.env.PUBLIC_API_URL.replace(/\/+$/, "")]
    : []),
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

app.options("{*path}", (_req, res) => {
  res.sendStatus(204);
});

// Serve Vue build assets only when the server is explicitly configured to use the Vue frontend.
if (SHOULD_SERVE_VUE) {
  app.use("/assets", express.static(path.join(VUE_DIST_DIR, "assets"), {
    maxAge: "1y",
    immutable: true,
  }));
  app.use("/images", express.static(path.join(VUE_DIST_DIR, "images"), {
    maxAge: "1d",
  }));
}

app.get("/", (_req, res) => {
  if (SHOULD_SERVE_VUE) {
    res.sendFile(VUE_INDEX);
  } else {
    res.sendFile(path.join(WEB_DIR, "landing.html"));
  }
});

app.get("/docs", (_req, res) => {
  if (SHOULD_SERVE_VUE) {
    res.sendFile(VUE_INDEX);
  } else {
    res.sendFile(path.join(WEB_DIR, "docs.html"));
  }
});

app.get("/app", (_req, res) => {
  res.redirect(301, "/");
});

app.use(express.static(WEB_DIR, { index: false }));

app.get(/^\/api\/rooms\/resolve\/(.+)$/, async (req, res) => {
  const identifier = decodeURIComponent(req.params[0] || "");
  const resolved = resolveRoomIdentifier(identifier);
  if (resolved.type === "invite") {
    res.json(resolved);
    return;
  }

  const project = await getProjectById(resolved.name);
  res.json({
    ...resolved,
    canonical_room_id: project?.id ?? resolved.name,
  });
});

app.get("/:provider/:owner/:repo", (req, res, next) => {
  const provider = req.params.provider.toLowerCase();

  if (!isKnownProvider(provider)) {
    return next();
  }

  const roomKey = `${provider}/${req.params.owner}/${req.params.repo}`;
  const normalized = normalizeRoomName(roomKey);
  res.redirect(301, `/in/${normalized}`);
});

app.get(/^\/in\/(.+)$/, async (req: AuthenticatedRequest, res) => {
  const roomIdentifier = decodeURIComponent(req.params[0] || "");
  const resolved = resolveRoomIdentifier(roomIdentifier);

  if (resolved.type === "room") {
    const project = await getProjectById(resolved.name);
    const canonicalRoomId = project?.id ?? resolved.name;

    if (canonicalRoomId !== roomIdentifier) {
      res.redirect(301, `/in/${canonicalRoomId}`);
      return;
    }

    if (isRepoBackedRoomId(canonicalRoomId)) {
      const decision = await resolveGitHubRoomEntryDecision({
        roomName: canonicalRoomId,
        sessionAccount: req.sessionAccount,
        redirectTo: `/in/${canonicalRoomId}`,
      });

      if (decision.kind === "redirect") {
        res.redirect(302, decision.location);
        return;
      }
    }
  }

  if (SHOULD_SERVE_VUE) {
    res.sendFile(VUE_INDEX);
  } else {
    res.sendFile(path.join(WEB_DIR, "index.html"));
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "letagents-api" });
});

app.get("/auth/github/app/callback", async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const setupAction = typeof req.query.setup_action === "string" ? req.query.setup_action : undefined;

  let stateValid = false;
  let redirectTo = "/";
  if (state) {
    const authState = await consumeAuthState(state);
    if (authState) {
      stateValid = true;
      redirectTo = authState.redirect_to || "/";
    }
  }

  res.redirect(
    302,
    buildGitHubAppSetupRedirectPath({
      redirectTo,
      setupAction,
      stateValid,
    })
  );
});

app.post("/webhooks/github", async (req: AuthenticatedRequest, res) => {
  const config = getGitHubAppConfig();
  if (!config.webhookSecret) {
    res.status(503).json({ error: "GitHub App webhook handling is not configured" });
    return;
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    res.status(400).json({ error: "Raw webhook body is required" });
    return;
  }

  const metadata = getGitHubWebhookMetadata(
    req.headers as Record<string, string | string[] | undefined>
  );
  if (!metadata.deliveryId || !metadata.eventName) {
    res.status(400).json({ error: "Missing GitHub webhook headers" });
    return;
  }

  if (!verifyGitHubWebhookSignature(rawBody, metadata.signature256, config.webhookSecret)) {
    res.status(401).json({ error: "Invalid GitHub webhook signature" });
    return;
  }

  const payload = req.body as GitHubWebhookPayload;
  const initialInstallationId = toGitHubWebhookId(payload.installation?.id);
  const initialGitHubRepoId = toGitHubWebhookId(payload.repository?.id);
  const initialRoomId = payload.repository?.full_name
    ? buildGitHubRepoRoomId(payload.repository.full_name)
    : null;

  const delivery = await recordGitHubWebhookDelivery({
    delivery_id: metadata.deliveryId,
    event_name: metadata.eventName,
    action: payload.action ?? null,
    installation_id: initialInstallationId,
    github_repo_id: initialGitHubRepoId,
    room_id: initialRoomId,
  });

  if (delivery.duplicate) {
    res.status(202).json({ ok: true, duplicate: true });
    return;
  }

  try {
    const result = await handleGitHubWebhookEvent(metadata.eventName, payload);
    await markGitHubWebhookDeliveryProcessed(metadata.deliveryId, {
      status: result.status,
      installation_id: result.installationId,
      github_repo_id: result.githubRepoId,
      room_id: result.roomId,
      error: null,
    });

    res.status(202).json({
      ok: true,
      status: result.status,
    });
  } catch (error) {
    await markGitHubWebhookDeliveryProcessed(metadata.deliveryId, {
      status: "failed",
      installation_id: initialInstallationId,
      github_repo_id: initialGitHubRepoId,
      room_id: initialRoomId,
      error: error instanceof Error ? error.message : "Unknown GitHub webhook processing error",
    });

    respondWithInternalError(
      res,
      "POST /webhooks/github",
      error,
      "GitHub webhook processing failed."
    );
  }
});

app.post("/auth/github/login", async (req, res) => {
  const redirectTo = sanitizeRedirectPath(
    typeof req.body?.redirect_to === "string" ? req.body.redirect_to : undefined,
    "/"
  );
  const state = crypto.randomBytes(24).toString("hex");

  await createAuthState(state, redirectTo);

  try {
    const authUrl = buildGitHubAuthorizeUrl(state);
    res.json({ auth_url: authUrl, state, redirect_to: redirectTo });
  } catch (error) {
    respondWithInternalError(
      res,
      "POST /auth/github/login",
      error,
      "GitHub login is currently unavailable."
    );
  }
});

app.post("/auth/device/start", async (_req, res) => {
  cleanupExpiredDeviceAuths();

  try {
    const device = await requestGitHubDeviceCode();
    const requestId = crypto.randomBytes(16).toString("hex");
    pendingDeviceAuths.set(requestId, {
      deviceCode: device.device_code,
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      intervalSeconds: device.interval,
      expiresAt: Date.now() + device.expires_in * 1000,
      lastPollAt: null,
    });

    res.status(201).json({
      request_id: requestId,
      user_code: device.user_code,
      verification_uri: device.verification_uri,
      expires_in: device.expires_in,
      interval: device.interval,
    });
  } catch (error) {
    respondWithInternalError(
      res,
      "POST /auth/device/start",
      error,
      "Device authorization is currently unavailable."
    );
  }
});

app.get("/auth/device/poll/:requestId", async (req, res) => {
  cleanupExpiredDeviceAuths();

  const requestId = String(req.params.requestId);
  const pending = pendingDeviceAuths.get(requestId);
  if (!pending) {
    res.status(404).json({ error: "Unknown or expired device authorization request" });
    return;
  }

  const now = Date.now();
  if (pending.lastPollAt && now - pending.lastPollAt < pending.intervalSeconds * 1000) {
    res.status(429).json({
      error: "Polling too quickly",
      interval: pending.intervalSeconds,
    });
    return;
  }

  pending.lastPollAt = now;

  try {
    const result = await exchangeGitHubDeviceCodeForAccessToken({
      deviceCode: pending.deviceCode,
    });

    if (result.status === "pending" || result.status === "slow_down") {
      if (result.status === "slow_down") {
        pending.intervalSeconds = Math.max(
          pending.intervalSeconds + 5,
          result.interval ?? pending.intervalSeconds + 5
        );
      }

      res.json({
        status: result.status,
        interval: pending.intervalSeconds,
        expires_in: Math.max(0, Math.ceil((pending.expiresAt - now) / 1000)),
      });
      return;
    }

    if (result.status === "denied" || result.status === "expired") {
      pendingDeviceAuths.delete(requestId);
      res.status(result.status === "denied" ? 403 : 410).json({ status: result.status });
      return;
    }

    const githubUser = await fetchGitHubUser(result.accessToken);
    const account = await upsertAccount({
      provider: "github",
      provider_user_id: String(githubUser.id),
      login: githubUser.login,
      display_name: githubUser.name,
      avatar_url: githubUser.avatar_url,
    });
    await refreshProviderAccessTokenForAccount(account.id, result.accessToken);
    clearGitHubRepoAccessCacheForLogin(account.login);

    const ownerToken = crypto.randomBytes(32).toString("hex");
    const ownerCredential = await createOwnerToken({
      accountId: account.id,
      githubUserId: String(githubUser.id),
      token: ownerToken,
      providerAccessToken: result.accessToken,
      oauthTokenExpiresAt: null,
    });
    pendingDeviceAuths.delete(requestId);

    res.json({
      status: "authorized",
      letagents_token: ownerToken,
      owner_token_id: ownerCredential.token_id,
      oauth_token_expires_at: ownerCredential.oauth_token_expires_at,
      account: {
        id: account.id,
        login: account.login,
        display_name: account.display_name,
        avatar_url: account.avatar_url,
        provider: account.provider,
        provider_user_id: account.provider_user_id,
      },
    });
  } catch (error) {
    respondWithInternalError(
      res,
      "GET /auth/device/poll/:requestId",
      error,
      "Device authorization polling failed."
    );
  }
});

app.get("/auth/github/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;

  if (!code || !state) {
    res.status(400).json({ error: "Missing code or state" });
    return;
  }

  const authState = await consumeAuthState(state);
  if (!authState) {
    res.status(400).json({ error: "Invalid or expired auth state" });
    return;
  }

  try {
    const accessToken = await exchangeGitHubCodeForAccessToken(code);
    const githubUser = await fetchGitHubUser(accessToken);
    const account = await upsertAccount({
      provider: "github",
      provider_user_id: String(githubUser.id),
      login: githubUser.login,
      display_name: githubUser.name,
      avatar_url: githubUser.avatar_url,
    });
    await refreshProviderAccessTokenForAccount(account.id, accessToken);
    clearGitHubRepoAccessCacheForLogin(account.login);

    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    const sessionToken = crypto.randomBytes(32).toString("hex");
    await createSession(account.id, sessionToken, expiresAt, accessToken);
    setSessionCookie(res, sessionToken);

    if (authState.redirect_to) {
      res.redirect(authState.redirect_to);
      return;
    }

    res.json({
      authenticated: true,
      account: {
        id: account.id,
        login: account.login,
        display_name: account.display_name,
        avatar_url: account.avatar_url,
      },
    });
  } catch (error) {
    respondWithInternalError(
      res,
      "GET /auth/github/callback",
      error,
      "GitHub authentication failed."
    );
  }
});

async function getGitHubRoomIntegrationProject(
  req: AuthenticatedRequest,
  res: Response,
  rawId: string
): Promise<Project | null> {
  const roomId = await resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
  const project = await resolveRoomOrReply(roomId, res);
  if (!project) {
    return null;
  }

  if (!isRepoBackedProject(project)) {
    res.status(400).json({ error: "GitHub App integrations are only available for repo-backed rooms" });
    return null;
  }

  if (!(await requireParticipant(req, res, project))) {
    return null;
  }

  return project;
}

async function buildGitHubRoomIntegrationResponse(project: Project): Promise<ReturnType<typeof resolveGitHubAppRoomIntegrationStatus>> {
  const config = getGitHubAppConfig();
  const repository = await getGitHubAppRepositoryByRoomId(project.id);
  const installation = repository
    ? await getGitHubAppInstallationById(repository.installation_id)
    : null;

  return resolveGitHubAppRoomIntegrationStatus({
    configured: hasGitHubAppConfig(),
    appSlug: config.appSlug ?? null,
    setupUrl: config.setupUrl ?? null,
    repository,
    installation,
  });
}

app.get(/^\/api\/rooms\/(.+)\/integrations\/github$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const project = await getGitHubRoomIntegrationProject(req, res, rawId);
  if (!project) {
    return;
  }

  res.json({
    room_id: project.id,
    ...(await buildGitHubRoomIntegrationResponse(project)),
  });
});

app.get(/^\/rooms\/(.+)\/integrations\/github$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const project = await getGitHubRoomIntegrationProject(req, res, rawId);
  if (!project) {
    return;
  }

  res.json({
    room_id: project.id,
    ...(await buildGitHubRoomIntegrationResponse(project)),
  });
});

app.post(/^\/api\/rooms\/(.+)\/integrations\/github\/install-url$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const project = await getGitHubRoomIntegrationProject(req, res, rawId);
  if (!project) {
    return;
  }

  if (!(await requireAdmin(req, res, project))) {
    return;
  }

  const config = getGitHubAppConfig();
  if (!hasGitHubAppConfig() || !config.appSlug) {
    res.status(503).json({ error: "GitHub App install flow is not configured" });
    return;
  }

  const state = crypto.randomBytes(24).toString("hex");
  await createAuthState(state, `/in/${project.id}`);

  res.json({
    room_id: project.id,
    install_url: buildGitHubAppInstallationUrl({
      appSlug: config.appSlug,
      state,
    }),
    setup_url: config.setupUrl,
    state,
  });
});

app.post(/^\/rooms\/(.+)\/integrations\/github\/install-url$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const project = await getGitHubRoomIntegrationProject(req, res, rawId);
  if (!project) {
    return;
  }

  if (!(await requireAdmin(req, res, project))) {
    return;
  }

  const config = getGitHubAppConfig();
  if (!hasGitHubAppConfig() || !config.appSlug) {
    res.status(503).json({ error: "GitHub App install flow is not configured" });
    return;
  }

  const state = crypto.randomBytes(24).toString("hex");
  await createAuthState(state, `/in/${project.id}`);

  res.json({
    room_id: project.id,
    install_url: buildGitHubAppInstallationUrl({
      appSlug: config.appSlug,
      state,
    }),
    setup_url: config.setupUrl,
    state,
  });
});

app.get("/auth/session", (req: AuthenticatedRequest, res) => {
  if (!req.sessionAccount) {
    res.json({ authenticated: false });
    return;
  }

  res.json({
    authenticated: true,
    account: {
      id: req.sessionAccount.account_id,
      provider: req.sessionAccount.provider,
      provider_user_id: req.sessionAccount.provider_user_id,
      login: req.sessionAccount.login,
      display_name: req.sessionAccount.display_name,
      avatar_url: req.sessionAccount.avatar_url,
    },
  });
});

app.post("/auth/logout", async (req: AuthenticatedRequest, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.letagents_session) {
    await deleteSessionByToken(cookies.letagents_session);
  }
  clearSessionCookie(res);
  res.json({ success: true });
});

app.get("/projects", async (req: AuthenticatedRequest, res) => {
  const { account } = await resolveRequestAuth(req);
  if (!account) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const projects = await getAllProjects();
  // Exclude invite-only rooms — their IDs ARE their join codes
  const safeProjects = projects
    .filter(({ id }) => !isInviteCode(id))
    .map(({ id, display_name }) => ({ id, display_name }));
  res.json({ projects: safeProjects });
});

app.post("/projects", async (req: AuthenticatedRequest, res) => {
  const project = await createProject();
  if (req.sessionAccount) {
    await assignProjectAdmin(project.id, req.sessionAccount.account_id);
  }
  res.status(201).json(project);
});

app.get("/projects/join/:code", async (req, res) => {
  const code = normalizeRoomId(req.params.code);
  const project = await getProjectByCode(code);

  if (!project) {
    res.status(404).json({ error: "Project not found for the given code" });
    return;
  }

  res.json({
    id: project.id,
    code: project.code,
    name: project.name,
    display_name: project.display_name,
  });
});

app.post("/projects/room/:name", async (req: AuthenticatedRequest, res) => {
  const name = decodeURIComponent(String(req.params.name));
  const requestedRoomId = normalizeRoomId(name);
  const roomId = await resolveCanonicalRoomRequestId(requestedRoomId);

  if (isRepoBackedRoomId(roomId)) {
    const decision = await resolveRepoRoomAccessDecision({
      roomName: roomId,
      sessionAccount: req.sessionAccount,
    });
    if (decision.kind !== "allow") {
      replyRepoRoomAccessDecision(res, roomId, decision);
      return;
    }
  }

  const { room: project, created } = await getOrCreateCanonicalRoom(roomId);

  if (req.sessionAccount && created) {
    if (isRepoBackedProject(project)) {
      await resolveProjectRole(project, req.sessionAccount);
    } else {
      await assignProjectAdmin(project.id, req.sessionAccount.account_id);
    }
  }

  res.status(created ? 201 : 200).json({
    id: project.id,
    code: project.code,
    name: project.name,
    display_name: project.display_name,
  });
});

app.get("/projects/:id/access", async (req: AuthenticatedRequest, res) => {
  const projectId = await resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
  const project = await getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const role = await resolveProjectRole(project, req.sessionAccount);
  res.json({
    project_id: project.id,
    room_type: isRepoBackedProject(project) ? "discoverable" : "invite",
    authenticated: Boolean(req.sessionAccount),
    role,
    account: req.sessionAccount
      ? {
          id: req.sessionAccount.account_id,
          login: req.sessionAccount.login,
          provider: req.sessionAccount.provider,
        }
      : null,
  });
});

app.post("/projects/:id/code/rotate", async (req: AuthenticatedRequest, res) => {
  const projectId = await resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
  const project = await getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!(await requireAdmin(req, res, project))) {
    return;
  }

  if (!project.code) {
    res.status(400).json({ error: "Only invite rooms can rotate codes" });
    return;
  }

  const rotated = await rotateProjectCode(project.id);
  if (!rotated) {
    res.status(500).json({ error: "Failed to rotate invite code" });
    return;
  }

  res.json({
    id: rotated.id,
    code: rotated.code,
    name: rotated.name,
    display_name: rotated.display_name,
  });
});

app.get("/agents/me", async (req: AuthenticatedRequest, res) => {
  if (!req.sessionAccount) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  res.json({
    account: {
      id: req.sessionAccount.account_id,
      login: req.sessionAccount.login,
      display_name: req.sessionAccount.display_name ?? null,
    },
    agents: await getAgentIdentitiesForOwner(req.sessionAccount.account_id),
  });
});

app.post("/agents", async (req: AuthenticatedRequest, res) => {
  if (!req.sessionAccount) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const { name, display_name, owner_label } = req.body as {
    name?: string;
    display_name?: string;
    owner_label?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const identity = await registerAgentIdentity({
    owner_account_id: req.sessionAccount.account_id,
    owner_login: req.sessionAccount.login,
    owner_label: owner_label?.trim() || req.sessionAccount.display_name || req.sessionAccount.login,
    name: name.trim(),
    display_name: display_name?.trim(),
  });

  res.status(201).json(identity);
});

app.post("/projects/:id/messages", async (req: AuthenticatedRequest, res) => {
  const projectId = await resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
  const project = await getProjectById(projectId);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!(await requireParticipant(req, res, project))) {
    return;
  }

  const { sender, text, agent_prompt_kind } = req.body as {
    sender?: string;
    text?: string;
    agent_prompt_kind?: string;
  };

  try {
    const promptKind = parseOptionalAgentPromptKind(agent_prompt_kind);
    const normalizedSender = typeof sender === "string" ? sender.trim() : "";
    if (
      !normalizedSender ||
      typeof text !== "string" ||
      (!text.trim() && (!promptKind || promptKind !== "auto"))
    ) {
      res.status(400).json({ error: "sender and text are required" });
      return;
    }
    const source = req.authKind === "session" ? "browser" : req.authKind === "owner_token" ? "agent" : undefined;
    const message = await emitProjectMessage(projectId, normalizedSender, text, {
      source,
      agent_prompt_kind: promptKind,
    });
    res.status(201).json(message);
  } catch (error) {
    respondWithBadRequest(
      res,
      "POST /projects/:id/messages",
      error,
      "Message could not be created."
    );
  }
});

app.get("/projects/:id/messages", async (req: AuthenticatedRequest, res) => {
  const projectId = await resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
  const project = await getProjectById(projectId);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!(await requireParticipant(req, res, project))) {
    return;
  }

  const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
  const after = typeof req.query.after === "string" ? req.query.after : undefined;
  const result = await getMessages(projectId, {
    limit,
    after,
    include_prompt_only: shouldIncludePromptOnlyMessages(req),
  });

  res.json({
    project_id: projectId,
    messages: result.messages,
    has_more: result.has_more,
  });
});

app.get("/projects/:id/messages/stream", async (req: AuthenticatedRequest, res) => {
  const projectId = await resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
  const project = await getProjectById(projectId);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!(await requireParticipant(req, res, project))) {
    return;
  }

  const heartbeat = startSseStream(res);

  const onMessageCreated = ({ projectId: eventProjectId, message }: MessageCreatedEvent) => {
    if (eventProjectId !== projectId) {
      return;
    }
    if (!shouldIncludePromptOnlyMessages(req) && isPromptOnlyAgentMessage(message.text, message.agent_prompt_kind)) {
      return;
    }

    res.write(`data: ${JSON.stringify(message)}\n\n`);
  };

  messageEvents.on("message:created", onMessageCreated);

  req.on("close", () => {
    messageEvents.off("message:created", onMessageCreated);
    stopSseStream(res, heartbeat);
  });
});

app.get("/projects/:id/messages/poll", async (req: AuthenticatedRequest, res) => {
  const projectId = await resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
  const project = await getProjectById(projectId);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!(await requireParticipant(req, res, project))) {
    return;
  }

  const after = typeof req.query.after === "string" ? req.query.after : undefined;
  const timeoutMs = parsePollTimeout(typeof req.query.timeout === "string" ? req.query.timeout : undefined);
  const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
  const includePromptOnly = shouldIncludePromptOnlyMessages(req);
  const existing = await getMessagesAfter(projectId, after, {
    limit,
    include_prompt_only: includePromptOnly,
  });

  if (existing.messages.length > 0) {
    res.json({ project_id: projectId, messages: existing.messages, has_more: existing.has_more });
    return;
  }

  let settled = false;

  const cleanup = () => {
    clearTimeout(timeout);
    messageEvents.off("message:created", onMessageCreated);
    req.off("close", onClientClose);
  };

  const resolveRequest = (msgs: Message[], hasMore = false) => {
    if (settled) {
      return;
    }

    settled = true;
    cleanup();
    res.json({ project_id: projectId, messages: msgs, has_more: hasMore });
  };

  const onMessageCreated = async ({ projectId: eventProjectId }: MessageCreatedEvent) => {
    if (eventProjectId !== projectId) {
      return;
    }

    const next = await getMessagesAfter(projectId, after, {
      limit,
      include_prompt_only: includePromptOnly,
    });
    if (next.messages.length > 0) {
      resolveRequest(next.messages, next.has_more);
    }
  };

  const onClientClose = () => {
    if (settled) {
      return;
    }

    settled = true;
    cleanup();
  };

  const timeout = setTimeout(() => {
    resolveRequest([]);
  }, timeoutMs);

  messageEvents.on("message:created", onMessageCreated);
  req.on("close", onClientClose);
});

app.post("/projects/:id/tasks", async (req: AuthenticatedRequest, res) => {
  const projectId = await resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
  const project = await getProjectById(projectId);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { title, description, created_by, source_message_id } = req.body as {
    title?: string;
    description?: string;
    created_by?: string;
    source_message_id?: string;
  };

  if (!title || !created_by) {
    res.status(400).json({ error: "title and created_by are required" });
    return;
  }

  if (!(await requireParticipant(req, res, project))) {
    return;
  }

  const task = await createTask(projectId, title, created_by, description, source_message_id);

  if (!(await isTrustedAgentCreator(projectId, created_by))) {
    res.status(201).json(task);
    return;
  }

  const acceptedTask = await updateTask(projectId, task.id, { status: "accepted" });
  if (!acceptedTask) {
    res.status(500).json({ error: "Task created but could not be auto-accepted" });
    return;
  }

  await emitProjectMessage(projectId, "letagents", formatTaskLifecycleStatus(acceptedTask));
  res.status(201).json(acceptedTask);
});

app.get("/projects/:id/tasks", async (req: AuthenticatedRequest, res) => {
  const projectId = await resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
  const project = await getProjectById(projectId);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!(await requireParticipant(req, res, project))) {
    return;
  }

  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const open = req.query.open === "true";
  const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
  const after = typeof req.query.after === "string" ? req.query.after : undefined;

  const result = open ? await getOpenTasks(projectId, { limit, after }) : await getTasks(projectId, status, { limit, after });
  res.json({ project_id: projectId, tasks: result.tasks, has_more: result.has_more });
});

app.get("/projects/:id/tasks/:taskId", async (req: AuthenticatedRequest, res) => {
  const projectId = await resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
  const project = await getProjectById(projectId);
  const taskId = String(req.params.taskId);
  const task = await getTaskById(projectId, taskId);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!(await requireParticipant(req, res, project))) {
    return;
  }

  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  res.json(task);
});

app.patch("/projects/:id/tasks/:taskId", async (req: AuthenticatedRequest, res) => {
  const projectId = await resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
  const taskId = String(req.params.taskId);
  const task = await getTaskById(projectId, taskId);

  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const project = await getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!(await requireParticipant(req, res, project))) {
    return;
  }

  const { status, assignee, pr_url } = req.body as {
    status?: TaskStatus;
    assignee?: string;
    pr_url?: string;
  };

  try {
    const adminOnlyStatuses = new Set<TaskStatus>(["accepted", "cancelled", "merged", "done"]);
    if (status && adminOnlyStatuses.has(status)) {
      if (!(await requireAdmin(req, res, project))) {
        return;
      }
    }

    const updated = await updateTask(projectId, taskId, { status, assignee, pr_url });
    if (updated && status && status !== task.status) {
      await emitProjectMessage(projectId, "letagents", formatTaskLifecycleStatus(updated));
    }
    res.json(updated);
  } catch (error) {
    respondWithBadRequest(
      res,
      "PATCH /projects/:id/tasks/:taskId",
      error,
      "Task update could not be completed."
    );
  }
});

// ═══════════════════════════════════════════════════════════════════
// CANONICAL ROOM ROUTES  (/rooms/*room_id/)
//
// These are the primary public API endpoints. All consumers (MCP,
// browser, CI agents) should use these instead of /projects/:id.
//
// Room ID can be:
//   - Invite code:   ABCD-EFGH-IJKL (parsers also accept ABCD-EFGH during transition)
//   - Repo URL: github.com/owner/repo (also accepts https:// prefix,
//               .git suffix, SSH remote format — all normalized)
//
// Error codes used in this section:
//   NOT_AUTHENTICATED      — no credential at all
//   TOKEN_INVALID          — credential present but not valid / revoked
//   PRIVATE_REPO_NO_ACCESS — owner known, but no collaborator access
//   ROOM_NOT_FOUND         — canonical ID does not map to any room
// ═══════════════════════════════════════════════════════════════════

/** Simple in-memory rate limiter for room join attempts. */
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



app.get("/rooms/resolve/:identifier", async (req, res) => {
  const identifier = decodeURIComponent(req.params.identifier);
  const normalized = normalizeRoomId(identifier);
  const resolved = resolveRoomIdentifier(normalized);
  if (resolved.type === "invite") {
    res.json({ input: identifier, normalized, resolved });
    return;
  }

  const project = await getProjectById(resolved.name);
  res.json({
    input: identifier,
    normalized,
    resolved,
    canonical_room_id: project?.id ?? resolved.name,
  });
});

app.post(/^\/rooms\/(.+)\/join$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const requestedRoomId = normalizeRoomId(rawId);
  const roomId = await resolveCanonicalRoomRequestId(requestedRoomId);

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

  if (isRepoBackedRoomId(roomId)) {
    const decision = await resolveRepoRoomAccessDecision({
      roomName: roomId,
      sessionAccount: req.sessionAccount,
    });
    if (decision.kind !== "allow") {
      replyRepoRoomAccessDecision(res, roomId, decision);
      return;
    }
  }

  const project = await resolveRoomOrReply(roomId, res, { allowCreate: true });
  if (!project) return;

  if (req.sessionAccount) {
    if (isRepoBackedProject(project)) {
      await resolveProjectRole(project, req.sessionAccount);
    } else {
      await assignProjectAdmin(project.id, req.sessionAccount.account_id);
    }
  }

  const role = await resolveProjectRole(project, req.sessionAccount);

  res.status(200).json({
    room_id: project.id,
    name: project.name ?? null,
    display_name: project.display_name,
    code: project.code,
    created_at: project.created_at,
    role,
    authenticated: Boolean(req.sessionAccount),
  });
});

app.post(/^\/rooms\/(.+)\/messages$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = await resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

  const project = await resolveRoomOrReply(roomId, res);
  if (!project) return;

  if (!(await requireParticipant(req, res, project))) return;

  const { sender, text, agent_prompt_kind } = req.body as {
    sender?: string;
    text?: string;
    agent_prompt_kind?: string;
  };
  try {
    const promptKind = parseOptionalAgentPromptKind(agent_prompt_kind);
    const normalizedSender = typeof sender === "string" ? sender.trim() : "";
    if (
      !normalizedSender ||
      typeof text !== "string" ||
      (!text.trim() && (!promptKind || promptKind !== "auto"))
    ) {
      res.status(400).json({ error: "sender and text are required" });
      return;
    }
    const source = req.authKind === "session" ? "browser" : req.authKind === "owner_token" ? "agent" : undefined;
    const message = await emitProjectMessage(project.id, normalizedSender, text, {
      source,
      agent_prompt_kind: promptKind,
    });
    res.status(201).json({
      ...message,
      room_id: project.id,
    });
  } catch (error) {
    respondWithBadRequest(
      res,
      "POST /rooms/:room_id/messages",
      error,
      "Message could not be created."
    );
  }
});

app.get(/^\/rooms\/(.+)\/messages$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = await resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

  const project = await resolveRoomOrReply(roomId, res);
  if (!project) return;

  if (!(await requireParticipant(req, res, project))) return;

  const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
  const after = typeof req.query.after === "string" ? req.query.after : undefined;
  const result = await getMessages(project.id, {
    limit,
    after,
    include_prompt_only: shouldIncludePromptOnlyMessages(req),
  });

  res.json({
    room_id: project.id,
    messages: result.messages,
    has_more: result.has_more,
  });
});

app.get(/^\/rooms\/(.+)\/messages\/poll$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = await resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

  const project = await resolveRoomOrReply(roomId, res);
  if (!project) return;

  if (!(await requireParticipant(req, res, project))) return;

  const projectId = project.id;
  const after = typeof req.query.after === "string" ? req.query.after : undefined;
  const timeoutMs = parsePollTimeout(typeof req.query.timeout === "string" ? req.query.timeout : undefined);
  const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
  const includePromptOnly = shouldIncludePromptOnlyMessages(req);
  const existing = await getMessagesAfter(projectId, after, {
    limit,
    include_prompt_only: includePromptOnly,
  });

  if (existing.messages.length > 0) {
    res.json({ room_id: project.id, messages: existing.messages, has_more: existing.has_more });
    return;
  }

  let settled = false;

  const cleanup = () => {
    clearTimeout(timeout);
    messageEvents.off("message:created", onMessageCreated);
    req.off("close", onClientClose);
  };

  const resolveRequest = (msgs: Message[], hasMore = false) => {
    if (settled) return;
    settled = true;
    cleanup();
    res.json({ room_id: project.id, messages: msgs, has_more: hasMore });
  };

  const onMessageCreated = async ({ projectId: eventProjectId }: MessageCreatedEvent) => {
    if (eventProjectId !== projectId) return;
    const next = await getMessagesAfter(projectId, after, {
      limit,
      include_prompt_only: includePromptOnly,
    });
    if (next.messages.length > 0) resolveRequest(next.messages, next.has_more);
  };

  const onClientClose = () => {
    if (settled) return;
    settled = true;
    cleanup();
  };

  const timeout = setTimeout(() => resolveRequest([]), timeoutMs);
  messageEvents.on("message:created", onMessageCreated);
  req.on("close", onClientClose);
});

app.get(/^\/rooms\/(.+)\/messages\/stream$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = await resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

  const project = await resolveRoomOrReply(roomId, res);
  if (!project) return;

  if (!(await requireParticipant(req, res, project))) return;

  const projectId = project.id;

  const heartbeat = startSseStream(res);

  const onMessageCreated = ({ projectId: eventProjectId, message }: MessageCreatedEvent) => {
    if (eventProjectId !== projectId) return;
    if (!shouldIncludePromptOnlyMessages(req) && isPromptOnlyAgentMessage(message.text, message.agent_prompt_kind)) {
      return;
    }
    res.write(`data: ${JSON.stringify({ ...message, room_id: project.id })}\n\n`);
  };

  messageEvents.on("message:created", onMessageCreated);

  req.on("close", () => {
    messageEvents.off("message:created", onMessageCreated);
    stopSseStream(res, heartbeat);
  });
});

app.get(/^\/rooms\/(.+)\/tasks$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = await resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

  const project = await resolveRoomOrReply(roomId, res);
  if (!project) return;

  if (!(await requireParticipant(req, res, project))) return;

  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const open = req.query.open === "true";
  const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
  const after = typeof req.query.after === "string" ? req.query.after : undefined;
  const result = open ? await getOpenTasks(project.id, { limit, after }) : await getTasks(project.id, status, { limit, after });

  res.json({ room_id: project.id, tasks: result.tasks, has_more: result.has_more });
});

app.post(/^\/rooms\/(.+)\/tasks$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = await resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

  const project = await resolveRoomOrReply(roomId, res, { allowCreate: false });
  if (!project) return;

  if (!(await requireParticipant(req, res, project))) return;

  const { title, description, created_by, source_message_id } = req.body as {
    title?: string;
    description?: string;
    created_by?: string;
    source_message_id?: string;
  };

  if (!title || !created_by) {
    res.status(400).json({ error: "title and created_by are required" });
    return;
  }

  const task = await createTask(project.id, title, created_by, description, source_message_id);

  if (!(await isTrustedAgentCreator(project.id, created_by))) {
    res.status(201).json({ ...task, room_id: project.id });
    return;
  }

  const acceptedTask = await updateTask(project.id, task.id, { status: "accepted" });
  if (!acceptedTask) {
    res.status(500).json({ error: "Task created but could not be auto-accepted" });
    return;
  }

  await emitProjectMessage(project.id, "letagents", formatTaskLifecycleStatus(acceptedTask));
  res.status(201).json({ ...acceptedTask, room_id: project.id });
});

app.get(/^\/rooms\/(.+)\/tasks\/([^/]+)$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = await resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
  const taskId = (req.params as Record<string, string>)[1] ?? "";

  const project = await resolveRoomOrReply(roomId, res);
  if (!project) return;

  if (!(await requireParticipant(req, res, project))) return;

  const task = await getTaskById(project.id, taskId);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  res.json({ ...task, room_id: project.id });
});

app.patch(/^\/rooms\/(.+)\/tasks\/([^/]+)$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = await resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
  const taskId = (req.params as Record<string, string>)[1] ?? "";

  const project = await resolveRoomOrReply(roomId, res);
  if (!project) return;

  if (!(await requireParticipant(req, res, project))) return;

  const task = await getTaskById(project.id, taskId);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const { status, assignee, pr_url } = req.body as {
    status?: TaskStatus;
    assignee?: string;
    pr_url?: string;
  };

  try {
    const adminOnlyStatuses = new Set<TaskStatus>(["accepted", "cancelled", "merged", "done"]);
    if (status && adminOnlyStatuses.has(status)) {
      if (!(await requireAdmin(req, res, project))) return;
    }

    const updated = await updateTask(project.id, taskId, { status, assignee, pr_url });
    if (updated && status && status !== task.status) {
      await emitProjectMessage(project.id, "letagents", formatTaskLifecycleStatus(updated));
    }
    res.json({ ...updated, room_id: project.id });
  } catch (error) {
    respondWithBadRequest(
      res,
      "PATCH /rooms/:room_id/tasks/:task_id",
      error,
      "Task update could not be completed."
    );
  }
});

app.patch(/^\/rooms\/(.+)$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = await resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

  const project = await resolveRoomOrReply(roomId, res);
  if (!project) return;

  if (!(await requireAdmin(req, res, project))) return;

  const { display_name } = req.body as { display_name?: string };
  if (!display_name?.trim()) {
    res.status(400).json({ error: "display_name is required" });
    return;
  }

  try {
    const updated = await updateProjectDisplayName(project.id, display_name);
    if (!updated) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    const role = await resolveProjectRole(updated, req.sessionAccount);
    res.json({
      room_id: updated.id,
      name: updated.name ?? null,
      display_name: updated.display_name,
      code: updated.code,
      created_at: updated.created_at,
      role,
      authenticated: Boolean(req.sessionAccount),
    });
  } catch (error) {
    respondWithBadRequest(
      res,
      "PATCH /rooms/:room_id",
      error,
      "Room update could not be completed."
    );
  }
});

const PORT = parseInt(process.env.PORT || "3001", 10);

app.listen(PORT, () => {
  console.log(`🚀 Let Agents Chat API running on http://localhost:${PORT}`);
});
