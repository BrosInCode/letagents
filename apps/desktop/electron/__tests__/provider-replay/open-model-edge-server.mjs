import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

function parseArgs(argv) {
  let hostname = "127.0.0.1";
  let port = 0;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--hostname" && argv[i + 1]) {
      hostname = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--port" && argv[i + 1]) {
      port = Number(argv[i + 1]);
      i += 1;
    }
  }
  return { hostname, port };
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
  if (!start || start.type !== "transcript_start" || start.provider !== "open-model") {
    throw new Error(`${filePath}: expected open-model transcript_start header`);
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
    if (entry.type === "expect_outbound" && entry.frame?.path === "/session/<session>/prompt_async") {
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

function mintAscendingMessageId(timestampMs, counter = 1) {
  let encoded = BigInt(timestampMs) * BigInt(0x1000) + BigInt(counter);
  const bytes = Buffer.alloc(6);
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(encoded & BigInt(0xff));
    encoded >>= BigInt(8);
  }
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const entropy = randomBytes(14);
  let suffix = "";
  for (const b of entropy) suffix += alphabet[b % 62];
  return `msg_${bytes.toString("hex")}${suffix}`;
}

function substitute(value, vars) {
  if (value === "<now>") return Date.now();
  if (typeof value === "string") {
    let out = value;
    for (const [key, replacement] of Object.entries(vars)) {
      if (out.includes(key)) out = out.split(key).join(String(replacement));
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars));
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = substitute(v, vars);
    }
    return result;
  }
  return value;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function writeMarker(controlDir, filename, payload) {
  if (!controlDir) return;
  try {
    mkdirSync(controlDir, { recursive: true });
    writeFileSync(join(controlDir, filename), `${JSON.stringify(payload)}\n`, "utf8");
  } catch {
    // Best-effort test synchronization marker.
  }
}

