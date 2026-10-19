// Cursor lane state: the provider handle, its live turn, turn terminals, and
// the typed errors that carry recovery outcomes across adapter modules.

import type {
  ProviderActivityEvent,
  ProviderConnectionRef,
  ProviderHandle,
  ProviderObservedState,
  ProviderSpawnRequest,
  ProviderStreamEvent,
  ProviderTerminalPayload,
} from "../provider-adapter.js";
import { ProviderExecutionObserver, type NativeLifecycleCheckpoint } from "../provider-execution-observer.js";
import type { CursorCliChild } from "./turn-launcher.js";
import type { ProviderProcessExit } from "../provider-evidence.js";
import type { CursorManagedProfile } from "../cursor-managed-profile.js";
import type { SupervisedWorkspaceGenerationHandle } from "../supervised-workspace-generation.js";

export type CursorStreamMessage = Record<string, unknown> & {
  type?: unknown;
  subtype?: unknown;
  session_id?: unknown;
  is_error?: unknown;
  result?: unknown;
  request_id?: unknown;
};

export interface LiveTurn {
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
  workspaceGenerationSettlement?: CursorGenerationSettlement;
  liveDisplayTools: Map<string, { tool: string; input: unknown; completed: boolean }>;
  executionTools: Map<string, { tool: string; completed: boolean }>;
  executionTurnFinished: boolean;
  executionRuntimeFinished: boolean;
  /** Keep the exited child birth installed until its typed turn effect is durable. */
  lifecycleSettlementDeferred: boolean;
  executionTerminalCheckpoint: {
    sessionId: string; subtype: string; isError: boolean; nativeLifecycle: NativeLifecycleCheckpoint;
  } | null;
  executionContinuationId: string | null;
  completion?: Promise<CursorTurnTerminal>;
}

export type CursorTurnTerminal = {
  state: "result" | "interrupted" | "attempt_terminal";
  exit: ProviderProcessExit;
  text: string | null;
  isError: boolean;
  nativeFailure?: boolean;
  providerRequestId: string | null;
  attemptTerminal: ProviderTerminalPayload | null;
  publicationContract: "structured_room_turn_v1" | "legacy_cursor_aggregate_v0";
  /** Safely redacted detail from the trusted private wrapper terminal. */
  terminalError?: string;
  /** Exact init identity retained when a live post-init checkpoint fails. */
  providerContinuationId?: string;
  /** Trusted wrapper link to the exact private filesystem authority journal. */
  workspaceGenerationManifestPath?: string;
  workspaceGenerationSettlement?: CursorGenerationSettlement;
  /** The turn finished, but its wrapper could not prove its remote authority ended. */
  authorityUnproven?: true;
  /** Its private generation stays unreconciled, so the turn's file changes are not kept. */
  fileChangesLost?: true;
};

export type CursorGenerationSettlement = {
  version: 1;
  phase: "aborted" | "cleaned";
  provider_continuation_id: string;
};

export class CursorRoomTurnNotDispatchedError extends Error {
  readonly roomTurnRecoveryOutcome = "not_dispatched" as const;
  constructor(message: string, readonly providerTurnId: string | null = null,
    readonly workspaceGenerationManifestPath?: string,
    readonly workspaceGenerationSettlement?: CursorGenerationSettlement) {
    super(message);
  }
}

export class CursorPostDispatchCheckpointError extends Error {}

export class CursorRoomTurnObservationDetachedError extends Error {}

export class CursorRecordedTurnInProgressError extends Error {
  readonly providerAttachOutcome = "in_progress" as const;
}

export class CursorProviderHandle implements ProviderHandle {
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
  readonly execution: ProviderExecutionObserver;

  constructor(
    readonly workAttemptId: string,
    readonly cwd: string,
    readonly policyArgs: string[],
    readonly deliveryMode: "mcp_polling" | "daemon_inbox",
    readonly spawnRequest: ProviderSpawnRequest,
    readonly supervisedProfile: CursorManagedProfile | null,
    now: () => string,
  ) { this.execution = new ProviderExecutionObserver(now); }

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
