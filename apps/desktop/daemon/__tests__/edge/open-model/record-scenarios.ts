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
// Runs the real daemon against the real `opencode` binary + a local loopback
// OpenAI-compatible Chat Completions stand-in (zero real account/cost) and
// writes redacted Format 1 NDJSON transcripts under `./fixtures/`.
//
// Usage:
//   LETAGENTS_RECORD_LIVE_OPENCODE=1 node --import tsx \
//     daemon/__tests__/edge/open-model/record-scenarios.ts

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORD_CLI = join(HERE, "record-cli.mjs");
const FIXTURES_DIR = join(HERE, "fixtures");
const LIVE_ENV = "LETAGENTS_RECORD_LIVE_OPENCODE";

const SAY_RE = /EDGE_SAY\[([a-z0-9-]+)\]/g;
const TOOL_RE = /EDGE_TOOL\[([^\]]+)\]/g;

interface FakeLlmServer {
  baseUrl: string;
  holdNext(): () => void;
  waitForRequest(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

async function startFakeOpenAiServer(): Promise<FakeLlmServer> {
  let hold: Promise<void> | null = null;
  let requestCount = 0;
  const reqWaiters: Array<() => void> = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const pathname = (req.url || "").split("?")[0];
      if (req.method !== "POST" || !pathname.endsWith("/chat/completions")) {
        console.log(`[fake-openai] 404 ${req.method} ${pathname}`);
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Unhandled ${req.method} ${pathname}` } }));
        return;
      }
      let parsed: { stream?: boolean; messages?: Array<{ role?: string; content?: unknown }> } = {};
      try { parsed = JSON.parse(bodyText); } catch { /* ignore */ }
      const isStream = parsed.stream !== false;
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const lastUserText = typeof lastUser?.content === "string"
        ? lastUser.content
        : JSON.stringify(lastUser?.content ?? "");
      const hasToolResult = messages.some((m) => m.role === "tool");
      const isTitleRequest = !lastUserText.includes("EDGE_SAY[") && !lastUserText.includes("EDGE_TOOL[");
      console.log(`[fake-openai] ${req.method} ${pathname} stream=${isStream} title=${isTitleRequest} msgs=${messages.length} user=${lastUserText.slice(0, 80).replace(/\s+/g, " ")}`);
      if (!isTitleRequest) {
        requestCount += 1;
        for (const wake of reqWaiters.splice(0)) wake();
      }

      let toolCommand: string | null = null;
      if (!hasToolResult && !isTitleRequest) {
        for (const match of lastUserText.matchAll(TOOL_RE)) toolCommand = match[1]!;
      }
      let replyText = isTitleRequest ? "Edge Session" : "edge-default-reply";
      for (const match of lastUserText.matchAll(SAY_RE)) replyText = match[1]!;

      const held = isTitleRequest ? null : hold;
      if (!isTitleRequest) hold = null;
      const sendResponse = () => {
        if (res.writableEnded || res.destroyed) return;
        const id = `chatcmpl_edge_${requestCount}`;
        const created = Math.floor(Date.now() / 1000);
        if (!isStream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model: "edge-model",
            choices: [{
              index: 0,
              message: { role: "assistant", content: replyText },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          }));
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: "edge-model",
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`;

        if (toolCommand) {
          res.write(chunk({
            role: "assistant",
            content: null,
            tool_calls: [{
              index: 0,
              id: `call_edge_${requestCount}`,
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: toolCommand, description: "Run edge test command" }),
              },
            }],
          }));
          res.write(chunk({}, "tool_calls"));
        } else {
          res.write(chunk({ role: "assistant", content: replyText }));
          res.write(`data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: "edge-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      };

      if (held) {
        void held.then(sendResponse);
      } else {
        sendResponse();
      }
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
    async waitForRequest(targetCount, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (requestCount < targetCount && Date.now() < deadline) {
        await Promise.race([
          new Promise<void>((resolveWake) => reqWaiters.push(resolveWake)),
          new Promise<void>((resolveTick) => setTimeout(resolveTick, 50)),
        ]);
      }
      if (requestCount < targetCount) throw new Error(`Timed out waiting for LLM request #${targetCount}`);
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
  let sessionSeq = 0;
  let turnSeq = 0;
  let assistantSeq = 0;
  let partSeq = 0;
  let permSeq = 0;
  let callSeq = 0;
  let genericIdSeq = 0;

  // First pass: discover exact session, user turn, assistant message, part, permission, and call IDs in chronological order.
  const bind = (raw: unknown, prefix: string, counter: () => number): void => {
    if (typeof raw !== "string" || !raw || idMap.has(raw)) return;
    idMap.set(raw, `<${prefix}-${counter()}>`);
  };

  const scanIds = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(scanIds); return; }
    const obj = node as Record<string, unknown>;
    if (typeof obj.path === "string") {
      const sesMatch = obj.path.match(/\/session\/([^/?]+)/);
      if (sesMatch?.[1] && sesMatch[1] !== "status" && !idMap.has(sesMatch[1])) {
        sessionSeq += 1;
        idMap.set(sesMatch[1], sessionSeq === 1 ? "<session>" : `<session-${sessionSeq}>`);
      }
      const permMatch = obj.path.match(/\/permission\/([^/?]+)/);
      if (permMatch?.[1]) bind(permMatch[1], "perm", () => ++permSeq);
    }
    if (obj.kind === "http" && obj.path === "/session" && obj.method === "POST") {
      const body = obj.body as Record<string, unknown> | undefined;
      if (typeof body?.id === "string" && !idMap.has(body.id)) {
        sessionSeq += 1;
        idMap.set(body.id, sessionSeq === 1 ? "<session>" : `<session-${sessionSeq}>`);
      }
    }
    if (typeof obj.messageID === "string" && obj.method === "POST") {
      bind(obj.messageID, "turn", () => ++turnSeq);
    }
    if (obj.body && typeof obj.body === "object" && !Array.isArray(obj.body)) {
      const b = obj.body as Record<string, unknown>;
      if (typeof b.messageID === "string") bind(b.messageID, "turn", () => ++turnSeq);
    }
    if (obj.role === "user" && typeof obj.id === "string") bind(obj.id, "turn", () => ++turnSeq);
    if (obj.role === "assistant" && typeof obj.id === "string") bind(obj.id, "assistant", () => ++assistantSeq);
    if (typeof obj.partID === "string") bind(obj.partID, "part", () => ++partSeq);
    if (typeof obj.callID === "string") bind(obj.callID, "call", () => ++callSeq);
    if (typeof obj.sessionID === "string" && !idMap.has(obj.sessionID)) {
      sessionSeq += 1;
      idMap.set(obj.sessionID, sessionSeq === 1 ? "<session>" : `<session-${sessionSeq}>`);
    }
    if (typeof obj.requestID === "string") bind(obj.requestID, "perm", () => ++permSeq);
    if (obj.type === "permission.asked" && obj.properties && typeof obj.properties === "object") {
      const p = obj.properties as Record<string, unknown>;
      bind(p.id, "perm", () => ++permSeq);
    }
    if (typeof obj.id === "string" && obj.id.startsWith("prt_")) bind(obj.id, "part", () => ++partSeq);
    if (typeof obj.id === "string" && obj.id.startsWith("per_")) bind(obj.id, "perm", () => ++permSeq);
    if (typeof obj.id === "string" && obj.id.startsWith("ses_")) {
      if (!idMap.has(obj.id)) {
        sessionSeq += 1;
        idMap.set(obj.id, sessionSeq === 1 ? "<session>" : `<session-${sessionSeq}>`);
      }
    }
    if (typeof obj.projectID === "string" && obj.projectID !== "global") {
      bind(obj.projectID, "project", () => ++genericIdSeq);
    }
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
    out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
    out = out.replace(/\/private\/var\/folders\/[^\s"']+/g, "<workspace>");
    out = out.replace(/\/var\/folders\/[^\s"']+/g, "<workspace>");
    out = out.replace(/http:\/\/127\.0\.0\.1:\d+/g, "http://127.0.0.1:<port>");
    if (hostName && hostName.length >= 4 && out.includes(hostName)) out = out.split(hostName).join("replay-host");
    if (userName && userName.length >= 3 && out.includes(`/${userName}/`)) {
      out = out.split(`/${userName}/`).join("/replay-user/");
    }
    return out;
  };

  const scrubValue = (value: unknown, key = ""): JsonValue => {
    if (value === null || value === undefined) return null;
    if (typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
      if (/^(?:apiKey|password|token|secret|authorization|cookie)$/i.test(key)) return "<redacted>";
      return scrubString(value);
    }
    if (Array.isArray(value)) return value.map((item) => scrubValue(item));
    if (typeof value === "object") {
      const out: JsonObject = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k === "parts" && key === "body" && Array.isArray(v)) {
          out[k] = v.map((part) => {
            if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
              return { type: "text", text: "<prompt>" };
            }
            return scrubValue(part);
          });
          continue;
        }
        out[k] = scrubValue(v, k);
      }
      return out;
    }
    return String(value);
  };

  // Filter out noisy repeated polling frames (/global/health retries, /session/status polls, /config, etc.)
  // while keeping EVERY authoritative startup, prompt, SSE, permission, abort, and exit frame!
  const entries: ProviderReplayEntry[] = [];
  let sawHealth = false;
  let sawCreateSession = false;
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i]!;
    if (raw.type === "runtime_exit") continue;
    const frame = raw.frame ?? {};
    const pathStr = typeof frame.path === "string" ? frame.path.split("?")[0]! : "";
    const methodStr = typeof frame.method === "string" ? frame.method : "";
    if (raw.type === "expect_outbound") {
      if (methodStr === "GET" && pathStr === "/global/health") {
        if (sawHealth) continue;
        sawHealth = true;
      } else if (methodStr === "POST" && pathStr === "/session") {
        sawCreateSession = true;
      } else if (
        pathStr.endsWith("/prompt_async") ||
        pathStr.endsWith("/abort") ||
        /\/permission\/[^/]+\/reply$/.test(pathStr)
      ) {
        // Keep exact control mutations.
      } else {
        continue;
      }
      entries.push({
        type: "expect_outbound",
        label: scrubString(raw.label || `${methodStr} ${pathStr}`),
        frame: scrubValue(frame) as JsonObject,
      });
    } else if (raw.type === "emit_inbound") {
      if (frame.kind === "http") {
        if (methodStr === "GET" && pathStr === "/global/health") {
          if (entries.some((e) => e.type === "emit_inbound" && e.label === "response:GET /global/health")) continue;
        } else if (methodStr === "POST" && pathStr === "/session" && sawCreateSession) {
          if (entries.some((e) => e.type === "emit_inbound" && e.label === "response:POST /session")) continue;
        } else if (
          pathStr.endsWith("/prompt_async") ||
          pathStr.endsWith("/abort") ||
          /\/permission\/[^/]+\/reply$/.test(pathStr)
        ) {
          // Keep exact HTTP responses for control mutations.
        } else {
          continue;
        }
      } else if (frame.kind === "sse") {
        const ev = frame.event as Record<string, unknown> | undefined;
        const evType = String(ev?.type || "");
        if (![
          "message.updated",
          "message.part.updated",
          "message.part.delta",
          "permission.asked",
          "permission.replied",
          "session.idle",
          "session.error",
        ].includes(evType)) {
          continue;
        }
        // Skip user message echo updates (replay server builds user messages from prompt_async).
        const props = ev?.properties as Record<string, unknown> | undefined;
        const info = props?.info as Record<string, unknown> | undefined;
        const part = props?.part as Record<string, unknown> | undefined;
        if (info?.role === "user") continue;
        if (part && typeof part.messageID === "string" && idMap.get(part.messageID)?.startsWith("<turn-")) continue;
      }
      entries.push({
        type: "emit_inbound",
        label: scrubString(raw.label || "inbound"),
        frame: scrubValue(frame) as JsonObject,
      });
    }
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
    accountMethods: [],
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
    provider: "open-model",
    protocol: "opencode.server/http-sse",
    providerVersion: context.providerVersion,
    scenario: context.scenario,
    capture: {
      recorder: "apps/desktop/daemon/__tests__/edge/open-model/record-scenarios.ts",
      recordedWith: "real opencode binary + local OpenAI Chat Completions stand-in",
      platform: `${process.platform}-${process.arch}`,
      description: context.description,
      redactions: redactor.counts,
    },
  };
  return { start, entries: finalEntries, redactionContext };
}

