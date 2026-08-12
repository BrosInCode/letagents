import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, mkdtempSync, openSync, readSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { desktopRuntimeEnvironment } from "../desktop-shell-environment.js";

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
import {
  CURSOR_IDENTITY_ATTESTATION_TIMEOUT_MS,
  CURSOR_MCP_CONNECTOR_PARENT,
  CURSOR_REAL_MCP_VALIDATION_TIMEOUT_MS,
  MAX_CURSOR_SESSION_ID_LENGTH,
  MAX_DURABLE_TURN_TERMINAL_BYTES,
  TURN_START_TIMEOUT_MS,
  CURSOR_SESSION_ID_PATTERN,
} from "./cursor-provider-constants.js";
import { safeCursorTerminalErrorDetail } from "./cursor-provider-evidence.js";
import {
  assertCursorPersonalIdentity,
  CursorIdentityAuthRequiredError,
  CursorTeamManagedIdentityError,
} from "./cursor-identity.js";
import {
  cursorSandboxPathVariants,
  cursorSandboxPathWithToolchains,
  cursorSandboxSdkRoot,
  cursorSandboxToolchainBinPaths,
  prepareCursorTurnRuntimeDataDir,
  removeCursorTurnRuntimeDataDir,
} from "./cursor-sandbox-policy.js";
import {
  cursorCliEnv,
  defaultLaunchTurn,
  type CursorCliChild,
} from "./cursor-turn-launcher.js";
export {
  assertCursorPersonalIdentity,
  cursorCliEnv,
  CursorIdentityAuthRequiredError,
  CursorTeamManagedIdentityError,
  defaultLaunchTurn,
};
export type { CursorCliChild };

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

function cursorPermissionUsesWorkspaceGeneration(
  permissionProfileId: ProviderSpawnRequest["permissionProfileId"],
): boolean {
  return permissionProfileId === "sandboxed_write" || permissionProfileId === "full_access";
}

function isRoomOnlyRentalAttempt(request: ProviderSpawnRequest): boolean {
  return request.supervisorEntryId?.startsWith("supervised_rental_") === true;
}

type CursorStreamMessage = Record<string, unknown> & {
  type?: unknown;
  subtype?: unknown;
  session_id?: unknown;
  is_error?: unknown;
  result?: unknown;
  request_id?: unknown;
};

export interface CursorProviderAdapterDependencies {
  launchTurn(input: { cursorBin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; deferStart?: boolean; statePath?: string; workspaceGenerationManifestPath?: string; deniedReadPaths?: string[]; deniedReadSubpaths?: string[]; deniedReadMetadataPaths?: string[]; deniedReadWriteRegexes?: string[]; deniedWriteRegexes?: string[]; deniedWritePaths?: string[]; deniedWriteStructuralPaths?: string[]; deniedWriteSubpaths?: string[]; deniedExecSubpaths?: string[]; allowedWriteSubpaths?: string[]; allowedReadSubpaths?: string[]; allowedNetworkUnixSockets?: string[]; allowedInternalUnixSocketRoots?: string[]; mcpConnectorSocketPath?: string; mcpRuntimeEntryPath?: string; mcpRuntimeCwd?: string; mcpRuntimeEnv?: Readonly<Record<string, string>>; providerAuthorization?: string; restrictRemoteAuthority?: boolean; testAgentUpstreamEndpoint?: string; testControlPlaneUpstreamEndpoint?: string; testMcpCapabilityTimeoutMs?: number; testStartupBarrier?: { path: string; stage: "mcp_listen" | "authority_listen" | "agent_listen" } }): CursorCliChild;
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
    /** Prevent room-only rentals from resolving an ancestor Git project. */
    roomOnlyRental?: boolean;
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
    this.cursorBin = options.cursorBin || desktopRuntimeEnvironment().LETAGENTS_CURSOR_AGENT_BIN || "cursor-agent";
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
        roomOnlyRental: input.roomOnlyRental,
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
        roomOnlyRental: isRoomOnlyRentalAttempt(req),
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
    const roomOnlyRental = isRoomOnlyRentalAttempt(handle.spawnRequest);
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
          roomOnlyRental,
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
          roomOnlyRental,
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
          roomOnlyRental,
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
          roomOnlyRental,
          devMcpServerEntryPath: handle.spawnRequest.devMcpServerEntryPath,
          mcpWorkingDirectory: identityProfileRoot,
        });
        throwIfCursorTurnLaunchAborted(launchSignal, roomTurnId);

        // Only after both credentialless probes are removed and live identity
        // is proven do we atomically reseal the stable profile and mint the
        // real MCP child's exact turn capability.
        // Rental attempts already run in a disposable room-only workspace. A
        // Git-backed generation here would either fail for the ordinary
        // non-repository directory or walk up into an unrelated owner repo.
        if (
          roomTurnId
          && cursorPermissionUsesWorkspaceGeneration(handle.spawnRequest.permissionProfileId)
          && !isRoomOnlyRentalAttempt(handle.spawnRequest)
        ) {
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
          roomOnlyRental,
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
      // cursor-agent has no headless per-server MCP approval (Cursor confirms
      // it is unimplemented); --approve-mcps is the ONLY non-interactive way to
      // load an MCP server. Without it the sealed HOME letagents MCP never
      // loads, so complete_room_turn is never exposed and the turn can never
      // attest (its "did not attest ... before model authority" timeout). This
      // is scoped, not blanket: the sealed profile is the sole MCP surface --
      // the HOME profile mcp.json holds only the letagents server, and every
      // workspace .cursor/mcp.json is denied-read by the native sandbox (see
      // SUPERVISED_CURSOR_PROJECT_HIDDEN_AUTHORITY_FILES -> nativeDeniedReadPaths),
      // so a checked-in or concurrently-added project server cannot be read,
      // let alone approved. --approve-mcps therefore approves exactly one MCP.
      ...(handle.deliveryMode === "daemon_inbox" ? ["--approve-mcps"] : []),
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
      // the native sandbox denying every workspace .cursor/mcp.json read keep
      // such a late server unreadable, so --approve-mcps (above) can only ever
      // approve the sealed HOME letagents server.
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
        ? {
          allowedNetworkUnixSockets: [mcpConnectorSocketPath!],
          // Cursor's headless worker binds a private stdio socket under this
          // per-turn data dir; the sandbox must admit that one bind+connect.
          allowedInternalUnixSocketRoots: [supervisedRuntimeDataDir!],
        }
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
