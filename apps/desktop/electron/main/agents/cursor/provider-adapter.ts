import { desktopRuntimeEnvironment } from "../../desktop-shell-environment.js";
import type {
  ProviderActivityEvent,
  ProviderAdapter,
  ProviderAdapterCapabilities,
  ProviderConnectionRef,
  ProviderContinuationRef,
  ProviderHandle,
  ProviderRoomTurnOptions,
  ProviderRoomTurnRecoveryRequest,
  ProviderRoomTurnRequest,
  ProviderRoomTurnResult,
  ProviderSpawnRequest,
  ProviderStopOptions,
  ProviderTurnControlResult,
  ProviderTurnControlOptions,
  ProviderStreamEvent,
  ProviderStreamEventKind,
  ProviderTerminalPayload,
  NativeExecutionObservation,
  NativeExecutionSubscription,
  ControlProbeResult,
} from "../provider-adapter.js";
import type { NativeLifecycleCheckpoint } from "../provider-execution-observer.js";
import { TURN_START_TIMEOUT_MS } from "../cursor-provider-constants.js";
import { createCursorRuntimeCustodyReader } from "../cursor-provider-evidence.js";
import {
  ProviderProcessCustody,
  DEFAULT_STOP_GRACE_MS,
  safeStreamPayload,
  type ProviderProcessExit,
} from "../provider-evidence.js";
import { prepareCursorSupervisedProfile } from "./managed-profile.js";
import { resolveLetAgentsMcpRuntime } from "../letagents-mcp-runtime.js";
import { createCursorUsageReader } from "../cursor-usage.js";
import type { ProviderUsage } from "../../../../shared/provider-usage.js";
import type { SupervisedWorkspaceGenerationHandle } from "../supervised-workspace-generation.js";
import {
  DEFAULT_DEPENDENCIES,
  type CursorProviderAdapterDependencies,
  type CursorProviderAdapterOptions,
} from "./dependencies.js";
import {
  CursorProviderHandle,
  type CursorGenerationSettlement,
  type CursorStreamMessage,
  type CursorTurnTerminal,
  type LiveTurn,
} from "./lane-state.js";
import { BASE_CURSOR_CAPABILITIES } from "./launch-arguments.js";
import {
  awaitDeferredRoomTurnSettlement,
  awaitRoomTurnTerminal,
  providerRoomTurnResult,
  rememberRoomTurnTerminal,
  runRoomTurn,
  settlePreparedTurnIdle,
} from "./room-turn.js";
import {
  consumeLine,
  interruptLiveDisplayTools,
  observeNativeExecution,
  observeNativeExit,
  observeNativeRuntimeExit,
  observeValidatedTurnTerminal,
  publishActivity,
  publishSafeStream,
  publishStream,
} from "./stream-events.js";
import { commitAttemptTerminal, completeTurn, finishAttempt, synthesizeAttemptTerminal } from "./turn-completion.js";
import { controlTurn, poke, stop, stopRef } from "./turn-control.js";
import { beginTurn, start } from "./turn-launch.js";
import {
  awaitTurnTerminal,
  exactProcessStatus,
  finishAfterVerifiedWrapperAbsence,
  readTerminatedTurnExit,
  signalExactProcess,
  terminateTurnChild,
} from "./turn-process.js";
import {
  observeRecordedTurnChild,
  readDurableTurnTerminal,
  readTrustedDurableTurnTerminal,
  readTrustedPreInitTurnFailure,
  recoverOwnedRoomTurn,
  recoverRoomTurn,
  removeDurableTurnJournal,
} from "./turn-recovery.js";
import {
  abandonTurnWorkspaceGeneration,
  recordGenerationSettlement,
  restoreConversationNamespace,
  retireTurnWorkspaceGeneration,
  verifyRestingConversation,
} from "./workspace-generation.js";

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

export class CursorProviderAdapter implements ProviderAdapter {
  readonly id = "cursor" as const;
  readonly cursorBin: string;
  readonly deps: CursorProviderAdapterDependencies;
  readonly activitySink?: (event: ProviderActivityEvent) => void;
  readonly streamSink?: (event: ProviderStreamEvent) => void;
  readonly turnStartTimeoutMs: number;
  readonly stopGraceMs: number;
  readonly supervisedProfileFactory: NonNullable<CursorProviderAdapterOptions["supervisedProfileFactory"]>;
  readonly handles = new Map<string, CursorProviderHandle>();
  readonly readCursorUsage: ReturnType<typeof createCursorUsageReader>;
  readonly processCustody: ProviderProcessCustody;
  readonly runtimeCustody: ReturnType<typeof createCursorRuntimeCustodyReader>;

