import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readlinkSync, readSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  buildCodexStartPrompt,
  DEFAULT_CODEX_STOP_PHRASE,
  looksLikeInviteCode,
  makeCodexStopToken,
} from "./codex-start-prompt.js";
import {
  synthesizeTerminalPayload,
  type ProviderActivityEvent,
  type ProviderAdapter,
  type ProviderAdapterCapabilities,
  type ProviderConnectionRef,
  type ProviderContinuationRef,
  type ProviderHandle,
  type ProviderObservedState,
  type ProviderRoomTurnOptions,
  type ProviderRoomTurnRecoveryRequest,
  type ProviderRoomTurnRequest,
  type ProviderRoomTurnResult,
  type ProviderSpawnRequest,
  type ProviderStopOptions,
  type ProviderTurnControlResult,
  type ProviderTurnControlOptions,
  ProviderTurnControlError,
  type ProviderStreamEvent,
  type ProviderStreamEventKind,
  type ProviderTerminalPayload,
} from "./provider-adapter.js";
import { attestProviderSpawnPolicy } from "./provider-spawn-configuration.js";
import {
  DEFAULT_STOP_GRACE_MS,
  defaultGetProcessIdentity,
  defaultSignalProcess,
  delay,
  redactCredentialText,
  safeStreamPayload,
  sameProcessBirthIdentity,
  type ProviderProcessExit,
} from "./provider-evidence.js";
import { apiUrl as desktopApiUrl } from "../paths.js";
import {
  bindCursorSupervisedIdentity,
  prepareCursorSupervisedProfile,
  type CursorPersonalIdentity,
  type CursorManagedProfile,
  type CursorSupervisedProfileOptions,
} from "./cursor-managed-profile.js";
import {
  assertCursorSupervisedMcpAuthority,
  cursorMcpInspectionEnv,
  runCursorSandboxedInspection,
} from "./cursor-mcp-authority.js";
import { resolveLetAgentsMcpRuntime } from "./letagents-mcp-runtime.js";
import { buildCursorChildEnv } from "./cursor-runner.js";
import { cursorPermissionProfileInstructionLines } from "./cursor-permission-profile.js";
import {
  createSupervisedWorkspaceGeneration,
  recoverSupervisedWorkspaceGeneration,
  removeSupervisedWorkspaceGenerationReceipt,
  type SupervisedWorkspaceGenerationHandle,
} from "./supervised-workspace-generation.js";

// P2b (plan v10 §4.8/§6, task_38, matrix row in §4.8): Cursor through its
// native `cursor-agent` harness. Unlike Codex (durable app-server) and Claude
// (long-lived stream-json child), Cursor's native shape is ONE CHILD PER TURN:
// the process exists only while a turn runs, exits with a real code/signal,
// and the session continues across turns via `--resume <session_id>`.
//
// The adapter therefore models the work attempt as a LANE, not a process:
//   - a live turn has a real pid + birth identity and full #765 exit evidence;
//   - between turns the lane is honestly `idle` with NO claimed process — the
//     connection ref carries no pid, and nothing may treat the lane as a live
//     writer (the matrix's "never a claimed live process" cell);
//   - a successful turn result is TURN-terminal, never ATTEMPT-terminal; the
//     attempt ends only via stop() or a turn that dies without its result.
//
// For daemon-owned turns this boundary also attests the read-only native policy,
// reseals an attempt-private MCP profile, and builds a narrow child environment.
// Generic interactive Cursor lanes retain their established local behavior.

const TURN_START_TIMEOUT_MS = 30_000;
// Live MCP capability attestation is part of native turn startup. Keep both
// observations on one deadline so a legitimate cold Cursor process is not
// killed before the adapter's own startup contract has expired.
const CURSOR_LIVE_MCP_CAPABILITY_TIMEOUT_MS = TURN_START_TIMEOUT_MS;
const MAX_DURABLE_TURN_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_DURABLE_TURN_TERMINAL_BYTES = 1024 * 1024;
const MAX_CURSOR_STREAM_LINE_BYTES = 512 * 1024;
const MAX_CURSOR_STREAM_EVENTS = 4_096;
const MAX_CURSOR_SESSION_ID_LENGTH = 256;
const MAX_CURSOR_TERMINAL_ERROR_DETAIL_LENGTH = 1_024;
const CURSOR_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// The bridge is packaged locally; a registry check must never wait on network
// installation. Keep enough room for Cursor's native MCP handshake on a busy
// machine without turning a broken local runtime into a long launch stall.
const CURSOR_REAL_MCP_VALIDATION_TIMEOUT_MS = 15_000;
const CURSOR_IDENTITY_ATTESTATION_TIMEOUT_MS = 15_000;
const CURSOR_SUPERVISED_AGENT_ENDPOINT = "https://api2.cursor.sh";
const CURSOR_SUPERVISED_CONTROL_PLANE_PATHS = [
  "/aiserver.v1.DashboardService/GetMe",
  "/aiserver.v1.DashboardService/GetUserPrivacyMode",
  "/aiserver.v1.ServerConfigService/GetServerConfig",
  "/aiserver.v1.AiService/AvailableModels",
  "/aiserver.v1.AiService/GetUsableModels",
  "/aiserver.v1.AiService/GetDefaultModelForCli",
] as const;

function cursorPermissionUsesWorkspaceGeneration(
  permissionProfileId: ProviderSpawnRequest["permissionProfileId"],
): boolean {
  return permissionProfileId === "sandboxed_write" || permissionProfileId === "full_access";
}

type CursorStreamMessage = Record<string, unknown> & {
  type?: unknown;
  subtype?: unknown;
  session_id?: unknown;
  is_error?: unknown;
  result?: unknown;
  request_id?: unknown;
};

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

