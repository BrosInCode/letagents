import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

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
  type ProviderSpawnRequest,
  type ProviderStopOptions,
  type ProviderStreamEvent,
  type ProviderStreamEventKind,
  type ProviderTerminalPayload,
} from "./provider-adapter.js";
import {
  DEFAULT_STOP_GRACE_MS,
  defaultGetProcessIdentity,
  defaultSignalProcess,
  delay,
  safeStreamPayload,
  type ProviderProcessExit,
} from "./provider-evidence.js";

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
// No permission/credential logic lives here: the Add Agent launch policy is
// rendered as CLI flags purely syntactically and the child sees the user's own
// environment (v10 §3 — see cursorCliEnv below for the one open spike cell).

const TURN_START_TIMEOUT_MS = 30_000;

type CursorStreamMessage = Record<string, unknown> & {
  type?: unknown;
  subtype?: unknown;
  session_id?: unknown;
  is_error?: unknown;
};

export interface CursorCliChild {
  pid: number | null;
  exited: Promise<ProviderProcessExit>;
  /** Ordered stdout stream-json lines (raw, one JSON document per line). */
  onLine(listener: (line: string) => void): () => void;
  /** Bounded stderr tail — the provider-quota signature lives here (msg_1708). */
  stderrTail(): string;
}

export interface CursorProviderAdapterDependencies {
  launchTurn(input: { cursorBin: string; args: string[]; cwd: string }): CursorCliChild;
  signalProcess(pid: number, signal: NodeJS.Signals): void;
  /** null means verified absent; undefined means liveness could not be verified. */
  getProcessIdentity(pid: number): string | null | undefined;
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
}

const BASE_CURSOR_CAPABILITIES: ProviderAdapterCapabilities = {
  // `--resume <session_id>` is the documented continuation across per-turn
  // children (the legacy engine already relies on it); the adapter asserts the
  // session identity echo per turn. Subject to TrailDelta's task_38 spike cell.
  resume: true,
  // cursor-agent takes its prompt as a positional argument and ignores stdin —
  // there is NO channel into a RUNNING turn. poke() delivers at the next turn
  // boundary (immediately when idle) and refuses mid-turn, so the reconciler's
  // stuck-agent poke rung must stay off.
  midTurnInjection: false,
  // Every turn's stream-json output is published as bounded/redacted evidence.
  transcriptAccess: true,
  permissionPromptBridging: false,
  // Between turns there is no process at all; after a daemon restart the lane
  // resumes via the session id. Bounded recovery, not survival (§4.8).
  survivesRestart: false,
};

// Flags the adapter owns. Everything else in the launch policy is the user's
// native CLI configuration, forwarded verbatim (no reinterpretation — v10 §3).
const RESERVED_POLICY_KEYS = new Set([
  "p",
  "print",
  "outputFormat",
  "output-format",
  "resume",
  "workspace",
  "cwd",
  // Headless operation requires the workspace-trust prompt suppressed; the
  // adapter owns that flag (same as the legacy runner). Workspace trust is
  // launch mechanics, not a permission mode — the policy's mode/force/sandbox
  // flags still pass through verbatim.
  "trust",
]);

function camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * Mechanically render the opaque Add Agent launch policy as CLI flags —
 * `{ mode: "ask", force: true, sandbox: "enabled" }` becomes
 * `--mode ask --force --sandbox enabled`. Purely syntactic; values are never
 * mapped, renamed, or filtered beyond the adapter-owned reserved flags.
 *
 * Note (msg_1780 spike): the adapter injects no --model, so a policy that
 * omits it inherits the ACCOUNT default model — which can surface as a
 * provider_quota terminal on limited accounts. That is the user's native CLI
 * behavior, deliberately not second-guessed here; the Add Agent policy is
 * where a model belongs.
 */
