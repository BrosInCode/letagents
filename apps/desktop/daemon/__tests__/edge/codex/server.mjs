/**
 * Transcript-driven Codex `app-server` stand-in for black-box daemon edge tests.
 *
 * Protocol initialization, `thread/start`, turn streaming deltas/completions,
 * approval prompts, and interrupts replay recorded frames from real
 * `codex-cli 0.162.1` fixtures in `./fixtures/*.ndjson` (note: `crash-loop.ndjson`
 * reuses the recorded `simple` handshake and appends a fault-injected exit).
 *
 * Methods answered by the stand-in, not recorded (and why):
 * - `config/read` (stdio probe & WebSocket): returns local sandbox/model config for
 *   the ephemeral test home created by `codex-agent-home.ts`.
 * - `hooks/list` (stdio probe): returns `{ data: [] }` for the ephemeral test home.
 * - `account/read` (stdio probe): validates `CODEX_REFRESH_TOKEN_URL_OVERRIDE` in-place
 *   rewrite during `ask_before_write` sandbox preflight.
 * - `command/exec` (stdio probe): verifies `-c permissions.<profile>` denied-path
 *   overrides during `ask_before_write` sandbox preflight.
 * - `model/list` (WebSocket): advertises the configured test model when queried.
 * - `mcpServerStatus/list` (fallback only): replays the recorded response when present
 *   in the transcript; falls back to `{ data: [] }` when the recording did not emit one.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { WebSocketServer } from "ws";

import { parseCodexEdgeTranscript } from "./parser.mjs";

const DEFAULT_MAX_LIFETIME_MS = 120_000;
const DEFAULT_GATE_TIMEOUT_MS = 60_000;

function isRunnerAlive(runnerPid) {
  if (!runnerPid || !Number.isInteger(runnerPid) || runnerPid <= 1) return true;
  try {
    process.kill(runnerPid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function extractDeniedPathsFromOverrides(argv) {
  const denied = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "-c" || !argv[i + 1]) continue;
    const override = argv[i + 1];
    const re = /"((?:\\.|[^"\\])*)"\s*=\s*"deny"/g;
    for (const match of override.matchAll(re)) {
      try {
        const rawPath = JSON.parse(`"${match[1]}"`);
        denied.add(rawPath);
        try { denied.add(realpathSync(rawPath)); } catch { /* ignore */ }
      } catch { /* ignore */ }
    }
  }
  return denied;
}

async function handleStdioMode(argv, transcript) {
  const deniedPaths = extractDeniedPathsFromOverrides(argv);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const writeMsg = (msg) => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const lifetime = setTimeout(() => process.exit(0), 30_000);
  lifetime.unref();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { continue; }
    if (msg.id === undefined || typeof msg.method !== "string") continue;

    if (msg.method === "initialize") {
      writeMsg({
        id: msg.id,
        result: {
          ...(transcript.initializeResult || {}),
          codexHome: process.env.CODEX_HOME || join(process.env.HOME || process.cwd(), ".codex"),
        },
      });
      continue;
    }

    if (msg.method === "config/read") {
      writeMsg({
        id: msg.id,
        result: {
          config: { cli_auth_credentials_store: "file" },
          layers: [],
        },
      });
      continue;
    }

    if (msg.method === "hooks/list") {
      writeMsg({ id: msg.id, result: { hooks: [] } });
      continue;
    }

    if (msg.method === "account/read") {
      const refreshUrl = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE;
      const codexHome = process.env.CODEX_HOME;
      if (refreshUrl && codexHome) {
        const authPath = join(codexHome, "auth.json");
        try {
          const resp = await fetch(refreshUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ grant_type: "refresh_token" }),
          });
          if (resp.ok) {
            const refreshed = await resp.json();
            const current = existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf8")) : {};
            const updated = {
              ...current,
              tokens: {
                ...(current.tokens || {}),
                id_token: refreshed.id_token ?? current.tokens?.id_token,
                access_token: refreshed.access_token ?? current.tokens?.access_token,
                refresh_token: refreshed.refresh_token ?? current.tokens?.refresh_token,
              },
              last_refresh: new Date().toISOString(),
            };
            // Write in place so symlinks and Windows hardlinks stay linked to the owner's file.
            writeFileSync(authPath, JSON.stringify(updated), "utf8");
          }
        } catch {
          // Return failure below if refresh could not be completed.
        }
      }
      writeMsg({ id: msg.id, result: { account: null } });
      continue;
    }

    if (msg.method === "command/exec") {
      const cmd = Array.isArray(msg.params?.command) ? msg.params.command : [];
      const target = cmd.at(-1);
      if (typeof target !== "string" || !target) {
        writeMsg({ id: msg.id, result: { exitCode: 1, stdout: "", stderr: "Missing path" } });
        continue;
      }
      let targetReal = target;
      try { targetReal = realpathSync(target); } catch { /* ignore */ }
      const isDenied = deniedPaths.has(target) || deniedPaths.has(targetReal);
      if (isDenied) {
        writeMsg({ id: msg.id, result: { exitCode: 1, stdout: "", stderr: "Permission denied" } });
        continue;
      }
      try {
        const content = readFileSync(target, "utf8");
        writeMsg({ id: msg.id, result: { exitCode: 0, stdout: content, stderr: "" } });
      } catch (err) {
        writeMsg({ id: msg.id, result: { exitCode: 1, stdout: "", stderr: String(err) } });
      }
      continue;
    }

    writeMsg({ id: msg.id, result: {} });
  }
  process.exit(0);
}

