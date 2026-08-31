import {
  combineSideEffects, ExecutionProtocolError, parseExecutionFact, sameNativeTurn,
  type ContinuationState, type ControlState, type ExecutionOperationFact, type ExecutionOutcome,
  type NativeTurnIdentity, type RuntimeState, type SideEffectState, type TurnOutcome, type TurnState,
} from "./execution-protocol.js";

export type OperationProjection = {
  operation: ExecutionOperationFact["operation"];
  state: "running" | "terminal";
  startObserved: boolean;
  outputBytes: number;
  sideEffects: SideEffectState;
  outcome: ExecutionOutcome | null;
  exitCode: number | null;
  signalNumber: number | null;
};
export type TurnProjection = NativeTurnIdentity & {
  state: TurnState;
  outcome: TurnOutcome | null;
  sideEffects: SideEffectState;
  operations: ReadonlyMap<string, OperationProjection>;
};
export type ExecutionProjection = {
  observerEpoch: number;
  controlObserverEpoch: number;
  runtime: RuntimeState;
  control: ControlState;
  continuation: ContinuationState;
  turns: ReadonlyMap<string, TurnProjection>;
};

export function emptyExecutionProjection(): ExecutionProjection {
  return { observerEpoch: 0, controlObserverEpoch: 0, runtime: "starting", control: "connecting", continuation: "available", turns: new Map() };
}

function transition<T extends string>(previous: T, next: T, allowed: Record<T, readonly T[]>): T {
  if (previous !== next && !allowed[previous].includes(next)) throw new ExecutionProtocolError("invalid_transition");
  return next;
}

function reduceOperation(previous: OperationProjection | undefined, fact: ExecutionOperationFact): OperationProjection {
  if (previous && previous.operation !== fact.operation) throw new ExecutionProtocolError("identity_mismatch");
  const operation: OperationProjection = previous ?? {
    operation: fact.operation, state: "running", startObserved: false, outputBytes: 0,
    sideEffects: "none", outcome: null, exitCode: null, signalNumber: null,
  };
  if (operation.state === "terminal") {
    if (fact.kind === "completed" && operation.outcome === fact.outcome
      && operation.exitCode === (fact.exitCode ?? null) && operation.signalNumber === (fact.signalNumber ?? null)) {
      return { ...operation, sideEffects: combineSideEffects(operation.sideEffects, fact.sideEffects) };
    }
    throw new ExecutionProtocolError("invalid_transition");
  }
  if (fact.kind === "completed" && ["denied_before_start", "cancelled_before_start"].includes(fact.outcome)
    && (operation.startObserved || operation.outputBytes > 0 || operation.sideEffects !== "none")) {
    throw new ExecutionProtocolError("invalid_transition");
  }
  const sideEffects = combineSideEffects(operation.sideEffects, fact.sideEffects);
  if (fact.kind === "started") return { ...operation, startObserved: true, sideEffects };
  if (fact.kind === "output") {
    const outputBytes = operation.outputBytes + fact.outputBytes;
    if (!Number.isSafeInteger(outputBytes)) throw new ExecutionProtocolError("invalid_fact");
    return { ...operation, outputBytes, sideEffects };
  }
  return {
    ...operation, state: "terminal", outcome: fact.outcome, sideEffects,
    exitCode: fact.exitCode ?? null, signalNumber: fact.signalNumber ?? null,
  };
}

/** Pure shadow projection. This module has no provider, inbox, or publication handles. */
export function reduceExecutionFact(previous: ExecutionProjection, value: unknown): ExecutionProjection {
  const fact = parseExecutionFact(value);
  if (fact.observerEpoch < previous.observerEpoch) throw new ExecutionProtocolError("stale_observer");
  if (fact.observerEpoch > previous.observerEpoch) previous = { ...previous, observerEpoch: fact.observerEpoch };
  switch (fact.domain) {
    case "runtime":
      return { ...previous, runtime: transition(previous.runtime, fact.state, {
        starting: ["ready", "stopping", "exited"], ready: ["stopping", "exited"], stopping: ["exited"], exited: [],
      }) };
    case "control":
      // Only explicit control evidence in a new epoch can reconnect. A new
      // observer reporting an old turn must not resurrect that old process.
      if (fact.state === "connecting" && fact.observerEpoch > previous.controlObserverEpoch) {
        return { ...previous, control: "connecting", controlObserverEpoch: fact.observerEpoch };
      }
      return { ...previous, controlObserverEpoch: fact.observerEpoch, control: transition(previous.control, fact.state, {
        connecting: ["responsive", "degraded", "lost", "unprobeable"],
        responsive: ["degraded", "lost", "unprobeable"], degraded: ["responsive", "lost", "unprobeable"],
        unprobeable: ["responsive", "degraded", "lost"], lost: [],
      }) };
    case "continuation": return { ...previous, continuation: transition(previous.continuation, fact.state, {
      available: ["repairing", "unavailable"], repairing: ["available", "unavailable"], unavailable: ["repairing"],
    }) };
    case "turn":
    case "execution": {
      const current = previous.turns.get(fact.turnId);
      if (current && !sameNativeTurn(current, fact)) throw new ExecutionProtocolError("identity_mismatch");
      const turn: TurnProjection = current ?? {
        turnId: fact.turnId, providerContinuationId: fact.providerContinuationId, providerTurnId: fact.providerTurnId,
        state: "none", outcome: null, sideEffects: "none", operations: new Map(),
      };
      let next: TurnProjection;
      if (fact.domain === "turn") {
        const state = transition(turn.state, fact.state, {
          none: ["active", "terminal", "lost"], active: ["terminal", "lost"], lost: ["active", "terminal"], terminal: [],
        });
        if (turn.state === "terminal" && turn.outcome !== fact.turnOutcome) throw new ExecutionProtocolError("invalid_transition");
        next = { ...turn, state, outcome: fact.turnOutcome ?? null };
      } else {
        if ((turn.state === "terminal" || turn.state === "lost") && fact.kind !== "completed") throw new ExecutionProtocolError("invalid_transition");
        const operations = new Map(turn.operations);
        operations.set(fact.executionId, reduceOperation(operations.get(fact.executionId), fact));
        next = { ...turn, operations, sideEffects: combineSideEffects(turn.sideEffects, fact.sideEffects) };
      }
      const turns = new Map(previous.turns);
      turns.set(fact.turnId, next);
      return { ...previous, turns };
    }
  }
}

