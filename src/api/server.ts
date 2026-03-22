import { EventEmitter } from "events";
import crypto from "crypto";
import express from "express";
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
  getAllProjects,
  getAgentIdentitiesForOwner,
  getOwnerTokenAccountByToken,
  getMessages,
  getMessagesAfter,
  getOpenTasks,
  getOrCreateCanonicalRoom,
  getOrCreateProjectByName,
  getProjectByCode,
  getProjectById,
  getProjectByName,
  getSessionAccountByToken,
  getTaskById,
  getTasks,
  hasMessagesFromSender,
  isProjectAdmin,
  registerAgentIdentity,
  rotateProjectCode,
  createOwnerToken,
  upsertAccount,
  updateProjectDisplayName,
  updateTask,
  type Message,
  type OwnerTokenAccount,
  type Project,
  type SessionAccount,
  type TaskStatus,
} from "./db.js";
import {
  buildGitHubAuthorizeUrl,
  exchangeGitHubDeviceCodeForAccessToken,
  exchangeGitHubCodeForAccessToken,
  fetchGitHubUser,
  getGitHubRepoVisibility,
  isGitHubRepoAdmin,
  isGitHubRepoCollaborator,
  parseGitHubRepoName,
  requestGitHubDeviceCode,
} from "./github-auth.js";
import {
  isInviteCode,
  isKnownProvider,
  normalizeRoomId,
  normalizeRoomName,
  resolveRoomIdentifier,
} from "./room-routing.js";
import { getAgentPrimaryLabel } from "../shared/agent-identity.js";

interface MessageCreatedEvent {
  projectId: string;
  message: Message;
}

interface AuthenticatedRequest extends express.Request {
  sessionAccount?: SessionAccount | OwnerTokenAccount | null;
  authKind?: "session" | "owner_token" | null;
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

function cleanupExpiredDeviceAuths(): void {
  const now = Date.now();
  for (const [requestId, auth] of pendingDeviceAuths.entries()) {
    if (auth.expiresAt <= now) {
      pendingDeviceAuths.delete(requestId);
    }
  }
}

async function emitProjectMessage(projectId: string, sender: string, text: string, source?: string): Promise<Message> {
  const message = await addMessage(projectId, sender, text, source);
  messageEvents.emit("message:created", { projectId, message } satisfies MessageCreatedEvent);
  return message;
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

  if (!input.sessionAccount) {
    return { kind: "auth_required" };
  }

  const githubRepo = parseGitHubRepoName(input.roomName);
  if (!githubRepo) {
    return { kind: "allow" };
  }

  const accessToken = input.sessionAccount.provider_access_token ?? undefined;
  const visibility = await getGitHubRepoVisibility(input.roomName, accessToken);

  if (visibility === "public") {
    return { kind: "allow" };
  }

  if (
    input.sessionAccount.provider !== "github" ||
    !input.sessionAccount.provider_access_token
  ) {
    return { kind: "private_repo_no_access" };
  }

  const allowed = await isGitHubRepoCollaborator({
    roomName: input.roomName,
    login: input.sessionAccount.login,
    accessToken: input.sessionAccount.provider_access_token,
  });

  return allowed ? { kind: "allow" } : { kind: "private_repo_no_access" };
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

const WEB_DIR = path.resolve(process.cwd(), "src", "web");

const app = express();
app.use(express.json());

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

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

app.options("{*path}", (_req, res) => {
  res.sendStatus(204);
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(WEB_DIR, "landing.html"));
});

app.get("/app", (_req, res) => {
  res.redirect(301, "/");
});

app.use(express.static(WEB_DIR, { index: false }));

app.get(/^\/api\/rooms\/resolve\/(.+)$/, (req, res) => {
  const identifier = decodeURIComponent(req.params[0] || "");
  const resolved = resolveRoomIdentifier(identifier);
  res.json(resolved);
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

  if (resolved.type === "room" && resolved.name !== roomIdentifier) {
    res.redirect(301, `/in/${resolved.name}`);
    return;
  }

  if (resolved.type === "room" && isRepoBackedRoomId(resolved.name)) {
    const decision = await resolveGitHubRoomEntryDecision({
      roomName: resolved.name,
      sessionAccount: req.sessionAccount,
      redirectTo: `/in/${resolved.name}`,
    });

    if (decision.kind === "redirect") {
      res.redirect(302, decision.location);
      return;
    }
  }

  res.sendFile(path.join(WEB_DIR, "index.html"));
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "letagents-api" });
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
    res.status(500).json({ error: (error as Error).message });
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
    res.status(500).json({ error: (error as Error).message });
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
    res.status(500).json({ error: (error as Error).message });
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
    res.status(500).json({ error: (error as Error).message });
  }
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