async function waitForGateFile(controlDir, gateName) {
  const target = join(controlDir, gateName);
  while (!existsSync(target)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const { hostname, port } = parseArgs(process.argv.slice(2));
const transcriptPath = process.env.LETAGENTS_OPENCODE_REPLAY_TRANSCRIPT;
if (!transcriptPath) {
  process.stderr.write("LETAGENTS_OPENCODE_REPLAY_TRANSCRIPT is required.\n");
  process.exit(2);
}
const controlDir = process.env.LETAGENTS_OPENCODE_REPLAY_CONTROL_DIR || "";
const transcript = loadTranscript(transcriptPath);

const expectedUser = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const expectedPassword = process.env.OPENCODE_SERVER_PASSWORD || "";
const expectedAuthHeader = `Basic ${Buffer.from(`${expectedUser}:${expectedPassword}`).toString("base64")}`;

let serverConfig = { model: "letagents-open-model/edge-model" };
if (process.env.OPENCODE_CONFIG_CONTENT) {
  try {
    serverConfig = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  } catch {
    // Keep default config.
  }
}

const sessions = new Map(); // sessionId -> { id, title, messages: Map<msgId, { info, parts }>, order: string[] }
const busySessions = new Set();
const pendingPermissions = new Map(); // reqId -> OpenCodePermissionRequest
const sseClients = new Set();
const abortWaiters = new Map(); // sessionId -> Array<() => void>
const permissionWaiters = new Map(); // reqId -> Array<(reply: string) => void>

let sessionCounter = 0;
let turnCounter = 0;
let messageSeq = 1;
let crashScheduled = false;

function broadcastEvent(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function scheduleCrashIfConfigured(delayMs) {
  if (crashScheduled) return;
  if (transcript.runtimeExit.requested === false && typeof transcript.runtimeExit.code === "number" && transcript.runtimeExit.code !== 0) {
    crashScheduled = true;
    const exitCode = transcript.runtimeExit.code;
    setTimeout(() => {
      process.exit(exitCode);
    }, delayMs);
  }
}

function applyInboundEvent(session, frame) {
  const type = frame?.type;
  const props = frame?.properties;
  if (type === "message.updated" && props?.info?.id) {
    const msgId = props.info.id;
    const existing = session.messages.get(msgId);
    if (existing) {
      existing.info = props.info;
    } else {
      session.messages.set(msgId, { info: props.info, parts: [] });
      session.order.push(msgId);
    }
  } else if (type === "message.part.updated" && props?.part?.messageID && props?.part?.id) {
    const msgId = props.part.messageID;
    let entry = session.messages.get(msgId);
    if (!entry) {
      entry = { info: { id: msgId, sessionID: session.id, role: "assistant" }, parts: [] };
      session.messages.set(msgId, entry);
      session.order.push(msgId);
    }
    const idx = entry.parts.findIndex((part) => part.id === props.part.id);
    if (idx >= 0) entry.parts[idx] = props.part;
    else entry.parts.push(props.part);
  } else if (type === "message.part.delta" && props?.messageID && props?.partID && typeof props?.delta === "string") {
    const entry = session.messages.get(props.messageID);
    const part = entry?.parts.find((item) => item.id === props.partID);
    if (part && props.field === "text") {
      part.text = `${typeof part.text === "string" ? part.text : ""}${props.delta}`;
    }
  } else if (type === "permission.asked" && props?.id) {
    pendingPermissions.set(props.id, props);
    writeMarker(controlDir, `permission-${props.id}-asked.json`, { id: props.id, sessionID: session.id });
  } else if (type === "session.idle") {
    busySessions.delete(session.id);
  }
  broadcastEvent(frame);
}

async function runTurnScript(session, turnId, turnIndex, promptBody) {
  const script = transcript.turns[turnIndex];
  writeMarker(controlDir, `turn-${turnIndex + 1}-started.json`, {
    turnIndex: turnIndex + 1,
    sessionId: session.id,
    turnId,
    pid: process.pid,
    promptText: promptBody?.parts?.[0]?.text ?? "",
  });

  if (!script) {
    // Fallback reply if test delivers extra messages beyond scripted turns.
    const assistantId = mintAscendingMessageId(Date.now() + 2, ++messageSeq);
    const partId = `prt_${turnIndex + 1}_1`;
    const now = Date.now();
    applyInboundEvent(session, {
      type: "message.updated",
      properties: {
        info: {
          id: assistantId,
          sessionID: session.id,
          role: "assistant",
          parentID: turnId,
          time: { created: now, completed: now + 1 },
        },
      },
    });
    applyInboundEvent(session, {
      type: "message.part.updated",
      properties: {
        part: { id: partId, sessionID: session.id, messageID: assistantId, type: "text", text: `edge-reply-${turnIndex + 1}` },
      },
    });
    applyInboundEvent(session, {
      type: "message.part.updated",
      properties: {
        part: { id: `${partId}_finish`, sessionID: session.id, messageID: assistantId, type: "step-finish", reason: "stop" },
      },
    });
    applyInboundEvent(session, { type: "session.idle", properties: { sessionID: session.id } });
    return;
  }

  const assistantId = mintAscendingMessageId(Date.now() + 2, ++messageSeq);
  const vars = {
    "<session>": session.id,
    "<turnId>": turnId,
    "<assistantId>": assistantId,
    "<requestId>": `perm_edge_${turnIndex + 1}`,
    "<callId>": `call_edge_${turnIndex + 1}`,
    "<reply>": "once",
  };

  for (const step of script.steps) {
    if (step.type === "emit_inbound") {
      const frame = substitute(step.frame, vars);
      applyInboundEvent(session, frame);
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    if (step.type === "expect_outbound") {
      const path = step.frame?.path;
      if (path === "/session/<session>/abort") {
        writeMarker(controlDir, `turn-${turnIndex + 1}-waiting-abort.json`, { sessionId: session.id, turnId });
        await new Promise((resolve) => {
          const list = abortWaiters.get(session.id) ?? [];
          list.push(resolve);
          abortWaiters.set(session.id, list);
        });
        continue;
      }
      if (path === "/permission/<request>/reply") {
        const reqId = vars["<requestId>"];
        const reply = await new Promise((resolve) => {
          const list = permissionWaiters.get(reqId) ?? [];
          list.push(resolve);
          permissionWaiters.set(reqId, list);
        });
        vars["<reply>"] = reply;
        continue;
      }
      if (typeof step.frame?.gate === "string" && controlDir) {
        writeMarker(controlDir, `turn-${turnIndex + 1}-waiting-gate.json`, {
          gate: step.frame.gate,
          sessionId: session.id,
          turnId,
          pid: process.pid,
        });
        await waitForGateFile(controlDir, step.frame.gate);
        continue;
      }
    }
  }
}

const server = createServer(async (req, res) => {
  if (req.headers.authorization !== expectedAuthHeader) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const url = new URL(req.url || "/", `http://${hostname}:${port}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  const sendJson = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
    if (method === "GET" && pathname === "/global/health") {
      return sendJson(200, { healthy: true, version: transcript.start.providerVersion || "1.18.20" });
    }

    if (method === "GET" && pathname === "/config") {
      return sendJson(200, serverConfig);
    }

    if (method === "GET" && pathname === "/session") {
      return sendJson(200, [...sessions.values()].map((s) => ({ id: s.id, title: s.title })));
    }

    if (method === "POST" && pathname === "/session") {
      const body = await readJsonBody(req);
      sessionCounter += 1;
      const id = `ses_edge_${sessionCounter}_${randomBytes(4).toString("hex")}`;
      sessions.set(id, { id, title: String(body.title || "Edge Session"), messages: new Map(), order: [] });
      if (transcript.runtimeExit.requested === false && transcript.runtimeExit.code !== 0) {
        // Fallback crash timer in case /event is not opened promptly.
        setTimeout(() => scheduleCrashIfConfigured(100), 600);
      }
      return sendJson(200, { id, title: String(body.title || "Edge Session") });
    }

    if (method === "GET" && pathname === "/session/status") {
      const status = {};
      for (const sid of busySessions) status[sid] = { type: "busy" };
      return sendJson(200, status);
    }

    if (method === "GET" && pathname === "/permission") {
      return sendJson(200, [...pendingPermissions.values()]);
    }

    const permReplyMatch = pathname.match(/^\/permission\/([^/]+)\/reply$/);
    if (method === "POST" && permReplyMatch) {
      const reqId = decodeURIComponent(permReplyMatch[1]);
      const body = await readJsonBody(req);
      if (!pendingPermissions.has(reqId)) {
        return sendJson(404, { error: "not_pending" });
      }
      pendingPermissions.delete(reqId);
      const reply = String(body.reply || "once");
      const waiters = permissionWaiters.get(reqId) ?? [];
      permissionWaiters.delete(reqId);
      sendJson(200, true);
      for (const resolve of waiters) setImmediate(() => resolve(reply));
      return;
    }

    if (method === "GET" && pathname === "/event") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      // Opening /event proves the daemon installed the live handle and observed idle.
      scheduleCrashIfConfigured(250);
      return;
    }

    const promptMatch = pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (method === "POST" && promptMatch) {
      const sid = decodeURIComponent(promptMatch[1]);
      const session = sessions.get(sid);
      if (!session) return sendJson(404, { error: "session_not_found" });
      const body = await readJsonBody(req);
      const userId = String(body.messageID || mintAscendingMessageId(Date.now(), ++messageSeq));
      const now = Date.now();
      session.messages.set(userId, {
        info: { id: userId, sessionID: sid, role: "user", time: { created: now } },
        parts: Array.isArray(body.parts) ? body.parts : [],
      });
      session.order.push(userId);
      busySessions.add(sid);
      const currentTurnIndex = turnCounter;
      turnCounter += 1;
      sendJson(200, { ok: true });
      setImmediate(() => {
        void runTurnScript(session, userId, currentTurnIndex, body);
      });
      return;
    }

    const abortMatch = pathname.match(/^\/session\/([^/]+)\/abort$/);
    if (method === "POST" && abortMatch) {
      const sid = decodeURIComponent(abortMatch[1]);
      const session = sessions.get(sid);
      if (!session) return sendJson(404, { error: "session_not_found" });
      writeMarker(controlDir, "turn-aborted.json", { sessionId: sid });
      const waiters = abortWaiters.get(sid) ?? [];
      abortWaiters.delete(sid);
      if (waiters.length > 0) {
        for (const resolve of waiters) resolve();
      } else {
        busySessions.delete(sid);
        broadcastEvent({ type: "session.idle", properties: { sessionID: sid } });
      }
      return sendJson(200, true);
    }

    const messageOneMatch = pathname.match(/^\/session\/([^/]+)\/message\/([^/]+)$/);
    if (method === "GET" && messageOneMatch) {
      const sid = decodeURIComponent(messageOneMatch[1]);
      const msgId = decodeURIComponent(messageOneMatch[2]);
      const session = sessions.get(sid);
      const message = session?.messages.get(msgId);
      if (!message) return sendJson(404, { error: "message_not_found" });
      return sendJson(200, message);
    }

    const messagesMatch = pathname.match(/^\/session\/([^/]+)\/message$/);
    if (method === "GET" && messagesMatch) {
      const sid = decodeURIComponent(messagesMatch[1]);
      const session = sessions.get(sid);
      if (!session) return sendJson(404, { error: "session_not_found" });
      const limit = Math.max(1, Number(url.searchParams.get("limit") || 64));
      const all = session.order.map((id) => session.messages.get(id)).filter(Boolean);
      return sendJson(200, all.slice(-limit));
    }

    return sendJson(404, { error: `unhandled route ${method} ${pathname}` });
  } catch (error) {
    return sendJson(500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, hostname);
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 200).unref();
});
