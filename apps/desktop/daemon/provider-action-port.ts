/**
 * Daemon-side mirror of the Electron ProviderAdapter.  P1e owns the
 * control-socket bridge; keeping this structural port here keeps reconciliation
 * outside Electron's failure domain.
 */
import type { ControlProbeResult, NativeExecutionCapabilities, NativeExecutionObservation, NativeExecutionSubscription, NativeTurnBoundary } from "../shared/execution-protocol.js";
import type { ProviderPermissionRequest, ProviderPermissionObservation, ProviderPermissionCorrelation, ProviderPermissionDispatchOptions, ProviderPermissionReply } from "../shared/provider-permissions.js";
export type ProviderActionCapabilities = {
  execution?: NativeExecutionCapabilities;
  /** Explicit adapter admission for durable room-ingress ownership. */
  deliveryModes?: ReadonlyArray<"mcp_polling" | "desktop_events" | "daemon_inbox">;
  resume: boolean;
  midTurnInjection: boolean;
  transcriptAccess: boolean;
  permissionPromptBridging: boolean;
  survivesRestart: boolean;
  turnControl?: "native_interrupt" | "restart_resume" | "unsupported";
  /** Native interrupt+resume of the current turn (Codex). Absent/false ⇒ the daemon uses stop-then-resend. */
  midTurnCorrection?: boolean;
  continuationRepair?: "same_process" | "unsupported";
};
export type ProviderTurnControlResult = {
  capability: NonNullable<ProviderActionCapabilities["turnControl"]>;
  interrupted: boolean;
  resumed: boolean;
  state: "idle" | "working";
};
export type ProviderActionConnectionRef =
  | { kind: "codex_app_server"; url: string; pid: number | null; processIdentity?: string | null }
  | { kind: "claude_cli"; pid: number | null; processIdentity?: string | null }
  | { kind: "cursor_cli"; pid: number | null; processIdentity?: string | null }
  | { kind: "opencode_server"; url: string; pid: number | null; processIdentity?: string | null; serverAuthPath: string };

/**
 * Compare the complete durable identity of two native provider connections.
 * A missing connection, PID, or process-birth identity is unknown evidence and
 * therefore never sufficient to authenticate a cached live handle.
 */
