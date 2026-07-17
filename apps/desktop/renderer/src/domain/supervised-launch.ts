import type {
  DesktopSupervisorManifestEntry,
} from "../../../electron/ipc-types";

/**
 * Phased launch progress for a supervised agent, derived purely from the
 * daemon manifest entry the desktop already polls (`supervisor.listAgents`).
 *
 * Every phase gate below is an observable manifest milestone the daemon writes
 * during convergence — there is no timer-driven or fabricated progress. The
 * daemon lifecycle (see apps/desktop/daemon/main.ts convergeManifestEntry /
 * bindWorkerSession) advances a fresh launch through:
 *   1. work attempt + workspace provisioned  -> `workspacePath` set
 *   2. provider child spawned                 -> `providerPid` set,
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
  | "displayName"
  | "provider"
  | "desiredState"
  | "observedState"
  | "condition"
  | "lastError"
  | "workspacePath"
  | "providerPid"
  | "agentSessionId"
  | "agentSessionBindingState"
>;

/** A block/failure that genuinely needs the owner, distinct from the normal
 * pre-bind coordination latch. */
function isBlockingCondition(condition: DesktopSupervisorManifestEntry["condition"]): boolean {
  return condition === "auth_blocked"
    || condition === "budget_blocked"
    || condition === "security_blocked"
    || condition === "quarantined";
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
  if (bound && live && entry.condition === "none") return 4; // ready
  if (bound) return 3;                                        // registering done
  // Provider child is up and the daemon is past "starting" (awaiting the room
  // bind). observedState "starting"/"absent" means it has not connected yet.
  const connecting = entry.providerPid != null
    && entry.observedState !== "starting"
    && entry.observedState !== "absent";
  if (connecting) return 2;                                   // connecting done
  if (entry.providerPid != null) return 1;                    // provider started
  if (entry.workspacePath != null) return 0;                  // workspace ready
  return -1;                                                  // preparing
}

export function supervisedLaunchProgress(entry: LaunchFields): SupervisedLaunchProgress {
  const providerLabel = supervisedLaunchProviderLabel(entry.provider);
  const reached = reachedIndex(entry);
  const ready = reached >= 4;
  const stopped = entry.desiredState === "stopped";
  const failed = !ready
    && !stopped
    && (entry.observedState === "failed" || isBlockingCondition(entry.condition));

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
    ? (entry.lastError?.trim() || blockedConditionDetail(entry.condition))
    : null;

  let headline: string;
  if (ready) {
    headline = `${entry.displayName} is ready`;
  } else if (stopped) {
    headline = `${providerLabel} agent stopped before it finished starting`;
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
    stopped,
    agentName: ready ? entry.displayName : null,
    providerLabel,
    headline,
    failureDetail,
    joinHint: ready || failed || stopped ? null : JOIN_HINT,
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
