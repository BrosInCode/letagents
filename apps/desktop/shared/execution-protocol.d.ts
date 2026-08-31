// Type-only boundary shared by the separately compiled native adapters and
// daemon. Runtime validation belongs to daemon/execution-protocol.ts.
export type RuntimeState = "starting" | "ready" | "stopping" | "exited";
export type ControlState = "connecting" | "responsive" | "degraded" | "lost" | "unprobeable";
export type ContinuationState = "available" | "repairing" | "unavailable";
export type TurnState = "none" | "active" | "terminal" | "lost";
export type TurnOutcome = "completed" | "failed" | "interrupted" | "unreadable";
export type SideEffectState = "none" | "possible" | "observed";
export type ExecutionOutcome = "succeeded" | "failed" | "denied_before_start" | "cancelled_before_start" | "interrupted_after_start" | "lost_after_start";
export type HardControlEvidence = "process_exit" | "process_birth_changed" | "transport_refused" | "control_epoch_gone" | "native_session_terminated";
export type NativeTurnIdentity = { turnId: string; providerContinuationId: string; providerTurnId: string };
export type FactEnvelope = {
  factId: string; agentId: string; executionGenerationId: string; runtimeGenerationId: string;
  observerEpoch: number; sourceSequence: number; nativeEventId?: string; observedAtMs: number;
};
type StateChange = FactEnvelope & { kind: "state_changed"; sideEffects: "none" };
type Operation = FactEnvelope & NativeTurnIdentity & {
  domain: "execution"; executionId: string;
  operation: "command" | "file_read" | "file_change" | "network" | "question" | "other";
  sideEffects: SideEffectState;
};
export type ExecutionFact =
  | StateChange & { domain: "runtime"; state: RuntimeState; controlEvidence?: HardControlEvidence }
  | StateChange & { domain: "control"; state: ControlState; controlEvidence?: HardControlEvidence }
  | StateChange & { domain: "continuation"; state: ContinuationState }
  | StateChange & NativeTurnIdentity & { domain: "turn"; state: TurnState; turnOutcome?: TurnOutcome }
  | Operation & { kind: "started" }
  | Operation & { kind: "output"; outputBytes: number }
  | Operation & { kind: "completed"; outcome: ExecutionOutcome; exitCode?: number; signalNumber?: number };
export type ExecutionOperationFact = Extract<ExecutionFact, { domain: "execution" }>;
type NativeFact<T> = T extends ExecutionFact ? Omit<T, keyof FactEnvelope | "turnId"> & { nativeEventId?: string } : never;
// Adapters never invent the daemon's agent/generation/turn identity. The daemon
// fences and supplies those fields before accepting an observation as a fact.
export type NativeExecutionFact = NativeFact<ExecutionFact>;
export type NativeExecutionObservation = {
  /** Opaque observer sequence identity, independent of native process birth. */
  sourceId: string;
  sequence: number; observedAtMs: number; fact: NativeExecutionFact;
  /** Exact observed OS birth, especially for Cursor's per-turn child. Host-private. */
  nativeProcessIdentity?: string;
};
export type NativeExecutionSubscription = {
  readonly sourceId: string;
  /** Empty retention reports latestSequence + 1 as firstRetainedSequence. */
  position(): { firstRetainedSequence: number; latestSequence: number };
  dispose(): void;
};
export type ControlProbeResult =
  | { state: "responsive" | "degraded" | "unprobeable" }
  | { state: "lost"; controlEvidence: HardControlEvidence };
export type NativeExecutionCapabilities = {
  controlProbe: "rpc" | "http" | "unsupported";
  approvals: {
    kinds: readonly ("command" | "file_change")[];
    recovery: "connection_only" | "native_instance_only" | "unsupported";
    denyScope: "request" | "session" | "unsupported";
  };
};
