// Slice of the Cursor turn wrapper program (see turn-launcher.ts):
// the wrapper's argv and state, stream inspection, and native process-group
// reaping.
// The slices concatenate in order into one script run with `node -e` (on
// Windows from an owner-private file); keep each slice's text exactly as the
// wrapper needs it. Windows-only text is chosen by `platform`, so the macOS
// program stays byte-for-byte the same.

import {
  CURSOR_LIVE_MCP_CAPABILITY_TIMEOUT_MS,
  CURSOR_MCP_CONNECTOR_PARENT,
  CURSOR_SUPERVISED_CONTROL_PLANE_PATHS,
  MAX_CURSOR_SESSION_ID_LENGTH,
  MAX_CURSOR_STREAM_EVENTS,
  MAX_CURSOR_STREAM_LINE_BYTES,
  MAX_DURABLE_TURN_STREAM_BYTES,
} from "../cursor-provider-constants.js";
import { escapeCursorSandboxRegex } from "../cursor-sandbox-policy.js";
import type { CursorWindowsTurnValues } from "./windows-turn.js";

/**
 * The connector-root pattern is built when a wrapper program is assembled, never
 * at module load: on Windows the parent is a `C:\\...` temporary folder, which
 * the sandbox-regex escape refuses, and a throw at load broke every main-process
 * module that imports this one. Windows builds its own pattern below.
 */
export function cursorMcpConnectorRootPattern(
  parent: string = CURSOR_MCP_CONNECTOR_PARENT,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    // The wrapper only matches this pattern; there is no sandbox profile to escape it for.
    const escaped = parent.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    return `^${escaped}\\\\letagents-cursor-mcp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`;
  }
  return `^${escapeCursorSandboxRegex(parent)}/letagents-cursor-mcp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`;
}

/** Launch values that the wrapper program embeds as JSON literals. */
export interface CursorWrapperLaunchValues {
  agentUpstreamEndpoint: string;
  controlPlaneUpstreamEndpoint: string;
  deniedDelegatingExecutablePaths: string[];
  /** Required on Windows: how the wrapper starts Cursor and where its connector listens. */
  windows?: CursorWindowsTurnValues;
}

export function cursorWrapperSetupSource(
  values: CursorWrapperLaunchValues,
  platform: NodeJS.Platform = process.platform,
): string {
  const { agentUpstreamEndpoint, controlPlaneUpstreamEndpoint, deniedDelegatingExecutablePaths } = values;
  const windows = platform === "win32";
  if (windows && !values.windows) throw new Error("The Windows Cursor wrapper needs its launch values.");
  return String.raw`const { appendFileSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { randomBytes, randomUUID } = require("node:crypto");
const http = require("node:http");
const http2 = require("node:http2");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const [bin, statePath, workspaceGenerationManifestPath, deniedReadPathsJson, deniedReadSubpathsJson, deniedReadMetadataPathsJson, deniedReadWriteRegexesJson, deniedWriteRegexesJson, deniedWritePathsJson, deniedWriteStructuralPathsJson, deniedWriteSubpathsJson, deniedExecSubpathsJson, allowedWriteSubpathsJson, allowedReadSubpathsJson, allowedNetworkUnixSocketsJson, allowedInternalUnixSocketRootsJson, mcpConnectorSocketPath, mcpRuntimeEntryPath, mcpRuntimeCwd, testStartupBarrierPath, testStartupBarrierStage, mcpCapabilityTimeoutMsValue, restrictRemoteAuthorityValue, fullAccessValue, ...args] = process.argv.slice(1);
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
const fullAccess = fullAccessValue === "1";
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
const mcpConnectorRootPattern = new RegExp(${JSON.stringify(cursorMcpConnectorRootPattern(CURSOR_MCP_CONNECTOR_PARENT, platform))});
${windows ? windowsTurnSource(values.windows!) : ""}let started = false;
let startPromise = null;
let native = null;
let authorityProxy = null;
let agentProxy = null;
let mcpConnectorServer = null;
let mcpConnectorSocket = null;
let mcpRuntime = null;
let mcpRuntimeProcessIdentity = null;
// Lost group continuity or a confirmed leader mismatch permanently revokes
// signal authority across overlapping or repeated startup cleanup calls.
let runtimeGroupSignalAuthorized = false;
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
// Which clean-up checks could not be proven; written beside remote_authority_revoked.
// A later pass that proves a check again clears it, so this is the last answer.
const revocationFailures = new Set();
function noteRevocation(check, failed) {
  if (failed) revocationFailures.add(check);
  else revocationFailures.delete(check);
}
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
    settleMcpCapabilityWaiters(false);
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
function runGroupProbe() {
  // A timed-out probe says nothing about the process table: under load a quick
  // ps can miss its bound. Retry it, at most twice more, with a longer bound.
  // Any other answer, including "members are still alive", is final.
  let inspected;
  for (const timeout of [250, 1000, 1000]) {
    inspected = spawnSync("/bin/ps", ["-axo", "pid=,pgid="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], detached: true,
      timeout, maxBuffer: 1024 * 1024,
    });
    if (!inspected.error || inspected.error.code !== "ETIMEDOUT") break;
  }
  return inspected;
}
function processGroupMembers(groupId, excludedPid = null) {
  if (process.platform === "win32") return [];
  try {
    // The detached ps probe cannot become a false member of either supervised
    // process group. A live group leader also prevents its PGID from being
    // recycled while retirement is inspecting it.
    const inspected = runGroupProbe();
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
${windows ? WINDOWS_NATIVE_REAP_SOURCE : POSIX_NATIVE_REAP_SOURCE}function beginReaping() {
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
`;
}

