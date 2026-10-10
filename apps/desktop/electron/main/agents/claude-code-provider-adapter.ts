import { ClaudeCompaction, type ClaudeStartupDeadline } from "./claude-compaction.js";
import { MANAGED_ROOM_WORK_INSTRUCTIONS } from "./desktop-event-prompt-format.js";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { claudeToolOperation } from "../../../../../shared/claude-tool-operation.mjs";
import { providerAcquisitionIdentity, retainProviderAcquisitionEvidence } from "../../../../../shared/provider-acquisition-evidence.mjs";
import { NO_REPLY_FAILURE } from "../../../../../shared/room-turn-no-reply.mjs";
import type { ClaudePermissionObservation, ClaudeNativePermissionRequest, ProviderPermissionDispatchOptions } from "../../../shared/provider-permissions.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { desktopRuntimeEnvironment } from "../desktop-shell-environment.js";

import {
  synthesizeTerminalPayload,
  sameProviderConnectionIdentity,
  PROCESS_ENDED_DURING_TURN,
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
import { attestProviderSpawnPolicy, ownerSetupUnusedOptionsNotice, ownerSetupUnusedOptionsSaidOnce, spawnUsesHomeHarness } from "./provider-spawn-configuration.js";
import { withoutRoomAuthority } from "./room-authority-environment.js";
import { managedCommitEnvironmentFor } from "./managed-agent-commit-identity.js";
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
  claudeApiErrorCategory,
  claudeUsageLimitRejected,
  exactClaudeStreamTerminal,
  recoverExactClaudeTurnFromSession,
  recoverExactClaudeTurnFailureFromSession,
  type ClaudeEvidenceRecord,
  type ClaudeExactTurnFailure,
  type ClaudeExactTurnResult,
} from "./claude-room-turn-evidence.js";
import { resolveLetAgentsMcpRuntime, type LetAgentsMcpRuntime } from "./letagents-mcp-runtime.js";
import { apiUrl as desktopApiUrl } from "../paths.js";
import { claudeApprovalProfileLabel, requireSupportedClaudeCodeVersion, resolveClaudeCodeExecutable } from "./claude-code-version.js";

// Claude Code through its native headless CLI. The daemon owns room ingress,
// exact-turn dispatch, retry, credentials, and publication; this adapter owns
// only the native process/session boundary. The Add Agent launch policy is
// forwarded verbatim, while LetAgents MCP effects borrow the daemon's exact
// generation grant instead of inheriting desktop owner authority.

const INIT_TIMEOUT_MS = 30_000;
// Resuming re-reads the whole saved conversation. With the provider's prompt
// cache expired, a ~110k-token session took 10 s to answer the bootstrap turn
// on an idle machine and over 30 s during a daemon handoff. Waiting costs no
// tokens; failing does, since the deadline is not retried and the user must
// restart the agent by hand.
const RESUME_INIT_TIMEOUT_MS = 90_000;
// With the owner's own setup on, Claude also starts the owner's MCP servers
// and prints `init` only once each has connected or run out of time. Its own
// limit for that is 30 s, the whole of the budget above, so one server that
// never answers used to fail the launch. The limit is now set explicitly, to
// Claude's own default so that no server is cut off sooner than when the
// owner runs Claude themselves, and the launch's budget grows by the same
// amount. A smaller limit the owner already set is kept. A larger one is
// capped, so the wait always fits the budget.
const OWNER_MCP_STARTUP_TIMEOUT_MS = 30_000;
const OWNER_MCP_STARTUP_TIMEOUT_MAX_MS = 45_000;
// Claude connects stdio servers three at a time, in order, and the room's own
// server comes after the owner's. Three of the owner's that never answer
// would hold the room's server back until they ran out of time, and the
// launch would fail for want of the room. Connecting them all at once means
// no server of the owner's can stand in front of the room's.
const OWNER_MCP_CONNECTION_BATCH_SIZE = 256;

/**
 * What Claude is told when it also starts the owner's servers: how to start
 * MCP servers, and, for a launch that reads the owner's settings alone, to
 * still read the instructions in the agent's work folder (`projectInstructions`).
 */
export function claudeOwnerSetupStartEnvironment(startupMs: number, projectInstructions = false): Record<string, string> {
  return {
    MCP_TIMEOUT: String(startupMs),
    MCP_SERVER_CONNECTION_BATCH_SIZE: String(OWNER_MCP_CONNECTION_BATCH_SIZE),
    MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE: String(OWNER_MCP_CONNECTION_BATCH_SIZE),
    ...(projectInstructions ? { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" } : {}),
  };
}

/**
 * The same values as settings given on the command line. The owner's own
 * `settings.json` may set them in its `env`, and that replaces the process
 * environment; settings given on the command line replace the owner's in turn.
 */
function claudeOwnerSetupSettings(startupMs: number, projectInstructions: boolean): string {
  return JSON.stringify({ env: claudeOwnerSetupStartEnvironment(startupMs, projectInstructions) });
}

/**
 * A policy that names no setting sources reads every one: the owner's, the
 * project's and the folder's local ones. That is Full access. With the
 * owner's setup on, a project's settings, hooks, skills, commands and
 * `.mcp.json` servers would then run beside the owner's own tools, and its
 * settings `env` would reach the owner's servers. Such a launch reads the
 * owner's settings alone, like every other access level does, and is given
 * the work folder as an added directory so the project's `CLAUDE.md` still
 * loads. The other access levels never read a project's instructions, with
 * or without the owner's setup, so they are left as they are.
 */
export function claudeOwnerSetupReadsProjectInstructionsOnly(policyArgs: readonly string[]): boolean {
  return !policyArgs.includes("--setting-sources");
}

/**
 * The arguments with one flag set to one value: where the flag first stands
 * when it is there already, at the end otherwise, and nowhere else. With the
 * owner's setup the launch says what these flags are; nothing the arguments
 * carried before decides them, by being there first or by being there last.
 */
function withFlagSetTo(args: readonly string[], flag: string, value: string | null): string[] {
  const set: string[] = [];
  let placed = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      set.push(args[index]!);
      continue;
    }
    index += 1;
    if (!placed && value !== null) set.push(flag, value);
    placed = true;
  }
  if (!placed && value !== null) set.push(flag, value);
  return set;
}

/** How long the owner's own MCP servers get to start, given the limit the owner's environment already sets. */
export function ownerMcpStartupTimeoutMs(configured: string | undefined): number {
  const own = /^[1-9][0-9]{0,8}$/.test(configured?.trim() ?? "") ? Number(configured!.trim()) : null;
  return own === null ? OWNER_MCP_STARTUP_TIMEOUT_MS : Math.min(own, OWNER_MCP_STARTUP_TIMEOUT_MAX_MS);
}

/** A name from the owner's own configuration, short and printable enough to show. */
function shownName(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return JSON.stringify(value.trim().replace(/[^\x20-\x7e]/g, "?").slice(0, 64));
}

/**
 * One line for each of the owner's MCP servers that Claude did not connect
 * when it started, so the owner can see which one is missing and why the
 * start was slow. The room's own server is checked separately.
 */
export function ownerMcpServerNotices(init: Record<string, unknown>): string[] {
  const notices: string[] = [];
  for (const row of Array.isArray(init.mcp_servers) ? init.mcp_servers : []) {
    if (!row || typeof row !== "object" || row.name === "letagents" || row.status === "connected") continue;
    const name = shownName(row.name);
    if (!name) continue;
    notices.push(row.status === "pending"
      ? `Your MCP server ${name} was still starting when this agent began, so its tools may be missing.`
      : row.status === "needs-auth"
        ? `Your MCP server ${name} needs you to sign in, so this agent is running without it.`
        : `Your MCP server ${name} did not start, so this agent is running without it.`);
    if (notices.length === 8) break;
  }
  return notices;
}
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
  /** `ownerSetup` marks a launch whose CLI environment the owner's own servers and hooks inherit. */
  launchChild(input: { claudeBin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; ownerSetup?: true }): ClaudeCliChild;
  /** `roomServerEnvironment` is given to the room's server alone, in its own configuration. */
  createLetAgentsMcpConfig(
    req: ProviderSpawnRequest,
    roomServerEnvironment?: Record<string, string>,
  ): Promise<{ path: string; dispose(): Promise<void> }>;
  signalProcess(pid: number, signal: NodeJS.Signals): void;
  /** null means verified absent; undefined means liveness could not be verified. */
  getProcessIdentity(pid: number): string | null | undefined;
  observeProcessExit(pid: number, processIdentity: string): Promise<ProviderProcessExit>;
  /**
   * The rows of a session's transcript, read where the CLI that ran it wrote
   * it (`transcriptsRoot`, its `projects` directory). Null when no transcript
   * for the session is found there: that proves nothing about the turn.
   */
  readSessionRows(sessionId: string, transcriptsRoot?: string): Promise<ClaudeEvidenceRecord[] | null>;
  /** The managed commit identity for this work attempt, or none. */
  resolveCommitEnvironment(req: ProviderSpawnRequest): Promise<Record<string, string>>;
  /** The owner's own `MCP_TIMEOUT`, when their environment sets one. Defaults to the desktop's environment. */
  ownerMcpTimeout?(): string | undefined;
  now(): string;
}

