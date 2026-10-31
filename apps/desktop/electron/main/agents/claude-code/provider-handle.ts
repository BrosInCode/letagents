import { RoomTurnContextCache } from "../desktop-event-prompt-format.js";
import type { ClaudePermissionObservation, ClaudeNativePermissionRequest } from "../../../../shared/provider-permissions.js";
import type { ProviderActivityEvent, ProviderConnectionRef, ProviderHandle, ProviderObservedState, ProviderStreamEvent, ProviderTerminalPayload } from "../provider-adapter.js";
import type { NativeExecutionFact } from "../../../../shared/execution-protocol.js";
import { ProviderExecutionObserver, type NativeLifecycleCheckpoint } from "../provider-execution-observer.js";
import type { ProviderProcessExit } from "../provider-evidence.js";
import type { ClaudeCliChild, ClaudeHeldRoomTurn, ClaudeRoomTurnTerminal, ClaudeStreamMessage } from "./types.js";

export class ClaudeProviderHandle implements ProviderHandle {
  readonly roomContext = new RoomTurnContextCache();
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
      this.roomContext.reset();
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
