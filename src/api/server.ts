import { EventEmitter } from "events";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  addMessage,
  createProject,
  createProjectWithName,
  createTask,
  getAllProjects,
  getMessages,
  getMessagesAfter,
  getOpenTasks,
  getOrCreateProjectByName,
  getProjectByCode,
  getProjectById,
  getProjectByName,
  getTasks,
  getTaskById,
  updateTask,
  type Message,
  type Project,
  type TaskStatus,
} from "./db.js";

interface MessageCreatedEvent {
  projectId: string;
  message: Message;
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

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

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

// Serve static web UI
app.use(express.static(path.join(__dirname, "..", "web")));

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "letagents-api" });
});

// GET /projects — list all projects
app.get("/projects", (_req, res) => {
  res.json({ projects: getAllProjects() });
});

// POST /projects — create a new project
app.post("/projects", (_req, res) => {
  const project = createProject();
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
app.post("/projects/room/:name", (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { project, created } = getOrCreateProjectByName(name);
  res.status(created ? 201 : 200).json({ id: project.id, code: project.code, name: project.name });
});

// POST /projects/:id/messages — send a message
app.post("/projects/:id/messages", (req, res) => {
  const projectId = req.params.id;

  if (!getProjectById(projectId)) {
    res.status(404).json({ error: "Project not found" });
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
app.post("/projects/:id/tasks", (req, res) => {
  const projectId = req.params.id;

  if (!getProjectById(projectId)) {
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

  const task = createTask(projectId, title, created_by, description, source_message_id);
  res.status(201).json(task);
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
app.patch("/projects/:id/tasks/:taskId", (req, res) => {
  const task = getTaskById(req.params.taskId);

  if (!task || task.project_id !== req.params.id) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const { status, assignee, pr_url } = req.body as {
    status?: TaskStatus;
    assignee?: string;
    pr_url?: string;
  };

  try {
    const updated = updateTask(req.params.taskId, { status, assignee, pr_url });
    if (updated && status && status !== task.status) {
      emitProjectMessage(req.params.id, "letagents", formatTaskLifecycleStatus(updated));
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
