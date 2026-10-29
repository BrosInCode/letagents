// Cursor managed-profile shapes, limits, and the fixed authority constants they enforce.

import type {
  DesktopCursorMcpPolicy,
  DesktopManagedAgentPermissionProfileId,
} from "../../../ipc-types.js";
import type { LetAgentsMcpRuntime } from "../letagents-mcp-runtime.js";

export interface CursorManagedProfile {
  homeDir: string;
  configDir: string;
  dataDir: string;
  cacheDir: string;
  env: Record<string, string>;
  mcpRuntimeEntryPath?: string;
  mcpRuntimeReadRoots?: string[];
  /** Credentialless base environment for a wrapper-hosted packaged MCP. */
  mcpRuntimeEnv?: Record<string, string>;
  /** Canonical credential-store roots needed only by live identity inspection. */
  authReadRoots?: string[];
  /** Unpredictable per-attempt alias that scopes Cursor's MCP allowlist. */
  mcpServerName?: string;
  /** Exact provider-authority files the native supervised process may not read. */
  nativeDeniedReadPaths?: string[];
  /** Provider-managed/plugin authority trees the native process may not traverse. */
  nativeDeniedReadSubpaths?: string[];
  /** Project authority roots whose metadata/traversal and replacement are denied. */
  nativeDeniedReadMetadataPaths?: string[];
  /** Generated authority paths denied for both native reads and writes. */
  nativeDeniedReadWriteRegexes?: string[];
  /** Git/provider authority patterns denied for native writes only. */
  nativeDeniedWriteRegexes?: string[];
  /** Private authority files Cursor must read but may never mutate. */
  nativeDeniedWritePaths?: string[];
  /** Stable directory entries that may contain writes but may not be unlinked/replaced. */
  nativeDeniedWriteStructuralPaths?: string[];
  /** Immutable packaged/runtime authority trees Cursor may read but not mutate. */
  nativeDeniedWriteSubpaths?: string[];
  /** Private/provider metadata trees that must never become executable launch roots. */
  nativeDeniedExecSubpaths?: string[];
  /** Attempt-private and attested workspace trees writable inside the global fence. */
  nativeAllowedWriteSubpaths?: string[];
  /** Repository/profile/runtime trees readable inside the global data-read fence. */
  nativeAllowedReadSubpaths?: string[];
}

export interface CursorManagedProfileOptions {
  sourceHomeDir?: string | null;
  homeDir?: string | null;
  workspaceRoot?: string | null;
  mcpPolicy?: DesktopCursorMcpPolicy | null;
}

export interface CursorSupervisedProfileOptions {
  workAttemptId: string;
  apiBaseUrl: string;
  workspaceRoot: string;
  /** Exact scratch workspaces must never inherit an ancestor repository boundary. */
  exactWorkspaceOnly?: boolean;
  /** Attested native authority; only sandboxed_write remains confined to this workspace. */
  permissionProfileId?: DesktopManagedAgentPermissionProfileId;
  sourceHomeDir?: string | null;
  /** Auth-only source refreshed by a just-completed live identity attestation. */
  authSourceHomeDir?: string | null;
  /** Disposable profile is awaiting a live identity proof; cached team metadata is non-authoritative. */
  identityAttestationOnly?: boolean;
  /** Exact personal identity returned by the fenced live GetMe attestation. */
  attestedPersonalIdentity?: CursorPersonalIdentity;
  /** Final inference profiles retain identity metadata but no login credentials. */
  exposeLoginCredentials?: boolean;
  /** Test-only/custom state root; production derives an owner-local stable path. */
  profileRoot?: string | null;
  /** Omit all provider login material for non-authoritative inspection profiles. */
  includeAuth?: boolean;
  /** Use a zero-tool local MCP probe only to enumerate Cursor's effective registry. */
  inspectionOnly?: boolean;
  /** Packaged absolute bridge used by every authority-bearing profile. */
  mcpRuntime?: LetAgentsMcpRuntime;
  /** Credentialless validation may use its empty disposable directory. */
  mcpWorkingDirectory?: string;
  /** Exact bounded-turn coordinates explicitly delivered to Cursor's MCP child. */
  supervisorMcpEnv?: Readonly<Record<string, string>>;
  /** Per-turn wrapper socket used instead of exposing supervisor coordinates to native Cursor. */
  mcpConnectorSocketPath?: string;
}

