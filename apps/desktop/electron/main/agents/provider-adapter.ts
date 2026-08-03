// The launcher boundary for supervised provider agents (plan v10 §4.8).
//
// Every supervised provider (Codex first, then Claude Code, Cursor) is driven
// through this one interface. The daemon + reconciler (P1d) consume it; the
// concrete adapters implement it over each provider's NATIVE harness. Two hard
// rules from v10 §3/§4.8:
//   1. This boundary owns NO permission/credential logic. The provider's own
//      launch policy (its Add Agent choice: Full access / Ask / Sandboxed /
//      Read-only) governs execution and is passed through UNCHANGED. There is no
//      curated HOME, no env scrub, no scoped-bearer injection here.
//   2. Progressive capabilities are opt-in and must each be backed by a passing
//      P0 spike cell before an adapter claims them. The reconciler consumes the
//      negotiated set (e.g. no `midTurnInjection` ⇒ the attention ladder skips
//      the poke rung).
//
// Built interface-first so durability (spawn/stop/restart/resume/terminal
// ordering) is provable against an in-memory fake child with no live provider
// process — see provider-adapter-fake and its lifecycle tests.

// Provider-runtime observed state, local to the launcher boundary. Kept
// independent of the daemon's three-axis `ObservedState` (separate compilation
// unit / process): the daemon/reconciler maps this to its own vocabulary at the
// control-socket boundary. Deliberately no cross-rootDir import into the daemon.
export type ProviderObservedState =
  | "starting"
  | "working"
  | "idle"
  | "stopping"
  | "stopped"
  | "failed";

export type ProviderAdapterId = "codex" | "claude-code" | "cursor" | "open-model";

// Negotiated per adapter; each `true` requires a proven spike cell (v10 §4.8).
export interface ProviderAdapterCapabilities {
  /**
   * Room-ingress modes this adapter can safely run. Daemon inbox support
   * requires bounded run/recover semantics, not merely a long-lived process.
   */
  deliveryModes?: ReadonlyArray<"mcp_polling" | "desktop_events" | "daemon_inbox">;
  /** Continue the SAME provider session across a restart (vs. starting fresh). */
  resume: boolean;
  /** Inject a message into a running session at its next tool boundary (poke). */
  midTurnInjection: boolean;
  /**
   * Apply a human correction to the CURRENT turn natively — interrupt and
   * resume the same in-flight turn without losing it (Codex). Distinct from
   * `midTurnInjection` (the reconciler "poke" rung) and from `turnControl`
   * (which only says a turn can be stopped). When absent/false, the supervisor
   * delivers a correction as stop-then-resend: it stops the turn and re-runs
   * the correction as a fresh bounded turn on the same provider session.
   */
  midTurnCorrection?: boolean;
  /** Read the live transcript/rollout for runtime activity evidence. */
  transcriptAccess: boolean;
  /** Surface the provider's native permission prompts through the desktop. */
  permissionPromptBridging: boolean;
  /**
   * v10 §4.8 recovery bound. `true` = the process/session genuinely survives a
   * restart with in-context state. `false` = "bounded recovery, not survival":
   * a restart loses in-context state since the last checkpoint; the work
   * attempt, workspace, scratchpad, and outbox bound that loss. The UI MUST
   * surface this bound.
   */
  survivesRestart: boolean;
  /** How this provider can stop one turn without ending the supervised attempt. */
  turnControl?: "native_interrupt" | "restart_resume" | "unsupported";
  /** Replace a missing continuation without replacing its verified provider process. */
  continuationRepair?: "same_process" | "unsupported";
}

export interface ProviderTurnControlResult {
  capability: NonNullable<ProviderAdapterCapabilities["turnControl"]>;
  interrupted: boolean;
  resumed: boolean;
  state: "idle" | "working";
}

export interface ProviderTurnControlOptions {
  /** Persist the exact discovered native turn before an interrupt can be sent. */
  checkpointTurnStarted?: (turnId: string) => Promise<void>;
  /** Persist the dispatching journal state before the first native side effect. */
  markDispatched?: () => Promise<void>;
}

/** A fenced legacy-polling boundary; this never selects a newer turn on replay. */
export interface ProviderExactTurnControlOptions {
  /** Omit only for the first discovery. A supplied id is the sole eligible target. */
  targetTurnId?: string | null;
  checkpointTargetTurn: (turnId: string) => Promise<void>;
  /** Must be the final awaited callback before native turn/interrupt. */
  markDispatched: () => Promise<void>;
  /** Detach only this daemon's observation; never stop the native provider. */
  detachSignal?: AbortSignal;
}

