import { EventEmitter } from "events";
import crypto from "crypto";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  addMessage,
  assignProjectAdmin,
  consumeAuthState,
  createProject,
  createProjectWithName,
  createAuthState,
  createSession,
  createTask,
  deleteSessionByToken,
  getAllProjects,
  getAgentIdentitiesForOwner,
  getMessages,
  getMessagesAfter,
  getOpenTasks,
  getOrCreateProjectByName,
  getProjectByCode,
  getProjectById,
  getProjectByName,
  getSessionAccountByToken,
  getTasks,
  getTaskById,
  hasMessagesFromSender,
  isProjectAdmin,
  registerAgentIdentity,
  rotateProjectCode,
  upsertAccount,
  updateTask,
  type Message,
  type Project,
  type SessionAccount,
  type TaskStatus,
} from "./db.js";
import {
  buildGitHubAuthorizeUrl,
  exchangeGitHubCodeForAccessToken,
  fetchGitHubUser,
  isGitHubRepoAdmin,
  parseGitHubRepoName,
} from "./github-auth.js";

interface MessageCreatedEvent {
  projectId: string;
  message: Message;
}

interface AuthenticatedRequest extends express.Request {
  sessionAccount?: SessionAccount | null;
}

function emitProjectMessage(projectId: string, sender: string, text: string): Message {
  const message = addMessage(projectId, sender, text);
  messageEvents.emit("message:created", { projectId, message } satisfies MessageCreatedEvent);
  return message;
}

