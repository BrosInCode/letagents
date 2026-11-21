import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { parseOpenCodeEdgeTranscript } from "./parser.mjs";

const DEFAULT_MAX_LIFETIME_MS = 120_000;
const DEFAULT_GATE_TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  let hostname = "127.0.0.1";
  let port = 0;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--hostname" && argv[i + 1]) {
      hostname = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--port" && argv[i + 1]) {
      port = Number.parseInt(argv[i + 1], 10);
      i += 1;
    }
  }
  return { hostname, port };
}

function mintNativeId(prefix, timestampMs, counter) {
  let encoded = BigInt(timestampMs) * BigInt(0x1000) + BigInt(counter);
  const timeBytes = Buffer.alloc(6);
  for (let i = 5; i >= 0; i -= 1) {
    timeBytes[i] = Number(encoded & BigInt(0xff));
    encoded >>= BigInt(8);
  }
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const entropy = randomBytes(14);
  let suffix = "";
  for (const byte of entropy) suffix += alphabet[byte % 62];
  return `${prefix}_${timeBytes.toString("hex")}${suffix}`;
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.once("error", reject);
    req.once("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
  });
}

function sendJson(res, status, body) {
  if (status === 204 || body === null) {
    res.writeHead(status);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isRunnerAlive(runnerPid) {
  if (!runnerPid || !Number.isInteger(runnerPid) || runnerPid <= 1) return true;
  try {
    process.kill(runnerPid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

async function runServer() {
  const { hostname, port } = parseArgs(process.argv.slice(2));
  const transcriptPath = process.env.LETAGENTS_OPENCODE_REPLAY_TRANSCRIPT;
  const controlDir = process.env.LETAGENTS_OPENCODE_REPLAY_CONTROL_DIR || "";
  const runnerPid = Number.parseInt(process.env.LETAGENTS_EDGE_TEST_RUNNER_PID || "0", 10) || 0;
  const maxLifetimeMs = Number.parseInt(process.env.LETAGENTS_REPLAY_MAX_LIFETIME_MS || "", 10) || DEFAULT_MAX_LIFETIME_MS;
  const expectedUsername = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const expectedPassword = process.env.OPENCODE_SERVER_PASSWORD || "";
  let serverConfig = { provider: {}, permission: {} };
  if (process.env.OPENCODE_CONFIG_CONTENT) {
    try { serverConfig = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT); } catch { /* ignore */ }
  }

  if (!transcriptPath) {
    process.stderr.write("LETAGENTS_OPENCODE_REPLAY_TRANSCRIPT is required.\n");
    process.exit(2);
  }
  const transcript = parseOpenCodeEdgeTranscript(readFileSync(transcriptPath, "utf8"), transcriptPath);
  if (controlDir) mkdirSync(controlDir, { recursive: true });

  const writeControl = (name, payload) => {
    if (!controlDir) return;
    writeFileSync(join(controlDir, name), typeof payload === "string" ? payload : JSON.stringify(payload, null, 2), "utf8");
  };

  let idCounter = 1;
  const nextId = (prefix) => mintNativeId(prefix, Date.now(), ++idCounter);

  const placeholderBindings = new Map();
  placeholderBindings.set("<workspace>", process.cwd());

  const resolvePlaceholder = (token) => {
    if (placeholderBindings.has(token)) return placeholderBindings.get(token);
    if (token === "<session>" || token.startsWith("<session-")) {
      const id = nextId("ses");
      placeholderBindings.set(token, id);
      return id;
    }
    if (token.startsWith("<assistant-")) {
      const id = nextId("msg");
      placeholderBindings.set(token, id);
      return id;
    }
    if (token.startsWith("<part-")) {
      const id = nextId("prt");
      placeholderBindings.set(token, id);
      return id;
    }
    if (token.startsWith("<perm-")) {
      const id = nextId("per");
      placeholderBindings.set(token, id);
      return id;
    }
    if (token.startsWith("<call-")) {
      const id = `call_${randomBytes(6).toString("hex")}`;
      placeholderBindings.set(token, id);
      return id;
    }
    if (token === "<uuid>") {
      const id = `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`;
      return id;
    }
    return token;
  };

  const PLACEHOLDER_RE = /<(?:session(?:-\d+)?|turn-\d+|assistant-\d+|part-\d+|perm-\d+|call-\d+|workspace|uuid)>/g;
  const materialize = (value) => {
    if (typeof value === "string") {
      return value.replace(PLACEHOLDER_RE, (match) => resolvePlaceholder(match));
    }
    if (Array.isArray(value)) return value.map(materialize);
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = materialize(v);
      return out;
    }
    return value;
  };

  const sessions = new Map(); // sessionId -> { info, messages: Map<msgId, { info, parts: [] }>, messageOrder: [], busy: boolean }
  const pendingPermissions = new Map(); // permId -> OpenCodePermissionRequest
  const sseClients = new Set();
  let nextTurnIndex = 0;
  let activeTurnWaiters = { permission: null, abort: null };
  let shuttingDown = false;

  const broadcastSse = (event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of [...sseClients]) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  const applyAndEmitEvent = (sessionId, rawEvent) => {
    const event = materialize(rawEvent);
    const session = sessions.get(sessionId);
    const props = event.properties || {};

    if (session) {
      if (event.type === "message.updated" && props.info && typeof props.info.id === "string") {
        const info = { ...props.info, sessionID: sessionId };
        // Keep chronological timestamps aligned with the live user turn timestamp so `chronological()` stays deterministic.
        const existing = session.messages.get(info.id);
        const now = Date.now();
        const normalizedTime = info.time && typeof info.time === "object"
          ? {
              ...info.time,
              ...(typeof info.time.created === "number" ? { created: existing?.info?.time?.created ?? now } : {}),
              ...(typeof info.time.completed === "number" ? { completed: Math.max(now, (existing?.info?.time?.created ?? now) + 1) } : {}),
            }
          : { created: now };
        info.time = normalizedTime;
        event.properties = { ...props, info };
        if (existing) {
          existing.info = info;
        } else {
          session.messages.set(info.id, { info, parts: [] });
          session.messageOrder.push(info.id);
        }
      } else if (event.type === "message.part.updated" && props.part && typeof props.part.messageID === "string") {
        const part = { ...props.part, sessionID: sessionId };
        const msg = session.messages.get(part.messageID);
        if (msg) {
          const idx = msg.parts.findIndex((p) => p.id === part.id);
          if (idx >= 0) msg.parts[idx] = part;
          else msg.parts.push(part);
        }
        event.properties = { ...props, part };
      } else if (event.type === "message.part.delta" && typeof props.messageID === "string" && typeof props.partID === "string") {
        const msg = session.messages.get(props.messageID);
        if (msg) {
          const part = msg.parts.find((p) => p.id === props.partID);
          if (part && typeof props.field === "string" && typeof props.delta === "string") {
            part[props.field] = `${typeof part[props.field] === "string" ? part[props.field] : ""}${props.delta}`;
          }
        }
      } else if (event.type === "permission.asked" && props.id) {
        pendingPermissions.set(props.id, props);
      } else if (event.type === "permission.replied" && props.requestID) {
        pendingPermissions.delete(props.requestID);
      } else if (event.type === "session.idle") {
        session.busy = false;
      }
    }

    broadcastSse(event);
    return event;
  };

  const waitUntil = async (predicate, timeoutMs = DEFAULT_GATE_TIMEOUT_MS) => {
    const deadline = Date.now() + timeoutMs;
    while (!shuttingDown && Date.now() < deadline) {
      if (predicate()) return true;
      if (!isRunnerAlive(runnerPid)) {
        shutdownNow(0);
        return false;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return predicate();
  };

  const runRecordedTurn = async (sessionId, turn, turnNumber, userMessageId) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.busy = true;
    const holdFile = controlDir ? join(controlDir, `hold-turn-${turnNumber}`) : "";
    const releaseFile = controlDir ? join(controlDir, `release-turn-${turnNumber}`) : "";
    const shouldHold = Boolean(holdFile && existsSync(holdFile));
    let holdApplied = false;
    let lastAssistantId = null;
    let lastToolPart = null;

    try {
      for (const step of turn.steps) {
        if (shuttingDown) return;
        if (step.kind === "sse") {
          for (let i = 0; i < step.events.length; i += 1) {
            if (shuttingDown) return;
            const emitted = applyAndEmitEvent(sessionId, step.events[i]);
            if (emitted.type === "message.updated" && emitted.properties?.info?.role === "assistant") {
              lastAssistantId = emitted.properties.info.id;
            }
            if (emitted.type === "message.part.updated" && emitted.properties?.part?.type === "tool") {
              lastToolPart = emitted.properties.part;
            }
            // If test requested a hold on this turn, pause right after the first assistant message.updated
            // so the daemon observes an active turn before completion streams through.
            if (shouldHold && !holdApplied && emitted.type === "message.updated") {
              holdApplied = true;
              writeControl(`turn-${turnNumber}-held.json`, { turnNumber, messageId: userMessageId, at: Date.now() });
              await waitUntil(() => existsSync(releaseFile) || Boolean(activeTurnWaiters.abort?.aborted));
              if (activeTurnWaiters.abort?.aborted) {
                return;
              }
            }
          }
          continue;
        }

        if (step.kind === "await_permission") {
          const permId = resolvePlaceholder(step.permPlaceholder);
          writeControl(`turn-${turnNumber}-waiting-permission.json`, {
            turnNumber,
            permId,
            messageId: userMessageId,
            at: Date.now(),
          });
          const decision = await new Promise((resolveDecision) => {
            const waiter = { permId, resolve: resolveDecision };
            activeTurnWaiters.permission = waiter;
            void waitUntil(() => activeTurnWaiters.permission !== waiter).then(() => {
              if (activeTurnWaiters.permission === waiter) {
                activeTurnWaiters.permission = null;
                resolveDecision({ reply: "timeout", aborted: true });
              }
            });
          });
          if (decision.aborted || shuttingDown) return;
          writeControl(`turn-${turnNumber}-permission-decision.json`, {
            turnNumber,
            permId,
            reply: decision.reply,
            at: Date.now(),
          });
          // Enforce native approval decision: only "once" or "always" continues to the granted recorded frames!
          if (decision.reply !== "once" && decision.reply !== "always") {
            pendingPermissions.delete(permId);
            broadcastSse({
              type: "permission.replied",
              properties: { sessionID: sessionId, requestID: permId, reply: decision.reply },
            });
            if (lastToolPart) {
              const deniedPart = {
                ...lastToolPart,
                state: {
                  ...(lastToolPart.state || {}),
                  status: "error",
                  error: "The user rejected permission to use this specific tool call",
                },
              };
              const msg = session.messages.get(deniedPart.messageID);
              if (msg) {
                const idx = msg.parts.findIndex((p) => p.id === deniedPart.id);
                if (idx >= 0) msg.parts[idx] = deniedPart;
              }
              broadcastSse({
                type: "message.part.updated",
                properties: { sessionID: sessionId, part: deniedPart, time: Date.now() },
              });
            }
            if (lastAssistantId) {
              const msg = session.messages.get(lastAssistantId);
              if (msg) {
                msg.info = {
                  ...msg.info,
                  time: { ...(msg.info.time || { created: Date.now() }), completed: Date.now() },
                  error: { name: "MessageAbortedError", data: { message: "Permission rejected by host" } },
                };
                broadcastSse({
                  type: "message.updated",
                  properties: { sessionID: sessionId, info: msg.info },
                });
              }
            }
            session.busy = false;
            broadcastSse({ type: "session.idle", properties: { sessionID: sessionId } });
            return;
          }
          continue;
        }

        if (step.kind === "await_abort") {
          writeControl(`turn-${turnNumber}-waiting-abort.json`, {
            turnNumber,
            messageId: userMessageId,
            at: Date.now(),
          });
          await new Promise((resolveAbort) => {
            const waiter = { aborted: false, response: step.response, resolve: resolveAbort };
            activeTurnWaiters.abort = waiter;
            void waitUntil(() => waiter.aborted).then(() => {
              if (activeTurnWaiters.abort === waiter && !waiter.aborted) {
                activeTurnWaiters.abort = null;
                resolveAbort();
              }
            });
          });
        }
      }
    } finally {
      if (session) session.busy = false;
    }
  };

  const checkAuth = (req) => {
    if (!expectedPassword) return true;
    const expected = `Basic ${Buffer.from(`${expectedUsername}:${expectedPassword}`).toString("base64")}`;
    return req.headers.authorization === expected;
  };

  const server = createServer(async (req, res) => {
    if (!checkAuth(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const method = (req.method || "GET").toUpperCase();
    const url = new URL(req.url || "/", `http://${hostname}:${port || 1}`);
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/global/health") {
      sendJson(res, transcript.healthResponse.status, materialize(transcript.healthResponse.body));
      return;
    }

    if (method === "GET" && pathname === "/config") {
      sendJson(res, 200, serverConfig);
      return;
    }

    if (method === "GET" && pathname === "/event") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      sseClients.add(res);
      req.once("close", () => sseClients.delete(res));
      return;
    }

    if (method === "GET" && pathname === "/session") {
      sendJson(res, 200, [...sessions.values()].map((s) => s.info));
      return;
    }

    if (method === "POST" && pathname === "/session") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const info = materialize(transcript.createSessionResponse.body);
      if (typeof body.title === "string" && body.title) info.title = body.title;
      info.directory = process.cwd();
      const now = Date.now();
      info.time = { created: now, updated: now };
      sessions.set(info.id, {
        info,
        messages: new Map(),
        messageOrder: [],
        busy: false,
      });
      sendJson(res, transcript.createSessionResponse.status, info);

      // Crash-loop fixture: recorded startup handshake followed by unrequested non-zero exit.
      if (transcript.turns.length === 0 && transcript.runtimeExit.requested === false) {
        const exitCode = transcript.runtimeExit.code ?? 1;
        setTimeout(() => {
          server.closeAllConnections?.();
          process.exit(exitCode);
        }, 150).unref();
      }
      return;
    }

    if (method === "GET" && pathname === "/session/status") {
      const statusMap = {};
      for (const [sid, session] of sessions.entries()) {
        if (session.busy) statusMap[sid] = { type: "busy" };
      }
      sendJson(res, 200, statusMap);
      return;
    }

    const msgSingleMatch = /^\/session\/([^/]+)\/message\/([^/]+)$/.exec(pathname);
    if (method === "GET" && msgSingleMatch) {
      const sid = decodeURIComponent(msgSingleMatch[1]);
      const mid = decodeURIComponent(msgSingleMatch[2]);
      const session = sessions.get(sid);
      if (!session) { sendJson(res, 404, { error: "Session not found" }); return; }
      const msg = session.messages.get(mid);
      if (!msg) { sendJson(res, 404, { error: "Message not found" }); return; }
      sendJson(res, 200, msg);
      return;
    }

    const msgListMatch = /^\/session\/([^/]+)\/message$/.exec(pathname);
    if (method === "GET" && msgListMatch) {
      const sid = decodeURIComponent(msgListMatch[1]);
      const session = sessions.get(sid);
      if (!session) { sendJson(res, 404, { error: "Session not found" }); return; }
      const limit = Math.max(1, Number.parseInt(url.searchParams.get("limit") || "64", 10) || 64);
      const list = session.messageOrder.slice(-limit).map((id) => session.messages.get(id)).filter(Boolean);
      sendJson(res, 200, list);
      return;
    }

    const promptMatch = /^\/session\/([^/]+)\/prompt_async$/.exec(pathname);
    if (method === "POST" && promptMatch) {
      const sid = decodeURIComponent(promptMatch[1]);
      const session = sessions.get(sid);
      if (!session) { sendJson(res, 404, { error: "Session not found" }); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      if (nextTurnIndex >= transcript.turns.length) {
        writeControl(`unexpected-turn-${nextTurnIndex + 1}.json`, {
          turnIndex: nextTurnIndex + 1,
          availableTurns: transcript.turns.length,
          messageId: body.messageID ?? null,
          at: Date.now(),
        });
        sendJson(res, 500, {
          error: `Unexpected OpenCode prompt_async #${nextTurnIndex + 1}; transcript only recorded ${transcript.turns.length} turn(s).`,
        });
        return;
      }
      const turn = transcript.turns[nextTurnIndex];
      nextTurnIndex += 1;
      const userMessageId = typeof body.messageID === "string" && body.messageID ? body.messageID : nextId("msg");
      placeholderBindings.set(turn.turnPlaceholder, userMessageId);
      const promptText = Array.isArray(body.parts)
        ? body.parts.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n")
        : "";
      const now = Date.now();
      const userMessage = {
        info: {
          id: userMessageId,
          role: "user",
          sessionID: sid,
          time: { created: now },
          agent: "build",
          model: body.model || { providerID: "letagents-open-model", modelID: "edge-model" },
        },
        parts: Array.isArray(body.parts)
          ? body.parts.map((p, idx) => ({ id: nextId("prt"), messageID: userMessageId, sessionID: sid, ...p, index: idx }))
          : [],
      };
      session.messages.set(userMessageId, userMessage);
      session.messageOrder.push(userMessageId);
      session.busy = true;
      writeControl(`turn-${turn.turnIndex}-started.json`, {
        turnNumber: turn.turnIndex,
        messageId: userMessageId,
        promptText,
        startedAt: now,
      });
      const resp = turn.promptResponse || { status: 204, body: null };
      sendJson(res, resp.status, resp.body);
      void runRecordedTurn(sid, turn, turn.turnIndex, userMessageId);
      return;
    }

    const abortMatch = /^\/session\/([^/]+)\/abort$/.exec(pathname);
    if (method === "POST" && abortMatch) {
      const sid = decodeURIComponent(abortMatch[1]);
      const session = sessions.get(sid);
      if (!session) { sendJson(res, 404, { error: "Session not found" }); return; }
      writeControl("turn-aborted.json", { sessionId: sid, at: Date.now() });
      const waiter = activeTurnWaiters.abort;
      if (waiter) {
        waiter.aborted = true;
        activeTurnWaiters.abort = null;
        sendJson(res, waiter.response?.status ?? 200, waiter.response?.body ?? true);
        waiter.resolve();
        return;
      }
      // If aborted while held in a non-abort transcript, cleanly stop the busy state.
      activeTurnWaiters.abort = { aborted: true };
      session.busy = false;
      broadcastSse({
        type: "session.error",
        properties: { sessionID: sid, error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
      });
      broadcastSse({ type: "session.idle", properties: { sessionID: sid } });
      sendJson(res, 200, true);
      return;
    }

    if (method === "GET" && pathname === "/permission") {
      sendJson(res, 200, [...pendingPermissions.values()]);
      return;
    }

    const permReplyMatch = /^\/permission\/([^/]+)\/reply$/.exec(pathname);
    if (method === "POST" && permReplyMatch) {
      const permId = decodeURIComponent(permReplyMatch[1]);
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!pendingPermissions.has(permId)) {
        sendJson(res, 404, { error: "Permission not pending" });
        return;
      }
      const reply = typeof body.reply === "string" ? body.reply : "reject";
      const waiter = activeTurnWaiters.permission;
      if (waiter && waiter.permId === permId) {
        activeTurnWaiters.permission = null;
        sendJson(res, 200, true);
        waiter.resolve({ reply, aborted: false });
        return;
      }
      sendJson(res, 404, { error: "No active waiter for permission" });
      return;
    }

    sendJson(res, 404, { error: `Unhandled OpenCode replay route: ${method} ${pathname}` });
  });

  function shutdownNow(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const res of [...sseClients]) {
      try { res.end(); } catch { /* ignore */ }
    }
    sseClients.clear();
    server.closeAllConnections?.();
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 500).unref();
  }

  const lifetimeTimer = setTimeout(() => shutdownNow(0), maxLifetimeMs);
  lifetimeTimer.unref();

  if (runnerPid > 1) {
    const parentWatch = setInterval(() => {
      if (!isRunnerAlive(runnerPid)) shutdownNow(0);
    }, 250);
    parentWatch.unref();
  }

  process.on("SIGTERM", () => shutdownNow(0));
  process.on("SIGINT", () => shutdownNow(0));

  server.listen(port, hostname);
}

await runServer();
