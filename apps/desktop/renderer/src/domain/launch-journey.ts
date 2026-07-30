import type {
  DesktopLaunchEvent,
  DesktopLaunchRecoveryAction,
  DesktopSupervisorManifestEntry,
} from "../../../electron/ipc-types";
import {
  supervisedLaunchProgress,
  supervisedLaunchProviderLabel,
  type SupervisedLaunchPhaseId,
} from "./supervised-launch";

/**
 * One continuous, evidence-backed launch journey for the Add Agent modal
 * (task_84).
 *
 * It folds two honest sources into a single ordered story:
 *  - the Electron-owned pre-durable launch-event stream (connect → save →
 *    activate), which explains the window that used to be an opaque "Starting…"
 *    button; and
 *  - the daemon manifest snapshot the modal already polls, which explains
 *    everything after the durable claim exists.
 *
 * Three grammars are kept deliberately separate:
 *  - MACHINE grammar = the event types (past-tense completed facts), consumed
 *    but never shown.
 *  - PRODUCT grammar = the per-step state (Waiting / In progress / Complete /
 *    Needs attention / Failed / Cancelled / Ready); exactly one step is active
 *    while launching, and a terminal outcome leaves zero active steps.
 *  - HUMAN grammar = the copy below (present-participle headings + plain
 *    sub-copy). Technical nouns stay out of the journey.
 *
 * Delivery is at-least-once, so events are folded idempotently by `sequence`.
 * Each `launch.requested` starts a fresh attempt: a retry under the same launch
 * id folds only the latest attempt, so it is never stuck on a prior terminal.
 */

export type LaunchJourneyPhaseId =
  | "connecting_supervisor"
  | "saving_agent"
  | SupervisedLaunchPhaseId; // preparing_workspace | starting_provider | connecting_room | registering_identity | ready

export type LaunchJourneyPhaseState = "pending" | "active" | "done" | "stopping" | "failed" | "cancelled";

export type LaunchJourneyStatus =
  | "in_progress"
  | "stopping"
  | "ready"
  | "blocked"
  | "failed"
  | "cancelled";

export interface LaunchJourneyPhase {
  id: LaunchJourneyPhaseId;
  /** Human-grammar heading (present participle while active). */
  label: string;
  /** Human-grammar sub-copy explaining the step in plain language. */
  detail: string;
  state: LaunchJourneyPhaseState;
}

export interface LaunchJourneyView {
  phases: LaunchJourneyPhase[];
  currentPhaseId: LaunchJourneyPhaseId;
  status: LaunchJourneyStatus;
  /** True once the background supervisor has durably saved this agent. */
  durable: boolean;
  /** Terminal success. */
  ready: boolean;
  /** Needs the owner's attention (blocked) or the attempt ended (failed). */
  failed: boolean;
  /** Intentionally retired (cancelled mid-launch, or stopped after ready). */
  stopped: boolean;
  /** A persisted stop request needs intervention and can be retried. */
  stopFailed: boolean;
  agentName: string | null;
  providerLabel: string;
  /** Short card title. */
  headline: string;
  /** Plain-language problem for the failed/blocked step; null otherwise. */
  failureDetail: string | null;
  /** What the failure did (or did not) change for the user. */
  failureImpact: string | null;
  /** Redacted implementation detail, progressively disclosed from the UI. */
  failureDiagnostic: string | null;
  /** Single primary recovery action for the failed/blocked step; null otherwise. */
  recovery: DesktopLaunchRecoveryAction | null;
  /** Reassuring "you can close this window" copy while still progressing. */
  joinHint: string | null;
}

const JOURNEY_PHASE_ORDER: readonly LaunchJourneyPhaseId[] = [
  "connecting_supervisor",
  "saving_agent",
  "preparing_workspace",
  "starting_provider",
  "connecting_room",
  "registering_identity",
  "ready",
];

// Pre-durable phase indices.
const CONNECTING = 0;
const SAVING = 1;
const PREPARING = 2;

const JOIN_HINT = "You can close this window. We'll keep setting up the agent.";