export interface CursorPersonalIdentity {
  userId: number;
  email: string | null;
  /** Held only in memory by the trusted proxy; never persisted to a profile. */
  providerAuthorization?: string;
}

export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}\n';

export const MAX_CURSOR_CONFIG_BYTES = 4 * 1024 * 1024;

export const MAX_WORKSPACE_MCP_BYTES = 256 * 1024;

export const MAX_CURSOR_PROFILE_ENTRIES = 4_096;

export const RETAINED_CURSOR_TURN_JOURNALS = 8;

export const SUPERVISED_CURSOR_PERMISSION_PROFILE_IDS = new Set<DesktopManagedAgentPermissionProfileId>([
  "read_only",
  "sandboxed_write",
  "full_access",
]);

export const CURSOR_TURN_STREAM_PATTERN = /^letagents-cursor-turn-[a-f0-9]{64}\.jsonl$/;

export const CURSOR_STATSIG_TEMP_PATTERN = /^statsig-cache\.json\.[1-9]\d{0,9}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

export const CURSOR_CLI_AUTH_KEYS = new Set(["authInfo"]);

export const CURSOR_AGENT_STATE_AUTH_KEYS = new Set([
  "accessToken",
  "authInfo",
  "expiresAt",
  "refreshToken",
  "token",
  "version",
]);

export const CURSOR_AUTH_INFO_KEYS = new Set([
  "accessToken",
  "authId",
  "displayName",
  "email",
  "expiresAt",
  "organizationId",
  "refreshToken",
  "teamId",
  "teamName",
  "token",
  "userId",
  "version",
]);

export const CURSOR_MCP_INSPECTION_PROBE_SOURCE = String.raw`
const { createInterface } = require("node:readline");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || message.id === undefined) return;
  let result = {};
  if (message.method === "initialize") {
    result = {
      protocolVersion: message.params && message.params.protocolVersion || "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "letagents-inspection", version: "1" },
    };
  } else if (message.method === "tools/list") {
    result = { tools: [] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
`;

export const CURSOR_MCP_SOCKET_CONNECTOR_SOURCE = String.raw`
const net = require("node:net");
const socketPath = process.argv[1];
if (typeof socketPath !== "string" || !socketPath.startsWith("/") || socketPath.length > 1024) process.exit(64);
const socket = net.createConnection({ path: socketPath });
socket.setNoDelay(true);
socket.once("connect", () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.once("error", () => process.exit(1));
socket.once("close", () => process.exit(0));
process.stdin.once("error", () => socket.destroy());
process.stdout.once("error", () => socket.destroy());
`;

/**
 * Windows: the same connector to the wrapper's named pipe. It opens the pipe
 * the way the supervisor daemon's clients do (shared/daemon-pipe-native.mjs,
 * whose path is the third argument): through the sealed addon, with
 * SECURITY_IDENTIFICATION, and only when the process serving the pipe runs as
 * this user. That process must also be this turn's wrapper (the pid it wrote
 * to connector.server). Only then does the connector send the turn's proof
 * from the private connector folder; the wrapper admits no client without it
 * (cursorMcpConnectorListenPath). Exit codes: 64 bad arguments, 65 no proof
 * or wrapper pid, 66 the addon cannot load here, 67 the pipe's server is not
 * this turn's wrapper.
 */
export const CURSOR_MCP_PIPE_CONNECTOR_SOURCE = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const [pipePath, proofPath, pipeNativePath] = process.argv.slice(1);
if (typeof pipePath !== "string" || !/^\\\\[.]\\pipe\\letagents-cursor-mcp-[0-9a-f]{32}$/.test(pipePath)) process.exit(64);
if (typeof proofPath !== "string" || !path.isAbsolute(proofPath) || path.basename(proofPath) !== "connector.proof") process.exit(64);
if (typeof pipeNativePath !== "string" || path.basename(pipeNativePath) !== "daemon-pipe-native.mjs"
  || !(process.platform === "win32" ? /^[A-Za-z]:\\/.test(pipeNativePath) : path.isAbsolute(pipeNativePath))) process.exit(64);
