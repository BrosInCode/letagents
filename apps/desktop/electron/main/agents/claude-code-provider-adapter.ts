import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { desktopRuntimeEnvironment } from "../desktop-shell-environment.js";

import {
  synthesizeTerminalPayload,
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
} from "./provider-adapter.js";
import { attestProviderSpawnPolicy } from "./provider-spawn-configuration.js";
import {
  isRentalCredentialIsolationRequested,
  rentalCredentialIsolationMarker,
  rentalIsolatedChildEnvironment,
} from "./rental-child-environment.js";
import {
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
import { LETAGENTS_NPX_ARGS } from "../mcp-config.js";
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
  createLetAgentsMcpConfig(): Promise<{ path: string; dispose(): Promise<void> }>;
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
  permissionPromptBridging: false,
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
  if (type === "result") return isClaudeFailedResult(message) ? "error" : "turn_lifecycle";
  if (type === "system") return "provider_event";
  if (/error/i.test(type)) return "error";
  return "provider_event";
}

function isClaudeFailedResult(message: ClaudeStreamMessage): boolean {
  if (message.type !== "result") return false;
  if ((message as { is_error?: unknown }).is_error === true) return true;
  return typeof message.subtype === "string" && /(?:error|failed)/i.test(message.subtype);
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

function initMcpServerNames(message: ClaudeStreamMessage): string[] {
  const servers = (message as { mcp_servers?: unknown }).mcp_servers;
  if (!Array.isArray(servers)) return [];
  return servers.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const name = (row as { name?: unknown }).name;
    return typeof name === "string" ? [name] : [];
  });
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
    "You are handling one daemon-owned room inbox item in an exact bounded turn.",
    "The daemon owns observation, credentials, retries, and publication. Do not register a session, authenticate, poll, or manage runtime lifecycle.",
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
  const stderrTail: string[] = [];

  const notifyDisconnect = () => {
    if (intentionalClose || exitedSettled || disconnectNotified) return;
    disconnectNotified = true;
    for (const listener of disconnectListeners) listener();
    disconnectListeners.clear();
  };

  const exited = new Promise<ProviderProcessExit>((resolve) => {
    child.once("error", (error) => {
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
    stderrTail.push(chunk.toString("utf8"));
    if (stderrTail.length > 20) stderrTail.shift();
  });

  return {
    pid: child.pid ?? null,
    exited,
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
  temporaryRoot = tmpdir(),
): Promise<{ path: string; dispose(): Promise<void> }> {
  const directory = await mkdtemp(join(temporaryRoot, "letagents-claude-mcp-"));
  const configPath = join(directory, "mcp.json");
  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      letagents: {
        command: "npx",
        args: [...LETAGENTS_NPX_ARGS],
        env: mcpEnv,
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
): Promise<{ path: string; dispose(): Promise<void> }> {
  const normalizedApiUrl = apiBaseUrl.trim();
  if (!normalizedApiUrl) {
    throw new Error("Claude's managed LetAgents endpoint is unavailable.");
  }
  return createEphemeralClaudeMcpConfig(
    { LETAGENTS_API_URL: normalizedApiUrl },
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
  createLetAgentsMcpConfig: createManagedClaudeMcpConfig,
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

  constructor(
    readonly workAttemptId: string,
    readonly pid: number | null,
    readonly providerContinuationId: string,
    readonly providerConnection: ProviderConnectionRef,
    readonly child: ClaudeCliChild,
    readonly exitEvidence: Promise<ProviderProcessExit>,
  ) {}

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
  private readonly pendingAttaches = new Map<string, Promise<ProviderHandle | ProviderAttachTerminal | null>>();
  private readonly exitPromises = new WeakMap<ClaudeProviderHandle, Promise<ProviderTerminalPayload>>();

  constructor(options: ClaudeCodeProviderAdapterOptions = {}) {
    this.claudeBin = options.claudeBin || resolveClaudeCodeExecutable(desktopRuntimeEnvironment());
    this.deps = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
    this.activitySink = options.activitySink;
    this.streamSink = options.streamSink;
    this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
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
    if (handle && !handle.terminal && handle.providerContinuationId === ref.providerContinuationId) {
      return handle;
    }
    if (handle) return null;
    const connection = ref.providerConnection;
    if (!connection || connection.kind !== "claude_cli") return null;

    const pending = this.pendingAttaches.get(ref.workAttemptId);
    if (pending) return pending;
    const attaching = this.fenceRecordedChild(connection, ref.providerContinuationId).finally(() => {
      if (this.pendingAttaches.get(ref.workAttemptId) === attaching) {
        this.pendingAttaches.delete(ref.workAttemptId);
      }
    });
    this.pendingAttaches.set(ref.workAttemptId, attaching);
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
      handle.child.writeLine(JSON.stringify({
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "interrupt" },
      }));
      // A control_response acknowledgement is intentionally insufficient. The
      // subsequent result event is the only proof that the queued/live turn
      // actually reached an interrupted boundary.
      const result = await resultBoundary;
      const subtype = typeof result.subtype === "string" ? result.subtype.toLowerCase() : "";
      const resultTurnId = typeof result.user_message_uuid === "string"
        ? result.user_message_uuid.trim()
        : "";
      if (
        subtype !== "interrupted"
        || sessionIdOf(result) !== handle.providerContinuationId
        || resultTurnId !== activeTurnId
      ) {
        const exactSessionTerminal = sessionIdOf(result) === handle.providerContinuationId;
        throw new ProviderTurnControlError(
          `Claude returned ${streamMethod(result)} instead of an exact-session interrupted boundary.`,
          exactSessionTerminal ? "not_applied" : "uncertain",
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
    let terminalPromise: Promise<ClaudeRoomTurnTerminal> | null = null;
    try {
      await options.beforeNativeDispatch?.();
      // Claude accepts a caller-supplied UUID, so durability can record the
      // exact native identity before the stdin write that starts the turn.
      await options.checkpointTurnStarted?.(turnId);
      terminalPromise = this.waitForExactRoomTurn(handle, turnId, options.detachSignal);
      handle.activeRoomTurnId = turnId;
      handle.state = "working";
      try {
        handle.child.writeLine(userStreamJsonLine(boundedClaudeRoomTurnPrompt(request), turnId));
      } catch (error) {
        // The exact id is durable, but the native write did not occur. Release
        // the local waiter and fail this continuation so recovery/reconcile can
        // proceed without leaving a permanent "turn in progress" fence.
        handle.activeRoomTurnId = null;
        handle.state = "failed";
        handle.protocolError = true;
        throw error;
      }
      const terminal = await terminalPromise;
      const result = this.providerRoomTurnResult(terminal);
      await options.checkpointTerminalResult?.(result);
      handle.roomTurnResults.delete(turnId);
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

    const result = this.providerRoomTurnResult(terminal);
    await options.checkpointTerminalResult?.(result);
    handle.roomTurnResults.delete(turnId);
    return result;
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

  private async start(
    req: ProviderSpawnRequest,
    resumeRef: ProviderContinuationRef | null,
  ): Promise<ClaudeProviderHandle> {
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
    const versionOutput = await this.deps.readVersion(this.claudeBin);
    requireSupportedClaudeCodeVersion(versionOutput);

    const policyArgs = claudeLaunchPolicyArgs(attestProviderSpawnPolicy("claude-code", req));
    const managedMcpConfig = await this.deps.createLetAgentsMcpConfig();
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

    if (child.pid === null) {
      // Node exposes no safe signalling target in this state. Fail closed until
      // the launch itself proves terminal instead of retrying beside an orphan.
      await child.exited;
      await managedMcpConfig.dispose();
      throw new Error(
        "Claude CLI launch did not expose a process id; refusing to start an unfenceable writer.",
      );
    }
    const processIdentity = this.deps.getProcessIdentity(child.pid);
    if (typeof processIdentity !== "string" || !processIdentity) {
      child.markIntentionalClose();
      await terminateFreshLaunch(child, this.deps, this.stopGraceMs);
      await managedMcpConfig.dispose();
      throw new Error(
        "Claude CLI process identity could not be verified; refusing to start an unfenceable writer.",
      );
    }

    let handle: ClaudeProviderHandle | null = null;
    const pendingLines: string[] = [];
    let init: ClaudeStreamMessage | null = null;
    let resolveInit: ((message: ClaudeStreamMessage) => void) | null = null;
    const initPromise = new Promise<ClaudeStreamMessage>((resolve) => { resolveInit = resolve; });
    const unsubscribeLines = child.onLine((line) => {
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
    const initTimeout = new Promise<null>((resolve) => {
      initTimer = setTimeout(() => resolve(null), this.initTimeoutMs);
    });
    try {
      // Claude does not emit init until it receives one stdin user frame. This
      // bootstrap establishes the continuation but deliberately does no room
      // work; every real message is claimed and dispatched by the daemon.
      child.writeLine(userStreamJsonLine(CLAUDE_DAEMON_BOOTSTRAP_PROMPT, bootstrapTurnId));

      const observedInit = await Promise.race([
        initPromise,
        child.exited.then(() => null),
        initTimeout,
      ]);
      if (!observedInit) {
        throw new Error("Claude CLI did not report its stream-json init message; refusing an unobservable worker.");
      }
      // The workplace is inherited from the user's own CLI configuration —
      // nothing is injected — but a worker without the room channel is useless
      // and must not be launched (parity with the Codex adapter's check).
      if (!initMcpServerNames(observedInit).some((name) => name.toLowerCase() === "letagents")) {
        throw new Error(
          "LetAgents MCP server is not configured for the Claude CLI; refusing to launch without the room workplace.",
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
        { kind: "claude_cli", pid: child.pid, processIdentity },
        child,
        observeFencedExit(child, child.pid, processIdentity, child.exited, this.deps),
      );
      this.handles.set(req.workAttemptId, handle);
      const exitPromise = handle.exitEvidence.then((exit) => this.observeExit(handle!, exit));
      this.exitPromises.set(handle, exitPromise);

      this.publishStream(handle, streamMethod(observedInit), observedInit, "provider_event");
      const bootstrapResult = this.waitForExactRoomTurn(handle, bootstrapTurnId);
      for (const line of pendingLines.splice(0)) {
        this.consumeLine(handle, line);
      }
      const bootstrapTerminal = await Promise.race([
        bootstrapResult,
        child.exited.then(() => null),
        initTimeout,
      ]);
      if (!bootstrapTerminal || "error" in bootstrapTerminal) {
        throw new Error("Claude CLI did not complete its daemon-safe bootstrap turn.");
      }
      handle.roomTurnResults.delete(bootstrapTurnId);
      handle.state = "idle";
      return handle;
    } catch (error) {
      if (handle) {
        handle.protocolError = true;
      } else {
        unsubscribeLines();
      }
      child.markIntentionalClose();
      await terminateFreshLaunch(child, this.deps, this.stopGraceMs);
      throw error;
    } finally {
      if (initTimer) clearTimeout(initTimer);
      await managedMcpConfig.dispose();
    }
  }

  /** The attach-path fence for a recorded child this adapter cannot reattach. */
  private async fenceRecordedChild(
    connection: Extract<ProviderConnectionRef, { kind: "claude_cli" }>,
    providerContinuationId: string,
  ): Promise<ProviderAttachTerminal> {
    if (connection.pid === null || !connection.processIdentity) {
      throw new Error(
        "Claude CLI attach is ambiguous; the durable endpoint has no verified process identity.",
      );
    }
    const identity = this.deps.getProcessIdentity(connection.pid);
    if (identity === undefined) {
      throw new Error(
        "Claude CLI attach is ambiguous; the recorded process identity cannot be verified.",
      );
    }
    if (identity === null || !sameProcessBirthIdentity(identity, connection.processIdentity)) {
      // The recorded child is verifiably gone (a recycled pid is NOT it and is
      // never signalled). Proven absent — bounded recovery may proceed.
      return this.attachTerminal(providerContinuationId, null, "crashed");
    }
    // A previous daemon's stdin disappearing normally gives Claude EOF. Let
    // that exact orphan finish and flush its JSONL terminal boundary before
    // fencing it; recovery can then prove the already-started turn without a
    // duplicate dispatch.
    const exitedNaturally = await Promise.race([
      this.deps.observeProcessExit(connection.pid, connection.processIdentity).then(() => true),
      delay(this.stopGraceMs).then(() => false),
    ]);
    if (exitedNaturally) {
      return this.attachTerminal(providerContinuationId, null, "crashed");
    }
    const identityBeforeTerm = this.deps.getProcessIdentity(connection.pid);
    if (identityBeforeTerm === undefined) {
      throw new Error(
        "Claude CLI attach is ambiguous; the orphaned child's identity cannot be verified.",
      );
    }
    if (identityBeforeTerm === null || !sameProcessBirthIdentity(identityBeforeTerm, connection.processIdentity)) {
      return this.attachTerminal(providerContinuationId, null, "crashed");
    }
    // The exact recorded child is still alive but unreachable (its stdio died
    // with the previous supervisor). It may still be writing the workspace, so
    // it must be terminal before any replacement generation exists.
    this.deps.signalProcess(connection.pid, "SIGTERM");
    await delay(this.stopGraceMs);
    const identityBeforeKill = this.deps.getProcessIdentity(connection.pid);
    if (identityBeforeKill === undefined) {
      throw new Error(
        "Claude CLI attach is ambiguous; the orphaned child's termination could not be verified.",
      );
    }
    if (identityBeforeKill !== null && sameProcessBirthIdentity(identityBeforeKill, connection.processIdentity)) {
      this.deps.signalProcess(connection.pid, "SIGKILL");
      await this.deps.observeProcessExit(connection.pid, connection.processIdentity);
      return this.attachTerminal(providerContinuationId, "SIGKILL", "killed");
    }
    return this.attachTerminal(providerContinuationId, "SIGTERM", "stopped");
  }

  private attachTerminal(
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
      },
    };
  }

  private consumeLine(handle: ClaudeProviderHandle, line: string): void {
    const message = parseStreamLine(line);
    if (!message) {
      this.publishStream(handle, "stdout/raw", { line }, "provider_event");
      return;
    }
    this.publishStream(handle, streamMethod(message), message, claudeStreamKind(message));
    const type = typeof message.type === "string" ? message.type : "";
    if (handle.state === "failed") return;
    if (type === "result") {
      const exactTurnId = typeof message.user_message_uuid === "string"
        ? message.user_message_uuid.trim()
        : "";
      if (exactTurnId) {
        const terminal = exactClaudeStreamTerminal(
          message,
          exactTurnId,
          handle.providerContinuationId,
        );
        if (terminal) {
          handle.roomTurnResults.set(exactTurnId, terminal);
          if (handle.activeRoomTurnId === exactTurnId) handle.activeRoomTurnId = null;
          const exactWaiters = [...(handle.roomTurnWaiters.get(exactTurnId) ?? [])];
          for (const waiter of exactWaiters) waiter.resolve(terminal);
        }
      }
      const exactInterrupted = typeof message.subtype === "string"
        && message.subtype.toLowerCase() === "interrupted"
        && sessionIdOf(message) === handle.providerContinuationId;
      if (handle.turnResultWaiters.size) {
        const waiters = [...handle.turnResultWaiters];
        handle.turnResultWaiters.clear();
        for (const resolve of waiters) resolve(message);
      }
      if (exactInterrupted) {
        handle.state = "idle";
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
      if (isClaudeFailedResult(message)) {
        handle.state = "failed";
        this.publishActivity(handle, {
          source: "native_harness",
          method: streamMethod(message),
          summary: "Turn failed",
          status: "blocked",
          checking: "Claude Code reported a terminal turn failure.",
          next_action: "Awaiting supervised recovery.",
        });
        return;
      }
      handle.state = "idle";
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
      handle.state = "working";
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

  private providerRoomTurnResult(terminal: ClaudeRoomTurnTerminal): ProviderRoomTurnResult {
    if ("error" in terminal) {
      throw new Error(`Claude bounded room turn ${terminal.turnId} failed: ${terminal.error}`);
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
