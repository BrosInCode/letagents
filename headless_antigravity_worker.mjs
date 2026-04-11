#!/usr/bin/env node
/**
 * Headless Antigravity worker — targets CURSOR_HANDOFF.md "Final Test".
 *
 * 1) Find a usable language_server target:
 *      - workspace `--enable_lsp --workspace_id ...` LS when the repo is already open
 *      - otherwise the legacy core LS (no --enable_lsp)
 * 2) For core LS: StartCascade → SignalExecutableIdle({ conversationId }) → SendUserCascadeMessage
 *    (items + embedded cascadeConfig / model) → SendAllQueuedMessages
 *    For workspace LS: StartCascade → SendUserCascadeMessage (Deck-style stream POST)
 * 3) (Optional, core-only) Connect reactive stream while queueing — see ANTIGRAVITY_STREAM_METHODS
 * 4) Poll GetCascadeTrajectorySteps until steps appear or timeout
 * 5) Print the last assistant-style reply on stdout (rest on stderr if verbose)
 *
 * Model / quota (important):
 *   Values like `MODEL_GOOGLE_GEMINI_2_5_FLASH` are **protobuf `Model` enum names**
 *   compiled into `language_server_macos_arm_bin` — they are **not** the friendly
 *   names shown in the Antigravity chat picker (e.g. “Gemini 3.1”). The UI label and
 *   the enum string are related only by whatever Google’s server maps them to.
 *   `ANTIGRAVITY_MODEL` is exactly that enum string on the wire (`GetModelResponse`,
 *   `SendAllQueuedMessages`, etc.). `MODEL_PLACEHOLDER_M26` can route to a different
 *   SKU than your UI selection, which is why you can see a **429 on one model** while
 *   another still has quota. Use `--list-models` when the API returns configs; if it
 *   returns `{}`, inspect traffic from the real UI or ask Antigravity release notes for
 *   the enum that matches your picker entry.
 *
 * Usage:
 *   node headless_antigravity_worker.mjs
 *   node headless_antigravity_worker.mjs "What is 2+2? Only output the number."
 *   node headless_antigravity_worker.mjs --verbose "..."
 *   ANTIGRAVITY_MODEL=MODEL_PLACEHOLDER_M26 node headless_antigravity_worker.mjs
 *   ANTIGRAVITY_MAX_POLLS=60 ANTIGRAVITY_POLL_MS=2000 node headless_antigravity_worker.mjs
 *   ANTIGRAVITY_WORKSPACE_URI=file:///path/to/repo node headless_antigravity_worker.mjs
 *
 * Flags:
 *   --verbose   Log polls and JSON snippets to stderr
 *   --json      Print full last steps payload JSON to stdout (no text extraction)
 *   --direct    Skip cascade chat; call GetModelResponse (works headless today).
 *               Premium / third-party models still need the cascade path + stream.
 *   --workspace-ls Force the repo/workspace `--enable_lsp` server when available.
 *   --core-ls   Force the legacy core LS path.
 *   --no-stream Same as default today (Deck path has no StreamCascadeReactiveUpdates wrapper).
 *   --legacy-stream Re-enable experimental Connect wrap + multi-method loop (old handoff path).
 *   --list-models  Print live model configs for the selected target; then exit.
 *   --list-cascades  Print GetAllCascadeTrajectories for the selected LS; then exit.
 *   --resolve-cascade  If ANTIGRAVITY_CASCADE_ID is unset, pick an active cascade from
 *               GetAllCascadeTrajectories (Antigravity-Deck + Antigravity-Link patterns).
 *   --scan-all-ls  With ANTIGRAVITY_CASCADE_ID and/or --resolve-cascade: probe every LS
 *               process (ranked: matching workspace first) until the cascade appears or one
 *               is active — fixes wrong-port / wrong-instance sends.
 *
 * Env (cascade reuse / discovery):
 *   ANTIGRAVITY_CASCADE_ID   If set, skip StartCascade and send/poll this conversation.
 *   ANTIGRAVITY_RESOLVE_CASCADE=1  Same as --resolve-cascade when no cascade id in env.
 *   ANTIGRAVITY_SCAN_ALL_LS=1      Same as --scan-all-ls (requires id and/or resolve).
 *
 * Cascade payload (Antigravity-Deck — github.com/tysonnbt/Antigravity-Deck `src/cascade.js`):
 *   `plannerTypeConfig.case: "conversational"`, `planModel`, `requestedModel: { modelId }`.
 *   `SendUserCascadeMessage` is issued as a server-streaming HTTP POST (read full body), not
 *   unary + `SendAllQueuedMessages` unless `ANTIGRAVITY_ALSO_SEND_ALL_QUEUED=1`.
 *   Polling uses `GetCascadeTrajectorySteps` with `startIndex`/`endIndex` when supported.
 *
 * Long runs + LetAgents MCP/API polling + handoff for follow-up agents:
 *   docs/AGENT_HANDOFF_LONG_RUNS_AND_HEADLESS.md
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED =
  process.env.NODE_TLS_REJECT_UNAUTHORIZED || "0";

import { execSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CORE_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.googleapis.com",
];

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8" });
}

function gitRepoRootOrEmpty() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Prefer git root so StartCascade matches an Antigravity workspace folder. */
function defaultWorkspaceUri() {
  const fromEnv = process.env.ANTIGRAVITY_WORKSPACE_URI?.trim();
  if (fromEnv) return fromEnv;
  const root = gitRepoRootOrEmpty();
  if (root) return `file://${root}`;
  const cwd = process.cwd();
  if (cwd.startsWith("/")) return `file://${cwd}`;
  return null;
}