  constructor(options: CursorProviderAdapterOptions = {}) {
    this.cursorBin = options.cursorBin || desktopRuntimeEnvironment().LETAGENTS_CURSOR_AGENT_BIN || "cursor-agent";
    this.deps = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
    this.processCustody = new ProviderProcessCustody(this.deps);
    this.runtimeCustody = createCursorRuntimeCustodyReader(this.processCustody, this.handles);
    this.activitySink = options.activitySink;
    this.streamSink = options.streamSink;
    this.turnStartTimeoutMs = options.turnStartTimeoutMs ?? TURN_START_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.supervisedProfileFactory = options.supervisedProfileFactory
      ?? ((input) => prepareCursorSupervisedProfile({
        workAttemptId: input.workAttemptId,
        workspaceRoot: input.cwd,
        permissionProfileId: input.permissionProfileId,
        exactWorkspaceOnly: input.exactWorkspaceOnly,
        apiBaseUrl: input.apiBaseUrl,
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
    this.readCursorUsage = createCursorUsageReader(
      this.cursorBin, this.deps, (id) => this.handles.get(id), this.supervisedProfileFactory,
    );
  }

  capabilities(): ProviderAdapterCapabilities {
    return { ...BASE_CURSOR_CAPABILITIES };
  }

  async readUsage(providerHandle: ProviderHandle): Promise<ProviderUsage | null> {
    return this.readCursorUsage(this.requireHandle(providerHandle));
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
    return stopRef(this, ref, options);
  }

  async poke(providerHandle: ProviderHandle, message: string): Promise<void> {
    return poke(this, providerHandle, message);
  }

  async controlTurn(
    providerHandle: ProviderHandle,
    correction?: string | null,
    options: ProviderTurnControlOptions = {},
  ): Promise<ProviderTurnControlResult> {
    return controlTurn(this, providerHandle, correction, options);
  }

  /** The daemon stages a file that this turn's sandbox may read; see cursor-room-turn-images.ts. */
  roomTurnImageDelivery(): "file" { return "file"; }

  async runRoomTurn(
    providerHandle: ProviderHandle,
    request: ProviderRoomTurnRequest,
    options: ProviderRoomTurnOptions = {},
  ): Promise<ProviderRoomTurnResult> {
    return runRoomTurn(this, providerHandle, request, options);
  }

  async recoverRoomTurn(
    providerHandle: ProviderHandle,
    request: ProviderRoomTurnRecoveryRequest,
    options: {
      detachSignal?: AbortSignal;
      checkpointProviderState?: ProviderRoomTurnOptions["checkpointProviderState"];
      settleLifecycleBeforeIdle?: ProviderRoomTurnOptions["settleLifecycleBeforeIdle"];
      checkpointTerminalResult?: ProviderRoomTurnOptions["checkpointTerminalResult"];
    } = {},
  ): Promise<ProviderRoomTurnResult> {
    return recoverRoomTurn(this, providerHandle, request, options);
  }

  async recoverOwnedRoomTurn(providerHandle: ProviderHandle, request: ProviderRoomTurnRecoveryRequest,
    options: Parameters<CursorProviderAdapter["recoverRoomTurn"]>[2] = {}): Promise<ProviderRoomTurnResult> {
    return recoverOwnedRoomTurn(this, providerHandle, request, options);
  }

  readDurableTurnTerminal(
    handle: CursorProviderHandle,
    turnId: string,
  ): CursorTurnTerminal | null {
    return readDurableTurnTerminal(this, handle, turnId);
  }

  readTrustedPreInitTurnFailure(
    turn: LiveTurn,
  ): { errorDetail: string } | null {
    return readTrustedPreInitTurnFailure(this, turn);
  }

  removeDurableTurnJournal(handle: CursorProviderHandle, turnId: string): void {
    return removeDurableTurnJournal(this, handle, turnId);
  }

  async stop(
    providerHandle: ProviderHandle,
    options: ProviderStopOptions = {},
  ): Promise<ProviderTerminalPayload> {
    return stop(this, providerHandle, options);
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

  async probeControl(providerHandle: ProviderHandle): Promise<ControlProbeResult> {
    const handle = this.requireHandle(providerHandle);
    // The wrapper IPC is not Cursor's control loop; an idle lane has no child.
    const result: ControlProbeResult = { state: "unprobeable" };
    const turn = handle.liveTurn;
    // Idle lanes lack a child; settlement can retain an exited child's birth.
    // Neither can authorize a new control fact in runtime-birth keyed capture.
    if (turn && !turn.executionRuntimeFinished) {
      handle.execution.emit(
        { domain: "control", kind: "state_changed", sideEffects: "none", ...result },
        turn.processIdentity,
        turn.pid,
      );
    }
    return result;
  }

  async start(
    req: ProviderSpawnRequest,
    resumeRef: ProviderContinuationRef | null,
  ): Promise<CursorProviderHandle> {
    return start(this, req, resumeRef);
  }

  async beginTurn(
    handle: CursorProviderHandle,
    prompt: string,
    resumeSessionId: string | null,
    roomTurnId: string | null = null,
    checkpointProviderState?: ProviderRoomTurnOptions["checkpointProviderState"],
    checkpointTurnStarted?: ProviderRoomTurnOptions["checkpointTurnStarted"],
    checkpointPreparedTurn?: ProviderRoomTurnOptions["checkpointPreparedTurn"],
    launchSignal?: AbortSignal,
    markDurableTurnStarted?: ProviderRoomTurnOptions["markDurableTurnStarted"],
    settleLifecycleBeforeIdle?: ProviderRoomTurnOptions["settleLifecycleBeforeIdle"],
    readOnlyImageFolders: readonly string[] = [], // Daemon-staged images: this launch may read, never write or run.
  ): Promise<LiveTurn> {
    return beginTurn(this, handle, prompt, resumeSessionId, roomTurnId, checkpointProviderState, checkpointTurnStarted, checkpointPreparedTurn, launchSignal, markDurableTurnStarted, settleLifecycleBeforeIdle, readOnlyImageFolders);
  }

  async completeTurn(
    handle: CursorProviderHandle,
    turn: LiveTurn,
    unsubscribe: () => void,
  ): Promise<CursorTurnTerminal> {
    return completeTurn(this, handle, turn, unsubscribe);
  }

  readTrustedDurableTurnTerminal(
    handle: CursorProviderHandle,
    turn: LiveTurn,
  ): CursorTurnTerminal {
    return readTrustedDurableTurnTerminal(this, handle, turn);
  }

  async retireTurnWorkspaceGeneration(
    handle: CursorProviderHandle,
    turn: LiveTurn,
    trustedRemoteAuthorityEvidence?: CursorTurnTerminal | true,
  ): Promise<void> {
    return retireTurnWorkspaceGeneration(this, handle, turn, trustedRemoteAuthorityEvidence);
  }

  restoreConversationNamespace(handle: CursorProviderHandle, generation: SupervisedWorkspaceGenerationHandle): void {
    return restoreConversationNamespace(this, handle, generation);
  }

  verifyRestingConversation(handle: CursorProviderHandle, settlement: CursorGenerationSettlement): void {
    return verifyRestingConversation(this, handle, settlement);
  }

  recordGenerationSettlement(handle: CursorProviderHandle, turnId: string, manifestPath: string,
    phase: CursorGenerationSettlement["phase"]): CursorGenerationSettlement {
    return recordGenerationSettlement(this, handle, turnId, manifestPath, phase);
  }

  async abandonTurnWorkspaceGeneration(
    generation: SupervisedWorkspaceGenerationHandle,
  ): Promise<void> {
    return abandonTurnWorkspaceGeneration(this, generation);
  }

  consumeLine(handle: CursorProviderHandle, turn: LiveTurn, line: string): void {
    return consumeLine(this, handle, turn, line);
  }

  interruptLiveDisplayTools(handle: CursorProviderHandle, turn: LiveTurn): void {
    return interruptLiveDisplayTools(this, handle, turn);
  }

  observeNativeExecution(handle: CursorProviderHandle, turn: LiveTurn, message: CursorStreamMessage, sessionId: string | null): NativeLifecycleCheckpoint | null {
    return observeNativeExecution(this, handle, turn, message, sessionId);
  }

  observeNativeExit(handle: CursorProviderHandle, turn: LiveTurn, exit: ProviderProcessExit): void {
    return observeNativeExit(this, handle, turn, exit);
  }

  observeValidatedTurnTerminal(
    handle: CursorProviderHandle,
    turn: LiveTurn,
    outcome: "completed" | "failed" | "interrupted" | "lost",
  ): void {
    return observeValidatedTurnTerminal(this, handle, turn, outcome);
  }

  observeNativeRuntimeExit(handle: CursorProviderHandle, turn: LiveTurn, exit: ProviderProcessExit): void {
    return observeNativeRuntimeExit(this, handle, turn, exit);
  }

  rememberRoomTurnTerminal(
    handle: CursorProviderHandle,
    turn: LiveTurn,
    terminal: CursorTurnTerminal,
    observeLifecycle = true,
  ): CursorTurnTerminal {
    return rememberRoomTurnTerminal(this, handle, turn, terminal, observeLifecycle);
  }

  awaitRoomTurnTerminal(
    completion: Promise<CursorTurnTerminal>,
    detachSignal?: AbortSignal,
  ): Promise<CursorTurnTerminal> {
    return awaitRoomTurnTerminal(this, completion, detachSignal);
  }

  providerRoomTurnResult(
    turnId: string,
    terminal: CursorTurnTerminal,
    providerContinuationId: string,
    protocolError = false,
  ): ProviderRoomTurnResult {
    return providerRoomTurnResult(this, turnId, terminal, providerContinuationId, protocolError);
  }

  async observeRecordedTurnChild(
    connection: Extract<ProviderConnectionRef, { kind: "cursor_cli" }>,
  ): Promise<null> {
    return observeRecordedTurnChild(this, connection);
  }

  async terminateTurnChild(
    pid: number,
    exited: Promise<ProviderProcessExit>,
    processIdentity?: string | null,
    ownsDescendantReaping = false,
    nativeLaunchIsDeferred = false,
  ): Promise<void> {
    return terminateTurnChild(this, pid, exited, processIdentity, ownsDescendantReaping, nativeLaunchIsDeferred);
  }

  async readTerminatedTurnExit(turn: LiveTurn): Promise<ProviderProcessExit> {
    return readTerminatedTurnExit(this, turn);
  }

  exactProcessStatus(pid: number, processIdentity: string): "exact" | "absent" | "ambiguous" {
    return exactProcessStatus(this, pid, processIdentity);
  }

  signalExactProcess(
    pid: number,
    processIdentity: string,
    signal: NodeJS.Signals,
  ): "signalled" | "absent" | "ambiguous" {
    return signalExactProcess(this, pid, processIdentity, signal);
  }

  async awaitTurnTerminal(
    handle: CursorProviderHandle,
    turn: LiveTurn,
  ): Promise<ProviderTerminalPayload> {
    return awaitTurnTerminal(this, handle, turn);
  }

  async finishAfterVerifiedWrapperAbsence(
    handle: CursorProviderHandle,
    turn: LiveTurn,
  ): Promise<ProviderTerminalPayload> {
    return finishAfterVerifiedWrapperAbsence(this, handle, turn);
  }

  async awaitDeferredRoomTurnSettlement(
    handle: CursorProviderHandle,
    turn: LiveTurn,
  ): Promise<void> {
    return awaitDeferredRoomTurnSettlement(this, handle, turn);
  }

  async settlePreparedTurnIdle(
    handle: CursorProviderHandle,
    turn: LiveTurn,
    exit: ProviderProcessExit,
    settleLifecycleBeforeIdle?: ProviderRoomTurnOptions["settleLifecycleBeforeIdle"],
    checkpointProviderState?: ProviderRoomTurnOptions["checkpointProviderState"],
  ): Promise<void> {
    return settlePreparedTurnIdle(this, handle, turn, exit, settleLifecycleBeforeIdle, checkpointProviderState);
  }

  finishAttempt(
    handle: CursorProviderHandle,
    exit: ProviderProcessExit,
    forcedCause?: ProviderTerminalPayload["terminalCause"],
  ): ProviderTerminalPayload {
    return finishAttempt(this, handle, exit, forcedCause);
  }

  synthesizeAttemptTerminal(
    handle: CursorProviderHandle,
    exit: ProviderProcessExit,
    forcedCause?: ProviderTerminalPayload["terminalCause"],
  ): ProviderTerminalPayload {
    return synthesizeAttemptTerminal(this, handle, exit, forcedCause);
  }

  commitAttemptTerminal(
    handle: CursorProviderHandle,
    terminal: ProviderTerminalPayload,
  ): ProviderTerminalPayload {
    return commitAttemptTerminal(this, handle, terminal);
  }

  publishStream(
    handle: CursorProviderHandle,
    method: string,
    providerPayload: unknown,
    kind: ProviderStreamEventKind,
  ): void {
    return publishStream(this, handle, method, providerPayload, kind);
  }

  publishSafeStream(
    handle: CursorProviderHandle,
    method: string,
    safe: ReturnType<typeof safeStreamPayload>,
    kind: ProviderStreamEventKind,
    nativeEventId: string | null = null,
    nativeLifecyclePhase: "turn_active" | "turn_terminal" | null = null,
  ): void {
    return publishSafeStream(this, handle, method, safe, kind, nativeEventId, nativeLifecyclePhase);
  }

  publishActivity(
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
    return publishActivity(this, handle, input);
  }

  requireHandle(handle: ProviderHandle): CursorProviderHandle {
    if (!(handle instanceof CursorProviderHandle)) {
      throw new Error("Provider handle does not belong to CursorProviderAdapter.");
    }
    return handle;
  }
}