export interface CursorProviderAdapterDependencies {
  launchTurn(input: { cursorBin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; deferStart?: boolean; statePath?: string; workspaceGenerationManifestPath?: string; deniedReadPaths?: string[]; deniedReadSubpaths?: string[]; deniedReadMetadataPaths?: string[]; deniedReadWriteRegexes?: string[]; deniedWriteRegexes?: string[]; deniedWritePaths?: string[]; deniedWriteStructuralPaths?: string[]; deniedWriteSubpaths?: string[]; deniedExecSubpaths?: string[]; allowedWriteSubpaths?: string[]; allowedReadSubpaths?: string[]; allowedNetworkUnixSockets?: string[]; mcpConnectorSocketPath?: string; mcpRuntimeEntryPath?: string; mcpRuntimeCwd?: string; mcpRuntimeEnv?: Readonly<Record<string, string>>; providerAuthorization?: string; restrictRemoteAuthority?: boolean; testAgentUpstreamEndpoint?: string; testControlPlaneUpstreamEndpoint?: string; testMcpCapabilityTimeoutMs?: number; testStartupBarrier?: { path: string; stage: "mcp_listen" | "authority_listen" | "agent_listen" } }): CursorCliChild;
  attestSupervisedMcp(input: {
    cursorBin: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    writableProfileRoot: string;
    requiredReadableRoots?: string[];
    expectedServerName?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<void>;
  attestPersonalIdentity(input: {
    cursorBin: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    writableProfileRoot: string;
    requiredReadableRoots?: string[];
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<CursorPersonalIdentity>;
  bindPersonalIdentity(profile: CursorManagedProfile, identity: CursorPersonalIdentity): void;
  signalProcess(pid: number, signal: NodeJS.Signals): void;
  /** null means verified absent; undefined means liveness could not be verified. */
  getProcessIdentity(pid: number): string | null | undefined;
  prepareTurnState(path: string): void;
  createWorkspaceGeneration: typeof createSupervisedWorkspaceGeneration;
  recoverWorkspaceGeneration: typeof recoverSupervisedWorkspaceGeneration;
  removeWorkspaceGenerationReceipt: typeof removeSupervisedWorkspaceGenerationReceipt;
  now(): string;
}

export interface CursorProviderAdapterOptions {
  cursorBin?: string;
  dependencies?: Partial<CursorProviderAdapterDependencies>;
  activitySink?: (event: ProviderActivityEvent) => void;
  streamSink?: (event: ProviderStreamEvent) => void;
  /** Bound on waiting for the first stream event of a turn (startup preflight). */
  turnStartTimeoutMs?: number;
  /** SIGTERM → SIGKILL escalation window for stop() and the attach-path fence. */
  stopGraceMs?: number;
  /** Injectable so adapter tests never touch the user's real Cursor profile. */
  supervisedProfileFactory?: (input: {
    workAttemptId: string;
    cwd: string;
    /** Exact durable permission authority selected for the supervised lane. */
    permissionProfileId?: CursorSupervisedProfileOptions["permissionProfileId"];
    /** Disposable root for non-authoritative MCP inspection. */
    profileRoot?: string;
    /** Inspection profiles deliberately omit Cursor login credentials. */
    includeAuth?: boolean;
    /** Auth-only source already refreshed by a live identity attestation. */
    authSourceHomeDir?: string;
    identityAttestationOnly?: boolean;
    attestedPersonalIdentity?: CursorPersonalIdentity;
    exposeLoginCredentials?: boolean;
    /** Inspection profiles expose only an inert local MCP readiness probe. */
    inspectionOnly?: boolean;
    /** Development-only runtime entry already gated by the daemon. */
    devMcpServerEntryPath?: string;
    /** Credentialless validation runs outside the real repository. */
    mcpWorkingDirectory?: string;
    /** Exact bounded-turn coordinates explicitly written into final MCP config. */
    supervisorMcpEnv?: Readonly<Record<string, string>>;
    /** Per-turn stdio connector owned by the durable wrapper. */
    mcpConnectorSocketPath?: string;
  }) => CursorManagedProfile;
}

export class CursorIdentityAuthRequiredError extends Error {
  constructor() {
    super("Cursor Agent needs sign-in before its live identity can be supervised.");
    this.name = "CursorIdentityAuthRequiredError";
  }
}

export class CursorTeamManagedIdentityError extends Error {
  constructor() {
    super(
      "Team-managed Cursor accounts are not supported for supervised agents because Cursor team policy cannot be safely mediated yet.",
    );
    this.name = "CursorTeamManagedIdentityError";
  }
}

const BASE_CURSOR_CAPABILITIES: ProviderAdapterCapabilities = {
  deliveryModes: ["mcp_polling", "daemon_inbox"],
  // `--resume <session_id>` is the documented continuation across per-turn
  // children (the legacy engine already relies on it); the adapter asserts the
  // session identity echo per turn. Subject to TrailDelta's task_38 spike cell.
  resume: true,
  // cursor-agent takes its prompt as a positional argument and ignores stdin —
  // there is NO channel into a RUNNING turn. poke() delivers at the next turn
  // boundary (immediately when idle) and refuses mid-turn, so the reconciler's
  // stuck-agent poke rung must stay off.
  midTurnInjection: false,
  // A legacy polling lane can still call controlTurn directly with a
  // correction, but the negotiated supervised capability is false: daemon
  // inbox corrections must use the durable stop-then-resend row rather than
  // start an unjournaled side turn.
  midTurnCorrection: false,
  // Every turn's stream-json output is published as bounded/redacted evidence.
  transcriptAccess: true,
  permissionPromptBridging: false,
  // Between turns there is no process at all; after a daemon restart the lane
  // resumes via the session id. Bounded recovery, not survival (§4.8).
  survivesRestart: false,
  turnControl: "restart_resume",
};

// Provider configuration normalizes Cursor permission authority into exactly
// these three native flags. Fail closed on everything else: Cursor has aliases
// such as --yolo/--continue and path/plugin flags that can silently override
// the supervised workspace, sandbox, or continuation boundary.
const ALLOWED_POLICY_KEYS = new Set(["mode", "force", "sandbox"]);

export const CURSOR_NO_ROOM_REPLY_SENTINEL = "LETAGENTS_NO_ROOM_REPLY";
const CURSOR_PENDING_CONTINUATION_PREFIX = "cursor-pending:";
const CURSOR_MCP_CONNECTOR_PARENT = "/tmp";
const CURSOR_MCP_CONNECTOR_ROOT_PATTERN = `^${escapeCursorSandboxRegex(CURSOR_MCP_CONNECTOR_PARENT)}/letagents-cursor-mcp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`;

export function boundedCursorRoomTurnPrompt(
  request: ProviderRoomTurnRequest,
  turnId: string,
  permissionProfileId?: string | null,
): string {
  return [
    "You are handling one daemon-owned room inbox item in an exact bounded turn.",
    `Your durable charter: ${request.charter?.trim() || "Help thoughtfully within the room."}`,
    ...cursorPermissionProfileInstructionLines(permissionProfileId as CursorSupervisedProfileOptions["permissionProfileId"]),
    "The daemon owns observation, credentials, retries, and publication. Do not register a session, authenticate, poll, or manage runtime lifecycle.",
    "You may use the discovered LetAgents product tools for bounded room context, tasks, artifacts, status, deliberate side messages, or moving to another room. Those actions are daemon-mediated.",
    "Assistant text generated during this turn is live activity only. Cursor's terminal result concatenates that activity, so it is never published as the room reply.",
    "After all work is finished, call complete_room_turn exactly once with either { outcome: \"reply\", text: \"your concise public answer\" } or { outcome: \"no_reply\" }.",
    "Do not send the activating reply with send_message or send_thread_message. The daemon publishes only the exact complete_room_turn proposal after the provider and its authority retire cleanly.",
    "After complete_room_turn succeeds, end this provider turn without revising or repeating the proposal.",
    `Turn id: ${turnId}`,
    `Inbox item: ${request.inboxItemId}`,
    `Recent bounded room context: ${JSON.stringify(request.observedContext ?? [])}`,
    `Source message: ${JSON.stringify(request.sourceMessage)}`,
    `Activation: ${JSON.stringify(request.activation)}`,
  ].join("\n");
}

function camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * Render the attested Add Agent permission policy as CLI flags —
 * `{ mode: "ask", force: true, sandbox: "enabled" }` becomes
 * `--mode ask --force --sandbox enabled`. Purely syntactic; values are never
 * mapped or renamed. Unknown flags fail closed because Cursor exposes authority
 * aliases and alternate workspace/plugin roots outside these three keys.
 *
 * Model is adapter-owned because it is separately attested in the durable
 * provider configuration snapshot. Allowing launchPolicy.model as well would
 * create duplicate flags with provider-version-dependent precedence.
 */
export function cursorLaunchPolicyArgs(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cursor launchPolicy must be the native CLI options object.");
  }
  const policy = value as Record<string, unknown>;
  const args: string[] = [];
  for (const [key, entry] of Object.entries(policy)) {
    if (!ALLOWED_POLICY_KEYS.has(key)) {
      throw new Error(`Cursor launchPolicy contains unsupported or adapter-owned flag '${key}'.`);
    }
    if (entry === undefined || entry === null || entry === false) continue;
    const flag = `--${camelToKebab(key)}`;
    if (entry === true) {
      args.push(flag);
    } else if (Array.isArray(entry)) {
      args.push(flag, entry.map((item) => String(item)).join(","));
    } else if (typeof entry === "string" || typeof entry === "number") {
      args.push(flag, String(entry));
    } else {
      throw new Error(`Cursor launchPolicy value for '${key}' must be a scalar, boolean, or string array.`);
    }
  }
  return args;
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

function cursorDaemonChildEnv(
  profileEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  // Supervised children receive the established Cursor runtime allowlist only;
  // Electron often carries unrelated GitHub/cloud/npm/database credentials.
  const env = buildCursorChildEnv(profileEnv);
  // A bounded provider turn borrows only the daemon's exact-generation tool
  // authority. Ambient desktop owner/fixed-worker credentials and stale
  // supervisor coordinates must never leak into the Cursor child or its MCPs.
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === "LETAGENTS_TOKEN"
      || normalizedKey === "LETAGENTS_AGENT_SESSION_BEARER"
      || normalizedKey === "CURSOR_API_KEY"
      || normalizedKey === "CURSOR_AUTH_TOKEN"
      || normalizedKey === "NODE_EXTRA_CA_CERTS"
      || normalizedKey === "SSL_CERT_DIR"
      || normalizedKey === "SSL_CERT_FILE"
      || normalizedKey.startsWith("LETAGENTS_SUPERVISOR_")
      || normalizedKey === "LETAGENTS_SUPERVISED_BOUNDED_TURNS"
      || normalizedKey === "LETAGENTS_EXECUTION_PROFILE"
      || normalizedKey === "LETAGENTS_PERMISSION_PROFILE_ID") {
      delete env[key];
    }
  }
  return env;
}

function cursorSupervisorMcpEnv(
  req: ProviderSpawnRequest,
  providerTurnId?: string | null,
): Record<string, string> {
  return {
    LETAGENTS_SUPERVISOR_ENTRY_ID: req.supervisorEntryId!,
    LETAGENTS_SUPERVISOR_DAEMON_SOCKET: req.supervisorSocketPath!,
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: req.workAttemptId,
    LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: req.supervisorExecutionGenerationId!,
    LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
    ...(providerTurnId ? { LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: providerTurnId } : {}),
    ...(req.supervisorWorkerSession ? {
      LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: req.supervisorWorkerSession.agentSessionId,
      LETAGENTS_SUPERVISOR_ROOM_ID: req.roomId,
      ...(req.agentDisplayName?.trim()
        ? { LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: req.agentDisplayName.trim() }
        : {}),
    } : {}),
    LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
    LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
    ...(req.permissionProfileId
      ? { LETAGENTS_PERMISSION_PROFILE_ID: req.permissionProfileId }
      : {}),
  };
}

function throwIfCursorTurnLaunchAborted(signal?: AbortSignal, roomTurnId?: string | null): void {
  if (signal?.aborted) {
    throw new CursorRoomTurnNotDispatchedError(
      "Cursor turn preparation was interrupted before native dispatch.",
      roomTurnId,
    );
  }
}

function cursorTurnLaunchAbort(signal?: AbortSignal): Promise<"aborted"> {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}

function cursorStreamKind(message: CursorStreamMessage): ProviderStreamEventKind {
  const type = typeof message.type === "string" ? message.type : "";
  if (type === "assistant") return "text_delta";
  // Cursor's documented `user` event is the prompt echo, not a tool result.
  if (type === "user") return "provider_event";
  if (type === "tool_call" || type === "tool_use" || type === "tool_use_summary") return "tool_lifecycle";
  if (type === "result") return "turn_lifecycle";
  if (type === "system") return "provider_event";
  if (/error/i.test(type)) return "error";
  return "provider_event";
}

type CursorLiveDisplayProjection = {
  method: "item/agentMessage/delta" | "item/toolCall/updated";
  kind: "text_delta" | "tool_lifecycle";
  payload: Record<string, unknown>;
};

function cursorRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cursorToolError(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  try { return JSON.stringify(value, null, 2); }
  catch { return "Cursor reported an unreadable tool error."; }
}

/**
 * Project an already-redacted/bounded Cursor event into the renderer's
 * provider-neutral display contract. Raw provider evidence is published
 * separately and remains untouched for daemon coordination.
 */
export function cursorLiveDisplayProjections(
  safeProviderPayload: unknown,
  exactTurnNamespace: string,
  eventNamespace: string,
): CursorLiveDisplayProjection[] {
  const message = cursorRecord(safeProviderPayload);
  if (!message || !exactTurnNamespace) return [];
  if (message.type === "assistant") {
    const body = cursorRecord(message.message);
    if (body?.role !== "assistant") return [];
    const delta = typeof body.content === "string"
      ? body.content
      : Array.isArray(body.content)
        ? body.content.flatMap((candidate) => {
          const block = cursorRecord(candidate);
          return block?.type === "text" && typeof block.text === "string" && block.text
            ? [block.text]
            : [];
        }).join("")
        : "";
    return delta
      ? [{
        method: "item/agentMessage/delta" as const,
        kind: "text_delta" as const,
        payload: {
          partId: `cursor:${exactTurnNamespace}:assistant:${eventNamespace}`,
          delta,
        },
      }]
      : [];
  }
  if (message.type !== "tool_call") return [];
  if (message.subtype !== "started" && message.subtype !== "completed") return [];
  if (typeof message.call_id !== "string" || !message.call_id.trim()) return [];
  const toolCalls = cursorRecord(message.tool_call);
  if (!toolCalls) return [];
  // Cursor may include object-valued metadata before the actual tool envelope.
  // Only documented `*ToolCall` keys name a callable operation; choosing the
  // first object would turn metadata into a fake tool card.
  const toolEntry = Object.entries(toolCalls).find(([key, value]) => /ToolCall$/.test(key) && cursorRecord(value));
  if (!toolEntry) return [];
  const [tool, rawCall] = toolEntry;
  const call = cursorRecord(rawCall)!;
  const result = cursorRecord(call.result);
  const failure = result && (Object.hasOwn(result, "error")
    ? result.error
    : Object.hasOwn(result, "failure") ? result.failure : undefined);
  const completed = message.subtype === "completed";
  const error = completed ? cursorToolError(failure) : null;
  const output = completed && result && Object.hasOwn(result, "success")
    ? result.success
    : completed && failure === undefined ? call.result ?? null : null;
  return [{
    method: "item/toolCall/updated",
    kind: "tool_lifecycle",
    payload: {
      callID: `cursor:${exactTurnNamespace}:${message.call_id.trim()}`,
      tool,
      status: error ? "error" : completed ? "completed" : "running",
      input: call.args ?? null,
      output,
      error,
    },
  }];
}

function streamMethod(message: CursorStreamMessage): string {
  const type = typeof message.type === "string" ? message.type : "unknown";
  const subtype = typeof message.subtype === "string" ? message.subtype : null;
  return subtype ? `${type}/${subtype}` : type;
}

function sessionIdOf(message: CursorStreamMessage): string | null {
  if (typeof message.session_id !== "string") return null;
  const sessionId = message.session_id.trim();
  return sessionId
    && sessionId.length <= MAX_CURSOR_SESSION_ID_LENGTH
    && CURSOR_SESSION_ID_PATTERN.test(sessionId)
    ? sessionId
    : null;
}

function requireCursorSessionId(value: string, label: string): string {
  const sessionId = value.trim();
  if (sessionId.length > MAX_CURSOR_SESSION_ID_LENGTH
    || !CURSOR_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`${label} is not a valid Cursor session identity.`);
  }
  return sessionId;
}

function isExactCursorLoopbackTestOrigin(value: string): boolean {
  const match = /^http:\/\/127[.]0[.]0[.]1:([1-9][0-9]{0,4})$/.exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port <= 65_535;
}

let cachedCursorSandboxDelegatingExecutablePaths: string[] | null = null;

function cursorSandboxDeveloperRoots(): string[] {
  if (process.platform !== "darwin") return [];
  const roots: string[] = [];
  try {
    const selected = readlinkSync("/var/db/xcode_select_link");
    roots.push(isAbsolute(selected) ? selected : resolve("/var/db", selected));
  } catch {}
  roots.push(
    "/Library/Developer/CommandLineTools",
    "/Applications/Xcode.app/Contents/Developer",
  );
  return [...new Set(roots)].filter((root) => existsSync(root));
}

function cursorSandboxToolchainBinPaths(): string[] {
  return cursorSandboxDeveloperRoots().flatMap((developerRoot) => [
    join(developerRoot, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin"),
    join(developerRoot, "usr", "bin"),
  ]).filter((directory) => existsSync(directory));
}

function cursorSandboxSdkRoot(): string | null {
  for (const developerRoot of cursorSandboxDeveloperRoots()) {
    for (const sdkRoot of [
      join(developerRoot, "SDKs", "MacOSX.sdk"),
      join(developerRoot, "Platforms", "MacOSX.platform", "Developer", "SDKs", "MacOSX.sdk"),
    ]) {
      if (existsSync(sdkRoot)) return sdkRoot;
    }
  }
  return null;
}

function cursorSandboxPathWithToolchains(pathValue: string, toolchainPaths: readonly string[]): string {
  const entries = pathValue.split(delimiter).filter(Boolean);
  const insertionIndex = entries.indexOf("/usr/bin");
  entries.splice(insertionIndex >= 0 ? insertionIndex : entries.length, 0, ...toolchainPaths);
  return [...new Set(entries)].join(delimiter);
}

function cursorSandboxDelegatingExecutablePaths(): string[] {
  if (cachedCursorSandboxDelegatingExecutablePaths) {
    return [...cachedCursorSandboxDelegatingExecutablePaths];
  }
  const paths = new Set([
    "/bin/launchctl", "/bin/kill",
    "/usr/bin/afplay", "/usr/bin/automator", "/usr/bin/defaults", "/usr/bin/hdiutil", "/usr/bin/killall",
    "/usr/bin/instruments", "/usr/bin/mdfind", "/usr/bin/mdls", "/usr/bin/open", "/usr/bin/osascript",
    "/usr/bin/pbcopy", "/usr/bin/pbpaste", "/usr/bin/qlmanage", "/usr/bin/say",
    "/usr/bin/screencapture", "/usr/bin/security", "/usr/bin/shortcuts", "/usr/bin/xcrun",
    "/usr/sbin/diskutil", "/usr/sbin/networksetup", "/usr/sbin/scutil",
  ]);
  if (process.platform === "darwin") {
    // Resolve selected Developer tool paths without spawning a process on
    // Electron's main thread, then deny effect-delegating binaries directly
    // as well as xcrun above. Repo builds can invoke compilers directly.
    for (const developerRoot of cursorSandboxDeveloperRoots()) {
      for (const relativePath of [
        "usr/bin/simctl",
        "usr/bin/devicectl",
        "usr/bin/xctrace",
        "usr/bin/xcdevice",
        "usr/bin/notarytool",
        "usr/bin/altool",
        "usr/bin/stapler",
      ]) {
        const executable = join(developerRoot, relativePath);
        if (!existsSync(executable)) continue;
        paths.add(executable);
        try { paths.add(realpathSync(executable)); } catch {}
      }
    }
  }
  cachedCursorSandboxDelegatingExecutablePaths = [...paths];
  return [...cachedCursorSandboxDelegatingExecutablePaths];
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
const [bin, statePath, workspaceGenerationManifestPath, deniedReadPathsJson, deniedReadSubpathsJson, deniedReadMetadataPathsJson, deniedReadWriteRegexesJson, deniedWriteRegexesJson, deniedWritePathsJson, deniedWriteStructuralPathsJson, deniedWriteSubpathsJson, deniedExecSubpathsJson, allowedWriteSubpathsJson, allowedReadSubpathsJson, allowedNetworkUnixSocketsJson, mcpConnectorSocketPath, mcpRuntimeEntryPath, mcpRuntimeCwd, testStartupBarrierPath, testStartupBarrierStage, mcpCapabilityTimeoutMsValue, restrictRemoteAuthorityValue, ...args] = process.argv.slice(1);
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
    const server = net.createServer({ allowHalfOpen: false }, (socket) => {
      if (finalizing || authorityRetiring || mcpConnectorAdmitted) { socket.destroy(); return; }
      mcpConnectorAdmitted = true;
      mcpConnectorSocket = socket;
      // Cursor initializes MCP before it can execute model-directed code. One
      // accepted stdio connection prevents a later native/escaped process from
      // replaying this otherwise-readable connector path.
      server.close();
      const runtime = spawn(process.execPath, [mcpRuntimeEntryPath], {
        cwd: mcpRuntimeCwd,
        env: mcpRuntimeEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      mcpRuntime = runtime;
      mcpRuntimeProcessIdentity = exactProcessGroupLeaderIdentity(runtime.pid, process.pid);
      if (process.platform !== "win32" && typeof mcpRuntimeProcessIdentity !== "string") {
        failMcpCapabilityAttestation("Cursor's hosted MCP runtime did not expose an exact process-group birth identity.");
        try { runtime.kill("SIGTERM"); } catch {}
        return;
      }
      const listedRequestIds = new Set();
      let clientInspectionBuffer = Buffer.alloc(0);
      let runtimeInspectionBuffer = Buffer.alloc(0);
      let inspectionBytes = 0;
      let inspectionFrames = 0;
      const maxInspectionBytes = 1024 * 1024;
      const maxInspectionFrames = 256;
      const maxOutstandingListRequests = 32;
      const accountInspectionChunk = (chunk) => {
        inspectionBytes += chunk.length;
        if (inspectionBytes <= maxInspectionBytes) return true;
        failMcpCapabilityAttestation("Cursor's live MCP capability-attestation exchange exceeded its lifetime byte limit.");
        return false;
      };
      const accountInspectionFrame = () => {
        inspectionFrames += 1;
        if (inspectionFrames <= maxInspectionFrames) return true;
        failMcpCapabilityAttestation("Cursor's live MCP capability-attestation exchange exceeded its lifetime frame limit.");
        return false;
      };
      const requestIdKey = (value) => {
        if (typeof value === "string") return "s:" + value;
        if (typeof value === "number" && Number.isFinite(value)) return "n:" + String(value);
        return null;
      };
      const hasRequiredCompletionContract = (response) => {
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
      };
      socket.on("data", (chunk) => {
        if (mcpCapabilityAttested || finalizing || authorityRetiring) return;
        if (!accountInspectionChunk(chunk)) return;
        clientInspectionBuffer = Buffer.concat([clientInspectionBuffer, chunk]);
        if (clientInspectionBuffer.length > maxInspectionBytes) {
          failMcpCapabilityAttestation("Cursor's live MCP client exceeded the bounded capability-attestation exchange.");
          return;
        }
        for (;;) {
          const newline = clientInspectionBuffer.indexOf(10);
          if (newline < 0) break;
          if (!accountInspectionFrame()) return;
          const line = clientInspectionBuffer.subarray(0, newline).toString("utf8").trim();
          clientInspectionBuffer = clientInspectionBuffer.subarray(newline + 1);
          if (!line) continue;
          let request;
          try { request = JSON.parse(line); }
          catch {
            failMcpCapabilityAttestation("Cursor's live MCP client emitted invalid capability-attestation protocol.");
            return;
          }
          if (request && request.method === "tools/list") {
            const key = requestIdKey(request.id);
            if (!key) {
              failMcpCapabilityAttestation("Cursor's live MCP client did not issue an attributable tools/list request.");
              return;
            }
            listedRequestIds.add(key);
            if (listedRequestIds.size > maxOutstandingListRequests) {
              failMcpCapabilityAttestation("Cursor's live MCP client exceeded the bounded outstanding tools/list requests.");
              return;
            }
          }
        }
      });
      socket.pipe(runtime.stdin);
      const inspectRuntimeCapability = (chunk) => {
        if (finalizing || authorityRetiring) return;
        if (!accountInspectionChunk(chunk)) return;
        runtimeInspectionBuffer = Buffer.concat([runtimeInspectionBuffer, chunk]);
        if (runtimeInspectionBuffer.length > maxInspectionBytes) {
          failMcpCapabilityAttestation("Cursor's live MCP runtime exceeded the bounded capability-attestation exchange.");
          return;
        }
        for (;;) {
          const newline = runtimeInspectionBuffer.indexOf(10);
          if (newline < 0) break;
          if (!accountInspectionFrame()) return;
          const framedLine = runtimeInspectionBuffer.subarray(0, newline + 1);
          const line = runtimeInspectionBuffer.subarray(0, newline).toString("utf8").trim();
          runtimeInspectionBuffer = runtimeInspectionBuffer.subarray(newline + 1);
          if (!line) {
            if (!socket.destroyed) socket.write(framedLine);
            continue;
          }
          let response;
          try { response = JSON.parse(line); }
          catch {
            failMcpCapabilityAttestation("Cursor's live MCP runtime emitted invalid capability-attestation protocol.");
            return;
          }
          const key = requestIdKey(response && response.id);
          if (key && listedRequestIds.has(key)) {
            listedRequestIds.delete(key);
            if (!hasRequiredCompletionContract(response)) {
              failMcpCapabilityAttestation("Cursor's live MCP runtime does not expose the required complete_room_turn contract.");
              return;
            }
            mcpCapabilityAttested = true;
            if (mcpCapabilityDeadline) clearTimeout(mcpCapabilityDeadline);
            mcpCapabilityDeadline = null;
            // Release every request held for attestation: now admissible.
            settleMcpCapabilityWaiters(true);
          }
          if (!socket.destroyed) socket.write(framedLine);
          if (mcpCapabilityAttested && runtimeInspectionBuffer.length > 0) {
            if (!socket.destroyed) socket.write(runtimeInspectionBuffer);
            runtimeInspectionBuffer = Buffer.alloc(0);
            break;
          }
        }
        if (mcpCapabilityAttested && !socket.destroyed) {
          // The bounded inspection phase has flushed every byte in original
          // order. Restore Node's native pipe backpressure for the unbounded
          // lifetime of normal tool traffic.
          runtime.stdout.removeListener("data", inspectRuntimeCapability);
          runtime.stdout.pipe(socket);
        }
      };
      runtime.stdout.on("data", inspectRuntimeCapability);
      forwardBoundedStderr(runtime.stderr, "Cursor's hosted MCP runtime");
      socket.once("error", () => {
        failMcpCapabilityAttestation("Cursor's live MCP connector failed before the turn became terminal.");
        try { runtime.kill("SIGTERM"); } catch {}
      });
      socket.once("close", () => {
        failMcpCapabilityAttestation("Cursor's live MCP connector ended before the turn became terminal.");
        try { runtime.stdin.end(); } catch {}
      });
      runtime.once("error", () => {
        failMcpCapabilityAttestation("Cursor's live MCP runtime failed before the turn became terminal.");
        socket.destroy();
      });
      runtime.once("close", () => {
        failMcpCapabilityAttestation("Cursor's live MCP runtime ended before the turn became terminal.");
        socket.destroy();
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
        failMcpCapabilityAttestation("Cursor's live MCP runtime did not attest complete_room_turn before model authority.");
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
          "(deny network-inbound)",
          "(deny network-outbound (require-not (require-any "
            + "(remote ip \"localhost:" + authorityProxyPort + "\") "
            + "(remote ip \"localhost:" + agentProxyPort + "\") "
            + allowedNetworkUnixSockets.map((path) =>
              "(remote unix-socket (literal " + JSON.stringify(path) + "))"
            ).join(" ")
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

function validateCursorSandboxPaths(paths: string[] | undefined): string[] {
  if (!paths) return [];
  if (paths.length > 512) throw new Error("Cursor native sandbox has too many authority paths.");
  return [...new Set(paths.map((path) => {
    if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > 4_096) {
      throw new Error("Cursor native sandbox authority paths must be bounded and absolute.");
    }
    return path;
  }))];
}

function cursorSandboxRuntimeReadSubpaths(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const resolveExecutable = (entry: string): { logical: string; canonical: string }[] => {
    const candidates = isAbsolute(entry) || entry.includes("/")
      ? [resolve(cwd, entry)]
      : (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => resolve(directory, entry));
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        return [{ logical: candidate, canonical: realpathSync(candidate) }];
      } catch {
        // Continue to another exact PATH candidate without invoking a shell.
      }
    }
    return [];
  };
  const appRoot = (executable: string): string | null => {
    let current = dirname(executable);
    for (;;) {
      if (current.endsWith(".app")) return current;
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  };
  const commandExecutables = resolveExecutable(command);
  const hostExecutables = resolveExecutable(process.execPath);
  const commandRuntimeRoots = commandExecutables.flatMap(({ canonical }) => {
    const applicationRoot = appRoot(canonical);
    if (applicationRoot) return [applicationRoot];
    const cursorInstall = /^(.*\/[.]local\/share\/cursor-agent\/versions\/[^/]+)\/cursor-agent$/.exec(canonical);
    return cursorInstall ? [cursorInstall[1]] : [];
  });
  const hostAppRoots = hostExecutables.flatMap(({ canonical }) => {
    const root = appRoot(canonical);
    return root ? [root] : [];
  });
  const pathDirectories = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => resolve(cwd, directory))
    .flatMap((logical) => {
      if (!existsSync(logical)) return [];
      try { return [{ logical, canonical: realpathSync(logical) }]; }
      catch { return []; }
    });
  let canonicalHostHome = resolve(homedir());
  try { canonicalHostHome = realpathSync(canonicalHostHome); } catch {}
  const isSameOrAncestor = (root: string, candidate: string): boolean => {
    const suffix = relative(root, candidate);
    return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
  };
  const toolchainRoots = pathDirectories.flatMap(({ logical, canonical }) => {
    const roots: string[] = [];
    const executableDirectoryName = /^(?:bin|sbin|shims|[A-Za-z0-9._-]+[-_.]bin)$/i;
    if (executableDirectoryName.test(basename(logical))
      && executableDirectoryName.test(basename(canonical))
      && canonical !== "/"
      && !isSameOrAncestor(canonical, canonicalHostHome)) {
      // A PATH directory is an executable capability, but only conventional,
      // narrow bin/shim directories are readable. Resolve the pair together:
      // a harmless-looking alias must not smuggle HOME, one of its private
      // child directories, or / into the fence.
      roots.push(logical, canonical);
    }
    const versionedBinPatterns = [
      /^(.*\/[.]nvm\/versions\/node\/[^/]+)\/bin$/,
      /^(.*\/[.]fnm\/node-versions\/[^/]+\/installation)\/bin$/,
      /^(.*\/[.]pyenv\/versions\/[^/]+)\/bin$/,
      /^(.*\/[.]rustup\/toolchains\/[^/]+)\/bin$/,
      /^(\/Library\/Frameworks\/[^/]+[.]framework\/Versions\/[^/]+)\/bin$/,
      /^(.*\/Library\/Android\/sdk)\/(?:emulator|platform-tools|cmdline-tools\/[^/]+\/bin)$/,
      /^(.*\/[.]cache\/codex-runtimes\/[^/]+\/dependencies)\/bin(?:\/[^/]+)?$/,
    ];
    for (const pattern of versionedBinPatterns) {
      const match = pattern.exec(canonical);
      if (match) roots.push(match[1]);
    }
    if ([logical, canonical].some((directory) =>
      directory === "/opt/homebrew/bin" || directory === "/opt/homebrew/sbin")) {
      // Homebrew's public bin directories are symlink farms. The executable,
      // its libexec helpers, and its linked libraries live under these
      // package-only roots; user data and Homebrew service config stay out.
      roots.push(
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/opt/homebrew/Cellar",
        "/opt/homebrew/opt",
        "/opt/homebrew/lib",
        "/opt/homebrew/share",
        "/opt/homebrew/etc/gitconfig",
      );
    }
    if ([logical, canonical].some((directory) =>
      directory === "/usr/local/bin" || directory === "/usr/local/sbin")) {
      // Intel Homebrew and the official Node installer both expose launchers
      // here while keeping their runtime modules below narrower descendants.
      // Do not admit /usr/local itself: it may contain unrelated user data.
      roots.push(
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/local/Cellar",
        "/usr/local/opt",
        "/usr/local/lib",
        "/usr/local/share",
        "/usr/local/etc/gitconfig",
      );
    }
    return roots;
  });
  return [...new Set([
    // The logical launcher may sit beside unrelated user scripts (commonly
    // ~/.local/bin), so admit that symlink/file exactly. Cursor's canonical
    // installation directory is a real multi-file runtime and remains the
    // smallest viable subtree. The host Node/Electron binary is exact unless
    // it belongs to an application bundle.
    ...commandExecutables.flatMap(({ logical, canonical }) => [logical, canonical]),
    ...hostExecutables.flatMap(({ logical, canonical }) => [logical, canonical]),
    ...commandRuntimeRoots,
    ...hostAppRoots,
    // PATH selects inherited developer tools, but an arbitrary PATH directory
    // is not itself read authority: it might be /, HOME, or a symlink to
    // either. Admit only narrowly recognized installation roots so npm, git,
    // package-managed and versioned tools can load their helpers without
    // making the rest of the user's home directory readable.
    ...toolchainRoots,
    "/System",
    "/Library/Apple",
    // Compiler drivers and their SDK/linker support are read-only toolchains;
    // their children inherit this same repo-write/network/process boundary.
    "/Library/Developer/CommandLineTools",
    "/Applications/Xcode.app",
    "/bin",
    "/sbin",
    "/usr/bin",
    "/usr/lib",
    "/usr/libexec",
    "/usr/sbin",
    "/usr/share",
    "/private/etc/hosts",
    "/private/etc/localtime",
    "/private/etc/nsswitch.conf",
    "/private/etc/paths",
    "/private/etc/paths.d",
    "/private/etc/resolv.conf",
    "/private/etc/ssl",
    "/private/var/db/timezone",
    "/private/var/run/resolv.conf",
    // Device nodes remain kernel-permission constrained; Node/Cursor require
    // random/null/stdio devices during startup and child execution.
    "/dev",
  ].filter(existsSync).map((path) => realpathSync(path)))];
}

function cursorSandboxPathVariants(path: string): string[] {
  const logical = resolve(path);
  let canonical = logical;
  try {
    canonical = realpathSync(logical);
  } catch {
    try { canonical = join(realpathSync(dirname(logical)), basename(logical)); }
    catch { /* Validation below still rejects malformed/non-absolute input. */ }
  }
  const aliases = [logical, canonical].flatMap((candidate) => {
    if (candidate === "/tmp" || candidate.startsWith("/tmp/")
      || candidate === "/var" || candidate.startsWith("/var/")
      || candidate === "/etc" || candidate.startsWith("/etc/")) {
      return [candidate, `/private${candidate}`];
    }
    if (candidate === "/private/tmp" || candidate.startsWith("/private/tmp/")
      || candidate === "/private/var" || candidate.startsWith("/private/var/")
      || candidate === "/private/etc" || candidate.startsWith("/private/etc/")) {
      return [candidate, candidate.slice("/private".length)];
    }
    return [candidate];
  });
  return [...new Set(aliases)];
}

const CURSOR_TURN_RUNTIME_DATA_PATTERN = /^\/(?:private\/)?tmp\/letagents-cursor-data-[A-Za-z0-9]{6}$/;

function prepareCursorTurnRuntimeDataDir(): string {
  const root = mkdtempSync(join(realpathSync("/tmp"), "letagents-cursor-data-"));
  chmodSync(root, 0o700);
  if (!CURSOR_TURN_RUNTIME_DATA_PATTERN.test(root)) {
    throw new Error("Cursor's private turn data root has an unexpected identity.");
  }
  return root;
}

function removeCursorTurnRuntimeDataDir(root: string): void {
  if (!CURSOR_TURN_RUNTIME_DATA_PATTERN.test(root)) {
    throw new Error("Refusing to remove an unexpected Cursor turn data root.");
  }
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Refusing to remove a redirected Cursor turn data root.");
    }
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function escapeCursorSandboxRegex(path: string): string {
  if (/[\x00-\x1f\x7f[\]\\^]/.test(path)) {
    throw new Error("Cursor sandbox regex paths contain unsupported characters.");
  }
  return [...path].map((character) => /[A-Za-z0-9/_-]/.test(character)
    ? character
    : `[${character}]`).join("");
}

function validateCursorSandboxRegexes(patterns: string[] | undefined): string[] {
  if (!patterns) return [];
  if (patterns.length > 64) throw new Error("Cursor native sandbox has too many authority patterns.");
  return [...new Set(patterns.map((pattern) => {
    if (!pattern.startsWith("^")
      || !pattern.endsWith("$")
      || pattern.includes("\0")
      || Buffer.byteLength(pattern, "utf8") > 4_096) {
      throw new Error("Cursor native sandbox authority patterns must be bounded and anchored.");
    }
    try {
      new RegExp(pattern);
    } catch {
      throw new Error("Cursor native sandbox authority pattern is invalid.");
    }
    return pattern;
  }))];
}

export async function assertCursorPersonalIdentity(input: {
  cursorBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  writableProfileRoot: string;
  requiredReadableRoots?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CursorPersonalIdentity> {
  const proxy = await startCursorIdentityProxy(input.signal);
  try {
    const result = await runCursorSandboxedInspection({
      cursorBin: input.cursorBin,
      commandArgs: [
        "--endpoint", proxy.endpoint,
        "--http-version", "1.1",
        "--disable-auto-update",
        "status", "--format", "json",
      ],
      cwd: input.cwd,
      env: input.env,
      writableProfileRoot: input.writableProfileRoot,
      requiredReadableRoots: input.requiredReadableRoots,
      allowedNetworkRemotes: [proxy.remote],
      timeoutMs: input.timeoutMs ?? CURSOR_IDENTITY_ATTESTATION_TIMEOUT_MS,
      signal: input.signal,
    });
    if (!result.ok) {
      const detail = result.stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
        || result.errorCode
        || "native status failed";
      throw new Error(`Cursor live identity attestation failed: ${detail}`);
    }
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const userInfo = parsed.userInfo;
    if (parsed.status === "unauthenticated" || parsed.isAuthenticated === false) {
      throw new CursorIdentityAuthRequiredError();
    }
    if (parsed.status !== "authenticated"
      || parsed.isAuthenticated !== true
      || !userInfo
      || typeof userInfo !== "object"
      || Array.isArray(userInfo)
      || typeof (userInfo as Record<string, unknown>).userId !== "number"
      || !Number.isSafeInteger((userInfo as Record<string, unknown>).userId)
      || ((userInfo as Record<string, unknown>).userId as number) <= 0) {
      throw new Error("Cursor could not prove the live account identity.");
    }
    if (Object.prototype.hasOwnProperty.call(userInfo, "teamId")
      && (userInfo as Record<string, unknown>).teamId !== null
      && (userInfo as Record<string, unknown>).teamId !== undefined) {
      throw new CursorTeamManagedIdentityError();
    }
    proxy.assertGetMeCompleted();
    const providerAuthorization = proxy.providerAuthorization();
    const userId = (userInfo as Record<string, unknown>).userId as number;
    const emailValue = (userInfo as Record<string, unknown>).email;
    return {
      userId,
      email: typeof emailValue === "string" && emailValue.trim()
        ? emailValue.trim()
        : null,
      providerAuthorization,
    };
  } finally {
    await proxy.close();
  }
}

function startCursorIdentityProxy(signal?: AbortSignal): Promise<{
  endpoint: string;
  remote: string;
  assertGetMeCompleted(): void;
  providerAuthorization(): string;
  close(): Promise<void>;
}> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Cursor live identity attestation was interrupted."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let getMeRequests = 0;
    let getMeSuccesses = 0;
    let providerAuthorization: string | null = null;
    const server: HttpServer = createServer((request, response) => {
      const requestPath = typeof request.url === "string" ? request.url : "";
      if (request.method !== "POST"
        || requestPath !== "/aiserver.v1.DashboardService/GetMe") {
        request.resume();
        response.writeHead(503, { connection: "close", "cache-control": "no-store" });
        response.end("Cursor identity attestation permits only GetMe.");
        return;
      }
      getMeRequests += 1;
      const requestAuthorization = request.headers.authorization;
      if (typeof requestAuthorization !== "string"
        || !/^Bearer [^\s\0]{1,16384}$/.test(requestAuthorization)
        || (providerAuthorization !== null && providerAuthorization !== requestAuthorization)) {
        request.resume();
        response.writeHead(503, { connection: "close", "cache-control": "no-store" });
        response.end("Cursor identity authorization was rejected.");
        return;
      }
      providerAuthorization = requestAuthorization;
      const contentLengthHeader = request.headers["content-length"];
      const contentLength = typeof contentLengthHeader === "string" && /^\d{1,7}$/.test(contentLengthHeader)
        ? Number(contentLengthHeader)
        : -1;
      if (request.headers["transfer-encoding"] !== undefined
        || !Number.isSafeInteger(contentLength)
        || contentLength < 0
        || contentLength > 1024 * 1024) {
        request.resume();
        response.writeHead(503, { connection: "close", "cache-control": "no-store" });
        response.end("Cursor identity request framing was rejected.");
        return;
      }
      const headers: Record<string, string | string[] | undefined> = {
        ...request.headers,
        host: "api2.cursor.sh",
      };
      delete headers.connection;
      delete headers["proxy-connection"];
      delete headers.upgrade;
      delete headers["keep-alive"];
      delete headers["transfer-encoding"];
      const upstream = httpsRequest({
        protocol: "https:",
        hostname: "api2.cursor.sh",
        port: 443,
        method: "POST",
        path: requestPath,
        headers,
        servername: "api2.cursor.sh",
        timeout: 15_000,
      }, (upstreamResponse) => {
        const responseHeaders: Record<string, string | string[] | undefined> = {
          ...upstreamResponse.headers,
        };
        delete responseHeaders.connection;
        delete responseHeaders["proxy-connection"];
        delete responseHeaders.upgrade;
        delete responseHeaders["keep-alive"];
        response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        let responseBytes = 0;
        upstreamResponse.on("data", (chunk: Buffer) => {
          responseBytes += chunk.length;
          if (responseBytes > 1024 * 1024) {
            upstreamResponse.destroy();
            response.destroy();
          }
        });
        upstreamResponse.once("end", () => {
          if (responseBytes <= 1024 * 1024
            && (upstreamResponse.statusCode ?? 0) >= 200
            && (upstreamResponse.statusCode ?? 0) < 300) {
            getMeSuccesses += 1;
          }
        });
        upstreamResponse.once("error", () => response.destroy());
        upstreamResponse.pipe(response);
      });
      upstream.once("timeout", () => upstream.destroy(new Error("Cursor GetMe timed out.")));
      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(502, { connection: "close" });
        response.end();
      });
      request.once("aborted", () => upstream.destroy());
      let receivedBytes = 0;
      let overflow = false;
      request.on("data", (chunk: Buffer) => {
        if (overflow) return;
        receivedBytes += chunk.length;
        if (receivedBytes > 1024 * 1024) {
          overflow = true;
          upstream.destroy();
          if (!response.headersSent) response.writeHead(413, { connection: "close" });
          response.end();
          request.resume();
          return;
        }
        if (!upstream.write(chunk)) {
          request.pause();
          upstream.once("drain", () => request.resume());
        }
      });
      request.once("end", () => { if (!overflow) upstream.end(); });
      request.once("error", () => upstream.destroy());
    });
    server.maxHeadersCount = 64;
    server.headersTimeout = 5_000;
    server.requestTimeout = 20_000;
    server.keepAliveTimeout = 1_000;
    const abort = (): void => {
      server.close();
      if (!settled) {
        settled = true;
        reject(new Error("Cursor live identity attestation was interrupted."));
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    server.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      if (settled) return;
      const address = server.address();
      if (!address || typeof address === "string") {
        settled = true;
        signal?.removeEventListener("abort", abort);
        server.close();
        reject(new Error("Cursor identity proxy did not expose a loopback port."));
        return;
      }
      settled = true;
      resolve({
        endpoint: `http://127.0.0.1:${address.port}`,
        remote: `localhost:${address.port}`,
        assertGetMeCompleted() {
          if (getMeRequests !== 1 || getMeSuccesses !== 1 || providerAuthorization === null) {
            throw new Error("Cursor did not complete exactly one live GetMe identity proof.");
          }
        },
        providerAuthorization() {
          if (providerAuthorization === null) {
            throw new Error("Cursor did not provide a live authorization proof.");
          }
          return providerAuthorization;
        },
        close: () => new Promise<void>((resolveClose) => {
          signal?.removeEventListener("abort", abort);
          server.closeAllConnections?.();
          server.close(() => resolveClose());
        }),
      });
    });
  });
}

const DEFAULT_DEPENDENCIES: CursorProviderAdapterDependencies = {
  launchTurn: defaultLaunchTurn,
  attestSupervisedMcp: assertCursorSupervisedMcpAuthority,
  attestPersonalIdentity: assertCursorPersonalIdentity,
  bindPersonalIdentity: bindCursorSupervisedIdentity,
  signalProcess: defaultSignalProcess,
  getProcessIdentity: defaultGetProcessIdentity,
  prepareTurnState: (path) => writeFileSync(path, "", { flag: "wx", mode: 0o600 }),
  createWorkspaceGeneration: createSupervisedWorkspaceGeneration,
  recoverWorkspaceGeneration: recoverSupervisedWorkspaceGeneration,
  removeWorkspaceGenerationReceipt: removeSupervisedWorkspaceGenerationReceipt,
  now: () => new Date().toISOString(),
};

interface LiveTurn {
  child: CursorCliChild;
  pid: number;
  processIdentity: string;
  sawInit: boolean;
  sawResult: boolean;
  resultWasError: boolean;
  resultText: string | null;
  providerRequestId: string | null;
  interruptRequested: boolean;
  /** Supervisor-minted identity embedded in the prompt and durable inbox. */
  roomTurnId: string | null;
  /** Exact control identity even for predecessor legacy turns with no inbox id. */
  controlTurnId: string;
  statePath: string | null;
  /** Writable turns own one private generation until its immutable tree is reconciled. */
  workspaceGeneration: SupervisedWorkspaceGenerationHandle | null;
  workspaceGenerationManifestPath: string | null;
  liveDisplayTools: Map<string, { tool: string; input: unknown }>;
  completion?: Promise<CursorTurnTerminal>;
}

type CursorTurnTerminal = {
  state: "result" | "interrupted" | "attempt_terminal";
  exit: ProviderProcessExit;
  text: string | null;
  isError: boolean;
  providerRequestId: string | null;
  attemptTerminal: ProviderTerminalPayload | null;
  publicationContract: "structured_room_turn_v1" | "legacy_cursor_aggregate_v0";
  /** Safely redacted detail from the trusted private wrapper terminal. */
  terminalError?: string;
  /** Exact init identity retained when a live post-init checkpoint fails. */
  providerContinuationId?: string;
  /** Trusted wrapper link to the exact private filesystem authority journal. */
  workspaceGenerationManifestPath?: string;
};

function safeCursorTerminalErrorDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = redactCredentialText(value).value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, MAX_CURSOR_TERMINAL_ERROR_DETAIL_LENGTH);
}

class CursorRoomTurnRecoveryError extends Error {
  readonly roomTurnRecoveryOutcome = "ambiguous" as const;
}

class CursorRoomTurnNotDispatchedError extends Error {
  readonly roomTurnRecoveryOutcome = "not_dispatched" as const;
  constructor(message: string, readonly providerTurnId: string | null = null) {
    super(message);
  }
}

class CursorPostDispatchCheckpointError extends Error {}

class CursorRoomTurnObservationDetachedError extends Error {}

class CursorRoomTurnTerminalError extends Error {
  readonly roomTurnRecoveryOutcome = "terminal_failure" as const;
}

class CursorRecordedTurnInProgressError extends Error {
  readonly providerAttachOutcome = "in_progress" as const;
}

/** Read one exact inode with O_NOFOLLOW and a preallocated size bound. */
function readBoundedCursorTurnFile(path: string, maxBytes: number, label: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CursorRoomTurnRecoveryError(`${label} could not be opened safely.`);
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) {
      throw new CursorRoomTurnRecoveryError(`${label} is not a bounded regular file.`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const after = fstatSync(fd);
    if (offset !== before.size || after.size !== before.size
      || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs) {
      throw new CursorRoomTurnRecoveryError(`${label} changed while it was being read.`);
    }
    return bytes.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// The empirically proven usage-limit signature (task_38 spike, msg_1708):
// init observed, the stream stops with NO result event, the process exits
// non-zero with no signal, and stderr carries the ActionRequiredError. This is
// an account/configuration condition, not a crash — the reconciler must not
// quarantine it and the UI can name the actual remedy.
const PROVIDER_QUOTA_STDERR = /ActionRequiredError[\s\S]*usage limit/i;

function isProviderQuotaExit(turn: LiveTurn, exit: ProviderProcessExit): boolean {
  return exit.type === "exit"
    && exit.signal === null
    && exit.code !== null
    && exit.code !== 0
    && turn.sawInit
    && !turn.sawResult
    && PROVIDER_QUOTA_STDERR.test(turn.child.stderrTail());
}

class CursorProviderHandle implements ProviderHandle {
  state: ProviderObservedState = "starting";
  stopRequested = false;
  protocolError = false;
  terminal: ProviderTerminalPayload | null = null;
  providerContinuationId: string | null = null;
  liveTurn: LiveTurn | null = null;
  activeRoomTurnId: string | null = null;
  roomTurnOperationId: string | null = null;
  roomTurnAbortController: AbortController | null = null;
  roomTurnOperationSettled: Promise<void> | null = null;
  readonly roomTurnResults = new Map<string, CursorTurnTerminal>();
  readonly exitListeners = new Set<(payload: ProviderTerminalPayload) => void>();
  readonly activityListeners = new Set<(event: ProviderActivityEvent) => void>();
  readonly streamListeners = new Set<(event: ProviderStreamEvent) => void>();
  streamSequence = 0;

  constructor(
    readonly workAttemptId: string,
    readonly cwd: string,
    readonly policyArgs: string[],
    readonly deliveryMode: "mcp_polling" | "daemon_inbox",
    readonly spawnRequest: ProviderSpawnRequest,
    readonly supervisedProfile: CursorManagedProfile | null,
  ) {}

  /**
   * Honest process claim: a pid exists only while a turn runs. Between turns
   * the lane claims NO process (matrix cell "never a claimed live process").
   */
  get pid(): number | null {
    return this.liveTurn?.pid ?? null;
  }

  get providerConnection(): ProviderConnectionRef {
    return {
      kind: "cursor_cli",
      pid: this.liveTurn?.pid ?? null,
      processIdentity: this.liveTurn?.processIdentity ?? null,
    };
  }

  observedState(): ProviderObservedState {
    return this.state;
  }
}

export class CursorProviderAdapter implements ProviderAdapter {
  readonly id = "cursor" as const;
  private readonly cursorBin: string;
  private readonly deps: CursorProviderAdapterDependencies;
  private readonly activitySink?: (event: ProviderActivityEvent) => void;
  private readonly streamSink?: (event: ProviderStreamEvent) => void;
  private readonly turnStartTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly supervisedProfileFactory: NonNullable<CursorProviderAdapterOptions["supervisedProfileFactory"]>;
  private readonly handles = new Map<string, CursorProviderHandle>();

  constructor(options: CursorProviderAdapterOptions = {}) {
    this.cursorBin = options.cursorBin || process.env.LETAGENTS_CURSOR_AGENT_BIN || "cursor-agent";
    this.deps = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
    this.activitySink = options.activitySink;
    this.streamSink = options.streamSink;
    this.turnStartTimeoutMs = options.turnStartTimeoutMs ?? TURN_START_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.supervisedProfileFactory = options.supervisedProfileFactory
      ?? ((input) => prepareCursorSupervisedProfile({
        workAttemptId: input.workAttemptId,
        workspaceRoot: input.cwd,
        permissionProfileId: input.permissionProfileId,
        apiBaseUrl: desktopApiUrl,
        profileRoot: input.profileRoot,
        includeAuth: input.includeAuth,
        authSourceHomeDir: input.authSourceHomeDir,
        identityAttestationOnly: input.identityAttestationOnly,
        attestedPersonalIdentity: input.attestedPersonalIdentity,
        exposeLoginCredentials: input.exposeLoginCredentials,
        inspectionOnly: input.inspectionOnly,
        mcpWorkingDirectory: input.mcpWorkingDirectory,
        supervisorMcpEnv: input.supervisorMcpEnv,
        mcpConnectorSocketPath: input.mcpConnectorSocketPath,
        mcpRuntime: input.inspectionOnly ? undefined : resolveLetAgentsMcpRuntime({
          devEntryPath: input.devMcpServerEntryPath,
        }),
      }));
  }

  capabilities(): ProviderAdapterCapabilities {
    return { ...BASE_CURSOR_CAPABILITIES };
  }

  async spawn(req: ProviderSpawnRequest): Promise<ProviderHandle> {
    return this.start(req, null);
  }

  async resume(
    ref: ProviderContinuationRef,
    req: ProviderSpawnRequest,
  ): Promise<ProviderHandle> {
    if (ref.workAttemptId !== req.workAttemptId) {
      throw new Error("Cursor resume ref must belong to the same work attempt.");
    }
    return this.start(req, ref);
  }

  /**
   * Between turns there is genuinely nothing to attach: no process exists and
   * the continuation lives entirely in the session id. During a live turn a
   * fresh adapter cannot reattach stdio. A still-live exact wrapper is reported
   * promptly as in-progress so daemon lifecycle control never queues behind an
   * unbounded attach. It is not treated as absent and no successor is launched.
   */
  async attach(ref: ProviderContinuationRef): Promise<ProviderHandle | null> {
    const handle = this.handles.get(ref.workAttemptId);
    if (handle && !handle.terminal && handle.providerContinuationId === ref.providerContinuationId) {
      return handle;
    }
    if (handle) return null;
    const connection = ref.providerConnection;
    if (!connection || connection.kind !== "cursor_cli") return null;
    if (connection.pid === null) {
      // An idle lane records no process; that absence is exact, not ambiguous.
      return null;
    }

    return this.observeRecordedTurnChild(connection);
  }

  async stopRef(
    ref: ProviderContinuationRef,
    options: ProviderStopOptions = {},
  ): Promise<ProviderTerminalPayload> {
    const connection = ref.providerConnection;
    if (!connection || connection.kind !== "cursor_cli") {
      throw new Error("Cursor exact-reference stop requires a Cursor wrapper reference.");
    }
    if ((connection.pid === null) !== (connection.processIdentity == null)) {
      throw new Error("Cursor exact-reference stop requires a verified wrapper process birth.");
    }
    if (connection.pid !== null && connection.processIdentity) {
      const identity = this.deps.getProcessIdentity(connection.pid);
      if (identity === undefined) {
        throw new Error("Cursor exact-reference stop is ambiguous because process identity cannot be verified.");
      }
      if (identity !== null && sameProcessBirthIdentity(identity, connection.processIdentity)) {
      // The wrapper owns its native process group and performs TERM→KILL
      // escalation internally. Killing the wrapper itself could orphan Cursor.
        this.deps.signalProcess(connection.pid, "SIGTERM");
        const deadline = Date.now() + (options.graceMs ?? this.stopGraceMs);
        for (;;) {
          const current = this.deps.getProcessIdentity(connection.pid);
          if (current === null || (typeof current === "string"
            && !sameProcessBirthIdentity(current, connection.processIdentity))) break;
          if (current === undefined) {
            throw new Error("Cursor exact-reference stop lost process-birth visibility before absence was proved.");
          }
          if (Date.now() >= deadline) {
            throw new Error("Cursor's process-reaping wrapper has not yet proved all recorded turn descendants are gone.");
          }
          await delay(25);
        }
      }
    }
    return synthesizeTerminalPayload({
      endedAt: this.deps.now(),
      exitCode: 0,
      signal: null,
      providerContinuationId: ref.providerContinuationId,
      stopRequested: true,
    });
  }

  /**
   * Boundary delivery, not mid-turn injection: when the lane is idle the next
   * boundary is NOW, so the message runs as a fresh `--resume` turn; while a
   * turn is running there is no channel into the child and this refuses.
   */
  async poke(providerHandle: ProviderHandle, message: string): Promise<void> {
    const handle = this.requireHandle(providerHandle);
    if (handle.deliveryMode === "daemon_inbox") {
      throw new Error("Cursor daemon-inbox delivery is journaled as bounded room turns; poke is unavailable.");
    }
    if (handle.terminal) {
      throw new Error("Cursor lane is terminal; nothing can be delivered.");
    }
    if (handle.liveTurn) {
      throw new Error(
        "Cursor has no channel into a running turn (positional-prompt CLI); deliver at the next boundary.",
      );
    }
    await this.beginTurn(handle, message, handle.providerContinuationId);
  }

  async controlTurn(
    providerHandle: ProviderHandle,
    correction?: string | null,
    options: ProviderTurnControlOptions = {},
  ): Promise<ProviderTurnControlResult> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) throw new Error("Cursor continuation is terminal; no turn can be controlled.");
    const text = correction?.trim() || null;
    if (text && handle.deliveryMode === "daemon_inbox") {
      throw new ProviderTurnControlError(
        "Cursor daemon-inbox turn control can stop the active bounded turn, but cannot start an unjournaled correction turn.",
        "not_applied",
      );
    }
    const expectedTurnId = options.targetTurnId?.trim() || null;
    let turn = handle.liveTurn;
    const pendingController = turn ? null : handle.roomTurnAbortController;
    const currentTurnId = turn?.controlTurnId ?? handle.activeRoomTurnId;
    if (expectedTurnId && currentTurnId && currentTurnId !== expectedTurnId) {
      // The checkpointed wrapper/room turn A ended or was superseded. Never
      // let retry of A acquire signal authority over a later process B.
      if (text) {
        throw new ProviderTurnControlError(
          "Cursor's checkpointed turn ended and a newer turn is active; the correction was not applied to that successor.",
          "not_applied",
        );
      }
      return {
        capability: "restart_resume",
        interrupted: false,
        resumed: false,
        state: turn || pendingController ? "working" : "idle",
      };
    }
    if (turn || pendingController) {
      if (currentTurnId) await options.checkpointTurnStarted?.(currentTurnId);
      await options.markDispatched?.();
      if (!turn && pendingController) {
        turn = handle.liveTurn;
        if (!turn && handle.roomTurnAbortController === pendingController) {
          const settled = handle.roomTurnOperationSettled;
          pendingController.abort();
          await settled;
          return {
            capability: "restart_resume",
            interrupted: true,
            resumed: false,
            state: "idle",
          };
        }
      }
    }
    if (turn) {
      const identity = this.exactProcessStatus(turn.pid, turn.processIdentity);
      if (identity !== "exact") {
        throw new Error("Cursor turn identity is stale; refusing to interrupt a different process.");
      }
      try {
        if (handle.liveTurn !== turn
          || this.signalExactProcess(turn.pid, turn.processIdentity, "SIGTERM") !== "signalled") {
          throw new ProviderTurnControlError(
            "Cursor turn ended before the child interrupt was dispatched.",
            "not_applied",
          );
        }
        turn.interruptRequested = true;
      } catch (error) {
        turn.interruptRequested = false;
        throw error;
      }
      const graceful = await Promise.race([
        turn.child.exited.then(() => true),
        delay(this.stopGraceMs).then(() => false),
      ]);
      if (!graceful && turn.child.ownsDescendantReaping) {
        throw new Error("Cursor's process-reaping wrapper has not yet proved the interrupted turn descendants are gone.");
      }
      if (!graceful) {
        const killed = this.signalExactProcess(turn.pid, turn.processIdentity, "SIGKILL");
        if (killed === "ambiguous") {
          throw new Error("Cursor turn process birth became unverifiable before interrupt escalation.");
        }
      }
      await turn.child.exited;
      if (turn.completion) {
        await turn.completion;
      } else {
        // A supervised Stop can race the atomic prepared checkpoint before
        // beginTurn installs its normal completion observer. Wait for the
        // whole bounded room operation so its reaper and live->idle durable
        // compensation finish before the daemon cancels the FIFO item.
        await handle.roomTurnOperationSettled;
      }
      if (handle.terminal) throw new Error("Cursor turn interruption unexpectedly ended the supervised attempt.");
    }
    if (text) {
      if (!turn) await options.markDispatched?.();
      await this.beginTurn(handle, text, handle.providerContinuationId);
    }
    return {
      capability: "restart_resume",
      interrupted: Boolean(turn),
      resumed: Boolean(text),
      state: text ? "working" : "idle",
    };
  }

  async runRoomTurn(
    providerHandle: ProviderHandle,
    request: ProviderRoomTurnRequest,
    options: ProviderRoomTurnOptions = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.requireHandle(providerHandle);
    if (handle.deliveryMode !== "daemon_inbox") {
      throw new Error("Cursor bounded room turns require daemon_inbox delivery.");
    }
    if (handle.terminal) throw new Error("Cursor continuation is terminal; no bounded room turn can run.");
    if (handle.state === "failed") throw new Error("Cursor continuation has failed; no bounded room turn can run.");
    if (handle.liveTurn || handle.roomTurnOperationId || handle.activeRoomTurnId) {
      throw new Error("Cursor continuation already has a bounded room turn in progress.");
    }
    if (!request.inboxItemId.trim() || !request.actionId.trim()) {
      throw new Error("Bounded Cursor room turn requires durable inbox and action ids.");
    }

    const turnId = `cursor:${randomUUID()}`;
    const turnAbortController = new AbortController();
    let settleRoomTurnOperation!: () => void;
    handle.roomTurnOperationId = turnId;
    handle.roomTurnAbortController = turnAbortController;
    handle.roomTurnOperationSettled = new Promise((resolve) => {
      settleRoomTurnOperation = resolve;
    });
    const detachDuringPreparation = () => turnAbortController.abort();
    const detachSignal = options.detachSignal;
    if (detachSignal?.aborted) detachDuringPreparation();
    else detachSignal?.addEventListener("abort", detachDuringPreparation, { once: true });
    const unlinkPreparationDetach = () => {
      detachSignal?.removeEventListener("abort", detachDuringPreparation);
    };
    const markDurableTurnStarted = () => {
      options.markDurableTurnStarted?.();
      unlinkPreparationDetach();
    };
    try {
      await (options.beforeNativeDispatch ?? options.markDispatched)?.();
      handle.activeRoomTurnId = turnId;
      let turn: LiveTurn;
      try {
        turn = await this.beginTurn(
          handle,
          boundedCursorRoomTurnPrompt(request, turnId, handle.spawnRequest.permissionProfileId),
          handle.providerContinuationId,
          turnId,
          options.checkpointProviderState,
          options.checkpointTurnStarted,
          options.checkpointPreparedTurn,
          turnAbortController.signal,
          markDurableTurnStarted,
        );
      } catch (error) {
        if (!(error instanceof CursorPostDispatchCheckpointError)) throw error;
        // This exact wrapper crossed the durable turn boundary. Handoff now
        // detaches observation instead of cancelling preparation.
        unlinkPreparationDetach();
        // Native work may have completed while its real session checkpoint
        // failed. Re-read only this exact wrapper terminal; never redispatch.
        return this.recoverRoomTurn(handle, {
          inboxItemId: request.inboxItemId,
          providerTurnId: turnId,
        }, {
          detachSignal: options.detachSignal,
          checkpointProviderState: options.checkpointProviderState,
          checkpointTerminalResult: options.checkpointTerminalResult,
        });
      }
      const terminal = await this.awaitRoomTurnTerminal(turn.completion!, options.detachSignal);
      await options.checkpointProviderState?.({
        providerContinuationId: handle.providerContinuationId!,
        providerConnection: handle.providerConnection,
      });
      const result = this.providerRoomTurnResult(turnId, terminal);
      const disposition = await options.checkpointTerminalResult?.(result);
      const acceptedResult = disposition?.acceptedResult ?? result;
      const cleanupRecoveryEvidence = options.checkpointTerminalResult
        ? disposition === undefined
          ? result.outcome !== "unreadable"
          : disposition.cleanupRecoveryEvidence
        : false;
      if (cleanupRecoveryEvidence) {
        if (turn.workspaceGenerationManifestPath) {
          await this.deps.removeWorkspaceGenerationReceipt(turn.workspaceGenerationManifestPath);
        }
        // The turn journal is the only restart-readable terminal evidence.
        // Retire it last, after every fallible generation cleanup succeeds.
        this.removeDurableTurnJournal(handle, turnId);
      }
      // Cursor has no exact-turn read API. Keep unreadable terminal evidence
      // until the daemon performs its one result-recovery pass; replies and
      // explicit no-replies are already durably normalized and can be dropped.
      if (cleanupRecoveryEvidence || (!options.checkpointTerminalResult && result.outcome !== "unreadable")) {
        handle.roomTurnResults.delete(turnId);
      }
      return acceptedResult;
    } finally {
      unlinkPreparationDetach();
      settleRoomTurnOperation();
      if (handle.roomTurnAbortController === turnAbortController) {
        handle.roomTurnAbortController = null;
        handle.roomTurnOperationSettled = null;
      }
      if (handle.roomTurnOperationId === turnId) handle.roomTurnOperationId = null;
      if (handle.activeRoomTurnId === turnId && handle.roomTurnResults.has(turnId)) {
        handle.activeRoomTurnId = null;
      } else if (handle.activeRoomTurnId === turnId && !handle.liveTurn) {
        // Launch/init failed before a recoverable exact turn existed.
        handle.activeRoomTurnId = null;
      }
    }
  }

  async recoverRoomTurn(
    providerHandle: ProviderHandle,
    request: ProviderRoomTurnRecoveryRequest,
    options: {
      detachSignal?: AbortSignal;
      checkpointProviderState?: ProviderRoomTurnOptions["checkpointProviderState"];
      checkpointTerminalResult?: ProviderRoomTurnOptions["checkpointTerminalResult"];
    } = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.requireHandle(providerHandle);
    const turnId = request.providerTurnId.trim();
    if (!turnId) {
      throw new CursorRoomTurnRecoveryError("Cursor room-turn recovery requires an exact persisted turn id.");
    }
    let terminal: CursorTurnTerminal | null;
    try {
      // The wrapper journal keeps consuming native stdout during a TERM fence,
      // after live listeners have detached. Prefer that exact durable terminal
      // over an earlier in-memory teardown snapshot so a late successful result
      // cannot be hidden until the next daemon restart.
      terminal = this.readDurableTurnTerminal(handle, turnId) ?? handle.roomTurnResults.get(turnId) ?? null;
    } catch (error) {
      throw error;
    }
    if (!terminal && handle.liveTurn?.roomTurnId === turnId && handle.liveTurn.completion) {
      terminal = await this.awaitRoomTurnTerminal(handle.liveTurn.completion, options.detachSignal);
    }
    if (!terminal) {
      // Cursor's CLI exposes no exact-turn read endpoint. A successor may
      // resume the continuation, but it must never rerun an ambiguous inbox
      // item after losing the original per-turn stream.
      throw new CursorRoomTurnRecoveryError(
        "Cursor room-turn recovery cannot prove the persisted exact turn reached a terminal boundary; refusing to rerun it.",
      );
    }
    if (terminal.workspaceGenerationManifestPath) {
      let receipt;
      try {
        receipt = await this.deps.recoverWorkspaceGeneration(
          terminal.workspaceGenerationManifestPath,
          // The trusted wrapper terminal above proves native process-group and
          // remote capability retirement. A stale detached process may still
          // hold old file descriptors, so recovery renames the generation out
          // of its allowlisted path before sealing its immutable Git tree.
          { retireReadyGeneration: true },
        );
      } catch (error) {
        throw new CursorRoomTurnRecoveryError(
          `Cursor's exact workspace generation could not be recovered: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (receipt.phase !== "cleaned") {
        throw new CursorRoomTurnRecoveryError(
          `Cursor's exact workspace generation recovery ended in ${receipt.phase}, not cleaned.`,
        );
      }
    }
    if (handle.providerContinuationId?.startsWith(CURSOR_PENDING_CONTINUATION_PREFIX)
      && terminal.providerContinuationId) {
      handle.providerContinuationId = requireCursorSessionId(
        terminal.providerContinuationId,
        "Cursor recovered session",
      );
    }
    try {
      await options.checkpointProviderState?.({
        providerContinuationId: handle.providerContinuationId!,
        providerConnection: handle.providerConnection,
      });
    } catch (error) {
      // The manifest write may already have committed before a later durable
      // checkpoint failed. Keep the continuation proven by the exact terminal
      // so an idempotent retry converges from either old or new durable state.
      throw new CursorRoomTurnRecoveryError(
        `Cursor terminal recovery could not checkpoint its exact continuation: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (terminal.state === "attempt_terminal") {
        // Recovery has the same attempt-level semantics as live completion. A
        // trusted wrapper terminal with init but no result proves this native
        // lane ended. Checkpoint its recovered continuation first because the
        // daemon's synchronous onExit listener retires the live handle and
        // would otherwise invalidate that checkpoint's ownership fence. The
        // finally still guarantees terminalization before either checkpoint
        // failure or providerRoomTurnResult escapes to the delivery worker.
        const attemptTerminal = this.finishAttempt(
          handle,
          terminal.exit,
          terminal.attemptTerminal?.terminalCause,
        );
        terminal = { ...terminal, attemptTerminal };
      }
    }
    const result = this.providerRoomTurnResult(turnId, terminal);
    const disposition = await options.checkpointTerminalResult?.(result);
    const acceptedResult = disposition?.acceptedResult ?? result;
    const cleanupRecoveryEvidence = options.checkpointTerminalResult
      ? disposition === undefined
        ? result.outcome !== "unreadable"
        : disposition.cleanupRecoveryEvidence
      : false;
    if (cleanupRecoveryEvidence) {
      if (terminal.workspaceGenerationManifestPath) {
        await this.deps.removeWorkspaceGenerationReceipt(terminal.workspaceGenerationManifestPath);
      }
      this.removeDurableTurnJournal(handle, turnId);
    }
    if (cleanupRecoveryEvidence || (!options.checkpointTerminalResult && result.outcome !== "unreadable")) {
      handle.roomTurnResults.delete(turnId);
    }
    return acceptedResult;
  }

  private readDurableTurnTerminal(
    handle: CursorProviderHandle,
    turnId: string,
  ): CursorTurnTerminal | null {
    const profile = handle.supervisedProfile;
    if (!profile) return null;
    const statePath = join(
      profile.configDir,
      `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`,
    );
    const terminalPath = `${statePath}.terminal.json`;
    const terminalJson = readBoundedCursorTurnFile(
      terminalPath,
      MAX_DURABLE_TURN_TERMINAL_BYTES,
      "Cursor durable terminal evidence",
    );
    if (terminalJson === null) return null;
    let exit: ProviderProcessExit;
    let initMessage: CursorStreamMessage;
    let resultMessage: CursorStreamMessage | null;
    let workspaceGenerationManifestPath: string | undefined;
    let terminalError: string | undefined;
    let publicationContract: CursorTurnTerminal["publicationContract"] = "structured_room_turn_v1";
    let legacyUnversionedTerminal = false;
    try {
      const raw = JSON.parse(terminalJson) as Record<string, unknown>;
      const currentRemoteAuthorityEvidence = raw.native_process_group_reaped === true
        && raw.reap_scope === "native_process_group"
        && raw.remote_authority_revoked === true;
      if (!currentRemoteAuthorityEvidence) {
        throw new CursorRoomTurnRecoveryError("Cursor terminal evidence does not prove native process-group retirement and remote-authority revocation.");
      }
      if (raw.type === "not_started") {
        throw new CursorRoomTurnNotDispatchedError(
          "Cursor's prepared wrapper exited before native dispatch; the exact inbox item is safe to retry.",
        );
      }
      if (raw.type !== "exit" && raw.type !== "error") {
        throw new CursorRoomTurnRecoveryError("Cursor terminal evidence has an unknown type.");
      }
      if (raw.session_contract_valid !== true || raw.stream_contract_complete !== true) {
        throw new CursorRoomTurnRecoveryError("Cursor terminal evidence did not preserve a complete session contract.");
      }
      if (raw.turn_contract_version !== undefined) {
        if (raw.turn_contract_version !== 1) {
          throw new CursorRoomTurnRecoveryError("Cursor terminal evidence has an unsupported turn contract version.");
        }
        publicationContract = "structured_room_turn_v1";
      } else {
        legacyUnversionedTerminal = true;
      }
      if (raw.workspace_generation_manifest_path !== undefined
        && raw.workspace_generation_manifest_path !== null) {
        if (typeof raw.workspace_generation_manifest_path !== "string"
          || raw.workspace_generation_manifest_path.length === 0
          || raw.workspace_generation_manifest_path.length > 16_384
          || !isAbsolute(raw.workspace_generation_manifest_path)
          || resolve(raw.workspace_generation_manifest_path) !== raw.workspace_generation_manifest_path) {
          throw new CursorRoomTurnRecoveryError("Cursor terminal evidence has an invalid workspace-generation journal path.");
        }
        workspaceGenerationManifestPath = raw.workspace_generation_manifest_path;
      }
      if (!raw.init || typeof raw.init !== "object" || Array.isArray(raw.init)) {
        throw new CursorRoomTurnRecoveryError("Cursor terminal evidence has no verified init snapshot.");
      }
      initMessage = raw.init as CursorStreamMessage;
      resultMessage = raw.result === null
        ? null
        : raw.result && typeof raw.result === "object" && !Array.isArray(raw.result)
          ? raw.result as CursorStreamMessage
          : (() => { throw new CursorRoomTurnRecoveryError("Cursor terminal result snapshot is malformed."); })();
      if (legacyUnversionedTerminal && resultMessage && !Object.hasOwn(resultMessage, "subtype")) {
        publicationContract = "legacy_cursor_aggregate_v0";
      }
      exit = raw.type === "exit"
        ? {
          type: "exit",
          code: typeof raw.code === "number" ? raw.code : null,
          signal: typeof raw.signal === "string" ? raw.signal as NodeJS.Signals : null,
        }
        : { type: "error", error: new Error(typeof raw.error === "string" ? raw.error : "Cursor wrapper launch failed.") };
      terminalError = raw.type === "error"
        ? safeCursorTerminalErrorDetail(raw.error) ?? "Cursor wrapper launch failed."
        : undefined;
    } catch (error) {
      if (error instanceof CursorRoomTurnNotDispatchedError) throw error;
      if (error instanceof CursorRoomTurnRecoveryError) throw error;
      throw new CursorRoomTurnRecoveryError(`Cursor durable terminal evidence is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const initSessionId = sessionIdOf(initMessage);
    if (initMessage.type !== "system" || initMessage.subtype !== "init" || !initSessionId) {
      throw new CursorRoomTurnRecoveryError("Cursor terminal init snapshot has no valid provider session identity.");
    }
    const pendingContinuation = handle.providerContinuationId?.startsWith(CURSOR_PENDING_CONTINUATION_PREFIX) === true;
    if (handle.providerContinuationId && !pendingContinuation
      && initSessionId !== handle.providerContinuationId) {
      throw new CursorRoomTurnRecoveryError("Cursor terminal snapshot belongs to a different provider continuation.");
    }
    if (pendingContinuation) handle.providerContinuationId = initSessionId;
    const resultSessionId = resultMessage ? sessionIdOf(resultMessage) : null;
    if (resultMessage && publicationContract === "structured_room_turn_v1" && !resultSessionId) {
      throw new CursorRoomTurnRecoveryError("Cursor terminal result has no exact provider session identity.");
    }
    if (resultSessionId && resultSessionId !== initSessionId) {
      throw new CursorRoomTurnRecoveryError("Cursor terminal result belongs to a different provider continuation.");
    }
    const sawResult = resultMessage?.type === "result";
    let isError = true;
    let text: string | null = null;
    let providerRequestId: string | null = null;
    if (sawResult && resultMessage) {
      // Durable snapshots written before subtype capture only persisted
      // `{type:"result",is_error:false}`. Accept exactly that absent-field
      // legacy shape during restart recovery; live observations and newer
      // snapshots (which persist subtype, including explicit null) retain the
      // strict success + false contract.
      const legacySuccess = !Object.hasOwn(resultMessage, "subtype")
        && resultMessage.is_error === false;
      isError = !legacySuccess
        && (resultMessage.subtype !== "success" || resultMessage.is_error !== false);
      text = typeof resultMessage.result === "string" ? resultMessage.result : null;
      providerRequestId = typeof resultMessage.request_id === "string" && resultMessage.request_id.trim()
        ? resultMessage.request_id.trim()
        : null;
    }
    return sawResult
      ? {
        state: "result",
        exit,
        text,
        isError,
        providerRequestId,
        attemptTerminal: null,
        publicationContract,
        ...(terminalError ? { terminalError } : {}),
        providerContinuationId: initSessionId,
        ...(workspaceGenerationManifestPath ? { workspaceGenerationManifestPath } : {}),
      }
      : {
        state: "attempt_terminal",
        exit,
        text: null,
        isError: true,
        providerRequestId: null,
        attemptTerminal: null,
        publicationContract,
        ...(terminalError ? { terminalError } : {}),
        providerContinuationId: initSessionId,
        ...(workspaceGenerationManifestPath ? { workspaceGenerationManifestPath } : {}),
      };
  }

  /**
   * Read only the wrapper-authored containment proof needed when live MCP
   * startup fails before Cursor can emit a provider init. This deliberately
   * does not promote the record to a recoverable room-turn terminal: without
   * init there is no provider continuation identity.
   */
  private readTrustedPreInitTurnFailure(
    turn: LiveTurn,
  ): { errorDetail: string } | null {
    if (!turn.statePath) return null;
    let raw: Record<string, unknown>;
    try {
      const terminalJson = readBoundedCursorTurnFile(
        `${turn.statePath}.terminal.json`,
        MAX_DURABLE_TURN_TERMINAL_BYTES,
        "Cursor pre-init terminal evidence",
      );
      if (terminalJson === null) return null;
      raw = JSON.parse(terminalJson) as Record<string, unknown>;
    } catch {
      return null;
    }
    const errorDetail = safeCursorTerminalErrorDetail(raw.error);
    if (raw.type !== "error"
      || raw.native_process_group_reaped !== true
      || raw.reap_scope !== "native_process_group"
      || raw.remote_authority_revoked !== true
      || raw.turn_contract_version !== 1
      || raw.session_contract_valid !== true
      || raw.stream_contract_complete !== true
      || raw.init !== null
      || raw.result !== null
      || raw.workspace_generation_manifest_path !== turn.workspaceGenerationManifestPath
      || !errorDetail) {
      return null;
    }
    return { errorDetail };
  }

  private removeDurableTurnJournal(handle: CursorProviderHandle, turnId: string): void {
    const profile = handle.supervisedProfile;
    if (!profile) return;
    const statePath = join(
      profile.configDir,
      `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`,
    );
    // unlink never follows a symlink. Delete terminal authority first so a
    // crash during cleanup can only leave inert stream bytes, never a terminal
    // record that points at missing evidence.
    for (const path of [`${statePath}.terminal.json`, statePath]) {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new CursorRoomTurnRecoveryError("Cursor durable turn journal could not be retired safely.");
        }
      }
    }
  }

  async stop(
    providerHandle: ProviderHandle,
    options: ProviderStopOptions = {},
  ): Promise<ProviderTerminalPayload> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) return handle.terminal;
    handle.stopRequested = true;
    handle.state = "stopping";

