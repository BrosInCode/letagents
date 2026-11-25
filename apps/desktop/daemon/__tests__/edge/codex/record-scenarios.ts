import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findReplayLeaks,
  ReplayRedactor,
  type ReplayRedactionContext,
} from "../../../../electron/__tests__/provider-replay/redaction.js";
import {
  PROVIDER_REPLAY_FORMAT,
  parseProviderReplayTranscript,
  serializeProviderReplayTranscript,
  type JsonObject,
  type JsonValue,
  type ProviderReplayEntry,
  type TranscriptStartEntry,
} from "../../../../electron/__tests__/provider-replay/transcript.js";
import { startEdgeDaemon, type EdgeAgentRegistration } from "../daemon-edge-harness.js";

// Manual developer recorder (never run by CI).
// Runs the real daemon against the real `codex` binary + a local loopback
// OpenAI Responses API stand-in (zero real account/cost) and writes redacted
// Format 1 NDJSON transcripts under `./fixtures/`.
//
// Usage:
//   LETAGENTS_RECORD_LIVE_CODEX=1 node --conditions=letagents-source --import tsx \
//     daemon/__tests__/edge/codex/record-scenarios.ts

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORD_CLI = join(HERE, "record-cli.mjs");
const FIXTURES_DIR = join(HERE, "fixtures");
const LIVE_ENV = "LETAGENTS_RECORD_LIVE_CODEX";

const SAY_RE = /EDGE_SAY\[([a-z0-9-]+)\]/g;
const TOOL_RE = /EDGE_TOOL\[([^\]]+)\]/g;