export function sameProviderActionConnectionIdentity(
  expected: ProviderActionConnectionRef | null | undefined,
  actual: ProviderActionConnectionRef | null | undefined,
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

/**
 * Compare durable provider-state snapshots, including the honest idle shape
 * used by Cursor between turns. This is deliberately different from
 * `sameProviderActionConnectionIdentity`: an idle snapshot is valid state but
 * is never evidence that a native process is alive.
 */
export function sameProviderActionConnectionSnapshot(
  expected: ProviderActionConnectionRef | null | undefined,
  actual: ProviderActionConnectionRef | null | undefined,
): boolean {
  if (!expected || !actual) return !expected && !actual;
  if (expected.kind !== actual.kind || expected.pid !== actual.pid) return false;
  const expectedIdentity = expected.processIdentity ?? null;
  const actualIdentity = actual.processIdentity ?? null;
  if (expectedIdentity !== actualIdentity) return false;
  if ((expected.pid === null) !== (expectedIdentity === null)) return false;
  if (expected.kind === "codex_app_server") {
    return actual.kind === "codex_app_server" && expected.url === actual.url;
  }
  if (expected.kind === "opencode_server") {
    return actual.kind === "opencode_server"
      && expected.url === actual.url
      && expected.serverAuthPath === actual.serverAuthPath;
  }
  return true;
}

export type ProviderActionRef = { workAttemptId: string; providerContinuationId: string; provider?: string; providerConnection?: ProviderActionConnectionRef | null; lifecycleAuthorityMode?: "legacy" | "typed_shadow" | "typed" };
export type ProviderActionSpawn = { workAttemptId: string; roomId: string; cwd: string; workspaceKind?: "git_worktree" | "room_scratch"; launchPolicy: unknown; provider?: string; model?: string | null; reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | null; permissionProfileId?: string | null; configurationRevision?: number; agentDisplayName?: string; deliveryMode?: "mcp_polling" | "desktop_events" | "daemon_inbox"; lifecycleAuthorityMode?: "legacy" | "typed_shadow" | "typed"; pollingContract?: "custodial_polling_v1"; resumeFrom?: ProviderActionRef | null; actionId?: string; supervisorEntryId?: string; supervisorSocketPath?: string; supervisorExecutionGenerationId?: string; supervisorWorkerSession?: { agentSessionId: string; roomCursor: string | null; apiUrl?: string }; devMcpServerEntryPath?: string; providerCredential?: { apiKey: string | null; baseUrl: string; model: string } };
export type ProviderActionHandle = { workAttemptId: string; pid: number | null; providerContinuationId: string | null; providerConnection?: ProviderActionConnectionRef | null; appliedConfigurationRevision?: number; custodyLaunchAgentSessionId?: string; observedState: "starting" | "working" | "idle" | "stopping" | "stopped" | "failed" };
export type ProviderActionTerminal = { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error" | "provider_quota"; providerContinuationId: string | null };
export type ProviderActionAttachTerminal = { state: "terminal"; terminal: ProviderActionTerminal };
export type CustodialPollingActivationRequest = {
  operationId: string; roomId: string; cwd: string; agentDisplayName: string;
  workerSession: { agentSessionId: string; roomCursor: string };
  /** Internal daemon attestation from the persisted applied launch, never controller input. */
  launchReceipt: {
    contract: "custodial_polling_v1"; configurationRevision: number; workAttemptId: string; agentSessionId: string;
    providerContinuationId: string; providerConnection: ProviderActionConnectionRef;
  };
};
export type CustodialPollingActivationOptions = {
  beforeNativeDispatch: () => Promise<void>;
  checkpointTurnStarted: (id: string) => Promise<void>;
  detachSignal?: AbortSignal;
};
export type ProviderActionAttachment = { state: "attached"; handle: ProviderActionHandle } | { state: "absent" } | { state: "ambiguous"; reason: string };
export type ProviderActionStreamEvent = {
  workAttemptId: string;
  providerContinuationId: string | null;
  observedAt: string;
  sequence: number;
  provider: string;
  kind: string;
  method: string;
  /** Opaque identity shared only with typed facts derived from this exact native lifecycle event. */
  nativeEventId?: string;
  /** Exact native process birth that emitted the event; required for Cursor child fencing. */
  nativeProcessIdentity?: string;
  /** PID paired with nativeProcessIdentity; neither field is exact alone. */
  nativeProcessPid?: number;
  /** Structural boundary for the correlated lifecycle checkpoint; never provider-authored text. */
  nativeLifecyclePhase?: "turn_active" | "turn_terminal";
  /** Shadow-comparison evidence only; consumers must not derive operational state from this frame. */
  lifecycleProjectionOnly?: true;
  /** Provider-approved, human-readable progress. Raw private reasoning is never placed here. */
  summary?: string | null;
  payload: unknown;
  payloadTruncated: boolean;
  payloadRedacted: boolean;
  durablePayloadRef: string | null;
};

/**
 * One durable room delivery. The daemon owns retries and publication; the
 * provider adapter owns only this bounded turn on an already-running handle.
 */
export type ProviderRoomTurnRequest = {
  inboxItemId: string;
  sourceMessage: unknown;
  activation: Record<string, unknown>;
  actionId: string;
  observedContext?: unknown[];
};
export type ProviderRoomTurnResult =
  | { turnId: string; outcome: "reply"; text: string; evidence?: "transcript" | "stream"; publicationContract?: "structured_room_turn_v1" | "legacy_cursor_aggregate_v0" }
  | { turnId: string; outcome: "no_reply"; text: null; evidence?: "transcript" | "stream"; publicationContract?: "structured_room_turn_v1" | "legacy_cursor_aggregate_v0" }
  /** Exact native terminal proof; never synthesized from an exception or stream classifier. */
  | { turnId: string; providerContinuationId: string; outcome: "failed" | "interrupted"; text: null; evidence: "transcript" | "stream"; publicationContract?: "structured_room_turn_v1" | "legacy_cursor_aggregate_v0" }
  | { turnId: string; outcome: "unreadable"; text: null; evidence?: "none"; publicationContract?: "structured_room_turn_v1" | "legacy_cursor_aggregate_v0" };
export type ProviderRoomTurnCheckpointDisposition = {
  acceptedResult: ProviderRoomTurnResult;
  cleanupRecoveryEvidence: boolean;
};
export type ProviderRoomTurnRecoveryRequest = { inboxItemId: string; providerTurnId: string };
export type ProviderExactTurnControlResult = { outcome: "no_active" | "terminal" | "interrupt_dispatched"; targetTurnId: string | null };
export type ProviderContinuationRepairRequest = {
  workAttemptId: string;
  expectedProviderContinuationId: string;
  /** A thread/start result already checkpointed by an interrupted repair. */
  checkpointedReplacementProviderContinuationId?: string | null;
  forceReplacement?: boolean;
  cwd: string;
  launchPolicy: unknown;
  model?: string | null;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
};
export type ProviderContinuationRepairResult = {
  handle: ProviderActionHandle;
  outcome: "rematerialized" | "replaced";
  previousProviderContinuationId: string;
  replacementProviderContinuationId: string;
};
export type ProviderFailureCode = "provider_continuation_missing";

export class ProviderActionFailure extends Error {
  readonly providerFailureCode: ProviderFailureCode;
  readonly providerContinuationId: string;

  constructor(message: string, code: ProviderFailureCode, providerContinuationId: string) {
    super(message);
    this.name = "ProviderActionFailure";
    this.providerFailureCode = code;
    this.providerContinuationId = providerContinuationId;
  }
}

export interface ProviderActionPort {
  onExecution?(handle: ProviderActionHandle, listener: (event: NativeExecutionObservation) => void): Promise<NativeExecutionSubscription>;
  probeControl?(handle: ProviderActionHandle): Promise<ControlProbeResult>;
  observePermissions?(handle: ProviderActionHandle, listener: (event: ProviderPermissionObservation) => void, signal: AbortSignal): Promise<void>;
  correlatePermissionTurn?(handle: ProviderActionHandle, request: ProviderPermissionRequest): Promise<ProviderPermissionCorrelation>;
  replyPermission?(handle: ProviderActionHandle, request: ProviderPermissionRequest, reply: "once" | "reject", options: ProviderPermissionDispatchOptions): Promise<ProviderPermissionReply>;
  capabilities(workAttemptId: string, provider?: string): Promise<ProviderActionCapabilities>;
  /** Verify the selected polling runtime before an existing writer is stopped. */
  preflightCustodialPolling?(input: { provider: string; devMcpServerEntryPath?: string }): Promise<void>;
  activateCustodialPolling?(handle: ProviderActionHandle, request: CustodialPollingActivationRequest, options: CustodialPollingActivationOptions): Promise<{ providerTurnId: string }>;
  inspectCustodialPollingActivation?(handle: ProviderActionHandle, providerTurnId: string): Promise<{ state: "active" | "unknown" } | { state: "terminal"; outcome: "completed" | "failed" | "interrupted" }>;
  spawn(request: ProviderActionSpawn): Promise<ProviderActionHandle>;
  attach(ref: ProviderActionRef): Promise<ProviderActionHandle | ProviderActionAttachTerminal | null>;
  /** Recover an intent journaled before dispatch, never by spawning a second child. */
  attachAction(actionId: string, workAttemptId: string): Promise<ProviderActionAttachment>;
  resume(ref: ProviderActionRef, request: ProviderActionSpawn): Promise<ProviderActionHandle>;
  poke(handle: ProviderActionHandle, message: string, options?: { actionId?: string }): Promise<void>;
  controlTurn?(handle: ProviderActionHandle, correction?: string | null, options?: {
    actionId?: string;
    targetTurnId?: string | null;
    checkpointTurnStarted?: (turnId: string) => Promise<void>;
    markDispatched?: () => Promise<void>;
  }): Promise<ProviderTurnControlResult>;
  inspectTurn?(handle: ProviderActionHandle, turnId: string): Promise<"active" | "terminal" | "unknown">;
  /** Read-only discovery; an idle snapshot does not itself fence new native work. */
  inspectTurnBoundary?(handle: ProviderActionHandle): Promise<NativeTurnBoundary>;
  controlExactTurn?(handle: ProviderActionHandle, options: { targetTurnId?: string | null; checkpointTargetTurn: (turnId: string) => Promise<void>; markDispatched: () => Promise<void>; detachSignal?: AbortSignal }): Promise<ProviderExactTurnControlResult>;
  runRoomTurn?(handle: ProviderActionHandle, request: ProviderRoomTurnRequest, options?: {
    /** Durable intent checkpoint; completes before the first native turn/start side effect. */
    beforeNativeDispatch?: () => Promise<void>;
    /** Durable exact turn checkpoint; completes after turn/start returns and before terminal observation. */
    checkpointTurnStarted?: (turnId: string) => Promise<void>;
    /**
     * Cursor-only atomic boundary: bind a paused wrapper birth and exact turn
     * id in one transaction before native work is released.
     */
    checkpointPreparedTurn?: (state: {
      providerTurnId: string;
      providerContinuationId: string;
      providerConnection: ProviderActionConnectionRef;
    }) => Promise<void>;
    /** Persist a provider's dynamic continuation/process identity before native work proceeds. */
    checkpointProviderState?: (state: {
      providerContinuationId: string;
      providerConnection: ProviderActionConnectionRef;
    }) => Promise<void>;
    /** Dispose the exact native birth's typed lifecycle effect before a reusable lane drops that birth. */
    settleLifecycleBeforeIdle?: () => Promise<void>;
    /** Synchronously marks that exact turn identity and process recovery state are durable. */
    markDurableTurnStarted?: () => void;
    /** Release provider-local output only after this durable terminal checkpoint succeeds. */
    checkpointTerminalResult?: (result: ProviderRoomTurnResult) => Promise<ProviderRoomTurnCheckpointDisposition | void>;
    /** Detach this local observation without interrupting the native turn. */
    detachSignal?: AbortSignal;
    /** @deprecated compatibility alias; new providers must use beforeNativeDispatch. */
    markDispatched?: () => Promise<void>;
  }): Promise<ProviderRoomTurnResult>;
  /** Recover only this persisted native turn; implementations must never call turn/start. */
  recoverRoomTurn?(handle: ProviderActionHandle, request: ProviderRoomTurnRecoveryRequest, options?: {
    detachSignal?: AbortSignal;
    checkpointProviderState?: (state: {
      providerContinuationId: string;
      providerConnection: ProviderActionConnectionRef;
    }) => Promise<void>;
    settleLifecycleBeforeIdle?: () => Promise<void>;
    checkpointTerminalResult?: (result: ProviderRoomTurnResult) => Promise<ProviderRoomTurnCheckpointDisposition | void>;
  }): Promise<ProviderRoomTurnResult>;
  repairContinuation?(handle: ProviderActionHandle, request: ProviderContinuationRepairRequest, options: {
    /** Persist the replacement before it becomes the sole authoritative handle. */
    checkpointReplacement: (providerContinuationId: string) => Promise<void>;
    detachSignal?: AbortSignal;
  }): Promise<ProviderContinuationRepairResult>;
  /** Stop an exact durable process birth without first attaching its transport. */
  stopRef?(ref: ProviderActionRef, options?: { force?: boolean; graceMs?: number; actionId?: string }): Promise<ProviderActionTerminal>;
  stop(handle: ProviderActionHandle, options?: { force?: boolean; graceMs?: number; actionId?: string }): Promise<ProviderActionTerminal>;
  onExit(handle: ProviderActionHandle, listener: (terminal: ProviderActionTerminal) => void): Promise<() => void>;
  onStream?(handle: ProviderActionHandle, listener: (event: ProviderActionStreamEvent) => void): Promise<() => void>;
}
