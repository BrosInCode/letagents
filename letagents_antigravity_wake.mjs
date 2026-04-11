#!/usr/bin/env node
/**
 * Long-poll LetAgents room messages and run `headless_antigravity_worker.mjs` when a
 * trigger line appears. This is the minimal "wake from letagents.chat" loop for local
 * testing (runs on your Mac, not inside MCP).
 *
 * Prerequisites:
 *   - LETAGENTS_TOKEN from device flow (AGENTS.md); repo room also needs GitHub access on that token.
 *   - Antigravity core LS running (same as headless worker).
 *
 * Env:
 *   LETAGENTS_API_URL   default https://letagents.chat
 *   LETAGENTS_TOKEN     required (Bearer)
 *   LETAGENTS_ROOM      e.g. github.com/EmmyMay/letagents
 *   LETAGENTS_WAKE_PREFIX  default AG_WAKE:
 *   LETAGENTS_REPLY_SENDER default antigravity-worker
 *   ANTIGRAVITY_WORKER_FLAGS  optional extra argv for worker (default: none = cascade + reactive stream).
 *   LETAGRAVITY_WORKER_FLAGS  legacy alias for the same. Use `--direct` only for unary smoke tests.
 *
 * Usage:
 *   LETAGENTS_TOKEN=... LETAGENTS_ROOM=github.com/you/repo node letagents_antigravity_wake.mjs
 *
 * In the web room, send a line like:
 *   AG_WAKE: What is 2+2? Reply with the digit only.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

function encodeRoomIdPath(roomId) {
  return roomId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function getEnv(name, fallback = "") {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

const API_URL = getEnv("LETAGENTS_API_URL", "https://letagents.chat").replace(/\/+$/, "");
const TOKEN = getEnv("LETAGENTS_TOKEN");
const ROOM = getEnv("LETAGENTS_ROOM");
const PREFIX = getEnv("LETAGENTS_WAKE_PREFIX", "AG_WAKE:");
const REPLY_SENDER = getEnv("LETAGENTS_REPLY_SENDER", "antigravity-worker");
const EXTRA_FLAGS = getEnv(
  "ANTIGRAVITY_WORKER_FLAGS",
  getEnv("LETAGRAVITY_WORKER_FLAGS", ""),
)
  .split(/\s+/)
  .filter(Boolean);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, "headless_antigravity_worker.mjs");

async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
      ...init.headers,
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    throw new Error(`${init.method || "GET"} ${url} -> ${res.status} ${text.slice(0, 500)}`);
  }
  return data;
}

/** Walk pages until we have a cursor at the newest message (avoids replaying old wakes). */
async function syncCursorToTip(roomPath) {
  let after;
  let lastId;
  for (;;) {
    const qs = new URLSearchParams({ limit: "500" });
    if (after) qs.set("after", after);
    const data = await fetchJson(`${API_URL}/rooms/${roomPath}/messages?${qs}`);
    const messages = data.messages ?? [];
    if (messages.length === 0) break;
    lastId = messages[messages.length - 1].id;
    if (!data.has_more) break;
    after = lastId;
  }
  return lastId;
}

function runWorker(prompt) {
  return new Promise((resolve, reject) => {
    const args = [WORKER, ...EXTRA_FLAGS, prompt];
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c) => {
      out += c.toString();
    });
    child.stderr?.on("data", (c) => {
      err += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`worker exit ${code}\n${err || out}`));
    });
  });
}

async function postMessage(roomPath, text) {
  await fetchJson(`${API_URL}/rooms/${roomPath}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: REPLY_SENDER, text }),
  });
}

async function main() {
  if (!TOKEN) {
    console.error("Missing LETAGENTS_TOKEN (mint via device flow; see AGENTS.md).");
    process.exit(1);
  }
  if (!ROOM) {
    console.error("Missing LETAGENTS_ROOM (e.g. github.com/EmmyMay/letagents).");
    process.exit(1);
  }

  const roomPath = encodeRoomIdPath(ROOM);
  console.error(`[wake] API=${API_URL} room=${ROOM}`);
  console.error(`[wake] syncing cursor to latest message…`);
  let cursor = await syncCursorToTip(roomPath);
  console.error(`[wake] cursor=${cursor ?? "(none)"} prefix=${JSON.stringify(PREFIX)} worker_flags=${EXTRA_FLAGS.join(" ")}`);

  for (;;) {
    const qs = new URLSearchParams({ timeout: "55000", limit: "50" });
    if (cursor) qs.set("after", cursor);
    const data = await fetchJson(`${API_URL}/rooms/${roomPath}/messages/poll?${qs}`);
    const messages = data.messages ?? [];
    if (messages.length === 0) continue;

    for (const m of messages) {
      cursor = m.id;
      if (m.sender === REPLY_SENDER) continue;
      if (!m.text?.startsWith(PREFIX)) continue;
      const prompt = m.text.slice(PREFIX.length).trim();
      if (!prompt) continue;
      console.error(`[wake] from=${m.sender} prompt=${JSON.stringify(prompt.slice(0, 120))}…`);
      try {
        const reply = await runWorker(prompt);
        const body = reply || "(empty worker stdout)";
        await postMessage(roomPath, body);
        console.error(`[wake] posted reply (${body.length} chars)`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[wake] error: ${msg}`);
        try {
          await postMessage(roomPath, `[wake error] ${msg.slice(0, 2000)}`);
        } catch (postErr) {
          console.error(postErr);
        }
      }
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
