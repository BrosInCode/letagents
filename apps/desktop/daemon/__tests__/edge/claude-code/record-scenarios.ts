import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startEdgeDaemon, type EdgeAgentRegistration, type EdgeDaemonHarness } from "../daemon-edge-harness.js";

// Records the traffic between the real daemon and the real `claude` program
// for the edge scenarios, as raw captures. It is a manual developer tool, and
// CI never runs it.
//
// Claude Code is real. The model is not: the program talks to a stand-in for
// the Messages API on 127.0.0.1, as `electron/scripts/record-claude-result-shapes.mjs`
// does. So a recording needs no Claude account and spends nothing, and the
// answer of each turn is known beforehand. The room server and the room's MCP
// server are the stand-ins of the edge harness.
//
//   LETAGENTS_RECORD_LIVE_CLAUDE=1 node --import tsx \
//     daemon/__tests__/edge/claude-code/record-scenarios.ts --out /tmp/claude-captures [--scenario simple]
//
// The captures are raw. `redact-capture.ts` makes the fixtures from them.

const LIVE_RECORD_ENV = "LETAGENTS_RECORD_LIVE_CLAUDE";
const RECORD_CLI = fileURLToPath(new URL("./record-cli.mjs", import.meta.url));
/** The words of the daemon's first prompt that name the answer it waits for. */
const BOOTSTRAP_ANSWER = "LETAGENTS_CLAUDE_DAEMON_READY";
/** A room message of a scenario names its own answer: `EDGE_SAY[alpha]` is answered `alpha`. */
const SAY = /EDGE_SAY\[([a-z0-9-]+)\]/g;

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** The answer to a request: the last thing its conversation asks for. */
function answerFor(body: string): string {
  let answer = "";
  let at = body.lastIndexOf(BOOTSTRAP_ANSWER);
  if (at >= 0) answer = BOOTSTRAP_ANSWER;
  for (const match of body.matchAll(SAY)) {
    if (match.index > at) {
      at = match.index;
      answer = match[1]!;
    }
  }
  return answer || "EDGE_NO_ANSWER";
}

export interface MessagesStandIn {
  url: string;
  /** While set, an answer is held back until the returned function is called. */
  holdNext(): () => void;
  requests: number;
  close(): Promise<void>;
}

async function startMessagesStandIn(): Promise<MessagesStandIn> {
  let hold: Promise<void> | null = null;
  const state = { requests: 0 };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = (request.url ?? "").split("?")[0];
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.method !== "POST" || path !== "/v1/messages") {
        response.writeHead(404, { "content-type": "application/json", "request-id": "req_edge" });
        response.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not found" } }));
        return;
      }
      state.requests += 1;
      const text = answerFor(body);
      const id = `msg_edge_${state.requests}`;
      const usage = { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const held = hold;
      hold = null;
      void (held ?? Promise.resolve()).then(() => {
        if (!/"stream"\s*:\s*true/.test(body)) {
          response.writeHead(200, { "content-type": "application/json", "request-id": "req_edge" });
          response.end(JSON.stringify({ id, type: "message", role: "assistant", model: "edge-model",
            content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_edge" });
        response.write(sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant",
          model: "edge-model", content: [], stop_reason: null, stop_sequence: null, usage } }));
        response.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        response.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
        response.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
        response.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }));
        response.end(sse("message_stop", { type: "message_stop" }));
      });
    });
  });
  await new Promise<void>((resolveListen) => server.listen({ host: "127.0.0.1", port: 0 }, resolveListen));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    holdNext() {
      let release!: () => void;
      hold = new Promise<void>((resolveHold) => { release = resolveHold; });
      return release;
    },
    get requests() { return state.requests; },
    close: () => new Promise<void>((resolveClose) => {
      server.closeAllConnections();
      server.close(() => resolveClose());
    }),
  };
}

interface ScenarioContext {
  harness: EdgeDaemonHarness;
  agent: EdgeAgentRegistration;
  messages: MessagesStandIn;
  captureDir: string;
  daemonGeneration: number;
}