export interface LaunchJourneyInput {
  /** Ordered (or unordered/duplicated) launch facts from Electron. */
  events?: readonly DesktopLaunchEvent[];
  /** The durable manifest entry once the claim exists; null in the pre-durable window. */
  entry?: DesktopSupervisorManifestEntry | null;
  /** Provider id used only when no entry/event is available yet. */
  provider?: string;
  /** Room name for the "Joining <room>" step. */
  roomLabel?: string;
  /** True once Start was clicked and the request is in flight (optimistic card). */
  requested?: boolean;
  /** Whether the selected provider has a real sign-in command available. Gates
   * the `sign_in` recovery so its "Copy sign-in command" label always has a
   * command behind it. */
  hasSignInCommand?: boolean;
}

function phaseCopy(
  id: LaunchJourneyPhaseId,
  ctx: { providerLabel: string; roomLabel: string; agentName: string | null },
): { label: string; detail: string } {
  switch (id) {
    case "connecting_supervisor":
      return {
        label: "Starting the background service",
        detail: "Opening the local service that keeps room agents running.",
      };
    case "saving_agent":
      return { label: "Saving your agent", detail: "Recording this agent so setup can continue if you close the app." };
    case "preparing_workspace":
      return { label: "Preparing your project", detail: "Creating a private project area for this agent." };
    case "starting_provider":
      return { label: `Starting ${ctx.providerLabel}`, detail: `Opening ${ctx.providerLabel} with your selected model and permissions.` };
    case "connecting_room":
      return { label: `Joining ${ctx.roomLabel}`, detail: "Connecting your new agent to this room." };
    case "registering_identity":
      return { label: "Setting up the agent", detail: "Creating its room identity and linking it to this launch." };
    case "ready":
      return {
        label: ctx.agentName ? `${ctx.agentName} is ready` : "Your agent is ready",
        detail: "Your agent joined the room and can now receive messages.",
      };
  }
}

/** Fold the LATEST attempt's at-least-once events into observed milestones. */
function foldEvents(events: readonly DesktopLaunchEvent[]): {
  connected: boolean;
  saved: boolean;
  activated: boolean;
  terminal: DesktopLaunchEvent | null;
} {
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence);
  // A retry reuses the launch id and appends a fresh `launch.requested`; fold
  // only from the last one so an earlier terminal never leaks into the retry.
  let attemptStart = 0;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    if (sorted[index]!.type === "launch.requested") {
      attemptStart = index;
      break;
    }
  }
  let connected = false;
  let saved = false;
  let activated = false;
  let terminal: DesktopLaunchEvent | null = null;
  for (const event of sorted.slice(attemptStart)) {
    switch (event.type) {
      case "supervisor.connected":
        connected = true;
        break;
      case "agent.saved":
        connected = true;
        saved = true;
        break;
      case "launch.activated":
        connected = true;
        saved = true;
        activated = true;
        break;
      case "launch.blocked":
      case "launch.failed":
      case "launch.cancelled":
        terminal = event;
        break;
      default:
        break;
    }
  }
  return { connected, saved, activated, terminal };
}

function manifestRecovery(
  entry: DesktopSupervisorManifestEntry,
  hasSignInCommand: boolean,
): DesktopLaunchRecoveryAction {
  switch (entry.condition) {
    case "auth_blocked":
      // Only offer the sign-in action when a real provider command exists;
      // otherwise honest retry copy.
      return hasSignInCommand ? "sign_in" : "retry";
    default:
      return "retry";
  }
}

interface PhaseFold {
  /** The current/boundary step. */
  activeIndex: number;
  /** The step that failed, or null. */
  failedIndex: number | null;
  /** Terminal success: every step complete. */
  ready: boolean;
  /** Terminal-without-failure (cancelled/stopped): no step is active. */
  settled: boolean;
  /** Stop intent is persisted but provider stop is not yet observed. */
  stopping?: boolean;
}

