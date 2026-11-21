import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const argv = process.argv.slice(2);

// Subcommand 1: `codex mcp list --json ...`
if (argv[0] === "mcp" && argv[1] === "list") {
  process.stdout.write("[]\n");
  process.exit(0);
}

// Subcommand 2: `codex app-server ... --listen ws://127.0.0.1:<port>`
function parseListenUrl(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--listen" && args[i + 1]) {
      return args[i + 1];
    }
  }
  return null;
}

const listenArg = parseListenUrl(argv);
if (argv[0] !== "app-server" || !listenArg || !listenArg.startsWith("ws://")) {
  process.stderr.write(`Unsupported codex-edge-server invocation: ${argv.join(" ")}\n`);
  process.exit(2);
}

function loadTranscript(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const parsed = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${filePath}:${index + 1}: invalid JSON (${error.message})`);
    }
  });
  const start = parsed[0];
  if (!start || start.type !== "transcript_start" || start.provider !== "codex") {
    throw new Error(`${filePath}: expected codex transcript_start header`);
  }
  const entries = parsed.slice(1);
  const runtimeExit = entries.find((entry) => entry.type === "runtime_exit") ?? {
    type: "runtime_exit",
    requested: true,
    transportClosedBeforeExit: false,
    code: 0,
    signal: null,
  };
  const turns = [];
  let currentTurn = null;
  for (const entry of entries) {
    if (entry.type === "runtime_exit") break;
    if (entry.type === "expect_outbound" && entry.frame?.method === "turn/start") {
      currentTurn = { steps: [] };
      turns.push(currentTurn);
      continue;
    }
    if (currentTurn) {
      currentTurn.steps.push(entry);
    }
  }
  return { start, turns, runtimeExit };
}

function substitute(value, vars) {
  if (value === "<now>") return Date.now();
  if (value === "<nowSec>") return Math.floor(Date.now() / 1000);
  if (typeof value === "string") {
    let out = value;
    for (const [key, replacement] of Object.entries(vars)) {
      if (out.includes(key)) out = out.split(key).join(String(replacement));
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = substitute(v, vars);
    }
    return out;
  }
  return value;
}

function writeMarker(controlDir, filename, payload) {
  if (!controlDir) return;
  try {
    mkdirSync(controlDir, { recursive: true });
    writeFileSync(join(controlDir, filename), `${JSON.stringify(payload)}\n`, "utf8");
  } catch {
    // Best-effort sync marker.
  }
}

async function waitForGateFile(controlDir, gateName) {
  const target = join(controlDir, gateName);
  while (!existsSync(target)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const transcriptPath = process.env.LETAGENTS_CODEX_REPLAY_TRANSCRIPT;
if (!transcriptPath) {
  process.stderr.write("LETAGENTS_CODEX_REPLAY_TRANSCRIPT is required.\n");
  process.exit(2);
}
const controlDir = process.env.LETAGENTS_CODEX_REPLAY_CONTROL_DIR || "";
const transcript = loadTranscript(transcriptPath);
const workspaceCwd = process.cwd();
const codexHome = process.env.CODEX_HOME || join(process.env.HOME || process.env.USERPROFILE || "", ".codex");
const listenUrl = new URL(listenArg);
const hostname = listenUrl.hostname || "127.0.0.1";
const port = Number(listenUrl.port);

const threads = new Map(); // threadId -> ThreadState
const sockets = new Set();
const interruptWaiters = new Map(); // turnId -> Array<() => void>
const pendingServerRequests = new Map(); // numeric id -> (result) => void

let nextServerRequestId = 10_000;
let turnCounter = 0;
let crashScheduled = false;
let resumedOnThisProcess = false;

function scheduleCrashIfConfigured(delayMs) {
  if (crashScheduled) return;
  if (transcript.runtimeExit.requested === false && typeof transcript.runtimeExit.code === "number" && transcript.runtimeExit.code !== 0) {
    crashScheduled = true;
    const exitCode = transcript.runtimeExit.code;
    setTimeout(() => process.exit(exitCode), delayMs);
  }
}

function makeThread(threadId, overrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: threadId,
    sessionId: threadId,
    cwd: workspaceCwd,
    model: overrides.model || "gpt-5.4",
    modelProvider: "openai",
    approvalPolicy: overrides.approvalPolicy || "never",
    approvalsReviewer: overrides.approvalsReviewer || "user",
    sandbox: overrides.sandbox || { type: "dangerFullAccess" },
    reasoningEffort: null,
    status: { type: "idle" },
    createdAt: nowSec,
    updatedAt: nowSec,
    turns: [],
  };
}

function serializeThread(thread, includeTurns) {
  return {
    id: thread.id,
    extra: null,
    sessionId: thread.sessionId,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "legacy",
    modelProvider: thread.modelProvider,
    model: thread.model,
    reasoningEffort: thread.reasoningEffort,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.updatedAt,
    status: thread.status,
    path: join(codexHome, "sessions", `${thread.id}.jsonl`),
    cwd: thread.cwd,
    cliVersion: transcript.start.providerVersion || "0.153.4",
    source: "vscode",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: includeTurns ? thread.turns : [],
  };
}

function sendFrame(ws, frame) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(frame));
  }
}

function broadcast(frame) {
  const text = JSON.stringify(frame);
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(text);
  }
}

function sendServerRequest(method, params) {
  const id = ++nextServerRequestId;
  return new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
    broadcast({ id, method, params });
  });
}

function applyInboundFrame(thread, turn, frame) {
  const method = frame?.method;
  const params = frame?.params ?? {};
  if (method === "thread/status/changed" && params.status) {
    thread.status = params.status;
  } else if (method === "item/started" && params.item) {
    const exists = turn.items.findIndex((i) => i.id === params.item.id);
    if (exists >= 0) turn.items[exists] = params.item;
    else turn.items.push(params.item);
  } else if (method === "item/agentMessage/delta" && params.itemId && typeof params.delta === "string") {
    const item = turn.items.find((i) => i.id === params.itemId);
    if (item && item.type === "agentMessage") {
      item.text = `${typeof item.text === "string" ? item.text : ""}${params.delta}`;
    }
  } else if (method === "item/completed" && params.item) {
    const exists = turn.items.findIndex((i) => i.id === params.item.id);
    if (exists >= 0) turn.items[exists] = params.item;
    else turn.items.push(params.item);
  } else if (method === "turn/completed" && params.turn) {
    turn.status = params.turn.status || "completed";
    turn.completedAt = Math.floor(Date.now() / 1000);
    turn.error = params.turn.error ?? null;
    thread.status = { type: "idle" };
  }
  broadcast(frame);
}

async function runTurnScript(thread, turn, turnIndex) {
  const script = transcript.turns[turnIndex];
  const userContent = turn.items?.[0]?.content;
  const promptText = Array.isArray(userContent) ? String(userContent[0]?.text ?? "") : "";
  writeMarker(controlDir, `turn-${turnIndex + 1}-started.json`, {
    turnIndex: turnIndex + 1,
    threadId: thread.id,
    turnId: turn.id,
    pid: process.pid,
    promptText,
  });

  if (!script) {
    const itemId = `msg_edge_${turnIndex + 1}`;
    applyInboundFrame(thread, turn, {
      method: "turn/started",
      params: { threadId: thread.id, turn: { ...turn, items: [], itemsView: "notLoaded" } },
      emittedAtMs: Date.now(),
    });
    applyInboundFrame(thread, turn, {
      method: "item/started",
      params: { threadId: thread.id, turnId: turn.id, item: { type: "agentMessage", id: itemId, text: "", phase: "final_answer" }, startedAtMs: Date.now() },
      emittedAtMs: Date.now(),
    });
    applyInboundFrame(thread, turn, {
      method: "item/agentMessage/delta",
      params: { threadId: thread.id, turnId: turn.id, itemId, delta: `codex-edge-reply-${turnIndex + 1}` },
      emittedAtMs: Date.now(),
    });
    applyInboundFrame(thread, turn, {
      method: "item/completed",
      params: { threadId: thread.id, turnId: turn.id, item: { type: "agentMessage", id: itemId, text: `codex-edge-reply-${turnIndex + 1}`, phase: "final_answer" }, completedAtMs: Date.now() },
      emittedAtMs: Date.now(),
    });
    applyInboundFrame(thread, turn, {
      method: "thread/status/changed",
      params: { threadId: thread.id, status: { type: "idle" } },
      emittedAtMs: Date.now(),
    });
    applyInboundFrame(thread, turn, {
      method: "turn/completed",
      params: { threadId: thread.id, turn: { ...turn, status: "completed", completedAt: Math.floor(Date.now() / 1000) } },
      emittedAtMs: Date.now(),
    });
    return;
  }

  const vars = {
    "<threadId>": thread.id,
    "<turnId>": turn.id,
    "<itemId>": `msg_edge_${turnIndex + 1}`,
    "<cmdItemId>": `cmd_edge_${turnIndex + 1}`,
    "<cwd>": thread.cwd,
    "<decision>": "accept",
  };

  for (const step of script.steps) {
    if (step.type === "emit_inbound") {
      const frame = substitute(step.frame, vars);
      if (frame.method === "item/commandExecution/requestApproval") {
        const result = await sendServerRequest(frame.method, frame.params);
        vars["<decision>"] = String(result?.decision || "accept");
        broadcast({
          method: "serverRequest/resolved",
          params: { threadId: thread.id, requestId: result?.__requestId },
          emittedAtMs: Date.now(),
        });
      } else {
        applyInboundFrame(thread, turn, frame);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    if (step.type === "expect_outbound") {
      if (step.frame?.method === "turn/interrupt") {
        writeMarker(controlDir, `turn-${turnIndex + 1}-waiting-interrupt.json`, {
          threadId: thread.id,
          turnId: turn.id,
        });
        await new Promise((resolve) => {
          const list = interruptWaiters.get(turn.id) ?? [];
          list.push(resolve);
          interruptWaiters.set(turn.id, list);
        });
        continue;
      }
      if (typeof step.frame?.gate === "string" && controlDir) {
        writeMarker(controlDir, `turn-${turnIndex + 1}-waiting-gate.json`, {
          gate: step.frame.gate,
          threadId: thread.id,
          turnId: turn.id,
          pid: process.pid,
        });
        await waitForGateFile(controlDir, step.frame.gate);
        continue;
      }
    }
  }
}

const httpServer = createServer((req, res) => {
  if (req.url === "/readyz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", (ws) => {
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    // Response from client to a server-initiated JSON-RPC request (approval decision).
    if (msg.method === undefined && msg.id !== undefined && pendingServerRequests.has(msg.id)) {
      const resolve = pendingServerRequests.get(msg.id);
      pendingServerRequests.delete(msg.id);
      resolve({ ...(msg.result || {}), __requestId: msg.id });
      return;
    }

    const { id, method, params = {} } = msg;
    const reply = (result) => {
      if (id !== undefined) sendFrame(ws, { id, result });
    };
    const replyError = (code, message) => {
      if (id !== undefined) sendFrame(ws, { id, error: { code, message } });
    };

    if (method === "initialize") {
      reply({
        userAgent: `letagents-desktop-codex-supervisor/${transcript.start.providerVersion || "0.153.4"}`,
        codexHome,
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform === "win32" ? "windows" : "macos",
      });
      return;
    }

    if (method === "initialized") {
      return;
    }

    if (method === "mcpServerStatus/list") {
      reply({
        data: [
          {
            name: "letagents",
            runtimeStatus: null,
            pluginId: null,
            serverInfo: { name: "letagents-edge-mcp-stub", version: "0.12.56" },
            tools: {
              read_messages: { name: "read_messages" },
              send_message: { name: "send_message" },
              get_board: { name: "get_board" },
              claim_task: { name: "claim_task" },
            },
            resources: [
              { mimeType: "application/json", name: "LetAgents runtime readiness", uri: "letagents://runtime/readiness" },
            ],
            resourceTemplates: [],
            authStatus: "unsupported",
          },
        ],
        nextCursor: null,
      });
      return;
    }

    if (method === "model/list") {
      reply({
        data: [
          {
            id: "gpt-5.4",
            model: "gpt-5.4",
            displayName: "GPT-5.4",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "medium" },
              { reasoningEffort: "high" },
            ],
            inputModalities: ["text", "image"],
          },
        ],
        nextCursor: null,
      });
      return;
    }

    if (method === "mcpServer/resource/read") {
      reply({
        contents: [
          {
            uri: params.uri || "letagents://runtime/readiness",
            mimeType: "application/json",
            text: JSON.stringify({
              format: 1,
              profile: "supervised_room_turn",
              provider: "codex",
              tools: ["claim_task", "get_board", "read_messages", "send_message"],
            }),
          },
        ],
        originCallId: null,
      });
      return;
    }

    if (method === "thread/start") {
      const threadId = randomUUID();
      const thread = makeThread(threadId, {
        model: params.model,
        approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer,
        sandbox: params.sandbox === "danger-full-access" ? { type: "dangerFullAccess" } : params.sandboxPolicy,
      });
      threads.set(threadId, thread);
      reply({
        thread: serializeThread(thread, true),
        model: thread.model,
        modelProvider: thread.modelProvider,
        serviceTier: "default",
        cwd: thread.cwd,
        runtimeWorkspaceRoots: [thread.cwd],
        instructionSources: [],
        approvalPolicy: thread.approvalPolicy,
        approvalsReviewer: thread.approvalsReviewer,
        sandbox: thread.sandbox,
        reasoningEffort: thread.reasoningEffort,
      });
      broadcast({
        method: "thread/started",
        params: { thread: serializeThread(thread, true) },
        emittedAtMs: Date.now(),
      });
      scheduleCrashIfConfigured(350);
      return;
    }

    if (method === "thread/resume") {
      const threadId = String(params.threadId || "");
      let thread = threads.get(threadId);
      if (!thread) {
        thread = makeThread(threadId, {
          model: params.model,
          approvalPolicy: params.approvalPolicy,
          approvalsReviewer: params.approvalsReviewer,
          sandbox: params.sandbox === "danger-full-access" ? { type: "dangerFullAccess" } : params.sandboxPolicy,
        });
        threads.set(threadId, thread);
      }
      resumedOnThisProcess = true;
      reply({
        thread: serializeThread(thread, true),
        model: thread.model,
        modelProvider: thread.modelProvider,
        serviceTier: "default",
        cwd: thread.cwd,
        runtimeWorkspaceRoots: [thread.cwd],
        instructionSources: [],
        approvalPolicy: thread.approvalPolicy,
        approvalsReviewer: thread.approvalsReviewer,
        sandbox: thread.sandbox,
        reasoningEffort: thread.reasoningEffort,
      });
      return;
    }

    if (method === "thread/read") {
      const thread = threads.get(String(params.threadId || ""));
      if (!thread) {
        replyError(-32000, `thread ${params.threadId} not found`);
        return;
      }
      reply({ thread: serializeThread(thread, params.includeTurns !== false) });
      if (resumedOnThisProcess) {
        scheduleCrashIfConfigured(350);
      }
      return;
    }

    if (method === "thread/turns/list") {
      const thread = threads.get(String(params.threadId || ""));
      if (!thread) {
        replyError(-32000, `thread ${params.threadId} not found`);
        return;
      }
      const limit = Math.max(1, Number(params.limit || 10));
      const turns = params.sortDirection === "desc" ? [...thread.turns].reverse() : [...thread.turns];
      reply({
        data: turns.slice(0, limit).map((t) => ({ ...t, itemsView: "full" })),
        nextCursor: null,
      });
      return;
    }

    if (method === "thread/loaded/list") {
      reply({ data: [...threads.keys()] });
      return;
    }

    if (method === "turn/start") {
      const thread = threads.get(String(params.threadId || ""));
      if (!thread) {
        replyError(-32000, `thread ${params.threadId} not found`);
        return;
      }
      const currentIndex = turnCounter;
      turnCounter += 1;
      const turnId = randomUUID();
      const userItemId = `user_item_${currentIndex + 1}`;
      const turn = {
        id: turnId,
        items: [
          {
            type: "userMessage",
            id: userItemId,
            clientId: null,
            content: Array.isArray(params.input) ? params.input : [],
          },
        ],
        itemsView: "full",
        status: "inProgress",
        error: null,
        startedAt: Math.floor(Date.now() / 1000),
        completedAt: null,
        durationMs: null,
      };
      thread.turns.push(turn);
      thread.status = { type: "active", activeFlags: [] };
      reply({ turn: { ...turn, items: [], itemsView: "notLoaded" } });
      setImmediate(() => {
        void runTurnScript(thread, turn, currentIndex);
      });
      return;
    }

    if (method === "turn/interrupt") {
      const turnId = String(params.turnId || "");
      writeMarker(controlDir, "turn-interrupted.json", { threadId: String(params.threadId || ""), turnId });
      reply({});
      const waiters = interruptWaiters.get(turnId) ?? [];
      interruptWaiters.delete(turnId);
      for (const resolve of waiters) setImmediate(resolve);
      return;
    }

    replyError(-32601, `Unsupported method: ${method}`);
  });
});

httpServer.listen(port, hostname);
process.on("SIGTERM", () => {
  wss.close(() => httpServer.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 200).unref();
});
