import { EventEmitter } from "events";
import express from "express";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Project {
  id: string;
  code: string;
  created_at: string;
}

interface Message {
  id: string;
  sender: string;
  text: string;
  timestamp: string;
}

interface MessageCreatedEvent {
  projectId: string;
  message: Message;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const projects = new Map<string, Project>();
const projectsByCode = new Map<string, string>(); // code → project id
const messages = new Map<string, Message[]>(); // project id → messages
const messageEvents = new EventEmitter();

let projectCounter = 0;
let messageCounter = 0;

function parseMessageId(messageId: string | undefined): number | null {
  if (!messageId) {
    return null;
  }

  const match = /^msg_(\d+)$/.exec(messageId);
  return match ? Number(match[1]) : null;
}

function getMessagesAfter(projectId: string, afterMessageId: string | undefined): Message[] {
  const projectMessages = messages.get(projectId) || [];
  const afterNumericId = parseMessageId(afterMessageId);

  if (afterNumericId === null) {
    return projectMessages;
  }

  return projectMessages.filter((message) => {
    const messageNumericId = parseMessageId(message.id);
    return messageNumericId !== null && messageNumericId > afterNumericId;
  });
}

function generateCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const seg1 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const seg2 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${seg1}-${seg2}`;
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
  projectCounter++;
  const id = `proj_${projectCounter}`;
  let code = generateCode();

  // Ensure code uniqueness (very unlikely collision but just in case)
  while (projectsByCode.has(code)) {
    code = generateCode();
  }

  const project: Project = {
    id,
    code,
    created_at: new Date().toISOString(),
  };

  projects.set(id, project);
  projectsByCode.set(code, id);
  messages.set(id, []);

  res.status(201).json(project);
});

// GET /projects/join/:code — look up project by join code
app.get("/projects/join/:code", (req, res) => {
  const code = req.params.code.toUpperCase();
  const projectId = projectsByCode.get(code);

  if (!projectId) {
    res.status(404).json({ error: "Project not found for the given code" });
    return;
  }

  const project = projects.get(projectId)!;
  res.json({ id: project.id, code: project.code });
});

// POST /projects/:id/messages — send a message
app.post("/projects/:id/messages", (req, res) => {
  const projectId = req.params.id;

  if (!projects.has(projectId)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { sender, text } = req.body as { sender?: string; text?: string };

  if (!sender || !text) {
    res.status(400).json({ error: "sender and text are required" });
    return;
  }

  messageCounter++;
  const message: Message = {
    id: `msg_${messageCounter}`,
    sender,
    text,
    timestamp: new Date().toISOString(),
  };

  messages.get(projectId)!.push(message);
  messageEvents.emit("message:created", { projectId, message } satisfies MessageCreatedEvent);
  res.status(201).json(message);
});

// GET /projects/:id/messages — read all messages
app.get("/projects/:id/messages", (req, res) => {
  const projectId = req.params.id;

  if (!projects.has(projectId)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({
    project_id: projectId,
    messages: messages.get(projectId) || [],
  });
});

// GET /projects/:id/messages/stream — stream new messages over SSE
app.get("/projects/:id/messages/stream", (req, res) => {
  const projectId = req.params.id;

  if (!projects.has(projectId)) {
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

  if (!projects.has(projectId)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const after = typeof req.query.after === "string" ? req.query.after : undefined;
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
  }, 30000);

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