function workspaceIdFromUri(workspaceUri) {
  if (!workspaceUri) return null;
  try {
    const url = new URL(workspaceUri);
    if (url.protocol !== "file:") return null;
    let fsPath = decodeURIComponent(url.pathname || "");
    if (/^\/[A-Za-z]:/.test(fsPath)) {
      fsPath = fsPath.slice(1);
    } else if (fsPath.startsWith("/")) {
      fsPath = fsPath.slice(1);
    }
    if (!fsPath) return null;
    return `file_${fsPath.replace(/:/g, "_3A").replace(/[\\/]/g, "_")}`;
  } catch {
    return null;
  }
}

function parseLanguageServerProcesses() {
  const out = sh("ps -axo pid=,command=");
  const found = [];
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    if (!line.includes("language_server_macos_arm_bin")) continue;
    const firstSpace = line.indexOf(" ");
    if (firstSpace === -1) continue;
    const pid = line.slice(0, firstSpace).trim();
    const cmd = line.slice(firstSpace + 1);
    const csrfMatch = cmd.match(/--csrf_token\s+([^\s]+)/);
    const workspaceIdMatch = cmd.match(/--workspace_id\s+([^\s]+)/);
    found.push({
      pid,
      cmd,
      csrf: csrfMatch ? csrfMatch[1] : null,
      workspaceId: workspaceIdMatch ? workspaceIdMatch[1] : null,
      isWorkspaceLsp: cmd.includes("--enable_lsp"),
    });
  }
  return found;
}

function findCoreProcess() {
  for (const proc of parseLanguageServerProcesses()) {
    if (proc.isWorkspaceLsp) continue;
    const hasEndpoint = CORE_ENDPOINTS.some((e) => proc.cmd.includes(e));
    if (!hasEndpoint) continue;
    return { pid: proc.pid, csrf: proc.csrf };
  }
  return null;
}

function findWorkspaceProcess(workspaceUri) {
  const wantedWorkspaceId = workspaceIdFromUri(workspaceUri);
  if (!wantedWorkspaceId) return null;
  for (const proc of parseLanguageServerProcesses()) {
    if (!proc.isWorkspaceLsp) continue;
    if (proc.workspaceId !== wantedWorkspaceId) continue;
    return {
      pid: proc.pid,
      csrf: proc.csrf,
      workspaceId: proc.workspaceId,
    };
  }
  return null;
}

function findListeningPorts(pid) {
  const out = sh(`lsof -Pan -p ${pid} -iTCP -sTCP:LISTEN`);
  const ports = [...out.matchAll(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/g)].map((m) =>
    Number(m[1]),
  );
  if (ports.length === 0) throw new Error(`No LISTEN ports for LS pid=${pid}`);
  return [...new Set(ports)].sort((a, b) => a - b);
}

function connectJsonHeaders(csrf) {
  return {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
    "x-codeium-csrf-token": csrf,
  };
}

