// Measures how fast real Claude Code and Codex agents start and answer,
// through the real LetAgents adapters, against the stand-in room server that
// record-codex-replay.ts uses. It is a manual developer tool: it spends real
// model turns, CI never runs it, and it starts no desktop app and no daemon.
//
// It reports the provider side of the phases in daemon/turn-start-latency.ts:
// - launch: `process` up to the provider's native ready signal, and
//   `bootstrap` after it (Claude's bootstrap model turn); fresh and resumed.
// - each turn: `provider_start` (call -> exact turn id), `first_output`
//   (turn id -> the first event the live display shows) and `turn_end`.
//   The first turn after a launch is the cold one.
//
//   LETAGENTS_MEASURE_LIVE_PROVIDERS=1 node --import tsx \
//     electron/scripts/measure-provider-start-latency.mjs --provider codex --turns 3
//
// The Codex adapter keeps its agents' home below HOME/.letagents. Run Codex
// with HOME set to a scratch folder that has your ~/.codex/auth.json linked
// in, so the agent home of your own desktop app is not touched. Claude Code
// finds its sign-in through your real HOME and writes only its usual session
// files there.
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { CodexProviderAdapter } from "../main/agents/codex-provider-adapter.ts";
import { ClaudeCodeProviderAdapter } from "../main/agents/claude-code-provider-adapter.ts";
import { resolveCodexExecutable } from "../main/agents/codex-executable.ts";
import { ProviderLiveDisplay } from "../../daemon/provider-live-display.ts";
import { sanitizeDaemonActivityEvent } from "../../daemon/credential-redaction.ts";
import { isHumanRoomActivityEvent } from "../../daemon/provider-stream-policy.ts";
import { firstOutputKind } from "../../daemon/turn-start-latency.ts";

const LIVE_ENV = "LETAGENTS_MEASURE_LIVE_PROVIDERS";
const TURN_TIMEOUT_MS = 240_000;
/** How long a launch that missed its deadline may take to arrive and be stopped. */
const LATE_LAUNCH_STOP_MS = 60_000;
const roomStubPath = join(dirname(fileURLToPath(import.meta.url)), "record-codex-replay-room-stub.mjs");