function parseListenUrl(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--listen" && argv[i + 1]) return argv[i + 1];
  }
  return null;
}

async function runServer() {
  const argv = process.argv.slice(2);
  const transcriptPath = process.env.LETAGENTS_CODEX_REPLAY_TRANSCRIPT;
  const controlDir = process.env.LETAGENTS_CODEX_REPLAY_CONTROL_DIR || "";
  const runnerPid = Number.parseInt(process.env.LETAGENTS_EDGE_TEST_RUNNER_PID || "0", 10) || 0;
  const maxLifetimeMs = Number.parseInt(process.env.LETAGENTS_REPLAY_MAX_LIFETIME_MS || "", 10) || DEFAULT_MAX_LIFETIME_MS;

  if (argv.includes("--version") || argv.includes("-V")) {
    const version = transcriptPath && existsSync(transcriptPath)
      ? parseCodexEdgeTranscript(readFileSync(transcriptPath, "utf8"), transcriptPath).start.providerVersion
      : "codex-cli 0.162.1";
    process.stdout.write(`${version}\n`);
    process.exit(0);
  }
  if (argv.includes("mcp") && argv.includes("list")) {
    process.stdout.write("[]\n");
    process.exit(0);
  }

  if (!transcriptPath) {
    process.stderr.write("LETAGENTS_CODEX_REPLAY_TRANSCRIPT is required.\n");
    process.exit(2);
  }
  const transcript = parseCodexEdgeTranscript(readFileSync(transcriptPath, "utf8"), transcriptPath);
  const listenArg = argv.includes("app-server") ? parseListenUrl(argv) : null;

  if (listenArg === "stdio://") {
    await handleStdioMode(argv, transcript);
    return;
  }

  if (!listenArg || !listenArg.startsWith("ws://")) {
    process.stderr.write(`Unsupported codex replay invocation: ${argv.join(" ")}\n`);
    process.exit(2);
  }

  if (controlDir) mkdirSync(controlDir, { recursive: true });
  const writeControl = (name, payload) => {
    if (!controlDir) return;
    writeFileSync(join(controlDir, name), typeof payload === "string" ? payload : JSON.stringify(payload, null, 2), "utf8");
  };

  const listenUrl = new URL(listenArg);
  const host = listenUrl.hostname || "127.0.0.1";
  const port = Number.parseInt(listenUrl.port, 10);

  const placeholderBindings = new Map();
  placeholderBindings.set("<workspace>", process.cwd());
  const resolvePlaceholder = (token) => {
    if (placeholderBindings.has(token)) return placeholderBindings.get(token);
    if (token === "<thread>" || token.startsWith("<thread-")) {
      const id = randomUUID();
      placeholderBindings.set(token, id);
      return id;
    }
    if (token.startsWith("<turn-")) {
      const id = randomUUID();
      placeholderBindings.set(token, id);
      return id;
    }
    if (token.startsWith("<item-")) {
      const id = `item_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      placeholderBindings.set(token, id);
      return id;
    }
    if (token.startsWith("<proc-")) {
      const id = String(10000 + Math.floor(Math.random() * 50000));
      placeholderBindings.set(token, id);
      return id;
    }
    return token;
  };

  const PLACEHOLDER_RE = /<(?:thread(?:-\d+)?|turn-\d+|item-\d+|proc-\d+|workspace)>/g;
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

  const clients = new Set();
  const broadcast = (frame) => {
    const raw = JSON.stringify(frame);
    for (const ws of [...clients]) {
      if (ws.readyState === 1) {
        try { ws.send(raw); } catch { /* ignore */ }
      }
    }
  };

  let threadState = null; // Live materialized thread object (with turns[])
  let threadStartMeta = null;
  let nextTurnIndex = 0;
  let nextServerReqId = 100;
  let activeInterruptWaiter = null;
  const pendingServerRequests = new Map(); // id -> { resolve }
  let shuttingDown = false;

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

  const upsertTurnItem = (turn, item) => {
    if (!turn || !item) return;
    if (!Array.isArray(turn.items)) turn.items = [];
    const idx = turn.items.findIndex((existing) => existing.id === item.id);
    if (idx >= 0) turn.items[idx] = item;
    else turn.items.push(item);
  };

  const applyAndBroadcastNotification = (rawFrame) => {
    const frame = materialize(rawFrame);
    const method = frame.method;
    const params = frame.params || {};

    if (threadState) {
      if (method === "thread/status/changed" && params.status) {
        threadState.status = params.status;
      } else if (method === "turn/started" && params.turn) {
        const existing = threadState.turns.find((t) => t.id === params.turn.id);
        if (!existing) {
          threadState.turns.push({ ...params.turn, items: [], itemsView: "full" });
        }
      } else if ((method === "item/started" || method === "item/completed") && params.item && params.turnId) {
        const turn = threadState.turns.find((t) => t.id === params.turnId);
        if (turn) upsertTurnItem(turn, params.item);
      } else if (method === "item/agentMessage/delta" && params.turnId && params.itemId && typeof params.delta === "string") {
        const turn = threadState.turns.find((t) => t.id === params.turnId);
        const item = turn?.items?.find((i) => i.id === params.itemId);
        if (item) item.text = `${item.text || ""}${params.delta}`;
      } else if (method === "turn/completed" && params.turn) {
        const existing = threadState.turns.find((t) => t.id === params.turn.id);
        if (existing) {
          existing.status = params.turn.status;
          existing.error = params.turn.error ?? null;
          existing.completedAt = params.turn.completedAt ?? Math.floor(Date.now() / 1000);
          existing.durationMs = params.turn.durationMs ?? 10;
          if (Array.isArray(params.turn.items)) {
            for (const item of params.turn.items) upsertTurnItem(existing, item);
          }
        }
      }
    }

    broadcast(frame);
    return frame;
  };

  const runRecordedTurn = async (turn, turnNumber, turnId, promptText) => {
    const holdFile = controlDir ? join(controlDir, `hold-turn-${turnNumber}`) : "";
    const releaseFile = controlDir ? join(controlDir, `release-turn-${turnNumber}`) : "";
    const shouldHold = Boolean(holdFile && existsSync(holdFile));
    let holdApplied = false;
    let lastCommandItem = null;

    for (const step of turn.steps) {
      if (shuttingDown) return;
      if (step.kind === "notify") {
        for (const rawFrame of step.frames) {
          if (shuttingDown) return;
          const emitted = applyAndBroadcastNotification(rawFrame);
          if (emitted.method === "item/started" && emitted.params?.item?.type === "commandExecution") {
            lastCommandItem = emitted.params.item;
          }
          // Pause right after turn/started + userMessage so the daemon checkpoints provider_turn_id and observes responding state.
          if (shouldHold && !holdApplied && emitted.method === "item/completed" && emitted.params?.item?.type === "userMessage") {
            holdApplied = true;
            writeControl(`turn-${turnNumber}-held.json`, { turnNumber, turnId, at: Date.now() });
            await waitUntil(() => existsSync(releaseFile) || Boolean(activeInterruptWaiter?.interrupted));
            if (activeInterruptWaiter?.interrupted) return;
          }
        }
        continue;
      }

      if (step.kind === "await_interrupt") {
        writeControl(`turn-${turnNumber}-waiting-interrupt.json`, { turnNumber, turnId, at: Date.now() });
        await new Promise((resolveInterrupt) => {
          const waiter = { turnId, interrupted: false, responseResult: step.responseResult, resolve: resolveInterrupt };
          activeInterruptWaiter = waiter;
          void waitUntil(() => waiter.interrupted).then(() => {
            if (activeInterruptWaiter === waiter && !waiter.interrupted) {
              activeInterruptWaiter = null;
              resolveInterrupt();
            }
          });
        });
        continue;
      }

      if (step.kind === "server_request") {
        const reqFrame = materialize(step.frame);
        const liveId = nextServerReqId++;
        reqFrame.id = liveId;
        if (reqFrame.params && typeof reqFrame.params === "object") {
          reqFrame.params.cwd = process.cwd();
        }
        writeControl(`turn-${turnNumber}-waiting-approval.json`, {
          turnNumber,
          turnId,
          requestId: liveId,
          method: reqFrame.method,
          at: Date.now(),
        });
        const replyMsg = await new Promise((resolveReply) => {
          const entry = { done: false, resolve: resolveReply };
          pendingServerRequests.set(liveId, entry);
          broadcast(reqFrame);
          void waitUntil(() => entry.done).then(() => {
            if (!entry.done) {
              pendingServerRequests.delete(liveId);
              resolveReply({ timeout: true });
            }
          });
        });
        if (replyMsg.timeout || shuttingDown) return;
        const decision = replyMsg.result?.decision;
        const accepted = decision === "accept" || (decision && typeof decision === "object" && "acceptWithExecpolicyAmendment" in decision);
        writeControl(`turn-${turnNumber}-approval-decision.json`, {
          turnNumber,
          turnId,
          requestId: liveId,
          decision,
          accepted,
          at: Date.now(),
        });
        // Enforce native approval decision: only "accept" replays the recorded post-approval completion frames!
        if (!accepted) {
          applyAndBroadcastNotification({
            method: "serverRequest/resolved",
            params: { threadId: threadState.id, requestId: liveId },
            emittedAtMs: Date.now(),
          });
          if (lastCommandItem) {
            applyAndBroadcastNotification({
              method: "item/completed",
              params: {
                item: { ...lastCommandItem, status: "declined", exitCode: null },
                threadId: threadState.id,
                turnId,
                completedAtMs: Date.now(),
              },
              emittedAtMs: Date.now(),
            });
          }
          applyAndBroadcastNotification({
            method: "thread/status/changed",
            params: { threadId: threadState.id, status: { type: "idle" } },
            emittedAtMs: Date.now(),
          });
          applyAndBroadcastNotification({
            method: "turn/completed",
            params: {
              threadId: threadState.id,
              turn: {
                id: turnId,
                rootTurnId: turnId,
                items: [],
                itemsView: "summary",
                status: "failed",
                error: { message: "Command approval declined by host" },
                startedAt: Math.floor(Date.now() / 1000),
                completedAt: Math.floor(Date.now() / 1000),
                durationMs: 10,
              },
            },
            emittedAtMs: Date.now(),
          });
          return;
        }
        // Rewrite recorded serverRequest/resolved requestId to match liveId on next step.
        const nextIdx = turn.steps.indexOf(step) + 1;
        const nextStep = turn.steps[nextIdx];
        if (nextStep?.kind === "notify") {
          for (const f of nextStep.frames) {
            if (f.method === "serverRequest/resolved" && f.params) {
              f.params = { ...f.params, requestId: liveId };
            }
          }
        }
      }
    }

    // For kill-recover transcripts where daemon 1 was SIGKILLed before receiving turn/completed,
    // wait for release-turn-N (if held and not already waited) and materialize the recorded completed turn snapshot.
    if (!turn.hasTerminalNotification && turn.recoveredTurnSnapshot) {
      if (shouldHold && !holdApplied) {
        holdApplied = true;
        writeControl(`turn-${turnNumber}-held.json`, { turnNumber, turnId, at: Date.now() });
        await waitUntil(() => existsSync(releaseFile));
      }
      const snapshot = materialize(turn.recoveredTurnSnapshot);
      const existing = threadState?.turns?.find((t) => t.id === turnId);
      if (existing) {
        existing.status = snapshot.status || "completed";
        existing.items = Array.isArray(snapshot.items) ? snapshot.items : existing.items;
        existing.itemsView = "full";
        existing.completedAt = Math.floor(Date.now() / 1000);
        existing.durationMs = snapshot.durationMs ?? 20;
      }
      if (threadState) {
        threadState.status = { type: "idle" };
      }
      broadcast({
        method: "thread/status/changed",
        params: { threadId: threadState?.id, status: { type: "idle" } },
        emittedAtMs: Date.now(),
      });
      broadcast({
        method: "turn/completed",
        params: { threadId: threadState?.id, turn: snapshot },
        emittedAtMs: Date.now(),
      });
    }
    void promptText;
  };

  const httpServer = createServer((req, res) => {
    const pathname = (req.url || "/").split("?")[0];
    if (pathname === "/readyz" || pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("Upgrade Required");
  });
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));

    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }

      // Reply from client to a server-initiated request (e.g. item/commandExecution/requestApproval)
      if (msg.method === undefined && msg.id !== undefined) {
        const waiter = pendingServerRequests.get(msg.id);
        if (waiter) {
          pendingServerRequests.delete(msg.id);
          waiter.done = true;
          waiter.resolve(msg);
        }
        return;
      }

      const method = msg.method;
      const id = msg.id;
      const params = msg.params || {};
      const reply = (result) => {
        if (id !== undefined && ws.readyState === 1) ws.send(JSON.stringify({ id, result }));
      };
      const replyError = (code, message) => {
        if (id !== undefined && ws.readyState === 1) ws.send(JSON.stringify({ id, error: { code, message } }));
      };

      if (method === "initialized") return;

      if (method === "initialize") {
        const res = materialize(transcript.initializeResult);
        res.codexHome = process.env.CODEX_HOME || join(process.env.HOME || process.cwd(), ".codex");
        reply(res);
        for (const notif of transcript.postInitializeNotifications) {
          ws.send(JSON.stringify(materialize(notif)));
        }
        return;
      }

      if (method === "mcpServerStatus/list") {
        reply(materialize(transcript.mcpServerStatusResult || { data: [], nextCursor: null }));
        return;
      }

      if (method === "model/list") {
        reply({ data: [], nextCursor: null });
        return;
      }

      if (method === "thread/start") {
        const res = materialize(transcript.threadStartResult);
        const liveCwd = process.cwd();
        res.cwd = liveCwd;
        if (Array.isArray(res.runtimeWorkspaceRoots)) res.runtimeWorkspaceRoots = [liveCwd];
        if (res.thread) {
          res.thread.cwd = liveCwd;
          if (Array.isArray(res.thread.runtimeWorkspaceRoots)) res.thread.runtimeWorkspaceRoots = [liveCwd];
          if (Array.isArray(res.thread.environments)) {
            res.thread.environments = res.thread.environments.map((env) => ({
              ...env,
              cwd: liveCwd,
              runtimeWorkspaceRoots: [liveCwd],
            }));
          }
        }
        if (typeof params.permissions === "string" && params.permissions && res.activePermissionProfile) {
          res.activePermissionProfile = { ...res.activePermissionProfile, id: params.permissions };
        }
        threadState = res.thread;
        threadStartMeta = res;
        reply(res);
        for (const notif of transcript.postThreadStartNotifications) {
          const mat = materialize(notif);
          if (mat.method === "thread/started" && mat.params?.thread) {
            mat.params.thread = threadState;
          }
          ws.send(JSON.stringify(mat));
        }

        // Crash-loop fixture: exit unexpectedly right after startup reaches idle.
        if (transcript.turns.length === 0 && transcript.runtimeExit.requested === false) {
          const exitCode = transcript.runtimeExit.code ?? 1;
          setTimeout(() => {
            wss.close();
            httpServer.closeAllConnections?.();
            process.exit(exitCode);
          }, 200).unref();
        }
        return;
      }

      if (method === "thread/resume") {
        if (!threadState) {
          if (typeof params.threadId !== "string" || !params.threadId.trim()) {
            replyError(-32001, "Thread not found");
            return;
          }
          // A fresh Codex process restarted after a crash loads the persisted thread ID on thread/resume.
          placeholderBindings.set("<thread>", params.threadId.trim());
          const hydrated = materialize(transcript.threadStartResult);
          const liveCwd = process.cwd();
          hydrated.cwd = liveCwd;
          if (Array.isArray(hydrated.runtimeWorkspaceRoots)) hydrated.runtimeWorkspaceRoots = [liveCwd];
          if (hydrated.thread) {
            hydrated.thread.id = params.threadId.trim();
            hydrated.thread.sessionId = params.threadId.trim();
            hydrated.thread.cwd = liveCwd;
            if (Array.isArray(hydrated.thread.runtimeWorkspaceRoots)) hydrated.thread.runtimeWorkspaceRoots = [liveCwd];
            if (Array.isArray(hydrated.thread.environments)) {
              hydrated.thread.environments = hydrated.thread.environments.map((env) => ({
                ...env,
                cwd: liveCwd,
                runtimeWorkspaceRoots: [liveCwd],
              }));
            }
          }
          threadState = hydrated.thread;
          threadStartMeta = hydrated;
        }
        const base = transcript.threadResumeResult ? materialize(transcript.threadResumeResult) : { ...threadStartMeta };
        base.thread = { ...threadState };
        base.cwd = process.cwd();
        if (Array.isArray(base.runtimeWorkspaceRoots)) base.runtimeWorkspaceRoots = [process.cwd()];
        if (typeof params.permissions === "string" && params.permissions && base.activePermissionProfile) {
          base.activePermissionProfile = { ...base.activePermissionProfile, id: params.permissions };
        }
        reply(base);
        for (const notif of transcript.postThreadResumeNotifications) {
          ws.send(JSON.stringify(materialize(notif)));
        }
        if (transcript.turns.length === 0 && transcript.runtimeExit.requested === false) {
          const exitCode = transcript.runtimeExit.code ?? 1;
          setTimeout(() => {
            wss.close();
            httpServer.closeAllConnections?.();
            process.exit(exitCode);
          }, 200).unref();
        }
        return;
      }

      if (method === "thread/read") {
        if (!threadState) {
          replyError(-32001, "Thread not found");
          return;
        }
        const copy = {
          ...threadState,
          turns: params.includeTurns ? threadState.turns : [],
        };
        reply({ thread: copy });
        return;
      }

      if (method === "thread/turns/list") {
        if (!threadState) {
          replyError(-32001, "Thread not found");
          return;
        }
        const limit = typeof params.limit === "number" ? params.limit : 20;
        const turnsList = [...threadState.turns];
        if (params.sortDirection === "desc") turnsList.reverse();
        const slice = turnsList.slice(0, limit).map((t) => ({ ...t, itemsView: "full" }));
        reply({ data: slice, nextCursor: null, backwardsCursor: null });
        return;
      }

      if (method === "thread/loaded/list") {
        reply({ data: threadState ? [threadState.id] : [], nextCursor: null });
        return;
      }

      if (method === "mcpServer/resource/read") {
        reply(materialize(transcript.mcpResourceReadResult || { contents: [], originCallId: null }));
        return;
      }

      if (method === "turn/start") {
        if (!threadState) {
          replyError(-32001, "Thread not found");
          return;
        }
        if (nextTurnIndex >= transcript.turns.length) {
          writeControl(`unexpected-turn-${nextTurnIndex + 1}.json`, {
            turnIndex: nextTurnIndex + 1,
            availableTurns: transcript.turns.length,
            at: Date.now(),
          });
          replyError(
            -32000,
            `Unexpected Codex turn/start #${nextTurnIndex + 1}; transcript only recorded ${transcript.turns.length} turn(s).`,
          );
          return;
        }
        const turn = transcript.turns[nextTurnIndex];
        nextTurnIndex += 1;
        const startResult = materialize(turn.turnStartResult);
        const turnId = startResult.turn.id;
        const promptText = Array.isArray(params.input)
          ? params.input.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n")
          : "";
        writeControl(`turn-${turn.turnIndex}-started.json`, {
          turnNumber: turn.turnIndex,
          turnId,
          promptText,
          startedAt: Date.now(),
        });
        reply(startResult);
        void runRecordedTurn(turn, turn.turnIndex, turnId, promptText);
        return;
      }

      if (method === "turn/interrupt") {
        writeControl("turn-interrupted.json", {
          threadId: params.threadId ?? threadState?.id ?? null,
          turnId: params.turnId ?? null,
          at: Date.now(),
        });
        const waiter = activeInterruptWaiter;
        if (waiter) {
          waiter.interrupted = true;
          activeInterruptWaiter = null;
          reply(waiter.responseResult || {});
          waiter.resolve();
          return;
        }
        reply({});
        return;
      }

      reply({});
    });
  });

  function shutdownNow(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const ws of [...clients]) {
      try { ws.close(); } catch { /* ignore */ }
    }
    clients.clear();
    wss.close();
    httpServer.closeAllConnections?.();
    httpServer.close(() => process.exit(code));
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

  httpServer.listen(port, host);
}

await runServer();