async function unary(baseUrl, csrf, method, body) {
  const url = `${baseUrl}/exa.language_server_pb.LanguageServerService/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: connectJsonHeaders(csrf),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  return { status: res.status, text, parsed };
}

/**
 * Parse `GetAllCascadeTrajectories` JSON — shapes from Antigravity-Deck (`trajectorySummaries`
 * map) and Antigravity-Link (array aliases). Returns cascadeId → summary row.
 * @param {unknown} parsed
 * @returns {Map<string, { status: string, trajectoryId?: string, stepCount?: number, summary?: string }>}
 */
export function parseTrajectorySummaries(parsed) {
  const map = new Map();
  if (!parsed || typeof parsed !== "object") return map;
  const o = /** @type {Record<string, unknown>} */ (parsed);

  const ts = o.trajectorySummaries;
  if (ts && typeof ts === "object" && !Array.isArray(ts)) {
    for (const [cid, info] of Object.entries(ts)) {
      if (!info || typeof info !== "object") continue;
      const inf = /** @type {Record<string, unknown>} */ (info);
      map.set(cid, {
        status: String(inf.status ?? ""),
        trajectoryId:
          typeof inf.trajectoryId === "string" ? inf.trajectoryId : undefined,
        stepCount:
          typeof inf.stepCount === "number" ? inf.stepCount : undefined,
        summary: typeof inf.summary === "string" ? inf.summary : undefined,
      });
    }
    return map;
  }

  const arr = /** @type {unknown[]} */ (
    (Array.isArray(o.trajectories) && o.trajectories) ||
      (Array.isArray(o.cascade_trajectories) && o.cascade_trajectories) ||
      (Array.isArray(o.cascades) && o.cascades) ||
      []
  );
  for (const t of arr) {
    if (!t || typeof t !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (t);
    const cid = String(
      row.cascadeId ??
        row.cascade_id ??
        row.id ??
        row.trajectoryId ??
        "",
    ).trim();
    if (!cid) continue;
    map.set(cid, {
      status: String(row.status ?? row.state ?? ""),
      trajectoryId:
        typeof row.trajectoryId === "string" ? row.trajectoryId : undefined,
      stepCount:
        typeof row.stepCount === "number"
          ? row.stepCount
          : typeof row.numTotalSteps === "number"
            ? row.numTotalSteps
            : undefined,
      summary: typeof row.summary === "string" ? row.summary : undefined,
    });
  }
  return map;
}

/**
 * Prefer RUNNING / WAITING; else first key; else last key (Link-style fallback).
 * @param {Map<string, { status: string }>} map
 */
export function pickActiveCascadeIdFromMap(map) {
  const isActive = (s) => {
    const u = String(s).toUpperCase();
    return (
      u.includes("RUNNING") ||
      u.includes("WAITING") ||
      u === "CASCADE_RUN_STATUS_RUNNING" ||
      u === "CASCADE_RUN_STATUS_WAITING_FOR_USER"
    );
  };
  /** @type {string | null} */
  let firstKey = null;
  /** @type {string | null} */
  let lastKey = null;
  for (const [cid, info] of map) {
    if (!firstKey) firstKey = cid;
    lastKey = cid;
    if (isActive(info.status)) return cid;
  }
  return lastKey || firstKey || "";
}

/**
 * Rank LS processes (workspace matching URI first), probe each until we find `wantCascadeId`
 * in summaries or, if `wantCascadeId` is null, pick an active cascade on that instance.
 * @param {{ wantCascadeId: string | null, workspaceUri: string | null, log: (...a: unknown[]) => void }} opt
 * @returns {Promise<{ baseUrl: string, csrf: string, pid: string, kind: "workspace"|"core", cascadeId: string } | null>}
 */
async function resolveCascadeAcrossLsInstances(opt) {
  const { wantCascadeId, workspaceUri, log } = opt;
  const wantWsId = workspaceUri ? workspaceIdFromUri(workspaceUri) : null;
  const processes = parseLanguageServerProcesses().filter(
    (p) => p.csrf && CORE_ENDPOINTS.some((e) => p.cmd.includes(e)),
  );
  const ranked = processes
    .map((p) => {
      let score = 0;
      if (p.isWorkspaceLsp && wantWsId && p.workspaceId === wantWsId) {
        score += 100;
      } else if (p.isWorkspaceLsp) {
        score += 50;
      } else {
        score += 1;
      }
      return { p, score };
    })
    .sort((a, b) => b.score - a.score);

  for (const { p } of ranked) {
    let baseUrl;
    try {
      baseUrl = await findLsBaseUrl(p.pid, p.csrf, log);
    } catch (e) {
      log(
        `scan-all-ls: skip pid=${p.pid} (${e instanceof Error ? e.message : String(e)})`,
      );
      continue;
    }
    const tr = await unary(baseUrl, p.csrf, "GetAllCascadeTrajectories", {});
    if (tr.status !== 200 || tr.parsed == null) {
      log(`scan-all-ls: GetAllCascadeTrajectories pid=${p.pid} HTTP ${tr.status}`);
      continue;
    }
    const map = parseTrajectorySummaries(tr.parsed);
    if (wantCascadeId) {
      if (map.has(wantCascadeId)) {
        return {
          baseUrl,
          csrf: /** @type {string} */ (p.csrf),
          pid: p.pid,
          kind: p.isWorkspaceLsp ? "workspace" : "core",
          cascadeId: wantCascadeId,
        };
      }
      continue;
    }
    const picked = pickActiveCascadeIdFromMap(map);
    if (picked) {
      return {
        baseUrl,
        csrf: /** @type {string} */ (p.csrf),
        pid: p.pid,
        kind: p.isWorkspaceLsp ? "workspace" : "core",
        cascadeId: picked,
      };
    }
  }
  return null;
}

async function findLsBaseUrl(pid, csrf, log) {
  const ports = findListeningPorts(pid);
  for (const port of ports) {
    for (const baseUrl of [
      `http://127.0.0.1:${port}`,
      `https://127.0.0.1:${port}`,
    ]) {
      try {
        const probe = await fetch(
          `${baseUrl}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
          {
            method: "POST",
            headers: connectJsonHeaders(csrf),
            body: "{}",
            signal: AbortSignal.timeout(3000),
          },
        );
        if (probe.ok) {
          log?.(`Resolved LS api=${baseUrl}`);
          return baseUrl;
        }
      } catch {
        /* try next */
      }
    }
  }
  throw new Error(`Could not find working LanguageServerService port for pid=${pid}`);
}

/** Antigravity-Deck `src/cascade.js` — plannerConfig shape that triggers execution. */
function deckPlannerCascadeConfig(modelId) {
  return {
    plannerConfig: {
      plannerTypeConfig: {
        case: "conversational",
        value: {},
      },
      planModel: modelId,
      requestedModel: { modelId },
    },
  };
}

/**
 * Deck uses server-streaming `SendUserCascadeMessage`: POST JSON, read full HTTP body.
 * @returns {{ status: number, text: string }}
 */
async function sendUserCascadeMessageStream(baseUrl, csrf, body, log) {
  const url = `${baseUrl}/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: connectJsonHeaders(csrf),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  log?.(
    `SendUserCascadeMessage(stream): HTTP ${res.status} responseBytes=${text.length}`,
  );
  return { status: res.status, text };
}

function connectEncodeJsonMessage(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function decodeConnectFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const flags = buf.readUInt8(offset);
    const len = buf.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + len;
    if (end > buf.length) break;
    frames.push({ flags, payload: buf.slice(start, end) });
    offset = end;
  }
  return { frames, consumed: offset, rest: buf.subarray(offset) };
}

/**
 * Keep a Connect server-stream open while `work()` runs (UI-style subscriber).
 * `work` should include polling for results while the stream stays connected.
 */
async function withOpenConnectStream(
  baseUrl,
  csrf,
  method,
  requestObj,
  work,
  timeoutMs,
  tailMs,
  log,
) {
  const url = `${baseUrl}/exa.language_server_pb.LanguageServerService/${method}`;
  const body = connectEncodeJsonMessage(requestObj);
  const ac = new AbortController();
  const hardStop = setTimeout(() => ac.abort(), timeoutMs);
  const collected = [];
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/connect+json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": csrf,
      },
      body,
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      return { status: res.status, error: "no body", collected, workResult: null };
    }
    let buf = Buffer.alloc(0);
    const reader = res.body.getReader();
    let readErr = null;
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength) {
            buf = Buffer.concat([buf, Buffer.from(value)]);
            const { frames, rest } = decodeConnectFrames(buf);
            buf = Buffer.from(rest);
            for (const f of frames) {
              const s = f.payload.toString("utf8");
              try {
                collected.push({ flags: f.flags, json: JSON.parse(s) });
              } catch {
                collected.push({ flags: f.flags, raw: s.slice(0, 500) });
              }
            }
          }
        }
      } catch (e) {
        readErr = String(e);
      }
    })();

    const workResult = await work();
    await new Promise((r) => setTimeout(r, tailMs));
    ac.abort();
    await pump.catch(() => {});
    log?.(
      `Connect stream ${method}: frames=${collected.length} readErr=${readErr ?? "none"}`,
    );
    return { status: res.status, collected, workResult, readErr };
  } catch (err) {
    return { error: String(err), collected, workResult: null };
  } finally {
    clearTimeout(hardStop);
  }
}

