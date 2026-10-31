/** The per-runtime Open Model provider handle. */
import type { ProviderActivityEvent, ProviderConnectionRef, ProviderHandle, ProviderObservedState, ProviderStreamEvent, ProviderTerminalPayload } from "../provider-adapter.js";
import { ProviderExecutionObserver } from "../provider-execution-observer.js";
import type { HardControlEvidence, TurnOutcome } from "../../../../shared/execution-protocol.js";
import { OpenCodeServerClient } from "../opencode-server-client.js";

export class OpenModelHandle implements ProviderHandle {
  private observed: ProviderObservedState;
  readonly exitListeners = new Set<(payload: ProviderTerminalPayload) => void>();
  readonly streamListeners = new Set<(event: ProviderStreamEvent) => void>();
  readonly activityListeners = new Set<(event: ProviderActivityEvent) => void>();
  sequence = 0;
  terminal: ProviderTerminalPayload | null = null;
  activeRoomTurnId: string | null = null;
  compaction: { messageId: string; startedAt: string } | null = null;
  /** True once every user message in the session is known to use OpenCode's ascending ID scheme. */
  nativeOrderingVerified = false;
  readonly execution: ProviderExecutionObserver;
  controlLoss: HardControlEvidence | null = null;
  observedTurn: { id: string; terminal: TurnOutcome | "lost" | null } | null = null;
  launchNotices: readonly string[] = [];
  /** This runtime was started with image input for its model, so it takes the activating message's images. */
  imageInput = false;
  /** This runtime may read outside its project, so it can open the room files staged for a turn. */
  externalReads = false;

  constructor(
    readonly workAttemptId: string,
    readonly pid: number,
    readonly providerContinuationId: string,
    readonly lifecycleAuthorityMode: "legacy" | "typed_shadow" | "typed",
    readonly providerConnection: Extract<ProviderConnectionRef, { kind: "opencode_server" }>,
    readonly client: OpenCodeServerClient,
    readonly configuredModel: string,
    initialState: ProviderObservedState,
    now: () => string,
  ) {
    this.observed = initialState;
    this.execution = new ProviderExecutionObserver(now);
  }

  observedState(): ProviderObservedState { return this.observed; }
  setState(value: ProviderObservedState): void { this.observed = value; }
}