    let turn = handle.liveTurn;
    const pendingController = turn ? null : handle.roomTurnAbortController;
    if (pendingController) {
      const settled = handle.roomTurnOperationSettled;
      pendingController.abort();
      await settled;
      turn = handle.liveTurn;
    }
    if (!turn) {
      // Idle lane: no process to signal. The attempt ends here with an honest
      // synthesized payload (no exit code exists because nothing was running).
      return this.finishAttempt(handle, { type: "exit", code: 0, signal: null });
    }

    if (options.force) {
      const signalled = this.signalExactProcess(
        turn.pid,
        turn.processIdentity,
        turn.child.ownsDescendantReaping ? "SIGTERM" : "SIGKILL",
      );
      if (signalled === "ambiguous") throw new Error("Cursor turn process birth is unverifiable; refusing force-stop.");
      if (signalled === "absent") {
        return this.finishAfterVerifiedWrapperAbsence(handle, turn);
      }
      if (turn.child.ownsDescendantReaping) {
        const reaped = await Promise.race([
          turn.child.exited.then(() => true),
          delay(options.graceMs ?? this.stopGraceMs).then(() => false),
        ]);
        if (!reaped) throw new Error("Cursor's wrapper has not yet retired its native process group.");
      }
      return this.awaitTurnTerminal(handle, turn);
    }
    const term = this.signalExactProcess(turn.pid, turn.processIdentity, "SIGTERM");
    if (term === "ambiguous") throw new Error("Cursor turn process birth is unverifiable; refusing stop.");
    if (term === "absent") {
      return this.finishAfterVerifiedWrapperAbsence(handle, turn);
    }
    const graceMs = options.graceMs ?? this.stopGraceMs;
    const graceful = await Promise.race([
      turn.child.exited.then(() => true),
      delay(graceMs).then(() => false),
    ]);
    if (!graceful && turn.child.ownsDescendantReaping) {
      throw new Error("Cursor's wrapper has not yet retired its native process group.");
    }
    if (!graceful) {
      const killed = this.signalExactProcess(turn.pid, turn.processIdentity, "SIGKILL");
      if (killed === "ambiguous") throw new Error("Cursor turn process birth became unverifiable before stop escalation.");
    }
    return this.awaitTurnTerminal(handle, turn);
  }

  onExit(
    providerHandle: ProviderHandle,
    listener: (payload: ProviderTerminalPayload) => void,
  ): () => void {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) {
      queueMicrotask(() => listener(handle.terminal!));
      return () => {};
    }
    handle.exitListeners.add(listener);
    return () => handle.exitListeners.delete(listener);
  }

  onActivity(
    providerHandle: ProviderHandle,
    listener: (event: ProviderActivityEvent) => void,
  ): () => void {
    const handle = this.requireHandle(providerHandle);
    handle.activityListeners.add(listener);
    return () => handle.activityListeners.delete(listener);
  }

  onStream(
    providerHandle: ProviderHandle,
    listener: (event: ProviderStreamEvent) => void,
  ): () => void {
    const handle = this.requireHandle(providerHandle);
    handle.streamListeners.add(listener);
    return () => handle.streamListeners.delete(listener);
  }

  private async start(
    req: ProviderSpawnRequest,
    resumeRef: ProviderContinuationRef | null,
  ): Promise<CursorProviderHandle> {
    const current = this.handles.get(req.workAttemptId);
    if (current && !current.terminal) {
      throw new Error(`Cursor work attempt '${req.workAttemptId}' already has a live lane.`);
    }
    if (!req.agentDisplayName?.trim()) {
      throw new Error("Cursor spawn requires the durable agent display name from the manifest.");
    }
    const deliveryMode = req.deliveryMode ?? "mcp_polling";
    if (deliveryMode !== "mcp_polling" && deliveryMode !== "daemon_inbox") {
      throw new Error(`Cursor does not support ${deliveryMode} room delivery.`);
    }
    if (deliveryMode === "daemon_inbox" && !req.permissionProfileId?.trim()) {
      throw new Error("Cursor daemon-inbox launch requires an exact permission profile.");
    }
    const policyArgs = [
      ...cursorLaunchPolicyArgs(attestProviderSpawnPolicy("cursor", req)),
      ...(req.model ? ["--model", req.model] : []),
    ];
    let supervisedProfile: CursorManagedProfile | null = null;
    if (deliveryMode === "daemon_inbox") {
      if (!req.supervisorEntryId?.trim()
        || !req.supervisorSocketPath?.trim()
        || !req.supervisorExecutionGenerationId?.trim()) {
        throw new Error("Cursor daemon-inbox launch requires exact supervisor coordinates.");
      }
      supervisedProfile = this.supervisedProfileFactory({
        workAttemptId: req.workAttemptId,
        cwd: req.cwd,
        permissionProfileId: req.permissionProfileId as CursorSupervisedProfileOptions["permissionProfileId"],
        includeAuth: false,
        devMcpServerEntryPath: req.devMcpServerEntryPath,
      });
    }
    const handle = new CursorProviderHandle(
      req.workAttemptId,
      req.cwd,
      policyArgs,
      deliveryMode,
      req,
      supervisedProfile,
    );
    if (resumeRef) handle.providerContinuationId = resumeRef.providerContinuationId;

    // A daemon successor must not start a bootstrap turn while an uncheckpointed
    // predecessor child may still be finishing. The durable FIFO recovers (or
    // blocks) that exact turn first; a later real inbox item verifies --resume.
    if (deliveryMode === "daemon_inbox") {
      // Cursor cannot mint a session without executing an inference. Persist a
      // non-native placeholder and let the FIRST DURABLY JOURNALED inbox turn
      // establish the real session instead of running uncaused bootstrap work.
      if (!handle.providerContinuationId) {
        handle.providerContinuationId = `${CURSOR_PENDING_CONTINUATION_PREFIX}${randomUUID()}`;
      }
      handle.state = "idle";
      this.handles.set(req.workAttemptId, handle);
      return handle;
    }

    const prompt = buildCodexStartPrompt({
      roomIdentifier: req.roomId,
      joinedVia: looksLikeInviteCode(req.roomId) ? "join_code" : "join_room",
      cwd: req.cwd,
      deliveryMode: "mcp_polling",
      stopPhrase: DEFAULT_CODEX_STOP_PHRASE,
      token: makeCodexStopToken(),
      suggestedDisplayName: req.agentDisplayName.trim(),
      deadlineUtc: null,
      maxMinutes: 0,
      providerLabel: "Cursor",
      runtimeKey: "cursor",
    });

    this.handles.set(req.workAttemptId, handle);
    try {
      await this.beginTurn(handle, prompt, resumeRef?.providerContinuationId ?? null);
      return handle;
    } catch (error) {
      if (this.handles.get(req.workAttemptId) === handle) {
        this.handles.delete(req.workAttemptId);
      }
      throw error;
    }
  }

  /**
   * Launch one native turn and resolve once it has STARTED (identity verified
   * and the first stream event observed). The room-worker turn then runs
   * arbitrarily long; completion is handled asynchronously by completeTurn —
   * spawn/poke callers get their handle back immediately, exactly like the
   * long-lived adapters.
   */
  private async beginTurn(
    handle: CursorProviderHandle,
    prompt: string,
    resumeSessionId: string | null,
    roomTurnId: string | null = null,
    checkpointProviderState?: ProviderRoomTurnOptions["checkpointProviderState"],
    checkpointTurnStarted?: ProviderRoomTurnOptions["checkpointTurnStarted"],
    checkpointPreparedTurn?: ProviderRoomTurnOptions["checkpointPreparedTurn"],
    launchSignal?: AbortSignal,
    markDurableTurnStarted?: ProviderRoomTurnOptions["markDurableTurnStarted"],
  ): Promise<LiveTurn> {
    throwIfCursorTurnLaunchAborted(launchSignal, roomTurnId);
    let childEnv: NodeJS.ProcessEnv | undefined;
    let deniedReadPaths: string[] | undefined;
    let deniedReadSubpaths: string[] | undefined;
    let deniedReadMetadataPaths: string[] | undefined;
    let deniedReadWriteRegexes: string[] | undefined;
    let deniedWriteRegexes: string[] | undefined;
    let deniedWritePaths: string[] | undefined;
    let deniedWriteStructuralPaths: string[] | undefined;
    let deniedWriteSubpaths: string[] | undefined;
    let deniedExecSubpaths: string[] | undefined;
    let allowedWriteSubpaths: string[] | undefined;
    let allowedReadSubpaths: string[] | undefined;
    let mcpConnectorRoot: string | undefined;
    let mcpConnectorSocketPath: string | undefined;
    let mcpRuntimeEntryPath: string | undefined;
    let mcpRuntimeEnv: Readonly<Record<string, string>> | undefined;
    let providerAuthorization: string | undefined;
    let supervisedRuntimeDataDir: string | undefined;
    let workspaceGeneration: SupervisedWorkspaceGenerationHandle | null = null;
    let providerWorkspace = handle.cwd;
    if (handle.deliveryMode === "daemon_inbox") {
      // First enumerate from a random disposable profile with an inert local
      // MCP and no turn/provider capability. The authority wrapper denies
      // direct networking and confines readable data/process execution.
      const inspectionProfileRoot = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-inspection-"));
      try {
        const enumerationProfile = this.supervisedProfileFactory({
          workAttemptId: `${handle.workAttemptId}:mcp-inspection:${randomUUID()}`,
          cwd: handle.cwd,
          profileRoot: inspectionProfileRoot,
          includeAuth: false,
          inspectionOnly: true,
          devMcpServerEntryPath: handle.spawnRequest.devMcpServerEntryPath,
        });
        const enumerationEnv = cursorMcpInspectionEnv({
          ...buildCursorChildEnv(enumerationProfile.env),
          AGENT_CLI_CREDENTIAL_STORE: "file",
        });
        await this.deps.attestSupervisedMcp({
          cursorBin: this.cursorBin,
          cwd: inspectionProfileRoot,
          env: enumerationEnv,
          writableProfileRoot: inspectionProfileRoot,
          expectedServerName: enumerationProfile.mcpServerName,
          signal: launchSignal,
        });
      } catch (error) {
        if (launchSignal?.aborted) {
          throw new CursorRoomTurnNotDispatchedError(
            "Cursor MCP attestation was interrupted and reaped before native dispatch.",
            roomTurnId,
          );
        }
        throw error;
      } finally {
        rmSync(inspectionProfileRoot, { recursive: true, force: true });
      }
      throwIfCursorTurnLaunchAborted(launchSignal, roomTurnId);

      // Pass one can only write its own now-deleted root. Create pass two
      // afterward so an escaped pass-one descendant never had path authority
      // over the profile that exercises the packaged bridge.
      const bridgeProfileRoot = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-bridge-"));
      try {
        const bridgeProfile = this.supervisedProfileFactory({
          workAttemptId: `${handle.workAttemptId}:mcp-bridge:${randomUUID()}`,
          cwd: handle.cwd,
          profileRoot: bridgeProfileRoot,
          includeAuth: false,
          inspectionOnly: false,
          devMcpServerEntryPath: handle.spawnRequest.devMcpServerEntryPath,
          mcpWorkingDirectory: bridgeProfileRoot,
          // Exercise the packaged server in its real credentialless bounded
          // mode. Owner mode would attempt repository auto-join after stdio
          // connect and can fail for reasons unrelated to MCP readiness. The
          // inspection never invokes a tool and its network sandbox admits no
          // supervisor socket, so these two non-secret mode markers cannot
          // borrow or exercise turn authority.
          supervisorMcpEnv: {
            LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
            LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
            LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
          },
        });
        const bridgeEnv = cursorMcpInspectionEnv({
          ...buildCursorChildEnv(bridgeProfile.env),
          // Prevent Cursor's shell launcher from consulting the login keychain
          // while validating a credentialless, local packaged bridge.
          AGENT_CLI_CREDENTIAL_STORE: "file",
        });
        await this.deps.attestSupervisedMcp({
          cursorBin: this.cursorBin,
          cwd: bridgeProfileRoot,
          env: bridgeEnv,
          writableProfileRoot: bridgeProfileRoot,
          requiredReadableRoots: bridgeProfile.mcpRuntimeReadRoots,
          expectedServerName: bridgeProfile.mcpServerName,
          timeoutMs: CURSOR_REAL_MCP_VALIDATION_TIMEOUT_MS,
          signal: launchSignal,
        });
      } catch (error) {
        if (supervisedRuntimeDataDir) {
          removeCursorTurnRuntimeDataDir(supervisedRuntimeDataDir);
          supervisedRuntimeDataDir = undefined;
        }
        if (launchSignal?.aborted) {
          throw new CursorRoomTurnNotDispatchedError(
            "Cursor MCP attestation was interrupted and reaped before native dispatch.",
            roomTurnId,
          );
        }
        throw error;
      } finally {
        rmSync(bridgeProfileRoot, { recursive: true, force: true });
      }
      throwIfCursorTurnLaunchAborted(launchSignal, roomTurnId);
      // Prove the live credential-store identity immediately before every
      // dispatch. Cursor's cached authInfo can lag account/team membership and
      // ambient API credentials are deliberately scrubbed, so a fresh random
      // profile runs only `status --format json`, requires real userInfo, and
      // fails closed for team-managed identities. The attested auth-only files
      // then overwrite stale metadata in the stable attempt profile.
      const identityProfileRoot = mkdtempSync(join(tmpdir(), "letagents-cursor-identity-"));
      try {
        let identityProfile = this.supervisedProfileFactory({
          workAttemptId: `${handle.workAttemptId}:identity:${randomUUID()}`,
          cwd: handle.cwd,
          profileRoot: identityProfileRoot,
          includeAuth: true,
          identityAttestationOnly: true,
          inspectionOnly: true,
          devMcpServerEntryPath: handle.spawnRequest.devMcpServerEntryPath,
          mcpWorkingDirectory: identityProfileRoot,
        });
        const personalIdentity = await this.deps.attestPersonalIdentity({
          cursorBin: this.cursorBin,
          cwd: identityProfileRoot,
          env: cursorDaemonChildEnv(identityProfile.env),
          writableProfileRoot: identityProfileRoot,
          requiredReadableRoots: identityProfile.authReadRoots,
          timeoutMs: CURSOR_IDENTITY_ATTESTATION_TIMEOUT_MS,
          signal: launchSignal,
        });
        providerAuthorization = personalIdentity.providerAuthorization;
        if (!providerAuthorization) {
          throw new Error("Cursor live identity attestation returned no provider authorization proof.");
        }
        // Reseal after status so any refreshed teamId is checked before its
        // sanitized auth metadata becomes the final turn's source.
        identityProfile = this.supervisedProfileFactory({
          workAttemptId: `${handle.workAttemptId}:identity:resealed`,
          cwd: handle.cwd,
          profileRoot: identityProfileRoot,
          includeAuth: true,
          authSourceHomeDir: identityProfile.homeDir,
          attestedPersonalIdentity: personalIdentity,
          exposeLoginCredentials: false,
          inspectionOnly: true,
          devMcpServerEntryPath: handle.spawnRequest.devMcpServerEntryPath,
          mcpWorkingDirectory: identityProfileRoot,
        });
        throwIfCursorTurnLaunchAborted(launchSignal, roomTurnId);

        // Only after both credentialless probes are removed and live identity
        // is proven do we atomically reseal the stable profile and mint the
        // real MCP child's exact turn capability.
        if (roomTurnId && cursorPermissionUsesWorkspaceGeneration(handle.spawnRequest.permissionProfileId)) {
          workspaceGeneration = await this.deps.createWorkspaceGeneration({
            realWorkspace: handle.cwd,
            turnIdentity: roomTurnId,
          });
        }
        providerWorkspace = workspaceGeneration?.liveWorkspace ?? handle.cwd;
        const supervisorMcpEnv = cursorSupervisorMcpEnv(handle.spawnRequest, roomTurnId);
        mcpConnectorRoot = join(CURSOR_MCP_CONNECTOR_PARENT, `letagents-cursor-mcp-${randomUUID()}`);
        mcpConnectorSocketPath = join(mcpConnectorRoot, "stdio.sock");
        const profile = this.supervisedProfileFactory({
          workAttemptId: handle.workAttemptId,
          cwd: providerWorkspace,
          permissionProfileId: handle.spawnRequest.permissionProfileId as CursorSupervisedProfileOptions["permissionProfileId"],
          authSourceHomeDir: identityProfile.homeDir,
          attestedPersonalIdentity: personalIdentity,
          exposeLoginCredentials: false,
          devMcpServerEntryPath: handle.spawnRequest.devMcpServerEntryPath,
          mcpConnectorSocketPath,
        });
        this.deps.bindPersonalIdentity(profile, personalIdentity);
        childEnv = cursorDaemonChildEnv(profile.env);
        const toolchainPath = cursorSandboxToolchainBinPaths();
        if (toolchainPath.length > 0) {
          // Apple's /usr/bin compiler drivers are xcrun shims, which require
          // host temp/cache writes. Prefer the real selected compiler bins so
          // ordinary repo builds work without widening the repo-only fence.
          childEnv.PATH = cursorSandboxPathWithToolchains(childEnv.PATH ?? "", toolchainPath);
        }
        const sdkRoot = cursorSandboxSdkRoot();
        if (sdkRoot) childEnv.SDKROOT = sdkRoot;
        // Cursor's long stable Application Support path otherwise falls back
        // to the shared /tmp/.cursor worker socket. A new unpredictable short
        // root per turn prevents both ambient-worker reuse and a detached old
        // helper from colliding with the next resumed turn.
        supervisedRuntimeDataDir = prepareCursorTurnRuntimeDataDir();
        childEnv.CURSOR_DATA_DIR = supervisedRuntimeDataDir;
        // Cursor's installed launcher adds `--use-system-ca` for memory/Keychain
        // stores, which makes Node enumerate the user's macOS Keychain. The
        // file store is confined to this owner-private profile; Cursor writes
        // only our public argv placeholder and the wrapper removes it before
        // publishing terminal evidence.
        childEnv.AGENT_CLI_CREDENTIAL_STORE = "file";
        deniedReadPaths = profile.nativeDeniedReadPaths;
        deniedReadSubpaths = profile.nativeDeniedReadSubpaths;
        deniedReadMetadataPaths = profile.nativeDeniedReadMetadataPaths;
        deniedReadWriteRegexes = profile.nativeDeniedReadWriteRegexes;
        deniedWriteRegexes = profile.nativeDeniedWriteRegexes;
        deniedWritePaths = profile.nativeDeniedWritePaths;
        deniedWriteStructuralPaths = profile.nativeDeniedWriteStructuralPaths;
        deniedWriteSubpaths = profile.nativeDeniedWriteSubpaths;
        deniedExecSubpaths = profile.nativeDeniedExecSubpaths;
        allowedWriteSubpaths = profile.nativeAllowedWriteSubpaths?.length
          ? [...new Set([
            ...profile.nativeAllowedWriteSubpaths,
            ...cursorSandboxPathVariants(supervisedRuntimeDataDir),
          ])]
          : undefined;
        allowedReadSubpaths = profile.nativeAllowedReadSubpaths?.length
          ? [...new Set([
            ...profile.nativeAllowedReadSubpaths,
            ...cursorSandboxPathVariants(supervisedRuntimeDataDir),
            ...(workspaceGeneration?.readOnlyRoots.flatMap((entry) => [
              ...cursorSandboxPathVariants(entry.sourcePath),
              ...(entry.generationPath ? cursorSandboxPathVariants(entry.generationPath) : []),
            ]) ?? []),
          ])]
          : undefined;
        deniedExecSubpaths = [...new Set([
          ...(deniedExecSubpaths ?? []),
          ...cursorSandboxPathVariants(supervisedRuntimeDataDir),
        ])];
        mcpRuntimeEntryPath = profile.mcpRuntimeEntryPath;
        if (!profile.mcpRuntimeEnv) {
          throw new Error("Supervised Cursor's wrapper-hosted MCP environment is unavailable.");
        }
        const mcpRuntimeRoot = dirname(mcpConnectorSocketPath);
        mcpRuntimeEnv = {
          ELECTRON_RUN_AS_NODE: "1",
          LETAGENTS_API_URL: profile.mcpRuntimeEnv.LETAGENTS_API_URL,
          HOME: join(mcpRuntimeRoot, "home"),
          XDG_CONFIG_HOME: join(mcpRuntimeRoot, "config"),
          XDG_DATA_HOME: join(mcpRuntimeRoot, "data"),
          XDG_CACHE_HOME: join(mcpRuntimeRoot, "cache"),
          CURSOR_CONFIG_DIR: join(mcpRuntimeRoot, "config", "cursor"),
          CURSOR_DATA_DIR: join(mcpRuntimeRoot, "data", "cursor"),
          NODE_COMPILE_CACHE: join(mcpRuntimeRoot, "cache", "node-compile-cache"),
          CURSOR_API_KEY: "",
          CURSOR_AUTH_TOKEN: "",
          ...supervisorMcpEnv,
        };
      } catch (error) {
        if (workspaceGeneration) {
          await this.abandonTurnWorkspaceGeneration(workspaceGeneration);
          workspaceGeneration = null;
        }
        if (launchSignal?.aborted) {
          throw new CursorRoomTurnNotDispatchedError(
            "Cursor identity attestation was interrupted before native dispatch.",
            roomTurnId,
          );
        }
        throw error;
      } finally {
        rmSync(identityProfileRoot, { recursive: true, force: true });
      }
    }
    const nativeResumeSession = resumeSessionId?.startsWith(CURSOR_PENDING_CONTINUATION_PREFIX)
      ? null
      : resumeSessionId
        ? requireCursorSessionId(resumeSessionId, "Cursor resume session")
        : null;
    const args = [
      "-p",
      "--output-format", "stream-json",
      // Cursor otherwise merges every .cursor/cli.json from the Git root down
      // to --workspace after our static check. Keep the provider's own native
      // suppression in addition to the per-turn filesystem revalidation.
      ...(handle.deliveryMode === "daemon_inbox" ? ["--disable-project-configs"] : []),
      ...(handle.deliveryMode === "daemon_inbox" ? ["--disable-auto-update"] : []),
      "--trust",
      // Read-only has no native sandbox field in its durable policy, so add
      // the supervised outer boundary explicitly. Write profiles carry their
      // exact enabled/disabled native choice in policyArgs; both stay inside
      // the independent OS workspace/process/network boundary.
      ...(handle.deliveryMode === "daemon_inbox" && handle.spawnRequest.permissionProfileId === "read_only"
        ? ["--sandbox", "enabled"]
        : []),
      "--workspace", providerWorkspace,
      ...handle.policyArgs,
      ...(nativeResumeSession ? [`--resume=${nativeResumeSession}`] : []),
      prompt,
    ];
    const statePath = roomTurnId && handle.supervisedProfile
      ? join(
        handle.supervisedProfile.configDir,
        `letagents-cursor-turn-${createHash("sha256").update(roomTurnId).digest("hex")}.jsonl`,
      )
      : null;
    if (statePath) {
      this.deps.prepareTurnState(statePath);
    }
    let child: CursorCliChild;
    try {
      child = this.deps.launchTurn({
      cursorBin: this.cursorBin,
      args,
      // Start inside the sealed private profile so no ambient launch cwd can
      // contribute config before Cursor resolves --workspace. Cursor later
      // changes into that workspace and can discover a concurrently-added
      // project MCP; the unpredictable bridge alias, approval-state purge, and
      // absence of --approve-mcps keep such a late server unapproved.
      cwd: handle.deliveryMode === "daemon_inbox" && handle.supervisedProfile
        ? dirname(handle.supervisedProfile.homeDir)
        : handle.cwd,
      ...(childEnv ? { env: childEnv } : {}),
      ...(deniedReadPaths?.length ? { deniedReadPaths } : {}),
      ...(deniedReadSubpaths?.length ? { deniedReadSubpaths } : {}),
      ...(deniedReadMetadataPaths?.length ? { deniedReadMetadataPaths } : {}),
      ...(deniedReadWriteRegexes?.length ? { deniedReadWriteRegexes } : {}),
      ...(deniedWriteRegexes?.length ? { deniedWriteRegexes } : {}),
      ...(deniedWritePaths?.length ? { deniedWritePaths } : {}),
      ...(deniedWriteStructuralPaths?.length ? { deniedWriteStructuralPaths } : {}),
      ...(deniedWriteSubpaths?.length ? { deniedWriteSubpaths } : {}),
      ...(deniedExecSubpaths?.length ? { deniedExecSubpaths } : {}),
      ...(allowedWriteSubpaths?.length ? { allowedWriteSubpaths } : {}),
      ...(allowedReadSubpaths?.length ? { allowedReadSubpaths } : {}),
      ...(handle.deliveryMode === "daemon_inbox"
        ? { allowedNetworkUnixSockets: [mcpConnectorSocketPath!] }
        : {}),
      ...(mcpConnectorSocketPath ? { mcpConnectorSocketPath } : {}),
      ...(mcpRuntimeEntryPath ? { mcpRuntimeEntryPath } : {}),
      ...(handle.deliveryMode === "daemon_inbox" ? { mcpRuntimeCwd: providerWorkspace } : {}),
      ...(mcpRuntimeEnv ? { mcpRuntimeEnv } : {}),
      ...(providerAuthorization ? { providerAuthorization } : {}),
      ...(handle.deliveryMode === "daemon_inbox" ? { deferStart: true } : {}),
      ...(handle.deliveryMode === "daemon_inbox" ? { restrictRemoteAuthority: true } : {}),
      ...(workspaceGeneration
        ? { workspaceGenerationManifestPath: workspaceGeneration.manifestPath }
        : {}),
      ...(statePath ? { statePath } : {}),
      });
    } catch (error) {
      if (supervisedRuntimeDataDir) removeCursorTurnRuntimeDataDir(supervisedRuntimeDataDir);
      if (workspaceGeneration) {
        await this.abandonTurnWorkspaceGeneration(workspaceGeneration);
        workspaceGeneration = null;
      }
      throw error;
    }
    if (supervisedRuntimeDataDir) {
      const runtimeDataDir = supervisedRuntimeDataDir;
      // The production wrapper removes this before terminal publication. This
      // post-exit fallback also retires it for injected/test launchers and a
      // wrapper that exits before entering its finalizer.
      void child.exited.then(() => {
        try { removeCursorTurnRuntimeDataDir(runtimeDataDir); } catch { /* terminal evidence remains authoritative */ }
      });
    }
    if (mcpConnectorRoot) {
      const connectorRoot = mcpConnectorRoot;
      // The wrapper normally retires this root before terminal evidence. If
      // the wrapper itself is SIGKILLed, the supervising adapter still owns
      // the unpredictable path and removes the now-dead socket tree on exit.
      void child.exited.then(() => {
        try { rmSync(connectorRoot, { recursive: true, force: true }); } catch { /* no live socket authority remains */ }
      });
    }
    const nativeLaunchIsDeferred = handle.deliveryMode === "daemon_inbox";
    const abandonPreparedGeneration = async (): Promise<void> => {
      if (!workspaceGeneration) return;
      await this.abandonTurnWorkspaceGeneration(workspaceGeneration);
      workspaceGeneration = null;
    };

    if (launchSignal?.aborted || handle.stopRequested) {
      if (child.pid !== null) {
        const wrapperIdentity = nativeLaunchIsDeferred ? this.deps.getProcessIdentity(child.pid) : undefined;
        await this.terminateTurnChild(child.pid, child.exited, wrapperIdentity, child.ownsDescendantReaping, nativeLaunchIsDeferred);
      } else {
        await child.exited;
      }
      await abandonPreparedGeneration();
      throw new CursorRoomTurnNotDispatchedError(
        "Cursor turn preparation was interrupted before native dispatch.",
        roomTurnId,
      );
    }

    if (child.pid === null) {
      // Fail closed until the launch proves terminal; never retry beside an
      // unobservable writer.
      await child.exited;
      await abandonPreparedGeneration();
      this.finishAttempt(handle, { type: "exit", code: null, signal: null }, "protocol_error");
      throw new Error("cursor-agent launch did not expose a process id; refusing an unfenceable turn.");
    }
    if (child.prepared) {
      let preparation: "prepared" | "exited" | "aborted";
      try {
        preparation = await Promise.race([
          child.prepared.then(() => "prepared" as const),
          child.exited.then(() => "exited" as const),
          cursorTurnLaunchAbort(launchSignal),
        ]);
      } catch (error) {
        await child.exited;
        await abandonPreparedGeneration();
        throw new Error(`Cursor wrapper could not prepare its durable boundary: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (preparation === "exited") {
        await abandonPreparedGeneration();
        throw new Error("Cursor wrapper exited before preparing its durable boundary; native work was not launched.");
      }
      if (preparation === "aborted") {
        const wrapperIdentity = nativeLaunchIsDeferred ? this.deps.getProcessIdentity(child.pid) : undefined;
        await this.terminateTurnChild(child.pid, child.exited, wrapperIdentity, child.ownsDescendantReaping, nativeLaunchIsDeferred);
        await abandonPreparedGeneration();
        throw new CursorRoomTurnNotDispatchedError(
          "Cursor turn preparation was interrupted before native dispatch.",
          roomTurnId,
        );
      }
    }
    const processIdentity = this.deps.getProcessIdentity(child.pid);
    if (typeof processIdentity !== "string" || !processIdentity) {
      await this.terminateTurnChild(child.pid, child.exited, processIdentity, child.ownsDescendantReaping, nativeLaunchIsDeferred);
      await abandonPreparedGeneration();
      this.finishAttempt(handle, { type: "exit", code: null, signal: null }, "protocol_error");
      throw new Error("cursor-agent process identity could not be verified; refusing an unfenceable turn.");
    }
    if (launchSignal?.aborted || handle.stopRequested) {
      await this.terminateTurnChild(child.pid, child.exited, processIdentity, child.ownsDescendantReaping, nativeLaunchIsDeferred);
      await abandonPreparedGeneration();
      throw new CursorRoomTurnNotDispatchedError(
        "Cursor turn preparation was interrupted before native dispatch.",
        roomTurnId,
      );
    }

    const turn: LiveTurn = {
      child,
      pid: child.pid,
      processIdentity,
      sawInit: false,
      sawResult: false,
      resultWasError: false,
      resultText: null,
      providerRequestId: null,
      interruptRequested: false,
      roomTurnId,
      controlTurnId: roomTurnId ?? randomUUID(),
      statePath,
      workspaceGeneration,
      workspaceGenerationManifestPath: workspaceGeneration?.manifestPath ?? null,
      liveDisplayTools: new Map(),
    };
    handle.liveTurn = turn;
    handle.state = "working";
    let turnCheckpointed = false;
    try {
      // The wrapper already exists and has installed its disconnect/SIGTERM
      // not-started journal, but native Cursor is still paused. Production
      // daemon delivery persists the exact supervisor turn and wrapper birth
      // in one transaction before release. The split callbacks remain only as
      // a compatibility path for direct adapter consumers during upgrade.
      if (roomTurnId) {
        if (checkpointPreparedTurn) {
          await checkpointPreparedTurn({
            providerTurnId: roomTurnId,
            providerContinuationId: handle.providerContinuationId!,
            providerConnection: handle.providerConnection,
          });
        } else {
          await checkpointTurnStarted?.(roomTurnId);
          await checkpointProviderState?.({
            providerContinuationId: handle.providerContinuationId!,
            providerConnection: handle.providerConnection,
          });
        }
        turnCheckpointed = true;
      } else {
        await checkpointProviderState?.({
          providerContinuationId: handle.providerContinuationId!,
          providerConnection: handle.providerConnection,
        });
      }
      throwIfCursorTurnLaunchAborted(launchSignal, roomTurnId);
      if (handle.liveTurn !== turn || turn.interruptRequested || handle.stopRequested) {
        throw new CursorRoomTurnNotDispatchedError(
          "Cursor turn preparation was interrupted at the durable checkpoint boundary.",
          roomTurnId,
        );
      }
      // The exact turn id and wrapper birth are both committed. Flip the
      // daemon's drain boundary and unlink handoff cancellation in one
      // synchronous callback immediately before native release.
      markDurableTurnStarted?.();
      if (handle.liveTurn !== turn || turn.interruptRequested || handle.stopRequested) {
        throw new CursorRoomTurnNotDispatchedError(
          "Cursor turn preparation was interrupted before native release.",
          roomTurnId,
        );
      }
    } catch (error) {
      await this.terminateTurnChild(turn.pid, child.exited, turn.processIdentity, child.ownsDescendantReaping, nativeLaunchIsDeferred);
      await abandonPreparedGeneration();
      turn.workspaceGeneration = null;
      handle.liveTurn = null;
      handle.state = "idle";
      if (turnCheckpointed) {
        // The atomic prepared checkpoint may already have committed the exact
        // wrapper birth even though native work was never released. Retire
        // that dead birth while the exact inbox turn still fences this
        // callback. The daemon permits this narrow live->idle edge during
        // handoff because the old owner still holds the singleton and drain.
        try {
          await checkpointProviderState?.({
            providerContinuationId: handle.providerContinuationId!,
            providerConnection: handle.providerConnection,
          });
        } catch (retirementError) {
          throw new CursorRoomTurnNotDispatchedError(
            `Cursor prepared wrapper was reaped, but its durable idle-state retirement failed: ${retirementError instanceof Error ? retirementError.message : String(retirementError)}`,
            roomTurnId,
          );
        }
        throw new CursorRoomTurnNotDispatchedError(
          `Cursor wrapper state could not be checkpointed before native dispatch: ${error instanceof Error ? error.message : String(error)}`,
          roomTurnId,
        );
      }
      if (launchSignal?.aborted) {
        throw new CursorRoomTurnNotDispatchedError(
          "Cursor turn preparation was interrupted and reaped before native dispatch.",
          roomTurnId,
        );
      }
      throw error;
    }
    // Startup gates on a VALID system/init — not on arbitrary stdout bytes. A
    // raw diagnostic line preceding init is published as evidence but must not
    // let spawn() return an uninitialized handle with no session identity
    // (msg_1758). init is the first event in the proven ordering (msg_1685),
    // so this bound is a protocol assertion, not a latency allowance.
    let signalInit: (() => void) | null = null;
    const initSeen = new Promise<"init">((resolve) => {
      signalInit = () => resolve("init");
    });
    const unsubscribe = child.onLine((line) => {
      this.consumeLine(handle, turn, line);
      if (turn.sawInit) signalInit?.();
    });
    const checkpointReleasedTurnIdle = async (): Promise<void> => {
      if (!turnCheckpointed || !roomTurnId || !checkpointProviderState) return;
      const providerContinuationId = handle.providerContinuationId ?? resumeSessionId;
      if (!providerContinuationId) return;
      await checkpointProviderState({
        providerContinuationId,
        providerConnection: handle.providerConnection,
      });
    };
    try {
      child.release();
    } catch (error) {
      // A failed IPC send is ambiguous: the wrapper may have received release
      // immediately before the channel reported failure. Reap first and
      // reconcile as post-dispatch work; never abandon the generation or tell
      // the daemon that this exact inbox item is automatically safe to rerun.
      unsubscribe();
      await this.terminateTurnChild(
        turn.pid,
        child.exited,
        turn.processIdentity,
        child.ownsDescendantReaping,
        nativeLaunchIsDeferred,
      );
      const exit = await child.exited;
      await this.retireTurnWorkspaceGeneration(handle, turn);
      if (handle.liveTurn === turn) handle.liveTurn = null;
      handle.state = "idle";
      await checkpointReleasedTurnIdle();
      if (roomTurnId) {
        throw new CursorPostDispatchCheckpointError(
          `Cursor native release acknowledgement was ambiguous; exact terminal recovery is required: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.finishAttempt(handle, exit, "protocol_error");
      throw error;
    }

    // The timer is REF'D and cleared: startup must stay observable even on an
    // otherwise idle loop. A turn that has passed init may run arbitrarily long
    // (quiet models are not dead — the exit event is the only terminal evidence).
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    const startTimeout = new Promise<"timeout">((resolve) => {
      startTimer = setTimeout(() => resolve("timeout"), this.turnStartTimeoutMs);
    });
    const first = await Promise.race([
      initSeen,
      child.exited.then(() => "exited" as const),
      startTimeout,
    ]);
    if (startTimer) clearTimeout(startTimer);
    if (first !== "init" && turn.interruptRequested) {
      // A user Stop can land after the prepared wrapper is released but before
      // Cursor emits its first valid init. The exact child has been fenced, so
      // this is a turn interruption—not evidence that the durable Cursor lane
      // itself died. Retire the wrapper birth and preserve the continuation.
      unsubscribe();
      if (first === "timeout") {
        await this.terminateTurnChild(turn.pid, child.exited, turn.processIdentity, child.ownsDescendantReaping);
      } else {
        await child.exited;
      }
      await this.retireTurnWorkspaceGeneration(handle, turn);
      if (handle.liveTurn === turn) handle.liveTurn = null;
      handle.state = "idle";
      await checkpointReleasedTurnIdle();
      throw new CursorRoomTurnNotDispatchedError(
        "Cursor turn was interrupted before its stream-json init; the continuation remains available.",
        roomTurnId,
      );
    }
    if (first === "timeout") {
      unsubscribe();
      await this.terminateTurnChild(turn.pid, child.exited, turn.processIdentity, child.ownsDescendantReaping);
      await this.retireTurnWorkspaceGeneration(handle, turn);
      handle.liveTurn = null;
      handle.state = "idle";
      await checkpointReleasedTurnIdle();
      this.finishAttempt(handle, { type: "exit", code: null, signal: null }, "protocol_error");
      throw new Error("cursor-agent reported no stream-json init within the startup bound; refusing an unobservable turn.");
    }
    if (first === "exited") {
      // The child died before a valid init: terminal evidence, and the launch
      // is REJECTED — a caller must never receive an already-terminal handle.
      // (A fenced session-contract violation lands here too, since the fence
      // terminates the child before readiness can resolve.)
      unsubscribe();
      const exit = await child.exited;
      const preInitFailure = this.readTrustedPreInitTurnFailure(turn);
      const liveFailureDetail = preInitFailure?.errorDetail
        ?? safeCursorTerminalErrorDetail(child.terminalError?.());
      let retirementError: unknown;
      try {
        await this.retireTurnWorkspaceGeneration(handle, turn, preInitFailure ? true : undefined);
      } catch (error) {
        // Never reconcile a writable generation without durable containment
        // proof. Preserve the causal live-MCP diagnosis while making the safe
        // retained-for-recovery state explicit to the caller.
        retirementError = error;
      }
      handle.liveTurn = null;
      handle.state = "idle";
      await checkpointReleasedTurnIdle();
      this.finishAttempt(handle, exit);
      if (retirementError) {
        if (liveFailureDetail) {
          const recoveryContext = preInitFailure
            ? "Its private workspace generation was retained because safe reconciliation did not complete."
            : "Its private workspace generation was retained for safe recovery because durable containment proof was unavailable.";
          throw new Error(
            `Cursor supervised startup failed: ${liveFailureDetail} ${recoveryContext}`,
          );
        }
        throw retirementError;
      }
      throw new Error(liveFailureDetail
        ? `Cursor supervised startup failed: ${liveFailureDetail}`
        : handle.protocolError
          ? "cursor-agent init violated the session contract; the turn was fenced."
          : "cursor-agent exited before reporting its stream-json init; the turn never became observable.");
    }
    if (handle.protocolError) {
      // consumeLine fenced a stranger session id in the init itself.
      unsubscribe();
      const exit = await child.exited;
      await this.retireTurnWorkspaceGeneration(handle, turn);
      handle.liveTurn = null;
      handle.state = "idle";
      await checkpointReleasedTurnIdle();
      this.finishAttempt(handle, exit);
      throw new Error("cursor-agent reported a different session than the durable continuation.");
    }
    if (!handle.providerContinuationId) {
      unsubscribe();
      await this.terminateTurnChild(turn.pid, child.exited, turn.processIdentity, child.ownsDescendantReaping);
      await this.retireTurnWorkspaceGeneration(handle, turn);
      handle.liveTurn = null;
      this.finishAttempt(handle, { type: "exit", code: null, signal: null }, "protocol_error");
      throw new Error("cursor-agent init carried no session id; refusing an unverifiable continuation.");
    }

    try {
      await checkpointProviderState?.({
        providerContinuationId: handle.providerContinuationId,
        providerConnection: handle.providerConnection,
      });
    } catch (error) {
      unsubscribe();
      await this.terminateTurnChild(turn.pid, child.exited, turn.processIdentity, child.ownsDescendantReaping);
      const exit = await child.exited;
      this.interruptLiveDisplayTools(handle, turn);
      const reportedContinuationId = handle.providerContinuationId;
      // Do not roll back a session identity proven by Cursor's exact init.
      // The daemon checkpoint may have committed its manifest update before a
      // later durability write failed; retaining the real identity lets the
      // recovery pass retry idempotently from either persisted side.
      let trustedDurableTerminal: CursorTurnTerminal | undefined;
      if (turn.child.requiresDurableTerminalEvidence) {
        try {
          // This post-init failure enters recoverRoomTurn immediately. Never
          // seed that recovery with buffered live output: the wrapper may have
          // been SIGKILLed during teardown before proving process-group and
          // authority retirement. The same trusted terminal check used by the
          // ordinary completion path is mandatory here too. It also preserves
          // a result emitted only during TERM teardown when no live result was
          // observed before the listener detached.
          trustedDurableTerminal = this.readTrustedDurableTurnTerminal(handle, turn);
        } catch (evidenceError) {
          handle.protocolError = true;
          this.publishStream(handle, "turn/terminal_invalid", {
            reason: evidenceError instanceof Error ? evidenceError.message : String(evidenceError),
          }, "error");
          this.finishAttempt(handle, exit, "protocol_error");
          throw new CursorRoomTurnRecoveryError(
            `Cursor reported a real session but its durable checkpoint failed, and trusted terminal recovery was unavailable: ${evidenceError instanceof Error ? evidenceError.message : String(evidenceError)}`,
          );
        }
      }
      await this.retireTurnWorkspaceGeneration(handle, turn, trustedDurableTerminal);
      handle.liveTurn = null;
      handle.state = "idle";
      if (trustedDurableTerminal) {
        this.rememberRoomTurnTerminal(handle, turn, trustedDurableTerminal);
      } else {
        this.rememberRoomTurnTerminal(handle, turn,
          turn.sawResult && !handle.protocolError
            ? {
              state: "result",
              exit,
              text: turn.resultText,
              isError: turn.resultWasError,
              providerRequestId: turn.providerRequestId,
              attemptTerminal: null,
              publicationContract: "structured_room_turn_v1",
              ...(reportedContinuationId ? { providerContinuationId: reportedContinuationId } : {}),
            }
            : {
              state: "attempt_terminal",
              exit,
              text: null,
              isError: true,
              providerRequestId: turn.providerRequestId,
              attemptTerminal: null,
              publicationContract: "structured_room_turn_v1",
              ...(reportedContinuationId ? { providerContinuationId: reportedContinuationId } : {}),
            });
      }
      throw new CursorPostDispatchCheckpointError(
        `Cursor reported a real session but its durable checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    turn.completion = this.completeTurn(handle, turn, unsubscribe);
    void turn.completion;
    return turn;
  }

  /** Await the turn's real exit and apply the honest end state. */
  private async completeTurn(
    handle: CursorProviderHandle,
    turn: LiveTurn,
    unsubscribe: () => void,
  ): Promise<CursorTurnTerminal> {
    const exit = await turn.child.exited;
    // Drain belt: even with close-gated exit evidence, give any line callbacks
    // already scheduled in this tick a chance to record the final result before
    // it is read — misreading a clean turn as !sawResult would drop the lane.
    // This drain is part of terminal correctness, not an optional background
    // timer. Keep the loop alive until it runs; an unref'd zero-delay timer can
    // otherwise strand stop()/handoff on an already-exited child.
    await new Promise<void>((resolveDrain) => setImmediate(resolveDrain));
    unsubscribe();
    // Every child exit is terminal for this turn's display lifecycle, even
    // when Cursor omits `result`, the user interrupts, or protocol validation
    // fails. The daemon stream spans turns, so leaving these entries in the
    // map would strand Inspector cards in `running` indefinitely.
    this.interruptLiveDisplayTools(handle, turn);
    let trustedDurableTerminal: CursorTurnTerminal | undefined;
    if (turn.child.requiresDurableTerminalEvidence) {
      try {
        trustedDurableTerminal = this.readTrustedDurableTurnTerminal(handle, turn);
      } catch (error) {
        handle.protocolError = true;
        this.publishStream(handle, "turn/terminal_invalid", {
          reason: error instanceof Error ? error.message : String(error),
        }, "error");
      }
    }
    const exactTerminalError = trustedDurableTerminal?.terminalError
      ?? safeCursorTerminalErrorDetail(turn.child.terminalError?.())
      ?? undefined;
    if (turn.workspaceGeneration && turn.child.requiresDurableTerminalEvidence
      && !trustedDurableTerminal) {
      // Do not touch the provider-authored tree until a successor can prove the
      // exact wrapper retired both process and remote authority. The generation
      // handle/receipt deliberately remains live and recoverable.
      const attemptTerminal = this.finishAttempt(handle, exit, "protocol_error");
      return this.rememberRoomTurnTerminal(handle, turn, {
        state: "attempt_terminal",
        exit,
        text: null,
        isError: true,
        providerRequestId: turn.providerRequestId,
        attemptTerminal,
        publicationContract: "structured_room_turn_v1",
        ...(exactTerminalError
          ? {
            terminalError: `${exactTerminalError} Its private workspace generation was retained for safe recovery because durable containment proof was unavailable.`,
          }
          : {}),
      });
    }
    await this.retireTurnWorkspaceGeneration(handle, turn, trustedDurableTerminal);
    if (handle.liveTurn === turn) handle.liveTurn = null;
    if (handle.terminal) {
      return this.rememberRoomTurnTerminal(handle, turn, {
        state: "attempt_terminal",
        exit,
        text: null,
        isError: true,
        providerRequestId: turn.providerRequestId,
        attemptTerminal: handle.terminal,
        publicationContract: "structured_room_turn_v1",
        ...(exactTerminalError ? { terminalError: exactTerminalError } : {}),
      });
    }

    if (turn.interruptRequested) {
      // Cursor has no in-turn channel, so the exact turn child is fenced and
      // the durable session is resumed for any correction. This is explicitly
      // TURN-terminal, never ATTEMPT-terminal.
      handle.state = "idle";
      this.publishActivity(handle, {
        source: "native_harness",
        method: "turn/interrupted",
        summary: "Turn interrupted; continuation preserved",
        status: "idle",
        checking: "",
        next_action: "awaiting redirected work",
      });
      return this.rememberRoomTurnTerminal(handle, turn, {
        state: "interrupted",
        exit,
        text: null,
        isError: true,
        providerRequestId: turn.providerRequestId,
        attemptTerminal: null,
        publicationContract: "structured_room_turn_v1",
      });
    }

    if (exit.type === "error" || handle.stopRequested || handle.protocolError || !turn.sawResult) {
      // A launch error, a requested stop, a session-identity violation, or a
      // child that died without its final result event are all ATTEMPT-level
      // terminal evidence — never silently absorbed as an idle turn. The one
      // refinement: the proven usage-limit signature is provider_quota, not a
      // crash (recoverable by model switch / spend limit, per the spike).
      const attemptTerminal = this.finishAttempt(
        handle,
        exit,
        !handle.stopRequested && !handle.protocolError && isProviderQuotaExit(turn, exit)
          ? "provider_quota"
          : undefined,
      );
      return this.rememberRoomTurnTerminal(handle, turn, {
        state: "attempt_terminal",
        exit,
        text: null,
        isError: true,
        providerRequestId: turn.providerRequestId,
        attemptTerminal,
        publicationContract: "structured_room_turn_v1",
        ...(exactTerminalError ? { terminalError: exactTerminalError } : {}),
      });
    }

    // TURN-terminal, not ATTEMPT-terminal: the lane stays alive and honestly
    // idle, with the session id as its only continuation state.
    handle.state = "idle";
    this.publishActivity(handle, {
      source: "native_harness",
      method: "result",
      summary: turn.resultWasError ? "Turn ended with an error result" : "Turn completed",
      status: "idle",
      checking: "",
      next_action: "awaiting next boundary delivery",
    });
    return this.rememberRoomTurnTerminal(handle, turn, {
      state: "result",
      exit,
      text: turn.resultText,
      isError: turn.resultWasError,
      providerRequestId: turn.providerRequestId,
      attemptTerminal: null,
      publicationContract: "structured_room_turn_v1",
    });
  }

  private readTrustedDurableTurnTerminal(
    handle: CursorProviderHandle,
    turn: LiveTurn,
  ): CursorTurnTerminal {
    if (!turn.roomTurnId) {
      throw new CursorRoomTurnRecoveryError("The supervised result had no exact durable turn identity.");
    }
    const durable = this.readDurableTurnTerminal(handle, turn.roomTurnId);
    if (!durable) {
      throw new CursorRoomTurnRecoveryError("The supervised wrapper published no trusted terminal evidence.");
    }
    if ((durable.workspaceGenerationManifestPath ?? null) !== turn.workspaceGenerationManifestPath) {
      throw new CursorRoomTurnRecoveryError(
        "The supervised wrapper terminal belongs to a different workspace generation.",
      );
    }
    // A result written only after checkpoint failure can legitimately exist
    // only in the wrapper journal. When a live result was already observed,
    // however, accepting a different durable value would cross-wire terminal
    // evidence and must fail closed.
    if (turn.sawResult && (durable.state !== "result"
      || durable.text !== turn.resultText
      || durable.isError !== turn.resultWasError
      || durable.providerRequestId !== turn.providerRequestId)) {
      throw new CursorRoomTurnRecoveryError(
        durable.state !== "result"
          ? "The supervised wrapper terminal did not contain the observed result."
          : "The live result did not match the exact durable terminal snapshot.",
      );
    }
    return durable;
  }

  /**
   * Filesystem authority ends only after the private generation is renamed out
   * of the provider's allowlisted path, sealed into an immutable Git tree, and
   * reconciled through its durable journal. Wrapper/process exit is necessary
   * remote authority evidence, but is deliberately not this receipt.
   */
  private async retireTurnWorkspaceGeneration(
    handle: CursorProviderHandle,
    turn: LiveTurn,
    trustedRemoteAuthorityEvidence?: CursorTurnTerminal | true,
  ): Promise<void> {
    const generation = turn.workspaceGeneration;
    if (!generation) return;
    // A wrapper exit alone does not prove that its native process group and
    // one-turn remote capabilities are gone. Validate the exact durable
    // terminal before renaming, freezing, or applying any provider-authored
    // filesystem state. On failure, retain the ready generation receipt so a
    // successor can recover only after it obtains trusted containment proof.
    if (turn.child.requiresDurableTerminalEvidence && !trustedRemoteAuthorityEvidence) {
      this.readTrustedDurableTurnTerminal(handle, turn);
    }
    try {
      const receipt = await generation.retireAndReconcile();
      if (receipt.phase !== "cleaned") {
        throw new Error(`unexpected terminal phase ${receipt.phase}`);
      }
      turn.workspaceGeneration = null;
    } catch (error) {
      throw new CursorRoomTurnRecoveryError(
        `Cursor's private workspace generation could not be retired and reconciled: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async abandonTurnWorkspaceGeneration(
    generation: SupervisedWorkspaceGenerationHandle,
  ): Promise<void> {
    const receipt = await generation.abandon();
    if (receipt.phase !== "aborted") {
      throw new CursorRoomTurnRecoveryError(
        `Cursor's unreleased private workspace generation ended in ${receipt.phase}, not aborted.`,
      );
    }
    // Native work never crossed the release boundary, so no later result
    // checkpoint can need this receipt for crash recovery.
    await this.deps.removeWorkspaceGenerationReceipt(receipt.manifestPath);
  }

  private consumeLine(handle: CursorProviderHandle, turn: LiveTurn, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: CursorStreamMessage | null = null;
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        message = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as CursorStreamMessage
          : null;
      } catch {
        message = null;
      }
    }
    if (!message) {
      this.publishStream(handle, "stdout/raw", { line: trimmed }, "provider_event");
      return;
    }
    const sessionId = sessionIdOf(message);
    if (Object.hasOwn(message, "session_id") && !sessionId) {
      handle.protocolError = true;
      this.publishStream(handle, "session/invalid", {
        reason: "provider emitted an invalid or option-shaped session identity",
      }, "error");
      this.signalExactProcess(turn.pid, turn.processIdentity, "SIGTERM");
      return;
    }
    const pendingContinuation = handle.providerContinuationId?.startsWith(CURSOR_PENDING_CONTINUATION_PREFIX) === true;
    if (sessionId && handle.providerContinuationId && !pendingContinuation && handle.providerContinuationId !== sessionId) {
      // A stranger session must never silently become this lane's continuation
      // (same rule as the Claude adapter's same-id assertion).
      handle.protocolError = true;
      this.publishStream(handle, "session/mismatch", {
        expectedSessionId: handle.providerContinuationId,
        observedSessionId: sessionId,
      }, "error");
      this.signalExactProcess(turn.pid, turn.processIdentity, "SIGTERM");
      return;
    }
    if (message.type === "result"
      && (!turn.sawInit || !sessionId || sessionId !== handle.providerContinuationId)) {
      handle.protocolError = true;
      this.publishStream(handle, "result/session_invalid", {
        reason: "Cursor result did not carry the exact verified turn session identity.",
      }, "error");
      this.signalExactProcess(turn.pid, turn.processIdentity, "SIGTERM");
      return;
    }
    const safeProviderPayload = safeStreamPayload(message);
    const duplicateInit = message.type === "system" && message.subtype === "init" && turn.sawInit;
    // The daemon uses the first verified init as the per-turn display boundary.
    // Preserve duplicate same-session init as diagnostics under a distinct
    // method so it cannot erase assistant/tool output already shown this turn.
    this.publishSafeStream(handle, duplicateInit ? "system/init_duplicate" : streamMethod(message), safeProviderPayload, cursorStreamKind(message));
    const rawEventSequence = handle.streamSequence;
    const type = typeof message.type === "string" ? message.type : "";
    if (type === "system") {
      // Readiness AND identity adoption are STRICT: only a genuine system/init
      // event that carried a session id counts (msg_1807). Other events may
      // carry session ids that are asserted against an established continuation
      // above, but never establish one themselves.
      if (message.subtype === "init") {
        if (!sessionId) {
          handle.protocolError = true;
          this.publishStream(handle, "session/missing", {
            reason: "init carried no session id",
          }, "error");
          this.signalExactProcess(turn.pid, turn.processIdentity, "SIGTERM");
          return;
        }
        if (!handle.protocolError) {
          handle.providerContinuationId = sessionId;
          turn.sawInit = true;
        }
      }
      return;
    }
    // Display projections require the exact session established by init.
    // Missing/foreign identities remain raw diagnostic evidence only.
    if (turn.sawInit && sessionId && sessionId === handle.providerContinuationId) {
      for (const projection of cursorLiveDisplayProjections(
        safeProviderPayload.payload,
        turn.controlTurnId,
        String(rawEventSequence),
      )) {
        if (projection.method === "item/toolCall/updated") {
          const callId = typeof projection.payload.callID === "string" ? projection.payload.callID : null;
          if (callId) {
            if (projection.payload.status === "running") {
              turn.liveDisplayTools.set(callId, {
                tool: typeof projection.payload.tool === "string" ? projection.payload.tool : "tool",
                input: projection.payload.input ?? null,
              });
            } else {
              turn.liveDisplayTools.delete(callId);
            }
          }
        }
        this.publishStream(handle, projection.method, projection.payload, projection.kind);
      }
    }
    if (type === "result") {
      this.interruptLiveDisplayTools(handle, turn);
      turn.sawResult = true;
      turn.resultWasError = message.subtype !== "success" || message.is_error !== false;
      turn.resultText = typeof message.result === "string" ? message.result : null;
      turn.providerRequestId = typeof message.request_id === "string" && message.request_id.trim()
        ? message.request_id.trim()
        : null;
      return;
    }
    if (type === "assistant" || type === "tool_call" || type === "tool_use" || type === "user") {
      this.publishActivity(handle, {
        source: "native_harness",
        method: streamMethod(message),
        summary: `Processing ${streamMethod(message)}`,
        status: "working",
        checking: "",
        next_action: "",
      });
    }
  }

  private interruptLiveDisplayTools(handle: CursorProviderHandle, turn: LiveTurn): void {
    for (const [callID, tool] of turn.liveDisplayTools) {
      this.publishStream(handle, "item/toolCall/updated", {
        callID,
        tool: tool.tool,
        status: "interrupted",
        input: tool.input,
        output: null,
        error: null,
      }, "tool_lifecycle");
    }
    turn.liveDisplayTools.clear();
  }

  private rememberRoomTurnTerminal(
    handle: CursorProviderHandle,
    turn: LiveTurn,
    terminal: CursorTurnTerminal,
  ): CursorTurnTerminal {
    if (turn.roomTurnId) {
      handle.roomTurnResults.set(turn.roomTurnId, terminal);
      while (handle.roomTurnResults.size > 16) {
        const oldest = handle.roomTurnResults.keys().next().value;
        if (typeof oldest !== "string") break;
        handle.roomTurnResults.delete(oldest);
      }
      if (handle.activeRoomTurnId === turn.roomTurnId) handle.activeRoomTurnId = null;
    }
    return terminal;
  }

  private awaitRoomTurnTerminal(
    completion: Promise<CursorTurnTerminal>,
    detachSignal?: AbortSignal,
  ): Promise<CursorTurnTerminal> {
    if (!detachSignal) return completion;
    if (detachSignal.aborted) {
      return Promise.reject(new CursorRoomTurnObservationDetachedError("Cursor room-turn observation detached."));
    }
    return new Promise((resolve, reject) => {
      const detach = () => {
        detachSignal.removeEventListener("abort", detach);
        reject(new CursorRoomTurnObservationDetachedError("Cursor room-turn observation detached."));
      };
      detachSignal.addEventListener("abort", detach, { once: true });
      void completion.then(
        (terminal) => {
          detachSignal.removeEventListener("abort", detach);
          resolve(terminal);
        },
        (error) => {
          detachSignal.removeEventListener("abort", detach);
          reject(error);
        },
      );
    });
  }

  private providerRoomTurnResult(
    turnId: string,
    terminal: CursorTurnTerminal,
  ): ProviderRoomTurnResult {
    if (terminal.state === "interrupted") {
      throw new CursorRoomTurnTerminalError("Cursor bounded room turn was interrupted before publication.");
    }
    if (terminal.state === "attempt_terminal") {
      const cause = terminal.attemptTerminal?.terminalCause;
      throw new CursorRoomTurnTerminalError(
        cause === "provider_quota"
          ? "Cursor could not complete this turn because the provider usage limit was reached."
          : terminal.terminalError
            ? `Cursor supervised turn failed: ${terminal.terminalError}`
          : "Cursor ended before the bounded room turn produced a terminal result.",
      );
    }
    if (terminal.isError) {
      throw new CursorRoomTurnTerminalError("Cursor returned an error result for the bounded room turn.");
    }
    const text = terminal.text?.trim() || null;
    if (text === CURSOR_NO_ROOM_REPLY_SENTINEL) {
      return { turnId, outcome: "no_reply", text: null, evidence: "stream", publicationContract: terminal.publicationContract };
    }
    if (!text) return { turnId, outcome: "unreadable", text: null, evidence: "none", publicationContract: terminal.publicationContract };
    return { turnId, outcome: "reply", text, evidence: "stream", publicationContract: terminal.publicationContract };
  }

  /** Inspect the exact checkpointed wrapper without waiting or signalling it. */
  private async observeRecordedTurnChild(
    connection: Extract<ProviderConnectionRef, { kind: "cursor_cli" }>,
  ): Promise<null> {
    if (!connection.processIdentity) {
      throw new Error(
        "Cursor attach is ambiguous; the recorded turn child has no verified process identity.",
      );
    }
    const identity = this.deps.getProcessIdentity(connection.pid!);
    if (identity === undefined) {
      throw new Error("Cursor attach is ambiguous; the recorded process identity cannot be verified.");
    }
    if (identity === null || !sameProcessBirthIdentity(identity, connection.processIdentity)) return null;
    throw new CursorRecordedTurnInProgressError(
      "Cursor's exact recorded turn wrapper is still running; recovery will retry without starting a successor.",
    );
  }

  private async terminateTurnChild(
    pid: number,
    exited: Promise<ProviderProcessExit>,
    processIdentity?: string | null,
    ownsDescendantReaping = false,
    nativeLaunchIsDeferred = false,
  ): Promise<void> {
    // A daemon-inbox wrapper is born paused. While release() has not run it has
    // no native child/process group to preserve, so TERM may safely escalate to
    // KILL of the exact wrapper. After release, only the wrapper may prove its
    // separately-detached native descendants gone; killing it would discard
    // that proof, so the post-release path remains deliberately fail-closed.
    // Every PID signal is birth-fenced, including late post-release timeout and
    // protocol cleanup. `undefined` means this caller never captured a birth;
    // a later observation cannot be adopted because the original child could
    // have exited and its PID been recycled between those observations. Only a
    // previously captured identity authorizes signalling. In the ambiguous
    // case, remain attached to the exact ChildProcess exit instead.
    if (processIdentity === null) return;
    if (processIdentity === undefined) {
      await exited;
      return;
    }
    const term = this.signalExactProcess(pid, processIdentity, "SIGTERM");
    if (term === "absent") return;
    if (term === "ambiguous") {
      await exited;
      return;
    }
    const graceful = await Promise.race([
      exited.then(() => true),
      delay(this.stopGraceMs).then(() => false),
    ]);
    if (graceful) return;
    if (ownsDescendantReaping && !nativeLaunchIsDeferred) {
      throw new Error("Cursor's wrapper has not yet retired its native process group.");
    }
    const killed = this.signalExactProcess(pid, processIdentity, "SIGKILL");
    if (killed === "absent") return;
    if (killed === "ambiguous") {
      // Never let a pre-native cleanup promise settle on ambiguous liveness:
      // delivery treats settlement as proof that it may restore the FIFO.
      await exited;
      return;
    }
    await exited;
  }

  private exactProcessStatus(pid: number, processIdentity: string): "exact" | "absent" | "ambiguous" {
    const identity = this.deps.getProcessIdentity(pid);
    if (identity === undefined) return "ambiguous";
    if (identity === null || !sameProcessBirthIdentity(identity, processIdentity)) return "absent";
    return "exact";
  }

  private signalExactProcess(
    pid: number,
    processIdentity: string,
    signal: NodeJS.Signals,
  ): "signalled" | "absent" | "ambiguous" {
    const status = this.exactProcessStatus(pid, processIdentity);
    if (status !== "exact") return status;
    this.deps.signalProcess(pid, signal);
    return "signalled";
  }

  private async awaitTurnTerminal(
    handle: CursorProviderHandle,
    turn: LiveTurn,
  ): Promise<ProviderTerminalPayload> {
    const exit = await turn.child.exited;
    if (turn.completion) {
      await turn.completion;
    } else {
      await this.retireTurnWorkspaceGeneration(handle, turn);
      if (handle.liveTurn === turn) handle.liveTurn = null;
    }
    return handle.terminal ?? this.finishAttempt(handle, exit);
  }

  private finishAfterVerifiedWrapperAbsence(
    handle: CursorProviderHandle,
    turn: LiveTurn,
  ): ProviderTerminalPayload {
    if (turn.workspaceGeneration) {
      throw new CursorRoomTurnRecoveryError(
        "Cursor's exact wrapper birth is absent, but its writable generation has no terminal retirement receipt; restart recovery is required.",
      );
    }
    if (handle.liveTurn === turn) handle.liveTurn = null;
    return this.finishAttempt(handle, { type: "exit", code: null, signal: null });
  }

  private finishAttempt(
    handle: CursorProviderHandle,
    exit: ProviderProcessExit,
    forcedCause?: ProviderTerminalPayload["terminalCause"],
  ): ProviderTerminalPayload {
    if (handle.terminal) return handle.terminal;
    const terminal = exit.type === "error"
      ? {
        ...synthesizeTerminalPayload({
          endedAt: this.deps.now(),
          exitCode: null,
          signal: null,
          providerContinuationId: handle.providerContinuationId,
          stopRequested: handle.stopRequested,
        }),
        terminalCause: "protocol_error" as const,
      }
      : synthesizeTerminalPayload({
        endedAt: this.deps.now(),
        exitCode: exit.code,
        signal: exit.signal,
        providerContinuationId: handle.providerContinuationId,
        stopRequested: handle.stopRequested,
      });
    if (forcedCause) terminal.terminalCause = forcedCause;
    if (handle.protocolError) terminal.terminalCause = "protocol_error";
    handle.terminal = terminal;
    handle.liveTurn = null;
    handle.state = terminal.terminalCause === "exited" || terminal.terminalCause === "stopped"
      ? "stopped"
      : "failed";
    if (this.handles.get(handle.workAttemptId) === handle) {
      this.handles.delete(handle.workAttemptId);
    }
    for (const listener of handle.exitListeners) listener(terminal);
    handle.exitListeners.clear();
    return terminal;
  }

  private publishStream(
    handle: CursorProviderHandle,
    method: string,
    providerPayload: unknown,
    kind: ProviderStreamEventKind,
  ): void {
    this.publishSafeStream(handle, method, safeStreamPayload(providerPayload), kind);
  }

  private publishSafeStream(
    handle: CursorProviderHandle,
    method: string,
    safe: ReturnType<typeof safeStreamPayload>,
    kind: ProviderStreamEventKind,
  ): void {
    const event: ProviderStreamEvent = {
      workAttemptId: handle.workAttemptId,
      providerContinuationId: handle.providerContinuationId,
      observedAt: this.deps.now(),
      sequence: ++handle.streamSequence,
      provider: this.id,
      kind,
      method,
      ...safe,
      durablePayloadRef: null,
    };
    this.streamSink?.(event);
    for (const listener of handle.streamListeners) listener(event);
  }

  private publishActivity(
    handle: CursorProviderHandle,
    input: {
      source: ProviderActivityEvent["source"];
      method: string | null;
      summary: string;
      status: ProviderActivityEvent["status"];
      checking: string;
      next_action: string;
    },
  ): void {
    const event: ProviderActivityEvent = {
      workAttemptId: handle.workAttemptId,
      providerContinuationId: handle.providerContinuationId,
      observedAt: this.deps.now(),
      source: input.source,
      method: input.method,
      summary: input.summary,
      status: input.status,
      checking: input.checking,
      nextAction: input.next_action,
    };
    this.activitySink?.(event);
    for (const listener of handle.activityListeners) listener(event);
  }

  private requireHandle(handle: ProviderHandle): CursorProviderHandle {
    if (!(handle instanceof CursorProviderHandle)) {
      throw new Error("Provider handle does not belong to CursorProviderAdapter.");
    }
    return handle;
  }
}