async function waitForCascadeIdle(baseUrl, csrf, cascadeId, maxMs, log) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const t = await unary(baseUrl, csrf, "GetCascadeTrajectory", { cascadeId });
    if (t.parsed?.status === "CASCADE_RUN_STATUS_IDLE") return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  log?.("waitForCascadeIdle: timeout");
  return false;
}

async function sendAllQueuedWithRetry(baseUrl, csrf, cascadeId, modelId, log) {
  const body = {
    cascadeId,
    cascadeConfig: deckPlannerCascadeConfig(modelId),
  };
  for (let attempt = 1; attempt <= 5; attempt++) {
    const flush = await unary(baseUrl, csrf, "SendAllQueuedMessages", body);
    if (flush.status === 200) {
      log?.(`SendAllQueuedMessages: ok (attempt ${attempt})`);
      return true;
    }
    log?.("SendAllQueuedMessages:", flush.status, flush.parsed || flush.text);
    const msg = flush.parsed?.message || flush.text || "";
    const notIdle = /not idle|cascade not idle/i.test(msg);
    if (notIdle) {
      log?.(`SendAllQueuedMessages: not idle, waiting then retry (${attempt}/5)…`);
      await waitForCascadeIdle(baseUrl, csrf, cascadeId, 20_000, log);
      continue;
    }
    return false;
  }
  return false;
}

