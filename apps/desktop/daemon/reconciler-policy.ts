import type { DesiredState, ObservedState, PolicyCondition } from "./types.js";

/**
 * Provider-neutral policy for the P1d convergence loop.  The provider bridge
 * supplies observations and executes the returned action; this module never
 * infers provider permissions or manufactures a capability.
 */
export type ReconcilerCapabilities = {
  resume: boolean;
  midTurnInjection: boolean;
};

export type ReconcilerSnapshot = {
  desiredState: DesiredState;
  observedState: ObservedState;
  condition: PolicyCondition;
  capabilities: ReconcilerCapabilities;
  nowMs: number;
  lastPollAtMs: number | null;
  addressedMessagesWaiting: number;
  pokeIgnored: boolean;
  activeLease: boolean;
  fencedRebindProven: boolean;
  exitsInWindow: number;
};

export type ReconcilerDecision = {
  action: "wait" | "poke" | "restart_with_resume" | "restart_fresh" | "quarantine" | "hold_coordination" | "stop";
  observedState: ObservedState;
  condition: PolicyCondition;
  reason: string;
};

export const CRASH_LOOP_EXIT_LIMIT = 5;
export const CRASH_LOOP_WINDOW_MS = 10 * 60 * 1000;
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** Exponential 1s → 5m retry backoff, indexed from the first failure. */
export function restartBackoffMs(consecutiveFailures: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.max(0, consecutiveFailures - 1));
}

/** A slow turn alone must never be treated as a dead worker. */
export function watchdogShouldEscalate(snapshot: Pick<ReconcilerSnapshot, "nowMs" | "lastPollAtMs" | "addressedMessagesWaiting" | "pokeIgnored">, thresholdMs: number): boolean {
  return snapshot.lastPollAtMs !== null
    && snapshot.nowMs - snapshot.lastPollAtMs >= thresholdMs
    && snapshot.addressedMessagesWaiting > 0
    && snapshot.pokeIgnored;
}

export function decideReconciliation(snapshot: ReconcilerSnapshot, watchdogThresholdMs: number): ReconcilerDecision {
  if (snapshot.desiredState === "stopped") {
    return { action: "stop", observedState: "stopping", condition: "none", reason: "desired state is stopped" };
  }

  if (snapshot.exitsInWindow >= CRASH_LOOP_EXIT_LIMIT) {
    return { action: "quarantine", observedState: "failed", condition: "quarantined", reason: "crash-loop threshold reached" };
  }

  const needsRecovery = snapshot.desiredState === "running"
    && (snapshot.observedState === "failed" || snapshot.observedState === "stopped" || snapshot.observedState === "absent");
  if (needsRecovery) {
    // A prompt/session rotation cannot cross a lease authorization boundary.
    if (snapshot.activeLease && !snapshot.fencedRebindProven) {
      return { action: "hold_coordination", observedState: "recovering", condition: "coordination_blocked", reason: "active lease requires fenced rebind before restart" };
    }
    if (snapshot.capabilities.resume) {
      return { action: "restart_with_resume", observedState: "recovering", condition: "none", reason: "provider negotiated resume" };
    }
    return { action: "restart_fresh", observedState: "recovering", condition: "none", reason: "bounded recovery: provider has no resume capability" };
  }

  if (snapshot.desiredState === "running"
    && snapshot.capabilities.midTurnInjection
    && snapshot.addressedMessagesWaiting > 0
    && snapshot.lastPollAtMs !== null
    && snapshot.nowMs - snapshot.lastPollAtMs >= watchdogThresholdMs
    && !snapshot.pokeIgnored) {
    return { action: "poke", observedState: snapshot.observedState, condition: snapshot.condition, reason: "addressed messages waiting at a poll boundary" };
  }

  if (watchdogShouldEscalate(snapshot, watchdogThresholdMs)) {
    // The Poke rung has already been exhausted. Recovery is still subject to
    // the lease fence above, so re-run through the recovery state next tick.
    return { action: "wait", observedState: "recovering", condition: snapshot.condition, reason: "poke ignored; await fenced recovery decision" };
  }

  return { action: "wait", observedState: snapshot.observedState, condition: snapshot.condition, reason: "no convergence action required" };
}
