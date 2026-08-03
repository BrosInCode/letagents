import type {
  DesktopSupervisorManifestEntry,
} from "../../../electron/ipc-types";
import { supervisedAgentDisplayLabel } from "./codenames";
import { safeUserVisibleErrorDetail } from "./user-visible-error";

/**
 * Phased launch progress for a supervised agent, derived purely from the
 * daemon manifest entry the desktop already polls (`supervisor.listAgents`).
 *
 * Every phase gate below is an observable manifest milestone the daemon writes
 * during convergence — there is no timer-driven or fabricated progress. The
 * daemon lifecycle (see apps/desktop/daemon/main.ts convergeManifestEntry /
 * bindWorkerSession) advances a fresh launch through:
 *   1. work attempt + workspace provisioned  -> `workspacePath` set
 *   2. provider runtime established           -> `providerPid` set, or a
 *                                                Cursor continuation set,
 *                                                observedState left "starting"
 *   3. provider up, awaiting the room bind     -> observedState "recovering"
 *                                                with condition
 *                                                "coordination_blocked"
 *                                                (the normal "awaiting exact
 *                                                bind" latch, NOT a failure)
 *   4. worker registered + bound to this entry -> agentSessionBindingState
 *                                                "active", workplace reachable,
 *                                                observedState working/idle,
 *                                                condition "none"
 */

export type SupervisedLaunchPhaseId =
  | "preparing_workspace"
  | "starting_provider"
  | "connecting_room"
  | "registering_identity"
  | "ready";

export type SupervisedLaunchPhaseState = "pending" | "active" | "done" | "failed";

export interface SupervisedLaunchPhase {
  id: SupervisedLaunchPhaseId;
  label: string;
  state: SupervisedLaunchPhaseState;
}

export interface SupervisedLaunchProgress {
  phases: SupervisedLaunchPhase[];
  /** The phase currently active, failed, or (once ready) the terminal phase. */
  currentPhaseId: SupervisedLaunchPhaseId;
  /** Bound, live, and unblocked: the launch produced a usable agent. */
  ready: boolean;
  /** A phase is blocked or failed and needs the owner's attention. */
  failed: boolean;
  /** The old process could not be attached, but the daemon may still produce
   * fresher evidence. Keep observing it instead of treating it as terminal. */
  recoverableBlocked: boolean;
  /** Stop intent is persisted, but the daemon has not yet observed the provider stopped. */
  stopping: boolean;
  /** Stop intent converged to an actionable failure instead of remaining in flight. */
  stopFailed: boolean;
  /** The durable claim exists, but ownership transfer never activated it. */
  ownershipPaused: boolean;
  /** The launch was retired (desired_state=stopped) before/after readiness. */
  stopped: boolean;
  /** Real registered agent name once ready; null while still launching. */
  agentName: string | null;
  /** Human provider label (Codex, Claude Code, ...). */
  providerLabel: string;
  /** Short status headline for the launch row. */
  headline: string;
  /** Failure/block detail for the failed phase; null otherwise. */
  failureDetail: string | null;
  /** Reassuring copy shown while phases are still progressing; null when settled. */
  joinHint: string | null;
}

const PHASE_ORDER: readonly { id: SupervisedLaunchPhaseId; label: string }[] = [
  { id: "preparing_workspace", label: "Preparing workspace" },
  { id: "starting_provider", label: "Starting provider" },
  { id: "connecting_room", label: "Connecting to room" },
  { id: "registering_identity", label: "Registering identity" },
  { id: "ready", label: "Ready" },
];

const JOIN_HINT = "The agent will join the room shortly.";

type LaunchFields = Pick<
  DesktopSupervisorManifestEntry,
  | "id"
  | "displayName"
  | "provider"
  | "desiredState"
  | "observedState"
  | "condition"
  | "lastError"
  | "workspacePath"
  | "providerPid"
  | "providerContinuationId"
  | "executionGenerationId"
  | "agentSessionId"
  | "agentSessionBindingState"
  | "workplaceLiveness"
>;

/** A block/failure that genuinely needs the owner, distinct from the normal
 * pre-bind coordination latch. */
function isExpectedCoordinationWait(lastError: string | null | undefined): boolean {
  const detail = lastError?.trim().toLowerCase();
  if (!detail) return true;
  return detail.includes("awaiting exact bind")
    || detail.includes("awaits exact worker wait evidence");
}

function isBlockingCondition(entry: LaunchFields): boolean {
  return entry.condition === "auth_blocked"
    || entry.condition === "budget_blocked"
    || entry.condition === "security_blocked"
    || entry.condition === "quarantined"
    || (entry.condition === "coordination_blocked" && !isExpectedCoordinationWait(entry.lastError));
}

export function supervisedLaunchProviderLabel(provider: string): string {
  switch (provider.trim().toLowerCase()) {
    case "codex": return "Codex";
    case "claude":
    case "claude-code": return "Claude Code";
    case "antigravity": return "Antigravity";
    case "cursor": return "Cursor";
    case "open-model":
    case "open_model": return "Open Model";
    default: return provider.trim() || "Agent";
  }
}