function formatTaskLifecycleStatus(task: {
  id: string;
  title: string;
  status: TaskStatus;
  assignee: string | null;
}): string {
  switch (task.status) {
    case "assigned":
      return task.assignee
        ? `[status] ${task.assignee} claimed ${task.id}: ${task.title}`
        : `[status] ${task.id} moved to assigned: ${task.title}`;
    case "in_progress":
      return task.assignee
        ? `[status] ${task.assignee} is working on ${task.id}: ${task.title}`
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

function isTrustedAgentCreator(projectId: string, createdBy: string): boolean {
  const normalizedSender = createdBy.trim().toLowerCase();
  if (!normalizedSender || normalizedSender === "human" || normalizedSender === "letagents") {
    return false;
  }

  return hasMessagesFromSender(projectId, createdBy);
}

// ---------------------------------------------------------------------------
// Realtime notifications
// ---------------------------------------------------------------------------

const messageEvents = new EventEmitter();

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

function isRepoBackedProject(project: Project): boolean {
  return Boolean(project.name && /^[A-Za-z0-9.-]+\/[^/]+\/[^/]+$/.test(project.name));
}

async function resolveProjectRole(
  project: Project,
  sessionAccount: SessionAccount | null | undefined
): Promise<"admin" | "participant" | "anonymous"> {
  if (!sessionAccount) {
    return isRepoBackedProject(project) ? "anonymous" : "participant";
  }

  if (isProjectAdmin(project.id, sessionAccount.account_id)) {
    return "admin";
  }

  if (project.name && parseGitHubRepoName(project.name) && sessionAccount.provider === "github") {
    const eligible = await isGitHubRepoAdmin({
      roomName: project.name,
      login: sessionAccount.login,
      accessToken: sessionAccount.provider_access_token ?? "",
    });

    if (eligible) {
      assignProjectAdmin(project.id, sessionAccount.account_id);
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
  if (isRepoBackedProject(project) && !req.sessionAccount) {
    res.status(401).json({ error: "Authentication required for repo-backed room actions" });
    return false;
  }

  return true;
}

async function resolveRequestAccount(req: express.Request): Promise<SessionAccount | null> {
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.letagents_session;
  if (sessionToken) {
    const sessionAccount = getSessionAccountByToken(sessionToken);
    if (sessionAccount) {
      return sessionAccount;
    }
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const providerToken = authHeader.slice("Bearer ".length).trim();
  if (!providerToken) {
    return null;
  }

  try {
    const githubUser = await fetchGitHubUser(providerToken);
    const account = upsertAccount({
      provider: "github",
      provider_user_id: String(githubUser.id),
      login: githubUser.login,
      display_name: githubUser.name,
      avatar_url: githubUser.avatar_url,
    });

    return {
      id: "token_session",
      account_id: account.id,
      token: providerToken,
      provider_access_token: providerToken,
      expires_at: new Date(Date.now() + 1000 * 60 * 15).toISOString(),
      created_at: new Date().toISOString(),
      provider: "github",
      provider_user_id: String(githubUser.id),
      login: githubUser.login,
      display_name: githubUser.name,
      avatar_url: githubUser.avatar_url,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

app.use(async (req: AuthenticatedRequest, _res, next) => {
  req.sessionAccount = await resolveRequestAccount(req);
  next();
});

// CORS headers
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.options("{*path}", (_req, res) => {
  res.sendStatus(204);
});

// Serve static web UI assets (CSS, JS, images)
app.use(express.static(path.join(__dirname, "..", "web")));

// ---------------------------------------------------------------------------
// Room URL routing (architecture spec §5)
// ---------------------------------------------------------------------------
import {
  isInviteCode,
  isKnownProvider,
  normalizeRoomName,
  resolveRoomIdentifier,
} from "./room-routing.js";

// API endpoint to resolve room identifiers (used by the web client)
app.get("/api/rooms/resolve/:identifier(*)", (req, res) => {
  const identifier = decodeURIComponent(req.params["identifier(*)"] || "");
  const resolved = resolveRoomIdentifier(identifier);
  res.json(resolved);
});

// Convenience alias: /:provider/:owner/:repo → redirect to /in/:provider/:owner/:repo
// This makes "letagents.chat/github.com/EmmyMay/letagents" work
app.get("/:provider/:owner/:repo", (req, res, next) => {
  const provider = req.params.provider.toLowerCase();

  if (!isKnownProvider(provider)) {
    return next(); // Not a known git provider, pass to next route
  }

  const roomKey = `${provider}/${req.params.owner}/${req.params.repo}`;
  const normalized = normalizeRoomName(roomKey);
  res.redirect(301, `/in/${normalized}`);
});

// Canonical room entry: /in/* — serves the web UI with room context
// The web client reads the room identifier from the URL and connects to the room
app.get("/in/:room(*)", (req, res) => {
  const roomIdentifier = decodeURIComponent(req.params["room(*)"] || "");
  const resolved = resolveRoomIdentifier(roomIdentifier);

  // Normalize the URL if the room name wasn't canonical
  if (resolved.type === "room" && resolved.name !== roomIdentifier) {
    res.redirect(301, `/in/${resolved.name}`);
    return;
  }

  // Serve the web UI — the client-side JS will extract the room from the URL
  res.sendFile(path.join(__dirname, "..", "web", "index.html"));
});

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "letagents-api" });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.post("/auth/github/login", (req, res) => {
  const redirectTo =
    typeof req.body?.redirect_to === "string" && req.body.redirect_to.trim()
      ? req.body.redirect_to.trim()
      : "/";
  const state = crypto.randomBytes(24).toString("hex");

  createAuthState(state, redirectTo);

  try {
    const authUrl = buildGitHubAuthorizeUrl(state);
    res.json({ auth_url: authUrl, state, redirect_to: redirectTo });
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

  const authState = consumeAuthState(state);
  if (!authState) {
    res.status(400).json({ error: "Invalid or expired auth state" });
    return;
  }

  try {
    const accessToken = await exchangeGitHubCodeForAccessToken(code);
    const githubUser = await fetchGitHubUser(accessToken);
    const account = upsertAccount({
      provider: "github",
      provider_user_id: String(githubUser.id),
      login: githubUser.login,
      display_name: githubUser.name,
      avatar_url: githubUser.avatar_url,
    });

    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    const sessionToken = crypto.randomBytes(32).toString("hex");
    createSession(account.id, sessionToken, expiresAt, accessToken);
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

app.post("/auth/logout", (req: AuthenticatedRequest, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.letagents_session) {
    deleteSessionByToken(cookies.letagents_session);
  }
  clearSessionCookie(res);
  res.json({ success: true });
});

// GET /projects — list all projects
app.get("/projects", (_req, res) => {
  res.json({ projects: getAllProjects() });
});

// POST /projects — create a new project
app.post("/projects", (_req, res) => {
  const req = _req as AuthenticatedRequest;
  const project = createProject();
  if (req.sessionAccount) {
    assignProjectAdmin(project.id, req.sessionAccount.account_id);
  }
  res.status(201).json(project);
});

// GET /projects/join/:code — look up project by join code
app.get("/projects/join/:code", (req, res) => {
  const code = req.params.code.toUpperCase();
  const project = getProjectByCode(code);

  if (!project) {
    res.status(404).json({ error: "Project not found for the given code" });
    return;
  }

  res.json({ id: project.id, code: project.code, name: project.name });
});

// POST /projects/room/:name — create or join a named room
app.post("/projects/room/:name", async (req: AuthenticatedRequest, res) => {
  const name = decodeURIComponent(String(req.params.name));
  const { project, created } = getOrCreateProjectByName(name);

  if (req.sessionAccount && created) {
    const role = await resolveProjectRole(project, req.sessionAccount);
    if (role === "admin") {
      assignProjectAdmin(project.id, req.sessionAccount.account_id);
    }
  }

  res.status(created ? 201 : 200).json({ id: project.id, code: project.code, name: project.name });
});

app.get("/projects/:id/access", async (req: AuthenticatedRequest, res) => {
  const projectId = String(req.params.id);
  const project = getProjectById(projectId);
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
  const project = getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!(await requireAdmin(req, res, project))) {
    return;
  }

  const rotated = rotateProjectCode(project.id);
  if (!rotated) {
    res.status(500).json({ error: "Failed to rotate invite code" });
    return;
  }

  res.json({
    id: rotated.id,
    code: rotated.code,
    name: rotated.name,
  });
});

app.get("/agents/me", (req: AuthenticatedRequest, res) => {
  if (!req.sessionAccount) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  res.json({
    account: {
      id: req.sessionAccount.account_id,
      login: req.sessionAccount.login,
    },
    agents: getAgentIdentitiesForOwner(req.sessionAccount.account_id),
  });
});

app.post("/agents", (req: AuthenticatedRequest, res) => {
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

  const identity = registerAgentIdentity({
    owner_account_id: req.sessionAccount.account_id,
    owner_login: req.sessionAccount.login,
    owner_label: owner_label?.trim() || req.sessionAccount.display_name || req.sessionAccount.login,
    name: name.trim(),
    display_name: display_name?.trim(),
  });

  res.status(201).json(identity);
});

// POST /projects/:id/messages — send a message
app.post("/projects/:id/messages", async (req: AuthenticatedRequest, res) => {
  const projectId = String(req.params.id);

  const project = getProjectById(projectId);
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

  const message = emitProjectMessage(projectId, sender, text);
  res.status(201).json(message);
});

// GET /projects/:id/messages — read all messages
app.get("/projects/:id/messages", (req, res) => {
  const projectId = req.params.id;

  if (!getProjectById(projectId)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({
    project_id: projectId,
    messages: getMessages(projectId),
  });
});

// GET /projects/:id/messages/stream — stream new messages over SSE
app.get("/projects/:id/messages/stream", (req, res) => {
  const projectId = req.params.id;

  if (!getProjectById(projectId)) {
    res.status(404).json({ error: "Project not found" });
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

// GET /projects/:id/messages/poll?after=<msg_id> — wait for new messages
app.get("/projects/:id/messages/poll", (req, res) => {
  const projectId = req.params.id;

  if (!getProjectById(projectId)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const after = typeof req.query.after === "string" ? req.query.after : undefined;
  const timeoutMs = parsePollTimeout(typeof req.query.timeout === "string" ? req.query.timeout : undefined);
  const existingMessages = getMessagesAfter(projectId, after);

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

  const onMessageCreated = ({ projectId: eventProjectId }: MessageCreatedEvent) => {
    if (eventProjectId !== projectId) {
      return;
    }

    const nextMessages = getMessagesAfter(projectId, after);
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

// ---------------------------------------------------------------------------
// Task Board Endpoints
// ---------------------------------------------------------------------------

// POST /projects/:id/tasks — create a task
app.post("/projects/:id/tasks", async (req: AuthenticatedRequest, res) => {
  const projectId = String(req.params.id);

  const project = getProjectById(projectId);
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

  const task = createTask(projectId, title, created_by, description, source_message_id);

  if (!isTrustedAgentCreator(projectId, created_by)) {
    res.status(201).json(task);
    return;
  }

  const acceptedTask = updateTask(task.id, { status: "accepted" });
  if (!acceptedTask) {
    res.status(500).json({ error: "Task created but could not be auto-accepted" });
    return;
  }

  emitProjectMessage(projectId, "letagents", formatTaskLifecycleStatus(acceptedTask));
  res.status(201).json(acceptedTask);
});

// GET /projects/:id/tasks — list tasks (optional ?status= filter)
app.get("/projects/:id/tasks", (req, res) => {
  const projectId = req.params.id;

  if (!getProjectById(projectId)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const open = req.query.open === "true";

  const tasks = open ? getOpenTasks(projectId) : getTasks(projectId, status);
  res.json({ project_id: projectId, tasks });
});

// GET /projects/:id/tasks/:taskId — get single task
app.get("/projects/:id/tasks/:taskId", (req, res) => {
  const task = getTaskById(req.params.taskId);

  if (!task || task.project_id !== req.params.id) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  res.json(task);
});

// PATCH /projects/:id/tasks/:taskId — update status/assignee
app.patch("/projects/:id/tasks/:taskId", async (req: AuthenticatedRequest, res) => {
  const projectId = String(req.params.id);
  const taskId = String(req.params.taskId);
  const task = getTaskById(taskId);

  if (!task || task.project_id !== projectId) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const project = getProjectById(projectId);
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

    const updated = updateTask(taskId, { status, assignee, pr_url });
    if (updated && status && status !== task.status) {
      emitProjectMessage(projectId, "letagents", formatTaskLifecycleStatus(updated));
    }
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3001", 10);

app.listen(PORT, () => {
  console.log(`🚀 Let Agents Chat API running on http://localhost:${PORT}`);
});