async function runAndRecord(
  scenario: string,
  description: string,
  realOpencodeBin: string,
  providerVersion: string,
  driver: (ctx: {
    harness: Awaited<ReturnType<typeof startEdgeDaemon>>;
    agentConfig: EdgeAgentRegistration;
    llm: FakeLlmServer;
    daemonGeneration: number;
  }) => Promise<void>,
  permissionProfileId: string = "full_access",
): Promise<void> {
  const llm = await startFakeOpenAiServer();
  const captureDir = join(tmpdir(), `letagents-om-rec-${scenario}-${Date.now()}`);
  const captureFile = join(captureDir, "raw.ndjson");
  mkdirSync(captureDir, { recursive: true });
  const harness = await startEdgeDaemon({
    shims: [
      {
        name: "opencode",
        scriptPath: RECORD_CLI,
        envVar: "LETAGENTS_OPENCODE_BIN",
        env: {
          LETAGENTS_REAL_OPENCODE_BIN: realOpencodeBin,
          LETAGENTS_OPENCODE_CAPTURE_FILE: captureFile,
        },
      },
    ],
  });
  try {
    const roomId = `rec_om_${scenario}`;
    const entryId = `agent_rec_om_${scenario}`;
    const agentConfig: EdgeAgentRegistration = {
      entryId,
      roomId,
      provider: "open-model",
      displayName: `Record OpenModel ${scenario}`,
      model: "edge-model",
      permissionProfileId,
      openModelCredential: {
        apiKey: "sk-edge-local-record",
        baseUrl: llm.baseUrl,
        model: "edge-model",
        contextWindow: 128_000,
      },
    };
    const { daemonGeneration } = await harness.startAgent(agentConfig);
    await harness.waitForEntry(
      entryId,
      (e) => e.observed_state === "idle" && Boolean(e.provider_ref?.provider_continuation_id),
      60_000,
      `real opencode idle (${scenario})`,
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
      throw new Error(`Leaks found in recorded ${scenario}.ndjson: ${JSON.stringify(leaks.slice(0, 5))}`);
    }
    mkdirSync(FIXTURES_DIR, { recursive: true });
    writeFileSync(join(FIXTURES_DIR, `${scenario}.ndjson`), serialized, "utf8");
    console.log(`Recorded ${scenario}.ndjson (${entries.length} entries, 0 leaks)`);
  } finally {
    if (existsSync(captureFile)) {
      const nonHealth = readFileSync(captureFile, "utf8")
        .split("\n")
        .filter((l) => l && !l.includes("/global/health"))
        .map((l) => {
          const e = JSON.parse(l) as RawEntry;
          const ev = (e.frame as Record<string, unknown> | undefined)?.event as Record<string, unknown> | undefined;
          if (ev) {
            const props = (ev.properties ?? {}) as Record<string, unknown>;
            return `${e.type}:${e.label} ${JSON.stringify(props).slice(0, 260)}`;
          }
          return `${e.type}:${e.label} status=${(e.frame as Record<string, unknown> | undefined)?.status ?? ""}`;
        });
      if (nonHealth.length && process.env.LETAGENTS_RECORD_DEBUG === "1") {
        console.log(`[capture non-health ${scenario}] (${nonHealth.length} lines):\n${nonHealth.join("\n")}`);
      }
    }
    await harness.dispose().catch(() => undefined);
    await llm.close().catch(() => undefined);
    rmSync(captureDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.env[LIVE_ENV] !== "1") {
    throw new Error(`Set ${LIVE_ENV}=1 to record live OpenCode transcripts.`);
  }
  const realOpencodeBin = process.env.LETAGENTS_REAL_OPENCODE_BIN?.trim()
    || execFileSync("which", ["opencode"], { encoding: "utf8" }).trim();
  const providerVersion = execFileSync(realOpencodeBin, ["--version"], { encoding: "utf8" }).trim();
  console.log(`Recording with real opencode ${providerVersion} (${realOpencodeBin})`);

  await runAndRecord(
    "simple",
    "One room message produces exactly one OpenCode reply.",
    realOpencodeBin,
    providerVersion,
    async ({ harness, agentConfig }) => {
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "EDGE_SAY[open-model-ready]" });
      await harness.roomServer.waitForPublishedMessages(agentConfig.roomId, (m) => m.length >= 1, 30_000);
      await harness.waitForEntry(
        agentConfig.entryId,
        (e) => e.observed_state === "idle" && e.room_agent_state?.turn.state === "idle" && (e.room_agent_state?.inbox.pending_count ?? 0) === 0,
        20_000,
      );
    },
  );

  await runAndRecord(
    "fifo-order",
    "Three room messages (A in flight, B and C queued) execute strictly in FIFO order A -> B -> C.",
    realOpencodeBin,
    providerVersion,
    async ({ harness, agentConfig, llm }) => {
      const release = llm.holdNext();
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "First FIFO message EDGE_SAY[fifo-reply-1]" });
      await llm.waitForRequest(1, 20_000);
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Second FIFO message EDGE_SAY[fifo-reply-2]" });
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Third FIFO message EDGE_SAY[fifo-reply-3]" });
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

  await runAndRecord(
    "turn-interrupt",
    "Interrupt an active OpenCode turn via manifest.control_turn, then complete a follow-up turn.",
    realOpencodeBin,
    providerVersion,
    async ({ harness, agentConfig, llm, daemonGeneration }) => {
      const release = llm.holdNext();
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Long turn EDGE_SAY[never]" });
      await llm.waitForRequest(1, 20_000);
      const active = await harness.waitForEntry(
        agentConfig.entryId,
        (e) => e.room_agent_state?.turn.state === "responding" && Boolean(e.room_agent_state.turn.provider_turn_id),
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
        action_id: "rec-om-interrupt-1",
        action_sequence: 1,
        correction: null,
      });
      release();
      await harness.waitForEntry(
        agentConfig.entryId,
        (e) => e.observed_state === "idle" && e.room_agent_state?.turn.state === "idle",
        20_000,
      );
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Follow-up EDGE_SAY[after-interrupt-reply]" });
      await harness.roomServer.waitForPublishedMessages(agentConfig.roomId, (m) => m.length >= 1, 30_000);
      await harness.waitForEntry(
        agentConfig.entryId,
        (e) => e.observed_state === "idle" && e.room_agent_state?.turn.state === "idle" && (e.room_agent_state?.inbox.pending_count ?? 0) === 0,
        20_000,
      );
    },
  );

  await runAndRecord(
    "kill-recover",
    "Daemon SIGKILL mid-turn; live OpenCode completes turn and restarted daemon publishes exactly once.",
    realOpencodeBin,
    providerVersion,
    async ({ harness, agentConfig, llm }) => {
      const release = llm.holdNext();
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Survive kill EDGE_SAY[survived-daemon-kill]" });
      await llm.waitForRequest(1, 20_000);
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

  await runAndRecord(
    "handoff",
    "OpenCode survives daemon update handoff and completes a follow-up turn.",
    realOpencodeBin,
    providerVersion,
    async ({ harness, agentConfig }) => {
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Before handoff EDGE_SAY[before-handoff-reply]" });
      await harness.roomServer.waitForPublishedMessages(agentConfig.roomId, (m) => m.length >= 1, 30_000);
      await harness.waitForEntry(
        agentConfig.entryId,
        (e) => e.observed_state === "idle" && e.room_agent_state?.turn.state === "idle",
        20_000,
      );
      const { successorStatus } = await harness.handoffToSuccessor();
      await harness.reinstallCredentials(agentConfig, successorStatus.generation);
      await harness.waitForEntry(agentConfig.entryId, (e) => e.observed_state === "idle", 25_000);
      harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "After handoff EDGE_SAY[after-handoff-reply]" });
      await harness.roomServer.waitForPublishedMessages(agentConfig.roomId, (m) => m.length >= 2, 30_000);
      await harness.waitForEntry(
        agentConfig.entryId,
        (e) => e.observed_state === "idle" && e.room_agent_state?.turn.state === "idle" && (e.room_agent_state?.inbox.pending_count ?? 0) === 0,
        20_000,
      );
    },
  );

  await runAndRecord(
    "approval",
    "Real OpenCode emits permission.asked for a bash tool call and completes after signed host approval.",
    realOpencodeBin,
    providerVersion,
    async ({ harness, agentConfig }) => {
      harness.roomServer.enqueueMessage(agentConfig.roomId, {
        text: "Run tool EDGE_TOOL[echo edge-approved] EDGE_SAY[approval-granted-reply]",
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

  // Derive crash-loop from the real recorded startup handshake (/global/health + POST /session) of simple.ndjson.
  const simple = parseProviderReplayTranscript(
    readFileSync(join(FIXTURES_DIR, "simple.ndjson"), "utf8"),
    "simple.ndjson",
  );
  const startupOnly = simple.entries.filter((e) =>
    e.type !== "runtime_exit" &&
    (e.label === "GET /global/health" ||
      e.label === "response:GET /global/health" ||
      e.label === "POST /session" ||
      e.label === "response:POST /session"),
  );
  const crashEntries: ProviderReplayEntry[] = [
    ...startupOnly.map(({ line: _line, ...rest }) => rest),
    { type: "runtime_exit", requested: false, transportClosedBeforeExit: false, code: 1, signal: null },
  ];
  const crashStart: TranscriptStartEntry = {
    ...simple.start,
    scenario: "crash-loop",
    capture: {
      ...simple.start.capture,
      description: "Real OpenCode startup handshake followed by repeated unexpected exit code 1 until quarantine.",
      derivedFrom: "simple.ndjson startup handshake + synthetic non-zero runtime_exit",
    },
  };
  const crashText = serializeProviderReplayTranscript(crashStart, crashEntries);
  parseProviderReplayTranscript(crashText, "crash-loop.ndjson");
  writeFileSync(join(FIXTURES_DIR, "crash-loop.ndjson"), crashText, "utf8");
  console.log(`Wrote crash-loop.ndjson (${crashEntries.length} entries)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