export type ApprovalState = "requested" | "decision_recorded" | "dispatching" | "resolved" | "superseded" | "lost";
export function waitingForApproval(turn: TurnState, approvals: readonly ApprovalState[]): boolean {
  return turn === "active" && approvals.some((state) => ["requested", "decision_recorded", "dispatching"].includes(state));
}
export function publicApprovalState(state: ApprovalState, decision?: "allow_once" | "deny"):
  "pending" | "decision_recorded" | "applied" | "denied" | "request_changed" | "unavailable" {
  if (state === "lost") return "unavailable";
  if (state === "superseded") return "request_changed";
  if (state === "resolved") {
    if (!decision) throw new ExecutionProtocolError("invalid_transition");
    return decision === "allow_once" ? "applied" : "denied";
  }
  return state === "requested" ? "pending" : "decision_recorded";
}

/** Inputs are durable checkpoints, not inferred error strings or elapsed time. */
export type DeliveryEvidence = {
  dispatch: "not_dispatched" | "possible" | "native_bound";
  nativeTurn: NativeTurnIdentity | null;
  /** Accepted exact durable checkpoint, never merely a provider stream event. */
  nativeTerminal: TurnOutcome | null;
  completion: "reply" | "no_reply" | null;
  published: boolean;
  userInterrupted: boolean;
  authority: "valid" | "ambiguous";
  continuation: ContinuationState;
  preDispatchFailures: number;
  resultReadFailures: number;
  publicationFailures: number;
};
export type DeliveryProjection = {
  state: "pending" | "retryable" | "result_recovery" | "publishing" | "blocked" | "acknowledged" | "acknowledged_no_reply" | "acknowledged_failed" | "cancelled_by_user";
  action: "dispatch" | "retry_provider" | "recover_exact_turn" | "retry_publication" | "restore_continuation" | "attention_required" | "none";
  fifo: "hold" | "advance";
  conclusion: "cleanly_concluded" | "failed" | "interrupted" | null;
};

/** Automatic recommendations only; explicit operator admission never erases failure debt. */
export function reduceDeliveryEvidence(evidence: DeliveryEvidence, limits = { preDispatchRetries: 3, resultRereads: 3, publicationFailures: 3 }): DeliveryProjection {
  const hold = (state: DeliveryProjection["state"], action: DeliveryProjection["action"]): DeliveryProjection =>
    ({ state, action, fifo: "hold", conclusion: null });
  const settled = (state: DeliveryProjection["state"], conclusion: DeliveryProjection["conclusion"]): DeliveryProjection =>
    ({ state, action: "none", fifo: "advance", conclusion });
  for (const count of [evidence.preDispatchFailures, evidence.resultReadFailures, evidence.publicationFailures,
    limits.preDispatchRetries, limits.resultRereads, limits.publicationFailures]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new ExecutionProtocolError("invalid_fact");
  }
  if (evidence.authority !== "valid") return hold("blocked", "attention_required");
  if ((evidence.nativeTerminal && !evidence.nativeTurn)
    || (evidence.nativeTurn && evidence.dispatch !== "native_bound")
    || (evidence.dispatch === "native_bound" && !evidence.nativeTurn)
    || (evidence.completion && !evidence.nativeTurn)
    || (evidence.published && evidence.completion !== "reply")) return hold("blocked", "attention_required");
  // Saved completion wins over a publication exception or subsequent provider
  // cleanup failure. Never resend its prompt or require another provider read.
  if (evidence.completion === "reply") {
    if (evidence.published) return settled("acknowledged", "cleanly_concluded");
    return evidence.publicationFailures >= limits.publicationFailures
      ? hold("blocked", "attention_required") : hold("publishing", "retry_publication");
  }
  if (evidence.completion === "no_reply") return settled("acknowledged_no_reply", "cleanly_concluded");
  if (evidence.nativeTerminal && evidence.nativeTerminal !== "unreadable") {
    if (evidence.nativeTerminal === "failed" || evidence.nativeTerminal === "interrupted") return settled("acknowledged_failed", "failed");
    if (evidence.userInterrupted) return settled("cancelled_by_user", "interrupted");
  }
  if (evidence.nativeTurn) {
    return evidence.resultReadFailures >= limits.resultRereads
      ? hold("blocked", "attention_required") : hold("result_recovery", "recover_exact_turn");
  }
  if (evidence.dispatch === "possible") return hold("blocked", "attention_required");
  if (evidence.userInterrupted) return settled("cancelled_by_user", "interrupted");
  if (evidence.continuation !== "available") return hold("blocked", "restore_continuation");
  if (evidence.preDispatchFailures >= limits.preDispatchRetries) return hold("blocked", "attention_required");
  return evidence.preDispatchFailures === 0 ? hold("pending", "dispatch") : hold("retryable", "retry_provider");
}
