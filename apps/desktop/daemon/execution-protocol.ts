import { z } from "zod";
import type { ExecutionFact, NativeTurnIdentity, SideEffectState } from "../shared/execution-protocol.js";
export type {
  RuntimeState, ControlState, ContinuationState, TurnState, TurnOutcome, SideEffectState,
  ExecutionOutcome, ExecutionFact, ExecutionOperationFact, NativeTurnIdentity,
} from "../shared/execution-protocol.js";

// This is a structural, host-private protocol. There is deliberately no field
// for command text, output, paths, reasons, credentials, or provider payloads.
export const executionIdentity = z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const runtimeStates = z.enum(["starting", "ready", "stopping", "exited"]);
export const controlStates = z.enum(["connecting", "responsive", "degraded", "lost", "unprobeable"]);
export const continuationStates = z.enum(["available", "repairing", "unavailable"]);
export const turnStates = z.enum(["none", "active", "terminal", "lost"]);
export const turnOutcomes = z.enum(["completed", "failed", "interrupted", "unreadable"]);
export const sideEffectStates = z.enum(["none", "possible", "observed"]);
export const executionOutcomes = z.enum([
  "succeeded", "failed", "denied_before_start", "cancelled_before_start", "interrupted_after_start", "lost_after_start",
]);
export const hardControlEvidence = z.enum([
  "process_exit", "process_birth_changed", "transport_refused", "control_epoch_gone", "native_session_terminated",
]);

const envelope = {
  factId: executionIdentity,
  agentId: executionIdentity,
  executionGenerationId: executionIdentity,
  runtimeGenerationId: executionIdentity,
  observerEpoch: integer.min(1),
  sourceSequence: integer.min(1),
  // An event identity within the exact native turn/execution + domain/kind,
  // not a shared tool item ID. Adapters without such identity must omit it.
  nativeEventId: executionIdentity.optional(),
  observedAtMs: integer,
};
const stateChange = { ...envelope, kind: z.literal("state_changed"), sideEffects: z.literal("none") };
const nativeTurn = {
  turnId: executionIdentity,
  providerContinuationId: executionIdentity,
  providerTurnId: executionIdentity,
};
const operation = {
  ...envelope, ...nativeTurn, domain: z.literal("execution"), executionId: executionIdentity,
  operation: z.enum(["command", "file_read", "file_change", "network", "question", "other"]),
  sideEffects: sideEffectStates,
};
const factSchema: z.ZodType<ExecutionFact> = z.union([
  z.strictObject({ ...stateChange, domain: z.literal("runtime"), state: runtimeStates, controlEvidence: hardControlEvidence.optional() })
    .refine((v) => (v.state === "exited") === (v.controlEvidence !== undefined)),
  z.strictObject({ ...stateChange, domain: z.literal("control"), state: controlStates, controlEvidence: hardControlEvidence.optional() })
    .refine((v) => (v.state === "lost") === (v.controlEvidence !== undefined)),
  z.strictObject({ ...stateChange, domain: z.literal("continuation"), state: continuationStates }),
  z.strictObject({ ...stateChange, ...nativeTurn, domain: z.literal("turn"), state: turnStates, turnOutcome: turnOutcomes.optional() })
    .refine((v) => (v.state === "terminal") === (v.turnOutcome !== undefined)),
  z.strictObject({ ...operation, kind: z.literal("started") }),
  z.strictObject({ ...operation, kind: z.literal("output"), outputBytes: integer }),
  z.strictObject({
    ...operation, kind: z.literal("completed"), outcome: executionOutcomes,
    exitCode: z.number().int().min(-2147483648).max(2147483647).optional(), signalNumber: integer.min(1).optional(),
  }).refine((v) => !["denied_before_start", "cancelled_before_start"].includes(v.outcome)
    || (v.sideEffects === "none" && v.exitCode === undefined && v.signalNumber === undefined)),
]);

export const nativeTurnIdentity = z.strictObject(nativeTurn);

export class ExecutionProtocolError extends Error {
  constructor(readonly code: "invalid_fact" | "identity_mismatch" | "stale_observer" | "sequence_conflict" | "invalid_transition" | "attempt_settled" | "source_unverified" | "source_gap") {
    // Never include untrusted event content in diagnostics.
    super(`Execution evidence rejected: ${code}.`);
    this.name = "ExecutionProtocolError";
  }
}

export function parseExecutionFact(value: unknown): ExecutionFact {
  const parsed = factSchema.safeParse(value);
  if (!parsed.success) throw new ExecutionProtocolError("invalid_fact");
  return parsed.data;
}

export function combineSideEffects(a: SideEffectState, b: SideEffectState): SideEffectState {
  if (a === "observed" || b === "observed") return "observed";
  return a === "possible" || b === "possible" ? "possible" : "none";
}

export function sameNativeTurn(a: NativeTurnIdentity, b: NativeTurnIdentity): boolean {
  return a.turnId === b.turnId && a.providerContinuationId === b.providerContinuationId && a.providerTurnId === b.providerTurnId;
}