export type ProviderExactTurnControlResult = {
  outcome: "no_active" | "terminal" | "interrupt_dispatched";
  targetTurnId: string | null;
};

export class ProviderTurnControlError extends Error {
  readonly turnControlOutcome: "not_applied" | "uncertain";
  constructor(message: string, outcome: "not_applied" | "uncertain") {
    super(message);
    this.turnControlOutcome = outcome;
  }
}

export type ProviderTerminalCause =
  | "exited"        // clean process exit
  | "killed"        // SIGKILL / force stop
  | "stopped"       // graceful SIGTERM stop
  | "crashed"       // unexpected death
  | "protocol_error" // harness/RPC violation
  // The provider refused/ended service for account reasons (usage limit, spend
  // cap) while the process itself behaved: recoverable by configuration, so the
  // reconciler must not count it as a crash or quarantine-worthy exit. Proven
  // signature for Cursor in the task_38 spike (msg_1708): init observed, no
  // result event, exit != 0, ActionRequiredError usage-limit stderr.
  | "provider_quota";

// Immutable payload recorded when a generation ends. Mirrors P1b's
// `execution_generation` terminal record so the reconciler/attestation can
// consume it directly.
export interface ProviderTerminalPayload {
  endedAt: string;
  exitCode: number | null;
  signal: string | null;
  terminalCause: ProviderTerminalCause;
  /** Provider-native continuation handle (codex thread_id, claude session_id). */
  providerContinuationId: string | null;
}

// A provider session that can be resumed/reattached. The work_attempt_id (P1b)
// is the immutable owner of the workspace and survives death AND rebind.
export interface ProviderContinuationRef {
  workAttemptId: string;
  providerContinuationId: string;
  /** Durable native process endpoint used to reconnect without creating a second writer. */
  providerConnection?: ProviderConnectionRef | null;
}

export type ProviderConnectionRef =
  | {
    kind: "codex_app_server";
    url: string;
    pid: number | null;
    /** Stable process birth identity; prevents PID-reuse death laundering. */
    processIdentity?: string | null;
  }
  | {
    // A headless CLI child has no reconnectable endpoint — stdio dies with the
    // supervising process — so its ref carries process identity only. A fresh
    // adapter can verify/fence the exact child but never live-reattach; recovery
    // is bounded (resume a continuation), not survival (v10 §4.8).
    kind: "claude_cli";
    pid: number | null;
    processIdentity?: string | null;
  }
  | {
    // Cursor runs one child per TURN: pid/identity are non-null only while a
    // turn is live; an idle lane honestly records no process at all and its
    // continuation lives entirely in the session id (task_38 matrix row).
    kind: "cursor_cli";
    pid: number | null;
    processIdentity?: string | null;
  }
  | {
    // Open Model runs through a dedicated loopback-only OpenCode server. The
    // server credential is a local runtime control secret, not the user's
    // model-provider API key. It is stored in an owner-only sidecar so a
    // successor daemon can authenticate to the same verified process.
    kind: "opencode_server";
    url: string;
    pid: number | null;
    processIdentity?: string | null;
    serverAuthPath: string;
  };

/**
 * Compare the complete durable identity of two native provider connections.
 * A missing connection, PID, or process-birth identity is unknown evidence and
 * therefore never sufficient to authenticate a cached live handle.
 */
export function sameProviderConnectionIdentity(
  expected: ProviderConnectionRef | null | undefined,
  actual: ProviderConnectionRef | null | undefined,
): boolean {
  if (!expected || !actual || expected.kind !== actual.kind) return false;
  if (expected.pid === null || actual.pid === null) return false;
  if (expected.pid !== actual.pid) return false;
  if (!expected.processIdentity || !actual.processIdentity) return false;
  if (expected.processIdentity !== actual.processIdentity) return false;
  if (expected.kind === "codex_app_server") {
    return actual.kind === "codex_app_server" && Boolean(expected.url) && expected.url === actual.url;
  }
  if (expected.kind === "opencode_server") {
    return actual.kind === "opencode_server"
      && Boolean(expected.url)
      && expected.url === actual.url
      && Boolean(expected.serverAuthPath)
      && expected.serverAuthPath === actual.serverAuthPath;
  }
  return true;
}