app.get("/projects", async (_req, res) => {
  res.json({ projects: await getAllProjects() });
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
  const roomId = normalizeRoomId(name);

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

  const { project, created } = await getOrCreateProjectByName(name);

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
  const projectId = String(req.params.id);
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
  const projectId = String(req.params.id);
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
  const projectId = String(req.params.id);
  const project = await getProjectById(projectId);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!(await requireParticipant(req, res, project))) {
    return;
  }

  const { sender, text } = req.body as { sender?: string; text?: string };

  if (!sender || !text) {
    res.status(400).json({ error: "sender and text are required" });
    return;
  }

  const source = req.authKind === "session" ? "browser" : req.authKind === "owner_token" ? "agent" : undefined;
  const message = await emitProjectMessage(projectId, sender, text, source);
  res.status(201).json(message);
});

app.get("/projects/:id/messages", async (req: AuthenticatedRequest, res) => {
  const projectId = String(req.params.id);
  const project = await getProjectById(projectId);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!(await requireParticipant(req, res, project))) {
    return;
  }

  res.json({
    project_id: projectId,
    messages: await getMessages(projectId),
  });
});

app.get("/projects/:id/messages/stream", async (req: AuthenticatedRequest, res) => {
  const projectId = String(req.params.id);
  const project = await getProjectById(projectId);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!(await requireParticipant(req, res, project))) {
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(": connected\n\n");

  const onMessageCreated = ({ projectId: eventProjectId, message }: MessageCreatedEvent) => {
    if (eventProjectId !== projectId) {
      return;
    }

    res.write(`data: ${JSON.stringify(message)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);

  messageEvents.on("message:created", onMessageCreated);

  req.on("close", () => {
    clearInterval(heartbeat);
    messageEvents.off("message:created", onMessageCreated);
    res.end();
  });
});

app.get("/projects/:id/messages/poll", async (req: AuthenticatedRequest, res) => {
  const projectId = String(req.params.id);
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
  const existingMessages = await getMessagesAfter(projectId, after);

  if (existingMessages.length > 0) {
    res.json({ project_id: projectId, messages: existingMessages });
    return;
  }

  let settled = false;

  const cleanup = () => {
    clearTimeout(timeout);
    messageEvents.off("message:created", onMessageCreated);
    req.off("close", onClientClose);
  };

  const resolveRequest = (nextMessages: Message[]) => {
    if (settled) {
      return;
    }

    settled = true;
    cleanup();
    res.json({ project_id: projectId, messages: nextMessages });
  };

  const onMessageCreated = async ({ projectId: eventProjectId }: MessageCreatedEvent) => {
    if (eventProjectId !== projectId) {
      return;
    }

    const nextMessages = await getMessagesAfter(projectId, after);
    if (nextMessages.length > 0) {
      resolveRequest(nextMessages);
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
  const projectId = String(req.params.id);
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
  const projectId = String(req.params.id);
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

  const taskList = open ? await getOpenTasks(projectId) : await getTasks(projectId, status);
  res.json({ project_id: projectId, tasks: taskList });
});

app.get("/projects/:id/tasks/:taskId", async (req: AuthenticatedRequest, res) => {
  const projectId = String(req.params.id);
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
  const projectId = String(req.params.id);
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
    res.status(400).json({ error: (error as Error).message });
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



app.get("/rooms/resolve/:identifier", (req, res) => {
  const identifier = decodeURIComponent(req.params.identifier);
  const normalized = normalizeRoomId(identifier);
  const resolved = resolveRoomIdentifier(normalized);
  res.json({ input: identifier, normalized, resolved });
});

app.post(/^\/rooms\/(.+)\/join$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = normalizeRoomId(rawId);

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
    room_id: roomId,
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
  const roomId = normalizeRoomId(rawId);

  const project = await resolveRoomOrReply(roomId, res);
  if (!project) return;

  if (!(await requireParticipant(req, res, project))) return;

  const { sender, text } = req.body as { sender?: string; text?: string };
  if (!sender || !text) {
    res.status(400).json({ error: "sender and text are required" });
    return;
  }

  const source = req.authKind === "session" ? "browser" : req.authKind === "owner_token" ? "agent" : undefined;
  const message = await emitProjectMessage(project.id, sender, text, source);
  res.status(201).json({
    ...message,
    room_id: roomId,
  });
});

app.get(/^\/rooms\/(.+)\/messages$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = normalizeRoomId(rawId);

  const project = await resolveRoomOrReply(roomId, res);
  if (!project) return;

  if (!(await requireParticipant(req, res, project))) return;

  res.json({
    room_id: roomId,
    messages: await getMessages(project.id),
  });
});

app.get(/^\/rooms\/(.+)\/messages\/poll$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = normalizeRoomId(rawId);

  const project = await resolveRoomOrReply(roomId, res);
  if (!project) return;

  if (!(await requireParticipant(req, res, project))) return;

  const projectId = project.id;
  const after = typeof req.query.after === "string" ? req.query.after : undefined;
  const timeoutMs = parsePollTimeout(typeof req.query.timeout === "string" ? req.query.timeout : undefined);
  const existingMessages = await getMessagesAfter(projectId, after);

  if (existingMessages.length > 0) {
    res.json({ room_id: roomId, messages: existingMessages });
    return;
  }

  let settled = false;

  const cleanup = () => {
    clearTimeout(timeout);
    messageEvents.off("message:created", onMessageCreated);
    req.off("close", onClientClose);
  };

  const resolveRequest = (nextMessages: Message[]) => {
    if (settled) return;
    settled = true;
    cleanup();
    res.json({ room_id: roomId, messages: nextMessages });
  };

  const onMessageCreated = async ({ projectId: eventProjectId }: MessageCreatedEvent) => {
    if (eventProjectId !== projectId) return;
    const nextMessages = await getMessagesAfter(projectId, after);
    if (nextMessages.length > 0) resolveRequest(nextMessages);
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
  const roomId = normalizeRoomId(rawId);

  const project = await resolveRoomOrReply(roomId, res);
  if (!project) return;

  if (!(await requireParticipant(req, res, project))) return;

  const projectId = project.id;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(": connected\n\n");

  const onMessageCreated = ({ projectId: eventProjectId, message }: MessageCreatedEvent) => {
    if (eventProjectId !== projectId) return;
    res.write(`data: ${JSON.stringify({ ...message, room_id: roomId })}\n\n`);
  };

  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
  messageEvents.on("message:created", onMessageCreated);

  req.on("close", () => {
    clearInterval(heartbeat);
    messageEvents.off("message:created", onMessageCreated);
    res.end();
  });
});

app.get(/^\/rooms\/(.+)\/tasks$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = normalizeRoomId(rawId);

  const project = await resolveRoomOrReply(roomId, res);
  if (!project) return;

  if (!(await requireParticipant(req, res, project))) return;

  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const open = req.query.open === "true";
  const taskList = open ? await getOpenTasks(project.id) : await getTasks(project.id, status);

  res.json({ room_id: roomId, tasks: taskList });
});

app.post(/^\/rooms\/(.+)\/tasks$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = normalizeRoomId(rawId);

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
    res.status(201).json({ ...task, room_id: roomId });
    return;
  }

  const acceptedTask = await updateTask(project.id, task.id, { status: "accepted" });
  if (!acceptedTask) {
    res.status(500).json({ error: "Task created but could not be auto-accepted" });
    return;
  }

  await emitProjectMessage(project.id, "letagents", formatTaskLifecycleStatus(acceptedTask));
  res.status(201).json({ ...acceptedTask, room_id: roomId });
});

app.get(/^\/rooms\/(.+)\/tasks\/([^/]+)$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = normalizeRoomId(rawId);
  const taskId = (req.params as Record<string, string>)[1] ?? "";

  const project = await resolveRoomOrReply(roomId, res);
  if (!project) return;

  if (!(await requireParticipant(req, res, project))) return;

  const task = await getTaskById(project.id, taskId);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  res.json({ ...task, room_id: roomId });
});

app.patch(/^\/rooms\/(.+)\/tasks\/([^/]+)$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = normalizeRoomId(rawId);
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
    res.json({ ...updated, room_id: roomId });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.patch(/^\/rooms\/(.+)$/, async (req: AuthenticatedRequest, res) => {
  const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
  const roomId = normalizeRoomId(rawId);

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
    res.status(400).json({ error: (error as Error).message });
  }
});

const PORT = parseInt(process.env.PORT || "3001", 10);

app.listen(PORT, () => {
  console.log(`🚀 Let Agents Chat API running on http://localhost:${PORT}`);
});