export interface ClaudeCodeProviderAdapterOptions {
  claudeBin?: string;
  dependencies?: Partial<ClaudeCodeProviderAdapterDependencies>;
  activitySink?: (event: ProviderActivityEvent) => void;
  streamSink?: (event: ProviderStreamEvent) => void;
  /** Cumulative startup time outside positively observed compaction. */
  initTimeoutMs?: number;
  /** The same budget for resuming a saved conversation; defaults to initTimeoutMs when only that is set. */
  resumeInitTimeoutMs?: number;
  /** Cumulative time spent compacting during one startup; defaults to five minutes. */
  compactionTimeoutMs?: number;
  /** SIGTERM → SIGKILL escalation window for stop() and the attach-path fence. */
  stopGraceMs?: number;
  /** How long a room turn stays open for a sub-agent that it started; defaults to thirty minutes. */
  backgroundSubagentWaitLimitMs?: number;
  /** How long a room turn stays open for a background command, or other work, that still runs; defaults to two minutes. */
  backgroundCommandWaitLimitMs?: number;
  /** How long the answer to a finished task's notice gets to begin; defaults to five minutes. */
  backgroundNoticeStartLimitMs?: number;
  /** How often a turn that is held open says so again, with the time it has waited; defaults to one minute. */
  backgroundWorkNoticeEveryMs?: number;
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

/**
 * The exact arguments a room agent's CLI starts with. The room's own server
 * is always named explicitly. Without the owner's own setup it is the only
 * MCP configuration Claude reads, so a repo-tracked .mcp.json cannot shadow
 * it. With that setup on, Claude also reads the owner's own servers, and a
 * server named on the command line still wins over one of the same name.
 */
export function claudeCliLaunchArgs(input: {
  approvalProfileLabel: string | null;
  homeHarness: boolean;
  /** How long the owner's MCP servers get to start. Only read with the owner's setup. */
  ownerMcpStartupMs?: number;
  /** The agent's work folder. Only read with the owner's setup, for a policy that names no setting sources. */
  cwd?: string;
  mcpConfigPath: string;
  policyArgs: readonly string[];
  model?: string | null;
  session: { resume: string } | { sessionId: string };
}): string[] {
  const instructionsOnly = input.homeHarness && claudeOwnerSetupReadsProjectInstructionsOnly(input.policyArgs);
  // With the owner's setup these three are what the launch says they are, whatever the arguments said:
  // the owner's settings alone, the launch's own start settings, and no folder but the agent's own.
  const policyArgs = input.homeHarness
    ? [
      ...withFlagSetTo(withFlagSetTo(withFlagSetTo(input.policyArgs,
        "--settings", claudeOwnerSetupSettings(input.ownerMcpStartupMs ?? ownerMcpStartupTimeoutMs(undefined), instructionsOnly)),
      "--setting-sources", "user"), "--add-dir", null),
      ...(instructionsOnly && input.cwd?.trim() ? ["--add-dir", input.cwd] : []),
    ]
    : input.policyArgs;
  return [
    "--print",
    "--verbose",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    // Auto keeps the bridge: anything Claude declines to decide reaches the host.
    ...(input.approvalProfileLabel ? ["--permission-prompt-tool", "stdio"] : []),
    ...(input.homeHarness ? [] : ["--strict-mcp-config"]),
    "--mcp-config", input.mcpConfigPath,
    ...policyArgs,
    ...(input.model ? ["--model", input.model] : []),
    ...("resume" in input.session ? ["--resume", input.session.resume] : ["--session-id", input.session.sessionId]),
  ];
}

/**
 * A request nobody can answer here. With the owner's own setup on, their MCP
 * servers can ask a person for typed input, and their skills can run
 * sub-agents whose tools need approval. LetAgents shows approvals only for
 * the agent's own tool calls, so either would wait forever. Neither can
 * happen without that setup: the room's server never asks, and an agent that
 * asks for approval has no tool that starts a sub-agent.
 */
function unanswerableClaudeRequest(request: unknown): { response: Record<string, unknown>; summary: string } | null {
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const candidate = request as Record<string, unknown>;
  if (candidate.subtype === "elicitation" && candidate.mcp_server_name !== "letagents") {
    const server = shownName(candidate.mcp_server_name);
    return {
      // Declining is what the server sees when a person says no.
      response: { action: "decline" },
      summary: `Declined a request for ${candidate.mode === "url" ? "a sign-in" : "typed input"} from ${server ? `your MCP server ${server}` : "one of your MCP servers"}. LetAgents cannot show it.`,
    };
  }
  if (candidate.subtype === "can_use_tool" && candidate.agent_id != null) {
    const tool = shownName(candidate.tool_name);
    return {
      response: { behavior: "deny", message: "LetAgents cannot show an approval for a sub-agent's action, so it was not allowed." },
      summary: `Did not allow ${tool ? `the tool ${tool}` : "a tool"} for a skill's helper agent. LetAgents cannot show an approval for it.`,
    };
  }
  return null;
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

/**
 * With the owner's own setup on, Claude also reads their MCP servers, and one
 * of them may be named `letagents` too. The room's server is the one this
 * launch named on the command line, which Claude reports as `dynamic`.
 */
function roomServerIsThisLaunchs(message: ClaudeStreamMessage): boolean {
  const rooms = Array.isArray(message.mcp_servers)
    ? message.mcp_servers.filter(row => row && typeof row === "object" && row.name === "letagents")
    : [];
  return rooms.length === 1 && rooms[0].source === "dynamic";
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

/**
 * A room turn stays open for background work that it started, so the room gets one complete answer.
 *
 * The model can start a shell command or a sub-agent that goes on after the tool call that started it. Claude
 * Code ends the command with the model's interim answer. It tells the model later how the work ended: with the
 * next request of whatever turn is running, or else in a turn of its own, whose result names no command.
 * 1. The turn's own result arrives, and work that the turn started has not been reported to the model: the
 *    turn does not end. Its answer is kept, and its result line is kept back.
 * 2. Each later result that answers the notice of such work adds its text.
 * 3. Work that still runs keeps the turn open up to the limit of its kind. Work that has ended keeps it open
 *    until the model has answered its notice. The turn ends when no work keeps it open. The reply is the
 *    kept texts in their order, with a blank line between them. Empty texts and repeated texts are left out.
 * 4. The turn also ends with what it has when an answer to a notice fails, and when all the work that it
 *    waits for has ended and no answer begins in time. Its owner can end the wait at any time: the reply is
 *    then posted with what the turn has. A reply that lacks something says so in one plain line.
 * 5. One answer can be about several notices: the CLI gives the model every notice that waits with one
 *    request. The answer is the turn's when any of those notices is of the turn's work, and the turn does
 *    not end while such an answer runs.
 * 6. A turn that ends while an answer to a notice still runs, or is due, leaves the CLI free: the adapter
 *    denies what that answer asked the owner to approve, and interrupts it. The next prompt would wait
 *    behind that answer, and behind an approval that nobody can give any more it would wait for ever.
 * An answer to a notice that comes after the turn has ended is not posted, and it ends no other turn.
 */
/** A sub-agent is finite work, and its report is the answer. No turn stays open longer than this. */
export const CLAUDE_BACKGROUND_SUBAGENT_WAIT_LIMIT_MS = 30 * 60_000;
/**
 * A command that runs in the background is often a server or a watcher that is meant to go on. Any other kind
 * of background task has not been captured, and gets this limit too.
 */
export const CLAUDE_BACKGROUND_COMMAND_WAIT_LIMIT_MS = 2 * 60_000;
/**
 * The notice of work that has ended is answered at once: the CLI has nothing else to do. The stream shows no
 * line for the start of that answer, and a notice that the running turn took with its last request gets no
 * answer of its own at all. So a turn whose work has all ended waits this long for a first line, and no longer.
 */
export const CLAUDE_BACKGROUND_NOTICE_START_LIMIT_MS = 5 * 60_000;
/** The turn is held open: the owner reads what it waits for, and for how long. The one event of these that Chat shows. */
export const CLAUDE_BACKGROUND_WORK_METHOD = "letagents/backgroundWork";
/** The result that answers a task's notice. It ends no turn, and its failure is not the agent's. */
export const CLAUDE_BACKGROUND_WORK_ANSWER_METHOD = "letagents/backgroundWorkAnswer";
/** The same result when no room turn runs: the agent is idle after it. */
export const CLAUDE_BACKGROUND_WORK_FINISHED_METHOD = "letagents/backgroundWorkFinished";
/**
 * The daemon's room-level state carries the newest sixteen activity events of an agent, and Chat reads the wait
 * from them. So a turn that is held open says again what it waits for after this many other lines.
 */
const CLAUDE_BACKGROUND_WORK_NOTICE_EVERY_LINES = 8;
const wholeMinutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
export const CLAUDE_BACKGROUND_WORK_TEXT = {
  // Added to the room reply, as one line after the model's texts. Each is true for every case that posts it.
  /** A command passed its limit: a server or a watcher that goes on, or a long command. That is no fault. */
  commandStillRuns: "A command that this turn started was still running in the background when this reply was posted. Claude's later answer about it will not be posted.",
  /** Work of a kind that is not known passed its limit. */
  stillRunning: "Background work that this turn started was still running when this reply was posted. Claude's later answer about it will not be posted.",
  /** A sub-agent passed its limit, and was stopped with the turn. Its report was the answer, so this is a fault. */
  subagentTimedOut: "A sub-agent that this turn started did not finish in the time allowed, and was stopped. Its report is not in this reply and will not be posted.",
  /** A sub-agent still ran when the turn ended for another reason, and was stopped with the turn. */
  subagentStopped: "A sub-agent that this turn started still ran when the turn ended, and was stopped. Its report is not in this reply and will not be posted.",
  /** The work had ended, and the answer to its notice failed or was not there in time. */
  notReported: "Background work that this turn started has ended, but Claude's report on it is not in this reply.",
  /** The owner ended the wait: with Stop, or with "Post answer now". Only the owner's request to stop the turn posts it. */
  ownerEnded: "The owner ended the wait for background work that this turn started. A later result will not be posted.",
  /**
   * The live result was missed, and the reply was read from the session. The rows that were read for the turn
   * hold no notice of some of its work: the work still ran when the session ended, or it was stopped, or
   * another prompt came before its notice. True for each of these.
   */
  noReportInSession: "This reply was read from Claude's saved session. A report on background work that this turn started is missing from it.",
  // For the owner, in the agent's activity.
  limitReached: "The wait for background work reached its time limit. The turn was ended, and a later result will not be posted to the room.",
  noAnswerBegan: "Background work has ended and Claude gave no further answer about it. The turn was ended with the answer it had.",
  answerFailed: "Claude could not answer about background work that ended:",
  /** An answer that no open turn waits for: its turn has ended, or the work never had one. */
  notPosted: "Claude answered about background work that no open room turn waits for. The answer was not posted to the room.",
  /** The same, for an answer that was interrupted or that failed. */
  notPostedUnfinished: "An answer about background work that no open room turn waits for was stopped or failed. Nothing was posted to the room.",
} as const;

/**
 * What the owner reads while a turn is held open: the work that still keeps it open, by kind, in the model's
 * own short descriptions. The times stand before the descriptions, because Chat cuts a long line at its end.
 * `endedMs` is how long ago the last of the work ended, for a turn that only waits for the answer about it.
 */
export function claudeBackgroundWorkWaitSummary(
  waitsFor: ReadonlyArray<{ description: string; kind: "subagent" | "command" | "other"; running: boolean }>,
  waitedMs: number,
  endedMs = 0,
  commandLimitMs = CLAUDE_BACKGROUND_COMMAND_WAIT_LIMIT_MS,
): string {
  const time = (ms: number) => ms < 60_000 ? "under 1 min" : `${Math.floor(ms / 60_000)} min`;
  const named = (subagent: boolean) => {
    const all = waitsFor.filter((task) => task.running && (task.kind === "subagent") === subagent).map((task) => `"${task.description}"`);
    return { count: all.length, list: `${all.slice(0, 3).join(", ")}${all.length > 3 ? ` and ${all.length - 3} more` : ""}` };
  };
  const subagents = named(true);
  const others = named(false);
  // Only a shell command is called a command. Work of another kind is waited for as long, and has no name here.
  const whatElse = waitsFor.some((task) => task.running && task.kind === "other") ? "background work"
    : others.count === 1 ? "a background command" : "background commands";
  const forOthers = `up to ${wholeMinutes(commandLimitMs)} min for ${whatElse}: ${others.list}.`;
  if (subagents.count) {
    return `Waiting for ${subagents.count === 1 ? "a sub-agent" : "sub-agents"} to finish (${time(waitedMs)}): ${subagents.list}.${others.count ? ` Also ${forOthers}` : ""}`;
  }
  return others.count ? `Waiting ${forOthers}` : `Waiting for Claude's answer about background work that ended ${time(endedMs)} ago.`;
}

/** The model's own short description of a task, as one printable line. */
function shownTaskDescription(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return text || "a task";
}

/** The result of the turn that Claude Code runs by itself for the notice of a background task. It names no command. */
function isClaudeTaskNoticeResult(message: ClaudeStreamMessage, sessionId: string): boolean {
  const origin = message.origin as { kind?: unknown } | null | undefined;
  return message.type === "result" && message.user_message_uuid == null && origin?.kind === "task-notification"
    && sessionIdOf(message) === sessionId;
}

type ClaudeHeldRoomTurn = {
  turnId: string;
  /** The turn's own result line. It is published when the turn ends. */
  result: ClaudeStreamMessage;
  /** What the model wrote for the room: the turn's own answer, then each answer to a notice. */
  answers: string[];
  sinceMs: number;
  /** A line of the answer to a notice has been seen, and its result has not. */
  answering: boolean;
  /** Since when all the work that the turn waits for has ended, and no line of an answer has been seen. */
  answerDueSinceMs: number | null;
  /** Since when none of the turn's work runs. */
  endedSinceMs: number | null;
  /** The lines that were published since the turn last said what it waits for. */
  linesSinceNotice: number;
  /** Says again, at a fixed pace, what the turn waits for. */
  notice: ReturnType<typeof setInterval>;
  /** Looks again when the next limit is reached. */
  wake: ReturnType<typeof setTimeout> | null;
};

const CLAUDE_API_ERROR_CATEGORIES = new Set([
  "authentication_failed", "oauth_org_not_allowed", "billing_error", "rate_limit",
  "overloaded", "invalid_request", "model_not_found", "server_error", "unknown", "max_output_tokens",
]);
/** Year 2100: a later value is a millisecond timestamp or garbage, not a reset time in seconds. */
const CLAUDE_MAX_RESET_EPOCH_SECONDS = 4_102_444_800;
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
  private limitResetsAtMs: number | null = null;
  private result: string | null = null;
  private uncorrelatedResult: string | null = null;
  private readonly lineTypes = new Map<string, number>();
  private lastLineType: string | null = null;
  private lastLineMs = 0;

  constructor(private readonly sessionId: string, private readonly turnId: string, private readonly budgetMs: number) {}

  initialized(): void { this.initializedAt = performance.now(); }

  /** The allowlisted API error category Claude reported for the bootstrap turn. */
  get apiError(): string | null { return this.assistantError; }

  /** When Claude said the rejecting usage limit resets (epoch ms), if it said so. */
  get usageLimitResetsAtMs(): number | null { return this.limitResetsAtMs; }

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
    } else if (message.type === "rate_limit_event") {
      // The CLI reports each usage window it reads. Only a rejected one names
      // the reset that matters, as epoch seconds (SDKRateLimitEvent). A value
      // outside the seconds range is not that field, so it is not trusted.
      // With several rejected windows the agent is limited until the latest.
      const info = message.rate_limit_info as { status?: unknown; resetsAt?: unknown } | null | undefined;
      if (info?.status === "rejected" && typeof info.resetsAt === "number" && Number.isSafeInteger(info.resetsAt)
        && info.resetsAt > 0 && info.resetsAt <= CLAUDE_MAX_RESET_EPOCH_SECONDS) {
        this.limitResetsAtMs = Math.max(this.limitResetsAtMs ?? 0, info.resetsAt * 1000);
      }
    } else if (message.type === "auth_status") {
      this.authMessages = Math.min(Number.MAX_SAFE_INTEGER, this.authMessages + 1);
      this.authenticating = typeof message.isAuthenticating === "boolean" ? message.isAuthenticating : null;
    }
  }