export function cursorLaunchPolicyArgs(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cursor launchPolicy must be the native CLI options object.");
  }
  const policy = value as Record<string, unknown>;
  const args: string[] = [];
  for (const [key, entry] of Object.entries(policy)) {
    if (RESERVED_POLICY_KEYS.has(key)) {
      throw new Error(`Cursor launchPolicy cannot override reserved flag '${key}'.`);
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

function cursorStreamKind(message: CursorStreamMessage): ProviderStreamEventKind {
  const type = typeof message.type === "string" ? message.type : "";
  if (type === "assistant") return "text_delta";
  if (type === "user") return "tool_lifecycle";
  if (type === "tool_call" || type === "tool_use" || type === "tool_use_summary") return "tool_lifecycle";
  if (type === "result") return "turn_lifecycle";
  if (type === "system") return "provider_event";
  if (/error/i.test(type)) return "error";
  return "provider_event";
}

function streamMethod(message: CursorStreamMessage): string {
  const type = typeof message.type === "string" ? message.type : "unknown";
  const subtype = typeof message.subtype === "string" ? message.subtype : null;
  return subtype ? `${type}/${subtype}` : type;
}

function sessionIdOf(message: CursorStreamMessage): string | null {
  return typeof message.session_id === "string" && message.session_id.trim()
    ? message.session_id.trim()
    : null;
}

function defaultLaunchTurn(input: { cursorBin: string; args: string[]; cwd: string }): CursorCliChild {
  const child = spawn(input.cursorBin, input.args, {
    cwd: input.cwd,
    // The prompt travels as a positional argument; cursor-agent has no stdin
    // channel (matrix row). Its own process group so group signalling reaps
    // any descendants.
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: cursorCliEnv(),
  });

  const lineListeners = new Set<(line: string) => void>();
  const stderrChunks: string[] = [];
  const exited = new Promise<ProviderProcessExit>((resolve) => {
    child.once("error", (error) => resolve({ type: "error", error }));
    // "close", not "exit": close fires only after the stdio streams have
    // drained, so the final buffered `result` line is always delivered before
    // the exit evidence resolves. With "exit" a cleanly completed turn could be
    // misclassified as a crash because its result line was still in the pipe
    // (TrailDelta review, msg_1780).
    child.once("close", (code, signal) => resolve({ type: "exit", code, signal }));
  });
  if (child.stdout) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      for (const listener of lineListeners) listener(line);
    });
  }
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
    if (stderrChunks.length > 20) stderrChunks.shift();
  });

  return {
    pid: child.pid ?? null,
    exited,
    onLine(listener) {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    stderrTail() {
      return stderrChunks.join("");
    },
  };
}

const DEFAULT_DEPENDENCIES: CursorProviderAdapterDependencies = {
  launchTurn: defaultLaunchTurn,
  signalProcess: defaultSignalProcess,
  getProcessIdentity: defaultGetProcessIdentity,
  now: () => new Date().toISOString(),
};

interface LiveTurn {
  child: CursorCliChild;
  pid: number;
  processIdentity: string;
  sawInit: boolean;
  sawResult: boolean;
  resultWasError: boolean;
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
  readonly exitListeners = new Set<(payload: ProviderTerminalPayload) => void>();
  readonly activityListeners = new Set<(event: ProviderActivityEvent) => void>();
  readonly streamListeners = new Set<(event: ProviderStreamEvent) => void>();
  streamSequence = 0;