/** How far the launch has honestly progressed (highest completed milestone). */
function reachedIndex(entry: LaunchFields): number {
  const bound = entry.agentSessionBindingState === "active";
  const live = entry.observedState === "idle"
    || entry.observedState === "working"
    || entry.observedState === "checkpointing";
  const workplaceReachable = entry.workplaceLiveness?.state === "reachable";
  // Ready ONLY on complete end-to-end evidence: the exact worker is bound, its
  // workplace is reachable, the provider is live, and nothing is blocked.
  if (bound && live && workplaceReachable && entry.condition === "none") return 4; // ready
  // Registering stays ACTIVE (never a "done" resting state) until fully ready:
  // a bound-but-unreachable worker, or one with room/session evidence but not
  // yet fully ready, remains registering_identity — it must never show Ready.
  // There is deliberately no intermediate `if (bound) return 3`.
  // Cursor is a per-turn lane and honestly has no process while idle. Its
  // durable continuation is the provider-established milestone; requiring a
  // PID would leave a healthy supervised Cursor launch stuck forever at
  // "Starting provider" between turns.
  const providerEstablished = entry.provider === "cursor"
    ? entry.providerContinuationId != null
    : entry.providerPid != null;
  if (providerEstablished && (bound || workplaceReachable || entry.agentSessionId != null)) return 2; // connecting done, registering active
  if (providerEstablished) return 1;                          // provider started, connecting active
  if (entry.workspacePath != null) return 0;                  // workspace ready, starting provider
  return -1;                                                  // preparing workspace
}

export function supervisedLaunchProgress(entry: LaunchFields): SupervisedLaunchProgress {
  const providerLabel = supervisedLaunchProviderLabel(entry.provider);
  const agentDisplayName = supervisedAgentDisplayLabel(entry.displayName, entry.id);
  const reached = reachedIndex(entry);
  const ownershipPaused = entry.desiredState === "paused";
  const stopFailed = entry.desiredState === "stopped"
    && (entry.observedState === "failed" || isBlockingCondition(entry));
  const stopping = entry.desiredState === "stopped"
    && entry.observedState !== "stopped"
    && !stopFailed;
  const stopped = entry.desiredState === "stopped" && entry.observedState === "stopped";
  const ready = entry.desiredState === "running" && reached >= 4;
  const hasProviderExecution = entry.providerPid != null
    || entry.providerContinuationId != null
    || entry.executionGenerationId != null;
  const recoverableBlocked = hasProviderExecution
    && !ready
    && !stopFailed
    && !stopping
    && !stopped
    && entry.condition === "coordination_blocked"
    && !isExpectedCoordinationWait(entry.lastError);
  const failed = ownershipPaused || stopFailed || (!ready
    && !stopping
    && !stopped
    && (entry.observedState === "failed" || isBlockingCondition(entry)));

  // The active phase is the first not-yet-completed phase. `reached` counts
  // completed gates, so the active index is `reached + 1`, clamped.
  const activeIndex = Math.min(Math.max(reached + 1, 0), PHASE_ORDER.length - 1);

  const phases: SupervisedLaunchPhase[] = PHASE_ORDER.map((phase, index) => {
    if (ready) {
      return { id: phase.id, label: phase.label, state: "done" };
    }
    if (index < activeIndex) {
      return { id: phase.id, label: phase.label, state: "done" };
    }
    if (index === activeIndex) {
      return { id: phase.id, label: phase.label, state: failed ? "failed" : "active" };
    }
    return { id: phase.id, label: phase.label, state: "pending" };
  });

  const currentPhaseId = phases[Math.min(activeIndex, phases.length - 1)]!.id;

  const failureDetail = failed
    ? (ownershipPaused
        ? safeUserVisibleErrorDetail(entry.lastError, `The ${providerLabel} launch was saved, but ownership transfer did not finish. Cancel it before starting a replacement.`)
        : stopFailed
        ? safeUserVisibleErrorDetail(entry.lastError, `The supervisor couldn't stop the ${providerLabel} agent. Check its status and try again.`)
        : entry.condition === "coordination_blocked" && hasProviderExecution
        ? `LetAgents can't currently reconnect to the previous ${providerLabel} process. It may still reconnect; you can wait or cancel this launch and start a new agent.`
        : entry.condition === "coordination_blocked"
        ? entry.workspacePath == null
          ? "LetAgents couldn't prepare the private project area. Try this launch again or cancel it and start a new agent."
          : `LetAgents couldn't start ${providerLabel} in the private project area. Try this launch again or cancel it and start a new agent.`
        : safeUserVisibleErrorDetail(entry.lastError, blockedConditionDetail(entry.condition)))
    : null;

  let headline: string;
  if (ready) {
    headline = `${agentDisplayName} is ready`;
  } else if (ownershipPaused) {
    headline = `${providerLabel} launch needs cleanup`;
  } else if (stopFailed) {
    headline = `Couldn't stop the ${providerLabel} agent`;
  } else if (stopping) {
    headline = `Cancelling ${providerLabel} launch...`;
  } else if (stopped) {
    headline = `${providerLabel} agent stopped before it finished starting`;
  } else if (recoverableBlocked) {
    headline = `${providerLabel} needs help reconnecting`;
  } else if (failed) {
    headline = `${providerLabel} agent needs attention`;
  } else {
    headline = `Starting ${providerLabel} agent`;
  }

  return {
    phases,
    currentPhaseId,
    ready,
    failed,
    recoverableBlocked,
    stopping,
    stopFailed,
    ownershipPaused,
    stopped,
    agentName: ready ? agentDisplayName : null,
    providerLabel,
    headline,
    failureDetail,
    joinHint: ready || failed || stopping || stopped ? null : JOIN_HINT,
  };
}

function blockedConditionDetail(condition: DesktopSupervisorManifestEntry["condition"]): string {
  switch (condition) {
    case "auth_blocked": return "Provider authentication is required before this agent can start.";
    case "budget_blocked": return "The configured budget or rate cap is exhausted.";
    case "security_blocked": return "A security policy blocked this agent from starting.";
    case "quarantined": return "The supervisor quarantined this agent after repeated failures.";
    default: return "The agent stopped before it finished starting.";
  }
}