/** @param {unknown} step */
function extractFromStepObject(step) {
  if (!step || typeof step !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (step);

  const pr =
    o.plannerResponse ?? o.planner_response;
  if (pr && typeof pr === "object") {
    const p = /** @type {Record<string, unknown>} */ (pr);
    const t =
      (typeof p.modifiedResponse === "string" && p.modifiedResponse) ||
      (typeof p.modified_response === "string" && p.modified_response) ||
      (typeof p.response === "string" && p.response);
    if (t && String(t).trim()) return String(t).trim();
  }

  const fin = o.finish;
  if (fin && typeof fin === "object") {
    const f = /** @type {Record<string, unknown>} */ (fin);
    const os =
      (typeof f.outputString === "string" && f.outputString) ||
      (typeof f.output_string === "string" && f.output_string);
    if (os && String(os).trim()) return String(os).trim();
  }

  const ep = o.ephemeralMessage ?? o.ephemeral_message;
  if (ep && typeof ep === "object") {
    const e = /** @type {Record<string, unknown>} */ (ep);
    if (typeof e.content === "string" && e.content.trim()) return e.content.trim();
  }

  return null;
}

/**
 * Walk gemini_coder.Step list including nested subtrajectory.steps.
 * @param {unknown[]} steps
 * @param {(s: unknown) => void} visit
 */
function walkStepsDeep(steps, visit) {
  if (!Array.isArray(steps)) return;
  for (const s of steps) {
    visit(s);
    if (!s || typeof s !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (s);
    const sub = o.subtrajectory ?? o.subTrajectory;
    if (sub && typeof sub === "object") {
      const t = /** @type {Record<string, unknown>} */ (sub);
      const inner = t.steps;
      if (Array.isArray(inner)) walkStepsDeep(inner, visit);
    }
  }
}

/**
 * Last non-empty assistant-like string wins (matches UI reading order).
 * @param {unknown} stepsPayload — GetCascadeTrajectoryStepsResponse
 */
export function extractAssistantReply(stepsPayload) {
  const parsed =
    stepsPayload &&
    typeof stepsPayload === "object" &&
    /** @type {Record<string, unknown>} */ (stepsPayload).steps;
  const steps = Array.isArray(parsed) ? parsed : [];
  let last = null;
  walkStepsDeep(steps, (s) => {
    const t = extractFromStepObject(s);
    if (t) last = t;
  });
  return last;
}

function parseArgs(argv) {
  const rest = [];
  let verbose = false;
  let jsonOut = false;
  let direct = false;
  let listModels = false;
  let noStream = false;
  let legacyStream = false;
  let targetMode = null;
  let listCascades = false;
  let resolveCascade = false;
  let scanAllLs = false;
  for (const a of argv) {
    if (a === "--verbose" || a === "-v") verbose = true;
    else if (a === "--json") jsonOut = true;
    else if (a === "--direct") direct = true;
    else if (a === "--list-models") listModels = true;
    else if (a === "--list-cascades") listCascades = true;
    else if (a === "--resolve-cascade") resolveCascade = true;
    else if (a === "--scan-all-ls") scanAllLs = true;
    else if (a === "--workspace-ls") targetMode = "workspace";
    else if (a === "--core-ls") targetMode = "core";
    else if (a === "--auto-ls") targetMode = "auto";
    else if (a === "--no-stream") noStream = true;
    else if (a === "--legacy-stream") legacyStream = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        `Usage: node headless_antigravity_worker.mjs [options] [prompt...]\n` +
          `  --list-cascades  --resolve-cascade  --scan-all-ls  (see file header)`,
      );
      process.exit(0);
    } else rest.push(a);
  }
  return {
    verbose,
    jsonOut,
    direct,
    listModels,
    listCascades,
    resolveCascade,
    scanAllLs,
    noStream,
    legacyStream,
    targetMode,
    prompt: rest.join(" ").trim(),
  };
}

function normalizeTargetMode(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "workspace" || v === "core" || v === "auto") return v;
  return "auto";
}

async function pickWorkspaceModel(baseUrl, csrf, log) {
  const r = await unary(baseUrl, csrf, "GetCascadeModelConfigData", {});
  const configs = Array.isArray(r.parsed?.clientModelConfigs)
    ? r.parsed.clientModelConfigs
    : [];
  const defaultModel = r.parsed?.defaultOverrideModelConfig?.modelOrAlias?.model;
  if (typeof defaultModel === "string" && defaultModel) {
    log(`Using workspace default model=${defaultModel}`);
    return defaultModel;
  }
  const withQuota = configs.filter(
    (cfg) =>
      typeof cfg?.modelOrAlias?.model === "string" &&
      (cfg?.quotaInfo?.remainingFraction ?? 0) > 0,
  );
  const recommended = withQuota.find((cfg) => cfg?.isRecommended);
  const picked =
    recommended?.modelOrAlias?.model ||
    withQuota[0]?.modelOrAlias?.model ||
    "MODEL_PLACEHOLDER_M47";
  log(`Using workspace fallback model=${picked}`);
  return picked;
}

function streamMethodsFromEnv() {
  const raw =
    process.env.ANTIGRAVITY_STREAM_METHODS?.trim() ||
    process.env.ANTIGRAVITY_STREAM_METHOD?.trim();
  if (raw) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [
    "StreamCascadeSummariesReactiveUpdates",
    "StreamCascadeReactiveUpdates",
    "StreamUserTrajectoryReactiveUpdates",
  ];
}

/**
 * Poll trajectory steps until assistant text, json-out, or idle/timeout.
 * @returns {{ reply: string | null, lastPayload: unknown, jsonEarly: unknown | null }}
 */
async function cascadePollUntilReply(
  baseUrl,
  csrf,
  cascadeId,
  maxPolls,
  delayMs,
  jsonOut,
  log,
) {
  let lastPayload = null;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const trajPre = await unary(baseUrl, csrf, "GetCascadeTrajectory", {
      cascadeId,
    });
    const numTotal = trajPre.parsed?.numTotalSteps ?? 0;
    let steps = await unary(baseUrl, csrf, "GetCascadeTrajectorySteps", {
      cascadeId,
      startIndex: 0,
      endIndex: Math.max(numTotal, 1),
    });
    if (steps.status !== 200 || steps.parsed == null) {
      steps = await unary(baseUrl, csrf, "GetCascadeTrajectorySteps", {
        cascadeId,
        stepOffset: 0,
      });
    }
    const n = steps.parsed?.steps?.length ?? 0;
    const traj = trajPre;
    const status = traj.parsed?.status;
    const numTotalSteps = traj.parsed?.numTotalSteps;

    log(
      `poll ${i + 1}/${maxPolls}: steps=${n} status=${status} numTotalSteps=${numTotalSteps ?? "?"}`,
    );

    if (steps.parsed) lastPayload = steps.parsed;

    if (jsonOut && n > 0) {
      return { reply: null, lastPayload, jsonEarly: steps.parsed };
    }

    const reply = extractAssistantReply(steps.parsed);
    if (reply) {
      return { reply, lastPayload, jsonEarly: null };
    }

    if (n === 0 && status === "CASCADE_RUN_STATUS_IDLE" && i > 3) {
      log("Trajectory idle with no steps; stopping early.");
      break;
    }
  }
  return { reply: null, lastPayload, jsonEarly: null };
}