function parseArguments(argv) {
  const options = { provider: null, turns: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--provider") options.provider = argv[++index];
    else if (argv[index] === "--turns") options.turns = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (options.provider !== "codex" && options.provider !== "claude-code") {
    throw new Error("Pass --provider codex or --provider claude-code.");
  }
  if (!Number.isSafeInteger(options.turns) || options.turns < 2) throw new Error("--turns must be at least 2.");
  return options;
}

const round = (ms) => Math.round(ms);

function withDeadline(work, what) {
  let timer;
  return Promise.race([
    work,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish in ${TURN_TIMEOUT_MS} ms.`)), TURN_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

async function main() {
  if (process.env[LIVE_ENV] !== "1") {
    throw new Error(`This tool runs real model turns. Set ${LIVE_ENV}=1 to run it deliberately.`);
  }
  const { provider, turns } = parseArguments(process.argv.slice(2));
  if (provider === "codex" && resolve(process.env.HOME || userInfo().homedir) === resolve(userInfo().homedir)) {
    throw new Error("Run Codex with HOME set to a scratch folder that has your ~/.codex/auth.json linked in. "
      + "With your real HOME, Codex would share the agent home of your own desktop app.");
  }
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "letagents-start-latency-")));
  let listener = null;
  const streamSink = (event) => listener?.(event);
  const adapter = provider === "codex"
    ? new CodexProviderAdapter({ codexBin: process.env.LETAGENTS_CODEX_BIN?.trim() || resolveCodexExecutable({ env: process.env }), streamSink, activitySink: () => {} })
    : new ClaudeCodeProviderAdapter({ streamSink, activitySink: () => {} });
  const workAttemptId = randomUUID();
  const request = {
    workAttemptId,
    roomId: "latency-room",
    agentDisplayName: "LatencyProbe",
    cwd: workspace,
    deliveryMode: "daemon_inbox",
    lifecycleAuthorityMode: "typed",
    // Codex runs as a Read-only agent; Claude's default mode asks before any write.
    ...(provider === "codex" ? { permissionProfileId: "read_only" } : {}),
    configurationRevision: 1,
    launchPolicy: provider === "codex"
      ? { approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } }
      : { permissionMode: "default" },
    devMcpServerEntryPath: roomStubPath,
  };
  const results = [];
  let handle = null;
  let model = null;
  let turnNumber = 0;

  const launch = async (kind) => {
    const started = performance.now();
    let nativeAt = null;
    listener = (event) => {
      const payload = event.payload;
      if (!model && payload && typeof payload === "object" && typeof payload.model === "string") model = payload.model;
    };
    const spawnRequest = { ...request, onNativeStarted: () => { nativeAt ??= performance.now(); } };
    const ref = handle && { workAttemptId, providerContinuationId: handle.providerContinuationId };
    handle = null;
    const pending = kind === "fresh" ? adapter.spawn(spawnRequest) : adapter.resume(ref, { ...spawnRequest, resumeFrom: ref });
    try {
      handle = await withDeadline(pending, `The ${kind} launch`);
    } catch (error) {
      // The adapter's process is detached: a launch that arrives late must still be stopped.
      await Promise.race([
        pending.then((late) => adapter.stop(late, { force: true })).catch(() => undefined),
        new Promise((done) => setTimeout(done, LATE_LAUNCH_STOP_MS)),
      ]);
      throw error;
    }
    const ended = performance.now();
    console.error(`launched (${kind}) in ${round(ended - started)} ms`);
    results.push({
      kind: "launch", provider, launch: kind, elapsed_ms: round(ended - started),
      phases_ms: nativeAt === null ? { process: round(ended - started) } : { process: round(nativeAt - started), bootstrap: round(ended - nativeAt) },
    });
  };

  const turn = async (start) => {
    turnNumber += 1;
    const display = new ProviderLiveDisplay(handle.providerContinuationId);
    const called = performance.now();
    let turnStartedAt = null;
    let firstOutput = null;
    let sequence = 0;
    listener = (event) => {
      if (firstOutput || turnStartedAt === null || !isHumanRoomActivityEvent(event)) return;
      const sanitized = sanitizeDaemonActivityEvent({
        observed_at: event.observedAt, sequence: ++sequence, provider: event.provider, kind: event.kind, method: event.method,
        summary: (event.summary?.trim() || `${event.provider} · ${event.method}`).slice(0, 500), status: "working",
        payload: event.payload, payload_truncated: event.payloadTruncated, payload_redacted: event.payloadRedacted,
        durable_payload_ref: event.durablePayloadRef,
      });
      for (const projected of display.project(sanitized, event.nativeLifecyclePhase)) {
        const kind = firstOutputKind(projected.method);
        if (kind) { firstOutput = { at: performance.now(), kind }; break; }
      }
    };
    const result = await withDeadline(adapter.runRoomTurn(handle, {
      inboxItemId: `latency-inbox-${turnNumber}`,
      actionId: `latency-action-${turnNumber}`,
      sourceMessage: { id: `latency-message-${turnNumber}`, sender: "latency-owner", text: `Reply with one short sentence: what is ${turnNumber} + 2?` },
      activation: { kind: "mention" },
      observedContext: [],
    }, {
      beforeNativeDispatch: async () => {},
      markDispatched: async () => {},
      checkpointTurnStarted: async () => { turnStartedAt ??= performance.now(); },
    }), `Turn ${turnNumber}`);
    const ended = performance.now();
    listener = null;
    console.error(`turn ${turnNumber} (${start}) ${result.outcome} in ${round(ended - called)} ms`);
    const providerStart = (turnStartedAt ?? ended) - called;
    results.push({
      kind: "turn", provider, start, outcome: result.outcome, first_output: firstOutput?.kind ?? null,
      elapsed_ms: round((firstOutput?.at ?? ended) - called),
      phases_ms: firstOutput
        ? { provider_start: round(providerStart), first_output: round(firstOutput.at - (turnStartedAt ?? called)) }
        : { provider_start: round(providerStart), turn_end: round(ended - (turnStartedAt ?? called)) },
      turn_total_ms: round(ended - called),
    });
  };

  // The adapters unref their processes and sockets; the daemon's own work keeps
  // its event loop alive, and this timer does the same here.
  const keepAlive = setInterval(() => {}, 60_000);
  // The agent's process runs detached, so Ctrl-C does not reach it; stop it here.
  const interrupted = (signal) => {
    void (handle ? adapter.stop(handle, { force: true }) : Promise.resolve())
      .catch(() => undefined)
      .finally(() => rm(workspace, { recursive: true, force: true }).finally(() => process.exit(signal === "SIGINT" ? 130 : 143)));
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    await launch("fresh");
    await turn("cold");
    for (let index = 1; index < turns; index += 1) await turn("warm");
    await adapter.stop(handle);
    await launch("resume");
    await turn("cold");
    await turn("warm");
  } finally {
    clearInterval(keepAlive);
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    if (handle) await adapter.stop(handle, { force: true }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
  for (const line of results) console.log(JSON.stringify(line));
  console.log(JSON.stringify({ kind: "summary", provider, model, turns: results.filter((line) => line.kind === "turn").length }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
