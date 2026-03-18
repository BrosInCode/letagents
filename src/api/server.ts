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

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const projects = new Map<string, Project>();
const projectsByCode = new Map<string, string>(); // code → project id
const messages = new Map<string, Message[]>(); // project id → messages

let projectCounter = 0;
let messageCounter = 0;

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

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3001", 10);

app.listen(PORT, () => {
  console.log(`🚀 Let Agents Chat API running on http://localhost:${PORT}`);
});
