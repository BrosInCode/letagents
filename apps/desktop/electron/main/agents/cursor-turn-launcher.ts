import { spawn } from "node:child_process";

import type { ProviderProcessExit } from "./provider-evidence.js";
import {
  CURSOR_LIVE_MCP_CAPABILITY_TIMEOUT_MS,
  CURSOR_MCP_CONNECTOR_PARENT,
  CURSOR_SUPERVISED_AGENT_ENDPOINT,
  CURSOR_SUPERVISED_CONTROL_PLANE_PATHS,
  MAX_CURSOR_SESSION_ID_LENGTH,
  MAX_CURSOR_STREAM_EVENTS,
  MAX_CURSOR_STREAM_LINE_BYTES,
  MAX_DURABLE_TURN_STREAM_BYTES,
} from "./cursor-provider-constants.js";
import { safeCursorTerminalErrorDetail } from "./cursor-provider-evidence.js";
import {
  cursorSandboxDelegatingExecutablePaths,
  cursorSandboxPathVariants,
  cursorSandboxRuntimeReadSubpaths,
  escapeCursorSandboxRegex,
  isExactCursorLoopbackTestOrigin,
  validateCursorSandboxPaths,
  validateCursorSandboxRegexes,
} from "./cursor-sandbox-policy.js";

const CURSOR_MCP_CONNECTOR_ROOT_PATTERN = `^${escapeCursorSandboxRegex(CURSOR_MCP_CONNECTOR_PARENT)}/letagents-cursor-mcp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`;

export interface CursorCliChild {
  pid: number | null;
  exited: Promise<ProviderProcessExit>;
  /** Ordered stdout stream-json lines (raw, one JSON document per line). */
  onLine(listener: (line: string) => void): () => void;
  /** Bounded stderr tail — the provider-quota signature lives here (msg_1708). */
  stderrTail(): string;
  /** Trusted wrapper IPC detail for a failure that may prevent journal publication. */
  terminalError?(): string | null;
  /** Release a prepared wrapper only after its exact process identity is durable. */
  release(): void;
  /** Production wrappers resolve only after their journal and IPC handlers exist. */
  prepared?: Promise<void>;
  /** The wrapper proves retirement of its own native process group; filesystem authority is separate. */
  ownsDescendantReaping?: boolean;
  /** Production wrappers require their remote-authority journal before a live result is trusted. */
  requiresDurableTerminalEvidence?: boolean;
}

/**
 * v10 §3: the child sees the user's own environment; nothing is scrubbed or
 * curated here. This deliberately DIVERGES from the legacy engine's
 * CURSOR_CHILD_ENV_ALLOWLIST (cursor-runner.ts), which is a LetAgents-imposed
 * curation of exactly the kind v10 prohibits. If TrailDelta's task_38 spike
 * proves a real launch blocker (a CLAUDECODE-analogue), add that single
 * documented carve-out — not an allowlist.
 */
export function cursorCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base };
}