async function main() {
  const {
    verbose,
    jsonOut,
    direct,
    listModels,
    listCascades,
    resolveCascade: resolveCascadeCli,
    scanAllLs: scanAllLsCli,
    noStream,
    legacyStream,
    targetMode: argTargetMode,
    prompt: promptArg,
  } = parseArgs(process.argv.slice(2));

  const resolveCascade =
    resolveCascadeCli ||
    process.env.ANTIGRAVITY_RESOLVE_CASCADE === "1" ||
    process.env.ANTIGRAVITY_RESOLVE_CASCADE === "true";
  const scanAllLsEnv =
    process.env.ANTIGRAVITY_SCAN_ALL_LS === "1" ||
    process.env.ANTIGRAVITY_SCAN_ALL_LS === "true";
  const scanAllLs = scanAllLsCli || scanAllLsEnv;

  const legacyReactive =
    legacyStream ||
    process.env.ANTIGRAVITY_USE_LEGACY_REACTIVE_STREAM === "1" ||
    process.env.ANTIGRAVITY_USE_LEGACY_REACTIVE_STREAM === "true";
  const prompt =
    promptArg || "What is 2+2? Only output the number.";

  const log = verbose ? (...a) => console.error(...a) : () => {};
  const workspaceUri = defaultWorkspaceUri();
  const envTargetMode = normalizeTargetMode(process.env.ANTIGRAVITY_TARGET);
  const requestedTargetMode = normalizeTargetMode(argTargetMode || envTargetMode);
  const effectiveTargetMode =
    direct && requestedTargetMode === "auto" ? "core" : requestedTargetMode;

  let targetKind = "core";
  let targetProcess = null;
  if (effectiveTargetMode !== "core" && workspaceUri) {
    const workspaceProc = findWorkspaceProcess(workspaceUri);
    if (workspaceProc?.csrf) {
      targetKind = "workspace";
      targetProcess = workspaceProc;
    } else if (effectiveTargetMode === "workspace") {
      throw new Error(
        `Workspace LS not found for ${workspaceUri}. Open the repo in Antigravity first, or rerun with --core-ls.`,
      );
    }
  }
  if (!targetProcess) {
    const core = findCoreProcess();
    if (!core?.csrf) {
      throw new Error(
        "Core LS not found. Start Antigravity and ensure a language_server_macos_arm_bin process exists without --enable_lsp.",
      );
    }
    targetProcess = core;
  }

  let baseUrl = await findLsBaseUrl(targetProcess.pid, targetProcess.csrf, log);
  log(
    `Using ${targetKind} LS pid=${targetProcess.pid} ${baseUrl}` +
      (workspaceUri ? ` workspaceUri=${workspaceUri}` : ""),
  );

  if (listCascades) {
    const r = await unary(
      baseUrl,
      targetProcess.csrf,
      "GetAllCascadeTrajectories",
      {},
    );
    if (r.status !== 200) {
      throw new Error(`GetAllCascadeTrajectories: HTTP ${r.status} ${r.text.slice(0, 400)}`);
    }
    const map = parseTrajectorySummaries(r.parsed);
    console.log(
      JSON.stringify(
        {
          raw: r.parsed,
          parsedSummaries: Object.fromEntries(map),
          pickedActive: pickActiveCascadeIdFromMap(map) || null,
        },
        null,
        2,
      ),
    );
    return;
  }

  /**
   * `--direct` keeps the core-LS shortcut default. Workspace LS chooses its live UI
   * default model when possible so we don't hard-code stale placeholders.
   */
  const modelId =
    process.env.ANTIGRAVITY_MODEL ||
    (direct
      ? "MODEL_GOOGLE_GEMINI_2_5_FLASH"
      : targetKind === "workspace"
        ? await pickWorkspaceModel(baseUrl, targetProcess.csrf, log)
        : "MODEL_CLAUDE_4_OPUS");

  if (listModels) {
    const method =
      targetKind === "workspace"
        ? "GetCascadeModelConfigData"
        : "GetCascadeModelConfigs";
    const r = await unary(baseUrl, targetProcess.csrf, method, {});
    if (r.status !== 200) {
      throw new Error(`${method}: ${r.status} ${r.text}`);
    }
    const empty =
      !r.parsed ||
      (typeof r.parsed === "object" &&
        Object.keys(/** @type {object} */ (r.parsed)).length === 0);
    if (empty) {
      console.error(
        `${method} returned an empty object (no \`clientModelConfigs\` in this session).`,
      );
      console.error(
        "For `--direct`, unset ANTIGRAVITY_MODEL to use the script default (a `MODEL_GOOGLE_GEMINI_*` enum from the LS binary), or set ANTIGRAVITY_MODEL yourself.",
      );
    }
    console.log(JSON.stringify(r.parsed, null, 2));
    return;
  }

  if (direct) {
    const r = await unary(baseUrl, targetProcess.csrf, "GetModelResponse", {
      prompt,
      model: modelId,
    });
    if (r.status !== 200 || !r.parsed?.response) {
      throw new Error(
        `GetModelResponse: ${r.status} ${r.text}\n` +
          `Hint: set ANTIGRAVITY_MODEL to a Gemini enum from \`node headless_antigravity_worker.mjs --list-models\` (UI model choice alone does not change this flag).`,
      );
    }
    if (jsonOut) {
      console.log(JSON.stringify(r.parsed, null, 2));
    } else {
      console.log(String(r.parsed.response).trim());
    }
    return;
  }

  const maxPolls = Number(process.env.ANTIGRAVITY_MAX_POLLS || 40);
  const delayMs = Number(process.env.ANTIGRAVITY_POLL_MS || 1500);
  const startBody = workspaceUri ? { workspaceUris: [workspaceUri] } : {};
  if (workspaceUri) log(`StartCascade workspaceUris=[${workspaceUri}]`);

  /** Reuse existing IDE cascade when set or resolved (skip StartCascade). */
  let reuseCascadeId = process.env.ANTIGRAVITY_CASCADE_ID?.trim() || null;

  if (scanAllLs) {
    if (!reuseCascadeId && !resolveCascade) {
      throw new Error(
        "--scan-all-ls / ANTIGRAVITY_SCAN_ALL_LS requires ANTIGRAVITY_CASCADE_ID and/or --resolve-cascade (or ANTIGRAVITY_RESOLVE_CASCADE=1).",
      );
    }
    const resolved = await resolveCascadeAcrossLsInstances({
      wantCascadeId: reuseCascadeId,
      workspaceUri,
      log,
    });
    if (!resolved) {
      throw new Error(
        "scan-all-ls: no language server instance reported this cascade / no active trajectory.",
      );
    }
    baseUrl = resolved.baseUrl;
    targetProcess = { pid: resolved.pid, csrf: resolved.csrf };
    targetKind = resolved.kind;
    if (!reuseCascadeId) reuseCascadeId = resolved.cascadeId;
    log(
      `scan-all-ls: using ${targetKind} pid=${resolved.pid} cascadeId=${reuseCascadeId} ${baseUrl}`,
    );
  } else if (resolveCascade && !reuseCascadeId) {
    const tr = await unary(
      baseUrl,
      targetProcess.csrf,
      "GetAllCascadeTrajectories",
      {},
    );
    if (tr.status !== 200 || tr.parsed == null) {
      throw new Error(
        `GetAllCascadeTrajectories: HTTP ${tr.status} ${tr.text.slice(0, 400)}`,
      );
    }
    const map = parseTrajectorySummaries(tr.parsed);
    reuseCascadeId = pickActiveCascadeIdFromMap(map) || null;
    if (!reuseCascadeId) {
      throw new Error(
        "resolve-cascade: no trajectories returned (empty map). Open a chat or set ANTIGRAVITY_CASCADE_ID.",
      );
    }
    log(`resolve-cascade: picked cascadeId=${reuseCascadeId}`);
  }

  const streamFallback =
    process.env.ANTIGRAVITY_STREAM_FALLBACK_NO_STREAM === "1" ||
    process.env.ANTIGRAVITY_STREAM_FALLBACK_NO_STREAM === "true";

  /**
   * @param {string | null} streamMethod — Connect RPC name, or null for no stream
   * @param {string | null} existingCascadeId — when set, skip StartCascade (reuse conversation)
   */
  async function runOneCascade(streamMethod, existingCascadeId) {
    let cascadeId;
    if (existingCascadeId) {
      cascadeId = existingCascadeId;
      log(
        `cascadeId=${cascadeId} (reuse; no StartCascade)` +
          (streamMethod ? ` reactiveStream=${streamMethod}` : " (no reactive stream)"),
      );
    } else {
      const started = await unary(
        baseUrl,
        targetProcess.csrf,
        "StartCascade",
        startBody,
      );
      if (!started.parsed?.cascadeId) {
        throw new Error(`StartCascade failed: ${started.status} ${started.text}`);
      }
      cascadeId = started.parsed.cascadeId;
      log(
        `cascadeId=${cascadeId}` +
          (streamMethod ? ` reactiveStream=${streamMethod}` : " (no reactive stream)"),
      );
    }

    const sendFlushAndPoll = async () => {
      /** @see https://github.com/tysonnbt/Antigravity-Deck/blob/main/src/cascade.js */
      const deckBody = {
        metadata: {},
        cascadeId,
        items: [{ text: prompt }],
        cascadeConfig: deckPlannerCascadeConfig(modelId),
        clientType: "CHAT_CLIENT_REQUEST_STREAM_CLIENT_TYPE_IDE",
        messageOrigin: "AGENT_MESSAGE_ORIGIN_IDE",
      };

      if (targetKind === "core") {
        const skipSig =
          process.env.ANTIGRAVITY_SKIP_SIGNAL_EXECUTABLE === "1" ||
          process.env.ANTIGRAVITY_SKIP_SIGNAL_EXECUTABLE === "true";
        if (!skipSig) {
          const sig = await unary(baseUrl, targetProcess.csrf, "SignalExecutableIdle", {
            conversationId: cascadeId,
          });
          log(
            `SignalExecutableIdle: HTTP ${sig.status} ${sig.parsed != null ? JSON.stringify(sig.parsed) : sig.text.slice(0, 240)}`,
          );
        }
      }

      const sur = await sendUserCascadeMessageStream(
        baseUrl,
        targetProcess.csrf,
        deckBody,
        log,
      );
      if (sur.status !== 200) {
        throw new Error(
          `SendUserCascadeMessage(stream): HTTP ${sur.status} ${sur.text.slice(0, 600)}`,
        );
      }

      const alsoFlush =
        process.env.ANTIGRAVITY_ALSO_SEND_ALL_QUEUED === "1" ||
        process.env.ANTIGRAVITY_ALSO_SEND_ALL_QUEUED === "true";
      if (targetKind === "core" && alsoFlush) {
        const flushed = await sendAllQueuedWithRetry(
          baseUrl,
          targetProcess.csrf,
          cascadeId,
          modelId,
          log,
        );
        if (!flushed) {
          throw new Error(
            "SendAllQueuedMessages never succeeded after retries; see stderr.",
          );
        }
      }

      return cascadePollUntilReply(
        baseUrl,
        targetProcess.csrf,
        cascadeId,
        maxPolls,
        delayMs,
        jsonOut,
        log,
      );
    };

    const skipLegacyStream =
      targetKind !== "core" || !streamMethod || noStream || !legacyReactive;
    if (skipLegacyStream) {
      return { ...(await sendFlushAndPoll()), streamError: null };
    }

    const subscriberId = `headless-${crypto.randomUUID().slice(0, 8)}`;
    const streamReq = { protocolVersion: 1, id: cascadeId, subscriberId };
    const streamTimeout = Number(
      process.env.ANTIGRAVITY_STREAM_TIMEOUT_MS || 240_000,
    );
    const tailMs = Number(process.env.ANTIGRAVITY_STREAM_TAIL_MS || 4000);

    const out = await withOpenConnectStream(
      baseUrl,
      targetProcess.csrf,
      streamMethod,
      streamReq,
      sendFlushAndPoll,
      streamTimeout,
      tailMs,
      log,
    );

    if (out.error) {
      return {
        reply: null,
        lastPayload: null,
        jsonEarly: null,
        streamError: out.error,
      };
    }
    if (out.status !== 200) {
      log(`Connect stream HTTP ${out.status} (${streamMethod})`);
    }
    const wr = out.workResult;
    if (!wr || typeof wr !== "object") {
      return {
        reply: null,
        lastPayload: null,
        jsonEarly: null,
        streamError: "stream work returned no result",
      };
    }
    return { ...wr, streamError: null };
  }

  function finishCascadeAttempt(pollResult) {
    if (pollResult.jsonEarly) {
      console.log(JSON.stringify(pollResult.jsonEarly, null, 2));
      return true;
    }
    if (pollResult.reply) {
      console.log(pollResult.reply);
      return true;
    }
    return false;
  }

  if (targetKind === "core" && legacyReactive && !noStream) {
    const methods = streamMethodsFromEnv();
    for (const method of methods) {
      log(`--- cascade + reactive stream: ${method} ---`);
      let pollResult;
      try {
        pollResult = await runOneCascade(method, reuseCascadeId);
      } catch (e) {
        log(e instanceof Error ? e.message : String(e));
        continue;
      }
      if (pollResult.streamError) {
        log(`stream skipped: ${pollResult.streamError}`);
        continue;
      }
      if (finishCascadeAttempt(pollResult)) return;
    }
    if (streamFallback) {
      log("--- fallback: cascade without reactive stream ---");
    } else {
      console.error(
        "No assistant reply after legacy reactive stream attempts. Retry without `--legacy-stream`, " +
          "or set ANTIGRAVITY_STREAM_FALLBACK_NO_STREAM=1.",
      );
      process.exit(1);
    }
  }

  let pollResult;
  try {
    pollResult = await runOneCascade(null, reuseCascadeId);
  } catch (e) {
    throw e;
  }
  if (pollResult.streamError) {
    throw new Error(pollResult.streamError);
  }
  if (finishCascadeAttempt(pollResult)) return;

  if (jsonOut && pollResult.lastPayload) {
    console.log(JSON.stringify(pollResult.lastPayload, null, 2));
    process.exit(1);
  }

  const fallback = extractAssistantReply(pollResult.lastPayload);
  if (fallback) {
    console.log(fallback);
    return;
  }

  console.error("Timeout: no assistant text found in trajectory steps.");
  if (verbose && pollResult.lastPayload) {
    console.error(JSON.stringify(pollResult.lastPayload, null, 2));
  }
  process.exit(1);
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