export interface ProviderSpawnRequest {
  workAttemptId: string;
  roomId: string;
  /** Durable ingress owner selected by the daemon, never inferred from policy. */
  deliveryMode?: "mcp_polling" | "desktop_events" | "daemon_inbox";
  /** Durable manifest identity to register in the room; never generated by the adapter. */
  agentDisplayName?: string;
  /** The per-work-attempt worktree (daemon-owned; never the user's dev checkout). */
  cwd: string;
  /**
   * The provider's existing launch policy from the desktop Add Agent UI, passed
   * through unchanged. Opaque to this layer by design (v10 §3) — the adapter
   * hands it to the native harness verbatim; LetAgents never reinterprets it.
   */
  launchPolicy: unknown;
  /** Exact configuration snapshot selected before this native runtime starts. */
  model?: string | null;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  permissionProfileId?: string | null;
  configurationRevision?: number;
  /** Present when this spawn continues a prior session (requires capabilities.resume). */
  resumeFrom?: ProviderContinuationRef | null;
  /** Explicit daemon bridge identity inherited by the provider's MCP child. */
  supervisorEntryId?: string;
  supervisorSocketPath?: string;
  supervisorExecutionGenerationId?: string;
  /** Non-secret durable room identity restored by the daemon on resume. */
  supervisorWorkerSession?: {
    agentSessionId: string;
    roomCursor: string | null;
  };
  /**
   * Development-only: absolute path to a locally built MCP server entry (e.g.
   * dist/mcp/server.js) for supervised provider smoke tests. Production safety
   * is caller-enforced: the daemon emits this field only for supported local
   * MCP providers when BOTH
   * LETAGENTS_DESKTOP_DEV_SERVER_URL and LETAGENTS_DEV_MCP_SERVER_ENTRY are set.
   * Never place a bearer credential or socket path in this field.
   */
  devMcpServerEntryPath?: string;
  /**
   * Ephemeral provider credential delivered Electron → daemon over the
   * owner-only control socket. It must never be serialized into a manifest,
   * checkpoint, launch argument, renderer payload, or OpenCode config file.
   */
  providerCredential?: {
    apiKey: string | null;
    baseUrl: string;
    model: string;
  };
}

export interface ProviderHandle {
  readonly workAttemptId: string;
  /** OS pid of the supervised process, or null for an in-process/attached shape. */
  readonly pid: number | null;
  /** The provider-native session id once known (thread/session). */
  readonly providerContinuationId: string | null;
  /** Persist this with the continuation so a fresh adapter can verify/reattach. */
  readonly providerConnection?: ProviderConnectionRef | null;
  observedState(): ProviderObservedState;
}

/**
 * Positive terminal evidence discovered while recovering a durable endpoint.
 * Some native harnesses cannot reattach after their supervisor dies. They may
 * nevertheless prove the recorded writer absent (or fence it first). Returning
 * that evidence lets durability close the old generation before a successor is
 * minted; plain null means only "not attached" and carries no death proof.
 */
export type ProviderAttachTerminal = {
  state: "terminal";
  terminal: ProviderTerminalPayload;
};

export interface ProviderStopOptions {
  /** Skip the graceful window and force-kill immediately. */
  force?: boolean;
  /** Grace period (ms) before escalating SIGTERM → SIGKILL. */
  graceMs?: number;
}

export interface ProviderActivityEvent {
  workAttemptId: string;
  providerContinuationId: string | null;
  observedAt: string;
  source: "native_harness" | "transcript_tail";
  method: string | null;
  summary: string;
  status: "idle" | "working" | "reviewing" | "blocked";
  checking: string;
  nextAction: string;
}

export type ProviderStreamEventKind =
  | "text_delta"
  | "turn_lifecycle"
  | "item_lifecycle"
  | "tool_lifecycle"
  | "command_output"
  | "approval"
  | "error"
  | "usage"
  | "transcript_snapshot"
  | "provider_event";

/**
 * Loss-minimized native provider evidence for the first-party live feed. The
 * compact ProviderActivityEvent is derived from this stream, never its only
 * durable representation. Payloads are provider-shaped but bounded/redacted at
 * the adapter boundary; a future persistence bridge may replace large payloads
 * with durablePayloadRef without changing the event taxonomy.
 */
export interface ProviderStreamEvent {
  workAttemptId: string;
  providerContinuationId: string | null;
  observedAt: string;
  sequence: number;
  provider: ProviderAdapterId;
  kind: ProviderStreamEventKind;
  method: string;
  /** Provider-approved, human-readable progress. Raw private reasoning is never placed here. */
  summary?: string | null;
  payload: unknown;
  payloadTruncated: boolean;
  payloadRedacted: boolean;
  durablePayloadRef: string | null;
}