let proof;
let serverPid;
try {
  proof = fs.readFileSync(proofPath, "utf8").trim();
  serverPid = Number(fs.readFileSync(path.join(path.dirname(proofPath), "connector.server"), "utf8").trim());
} catch { process.exit(65); }
if (!/^[0-9a-f]{64}$/.test(proof) || !Number.isSafeInteger(serverPid) || serverPid <= 0) process.exit(65);
// Exit once what was written to stdout and stderr is out (a pipe may write
// asynchronously), and at the latest after two seconds.
const exitAfterOutput = (code) => {
  setTimeout(() => process.exit(code), 2000);
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
};
const refuse = (code, message) => {
  process.stderr.write("LetAgents: Cursor's MCP connector " + message + "\n");
  exitAfterOutput(code);
};
const describe = (error) => (error && error.message ? error.message : String(error));
function connect(addon) {
  const deadline = Date.now() + 10000;
  const attempt = () => {
    let opened;
    try {
      opened = addon.open(pipePath);
    } catch (error) {
      if (error && error.code === "EBUSY" && Date.now() < deadline) { setTimeout(attempt, 20); return; }
      refuse(error && error.code === "ERR_LETAGENTS_DAEMON_UNTRUSTED" ? 67 : 1, "could not open its pipe: " + describe(error));
      return;
    }
    if (!opened || !Number.isInteger(opened.fd) || opened.fd < 0) { refuse(1, "got no descriptor for its pipe."); return; }
    if (opened.serverPid !== serverPid) {
      try { fs.closeSync(opened.fd); } catch {}
      refuse(67, "refused its pipe: process " + opened.serverPid + " serves it, not this turn's wrapper.");
      return;
    }
    const socket = new net.Socket({ fd: opened.fd, readable: true, writable: true });
    socket.once("error", () => exitAfterOutput(1));
    socket.once("close", () => exitAfterOutput(0));
    process.stdin.once("error", () => socket.destroy());
    process.stdout.once("error", () => socket.destroy());
    socket.write(proof + "\n");
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  };
  attempt();
}
import(pathToFileURL(pipeNativePath).href)
  .then((native) => native.loadDaemonPipeAddon())
  .then(connect, (error) => refuse(66, "cannot open its pipe safely on this computer: " + describe(error)));
`;
export const SUPERVISED_CURSOR_PROJECT_AUTHORITY_FILES = [
  [".cursor", "cli.json"],
  [".cursor", "cli-config.json"],
  [".cursor", "mcp.json"],
  [".cursor", "permissions.json"],
  [".cursor", "settings.json"],
  [".cursor", "hooks.json"],
] as const;

export const SUPERVISED_CURSOR_PROJECT_HIDDEN_AUTHORITY_FILES = [
  ...SUPERVISED_CURSOR_PROJECT_AUTHORITY_FILES,
  // Cursor recognizes Claude-compatible settings, but another provider's
  // checked-in/local configuration must not make a supervised workspace
  // unusable. Keep these files present for Claude while denying Cursor's
  // complete native process tree both read and write access below.
  [".claude", "settings.json"],
  [".claude", "settings.local.json"],
] as const;

export const SUPERVISED_CURSOR_MCP_ENV_KEYS = new Set([
  "LETAGENTS_SUPERVISOR_ENTRY_ID",
  "LETAGENTS_SUPERVISOR_DAEMON_SOCKET",
  "LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID",
  "LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID",
  "LETAGENTS_SUPERVISOR_PROVIDER",
  "LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID",
  "LETAGENTS_SUPERVISOR_AGENT_SESSION_ID",
  "LETAGENTS_SUPERVISOR_ROOM_ID",
  "LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME",
  "LETAGENTS_SUPERVISED_BOUNDED_TURNS",
  "LETAGENTS_EXECUTION_PROFILE",
  "LETAGENTS_PERMISSION_PROFILE_ID",
]);

export const DARWIN_CURSOR_ENTERPRISE_HOOK_PATH = "/Library/Application Support/Cursor/hooks.json";

export const DEFAULT_CURSOR_MCP_POLICY: DesktopCursorMcpPolicy = "filter_letagents";
