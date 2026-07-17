import type { DesktopSupervisorManifestEntry } from "../../../electron/ipc-types";

/**
 * Presentation helpers for the destructive "Stop agent" control in the
 * supervised agent modal. Stopping retires the runtime by setting
 * desired_state=stopped (the daemon owns convergence); this module only
 * decides the honest button/label state — it changes no lifecycle semantics.
 *
 * "Stop agent" is deliberately distinct from the turn-level "Stop turn"/Steer
 * controls: it is destructive, confirm-gated, and lives in its own danger zone.
 */

type StopFields = Pick<DesktopSupervisorManifestEntry, "desiredState" | "observedState">;

/**
 * A truthful lifecycle label for a supervised entry, so a stopped/stopping
 * agent never lingers in the UI as "working"/"idle".
 */
/** A stop request that converged to a failure instead of stopping. */
export function supervisedStopAgentFailed(entry: StopFields): boolean {
  return entry.desiredState === "stopped" && entry.observedState === "failed";
}

export function supervisedLifecycleStatusLabel(entry: StopFields): string {
  if (entry.desiredState === "stopped") {
    if (entry.observedState === "stopped" || entry.observedState === "absent") return "Stopped";
    if (entry.observedState === "failed") return "Stop failed";
    return "Stopping…";
  }
  if (entry.desiredState === "paused") {
    return entry.observedState === "paused" ? "Paused" : "Pausing…";
  }
  switch (entry.observedState) {
    case "working": return "Working";
    case "idle": return "Idle";
    case "checkpointing": return "Checkpointing";
    case "recovering": return "Recovering";
    case "failed": return "Failed";
    case "starting": return "Starting";
    default: return entry.observedState;
  }
}

/**
 * The entry is already retired, so Stop agent is a no-op (idempotent guard).
 * A FAILED stop is NOT disabled — it stays actionable so the owner can retry.
 */
export function supervisedStopAgentDisabled(entry: StopFields): boolean {
  return entry.desiredState === "stopped" && entry.observedState !== "failed";
}

/** Whether a stop is still converging (desired stopped, not yet stopped and
 * not failed). A failed stop is terminal-not-converging, so it is excluded. */
export function supervisedStopAgentInFlight(entry: StopFields): boolean {
  return entry.desiredState === "stopped"
    && entry.observedState !== "stopped"
    && entry.observedState !== "absent"
    && entry.observedState !== "failed";
}

/**
 * Label for the destructive Stop-agent button across its states. `pendingStop`
 * is the in-flight request this modal issued; `confirming` is the two-step
 * destructive-confirm affordance.
 */
export function supervisedStopAgentButtonLabel(
  entry: StopFields,
  state: { confirming: boolean; pendingStop: boolean },
): string {
  if (state.pendingStop || supervisedStopAgentInFlight(entry)) return "Stopping…";
  if (supervisedStopAgentFailed(entry)) return "Retry stop";
  if (entry.desiredState === "stopped") return "Stopped";
  if (state.confirming) return "Confirm stop";
  return "Stop agent";
}