/** A single daemon-owned inbox item executed on an existing provider thread. */
export interface ProviderRoomTurnRequest {
  inboxItemId: string;
  sourceMessage: unknown;
  activation: Record<string, unknown>;
  actionId: string;
  charter?: string;
  observedContext?: unknown[];
}

export type ProviderRoomTurnResult =
  | { turnId: string; outcome: "reply"; text: string; evidence?: "transcript" | "stream" }
  | { turnId: string; outcome: "no_reply"; text: null; evidence?: "transcript" | "stream" }
  | { turnId: string; outcome: "unreadable"; text: null; evidence?: "none" };
export interface ProviderRoomTurnRecoveryRequest { inboxItemId: string; providerTurnId: string; }
export interface ProviderContinuationRepairRequest {
  workAttemptId: string;
  expectedProviderContinuationId: string;
  /** A thread/start result already checkpointed by an interrupted repair. */
  checkpointedReplacementProviderContinuationId?: string | null;
  /**
   * This exact continuation already appeared to rematerialize and then failed
   * the next turn/start. Skip another optimistic reuse and create a durable
   * replacement instead.
   */
  forceReplacement?: boolean;
  cwd: string;
  launchPolicy: unknown;
  model?: string | null;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
}
export interface ProviderContinuationRepairResult {
  handle: ProviderHandle;
  outcome: "rematerialized" | "replaced";
  previousProviderContinuationId: string;
  replacementProviderContinuationId: string;
}

export class ProviderContinuationMissingError extends Error {
  readonly providerFailureCode = "provider_continuation_missing" as const;
  readonly providerContinuationId: string;

  constructor(providerContinuationId: string) {
    super("The saved provider conversation is unavailable.");
    this.name = "ProviderContinuationMissingError";
    this.providerContinuationId = providerContinuationId;
  }
}

export interface ProviderRoomTurnOptions {
  /** Persist dispatch intent before the first native turn/start side effect. */
  beforeNativeDispatch?: () => Promise<void>;
  /** Persist the exact native turn id before awaiting its terminal state. */
  checkpointTurnStarted?: (turnId: string) => Promise<void>;
  /** Persist a provider's dynamic continuation/process identity before native work proceeds. */
  checkpointProviderState?: (state: {
    providerContinuationId: string;
    providerConnection: ProviderConnectionRef;
  }) => Promise<void>;
  /** Synchronously marks that exact turn identity and process recovery state are durable. */
  markDurableTurnStarted?: () => void;
  /** Persist normalized terminal evidence before provider-local evidence is released. */
  checkpointTerminalResult?: (result: ProviderRoomTurnResult) => Promise<void>;
  /** Detach this observer only; never interrupt the provider-native turn. */
  detachSignal?: AbortSignal;
  /** @deprecated compatibility alias; new adapters must call beforeNativeDispatch. */
  markDispatched?: () => Promise<void>;
}

export interface ProviderAdapter {
  readonly id: ProviderAdapterId;

  /** The negotiated capability set (each `true` backed by a P0 spike cell). */
  capabilities(): ProviderAdapterCapabilities;

  /** Launch a fresh child under the provider's native harness. */
  spawn(req: ProviderSpawnRequest): Promise<ProviderHandle>;

  /**
   * Reattach to a child that is still alive (e.g. after a desktop restart)
   * WITHOUT relaunching it. A terminal result is positive evidence that the
   * recorded writer is gone; null alone is not terminal evidence.
   */
  attach(ref: ProviderContinuationRef): Promise<ProviderHandle | ProviderAttachTerminal | null>;

  /**
   * Relaunch continuing the prior session. Requires capabilities().resume; for a
   * no-resume provider the reconciler must spawn() fresh instead and accept the
   * bounded-recovery loss.
   */
  resume(ref: ProviderContinuationRef, req: ProviderSpawnRequest): Promise<ProviderHandle>;

  /** Inject a message at the next tool boundary. Requires capabilities().midTurnInjection. */
  poke(handle: ProviderHandle, message: string): Promise<void>;

  /**
   * Stop only the current native turn and optionally apply a correction on the
   * same provider continuation. This must never make the work attempt terminal.
   */
  controlTurn?(handle: ProviderHandle, correction?: string | null, options?: ProviderTurnControlOptions): Promise<ProviderTurnControlResult>;