function buildPhases(
  fold: PhaseFold,
  ctx: { providerLabel: string; roomLabel: string; agentName: string | null },
): LaunchJourneyPhase[] {
  return JOURNEY_PHASE_ORDER.map((id, index) => {
    const copy = phaseCopy(id, ctx);
    let state: LaunchJourneyPhaseState;
    if (fold.ready) {
      state = "done";
    } else if (fold.failedIndex !== null && index === fold.failedIndex) {
      state = "failed";
    } else if (index < fold.activeIndex) {
      state = "done";
    } else if (fold.stopping && index === fold.activeIndex) {
      return {
        id,
        label: "Cancelling launch",
        detail: "Waiting for the provider to stop safely.",
        state: "stopping",
      };
    } else if (index === fold.activeIndex && fold.failedIndex === null && !fold.settled) {
      state = "active";
    } else if (fold.settled && index === fold.activeIndex) {
      // Terminal cancelled/stopped: the step that was in flight is Cancelled,
      // never a misleading "Waiting". Steps never reached stay neutral.
      state = "cancelled";
    } else {
      state = "pending";
    }
    return { id, label: copy.label, detail: copy.detail, state };
  });
}

export function foldLaunchJourney(input: LaunchJourneyInput): LaunchJourneyView {
  const events = input.events ?? [];
  const entry = input.entry ?? null;
  const providerLabel = supervisedLaunchProviderLabel(entry?.provider ?? input.provider ?? "agent");
  const roomLabel = input.roomLabel?.trim() || "the room";
  const { connected, saved, terminal } = foldEvents(events);

  if (entry) {
    // The durable entry proves the connect + save window completed; the last
    // five steps are derived from the manifest exactly as before, just relabelled.
    const manifest = supervisedLaunchProgress(entry);
    const agentName = manifest.agentName;
    const ctx = { providerLabel, roomLabel, agentName };
    const manifestActiveOffset = manifest.phases.findIndex((phase) => phase.state === "active" || phase.state === "failed");
    const activeIndex = manifest.ready
      ? JOURNEY_PHASE_ORDER.length - 1
      : PREPARING + Math.max(manifestActiveOffset, 0);
    const failedIndex = manifest.failed ? activeIndex : null;
    // A stop of an agent that already reached ready is a lifecycle stop, not a
    // cancelled launch — the launch succeeded and was later retired. Uses the
    // durable ready stamp, consistent with the electron cancel gate.
    const everReady = entry.readyReachedAt != null;

    const phases = buildPhases(
      {
        activeIndex,
        failedIndex,
        ready: manifest.ready,
        settled: manifest.stopped,
        stopping: manifest.stopping,
      },
      ctx,
    );
    const status: LaunchJourneyStatus = manifest.ready
      ? "ready"
      : manifest.stopping
        ? "stopping"
        : manifest.stopped
          ? "cancelled"
          : manifest.recoverableBlocked
            ? "blocked"
            : manifest.failed
              ? "failed"
              : "in_progress";
    return {
      phases,
      currentPhaseId: phases[Math.min(activeIndex, phases.length - 1)]!.id,
      status,
      durable: true,
      ready: manifest.ready,
      failed: manifest.failed,
      stopped: manifest.stopped,
      stopFailed: manifest.stopFailed,
      agentName,
      providerLabel,
      headline: manifest.stopFailed
        ? manifest.headline
        : headlineFor(status, ctx, { stoppedAfterReady: everReady }),
      failureDetail: manifest.failed ? manifest.failureDetail : null,
      failureImpact: null,
      // The durable entry cannot store why a pre-activation step threw — the
      // daemon never hears about it. The terminal launch event from this
      // session can; surface it as the progressively disclosed diagnostic
      // instead of leaving only the generic ownership-transfer copy.
      failureDiagnostic: manifest.failed ? terminal?.diagnostic ?? null : null,
      recovery: manifest.failed && !manifest.recoverableBlocked && !manifest.stopFailed && !manifest.ownershipPaused
        ? manifestRecovery(entry, input.hasSignInCommand ?? false)
        : null,
      joinHint: status === "in_progress" ? JOIN_HINT : null,
    };
  }

  // Pre-durable window: no durable entry yet. Drive from the event stream.
  const ctx = { providerLabel, roomLabel, agentName: null as string | null };

  if (terminal) {
    // A failure/cancel before the durable claim. Attribute it to the step that
    // was in flight: connecting if we never connected, otherwise saving.
    const boundaryIndex = connected ? SAVING : CONNECTING;
    const cancelled = terminal.type === "launch.cancelled";
    const status: LaunchJourneyStatus =
      cancelled ? "cancelled" : terminal.type === "launch.blocked" ? "blocked" : "failed";
    const phases = buildPhases(
      { activeIndex: boundaryIndex, failedIndex: cancelled ? null : boundaryIndex, ready: false, settled: cancelled },
      ctx,
    );
    // The first boundary can also contain validation failures emitted before
    // Electron contacts the daemon (for example, a missing project). Only the
    // explicit reconnect recovery identifies an actual background-service
    // startup failure; preserve every other actionable message verbatim.
    const connectionFailed = (
      !cancelled
      && boundaryIndex === CONNECTING
      && terminal.recovery === "reconnect"
    );
    const savingFailed = !cancelled && boundaryIndex === SAVING;
    const failureDetail = connectionFailed
      ? "LetAgents couldn’t start the local service that manages room agents."
      : savingFailed
        ? "LetAgents reached its background service but couldn’t save this agent."
        : terminal.detail;
    const failureDiagnostic = !cancelled
      ? terminal.diagnostic
        ?? ((terminal.detail && terminal.detail.trim() !== failureDetail?.trim())
          ? terminal.detail
          : null)
      : null;
    return {
      phases,
      currentPhaseId: JOURNEY_PHASE_ORDER[boundaryIndex]!,
      status,
      durable: false,
      ready: false,
      failed: status === "blocked" || status === "failed",
      stopped: cancelled,
      stopFailed: false,
      agentName: null,
      providerLabel,
      headline: connectionFailed
        ? "Background service didn’t start"
        : savingFailed
          ? "Agent setup stopped before it was saved"
          : headlineFor(status, ctx),
      failureDetail,
      failureImpact: cancelled
        ? null
        : "No agent was created. Your room and project are unchanged.",
      failureDiagnostic,
      recovery: terminal.recovery,
      joinHint: null,
    };
  }

  // Still progressing through the pre-durable window.
  const activeIndex = saved ? PREPARING : connected ? SAVING : CONNECTING;
  const phases = buildPhases({ activeIndex, failedIndex: null, ready: false, settled: false }, ctx);
  return {
    phases,
    currentPhaseId: JOURNEY_PHASE_ORDER[Math.min(activeIndex, phases.length - 1)]!,
    status: "in_progress",
    durable: false,
    ready: false,
    failed: false,
    stopped: false,
    stopFailed: false,
    agentName: null,
    providerLabel,
    headline: headlineFor("in_progress", ctx),
    failureDetail: null,
    failureImpact: null,
    failureDiagnostic: null,
    recovery: null,
    joinHint: JOIN_HINT,
  };
}

function headlineFor(
  status: LaunchJourneyStatus,
  ctx: { providerLabel: string; roomLabel: string; agentName: string | null },
  opts: { stoppedAfterReady?: boolean } = {},
): string {
  switch (status) {
    case "ready":
      return ctx.agentName ? `${ctx.agentName} joined the room` : "Your agent is ready";
    case "cancelled":
      // A successful launch that was later stopped is a lifecycle stop, not a
      // cancelled launch.
      return opts.stoppedAfterReady
        ? (ctx.agentName ? `${ctx.agentName} stopped` : `${ctx.providerLabel} agent stopped`)
        : "Launch cancelled";
    case "stopping":
      return `Cancelling ${ctx.providerLabel} launch...`;
    case "blocked":
      return `${ctx.providerLabel} needs help reconnecting`;
    case "failed":
      return `Couldn't add the ${ctx.providerLabel} agent`;
    default:
      return `Adding ${ctx.providerLabel} to ${ctx.roomLabel}`;
  }
}