async function waitIdle(context: ScenarioContext, what: string): Promise<void> {
  await context.harness.waitForEntry(
    context.agent.entryId,
    (entry) => entry.observed_state === "idle" && entry.room_agent_state?.turn.state === "idle",
    60_000,
    what,
  );
}

async function waitForCapture(dir: string, index: number, pattern: RegExp, what: string): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const path = join(dir, `capture-${index}.ndjson`);
  const deadline = Date.now() + 60_000;
  while (!(existsSync(path) && pattern.test(readFileSync(path, "utf8")))) {
    if (Date.now() > deadline) throw new Error(`The capture never showed ${what}.`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

/**
 * Copy the session file of the program as `session-<launch>.jsonl`, once it
 * holds `turns` turns that the model ended. Claude Code writes the file as it
 * works, so a copy made too early misses the end of the turn.
 */
async function snapshotSessionFile(homeDir: string, captureDir: string, launch: number, turns: number): Promise<void> {
  const { readFileSync, copyFileSync } = await import("node:fs");
  const root = join(homeDir, ".claude", "projects");
  const deadline = Date.now() + 60_000;
  for (;;) {
    const files = existsSync(root)
      ? (readdirSync(root, { recursive: true }) as string[]).filter((file) => file.endsWith(".jsonl"))
      : [];
    if (files.length > 1) throw new Error(`More than one session file in ${root}: ${files.join(", ")}.`);
    if (files.length === 1) {
      const ended = readFileSync(join(root, files[0]!), "utf8").split('"stop_reason":"end_turn"').length - 1;
      if (ended >= turns) {
        copyFileSync(join(root, files[0]!), join(captureDir, `session-${launch}.jsonl`));
        return;
      }
    }
    if (Date.now() > deadline) throw new Error(`The session file never held ${turns} ended turns.`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

const SCENARIOS: Record<string, (context: ScenarioContext) => Promise<void>> = {
  /** One room message, one reply. */
  async simple({ harness, agent }) {
    harness.roomServer.enqueueMessage(agent.roomId, { text: "EDGE_SAY[claude-ready]" });
    await harness.roomServer.waitForPublishedMessages(agent.roomId, (messages) => messages.length >= 1, 60_000);
  },
  /** Two room messages that wait in the queue, answered in their order. */
  async "fifo-two"({ harness, agent }) {
    harness.roomServer.enqueueMessage(agent.roomId, { text: "EDGE_SAY[first-reply]" });
    harness.roomServer.enqueueMessage(agent.roomId, { text: "EDGE_SAY[second-reply]" });
    await harness.roomServer.waitForPublishedMessages(agent.roomId, (messages) => messages.length >= 2, 60_000);
  },
  /** A turn that the owner stops while the model has not answered. */
  async "turn-interrupt"(context) {
    const { harness, agent, messages, captureDir } = context;
    const release = messages.holdNext();
    harness.roomServer.enqueueMessage(agent.roomId, { text: "EDGE_SAY[never-sent]" });
    const active = await harness.waitForEntry(
      agent.entryId,
      (entry) => entry.room_agent_state?.turn.state === "responding"
        && Boolean(entry.room_agent_state.turn.provider_turn_id)
        && Boolean(entry.room_agent_state.turn.inbox_item_id),
      60_000,
      "a responding turn",
    );
    await waitForCapture(captureDir, 1, /"state":"started"[^\n]*\n[\s\S]*"state":"started"/, "the start of the room turn");
    await harness.rpc.controlTurn({
      id: agent.entryId,
      daemon_generation: context.daemonGeneration,
      room_id: agent.roomId,
      work_attempt_id: active.provider_ref!.work_attempt_id,
      execution_generation_id: active.provider_ref!.execution_generation_id,
      provider_continuation_id: active.provider_ref!.provider_continuation_id,
      provider_turn_id: active.room_agent_state!.turn.provider_turn_id!,
      inbox_item_id: active.room_agent_state!.turn.inbox_item_id!,
      source_message_id: active.room_agent_state!.turn.source_message_id!,
      action_id: "edge-claude-interrupt-1",
      action_sequence: 1,
      correction: null,
    });
    release();
  },
  /** The daemon dies during a room turn and starts again. */
  async "kill-recover"(context) {
    const { harness, agent, messages, captureDir } = context;
    const release = messages.holdNext();
    harness.roomServer.enqueueMessage(agent.roomId, { text: "EDGE_SAY[survived-kill]" });
    await harness.waitForEntry(
      agent.entryId,
      (entry) => entry.room_agent_state?.turn.state === "responding" && Boolean(entry.room_agent_state.turn.provider_turn_id),
      60_000,
      "a responding turn",
    );
    await waitForCapture(captureDir, 1, /"state":"started"[^\n]*\n[\s\S]*"state":"started"/, "the start of the room turn");
    await harness.kill("SIGKILL");
    release();
    // The program ends by itself once its reader is gone. Keep its session file as it left it.
    await snapshotSessionFile(harness.homeDir, captureDir, 1, 2);
    const restarted = await harness.restart();
    await harness.reinstallCredentials(agent, restarted.generation);
    await harness.roomServer.waitForPublishedMessages(agent.roomId, (published) => published.length >= 1, 90_000);
  },
};

async function record(name: string, outRoot: string): Promise<void> {
  const captureDir = join(outRoot, name);
  rmSync(captureDir, { recursive: true, force: true });
  mkdirSync(captureDir, { recursive: true });
  const realBin = process.env.LETAGENTS_EDGE_CLAUDE_REAL_BIN
    || spawnSync("which", ["claude"], { encoding: "utf8" }).stdout.trim();
  if (!realBin) throw new Error("The Claude Code program was not found. Set LETAGENTS_EDGE_CLAUDE_REAL_BIN to its path.");

  const messages = await startMessagesStandIn();
  const harness = await startEdgeDaemon({
    keepHome: process.env.LETAGENTS_EDGE_KEEP_HOME === "1",
    shims: [{
      name: "claude",
      scriptPath: RECORD_CLI,
      envVar: "LETAGENTS_CLAUDE_CODE_BIN",
      env: {
        LETAGENTS_EDGE_CLAUDE_RECORD_DIR: captureDir,
        LETAGENTS_EDGE_CLAUDE_REAL_BIN: realBin,
        ANTHROPIC_BASE_URL: messages.url,
        ANTHROPIC_API_KEY: "edge-dummy-key",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
      },
    }],
  });
  const agent: EdgeAgentRegistration = {
    entryId: `agent_claude_${name}`,
    roomId: `edge_claude_${name}`,
    provider: "claude-code",
    displayName: `Edge Claude ${name}`,
    model: "sonnet",
    permissionProfileId: "full_access",
  };
  const context: ScenarioContext = { harness, agent, messages, captureDir, daemonGeneration: 0 };
  try {
    context.daemonGeneration = (await harness.startAgent(agent)).daemonGeneration;
    await harness.waitForEntry(agent.entryId, (entry) => entry.observed_state === "idle", 90_000, "claude idle after its first prompt");
    await SCENARIOS[name]!(context);
    await waitIdle(context, "idle at the end of the scenario");
  } catch (error) {
    console.error(`[${name}] ${error instanceof Error ? error.stack : String(error)}`);
    console.error(`[${name}] daemon stderr:\n${harness.daemonOutput().stderr.slice(-4000)}`);
    process.exitCode = 1;
  } finally {
    await harness.dispose();
    await messages.close();
  }
  console.log(`[${name}] ${readdirSync(captureDir).join(", ")} (${messages.requests} model requests) in ${captureDir}`);
}

async function main(): Promise<void> {
  if (process.env[LIVE_RECORD_ENV] !== "1") {
    throw new Error(`This tool starts the real Claude Code program. Set ${LIVE_RECORD_ENV}=1 to run it on purpose.`);
  }
  const args = process.argv.slice(2);
  const option = (flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const outRoot = resolve(option("--out") ?? "");
  if (!option("--out")) throw new Error("Give --out <folder outside the repository>.");
  const names = option("--scenario") ? [option("--scenario")!] : Object.keys(SCENARIOS);
  for (const name of names) {
    if (!SCENARIOS[name]) throw new Error(`Unknown scenario ${name}. Known: ${Object.keys(SCENARIOS).join(", ")}.`);
    await record(name, outRoot);
  }
}

await main();