  /** Fence one legacy polling turn without ever selecting a replacement latest turn. */
  controlExactTurn?(handle: ProviderHandle, options: ProviderExactTurnControlOptions): Promise<ProviderExactTurnControlResult>;

  /** Inspect only one already-persisted native turn; never choose a latest turn. */
  inspectTurn?(handle: ProviderHandle, turnId: string): Promise<"active" | "terminal" | "unknown">;

  /** Run one bounded room turn without launching or replacing the provider. */
  runRoomTurn?(handle: ProviderHandle, request: ProviderRoomTurnRequest, options?: ProviderRoomTurnOptions): Promise<ProviderRoomTurnResult>;
  /** Recover only a persisted exact native turn; it must not start another turn. */
  recoverRoomTurn?(handle: ProviderHandle, request: ProviderRoomTurnRecoveryRequest, options?: {
    detachSignal?: AbortSignal;
    checkpointProviderState?: ProviderRoomTurnOptions["checkpointProviderState"];
    checkpointTerminalResult?: (result: ProviderRoomTurnResult) => Promise<void>;
  }): Promise<ProviderRoomTurnResult>;
  repairContinuation?(handle: ProviderHandle, request: ProviderContinuationRepairRequest, options: {
    checkpointReplacement: (providerContinuationId: string) => Promise<void>;
    detachSignal?: AbortSignal;
  }): Promise<ProviderContinuationRepairResult>;

  /** Stop an exact durable process birth when a successor cannot reattach its transport. */
  stopRef?(ref: ProviderContinuationRef, opts?: ProviderStopOptions): Promise<ProviderTerminalPayload>;

  /** Graceful stop → grace → force. Resolves with the immutable terminal payload. */
  stop(handle: ProviderHandle, opts?: ProviderStopOptions): Promise<ProviderTerminalPayload>;

  /**
   * Observe process exit (the "observable exit" floor from v10 §4.8) — however
   * the child dies, the supervisor learns the terminal payload. Returns an
   * unsubscribe function.
   */
  onExit(handle: ProviderHandle, listener: (payload: ProviderTerminalPayload) => void): () => void;

  /**
   * Optional native-runtime evidence stream. P1e bridges this to the daemon
   * control socket; adapters with transcript access emit both live harness
   * notifications and durable transcript-tail snapshots.
   */
  onActivity?(
    handle: ProviderHandle,
    listener: (event: ProviderActivityEvent) => void,
  ): () => void;

  /** Ordered native provider events for live UI and safe durable persistence. */
  onStream?(
    handle: ProviderHandle,
    listener: (event: ProviderStreamEvent) => void,
  ): () => void;
}

// task_28 cell (d): a raw SIGKILL leaves NO native terminal payload in the
// provider's transcript, and cell (c)/(d) show the outer process just exits.
// So the adapter SYNTHESIZES the terminal payload from the OBSERVED OS exit
// (code/signal) rather than trusting the harness (or model prose) to emit one.
// `stopRequested` disambiguates a stop WE initiated from an unexpected death:
// the same SIGTERM/SIGKILL is a clean "stopped"/"killed" when we asked for it,
// but a "crashed" when it came from outside (OOM, external kill, dev restart).
export function synthesizeTerminalPayload(input: {
  exitCode: number | null;
  signal: string | null;
  providerContinuationId: string | null;
  endedAt: string;
  stopRequested?: boolean;
}): ProviderTerminalPayload {
  const { exitCode, signal, stopRequested = false } = input;
  let terminalCause: ProviderTerminalCause;
  if (signal === "SIGKILL" || signal === "SIGABRT") {
    terminalCause = stopRequested ? "killed" : "crashed";
  } else if (signal === "SIGTERM" || signal === "SIGINT" || signal === "SIGHUP") {
    terminalCause = stopRequested ? "stopped" : "crashed";
  } else if (signal) {
    // any other terminating signal we didn't send
    terminalCause = "crashed";
  } else if (exitCode === 0) {
    terminalCause = stopRequested ? "stopped" : "exited";
  } else {
    // nonzero or null exit code with no signal: clean only if we asked to stop
    terminalCause = stopRequested ? "stopped" : "crashed";
  }
  return {
    endedAt: input.endedAt,
    exitCode,
    signal,
    terminalCause,
    providerContinuationId: input.providerContinuationId,
  };
}