export function defaultLaunchTurn(input: {
  cursorBin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  deferStart?: boolean;
  statePath?: string;
  workspaceGenerationManifestPath?: string;
  deniedReadPaths?: string[];
  deniedReadSubpaths?: string[];
  deniedReadMetadataPaths?: string[];
  deniedReadWriteRegexes?: string[];
  deniedWriteRegexes?: string[];
  deniedWritePaths?: string[];
  deniedWriteStructuralPaths?: string[];
  deniedWriteSubpaths?: string[];
  deniedExecSubpaths?: string[];
  allowedWriteSubpaths?: string[];
  allowedReadSubpaths?: string[];
  allowedNetworkUnixSockets?: string[];
  /**
   * Directory roots under which the sandboxed agent may bind AND connect its
   * own private unix sockets (Cursor's headless worker IPC). Scoped to the
   * per-turn CURSOR_DATA_DIR so the inbound-bind allowance can never reach a
   * shared or ambient socket path.
   */
  allowedInternalUnixSocketRoots?: string[];
  mcpConnectorSocketPath?: string;
  mcpRuntimeEntryPath?: string;
  mcpRuntimeCwd?: string;
  mcpRuntimeEnv?: Readonly<Record<string, string>>;
  providerAuthorization?: string;
  restrictRemoteAuthority?: boolean;
  /** Injectable only through direct unit tests; adapter production never sets it. */
  testAgentUpstreamEndpoint?: string;
  /** Injectable only through direct unit tests; adapter production never sets it. */
  testControlPlaneUpstreamEndpoint?: string;
  /** Injectable only through direct loopback unit tests; adapter production never sets it. */
  testMcpCapabilityTimeoutMs?: number;
  /** Injectable only through direct unit tests; adapter production never sets it. */
  testStartupBarrier?: {
    path: string;
    stage: "mcp_listen" | "authority_listen" | "agent_listen";
  };
}): CursorCliChild {
  const deniedDelegatingExecutablePaths = cursorSandboxDelegatingExecutablePaths();
  const deniedReadPaths = validateCursorSandboxPaths(input.deniedReadPaths);
  const deniedReadSubpaths = validateCursorSandboxPaths(input.deniedReadSubpaths);
  const deniedReadMetadataPaths = validateCursorSandboxPaths(input.deniedReadMetadataPaths);
  const deniedReadWriteRegexes = validateCursorSandboxRegexes(input.deniedReadWriteRegexes);
  const deniedWriteRegexes = validateCursorSandboxRegexes(input.deniedWriteRegexes);
  const deniedWritePaths = validateCursorSandboxPaths(input.deniedWritePaths);
  const deniedWriteStructuralPaths = validateCursorSandboxPaths(input.deniedWriteStructuralPaths);
  const deniedWriteSubpaths = validateCursorSandboxPaths(input.deniedWriteSubpaths);
  const deniedExecSubpaths = validateCursorSandboxPaths(input.deniedExecSubpaths);
  const allowedWriteSubpaths = validateCursorSandboxPaths(input.allowedWriteSubpaths);
  const allowedReadSubpaths = input.allowedReadSubpaths?.length
    ? validateCursorSandboxPaths([
      ...input.allowedReadSubpaths,
      ...cursorSandboxRuntimeReadSubpaths(input.cursorBin, input.cwd, input.env ?? process.env),
    ])
    : [];
  const allowedNetworkUnixSockets = validateCursorSandboxPaths(
    (input.allowedNetworkUnixSockets ?? []).flatMap(cursorSandboxPathVariants),
  );
  const allowedInternalUnixSocketRoots = validateCursorSandboxPaths(
    (input.allowedInternalUnixSocketRoots ?? []).flatMap(cursorSandboxPathVariants),
  );
  if (input.statePath) {
    const streamPaths = validateCursorSandboxPaths(
      cursorSandboxPathVariants(input.statePath),
    );
    const terminalPaths = validateCursorSandboxPaths(
      cursorSandboxPathVariants(`${input.statePath}.terminal.json`),
    );
    deniedReadPaths.push(...streamPaths, ...terminalPaths);
    deniedWritePaths.push(...streamPaths, ...terminalPaths);
    deniedReadWriteRegexes.push(...terminalPaths.map((terminalPath) =>
      `^${escapeCursorSandboxRegex(terminalPath)}[.]tmp-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$`
    ));
  }
  const restrictRemoteAuthority = input.restrictRemoteAuthority === true;
  const providerAuthorization = input.providerAuthorization;
  const agentUpstreamEndpoint = input.testAgentUpstreamEndpoint ?? CURSOR_SUPERVISED_AGENT_ENDPOINT;
  const controlPlaneUpstreamEndpoint = input.testControlPlaneUpstreamEndpoint ?? "https://api2.cursor.sh";
  if (agentUpstreamEndpoint !== CURSOR_SUPERVISED_AGENT_ENDPOINT
    && !isExactCursorLoopbackTestOrigin(agentUpstreamEndpoint)) {
    throw new Error("Cursor's supervised agent upstream test seam requires an exact loopback HTTP/2 origin.");
  }
  if (controlPlaneUpstreamEndpoint !== "https://api2.cursor.sh"
    && !isExactCursorLoopbackTestOrigin(controlPlaneUpstreamEndpoint)) {
    throw new Error("Cursor's supervised control-plane upstream test seam requires an exact loopback HTTP origin.");
  }
  const testStartupBarrier = input.testStartupBarrier;
  if (testStartupBarrier && (
    !restrictRemoteAuthority
    || !input.testAgentUpstreamEndpoint
    || !input.testControlPlaneUpstreamEndpoint
    || !isExactCursorLoopbackTestOrigin(input.testAgentUpstreamEndpoint)
    || !isExactCursorLoopbackTestOrigin(input.testControlPlaneUpstreamEndpoint)
    || !/^(?:\/private)?\/tmp\/letagents-cursor-startup-barrier-[A-Za-z0-9]{6,64}\/(?:mcp_listen|authority_listen|agent_listen)$/.test(testStartupBarrier.path)
    || !testStartupBarrier.path.endsWith(`/${testStartupBarrier.stage}`)
  )) {
    throw new Error("Cursor's startup barrier is restricted to exact loopback unit tests.");
  }
  const testMcpCapabilityTimeoutMs = input.testMcpCapabilityTimeoutMs;
  if (testMcpCapabilityTimeoutMs !== undefined && (
    !restrictRemoteAuthority
    || !input.testAgentUpstreamEndpoint
    || !input.testControlPlaneUpstreamEndpoint
    || !isExactCursorLoopbackTestOrigin(input.testAgentUpstreamEndpoint)
    || !isExactCursorLoopbackTestOrigin(input.testControlPlaneUpstreamEndpoint)
    || !Number.isSafeInteger(testMcpCapabilityTimeoutMs)
    || testMcpCapabilityTimeoutMs < 1
    || testMcpCapabilityTimeoutMs > CURSOR_LIVE_MCP_CAPABILITY_TIMEOUT_MS
  )) {
    throw new Error("Cursor's live MCP capability timeout seam is restricted to bounded exact-loopback unit tests.");
  }
  const mcpCapabilityTimeoutMs = testMcpCapabilityTimeoutMs
    ?? CURSOR_LIVE_MCP_CAPABILITY_TIMEOUT_MS;
  if (restrictRemoteAuthority && (!providerAuthorization
    || !/^Bearer [^\s\0]{1,16384}$/.test(providerAuthorization))) {
    throw new Error("Supervised Cursor requires an in-memory live provider authorization proof.");
  }
  if (restrictRemoteAuthority && (!input.mcpConnectorSocketPath
    || !input.mcpRuntimeEntryPath
    || !input.mcpRuntimeCwd
    || !input.mcpRuntimeEnv)) {
    throw new Error("Supervised Cursor requires a wrapper-owned MCP connector boundary.");
  }
  if (restrictRemoteAuthority
    && (allowedWriteSubpaths.length === 0 || allowedReadSubpaths.length === 0)) {
    throw new Error("Supervised Cursor requires non-empty read and write sandbox allow-lists.");
  }
  if (restrictRemoteAuthority && input.args.some((arg) =>
    arg === "-e"
      || arg === "--endpoint"
      || arg.startsWith("--endpoint=")
      || arg === "--agent-endpoint"
      || arg.startsWith("--agent-endpoint=")
      || arg === "--auth-token"
      || arg.startsWith("--auth-token=")
      || arg === "--http-version"
      || arg.startsWith("--http-version="))) {
    throw new Error("Supervised Cursor endpoint and authentication flags are adapter-owned.");
  }
  // The wrapper is the durable process identity. It does not launch Cursor
  // until release(), allowing the daemon to checkpoint PID + birth identity
  // before any model/tool side effect. It also mirrors the exact stream and a
  // terminal record to an owner-private file for restart/handoff recovery.
const wrapperSource = String.raw`
const { appendFileSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { randomBytes, randomUUID } = require("node:crypto");
const http = require("node:http");
const http2 = require("node:http2");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const [bin, statePath, workspaceGenerationManifestPath, deniedReadPathsJson, deniedReadSubpathsJson, deniedReadMetadataPathsJson, deniedReadWriteRegexesJson, deniedWriteRegexesJson, deniedWritePathsJson, deniedWriteStructuralPathsJson, deniedWriteSubpathsJson, deniedExecSubpathsJson, allowedWriteSubpathsJson, allowedReadSubpathsJson, allowedNetworkUnixSocketsJson, allowedInternalUnixSocketRootsJson, mcpConnectorSocketPath, mcpRuntimeEntryPath, mcpRuntimeCwd, testStartupBarrierPath, testStartupBarrierStage, mcpCapabilityTimeoutMsValue, restrictRemoteAuthorityValue, ...args] = process.argv.slice(1);
const deniedReadPaths = JSON.parse(deniedReadPathsJson || "[]");
const deniedReadSubpaths = JSON.parse(deniedReadSubpathsJson || "[]");
const deniedReadMetadataPaths = JSON.parse(deniedReadMetadataPathsJson || "[]");
const deniedReadWriteRegexes = JSON.parse(deniedReadWriteRegexesJson || "[]");
const deniedWriteRegexes = JSON.parse(deniedWriteRegexesJson || "[]");
const deniedWritePaths = JSON.parse(deniedWritePathsJson || "[]");
const deniedWriteStructuralPaths = JSON.parse(deniedWriteStructuralPathsJson || "[]");
const deniedWriteSubpaths = JSON.parse(deniedWriteSubpathsJson || "[]");
const deniedExecSubpaths = JSON.parse(deniedExecSubpathsJson || "[]");
const allowedWriteSubpaths = JSON.parse(allowedWriteSubpathsJson || "[]");
const allowedReadSubpaths = JSON.parse(allowedReadSubpathsJson || "[]");
const allowedNetworkUnixSockets = JSON.parse(allowedNetworkUnixSocketsJson || "[]");
const allowedInternalUnixSocketRoots = JSON.parse(allowedInternalUnixSocketRootsJson || "[]");
const restrictRemoteAuthority = restrictRemoteAuthorityValue === "1";
const mcpCapabilityTimeoutMs = Number(mcpCapabilityTimeoutMsValue);
if (!Number.isSafeInteger(mcpCapabilityTimeoutMs)
  || mcpCapabilityTimeoutMs < 1
  || mcpCapabilityTimeoutMs > ${CURSOR_LIVE_MCP_CAPABILITY_TIMEOUT_MS}) {
  throw new Error("Cursor MCP capability timeout is outside the turn-start boundary.");
}
let providerAuthorization = "";
// Cursor currently decodes the exp claim before honoring the documented argv token.
// Give each turn a fresh, syntactically JWT-shaped public placeholder. It is
// not provider authentication (the trusted proxy replaces it upstream), but
// its unpredictability is a local capability: a process left from an abnormal
// predecessor cannot regain proxy authority if the kernel later reuses either
// loopback port.
const publicAuthPlaceholder = [
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0",
  Buffer.from(JSON.stringify({
    exp: 4102444800,
    sub: "letagents-supervised-proxy-" + randomUUID(),
  })).toString("base64url"),
  randomBytes(24).toString("base64url"),
].join(".");
const expectedProxyAuthorization = "Bearer " + publicAuthPlaceholder;
const supervisedAgentEndpoint = ${JSON.stringify(agentUpstreamEndpoint)};
const supervisedControlPlaneEndpoint = ${JSON.stringify(controlPlaneUpstreamEndpoint)};
const supervisedControlPlanePaths = new Set(${JSON.stringify(CURSOR_SUPERVISED_CONTROL_PLANE_PATHS)});
const deniedDelegatingExecutables = ${JSON.stringify(deniedDelegatingExecutablePaths)};
const mcpConnectorRootPattern = new RegExp(${JSON.stringify(CURSOR_MCP_CONNECTOR_ROOT_PATTERN)});
let started = false;
let startPromise = null;
let native = null;
let authorityProxy = null;
let agentProxy = null;
let mcpConnectorServer = null;
let mcpConnectorSocket = null;
let mcpRuntime = null;
let mcpRuntimeProcessIdentity = null;
let mcpRuntimeEnv = null;
let mcpConnectorAdmitted = false;
let mcpCapabilityAttested = !restrictRemoteAuthority;
let mcpCapabilityDeadline = null;
// Model-authority requests that reached the agent proxy before live MCP
// attestation resolved. Cursor opens its model connection at startup in
// parallel with the MCP handshake that attestation validates, so a request can
// legitimately arrive first. Such requests are held here -- never rejected
// mid-startup -- and released the instant attestation settles. The set drains
// exactly once per outcome, so no held request can outlive attestation.
const mcpCapabilityWaiters = new Set();
function settleMcpCapabilityWaiters(attested) {
  const pending = [...mcpCapabilityWaiters];
  mcpCapabilityWaiters.clear();
  for (const release of pending) release(attested);
}
const agentProxySessions = new Set();
const agentProxySockets = new Set();
const agentProxyInternalServers = new Set();
const agentProxyUpstreamSessions = new Set();
const agentProxyUpstreamStreams = new Set();
const authorityProxySockets = new Set();
const authorityProxyUpstreams = new Set();
let finalizing = false;
let authorityRetiring = false;
let authorityRetirementPromise = null;
let runtimeDataRetirementResult = null;
let persistedBytes = 0;
let exitEvidence = null;
let exitCode = 1;
let reapPromise = null;
let evidenceDrainTimer = null;
let pendingLine = "";
let droppingOversizedLine = false;
let sawInit = false;
let initSnapshot = null;
let resultSnapshot = null;
let sessionContractValid = true;
let streamContractComplete = true;
let observedSessionId = null;
let protocolErrorEmitted = false;
let streamBudgetExceeded = false;
let stderrBudgetExceeded = false;
let forwardedStreamBytes = 0;
let forwardedStreamEvents = 0;
let forwardedStderrBytes = 0;
const decoder = new StringDecoder("utf8");
let stateFd = statePath ? openSync(statePath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW) : null;
const maxPersistedBytes = ${MAX_DURABLE_TURN_STREAM_BYTES};
const maxLineBytes = ${MAX_CURSOR_STREAM_LINE_BYTES};
const maxStreamEvents = ${MAX_CURSOR_STREAM_EVENTS};
const maxStderrBytes = 256 * 1024;
const maxSessionLength = ${MAX_CURSOR_SESSION_ID_LENGTH};
const sessionPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const terminalPath = statePath ? statePath + ".terminal.json" : "";
const resumeArgument = args.find((arg) => typeof arg === "string" && arg.startsWith("--resume="));
const expectedSessionId = resumeArgument ? resumeArgument.slice("--resume=".length) : null;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitAtTestStartupBarrier(stage) {
  if (!testStartupBarrierPath || testStartupBarrierStage !== stage) return;
  mkdirSync(testStartupBarrierPath, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(testStartupBarrierPath, "ready"), stage + "\n", { mode: 0o600 });
  const releasePath = path.join(testStartupBarrierPath, "release");
  while (!finalizing && !authorityRetiring && !existsSync(releasePath)) await wait(5);
}
function recordCausalTerminalError(detail) {
  if (exitEvidence) return;
  exitEvidence = { type: "error", error: detail };
  // The wrapper-only IPC fallback keeps live diagnostics deterministic even
  // if emergency group reaping prevents the durable terminal rename.
  try { if (process.send) process.send({ type: "terminal_error", error: detail }); } catch {}
}
function forwardBoundedStderr(source, label) {
  source.on("data", (value) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (stderrBudgetExceeded) return;
    const remaining = Math.max(0, maxStderrBytes - forwardedStderrBytes);
    const bounded = chunk.subarray(0, remaining);
    forwardedStderrBytes += bounded.length;
    if (bounded.length && !process.stderr.write(bounded)) {
      source.pause();
      process.stderr.once("drain", () => source.resume());
    }
    if (chunk.length <= remaining) return;
    stderrBudgetExceeded = true;
    const detail = label + " exceeded the supervised stderr byte budget.";
    recordCausalTerminalError(detail);
    exitCode = 1;
    if (native) void beginFatalReaping();
    else void finishNotStarted(detail);
  });
}
function terminal(value) {
  if (!terminalPath) return;
  const tmp = terminalPath + ".tmp-" + randomUUID();
  writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(tmp, terminalPath);
}
function validSession(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxSessionLength
    && sessionPattern.test(value);
}
function emitProtocolError(detail) {
  if (protocolErrorEmitted) return;
  protocolErrorEmitted = true;
  process.stdout.write(JSON.stringify({
    type: "letagents_stream_contract_error",
    session_id: "",
    error: detail || "Cursor violated the bounded stream-json contract.",
  }) + "\n");
}
function exceedStreamBudget(detail) {
  if (streamBudgetExceeded) return;
  streamBudgetExceeded = true;
  streamContractComplete = false;
  pendingLine = "";
  emitProtocolError(detail);
  recordCausalTerminalError(detail);
  void beginFatalReaping();
}
function inspectLine(line) {
  if (streamBudgetExceeded) return;
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (lineBytes > maxLineBytes) {
    streamContractComplete = false;
    emitProtocolError("Cursor emitted an oversized stream-json line.");
    return;
  }
  if (forwardedStreamEvents >= maxStreamEvents) {
    exceedStreamBudget("Cursor exceeded the bounded stream-json event budget.");
    return;
  }
  if (forwardedStreamBytes + lineBytes + 1 > maxPersistedBytes) {
    exceedStreamBudget("Cursor exceeded the bounded aggregate stream-json byte budget.");
    return;
  }
  forwardedStreamEvents += 1;
  forwardedStreamBytes += lineBytes + 1;
  process.stdout.write(line + "\n");
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return;
  let message;
  try { message = JSON.parse(trimmed); }
  catch {
    streamContractComplete = false;
    emitProtocolError("Cursor emitted malformed stream-json output.");
    return;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const hasSession = Object.prototype.hasOwnProperty.call(message, "session_id");
  const sessionId = validSession(message.session_id) ? message.session_id : null;
  if (hasSession && !sessionId) sessionContractValid = false;
  if (sessionId) {
    const contractSession = expectedSessionId || observedSessionId;
    if (contractSession && sessionId !== contractSession) sessionContractValid = false;
  }
  if (message.type === "system" && message.subtype === "init") {
    if (!sessionId) sessionContractValid = false;
    else {
      if (observedSessionId && observedSessionId !== sessionId) sessionContractValid = false;
      observedSessionId = sessionId;
      sawInit = true;
      initSnapshot = { type: "system", subtype: "init", session_id: sessionId };
    }
  }
  if (message.type === "result") {
    if (!sawInit) {
      sessionContractValid = false;
      emitProtocolError("Cursor emitted a result before its verified init event.");
    }
    const result = typeof message.result === "string" ? message.result : null;
    if (result !== null && Buffer.byteLength(result, "utf8") > maxLineBytes) {
      streamContractComplete = false;
      return;
    }
    resultSnapshot = {
      type: "result",
      subtype: typeof message.subtype === "string" ? message.subtype : null,
      ...(sessionId ? { session_id: sessionId } : {}),
      is_error: message.is_error,
      result,
      request_id: typeof message.request_id === "string" ? message.request_id : null,
    };
  }
}
function consumeText(text) {
  let cursor = 0;
  while (cursor < text.length) {
    if (streamBudgetExceeded) return;
    const newline = text.indexOf("\n", cursor);
    if (droppingOversizedLine) {
      if (newline === -1) return;
      droppingOversizedLine = false;
      cursor = newline + 1;
      continue;
    }
    if (newline === -1) {
      const segment = text.slice(cursor);
      if (Buffer.byteLength(pendingLine, "utf8") + Buffer.byteLength(segment, "utf8") > maxLineBytes) {
        streamContractComplete = false;
        pendingLine = "";
        droppingOversizedLine = true;
        emitProtocolError("Cursor emitted an oversized stream-json line.");
      } else {
        pendingLine += segment;
      }
      return;
    }
    const segment = text.slice(cursor, newline);
    if (Buffer.byteLength(pendingLine, "utf8") + Buffer.byteLength(segment, "utf8") > maxLineBytes) {
      streamContractComplete = false;
      pendingLine = "";
      emitProtocolError("Cursor emitted an oversized stream-json line.");
      cursor = newline + 1;
      continue;
    }
    pendingLine += segment;
    inspectLine(pendingLine.endsWith("\r") ? pendingLine.slice(0, -1) : pendingLine);
    pendingLine = "";
    cursor = newline + 1;
  }
}
function flushParser() {
  consumeText(decoder.end());
  if (!droppingOversizedLine && pendingLine) inspectLine(pendingLine);
  pendingLine = "";
}
function processGroupMembers(groupId, excludedPid = null) {
  if (process.platform === "win32") return [];
  try {
    // The detached ps probe cannot become a false member of either supervised
    // process group. A live group leader also prevents its PGID from being
    // recycled while retirement is inspecting it.
    const inspected = spawnSync("/bin/ps", ["-axo", "pid=,pgid="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], detached: true,
      timeout: 250, maxBuffer: 1024 * 1024,
    });
    if (inspected.error || inspected.status !== 0 || typeof inspected.stdout !== "string") return null;
    return inspected.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) return [];
      const pid = Number(match[1]);
      const pgid = Number(match[2]);
      return pgid === groupId && pid !== excludedPid ? [pid] : [];
    });
  } catch { return null; }
}
function exactProcessGroupLeaderIdentity(pid, expectedParentPid) {
  if (process.platform === "win32") return undefined;
  if (!Number.isSafeInteger(pid) || pid <= 1
    || !Number.isSafeInteger(expectedParentPid) || expectedParentPid <= 1) return undefined;
  try {
    const inspected = spawnSync("/bin/ps", [
      "-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart=",
    ], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], detached: true,
      timeout: 250, maxBuffer: 16 * 1024,
    });
    if (inspected.error || typeof inspected.stdout !== "string") return undefined;
    const output = inspected.stdout.trim();
    if (!output) return inspected.status === 1 ? null : undefined;
    if (inspected.status !== 0) return undefined;
    const match = output.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return undefined;
    const observedPid = Number(match[1]);
    const observedParentPid = Number(match[2]);
    const observedGroupId = Number(match[3]);
    const birthIdentity = match[4].trim();
    if (observedPid !== pid || observedParentPid !== expectedParentPid
      || observedGroupId !== pid || !birthIdentity) return null;
    return birthIdentity;
  } catch {
    return undefined;
  }
}
function ownGroupMembers() {
  // This wrapper remains the process-group leader until every native
  // descendant is gone.
  return processGroupMembers(process.pid, process.pid);
}
function signalNativeGroup(signal) {
  if (!native) return;
  if (process.platform === "win32") {
    try { native.kill(signal); } catch {}
    return;
  }
  try { process.kill(-process.pid, signal); }
  catch (error) { if (!error || error.code !== "ESRCH") throw error; }
}
async function reapNativeGroup() {
  // macOS exposes no cgroup/job-object equivalent to an unprivileged desktop
  // process. A deliberately detached setsid child can leave this PGID. The
  // wrapper therefore records this exact scope (never "all descendants") and
  // revokes every remote turn capability/proxy separately before terminal
  // evidence. Filesystem authority is retired by the supervisor's distinct
  // workspace-generation boundary, never inferred from this process-group
  // observation.
  if (!native) return true;
  if (process.platform === "win32") return false;
  let members = ownGroupMembers();
  if (members === null || members.length > 0) {
    signalNativeGroup("SIGTERM");
    const graceDeadline = Date.now() + 500;
    while (Date.now() < graceDeadline) {
      await wait(25);
      members = ownGroupMembers();
      if (members !== null && members.length === 0) break;
    }
  }
  if (members === null || members.length > 0) {
    // The still-live wrapper is the exact group leader, so its PGID cannot be
    // recycled. A forced group kill also kills this wrapper; leave no possibly
    // truncated terminal record and let successor recovery fail closed.
    signalNativeGroup("SIGKILL");
    await new Promise(() => {});
  }
  return true;
}
function beginReaping() {
  if (!reapPromise) reapPromise = reapNativeGroup();
  return reapPromise;
}
function beginFatalReaping() {
  const authorityRetirement = beginTurnAuthorityRetirement();
  if (!reapPromise) {
    reapPromise = (async () => {
      await authorityRetirement;
      return reapNativeGroup();
    })();
  }
  return reapPromise;
}
function armEvidenceDrainDeadline() {
  if (evidenceDrainTimer) return;
  evidenceDrainTimer = setTimeout(() => {
    void (async () => {
      await beginTurnAuthorityRetirement();
      retireTurnRuntimeData();
      try { purgePublicPlaceholderCredentialFile(); } catch {}
      if (stateFd !== null) { try { closeSync(stateFd); } catch {} stateFd = null; }
      // No terminal record: inherited evidence pipes never closed, so a
      // successor must fail closed instead of accepting a truncated stream.
      process.exit(1);
    })();
  }, 3000);
}
function failStreamPersistence(error) {
  streamContractComplete = false;
  if (stateFd !== null) { try { closeSync(stateFd); } catch {} stateFd = null; }
  recordCausalTerminalError("Cursor durable stream persistence failed: " + (error && error.message ? error.message : String(error)));
  exitCode = 1;
  void beginFatalReaping();
}
function failMcpCapabilityAttestation(detail) {
  if (finalizing || authorityRetiring) return;
  if (mcpCapabilityDeadline) clearTimeout(mcpCapabilityDeadline);
  mcpCapabilityDeadline = null;
  mcpCapabilityAttested = false;
  // Release any held model request as rejected. recordCausalTerminalError below
  // captures detail as the durable terminal reason, so the displayed failure is
  // this exact cause -- not the generic connector-ended message a later socket
  // close would otherwise record first.
  settleMcpCapabilityWaiters(false);
  if (resultSnapshot) {
    // The native provider has already emitted its terminal turn result. No
    // further model authority is legitimate; retire the lease normally.
    void beginTurnAuthorityRetirement();
    return;
  }
  // The private durable terminal remains authoritative for recovery. The
  // wrapper-only IPC fallback remains live-only and cannot be forged by native
  // Cursor or the MCP runtime because neither inherits the IPC descriptor.
  recordCausalTerminalError(detail);
  exitCode = 1;
  if (!native) {
    void finishNotStarted(detail, true);
    return;
  }
  void beginFatalReaping();
}
async function closeMcpConnector() {
  if (mcpCapabilityDeadline) clearTimeout(mcpCapabilityDeadline);
  mcpCapabilityDeadline = null;
  let runtimeClosed = true;
  let runtimeGroupClosed = true;
  const runtime = mcpRuntime;
  let runtimeGroupSignalAuthorized = false;
  let groupMembers = null;
  let signalRuntimeGroup = null;
  if (runtime) {
    const runtimeGroupId = runtime.pid;
    runtimeClosed = runtime.exitCode !== null || runtime.signalCode !== null;
    runtime.once("exit", () => { runtimeClosed = true; });
    runtime.once("error", () => { runtimeClosed = true; });
    if (process.platform === "win32") {
      runtimeGroupClosed = runtimeClosed;
      signalRuntimeGroup = (signal) => {
        try { runtime.kill(signal); } catch {}
      };
      if (!runtimeClosed) signalRuntimeGroup("SIGTERM");
    } else if (Number.isSafeInteger(runtimeGroupId) && runtimeGroupId > 1) {
      groupMembers = () => processGroupMembers(runtimeGroupId);
      signalRuntimeGroup = (signal) => {
        const currentIdentity = exactProcessGroupLeaderIdentity(runtimeGroupId, process.pid);
        if (!runtimeGroupSignalAuthorized
          || typeof mcpRuntimeProcessIdentity !== "string"
          || currentIdentity !== mcpRuntimeProcessIdentity) {
          runtimeGroupSignalAuthorized = false;
          return;
        }
        try { process.kill(-runtimeGroupId, signal); }
        catch (error) {
          // EPERM is not proof of absence. Keep polling the exact PGID below and
          // return false unless both the runtime and every group member vanish.
          if (error && (error.code === "ESRCH" || error.code === "EPERM")) return;
          throw error;
        }
      };
      runtimeGroupSignalAuthorized = typeof mcpRuntimeProcessIdentity === "string";
      // Re-prove the captured leader's birth and ancestry inside every signal
      // attempt, including escalation. POSIX offers no atomic identity+signal
      // primitive here, so this minimizes—but cannot erase—the final syscall
      // race. An absent, changed, or ambiguous leader permanently revokes the
      // numeric PGID's signal authority.
      if (runtimeGroupSignalAuthorized) signalRuntimeGroup("SIGTERM");
    }
  }
  if (mcpConnectorServer) { try { mcpConnectorServer.close(); } catch {} }
  mcpConnectorServer = null;
  let socketClosed = true;
  if (mcpConnectorSocket && !mcpConnectorSocket.destroyed) {
    socketClosed = false;
    mcpConnectorSocket.once("close", () => { socketClosed = true; });
    try { mcpConnectorSocket.destroy(); } catch {}
  }
  if (runtime) {
    try { runtime.stdin.end(); } catch {}
    let members = groupMembers ? groupMembers() : null;
    if (process.platform !== "win32") {
      runtimeGroupClosed = members !== null && members.length === 0;
      // Once a successful probe observes the original group empty, or any
      // probe is ambiguous, continuity is lost forever. A later process group
      // with the same number must not inherit this runtime's signal authority.
      if (members === null || runtimeGroupClosed) runtimeGroupSignalAuthorized = false;
    }
    const graceDeadline = Date.now() + 500;
    while ((!runtimeClosed || !runtimeGroupClosed) && Date.now() < graceDeadline) {
      await wait(25);
      if (process.platform === "win32") {
        runtimeGroupClosed = runtimeClosed;
      } else {
        members = groupMembers ? groupMembers() : null;
        runtimeGroupClosed = members !== null && members.length === 0;
        if (members === null || runtimeGroupClosed) runtimeGroupSignalAuthorized = false;
      }
    }
    if ((!runtimeClosed || !runtimeGroupClosed)
      && signalRuntimeGroup
      && (process.platform === "win32" || runtimeGroupSignalAuthorized)) {
      signalRuntimeGroup("SIGKILL");
      const killDeadline = Date.now() + 500;
      while ((!runtimeClosed || !runtimeGroupClosed) && Date.now() < killDeadline) {
        await wait(25);
        if (process.platform === "win32") {
          runtimeGroupClosed = runtimeClosed;
        } else {
          members = groupMembers ? groupMembers() : null;
          runtimeGroupClosed = members !== null && members.length === 0;
          if (members === null || runtimeGroupClosed) runtimeGroupSignalAuthorized = false;
        }
      }
    }
  }
  const socketDeadline = Date.now() + 500;
  while (!socketClosed && Date.now() < socketDeadline) await wait(5);
  const revoked = socketClosed && runtimeClosed && runtimeGroupClosed;
  if (socketClosed) mcpConnectorSocket = null;
  // Preserve ambiguous runtime evidence across repeated close attempts. Some
  // not-started paths deliberately call close twice around an in-flight start;
  // forgetting a non-retired group here would let the second call falsely
  // report that all remote authority was revoked.
  if (runtimeClosed && runtimeGroupClosed) {
    mcpRuntime = null;
    mcpRuntimeProcessIdentity = null;
  }
  const connectorRoot = path.dirname(mcpConnectorSocketPath || "");
  if (revoked && mcpConnectorRootPattern.test(connectorRoot)) {
    rmSync(connectorRoot, { recursive: true, force: true });
  }
  return revoked;
}
function purgePublicPlaceholderCredentialFile() {
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) throw new Error("missing private HOME");
  const credentialPath = path.join(home, ".cursor", "auth.json");
  let stat;
  try { stat = lstatSync(credentialPath); }
  catch (error) { if (error && error.code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("unexpected Cursor credential file");
  const parsed = JSON.parse(readFileSync(credentialPath, "utf8"));
  const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).sort() : [];
  if (keys.length !== 2 || keys[0] !== "accessToken" || keys[1] !== "refreshToken"
    || parsed.accessToken !== publicAuthPlaceholder || parsed.refreshToken !== publicAuthPlaceholder) {
    throw new Error("Cursor credential file contains unexpected authority");
  }
  unlinkSync(credentialPath);
}
function purgeTurnRuntimeDataRoot() {
  if (!restrictRemoteAuthority) return true;
  const root = process.env.CURSOR_DATA_DIR;
  if (typeof root !== "string"
    || !/^\/(?:private\/)?tmp\/letagents-cursor-data-[A-Za-z0-9]{6}$/.test(root)) {
    throw new Error("unexpected Cursor turn data root");
  }
  let stat;
  try { stat = lstatSync(root); }
  catch (error) { if (error && error.code === "ENOENT") return true; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("redirected Cursor turn data root");
  }
  rmSync(root, { recursive: true, force: true });
  try { lstatSync(root); }
  catch (error) { if (error && error.code === "ENOENT") return true; throw error; }
  throw new Error("Cursor turn data root survived retirement");
}
function validatedMcpRuntimeEnv(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("missing MCP runtime environment");
  const allowed = new Set(${JSON.stringify([
    "ELECTRON_RUN_AS_NODE", "LETAGENTS_API_URL", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    "XDG_CACHE_HOME", "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", "NODE_COMPILE_CACHE", "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN", "LETAGENTS_SUPERVISOR_ENTRY_ID", "LETAGENTS_SUPERVISOR_DAEMON_SOCKET",
    "LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID", "LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID",
    "LETAGENTS_SUPERVISOR_PROVIDER", "LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID",
    "LETAGENTS_SUPERVISOR_AGENT_SESSION_ID", "LETAGENTS_SUPERVISOR_ROOM_ID",
    "LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME", "LETAGENTS_SUPERVISED_BOUNDED_TURNS",
    "LETAGENTS_EXECUTION_PROFILE", "LETAGENTS_PERMISSION_PROFILE_ID",
  ])});
  const result = {};
  const entries = Object.entries(value);
  if (entries.length > allowed.size) throw new Error("oversized MCP runtime environment");
  for (const [key, entry] of entries) {
    if (!allowed.has(key) || typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry, "utf8") > 16 * 1024) {
      throw new Error("invalid MCP runtime environment");
    }
    result[key] = entry;
  }
  const required = [
    "LETAGENTS_API_URL", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
    "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", "NODE_COMPILE_CACHE", "LETAGENTS_SUPERVISOR_ENTRY_ID",
    "LETAGENTS_SUPERVISOR_DAEMON_SOCKET", "LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID",
    "LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID", "LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID",
    "LETAGENTS_SUPERVISOR_AGENT_SESSION_ID", "LETAGENTS_SUPERVISOR_ROOM_ID",
    "LETAGENTS_PERMISSION_PROFILE_ID",
  ];
  if (required.some((key) => !result[key])
    || result.ELECTRON_RUN_AS_NODE !== "1"
    || result.LETAGENTS_SUPERVISOR_PROVIDER !== "cursor"
    || result.LETAGENTS_SUPERVISED_BOUNDED_TURNS !== "1"
    || result.LETAGENTS_EXECUTION_PROFILE !== "supervised_room_turn"
    || !["read_only", "sandboxed_write", "full_access"].includes(result.LETAGENTS_PERMISSION_PROFILE_ID)
    || result.CURSOR_API_KEY !== ""
    || result.CURSOR_AUTH_TOKEN !== "") {
    throw new Error("incomplete MCP runtime environment");
  }
  return result;
}
function hasRequiredCompletionContract(response) {
  const tools = response && response.result && response.result.tools;
  if (!Array.isArray(tools)) return false;
  const matches = tools.filter((tool) => tool && tool.name === "complete_room_turn");
  if (matches.length !== 1) return false;
  const schema = matches[0].inputSchema;
  const properties = schema && schema.properties;
  const outcome = properties && properties.outcome;
  const text = properties && properties.text;
  return schema && typeof schema === "object" && !Array.isArray(schema)
    && schema.type === "object"
    && properties && typeof properties === "object" && !Array.isArray(properties)
    && outcome && typeof outcome === "object" && !Array.isArray(outcome)
    && outcome.type === "string"
    && Array.isArray(outcome.enum)
    && outcome.enum.length === 2
    && new Set(outcome.enum).size === 2
    && outcome.enum.includes("reply")
    && outcome.enum.includes("no_reply")
    && text && typeof text === "object" && !Array.isArray(text)
    && text.type === "string"
    && Array.isArray(schema.required)
    && schema.required.length === 1
    && schema.required[0] === "outcome";
}
// The wrapper hosts the MCP runtime itself, so it proves the complete_room_turn
// contract with its own bounded initialize/tools/list handshake before Cursor
// is launched. Attestation must never wait for the client's tools/list: Cursor
// defers tool listing until its agent bootstrap succeeds, and that bootstrap is
// exactly what the authority hold suspends, so gating model authority on client
// traffic deadlocks every supervised turn against its own hold.
function verifyHostedMcpRuntimeContract(runtime) {
  return new Promise((resolve, reject) => {
    const initializeId = "letagents-attest-init-" + randomUUID();
    const listId = "letagents-attest-tools-" + randomUUID();
    let inspectionBuffer = Buffer.alloc(0);
    let inspectionBytes = 0;
    let inspectionFrames = 0;
    const maxInspectionBytes = 1024 * 1024;
    const maxInspectionFrames = 256;
    let settled = false;
    let deadline = null;
    const finish = (error, leftover) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      deadline = null;
      runtime.stdout.removeListener("data", onData);
      runtime.removeListener("error", onRuntimeError);
      runtime.removeListener("close", onRuntimeClose);
      // Any bytes the runtime pipelined after the attested tools/list response
      // belong to the client stream; return them unconsumed for the connector.
      if (!error && leftover && leftover.length > 0) runtime.stdout.unshift(leftover);
      if (error) reject(error); else resolve();
    };
    const onRuntimeError = () => finish(new Error("Cursor's live MCP runtime failed before capability attestation."));
    const onRuntimeClose = () => finish(new Error("Cursor's live MCP runtime ended before capability attestation."));
    const onData = (chunk) => {
      if (settled) return;
      inspectionBytes += chunk.length;
      if (inspectionBytes > maxInspectionBytes) {
        finish(new Error("Cursor's live MCP runtime exceeded the bounded capability-attestation exchange."));
        return;
      }
      inspectionBuffer = Buffer.concat([inspectionBuffer, chunk]);
      for (;;) {
        const newline = inspectionBuffer.indexOf(10);
        if (newline < 0) break;
        inspectionFrames += 1;
        if (inspectionFrames > maxInspectionFrames) {
          finish(new Error("Cursor's live MCP runtime exceeded the bounded capability-attestation exchange."));
          return;
        }
        const line = inspectionBuffer.subarray(0, newline).toString("utf8").trim();
        inspectionBuffer = inspectionBuffer.subarray(newline + 1);
        if (!line) continue;
        let response;
        try { response = JSON.parse(line); }
        catch {
          finish(new Error("Cursor's live MCP runtime emitted invalid capability-attestation protocol."));
          return;
        }
        // Startup notifications from the runtime are legitimate protocol; only
        // the wrapper's own request ids participate in attestation.
        if (!response || (response.id !== initializeId && response.id !== listId)) continue;
        if (response.id === initializeId) {
          try {
            runtime.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            runtime.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: listId, method: "tools/list", params: {} }) + "\n");
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          continue;
        }
        if (!hasRequiredCompletionContract(response)) {
          finish(new Error("Cursor's live MCP runtime does not expose the required complete_room_turn contract."));
          return;
        }
        finish(null, inspectionBuffer);
        return;
      }
    };
    deadline = setTimeout(() => {
      finish(new Error("Cursor's hosted MCP runtime did not prove the complete_room_turn contract before launch."));
    }, mcpCapabilityTimeoutMs);
    runtime.stdout.on("data", onData);
    runtime.once("error", onRuntimeError);
    runtime.once("close", onRuntimeClose);
    try {
      runtime.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: initializeId,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "letagents-cursor-turn-wrapper", version: "1.0.0" },
        },
      }) + "\n");
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
function startMcpConnector() {
  if (!restrictRemoteAuthority) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const failStart = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const connectorRoot = path.dirname(mcpConnectorSocketPath);
    if (!mcpConnectorRootPattern.test(connectorRoot)
      || mcpConnectorSocketPath !== connectorRoot + "/stdio.sock"
      || mcpConnectorSocketPath.includes("\0")
      || Buffer.byteLength(mcpConnectorSocketPath, "utf8") > 100
      || !mcpRuntimeEntryPath.startsWith("/")
      || !mcpRuntimeCwd.startsWith("/")) {
      failStart(new Error("invalid MCP connector boundary"));
      return;
    }
    const expectedRuntimePaths = {
      HOME: connectorRoot + "/home",
      XDG_CONFIG_HOME: connectorRoot + "/config",
      XDG_DATA_HOME: connectorRoot + "/data",
      XDG_CACHE_HOME: connectorRoot + "/cache",
      CURSOR_CONFIG_DIR: connectorRoot + "/config/cursor",
      CURSOR_DATA_DIR: connectorRoot + "/data/cursor",
      NODE_COMPILE_CACHE: connectorRoot + "/cache/node-compile-cache",
    };
    if (Object.entries(expectedRuntimePaths).some(([key, value]) => mcpRuntimeEnv[key] !== value)) {
      failStart(new Error("MCP runtime state escaped its private connector root"));
      return;
    }
    try {
      mkdirSync(connectorRoot, { mode: 0o700 });
      for (const directory of [
        expectedRuntimePaths.HOME,
        expectedRuntimePaths.XDG_CONFIG_HOME,
        expectedRuntimePaths.XDG_DATA_HOME,
        expectedRuntimePaths.XDG_CACHE_HOME,
        expectedRuntimePaths.CURSOR_CONFIG_DIR,
        expectedRuntimePaths.CURSOR_DATA_DIR,
        expectedRuntimePaths.NODE_COMPILE_CACHE,
      ]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      void closeMcpConnector();
      failStart(error);
      return;
    }
    const runtime = spawn(process.execPath, [mcpRuntimeEntryPath], {
      cwd: mcpRuntimeCwd,
      env: mcpRuntimeEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    mcpRuntime = runtime;
    mcpRuntimeProcessIdentity = exactProcessGroupLeaderIdentity(runtime.pid, process.pid);
    if (process.platform !== "win32" && typeof mcpRuntimeProcessIdentity !== "string") {
      const detail = "Cursor's hosted MCP runtime did not expose an exact process-group birth identity.";
      try { runtime.kill("SIGTERM"); } catch {}
      failMcpCapabilityAttestation(detail);
      failStart(new Error(detail));
      return;
    }
    forwardBoundedStderr(runtime.stderr, "Cursor's hosted MCP runtime");
    verifyHostedMcpRuntimeContract(runtime).then(() => {
      if (finalizing || authorityRetiring) {
        failStart(new Error("Cursor MCP connector startup was cancelled."));
        return;
      }
      runtime.once("error", () => {
        failMcpCapabilityAttestation("Cursor's live MCP runtime failed before the turn became terminal.");
        if (mcpConnectorSocket) { try { mcpConnectorSocket.destroy(); } catch {} }
      });
      runtime.once("close", () => {
        failMcpCapabilityAttestation("Cursor's live MCP runtime ended before the turn became terminal.");
        if (mcpConnectorSocket) { try { mcpConnectorSocket.destroy(); } catch {} }
      });
      const server = net.createServer({ allowHalfOpen: false }, (socket) => {
        if (finalizing || authorityRetiring || mcpConnectorAdmitted) { socket.destroy(); return; }
        mcpConnectorAdmitted = true;
        mcpConnectorSocket = socket;
        // Cursor initializes MCP before it can execute model-directed code. One
        // accepted stdio connection prevents a later native/escaped process from
        // replaying this otherwise-readable connector path.
        server.close();
        if (runtime.exitCode !== null || runtime.signalCode !== null) {
          failMcpCapabilityAttestation("Cursor's live MCP runtime ended before the turn became terminal.");
          socket.destroy();
          return;
        }
        // The hosted runtime proved the completion contract before this
        // listener opened, so Cursor reaching the connector is the remaining
        // live evidence. Admit held model authority on the channel itself --
        // never on later client traffic, which the hold would deadlock.
        mcpCapabilityAttested = true;
        if (mcpCapabilityDeadline) clearTimeout(mcpCapabilityDeadline);
        mcpCapabilityDeadline = null;
        settleMcpCapabilityWaiters(true);
        socket.pipe(runtime.stdin);
        runtime.stdout.pipe(socket);
        socket.once("error", () => {
          failMcpCapabilityAttestation("Cursor's live MCP connector failed before the turn became terminal.");
          try { runtime.kill("SIGTERM"); } catch {}
        });
        socket.once("close", () => {
          failMcpCapabilityAttestation("Cursor's live MCP connector ended before the turn became terminal.");
          try { runtime.stdin.end(); } catch {}
        });
      });
      mcpConnectorServer = server;
      server.once("error", failStart);
      server.once("close", () => {
        if (!settled && (finalizing || authorityRetiring)) {
          failStart(new Error("Cursor MCP connector startup was cancelled."));
        }
      });
      server.listen(mcpConnectorSocketPath, async () => {
        await waitAtTestStartupBarrier("mcp_listen");
        if (finalizing || authorityRetiring) {
          try { server.close(); } catch {}
          failStart(new Error("Cursor MCP connector startup was cancelled."));
          return;
        }
        server.removeListener("error", failStart);
        try { chmodSync(mcpConnectorSocketPath, 0o600); }
        catch (error) { void closeMcpConnector(); failStart(error); return; }
        mcpCapabilityDeadline = setTimeout(() => {
          failMcpCapabilityAttestation("Cursor never connected the attested MCP runtime before model authority.");
        }, mcpCapabilityTimeoutMs);
        settled = true;
        server.on("error", (error) => {
          const detail = "Cursor MCP connector failed: " + (error && error.message ? error.message : String(error));
          if (!native) { finishNotStarted(detail); return; }
          if (!exitEvidence) exitEvidence = { type: "error", error: detail };
          exitCode = 1;
          void beginFatalReaping();
        });
        resolve();
      });
    }, (error) => {
      const detail = error && error.message ? error.message : String(error);
      try { runtime.kill("SIGTERM"); } catch {}
      failMcpCapabilityAttestation(detail);
      failStart(error instanceof Error ? error : new Error(detail));
    });
  });
}
async function closeAuthorityProxy() {
  if (authorityProxy) {
    try { authorityProxy.close(); } catch {}
    try { authorityProxy.closeAllConnections(); } catch {}
  }
  if (agentProxy) { try { agentProxy.close(); } catch {} }
  for (const server of agentProxyInternalServers) {
    try { server.close(); } catch {}
    try { server.closeAllConnections(); } catch {}
  }
  agentProxyInternalServers.clear();
  for (const upstream of authorityProxyUpstreams) { try { upstream.destroy(); } catch {} }
  for (const stream of agentProxyUpstreamStreams) {
    try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch {}
    try { stream.destroy(); } catch {}
  }
  for (const session of agentProxyUpstreamSessions) { try { session.destroy(); } catch {} }
  for (const socket of authorityProxySockets) { try { socket.destroy(); } catch {} }
  for (const session of agentProxySessions) { try { session.destroy(); } catch {} }
  for (const socket of agentProxySockets) { try { socket.destroy(); } catch {} }
  const deadline = Date.now() + 500;
  while (Date.now() < deadline && (
    authorityProxyUpstreams.size > 0
    || agentProxyUpstreamStreams.size > 0
    || agentProxyUpstreamSessions.size > 0
    || authorityProxySockets.size > 0
    || agentProxySessions.size > 0
    || agentProxySockets.size > 0
  )) await wait(5);
  const revoked = authorityProxyUpstreams.size === 0
    && agentProxyUpstreamStreams.size === 0
    && agentProxyUpstreamSessions.size === 0
    && authorityProxySockets.size === 0
    && agentProxySessions.size === 0
    && agentProxySockets.size === 0;
  authorityProxy = null;
  agentProxy = null;
  return revoked;
}
function beginTurnAuthorityRetirement() {
  authorityRetiring = true;
  // Any request still held for attestation can never be admitted once authority
  // is retiring; release them all as rejected so none outlives the turn.
  settleMcpCapabilityWaiters(false);
  if (!authorityRetirementPromise) {
    authorityRetirementPromise = (async () => {
      // Invoke both closures before the first await. This synchronously closes
      // every listener/socket and signals the detached MCP runtime before any
      // native-controlled cleanup or process-group escalation can block us.
      const proxyRetirement = closeAuthorityProxy().catch(() => {
        if (!exitEvidence) {
          exitEvidence = { type: "error", error: "Cursor authority proxies could not be retired." };
        }
        exitCode = 1;
        streamContractComplete = false;
        return false;
      });
      const mcpRetirement = closeMcpConnector().catch(() => {
        if (!exitEvidence) {
          exitEvidence = { type: "error", error: "Cursor MCP connector could not be retired." };
        }
        exitCode = 1;
        streamContractComplete = false;
        return false;
      });
      const [proxyAuthorityRevoked, mcpAuthorityRevoked] = await Promise.all([
        proxyRetirement,
        mcpRetirement,
      ]);
      return { proxyAuthorityRevoked, mcpAuthorityRevoked };
    })();
  }
  return authorityRetirementPromise;
}
function retireTurnRuntimeData() {
  try { runtimeDataRetirementResult = purgeTurnRuntimeDataRoot(); }
  catch {
    runtimeDataRetirementResult = false;
    if (!exitEvidence) {
      exitEvidence = { type: "error", error: "Cursor's private turn data root could not be retired safely." };
    }
    exitCode = 1;
    streamContractComplete = false;
  }
  return runtimeDataRetirementResult;
}
function denyControlPlaneRequest(request, response) {
  request.resume();
  response.writeHead(503, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "connection": "close",
  });
  response.end("Cursor remote authority is disabled for this supervised turn.");
}
function startAgentProxy() {
  if (!restrictRemoteAuthority) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let admitted = false;
    function forward(source, headers, downstream) {
      const path = headers[":path"] || source.url;
      const upstreamSession = http2.connect(supervisedAgentEndpoint);
      agentProxyUpstreamSessions.add(upstreamSession);
      upstreamSession.once("close", () => agentProxyUpstreamSessions.delete(upstreamSession));
      const upstreamHeaders = {
        ":method": "POST",
        ":path": path,
        ":scheme": "https",
        ":authority": "api2.cursor.sh",
        authorization: providerAuthorization,
      };
      for (const [key, value] of Object.entries(headers)) {
        if (key.startsWith(":")
          || key === "authorization"
          || key === "connection"
          || key === "host"
          || key === "proxy-connection"
          || key === "transfer-encoding"
          || value === undefined) continue;
        upstreamHeaders[key] = value;
      }
      let upstream;
      try { upstream = upstreamSession.request(upstreamHeaders); }
      catch { downstream.fail(502); upstreamSession.destroy(); return; }
      agentProxyUpstreamStreams.add(upstream);
      upstream.once("close", () => agentProxyUpstreamStreams.delete(upstream));
      let requestBytes = 0;
      let responseBytes = 0;
      let failed = false;
      function fail(status) {
        if (failed) return;
        failed = true;
        try { upstream.close(http2.constants.NGHTTP2_CANCEL); } catch {}
        try { upstreamSession.close(); } catch {}
        downstream.fail(status);
      }
      upstreamSession.once("error", () => fail(502));
      upstream.once("error", () => fail(502));
      source.once("error", () => fail(499));
      source.on("data", (chunk) => {
        if (failed) return;
        requestBytes += chunk.length;
        if (requestBytes > 64 * 1024 * 1024) { fail(413); return; }
        if (!upstream.write(chunk)) {
          source.pause();
          upstream.once("drain", () => source.resume());
        }
      });
      source.once("end", () => { if (!failed) upstream.end(); });
      upstream.once("response", (responseHeaders) => {
        if (failed) return;
        const downstreamHeaders = {};
        for (const [key, value] of Object.entries(responseHeaders)) {
          if (key === "connection" || key === "proxy-connection" || key === "transfer-encoding") continue;
          downstreamHeaders[key] = value;
        }
        try { downstream.respond(downstreamHeaders); } catch { fail(502); }
      });
      upstream.on("data", (chunk) => {
        if (failed) return;
        responseBytes += chunk.length;
        if (responseBytes > 64 * 1024 * 1024) { fail(502); return; }
        if (!downstream.write(chunk)) {
          upstream.pause();
          downstream.onceDrain(() => upstream.resume());
        }
      });
      upstream.once("end", () => {
        if (!failed) downstream.end();
        upstreamSession.close();
      });
      downstream.onceClose(() => {
        try { upstream.close(); } catch {}
        try { upstreamSession.close(); } catch {}
      });
    }
    // Genuine, non-timing violations: a bad proxy token, wrong method/path/
    // content-type, or a second request after one was already admitted. These
    // never wait -- they are rejected immediately, independent of attestation.
    function requestViolation(method, path, contentType, authorization) {
      return finalizing
        || authorityRetiring
        || admitted
        || authorization !== expectedProxyAuthorization
        || method !== "POST"
        || path !== "/agent.v1.AgentService/Run"
        || typeof contentType !== "string"
        || !/^application\/connect[+]proto(?:\s*;|$)/i.test(contentType.trim());
    }
    // Decide whether one model request may be forwarded. When the only unmet
    // condition is live MCP attestation, the request is HELD on the real
    // attestation signal rather than rejected: rejecting mid-handshake makes
    // Cursor treat the turn as a dropped connection and retry to death. The hold
    // is bounded by the capability deadline armed when the connector began
    // listening -- attestation success admits, failure or timeout rejects -- and
    // cancel() frees the single admission slot if the caller's stream dies while
    // held. Fail-closed: every path resolves to a definite allow or deny. A deny
    // reached during teardown may surface to the client as a connection reset
    // rather than the 503 body; the durable failure reason is the recorded
    // terminal evidence, not the wire response.
    function admitRequest(method, path, contentType, authorization) {
      if (requestViolation(method, path, contentType, authorization)) {
        return { promise: Promise.resolve(false), cancel() {} };
      }
      if (mcpCapabilityAttested) {
        admitted = true;
        return { promise: Promise.resolve(true), cancel() {} };
      }
      let resolveAdmit;
      const promise = new Promise((resolve) => { resolveAdmit = resolve; });
      const release = (attested) => {
        if (!attested || requestViolation(method, path, contentType, authorization)) { resolveAdmit(false); return; }
        admitted = true;
        resolveAdmit(true);
      };
      mcpCapabilityWaiters.add(release);
      return {
        promise,
        cancel() { if (mcpCapabilityWaiters.delete(release)) resolveAdmit(false); },
      };
    }
    const h2Server = http2.createServer({ settings: { maxHeaderListSize: 64 * 1024 } });
    agentProxyInternalServers.add(h2Server);
    h2Server.once("close", () => {
      agentProxyInternalServers.delete(h2Server);
      if (!settled && (finalizing || authorityRetiring)) failStart(new Error("Cursor agent proxy startup was cancelled."));
    });
    h2Server.on("connection", (socket) => {
      if (finalizing || authorityRetiring) { socket.destroy(); return; }
      agentProxySockets.add(socket);
      socket.once("close", () => agentProxySockets.delete(socket));
    });
    h2Server.on("session", (session) => {
      if (finalizing || authorityRetiring) { session.destroy(); return; }
      agentProxySessions.add(session);
      session.once("close", () => agentProxySessions.delete(session));
    });
    h2Server.on("stream", (stream, headers) => {
      const admission = admitRequest(headers[":method"], headers[":path"], headers["content-type"], headers.authorization);
      const onClosed = () => admission.cancel();
      stream.once("close", onClosed);
      void admission.promise.then((allowed) => {
        stream.removeListener("close", onClosed);
        if (!allowed) {
          try { stream.respond({ ":status": 503, "cache-control": "no-store" }); } catch {}
          try { stream.end("Cursor agent proxy rejected the request."); } catch {}
          return;
        }
        // The admitted stream died before we could forward (nothing was sent
        // upstream). Free the single admission slot so a legitimate retry is
        // not rejected as a replay -- otherwise this reintroduces the
        // retry-to-death this fix removes.
        if (stream.destroyed || stream.closed) { admitted = false; return; }
        forward(stream, headers, {
          respond: (value) => stream.respond(value),
          fail: (status) => {
            try { if (!stream.headersSent) stream.respond({ ":status": status }); } catch {}
            try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch {}
          },
          write: (chunk) => stream.write(chunk),
          end: () => stream.end(),
          onceDrain: (listener) => stream.once("drain", listener),
          onceClose: (listener) => stream.once("close", listener),
        });
      });
    });
    h2Server.on("sessionError", () => {});
    const h1Server = http.createServer((request, response) => {
      const admission = admitRequest(request.method, request.url, request.headers["content-type"], request.headers.authorization);
      const onClosed = () => admission.cancel();
      response.once("close", onClosed);
      void admission.promise.then((allowed) => {
        response.removeListener("close", onClosed);
        if (!allowed) {
          request.resume();
          try {
            response.writeHead(503, { "cache-control": "no-store", "connection": "close" });
            response.end("Cursor agent proxy rejected the request.");
          } catch {}
          return;
        }
        // The admitted response died before we could forward. Free the single
        // admission slot (see the HTTP/2 path) so a legitimate retry is admitted.
        if (response.writableEnded || response.destroyed) { admitted = false; request.resume(); return; }
        forward(request, request.headers, {
          respond: (value) => {
            const status = Number(value[":status"] || 502);
            const headers = {};
            for (const [key, entry] of Object.entries(value)) {
              if (!key.startsWith(":") && key !== "connection" && key !== "transfer-encoding") headers[key] = entry;
            }
            response.writeHead(status, headers);
          },
          fail: (status) => {
            try { if (!response.headersSent) response.writeHead(status, { "connection": "close" }); } catch {}
            response.destroy();
          },
          write: (chunk) => response.write(chunk),
          end: () => response.end(),
          onceDrain: (listener) => response.once("drain", listener),
          onceClose: (listener) => response.once("close", listener),
        });
      });
    });
    agentProxyInternalServers.add(h1Server);
    h1Server.once("close", () => {
      agentProxyInternalServers.delete(h1Server);
      if (!settled && (finalizing || authorityRetiring)) failStart(new Error("Cursor agent proxy startup was cancelled."));
    });
    h1Server.on("connection", (socket) => {
      if (finalizing || authorityRetiring) { socket.destroy(); return; }
      agentProxySockets.add(socket);
      socket.once("close", () => agentProxySockets.delete(socket));
    });
    h1Server.on("clientError", (_error, socket) => { try { socket.destroy(); } catch {} });
    const h2Preface = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
    let h2Port = null;
    let h1Port = null;
    let internalReady = 0;
    let settled = false;
    function failStart(error) {
      if (settled) return;
      settled = true;
      void closeAuthorityProxy();
      reject(error);
    }
    function internalListening(server, protocol) {
      if (finalizing || authorityRetiring) {
        failStart(new Error("Cursor agent proxy startup was cancelled."));
        return;
      }
      const address = server.address();
      if (!address || typeof address === "string") { failStart(new Error("Cursor internal agent proxy did not expose a loopback port.")); return; }
      if (protocol === "h2") h2Port = address.port;
      else h1Port = address.port;
      internalReady += 1;
      if (internalReady !== 2) return;
      const mux = net.createServer((socket) => {
        if (finalizing || authorityRetiring || agentProxySockets.size >= 24) { socket.destroy(); return; }
        agentProxySockets.add(socket);
        socket.once("close", () => agentProxySockets.delete(socket));
        socket.setTimeout(5000, () => socket.destroy());
        let probe = Buffer.alloc(0);
        function inspect(chunk) {
          probe = Buffer.concat([probe, chunk]);
          const prefixLength = Math.min(probe.length, h2Preface.length);
          const couldBeH2 = probe.subarray(0, prefixLength).equals(h2Preface.subarray(0, prefixLength));
          if (couldBeH2 && probe.length < h2Preface.length) return;
          socket.removeListener("data", inspect);
          socket.pause();
          socket.setTimeout(0);
          const routed = net.connect({ host: "127.0.0.1", port: couldBeH2 ? h2Port : h1Port });
          agentProxySockets.add(routed);
          routed.once("close", () => agentProxySockets.delete(routed));
          routed.once("error", () => socket.destroy());
          socket.once("error", () => routed.destroy());
          routed.once("connect", () => {
            if (finalizing || authorityRetiring) { routed.destroy(); socket.destroy(); return; }
            routed.write(probe);
            socket.pipe(routed);
            routed.pipe(socket);
            socket.resume();
          });
        }
        socket.on("data", inspect);
      });
      agentProxy = mux;
      mux.once("close", () => {
        if (!settled && (finalizing || authorityRetiring)) failStart(new Error("Cursor agent proxy startup was cancelled."));
      });
      mux.once("error", failStart);
      mux.listen({ host: "127.0.0.1", port: 0, exclusive: true }, async () => {
        await waitAtTestStartupBarrier("agent_listen");
        if (settled) { try { mux.close(); } catch {} return; }
        if (finalizing || authorityRetiring) {
          try { mux.close(); } catch {}
          failStart(new Error("Cursor agent proxy startup was cancelled."));
          return;
        }
        settled = true;
        mux.removeListener("error", failStart);
        mux.on("error", (error) => {
          const detail = "Cursor agent proxy failed: " + (error && error.message ? error.message : String(error));
          if (!native) { void finishNotStarted(detail); return; }
          if (!exitEvidence) exitEvidence = { type: "error", error: detail };
          exitCode = 1;
          void beginFatalReaping();
        });
        const address = mux.address();
        if (!address || typeof address === "string") {
          void closeAuthorityProxy();
          reject(new Error("Cursor agent proxy did not expose a loopback port."));
          return;
        }
        resolve(address.port);
      });
    }
    h2Server.once("error", failStart);
    h1Server.once("error", failStart);
    h2Server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      if (finalizing || authorityRetiring) { failStart(new Error("Cursor agent proxy startup was cancelled.")); return; }
      h2Server.removeListener("error", failStart);
      internalListening(h2Server, "h2");
    });
    h1Server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      if (finalizing || authorityRetiring) { failStart(new Error("Cursor agent proxy startup was cancelled.")); return; }
      h1Server.removeListener("error", failStart);
      internalListening(h1Server, "h1");
    });
  });
}
function startAuthorityProxy() {
  if (!restrictRemoteAuthority) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let settled = false;
    const failStart = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const server = http.createServer((request, response) => {
      if (finalizing || authorityRetiring) { request.destroy(); response.destroy(); return; }
      const requestPath = typeof request.url === "string" ? request.url : "";
      if (request.headers.authorization !== expectedProxyAuthorization
        || request.method !== "POST" || !supervisedControlPlanePaths.has(requestPath)) {
        denyControlPlaneRequest(request, response);
        return;
      }
      const contentLengthHeader = request.headers["content-length"];
      const transferEncoding = request.headers["transfer-encoding"];
      const contentLength = typeof contentLengthHeader === "string" && /^\d{1,7}$/.test(contentLengthHeader)
        ? Number(contentLengthHeader)
        : -1;
      if (transferEncoding !== undefined
        || !Number.isSafeInteger(contentLength)
        || contentLength < 0
        || contentLength > 1024 * 1024) {
        denyControlPlaneRequest(request, response);
        return;
      }
      const headers = {
        ...request.headers,
        host: "api2.cursor.sh",
        authorization: providerAuthorization,
      };
      delete headers.connection;
      delete headers["proxy-connection"];
      delete headers.upgrade;
      delete headers["keep-alive"];
      delete headers["transfer-encoding"];
      const controlPlaneUrl = new URL(requestPath, supervisedControlPlaneEndpoint);
      const controlPlaneClient = controlPlaneUrl.protocol === "https:" ? https : http;
      const upstream = controlPlaneClient.request({
        protocol: controlPlaneUrl.protocol,
        hostname: controlPlaneUrl.hostname,
        port: controlPlaneUrl.port || (controlPlaneUrl.protocol === "https:" ? 443 : 80),
        method: "POST",
        path: requestPath,
        headers,
        ...(controlPlaneUrl.protocol === "https:" ? { servername: "api2.cursor.sh" } : {}),
        timeout: 15000,
        agent: false,
      }, (upstreamResponse) => {
        authorityProxyUpstreams.add(upstreamResponse);
        upstreamResponse.once("close", () => authorityProxyUpstreams.delete(upstreamResponse));
        const responseHeaders = {
          ...upstreamResponse.headers,
        };
        delete responseHeaders.connection;
        delete responseHeaders["proxy-connection"];
        delete responseHeaders.upgrade;
        delete responseHeaders["keep-alive"];
        response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        upstreamResponse.once("error", () => response.destroy());
        upstreamResponse.pipe(response);
      });
      authorityProxyUpstreams.add(upstream);
      upstream.once("close", () => authorityProxyUpstreams.delete(upstream));
      upstream.once("timeout", () => upstream.destroy(new Error("Cursor control-plane request timed out.")));
      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(502, { "connection": "close" });
        response.end();
      });
      request.once("aborted", () => upstream.destroy());
      let receivedBytes = 0;
      let requestOverflow = false;
      request.on("data", (chunk) => {
        if (requestOverflow) return;
        receivedBytes += chunk.length;
        if (receivedBytes > 1024 * 1024) {
          requestOverflow = true;
          upstream.destroy();
          if (!response.headersSent) response.writeHead(413, { "connection": "close" });
          response.end();
          request.resume();
          return;
        }
        if (!upstream.write(chunk)) {
          request.pause();
          upstream.once("drain", () => request.resume());
        }
      });
      request.once("end", () => { if (!requestOverflow) upstream.end(); });
      request.once("error", () => upstream.destroy());
    });
    server.on("connection", (socket) => {
      if (finalizing || authorityRetiring || authorityProxySockets.size >= 8) { socket.destroy(); return; }
      authorityProxySockets.add(socket);
      socket.once("close", () => authorityProxySockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => {
      try { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch {}
    });
    server.maxHeadersCount = 64;
    server.headersTimeout = 5000;
    server.requestTimeout = 20000;
    server.keepAliveTimeout = 1000;
    authorityProxy = server;
    server.once("error", failStart);
    server.once("close", () => {
      if (!settled && (finalizing || authorityRetiring)) {
        failStart(new Error("Cursor authority proxy startup was cancelled."));
      }
    });
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, async () => {
      await waitAtTestStartupBarrier("authority_listen");
      if (finalizing || authorityRetiring) {
        try { server.close(); } catch {}
        failStart(new Error("Cursor authority proxy startup was cancelled."));
        return;
      }
      server.removeListener("error", failStart);
      const address = server.address();
      if (!address || typeof address === "string") {
        closeAuthorityProxy();
        failStart(new Error("Cursor authority proxy did not expose a loopback port."));
        return;
      }
      settled = true;
      server.on("error", (error) => {
        const detail = "Cursor authority proxy failed: " + (error && error.message ? error.message : String(error));
        if (!native) {
          finishNotStarted(detail);
          return;
        }
        if (!exitEvidence) {
          exitEvidence = { type: "error", error: detail };
        }
        exitCode = 1;
        void beginFatalReaping();
      });
      resolve(address.port);
    });
  });
}
async function finalize() {
  if (finalizing) return;
  finalizing = true;
  if (evidenceDrainTimer) { clearTimeout(evidenceDrainTimer); evidenceDrainTimer = null; }
  const { proxyAuthorityRevoked, mcpAuthorityRevoked } = await beginTurnAuthorityRetirement();
  const nativeGroupReaped = await beginReaping();
  const runtimeDataRetired = retireTurnRuntimeData();
  const remoteAuthorityRevoked = proxyAuthorityRevoked && mcpAuthorityRevoked && runtimeDataRetired;
  if (!remoteAuthorityRevoked) exitCode = 1;
  try { purgePublicPlaceholderCredentialFile(); }
  catch {
    if (!exitEvidence) {
      exitEvidence = { type: "error", error: "Cursor's public credential placeholder could not be purged safely." };
    }
    exitCode = 1;
    streamContractComplete = false;
  }
  flushParser();
  try { purgeStatsigTemporaryFiles(); }
  catch (error) {
    if (!exitEvidence) {
      exitEvidence = { type: "error", error: "Cursor Statsig temporary state could not be purged." };
    }
    exitCode = 1;
    streamContractComplete = false;
  }
  if (stateFd !== null) { try { closeSync(stateFd); } catch {} stateFd = null; }
  try {
    terminal({
      ...(exitEvidence || { type: "error", error: "Cursor wrapper closed without native exit evidence." }),
      native_process_group_reaped: nativeGroupReaped,
      reap_scope: "native_process_group",
      remote_authority_revoked: remoteAuthorityRevoked,
      turn_contract_version: 1,
      session_contract_valid: sessionContractValid,
      stream_contract_complete: streamContractComplete,
      workspace_generation_manifest_path: workspaceGenerationManifestPath || null,
      init: initSnapshot,
      result: resultSnapshot,
    });
  } catch {}
  process.exit(exitCode);
}
function purgeStatsigTemporaryFiles() {
  const configDir = process.env.CURSOR_CONFIG_DIR;
  if (!configDir) return;
  const stat = lstatSync(configDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("redirected config");
  const directory = opendirSync(configDir);
  let entries = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      entries += 1;
      if (entries > 4096) throw new Error("too many config entries");
      if (!/^statsig-cache[.]json[.][1-9][0-9]{0,9}[.][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]tmp$/i.test(entry.name)) continue;
      const path = configDir + "/" + entry.name;
      const entryStat = lstatSync(path);
      if (entryStat.isDirectory() && !entryStat.isSymbolicLink()) throw new Error("Statsig temp is a directory");
      unlinkSync(path);
    }
  } finally { directory.closeSync(); }
}
async function start() {
  if (started || finalizing || authorityRetiring) return;
  started = true;
  let authorityProxyPort = null;
  let agentProxyPort = null;
  try {
    await startMcpConnector();
    if (finalizing || authorityRetiring) return;
    authorityProxyPort = await startAuthorityProxy();
    if (finalizing || authorityRetiring) return;
    agentProxyPort = await startAgentProxy();
    if (finalizing || authorityRetiring) return;
  } catch (error) {
    await finishNotStarted("Cursor authority proxy failed: " + (error && error.message ? error.message : String(error)), true);
    return;
  }
  const nativeEnv = { ...process.env };
  // Wrapper-only: packaged Electron needs this to execute the inline Node
  // wrapper, but an Electron-backed Cursor binary must never inherit it.
  delete nativeEnv.ELECTRON_RUN_AS_NODE;
  const sandboxed = process.platform === "darwin"
    && (restrictRemoteAuthority
      || deniedReadPaths.length > 0
      || deniedReadSubpaths.length > 0
      || deniedReadMetadataPaths.length > 0
      || deniedReadWriteRegexes.length > 0
      || deniedWriteRegexes.length > 0
      || deniedWritePaths.length > 0
      || deniedWriteStructuralPaths.length > 0
      || deniedWriteSubpaths.length > 0
      || allowedWriteSubpaths.length > 0
      || allowedReadSubpaths.length > 0);
  const nativeCommand = sandboxed ? "/usr/bin/sandbox-exec" : bin;
  const cursorArgs = authorityProxyPort === null || agentProxyPort === null
    ? args
    : [
      "--endpoint", "http://127.0.0.1:" + authorityProxyPort,
      "--agent-endpoint", "http://127.0.0.1:" + agentProxyPort,
      // This Cursor path consumes its documented auth override only from
      // argv. The value is deliberately non-secret and merely suppresses a
      // credential-store lookup; both proxies replace it before forwarding.
      "--auth-token", publicAuthPlaceholder,
      "--http-version", "1.1",
      ...args,
    ];
  const nativeArgs = sandboxed
    ? [
      "-p",
      [
        "(version 1)",
        "(allow default)",
        ...(restrictRemoteAuthority ? [
          // Cursor queries its own process metadata during startup. Preserve
          // self inspection while denying native/model descendants visibility
          // into wrapper-hosted MCP and future same-UID process environments.
          "(deny process-info* (target others))",
          // Native Cursor and model-directed tools may manage themselves and
          // their own child tools, but must never signal the trusted wrapper
          // or an unrelated same-UID process. Hiding process metadata is not
          // sufficient because a known or inherited PID remains signalable.
          "(deny signal (require-not (require-any (target self) (target children))))",
          // Model-directed helpers inherit file/network rules, but macOS GUI
          // and daemon clients can delegate effects to an unsandboxed service.
          // Block those channels independently of Cursor's command classifier.
          "(deny appleevent-send)",
          // Repo-native binaries can ask launchd to create an unsupervised
          // service without executing the launchctl CLI, so deny the
          // underlying operation as well as the executable path.
          "(deny job-creation)",
          // A mount placed below the writable generation would replace its
          // vnode boundary with unrelated storage. The supervisor owns all
          // generation mounts and file flags; native descendants own neither.
          "(deny file-mount file-unmount)",
          "(deny file-write-flags)",
          // Path-scoped writes are otherwise vulnerable to inode aliases:
          // hard links can mutate an outside/protected path through an allowed
          // workspace pathname. Do not inventory the existing project tree at
          // startup; cheaply prevent the supervised process from creating new
          // aliases instead. APFS clones remain usable inside the repo and
          // still require source-read authority, so the global data-read fence
          // blocks outside imports.
          "(deny file-link)",
          "(deny mach-lookup (global-name \"com.apple.coreservices.appleevents\"))",
          "(deny mach-lookup (global-name \"com.apple.coreservices.launchservicesd\"))",
          "(deny mach-lookup (global-name \"com.apple.launchservices.mapdb\"))",
          "(deny mach-lookup (global-name \"com.apple.pasteboard.1\"))",
          // Executable path denials are not a capability boundary: a
          // repo-native binary can call Security.framework or CFPreferences
          // directly. Fence those host-data brokers at Mach lookup instead.
          "(deny mach-lookup (global-name \"com.apple.SecurityServer\"))",
          "(deny mach-lookup (global-name \"com.apple.cfprefsd.agent\"))",
          "(deny mach-lookup (global-name \"com.apple.cfprefsd.daemon\"))",
          "(deny mach-lookup (global-name \"com.apple.CoreSimulator.CoreSimulatorService\"))",
          "(deny mach-lookup (global-name \"com.apple.CoreSimulator.SimLaunchHost\"))",
          "(deny mach-lookup (global-name \"com.apple.CoreSimulator.SimulatorTrampoline\"))",
          "(deny mach-lookup (global-name \"com.apple.windowserver.active\"))",
          "(deny mach-lookup (global-name \"com.apple.windowserver\"))",
          "(deny mach-lookup (global-name \"com.apple.metadata.mds\"))",
          "(deny mach-lookup (global-name \"com.apple.DiskArbitration.diskarbitrationd\"))",
          // Cursor's headless worker spawns a helper that binds a private
          // stdio socket under its per-turn CURSOR_DATA_DIR (we relocate it
          // there so no ambient /tmp/.cursor worker is reused). A unix-socket
          // listen() is network-inbound, so an absolute inbound deny EPERMs
          // that bind and the worker dies before the MCP client ever connects.
          // Admit inbound binds only for unix sockets under that exact per-turn
          // root; every other inbound (and TCP) stays denied.
          allowedInternalUnixSocketRoots.length > 0
            ? "(deny network-inbound (require-not (require-any "
              + allowedInternalUnixSocketRoots.map((root) =>
                "(local unix-socket (subpath " + JSON.stringify(root) + "))"
              ).join(" ")
              + ")))"
            : "(deny network-inbound)",
          "(deny network-outbound (require-not (require-any "
            + "(remote ip \"localhost:" + authorityProxyPort + "\") "
            + "(remote ip \"localhost:" + agentProxyPort + "\") "
            + allowedNetworkUnixSockets.map((path) =>
              "(remote unix-socket (literal " + JSON.stringify(path) + "))"
            ).join(" ")
            // The worker's own client half connects back to that private
            // socket; permit outbound only to the same per-turn root.
            + allowedInternalUnixSocketRoots.map((root) =>
              " (remote unix-socket (subpath " + JSON.stringify(root) + "))"
            ).join("")
            + ")))",
          ...deniedDelegatingExecutables.map((path) =>
            "(deny process-exec (literal " + JSON.stringify(path) + "))"
          ),
        ] : []),
        ...deniedExecSubpaths.map((path) =>
          "(deny process-exec (subpath " + JSON.stringify(path) + "))"
        ),
        ...(allowedReadSubpaths.length > 0 ? [
          "(deny file-read-data (require-not (require-any "
            + "(literal \"/\") "
            + allowedReadSubpaths.map((path) =>
              "(subpath " + JSON.stringify(path) + ")"
            ).join(" ")
            + ")))",
        ] : []),
        ...(allowedWriteSubpaths.length > 0 ? [
          "(deny file-write* (require-not (require-any "
            + "(literal \"/dev/null\") "
            + allowedWriteSubpaths.map((path) =>
              "(subpath " + JSON.stringify(path) + ")"
            ).join(" ")
            + ")))",
        ] : []),
        ...deniedReadPaths.map((path) =>
          "(deny file-read* (literal " + JSON.stringify(path) + "))"
        ),
        ...deniedReadSubpaths.map((path) =>
          "(deny file-read* (subpath " + JSON.stringify(path) + "))"
        ),
        ...deniedReadMetadataPaths.map((path) =>
          "(deny file-read-metadata (literal " + JSON.stringify(path) + "))"
        ),
        ...deniedReadWriteRegexes.map((pattern) =>
          "(deny file-read* (regex #" + JSON.stringify(pattern) + "))"
        ),
        // The same authority locations are immutable for the complete native
        // process tree. This closes late-create and redirected-download races
        // for hooks, settings, plugins, Statsig gates, and bundled MCPs.
        ...deniedReadPaths.map((path) =>
          "(deny file-write* (literal " + JSON.stringify(path) + "))"
        ),
        ...deniedReadSubpaths.map((path) =>
          "(deny file-write* (subpath " + JSON.stringify(path) + "))"
        ),
        ...deniedReadMetadataPaths.map((path) =>
          "(deny file-write* (literal " + JSON.stringify(path) + "))"
        ),
        ...deniedReadWriteRegexes.map((pattern) =>
          "(deny file-write* (regex #" + JSON.stringify(pattern) + "))"
        ),
        ...deniedWriteRegexes.map((pattern) =>
          "(deny file-write* (regex #" + JSON.stringify(pattern) + "))"
        ),
        ...deniedWritePaths.map((path) =>
          "(deny file-write* (literal " + JSON.stringify(path) + "))"
        ),
        ...deniedWriteStructuralPaths.map((path) =>
          "(deny file-write-unlink (literal " + JSON.stringify(path) + "))"
        ),
        ...deniedWriteSubpaths.map((path) =>
          "(deny file-write* (subpath " + JSON.stringify(path) + "))"
        ),
      ].join("\n"),
      bin,
      ...cursorArgs,
    ]
    : cursorArgs;
  if (finalizing || authorityRetiring) return;
  native = spawn(nativeCommand, nativeArgs, {
    cwd: process.cwd(), env: nativeEnv, stdio: ["ignore", "pipe", "pipe"],
    // The durable wrapper is already a detached group leader. Keep native
    // Cursor and its descendants in that exact, still-live group so a reaped
    // native PID can never be mistaken for later group authority.
    detached: false,
  });
  native.stdout.on("data", (chunk) => {
    if (statePath && stateFd !== null && persistedBytes < maxPersistedBytes) {
      try {
        const bounded = chunk.subarray(0, Math.max(0, maxPersistedBytes - persistedBytes));
        if (bounded.length) appendFileSync(stateFd, bounded);
        persistedBytes += bounded.length;
      } catch (error) {
        failStreamPersistence(error);
      }
    }
    consumeText(decoder.write(chunk));
  });
  forwardBoundedStderr(native.stderr, "Cursor native process");
  native.once("error", (error) => {
    if (!exitEvidence) {
      exitEvidence = { type: "error", error: error && error.message ? error.message : String(error) };
    }
    exitCode = 1;
    void beginFatalReaping();
    armEvidenceDrainDeadline();
  });
  native.once("exit", (code, signal) => {
    // A containment or protocol failure that initiated reaping is the causal
    // terminal evidence. The resulting native exit must not erase that exact,
    // actionable reason with a generic exit code.
    if (!exitEvidence) {
      exitEvidence = { type: "exit", code, signal };
      exitCode = code === 0 ? 0 : (typeof code === "number" ? code : 1);
    } else if (exitEvidence.type === "error") {
      // A provider that handles our fatal TERM and exits zero must not convert
      // the wrapper's already-recorded protocol/containment failure into a
      // successful or user-stopped attempt lifecycle.
      exitCode = 1;
    }
    // Descendants may hold stdout open. Reaping starts at native exit, while
    // terminal publication waits for close so the final result bytes drain.
    void beginFatalReaping();
    armEvidenceDrainDeadline();
  });
  native.once("close", () => { void finalize(); });
}
async function finishNotStarted(error, calledFromStart = false) {
  if (finalizing) return;
  finalizing = true;
  authorityRetiring = true;
  // A wrapper that never crossed native release still rejects any held request.
  settleMcpCapabilityWaiters(false);
  // First revoke anything already published. Then wait for the in-progress
  // startup continuation to observe the cancellation fence and close again,
  // so a late listen callback cannot outlive not_started evidence.
  try { await closeAuthorityProxy(); } catch {}
  try { await closeMcpConnector(); } catch {}
  if (!calledFromStart && startPromise) {
    try { await startPromise; } catch {}
  }
  let proxyAuthorityRevoked = false;
  let mcpAuthorityRevoked = false;
  try { proxyAuthorityRevoked = await closeAuthorityProxy(); } catch {}
  try { mcpAuthorityRevoked = await closeMcpConnector(); } catch {}
  try { purgePublicPlaceholderCredentialFile(); } catch {}
  const runtimeDataRetired = retireTurnRuntimeData();
  if (stateFd !== null) { try { closeSync(stateFd); } catch {} stateFd = null; }
  try {
    terminal({
      type: "not_started",
      ...(error ? { error } : {}),
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: proxyAuthorityRevoked && mcpAuthorityRevoked && runtimeDataRetired,
      session_contract_valid: true,
      stream_contract_complete: true,
      workspace_generation_manifest_path: workspaceGenerationManifestPath || null,
      init: null,
      result: null,
    });
  } catch {}
  process.exit(1);
}
process.on("message", (message) => {
  if (!message || message.type !== "start") return;
  if (restrictRemoteAuthority) {
    if (typeof message.providerAuthorization !== "string"
      || !/^Bearer [^\s\0]{1,16384}$/.test(message.providerAuthorization)) {
      void finishNotStarted("Cursor wrapper received no valid provider authorization proof.");
      return;
    }
    providerAuthorization = message.providerAuthorization;
    try { mcpRuntimeEnv = validatedMcpRuntimeEnv(message.mcpRuntimeEnv); }
    catch { void finishNotStarted("Cursor wrapper received no valid MCP runtime boundary."); return; }
  }
  const pendingStart = start();
  startPromise = pendingStart;
  void pendingStart.catch((error) => finishNotStarted(
    "Cursor wrapper startup failed: " + (error && error.message ? error.message : String(error)),
    true,
  )).finally(() => {
    if (startPromise === pendingStart) startPromise = null;
  });
});
process.on("disconnect", () => {
  if (native) return;
  void finishNotStarted();
});
process.on("SIGTERM", () => { if (native) void beginFatalReaping(); else void finishNotStarted(); });
process.on("SIGINT", () => { if (native) void beginFatalReaping(); else void finishNotStarted(); });
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
if (process.send) process.send({ type: "prepared" });
`;
  const child = spawn(process.execPath, [
    "-e",
    wrapperSource,
    input.cursorBin,
    input.statePath ?? "",
    input.workspaceGenerationManifestPath ?? "",
    JSON.stringify(deniedReadPaths),
    JSON.stringify(deniedReadSubpaths),
    JSON.stringify(deniedReadMetadataPaths),
    JSON.stringify(deniedReadWriteRegexes),
    JSON.stringify(deniedWriteRegexes),
    JSON.stringify(deniedWritePaths),
    JSON.stringify(deniedWriteStructuralPaths),
    JSON.stringify(deniedWriteSubpaths),
    JSON.stringify(deniedExecSubpaths),
    JSON.stringify(allowedWriteSubpaths),
    JSON.stringify(allowedReadSubpaths),
    JSON.stringify(allowedNetworkUnixSockets),
    JSON.stringify(allowedInternalUnixSocketRoots),
    input.mcpConnectorSocketPath ?? "",
    input.mcpRuntimeEntryPath ?? "",
    input.mcpRuntimeCwd ?? "",
    testStartupBarrier?.path ?? "",
    testStartupBarrier?.stage ?? "",
    String(mcpCapabilityTimeoutMs),
    restrictRemoteAuthority ? "1" : "0",
    ...input.args,
  ], {
    cwd: input.cwd,
    // The prompt travels as a positional argument; cursor-agent has no stdin
    // channel (matrix row). Its own process group so group signalling reaps
    // any descendants.
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: process.platform !== "win32",
    env: {
      ...(input.env ?? cursorCliEnv()),
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  });

  const lineListeners = new Set<(line: string) => void>();
  const stderrChunks: string[] = [];
  let wrapperTerminalError: string | null = null;
  let wrapperPrepared = false;
  let resolvePrepared!: () => void;
  let rejectPrepared!: (error: Error) => void;
  const prepared = new Promise<void>((resolve, reject) => {
    resolvePrepared = resolve;
    rejectPrepared = reject;
  });
  child.on("message", (message) => {
    const wrapperMessage = message && typeof message === "object"
      ? message as { type?: unknown; error?: unknown }
      : null;
    if (wrapperMessage?.type === "terminal_error"
      && typeof wrapperMessage.error === "string") {
      wrapperTerminalError = wrapperMessage.error;
    }
    if (!wrapperPrepared && message && typeof message === "object"
      && (message as { type?: unknown }).type === "prepared") {
      wrapperPrepared = true;
      resolvePrepared();
    }
  });
  const exited = new Promise<ProviderProcessExit>((resolve) => {
    child.once("error", (error) => {
      if (!wrapperPrepared) rejectPrepared(error);
      resolve({ type: "error", error });
    });
    // "close", not "exit": close fires only after the stdio streams have
    // drained, so the final buffered `result` line is always delivered before
    // the exit evidence resolves. With "exit" a cleanly completed turn could be
    // misclassified as a crash because its result line was still in the pipe
    // (TrailDelta review, msg_1780).
    child.once("close", (code, signal) => {
      if (!wrapperPrepared) rejectPrepared(new Error("Cursor wrapper exited before preparing its durable turn boundary."));
      resolve({ type: "exit", code, signal });
    });
  });
  if (child.stdout) {
    let bufferedLine = Buffer.alloc(0);
    let droppingOversizedLine = false;
    let protocolErrorEmitted = false;
    const emitLine = (line: string) => {
      for (const listener of lineListeners) listener(line);
    };
    const emitOversizedLineError = () => {
      if (protocolErrorEmitted) return;
      protocolErrorEmitted = true;
      emitLine(JSON.stringify({
        type: "letagents_stream_contract_error",
        session_id: "",
        error: "Cursor wrapper emitted an oversized stream-json line.",
      }));
    };
    child.stdout.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(0x0a, cursor);
        if (droppingOversizedLine) {
          if (newline < 0) return;
          droppingOversizedLine = false;
          cursor = newline + 1;
          continue;
        }
        const end = newline < 0 ? chunk.length : newline;
        const segment = chunk.subarray(cursor, end);
        if (bufferedLine.length + segment.length > MAX_CURSOR_STREAM_LINE_BYTES) {
          bufferedLine = Buffer.alloc(0);
          emitOversizedLineError();
          if (newline < 0) {
            droppingOversizedLine = true;
            return;
          }
          cursor = newline + 1;
          continue;
        }
        bufferedLine = bufferedLine.length === 0
          ? Buffer.from(segment)
          : Buffer.concat([bufferedLine, segment]);
        if (newline < 0) return;
        const line = bufferedLine.length > 0 && bufferedLine.at(-1) === 0x0d
          ? bufferedLine.subarray(0, -1)
          : bufferedLine;
        emitLine(line.toString("utf8"));
        bufferedLine = Buffer.alloc(0);
        cursor = newline + 1;
      }
    });
    child.stdout.on("end", () => {
      if (!droppingOversizedLine && bufferedLine.length) emitLine(bufferedLine.toString("utf8"));
      bufferedLine = Buffer.alloc(0);
    });
  }
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
    if (stderrChunks.length > 20) stderrChunks.shift();
  });

  let released = false;
  const result: CursorCliChild = {
    pid: child.pid ?? null,
    exited,
    onLine(listener) {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    stderrTail() {
      return stderrChunks.join("");
    },
    terminalError() {
      return safeCursorTerminalErrorDetail(wrapperTerminalError);
    },
    prepared,
    ownsDescendantReaping: process.platform !== "win32",
    requiresDurableTerminalEvidence: Boolean(input.statePath && restrictRemoteAuthority),
    release() {
      if (released) return;
      released = true;
      child.send?.({
        type: "start",
        ...(providerAuthorization ? { providerAuthorization } : {}),
        ...(input.mcpRuntimeEnv ? { mcpRuntimeEnv: input.mcpRuntimeEnv } : {}),
      });
    },
  };
  if (!input.deferStart) result.release();
  return result;
}
