import { MANAGED_ROOM_WORK_INSTRUCTIONS } from "./desktop-event-prompt-format.js";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { claudeToolOperation } from "../../../../../shared/claude-tool-operation.mjs";
import { providerAcquisitionIdentity, retainProviderAcquisitionEvidence } from "../../../../../shared/provider-acquisition-evidence.mjs";
import type { ClaudePermissionObservation, ClaudeNativePermissionRequest, ProviderPermissionDispatchOptions } from "../../../shared/provider-permissions.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { desktopRuntimeEnvironment } from "../desktop-shell-environment.js";

import {
  synthesizeTerminalPayload,
  sameProviderConnectionIdentity,
  type ProviderActivityEvent,
  type ProviderAdapter,
  type ProviderAdapterCapabilities,
  type ProviderAttachTerminal,
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
  ProviderTurnControlError,
  type ProviderTurnControlOptions,
  type ProviderStreamEvent,
  type ProviderStreamEventKind,
  type ProviderTerminalPayload,
  type NativeExecutionObservation,
  type NativeExecutionSubscription,
  type ControlProbeResult,
} from "./provider-adapter.js";
import type { NativeExecutionFact } from "../../../shared/execution-protocol.js";
import {
  nativeExecutionId,
  nativeLifecycleCheckpoint,
  ProviderExecutionObserver,
  type NativeLifecycleCheckpoint,
} from "./provider-execution-observer.js";
import { attestProviderSpawnPolicy } from "./provider-spawn-configuration.js";
import {
  isRentalCredentialIsolationRequested,
  rentalCredentialIsolationMarker,
  rentalIsolatedChildEnvironment,
} from "./rental-child-environment.js";
import {
  ProviderProcessCustody,
  DEFAULT_STOP_GRACE_MS,
  defaultGetProcessIdentity,
  defaultObserveProcessExit,
  defaultSignalProcess,
  delay,
  errorMessage,
  observeFencedExit,
  sameProcessBirthIdentity,
  safeStreamPayload,
  terminateFreshLaunch,
  type ProviderProcessExit,
} from "./provider-evidence.js";
import {
  CLAUDE_NO_ROOM_REPLY_SENTINEL,
  exactClaudeStreamTerminal,
  recoverExactClaudeTurnFromSession,
  type ClaudeEvidenceRecord,
  type ClaudeExactTurnFailure,
  type ClaudeExactTurnResult,
} from "./claude-room-turn-evidence.js";
import { resolveLetAgentsMcpRuntime, type LetAgentsMcpRuntime } from "./letagents-mcp-runtime.js";
import { apiUrl as desktopApiUrl } from "../paths.js";
import { requireSupportedClaudeCodeVersion, resolveClaudeCodeExecutable } from "./claude-code-version.js";

// Claude Code through its native headless CLI. The daemon owns room ingress,
// exact-turn dispatch, retry, credentials, and publication; this adapter owns
// only the native process/session boundary. The Add Agent launch policy is
// forwarded verbatim, while LetAgents MCP effects borrow the daemon's exact
// generation grant instead of inheriting desktop owner authority.

const INIT_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 8_000;

/** One parsed stream-json line from the CLI. */
type ClaudeStreamMessage = Record<string, unknown> & { type?: unknown; subtype?: unknown };

export interface ClaudeCliChild {
  pid: number | null;
  exited: Promise<ProviderProcessExit>;
  /** Output volume only; native stderr contents never leave the child owner. */
  stderrBytesRead?(): number;
  /** Positive native spawn failure before any child process was acquired. */
  didNotSpawn?(): boolean;
  /** Ordered stdout stream-json lines (raw, one JSON document per line). */
  onLine(listener: (line: string) => void): () => void;
  /** Control-channel loss (stdout closed while the child was not stopped by us). */
  onDisconnect(listener: () => void): () => void;
  /** Write one stream-json input line (a user message) to the CLI's stdin. */
  writeLine(json: string): void;
  /** Close stdin; in --input-format stream-json mode the CLI finishes and exits. */
  endInput(): void;
  /** Mark teardown as intentional so the stdio close does not read as control loss. */
  markIntentionalClose(): void;
}

export interface ClaudeCodeProviderAdapterDependencies {
  readVersion(claudeBin: string): Promise<string>;
  launchChild(input: { claudeBin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }): ClaudeCliChild;
  createLetAgentsMcpConfig(req: ProviderSpawnRequest): Promise<{ path: string; dispose(): Promise<void> }>;
  signalProcess(pid: number, signal: NodeJS.Signals): void;
  /** null means verified absent; undefined means liveness could not be verified. */
  getProcessIdentity(pid: number): string | null | undefined;
  observeProcessExit(pid: number, processIdentity: string): Promise<ProviderProcessExit>;
  readSessionRows(sessionId: string): Promise<ClaudeEvidenceRecord[]>;
  now(): string;
}

export interface ClaudeCodeProviderAdapterOptions {
  claudeBin?: string;
  dependencies?: Partial<ClaudeCodeProviderAdapterDependencies>;
  activitySink?: (event: ProviderActivityEvent) => void;
  streamSink?: (event: ProviderStreamEvent) => void;
  /** Startup-only bound on waiting for the stream-json init message. */
  initTimeoutMs?: number;
  /** SIGTERM → SIGKILL escalation window for stop() and the attach-path fence. */
  stopGraceMs?: number;
}

const BASE_CLAUDE_CAPABILITIES: ProviderAdapterCapabilities = {
  execution: {
    controlProbe: "unsupported",
    approvals: { kinds: ["command"], recovery: "native_instance_only", denyScope: "request" },
  },
  deliveryModes: ["daemon_inbox"],
  // Empirically proven by the task_36 acceptance spike (msg_1382): `--resume
  // <session_id>` continues the SAME session id. The adapter asserts that
  // identity on every resume and the regression suite pins it.
  resume: true,
  // The spike also settled this cell: ordinary stream-json input is QUEUED to
  // the next turn boundary, and the real mid-turn primitive is
  // `control_request/subtype=interrupt` whose success is only proven by the
  // subsequent interrupted result. That is an interrupt control, not message
  // delivery, so the reconciler's poke rung stays off.
  midTurnInjection: false,
  // Claude Code has no native interrupt+resume; corrections use stop-then-resend.
  midTurnCorrection: false,
  // The live stream-json stdout IS the transcript stream; every message is
  // published as bounded/redacted stream evidence.
  transcriptAccess: true,
  permissionPromptBridging: true,
  // stdio dies with the supervising process: a daemon restart can fence the
  // orphan and resume the continuation, but in-context state since the last
  // message is not a survivable live session. Bounded recovery, not survival.
  survivesRestart: false,
  turnControl: "native_interrupt",
};

// Reserved flags the adapter owns. Everything else in the launch policy is the
// user's native CLI configuration and is forwarded verbatim (no reinterpretation,
// no LetAgents permission semantics — v10 §3/§4.8).
const RESERVED_POLICY_KEYS = new Set([
  "print",
  "inputFormat",
  "input-format",
  "outputFormat",
  "output-format",
  "resume",
  "continue",
  "cwd",
  "verbose",
  // The adapter mints/asserts the session identity (msg_1382 spike).
  "sessionId",
  "session-id",
  // Session persistence is what makes bounded --resume recovery possible;
  // a policy must not silently disable the continuation.
  "noSessionPersistence",
  "no-session-persistence",
  // The managed workplace is injected explicitly so project-level .mcp.json
  // files cannot shadow it or exfiltrate its worker credential.
  "mcpConfig",
  "mcp-config",
  "strictMcpConfig",
  "strict-mcp-config",
  "permissionPromptTool",
  "permission-prompt-tool",
]);

function camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * Mechanically render the opaque Add Agent launch policy as CLI flags:
 * `{ permissionMode: "acceptEdits" }` → `--permission-mode acceptEdits`.
 * Purely syntactic — values are never mapped, renamed, or filtered beyond the
 * adapter-owned reserved flags above.
 */
export function claudeLaunchPolicyArgs(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Claude launchPolicy must be the native CLI options object.");
  }
  const policy = value as Record<string, unknown>;
  const args: string[] = [];
  for (const [key, entry] of Object.entries(policy)) {
    if (RESERVED_POLICY_KEYS.has(key)) {
      throw new Error(`Claude launchPolicy cannot override reserved flag '${key}'.`);
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
      throw new Error(`Claude launchPolicy value for '${key}' must be a scalar, boolean, or string array.`);
    }
  }
  return args;
}

function claudeStreamKind(message: ClaudeStreamMessage): ProviderStreamEventKind {
  const type = typeof message.type === "string" ? message.type : "";
  if (type === "assistant") return "text_delta";
  if (type === "user") return "tool_lifecycle";
  if (type === "tool_use_summary") return "tool_lifecycle";
  if (type === "result") return isClaudeFailedResult(message) && !isClaudeTurnLimitResult(message)
    ? "error" : "turn_lifecycle";
  if (type === "system") return "provider_event";
  if (/error/i.test(type)) return "error";
  return "provider_event";
}

function isClaudeFailedResult(message: ClaudeStreamMessage): boolean {
  if (message.type !== "result") return false;
  if ((message as { is_error?: unknown }).is_error === true) return true;
  return typeof message.subtype === "string" && /(?:error|failed)/i.test(message.subtype);
}

function isClaudeTurnLimitResult(message: ClaudeStreamMessage): boolean {
  // These documented limits end one command, not the CLI session. Unknown
  // failures retain the legacy recovery path until typed lifecycle rollout.
  return message.type === "result" && typeof message.subtype === "string"
    && /^(?:error_max_turns|error_max_budget_usd|error_max_structured_output_retries)$/.test(message.subtype);
}

function streamMethod(message: ClaudeStreamMessage): string {
  const type = typeof message.type === "string" ? message.type : "unknown";
  const subtype = typeof message.subtype === "string" ? message.subtype : null;
  return subtype ? `${type}/${subtype}` : type;
}