  summary(child: ClaudeCliChild, compactionFields: string[] = []): string {
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
      ...compactionFields,
      ...(this.lastApiRetry === null ? [] : [`last_api_retry=${this.lastApiRetry}`]),
      ...(this.assistantError === null ? [] : [`assistant_error=${this.assistantError}`]),
      ...(this.limitResetsAtMs === null ? [] : [`usage_limit_resets_at=${new Date(this.limitResetsAtMs).toISOString()}`]),
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

/**
 * What the owner reads when Claude Code ended the prompt that starts an agent
 * with no call to the model. It repeats nothing of the CLI's text, which can
 * hold a hook's words, a path of the owner's machine, and the prompt.
 *
 * `namesSettingSources`: the launch told Claude Code which settings to read.
 * An access level that does so reads the owner's settings alone with the
 * owner's setup on, and no settings at all with it off: only then is turning
 * the setup off a way out. A launch that names none reads the owner's
 * settings, the project's and the folder's local ones.
 */
export function claudeStartWithoutModelText(input: {
  modelNotCalled: "hook_stopped_prompt" | "unknown"; ownerSetup: boolean; namesSettingSources: boolean;
}): string {
  if (input.modelNotCalled !== "hook_stopped_prompt") {
    return "Claude Code ended the prompt that LetAgents sends to start this agent without a call to the model, so the agent did not start.";
  }
  const stopped = "A UserPromptSubmit hook stopped the prompt that LetAgents sends to start this agent";
  const change = "Change the hook so that it lets this prompt through, then try again.";
  if (input.ownerSetup) {
    // "with your own setup": the desktop shows a start that was refused over the owner's setup in the launch's own words.
    return `${stopped}, so the agent cannot start with your own setup while the hook stops that prompt. `
      + `With your own setup on, Claude Code runs the hooks of your own Claude Code settings and plugins. ${change}`
      + (input.namesSettingSources
        ? " Or turn off \"Use your own Claude Code setup\" for this agent: it then reads none of your Claude Code settings, so their hooks do not run."
        : "");
  }
  return `${stopped}, so the agent cannot start while the hook stops that prompt. `
    + `${input.namesSettingSources ? "" : "This agent runs the hooks of your Claude Code settings and of the project's settings. "}${change}`;
}

class ClaudeBootstrapError extends Error {
  readonly name = "ClaudeBootstrapError";
  readonly reason: ClaudeStartupDeadline | "native_exit" | "transport_error" | "failed_response";
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  /** The account's usage limit rejected the turn; retrying only helps after it resets. */
  readonly providerQuotaExhausted?: true;
  /** When Claude said that usage limit resets (epoch ms); absent when it did not say. */
  readonly providerQuotaResetsAtMs?: number;
  /** Claude reported a service-side failure that a fresh attempt may clear. */
  readonly transientProviderStart?: true;

  constructor(
    readonly phase: "init" | "bootstrap_turn",
    failure: ProviderProcessExit | { type: ClaudeStartupDeadline | "failed_response" },
    observations: string,
    apiError: string | null = null,
    limitResetsAtMs: number | null = null,
    /** Plain words for the owner, in place of the boundary that was observed. */
    said: string | null = null,
  ) {
    const reason = failure.type === "exit" ? "native_exit"
      : failure.type === "error" ? "transport_error" : failure.type;
    const prefix = phase === "init" ? "Claude CLI did not report its stream-json init message"
      : "Claude CLI did not complete its daemon-safe bootstrap turn";
    // Preserve the observed boundary without copying native error/result text
    // into supervisor diagnostics. Transport loss is not a physical death proof.
    super(said !== null ? [said, observations].filter(Boolean).join(" ")
      : `${prefix} (${reason}${failure.type === "exit" ? `; exit code ${failure.code ?? "unknown"}; signal ${failure.signal ?? "none"}` : ""}). ${observations}`);
    this.reason = reason;
    if (failure.type === "exit") {
      this.exitCode = failure.code;
      this.signal = failure.signal;
    }
    // Only an explicit API rejection of the bootstrap turn is classified. A
    // deadline stays unretried: a stalled resume can spend tokens each time.
    if (reason === "failed_response" && apiError === "rate_limit") {
      this.providerQuotaExhausted = true;
      if (limitResetsAtMs !== null) this.providerQuotaResetsAtMs = limitResetsAtMs;
    }
    if (reason === "failed_response" && (apiError === "overloaded" || apiError === "server_error")) this.transientProviderStart = true;
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

/**
 * The environment the CLI itself runs in. Claude hands it to every MCP server,
 * hook and command it starts. With the owner's own setup on those are the
 * owner's programs, so nothing that lets a process act as the room agent may
 * be in it; the room's server is given the coordinates in its own configuration.
 */
export function claudeChildEnvironment(
  input: { env?: NodeJS.ProcessEnv; ownerSetup?: true },
  base: NodeJS.ProcessEnv = desktopRuntimeEnvironment(),
): NodeJS.ProcessEnv {
  const env = claudeCliEnv(base, input.env);
  return input.ownerSetup ? withoutRoomAuthority(env) : env;
}

function defaultLaunchChild(input: { claudeBin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; ownerSetup?: true }): ClaudeCliChild {
  const child = spawn(input.claudeBin, input.args, {
    cwd: input.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group: group-signalling (shared defaultSignalProcess
    // targets -pid first) reaps the CLI's descendants too, and the child is not
    // torn down as a side effect of the supervisor's own stdio going away.
    detached: process.platform !== "win32",
    // The strict launch config supplies the API endpoint; these coordinates
    // make every LetAgents MCP effect borrow the exact daemon generation.
    env: claudeChildEnvironment(input),
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
  roomServerEnvironment: Record<string, string> = {},
): Promise<{ path: string; dispose(): Promise<void> }> {
  const normalizedApiUrl = apiBaseUrl.trim();
  if (!normalizedApiUrl) {
    throw new Error("Claude's managed LetAgents endpoint is unavailable.");
  }
  return createEphemeralClaudeMcpConfig(
    { ...roomServerEnvironment, LETAGENTS_API_URL: normalizedApiUrl },
    resolveRuntime(devEntryPath),
    temporaryRoot,
  );
}

export function claudeSessionTranscriptCandidates(entries: string[], sessionId: string): string[] {
  const suffix = `${sessionId}.jsonl`;
  return entries.filter((entry) => entry.split(/[\\/]/).at(-1) === suffix);
}

/**
 * Where a Claude CLI started with this environment keeps its session
 * transcripts: `CLAUDE_CONFIG_DIR` when it is set, otherwise `.claude` in its
 * home directory, as Claude Code resolves it.
 */
export function claudeTranscriptsRoot(environment: NodeJS.ProcessEnv): string {
  const configDir = environment.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? join(configDir, "projects") : join(environment.HOME?.trim() || homedir(), ".claude", "projects");
}

async function defaultReadSessionRows(sessionId: string, transcriptsRoot = claudeTranscriptsRoot(claudeCliEnv())): Promise<ClaudeEvidenceRecord[] | null> {
  const projectsRoot = transcriptsRoot;
  let entries: string[];
  try {
    entries = await readdir(projectsRoot, { recursive: true });
  } catch {
    return null;
  }
  const matches = claudeSessionTranscriptCandidates(entries, sessionId);
  if (matches.length > 1) {
    throw new ClaudeRoomTurnRecoveryError(
      "Claude room-turn recovery found more than one transcript for the exact continuation.",
    );
  }
  if (!matches[0]) return null;
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
  resolveCommitEnvironment: managedCommitEnvironmentFor,
  createLetAgentsMcpConfig: (req, roomServerEnvironment) => createManagedClaudeMcpConfig(
    req.supervisorWorkerSession?.apiUrl ?? desktopApiUrl, tmpdir(), req.devMcpServerEntryPath, undefined, roomServerEnvironment,
  ),
  signalProcess: defaultSignalProcess,
  getProcessIdentity: defaultGetProcessIdentity,
  observeProcessExit: defaultObserveProcessExit,
  readSessionRows: defaultReadSessionRows,
  now: () => new Date().toISOString(),
};

class ClaudeProviderHandle implements ProviderHandle {
  /** Owner-visible warnings from this launch; the daemon records each in the agent's activity. */
  launchNotices: readonly string[] = [];
  /** The process was started with its owner's own Claude Code setup. */
  ownerSetup = false;
  /** Where this process writes its session transcripts, as its environment decides. */
  transcriptsRoot: string | undefined;
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
  /** Turns whose own result proved that they completed, and carried no answer. */
  readonly roomTurnsWithoutAnswer = new Set<string>();
  /** Claude Code's name for the API error that the running turn's stream last carried. */
  roomTurnApiError: { turnId: string; category: string } | null = null;
  /** The turn whose stream reported a usage window of the account that rejected a request. */
  roomTurnUsageLimit: string | null = null;
  activeRoomTurnId: string | null = null;
  /**
   * Work the CLI runs in the background, by its task id, until the model has been told how it ended. `turnId`
   * is the room turn that started it; work that no room turn started has none. `sinceMs` is when it was first seen.
   */
  readonly backgroundTasks = new Map<string, { turnId: string | null; description: string; type: unknown; sinceMs: number }>();
  /** Ended background tasks whose notice the model has still to be given, in the order the CLI reported them. */
  readonly taskNotices: string[] = [];
  /** The tasks whose notices the answer that is running has been given. They are reported when that answer ends. */
  readonly noticeAnswerTasks: string[] = [];
  /** The room turn whose own result has arrived, and which stays open for background work it started. */
  heldRoomTurn: ClaudeHeldRoomTurn | null = null;
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
  /** `hostDenied` is set once this adapter has written the host's deny for the tool's permission request. */
  readonly executionTools = new Map<string, { operation: Extract<NativeExecutionFact, { domain: "execution" }>["operation"]; completed: boolean; name: string; input: unknown; hostDenied?: true }>();
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
  private readonly resumeInitTimeoutMs: number;
  private readonly compactionTimeoutMs: number;
  private readonly compactions = new Map<string, ClaudeCompaction>();
  private readonly handleCompactions = new WeakMap<ClaudeProviderHandle, ClaudeCompaction>();
  private readonly stopGraceMs: number;
  private readonly backgroundSubagentWaitLimitMs: number;
  private readonly backgroundCommandWaitLimitMs: number;
  private readonly backgroundNoticeStartLimitMs: number;
  private readonly backgroundWorkNoticeEveryMs: number;
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
    this.resumeInitTimeoutMs = options.resumeInitTimeoutMs ?? options.initTimeoutMs ?? RESUME_INIT_TIMEOUT_MS;
    this.compactionTimeoutMs = options.compactionTimeoutMs ?? 300_000;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.backgroundSubagentWaitLimitMs = options.backgroundSubagentWaitLimitMs ?? CLAUDE_BACKGROUND_SUBAGENT_WAIT_LIMIT_MS;
    this.backgroundCommandWaitLimitMs = options.backgroundCommandWaitLimitMs ?? CLAUDE_BACKGROUND_COMMAND_WAIT_LIMIT_MS;
    this.backgroundNoticeStartLimitMs = options.backgroundNoticeStartLimitMs ?? CLAUDE_BACKGROUND_NOTICE_START_LIMIT_MS;
    this.backgroundWorkNoticeEveryMs = options.backgroundWorkNoticeEveryMs ?? 60_000;
  }

  runtimeCustody(workAttemptId: string, providerHandle?: ProviderHandle): "absent" | "owned" | "unknown" {
    const handle = this.handles.get(workAttemptId);
    return this.processCustody.state(workAttemptId, handle === providerHandle ? handle?.child : undefined);
  }

  compactionProgress(workAttemptId: string): { state: "compacting"; startedAt: string } | null {
    return this.compactions.get(workAttemptId)?.progress() ?? null;
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
      const held = handle.heldRoomTurn;
      if (held?.turnId === activeTurnId) {
        // The command has ended with its answer, and the turn only waits for background work. The owner ends
        // that wait: the turn ends now, with the texts it has. Nothing of the turn was interrupted, so the
        // reply stands and is posted. The interrupt that ends the wait stops the answer to a task's notice,
        // and a sub-agent that still runs. A command in the background goes on (each captured).
        this.settleHeldRoomTurn(handle, held, "owner");
        return { capability: "native_interrupt", interrupted: false, resumed: false, state: "idle" };
      }
      handle.pendingInterruptTurnId = activeTurnId!;
      try {
        this.writeInterrupt(handle);
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
    let cutOffByExit = false;
    let providerErrorInSession = false;
    if (!terminal) {
      // The turn's own result already proved that it completed, and carried
      // no answer. This read looks for the answer in the session instead.
      // The process that saw the result holds that proof in memory. The
      // daemon holds it saved, for a read after that process or the daemon
      // itself has ended.
      const completedWithoutAnswer = request.savedAsUnreadable === true || handle.roomTurnsWithoutAnswer.has(turnId);
      // With that proof a session that cannot be read changes nothing: it
      // would be read the same way again, and there is no answer to wait for.
      const rows = await this.deps.readSessionRows(handle.providerContinuationId, handle.transcriptsRoot).catch((error: unknown) => {
        if (!completedWithoutAnswer) throw error;
        return null;
      });
      // No transcript where the CLI writes it proves nothing about the turn:
      // it is left for its owner, as before, rather than settled as cut off.
      if (rows === null && !completedWithoutAnswer) {
        throw new ClaudeRoomTurnRecoveryError("Claude room-turn recovery found no transcript for the conversation where the CLI keeps it.");
      }
      terminal = rows && recoverExactClaudeTurnFromSession(rows, turnId, handle.providerContinuationId);
      // The turn started background work, and the session does not prove the reply complete. The reply says so
      // in one plain line, as a turn that is held open does when it ends before all of that work was answered.
      if (terminal && !("error" in terminal) && terminal.outcome === "reply" && terminal.backgroundWork) {
        terminal = { turnId, outcome: "reply", evidence: terminal.evidence, text: `${terminal.text}\n\n${terminal.backgroundWork === "ended_unreported"
          ? CLAUDE_BACKGROUND_WORK_TEXT.notReported : CLAUDE_BACKGROUND_WORK_TEXT.noReportInSession}` };
      }
      // A turn that ended on a provider error has it in the session; that
      // is how it ended, and its reason is the provider's.
      if (!terminal && rows) {
        terminal = recoverExactClaudeTurnFailureFromSession(rows, turnId, handle.providerContinuationId);
        providerErrorInSession = terminal !== null;
      }
      // Neither the result nor the session holds an answer, and the turn is
      // known to have completed: there is no answer to wait for. Reporting it
      // unreadable once more would block the agent on a read that cannot
      // change. It is the settled failure every provider reports for a model
      // that wrote no reply, which task continuity knows how to follow up.
      if (completedWithoutAnswer && (!terminal || (!("error" in terminal) && terminal.outcome === "unreadable"))) {
        terminal = { turnId, nativeOutcome: "failed", error: NO_REPLY_FAILURE.emptyAnswer };
      }
      // The session holds no ending for this turn, and the process that ran
      // it has ended: no ending will ever be written. The turn was cut off by
      // that exit, and is reported as that instead of being waited for. A last
      // message with no answer in it is no ending either: the CLI goes on
      // after such a message, and only the turn's own result, which was not
      // seen here, could prove that the turn ended there.
      if ((!terminal || (!("error" in terminal) && terminal.outcome === "unreadable")) && request.originProcessEnded) {
        cutOffByExit = true;
        terminal = { turnId, nativeOutcome: "interrupted", error: PROCESS_ENDED_DURING_TURN };
      }
      // The process that ran this turn exited before it reported the turn's
      // result, and this one is sent no result for a turn that ended before
      // it started. The session's own record is then the only place the
      // ending exists. The daemon says when its execution record still holds
      // the turn open; the ending is recorded there too, or the turn would
      // refuse every later turn of this agent.
      if (terminal && request.recordEnding && nativeExecutionId(handle.providerContinuationId) && nativeExecutionId(turnId)) {
        handle.execution.emit({ domain: "turn", kind: "state_changed", state: "terminal", sideEffects: "none",
          providerContinuationId: handle.providerContinuationId, providerTurnId: turnId,
          turnOutcome: "error" in terminal ? terminal.nativeOutcome
            : terminal.outcome === "unreadable" ? "unreadable" : "completed" },
        handle.providerConnection.kind === "claude_cli" ? handle.providerConnection.processIdentity ?? undefined : undefined,
        handle.providerConnection.kind === "claude_cli" ? handle.providerConnection.pid ?? undefined : undefined);
      }
    }
    if (!terminal) {
      throw new ClaudeRoomTurnRecoveryError(
        "Claude room-turn recovery cannot prove the persisted exact turn reached a terminal boundary.",
      );
    }

    // What was read is the session's own record of the turn, not a stream.
    const result: ProviderRoomTurnResult = cutOffByExit
      ? { turnId, providerContinuationId: handle.providerContinuationId, outcome: "interrupted", text: null, evidence: "transcript", error: PROCESS_ENDED_DURING_TURN }
      : providerErrorInSession ? { ...this.providerRoomTurnResult(handle, terminal), evidence: "transcript" } as ProviderRoomTurnResult
        : this.providerRoomTurnResult(handle, terminal);
    await options.checkpointTerminalResult?.(result);
    if (!("error" in terminal) || options.checkpointTerminalResult) handle.roomTurnResults.delete(turnId);
    if (result.outcome !== "unreadable") handle.roomTurnsWithoutAnswer.delete(turnId);
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
      // Remember the deny for this exact tool, so its error result can be told from any other failure.
      if (reply === "reject") {
        const denied = handle.executionTools.get(pending.native.request.tool_use_id);
        if (denied) denied.hostDenied = true;
      }
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
    const unanswerable = unanswerableClaudeRequest(message.request);
    if (unanswerable) {
      try {
        handle.child.writeLine(JSON.stringify({ type: "control_response", response: {
          subtype: "success", request_id: message.request_id, response: unanswerable.response,
        } }));
      } catch { return; /* The CLI is gone; its exit is observed separately. */ }
      // The owner sees in the agent's activity that something was turned down, and whose it was.
      // The daemon builds an agent's activity from its stream, so that is where it is said.
      this.publishStream(handle, "control_request/declined", {}, "provider_event", null, null, unanswerable.summary);
      this.heldRoomTurnPublished(handle);
      return;
    }
    const request = message.request as ClaudeNativePermissionRequest["request"] | undefined;
    const turnId = handle.activeRoomTurnId;
    if (!request || request.agent_id != null || request.subtype !== "can_use_tool"
      || typeof request.tool_name !== "string" || !request.tool_name.trim()
      || typeof request.tool_use_id !== "string" || !request.tool_use_id.trim()
      || !request.input || typeof request.input !== "object" || Array.isArray(request.input)) return;
    if (!turnId || handle.executionTurnId !== turnId || !handle.executionTurnStarted) {
      // No room turn has started, so no approval can be shown: an approval belongs to a turn. This is the answer
      // to the notice of a task whose turn has ended. The CLI would wait for it, and the next prompt behind it.
      try {
        handle.child.writeLine(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
          response: { behavior: "deny", message: "No room turn is open that an approval could be shown for, so this action was not allowed." } } }));
      } catch { return; /* The CLI is gone; its exit is observed separately. */ }
      handle.seenPermissionRequestIds.add(message.request_id);
      this.publishStream(handle, "control_request/declined", {}, "provider_event", null, null,
        `Did not allow the tool ${shownName(request.tool_name)}, which Claude asked for outside a room turn. LetAgents shows an approval only for a turn that is open.`);
      return;
    }
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
    const approvalProfileLabel = claudeApprovalProfileLabel(req.permissionProfileId);
    requireSupportedClaudeCodeVersion(versionOutput, approvalProfileLabel);

    const homeHarness = spawnUsesHomeHarness("claude-code", req);
    // With the owner's setup this is the access level's own options and nothing else the stored policy holds.
    const attestedPolicy = attestProviderSpawnPolicy("claude-code", req);
    const policyArgs = claudeLaunchPolicyArgs(attestedPolicy);
    // A workspace that would commit as the host's global Git identity commits
    // as the owner's GitHub noreply identity instead; rentals never get one.
    const commitEnvironment = await this.deps.resolveCommitEnvironment(req);
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
    // Claude hands its own environment to every MCP server and hook it
    // starts. With the owner's own setup on those include the owner's, so the
    // coordinates go to the room's server alone, in its own configuration.
    if (homeHarness && !supervisorEnv) {
      throw new Error("Claude can use its owner's own setup only as a daemon-supervised room agent.");
    }
    const managedMcpConfig = homeHarness
      ? await this.deps.createLetAgentsMcpConfig(req, supervisorEnv)
      : await this.deps.createLetAgentsMcpConfig(req);
    // Use an explicit strict config so a repo-tracked .mcp.json cannot shadow
    // the managed room workplace. The short-lived 0600 config lives outside
    // the worktree, its path (never its credential) enters argv, and it is
    // deleted as soon as Claude reports the initialized MCP workplace.
    // The spike (msg_1382) proved both identity paths: a minted --session-id is
    // honored verbatim on fresh spawns, and --resume continues the SAME session
    // id. Either way the continuation is asserted against init below.
    const expectedSessionId = resumeRef ? resumeRef.providerContinuationId : randomUUID();
    const bootstrapTurnId = randomUUID();
    const ownerMcpStartupMs = homeHarness ? ownerMcpStartupTimeoutMs(this.deps.ownerMcpTimeout?.() ?? desktopRuntimeEnvironment().MCP_TIMEOUT) : 0;
    const args = claudeCliLaunchArgs({
      approvalProfileLabel,
      homeHarness,
      ...(homeHarness ? { ownerMcpStartupMs, cwd: req.cwd } : {}),
      mcpConfigPath: managedMcpConfig.path,
      policyArgs,
      model: req.model,
      session: resumeRef ? { resume: resumeRef.providerContinuationId } : { sessionId: expectedSessionId },
    });
    // With the owner's setup the CLI is told how to start their servers, and is not given the coordinates.
    const launchEnv = homeHarness
      ? { ...commitEnvironment, ...claudeOwnerSetupStartEnvironment(ownerMcpStartupMs, claudeOwnerSetupReadsProjectInstructionsOnly(policyArgs)) }
      : Object.keys(commitEnvironment).length ? { ...commitEnvironment, ...supervisorEnv } : supervisorEnv;
    let child: ClaudeCliChild;
    try {
      child = this.deps.launchChild({
        claudeBin: this.claudeBin, args, cwd: req.cwd, env: launchEnv, ...(homeHarness ? { ownerSetup: true as const } : {}),
      });
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
    // The owner's servers get their own time to start on top of the launch's budget.
    const startupBudgetMs = (resumeRef ? this.resumeInitTimeoutMs : this.initTimeoutMs) + ownerMcpStartupMs;
    const diagnostics = new ClaudeBootstrapDiagnostics(expectedSessionId, bootstrapTurnId, startupBudgetMs);
    const compaction = new ClaudeCompaction(expectedSessionId, startupBudgetMs,
      this.compactionTimeoutMs, this.deps.now, req.onProgress);
    this.compactions.set(req.workAttemptId, compaction);
    const closeCompaction = () => {
      compaction.close();
      if (this.compactions.get(req.workAttemptId) === compaction) this.compactions.delete(req.workAttemptId);
    };
    void child.exited.then(closeCompaction);
    const unsubscribeCompactionDisconnect = child.onDisconnect(() => compaction.clear());
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

    const bootstrapFailure = Symbol("bootstrap-failure");
    const initTimeout = compaction.deadline.then(type => ({ [bootstrapFailure]: { type } }));
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
        const failure = observedInit[bootstrapFailure];
        // A start that ran out of time with the owner's setup on is most often waiting on something of the owner's.
        const waitedOnOwnerSetup = homeHarness && failure.type !== "exit" && failure.type !== "error";
        throw new ClaudeBootstrapError("init", failure, diagnostics.summary(child, compaction.diagnosticFields())
          + (waitedOnOwnerSetup ? " This agent starts with your own Claude Code setup, so one of your MCP servers or hooks may be holding the start up." : ""));
      }
      if (approvalProfileLabel
        && (!Array.isArray(observedInit.capabilities) || !observedInit.capabilities.includes("msg_lifecycle_v1"))) {
        throw new Error("Claude tool approvals require exact native turn lifecycle support. Update Claude Code, then try again.");
      }
      // An account without automatic review starts in another mode. Running
      // there would either prompt for everything or decide nothing.
      if (req.permissionProfileId === "auto_review" && observedInit.permissionMode !== "auto") {
        throw new Error("Claude Code did not start in Auto mode. This account or Claude Code version may not support it. Choose another access level, then try again.");
      }
      // A named but failed server is not a usable room connection.
      if (!hasReadyRoomWorkplace(observedInit)) {
        throw new Error(
          "LetAgents room tools did not connect to Claude; refusing to launch without the room workplace.",
        );
      }
      if (homeHarness && !roomServerIsThisLaunchs(observedInit)) {
        throw new Error(
          "Claude did not report the room's LetAgents server as the one this launch started, so it will not run with your own setup. Update Claude Code, then try again.",
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
      if (homeHarness) {
        const unused = ownerSetupUnusedOptionsSaidOnce.whenChanged(req.supervisorEntryId, ownerSetupUnusedOptionsNotice("Claude Code", req.launchPolicy, attestedPolicy));
        handle.launchNotices = [...ownerMcpServerNotices(observedInit), ...(unused ? [unused] : [])];
      }
      handle.ownerSetup = homeHarness;
      handle.transcriptsRoot = claudeTranscriptsRoot(claudeChildEnvironment({ env: launchEnv, ...(homeHarness ? { ownerSetup: true as const } : {}) }));
      this.handles.set(req.workAttemptId, handle);
      this.handleCompactions.set(handle, compaction);
      const exitPromise = handle.exitEvidence.then((exit) => this.observeExit(handle!, exit));
      this.exitPromises.set(handle, exitPromise);

      diagnostics.initialized();
      // The CLI and its MCP workplace are up. The bootstrap turn below is a
      // model round trip (up to the resume budget), not local launch work.
      try { req.onNativeStarted?.(); } catch { /* a host hint cannot fail the launch */ }
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
        // Claude was up, so it has said which of the owner's servers did not start.
        throw new ClaudeBootstrapError("bootstrap_turn", bootstrapTerminal[bootstrapFailure], diagnostics.summary(child, compaction.diagnosticFields())
          + (handle.launchNotices.length ? ` ${handle.launchNotices.join(" ")}` : ""));
      }
      compaction.checkDeadline();
      if (compaction.failure) {
        throw new ClaudeBootstrapError("bootstrap_turn", { type: compaction.failure }, diagnostics.summary(child, compaction.diagnosticFields()));
      }
      if ("error" in bootstrapTerminal) {
        // Claude Code ended the prompt that starts the agent with no call to the model. The owner reads what
        // happened, and nothing of the CLI's text. A hook that stopped the prompt stops it at each start, so
        // the failure is given no mark of one that passes: no start is tried again by itself, and the agent
        // waits for its owner. A hook's stop needs no list of observations; a cause that is not known does.
        if (bootstrapTerminal.modelNotCalled) {
          throw new ClaudeBootstrapError("bootstrap_turn", { type: "failed_response" },
            bootstrapTerminal.modelNotCalled === "hook_stopped_prompt" ? "" : diagnostics.summary(child, compaction.diagnosticFields()), null, null,
            claudeStartWithoutModelText({ modelNotCalled: bootstrapTerminal.modelNotCalled, ownerSetup: homeHarness,
              namesSettingSources: policyArgs.includes("--setting-sources") }));
        }
        throw new ClaudeBootstrapError("bootstrap_turn", { type: "failed_response" },
          diagnostics.summary(child, compaction.diagnosticFields()), diagnostics.apiError, diagnostics.usageLimitResetsAtMs);
      }
      handle.roomTurnResults.delete(bootstrapTurnId);
      handle.roomTurnsWithoutAnswer.delete(bootstrapTurnId);
      handle.state = "idle";
      handle.execution.emit(
        { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" },
        processIdentity,
        child.pid ?? undefined,
      );
      return handle;
    } catch (error) {
      capturingBootstrap = false;
      closeCompaction();
      unsubscribeCompactionDisconnect();
      if (handle) {
        handle.protocolError = true;
        ownerSetupUnusedOptionsSaidOnce.forget(req.supervisorEntryId, handle.launchNotices);
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
      compaction.finishBootstrap();
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
      this.heldRoomTurnPublished(handle);
      return;
    }
    this.handleCompactions.get(handle)?.observe(message);
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
    let backgroundWork: "same" | "changed" | "tell" = "same";
    if (handle.state !== "failed") {
      backgroundWork = this.observeBackgroundWork(handle, message);
      if (isClaudeTaskNoticeResult(message, handle.providerContinuationId)) {
        // The answer that ends here, or goes on, was given the notice that was first in line.
        const taskId = handle.taskNotices.shift();
        if (taskId !== undefined) handle.noticeAnswerTasks.push(taskId);
        if (!contextualInterruptTurnId && !contextualInterruptReplayTurnId) {
          this.consumeTaskNoticeResult(handle, message);
          return;
        }
        // An interrupt that the owner sent for the running turn can end this answer instead. That stays as it was.
        for (const answered of handle.noticeAnswerTasks.splice(0)) handle.backgroundTasks.delete(answered);
      } else if (this.holdRoomTurn(handle, message)) return;
    }
    const nativeLifecycle = this.observeNativeExecution(
      handle,
      message,
      contextualInterruptTurnId,
      contextualInterruptReplayTurnId,
    );
    // While a turn is held open, what it waits for is what the owner reads: the rows of a sub-agent, and of
    // an answer to a notice, are published as events that Chat does not show in the place of the wait.
    const held = handle.heldRoomTurn;
    const row = message.type === "assistant" || message.type === "user" || message.type === "tool_use_summary";
    this.publishStream(handle, streamMethod(message), message, held && row ? "provider_event" : claudeStreamKind(message),
      nativeLifecycle?.nativeEventId ?? null, nativeLifecycle?.phase ?? null);
    // The line is published first: what it means for a turn that is held open comes after it.
    this.heldRoomTurnPublished(handle, backgroundWork);
    if (nativeLifecycle?.phase === "turn_terminal") this.handleCompactions.get(handle)?.clear();
    const typedAuthority = handle.lifecycleAuthorityMode === "typed";
    if (typedAuthority && nativeLifecycle?.phase === "turn_active") handle.state = "working";
    if (typedAuthority && nativeLifecycle?.phase === "turn_terminal") handle.state = "idle";
    const type = typeof message.type === "string" ? message.type : "";
    if (handle.state === "failed") return;
    // Claude names an API error on the assistant row that carries its text. The row comes before the
    // result, and does not always name its command; the result that follows does.
    const apiErrorCategory = claudeApiErrorCategory(message, handle.providerContinuationId);
    if (apiErrorCategory && handle.activeRoomTurnId
      && (message.user_message_uuid == null || message.user_message_uuid === handle.activeRoomTurnId)) {
      handle.roomTurnApiError = { turnId: handle.activeRoomTurnId, category: apiErrorCategory };
    }
    if (handle.activeRoomTurnId && claudeUsageLimitRejected(message, handle.providerContinuationId)) handle.roomTurnUsageLimit = handle.activeRoomTurnId;
    if (type === "result") {
      const exactTurnId = typeof message.user_message_uuid === "string"
        ? message.user_message_uuid.trim()
        : contextualInterruptTurnId ?? "";
      let exactTurnFailed = false;
      if (exactTurnId) {
        const terminal = contextualInterruptTurnId
          ? { turnId: contextualInterruptTurnId, nativeOutcome: "interrupted" as const, error: "Claude command ended interrupted." }
          : exactClaudeStreamTerminal(message, exactTurnId, handle.providerContinuationId,
            handle.roomTurnApiError?.turnId === exactTurnId ? handle.roomTurnApiError.category : null,
            handle.roomTurnUsageLimit === exactTurnId);
        if (terminal) {
          exactTurnFailed = "error" in terminal && handle.activeRoomTurnId === exactTurnId;
          handle.roomTurnResults.set(exactTurnId, terminal);
          if (!("error" in terminal) && terminal.outcome === "unreadable") handle.roomTurnsWithoutAnswer.add(exactTurnId);
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

  /** The room turn that the CLI is running, once it has reported the command as started. */
  private runningRoomTurn(handle: ClaudeProviderHandle): string | null {
    const turnId = handle.activeRoomTurnId;
    return turnId && !handle.heldRoomTurn && handle.executionTurnStarted && handle.executionTurnId === turnId ? turnId : null;
  }

  /**
   * Ask the CLI to stop what it runs: a turn, the answer to a task's notice, and a sub-agent in the background.
   * A command in the background goes on (each captured).
   */
  private writeInterrupt(handle: ClaudeProviderHandle): void {
    handle.child.writeLine(JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } }));
  }

  /**
   * Follow the background work of the CLI: what started, what ended, and what the model has been told. Says
   * whether this changed what a turn that is held open waits for, and whether its owner is to be told again.
   */
  private observeBackgroundWork(handle: ClaudeProviderHandle, message: ClaudeStreamMessage): "same" | "changed" | "tell" {
    if (sessionIdOf(message) !== handle.providerContinuationId || message.parent_tool_use_id != null) return "same";
    const held = handle.heldRoomTurn;
    let added = false;
    const remember = (task: Record<string, unknown>) => {
      if (typeof task.task_id !== "string" || !task.task_id || task.task_id.length > 128 || handle.backgroundTasks.has(task.task_id)) return;
      if (handle.backgroundTasks.size >= 256) handle.backgroundTasks.delete(handle.backgroundTasks.keys().next().value!);
      // Work that the answer to a notice starts belongs to the turn that is held open for that notice.
      handle.backgroundTasks.set(task.task_id, { turnId: held?.turnId ?? this.runningRoomTurn(handle),
        description: shownTaskDescription(task.description), type: task.task_type, sinceMs: Date.parse(this.deps.now()) });
      added = true;
    };
    if (message.type === "assistant" || message.type === "user") {
      if (message.type === "user") {
        // The turn that is running goes on, and its next request to the model takes every notice that waits
        // (captured for a tool's result; taken to hold for each row that the CLI adds to a turn, because a
        // notice that is wrongly waited for holds its turn open).
        if (this.runningRoomTurn(handle)) {
          // The room turn took them: its own answer is the answer to them.
          for (const taskId of handle.taskNotices.splice(0)) handle.backgroundTasks.delete(taskId);
        } else {
          // The answer to a notice took them. Its own notice stays the first in line until its result.
          handle.noticeAnswerTasks.push(...handle.taskNotices.splice(1));
        }
      }
      // While a turn is held open, only the answer to a notice writes these rows: it has begun.
      if (held) held.answering = true;
      return held ? "changed" : "same";
    }
    if (message.type !== "system") return "same";
    if (message.subtype === "background_tasks_changed" && Array.isArray(message.tasks)) {
      for (const task of message.tasks) if (task && typeof task === "object") remember(task as Record<string, unknown>);
    } else if (message.subtype === "task_started" && message.is_backgrounded === true) {
      remember(message);
    } else if (message.subtype === "task_notification" && typeof message.task_id === "string") {
      const task = handle.backgroundTasks.get(message.task_id);
      // A task that ran inside its tool call reported to the model there, and is not known here.
      if (!task) return "same";
      // The model is not told of a command that was stopped. It is told of a sub-agent that was stopped on
      // request, and not of one that an interrupt stopped (each captured). The two look the same here. An
      // interrupt comes only from this adapter, when a turn ends. So work that was stopped when its turn is
      // not open any more was stopped by that interrupt, or by the model in a later request, which takes the
      // notice itself. No answer to this notice follows: it is not put in line, where it would stand before
      // the notice of a later turn's work. In its own open turn it is put in line, for the turn's next request.
      const open = held?.turnId ?? this.runningRoomTurn(handle);
      if (message.status === "stopped" && (task.type === "local_bash" || !(open && task.turnId === open))) handle.backgroundTasks.delete(message.task_id);
      else if (handle.taskNotices.push(message.task_id) > 256) handle.taskNotices.shift();
      return held && task.turnId === held.turnId ? "tell" : "changed";
    }
    return added && held ? "tell" : "same";
  }

  /**
   * The work of the held turn that the model has not answered about. Work that still runs keeps the turn open
   * until `waitsUntilMs`: the limit of its kind, counted from the turn's own result, or from the start of work
   * that began later.
   */
  private heldRoomTurnWork(handle: ClaudeProviderHandle, held: ClaudeHeldRoomTurn): Array<{ description: string; kind: "subagent" | "command" | "other"; running: boolean; waitsUntilMs: number }> {
    return [...handle.backgroundTasks].filter(([, task]) => task.turnId === held.turnId).map(([taskId, task]) => {
      const kind = task.type === "local_agent" ? "subagent" as const : task.type === "local_bash" ? "command" as const : "other" as const;
      return { description: task.description, kind, running: !handle.taskNotices.includes(taskId) && !handle.noticeAnswerTasks.includes(taskId),
        waitsUntilMs: Math.max(held.sinceMs, task.sinceMs) + (kind === "subagent" ? this.backgroundSubagentWaitLimitMs : this.backgroundCommandWaitLimitMs) };
    });
  }

  /** The turn's own result has arrived. Keep the turn open when work that it started has not been reported to the model. */
  private holdRoomTurn(handle: ClaudeProviderHandle, message: ClaudeStreamMessage): boolean {
    const turnId = handle.activeRoomTurnId;
    // A turn that the owner is stopping ends as it did before.
    if (!turnId || handle.heldRoomTurn || message.type !== "result" || message.user_message_uuid !== turnId
      || handle.pendingInterruptTurnId === turnId
      || ![...handle.backgroundTasks.values()].some((task) => task.turnId === turnId)) return false;
    const own = exactClaudeStreamTerminal(message, turnId, handle.providerContinuationId);
    // Only an answer is held, or the model's word that it has none. A turn that failed ends as it did before.
    if (!own || "error" in own || own.outcome === "unreadable") return false;
    const held: ClaudeHeldRoomTurn = {
      turnId, result: message, answers: own.outcome === "reply" ? [own.text] : [], sinceMs: Date.parse(this.deps.now()),
      answering: false, answerDueSinceMs: null, endedSinceMs: null, linesSinceNotice: 0, wake: null,
      notice: setInterval(() => this.heldRoomTurnChanged(handle, true), this.backgroundWorkNoticeEveryMs),
    };
    // A wait must not keep a process alive that has nothing else to do.
    held.notice.unref?.();
    handle.heldRoomTurn = held;
    if (handle.lifecycleAuthorityMode !== "typed") handle.state = "working";
    this.heldRoomTurnChanged(handle, true);
    return true;
  }

  /**
   * Look at the held turn again: after its work changed, when a limit is reached, and at a fixed pace. The
   * turn ends when no work keeps it open. With `tell`, a turn that stays open says again what it waits for.
   */
  private heldRoomTurnChanged(handle: ClaudeProviderHandle, tell = false): void {
    const held = handle.heldRoomTurn;
    if (!held) return;
    const now = Date.parse(this.deps.now());
    const work = this.heldRoomTurnWork(handle, held);
    // Work that still runs keeps the turn open up to its limit. Work that has ended keeps it open for the answer.
    const waitsFor = work.filter((task) => !task.running || now < task.waitsUntilMs);
    const lastMs = held.sinceMs + this.backgroundSubagentWaitLimitMs;
    if (!waitsFor.length || now >= lastMs) {
      this.settleHeldRoomTurn(handle, held, work.length ? "limit" : "answered");
      return;
    }
    const runs = waitsFor.some((task) => task.running);
    held.endedSinceMs = runs ? null : held.endedSinceMs ?? now;
    // All of it has ended: the CLI has only its answer to give, and it gives that at once.
    held.answerDueSinceMs = held.answering || runs ? null : held.answerDueSinceMs ?? now;
    const answerDueMs = held.answerDueSinceMs === null ? Infinity : held.answerDueSinceMs + this.backgroundNoticeStartLimitMs;
    if (now >= answerDueMs) {
      this.settleHeldRoomTurn(handle, held, "no_answer");
      return;
    }
    const nextMs = Math.min(lastMs, answerDueMs, ...waitsFor.filter((task) => task.running).map((task) => task.waitsUntilMs));
    if (held.wake) clearTimeout(held.wake);
    held.wake = setTimeout(() => this.heldRoomTurnChanged(handle), Math.max(1, nextMs - now));
    held.wake.unref?.();
    if (!tell) return;
    // Say that the turn is held open, for what, and for how long. The daemon builds an agent's activity from its stream.
    held.linesSinceNotice = 0;
    const summary = claudeBackgroundWorkWaitSummary(waitsFor, now - held.sinceMs, now - (held.endedSinceMs ?? now), this.backgroundCommandWaitLimitMs);
    this.publishStream(handle, CLAUDE_BACKGROUND_WORK_METHOD,
      { waiting_for: waitsFor.filter((task) => task.running).map((task) => task.description), waited_ms: now - held.sinceMs }, "provider_event", null, null, summary);
    this.publishActivity(handle, { source: "native_harness", method: CLAUDE_BACKGROUND_WORK_METHOD, summary, status: "working", checking: "", next_action: "" });
  }

  /**
   * A line was published. While a turn is held open, each line moves the wait away from the newest events of
   * the agent, which is all that the daemon keeps: after some lines the turn says again what it waits for.
   */
  private heldRoomTurnPublished(handle: ClaudeProviderHandle, backgroundWork: "same" | "changed" | "tell" = "same"): void {
    const held = handle.heldRoomTurn;
    if (held && (held.linesSinceNotice += 1) >= CLAUDE_BACKGROUND_WORK_NOTICE_EVERY_LINES) backgroundWork = "tell";
    if (backgroundWork !== "same") this.heldRoomTurnChanged(handle, backgroundWork === "tell");
  }

  /** A result of the answer to a task's notice. The notice that was first in line is among `noticeAnswerTasks` now. */
  private consumeTaskNoticeResult(handle: ClaudeProviderHandle, message: ClaudeStreamMessage): void {
    const held = handle.heldRoomTurn;
    // Notices that went to the model with one request each get a result. All but the last of these results
    // are empty and have no turn of the model in them (captured): the answer goes on, for the notices still in line.
    if (message.subtype === "success" && message.is_error === false && message.num_turns === 0 && !String(message.result ?? "").trim()
      && handle.taskNotices.length > 0) {
      this.publishStream(handle, CLAUDE_BACKGROUND_WORK_ANSWER_METHOD, message, "provider_event");
      this.heldRoomTurnChanged(handle);
      return;
    }
    // The answer has ended. It was about every notice that it was given, and it is the held turn's when any of them is.
    const startedBy = handle.noticeAnswerTasks.splice(0).map((taskId) => {
      const turnId = handle.backgroundTasks.get(taskId)?.turnId ?? null;
      handle.backgroundTasks.delete(taskId);
      return turnId;
    });
    if (held) held.answering = false;
    // Read as a turn's own result: the same shapes are an answer, no answer, or a failure with its text.
    const answer = exactClaudeStreamTerminal({ ...message, user_message_uuid: "notice" }, "notice", handle.providerContinuationId);
    const failed = !answer || "error" in answer;
    if (!held || !startedBy.includes(held.turnId)) {
      // No open turn waits for it: its turn has ended, or the work never had one. Nothing is posted, and no turn ends on it.
      this.publishStream(handle, handle.activeRoomTurnId ? CLAUDE_BACKGROUND_WORK_ANSWER_METHOD : CLAUDE_BACKGROUND_WORK_FINISHED_METHOD,
        message, "provider_event", null, null, failed ? CLAUDE_BACKGROUND_WORK_TEXT.notPostedUnfinished : CLAUDE_BACKGROUND_WORK_TEXT.notPosted);
      // No room turn runs, and the answer has ended: the agent is idle.
      if (!handle.activeRoomTurnId && handle.state === "working") handle.state = "idle";
      this.heldRoomTurnChanged(handle, true);
      return;
    }
    if (failed) {
      this.publishStream(handle, CLAUDE_BACKGROUND_WORK_ANSWER_METHOD, message, "provider_event", null, null,
        `${CLAUDE_BACKGROUND_WORK_TEXT.answerFailed} ${String(safeStreamPayload(answer?.error ?? "").payload).slice(0, 300)}`);
      this.settleHeldRoomTurn(handle, held, "answer_failed");
      return;
    }
    this.publishStream(handle, CLAUDE_BACKGROUND_WORK_ANSWER_METHOD, message, "provider_event");
    if (answer.outcome === "reply") held.answers.push(answer.text);
    this.heldRoomTurnChanged(handle, true);
  }

  /** End the turn that was held open: now its own result line is published, and its waiters get what it has. */
  private settleHeldRoomTurn(
    handle: ClaudeProviderHandle,
    held: ClaudeHeldRoomTurn,
    ended: "answered" | "answer_failed" | "limit" | "no_answer" | "owner",
  ): void {
    if (handle.heldRoomTurn !== held) return;
    const left = this.heldRoomTurnWork(handle, held);
    // An answer to a notice runs, or is due: one of its lines was seen, or a notice waits for it.
    const answerRuns = held.answering || handle.taskNotices.length > 0 || handle.noticeAnswerTasks.length > 0;
    handle.heldRoomTurn = null;
    clearInterval(held.notice);
    if (held.wake) clearTimeout(held.wake);
    const { turnId } = held;
    // Empty texts are left out, and so is a text that repeats the text before it. Two tasks can have the same answer.
    const said = held.answers.map((text) => text.trim()).filter(Boolean).filter((text, index, all) => text !== all[index - 1]);
    // One plain line says what the reply lacks, and why. Work that still runs past its limit is the usual case, and no fault.
    const runs = (kind: "subagent" | "command" | "other") => left.some((task) => task.running && task.kind === kind);
    const lacks = ended === "owner" ? [CLAUDE_BACKGROUND_WORK_TEXT.ownerEnded] : [
      ...(ended === "answer_failed" || (ended === "limit" && left.some((task) => !task.running)) ? [CLAUDE_BACKGROUND_WORK_TEXT.notReported] : []),
      // A sub-agent that still runs is stopped with the turn, below.
      ...(runs("subagent") ? [ended === "limit" ? CLAUDE_BACKGROUND_WORK_TEXT.subagentTimedOut : CLAUDE_BACKGROUND_WORK_TEXT.subagentStopped] : []),
      ...(runs("other") ? [CLAUDE_BACKGROUND_WORK_TEXT.stillRunning] : runs("command") ? [CLAUDE_BACKGROUND_WORK_TEXT.commandStillRuns] : []),
    ];
    // A turn in which the model wrote nothing for the room posts nothing.
    const terminal: ClaudeRoomTurnTerminal = said.length
      ? { turnId, outcome: "reply", text: [...said, ...(lacks.length ? [lacks.join(" ")] : [])].join("\n\n"), evidence: "stream" }
      : { turnId, outcome: "no_reply", text: null, evidence: "stream" };
    try {
      if (ended === "owner" || (ended !== "answered" && (answerRuns || runs("subagent")))) {
        // The CLI must be free for the next prompt. An approval that the answer asked for is denied: with the
        // turn its card goes, and nobody could give it any more. Then the answer is interrupted (each captured).
        // The interrupt stops a sub-agent too: no turn waits for its report any more, and the reply says so.
        try {
          for (const pending of handle.permissionRequests.values()) {
            if (pending.turnId !== turnId || pending.dispatching) continue;
            handle.child.writeLine(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: pending.native.id,
              response: { behavior: "deny", message: "The turn ended before this action was approved." } } }));
          }
          this.writeInterrupt(handle);
        } catch { /* The CLI is gone; its exit is observed separately. */ }
      }
      // A command that passed its limit is no news for the owner. Any other limit is.
      if (ended === "no_answer" || (ended === "limit" && left.some((task) => !task.running || task.kind === "subagent"))) {
        this.publishStream(handle, CLAUDE_BACKGROUND_WORK_ANSWER_METHOD, {}, "provider_event", null, null,
          ended === "limit" ? CLAUDE_BACKGROUND_WORK_TEXT.limitReached : CLAUDE_BACKGROUND_WORK_TEXT.noAnswerBegan);
      }
      const nativeLifecycle = this.observeNativeExecution(handle, held.result);
      this.publishStream(handle, streamMethod(held.result), held.result, claudeStreamKind(held.result),
        nativeLifecycle?.nativeEventId ?? null, nativeLifecycle?.phase ?? null);
      if (nativeLifecycle?.phase === "turn_terminal") this.handleCompactions.get(handle)?.clear();
    } finally {
      // Whatever a listener does with those lines, the turn is over: nothing may wait for it any longer.
      handle.roomTurnResults.set(turnId, terminal);
      if (handle.activeRoomTurnId === turnId) handle.activeRoomTurnId = null;
      for (const waiter of [...(handle.roomTurnWaiters.get(turnId) ?? [])]) waiter.resolve(terminal);
      // A Stop that was on its way when the turn ended reads this as the result that came first.
      const boundaries = [...handle.turnResultWaiters];
      handle.turnResultWaiters.clear();
      for (const resolve of boundaries) resolve(held.result);
      if (handle.state === "working") handle.state = "idle";
    }
    this.publishActivity(handle, { source: "native_harness", method: streamMethod(held.result),
      summary: "Turn completed", status: "idle", checking: "", next_action: "awaiting next room work" });
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
        && (message.subtype === "success" ? typeof message.is_error === "boolean" : message.is_error === true);
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
          // The host denied this exact tool and Claude reports it as an error: the tool never ran. Any other
          // error result stays a generic failure, which cannot say what became of an approval.
          const denied = tool.hostDenied === true && block.is_error === true;
          emit({ domain: "execution", kind: "completed", executionId: block.tool_use_id, operation: tool.operation,
            outcome: denied ? "denied_before_start" : block.is_error === true ? "failed" : "succeeded",
            sideEffects: denied || tool.operation === "file_read" ? "none" : "possible", ...turn });
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
      return { turnId: terminal.turnId, providerContinuationId: handle.providerContinuationId,
        outcome: terminal.nativeOutcome, text: null, evidence: "stream",
        error: String(safeStreamPayload(terminal.error).payload).slice(0, 2000),
        ...(terminal.unrecognizedResult ? { unrecognizedResult: true as const } : {}),
        ...(terminal.apiFailure ? { claudeApiFailure: terminal.apiFailure } : {}),
        ...(terminal.refusal ? { refusal: true as const } : {}) };
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
    summary: string | null = null,
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
      ...(summary ? { summary } : {}),
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
    // A turn that was held open ends like any turn the process ended under: its waiters are told below, and
    // the session is read for it. That gives the turn's own answer with the answers to the notices of its work
    // that the session holds, and one line when the session does not prove that reply complete.
    const held = handle.heldRoomTurn;
    if (held) {
      handle.heldRoomTurn = null;
      clearInterval(held.notice);
      if (held.wake) clearTimeout(held.wake);
    }
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