  constructor(
    readonly workAttemptId: string,
    readonly cwd: string,
    readonly policyArgs: string[],
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
  private readonly handles = new Map<string, CursorProviderHandle>();
  private readonly pendingAttaches = new Map<string, Promise<ProviderHandle | null>>();

  constructor(options: CursorProviderAdapterOptions = {}) {
    this.cursorBin = options.cursorBin || process.env.LETAGENTS_CURSOR_AGENT_BIN || "cursor-agent";
    this.deps = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
    this.activitySink = options.activitySink;
    this.streamSink = options.streamSink;
    this.turnStartTimeoutMs = options.turnStartTimeoutMs ?? TURN_START_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
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
   * fresh adapter cannot reattach stdio, so a verified-live recorded child is
   * fenced (TERM → grace → identity recheck → KILL → verified disappearance)
   * before the lane is reported absent for bounded resume — the same msg_1188
   * discipline as the Claude adapter. Unverifiable state throws ambiguous.
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

    const pending = this.pendingAttaches.get(ref.workAttemptId);
    if (pending) return pending;
    const attaching = this.fenceRecordedTurnChild(connection).finally(() => {
      if (this.pendingAttaches.get(ref.workAttemptId) === attaching) {
        this.pendingAttaches.delete(ref.workAttemptId);
      }
    });
    this.pendingAttaches.set(ref.workAttemptId, attaching);
    return attaching;
  }

  /**
   * Boundary delivery, not mid-turn injection: when the lane is idle the next
   * boundary is NOW, so the message runs as a fresh `--resume` turn; while a
   * turn is running there is no channel into the child and this refuses.
   */
  async poke(providerHandle: ProviderHandle, message: string): Promise<void> {
    const handle = this.requireHandle(providerHandle);
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

  async stop(
    providerHandle: ProviderHandle,
    options: ProviderStopOptions = {},
  ): Promise<ProviderTerminalPayload> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) return handle.terminal;
    handle.stopRequested = true;
    handle.state = "stopping";

    const turn = handle.liveTurn;
    if (!turn) {
      // Idle lane: no process to signal. The attempt ends here with an honest
      // synthesized payload (no exit code exists because nothing was running).
      return this.finishAttempt(handle, { type: "exit", code: 0, signal: null });
    }

    if (options.force) {
      this.deps.signalProcess(turn.pid, "SIGKILL");
      return this.awaitTurnTerminal(handle, turn);
    }
    this.deps.signalProcess(turn.pid, "SIGTERM");
    const graceMs = options.graceMs ?? this.stopGraceMs;
    const graceful = await Promise.race([
      turn.child.exited.then(() => true),
      delay(graceMs).then(() => false),
    ]);
    if (!graceful) this.deps.signalProcess(turn.pid, "SIGKILL");
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
    const policyArgs = cursorLaunchPolicyArgs(req.launchPolicy);
    const handle = new CursorProviderHandle(req.workAttemptId, req.cwd, policyArgs);
    if (resumeRef) handle.providerContinuationId = resumeRef.providerContinuationId;

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
  ): Promise<void> {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--trust",
      "--workspace", handle.cwd,
      ...handle.policyArgs,
      ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
      prompt,
    ];
    const child = this.deps.launchTurn({ cursorBin: this.cursorBin, args, cwd: handle.cwd });

    if (child.pid === null) {
      // Fail closed until the launch proves terminal; never retry beside an
      // unobservable writer.
      await child.exited;
      this.finishAttempt(handle, { type: "exit", code: null, signal: null }, "protocol_error");
      throw new Error("cursor-agent launch did not expose a process id; refusing an unfenceable turn.");
    }
    const processIdentity = this.deps.getProcessIdentity(child.pid);
    if (typeof processIdentity !== "string" || !processIdentity) {
      await this.terminateTurnChild(child.pid, child.exited);
      this.finishAttempt(handle, { type: "exit", code: null, signal: null }, "protocol_error");
      throw new Error("cursor-agent process identity could not be verified; refusing an unfenceable turn.");
    }

    const turn: LiveTurn = {
      child,
      pid: child.pid,
      processIdentity,
      sawInit: false,
      sawResult: false,
      resultWasError: false,
    };
    handle.liveTurn = turn;
    handle.state = "working";

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
    if (first === "timeout") {
      unsubscribe();
      await this.terminateTurnChild(turn.pid, child.exited, turn.processIdentity);
      handle.liveTurn = null;
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
      handle.liveTurn = null;
      this.finishAttempt(handle, exit);
      throw new Error(handle.protocolError
        ? "cursor-agent init violated the session contract; the turn was fenced."
        : "cursor-agent exited before reporting its stream-json init; the turn never became observable.");
    }
    if (handle.protocolError) {
      // consumeLine fenced a stranger session id in the init itself.
      unsubscribe();
      const exit = await child.exited;
      handle.liveTurn = null;
      this.finishAttempt(handle, exit);
      throw new Error("cursor-agent reported a different session than the durable continuation.");
    }
    if (!handle.providerContinuationId) {
      unsubscribe();
      await this.terminateTurnChild(turn.pid, child.exited, turn.processIdentity);
      handle.liveTurn = null;
      this.finishAttempt(handle, { type: "exit", code: null, signal: null }, "protocol_error");
      throw new Error("cursor-agent init carried no session id; refusing an unverifiable continuation.");
    }