function sessionIdOf(message: ClaudeStreamMessage): string | null {
  const value = (message as { session_id?: unknown }).session_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function claudeTerminalDiscriminator(message: ClaudeStreamMessage): string {
  const subtype = typeof message.subtype === "string" && message.subtype.trim()
    ? message.subtype.trim().toLowerCase()
    : "unknown";
  const errorState = message.is_error === true ? "error"
    : message.is_error === false ? "ok" : "unknown";
  return `${subtype}:${errorState}`;
}

function hasReadyRoomWorkplace(message: ClaudeStreamMessage): boolean {
  if (!Array.isArray(message.mcp_servers) || !Array.isArray(message.tools)) return false;
  const connected = message.mcp_servers.some(row => row && typeof row === "object"
    && row.name === "letagents" && row.status === "connected");
  return connected && ["get_board", "read_messages", "send_message"].every(name =>
    (message.tools as unknown[]).includes(`mcp__letagents__${name}`));
}

function assistantTextOf(message: ClaudeStreamMessage): string | null {
  const content = ((message as { message?: { content?: unknown } }).message ?? {}).content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || null;
}

function userStreamJsonLine(text: string, uuid?: string): string {
  return JSON.stringify({
    type: "user",
    ...(uuid ? { uuid } : {}),
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

export function boundedClaudeRoomTurnPrompt(request: ProviderRoomTurnRequest): string {
  return [
    ...MANAGED_ROOM_WORK_INSTRUCTIONS,
    "You may use the discovered LetAgents product tools for room context, tasks, artifacts, status, deliberate side messages, or moving to another room. Those actions are daemon-mediated.",
    "Answer the activating message in your final response; do not send that same reply with a message tool.",
    `If no response should be published, return exactly ${CLAUDE_NO_ROOM_REPLY_SENTINEL} with no other text.`,
    `Inbox item: ${request.inboxItemId}`,
    `Recent bounded room context: ${JSON.stringify(request.observedContext ?? [])}`,
    `Source message: ${JSON.stringify(request.sourceMessage)}`,
    `Activation: ${JSON.stringify(request.activation)}`,
  ].join("\n");
}

const CLAUDE_DAEMON_BOOTSTRAP_PROMPT = [
  "Initialize this supervised Claude Code continuation.",
  "Do not call tools, inspect the room, or perform work.",
  "Reply exactly LETAGENTS_CLAUDE_DAEMON_READY.",
].join("\n");

type ClaudeRoomTurnTerminal = ClaudeExactTurnResult | ClaudeExactTurnFailure;

const CLAUDE_API_ERROR_CATEGORIES = new Set([
  "authentication_failed", "oauth_org_not_allowed", "billing_error", "rate_limit",
  "overloaded", "invalid_request", "model_not_found", "server_error", "unknown", "max_output_tokens",
]);
const CLAUDE_RESULT_CATEGORIES = new Set([
  "success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries",
]);
const CLAUDE_STARTUP_SYSTEM_TYPES = new Set([
  "init", "api_retry", "compact_boundary", "control_request_progress", "hook_started", "hook_progress",
  "commands_changed", "background_tasks_changed", "files_persisted", "elicitation_complete", "informational",
  "local_command_output", "memory_recall", "mirror_error", "model_refusal_fallback", "model_refusal_no_fallback",
  "notification", "permission_denied", "plugin_install", "task_notification", "task_progress", "task_started",
  "task_updated", "thinking_tokens", "worker_shutting_down",
]);
const CLAUDE_STARTUP_LINE_TYPES = new Set([
  "assistant", "result", "user", "auth_status", "stream_event", "tool_progress", "tool_use_summary",
  "control_request", "control_cancel_request",
]);

function claudeStartupLineType(message: ClaudeStreamMessage): string {
  // Values outside these finite enums never enter the diagnostic, including
  // unknown keys/subtypes, hook output, tool names, IDs and native error text.
  if (message.type === "command_lifecycle") {
    return `command_lifecycle.${message.state === "started" ? "started" : "unlisted"}`;
  }
  if (message.type !== "system") {
    return typeof message.type === "string" && CLAUDE_STARTUP_LINE_TYPES.has(message.type) ? message.type : "unlisted";
  }
  if (message.subtype === "status") {
    const status = message.status === null ? "cleared"
      : message.status === "compacting" || message.status === "requesting" ? message.status : "unlisted";
    const compact = message.compact_result === undefined ? ""
      : message.compact_result === "success" || message.compact_result === "failed"
        ? `.compact_${message.compact_result}` : ".compact_unlisted";
    return `system.status.${status}${compact}`;
  }
  if (message.subtype === "hook_response") {
    const outcome = message.outcome === "success" || message.outcome === "error" || message.outcome === "cancelled"
      ? message.outcome : "unlisted";
    return `system.hook_response.${outcome}`;
  }
  if (message.subtype === "session_state_changed") {
    const state = message.state === "idle" || message.state === "running" || message.state === "requires_action"
      ? message.state : "unlisted";
    return `system.session_state_changed.${state}`;
  }
  return typeof message.subtype === "string" && CLAUDE_STARTUP_SYSTEM_TYPES.has(message.subtype)
    ? `system.${message.subtype}` : "system.unlisted";
}

/** Bounded observations from this child's startup, never an inferred root cause. */
class ClaudeBootstrapDiagnostics {
  private readonly startedAt = performance.now();
  private initializedAt: number | null = null;
  private stdoutLines = 0;
  private matchedSessionLines = 0;
  private apiRetries = 0;
  private assistantMessages = 0;
  private resultMessages = 0;
  private authMessages = 0;
  private authenticating: boolean | null = null;
  private lastApiRetry: string | null = null;
  private assistantError: string | null = null;
  private result: string | null = null;
  private uncorrelatedResult: string | null = null;
  private readonly lineTypes = new Map<string, number>();
  private lastLineType: string | null = null;
  private lastLineMs = 0;

  constructor(private readonly sessionId: string, private readonly turnId: string, private readonly budgetMs: number) {}

  initialized(): void { this.initializedAt = performance.now(); }

  observe(line: string): void {
    this.stdoutLines = Math.min(Number.MAX_SAFE_INTEGER, this.stdoutLines + 1);
    const message = parseStreamLine(line);
    if (!message || message.session_id !== this.sessionId) return;
    this.matchedSessionLines = Math.min(Number.MAX_SAFE_INTEGER, this.matchedSessionLines + 1);
    const lineType = claudeStartupLineType(message);
    this.lineTypes.set(lineType, Math.min(Number.MAX_SAFE_INTEGER, (this.lineTypes.get(lineType) ?? 0) + 1));
    this.lastLineType = lineType;
    // Subscription/diagnostics start is the origin, including pre-init lines.
    this.lastLineMs = Math.max(0, Math.round(performance.now() - this.startedAt));
    // Never include arbitrary error strings, keys, subtypes, IDs or message text.
    const category = typeof message.error === "string" && CLAUDE_API_ERROR_CATEGORIES.has(message.error)
      ? message.error : "unlisted";
    if (message.type === "system" && message.subtype === "api_retry") {
      this.apiRetries = Math.min(Number.MAX_SAFE_INTEGER, this.apiRetries + 1);
      const status = message.error_status === null ? "none"
        : typeof message.error_status === "number" && Number.isInteger(message.error_status)
          && message.error_status >= 100 && message.error_status <= 599 ? message.error_status : "unlisted";
      this.lastApiRetry = `${category} (HTTP ${status})`;
    } else if (message.type === "assistant") {
      this.assistantMessages = Math.min(Number.MAX_SAFE_INTEGER, this.assistantMessages + 1);
      if (message.error !== undefined) this.assistantError = category;
    } else if (message.type === "result") {
      this.resultMessages = Math.min(Number.MAX_SAFE_INTEGER, this.resultMessages + 1);
      const subtype = typeof message.subtype === "string" && CLAUDE_RESULT_CATEGORIES.has(message.subtype)
        ? message.subtype : "unlisted";
      if (message.user_message_uuid === this.turnId) {
        this.result = subtype;
      } else this.uncorrelatedResult = subtype;
    } else if (message.type === "auth_status") {
      this.authMessages = Math.min(Number.MAX_SAFE_INTEGER, this.authMessages + 1);
      this.authenticating = typeof message.isAuthenticating === "boolean" ? message.isAuthenticating : null;
    }
  }

  summary(child: ClaudeCliChild): string {
    const failedAt = performance.now();
    const elapsed = (start: number, end: number) => Math.max(0, Math.round(end - start));
    let stderrBytes: number | null = null;
    try {
      const count = child.stderrBytesRead?.();
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) stderrBytes = count;
    } catch { /* An unavailable diagnostic must not replace the launch failure. */ }
    const lineTypes: string[] = [];
    for (const [type, count] of this.lineTypes) {
      const item = `${type}:${count}`;
      if (lineTypes.length === 8 || [...lineTypes, item].join(",").length > 180) break;
      lineTypes.push(item);
    }
    // Keep the histogram and its omission count in one field so the outer
    // 512-character cap cannot retain a partial histogram without its marker.
    const omittedTypes = this.lineTypes.size - lineTypes.length;
    if (omittedTypes) lineTypes.push(`omitted_types:${omittedTypes}`);
    const fields = [
      ...(this.lastApiRetry === null ? [] : [`last_api_retry=${this.lastApiRetry}`]),
      ...(this.assistantError === null ? [] : [`assistant_error=${this.assistantError}`]),
      ...(this.result === null ? [] : [`result=${this.result}`]),
      ...(this.uncorrelatedResult === null ? [] : [`uncorrelated_result=${this.uncorrelatedResult}`]),
      ...(this.authMessages === 0 ? [] : [`auth_status_count=${this.authMessages}`, `authenticating=${this.authenticating ?? "unlisted"}`]),
      ...(this.lastLineType === null ? [] : [`last_line_type=${this.lastLineType}`, `last_line_ms=${this.lastLineMs}`]),
      `init_ms=${elapsed(this.startedAt, this.initializedAt ?? failedAt)}`,
      `bootstrap_ms=${this.initializedAt === null ? "not_started" : elapsed(this.initializedAt, failedAt)}`,
      `budget_ms=${this.budgetMs}`, `stdout_lines=${this.stdoutLines}`, `matched_session_lines=${this.matchedSessionLines}`,
      `stderr_bytes=${stderrBytes ?? "unavailable"}`,
      `api_retry_count=${this.apiRetries}`, `assistant_count=${this.assistantMessages}`, `result_count=${this.resultMessages}`,
      ...(lineTypes.length ? [`line_types=${lineTypes.join(",")}`] : []),
    ];
    let omitted = 0;
    for (;;) {
      const summary = `Startup observations: ${fields.join("; ")}${omitted ? `; omitted_fields=${omitted}` : ""}.`;
      if (summary.length <= 512) return summary;
      fields.pop();
      omitted += 1;
    }
  }
}

class ClaudeBootstrapError extends Error {
  readonly name = "ClaudeBootstrapError";
  readonly reason: "deadline" | "native_exit" | "transport_error" | "failed_response";
  readonly exitCode?: number | null;
  readonly signal?: string | null;

  constructor(
    readonly phase: "init" | "bootstrap_turn",
    failure: ProviderProcessExit | { type: "deadline" | "failed_response" },
    observations: string,
  ) {
    const reason = failure.type === "exit" ? "native_exit"
      : failure.type === "error" ? "transport_error" : failure.type;
    const prefix = phase === "init" ? "Claude CLI did not report its stream-json init message"
      : "Claude CLI did not complete its daemon-safe bootstrap turn";
    // Preserve the observed boundary without copying native error/result text
    // into supervisor diagnostics. Transport loss is not a physical death proof.
    super(`${prefix} (${reason}${failure.type === "exit" ? `; exit code ${failure.code ?? "unknown"}; signal ${failure.signal ?? "none"}` : ""}). ${observations}`);
    this.reason = reason;
    if (failure.type === "exit") {
      this.exitCode = failure.code;
      this.signal = failure.signal;
    }
  }
}

class ClaudeRoomTurnRecoveryError extends Error {
  readonly roomTurnRecoveryOutcome = "ambiguous" as const;
}

class ClaudeRoomTurnObservationDetachedError extends Error {}

/**
 * The child's environment is the user's own, minus exactly one carve-out the
 * task_36 acceptance spike proved necessary (msg_1382): the CLI refuses to
 * start when CLAUDECODE is set ("cannot be launched inside another Claude Code
 * session"), so a supervisor that itself runs under Claude Code must not leak
 * that marker into the worker. Daemon-owned turns borrow exact-generation
 * authority, so ambient owner and fixed worker credentials are also removed
 * before Claude or provider-started shell commands can inherit them.
 */
export function claudeCliEnv(base: NodeJS.ProcessEnv = desktopRuntimeEnvironment(), overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const combined = { ...base, ...overrides };
  if (isRentalCredentialIsolationRequested(combined)) return rentalIsolatedChildEnvironment(combined);
  const {
    CLAUDECODE: _omitted,
    LETAGENTS_TOKEN: _ownerToken,
    LETAGENTS_AGENT_SESSION_BEARER: _fixedWorkerBearer,
    ...env
  } = combined;
  return env;
}

function defaultReadVersion(claudeBin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      claudeBin,
      ["--version"],
      { timeout: VERSION_TIMEOUT_MS, env: claudeCliEnv() },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Claude Code could not be checked: ${errorMessage(error)}`));
          return;
        }
        resolve(String(stdout || stderr || ""));
      },
    );
    child.stdin?.end();
  });
}

function defaultLaunchChild(input: { claudeBin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }): ClaudeCliChild {
  const child = spawn(input.claudeBin, input.args, {
    cwd: input.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group: group-signalling (shared defaultSignalProcess
    // targets -pid first) reaps the CLI's descendants too, and the child is not
    // torn down as a side effect of the supervisor's own stdio going away.
    detached: process.platform !== "win32",
    // The strict launch config supplies the API endpoint; these coordinates
    // make every LetAgents MCP effect borrow the exact daemon generation.
    env: claudeCliEnv(desktopRuntimeEnvironment(), input.env),
  });

  const lineListeners = new Set<(line: string) => void>();
  const disconnectListeners = new Set<() => void>();
  let intentionalClose = false;
  let exitedSettled = false;
  let disconnectNotified = false;
  let stderrBytes = 0;

  const notifyDisconnect = () => {
    if (intentionalClose || exitedSettled || disconnectNotified) return;
    disconnectNotified = true;
    for (const listener of disconnectListeners) listener();
    disconnectListeners.clear();
  };

  let spawned = false;
  let sawPid = child.pid !== undefined;
  let failedToSpawn = false;
  child.once("spawn", () => { spawned = true; sawPid ||= child.pid !== undefined; });
  const exited = new Promise<ProviderProcessExit>((resolve) => {
    child.once("error", (error) => {
      sawPid ||= child.pid !== undefined;
      failedToSpawn = !spawned && !sawPid;
      exitedSettled = true;
      resolve({ type: "error", error });
    });
    child.once("exit", (code, signal) => {
      exitedSettled = true;
      resolve({ type: "exit", code, signal });
    });
  });

  if (child.stdout) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      for (const listener of lineListeners) listener(line);
    });
    child.stdout.once("close", () => {
      // Give a simultaneous exit event one macrotask to win: a real exit is
      // authoritative evidence and must not be reported as mere control loss.
      setTimeout(notifyDisconnect, 50).unref?.();
    });
  }
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + chunk.byteLength);
  });

  return {
    pid: child.pid ?? null,
    exited,
    stderrBytesRead: () => stderrBytes,
    didNotSpawn: () => failedToSpawn && child.pid === undefined,
    onLine(listener) {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onDisconnect(listener) {
      if (disconnectNotified) {
        queueMicrotask(listener);
        return () => {};
      }
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
    writeLine(json) {
      if (!child.stdin || !child.stdin.writable || child.stdin.writableEnded || child.stdin.destroyed) {
        throw new Error("Claude CLI stdin is unavailable.");
      }
      child.stdin.write(`${json}\n`);
    },
    endInput() {
      try {
        child.stdin?.end();
      } catch {
        // The pipe may already be gone; the exit observation stays authoritative.
      }
    },
    markIntentionalClose() {
      intentionalClose = true;
    },
  };
}

export async function createEphemeralClaudeMcpConfig(
  mcpEnv: Record<string, string>,
  runtime: LetAgentsMcpRuntime,
  temporaryRoot = tmpdir(),
): Promise<{ path: string; dispose(): Promise<void> }> {
  const directory = await mkdtemp(join(temporaryRoot, "letagents-claude-mcp-"));
  const configPath = join(directory, "mcp.json");
  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      letagents: {
        command: process.execPath,
        args: [runtime.entryPath],
        env: { ...mcpEnv, ELECTRON_RUN_AS_NODE: "1" },
      },
    },
  }), { encoding: "utf8", mode: 0o600 });
  let disposed = false;
  return {
    path: configPath,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function createManagedClaudeMcpConfig(
  apiBaseUrl = desktopApiUrl,
  temporaryRoot = tmpdir(),
  devEntryPath?: string,
  resolveRuntime: (devEntryPath?: string) => LetAgentsMcpRuntime = entry =>
    resolveLetAgentsMcpRuntime({ devEntryPath: entry, env: desktopRuntimeEnvironment() }),
): Promise<{ path: string; dispose(): Promise<void> }> {
  const normalizedApiUrl = apiBaseUrl.trim();
  if (!normalizedApiUrl) {
    throw new Error("Claude's managed LetAgents endpoint is unavailable.");
  }
  return createEphemeralClaudeMcpConfig(
    { LETAGENTS_API_URL: normalizedApiUrl },
    resolveRuntime(devEntryPath),
    temporaryRoot,
  );
}

export function claudeSessionTranscriptCandidates(entries: string[], sessionId: string): string[] {
  const suffix = `${sessionId}.jsonl`;
  return entries.filter((entry) => entry.split(/[\\/]/).at(-1) === suffix);
}

async function defaultReadSessionRows(sessionId: string): Promise<ClaudeEvidenceRecord[]> {
  const projectsRoot = join(homedir(), ".claude", "projects");
  let entries: string[];
  try {
    entries = await readdir(projectsRoot, { recursive: true });
  } catch {
    return [];
  }
  const matches = claudeSessionTranscriptCandidates(entries, sessionId);
  if (matches.length > 1) {
    throw new ClaudeRoomTurnRecoveryError(
      "Claude room-turn recovery found more than one transcript for the exact continuation.",
    );
  }
  if (!matches[0]) return [];
  const text = await readFile(join(projectsRoot, matches[0]), "utf8");
  return text.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return [];
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? [parsed as ClaudeEvidenceRecord]
        : [];
    } catch {
      return [];
    }
  });
}

const DEFAULT_DEPENDENCIES: ClaudeCodeProviderAdapterDependencies = {
  readVersion: defaultReadVersion,
  launchChild: defaultLaunchChild,
  createLetAgentsMcpConfig: req => createManagedClaudeMcpConfig(
    req.supervisorWorkerSession?.apiUrl ?? desktopApiUrl, tmpdir(), req.devMcpServerEntryPath,
  ),
  signalProcess: defaultSignalProcess,
  getProcessIdentity: defaultGetProcessIdentity,
  observeProcessExit: defaultObserveProcessExit,
  readSessionRows: defaultReadSessionRows,
  now: () => new Date().toISOString(),
};

class ClaudeProviderHandle implements ProviderHandle {
  state: ProviderObservedState = "starting";
  stopRequested = false;
  protocolError = false;
  terminal: ProviderTerminalPayload | null = null;
  readonly exitListeners = new Set<(payload: ProviderTerminalPayload) => void>();
  readonly activityListeners = new Set<(event: ProviderActivityEvent) => void>();
  readonly streamListeners = new Set<(event: ProviderStreamEvent) => void>();
  streamSequence = 0;
  readonly turnResultWaiters = new Set<(message: ClaudeStreamMessage) => void>();
  readonly roomTurnWaiters = new Map<string, Set<{
    resolve: (result: ClaudeRoomTurnTerminal) => void;
    reject: (error: Error) => void;
  }>>();
  readonly roomTurnResults = new Map<string, ClaudeRoomTurnTerminal>();
  activeRoomTurnId: string | null = null;
  roomTurnOperationId: string | null = null;
  pendingInterruptTurnId: string | null = null;
  contextualInterruptTerminalTurnId: string | null = null;
  readonly contextualInterruptResults = new WeakSet<ClaudeStreamMessage>();
  readonly execution: ProviderExecutionObserver;
  executionTurnId: string | null = null;
  executionTurnStarted = false;
  executionTerminalCheckpoint: {
    providerTurnId: string; terminalDiscriminator: string; nativeLifecycle: NativeLifecycleCheckpoint;
  } | null = null;
  readonly executionTools = new Map<string, { operation: Extract<NativeExecutionFact, { domain: "execution" }>["operation"]; completed: boolean; name: string; input: unknown }>();
  executionExitObserved = false;
  permissionControlAvailable = true;
  readonly seenPermissionRequestIds = new Set<string>();
  readonly permissionRequests = new Map<string, { native: ClaudeNativePermissionRequest; turnId: string; dispatching: boolean }>();
  readonly permissionListeners = new Set<() => void>();
  // Sent prompts still need a request-closure receipt when their tool completes.
  readonly permissionClosures = new Map<string, { native: ClaudeNativePermissionRequest; turnId: string }>();
  readonly permissionClosureListeners = new Set<(event: Extract<ClaudePermissionObservation, { type: "request_closed" }>) => void>();

  permissionsChanged(): void {
    for (const listener of this.permissionListeners) { try { listener(); } catch { /* Observers cannot control the CLI. */ } }
  }

  clearPermissions(): void {
    this.permissionRequests.clear();
    this.permissionClosures.clear();
    this.permissionsChanged();
  }

  constructor(
    readonly workAttemptId: string,
    readonly pid: number | null,
    readonly providerContinuationId: string,
    readonly lifecycleAuthorityMode: "legacy" | "typed_shadow" | "typed",
    readonly providerConnection: ProviderConnectionRef,
    readonly child: ClaudeCliChild,
    readonly exitEvidence: Promise<ProviderProcessExit>,
    now: () => string,
  ) {
    this.execution = new ProviderExecutionObserver(now);
    child.onDisconnect(() => {
      this.permissionControlAvailable = false;
      this.clearPermissions();
      if (this.executionExitObserved) return;
      this.execution.emit(
        { domain: "control", kind: "state_changed", state: "degraded", sideEffects: "none" },
        providerConnection.kind === "claude_cli" ? providerConnection.processIdentity ?? undefined : undefined,
        providerConnection.kind === "claude_cli" ? providerConnection.pid ?? undefined : undefined,
      );
    });
  }

  observedState(): ProviderObservedState {
    return this.state;
  }
}

export class ClaudeCodeProviderAdapter implements ProviderAdapter {
  readonly id = "claude-code" as const;
  private readonly claudeBin: string;
  private readonly deps: ClaudeCodeProviderAdapterDependencies;
  private readonly activitySink?: (event: ProviderActivityEvent) => void;
  private readonly streamSink?: (event: ProviderStreamEvent) => void;
  private readonly initTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly handles = new Map<string, ClaudeProviderHandle>();
  private readonly processCustody: ProviderProcessCustody;
  private readonly pendingAttaches = new Map<string, {
    ref: ProviderContinuationRef;
    promise: Promise<ProviderHandle | ProviderAttachTerminal | null>;
  }>();
  private readonly exitPromises = new WeakMap<ClaudeProviderHandle, Promise<ProviderTerminalPayload>>();

  constructor(options: ClaudeCodeProviderAdapterOptions = {}) {
    this.claudeBin = options.claudeBin || resolveClaudeCodeExecutable(desktopRuntimeEnvironment());
    this.deps = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
    this.processCustody = new ProviderProcessCustody(this.deps);
    this.activitySink = options.activitySink;
    this.streamSink = options.streamSink;
    this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }

  runtimeCustody(workAttemptId: string, providerHandle?: ProviderHandle): "absent" | "owned" | "unknown" {
    const handle = this.handles.get(workAttemptId);
    return this.processCustody.state(workAttemptId, handle === providerHandle ? handle?.child : undefined);
  }

  capabilities(): ProviderAdapterCapabilities {
    return { ...BASE_CLAUDE_CAPABILITIES };
  }

  async spawn(req: ProviderSpawnRequest): Promise<ProviderHandle> {
    return this.start(req, null);
  }

  async resume(
    ref: ProviderContinuationRef,
    req: ProviderSpawnRequest,
  ): Promise<ProviderHandle> {
    if (ref.workAttemptId !== req.workAttemptId) {
      throw new Error("Claude resume ref must belong to the same work attempt.");
    }
    return this.start(req, ref);
  }

  /**
   * A CLI child has no reconnectable control channel: its stdio died with the
   * supervisor that spawned it. So attach can never return a live handle for a
   * fresh adapter — it either proves the recorded child absent (null), or, when
   * the exact birth identity is verifiably still running, FENCES it per the
   * msg_1188 invariant (TERM → grace → identity recheck → KILL → await
   * identity disappearance) and then reports absent, so the reconciler proceeds
   * to bounded recovery without ever risking a second writer. Unverifiable
   * state throws ambiguous and blocks replacement.
   */
  async attach(ref: ProviderContinuationRef): Promise<ProviderHandle | ProviderAttachTerminal | null> {
    const handle = this.handles.get(ref.workAttemptId);
    const authorityMode = ref.lifecycleAuthorityMode ?? "typed_shadow";
    if (handle && !handle.terminal
      && handle.providerContinuationId === ref.providerContinuationId
      && handle.lifecycleAuthorityMode === authorityMode
      && sameProviderConnectionIdentity(handle.providerConnection, ref.providerConnection)) {
      return handle;
    }
    if (handle) return null;
    const connection = ref.providerConnection;
    if (!connection || connection.kind !== "claude_cli") return null;

    const pending = this.pendingAttaches.get(ref.workAttemptId);
    if (pending) {
      if (pending.ref.providerContinuationId !== ref.providerContinuationId
        || (pending.ref.lifecycleAuthorityMode ?? "typed_shadow") !== authorityMode
        || !sameProviderConnectionIdentity(pending.ref.providerConnection, connection)) return null;
      return pending.promise;
    }
    const attaching = this.fenceRecordedChild(connection, ref.providerContinuationId).finally(() => {
      if (this.pendingAttaches.get(ref.workAttemptId)?.promise === attaching) {
        this.pendingAttaches.delete(ref.workAttemptId);
      }
    });
    this.pendingAttaches.set(ref.workAttemptId, { ref, promise: attaching });
    return attaching;
  }

  async poke(_handle: ProviderHandle, _message: string): Promise<void> {
    throw new Error(
      "Claude mid-turn message injection is not supported; only native interruption is available.",
    );
  }

  async controlTurn(
    providerHandle: ProviderHandle,
    correction?: string | null,
    options: ProviderTurnControlOptions = {},
  ): Promise<ProviderTurnControlResult> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) throw new Error("Claude continuation is terminal; no turn can be controlled.");
    const text = correction?.trim() || null;
    if (text) {
      throw new ProviderTurnControlError(
        "Claude daemon-inbox turn control can stop the active bounded turn, but cannot start an unjournaled correction turn.",
        "not_applied",
      );
    }
    const expectedTurnId = options.targetTurnId?.trim() || null;
    const activeTurnId = handle.activeRoomTurnId;
    if (expectedTurnId && activeTurnId !== expectedTurnId) {
      // The checkpointed A is no longer active. B, if present, is outside the
      // old action's authority and must never be interrupted by its retry.
      return {
        capability: "native_interrupt",
        interrupted: false,
        resumed: false,
        state: activeTurnId ? "working" : "idle",
      };
    }
    const active = Boolean(activeTurnId);
    if (active) {
      const resultBoundary = this.waitForNextTurnResult(handle);
      await options.checkpointTurnStarted?.(activeTurnId!);
      await options.markDispatched?.();
      if (handle.activeRoomTurnId !== activeTurnId) {
        const result = await resultBoundary;
        throw new ProviderTurnControlError(
          `Claude returned ${streamMethod(result)} before the interrupt was dispatched.`,
          "not_applied",
        );
      }
      handle.pendingInterruptTurnId = activeTurnId!;
      try {
        handle.child.writeLine(JSON.stringify({
          type: "control_request",
          request_id: randomUUID(),
          request: { subtype: "interrupt" },
        }));
      } catch (error) {
        if (handle.pendingInterruptTurnId === activeTurnId) handle.pendingInterruptTurnId = null;
        throw error;
      }
      // A control_response acknowledgement is intentionally insufficient. The
      // subsequent result event is the only proof that the queued/live turn
      // actually reached an interrupted boundary.
      const result = await resultBoundary;
      const subtype = typeof result.subtype === "string" ? result.subtype.toLowerCase() : "";
      const resultTurnId = typeof result.user_message_uuid === "string"
        ? result.user_message_uuid.trim()
        : "";
      const contextualInterrupt = handle.contextualInterruptResults.has(result);
      if (
        !contextualInterrupt
        && (subtype !== "interrupted"
          || sessionIdOf(result) !== handle.providerContinuationId
          || resultTurnId !== activeTurnId)
      ) {
        const exactTargetTerminal = sessionIdOf(result) === handle.providerContinuationId
          && resultTurnId === activeTurnId
          && Boolean(exactClaudeStreamTerminal(result, activeTurnId!, handle.providerContinuationId));
        throw new ProviderTurnControlError(
          `Claude returned ${streamMethod(result)} instead of an exact-session interrupted boundary.`,
          exactTargetTerminal ? "not_applied" : "uncertain",
        );
      }
      handle.state = "idle";
    }
    return {
      capability: "native_interrupt",
      interrupted: active,
      resumed: false,
      state: "idle",
    };
  }

  async runRoomTurn(
    providerHandle: ProviderHandle,
    request: ProviderRoomTurnRequest,
    options: ProviderRoomTurnOptions = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) throw new Error("Claude continuation is terminal; no bounded room turn can run.");
    if (handle.state === "failed") throw new Error("Claude continuation has failed; no bounded room turn can run.");
    if (handle.roomTurnOperationId || handle.activeRoomTurnId) {
      throw new Error("Claude continuation already has a bounded room turn in progress.");
    }
    if (!request.inboxItemId.trim() || !request.actionId.trim()) {
      throw new Error("Bounded Claude room turn requires durable inbox and action ids.");
    }

    const turnId = randomUUID();
    handle.roomTurnOperationId = turnId;
    handle.contextualInterruptTerminalTurnId = null;
    let terminalPromise: Promise<ClaudeRoomTurnTerminal> | null = null;
    try {
      await options.beforeNativeDispatch?.();
      // Claude accepts a caller-supplied UUID, so durability can record the
      // exact native identity before the stdin write that starts the turn.
      await options.checkpointTurnStarted?.(turnId);
      terminalPromise = this.waitForExactRoomTurn(handle, turnId, options.detachSignal);
      handle.activeRoomTurnId = turnId;
      if (handle.lifecycleAuthorityMode !== "typed") handle.state = "working";
      handle.executionTurnId = turnId;
      handle.executionTurnStarted = false;
      handle.executionTerminalCheckpoint = null;
      handle.executionTools.clear();
      try {
        handle.child.writeLine(userStreamJsonLine(boundedClaudeRoomTurnPrompt(request), turnId));
      } catch (error) {
        // The exact id is durable, but the native write did not occur. Release
        // the local waiter and fail this continuation so recovery/reconcile can
        // proceed without leaving a permanent "turn in progress" fence.
        handle.activeRoomTurnId = null;
        handle.state = "failed";
        handle.protocolError = true;
        handle.executionTurnId = null;
        handle.executionTurnStarted = false;
        throw error;
      }
      const terminal = await terminalPromise;
      const result = this.providerRoomTurnResult(handle, terminal);
      await options.checkpointTerminalResult?.(result);
      if (!("error" in terminal) || options.checkpointTerminalResult) handle.roomTurnResults.delete(turnId);
      return result;
    } catch (error) {
      if (terminalPromise && handle.activeRoomTurnId !== turnId) {
        this.removeExactRoomTurnWaiters(handle, turnId, error);
        await terminalPromise.catch(() => undefined);
      }
      throw error;
    } finally {
      if (handle.roomTurnOperationId === turnId) handle.roomTurnOperationId = null;
      if (handle.activeRoomTurnId === turnId && handle.roomTurnResults.has(turnId)) {
        handle.activeRoomTurnId = null;
      }
    }
  }

  async recoverRoomTurn(
    providerHandle: ProviderHandle,
    request: ProviderRoomTurnRecoveryRequest,
    options: Pick<ProviderRoomTurnOptions, "detachSignal" | "checkpointTerminalResult"> = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.requireHandle(providerHandle);
    const turnId = request.providerTurnId.trim();
    if (!turnId) {
      throw new ClaudeRoomTurnRecoveryError("Claude room-turn recovery requires an exact persisted turn id.");
    }

    let terminal = handle.roomTurnResults.get(turnId) ?? null;
    if (!terminal && handle.activeRoomTurnId === turnId) {
      terminal = await this.waitForExactRoomTurn(handle, turnId, options.detachSignal);
    }
    if (!terminal) {
      const rows = await this.deps.readSessionRows(handle.providerContinuationId);
      terminal = recoverExactClaudeTurnFromSession(rows, turnId, handle.providerContinuationId);
    }
    if (!terminal) {
      throw new ClaudeRoomTurnRecoveryError(
        "Claude room-turn recovery cannot prove the persisted exact turn reached a terminal boundary.",
      );
    }

    const result = this.providerRoomTurnResult(handle, terminal);
    await options.checkpointTerminalResult?.(result);
    if (!("error" in terminal) || options.checkpointTerminalResult) handle.roomTurnResults.delete(turnId);
    return result;
  }

  async stopRef(ref: ProviderContinuationRef, options: ProviderStopOptions = {}): Promise<ProviderTerminalPayload> {
    ref = { ...ref, providerConnection: ref.providerConnection && { ...ref.providerConnection } };
    const connection = ref.providerConnection;
    const graceMs = options.graceMs ?? this.stopGraceMs;
    const birthEvidence = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([1-9]|[12]\d|3[01])\s+([01]\d|2[0-3]):[0-5]\d:[0-5]\d\s+\d{4}(?:\s|$)/;
    if (!ref.workAttemptId?.trim() || !ref.providerContinuationId?.trim()
      || connection?.kind !== "claude_cli" || !Number.isSafeInteger(connection.pid) || connection.pid! <= 0
      || typeof connection.processIdentity !== "string" || !birthEvidence.test(connection.processIdentity.trim())
      || !Number.isFinite(graceMs) || graceMs < 0) {
      throw new Error("Claude exact-reference stop requires an exact continuation and process birth.");
    }
    const known = [...this.handles.values()].find(handle => handle.pid === connection.pid
      && handle.providerConnection.processIdentity
      && sameProcessBirthIdentity(handle.providerConnection.processIdentity, connection.processIdentity!));
    if (known && (known.workAttemptId !== ref.workAttemptId || known.providerContinuationId !== ref.providerContinuationId
      || !sameProviderConnectionIdentity(known.providerConnection, connection))) {
      throw new Error("Claude exact-reference stop conflicts with the known native process owner.");
    }
    if (known) {
      known.stopRequested = true;
      known.clearPermissions();
      known.state = "stopping";
      known.child.markIntentionalClose();
    }
    // A cached protocol terminal is not evidence that the process stopped.
    const result = await this.fenceRecordedChild(connection, ref.providerContinuationId,
      { force: options.force === true, graceMs, birthEvidence });
    return result.terminal;
  }

  async stop(
    providerHandle: ProviderHandle,
    options: ProviderStopOptions = {},
  ): Promise<ProviderTerminalPayload> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) return handle.terminal;
    if (handle.pid === null) {
      throw new Error("Cannot stop a Claude CLI child without an observed process id.");
    }

    handle.stopRequested = true;
    handle.clearPermissions();
    handle.state = "stopping";
    handle.child.markIntentionalClose();
    const exitPromise = this.requireExitPromise(handle);
    if (options.force) {
      this.deps.signalProcess(handle.pid, "SIGKILL");
      return exitPromise;
    }

    this.deps.signalProcess(handle.pid, "SIGTERM");
    const graceMs = options.graceMs ?? this.stopGraceMs;
    const graceful = await Promise.race([
      exitPromise.then((payload) => ({ payload })),
      delay(graceMs).then(() => null),
    ]);
    if (graceful) return graceful.payload;

    this.deps.signalProcess(handle.pid, "SIGKILL");
    return exitPromise;
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

  onExecution(providerHandle: ProviderHandle, listener: (event: NativeExecutionObservation) => void): NativeExecutionSubscription {
    return this.requireHandle(providerHandle).execution.subscribe(listener);
  }

  async observePermissions(
    providerHandle: ProviderHandle,
    listener: (event: ClaudePermissionObservation) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const handle = this.requireHandle(providerHandle);
    if (signal.aborted) return;
    const notify = () => {
      if (signal.aborted) return;
      try {
        if (this.handles.get(handle.workAttemptId) !== handle || handle.terminal || handle.stopRequested) listener({ type: "unavailable" });
        else if (!handle.permissionControlAvailable) listener({ type: "degraded" });
        else listener({ type: "snapshot", requests: [...handle.permissionRequests.values()].map(value => structuredClone(value.native)) });
      } catch { /* Observer failures do not alter permission decisions. */ }
    };
    const closed = (event: Extract<ClaudePermissionObservation, { type: "request_closed" }>) => {
      if (!signal.aborted) listener(event);
    };
    handle.permissionClosureListeners.add(closed);
    handle.permissionListeners.add(notify);
    notify();
    await new Promise<void>(resolve => {
      const stop = () => { handle.permissionListeners.delete(notify); handle.permissionClosureListeners.delete(closed); resolve(); };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    });
  }

  async correlatePermissionTurn(providerHandle: ProviderHandle, request: ClaudeNativePermissionRequest): Promise<
    { outcome: "correlation_unproven" } | { outcome: "correlated"; providerContinuationId: string; providerTurnId: string }
  > {
    const handle = this.requireHandle(providerHandle);
    const pending = this.currentPermission(handle, request);
    return pending ? { outcome: "correlated", providerContinuationId: handle.providerContinuationId, providerTurnId: pending.turnId }
      : { outcome: "correlation_unproven" };
  }

  async replyPermission(providerHandle: ProviderHandle, expected: ClaudeNativePermissionRequest,
    reply: "once" | "reject", options?: ProviderPermissionDispatchOptions,
  ): Promise<{ outcome: "sent"; scope: "request" }> {
    const handle = this.requireHandle(providerHandle);
    const refuse = () => Object.assign(new Error("Claude permission request is no longer pending on the exact turn."), { outcome: "not_dispatched" });
    if (!["once", "reject"].includes(reply) || !options?.beforeNativeDispatch) throw refuse();
    const pending = this.currentPermission(handle, expected);
    if (!pending || pending.dispatching) throw refuse();
    pending.dispatching = true;
    let dispatched = false;
    try {
      await options.beforeNativeDispatch();
      if (this.currentPermission(handle, expected) !== pending) throw refuse();
      options.assertNativeDispatch?.();
      // The assertion may synchronously revoke or replace the runtime.
      if (this.currentPermission(handle, expected) !== pending) throw refuse();
      dispatched = true;
      handle.child.writeLine(JSON.stringify({ type: "control_response", response: {
        subtype: "success", request_id: pending.native.id,
        response: reply === "once" ? { behavior: "allow", updatedInput: pending.native.request.input }
          : { behavior: "deny", message: "The host rejected this action." },
      } }));
      return { outcome: "sent", scope: "request" };
    } catch (error) {
      if (dispatched) throw Object.assign(new Error("Claude approval dispatch cannot be confirmed."), { outcome: "uncertain" });
      pending.dispatching = false;
      throw error;
    } finally {
      if (dispatched) { handle.permissionRequests.delete(expected.id); handle.permissionsChanged(); }
    }
  }

  private currentPermission(handle: ClaudeProviderHandle, expected: ClaudeNativePermissionRequest) {
    const pending = handle.permissionRequests.get(expected.id);
    if (!pending || !isDeepStrictEqual(pending.native, expected)
      || this.handles.get(handle.workAttemptId) !== handle || handle.terminal || handle.stopRequested
      || !handle.permissionControlAvailable || handle.providerConnection.kind !== "claude_cli"
      || !handle.providerConnection.processIdentity
      || this.deps.getProcessIdentity(handle.pid!) !== handle.providerConnection.processIdentity
      || handle.executionTurnId !== pending.turnId || handle.activeRoomTurnId !== pending.turnId
      || !handle.executionTurnStarted || handle.pendingInterruptTurnId) return null;
    const tool = handle.executionTools.get(expected.request.tool_use_id);
    return tool && !tool.completed && tool.name === expected.request.tool_name
      && isDeepStrictEqual(tool.input, expected.request.input) ? pending : null;
  }

  private closePermission(handle: ClaudeProviderHandle, id: string): void {
    const pending = handle.permissionRequests.get(id) ?? handle.permissionClosures.get(id);
    if (!pending || this.handles.get(handle.workAttemptId) !== handle || !handle.permissionControlAvailable
      || handle.providerConnection.kind !== "claude_cli" || !handle.providerConnection.processIdentity
      || this.deps.getProcessIdentity(handle.pid!) !== handle.providerConnection.processIdentity) return;
    handle.permissionClosures.delete(id);
    handle.permissionRequests.delete(id);
    const event = { type: "request_closed" as const, request: structuredClone(pending.native),
      providerContinuationId: handle.providerContinuationId, providerTurnId: pending.turnId };
    for (const listener of handle.permissionClosureListeners) {
      try { listener(event); } catch { /* Closure is observation, never a decision. */ }
    }
    handle.permissionsChanged();
  }

  private consumePermission(handle: ClaudeProviderHandle, message: ClaudeStreamMessage): void {
    if (typeof message.request_id !== "string" || !message.request_id.trim() || message.request_id.length > 512) return;
    if (message.type === "control_cancel_request") {
      handle.seenPermissionRequestIds.add(message.request_id);
      this.closePermission(handle, message.request_id);
      return;
    }
    const request = message.request as ClaudeNativePermissionRequest["request"] | undefined;
    const turnId = handle.activeRoomTurnId;
    if (!request || request.agent_id != null || request.subtype !== "can_use_tool" || !turnId || handle.executionTurnId !== turnId
      || !handle.executionTurnStarted || typeof request.tool_name !== "string" || !request.tool_name.trim()
      || typeof request.tool_use_id !== "string" || !request.tool_use_id.trim()
      || !request.input || typeof request.input !== "object" || Array.isArray(request.input)) return;
    const native = { id: message.request_id, request: structuredClone(request) };
    const prior = handle.permissionRequests.get(native.id);
    if (prior) {
      // Reused IDs with different payloads are ambiguous and cannot inherit approval.
      if (!isDeepStrictEqual(prior.native, native)) { handle.permissionControlAvailable = false; handle.clearPermissions(); }
      return;
    }
    if (handle.seenPermissionRequestIds.has(native.id)) return;
    handle.seenPermissionRequestIds.add(native.id);
    handle.permissionRequests.set(native.id, { native, turnId, dispatching: false });
    handle.permissionClosures.set(native.id, { native, turnId });
    while (handle.permissionClosures.size > 64) handle.permissionClosures.delete(handle.permissionClosures.keys().next().value!);
    handle.permissionsChanged();
  }

  async probeControl(providerHandle: ProviderHandle): Promise<ControlProbeResult> {
    const handle = this.requireHandle(providerHandle);
    // A live PID or quiet stdout cannot prove the native control loop responds.
    const result: ControlProbeResult = handle.executionExitObserved
      ? { state: "lost", controlEvidence: "process_exit" }
      : { state: "unprobeable" };
    handle.execution.emit(
      { domain: "control", kind: "state_changed", sideEffects: "none", ...result },
      handle.providerConnection.kind === "claude_cli"
        ? handle.providerConnection.processIdentity ?? undefined
        : undefined,
      handle.providerConnection.kind === "claude_cli"
        ? handle.providerConnection.pid ?? undefined
        : undefined,
    );
    return result;
  }

  private async start(
    req: ProviderSpawnRequest,
    resumeRef: ProviderContinuationRef | null,
  ): Promise<ClaudeProviderHandle> {
    return this.processCustody.acquire(req.workAttemptId, () => this.startAcquired(req, resumeRef));
  }

  private async startAcquired(
    req: ProviderSpawnRequest,
    resumeRef: ProviderContinuationRef | null,
  ): Promise<ClaudeProviderHandle> {
    const acquisition = providerAcquisitionIdentity("claude-code", req, resumeRef?.providerContinuationId ?? null);
    const current = this.handles.get(req.workAttemptId);
    if (current && !current.terminal) {
      throw new Error(`Claude work attempt '${req.workAttemptId}' already has a live process.`);
    }
    if (!req.agentDisplayName?.trim()) {
      throw new Error("Claude spawn requires the durable agent display name from the manifest.");
    }
    if (req.deliveryMode !== "daemon_inbox") {
      throw new Error("Claude room agents require daemon_inbox delivery.");
    }
    const lifecycleAuthorityMode = req.lifecycleAuthorityMode ?? "typed_shadow";
    const versionOutput = await this.deps.readVersion(this.claudeBin);
    requireSupportedClaudeCodeVersion(versionOutput, req.permissionProfileId === "ask_before_write");

    const policyArgs = claudeLaunchPolicyArgs(attestProviderSpawnPolicy("claude-code", req));
    const managedMcpConfig = await this.deps.createLetAgentsMcpConfig(req);
    // Use an explicit strict config so a repo-tracked .mcp.json cannot shadow
    // the managed room workplace. The short-lived 0600 config lives outside
    // the worktree, its path (never its credential) enters argv, and it is
    // deleted as soon as Claude reports the initialized MCP workplace.
    // The spike (msg_1382) proved both identity paths: a minted --session-id is
    // honored verbatim on fresh spawns, and --resume continues the SAME session
    // id. Either way the continuation is asserted against init below.
    const expectedSessionId = resumeRef ? resumeRef.providerContinuationId : randomUUID();
    const bootstrapTurnId = randomUUID();
    const args = [
      "--print",
      "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      ...(req.permissionProfileId === "ask_before_write" ? ["--permission-prompt-tool", "stdio"] : []),
      "--strict-mcp-config",
      "--mcp-config", managedMcpConfig.path,
      ...policyArgs,
      ...(req.model ? ["--model", req.model] : []),
      ...(resumeRef ? ["--resume", resumeRef.providerContinuationId] : ["--session-id", expectedSessionId]),
    ];
    const supervisorEnv = req.supervisorEntryId && req.supervisorSocketPath && req.supervisorExecutionGenerationId
      ? {
        LETAGENTS_SUPERVISOR_ENTRY_ID: req.supervisorEntryId,
        LETAGENTS_SUPERVISOR_DAEMON_SOCKET: req.supervisorSocketPath,
        LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: req.workAttemptId,
        LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: req.supervisorExecutionGenerationId,
        ...(req.supervisorWorkerSession ? {
          LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: req.supervisorWorkerSession.agentSessionId,
          LETAGENTS_SUPERVISOR_ROOM_ID: req.roomId,
          LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: req.agentDisplayName.trim(),
        } : {}),
        LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
        LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
        ...(req.supervisorEntryId.startsWith("supervised_rental_") ? {
          [rentalCredentialIsolationMarker]: "1",
        } : {}),
        ...(req.permissionProfileId ? { LETAGENTS_PERMISSION_PROFILE_ID: req.permissionProfileId } : {}),
      }
      : undefined;
    let child: ClaudeCliChild;
    try {
      child = this.deps.launchChild({ claudeBin: this.claudeBin, args, cwd: req.cwd, env: supervisorEnv });
    } catch (error) {
      await managedMcpConfig.dispose();
      throw error;
    }

    const captureBirth = this.processCustody.record(req.workAttemptId, child);
    const processIdentity = captureBirth();
    if (child.pid === null) {
      // Node exposes no safe signalling target in this state. Fail closed until
      // the launch itself proves terminal instead of retrying beside an orphan.
      await child.exited;
      await managedMcpConfig.dispose();
      throw new Error(
        "Claude CLI launch did not expose a process id; refusing to start an unfenceable writer.",
      );
    }

    if (typeof processIdentity !== "string" || !processIdentity) {
      child.markIntentionalClose();
      await terminateFreshLaunch(child, this.deps, this.stopGraceMs);
      await managedMcpConfig.dispose();
      throw new Error(
        "Claude CLI process identity could not be verified; refusing to start an unfenceable writer.",
      );
    }

    let handle: ClaudeProviderHandle | null = null;
    const diagnostics = new ClaudeBootstrapDiagnostics(expectedSessionId, bootstrapTurnId, this.initTimeoutMs);
    let capturingBootstrap = true;
    const pendingLines: string[] = [];
    let init: ClaudeStreamMessage | null = null;
    let resolveInit: ((message: ClaudeStreamMessage) => void) | null = null;
    const initPromise = new Promise<ClaudeStreamMessage>((resolve) => { resolveInit = resolve; });
    const unsubscribeLines = child.onLine((line) => {
      if (capturingBootstrap) diagnostics.observe(line);
      if (!init) {
        const parsed = parseStreamLine(line);
        if (parsed && parsed.type === "system" && parsed.subtype === "init") {
          init = parsed;
          resolveInit?.(parsed);
          return;
        }
        pendingLines.push(line);
        return;
      }
      if (!handle) {
        pendingLines.push(line);
        return;
      }
      this.consumeLine(handle, line);
    });

    // The init wait is a REF'D timer (unlike the evidence module's unref'd
    // delay): startup must stay observable even when nothing else keeps the
    // supervising process's event loop alive. Cleared as soon as the race ends.
    let initTimer: ReturnType<typeof setTimeout> | null = null;
    const bootstrapFailure = Symbol("bootstrap-failure");
    const initTimeout = new Promise<{ [bootstrapFailure]: { type: "deadline" } }>((resolve) => {
      initTimer = setTimeout(() => resolve({ [bootstrapFailure]: { type: "deadline" } }), this.initTimeoutMs);
    });
    try {
      // Claude does not emit init until it receives one stdin user frame. This
      // bootstrap establishes the continuation but deliberately does no room
      // work; every real message is claimed and dispatched by the daemon.
      child.writeLine(userStreamJsonLine(CLAUDE_DAEMON_BOOTSTRAP_PROMPT, bootstrapTurnId));

      // Keep the raw observation promises and map only process exit, retaining
      // the established precedence for exact results consumed in the same batch.
      const observedInit = await Promise.race([
        initPromise,
        child.exited.then(exit => ({ [bootstrapFailure]: exit })),
        initTimeout,
      ]);
      if (bootstrapFailure in observedInit) {
        throw new ClaudeBootstrapError("init", observedInit[bootstrapFailure], diagnostics.summary(child));
      }
      if (req.permissionProfileId === "ask_before_write"
        && (!Array.isArray(observedInit.capabilities) || !observedInit.capabilities.includes("msg_lifecycle_v1"))) {
        throw new Error("Claude tool approvals require exact native turn lifecycle support. Update Claude Code, then try again.");
      }
      // A named but failed server is not a usable room connection.
      if (!hasReadyRoomWorkplace(observedInit)) {
        throw new Error(
          "LetAgents room tools did not connect to Claude; refusing to launch without the room workplace.",
        );
      }
      const sessionId = sessionIdOf(observedInit);
      if (!sessionId) {
        throw new Error("Claude CLI init did not include a session id.");
      }
      // Exact continuation identity, both directions (msg_1382): a fresh spawn
      // must run under the minted --session-id, and --resume must continue the
      // SAME session. Anything else is a different conversation and must not
      // silently become this work attempt's continuation.
      if (sessionId !== expectedSessionId) {
        throw new Error(
          resumeRef
            ? "Claude CLI resumed a different session than the durable continuation."
            : "Claude CLI ignored the minted session id; refusing an unverifiable continuation.",
        );
      }

      handle = new ClaudeProviderHandle(
        req.workAttemptId,
        child.pid,
        sessionId,
        lifecycleAuthorityMode,
        { kind: "claude_cli", pid: child.pid, processIdentity },
        child,
        observeFencedExit(child, child.pid, processIdentity, child.exited, this.deps),
        this.deps.now,
      );
      this.handles.set(req.workAttemptId, handle);
      const exitPromise = handle.exitEvidence.then((exit) => this.observeExit(handle!, exit));
      this.exitPromises.set(handle, exitPromise);

      diagnostics.initialized();
      this.publishStream(handle, streamMethod(observedInit), observedInit, "provider_event");
      const bootstrapResult = this.waitForExactRoomTurn(handle, bootstrapTurnId);
      for (const line of pendingLines.splice(0)) {
        this.consumeLine(handle, line);
      }
      const bootstrapTerminal = await Promise.race([
        bootstrapResult,
        child.exited.then(exit => ({ [bootstrapFailure]: exit })),
        initTimeout,
      ]);
      if (bootstrapFailure in bootstrapTerminal) {
        throw new ClaudeBootstrapError("bootstrap_turn", bootstrapTerminal[bootstrapFailure], diagnostics.summary(child));
      }
      if ("error" in bootstrapTerminal) {
        throw new ClaudeBootstrapError("bootstrap_turn", { type: "failed_response" }, diagnostics.summary(child));
      }
      handle.roomTurnResults.delete(bootstrapTurnId);
      handle.state = "idle";
      handle.execution.emit(
        { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" },
        processIdentity,
        child.pid ?? undefined,
      );
      return handle;
    } catch (error) {
      capturingBootstrap = false;
      if (handle) {
        handle.protocolError = true;
      } else {
        unsubscribeLines();
      }
      child.markIntentionalClose();
      await terminateFreshLaunch(child, this.deps, this.stopGraceMs);
      // Cleanup returning is not death. Retain only the existing exact exit
      // observation from this rejected child, without admitting its handle.
      if (handle?.terminal?.nativeRuntimeDeath && handle.providerConnection.kind === "claude_cli") {
        retainProviderAcquisitionEvidence(error, acquisition, handle.providerConnection, handle.terminal);
      }
      throw error;
    } finally {
      capturingBootstrap = false;
      if (initTimer) clearTimeout(initTimer);
      await managedMcpConfig.dispose();
    }
  }

  /** The attach-path fence for a recorded child this adapter cannot reattach. */
  private async fenceRecordedChild(
    connection: Extract<ProviderConnectionRef, { kind: "claude_cli" }>,
    providerContinuationId: string,
    stop?: { force: boolean; graceMs: number; birthEvidence: RegExp },
  ): Promise<ProviderAttachTerminal> {
    if (connection.pid === null || !connection.processIdentity) {
      throw new Error(
        "Claude CLI attach is ambiguous; the durable endpoint has no verified process identity.",
      );
    }
    const readIdentity = () => {
      const identity = this.deps.getProcessIdentity(connection.pid!);
      if (stop && typeof identity === "string" && !stop.birthEvidence.test(identity.trim())) {
        throw new Error("Claude exact-reference stop is ambiguous because process birth cannot be verified.");
      }
      return identity;
    };
    const identity = readIdentity();
    if (identity === undefined) {
      throw new Error(
        "Claude CLI attach is ambiguous; the recorded process identity cannot be verified.",
      );
    }
    if (identity === null || !sameProcessBirthIdentity(identity, connection.processIdentity)) {
      // The recorded child is verifiably gone (a recycled pid is NOT it and is
      // never signalled). Proven absent — bounded recovery may proceed.
      return this.attachTerminal(connection, providerContinuationId, null, "crashed");
    }
    // A previous daemon's stdin disappearing normally gives Claude EOF. Let
    // that exact orphan finish and flush its JSONL terminal boundary before
    // fencing it; recovery can then prove the already-started turn without a
    // duplicate dispatch.
    const exitedNaturally = !stop && await Promise.race([
      this.deps.observeProcessExit(connection.pid, connection.processIdentity).then(() => true),
      delay(this.stopGraceMs).then(() => false),
    ]);
    if (exitedNaturally) {
      return this.attachTerminal(connection, providerContinuationId, null, "crashed");
    }
    const identityBeforeTerm = readIdentity();
    if (identityBeforeTerm === undefined) {
      throw new Error(
        "Claude CLI attach is ambiguous; the orphaned child's identity cannot be verified.",
      );
    }
    if (identityBeforeTerm === null || !sameProcessBirthIdentity(identityBeforeTerm, connection.processIdentity)) {
      return this.attachTerminal(connection, providerContinuationId, null, "crashed");
    }
    // The exact recorded child is still alive but unreachable (its stdio died
    // with the previous supervisor). It may still be writing the workspace, so
    // it must be terminal before any replacement generation exists.
    const signal = stop?.force ? "SIGKILL" : "SIGTERM";
    this.deps.signalProcess(connection.pid, signal);
    await delay(stop?.graceMs ?? this.stopGraceMs);
    const identityBeforeKill = readIdentity();
    if (identityBeforeKill === undefined) {
      throw new Error(
        "Claude CLI attach is ambiguous; the orphaned child's termination could not be verified.",
      );
    }
    if (identityBeforeKill !== null && sameProcessBirthIdentity(identityBeforeKill, connection.processIdentity)) {
      if (stop?.force) throw new Error("Claude exact-reference stop has not yet proved the recorded process birth is gone.");
      this.deps.signalProcess(connection.pid, "SIGKILL");
      if (stop) {
        await delay(stop.graceMs);
        const finalIdentity = readIdentity();
        if (finalIdentity === undefined || (finalIdentity !== null && sameProcessBirthIdentity(finalIdentity, connection.processIdentity))) {
          throw new Error("Claude exact-reference stop has not yet proved the recorded process birth is gone.");
        }
      } else {
        await this.deps.observeProcessExit(connection.pid, connection.processIdentity);
      }
      return this.attachTerminal(connection, providerContinuationId, "SIGKILL", "killed");
    }
    return this.attachTerminal(connection, providerContinuationId, signal, signal === "SIGKILL" ? "killed" : "stopped");
  }

  private attachTerminal(
    connection: Extract<ProviderConnectionRef, { kind: "claude_cli" }>,
    providerContinuationId: string,
    signal: string | null,
    terminalCause: ProviderTerminalPayload["terminalCause"],
  ): ProviderAttachTerminal {
    return {
      state: "terminal",
      terminal: {
        endedAt: this.deps.now(),
        exitCode: null,
        signal,
        terminalCause,
        providerContinuationId,
        nativeRuntimeDeath: { kind: "claude_cli", pid: connection.pid!, processIdentity: connection.processIdentity! },
      },
    };
  }

  private consumeLine(handle: ClaudeProviderHandle, line: string): void {
    const message = parseStreamLine(line);
    if (!message) {
      this.publishStream(handle, "stdout/raw", { line }, "provider_event");
      return;
    }
    // Native approval payloads stay host-ephemeral; do not publish them to room activity.
    if (message.type === "control_request" || message.type === "control_cancel_request") {
      this.consumePermission(handle, message);
      return;
    }
    const contextualInterruptTurnId = this.contextualInterruptTurnId(handle, message);
    const contextualInterruptReplayTurnId = contextualInterruptTurnId
      ? null
      : this.contextualInterruptReplayTurnId(handle, message);
    if (contextualInterruptTurnId) handle.contextualInterruptResults.add(message);
    const nativeLifecycle = this.observeNativeExecution(
      handle,
      message,
      contextualInterruptTurnId,
      contextualInterruptReplayTurnId,
    );
    this.publishStream(handle, streamMethod(message), message, claudeStreamKind(message),
      nativeLifecycle?.nativeEventId ?? null, nativeLifecycle?.phase ?? null);
    const typedAuthority = handle.lifecycleAuthorityMode === "typed";
    if (typedAuthority && nativeLifecycle?.phase === "turn_active") handle.state = "working";
    if (typedAuthority && nativeLifecycle?.phase === "turn_terminal") handle.state = "idle";
    const type = typeof message.type === "string" ? message.type : "";
    if (handle.state === "failed") return;
    if (type === "result") {
      const exactTurnId = typeof message.user_message_uuid === "string"
        ? message.user_message_uuid.trim()
        : contextualInterruptTurnId ?? "";
      let exactTurnFailed = false;
      if (exactTurnId) {
        const terminal = contextualInterruptTurnId
          ? { turnId: contextualInterruptTurnId, nativeOutcome: "interrupted" as const, error: "Claude command ended interrupted." }
          : exactClaudeStreamTerminal(message, exactTurnId, handle.providerContinuationId);
        if (terminal) {
          exactTurnFailed = "error" in terminal && handle.activeRoomTurnId === exactTurnId;
          handle.roomTurnResults.set(exactTurnId, terminal);
          if (handle.activeRoomTurnId === exactTurnId) handle.activeRoomTurnId = null;
          if (handle.pendingInterruptTurnId === exactTurnId) handle.pendingInterruptTurnId = null;
          if (contextualInterruptTurnId === exactTurnId) {
            handle.contextualInterruptTerminalTurnId = exactTurnId;
          }
          const exactWaiters = [...(handle.roomTurnWaiters.get(exactTurnId) ?? [])];
          for (const waiter of exactWaiters) waiter.resolve(terminal);
        }
      }
      const exactInterrupted = Boolean(contextualInterruptTurnId || contextualInterruptReplayTurnId)
        || (typeof message.subtype === "string"
          && message.subtype.toLowerCase() === "interrupted"
          && sessionIdOf(message) === handle.providerContinuationId);
      if (handle.turnResultWaiters.size) {
        const waiters = [...handle.turnResultWaiters];
        handle.turnResultWaiters.clear();
        for (const resolve of waiters) resolve(message);
      }
      if (exactInterrupted) {
        if (!typedAuthority) handle.state = "idle";
        this.publishActivity(handle, {
          source: "native_harness",
          method: streamMethod(message),
          summary: "Turn interrupted",
          status: "idle",
          checking: "",
          next_action: "awaiting redirected work",
        });
        return;
      }
      if (isClaudeFailedResult(message) || (typedAuthority && exactTurnFailed)) {
        const turnLimited = isClaudeTurnLimitResult(message);
        if (!typedAuthority) handle.state = turnLimited || exactTurnFailed ? "idle" : "failed";
        this.publishActivity(handle, {
          source: "native_harness",
          method: streamMethod(message),
          summary: "Turn failed",
          status: "blocked",
          checking: "Claude Code reported a terminal turn failure.",
          next_action: turnLimited ? "Awaiting next room work." : "Awaiting supervised recovery.",
        });
        return;
      }
      if (!typedAuthority) handle.state = "idle";
      this.publishActivity(handle, {
        source: "native_harness",
        method: streamMethod(message),
        summary: "Turn completed",
        status: "idle",
        checking: "",
        next_action: "awaiting next room work",
      });
      return;
    }
    if (type === "assistant" || type === "user" || type === "tool_use_summary") {
      if (!typedAuthority) handle.state = "working";
      const text = type === "assistant" ? assistantTextOf(message) : null;
      this.publishActivity(handle, {
        source: "native_harness",
        method: streamMethod(message),
        summary: text ? text.slice(0, 240) : `Processing ${streamMethod(message)}`,
        status: "working",
        checking: "",
        next_action: "",
      });
    }
  }

  private contextualInterruptTurnId(
    handle: ClaudeProviderHandle,
    message: ClaudeStreamMessage,
  ): string | null {
    const turnId = handle.pendingInterruptTurnId;
    // Delivery may detach/recover its waiter while this native turn stays live.
    // Its transient roomTurnOperationId is not native interruption authority.
    if (!turnId
      || handle.activeRoomTurnId !== turnId
      || handle.executionTurnId !== turnId
      || message.type !== "result"
      || sessionIdOf(message) !== handle.providerContinuationId
      || message.subtype !== "error_during_execution"
      || message.is_error !== true
      || !(message.terminal_reason === "aborted_streaming" && message.user_message_uuid == null
        || ["aborted_streaming", "aborted_tools"].includes(String(message.terminal_reason)) && message.user_message_uuid === turnId)) return null;
    return turnId;
  }

  private contextualInterruptReplayTurnId(
    handle: ClaudeProviderHandle,
    message: ClaudeStreamMessage,
  ): string | null {
    const turnId = handle.contextualInterruptTerminalTurnId;
    if (!turnId
      || handle.activeRoomTurnId !== null
      || handle.executionTurnId !== null
      || message.type !== "result"
      || sessionIdOf(message) !== handle.providerContinuationId
      || message.subtype !== "error_during_execution"
      || message.is_error !== true
      || !(message.terminal_reason === "aborted_streaming" && message.user_message_uuid == null
        || ["aborted_streaming", "aborted_tools"].includes(String(message.terminal_reason)) && message.user_message_uuid === turnId)) return null;
    return turnId;
  }

  private observeNativeExecution(
    handle: ClaudeProviderHandle,
    message: ClaudeStreamMessage,
    contextualInterruptTurnId: string | null = null,
    contextualInterruptReplayTurnId: string | null = null,
  ): NativeLifecycleCheckpoint | null {
    const replay = handle.executionTerminalCheckpoint;
    if (message.type === "result" && replay
      && message.session_id === handle.providerContinuationId
      && (message.user_message_uuid === replay.providerTurnId
        || contextualInterruptReplayTurnId === replay.providerTurnId)
      && claudeTerminalDiscriminator(message) === replay.terminalDiscriminator) {
      return replay.nativeLifecycle;
    }
    const turnId = handle.executionTurnId;
    if (!turnId || message.session_id !== handle.providerContinuationId
      || !nativeExecutionId(handle.providerContinuationId)) return null;
    const emit = (fact: NativeExecutionFact) => handle.execution.emit(fact,
      handle.providerConnection.kind === "claude_cli" ? handle.providerConnection.processIdentity ?? undefined : undefined,
      handle.providerConnection.kind === "claude_cli" ? handle.providerConnection.pid ?? undefined : undefined);
    const turn = { providerTurnId: turnId, providerContinuationId: handle.providerContinuationId };
    // command_uuid names the user turn, never a shell command. Only an exact
    // native started event proves receipt; writing stdin alone is insufficient.
    if (message.type === "command_lifecycle" && message.command_uuid === turnId && message.state === "started") {
      const nativeLifecycle = nativeLifecycleCheckpoint({
        provider: this.id,
        workAttemptId: handle.workAttemptId,
        phase: "turn_active",
        providerContinuationId: handle.providerContinuationId,
        providerTurnId: turnId,
        nativeProcessPid: handle.providerConnection.kind === "claude_cli"
          ? handle.providerConnection.pid ?? undefined : undefined,
        nativeProcessIdentity: handle.providerConnection.kind === "claude_cli"
          ? handle.providerConnection.processIdentity ?? undefined : undefined,
      });
      if (!handle.executionTurnStarted) {
        handle.executionTurnStarted = true;
        emit({ domain: "turn", kind: "state_changed", state: "active", sideEffects: "none",
          nativeEventId: nativeLifecycle.nativeEventId, ...turn });
      }
      return nativeLifecycle;
    } else if (message.type === "result"
      && (message.user_message_uuid === turnId || contextualInterruptTurnId === turnId)) {
      const hasLegacyTerminalShape = typeof message.subtype === "string" && Boolean(message.subtype)
        && (message.subtype === "success" ? message.is_error === false : message.is_error === true);
      if (handle.lifecycleAuthorityMode !== "typed" && !hasLegacyTerminalShape) return null;
      const terminalDiscriminator = claudeTerminalDiscriminator(message);
      const subtype = typeof message.subtype === "string" ? message.subtype.toLowerCase() : "";
      const turnOutcome = contextualInterruptTurnId === turnId || subtype === "interrupted" ? "interrupted"
        : subtype === "success" && message.is_error === false ? "completed" : "failed";
      const nativeLifecycle = nativeLifecycleCheckpoint({
        provider: this.id,
        workAttemptId: handle.workAttemptId,
        phase: "turn_terminal",
        providerContinuationId: handle.providerContinuationId,
        providerTurnId: turnId,
        nativeProcessPid: handle.providerConnection.kind === "claude_cli"
          ? handle.providerConnection.pid ?? undefined : undefined,
        nativeProcessIdentity: handle.providerConnection.kind === "claude_cli"
          ? handle.providerConnection.processIdentity ?? undefined : undefined,
        terminalDiscriminator,
      });
      emit({ domain: "turn", kind: "state_changed", state: "terminal", sideEffects: "none", ...turn,
        nativeEventId: nativeLifecycle.nativeEventId,
        turnOutcome });
      handle.executionTerminalCheckpoint = {
        providerTurnId: turnId,
        terminalDiscriminator,
        nativeLifecycle,
      };
      for (const [id, pending] of new Map([...handle.permissionClosures, ...handle.permissionRequests])) {
        if (pending.turnId === turnId) this.closePermission(handle, id);
      }
      handle.executionTurnId = null;
      handle.executionTurnStarted = false;
      handle.executionTools.clear();
      handle.clearPermissions();
      return nativeLifecycle;
    } else if (handle.executionTurnStarted && (message.type === "assistant" || message.type === "user")
      && message.parent_tool_use_id == null
      && (message.user_message_uuid == null || message.user_message_uuid === turnId)) {
      // Tool messages carry session/tool identity, not the caller's turn UUID.
      // Do not attribute a bootstrap or previous-turn tail before exact receipt.
      const body = message.message as { content?: unknown } | undefined;
      if (!Array.isArray(body?.content)) return null;
      for (const value of body.content) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const block = value as Record<string, unknown>;
        if (message.type === "assistant" && block.type === "tool_use" && nativeExecutionId(block.id)
          && typeof block.name === "string" && !handle.executionTools.has(block.id)) {
          // Tool requests precede permission. Record correlation only, never
          // claim execution.started (nor expose agent-authored input/text).
          const operation = claudeToolOperation(block.name);
          handle.executionTools.set(block.id, { operation, completed: false, name: block.name, input: structuredClone(block.input) });
        } else if (message.type === "user" && block.type === "tool_result" && nativeExecutionId(block.tool_use_id)) {
          const tool = handle.executionTools.get(block.tool_use_id);
          if (!tool || tool.completed || (block.is_error !== undefined && typeof block.is_error !== "boolean")
            || (typeof block.content !== "string" && !Array.isArray(block.content))) continue;
          tool.completed = true;
          for (const [id, pending] of new Map([...handle.permissionClosures, ...handle.permissionRequests])) {
            if (pending.turnId === turnId && pending.native.request.tool_use_id === block.tool_use_id) this.closePermission(handle, id);
          }
          emit({ domain: "execution", kind: "completed", executionId: block.tool_use_id, operation: tool.operation,
            outcome: block.is_error === true ? "failed" : "succeeded", sideEffects: tool.operation === "file_read" ? "none" : "possible", ...turn });
        }
      }
    }
    return null;
  }

  private waitForNextTurnResult(handle: ClaudeProviderHandle): Promise<ClaudeStreamMessage> {
    return new Promise<ClaudeStreamMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.turnResultWaiters.delete(done);
        reject(new Error("Claude did not prove the active turn reached an interrupted boundary."));
      }, 10_000);
      const done = (message: ClaudeStreamMessage) => {
        clearTimeout(timer);
        resolve(message);
      };
      handle.turnResultWaiters.add(done);
    });
  }

  private waitForExactRoomTurn(
    handle: ClaudeProviderHandle,
    turnId: string,
    detachSignal?: AbortSignal,
  ): Promise<ClaudeRoomTurnTerminal> {
    const cached = handle.roomTurnResults.get(turnId);
    if (cached) return Promise.resolve(cached);
    if (detachSignal?.aborted) {
      return Promise.reject(new ClaudeRoomTurnObservationDetachedError("Claude room-turn observation detached."));
    }
    return new Promise<ClaudeRoomTurnTerminal>((resolve, reject) => {
      const waiters = handle.roomTurnWaiters.get(turnId) ?? new Set();
      let entry: {
        resolve: (result: ClaudeRoomTurnTerminal) => void;
        reject: (error: Error) => void;
      };
      const cleanup = () => {
        detachSignal?.removeEventListener("abort", detached);
        const current = handle.roomTurnWaiters.get(turnId);
        current?.delete(entry);
        if (current?.size === 0) handle.roomTurnWaiters.delete(turnId);
      };
      const detached = () => {
        cleanup();
        reject(new ClaudeRoomTurnObservationDetachedError("Claude room-turn observation detached."));
      };
      entry = {
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      waiters.add(entry);
      handle.roomTurnWaiters.set(turnId, waiters);
      detachSignal?.addEventListener("abort", detached, { once: true });
    });
  }

  private removeExactRoomTurnWaiters(
    handle: ClaudeProviderHandle,
    turnId: string,
    error: unknown,
  ): void {
    const waiters = [...(handle.roomTurnWaiters.get(turnId) ?? [])];
    for (const waiter of waiters) {
      waiter.reject(error instanceof Error ? error : new Error(errorMessage(error)));
    }
  }

  private providerRoomTurnResult(handle: ClaudeProviderHandle, terminal: ClaudeRoomTurnTerminal): ProviderRoomTurnResult {
    if ("error" in terminal) {
      if (!terminal.nativeOutcome) throw new Error(`Claude bounded room turn ${terminal.turnId} failed: ${terminal.error}`);
      return { turnId: terminal.turnId, providerContinuationId: handle.providerContinuationId,
        outcome: terminal.nativeOutcome, text: null, evidence: "stream",
        error: String(safeStreamPayload(terminal.error).payload).slice(0, 2000) };
    }
    if (terminal.outcome === "reply") {
      return {
        turnId: terminal.turnId,
        outcome: "reply",
        text: terminal.text,
        evidence: terminal.evidence,
      };
    }
    if (terminal.outcome === "no_reply") {
      return {
        turnId: terminal.turnId,
        outcome: "no_reply",
        text: null,
        evidence: terminal.evidence,
      };
    }
    return { turnId: terminal.turnId, outcome: "unreadable", text: null, evidence: "none" };
  }

  private publishStream(
    handle: ClaudeProviderHandle,
    method: string,
    providerPayload: unknown,
    kind: ProviderStreamEventKind,
    nativeEventId: string | null = null,
    nativeLifecyclePhase: "turn_active" | "turn_terminal" | null = null,
  ): void {
    const safe = safeStreamPayload(providerPayload);
    const event: ProviderStreamEvent = {
      workAttemptId: handle.workAttemptId,
      providerContinuationId: handle.providerContinuationId,
      observedAt: this.deps.now(),
      sequence: ++handle.streamSequence,
      provider: this.id,
      kind,
      method,
      ...(nativeEventId ? { nativeEventId } : {}),
      ...(nativeLifecyclePhase ? { nativeLifecyclePhase } : {}),
      ...safe,
      durablePayloadRef: null,
    };
    this.streamSink?.(event);
    for (const listener of handle.streamListeners) listener(event);
  }

  private publishActivity(
    handle: ClaudeProviderHandle,
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

  private observeExit(
    handle: ClaudeProviderHandle,
    exit: ProviderProcessExit,
  ): ProviderTerminalPayload {
    handle.pendingInterruptTurnId = null;
    handle.contextualInterruptTerminalTurnId = null;
    handle.permissionControlAvailable = false;
    handle.clearPermissions();
    if (exit.type === "exit") {
      handle.executionExitObserved = true;
      const identity = handle.providerConnection.kind === "claude_cli" ? handle.providerConnection.processIdentity ?? undefined : undefined;
      const pid = handle.providerConnection.kind === "claude_cli" ? handle.providerConnection.pid ?? undefined : undefined;
      if (handle.executionTurnId && nativeExecutionId(handle.providerContinuationId)) {
        handle.execution.emit({ domain: "turn", kind: "state_changed", state: "lost", sideEffects: "none",
          providerContinuationId: handle.providerContinuationId, providerTurnId: handle.executionTurnId }, identity, pid);
        handle.executionTurnId = null;
        handle.executionTurnStarted = false;
        handle.executionTools.clear();
      }
      handle.execution.emit({ domain: "control", kind: "state_changed", state: "lost", sideEffects: "none", controlEvidence: "process_exit" }, identity, pid);
      handle.execution.emit({ domain: "runtime", kind: "state_changed", state: "exited", sideEffects: "none", controlEvidence: "process_exit" }, identity, pid);
    }
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
    if (exit.type === "exit" && handle.providerConnection.kind === "claude_cli"
      && handle.providerConnection.pid && handle.providerConnection.processIdentity) {
      (terminal as ProviderTerminalPayload).nativeRuntimeDeath = { kind: "claude_cli",
        pid: handle.providerConnection.pid, processIdentity: handle.providerConnection.processIdentity };
    }
    if (handle.protocolError) terminal.terminalCause = "protocol_error";
    handle.terminal = terminal;
    handle.state = terminal.terminalCause === "exited" || terminal.terminalCause === "stopped"
      ? "stopped"
      : "failed";
    handle.child.markIntentionalClose();
    if (this.handles.get(handle.workAttemptId) === handle) {
      this.handles.delete(handle.workAttemptId);
    }
    for (const turnId of [...handle.roomTurnWaiters.keys()]) {
      this.removeExactRoomTurnWaiters(
        handle,
        turnId,
        new Error(`Claude exited before bounded room turn ${turnId} reached a terminal boundary.`),
      );
    }
    for (const listener of handle.exitListeners) listener(terminal);
    handle.exitListeners.clear();
    return terminal;
  }

  private requireHandle(handle: ProviderHandle): ClaudeProviderHandle {
    if (!(handle instanceof ClaudeProviderHandle)) {
      throw new Error("Provider handle does not belong to ClaudeCodeProviderAdapter.");
    }
    return handle;
  }

  private requireExitPromise(handle: ClaudeProviderHandle): Promise<ProviderTerminalPayload> {
    const promise = this.exitPromises.get(handle);
    if (!promise) throw new Error("Claude provider handle is missing its exit observation.");
    return promise;
  }
}

function parseStreamLine(line: string): ClaudeStreamMessage | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as ClaudeStreamMessage
      : null;
  } catch {
    return null;
  }
}