/**
 * Windows declarations: the launch values, and the native command line. Main
 * quoted Cursor's program and the adapter's arguments (quoteWindowsArgument);
 * the wrapper adds only its own proxy flags, which are plain tokens.
 */
function windowsTurnSource(values: CursorWindowsTurnValues): string {
  return String.raw`const windowsTurn = ${JSON.stringify(values)};
let nativeHelperBirth = null;
function windowsNativeCommandLine(cursorArgs) {
  const added = cursorArgs.slice(0, cursorArgs.length - args.length);
  if (added.some((arg) => typeof arg !== "string" || !/^[A-Za-z0-9_.:/=-]+$/.test(arg))) {
    throw new Error("Cursor's proxy arguments are not plain tokens.");
  }
  return [windowsTurn.head, ...added, windowsTurn.tail].filter(Boolean).join(" ");
}
function readNativeHelperBirth(pid) {
  // The creation time of the exact helper while this wrapper holds it, so its
  // pid cannot be reused before the helper ends that job.
  try {
    const info = spawnSync(windowsTurn.helper, ["info", String(pid)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 10000,
    });
    if (info.error || info.status !== 0) return null;
    const parsed = JSON.parse(String(info.stdout).trim());
    return parsed && parsed.pid === pid && typeof parsed.creationTime === "string" && /^[0-9]+$/.test(parsed.creationTime)
      ? parsed.creationTime
      : null;
  } catch { return null; }
}
`;
}

// macOS and Linux: the process-group reaping the wrapper has always done.
const POSIX_NATIVE_REAP_SOURCE = String.raw`function signalNativeGroup(signal) {
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
`;

// Windows: native Cursor runs inside letagents-process-tree.exe's job. The
// helper exits only once that job is empty, so its exit is the proof that
// every Cursor descendant ended. Ending the job goes through the helper with
// the helper's recorded birth; it waits until the job is empty.
const WINDOWS_NATIVE_REAP_SOURCE = String.raw`function signalNativeGroup(signal) {
  if (!native) return;
  // Ending the helper closes its job, and Windows ends every process in it.
  try { native.kill(signal); } catch {}
}
function endNativeJob() {
  if (!nativeHelperBirth) return null;
  try {
    const ended = spawnSync(windowsTurn.helper, ["kill", String(native.pid), nativeHelperBirth], {
      stdio: "ignore", windowsHide: true, timeout: 15000,
    });
    // 0: the job was ended and is empty; 2: the helper already exited, which it does only once its job is empty.
    return ended.error ? null : ended.status;
  } catch { return null; }
}
async function reapNativeGroup() {
  if (!native) return true;
  if (native.exitCode !== null || native.signalCode !== null) return true;
  const exited = new Promise((resolve) => native.once("exit", resolve));
  const status = endNativeJob();
  if (status === 0 || status === 2) {
    await exited;
    return true;
  }
  // The job could not be ended through the helper: end the helper, which
  // closes the job, but report the descendants as unproven.
  signalNativeGroup("SIGKILL");
  await exited;
  return false;
}
`;
