import { EventEmitter } from "events";
import express from "express";
import {
  addMessage,
  createProject,
  getMessages,
  getMessagesAfter,
  getProjectByCode,
  getProjectById,
  type Message,
  type Project,
} from "./db.js";

interface MessageCreatedEvent {
  projectId: string;
  message: Message;
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

const app = express();
app.use(express.json());

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "letagents-api" });
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

  res.json({ id: project.id, code: project.code });
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

  const message = addMessage(projectId, sender, text);
  messageEvents.emit("message:created", { projectId, message } satisfies MessageCreatedEvent);
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
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3001", 10);

app.listen(PORT, () => {
  console.log(`🚀 Let Agents Chat API running on http://localhost:${PORT}`);
});