interface FakeResponsesServer {
  baseUrl: string;
  holdNext(): () => void;
  waitForRequest(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

function extractTextFromResponsesInput(input: unknown): { userText: string; hasToolOutput: boolean } {
  if (typeof input === "string") return { userText: input, hasToolOutput: false };
  if (!Array.isArray(input)) return { userText: "", hasToolOutput: false };
  let hasToolOutput = false;
  let lastUserText = "";
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (
      obj.type === "function_call_output" ||
      obj.type === "local_shell_call_output" ||
      obj.type === "custom_tool_call_output"
    ) {
      hasToolOutput = true;
    }
    if (obj.role === "user") {
      if (typeof obj.content === "string") {
        lastUserText = obj.content;
      } else if (Array.isArray(obj.content)) {
        const textParts = obj.content
          .filter((p) => p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string")
          .map((p) => String((p as Record<string, unknown>).text));
        if (textParts.length) lastUserText = textParts.join("\n");
      }
    }
  }
  return { userText: lastUserText, hasToolOutput };
}

function pickCommandTool(
  tools: unknown,
  command: string,
): { kind: "function"; name: string; argumentsJson: string } | { kind: "local_shell"; command: string[] } | null {
  if (!Array.isArray(tools)) return null;
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const tool = t as Record<string, unknown>;
    const name = typeof tool.name === "string" ? tool.name : "";
    if (tool.type === "function" && name === "exec_command") {
      return {
        kind: "function",
        name,
        argumentsJson: JSON.stringify({
          cmd: command,
          sandbox_permissions: "require_escalated",
          justification: "Need host approval for edge test command",
        }),
      };
    }
    if (tool.type === "function" && name === "shell_command") {
      return {
        kind: "function",
        name,
        argumentsJson: JSON.stringify({
          command,
          sandbox_permissions: "require_escalated",
          justification: "Need host approval for edge test command",
        }),
      };
    }
    if (tool.type === "function" && name === "shell") {
      return {
        kind: "function",
        name,
        argumentsJson: JSON.stringify({
          command: ["bash", "-lc", command],
          sandbox_permissions: "require_escalated",
          justification: "Need host approval for edge test command",
        }),
      };
    }
    if (tool.type === "local_shell") {
      return { kind: "local_shell", command: ["bash", "-lc", command] };
    }
  }
  return null;
}

async function startFakeResponsesServer(): Promise<FakeResponsesServer> {
  let hold: Promise<void> | null = null;
  let requestCount = 0;
  const reqWaiters: Array<() => void> = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const pathname = (req.url || "").split("?")[0];
      if (req.method !== "POST" || !pathname.endsWith("/responses")) {
        console.log(`[fake-responses] 404 ${req.method} ${pathname}`);
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Unhandled ${req.method} ${pathname}` } }));
        return;
      }

      let parsed: { input?: unknown; model?: string; tools?: unknown } = {};
      try { parsed = JSON.parse(bodyText); } catch { /* ignore */ }
      const { userText, hasToolOutput } = extractTextFromResponsesInput(parsed.input);
      const isAuxiliary = !userText.includes("EDGE_SAY[") && !userText.includes("EDGE_TOOL[");
      console.log(`[fake-responses] POST ${pathname} aux=${isAuxiliary} toolOut=${hasToolOutput} user=${userText.slice(0, 70).replace(/\s+/g, " ")}`);

      if (!isAuxiliary) {
        requestCount += 1;
        for (const wake of reqWaiters.splice(0)) wake();
      }

      let toolCommand: string | null = null;
      if (!hasToolOutput && !isAuxiliary) {
        for (const match of userText.matchAll(TOOL_RE)) toolCommand = match[1]!;
      }
      let replyText = isAuxiliary ? "Edge Thread" : "codex-default-reply";
      for (const match of userText.matchAll(SAY_RE)) replyText = match[1]!;

      const held = isAuxiliary ? null : hold;
      if (!isAuxiliary) hold = null;

      const sendResponse = () => {
        if (res.writableEnded || res.destroyed) return;
        const seqId = requestCount;
        const responseId = `resp_edge_${seqId}_${Date.now()}`;
        const model = parsed.model || "gpt-5.4";
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const emit = (eventName: string, data: Record<string, unknown>) => {
          res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        emit("response.created", {
          type: "response.created",
          response: { id: responseId, object: "response", status: "in_progress", model, output: [] },
        });

        const selectedTool = toolCommand ? pickCommandTool(parsed.tools, toolCommand) : null;
        if (selectedTool && selectedTool.kind === "function") {
          const itemId = `fc_edge_${seqId}`;
          const callId = `call_edge_${seqId}`;
          const item = {
            id: itemId,
            type: "function_call",
            status: "completed",
            call_id: callId,
            name: selectedTool.name,
            arguments: selectedTool.argumentsJson,
          };
          emit("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", arguments: "" },
          });
          emit("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            item_id: itemId,
            output_index: 0,
            delta: selectedTool.argumentsJson,
          });
          emit("response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            item_id: itemId,
            output_index: 0,
            arguments: selectedTool.argumentsJson,
          });
          emit("response.output_item.done", {
            type: "response.output_item.done",
            output_index: 0,
            item,
          });
          emit("response.completed", {
            type: "response.completed",
            response: {
              id: responseId,
              object: "response",
              status: "completed",
              model,
              output: [item],
              usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
            },
          });
        } else if (selectedTool && selectedTool.kind === "local_shell") {
          const itemId = `lsh_edge_${seqId}`;
          const callId = `call_edge_${seqId}`;
          const item = {
            id: itemId,
            type: "local_shell_call",
            status: "completed",
            call_id: callId,
            action: { type: "exec", command: selectedTool.command },
          };
          emit("response.output_item.added", { type: "response.output_item.added", output_index: 0, item });
          emit("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
          emit("response.completed", {
            type: "response.completed",
            response: {
              id: responseId,
              object: "response",
              status: "completed",
              model,
              output: [item],
              usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
            },
          });
        } else {
          const itemId = `msg_edge_${seqId}`;
          const item = {
            id: itemId,
            type: "message",
            status: "completed",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: replyText, annotations: [] }],
          };
          emit("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: itemId, type: "message", status: "in_progress", role: "assistant", phase: "final_answer", content: [] },
          });
          emit("response.content_part.added", {
            type: "response.content_part.added",
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
          emit("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta: replyText,
          });
          emit("response.output_text.done", {
            type: "response.output_text.done",
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            text: replyText,
          });
          emit("response.content_part.done", {
            type: "response.content_part.done",
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: replyText, annotations: [] },
          });
          emit("response.output_item.done", {
            type: "response.output_item.done",
            output_index: 0,
            item,
          });
          emit("response.completed", {
            type: "response.completed",
            response: {
              id: responseId,
              object: "response",
              status: "completed",
              model,
              output: [item],
              usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            },
          });
        }
        res.end();
      };

      if (held) void held.then(sendResponse);
      else sendResponse();
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    holdNext() {
      let release!: () => void;
      hold = new Promise<void>((resolveHold) => { release = resolveHold; });
      return release;
    },
    async waitForRequest(targetCount, timeoutMs = 25_000) {
      const deadline = Date.now() + timeoutMs;
      while (requestCount < targetCount && Date.now() < deadline) {
        await Promise.race([
          new Promise<void>((resolveWake) => reqWaiters.push(resolveWake)),
          new Promise<void>((resolveTick) => setTimeout(resolveTick, 50)),
        ]);
      }
      if (requestCount < targetCount) throw new Error(`Timed out waiting for Responses API request #${targetCount}`);
    },
    close: () => new Promise<void>((resolveClose) => {
      server.closeAllConnections?.();
      server.close(() => resolveClose());
    }),
  };
}