    void this.completeTurn(handle, turn, unsubscribe);
  }

  /** Await the turn's real exit and apply the honest end state. */
  private async completeTurn(
    handle: CursorProviderHandle,
    turn: LiveTurn,
    unsubscribe: () => void,
  ): Promise<void> {
    const exit = await turn.child.exited;
    // Drain belt: even with close-gated exit evidence, give any line callbacks
    // already scheduled in this tick a chance to record the final result before
    // it is read — misreading a clean turn as !sawResult would drop the lane.
    await delay(0);
    unsubscribe();
    if (handle.liveTurn === turn) handle.liveTurn = null;
    if (handle.terminal) return;

    if (exit.type === "error" || handle.stopRequested || handle.protocolError || !turn.sawResult) {
      // A launch error, a requested stop, a session-identity violation, or a
      // child that died without its final result event are all ATTEMPT-level
      // terminal evidence — never silently absorbed as an idle turn. The one
      // refinement: the proven usage-limit signature is provider_quota, not a
      // crash (recoverable by model switch / spend limit, per the spike).
      this.finishAttempt(
        handle,
        exit,
        !handle.stopRequested && !handle.protocolError && isProviderQuotaExit(turn, exit)
          ? "provider_quota"
          : undefined,
      );
      return;
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
    if (sessionId && handle.providerContinuationId && handle.providerContinuationId !== sessionId) {
      // A stranger session must never silently become this lane's continuation
      // (same rule as the Claude adapter's same-id assertion).
      handle.protocolError = true;
      this.publishStream(handle, "session/mismatch", {
        expectedSessionId: handle.providerContinuationId,
        observedSessionId: sessionId,
      }, "error");
      this.deps.signalProcess(turn.pid, "SIGTERM");
    }
    this.publishStream(handle, streamMethod(message), message, cursorStreamKind(message));
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
          this.deps.signalProcess(turn.pid, "SIGTERM");
          return;
        }
        if (!handle.protocolError) {
          handle.providerContinuationId = sessionId;
          turn.sawInit = true;
        }
      }
      return;
    }
    if (type === "result") {
      turn.sawResult = true;
      turn.resultWasError = message.is_error === true;
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

  /** The attach-path fence for a recorded live-turn child (msg_1188). */
  private async fenceRecordedTurnChild(
    connection: Extract<ProviderConnectionRef, { kind: "cursor_cli" }>,
  ): Promise<null> {
    if (!connection.processIdentity) {
      throw new Error(
        "Cursor attach is ambiguous; the recorded turn child has no verified process identity.",
      );
    }
    const pid = connection.pid!;
    const identity = this.deps.getProcessIdentity(pid);
    if (identity === undefined) {
      throw new Error("Cursor attach is ambiguous; the recorded process identity cannot be verified.");
    }
    if (identity === null || identity !== connection.processIdentity) {
      // Verifiably gone (a recycled pid is NOT it and is never signalled).
      return null;
    }
    this.deps.signalProcess(pid, "SIGTERM");
    await delay(this.stopGraceMs);
    const identityBeforeKill = this.deps.getProcessIdentity(pid);
    if (identityBeforeKill === undefined) {
      throw new Error("Cursor attach is ambiguous; the orphaned turn child's termination could not be verified.");
    }
    if (identityBeforeKill !== null && identityBeforeKill === connection.processIdentity) {
      this.deps.signalProcess(pid, "SIGKILL");
      await this.awaitIdentityGone(pid, connection.processIdentity);
    }
    return null;
  }

  private async awaitIdentityGone(pid: number, processIdentity: string): Promise<void> {
    while (true) {
      const identity = this.deps.getProcessIdentity(pid);
      if (identity === null || (typeof identity === "string" && identity !== processIdentity)) return;
      await delay(50);
    }
  }

  private async terminateTurnChild(
    pid: number,
    exited: Promise<ProviderProcessExit>,
    processIdentity?: string,
  ): Promise<void> {
    this.deps.signalProcess(pid, "SIGTERM");
    const graceful = await Promise.race([
      exited.then(() => true),
      delay(this.stopGraceMs).then(() => false),
    ]);
    if (graceful) return;
    if (processIdentity) {
      const identity = this.deps.getProcessIdentity(pid);
      if (identity !== null && identity !== processIdentity) return;
    }
    this.deps.signalProcess(pid, "SIGKILL");
    await exited;
  }

  private async awaitTurnTerminal(
    handle: CursorProviderHandle,
    turn: LiveTurn,
  ): Promise<ProviderTerminalPayload> {
    const exit = await turn.child.exited;
    handle.liveTurn = null;
    return handle.terminal ?? this.finishAttempt(handle, exit);
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
