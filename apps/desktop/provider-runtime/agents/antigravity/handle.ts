import type { ProviderUsage } from "../../../shared/provider-usage.js";
import type { TurnOutcome } from "../../../shared/execution-protocol.js";
import { RoomTurnContextCache } from "../desktop-event-prompt-format.js";
import type { ProviderActivityEvent, ProviderConnectionRef, ProviderHandle, ProviderObservedState, ProviderRoomTurnResult, ProviderStreamEvent, ProviderTerminalPayload } from "../provider-adapter.js";
import { ProviderExecutionObserver } from "../provider-execution-observer.js";
import type { ProviderProcessExit } from "../provider-evidence.js";
import type { AcpConnection } from "./acp-connection.js";
import type { AntigravityChild } from "./child-process.js";
import type { AntigravityLaunchAuthority } from "./launch.js";
import type { ClaudePermissionObservation } from "../../../shared/provider-permissions.js";
import type { AntigravityNativePermissionRequest, AntigravityPendingPermission } from "./permissions.js";

/** One room turn while its ACP prompt is open. */
export type AntigravityActiveTurn = {
  turnId: string;
  /** The agent's message text, in the order the chunks came. */
  text: string[];
  /** This host refused one of the turn's permission requests. */
  refusedTool: boolean;
  /** Tool calls this host refused: they failed before they started. */
  deniedTools?: Set<string>;
  /** Tool calls that had a permission request, with the tool name the request carried. */
  requestedTools?: Map<string, string>;
  /** The daemon-owned files this turn's room message carried: agy may read exactly these, wherever they are. */
  stagedFiles?: Set<string>;
  /** The owner asked to stop this turn (session/cancel was sent). */
  cancelRequested?: boolean;
  /** Each tool call's last status, so a repeated update is not reported twice. */
  toolStatuses: Map<string, string>;
  /** Settles with the prompt's own result, or rejects when the process ends first. */
  result: Promise<{ stopReason: string | null; error: string | null }>;
  /** Settles when the whole room turn is over: the prompt, then any command it left running and agy's own reply to it. */
  settled?: Promise<{ stopReason: string | null; error: string | null }>;
  /** Commands of this turn that still run (agy's `run_command` that went to the background). */
  openCommands: Set<string>;
  lastUpdateAt: number;
  lastUsageAt: number;
  lastCommandEndAt: number;
  /** The turn was posted while a command it started still ran. */
  backgroundCut?: boolean;
};

export class AntigravityHandle implements ProviderHandle {
  readonly roomContext = new RoomTurnContextCache();
  readonly execution: ProviderExecutionObserver;
  launchNotices: readonly string[] = [];
  /** The process started with its owner's own Antigravity setup. */
  ownerSetup = false;
  state: ProviderObservedState = "starting";
  stopRequested = false;
  terminal: ProviderTerminalPayload | null = null;
  controlLoss: "process_exit" | "process_birth_changed" | null = null;
  sequence = 0;
  activeTurn: AntigravityActiveTurn | null = null;
  /** The last turn this handle reported on, for its lifecycle facts. */
  observedTurn: { id: string; terminal: TurnOutcome | "lost" | null } | null = null;
  /** Finished results kept until the daemon has checkpointed them. */
  readonly roomTurnResults = new Map<string, ProviderRoomTurnResult>();
  usage: ProviderUsage;
  /** The agent's own Antigravity data folder (`--gemini-dir`). */
  geminiDir: string | null = null;
  /** The agent's working folder, where agy looks for workspace customizations. */
  cwd: string | null = null;
  /** The model agy reports for this session, which decides whose limits apply. */
  currentModel: string | null = null;
  quotaReadAt = 0;
  quotaRead: Promise<void> | null = null;
  /** Requests agy waits on under Ask before writes, by native request id. */
  readonly permissionRequests = new Map<string, AntigravityPendingPermission>();
  readonly permissionListeners = new Set<() => void>();
  /** Answered requests whose tool has not ended yet, by tool call id. */
  readonly permissionClosures = new Map<string, { native: AntigravityNativePermissionRequest; turnId: string }>();
  readonly permissionClosureListeners = new Set<(event: Extract<ClaudePermissionObservation, { type: "request_closed" }>) => void>();
  permissionControlAvailable = true;
  readonly exitListeners = new Set<(payload: ProviderTerminalPayload) => void>();
  readonly activityListeners = new Set<(event: ProviderActivityEvent) => void>();
  readonly streamListeners = new Set<(event: ProviderStreamEvent) => void>();

  constructor(
    readonly workAttemptId: string,
    readonly pid: number,
    readonly providerContinuationId: string,
    readonly lifecycleAuthorityMode: "typed",
    readonly providerConnection: Extract<ProviderConnectionRef, { kind: "antigravity_acp" }>,
    readonly child: AntigravityChild,
    readonly connection: AcpConnection,
    readonly authority: AntigravityLaunchAuthority,
    readonly exitEvidence: Promise<ProviderProcessExit>,
    now: () => string,
  ) {
    this.execution = new ProviderExecutionObserver(now);
    this.usage = { providerContinuationId, account: { state: "unavailable", windows: [] }, context: null, compaction: null };
  }

  permissionsChanged(): void {
    for (const listener of this.permissionListeners) { try { listener(); } catch { /* observers cannot control agy */ } }
  }

  /** Close one answered request's tool, or every one of a turn that ended. */
  closePermissions(match: (toolCallId: string, turnId: string) => boolean): void {
    for (const [toolCallId, closure] of this.permissionClosures) {
      if (!match(toolCallId, closure.turnId)) continue;
      this.permissionClosures.delete(toolCallId);
      for (const listener of this.permissionClosureListeners) {
        try { listener({ type: "request_closed", request: closure.native, providerContinuationId: this.providerContinuationId, providerTurnId: closure.turnId }); } catch { /* observers cannot control agy */ }
      }
    }
  }

  /** Answer every request still waiting with `cancelled`: its turn ended, or agy is going away. Each one is closed. */
  cancelPendingPermissions(turnId?: string): void {
    const cancelled = new Set<string>();
    for (const [id, pending] of this.permissionRequests) {
      if (turnId && pending.turnId !== turnId) continue;
      this.permissionRequests.delete(id);
      pending.settle({ outcome: { outcome: "cancelled" } });
      cancelled.add(pending.toolCallId);
    }
    if (!cancelled.size) return;
    this.permissionsChanged();
    this.closePermissions((toolCallId) => cancelled.has(toolCallId));
  }

  observedState(): ProviderObservedState {
    return this.state;
  }
}