interface RawEntry {
  type: "expect_outbound" | "emit_inbound" | "runtime_exit";
  label?: string;
  frame?: JsonObject;
  requested?: boolean;
  transportClosedBeforeExit?: boolean;
  code?: number | null;
  signal?: string | null;
}

function redactAndNormalizeCapture(
  rawLines: RawEntry[],
  context: {
    scenario: string;
    description: string;
    providerVersion: string;
    homeDir: string;
    workspaceDir: string;
    modelBaseUrl: string;
    roomApiUrl: string;
  },
): { start: TranscriptStartEntry; entries: ProviderReplayEntry[]; redactionContext: ReplayRedactionContext } {
  const idMap = new Map<string, string>();
  let threadSeq = 0;
  let turnSeq = 0;
  let itemSeq = 0;
  let approvalSeq = 0;

  const bind = (raw: unknown, prefix: string, counter: () => number, singleton = false): void => {
    if (typeof raw !== "string" || !raw || idMap.has(raw)) return;
    const n = counter();
    idMap.set(raw, singleton && n === 1 ? `<${prefix}>` : `<${prefix}-${n}>`);
  };

  const scanIds = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(scanIds); return; }
    const obj = node as Record<string, unknown>;
    if (typeof obj.threadId === "string") bind(obj.threadId, "thread", () => ++threadSeq, true);
    if (obj.thread && typeof obj.thread === "object" && !Array.isArray(obj.thread)) {
      const t = obj.thread as Record<string, unknown>;
      if (typeof t.id === "string") bind(t.id, "thread", () => ++threadSeq, true);
    }
    if (typeof obj.turnId === "string") bind(obj.turnId, "turn", () => ++turnSeq);
    if (obj.turn && typeof obj.turn === "object" && !Array.isArray(obj.turn)) {
      const t = obj.turn as Record<string, unknown>;
      if (typeof t.id === "string") bind(t.id, "turn", () => ++turnSeq);
    }
    if (typeof obj.itemId === "string") bind(obj.itemId, "item", () => ++itemSeq);
    if (obj.item && typeof obj.item === "object" && !Array.isArray(obj.item)) {
      const item = obj.item as Record<string, unknown>;
      if (typeof item.id === "string") bind(item.id, "item", () => ++itemSeq);
    }
    if (typeof obj.approvalId === "string") bind(obj.approvalId, "approval", () => ++approvalSeq);
    if (typeof obj.processId === "string" && obj.processId.length > 4) bind(obj.processId, "proc", () => ++itemSeq);
    for (const val of Object.values(obj)) scanIds(val);
  };
  for (const entry of rawLines) scanIds(entry.frame);

  const userName = userInfo().username;
  const hostName = hostname();
  const realHome = homedir();
  const orderedIds = [...idMap.entries()].sort((a, b) => b[0].length - a[0].length);

  const scrubString = (text: string): string => {
    let out = text;
    for (const [raw, placeholder] of orderedIds) {
      if (out.includes(raw)) out = out.split(raw).join(placeholder);
    }
    for (const dir of [context.workspaceDir, context.homeDir, realHome]) {
      if (dir && out.includes(dir)) out = out.split(dir).join("<workspace>");
    }
    if (context.modelBaseUrl && out.includes(context.modelBaseUrl)) {
      out = out.split(context.modelBaseUrl).join("http://127.0.0.1:<modelPort>/v1");
    }
    if (context.roomApiUrl && out.includes(context.roomApiUrl)) {
      out = out.split(context.roomApiUrl).join("http://127.0.0.1:<roomPort>");
    }
    out = out.replace(/\/private\/var\/folders\/[^\s"']+/g, "<workspace>");
    out = out.replace(/\/var\/folders\/[^\s"']+/g, "<workspace>");
    out = out.replace(/http:\/\/127\.0\.0\.1:\d+/g, "http://127.0.0.1:<port>");
    return out;
  };

  const scrubValue = (value: unknown, key = ""): JsonValue => {
    if (value === null || value === undefined) return null;
    if (typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
      if ((key === "text" || key === "preview") && value.includes("You are responding to a daemon-owned room inbox item")) {
        return "<prompt>";
      }
      return scrubString(value);
    }
    if (Array.isArray(value)) return value.map((item) => scrubValue(item));
    if (typeof value === "object") {
      const out: JsonObject = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = scrubValue(v, k);
      }
      return out;
    }
    return String(value);
  };

  const entries: ProviderReplayEntry[] = [];
  for (const raw of rawLines) {
    if (raw.type === "runtime_exit") continue;
    if (!raw.frame) continue;
    const method = typeof raw.frame.method === "string" ? raw.frame.method : "";
    // Skip ultra-noisy internal Codex legacy event duplicates (codex/event/*) so transcripts stay readable & compact,
    // while keeping EVERY authoritative JSON-RPC request/response and v2 notification!
    if (raw.type === "emit_inbound" && method.startsWith("codex/event/")) continue;
    entries.push({
      type: raw.type,
      label: scrubString(raw.label || method || "frame"),
      frame: scrubValue(raw.frame) as JsonObject,
    });
  }
  entries.push({
    type: "runtime_exit",
    requested: true,
    transportClosedBeforeExit: false,
    code: 0,
    signal: null,
  });

  const redactionContext: ReplayRedactionContext = {
    workspacePaths: [context.workspaceDir, context.homeDir],
    tempDirectories: [tmpdir()],
    repositoryPaths: [],
    homeDirectory: realHome,
    username: userName,
    personalNames: [],
    hostnames: [hostName],
    secrets: ["sk-edge-local-record"],
    ownerSetupNames: [],
    accountMethods: [/^account\//],
  };
  const redactor = new ReplayRedactor(redactionContext);
  const finalEntries: ProviderReplayEntry[] = entries.map((entry) => {
    if (entry.type === "runtime_exit") return entry;
    return {
      ...entry,
      ...(entry.label ? { label: redactor.redactText(entry.label) } : {}),
      frame: redactor.redactFrame(entry.frame, entry.label),
    };
  });

  const start: TranscriptStartEntry = {
    type: "transcript_start",
    format: PROVIDER_REPLAY_FORMAT,
    provider: "codex",
    protocol: "codex.app-server/jsonrpc-ws",
    providerVersion: context.providerVersion,
    scenario: context.scenario,
    capture: {
      recorder: "apps/desktop/daemon/__tests__/edge/codex/record-scenarios.ts",
      recordedWith: "real codex binary + local OpenAI Responses API stand-in",
      platform: `${process.platform}-${process.arch}`,
      description: context.description,
      redactions: redactor.counts,
    },
  };
  return { start, entries: finalEntries, redactionContext };
}

function writeLocalCodexConfig(homeDir: string, baseUrl: string): void {
  const codexDir = join(homeDir, ".codex");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(codexDir, "config.toml"),
    [
      'model_provider = "local"',
      'model = "gpt-5.4"',
      'cli_auth_credentials_store = "file"',
      "",
      "[model_providers.local]",
      'name = "Local Edge Recorder"',
      `base_url = "${baseUrl}"`,
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "responses"',
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(codexDir, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-edge-local-record" }, null, 2),
    "utf8",
  );
}

async function runAndRecord(
  scenario: string,
  description: string,
  realCodexBin: string,
  providerVersion: string,
  driver: (ctx: {
    harness: Awaited<ReturnType<typeof startEdgeDaemon>>;
    agentConfig: EdgeAgentRegistration;
    llm: FakeResponsesServer;
    daemonGeneration: number;
  }) => Promise<void>,
  permissionProfileId: string = "full_access",
): Promise<void> {
  const llm = await startFakeResponsesServer();
  const captureDir = join(tmpdir(), `letagents-codex-rec-${scenario}-${Date.now()}`);
  const captureFile = join(captureDir, "raw.ndjson");
  mkdirSync(captureDir, { recursive: true });
  const harness = await startEdgeDaemon({
    shims: [
      {
        name: "codex",
        scriptPath: RECORD_CLI,
        envVar: "LETAGENTS_CODEX_BIN",
        env: {
          LETAGENTS_REAL_CODEX_BIN: realCodexBin,
          LETAGENTS_CODEX_CAPTURE_FILE: captureFile,
          OPENAI_API_KEY: "sk-edge-local-record",
        },
      },
    ],
  });
  try {
    writeLocalCodexConfig(harness.homeDir, llm.baseUrl);
    const roomId = `rec_codex_${scenario}`;
    const entryId = `agent_rec_codex_${scenario}`;
    const agentConfig: EdgeAgentRegistration = {
      entryId,
      roomId,
      provider: "codex",
      displayName: `Record Codex ${scenario}`,
      model: "gpt-5.4",
      permissionProfileId,
    };
    const { daemonGeneration } = await harness.startAgent(agentConfig);
    await harness.waitForEntry(
      entryId,
      (e) => e.observed_state === "idle" && Boolean(e.provider_ref?.provider_continuation_id),
      60_000,
      `real codex idle (${scenario})`,
    );
    await driver({ harness, agentConfig, llm, daemonGeneration });
    await harness.dispose();

    const rawText = readFileSync(captureFile, "utf8");
    const rawLines = rawText
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as RawEntry);
    const { start, entries, redactionContext } = redactAndNormalizeCapture(rawLines, {
      scenario,
      description,
      providerVersion,
      homeDir: harness.homeDir,
      workspaceDir: harness.workspaceDir,
      modelBaseUrl: llm.baseUrl,
      roomApiUrl: harness.roomServer.apiUrl,
    });
    const serialized = serializeProviderReplayTranscript(start, entries);
    parseProviderReplayTranscript(serialized, `${scenario}.ndjson`);
    const leaks = findReplayLeaks(serialized, redactionContext);
    if (leaks.length > 0) {
      throw new Error(`Leaks found in recorded codex/${scenario}.ndjson: ${JSON.stringify(leaks.slice(0, 8))}`);
    }
    mkdirSync(FIXTURES_DIR, { recursive: true });
    writeFileSync(join(FIXTURES_DIR, `${scenario}.ndjson`), serialized, "utf8");
    console.log(`Recorded codex/${scenario}.ndjson (${entries.length} entries, 0 leaks)`);
  } finally {
    if (existsSync(captureFile) && process.env.LETAGENTS_RECORD_DEBUG === "1") {
      const lines = readFileSync(captureFile, "utf8").split("\n").filter(Boolean);
      console.log(`[codex capture ${scenario}] (${lines.length} lines), tail:\n${lines.slice(-8).join("\n").slice(0, 2000)}`);
    }
    await harness.dispose().catch(() => undefined);
    await llm.close().catch(() => undefined);
    rmSync(captureDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.env[LIVE_ENV] !== "1") {
    throw new Error(`Set ${LIVE_ENV}=1 to record live Codex transcripts.`);
  }
  const only = process.env.LETAGENTS_RECORD_SCENARIOS
    ? new Set(process.env.LETAGENTS_RECORD_SCENARIOS.split(",").map((s) => s.trim()).filter(Boolean))
    : null;
  const shouldRun = (name: string) => !only || only.has(name);
  const realCodexBin = process.env.LETAGENTS_REAL_CODEX_BIN?.trim()
    || execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
  const providerVersion = execFileSync(realCodexBin, ["--version"], { encoding: "utf8" }).trim();
  console.log(`Recording with real ${providerVersion} (${realCodexBin})`);

  if (shouldRun("simple")) await runAndRecord(
    "simple",
    "One room message produces exactly one Codex reply.",
    realCodexBin,
    providerVersion,
    async ({ harness, agentConfig }) => {
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "EDGE_SAY[codex-ready-reply]" });
      await harness.roomServer.waitForPublishedMessages(agentConfig.roomId, (m) => m.length >= 1, 30_000);
      await harness.waitForEntry(
        agentConfig.entryId,
        (e) => e.observed_state === "idle" && e.room_agent_state?.turn.state === "idle" && (e.room_agent_state?.inbox.pending_count ?? 0) === 0,
        20_000,
      );
    },
  );

  if (shouldRun("fifo-order")) await runAndRecord(
    "fifo-order",
    "Three room messages (A in flight, B and C queued) execute strictly in FIFO order A -> B -> C.",
    realCodexBin,
    providerVersion,
    async ({ harness, agentConfig, llm }) => {
      const release = llm.holdNext();
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "First Codex FIFO message EDGE_SAY[codex-fifo-1]" });
      await llm.waitForRequest(1, 25_000);
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Second Codex FIFO message EDGE_SAY[codex-fifo-2]" });
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Third Codex FIFO message EDGE_SAY[codex-fifo-3]" });
      await harness.waitForEntry(agentConfig.entryId, (e) => (e.room_agent_state?.inbox.pending_count ?? 0) >= 3, 15_000);
      release();
      await harness.roomServer.waitForPublishedMessages(agentConfig.roomId, (m) => m.length >= 3, 45_000);
      await harness.waitForEntry(
        agentConfig.entryId,
        (e) => e.observed_state === "idle" && e.room_agent_state?.turn.state === "idle" && (e.room_agent_state?.inbox.pending_count ?? 0) === 0,
        20_000,
      );
    },
  );

  if (shouldRun("turn-interrupt")) await runAndRecord(
    "turn-interrupt",
    "Interrupt an active Codex turn via manifest.control_turn, then complete a follow-up turn.",
    realCodexBin,
    providerVersion,
    async ({ harness, agentConfig, llm, daemonGeneration }) => {
      const release = llm.holdNext();
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Long Codex turn EDGE_SAY[never]" });
      await llm.waitForRequest(1, 25_000);
      const active = await harness.waitForEntry(
        agentConfig.entryId,
        (e) =>
          e.observed_state === "working" &&
          e.room_agent_state?.turn.state === "responding" &&
          Boolean(e.room_agent_state.turn.provider_turn_id),
        20_000,
      );
      await harness.rpc.controlTurn({
        id: agentConfig.entryId,
        daemon_generation: daemonGeneration,
        room_id: agentConfig.roomId,
        work_attempt_id: active.provider_ref!.work_attempt_id,
        execution_generation_id: active.provider_ref!.execution_generation_id,
        provider_continuation_id: active.provider_ref!.provider_continuation_id,
        provider_turn_id: active.room_agent_state!.turn.provider_turn_id!,
        inbox_item_id: active.room_agent_state!.turn.inbox_item_id!,
        source_message_id: active.room_agent_state!.turn.source_message_id!,
        action_id: "rec-codex-interrupt-1",
        action_sequence: 1,
        correction: null,
      });
      release();
      await harness.waitForEntry(
        agentConfig.entryId,
        (e) => e.observed_state === "idle" && e.room_agent_state?.turn.state === "idle",
        20_000,
      );
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Follow-up EDGE_SAY[codex-after-interrupt]" });
      await harness.roomServer.waitForPublishedMessages(agentConfig.roomId, (m) => m.length >= 1, 30_000);
      await harness.waitForEntry(
        agentConfig.entryId,
        (e) => e.observed_state === "idle" && e.room_agent_state?.turn.state === "idle" && (e.room_agent_state?.inbox.pending_count ?? 0) === 0,
        20_000,
      );
    },
  );

  if (shouldRun("kill-recover")) await runAndRecord(
    "kill-recover",
    "Daemon SIGKILL mid-turn; live Codex completes turn and restarted daemon publishes exactly once.",
    realCodexBin,
    providerVersion,
    async ({ harness, agentConfig, llm }) => {
      const release = llm.holdNext();
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Survive kill EDGE_SAY[codex-survived-kill]" });
      await llm.waitForRequest(1, 25_000);
      await harness.waitForEntry(
        agentConfig.entryId,
        (e) => e.room_agent_state?.turn.state === "responding" && Boolean(e.room_agent_state.turn.provider_turn_id),
        20_000,
      );
      await harness.kill("SIGKILL");
      release();
      const restarted = await harness.restart();
      await harness.reinstallCredentials(agentConfig, restarted.generation);
      await harness.roomServer.waitForPublishedMessages(agentConfig.roomId, (m) => m.length >= 1, 30_000);
      await harness.waitForEntry(
        agentConfig.entryId,
        (e) => e.observed_state === "idle" && e.room_agent_state?.turn.state === "idle" && (e.room_agent_state?.inbox.pending_count ?? 0) === 0,
        20_000,
      );
    },
  );

  if (shouldRun("handoff")) await runAndRecord(
    "handoff",
    "Codex survives daemon update handoff and completes a follow-up turn.",
    realCodexBin,
    providerVersion,
    async ({ harness, agentConfig }) => {
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Before handoff EDGE_SAY[codex-before-handoff]" });
      await harness.roomServer.waitForPublishedMessages(agentConfig.roomId, (m) => m.length >= 1, 30_000);
      await harness.waitForEntry(
        agentConfig.entryId,
        (e) => e.observed_state === "idle" && e.room_agent_state?.turn.state === "idle",
        20_000,
      );
      const { successorStatus } = await harness.handoffToSuccessor();
      await harness.reinstallCredentials(agentConfig, successorStatus.generation);
      await harness.waitForEntry(agentConfig.entryId, (e) => e.observed_state === "idle", 25_000);
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "After handoff EDGE_SAY[codex-after-handoff]" });
      await harness.roomServer.waitForPublishedMessages(agentConfig.roomId, (m) => m.length >= 2, 30_000);
      await harness.waitForEntry(
        agentConfig.entryId,
        (e) => e.observed_state === "idle" && e.room_agent_state?.turn.state === "idle" && (e.room_agent_state?.inbox.pending_count ?? 0) === 0,
        20_000,
      );
    },
  );

  if (shouldRun("approval")) await runAndRecord(
    "approval",
    "Real Codex with ask_before_write emits command approval request and completes after signed host allow_once.",
    realCodexBin,
    providerVersion,
    async ({ harness, agentConfig }) => {
      harness.roomServer.enqueueMessage(agentConfig.roomId, {
        text: "Run command EDGE_TOOL[touch edge-approval-probe.txt] EDGE_SAY[codex-approval-granted]",
      });
      const candidate = await harness.waitForApproval(
        agentConfig.roomId,
        (c) => c.status === "pending" && Boolean(c.reference),
        30_000,
      );
      await harness.rpc.decideHostApproval(candidate, "allow_once");
      await harness.roomServer.waitForPublishedMessages(agentConfig.roomId, (m) => m.length >= 1, 30_000);
      await harness.waitForEntry(
        agentConfig.entryId,
        (e) => e.observed_state === "idle" && e.room_agent_state?.turn.state === "idle" && (e.room_agent_state?.inbox.pending_count ?? 0) === 0,
        20_000,
      );
    },
    "ask_before_write",
  );

  // Derive crash-loop from the real recorded startup handshake of simple.ndjson.
  const simple = parseProviderReplayTranscript(
    readFileSync(join(FIXTURES_DIR, "simple.ndjson"), "utf8"),
    "simple.ndjson",
  );
  const firstTurnIdx = simple.entries.findIndex((e) => e.type === "expect_outbound" && e.label === "turn/start");
  const startupOnly = (firstTurnIdx >= 0 ? simple.entries.slice(0, firstTurnIdx) : simple.entries)
    .filter((e) => e.type !== "runtime_exit");
  const crashEntries: ProviderReplayEntry[] = [
    ...startupOnly.map(({ line: _line, ...rest }) => rest),
    { type: "runtime_exit", requested: false, transportClosedBeforeExit: false, code: 1, signal: null },
  ];
  const crashStart: TranscriptStartEntry = {
    ...simple.start,
    scenario: "crash-loop",
    capture: {
      ...simple.start.capture,
      description: "Real Codex startup handshake followed by repeated unexpected exit code 1 until quarantine.",
      derivedFrom: "simple.ndjson startup handshake + synthetic non-zero runtime_exit",
    },
  };
  const crashText = serializeProviderReplayTranscript(crashStart, crashEntries);
  parseProviderReplayTranscript(crashText, "crash-loop.ndjson");
  writeFileSync(join(FIXTURES_DIR, "crash-loop.ndjson"), crashText, "utf8");
  console.log(`Wrote codex/crash-loop.ndjson (${crashEntries.length} entries)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
